// Client-side DOCX draft creator.
// Loads the original DOCX Blob, replaces placeholders inside OOXML text nodes,
// and returns a new DOCX Blob. The Legal Folder remains the source of truth.

import JSZip from 'jszip';
import {
  generateBarePlaceholderAliases,
  generatePlaceholderAliases,
  getRelatedPlaceholderKeys,
  humanizePlaceholderLabel,
  normalizePlaceholderKey,
  xmlDecodeText,
  xmlEscapeText,
} from './templatePlaceholderUtils';

const REQUIRED_DOCX_FILES = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];

const PRIORITY_PARTS = [
  'word/document.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml',
];

const RESERVED_INPUT_KEYS = new Set([
  'fields',
  'placeholderValues',
  'detectedPlaceholders',
  'agreementFamily',
]);

function isNonEmptyValue(value) {
  return value !== undefined && value !== null && String(value) !== '';
}

function normalizeFieldKey(key) {
  return normalizePlaceholderKey(key);
}

function makeContext(input = {}) {
  const structured = input && typeof input === 'object' ? input : {};
  const valueByKey = new Map();
  const sourceByKey = new Map();
  const explicitBareKeys = new Set();
  const safeBareKeys = new Set();
  const detectedPlaceholders = Array.isArray(structured.detectedPlaceholders)
    ? structured.detectedPlaceholders
    : [];
  const warnings = [];

  function setValue(key, value, source, priority, { explicitBare = false } = {}) {
    if (!isNonEmptyValue(value)) return;
    const normalized = normalizePlaceholderKey(key);
    if (!normalized) return;

    const existing = valueByKey.get(normalized);
    const existingSource = sourceByKey.get(normalized);
    if (existing !== undefined && String(existing) !== String(value)) {
      warnings.push({
        code: 'ambiguousAlias',
        key: normalized,
        keptSource: existingSource?.source,
        ignoredSource: source,
      });
      if ((existingSource?.priority || 0) > priority) return;
    }

    valueByKey.set(normalized, value);
    sourceByKey.set(normalized, { source, priority });
    if (explicitBare) explicitBareKeys.add(normalized);
  }

  function setValueWithAliases(key, value, source, priority, options) {
    for (const related of getRelatedPlaceholderKeys(key)) {
      setValue(related, value, source, priority, options);
    }
  }

  for (const placeholder of detectedPlaceholders) {
    const raw = placeholder?.raw || placeholder?.key || placeholder?.label;
    const normalized = normalizePlaceholderKey(raw);
    if (!normalized) continue;
    if (placeholder?.type === 'plain' || (raw && !String(raw).startsWith('[') && !String(raw).startsWith('{{'))) {
      safeBareKeys.add(normalized);
    }
  }

  const fieldValues = structured.fields || {};
  for (const [key, value] of Object.entries(fieldValues)) {
    setValueWithAliases(normalizeFieldKey(key), value, 'field', 2);
  }

  const placeholderValues = structured.placeholderValues || {};
  for (const [key, value] of Object.entries(placeholderValues)) {
    setValueWithAliases(key, value, 'placeholderValue', 3, { explicitBare: true });
  }

  for (const [key, value] of Object.entries(structured)) {
    if (RESERVED_INPUT_KEYS.has(key)) continue;
    if (value && typeof value === 'object') continue;
    setValueWithAliases(key, value, 'legacyValue', 1, { explicitBare: true });
  }

  return {
    valueByKey,
    explicitBareKeys,
    safeBareKeys,
    detectedPlaceholders,
    warnings,
  };
}

function valueForKey(context, key) {
  for (const related of getRelatedPlaceholderKeys(key)) {
    if (context.valueByKey.has(related)) return context.valueByKey.get(related);
  }
  return undefined;
}

function getTextNodes(xml) {
  const nodes = [];
  const textRe = /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g;
  for (const match of xml.matchAll(textRe)) {
    const contentStart = match.index + match[1].length;
    const contentEnd = contentStart + match[2].length;
    nodes.push({
      contentStart,
      contentEnd,
      text: xmlDecodeText(match[2]),
    });
  }
  return nodes;
}

function buildFlatText(nodes) {
  const charMap = [];
  let flatText = '';

  nodes.forEach((node, nodeIndex) => {
    for (let offset = 0; offset < node.text.length; offset++) {
      charMap.push({ nodeIndex, offset });
    }
    flatText += node.text;
  });

  return { flatText, charMap };
}

function shouldUseBareAlias(context, key) {
  const normalized = normalizePlaceholderKey(key);
  return (
    context.explicitBareKeys.has(normalized) ||
    context.safeBareKeys.has(normalized)
  );
}

function buildCandidates(context) {
  const candidates = [];

  for (const [key, value] of context.valueByKey.entries()) {
    for (const alias of generatePlaceholderAliases(key)) {
      const isWrapped = alias.startsWith('[') || alias.startsWith('{{');
      const isToken = /[_.]/.test(alias);
      const isBareWord = !isWrapped && !isToken;
      if (isBareWord && !shouldUseBareAlias(context, key)) continue;

      candidates.push({
        alias,
        normalizedKey: key,
        value,
        kind: isWrapped ? 'wrapped' : isToken ? 'token' : 'bare',
        caseSensitive: isBareWord,
      });
    }

    if (shouldUseBareAlias(context, key)) {
      for (const alias of generateBarePlaceholderAliases(key)) {
        candidates.push({
          alias,
          normalizedKey: key,
          value,
          kind: /_/.test(alias) ? 'token' : 'bare',
          caseSensitive: true,
        });
      }
    }
  }

  for (const placeholder of context.detectedPlaceholders) {
    const raw = placeholder?.raw;
    const normalizedKey = normalizePlaceholderKey(raw || placeholder?.key || '');
    const value = valueForKey(context, normalizedKey);
    if (!raw || !isNonEmptyValue(value)) continue;
    candidates.push({
      alias: raw,
      normalizedKey,
      value,
      kind: raw.startsWith('[') || raw.startsWith('{{') ? 'wrapped' : 'bare',
      caseSensitive: false,
    });
  }

  const seen = new Set();
  return candidates
    .filter((candidate) => candidate.alias)
    .filter((candidate) => {
      const id = `${candidate.alias}\u0000${candidate.normalizedKey}\u0000${candidate.value}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => b.alias.length - a.alias.length);
}

function isTokenBoundary(char) {
  return !char || !/[A-Za-z0-9_.]/.test(char);
}

function isWordBoundary(char) {
  return !char || !/[A-Za-z0-9]/.test(char);
}

function hasSafeBoundaries(flatText, start, end, candidate) {
  if (candidate.kind === 'wrapped') return true;
  const before = flatText[start - 1] || '';
  const after = flatText[end] || '';
  if (candidate.kind === 'token') return isTokenBoundary(before) && isTokenBoundary(after);
  return isWordBoundary(before) && isWordBoundary(after);
}

function collectMatches(flatText, candidates) {
  const matches = [];
  const lowerFlat = flatText.toLowerCase();

  for (const candidate of candidates) {
    const haystack = candidate.caseSensitive ? flatText : lowerFlat;
    const needle = candidate.caseSensitive ? candidate.alias : candidate.alias.toLowerCase();
    let cursor = 0;

    while (needle) {
      const start = haystack.indexOf(needle, cursor);
      if (start === -1) break;
      const end = start + needle.length;
      if (hasSafeBoundaries(flatText, start, end, candidate)) {
        matches.push({
          ...candidate,
          start,
          end,
          placeholder: flatText.slice(start, end),
        });
      }
      cursor = start + Math.max(needle.length, 1);
    }
  }

  const selected = [];
  const occupied = new Set();
  matches
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
    .forEach((match) => {
      for (let i = match.start; i < match.end; i++) {
        if (occupied.has(i)) return;
      }
      for (let i = match.start; i < match.end; i++) occupied.add(i);
      selected.push(match);
    });

  return selected.sort((a, b) => b.start - a.start);
}

function applyMatchesToNodes(xml, nodes, charMap, matches) {
  const texts = nodes.map((node) => node.text);
  const replaced = [];

  for (const match of matches) {
    const startMap = charMap[match.start];
    const endMap = charMap[match.end - 1];
    if (!startMap || !endMap) continue;

    const replacement = String(match.value);
    if (startMap.nodeIndex === endMap.nodeIndex) {
      const text = texts[startMap.nodeIndex];
      texts[startMap.nodeIndex] =
        text.slice(0, startMap.offset) +
        replacement +
        text.slice(endMap.offset + 1);
    } else {
      const firstText = texts[startMap.nodeIndex];
      const lastText = texts[endMap.nodeIndex];
      texts[startMap.nodeIndex] = firstText.slice(0, startMap.offset) + replacement;
      for (let i = startMap.nodeIndex + 1; i < endMap.nodeIndex; i++) {
        texts[i] = '';
      }
      texts[endMap.nodeIndex] = lastText.slice(endMap.offset + 1);
    }

    replaced.push({
      placeholder: match.placeholder,
      normalizedKey: match.normalizedKey,
      value: replacement,
      occurrences: 1,
    });
  }

  let modifiedXml = xml;
  for (let i = nodes.length - 1; i >= 0; i--) {
    modifiedXml =
      modifiedXml.slice(0, nodes[i].contentStart) +
      xmlEscapeText(texts[i]) +
      modifiedXml.slice(nodes[i].contentEnd);
  }

  return { xml: modifiedXml, replaced };
}

function pushUniquePlaceholder(map, item) {
  const key = `${item.part}\u0000${item.placeholder}\u0000${item.normalizedKey}`;
  if (!map.has(key)) map.set(key, item);
}

function collectDetectedBareRemainders(flatText, part, context, map) {
  for (const placeholder of context.detectedPlaceholders) {
    if (placeholder?.raw?.startsWith('[') || placeholder?.raw?.startsWith('{{')) continue;
    const raw = placeholder?.raw || placeholder?.key;
    if (!raw) continue;
    const normalizedKey = normalizePlaceholderKey(raw);
    const value = valueForKey(context, normalizedKey);
    if (isNonEmptyValue(value)) continue;
    for (const alias of generateBarePlaceholderAliases(raw)) {
      const start = flatText.indexOf(alias);
      if (start !== -1 && hasSafeBoundaries(flatText, start, start + alias.length, { kind: 'bare' })) {
        pushUniquePlaceholder(map, {
          placeholder: alias,
          normalizedKey,
          part,
          reason: 'noValueProvided',
        });
      }
    }
  }
}

function collectUnresolvedPlaceholders(xml, part, context) {
  const nodes = getTextNodes(xml);
  const { flatText } = buildFlatText(nodes);
  const unresolved = new Map();
  const patterns = [
    /\[[A-Za-z][^[\]\n]{0,120}\]/g,
    /\{\{[A-Za-z][^{}\n]{0,120}\}\}/g,
    /\b[A-Z][A-Z0-9]*(?:[._]+[A-Z0-9]+)+\.?\b/g,
    /\bX{4,}\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of flatText.matchAll(pattern)) {
      const placeholder = match[0];
      const normalizedKey = normalizePlaceholderKey(placeholder);
      const hasValue = isNonEmptyValue(valueForKey(context, normalizedKey));
      pushUniquePlaceholder(unresolved, {
        placeholder,
        normalizedKey,
        part,
        reason: hasValue ? 'replacementSkippedForSafety' : 'noValueProvided',
      });
    }
  }

  collectDetectedBareRemainders(flatText, part, context, unresolved);
  return Array.from(unresolved.values());
}

function aggregateReplaced(replaced, part) {
  const grouped = new Map();
  for (const item of replaced) {
    const key = `${part}\u0000${item.placeholder}\u0000${item.normalizedKey}\u0000${item.value}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      grouped.set(key, { ...item, part });
    }
  }
  return Array.from(grouped.values());
}

function parseXmlIsValid(xml) {
  if (typeof DOMParser === 'undefined') return true;
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  return parsed.getElementsByTagName('parsererror').length === 0;
}

export function replacePlaceholdersInXml(xml, input = {}, { part = 'word/document.xml' } = {}) {
  const context = input.valueByKey instanceof Map ? input : makeContext(input);
  if (!parseXmlIsValid(xml)) {
    return {
      xml,
      replaced: [],
      unresolved: [],
      warnings: [`Could not process ${part}: invalid XML part.`],
    };
  }

  const nodes = getTextNodes(xml);
  if (nodes.length === 0) {
    return { xml, replaced: [], unresolved: [], warnings: [] };
  }

  const { flatText, charMap } = buildFlatText(nodes);
  const matches = collectMatches(flatText, buildCandidates(context));
  const applied = applyMatchesToNodes(xml, nodes, charMap, matches);
  const modifiedXml = applied.xml;

  if (!parseXmlIsValid(modifiedXml)) {
    return {
      xml,
      replaced: [],
      unresolved: collectUnresolvedPlaceholders(xml, part, context),
      warnings: [`Could not process ${part}: replacement would produce invalid XML.`],
    };
  }

  return {
    xml: modifiedXml,
    replaced: aggregateReplaced(applied.replaced, part),
    unresolved: collectUnresolvedPlaceholders(modifiedXml, part, context),
    warnings: [],
  };
}

function sortDocxParts(parts) {
  const priority = new Map(PRIORITY_PARTS.map((part, index) => [part, index]));
  return parts.sort((a, b) => {
    const nameA = typeof a === 'string' ? a : a.name;
    const nameB = typeof b === 'string' ? b : b.name;
    const ap = priority.has(nameA) ? priority.get(nameA) : 100;
    const bp = priority.has(nameB) ? priority.get(nameB) : 100;
    return ap - bp || nameA.localeCompare(nameB);
  });
}

async function getReplaceableParts(zip) {
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .filter((name) => name.startsWith('word/') && name.endsWith('.xml'));
  const parts = [];

  for (const name of names) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    if (/<w:t\b/.test(xml)) parts.push({ name, xml });
  }

  return sortDocxParts(parts);
}

function buildWarnings(report, processingWarnings) {
  const warnings = [...processingWarnings];
  if (report.unresolved.length > 0) {
    warnings.push(`${report.unresolved.length} placeholder(s) still need manual review.`);
  }
  return warnings;
}

function validateZipStructure(zip) {
  const missing = REQUIRED_DOCX_FILES.filter((name) => !zip.file(name));
  return missing.map((name) => `Generated DOCX is missing required file: ${name}`);
}

async function validateGeneratedDocx(blob) {
  try {
    const zip = await JSZip.loadAsync(blob);
    return validateZipStructure(zip);
  } catch (err) {
    return [`Generated DOCX could not be re-read: ${err.message}`];
  }
}

function dedupeUnresolved(unresolved) {
  const map = new Map();
  for (const item of unresolved) {
    const key = `${item.part}\u0000${item.placeholder}\u0000${item.normalizedKey}`;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

/**
 * Creates a new draft DOCX Blob from the original template Blob by replacing
 * placeholder values.
 *
 * @param {Blob} templateBlob — the original DOCX from the Legal Folder cache
 * @param {Record<string, string>|{
 *   fields?: Record<string, string>,
 *   placeholderValues?: Record<string, string>,
 *   detectedPlaceholders?: Array<{ key?: string, raw?: string, type?: string }>,
 * }} input
 * @returns {Promise<{
 *   blob: Blob,
 *   resolved: string[],
 *   unresolved: string[],
 *   warnings: string[],
 *   replacementReport: {
 *     replaced: Array<{ placeholder: string, normalizedKey: string, value: string, part: string, occurrences: number }>,
 *     unresolved: Array<{ placeholder: string, normalizedKey: string, part: string, reason: string }>,
 *     warnings: string[],
 *   }
 * }>}
 */
export async function createDraftDocx(templateBlob, input = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(templateBlob);
  } catch (err) {
    throw new Error(`Could not read template file as a DOCX: ${err.message}`, { cause: err });
  }

  const structureWarnings = validateZipStructure(zip);
  const context = makeContext(input);
  const parts = await getReplaceableParts(zip);
  const replaced = [];
  const unresolved = [];
  const processingWarnings = [
    ...structureWarnings,
    ...context.warnings.map((warning) => `Ambiguous placeholder alias: ${warning.key}`),
  ];

  for (const { name, xml } of parts) {
    try {
      const result = replacePlaceholdersInXml(xml, context, { part: name });
      if (result.xml !== xml) zip.file(name, result.xml);
      replaced.push(...result.replaced);
      unresolved.push(...result.unresolved);
      processingWarnings.push(...result.warnings);
    } catch (err) {
      processingWarnings.push(`Could not process ${name}: ${err.message}`);
    }
  }

  const replacementReport = {
    replaced,
    unresolved: dedupeUnresolved(unresolved),
    warnings: processingWarnings,
  };

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const validationWarnings = await validateGeneratedDocx(blob);
  replacementReport.warnings.push(...validationWarnings);

  return {
    blob,
    resolved: Array.from(new Set(replacementReport.replaced.map((item) => item.normalizedKey))),
    unresolved: replacementReport.unresolved.map((item) => item.placeholder),
    warnings: buildWarnings(replacementReport, replacementReport.warnings),
    replacementReport,
  };
}

/**
 * Triggers a browser download of the draft Blob.
 */
export function downloadDraft(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'draft.docx';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

export function formatUnresolvedPlaceholder(item) {
  return humanizePlaceholderLabel(item?.placeholder || item?.normalizedKey || '');
}
