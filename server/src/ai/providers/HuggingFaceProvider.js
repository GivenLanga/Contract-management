const fetch = require('node-fetch');
const { AIModelProvider } = require('./AIModelProvider');

/**
 * Hugging Face cloud inference provider only.
 *
 * Do not use this provider for local models downloaded from Hugging Face.
 * Downloaded models must run through LocalProvider or OllamaProvider.
 */
class HuggingFaceProvider extends AIModelProvider {
  constructor(config = {}) {
    super();
    if (config.localModelPath || process.env.LOCAL_MODEL_PATH) {
      throw new Error('A LOCAL_MODEL_PATH was provided, but ACTIVE_MODEL_PROVIDER=huggingface uses cloud inference. Use ACTIVE_MODEL_PROVIDER=local to run a downloaded model locally.');
    }
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
  get usesCloudInference() { return true; }
  get capabilities() { return this._caps; }

  async generate(input) {
    if (process.env.ALLOW_CLOUD_AI !== 'true') {
      return {
        type: 'error',
        message: 'Hugging Face cloud provider is disabled because ALLOW_CLOUD_AI=false. Use ACTIVE_MODEL_PROVIDER=local for downloaded models.',
      };
    }

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
    if (process.env.ALLOW_CLOUD_AI !== 'true') {
      return {
        healthy: false,
        error: 'Hugging Face cloud provider is disabled because ALLOW_CLOUD_AI=false. Use ACTIVE_MODEL_PROVIDER=local for downloaded models.',
      };
    }
    if (!this._apiKey || this._apiKey.startsWith('hf_your')) {
      return { healthy: false, error: 'API key not configured' };
    }
    return { healthy: true };
  }

  _buildPrompt(input) {
    // Use the ChatML format expected by Qwen2.5-Instruct and most modern instruction models.
    // The generic "System: / User: / Assistant:" format does not match the model's training
    // format and causes unreliable instruction-following.
    let prompt = '';
    if (input.systemPrompt) {
      prompt += `<|im_start|>system\n${input.systemPrompt}<|im_end|>\n`;
    }
    for (const m of (input.messages || [])) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      prompt += `<|im_start|>${role}\n${m.content || m.text || ''}<|im_end|>\n`;
    }
    prompt += '<|im_start|>assistant\n';
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
