const fetch = require('node-fetch');
const { AIModelProvider } = require('./AIModelProvider');

class OllamaProvider extends AIModelProvider {
  constructor(config = {}) {
    super();
    this._name    = config.modelName || 'qwen2.5:1.5b-instruct';
    this._baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    this._caps = {
      supportsToolCalling:  config.supportsToolCalling  ?? false,
      supportsJsonSchema:   config.supportsJsonSchema   ?? false,
      supportsStreaming:    true,
      supportsVision:       false,
      maxContextTokens:     config.maxContextTokens     || 32768,
      recommendedTemperature: config.temperature        ?? 0.1,
    };
  }

  get name()         { return this._name; }
  get family()       { return 'local'; }
  get capabilities() { return this._caps; }

  async generate(input) {
    const messages = this._buildMessages(input);

    let res;
    try {
      res = await fetch(`${this._baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:   this._name,
          messages,
          stream:  false,
          options: {
            temperature: input.temperature ?? this._caps.recommendedTemperature,
            num_predict: input.maxTokens   || 1024,
          },
          // Enable JSON mode only when the model declares schema support
          ...(this._caps.supportsJsonSchema ? { format: 'json' } : {}),
        }),
        // Use the orchestrator's AbortSignal if provided; fall back to 45s guard.
        signal: input.signal || AbortSignal.timeout(45000),
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.name === 'TimeoutError') {
        return { type: 'error', message: 'Local AI model unavailable. Ensure Ollama is running.' };
      }
      return { type: 'error', message: `Ollama request failed: ${err.message}` };
    }

    if (!res.ok) {
      return { type: 'error', message: `Ollama returned HTTP ${res.status}` };
    }

    const data  = await res.json();
    const text  = data.message?.content || '';
    return this._parseOutput(text);
  }

  async *stream(input) {
    const messages = this._buildMessages(input);
    const res = await fetch(`${this._baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this._name, messages, stream: true,
        options: { temperature: input.temperature ?? 0.1 } }),
    });
    if (!res.ok) throw new Error(`Ollama stream error: ${res.status}`);
    for await (const chunk of res.body) {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content) yield { delta: obj.message.content };
        } catch {}
      }
    }
  }

  async healthCheck() {
    try {
      const res  = await fetch(`${this._baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { healthy: false, error: `Ollama status ${res.status}` };
      const data = await res.json();
      const modelAvailable = Array.isArray(data.models) &&
        data.models.some(m => m.name?.startsWith(this._name.split(':')[0]));
      return { healthy: true, modelAvailable };
    } catch {
      return { healthy: false, error: 'Ollama not running or unreachable' };
    }
  }

  _buildMessages(input) {
    const out = [];
    if (input.systemPrompt) out.push({ role: 'system', content: input.systemPrompt });
    for (const m of (input.messages || [])) {
      out.push({ role: m.role, content: m.content || m.text || '' });
    }
    return out;
  }

  _parseOutput(content) {
    const text = content.trim();

    // 1. Try to extract a tool_call JSON block
    const toolCall = this._extractToolCall(text);
    if (toolCall) return toolCall;

    // 2. Looks like a clarification
    if (text.endsWith('?') && text.length < 400) {
      return { type: 'clarification', question: text };
    }

    return { type: 'assistant_message', content: text };
  }

  _extractToolCall(text) {
    // Try direct parse first (JSON-mode models)
    try {
      const obj = JSON.parse(text);
      if (obj.type === 'tool_call' && obj.toolName) {
        return { type: 'tool_call', toolName: obj.toolName, arguments: obj.arguments || {} };
      }
    } catch {}

    // Find first {...} block that looks like a tool call
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(start, i + 1));
            if (obj.type === 'tool_call' && obj.toolName) {
              return { type: 'tool_call', toolName: obj.toolName, arguments: obj.arguments || {} };
            }
          } catch {}
          break;
        }
      }
    }
    return null;
  }
}

module.exports = { OllamaProvider };
