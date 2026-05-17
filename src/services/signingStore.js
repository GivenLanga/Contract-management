import { LEGAL_FOLDER_UPDATED, getLegalFolderImport } from './legalFolderStore.js';
import { normalizeFieldForStorage, defaultFieldValue, SIGNATURE_FIELD_TYPES } from './signingFields.js';

export const SIGNING_UPDATED = 'signing-updated';

const SIGNING_KEY = 'clm_local_signing_records';

const nowIso = () => new Date().toISOString();

const fromStorage = (fallback = []) => {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(SIGNING_KEY);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const toStorage = (records) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SIGNING_KEY, JSON.stringify(records));
  window.dispatchEvent(new Event(SIGNING_UPDATED));
};

export const subscribeToSigning = (callback) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SIGNING_UPDATED, callback);
  window.addEventListener(LEGAL_FOLDER_UPDATED, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(SIGNING_UPDATED, callback);
    window.removeEventListener(LEGAL_FOLDER_UPDATED, callback);
    window.removeEventListener('storage', callback);
  };
};

const shortHash = (value) => {
  let hash = 0;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().padStart(8, '0');
};

const roleBlueprints = {
  Addendum: ['Party 1', 'Party 2'],
  Assistance: ['Provider', 'Beneficiary'],
  Consultancy: ['Company', 'Consultant'],
  Loan: ['Lender', 'Borrower'],
  MSA: ['Client', 'Service Provider'],
  Service: ['Client', 'Service Provider'],
  NDA: ['Disclosing Party', 'Receiving Party'],
  SOW: ['Client', 'Service Provider'],
  Vendor: ['Company', 'Vendor'],
  License: ['Licensor', 'Licensee'],
  Employment: ['Employer', 'Employee'],
  DPA: ['Controller', 'Processor'],
  Partnership: ['Partner 1', 'Partner 2'],
};

export const signerRolesForContract = (contract) =>
  roleBlueprints[contract?.type] || ['Party 1', 'Party 2'];

const makeField = (role, index, email = '') => ({
  id: `field_${index}`,
  type: 'signature',
  page: 1,
  x: 0.12,
  y: Math.min(0.84, 0.18 + index * 0.1),
  width: 0.28,
  height: 0.064,
  coordinateOrigin: 'normalized',
  assignedTo: email,
  role,
  required: true,
  filled: false,
});

const defaultSigningFields = (doc, contract) =>
  signerRolesForContract(contract || doc?.contract).map((role, index) => makeField(role, index));

const getRecords = () => fromStorage([]);

const saveRecord = (record) => {
  const records = getRecords();
  const next = records.filter((item) => item.docId !== record.docId);
  next.push(record);
  toStorage(next);
};

const recordFor = (docId) => getRecords().find((record) => record.docId === docId);

const legalFolderDocuments = () => {
  const snapshot = getLegalFolderImport();
  const contractMap = new Map(snapshot.contracts.map((contract) => [contract.id, contract]));

  return snapshot.documents
    .filter((doc) => doc.lifecycleStage === 'FINAL' || doc.lifecycleStage === 'SIGNED')
    .map((doc) => {
    const contract = contractMap.get(doc.contract?.id) ||
      snapshot.contracts.find((item) => item.title === doc.contract?.title) ||
      null;
    const record = recordFor(doc._id);
    const fields = record?.signingFields || defaultSigningFields(doc, contract);
    const signatures = record?.signatures || [];
    const status = record?.status || (doc.lifecycleStage === 'SIGNED' ? 'Signed' : 'Ready for Signature');

    return {
      ...doc,
      ...record,
      _id: doc._id,
      name: doc.name,
      type: doc.type,
      size: doc.size,
      source: doc.source,
      sourcePath: doc.sourcePath,
      contract: contract
        ? { id: contract.id, title: contract.title, type: contract.type }
        : doc.contract,
      uploadedBy: record?.preparedBy || doc.uploadedBy || { name: 'Shared Folder' },
      updatedAt: record?.updatedAt || doc.updatedAt,
      status,
      signingFields: fields,
      signatures,
      auditLogs: record?.auditLogs || [
        {
          action: 'Imported from Legal Folder',
          performedBy: { name: 'Shared Folder' },
          createdAt: doc.updatedAt || nowIso(),
        },
      ],
      inferredSignerRoles: signerRolesForContract(contract),
      readyForEnvelope: status === 'Ready for Signature',
    };
  });
};

export const getSigningDocuments = () => legalFolderDocuments();

export const getSigningDocument = (docId) =>
  getSigningDocuments().find((doc) => doc._id === docId) || null;

export const requestSigning = (docId, payload, user) => {
  const doc = getSigningDocument(docId);
  if (!doc) throw new Error('Document not found in Legal Folder.');

  const signers = payload.signers || [];
  const fields = (payload.fields?.length ? payload.fields : defaultSigningFields(doc)).map((field, index) => ({
    ...normalizeFieldForStorage(field, payload.pageMetrics),
    id: field.id || `field_${index}`,
    assignedTo: field.assignedTo || signers[index]?.email || '',
    role: field.role || signers[index]?.role || `Signer ${index + 1}`,
    required: true,
    filled: false,
    fieldValue: undefined,
  }));

  const preparedBy = user
    ? { name: user.name || user.email || 'Current User', email: user.email, _id: user._id }
    : { name: 'Current User' };

  saveRecord({
    docId,
    status: 'Pending Signature',
    signers,
    signingFields: fields,
    signingPreparation: {
      ...(doc.signingPreparation || {}),
      pageMetrics: payload.pageMetrics || doc.signingPreparation?.pageMetrics,
    },
    signingEvidence: {
      mode: payload.evidenceMode || 'standard',
      ...(payload.evidenceMode === 'ron' ? { ron: payload.ronConfig || {} } : {}),
    },
    signingOrder: payload.signingOrder || 'parallel',
    message: payload.message || '',
    preparedBy,
    updatedAt: nowIso(),
    signatures: doc.signatures || [],
    auditLogs: [
      {
        action: `Envelope sent to ${signers.length} signer${signers.length === 1 ? '' : 's'}`,
        performedBy: preparedBy,
        createdAt: nowIso(),
      },
      ...(doc.auditLogs || []),
    ],
  });
};

export const signDocument = (docId, payload, user) => {
  const doc = getSigningDocument(docId);
  if (!doc) throw new Error('Document not found in Legal Folder.');
  if (payload.consentAccepted !== true) throw new Error('Electronic signature consent is required before signing.');

  const signerEmail = user?.email || payload.signerEmail || 'local-signer@contractiq.local';
  const signerName = user?.name || payload.signerName || signerEmail;
  const isConfiguredSigner = !doc.signers?.length || doc.signers.some((signer) =>
    String(signer.email || '').trim().toLowerCase() === String(signerEmail || '').trim().toLowerCase()
  );
  if (!isConfiguredSigner) throw new Error('You are not a signer on this document.');

  const fields = doc.signingFields?.length
    ? doc.signingFields.map((field) => ({ ...field, required: true }))
    : [makeField(payload.signerRole || 'Signatory', 0, signerEmail)];
  const allowUnassigned = !doc.signers?.length || doc.signers.length <= 1;
  const signerOwnsField = (field) => field.assignedTo === signerEmail || (allowUnassigned && !field.assignedTo);
  const fieldValues = payload.fieldValues && typeof payload.fieldValues === 'object' ? payload.fieldValues : {};
  const signatureIndex = fields.findIndex((field) =>
    !field.filled &&
    signerOwnsField(field) &&
    (
      (payload.fieldId && field.id === payload.fieldId) ||
      SIGNATURE_FIELD_TYPES.has(field.type)
    )
  );
  const index = signatureIndex >= 0
    ? signatureIndex
    : fields.findIndex((field) => !field.filled && signerOwnsField(field));

  if (index < 0) throw new Error('All required signing fields have already been completed.');

  const signedAt = nowIso();
  const field = fields[index];
  fields[index] = {
    ...field,
    assignedTo: field.assignedTo || signerEmail,
    filled: true,
    filledBy: signerEmail,
    filledAt: signedAt,
    fieldValue: SIGNATURE_FIELD_TYPES.has(field.type) ? field.fieldValue : defaultFieldValue(field, { email: signerEmail, name: signerName }),
  };

  fields.forEach((item, itemIndex) => {
    if (!SIGNATURE_FIELD_TYPES.has(item.type)) return;
    if (item.filled || !signerOwnsField(item)) return;
    fields[itemIndex] = {
      ...item,
      assignedTo: item.assignedTo || signerEmail,
      filled: true,
      filledBy: signerEmail,
      filledAt: signedAt,
    };
  });

  fields.forEach((item, itemIndex) => {
    if (SIGNATURE_FIELD_TYPES.has(item.type)) return;
    if (!signerOwnsField(item)) return;
    if (!Object.prototype.hasOwnProperty.call(fieldValues, item.id)) return;
    fields[itemIndex] = {
      ...item,
      assignedTo: item.assignedTo || signerEmail,
      filled: true,
      filledBy: signerEmail,
      filledAt: signedAt,
      fieldValue: fieldValues[item.id],
    };
  });

  const signature = {
    _id: `SIG-${shortHash(`${docId}-${signerEmail}-${signedAt}`)}`,
    signerName,
    signerEmail,
    signerRole: payload.signerRole || field.role || 'Signatory',
    signatureData: payload.signatureData,
    initialsData: payload.initialsData,
    method: payload.method || 'draw',
    fieldId: field.id,
    page: payload.page || field.page || 1,
    position: payload.position || {
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      origin: field.coordinateOrigin || 'normalized',
    },
    signedAt,
    evidence: {
      consentAccepted: payload.consentAccepted === true,
      consentText: 'I agree to use electronic records and signatures for this document.',
    },
    auditHash: shortHash(`${docId}-${signerEmail}-${payload.signatureData}-${signedAt}`),
  };

  const signatures = [...(doc.signatures || []), signature];
  const allSigned = fields.every((item) => item.filled);
  const performedBy = { name: signerName, email: signerEmail };

  saveRecord({
    docId,
    status: allSigned ? 'Signed' : 'Pending Signature',
    signers: doc.signers || [],
    signingFields: fields,
    signingOrder: doc.signingOrder || 'parallel',
    message: doc.message || '',
    preparedBy: doc.preparedBy || doc.uploadedBy,
    updatedAt: signedAt,
    signatures,
    auditLogs: [
      {
        action: `${signerName} signed as ${signature.signerRole}`,
        performedBy,
        performedByEmail: signerEmail,
        createdAt: signedAt,
      },
      ...(doc.auditLogs || []),
    ],
  });

  return signature;
};
