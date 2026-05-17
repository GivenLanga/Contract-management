'use strict';

const crypto = require('crypto');

const STAGES = ['TEMPLATE', 'DRAFT', 'FINAL', 'SIGNED', 'UNKNOWN'];

function stableId(sourceId, relativePath) {
  const hash = crypto
    .createHash('sha256')
    .update(`${sourceId || 'legal-folder'}:${relativePath || ''}`)
    .digest('hex')
    .slice(0, 16);
  return `lf-file:${hash}`;
}

function normalizeRelative(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function nowIso() {
  return new Date().toISOString();
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMetadata(input = {}) {
  const relativePath = normalizeRelative(input.relativePath || input.displayPath || input.fileName);
  const sourceId = input.sourceId || 'legal-folder';
  const updatedAt = input.updatedAt || nowIso();
  const fileName = input.fileName || relativePath.split('/').pop() || '';
  const lifecycleStage = STAGES.includes(input.lifecycleStage) ? input.lifecycleStage : 'UNKNOWN';

  return {
    id: input.id || stableId(sourceId, relativePath),
    sourceId,
    fileName,
    relativePath,
    displayPath: input.displayPath || relativePath,
    extension: String(input.extension || '').replace(/^\./, '').toLowerCase(),
    fileSize: Number(input.fileSize || 0),
    lastModified: input.lastModified || null,
    contentHash: input.contentHash || null,
    lifecycleStage,
    year: input.year || null,
    category: input.category || null,
    counterparty: input.counterparty || null,
    stageFolder: input.stageFolder || null,
    agreementFamily: input.agreementFamily || 'OTHER',
    templateSourceKey: input.templateSourceKey || null,
    createdFromTemplate: Boolean(input.createdFromTemplate),
    contractStatus: input.contractStatus || null,
    contractStatusLabel: input.contractStatusLabel || null,
    contractValue: optionalNumber(input.contractValue),
    contractValueDisplay: input.contractValueDisplay || null,
    currency: input.currency || null,
    effectiveDate: input.effectiveDate || null,
    startDate: input.startDate || null,
    commencementDate: input.commencementDate || null,
    expiryDate: input.expiryDate || null,
    expirationDate: input.expirationDate || null,
    endDate: input.endDate || null,
    terminationDate: input.terminationDate || null,
    renewalDate: input.renewalDate || null,
    signedDate: input.signedDate || null,
    extraction: input.extraction || null,
    detectedAt: input.detectedAt || updatedAt,
    updatedAt,
    missingFromDisk: Boolean(input.missingFromDisk),
  };
}

class LegalFolderLifecycleIndex {
  constructor(initialRecords = []) {
    this.records = new Map();
    initialRecords.forEach((record) => this.upsertFileMetadata(record));
  }

  keyFor(sourceId, relativePath) {
    return `${sourceId || 'legal-folder'}:${normalizeRelative(relativePath)}`;
  }

  upsertFileMetadata(metadata) {
    const normalized = normalizeMetadata(metadata);
    if (!normalized.relativePath) return null;
    const key = this.keyFor(normalized.sourceId, normalized.relativePath);
    const existing = this.records.get(key);
    const next = existing
      ? {
        ...existing,
        ...normalized,
        id: existing.id,
        detectedAt: existing.detectedAt || normalized.detectedAt,
        updatedAt: normalized.updatedAt || nowIso(),
        missingFromDisk: false,
      }
      : normalized;
    this.records.set(key, next);
    return next;
  }

  removeFileMetadata(relativePath, sourceId = 'legal-folder') {
    return this.records.delete(this.keyFor(sourceId, relativePath));
  }

  getAllFiles(sourceId = null) {
    return Array.from(this.records.values())
      .filter((record) => !sourceId || record.sourceId === sourceId)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  getFilesByStage(stage, sourceId = null) {
    return this.getAllFiles(sourceId).filter((record) => record.lifecycleStage === stage);
  }

  getTemplates(sourceId = null) {
    return this.getFilesByStage('TEMPLATE', sourceId);
  }

  getDrafts(sourceId = null) {
    return this.getFilesByStage('DRAFT', sourceId);
  }

  getFinalDocuments(sourceId = null) {
    return this.getFilesByStage('FINAL', sourceId);
  }

  getSignedDocuments(sourceId = null) {
    return this.getFilesByStage('SIGNED', sourceId);
  }

  getFilesByCounterparty(counterparty, sourceId = null) {
    const needle = String(counterparty || '').trim().toLowerCase();
    if (!needle) return [];
    return this.getAllFiles(sourceId).filter((record) =>
      String(record.counterparty || '').toLowerCase() === needle
    );
  }

  clearIndexForSource(sourceId) {
    if (!sourceId) {
      const count = this.records.size;
      this.records.clear();
      return count;
    }
    let removed = 0;
    for (const [key, record] of this.records.entries()) {
      if (record.sourceId === sourceId) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  replaceSourceFiles(sourceId, files = []) {
    this.clearIndexForSource(sourceId);
    files.forEach((file) => this.upsertFileMetadata({ ...file, sourceId }));
    return this.getAllFiles(sourceId);
  }

  summary(sourceId = null) {
    const files = this.getAllFiles(sourceId);
    const counts = files.reduce((acc, file) => {
      const key = String(file.lifecycleStage || 'UNKNOWN').toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      templates: counts.template || 0,
      drafts: counts.draft || 0,
      finals: counts.final || 0,
      signed: counts.signed || 0,
      unknown: counts.unknown || 0,
      scanned: files.length,
      skipped: 0,
    };
  }

  toJSON(sourceId = null) {
    return {
      files: this.getAllFiles(sourceId),
      summary: this.summary(sourceId),
    };
  }
}

module.exports = {
  STAGES,
  LegalFolderLifecycleIndex,
  normalizeMetadata,
  stableId,
};
