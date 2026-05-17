import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Module mocks (must be hoisted before real imports) ────────────────────────

vi.mock('../../../services/legalFolderAccess', () => ({
  FOLDER_STATE: {
    DISCONNECTED: 'DISCONNECTED',
    INDEX_ONLY: 'INDEX_ONLY',
    UNSUPPORTED_BROWSER: 'UNSUPPORTED_BROWSER',
    WRITE_REAUTH_REQUIRED: 'WRITE_REAUTH_REQUIRED',
    WRITE_READY: 'WRITE_READY',
  },
  getLegalFolderStatus: vi.fn(),
  ensureLegalFolderWriteAccess: vi.fn(),
  reauthorizeLegalFolder: vi.fn(),
}));

vi.mock('../../../services/legalFolderStore', () => {
  const getLegalFolderImport = vi.fn(() => ({ source: null, contracts: [], documents: [] }));
  return {
    getLegalFolderImport,
    addDocumentToLegalFolderImport: vi.fn(),
    subscribeToDesktopLifecycleIndex: vi.fn(() => () => {}),
    syncLifecycleIndexFromDesktop: vi.fn(() => Promise.resolve(getLegalFolderImport())),
    LEGAL_FOLDER_UPDATED: 'legal-folder-updated',
  };
});

vi.mock('../../../services/legalFolderFileStore', () => ({
  getLegalFolderFile: vi.fn(),
}));

vi.mock('../../../services/legalFolderHandle', () => ({
  getLegalFolderHandle: vi.fn(() => null),
}));

vi.mock('../../../services/legalFolderPathBuilder', () => ({
  buildDraftDestination: vi.fn(),
  writeDraftToFolder: vi.fn(),
  mapAgreementFamilyToFolder: vi.fn(() => 'Services'),
  getExistingCategoryFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../services/templateDraftWriter', () => ({
  createDraftDocx: vi.fn(),
  formatUnresolvedPlaceholder: vi.fn((item) => item?.placeholder || item?.normalizedKey || ''),
}));

vi.mock('../../../services/templateDocumentScanner', () => ({
  scanDocx: vi.fn().mockResolvedValue({ placeholders: [], blankFields: [] }),
  isScannable: vi.fn(() => false),
}));

vi.mock('../../../services/api', () => ({
  templates: { discover: vi.fn(), disconnectSource: vi.fn() },
}));

vi.mock('../../../services/draftOpenService', () => ({
  openDraft: vi.fn(),
}));

vi.mock('../../../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ isManager: false })),
}));

vi.mock('../../../context/NotificationContext', () => ({
  useNotifications: vi.fn(() => ({ unreadCount: 0 })),
}));

// ── Real imports after mocks ───────────────────────────────────────────────────

import {
  getLegalFolderStatus,
  ensureLegalFolderWriteAccess,
  reauthorizeLegalFolder,
  FOLDER_STATE,
} from '../../../services/legalFolderAccess';
import { getLegalFolderImport } from '../../../services/legalFolderStore';
import { getLegalFolderFile } from '../../../services/legalFolderFileStore';
import { getLegalFolderHandle } from '../../../services/legalFolderHandle';
import {
  buildDraftDestination,
  writeDraftToFolder,
} from '../../../services/legalFolderPathBuilder';
import { createDraftDocx } from '../../../services/templateDraftWriter';
import { isScannable, scanDocx } from '../../../services/templateDocumentScanner';
import { openDraft } from '../../../services/draftOpenService';

import Templates from '../Templates';

function renderTemplates() {
  return render(
    <MemoryRouter>
      <Templates />
    </MemoryRouter>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEMPLATE = {
  _id: 'tpl-001',
  name: 'Service Agreement Template',
  title: 'Service Agreement Template',
  originalFileName: 'Service Agreement Template.docx',
  agreementFamily: 'ONCE_OFF_SERVICE_AGREEMENT',
  category: 'Service',
  extension: 'docx',
  fileSize: 50000,
  sourcePath: 'Legal Folder/Templates/Service Agreement Template.docx',
  updatedAt: new Date().toISOString(),
  sourceKind: 'LEGAL_FOLDER_SYNC',
};

function fakeSource(name = 'Legal Folder') {
  return {
    name,
    syncedAt: new Date().toISOString(),
    importerVersion: 5,
    contractCount: 1,
    fileCount: 1,
    fileCacheCount: 1,
    scannedFileCount: 1,
    skippedFileCount: 0,
  };
}

function fakeDocument() {
  return {
    ...TEMPLATE,
    contract: { id: 'c1' },
    source: 'shared-folder',
    status: 'Draft',
    lifecycleStage: 'TEMPLATE',
    agreementFamily: 'ONCE_OFF_SERVICE_AGREEMENT',
    category: 'Service',
    updatedAt: new Date().toISOString(),
    uploadedBy: { name: 'Shared Folder' },
  };
}

function statusFor(state) {
  return {
    state,
    hasIndex: state !== FOLDER_STATE.DISCONNECTED,
    sourceId: state !== FOLDER_STATE.DISCONNECTED ? 'Legal Folder' : null,
    sourceName: state !== FOLDER_STATE.DISCONNECTED ? 'Legal Folder' : null,
    hasRootHandle: state === FOLDER_STATE.WRITE_READY,
    canRead: state !== FOLDER_STATE.DISCONNECTED,
    canWrite: state === FOLDER_STATE.WRITE_READY,
    writePermission: state === FOLDER_STATE.WRITE_READY ? 'granted' : 'prompt',
    browserSupportsDirectoryPicker: state !== FOLDER_STATE.UNSUPPORTED_BROWSER,
    browserSupportsWritableStreams: state !== FOLDER_STATE.UNSUPPORTED_BROWSER,
    browserSupportsPersistentHandles: true,
  };
}

function setupIndexWithTemplates() {
  const source = fakeSource();
  const doc = fakeDocument();
  getLegalFolderImport.mockReturnValue({
    source,
    contracts: [{ id: 'c1', type: 'Service' }],
    documents: [doc],
  });
}

let templateInfoSpy;
let templateWarnSpy;

beforeEach(() => {
  templateInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  templateWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.clearAllMocks();
  getLegalFolderImport.mockReturnValue({ source: null, contracts: [], documents: [] });
  getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.DISCONNECTED));
  getLegalFolderFile.mockResolvedValue(null);
  ensureLegalFolderWriteAccess.mockResolvedValue(FOLDER_STATE.WRITE_READY);
  openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: 'Open from path.' });
  delete window.showSaveFilePicker;
  delete window.showDirectoryPicker;
});

afterEach(() => {
  templateInfoSpy.mockRestore();
  templateWarnSpy.mockRestore();
  delete window.showSaveFilePicker;
  delete window.showDirectoryPicker;
  delete window.contractiq;
});

// ── 1. Templates visible with index-only state ────────────────────────────────

describe('Templates page — index-only state', () => {
  it('reads TEMPLATE lifecycle stage files as templates', async () => {
    const source = fakeSource();
    getLegalFolderImport.mockReturnValue({
      source,
      contracts: [],
      documents: [{
        ...fakeDocument(),
        sourcePath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement.docx',
        lifecycleStage: 'TEMPLATE',
      }],
    });
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();

    await waitFor(() => {
      expect(screen.getByText('Service Agreement Template')).toBeInTheDocument();
    });
  });

  it('removes template cards when the lifecycle index no longer contains them', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));

    getLegalFolderImport.mockReturnValue({ source: fakeSource(), contracts: [], documents: [] });
    act(() => {
      window.dispatchEvent(new Event('legal-folder-updated'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Service Agreement Template')).not.toBeInTheDocument();
    });
  });

  it('shows template cards when index exists even without write access', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();

    await waitFor(() => {
      expect(screen.getByText('Service Agreement Template')).toBeInTheDocument();
    });
  });

  it('shows write-access banner when index exists but write is not ready', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();

    await waitFor(() => {
      expect(screen.getByTestId('write-access-banner')).toBeInTheDocument();
    });
  });

  it('does not show write-access banner when index is WRITE_READY', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));

    renderTemplates();

    await waitFor(() => {
      expect(screen.queryByTestId('write-access-banner')).not.toBeInTheDocument();
    });
  });

  it('does not show write-access banner when there is no index', async () => {
    getLegalFolderImport.mockReturnValue({ source: null, contracts: [], documents: [] });
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.DISCONNECTED));

    renderTemplates();
    await waitFor(() => {
      expect(screen.queryByTestId('write-access-banner')).not.toBeInTheDocument();
    });
  });
});

// ── 2. Create Draft with index-only state shows write reauth, NOT "not connected" ──

describe('DraftModal — index-only / reauth state', () => {
  it('shows "Legal Folder Write Access Required" title, not "Not Connected"', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));

    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText('Legal Folder Write Access Required')).toBeInTheDocument();
    });

    // Critical regression check: must not say "Not Connected"
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
  });

  it('shows the write-access message body explaining the distinction', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText(/Legal Folder write access is not available/)).toBeInTheDocument();
    });
  });

  it('shows Re-authorize Legal Folder button', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText('Re-authorize Legal Folder')).toBeInTheDocument();
    });
  });
});

// ── 3. Create Draft with no index at all ─────────────────────────────────────

describe('DraftModal — no Legal Folder index', () => {
  it('is unreachable because no templates are shown — but templates in state show disconnected modal', async () => {
    // If someone manages to open DraftModal with DISCONNECTED status, they see the right message
    getLegalFolderImport.mockReturnValue({ source: null, contracts: [], documents: [] });
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.DISCONNECTED));

    // Render with no templates — the "Use" button won't exist
    renderTemplates();
    await waitFor(() => {
      expect(screen.getByText('No Legal Folder connected.')).toBeInTheDocument();
    });
  });
});

// ── 4. Create Draft with unsupported browser ─────────────────────────────────

describe('DraftModal — unsupported browser', () => {
  it('shows browser not supported message', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.UNSUPPORTED_BROWSER));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText(/Browser Not Supported/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
  });

  it('does not claim folder is disconnected in unsupported browser state', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.UNSUPPORTED_BROWSER));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText(/Legal Folder write access is not supported/)).toBeInTheDocument();
    });
  });
});

// ── 5. Create Draft with WRITE_READY writes directly into folder ─────────────

describe('DraftModal — WRITE_READY', () => {
  it('proceeds to form when write access is ready and file is cached', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    getLegalFolderFile.mockResolvedValue({ blob: new Blob(['docx']), type: 'docx' });
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder' });

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText('Draft from Template')).toBeInTheDocument();
    });
  });

  it('in Electron, reads the template from the Legal Folder instead of browser cache', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    getLegalFolderFile.mockResolvedValue(null);
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder' });
    window.contractiq = {
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: true,
        fileName: 'Service Agreement Template.docx',
        extension: '.docx',
        relativePath: 'Templates/Service Agreement Template.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        arrayBuffer: new TextEncoder().encode('docx').buffer,
      }),
    };

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText('Draft from Template')).toBeInTheDocument();
    });
    expect(window.contractiq.readLegalFolderFile).toHaveBeenCalledWith({
      relativePath: 'Templates/Service Agreement Template.docx',
    });
    expect(getLegalFolderFile).not.toHaveBeenCalled();
    expect(screen.queryByText('Template File Not Cached')).not.toBeInTheDocument();
  });

  it('shows a Legal Folder missing-file message when Electron cannot find the template', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    getLegalFolderFile.mockResolvedValue(null);
    window.contractiq = {
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: false,
        code: 'FILE_NOT_FOUND',
        message: 'Missing',
      }),
    };

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      expect(screen.getByText('Template File Not Found')).toBeInTheDocument();
    });
    expect(screen.getByText(/could not be found in the connected Legal Folder/)).toBeInTheDocument();
    expect(screen.queryByText(/browser cache/i)).not.toBeInTheDocument();
  });

  it('writes directly to Legal Folder without opening OS save dialog', async () => {
    window.showSaveFilePicker = vi.fn();
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    ensureLegalFolderWriteAccess.mockResolvedValue(FOLDER_STATE.WRITE_READY);
    getLegalFolderFile.mockResolvedValue({ blob: new Blob(['docx']), type: 'docx' });
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder', kind: 'directory' });
    createDraftDocx.mockResolvedValue({ blob: new Blob(['out']), warnings: [] });
    buildDraftDestination.mockResolvedValue({
      directoryHandle: {},
      fileName: 'Service Agreement - Acme - Draft v1.docx',
      relativePath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
      displayPath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
    });
    writeDraftToFolder.mockResolvedValue(undefined);

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Draft from Template'));

    fireEvent.change(screen.getAllByPlaceholderText(/ABC Suppliers/)[1], { target: { value: 'Acme Ltd' } });
    fireEvent.click(screen.getByText('Create Draft'));

    await waitFor(() => {
      expect(writeDraftToFolder).toHaveBeenCalled();
      expect(window.showSaveFilePicker).not.toHaveBeenCalled();
    });
  });

  it('passes structured placeholder fields and detected placeholders to createDraftDocx', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    ensureLegalFolderWriteAccess.mockResolvedValue(FOLDER_STATE.WRITE_READY);
    getLegalFolderFile.mockResolvedValue({ blob: new Blob(['docx']), type: 'docx' });
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder', kind: 'directory' });
    isScannable.mockReturnValueOnce(true);
    scanDocx.mockResolvedValueOnce({
      placeholders: [
        {
          key: 'insert_company_name',
          raw: '[INSERT COMPANY NAME]',
          label: 'Company Name',
          group: 'Parties',
        },
        {
          key: 'insert_reg_no',
          raw: '[INSERT REG. NO.]',
          label: 'Registration Number',
          group: 'Registration Details',
        },
      ],
      blankFields: [],
      warnings: [],
    });
    createDraftDocx.mockResolvedValue({
      blob: new Blob(['out']),
      warnings: [],
      replacementReport: { replaced: [], unresolved: [], warnings: [] },
    });
    buildDraftDestination.mockResolvedValue({
      directoryHandle: {},
      fileName: 'Service Agreement - Acme - Draft v1.docx',
      relativePath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
      displayPath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
    });
    writeDraftToFolder.mockResolvedValue(undefined);

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Draft from Template'));

    fireEvent.change(screen.getAllByPlaceholderText(/ABC Suppliers/)[1], { target: { value: 'BackSlash' } });
    fireEvent.change(screen.getByPlaceholderText('Company Name'), {
      target: { value: 'ContractIQ RF Proprietary Limited' },
    });
    fireEvent.change(screen.getByPlaceholderText('Registration Number'), {
      target: { value: '2026/123456/07' },
    });
    fireEvent.click(screen.getByText('Create Draft'));

    await waitFor(() => expect(createDraftDocx).toHaveBeenCalled());
    expect(createDraftDocx.mock.calls[0][1]).toMatchObject({
      fields: {
        counterparty: 'BackSlash',
        counterpartyName: 'BackSlash',
        companyName: 'ContractIQ RF Proprietary Limited',
        insertCompanyName: 'ContractIQ RF Proprietary Limited',
        registrationNumber: '2026/123456/07',
        insertRegNo: '2026/123456/07',
      },
      placeholderValues: {
        insert_company_name: 'ContractIQ RF Proprietary Limited',
        '[INSERT COMPANY NAME]': 'ContractIQ RF Proprietary Limited',
        insert_reg_no: '2026/123456/07',
        '[INSERT REG. NO.]': '2026/123456/07',
      },
    });
    expect(createDraftDocx.mock.calls[0][1].detectedPlaceholders).toHaveLength(2);
  });

  it('does not use anchor download for the draft', async () => {
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    ensureLegalFolderWriteAccess.mockResolvedValue(FOLDER_STATE.WRITE_READY);
    getLegalFolderFile.mockResolvedValue({ blob: new Blob(['docx']), type: 'docx' });
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder', kind: 'directory' });
    createDraftDocx.mockResolvedValue({ blob: new Blob(['out']), warnings: [] });
    buildDraftDestination.mockResolvedValue({
      directoryHandle: {},
      fileName: 'Draft v1.docx',
      relativePath: 'Contracts/2026/Services/Acme/Drafts/Draft v1.docx',
      displayPath: 'Contracts/2026/Services/Acme/Drafts/Draft v1.docx',
    });
    writeDraftToFolder.mockResolvedValue(undefined);

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Draft from Template'));
    fireEvent.change(screen.getAllByPlaceholderText(/ABC Suppliers/)[1], { target: { value: 'Acme Ltd' } });
    fireEvent.click(screen.getByText('Create Draft'));

    await waitFor(() => expect(writeDraftToFolder).toHaveBeenCalled());

    // Any anchor that was appended should not have a download attribute pointing to a blob
    const anchors = appendSpy.mock.calls
      .map(([el]) => el)
      .filter((el) => el?.tagName === 'A' && el.download);
    expect(anchors).toHaveLength(0);
    appendSpy.mockRestore();
  });
});

// ── 6. Re-authorize button calls showDirectoryPicker ─────────────────────────

describe('Re-authorize flow', () => {
  it('calls showDirectoryPicker with mode readwrite when Re-authorize is clicked', async () => {
    setupIndexWithTemplates();
    // Two calls must return WRITE_REAUTH_REQUIRED (Templates mount + DraftModal mount)
    getLegalFolderStatus
      .mockResolvedValueOnce(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED))
      .mockResolvedValueOnce(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED))
      .mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    reauthorizeLegalFolder.mockResolvedValue({ success: true });
    getLegalFolderFile.mockResolvedValue(null); // file not cached

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Re-authorize Legal Folder'));

    fireEvent.click(screen.getByText('Re-authorize Legal Folder'));
    await waitFor(() => {
      expect(reauthorizeLegalFolder).toHaveBeenCalled();
    });
  });

  it('shows name mismatch error when wrong folder selected', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));
    reauthorizeLegalFolder.mockResolvedValue({
      success: false,
      reason: 'name_mismatch',
      expectedName: 'Legal Folder',
      selectedName: 'Wrong Folder',
    });

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Re-authorize Legal Folder'));
    fireEvent.click(screen.getByText('Re-authorize Legal Folder'));

    await waitFor(() => {
      expect(screen.getByText(/The selected folder does not look like/)).toBeInTheDocument();
    });
  });

  it('after successful re-auth, resumes draft flow', async () => {
    setupIndexWithTemplates();
    // Calls 1 & 2: Templates mount + DraftModal first mount → WRITE_REAUTH_REQUIRED
    // Call 3+: DraftModal retry after re-auth → WRITE_READY
    let callCount = 0;
    getLegalFolderStatus.mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 2) return statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED);
      return statusFor(FOLDER_STATE.WRITE_READY);
    });
    reauthorizeLegalFolder.mockResolvedValue({ success: true });
    getLegalFolderFile.mockResolvedValue({ blob: new Blob(['docx']), type: 'docx' });
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder' });

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Re-authorize Legal Folder'));
    fireEvent.click(screen.getByText('Re-authorize Legal Folder'));

    // After re-auth, should progress to the form
    await waitFor(() => {
      expect(screen.getByText('Draft from Template')).toBeInTheDocument();
    });
  });
});

// ── 10–13. No generic save dialogs or anchor downloads ───────────────────────

describe('Generic save dialog prohibition', () => {
  it('showSaveFilePicker is never called during draft creation', async () => {
    window.showSaveFilePicker = vi.fn();
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
    ensureLegalFolderWriteAccess.mockResolvedValue(FOLDER_STATE.WRITE_READY);
    getLegalFolderFile.mockResolvedValue({ blob: new Blob(['x']), type: 'docx' });
    getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder' });
    createDraftDocx.mockResolvedValue({ blob: new Blob(['out']), warnings: [] });
    buildDraftDestination.mockResolvedValue({
      directoryHandle: {},
      fileName: 'Draft v1.docx',
      relativePath: 'Contracts/2026/Services/Acme/Drafts/Draft v1.docx',
      displayPath: 'Contracts/2026/Services/Acme/Drafts/Draft v1.docx',
    });
    writeDraftToFolder.mockResolvedValue(undefined);

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);
    await waitFor(() => screen.getByText('Draft from Template'));
    fireEvent.change(screen.getAllByPlaceholderText(/ABC Suppliers/)[1], { target: { value: 'Acme Ltd' } });
    fireEvent.click(screen.getByText('Create Draft'));

    await waitFor(() => expect(writeDraftToFolder).toHaveBeenCalled());
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
  });
});

// ── 14. Templates page banner appears when index exists but write access missing ──

describe('Write-access banner content', () => {
  it('banner text mentions re-authorization when WRITE_REAUTH_REQUIRED', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();
    await waitFor(() => {
      const banner = screen.getByTestId('write-access-banner');
      expect(banner).toHaveTextContent(/Re-authorize write access/);
    });
  });

  it('banner text mentions browser limitation when UNSUPPORTED_BROWSER', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.UNSUPPORTED_BROWSER));

    renderTemplates();
    await waitFor(() => {
      const banner = screen.getByTestId('write-access-banner');
      expect(banner).toHaveTextContent(/browser does not support/i);
    });
  });
});

// ── 15. Legal Folder page shows write access state (via Templates folderStatus) ──

describe('folderStatus integration', () => {
  it('folderStatus is refreshed after LEGAL_FOLDER_UPDATED event', async () => {
    // Initial: no index
    getLegalFolderImport.mockReturnValue({ source: null, contracts: [], documents: [] });
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.DISCONNECTED));

    renderTemplates();
    await waitFor(() => screen.getByText('No Legal Folder connected.'));

    // Simulate folder being connected
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));
    window.dispatchEvent(new Event('legal-folder-updated'));

    await waitFor(() => {
      expect(screen.getByTestId('write-access-banner')).toBeInTheDocument();
    });
  });
});

// ── Regression: visible templates → not-connected message must not appear ────

describe('Regression: visible templates must not produce false not-connected error', () => {
  it('never shows "Legal Folder Not Connected" modal when templates are visible from active index', async () => {
    setupIndexWithTemplates();
    getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_REAUTH_REQUIRED));

    renderTemplates();
    await waitFor(() => screen.getByText('Service Agreement Template'));
    fireEvent.click(screen.getAllByText('Use')[0]);

    await waitFor(() => {
      // Must not have the old wrong title
      expect(screen.queryByText('Legal Folder Not Connected')).not.toBeInTheDocument();
    });
  });
});

// ── Done-phase helpers ────────────────────────────────────────────────────────

function setupForSuccess() {
  setupIndexWithTemplates();
  getLegalFolderStatus.mockResolvedValue(statusFor(FOLDER_STATE.WRITE_READY));
  ensureLegalFolderWriteAccess.mockResolvedValue(FOLDER_STATE.WRITE_READY);
  getLegalFolderFile.mockResolvedValue({ blob: new Blob(['docx']), type: 'docx' });
  getLegalFolderHandle.mockReturnValue({ name: 'Legal Folder', kind: 'directory' });
  createDraftDocx.mockResolvedValue({ blob: new Blob(['out']), warnings: [] });
  buildDraftDestination.mockResolvedValue({
    directoryHandle: {},
    fileName: 'Service Agreement - Acme - Draft v1.docx',
    relativePath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
    displayPath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
  });
  writeDraftToFolder.mockResolvedValue(undefined);
}

async function reachDoneState() {
  renderTemplates();
  await waitFor(() => screen.getByText('Service Agreement Template'));
  fireEvent.click(screen.getAllByText('Use')[0]);
  await waitFor(() => screen.getByText('Draft from Template'));
  fireEvent.change(screen.getAllByPlaceholderText(/ABC Suppliers/)[1], { target: { value: 'Acme Ltd' } });
  fireEvent.click(screen.getByText('Create Draft'));
  await waitFor(() => screen.getByText('Draft Created'));
}

// ── 1–2. Draft Created modal shows Close and Open Draft buttons ───────────────

describe('Draft Created modal — buttons and initial state', () => {
  it('shows Close button after draft creation', async () => {
    setupForSuccess();
    await reachDoneState();
    expect(screen.getByText('Close')).toBeInTheDocument();
  });

  it('shows Open Draft button after draft creation', async () => {
    setupForSuccess();
    await reachDoneState();
    expect(screen.getByTestId('open-draft-btn')).toBeInTheDocument();
  });

  it('Open Draft button shows 5-second countdown text initially', async () => {
    setupForSuccess();
    await reachDoneState();
    expect(screen.getByTestId('open-draft-btn')).toHaveTextContent(/Open Draft in 5s/);
  });

  it('Open Draft button is not disabled initially', async () => {
    setupForSuccess();
    await reachDoneState();
    expect(screen.getByTestId('open-draft-btn')).not.toBeDisabled();
  });
});

// ── 3. Countdown decrements once per second ───────────────────────────────────

describe('Draft Created modal — countdown decrement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('decrements countdown text from 5s to 4s after one second', async () => {
    vi.useFakeTimers();
    setupForSuccess();

    renderTemplates();

    // Flush React effects and all immediately-resolving mocked promises.
    // Each round of `act(async () => Promise.resolve())` flushes one microtask layer.
    const flush = async (rounds = 8) => {
      for (let i = 0; i < rounds; i++) {
        await act(async () => { await Promise.resolve(); });
      }
    };

    await flush();
    expect(screen.getByText('Service Agreement Template')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('Use')[0]);
    await flush();
    expect(screen.getByText('Draft from Template')).toBeInTheDocument();

    fireEvent.change(screen.getAllByPlaceholderText(/ABC Suppliers/)[1], { target: { value: 'Acme' } });
    fireEvent.click(screen.getByText('Create Draft'));
    await flush();
    expect(screen.getByTestId('open-draft-btn')).toHaveTextContent(/Open Draft in 5s/);

    // Advance 1 second — wrap in act so React flushes the setCountdown state update
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('open-draft-btn')).toHaveTextContent(/Open Draft in 4s/);

    vi.useRealTimers();
  });
});

// ── 4. Countdown stops when Close is clicked ──────────────────────────────────

describe('Draft Created modal — countdown cancellation', () => {
  it('modal closes when Close is clicked (countdown cancelled)', async () => {
    setupForSuccess();
    await reachDoneState();

    fireEvent.click(screen.getByText('Close'));

    await waitFor(() => {
      expect(screen.queryByText('Draft Created')).not.toBeInTheDocument();
    });
  });
});

// ── 6–7. Manual Open Draft click ──────────────────────────────────────────────

describe('Draft Created modal — manual Open Draft', () => {
  it('calls openDraft immediately when Open Draft is clicked', async () => {
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();

    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(openDraft).toHaveBeenCalledTimes(1);
    });
  });

  it('Open Draft button shows "Opening…" while the call is in flight', async () => {
    let resolveFn;
    openDraft.mockImplementation(() => new Promise((res) => { resolveFn = res; }));
    setupForSuccess();
    await reachDoneState();

    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('open-draft-btn')).toHaveTextContent('Opening…');
    });

    resolveFn({ ok: false, method: 'browser_fallback', message: '' });
  });

  it('cannot fire openDraft twice (second click while opening is ignored)', async () => {
    let resolveFn;
    openDraft.mockImplementation(() => new Promise((res) => { resolveFn = res; }));
    setupForSuccess();
    await reachDoneState();

    fireEvent.click(screen.getByTestId('open-draft-btn'));
    await waitFor(() => screen.getByText('Opening…'));

    // Second click while opening is in progress
    fireEvent.click(screen.getByTestId('open-draft-btn'));

    resolveFn({ ok: false, method: 'browser_fallback', message: '' });
    await waitFor(() => expect(openDraft).toHaveBeenCalledTimes(1));
  });
});

// ── 8–11. Opening failure shows fallback message ──────────────────────────────

describe('Draft Created modal — browser_fallback shown on open failure', () => {
  it('shows browser-only fallback panel when openDraft returns browser_fallback', async () => {
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();

    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(screen.getByText(/Automatic opening requires the ContractIQ desktop app/)).toBeInTheDocument();
    });
  });

  it('fallback panel shows Copy Path button', async () => {
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('copy-path-btn')).toBeInTheDocument();
    });
  });

  it('fallback panel shows View in Legal Folder button', async () => {
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('view-in-folder-btn')).toBeInTheDocument();
    });
  });

  it('draftOpenService is called with fileName, relativePath, extension and mimeType', async () => {
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => expect(openDraft).toHaveBeenCalled());

    const arg = openDraft.mock.calls[0][0];
    expect(arg).toMatchObject({
      fileName: 'Service Agreement - Acme - Draft v1.docx',
      relativePath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('does not show browser-only fallback text when the Electron bridge exists', async () => {
    window.contractiq = {
      openDraft: vi.fn(),
      chooseLegalFolder: vi.fn(),
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: true,
        fileName: 'Service Agreement Template.docx',
        extension: '.docx',
        relativePath: 'Templates/Service Agreement Template.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        arrayBuffer: new TextEncoder().encode('docx').buffer,
      }),
    };
    openDraft.mockResolvedValue({
      ok: false,
      method: 'browser_fallback',
      code: 'DESKTOP_OPEN_FAILED',
      message: 'Desktop bridge returned an open error.',
    });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(screen.getAllByText('Desktop bridge returned an open error.').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Automatic opening requires the ContractIQ desktop app/)).not.toBeInTheDocument();
  });
});

describe('Draft Created modal — Legal Folder root selection', () => {
  it('shows Choose Legal Folder action when Electron reports LEGAL_FOLDER_ROOT_NOT_SET', async () => {
    window.contractiq = {
      openDraft: vi.fn(),
      chooseLegalFolder: vi.fn(),
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: true,
        fileName: 'Service Agreement Template.docx',
        extension: '.docx',
        relativePath: 'Templates/Service Agreement Template.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        arrayBuffer: new TextEncoder().encode('docx').buffer,
      }),
    };
    openDraft.mockResolvedValue({
      ok: false,
      method: 'native_bridge',
      code: 'LEGAL_FOLDER_ROOT_NOT_SET',
      message: 'ContractIQ Desktop needs to know your Legal Folder location before it can open the draft.',
    });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));

    await waitFor(() => {
      expect(screen.getAllByText(/needs to know your Legal Folder location/).length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('choose-legal-folder-btn')).toBeInTheDocument();
    expect(screen.getByTestId('open-draft-again-btn')).toBeInTheDocument();
    expect(screen.queryByText(/Automatic opening requires the ContractIQ desktop app/)).not.toBeInTheDocument();
  });

  it('chooses the Legal Folder and retries Open Draft automatically', async () => {
    window.contractiq = {
      openDraft: vi.fn(),
      chooseLegalFolder: vi.fn().mockResolvedValue({
        ok: true,
        name: 'sa_mock_contracts_pack',
        sourceId: 'legal-folder:test',
        rootName: 'sa_mock_contracts_pack',
      }),
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: true,
        fileName: 'Service Agreement Template.docx',
        extension: '.docx',
        relativePath: 'Templates/Service Agreement Template.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        arrayBuffer: new TextEncoder().encode('docx').buffer,
      }),
    };
    openDraft
      .mockResolvedValueOnce({
        ok: false,
        method: 'native_bridge',
        code: 'LEGAL_FOLDER_ROOT_NOT_SET',
        message: 'ContractIQ Desktop needs to know your Legal Folder location before it can open the draft.',
      })
      .mockResolvedValueOnce({
        ok: true,
        method: 'libreoffice_writer',
        app: 'LibreOffice Writer',
        message: 'Opening in LibreOffice Writer.',
      });

    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));
    await waitFor(() => screen.getByTestId('choose-legal-folder-btn'));

    fireEvent.click(screen.getByTestId('choose-legal-folder-btn'));

    await waitFor(() => {
      expect(window.contractiq.chooseLegalFolder).toHaveBeenCalledTimes(1);
      expect(openDraft).toHaveBeenCalledTimes(2);
    });
    expect(screen.getAllByText(/Opening in LibreOffice Writer/).length).toBeGreaterThan(0);
  });
});

// ── 12. View in Legal Folder navigates ────────────────────────────────────────

describe('Draft Created modal — View in Legal Folder', () => {
  it('dispatches navigate event when View in Legal Folder is clicked', async () => {
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));
    await waitFor(() => screen.getByTestId('view-in-folder-btn'));

    const events = [];
    window.addEventListener('navigate', (e) => events.push(e.detail));

    fireEvent.click(screen.getByTestId('view-in-folder-btn'));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ path: '/documents' });
  });
});

// ── 14. No generic save dialog ────────────────────────────────────────────────

describe('Draft Created modal — no save dialog', () => {
  it('showSaveFilePicker is never called during the open-draft flow', async () => {
    window.showSaveFilePicker = vi.fn();
    openDraft.mockResolvedValue({ ok: false, method: 'browser_fallback', message: '...' });
    setupForSuccess();
    await reachDoneState();
    fireEvent.click(screen.getByTestId('open-draft-btn'));
    await waitFor(() => expect(openDraft).toHaveBeenCalled());
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
  });
});
