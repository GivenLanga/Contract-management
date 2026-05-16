'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const Template = require('../models/Template');
const Document = require('../models/Document');
const { protect, requireRole } = require('../middleware/auth');
const { templateUpload } = require('../middleware/upload');
const { discoverTemplates } = require('../services/templateDiscoveryService');
const { classify, cleanTitle, buildTags, displaySourceLabel, isSupportedExtension } = require('../services/templateClassifier');

const router = express.Router();

// ── Shared visibility filter ──────────────────────────────────────────────────

function visibilityFilter(user) {
  if (user.role === 'admin' || user.role === 'manager') {
    // Admins/managers see everything including PENDING_REVIEW templates
    return { isActive: true };
  }
  // Normal users see only active, approved templates
  return { isActive: true, status: 'ACTIVE', approvalStatus: 'APPROVED' };
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
    const [total, active, discovered, uploaded, pending] = await Promise.all([
      Template.countDocuments({ isActive: true }),
      Template.countDocuments({ isActive: true, status: 'ACTIVE' }),
      Template.countDocuments({ isDiscovered: true }),
      Template.countDocuments({ isUploaded: true }),
      Template.countDocuments({ isActive: true, status: 'PENDING_REVIEW' }),
    ]);

    // Most recent lastScannedAt across all templates
    const lastSynced = await Template.findOne({ lastScannedAt: { $exists: true } })
      .sort({ lastScannedAt: -1 })
      .select('lastScannedAt')
      .lean();

    res.json({
      totalTemplates: total,
      activeTemplates: active,
      discoveredTemplates: discovered,
      uploadedTemplates: uploaded,
      pendingReviewTemplates: pending,
      lastSync: lastSynced?.lastScannedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/templates/discover ─────────────────────────────────────────────
router.post('/discover', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    // candidates: template metadata objects the frontend collected from localStorage
    const candidates = Array.isArray(req.body.candidates) ? req.body.candidates : [];

    const summary = await discoverTemplates({
      candidates,
      userId: req.user._id,
    });

    res.json({
      ok: true,
      summary: {
        scanned: summary.scanned,
        imported: summary.imported,
        updated: summary.updated,
        skipped: summary.skipped,
        failed: summary.failed,
        warnings: summary.warnings,
      },
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
// Creates a working copy of a template as a Document draft.
// Phase 2 placeholder: the draft is created but the frontend Use modal now
// shows a "coming in Phase 2" message instead of this flow.
router.post('/:id/draft', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    // For metadata-only discovered templates (no server-side file), we cannot
    // create a physical draft copy yet — that is Phase 2 territory.
    if (!template.path || !fs.existsSync(template.path)) {
      return res.status(409).json({
        error: 'Draft creation from this template requires Phase 2 integration.',
        phase2: true,
      });
    }

    const { taskId, contractId, draftName } = req.body;
    const ext = path.extname(template.filename || template.originalFileName || '.docx');
    const newFilename = `draft_${uuidv4()}${ext}`;
    const uploadDir = path.join(__dirname, '../../uploads');

    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const newPath = path.join(uploadDir, newFilename);
    fs.copyFileSync(template.path, newPath);

    const docName = draftName || `${template.name} – Draft (${new Date().toLocaleDateString()})`;
    const doc = await Document.create({
      name: docName,
      originalName: `${template.name}${ext}`,
      filename: newFilename,
      path: newPath,
      mimetype: template.mimeType || (template.fileType === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      type: template.fileType === 'pdf' ? 'pdf' : 'docx',
      task: taskId || undefined,
      contract: contractId || undefined,
      uploadedBy: req.user._id,
      status: 'Draft',
      description: `Draft created from template: ${template.name}`,
    });

    await Template.updateOne({ _id: template._id }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } });

    res.status(201).json({ document: doc, downloadUrl: `/uploads/${newFilename}` });
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
