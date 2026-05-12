const PROVIDERS = {
  local:        () => require('./LocalProvider').LocalProvider,
  ollama:       () => require('./OllamaProvider').OllamaProvider,
  huggingface:  () => require('./HuggingFaceProvider').HuggingFaceProvider,
  hf:           () => require('./HuggingFaceProvider').HuggingFaceProvider,
  mock:         () => require('./MockProvider').MockProvider,
};

const CLOUD_PROVIDER_NAMES = new Set(['huggingface', 'hf']);

const cloudEnabled = (config = {}) =>
  config.allowCloudAi === true || process.env.ALLOW_CLOUD_AI === 'true';

const hasLocalModelPath = (config = {}) =>
  Boolean(config.localModelPath || process.env.LOCAL_MODEL_PATH);

const assertLocalCompletionEndpoint = (providerName, baseUrl, allowCloud) => {
  if (allowCloud || !baseUrl) return;

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid ${providerName} model endpoint: ${baseUrl}`);
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal) {
    throw new Error('Remote AI endpoints are disabled because ALLOW_CLOUD_AI=false. Configure a localhost runtime or explicitly enable cloud AI.');
  }
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

  const allowCloud = cloudEnabled(config);

  if (CLOUD_PROVIDER_NAMES.has(normalized)) {
    if (hasLocalModelPath(config)) {
      throw new Error('A LOCAL_MODEL_PATH was provided, but ACTIVE_MODEL_PROVIDER=huggingface uses cloud inference. Use ACTIVE_MODEL_PROVIDER=local to run a downloaded model locally.');
    }
    if (!allowCloud) {
      throw new Error('Hugging Face cloud provider is disabled because ALLOW_CLOUD_AI=false. Use ACTIVE_MODEL_PROVIDER=local for downloaded models.');
    }
  }

  if (normalized === 'ollama') {
    assertLocalCompletionEndpoint('Ollama', config.baseUrl || 'http://localhost:11434', allowCloud);
  }

  if (normalized === 'mock') {
    const isProduction = process.env.NODE_ENV === 'production';
    const allowMock = !isProduction && process.env.ALLOW_MOCK_PROVIDER !== 'false';
    if (!allowMock) {
      throw new Error('Mock AI provider is disabled. Set ACTIVE_MODEL_PROVIDER=local.');
    }
  }

  return new (Cls())(config);
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
 * LOCAL_MODEL_SOURCE=huggingface_download
 * LOCAL_MODEL_RUNTIME=llama.cpp
 * LOCAL_MODEL_PATH=./models/qwen2.5-1.5b-instruct/model.gguf
 * ALLOW_CLOUD_AI=false
 */
const createFromEnv = () => {
  const providerName = process.env.ACTIVE_MODEL_PROVIDER || 'local';
  const config = {
    modelId:             process.env.ACTIVE_MODEL_ID,
    modelName:           process.env.ACTIVE_MODEL_NAME,
    modelSource:         process.env.LOCAL_MODEL_SOURCE,
    runtime:             process.env.LOCAL_MODEL_RUNTIME,
    localModelPath:      process.env.LOCAL_MODEL_PATH,
    autoDownload:        process.env.ACTIVE_MODEL_AUTO_DOWNLOAD === 'true',
    baseUrl:             process.env.ACTIVE_MODEL_BASE_URL,
    apiKey:              process.env.HF_API_KEY,
    allowCloudAi:        process.env.ALLOW_CLOUD_AI === 'true',
    supportsToolCalling: process.env.ACTIVE_MODEL_SUPPORTS_TOOLS === 'true',
    supportsJsonSchema:  process.env.ACTIVE_MODEL_SUPPORTS_JSON_SCHEMA === 'true',
    maxContextTokens:    parseInt(process.env.ACTIVE_MODEL_CONTEXT_WINDOW) || 32768,
    temperature:         parseFloat(process.env.ACTIVE_MODEL_TEMPERATURE) || 0.1,
  };
  const provider = create(providerName, config);
  if (provider.family === 'cloud' && process.env.ALLOW_CLOUD_AI !== 'true') {
    throw new Error('Cloud AI providers are disabled by default. Set ALLOW_CLOUD_AI=true only after confirming legal data may leave this environment.');
  }
  if (provider.family === 'local') {
    console.log(`[AI] Provider: ${String(providerName).toLowerCase()}`);
    console.log(`[AI] Model source: ${config.modelSource || 'configured_local_model'}`);
    console.log(`[AI] Runtime: ${config.runtime || 'configured local runtime'}`);
    console.log(`[AI] Cloud inference: ${config.allowCloudAi ? 'enabled' : 'disabled'}`);
  } else {
    console.log(`[AI] Active model provider=${provider.family}/${provider.name}`);
  }
  return provider;
};

module.exports = { create, createFromEnv, PROVIDERS };
