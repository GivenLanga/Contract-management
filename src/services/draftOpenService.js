// Draft opener service — capability-based, browser-first.
//
// Strategy order:
//   1. window.contractiq native bridge (Electron/Tauri/local desktop helper)
//   2. window.__contractiq_protocol_base custom URI scheme (registered by desktop app)
//   3. Browser-only fallback (honest: cannot auto-open)
//
// Never passes raw absolute paths from the frontend.
// Never uses showSaveFilePicker, anchor downloads, or cloud uploads.

const ALLOWED_EXTENSIONS = new Set(['docx', 'doc', 'dotx', 'odt']);

function normalizeExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '');
}

function validate({ relativePath, extension }) {
  if (!relativePath) {
    return {
      ok: false,
      method: 'unsupported',
      message: 'Missing file path — cannot open draft.',
      error: 'MISSING_PATH',
    };
  }
  if (!ALLOWED_EXTENSIONS.has(normalizeExt(extension))) {
    return {
      ok: false,
      method: 'unsupported',
      message: `File type "${normalizeExt(extension) || 'unknown'}" is not supported for opening.`,
      error: 'INVALID_EXTENSION',
    };
  }
  return null;
}

/**
 * Attempts to open a draft file using the best available mechanism.
 *
 * @param {{
 *   fileName: string,
 *   relativePath: string,
 *   displayPath: string,
 *   legalFolderSourceId?: string,
 *   templateTitle?: string,
 *   fileHandle?: FileSystemFileHandle,
 *   directoryHandle?: FileSystemDirectoryHandle,
 *   absolutePathHint?: string,
 *   draftId?: string,
 *   mimeType?: string,
 *   extension: string,
 * }} createdDraft
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   method: 'native_bridge_word' | 'native_bridge_default' | 'custom_protocol' | 'browser_fallback' | 'unsupported',
 *   message: string,
 *   error?: string,
 * }>}
 */
export async function openDraft(createdDraft) {
  const { relativePath, extension, legalFolderSourceId } = createdDraft || {};

  const invalid = validate({ relativePath, extension });
  if (invalid) return invalid;

  // 1. Native bridge (Electron / Tauri / local helper exposes window.contractiq)
  if (typeof window !== 'undefined' && typeof window.contractiq?.openDraft === 'function') {
    try {
      const wordResult = await window.contractiq.openDraft({
        relativePath,
        legalFolderSourceId,
        preferredApp: 'word',
      });
      if (wordResult?.ok) {
        return { ok: true, method: 'native_bridge_word', message: 'Opening in Microsoft Word…' };
      }
      const defaultResult = await window.contractiq.openDraft({
        relativePath,
        legalFolderSourceId,
        preferredApp: 'default',
      });
      if (defaultResult?.ok) {
        return {
          ok: true,
          method: 'native_bridge_default',
          message: 'Opening in your default document editor…',
        };
      }
    } catch {
      // Bridge call failed — fall through
    }
  }

  // 2. Custom protocol handler (registered by desktop installer, not the web page)
  const protocolBase =
    typeof window !== 'undefined' && window.__contractiq_protocol_base;
  if (protocolBase) {
    try {
      const tokenFn = window.__contractiq_open_token;
      const token = typeof tokenFn === 'function' ? tokenFn() : '';
      const url =
        `${protocolBase}?path=${encodeURIComponent(relativePath)}` +
        `&source=${encodeURIComponent(legalFolderSourceId || '')}` +
        `&token=${encodeURIComponent(token)}`;
      window.location.href = url;
      return { ok: true, method: 'custom_protocol', message: 'Opening via ContractIQ protocol handler…' };
    } catch {
      // Protocol handler not available — fall through
    }
  }

  // 3. Browser-only fallback — honest: cannot auto-open from a web page
  return {
    ok: false,
    method: 'browser_fallback',
    message:
      'Automatic opening requires the ContractIQ desktop app. ' +
      'The draft was created successfully. Open it from the Legal Folder path shown.',
  };
}
