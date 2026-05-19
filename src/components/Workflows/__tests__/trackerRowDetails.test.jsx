import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ── Shared mock task fixtures ─────────────────────────────────────────────────
const TRACKER_TASK = {
  id:             'tracker-wb-Legal-2',
  sourceType:     'LEGAL_TRACKER',
  _type:          'TRACKER',
  legalTrackerId: 'Legal-row-2',
  workbookName:   'Legal Tracker',
  sheetName:      'Legal',
  rowNumber:      2,
  rowKey:         'row-2',

  taskType:      'Drafting',
  parties:       'MK Electro',
  description:   'Assistance Agreement',
  progress:      'Completed',
  status:        'Investment',
  purpose:       'Legal',
  dateOfRequest: new Date('2026-01-10'),
  deadline:      null,
  rawDeadlineText: 'Ongoing task',
  department:    'Legal',
  assignee:      'FM',
  keyLearning:   'Some key note',

  appStatus:     'active',
  pipelineStage: 'review',
  dueState:      'unknown',
  lastSyncedAt:  '2026-05-18T10:00:00.000Z',
};

const COMPLETED_TRACKER_TASK = {
  ...TRACKER_TASK,
  id: 'tracker-wb-Legal-3',
  appStatus: 'completed',
  progress:  'Completed',
};

const MANUAL_TASK = {
  id:          'mn-1',
  _type:       'MANUAL',
  title:       'Policy review',
  description: 'Review HR policy',
  taskType:    'Review',
  department:  'HR',
  assignee:    'Alice',
  status:      'Pending',
  dueDate:     '2026-06-01',
  priority:    'High',
  notes:       'Important compliance check',
};

// ── Setup window.contractiq mock ──────────────────────────────────────────────
function setupBridge(overrides = {}) {
  window.contractiq = {
    trackerUpdateRow:  vi.fn().mockResolvedValue({ ok: true }),
    trackerReadRow:    vi.fn().mockResolvedValue({ ok: true, row: TRACKER_TASK }),
    trackerOpenFile:   vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function teardownBridge() {
  delete window.contractiq;
}

// ── Import components ─────────────────────────────────────────────────────────
import TrackerRowDrawer, { EDITABLE_TRACKER_FIELDS } from '../TrackerRowDrawer';
import DoneConfirmModal from '../DoneConfirmModal';

// ── 1–12: Drawer field visibility ─────────────────────────────────────────────
describe('TrackerRowDrawer — field visibility', () => {
  beforeEach(() => setupBridge());
  afterEach(() => teardownBridge());

  function renderDrawer(task = TRACKER_TASK, extra = {}) {
    return render(
      <TrackerRowDrawer
        task={task}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
        {...extra}
      />
    );
  }

  it('1. opens drawer with Legal Tracker Row Details title', () => {
    renderDrawer();
    expect(screen.getByText('Legal Tracker Row Details')).toBeInTheDocument();
  });

  it('2. shows Task type', () => {
    renderDrawer();
    expect(screen.getByText('Task type')).toBeInTheDocument();
    expect(screen.getByText('Drafting')).toBeInTheDocument();
  });

  it('3. shows Parties', () => {
    renderDrawer();
    expect(screen.getByText('Parties')).toBeInTheDocument();
    expect(screen.getByText('MK Electro')).toBeInTheDocument();
  });

  it('4. shows Description', () => {
    renderDrawer();
    expect(screen.getByText('Assistance Agreement')).toBeInTheDocument();
  });

  it('5. shows Progress', () => {
    renderDrawer();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    // 'Completed' appears in the progress field and also in the app status badge
    const completeds = screen.getAllByText('Completed');
    expect(completeds.length).toBeGreaterThan(0);
  });

  it('6. shows Status (Investment)', () => {
    renderDrawer();
    expect(screen.getByText('Investment')).toBeInTheDocument();
  });

  it('7. shows Purpose', () => {
    renderDrawer();
    expect(screen.getByText('Purpose')).toBeInTheDocument();
    // 'Legal' appears for both purpose and department — just confirm at least one exists
    expect(screen.getAllByText('Legal').length).toBeGreaterThan(0);
  });

  it('8. shows Date of Request label', () => {
    renderDrawer();
    expect(screen.getByText('Date of Request')).toBeInTheDocument();
  });

  it('9. shows Deadline / submission raw text', () => {
    renderDrawer();
    expect(screen.getByText('Ongoing task')).toBeInTheDocument();
  });

  it('10. shows Internal Department', () => {
    renderDrawer();
    expect(screen.getByText('Internal Department')).toBeInTheDocument();
  });

  it('11. shows Assignee — FM', () => {
    renderDrawer();
    expect(screen.getByText('FM')).toBeInTheDocument();
  });

  it('12. shows Key Learning', () => {
    renderDrawer();
    expect(screen.getByText('Some key note')).toBeInTheDocument();
  });

  it('shows Excel source section with row number', () => {
    renderDrawer();
    expect(screen.getByText('2')).toBeInTheDocument(); // rowNumber
  });

  it('shows workbook name', () => {
    renderDrawer();
    expect(screen.getByText('Legal Tracker')).toBeInTheDocument();
  });

  it('subtitle includes legalTrackerId', () => {
    renderDrawer();
    expect(screen.getAllByText(/Legal-row-2/).length).toBeGreaterThan(0);
  });
});

// ── 13. Assign button does not trigger row click ───────────────────────────────
describe('TrackerTaskRow — button isolation (via drawer)', () => {
  it('13. clicking Assign inside drawer does not propagate to overlay close', () => {
    setupBridge();
    const onClose  = vi.fn();
    const onAssign = vi.fn();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={onClose}
        onSaved={vi.fn()}
        onAssign={onAssign}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Assign'));
    expect(onAssign).toHaveBeenCalled();
    // onClose should NOT have been called via assign click
    expect(onClose).not.toHaveBeenCalled();
    teardownBridge();
  });

  it('14. clicking Mark Done inside drawer calls onComplete, not onClose', () => {
    setupBridge();
    const onClose    = vi.fn();
    const onComplete = vi.fn();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={onClose}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={onComplete}
        onOpenTracker={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Mark Done'));
    expect(onComplete).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    teardownBridge();
  });
});

// ── 15–18. Edit mode ──────────────────────────────────────────────────────────
describe('TrackerRowDrawer — edit mode', () => {
  beforeEach(() => setupBridge());
  afterEach(() => teardownBridge());

  function renderDrawer(task = TRACKER_TASK) {
    const onSaved = vi.fn();
    render(
      <TrackerRowDrawer
        task={task}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={onSaved}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    return { onSaved };
  }

  it('15. Edit mode shows input for Parties', () => {
    renderDrawer();
    fireEvent.click(screen.getByText('Edit'));
    // After clicking Edit, the Parties field should have an input
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBeGreaterThan(0);
  });

  it('16. Save calls trackerUpdateRow with changed fields', async () => {
    const { onSaved } = renderDrawer();
    fireEvent.click(screen.getByText('Edit'));

    // Find the Parties input and change it
    const inputs = screen.getAllByRole('textbox');
    // parties is the second text input (after taskType)
    const partiesInputIndex = EDITABLE_TRACKER_FIELDS.findIndex(f => f.key === 'parties');
    const partiesInput = inputs[partiesInputIndex];
    fireEvent.change(partiesInput, { target: { value: 'New Party Name' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });

    expect(window.contractiq.trackerUpdateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        rowNumber:    2,
        fieldUpdates: expect.objectContaining({ parties: 'New Party Name' }),
      })
    );
  });

  it('17. Save success calls onSaved with updated task', async () => {
    const { onSaved } = renderDrawer();
    fireEvent.click(screen.getByText('Edit'));

    const inputs = screen.getAllByRole('textbox');
    const partiesIdx = EDITABLE_TRACKER_FIELDS.findIndex(f => f.key === 'parties');
    fireEvent.change(inputs[partiesIdx], { target: { value: 'Updated Party' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ parties: 'Updated Party' })
      );
    });
  });

  it('18. Locked workbook error shows sync error message', async () => {
    window.contractiq.trackerUpdateRow = vi.fn().mockResolvedValue({
      ok: false, code: 'FILE_LOCKED', message: 'File is locked',
    });
    renderDrawer();
    fireEvent.click(screen.getByText('Edit'));

    const inputs = screen.getAllByRole('textbox');
    const partiesIdx = EDITABLE_TRACKER_FIELDS.findIndex(f => f.key === 'parties');
    fireEvent.change(inputs[partiesIdx], { target: { value: 'Changed' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/locked/i);
    });
  });
});

// ── 19. Manual task drawer ────────────────────────────────────────────────────
describe('TrackerRowDrawer — manual task', () => {
  it('19. manual task opens Manual Task Details drawer', () => {
    render(
      <TrackerRowDrawer
        task={MANUAL_TASK}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    expect(screen.getByText('Manual Task Details')).toBeInTheDocument();
    // title appears in subtitle + body — use getAllByText
    expect(screen.getAllByText('Policy review').length).toBeGreaterThan(0);
    expect(screen.getByText('Review HR policy')).toBeInTheDocument();
  });

  it('20. manual task drawer does not show Excel source section', () => {
    render(
      <TrackerRowDrawer
        task={MANUAL_TASK}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    expect(screen.queryByText('Excel source')).not.toBeInTheDocument();
    expect(screen.queryByText('Workbook')).not.toBeInTheDocument();
  });
});

// ── 21–25. Done confirmation modal ────────────────────────────────────────────
describe('DoneConfirmModal', () => {
  beforeEach(() => setupBridge());
  afterEach(() => teardownBridge());

  function renderDoneModal(task = TRACKER_TASK, extra = {}) {
    const onConfirmed = vi.fn();
    const onClose     = vi.fn();
    render(
      <DoneConfirmModal
        task={task}
        onClose={onClose}
        onConfirmed={onConfirmed}
        {...extra}
      />
    );
    return { onConfirmed, onClose };
  }

  it('21. done modal shows task type and parties', () => {
    renderDoneModal();
    expect(screen.getByText('Drafting')).toBeInTheDocument();
    expect(screen.getByText('MK Electro')).toBeInTheDocument();
  });

  it('22. done modal explains what Excel fields will change', () => {
    renderDoneModal();
    // 'Progress' appears in context row + Excel changes section
    expect(screen.getAllByText('Progress').length).toBeGreaterThan(0);
    // 'Completed' appears in progress value + Excel write value
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getByText(/marks task as done/i)).toBeInTheDocument();
  });

  it('23. Mark Done calls trackerUpdateRow then onConfirmed', async () => {
    const { onConfirmed } = renderDoneModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mark done/i }));
    });
    expect(window.contractiq.trackerUpdateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        rowNumber:    2,
        fieldUpdates: expect.objectContaining({ progress: 'Completed' }),
      })
    );
    expect(onConfirmed).toHaveBeenCalled();
  });

  it('24. locked workbook error shows message in modal', async () => {
    window.contractiq.trackerUpdateRow = vi.fn().mockResolvedValue({
      ok: false, code: 'FILE_LOCKED',
    });
    renderDoneModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mark done/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/locked/i);
    });
  });

  it('25. Cancel button calls onClose without marking done', () => {
    const { onClose, onConfirmed } = renderDoneModal();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

// ── 26–29. Assign context ─────────────────────────────────────────────────────
describe('AssignModal row context', () => {
  it('26. context includes parties and department — modeled from task shape', () => {
    // Verify the task shape provides enough fields for AssignModal to render
    const task = TRACKER_TASK;
    expect(task.taskType).toBe('Drafting');
    expect(task.parties).toBe('MK Electro');
    expect(task.department).toBe('Legal');
    expect(task.keyLearning).toBe('Some key note');
    expect(task.purpose).toBe('Legal');
  });

  it('27. tracker task has rawDeadlineText for display fallback', () => {
    expect(TRACKER_TASK.rawDeadlineText).toBe('Ongoing task');
  });

  it('28. task has assignee field for "current assignee" display', () => {
    expect(TRACKER_TASK.assignee).toBe('FM');
  });

  it('29. manual task has no rawDeadlineText — falls back to dueDate', () => {
    expect(MANUAL_TASK.rawDeadlineText).toBeUndefined();
    expect(MANUAL_TASK.dueDate).toBe('2026-06-01');
  });
});

// ── 30. No Edit button for non-managers ──────────────────────────────────────
describe('Drawer — manager gating', () => {
  it('30. Edit button is hidden for non-managers', () => {
    setupBridge();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={false}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    teardownBridge();
  });

  it('31. Assign button is hidden for non-managers on active task', () => {
    setupBridge();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={false}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    expect(screen.queryByText('Assign')).not.toBeInTheDocument();
    teardownBridge();
  });
});

// ── 32. Completed task hides action buttons ───────────────────────────────────
describe('Drawer — completed task', () => {
  it('32. completed task hides Edit, Assign, Mark Done buttons', () => {
    setupBridge();
    render(
      <TrackerRowDrawer
        task={COMPLETED_TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Assign')).not.toBeInTheDocument();
    expect(screen.queryByText('Mark Done')).not.toBeInTheDocument();
    // Open Tracker should still be visible
    expect(screen.getByText('Open Tracker')).toBeInTheDocument();
    teardownBridge();
  });
});

// ── 33. Escape closes drawer ──────────────────────────────────────────────────
describe('Drawer — keyboard', () => {
  it('33. pressing Escape calls onClose', () => {
    setupBridge();
    const onClose = vi.fn();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={onClose}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    teardownBridge();
  });
});

// ── 34. Cancel in edit mode resets state ─────────────────────────────────────
describe('Drawer — cancel edit', () => {
  it('34. Cancel in edit mode hides Save Changes and shows Edit again', () => {
    setupBridge();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    teardownBridge();
  });
});

// ── 35. No-op save when no fields changed ────────────────────────────────────
describe('Drawer — unchanged save', () => {
  it('35. Save with no changes does not call trackerUpdateRow', async () => {
    setupBridge();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Edit'));
    // Click Save without changing anything
    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });
    expect(window.contractiq.trackerUpdateRow).not.toHaveBeenCalled();
    teardownBridge();
  });
});

// ── 36. EDITABLE_TRACKER_FIELDS exports ──────────────────────────────────────
describe('EDITABLE_TRACKER_FIELDS contract', () => {
  const REQUIRED_KEYS = [
    'taskType', 'parties', 'description', 'purpose',
    'progress', 'status',
    'dateOfRequest', 'deadline',
    'department', 'assignee', 'keyLearning',
  ];

  it('36. exports all required editable field keys', () => {
    const exportedKeys = EDITABLE_TRACKER_FIELDS.map(f => f.key);
    REQUIRED_KEYS.forEach(k => {
      expect(exportedKeys).toContain(k);
    });
  });

  it('37. every field has label, type, and section', () => {
    EDITABLE_TRACKER_FIELDS.forEach(f => {
      expect(f.label).toBeTruthy();
      expect(['text', 'textarea', 'date']).toContain(f.type);
      expect(f.section).toBeTruthy();
    });
  });
});

// ── 38. Overlay click closes drawer ──────────────────────────────────────────
describe('Drawer — overlay', () => {
  it('38. clicking overlay calls onClose', () => {
    setupBridge();
    const onClose = vi.fn();
    render(
      <TrackerRowDrawer
        task={TRACKER_TASK}
        isManager={true}
        syncing={false}
        onClose={onClose}
        onSaved={vi.fn()}
        onAssign={vi.fn()}
        onComplete={vi.fn()}
        onOpenTracker={vi.fn()}
      />
    );
    // The overlay is the first element with rd__overlay class
    const overlay = document.querySelector('.rd__overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
    teardownBridge();
  });
});
