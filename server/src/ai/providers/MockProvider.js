const { AIModelProvider } = require('./AIModelProvider');

/**
 * Deterministic mock provider.
 * Used when no real model is configured or during testing.
 * Maps common phrases to tool calls so the assistant still works
 * in demo mode without any local model installed.
 */
class MockProvider extends AIModelProvider {
  get name()         { return 'mock'; }
  get family()       { return 'mock'; }
  get capabilities() {
    return {
      supportsToolCalling:    true,
      supportsJsonSchema:     true,
      supportsStreaming:      false,
      supportsVision:         false,
      maxContextTokens:       4096,
      recommendedTemperature: 0.0,
    };
  }

  async generate(input) {
    const last   = input.messages?.[input.messages.length - 1];
    const text   = (last?.content || last?.text || '').toLowerCase();

    if (text.includes('help') || text.includes('what can you')) {
      return { type: 'tool_call', toolName: 'show_help', arguments: {} };
    }
    if (text.includes('overdue')) {
      return { type: 'tool_call', toolName: 'list_overdue_tasks', arguments: { mine_only: false } };
    }
    if (text.includes('my task')) {
      return { type: 'tool_call', toolName: 'list_my_tasks', arguments: {} };
    }
    if (/\b(expired|already expired|have expired|has expired|past expiry|past expiration)\b/.test(text) && text.includes('contract')) {
      return { type: 'tool_call', toolName: 'get_expired_contracts', arguments: { countOnly: text.includes('how many') || text.includes('count') } };
    }
    if (/\b(expiring|expire soon|expires soon|expire in|expires in|expire next|expires next|expiry soon|about to expire|renewal)\b/.test(text) && text.includes('contract')) {
      const m    = text.match(/(\d+)\s*(day|week|month)/);
      const mult = { day: 1, week: 7, month: 30 };
      const days = m ? parseInt(m[1]) * (mult[m[2]] || 1) : 30;
      return { type: 'tool_call', toolName: 'count_expiring_contracts', arguments: { days } };
    }
    if (text.includes('pending signature') || (text.includes('sign') && text.includes('pending'))) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: {} };
    }
    if (text.includes('drafter') || text.includes('drafting') || text.includes('who is draft')) {
      return { type: 'tool_call', toolName: 'show_current_drafters', arguments: {} };
    }
    if (text.includes('navigate') || text.includes('go to') || text.includes('open page')) {
      const page = text.replace(/navigate|go to|open page|page/g, '').trim() || 'dashboard';
      return { type: 'tool_call', toolName: 'navigate_to_page', arguments: { page } };
    }
    if (text.includes('search') || text.includes('find') || text.includes('contract')) {
      const q = text.replace(/search|find|for|the|a|an|contract/g, '').trim();
      return { type: 'tool_call', toolName: 'search_contracts', arguments: { query: q || 'all' } };
    }

    return {
      type: 'assistant_message',
      content: "I'm ready to help. You can ask me to search contracts, check expiring contracts, list tasks, show signing status, or navigate to any page.",
    };
  }

  async healthCheck() {
    return { healthy: true, note: 'Mock provider — always available. Configure a real model for production.' };
  }
}

module.exports = { MockProvider };
