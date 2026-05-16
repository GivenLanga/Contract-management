// Session-scoped store for the active FileSystemDirectoryHandle.
// The handle is set when the user picks the Legal Folder (readwrite mode) and
// remains valid for the current browser session. It cannot be serialised to
// localStorage, so it is lost on page reload — the user must reconnect.

let _handle = null;

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
