'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AiRuntimeManager } = require('../src/ai/runtime/AiRuntimeManager');

const ENV_KEYS = [
  'ACTIVE_MODEL_PROVIDER',
  'ALLOW_CLOUD_AI',
  'LOCAL_MODEL_SOURCE',
  'LOCAL_MODEL_RUNTIME',
  'LOCAL_MODEL_PATH',
  'LOCAL_MODEL_SHA256',
];

async function withEnv(values, fn) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('AI status reports local provider, Hugging Face download source, and cloud disabled', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modelPath = path.join(dir, 'model.gguf');
  fs.writeFileSync(modelPath, Buffer.alloc(2048 * 1024, 1));

  await withEnv({
    ACTIVE_MODEL_PROVIDER: 'local',
    ALLOW_CLOUD_AI: 'false',
    LOCAL_MODEL_SOURCE: 'huggingface_download',
    LOCAL_MODEL_RUNTIME: 'llama.cpp',
    LOCAL_MODEL_PATH: modelPath,
    LOCAL_MODEL_SHA256: undefined,
  }, async () => {
    const status = await new AiRuntimeManager().getStatus();
    assert.equal(status.provider, 'local');
    assert.equal(status.modelSource, 'huggingface_download');
    assert.equal(status.runtime, 'llama.cpp');
    assert.equal(status.cloudEnabled, false);
    assert.equal(status.usesCloudInference, false);
    assert.notEqual(status.provider, 'huggingface');
  });
});

test('AI status reports clear failure for wrong local model format', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modelPath = path.join(dir, 'model.safetensors');
  fs.writeFileSync(modelPath, Buffer.alloc(2048 * 1024, 1));

  await withEnv({
    ACTIVE_MODEL_PROVIDER: 'local',
    ALLOW_CLOUD_AI: 'false',
    LOCAL_MODEL_SOURCE: 'huggingface_download',
    LOCAL_MODEL_RUNTIME: 'llama.cpp',
    LOCAL_MODEL_PATH: modelPath,
    LOCAL_MODEL_SHA256: undefined,
  }, async () => {
    const status = await new AiRuntimeManager().getStatus();
    assert.equal(status.status, 'failed');
    assert.equal(status.provider, 'local');
    assert.equal(status.cloudEnabled, false);
    assert.equal(status.usesCloudInference, false);
    assert.equal(status.model.format, 'safetensors');
    assert.equal(status.model.formatValid, false);
    assert.match(status.model.errors.join(' '), /expects a GGUF model file/);
  });
});
