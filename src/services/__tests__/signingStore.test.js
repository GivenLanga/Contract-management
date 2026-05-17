import { beforeEach, describe, expect, it } from 'vitest';
import { clearLegalFolderImport, saveLegalFolderImport } from '../legalFolderStore.js';
import { getSigningDocuments } from '../signingStore.js';

const source = {
  importerVersion: 5,
  name: 'Legal Folder',
  syncedAt: new Date().toISOString(),
  contractCount: 1,
  fileCount: 2,
  scannedFileCount: 2,
  skippedFileCount: 0,
};

const contract = {
  id: 'LF-1',
  title: 'Service Agreement - Acme',
  type: 'Service',
  counterparty: 'Acme',
  tags: ['Service'],
};

const baseDoc = {
  _id: 'doc-final',
  name: 'Agreement - Final v1.docx',
  type: 'docx',
  size: 10,
  updatedAt: new Date().toISOString(),
  uploadedBy: { name: 'Legal Folder' },
  contract: { id: contract.id, title: contract.title },
  source: 'shared-folder',
  sourcePath: 'Contracts/2026/Service Providers/Acme/Final/Agreement - Final v1.docx',
};

beforeEach(() => {
  window.localStorage.clear();
  clearLegalFolderImport();
});

describe('signingStore lifecycle filtering', () => {
  it('excludes DRAFT and includes FINAL documents for the ready list', () => {
    saveLegalFolderImport({
      source,
      contracts: [contract],
      documents: [
        { ...baseDoc, _id: 'doc-draft', name: 'Agreement - Draft v1.docx', lifecycleStage: 'DRAFT' },
        { ...baseDoc, lifecycleStage: 'FINAL' },
      ],
    });

    const docs = getSigningDocuments();
    expect(docs.map((doc) => doc._id)).toEqual(['doc-final']);
    expect(docs[0].status).toBe('Ready for Signature');
    expect(docs[0].readyForEnvelope).toBe(true);
  });

  it('includes SIGNED documents as completed records', () => {
    saveLegalFolderImport({
      source,
      contracts: [contract],
      documents: [{ ...baseDoc, _id: 'doc-signed', lifecycleStage: 'SIGNED' }],
    });

    const docs = getSigningDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe('Signed');
    expect(docs[0].readyForEnvelope).toBe(false);
  });
});
