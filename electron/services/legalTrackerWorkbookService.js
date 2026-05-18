'use strict';

const ExcelJS = require('exceljs');
const path    = require('path');
const fs      = require('fs');

// ── Column alias map ──────────────────────────────────────────────────────────
const COLUMN_ALIASES = {
  taskType:      ['task type', 'type', 'work type', 'category'],
  parties:       ['parties', 'party', 'counterparty', 'client'],
  description:   ['description', 'matter', 'task', 'work item'],
  progress:      ['progress'],
  status:        ['status'],
  purpose:       ['purpose'],
  dateOfRequest: ['date of request', 'date requested', 'request date'],
  deadline:      ['deadline / submission', 'deadline', 'due date', 'submission date', 'target date'],
  department:    ['internal department', 'department', 'dept'],
  assignee:      ['assignee', 'owner', 'responsible person', 'assigned to'],
  keyLearning:   ['key learninge', 'key learning', 'lessons', 'notes'],
};

// ── Pipeline stage keyword map (highest-priority first) ───────────────────────
const STAGE_KEYWORDS = [
  ['complete',  ['completed', 'done', 'finalized', 'fully signed', 'closed', 'archived', 'stored']],
  ['signature', ['ready for sign', 'signature', 'signing', 'sent for sign', 'awaiting sign', 'partially signed']],
  ['manager',   ['with manager', 'manager review', 'manager approval', 'approved', 'with md', 'with ceo', 'with director']],
  ['business',  ['with business', 'business input', 'internal dept', 'waiting on business', 'business review']],
  ['external',  ['external review', 'ext review', 'sent to external', 'waiting for external', 'email feedback', 'third party', 'negotiation']],
  ['review',    ['legal review', 'internal review', 'in review', 'drafting', 'draft', 'in progress', 'in legal review']],
];

// ── Pure helpers (exported for testing) ──────────────────────────────────────

function normalizeHeader(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function detectColumnMapping(headerRow) {
  const mapping = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = normalizeHeader(cell.value);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (!mapping[field] && aliases.includes(text)) {
        mapping[field] = colNumber;
      }
    }
  });
  return mapping;
}

function parseExcelDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // Excel serial date: days since 1899-12-31 (with 1900 leap year bug at offset 25569)
    const d = new Date((value - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function calcDueState(deadline) {
  if (!deadline) return 'unknown';
  const now = Date.now();
  const d   = deadline instanceof Date ? deadline.getTime() : new Date(deadline).getTime();
  if (isNaN(d)) return 'unknown';
  const diff = d - now;
  if (diff < 0)          return 'overdue';
  if (diff < 86400000)   return 'today';
  if (diff < 7 * 86400000) return 'soon';
  return 'ok';
}

function mapToPipelineStage(progress, status, assignee) {
  const combined = `${progress ?? ''} ${status ?? ''}`.toLowerCase();
  for (const [stage, keywords] of STAGE_KEYWORDS) {
    if (keywords.some(kw => combined.includes(kw))) return stage;
  }
  return assignee ? 'assigned' : 'intake';
}

function sanitizeForExcel(value) {
  if (typeof value !== 'string') return String(value ?? '');
  const trimmed = value.trim();
  if (trimmed.length > 0 && ['+', '-', '=', '@'].includes(trimmed[0])) {
    return `'${trimmed}`;
  }
  return trimmed;
}

// ── Internal ExcelJS helpers ──────────────────────────────────────────────────

function detectMainSheet(workbook) {
  for (const sheet of workbook.worksheets) {
    if (sheet.name.toLowerCase() === 'legal') return sheet;
  }
  return workbook.worksheets[0] ?? null;
}

function getCellText(row, colIndex) {
  if (!colIndex) return '';
  const v = row.getCell(colIndex).value;
  if (v == null) return '';
  if (typeof v === 'object' && v !== null) {
    if (v.text   !== undefined) return String(v.text);   // rich text
    if (v.result !== undefined) return String(v.result); // formula
  }
  return String(v);
}

function isRowEmpty(row, mapping) {
  for (const colIndex of Object.values(mapping)) {
    if (colIndex && getCellText(row, colIndex).trim()) return false;
  }
  return true;
}

function buildTask(row, mapping, rowNumber, workbookName, sheetName) {
  const progress   = getCellText(row, mapping.progress);
  const statusText = getCellText(row, mapping.status);
  const assignee   = getCellText(row, mapping.assignee);
  const rawDL      = mapping.deadline ? row.getCell(mapping.deadline).value : null;
  const deadline   = parseExcelDate(rawDL);

  const pLow = progress.toLowerCase();
  const isCompleted = ['completed', 'done', 'closed', 'finalized', 'fully signed']
    .some(s => pLow.includes(s));

  return {
    id:              `tracker-${workbookName}-${sheetName}-${rowNumber}`,
    sourceType:      'LEGAL_TRACKER',
    legalTrackerId:  `${sheetName}-row-${rowNumber}`,
    workbookName,
    sheetName,
    rowNumber,
    rowKey:          `row-${rowNumber}`,

    taskType:      getCellText(row, mapping.taskType),
    parties:       getCellText(row, mapping.parties),
    description:   getCellText(row, mapping.description),
    progress,
    status:        statusText,
    purpose:       getCellText(row, mapping.purpose),
    dateOfRequest: parseExcelDate(mapping.dateOfRequest ? row.getCell(mapping.dateOfRequest).value : null),
    deadline,
    rawDeadlineText: rawDL != null ? String(rawDL) : '',
    department:    getCellText(row, mapping.department),
    assignee,
    keyLearning:   getCellText(row, mapping.keyLearning),

    appStatus:     isCompleted ? 'completed' : 'active',
    dueState:      calcDueState(deadline),
    priority:      'Medium',
    pipelineStage: mapToPipelineStage(progress, statusText, assignee),
    lastSyncedAt:  new Date().toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function readWorkbook(filePath) {
  if (!filePath || !filePath.endsWith('.xlsx')) {
    return { ok: false, code: 'INVALID_FILE_TYPE', message: 'Only .xlsx files are supported.' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, code: 'FILE_NOT_FOUND', message: 'File not found.' };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    const isLocked = err.code === 'EBUSY' || /lock/i.test(String(err.message));
    return {
      ok:      false,
      code:    isLocked ? 'FILE_LOCKED' : 'READ_ERROR',
      message: isLocked ? 'File is locked by another application.' : String(err.message),
    };
  }

  const sheet = detectMainSheet(workbook);
  if (!sheet) {
    return { ok: false, code: 'NO_SHEET', message: 'No worksheets found in workbook.' };
  }

  // Try row 1 for headers; fall back to row 2
  let headerRow = sheet.getRow(1);
  let mapping   = detectColumnMapping(headerRow);
  if (Object.keys(mapping).length < 2) {
    headerRow = sheet.getRow(2);
    mapping   = detectColumnMapping(headerRow);
  }

  const headerRowNum = headerRow.number;
  const workbookName = path.basename(filePath, '.xlsx');
  const tasks        = [];
  const warnings     = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNum) return;
    if (isRowEmpty(row, mapping))  return;
    const task = buildTask(row, mapping, rowNumber, workbookName, sheet.name);
    if (!task.description && !task.taskType) {
      warnings.push(`Row ${rowNumber}: no description or task type.`);
    }
    tasks.push(task);
  });

  return {
    ok:            true,
    workbookName,
    sheetName:     sheet.name,
    headerRow:     headerRowNum,
    columnMapping: mapping,
    tasks,
    rowsImported:  tasks.length,
    warnings,
    lastSyncedAt:  new Date().toISOString(),
  };
}

async function createBackup(filePath) {
  const dir   = path.dirname(filePath);
  const base  = path.basename(filePath, '.xlsx');
  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest  = path.join(dir, `${base}_backup_${ts}.xlsx`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

async function updateRow(filePath, { rowNumber, fieldUpdates, columnMapping }) {
  if (!filePath || !filePath.endsWith('.xlsx')) {
    return { ok: false, code: 'INVALID_FILE_TYPE' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, code: 'FILE_NOT_FOUND' };
  }

  let backupPath;
  try {
    backupPath = await createBackup(filePath);
  } catch (err) {
    return { ok: false, code: 'BACKUP_FAILED', message: String(err.message) };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    return { ok: false, code: 'READ_ERROR', message: String(err.message), backupPath };
  }

  const sheet = detectMainSheet(workbook);
  if (!sheet) return { ok: false, code: 'NO_SHEET', backupPath };

  const row = sheet.getRow(rowNumber);
  for (const [field, value] of Object.entries(fieldUpdates)) {
    const colIndex = columnMapping[field];
    if (!colIndex) continue;
    row.getCell(colIndex).value = sanitizeForExcel(String(value ?? ''));
  }
  row.commit();

  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (err) {
    const isLocked = err.code === 'EBUSY' || /lock/i.test(String(err.message));
    return {
      ok:      false,
      code:    isLocked ? 'FILE_LOCKED' : 'WRITE_ERROR',
      message: String(err.message),
      backupPath,
    };
  }

  return { ok: true, rowNumber, backupPath };
}

module.exports = {
  readWorkbook,
  updateRow,
  createBackup,
  // Pure helpers — exported so tests can import without ExcelJS
  sanitizeForExcel,
  mapToPipelineStage,
  calcDueState,
  parseExcelDate,
  detectColumnMapping,
  normalizeHeader,
};
