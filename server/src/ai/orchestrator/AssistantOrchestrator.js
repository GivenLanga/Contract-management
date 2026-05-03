const { ToolRegistry }      = require('../tools/ToolRegistry');
const { PolicyEngine }      = require('../policy/PolicyEngine');
const { SchemaValidator }   = require('../parsing/SchemaValidator');
const { ToolCallParser }    = require('../parsing/ToolCallParser');
const { ConversationMemory } = require('./ConversationMemory');
const { PromptBuilder }     = require('./PromptBuilder');
const { AuditLogger }       = require('../AuditLogger');
const { createFromEnv }     = require('../providers/ModelProviderFactory');
const { getLegalFolderRagService } = require('../rag/LegalFolderRagService');
const { getBackendKnowledgeRagService } = require('../rag/BackendKnowledgeRagService');
const { IntentRouter }      = require('./IntentRouter');
const { sanitizeAssistantContent } = require('../security/PromptSecurity');

const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const TOOL_TIMEOUT_MS = envInt('AI_TOOL_TIMEOUT_MS', 15000, 1000);
const FALLBACK_MAX_TOKENS = envInt('AI_FALLBACK_MAX_TOKENS', 512, 64);
const RAG_MAX_TOKENS = Math.max(FALLBACK_MAX_TOKENS, envInt('AI_RAG_MAX_TOKENS', 512, 64));
const FALLBACK_TEMPERATURE = Number.isFinite(Number(process.env.AI_FALLBACK_TEMPERATURE))
  ? Number(process.env.AI_FALLBACK_TEMPERATURE)
  : 0;

class AssistantOrchestrator {
  constructor() {
    this._registry  = new ToolRegistry();
    this._policy    = new PolicyEngine();
    this._validator = new SchemaValidator();
    this._parser    = new ToolCallParser();
    this._memory    = new ConversationMemory();
    this._audit     = new AuditLogger();
    this._pending   = new Map(); // confirmationId → { tool, args, context, expiresAt }
    this._provider  = createFromEnv();
    this._prompt    = new PromptBuilder(this._registry);
    this._rag       = getLegalFolderRagService();
    this._backendRag = getBackendKnowledgeRagService();
    this._intent    = new IntentRouter();
  }

  async chat({ sessionId, message, user, ipAddress }) {
    const context = { userId: user?._id, user };

    // Try routing directly — bypasses the model entirely for known patterns
    const directResponse = await this._tryDirectResponse({
      sessionId, message, user, ipAddress, context,
    });
    if (directResponse) return directResponse;

    const history = this._memory.get(sessionId);

    // RAG: retrieve for all providers when the query matches document/contract keywords.
    // Grounding the prompt in real document excerpts prevents hallucination regardless of model size.
    const shouldRetrieveLegal = this._rag.shouldRetrieve(message);
    const legalRag = shouldRetrieveLegal
      ? await this._rag.retrieve({ user, query: message }).catch((err) => {
        console.warn(`[AI RAG] Retrieval failed: ${err.message}`);
        return null;
      })
      : null;

    const shouldRetrieveBackend = this._backendRag.shouldRetrieve(message);
    const backendRag = shouldRetrieveBackend
      ? await this._backendRag.retrieve({ user, query: message }).catch((err) => {
        console.warn(`[AI Backend RAG] Retrieval failed: ${err.message}`);
        return null;
      })
      : null;

    const systemPrompt = this._prompt.buildSystemPrompt(user, {
      legalFolder: this._rag.formatContext(legalRag),
      backendKnowledge: this._backendRag.formatContext(backendRag),
    });
    const messages    = this._prompt.buildMessages(history, message);
    const hasRetrieval = Boolean(legalRag || backendRag);

    let modelOut;
    try {
      modelOut = await this._provider.generate({
        systemPrompt,
        messages,
        maxTokens: hasRetrieval ? RAG_MAX_TOKENS : FALLBACK_MAX_TOKENS,
        temperature: FALLBACK_TEMPERATURE,
      });
    } catch (err) {
      const providerError = err.message || 'unknown error';
      const setupRequired = /not installed|setup|disabled/i.test(providerError);
      const runtimeDeviceLost = /vk::Device::waitForFences|ErrorDeviceLos|ErrorDeviceLost|device lost|vulkan/i.test(providerError);
      console.error(`[AI] Provider generate failed (${this._provider.family || 'unknown'}):`, err);
      return {
        type: 'error',
        message: setupRequired
          ? providerError
          : runtimeDeviceLost
            ? 'The local AI runtime lost its GPU device while generating. App-data questions with built-in tools can still work; restart local AI if free-form answers keep failing.'
            : process.env.NODE_ENV === 'production'
              ? 'AI model unavailable. Please try again.'
              : `AI model unavailable: ${providerError}`,
      };
    }

    if (modelOut?.type === 'error') {
      return { type: 'error', message: modelOut.message };
    }

    const toolCall = this._parser.parse(modelOut, this._registry);
    if (toolCall) {
      return await this._handleToolCall(toolCall, context, sessionId, message, user, ipAddress);
    }

    const sanitized = sanitizeAssistantContent(modelOut?.content || modelOut?.question || '');
    const content = sanitized.content;
    if (!content.trim()) {
      return {
        type: 'error',
        message: 'I could not produce a reliable answer for that. Try rephrasing the request or use one of the suggested actions.',
      };
    }

    if (sanitized.blocked) {
      await this._audit.logSecurityEvent({
        user,
        eventType: 'blocked_model_output',
        detail: { provider: this._provider.family, reason: 'system_prompt_or_tool_leak' },
        ipAddress,
      });
    }

    this._memory.append(sessionId, { role: 'user',      content: message });
    this._memory.append(sessionId, { role: 'assistant', content });

    return { type: modelOut?.type === 'clarification' ? 'clarification' : 'message', content };
  }

  async _tryDirectResponse({ sessionId, message, user, ipAddress, context }) {
    const route = this._intent.route(message);
    if (!route) return null;

    if (route.type === 'message') {
      return this._rememberedMessage(sessionId, message, route.content);
    }

    if (route.type === 'legal_folder_count') {
      const counts = await this._rag.getCounts(user);
      const count = counts.syncedDocuments || counts.serverDocuments || 0;
      let content;
      if (counts.syncedDocuments && counts.serverDocuments && counts.syncedDocuments !== counts.serverDocuments) {
        content = `Your Legal Folder has ${counts.syncedDocuments} browser-indexed files and ${counts.serverDocuments} server documents marked for the Legal Folder.`;
      } else if (count === 0) {
        content = 'I do not have any Legal Folder files indexed for AI search yet. Open or sync the Legal Folder once, then ask again.';
      } else {
        content = count === 1
          ? 'Your Legal Folder has 1 file indexed for AI search.'
          : `Your Legal Folder has ${count} files indexed for AI search.`;
      }

      this._memory.append(sessionId, { role: 'user', content: message });
      this._memory.append(sessionId, { role: 'assistant', content });
      return { type: 'success', data: { message: content, count, legalFolder: counts } };
    }

    if (route.type === 'tool_call') {
      return await this._handleToolCall(route, context, sessionId, message, user, ipAddress);
    }

    return null;
  }

  _rememberedMessage(sessionId, userMessage, content) {
    this._memory.append(sessionId, { role: 'user', content: userMessage });
    this._memory.append(sessionId, { role: 'assistant', content });
    return { type: 'message', content };
  }

  async confirm({ confirmationId, user, ipAddress }) {
    const pending = this._pending.get(confirmationId);
    if (!pending) return { type: 'error', message: 'Confirmation expired or not found.' };
    if (pending.expiresAt < Date.now()) {
      this._pending.delete(confirmationId);
      return { type: 'error', message: 'Confirmation expired.' };
    }
    if (pending.userId !== String(user?._id || '')) {
      await this._audit.logSecurityEvent({
        user,
        eventType: 'confirmation_user_mismatch',
        detail: { confirmationId, toolName: pending.tool?.name },
        ipAddress,
      });
      return { type: 'error', message: 'Confirmation expired or not found.' };
    }
    this._pending.delete(confirmationId);
    return this._executeTool(pending.tool, pending.args, pending.context, user, ipAddress);
  }

  async _handleToolCall(toolCall, context, sessionId, userMessage, user, ipAddress) {
    const { toolName, arguments: args } = toolCall;
    const tool = this._registry.get(toolName);

    if (!tool) {
      await this._audit.logSecurityEvent({
        user,
        eventType: 'unknown_tool_call',
        detail: { toolName },
        ipAddress,
      });
      return { type: 'error', message: 'Unknown AI tool.' };
    }

    const policy = this._policy.evaluate(tool, user);
    if (!policy.allowed) {
      await this._audit.logSecurityEvent({
        user,
        eventType: 'tool_policy_denied',
        detail: { toolName, reason: policy.reason },
        ipAddress,
      });
      return { type: 'error', message: policy.reason };
    }

    if (tool.schema) {
      const { valid, errors } = this._validator.validate(tool.schema, args);
      if (!valid) {
        await this._audit.logSecurityEvent({
          user,
          eventType: 'invalid_tool_arguments',
          detail: { toolName, errors },
          ipAddress,
        });
        return { type: 'error', message: `Invalid arguments: ${errors.join('; ')}` };
      }
    }

    if (policy.requiresConfirmation) {
      const confirmationId = `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this._pending.set(confirmationId, {
        tool, args, context,
        userId: String(user?._id || ''),
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      return {
        type: 'confirmation_required',
        confirmationId,
        toolName,
        description: tool.description,
        args,
        message: `This action requires your confirmation: ${tool.description}`,
      };
    }

    const result = await this._executeTool(tool, args, context, user, ipAddress);

    // Store a short human-readable summary — NOT the full JSON — to keep context small
    this._memory.append(sessionId, { role: 'user', content: userMessage });
    this._memory.append(sessionId, { role: 'assistant', content: this._summarizeForMemory(result) });

    return result;
  }

  async _executeTool(tool, args, context, user, ipAddress) {
    let result;
    let timeoutId;
    try {
      result = await Promise.race([
        tool.execute(args, context),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Tool timed out.')), TOOL_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      result = {
        type: 'error',
        message: process.env.NODE_ENV === 'production'
          ? 'The assistant action failed. Please try again or use the app screen directly.'
          : `Tool error: ${err.message}`,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    await this._audit.logToolCall({ user, toolName: tool.name, args, result, ipAddress });
    return result;
  }

  /**
   * Produce a short natural-language summary of a tool result for conversation memory.
   * This keeps context tokens small between turns.
   */
  _summarizeForMemory(result) {
    if (!result) return 'Done.';
    if (result.type === 'error')     return `Error: ${result.message}`;
    if (result.type === 'not_found') return result.message || 'Not found.';
    if (result.type === 'navigation') return `Navigated to ${result.data?.label || result.data?.path || 'page'}.`;

    const d = result.data;
    if (!d) return result.message || 'Done.';

    if (d.message && !d.contracts && !d.documents && !d.tasks && !d.drafters) return d.message;

    if (d.contracts?.length) {
      const names = d.contracts.slice(0, 3).map((c) => c.title).filter(Boolean).join(', ');
      return `Found ${d.contracts.length} contract${d.contracts.length !== 1 ? 's' : ''}${names ? `: ${names}` : ''}.`;
    }
    if (Array.isArray(d.contracts) && d.contracts.length === 0) return 'No contracts found.';

    if (d.documents?.length) {
      const names = d.documents.slice(0, 3).map((doc) => doc.name).filter(Boolean).join(', ');
      return `Found ${d.documents.length} document${d.documents.length !== 1 ? 's' : ''}${names ? `: ${names}` : ''}.`;
    }
    if (Array.isArray(d.documents) && d.documents.length === 0) return 'No documents found.';

    if (d.tasks?.length) {
      return `Found ${d.tasks.length} task${d.tasks.length !== 1 ? 's' : ''}.`;
    }
    if (Array.isArray(d.tasks) && d.tasks.length === 0) return 'No tasks found.';

    if (d.signers?.length) {
      return `${d.completedSigners ?? 0}/${d.totalSigners ?? d.signers.length} signers have completed signing.`;
    }

    if (d.drafters?.length) {
      const names = d.drafters.slice(0, 3).map((u) => u.name).filter(Boolean).join(', ');
      return `${d.drafters.length} user${d.drafters.length !== 1 ? 's' : ''} currently drafting${names ? `: ${names}` : ''}.`;
    }

    if (typeof d.pending === 'number') {
      return `Tasks: ${d.pending} pending, ${d.inProgress ?? 0} in progress, ${d.overdue ?? 0} overdue, ${d.completed ?? 0} completed.`;
    }

    if (typeof d.count === 'number' && d.days) return `${d.count} contract${d.count !== 1 ? 's' : ''} expiring within ${d.days} days.`;
    if (typeof d.count === 'number') return `Total: ${d.count}.`;

    if (d.summary?.title) return `${d.summary.title} — ${d.summary.status}.`;
    if (d.title && d.status) return `${d.title}: ${d.status}.`;

    return 'Done.';
  }

  clearSession(sessionId) {
    this._memory.clear(sessionId);
  }

  async healthCheck() {
    return this._provider.healthCheck();
  }
}

let _instance;
const getInstance = () => {
  if (!_instance) _instance = new AssistantOrchestrator();
  return _instance;
};

module.exports = { AssistantOrchestrator, getInstance };
