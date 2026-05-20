import { getSigningDocuments } from './signingStore';
import { documents as documentsApi } from './api';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeStatus = (value) => String(value || '').trim().toLowerCase().replace(/[\s\u2013\u2014-]+/g, '_');

const SIGNED_STATUSES = new Set(['signed', 'completed', 'complete']);
const DECLINED_STATUSES = new Set(['declined', 'rejected']);
const VIEWED_STATUSES = new Set(['viewed']);
const SENT_WAITING_STATUSES = new Set(['pending_signature', 'sent', 'awaiting_signature', 'sent_waiting']);

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

export function mergeSigningDocuments(serverDocs = [], localDocs = []) {
  const merged = new Map();
  serverDocs.forEach((doc) => {
    if (doc?._id) merged.set(doc._id, doc);
  });
  localDocs.forEach((doc) => {
    if (doc?._id && !merged.has(doc._id)) merged.set(doc._id, doc);
  });
  return Array.from(merged.values());
}

const ownerMatchesUser = (owner, user) => {
  if (!owner || !user) return false;
  return (
    (user._id && owner._id && String(owner._id) === String(user._id)) ||
    (user.email && owner.email && normalizeEmail(owner.email) === normalizeEmail(user.email))
  );
};

export function canAccessSentWaitingDocument(doc, { user, isManager } = {}) {
  if (isManager) return true;
  if (!user) return false;
  return ownerMatchesUser(doc?.uploadedBy, user) || (!doc?.uploadedBy && ownerMatchesUser(doc?.preparedBy, user));
}

const signatureEmail = (signature) => normalizeEmail(signature?.signerEmail || signature?.email);

const fieldEmail = (field) => normalizeEmail(field?.assignedTo || field?.email);

function buildSignatureMap(signatures = []) {
  const map = new Map();
  signatures.forEach((signature) => {
    const email = signatureEmail(signature);
    if (email && !map.has(email)) map.set(email, signature);
  });
  return map;
}

function buildFieldsByEmail(fields = []) {
  const map = new Map();
  const unassigned = [];
  fields.forEach((field) => {
    const email = fieldEmail(field);
    if (!email) {
      if (field?.required !== false) unassigned.push(field);
      return;
    }
    if (!map.has(email)) map.set(email, []);
    map.get(email).push(field);
  });
  return { fieldsByEmail: map, unassigned };
}

const fieldIsFilled = (field) => Boolean(field?.filled || field?.filledAt || field?.completedAt);

const allFieldsFilled = (fields = []) => fields.length > 0 && fields.every(fieldIsFilled);

export function isSignerSigned(signer = {}, doc = {}) {
  const status = normalizeStatus(firstValue(signer.signingStatus, signer.status));
  if (signer.hasSigned === true) return true;
  if (SIGNED_STATUSES.has(status)) return true;
  if (signer.signedAt || signer.completedAt) return true;

  const email = normalizeEmail(signer.email);
  if (email && (doc.signatures || []).some((signature) => signatureEmail(signature) === email)) return true;

  if (email) {
    const signerFields = (doc.signingFields || []).filter((field) => fieldEmail(field) === email);
    if (allFieldsFilled(signerFields)) return true;
  }

  return false;
}

function signerDisplayStatus(signer, hasSigned) {
  if (hasSigned) return 'Signed';
  const status = normalizeStatus(firstValue(signer.signingStatus, signer.status));
  if (DECLINED_STATUSES.has(status)) return status === 'declined' ? 'Declined' : 'Rejected';
  if (VIEWED_STATUSES.has(status) || signer.viewedAt) return 'Viewed';
  return 'Pending';
}

function rowFromSigner(signer, doc, signatureMap, fieldsByEmail) {
  const email = normalizeEmail(signer.email);
  const signature = email ? signatureMap.get(email) : null;
  const signerFields = email ? (fieldsByEmail.get(email) || []) : [];
  const hasSigned = isSignerSigned(signer, doc);
  return {
    name: firstValue(signature?.signerName, signer.name, signer.email, 'Signer'),
    email: signer.email || '',
    role: firstValue(signer.role, signature?.signerRole, 'Signatory'),
    status: signerDisplayStatus(signer, hasSigned),
    hasSigned,
    signedAt: firstValue(signer.signedAt, signer.completedAt, signature?.signedAt, signerFields.find(fieldIsFilled)?.filledAt),
    viewedAt: signer.viewedAt || null,
    lastReminderAt: firstValue(signer.lastReminderAt, signer.remindedAt, signer.reminderSentAt),
    signingStatus: firstValue(signer.signingStatus, signer.status),
  };
}

function rowFromFieldGroup(key, fields, signatureMap) {
  const first = fields[0] || {};
  const email = key === '__unassigned__' ? '' : key;
  const signature = email ? signatureMap.get(email) : null;
  const hasSigned = Boolean(signature) || allFieldsFilled(fields);
  return {
    name: firstValue(signature?.signerName, first.assignedTo, first.role, 'Signer'),
    email,
    role: firstValue(first.role, signature?.signerRole, 'Signatory'),
    status: hasSigned ? 'Signed' : 'Pending',
    hasSigned,
    signedAt: firstValue(signature?.signedAt, fields.find(fieldIsFilled)?.filledAt),
    viewedAt: null,
    lastReminderAt: null,
    signingStatus: hasSigned ? 'signed' : 'not_signed',
  };
}

function rowFromSignature(signature) {
  return {
    name: firstValue(signature.signerName, signature.signerEmail, 'Signer'),
    email: signature.signerEmail || '',
    role: firstValue(signature.signerRole, 'Signatory'),
    status: 'Signed',
    hasSigned: true,
    signedAt: signature.signedAt || null,
    viewedAt: null,
    lastReminderAt: null,
    signingStatus: 'signed',
  };
}

export function getSignerProgress(doc = {}) {
  const signatures = Array.isArray(doc.signatures) ? doc.signatures : [];
  const fields = Array.isArray(doc.signingFields) ? doc.signingFields : [];
  const signers = Array.isArray(doc.signers) ? doc.signers : [];
  const signatureMap = buildSignatureMap(signatures);
  const { fieldsByEmail, unassigned } = buildFieldsByEmail(fields);
  const rows = [];

  signers.forEach((signer) => {
    rows.push(rowFromSigner(signer, doc, signatureMap, fieldsByEmail));
  });

  fieldsByEmail.forEach((signerFields, email) => {
    if (rows.some((row) => normalizeEmail(row.email) === email)) return;
    rows.push(rowFromFieldGroup(email, signerFields, signatureMap));
  });

  if (!signers.length && unassigned.length) {
    rows.push(rowFromFieldGroup('__unassigned__', unassigned, signatureMap));
  }

  signatures.forEach((signature) => {
    const email = signatureEmail(signature);
    if (email && rows.some((row) => normalizeEmail(row.email) === email)) return;
    rows.push(rowFromSignature(signature));
  });

  const signedCount = rows.filter((row) => row.hasSigned).length;
  const totalSigners = rows.length;

  return {
    signedCount,
    totalSigners,
    pendingCount: Math.max(0, totalSigners - signedCount),
    signers: rows,
  };
}

export function getDocumentSigningStatus(doc = {}) {
  const progress = getSignerProgress(doc);
  const docStatus = normalizeStatus(doc.status);
  const hasDeclinedSigner = progress.signers.some((signer) => DECLINED_STATUSES.has(normalizeStatus(signer.signingStatus || signer.status)));

  if (docStatus === 'declined' || hasDeclinedSigner) return 'Declined';
  if (progress.totalSigners > 0 && progress.signedCount === progress.totalSigners) return 'Completed';
  if (progress.signedCount > 0) return 'Partially Signed';
  if (docStatus === 'pending_signature') return 'Pending Signature';
  return 'Awaiting Signatures';
}

export function isFullySignedDocument(doc = {}) {
  const progress = getSignerProgress(doc);
  return progress.totalSigners > 0 && progress.signedCount === progress.totalSigners;
}

export function isSentWaitingSigningDocument(doc = {}) {
  const docStatus = normalizeStatus(doc.status);
  if (!SENT_WAITING_STATUSES.has(docStatus)) return false;
  if (docStatus === 'declined' || DECLINED_STATUSES.has(docStatus)) return false;
  return !isFullySignedDocument(doc);
}

export function selectSentWaitingSigningDocuments(docs = [], options = {}) {
  const { applyAccessFilter = true } = options;
  return docs.filter((doc) => {
    if (!isSentWaitingSigningDocument(doc)) return false;
    if (!applyAccessFilter) return true;
    return canAccessSentWaitingDocument(doc, options);
  });
}

export async function getSentWaitingSigningDocuments(options = {}) {
  const localDocs = getSigningDocuments();
  let serverDocs;
  try {
    const data = await documentsApi.list({ limit: options.limit || 200 });
    serverDocs = data.documents || [];
  } catch {
    serverDocs = [];
  }
  return selectSentWaitingSigningDocuments(mergeSigningDocuments(serverDocs, localDocs), options);
}

export function getPendingReminderSigners(doc = {}) {
  return getSignerProgress(doc).signers.filter((signer) => {
    const status = normalizeStatus(signer.signingStatus || signer.status);
    return !signer.hasSigned && !DECLINED_STATUSES.has(status) && Boolean(signer.email);
  });
}
