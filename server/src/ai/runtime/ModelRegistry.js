const config = require('../config/assistant.config.json');

function getActiveModelId() {
  return process.env.ACTIVE_MODEL_ID || config.activeModel;
}

function getModel(modelId) {
  if (!modelId) return null;
  return config.models?.[modelId] || null;
}

function getActiveModel() {
  return getModel(getActiveModelId());
}

function getAllModels() {
  return Object.values(config.models || {});
}

function getConfig() {
  return config;
}

const ModelRegistry = {
  getConfig,
  getActiveModelId,
  getModel,
  getActiveModel,
  getAllModels,
};

module.exports = {
  ModelRegistry,
  getConfig,
  getActiveModelId,
  getModel,
  getActiveModel,
  getAllModels,
};
