const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Template = require('../models/Template');
const Document = require('../models/Document');
const { protect, requireRole } = require('../middleware/auth');
const { templateUpload } = require('../middleware/upload');

const router = express.Router();

// GET /api/templates
router.get('/', protect, async (req, res) => {
  try {
    const { type, category } = req.query;
    const filter = { isActive: true };
    if (type) filter.type = type;
    if (category) filter.category = category;
    const templates = await Template.find(filter)
      .populate('createdBy', 'name')
      .sort({ name: 1 });
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/templates/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id).populate('createdBy', 'name');
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates/upload
router.post('/upload', protect, requireRole('admin', 'manager'), templateUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { name, type, description, category, fields } = req.body;
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const template = await Template.create({
      name,
      type,
      description,
      category: category || 'General',
      filename: req.file.filename,
      path: req.file.path,
      fileType: ext === 'pdf' ? 'pdf' : 'docx',
      fields: fields ? JSON.parse(fields) : [],
      createdBy: req.user._id,
    });
    res.status(201).json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates/:id/draft — create a draft document from template
router.post('/:id/draft', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    if (!fs.existsSync(template.path)) {
      return res.status(404).json({ error: 'Template file not found on server.' });
    }

    const { taskId, contractId, draftName } = req.body;

    // Copy template to uploads dir as a new draft
    const ext = path.extname(template.filename);
    const newFilename = `draft_${uuidv4()}${ext}`;
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const newPath = path.join(uploadDir, newFilename);
    fs.copyFileSync(template.path, newPath);

    const docName = draftName || `${template.name} - Draft (${new Date().toLocaleDateString()})`;
    const doc = await Document.create({
      name: docName,
      originalName: `${template.name}${ext}`,
      filename: newFilename,
      path: newPath,
      mimetype: template.fileType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      type: template.fileType === 'pdf' ? 'pdf' : 'docx',
      task: taskId || undefined,
      contract: contractId || undefined,
      uploadedBy: req.user._id,
      status: 'Draft',
      description: `Draft created from template: ${template.name}`,
    });

    template.usageCount += 1;
    await template.save();

    res.status(201).json({ document: doc, downloadUrl: `/uploads/${newFilename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/templates/:id/download — download original template
router.get('/:id/download', protect, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    if (!fs.existsSync(template.path)) {
      return res.status(404).json({ error: 'Template file not found.' });
    }
    res.download(template.path, `${template.name}.${template.fileType}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const template = await Template.findByIdAndDelete(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    if (fs.existsSync(template.path)) fs.unlinkSync(template.path);
    res.json({ message: 'Template deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
