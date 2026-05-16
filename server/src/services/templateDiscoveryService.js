'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Template = require('../models/Template');
const Document = require('../models/Document');
const {
  classify,
  cleanTitle,
  buildTags,
  isTemplatePath,
  shouldSkip,
  isSupportedExtension,
  getExtension,
} = require('./templateClassifier');

const BACKEND_TEMPLATES_DIR = path.join(__dirname, '../../templates');

/**
 * Computes a stable, unique source key for a LEGAL_FOLDER_SYNC candidate.
 * SHA-256 of "LEGAL_FOLDER_SYNC::{sourceId}::{normalizedPath}" so that the
 * same file from the same source always produces the same key across syncs.
 *
 * @param {string} legalFolderSourceId
 * @param {object} candidate  — must have at least one of: sourcePath, name
 * @returns {string} hex SHA-256 digest
 */
function computeSourceKey(legalFolderSourceId, candidate) {
  const sourceId = String(legalFolderSourceId || '').toLowerCase().trim();
  const rawPath = String(candidate.sourcePath || candidate.name || '')
    .replace(/\\/g, '/')
    .toLowerCase()
    .trim();
  return crypto.createHash('sha256')
    .update(`LEGAL_FOLDER_SYNC::${sourceId}::${rawPath}`)
    .digest('hex');
}

/**
 * Discovers and idempotently upserts templates from multiple sources.
 *
 * @param {{ candidates?: object[], userId?: string, legalFolderSource?: object }} options
 *   legalFolderSource: { id, name, syncedAt } — metadata for the Legal Folder
 *   source that produced the candidates. When present, enables sourceKey-based
 *   upsert and stale record removal.
 * @returns {Promise<object>} summary
 */
async function discoverTemplates({ candidates = [], userId, legalFolderSource } = {}) {
  const legalFolderSourceId = legalFolderSource?.id || null;

  const summary = {
    source: 'discover',
    scanned: 0,
    supportedFiles: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    skippedDuplicates: 0,
    removedStale: 0,
    failed: 0,
    sourceId: legalFolderSourceId,
    warnings: [],
  };

  // Tracks dedup keys across all sources within this call
  const seen = new Set();
  // Tracks sourceKeys encountered in this sync (used for stale removal)
  const seenSourceKeys = new Set();

  // ── 1. Frontend-provided candidates (LEGAL_FOLDER_SYNC) ───────────────────
  if (Array.isArray(candidates) && candidates.length > 0) {
    for (const candidate of candidates) {
      summary.scanned++;
      try {
        const outcome = await _processFrontendCandidate(
          candidate, userId, seen, seenSourceKeys, legalFolderSourceId
        );
        if (outcome === 'duplicate') {
          summary.skippedDuplicates++;
        } else {
          _tally(summary, outcome);
        }
      } catch (err) {
        summary.failed++;
        summary.warnings.push(`Failed to import "${candidate.name}": ${err.message}`);
      }
    }

    // Remove stale LEGAL_FOLDER_SYNC records from this source that were not
    // seen in this sync — they are no longer present in the Legal Folder.
    if (legalFolderSourceId && seenSourceKeys.size > 0) {
      try {
        const removeResult = await Template.deleteMany({
          sourceKind: 'LEGAL_FOLDER_SYNC',
          legalFolderSourceId: String(legalFolderSourceId),
          sourceKey: { $nin: Array.from(seenSourceKeys) },
        });
        summary.removedStale = removeResult.deletedCount;
      } catch (err) {
        summary.warnings.push(`Stale template removal failed: ${err.message}`);
      }
    }
  }

  // ── 2. MongoDB legal folder documents with template-like paths ────────────
  try {
    const legalDocs = await Document.find({ isInLegalFolder: true })
      .select('name originalName legalFolderPath filename path mimetype fileSize size updatedAt')
      .lean();

    for (const doc of legalDocs) {
      const sourcePath = doc.legalFolderPath || '';
      if (!isTemplatePath(sourcePath)) continue;

      const fileName = doc.originalName || doc.name || '';
      if (!fileName || shouldSkip(fileName) || !isSupportedExtension(fileName)) continue;

      summary.scanned++;
      summary.supportedFiles++;

      const dedupKey = `mongo:${String(doc._id)}`;
      if (seen.has(dedupKey)) { summary.skipped++; continue; }
      seen.add(dedupKey);

      try {
        const outcome = await _upsertFromMongoDocument(doc, userId);
        _tally(summary, outcome);
      } catch (err) {
        summary.failed++;
        summary.warnings.push(`Failed to import document "${doc.name}": ${err.message}`);
      }
    }
  } catch (err) {
    summary.warnings.push(`Could not query legal folder documents from MongoDB: ${err.message}`);
  }

  // ── 3. Backend disk: server/templates/ (SERVER_UPLOAD) ────────────────────
  try {
    await _scanDiskDirectory(BACKEND_TEMPLATES_DIR, summary, seen, userId);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      summary.warnings.push(`Could not scan server/templates/: ${err.message}`);
    }
  }

  if (summary.imported === 0 && summary.updated === 0 && candidates.length === 0) {
    summary.warnings.push(
      'No backend-synced legal folder files matched template criteria. ' +
      'Sync the Legal Folder first, then click "Sync Templates from Legal Folder" again.'
    );
  }

  return summary;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Idempotent upsert for a single frontend-provided template candidate.
 * Lookup priority:
 *  1. sourceKey (new stable hash) — prevents duplicates across syncs
 *  2. legacy storageKey / (originalFileName + sourceFolder) — migrates old records
 *  3. Create new record
 *
 * @returns {Promise<'imported'|'updated'|'skipped'|'duplicate'>}
 */
async function _processFrontendCandidate(candidate, userId, seen, seenSourceKeys, legalFolderSourceId) {
  const { name, sourcePath, size, _id: frontendId, updatedAt } = candidate;

  if (!name || shouldSkip(name) || !isSupportedExtension(name)) return 'skipped';

  // Dedup within this payload (same path submitted twice)
  const dedupKey = `frontend:${sourcePath || name}`;
  if (seen.has(dedupKey)) return 'duplicate';
  seen.add(dedupKey);

  const { title, version } = cleanTitle(name);
  const classification = classify(name, sourcePath || '');
  const ext = getExtension(name);
  const folderLabel = _extractFolderLabel(sourcePath);
  const storeKey = `legal_folder:${frontendId || sourcePath}`;

  // Compute stable sourceKey when we have a source identifier
  const sourceKey = legalFolderSourceId
    ? computeSourceKey(legalFolderSourceId, candidate)
    : null;

  if (sourceKey) seenSourceKeys.add(sourceKey);

  // 1. Idempotent lookup by sourceKey (preferred, collision-proof)
  if (sourceKey && legalFolderSourceId) {
    const existing = await Template.findOne({ sourceKind: 'LEGAL_FOLDER_SYNC', sourceKey });
    if (existing) {
      await Template.updateOne(
        { _id: existing._id },
        { $set: { lastScannedAt: new Date(), updatedBy: userId, legalFolderSourceId } }
      );
      return 'updated';
    }
  }

  // 2. Legacy dedup for pre-migration records — update them with new fields
  const existingLegacy = await Template.findOne({
    $or: [
      { storageKey: storeKey },
      { originalFileName: name, sourceFolder: folderLabel },
    ],
  });

  if (existingLegacy) {
    const patch = { lastScannedAt: new Date(), updatedBy: userId };
    if (sourceKey) patch.sourceKey = sourceKey;
    if (legalFolderSourceId) patch.legalFolderSourceId = legalFolderSourceId;
    if (!existingLegacy.sourceKind) patch.sourceKind = 'LEGAL_FOLDER_SYNC';
    await Template.updateOne({ _id: existingLegacy._id }, { $set: patch });
    return 'updated';
  }

  // 3. Create new record
  const doc = {
    name: title,
    title,
    description: `Discovered from Legal Folder — ${folderLabel || 'Templates'}`,
    originalFileName: name,
    sourcePath,
    sourceFolder: folderLabel,
    sourceType: 'DISCOVERED',
    sourceKind: 'LEGAL_FOLDER_SYNC',
    storageKey: storeKey,
    extension: ext,
    fileType: _normaliseFileType(ext),
    fileSize: size || 0,
    agreementFamily: classification.agreementFamily,
    category: classification.category,
    tags: buildTags(title, classification),
    versionLabel: version,
    classificationConfidence: classification.confidence,
    classificationSignals: classification.signals,
    status: 'ACTIVE',
    approvalStatus: 'APPROVED',
    isDiscovered: true,
    isUploaded: false,
    isActive: true,
    lastScannedAt: new Date(),
    createdBy: userId,
  };

  if (sourceKey) doc.sourceKey = sourceKey;
  if (legalFolderSourceId) doc.legalFolderSourceId = legalFolderSourceId;
  if (updatedAt) doc.updatedAt = new Date(updatedAt);

  await Template.create(doc);
  return 'imported';
}

/**
 * Creates or refreshes a Template record from a MongoDB Document that lives
 * in the legal folder and has a template-like source path.
 */
async function _upsertFromMongoDocument(doc, userId) {
  const fileName = doc.originalName || doc.name || '';
  const { title, version } = cleanTitle(fileName);
  const classification = classify(fileName, doc.legalFolderPath || '');
  const ext = getExtension(fileName);
  const folderLabel = _extractFolderLabel(doc.legalFolderPath);

  const existing = await Template.findOne({ documentId: doc._id });

  if (existing) {
    await Template.updateOne(
      { _id: existing._id },
      { $set: { lastScannedAt: new Date(), updatedBy: userId } }
    );
    return 'updated';
  }

  await Template.create({
    name: title,
    title,
    originalFileName: fileName,
    sourcePath: doc.legalFolderPath,
    sourceFolder: folderLabel,
    sourceType: 'DISCOVERED',
    sourceKind: 'LEGAL_FOLDER_SYNC',
    documentId: doc._id,
    filename: doc.filename,
    path: doc.path,
    mimeType: doc.mimetype,
    extension: ext,
    fileType: _normaliseFileType(ext, doc.mimetype),
    fileSize: doc.fileSize || doc.size || 0,
    agreementFamily: classification.agreementFamily,
    category: classification.category,
    tags: buildTags(title, classification),
    versionLabel: version,
    classificationConfidence: classification.confidence,
    classificationSignals: classification.signals,
    status: 'ACTIVE',
    approvalStatus: 'APPROVED',
    isDiscovered: true,
    isUploaded: false,
    isActive: true,
    lastScannedAt: new Date(),
    createdBy: userId,
  });

  return 'imported';
}

/**
 * Recursively scans a backend disk directory. Files here are SERVER_UPLOAD
 * records — they have real server-side paths and are not tied to a Legal Folder.
 */
async function _scanDiskDirectory(dirPath, summary, seen, userId) {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await _scanDiskDirectory(entryPath, summary, seen, userId);
      continue;
    }

    if (!entry.isFile()) continue;

    const fileName = entry.name;
    if (shouldSkip(fileName) || !isSupportedExtension(fileName)) continue;

    summary.scanned++;
    summary.supportedFiles++;

    const dedupKey = `disk:${entryPath}`;
    if (seen.has(dedupKey)) { summary.skipped++; continue; }
    seen.add(dedupKey);

    try {
      const existing = await Template.findOne({ path: entryPath });
      if (existing) {
        await Template.updateOne(
          { _id: existing._id },
          { $set: { lastScannedAt: new Date(), sourceKind: 'SERVER_UPLOAD' } }
        );
        summary.updated++;
        continue;
      }

      const stats = fs.statSync(entryPath);
      const { title, version } = cleanTitle(fileName);
      const classification = classify(fileName, dirPath);
      const ext = getExtension(fileName);
      const folderLabel = path.basename(dirPath);

      await Template.create({
        name: title,
        title,
        originalFileName: fileName,
        filename: fileName,
        path: entryPath,
        filePath: entryPath,
        sourcePath: dirPath,
        sourceFolder: folderLabel,
        sourceType: 'UPLOADED',
        sourceKind: 'SERVER_UPLOAD',
        extension: ext,
        fileType: _normaliseFileType(ext),
        fileSize: stats.size,
        agreementFamily: classification.agreementFamily,
        category: classification.category,
        tags: buildTags(title, classification),
        versionLabel: version,
        classificationConfidence: classification.confidence,
        classificationSignals: classification.signals,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isDiscovered: false,
        isUploaded: true,
        isActive: true,
        lastScannedAt: new Date(),
        createdBy: userId,
      });

      summary.imported++;
    } catch (err) {
      summary.failed++;
      summary.warnings.push(`Failed to import file "${fileName}": ${err.message}`);
    }
  }
}

function _tally(summary, outcome) {
  if (outcome === 'imported') summary.imported++;
  else if (outcome === 'updated') summary.updated++;
  else summary.skipped++;
}

function _extractFolderLabel(sourcePath) {
  if (!sourcePath) return null;
  const parts = String(sourcePath)
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(-2).join(' / ') || null;
}

function _normaliseFileType(ext, mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  const allowed = ['docx', 'dotx', 'doc', 'txt', 'md'];
  return allowed.includes(ext) ? ext : 'docx';
}

module.exports = { discoverTemplates, computeSourceKey };
