const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const TTL_MS      = 30 * 60 * 1000; // 30 minutes
const MAX_TURNS   = envInt('AI_MEMORY_MAX_MESSAGES', 8, 4);
const MAX_MESSAGE_CHARS = envInt('AI_MEMORY_MAX_MESSAGE_CHARS', 1200, 500);
const MAX_SESSIONS = envInt('AI_MEMORY_MAX_SESSIONS', 500, 10);
const PRUNE_EVERY = 5 * 60 * 1000;  // prune stale sessions every 5 min
const { redactSensitiveText } = require('../security/PromptSecurity');

const compactMessage = (message) => ({
  role: message.role,
  content: redactSensitiveText(message.content, { maxChars: MAX_MESSAGE_CHARS }),
});

class ConversationMemory {
  constructor() {
    this._sessions = new Map();
    this._pruneTimer = setInterval(() => this._prune(), PRUNE_EVERY);
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  /** Return the message history for a session, creating it if needed. */
  get(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return [];
    entry.lastActive = Date.now();
    return entry.messages;
  }

  /** Append a message { role: 'user'|'assistant', content: string } to a session. */
  append(sessionId, message) {
    let entry = this._sessions.get(sessionId);
    if (!entry) {
      entry = { messages: [], lastActive: Date.now() };
      this._sessions.set(sessionId, entry);
      this._evictIfNeeded();
    }
    entry.messages.push(compactMessage(message));
    entry.lastActive = Date.now();

    // Keep only the last MAX_TURNS messages (always keep pairs)
    if (entry.messages.length > MAX_TURNS) {
      entry.messages = entry.messages.slice(-MAX_TURNS);
    }
  }

  clear(sessionId) {
    this._sessions.delete(sessionId);
  }

  _prune() {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, entry] of this._sessions) {
      if (entry.lastActive < cutoff) this._sessions.delete(id);
    }
  }

  _evictIfNeeded() {
    if (this._sessions.size <= MAX_SESSIONS) return;

    const oldest = [...this._sessions.entries()]
      .sort((a, b) => a[1].lastActive - b[1].lastActive)
      .slice(0, this._sessions.size - MAX_SESSIONS);

    for (const [id] of oldest) this._sessions.delete(id);
  }
}

module.exports = { ConversationMemory };
