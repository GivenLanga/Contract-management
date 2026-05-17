import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDraft } from '../draftOpenService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID = {
  fileName: 'Service Agreement - Acme - Draft v1.docx',
  relativePath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
  displayPath: 'Contracts/2026/Services/Acme/Drafts/Service Agreement - Acme - Draft v1.docx',
  legalFolderSourceId: 'Legal Folder',
  templateTitle: 'Service Agreement Template',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extension: 'docx',
};

let savedLocationHref;
let infoSpy;
let warnSpy;

beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete window.contractiq;
  delete window.__contractiq_protocol_base;
  delete window.__contractiq_open_token;
  delete window.showSaveFilePicker;
  savedLocationHref = window.location.href;
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  delete window.contractiq;
  delete window.__contractiq_protocol_base;
  delete window.__contractiq_open_token;
  delete window.showSaveFilePicker;
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('Input validation', () => {
  it('rejects missing relativePath', async () => {
    const result = await openDraft({ ...VALID, relativePath: '' });
    expect(result.ok).toBe(false);
    expect(result.method).toBe('unsupported');
    expect(result.error).toBe('MISSING_RELATIVE_PATH');
  });

  it('rejects null relativePath', async () => {
    const result = await openDraft({ ...VALID, relativePath: null });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('MISSING_RELATIVE_PATH');
  });

  it('rejects invalid extension .exe', async () => {
    const result = await openDraft({ ...VALID, extension: 'exe' });
    expect(result.ok).toBe(false);
    expect(result.method).toBe('unsupported');
    expect(result.error).toBe('UNSUPPORTED_EXTENSION');
  });

  it('rejects invalid extension .pdf', async () => {
    const result = await openDraft({ ...VALID, extension: 'pdf' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('UNSUPPORTED_EXTENSION');
  });

  it('accepts .docx extension', async () => {
    const result = await openDraft(VALID);
    expect(result.method).toBe('browser_fallback');
  });

  it('accepts .doc extension', async () => {
    const result = await openDraft({ ...VALID, extension: 'doc' });
    expect(result.method).toBe('browser_fallback');
  });

  it('accepts .dotx extension', async () => {
    const result = await openDraft({ ...VALID, extension: 'dotx' });
    expect(result.method).toBe('browser_fallback');
  });
});

// ── Browser-only fallback ─────────────────────────────────────────────────────

describe('browser_fallback — no native bridge', () => {
  it('returns browser_fallback when no bridge and no protocol', async () => {
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('browser_fallback');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('does not call showSaveFilePicker', async () => {
    window.showSaveFilePicker = vi.fn();
    await openDraft(VALID);
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
  });
});

// ── Native bridge ─────────────────────────────────────────────────────────────

describe('native_bridge — window.contractiq', () => {
  it('logs and calls bridge when window.contractiq exists', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({
        ok: true,
        app: 'LibreOffice Writer',
        method: 'libreoffice_writer',
        message: 'Opening in LibreOffice Writer.',
      }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('libreoffice_writer');
    expect(window.contractiq.openDraft).toHaveBeenCalledWith({
      relativePath: VALID.relativePath,
      legalFolderSourceId: VALID.legalFolderSourceId,
      preferredApp: 'word',
    });
    expect(infoSpy).toHaveBeenCalledWith(
      '[draftOpenService] desktop bridge available',
      { hasContractiq: true, hasOpenDraftBridge: true }
    );
    expect(infoSpy).toHaveBeenCalledWith(
      '[draftOpenService] calling openDraft',
      {
        relativePath: VALID.relativePath,
        legalFolderSourceId: VALID.legalFolderSourceId,
        preferredApp: 'word',
      }
    );
  });

  it('propagates app name from bridge response in message and app field', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true, app: 'LibreOffice Writer' }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(true);
    expect(result.app).toBe('LibreOffice Writer');
    expect(result.message).toContain('LibreOffice Writer');
  });

  it('falls back to a generic editor label when bridge returns ok:true with no app', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(true);
    expect(result.app).toBe('your document editor');
  });

  it('returns the exact desktop error when the bridge fails with a known code', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({
        ok: false,
        code: 'LEGAL_FOLDER_ROOT_NOT_SET',
        message: 'Choose your Legal Folder before opening drafts.',
      }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('native_bridge');
    expect(result.code).toBe('LEGAL_FOLDER_ROOT_NOT_SET');
    expect(result.message).toContain('Legal Folder');
    expect(window.contractiq.openDraft).toHaveBeenCalledTimes(1);
  });

  it('falls back only when the bridge explicitly returns unsupported', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({
        ok: false,
        method: 'unsupported',
        code: 'UNSUPPORTED_DESKTOP_BRIDGE',
      }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('browser_fallback');
    expect(warnSpy).toHaveBeenCalledWith(
      '[draftOpenService] fallback',
      expect.objectContaining({ reason: 'desktop_bridge_returned_unsupported' })
    );
  });

  it('returns DESKTOP_BRIDGE_ERROR when bridge throws', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockRejectedValue(new Error('bridge crashed')),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('native_bridge');
    expect(result.code).toBe('DESKTOP_BRIDGE_ERROR');
    expect(result.message).toBe('bridge crashed');
  });

  it('does not return browser fallback wording when contractiq exists without openDraft', async () => {
    window.contractiq = {};
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('native_bridge');
    expect(result.code).toBe('DESKTOP_OPEN_BRIDGE_MISSING');
    expect(result.message).not.toMatch(/desktop app required/i);
  });

  it('passes relativePath and legalFolderSourceId to bridge, not absolute path', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    await openDraft(VALID);
    const call = window.contractiq.openDraft.mock.calls[0][0];
    expect(call).not.toHaveProperty('absolutePath');
    expect(call).toHaveProperty('relativePath');
    expect(call).toHaveProperty('legalFolderSourceId');
  });

  it('does not include nativePath in bridge args when createdDraft has no nativePath', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    await openDraft(VALID); // VALID has no nativePath
    const call = window.contractiq.openDraft.mock.calls[0][0];
    expect(call).not.toHaveProperty('nativePath');
  });

  it('includes nativePath in bridge args when createdDraft provides one', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true, app: 'LibreOffice Writer' }),
    };
    const draftWithPath = {
      ...VALID,
      nativePath: '/home/user/Legal Folder/Contracts/2026/Services/Acme/Drafts/Agreement v1.docx',
    };
    await openDraft(draftWithPath);
    const call = window.contractiq.openDraft.mock.calls[0][0];
    expect(call.nativePath).toBe(draftWithPath.nativePath);
    expect(call.relativePath).toBe(VALID.relativePath);
  });

  it('includes nativePath in the single bridge call when provided', async () => {
    const nativePath = '/home/user/Legal Folder/Contracts/2026/Services/Acme/Drafts/Agreement v1.docx';
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true, app: 'LibreOffice Writer' }),
    };
    await openDraft({ ...VALID, nativePath });
    const call = window.contractiq.openDraft.mock.calls[0][0];
    expect(call.nativePath).toBe(nativePath);
    expect(call.preferredApp).toBe('word');
    expect(window.contractiq.openDraft).toHaveBeenCalledTimes(1);
  });
});

// ── Custom protocol ───────────────────────────────────────────────────────────

describe('custom_protocol — window.__contractiq_protocol_base', () => {
  it('uses custom_protocol method when base is configured', async () => {
    // jsdom allows assigning location.href but won't navigate
    window.__contractiq_protocol_base = 'contractiq://open-draft';
    const result = await openDraft(VALID);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('custom_protocol');
  });

  it('includes relativePath and source in the protocol URL', async () => {
    window.__contractiq_protocol_base = 'contractiq://open-draft';
    // Spy on location to capture the href assignment
    let capturedHref = '';
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        set href(v) { capturedHref = v; },
        get href() { return savedLocationHref; },
      },
    });

    await openDraft(VALID);
    expect(capturedHref).toContain(encodeURIComponent(VALID.relativePath));
    expect(capturedHref).toContain(encodeURIComponent(VALID.legalFolderSourceId));
  });

  it('is not used when __contractiq_protocol_base is absent', async () => {
    const result = await openDraft(VALID);
    expect(result.method).not.toBe('custom_protocol');
  });

  it('custom protocol takes lower priority than native bridge', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true, method: 'libreoffice_writer' }),
    };
    window.__contractiq_protocol_base = 'contractiq://open-draft';
    const result = await openDraft(VALID);
    expect(result.method).toBe('libreoffice_writer');
  });
});
