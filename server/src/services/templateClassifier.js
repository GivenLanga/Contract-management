'use strict';

// Folder names that identify a directory as a template source
const TEMPLATE_FOLDER_NAMES = new Set([
  'templates',
  'template',
  'legal templates',
  'contract templates',
  'standard templates',
  'approved templates',
  'precedents',
  'boilerplates',
  'forms',
]);

// Agreement family definitions: terms matched against lowercased filename + source path.
// weight: base score multiplier. Terms matched in the filename are scored 2×.
const FAMILY_RULES = [
  { family: 'FUNDING_LOAN_AGREEMENT', terms: ['funding loan agreement', 'funding loan'], category: 'Loans', weight: 4 },
  { family: 'BRIDGING_FINANCE_AGREEMENT', terms: ['bridging finance', 'bridging loan'], category: 'Finance', weight: 4 },
  { family: 'LOAN_AGREEMENT', terms: ['loan agreement', 'loan'], category: 'Loans', weight: 2 },
  { family: 'GRANT_AGREEMENT', terms: ['grant agreement', 'grant'], category: 'Grants', weight: 3 },
  { family: 'ASSISTANCE_AGREEMENT', terms: ['assistance agreement', 'assistance'], category: 'Grants', weight: 3 },
  { family: 'MASTER_SERVICE_AGREEMENT', terms: ['master services agreement', 'master service agreement', 'msa'], category: 'Services', weight: 4 },
  { family: 'ONCE_OFF_SERVICE_AGREEMENT', terms: ['once-off service agreement', 'once off service agreement', 'once-off service'], category: 'Services', weight: 4 },
  { family: 'SERVICE_PROVIDER_AGREEMENT', terms: ['service provider agreement', 'service agreement', 'services agreement'], category: 'Services', weight: 2 },
  { family: 'CONSULTANCY_AGREEMENT', terms: ['consultancy agreement', 'consultancy', 'consulting agreement', 'consultant agreement'], category: 'Consultancy', weight: 3 },
  { family: 'SLA', terms: ['service level agreement', ' sla '], category: 'Services', weight: 3 },
  { family: 'VENDOR_AGREEMENT', terms: ['vendor supply agreement', 'vendor agreement', 'vendor supply', 'supplier agreement'], category: 'Procurement', weight: 3 },
  { family: 'LEASE_ADDENDUM', terms: ['lease addendum'], category: 'Property', weight: 4 },
  { family: 'LEASE_AGREEMENT', terms: ['lease agreement', 'lease'], category: 'Property', weight: 2 },
  { family: 'ADDENDUM', terms: ['addendum'], category: 'Addenda', weight: 2 },
  { family: 'AMENDMENT_AGREEMENT', terms: ['amendment agreement', 'amendment'], category: 'Amendments', weight: 2 },
  { family: 'NDA', terms: ['non-disclosure agreement', 'non disclosure agreement', 'mutual nda', 'nda'], category: 'Confidentiality', weight: 3 },
  { family: 'CONFIDENTIALITY_AGREEMENT', terms: ['confidentiality agreement', 'confidentiality'], category: 'Confidentiality', weight: 2 },
  { family: 'MOU', terms: ['memorandum of understanding', ' mou '], category: 'Agreements', weight: 4 },
  { family: 'MOA', terms: ['memorandum of agreement', ' moa '], category: 'Agreements', weight: 4 },
  { family: 'EMPLOYMENT_AGREEMENT', terms: ['employment agreement', 'employment contract', 'employment'], category: 'HR', weight: 2 },
  { family: 'RENEWAL_LETTER', terms: ['renewal letter', 'renewal notice'], category: 'Renewals', weight: 3 },
  { family: 'TERMINATION_NOTICE', terms: ['termination notice', 'termination letter', 'termination'], category: 'Terminations', weight: 2 },
  { family: 'BOARD_RESOLUTION', terms: ['board resolution'], category: 'Corporate', weight: 3 },
  { family: 'POPIA_CLAUSE', terms: ['popia', 'protection of personal information'], category: 'Compliance', weight: 4 },
  { family: 'FICA_COMPLIANCE', terms: ['fica compliance', 'fica', 'financial intelligence centre'], category: 'Compliance', weight: 4 },
  { family: 'GENERAL_CONTRACT', terms: ['general contract', 'general agreement'], category: 'General', weight: 1 },
];

// Patterns for version and date extraction
const VERSION_RE = /\(v(\d+(?:\.\d+)*)\)/i;
const BRACKET_DATE_RE = /\[(\d{6,8})\]/g;
// Strip the word "template" when it's a standalone word (for title cleanup)
const TEMPLATE_WORD_RE = /\s*\btemplate\b\s*/gi;

const SUPPORTED_EXTENSIONS = new Set(['docx', 'dotx', 'doc', 'pdf', 'txt', 'md']);
const SKIP_PATTERN = /^(~\$|\.)/;

/**
 * Produces a clean display title from an original filename.
 *
 * - Removes file extension
 * - Extracts and returns version string (e.g. "v2") separately
 * - Strips bracket date noise ([20022023])
 * - Removes the word "Template" as a standalone word
 * - Preserves meaningful suffixes: "Juristic Entities", "Individuals", numbering
 *
 * @param {string} originalFileName
 * @returns {{ title: string, version: string|null }}
 */
function cleanTitle(originalFileName) {
  // Strip extension
  let title = String(originalFileName || '').replace(/\.[^.]+$/, '');

  // Extract version before removing
  const versionMatch = title.match(VERSION_RE);
  const version = versionMatch ? `v${versionMatch[1]}` : null;

  title = title
    .replace(VERSION_RE, '')        // remove (v2)
    .replace(BRACKET_DATE_RE, '')   // remove [20022023]
    .replace(TEMPLATE_WORD_RE, ' ') // remove standalone "Template"
    .replace(/\s*-\s*/g, ' - ')     // normalise dashes
    .replace(/\s{2,}/g, ' ')        // collapse spaces
    .replace(/^[\s-]+|[\s-]+$/g, '') // trim leading/trailing
    .trim();

  if (!title) {
    title = String(originalFileName || '').replace(/\.[^.]+$/, '');
  }

  return { title, version };
}

/**
 * Classifies a template by filename and source path using deterministic keyword rules.
 *
 * @param {string} originalFileName
 * @param {string} [sourcePath]
 * @returns {{ agreementFamily: string, category: string, confidence: 'high'|'medium'|'low', signals: string[], requiresReview: boolean }}
 */
function classify(originalFileName, sourcePath = '') {
  const name = String(originalFileName || '');
  const nameLower = name.toLowerCase().replace(/\.[^.]+$/, '');
  const pathLower = String(sourcePath || '').toLowerCase();

  let bestFamily = null;
  let bestScore = 0;
  const signals = [];

  for (const rule of FAMILY_RULES) {
    for (const term of rule.terms) {
      const inName = nameLower.includes(term);
      const inPath = pathLower.includes(term);

      if (!inName && !inPath) continue;

      // Name match scores double
      const score = rule.weight * (inName ? 2 : 1);

      if (score > bestScore) {
        bestScore = score;
        bestFamily = rule.family;
      }

      const signal = `keyword:${term}`;
      if (!signals.includes(signal)) signals.push(signal);
    }
  }

  if (!bestFamily) {
    bestFamily = 'OTHER';
    signals.push('no-keyword-match');
  }

  let confidence;
  if (bestScore >= 8) confidence = 'high';
  else if (bestScore >= 4) confidence = 'medium';
  else confidence = 'low';

  const rule = FAMILY_RULES.find((r) => r.family === bestFamily);
  const category = rule ? rule.category : 'General';
  const requiresReview = confidence === 'low' || bestFamily === 'OTHER';

  return { agreementFamily: bestFamily, category, confidence, signals, requiresReview };
}

/**
 * Returns true if the given source path contains a recognised template folder name.
 *
 * @param {string} sourcePath
 * @returns {boolean}
 */
function isTemplatePath(sourcePath) {
  if (!sourcePath) return false;
  const parts = String(sourcePath)
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.some((part) => TEMPLATE_FOLDER_NAMES.has(part));
}

/**
 * Returns true if the file should be ignored (temp Word lock files, hidden files).
 *
 * @param {string} fileName
 * @returns {boolean}
 */
function shouldSkip(fileName) {
  return SKIP_PATTERN.test(String(fileName || ''));
}

/**
 * Returns true if the file extension is supported for templates.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
function isSupportedExtension(fileName) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  return Boolean(ext && SUPPORTED_EXTENSIONS.has(ext));
}

/**
 * Returns the normalised extension for a file.
 *
 * @param {string} fileName
 * @returns {string}
 */
function getExtension(fileName) {
  return String(fileName || '').split('.').pop()?.toLowerCase() || 'docx';
}

/**
 * Builds a concise tag array from classification results and title.
 *
 * @param {string} title
 * @param {{ agreementFamily: string, category: string }} classification
 * @returns {string[]}
 */
function buildTags(title, classification) {
  const tags = [];
  if (classification.category && classification.category !== 'General') {
    tags.push(classification.category);
  }
  if (classification.agreementFamily && classification.agreementFamily !== 'OTHER') {
    const readable = classification.agreementFamily
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    tags.push(readable);
  }
  return [...new Set(tags)];
}

/**
 * Derives a safe display source label (not the real filesystem path).
 * E.g. "Templates / Loans" instead of "/home/user/..."
 *
 * @param {string} sourcePath
 * @returns {string}
 */
function displaySourceLabel(sourcePath) {
  if (!sourcePath) return 'Templates';
  const parts = String(sourcePath)
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  // Return the last 2 meaningful segments
  const meaningful = parts.slice(-2);
  return meaningful.join(' / ') || 'Templates';
}

module.exports = {
  classify,
  cleanTitle,
  buildTags,
  displaySourceLabel,
  isTemplatePath,
  shouldSkip,
  isSupportedExtension,
  getExtension,
  TEMPLATE_FOLDER_NAMES,
  SUPPORTED_EXTENSIONS,
};
