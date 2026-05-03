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
const UNDERLINE_RUN_PATTERN = /_{4,}/g;
const EXPLICIT_DATE_WORDS = /\b(date|dated)\b/i;
const LEGAL_DATE_TEXT_WORDS = /\b(on this|day of)\b/gi;
const SIGNATURE_LINE_WORDS = /\b(sign|signature|sign here|signed by|authorized signatory|signatory|for and on behalf)\b/i;
const EXECUTION_PLACE_WORDS = /\bsigned\s+at\b/i;
const TEXT_LINE_WORDS = /\b(full name|print name|printed name|name|title|capacity)\b/i;
const NON_SIGNATURE_FIELD_WORDS = /\b(full name|print name|printed name|name|capacity|title|address)\b\s*:?/i;
const TEXT_WORD_PATTERN = /\b[A-Za-z][A-Za-z0-9'-]*\b/g;
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
    y: Math.max(0, run.y - 8),
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

const textItemBoxes = (line, metric = {}) => {
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

const legalDateValueFieldsFromLine = (line, pageNumber, metric, runs = line.runs) => {
  if (!runs.length) return [];

  const fields = [];
  for (const cueMatch of line.text.matchAll(LEGAL_DATE_TEXT_WORDS)) {
    const cueIndex = cueMatch.index;
    const cueEnd = cueIndex + cueMatch[0].length;
    const match = firstRunAfterTextIndex(line, runs, cueEnd);
    if (!match) continue;

    fields.push(fieldFromUnderlineRun({
      type: 'text',
      pageNumber,
      metric,
      run: match.run,
      context: line.text,
      confidence: 0.78,
      detector: 'pdfjs-text-underline-legal-date-text',
      detection: {
        cue: line.text.slice(cueIndex, Math.min(line.text.length, cueIndex + 40)).trim(),
        nextText: match.nextWord?.text || '',
        underlineRunCount: 1,
      },
    }));
  }

  const numberPattern = /\d+(?=_|\b)/g;
  for (const numberMatch of line.text.matchAll(numberPattern)) {
    const cueIndex = numberMatch.index;
    const cueEnd = cueIndex + numberMatch[0].length;
    const match = firstRunAfterTextIndex(line, runs, cueEnd);
    if (!match) continue;

    const duplicate = fields.some((field) =>
      overlapRatio(field, {
        page: pageNumber,
        x: match.run.x,
        y: Math.max(0, match.run.y - 8),
        width: match.run.width,
        height: 28,
      }) > 0.35
    );
    if (duplicate) continue;

    fields.push(fieldFromUnderlineRun({
      type: 'number',
      pageNumber,
      metric,
      run: match.run,
      context: line.text,
      confidence: 0.76,
      detector: 'pdfjs-text-underline-number',
      detection: {
        cue: numberMatch[0],
        nextText: match.nextWord?.text || '',
        underlineRunCount: 1,
      },
    }));
  }

  return fields;
};

const signatureConfidenceForContext = (lineText, neighborText) => {
  const context = `${lineText} ${neighborText}`;
  if (NON_SIGNATURE_FIELD_WORDS.test(lineText)) return 0;
  if (EXECUTION_PLACE_WORDS.test(lineText) && !SIGNATURE_LINE_WORDS.test(lineText)) return 0;
  if (/\bfor and on behalf\b/i.test(context)) return 0.88;
  if (SIGNATURE_LINE_WORDS.test(context)) return 0.86;
  if (/\bsigned by\b/i.test(context)) return 0.82;
  if (/\bwitness\b/i.test(context)) return 0.58;
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

const lineTextBox = (line, metric = {}) => {
  const bounds = lineBounds(line, metric);
  const height = Math.max(10, bounds.height || 10);
  return {
    x: bounds.x,
    y: Math.max(0, bounds.y - Math.min(3, height * 0.25)),
    width: Math.max(0, bounds.right - bounds.x),
    height: height + 4,
    right: bounds.right,
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

const textBoxesInCell = (lines, cell, metric) =>
  lines
    .flatMap((line) => textItemBoxes(line, metric))
    .filter((box) =>
      box.width > 0 &&
      box.y + box.height >= cell.y - 2 &&
      box.y <= cell.y + cell.height + 2 &&
      rangesOverlap(box.x, box.x + box.width, cell.x, cell.x + cell.width) > 0
    )
    .map((box) => ({
      x: Math.max(cell.x, box.x - 2),
      y: Math.max(cell.y, box.y - 2),
      width: Math.min(cell.x + cell.width, box.x + box.width + 2) - Math.max(cell.x, box.x - 2),
      height: Math.min(cell.y + cell.height, box.y + box.height + 2) - Math.max(cell.y, box.y - 2),
    }))
    .filter((box) => box.width > 0 && box.height > 0);

const cellHasText = (cell, lines, metric) =>
  textBoxesInCell(lines, cell, metric)
    .some((box) => cellContainsRectCenter(cell, box) || rectOverlapRatio(cell, box) > 0.02);

const tableFieldTypeForLine = (lineText = '') => {
  if (DATE_WORDS.test(lineText)) return 'date';
  if (TEXT_LINE_WORDS.test(lineText)) return 'text';
  if (SIGNATURE_LINE_WORDS.test(lineText) && !NON_SIGNATURE_FIELD_WORDS.test(lineText)) return 'signature';
  return null;
};

const tableFieldHeightForType = (type, cellHeight) => {
  if (type === 'signature') return Math.max(28, cellHeight);
  if (type === 'date') return Math.max(22, Math.min(32, cellHeight));
  return Math.max(24, Math.min(34, cellHeight));
};

const chooseTableFieldGeometry = ({ type, line, targetCell, lines, existingFields, pageNumber, metric }) => {
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

  const minWidth = type === 'signature' ? 80 : 36;
  const minHeight = type === 'signature' ? 24 : 18;
  const desiredHeight = tableFieldHeightForType(type, inner.height);
  const lineBox = lineTextBox(line, metric);
  const textBlockers = textBoxesInCell(lines, targetCell, metric);
  const fieldBlockers = existingFields
    .filter((field) => field.page === pageNumber && cellContainsRectCenter(targetCell, field))
    .map((field) => ({ x: field.x, y: field.y, width: field.width, height: field.height }));
  const blockers = [...textBlockers, ...fieldBlockers];
  const candidates = [];

  const pushCandidate = (candidate) => {
    const x = Math.max(inner.x, candidate.x);
    const y = Math.max(inner.y, candidate.y);
    const right = Math.min(inner.x + inner.width, candidate.x + candidate.width);
    const top = Math.min(inner.y + inner.height, candidate.y + candidate.height);
    const width = right - x;
    const height = top - y;
    if (width < minWidth || height < minHeight) return;
    const rect = {
      x,
      y: y + Math.max(0, (height - Math.min(height, desiredHeight)) / 2),
      width: Math.min(width, pageWidth - x),
      height: Math.min(height, desiredHeight),
    };
    const overlap = blockers.reduce((max, blocker) => Math.max(max, rectOverlapRatio(rect, blocker)), 0);
    candidates.push({
      ...rect,
      overlap,
      score: rect.width * rect.height - overlap * 100000,
    });
  };

  pushCandidate(inner);

  const rowBlockers = blockers.filter((blocker) =>
    rangesOverlap(blocker.y, blocker.y + blocker.height, lineBox.y, lineBox.y + lineBox.height) > 0
  );
  if (rowBlockers.length) {
    const rowRight = Math.max(...rowBlockers.map((blocker) => blocker.x + blocker.width));
    pushCandidate({
      x: rowRight + 6,
      y: inner.y,
      width: inner.x + inner.width - rowRight - 6,
      height: inner.height,
    });
  }

  for (const blocker of blockers) {
    pushCandidate({
      x: inner.x,
      y: inner.y,
      width: inner.width,
      height: blocker.y - inner.y - 3,
    });
    pushCandidate({
      x: inner.x,
      y: blocker.y + blocker.height + 3,
      width: inner.width,
      height: inner.y + inner.height - blocker.y - blocker.height - 3,
    });
    pushCandidate({
      x: blocker.x + blocker.width + 6,
      y: inner.y,
      width: inner.x + inner.width - blocker.x - blocker.width - 6,
      height: inner.height,
    });
  }

  const cleanCandidates = candidates.filter((candidate) => candidate.overlap <= 0.08);
  const chosen = cleanCandidates
    .sort((a, b) => b.score - a.score || b.width - a.width || b.height - a.height)[0];

  if (!chosen) return null;
  return {
    x: Math.max(0, chosen.x),
    y: Math.max(0, chosen.y),
    width: Math.max(minWidth, chosen.width),
    height: chosen.height,
  };
};

const tableFieldsFromCells = (lines, pageNumber, metric, tableCells = []) => {
  if (!Array.isArray(tableCells) || !tableCells.length) return [];
  const pageWidth = finiteNumber(metric.width, 612) || 612;
  const fields = [];

  for (const line of lines) {
    const type = tableFieldTypeForLine(line.text);
    if (!type) continue;

    const bounds = lineBounds(line, metric);
    const labelCells = tableCells
      .filter((cell) =>
        line.y >= cell.y - 4 &&
        line.y <= cell.y + cell.height + 4 &&
        rangesOverlap(bounds.x, bounds.right, cell.x, cell.x + cell.width) > 0
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));
    const labelCell = labelCells[0];
    if (!labelCell) continue;

    const rowCells = tableCells
      .filter((cell) => {
        const overlap = rangesOverlap(labelCell.y, labelCell.y + labelCell.height, cell.y, cell.y + cell.height);
        return overlap / Math.max(1, Math.min(labelCell.height, cell.height)) > 0.7;
      })
      .sort((a, b) => a.x - b.x);
    const rightCell = rowCells.find((cell) =>
      cell.x >= labelCell.x + labelCell.width - 3 &&
      cell.width >= Math.max(90, pageWidth * 0.14) &&
      !cellHasText(cell, lines, metric)
    );
    if (!rightCell) continue;
    const targetCell = rightCell;
    const geometry = chooseTableFieldGeometry({
      type,
      line,
      targetCell,
      lines,
      existingFields: fields,
      pageNumber,
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
      context: line.text.trim(),
      detection: {
        lineText: line.text.trim(),
        tableCell: {
          x: targetCell.x,
          y: targetCell.y,
          width: targetCell.width,
          height: targetCell.height,
        },
      },
    });
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
  const lineFields = fields.filter((field) =>
    ['date', 'text', 'number'].includes(field.type) &&
    String(field.detector || '').startsWith('pdfjs-text-underline')
  );
  const visited = new Set();

  for (const seed of lineFields) {
    if (visited.has(seed)) continue;
    const stack = lineFields
      .filter((field) => {
        if (visited.has(field)) return false;
        const overlap = rangesOverlap(seed.x, seed.x + seed.width, field.x, field.x + field.width);
        const minWidth = Math.min(seed.width, field.width) || 1;
        return overlap / minWidth > 0.35 &&
          Math.abs(finiteNumber(seed.detection?.underlineY, seed.y + 8) - finiteNumber(field.detection?.underlineY, field.y + 8)) <= 42;
      })
      .sort((a, b) => finiteNumber(b.detection?.underlineY, b.y + 8) - finiteNumber(a.detection?.underlineY, a.y + 8));

    if (stack.length < 2) {
      visited.add(seed);
      continue;
    }

    stack.forEach((field) => visited.add(field));
    const gaps = stack.slice(1).map((field, index) =>
      Math.abs(finiteNumber(stack[index].detection?.underlineY, stack[index].y + 8) - finiteNumber(field.detection?.underlineY, field.y + 8))
    ).filter((gap) => gap > 0);
    const minGap = gaps.length ? Math.min(...gaps) : 28;
    const commonHeight = Math.max(14, Math.min(28, minGap - 3));

    for (const field of stack) {
      const underlineY = finiteNumber(field.detection?.underlineY, field.y + 8);
      field.height = commonHeight;
      field.y = Math.max(0, Math.min(pageHeight - commonHeight, underlineY - Math.min(8, commonHeight * 0.35)));
      field.detection = {
        ...(field.detection || {}),
        stackedLineHeight: commonHeight,
      };
    }
  }

  return fields;
};

const textLayoutFieldsFromLines = (lines, pageNumber, metric, signers = [], drawnLines = [], tableCells = []) => {
  const fields = [];

  fields.push(...tableFieldsFromCells(lines, pageNumber, metric, tableCells));

  lines.forEach((line, index) => {
    if (tableFieldTypeForLine(line.text) && lineIntersectsTableCell(line, tableCells, metric)) return;

    const neighborText = [
      lines[index - 1]?.text || '',
      lines[index + 1]?.text || '',
    ].join(' ');
    const runs = lineRunsNearText(line, drawnLines);

    const dateField = dateFieldFromLine(line, pageNumber, metric, runs);
    if (dateField) fields.push(dateField);

    const textField = textFieldFromLine(line, pageNumber, metric, runs);
    if (textField) fields.push(textField);

    fields.push(...legalDateValueFieldsFromLine(line, pageNumber, metric, runs));

    const signatureConfidence = signatureConfidenceForContext(line.text, neighborText);
    if (!signatureConfidence) return;

    const signatureCueIndex = line.text.search(SIGNATURE_LINE_WORDS);
    for (const run of runs) {
      if (dateField && overlapRatio(dateField, {
        type: dateField.type,
        page: pageNumber,
        x: run.x,
        y: Math.max(0, run.y - 8),
        width: run.width,
        height: dateField.height,
      }) > 0.25) continue;
      if (textField && overlapRatio(textField, {
        type: textField.type,
        page: pageNumber,
        x: run.x,
        y: Math.max(0, run.y - 8),
        width: run.width,
        height: textField.height,
      }) > 0.25) continue;
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
  const signerCount = Array.isArray(signers) ? signers.length : 0;
  if (!signerCount) return laidOutFields;

  const capped = [];
  for (const type of ['signature', 'date']) {
    const typeFields = laidOutFields
      .filter((field) => field.type === type)
      .sort((a, b) => b.confidence - a.confidence || a.page - b.page || b.y - a.y || a.x - b.x)
      .slice(0, signerCount)
      .map((field, signerIndex) => ({
        ...field,
        signerIndex,
        detection: {
          ...(field.detection || {}),
          signerIndex,
        },
      }));
    capped.push(...typeFields);
  }

  return [
    ...capped,
    ...laidOutFields.filter((field) => !['signature', 'date'].includes(field.type)),
  ];
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
    if (height < 24 || height > pageHeight * 0.35) continue;

    for (let xIndex = 0; xIndex < xCoords.length - 1; xIndex += 1) {
      const left = xCoords[xIndex];
      const right = xCoords[xIndex + 1];
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

      if (hasTop && hasBottom && hasLeft && hasRight) {
        cells.push({ source: 'pdf-path-table-grid', x: left, y: bottom, width, height });
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

const mergeFields = (fields, pageMetrics) => {
  const normalized = fields
    .map((field) => normalizePdfField(field, pageMetrics))
    .sort((a, b) => (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0));
  const merged = [];

  for (const field of normalized) {
    const duplicate = merged.find((item) =>
      item.type === field.type &&
      (overlapRatio(item, field) > 0.35 || centerDistance(item, field) < 28)
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

const assignFieldsToSigners = (fields, signers = []) => {
  const signerList = Array.isArray(signers) ? signers : [];
  return fields.map((field, index) => {
    const signerIndex = Number.isInteger(field.detection?.signerIndex)
      ? field.detection.signerIndex
      : field.type === 'signature' || field.type === 'date' || field.type === 'initials'
        ? index % Math.max(1, signerList.length)
        : -1;
    const signer = signerIndex >= 0 ? signerList[signerIndex] : null;
    return {
      ...field,
      assignedTo: field.assignedTo || signer?.email || '',
      role: field.role || signer?.role || '',
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

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent({ includeMarkedContent: false });
    const operatorList = await page.getOperatorList();
    const metric = pageMetrics[pageNumber - 1] || page.getViewport({ scale: 1 });
    const lines = buildTextLines(text.items || []);
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
  const hasDateField = candidates.some((field) => field.type === 'date');
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

  const fields = assignFieldsToSigners(mergeFields(candidates, pageMetrics), signers);
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
  buildMiddlePageInitialFields,
  textLayoutFieldsFromLines,
  pathGeometryFromOperatorList,
  detectWithLayoutLm,
  inferFieldType,
};
