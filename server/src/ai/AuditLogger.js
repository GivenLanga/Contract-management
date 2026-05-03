const AuditLog = require('../models/AuditLog');
const { redactSensitiveText } = require('./security/PromptSecurity');

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'signatureData',
  'initialsData',
  'apiKey',
  'authorization',
  'cookie',
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
