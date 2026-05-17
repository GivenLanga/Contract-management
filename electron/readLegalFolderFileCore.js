'use strict';

const nodePath = require('path');

const ALLOWED_EXTENSIONS = new Set(['.docx', '.dotx', '.doc', '.pdf', '.txt', '.md']);

const MIME_TYPES = new Map([
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
  ['.doc', 'application/msword'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
]);

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

async function statFile(fsModule, absolutePath) {
  if (fsModule?.promises?.stat) return fsModule.promises.stat(absolutePath);
  return fsModule.statSync(absolutePath);
}

async function readFileBuffer(fsModule, absolutePath) {
  if (fsModule?.promises?.readFile) return fsModule.promises.readFile(absolutePath);
  return fsModule.readFileSync(absolutePath);
}

function toArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer;
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function safeReadLegalFolderFilePayload(payload = {}) {
  return {
    relativePath: payload.relativePath,
  };
}

async function readLegalFolderFileFromRoot(payload = {}, options = {}) {
  const {
    legalFolderRoot,
    fsModule,
    pathModule = nodePath,
    logger,
  } = options;

  const relativePath = payload.relativePath;

  logger?.info?.('[electron:readLegalFolderFile] handler called', {
    hasRoot: Boolean(legalFolderRoot),
    relativePath,
  });

  if (!legalFolderRoot) {
    return failure(
      'LEGAL_FOLDER_ROOT_NOT_SET',
      'Choose your Legal Folder in ContractIQ Desktop before using templates.'
    );
  }

  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return failure('MISSING_RELATIVE_PATH', 'No template relative path was provided.');
  }

  const cleanRelativePath = relativePath.trim();
  if (isAbsoluteLike(cleanRelativePath, pathModule) || hasTraversal(cleanRelativePath)) {
    return failure(
      'PATH_TRAVERSAL_BLOCKED',
      'Template path must be relative and stay inside the Legal Folder.'
    );
  }

  const rootResolved = pathModule.resolve(legalFolderRoot);
  const relativeForPlatform = normalizeRelativeForPlatform(cleanRelativePath, pathModule);
  const absolutePath = pathModule.resolve(rootResolved, relativeForPlatform);

  logger?.info?.('[electron:readLegalFolderFile] resolved path', {
    relativePath: cleanRelativePath,
    rootName: pathModule.basename(rootResolved),
    absolutePath,
  });

  if (!isInsideRoot(rootResolved, absolutePath, pathModule)) {
    return failure(
      'PATH_TRAVERSAL_BLOCKED',
      'Template path resolved outside the Legal Folder.'
    );
  }

  const extension = pathModule.extname(absolutePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    logger?.warn?.('[electron:readLegalFolderFile] unsupported extension', {
      relativePath: cleanRelativePath,
      extension,
    });
    return failure(
      'UNSUPPORTED_EXTENSION',
      `File type "${extension || 'unknown'}" is not supported.`
    );
  }

  let stat;
  try {
    stat = await statFile(fsModule, absolutePath);
  } catch (err) {
    logger?.warn?.('[electron:readLegalFolderFile] file missing', {
      relativePath: cleanRelativePath,
      code: err?.code || null,
      message: err?.message || String(err),
    });
    return failure('FILE_NOT_FOUND', 'The template file could not be found in the connected Legal Folder.');
  }

  if (!stat?.isFile?.()) {
    return failure('FILE_NOT_FOUND', 'The template file could not be found in the connected Legal Folder.');
  }

  const buffer = await readFileBuffer(fsModule, absolutePath);
  const fileName = pathModule.basename(absolutePath);
  const mimeType = MIME_TYPES.get(extension) || 'application/octet-stream';

  logger?.info?.('[electron:readLegalFolderFile] file read', {
    relativePath: cleanRelativePath,
    fileName,
    extension,
    bytes: buffer.byteLength,
  });

  return {
    ok: true,
    fileName,
    extension,
    relativePath: cleanRelativePath,
    mimeType,
    arrayBuffer: toArrayBuffer(buffer),
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MIME_TYPES,
  readLegalFolderFileFromRoot,
  safeReadLegalFolderFilePayload,
};
