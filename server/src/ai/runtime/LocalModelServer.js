const { LlamaCppRuntimeClient } = require('./LlamaCppRuntimeClient');

class LocalModelServer {
  constructor() {
    this._client = null;
    this._runtime = null;
  }

  getClient() {
    if (!this._client) {
      throw new Error('Local runtime client has not been created.');
    }
    return this._client;
  }

  async start(modelDef, modelPath) {
    const client = this._getClientForRuntime(modelDef.runtime);
    await client.start(modelDef, modelPath);
  }

  async stop() {
    if (this._client) await this._client.stop();
  }

  async healthCheck() {
    if (!this._client) return false;
    return this._client.healthCheck();
  }

  async generate(input) {
    return this.getClient().generate(input);
  }

  _getClientForRuntime(runtime) {
    if (this._client && this._runtime === runtime) return this._client;

    if (this._client) {
      this._client.stop().catch(() => {});
    }

    switch (runtime) {
      case 'llama_cpp':
        this._client = new LlamaCppRuntimeClient();
        break;
      default:
        throw new Error(`Unsupported local AI runtime: ${runtime}`);
    }

    this._runtime = runtime;
    return this._client;
  }
}

module.exports = { LocalModelServer };
