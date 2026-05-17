'use strict';

const path = require('path');

const CONTRACT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  EXPIRING_SOON: 'EXPIRING_SOON',
  TERMINATED: 'TERMINATED',
  UNKNOWN: 'UNKNOWN',
});

const STATUS_LABELS = Object.freeze({
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  EXPIRING_SOON: 'Expiring Soon',
  TERMINATED: 'Terminated',
  UNKNOWN: 'Unknown',
});

const MONTHS = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

const MONTH_PATTERN = Array.from(MONTHS.keys())
  .sort((a, b) => b.length - a.length)
  .join('|');

const TEXT_PARTS = [
  'word/document.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml',
];

const MONEY_LABELS = [
  { key: 'total_contract_value', score: 100, pattern: /\b(total\s+contract\s+value|maximum\s+contract\s+value)\b/i },
  { key: 'contract_value', score: 95, pattern: /\b(contract\s+value|agreement\s+value|approved\s+amount)\b/i },
  { key: 'finance_amount', score: 90, pattern: /\b(loan\s+amount|funding\s+amount|facility\s+amount|grant\s+amount)\b/i },
  { key: 'price', score: 80, pattern: /\b(contract\s+price|purchase\s+price|consideration)\b/i },
  { key: 'fees', score: 70, pattern: /\b(service\s+fees?|fees?)\b/i },
  { key: 'amount', score: 55, pattern: /\b(amount|not\s+exceeding)\b/i },
];

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xmlToText(xml) {
  return decodeXmlEntities(xml)
    .replace(/<w:tab\b[^>]*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function toIsoDate(year, month, day) {
  if (!isValidDateParts(year, month, day)) return null;
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function parseDateFragment(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  let match = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (match) return toIsoDate(match[1], match[2], match[3]);

  match = text.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/);
  if (match) return toIsoDate(match[3], match[2], match[1]);

  match = text.match(new RegExp(`\\b(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:\\s+day\\s+of)?\\s+(${MONTH_PATTERN})\\s+(20\\d{2})\\b`, 'i'));
  if (match) return toIsoDate(match[3], MONTHS.get(match[2].toLowerCase()), match[1]);

  return null;
}

function dateValuePattern() {
  return `(?:20\\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\\d|3[01])|(?:0?[1-9]|[12]\\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.]20\\d{2}|(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:\\s+day\\s+of)?\\s+(?:${MONTH_PATTERN})\\s+20\\d{2})`;
}

function firstDateAfterLabel(text, labelPattern, maxChars = 120) {
  const pattern = new RegExp(`${labelPattern}[^\\n\\r]{0,${maxChars}}?(${dateValuePattern()})`, 'i');
  const match = text.match(pattern);
  return match ? parseDateFragment(match[1]) : null;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function extractDates(text) {
  const normalized = normalizeText(text);
  const fieldsFound = [];
  const warnings = [];

  const effectiveDate = firstDateAfterLabel(normalized, '\\bEffective\\s+Date\\b');
  const commencementDate = firstDateAfterLabel(normalized, '\\bCommencement\\s+Date\\b');
  const explicitStartDate = firstDateAfterLabel(normalized, '\\bStart\\s+Date\\b');
  const signedDate = firstDateAfterLabel(normalized, '\\b(?:Signature|Signed)\\s+Date\\b');
  const expiryDate =
    firstDateAfterLabel(normalized, '\\b(?:Expiry|Expiration)\\s+Date\\b') ||
    firstDateAfterLabel(normalized, '\\b(?:expires?|expire)\\s+(?:on|at)\\b', 80) ||
    firstDateAfterLabel(normalized, '\\bvalid\\s+until\\b', 80) ||
    firstDateAfterLabel(normalized, '\\bremain(?:s)?\\s+in\\s+force\\s+until\\b', 80);
  const endDate = firstDateAfterLabel(normalized, '\\bEnd\\s+Date\\b') || expiryDate;
  const terminationDate = firstDateAfterLabel(normalized, '\\bTermination\\s+Date\\b');
  const renewalDate = firstDateAfterLabel(normalized, '\\bRenewal\\s+Date\\b');

  const startDate = effectiveDate || commencementDate || explicitStartDate || null;

  const allDates = [];
  const allDatePattern = new RegExp(dateValuePattern(), 'gi');
  for (const match of normalized.matchAll(allDatePattern)) {
    allDates.push(parseDateFragment(match[0]));
  }

  const result = {
    effectiveDate,
    startDate,
    commencementDate,
    signedDate,
    expiryDate,
    endDate,
    terminationDate,
    renewalDate,
    allDates: unique(allDates).sort(),
  };

  for (const [key, value] of Object.entries(result)) {
    if (key !== 'allDates' && value) fieldsFound.push(key);
  }

  if (/initial\s+term|agreement\s+period|\bterm\b/i.test(normalized) && !expiryDate && !endDate) {
    warnings.push('Term language detected, but no reliable expiry date could be calculated.');
  }

  return { ...result, fieldsFound, warnings };
}

function parseMoneyNumber(rawNumber, unit) {
  const compact = String(rawNumber || '').replace(/\s+/g, '').replace(/,/g, '');
  const number = Number(compact);
  if (!Number.isFinite(number)) return null;
  if (/million/i.test(unit || '')) return Math.round(number * 1000000);
  return Math.round(number);
}

function displayZar(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  const digits = String(Math.round(Number(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `R ${grouped}`;
}

function labelScoreForContext(context) {
  for (const label of MONEY_LABELS) {
    if (label.pattern.test(context)) return label;
  }
  return null;
}

function extractContractValue(text) {
  const normalized = normalizeText(text);
  const warnings = [];
  const fieldsFound = [];
  const candidates = [];
  const moneyPattern = /\b(?:(ZAR|R)\s*)?(\d[\d\s,]*(?:\.\d+)?)\s*(million)?\s*(?:rand)?\b/gi;

  for (const match of normalized.matchAll(moneyPattern)) {
    const currencyToken = match[1];
    const unit = match[3];
    const before = normalized.slice(Math.max(0, match.index - 100), match.index);
    const after = normalized.slice(match.index, Math.min(normalized.length, match.index + 80));
    const context = `${before}${after}`;

    if (!currencyToken && !/rand|zar/i.test(context)) continue;
    if (/%|interest|vat|penalt|invoice|threshold/i.test(context) && !/contract\s+value|loan\s+amount|funding\s+amount|facility\s+amount/i.test(context)) {
      continue;
    }

    const value = parseMoneyNumber(match[2], unit);
    if (!value || value <= 0) continue;

    const label = labelScoreForContext(context);
    candidates.push({
      value,
      currency: 'ZAR',
      displayValue: displayZar(value),
      score: label?.score || 20,
      labelKey: label?.key || 'unlabelled_amount',
      context: context.replace(/\s+/g, ' ').trim().slice(0, 180),
    });
  }

  if (candidates.length === 0) {
    return {
      contractValue: null,
      currency: null,
      contractValueDisplay: null,
      fieldsFound,
      warnings,
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  const topScore = candidates[0].score;
  const topCandidates = candidates.filter((candidate) => candidate.score === topScore);
  const topValues = unique(topCandidates.map((candidate) => String(candidate.value)));

  if (topValues.length > 1) {
    return {
      contractValue: null,
      currency: null,
      contractValueDisplay: null,
      fieldsFound,
      warnings: ['Multiple amounts detected; contract value requires review.'],
      candidates: candidates.slice(0, 5),
    };
  }

  const selected = candidates[0];
  fieldsFound.push('contractValue');
  return {
    contractValue: selected.value,
    currency: selected.currency,
    contractValueDisplay: selected.displayValue,
    fieldsFound,
    warnings,
    candidates: candidates.slice(0, 5),
  };
}

function deriveContractStatus(metadata = {}, options = {}) {
  if (metadata.terminationDate || metadata.terminated || metadata.cancelled || metadata.canceled) {
    return CONTRACT_STATUS.TERMINATED;
  }

  const endDate = metadata.expiryDate || metadata.expirationDate || metadata.endDate || null;
  if (!endDate) return CONTRACT_STATUS.UNKNOWN;

  const todayInput = options.today || new Date();
  const today = new Date(`${typeof todayInput === 'string' ? todayInput.slice(0, 10) : todayInput.toISOString().slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(endDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return CONTRACT_STATUS.UNKNOWN;

  const days = Math.ceil((end.getTime() - today.getTime()) / 86400000);
  if (days < 0) return CONTRACT_STATUS.EXPIRED;
  if (days <= 30) return CONTRACT_STATUS.EXPIRING_SOON;
  return CONTRACT_STATUS.ACTIVE;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.UNKNOWN;
}

function extractCounterparty(text) {
  const normalized = normalizeText(text).slice(0, 5000);
  const match = normalized.match(/\bbetween\s+(.{3,220}?)\s+\band\s+(.{3,220}?)(?:\n|,|\(|\bwhereas\b|\brecitals\b)/i);
  if (!match) return null;
  const candidate = match[2]
    .replace(/\b(registration|company|number|no\.?).*$/i, '')
    .replace(/[(){}[\]"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return candidate.length >= 3 ? candidate : null;
}

function inferAgreementFamilyFromText(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(addendum|amendment)\b/.test(lower)) return 'ADDENDUM';
  if (/\bassistance agreement\b/.test(lower)) return 'ASSISTANCE_AGREEMENT';
  if (/\bconsult/.test(lower)) return 'CONSULTANCY_AGREEMENT';
  if (/\bfunding loan\b|\bloan agreement\b|\bloan amount\b/.test(lower)) return 'FUNDING_LOAN_AGREEMENT';
  if (/\bmaster service\b|\bmsa\b/.test(lower)) return 'MASTER_SERVICE_AGREEMENT';
  if (/\bservice agreement\b|\bservice fees?\b/.test(lower)) return 'ONCE_OFF_SERVICE_AGREEMENT';
  if (/\bnon[- ]disclosure\b|\bnda\b/.test(lower)) return 'NDA';
  if (/\bstatement of work\b|\bsow\b/.test(lower)) return 'SOW';
  if (/\bdata processing\b|\bdpa\b/.test(lower)) return 'DPA';
  if (/\blease\b/.test(lower)) return 'LEASE_AGREEMENT';
  if (/\bagreement\b|\bcontract\b/.test(lower)) return 'GENERAL_CONTRACT';
  return null;
}

async function extractDocxText(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const partNames = new Set(TEXT_PARTS);
  Object.keys(zip.files).forEach((name) => {
    if (/^word\/header\d+\.xml$/i.test(name) || /^word\/footer\d+\.xml$/i.test(name)) {
      partNames.add(name);
    }
  });

  const chunks = [];
  for (const partName of partNames) {
    const part = zip.file(partName);
    if (!part) continue;
    const xml = await part.async('string');
    chunks.push(xmlToText(xml));
  }
  return normalizeText(chunks.join('\n'));
}

function decodePdfLiteral(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function extractPdfText(buffer) {
  const raw = Buffer.from(buffer).toString('latin1');
  const chunks = [];
  for (const match of raw.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g)) {
    chunks.push(decodePdfLiteral(match[1]));
  }
  for (const match of raw.matchAll(/\[((?:\s*\([^()]*(?:\\.[^()]*)*\)\s*-?\d*)+)\]\s*TJ/g)) {
    for (const inner of match[1].matchAll(/\(([^()]*(?:\\.[^()]*)*)\)/g)) {
      chunks.push(decodePdfLiteral(inner[1]));
    }
  }
  return normalizeText(chunks.join(' '));
}

async function extractTextFromFile(absolutePath, options = {}) {
  const fsModule = options.fsModule || require('fs');
  const pathModule = options.pathModule || path;
  const extension = pathModule.extname(absolutePath).toLowerCase();
  const buffer = await fsModule.promises.readFile(absolutePath);

  if (extension === '.docx' || extension === '.dotx') return extractDocxText(buffer);
  if (extension === '.txt' || extension === '.md') return normalizeText(buffer.toString('utf8'));
  if (extension === '.pdf') return extractPdfText(buffer);
  return '';
}

function extractContractMetadataFromText(text, options = {}) {
  const warnings = [];
  const normalized = normalizeText(text).slice(0, 100000);
  const dateResult = extractDates(normalized);
  const valueResult = extractContractValue(normalized);
  warnings.push(...dateResult.warnings, ...valueResult.warnings);

  const metadata = {
    contractValue: valueResult.contractValue,
    contractValueDisplay: valueResult.contractValueDisplay,
    currency: valueResult.currency,
    effectiveDate: dateResult.effectiveDate,
    startDate: dateResult.startDate,
    commencementDate: dateResult.commencementDate,
    expiryDate: dateResult.expiryDate,
    endDate: dateResult.expiryDate || dateResult.endDate || dateResult.terminationDate || null,
    terminationDate: dateResult.terminationDate,
    renewalDate: dateResult.renewalDate,
    signedDate: dateResult.signedDate,
    counterparty: extractCounterparty(normalized),
    agreementFamily: inferAgreementFamilyFromText(normalized),
  };

  const contractStatus = deriveContractStatus(metadata, options);
  const fieldsFound = unique([
    ...dateResult.fieldsFound,
    ...valueResult.fieldsFound,
    metadata.counterparty ? 'counterparty' : null,
    metadata.agreementFamily ? 'agreementFamily' : null,
    'contractStatus',
  ]);

  const confidence = fieldsFound.length >= 4
    ? 'high'
    : fieldsFound.length >= 2
      ? 'medium'
      : 'low';

  return {
    ...metadata,
    contractStatus,
    contractStatusLabel: statusLabel(contractStatus),
    extraction: {
      extractedAt: new Date().toISOString(),
      confidence,
      warnings,
      fieldsFound,
    },
  };
}

async function extractContractMetadataFromFile(absolutePath, options = {}) {
  const extension = (options.pathModule || path).extname(absolutePath).toLowerCase();
  try {
    const text = await extractTextFromFile(absolutePath, options);
    if (!text) {
      return {
        contractStatus: CONTRACT_STATUS.UNKNOWN,
        contractStatusLabel: STATUS_LABELS.UNKNOWN,
        contractValue: null,
        contractValueDisplay: null,
        currency: null,
        effectiveDate: null,
        startDate: null,
        commencementDate: null,
        expiryDate: null,
        endDate: null,
        terminationDate: null,
        renewalDate: null,
        signedDate: null,
        counterparty: null,
        agreementFamily: null,
        extraction: {
          extractedAt: new Date().toISOString(),
          confidence: 'low',
          warnings: [`Could not extract text from ${extension || 'file'} document.`],
          fieldsFound: ['contractStatus'],
        },
      };
    }
    return extractContractMetadataFromText(text, options);
  } catch (err) {
    return {
      contractStatus: CONTRACT_STATUS.UNKNOWN,
      contractStatusLabel: STATUS_LABELS.UNKNOWN,
      contractValue: null,
      contractValueDisplay: null,
      currency: null,
      effectiveDate: null,
      startDate: null,
      commencementDate: null,
      expiryDate: null,
      endDate: null,
      terminationDate: null,
      renewalDate: null,
      signedDate: null,
      counterparty: null,
      agreementFamily: null,
      extraction: {
        extractedAt: new Date().toISOString(),
        confidence: 'low',
        warnings: [`Metadata extraction failed: ${err?.message || String(err)}`],
        fieldsFound: ['contractStatus'],
      },
    };
  }
}

module.exports = {
  CONTRACT_STATUS,
  STATUS_LABELS,
  deriveContractStatus,
  displayZar,
  extractContractMetadataFromFile,
  extractContractMetadataFromText,
  extractContractValue,
  extractDates,
  extractDocxText,
  extractPdfText,
  parseDateFragment,
  statusLabel,
};
