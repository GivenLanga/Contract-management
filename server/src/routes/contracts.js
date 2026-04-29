const express = require('express');
const { body, validationResult } = require('express-validator');
const Contract = require('../models/Contract');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/contracts
router.get('/', protect, async (req, res) => {
  try {
    const { status, type, search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (search) {
      filter.$or = [
        { title: new RegExp(search, 'i') },
        { contractId: new RegExp(search, 'i') },
        { 'parties.name': new RegExp(search, 'i') },
      ];
    }
    if (req.user.role === 'external') {
      filter['parties.email'] = req.user.email;
    }

    const contracts = await Contract.find(filter)
      .populate('createdBy', 'name email')
      .populate('assignedTo', 'name email')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Contract.countDocuments(filter);
    res.json({ contracts, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contracts/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const contract = await Contract.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('assignedTo', 'name email')
      .populate('approvers.user', 'name email')
      .populate('templateUsed', 'name type');
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    res.json({ contract });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contracts
router.post('/', protect, [
  body('title').trim().notEmpty().withMessage('Title required'),
  body('type').notEmpty().withMessage('Contract type required'),
], validate, async (req, res) => {
  try {
    const contract = await Contract.create({ ...req.body, createdBy: req.user._id });
    await contract.populate('createdBy', 'name email');

    await AuditLog.create({
      action: `Contract created: ${contract.title}`,
      category: 'contract',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'contract', id: contract._id, label: contract.title },
    });

    res.status(201).json({ contract });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/contracts/:id
router.put('/:id', protect, async (req, res) => {
  try {
    const contract = await Contract.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('createdBy', 'name email')
      .populate('assignedTo', 'name email');
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    await AuditLog.create({
      action: `Contract updated: ${contract.title}`,
      category: 'contract',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'contract', id: contract._id, label: contract.title },
    });

    res.json({ contract });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/contracts/:id/approve
router.put('/:id/approve', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, comment } = req.body;
    const contract = await Contract.findById(req.params.id).populate('createdBy', 'name email _id');
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    const approverEntry = contract.approvers.find((a) => a.user?.toString() === req.user._id.toString());
    if (approverEntry) {
      approverEntry.status = status;
      approverEntry.comment = comment;
      approverEntry.respondedAt = new Date();
    } else {
      contract.approvers.push({ user: req.user._id, role: req.user.role, status, comment, respondedAt: new Date() });
    }

    if (status === 'Approved') {
      contract.status = 'Approved';
      await Notification.create({
        recipient: contract.createdBy._id,
        type: 'approval_done',
        title: 'Contract Approved',
        message: `${req.user.name} approved "${contract.title}".`,
        relatedTo: { type: 'contract', id: contract._id, label: contract.title },
      });
    } else if (status === 'Rejected') {
      contract.status = 'Under Review';
    }

    await contract.save();
    res.json({ contract });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contracts/:id
router.delete('/:id', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const contract = await Contract.findByIdAndDelete(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    res.json({ message: 'Contract deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
