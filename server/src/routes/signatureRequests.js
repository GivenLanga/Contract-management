'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const SignatureRequest = require('../models/SignatureRequest');
const Signatory        = require('../models/Signatory');
const LegalRequest     = require('../models/LegalRequest');
const Notification     = require('../models/Notification');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/signature-requests?legalRequest=<id>
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.legalRequest) filter.legalRequest = req.query.legalRequest;
    if (req.query.status)       filter.status = req.query.status;

    const requests = await SignatureRequest.find(filter)
      .populate('legalRequest', 'title requestId status')
      .populate('document', 'name filename')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ signatureRequests: requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signature-requests/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const sigReq = await SignatureRequest.findById(req.params.id)
      .populate('legalRequest', 'title requestId status')
      .populate('document', 'name filename')
      .populate('createdBy', 'name email');
    if (!sigReq) return res.status(404).json({ error: 'Signature request not found.' });

    const signatories = await Signatory.find({ signatureRequest: req.params.id })
      .populate('user', 'name email');

    res.json({ signatureRequest: sigReq, signatories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signature-requests
router.post('/', protect, requireRole('admin', 'manager'), [
  body('legalRequest').notEmpty().withMessage('Legal request ID required'),
], validate, async (req, res) => {
  try {
    const lr = await LegalRequest.findById(req.body.legalRequest);
    if (!lr) return res.status(404).json({ error: 'Legal request not found.' });

    const sigReq = await SignatureRequest.create({
      legalRequest: req.body.legalRequest,
      document:     req.body.document,
      title:        req.body.title || lr.title,
      message:      req.body.message,
      createdBy:    req.user._id,
      expiresAt:    req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
    });

    await sigReq.populate('createdBy', 'name email');
    res.status(201).json({ signatureRequest: sigReq });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/signature-requests/:id/send — mark as SENT and notify signatories
router.put('/:id/send', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const sigReq = await SignatureRequest.findById(req.params.id).populate('legalRequest', 'title');
    if (!sigReq) return res.status(404).json({ error: 'Signature request not found.' });
    if (sigReq.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT requests can be sent.' });

    sigReq.status = 'SENT';
    sigReq.sentAt = new Date();
    await sigReq.save();

    // Notify all signatories
    const signatories = await Signatory.find({ signatureRequest: sigReq._id });
    await Promise.all(signatories.map(s => {
      if (!s.user) return;
      return Notification.create({
        recipient: s.user,
        type:      'general',
        title:     'Signature Required',
        message:   `You have been asked to sign: "${sigReq.title || sigReq.legalRequest?.title}"`,
        priority:  'high',
        relatedTo: { type: 'contract', id: sigReq.legalRequest?._id, label: sigReq.title },
      }).catch(err => console.error('[sig notify]', err));
    }));

    res.json({ signatureRequest: sigReq });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/signature-requests/:id/cancel
router.put('/:id/cancel', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const sigReq = await SignatureRequest.findByIdAndUpdate(
      req.params.id,
      { status: 'CANCELLED' },
      { new: true }
    );
    if (!sigReq) return res.status(404).json({ error: 'Signature request not found.' });
    res.json({ signatureRequest: sigReq });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
