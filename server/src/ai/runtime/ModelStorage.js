const os   = require('os');
const path = require('path');
const fs   = require('fs');

const APP_NAME = 'ContractIQ';

function getModelsDir() {
  // Override via env
  if (process.env.MODEL_STORAGE_DIR && process.env.MODEL_STORAGE_DIR !== 'auto') {
    return process.env.MODEL_STORAGE_DIR;
  }

  const p = process.platform;
  if (p === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_NAME, 'models');
  }
  if (p === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, 'models');
  }
  // Linux / other
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'contractiq', 'models');
}

function ensureModelsDir() {
  const dir = getModelsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getModelPath(fileName) {
  if (process.env.LOCAL_MODEL_PATH) {
    return resolveLocalModelPath(process.env.LOCAL_MODEL_PATH);
  }
  return path.join(getModelsDir(), fileName);
}

function resolveLocalModelPath(modelPath) {
  if (!modelPath) return '';
  return path.isAbsolute(modelPath)
    ? modelPath
    : path.resolve(process.cwd(), modelPath);
}

function getModelPartPath(fileName) {
  return path.join(getModelsDir(), `${fileName}.part`);
}

function getModelInvalidPath(fileName) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(getModelsDir(), `${fileName}.invalid-${stamp}`);
}

function modelExists(fileName) {
  return fs.existsSync(getModelPath(fileName));
}

module.exports = {
  getModelsDir,
  ensureModelsDir,
  getModelPath,
  resolveLocalModelPath,
  getModelPartPath,
  getModelInvalidPath,
  modelExists,
};
