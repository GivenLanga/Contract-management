const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const visionFieldDetection = require('./visionFieldDetectionService');

const IDP_VERSION = '2026.04-idp-v1';
const NORMALIZED_DIR = path.join(__dirname, '../../uploads/normalized');
const ANCHOR_PATTERN = /\{\{([A-Za-z0-9_:-]+)\}\}/g;
const SOURCE_PRIORITY = {
  anchor: 100,
  'yolo-cv': 85,
  textract: 80,
  layoutlmv3: 75,
  'opencv-ocr': 55,
  'heuristic-keyword': 45,
  'heuristic-default': 10,
};

const SIGNATURE_WORDS = /\b(sign|signature|signed by|sign here|authorized signatory)\b/i;
const DATE_WORDS = /\b(date|dated)\b/i;
const INITIAL_WORDS = /\b(initial|initials)\b/i;
const NAME_WORDS = /\b(print name|printed name|name)\b/i;
const CHECKBOX_WORDS = /\b(check\s*box|checkbox|tick\s*box|consent|agree|acknowledge)\b/i;
const RADIO_WORDS = /\b(radio|option)\b/i;
const DROPDOWN_WORDS = /\b(drop\s*down|dropdown|select)\b/i;
const UNDERLINE_RUN_PATTERN = /_{3,}/g;
const EXPLICIT_DATE_WORDS = /\b(date|dated)\b/i;
const SIGNATURE_LINE_WORDS = /\b(sign|signature|sign here|signed by|authorized signatory|authorised signatory|signatory|for and on behalf)\b/i;
const EXECUTION_PLACE_WORDS = /\bsigned\s+at\b/i;
const SIGNED_ON_RE = /\bsigned\s+on\b/i;
const EXEC_BLOCK_HEADER_RE = /^(?:for(?:\s+and\s+on\s+behalf\s+of)?|signed\s+(?:by|for)|executed\s+(?:by|for)|on\s+behalf\s+of)\s*:/i;
const FIELD_LINE_RE = /_{3,}|^(?:signature|date|name|initial|title|designation|designatation|position|capacity|address|witness)\s*:/i;
// Matches any fragment of a "dated at ___ on this ___ day of ___ 20___" clause.
// Each fragment in its own table cell also needs to be detected independently.
const INLINE_DATE_CLAUSE_RE = /\bdated\s+at\b|\bday\s+of\b|\bon\s+this\b/i;
const DAY_OF_DATE_RE = /\bday\s+of\b/i;
const ON_THIS_DATE_RE = /\bon\s+this\b/i;
// Matches a year stub like "20___" — the trailing blank of an execution date clause.
const YEAR_STUB_RE = /\b(?:19|20)\d{0,2}[\s_]/;
const TEXT_LINE_WORDS = /\b(full name|print name|printed name|name|title|designation|designatation|position|capacity)\b/i;
const NON_SIGNATURE_FIELD_WORDS = /\b(full name|print name|printed name|name|capacity|title|designation|designatation|position|address)\b\s*:?/i;
const TEXT_WORD_PATTERN = /\b[A-Za-z][A-Za-z0-9'-]*\b/g;
const EXPLICIT_SIGNATURE_CUE_RE = /\b(sign\s+here|signed\s+by|for\s+and\s+on\s+behalf|authori[sz]ed\s+signatory)\b/i;
const SIGNATURE_LABEL_RE = /(?:^|\s)(?:signature|sign|signatory)\s*(?::|_|\s*$)/i;
const SUPPORTED_FIELD_TYPES = new Set([
  'signature',
  'initials',
  'date',
  'text',
  'number',
  'checkbox',
  'radio',
  'dropdown',
]);

const optionalRequire = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

const sha256File = (filePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const inferFieldType = (label = '') => {
  if (DATE_WORDS.test(label)) return 'date';
  if (INITIAL_WORDS.test(label)) return 'initials';
  if (CHECKBOX_WORDS.test(label)) return 'checkbox';
  if (RADIO_WORDS.test(label)) return 'radio';
  if (DROPDOWN_WORDS.test(label)) return 'dropdown';
  if (NAME_WORDS.test(label)) return 'text';
  return 'signature';
};

const normalizeFieldType = (field = {}) => {
  const explicitType = String(field.type || '').toLowerCase().trim();
  if (SUPPORTED_FIELD_TYPES.has(explicitType)) return explicitType;
  return inferFieldType(field.name || field.anchor || field.context || field.rawType || explicitType);
};

const parseSignerIndex = (label = '') => {
  const match = String(label).match(/(?:signer|party|sig|signature|date|initials?)[_-]?(\d+)/i);
  return match ? Math.max(0, Number(match[1]) - 1) : null;
};

const fieldSignerIndex = (field = {}) => {
  if (Number.isInteger(field.signerIndex)) return field.signerIndex;
  if (Number.isInteger(field.detection?.signerIndex)) return field.detection.signerIndex;
  return parseSignerIndex(field.name || field.anchor || field.context || '');
};

const finiteNumber = (value, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const textItemGeometry = (item) => {
  const [, , , , rawX, rawY] = item.transform || [1, 0, 0, 1, 0, 0];
  return {
    text: String(item.str || ''),
    x: finiteNumber(rawX),
    y: finiteNumber(rawY),
    width: finiteNumber(item.width),
    height: finiteNumber(item.height, 10),
  };
};

const buildTextLines = (items = []) => {
  const lines = [];
  const geometries = items
    .map(textItemGeometry)
    .filter((item) => item.text.trim())
    .sort((a, b) => b.y - a.y || a.x - b.x);

  for (const item of geometries) {
    const tolerance = Math.max(2.5, item.height * 0.35);
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .map((line) => {
      const sortedItems = line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let previousRight = null;
      const runs = [];

      for (const item of sortedItems) {
        const gap = previousRight === null ? 0 : item.x - previousRight;
        if (text && gap > 2 && !text.endsWith(' ')) text += ' ';
        const textOffset = text.length;
        text += item.text;

        const charWidth = item.text.length
          ? item.width / item.text.length
          : Math.max(4, item.height * 0.45);
        for (const match of item.text.matchAll(UNDERLINE_RUN_PATTERN)) {
          runs.push({
            textIndex: textOffset + match.index,
            textEnd: textOffset + match.index + match[0].length,
            x: item.x + match.index * charWidth,
            y: item.y,
            width: match[0].length * charWidth,
            chars: match[0].length,
          });
        }

        item.textIndex = textOffset;
        item.textEnd = textOffset + item.text.length;
        item.charWidth = charWidth;
        previousRight = item.x + item.width;
      }

      const minX = sortedItems.length ? Math.min(...sortedItems.map((item) => item.x)) : 0;
      const maxRight = sortedItems.length ? Math.max(...sortedItems.map((item) => item.x + item.width)) : 0;
      const maxHeight = sortedItems.length ? Math.max(...sortedItems.map((item) => item.height)) : 10;

      return {
        y: line.y,
        text,
        runs,
        items: sortedItems,
        x: minX,
        right: maxRight,
        height: maxHeight,
      };
    })
    .sort((a, b) => b.y - a.y);
};

const fieldFromUnderlineRun = ({ type, pageNumber, run, metric, context, confidence, detector, detection = {} }) => {
  const height = type === 'signature' ? 38 : type === 'date' ? 24 : 28;
  const pageWidth = finiteNumber(metric.width, 612) || 612;
  return {
    source: 'heuristic-keyword',
    detector,
    type,
    page: pageNumber,
    x: Math.max(0, run.x),
    y: Math.max(0, run.y),
    width: Math.max(1, Math.min(run.width, pageWidth - run.x - 24)),
    height,
    confidence,
    context: context.trim(),
    detection: {
      lineText: context.trim(),
      underlineChars: run.chars,
      underlineWidth: run.width,
      underlineY: run.y,
      ...detection,
    },
  };
};

const rangesOverlap = (aStart, aEnd, bStart, bEnd) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const textIndexForX = (line, x) => {
  const items = Array.isArray(line.items) ? line.items : [];
  if (!items.length) return line.text?.length || 0;

  const sortedItems = [...items].sort((a, b) => a.x - b.x);
  for (let index = 0; index < sortedItems.length; index += 1) {
    const item = sortedItems[index];
    const right = item.x + item.width;
    if (x >= item.x && x <= right) {
      const charWidth = item.charWidth || (item.text?.length ? item.width / item.text.length : 4);
      return item.textIndex + Math.max(0, Math.min(item.text.length, (x - item.x) / charWidth));
    }

    const next = sortedItems[index + 1];
    if (next && x > right && x < next.x) {
      const gapRatio = (x - right) / Math.max(1, next.x - right);
      return item.textEnd + gapRatio * Math.max(1, next.textIndex - item.textEnd);
    }
  }

  const first = sortedItems[0];
  if (x < first.x) return 0;
  return line.text?.length || sortedItems[sortedItems.length - 1].textEnd || 0;
};

const textXAtIndex = (line, textIndex) => {
  const items = Array.isArray(line.items) ? line.items : [];
  if (!items.length) return null;

  for (const item of items) {
    if (textIndex >= item.textIndex && textIndex <= item.textEnd) {
      const charWidth = item.charWidth || (item.text?.length ? item.width / item.text.length : 4);
      return item.x + Math.max(0, textIndex - item.textIndex) * charWidth;
    }
  }

  const next = items.find((item) => item.textIndex > textIndex);
  if (next) return next.x;
  const last = items[items.length - 1];
  return last.x + last.width;
};

const firstWordAfter = (text = '', startIndex = 0) => {
  TEXT_WORD_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TEXT_WORD_PATTERN)) {
    if (match.index >= startIndex) {
      return {
        text: match[0],
        index: match.index,
        end: match.index + match[0].length,
      };
    }
  }
  return null;
};

const textItemBoxes = (line) => {
  const items = Array.isArray(line.items) ? line.items : [];
  if (!items.length) return [];

  return items
    .filter((item) => {
      const text = String(item.text || '');
      return text.trim() && !/^_+$/.test(text.trim());
    })
    .map((item) => {
      const height = Math.max(10, finiteNumber(item.height, line.height || 10));
      return {
        x: item.x,
        y: Math.max(0, item.y - Math.min(3, height * 0.25)),
        width: item.width,
        height: height + 4,
        right: item.x + item.width,
      };
    })
    .filter((box) => box.width > 0 && box.height > 0);
};

const runOverlapsText = (line, run, metric = {}) => {
  const rect = {
    x: run.x,
    y: Math.max(0, run.y - 8),
    width: run.width,
    height: 28,
  };
  return textItemBoxes(line, metric).some((box) => rectOverlapRatio(rect, box) > 0.08);
};

const emptyRunSegment = (line, run, cueEnd, metric = {}) => {
  if (run.source !== 'pdf-path-line') {
    return runOverlapsText(line, run, metric) ? null : run;
  }

  const cueEndX = textXAtIndex(line, cueEnd);
  let start = Math.max(run.x, cueEndX === null ? run.x : cueEndX + 3);
  let end = run.x + run.width;
  const runBand = {
    x: run.x,
    y: Math.max(0, run.y - 10),
    width: run.width,
    height: 24,
  };
  const blockers = textItemBoxes(line, metric)
    .filter((box) => rectOverlapRatio(runBand, box) > 0.02)
    .sort((a, b) => a.x - b.x);

  for (const blocker of blockers) {
    const blockerEnd = blocker.x + blocker.width;
    if (blockerEnd <= start) continue;
    if (blocker.x <= start && blockerEnd > start) {
      start = blockerEnd + 3;
      continue;
    }
    if (blocker.x > start) {
      end = Math.min(end, blocker.x - 3);
      break;
    }
  }

  const width = end - start;
  if (width < 12) return null;
  return {
    ...run,
    x: start,
    width,
    chars: Math.max(4, Math.round(width / 5)),
    textIndex: textIndexForX(line, start),
    textEnd: textIndexForX(line, end),
  };
};

const firstRunAfterTextIndex = (line, runs = [], cueEnd) => {
  const cueEndX = textXAtIndex(line, cueEnd);
  const candidates = runs
    .filter((run) => {
      if (run.source === 'pdf-path-line' && cueEndX !== null) return run.x + run.width > cueEndX + 2;
      return run.textEnd > cueEnd;
    })
    .sort((a, b) => a.x - b.x || a.textIndex - b.textIndex);

  for (const candidate of candidates) {
    const run = emptyRunSegment(line, candidate, cueEnd);
    if (!run) continue;

    const nextWord = firstWordAfter(line.text, Math.ceil(run.textEnd));
    if (nextWord && run.textIndex >= nextWord.index) continue;

    return {
      run,
      nextWord,
    };
  }

  return null;
};

const lineRunsNearText = (line, drawnLines = []) => {
  const nearbyDrawnLines = drawnLines
    .filter((drawnLine) => Math.abs(drawnLine.y - line.y) <= 18)
    .map((drawnLine) => ({
      ...drawnLine,
      textIndex: textIndexForX(line, drawnLine.x),
      textEnd: textIndexForX(line, drawnLine.x + drawnLine.width),
    }));
  return [...(line.runs || []), ...nearbyDrawnLines]
    .sort((a, b) => a.x - b.x);
};

const dateFieldFromLine = (line, pageNumber, metric, runs = line.runs) => {
  if (!runs.length || !EXPLICIT_DATE_WORDS.test(line.text)) return null;

  const cueMatch = line.text.match(EXPLICIT_DATE_WORDS);
  const cueIndex = cueMatch?.index;
  const cueEnd = Number.isInteger(cueIndex) ? cueIndex + cueMatch[0].length : null;

  if (cueEnd === null) return null;

  const match = firstRunAfterTextIndex(line, runs, cueEnd);
  if (!match) return null;
  const { run, nextWord } = match;

  return fieldFromUnderlineRun({
    type: 'date',
    pageNumber,
    metric,
    run,
    context: line.text,
    confidence: 0.82,
    detector: 'pdfjs-text-underline-date',
    detection: {
      cue: line.text.slice(cueIndex, Math.min(line.text.length, cueIndex + 40)).trim(),
      nextText: nextWord?.text || '',
      underlineRunCount: 1,
    },
  });
};

const textFieldFromLine = (line, pageNumber, metric, runs = line.runs) => {
  if (!runs.length || !TEXT_LINE_WORDS.test(line.text)) return null;

  const cueMatch = line.text.match(TEXT_LINE_WORDS);
  const cueIndex = cueMatch?.index;
  const cueEnd = Number.isInteger(cueIndex) ? cueIndex + cueMatch[0].length : null;
  if (cueEnd === null) return null;

  const match = firstRunAfterTextIndex(line, runs, cueEnd);
  if (!match) return null;

  return fieldFromUnderlineRun({
    type: 'text',
    pageNumber,
    metric,
    run: match.run,
    context: line.text,
    confidence: 0.78,
    detector: 'pdfjs-text-underline-text',
    detection: {
      cue: line.text.slice(cueIndex, Math.min(line.text.length, cueIndex + 40)).trim(),
      nextText: match.nextWord?.text || '',
      underlineRunCount: 1,
    },
  });
};

// Detects "Signed at ___" (place → 'text') and "Signed on ___" (date → 'date') underlines.
// These are NOT signature fields — EXECUTION_PLACE_WORDS already zeroes their signature
// confidence, but nothing was creating a field for them at all.
const signedAtOrOnFieldFromLine = (line, pageNumber, metric, runs = line.runs) => {
  if (!runs.length) return null;
  const text = line.text;
  const atMatch = text.match(EXECUTION_PLACE_WORDS); // /\bsigned\s+at\b/i
  const onMatch = !atMatch && text.match(SIGNED_ON_RE); // /\bsigned\s+on\b/i
  const cueMatch = atMatch || onMatch;
  if (!cueMatch) return null;
  const cueEnd = cueMatch.index + cueMatch[0].length;
  const match = firstRunAfterTextIndex(line, runs, cueEnd);
  if (!match) return null;
  return fieldFromUnderlineRun({
    type: atMatch ? 'text' : 'date',
    pageNumber,
    metric,
    run: match.run,
    context: text,
    confidence: 0.82,
    detector: atMatch ? 'pdfjs-text-underline-signed-at' : 'pdfjs-text-underline-signed-on',
    detection: { cue: cueMatch[0].toLowerCase(), nextText: match.nextWord?.text || '' },
  });
};

const inlineDateClauseRunType = (lineText, run, locationBoundary, dateRunIndex = -1, dateRunCount = 0) => {
  const start = Math.floor(finiteNumber(run.textIndex, 0));
  const end = Math.ceil(finiteNumber(run.textEnd, start));
  const mid = (start + end) / 2;
  const before = lineText.slice(0, start);

  if (locationBoundary !== null && mid < locationBoundary) {
    return { type: 'text', role: 'execution-place' };
  }

  if (/\b(?:19|20)\d{0,2}\s*$/.test(before)) {
    return { type: 'number', role: 'year' };
  }

  if (dateRunIndex === 0) {
    return { type: 'number', role: 'day' };
  }

  if (dateRunIndex === dateRunCount - 1 && dateRunCount >= 3 && YEAR_STUB_RE.test(lineText)) {
    return { type: 'number', role: 'year' };
  }

  if (dateRunIndex > 0 && dateRunIndex < dateRunCount) {
    return { type: 'text', role: 'month' };
  }

  if (/\bon\s+this\b/i.test(before) && !/\bday\s+of\b/i.test(before)) {
    return { type: 'number', role: 'day' };
  }

  if (/\bday\s+of\b/i.test(before)) {
    return { type: 'text', role: 'month' };
  }

  return { type: 'text', role: 'date-fragment' };
};

// Handles "Dated at _______ on this _______ day of _______ 20___" style inline clauses.
// These are fragments of one legal execution sentence, not full date-picker values:
// place/month are text and day/year are number fields.
const inlineDateClauseFieldsFromLine = (line, pageNumber, metric, runs = line.runs) => {
  if (!runs.length || !INLINE_DATE_CLAUSE_RE.test(line.text)) return [];

  const text = line.text;
  // Find the boundary where the location blank ends and the date blanks begin.
  // "on this" marks the start of the date portion; without it, all blanks are dates.
  const onThisMatch = text.match(/\bon\s+this\b/i);
  const locationBoundary = onThisMatch ? onThisMatch.index : null;
  // Shared ID for every blank on this line so assignFieldsToSigners groups them
  // as one logical unit — prevents round-robin from splitting them across signatories.
  const clauseLineId = `idc_${pageNumber}_${Math.round(line.y)}`;

  const fields = [];
  const sortedRuns = [...runs].sort((a, b) => a.x - b.x);
  const dateRuns = sortedRuns.filter((run) => {
    const runMid = ((run.textIndex || 0) + (run.textEnd || run.textIndex || 0)) / 2;
    return locationBoundary === null || runMid >= locationBoundary;
  });

  for (const run of sortedRuns) {
    const classification = inlineDateClauseRunType(
      text,
      run,
      locationBoundary,
      dateRuns.indexOf(run),
      dateRuns.length
    );
    const field = fieldFromUnderlineRun({
      type: classification.type,
      pageNumber,
      metric,
      run,
      context: text,
      confidence: 0.80,
      detector: 'pdfjs-text-underline-date-clause',
      detection: {
        isInlineDateClause: true,
        clauseLineId,
        fragmentRole: classification.role,
        underlineRunCount: runs.length,
      },
    });
    if (field) fields.push(field);
  }
  return fields;
};

const wordCount = (value = '') =>
  (String(value).match(TEXT_WORD_PATTERN) || []).length;

const looksLikeBodyText = (value = '') => {
  const text = String(value || '').trim();
  return wordCount(text) > 10 && /[.;,]/.test(text) && !/_{3,}/.test(text);
};

const looksLikeProseLine = (value = '') => {
  const text = String(value || '').trim();
  if (!text || /_{3,}|:\s*$/.test(text)) return false;
  if (SIGNATURE_LABEL_RE.test(text)) return false;
  return wordCount(text) >= 8;
};

const hasSignatureFieldCue = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return false;
  if (looksLikeProseLine(text)) return false;
  if (EXPLICIT_SIGNATURE_CUE_RE.test(text)) return true;
  if (SIGNATURE_LABEL_RE.test(text)) return true;
  return /^(?:signature|sign|signatory|authori[sz]ed signatory)\b/i.test(text) && wordCount(text) <= 6;
};

const signatureConfidenceForContext = (lineText, neighborText) => {
  const line = String(lineText || '').trim();
  const context = `${lineText} ${neighborText}`;
  if (NON_SIGNATURE_FIELD_WORDS.test(lineText)) return 0;
  if (EXECUTION_PLACE_WORDS.test(lineText) && !SIGNATURE_LINE_WORDS.test(lineText)) return 0;
  if (/\bduly\s+authori[sz]ed\s+to\s+sign\b/i.test(context) && !hasSignatureFieldCue(line)) return 0;
  if (looksLikeProseLine(line)) return 0;
  if (looksLikeBodyText(line) && !EXPLICIT_SIGNATURE_CUE_RE.test(line)) return 0;
  if (/\bfor and on behalf\b/i.test(context)) return 0.88;
  if (hasSignatureFieldCue(line) || hasSignatureFieldCue(neighborText)) return 0.86;
  if (/\bsigned by\b/i.test(context)) return 0.82;
  if (/\bwitness\b/i.test(context) && !looksLikeBodyText(line)) return 0.58;
  return 0;
};

const lineBounds = (line, metric = {}) => {
  const items = Array.isArray(line.items) ? line.items : [];
  if (items.length) {
    return {
      x: Math.min(...items.map((item) => item.x)),
      right: Math.max(...items.map((item) => item.x + item.width)),
      y: finiteNumber(line.y),
      height: Math.max(...items.map((item) => item.height || 10)),
    };
  }
  const runs = Array.isArray(line.runs) ? line.runs : [];
  if (runs.length) {
    return {
      x: Math.min(...runs.map((run) => run.x)),
      right: Math.max(...runs.map((run) => run.x + run.width)),
      y: finiteNumber(line.y),
      height: 12,
    };
  }
  return {
    x: finiteNumber(line.x),
    right: finiteNumber(line.right, finiteNumber(metric.width, 612)),
    y: finiteNumber(line.y),
    height: finiteNumber(line.height, 12),
  };
};

const rectsOverlapArea = (a, b) => {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y, b.y);
  const top = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, top - bottom);
};

const rectOverlapRatio = (a, b) => {
  const area = rectsOverlapArea(a, b);
  const minArea = Math.min(a.width * a.height, b.width * b.height) || 1;
  return area / minArea;
};

const cellContainsRectCenter = (cell, rect) => {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return cx >= cell.x - 2 &&
    cx <= cell.x + cell.width + 2 &&
    cy >= cell.y - 2 &&
    cy <= cell.y + cell.height + 2;
};

const cellContainsPoint = (cell, x, y) =>
  x >= cell.x - 2 &&
  x <= cell.x + cell.width + 2 &&
  y >= cell.y - 2 &&
  y <= cell.y + cell.height + 2;

const cellHasPlacedField = (cell, fields = []) =>
  fields.some((field) => cellContainsRectCenter(cell, field));

const textBoxBelongsToCell = (box, cell) => {
  if (cellContainsRectCenter(cell, box)) return true;
  const xOverlap = rangesOverlap(box.x, box.x + box.width, cell.x, cell.x + cell.width);
  const yOverlap = rangesOverlap(box.y, box.y + box.height, cell.y, cell.y + cell.height);
  return xOverlap / Math.max(1, box.width) >= 0.35 &&
    yOverlap / Math.max(1, Math.min(box.height, cell.height)) >= 0.35;
};

const textBoxesInCell = (lines, cell, metric) =>
  lines
    .flatMap((line) => textItemBoxes(line, metric))
    .filter((box) => box.width > 0 && textBoxBelongsToCell(box, cell))
    .map((box) => ({
      x: Math.max(cell.x, box.x - 2),
      y: Math.max(cell.y, box.y - 2),
      width: Math.min(cell.x + cell.width, box.x + box.width + 2) - Math.max(cell.x, box.x - 2),
      height: Math.min(cell.y + cell.height, box.y + box.height + 2) - Math.max(cell.y, box.y - 2),
    }))
    .filter((box) => box.width > 0 && box.height > 0);

const cellTextForLine = (line, cell) => {
  const items = Array.isArray(line.items) ? line.items : [];
  if (items.length) {
    return items
      .filter((item) => {
        const text = String(item.text || '');
        if (!text.trim() || /^_+$/.test(text.trim())) return false;
        const height = Math.max(10, finiteNumber(item.height, line.height || 10));
        return textBoxBelongsToCell({
          x: item.x,
          y: Math.max(0, item.y - Math.min(3, height * 0.25)),
          width: item.width,
          height: height + 4,
        }, cell);
      })
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const bounds = lineBounds(line);
  const lineBox = {
    x: bounds.x,
    y: bounds.y - Math.max(4, finiteNumber(bounds.height, 12) * 0.25),
    width: Math.max(0, bounds.right - bounds.x),
    height: Math.max(10, finiteNumber(bounds.height, 12) + 4),
  };
  return textBoxBelongsToCell(lineBox, cell) ? String(line.text || '').trim() : '';
};

const cellHasBlankMarkerForLine = (line, cell) => {
  const items = Array.isArray(line.items) ? line.items : [];
  if (items.length) {
    return items.some((item) => {
      const text = String(item.text || '');
      if (!/_{3,}/.test(text)) return false;
      const height = Math.max(10, finiteNumber(item.height, line.height || 10));
      return textBoxBelongsToCell({
        x: item.x,
        y: Math.max(0, item.y - Math.min(3, height * 0.25)),
        width: item.width,
        height: height + 4,
      }, cell);
    });
  }

  if (!/_{3,}/.test(String(line.text || ''))) return false;
  const bounds = lineBounds(line);
  return textBoxBelongsToCell({
    x: bounds.x,
    y: bounds.y - Math.max(4, finiteNumber(bounds.height, 12) * 0.25),
    width: Math.max(0, bounds.right - bounds.x),
    height: Math.max(10, finiteNumber(bounds.height, 12) + 4),
  }, cell);
};

// A target cell is occupied only by real text. Pure underscores are visual blanks
// and remain valid designated signing areas.
const cellHasText = (cell, lines, metric) =>
  lines.some((line) => Boolean(cellTextForLine(line, cell))) ||
    textBoxesInCell(lines, cell, metric).some((box) => cellContainsRectCenter(cell, box));

const tableFieldTypeForLine = (lineText = '') => {
  if (looksLikeProseLine(lineText)) return null;
  if (/\bdated\s+at\b/i.test(lineText) || EXECUTION_PLACE_WORDS.test(lineText)) return 'text';
  if (ON_THIS_DATE_RE.test(lineText)) return 'number';       // "on this ___" → day number
  if (DAY_OF_DATE_RE.test(lineText)) return 'text';          // "day of ___" → month text
  if (YEAR_STUB_RE.test(lineText)) return 'number';          // "20___" year-stub → year number
  if (DATE_WORDS.test(lineText)) return 'date';
  if (SIGNED_ON_RE.test(lineText)) return 'date';
  if (TEXT_LINE_WORDS.test(lineText)) return 'text';
  if (SIGNATURE_LINE_WORDS.test(lineText) && !NON_SIGNATURE_FIELD_WORDS.test(lineText)) return 'signature';
  return null;
};

const tableFieldHeightForType = (type, cellHeight) => {
  if (type === 'signature') return Math.max(28, cellHeight);
  if (type === 'date') return Math.max(22, Math.min(32, cellHeight));
  return Math.max(24, Math.min(34, cellHeight));
};

const tableFieldMinimumWidth = (type) => {
  if (type === 'signature') return 80;
  if (type === 'date') return 64;
  return 36;
};

const chooseTableFieldGeometry = ({ type, targetCell, metric }) => {
  const pageWidth = finiteNumber(metric.width, 612) || 612;
  const insetX = Math.min(8, Math.max(4, targetCell.width * 0.025));
  const insetY = Math.min(6, Math.max(3, targetCell.height * 0.08));
  const inner = {
    x: targetCell.x + insetX,
    y: targetCell.y + insetY,
    width: Math.max(0, targetCell.width - insetX * 2),
    height: Math.max(0, targetCell.height - insetY * 2),
  };
  if (inner.width <= 0 || inner.height <= 0) return null;

  const minWidth = tableFieldMinimumWidth(type);
  const minHeight = Math.min(inner.height, type === 'signature' ? 18 : 10);
  const desiredHeight = tableFieldHeightForType(type, inner.height);
  const width = Math.min(inner.width, pageWidth - inner.x);
  const height = Math.min(inner.height, desiredHeight);
  if (width < minWidth || height < minHeight) return null;

  return {
    x: Math.max(0, inner.x),
    y: Math.max(0, inner.y + Math.max(0, (inner.height - height) / 2)),
    width,
    height,
  };
};

const cellsShareRow = (a, b) => {
  const overlap = rangesOverlap(a.y, a.y + a.height, b.y, b.y + b.height);
  const minHeight = Math.max(1, Math.min(a.height, b.height));
  const centerDelta = Math.abs((a.y + a.height / 2) - (b.y + b.height / 2));
  return overlap / minHeight > 0.7 && centerDelta <= Math.max(6, minHeight * 0.35);
};

const sameTableCell = (a, b) =>
  Math.abs(a.x - b.x) <= 3 &&
  Math.abs(a.y - b.y) <= 3 &&
  Math.abs(a.width - b.width) <= 6 &&
  Math.abs(a.height - b.height) <= 6;

const findAdjacentRightCell = (labelCell, tableCells = []) => {
  const labelRight = labelCell.x + labelCell.width;
  return tableCells
    .filter((cell) => {
      if (sameTableCell(cell, labelCell)) return false;
      if (!cellsShareRow(cell, labelCell)) return false;
      const gap = cell.x - labelRight;
      return gap >= -3 && gap <= 8;
    })
    .sort((a, b) =>
      Math.abs(a.x - labelRight) - Math.abs(b.x - labelRight) ||
      (a.width * a.height) - (b.width * b.height)
    )[0] || null;
};

const tableFieldsFromCells = (lines, pageNumber, metric, tableCells = []) => {
  if (!Array.isArray(tableCells) || !tableCells.length) return [];
  const fields = [];

  for (const line of lines) {
    const bounds = lineBounds(line, metric);
    const labelCells = tableCells
      .map((cell) => ({
        cell,
        labelText: cellTextForLine(line, cell),
      }))
      .filter(({ cell, labelText }) =>
        labelText &&
        line.y >= cell.y - 4 &&
        line.y <= cell.y + cell.height + 4 &&
        rangesOverlap(bounds.x, bounds.right, cell.x, cell.x + cell.width) > 0
      )
      .sort((a, b) => a.cell.x - b.cell.x);

    if (!labelCells.length) continue;

    // Table rule: only a keyword cell can trigger a field, and only the bordered
    // cell immediately to its right can receive it.
    for (const { cell: labelCell, labelText } of labelCells) {
      if (cellHasBlankMarkerForLine(line, labelCell)) continue;
      const type = tableFieldTypeForLine(labelText);
      if (!type) continue;

      const rightCell = findAdjacentRightCell(labelCell, tableCells);
      const hasEmptyDesignatedCell =
        rightCell &&
        rightCell.width - Math.min(8, Math.max(4, rightCell.width * 0.025)) * 2 >= tableFieldMinimumWidth(type) &&
        !cellHasText(rightCell, lines, metric) &&
        !cellHasPlacedField(rightCell, fields);
      if (!hasEmptyDesignatedCell) continue;

      const geometry = chooseTableFieldGeometry({
        type,
        targetCell: rightCell,
        metric,
      });
      if (!geometry) continue;

      fields.push({
        source: 'heuristic-keyword',
        detector: `pdfjs-table-${type}-cell`,
        type,
        page: pageNumber,
        ...geometry,
        confidence: type === 'signature' ? 0.9 : 0.82,
        context: labelText,
        detection: {
          lineText: labelText,
          tableCell: {
            x: rightCell.x,
            y: rightCell.y,
            width: rightCell.width,
            height: rightCell.height,
          },
        },
      });
    }
  }

  return fields;
};

const lineIntersectsTableCell = (line, tableCells = [], metric = {}) => {
  if (!Array.isArray(tableCells) || !tableCells.length) return false;
  const bounds = lineBounds(line, metric);
  return tableCells.some((cell) =>
    line.y >= cell.y - 4 &&
    line.y <= cell.y + cell.height + 4 &&
    rangesOverlap(bounds.x, bounds.right, cell.x, cell.x + cell.width) > 0
  );
};

const harmonizeStackedLineFields = (fields, metric) => {
  const pageHeight = finiteNumber(metric.height, 792) || 792;
  // Include all underline-detected types so signature heights are relative to their neighbours
  const lineFields = fields.filter((field) =>
    ['date', 'text', 'number', 'signature', 'initials'].includes(field.type) &&
    String(field.detector || '').startsWith('pdfjs-text-underline')
  );
  const visited = new Set();

  for (const seed of lineFields) {
    if (visited.has(seed)) continue;
    const stack = lineFields
      .filter((field) => {
        if (visited.has(field)) return false;
        const xOverlap = rangesOverlap(seed.x, seed.x + seed.width, field.x, field.x + field.width);
        const minWidth = Math.min(seed.width, field.width) || 1;
        // 64 px window catches typical contract signing-block line spacing
        return xOverlap / minWidth > 0.35 &&
          Math.abs(
            finiteNumber(seed.detection?.underlineY, seed.y + 8) -
            finiteNumber(field.detection?.underlineY, field.y + 8)
          ) <= 64;
      })
      // Descending underlineY → stack[0] is highest on page (largest PDF y)
      .sort((a, b) =>
        finiteNumber(b.detection?.underlineY, b.y + 8) -
        finiteNumber(a.detection?.underlineY, a.y + 8)
      );

    if (stack.length < 2) {
      visited.add(seed);
      continue;
    }

    stack.forEach((field) => visited.add(field));

    // Precompute per-adjacent-pair gaps (index k → gap between k and k+1)
    const pairGaps = stack.slice(1).map((field, k) =>
      Math.abs(
        finiteNumber(stack[k].detection?.underlineY, stack[k].y + 8) -
        finiteNumber(field.detection?.underlineY, field.y + 8)
      )
    ).filter((g) => g > 0);
    const fallbackGap = pairGaps.length ? Math.min(...pairGaps) : 28;

    for (let k = 0; k < stack.length; k++) {
      const field = stack[k];
      const underlineY = finiteNumber(field.detection?.underlineY, field.y + 8);
      // Use the gap to the immediately-adjacent field below, not the global minimum.
      // This lets a signature keep a taller box even when a distant pair is tight.
      const nextBelow = stack[k + 1];
      const gapToNext = nextBelow
        ? Math.abs(underlineY - finiteNumber(nextBelow.detection?.underlineY, nextBelow.y + 8))
        : fallbackGap;

      const isSig = field.type === 'signature';
      const isInit = field.type === 'initials';
      const maxH = isSig ? 40 : isInit ? 28 : 28;
      // Cap to the adjacent underline gap so tight signing stacks stay visible
      // without overlapping the next field.
      const targetHeight = Math.max(8, Math.min(maxH, gapToNext));
      field.height = targetHeight;
      field.y = Math.max(0, Math.min(pageHeight - targetHeight, underlineY));
      field.detection = { ...(field.detection || {}), stackedLineHeight: targetHeight };
    }
  }

  return fields;
};

// Resolve any remaining overlaps after mergeFields/normalizePdfField.
// All fields are in PDF coordinates: y=0 at bottom, y increases upward.
// Higher PDF y = higher on page (appears earlier when reading).
const resolveFieldOverlaps = (fields) => {
  const byPage = new Map();
  for (const field of fields) {
    const p = field.page || 1;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push(field);
  }

  for (const pageFields of byPage.values()) {
    // Sort by PDF y descending → fields higher on the page come first.
    // Ties broken by height descending so a taller field is "upper" and protects
    // the shorter one from being spuriously clipped.
    pageFields.sort((a, b) => b.y - a.y || b.height - a.height);

    // N² pass so non-consecutive pairs (A overlaps C but not B) are also caught.
    for (let i = 0; i < pageFields.length; i++) {
      const upper = pageFields[i];
      for (let j = i + 1; j < pageFields.length; j++) {
        const lower = pageFields[j];

        // After sort upper.y >= lower.y always holds.
        // If the difference is < 4 px the two fields are on the same visual row
        // (e.g. signature left / date right) — skip to avoid false clips.
        if (upper.y - lower.y < 4) continue;

        // Skip when the fields don't share enough horizontal space to be considered
        // part of the same column.  25 % overlap of the narrower field is the threshold.
        const xOverlap = rangesOverlap(
          upper.x, upper.x + upper.width,
          lower.x, lower.x + lower.width
        );
        const minWidth = Math.min(upper.width, lower.width) || 1;
        if (xOverlap / minWidth < 0.25) continue;

        // In PDF space: lower field occupies [lower.y, lower.y + lower.height].
        // It overlaps upper field when lower.y + lower.height > upper.y.
        const lowerTop = lower.y + lower.height;
        if (lowerTop > upper.y) {
          const available = upper.y - lower.y - 2; // 2 px breathing room
          // 8 px absolute floor — type-specific minH must not force the box
          // above the available space and re-introduce the overlap.
          lower.height = Math.max(8, available);
        }
      }
    }
  }

  return fields;
};

// Returns the PDF y of the nearest text line or drawn rule that sits above the field's
// underline (within 80 px, with ≥15 % x overlap). Returns null if nothing is found.
// In PDF space "above" means higher y (y increases upward).
const findNearestContentAbove = (field, lines, drawnLines) => {
  const underlineY = finiteNumber(field.detection?.underlineY, field.y);
  const fieldLeft = field.x;
  const fieldRight = field.x + field.width;
  const fieldWidth = field.width || 1;
  let nearest = null;

  for (const line of lines) {
    if (line.y <= underlineY + 2) continue;
    if (line.y > underlineY + 80) continue;
    const xOverlap = rangesOverlap(fieldLeft, fieldRight, line.x, line.right || line.x);
    if (xOverlap / fieldWidth < 0.15) continue;
    if (nearest === null || line.y < nearest) nearest = line.y;
  }

  for (const dl of drawnLines) {
    if (dl.y <= underlineY + 2) continue;
    if (dl.y > underlineY + 80) continue;
    const xOverlap = rangesOverlap(fieldLeft, fieldRight, dl.x, dl.x + dl.width);
    if (xOverlap / fieldWidth < 0.15) continue;
    if (nearest === null || dl.y < nearest) nearest = dl.y;
  }

  return nearest;
};

const clampFieldsToTableCells = (fields, tableCells = []) => {
  if (!Array.isArray(tableCells) || !tableCells.length) return fields;

  for (const field of fields) {
    if (!String(field.detector || '').startsWith('pdfjs-text-underline') &&
      !String(field.detector || '').startsWith('pdfjs-table-')) {
      continue;
    }

    const anchorX = field.x + Math.min(8, Math.max(1, field.width / 2));
    const anchorY = field.y + Math.max(1, field.height / 2);
    const cell = tableCells.find((candidate) => cellContainsPoint(candidate, anchorX, anchorY)) ||
      tableCells.find((candidate) => cellContainsRectCenter(candidate, field));
    if (!cell) continue;

    const inset = 2;
    const left = cell.x + inset;
    const right = cell.x + cell.width - inset;
    const bottom = cell.y + inset;
    const top = cell.y + cell.height - inset;
    if (right <= left || top <= bottom) continue;

    const minWidth = Math.min(field.type === 'checkbox' ? 12 : 24, right - left);
    const minHeight = Math.min(field.type === 'signature' ? 18 : 12, top - bottom);

    const nextX = Math.max(left, Math.min(field.x, right - minWidth));
    const nextRight = Math.max(nextX + minWidth, Math.min(right, field.x + field.width));
    const nextY = Math.max(bottom, Math.min(field.y, top - minHeight));
    const nextTop = Math.max(nextY + minHeight, Math.min(top, field.y + field.height));

    field.x = nextX;
    field.y = nextY;
    field.width = nextRight - nextX;
    field.height = nextTop - nextY;
    field.detection = {
      ...(field.detection || {}),
      clampedToTableCell: { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
    };
  }

  return fields;
};

const textLayoutFieldsFromLines = (lines, pageNumber, metric, signers = [], drawnLines = [], tableCells = []) => {
  void signers;
  const fields = [];

  fields.push(...tableFieldsFromCells(lines, pageNumber, metric, tableCells, drawnLines));

  lines.forEach((line, index) => {
    const neighborText = [
      lines[index - 1]?.text || '',
      lines[index + 1]?.text || '',
    ].join(' ');
    const runs = lineRunsNearText(line, drawnLines);
    // Once table geometry exists, table rows are handled exclusively by
    // tableFieldsFromCells. Letting generic underline detection run inside a
    // table causes fields to land on labels/prose when a compact row is missed.
    if (lineIntersectsTableCell(line, tableCells, metric)) return;

    // "Dated at ___ on this ___ day of ___ 20___" — one field per blank.
    // These are legal date fragments, so they are text/number fields rather than
    // separate full date-picker controls.
    const isInlineDateClause = INLINE_DATE_CLAUSE_RE.test(line.text);
    const clauseFields = isInlineDateClause
      ? inlineDateClauseFieldsFromLine(line, pageNumber, metric, runs)
      : [];
    clauseFields.forEach((f) => fields.push(f));

    const dateField = isInlineDateClause ? null : dateFieldFromLine(line, pageNumber, metric, runs);
    if (dateField) fields.push(dateField);

    const textField = isInlineDateClause ? null : textFieldFromLine(line, pageNumber, metric, runs);
    if (textField) fields.push(textField);

    // "Signed at ___" → text (place); "Signed on ___" → date.
    // Neither is a signature field. EXECUTION_PLACE_WORDS already zeroes signature
    // confidence for these lines, but nothing was creating a field for them.
    const signedField = (!isInlineDateClause && !dateField && !textField)
      ? signedAtOrOnFieldFromLine(line, pageNumber, metric, runs)
      : null;
    if (signedField) fields.push(signedField);

    const signatureConfidence = signatureConfidenceForContext(line.text, neighborText);
    if (!signatureConfidence) return;

    // All non-signature fields already detected on this line — used to guard against
    // a run being claimed as both a clause blank and a signature field.
    const lineNonSigFields = [
      ...clauseFields,
      ...(dateField ? [dateField] : []),
      ...(textField ? [textField] : []),
      ...(signedField ? [signedField] : []),
    ];

    const signatureCueIndex = line.text.search(SIGNATURE_LINE_WORDS);
    for (const run of runs) {
      const runBox = {
        page: pageNumber,
        x: run.x,
        y: Math.max(0, run.y - 8),
        width: run.width,
        height: 28,
      };
      if (lineNonSigFields.some((f) => overlapRatio(f, runBox) > 0.25)) continue;
      if (signatureCueIndex >= 0 && run.textEnd <= signatureCueIndex) continue;
      if (run.width < Math.min(110, finiteNumber(metric.width, 612) * 0.18)) continue;
      fields.push(fieldFromUnderlineRun({
        type: 'signature',
        pageNumber,
        metric,
        run,
        context: [neighborText, line.text].filter(Boolean).join(' '),
        confidence: signatureConfidence,
        detector: 'pdfjs-text-underline-signature',
      }));
    }
  });

  const laidOutFields = harmonizeStackedLineFields(fields, metric);

  // Snap every underline-detected field to its underline y and clamp its height
  // against any text or rule that sits directly above it on the page.
  for (const field of laidOutFields) {
    if (!String(field.detector || '').startsWith('pdfjs-text-underline')) continue;
    const underlineY = finiteNumber(field.detection?.underlineY, field.y);
    field.y = Math.max(0, underlineY);
    const aboveY = findNearestContentAbove(field, lines, drawnLines);
    if (aboveY !== null) {
      // Hard cap: never extend above content. 8 px absolute minimum keeps the
      // field visible; minH by type is NOT applied here so the cap always wins.
      field.height = Math.max(8, Math.min(field.height, aboveY - underlineY - 2));
    }
  }

  return clampFieldsToTableCells(laidOutFields, tableCells);
};

const multiplyPdfMatrices = (left, right) => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4],
  left[1] * right[4] + left[3] * right[5] + left[5],
];

const transformPoint = (matrix, x, y) => ({
  x: matrix[0] * x + matrix[2] * y + matrix[4],
  y: matrix[1] * x + matrix[3] * y + matrix[5],
});

const transformBbox = (bbox, matrix) => {
  const [left, bottom, right, top] = bbox;
  const points = [
    transformPoint(matrix, left, bottom),
    transformPoint(matrix, left, top),
    transformPoint(matrix, right, bottom),
    transformPoint(matrix, right, top),
  ];
  return [
    Math.min(...points.map((point) => point.x)),
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)),
  ];
};

const dedupeGeometry = (items, sameGeometry) =>
  items.filter((item, index, list) => !list.slice(0, index).some((prior) => sameGeometry(prior, item)));

const buildTableCellsFromGridLines = (horizontalLines, verticalLines, metric) => {
  const pageWidth = finiteNumber(metric.width, 612) || 612;
  const pageHeight = finiteNumber(metric.height, 792) || 792;
  if (horizontalLines.length < 2 || verticalLines.length < 2) return [];

  const xCoords = [...new Set(verticalLines.map((line) => Math.round(line.x)))].sort((a, b) => a - b);
  const yCoords = [...new Set(horizontalLines.map((line) => Math.round(line.y)))].sort((a, b) => a - b);
  const cells = [];

  for (let yIndex = 0; yIndex < yCoords.length - 1; yIndex += 1) {
    const bottom = yCoords[yIndex];
    const top = yCoords[yIndex + 1];
    const height = top - bottom;
    if (height < 14 || height > pageHeight * 0.35) continue;

    for (let leftIndex = 0; leftIndex < xCoords.length - 1; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < xCoords.length; rightIndex += 1) {
        const left = xCoords[leftIndex];
        const right = xCoords[rightIndex];
        const width = right - left;
        if (width < Math.max(70, pageWidth * 0.1)) continue;

        const hasTop = horizontalLines.some((line) =>
          Math.abs(line.y - top) <= 3 && line.x <= left + 4 && line.x + line.width >= right - 4
        );
        const hasBottom = horizontalLines.some((line) =>
          Math.abs(line.y - bottom) <= 3 && line.x <= left + 4 && line.x + line.width >= right - 4
        );
        const hasLeft = verticalLines.some((line) =>
          Math.abs(line.x - left) <= 3 && line.y <= bottom + 4 && line.y + line.height >= top - 4
        );
        const hasRight = verticalLines.some((line) =>
          Math.abs(line.x - right) <= 3 && line.y <= bottom + 4 && line.y + line.height >= top - 4
        );
        const hasInteriorDivider = verticalLines.some((line) =>
          line.x > left + 4 &&
          line.x < right - 4 &&
          line.y <= bottom + 4 &&
          line.y + line.height >= top - 4
        );

        if (hasTop && hasBottom && hasLeft && hasRight && !hasInteriorDivider) {
          cells.push({ source: 'pdf-path-table-grid', x: left, y: bottom, width, height });
        }
      }
    }
  }

  return cells;
};

const pathGeometryFromOperatorList = (operatorList, metric, ops = {}) => {
  const horizontalLines = [];
  const verticalLines = [];
  const tableCells = [];
  const pageWidth = finiteNumber(metric.width, 612) || 612;
  const pageHeight = finiteNumber(metric.height, 792) || 792;
  const matrixStack = [];
  let currentMatrix = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < (operatorList?.fnArray || []).length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray?.[index] || [];

    if (fn === ops.save) {
      matrixStack.push([...currentMatrix]);
      continue;
    }
    if (fn === ops.restore) {
      currentMatrix = matrixStack.pop() || [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (fn === ops.transform && args.length >= 6) {
      currentMatrix = multiplyPdfMatrices(currentMatrix, args.map((value) => finiteNumber(value)));
      continue;
    }

    if (ops.constructPath && fn !== ops.constructPath && (!ops.rectangle || fn !== ops.rectangle)) continue;

    const bbox = args[2];
    if (!bbox || typeof bbox.length !== 'number') continue;

    const [rawLeft, rawBottom, rawRight, rawTop] = transformBbox(Array.from(bbox).map((value) => finiteNumber(value)), currentMatrix);
    const left = Math.min(rawLeft, rawRight);
    const right = Math.max(rawLeft, rawRight);
    const bottom = Math.min(rawBottom, rawTop);
    const top = Math.max(rawBottom, rawTop);
    const width = right - left;
    const height = top - bottom;

    if (width >= Math.max(80, pageWidth * 0.12) && height <= 2.5) {
      horizontalLines.push({
        source: 'pdf-path-line',
        x: left,
        y: bottom + height / 2,
        width,
        chars: Math.max(4, Math.round(width / 5)),
      });
      continue;
    }

    if (height >= 24 && width <= 2.5) {
      verticalLines.push({
        source: 'pdf-path-vertical-line',
        x: left + width / 2,
        y: bottom,
        height,
      });
      continue;
    }

    if (
      width >= Math.max(80, pageWidth * 0.12) &&
      height >= 24 &&
      height <= pageHeight * 0.35
    ) {
      tableCells.push({
        source: 'pdf-path-rectangle',
        x: left,
        y: bottom,
        width,
        height,
      });
      horizontalLines.push({
        source: 'pdf-path-rectangle-edge',
        x: left,
        y: bottom,
        width,
        chars: Math.max(4, Math.round(width / 5)),
      });
      horizontalLines.push({
        source: 'pdf-path-rectangle-edge',
        x: left,
        y: top,
        width,
        chars: Math.max(4, Math.round(width / 5)),
      });
      verticalLines.push({
        source: 'pdf-path-rectangle-edge',
        x: left,
        y: bottom,
        height,
      });
      verticalLines.push({
        source: 'pdf-path-rectangle-edge',
        x: right,
        y: bottom,
        height,
      });
    }
  }

  const dedupedHorizontalLines = dedupeGeometry(
    horizontalLines.sort((a, b) => b.width - a.width),
    (prior, line) =>
      Math.abs(prior.x - line.x) < 4 &&
      Math.abs(prior.y - line.y) < 4 &&
      Math.abs(prior.width - line.width) < 8
  );
  const dedupedVerticalLines = dedupeGeometry(
    verticalLines.sort((a, b) => b.height - a.height),
    (prior, line) =>
      Math.abs(prior.x - line.x) < 4 &&
      Math.abs(prior.y - line.y) < 4 &&
      Math.abs(prior.height - line.height) < 8
  );
  const gridCells = buildTableCellsFromGridLines(dedupedHorizontalLines, dedupedVerticalLines, metric);

  return {
    horizontalLines: dedupedHorizontalLines,
    verticalLines: dedupedVerticalLines,
    tableCells: dedupeGeometry(
      [...tableCells, ...gridCells].sort((a, b) => (a.width * a.height) - (b.width * b.height)),
      (prior, cell) =>
        Math.abs(prior.x - cell.x) < 4 &&
        Math.abs(prior.y - cell.y) < 4 &&
        Math.abs(prior.width - cell.width) < 8 &&
        Math.abs(prior.height - cell.height) < 8
    ),
  };
};

const buildMiddlePageInitialFields = (pageMetrics, signers = []) => {
  if (!Array.isArray(pageMetrics) || pageMetrics.length <= 2) return [];

  const signerList = Array.isArray(signers) && signers.length
    ? signers
    : [{ email: '', role: 'Signatory' }];
  const width = 54;
  const height = 24;
  const gap = 8;
  const margin = 36;
  const totalWidth = signerList.length * width + Math.max(0, signerList.length - 1) * gap;

  return pageMetrics.slice(1, -1).flatMap((metric, pageOffset) => {
    const pageWidth = finiteNumber(metric.width, 612) || 612;
    const pageNumber = metric.page || pageOffset + 2;
    const startX = Math.max(margin, pageWidth - margin - totalWidth);

    return signerList.map((signer, signerIndex) => ({
      source: 'heuristic-keyword',
      detector: 'middle-page-initials-policy',
      type: 'initials',
      page: pageNumber,
      x: startX + signerIndex * (width + gap),
      y: 30,
      width,
      height,
      confidence: 0.9,
      context: `Middle-page initials ${signer.role || signer.name || `Signer ${signerIndex + 1}`}`,
      assignedTo: signer.email || '',
      role: signer.role || '',
      required: true,
      signerIndex,
      detection: {
        signerIndex,
        policy: 'every-page-except-first-and-last',
      },
    }));
  });
};

const getPdfPageMetrics = async (pdfPath) => {
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return pdfDoc.getPages().map((page, index) => {
    const size = page.getSize();
    return {
      page: index + 1,
      width: size.width,
      height: size.height,
      rotation: page.getRotation().angle || 0,
    };
  });
};

const normalizeDocumentToPdf = (doc) => new Promise((resolve, reject) => {
  if (doc.type === 'pdf') {
    resolve({
      pdfPath: doc.path,
      converted: false,
      diagnostics: { provider: 'normalizer', sourceType: 'pdf', converted: false },
    });
    return;
  }

  if (!['docx', 'doc'].includes(doc.type)) {
    reject(new Error('Automated signing preparation currently requires PDF, DOC, or DOCX input.'));
    return;
  }

  if (!fs.existsSync(NORMALIZED_DIR)) fs.mkdirSync(NORMALIZED_DIR, { recursive: true });
  const libreOffice = process.env.LIBREOFFICE_BIN || 'soffice';
  const child = spawn(libreOffice, [
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    NORMALIZED_DIR,
    doc.path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error('DOCX to PDF normalization timed out. Install LibreOffice or upload a PDF source.'));
  }, Number(process.env.IDP_NORMALIZE_TIMEOUT_MS) || 30000);

  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    clearTimeout(timeout);
    reject(new Error(`DOCX to PDF normalization failed: ${error.message}`));
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    const expected = path.join(
      NORMALIZED_DIR,
      `${path.basename(doc.path, path.extname(doc.path))}.pdf`
    );
    if (code !== 0 || !fs.existsSync(expected)) {
      reject(new Error(`DOCX to PDF normalization failed. ${stderr.trim() || 'LibreOffice did not produce a PDF.'}`));
      return;
    }
    resolve({
      pdfPath: expected,
      converted: true,
      diagnostics: {
        provider: 'normalizer',
        sourceType: doc.type,
        converted: true,
        output: expected,
      },
    });
  });
});

const normalizePdfField = (field, pageMetrics) => {
  const pageNumber = Math.max(1, Number(field.page) || 1);
  const page = pageMetrics[pageNumber - 1] || pageMetrics[0] || { width: 612, height: 792 };
  const width = Math.max(24, Math.min(Number(field.width) || 180, page.width));
  const height = Math.max(16, Math.min(Number(field.height) || 36, page.height));
  const x = Math.max(0, Math.min(Number(field.x) || 0, page.width - width));
  const y = Math.max(0, Math.min(Number(field.y) || 0, page.height - height));

  return {
    id: field.id,
    type: normalizeFieldType(field),
    page: pageNumber,
    x,
    y,
    width,
    height,
    assignedTo: field.assignedTo || '',
    role: field.role || '',
    required: field.required !== false,
    filled: false,
    fieldMeta: field.fieldMeta,
    source: field.source || 'heuristic-default',
    confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 0.5,
    anchor: field.anchor || '',
    context: field.context || field.name || '',
    coordinateOrigin: 'pdf',
    detection: {
      ...(field.detection || {}),
      detector: field.detector || field.source || 'unknown',
      rawType: field.rawType || '',
      pageWidth: page.width,
      pageHeight: page.height,
      signerIndex: fieldSignerIndex(field),
    },
  };
};

const overlapRatio = (a, b) => {
  if (a.page !== b.page) return 0;
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y, b.y);
  const top = Math.min(a.y + a.height, b.y + b.height);
  const area = Math.max(0, right - left) * Math.max(0, top - bottom);
  const minArea = Math.min(a.width * a.height, b.width * b.height) || 1;
  return area / minArea;
};

const centerDistance = (a, b) => {
  if (a.page !== b.page) return Number.POSITIVE_INFINITY;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
};

const looksLikeSameFieldPosition = (a, b) => {
  if (a.page !== b.page) return false;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  const xDelta = Math.abs(ax - bx);
  const yDelta = Math.abs(ay - by);
  const widthDelta = Math.abs(a.width - b.width);
  return centerDistance(a, b) < 28 &&
    xDelta <= Math.max(8, Math.min(a.width, b.width) * 0.08) &&
    yDelta <= Math.max(6, Math.min(a.height, b.height) * 0.35) &&
    widthDelta <= Math.max(16, Math.max(a.width, b.width) * 0.15);
};

const mergeFields = (fields, pageMetrics) => {
  const normalized = fields
    .map((field) => normalizePdfField(field, pageMetrics))
    .sort((a, b) => (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0));
  const merged = [];

  for (const field of normalized) {
    const duplicate = merged.find((item) =>
      item.type === field.type &&
      (overlapRatio(item, field) > 0.35 || looksLikeSameFieldPosition(item, field))
    );
    if (!duplicate) merged.push(field);
  }

  return merged
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
    .map((field, index) => ({
      ...field,
      id: field.id || `auto_${field.type}_${field.page}_${index + 1}`,
    }));
};

// Scans text lines across all pages for "FOR:", "SIGNED BY:", "EXECUTED BY:" etc. headers
// that mark where each party's signing block begins. Returns signer block boundaries.
// pageLines: Array<{ pageNumber, lines }> where lines are sorted descending y (top-of-page first).
const inferSignerBlocksFromLines = (pageLines, signers) => {
  const signerList = Array.isArray(signers) ? signers : [];
  const rawBlocks = [];

  for (const { pageNumber, lines } of pageLines) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].text.trim();
      if (!EXEC_BLOCK_HEADER_RE.test(trimmed)) continue;

      // Extract entity label: text after the colon, or the next non-field line if blank
      const afterColon = trimmed.replace(EXEC_BLOCK_HEADER_RE, '').trim();
      let label = afterColon;
      if (!label && lines[i + 1]) {
        const nextText = lines[i + 1].text.trim();
        if (!FIELD_LINE_RE.test(nextText) && !EXEC_BLOCK_HEADER_RE.test(nextText)) {
          label = nextText;
        }
      }

      rawBlocks.push({ pageNumber, y: lines[i].y, x: lines[i].x || 0, rawLabel: label });
    }
  }

  // Need at least 2 blocks to trigger spatial assignment
  if (rawBlocks.length < 2) return { signerBlocks: [], hasBlocks: false };

  // Sort top-to-bottom: ascending page, descending y within page
  rawBlocks.sort((a, b) => a.pageNumber - b.pageNumber || b.y - a.y);

  // Match blocks to signers: try name/role substring match first, fall back to order
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const assignedSigners = new Set();

  const signerBlocks = rawBlocks.map((block) => {
    const labelNorm = normalize(block.rawLabel);
    let bestIndex = -1;
    let bestScore = 0;

    for (let si = 0; si < signerList.length; si++) {
      if (assignedSigners.has(si)) continue;
      const nameNorm = normalize(signerList[si]?.name);
      const roleNorm = normalize(signerList[si]?.role);
      let score = 0;
      if (labelNorm && nameNorm && labelNorm.includes(nameNorm) && nameNorm.length > 2) score = 2;
      else if (labelNorm && roleNorm && labelNorm.includes(roleNorm) && roleNorm.length > 2) score = 1;
      if (score > bestScore) { bestScore = score; bestIndex = si; }
    }

    // Fall back to next unassigned signer in order
    if (bestIndex < 0) {
      for (let si = 0; si < Math.max(signerList.length, rawBlocks.length); si++) {
        if (!assignedSigners.has(si)) { bestIndex = si; break; }
      }
    }

    if (bestIndex >= 0) assignedSigners.add(bestIndex);
    return { pageNumber: block.pageNumber, y: block.y, x: block.x || 0, signerIndex: bestIndex >= 0 ? bestIndex : 0 };
  });

  return { signerBlocks, hasBlocks: true };
};

// Tags each field with the signerIndex of the nearest "FOR:" block above it.
// Fields with detection.signerIndex already set (e.g. from anchors) are left unchanged.
const assignFieldsBySignerBlocks = (fields, signerBlocks) => {
  if (!signerBlocks.length) return fields;

  return fields.map((field) => {
    if (Number.isInteger(field.detection?.signerIndex)) return field;

    const fieldPage = field.page || 1;
    const fieldY = finiteNumber(field.y);

    // Blocks on the same page whose header sits above this field (larger PDF y)
    // Allow 4 px slack so a field whose baseline touches the FOR: line still matches
    const aboveSamePage = signerBlocks.filter(
      (b) => b.pageNumber === fieldPage && b.y > fieldY - 4
    );

    if (aboveSamePage.length > 0) {
      // Primary sort: smallest vertical distance above field (closest header wins).
      // Tiebreaker for same-y blocks (side-by-side columns): smallest horizontal
      // distance from the block header's left edge to the field's centre.
      const fieldCenterX = finiteNumber(field.x) + finiteNumber(field.width) / 2;
      const nearest = aboveSamePage.reduce((best, b) => {
        const bDy = b.y - fieldY;
        const bestDy = best.y - fieldY;
        if (Math.abs(bDy - bestDy) > 20) return bDy < bestDy ? b : best;
        const bDx = Math.abs((b.x || 0) - fieldCenterX);
        const bestDx = Math.abs((best.x || 0) - fieldCenterX);
        return bDx < bestDx ? b : best;
      });
      return {
        ...field,
        detection: {
          ...(field.detection || {}),
          signerIndex: nearest.signerIndex,
          signerAssignmentSource: 'signer-block',
        },
      };
    }

    // Field is above all blocks on its page, or its block started on a previous page
    const prevPageBlock = signerBlocks
      .filter((b) => b.pageNumber < fieldPage)
      .sort((a, b) => b.pageNumber - a.pageNumber || b.y - a.y)[0];

    if (prevPageBlock) {
      return {
        ...field,
        detection: {
          ...(field.detection || {}),
          signerIndex: prevPageBlock.signerIndex,
          signerAssignmentSource: 'signer-block',
        },
      };
    }

    return field;
  });
};

const fieldReadOrder = (a, b) =>
  a.page - b.page || b.y - a.y || a.x - b.x;

const fieldKey = (field) =>
  field.id || `${field.type}:${field.page}:${Math.round(field.x)}:${Math.round(field.y)}:${Math.round(field.width)}`;

const explicitSignerIndex = (field) => {
  if (Number.isInteger(field.signerIndex)) return field.signerIndex;
  if (
    Number.isInteger(field.detection?.signerIndex) &&
    field.detection?.signerAssignmentSource !== 'signer-block'
  ) {
    return field.detection.signerIndex;
  }
  return parseSignerIndex(field.name || field.anchor || field.context || '');
};

const softSignerBlockIndex = (field) => {
  if (
    Number.isInteger(field.detection?.signerIndex) &&
    field.detection?.signerAssignmentSource === 'signer-block'
  ) {
    return field.detection.signerIndex;
  }
  return null;
};

const nearestSignatureAnchor = (field, anchors = []) => {
  if (!anchors.length || field.type === 'signature') return null;
  const fieldCenterX = finiteNumber(field.x) + finiteNumber(field.width) / 2;
  const fieldCenterY = finiteNumber(field.y) + finiteNumber(field.height) / 2;
  const fieldWidth = Math.max(1, finiteNumber(field.width, 1));
  const isClauseFragment = Boolean(field.detection?.clauseLineId || field.detection?.isInlineDateClause);
  let best = null;

  for (const anchor of anchors) {
    const signature = anchor.field;
    if ((signature.page || 1) !== (field.page || 1)) continue;

    const sigCenterX = finiteNumber(signature.x) + finiteNumber(signature.width) / 2;
    const sigCenterY = finiteNumber(signature.y) + finiteNumber(signature.height) / 2;
    const dy = Math.abs(sigCenterY - fieldCenterY);
    const signatureBelow = sigCenterY < fieldCenterY;
    const signatureAbove = sigCenterY > fieldCenterY;
    const maxDy = isClauseFragment ? 260 : field.type === 'date' ? 130 : 150;
    if (dy > maxDy) continue;

    const xOverlap = rangesOverlap(
      field.x, field.x + field.width,
      signature.x, signature.x + signature.width
    );
    const overlapRatioX = xOverlap / Math.min(fieldWidth, Math.max(1, finiteNumber(signature.width, 1)));
    const dx = Math.abs(sigCenterX - fieldCenterX);
    const closeEnoughX = isClauseFragment
      ? overlapRatioX >= 0.05 || dx <= Math.max(320, finiteNumber(signature.width, 1))
      : overlapRatioX >= 0.1 || dx <= Math.max(180, finiteNumber(signature.width, 1) * 0.75);
    if (!closeEnoughX) continue;

    let score = dy * 2 + dx * 0.15 - overlapRatioX * 80;
    if (isClauseFragment) score += signatureBelow ? -220 : 220;
    else if (field.type === 'date' && dy <= 36) score -= 80;
    else if (signatureAbove && dy <= 120) score -= 40;

    if (!best || score < best.score) best = { ...anchor, score };
  }

  return best;
};

const SIGNING_GROUP_START_RE = /^\s*(?:signed\s+(?:at|on)|dated\s+at)\b/i;

const startsSequentialSigningGroup = (field) => {
  if (!['text', 'date', 'number'].includes(field.type)) return false;
  const context = String(field.context || field.detection?.lineText || '').trim();
  if (!SIGNING_GROUP_START_RE.test(context)) return false;
  if (field.detection?.isInlineDateClause) {
    return !field.detection.fragmentRole || field.detection.fragmentRole === 'execution-place';
  }
  return true;
};

const sequentialSigningGroupAssignments = (orderedFields, signerCount) => {
  const assignments = new Map();
  let currentGroup = null;
  let groupIndex = -1;

  for (const field of orderedFields) {
    if (startsSequentialSigningGroup(field)) {
      groupIndex += 1;
      currentGroup = {
        page: field.page || 1,
        signerIndex: groupIndex % signerCount,
      };
    }

    if (!currentGroup || (field.page || 1) !== currentGroup.page) continue;
    assignments.set(fieldKey(field), currentGroup.signerIndex);
  }

  return assignments;
};

const assignFieldsToSigners = (fields, signers = []) => {
  const signerList = Array.isArray(signers) ? signers : [];
  const signerCount = Math.max(1, signerList.length);
  const ordered = [...fields].sort(fieldReadOrder);
  const groupSignerByKey = sequentialSigningGroupAssignments(ordered, signerCount);
  const signatureSignerByKey = new Map();
  let nextSignatureSigner = 0;

  for (const field of ordered) {
    if (field.type !== 'signature') continue;
    const explicit = explicitSignerIndex(field);
    const signerIndex = Number.isInteger(explicit)
      ? explicit
      : nextSignatureSigner % signerCount;
    signatureSignerByKey.set(fieldKey(field), signerIndex);
    nextSignatureSigner = Math.max(nextSignatureSigner + (Number.isInteger(explicit) ? 0 : 1), signerIndex + 1);
  }

  const anchors = ordered
    .filter((field) => field.type === 'signature')
    .map((field) => ({ field, signerIndex: signatureSignerByKey.get(fieldKey(field)) ?? 0 }));

  const fallbackSignerByClause = new Map();
  let fallbackCounter = 0;

  return fields.map((field) => {
    let signerIndex = explicitSignerIndex(field);

    if (!Number.isInteger(signerIndex) && field.type === 'signature') {
      signerIndex = signatureSignerByKey.get(fieldKey(field)) ?? 0;
    }

    if (!Number.isInteger(signerIndex)) {
      const anchor = nearestSignatureAnchor(field, anchors);
      if (anchor) signerIndex = anchor.signerIndex;
    }

    if (!Number.isInteger(signerIndex)) {
      signerIndex = groupSignerByKey.get(fieldKey(field));
    }

    if (!Number.isInteger(signerIndex)) {
      signerIndex = softSignerBlockIndex(field);
    }

    if (!Number.isInteger(signerIndex)) {
      const clauseId = field.detection?.clauseLineId;
      if (clauseId) {
        if (!fallbackSignerByClause.has(clauseId)) {
          fallbackSignerByClause.set(clauseId, fallbackCounter % signerCount);
        }
        signerIndex = fallbackSignerByClause.get(clauseId);
      } else if (field.type === 'date' || field.type === 'initials') {
        signerIndex = fallbackCounter % signerCount;
        fallbackCounter += 1;
      } else {
        signerIndex = Math.max(0, Math.min(signerCount - 1, fallbackCounter));
      }
    }

    const signer = signerIndex >= 0 ? signerList[signerIndex % signerCount] : null;
    return {
      ...field,
      assignedTo: field.assignedTo || signer?.email || '',
      role: field.role || signer?.role || '',
      detection: {
        ...(field.detection || {}),
        signerIndex,
      },
    };
  });
};

const extractAnchorsWithPdfJs = async (pdfPath, pageMetrics) => {
  const diagnostics = { provider: 'pdfjs-dist', available: false, fields: 0 };
  let pdfjsLib;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    diagnostics.error = `pdfjs-dist unavailable: ${error.message}`;
    return { fields: [], diagnostics };
  }

  diagnostics.available = true;
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
  const pdf = await loadingTask.promise;
  const fields = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent({ includeMarkedContent: false });
    const metric = pageMetrics[pageNumber - 1] || page.getViewport({ scale: 1 });

    for (const item of text.items || []) {
      const value = item.str || '';
      if (!value.includes('{{')) continue;
      for (const match of value.matchAll(ANCHOR_PATTERN)) {
        const charWidth = value.length ? (Number(item.width) || 0) / value.length : 0;
        const [, , , , rawX, rawY] = item.transform || [1, 0, 0, 1, 0, 0];
        const fieldWidth = Math.max(110, Math.min(260, (match[0].length * charWidth) || 160));
        const fieldHeight = 32;

        fields.push({
          source: 'anchor',
          detector: 'pdfjs-text-layer',
          anchor: match[0],
          name: match[1],
          type: inferFieldType(match[1]),
          page: pageNumber,
          x: rawX + match.index * charWidth,
          y: Math.max(0, rawY - 8),
          width: fieldWidth,
          height: fieldHeight,
          confidence: 1,
          context: match[1],
          pageWidth: metric.width,
          pageHeight: metric.height,
        });
      }
    }
  }

  diagnostics.fields = fields.length;
  return { fields, diagnostics };
};

const detectLayoutFieldsWithPdfJs = async (pdfPath, pageMetrics, signers = []) => {
  const diagnostics = {
    provider: 'pdfjs-layout-lines',
    available: false,
    fields: 0,
    signatureFields: 0,
    dateFields: 0,
    initialsFields: 0,
  };
  let pdfjsLib;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    diagnostics.error = `pdfjs-dist unavailable: ${error.message}`;
    return { fields: [], diagnostics };
  }

  diagnostics.available = true;
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
  const pdf = await loadingTask.promise;
  let fields = [];
  const pageLines = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent({ includeMarkedContent: false });
    const operatorList = await page.getOperatorList();
    const metric = pageMetrics[pageNumber - 1] || page.getViewport({ scale: 1 });
    const lines = buildTextLines(text.items || []);
    pageLines.push({ pageNumber, lines });
    const pathGeometry = pathGeometryFromOperatorList(operatorList, metric, pdfjsLib.OPS || {});
    fields = fields.concat(textLayoutFieldsFromLines(
      lines,
      pageNumber,
      metric,
      signers,
      pathGeometry.horizontalLines,
      pathGeometry.tableCells
    ));
  }

  // Detect "FOR:" / "SIGNED BY:" execution blocks and reassign fields spatially.
  // When blocks are found, each field is tagged with the signerIndex of the block
  // it falls under, overriding the sequential round-robin in textLayoutFieldsFromLines.
  const { signerBlocks, hasBlocks } = inferSignerBlocksFromLines(pageLines, signers);
  if (hasBlocks) {
    fields = assignFieldsBySignerBlocks(fields, signerBlocks);
    diagnostics.signerBlocksDetected = signerBlocks.length;
  }

  const initialFields = buildMiddlePageInitialFields(pageMetrics, signers);
  fields = fields.concat(initialFields);

  diagnostics.fields = fields.length;
  diagnostics.signatureFields = fields.filter((field) => field.type === 'signature').length;
  diagnostics.dateFields = fields.filter((field) => field.type === 'date').length;
  diagnostics.initialsFields = initialFields.length;
  return { fields, diagnostics };
};

const detectWithTextract = async (pdfPath, pageMetrics) => {
  const diagnostics = { provider: 'textract', enabled: process.env.AWS_TEXTRACT_ENABLED === 'true', fields: 0 };
  if (!diagnostics.enabled) return { fields: [], diagnostics };

  const textract = optionalRequire('@aws-sdk/client-textract');
  if (!textract) {
    diagnostics.error = '@aws-sdk/client-textract is not installed';
    return { fields: [], diagnostics };
  }

  const { TextractClient, AnalyzeDocumentCommand } = textract;
  const client = new TextractClient({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });
  const response = await client.send(new AnalyzeDocumentCommand({
    Document: { Bytes: fs.readFileSync(pdfPath) },
    FeatureTypes: ['FORMS', 'SIGNATURES', 'LAYOUT'],
  }));

  const fields = [];
  const blocks = response.Blocks || [];
  for (const block of blocks) {
    const text = block.Text || '';
    const isDetectedSignature = block.BlockType === 'SIGNATURE';
    const isKeyword = block.BlockType === 'LINE' && (SIGNATURE_WORDS.test(text) || DATE_WORDS.test(text) || INITIAL_WORDS.test(text));
    if (!isDetectedSignature && !isKeyword) continue;

    const metric = pageMetrics[(block.Page || 1) - 1] || { width: 612, height: 792 };
    const box = block.Geometry?.BoundingBox || {};
    const width = Math.max(100, (Number(box.Width) || 0.2) * metric.width);
    const height = Math.max(28, (Number(box.Height) || 0.04) * metric.height);
    const x = (Number(box.Left) || 0) * metric.width;
    const top = (Number(box.Top) || 0) * metric.height;

    fields.push({
      source: 'textract',
      detector: 'amazon-textract',
      rawType: block.BlockType,
      type: isDetectedSignature ? 'signature' : inferFieldType(text),
      page: block.Page || 1,
      x,
      y: metric.height - top - height - (isKeyword ? 8 : 0),
      width,
      height,
      confidence: (Number(block.Confidence) || 0) / 100,
      context: text,
    });
  }

  diagnostics.fields = fields.length;
  diagnostics.modelVersion = response.AnalyzeDocumentModelVersion;
  return { fields, diagnostics };
};

const detectWithLayoutLm = async (pdfPath, pageMetrics) => {
  const endpoint = process.env.LAYOUTLMV3_ENDPOINT;
  const diagnostics = { provider: 'layoutlmv3', enabled: Boolean(endpoint), fields: 0 };
  if (!endpoint) return { fields: [], diagnostics };

  const fetch = optionalRequire('node-fetch');
  if (!fetch) {
    diagnostics.error = 'node-fetch is not installed';
    return { fields: [], diagnostics };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.LAYOUTLMV3_API_KEY ? { Authorization: `Bearer ${process.env.LAYOUTLMV3_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      documentBase64: fs.readFileSync(pdfPath).toString('base64'),
      pageMetrics,
      task: 'signing-field-detection',
      labels: ['signature', 'date', 'initials', 'text'],
    }),
  });

  if (!response.ok) {
    diagnostics.error = `LayoutLMv3 endpoint returned ${response.status}`;
    return { fields: [], diagnostics };
  }

  const payload = await response.json();
  const fields = (payload.fields || []).map((field) => ({
    ...field,
    source: 'layoutlmv3',
    detector: field.detector || 'layoutlmv3-endpoint',
    confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 0.75,
  }));

  diagnostics.fields = fields.length;
  diagnostics.modelVersion = payload.modelVersion;
  return { fields, diagnostics };
};

const runPythonDetector = (pdfPath, pageMetrics) => new Promise((resolve) => {
  const diagnostics = { provider: 'python-opencv-tesseract', enabled: process.env.IDP_DISABLE_PYTHON_FALLBACK !== 'true', fields: 0 };
  if (!diagnostics.enabled) return resolve({ fields: [], diagnostics });

  const script = process.env.IDP_PYTHON_WORKER || path.join(__dirname, '../../idp/detect_fields.py');
  if (!fs.existsSync(script)) {
    diagnostics.error = 'Python IDP worker script not found';
    return resolve({ fields: [], diagnostics });
  }

  const python = process.env.IDP_PYTHON_BIN || 'python3';
  const child = spawn(python, [script, pdfPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IDP_PAGE_METRICS: JSON.stringify(pageMetrics),
    },
  });

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    diagnostics.error = 'Python IDP worker timed out';
    child.kill('SIGTERM');
  }, Number(process.env.IDP_PYTHON_TIMEOUT_MS) || 25000);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    clearTimeout(timeout);
    diagnostics.error = error.message;
    resolve({ fields: [], diagnostics });
  });
  child.on('close', () => {
    clearTimeout(timeout);
    try {
      const parsed = stdout ? JSON.parse(stdout) : {};
      diagnostics.fields = parsed.fields?.length || 0;
      diagnostics.worker = parsed.diagnostics || {};
      if (stderr.trim()) diagnostics.stderr = stderr.trim().slice(0, 1000);
      resolve({
        fields: (parsed.fields || []).map((field) => ({
          ...field,
          source: field.source || 'opencv-ocr',
          detector: field.detector || 'python-idp-worker',
        })),
        diagnostics,
      });
    } catch (error) {
      diagnostics.error = error.message;
      diagnostics.stderr = stderr.trim().slice(0, 1000);
      resolve({ fields: [], diagnostics });
    }
  });
});

const buildDefaultFields = (pageMetrics, signers = []) => {
  const page = pageMetrics[pageMetrics.length - 1] || { page: 1, width: 612, height: 792 };
  const signerList = Array.isArray(signers) && signers.length ? signers : [{ role: 'Signatory', email: '' }];

  return signerList.flatMap((signer, index) => {
    const y = Math.max(72, 96 + index * 82);
    return [
      {
        source: 'heuristic-default',
        detector: 'last-page-signature-block',
        type: 'signature',
        page: page.page,
        x: 72,
        y,
        width: Math.min(240, page.width - 144),
        height: 46,
        confidence: 0.25,
        context: signer.role || `Signer ${index + 1}`,
        assignedTo: signer.email || '',
        role: signer.role || '',
      },
      {
        source: 'heuristic-default',
        detector: 'last-page-date-block',
        type: 'date',
        page: page.page,
        x: Math.min(340, page.width - 190),
        y,
        width: 150,
        height: 28,
        confidence: 0.25,
        context: `${signer.role || `Signer ${index + 1}`} date`,
        assignedTo: signer.email || '',
        role: signer.role || '',
      },
    ];
  });
};

const prepareSigningDocument = async ({ doc, signers = [], strategy = {} }) => {
  if (!doc?.path || !fs.existsSync(doc.path)) {
    throw new Error('Document file is not available for IDP preparation.');
  }

  const normalized = await normalizeDocumentToPdf(doc);
  const pageMetrics = await getPdfPageMetrics(normalized.pdfPath);
  const sourceFileHash = sha256File(normalized.pdfPath);
  const diagnostics = [normalized.diagnostics];

  const anchorResult = await extractAnchorsWithPdfJs(normalized.pdfPath, pageMetrics);
  diagnostics.push(anchorResult.diagnostics);

  const layoutLineResult = strategy.skipLayoutLines
    ? { fields: [], diagnostics: { provider: 'pdfjs-layout-lines', skipped: true } }
    : await detectLayoutFieldsWithPdfJs(normalized.pdfPath, pageMetrics, signers).catch((error) => ({
      fields: [],
      diagnostics: { provider: 'pdfjs-layout-lines', error: error.message },
    }));
  diagnostics.push(layoutLineResult.diagnostics);

  const textractResult = await detectWithTextract(normalized.pdfPath, pageMetrics).catch((error) => ({
    fields: [],
    diagnostics: { provider: 'textract', error: error.message },
  }));
  diagnostics.push(textractResult.diagnostics);

  const visionResult = strategy.skipVision ? { fields: [], diagnostics: { provider: 'yolo-cv', skipped: true } }
    : await visionFieldDetection.detectVisionFields({ pdfPath: normalized.pdfPath, pageMetrics }).catch((error) => ({
      fields: [],
      diagnostics: { provider: 'yolo-cv', error: error.message },
    }));
  diagnostics.push(visionResult.diagnostics);

  const layoutLmResult = await detectWithLayoutLm(normalized.pdfPath, pageMetrics).catch((error) => ({
    fields: [],
    diagnostics: { provider: 'layoutlmv3', error: error.message },
  }));
  diagnostics.push(layoutLmResult.diagnostics);

  const pythonResult = strategy.skipFallback ? { fields: [], diagnostics: { provider: 'python-opencv-tesseract', skipped: true } }
    : await runPythonDetector(normalized.pdfPath, pageMetrics);
  diagnostics.push(pythonResult.diagnostics);

  let candidates = [
    ...anchorResult.fields,
    ...layoutLineResult.fields,
    ...visionResult.fields,
    ...textractResult.fields,
    ...layoutLmResult.fields,
    ...pythonResult.fields,
  ];

  const hasSignatureField = candidates.some((field) => field.type === 'signature');
  const hasDateField = candidates.some((field) =>
    field.type === 'date' ||
    (
      field.detection?.isInlineDateClause &&
      ['day', 'month', 'year'].includes(field.detection?.fragmentRole)
    )
  );
  if (!hasSignatureField || !hasDateField) {
    const defaultFields = buildDefaultFields(pageMetrics, signers)
      .filter((field) =>
        (!hasSignatureField && field.type === 'signature') ||
        (!hasDateField && field.type === 'date'));
    candidates = candidates.concat(defaultFields);
    diagnostics.push({
      provider: 'heuristic-default',
      fields: defaultFields.length,
      addedSignatureFallback: !hasSignatureField,
      addedDateFallback: !hasDateField,
      reviewRequired: Boolean(defaultFields.length),
    });
  }

  const fields = assignFieldsToSigners(
    resolveFieldOverlaps(mergeFields(candidates, pageMetrics)),
    signers,
  );
  const reviewRequired = fields.some((field) => field.confidence < 0.75 || field.source === 'heuristic-default');
  const fieldsHash = crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');

  return {
    fields,
    metadata: {
      status: reviewRequired ? 'needs_review' : 'prepared',
      preparedAt: new Date(),
      detectionVersion: IDP_VERSION,
      strategy: {
        anchors: true,
        layoutLines: true,
        middlePageInitials: true,
        visionYolo: visionFieldDetection.detectVisionFields ? process.env.IDP_VISION_ENABLED === 'true' || Boolean(process.env.IDP_YOLO_MODEL_PATH || process.env.IDP_VISION_MODEL_PATH || process.env.CV_YOLO_MODEL_PATH) : false,
        textract: process.env.AWS_TEXTRACT_ENABLED === 'true',
        layoutlmv3: Boolean(process.env.LAYOUTLMV3_ENDPOINT),
        pythonFallback: process.env.IDP_DISABLE_PYTHON_FALLBACK !== 'true',
        defaultFallback: true,
      },
      diagnostics,
      pageMetrics,
      sourceFileHash,
      reviewRequired,
      fieldsHash,
      normalizedPdfPath: normalized.pdfPath,
      normalizedFromOffice: normalized.converted,
    },
  };
};

module.exports = {
  IDP_VERSION,
  prepareSigningDocument,
  normalizeDocumentToPdf,
  extractAnchorsWithPdfJs,
  detectLayoutFieldsWithPdfJs,
  getPdfPageMetrics,
  mergeFields,
  assignFieldsToSigners,
  buildMiddlePageInitialFields,
  textLayoutFieldsFromLines,
  pathGeometryFromOperatorList,
  detectWithLayoutLm,
  inferFieldType,
};
