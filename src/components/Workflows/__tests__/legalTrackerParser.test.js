import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  normalizeHeader,
  detectColumnMapping,
  parseExcelDate,
  calcDueState,
  mapToPipelineStage,
  sanitizeForExcel,
  buildTrackerTask,
  importRows,
  COLUMN_ALIASES,
} from '../../../services/legalTrackerParser';

// ── 1. Detect Legal sheet ──────────────────────────────────────────────────────
describe('detectColumnMapping', () => {
  it('maps standard headers correctly', () => {
    const headers = [
      { colIndex: 1, text: 'Task type' },
      { colIndex: 2, text: 'Parties' },
      { colIndex: 3, text: 'Description' },
      { colIndex: 4, text: 'Progress' },
      { colIndex: 5, text: 'Status' },
      { colIndex: 6, text: 'Deadline / submission' },
      { colIndex: 7, text: 'Assignee' },
    ];
    const mapping = detectColumnMapping(headers);
    expect(mapping.taskType).toBe(1);
    expect(mapping.parties).toBe(2);
    expect(mapping.description).toBe(3);
    expect(mapping.progress).toBe(4);
    expect(mapping.status).toBe(5);
    expect(mapping.deadline).toBe(6);
    expect(mapping.assignee).toBe(7);
  });

  // ── 2. Detect row 2 headers (normalizeHeader)
  it('normalizeHeader lowercases and trims', () => {
    expect(normalizeHeader('  Task Type  ')).toBe('task type');
    expect(normalizeHeader('DEADLINE / SUBMISSION')).toBe('deadline / submission');
    expect(normalizeHeader(null)).toBe('');
    expect(normalizeHeader(undefined)).toBe('');
  });

  // ── 3. Map "Key Learninge" to keyLearning
  it('maps misspelled "Key Learninge" alias to keyLearning', () => {
    const headers = [{ colIndex: 9, text: 'Key Learninge' }];
    const mapping = detectColumnMapping(headers);
    expect(mapping.keyLearning).toBe(9);
  });

  it('maps "Key Learning" (correct spelling) to keyLearning', () => {
    const headers = [{ colIndex: 9, text: 'Key Learning' }];
    const mapping = detectColumnMapping(headers);
    expect(mapping.keyLearning).toBe(9);
  });

  it('maps column aliases like "Due Date" and "Counterparty"', () => {
    const headers = [
      { colIndex: 1, text: 'Due Date' },
      { colIndex: 2, text: 'Counterparty' },
      { colIndex: 3, text: 'Owner' },
    ];
    const mapping = detectColumnMapping(headers);
    expect(mapping.deadline).toBe(1);
    expect(mapping.parties).toBe(2);
    expect(mapping.assignee).toBe(3);
  });
});

// ── 4. Import tracker rows ─────────────────────────────────────────────────────
describe('importRows', () => {
  const mapping = { taskType: 1, parties: 2, description: 3, progress: 4, status: 5, deadline: 6, assignee: 7 };

  // ── 5. Skip empty rows
  it('skips rows where all mapped columns are empty', () => {
    const rows = [
      { rowNumber: 2, cells: {} },
      { rowNumber: 3, cells: { 1: 'Contract Review', 3: 'NDA draft' } },
    ];
    const tasks = importRows(rows, mapping, 'Legal Tracker', 'Legal', 1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].rowNumber).toBe(3);
  });

  // ── 6. Preserve unparseable deadline text
  it('preserves rawDeadlineText when deadline is not a parseable date', () => {
    const rows = [{ rowNumber: 2, cells: { 1: 'Review', 3: 'Some matter', 6: 'ASAP' } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].rawDeadlineText).toBe('ASAP');
    expect(tasks[0].deadline).toBeNull();
  });

  // ── 7. Convert Excel serial dates
  it('converts Excel serial date number to a Date object', () => {
    const serialDate = 45000; // a valid Excel date serial
    const rows = [{ rowNumber: 2, cells: { 1: 'Drafting', 3: 'Task', 6: serialDate } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].deadline).toBeInstanceOf(Date);
    expect(isNaN(tasks[0].deadline.getTime())).toBe(false);
  });

  // ── 8. Missing assignee becomes unassigned
  it('sets assignee to empty string when column is blank', () => {
    const rows = [{ rowNumber: 2, cells: { 1: 'Review', 3: 'Matter X' } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].assignee).toBe('');
    expect(tasks[0].pipelineStage).toBe('intake');
  });

  // ── 9. Completed progress maps to completed appStatus
  it('sets appStatus to completed when progress includes "completed"', () => {
    const rows = [{ rowNumber: 2, cells: { 1: 'NDA', 3: 'Matter A', 4: 'Completed' } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].appStatus).toBe('completed');
  });

  it('sets appStatus to active when progress is "In Progress"', () => {
    const rows = [{ rowNumber: 2, cells: { 1: 'NDA', 3: 'Matter A', 4: 'In Progress' } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].appStatus).toBe('active');
  });

  // ── 10. Overdue deadlines map to overdue dueState
  it('maps past deadline to overdue dueState', () => {
    const pastDate = '2020-01-01';
    const rows = [{ rowNumber: 2, cells: { 3: 'Old task', 6: pastDate } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].dueState).toBe('overdue');
  });

  it('maps future deadline to ok dueState', () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const rows = [{ rowNumber: 2, cells: { 3: 'Future task', 6: future } }];
    const tasks = importRows(rows, mapping, 'WB', 'Legal', 1);
    expect(tasks[0].dueState).toBe('ok');
  });
});

// ── parseExcelDate ─────────────────────────────────────────────────────────────
describe('parseExcelDate', () => {
  it('returns null for null input', () => {
    expect(parseExcelDate(null)).toBeNull();
  });

  it('returns the Date unchanged if valid', () => {
    const d = new Date('2025-06-01');
    expect(parseExcelDate(d)).toBe(d);
  });

  it('returns null for invalid Date', () => {
    expect(parseExcelDate(new Date('not-a-date'))).toBeNull();
  });

  it('converts Excel serial number to Date', () => {
    const d = parseExcelDate(45000);
    expect(d).toBeInstanceOf(Date);
  });

  it('parses ISO string', () => {
    const d = parseExcelDate('2025-06-01');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
  });

  it('returns null for unparseable string', () => {
    expect(parseExcelDate('ASAP')).toBeNull();
  });
});

// ── calcDueState ───────────────────────────────────────────────────────────────
describe('calcDueState', () => {
  it('returns overdue for past date', () => {
    expect(calcDueState(new Date('2020-01-01'))).toBe('overdue');
  });

  it('returns today for date within next 24h', () => {
    const d = new Date(Date.now() + 3600 * 1000);
    expect(calcDueState(d)).toBe('today');
  });

  it('returns soon for date within next 7 days', () => {
    const d = new Date(Date.now() + 3 * 86400000);
    expect(calcDueState(d)).toBe('soon');
  });

  it('returns ok for date more than 7 days away', () => {
    const d = new Date(Date.now() + 30 * 86400000);
    expect(calcDueState(d)).toBe('ok');
  });

  it('returns unknown for null', () => {
    expect(calcDueState(null)).toBe('unknown');
  });
});

// ── mapToPipelineStage ─────────────────────────────────────────────────────────
describe('mapToPipelineStage', () => {
  it('maps "completed" to complete stage', () => {
    expect(mapToPipelineStage('Completed', '', '')).toBe('complete');
  });

  it('maps "signature" to signature stage', () => {
    expect(mapToPipelineStage('Ready for signature', '', '')).toBe('signature');
  });

  it('maps "with manager" to manager stage', () => {
    expect(mapToPipelineStage('With Manager', '', '')).toBe('manager');
  });

  it('maps "with business" to business stage', () => {
    expect(mapToPipelineStage('With Business', '', '')).toBe('business');
  });

  it('maps "external review" to external stage', () => {
    expect(mapToPipelineStage('Sent to external', '', '')).toBe('external');
  });

  it('maps "in progress" to review stage', () => {
    expect(mapToPipelineStage('In Progress', '', '')).toBe('review');
  });

  it('maps assigned (with assignee, no status) to assigned stage', () => {
    expect(mapToPipelineStage('', '', 'John Doe')).toBe('assigned');
  });

  it('maps blank progress + no assignee to intake', () => {
    expect(mapToPipelineStage('', '', '')).toBe('intake');
  });
});

// ── sanitizeForExcel ───────────────────────────────────────────────────────────
describe('sanitizeForExcel', () => {
  // ── 15. Formula-like input sanitized
  it('prefixes = with apostrophe', () => {
    expect(sanitizeForExcel('=SUM(A1)')).toBe("'=SUM(A1)");
  });

  it('prefixes + with apostrophe', () => {
    expect(sanitizeForExcel('+10')).toBe("'+10");
  });

  it('prefixes - with apostrophe', () => {
    expect(sanitizeForExcel('-data')).toBe("'-data");
  });

  it('prefixes @ with apostrophe', () => {
    expect(sanitizeForExcel('@username')).toBe("'@username");
  });

  it('leaves normal strings untouched', () => {
    expect(sanitizeForExcel('John Doe')).toBe('John Doe');
  });

  it('handles non-string values', () => {
    expect(sanitizeForExcel(42)).toBe('42');
    expect(sanitizeForExcel(null)).toBe('');
  });
});
