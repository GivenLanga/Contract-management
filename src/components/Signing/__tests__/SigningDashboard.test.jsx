import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ user: { _id: 'mgr-1', name: 'Manager', email: 'mgr@example.com' }, isManager: true }),
}));

vi.mock('../../../services/signingStore', () => ({
  getSigningDocuments: vi.fn(),
  subscribeToSigning: vi.fn(() => vi.fn()),
}));

vi.mock('../../../services/api', () => ({
  documents: {
    list: vi.fn(),
  },
  signing: {
    remind: vi.fn(),
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { documents as documentsApi } from '../../../services/api';
import { getSigningDocuments } from '../../../services/signingStore';
import SigningDashboard from '../SigningDashboard';

const pendingDoc = {
  _id: 'doc-waiting',
  name: 'Funding Agreement',
  status: 'Pending Signature',
  uploadedBy: { _id: 'mgr-1', name: 'Manager', email: 'mgr@example.com' },
  updatedAt: '2026-05-15T10:00:00.000Z',
  signers: [
    { email: 'borrower@example.com', name: 'Borrower', role: 'Borrower', signingStatus: 'not_signed' },
  ],
  signingFields: [{ id: 'f1', assignedTo: 'borrower@example.com', role: 'Borrower', required: true, filled: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getSigningDocuments.mockReturnValue([pendingDoc]);
  documentsApi.list.mockResolvedValue({ documents: [] });
});

describe('SigningDashboard Sent Waiting regression', () => {
  it('still renders Sent Waiting documents from the shared selector', async () => {
    render(<MemoryRouter><SigningDashboard /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /sent — waiting/i }));

    expect(await screen.findByText('Funding Agreement')).toBeInTheDocument();
    expect(screen.getByText('0/1 signed')).toBeInTheDocument();
  });

  it('keeps View Document and Audit Trail navigation behavior', async () => {
    render(<MemoryRouter><SigningDashboard /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /sent — waiting/i }));
    await screen.findByText('Funding Agreement');

    fireEvent.click(screen.getByRole('button', { name: /view document/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/signing/view/doc-waiting', {
      state: { returnTo: '/signing', returnLabel: 'Signing' },
    });

    fireEvent.click(screen.getByRole('button', { name: /audit trail/i }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/signing/view/doc-waiting?panel=activity', {
        state: { returnTo: '/signing', returnLabel: 'Signing' },
      });
    });
  });
});
