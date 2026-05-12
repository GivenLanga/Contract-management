const clampInt = (value, fallback, min, max) => {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const LOCAL_CONTEXT_TOKENS = clampInt(process.env.LOCAL_AI_CONTEXT_TOKENS, 3072, 1024, 8192);
const LOCAL_BATCH_SIZE = clampInt(process.env.LOCAL_AI_BATCH_SIZE, 512, 128, 2048);
const LOCAL_THREADS = process.env.LOCAL_AI_THREADS === undefined
  ? 0
  : clampInt(process.env.LOCAL_AI_THREADS, 0, 0, 256);
const LOCAL_MAX_OUTPUT_TOKENS = clampInt(process.env.LOCAL_AI_MAX_OUTPUT_TOKENS, 192, 32, 2048);
const LOCAL_TEMPERATURE = Number.isFinite(Number(process.env.LOCAL_AI_TEMPERATURE))
  ? Number(process.env.LOCAL_AI_TEMPERATURE)
  : 0;

/**
 * LocalRuntimeClient implementation using node-llama-cpp.
 *
 * Runtime dependency: node-llama-cpp is declared in server/package.json.
 *
 * The rest of the app calls only generate(input) — it never imports
 * node-llama-cpp directly, so swapping this class is all it takes
 * to change the inference engine.
 */
class LlamaCppRuntimeClient {
  constructor() {
    this._llama   = null;
    this._model   = null;
    this._ctx     = null;
    this._Session = null;
    this._ready   = false;
    this._modelPath = null;
    this._generationQueue = Promise.resolve();
  }

  async start(modelDef, modelPath) {
    if (this._ready && this._modelPath === modelPath) {
      console.log('[AI Runtime] Model already loaded in llama.cpp client; reusing warm context.');
      return;
    }

    let mod;
    try {
      // node-llama-cpp v3 may ship as ESM; dynamic import() handles both.
      mod = await import('node-llama-cpp').catch(() => require('node-llama-cpp'));
    } catch {
      throw new Error(
        'The local AI runtime package is missing from this build. Reinstall the app or contact support.'
      );
    }

    const { getLlama, LlamaChatSession } = mod;
    this._Session = LlamaChatSession;

    console.log(`[AI Runtime] Loading model: ${modelPath}`);
    this._llama = await getLlama();
    this._model = await this._llama.loadModel({ modelPath });
    this._ctx   = await this._model.createContext({
      contextSize: Math.min(modelDef.contextWindow || LOCAL_CONTEXT_TOKENS, LOCAL_CONTEXT_TOKENS),
      batchSize: LOCAL_BATCH_SIZE,
      threads: LOCAL_THREADS,
      flashAttention: true,
    });
    this._ready = true;
    this._modelPath = modelPath;
    console.log('[AI Runtime] Model ready.');
  }

  async stop() {
    this._ready = false;
    try { await this._ctx?.dispose?.(); }   catch {}
    try { await this._model?.dispose?.(); } catch {}
    try { await this._llama?.dispose?.(); } catch {}
    this._ctx = this._model = this._llama = null;
    this._modelPath = null;
    this._generationQueue = Promise.resolve();
  }

  async healthCheck() { return this._ready; }

  async generate(input) {
    const next = this._generationQueue.then(
      () => this._generate(input),
      () => this._generate(input)
    );
    this._generationQueue = next.catch(() => {});
    return next;
  }

  async _generate(input) {
    if (!this._ready) throw new Error('Local AI runtime is not ready.');
    const startedAt = Date.now();

    const sequence = this._ctx.getSequence();
    const session = new this._Session({
      contextSequence: sequence,
      autoDisposeSequence: true,
    });

    try {
      // Pre-load conversation history without generating.
      const messages = input.messages || [];
      const history  = [];
      if (input.systemPrompt) history.push({ type: 'system', text: input.systemPrompt });

      for (let i = 0; i < messages.length - 1; i++) {
        const m = messages[i];
        const text = m.content || m.text || '';
        if (!text) continue;

        if (m.role === 'assistant') history.push({ type: 'model', response: [text] });
        else if (m.role === 'system') history.push({ type: 'system', text });
        else history.push({ type: 'user', text });
      }
      if (history.length > 0) {
        try {
          if (typeof session.setChatHistory === 'function') session.setChatHistory(history);
          else if (session.chatHistory !== undefined)        session.chatHistory = history;
        } catch {}
      }

      const last   = messages[messages.length - 1];
      const prompt = last?.content || last?.text || '';

      const response = await session.prompt(prompt, {
        maxTokens:   input.maxTokens  || LOCAL_MAX_OUTPUT_TOKENS,
        temperature: input.temperature ?? LOCAL_TEMPERATURE,
        signal:      input.signal,   // node-llama-cpp v3 aborts on AbortSignal
      });

      const parsed = this._parse(response.trim());
      console.log(`[AI Runtime] Generated ${response.length} chars in ${Date.now() - startedAt}ms (${parsed.type}).`);
      return parsed;
    } finally {
      try { session.dispose({ disposeSequence: true }); } catch {
        try { sequence.dispose?.(); } catch {}
      }
    }
  }

  _parse(text) {
    // Try to extract a tool_call JSON block
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            try {
              const obj = JSON.parse(text.slice(start, i + 1));
              if (obj.type === 'tool_call' && obj.toolName)
                return { type: 'tool_call', toolName: obj.toolName, arguments: obj.arguments || {} };
            } catch {}
            break;
          }
        }
      }
    }
    if (text.endsWith('?') && text.length < 400)
      return { type: 'clarification', question: text };
    return { type: 'assistant_message', content: text };
  }
}

module.exports = { LlamaCppRuntimeClient };
