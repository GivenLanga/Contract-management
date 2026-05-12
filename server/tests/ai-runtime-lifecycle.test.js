'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AiRuntimeManager, STATUS } = require('../src/ai/runtime/AiRuntimeManager');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeModel = {
  id: 'local-test-model',
  fileName: 'model.gguf',
  displayName: 'Local Test Model',
  runtime: 'llama_cpp',
  contextWindow: 2048,
};

function makeManager() {
  const manager = new AiRuntimeManager();
  manager._resolveModel = () => fakeModel;
  manager.getActiveModel = async () => fakeModel;
  manager._assertModelInstalledForStart = async () => {};
  manager._verifyLocalModel = async () => ({
    provider: 'local',
    modelSource: 'local_file',
    runtime: 'llama.cpp',
    cloudEnabled: false,
    usesCloudInference: false,
    modelPathConfigured: true,
    fileExists: true,
    fileReadable: true,
    format: 'gguf',
    formatValid: true,
    hashConfigured: false,
    runtimeStarted: true,
    basicPromptPassed: true,
    jsonPromptPassed: true,
    toolCallPromptPassed: true,
    ready: true,
    valid: true,
    errors: [],
  });
  manager._refreshMissingModel = () => {};
  manager._refreshCompletedDownload = () => {};
  return manager;
}

test('two concurrent runtime starts share one startup promise', async () => {
  const manager = makeManager();
  let starts = 0;
  manager._server = {
    isReadyFor: async () => false,
    start: async () => {
      starts += 1;
      await delay(50);
    },
    healthCheck: async () => true,
  };

  await Promise.all([
    manager.startRuntime(fakeModel.id),
    manager.startRuntime(fakeModel.id),
  ]);

  assert.equal(starts, 1);
  assert.equal(manager._status, STATUS.READY);
});

test('status polling does not start the local model process', async () => {
  const manager = makeManager();
  let starts = 0;
  manager._server = {
    isReadyFor: async () => false,
    start: async () => { starts += 1; },
    healthCheck: async () => true,
  };

  const first = await manager.getStatus();
  const second = await manager.getStatus();

  assert.equal(starts, 0);
  assert.equal(first.status, STATUS.IDLE);
  assert.equal(second.status, STATUS.IDLE);
});

test('ready model is reused by ensureReady without starting again', async () => {
  const manager = makeManager();
  let starts = 0;
  manager._status = STATUS.READY;
  manager._lastHealthCheckAt = Date.now();
  manager._server = {
    isReadyFor: async () => true,
    start: async () => { starts += 1; },
    healthCheck: async () => true,
  };

  await manager.ensureReady();
  assert.equal(starts, 0);
});

test('failed runtime does not loop-restart from chat readiness checks', async () => {
  const manager = makeManager();
  let starts = 0;
  manager._status = STATUS.FAILED;
  manager._error = 'model load failed';
  manager.startRuntime = async () => { starts += 1; };

  await assert.rejects(() => manager.ensureReady(), /model load failed/);
  assert.equal(starts, 0);
});

test('ensureReady awaits the existing startup promise while starting', async () => {
  const manager = makeManager();
  let resolved = false;
  manager._status = STATUS.STARTING;
  manager._startPromise = delay(25).then(() => { resolved = true; manager._status = STATUS.READY; });

  await manager.ensureReady();
  assert.equal(resolved, true);
  assert.equal(manager._status, STATUS.READY);
});
