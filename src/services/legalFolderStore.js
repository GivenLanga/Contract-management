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

const TEXT_EXTRACT_EXTENSIONS = new Set(['docx', 'txt', 'md', 'rtf', 'csv', 'json']);
const SKIPPED_FILE_PATTERN = /(^\.|^~\$|\.tmp$|\.lock$|\.crdownload$|\.part$)/i;
const GENERIC_FILE_NAME = /\b(annexure|appendix|attachment|comments|exhibit|redline|redlines|schedule|scope|signed copy|version|v\d+(?:\.\d+)*)\b/i;

// Returns true if the file lives inside a drafts folder anywhere in its path
const isInDraftsFolder = (pathParts) =>
  pathParts.slice(0, -1).some((part) => part.toLowerCase() === 'drafts');

// Detects the corporate nesting pattern: RootFolder/Year/Company/StatusFolder/file
// Returns { year, company } when the pattern is found, otherwise null
const detectNestedStructure = (pathParts) => {
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
  const match = text.match(/\b(?:zar|usd|r|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : 0;
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

const makeDocument = (entry, contract, status, nestedInfo = null) => {
  const ext = extensionOf(entry.name);
  const updatedAt = new Date(entry.lastModified || Date.now()).toISOString();
  const sourcePath = entry.relativePath || entry.name;
  const companyName = nestedInfo?.company ? titleCase(nestedInfo.company) : null;

  return {
    _id: `DOC-${stableHash(`${sourcePath}-${entry.size}-${entry.lastModified}`)}`,
    name: entry.name,
    type: ext,
    size: entry.size || 0,
    status,
    updatedAt,
    uploadedBy: { name: companyName || 'Shared Folder' },
    contract: { id: contract.id, title: contract.title },
    source: 'shared-folder',
    sourcePath,
    company: companyName,
    year: nestedInfo?.year || null,
  };
};

const makeContractFromEntry = (entry, pathParts, sourceName, nestedInfo = null) => {
  const sourcePath = entry.relativePath || entry.name;
  const fileBase = baseNameOf(entry.name);
  const nameSource = contractNameSource(fileBase, pathParts);
  const textContent = entry.textContent || '';
  const heading = contractHeading(textContent);
  const typeSignal = `${heading} ${sourcePath} ${fileBase}`;
  const pathText = `${typeSignal} ${textContent.slice(0, 8000)}`;
  const templateLike = isTemplateLike(pathText);
  const type = inferType(typeSignal, { includeGeneric: false }) || inferType(pathText) || CONTRACT_TYPES[CONTRACT_TYPES.length - 1];
  const status = inferStatusFromPath(pathParts) || inferStatus(pathText);
  const department = inferDepartment(pathText, pathParts);
  const counterparty = nestedInfo?.company
    ? titleCase(nestedInfo.company)
    : (inferCounterpartyFromText(textContent) || inferCounterparty(nameSource, type));
  const title = `${type.label} - ${counterparty}`;
  const dates = templateLike ? [] : inferDates(pathText);
  const startDate = dates.length > 1 ? dates[0] : null;
  const endDate = dates.length > 1 ? dates[dates.length - 1] : null;
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
    value: inferValue(pathText),
    startDate,
    endDate,
    renewalDate: renewalFromEndDate(endDate),
    createdDate,
    tags: unique(['Legal Folder', department, type.value, extensionOf(entry.name).toUpperCase()]),
    priority: 'Medium',
    stage: stageFromStatus(status),
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
  const importableEntries = entries.filter((entry) => {
    const path = entry.relativePath || entry.name;
    const name = entry.name || path.split('/').pop();
    const pathParts = normalisePath(path);
    const hiddenPath = pathParts.some((part) => part.startsWith('.'));
    const inDrafts = isInDraftsFolder(pathParts);
    const skipped = !name || hiddenPath || SKIPPED_FILE_PATTERN.test(name) || inDrafts;

    if (skipped) {
      skippedEntries.push({ name, path });
      return false;
    }

    return true;
  });

  const contracts = importableEntries.map((entry) => {
    const pathParts = normalisePath(entry.relativePath || entry.name);
    const name = entry.name || pathParts[pathParts.length - 1];
    const nestedInfo = detectNestedStructure(pathParts);
    const contract = makeContractFromEntry({ ...entry, name }, pathParts, sourceName, nestedInfo);
    const document = makeDocument({ ...entry, name }, contract, contract.status, nestedInfo);

    contract.relatedDocuments = [document];
    contract.tags = unique([...(contract.tags || []), extensionOf(name).toUpperCase()]);

    documents.push(document);
    return {
      ...contract,
      activity: [
        { date: isoDate(Date.now()), action: 'Synced from shared folder', user: 'Shared Folder' },
        ...(contract.activity || []),
      ],
    };
  }).sort((a, b) => a.title.localeCompare(b.title));

  return {
    source: {
      importerVersion: IMPORTER_VERSION,
      importerMode: 'all-non-hidden-files',
      name: sourceName,
      syncedAt: new Date().toISOString(),
      scannedFileCount: entries.length,
      fileCount: importableEntries.length,
      skippedFileCount: skippedEntries.length,
      contractCount: contracts.length,
      skippedSamples: skippedEntries.slice(0, 5),
    },
    contracts,
    documents,
  };
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
