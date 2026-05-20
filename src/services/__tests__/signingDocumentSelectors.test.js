import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  documents: {
    list: vi.fn(),
  },
}));

vi.mock('../signingStore.js', () => ({
  getSigningDocuments: vi.fn(),
}));

import { documents as documentsApi } from '../api.js';
import { getSigningDocuments } from '../signingStore.js';
import {
  getDocumentSigningStatus,
  getPendingReminderSigners,
  getSentWaitingSigningDocuments,
  getSignerProgress,
} from '../signingDocumentSelectors.js';

const owner = { _id: 'mgr-1', name: 'Manager', email: 'mgr@example.com' };

const pendingDoc = {
  _id: 'doc-pending',
  name: 'Pending Agreement',
  status: 'Pending Signature',
  uploadedBy: owner,
  signers: [
    { email: 'lender@example.com', name: 'Given', role: 'Lender', signingStatus: 'not_signed' },
    { email: 'borrower@example.com', name: 'Faith', role: 'Borrower', signingStatus: 'not_signed' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  documentsApi.list.mockResolvedValue({ documents: [] });
  getSigningDocuments.mockReturnValue([]);
});

describe('signingDocumentSelectors', () => {
  it('returns the same Sent Waiting document set from merged server and local signing data', async () => {
    const docs21 = Array.from({ length: 21 }, (_, index) => ({
      ...pendingDoc,
      _id: `doc-${index}`,
      name: `Document ${index}`,
    }));
    documentsApi.list.mockResolvedValue({
      documents: [
        ...docs21,
        { ...pendingDoc, _id: 'doc-ready', status: 'Ready for Signature' },
        { ...pendingDoc, _id: 'doc-signed', status: 'Signed' },
        { ...pendingDoc, _id: 'doc-declined', status: 'Declined' },
      ],
    });

    const result = await getSentWaitingSigningDocuments({ user: owner, isManager: true });

    expect(result).toHaveLength(21);
    expect(result.map((doc) => doc.status).every((status) => status === 'Pending Signature')).toBe(true);
  });

  it('uses server documents first and falls back to local documents when server is unavailable', async () => {
    documentsApi.list.mockRejectedValue(new Error('offline'));
    getSigningDocuments.mockReturnValue([pendingDoc]);

    const result = await getSentWaitingSigningDocuments({ user: owner, isManager: true });

    expect(result).toEqual([pendingDoc]);
  });

  it('calculates 0/2 signed for pending signers', () => {
    const progress = getSignerProgress(pendingDoc);

    expect(progress.signedCount).toBe(0);
    expect(progress.totalSigners).toBe(2);
    expect(progress.pendingCount).toBe(2);
    expect(progress.signers.map((signer) => signer.status)).toEqual(['Pending', 'Pending']);
  });

  it('marks signedAt and hasSigned signers as signed without marking pending signers signed', () => {
    const progress = getSignerProgress({
      ...pendingDoc,
      signers: [
        { email: 'given@example.com', name: 'Given', role: 'Lender', signedAt: '2026-05-01T10:00:00.000Z' },
        { email: 'done@example.com', name: 'Done', role: 'Witness', hasSigned: true },
        { email: 'faith@example.com', name: 'Faith', role: 'Borrower', signingStatus: 'not_signed' },
      ],
    });

    expect(progress.signedCount).toBe(2);
    expect(progress.totalSigners).toBe(3);
    expect(progress.signers.find((signer) => signer.name === 'Faith').hasSigned).toBe(false);
  });

  it('uses signatures to calculate 1/2 signed and keeps reminder targets pending-only', () => {
    const doc = {
      ...pendingDoc,
      signatures: [{ signerEmail: 'given@example.com', signerName: 'Given', signerRole: 'Lender', signedAt: '2026-05-01T10:00:00.000Z' }],
      signers: [
        { email: 'given@example.com', name: 'Given', role: 'Lender', signingStatus: 'not_signed' },
        { email: 'faith@example.com', name: 'Faith', role: 'Borrower', signingStatus: 'not_signed' },
      ],
    };

    const progress = getSignerProgress(doc);
    const reminderSigners = getPendingReminderSigners(doc);

    expect(progress.signedCount).toBe(1);
    expect(progress.totalSigners).toBe(2);
    expect(getDocumentSigningStatus(doc)).toBe('Partially Signed');
    expect(reminderSigners.map((signer) => signer.email)).toEqual(['faith@example.com']);
  });

  it('excludes fully signed documents even if their document status is stale Pending Signature', async () => {
    documentsApi.list.mockResolvedValue({
      documents: [{
        ...pendingDoc,
        _id: 'doc-stale',
        signers: pendingDoc.signers.map((signer) => ({ ...signer, signingStatus: 'signed' })),
      }],
    });

    const result = await getSentWaitingSigningDocuments({ user: owner, isManager: true });

    expect(result).toEqual([]);
  });
});
