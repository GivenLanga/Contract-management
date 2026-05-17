'use strict';

const crypto = require('crypto');
const nodePath = require('path');

const ALLOWED_EXTENSIONS = new Set(['.docx', '.doc', '.dotx', '.odt']);

function logInfo(logger, message, details) {
  if (logger && typeof logger.info === 'function') logger.info(message, details);
}

function logWarn(logger, message, details) {
  if (logger && typeof logger.warn === 'function') logger.warn(message, details);
}

function createLegalFolderSourceId(rootPath) {
  if (!rootPath) return null;
  const hash = crypto.createHash('sha256').update(String(rootPath)).digest('hex').slice(0, 16);
  return `legal-folder:${hash}`;
}

function getSafeLegalFolderMetadata(rootPath, { includeDebugRoot = false, pathModule = nodePath } = {}) {
  const hasRoot = Boolean(rootPath);
  const metadata = {
    ok: true,
    hasRoot,
    sourceId: hasRoot ? createLegalFolderSourceId(rootPath) : null,
    rootName: hasRoot ? pathModule.basename(rootPath) : null,
  };
  if (includeDebugRoot && hasRoot) metadata.debugRoot = rootPath;
  return metadata;
}

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

function isAbsoluteLike(input, pathModule = nodePath) {
  const value = String(input || '');
  return (
    pathModule.isAbsolute(value) ||
    nodePath.posix.isAbsolute(value) ||
    nodePath.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  );
}

function hasTraversal(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => part === '..');
}

function normalizeRelativeForPlatform(input, pathModule = nodePath) {
  return String(input).replace(/[\\/]+/g, pathModule.sep);
}

function isInsideRoot(rootPath, absolutePath, pathModule = nodePath) {
  const relative = pathModule.relative(rootPath, absolutePath);
  return Boolean(relative) && !relative.startsWith('..') && !pathModule.isAbsolute(relative);
}

function validateExtensionAndExists(absolutePath, { fsModule, pathModule = nodePath, logger } = {}) {
  const ext = pathModule.extname(absolutePath).toLowerCase();
  const extensionSupported = ALLOWED_EXTENSIONS.has(ext);
  logInfo(logger, '[electron:openDraft] extension result', {
    extension: ext || null,
    supported: extensionSupported,
  });

  if (!extensionSupported) {
    return failure(
      'UNSUPPORTED_EXTENSION',
      `File type "${ext || 'unknown'}" is not supported.`
    );
  }

  const exists = Boolean(fsModule && fsModule.existsSync(absolutePath));
  logInfo(logger, '[electron:openDraft] file exists result', {
    absolutePath,
    exists,
  });

  if (!exists) {
    return failure('FILE_NOT_FOUND', 'The draft file was not found on disk.', {
      absolutePath,
    });
  }

  return { ok: true, extension: ext };
}

function resolveOpenDraftTarget(payload = {}, options = {}) {
  const {
    legalFolderRoot,
    fsModule,
    pathModule = nodePath,
    logger,
  } = options;

  const relativePath = payload.relativePath;
  const nativePath = payload.nativePath;
  const hasNativePath = typeof nativePath === 'string' && nativePath.length > 0;

  logInfo(logger, '[electron:openDraft] relativePath received', { relativePath });
  logInfo(logger, '[electron:openDraft] nativePath received', { hasNativePath, nativePath });
  logInfo(logger, '[electron:openDraft] legalFolderRoot availability', {
    hasRoot: Boolean(legalFolderRoot),
  });

  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return failure('MISSING_RELATIVE_PATH', 'No draft relative path was provided.');
  }

  const cleanRelativePath = relativePath.trim();
  if (isAbsoluteLike(cleanRelativePath, pathModule) || hasTraversal(cleanRelativePath)) {
    return failure(
      'PATH_TRAVERSAL_BLOCKED',
      'Draft path must be relative and stay inside the Legal Folder.'
    );
  }

  if (legalFolderRoot) {
    const rootResolved = pathModule.resolve(legalFolderRoot);
    const relativeForPlatform = normalizeRelativeForPlatform(cleanRelativePath, pathModule);
    const absolutePath = pathModule.resolve(rootResolved, relativeForPlatform);

    logInfo(logger, '[electron:openDraft] selected strategy', {
      strategy: 'legalFolderRoot_relativePath',
    });
    logInfo(logger, '[electron:openDraft] resolved absolute path', {
      legalFolderRoot: rootResolved,
      relativePath: cleanRelativePath,
      absolutePath,
    });

    if (!isInsideRoot(rootResolved, absolutePath, pathModule)) {
      return failure(
        'PATH_TRAVERSAL_BLOCKED',
        'Draft path resolved outside the Legal Folder.'
      );
    }

    const valid = validateExtensionAndExists(absolutePath, { fsModule, pathModule, logger });
    if (!valid.ok) return valid;

    return {
      ok: true,
      strategy: 'legalFolderRoot_relativePath',
      absolutePath,
      relativePath: cleanRelativePath,
      extension: valid.extension,
    };
  }

  if (hasNativePath) {
    if (!isAbsoluteLike(nativePath, pathModule)) {
      return failure('PATH_TRAVERSAL_BLOCKED', 'Native draft path must be absolute.');
    }

    const absolutePath = pathModule.resolve(nativePath);
    logInfo(logger, '[electron:openDraft] selected strategy', {
      strategy: 'nativePath_fallback',
    });
    logInfo(logger, '[electron:openDraft] resolved absolute path', {
      absolutePath,
      nativePath,
    });

    const valid = validateExtensionAndExists(absolutePath, { fsModule, pathModule, logger });
    if (!valid.ok) return valid;

    return {
      ok: true,
      strategy: 'nativePath_fallback',
      absolutePath,
      relativePath: cleanRelativePath,
      extension: valid.extension,
    };
  }

  logInfo(logger, '[electron:openDraft] selected strategy', {
    strategy: 'none',
    reason: 'LEGAL_FOLDER_ROOT_NOT_SET',
  });

  return failure(
    'LEGAL_FOLDER_ROOT_NOT_SET',
    'ContractIQ Desktop needs to know your Legal Folder location before it can open the draft.'
  );
}

async function openLinuxDocument(absolutePath, { spawnDetached, logger } = {}) {
  const candidates = [
    {
      cmd: 'libreoffice',
      args: ['--writer', absolutePath],
      app: 'LibreOffice Writer',
      method: 'libreoffice_writer',
      message: 'Opening in LibreOffice Writer.',
    },
    {
      cmd: 'onlyoffice-desktopeditors',
      args: [absolutePath],
      app: 'OnlyOffice Desktop Editors',
      method: 'onlyoffice_desktopeditors',
      message: 'Opening in OnlyOffice Desktop Editors.',
    },
    {
      cmd: 'wps',
      args: [absolutePath],
      app: 'WPS Writer',
      method: 'wps_writer',
      message: 'Opening in WPS Writer.',
    },
    {
      cmd: 'xdg-open',
      args: [absolutePath],
      app: 'Default Document App',
      method: 'xdg_open',
      message: 'Opening in the default document app.',
    },
  ];

  const attempts = [];
  for (const candidate of candidates) {
    logInfo(logger, '[electron:openDraft] opener attempt', {
      command: candidate.cmd,
      args: candidate.args,
      method: candidate.method,
    });

    try {
      await spawnDetached(candidate.cmd, candidate.args);
      return {
        ok: true,
        app: candidate.app,
        method: candidate.method,
        message: candidate.message,
      };
    } catch (err) {
      const attempt = {
        command: candidate.cmd,
        method: candidate.method,
        code: err?.code || null,
        message: err?.message || String(err),
      };
      attempts.push(attempt);
      logWarn(logger, '[electron:openDraft] opener failed', attempt);
    }
  }

  return failure(
    'NO_OPENER_AVAILABLE',
    'No supported document opener is available. Install LibreOffice Writer or configure a default document app.',
    { attempts }
  );
}

async function openResolvedDraft(absolutePath, payload = {}, options = {}) {
  const {
    platform = process.platform,
    spawnDetached,
    shellOpenPath,
    logger,
  } = options;

  logInfo(logger, '[electron:openDraft] preferred app', {
    preferredApp: payload.preferredApp || null,
    platform,
  });

  if (platform === 'linux') {
    return openLinuxDocument(absolutePath, { spawnDetached, logger });
  }

  if (platform === 'darwin') {
    const args = payload.preferredApp === 'word'
      ? ['-a', 'Microsoft Word', absolutePath]
      : [absolutePath];
    try {
      await spawnDetached('open', args);
      const isWord = payload.preferredApp === 'word';
      return {
        ok: true,
        app: isWord ? 'Microsoft Word' : 'Default Document App',
        method: isWord ? 'ms_word_mac' : 'open_default',
        message: isWord ? 'Opening in Microsoft Word.' : 'Opening in the default document app.',
      };
    } catch (err) {
      logWarn(logger, '[electron:openDraft] opener failed', {
        command: 'open',
        code: err?.code || null,
        message: err?.message || String(err),
      });
      return failure('NO_OPENER_AVAILABLE', 'Could not open the draft on macOS.');
    }
  }

  if (platform === 'win32') {
    if (typeof shellOpenPath === 'function') {
      const shellError = await shellOpenPath(absolutePath);
      if (!shellError) {
        return {
          ok: true,
          app: 'Default Document App',
          method: 'shell_open_path',
          message: 'Opening in the default document app.',
        };
      }
      logWarn(logger, '[electron:openDraft] opener failed', {
        command: 'shell.openPath',
        code: null,
        message: shellError,
      });
    }
    return failure('NO_OPENER_AVAILABLE', 'Could not open the draft on Windows.');
  }

  return failure('NO_OPENER_AVAILABLE', `Platform "${platform}" is not supported for opening drafts.`);
}

async function openDraftWithDesktopStrategy(payload = {}, options = {}) {
  const logger = options.logger;
  const target = resolveOpenDraftTarget(payload, options);
  if (!target.ok) {
    logInfo(logger, '[electron:openDraft] final result', target);
    return target;
  }

  const result = await openResolvedDraft(target.absolutePath, payload, options);
  logInfo(logger, '[electron:openDraft] final result', {
    ...result,
    absolutePath: target.absolutePath,
    strategy: target.strategy,
  });
  return result;
}

module.exports = {
  ALLOWED_EXTENSIONS,
  createLegalFolderSourceId,
  getSafeLegalFolderMetadata,
  resolveOpenDraftTarget,
  openDraftWithDesktopStrategy,
  openLinuxDocument,
};
