'use strict';

const path = require('path');

const LIFECYCLE_STAGE = Object.freeze({
  TEMPLATE: 'TEMPLATE',
  DRAFT: 'DRAFT',
  FINAL: 'FINAL',
  SIGNED: 'SIGNED',
  UNKNOWN: 'UNKNOWN',
});

const TEMPLATE_FOLDERS = new Set([
  'templates',
  'legal templates',
  'contract templates',
  'standard templates',
  'precedents',
]);

const STAGE_FOLDERS = new Map([
  ['drafts', LIFECYCLE_STAGE.DRAFT],
  ['draft', LIFECYCLE_STAGE.DRAFT],
  ['working drafts', LIFECYCLE_STAGE.DRAFT],
  ['final', LIFECYCLE_STAGE.FINAL],
  ['finals', LIFECYCLE_STAGE.FINAL],
  ['approved', LIFECYCLE_STAGE.FINAL],
  ['approved final', LIFECYCLE_STAGE.FINAL],
  ['ready for signature', LIFECYCLE_STAGE.FINAL],
  ['ready for signing', LIFECYCLE_STAGE.FINAL],
  ['for signature', LIFECYCLE_STAGE.FINAL],
  ['for signing', LIFECYCLE_STAGE.FINAL],
  ['to sign', LIFECYCLE_STAGE.FINAL],
  ['awaiting signature', LIFECYCLE_STAGE.FINAL],
  ['pending signature', LIFECYCLE_STAGE.FINAL],
  ['needs signature', LIFECYCLE_STAGE.FINAL],
  ['sign', LIFECYCLE_STAGE.SIGNED],
  ['signed', LIFECYCLE_STAGE.SIGNED],
  ['signed documents', LIFECYCLE_STAGE.SIGNED],
  ['signed docs', LIFECYCLE_STAGE.SIGNED],
  ['signed contracts', LIFECYCLE_STAGE.SIGNED],
  ['signed agreements', LIFECYCLE_STAGE.SIGNED],
  ['documents signed', LIFECYCLE_STAGE.SIGNED],
  ['docs signed', LIFECYCLE_STAGE.SIGNED],
  ['contracts signed', LIFECYCLE_STAGE.SIGNED],
  ['agreements signed', LIFECYCLE_STAGE.SIGNED],
  ['executed', LIFECYCLE_STAGE.SIGNED],
  ['executed documents', LIFECYCLE_STAGE.SIGNED],
  ['executed contracts', LIFECYCLE_STAGE.SIGNED],
  ['executed agreements', LIFECYCLE_STAGE.SIGNED],
  ['fully signed', LIFECYCLE_STAGE.SIGNED],
  ['fully signed documents', LIFECYCLE_STAGE.SIGNED],
  ['fully signed contracts', LIFECYCLE_STAGE.SIGNED],
  ['fully signed agreements', LIFECYCLE_STAGE.SIGNED],
  ['completed', LIFECYCLE_STAGE.SIGNED],
  ['completed documents', LIFECYCLE_STAGE.SIGNED],
  ['completed contracts', LIFECYCLE_STAGE.SIGNED],
  ['completed agreements', LIFECYCLE_STAGE.SIGNED],
  ['signed final', LIFECYCLE_STAGE.SIGNED],
  ['final signed', LIFECYCLE_STAGE.SIGNED],
  ['e signed', LIFECYCLE_STAGE.SIGNED],
  ['e signed documents', LIFECYCLE_STAGE.SIGNED],
  ['electronically signed', LIFECYCLE_STAGE.SIGNED],
  ['electronically signed documents', LIFECYCLE_STAGE.SIGNED],
  ['wet signed', LIFECYCLE_STAGE.SIGNED],
  ['wet signed documents', LIFECYCLE_STAGE.SIGNED],
  ['doc signed', LIFECYCLE_STAGE.SIGNED],
  ['document signed', LIFECYCLE_STAGE.SIGNED],
  ['contract signed', LIFECYCLE_STAGE.SIGNED],
  ['agreement signed', LIFECYCLE_STAGE.SIGNED],
]);

const SIGNED_PRIMARY_TOKENS = new Set(['signed', 'executed']);
const SIGNED_COMPANION_TOKENS = new Set([
  'document', 'documents',
  'doc', 'docs',
  'contract', 'contracts',
  'agreement', 'agreements',
  'final',
  'fully',
]);

const SUPPORTED_TEMPLATE_EXTENSIONS = new Set(['.docx', '.dotx', '.doc', '.pdf', '.txt', '.md']);
const SUPPORTED_CONTRACT_EXTENSIONS = new Set(['.docx', '.dotx', '.doc', '.pdf', '.odt', '.txt', '.md']);
const TEMP_FILE_PATTERN = /(^~\$|\.tmp$|\.lock$|\.crdownload$|\.part$|\.swp$|~$)/i;
const RECOVERY_FILE_PATTERN = /^(autorecovery save of|~wrd|wrf|\.~lock)/i;
const IGNORED_FOLDERS = new Set(['node_modules', 'app', 'server']);

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function pathParts(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return normalized ? normalized.split('/') : [];
}

function normalizePathSegment(part) {
  return String(part || '')
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lowerPart(part) {
  return normalizePathSegment(part);
}

function matchesSignedTokenRule(normalizedSegment) {
  const words = normalizedSegment.split(/\s+/).filter(Boolean);
  return (
    words.some((word) => SIGNED_PRIMARY_TOKENS.has(word)) &&
    words.some((word) => SIGNED_COMPANION_TOKENS.has(word))
  );
}

function stageForSegment(originalSegment) {
  const normalized = normalizePathSegment(originalSegment);
  const stage = STAGE_FOLDERS.get(normalized);
  if (stage) {
    return {
      lifecycleStage: stage,
      reason: `PATH_SEGMENT_${stage}_ALIAS`,
      matchedSegment: originalSegment,
      confidence: 'high',
    };
  }
  if (matchesSignedTokenRule(normalized)) {
    return {
      lifecycleStage: LIFECYCLE_STAGE.SIGNED,
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      matchedSegment: originalSegment,
      confidence: 'medium',
    };
  }
  return null;
}

function shouldIgnoreLegalFolderPath(relativePath) {
  const parts = pathParts(relativePath);
  if (!parts.length) return true;
  const fileName = parts[parts.length - 1] || '';
  if (!fileName) return true;
  if (TEMP_FILE_PATTERN.test(fileName) || RECOVERY_FILE_PATTERN.test(fileName)) return true;
  return parts.some((part) => {
    const lower = lowerPart(part);
    return lower.startsWith('.') || IGNORED_FOLDERS.has(lower);
  });
}

function extensionOf(relativePath) {
  return path.posix.extname(normalizeRelativePath(relativePath)).toLowerCase();
}

function isSupportedLifecycleFile(relativePath) {
  if (shouldIgnoreLegalFolderPath(relativePath)) return false;
  const parts = pathParts(relativePath);
  const folderParts = parts.slice(0, -1).map(lowerPart);
  const ext = extensionOf(relativePath);
  if (folderParts.some((part) => TEMPLATE_FOLDERS.has(part))) {
    return SUPPORTED_TEMPLATE_EXTENSIONS.has(ext);
  }
  if (folderParts.some((part) => part === 'contracts')) {
    return SUPPORTED_CONTRACT_EXTENSIONS.has(ext);
  }
  return SUPPORTED_TEMPLATE_EXTENSIONS.has(ext) || SUPPORTED_CONTRACT_EXTENSIONS.has(ext);
}

function inferAgreementFamily(relativePath, category = '') {
  const text = `${category} ${path.posix.basename(normalizeRelativePath(relativePath), extensionOf(relativePath))}`
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  if (text.includes('addendum')) return 'ADDENDUM';
  if (text.includes('assistance')) return 'ASSISTANCE_AGREEMENT';
  if (text.includes('consultancy') || text.includes('consultant')) return 'CONSULTANCY_AGREEMENT';
  if (text.includes('funding loan') || /\bloan\b/.test(text)) return 'FUNDING_LOAN_AGREEMENT';
  if (text.includes('master service') || /\bmsa\b/.test(text)) return 'MASTER_SERVICE_AGREEMENT';
  if (text.includes('service provider') || text.includes('service agreement')) return 'ONCE_OFF_SERVICE_AGREEMENT';
  if (text.includes('non disclosure') || text.includes('non-disclosure') || /\bnda\b/.test(text)) return 'NDA';
  if (text.includes('statement of work') || /\bsow\b/.test(text)) return 'SOW';
  if (text.includes('vendor') || text.includes('supplier')) return 'VENDOR_AGREEMENT';
  if (text.includes('license') || text.includes('licence')) return 'LICENSE_AGREEMENT';
  if (text.includes('employment')) return 'EMPLOYMENT_AGREEMENT';
  if (text.includes('data processing') || /\bdpa\b/.test(text)) return 'DPA';
  if (text.includes('partnership')) return 'PARTNERSHIP_AGREEMENT';
  if (text.includes('agreement') || text.includes('contract')) return 'GENERAL_CONTRACT';
  return 'OTHER';
}

function classifyLegalFolderPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = pathParts(normalized);
  const folderParts = parts.slice(0, -1);
  const lowerFolders = folderParts.map(lowerPart);
  const base = {
    lifecycleStage: LIFECYCLE_STAGE.UNKNOWN,
    reason: 'NO_STAGE_FOLDER_MATCH',
    matchedSegment: null,
    confidence: 'none',
    year: null,
    category: null,
    counterparty: null,
    stageFolder: null,
    agreementFamily: inferAgreementFamily(normalized),
    isTemplate: false,
    isContractDocument: false,
  };

  if (!parts.length || shouldIgnoreLegalFolderPath(normalized)) return base;

  let stageMatch = null;
  let stageIndex = -1;
  for (let index = 0; index < folderParts.length; index += 1) {
    const match = TEMPLATE_FOLDERS.has(lowerFolders[index])
      ? {
        lifecycleStage: LIFECYCLE_STAGE.TEMPLATE,
        reason: 'PATH_SEGMENT_TEMPLATE_ALIAS',
        matchedSegment: folderParts[index],
        confidence: 'high',
      }
      : stageForSegment(folderParts[index]);
    if (match) {
      stageMatch = match;
      stageIndex = index;
    }
  }

  const contractsIndex = lowerFolders.findIndex((part) => part === 'contracts');
  if (!stageMatch) {
    return {
      ...base,
      isContractDocument: contractsIndex !== -1,
    };
  }

  if (stageMatch.lifecycleStage === LIFECYCLE_STAGE.TEMPLATE) {
    return {
      ...base,
      ...stageMatch,
      stageFolder: folderParts[stageIndex],
      agreementFamily: inferAgreementFamily(normalized),
      isTemplate: true,
      isContractDocument: contractsIndex !== -1,
    };
  }

  if (contractsIndex === -1) return { ...base, ...stageMatch, stageFolder: folderParts[stageIndex] };

  const contractParts = folderParts.slice(contractsIndex + 1, stageIndex);
  const yearIndex = contractParts.findIndex((part) => /^20\d{2}$/.test(part));
  const year = yearIndex >= 0 ? contractParts[yearIndex] : null;
  const category = yearIndex >= 0 ? contractParts[yearIndex + 1] || null : contractParts[0] || null;
  const counterparty = yearIndex >= 0
    ? contractParts.slice(yearIndex + 2).join('/') || null
    : contractParts.slice(1).join('/') || null;
  const stageFolder = folderParts[stageIndex];
  const lifecycleStage = stageMatch.lifecycleStage;

  return {
    ...base,
    ...stageMatch,
    lifecycleStage,
    year,
    category,
    counterparty,
    stageFolder,
    agreementFamily: inferAgreementFamily(normalized, category || ''),
    isContractDocument: true,
  };
}

module.exports = {
  LIFECYCLE_STAGE,
  TEMPLATE_FOLDERS,
  STAGE_FOLDERS,
  SUPPORTED_TEMPLATE_EXTENSIONS,
  SUPPORTED_CONTRACT_EXTENSIONS,
  normalizeRelativePath,
  classifyLegalFolderPath,
  shouldIgnoreLegalFolderPath,
  isSupportedLifecycleFile,
  inferAgreementFamily,
};
