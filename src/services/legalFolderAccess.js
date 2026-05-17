// Legal Folder capability service.
// Distinguishes three capability states:
//   DISCONNECTED          — no index, no templates, no documents
//   INDEX_ONLY / WRITE_REAUTH_REQUIRED — index exists, but write handle is missing or revoked
//   WRITE_READY           — root handle is present with granted readwrite permission
//
// Also handles UNSUPPORTED_BROWSER for browsers without File System Access API.

import { getLegalFolderImport } from './legalFolderStore';
import {
  getLegalFolderHandle,
  setLegalFolderHandle,
  loadHandleFromIndexedDB,
  saveHandleToIndexedDB,
} from './legalFolderHandle';

export const FOLDER_STATE = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  INDEX_ONLY: 'INDEX_ONLY',
  UNSUPPORTED_BROWSER: 'UNSUPPORTED_BROWSER',
  WRITE_REAUTH_REQUIRED: 'WRITE_REAUTH_REQUIRED',
  WRITE_READY: 'WRITE_READY',
});

function detectCaps() {
  return {
    browserSupportsDirectoryPicker:
      typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    browserSupportsWritableStreams:
      typeof window !== 'undefined' && 'FileSystemWritableFileStream' in window,
    browserSupportsPersistentHandles:
      typeof indexedDB !== 'undefined',
  };
}

/**
 * Returns a full Legal Folder capability status object.
 *
 * Async because it may load the handle from IndexedDB and call queryPermission.
 * Never calls requestPermission — that requires an explicit user gesture.
 *
 * @returns {Promise<{
 *   hasIndex: boolean,
 *   sourceId: string | null,
 *   sourceName: string | null,
 *   hasRootHandle: boolean,
 *   canRead: boolean,
 *   canWrite: boolean,
 *   writePermission: "granted" | "prompt" | "denied" | "unsupported" | "unknown",
 *   browserSupportsDirectoryPicker: boolean,
 *   browserSupportsWritableStreams: boolean,
 *   browserSupportsPersistentHandles: boolean,
 *   state: string,
 * }>}
 */
export async function getLegalFolderStatus() {
  const caps = detectCaps();
  const snapshot = getLegalFolderImport();
  const hasIndex = !!snapshot.source;

  const base = {
    hasIndex,
    sourceId: snapshot.source?.name ?? null,
    sourceName: snapshot.source?.name ?? null,
    hasRootHandle: false,
    canRead: hasIndex,
    canWrite: false,
    writePermission: 'unknown',
    ...caps,
  };

  if (!hasIndex) {
    return { ...base, state: FOLDER_STATE.DISCONNECTED };
  }

  if (!caps.browserSupportsDirectoryPicker) {
    // Index exists (templates are visible) but the browser cannot grant write access.
    // INDEX_ONLY is the accurate label — the folder was connected via file input.
    return {
      ...base,
      state: FOLDER_STATE.UNSUPPORTED_BROWSER,
      writePermission: 'unsupported',
    };
  }

  // Try memory first, then IndexedDB
  let handle = getLegalFolderHandle();
  if (!handle) {
    handle = await loadHandleFromIndexedDB();
    if (handle) setLegalFolderHandle(handle);
  }

  if (!handle) {
    return {
      ...base,
      state: FOLDER_STATE.WRITE_REAUTH_REQUIRED,
      writePermission: 'prompt',
    };
  }

  // Check permission without prompting the user
  let writePermission = 'unknown';
  try {
    writePermission = await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    writePermission = 'unknown';
  }

  if (writePermission === 'granted') {
    return {
      ...base,
      hasRootHandle: true,
      canWrite: true,
      writePermission,
      state: FOLDER_STATE.WRITE_READY,
    };
  }

  // 'prompt', 'denied', or 'unknown' — needs user interaction to restore
  return {
    ...base,
    hasRootHandle: true,
    writePermission,
    state: FOLDER_STATE.WRITE_REAUTH_REQUIRED,
  };
}

/**
 * Ensures write access is available, requesting permission if needed.
 * Must be called from a user-gesture context (button click, form submit).
 *
 * @returns {Promise<string>} A FOLDER_STATE value
 */
export async function ensureLegalFolderWriteAccess() {
  const caps = detectCaps();
  const snapshot = getLegalFolderImport();

  if (!snapshot.source) return FOLDER_STATE.DISCONNECTED;
  if (!caps.browserSupportsDirectoryPicker) return FOLDER_STATE.UNSUPPORTED_BROWSER;

  let handle = getLegalFolderHandle();
  if (!handle) {
    handle = await loadHandleFromIndexedDB();
    if (handle) setLegalFolderHandle(handle);
  }

  if (!handle) return FOLDER_STATE.WRITE_REAUTH_REQUIRED;

  try {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') return FOLDER_STATE.WRITE_READY;

    if (permission === 'prompt') {
      // requestPermission is safe here because this function is called from a user gesture
      permission = await handle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') return FOLDER_STATE.WRITE_READY;
    }
  } catch {
    // Permission API not available or call failed
  }

  return FOLDER_STATE.WRITE_REAUTH_REQUIRED;
}

/**
 * Opens a directory picker asking the user to re-select the Legal Folder root.
 * Validates the selection against the expected source name, stores the handle
 * in both memory and IndexedDB, then returns the result.
 *
 * Must be called from a user-gesture context.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   handle?: FileSystemDirectoryHandle,
 *   reason?: string,
 *   expectedName?: string,
 *   selectedName?: string,
 * }>}
 */
export async function reauthorizeLegalFolder() {
  const snapshot = getLegalFolderImport();
  const expectedName = snapshot.source?.name ?? null;

  let newHandle;
  try {
    newHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err?.name === 'AbortError') return { success: false, reason: 'cancelled' };
    return { success: false, reason: 'picker_failed', message: err?.message };
  }

  // Validate folder name — the primary identifier for the Legal Folder root
  if (expectedName && newHandle.name !== expectedName) {
    return {
      success: false,
      reason: 'name_mismatch',
      expectedName,
      selectedName: newHandle.name,
    };
  }

  setLegalFolderHandle(newHandle);
  await saveHandleToIndexedDB(newHandle);
  return { success: true, handle: newHandle };
}
