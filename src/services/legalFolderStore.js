import { contracts as mockContracts } from '../data/mockData.js';

export const LEGAL_FOLDER_UPDATED = 'legal-folder-updated';

const CONTRACTS_KEY = 'clm_legal_folder_contracts';
const DOCUMENTS_KEY = 'clm_legal_folder_documents';
const SOURCE_KEY = 'clm_legal_folder_source';
const IMPORTER_VERSION = 5;

const CONTRACT_TYPES = [
  { value: 'Addendum', label: 'Addendum', terms: ['addendum', 'variation of the main agreement', 'main agreement is hereby varied'] },
  { value: 'Assistance', label: 'Assistance Agreement', terms: ['assistance agreement', 'assistance', 'beneficiary', 'b-bbee', 'eeip'] },
  { value: 'Consultancy', label: 'Consultancy Agreement', terms: ['consultancy agreement', 'consultant', 'financial services agreement'] },
  { value: 'Loan', label: 'Funding Loan Agreement', terms: ['funding loan', 'loan agreement', 'funding agreement', 'loan'] },
  { value: 'MSA', label: 'Master Service Agreement', terms: ['msa', 'master service agreement', 'services agreement'] },
  { value: 'Service', label: 'Service Agreement', terms: ['once-off service agreement', 'once off service agreement', 'service agreement'] },
  { value: 'NDA', label: 'Non-Disclosure Agreement', terms: ['nda', 'non disclosure', 'non-disclosure', 'confidentiality'] },
  { value: 'SOW', label: 'Statement of Work', terms: ['sow', 'statement of work', 'scope of work'] },
  { value: 'Vendor', label: 'Vendor Agreement', terms: ['vendor', 'supplier', 'procurement'] },
  { value: 'License', label: 'Software License Agreement', terms: ['license', 'licence', 'software license', 'saas'] },
  { value: 'Employment', label: 'Employment Agreement', terms: ['employment', 'employee', 'executive agreement'] },
  { value: 'DPA', label: 'Data Processing Agreement', terms: ['dpa', 'data processing', 'gdpr', 'popia'] },
  { value: 'Partnership', label: 'Partnership Agreement', terms: ['partnership', 'partner', 'strategic'] },
  { value: 'Agreement', label: 'General Agreement', terms: ['agreement'] },
  { value: 'Imported', label: 'Imported Contract', terms: [] },
];

const DEPARTMENTS = [
  'Legal',
  'IT',
  'Finance',
  'Engineering',
  'HR',
  'Human Resources',
  'Operations',
  'Procurement',
  'Business Development',
  'Compliance',
];

const GENERIC_FOLDERS = new Set([
  'approved',
  'archive',
  'archives',
  'contracts',
  'documents',
  'drafts',
  'executed',
  'final',
  'legal',
  'legal folder',
  'shared',
  'signed',
  'templates',
  'training',
  'training templates',
]);

const LIFECYCLE_STAGE = Object.freeze({
  TEMPLATE: 'TEMPLATE',
  DRAFT: 'DRAFT',
  FINAL: 'FINAL',
  SIGNED: 'SIGNED',
  UNKNOWN: 'UNKNOWN',
});

const TEMPLATE_STAGE_FOLDERS = new Set([
  'templates',
  'legal templates',
  'contract templates',
  'standard templates',
  'precedents',
]);

const LIFECYCLE_STAGE_FOLDERS = new Map([
  ['drafts', LIFECYCLE_STAGE.DRAFT],
  ['draft', LIFECYCLE_STAGE.DRAFT],
  ['working drafts', LIFECYCLE_STAGE.DRAFT],
  ['final', LIFECYCLE_STAGE.FINAL],
  ['finals', LIFECYCLE_STAGE.FINAL],
  ['approved', LIFECYCLE_STAGE.FINAL],
  ['approved final', LIFECYCLE_STAGE.FINAL],
  ['signed', LIFECYCLE_STAGE.SIGNED],
  ['executed', LIFECYCLE_STAGE.SIGNED],
  ['fully signed', LIFECYCLE_STAGE.SIGNED],
  ['completed', LIFECYCLE_STAGE.SIGNED],
]);

const TEXT_EXTRACT_EXTENSIONS = new Set(['docx', 'txt', 'md', 'rtf', 'csv', 'json']);
const SKIPPED_FILE_PATTERN = /(^\.|^~\$|\.tmp$|\.lock$|\.crdownload$|\.part$)/i;
const GENERIC_FILE_NAME = /\b(annexure|appendix|attachment|comments|exhibit|redline|redlines|schedule|scope|signed copy|version|v\d+(?:\.\d+)*)\b/i;

// Detects the corporate nesting pattern: RootFolder/Year/Company/StatusFolder/file
// Returns { year, company } when the pattern is found, otherwise null
const detectNestedStructure = (pathParts, lifecycleInfo = null) => {
  if (lifecycleInfo?.year || lifecycleInfo?.counterparty) {
    return {
      year: lifecycleInfo.year || null,
      company: lifecycleInfo.counterparty || null,
      category: lifecycleInfo.category || null,
    };
  }
  const yearIdx = pathParts.findIndex((part) => /^20\d{2}$/.test(part));
  if (yearIdx === -1 || yearIdx + 1 >= pathParts.length - 1) return null;
  const companyPart = pathParts[yearIdx + 1];
  if (GENERIC_FOLDERS.has(companyPart.toLowerCase()) || /^20\d{2}$/.test(companyPart)) return null;
  return { year: pathParts[yearIdx], company: companyPart };
};

// Infers status from the folder name a file sits in (final/signed/executed → Active)
const inferStatusFromPath = (pathParts) => {
  const folders = pathParts.slice(0, -1).map((p) => p.toLowerCase());
  if (folders.some((f) => f === 'signed' || f === 'executed')) return 'Active';
  if (folders.some((f) => f === 'final' || f === 'approved')) return 'Active';
  return null;
};

const toStorage = (key, value) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(value));
};

const fromStorage = (key, fallback) => {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const removeStorage = (key) => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(key);
};

const emitUpdate = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LEGAL_FOLDER_UPDATED));
};

const normalisePath = (path) =>
  String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

const extensionOf = (name) => {
  const match = String(name || '').match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : 'file';
};

const baseNameOf = (name) => String(name || '').replace(/\.[^.]+$/, '');

const inferAgreementFamilyFromPath = (sourcePath = '', category = '') => {
  const text = `${category} ${baseNameOf(sourcePath)}`.replace(/[_-]+/g, ' ').toLowerCase();
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
};

export const classifyLegalFolderEntryPath = (sourcePath) => {
  const pathParts = normalisePath(sourcePath);
  const folderParts = pathParts.slice(0, -1);
  const lowerFolders = folderParts.map((part) => part.toLowerCase());
  const base = {
    lifecycleStage: LIFECYCLE_STAGE.UNKNOWN,
    year: null,
    category: null,
    counterparty: null,
    stageFolder: null,
    agreementFamily: inferAgreementFamilyFromPath(sourcePath),
    isTemplate: false,
    isContractDocument: false,
  };

  const templateIdx = lowerFolders.findIndex((part) => TEMPLATE_STAGE_FOLDERS.has(part));
  if (templateIdx >= 0) {
    return {
      ...base,
      lifecycleStage: LIFECYCLE_STAGE.TEMPLATE,
      stageFolder: folderParts[templateIdx],
      isTemplate: true,
    };
  }

  const contractsIdx = lowerFolders.findIndex((part) => part === 'contracts');
  if (contractsIdx === -1) return base;

  const stageIdx = lowerFolders.findIndex((part, index) =>
    index > contractsIdx && LIFECYCLE_STAGE_FOLDERS.has(part)
  );
  if (stageIdx === -1) return { ...base, isContractDocument: true };

  const contractParts = folderParts.slice(contractsIdx + 1, stageIdx);
  const yearIdx = contractParts.findIndex((part) => /^20\d{2}$/.test(part));
  const year = yearIdx >= 0 ? contractParts[yearIdx] : null;
  const category = yearIdx >= 0 ? contractParts[yearIdx + 1] || null : contractParts[0] || null;
  const counterparty = yearIdx >= 0
    ? contractParts.slice(yearIdx + 2).join('/') || null
    : contractParts.slice(1).join('/') || null;
  const stageFolder = folderParts[stageIdx];
  const lifecycleStage = LIFECYCLE_STAGE_FOLDERS.get(stageFolder.toLowerCase()) || LIFECYCLE_STAGE.UNKNOWN;

  return {
    ...base,
    lifecycleStage,
    year,
    category,
    counterparty,
    stageFolder,
    agreementFamily: inferAgreementFamilyFromPath(sourcePath, category || ''),
    isContractDocument: true,
  };
};

const statusFromLifecycleStage = (stage, fallback = 'Active') => {
  if (stage === LIFECYCLE_STAGE.TEMPLATE) return 'Template';
  if (stage === LIFECYCLE_STAGE.DRAFT) return 'Draft';
  if (stage === LIFECYCLE_STAGE.FINAL) return 'Ready for Signature';
  if (stage === LIFECYCLE_STAGE.SIGNED) return 'Signed';
  return fallback;
};

const decodeXmlEntities = (value) =>
  String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

const pretty = (value) =>
  decodeXmlEntities(value)
    .replace(/[_+.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const titleCase = (value) =>
  pretty(value)
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');

const stableHash = (value) => {
  let hash = 0;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
};

const unique = (items) => [...new Set(items.filter(Boolean))];

const isoDate = (value) => {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
};

const readUint16 = (view, offset) => view.getUint16(offset, true);
const readUint32 = (view, offset) => view.getUint32(offset, true);

const inflateRaw = async (data) => {
  if (typeof DecompressionStream === 'undefined') return null;

  for (const format of ['deflate-raw', 'deflate']) {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
      return await new Response(stream).arrayBuffer();
    } catch {
      // Some browsers support only one of the deflate names.
    }
  }

  return null;
};

const fileFromZip = async (arrayBuffer, fileName) => {
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder();
  const minEocd = 22;
  const maxComment = 65535;
  const start = Math.max(0, view.byteLength - minEocd - maxComment);
  let eocdOffset = -1;

  for (let offset = view.byteLength - minEocd; offset >= start; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) return '';

  const totalEntries = readUint16(view, eocdOffset + 10);
  let cursor = readUint32(view, eocdOffset + 16);

  for (let i = 0; i < totalEntries; i += 1) {
    if (readUint32(view, cursor) !== 0x02014b50) break;

    const compression = readUint16(view, cursor + 10);
    const compressedSize = readUint32(view, cursor + 20);
    const fileNameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localHeaderOffset = readUint32(view, cursor + 42);
    const nameBytes = new Uint8Array(arrayBuffer, cursor + 46, fileNameLength);
    const name = decoder.decode(nameBytes);

    if (name === fileName && readUint32(view, localHeaderOffset) === 0x04034b50) {
      const localNameLength = readUint16(view, localHeaderOffset + 26);
      const localExtraLength = readUint16(view, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = arrayBuffer.slice(dataStart, dataStart + compressedSize);
      const content = compression === 0 ? compressed : await inflateRaw(compressed);
      return content ? decoder.decode(content) : '';
    }

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return '';
};

const docxXmlToText = (xml) =>
  decodeXmlEntities(xml)
    .replace(/<w:tab\b[^>]*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripRtf = (text) =>
  text
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/\\[a-z]+-?\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractTextFromEntry = async (entry) => {
  const ext = extensionOf(entry.name);
  if (!entry.file) return '';

  try {
    if (ext === 'docx') {
      const xml = await fileFromZip(await entry.file.arrayBuffer(), 'word/document.xml');
      return docxXmlToText(xml).slice(0, 30000);
    }

    if (TEXT_EXTRACT_EXTENSIONS.has(ext) && ext !== 'docx' && ext !== 'rtf') {
      return (await entry.file.text()).slice(0, 30000);
    }

    if (ext === 'rtf') {
      return stripRtf(await entry.file.text()).slice(0, 30000);
    }
  } catch {
    return '';
  }

  return '';
};

export const enrichLegalFolderEntries = async (entries) =>
  Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      textContent: await extractTextFromEntry(entry),
    }))
  );

const renewalFromEndDate = (endDate) => {
  if (!endDate) return null;
  const date = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
};

const inferType = (text, { includeGeneric = true } = {}) => {
  const lower = text.toLowerCase();
  const types = includeGeneric
    ? CONTRACT_TYPES
    : CONTRACT_TYPES.filter((type) => type.value !== 'Agreement');
  return types.find((type) => type.terms.some((term) => lower.includes(term))) || null;
};

const isTemplateLike = (text) =>
  /\btemplate\b|\bdrafting note\b|\[insert\b|\[company name\]|\{ ?insert\b|\[●\]/i.test(text);

const inferStatus = (text) => {
  const lower = text.toLowerCase();
  if (isTemplateLike(text)) return 'Draft';
  if (/\b(expired|terminated|cancelled|canceled)\b/.test(lower)) return 'Expired';
  if (/\b(pending signature|awaiting signature|for signature)\b/.test(lower)) return 'Pending Signature';
  if (/\b(draft|working copy)\b/.test(lower)) return 'Draft';
  if (/\b(review|redline|redlines|negotiation|comments)\b/.test(lower)) return 'Under Review';
  return 'Active';
};

const stageFromStatus = (status) => {
  if (status === 'Draft') return 'Authoring';
  if (status === 'Under Review') return 'Review';
  if (status === 'Pending Signature') return 'Signature';
  if (status === 'Expired') return 'Execution';
  return 'Execution';
};

const inferDepartment = (pathText, pathParts) => {
  const lower = pathText.toLowerCase();
  const match = DEPARTMENTS.find((department) => lower.includes(department.toLowerCase()));
  if (match) return match === 'HR' ? 'Human Resources' : match;

  const folderCandidate = pathParts
    .slice(1, -1)
    .find((part) => !GENERIC_FOLDERS.has(part.toLowerCase()));

  return folderCandidate ? titleCase(folderCandidate) : 'Legal';
};

const isDepartmentFolder = (part) =>
  DEPARTMENTS.some((department) => department.toLowerCase() === part.toLowerCase());

const isGenericFolder = (part) =>
  GENERIC_FOLDERS.has(part.toLowerCase()) || isDepartmentFolder(part);

const contractNameSource = (fileBase, pathParts) => {
  const parentContractFolder = pathParts
    .slice(1, -1)
    .reverse()
    .find((part) => !isGenericFolder(part));

  if (GENERIC_FILE_NAME.test(fileBase) && parentContractFolder) {
    return parentContractFolder;
  }

  return fileBase;
};

const inferDates = (text) => {
  const found = [];
  const addDate = (year, month, day) => {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day)
    ) {
      found.push(date.toISOString().slice(0, 10));
    }
  };

  for (const match of text.matchAll(/(20\d{2})[-_. ](0?[1-9]|1[0-2])[-_. ](0?[1-9]|[12]\d|3[01])/g)) {
    addDate(match[1], match[2], match[3]);
  }

  for (const match of text.matchAll(/(0?[1-9]|[12]\d|3[01])[-_. ](0?[1-9]|1[0-2])[-_. ](20\d{2})/g)) {
    addDate(match[3], match[2], match[1]);
  }

  return unique(found).sort();
};

const inferValue = (text) => {
  const match = text.match(/\b(?:zar|r)\s*([\d\s,]+(?:\.\d+)?)\s*(million)?/i);
  if (!match) return 0;
  const value = Number(match[1].replace(/[\s,]/g, ''));
  if (!Number.isFinite(value)) return 0;
  return /million/i.test(match[2] || '') ? Math.round(value * 1000000) : value;
};

const CONTRACT_STATUS_LABELS = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  EXPIRING_SOON: 'Expiring Soon',
  TERMINATED: 'Terminated',
  UNKNOWN: 'Unknown',
};

const contractStatusLabel = (status) =>
  CONTRACT_STATUS_LABELS[String(status || '').toUpperCase()] || null;

const optionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const deriveContractStatusLabel = ({ lifecycleStage, contractStatus, contractStatusLabel: label, expiryDate, endDate, terminationDate } = {}) => {
  if (label && label !== 'Signed') return label;
  const fromCode = contractStatusLabel(contractStatus);
  if (fromCode) return fromCode;
  if (terminationDate) return 'Terminated';
  const resolvedEndDate = expiryDate || endDate;
  if (!resolvedEndDate) return lifecycleStage === LIFECYCLE_STAGE.SIGNED ? 'Unknown' : null;
  const today = new Date();
  const todayMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const end = new Date(`${String(resolvedEndDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return lifecycleStage === LIFECYCLE_STAGE.SIGNED ? 'Unknown' : null;
  const days = Math.ceil((end.getTime() - todayMidnight.getTime()) / 86400000);
  if (days < 0) return 'Expired';
  if (days <= 30) return 'Expiring Soon';
  return 'Active';
};

const typeWordsPattern = /(first addendum|addendum|assistance agreement|consultancy agreement|financial services agreement|funding loan agreement|loan agreement|master services? agreement|services agreement|service agreement|non disclosure agreement|non-disclosure agreement|statement of work|scope of work|software license agreement|data processing agreement|partnership agreement|employment agreement|vendor agreement|\bmsa\b|\bnda\b|\bsow\b|\bdpa\b|\bdocx?\b|\bpdf\b)/gi;
const statusWordsPattern = /\b(active|approved|draft|executed|execution|final|pending|redline|redlines|review|signed|v\d+(?:\.\d+)*)\b/gi;

const matchesTypeWords = (value) => {
  typeWordsPattern.lastIndex = 0;
  return typeWordsPattern.test(value);
};

const inferCounterparty = (fileBase, type) => {
  const parts = pretty(fileBase)
    .split(/[-\u2013\u2014|]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const bestPart =
    [...parts].reverse().find((part) => !matchesTypeWords(part) && part.length > 2) ||
    parts[parts.length - 1] ||
    fileBase;

  typeWordsPattern.lastIndex = 0;
  statusWordsPattern.lastIndex = 0;

  const cleaned = pretty(bestPart)
    .replace(typeWordsPattern, '')
    .replace(statusWordsPattern, '')
    .replace(/\b(revised|template)\b/gi, '')
    .replace(/\(v\d+(?:\.\d+)?\)/gi, '')
    .replace(/\[[\d\s]+\]/g, '')
    .replace(/\bclm[-_\s]*\d{4}[-_\s]*\d+\b/gi, '')
    .replace(/\b20\d{2}[-_. ]\d{1,2}[-_. ]\d{1,2}\b/g, '')
    .replace(/\b\d{1,2}[-_. ]\d{1,2}[-_. ]20\d{2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = isTemplateLike(fileBase) ? 'Template' : fileBase;
  const validCleaned =
    cleaned.length >= 3 && !/^(the )?proprietary limited$/i.test(cleaned)
      ? cleaned
      : '';

  return titleCase(validCleaned || fallback || type.label);
};

const contractHeading = (text) => {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => pretty(line))
    .filter(Boolean);

  return (
    lines.find((line) => /\b(addendum|agreement|contract|loan|sow|statement of work)\b/i.test(line)) ||
    ''
  );
};

const cleanPartyName = (value) => {
  const name = pretty(value)
    .replace(/\(.*?(registration|identity|reg\.?|number).*?\)/gi, '')
    .replace(/[(){}[\]]/g, '')
    .replace(/[“”"].*$/g, '')
    .replace(/\b(insert|company name|reg\.? no\.?|xxxxxxxx|xxxxx|beneficiary reg no|beneficiary’s name|beneficiary's name|sp name)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!name || name.length < 3) return '';
  if (/^(name|company|the proprietary limited|proprietary limited|limited|pty ltd|name proprietary limited)$/i.test(name)) return '';
  if (/\b(name|company)\s+proprietary limited\b/i.test(name)) return '';
  return titleCase(name);
};

const inferCounterpartyFromText = (text) => {
  const compact = pretty(text).slice(0, 1800);
  const betweenMatch = compact.match(/\bbetween\s+(.{3,500}?)\s+\band\s+(.{3,500}?)(?:\s+\bDefinitions\b|\s+\bInterpretation\b|\s+\bPARTIES\b|\s+\(“|\s+\("|\s+$)/i);
  if (betweenMatch) {
    return cleanPartyName(betweenMatch[2]) || cleanPartyName(betweenMatch[1]);
  }

  const beneficiaryMatch = compact.match(/Beneficiary\s*(?:”|")?\s*means\s+(.{3,220}?)(?:\s+\(|\s+a\s+private|\s+duly|\s+;|\s+\.)/i);
  if (beneficiaryMatch) return cleanPartyName(beneficiaryMatch[1]);

  return '';
};

const inferClauses = (text, typeValue) => {
  const lower = text.toLowerCase();
  const clauses = [];
  if (lower.includes('liability')) clauses.push('Liability Cap');
  if (lower.includes('ip') || lower.includes('intellectual')) clauses.push('IP Ownership');
  if (lower.includes('privacy') || lower.includes('data') || lower.includes('gdpr') || lower.includes('popia')) clauses.push('Data Privacy');
  if (lower.includes('sla') || lower.includes('service level')) clauses.push('SLA Guarantee');
  if (lower.includes('termination')) clauses.push('Termination');
  if (lower.includes('audit')) clauses.push('Audit Rights');
  if (typeValue === 'NDA') clauses.push('Confidentiality Period', 'Return of Information');
  if (typeValue === 'SOW') clauses.push('Deliverables', 'Payment Schedule');
  if (typeValue === 'DPA') clauses.push('Processing Purposes', 'Security Measures');
  return unique(clauses.length ? clauses : ['Governing Terms', 'Termination']);
};

const makeDocument = (entry, contract, status, nestedInfo = null, lifecycleInfo = null, sourceId = null) => {
  const ext = extensionOf(entry.name);
  const updatedAt = new Date(entry.lastModified || Date.now()).toISOString();
  const sourcePath = entry.relativePath || entry.name;
  const companyName = nestedInfo?.company ? titleCase(nestedInfo.company) : null;
  const lifecycleStage = lifecycleInfo?.lifecycleStage || LIFECYCLE_STAGE.UNKNOWN;

  return {
    _id: lifecycleInfo?.id || `DOC-${stableHash(`${sourcePath}-${entry.size}-${entry.lastModified}`)}`,
    name: entry.name,
    type: ext,
    size: entry.size || 0,
    status,
    updatedAt,
    uploadedBy: { name: companyName || 'Shared Folder' },
    contract: contract ? { id: contract.id, title: contract.title } : null,
    source: 'shared-folder',
    sourcePath,
    relativePath: sourcePath,
    legalFolderRelativePath: sourcePath,
    displayPath: sourcePath,
    company: companyName,
    counterparty: lifecycleInfo?.counterparty || companyName,
    year: lifecycleInfo?.year || nestedInfo?.year || null,
    category: lifecycleInfo?.category || nestedInfo?.category || null,
    lifecycleStage,
    documentStage: lifecycleStage,
    stageFolder: lifecycleInfo?.stageFolder || null,
    lifecycleReason: lifecycleInfo?.reason || lifecycleInfo?.lifecycleReason || null,
    matchedSegment: lifecycleInfo?.matchedSegment || null,
    lifecycleConfidence: lifecycleInfo?.confidence || lifecycleInfo?.lifecycleConfidence || null,
    agreementFamily: lifecycleInfo?.agreementFamily || 'OTHER',
    contractStatus: lifecycleInfo?.contractStatus || null,
    contractStatusLabel: lifecycleInfo?.contractStatusLabel || null,
    contractValue: lifecycleInfo?.contractValue ?? null,
    contractValueDisplay: lifecycleInfo?.contractValueDisplay || null,
    currency: lifecycleInfo?.currency || null,
    effectiveDate: lifecycleInfo?.effectiveDate || null,
    startDate: lifecycleInfo?.startDate || null,
    commencementDate: lifecycleInfo?.commencementDate || null,
    expiryDate: lifecycleInfo?.expiryDate || null,
    expirationDate: lifecycleInfo?.expirationDate || null,
    endDate: lifecycleInfo?.endDate || null,
    terminationDate: lifecycleInfo?.terminationDate || null,
    renewalDate: lifecycleInfo?.renewalDate || null,
    signedDate: lifecycleInfo?.signedDate || null,
    extraction: lifecycleInfo?.extraction || null,
    sourceId,
    missingFromDisk: false,
  };
};

const makeContractFromEntry = (entry, pathParts, sourceName, nestedInfo = null, lifecycleInfo = null) => {
  const sourcePath = entry.relativePath || entry.name;
  const fileBase = baseNameOf(entry.name);
  const nameSource = contractNameSource(fileBase, pathParts);
  const textContent = entry.textContent || '';
  const heading = contractHeading(textContent);
  const typeSignal = `${heading} ${sourcePath} ${fileBase}`;
  const pathText = `${typeSignal} ${textContent.slice(0, 8000)}`;
  const templateLike = isTemplateLike(pathText);
  const type = inferType(typeSignal, { includeGeneric: false }) || inferType(pathText) || CONTRACT_TYPES[CONTRACT_TYPES.length - 1];
  const lifecycleStage = lifecycleInfo?.lifecycleStage || LIFECYCLE_STAGE.UNKNOWN;
  const department = inferDepartment(pathText, pathParts);
  const counterparty = lifecycleInfo?.counterparty
    ? titleCase(lifecycleInfo.counterparty)
    : nestedInfo?.company
    ? titleCase(nestedInfo.company)
    : (inferCounterpartyFromText(textContent) || inferCounterparty(nameSource, type));
  const title = `${type.label} - ${counterparty}`;
  const dates = templateLike ? [] : inferDates(pathText);
  const startDate = lifecycleInfo?.effectiveDate || lifecycleInfo?.startDate || lifecycleInfo?.commencementDate || (dates.length > 1 ? dates[0] : null);
  const endDate = lifecycleInfo?.expiryDate || lifecycleInfo?.expirationDate || lifecycleInfo?.endDate || lifecycleInfo?.terminationDate || (dates.length > 1 ? dates[dates.length - 1] : null);
  const status = deriveContractStatusLabel({
    lifecycleStage,
    contractStatus: lifecycleInfo?.contractStatus,
    contractStatusLabel: lifecycleInfo?.contractStatusLabel,
    expiryDate: lifecycleInfo?.expiryDate || lifecycleInfo?.expirationDate,
    endDate,
    terminationDate: lifecycleInfo?.terminationDate,
  }) || statusFromLifecycleStage(lifecycleStage, inferStatusFromPath(pathParts) || inferStatus(pathText));
  const inferredValue = inferValue(pathText);
  const extractedValue = optionalNumber(lifecycleInfo?.contractValue);
  const value = extractedValue ?? inferredValue;
  const createdDate = isoDate(entry.lastModified);
  const owner = department === 'Legal' ? 'Legal Team' : `${department} Department`;
  const id = `LF-${stableHash(`${sourceName}-${sourcePath}`)}`;
  const sourceFolder = pathParts.slice(0, -1).join('/');

  return {
    id,
    title,
    type: type.value,
    status,
    counterparty,
    owner,
    department,
    value,
    contractValue: extractedValue,
    contractValueDisplay: lifecycleInfo?.contractValueDisplay || null,
    currency: lifecycleInfo?.currency || null,
    startDate,
    endDate,
    effectiveDate: lifecycleInfo?.effectiveDate || null,
    commencementDate: lifecycleInfo?.commencementDate || null,
    expiryDate: lifecycleInfo?.expiryDate || lifecycleInfo?.expirationDate || null,
    terminationDate: lifecycleInfo?.terminationDate || null,
    signedDate: lifecycleInfo?.signedDate || null,
    renewalDate: lifecycleInfo?.renewalDate || renewalFromEndDate(endDate),
    createdDate,
    tags: unique(['Legal Folder', department, type.value, extensionOf(entry.name).toUpperCase()]),
    priority: 'Medium',
    stage: stageFromStatus(status),
    contractStatus: lifecycleInfo?.contractStatus || null,
    contractStatusLabel: lifecycleInfo?.contractStatusLabel || status,
    extraction: lifecycleInfo?.extraction || null,
    lifecycleStage,
    stageFolder: lifecycleInfo?.stageFolder || null,
    lifecycleReason: lifecycleInfo?.reason || lifecycleInfo?.lifecycleReason || null,
    matchedSegment: lifecycleInfo?.matchedSegment || null,
    lifecycleConfidence: lifecycleInfo?.confidence || lifecycleInfo?.lifecycleConfidence || null,
    agreementFamily: lifecycleInfo?.agreementFamily || type.value,
    description: heading
      ? `${heading}. Imported from ${sourceName}. Source path: ${sourcePath}`
      : `Imported from ${sourceName}. Source path: ${sourcePath}`,
    clauses: inferClauses(pathText, type.value),
    approvers: [
      { name: 'Legal Folder', role: 'Source Folder', status: 'Approved', date: createdDate },
    ],
    activity: [
      { date: createdDate, action: 'Synced from legal folder', user: 'Shared Folder' },
    ],
    relatedDocuments: [],
    source: 'shared-folder',
    sourceFolder,
    sourcePath,
    relativePath: sourcePath,
    legalFolderRelativePath: sourcePath,
    year: nestedInfo?.year || null,
    importedAt: new Date().toISOString(),
  };
};

export const entriesFromFileList = (fileList) =>
  Array.from(fileList || []).map((file) => ({
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    relativePath: file.webkitRelativePath || file.name,
  }));

export const collectFilesFromDirectoryHandle = async (directoryHandle) => {
  const files = [];

  const walk = async (handle, path) => {
    for await (const [name, entry] of handle.entries()) {
      const childPath = `${path}/${name}`;
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        files.push({
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          relativePath: childPath,
        });
      } else if (entry.kind === 'directory') {
        await walk(entry, childPath);
      }
    }
  };

  await walk(directoryHandle, directoryHandle.name);
  return files;
};

export const buildLegalFolderImport = (entries, sourceName = 'Shared Folder') => {
  const documents = [];
  const skippedEntries = [];
  const sourceId = entries.find((entry) => entry.lifecycleMetadata?.sourceId)?.lifecycleMetadata.sourceId || sourceName;
  const importableEntries = entries.filter((entry) => {
    const path = entry.relativePath || entry.name;
    const name = entry.name || path.split('/').pop();
    const pathParts = normalisePath(path);
    const hiddenPath = pathParts.some((part) => part.startsWith('.'));
    const skipped = !name || hiddenPath || SKIPPED_FILE_PATTERN.test(name);

    if (skipped) {
      skippedEntries.push({ name, path });
      return false;
    }

    return true;
  });

  const contracts = importableEntries.map((entry) => {
    const pathParts = normalisePath(entry.relativePath || entry.name);
    const name = entry.name || pathParts[pathParts.length - 1];
    const lifecycleInfo = {
      ...classifyLegalFolderEntryPath(entry.relativePath || entry.name),
      ...(entry.lifecycleMetadata || {}),
    };
    const nestedInfo = detectNestedStructure(pathParts, lifecycleInfo);
    const contract = makeContractFromEntry({ ...entry, name }, pathParts, sourceName, nestedInfo, lifecycleInfo);
    const document = makeDocument({ ...entry, name }, contract, contract.status, nestedInfo, lifecycleInfo, sourceId);

    contract.relatedDocuments = [document];
    contract.tags = unique([
      ...(contract.tags || []),
      extensionOf(name).toUpperCase(),
      lifecycleInfo.lifecycleStage !== LIFECYCLE_STAGE.UNKNOWN ? lifecycleInfo.lifecycleStage : '',
    ]);

    documents.push(document);
    if (lifecycleInfo.lifecycleStage === LIFECYCLE_STAGE.TEMPLATE) return null;
    return {
      ...contract,
      activity: [
        { date: isoDate(Date.now()), action: 'Synced from shared folder', user: 'Shared Folder' },
        ...(contract.activity || []),
      ],
    };
  }).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));

  const lifecycleSummary = documents.reduce((acc, doc) => {
    const stage = doc.lifecycleStage || LIFECYCLE_STAGE.UNKNOWN;
    if (stage === LIFECYCLE_STAGE.TEMPLATE) acc.templates += 1;
    else if (stage === LIFECYCLE_STAGE.DRAFT) acc.drafts += 1;
    else if (stage === LIFECYCLE_STAGE.FINAL) acc.finals += 1;
    else if (stage === LIFECYCLE_STAGE.SIGNED) acc.signed += 1;
    else acc.unknown += 1;
    return acc;
  }, { templates: 0, drafts: 0, finals: 0, signed: 0, unknown: 0 });

  return {
    source: {
      importerVersion: IMPORTER_VERSION,
      importerMode: 'legal-folder-lifecycle',
      name: sourceName,
      sourceId,
      syncedAt: new Date().toISOString(),
      scannedFileCount: entries.length,
      fileCount: importableEntries.length,
      skippedFileCount: skippedEntries.length,
      contractCount: contracts.length,
      skippedSamples: skippedEntries.slice(0, 5),
      lifecycleSummary,
    },
    contracts,
    documents,
  };
};

const countLifecycleStages = (records = []) =>
  records.reduce((counts, record) => {
    const stage = String(record.lifecycleStage || 'UNKNOWN').toUpperCase();
    counts[stage] = (counts[stage] || 0) + 1;
    return counts;
  }, { TEMPLATE: 0, DRAFT: 0, FINAL: 0, SIGNED: 0, UNKNOWN: 0 });

const pathValueForRecord = (record = {}) =>
  [
    record.relativePath,
    record.legalFolderPath,
    record.sourcePath,
    record.folderPath,
    record.displayPath,
    record.path,
    record.filePath,
    record.fullPath,
    record.relativeFilePath,
    record.legalFolderRelativePath,
    record.sourceRelativePath,
  ].filter(Boolean).join(' ');

const hasSignedLikePath = (record = {}) =>
  /\b(signed|executed|completed|sign)\b/i.test(pathValueForRecord(record).replace(/[_-]/g, ' '));

const signedLikeRecords = (records = []) =>
  records
    .filter(hasSignedLikePath)
    .map((record) => ({
      title: record.title || record.name || record.fileName || null,
      fileName: record.fileName || record.name || null,
      relativePath: record.relativePath || null,
      sourcePath: record.sourcePath || null,
      displayPath: record.displayPath || null,
      lifecycleStage: record.lifecycleStage || null,
      documentStage: record.documentStage || null,
      status: record.status || null,
      lifecycleReason: record.lifecycleReason || record.reason || null,
      matchedSegment: record.matchedSegment || null,
    }));

export const buildLegalFolderImportFromLifecycleIndex = (payload = {}) => {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const sourceName = payload.rootName || payload.name || 'Legal Folder';
  const entries = files.map((file) => ({
    name: file.fileName || String(file.relativePath || '').split('/').pop(),
    size: file.fileSize || 0,
    lastModified: file.lastModified || file.updatedAt || Date.now(),
    relativePath: file.relativePath || file.displayPath || file.fileName,
    textContent: '',
    lifecycleMetadata: file,
  }));
  const snapshot = buildLegalFolderImport(entries, sourceName);
  if (import.meta.env.DEV) {
    const receivedCounts = countLifecycleStages(files);
    const afterDocumentCounts = countLifecycleStages(snapshot.documents);
    const afterContractCounts = countLifecycleStages(snapshot.contracts);
    console.info('[legalFolderStore] lifecycle sync diagnostics', {
      receivedTotal: files.length,
      receivedSigned: receivedCounts.SIGNED,
      receivedUnknown: receivedCounts.UNKNOWN,
      afterConversionTotal: snapshot.contracts.length,
      afterConversionSigned: afterContractCounts.SIGNED,
      afterConversionUnknown: afterContractCounts.UNKNOWN,
      afterConversionDocumentsTotal: snapshot.documents.length,
      afterConversionDocumentsSigned: afterDocumentCounts.SIGNED,
      afterConversionDocumentsUnknown: afterDocumentCounts.UNKNOWN,
      signedLikeRecordsAfterConversion: signedLikeRecords([...snapshot.contracts, ...snapshot.documents]).slice(0, 20),
    });
  }
  return {
    ...snapshot,
    source: {
      ...snapshot.source,
      sourceId: payload.sourceId || snapshot.source.sourceId || sourceName,
      name: sourceName,
      rootName: payload.rootName || sourceName,
      lifecycleSummary: payload.summary || snapshot.source.lifecycleSummary,
      scannedFileCount: payload.summary?.scanned ?? snapshot.source.scannedFileCount,
      skippedFileCount: payload.summary?.skipped ?? snapshot.source.skippedFileCount,
      fileCount: files.length,
    },
  };
};

export const applyLifecycleIndexPayload = (payload = {}) => {
  if (!payload?.ok) return getLegalFolderImport();
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (payload.eventType === 'disconnect' || (!payload.hasRoot && files.length === 0)) {
    clearLegalFolderImport();
    return getLegalFolderImport();
  }
  const snapshot = buildLegalFolderImportFromLifecycleIndex(payload);
  saveLegalFolderImport(snapshot);
  return snapshot;
};

export const syncLifecycleIndexFromDesktop = async () => {
  if (typeof window === 'undefined' || typeof window.contractiq?.getLifecycleIndex !== 'function') {
    return getLegalFolderImport();
  }
  const payload = await window.contractiq.getLifecycleIndex();
  if (!payload?.ok) return getLegalFolderImport();
  return applyLifecycleIndexPayload(payload);
};

export const LEGAL_FOLDER_LIFECYCLE_NOTIFICATION = 'legal-folder-lifecycle-notification';

const emitLifecycleNotification = (notification) => {
  if (typeof window === 'undefined' || !notification?.message) return;
  window.dispatchEvent(new CustomEvent(LEGAL_FOLDER_LIFECYCLE_NOTIFICATION, { detail: notification }));
};

export const subscribeToDesktopLifecycleIndex = () => {
  if (typeof window === 'undefined' || typeof window.contractiq?.onLifecycleUpdated !== 'function') {
    return () => {};
  }
  return window.contractiq.onLifecycleUpdated((payload) => {
    if (!payload?.ok) return;
    applyLifecycleIndexPayload(payload);
    if (payload.live && payload.notification) emitLifecycleNotification(payload.notification);
  });
};

export const saveLegalFolderImport = (snapshot) => {
  toStorage(CONTRACTS_KEY, snapshot.contracts || []);
  toStorage(DOCUMENTS_KEY, snapshot.documents || []);
  toStorage(SOURCE_KEY, snapshot.source || null);
  emitUpdate();
};

export const getLegalFolderImport = () => ({
  contracts: (() => {
    const source = fromStorage(SOURCE_KEY, null);
    return source?.importerVersion === IMPORTER_VERSION ? fromStorage(CONTRACTS_KEY, []) : [];
  })(),
  documents: (() => {
    const source = fromStorage(SOURCE_KEY, null);
    return source?.importerVersion === IMPORTER_VERSION ? fromStorage(DOCUMENTS_KEY, []) : [];
  })(),
  source: (() => {
    const source = fromStorage(SOURCE_KEY, null);
    return source?.importerVersion === IMPORTER_VERSION ? source : null;
  })(),
});

export const clearLegalFolderImport = () => {
  removeStorage(CONTRACTS_KEY);
  removeStorage(DOCUMENTS_KEY);
  removeStorage(SOURCE_KEY);
  emitUpdate();
};

export const addDocumentToLegalFolderImport = (doc) => {
  const source = fromStorage(SOURCE_KEY, null);
  if (!source || source.importerVersion !== IMPORTER_VERSION) return;
  const existing = fromStorage(DOCUMENTS_KEY, []);
  toStorage(DOCUMENTS_KEY, [...existing.filter((d) => d._id !== doc._id), doc]);
  emitUpdate();
};

export const getContractsForApp = () => {
  const importedContracts = getLegalFolderImport().contracts;
  return importedContracts.length ? importedContracts : mockContracts;
};
