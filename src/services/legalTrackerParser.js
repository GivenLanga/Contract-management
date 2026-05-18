// Pure ESM tracker parsing logic — no Node/Electron deps, importable in tests.
// The Electron workbook service duplicates these implementations in CJS.

export const COLUMN_ALIASES = {
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

export const STAGE_KEYWORDS = [
  ['complete',  ['completed', 'done', 'finalized', 'fully signed', 'closed', 'archived', 'stored']],
  ['signature', ['ready for sign', 'signature', 'signing', 'sent for sign', 'awaiting sign', 'partially signed']],
  ['manager',   ['with manager', 'manager review', 'manager approval', 'approved', 'with md', 'with ceo', 'with director']],
  ['business',  ['with business', 'business input', 'internal dept', 'waiting on business', 'business review']],
  ['external',  ['external review', 'ext review', 'sent to external', 'waiting for external', 'email feedback', 'third party', 'negotiation']],
  ['review',    ['legal review', 'internal review', 'in review', 'drafting', 'draft', 'in progress', 'in legal review']],
];

export function normalizeHeader(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function detectColumnMapping(headers) {
  // headers: array of { colIndex, text } OR object with colIndex->headerText
  const mapping = {};
  const entries = Array.isArray(headers)
    ? headers
    : Object.entries(headers).map(([colIndex, text]) => ({ colIndex: Number(colIndex), text }));

  for (const { colIndex, text } of entries) {
    const norm = normalizeHeader(text);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (!mapping[field] && aliases.includes(norm)) {
        mapping[field] = colIndex;
      }
    }
  }
  return mapping;
}

export function parseExcelDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date((value - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function calcDueState(deadline) {
  if (!deadline) return 'unknown';
  const now  = Date.now();
  const d    = deadline instanceof Date ? deadline.getTime() : new Date(deadline).getTime();
  if (isNaN(d)) return 'unknown';
  const diff = d - now;
  if (diff < 0)             return 'overdue';
  if (diff < 86400000)      return 'today';
  if (diff < 7 * 86400000)  return 'soon';
  return 'ok';
}

export function mapToPipelineStage(progress, status, assignee) {
  const combined = `${progress ?? ''} ${status ?? ''}`.toLowerCase();
  for (const [stage, keywords] of STAGE_KEYWORDS) {
    if (keywords.some(kw => combined.includes(kw))) return stage;
  }
  return assignee ? 'assigned' : 'intake';
}

export function sanitizeForExcel(value) {
  if (typeof value !== 'string') return String(value ?? '');
  const trimmed = value.trim();
  if (trimmed.length > 0 && ['+', '-', '=', '@'].includes(trimmed[0])) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export function buildTrackerTask({ rowNumber, cells, mapping, workbookName, sheetName }) {
  const get = (field) => String(cells[mapping[field]] ?? '').trim();
  const progress   = get('progress');
  const statusText = get('status');
  const assignee   = get('assignee');
  const rawDL      = cells[mapping['deadline']];
  const deadline   = parseExcelDate(rawDL ?? null);

  const pLow = progress.toLowerCase();
  const isCompleted = ['completed', 'done', 'closed', 'finalized', 'fully signed']
    .some(s => pLow.includes(s));

  return {
    id:             `tracker-${workbookName}-${sheetName}-${rowNumber}`,
    sourceType:     'LEGAL_TRACKER',
    legalTrackerId: `${sheetName}-row-${rowNumber}`,
    workbookName,
    sheetName,
    rowNumber,
    rowKey:         `row-${rowNumber}`,

    taskType:      get('taskType'),
    parties:       get('parties'),
    description:   get('description'),
    progress,
    status:        statusText,
    purpose:       get('purpose'),
    dateOfRequest: parseExcelDate(cells[mapping['dateOfRequest']] ?? null),
    deadline,
    rawDeadlineText: rawDL != null ? String(rawDL) : '',
    department:    get('department'),
    assignee,
    keyLearning:   get('keyLearning'),

    appStatus:     isCompleted ? 'completed' : 'active',
    dueState:      calcDueState(deadline),
    priority:      'Medium',
    pipelineStage: mapToPipelineStage(progress, statusText, assignee),
    lastSyncedAt:  new Date().toISOString(),
  };
}

export function importRows(rows, mapping, workbookName, sheetName, headerRowNum = 1) {
  const tasks = [];
  for (const { rowNumber, cells } of rows) {
    if (rowNumber <= headerRowNum) continue;
    const allEmpty = Object.values(mapping).every(colIdx => !String(cells[colIdx] ?? '').trim());
    if (allEmpty) continue;
    tasks.push(buildTrackerTask({ rowNumber, cells, mapping, workbookName, sheetName }));
  }
  return tasks;
}
