const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ToolCallParser } = require('../parsing/ToolCallParser');
const { normalizeRuntime, runtimeDisplayName } = require('../runtime/LocalModelServer');

const DEFAULT_MIN_MODEL_BYTES = 1024 * 1024;

const sha256Pattern = /^[a-f0-9]{64}$/i;

function defaultResolveRuntimePackage(packageName) {
  const searchPaths = require.resolve.paths(packageName) || [];
  for (const searchPath of searchPaths) {
    const packagePath = path.join(searchPath, packageName, 'package.json');
    if (fs.existsSync(packagePath)) return packagePath;
  }
  throw new Error(`${packageName} not found`);
}

const toolRegistry = {
  get(name) {
    return name === 'list_my_tasks'
      ? { name, schema: { type: 'object', additionalProperties: false, properties: {} } }
      : null;
  },
};

function isCloudEnabled() {
  return process.env.ALLOW_CLOUD_AI === 'true';
}

function sourceFromModel(modelDef) {
  if (process.env.LOCAL_MODEL_SOURCE) return process.env.LOCAL_MODEL_SOURCE;
  const downloadUrl = String(modelDef?.downloadUrl || '');
  if (/^https:\/\/huggingface\.co\//i.test(downloadUrl)) return 'huggingface_download';
  return 'local_file';
}

function formatFromPath(modelPath) {
  const ext = path.extname(String(modelPath || '')).replace(/^\./, '').toLowerCase();
  if (ext === 'gguf') return 'gguf';
  if (ext === 'safetensors') return 'safetensors';
  return 'unknown';
}

function extractText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  return output.content || output.message || output.question || JSON.stringify(output);
}

function extractJsonObject(text) {
  const source = String(text || '').trim();
  try { return JSON.parse(source); } catch {}

  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)); } catch {}
        return null;
      }
    }
  }
  return null;
}

class LocalModelVerifier {
  constructor(options = {}) {
    this._fs = options.fs || fs;
    this._crypto = options.crypto || crypto;
    this._parser = options.toolCallParser || new ToolCallParser();
    this._minModelBytes = options.minModelBytes || DEFAULT_MIN_MODEL_BYTES;
    this._resolveRuntimePackage = options.resolveRuntimePackage || defaultResolveRuntimePackage;
  }

  async verify({
    modelDef = null,
    modelPath = '',
    expectedSha256 = '',
    runtime = '',
    runtimeClient = null,
    runRuntimeChecks = false,
    minModelBytes = this._minModelBytes,
  } = {}) {
    const normalizedRuntime = normalizeRuntime(runtime || modelDef?.runtime || process.env.LOCAL_MODEL_RUNTIME || '');
    const runtimeName = runtimeDisplayName(normalizedRuntime || runtime || modelDef?.runtime);
    const format = formatFromPath(modelPath);
    const result = {
      provider: 'local',
      modelSource: sourceFromModel(modelDef),
      runtime: runtimeName,
      cloudEnabled: isCloudEnabled(),
      usesCloudInference: false,
      modelPathConfigured: Boolean(modelPath),
      fileExists: false,
      fileReadable: false,
      format,
      formatValid: false,
      fileSizeBytes: undefined,
      hashConfigured: sha256Pattern.test(String(expectedSha256 || '')),
      hashValid: undefined,
      runtimeConfigured: Boolean(normalizedRuntime),
      runtimeBinaryExists: false,
      runtimeStarted: false,
      basicPromptPassed: false,
      jsonPromptPassed: false,
      toolCallPromptPassed: false,
      ready: false,
      valid: false,
      errors: [],
    };

    if (!result.modelPathConfigured) {
      result.errors.push('Local model path is not configured. Set LOCAL_MODEL_PATH or use a configured local model.');
      return this._finish(result);
    }

    await this._checkFile(result, modelPath, expectedSha256, minModelBytes);
    this._checkRuntimeConfig(result, normalizedRuntime);

    if (runRuntimeChecks && !result.errors.length) {
      await this._runPromptChecks(result, runtimeClient);
    }

    return this._finish(result);
  }

  async _checkFile(result, modelPath, expectedSha256, minModelBytes) {
    try {
      const stat = this._fs.statSync(modelPath);
      result.fileExists = stat.isFile();
      result.fileSizeBytes = stat.size;
    } catch {
      result.errors.push('Local model file does not exist.');
      return;
    }

    try {
      this._fs.accessSync(modelPath, this._fs.constants.R_OK);
      result.fileReadable = true;
    } catch {
      result.errors.push('Local model file is not readable.');
    }

    if (result.runtime === 'llama.cpp') {
      result.formatValid = result.format === 'gguf';
      if (!result.formatValid) {
        if (result.format === 'safetensors') {
          result.errors.push('This local runtime expects a GGUF model file. The selected model appears to be .safetensors. Please provide a GGUF version or configure a compatible local runtime.');
        } else {
          result.errors.push('Local llama.cpp runtime expects a GGUF model file.');
        }
      }
    } else {
      result.formatValid = result.format !== 'unknown';
    }

    if (Number.isFinite(minModelBytes) && result.fileSizeBytes <= minModelBytes) {
      result.errors.push(`Local model file is too small to be a valid model (${result.fileSizeBytes} bytes).`);
    }

    if (result.hashConfigured) {
      const actual = await this._sha256(modelPath);
      result.actualSha256 = actual;
      result.expectedSha256 = expectedSha256;
      result.hashValid = actual.toLowerCase() === expectedSha256.toLowerCase();
      if (!result.hashValid) result.errors.push('Local model SHA-256 hash does not match the configured value.');
    }
  }

  _checkRuntimeConfig(result, normalizedRuntime) {
    if (!result.runtimeConfigured) {
      result.errors.push('Local model runtime is not configured. Set LOCAL_MODEL_RUNTIME=llama.cpp.');
      return;
    }

    if (normalizedRuntime === 'llama_cpp') {
      try {
        this._resolveRuntimePackage('node-llama-cpp');
        result.runtimeBinaryExists = true;
      } catch {
        result.errors.push('The local llama.cpp runtime package is not installed.');
      }
      return;
    }

    result.errors.push(`Unsupported local model runtime: ${result.runtime}`);
  }

  async _runPromptChecks(result, runtimeClient) {
    if (!runtimeClient || typeof runtimeClient.generate !== 'function') {
      result.errors.push('Local runtime is not started.');
      return;
    }

    result.runtimeStarted = typeof runtimeClient.healthCheck === 'function'
      ? Boolean(await runtimeClient.healthCheck())
      : true;
    if (!result.runtimeStarted) {
      result.errors.push('Local runtime failed its health check.');
      return;
    }

    const basic = await runtimeClient.generate({
      messages: [{ role: 'user', content: 'Say only: READY' }],
      maxTokens: 16,
      temperature: 0,
    });
    const basicText = extractText(basic).trim();
    result.basicPromptPassed = /\bREADY\b/i.test(basicText) &&
      !/\bNOT\s+READY\b/i.test(basicText) &&
      basicText.length <= 80;
    if (!result.basicPromptPassed) result.errors.push('Local model failed the basic READY prompt test.');

    const json = await runtimeClient.generate({
      messages: [{ role: 'user', content: 'Return only valid JSON:\n{"status":"ready"}' }],
      maxTokens: 64,
      temperature: 0,
    });
    const jsonObject = extractJsonObject(extractText(json));
    result.jsonPromptPassed = jsonObject?.status === 'ready';
    if (!result.jsonPromptPassed) result.errors.push('Local model loaded, but failed the JSON format test.');

    const toolPrompt = 'You are a tool-calling assistant.\nReturn only this JSON object and nothing else:\n{"type":"tool_call","toolName":"list_my_tasks","args":{}}';
    const tool = await runtimeClient.generate({
      messages: [{ role: 'user', content: toolPrompt }],
      maxTokens: 96,
      temperature: 0,
    });
    const parsedTool = this._parser.parse(
      tool.type === 'tool_call' ? tool : { type: 'assistant_message', content: extractText(tool) },
      toolRegistry
    );
    result.toolCallPromptPassed = parsedTool?.toolName === 'list_my_tasks';
    if (!result.toolCallPromptPassed) result.errors.push('Model loaded, but failed tool-call format test.');
  }

  _finish(result) {
    result.ready = result.errors.length === 0;
    result.valid = result.ready;
    return result;
  }

  _sha256(modelPath) {
    return new Promise((resolve, reject) => {
      const hash = this._crypto.createHash('sha256');
      const stream = this._fs.createReadStream(modelPath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}

module.exports = { LocalModelVerifier, formatFromPath, sourceFromModel };
