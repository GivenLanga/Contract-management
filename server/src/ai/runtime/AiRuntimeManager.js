const fs = require('fs');
const { ModelRegistry } = require('./ModelRegistry');
const {
  ensureModelsDir,
  modelExists,
  getModelPath,
  getModelPartPath,
  getModelsDir,
} = require('./ModelStorage');
const { ModelDownloader } = require('./ModelDownloader');
const { ModelVerifier } = require('./ModelVerifier');
const { LocalModelServer } = require('./LocalModelServer');
const { LocalModelVerifier } = require('../providers/LocalModelVerifier');

const STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  NOT_INSTALLED: 'not_installed',
  DOWNLOADING: 'downloading',
  DOWNLOAD_PAUSED: 'download_paused',
  VERIFYING: 'verifying',
  INSTALLED: 'installed',
  STARTING: 'starting',
  READY: 'ready',
  FAILED: 'failed',
  ERROR: 'error',
  DISABLED: 'disabled',
};

const HEALTH_CACHE_MS = 60_000; // only hit the runtime health check once per minute

class AiRuntimeManager {
  constructor() {
    this._status = STATUS.IDLE;
    this._message = 'Local AI has not been checked yet.';
    this._error = null;
    this._progress = null;
    this._server = new LocalModelServer();
    this._downloader = new ModelDownloader();
    this._verifier = new ModelVerifier();
    this._localModelVerifier = new LocalModelVerifier();
    this._verificationCache = null;
    this._lastHealthCheckAt = 0;
    this._lastHealthResult = false;
    this._startPromise = null;
    this._startModelId = null;
  }

  async initialize() {
    this._set(STATUS.CHECKING, 'Checking local AI model...');

    let model;
    try {
      model = await this.getActiveModel();
    } catch (err) {
      this._set(STATUS.FAILED, err.message, err.message);
      return;
    }

    console.log(`[AI Runtime] Active model=${model.id} runtime=${model.runtime} storage=${getModelsDir()}`);

    if (!modelExists(model.fileName)) {
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
      return;
    }

    try {
      await this.startRuntime(model.id);
    } catch {
      // startRuntime records the user-facing error state.
    }
  }

  async getStatus() {
    const model = await this.getActiveModel();
    this._refreshMissingModel(model);
    this._refreshCompletedDownload(model);
    const verification = await this._verifyLocalModel(model, {
      runRuntimeChecks: this._status === STATUS.READY,
      useCache: true,
    });
    const provider = String(process.env.ACTIVE_MODEL_PROVIDER || 'local').toLowerCase();
    const cloudEnabled = process.env.ALLOW_CLOUD_AI === 'true';
    const usesCloudInference = ['huggingface', 'hf'].includes(provider);
    const modelReady = this._status === STATUS.READY && verification.ready;
    const responseStatus = this._responseStatus(verification);

    return {
      provider,
      modelSource: verification.modelSource,
      runtime: verification.runtime,
      cloudEnabled,
      usesCloudInference,
      status: responseStatus,
      activeModelId: model.id,
      activeModelDisplayName: model.displayName,
      parameterSize: model.parameterSize,
      quantization: model.quantization,
      runtimeKey: model.runtime,
      format: verification.format,
      mode: 'local',
      downloadSizeBytes: model.downloadSizeBytes,
      requiredDiskBytes: model.requiredDiskBytes,
      contextWindow: model.contextWindow,
      recommendedHardware: model.recommendedHardware,
      message: this._message,
      progress: this._progress,
      error: this._error,
      model: {
        name: model.displayName,
        path: getModelPath(model.fileName),
        format: verification.format,
        fileExists: verification.fileExists,
        fileReadable: verification.fileReadable,
        formatValid: verification.formatValid,
        fileSizeBytes: verification.fileSizeBytes,
        hashConfigured: verification.hashConfigured,
        hashValid: verification.hashValid,
        runtime: verification.runtime,
        runtimeRunning: verification.runtimeStarted,
        basicPromptPassed: verification.basicPromptPassed,
        jsonPromptPassed: verification.jsonPromptPassed,
        toolCallPromptPassed: verification.toolCallPromptPassed,
        ready: modelReady,
        errors: verification.errors,
      },
      localVerification: verification,
      storageDir: getModelsDir(),
      modelsDir: getModelsDir(),
    };
  }

  get isDownloading() { return this._downloader.isDownloading; }

  async getActiveModel() {
    const model = ModelRegistry.getActiveModel();
    if (!model) {
      throw new Error(`No active model configured for id "${ModelRegistry.getActiveModelId()}".`);
    }
    return model;
  }

  async isModelInstalled(modelId) {
    const model = this._resolveModel(modelId);
    return modelExists(model.fileName);
  }

  async ensureModelInstalled(modelId) {
    const model = this._resolveModel(modelId);
    if (!modelExists(model.fileName)) {
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
      throw new Error('Local AI model is not installed.');
    }

    const result = await this.verifyModel(model.id);
    if (!result.valid) {
      throw new Error(result.errors?.[0] || result.error || 'Local AI model verification failed.');
    }
  }

  async downloadModel(modelId) {
    if (this._downloader.isDownloading) {
      throw new Error('Download already in progress.');
    }

    const model = this._resolveModel(modelId);
    ensureModelsDir();

    this._progress = {
      modelId: model.id,
      downloadedBytes: 0,
      totalBytes: model.downloadSizeBytes,
      percentage: 0,
      speedBytesPerSecond: 0,
      estimatedSecondsRemaining: null,
    };
    this._set(STATUS.DOWNLOADING, 'Downloading local AI model...');

    let partPath;
    try {
      partPath = await this._downloader.download(model, (progress) => {
        this._progress = progress;
        this._message = `Downloading local AI model... ${progress.percentage}%`;
      }, { retries: 5 });
    } catch (err) {
      if (err.cancelled) {
        this._set(STATUS.DOWNLOAD_PAUSED, 'Download cancelled.');
      } else {
        this._set(STATUS.ERROR, 'The local AI model could not be downloaded.', err.message);
      }
      throw err;
    }

    this._set(STATUS.VERIFYING, 'Verifying model checksum...');
    const verification = await this._verifier.verify(partPath, model.sha256, { quarantineInvalid: true });
    if (!verification.valid) {
      this._set(STATUS.FAILED, 'Model verification failed. The model was not installed.', verification.error);
      throw new Error(verification.error || 'Model verification failed.');
    }

    const finalPath = getModelPath(model.fileName);
    try {
      fs.rmSync(finalPath, { force: true });
      fs.renameSync(partPath, finalPath);
    } catch (err) {
      this._set(STATUS.FAILED, 'Verified model could not be saved.', err.message);
      throw err;
    }

    this._progress = null;
    this._set(STATUS.INSTALLED, 'Local AI model installed.');
    await this.startRuntime(model.id);
  }

  cancelDownload() {
    this._downloader.cancel();
    this._set(STATUS.DOWNLOAD_PAUSED, 'Download cancelled.');
  }

  async verifyModel(modelId) {
    const model = this._resolveModel(modelId);
    const modelPath = getModelPath(model.fileName);

    this._set(STATUS.VERIFYING, 'Verifying model checksum...');
    const result = await this._verifyLocalModel(model, { force: true });

    if (result.valid) {
      this._set(STATUS.INSTALLED, 'Local AI model verified.');
    } else {
      this._set(STATUS.FAILED, 'Model verification failed.', result.errors?.[0] || result.error);
    }

    return result;
  }

  async startRuntime(modelId) {
    const model = this._resolveModel(modelId);
    const modelPath = getModelPath(model.fileName);

    if (this._startPromise) {
      console.log(`[AI Runtime] Startup reused for ${this._startModelId || model.id}; duplicate start prevented.`);
      return this._startPromise;
    }

    this._startModelId = model.id;
    this._set(STATUS.STARTING, 'Starting local AI runtime...');
    this._startPromise = this._startRuntimeLocked(model, modelPath)
      .catch((err) => {
        this._set(STATUS.FAILED, 'Failed to start local AI runtime.', err.message);
        throw err;
      })
      .finally(() => {
        this._startPromise = null;
        this._startModelId = null;
      });

    return this._startPromise;
  }

  async stopRuntime() {
    await this._server.stop();
    const model = await this.getActiveModel();
    if (modelExists(model.fileName)) {
      this._set(STATUS.INSTALLED, 'Local AI runtime stopped. Model remains installed.');
    } else {
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
    }
  }

  async healthCheck() {
    const status = await this.getStatus();
    if (status.status !== STATUS.READY) {
      return {
        healthy: false,
        modelAvailable: status.status !== STATUS.NOT_INSTALLED,
        status: status.status,
        error: status.error || status.message,
      };
    }

    const startedAt = Date.now();
    const healthy = await this._server.healthCheck();
    console.log(`[AI Runtime] Model health check duration: ${Date.now() - startedAt}ms (healthy=${healthy}).`);
    this._lastHealthCheckAt = Date.now();
    this._lastHealthResult = healthy;
    if (!healthy) {
      this._set(STATUS.FAILED, 'Local AI runtime failed its health check.', 'Runtime health check failed.');
    }

    return {
      healthy,
      modelAvailable: true,
      status: this._status,
      activeModelId: status.activeModelId,
      runtime: status.runtime,
    };
  }

  async ensureReady() {
    if (this._status === STATUS.DISABLED) {
      throw new Error('AI assistant is disabled. Enable it from the AI setup panel.');
    }

    if (this._status === STATUS.NOT_INSTALLED || this._status === STATUS.DOWNLOAD_PAUSED) {
      throw new Error('Local AI model is not installed. Download it from the AI setup panel.');
    }

    if (this._status === STATUS.STARTING) {
      if (this._startPromise) {
        console.log('[AI Runtime] Startup reused by chat request; waiting for existing local model start.');
        await this._startPromise;
        return;
      }
      throw new Error('Local AI runtime is starting. Please try again shortly.');
    }

    if (this._status === STATUS.READY) {
      // Only re-run the health check if more than 60 s have elapsed since the last one
      const now = Date.now();
      if (now - this._lastHealthCheckAt < HEALTH_CACHE_MS) return;
      const health = await this.healthCheck();
      if (health.healthy) return;
      throw new Error(this._error || 'Local AI runtime failed its health check.');
    }

    if (this._status === STATUS.FAILED || this._status === STATUS.ERROR) {
      throw new Error(this._error || this._message || 'Local AI runtime failed to start.');
    }

    const status = await this.getStatus();
    if (status.status === STATUS.NOT_INSTALLED || status.status === STATUS.DOWNLOAD_PAUSED) {
      throw new Error('Local AI model is not installed. Download it from the AI setup panel.');
    }
    if (status.status === STATUS.STARTING && this._startPromise) {
      console.log('[AI Runtime] Startup reused by chat request after status check.');
      await this._startPromise;
      return;
    }
    if (status.status === STATUS.FAILED || status.status === STATUS.ERROR || status.status === 'failed') {
      throw new Error(status.error || status.message || 'Local AI runtime failed to start.');
    }

    await this.startRuntime(status.activeModelId);
  }

  getRuntimeClient() {
    return this._server;
  }

  setDisabled() {
    this._set(STATUS.DISABLED, 'AI assistant is disabled.');
  }

  async reenable() {
    const model = await this.getActiveModel();
    if (modelExists(model.fileName)) {
      await this.startRuntime(model.id);
    } else {
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
    }
  }

  async _startRuntimeLocked(model, modelPath) {
    await this._assertModelInstalledForStart(model, modelPath);

    if (await this._server.isReadyFor?.(model.runtime, modelPath)) {
      console.log('[AI Runtime] Model already running after verification; no reload needed.');
      this._lastHealthCheckAt = Date.now();
      this._lastHealthResult = true;
      this._set(STATUS.READY, `Local AI ready. Model: ${model.displayName}`);
      return;
    }

    console.log(`[AI Runtime] Model process started for ${model.id}.`);
    await this._server.start(model, modelPath);
    const verification = await this._verifyLocalModel(model, {
      runRuntimeChecks: true,
      force: true,
    });
    if (!verification.ready) {
      throw new Error(verification.errors.join(' '));
    }
    this._lastHealthCheckAt = Date.now();
    this._lastHealthResult = true;
    this._set(STATUS.READY, `Local AI ready. Model: ${model.displayName}`);
  }

  async _assertModelInstalledForStart(model, modelPath) {
    if (!modelExists(model.fileName)) {
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
      throw new Error('Local AI model is not installed.');
    }

    const result = await this._verifyLocalModel(model, {
      runRuntimeChecks: false,
      useCache: true,
    });
    if (!result.valid) {
      throw new Error(result.errors?.[0] || result.error || 'Local AI model verification failed.');
    }
  }

  _resolveModel(modelId) {
    const id = modelId || ModelRegistry.getActiveModelId();
    const configuredModel = ModelRegistry.getModel(id);
    const model = configuredModel
      ? {
        ...configuredModel,
        runtime: process.env.LOCAL_MODEL_RUNTIME || configuredModel.runtime,
        sha256: process.env.LOCAL_MODEL_SHA256 || configuredModel.sha256,
      }
      : null;
    if (!model) throw new Error(`Unknown local AI model "${id}".`);
    return model;
  }

  async _verifyLocalModel(model, options = {}) {
    const modelPath = getModelPath(model.fileName);
    const runRuntimeChecks = options.runRuntimeChecks === true;
    const key = this._verificationKey(model, modelPath);

    if (
      options.useCache &&
      this._verificationCache?.key === key &&
      (!runRuntimeChecks || this._verificationCache.runtimeChecked)
    ) {
      return this._verificationCache.result;
    }

    const result = await this._localModelVerifier.verify({
      modelDef: model,
      modelPath,
      expectedSha256: model.sha256,
      runtime: model.runtime,
      runtimeClient: runRuntimeChecks ? this._server : null,
      runRuntimeChecks,
    });

    this._verificationCache = { key, runtimeChecked: runRuntimeChecks, result };
    return result;
  }

  _verificationKey(model, modelPath) {
    let statKey = 'missing';
    try {
      const stat = fs.statSync(modelPath);
      statKey = `${stat.size}:${stat.mtimeMs}`;
    } catch {}
    return `${model.id}:${modelPath}:${model.runtime}:${model.sha256 || ''}:${statKey}`;
  }

  _responseStatus(verification) {
    if (this._status === STATUS.FAILED) return STATUS.FAILED;
    if (this._status === STATUS.READY) return verification.ready ? STATUS.READY : 'failed';
    if (!verification.modelPathConfigured) return 'failed';
    if (!verification.fileExists) return STATUS.NOT_INSTALLED;

    const formatOrHashFailure = verification.fileExists && verification.errors.some((error) =>
      /GGUF|safetensors|SHA-256|too small|not readable|runtime/i.test(error)
    );
    if (formatOrHashFailure) return 'failed';

    return this._status;
  }

  _refreshMissingModel(model) {
    if (!model) return;
    const runningStatus = [
      STATUS.INSTALLED,
      STATUS.STARTING,
      STATUS.READY,
      STATUS.VERIFYING,
    ].includes(this._status);

    if (runningStatus && !modelExists(model.fileName)) {
      this._server.stop().catch(() => {});
      this._progress = null;
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
    }
  }

  _refreshCompletedDownload(model) {
    if (this._status !== STATUS.DOWNLOADING || this._downloader.isDownloading) return;

    if (modelExists(model.fileName)) {
      this._progress = null;
      this._set(STATUS.INSTALLED, 'Local AI model downloaded. Verification is pending.');
      return;
    }

    if (!fs.existsSync(getModelPartPath(model.fileName))) {
      this._progress = null;
      this._set(STATUS.NOT_INSTALLED, 'The local AI model is not installed.');
    }
  }

  _set(status, message, error = null) {
    this._status = status;
    this._message = message;
    this._error = error;

    if (error) {
      console.error(`[AI Runtime] ${status}: ${message} ${error}`);
    } else {
      console.log(`[AI Runtime] ${status}: ${message}`);
    }
  }
}

let _instance;
const getInstance = () => {
  if (!_instance) _instance = new AiRuntimeManager();
  return _instance;
};

module.exports = { AiRuntimeManager, getInstance, STATUS };
