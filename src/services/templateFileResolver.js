import { getLegalFolderFile } from './legalFolderFileStore';

const PATH_FIELDS = [
  'relativePath',
  'legalFolderRelativePath',
  'sourceRelativePath',
  'sourcePath',
  'legalFolderPath',
  'displayPath',
];

const TOP_LEVEL_LEGAL_FOLDERS = new Set([
  'templates',
  'legal templates',
  'contract templates',
  'standard templates',
  'precedents',
  'contracts',
]);

const DESKTOP_MESSAGES = {
  FILE_NOT_FOUND: 'The template file could not be found in the connected Legal Folder.',
  LEGAL_FOLDER_ROOT_NOT_SET: 'Choose your Legal Folder in ContractIQ Desktop before using templates.',
  MISSING_RELATIVE_PATH: 'The template record does not include a Legal Folder relative path.',
  PATH_TRAVERSAL_BLOCKED: 'The template path is not safe to read from the Legal Folder.',
  UNSUPPORTED_EXTENSION: 'This template file type is not supported for drafting.',
};

const BROWSER_CACHE_MESSAGE =
  'The template file is not available in browser cache. Sync the Legal Folder again.';

function isDev() {
  return Boolean(import.meta.env?.DEV);
}

function normalizeSeparators(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function normalizeSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isAbsoluteLike(value) {
  const path = String(value || '').trim();
  return (
    path.startsWith('/') ||
    path.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

function hasTraversal(value) {
  return normalizeSeparators(value).split('/').some((part) => part === '..');
}

function hasFileExtension(segment) {
  return /\.[A-Za-z0-9]{1,10}$/.test(String(segment || ''));
}

function safeFieldValue(value) {
  if (!value) return null;
  const normalized = normalizeSeparators(value);
  return isAbsoluteLike(normalized) ? '[absolute path hidden]' : normalized;
}

function availableTemplateFields(template = {}) {
  return {
    relativePath: safeFieldValue(template.relativePath),
    legalFolderRelativePath: safeFieldValue(template.legalFolderRelativePath),
    sourceRelativePath: safeFieldValue(template.sourceRelativePath),
    sourcePath: safeFieldValue(template.sourcePath),
    legalFolderPath: safeFieldValue(template.legalFolderPath),
    folderPath: safeFieldValue(template.folderPath),
    displayPath: safeFieldValue(template.displayPath),
    fileName: template.fileName || template.originalFileName || template.name || null,
    sourceId: template.sourceId || null,
    lifecycleStage: template.lifecycleStage || null,
  };
}

function candidatePaths(template = {}) {
  const values = PATH_FIELDS
    .map((field) => ({ field, value: template[field] }))
    .filter((item) => typeof item.value === 'string' && item.value.trim());

  const fileName = template.fileName || template.originalFileName || template.name;
  if (template.folderPath && fileName && !hasFileExtension(template.folderPath)) {
    values.push({
      field: 'folderPath+fileName',
      value: `${template.folderPath}/${fileName}`,
    });
  }

  return values;
}

function stripLegalFolderRootPrefix(pathValue, template = {}) {
  const parts = normalizeSeparators(pathValue).split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const sourceNames = [
    template.sourceName,
    template.rootName,
    template.legalFolderRootName,
    template.legalFolderName,
  ].map(normalizeSegment).filter(Boolean);

  if (sourceNames.includes(normalizeSegment(parts[0]))) {
    return parts.slice(1).join('/');
  }

  const topLevelIndex = parts.findIndex((part) => TOP_LEVEL_LEGAL_FOLDERS.has(normalizeSegment(part)));
  if (topLevelIndex > 0) return parts.slice(topLevelIndex).join('/');

  return parts.join('/');
}

export function getTemplateRelativePath(template = {}) {
  for (const candidate of candidatePaths(template)) {
    const normalized = normalizeSeparators(candidate.value);
    if (!normalized || isAbsoluteLike(normalized) || hasTraversal(normalized)) continue;
    const relativePath = stripLegalFolderRootPrefix(normalized, template);
    if (relativePath && !isAbsoluteLike(relativePath) && !hasTraversal(relativePath)) {
      return relativePath;
    }
  }
  return '';
}

function createResolverError(code, message, details = {}) {
  const err = new Error(message);
  err.name = 'TemplateFileResolverError';
  err.code = code;
  err.userMessage = message;
  Object.assign(err, details);
  return err;
}

function bytesFromBase64(base64) {
  const bufferCtor = globalThis.Buffer;
  const binary = typeof atob === 'function'
    ? atob(base64)
    : bufferCtor?.from?.(base64, 'base64')?.toString('binary') || '';
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesFromDesktopResult(result) {
  if (result?.arrayBuffer instanceof ArrayBuffer) {
    return new Uint8Array(result.arrayBuffer);
  }
  if (ArrayBuffer.isView(result?.arrayBuffer)) {
    return new Uint8Array(
      result.arrayBuffer.buffer,
      result.arrayBuffer.byteOffset,
      result.arrayBuffer.byteLength
    );
  }
  if (result?.arrayBuffer?.type === 'Buffer' && Array.isArray(result.arrayBuffer.data)) {
    return new Uint8Array(result.arrayBuffer.data);
  }
  if (Array.isArray(result?.arrayBuffer)) {
    return new Uint8Array(result.arrayBuffer);
  }
  if (typeof result?.base64 === 'string') {
    return bytesFromBase64(result.base64);
  }
  if (typeof result?.dataBase64 === 'string') {
    return bytesFromBase64(result.dataBase64);
  }
  return new Uint8Array();
}

function blobFromDesktopResult(result) {
  const bytes = bytesFromDesktopResult(result);
  return new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
}

export function getTemplateFileDebugInfo(template = {}) {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.contractiq);
  const hasElectronFileReader =
    typeof window !== 'undefined' && typeof window.contractiq?.readLegalFolderFile === 'function';
  const relativePath = getTemplateRelativePath(template);
  return {
    templateTitle: template.title || template.name || template.originalFileName || null,
    fileName: template.fileName || template.originalFileName || template.name || null,
    relativePath,
    lifecycleStage: template.lifecycleStage || null,
    isDesktop,
    hasElectronFileReader,
  };
}

export async function resolveTemplateFile(template = {}, options = {}) {
  const getCachedFile = options.getCachedFile || getLegalFolderFile;
  const debug = getTemplateFileDebugInfo(template);

  if (debug.isDesktop) {
    if (!debug.hasElectronFileReader) {
      const err = createResolverError(
        'DESKTOP_FILE_READER_UNAVAILABLE',
        'ContractIQ Desktop needs its Legal Folder file reader before using templates.',
        {
          attemptedRelativePath: debug.relativePath || null,
          availableTemplateFields: availableTemplateFields(template),
          resolverStrategy: 'none',
        }
      );
      if (isDev()) console.warn('[templateFileResolver] failed', err);
      throw err;
    }

    if (isDev()) {
      console.info('[templateFileResolver] resolving template file', {
        ...debug,
        resolverStrategy: 'electron',
      });
    }

    if (!debug.relativePath) {
      const err = createResolverError(
        'MISSING_RELATIVE_PATH',
        DESKTOP_MESSAGES.MISSING_RELATIVE_PATH,
        {
          attemptedRelativePath: null,
          availableTemplateFields: availableTemplateFields(template),
          resolverStrategy: 'electron',
        }
      );
      if (isDev()) console.warn('[templateFileResolver] failed', err);
      throw err;
    }

    const result = await window.contractiq.readLegalFolderFile({ relativePath: debug.relativePath });
    if (result?.ok) {
      const blob = blobFromDesktopResult(result);
      return {
        ok: true,
        strategy: 'electron',
        blob,
        record: {
          blob,
          type: result.extension?.replace(/^\./, '') || template.extension || '',
          mimeType: result.mimeType || blob.type,
          sourcePath: result.relativePath || debug.relativePath,
          name: result.fileName || debug.fileName,
        },
        relativePath: result.relativePath || debug.relativePath,
        fileName: result.fileName || debug.fileName,
        mimeType: result.mimeType || blob.type,
      };
    }

    const code = result?.code || 'DESKTOP_FILE_READ_FAILED';
    const message = DESKTOP_MESSAGES[code] || result?.message || 'Could not read the template from the Legal Folder.';
    const err = createResolverError(code, message, {
      attemptedRelativePath: debug.relativePath,
      availableTemplateFields: availableTemplateFields(template),
      resolverStrategy: 'electron',
      desktopResult: result || null,
    });
    if (isDev()) {
      console.warn('[templateFileResolver] failed', {
        code: err.code,
        message: err.message,
        attemptedRelativePath: err.attemptedRelativePath,
        availableTemplateFields: err.availableTemplateFields,
      });
    }
    throw err;
  }

  if (isDev()) {
    console.info('[templateFileResolver] resolving template file', {
      ...debug,
      resolverStrategy: 'indexeddb',
    });
  }

  const cacheKey = template._id || template.storageKey || template.id;
  let record = null;
  if (cacheKey) {
    record = await getCachedFile(cacheKey);
  }

  if (record?.blob) {
    return {
      ok: true,
      strategy: 'indexeddb',
      blob: record.blob,
      record,
      relativePath: record.sourcePath || debug.relativePath || null,
      fileName: record.name || debug.fileName,
      mimeType: record.mimeType || record.blob.type || '',
    };
  }

  const err = createResolverError('TEMPLATE_FILE_NOT_CACHED', BROWSER_CACHE_MESSAGE, {
    attemptedRelativePath: debug.relativePath || null,
    availableTemplateFields: availableTemplateFields(template),
    resolverStrategy: 'indexeddb',
  });
  if (isDev()) {
    console.warn('[templateFileResolver] failed', {
      code: err.code,
      message: err.message,
      attemptedRelativePath: err.attemptedRelativePath,
      availableTemplateFields: err.availableTemplateFields,
    });
  }
  throw err;
}

export const TEMPLATE_FILE_MESSAGES = {
  ...DESKTOP_MESSAGES,
  TEMPLATE_FILE_NOT_CACHED: BROWSER_CACHE_MESSAGE,
};
