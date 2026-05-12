const { AIModelProvider }  = require('./AIModelProvider');
const { getInstance }      = require('../runtime/AiRuntimeManager');
const { ModelRegistry }    = require('../runtime/ModelRegistry');

class LocalProvider extends AIModelProvider {
  constructor() {
    super();
    this._manager = getInstance();
  }

  get name() {
    return ModelRegistry.getActiveModel()?.displayName || 'local';
  }
  get family() { return 'local'; }
  get capabilities() {
    const model = ModelRegistry.getActiveModel();
    return {
      supportsToolCalling:    false,
      supportsJsonSchema:     false,
      supportsStreaming:      false,
      supportsVision:         false,
      maxContextTokens:       model?.contextWindow || 4096,
      recommendedTemperature: 0.1,
    };
  }

  async generate(input) {
    try {
      await this._manager.ensureReady();
      return this._manager.getRuntimeClient().generate(input);
    } catch (err) {
      if (process.env.ALLOW_CLOUD_AI !== 'true') {
        throw new Error(`Local model is not ready. Cloud AI is disabled, so no remote provider was used. ${err.message}`);
      }
      throw err;
    }
  }

  async healthCheck() {
    return this._manager.healthCheck();
  }
}

module.exports = { LocalProvider };
