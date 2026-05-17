import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLegalFolderStatus,
  ensureLegalFolderWriteAccess,
  reauthorizeLegalFolder,
  FOLDER_STATE,
} from '../legalFolderAccess';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHandle(permission = 'granted', name = 'Legal Folder') {
  return {
    name,
    kind: 'directory',
    queryPermission: vi.fn().mockResolvedValue(permission),
    requestPermission: vi.fn().mockResolvedValue(permission),
  };
}

function stubSource(sourceName = 'Legal Folder') {
  return { source: { name: sourceName, syncedAt: new Date().toISOString(), importerVersion: 5 } };
}

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../legalFolderStore', () => ({
  getLegalFolderImport: vi.fn(() => ({ source: null, contracts: [], documents: [] })),
}));

vi.mock('../legalFolderHandle', () => ({
  getLegalFolderHandle: vi.fn(() => null),
  setLegalFolderHandle: vi.fn(),
  loadHandleFromIndexedDB: vi.fn().mockResolvedValue(null),
  saveHandleToIndexedDB: vi.fn().mockResolvedValue(undefined),
}));

import { getLegalFolderImport } from '../legalFolderStore';
import {
  getLegalFolderHandle,
  setLegalFolderHandle,
  loadHandleFromIndexedDB,
  saveHandleToIndexedDB,
} from '../legalFolderHandle';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no directory picker support
  delete window.showDirectoryPicker;
});

afterEach(() => {
  delete window.showDirectoryPicker;
});

// ── getLegalFolderStatus ──────────────────────────────────────────────────────

describe('getLegalFolderStatus', () => {
  it('returns DISCONNECTED when no index exists', async () => {
    getLegalFolderImport.mockReturnValue({ source: null, contracts: [], documents: [] });
    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.DISCONNECTED);
    expect(status.hasIndex).toBe(false);
    expect(status.canWrite).toBe(false);
  });

  it('returns UNSUPPORTED_BROWSER when index exists but showDirectoryPicker is absent', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.UNSUPPORTED_BROWSER);
    expect(status.hasIndex).toBe(true);
    expect(status.browserSupportsDirectoryPicker).toBe(false);
    expect(status.canWrite).toBe(false);
  });

  it('returns WRITE_REAUTH_REQUIRED when index exists, API supported, but no handle anywhere', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    getLegalFolderHandle.mockReturnValue(null);
    loadHandleFromIndexedDB.mockResolvedValue(null);

    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.WRITE_REAUTH_REQUIRED);
    expect(status.hasIndex).toBe(true);
    expect(status.hasRootHandle).toBe(false);
    expect(status.canWrite).toBe(false);
  });

  it('returns WRITE_READY when handle from memory has granted permission', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    const handle = makeHandle('granted');
    getLegalFolderHandle.mockReturnValue(handle);

    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.WRITE_READY);
    expect(status.canWrite).toBe(true);
    expect(status.writePermission).toBe('granted');
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('returns WRITE_READY when handle is loaded from IndexedDB and has granted permission', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    const handle = makeHandle('granted');
    getLegalFolderHandle.mockReturnValue(null);
    loadHandleFromIndexedDB.mockResolvedValue(handle);

    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.WRITE_READY);
    expect(setLegalFolderHandle).toHaveBeenCalledWith(handle);
    expect(status.canWrite).toBe(true);
  });

  it('returns WRITE_REAUTH_REQUIRED when handle exists but permission is "prompt"', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    const handle = makeHandle('prompt');
    getLegalFolderHandle.mockReturnValue(handle);

    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.WRITE_REAUTH_REQUIRED);
    expect(status.hasRootHandle).toBe(true);
    expect(status.canWrite).toBe(false);
  });

  it('returns WRITE_REAUTH_REQUIRED when handle exists but permission is "denied"', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    const handle = makeHandle('denied');
    getLegalFolderHandle.mockReturnValue(handle);

    const status = await getLegalFolderStatus();
    expect(status.state).toBe(FOLDER_STATE.WRITE_REAUTH_REQUIRED);
    expect(status.canWrite).toBe(false);
  });

  it('exposes sourceName from the active source', async () => {
    getLegalFolderImport.mockReturnValue(stubSource('Acme Legal'));
    const status = await getLegalFolderStatus();
    expect(status.sourceName).toBe('Acme Legal');
    expect(status.sourceId).toBe('Acme Legal');
  });
});

// ── ensureLegalFolderWriteAccess ──────────────────────────────────────────────

describe('ensureLegalFolderWriteAccess', () => {
  it('returns DISCONNECTED when no source', async () => {
    getLegalFolderImport.mockReturnValue({ source: null });
    expect(await ensureLegalFolderWriteAccess()).toBe(FOLDER_STATE.DISCONNECTED);
  });

  it('returns UNSUPPORTED_BROWSER when picker API is absent', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    expect(await ensureLegalFolderWriteAccess()).toBe(FOLDER_STATE.UNSUPPORTED_BROWSER);
  });

  it('returns WRITE_REAUTH_REQUIRED when no handle exists', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    getLegalFolderHandle.mockReturnValue(null);
    loadHandleFromIndexedDB.mockResolvedValue(null);
    expect(await ensureLegalFolderWriteAccess()).toBe(FOLDER_STATE.WRITE_REAUTH_REQUIRED);
  });

  it('returns WRITE_READY when queryPermission returns granted', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    getLegalFolderHandle.mockReturnValue(makeHandle('granted'));
    expect(await ensureLegalFolderWriteAccess()).toBe(FOLDER_STATE.WRITE_READY);
  });

  it('calls requestPermission when queryPermission returns prompt and returns WRITE_READY if granted', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    const handle = {
      name: 'Legal Folder',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('granted'),
    };
    getLegalFolderHandle.mockReturnValue(handle);
    const result = await ensureLegalFolderWriteAccess();
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(result).toBe(FOLDER_STATE.WRITE_READY);
  });

  it('returns WRITE_REAUTH_REQUIRED when requestPermission returns denied', async () => {
    getLegalFolderImport.mockReturnValue(stubSource());
    window.showDirectoryPicker = vi.fn();
    const handle = {
      name: 'Legal Folder',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
    };
    getLegalFolderHandle.mockReturnValue(handle);
    expect(await ensureLegalFolderWriteAccess()).toBe(FOLDER_STATE.WRITE_REAUTH_REQUIRED);
  });
});

// ── reauthorizeLegalFolder ────────────────────────────────────────────────────

describe('reauthorizeLegalFolder', () => {
  it('calls showDirectoryPicker with mode: readwrite', async () => {
    getLegalFolderImport.mockReturnValue(stubSource('Legal Folder'));
    const handle = makeHandle('granted', 'Legal Folder');
    window.showDirectoryPicker = vi.fn().mockResolvedValue(handle);

    await reauthorizeLegalFolder();
    expect(window.showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('returns success and stores handle in memory + IndexedDB', async () => {
    getLegalFolderImport.mockReturnValue(stubSource('Legal Folder'));
    const handle = makeHandle('granted', 'Legal Folder');
    window.showDirectoryPicker = vi.fn().mockResolvedValue(handle);

    const result = await reauthorizeLegalFolder();
    expect(result.success).toBe(true);
    expect(result.handle).toBe(handle);
    expect(setLegalFolderHandle).toHaveBeenCalledWith(handle);
    expect(saveHandleToIndexedDB).toHaveBeenCalledWith(handle);
  });

  it('returns cancelled when user dismisses picker', async () => {
    getLegalFolderImport.mockReturnValue(stubSource('Legal Folder'));
    const err = new Error('Abort');
    err.name = 'AbortError';
    window.showDirectoryPicker = vi.fn().mockRejectedValue(err);

    const result = await reauthorizeLegalFolder();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(saveHandleToIndexedDB).not.toHaveBeenCalled();
  });

  it('returns name_mismatch when selected folder name differs from source', async () => {
    getLegalFolderImport.mockReturnValue(stubSource('Legal Folder'));
    const handle = makeHandle('granted', 'Wrong Folder');
    window.showDirectoryPicker = vi.fn().mockResolvedValue(handle);

    const result = await reauthorizeLegalFolder();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('name_mismatch');
    expect(result.expectedName).toBe('Legal Folder');
    expect(result.selectedName).toBe('Wrong Folder');
    expect(saveHandleToIndexedDB).not.toHaveBeenCalled();
  });

  it('does not call showSaveFilePicker', async () => {
    getLegalFolderImport.mockReturnValue(stubSource('Legal Folder'));
    window.showSaveFilePicker = vi.fn();
    const handle = makeHandle('granted', 'Legal Folder');
    window.showDirectoryPicker = vi.fn().mockResolvedValue(handle);

    await reauthorizeLegalFolder();
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
  });
});
