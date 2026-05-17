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

beforeEach(() => {
  delete window.contractiq;
  delete window.__contractiq_protocol_base;
  delete window.__contractiq_open_token;
  delete window.showSaveFilePicker;
  savedLocationHref = window.location.href;
});

afterEach(() => {
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
    expect(result.error).toBe('MISSING_PATH');
  });

  it('rejects null relativePath', async () => {
    const result = await openDraft({ ...VALID, relativePath: null });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('MISSING_PATH');
  });

  it('rejects invalid extension .exe', async () => {
    const result = await openDraft({ ...VALID, extension: 'exe' });
    expect(result.ok).toBe(false);
    expect(result.method).toBe('unsupported');
    expect(result.error).toBe('INVALID_EXTENSION');
  });

  it('rejects invalid extension .pdf', async () => {
    const result = await openDraft({ ...VALID, extension: 'pdf' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('INVALID_EXTENSION');
  });

  it('accepts .docx extension', async () => {
    const result = await openDraft(VALID);
    expect(result.error).toBeUndefined();
  });

  it('accepts .doc extension', async () => {
    const result = await openDraft({ ...VALID, extension: 'doc' });
    expect(result.error).toBeUndefined();
  });

  it('accepts .dotx extension', async () => {
    const result = await openDraft({ ...VALID, extension: 'dotx' });
    expect(result.error).toBeUndefined();
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
  it('returns native_bridge_word when bridge succeeds with word', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('native_bridge_word');
    expect(window.contractiq.openDraft).toHaveBeenCalledWith({
      relativePath: VALID.relativePath,
      legalFolderSourceId: VALID.legalFolderSourceId,
      preferredApp: 'word',
    });
  });

  it('falls back to native_bridge_default when word fails but default succeeds', async () => {
    window.contractiq = {
      openDraft: vi.fn()
        .mockResolvedValueOnce({ ok: false })   // word → fail
        .mockResolvedValueOnce({ ok: true }),    // default → success
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('native_bridge_default');
    expect(window.contractiq.openDraft).toHaveBeenCalledTimes(2);
  });

  it('returns browser_fallback when both word and default fail', async () => {
    window.contractiq = {
      openDraft: vi.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false }),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('browser_fallback');
  });

  it('returns browser_fallback when bridge throws', async () => {
    window.contractiq = {
      openDraft: vi.fn().mockRejectedValue(new Error('bridge crashed')),
    };
    const result = await openDraft(VALID);
    expect(result.ok).toBe(false);
    expect(result.method).toBe('browser_fallback');
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
      openDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    window.__contractiq_protocol_base = 'contractiq://open-draft';
    const result = await openDraft(VALID);
    expect(result.method).toBe('native_bridge_word');
  });
});
