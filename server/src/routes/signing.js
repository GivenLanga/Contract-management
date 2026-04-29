const express = require('express');
const path = require('path');
const fs = require('fs');
const Document = require('../models/Document');
const Signature = require('../models/Signature');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const emailService = require('../services/emailService');
const signingService = require('../services/signingService');
const idpService = require('../services/documentIdpService');
const pdfFinalizationService = require('../services/pdfFinalizationService');
const { buildSignatureEvidence } = require('../services/signatureEvidenceService');
const { protect } = require('../middleware/auth');
const signingMetadataSchema = require('../schemas/signingDocumentMetadata.schema.json');

const router = express.Router();

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
      origin: bodyPosition.origin || field?.coordinateOrigin || 'top-left',
    };
  }
  if (!field) return undefined;
  return {
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
    origin: field.coordinateOrigin || 'top-left',
  };
};

// GET /api/signing/pending — docs awaiting signatures
router.get('/pending', protect, async (req, res) => {
  try {
    const filter = { status: 'Pending Signature' };
    if (req.user.role === 'external') {
      // External users only see docs assigned to their email
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

// GET /api/signing/metadata-schema - schema for IDP metadata and audit payloads
router.get('/metadata-schema', protect, (req, res) => {
  res.json({ schema: signingMetadataSchema });
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
    }));
    if (req.body.signingOrder) doc.signingOrder = req.body.signingOrder;
    doc.signingPreparation = {
      ...result.metadata,
      preparedBy: req.user._id,
    };
    if (doc.status === 'Draft' || doc.status === 'Approved') {
      doc.status = 'Pending Signature';
    }
    await doc.save();

    await AuditLog.create({
      action: `Signing fields prepared: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        detectionVersion: result.metadata.detectionVersion,
        fieldCount: result.fields.length,
        reviewRequired: result.metadata.reviewRequired,
        sourceFileHash: result.metadata.sourceFileHash,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      document: doc,
      fields: result.fields,
      preparation: doc.signingPreparation,
    });
  } catch (err) {
    try {
      await Document.findByIdAndUpdate(req.params.docId, {
        'signingPreparation.status': 'failed',
        'signingPreparation.errorMessage': err.message,
      });
    } catch {}
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/:docId/signatures — all signatures for a doc
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

// POST /api/signing/:docId/sign
router.post('/:docId/sign', protect, async (req, res) => {
  try {
    const { signatureData, initialsData, method, fieldId, page, position, signerRole, signatureTelemetry } = req.body;

    if (!signatureData) return res.status(400).json({ error: 'Signature data required.' });

    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status !== 'Pending Signature') {
      return res.status(400).json({ error: 'Document is not pending signature.' });
    }

    // Check if this signer is authorized
    const assignedField = doc.signingFields.find((f) => fieldId && f.id === fieldId)
      || doc.signingFields.find((f) => f.assignedTo === req.user.email && !f.filled)
      || doc.signingFields.find((f) => !f.assignedTo && !f.filled);
    const fieldBelongsToSigner = !assignedField?.assignedTo || assignedField.assignedTo === req.user.email;
    if ((!assignedField || !fieldBelongsToSigner) && req.user.role === 'external') {
      return res.status(403).json({ error: 'You are not authorized to sign this document.' });
    }

    // Check for duplicate signature
    const existingSig = await Signature.findOne({
      document: doc._id,
      signerEmail: req.user.email,
    });
    if (existingSig) {
      return res.status(400).json({ error: 'You have already signed this document.' });
    }

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

    // Optional legacy embed. By default the visible PDF is produced once at finalization.
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

        // Update document path to signed version
        doc.path = result.signedPath;
        doc.filename = path.basename(result.signedPath);
      } catch (e) {
        console.error('PDF signing error:', e.message);
      }
    }

    // Record signature
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

    // Mark signing field as filled
    if (assignedField) {
      assignedField.filled = true;
      assignedField.filledBy = req.user.email;
      assignedField.filledAt = signedAt;
    }

    // Check if all fields are signed
    const allFilled = doc.signingFields.every((f) => f.filled || !f.required);
    if (allFilled) {
      doc.status = 'Signed';
    }

    await doc.save();

    let finalization = null;
    if (allFilled && doc.type === 'pdf' && process.env.SIGNING_AUTO_FINALIZE !== 'false') {
      try {
        const signaturesForFinalization = await Signature.find({ document: doc._id }).sort({ signedAt: 1 });
        finalization = await pdfFinalizationService.finalizePdf({
          doc,
          signatures: signaturesForFinalization,
          requestedBy: req.user,
        });
        doc.path = finalization.finalizedPath;
        doc.filename = path.basename(finalization.finalizedPath);
        doc.finalization = {
          status: 'finalized',
          finalizedAt: finalization.finalizedAt,
          finalizedBy: req.user._id,
          finalizedFilename: finalization.finalizedFilename,
          finalizedPath: finalization.finalizedPath,
          flattenedHash: finalization.flattenedHash,
          finalPdfHash: finalization.finalPdfHash,
          byteLength: finalization.byteLength,
          digitalSignatureStatus: finalization.digitalSignature.status,
          certificateFingerprint: finalization.digitalSignature.certificateFingerprint,
          signatureStandard: finalization.digitalSignature.status === 'signed' ? 'PAdES-compatible CMS detached signature' : undefined,
          errorMessage: finalization.digitalSignature.status === 'failed' ? finalization.digitalSignature.reason : undefined,
        };
        await doc.save();

        await AuditLog.create({
          action: `Signed PDF finalized: ${doc.name}`,
          category: 'signature',
          performedBy: req.user._id,
          performedByEmail: req.user.email,
          target: { type: 'document', id: doc._id, label: doc.name },
          metadata: {
            finalPdfHash: finalization.finalPdfHash,
            flattenedHash: finalization.flattenedHash,
            digitalSignatureStatus: finalization.digitalSignature.status,
          },
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
        });
      } catch (error) {
        doc.finalization = {
          status: 'failed',
          errorMessage: error.message,
        };
        await doc.save();
      }
    }

    // Notify document owner
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

    // Notify signer (external email confirmation)
    if (req.user.role !== 'external') {
      emailService.sendSigningConfirmation(req.user, doc, req.user, false).catch(console.error);
    }

    await AuditLog.create({
      action: `Document signed: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        method: identityEvidence.normalizedMethod,
        fieldId: assignedField?.id || fieldId,
        page: effectivePage,
        auditHash: signature.auditHash,
        evidence: identityEvidence.evidence,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.status(201).json({
      signature,
      documentStatus: doc.status,
      allSigned: allFilled,
      signedFilename,
      finalization,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/request — manager sends signing request
router.post('/:docId/request', protect, async (req, res) => {
  try {
    const { signers, fields, signingOrder } = req.body;

    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    doc.status = 'Pending Signature';
    doc.signingOrder = signingOrder || doc.signingOrder || 'parallel';
    doc.signers = (signers || []).map((signer, index) => ({
      email: signer.email,
      name: signer.name,
      role: signer.role,
      userId: signer.userId || undefined,
      order: index + 1,
      authMethod: signer.authMethod || 'email',
    }));
    if (fields && fields.length > 0) {
      doc.signingFields = fields.map((field, index) => ({
        ...field,
        id: field.id || `field_${index}`,
        page: field.page || 1,
        coordinateOrigin: field.coordinateOrigin || 'top-left',
        source: field.source || 'manual',
        confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 1,
        required: field.required !== false,
        filled: false,
      }));
    }
    await doc.save();

    // Send signing requests to each signer
    for (const signer of signers || []) {
      await Notification.create({
        recipient: signer.userId || undefined,
        type: 'signing_request',
        title: 'Signature Required',
        message: `Your signature is required on "${doc.name}"`,
        relatedTo: { type: 'document', id: doc._id, label: doc.name },
        priority: 'high',
      });
      emailService.sendSigningRequest(signer, doc, req.user).catch(console.error);
    }

    res.json({ message: 'Signing requests sent.', document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/:docId/metadata - metadata, fields, audit, and finalization state
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
            : doc.status === 'Signed'
              ? 'signed'
              : doc.status === 'Pending Signature'
                ? 'pending'
                : 'draft',
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

// POST /api/signing/:docId/finalize - flatten, hash, and optionally X.509-sign the PDF
router.post('/:docId/finalize', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    const signatures = await Signature.find({ document: doc._id }).sort({ signedAt: 1 });
    const requiredFields = doc.signingFields?.filter((field) => field.required) || [];
    const allRequiredSigned = requiredFields.every((field) => field.filled);
    if (!allRequiredSigned && req.body.allowIncomplete !== true) {
      return res.status(409).json({ error: 'Required signing fields are not complete.' });
    }

    const result = await pdfFinalizationService.finalizePdf({
      doc,
      signatures,
      requestedBy: req.user,
    });

    doc.path = result.finalizedPath;
    doc.filename = path.basename(result.finalizedPath);
    doc.status = 'Signed';
    doc.finalization = {
      status: 'finalized',
      finalizedAt: result.finalizedAt,
      finalizedBy: req.user._id,
      finalizedFilename: result.finalizedFilename,
      finalizedPath: result.finalizedPath,
      flattenedHash: result.flattenedHash,
      finalPdfHash: result.finalPdfHash,
      byteLength: result.byteLength,
      digitalSignatureStatus: result.digitalSignature.status,
      certificateFingerprint: result.digitalSignature.certificateFingerprint,
      signatureStandard: result.digitalSignature.status === 'signed' ? 'PAdES-compatible CMS detached signature' : undefined,
      errorMessage: result.digitalSignature.status === 'failed' ? result.digitalSignature.reason : undefined,
    };
    await doc.save();

    await AuditLog.create({
      action: `Signed PDF finalized: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        finalPdfHash: result.finalPdfHash,
        flattenedHash: result.flattenedHash,
        digitalSignatureStatus: result.digitalSignature.status,
        certificateFingerprint: result.digitalSignature.certificateFingerprint,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ document: doc, finalization: result });
  } catch (err) {
    try {
      await Document.findByIdAndUpdate(req.params.docId, {
        'finalization.status': 'failed',
        'finalization.errorMessage': err.message,
      });
    } catch {}
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
