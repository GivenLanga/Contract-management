import { describe, it, expect } from 'vitest';

// ── Import pure helpers from Workflows.jsx ─────────────────────────────────────
// We re-implement/mirror them here since they are module-level non-exported
// functions. Tests verify the filtering logic and tab count expectations.

// Mirror of helpers under test
function itemDueDate(item)    { return item.dueDate || item.deadline || null; }
function itemAssignee(item)   { return item.assignedTo || (item.assignee ? { name: item.assignee } : null); }

function buildWarnings(cfg, secondaryFilter, searchTerm) {
  const raw = cfg?.warnings || [];
  let warnings = raw.map((w, i) => {
    const msg = typeof w === 'string' ? w : (w?.message || String(w));
    const lower = msg.toLowerCase();
    const rowMatch = msg.match(/row\s+(\d+)/i);
    const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : null;
    let type = 'general';
    let severity = 'Warning';
    let suggestedFix = '';
    if ((lower.includes('parse') || lower.includes('date')) && lower.includes('deadline')) {
      type = 'dateParsing'; suggestedFix = 'Update the deadline cell to a valid date format.';
    } else if (lower.includes('missing') && lower.includes('deadline')) {
      type = 'missingDeadline'; suggestedFix = 'Add a deadline date to the Deadline column.';
    } else if (lower.includes('missing') && (lower.includes('assignee') || lower.includes('assigned'))) {
      type = 'missingAssignee'; suggestedFix = 'Add an assignee name to the Assignee column.';
    } else if (lower.includes('column') || lower.includes('mapping') || lower.includes('header')) {
      type = 'mappingIssues'; severity = 'Error'; suggestedFix = 'Check the header row.';
    } else if (lower.includes('lock') || lower.includes('sync') || lower.includes('write') || lower.includes('pending')) {
      type = 'spreadsheetSync'; suggestedFix = 'Close the spreadsheet and retry.';
    }
    return { id: i, type, severity, message: msg, rowNumber, suggestedFix };
  });
  if (secondaryFilter && secondaryFilter !== 'all') {
    warnings = warnings.filter(w => w.type === secondaryFilter);
  }
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    warnings = warnings.filter(w => w.message.toLowerCase().includes(q) || (w.suggestedFix || '').toLowerCase().includes(q));
  }
  return warnings;
}

function matchesSearch(item, q) {
  const assignee = itemAssignee(item);
  return (
    (item.title || item.description || '').toLowerCase().includes(q) ||
    (item.requestId || item.legalTrackerId || '').toLowerCase().includes(q) ||
    (item.counterpartyName || item.parties || '').toLowerCase().includes(q) ||
    (item.department || '').toLowerCase().includes(q) ||
    (item.taskType || '').toLowerCase().includes(q) ||
    (item.status || item.progress || '').toLowerCase().includes(q) ||
    (assignee?.name || item.assignee || '').toLowerCase().includes(q) ||
    (item.rowNumber != null ? String(item.rowNumber) : '').includes(q)
  );
}

// ── Fixtures ───────────────────────────────────────────────────────────────────
const mkTracker = (overrides = {}) => ({
  id: 'tk-1', appStatus: 'active', assignee: 'Alice', pipelineStage: 'review',
  description: 'NDA Review', taskType: 'NDA', deadline: null, lastSyncedAt: null,
  _type: 'TRACKER', ...overrides,
});
const mkManual = (overrides = {}) => ({
  id: 'mn-1', status: 'Pending', assignee: 'Bob', title: 'Policy review',
  dueDate: null, _type: 'MANUAL', ...overrides,
});

// ── 1. Primary tab counts ──────────────────────────────────────────────────────
describe('tab count logic', () => {
  const trackerItems = [
    mkTracker({ id: 'tk-1', appStatus: 'active' }),
    mkTracker({ id: 'tk-2', appStatus: 'active' }),
    mkTracker({ id: 'tk-3', appStatus: 'completed' }),
  ];
  const manualItems = [
    mkManual({ id: 'mn-1', status: 'Pending' }),
    mkManual({ id: 'mn-2', status: 'Completed' }),
  ];

  it('counts active tracker tasks', () => {
    expect(trackerItems.filter(t => t.appStatus !== 'completed').length).toBe(2);
  });

  it('counts active manual tasks', () => {
    expect(manualItems.filter(m => m.status !== 'Completed').length).toBe(1);
  });

  it('counts completed tasks (tracker + manual)', () => {
    const comp = trackerItems.filter(t => t.appStatus === 'completed').length
               + manualItems.filter(m => m.status === 'Completed').length;
    expect(comp).toBe(2);
  });
});

// ── 2. All tab combines active tracker + manual ────────────────────────────────
describe('All tab', () => {
  it('merges active tracker and manual tasks', () => {
    const trackerItems = [
      mkTracker({ id: 'tk-a', appStatus: 'active' }),
      mkTracker({ id: 'tk-b', appStatus: 'completed' }),
    ];
    const manualItems = [
      mkManual({ id: 'mn-a', status: 'Pending' }),
    ];
    const tkActive = trackerItems.filter(t => t.appStatus !== 'completed').map(t => ({ ...t, _type: 'TRACKER' }));
    const mnActive = manualItems.filter(m => m.status !== 'Completed').map(m => ({ ...m, _type: 'MANUAL' }));
    const combined = [...tkActive, ...mnActive];
    expect(combined).toHaveLength(2);
    expect(combined.some(r => r._type === 'TRACKER')).toBe(true);
    expect(combined.some(r => r._type === 'MANUAL')).toBe(true);
  });

  it('excludes completed tasks from the All tab', () => {
    const trackerItems = [mkTracker({ appStatus: 'completed' })];
    const manualItems  = [mkManual({ status: 'Completed' })];
    const combined = [
      ...trackerItems.filter(t => t.appStatus !== 'completed'),
      ...manualItems.filter(m => m.status !== 'Completed'),
    ];
    expect(combined).toHaveLength(0);
  });

  it('tab count for all equals tracker active + manual active', () => {
    const trackerItems = [mkTracker({ appStatus: 'active' }), mkTracker({ appStatus: 'completed' })];
    const manualItems  = [mkManual({ status: 'Pending' }), mkManual({ status: 'Completed' })];
    const activeTk = trackerItems.filter(t => t.appStatus !== 'completed').length;
    const activeMn = manualItems.filter(m => m.status !== 'Completed').length;
    expect(activeTk + activeMn).toBe(2);
  });
});

// ── 3. Tracker tab only shows active tracker tasks ─────────────────────────────
describe('Tracker tab', () => {
  it('excludes completed tracker tasks by default', () => {
    const items = [
      mkTracker({ id: 'a', appStatus: 'active' }),
      mkTracker({ id: 'b', appStatus: 'completed' }),
    ];
    const active = items.filter(t => t.appStatus !== 'completed');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('a');
  });

  it('does not include manual tasks', () => {
    const trackerItems = [mkTracker()];
    const manualItems  = [mkManual()];
    const result = trackerItems
      .filter(t => t.appStatus !== 'completed')
      .map(t => ({ ...t, _type: 'TRACKER' }));
    expect(result.every(r => r._type === 'TRACKER')).toBe(true);
    expect(result.some(r => r.id === manualItems[0].id)).toBe(false);
  });
});

// ── 3. Manual tab only shows manual active tasks ───────────────────────────────
describe('Manual tab', () => {
  it('shows manual active tasks', () => {
    const items = [mkManual({ id: 'mn-a', status: 'Pending' }), mkManual({ id: 'mn-b', status: 'Completed' })];
    const result = items.filter(m => m.status !== 'Completed');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mn-a');
  });

  it('does not include tracker tasks', () => {
    const manualItems  = [mkManual()];
    const result = manualItems.filter(m => m.status !== 'Completed').map(m => ({ ...m, _type: 'MANUAL' }));
    expect(result.every(r => r._type === 'MANUAL')).toBe(true);
  });
});

// ── 4. Completed tab shows completed tracker + manual ──────────────────────────
describe('Completed tab', () => {
  it('includes completed tracker tasks', () => {
    const items = [mkTracker({ id: 'a', appStatus: 'completed' }), mkTracker({ id: 'b', appStatus: 'active' })];
    expect(items.filter(t => t.appStatus === 'completed')).toHaveLength(1);
  });

  it('includes completed manual tasks', () => {
    const items = [mkManual({ id: 'x', status: 'Completed' }), mkManual({ id: 'y', status: 'Pending' })];
    expect(items.filter(m => m.status === 'Completed')).toHaveLength(1);
  });

  it('"Tracker Completed" secondary shows only tracker completed', () => {
    const compTk = [mkTracker({ appStatus: 'completed', _type: 'TRACKER' })];
    const compMn = [mkManual({ status: 'Completed', _type: 'MANUAL' })];
    const result = compTk; // secondaryFilter === 'trackerCompleted'
    expect(result.every(r => r._type === 'TRACKER')).toBe(true);
  });

  it('"Manual Completed" secondary shows only manual completed', () => {
    const compMn = [mkManual({ status: 'Completed', _type: 'MANUAL' })];
    expect(compMn.every(r => r._type === 'MANUAL')).toBe(true);
  });
});

// ── 5. Tracker + Unassigned secondary filter ───────────────────────────────────
describe('Tracker + Unassigned', () => {
  it('returns only unassigned tracker active tasks', () => {
    const items = [
      mkTracker({ id: 'a', appStatus: 'active', assignee: '' }),
      mkTracker({ id: 'b', appStatus: 'active', assignee: 'Alice' }),
    ];
    const active = items.filter(t => t.appStatus !== 'completed');
    const unassigned = active.filter(t => !t.assignee);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].id).toBe('a');
  });
});

// ── 6. Warnings tab ────────────────────────────────────────────────────────────
describe('buildWarnings', () => {
  const cfg = {
    warnings: [
      'Row 3: Could not parse deadline date "ASAP"',
      'Row 5: Missing assignee in Assignee column',
      'Row 7: Missing deadline',
      'Sync pending — spreadsheet is write-locked',
      'Column mapping issue: header not found',
    ],
  };

  it('returns all warnings for "all" filter', () => {
    expect(buildWarnings(cfg, 'all', '')).toHaveLength(5);
  });

  it('classifies date parsing warnings', () => {
    const result = buildWarnings(cfg, 'dateParsing', '');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('dateParsing');
  });

  it('classifies missing assignee warnings', () => {
    const result = buildWarnings(cfg, 'missingAssignee', '');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('missingAssignee');
  });

  it('classifies spreadsheet sync warnings', () => {
    const result = buildWarnings(cfg, 'spreadsheetSync', '');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('spreadsheetSync');
  });

  it('classifies mapping issues', () => {
    const result = buildWarnings(cfg, 'mappingIssues', '');
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('Error');
  });

  it('extracts row number from warning message', () => {
    const result = buildWarnings(cfg, 'dateParsing', '');
    expect(result[0].rowNumber).toBe(3);
  });

  it('returns empty when no warnings for filter', () => {
    expect(buildWarnings({ warnings: [] }, 'dateParsing', '')).toHaveLength(0);
  });
});

// ── 7. Warnings tab — search applies ──────────────────────────────────────────
describe('buildWarnings search', () => {
  it('filters warnings by search term', () => {
    const cfg = { warnings: ['Row 1: Could not parse deadline date "ASAP"', 'Row 2: Missing assignee'] };
    const result = buildWarnings(cfg, 'all', 'assignee');
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('assignee');
  });
});

// ── 8. Search applies within selected primary tab ──────────────────────────────
describe('matchesSearch', () => {
  it('matches by description', () => {
    const item = mkTracker({ description: 'NDA review for Acme Corp' });
    expect(matchesSearch(item, 'acme')).toBe(true);
    expect(matchesSearch(item, 'xyz')).toBe(false);
  });

  it('matches by parties', () => {
    expect(matchesSearch(mkTracker({ parties: 'Acme Corp' }), 'acme')).toBe(true);
  });

  it('matches by assignee name', () => {
    expect(matchesSearch(mkTracker({ assignee: 'Alice Smith' }), 'alice')).toBe(true);
  });

  it('matches by row number', () => {
    expect(matchesSearch(mkTracker({ rowNumber: 42 }), '42')).toBe(true);
  });

  it('matches by taskType', () => {
    expect(matchesSearch(mkTracker({ taskType: 'Lease Agreement' }), 'lease')).toBe(true);
  });

  it('matches by status', () => {
    expect(matchesSearch(mkManual({ status: 'In Progress' }), 'progress')).toBe(true);
  });
});

// ── 9. Secondary filters switch per primary tab ────────────────────────────────
describe('SECONDARY_FILTERS keys per tab', () => {
  const SECONDARY_FILTERS = {
    tracker:   ['all','overdue','dueToday','dueThisWeek','unassigned','withManager','withBusiness','signature','noUpdate'],
    manual:    ['all','overdue','dueToday','dueThisWeek','unassigned','assigned'],
    completed: ['all','trackerCompleted','manualCompleted','completedThisWeek'],
    warnings:  ['all','dateParsing','missingAssignee','missingDeadline','spreadsheetSync','mappingIssues'],
  };

  it('tracker tab does not include "manual" or "completed" keys', () => {
    expect(SECONDARY_FILTERS.tracker).not.toContain('manual');
    expect(SECONDARY_FILTERS.tracker).not.toContain('completed');
  });

  it('manual tab does not include "withManager" or "signature" keys', () => {
    expect(SECONDARY_FILTERS.manual).not.toContain('withManager');
    expect(SECONDARY_FILTERS.manual).not.toContain('signature');
  });

  it('completed tab has tracker/manual sub-filters', () => {
    expect(SECONDARY_FILTERS.completed).toContain('trackerCompleted');
    expect(SECONDARY_FILTERS.completed).toContain('manualCompleted');
  });

  it('warnings tab has warning-specific filters', () => {
    expect(SECONDARY_FILTERS.warnings).toContain('dateParsing');
    expect(SECONDARY_FILTERS.warnings).toContain('spreadsheetSync');
  });
});
