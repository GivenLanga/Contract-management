'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LocalModelVerifier } = require('../src/ai/providers/LocalModelVerifier');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-verifier-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(t, name, content = 'model-bytes') {
  const file = path.join(tempDir(t), name);
  fs.writeFileSync(file, content);
  return file;
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function verifier(options = {}) {
  return new LocalModelVerifier({
    minModelBytes: 1,
    resolveRuntimePackage: () => '/local/node-llama-cpp',
    ...options,
  });
}

function runtime(responses, healthy = true) {
  const queue = [...responses];
  return {
    healthCheck: async () => healthy,
    generate: async () => queue.shift() || { type: 'assistant_message', content: '' },
  };
}

const baseModel = {
  runtime: 'llama.cpp',
  downloadUrl: 'https://huggingface.co/example/model/resolve/main/model.gguf',
};

test('LocalModelVerifier reports missing model path', async () => {
  const result = await verifier().verify({ modelDef: baseModel, runtime: 'llama.cpp' });
  assert.equal(result.provider, 'local');
  assert.equal(result.usesCloudInference, false);
  assert.equal(result.modelPathConfigured, false);
  assert.equal(result.ready, false);
  assert.match(result.errors[0], /path is not configured/);
});

test('LocalModelVerifier reports file does not exist', async () => {
  const result = await verifier().verify({
    modelDef: baseModel,
    modelPath: path.join(os.tmpdir(), 'missing-model.gguf'),
    runtime: 'llama.cpp',
  });
  assert.equal(result.fileExists, false);
  assert.equal(result.ready, false);
  assert.match(result.errors[0], /does not exist/);
});

test('LocalModelVerifier rejects non-GGUF files for llama.cpp', async (t) => {
  const file = writeFile(t, 'model.safetensors');
  const result = await verifier().verify({ modelDef: baseModel, modelPath: file, runtime: 'llama.cpp' });
  assert.equal(result.format, 'safetensors');
  assert.equal(result.formatValid, false);
  assert.match(result.errors.join(' '), /expects a GGUF model file/);
});

test('LocalModelVerifier reports hash mismatch', async (t) => {
  const content = 'model-bytes';
  const file = writeFile(t, 'model.gguf', content);
  const result = await verifier().verify({
    modelDef: baseModel,
    modelPath: file,
    runtime: 'llama.cpp',
    expectedSha256: '0'.repeat(64),
  });
  assert.equal(result.hashConfigured, true);
  assert.equal(result.hashValid, false);
  assert.match(result.errors.join(' '), /SHA-256/);
});

test('LocalModelVerifier reports runtime package missing', async (t) => {
  const file = writeFile(t, 'model.gguf');
  const result = await verifier({
    resolveRuntimePackage: () => { throw new Error('missing'); },
  }).verify({ modelDef: baseModel, modelPath: file, runtime: 'llama.cpp' });
  assert.equal(result.runtimeConfigured, true);
  assert.equal(result.runtimeBinaryExists, false);
  assert.match(result.errors.join(' '), /runtime package is not installed/);
});

test('LocalModelVerifier reports basic prompt failure', async (t) => {
  const file = writeFile(t, 'model.gguf');
  const result = await verifier().verify({
    modelDef: baseModel,
    modelPath: file,
    runtime: 'llama.cpp',
    runtimeClient: runtime([
      { type: 'assistant_message', content: 'NOT READY' },
      { type: 'assistant_message', content: '{"status":"ready"}' },
      { type: 'assistant_message', content: '{"type":"tool_call","toolName":"get_due_today","args":{}}' },
    ]),
    runRuntimeChecks: true,
  });
  assert.equal(result.basicPromptPassed, false);
  assert.match(result.errors.join(' '), /READY prompt/);
});

test('LocalModelVerifier reports JSON prompt failure', async (t) => {
  const file = writeFile(t, 'model.gguf');
  const result = await verifier().verify({
    modelDef: baseModel,
    modelPath: file,
    runtime: 'llama.cpp',
    runtimeClient: runtime([
      { type: 'assistant_message', content: 'READY' },
      { type: 'assistant_message', content: 'status ready' },
      { type: 'assistant_message', content: '{"type":"tool_call","toolName":"get_due_today","args":{}}' },
    ]),
    runRuntimeChecks: true,
  });
  assert.equal(result.jsonPromptPassed, false);
  assert.match(result.errors.join(' '), /JSON format test/);
});

test('LocalModelVerifier reports tool-call prompt failure', async (t) => {
  const file = writeFile(t, 'model.gguf');
  const result = await verifier().verify({
    modelDef: baseModel,
    modelPath: file,
    runtime: 'llama.cpp',
    runtimeClient: runtime([
      { type: 'assistant_message', content: 'READY' },
      { type: 'assistant_message', content: '{"status":"ready"}' },
      { type: 'assistant_message', content: '{"type":"tool_call","toolName":"unknown_tool","args":{}}' },
    ]),
    runRuntimeChecks: true,
  });
  assert.equal(result.toolCallPromptPassed, false);
  assert.match(result.errors.join(' '), /tool-call format test/);
});

test('LocalModelVerifier passes all local checks', async (t) => {
  const content = 'model-bytes';
  const file = writeFile(t, 'model.gguf', content);
  const result = await verifier().verify({
    modelDef: baseModel,
    modelPath: file,
    runtime: 'llama.cpp',
    expectedSha256: hash(content),
    runtimeClient: runtime([
      { type: 'assistant_message', content: 'READY' },
      { type: 'assistant_message', content: '{"status":"ready"}' },
      { type: 'assistant_message', content: '{"type":"tool_call","toolName":"get_due_today","args":{}}' },
    ]),
    runRuntimeChecks: true,
  });
  assert.equal(result.modelSource, 'huggingface_download');
  assert.equal(result.cloudEnabled, false);
  assert.equal(result.usesCloudInference, false);
  assert.equal(result.hashValid, true);
  assert.equal(result.runtimeStarted, true);
  assert.equal(result.basicPromptPassed, true);
  assert.equal(result.jsonPromptPassed, true);
  assert.equal(result.toolCallPromptPassed, true);
  assert.equal(result.ready, true);
  assert.deepEqual(result.errors, []);
});
