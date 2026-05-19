import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildTrackerRowKey,
  buildManualWorkflowKey,
  findLinkedBackendTask,
  upsertTrackerTask,
  markLinkedTaskCompleted,
  markLinkedTaskSyncFailed,
  retryExcelSync,
  createManualWorkflowTask,
  updateManualTaskAssignee,
  completeManualTask,
} from '../trackerTaskBridge';

// ── Mock api ──────────────────────────────────────────────────────────────────
vi.mock('../api', () => ({
  tasks: {
    list:   vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

import { tasks as tasksApi } from '../api';

const TRACKER_TASK = {
  id:              'tk-1',
  legalTrackerId:  'Legal-row-6',
  workbookName:    'Legal Tracker.xlsx',
  sheetName:       'Active Matters',
  rowNumber:       6,
  rowKey:          'row-6-key',
  taskType:        'Legal',
  description:     'Update Contracts Management spreadsheet',
  parties:         'Internal',
  department:      'Legal',
  priority:        'Medium',
  deadline:        '2026-06-30T00:00:00.000Z',
  rawDeadlineText: 'Ongoing task',
};

const BACKEND_TASK = {
  _id:           'bk-abc123',
  title:         '[Tracker] Update Contracts Management spreadsheet',
  sourceType:    'LEGAL_TRACKER',
  trackerRowKey: 'LEGAL_TRACKER::Legal-row-6::Active Matters::6',
  syncStatus:    'SYNCED',
  status:        'Pending',
  trackerMeta:   { rowNumber: 6, legalTrackerId: 'Legal-row-6' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. buildTrackerRowKey ─────────────────────────────────────────────────────
describe('buildTrackerRowKey', () => {
  it('produces a stable key from legalTrackerId + sheetName + rowNumber', () => {
    const key = buildTrackerRowKey(TRACKER_TASK);
    expect(key).toBe('LEGAL_TRACKER::Legal-row-6::Active Matters::6');
  });

  it('falls back to row-N when legalTrackerId is absent', () => {
    const key = buildTrackerRowKey({ rowNumber: 12, sheetName: 'Sheet1' });
    expect(key).toBe('LEGAL_TRACKER::row-12::Sheet1::12');
  });

  it('falls back to Sheet1 when sheetName is absent', () => {
    const key = buildTrackerRowKey({ legalTrackerId: 'Legal-row-3', rowNumber: 3 });
    expect(key).toBe('LEGAL_TRACKER::Legal-row-3::Sheet1::3');
  });

  it('two tasks with same row produce the same key (dedup guarantee)', () => {
    const a = buildTrackerRowKey(TRACKER_TASK);
    const b = buildTrackerRowKey({ ...TRACKER_TASK, taskType: 'Different Type' });
    expect(a).toBe(b);
  });
});

// ── 2. buildManualWorkflowKey ─────────────────────────────────────────────────
describe('buildManualWorkflowKey', () => {
  it('returns MANUAL_WORKFLOW::{id}', () => {
    expect(buildManualWorkflowKey('manual-123')).toBe('MANUAL_WORKFLOW::manual-123');
  });
});

// ── 3. findLinkedBackendTask ──────────────────────────────────────────────────
describe('findLinkedBackendTask', () => {
  it('returns first task matching the trackerRowKey', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [BACKEND_TASK] });
    const result = await findLinkedBackendTask(BACKEND_TASK.trackerRowKey);
    expect(result).toEqual(BACKEND_TASK);
    expect(tasksApi.list).toHaveBeenCalledWith({ trackerRowKey: BACKEND_TASK.trackerRowKey, limit: 1 });
  });

  it('returns null when no task matches', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    const result = await findLinkedBackendTask('LEGAL_TRACKER::Legal-row-99::Sheet1::99');
    expect(result).toBeNull();
  });

  it('returns null on API error (silent)', async () => {
    tasksApi.list.mockRejectedValue(new Error('Network error'));
    const result = await findLinkedBackendTask('any-key');
    expect(result).toBeNull();
  });
});

// ── 4. upsertTrackerTask — CREATE path ───────────────────────────────────────
describe('upsertTrackerTask — create', () => {
  it('(test 1) assigning tracker row creates a task in Tasks', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] }); // no existing
    tasksApi.create.mockResolvedValue({ task: { ...BACKEND_TASK, _id: 'new-id' } });

    const result = await upsertTrackerTask({
      trackerTask:    TRACKER_TASK,
      assignedUserId: 'user-faith-id',
      note:           'Please handle',
    });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(tasksApi.create).toHaveBeenCalledOnce();

    const payload = tasksApi.create.mock.calls[0][0];
    expect(payload.sourceType).toBe('LEGAL_TRACKER');
    expect(payload.trackerRowKey).toBe('LEGAL_TRACKER::Legal-row-6::Active Matters::6');
    expect(payload.assignedTo).toBe('user-faith-id');
    expect(payload.trackerMeta.legalTrackerId).toBe('Legal-row-6');
    expect(payload.trackerMeta.workbookName).toBe('Legal Tracker.xlsx');
    expect(payload.trackerMeta.rowNumber).toBe(6);
    expect(payload.syncStatus).toBe('SYNCED');
  });

  it('stores the tracker row workbook/sheet/row in trackerMeta (no absolute path)', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    tasksApi.create.mockResolvedValue({ task: BACKEND_TASK });

    await upsertTrackerTask({ trackerTask: TRACKER_TASK, assignedUserId: 'u1' });

    const meta = tasksApi.create.mock.calls[0][0].trackerMeta;
    expect(meta).not.toHaveProperty('absolutePath');
    expect(meta).not.toHaveProperty('filePath');
    expect(meta.workbookName).toBe('Legal Tracker.xlsx');
    expect(meta.sheetName).toBe('Active Matters');
    expect(meta.rowNumber).toBe(6);
  });

  it('returns ok: false when tasksApi.create throws', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    tasksApi.create.mockRejectedValue(new Error('Server error'));
    const result = await upsertTrackerTask({ trackerTask: TRACKER_TASK, assignedUserId: 'u1' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Server error');
  });
});

// ── 5. upsertTrackerTask — UPDATE path (no duplicates) ───────────────────────
describe('upsertTrackerTask — update (no duplicate)', () => {
  it('(test 2) re-assigning same tracker row updates existing task, no duplicate', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [BACKEND_TASK] }); // existing found
    tasksApi.update.mockResolvedValue({ task: { ...BACKEND_TASK, assignedTo: 'user-new-id' } });

    const result = await upsertTrackerTask({
      trackerTask:    TRACKER_TASK,
      assignedUserId: 'user-new-id',
    });

    expect(result.ok).toBe(true);
    expect(result.created).toBe(false); // updated, not created
    expect(tasksApi.create).not.toHaveBeenCalled();
    expect(tasksApi.update).toHaveBeenCalledWith('bk-abc123', expect.objectContaining({
      assignedTo: 'user-new-id',
      syncStatus: 'SYNCED',
    }));
  });

  it('(test 17) assigning same tracker row twice does not create duplicate task', async () => {
    // First call: no existing → create
    tasksApi.list.mockResolvedValueOnce({ tasks: [] });
    tasksApi.create.mockResolvedValueOnce({ task: BACKEND_TASK });
    await upsertTrackerTask({ trackerTask: TRACKER_TASK, assignedUserId: 'u1' });

    // Second call: existing found → update
    tasksApi.list.mockResolvedValueOnce({ tasks: [BACKEND_TASK] });
    tasksApi.update.mockResolvedValueOnce({ task: BACKEND_TASK });
    await upsertTrackerTask({ trackerTask: TRACKER_TASK, assignedUserId: 'u2' });

    expect(tasksApi.create).toHaveBeenCalledTimes(1); // only once total
    expect(tasksApi.update).toHaveBeenCalledTimes(1);
  });
});

// ── 6. markLinkedTaskCompleted ────────────────────────────────────────────────
describe('markLinkedTaskCompleted', () => {
  it('(test 5) marks the linked backend task as Completed after Excel write', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [BACKEND_TASK] });
    tasksApi.update.mockResolvedValue({ task: { ...BACKEND_TASK, status: 'Completed' } });

    const result = await markLinkedTaskCompleted(TRACKER_TASK);

    expect(result.ok).toBe(true);
    expect(tasksApi.update).toHaveBeenCalledWith('bk-abc123', expect.objectContaining({
      status:     'Completed',
      syncStatus: 'SYNCED',
    }));
  });

  it('returns NOT_FOUND when no linked task exists', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    const result = await markLinkedTaskCompleted(TRACKER_TASK);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });
});

// ── 7. markLinkedTaskSyncFailed ───────────────────────────────────────────────
describe('markLinkedTaskSyncFailed', () => {
  it('(test 7) sets syncStatus = SYNC_FAILED on backend task when Excel write fails', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [BACKEND_TASK] });
    tasksApi.update.mockResolvedValue({ task: BACKEND_TASK });

    await markLinkedTaskSyncFailed(TRACKER_TASK, 'File locked');

    expect(tasksApi.update).toHaveBeenCalledWith('bk-abc123', expect.objectContaining({
      syncStatus: 'SYNC_FAILED',
    }));
  });

  it('is silent when no linked task exists', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    await expect(markLinkedTaskSyncFailed(TRACKER_TASK)).resolves.toBeUndefined();
  });
});

// ── 8. retryExcelSync ─────────────────────────────────────────────────────────
describe('retryExcelSync', () => {
  it('(test 8) calls trackerUpdateRow and marks backend task SYNCED on success', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({ ok: true });
    global.window = global.window || {};
    window.contractiq = { trackerUpdateRow: mockUpdate };
    tasksApi.update.mockResolvedValue({ task: { ...BACKEND_TASK, syncStatus: 'SYNCED' } });

    const task = {
      _id:          'bk-abc123',
      sourceType:   'LEGAL_TRACKER',
      trackerMeta:  { rowNumber: 6 },
      status:       'Completed',
      syncStatus:   'SYNC_FAILED',
    };

    const result = await retryExcelSync(task);

    expect(result.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      rowNumber:    6,
      fieldUpdates: { progress: 'Completed' },
    }));
    expect(tasksApi.update).toHaveBeenCalledWith('bk-abc123', expect.objectContaining({
      syncStatus: 'SYNCED',
    }));
  });

  it('returns NO_ROW when trackerMeta has no rowNumber', async () => {
    const task = { _id: 'bk-1', trackerMeta: {} };
    const result = await retryExcelSync(task);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_ROW');
  });

  it('returns NO_DESKTOP when window.contractiq is absent', async () => {
    delete window.contractiq;
    const task = { _id: 'bk-1', trackerMeta: { rowNumber: 6 } };
    const result = await retryExcelSync(task);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_DESKTOP');
  });

  it('returns WRITE_FAILED when IPC returns ok: false', async () => {
    window.contractiq = { trackerUpdateRow: vi.fn().mockResolvedValue({ ok: false, code: 'FILE_LOCKED' }) };
    const task = { _id: 'bk-1', trackerMeta: { rowNumber: 6 } };
    const result = await retryExcelSync(task);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FILE_LOCKED');
  });
});

// ── 9. createManualWorkflowTask ───────────────────────────────────────────────
describe('createManualWorkflowTask', () => {
  it('(test 10) creates a backend task with sourceType MANUAL_WORKFLOW', async () => {
    tasksApi.create.mockResolvedValue({ task: { _id: 'mn-1', sourceType: 'MANUAL_WORKFLOW' } });

    const localTask = {
      id:          'manual-abc',
      title:       'Draft policy memo',
      description: 'Write the new data retention policy',
      taskType:    'Internal Policy',
      department:  'Compliance',
      dueDate:     '2026-06-01',
      priority:    'High',
      notes:       'Due before quarter end',
    };

    const result = await createManualWorkflowTask({ localTask, assignedUserId: 'u-faith' });

    expect(result.ok).toBe(true);
    const payload = tasksApi.create.mock.calls[0][0];
    expect(payload.sourceType).toBe('MANUAL_WORKFLOW');
    expect(payload.workflowTaskId).toBe('manual-abc');
    expect(payload.title).toBe('Draft policy memo');
    expect(payload.assignedTo).toBe('u-faith');
  });

  it('creates task without assignee for unassigned manual tasks', async () => {
    tasksApi.create.mockResolvedValue({ task: { _id: 'mn-2', sourceType: 'MANUAL_WORKFLOW' } });
    const localTask = { id: 'manual-xyz', title: 'Review contracts', dueDate: null };
    const result = await createManualWorkflowTask({ localTask, assignedUserId: null });
    expect(result.ok).toBe(true);
    expect(tasksApi.create.mock.calls[0][0].assignedTo).toBeUndefined();
  });

  it('(test 11) stores workflowTaskId for cross-linking', async () => {
    tasksApi.create.mockResolvedValue({ task: { _id: 'mn-3' } });
    const localTask = { id: 'manual-link-test', title: 'Test task' };
    await createManualWorkflowTask({ localTask, assignedUserId: 'u1' });
    expect(tasksApi.create.mock.calls[0][0].workflowTaskId).toBe('manual-link-test');
  });

  it('returns ok: false when backend create throws', async () => {
    tasksApi.create.mockRejectedValue(new Error('Backend offline'));
    const localTask = { id: 'manual-fail', title: 'Fail task' };
    const result = await createManualWorkflowTask({ localTask });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Backend offline');
  });
});

// ── 18. Re-import dedup: rowKey-based preservation ───────────────────────────
describe('Re-import dedup', () => {
  it('(test 18) re-importing tracker uses same trackerRowKey so backend task is found (not duplicated)', async () => {
    // Simulate re-import: same legalTrackerId + sheetName + rowNumber → same key
    const reimportedTask = { ...TRACKER_TASK, taskType: 'Updated', description: 'Updated description' };
    const key1 = buildTrackerRowKey(TRACKER_TASK);
    const key2 = buildTrackerRowKey(reimportedTask);
    expect(key1).toBe(key2); // same key → same backend task found → no duplicate
  });

  it('(test 19) re-sync with same rowKey updates trackerMeta but preserves task assignment', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [BACKEND_TASK] });
    tasksApi.update.mockResolvedValue({ task: BACKEND_TASK });

    await upsertTrackerTask({
      trackerTask:    { ...TRACKER_TASK, parties: 'Updated Parties' },
      assignedUserId: 'user-faith-id',
    });

    // Should have updated, not created
    expect(tasksApi.create).not.toHaveBeenCalled();
    expect(tasksApi.update).toHaveBeenCalledWith('bk-abc123', expect.objectContaining({
      assignedTo: 'user-faith-id',
    }));
  });
});

// ── 10. updateManualTaskAssignee ──────────────────────────────────────────────
describe('updateManualTaskAssignee', () => {
  const MANUAL_BACKEND_TASK = {
    _id:           'mn-bk-1',
    sourceType:    'MANUAL_WORKFLOW',
    trackerRowKey: 'MANUAL_WORKFLOW::manual-abc',
    workflowTaskId:'manual-abc',
  };

  it('(test 11) finds linked backend task by workflowTaskId and updates assignedTo', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [MANUAL_BACKEND_TASK] });
    tasksApi.update.mockResolvedValue({ task: { ...MANUAL_BACKEND_TASK, assignedTo: 'u-faith' } });

    const result = await updateManualTaskAssignee({
      task: { id: 'manual-abc', sourceType: 'MANUAL_WORKFLOW' },
      assignedUserId: 'u-faith',
    });

    expect(result.ok).toBe(true);
    expect(tasksApi.update).toHaveBeenCalledWith('mn-bk-1', expect.objectContaining({
      assignedTo: 'u-faith',
    }));
  });

  it('(test 12) returns NOT_FOUND when no linked backend task exists', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    const result = await updateManualTaskAssignee({
      task: { id: 'manual-xyz', sourceType: 'MANUAL_WORKFLOW' },
      assignedUserId: 'u-faith',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns NO_WORKFLOW_TASK_ID when task has no id', async () => {
    const result = await updateManualTaskAssignee({
      task: { sourceType: 'MANUAL_WORKFLOW' },
      assignedUserId: 'u-faith',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_WORKFLOW_TASK_ID');
  });

  it('looks up workflowTaskId from trackerMeta when id field absent', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [MANUAL_BACKEND_TASK] });
    tasksApi.update.mockResolvedValue({ task: MANUAL_BACKEND_TASK });

    const result = await updateManualTaskAssignee({
      task: { trackerMeta: { workflowTaskId: 'manual-abc' }, sourceType: 'MANUAL_WORKFLOW' },
      assignedUserId: 'u-john',
    });

    expect(result.ok).toBe(true);
    expect(tasksApi.list).toHaveBeenCalledWith({ trackerRowKey: 'MANUAL_WORKFLOW::manual-abc', limit: 1 });
  });
});

// ── 11. completeManualTask ────────────────────────────────────────────────────
describe('completeManualTask', () => {
  const MANUAL_BACKEND_TASK = {
    _id:           'mn-bk-2',
    sourceType:    'MANUAL_WORKFLOW',
    trackerRowKey: 'MANUAL_WORKFLOW::manual-done',
    workflowTaskId:'manual-done',
    status:        'Pending',
  };

  it('(test 17) marks linked backend task Completed when manual task is completed in Workflows', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [MANUAL_BACKEND_TASK] });
    tasksApi.update.mockResolvedValue({ task: { ...MANUAL_BACKEND_TASK, status: 'Completed' } });

    const result = await completeManualTask({ id: 'manual-done', sourceType: 'MANUAL_WORKFLOW' });

    expect(result.ok).toBe(true);
    expect(tasksApi.update).toHaveBeenCalledWith('mn-bk-2', expect.objectContaining({
      status: 'Completed',
    }));
  });

  it('returns NOT_FOUND when no linked backend task exists', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [] });
    const result = await completeManualTask({ id: 'manual-none' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns NO_WORKFLOW_TASK_ID when task has no id', async () => {
    const result = await completeManualTask({ sourceType: 'MANUAL_WORKFLOW' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_WORKFLOW_TASK_ID');
  });
});
