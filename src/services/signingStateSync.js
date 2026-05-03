import { ai } from './api';
import { getSigningDocuments } from './signingStore';

const MAX_SIGNING_DOCUMENTS = 500;
const MAX_PARTICIPANTS = 80;

const safePerson = (value = {}) => ({
  _id: value._id || value.id || value.userId || '',
  name: value.name || '',
  email: value.email || '',
});

const safeSigner = (value = {}) => ({
  email: value.email || '',
  name: value.name || '',
  role: value.role || '',
  userId: value.userId || '',
  type: value.type || '',
});

const safeField = (value = {}) => ({
  id: value.id || '',
  type: value.type || 'signature',
  assignedTo: value.assignedTo || '',
  role: value.role || '',
  required: value.required !== false,
  filled: value.filled === true,
  filledBy: value.filledBy || '',
  filledAt: value.filledAt || '',
});

const safeSignature = (value = {}) => ({
  signerEmail: value.signerEmail || '',
  signerName: value.signerName || '',
  signerRole: value.signerRole || '',
  signedAt: value.signedAt || '',
});

export const syncSigningStateIndex = async () => {
  const documents = getSigningDocuments()
    .slice(0, MAX_SIGNING_DOCUMENTS)
    .map((doc) => ({
      id: doc._id,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      contractTitle: doc.contract?.title,
      contractId: doc.contract?.contractId || doc.contract?.id,
      uploadedBy: safePerson(doc.uploadedBy || doc.preparedBy),
      updatedAt: doc.updatedAt,
      signingOrder: doc.signingOrder,
      signers: (doc.signers || []).slice(0, MAX_PARTICIPANTS).map(safeSigner),
      signingFields: (doc.signingFields || []).slice(0, MAX_PARTICIPANTS).map(safeField),
      signatures: (doc.signatures || []).slice(0, MAX_PARTICIPANTS).map(safeSignature),
    }));

  return ai.syncSigningState({ documents });
};
