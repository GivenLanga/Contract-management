import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  resolveOpenDraftTarget,
  openDraftWithDesktopStrategy,
} = require('../../../electron/openDraftCore.js');

const ROOT = '/home/creepydoll/Documents/sa_mock_contracts_pack';
const RELATIVE_PATH = 'Contracts/2026/Addenda/BackSlash/Drafts/Addendum Template 1 - BackSlash - Draft v2.docx';
const ABSOLUTE_PATH = path.resolve(ROOT, RELATIVE_PATH);

function fakeFs(existingPaths = [ABSOLUTE_PATH]) {
  return {
    existsSync: vi.fn((candidate) => existingPaths.includes(candidate)),
  };
}

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function enoent(command) {
  const err = new Error(`${command} not found`);
  err.code = 'ENOENT';
  return err;
}

describe('electron openDraft core — path resolution', () => {
  it('openDraft with valid relativePath uses legalFolderRoot', () => {
    const result = resolveOpenDraftTarget(
      { relativePath: RELATIVE_PATH, preferredApp: 'word' },
      { legalFolderRoot: ROOT, fsModule: fakeFs(), pathModule: path, logger: fakeLogger() }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('legalFolderRoot_relativePath');
    expect(result.absolutePath).toBe(ABSOLUTE_PATH);
  });

  it('returns LEGAL_FOLDER_ROOT_NOT_SET when no root or nativePath is available', () => {
    const result = resolveOpenDraftTarget(
      { relativePath: RELATIVE_PATH, preferredApp: 'word' },
      { legalFolderRoot: null, fsModule: fakeFs(), pathModule: path, logger: fakeLogger() }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('LEGAL_FOLDER_ROOT_NOT_SET');
  });

  it('rejects absolute paths', () => {
    const result = resolveOpenDraftTarget(
      { relativePath: '/etc/passwd' },
      { legalFolderRoot: ROOT, fsModule: fakeFs(), pathModule: path, logger: fakeLogger() }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('rejects ../ traversal', () => {
    const result = resolveOpenDraftTarget(
      { relativePath: '../secret.docx' },
      { legalFolderRoot: ROOT, fsModule: fakeFs(), pathModule: path, logger: fakeLogger() }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('rejects unsupported extension', () => {
    const pdfPath = 'Contracts/2026/Addenda/BackSlash/Drafts/Addendum.pdf';
    const result = resolveOpenDraftTarget(
      { relativePath: pdfPath },
      {
        legalFolderRoot: ROOT,
        fsModule: fakeFs([path.resolve(ROOT, pdfPath)]),
        pathModule: path,
        logger: fakeLogger(),
      }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNSUPPORTED_EXTENSION');
  });

  it('returns FILE_NOT_FOUND when file is missing', () => {
    const result = resolveOpenDraftTarget(
      { relativePath: RELATIVE_PATH },
      { legalFolderRoot: ROOT, fsModule: fakeFs([]), pathModule: path, logger: fakeLogger() }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('FILE_NOT_FOUND');
  });
});

describe('electron openDraft core — Linux opener order', () => {
  it('tries libreoffice first', async () => {
    const calls = [];
    const spawnDetached = vi.fn(async (command, args) => {
      calls.push({ command, args });
    });

    const result = await openDraftWithDesktopStrategy(
      { relativePath: RELATIVE_PATH, preferredApp: 'word' },
      {
        legalFolderRoot: ROOT,
        platform: 'linux',
        fsModule: fakeFs(),
        pathModule: path,
        spawnDetached,
        logger: fakeLogger(),
      }
    );

    expect(result.ok).toBe(true);
    expect(result.method).toBe('libreoffice_writer');
    expect(calls[0]).toEqual({
      command: 'libreoffice',
      args: ['--writer', ABSOLUTE_PATH],
    });
  });

  it('falls back to xdg-open after office launchers fail', async () => {
    const calls = [];
    const spawnDetached = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (command !== 'xdg-open') throw enoent(command);
    });

    const result = await openDraftWithDesktopStrategy(
      { relativePath: RELATIVE_PATH, preferredApp: 'word' },
      {
        legalFolderRoot: ROOT,
        platform: 'linux',
        fsModule: fakeFs(),
        pathModule: path,
        spawnDetached,
        logger: fakeLogger(),
      }
    );

    expect(result.ok).toBe(true);
    expect(result.method).toBe('xdg_open');
    expect(calls.map((call) => call.command)).toEqual([
      'libreoffice',
      'onlyoffice-desktopeditors',
      'wps',
      'xdg-open',
    ]);
  });

  it('logs ENOENT clearly for failed opener attempts', async () => {
    const logger = fakeLogger();
    const spawnDetached = vi.fn(async (command) => {
      throw enoent(command);
    });

    const result = await openDraftWithDesktopStrategy(
      { relativePath: RELATIVE_PATH, preferredApp: 'word' },
      {
        legalFolderRoot: ROOT,
        platform: 'linux',
        fsModule: fakeFs(),
        pathModule: path,
        spawnDetached,
        logger,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_OPENER_AVAILABLE');
    expect(logger.warn).toHaveBeenCalledWith(
      '[electron:openDraft] opener failed',
      expect.objectContaining({
        command: 'libreoffice',
        code: 'ENOENT',
      })
    );
  });
});
