const envInt = (name, fallback, min) => {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const MAX_DOCUMENTS = envInt('AI_SIGNING_STATE_MAX_DOCUMENTS', 500, 1);
const MAX_PARTICIPANTS = envInt('AI_SIGNING_STATE_MAX_PARTICIPANTS', 80, 1);
const MAX_TEXT = 240;

const cleanText = (value, max = MAX_TEXT) =>
  String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const cleanEmail = (value) =>
  String(value || '').trim().toLowerCase().slice(0, 320);

const cleanId = (value) => cleanText(value, 128);

const cleanDate = (value) => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
};

const cleanPerson = (value = {}) => ({
  _id: cleanId(value._id || value.id || value.userId),
  name: cleanText(value.name),
  email: cleanEmail(value.email),
});

const cleanSigner = (value = {}) => ({
  email: cleanEmail(value.email),
  name: cleanText(value.name),
  role: cleanText(value.role, 120),
  userId: cleanId(value.userId),
  type: cleanText(value.type, 40),
});

const cleanField = (value = {}) => ({
  id: cleanId(value.id),
  type: cleanText(value.type, 40),
  assignedTo: cleanEmail(value.assignedTo),
  role: cleanText(value.role, 120),
  required: value.required !== false,
  filled: value.filled === true,
  filledBy: cleanEmail(value.filledBy),
  filledAt: cleanDate(value.filledAt),
});

const cleanSignature = (value = {}) => ({
  signerEmail: cleanEmail(value.signerEmail),
  signerName: cleanText(value.signerName),
  signerRole: cleanText(value.signerRole, 120),
  signedAt: cleanDate(value.signedAt),
});

class ClientSigningStateService {
  constructor() {
    this._state = new Map();
  }

  sync({ userId, documents }) {
    const key = String(userId || '');
    if (!key) return { indexedDocuments: 0, syncedAt: null };

    const safeDocuments = (Array.isArray(documents) ? documents : [])
      .slice(0, MAX_DOCUMENTS)
      .map((doc) => this._cleanDocument(doc))
      .filter((doc) => doc._id && doc.name);

    const syncedAt = new Date();
    this._state.set(key, { documents: safeDocuments, syncedAt });

    return {
      indexedDocuments: safeDocuments.length,
      syncedAt,
    };
  }

  getDocuments(userId) {
    const entry = this._state.get(String(userId || ''));
    return entry?.documents || [];
  }

  getStatus(userId) {
    const entry = this._state.get(String(userId || ''));
    return {
      indexedDocuments: entry?.documents?.length || 0,
      syncedAt: entry?.syncedAt || null,
    };
  }

  _cleanDocument(doc = {}) {
    const contractTitle = cleanText(doc.contractTitle || doc.contract?.title);
    const contractId = cleanText(doc.contractId || doc.contract?.contractId || doc.contract?.id, 120);

    return {
      _id: cleanId(doc.id || doc._id),
      source: 'browser_signing_state',
      name: cleanText(doc.name),
      type: cleanText(doc.type, 40),
      status: cleanText(doc.status, 80),
      contract: contractTitle || contractId ? { title: contractTitle, contractId } : null,
      uploadedBy: cleanPerson(doc.uploadedBy || doc.preparedBy),
      updatedAt: cleanDate(doc.updatedAt),
      signingOrder: cleanText(doc.signingOrder, 40),
      signers: (Array.isArray(doc.signers) ? doc.signers : [])
        .slice(0, MAX_PARTICIPANTS)
        .map(cleanSigner),
      signingFields: (Array.isArray(doc.signingFields) ? doc.signingFields : [])
        .slice(0, MAX_PARTICIPANTS)
        .map(cleanField),
      signatures: (Array.isArray(doc.signatures) ? doc.signatures : [])
        .slice(0, MAX_PARTICIPANTS)
        .map(cleanSignature),
    };
  }
}

let instance;
const getClientSigningStateService = () => {
  if (!instance) instance = new ClientSigningStateService();
  return instance;
};

module.exports = {
  ClientSigningStateService,
  getClientSigningStateService,
};
