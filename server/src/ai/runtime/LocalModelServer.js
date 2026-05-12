const { LlamaCppRuntimeClient } = require('./LlamaCppRuntimeClient');

function normalizeRuntime(runtime) {
  const text = String(runtime || '').trim().toLowerCase();
  if (['llama.cpp', 'llama-cpp', 'llamacpp', 'llama_cpp'].includes(text)) return 'llama_cpp';
  return text;
}

function runtimeDisplayName(runtime) {
  return normalizeRuntime(runtime) === 'llama_cpp' ? 'llama.cpp' : String(runtime || 'unknown');
}

class LocalModelServer {
  constructor() {
    this._client = null;
    this._runtime = null;
    this._modelPath = null;
    this._startPromise = null;
  }

  getClient() {
    if (!this._client) {
      throw new Error('Local runtime client has not been created.');
    }
    return this._client;
  }

  async start(modelDef, modelPath) {
    if (await this.isReadyFor(modelDef.runtime, modelPath)) {
      console.log('[AI Runtime] Model already running; reusing local runtime client.');
      return;
    }

    if (this._startPromise) {
      console.log('[AI Runtime] Startup reused; duplicate LocalModelServer start prevented.');
      return this._startPromise;
    }

    this._startPromise = (async () => {
      const client = this._getClientForRuntime(modelDef.runtime, modelPath);
      await client.start(modelDef, modelPath);
      this._modelPath = modelPath;
    })().finally(() => {
      this._startPromise = null;
    });

    return this._startPromise;
  }

  async stop() {
    if (this._client) await this._client.stop();
    this._modelPath = null;
  }

  async healthCheck() {
    if (!this._client) return false;
    return this._client.healthCheck();
  }

  async generate(input) {
    return this.getClient().generate(input);
  }

  async isReadyFor(runtime, modelPath) {
    const normalizedRuntime = normalizeRuntime(runtime);
    return Boolean(
      this._client &&
      this._runtime === normalizedRuntime &&
      this._modelPath === modelPath &&
      await this.healthCheck()
    );
  }

  _getClientForRuntime(runtime, modelPath) {
    const normalizedRuntime = normalizeRuntime(runtime);
    if (this._client && this._runtime === normalizedRuntime && this._modelPath === modelPath) return this._client;

    if (this._client) {
      this._client.stop().catch(() => {});
      this._modelPath = null;
    }

    switch (normalizedRuntime) {
      case 'llama_cpp':
        this._client = new LlamaCppRuntimeClient();
        break;
      default:
        throw new Error(`Unsupported local AI runtime: ${runtime}`);
    }

    this._runtime = normalizedRuntime;
    return this._client;
  }
}

module.exports = { LocalModelServer, normalizeRuntime, runtimeDisplayName };
