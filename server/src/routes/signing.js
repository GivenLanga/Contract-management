const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Document = require('../models/Document');
const Signature = require('../models/Signature');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const emailService = require('../services/emailService');
const signingService = require('../services/signingService');
const idpService = require('../services/documentIdpService');
const pdfFinalizationService = require('../services/pdfFinalizationService');
const { buildSignatureEvidence } = require('../services/signatureEvidenceService');
const { protect } = require('../middleware/auth');
const signingMetadataSchema = require('../schemas/signingDocumentMetadata.schema.json');

const router = express.Router();

const generateSignerToken = () => crypto.randomBytes(32).toString('hex');

const canManageDocument = (doc, user) => {
  if (!doc || !user) return false;
  if (['admin', 'manager'].includes(user.role)) return true;
  const ownerId = doc.uploadedBy?._id || doc.uploadedBy;
  return ownerId?.toString() === user._id?.toString();
};

const fieldPosition = (field, bodyPosition) => {
  if (bodyPosition) {
    return {
      x: bodyPosition.x,
      y: bodyPosition.y,
      width: bodyPosition.width,
      height: bodyPosition.height,
      origin: bodyPosition.origin || field?.coordinateOrigin || 'normalized',
    };
  }
  if (!field) return undefined;
  return {
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
    origin: field.coordinateOrigin || 'normalized',
  };
};

const fieldBelongsToSigner = (field, signerEmail) =>
  Boolean(field) && (!field.assignedTo || field.assignedTo === signerEmail);

const signatureFieldTypes = new Set(['signature', 'initials']);

const applyFieldValues = ({ doc, signerEmail, fieldValues, signedAt }) => {
  if (!fieldValues || typeof fieldValues !== 'object') return;
  for (const [fid, fval] of Object.entries(fieldValues)) {
    const field = doc.signingFields.find((f) => f.id === fid);
    if (!field || signatureFieldTypes.has(field.type)) continue;
    if (!fieldBelongsToSigner(field, signerEmail)) continue;
    field.filled = true;
    field.filledBy = signerEmail;
    field.filledAt = signedAt;
    field.fieldValue = fval;
  }
};

// Validate a field value against its type constraints
const validateFieldValue = (field, value) => {
  const { type, fieldMeta } = field || {};
  if (!type || type === 'signature' || type === 'initials') return null;
  if (type === 'date') {
    if (value && isNaN(Date.parse(value))) return 'Invalid date value.';
    return null;
  }
  if (type === 'number') {
    const num = Number(value);
    if (isNaN(num)) return 'Field requires a numeric value.';
    if (fieldMeta?.min !== undefined && num < fieldMeta.min) return `Value must be at least ${fieldMeta.min}.`;
    if (fieldMeta?.max !== undefined && num > fieldMeta.max) return `Value must be at most ${fieldMeta.max}.`;
    return null;
  }
  if (type === 'text') {
    if (fieldMeta?.maxLength && String(value || '').length > fieldMeta.maxLength) return `Value exceeds max length of ${fieldMeta.maxLength}.`;
    return null;
  }
  if (type === 'checkbox') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') return 'Checkbox must be true or false.';
    return null;
  }
  if (type === 'radio' || type === 'dropdown') {
    const options = fieldMeta?.options || [];
    if (options.length && !options.includes(value)) return `Value must be one of: ${options.join(', ')}.`;
    return null;
  }
  return null;
};

// Determine whether it is a signer's turn (for sequential mode)
const isSignerTurn = (doc, signerEmail) => {
  if (doc.signingOrder !== 'sequential') return true;
  const sorted = [...(doc.signers || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const nextPending = sorted.find((s) => s.signingStatus !== 'signed');
  return !nextPending || nextPending.email === signerEmail;
};

// GET /api/signing/pending — docs awaiting signatures
router.get('/pending', protect, async (req, res) => {
  try {
    const filter = { status: 'Pending Signature' };
    if (req.user.role === 'external') {
      filter['signingFields.assignedTo'] = req.user.email;
    }
    const docs = await Document.find(filter)
      .populate('uploadedBy', 'name email')
      .populate('contract', 'title contractId')
      .sort({ updatedAt: -1 });
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/metadata-schema
router.get('/metadata-schema', protect, (req, res) => {
  res.json({ schema: signingMetadataSchema });
});

// ─── Public token-based signing ─────────────────────────────────────────────

// GET /api/signing/public/sign/:token — external signer retrieves their document info
router.get('/public/sign/:token', async (req, res) => {
  try {
    const doc = await Document.findOne({ 'signers.token': req.params.token })
      .populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Signing link is invalid or has expired.' });

    const signer = doc.signers.find((s) => s.token === req.params.token);
    if (!signer) return res.status(404).json({ error: 'Signing link not found.' });
    if (signer.signingStatus === 'signed') return res.status(409).json({ error: 'You have already signed this document.' });
    if (doc.status === 'Signed' || doc.status === 'Archived') {
      return res.status(409).json({ error: 'This document is no longer accepting signatures.' });
    }

    // Mark viewed
    if (!signer.viewedAt) {
      signer.viewedAt = new Date();
      await doc.save();
      await AuditLog.create({
        action: `Document viewed by external signer: ${doc.name}`,
        category: 'signature',
        performedByEmail: signer.email,
        target: { type: 'document', id: doc._id, label: doc.name },
        metadata: { signerEmail: signer.email, signerRole: signer.role },
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
    }

    // Return only what the external signer needs
    res.json({
      document: {
        _id: doc._id,
        name: doc.name,
        type: doc.type,
        status: doc.status,
        uploadedBy: doc.uploadedBy,
        signingOrder: doc.signingOrder,
        previewUrl: `/api/signing/public/document/${req.params.token}`,
      },
      signer: {
        email: signer.email,
        name: signer.name,
        role: signer.role,
        signingStatus: signer.signingStatus,
        viewedAt: signer.viewedAt,
      },
      fields: (doc.signingFields || []).filter(
        (f) => !f.assignedTo || f.assignedTo === signer.email
      ),
      isTurn: isSignerTurn(doc, signer.email),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/public/document/:token — streams source file for external signer preview
router.get('/public/document/:token', async (req, res) => {
  try {
    const doc = await Document.findOne({ 'signers.token': req.params.token });
    if (!doc) return res.status(404).send('Signing link is invalid or has expired.');

    const signer = doc.signers.find((s) => s.token === req.params.token);
    if (!signer) return res.status(404).send('Signer not found.');
    if (!fs.existsSync(doc.path)) return res.status(404).send('File not found on server.');

    res.setHeader('Content-Type', doc.mimetype || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    fs.createReadStream(doc.path).pipe(res);
  } catch {
    res.status(500).send('Error loading document');
  }
});

// POST /api/signing/public/sign/:token — external signer submits their signature
router.post('/public/sign/:token', async (req, res) => {
  try {
    const { signatureData, initialsData, method, fieldId, page, position, fieldValues, signatureTelemetry } = req.body;

    if (!signatureData) return res.status(400).json({ error: 'Signature data required.' });

    const doc = await Document.findOne({ 'signers.token': req.params.token })
      .populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Signing link is invalid or has expired.' });

    const signer = doc.signers.find((s) => s.token === req.params.token);
    if (!signer) return res.status(404).json({ error: 'Signer not found.' });
    if (signer.signingStatus === 'signed') return res.status(409).json({ error: 'You have already signed this document.' });
    if (doc.status !== 'Pending Signature') return res.status(400).json({ error: 'Document is not pending signature.' });

    if (!isSignerTurn(doc, signer.email)) {
      return res.status(403).json({ error: 'It is not your turn to sign. Please wait for prior signers to complete.' });
    }

    // Validate non-signature field values
    if (fieldValues && typeof fieldValues === 'object') {
      const errors = [];
      for (const [fid, fval] of Object.entries(fieldValues)) {
        const field = doc.signingFields.find((f) => f.id === fid);
        if (!field) continue;
        if (!fieldBelongsToSigner(field, signer.email)) {
          errors.push({ fieldId: fid, error: 'Field is not assigned to this signer.' });
          continue;
        }
        const err = validateFieldValue(field, fval);
        if (err) errors.push({ fieldId: fid, error: err });
      }
      if (errors.length) return res.status(422).json({ error: 'Field validation failed.', fieldErrors: errors });
    }

    const assignedField = doc.signingFields.find((f) => fieldId && f.id === fieldId && fieldBelongsToSigner(f, signer.email))
      || doc.signingFields.find((f) => f.assignedTo === signer.email && !f.filled)
      || doc.signingFields.find((f) => !f.assignedTo && !f.filled);
    if (fieldId && !assignedField) {
      return res.status(403).json({ error: 'Field is not assigned to this signer.' });
    }

    const existingSig = await Signature.findOne({ document: doc._id, signerEmail: signer.email });
    if (existingSig) return res.status(409).json({ error: 'You have already signed this document.' });

    const signedAt = new Date();
    const identityEvidence = buildSignatureEvidence({
      signatureData,
      initialsData,
      telemetry: signatureTelemetry,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      method,
      signedAt,
    });
    const effectivePosition = fieldPosition(assignedField, position);
    const effectivePage = Number(page ?? assignedField?.page ?? 1);

    const signature = await Signature.create({
      document: doc._id,
      signerEmail: signer.email,
      signerName: signer.name,
      signerRole: signer.role || assignedField?.role || 'Signatory',
      signatureData,
      initialsData,
      method: identityEvidence.normalizedMethod,
      signatureImageHash: identityEvidence.signatureImageHash,
      initialsImageHash: identityEvidence.initialsImageHash,
      fieldId: assignedField?.id || fieldId,
      page: effectivePage,
      position: effectivePosition,
      signedAt,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      evidence: identityEvidence.evidence,
    });

    // Mark field filled
    if (assignedField) {
      assignedField.filled = true;
      assignedField.filledBy = signer.email;
      assignedField.filledAt = signedAt;
    }

    applyFieldValues({ doc, signerEmail: signer.email, fieldValues, signedAt });

    // Update per-signer state
    signer.signingStatus = 'signed';
    signer.signedAt = signedAt;

    // Check if all required fields are now filled
    const allFilled = doc.signingFields.every((f) => f.filled || !f.required);
    if (allFilled) doc.status = 'Signed';

    await doc.save();

    // Notify the next signer in sequential mode
    if (!allFilled && doc.signingOrder === 'sequential') {
      const sorted = [...doc.signers].sort((a, b) => (a.order || 0) - (b.order || 0));
      const nextSigner = sorted.find((s) => s.signingStatus !== 'signed');
      if (nextSigner) {
        emailService.sendSigningRequest(nextSigner, doc, doc.uploadedBy, nextSigner.token).catch(console.error);
      }
    }

    // Finalize if all signed
    let finalization = null;
    if (allFilled && doc.type === 'pdf' && process.env.SIGNING_AUTO_FINALIZE !== 'false') {
      try {
        const signaturesForFinalization = await Signature.find({ document: doc._id }).sort({ signedAt: 1 });
        finalization = await pdfFinalizationService.finalizePdf({ doc, signatures: signaturesForFinalization, requestedBy: { email: signer.email } });
        doc.path = finalization.finalizedPath;
        doc.filename = path.basename(finalization.finalizedPath);
        doc.finalization = buildFinalizationPayload(finalization);
        await doc.save();
        emailService.sendSigningCompletion(doc.uploadedBy, doc, doc.signers).catch(console.error);
      } catch (e) {
        doc.finalization = { status: 'failed', errorMessage: e.message };
        await doc.save();
      }
    }

    await AuditLog.create({
      action: `Document signed via token: ${doc.name}`,
      category: 'signature',
      performedByEmail: signer.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { method: identityEvidence.normalizedMethod, fieldId: assignedField?.id || fieldId, auditHash: signature.auditHash },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.status(201).json({ signature, documentStatus: doc.status, allSigned: allFilled, finalization });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/prepare - run IDP detection and attach signing fields
router.post('/:docId/prepare', protect, async (req, res) => {
  try {
    const { signers = [], strategy = {} } = req.body;
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    const result = await idpService.prepareSigningDocument({ doc, signers, strategy });
    if (result.metadata.normalizedFromOffice && result.metadata.normalizedPdfPath) {
      doc.path = result.metadata.normalizedPdfPath;
      doc.filename = path.basename(result.metadata.normalizedPdfPath);
      doc.mimetype = 'application/pdf';
      doc.type = 'pdf';
    }
    doc.signingFields = result.fields;
    doc.signers = (signers || []).map((signer, index) => ({
      email: signer.email,
      name: signer.name,
      role: signer.role,
      userId: signer.userId || undefined,
      order: index + 1,
      authMethod: signer.authMethod || 'email',
      signingStatus: 'not_signed',
    }));
    if (req.body.signingOrder) doc.signingOrder = req.body.signingOrder;
    doc.signingPreparation = { ...result.metadata, preparedBy: req.user._id };
    await doc.save();

    await AuditLog.create({
      action: `Signing fields prepared: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { detectionVersion: result.metadata.detectionVersion, fieldCount: result.fields.length, reviewRequired: result.metadata.reviewRequired, sourceFileHash: result.metadata.sourceFileHash },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ document: doc, fields: result.fields, preparation: doc.signingPreparation });
  } catch (err) {
    try {
      await Document.findByIdAndUpdate(req.params.docId, { 'signingPreparation.status': 'failed', 'signingPreparation.errorMessage': err.message });
    } catch {
      // Best-effort failure metadata only.
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/:docId/signatures
router.get('/:docId/signatures', protect, async (req, res) => {
  try {
    const sigs = await Signature.find({ document: req.params.docId })
      .populate('signedBy', 'name email')
      .sort({ signedAt: 1 });
    res.json({ signatures: sigs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const buildFinalizationPayload = (result) => ({
  status: 'finalized',
  finalizedAt: result.finalizedAt,
  finalizedBy: result.finalizedBy,
  finalizedFilename: result.finalizedFilename,
  finalizedPath: result.finalizedPath,
  flattenedHash: result.flattenedHash,
  finalPdfHash: result.finalPdfHash,
  byteLength: result.byteLength,
  digitalSignatureStatus: result.digitalSignature.status,
  certificateFingerprint: result.digitalSignature.certificateFingerprint,
  signatureStandard: result.digitalSignature.status === 'signed' ? 'PAdES-compatible CMS detached signature' : undefined,
  errorMessage: result.digitalSignature.status === 'failed' ? result.digitalSignature.reason : undefined,
});

// POST /api/signing/:docId/sign
router.post('/:docId/sign', protect, async (req, res) => {
  try {
    const { signatureData, initialsData, method, fieldId, page, position, signerRole, fieldValues, signatureTelemetry } = req.body;

    if (!signatureData) return res.status(400).json({ error: 'Signature data required.' });

    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status !== 'Pending Signature') return res.status(400).json({ error: 'Document is not pending signature.' });

    // Sequential turn-gating
    if (!isSignerTurn(doc, req.user.email)) {
      return res.status(403).json({ error: 'It is not your turn to sign. Please wait for prior signers to complete.' });
    }

    const assignedField = doc.signingFields.find((f) => fieldId && f.id === fieldId && fieldBelongsToSigner(f, req.user.email))
      || doc.signingFields.find((f) => f.assignedTo === req.user.email && !f.filled)
      || doc.signingFields.find((f) => !f.assignedTo && !f.filled);
    if ((!assignedField || !fieldBelongsToSigner(assignedField, req.user.email)) && req.user.role === 'external') {
      return res.status(403).json({ error: 'You are not authorized to sign this document.' });
    }

    // Validate non-signature field values
    if (fieldValues && typeof fieldValues === 'object') {
      const errors = [];
      for (const [fid, fval] of Object.entries(fieldValues)) {
        const field = doc.signingFields.find((f) => f.id === fid);
        if (!field) continue;
        if (!fieldBelongsToSigner(field, req.user.email)) {
          errors.push({ fieldId: fid, error: 'Field is not assigned to this signer.' });
          continue;
        }
        const err = validateFieldValue(field, fval);
        if (err) errors.push({ fieldId: fid, error: err });
      }
      if (errors.length) return res.status(422).json({ error: 'Field validation failed.', fieldErrors: errors });
    }

    const existingSig = await Signature.findOne({ document: doc._id, signerEmail: req.user.email });
    if (existingSig) return res.status(400).json({ error: 'You have already signed this document.' });

    const signedAt = new Date();
    const identityEvidence = buildSignatureEvidence({ signatureData, initialsData, telemetry: signatureTelemetry, ipAddress: req.ip, userAgent: req.get('User-Agent'), method, signedAt });
    const effectivePosition = fieldPosition(assignedField, position);
    const effectivePage = Number(page ?? assignedField?.page ?? 1);

    let signedFilename = doc.filename;
    if (process.env.SIGNING_EMBED_ON_EACH_SIGN === 'true' && doc.type === 'pdf' && fs.existsSync(doc.path)) {
      try {
        const result = await signingService.embedSignatureInPDF(doc.path, signatureData, {
          page: Math.max(0, effectivePage - 1),
          x: effectivePosition?.x || 100,
          y: effectivePosition?.y || 200,
          width: effectivePosition?.width || 200,
          height: effectivePosition?.height || 80,
          initialsBase64: initialsData,
          signerName: req.user.name,
          signerEmail: req.user.email,
          signedAt,
        });
        signedFilename = result.signedFilename;
        doc.path = result.signedPath;
        doc.filename = path.basename(result.signedPath);
      } catch (e) {
        console.error('PDF signing error:', e.message);
      }
    }

    const signature = await Signature.create({
      document: doc._id,
      signedBy: req.user._id,
      signerEmail: req.user.email,
      signerName: req.user.name,
      signerRole: signerRole || assignedField?.role || 'Signatory',
      signatureData,
      initialsData,
      method: identityEvidence.normalizedMethod,
      signatureImageHash: identityEvidence.signatureImageHash,
      initialsImageHash: identityEvidence.initialsImageHash,
      fieldId: assignedField?.id || fieldId,
      page: effectivePage,
      position: effectivePosition,
      signedAt,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      evidence: identityEvidence.evidence,
    });

    // Mark field filled
    if (assignedField) {
      assignedField.filled = true;
      assignedField.filledBy = req.user.email;
      assignedField.filledAt = signedAt;
    }

    applyFieldValues({ doc, signerEmail: req.user.email, fieldValues, signedAt });

    // Update per-signer state
    const signerRecord = doc.signers.find((s) => s.email === req.user.email || s.userId?.toString() === req.user._id?.toString());
    if (signerRecord) {
      signerRecord.signingStatus = 'signed';
      signerRecord.signedAt = signedAt;
    }

    const allFilled = doc.signingFields.every((f) => f.filled || !f.required);
    if (allFilled) doc.status = 'Signed';

    await doc.save();

    // Notify next signer for sequential mode
    if (!allFilled && doc.signingOrder === 'sequential') {
      const sorted = [...doc.signers].sort((a, b) => (a.order || 0) - (b.order || 0));
      const nextSigner = sorted.find((s) => s.signingStatus !== 'signed');
      if (nextSigner) {
        emailService.sendSigningRequest(nextSigner, doc, req.user, nextSigner.token).catch(console.error);
      }
    }

    let finalization = null;
    if (allFilled && doc.type === 'pdf' && process.env.SIGNING_AUTO_FINALIZE !== 'false') {
      try {
        const signaturesForFinalization = await Signature.find({ document: doc._id }).sort({ signedAt: 1 });
        finalization = await pdfFinalizationService.finalizePdf({ doc, signatures: signaturesForFinalization, requestedBy: req.user });
        doc.path = finalization.finalizedPath;
        doc.filename = path.basename(finalization.finalizedPath);
        doc.finalization = buildFinalizationPayload(finalization);
        await doc.save();
        await AuditLog.create({
          action: `Signed PDF finalized: ${doc.name}`,
          category: 'signature',
          performedBy: req.user._id,
          performedByEmail: req.user.email,
          target: { type: 'document', id: doc._id, label: doc.name },
          metadata: { finalPdfHash: finalization.finalPdfHash, flattenedHash: finalization.flattenedHash, digitalSignatureStatus: finalization.digitalSignature.status },
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
        });
        emailService.sendSigningCompletion(doc.uploadedBy, doc, doc.signers).catch(console.error);
      } catch (error) {
        doc.finalization = { status: 'failed', errorMessage: error.message };
        await doc.save();
      }
    }

    if (doc.uploadedBy._id.toString() !== req.user._id.toString()) {
      await Notification.create({
        recipient: doc.uploadedBy._id,
        type: 'signing_completed',
        title: 'Document Signed',
        message: `${req.user.name} signed "${doc.name}"`,
        relatedTo: { type: 'signature', id: signature._id, label: doc.name },
        priority: 'high',
      });
      emailService.sendSigningConfirmation(doc.uploadedBy, doc, req.user, true).catch(console.error);
    }

    if (req.user.role !== 'external') {
      emailService.sendSigningConfirmation(req.user, doc, req.user, false).catch(console.error);
    }

    await AuditLog.create({
      action: `Document signed: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { method: identityEvidence.normalizedMethod, fieldId: assignedField?.id || fieldId, page: effectivePage, auditHash: signature.auditHash, evidence: identityEvidence.evidence },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.status(201).json({ signature, documentStatus: doc.status, allSigned: allFilled, signedFilename, finalization });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/request — manager sends signing request and assigns tokens
router.post('/:docId/request', protect, async (req, res) => {
  try {
    const { signers, fields, signingOrder, pageMetrics, message } = req.body;

    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    doc.status = 'Pending Signature';
    doc.signingOrder = signingOrder || doc.signingOrder || 'parallel';
    doc.signers = (signers || []).map((signer, index) => ({
      email: signer.email,
      name: signer.name,
      role: signer.role,
      userId: signer.userId || undefined,
      order: index + 1,
      authMethod: signer.authMethod || 'email',
      token: generateSignerToken(),
      signingStatus: 'not_signed',
      sentAt: new Date(),
    }));

    let preparationForRequest = null;
    if ((!fields || fields.length === 0) && (!doc.signingFields || doc.signingFields.length === 0)) {
      preparationForRequest = await idpService.prepareSigningDocument({ doc, signers: signers || [], strategy: {} });
      if (preparationForRequest.metadata.normalizedFromOffice && preparationForRequest.metadata.normalizedPdfPath) {
        doc.path = preparationForRequest.metadata.normalizedPdfPath;
        doc.filename = path.basename(preparationForRequest.metadata.normalizedPdfPath);
        doc.mimetype = 'application/pdf';
        doc.type = 'pdf';
      }
      doc.signingFields = preparationForRequest.fields;
    } else if (fields && fields.length > 0) {
      doc.signingFields = fields.map((field, index) => ({
        ...field,
        id: field.id || `field_${index}`,
        page: field.page || 1,
        coordinateOrigin: field.coordinateOrigin || 'normalized',
        source: field.source || 'manual',
        confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 1,
        required: field.required !== false,
        filled: false,
      }));
    }
    doc.signingPreparation = {
      ...(preparationForRequest?.metadata || (doc.signingPreparation?.toObject ? doc.signingPreparation.toObject() : doc.signingPreparation || {})),
      status: 'prepared',
      preparedAt: new Date(),
      preparedBy: req.user._id,
      strategy: preparationForRequest?.metadata?.strategy || { source: fields?.length ? 'manual-envelope' : 'prepared-fields' },
      pageMetrics: pageMetrics || preparationForRequest?.metadata?.pageMetrics || doc.signingPreparation?.pageMetrics,
      diagnostics: {
        ...(Array.isArray(preparationForRequest?.metadata?.diagnostics)
          ? { idp: preparationForRequest.metadata.diagnostics }
          : doc.signingPreparation?.diagnostics || {}),
        message: message || undefined,
        fieldCount: doc.signingFields?.length || 0,
      },
    };
    await doc.save();

    // For sequential mode, only send to the first signer. For parallel, send to all.
    const signersToNotify = doc.signingOrder === 'sequential'
      ? [doc.signers[0]].filter(Boolean)
      : doc.signers;

    for (const signer of signersToNotify) {
      if (signer.userId) {
        await Notification.create({
          recipient: signer.userId,
          type: 'signing_request',
          title: 'Signature Required',
          message: `Your signature is required on "${doc.name}"`,
          relatedTo: { type: 'document', id: doc._id, label: doc.name },
          priority: 'high',
        });
      }
      emailService.sendSigningRequest(signer, doc, req.user, signer.token).catch(console.error);
    }

    await AuditLog.create({
      action: `Signing request sent: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { signerCount: doc.signers.length, signingOrder: doc.signingOrder },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ message: 'Signing requests sent.', document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/reject — a signer declines to sign
router.post('/:docId/reject', protect, async (req, res) => {
  try {
    const { reason } = req.body;
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status !== 'Pending Signature') return res.status(400).json({ error: 'Document is not pending signature.' });

    const signerRecord = doc.signers.find((s) => s.email === req.user.email || s.userId?.toString() === req.user._id?.toString());
    if (!signerRecord && req.user.role === 'external') {
      return res.status(403).json({ error: 'You are not a signer on this document.' });
    }
    if (signerRecord) {
      signerRecord.signingStatus = 'rejected';
      signerRecord.rejectionReason = reason || 'No reason provided.';
    }
    doc.status = 'Declined';
    await doc.save();

    await Notification.create({
      recipient: doc.uploadedBy._id,
      type: 'signing_rejected',
      title: 'Signing Rejected',
      message: `${req.user.name} declined to sign "${doc.name}"`,
      relatedTo: { type: 'document', id: doc._id, label: doc.name },
      priority: 'high',
    });

    await AuditLog.create({
      action: `Document signing rejected: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { reason: reason || 'No reason provided.' },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ message: 'Signing declined.', document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/reject-token/:token — external signer rejects via token
router.post('/reject-token/:token', async (req, res) => {
  try {
    const { reason } = req.body;
    const doc = await Document.findOne({ 'signers.token': req.params.token }).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Signing link is invalid or has expired.' });

    const signer = doc.signers.find((s) => s.token === req.params.token);
    if (!signer) return res.status(404).json({ error: 'Signer not found.' });

    signer.signingStatus = 'rejected';
    signer.rejectionReason = reason || 'No reason provided.';
    doc.status = 'Declined';
    await doc.save();

    await Notification.create({
      recipient: doc.uploadedBy._id,
      type: 'signing_rejected',
      title: 'Signing Rejected',
      message: `${signer.name || signer.email} declined to sign "${doc.name}"`,
      relatedTo: { type: 'document', id: doc._id, label: doc.name },
      priority: 'high',
    });

    await AuditLog.create({
      action: `Document signing rejected via token: ${doc.name}`,
      category: 'signature',
      performedByEmail: signer.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { reason: reason || 'No reason provided.' },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ message: 'Signing declined.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/remind/:signerEmail — send a reminder to a specific signer
router.post('/:docId/remind/:signerEmail', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    const signer = doc.signers.find((s) => s.email === req.params.signerEmail);
    if (!signer) return res.status(404).json({ error: 'Signer not found.' });
    if (signer.signingStatus === 'signed') return res.status(400).json({ error: 'Signer has already signed.' });

    // Rate-limit reminders to once per 24 hours
    if (signer.lastReminderAt) {
      const hoursSinceLast = (Date.now() - new Date(signer.lastReminderAt).getTime()) / 3_600_000;
      if (hoursSinceLast < 24) {
        return res.status(429).json({ error: `A reminder was already sent ${Math.floor(hoursSinceLast)}h ago. Please wait before sending another.` });
      }
    }

    signer.lastReminderAt = new Date();
    await doc.save();

    await emailService.sendSigningReminder(signer, doc, req.user, signer.token);

    await AuditLog.create({
      action: `Signing reminder sent to ${signer.email}: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { signerEmail: signer.email },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ message: `Reminder sent to ${signer.email}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/:docId/metadata
router.get('/:docId/metadata', protect, async (req, res) => {
  try {
    const [doc, signatures, auditLogs] = await Promise.all([
      Document.findById(req.params.docId).populate('uploadedBy', 'name email'),
      Signature.find({ document: req.params.docId }).sort({ signedAt: 1 }),
      AuditLog.find({ 'target.id': req.params.docId }).sort({ createdAt: 1 }),
    ]);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    res.json({
      metadata: {
        documentId: doc._id.toString(),
        version: doc.version,
        sourceFileHash: doc.signingPreparation?.sourceFileHash || doc.finalization?.finalPdfHash || '',
        status: doc.finalization?.status === 'finalized'
          ? 'finalized'
          : doc.signingPreparation?.status === 'needs_review'
            ? 'needs_review'
            : doc.status === 'Signed' ? 'signed'
              : doc.status === 'Pending Signature' ? 'pending'
                : doc.status === 'Declined' ? 'declined' : 'draft',
        fields: doc.signingFields || [],
        routing: {
          mode: doc.signingOrder || 'parallel',
          signers: doc.signers || [],
        },
        auditTrail: auditLogs.map((log) => ({
          eventId: log._id.toString(),
          type: log.action,
          actorEmail: log.performedByEmail,
          timestamp: log.createdAt,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent,
          evidence: log.metadata?.evidence,
        })),
        signatures,
        preparation: doc.signingPreparation,
        finalization: doc.finalization,
      },
      schema: signingMetadataSchema,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/finalize
router.post('/:docId/finalize', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    const signatures = await Signature.find({ document: doc._id }).sort({ signedAt: 1 });
    const requiredFields = doc.signingFields?.filter((f) => f.required) || [];
    const allRequiredSigned = requiredFields.every((f) => f.filled);
    if (!allRequiredSigned && req.body.allowIncomplete !== true) {
      return res.status(409).json({ error: 'Required signing fields are not complete.' });
    }

    const result = await pdfFinalizationService.finalizePdf({ doc, signatures, requestedBy: req.user });
    doc.path = result.finalizedPath;
    doc.filename = path.basename(result.finalizedPath);
    doc.status = 'Signed';
    doc.finalization = buildFinalizationPayload(result);
    await doc.save();

    await AuditLog.create({
      action: `Signed PDF finalized: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { finalPdfHash: result.finalPdfHash, flattenedHash: result.flattenedHash, digitalSignatureStatus: result.digitalSignature.status, certificateFingerprint: result.digitalSignature.certificateFingerprint },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ document: doc, finalization: result });
  } catch (err) {
    try {
      await Document.findByIdAndUpdate(req.params.docId, { 'finalization.status': 'failed', 'finalization.errorMessage': err.message });
    } catch {
      // Best-effort failure metadata only.
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/:docId/audit-trail
router.get('/:docId/audit-trail', protect, async (req, res) => {
  try {
    const [signatures, auditLogs] = await Promise.all([
      Signature.find({ document: req.params.docId })
        .populate('signedBy', 'name email')
        .sort({ signedAt: 1 }),
      AuditLog.find({ 'target.id': req.params.docId })
        .populate('performedBy', 'name email')
        .sort({ createdAt: 1 }),
    ]);
    res.json({ signatures, auditLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
