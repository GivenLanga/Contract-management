import { describe, it, expect } from 'vitest';

// Mirror helpers from Workflows.jsx (not exported — tested by mirroring)

function itemDueDate(item) { return item.dueDate || item.deadline || null; }

function calcDueState(dateVal) {
  if (!dateVal) return 'unknown';
  const now = Date.now(); const d = new Date(dateVal).getTime();
  if (isNaN(d)) return 'unknown';
  const diff = d - now;
  if (diff < 0) return 'overdue';
  if (diff < 86400000) return 'today';
  if (diff < 7 * 86400000) return 'soon';
  return 'ok';
}

function isCompletedWorkflowTask(task) {
  return task.appStatus === 'completed' || task.status === 'Completed';
}

function getCompletionOutcome(task) {
  const deadline    = itemDueDate(task);
  const completedAt = task.completedAt || null;

  if (!deadline) {
    return { label: 'Completed — no deadline', tone: 'muted', detail: null, outcome: 'COMPLETED_NO_DEADLINE' };
  }

  const deadlineDate = new Date(deadline);
  if (isNaN(deadlineDate.getTime())) {
    return { label: 'Completed', tone: 'success', detail: null, outcome: 'COMPLETED_DATE_UNKNOWN' };
  }

  const deadlineStr = deadlineDate.toLocaleDateString('en-ZA');

  if (completedAt) {
    const completedDate = new Date(completedAt);
    if (!isNaN(completedDate.getTime())) {
      if (completedDate > deadlineDate) {
        const daysLate = Math.ceil((completedDate.getTime() - deadlineDate.getTime()) / 86400000);
        return { label: `Completed ${daysLate}d late`, tone: 'warning', detail: `due ${deadlineStr}`, outcome: 'COMPLETED_LATE' };
      }
      return { label: 'Completed on time', tone: 'success', detail: `due ${deadlineStr}`, outcome: 'COMPLETED_ON_TIME' };
    }
  }

  return { label: 'Completed', tone: 'success', detail: `deadline: ${deadlineStr}`, outcome: 'COMPLETED_DATE_UNKNOWN' };
}

// Shared test dates (past deadline: definitely in the past)
const PAST_DEADLINE  = '2020-01-01';
const FUTURE_DL      = '2099-12-31';
const COMPLETED_LATE = '2020-06-01'; // after PAST_DEADLINE
const COMPLETED_EARLY= '2019-12-01'; // before PAST_DEADLINE

// ── 1. Active overdue task shows "overdue" dueState ───────────────────────────
describe('active overdue detection', () => {
  it('returns overdue for incomplete task with past deadline', () => {
    const task = { deadline: PAST_DEADLINE, appStatus: 'active' };
    expect(isCompletedWorkflowTask(task)).toBe(false);
    expect(calcDueState(task.deadline)).toBe('overdue');
  });

  it('tracker tab still shows overdue for incomplete tracker task', () => {
    const task = { deadline: PAST_DEADLINE, appStatus: 'active', progress: 'In Progress' };
    expect(calcDueState(task.deadline)).toBe('overdue');
  });
});

// ── 2. Completed task — past deadline, no completedDate ───────────────────────
describe('getCompletionOutcome — no completedDate', () => {
  it('completed task with past deadline and no completedDate → Completed (not Overdue)', () => {
    const task = { deadline: PAST_DEADLINE, appStatus: 'completed', completedAt: null };
    const outcome = getCompletionOutcome(task);
    expect(outcome.label).toBe('Completed');
    expect(outcome.outcome).toBe('COMPLETED_DATE_UNKNOWN');
    expect(outcome.tone).not.toBe('overdue');
  });

  it('outcome includes deadline as muted detail text', () => {
    const task = { deadline: '2026-05-16', appStatus: 'completed', completedAt: null };
    const outcome = getCompletionOutcome(task);
    expect(outcome.detail).toMatch(/deadline/i);
  });

  it('tone is success (green), not warning (amber) or overdue (red)', () => {
    const task = { deadline: PAST_DEADLINE, appStatus: 'completed' };
    expect(getCompletionOutcome(task).tone).toBe('success');
  });
});

// ── 3. Completed task — completedDate after deadline (late) ───────────────────
describe('getCompletionOutcome — completed late', () => {
  it('returns COMPLETED_LATE when completedAt > deadline', () => {
    const task = { deadline: PAST_DEADLINE, completedAt: COMPLETED_LATE };
    const outcome = getCompletionOutcome(task);
    expect(outcome.outcome).toBe('COMPLETED_LATE');
    expect(outcome.label).toMatch(/late/i);
    expect(outcome.tone).toBe('warning');
  });

  it('includes daysLate count in the label', () => {
    const dl = '2024-01-01';
    const ca = '2024-01-05'; // 4 days late
    const outcome = getCompletionOutcome({ deadline: dl, completedAt: ca });
    expect(outcome.label).toBe('Completed 4d late');
  });

  it('detail includes the deadline date for reference', () => {
    const task = { deadline: PAST_DEADLINE, completedAt: COMPLETED_LATE };
    expect(getCompletionOutcome(task).detail).toMatch(/due/i);
  });
});

// ── 4. Completed task — completedDate on or before deadline (on time) ─────────
describe('getCompletionOutcome — completed on time', () => {
  it('returns COMPLETED_ON_TIME when completedAt <= deadline', () => {
    const task = { deadline: PAST_DEADLINE, completedAt: COMPLETED_EARLY };
    const outcome = getCompletionOutcome(task);
    expect(outcome.outcome).toBe('COMPLETED_ON_TIME');
    expect(outcome.label).toBe('Completed on time');
    expect(outcome.tone).toBe('success');
  });

  it('returns on time when completedAt equals deadline exactly', () => {
    const task = { deadline: '2024-03-15', completedAt: '2024-03-15' };
    expect(getCompletionOutcome(task).outcome).toBe('COMPLETED_ON_TIME');
  });
});

// ── 5. Completed task — no deadline ───────────────────────────────────────────
describe('getCompletionOutcome — no deadline', () => {
  it('returns COMPLETED_NO_DEADLINE when no dueDate or deadline', () => {
    const task = { appStatus: 'completed', deadline: null, dueDate: null };
    const outcome = getCompletionOutcome(task);
    expect(outcome.outcome).toBe('COMPLETED_NO_DEADLINE');
    expect(outcome.label).toMatch(/no deadline/i);
    expect(outcome.tone).toBe('muted');
  });

  it('detail is null when no deadline exists', () => {
    expect(getCompletionOutcome({ deadline: null }).detail).toBeNull();
  });
});

// ── 6. isCompletedWorkflowTask detection ──────────────────────────────────────
describe('isCompletedWorkflowTask', () => {
  it('detects tracker completed via appStatus', () => {
    expect(isCompletedWorkflowTask({ appStatus: 'completed' })).toBe(true);
  });

  it('detects manual completed via status field', () => {
    expect(isCompletedWorkflowTask({ status: 'Completed' })).toBe(true);
  });

  it('returns false for active tracker task', () => {
    expect(isCompletedWorkflowTask({ appStatus: 'active' })).toBe(false);
  });

  it('returns false for pending manual task', () => {
    expect(isCompletedWorkflowTask({ status: 'Pending' })).toBe(false);
  });
});

// ── 7. Overdue KPI excludes completed tasks (logic mirror) ────────────────────
describe('KPI overdue excludes completed', () => {
  const trackerItems = [
    { id: 'a', appStatus: 'active',    deadline: PAST_DEADLINE },
    { id: 'b', appStatus: 'completed', deadline: PAST_DEADLINE }, // should NOT count
  ];
  const manualItems = [
    { id: 'c', status: 'Pending',   dueDate: PAST_DEADLINE },
    { id: 'd', status: 'Completed', dueDate: PAST_DEADLINE }, // should NOT count
  ];

  it('overdue KPI counts only active items with past deadline', () => {
    const now = new Date();
    const activeTk = trackerItems.filter(t => t.appStatus !== 'completed');
    const activeMn = manualItems.filter(m => m.status !== 'Completed');
    const overdueTk = activeTk.filter(t => t.deadline && new Date(t.deadline) < now).length;
    const overdueMn = activeMn.filter(m => m.dueDate  && new Date(m.dueDate)  < now).length;
    expect(overdueTk + overdueMn).toBe(2); // one tracker + one manual, both active + past deadline
  });

  it('completed tasks do not inflate the overdue count', () => {
    const now = new Date();
    const allWithCompleted = [...trackerItems, ...manualItems];
    const naiveOverdue = allWithCompleted.filter(t =>
      (t.deadline || t.dueDate) && new Date(t.deadline || t.dueDate) < now
    ).length;
    // naive count = 4, but after filtering completed it should be 2
    expect(naiveOverdue).toBe(4);

    const activeTk = trackerItems.filter(t => t.appStatus !== 'completed');
    const activeMn = manualItems.filter(m => m.status !== 'Completed');
    const correct = activeTk.filter(t => new Date(t.deadline) < now).length
                  + activeMn.filter(m => new Date(m.dueDate) < now).length;
    expect(correct).toBe(2);
    expect(correct).toBeLessThan(naiveOverdue);
  });
});

// ── 8. Completion row uses warning tone (amber), not error/red ────────────────
describe('completed late uses warning tone, not red', () => {
  it('tone is warning for late completion, not overdue/error', () => {
    const task = { deadline: PAST_DEADLINE, completedAt: COMPLETED_LATE };
    const outcome = getCompletionOutcome(task);
    expect(outcome.tone).toBe('warning');
    expect(outcome.tone).not.toBe('overdue');
    expect(outcome.tone).not.toBe('error');
  });

  it('tone is success for on-time completion', () => {
    const task = { deadline: PAST_DEADLINE, completedAt: COMPLETED_EARLY };
    expect(getCompletionOutcome(task).tone).toBe('success');
  });
});

// ── 9. Regression: manual completed follows same outcome logic ─────────────────
describe('manual task completion outcome', () => {
  it('manual task with dueDate (not deadline) uses itemDueDate fallback', () => {
    const task = { status: 'Completed', dueDate: PAST_DEADLINE, deadline: null, completedAt: null };
    const outcome = getCompletionOutcome(task);
    expect(outcome.outcome).toBe('COMPLETED_DATE_UNKNOWN');
    expect(outcome.label).toBe('Completed');
  });

  it('manual task on time with dueDate', () => {
    const task = { status: 'Completed', dueDate: PAST_DEADLINE, completedAt: COMPLETED_EARLY };
    expect(getCompletionOutcome(task).outcome).toBe('COMPLETED_ON_TIME');
  });
});
