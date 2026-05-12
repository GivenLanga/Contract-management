'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const FACTORY_PATH = require.resolve('../src/ai/providers/ModelProviderFactory');
const HF_PATH = require.resolve('../src/ai/providers/HuggingFaceProvider');

const ENV_KEYS = [
  'ACTIVE_MODEL_PROVIDER',
  'ALLOW_CLOUD_AI',
  'LOCAL_MODEL_PATH',
  'ACTIVE_MODEL_BASE_URL',
  'HF_API_KEY',
];

function withEnv(values, fn) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

function freshFactory() {
  delete require.cache[FACTORY_PATH];
  return require(FACTORY_PATH);
}

test('ACTIVE_MODEL_PROVIDER=local uses LocalProvider', () => withEnv({
  ALLOW_CLOUD_AI: 'false',
  LOCAL_MODEL_PATH: undefined,
}, () => {
  const { create } = freshFactory();
  const provider = create('local');
  assert.equal(provider.family, 'local');
}));

test('ACTIVE_MODEL_PROVIDER=huggingface with ALLOW_CLOUD_AI=false throws', () => withEnv({
  ALLOW_CLOUD_AI: 'false',
  LOCAL_MODEL_PATH: undefined,
}, () => {
  const { create } = freshFactory();
  assert.throws(
    () => create('huggingface'),
    /Hugging Face cloud provider is disabled because ALLOW_CLOUD_AI=false/
  );
}));

test('ACTIVE_MODEL_PROVIDER=huggingface with ALLOW_CLOUD_AI=true allows HuggingFaceProvider', () => withEnv({
  ALLOW_CLOUD_AI: 'true',
  LOCAL_MODEL_PATH: undefined,
}, () => {
  const { create } = freshFactory();
  const provider = create('huggingface', { allowCloudAi: true, apiKey: 'hf_test' });
  assert.equal(provider.family, 'cloud');
  assert.equal(provider.usesCloudInference, true);
}));

test('ACTIVE_MODEL_PROVIDER=local does not instantiate HuggingFaceProvider', () => withEnv({
  ALLOW_CLOUD_AI: 'false',
  LOCAL_MODEL_PATH: undefined,
}, () => {
  delete require.cache[FACTORY_PATH];
  delete require.cache[HF_PATH];
  const { create } = require(FACTORY_PATH);
  create('local');
  assert.equal(require.cache[HF_PATH], undefined);
}));

test('LOCAL_MODEL_PATH with HuggingFaceProvider errors as a local/cloud mismatch', () => withEnv({
  ALLOW_CLOUD_AI: 'true',
  LOCAL_MODEL_PATH: './models/model.gguf',
}, () => {
  const { create } = freshFactory();
  assert.throws(
    () => create('huggingface', { allowCloudAi: true }),
    /LOCAL_MODEL_PATH was provided/
  );
}));

test('remote Ollama endpoint is blocked when cloud AI is disabled', () => withEnv({
  ALLOW_CLOUD_AI: 'false',
  LOCAL_MODEL_PATH: undefined,
}, () => {
  const { create } = freshFactory();
  assert.throws(
    () => create('ollama', { baseUrl: 'https://ai.example.com' }),
    /Remote AI endpoints are disabled/
  );
}));
