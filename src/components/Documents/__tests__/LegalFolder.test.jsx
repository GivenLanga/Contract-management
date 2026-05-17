import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { clearLegalFolderImport, saveLegalFolderImport } from '../../../services/legalFolderStore.js';
import LegalFolder from '../LegalFolder.jsx';

vi.mock('../../../services/legalFolderFileStore', () => ({
  clearLegalFolderFiles: vi.fn(() => Promise.resolve()),
  replaceLegalFolderFiles: vi.fn(() => Promise.resolve({ stored: 0 })),
}));

vi.mock('../../../services/legalFolderRagSync', () => ({
  syncLegalFolderRagIndex: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../services/api', () => ({
  templates: { disconnectSource: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../../../services/legalFolderHandle', () => ({
  setLegalFolderHandle: vi.fn(),
  clearLegalFolderHandle: vi.fn(),
  saveHandleToIndexedDB: vi.fn(() => Promise.resolve()),
  clearHandleFromIndexedDB: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../services/legalFolderAccess', () => ({
  FOLDER_STATE: {
    DISCONNECTED: 'DISCONNECTED',
    INDEX_ONLY: 'INDEX_ONLY',
    UNSUPPORTED_BROWSER: 'UNSUPPORTED_BROWSER',
    WRITE_REAUTH_REQUIRED: 'WRITE_REAUTH_REQUIRED',
    WRITE_READY: 'WRITE_READY',
  },
  getLegalFolderStatus: vi.fn(() => Promise.resolve({ state: 'WRITE_READY' })),
}));

const source = {
  importerVersion: 5,
  importerMode: 'legal-folder-lifecycle',
  name: 'Legal Folder',
  sourceId: 'src-1',
  syncedAt: new Date().toISOString(),
  contractCount: 1,
  fileCount: 2,
  scannedFileCount: 2,
  skippedFileCount: 0,
  lifecycleSummary: { templates: 1, drafts: 1, finals: 0, signed: 0, unknown: 0 },
};

beforeEach(() => {
  window.localStorage.clear();
  clearLegalFolderImport();
  delete window.contractiq;
});

describe('LegalFolder lifecycle UI', () => {
  it('shows stage badges for indexed files', async () => {
    saveLegalFolderImport({
      source,
      contracts: [],
      documents: [
        {
          _id: 'tpl-1',
          name: 'Addendum Template.docx',
          type: 'docx',
          sourcePath: 'Templates/Addendum Template.docx',
          updatedAt: new Date().toISOString(),
          uploadedBy: { name: 'Shared Folder' },
          lifecycleStage: 'TEMPLATE',
          status: 'Template',
        },
        {
          _id: 'draft-1',
          name: 'Agreement - Draft v1.docx',
          type: 'docx',
          sourcePath: 'Contracts/2026/Service Providers/Acme/Drafts/Agreement - Draft v1.docx',
          updatedAt: new Date().toISOString(),
          uploadedBy: { name: 'Acme' },
          lifecycleStage: 'DRAFT',
          category: 'Service Providers',
          company: 'Acme',
          year: '2026',
          status: 'Draft',
        },
      ],
    });

    render(<LegalFolder />);

    await waitFor(() => {
      expect(screen.getByText('Template')).toBeInTheDocument();
      expect(screen.getByText('Draft')).toBeInTheDocument();
    });
  });

  it('disconnect clears the local Legal Folder index', async () => {
    saveLegalFolderImport({
      source,
      contracts: [],
      documents: [{
        _id: 'tpl-1',
        name: 'Addendum Template.docx',
        type: 'docx',
        sourcePath: 'Templates/Addendum Template.docx',
        updatedAt: new Date().toISOString(),
        uploadedBy: { name: 'Shared Folder' },
        lifecycleStage: 'TEMPLATE',
        status: 'Template',
      }],
    });

    render(<LegalFolder />);
    await waitFor(() => screen.getByText('Addendum Template.docx'));
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(screen.getByText('No shared folder connected')).toBeInTheDocument();
    });
  });
});
