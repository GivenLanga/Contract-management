const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const RonJournalEntry = require('../models/RonJournalEntry');

const RON_IDENTITY_DIR = path.join(__dirname, '../../uploads/ron-identity');
const RON_RECORDING_DIR = path.join(__dirname, '../../uploads/ron-recordings');
const cleanText = (value, max = 200) => String(value || '').trim().slice(0, max);
const normalizeEmail = (value) => cleanText(value, 320).toLowerCase();
const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const isRonDocument = (doc) => doc?.signingEvidence?.mode === 'ron';

const ronRoot = (doc) => {
  if (!doc.signingEvidence) doc.signingEvidence = {};
  if (!doc.signingEvidence.ron) doc.signingEvidence.ron = {};
  return doc.signingEvidence.ron;
};

const jitsiRoomId = (doc) => {
  const seed = `${doc._id || uuidv4()}:${Date.now()}:${crypto.randomBytes(12).toString('hex')}`;
  return `contractiq-ron-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
};

const buildMeetingUrl = (roomId) => {
  const baseUrl = process.env.RON_VIDEO_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      'RON_VIDEO_BASE_URL must be configured with a private, SOC-2-compliant video provider. ' +
      'Public video services are not permitted for RON notarization.'
    );
  }
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(roomId)}`;
};

const ensureRonSession = (doc) => {
  if (!isRonDocument(doc)) return null;
  const ron = ronRoot(doc);
  if (!ron.session?.roomId) {
    const roomId = jitsiRoomId(doc);
    ron.session = {
      provider: process.env.RON_VIDEO_PROVIDER || 'configured_provider',
      roomId,
      meetingUrl: buildMeetingUrl(roomId),
      status: 'created',
      createdAt: new Date(),
      recordingStorage: process.env.RON_RECORDING_STORAGE || 'local',
    };
  }
  if (!ron.identity) ron.identity = { provider: process.env.RON_IDENTITY_PROVIDER || 'external', signers: [] };
  if (!ron.journal) ron.journal = [];
  return ron.session;
};

const ronSignerIdentity = (doc, signerEmail) => {
  const ron = ronRoot(doc);
  const email = normalizeEmail(signerEmail);
  const signers = Array.isArray(ron.identity?.signers) ? ron.identity.signers : Object.values(ron.identity?.signers || {});
  return signers.find((record) => normalizeEmail(record.signerEmail) === email) || { status: 'not_started' };
};

const publicRonPayload = (doc, signerEmail) => {
  if (!isRonDocument(doc)) return null;
  const ron = ronRoot(doc);
  const session = ensureRonSession(doc);
  const identity = ronSignerIdentity(doc, signerEmail);
  return {
    ...ron,
    session: {
      provider: session.provider,
      roomId: session.roomId,
      meetingUrl: session.meetingUrl,
      status: session.status,
      scheduledAt: session.scheduledAt || null,
      notaryStartedAt: session.notaryStartedAt,
      completedAt: session.completedAt,
      recordingStatus: session.recordingStatus,
    },
    identity: {
      provider: ron.identity?.provider || process.env.RON_IDENTITY_PROVIDER || 'external',
      signer: {
        status: identity.status || 'not_started',
        method: identity.method || ron.identityMethod,
        verifiedAt: identity.verifiedAt,
        rejectedAt: identity.rejectedAt,
        providerReference: identity.providerReference,
      },
    },
    notaryStamp: ron.notaryStamp ? { appliedAt: ron.notaryStamp.appliedAt } : null,
    // SA-specific public fields
    saDocumentType: doc.signingEvidence?.saDocumentType || null,
    scheduledAt: doc.signingEvidence?.scheduledAt || session.scheduledAt || null,
  };
};

// ─── Identity document encryption at rest ────────────────────────────────────
// Format written to disk: [16-byte IV][16-byte GCM auth tag][ciphertext]

const identityEncryptionKey = () => {
  const raw = process.env.RON_IDENTITY_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'RON_IDENTITY_ENCRYPTION_KEY or ENCRYPTION_KEY must be set to encrypt signer identity documents at rest.'
    );
  }
  return Buffer.from(raw.padEnd(32).slice(0, 32));
};

const encryptIdentityBuffer = (buffer) => {
  const key = identityEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
};

const decryptIdentityBuffer = (stored) => {
  const key = identityEncryptionKey();
  const iv = stored.subarray(0, 16);
  const authTag = stored.subarray(16, 32);
  const ciphertext = stored.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

const saveIdentityDocument = ({ file, documentId, signerEmail }) => {
  fs.mkdirSync(RON_IDENTITY_DIR, { recursive: true });
  const extension = path.extname(file.originalname || '') || (
    file.mimetype === 'application/pdf' ? '.pdf' : '.jpg'
  );
  const id = uuidv4();
  const filename = `${id}${extension.toLowerCase()}.enc`;
  const filePath = path.join(RON_IDENTITY_DIR, filename);
  const encryptedBuffer = encryptIdentityBuffer(file.buffer);
  fs.writeFileSync(filePath, encryptedBuffer);
  return {
    id,
    filename: `ron-identity/${filename}`,
    mimeType: file.mimetype,
    originalName: cleanText(file.originalname, 180),
    byteLength: file.size || file.buffer.length,
    sha256: sha256Buffer(file.buffer),
    encrypted: true,
    documentId: String(documentId || ''),
    signerEmail: normalizeEmail(signerEmail),
    storedAt: new Date(),
  };
};

const identityProviderConfigured = () => Boolean(process.env.RON_IDENTITY_PROVIDER_URL);

const runIdentityProviderVerification = async ({ doc, signer, fileRecord, file }) => {
  if (!identityProviderConfigured()) {
    return {
      status: 'configuration_required',
      error: 'RON_IDENTITY_PROVIDER_URL is required for credential analysis or KBA identity proofing.',
    };
  }

  const payload = {
    documentId: String(doc._id),
    signer: { email: signer.email, name: signer.name },
    identityMethod: doc.signingEvidence?.ron?.identityMethod || 'credential_analysis_kba',
    idDocument: {
      mimeType: fileRecord.mimeType,
      byteLength: fileRecord.byteLength,
      sha256: fileRecord.sha256,
      dataBase64: file.buffer.toString('base64'),
    },
  };

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.RON_IDENTITY_PROVIDER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.RON_IDENTITY_PROVIDER_API_KEY}`;
  }

  const response = await fetch(process.env.RON_IDENTITY_PROVIDER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeout: Number(process.env.RON_IDENTITY_PROVIDER_TIMEOUT_MS) || 20000,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: 'failed',
      error: body.error || body.message || `Identity provider failed (${response.status}).`,
      providerReference: body.referenceId || body.id,
    };
  }

  const providerStatus = cleanText(body.status || body.result || '', 60).toLowerCase();
  const verified = ['verified', 'approved', 'pass', 'passed', 'success'].includes(providerStatus)
    || body.verified === true
    || body.approved === true;

  return {
    status: verified ? 'verified' : 'rejected',
    providerReference: body.referenceId || body.id || body.transactionId,
    providerStatus: providerStatus || (verified ? 'verified' : 'rejected'),
    checks: body.checks || body.verifications || {},
    error: verified ? '' : (body.error || body.message || 'Identity provider did not approve this signer.'),
  };
};

const uploadSignerIdentity = async ({ doc, signer, file }) => {
  if (!isRonDocument(doc)) throw new Error('This document is not configured for RON.');
  if (!file?.buffer?.length) throw new Error('Upload a government ID image or PDF.');
  const ron = ronRoot(doc);
  ensureRonSession(doc);
  const email = normalizeEmail(signer.email);
  const identityMethod = ron.identityMethod || 'credential_analysis_kba';

  if (identityMethod !== 'personal_knowledge' && !identityProviderConfigured()) {
    throw new Error('RON identity proofing requires RON_IDENTITY_PROVIDER_URL or the notary must choose personal knowledge.');
  }

  const fileRecord = saveIdentityDocument({ file, documentId: doc._id, signerEmail: signer.email });
  const providerResult = identityMethod === 'personal_knowledge'
    ? { status: 'pending_notary', providerStatus: 'manual_notary_review' }
    : await runIdentityProviderVerification({ doc, signer, fileRecord, file });

  ron.identity = ron.identity || { provider: process.env.RON_IDENTITY_PROVIDER || 'external', signers: [] };
  const signers = Array.isArray(ron.identity.signers) ? ron.identity.signers : Object.values(ron.identity.signers || {});
  const nextRecord = {
    signerEmail: email,
    method: identityMethod,
    status: providerResult.status,
    uploadedAt: new Date(),
    verifiedAt: providerResult.status === 'verified' ? new Date() : undefined,
    rejectedAt: providerResult.status === 'rejected' ? new Date() : undefined,
    provider: process.env.RON_IDENTITY_PROVIDER || 'external',
    providerStatus: providerResult.providerStatus,
    providerReference: providerResult.providerReference,
    checks: providerResult.checks,
    error: providerResult.error,
    idDocument: fileRecord,
  };
  ron.identity.signers = [
    ...signers.filter((record) => normalizeEmail(record.signerEmail) !== email),
    nextRecord,
  ];
  const journalEntry = { event: 'identity_proofing_submitted', signerEmail: email, status: providerResult.status, at: new Date() };
  ron.journal = [...(ron.journal || []), journalEntry];
  await RonJournalEntry.appendEntry({ document: doc._id, ...journalEntry });
  doc.markModified?.('signingEvidence');
  return nextRecord;
};

const updateRonSession = async ({ doc, action, actor, payload = {} }) => {
  if (!isRonDocument(doc)) throw new Error('This document is not configured for RON.');
  const ron = ronRoot(doc);
  const session = ensureRonSession(doc);
  const now = new Date();
  const actorEmail = normalizeEmail(actor?.email);

  if (action === 'schedule') {
    const rawDate = payload.scheduledAt;
    if (!rawDate) throw new Error('scheduledAt is required to schedule a notary session.');
    const scheduledAt = new Date(rawDate);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error('scheduledAt is not a valid date/time.');
    if (scheduledAt.getTime() < Date.now() - 60000) throw new Error('Cannot schedule a session in the past.');
    session.scheduledAt = scheduledAt;
    session.status = 'scheduled';
    // Mirror to top-level signingEvidence for easy querying
    doc.signingEvidence.scheduledAt = scheduledAt;
    doc.markModified?.('signingEvidence');
  } else if (action === 'start') {
    session.status = 'live';
    session.notaryStartedAt = session.notaryStartedAt || now;
    session.startedBy = actorEmail;
  } else if (action === 'complete') {
    session.status = 'completed';
    session.completedAt = now;
    session.completedBy = actorEmail;
    session.recordingReference = cleanText(payload.recordingReference, 400);
    session.recordingSha256 = cleanText(payload.recordingSha256, 128);
    session.recordingStatus = session.recordingReference ? 'stored' : 'pending';
  } else if (action === 'verify_personal_knowledge') {
    const signerEmail = normalizeEmail(payload.signerEmail);
    if (!signerEmail) throw new Error('Signer email is required.');
    ron.identity = ron.identity || { provider: 'notary_personal_knowledge', signers: [] };
    const signers = Array.isArray(ron.identity.signers) ? ron.identity.signers : Object.values(ron.identity.signers || {});
    const existing = signers.find((record) => normalizeEmail(record.signerEmail) === signerEmail) || {};
    const nextRecord = {
      ...existing,
      signerEmail,
      method: 'personal_knowledge',
      status: 'verified',
      verifiedAt: now,
      verifiedBy: actorEmail,
      provider: 'notary_personal_knowledge',
    };
    ron.identity.signers = [
      ...signers.filter((record) => normalizeEmail(record.signerEmail) !== signerEmail),
      nextRecord,
    ];
  } else if (action === 'seal') {
    ron.seal = {
      appliedAt: now,
      appliedBy: actorEmail,
      certificateFingerprint: cleanText(payload.certificateFingerprint, 128),
      pkiProvider: cleanText(payload.pkiProvider || 'x509-p12', 80),
    };
  } else {
    throw new Error('Unsupported RON session action.');
  }

  const journalEntry = {
    event: `notary_${action}`,
    actorEmail,
    signerEmail: normalizeEmail(payload.signerEmail),
    at: now,
  };
  ron.journal = [...(ron.journal || []), journalEntry];
  await RonJournalEntry.appendEntry({ document: doc._id, ...journalEntry });
  doc.markModified?.('signingEvidence');
  return ron;
};

const RON_STAMP_DIR = path.join(__dirname, '../../uploads/ron-stamps');

const applyNotaryStamp = async ({ doc, file }) => {
  if (!isRonDocument(doc)) throw new Error('This document is not configured for notarization.');
  if (!file?.buffer?.length) throw new Error('Upload the notary stamp image (PNG or JPG).');
  const ron = ronRoot(doc);
  fs.mkdirSync(RON_STAMP_DIR, { recursive: true });
  const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
  const id = uuidv4();
  const filename = `${id}${ext}`;
  const filePath = path.join(RON_STAMP_DIR, filename);
  fs.writeFileSync(filePath, file.buffer);
  ron.notaryStamp = {
    id,
    filename: `ron-stamps/${filename}`,
    filePath,
    mimeType: file.mimetype,
    byteLength: file.buffer.length,
    sha256: sha256Buffer(file.buffer),
    storedAt: new Date(),
    appliedAt: new Date(),
  };
  const journalEntry = {
    event: 'notary_stamp_stored',
    at: new Date(),
  };
  ron.journal = [...(ron.journal || []), journalEntry];
  await RonJournalEntry.appendEntry({ document: doc._id, ...journalEntry });
  doc.markModified?.('signingEvidence');
  return ron.notaryStamp;
};

const saveRonRecording = async ({ doc, file, actor }) => {
  if (!isRonDocument(doc)) throw new Error('This document is not configured for RON.');
  if (!file?.buffer?.length) throw new Error('Upload the RON audio/video recording file.');
  const ron = ronRoot(doc);
  const session = ensureRonSession(doc);
  fs.mkdirSync(RON_RECORDING_DIR, { recursive: true });
  const ext = path.extname(file.originalname || '') || (file.mimetype === 'video/mp4' ? '.mp4' : '.webm');
  const id = uuidv4();
  const filename = `${id}${ext.toLowerCase()}`;
  const filePath = path.join(RON_RECORDING_DIR, filename);
  fs.writeFileSync(filePath, file.buffer);
  const recording = {
    id,
    filename: `ron-recordings/${filename}`,
    storage: 'local',
    mimeType: file.mimetype,
    originalName: cleanText(file.originalname, 180),
    byteLength: file.size || file.buffer.length,
    sha256: sha256Buffer(file.buffer),
    storedAt: new Date(),
    storedBy: normalizeEmail(actor?.email),
  };
  session.recordingStatus = 'stored';
  session.recordingReference = recording.filename;
  session.recordingSha256 = recording.sha256;
  session.recording = recording;
  const journalEntry = {
    event: 'ron_recording_stored',
    actorEmail: normalizeEmail(actor?.email),
    recordingHash: recording.sha256,
    at: new Date(),
  };
  ron.journal = [...(ron.journal || []), journalEntry];
  await RonJournalEntry.appendEntry({ document: doc._id, ...journalEntry });
  doc.markModified?.('signingEvidence');
  return recording;
};

const validateRonCanSign = ({ doc, signer }) => {
  if (!isRonDocument(doc)) return [];
  const errors = [];
  const ron = ronRoot(doc);
  const identityMethod = ron.identityMethod || 'credential_analysis_kba';
  const identity = ronSignerIdentity(doc, signer.email);

  if (identity.status !== 'verified') {
    errors.push(identityMethod === 'personal_knowledge'
      ? 'The notary must verify personal knowledge before this RON can be signed.'
      : 'Complete identity proofing before signing this RON document.');
  }
  if (!ron.session?.meetingUrl) errors.push('RON live session is not configured.');
  if (!ron.session?.notaryStartedAt) errors.push('The notary must start the live RON session before signing.');
  if (identityMethod !== 'personal_knowledge' && !identity.providerReference) {
    errors.push('Identity provider reference is required for credential-analysis RON.');
  }
  return errors;
};

module.exports = {
  ensureRonSession,
  publicRonPayload,
  uploadSignerIdentity,
  updateRonSession,
  saveRonRecording,
  applyNotaryStamp,
  validateRonCanSign,
  isRonDocument,
  decryptIdentityBuffer,
};
