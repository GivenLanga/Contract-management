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

function getDesktopBridgeState() {
  const hasContractiq = typeof window !== 'undefined' && Boolean(window.contractiq);
  const hasOpenDraftBridge =
    typeof window !== 'undefined' && typeof window.contractiq?.openDraft === 'function';
  return { hasContractiq, hasOpenDraftBridge };
}

function isUnsupportedBridgeResult(result) {
  return (
    result?.method === 'unsupported' ||
    result?.code === 'UNSUPPORTED' ||
    result?.code === 'UNSUPPORTED_DESKTOP_BRIDGE'
  );
}

function validate({ relativePath, extension }) {
  if (!relativePath) {
    return {
      ok: false,
      method: 'unsupported',
      message: 'Missing file path — cannot open draft.',
      code: 'MISSING_RELATIVE_PATH',
      error: 'MISSING_RELATIVE_PATH',
    };
  }
  if (!ALLOWED_EXTENSIONS.has(normalizeExt(extension))) {
    return {
      ok: false,
      method: 'unsupported',
      message: `File type "${normalizeExt(extension) || 'unknown'}" is not supported for opening.`,
      code: 'UNSUPPORTED_EXTENSION',
      error: 'UNSUPPORTED_EXTENSION',
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
 *   method: 'native_bridge' | 'custom_protocol' | 'browser_fallback' | 'unsupported',
 *   message: string,
 *   code?: string,
 *   error?: string,
 * }>}
 */
export async function openDraft(createdDraft) {
  const { relativePath, extension, legalFolderSourceId, nativePath } = createdDraft || {};

  const invalid = validate({ relativePath, extension });
  if (invalid) return invalid;

  // 1. Native bridge (Electron / Tauri / local helper exposes window.contractiq)
  const bridgeState = getDesktopBridgeState();
  console.info('[draftOpenService] desktop bridge available', bridgeState);

  if (bridgeState.hasOpenDraftBridge) {
    try {
      const payload = {
        relativePath,
        legalFolderSourceId,
        preferredApp: 'word',
      };
      if (nativePath) payload.nativePath = nativePath;

      console.info('[draftOpenService] calling openDraft', payload);
      const result = await window.contractiq.openDraft(payload);
      console.info('[draftOpenService] openDraft result', result);

      if (result?.ok) {
        const app = result.app || 'your document editor';
        return {
          ok: true,
          method: result.method || 'native_bridge',
          message: result.message || `Opening in ${app}…`,
          app,
        };
      }

      if (!isUnsupportedBridgeResult(result)) {
        return {
          ok: false,
          method: result?.method || 'native_bridge',
          code: result?.code || result?.error || 'DESKTOP_OPEN_FAILED',
          error: result?.code || result?.error || 'DESKTOP_OPEN_FAILED',
          message: result?.message || 'ContractIQ Desktop could not open the draft.',
          app: result?.app,
        };
      }

      console.warn('[draftOpenService] fallback', {
        reason: 'desktop_bridge_returned_unsupported',
        result,
      });
    } catch (err) {
      const result = {
        ok: false,
        method: 'native_bridge',
        code: 'DESKTOP_BRIDGE_ERROR',
        error: 'DESKTOP_BRIDGE_ERROR',
        message: err?.message || 'ContractIQ Desktop bridge failed while opening the draft.',
      };
      console.info('[draftOpenService] openDraft result', result);
      return result;
    }
  } else {
    console.warn('[draftOpenService] fallback', {
      reason: bridgeState.hasContractiq ? 'openDraft_bridge_missing' : 'contractiq_bridge_missing',
    });
    if (bridgeState.hasContractiq) {
      return {
        ok: false,
        method: 'native_bridge',
        code: 'DESKTOP_OPEN_BRIDGE_MISSING',
        error: 'DESKTOP_OPEN_BRIDGE_MISSING',
        message: 'ContractIQ Desktop is running, but the Open Draft bridge is not available.',
      };
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
    } catch (err) {
      console.warn('[draftOpenService] fallback', {
        reason: 'custom_protocol_failed',
        message: err?.message || String(err),
      });
      // Protocol handler not available — fall through
    }
  }

  // 3. Browser-only fallback — honest: cannot auto-open from a web page
  console.warn('[draftOpenService] fallback', {
    reason: 'browser_only_no_open_capability',
  });
  return {
    ok: false,
    method: 'browser_fallback',
    code: 'BROWSER_OPEN_UNSUPPORTED',
    error: 'BROWSER_OPEN_UNSUPPORTED',
    message:
      'Automatic opening requires the ContractIQ desktop app. ' +
      'The draft was created successfully. Open it from the Legal Folder path shown.',
  };
}
