'use strict';

const { normalizeMessage } = require('./AIRequestNormalizer');

const DEFAULT_HEALTH_TIMEOUT_MS = 750;

const withTimeout = async (promise, timeoutMs) => {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ healthy: false, timeout: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

class DraftingIntentHandler {
  constructor(opts = {}) {
    this._healthTimeoutMs = opts.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS;
  }

  async handle({ message, provider }) {
    const text = normalizeMessage(message);
    if (!this.isDraftingQuery(text)) return null;

    if (this._isUnderspecified(text)) {
      return {
        type: 'clarification_required',
        category: 'drafting',
        title: 'Drafting Details Needed',
        summary: 'I can help draft that, but I need the source agreement or template, the change you want, the effective date, and the parties involved.',
        metrics: {},
        items: [],
      };
    }

    const health = provider?.healthCheck
      ? await withTimeout(provider.healthCheck(), this._healthTimeoutMs).catch((err) => ({ healthy: false, error: err.message }))
      : { healthy: false, error: 'No local model health check is available.' };

    if (!health?.healthy) {
      return {
        type: 'drafting_unavailable',
        category: 'local_model_required',
        title: 'Drafting Unavailable',
        summary: 'Drafting requires the local AI model, but it is currently unavailable or too slow. Restart local AI or use a template-based draft if available.',
        metrics: { healthCheckTimedOut: Boolean(health?.timeout) },
        items: [],
      };
    }

    // Returning null lets AssistantOrchestrator use the normal local-model path,
    // now that the runtime has passed the fast health gate.
    return null;
  }

  isDraftingQuery(text) {
    return /\b(draft|write|prepare|generate|rewrite)\b/.test(text) &&
      /\b(addendum|contract|agreement|nda|clause|letter|notice|template|amendment)\b/.test(text);
  }

  _isUnderspecified(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 5) return true;
    return /^(draft|write|prepare|generate)\s+(an?\s+)?(addendum|contract|agreement|nda|clause|amendment)$/.test(text);
  }
}

module.exports = { DraftingIntentHandler };
