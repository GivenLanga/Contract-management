import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../services/legalFolderStore', () => ({
  getContractsForApp: vi.fn(),
  LEGAL_FOLDER_UPDATED: 'legal-folder-updated',
}));

vi.mock('../../../context/NotificationContext', () => ({
  useNotifications: vi.fn(() => ({ unreadCount: 0 })),
}));

vi.mock('../../../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: { name: 'Test User' } })),
}));

import { getContractsForApp } from '../../../services/legalFolderStore';
import ContractList from '../ContractList';

// ── Helpers ───────────────────────────────────────────────────────────────────

const base = {
  id: 'TEST-001',
  title: 'Test Contract',
  type: 'Service',
  status: 'Active',   // neutral status — stage is determined by sourcePath in each record
  counterparty: 'Test Corp',
  value: 0,
  endDate: null,
  startDate: null,
  tags: [],
  priority: 'Medium',
};

const signed = {
  ...base,
  id: 'SIGNED-001',
  title: 'Agreement Signed',
  sourcePath: 'Contracts/2026/Service Providers/ABC/Signed/Agreement Signed.pdf',
};

const draft = {
  ...base,
  id: 'DRAFT-001',
  title: 'Agreement Draft',
  status: 'Draft',
  sourcePath: 'Contracts/2026/Service Providers/ABC/Drafts/Agreement Draft v1.docx',
};

const final_ = {
  ...base,
  id: 'FINAL-001',
  title: 'Agreement Final',
  status: 'Ready for Signature',
  sourcePath: 'Contracts/2026/Service Providers/ABC/Final/Agreement Final v1.docx',
};

const template = {
  ...base,
  id: 'TPL-001',
  title: 'Template Doc',
  status: 'Draft',
  sourcePath: 'Templates/MyTemplate.docx',
};

const unknown = {
  ...base,
  id: 'UNK-001',
  title: 'Unknown Doc',
  status: 'Active',
};

const isoDaysFromToday = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

function renderList() {
  return render(
    <MemoryRouter>
      <ContractList />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Core acceptance scenario ──────────────────────────────────────────────────

describe('Core acceptance scenario', () => {
  it('shows only the signed contract when given a mix of staged records', () => {
    getContractsForApp.mockReturnValue([signed, draft, final_]);
    renderList();
    expect(screen.getByText('Agreement Signed')).toBeInTheDocument();
    expect(screen.queryByText('Agreement Draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Agreement Final')).not.toBeInTheDocument();
  });
});

// ── Stage filtering ───────────────────────────────────────────────────────────

describe('Stage-based filtering', () => {
  it('shows signed records', () => {
    getContractsForApp.mockReturnValue([signed]);
    renderList();
    expect(screen.getByText('Agreement Signed')).toBeInTheDocument();
  });

  it('hides draft records', () => {
    getContractsForApp.mockReturnValue([draft]);
    renderList();
    expect(screen.queryByText('Agreement Draft')).not.toBeInTheDocument();
  });

  it('hides final records', () => {
    getContractsForApp.mockReturnValue([final_]);
    renderList();
    expect(screen.queryByText('Agreement Final')).not.toBeInTheDocument();
  });

  it('hides template records', () => {
    getContractsForApp.mockReturnValue([template]);
    renderList();
    expect(screen.queryByText('Template Doc')).not.toBeInTheDocument();
  });

  it('hides unknown records', () => {
    getContractsForApp.mockReturnValue([unknown]);
    renderList();
    expect(screen.queryByText('Unknown Doc')).not.toBeInTheDocument();
  });
});

// ── Portfolio metadata display ───────────────────────────────────────────────

describe('Signed contract portfolio metadata', () => {
  it('16. Status column shows Active, not Signed', () => {
    getContractsForApp.mockReturnValue([{
      ...signed,
      status: 'Signed',
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      expiryDate: '2099-12-31',
      endDate: '2099-12-31',
    }]);
    renderList();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.queryByText('Signed')).not.toBeInTheDocument();
  });

  it('17. Expired contract shows Expired', () => {
    getContractsForApp.mockReturnValue([{
      ...signed,
      id: 'EXP-001',
      title: 'Expired Agreement',
      status: 'Signed',
      expiryDate: '2000-01-01',
      endDate: '2000-01-01',
    }]);
    renderList();
    expect(screen.getAllByText('Expired').length).toBeGreaterThan(0);
  });

  it('shows Expiring Soon when expiry is within 30 days', () => {
    const soon = isoDaysFromToday(15);
    getContractsForApp.mockReturnValue([{
      ...signed,
      id: 'SOON-001',
      title: 'Soon Agreement',
      status: 'Signed',
      expiryDate: soon,
      endDate: soon,
    }]);
    renderList();
    expect(screen.getAllByText('Expiring Soon').length).toBeGreaterThan(0);
  });

  it('18. Missing end date shows dash', () => {
    getContractsForApp.mockReturnValue([{
      ...signed,
      id: 'NOEND-001',
      title: 'No End Agreement',
      status: 'Signed',
      contractStatus: 'UNKNOWN',
      contractStatusLabel: 'Unknown',
      endDate: null,
      expiryDate: null,
    }]);
    renderList();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('19. Contract value displays R 510 000', () => {
    getContractsForApp.mockReturnValue([{
      ...signed,
      id: 'VAL-001',
      title: 'Value Agreement',
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      contractValue: 510000,
      contractValueDisplay: 'R 510 000',
      value: 510000,
      expiryDate: '2099-12-31',
    }]);
    renderList();
    expect(screen.getByText('R 510 000')).toBeInTheDocument();
  });

  it('20. Missing value shows dash', () => {
    getContractsForApp.mockReturnValue([{
      ...signed,
      id: 'NOVAL-001',
      title: 'Missing Value Agreement',
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      value: 0,
      contractValue: null,
      contractValueDisplay: null,
      expiryDate: '2099-12-31',
    }]);
    renderList();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('21. Signed contract remains visible even when extraction fails', () => {
    getContractsForApp.mockReturnValue([{
      ...signed,
      id: 'FAIL-001',
      title: 'Extraction Failed Agreement',
      status: 'Signed',
      contractStatus: 'UNKNOWN',
      contractStatusLabel: 'Unknown',
      extraction: {
        confidence: 'low',
        warnings: ['Could not extract text from PDF document.'],
        fieldsFound: ['contractStatus'],
      },
    }]);
    renderList();
    expect(screen.getByText('Extraction Failed Agreement')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  });
});

// ── Regression: path-based detection without lifecycleStage field ─────────────

describe('Regression: Signed folder path works even without lifecycleStage field', () => {
  it('shows record when only sourcePath contains Signed segment — no lifecycleStage field', () => {
    const noStageField = {
      ...base,
      id: 'PATH-001',
      title: 'Path Only Signed',
      sourcePath: 'Contracts/2026/Services/Corp/Signed/contract.pdf',
      // NOTE: no lifecycleStage property at all
    };
    getContractsForApp.mockReturnValue([noStageField]);
    renderList();
    expect(screen.getByText('Path Only Signed')).toBeInTheDocument();
  });

  it('shows record when lifecycleStage field is set to SIGNED (no path needed)', () => {
    const withStage = { ...base, id: 'LS-001', title: 'Legacy Signed', lifecycleStage: 'SIGNED' };
    getContractsForApp.mockReturnValue([withStage]);
    renderList();
    expect(screen.getByText('Legacy Signed')).toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('Empty state when no signed contracts', () => {
  it('shows "No signed contracts found." when all records are non-signed', () => {
    getContractsForApp.mockReturnValue([draft, final_]);
    renderList();
    expect(screen.getByText(/No signed contracts found/)).toBeInTheDocument();
  });

  it('shows empty state body mentioning Signed folder', () => {
    getContractsForApp.mockReturnValue([draft]);
    renderList();
    expect(screen.getByText(/Signed folder/i)).toBeInTheDocument();
  });

  it('shows empty state when store returns zero records', () => {
    getContractsForApp.mockReturnValue([]);
    renderList();
    expect(screen.getByText(/No signed contracts found/)).toBeInTheDocument();
  });

  it('does NOT show the generic "No contracts match your filters" message when all are non-signed', () => {
    getContractsForApp.mockReturnValue([draft, final_]);
    renderList();
    expect(screen.queryByText(/No contracts match your filters/)).not.toBeInTheDocument();
  });
});

// ── Diagnostics in empty state ────────────────────────────────────────────────

describe('Diagnostic counts in empty state', () => {
  it('shows draft count in diagnostics', () => {
    getContractsForApp.mockReturnValue([draft]);
    renderList();
    expect(screen.getByText(/1 draft/i)).toBeInTheDocument();
  });

  it('shows final count in diagnostics', () => {
    getContractsForApp.mockReturnValue([final_]);
    renderList();
    expect(screen.getByText(/1 final document/i)).toBeInTheDocument();
  });

  it('shows "0 signed documents" in diagnostics when there are other records', () => {
    getContractsForApp.mockReturnValue([draft, final_]);
    renderList();
    expect(screen.getByText('0 signed documents')).toBeInTheDocument();
  });

  it('does NOT show diagnostics section when store returns zero records total', () => {
    getContractsForApp.mockReturnValue([]);
    renderList();
    expect(screen.queryByText('0 signed documents')).not.toBeInTheDocument();
    expect(screen.queryByText(/Detected in Legal Folder/i)).not.toBeInTheDocument();
  });
});

// ── Acceptance scenario: alias folder names (tests 36-38) ────────────────────

describe('Acceptance scenario — alias folder names', () => {
  it('36. includes document in Signed Documents folder', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'SD-001',
      title: 'Agreement from Signed Documents',
      sourcePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    }]);
    renderList();
    expect(screen.getByText('Agreement from Signed Documents')).toBeInTheDocument();
  });

  it('36b. includes document in Executed Contracts folder', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'EC-001',
      title: 'Agreement from Executed Contracts',
      sourcePath: 'Contracts/2026/Service Providers/ABC/Executed Contracts/Agreement.pdf',
    }]);
    renderList();
    expect(screen.getByText('Agreement from Executed Contracts')).toBeInTheDocument();
  });

  it('37. excludes document in Awaiting Signature folder', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'AW-001',
      title: 'Awaiting Agreement',
      sourcePath: 'Contracts/2026/Service Providers/ABC/Awaiting Signature/Agreement.pdf',
    }]);
    renderList();
    expect(screen.queryByText('Awaiting Agreement')).not.toBeInTheDocument();
  });

  it('38. excludes file named "Signed Agreement.pdf" inside Final folder', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'FS-001',
      title: 'Final Signed Agreement',
      sourcePath: 'Contracts/2026/Service Providers/ABC/Final/Signed Agreement.pdf',
    }]);
    renderList();
    expect(screen.queryByText('Final Signed Agreement')).not.toBeInTheDocument();
  });

  it('excludes Template even if filename contains Signed', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'TP-001',
      title: 'Signed NDA Template',
      sourcePath: 'Templates/Signed NDA Template.docx',
    }]);
    renderList();
    expect(screen.queryByText('Signed NDA Template')).not.toBeInTheDocument();
  });

  it('11. lifecycleStage UNKNOWN with relativePath inside Signed Documents appears', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'UNK-SD-001',
      title: 'Unknown Stage Signed Documents',
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    }]);
    renderList();
    expect(screen.getByText('Unknown Stage Signed Documents')).toBeInTheDocument();
  });

  it('12. lifecycleStage UNKNOWN with Windows backslash path inside Signed appears', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'UNK-WIN-001',
      title: 'Unknown Stage Windows Signed',
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts\\2026\\Service Providers\\ABC\\Signed\\Agreement.pdf',
    }]);
    renderList();
    expect(screen.getByText('Unknown Stage Windows Signed')).toBeInTheDocument();
  });

  it('13. signed-like UNKNOWN diagnostic count is zero after classifier recovery', () => {
    getContractsForApp.mockReturnValue([{
      ...base,
      id: 'UNK-SD-002',
      title: 'Recovered Signed Documents',
      lifecycleStage: 'UNKNOWN',
      relativePath: 'Contracts/2026/Service Providers/ABC/Signed Documents/Agreement.pdf',
    }]);
    renderList();
    expect(screen.queryByText(/No signed contracts found/)).not.toBeInTheDocument();
  });
});
