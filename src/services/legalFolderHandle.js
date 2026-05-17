// Session-scoped store for the active FileSystemDirectoryHandle.
// The handle is set when the user picks the Legal Folder (readwrite mode).
//
// FileSystemDirectoryHandle objects are structured-cloneable and CAN be stored
// in IndexedDB. On page reload we retrieve the stored handle and call
// queryPermission / requestPermission to restore write access without forcing
// the user to re-pick the folder every session.

let _handle = null;

// ── In-memory accessors ───────────────────────────────────────────────────────

export function setLegalFolderHandle(handle) {
  _handle = handle || null;
}

export function getLegalFolderHandle() {
  return _handle;
}

export function clearLegalFolderHandle() {
  _handle = null;
}

export function hasLegalFolderHandle() {
  return _handle !== null;
}

// ── IndexedDB persistence ─────────────────────────────────────────────────────

const IDB_NAME = 'clm_legal_folder_handle_v1';
const IDB_VERSION = 1;
const IDB_STORE = 'handles';
const HANDLE_KEY = 'root';

function openHandleDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Cannot open handle store'));
  });
}

/**
 * Persists the FileSystemDirectoryHandle to IndexedDB so it survives page reload.
 * Non-fatal — callers should not depend on this succeeding.
 */
export async function saveHandleToIndexedDB(handle) {
  if (!handle) return;
  try {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
      req.onsuccess = () => { db.close(); resolve(); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    // Non-fatal — in-memory handle still works for this browser session
  }
}

/**
 * Loads the stored FileSystemDirectoryHandle from IndexedDB.
 * Returns null if no handle is stored or IndexedDB is unavailable.
 * The returned handle still requires queryPermission / requestPermission.
 */
export async function loadHandleFromIndexedDB() {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch {
    return null;
  }
}

/**
 * Removes the stored FileSystemDirectoryHandle from IndexedDB.
 * Called on disconnect so stale handles don't restore after a disconnect.
 */
export async function clearHandleFromIndexedDB() {
  try {
    const db = await openHandleDb();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch {
    // Non-fatal
  }
}
