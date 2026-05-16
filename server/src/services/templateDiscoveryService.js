'use strict';

const fs = require('fs');
const path = require('path');
const Template = require('../models/Template');
const Document = require('../models/Document');
const {
  classify,
  cleanTitle,
  buildTags,
  displaySourceLabel,
  isTemplatePath,
  shouldSkip,
  isSupportedExtension,
  getExtension,
} = require('./templateClassifier');

// Backend disk paths this service can access directly
const BACKEND_TEMPLATES_DIR = path.join(__dirname, '../../templates');
const BACKEND_UPLOADS_LEGAL_FOLDER = path.join(__dirname, '../../uploads/legal-folder');

/**
 * Discovers templates from three sources:
 *
 *  1. Frontend-provided candidates (from browser localStorage/IndexedDB) — the
 *     caller is responsible for filtering these to template paths before sending.
 *  2. MongoDB Document records with isInLegalFolder=true whose legalFolderPath
 *     matches a recognised template folder name.
 *  3. Backend-accessible disk directories: server/templates/ and
 *     server/uploads/legal-folder/ (only scanned when a template-like path
 *     can be inferred from the file or its location).
 *
 * @param {{ candidates?: object[], userId?: string }} options
 * @returns {Promise<object>} summary
 */
async function discoverTemplates({ candidates = [], userId } = {}) {
  const summary = {
    source: 'discover',
    scanned: 0,
    supportedFiles: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
  };

  // Tracks dedup keys so a file is not imported twice across sources
  const seen = new Set();

  // ── 1. Frontend-provided candidates ────────────────────────────────────────
  if (Array.isArray(candidates) && candidates.length > 0) {
    for (const candidate of candidates) {
      summary.scanned++;
      try {
        const outcome = await _processFrontendCandidate(candidate, userId, seen);
        _tally(summary, outcome);
      } catch (err) {
        summary.failed++;
        summary.warnings.push(`Failed to import "${candidate.name}": ${err.message}`);
      }
    }
  }

  // ── 2. MongoDB legal folder documents with template paths ──────────────────
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

  // ── 3. Backend disk: server/templates/ ────────────────────────────────────
  try {
    await _scanDiskDirectory(BACKEND_TEMPLATES_DIR, 'UPLOADED', summary, seen, userId);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      summary.warnings.push(`Could not scan server/templates/: ${err.message}`);
    }
  }

  // Note: server/uploads/legal-folder/ contains UUID-named files with no
  // obvious template signal in the filename itself, so we don't scan it
  // blindly — its contents are already discoverable via the MongoDB query
  // above (those Document records have legalFolderPath set).

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
 * Imports a single frontend-provided template candidate.
 * The candidate is a document metadata object from the browser localStorage.
 *
 * @param {object} candidate
 * @param {string|undefined} userId
 * @param {Set<string>} seen
 * @returns {Promise<'imported'|'updated'|'skipped'>}
 */
async function _processFrontendCandidate(candidate, userId, seen) {
  const { name, sourcePath, type: _type, size, _id: frontendId, updatedAt } = candidate;

  if (!name || shouldSkip(name) || !isSupportedExtension(name)) return 'skipped';

  const dedupKey = `frontend:${sourcePath || name}`;
  if (seen.has(dedupKey)) return 'skipped';
  seen.add(dedupKey);

  const { title, version } = cleanTitle(name);
  const classification = classify(name, sourcePath || '');
  const ext = getExtension(name);
  const folderLabel = _extractFolderLabel(sourcePath);
  const storeKey = `legal_folder:${frontendId || sourcePath}`;

  // Check for existing record
  const existing = await Template.findOne({
    $or: [
      { storageKey: storeKey },
      { originalFileName: name, sourceFolder: folderLabel },
    ],
  });

  if (existing) {
    await Template.updateOne({ _id: existing._id }, { $set: { lastScannedAt: new Date(), updatedBy: userId } });
    return 'updated';
  }

  await Template.create({
    name: title,
    title,
    description: `Discovered from Legal Folder — ${folderLabel || 'Templates'}`,
    originalFileName: name,
    sourcePath,
    sourceFolder: folderLabel,
    sourceType: 'DISCOVERED',
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
    updatedAt: updatedAt ? new Date(updatedAt) : undefined,
  });

  return 'imported';
}

/**
 * Creates or refreshes a Template record from a MongoDB Document record that
 * lives in the legal folder and has a template-like source path.
 *
 * @param {object} doc  - Mongoose Document lean object
 * @param {string|undefined} userId
 * @returns {Promise<'imported'|'updated'|'skipped'>}
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
 * Recursively scans a backend disk directory for supported template files.
 * Only creates Template records for files not already tracked.
 *
 * @param {string} dirPath
 * @param {'UPLOADED'|'DISCOVERED'} sourceType
 * @param {object} summary
 * @param {Set<string>} seen
 * @param {string|undefined} userId
 */
async function _scanDiskDirectory(dirPath, sourceType, summary, seen, userId) {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await _scanDiskDirectory(entryPath, sourceType, summary, seen, userId);
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
        await Template.updateOne({ _id: existing._id }, { $set: { lastScannedAt: new Date() } });
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
        sourceType,
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
        isDiscovered: sourceType === 'DISCOVERED',
        isUploaded: sourceType === 'UPLOADED',
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
  // Return the parent folder segment(s) — last two meaningful parts excluding the filename
  // (sourcePath may or may not include the filename)
  const meaningful = parts.slice(-2);
  return meaningful.join(' / ') || null;
}

function _normaliseFileType(ext, mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  const allowed = ['docx', 'dotx', 'doc', 'txt', 'md'];
  return allowed.includes(ext) ? ext : 'docx';
}

module.exports = { discoverTemplates };
