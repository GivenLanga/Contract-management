const path = require('path');
const { getAiCapabilities } = require('./AiCapabilities');
const { redactSensitiveFields } = require('./FieldFilter');
const { redactSensitiveText, sanitizeRetrievedSnippet } = require('./PromptSecurity');

const DEFAULT_MAX_CHARS = 12000;
const SOURCE_AUDIENCES = new Set(['source', 'source_code', 'backend_source', 'internal']);

const safeLabel = (value, allowPath = false) => {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text) return '';
  if (allowPath) return text.replace(/(^|\/)\.\.(\/|$)/g, '');
  return path.basename(text) || text;
};

const trimToRemaining = (text, remaining) => {
  if (remaining <= 0) return '';
  const normalized = String(text || '');
  return normalized.length > remaining
    ? `${normalized.slice(0, Math.max(0, remaining - 20)).trim()} [truncated]`
    : normalized;
};

const formatSecurityFlags = (flags) =>
  Array.isArray(flags) && flags.length
    ? `Security note: prompt-like instructions were detected and neutralized. Flags: ${flags.join(', ')}`
    : null;

function formatRagSnippets({ snippets, prefix, sourceType, capabilities, maxChars }) {
  let redactionCount = 0;
  let blockedContextCount = 0;
  const warnings = [];
  const parts = [];
  let used = 0;

  for (const raw of snippets || []) {
    const audience = String(raw.audience || '').toLowerCase();
    if (sourceType === 'backend' && SOURCE_AUDIENCES.has(audience) && !capabilities.backendSourceRag) {
      blockedContextCount += 1;
      continue;
    }

    const sanitized = sanitizeRetrievedSnippet(raw.snippet || raw.text || '', {
      maxChars: Math.min(1800, maxChars),
      redactPii: sourceType !== 'backend' || !capabilities.backendSourceRag,
    });
    redactionCount += sanitized.securityFlags.length;

    const id = raw.id || `${prefix}${parts.length + 1}`;
    const allowPath = sourceType === 'backend' && capabilities.backendSourceRag;
    const source = safeLabel(raw.sourceLabel || raw.sourcePath || raw.documentName || raw.title, allowPath);
    const title = redactSensitiveText(raw.title || raw.documentName || 'Reference', { maxChars: 200 });
    const lines = [
      `[${id}] ${sourceType === 'backend' ? 'Backend reference' : 'Legal document'}: ${title}`,
      source ? `Source: ${source}` : null,
      raw.contractTitle ? `Contract: ${redactSensitiveText(raw.contractTitle, { maxChars: 200 })}` : null,
      raw.status ? `Status: ${redactSensitiveText(raw.status, { maxChars: 80 })}` : null,
      raw.audience ? `Access level: ${redactSensitiveText(raw.audience, { maxChars: 80 })}` : null,
      formatSecurityFlags([...(raw.securityFlags || []), ...sanitized.securityFlags]),
      `Excerpt: ${sanitized.text}`,
    ].filter(Boolean);

    const block = lines.join('\n');
    const remaining = maxChars - used;
    const kept = trimToRemaining(block, remaining);
    if (!kept) {
      warnings.push('AI context was truncated before all retrieved snippets could be included.');
      blockedContextCount += 1;
      break;
    }
    parts.push(kept);
    used += kept.length + 2;
  }

  return {
    context: parts.join('\n\n'),
    warnings,
    redactionCount,
    blockedContextCount,
  };
}

function formatToolResults({ toolResults, user, maxChars }) {
  const parts = [];
  let used = 0;
  for (const result of toolResults || []) {
    const safe = redactSensitiveFields(result, { user, maxStringChars: 600 });
    const text = redactSensitiveText(JSON.stringify(safe), { maxChars: Math.min(1800, maxChars) });
    const kept = trimToRemaining(text, maxChars - used);
    if (!kept) break;
    parts.push(kept);
    used += kept.length + 2;
  }
  return parts.join('\n\n');
}

function buildSafeAiContext({
  user,
  capabilities = getAiCapabilities(user),
  legalRagResults = [],
  backendRagResults = [],
  toolResults = [],
  maxChars = DEFAULT_MAX_CHARS,
}) {
  const legalBudget = Math.floor(maxChars * 0.5);
  const backendBudget = Math.floor(maxChars * 0.35);
  const toolBudget = Math.max(1000, maxChars - legalBudget - backendBudget);

  const legal = formatRagSnippets({
    snippets: legalRagResults,
    prefix: 'LF',
    sourceType: 'legal',
    capabilities,
    maxChars: legalBudget,
  });
  const backend = formatRagSnippets({
    snippets: backendRagResults,
    prefix: 'BK',
    sourceType: 'backend',
    capabilities,
    maxChars: backendBudget,
  });

  return {
    safeLegalContext: legal.context,
    safeBackendContext: backend.context,
    safeToolContext: formatToolResults({ toolResults, user, maxChars: toolBudget }),
    warnings: [...legal.warnings, ...backend.warnings],
    redactionCount: legal.redactionCount + backend.redactionCount,
    blockedContextCount: legal.blockedContextCount + backend.blockedContextCount,
  };
}

module.exports = {
  buildSafeAiContext,
};
