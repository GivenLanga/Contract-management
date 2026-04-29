const express = require('express');
const path = require('path');
const fs = require('fs');
const Document = require('../models/Document');
const Notification = require('../models/Notification');
const Comment = require('../models/Comment');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const emailService = require('../services/emailService');
const { protect, requireRole } = require('../middleware/auth');
const { documentUpload } = require('../middleware/upload');

const router = express.Router();

// GET /api/documents
router.get('/', protect, async (req, res) => {
  try {
    const { status, contract, task, legalFolder, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (contract) filter.contract = contract;
    if (task) filter.task = task;
    if (legalFolder === 'true') filter.isInLegalFolder = true;

    const docs = await Document.find(filter)
      .populate('uploadedBy', 'name email')
      .populate('contract', 'title contractId')
      .populate('task', 'title')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Document.countDocuments(filter);
    res.json({ documents: docs, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id)
      .populate('uploadedBy', 'name email')
      .populate('contract', 'title contractId type')
      .populate('task', 'title')
      .populate('lockedBy', 'name');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    // Check lock access
    if (doc.isLocked) {
      const isOwner = doc.uploadedBy._id.toString() === req.user._id.toString();
      if (!isOwner && !['admin', 'manager'].includes(req.user.role)) {
        return res.status(423).json({ error: 'Document is locked. Password required.', locked: true });
      }
    }

    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/unlock
router.post('/:id/unlock', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).select('+lockedPassword');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    const isOwner = doc.uploadedBy.toString() === req.user._id.toString();
    if (isOwner) return res.json({ access: true });
    const valid = doc.verifyPassword(req.body.password);
    res.json({ access: valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/upload
router.post('/upload', protect, documentUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { name, contract, task, description, tags, distributeEmails } = req.body;
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const docType = ['pdf'].includes(ext) ? 'pdf' : ['docx', 'doc'].includes(ext) ? 'docx' : 'other';

    const doc = await Document.create({
      name: name || req.file.originalname,
      originalName: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      mimetype: req.file.mimetype,
      size: req.file.size,
      type: docType,
      contract: contract || undefined,
      task: task || undefined,
      description,
      tags: tags ? JSON.parse(tags) : [],
      uploadedBy: req.user._id,
      status: 'Draft',
    });

    await doc.populate('uploadedBy', 'name email');

    // Internal notification to managers
    const managers = await User.find({ role: { $in: ['admin', 'manager'] }, isActive: true });
    for (const m of managers) {
      if (m._id.toString() !== req.user._id.toString()) {
        await Notification.create({
          recipient: m._id,
          type: 'document_uploaded',
          title: 'Document Uploaded',
          message: `${req.user.name} uploaded: "${doc.name}"`,
          relatedTo: { type: 'document', id: doc._id, label: doc.name },
        });
      }
    }

    // Distribute via email if requested
    if (distributeEmails) {
      const emails = JSON.parse(distributeEmails);
      const recipients = emails.map((e) => ({ email: e, name: e }));
      emailService.sendDocumentUpload(recipients, doc, req.user).catch(console.error);
      doc.distributedTo = recipients.map((r) => ({ ...r, type: 'external', sentAt: new Date() }));
      await doc.save();
    }

    await AuditLog.create({
      action: `Document uploaded: ${doc.name}`,
      category: 'document',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      ipAddress: req.ip,
    });

    res.status(201).json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id/status
router.put('/:id/status', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status } = req.body;
    const doc = await Document.findById(req.params.id).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    doc.status = status;

    // Move to legal folder when approved
    if (status === 'Approved') {
      doc.isInLegalFolder = true;
      await Notification.create({
        recipient: doc.uploadedBy._id,
        type: 'document_approved',
        title: 'Document Approved',
        message: `Your document "${doc.name}" was approved and added to the Legal Folder.`,
        relatedTo: { type: 'document', id: doc._id, label: doc.name },
      });
    }

    if (status === 'Rejected') {
      await Notification.create({
        recipient: doc.uploadedBy._id,
        type: 'document_rejected',
        title: 'Document Rejected',
        message: `Your document "${doc.name}" was rejected. Check comments for details.`,
        relatedTo: { type: 'document', id: doc._id, label: doc.name },
      });
    }

    // Move to signing if approved
    if (status === 'Pending Signature') {
      doc.status = 'Pending Signature';
    }

    await doc.save();
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id/lock
router.put('/:id/lock', protect, async (req, res) => {
  try {
    const { password } = req.body;
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    const isOwner = doc.uploadedBy.toString() === req.user._id.toString();
    if (!isOwner && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    doc.setPassword(password);
    doc.lockedBy = req.user._id;
    doc.lockedAt = new Date();
    await doc.save();
    res.json({ message: 'Document locked.', isLocked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id/unlock-set
router.put('/:id/unlock-set', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    doc.isLocked = false;
    doc.lockedPassword = undefined;
    await doc.save();
    res.json({ message: 'Document unlocked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/view — serves file inline (for iframe embedding)
// Accepts ?token= query param because iframes can't set Authorization headers
router.get('/:id/view', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const token = req.query.token || (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).send('Unauthorized');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) return res.status(401).send('Invalid token');

    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).send('Document not found');
    if (!fs.existsSync(doc.path)) return res.status(404).send('File not found on server');

    res.setHeader('Content-Type', doc.mimetype || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    fs.createReadStream(doc.path).pipe(res);
  } catch (err) {
    res.status(500).send('Error loading document');
  }
});

// GET /api/documents/:id/download
router.get('/:id/download', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).select('+lockedPassword');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    if (doc.isLocked) {
      const isOwner = doc.uploadedBy.toString() === req.user._id.toString();
      if (!isOwner) return res.status(423).json({ error: 'Document locked.' });
    }

    if (!fs.existsSync(doc.path)) return res.status(404).json({ error: 'File not found on server.' });

    await AuditLog.create({
      action: `Document downloaded: ${doc.name}`,
      category: 'document',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      ipAddress: req.ip,
    });

    res.download(doc.path, doc.originalName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Comments
router.get('/:id/comments', protect, async (req, res) => {
  try {
    const comments = await Comment.find({ document: req.params.id })
      .populate('author', 'name email avatar')
      .populate('resolvedBy', 'name')
      .populate('replies.author', 'name email')
      .sort({ createdAt: 1 });
    res.json({ comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/comments', protect, async (req, res) => {
  try {
    const { text, position, isInternal } = req.body;
    const comment = await Comment.create({
      document: req.params.id,
      text,
      position,
      isInternal,
      author: req.user._id,
    });
    await comment.populate('author', 'name email avatar');
    res.status(201).json({ comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:docId/comments/:commentId/resolve', protect, async (req, res) => {
  try {
    const comment = await Comment.findByIdAndUpdate(
      req.params.commentId,
      { resolved: true, resolvedBy: req.user._id, resolvedAt: new Date() },
      { new: true }
    ).populate('author resolvedBy', 'name');
    res.json({ comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete document
router.delete('/:id', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (fs.existsSync(doc.path)) fs.unlinkSync(doc.path);
    await doc.deleteOne();
    res.json({ message: 'Document deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
