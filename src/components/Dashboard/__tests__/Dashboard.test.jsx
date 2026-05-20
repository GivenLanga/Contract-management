import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { _id: 'mgr-1', name: 'Admin Manager', email: 'admin@example.com' },
    isManager: true,
  }),
}));

vi.mock('../../../context/NotificationContext', () => ({
  useNotifications: () => ({ unreadCount: 0 }),
}));

vi.mock('../../../services/legalFolderStore', () => ({
  LEGAL_FOLDER_UPDATED: 'legal-folder-updated',
  getContractsForApp: vi.fn(() => []),
}));

vi.mock('../../../services/signingStore', () => ({
  subscribeToSigning: vi.fn(() => vi.fn()),
}));

vi.mock('../../../services/dashboardSelectors', () => ({
  getDashboardData: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { getDashboardData } from '../../../services/dashboardSelectors';
import Dashboard from '../Dashboard';

const dashboardFixture = {
  operations: {
    activeWorkflows: 11,
    overdueTasks: 2,
    dueToday: 3,
    unassignedTasks: 1,
    trackerTasks: 10,
    trackerWarnings: 4,
    signatureFollowUps: 21,
    workQueueItems: [],
  },
  contractSummary: {
    totalSignedContracts: 2,
    activeContracts: 1,
    expiringIn30Days: 1,
    expiredContracts: 0,
    unknownContracts: 0,
    contractsWithValue: 1,
    contractsMissingValue: 1,
    portfolioValue: 510000,
  },
  contractPipeline: {
    active: 1,
    expiringSoon: 1,
    expired: 0,
    unknown: 0,
    items: [
      { key: 'active', label: 'Active', status: 'Active', count: 1, color: '#10b981' },
      { key: 'expiringSoon', label: 'Expiring Soon', status: 'Expiring Soon', count: 1, color: '#f59e0b' },
      { key: 'expired', label: 'Expired', status: 'Expired', count: 0, color: '#ef4444' },
      { key: 'unknown', label: 'Unknown', status: 'Unknown', count: 0, color: '#94a3b8' },
    ],
  },
  contractsNeedingAttention: [
    {
      id: 'soon',
      title: 'Soon Signed Agreement',
      counterparty: 'Acme',
      type: 'Service',
      portfolioStatus: 'Expiring Soon',
      endDate: '2026-05-31',
      daysRemaining: 11,
      value: 510000,
      contractValueDisplay: 'R 510 000',
    },
    {
      id: 'later',
      title: 'Later Signed Agreement',
      counterparty: 'Beta',
      type: 'Loan',
      portfolioStatus: 'Active',
      endDate: '2026-06-30',
      daysRemaining: 41,
      value: null,
    },
  ],
  diagnostics: {
    workflowActive: 11,
    signatureFollowUps: 21,
    signedContracts: 2,
    portfolioValue: 510000,
  },
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  getDashboardData.mockResolvedValue(dashboardFixture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard current data view', () => {
  it('does not import old mock/report/legal request sources', () => {
    const source = fs.readFileSync(path.resolve('src/components/Dashboard/Dashboard.jsx'), 'utf8');

    expect(source).not.toMatch(/mockData|sampleContracts|demoContracts/);
    expect(source).not.toMatch(/legalRequests|legalRequest|Legal Requests/);
    expect(source).not.toMatch(/reportsApi|tasksApi/);
  });

  it('renders operations and signed contract portfolio from Dashboard selectors', async () => {
    renderDashboard();

    expect(await screen.findByText('Active Workflows')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('Tracker Tasks')).toBeInTheDocument();
    expect(screen.getByText('Signature Follow-ups')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();

    expect(screen.getByText('Total Signed Contracts')).toBeInTheDocument();
    expect(screen.getByText('Active Contracts')).toBeInTheDocument();
    expect(screen.getByText('Expiring in 30d')).toBeInTheDocument();
    expect(screen.getByText('Soon Signed Agreement')).toBeInTheDocument();
    expect(screen.getByText('11 days left')).toBeInTheDocument();
  });

  it('shows the current signed contract pipeline and not stale Draft or Approved buckets', async () => {
    renderDashboard();

    expect(await screen.findByText('Contract Pipeline')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Expiring Soon').length).toBeGreaterThan(0);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
  });

  it('does not show stale hardcoded portfolio values and uses an honest empty state', async () => {
    getDashboardData.mockResolvedValue({
      ...dashboardFixture,
      contractSummary: {
        totalSignedContracts: 0,
        activeContracts: 0,
        expiringIn30Days: 0,
        expiredContracts: 0,
        unknownContracts: 0,
        contractsWithValue: 0,
        contractsMissingValue: 0,
        portfolioValue: 0,
      },
      contractsNeedingAttention: [],
    });

    renderDashboard();

    expect(await screen.findByText('No signed contracts are expiring soon.')).toBeInTheDocument();
    expect(screen.queryByText(/14,600,000|14 600 000/)).not.toBeInTheDocument();
  });

  it('routes Dashboard actions to current app destinations', async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: /open workflows/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/workflows');

    fireEvent.click(await screen.findByRole('button', { name: /unassigned tasks/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks?tab=unassigned');

    fireEvent.click(screen.getAllByRole('button', { name: /view all/i })[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/contracts');

    fireEvent.click(screen.getAllByRole('button', { name: /view all/i })[1]);
    expect(mockNavigate).toHaveBeenCalledWith('/contracts?status=Expiring%20Soon');

    fireEvent.click(screen.getAllByText('Expiring Soon')[0]);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/contracts?status=Expiring%20Soon');
    });
  });
});
