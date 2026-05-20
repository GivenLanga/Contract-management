import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ user: { _id: 'mgr-1', name: 'Manager', email: 'mgr@example.com' } }),
}));

vi.mock('../../../services/signingStore', () => ({
  getSigningDocument: vi.fn(),
  signDocument: vi.fn(),
  subscribeToSigning: vi.fn(() => vi.fn()),
}));

vi.mock('../../../services/api', () => ({
  documents: {
    get: vi.fn(),
    viewUrl: vi.fn(() => '/api/documents/doc-view'),
  },
  signing: {
    getSignatures: vi.fn(),
    sign: vi.fn(),
    auditTrail: vi.fn(),
    completionCertificate: vi.fn(),
  },
}));

vi.mock('../../../services/legalFolderFileStore', () => ({
  getLegalFolderFile: vi.fn().mockResolvedValue(null),
  canRenderDocxPreview: vi.fn(() => false),
}));

vi.mock('../../../services/docxPreviewRenderer', () => ({
  renderDocxPreview: vi.fn(),
}));

vi.mock('../../../services/signingEvidenceClient', () => ({
  collectSigningClientEvidence: vi.fn().mockResolvedValue({}),
}));

vi.mock('../PdfDocumentPreview', () => ({
  default: () => <div>PDF preview</div>,
}));

vi.mock('../SignatureModal', () => ({
  default: () => null,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { getSigningDocument } from '../../../services/signingStore';
import SigningViewer from '../SigningViewer';

const doc = {
  _id: 'doc-sig-1',
  name: 'NDA - Acme Corp',
  type: 'docx',
  status: 'Pending Signature',
  sourcePath: 'Legal Folder/NDA - Acme Corp.docx',
  signers: [],
  signingFields: [],
  signatures: [],
  auditLogs: [],
};

function renderViewer(entry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/signing/view/:docId" element={<SigningViewer />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSigningDocument.mockReturnValue(doc);
});

describe('SigningViewer back navigation', () => {
  it('returns to Signature Follow-Ups when opened from Tasks route state', async () => {
    renderViewer({
      pathname: '/signing/view/doc-sig-1',
      state: {
        returnTo: '/tasks?tab=signature-follow-ups',
        returnLabel: 'Signature Follow-Ups',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /^back$/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/tasks?tab=signature-follow-ups');
  });

  it('falls back to Signing when no return context exists', async () => {
    renderViewer('/signing/view/doc-sig-1');

    fireEvent.click(await screen.findByRole('button', { name: /^back$/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/signing');
  });

  it('returns to Signing when opened with Signing dashboard return context', async () => {
    renderViewer({
      pathname: '/signing/view/doc-sig-1',
      state: {
        returnTo: '/signing',
        returnLabel: 'Signing',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /^back$/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/signing');
  });

  it('uses return context for the document-not-found back button', async () => {
    getSigningDocument.mockReturnValue(null);
    renderViewer({
      pathname: '/signing/view/local-missing',
      state: {
        returnTo: '/tasks?tab=signature-follow-ups',
        returnLabel: 'Signature Follow-Ups',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /back to signature follow-ups/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/tasks?tab=signature-follow-ups');
  });
});
