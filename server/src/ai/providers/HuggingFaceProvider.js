const fetch = require('node-fetch');
const { AIModelProvider } = require('./AIModelProvider');

class HuggingFaceProvider extends AIModelProvider {
  constructor(config = {}) {
    super();
    this._name   = config.modelName || process.env.HF_MODEL || 'Qwen/Qwen2.5-7B-Instruct';
    this._apiKey = config.apiKey    || process.env.HF_API_KEY || '';
    this._caps = {
      supportsToolCalling:    false,
      supportsJsonSchema:     false,
      supportsStreaming:      false,
      supportsVision:         false,
      maxContextTokens:       32768,
      recommendedTemperature: 0.2,
    };
  }

  get name()         { return this._name; }
  get family()       { return 'cloud'; }
  get capabilities() { return this._caps; }

  async generate(input) {
    if (!this._apiKey || this._apiKey.startsWith('hf_your')) {
      return { type: 'error', message: 'HuggingFace API key not configured. Add HF_API_KEY to your .env.' };
    }

    const prompt = this._buildPrompt(input);

    let res;
    try {
      res = await fetch(`https://api-inference.huggingface.co/models/${this._name}`, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs:     prompt,
          parameters: {
            max_new_tokens:  input.maxTokens || 512,
            temperature:     input.temperature ?? 0.2,
            return_full_text: false,
          },
        }),
        signal: AbortSignal.timeout(45000),
      });
    } catch (err) {
      return { type: 'error', message: `HuggingFace request failed: ${err.message}` };
    }

    if (!res.ok) {
      return { type: 'error', message: `HuggingFace API error: ${res.status}` };
    }

    const data    = await res.json();
    const content = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;

    if (!content) return { type: 'error', message: 'No response from HuggingFace model.' };
    return this._parseOutput(content.trim());
  }

  async healthCheck() {
    if (!this._apiKey || this._apiKey.startsWith('hf_your')) {
      return { healthy: false, error: 'API key not configured' };
    }
    return { healthy: true };
  }

  _buildPrompt(input) {
    let prompt = '';
    if (input.systemPrompt) prompt += `System: ${input.systemPrompt}\n\n`;
    for (const m of (input.messages || [])) {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      prompt += `${role}: ${m.content || m.text || ''}\n`;
    }
    prompt += 'Assistant: ';
    return prompt;
  }

  _parseOutput(content) {
    // Try to find an embedded tool_call JSON
    const start = content.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') {
          depth--;
          if (depth === 0) {
            try {
              const obj = JSON.parse(content.slice(start, i + 1));
              if (obj.type === 'tool_call' && obj.toolName) {
                return { type: 'tool_call', toolName: obj.toolName, arguments: obj.arguments || {} };
              }
            } catch {}
            break;
          }
        }
      }
    }
    return { type: 'assistant_message', content };
  }
}

module.exports = { HuggingFaceProvider };
