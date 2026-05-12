const fsPromises = require('fs').promises;
const path = require('path');
const { AiDataAccessPolicy } = require('../security/AiDataAccessPolicy');
const { redactSensitiveText, sanitizeRetrievedSnippet } = require('../security/PromptSecurity');

const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const DEFAULT_SERVER_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_SOURCE_DIRS = ['src', 'package.json'];
const MAX_FILE_BYTES = envInt('AI_BACKEND_RAG_MAX_FILE_BYTES', 160000, 1000);
const MAX_CHUNK_CHARS = envInt('AI_BACKEND_RAG_CHUNK_CHARS', 1800, 400);
const CHUNK_OVERLAP_CHARS = envInt('AI_BACKEND_RAG_CHUNK_OVERLAP_CHARS', 180, 0);
const MAX_CONTEXT_SNIPPETS = envInt('AI_BACKEND_RAG_MAX_CONTEXT_SNIPPETS', 8, 1);
const REINDEX_INTERVAL_MS = envInt('AI_BACKEND_RAG_REINDEX_INTERVAL_MS', 60000, 5000);

const BACKEND_QUERY_HINT = /\b(backend|server|api|endpoint|route|controller|middleware|service|model|schema|database|mongodb|mongoose|rbac|permission|role|auth|authentication|jwt|upload|email service|web app|application|feature|workflow|implementation|code|config|environment|how does .* work|what does .* do)\b/i;
const APP_ENTITY_WITH_TECH_HINT = /(?:\b(contract|document|task|template|signing|report|notification|user|legal folder)\b[\s\S]{0,80}\b(model|schema|route|endpoint|api|service|controller|permission|field|backend|server|code|implementation)\b)|(?:\b(model|schema|route|endpoint|api|service|controller|permission|field|backend|server|code|implementation)\b[\s\S]{0,80}\b(contract|document|task|template|signing|report|notification|user|legal folder)\b)/i;

const HELP_FILE_PATTERNS = [
  /^SETUP\.md$/,
  /^src\/ai\/config\/legalWorkflowSla\.js$/,
  /^src\/models\/LegalRequest\.js$/,
  /^src\/models\/SignatureRequest\.js$/,
  /^src\/models\/Signatory\.js$/,
  /^src\/services\/legalWorkflowService\.js$/,
  /^src\/services\/signingService\.js$/,
];

const SOURCE_FILE_PATTERNS = [
  /^src\/routes\//,
  /^src\/models\//,
  /^src\/middleware\//,
  /^src\/services\//,
  /^src\/ai\//,
  /^src\/config\//,
  /^src\/server\.js$/,
  /^src\/schemas\//,
  /^SETUP\.md$/,
  /^package\.json$/,
];

const DENY_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)?/,
  /(^|\/)node_modules\//,
  /(^|\/)uploads\//,
  /(^|\/)legal-folder\//,
  /(^|\/)templates\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)tests?\//,
  /(^|\/)__pycache__\//,
  /\.(pdf|docx?|png|jpe?g|gif|zip|gz|bin|gguf)$/i,
];

const SENSITIVE_FIELD_RE = /^(password|lockedPassword|signatureData|initialsData|token|secret|apiKey|jwt|certificate|privateKey)$/i;

const normalizeText = (value) =>
  String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const tokenize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
  'who', 'why', 'how', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'you',
  'please', 'show', 'tell', 'about', 'into', 'onto', 'does', 'did', 'which',
  'app', 'application', 'backend', 'server',
]);

const isTextFile = (filePath) => /\.(js|json|md|txt)$/i.test(filePath);

const safeRel = (rootDir, filePath) => path.relative(rootDir, filePath).replace(/\\/g, '/');

const isDenied = (relPath) => DENY_PATH_PATTERNS.some((pattern) => pattern.test(relPath));

const hasAllowedPattern = (relPath, patterns) => patterns.some((pattern) => pattern.test(relPath));

class BackendKnowledgeRagService {
  constructor(options = {}) {
    this._rootDir = options.rootDir || DEFAULT_SERVER_ROOT;
    this._sourceDirs = options.sourceDirs || DEFAULT_SOURCE_DIRS;
    this._includeSource = options.includeSource ?? process.env.AI_BACKEND_RAG_INCLUDE_SOURCE !== 'false';
    this._enabled = options.enabled ?? process.env.AI_BACKEND_RAG_ENABLED !== 'false';
    this._policy = options.policy || new AiDataAccessPolicy();
    this._chunks = [];
    this._files = [];
    this._indexedAt = null;
    this._lastAttemptAt = 0;
    this._indexingPromise = null; // guard against concurrent reindex
  }

  shouldRetrieve(query, user) {
    if (!this._enabled) return false;
    if (user !== undefined && !this._canUseAnyBackendRag(user)) return false;
    return BACKEND_QUERY_HINT.test(query || '') || APP_ENTITY_WITH_TECH_HINT.test(query || '');
  }

  getStatus(user) {
    const helpChunks = this._chunks.filter((chunk) => chunk.audience === 'help').length;
    const sourceChunks = this._chunks.filter((chunk) => chunk.audience === 'source').length;
    const hasHelp = this._policy.canUseBackendRag(user, 'help');
    const hasSource = this._policy.canUseBackendRag(user, 'source');
    return {
      enabled: this._enabled,
      indexed: Boolean(this._indexedAt),
      indexedAt: this._indexedAt,
      sourceFiles: this._files.length,
      chunks: (hasHelp || hasSource) ? this._chunks.length : 0,
      helpChunks: hasHelp ? helpChunks : 0,
      sourceChunks: hasSource ? sourceChunks : undefined,
      publicChunks: hasHelp ? helpChunks : 0,
      internalChunks: hasSource ? sourceChunks : undefined,
      helpAccess: hasHelp,
      sourceAccess: hasSource,
      publicAccess: hasHelp,
      internalAccess: hasSource,
    };
  }

  async reindex() {
    this._chunks = [];
    this._files = [];
    this._indexedAt = null;
    return this._buildIndex({ force: true });
  }

  async retrieve({ user, query }) {
    if (!this.shouldRetrieve(query, user)) return null;

    const index = await this._buildIndex();
    const tokens = tokenize(query);
    if (tokens.length === 0 || !index.chunks.length) return null;

    const allowHelp = this._policy.canUseBackendRag(user, 'help');
    const allowSource = this._policy.canUseBackendRag(user, 'source');
    const candidates = index.chunks
      .filter((chunk) => (chunk.audience === 'help' && allowHelp) || (chunk.audience === 'source' && allowSource))
      .map((chunk) => ({ ...chunk, score: this._scoreChunk(chunk, query, tokens) }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CONTEXT_SNIPPETS);

    if (!candidates.length) return null;

    return {
      snippets: candidates.map((chunk, index) => ({
        id: `BK${index + 1}`,
        title: chunk.title,
        sourcePath: chunk.sourcePath,
        sourceLabel: chunk.sourceLabel,
        audience: chunk.audience,
        snippet: chunk.text,
        securityFlags: chunk.securityFlags || [],
      })),
    };
  }

  formatContext(retrieval) {
    if (!retrieval?.snippets?.length) return '';

    return retrieval.snippets.map((item) => [
      `[${item.id}] Backend reference: ${item.title}`,
      item.audience === 'source' ? `Path: ${item.sourcePath}` : `Source: ${item.sourceLabel || path.basename(item.sourcePath || '') || 'App help'}`,
      `Audience: ${item.audience}`,
      item.securityFlags?.length ? `Security note: prompt-like instructions were detected and removed. Flags: ${item.securityFlags.join(', ')}` : null,
      `Excerpt: ${item.snippet}`,
    ].filter(Boolean).join('\n')).join('\n\n');
  }

  async _buildIndex(options = {}) {
    const now = Date.now();
    if (!options.force && this._indexedAt && now - this._lastAttemptAt < REINDEX_INTERVAL_MS) {
      return { chunks: this._chunks, files: this._files, indexedAt: this._indexedAt };
    }

    this._lastAttemptAt = now;
    if (!this._enabled) return { chunks: [], files: [], indexedAt: null };

    if (this._indexingPromise) return this._indexingPromise;
    this._indexingPromise = this._runIndex().finally(() => { this._indexingPromise = null; });
    return this._indexingPromise;
  }

  async _runIndex() {
    const files = await this._collectFiles();
    const chunks = [];

    for (const file of files) {
      const relPath = safeRel(this._rootDir, file);
      const text = await this._readSafeFile(file);
      if (!text) continue;

      chunks.push(...this._buildHelpChunks(relPath, text));
      if (this._includeSource && hasAllowedPattern(relPath, SOURCE_FILE_PATTERNS)) {
        chunks.push(...this._chunkSourceFile(relPath, text));
      }
    }

    this._chunks = chunks;
    this._files = files.map((file) => safeRel(this._rootDir, file));
    this._indexedAt = new Date();

    return { chunks: this._chunks, files: this._files, indexedAt: this._indexedAt };
  }

  async _collectFiles() {
    const collected = [];
    const visit = async (targetPath) => {
      const resolved = path.resolve(this._rootDir, targetPath);
      if (resolved !== this._rootDir && !resolved.startsWith(`${this._rootDir}${path.sep}`)) return;

      let stat;
      try {
        stat = await fsPromises.stat(resolved);
      } catch {
        return;
      }

      const relPath = safeRel(this._rootDir, resolved);
      if (isDenied(relPath)) return;

      if (stat.isDirectory()) {
        let entries;
        try { entries = await fsPromises.readdir(resolved); } catch { return; }
        for (const entry of entries) {
          await visit(path.join(targetPath, entry));
        }
        return;
      }

      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || !isTextFile(resolved)) return;
      if (!hasAllowedPattern(relPath, SOURCE_FILE_PATTERNS) && !hasAllowedPattern(relPath, HELP_FILE_PATTERNS)) return;
      collected.push(resolved);
    };

    for (const sourceDir of this._sourceDirs) await visit(sourceDir);
    return collected.sort();
  }

  async _readSafeFile(filePath) {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      return redactSensitiveText(raw, {
        redactPii: false,
        maxChars: MAX_FILE_BYTES,
      });
    } catch {
      return '';
    }
  }

  _buildHelpChunks(relPath, text) {
    if (!hasAllowedPattern(relPath, HELP_FILE_PATTERNS)) return [];

    if (relPath === 'SETUP.md') {
      return this._helpTextChunks(relPath, 'Setup guide', text);
    }
    if (relPath === 'src/ai/config/legalWorkflowSla.js') {
      return this._slaHelpChunks(relPath, text);
    }
    if (relPath === 'src/models/LegalRequest.js' || relPath === 'src/services/legalWorkflowService.js') {
      return this._workflowHelpChunks(relPath, text);
    }
    if (relPath === 'src/models/SignatureRequest.js' || relPath === 'src/models/Signatory.js' || relPath === 'src/services/signingService.js') {
      return this._signingHelpChunks(relPath, text);
    }

    return [];
  }

  _routeSummaryChunks(relPath, text) {
    const routes = [];
    const routeRe = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    for (const match of text.matchAll(routeRe)) {
      routes.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
    if (!routes.length) return [];

    return [this._makeChunk({
      title: `Routes in ${relPath}`,
      sourcePath: relPath,
      audience: 'source',
      text: `Backend route file ${relPath} exposes these route handlers:\n${routes.map((route) => `- ${route}`).join('\n')}`,
    })];
  }

  _modelSummaryChunks(relPath, text) {
    const schemaName = path.basename(relPath, '.js');
    const fields = [...new Set([...text.matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*(?:\{|\[|new mongoose\.Schema)/gm)]
      .map((match) => match[1])
      .filter((field) => !SENSITIVE_FIELD_RE.test(field))
      .slice(0, 80))];

    if (!fields.length) return [];
    return [this._makeChunk({
      title: `${schemaName} data model`,
      sourcePath: relPath,
      audience: 'source',
      text: `${schemaName} model fields visible for assistant documentation: ${fields.join(', ')}.`,
    })];
  }

  _rbacSummaryChunks(relPath, text) {
    const roles = [...text.matchAll(/^\s*(admin|manager|staff|external)\s*:/gm)].map((match) => match[1]);
    const permissions = [...new Set([...text.matchAll(/'([a-z]+:[a-z]+)'/g)].map((match) => match[1]))].sort();
    return [this._makeChunk({
      title: 'RBAC roles and permissions',
      sourcePath: relPath,
      audience: 'source',
      text: `The backend defines these roles: ${roles.join(', ')}. Permission names include: ${permissions.join(', ')}.`,
    })];
  }

  _serverSummaryChunks(relPath, text) {
    const mounts = [...text.matchAll(/app\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z]\w+)/g)]
      .map((match) => `${match[1]} -> ${match[2]}`);
    return [this._makeChunk({
      title: 'Express server route mounts and middleware',
      sourcePath: relPath,
      audience: 'source',
      text: `Express server mounts: ${mounts.join(', ')}. Core middleware includes helmet, CORS, JSON body parsing, URL encoding, static file serving, and rate limiting.`,
    })];
  }

  _helpTextChunks(relPath, title, text) {
    const clean = normalizeText(text).slice(0, MAX_CHUNK_CHARS);
    if (!clean) return [];
    return [this._makeChunk({ title, sourcePath: relPath, sourceLabel: title, audience: 'help', text: clean })];
  }

  _workflowHelpChunks(relPath, text) {
    const statusesMatch = text.match(/const ALL_STATUSES = \[([\s\S]*?)\];/);
    const statuses = statusesMatch
      ? [...statusesMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
      : [];
    const safeStatusText = statuses.length
      ? `Workflow statuses include: ${statuses.join(', ')}.`
      : 'Workflow records move through submitted, review, approval, signature, storage, closure, hold, and cancellation states.';

    return [this._makeChunk({
      title: 'Legal workflow help',
      sourcePath: relPath,
      sourceLabel: 'Workflow help',
      audience: 'help',
      text: [
        safeStatusText,
        'Operational due dates use dueDate. targetDate is the original calculated target date and may differ when dueDate is overridden.',
        'Signature progress is tracked with signatureEmailSentAt, pendingSignatoriesCount, completedSignatoriesCount, isFullySigned, and fullySignedAt.',
        'Workflow history records status, holder, assignment, due-date, document, task, signature, and comment events as a timeline.',
        'Live workflow records must be accessed through AI tools so RBAC and DataScope filters can be applied.',
      ].join(' '),
    })];
  }

  _slaHelpChunks(relPath, text) {
    const entries = [...text.matchAll(/([A-Z_]+):\s*(\d+)/g)]
      .map((match) => `${match[1]}=${match[2]}`);
    return [this._makeChunk({
      title: 'Legal workflow SLA help',
      sourcePath: relPath,
      sourceLabel: 'Workflow SLA help',
      audience: 'help',
      text: `Central legal workflow SLA thresholds: ${entries.join(', ')}. External turnaround is met when a request is completed or sent for signature within the configured threshold; signature completion is tracked separately.`,
    })];
  }

  _signingHelpChunks(relPath, text) {
    const statuses = [...new Set([...text.matchAll(/'([A-Z_]+)'/g)]
      .map((match) => match[1])
      .filter((value) => ['DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'FULLY_SIGNED', 'EXPIRED', 'CANCELLED', 'PENDING', 'EMAIL_SENT', 'VIEWED', 'SIGNED', 'DECLINED'].includes(value)))];
    return [this._makeChunk({
      title: 'Signing process help',
      sourcePath: relPath,
      sourceLabel: 'Signing help',
      audience: 'help',
      text: [
        'Signing is tracked through signature requests, signatories, documents, and workflow status fields.',
        statuses.length ? `Signing statuses include: ${statuses.join(', ')}.` : '',
        'Safe AI answers may include document title, signature status, signedAt, signatureEmailSentAt, pending signatory counts, and reminder timing.',
        'Secure signing links, signing tokens, raw evidence packages, IP addresses, device fingerprints, and certificate internals must not be exposed through AI responses.',
      ].filter(Boolean).join(' '),
    })];
  }

  _chunkSourceFile(relPath, text) {
    const clean = normalizeText(text);
    if (!clean) return [];

    const chunks = [];
    let cursor = 0;
    let part = 1;
    while (cursor < clean.length) {
      const end = Math.min(clean.length, cursor + MAX_CHUNK_CHARS);
      chunks.push(this._makeChunk({
        title: `${relPath} source part ${part}`,
        sourcePath: relPath,
        audience: 'source',
        text: clean.slice(cursor, end),
      }));
      if (end >= clean.length) break;
      cursor = Math.max(end - CHUNK_OVERLAP_CHARS, cursor + 1);
      part += 1;
    }

    return chunks;
  }

  _makeChunk({ title, sourcePath, sourceLabel, audience, text }) {
    const sanitized = sanitizeRetrievedSnippet(text, {
      maxChars: MAX_CHUNK_CHARS,
      redactPii: false,
    });

    return {
      title,
      sourcePath,
      sourceLabel,
      audience,
      text: sanitized.text,
      securityFlags: sanitized.securityFlags,
    };
  }

  _scoreChunk(chunk, query, tokens) {
    const haystack = `${chunk.title} ${chunk.sourcePath} ${chunk.text}`.toLowerCase();
    let score = 0;
    for (const token of [...new Set(tokens)]) {
      if (haystack.includes(token)) score += token.length > 5 ? 2 : 1;
    }

    const queryText = String(query || '').toLowerCase().trim();
    if (queryText && haystack.includes(queryText)) score += 4;
    if (chunk.audience === 'help' && score > 0) score += 1;
    if (/route|endpoint|api/.test(queryText) && chunk.sourcePath.includes('routes/')) score += 4;
    if (/model|schema|field|database/.test(queryText) && chunk.sourcePath.includes('models/')) score += 4;
    if (/permission|role|rbac/.test(queryText) && chunk.sourcePath.includes('rbac')) score += 4;

    return score;
  }

  _canUseAnyBackendRag(user) {
    return this._policy.canUseBackendRag(user, 'help') || this._policy.canUseBackendRag(user, 'source');
  }
}

let instance;
const getBackendKnowledgeRagService = () => {
  if (!instance) instance = new BackendKnowledgeRagService();
  return instance;
};

module.exports = {
  BackendKnowledgeRagService,
  getBackendKnowledgeRagService,
};
