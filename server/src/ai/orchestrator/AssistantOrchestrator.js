const crypto                = require('crypto');
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
const { isOperationalQuery }       = require('./OperationalQueryGuard');
const { getAiCapabilities }        = require('../security/AiCapabilities');
const { buildSafeAiContext }       = require('../security/SafeAiContextBuilder');
const { redactSensitiveFields }    = require('../security/FieldFilter');
const { DomainIntentClassifier, CATEGORIES } = require('./DomainIntentClassifier');
const { DraftingIntentHandler }    = require('./DraftingIntentHandler');
const { clarificationRequired, isStructuredResult } = require('../results/AiResultTypes');
const { AppDataQueryPlanner }      = require('./AppDataQueryPlanner');

const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const PENDING_TTL_MS   = 5 * 60 * 1000;
const PENDING_PRUNE_MS = 60 * 1000; // sweep expired confirmations every minute
const TOOL_TIMEOUT_MS = envInt('AI_TOOL_TIMEOUT_MS', 15000, 1000);
const FALLBACK_MAX_TOKENS = envInt('AI_FALLBACK_MAX_TOKENS', 512, 64);
const RAG_MAX_TOKENS = Math.max(FALLBACK_MAX_TOKENS, envInt('AI_RAG_MAX_TOKENS', 512, 64));
const FALLBACK_TEMPERATURE = Number.isFinite(Number(process.env.AI_FALLBACK_TEMPERATURE))
  ? Number(process.env.AI_FALLBACK_TEMPERATURE)
  : 0;
const MODEL_TIMEOUT_MS       = envInt('AI_MODEL_TIMEOUT_MS',       20000, 1000);
const MODEL_RETRY_TIMEOUT_MS = envInt('AI_MODEL_RETRY_TIMEOUT_MS', 10000, 1000);
const TOTAL_CHAT_TIMEOUT_MS  = envInt('AI_TOTAL_CHAT_TIMEOUT_MS',  30000, 5000);

class AssistantOrchestrator {
  // opts is used by tests to inject short timeouts without module-cache clearing.
  constructor(opts = {}) {
    this._registry   = new ToolRegistry();
    this._policy     = new PolicyEngine();
    this._validator  = new SchemaValidator();
    this._parser     = new ToolCallParser();
    this._memory     = new ConversationMemory();
    this._audit      = new AuditLogger();
    this._pending    = new Map(); // confirmationId → { tool, args, context, userId, expiresAt }
    this._provider   = createFromEnv();
    this._prompt     = new PromptBuilder(this._registry);
    this._rag        = getLegalFolderRagService();
    this._backendRag = getBackendKnowledgeRagService();
    this._intent     = new IntentRouter();
    this._classifier = new DomainIntentClassifier();
    this._drafting   = new DraftingIntentHandler();
    this._appDataPlanner = new AppDataQueryPlanner({ classifier: this._classifier });

    this._modelTimeoutMs = opts.modelTimeoutMs ?? MODEL_TIMEOUT_MS;
    this._retryTimeoutMs = opts.retryTimeoutMs ?? MODEL_RETRY_TIMEOUT_MS;
    this._totalTimeoutMs = opts.totalTimeoutMs ?? TOTAL_CHAT_TIMEOUT_MS;

    // Periodically evict expired confirmation entries to prevent memory leak
    this._pendingPruneTimer = setInterval(() => this._prunePending(), PENDING_PRUNE_MS);
    if (this._pendingPruneTimer.unref) this._pendingPruneTimer.unref();
  }

  _prunePending() {
    const now = Date.now();
    for (const [id, entry] of this._pending) {
      if (entry.expiresAt < now) this._pending.delete(id);
    }
  }

  async chat({ sessionId, message, user, ipAddress }) {
    const _t0 = Date.now();
    const _debug = process.env.AI_DEBUG_TIMING === 'true' || process.env.NODE_ENV !== 'production';

    const capabilities = getAiCapabilities(user);
    const context = { userId: user?._id, user, capabilities };

    // ── Phase: deterministic app-data planner ──
    // Live app facts must be answered by backend tools.  This planner runs before
    // the legacy direct router so filtered app-data questions go through the
    // structured workflows/tasks/signed-documents paths first.
    const _tPlan0 = Date.now();
    const appDataPlan = this._appDataPlanner.plan(message);
    const _planMs = Date.now() - _tPlan0;
    if (appDataPlan.isAppDataQuery) {
      const toolCall = this._appDataPlanner.toToolCall(appDataPlan);
      if (toolCall && appDataPlan.confidence >= 0.75) {
        const _tTool0 = Date.now();
        const result = await this._handleToolCall(toolCall, context, sessionId, message, user, ipAddress);
        const _toolMs = Date.now() - _tTool0;
        const _timing = {
          queryClass: 'APP_DATA_QUERY',
          normalizedQuery: appDataPlan.normalizedQuery,
          domain: appDataPlan.domain,
          intent: appDataPlan.intent,
          capabilityId: appDataPlan.capabilityId,
          tool: toolCall.toolName,
          selectedTool: toolCall.toolName,
          confidence: appDataPlan.confidence,
          appDataQuery: true,
          directRouteMatched: true,
          modelSkipped: true,
          modelCalled: false,
          ragSkipped: true,
          ragCalled: false,
          promptBuilt: false,
          fallbackUsed: false,
          timeoutHappened: false,
          plannerMs: _planMs,
          toolExecuteMs: _toolMs,
          totalMs: Date.now() - _t0,
          resultType: result?.type,
        };
        if (_debug) this._logTiming('app_data_direct_tool', _timing);
        return _debug ? { ...result, _timing } : result;
      }

      const fallback = this._appDataPlanner.clarification(appDataPlan);
      const _timing = {
        queryClass: 'APP_DATA_QUERY',
        normalizedQuery: appDataPlan.normalizedQuery,
        domain: appDataPlan.domain,
        intent: appDataPlan.intent,
        capabilityId: appDataPlan.capabilityId,
        confidence: appDataPlan.confidence,
        appDataQuery: true,
        modelSkipped: true,
        modelCalled: false,
        ragSkipped: true,
        ragCalled: false,
        promptBuilt: false,
        fallbackUsed: true,
        timeoutHappened: false,
        plannerMs: _planMs,
        totalMs: Date.now() - _t0,
        resultType: fallback.type,
      };
      if (_debug) this._logTiming('app_data_clarification', _timing);
      this._memory.append(sessionId, { role: 'user', content: message });
      this._memory.append(sessionId, { role: 'assistant', content: fallback.summary });
      return _debug ? { ...fallback, _timing } : fallback;
    }

    // ── Phase: IntentRouter (direct route) ──
    const _tDirect0 = Date.now();
    const directResponse = await this._tryDirectResponse({
      sessionId, message, user, ipAddress, context,
    });
    const _directMs = Date.now() - _tDirect0;
    if (directResponse) {
      const _directTiming = {
        tool: directResponse._directToolName || directResponse.type,
        directMs: _directMs,
        totalMs: Date.now() - _t0,
        modelSkipped: true,
        ragSkipped: true,
      };
      if (_debug) this._logTiming('direct_route', _directTiming);
      const { _directToolName, ...cleanDirectResponse } = directResponse;
      return _debug ? { ...cleanDirectResponse, _timing: _directTiming } : cleanDirectResponse;
    }

    const classification = this._classifier.classify(message);

    if (classification.category === CATEGORIES.DRAFTING_QUERY) {
      const _tDraft0 = Date.now();
      const draftResult = await this._drafting.handle({ message, user, provider: this._provider });
      if (draftResult) {
        const _draftTiming = {
          domain: classification.domain,
          queryType: classification.queryType,
          directMs: Date.now() - _tDraft0,
          totalMs: Date.now() - _t0,
          modelSkipped: true,
          ragSkipped: true,
          resultType: draftResult.type,
        };
        if (_debug) this._logTiming('drafting_fast_path', _draftTiming);
        this._memory.append(sessionId, { role: 'user', content: message });
        this._memory.append(sessionId, { role: 'assistant', content: draftResult.summary });
        return _debug ? { ...draftResult, _timing: _draftTiming } : draftResult;
      }
    }

    if (classification.category === CATEGORIES.APP_DATA_QUERY && classification.requiresTool && !classification.allowModel) {
      const fallback = this._appDataClarification(classification);
      const _guardTiming = {
        domain: classification.domain,
        queryType: classification.queryType,
        totalMs: Date.now() - _t0,
        modelSkipped: true,
        ragSkipped: true,
        fallbackUsed: true,
        resultType: fallback.type,
      };
      if (_debug) this._logTiming('app_data_guard', _guardTiming);
      this._memory.append(sessionId, { role: 'user', content: message });
      this._memory.append(sessionId, { role: 'assistant', content: fallback.summary });
      return _debug ? { ...fallback, _timing: _guardTiming } : fallback;
    }

    // Deadline for the entire model-path: starts after the direct-route check
    // (direct routes are always fast and don't count against the model budget).
    const _chatDeadline = Date.now() + this._totalTimeoutMs;

    const history = this._memory.get(sessionId);

    // Queries asking for live operational data (counts, statuses, lists) are answered
    // by tools — not by document content or backend source code.  Skip RAG for those
    // unless the message is also asking for document content or an explanation.
    const _isDocumentContent = /\b(clause|section|paragraph|say|says|stated|wording|provision|summariz|summarise|analyz|analys|review.*content|text of|detail.*contract)\b/i.test(message);
    const _isExplainQuery    = /\b(explain|how does|how do|how is|how are|why does|why is|what is the (process|flow|workflow|purpose)|walk me through|how .{0,20} work)\b/i.test(message);
    const _isOperational     = isOperationalQuery(message);

    // ── Phase: Legal RAG retrieval ──
    // Skip when the query is operational AND not asking for document-level content.
    const shouldRetrieveLegal = (_isDocumentContent || !_isOperational) && this._rag.shouldRetrieve(message, user);
    const _tLegal0 = Date.now();
    const legalRag = shouldRetrieveLegal
      ? await this._rag.retrieve({ user, query: message }).catch((err) => {
        console.warn(`[AI RAG] Retrieval failed: ${err.message}`);
        return null;
      })
      : null;
    const _legalRagMs = Date.now() - _tLegal0;

    // ── Phase: Backend RAG retrieval ──
    // Skip when the query is operational AND not asking for an explanation of app behavior.
    const shouldRetrieveBackend = (_isExplainQuery || !_isOperational) && this._backendRag.shouldRetrieve(message, user);
    const _tBackend0 = Date.now();
    const backendRag = shouldRetrieveBackend
      ? await this._backendRag.retrieve({ user, query: message }).catch((err) => {
        console.warn(`[AI Backend RAG] Retrieval failed: ${err.message}`);
        return null;
      })
      : null;
    const _backendRagMs = Date.now() - _tBackend0;

    const ragSecurityFlags = [
      ...(legalRag?.snippets || []).flatMap((snippet) => snippet.securityFlags || []),
      ...(backendRag?.snippets || []).flatMap((snippet) => snippet.securityFlags || []),
    ];
    const safeContext = buildSafeAiContext({
      user,
      capabilities,
      query: message,
      legalRagResults: legalRag?.snippets || [],
      backendRagResults: backendRag?.snippets || [],
    });

    // ── Phase: RAG audit log ──
    const _tAudit0 = Date.now();
    if (legalRag || backendRag || safeContext.blockedContextCount || safeContext.redactionCount) {
      await this._audit.logRagRetrieval({
        user,
        sourceType: [
          legalRag ? 'legal_document' : null,
          backendRag ? 'backend_knowledge' : null,
        ].filter(Boolean).join('+') || 'none',
        query: message,
        retrievedCount: (legalRag?.snippets?.length || 0) + (backendRag?.snippets?.length || 0),
        blockedCount: safeContext.blockedContextCount,
        securityFlags: ragSecurityFlags,
        redactionCount: safeContext.redactionCount,
        ipAddress,
      });
    }
    const _ragAuditMs = Date.now() - _tAudit0;

    // ── Phase: Prompt build ──
    const _tPrompt0 = Date.now();
    const systemPrompt = this._prompt.buildSystemPrompt(user, {
      legalFolder: safeContext.safeLegalContext,
      backendKnowledge: safeContext.safeBackendContext,
      warnings: safeContext.warnings,
      capabilities,
    }, { query: message });
    const messages    = this._prompt.buildMessages(history, message);
    const _promptBuildMs = Date.now() - _tPrompt0;
    const hasRetrieval = Boolean(legalRag || backendRag);

    if (_debug) {
      const _promptMetrics = {
        systemPromptChars: systemPrompt.length,
        messagesChars: messages.reduce((s, m) => s + (m.content?.length || 0), 0),
        legalRagChars: safeContext.safeLegalContext?.length || 0,
        backendRagChars: safeContext.safeBackendContext?.length || 0,
        toolCountIncluded: this._prompt.lastMetrics?.toolCount || 0,
        examplesCountIncluded: this._prompt.lastMetrics?.examplesCount || 0,
      };
      this._logTiming('prompt_size', _promptMetrics);
    }

    // ── Phase: Model generate (first attempt) ──
    const _tModel0 = Date.now();
    let modelOut;
    try {
      const _modelBudget = Math.min(this._modelTimeoutMs, Math.max(0, _chatDeadline - Date.now()));
      if (_modelBudget <= 0) {
        // RAG/audit consumed the entire chat budget before we could even call the model.
        this._audit.logAiTimeout({ user, phase: 'pre_generate', timeoutMs: this._totalTimeoutMs, ipAddress }).catch(() => {});
        const _timing = { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: 0, totalMs: Date.now() - _t0 };
        if (_debug) this._logTiming('timeout_pre_generate', _timing);
        const r = { type: 'message', content: this._timeoutMessage(_isOperational) };
        return _debug ? { ...r, _timing } : r;
      }

      modelOut = await this._generateWithTimeout({
        systemPrompt,
        messages,
        maxTokens: hasRetrieval ? RAG_MAX_TOKENS : FALLBACK_MAX_TOKENS,
        temperature: FALLBACK_TEMPERATURE,
      }, _modelBudget);
    } catch (err) {
      const _modelGenerateMs = Date.now() - _tModel0;
      if (err.code === 'AI_TIMEOUT') {
        this._audit.logAiTimeout({ user, phase: 'generate', timeoutMs: this._modelTimeoutMs, ipAddress }).catch(() => {});
        if (_debug) this._logTiming('timeout_generate', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, totalMs: Date.now() - _t0 });
        const r = { type: 'message', content: this._timeoutMessage(_isOperational) };
        return _debug ? { ...r, _timing: { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, totalMs: Date.now() - _t0 } } : r;
      }
      const providerError = err.message || 'unknown error';
      const setupRequired = /not installed|setup|disabled/i.test(providerError);
      const runtimeDeviceLost = /vk::Device::waitForFences|ErrorDeviceLos|ErrorDeviceLost|device lost|vulkan/i.test(providerError);
      console.error(`[AI] Provider generate failed (${this._provider.family || 'unknown'}):`, err);
      if (_debug) this._logTiming('model_error', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend });
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
    const _modelGenerateMs = Date.now() - _tModel0;

    if (modelOut?.type === 'error') {
      if (_debug) this._logTiming('model_error_response', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, totalMs: Date.now() - _t0 });
      return { type: 'error', message: modelOut.message };
    }

    // ── Phase: Tool call parse ──
    const _tParse0 = Date.now();
    let toolCall = this._parser.parse(modelOut, this._registry);
    const _toolParseMs = Date.now() - _tParse0;

    // ── Phase: OperationalQueryGuard retry ──
    let _retryMs = 0;
    if (!toolCall && isOperationalQuery(message)) {
      const _tRetry0 = Date.now();
      const _retryBudget = Math.min(this._retryTimeoutMs, Math.max(0, _chatDeadline - Date.now()));

      if (_retryBudget <= 0) {
        // Total chat budget exhausted before retry could start.
        this._audit.logAiTimeout({ user, phase: 'pre_retry', timeoutMs: this._totalTimeoutMs, ipAddress }).catch(() => {});
        _retryMs = Date.now() - _tRetry0;
        if (_debug) this._logTiming('timeout_pre_retry', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0 });
        const r = { type: 'message', content: 'I need to check system records, but the local model took too long to select a tool. Please try a more specific query or use the dashboard filters.' };
        return _debug ? { ...r, _timing: { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0 } } : r;
      }

      const strictPrompt = this._prompt.buildSystemPrompt(user, {
        legalFolder: safeContext.safeLegalContext,
        backendKnowledge: safeContext.safeBackendContext,
        warnings: safeContext.warnings,
        capabilities,
      }, { strictToolUse: true, query: message });
      let retryOut;
      try {
        retryOut = await this._generateWithTimeout({
          systemPrompt: strictPrompt,
          messages,
          maxTokens: FALLBACK_MAX_TOKENS,
          temperature: 0,
        }, _retryBudget);
      } catch (err) {
        if (err.code === 'AI_TIMEOUT') {
          this._audit.logAiTimeout({ user, phase: 'retry', timeoutMs: _retryBudget, ipAddress }).catch(() => {});
        }
        // timeout or other retry error — fall through to operational fallback
      }
      toolCall = retryOut ? this._parser.parse(retryOut, this._registry) : null;
      _retryMs = Date.now() - _tRetry0;
      if (!toolCall) {
        if (_debug) this._logTiming('guard_fallback', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend });
        const fallback = {
          type: 'message',
          content: this._timeoutMessage(true),
        };
        return _debug ? { ...fallback, _timing: { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend } } : fallback;
      }
    }

    // ── Phase: Tool execution ──
    if (toolCall) {
      const _tTool0 = Date.now();
      const result = await this._handleToolCall(toolCall, context, sessionId, message, user, ipAddress);
      const _toolExecuteMs = Date.now() - _tTool0;
      if (_debug) this._logTiming('tool_call', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, toolExecuteMs: _toolExecuteMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend });
      return _debug ? { ...result, _timing: { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, toolExecuteMs: _toolExecuteMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend } } : result;
    }

    // ── Phase: Plain assistant message ──
    const sanitized = sanitizeAssistantContent(modelOut?.content || modelOut?.question || '', { capabilities });
    const content = sanitized.content;
    if (!content.trim()) {
      if (_debug) this._logTiming('empty_response', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0 });
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

    const msgResult = { type: modelOut?.type === 'clarification' ? 'clarification' : 'message', content };
    if (_debug) this._logTiming('plain_message', { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend });
    return _debug ? { ...msgResult, _timing: { legalRagMs: _legalRagMs, backendRagMs: _backendRagMs, ragAuditMs: _ragAuditMs, promptBuildMs: _promptBuildMs, modelGenerateMs: _modelGenerateMs, toolParseMs: _toolParseMs, retryMs: _retryMs, totalMs: Date.now() - _t0, legalRagTriggered: shouldRetrieveLegal, backendRagTriggered: shouldRetrieveBackend } } : msgResult;
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
      const result = await this._handleToolCall(route, context, sessionId, message, user, ipAddress);
      return { ...result, _directToolName: route.toolName };
    }

    return null;
  }

  _rememberedMessage(sessionId, userMessage, content) {
    this._memory.append(sessionId, { role: 'user', content: userMessage });
    this._memory.append(sessionId, { role: 'assistant', content });
    return { type: 'message', content };
  }

  _appDataClarification(classification) {
    const domain = classification.domain === 'general' ? 'app data' : classification.domain.replace(/_/g, ' ');
    return clarificationRequired({
      title: 'Choose a System Lookup',
      category: 'app_data',
      summary: `I need to use a backend tool for ${domain} facts, but I could not select one confidently. Please ask for a specific count, list, status, value, due-date, signing, or progress lookup.`,
      options: ['contracts', 'workflows', 'tasks', 'signing', 'documents', 'reports'],
    });
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
    const result = await this._executeTool(pending.tool, pending.args, pending.context, user, ipAddress);

    // Record the original user message and the outcome in conversation memory
    if (pending.sessionId) {
      this._memory.append(pending.sessionId, { role: 'user',      content: pending.userMessage || `Confirmed: ${pending.tool.name}` });
      this._memory.append(pending.sessionId, { role: 'assistant', content: this._summarizeForMemory(result) });
    }

    return result;
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
      const confirmationId = crypto.randomBytes(16).toString('hex');
      this._pending.set(confirmationId, {
        tool, args, context,
        userId:     String(user?._id || ''),
        sessionId,
        userMessage,
        expiresAt:  Date.now() + PENDING_TTL_MS,
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
      result = redactSensitiveFields(result, { user, maxStringChars: 1500 });
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
    if (!result) return 'No result returned.';
    if (result.type === 'error')     return `Error: ${result.message}`;
    if (result.type === 'not_found') return result.message || 'Not found.';

    if (isStructuredResult(result)) {
      return result.summary || `${result.title || 'Summary'}: ${result.metrics?.count ?? result.items?.length ?? 0} item(s).`;
    }
    if (result.type === 'navigation') return `Navigated to ${result.data?.label || result.data?.path || 'page'}.`;

    const d = result.data;
    if (!d) return result.message || 'No result returned.';

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

    if (d.mode === 'expired' && typeof d.count === 'number') return d.message || `${d.count} contract${d.count !== 1 ? 's have' : ' has'} expired.`;
    if (d.mode === 'expiring' && typeof d.count === 'number' && d.days) return d.message || `${d.count} contract${d.count !== 1 ? 's' : ''} expiring within ${d.days} days.`;
    if (typeof d.count === 'number' && d.days) return `${d.count} contract${d.count !== 1 ? 's' : ''} expiring within ${d.days} days.`;
    if (typeof d.count === 'number') return `Total: ${d.count}.`;

    if (d.summary?.title) return `${d.summary.title} — ${d.summary.status}.`;
    if (d.title && d.status) return `${d.title}: ${d.status}.`;

    return result.message || 'Result returned.';
  }

  /**
   * Call provider.generate() with a hard wall-clock timeout.
   * Passes an AbortSignal so runtimes that support it (node-llama-cpp, Ollama)
   * can cancel the in-flight generation and free resources immediately.
   *
   * Rejection order matters: the timeout promise rejects BEFORE calling
   * controller.abort() so that Promise.race always settles with the
   * AI_TIMEOUT error rather than the provider's downstream AbortError.
   */
  async _generateWithTimeout(input, timeoutMs) {
    const controller = new AbortController();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error(`AI model timed out after ${timeoutMs}ms`);
        err.code = 'AI_TIMEOUT';
        reject(err);          // reject first — Promise.race picks this up
        controller.abort();   // then abort so the provider can clean up
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this._provider.generate({ ...input, signal: controller.signal }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  _logTiming(phase, timing) {
    const isDurationKey = (key) => /(?:^|[A-Z])Ms$/.test(key);
    const parts = Object.entries(timing)
      .map(([k, v]) => `${k}=${typeof v === 'number' && isDurationKey(k) ? `${v}ms` : v}`)
      .join(' ');
    console.log(`[AI Timing] phase=${phase} ${parts}`);
  }

  _timeoutMessage(isOperational) {
    if (isOperational) {
      return "I could not select the correct system tool before the local model timed out. No cloud fallback was used. Please try a more specific query like 'show unassigned workflow tasks' or use the Workflows page.";
    }
    return 'The local AI model took too long to respond. I did not use a cloud fallback. Please try again or use the dashboard filters.';
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
