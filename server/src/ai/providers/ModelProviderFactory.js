const { OllamaProvider }       = require('./OllamaProvider');
const { HuggingFaceProvider }  = require('./HuggingFaceProvider');
const { MockProvider }         = require('./MockProvider');
const { LocalProvider }        = require('./LocalProvider');

const PROVIDERS = {
  local:        LocalProvider,
  ollama:       OllamaProvider,
  huggingface:  HuggingFaceProvider,
  hf:           HuggingFaceProvider,
  mock:         MockProvider,
};

/**
 * Create a provider instance by name.
 * Add a new entry to PROVIDERS to register a new model runtime.
 */
const create = (providerName, config = {}) => {
  const normalized = String(providerName || 'local').toLowerCase();
  const Cls = PROVIDERS[normalized];
  if (!Cls) {
    throw new Error(`Unknown AI model provider "${providerName}".`);
  }

  if (normalized === 'mock') {
    const isProduction = process.env.NODE_ENV === 'production';
    const allowMock = !isProduction && process.env.ALLOW_MOCK_PROVIDER !== 'false';
    if (!allowMock) {
      throw new Error('Mock AI provider is disabled. Set ACTIVE_MODEL_PROVIDER=local.');
    }
  }

  return new Cls(config);
};

/**
 * Read provider and model config from environment variables.
 * Switching the active model requires only changing .env — no code changes.
 *
 * ACTIVE_MODEL_PROVIDER=ollama
 * ACTIVE_MODEL_NAME=qwen2.5:1.5b-instruct
 * ACTIVE_MODEL_BASE_URL=http://localhost:11434
 * ACTIVE_MODEL_SUPPORTS_TOOLS=false
 * ACTIVE_MODEL_SUPPORTS_JSON_SCHEMA=false
 * ACTIVE_MODEL_CONTEXT_WINDOW=32768
 * ACTIVE_MODEL_TEMPERATURE=0.1
 */
const createFromEnv = () => {
  const providerName = process.env.ACTIVE_MODEL_PROVIDER || 'local';
  const config = {
    modelId:             process.env.ACTIVE_MODEL_ID,
    modelName:           process.env.ACTIVE_MODEL_NAME,
    runtime:             process.env.LOCAL_MODEL_RUNTIME,
    autoDownload:        process.env.ACTIVE_MODEL_AUTO_DOWNLOAD === 'true',
    baseUrl:             process.env.ACTIVE_MODEL_BASE_URL,
    apiKey:              process.env.HF_API_KEY,
    supportsToolCalling: process.env.ACTIVE_MODEL_SUPPORTS_TOOLS === 'true',
    supportsJsonSchema:  process.env.ACTIVE_MODEL_SUPPORTS_JSON_SCHEMA === 'true',
    maxContextTokens:    parseInt(process.env.ACTIVE_MODEL_CONTEXT_WINDOW) || 32768,
    temperature:         parseFloat(process.env.ACTIVE_MODEL_TEMPERATURE) || 0.1,
  };
  const provider = create(providerName, config);
  if (provider.family === 'cloud' && process.env.ALLOW_CLOUD_AI !== 'true') {
    throw new Error('Cloud AI providers are disabled by default. Set ALLOW_CLOUD_AI=true only after confirming legal data may leave this environment.');
  }
  console.log(`[AI] Active model provider=${provider.family}/${provider.name}`);
  return provider;
};

module.exports = { create, createFromEnv, PROVIDERS };
