// Client-side DOCX placeholder scanner.
// Accepts a File/Blob, reads the ZIP structure with the browser Compression API,
// and returns a structured list of detected placeholders and blank form fields.
//
// No server upload required. Operates entirely in the browser.

import {
  humanizePlaceholderLabel,
  normalizePlaceholderKey,
  xmlDecodeText,
} from './templatePlaceholderUtils';

// ── ZIP reader (no external dependency) ──────────────────────────────────────

const readUint16 = (view, offset) => view.getUint16(offset, true);
const readUint32 = (view, offset) => view.getUint32(offset, true);

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') return null;
  for (const fmt of ['deflate-raw', 'deflate']) {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(fmt));
      return await new Response(stream).arrayBuffer();
    } catch { /* try next format */ }
  }
  return null;
}

async function extractFromZip(arrayBuffer, targetName) {
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder();
  const minEocd = 22;
  const maxComment = 65535;
  const start = Math.max(0, view.byteLength - minEocd - maxComment);
  let eocdOffset = -1;

  for (let off = view.byteLength - minEocd; off >= start; off--) {
    if (readUint32(view, off) === 0x06054b50) { eocdOffset = off; break; }
  }
  if (eocdOffset === -1) return '';

  const totalEntries = readUint16(view, eocdOffset + 10);
  let cursor = readUint32(view, eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (readUint32(view, cursor) !== 0x02014b50) break;
    const compression = readUint16(view, cursor + 10);
    const compressedSize = readUint32(view, cursor + 20);
    const fileNameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localHeaderOffset = readUint32(view, cursor + 42);
    const name = decoder.decode(new Uint8Array(arrayBuffer, cursor + 46, fileNameLength));

    if (name === targetName && readUint32(view, localHeaderOffset) === 0x04034b50) {
      const localNameLen = readUint16(view, localHeaderOffset + 26);
      const localExtraLen = readUint16(view, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressed = arrayBuffer.slice(dataStart, dataStart + compressedSize);
      const content = compression === 0 ? compressed : await inflateRaw(compressed);
      return content ? decoder.decode(content) : '';
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return '';
}

async function listZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder();
  const start = Math.max(0, view.byteLength - 22 - 65535);
  let eocdOffset = -1;

  for (let off = view.byteLength - 22; off >= start; off--) {
    if (readUint32(view, off) === 0x06054b50) { eocdOffset = off; break; }
  }
  if (eocdOffset === -1) return [];

  const totalEntries = readUint16(view, eocdOffset + 10);
  let cursor = readUint32(view, eocdOffset + 16);
  const names = [];

  for (let i = 0; i < totalEntries; i++) {
    if (readUint32(view, cursor) !== 0x02014b50) break;
    const fileNameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    names.push(decoder.decode(new Uint8Array(arrayBuffer, cursor + 46, fileNameLength)));
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return names;
}

// ── XML helpers ───────────────────────────────────────────────────────────────

// Reconstruct paragraph-level text by joining all <w:t> content within each <w:p>.
// This handles placeholders split across OOXML runs at the paragraph boundary.
function extractParagraphTexts(xml) {
  const paras = [];
  // Match each paragraph block
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const textRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

  for (const m of xml.matchAll(paraRe)) {
    const parts = [];
    for (const t of m[0].matchAll(textRe)) {
      parts.push(xmlDecodeText(t[1]));
    }
    const text = parts.join('');
    if (text.trim()) paras.push(text);
  }
  return paras;
}

// ── Placeholder detection ─────────────────────────────────────────────────────

// [PLACEHOLDER TEXT] — square bracket, 1–80 chars, may contain spaces/slashes/dots
const SQUARE_RE = /\[([A-Za-z][^[\]\n]{0,80}?)\]/g;
// {{PlaceholderName}} — curly double braces
const CURLY_RE = /\{\{([A-Za-z][^{}\n]{0,80})\}\}/g;
// INSERT_COMPANY_NAME / INSERT_REG._NO. style placeholders
const UPPER_UNDERSCORE_RE = /\b[A-Z][A-Z0-9]*(?:[._]+[A-Z0-9]+)+\.?\b/g;
// A small set of plain uppercase placeholders when they occupy a field-like run.
const PLAIN_PLACEHOLDER_RE = /^(COMPANY|COUNTERPARTY|COUNTERPARTY NAME|DATE|EFFECTIVE DATE|COMMENCEMENT DATE)$/;
// Blank form label: "Label text:" optionally followed by underscores/dots/nothing
const BLANK_FIELD_RE = /^([A-Za-z][A-Za-z /\-,]+?):\s*(?:_{2,}|\.{2,}|\*{2,})?\s*$/;
// Signing field patterns
const SIGN_PATTERNS = [
  /\bSigned?\s+(?:at|on)\b/i,
  /\bDate\s*:\s*$/i,
  /\bWitness\s*:\s*$/i,
  /\bNotary\s*:\s*$/i,
];

const FIELD_GROUPS = {
  'COMPANY NAME': 'Parties',
  'COMPANY': 'Parties',
  'PARTY': 'Parties',
  'BENEFICIARY': 'Parties',
  'LENDER': 'Parties',
  'BORROWER': 'Parties',
  'CLIENT': 'Parties',
  'SERVICE PROVIDER': 'Parties',
  'CONSULTANT': 'Parties',
  'REG': 'Registration Details',
  'REGISTRATION': 'Registration Details',
  'REG NO': 'Registration Details',
  'REGISTRATION NUMBER': 'Registration Details',
  'DATE': 'Dates',
  'EFFECTIVE DATE': 'Dates',
  'COMMENCEMENT': 'Dates',
  'TERMINATION': 'Dates',
  'AMOUNT': 'Funding / Amounts',
  'FUNDING': 'Funding / Amounts',
  'LOAN AMOUNT': 'Funding / Amounts',
  'CAPACITY': 'Funding / Amounts',
  'ADDRESS': 'Addresses',
  'PHYSICAL ADDRESS': 'Addresses',
  'POSTAL': 'Addresses',
  'EMAIL': 'Notices',
  'ATTENTION': 'Notices',
  'NOTICE': 'Notices',
  'FULL NAME': 'Signatures',
  'DESIGNATION': 'Signatures',
  'SIGNATORY': 'Signatures',
  'SIGNED': 'Signatures',
  'WITNESS': 'Signatures',
  'ANNEXURE': 'Annexures',
  'SCHEDULE': 'Annexures',
};

function guessGroup(raw) {
  const up = normalizePlaceholderKey(raw).replace(/_/g, ' ').toUpperCase();
  for (const [key, group] of Object.entries(FIELD_GROUPS)) {
    if (up.includes(key)) return group;
  }
  return 'Other';
}

function normaliseKey(raw) {
  return normalizePlaceholderKey(raw);
}

function toLabel(raw) {
  return humanizePlaceholderLabel(raw);
}

function scanParagraphs(paragraphs) {
  const placeholderMap = new Map();
  const blankFieldMap = new Map();
  const warnings = [];

  for (const para of paragraphs) {
    // Square bracket placeholders
    for (const m of para.matchAll(SQUARE_RE)) {
      const raw = m[1];
      // Skip clearly non-placeholder content (like [20022023] date stamps)
      if (/^\d+$/.test(raw)) continue;
      const key = normaliseKey(raw);
      if (placeholderMap.has(key)) {
        placeholderMap.get(key).occurrences++;
      } else {
        placeholderMap.set(key, {
          key,
          label: toLabel(raw),
          raw: `[${raw}]`,
          type: 'square',
          required: true,
          occurrences: 1,
          group: guessGroup(raw),
        });
      }
    }

    // Curly placeholders
    for (const m of para.matchAll(CURLY_RE)) {
      const raw = m[1];
      const key = normaliseKey(raw);
      if (placeholderMap.has(key)) {
        placeholderMap.get(key).occurrences++;
      } else {
        placeholderMap.set(key, {
          key,
          label: toLabel(raw),
          raw: `{{${raw}}}`,
          type: 'curly',
          required: true,
          occurrences: 1,
          group: guessGroup(raw),
        });
      }
    }

    // Uppercase underscore placeholders like INSERT_COMPANY_NAME.
    for (const m of para.matchAll(UPPER_UNDERSCORE_RE)) {
      const raw = m[0];
      const key = normaliseKey(raw);
      if (placeholderMap.has(key)) {
        placeholderMap.get(key).occurrences++;
      } else {
        placeholderMap.set(key, {
          key,
          label: toLabel(raw),
          raw,
          type: 'underscore',
          required: true,
          occurrences: 1,
          group: guessGroup(raw),
        });
      }
    }

    // Plain placeholders are only detected when the whole paragraph/run text is
    // an obvious field token, not when the word appears in normal legal prose.
    const plain = para.trim();
    if (PLAIN_PLACEHOLDER_RE.test(plain)) {
      const key = normaliseKey(plain);
      if (placeholderMap.has(key)) {
        placeholderMap.get(key).occurrences++;
      } else {
        placeholderMap.set(key, {
          key,
          label: toLabel(plain),
          raw: plain,
          type: 'plain',
          required: true,
          occurrences: 1,
          group: guessGroup(plain),
        });
      }
    }

    // Blank form fields (e.g. "Full Name:   ____")
    const blankMatch = para.match(BLANK_FIELD_RE);
    if (blankMatch) {
      const label = blankMatch[1].trim();
      const key = normaliseKey(label);
      if (!blankFieldMap.has(key)) {
        blankFieldMap.set(key, {
          label,
          key,
          type: 'blank',
          group: guessGroup(label),
          required: false,
          context: para.slice(0, 80),
        });
      }
    }

    // Signing patterns
    for (const re of SIGN_PATTERNS) {
      if (re.test(para)) {
        const key = normaliseKey(para.slice(0, 30));
        if (!blankFieldMap.has(key)) {
          blankFieldMap.set(key, {
            label: para.trim().slice(0, 40),
            key,
            type: 'signing',
            group: 'Signatures',
            required: false,
            context: para.slice(0, 80),
          });
        }
      }
    }
  }

  // Warn about potential split-run placeholders (heuristic: partial bracket found)
  const fullText = paragraphs.join(' ');
  if (/\[\s*$|\s*\]/.test(fullText)) {
    warnings.push('Some placeholders may be split across formatting runs and were not detected. Review the template manually.');
  }

  return {
    placeholders: Array.from(placeholderMap.values()),
    blankFields: Array.from(blankFieldMap.values()),
    warnings,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

function getDocxTextParts(entries) {
  const priority = new Map([
    ['word/document.xml', 0],
    ['word/footnotes.xml', 1],
    ['word/endnotes.xml', 2],
    ['word/comments.xml', 3],
  ]);
  return entries
    .filter((entry) => entry.startsWith('word/') && entry.endsWith('.xml'))
    .filter((entry) => (
      entry === 'word/document.xml' ||
      /^word\/header\d+\.xml$/.test(entry) ||
      /^word\/footer\d+\.xml$/.test(entry) ||
      /^word\/textbox.*\.xml$/.test(entry) ||
      ['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'].includes(entry)
    ))
    .sort((a, b) => {
      const ap = priority.has(a) ? priority.get(a) : 10;
      const bp = priority.has(b) ? priority.get(b) : 10;
      return ap - bp || a.localeCompare(b);
    });
}

/**
 * Scans a DOCX File/Blob for placeholders and blank form fields.
 *
 * @param {File|Blob} blob  — the DOCX file
 * @param {string} [templateTitle]
 * @returns {Promise<ScanResult>}
 */
export async function scanDocx(blob, templateTitle = '') {
  const arrayBuffer = await blob.arrayBuffer();

  const entries = await listZipEntries(arrayBuffer);
  const isDocx = entries.includes('word/document.xml') || entries.includes('[Content_Types].xml');
  if (!isDocx) {
    return { templateTitle, placeholders: [], blankFields: [], detectedRoles: [], warnings: ['File does not appear to be a valid DOCX.'] };
  }

  const paragraphs = [];

  for (const part of getDocxTextParts(entries)) {
    try {
      const xml = await extractFromZip(arrayBuffer, part);
      if (xml) paragraphs.push(...extractParagraphTexts(xml));
    } catch { /* skip unreadable parts */ }
  }

  const { placeholders, blankFields, warnings } = scanParagraphs(paragraphs);

  // Detect party roles from placeholder keys
  const detectedRoles = [];
  const keys = placeholders.map((p) => p.key);
  if (keys.some((k) => k.includes('BENEFICIARY'))) detectedRoles.push('Beneficiary');
  if (keys.some((k) => k.includes('COMPANY') || k.includes('CLIENT'))) detectedRoles.push('Company');
  if (keys.some((k) => k.includes('LENDER'))) detectedRoles.push('Lender');
  if (keys.some((k) => k.includes('BORROWER'))) detectedRoles.push('Borrower');
  if (keys.some((k) => k.includes('CONSULTANT') || k.includes('SERVICE_PROVIDER'))) detectedRoles.push('Consultant');

  // Guess agreement family from placeholder content
  let detectedAgreementFamily = null;
  const allKeys = keys.join(' ');
  if (/BENEFICIARY|EEIP|B-BBEE|ASSISTANCE/.test(allKeys)) detectedAgreementFamily = 'ASSISTANCE_AGREEMENT';
  else if (/LOAN|LENDER|BORROWER|FUNDING/.test(allKeys)) detectedAgreementFamily = 'FUNDING_LOAN_AGREEMENT';
  else if (/SERVICE|CONSULTANT|CLIENT/.test(allKeys)) detectedAgreementFamily = 'MASTER_SERVICE_AGREEMENT';
  else if (/CONFIDENTIAL|NDA/.test(allKeys)) detectedAgreementFamily = 'NDA';

  return {
    templateTitle,
    placeholders,
    blankFields,
    detectedRoles,
    detectedAgreementFamily,
    warnings,
  };
}

/**
 * Returns true if the file is scannable (DOCX).
 */
export function isScannable(extension) {
  return ['docx', 'dotx', 'doc'].includes(String(extension || '').toLowerCase());
}
