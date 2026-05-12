const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { stableJson } = require('../utils/stableJson');

const EVIDENCE_DIR = path.join(__dirname, '../../uploads/signing-evidence');
const MAX_PHOTO_BYTES = Number(process.env.SIGNING_EVIDENCE_MAX_PHOTO_BYTES) || 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = Number(process.env.SIGNING_EVIDENCE_MAX_VIDEO_BYTES) || 15 * 1024 * 1024;
const BASE64_MARKER = ';base64,';

const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const cleanText = (value, max = 200) => String(value || '').trim().slice(0, max);
const cleanEmail = (value) => cleanText(value, 320).toLowerCase();

const parseDataUri = (value) => {
  const input = String(value || '').trim();
  if (!input.toLowerCase().startsWith('data:')) return null;
  const markerIndex = input.toLowerCase().indexOf(BASE64_MARKER);
  if (markerIndex === -1) return null;
  const mimeType = input
    .slice(5, markerIndex)
    .split(';')[0]
    .trim()
    .toLowerCase();
  const base64 = input.slice(markerIndex + BASE64_MARKER.length);
  if (!/^[a-z0-9+/=\s]+$/i.test(base64)) return null;
  return {
    mimeType,
    buffer: Buffer.from(base64.replace(/\s/g, ''), 'base64'),
  };
};

const extensionFor = (mimeType) => {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'video/webm') return 'webm';
  if (mimeType === 'video/mp4') return 'mp4';
  return 'bin';
};

// SA identity methods (no US-style KBA in SA law)
const SA_IDENTITY_METHODS = new Set(['sa_id_document', 'passport_document', 'personal_knowledge']);
// Full set including legacy US methods for backward compat
const RON_IDENTITY_METHODS = new Set([
  'sa_id_document', 'passport_document', 'personal_knowledge',
  'credential_analysis_kba', 'credential_analysis',
]);

const SA_PROVINCES = {
  GP: 'Gauteng', WC: 'Western Cape', KZN: 'KwaZulu-Natal',
  EC: 'Eastern Cape', FS: 'Free State', LP: 'Limpopo',
  MP: 'Mpumalanga', NC: 'Northern Cape', NW: 'North West',
};

const SA_DOCUMENT_TYPES = ['antenuptial_contract', 'power_of_attorney', 'affidavit', 'academic_transcript', 'property_agreement', 'declaration', 'other'];

const normalizeRonConfig = (config = {}) => {
  const notary = config.notary || {};
  const identityMethod = RON_IDENTITY_METHODS.has(config.identityMethod)
    ? config.identityMethod
    : 'sa_id_document';
  const isSaIdentity = SA_IDENTITY_METHODS.has(identityMethod);
  // Prefer SA-specific province over legacy commissionState
  const province = cleanText(notary.province || notary.commissionState, 10).toUpperCase();
  const venue = cleanText(notary.venue || notary.county, 120);
  return {
    providerModel: 'internal_notary_session',
    identityMethod,
    jurisdiction: 'ZA',
    notary: {
      name: cleanText(notary.name),
      email: cleanEmail(notary.email),
      province,
      admissionNumber: cleanText(notary.admissionNumber || notary.commissionNumber, 120),
      commissionExpiresAt: cleanText(notary.commissionExpiresAt, 40),
      venue,
      // Legacy fields for non-SA backward compat
      commissionState: province,
      commissionNumber: cleanText(notary.commissionNumber, 120),
      county: venue,
    },
    requirements: {
      liveAudioVideoSession: true,
      signerIdentityDocument: isSaIdentity && identityMethod !== 'personal_knowledge',
      signerCredentialAnalysis: ['credential_analysis', 'credential_analysis_kba'].includes(identityMethod),
      knowledgeBasedAuthentication: identityMethod === 'credential_analysis_kba',
      notaryPersonalKnowledge: identityMethod === 'personal_knowledge',
      notaryStamp: true,
      electronicJournal: true,
      tamperEvidentCertificate: true,
      notaryElectronicSeal: true,
    },
  };
};

const evidencePolicyFor = (mode = 'standard', ronConfig = {}) => {
  const normalized = ['standard', 'photo', 'video', 'ron'].includes(mode) ? mode : 'standard';
  const policy = {
    mode: normalized,
    requirePhoto: ['photo', 'video', 'ron'].includes(normalized),
    requireVideo: ['video', 'ron'].includes(normalized),
    requireAudio: normalized === 'ron',
    ronRequested: normalized === 'ron',
  };
  if (normalized === 'ron') policy.ron = normalizeRonConfig(ronConfig);
  return policy;
};

const normalizeEvidenceMode = (value) => evidencePolicyFor(value).mode;

const normalizeEvidencePolicy = (value, userId) => {
  const source = typeof value === 'string' ? { mode: value } : (value || {});
  const policy = evidencePolicyFor(source.mode, source.ron);
  return {
    ...policy,
    configuredAt: new Date(),
    configuredBy: userId,
  };
};

const validateEvidencePolicy = (policy = {}) => {
  const errors = [];
  if (policy.mode !== 'ron') return errors;

  const ron = normalizeRonConfig(policy.ron);
  if (!ron.notary.name) errors.push('Notarization requires the notary full name.');
  if (!ron.notary.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ron.notary.email)) {
    errors.push('Notarization requires a valid notary email address.');
  }
  if (!ron.notary.admissionNumber && !ron.notary.commissionNumber) {
    errors.push('Notarization requires the notary High Court admission or commission number.');
  }
  if (!ron.notary.province && !ron.notary.commissionState) {
    errors.push('Notarization requires the notary province or jurisdiction.');
  }
  if (!ron.notary.commissionExpiresAt) {
    errors.push('Notarization requires the notary commission expiration date.');
  } else {
    const expiryDate = new Date(ron.notary.commissionExpiresAt);
    if (!Number.isFinite(expiryDate.getTime())) {
      errors.push('Notary commission expiration date is not a valid date.');
    } else if (expiryDate <= new Date()) {
      errors.push('Notary commission has expired. The notary must renew their commission before conducting a notarization session.');
    }
  }
  if (!ron.notary.venue && !ron.notary.county) errors.push('Notarization requires the notarial venue or city.');
  if (!RON_IDENTITY_METHODS.has(ron.identityMethod)) {
    errors.push('Notarization requires a recognized identity-proofing method.');
  }
  // SA identity methods do not require external KBA provider
  const needsExternalProvider = ['credential_analysis', 'credential_analysis_kba'].includes(ron.identityMethod);
  if (needsExternalProvider && !process.env.RON_IDENTITY_PROVIDER_URL) {
    errors.push('Credential analysis requires RON_IDENTITY_PROVIDER_URL. Use SA ID document, passport, or personal knowledge for South African notarization.');
  }
  if (!process.env.RON_NOTARY_P12_PATH && !process.env.PDF_SIGNING_P12_PATH) {
    errors.push('Notarization requires a notary PKI certificate. Configure RON_NOTARY_P12_PATH or PDF_SIGNING_P12_PATH.');
  }
  return errors;
};

const saveEvidenceFile = ({ buffer, mimeType, documentId, signerEmail, kind }) => {
  const datePart = new Date().toISOString().slice(0, 7); // YYYY-MM
  const subDir = path.join(EVIDENCE_DIR, datePart);
  fs.mkdirSync(subDir, { recursive: true });
  const fileId = uuidv4();
  const filename = `${fileId}.${extensionFor(mimeType)}`;
  const filePath = path.join(subDir, filename);
  fs.writeFileSync(filePath, buffer);
  return {
    id: fileId,
    kind,
    mimeType,
    byteLength: buffer.length,
    sha256: sha256Buffer(buffer),
    storage: 'local',
    filename: `signing-evidence/${datePart}/${filename}`,
    documentId: String(documentId || ''),
    signerEmail: cleanText(signerEmail, 320).toLowerCase(),
    storedAt: new Date(),
  };
};

const processSigningMediaEvidence = ({ mediaEvidence = {}, policy = {}, documentId, signerEmail }) => {
  const modePolicy = evidencePolicyFor(policy.mode, policy.ron);
  const result = {
    mode: modePolicy.mode,
    required: {
      photo: modePolicy.requirePhoto,
      video: modePolicy.requireVideo,
      audio: modePolicy.requireAudio,
      ron: modePolicy.ronRequested,
    },
    captureStartedAt: mediaEvidence?.captureStartedAt || null,
    captureStoppedAt: mediaEvidence?.captureStoppedAt || null,
    photoCapturedAt: mediaEvidence?.photoCapturedAt || null,
    videoStartedAt: mediaEvidence?.videoStartedAt || null,
    videoStoppedAt: mediaEvidence?.videoStoppedAt || null,
    userMediaConstraints: {
      audio: Boolean(mediaEvidence?.userMediaConstraints?.audio),
      video: Boolean(mediaEvidence?.userMediaConstraints?.video),
    },
    errors: [],
  };
  if (modePolicy.mode === 'ron') {
    result.ron = {
      ...normalizeRonConfig(modePolicy.ron),
      session: {
        signerAcknowledgedAt: mediaEvidence?.ronSession?.signerAcknowledgedAt || null,
        techCheckedAt: mediaEvidence?.ronSession?.techCheckedAt || null,
        sessionStartedAt: mediaEvidence?.ronSession?.sessionStartedAt || mediaEvidence?.captureStartedAt || null,
        sessionStoppedAt: mediaEvidence?.ronSession?.sessionStoppedAt || mediaEvidence?.captureStoppedAt || null,
      },
    };
  }

  if (modePolicy.mode === 'standard') return result;

  const photo = parseDataUri(mediaEvidence?.photoData);
  let validPhoto = null;
  if (modePolicy.requirePhoto) {
    if (!photo) {
      result.errors.push('Photo evidence is required for this signing request.');
    } else if (!['image/png', 'image/jpeg'].includes(photo.mimeType)) {
      result.errors.push('Photo evidence must be a PNG or JPG image.');
    } else if (photo.buffer.length > MAX_PHOTO_BYTES) {
      result.errors.push('Photo evidence is too large.');
    } else {
      validPhoto = photo;
    }
  }

  const video = parseDataUri(mediaEvidence?.videoData);
  let validVideo = null;
  if (modePolicy.requireVideo) {
    if (!video) {
      result.errors.push('Video evidence is required for this signing request.');
    } else if (!['video/webm', 'video/mp4'].includes(video.mimeType)) {
      result.errors.push('Video evidence must be a WebM or MP4 video.');
    } else if (video.buffer.length > MAX_VIDEO_BYTES) {
      result.errors.push('Video evidence is too large.');
    } else {
      validVideo = video;
    }
  }

  if (modePolicy.requireAudio && !mediaEvidence?.userMediaConstraints?.audio) {
    result.errors.push('Audio evidence is required for a RON signing request.');
  }

  if (result.errors.length) return result;

  if (validPhoto) {
    result.photo = saveEvidenceFile({
      buffer: validPhoto.buffer,
      mimeType: validPhoto.mimeType,
      documentId,
      signerEmail,
      kind: 'photo',
    });
  }

  if (validVideo) {
    result.video = saveEvidenceFile({
      buffer: validVideo.buffer,
      mimeType: validVideo.mimeType,
      documentId,
      signerEmail,
      kind: 'video',
    });
  }

  result.complete = result.errors.length === 0;
  result.evidenceHash = sha256Buffer(Buffer.from(stableJson({
    mode: result.mode,
    required: result.required,
    photoHash: result.photo?.sha256 || '',
    videoHash: result.video?.sha256 || '',
    captureStartedAt: result.captureStartedAt,
    captureStoppedAt: result.captureStoppedAt,
    photoCapturedAt: result.photoCapturedAt,
    videoStartedAt: result.videoStartedAt,
    videoStoppedAt: result.videoStoppedAt,
  })));
  return result;
};

module.exports = {
  evidencePolicyFor,
  normalizeEvidenceMode,
  normalizeEvidencePolicy,
  normalizeRonConfig,
  validateEvidencePolicy,
  processSigningMediaEvidence,
  SA_PROVINCES,
  SA_DOCUMENT_TYPES,
};
