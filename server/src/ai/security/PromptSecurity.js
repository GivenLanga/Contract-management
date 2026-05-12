const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const DEFAULT_MAX_TEXT_CHARS = envInt('AI_MAX_ASSISTANT_MESSAGE_CHARS', 4000, 1000);

const PROMPT_INJECTION_PATTERNS = [
  { name: 'ignore-instructions', regex: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|above|prior|system|developer|hidden)\s+instructions?\b/gi },
  { name: 'system-prompt-request', regex: /\b(?:reveal|print|show|dump|repeat|expose)\s+(?:the\s+)?(?:system prompt|developer message|hidden instructions?|initial instructions?)\b/gi },
  { name: 'tool-control', regex: /\b(?:tool_call|function_call|call\s+the\s+tool|execute\s+the\s+function|run\s+this\s+tool)\b/gi },
  { name: 'data-exfiltration', regex: /\b(?:exfiltrate|send|post|upload)\b[\s\S]{0,80}\b(?:webhook|callback|http:\/\/|https:\/\/|external server)\b/gi },
  { name: 'policy-bypass', regex: /\b(?:jailbreak|developer mode|do anything now|bypass(?:es)?\s+(?:policy|safety|guardrails?))\b/gi },
];

const SYSTEM_PROMPT_LEAK_PATTERNS = [
  /\bRESPONSE RULES\b/i,
  /\bTool selection guide\b/i,
  /\bAvailable tools:\b/i,
  /\bCurrent user:.*\brole:/i,
  /<\|im_start\|>system/i,
  /"type"\s*:\s*"tool_call"/i,
];

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bmongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
  /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi,
  /\bmysql:\/\/[^\s"'<>]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:JWT_SECRET|ENCRYPTION_KEY|DATABASE_URL|MONGO_URI|SMTP_PASS|SMTP_PASSWORD|HF_TOKEN)\s*[:=]\s*["']?[^"'\s,;]{4,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
  /\b(?:signing|signature)[_-]?(?:token|link|url)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
  /\/(?:sign|signing|signature)\/(?:public\/)?[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*token[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/gi,
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\b/g,
];

const SIGNING_URL_PATTERNS = [
  /https?:\/\/[^\s"'<>]*(?:signing|signature|sign)[^\s"'<>]*(?:token|access|public)[^\s"'<>]*/gi,
  /\/api\/sign(?:ing|ature)?\/[^\s"'<>]*(?:token|public|external)[^\s"'<>]*/gi,
];

const SOURCE_CODE_LEAK_PATTERNS = [
  /\bmongoose\.Schema\b/,
  /\bmodule\.exports\b/,
  /\brouter\.(get|post|put|patch|delete)\s*\(/,
  /\bprocess\.env\.[A-Z0-9_]+\b/,
  /\brequire\(['"][^'"]+['"]\)/,
];

const PII_PATTERNS = [
  { regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[redacted-email]' },
  { regex: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, replacement: '[redacted-phone]' },
];

const normalizePromptText = (value, maxChars = DEFAULT_MAX_TEXT_CHARS) =>
  Array.from(String(value || ''), (char) => {
    const code = char.charCodeAt(0);
    if (code === 0) return '';
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127) return ' ';
    return char;
  }).join('')
    .replace(/[ \t]{2,}/g, ' ')
    .slice(0, maxChars)
    .trim();

const redactSensitiveText = (value, options = {}) => {
  const { redactPii = false, maxChars = DEFAULT_MAX_TEXT_CHARS } = options;
  let text = normalizePromptText(value, maxChars);

  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, '[redacted-secret]');
  }
  for (const pattern of SIGNING_URL_PATTERNS) {
    text = text.replace(pattern, '[redacted-signing-link]');
  }

  if (redactPii) {
    for (const { regex, replacement } of PII_PATTERNS) {
      text = text.replace(regex, replacement);
    }
  }

  return text;
};

const detectPromptInjection = (value) => {
  const text = String(value || '');
  const matches = [];
  for (const { name, regex } of PROMPT_INJECTION_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) matches.push(name);
  }
  return { detected: matches.length > 0, matches };
};

const stripPromptLikeInstructions = (value) => {
  let text = String(value || '');
  for (const { regex } of PROMPT_INJECTION_PATTERNS) {
    regex.lastIndex = 0;
    text = text.replace(regex, '[removed-prompt-instruction]');
  }
  return text;
};

const sanitizeRetrievedSnippet = (value, options = {}) => {
  const {
    maxChars = envInt('AI_RAG_SNIPPET_MAX_CHARS', 1400, 400),
    redactPii = process.env.AI_REDACT_RAG_PII !== 'false',
  } = options;

  const normalized = normalizePromptText(value, maxChars);
  const detection = detectPromptInjection(normalized);
  const stripped = detection.detected ? stripPromptLikeInstructions(normalized) : normalized;
  return {
    text: redactSensitiveText(stripped, { redactPii, maxChars }),
    securityFlags: detection.matches,
  };
};

const sanitizeAssistantContent = (value, options = {}) => {
  const { capabilities } = options;
  let content = redactSensitiveText(value, { maxChars: DEFAULT_MAX_TEXT_CHARS });

  if (SYSTEM_PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(content))) {
    return {
      blocked: true,
      content: 'I cannot reveal internal assistant instructions or hidden configuration. I can still help with contract, task, document, or signing questions.',
    };
  }

  if (capabilities && !capabilities.backendSourceRag && SOURCE_CODE_LEAK_PATTERNS.some((pattern) => pattern.test(content))) {
    return {
      blocked: true,
      content: 'I cannot reveal backend source code or implementation internals for your role. I can provide safe product help or answer permitted app-data questions through tools.',
    };
  }

  return { blocked: false, content };
};

module.exports = {
  detectPromptInjection,
  normalizePromptText,
  redactSensitiveText,
  sanitizeAssistantContent,
  sanitizeRetrievedSnippet,
};
