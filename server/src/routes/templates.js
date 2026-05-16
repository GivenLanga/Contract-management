'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const Template = require('../models/Template');
const Document = require('../models/Document');
const { protect, requireRole } = require('../middleware/auth');
const { templateUpload } = require('../middleware/upload');
const { discoverTemplates } = require('../services/templateDiscoveryService');
const { classify, cleanTitle, buildTags, displaySourceLabel, isSupportedExtension } = require('../services/templateClassifier');
const { sanitizeFilename, resolveDraftFilename } = require('../services/templateDraftPathService');

const router = express.Router();

// ── Shared visibility filter ──────────────────────────────────────────────────

function visibilityFilter(user) {
  if (user.role === 'admin' || user.role === 'manager') {
    return { isActive: true, isOrphaned: { $ne: true } };
  }
  return { isActive: true, isOrphaned: { $ne: true }, status: 'ACTIVE', approvalStatus: 'APPROVED' };
}

// ── GET /api/templates/facets ─────────────────────────────────────────────────
// Must be registered before /:id to avoid capture
router.get('/facets', protect, async (req, res) => {
  try {
    const base = visibilityFilter(req.user);

    const [categories, agreementFamilies, sourceTypes, statuses, tags] = await Promise.all([
      Template.distinct('category', base),
      Template.distinct('agreementFamily', base),
      Template.distinct('sourceType', base),
      Template.distinct('status', base),
      Template.distinct('tags', base),
    ]);

    res.json({
      categories: categories.filter(Boolean).sort(),
      agreementFamilies: agreementFamilies.filter(Boolean).sort(),
      sourceTypes: sourceTypes.filter(Boolean).sort(),
      statuses: statuses.filter(Boolean).sort(),
      tags: tags.filter(Boolean).sort(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/templates/diagnostics ───────────────────────────────────────────
router.get('/diagnostics', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const [total, active, discovered, uploaded, orphaned, pending, lastSynced, bySourceRaw] =
      await Promise.all([
        Template.countDocuments({ isActive: true }),
        Template.countDocuments({ isActive: true, status: 'ACTIVE' }),
        Template.countDocuments({ isDiscovered: true }),
        Template.countDocuments({ isUploaded: true }),
        Template.countDocuments({ isOrphaned: true }),
        Template.countDocuments({ isActive: true, status: 'PENDING_REVIEW' }),
        Template.findOne({ lastScannedAt: { $exists: true } })
          .sort({ lastScannedAt: -1 })
          .select('lastScannedAt')
          .lean(),
        Template.aggregate([
          { $match: { sourceKind: 'LEGAL_FOLDER_SYNC', legalFolderSourceId: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: '$legalFolderSourceId',
              count: { $sum: 1 },
              activeCount: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
              orphanedCount: { $sum: { $cond: [{ $eq: ['$isOrphaned', true] }, 1, 0] } },
            },
          },
          {
            $project: {
              _id: 0,
              legalFolderSourceId: '$_id',
              count: 1,
              activeCount: 1,
              orphanedCount: 1,
            },
          },
        ]),
      ]);

    res.json({
      totalTemplates: total,
      activeTemplates: active,
      discoveredTemplates: discovered,
      uploadedTemplates: uploaded,
      orphanedTemplates: orphaned,
      pendingReviewTemplates: pending,
      lastSync: lastSynced?.lastScannedAt || null,
      bySource: bySourceRaw,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/templates/discover ─────────────────────────────────────────────
router.post('/discover', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const candidates = Array.isArray(req.body.candidates) ? req.body.candidates : [];
    // legalFolderSource: { id, name, syncedAt } — enables idempotent upsert + stale removal
    const legalFolderSource = req.body.legalFolderSource || null;

    const summary = await discoverTemplates({
      candidates,
      userId: req.user._id,
      legalFolderSource,
    });

    res.json({
      ok: true,
      summary: {
        scanned: summary.scanned,
        imported: summary.imported,
        updated: summary.updated,
        skipped: summary.skipped,
        skippedDuplicates: summary.skippedDuplicates,
        removedStale: summary.removedStale,
        failed: summary.failed,
        sourceId: summary.sourceId,
        warnings: summary.warnings,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/templates/disconnect-source ─────────────────────────────────────
// Removes all LEGAL_FOLDER_SYNC templates belonging to a disconnected source.
// SERVER_UPLOAD templates are never touched.
router.post('/disconnect-source', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { legalFolderSourceId } = req.body;
    if (!legalFolderSourceId) {
      return res.status(400).json({ error: 'legalFolderSourceId is required.' });
    }

    const result = await Template.deleteMany({
      sourceKind: 'LEGAL_FOLDER_SYNC',
      legalFolderSourceId: String(legalFolderSourceId),
    });

    const n = result.deletedCount;
    res.json({
      removed: n,
      sourceId: legalFolderSourceId,
      message: `Removed ${n} discovered template${n !== 1 ? 's' : ''} from disconnected Legal Folder source.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/templates ────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const {
      search,
      category,
      agreementFamily,
      status,
      sourceType,
      approvalStatus,
      page = 1,
      limit = 100,
    } = req.query;

    const filter = visibilityFilter(req.user);

    if (category && category !== 'All') filter.category = category;
    if (agreementFamily) filter.agreementFamily = agreementFamily;
    if (status) filter.status = status;
    if (sourceType) filter.sourceType = sourceType;
    if (approvalStatus) filter.approvalStatus = approvalStatus;

    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [
        { name: re },
        { title: re },
        { description: re },
        { tags: re },
        { originalFileName: re },
        { category: re },
        { agreementFamily: re },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [templates, total] = await Promise.all([
      Template.find(filter)
        .populate('createdBy', 'name')
        .sort({ name: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Template.countDocuments(filter),
    ]);

    // Strip raw filesystem paths from non-admin users
    const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
    const sanitised = templates.map((t) => ({
      ...t,
      path: isPrivileged ? t.path : undefined,
      filePath: isPrivileged ? t.filePath : undefined,
      sourcePath: isPrivileged ? t.sourcePath : undefined,
      displaySource: displaySourceLabel(t.sourceFolder || t.sourcePath),
    }));

    res.json({ templates: sanitised, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/templates/:id ────────────────────────────────────────────────────
router.get('/:id', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id)
      .populate('createdBy', 'name')
      .lean();

    if (!template) return res.status(404).json({ error: 'Template not found.' });

    const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
    const result = {
      ...template,
      path: isPrivileged ? template.path : undefined,
      filePath: isPrivileged ? template.filePath : undefined,
      sourcePath: isPrivileged ? template.sourcePath : undefined,
      displaySource: displaySourceLabel(template.sourceFolder || template.sourcePath),
    };

    res.json({ template: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/templates (upload a new template) ───────────────────────────────
router.post(
  '/',
  protect,
  requireRole('admin', 'manager'),
  templateUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

      const { title, description, category, agreementFamily, tags } = req.body;
      const fileName = req.file.originalname;
      const ext = path.extname(fileName).slice(1).toLowerCase();

      if (!isSupportedExtension(fileName)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `Unsupported file type: .${ext}` });
      }

      const { title: derivedTitle } = cleanTitle(fileName);
      const classification = classify(fileName, '');

      const displayTitle = title?.trim() || derivedTitle;
      const resolvedAgreementFamily = agreementFamily || classification.agreementFamily;
      const resolvedCategory = category?.trim() || classification.category;
      const resolvedTags = tags
        ? String(tags).split(',').map((t) => t.trim()).filter(Boolean)
        : buildTags(displayTitle, classification);

      const template = await Template.create({
        name: displayTitle,
        title: displayTitle,
        description: description?.trim() || undefined,
        originalFileName: fileName,
        filename: req.file.filename,
        path: req.file.path,
        filePath: req.file.path,
        sourceFolder: 'Uploaded',
        sourceType: 'UPLOADED',
        sourceKind: 'SERVER_UPLOAD',
        mimeType: req.file.mimetype,
        extension: ext,
        fileType: ext === 'pdf' ? 'pdf' : ext === 'doc' ? 'doc' : 'docx',
        fileSize: req.file.size,
        agreementFamily: resolvedAgreementFamily,
        category: resolvedCategory,
        tags: resolvedTags,
        classificationConfidence: title ? 'high' : classification.confidence,
        classificationSignals: classification.signals,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isUploaded: true,
        isDiscovered: false,
        isActive: true,
        lastScannedAt: new Date(),
        createdBy: req.user._id,
      });

      res.status(201).json({ template });
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/templates/upload (backwards-compat alias) ──────────────────────
router.post(
  '/upload',
  protect,
  requireRole('admin', 'manager'),
  templateUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

      const { name, title, type, description, category, fields } = req.body;
      const fileName = req.file.originalname;
      const ext = path.extname(fileName).slice(1).toLowerCase();

      const { title: derivedTitle } = cleanTitle(fileName);
      const classification = classify(fileName, '');

      const displayTitle = (title || name)?.trim() || derivedTitle;

      const template = await Template.create({
        name: displayTitle,
        title: displayTitle,
        description: description?.trim(),
        originalFileName: fileName,
        filename: req.file.filename,
        path: req.file.path,
        filePath: req.file.path,
        sourceFolder: 'Uploaded',
        sourceType: 'UPLOADED',
        sourceKind: 'SERVER_UPLOAD',
        mimeType: req.file.mimetype,
        extension: ext,
        fileType: ext === 'pdf' ? 'pdf' : 'docx',
        fileSize: req.file.size,
        agreementFamily: classification.agreementFamily,
        category: category?.trim() || classification.category,
        tags: buildTags(displayTitle, classification),
        classificationConfidence: classification.confidence,
        classificationSignals: classification.signals,
        // Legacy fields
        type: type || undefined,
        fields: fields ? JSON.parse(fields) : [],
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isUploaded: true,
        isActive: true,
        createdBy: req.user._id,
      });

      res.status(201).json({ template });
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/templates/:id/draft ─────────────────────────────────────────────
// Legal Folder templates (LEGAL_FOLDER_SYNC) are now drafted entirely client-side
// using the browser File System Access API and JSZip. The backend is no longer the
// primary file store for these templates.
//
// SERVER_UPLOAD templates that have a backing file on disk are still supported
// server-side for compatibility, but this path is no longer the primary flow.
router.post('/:id/draft', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    // Legal Folder templates must be drafted client-side — the server does not hold
    // the file and should not be asked to create drafts for them.
    if (template.sourceKind === 'LEGAL_FOLDER_SYNC') {
      return res.status(410).json({
        code: 'DRAFT_CLIENT_SIDE',
        message:
          'This template is sourced from a connected Legal Folder. ' +
          'Drafts are created directly in the browser from the cached template file. ' +
          'Use the "Use" button on the Templates page to create a draft.',
        actions: [
          'Open the Templates page and click Use on this template.',
          'Ensure the Legal Folder is connected and synced so the file is cached.',
        ],
      });
    }

    if (!template.isActive) {
      return res.status(403).json({ error: 'This template is not active.' });
    }

    const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
    if (!isPrivileged && (template.status !== 'ACTIVE' || template.approvalStatus !== 'APPROVED')) {
      return res.status(403).json({ error: 'This template is not approved for use.' });
    }

    // SERVER_UPLOAD: check that a physical file is present on the server.
    const templateFilePath = template.path || template.filePath;
    if (!templateFilePath || !fs.existsSync(templateFilePath)) {
      return res.status(409).json({
        code: 'TEMPLATE_FILE_UNAVAILABLE',
        message: 'The template file is not available on the server.',
        actions: ['Upload the template file again or contact an administrator.'],
      });
    }

    const {
      documentTitle,
      counterparty,
      department,
      category,
      effectiveDate,
      legalRequestId,
      placeholderValues,
      notes,
    } = req.body;

    const defaultTitle = `${template.title || template.name} - Draft`;
    const rawTitle = (typeof documentTitle === 'string' && documentTitle.trim())
      ? documentTitle.trim()
      : defaultTitle;
    const safeTitle = sanitizeFilename(rawTitle);

    const year = new Date().getFullYear();
    const safeCategory = sanitizeFilename(category || template.category || 'General');
    const destRelDir = path.join('generated-drafts', String(year), safeCategory);
    const destAbsDir = path.join(__dirname, '../../uploads', destRelDir);

    if (!fs.existsSync(destAbsDir)) fs.mkdirSync(destAbsDir, { recursive: true });

    const ext = path.extname(templateFilePath) || `.${template.extension || 'docx'}`;
    const { filename: draftFilename, filePath: draftAbsPath } =
      resolveDraftFilename(destAbsDir, safeTitle, ext);

    fs.copyFileSync(templateFilePath, draftAbsPath);

    const mime = template.mimeType
      || (ext === '.pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    const displayPath = path
      .join('generated-drafts', String(year), safeCategory, draftFilename)
      .replace(/\\/g, '/');

    const doc = await Document.create({
      name: safeTitle,
      originalName: draftFilename,
      filename: draftFilename,
      path: draftAbsPath,
      mimetype: mime,
      size: fs.statSync(draftAbsPath).size,
      type: ext === '.pdf' ? 'pdf' : ext === '.doc' ? 'doc' : 'docx',
      uploadedBy: req.user._id,
      status: 'Draft',
      documentStage: 'DRAFT',
      description: notes?.trim() || `Draft created from template: ${template.title || template.name}`,
      legalRequest: legalRequestId || undefined,
      tags: [
        department ? `dept:${sanitizeFilename(department)}` : null,
        counterparty ? `counterparty:${sanitizeFilename(counterparty)}` : null,
        effectiveDate ? `effective:${effectiveDate}` : null,
      ].filter(Boolean),
      createdFromTemplate: true,
      templateId: template._id,
      templateTitle: template.title || template.name,
      templateVersionLabel: template.versionLabel || undefined,
      agreementFamily: template.agreementFamily || undefined,
      sourceTemplateFileName: template.originalFileName || undefined,
    });

    await Template.updateOne(
      { _id: template._id },
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
    );

    res.status(201).json({
      type: 'draft_created_from_template',
      message: 'Draft created successfully.',
      template: {
        id: template._id,
        title: template.title || template.name,
        agreementFamily: template.agreementFamily,
        versionLabel: template.versionLabel,
      },
      document: {
        id: doc._id,
        title: doc.name,
        fileName: draftFilename,
        stage: doc.documentStage,
        status: doc.status,
        displayPath,
        createdFromTemplate: doc.createdFromTemplate,
        templateId: doc.templateId,
      },
      warnings: [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/templates/:id/download ──────────────────────────────────────────
router.get('/:id/download', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    if (!template.path || !fs.existsSync(template.path)) {
      return res.status(404).json({ error: 'Template file not found on server.' });
    }

    const downloadName = `${template.name}.${template.extension || template.fileType || 'docx'}`;
    res.download(template.path, downloadName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/templates/:id ─────────────────────────────────────────────────
router.delete('/:id', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    // Archive rather than hard-delete if it has been used
    if (template.usageCount > 0) {
      await Template.updateOne({ _id: template._id }, { $set: { isActive: false, status: 'ARCHIVED' } });
      return res.json({ message: 'Template archived (it has usage history).' });
    }

    await Template.findByIdAndDelete(req.params.id);

    // Delete backing file only if it was an uploaded template and the file exists
    if (template.isUploaded && template.path && fs.existsSync(template.path)) {
      fs.unlinkSync(template.path);
    }

    res.json({ message: 'Template deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
