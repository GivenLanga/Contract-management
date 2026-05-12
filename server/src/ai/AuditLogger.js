const AuditLog = require('../models/AuditLog');
const { redactSensitiveText } = require('./security/PromptSecurity');

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'secret',
  'signatureData',
  'initialsData',
  'signatureToken',
  'signingToken',
  'signingUrl',
  'secureUrl',
  'evidence',
  'ipAddress',
  'userAgent',
  'certificate',
  'apiKey',
  'authorization',
  'cookie',
  'prompt',
  'snippet',
  'payload',
]);

class AuditLogger {
  async logToolCall({ user, toolName, args, result, ipAddress }) {
    try {
      if (AuditLog.db.readyState !== 1) return;
      await AuditLog.create({
        action: `AI tool: ${toolName}`,
        category: 'system',
        performedBy: user?._id,
        performedByEmail: user?.email,
        ipAddress,
        metadata: {
          toolName,
          args: this._sanitise(args),
          resultType: result?.type,
        },
        result: result?.type === 'error' ? 'failure' : 'success',
        errorMessage: result?.type === 'error' ? result.message : undefined,
      });
    } catch {
      // Audit failures must not break the assistant response
    }
  }

  async logSecurityEvent({ user, eventType, detail, ipAddress }) {
    try {
      if (AuditLog.db.readyState !== 1) return;
      await AuditLog.create({
        action: `AI security: ${eventType}`,
        category: 'system',
        performedBy: user?._id,
        performedByEmail: user?.email,
        ipAddress,
        metadata: this._sanitise(detail),
        result: 'failure',
      });
    } catch {
      // Audit failures must not break the assistant response
    }
  }

  async logRagRetrieval({ user, sourceType, query, retrievedCount = 0, blockedCount = 0, securityFlags = [], redactionCount = 0, ipAddress }) {
    try {
      if (AuditLog.db.readyState !== 1) return;
      await AuditLog.create({
        action: `AI RAG: ${sourceType}`,
        category: 'system',
        performedBy: user?._id,
        performedByEmail: user?.email,
        ipAddress,
        metadata: this._sanitise({
          sourceType,
          querySummary: String(query || '').slice(0, 160),
          retrievedCount,
          blockedCount,
          securityFlags: Array.from(new Set(securityFlags || [])).slice(0, 20),
          redactionCount,
          userRole: user?.role,
        }),
        result: blockedCount > 0 || securityFlags?.length ? 'failure' : 'success',
      });
    } catch {
      // Audit failures must not break the assistant response
    }
  }

  async logAiTimeout({ user, phase, timeoutMs, ipAddress }) {
    try {
      if (AuditLog.db.readyState !== 1) return;
      await AuditLog.create({
        action: `AI timeout: ${phase}`,
        category: 'system',
        performedBy: user?._id,
        performedByEmail: user?.email,
        ipAddress,
        metadata: { phase, timeoutMs },
        result: 'failure',
      });
    } catch {
      // Audit failures must not break the assistant response
    }
  }

  _sanitise(args) {
    if (args === null || args === undefined) return args;
    if (typeof args === 'string') return redactSensitiveText(args, { maxChars: 500 });
    if (typeof args !== 'object') return args;
    if (Array.isArray(args)) return args.slice(0, 20).map((item) => this._sanitise(item));

    const safe = {};
    for (const [key, value] of Object.entries(args)) {
      const normalizedKey = key.toLowerCase();
      if ([...SENSITIVE_KEYS].some((sensitive) => normalizedKey.includes(sensitive.toLowerCase()))) {
        safe[key] = '[redacted]';
      } else {
        safe[key] = this._sanitise(value);
      }
    }
    return safe;
  }
}

module.exports = { AuditLogger };
