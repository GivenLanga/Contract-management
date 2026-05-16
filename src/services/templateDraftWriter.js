// Client-side DOCX draft creator.
// Loads the original DOCX Blob, replaces detected placeholders with user-supplied
// values, and returns a new DOCX Blob. Uses JSZip for ZIP assembly.
//
// Replacement strategy:
//   1. Simple replaceAll on the raw XML — reliable when a placeholder is a single
//      contiguous OOXML text node.
//   2. Tracks which placeholders were replaced vs. unresolved (split across runs).
//   3. Never corrupts the ZIP — original files pass through unchanged.

import JSZip from 'jszip';

// ── XML helpers ───────────────────────────────────────────────────────────────

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Replace all occurrences of `from` (raw and XML-escaped forms) with `to`
 * (XML-escaped) inside an XML string.
 * Returns { xml, replaced: boolean }.
 */
function replaceInXml(xml, from, to) {
  const safeValue = escapeXml(String(to || ''));
  const escapedFrom = escapeXml(from);
  let result = xml;
  let replaced = false;

  if (result.includes(escapedFrom)) {
    result = result.split(escapedFrom).join(safeValue);
    replaced = true;
  }
  if (result.includes(from)) {
    result = result.split(from).join(safeValue);
    replaced = true;
  }
  return { xml: result, replaced };
}

// ── Core replacement ──────────────────────────────────────────────────────────

/**
 * Apply the user-supplied values map to an XML string.
 * `values` is { key: value } where key can be:
 *   - raw placeholder text like "COMPANY NAME"  → matches [COMPANY NAME] and {{COMPANY NAME}}
 *   - or the full raw form like "[COMPANY NAME]" or "{{CompanyName}}"
 *
 * Returns { xml, resolved: string[], unresolved: string[] }.
 */
function applyValuesToXml(xml, values) {
  let current = xml;
  const resolved = [];
  const unresolved = [];

  for (const [key, value] of Object.entries(values)) {
    if (!value && value !== 0) continue; // skip empty values

    const rawKey = String(key).trim();

    // Determine what patterns to try replacing
    const forms = new Set([
      rawKey,                                   // raw key as-is
      `[${rawKey}]`,                            // [KEY]
      `{{${rawKey}}}`,                          // {{KEY}}
    ]);

    // Also try title-cased / lower variants
    const lower = rawKey.toLowerCase();
    const upper = rawKey.toUpperCase();
    forms.add(`[${lower}]`);
    forms.add(`[${upper}]`);
    forms.add(`{{${lower}}}`);
    forms.add(`{{${upper}}}`);

    let anyReplaced = false;
    for (const form of forms) {
      const { xml: next, replaced } = replaceInXml(current, form, value);
      if (replaced) {
        current = next;
        anyReplaced = true;
      }
    }

    if (anyReplaced) {
      resolved.push(rawKey);
    } else {
      unresolved.push(rawKey);
    }
  }

  return { xml: current, resolved, unresolved };
}

// ── Public API ────────────────────────────────────────────────────────────────

const REPLACEABLE_PARTS = [
  'word/document.xml',
  'word/header1.xml',
  'word/header2.xml',
  'word/header3.xml',
  'word/footer1.xml',
  'word/footer2.xml',
  'word/footer3.xml',
];

/**
 * Creates a new draft DOCX Blob from the original template Blob by replacing
 * placeholder values.
 *
 * @param {Blob} templateBlob  — the original DOCX from the Legal Folder cache
 * @param {Record<string, string>} values  — placeholder key → replacement value
 * @returns {Promise<{ blob: Blob, resolved: string[], unresolved: string[], warnings: string[] }>}
 */
export async function createDraftDocx(templateBlob, values = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(templateBlob);
  } catch (err) {
    throw new Error(`Could not read template file as a DOCX: ${err.message}`);
  }

  const allResolved = [];
  const allUnresolved = [];
  const warnings = [];

  for (const part of REPLACEABLE_PARTS) {
    const file = zip.file(part);
    if (!file) continue;

    try {
      const originalXml = await file.async('string');
      const { xml: modifiedXml, resolved, unresolved } = applyValuesToXml(originalXml, values);

      zip.file(part, modifiedXml);
      allResolved.push(...resolved.filter((k) => !allResolved.includes(k)));
      // Only add to unresolved if not resolved in any other part
      for (const k of unresolved) {
        if (!allResolved.includes(k) && !allUnresolved.includes(k)) {
          allUnresolved.push(k);
        }
      }
    } catch (err) {
      warnings.push(`Could not process ${part}: ${err.message}`);
    }
  }

  if (allUnresolved.length > 0) {
    warnings.push(
      `${allUnresolved.length} placeholder(s) were not replaced (may be split across formatting runs): ` +
      allUnresolved.join(', ')
    );
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { blob, resolved: allResolved, unresolved: allUnresolved, warnings };
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
