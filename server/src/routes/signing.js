const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const multer = require('multer');
const Document = require('../models/Document');
const Signature = require('../models/Signature');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const emailService = require('../services/emailService');
const signingService = require('../services/signingService');
const idpService = require('../services/documentIdpService');
const pdfFinalizationService = require('../services/pdfFinalizationService');
const completionCertificateService = require('../services/completionCertificateService');
const trustedTimestampService = require('../services/trustedTimestampService');
const signingMediaEvidenceService = require('../services/signingMediaEvidenceService');
const ronNotarizationService = require('../services/ronNotarizationService');
const {
  buildSignatureEvidence,
  buildPlatformAttestation,
  ensurePlatformAttestationConfigured,
  normalizeSignatureMethod,
} = require('../services/signatureEvidenceService');
const { protect } = require('../middleware/auth');
const signingMetadataSchema = require('../schemas/signingDocumentMetadata.schema.json');

const router = express.Router();

const generateSignerToken = () => crypto.randomBytes(32).toString('hex');
const SIGNER_TOKEN_RE = /^[a-f0-9]{64}$/i;
const parsedSigningTokenTtlDays = Number(process.env.SIGNING_TOKEN_TTL_DAYS);
const SIGNING_TOKEN_TTL_DAYS = Number.isFinite(parsedSigningTokenTtlDays) && parsedSigningTokenTtlDays > 0
  ? parsedSigningTokenTtlDays
  : 30;
const parsedMaxSignatureImageBytes = Number(process.env.MAX_SIGNATURE_IMAGE_BYTES);
const MAX_SIGNATURE_IMAGE_BYTES = Number.isFinite(parsedMaxSignatureImageBytes)
  ? parsedMaxSignatureImageBytes
  : 2 * 1024 * 1024;
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');
const ELECTRONIC_SIGNATURE_CONSENT_TEXT =
  'I agree to use electronic records and signatures for this document.';
const ELECTRONIC_SIGNATURE_CONSENT_VERSION = 'contractiq-esign-disclosure-v1';
const ELECTRONIC_SIGNATURE_CONSENT_HASH = crypto
  .createHash('sha256')
  .update(ELECTRONIC_SIGNATURE_CONSENT_TEXT)
  .digest('hex');
const SIGNING_AUTH_CODE_TTL_MS = Number(process.env.SIGNING_AUTH_CODE_TTL_MS) || 10 * 60 * 1000;
const SIGNING_AUTH_SESSION_TTL_MS = Number(process.env.SIGNING_AUTH_SESSION_TTL_MS) || 60 * 60 * 1000;
const SIGNING_AUTH_RESEND_COOLDOWN_MS = Number(process.env.SIGNING_AUTH_RESEND_COOLDOWN_MS) || 60 * 1000;
const SIGNING_AUTH_MAX_ATTEMPTS = Number(process.env.SIGNING_AUTH_MAX_ATTEMPTS) || 5;
const SIGNING_AUTH_TOTAL_MAX_ATTEMPTS = Number(process.env.SIGNING_AUTH_TOTAL_MAX_ATTEMPTS) || 20;
const SIGNING_AUTH_LOCKOUT_DURATION_MS = Number(process.env.SIGNING_AUTH_LOCKOUT_DURATION_MS) || 24 * 60 * 60 * 1000;
const PUBLIC_SIGNING_MAX_BODY_BYTES = Number(process.env.PUBLIC_SIGNING_MAX_BODY_BYTES) || 22 * 1024 * 1024;
const DRAWN_SIGNATURE_MIN_POINTS = Number(process.env.DRAWN_SIGNATURE_MIN_POINTS) || 8;
const TEXT_OVERLAP_LIMIT = 0.18;
const MAX_SIGNATURE_IMAGE_DIMENSIONS = {
  signature: { width: 1200, height: 600 },
  initials: { width: 600, height: 360 },
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const cleanText = (value, max = 200) => String(value || '').trim().slice(0, max);
const safeFilename = (value) => path.basename(String(value || 'document.pdf')).replace(/[^\w.\- ()]/g, '_');
const hashSignerToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const hashPublicSecret = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const tokenExpiresAt = () => new Date(Date.now() + SIGNING_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
const isValidSignerToken = (token) => SIGNER_TOKEN_RE.test(String(token || ''));
const isSignerTokenExpired = (signer) =>
  Boolean(signer?.tokenExpiresAt && new Date(signer.tokenExpiresAt).getTime() <= Date.now());
const finiteNumber = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};
const placementOrigins = new Set(['pdf', 'top-left', 'normalized']);
const publicSigningLimiter = ({ windowMs, max, message }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.params.token || ''}`,
  message: { error: message },
});

const publicSigningReadLimiter = publicSigningLimiter({
  windowMs: 15 * 60 * 1000,
  max: 90,
  message: 'Too many signing link requests. Please wait a few minutes and try again.',
});
const publicSigningMutationLimiter = publicSigningLimiter({
  windowMs: 10 * 60 * 1000,
  max: 25,
  message: 'Too many signing attempts. Please wait a few minutes and try again.',
});
const publicSigningAuthLimiter = publicSigningLimiter({
  windowMs: 10 * 60 * 1000,
  max: 8,
  message: 'Too many verification attempts. Please wait a few minutes and try again.',
});
const ronIdentityUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.RON_ID_MAX_FILE_BYTES) || 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('RON identity document must be a JPG, PNG, WebP, or PDF file.'));
  },
});
const ronRecordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.RON_RECORDING_MAX_FILE_BYTES) || 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('RON recording must be a WebM, MP4, or MPEG audio/video file.'));
  },
});
const notaryStampUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.NOTARY_STAMP_MAX_FILE_BYTES) || 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Notary stamp must be a PNG or JPG image.'));
  },
});

const rejectOversizedPublicPayload = (req, res, next) => {
  const byteLength = Number(req.get('content-length') || 0);
  if (byteLength > PUBLIC_SIGNING_MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Signing request payload is too large.' });
  }
  return next();
};

const issueSignerToken = (signer) => {
  const token = generateSignerToken();
  const issuedAt = new Date();
  signer.tokenHash = hashSignerToken(token);
  signer.token = undefined;
  signer.tokenIssuedAt = issuedAt;
  signer.tokenExpiresAt = tokenExpiresAt();
  signer.sentAt = signer.sentAt || issuedAt;
  signer.authCodeHash = undefined;
  signer.authCodeExpiresAt = undefined;
  signer.authCodeAttempts = 0;
  signer.authCodeLastSentAt = undefined;
  signer.authVerifiedAt = undefined;
  signer.authSessionHash = undefined;
  signer.authSessionExpiresAt = undefined;
  return token;
};

const normalizeAuthMethod = (value) => {
  const method = cleanText(value || 'email', 40).toLowerCase().replace(/[\s-]+/g, '_');
  if (['none', 'link', 'link_only', 'no_auth'].includes(method)) return 'link';
  if (['access_code', 'accesscode', 'code'].includes(method)) return 'access_code';
  if (['sms', 'phone', 'phone_otp'].includes(method)) return 'phone_otp';
  return 'email_otp';
};

const signerRequiresAuth = (signer) => normalizeAuthMethod(signer?.authMethod) !== 'link';
const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '';
  const shown = local.length <= 2 ? `${local[0] || ''}*` : `${local.slice(0, 2)}${'*'.repeat(Math.min(6, local.length - 2))}`;
  return `${shown}@${domain}`;
};

const publicSigningSessionToken = (req) => String(req.get('X-Signing-Session') || '').trim();
const devVerificationBypassEnabled = (req) =>
  process.env.NODE_ENV === 'development' && (
    req.get('X-Signing-Dev-Bypass') === 'true' ||
    req.query?.devSkipVerification === '1'
  );
const hasValidSignerSession = (signer, req) => {
  if (!signerRequiresAuth(signer)) return true;
  if (devVerificationBypassEnabled(req)) return true;
  const session = publicSigningSessionToken(req);
  if (!session || !signer?.authSessionHash) return false;
  if (!signer.authSessionExpiresAt || new Date(signer.authSessionExpiresAt).getTime() <= Date.now()) return false;
  return signer.authSessionHash === hashPublicSecret(session);
};

const publicAuthPayload = (signer, req) => {
  const required = signerRequiresAuth(signer);
  return {
    required,
    verified: !required || hasValidSignerSession(signer, req),
    method: normalizeAuthMethod(signer?.authMethod),
    maskedEmail: maskEmail(signer?.email),
    sessionExpiresAt: signer?.authSessionExpiresAt,
  };
};

const requireVerifiedPublicSigner = (req, res, signer) => {
  if (hasValidSignerSession(signer, req)) return true;
  res.status(401).json({
    error: 'Verify your email before continuing.',
    auth: publicAuthPayload(signer, req),
  });
  return false;
};

const generateSigningAuthCode = () => String(crypto.randomInt(100000, 1000000));
const hashSigningAuthCode = (doc, signer, code) =>
  hashPublicSecret(`${doc._id}:${normalizeEmail(signer.email)}:${String(code || '').trim()}`);

const issueAuthSession = (signer) => {
  const sessionToken = generateSignerToken();
  signer.authSessionHash = hashPublicSecret(sessionToken);
  signer.authSessionExpiresAt = new Date(Date.now() + SIGNING_AUTH_SESSION_TTL_MS);
  signer.authVerifiedAt = new Date();
  signer.authCodeHash = undefined;
  signer.authCodeExpiresAt = undefined;
  signer.authCodeAttempts = 0;
  return sessionToken;
};

const signerMatchesToken = (signer, token, tokenHash = hashSignerToken(token)) => {
  if (!signer) return false;
  if (signer.tokenHash) {
    const expected = Buffer.from(signer.tokenHash);
    const actual = Buffer.from(tokenHash);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  // Legacy plaintext path — timing-safe to prevent oracle attacks during the migration window
  if (signer.token) {
    const expected = Buffer.from(String(signer.token));
    const actual = Buffer.from(String(token));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  return false;
};

const migrateLegacySignerToken = (signer, token) => {
  if (!signer?.token || signer.token !== token) return false;
  signer.tokenHash = signer.tokenHash || hashSignerToken(token);
  signer.token = undefined;
  signer.tokenIssuedAt = signer.tokenIssuedAt || signer.sentAt || new Date();
  signer.tokenExpiresAt = signer.tokenExpiresAt || tokenExpiresAt();
  return true;
};

const findSigningDocumentByToken = async (token, { populateUploadedBy = false } = {}) => {
  if (!isValidSignerToken(token)) {
    return { status: 404, error: 'Signing link is invalid or has expired.' };
  }

  const tokenHash = hashSignerToken(token);
  let query = Document.findOne({
    $or: [
      { 'signers.tokenHash': tokenHash },
      { 'signers.token': token },
    ],
  });
  if (populateUploadedBy) query = query.populate('uploadedBy', 'name email');

  const doc = await query;
  if (!doc) return { status: 404, error: 'Signing link is invalid or has expired.' };

  const signer = (doc.signers || []).find((candidate) => signerMatchesToken(candidate, token, tokenHash));
  if (!signer) return { status: 404, error: 'Signing link not found.' };

  const migratedLegacyToken = migrateLegacySignerToken(signer, token);
  if (isSignerTokenExpired(signer)) {
    return { status: 410, error: 'Signing link is invalid or has expired.', doc, signer, migratedLegacyToken };
  }

  return { doc, signer, tokenHash, migratedLegacyToken };
};

const canManageDocument = (doc, user) => {
  if (!doc || !user) return false;
  if (['admin', 'manager'].includes(user.role)) return true;
  const ownerId = doc.uploadedBy?._id || doc.uploadedBy;
  return ownerId?.toString() === user._id?.toString();
};

const canAccessSigningEvidence = (doc, user) => (
  canManageDocument(doc, user) ||
  (doc.signers || []).some((signer) => normalizeEmail(signer.email) === normalizeEmail(user?.email))
);

const fieldPosition = (field, bodyPosition) => {
  if (field) {
    return {
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      origin: field.coordinateOrigin || 'normalized',
    };
  }
  if (!bodyPosition) return undefined;
  return {
    x: finiteNumber(bodyPosition.x, undefined),
    y: finiteNumber(bodyPosition.y, undefined),
    width: finiteNumber(bodyPosition.width, undefined),
    height: finiteNumber(bodyPosition.height, undefined),
    origin: placementOrigins.has(bodyPosition.origin) ? bodyPosition.origin : 'top-left',
  };
};

const fieldBelongsToSigner = (field, signerEmail, { allowUnassigned = true } = {}) =>
  Boolean(field) && (
    (allowUnassigned && !field.assignedTo) ||
    normalizeEmail(field.assignedTo) === normalizeEmail(signerEmail)
  );

const allowUnassignedPublicFields = (doc) => (doc.signers || []).length <= 1;
const fieldBelongsToPublicSigner = (doc, field, signerEmail) =>
  fieldBelongsToSigner(field, signerEmail, { allowUnassigned: allowUnassignedPublicFields(doc) });

const signatureFieldTypes = new Set(['signature', 'initials']);
const valueFieldTypes = new Set(['date', 'text', 'number', 'checkbox', 'radio', 'dropdown']);
const requirePlacedFields = (fields = []) =>
  (fields || []).map((field) => ({
    ...(field?.toObject ? field.toObject() : field),
    required: true,
  }));

const normalizedFieldRect = (field = {}) => {
  const x = finiteNumber(field.x, 0);
  const y = finiteNumber(field.y, 0);
  const width = Math.max(0, finiteNumber(field.width, 0));
  const height = Math.max(0, finiteNumber(field.height, 0));
  return {
    page: Number(field.page || 1),
    x,
    y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    area: width * height,
  };
};

const overlapRatio = (subject, other) => {
  const subjectRect = normalizedFieldRect(subject);
  const otherRect = normalizedFieldRect(other);
  if (subjectRect.page !== otherRect.page) return 0;
  const width = Math.min(subjectRect.right, otherRect.right) - Math.max(subjectRect.x, otherRect.x);
  const height = Math.min(subjectRect.bottom, otherRect.bottom) - Math.max(subjectRect.y, otherRect.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.max(subjectRect.area, 0.000001);
};

const canonicalizeSigningFields = (fields = []) => {
  const canonical = [];
  const removedFields = [];

  const sourceFields = (fields || []).map((field) => (field?.toObject ? field.toObject() : field));

  for (let index = 0; index < sourceFields.length; index += 1) {
    const field = sourceFields[index];
    if (field?.type === 'text') {
      const hiddenBy = sourceFields.find((candidate, candidateIndex) => (
        candidateIndex !== index &&
        (candidate.type !== 'text' || candidateIndex < index) &&
        overlapRatio(field, candidate) >= TEXT_OVERLAP_LIMIT
      ));
      if (hiddenBy) {
        removedFields.push({
          id: field.id,
          type: field.type,
          page: field.page,
          hiddenBy: hiddenBy.id || hiddenBy.type,
          overlapRatio: Number(overlapRatio(field, hiddenBy).toFixed(3)),
        });
        continue;
      }
    }
    canonical.push(field);
  }

  return { fields: canonical, removedFields };
};

const applyCanonicalSigningFields = (doc) => {
  const result = canonicalizeSigningFields(doc.signingFields || []);
  if (!result.removedFields.length) return result;

  doc.signingFields = result.fields;
  const prep = doc.signingPreparation?.toObject ? doc.signingPreparation.toObject() : (doc.signingPreparation || {});
  doc.signingPreparation = {
    ...prep,
    diagnostics: {
      ...(prep.diagnostics || {}),
      canonicalFieldCleanup: {
        removedFields: result.removedFields,
        removedCount: result.removedFields.length,
        reason: 'Removed text fields hidden by another placed field before external signing.',
      },
    },
  };
  doc.markModified('signingFields');
  doc.markModified('signingPreparation');
  return result;
};

const fieldValueIsComplete = (field, value) => {
  if (field?.type === 'checkbox') {
    return value === true || value === 'true';
  }
  if (field?.type === 'radio' && (value === false || value === 'false')) return false;
  return String(value ?? '').trim().length > 0;
};

const parseImageDataUri = (value, label, { required = true } = {}) => {
  if (!value) return required ? { error: `${label} is required.` } : { dataUrl: '' };
  const text = String(value);
  const match = text.match(/^data:image\/(png|jpe?g);base64,/i);
  if (!match) return { error: `${label} must be a PNG or JPG image.` };
  const mime = match[1].toLowerCase().replace('jpg', 'jpeg');
  const payload = text.replace(/^data:image\/(png|jpe?g);base64,/i, '');
  if (!payload || !/^[A-Za-z0-9+/=\s]+$/.test(payload)) return { error: `${label} is not valid base64 image data.` };
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) return { error: `${label} is empty.` };
  if (buffer.length > MAX_SIGNATURE_IMAGE_BYTES) {
    return { error: `${label} must be ${Math.round(MAX_SIGNATURE_IMAGE_BYTES / 1024 / 1024)} MB or smaller.` };
  }
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if ((mime === 'png' && !isPng) || (mime === 'jpeg' && !isJpeg)) {
    return { error: `${label} file header does not match its declared image type.` };
  }
  return { buffer, mime, dataUrl: text };
};

const normalizeSubmittedImageDataUri = async (value, label, { required = true, kind = 'signature' } = {}) => {
  const parsed = parseImageDataUri(value, label, { required });
  if (parsed.error || !parsed.buffer) return parsed;
  const maxSize = MAX_SIGNATURE_IMAGE_DIMENSIONS[kind] || MAX_SIGNATURE_IMAGE_DIMENSIONS.signature;

  try {
    const metadata = await sharp(parsed.buffer, { limitInputPixels: 16_000_000 }).metadata();
    if (!['png', 'jpeg'].includes(metadata.format)) return { error: `${label} must be a PNG or JPG image.` };
    if (!metadata.width || !metadata.height || metadata.width < 8 || metadata.height < 8) {
      return { error: `${label} image is too small to be a usable signature.` };
    }
    if (metadata.width > 6000 || metadata.height > 6000) {
      return { error: `${label} image dimensions are too large.` };
    }

    const normalized = await sharp(parsed.buffer, { limitInputPixels: 16_000_000 })
      .rotate()
      .resize({
        width: maxSize.width,
        height: maxSize.height,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    return {
      dataUrl: `data:image/png;base64,${normalized.toString('base64')}`,
      metadata: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      },
    };
  } catch {
    return { error: `${label} could not be decoded as an image.` };
  }
};

const drawnSignaturePointCount = (telemetry = {}) =>
  (Array.isArray(telemetry.strokes) ? telemetry.strokes : []).reduce(
    (sum, stroke) => sum + (Array.isArray(stroke.points) ? stroke.points.length : 0),
    0
  );

const validateSignaturePayload = async ({ signatureData, initialsData, method, signatureTelemetry }) => {
  const errors = [];
  const rawMethod = String(method || '').trim().toLowerCase();
  const normalizedMethod = normalizeSignatureMethod(method);
  const signatureImage = await normalizeSubmittedImageDataUri(signatureData, 'Signature image', { kind: 'signature' });
  const initialsImage = await normalizeSubmittedImageDataUri(initialsData, 'Initials image', { required: false, kind: 'initials' });

  if (signatureImage.error) errors.push(signatureImage.error);
  if (initialsImage.error) errors.push(initialsImage.error);
  if (rawMethod && !['draw', 'drawn', 'upload', 'uploaded', 'type', 'typed'].includes(rawMethod)) errors.push('Unsupported signature method.');
  if (!['drawn', 'uploaded', 'typed'].includes(normalizedMethod)) errors.push('Unsupported signature method.');
  if (normalizedMethod === 'drawn' && drawnSignaturePointCount(signatureTelemetry) < DRAWN_SIGNATURE_MIN_POINTS) {
    errors.push('Add a little more ink to your signature before signing.');
  }

  return {
    errors,
    signatureData: signatureImage.dataUrl || signatureData,
    initialsData: initialsImage.dataUrl || initialsData,
    imageMetadata: {
      signature: signatureImage.metadata,
      initials: initialsImage.metadata,
    },
  };
};

const findPrimarySignatureField = ({ doc, signerEmail, fieldId, allowUnassigned = true }) => {
  const fields = doc.signingFields || [];
  if (!fields.length) return { field: null };

  const pendingSignatureFields = fields.filter(
    (field) => field.type === 'signature' && !field.filled && fieldBelongsToSigner(field, signerEmail, { allowUnassigned })
  );
  const requestedField = fieldId ? fields.find((field) => field.id === fieldId) : null;

  if (fieldId && !requestedField) {
    return { status: 404, error: 'Signing field was not found.' };
  }
  if (requestedField && !fieldBelongsToSigner(requestedField, signerEmail, { allowUnassigned })) {
    return { status: 403, error: 'Field is not assigned to this signer.' };
  }
  if (requestedField?.type === 'signature') {
    if (requestedField.filled) return { status: 409, error: 'This signature field is already complete.' };
    return { field: requestedField };
  }
  if (requestedField && requestedField.type !== 'initials') {
    return { status: 400, error: 'The selected field cannot receive a signature.' };
  }

  const assignedField = pendingSignatureFields.find(
    (field) => normalizeEmail(field.assignedTo) === normalizeEmail(signerEmail)
  ) || pendingSignatureFields.find((field) => !field.assignedTo);

  if (!assignedField) {
    return { status: 409, error: 'No pending signature field is assigned to this signer.' };
  }

  return { field: assignedField };
};

const signatureFieldsCompletedBySigning = ({ doc, signerEmail, assignedField, allowUnassigned = true }) => {
  if (!assignedField) return [];
  return (doc.signingFields || []).filter((field) => (
    field.type === 'signature' &&
    !field.filled &&
    (
      field.id === assignedField.id ||
      normalizeEmail(field.assignedTo) === normalizeEmail(signerEmail) ||
      (allowUnassigned && !field.assignedTo)
    )
  ));
};

const requiredFieldErrorsForSigning = ({ doc, signerEmail, assignedField, fieldValues, initialsData, allowUnassigned = true }) => {
  const errors = [];
  const signatureFieldIds = new Set(
    signatureFieldsCompletedBySigning({ doc, signerEmail, assignedField, allowUnassigned }).map((field) => field.id)
  );

  for (const field of doc.signingFields || []) {
    if (field.filled || !fieldBelongsToSigner(field, signerEmail, { allowUnassigned })) continue;

    if (field.type === 'signature') {
      if (!signatureFieldIds.has(field.id)) {
        errors.push({ fieldId: field.id, error: 'Required signature field is not complete.' });
      }
      continue;
    }

    if (field.type === 'initials') {
      if (!initialsData) errors.push({ fieldId: field.id, error: 'Required initials field is not complete.' });
      continue;
    }

    if (valueFieldTypes.has(field.type)) {
      const value = Object.prototype.hasOwnProperty.call(fieldValues || {}, field.id)
        ? fieldValues[field.id]
        : field.fieldValue;
      if (!fieldValueIsComplete(field, value)) {
        errors.push({ fieldId: field.id, error: 'Required field is not complete.' });
      }
    }
  }

  return errors;
};

const applyFieldValues = ({ doc, signerEmail, fieldValues, signedAt, allowUnassigned = true }) => {
  if (!fieldValues || typeof fieldValues !== 'object') return;
  for (const [fid, fval] of Object.entries(fieldValues)) {
    const field = doc.signingFields.find((f) => f.id === fid);
    if (!field || signatureFieldTypes.has(field.type)) continue;
    if (!fieldBelongsToSigner(field, signerEmail, { allowUnassigned })) continue;
    field.filled = true;
    field.filledBy = signerEmail;
    field.filledAt = signedAt;
    field.fieldValue = fval;
  }
};

const applyInitialsFields = ({ doc, signerEmail, signedAt, hasInitials, allowUnassigned = true }) => {
  if (!hasInitials) return;
  for (const field of doc.signingFields || []) {
    if (field.type !== 'initials') continue;
    if (field.filled) continue;
    if (!fieldBelongsToSigner(field, signerEmail, { allowUnassigned })) continue;
    field.filled = true;
    field.filledBy = signerEmail;
    field.filledAt = signedAt;
  }
};

const applySignatureFields = ({ doc, signerEmail, signedAt, assignedField, allowUnassigned = true }) => {
  for (const field of signatureFieldsCompletedBySigning({ doc, signerEmail, assignedField, allowUnassigned })) {
    field.filled = true;
    field.filledBy = signerEmail;
    field.filledAt = signedAt;
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
    if (value === undefined || value === null || value === '') return null;
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
    if (value === undefined || value === null || value === '') return null;
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
  return !nextPending || normalizeEmail(nextPending.email) === normalizeEmail(signerEmail);
};

const inactiveSigningRequestError = (doc, signer) => {
  if (signer.signingStatus === 'signed') {
    return { status: 409, error: 'You have already signed this document.' };
  }
  if (signer.signingStatus === 'rejected' || signer.signingStatus === 'declined') {
    return { status: 409, error: 'You have already declined this signing request.' };
  }
  if (doc.status === 'Signed' || doc.status === 'Archived') {
    return { status: 409, error: 'This document is no longer accepting signatures.' };
  }
  if (doc.status === 'Declined') {
    return { status: 409, error: 'This signing request has been declined.' };
  }
  if (doc.status !== 'Pending Signature') {
    return { status: 409, error: 'This document is not accepting signatures.' };
  }
  return null;
};

const normalizeSignerInputs = (signers = []) => {
  const errors = [];
  const seen = new Set();
  const normalized = (Array.isArray(signers) ? signers : []).map((signer, index) => {
    const email = normalizeEmail(signer?.email);
    const name = cleanText(signer?.name, 160);
    const role = cleanText(signer?.role || `Signer ${index + 1}`, 120);

    if (!name) errors.push(`Signer ${index + 1} requires a name.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`Signer ${index + 1} requires a valid email address.`);
    }
    if (email && seen.has(email)) errors.push(`Duplicate signer email: ${email}.`);
    if (email) seen.add(email);

    return {
      email,
      name,
      role,
      userId: signer?.userId || undefined,
      order: index + 1,
      authMethod: cleanText(signer?.authMethod || 'email', 40),
    };
  });

  if (!normalized.length) errors.push('At least one signer is required.');
  return { signers: normalized, errors };
};

const assignFieldToSigner = (field, signers = []) => {
  const assignedEmail = normalizeEmail(field?.assignedTo);
  const byEmail = signers.find((signer) => normalizeEmail(signer.email) === assignedEmail);
  if (byEmail) return byEmail.email;

  const role = cleanText(field?.role, 120).toLowerCase();
  const byRole = role
    ? signers.find((signer) => cleanText(signer.role, 120).toLowerCase() === role)
    : null;
  if (byRole) return byRole.email;

  return signers.length === 1 ? signers[0].email : '';
};

const normalizeFieldsForRequest = (fields = [], signers = []) => {
  const normalized = (Array.isArray(fields) ? fields : []).map((field, index) => {
    const assignedTo = assignFieldToSigner(field, signers);
    const signer = signers.find((item) => item.email === assignedTo);
    return {
      ...(field?.toObject ? field.toObject() : field),
      id: field.id || `field_${index}`,
      page: field.page || 1,
      coordinateOrigin: field.coordinateOrigin || 'normalized',
      source: field.source || 'manual',
      confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 1,
      assignedTo,
      role: field.role || signer?.role || '',
      required: true,
      filled: false,
      filledBy: undefined,
      filledAt: undefined,
    };
  });

  const unassigned = normalized.filter((field) => !field.assignedTo);
  const signerEmailsWithFields = new Set(normalized.map((field) => normalizeEmail(field.assignedTo)).filter(Boolean));
  const signersWithoutFields = signers.filter((signer) => !signerEmailsWithFields.has(normalizeEmail(signer.email)));
  const errors = [];

  if (!normalized.length) errors.push('Add at least one signing field before sending.');
  if (unassigned.length) {
    errors.push('Every signing field must be assigned to a signer.');
  }
  if (signersWithoutFields.length) {
    errors.push(`Each signer must have at least one assigned field: ${signersWithoutFields.map((signer) => signer.email).join(', ')}.`);
  }

  return { fields: normalized, errors };
};

const assertDocumentPathIsStreamable = (documentPath) => {
  const resolved = path.resolve(documentPath || '');
  if (!resolved.startsWith(`${UPLOADS_ROOT}${path.sep}`)) return null;
  return resolved;
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
router.get('/public/sign/:token', publicSigningReadLimiter, async (req, res) => {
  try {
    const tokenLookup = await findSigningDocumentByToken(req.params.token, { populateUploadedBy: true });
    if (tokenLookup.error) return res.status(tokenLookup.status).json({ error: tokenLookup.error });

    const { doc, signer } = tokenLookup;
    if (signer.signingStatus !== 'signed') {
      const inactiveError = inactiveSigningRequestError(doc, signer);
      if (inactiveError) return res.status(inactiveError.status).json({ error: inactiveError.error });
    }

    const isTurn = isSignerTurn(doc, signer.email);
    const auth = publicAuthPayload(signer, req);
    const canonical = applyCanonicalSigningFields(doc);
    const shouldSaveCanonical = canonical.removedFields.length > 0;
    const existingSignature = signer.signingStatus === 'signed'
      ? await Signature.findOne({ document: doc._id, signerEmail: normalizeEmail(signer.email) }).sort({ signedAt: -1 })
      : null;

    // Mark viewed
    let shouldSavePublicDoc = tokenLookup.migratedLegacyToken || shouldSaveCanonical;
    if (doc.signingEvidence?.mode === 'ron') {
      ronNotarizationService.ensureRonSession(doc);
      shouldSavePublicDoc = true;
    }

    if (auth.verified && isTurn && !signer.viewedAt && signer.signingStatus !== 'signed') {
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
    } else if (shouldSavePublicDoc) {
      await doc.save();
    }

    const sender = auth.verified && doc.uploadedBy
      ? { name: doc.uploadedBy.name, email: doc.uploadedBy.email }
      : undefined;
    const receipt = auth.verified && signer.signingStatus === 'signed'
      ? buildPublicSigningReceipt({ doc, signer, signature: existingSignature, token: req.params.token })
      : null;

    const publicSigningEvidence = doc.signingEvidence?.mode === 'ron'
      ? {
        ...signingMediaEvidenceService.evidencePolicyFor(doc.signingEvidence?.mode, doc.signingEvidence?.ron),
        ron: ronNotarizationService.publicRonPayload(doc, signer.email),
      }
      : signingMediaEvidenceService.evidencePolicyFor(doc.signingEvidence?.mode, doc.signingEvidence?.ron);

    // Return only what the external signer needs
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      document: {
        _id: doc._id,
        name: doc.name,
        type: doc.type,
        status: doc.status,
        sender,
        signingOrder: doc.signingOrder,
        signingEvidence: publicSigningEvidence,
        previewUrl: auth.verified ? `/api/signing/public/document/${req.params.token}` : null,
      },
      signer: {
        email: auth.verified ? signer.email : undefined,
        maskedEmail: maskEmail(signer.email),
        name: signer.name,
        role: signer.role,
        signingStatus: signer.signingStatus,
        viewedAt: signer.viewedAt,
        sentAt: signer.sentAt,
        tokenExpiresAt: signer.tokenExpiresAt,
      },
      auth,
      consent: {
        version: ELECTRONIC_SIGNATURE_CONSENT_VERSION,
        text: ELECTRONIC_SIGNATURE_CONSENT_TEXT,
        textHash: ELECTRONIC_SIGNATURE_CONSENT_HASH,
      },
      receipt,
      fields: auth.verified
        ? requirePlacedFields((doc.signingFields || []).filter((f) => fieldBelongsToPublicSigner(doc, f, signer.email)))
        : [],
      isTurn,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/public/sign/:token/auth/send', publicSigningAuthLimiter, rejectOversizedPublicPayload, async (req, res) => {
  try {
    const tokenLookup = await findSigningDocumentByToken(req.params.token, { populateUploadedBy: true });
    if (tokenLookup.error) return res.status(tokenLookup.status).json({ error: tokenLookup.error });

    const { doc, signer } = tokenLookup;
    if (signer.signingStatus === 'rejected' || signer.signingStatus === 'declined' || doc.status === 'Declined' || doc.status === 'Archived') {
      return res.status(409).json({ error: 'This signing request is no longer accepting verification.' });
    }
    if (signer.signingStatus !== 'signed' && !isSignerTurn(doc, signer.email)) {
      return res.status(403).json({ error: 'It is not your turn to sign. Please wait for prior signers to complete.' });
    }
    if (!signerRequiresAuth(signer)) {
      return res.json({ auth: publicAuthPayload(signer, req), message: 'This signing link does not require a verification code.' });
    }

    // Permanent lockout check
    if (signer.authLockedUntil && new Date(signer.authLockedUntil).getTime() > Date.now()) {
      return res.status(429).json({ error: 'This signing link has been locked due to too many failed attempts. Contact the sender.' });
    }

    const lastSentAt = signer.authCodeLastSentAt ? new Date(signer.authCodeLastSentAt).getTime() : 0;
    if (lastSentAt && Date.now() - lastSentAt < SIGNING_AUTH_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'A verification code was sent recently. Please wait before requesting another code.' });
    }

    const code = generateSigningAuthCode();
    const expiresAt = new Date(Date.now() + SIGNING_AUTH_CODE_TTL_MS);
    signer.authCodeHash = hashSigningAuthCode(doc, signer, code);
    signer.authCodeExpiresAt = expiresAt;
    signer.authCodeAttempts = 0;
    signer.authCodeLastSentAt = new Date();
    await doc.save();

    emailService.sendSigningAuthCode(signer, doc, code, expiresAt).catch(console.error);
    await AuditLog.create({
      action: `External signing verification code sent: ${doc.name}`,
      category: 'signature',
      performedByEmail: signer.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { signerEmail: signer.email, authMethod: normalizeAuthMethod(signer.authMethod) },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      message: 'Verification code sent.',
      auth: { ...publicAuthPayload(signer, req), codeExpiresAt: expiresAt },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/public/sign/:token/auth/verify', publicSigningAuthLimiter, rejectOversizedPublicPayload, async (req, res) => {
  try {
    const tokenLookup = await findSigningDocumentByToken(req.params.token);
    if (tokenLookup.error) return res.status(tokenLookup.status).json({ error: tokenLookup.error });

    const { doc, signer } = tokenLookup;
    if (signer.signingStatus === 'rejected' || signer.signingStatus === 'declined' || doc.status === 'Declined' || doc.status === 'Archived') {
      return res.status(409).json({ error: 'This signing request is no longer accepting verification.' });
    }
    if (signer.signingStatus !== 'signed' && !isSignerTurn(doc, signer.email)) {
      return res.status(403).json({ error: 'It is not your turn to sign. Please wait for prior signers to complete.' });
    }
    if (!signerRequiresAuth(signer)) {
      const sessionToken = issueAuthSession(signer);
      await doc.save();
      return res.json({ sessionToken, auth: publicAuthPayload(signer, { ...req, get: (name) => (name === 'X-Signing-Session' ? sessionToken : req.get(name)) }) });
    }

    // Permanent lockout check
    if (signer.authLockedUntil && new Date(signer.authLockedUntil).getTime() > Date.now()) {
      return res.status(429).json({ error: 'This signing link has been locked due to too many failed attempts. Contact the sender.' });
    }

    const code = String(req.body?.code || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(code)) return res.status(422).json({ error: 'Enter the 6 digit verification code.' });
    if (!signer.authCodeHash || !signer.authCodeExpiresAt || new Date(signer.authCodeExpiresAt).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'Verification code has expired. Request a new code.' });
    }
    if (Number(signer.authCodeAttempts || 0) >= SIGNING_AUTH_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect verification attempts. Request a new code.' });
    }

    const expected = Buffer.from(signer.authCodeHash);
    const actual = Buffer.from(hashSigningAuthCode(doc, signer, code));
    const codeMatches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!codeMatches) {
      signer.authCodeAttempts = Number(signer.authCodeAttempts || 0) + 1;
      signer.authTotalFailedAttempts = Number(signer.authTotalFailedAttempts || 0) + 1;
      if (signer.authTotalFailedAttempts >= SIGNING_AUTH_TOTAL_MAX_ATTEMPTS) {
        signer.authLockedUntil = new Date(Date.now() + SIGNING_AUTH_LOCKOUT_DURATION_MS);
      }
      await doc.save();
      await AuditLog.create({
        action: `External signing verification failed: ${doc.name}`,
        category: 'signature',
        result: 'failure',
        performedByEmail: signer.email,
        target: { type: 'document', id: doc._id, label: doc.name },
        metadata: {
          signerEmail: signer.email,
          authMethod: normalizeAuthMethod(signer.authMethod),
          attemptNumber: signer.authCodeAttempts,
          totalFailedAttempts: signer.authTotalFailedAttempts,
          locked: Boolean(signer.authLockedUntil),
        },
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      if (signer.authLockedUntil) {
        return res.status(429).json({ error: 'This signing link has been locked due to too many failed attempts. Contact the sender.' });
      }
      return res.status(422).json({ error: 'Verification code is incorrect.' });
    }

    const sessionToken = issueAuthSession(signer);
    await doc.save();
    await AuditLog.create({
      action: `External signing access verified: ${doc.name}`,
      category: 'signature',
      performedByEmail: signer.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { signerEmail: signer.email, authMethod: normalizeAuthMethod(signer.authMethod) },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      sessionToken,
      auth: {
        required: true,
        verified: true,
        method: normalizeAuthMethod(signer.authMethod),
        sessionExpiresAt: signer.authSessionExpiresAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/public/document/:token — streams source file for external signer preview
router.get('/public/document/:token', publicSigningReadLimiter, async (req, res) => {
  try {
    const tokenLookup = await findSigningDocumentByToken(req.params.token);
    if (tokenLookup.error) return res.status(tokenLookup.status).send(tokenLookup.error);

    const { doc, signer } = tokenLookup;
    const inactiveError = inactiveSigningRequestError(doc, signer);
    if (inactiveError) return res.status(inactiveError.status).send(inactiveError.error);
    if (!isSignerTurn(doc, signer.email)) {
      return res.status(403).send('It is not your turn to sign. Please wait for prior signers to complete.');
    }
    if (!requireVerifiedPublicSigner(req, res, signer)) return;

    if (tokenLookup.migratedLegacyToken) await doc.save();

    const streamPath = assertDocumentPathIsStreamable(doc.path);
    if (!streamPath) return res.status(403).send('Document preview is not available for this signing link.');
    if (!fs.existsSync(streamPath)) return res.status(404).send('File not found on server.');

    res.setHeader('Content-Type', doc.mimetype || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename(doc.originalName || doc.filename || doc.name)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    fs.createReadStream(streamPath).pipe(res);
  } catch {
    res.status(500).send('Error loading document');
  }
});

router.get('/public/document/:token/final', publicSigningReadLimiter, async (req, res) => {
  try {
    const tokenLookup = await findSigningDocumentByToken(req.params.token);
    if (tokenLookup.error) return res.status(tokenLookup.status).send(tokenLookup.error);

    const { doc, signer } = tokenLookup;
    if (!requireVerifiedPublicSigner(req, res, signer)) return;
    if (signer.signingStatus !== 'signed') return res.status(403).send('Only completed signers can download the finalized document.');
    if (doc.finalization?.status !== 'finalized') return res.status(409).send('Finalized document is not available yet.');

    const streamPath = assertDocumentPathIsStreamable(doc.finalization.finalizedPath || doc.path);
    if (!streamPath || !fs.existsSync(streamPath)) return res.status(404).send('Finalized document not found on server.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(doc.originalName || doc.name).replace(/\.[^.]+$/, '')}-signed.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(streamPath).pipe(res);
  } catch {
    res.status(500).send('Error loading finalized document');
  }
});

router.post('/public/sign/:token/ron/identity', publicSigningAuthLimiter, rejectOversizedPublicPayload, ronIdentityUpload.single('idDocument'), async (req, res) => {
  try {
    const tokenLookup = await findSigningDocumentByToken(req.params.token, { populateUploadedBy: true });
    if (tokenLookup.error) return res.status(tokenLookup.status).json({ error: tokenLookup.error });

    const { doc, signer } = tokenLookup;
    const inactiveError = inactiveSigningRequestError(doc, signer);
    if (inactiveError) return res.status(inactiveError.status).json({ error: inactiveError.error });
    if (!requireVerifiedPublicSigner(req, res, signer)) return;
    if (!isSignerTurn(doc, signer.email)) {
      return res.status(403).json({ error: 'It is not your turn to complete RON identity proofing.' });
    }
    if (!req.file) return res.status(422).json({ error: 'Upload a government ID image or PDF.' });

    const identity = await ronNotarizationService.uploadSignerIdentity({ doc, signer, file: req.file });
    await doc.save();
    await AuditLog.create({
      action: `RON identity proofing submitted: ${doc.name}`,
      category: 'signature',
      performedByEmail: signer.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        signerEmail: signer.email,
        status: identity.status,
        method: identity.method,
        providerReference: identity.providerReference,
        idDocumentHash: identity.idDocument?.sha256,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      identity: {
        status: identity.status,
        method: identity.method,
        verifiedAt: identity.verifiedAt,
        rejectedAt: identity.rejectedAt,
        providerReference: identity.providerReference,
        error: identity.error,
      },
      signingEvidence: {
        ...signingMediaEvidenceService.evidencePolicyFor(doc.signingEvidence?.mode, doc.signingEvidence?.ron),
        ron: ronNotarizationService.publicRonPayload(doc, signer.email),
      },
    });
  } catch (err) {
    const status = /requires RON_IDENTITY_PROVIDER_URL/i.test(err.message) ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/signing/public/sign/:token — external signer submits their signature
router.post('/public/sign/:token', publicSigningMutationLimiter, rejectOversizedPublicPayload, async (req, res) => {
  try {
    const {
      signatureData,
      initialsData,
      method,
      fieldId,
      page,
      position,
      fieldValues,
      signatureTelemetry,
      clientEvidence,
      mediaEvidence,
      consentAccepted,
      consentVersion,
    } = req.body;
    const idempotencyKey = cleanText(req.get('X-Signing-Idempotency-Key') || req.body?.idempotencyKey, 128);

    const tokenLookup = await findSigningDocumentByToken(req.params.token, { populateUploadedBy: true });
    if (tokenLookup.error) return res.status(tokenLookup.status).json({ error: tokenLookup.error });

    const { doc, signer } = tokenLookup;
    const inactiveError = inactiveSigningRequestError(doc, signer);
    if (inactiveError) {
      const existingSig = await Signature.findOne({ document: doc._id, signerEmail: normalizeEmail(signer.email) });
      if (existingSig && idempotencyKey && existingSig.idempotencyKey === idempotencyKey) {
        return res.status(200).json({
          signature: signatureResponse(existingSig),
          documentStatus: doc.status,
          allSigned: doc.signingFields.every((f) => f.filled),
          finalization: doc.finalization,
          receipt: buildPublicSigningReceipt({ doc, signer, signature: existingSig, token: req.params.token }),
          idempotent: true,
        });
      }
      return res.status(inactiveError.status).json({ error: inactiveError.error });
    }

    if (!requireVerifiedPublicSigner(req, res, signer)) return;
    applyCanonicalSigningFields(doc);

    if (!isSignerTurn(doc, signer.email)) {
      return res.status(403).json({ error: 'It is not your turn to sign. Please wait for prior signers to complete.' });
    }
    if (consentAccepted !== true) {
      return res.status(422).json({ error: 'Electronic signature consent is required before signing.' });
    }
    if (consentVersion && consentVersion !== ELECTRONIC_SIGNATURE_CONSENT_VERSION) {
      return res.status(409).json({ error: 'Electronic signature consent disclosure has changed. Reload and accept the current disclosure.' });
    }
    const ronReadinessErrors = ronNotarizationService.validateRonCanSign({ doc, signer });
    if (ronReadinessErrors.length) {
      return res.status(422).json({ error: ronReadinessErrors[0], errors: ronReadinessErrors });
    }

    const payloadValidation = await validateSignaturePayload({ signatureData, initialsData, method, signatureTelemetry });
    if (payloadValidation.errors.length) {
      return res.status(400).json({ error: payloadValidation.errors[0], errors: payloadValidation.errors });
    }
    const normalizedSignatureData = payloadValidation.signatureData;
    const normalizedInitialsData = payloadValidation.initialsData;

    const allowUnassigned = allowUnassignedPublicFields(doc);

    // Validate non-signature field values
    if (fieldValues && typeof fieldValues === 'object') {
      const errors = [];
      for (const [fid, fval] of Object.entries(fieldValues)) {
        const field = doc.signingFields.find((f) => f.id === fid);
        if (!field) continue;
        if (!fieldBelongsToSigner(field, signer.email, { allowUnassigned })) {
          errors.push({ fieldId: fid, error: 'Field is not assigned to this signer.' });
          continue;
        }
        const err = validateFieldValue(field, fval);
        if (err) errors.push({ fieldId: fid, error: err });
      }
      if (errors.length) return res.status(422).json({ error: 'Field validation failed.', fieldErrors: errors });
    }

    const fieldSelection = findPrimarySignatureField({ doc, signerEmail: signer.email, fieldId, allowUnassigned });
    if (fieldSelection.error) {
      return res.status(fieldSelection.status || 400).json({ error: fieldSelection.error });
    }
    const assignedField = fieldSelection.field;

    const requiredErrors = requiredFieldErrorsForSigning({
      doc,
      signerEmail: signer.email,
      assignedField,
      fieldValues,
      initialsData: normalizedInitialsData,
      allowUnassigned,
    });
    if (requiredErrors.length) {
      return res.status(422).json({ error: 'Required signing fields are incomplete.', fieldErrors: requiredErrors });
    }

    const existingSig = await Signature.findOne({ document: doc._id, signerEmail: normalizeEmail(signer.email) });
    if (existingSig) {
      if (idempotencyKey && existingSig.idempotencyKey === idempotencyKey) {
        return res.status(200).json({
          signature: signatureResponse(existingSig),
          documentStatus: doc.status,
          allSigned: doc.signingFields.every((f) => f.filled),
          finalization: doc.finalization,
          receipt: buildPublicSigningReceipt({ doc, signer, signature: existingSig, token: req.params.token }),
          idempotent: true,
        });
      }
      return res.status(409).json({ error: 'You have already signed this document.' });
    }

    const signedAt = new Date();
    const effectivePosition = fieldPosition(assignedField, position);
    const effectivePage = Number(assignedField?.page ?? page ?? 1);
    const consentEvidence = consentEvidenceFor(signedAt);
    const signingMediaEvidence = signingMediaEvidenceService.processSigningMediaEvidence({
      mediaEvidence,
      policy: doc.signingEvidence,
      documentId: doc._id,
      signerEmail: signer.email,
    });
    if (signingMediaEvidence.errors.length) {
      return res.status(422).json({ error: signingMediaEvidence.errors[0], errors: signingMediaEvidence.errors });
    }
    const identityEvidence = buildSignatureEvidence({
      signatureData: normalizedSignatureData,
      initialsData: normalizedInitialsData,
      telemetry: signatureTelemetry,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      method,
      signedAt,
      documentId: doc._id,
      signerEmail: signer.email,
      fieldId: assignedField?.id || fieldId,
      page: effectivePage,
      position: effectivePosition,
      fieldValues,
      documentHash: documentContentHash(doc),
      consent: consentEvidence,
      imageMetadata: payloadValidation.imageMetadata,
      clientEvidence,
      mediaEvidence: signingMediaEvidence,
    });
    identityEvidence.evidence.trustedTimestamp = await trustedTimestampService.timestampEvidenceHash(identityEvidence.evidence.evidenceHash);
    ensurePlatformAttestationConfigured();

    let signature;
    try {
      signature = await createSignatureRecord({
        document: doc._id,
        signerEmail: normalizeEmail(signer.email),
        signerName: signer.name,
        signerRole: signer.role || assignedField?.role || 'Signatory',
        signatureData: normalizedSignatureData,
        initialsData: normalizedInitialsData,
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
        idempotencyKey,
      });
    } catch (createError) {
      if (!isDuplicateSignatureError(createError)) throw createError;
      const raceSig = await Signature.findOne({ document: doc._id, signerEmail: normalizeEmail(signer.email) });
      if (raceSig && idempotencyKey && raceSig.idempotencyKey === idempotencyKey) {
        return res.status(200).json({
          signature: signatureResponse(raceSig),
          documentStatus: doc.status,
          allSigned: doc.signingFields.every((f) => f.filled),
          finalization: doc.finalization,
          receipt: buildPublicSigningReceipt({ doc, signer, signature: raceSig, token: req.params.token }),
          idempotent: true,
        });
      }
      return res.status(409).json({ error: 'You have already signed this document.' });
    }

    applySignatureFields({ doc, signerEmail: signer.email, signedAt, assignedField, allowUnassigned });
    applyFieldValues({ doc, signerEmail: signer.email, fieldValues, signedAt, allowUnassigned });
    applyInitialsFields({ doc, signerEmail: signer.email, signedAt, hasInitials: Boolean(normalizedInitialsData), allowUnassigned });

    signer.signingStatus = 'signed';
    signer.signedAt = signedAt;

    const allFilled = doc.signingFields.every((f) => f.filled);
    if (allFilled) doc.status = 'Signed';

    let nextSignerInvite = null;
    if (!allFilled && doc.signingOrder === 'sequential') {
      const sorted = [...doc.signers].sort((a, b) => (a.order || 0) - (b.order || 0));
      const nextSigner = sorted.find((s) => s.signingStatus !== 'signed');
      if (nextSigner) {
        nextSignerInvite = { signer: nextSigner, token: issueSignerToken(nextSigner) };
      }
    }

    await doc.save();

    if (nextSignerInvite) {
      emailService.sendSigningRequest(nextSignerInvite.signer, doc, doc.uploadedBy, nextSignerInvite.token).catch(console.error);
    }

    let finalization = null;
    if (allFilled && doc.type === 'pdf' && process.env.SIGNING_AUTO_FINALIZE !== 'false' && ronReadyToFinalize(doc)) {
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

    const signerForConfirmation = signer.toObject ? signer.toObject() : signer;
    if (doc.signingEvidence?.mode === 'ron' && allFilled && finalization?.status !== 'failed') {
      // SA RON notarization — send official notarization email with notary details
      const notary = doc.signingEvidence?.ron?.notary || {};
      emailService.sendNotarizationComplete(
        { email: signer.email, name: signer.name },
        doc,
        notary,
        null,
      ).catch(console.error);
    } else {
      emailService
        .sendSigningConfirmation({ email: signer.email, name: signer.name }, doc, { ...signerForConfirmation, signedAt }, false)
        .catch(console.error);
    }

    await AuditLog.create({
      action: `Document signed via token: ${doc.name}`,
      category: 'signature',
      performedByEmail: signer.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        method: identityEvidence.normalizedMethod,
        fieldId: assignedField?.id || fieldId,
        page: effectivePage,
        auditHash: signature.auditHash,
        evidenceHash: identityEvidence.evidence.evidenceHash,
        clientEvidenceHash: identityEvidence.evidence.clientEvidenceHash,
        trustedTimestampStatus: identityEvidence.evidence.trustedTimestamp?.status,
        consentAccepted: true,
        consentVersion: ELECTRONIC_SIGNATURE_CONSENT_VERSION,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.status(201).json({
      signature: signatureResponse(signature),
      documentStatus: doc.status,
      allSigned: allFilled,
      finalization: doc.finalization || finalization,
      receipt: buildPublicSigningReceipt({ doc, signer, signature, finalization: doc.finalization || finalization, token: req.params.token }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signing/:docId/prepare - run IDP detection and attach signing fields
router.post('/:docId/prepare', protect, async (req, res) => {
  try {
    const { signers = [], strategy = {}, evidenceMode = 'standard', ronConfig = {} } = req.body;
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
    const preparedFields = canonicalizeSigningFields(requirePlacedFields(result.fields));
    doc.signingFields = preparedFields.fields;
    const evidencePolicy = signingMediaEvidenceService.normalizeEvidencePolicy({ mode: evidenceMode, ron: ronConfig }, req.user._id);
    const evidenceErrors = signingMediaEvidenceService.validateEvidencePolicy(evidencePolicy);
    if (evidenceErrors.length) return res.status(422).json({ error: evidenceErrors[0], errors: evidenceErrors });
    doc.signingEvidence = evidencePolicy;
    // SA-specific fields
    if (req.body.saDocumentType) doc.signingEvidence.saDocumentType = cleanText(req.body.saDocumentType, 80);
    if (req.body.apostilleRequired !== undefined) doc.signingEvidence.apostilleRequired = Boolean(req.body.apostilleRequired);
    ronNotarizationService.ensureRonSession(doc);
    // Apply scheduled session time if provided
    if (req.body.scheduledAt && doc.signingEvidence?.mode === 'ron') {
      const scheduledAt = new Date(req.body.scheduledAt);
      if (Number.isFinite(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now() - 60000) {
        doc.signingEvidence.scheduledAt = scheduledAt;
        const ron = doc.signingEvidence.ron || {};
        if (!ron.session) ron.session = {};
        ron.session.scheduledAt = scheduledAt;
        ron.session.status = 'scheduled';
        doc.signingEvidence.ron = ron;
        doc.markModified('signingEvidence');
      }
    }
    doc.signers = (signers || []).map((signer, index) => ({
      email: signer.email,
      name: signer.name,
      role: signer.role,
      userId: signer.userId || undefined,
      order: index + 1,
      authMethod: signer.authMethod || 'email',
      authCodeAttempts: 0,
      signingStatus: 'not_signed',
    }));
    if (req.body.signingOrder) doc.signingOrder = req.body.signingOrder;
    const prepareDiagnostics = Array.isArray(result.metadata?.diagnostics)
      ? [
          ...result.metadata.diagnostics,
          ...(preparedFields.removedFields.length ? [{
            provider: 'external-field-canonicalizer',
            removedFields: preparedFields.removedFields.length,
          }] : []),
        ]
      : {
          ...(result.metadata?.diagnostics || {}),
          ...(preparedFields.removedFields.length ? {
            canonicalFieldCleanup: {
              removedFields: preparedFields.removedFields,
              removedCount: preparedFields.removedFields.length,
            },
          } : {}),
        };
    doc.signingPreparation = {
      ...result.metadata,
      preparedBy: req.user._id,
      diagnostics: prepareDiagnostics,
    };
    await doc.save();

    await AuditLog.create({
      action: `Signing fields prepared: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { detectionVersion: result.metadata.detectionVersion, fieldCount: doc.signingFields.length, reviewRequired: result.metadata.reviewRequired, sourceFileHash: result.metadata.sourceFileHash, canonicalRemovedFields: preparedFields.removedFields.length },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({ document: doc, fields: doc.signingFields, preparation: doc.signingPreparation });
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
    const doc = await Document.findById(req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canAccessSigningEvidence(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });
    const sigs = await Signature.find({ document: req.params.docId })
      .populate('signedBy', 'name email')
      .sort({ signedAt: 1 })
      .limit(500);
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

const ronReadyToFinalize = (doc) => {
  if (doc.signingEvidence?.mode !== 'ron') return true;
  const ron = doc.signingEvidence.ron || {};
  return Boolean(ron.session?.recordingStatus === 'stored' && ron.seal?.appliedAt);
};

const finalizeIfReady = async ({ doc, requestedBy }) => {
  const allFilled = (doc.signingFields || []).every((field) => field.filled);
  if (!allFilled || doc.type !== 'pdf' || doc.finalization?.status === 'finalized' || !ronReadyToFinalize(doc)) return null;
  const signatures = await Signature.find({ document: doc._id }).sort({ signedAt: 1 });
  const result = await pdfFinalizationService.finalizePdf({ doc, signatures, requestedBy });
  doc.path = result.finalizedPath;
  doc.filename = path.basename(result.finalizedPath);
  doc.status = 'Signed';
  doc.finalization = buildFinalizationPayload(result);
  return result;
};

const documentContentHash = (doc) => {
  if (doc.finalization?.finalPdfHash) return doc.finalization.finalPdfHash;
  if (doc.signingPreparation?.sourceFileHash) return doc.signingPreparation.sourceFileHash;
  if (!doc.path || !fs.existsSync(doc.path)) return '';
  try {
    return pdfFinalizationService.sha256Buffer(fs.readFileSync(doc.path));
  } catch {
    return '';
  }
};

const consentEvidenceFor = (signedAt) => ({
  accepted: true,
  acceptedAt: signedAt,
  text: ELECTRONIC_SIGNATURE_CONSENT_TEXT,
  version: ELECTRONIC_SIGNATURE_CONSENT_VERSION,
  textHash: ELECTRONIC_SIGNATURE_CONSENT_HASH,
});

const signatureResponse = (signature) => ({
  _id: signature._id,
  signerEmail: signature.signerEmail,
  signedAt: signature.signedAt,
  auditHash: signature.auditHash,
  fieldId: signature.fieldId,
  evidenceHash: signature.evidence?.evidenceHash,
  witnessedBy: signature.witnessedBy,
});

const publicFinalDownloadUrl = (doc, token) =>
  doc.finalization?.status === 'finalized'
    ? `/api/signing/public/document/${token}/final`
    : null;

const buildPublicSigningReceipt = ({ doc, signer, signature, finalization, token }) => ({
  document: {
    id: doc._id,
    name: doc.name,
    status: doc.status,
  },
  signer: {
    name: signer.name,
    email: signer.email,
    role: signer.role,
    signedAt: signer.signedAt || signature?.signedAt,
  },
  signature: signature ? signatureResponse(signature) : null,
  finalization: finalization || doc.finalization || null,
  downloadUrl: publicFinalDownloadUrl(doc, token),
});

const isDuplicateSignatureError = (error) =>
  error?.code === 11000 && (
    error?.keyPattern?.document ||
    /document_1_signerEmail_1/.test(String(error?.message || ''))
  );

const createSignatureRecord = async (record) => {
  const auditHash = Signature.computeAuditHash(record);
  const witnessedBy = buildPlatformAttestation({ ...record, auditHash });
  return Signature.create({ ...record, auditHash, witnessedBy });
};

router.post('/:docId/ron/session', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    const action = cleanText(req.body?.action, 80);
    const ron = await ronNotarizationService.updateRonSession({
      doc,
      action,
      actor: req.user,
      payload: req.body || {},
    });
    const finalization = await finalizeIfReady({ doc, requestedBy: req.user });
    await doc.save();
    await AuditLog.create({
      action: `RON ${action}: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        action,
        signerEmail: normalizeEmail(req.body?.signerEmail),
        sessionStatus: ron.session?.status,
        recordingStatus: ron.session?.recordingStatus,
        finalPdfHash: finalization?.finalPdfHash,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      signingEvidence: {
        ...signingMediaEvidenceService.evidencePolicyFor(doc.signingEvidence?.mode, doc.signingEvidence?.ron),
        ron,
      },
      finalization: doc.finalization,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.post('/:docId/ron/recording', protect, ronRecordingUpload.single('recording'), async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });
    if (!req.file) return res.status(422).json({ error: 'Upload the RON audio/video recording file.' });

    const recording = await ronNotarizationService.saveRonRecording({ doc, file: req.file, actor: req.user });
    const finalization = await finalizeIfReady({ doc, requestedBy: req.user });
    await doc.save();
    await AuditLog.create({
      action: `RON recording stored: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        recordingHash: recording.sha256,
        recordingStorage: recording.storage,
        byteLength: recording.byteLength,
        finalPdfHash: finalization?.finalPdfHash,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      recording,
      signingEvidence: {
        ...signingMediaEvidenceService.evidencePolicyFor(doc.signingEvidence?.mode, doc.signingEvidence?.ron),
        ron: doc.signingEvidence.ron,
      },
      finalization: doc.finalization,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/signing/:docId/ron/stamp — upload notary stamp image (SA RON)
router.post('/:docId/ron/stamp', protect, notaryStampUpload.single('stamp'), async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });
    if (!req.file) return res.status(422).json({ error: 'Upload a PNG or JPG notary stamp image.' });

    const stamp = await ronNotarizationService.applyNotaryStamp({ doc, file: req.file });
    await doc.save();
    await AuditLog.create({
      action: `Notary stamp stored: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { stampHash: stamp.sha256, stampMimeType: stamp.mimeType },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    res.json({ stamp: { id: stamp.id, appliedAt: stamp.appliedAt, sha256: stamp.sha256 } });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/signing/:docId/sign
router.post('/:docId/sign', protect, async (req, res) => {
  try {
    const { signatureData, initialsData, method, fieldId, page, position, signerRole, fieldValues, signatureTelemetry, clientEvidence, mediaEvidence, consentAccepted } = req.body;

    const payloadValidation = await validateSignaturePayload({ signatureData, initialsData, method, signatureTelemetry });
    if (payloadValidation.errors.length) {
      return res.status(400).json({ error: payloadValidation.errors[0], errors: payloadValidation.errors });
    }
    const normalizedSignatureData = payloadValidation.signatureData;
    const normalizedInitialsData = payloadValidation.initialsData;
    if (consentAccepted !== true) {
      return res.status(422).json({ error: 'Electronic signature consent is required before signing.' });
    }

    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status !== 'Pending Signature') return res.status(400).json({ error: 'Document is not pending signature.' });

    const signerRecord = doc.signers.find((s) => normalizeEmail(s.email) === normalizeEmail(req.user.email) || s.userId?.toString() === req.user._id?.toString());
    if (doc.signers?.length && !signerRecord) {
      return res.status(403).json({ error: 'You are not a signer on this document.' });
    }
    if (signerRecord?.signingStatus === 'signed') {
      return res.status(409).json({ error: 'You have already signed this document.' });
    }
    if (signerRecord?.signingStatus === 'rejected' || signerRecord?.signingStatus === 'declined') {
      return res.status(409).json({ error: 'You have already declined this signing request.' });
    }

    // Sequential turn-gating
    if (!isSignerTurn(doc, req.user.email)) {
      return res.status(403).json({ error: 'It is not your turn to sign. Please wait for prior signers to complete.' });
    }

    const allowUnassigned = allowUnassignedPublicFields(doc);
    const fieldSelection = findPrimarySignatureField({ doc, signerEmail: req.user.email, fieldId, allowUnassigned });
    if (fieldSelection.error) {
      return res.status(fieldSelection.status || 400).json({ error: fieldSelection.error });
    }
    const assignedField = fieldSelection.field;

    // Validate non-signature field values
    if (fieldValues && typeof fieldValues === 'object') {
      const errors = [];
      for (const [fid, fval] of Object.entries(fieldValues)) {
        const field = doc.signingFields.find((f) => f.id === fid);
        if (!field) continue;
        if (!fieldBelongsToSigner(field, req.user.email, { allowUnassigned })) {
          errors.push({ fieldId: fid, error: 'Field is not assigned to this signer.' });
          continue;
        }
        const err = validateFieldValue(field, fval);
        if (err) errors.push({ fieldId: fid, error: err });
      }
      if (errors.length) return res.status(422).json({ error: 'Field validation failed.', fieldErrors: errors });
    }

    const requiredErrors = requiredFieldErrorsForSigning({
      doc,
      signerEmail: req.user.email,
      assignedField,
      fieldValues,
      initialsData: normalizedInitialsData,
      allowUnassigned,
    });
    if (requiredErrors.length) {
      return res.status(422).json({ error: 'Required signing fields are incomplete.', fieldErrors: requiredErrors });
    }

    const existingSig = await Signature.findOne({ document: doc._id, signerEmail: normalizeEmail(req.user.email) });
    if (existingSig) return res.status(409).json({ error: 'You have already signed this document.' });

    const signedAt = new Date();
    const effectivePosition = fieldPosition(assignedField, position);
    const effectivePage = Number(assignedField?.page ?? page ?? 1);
    const consentEvidence = consentEvidenceFor(signedAt);
    const signingMediaEvidence = signingMediaEvidenceService.processSigningMediaEvidence({
      mediaEvidence,
      policy: mediaEvidence ? doc.signingEvidence : { mode: 'standard' },
      documentId: doc._id,
      signerEmail: req.user.email,
    });
    if (signingMediaEvidence.errors.length) {
      return res.status(422).json({ error: signingMediaEvidence.errors[0], errors: signingMediaEvidence.errors });
    }
    const identityEvidence = buildSignatureEvidence({
      signatureData: normalizedSignatureData,
      initialsData: normalizedInitialsData,
      telemetry: signatureTelemetry,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      method,
      signedAt,
      documentId: doc._id,
      signerEmail: req.user.email,
      fieldId: assignedField?.id || fieldId,
      page: effectivePage,
      position: effectivePosition,
      fieldValues,
      documentHash: documentContentHash(doc),
      consent: consentEvidence,
      imageMetadata: payloadValidation.imageMetadata,
      clientEvidence,
      mediaEvidence: signingMediaEvidence,
    });
    identityEvidence.evidence.trustedTimestamp = await trustedTimestampService.timestampEvidenceHash(identityEvidence.evidence.evidenceHash);
    ensurePlatformAttestationConfigured();

    let signedFilename = doc.filename;
    if (process.env.SIGNING_LEGACY_EMBED_ON_EACH_SIGN === 'true' && doc.type === 'pdf' && fs.existsSync(doc.path)) {
      try {
        const result = await signingService.embedSignatureInPDF(doc.path, normalizedSignatureData, {
          page: Math.max(0, effectivePage - 1),
          x: effectivePosition?.x ?? 100,
          y: effectivePosition?.y ?? 200,
          width: effectivePosition?.width ?? 200,
          height: effectivePosition?.height ?? 80,
          origin: effectivePosition?.origin || 'top-left',
          initialsBase64: normalizedInitialsData,
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

    let signature;
    try {
      signature = await createSignatureRecord({
        document: doc._id,
        signedBy: req.user._id,
        signerEmail: normalizeEmail(req.user.email),
        signerName: req.user.name,
        signerRole: signerRole || assignedField?.role || 'Signatory',
        signatureData: normalizedSignatureData,
        initialsData: normalizedInitialsData,
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
    } catch (createError) {
      if (isDuplicateSignatureError(createError)) {
        return res.status(409).json({ error: 'You have already signed this document.' });
      }
      throw createError;
    }

    applySignatureFields({ doc, signerEmail: req.user.email, signedAt, assignedField, allowUnassigned });
    applyFieldValues({ doc, signerEmail: req.user.email, fieldValues, signedAt, allowUnassigned });
    applyInitialsFields({ doc, signerEmail: req.user.email, signedAt, hasInitials: Boolean(normalizedInitialsData), allowUnassigned });

    // Update per-signer state
    if (signerRecord) {
      signerRecord.signingStatus = 'signed';
      signerRecord.signedAt = signedAt;
    }

    const allFilled = doc.signingFields.every((f) => f.filled);
    if (allFilled) doc.status = 'Signed';

    let nextSignerInvite = null;
    if (!allFilled && doc.signingOrder === 'sequential') {
      const sorted = [...doc.signers].sort((a, b) => (a.order || 0) - (b.order || 0));
      const nextSigner = sorted.find((s) => s.signingStatus !== 'signed');
      if (nextSigner) {
        nextSignerInvite = { signer: nextSigner, token: issueSignerToken(nextSigner) };
      }
    }

    await doc.save();

    // Notify next signer for sequential mode
    if (nextSignerInvite) {
      emailService.sendSigningRequest(nextSignerInvite.signer, doc, req.user, nextSignerInvite.token).catch(console.error);
    }

    let finalization = null;
    if (allFilled && doc.type === 'pdf' && process.env.SIGNING_AUTO_FINALIZE !== 'false' && ronReadyToFinalize(doc)) {
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
    const { signers, fields, signingOrder, pageMetrics, message, evidenceMode = 'standard', ronConfig = {} } = req.body;
    const signerValidation = normalizeSignerInputs(signers || []);
    if (signerValidation.errors.length) {
      return res.status(422).json({ error: signerValidation.errors[0], errors: signerValidation.errors });
    }
    const normalizedSigners = signerValidation.signers;

    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    doc.status = 'Pending Signature';
    doc.signingOrder = signingOrder || doc.signingOrder || 'parallel';
    const evidencePolicy = signingMediaEvidenceService.normalizeEvidencePolicy({ mode: evidenceMode, ron: ronConfig }, req.user._id);
    const evidenceErrors = signingMediaEvidenceService.validateEvidencePolicy(evidencePolicy);
    if (evidenceErrors.length) return res.status(422).json({ error: evidenceErrors[0], errors: evidenceErrors });
    doc.signingEvidence = evidencePolicy;
    ronNotarizationService.ensureRonSession(doc);
    doc.signers = normalizedSigners.map((signer, index) => ({
      email: signer.email,
      name: signer.name,
      role: signer.role,
      userId: signer.userId || undefined,
      order: index + 1,
      authMethod: signer.authMethod || 'email',
      token: undefined,
	      tokenHash: undefined,
	      tokenIssuedAt: undefined,
	      tokenExpiresAt: undefined,
	      authCodeHash: undefined,
	      authCodeExpiresAt: undefined,
	      authCodeAttempts: 0,
	      authCodeLastSentAt: undefined,
	      authVerifiedAt: undefined,
	      authSessionHash: undefined,
	      authSessionExpiresAt: undefined,
	      signingStatus: 'not_signed',
	      sentAt: undefined,
	    }));

	    let preparationForRequest = null;
	    let manualNormalization = null;
	    if ((!fields || fields.length === 0) && (!doc.signingFields || doc.signingFields.length === 0)) {
	      preparationForRequest = await idpService.prepareSigningDocument({ doc, signers: normalizedSigners, strategy: {} });
	      if (preparationForRequest.metadata.normalizedFromOffice && preparationForRequest.metadata.normalizedPdfPath) {
        doc.path = preparationForRequest.metadata.normalizedPdfPath;
        doc.filename = path.basename(preparationForRequest.metadata.normalizedPdfPath);
        doc.mimetype = 'application/pdf';
        doc.type = 'pdf';
	      }
	      doc.signingFields = requirePlacedFields(preparationForRequest.fields);
	    } else if (fields && fields.length > 0) {
	      const normalized = await idpService.normalizeDocumentToPdf(doc);
	      const normalizedPageMetrics = await idpService.getPdfPageMetrics(normalized.pdfPath).catch(() => null);
	      manualNormalization = {
	        ...normalized.diagnostics,
	        normalizedPdfPath: normalized.pdfPath,
	        normalizedFromOffice: normalized.converted,
	        pageMetrics: normalizedPageMetrics,
	        sourceFileHash: pdfFinalizationService.sha256Buffer(fs.readFileSync(normalized.pdfPath)),
	      };
	      if (normalized.converted && normalized.pdfPath) {
	        doc.path = normalized.pdfPath;
	        doc.filename = path.basename(normalized.pdfPath);
	        doc.mimetype = 'application/pdf';
	        doc.type = 'pdf';
	      }
	      doc.signingFields = fields;
	    }

    const fieldValidation = normalizeFieldsForRequest(doc.signingFields || [], normalizedSigners);
    if (fieldValidation.errors.length) {
      return res.status(422).json({ error: fieldValidation.errors[0], errors: fieldValidation.errors });
    }
	    const canonicalFields = canonicalizeSigningFields(fieldValidation.fields);
	    const signerEmailsWithCanonicalFields = new Set(canonicalFields.fields.map((field) => normalizeEmail(field.assignedTo)).filter(Boolean));
	    const signersWithoutCanonicalFields = normalizedSigners.filter((signer) => !signerEmailsWithCanonicalFields.has(normalizeEmail(signer.email)));
	    if (signersWithoutCanonicalFields.length) {
	      return res.status(422).json({
	        error: `Each signer must have at least one visible assigned field: ${signersWithoutCanonicalFields.map((signer) => signer.email).join(', ')}.`,
	      });
	    }
	    doc.signingFields = canonicalFields.fields;

	    doc.signingPreparation = {
	      ...(preparationForRequest?.metadata || (doc.signingPreparation?.toObject ? doc.signingPreparation.toObject() : doc.signingPreparation || {})),
	      status: 'prepared',
	      preparedAt: new Date(),
	      preparedBy: req.user._id,
	      strategy: preparationForRequest?.metadata?.strategy || { source: fields?.length ? 'manual-envelope' : 'prepared-fields' },
	      pageMetrics: pageMetrics || manualNormalization?.pageMetrics || preparationForRequest?.metadata?.pageMetrics || doc.signingPreparation?.pageMetrics,
	      sourceFileHash: manualNormalization?.sourceFileHash || preparationForRequest?.metadata?.sourceFileHash || doc.signingPreparation?.sourceFileHash,
	      normalizedPdfPath: manualNormalization?.normalizedPdfPath || preparationForRequest?.metadata?.normalizedPdfPath || doc.signingPreparation?.normalizedPdfPath,
	      normalizedFromOffice: manualNormalization?.normalizedFromOffice || preparationForRequest?.metadata?.normalizedFromOffice || false,
	      diagnostics: {
	        ...(Array.isArray(preparationForRequest?.metadata?.diagnostics)
	          ? { idp: preparationForRequest.metadata.diagnostics }
	          : doc.signingPreparation?.diagnostics || {}),
	        ...(manualNormalization ? { normalizer: manualNormalization } : {}),
	        ...(canonicalFields.removedFields.length ? {
	          canonicalFieldCleanup: {
	            removedFields: canonicalFields.removedFields,
	            removedCount: canonicalFields.removedFields.length,
	          },
	        } : {}),
	        message: message || undefined,
	        fieldCount: doc.signingFields?.length || 0,
	      },
    };

    // For sequential mode, only send to the first signer. For parallel, send to all.
    const signersToNotify = doc.signingOrder === 'sequential'
      ? [doc.signers[0]].filter(Boolean)
      : doc.signers;
    const signerInviteTokens = new Map();

    for (const signer of signersToNotify) {
      signerInviteTokens.set(normalizeEmail(signer.email), issueSignerToken(signer));
    }

    await doc.save();

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
      emailService.sendSigningRequest(signer, doc, req.user, signerInviteTokens.get(normalizeEmail(signer.email))).catch(console.error);
    }

    await AuditLog.create({
      action: `Signing request sent: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: { signerCount: doc.signers.length, signingOrder: doc.signingOrder, evidenceMode: doc.signingEvidence?.mode || 'standard' },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    const appUrl = process.env.APP_URL || 'http://localhost:5174';
    const devPreview = process.env.NODE_ENV === 'development'
      ? {
          enabled: true,
          signers: doc.signers.map((s) => ({
            name: s.name,
            email: s.email,
	            role: s.role || 'Signatory',
	            signingUrl: signerInviteTokens.has(normalizeEmail(s.email))
	              ? `${appUrl}/sign/external/${signerInviteTokens.get(normalizeEmail(s.email))}?devSkipVerification=1`
	              : null,
            waitingForTurn: !signerInviteTokens.has(normalizeEmail(s.email)),
          })),
        }
      : undefined;

    res.json({ message: 'Signing requests sent.', document: doc, devPreview });
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
router.post('/reject-token/:token', publicSigningMutationLimiter, rejectOversizedPublicPayload, async (req, res) => {
  try {
    const reason = cleanText(req.body?.reason || 'No reason provided.', 500) || 'No reason provided.';
    const tokenLookup = await findSigningDocumentByToken(req.params.token, { populateUploadedBy: true });
    if (tokenLookup.error) return res.status(tokenLookup.status).json({ error: tokenLookup.error });

    const { doc, signer } = tokenLookup;
    const inactiveError = inactiveSigningRequestError(doc, signer);
    if (inactiveError) return res.status(inactiveError.status).json({ error: inactiveError.error });
	    if (!isSignerTurn(doc, signer.email)) {
	      return res.status(403).json({ error: 'It is not your turn to decline. Please wait for prior signers to complete.' });
	    }
	    if (!requireVerifiedPublicSigner(req, res, signer)) return;

    signer.signingStatus = 'rejected';
    signer.rejectionReason = reason;
    signer.declinedAt = new Date();
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
      metadata: { reason },
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
    const reminderToken = issueSignerToken(signer);
    await doc.save();

    await emailService.sendSigningReminder(signer, doc, req.user, reminderToken);

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
    const doc = await Document.findById(req.params.docId).populate('uploadedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });
    const [signatures, auditLogs] = await Promise.all([
      Signature.find({ document: req.params.docId }).sort({ signedAt: 1 }).limit(500),
      AuditLog.find({ 'target.id': req.params.docId }).sort({ createdAt: 1 }).limit(1000),
    ]);

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
        fields: requirePlacedFields(doc.signingFields || []),
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
    const requiredFields = doc.signingFields || [];
    const allRequiredSigned = requiredFields.every((f) => f.filled);
    if (!allRequiredSigned && req.body.allowIncomplete !== true) {
      return res.status(409).json({ error: 'Required signing fields are not complete.' });
    }
    if (!ronReadyToFinalize(doc)) {
      return res.status(409).json({ error: 'RON finalization requires the notary seal and stored audio/video recording.' });
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

// GET /api/signing/:docId/completion-certificate
router.get('/:docId/completion-certificate', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId)
      .populate('uploadedBy', 'name email')
      .populate('finalization.finalizedBy', 'name email');
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canAccessSigningEvidence(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });

    const completed = doc.status === 'Signed' || doc.finalization?.status === 'finalized';
    if (!completed) {
      return res.status(409).json({ error: 'Certificate of Completion is available after the document is fully signed.' });
    }

    const filename = safeFilename(`${String(doc.name || 'document').replace(/\.[^.]+$/, '')}_certificate_of_completion.pdf`);

    // Audit every download access
    await AuditLog.create({
      action: `Completion certificate downloaded: ${doc.name}`,
      category: 'signature',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'document', id: doc._id, label: doc.name },
      metadata: {
        finalPdfHash: doc.finalization?.finalPdfHash,
        digitalSignatureStatus: doc.finalization?.digitalSignatureStatus,
        servedFromCache: Boolean(doc.finalization?.certificatePath),
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    // Serve stored certificate on subsequent requests (deterministic output)
    if (doc.finalization?.certificatePath && fs.existsSync(doc.finalization.certificatePath)) {
      const pdfBytes = fs.readFileSync(doc.finalization.certificatePath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdfBytes.length);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pdfBytes);
    }

    // First request: generate and store certificate
    const [signatures, existingAuditLogs] = await Promise.all([
      Signature.find({ document: doc._id })
        .populate('signedBy', 'name email')
        .sort({ signedAt: 1 })
        .limit(500),
      AuditLog.find({ 'target.id': doc._id })
        .populate('performedBy', 'name email')
        .sort({ createdAt: 1 })
        .limit(1000),
    ]);

    const pdfBytes = await completionCertificateService.createCompletionCertificatePdf({
      doc,
      signatures,
      auditLogs: existingAuditLogs,
      generatedBy: req.user,
    });

    // Persist certificate so subsequent downloads are byte-identical
    const certDir = path.join(UPLOADS_ROOT, 'certificates');
    if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
    const certPath = path.join(certDir, `cert_${doc._id}.pdf`);
    fs.writeFileSync(certPath, pdfBytes);
    if (doc.finalization) {
      doc.finalization.certificatePath = certPath;
      doc.finalization.certificateHash = pdfFinalizationService.sha256Buffer(pdfBytes);
      doc.markModified('finalization');
      await doc.save();
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBytes.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdfBytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signing/:docId/audit-trail
router.get('/:docId/audit-trail', protect, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (!canManageDocument(doc, req.user)) return res.status(403).json({ error: 'Forbidden.' });
    const [signatures, auditLogs] = await Promise.all([
      Signature.find({ document: req.params.docId })
        .populate('signedBy', 'name email')
        .sort({ signedAt: 1 })
        .limit(500),
      AuditLog.find({ 'target.id': req.params.docId })
        .populate('performedBy', 'name email')
        .sort({ createdAt: 1 })
        .limit(1000),
    ]);
    res.json({ signatures, auditLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
