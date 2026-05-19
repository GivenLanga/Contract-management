const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const { getInstance } = require('../ai/orchestrator/AssistantOrchestrator');
const { getInstance: getRuntimeManager } = require('../ai/runtime/AiRuntimeManager');
const { ModelRegistry } = require('../ai/runtime/ModelRegistry');
const { getModelsDir } = require('../ai/runtime/ModelStorage');
const { getLegalFolderRagService } = require('../ai/rag/LegalFolderRagService');
const { getBackendKnowledgeRagService } = require('../ai/rag/BackendKnowledgeRagService');
const { getClientSigningStateService } = require('../ai/state/ClientSigningStateService');
const { AiDataAccessPolicy } = require('../ai/security/AiDataAccessPolicy');

const router = express.Router();

const getOrchestrator = () => getInstance();
const runtimeManager = () => getRuntimeManager();
const ragService = () => getLegalFolderRagService();
const backendRagService = () => getBackendKnowledgeRagService();
const signingStateService = () => getClientSigningStateService();
const aiPolicy = new AiDataAccessPolicy();

const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const MAX_AI_MESSAGE_CHARS = envInt('AI_MAX_MESSAGE_CHARS', 2000, 100);
const MAX_RAG_SYNC_DOCUMENTS = envInt('AI_RAG_MAX_SYNC_DOCUMENTS', 500, 1);
const MAX_RAG_SYNC_TOTAL_CHARS = envInt('AI_RAG_MAX_SYNC_TOTAL_CHARS', 3000000, 1000);

const aiKeyGenerator = (req) => String(req.user?._id || req.ip);

const aiChatLimiter = rateLimit({
  windowMs: envInt('AI_CHAT_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000, 1000),
  max: envInt('AI_CHAT_RATE_LIMIT_MAX', 40, 1),
  keyGenerator: aiKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { type: 'error', message: 'Too many AI requests. Please wait a moment and try again.' },
});

const aiMutationLimiter = rateLimit({
  windowMs: envInt('AI_MUTATION_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 1000),
  max: envInt('AI_MUTATION_RATE_LIMIT_MAX', 20, 1),
  keyGenerator: aiKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI setup or indexing requests. Please wait and try again.' },
});

const cleanSessionId = (value, fallback) => {
  const text = String(value || '').trim().slice(0, 128).replace(/[^\w.-]/g, '_');
  return text || fallback;
};

const scopedSessionId = (user, clientSessionId) => `${user?._id || 'anonymous'}:${clientSessionId}`;

const canManageBackendRag = (user) => ['admin', 'manager'].includes(user?.role);

const sanitizeRagSource = (raw) => {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = raw.name != null ? String(raw.name).slice(0, 255) : undefined;
  return name != null ? { name } : null;
};

const validateRagSyncPayload = (body) => {
  const documents = Array.isArray(body?.documents) ? body.documents : [];
  if (documents.length > MAX_RAG_SYNC_DOCUMENTS) {
    return `Legal Folder sync accepts at most ${MAX_RAG_SYNC_DOCUMENTS} documents at a time.`;
  }

  let totalChars = 0;
  for (const doc of documents) {
    totalChars += String(doc?.textContent || '').length;
    if (totalChars > MAX_RAG_SYNC_TOTAL_CHARS) {
      return `Legal Folder sync accepts at most ${MAX_RAG_SYNC_TOTAL_CHARS} text characters at a time.`;
    }
  }

  return null;
};

router.use(protect);

// GET /api/ai/status — local AI setup/runtime state
router.get('/status', async (req, res) => {
  try {
    res.json(await runtimeManager().getStatus());
  } catch (err) {
    res.status(500).json({
      provider: String(process.env.ACTIVE_MODEL_PROVIDER || 'local').toLowerCase(),
      modelSource: process.env.LOCAL_MODEL_SOURCE || null,
      runtime: process.env.LOCAL_MODEL_RUNTIME || null,
      cloudEnabled: process.env.ALLOW_CLOUD_AI === 'true',
      usesCloudInference: ['huggingface', 'hf'].includes(String(process.env.ACTIVE_MODEL_PROVIDER || '').toLowerCase()),
      status: 'failed',
      mode: 'local',
      error: err.message,
    });
  }
});

// GET /api/ai/models — configured local model registry
router.get('/models', async (req, res) => {
  try {
    const manager = runtimeManager();
    const models = await Promise.all(ModelRegistry.getAllModels().map(async (model) => ({
      ...model,
      installed: await manager.isModelInstalled(model.id),
    })));

    res.json({
      activeModelId: ModelRegistry.getActiveModelId(),
      storageDir: getModelsDir(),
      models,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/models/:modelId/download — start background download
router.post('/models/:modelId/download', aiMutationLimiter, async (req, res) => {
  try {
    const model = ModelRegistry.getModel(req.params.modelId);
    if (!model) return res.status(404).json({ error: 'Unknown local AI model.' });

    const manager = runtimeManager();
    const status = await manager.getStatus();
    if (status.status === 'downloading' || manager.isDownloading) {
      return res.status(409).json({ error: 'A model download is already in progress.', status });
    }

    manager.downloadModel(model.id).catch((err) => {
      if (!err.cancelled) console.error(`[AI Runtime] Background model download failed: ${err.message}`);
    });

    res.status(202).json(await manager.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/models/:modelId/download/cancel — cancel active download
router.post('/models/:modelId/download/cancel', aiMutationLimiter, async (req, res) => {
  try {
    const manager = runtimeManager();
    manager.cancelDownload();
    res.json(await manager.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/models/:modelId/verify — verify installed model file
router.post('/models/:modelId/verify', aiMutationLimiter, async (req, res) => {
  try {
    const manager = runtimeManager();
    const verification = await manager.verifyModel(req.params.modelId);
    res.json({ verification, status: await manager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/start — start or connect to local runtime
router.post('/start', aiMutationLimiter, async (req, res) => {
  try {
    const manager = runtimeManager();
    await manager.startRuntime(req.body?.modelId);
    res.json(await manager.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message, status: await runtimeManager().getStatus().catch(() => null) });
  }
});

// POST /api/ai/stop — stop local runtime without deleting model
router.post('/stop', aiMutationLimiter, async (req, res) => {
  try {
    const manager = runtimeManager();
    await manager.stopRuntime();
    res.json(await manager.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/disable — let the user continue without AI
router.post('/disable', aiMutationLimiter, async (req, res) => {
  const manager = runtimeManager();
  manager.setDisabled();
  res.json(await manager.getStatus());
});

// POST /api/ai/enable — re-check local AI after being disabled
router.post('/enable', aiMutationLimiter, async (req, res) => {
  try {
    const manager = runtimeManager();
    await manager.reenable();
    res.json(await manager.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/rag/legal-folder/sync — sync browser Legal Folder text into local RAG index
router.post('/rag/legal-folder/sync', aiMutationLimiter, async (req, res) => {
  try {
    if (!aiPolicy.canUseDocumentRag(req.user)) {
      return res.status(403).json({ ok: false, error: 'AI document retrieval is not permitted for this user.' });
    }
    const payloadError = validateRagSyncPayload(req.body);
    if (payloadError) return res.status(413).json({ ok: false, error: payloadError });

    const result = ragService().syncLegalFolder({
      userId: req.user._id,
      source: sanitizeRagSource(req.body?.source),
      documents: req.body?.documents,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ai/rag/legal-folder/status — local RAG index state
router.get('/rag/legal-folder/status', async (req, res) => {
  try {
    if (!aiPolicy.canUseDocumentRag(req.user)) {
      return res.status(403).json({ error: 'AI document retrieval is not permitted for this user.' });
    }
    res.json(ragService().getStatus(req.user._id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/signing-state/sync — sync browser signing-room metadata for AI tools
router.post('/signing-state/sync', aiMutationLimiter, async (req, res) => {
  try {
    const result = signingStateService().sync({
      userId: req.user._id,
      documents: req.body?.documents,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ai/signing-state/status — current user's browser signing-state sync status
router.get('/signing-state/status', async (req, res) => {
  try {
    res.json(signingStateService().getStatus(req.user._id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/rag/backend/status — backend knowledge RAG state
router.get('/rag/backend/status', async (req, res) => {
  try {
    res.json(backendRagService().getStatus(req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/rag/backend/reindex — rebuild backend knowledge RAG
router.post('/rag/backend/reindex', aiMutationLimiter, async (req, res) => {
  try {
    if (!canManageBackendRag(req.user)) {
      return res.status(403).json({ error: 'Only administrators and managers can rebuild backend AI knowledge.' });
    }

    const result = await backendRagService().reindex();
    res.json({
      ok: true,
      indexedAt: result.indexedAt,
      sourceFiles: result.files.length,
      chunks: result.chunks.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ai/chat — main assistant endpoint
router.post('/chat', aiChatLimiter, async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const trimmed = String(message || '').trim();
    if (!trimmed) {
      return res.status(400).json({ type: 'error', message: 'Message is required.' });
    }
    if (trimmed.length > MAX_AI_MESSAGE_CHARS) {
      return res.status(413).json({ type: 'error', message: `Message is too long. Maximum length is ${MAX_AI_MESSAGE_CHARS} characters.` });
    }
    const clientSid = cleanSessionId(sessionId, req.user._id.toString());
    const internalSid = scopedSessionId(req.user, clientSid);
    const result = await getOrchestrator().chat({
      sessionId:  internalSid,
      message:    trimmed,
      user:       req.user,
      ipAddress:  req.ip,
    });
    res.json({ ...result, sessionId: clientSid });
  } catch (err) {
    res.status(500).json({ type: 'error', message: err.message });
  }
});

// POST /api/ai/confirm — confirm a pending medium-risk action
router.post('/confirm', aiMutationLimiter, async (req, res) => {
  try {
    const { confirmationId } = req.body;
    if (!confirmationId) return res.status(400).json({ type: 'error', message: 'confirmationId required.' });
    const result = await getOrchestrator().confirm({
      confirmationId,
      user:      req.user,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ type: 'error', message: err.message });
  }
});

// DELETE /api/ai/session — clear conversation memory
router.delete('/session', (req, res) => {
  const clientSid = cleanSessionId(req.query.sessionId, req.user._id.toString());
  getOrchestrator().clearSession(scopedSessionId(req.user, clientSid));
  res.json({ ok: true });
});

// GET /api/ai/health — model health check
router.get('/health', async (req, res) => {
  try {
    const health = await getOrchestrator().healthCheck();
    res.json(health);
  } catch (err) {
    res.status(500).json({ healthy: false, error: err.message });
  }
});

// GET /api/ai/suggestions — quick suggestion chips
router.get('/suggestions', (req, res) => {
  res.json({
	    suggestions: [
	      'What tracker tasks are overdue?',
	      'Show unassigned workflow tasks',
	      'What needs my attention today?',
	      'Show final documents ready for signing',
	      'Show signed contracts expiring soon',
	      'Show tracker warnings',
	      'Show documents pending signature',
	      'List my tasks',
	    ],
	  });
});

// Legacy /query endpoint kept for backwards compatibility
router.post('/query', aiChatLimiter, async (req, res) => {
  try {
    const { query } = req.body;
    const trimmed = String(query || '').trim();
    if (!trimmed || trimmed.length < 3) {
      return res.status(400).json({ error: 'Query must be at least 3 characters.' });
    }
    if (trimmed.length > MAX_AI_MESSAGE_CHARS) {
      return res.status(413).json({ error: `Query is too long. Maximum length is ${MAX_AI_MESSAGE_CHARS} characters.` });
    }
    const clientSid = req.user._id.toString();
    const result = await getOrchestrator().chat({
      sessionId: scopedSessionId(req.user, clientSid),
      message: trimmed,
      user: req.user,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
