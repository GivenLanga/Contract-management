// Two-way bridge between Legal Tracker spreadsheet rows and ContractIQ backend tasks.
// Rules:
//   - Tracker row → backend task only when assigned (requires an assignee user ID).
//   - Stable dedup key prevents duplicate task creation on re-assign.
//   - Excel never leaves the local machine; trackerMeta stores only non-path metadata.
//   - Manual workflow tasks get their own sourceType and never trigger Excel writes.

import { tasks as tasksApi } from './api';

// ── Stable key ────────────────────────────────────────────────────────────────
// Format: LEGAL_TRACKER::{legalTrackerId}::{sheetName}::{rowNumber}
// This key is stored on the backend task for dedup and lookup.
export function buildTrackerRowKey(task) {
  const id    = task.legalTrackerId || `row-${task.rowNumber ?? 0}`;
  const sheet = task.sheetName     || 'Sheet1';
  const row   = task.rowNumber     ?? 0;
  return `LEGAL_TRACKER::${id}::${sheet}::${row}`;
}

export function buildManualWorkflowKey(workflowTaskId) {
  return `MANUAL_WORKFLOW::${workflowTaskId}`;
}

// ── Lookup ────────────────────────────────────────────────────────────────────
export async function findLinkedBackendTask(trackerRowKey) {
  try {
    const data = await tasksApi.list({ trackerRowKey, limit: 1 });
    return (data.tasks || [])[0] || null;
  } catch {
    return null;
  }
}

// ── Upsert tracker task ───────────────────────────────────────────────────────
// Creates or updates the backend task linked to a tracker row.
// Returns { ok, task, created } or { ok: false, message }.
export async function upsertTrackerTask({ trackerTask, assignedUserId, note }) {
  const trackerRowKey = buildTrackerRowKey(trackerTask);

  // Fallback deadline: 7 days out if no date is available
  const deadlineIso = trackerTask.deadline
    ? (() => { const d = new Date(trackerTask.deadline); return isNaN(d) ? null : d.toISOString(); })()
    : new Date(Date.now() + 7 * 86400000).toISOString();

  const trackerMeta = {
    legalTrackerId: trackerTask.legalTrackerId,
    workbookName:   trackerTask.workbookName,
    sheetName:      trackerTask.sheetName,
    rowNumber:      trackerTask.rowNumber,
    rowKey:         trackerTask.rowKey,
    taskType:       trackerTask.taskType,
    parties:        trackerTask.parties,
    department:     trackerTask.department,
    rawDeadlineText: trackerTask.rawDeadlineText,
  };

  try {
    const existing = await findLinkedBackendTask(trackerRowKey);

    if (existing) {
      const updated = await tasksApi.update(existing._id, {
        assignedTo:   assignedUserId,
        description:  note || existing.description,
        deadline:     deadlineIso,
        syncStatus:   'SYNCED',
        lastSyncedAt: new Date().toISOString(),
        trackerMeta,
      });
      return { ok: true, task: updated.task, created: false };
    }

    const created = await tasksApi.create({
      title:         `[Tracker] ${trackerTask.description || trackerTask.taskType || 'Legal Tracker Task'}`,
      description:   note || `Assigned from Legal Tracker: ${trackerTask.legalTrackerId || `row ${trackerTask.rowNumber}`}`,
      type:          'GENERAL_TASK',
      assignedTo:    assignedUserId,
      deadline:      deadlineIso,
      priority:      trackerTask.priority || 'Medium',
      status:        'Pending',
      sourceType:    'LEGAL_TRACKER',
      trackerRowKey,
      trackerMeta,
      syncStatus:    'SYNCED',
      lastSyncedAt:  new Date().toISOString(),
    });
    return { ok: true, task: created.task, created: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ── Mark linked task completed ────────────────────────────────────────────────
// Called after a successful Excel write from DoneConfirmModal or from TaskList.
export async function markLinkedTaskCompleted(trackerTask) {
  const trackerRowKey = buildTrackerRowKey(trackerTask);
  try {
    const existing = await findLinkedBackendTask(trackerRowKey);
    if (!existing) return { ok: false, code: 'NOT_FOUND' };
    await tasksApi.update(existing._id, {
      status:       'Completed',
      syncStatus:   'SYNCED',
      lastSyncedAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ── Mark linked task sync failed ──────────────────────────────────────────────
// Called when the Excel write fails, to record the failure on the backend task.
export async function markLinkedTaskSyncFailed(trackerTask, reason) {
  const trackerRowKey = buildTrackerRowKey(trackerTask);
  try {
    const existing = await findLinkedBackendTask(trackerRowKey);
    if (!existing) return;
    await tasksApi.update(existing._id, {
      syncStatus:   'SYNC_FAILED',
      progressNote: reason || 'Excel sync failed. Retry required.',
    });
  } catch {
    // Non-critical — don't surface this error
  }
}

// ── Retry sync from TaskList ──────────────────────────────────────────────────
// Wraps the Electron IPC call + backend status update for the "Retry Sync" button.
// Returns { ok, code?, message? }
export async function retryExcelSync(task) {
  const { trackerMeta } = task;
  if (!trackerMeta?.rowNumber) return { ok: false, code: 'NO_ROW' };
  if (!window.contractiq?.trackerUpdateRow) return { ok: false, code: 'NO_DESKTOP' };

  let res;
  try {
    res = await window.contractiq.trackerUpdateRow({
      rowNumber:    trackerMeta.rowNumber,
      fieldUpdates: { progress: 'Completed' },
    });
  } catch (err) {
    res = { ok: false, message: String(err?.message || err) };
  }

  if (!res?.ok) return { ok: false, code: res?.code || 'WRITE_FAILED', message: res?.message };

  // Mark synced on backend
  try {
    await tasksApi.update(task._id, {
      syncStatus:   'SYNCED',
      lastSyncedAt: new Date().toISOString(),
      progressNote: null,
    });
  } catch {
    // Best effort
  }
  return { ok: true };
}

// ── Update manual workflow task assignee ──────────────────────────────────────
// Called when a manual task is assigned from either Tasks page or Workflows page.
// Returns { ok } or { ok: false, code?, message? }.
export async function updateManualTaskAssignee({ task, assignedUserId }) {
  const workflowTaskId =
    task.id || task.workflowTaskId || task.trackerMeta?.workflowTaskId;
  if (!workflowTaskId) return { ok: false, code: 'NO_WORKFLOW_TASK_ID' };

  const trackerRowKey = buildManualWorkflowKey(workflowTaskId);
  try {
    const existing = await findLinkedBackendTask(trackerRowKey);
    if (!existing) return { ok: false, code: 'NOT_FOUND' };
    await tasksApi.update(existing._id, { assignedTo: assignedUserId });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ── Mark manual workflow backend task completed ───────────────────────────────
// Called when a manual task is completed from Workflows so Tasks reflects it.
export async function completeManualTask(task) {
  const workflowTaskId =
    task.id || task.workflowTaskId || task.trackerMeta?.workflowTaskId;
  if (!workflowTaskId) return { ok: false, code: 'NO_WORKFLOW_TASK_ID' };

  const trackerRowKey = buildManualWorkflowKey(workflowTaskId);
  try {
    const existing = await findLinkedBackendTask(trackerRowKey);
    if (!existing) return { ok: false, code: 'NOT_FOUND' };
    await tasksApi.update(existing._id, {
      status:      'Completed',
      syncStatus:  'SYNCED',
      lastSyncedAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ── Create manual workflow backend task ───────────────────────────────────────
// Called when a manual task is saved from ManualTaskModal.
// Returns { ok, task } or { ok: false, message }.
export async function createManualWorkflowTask({ localTask, assignedUserId }) {
  const workflowTaskId = localTask.id;

  const deadlineIso = localTask.dueDate
    ? (() => { const d = new Date(localTask.dueDate); return isNaN(d) ? null : d.toISOString(); })()
    : null;

  try {
    const created = await tasksApi.create({
      title:          localTask.title,
      description:    localTask.description || null,
      type:           'GENERAL_TASK',
      assignedTo:     assignedUserId || undefined,
      deadline:       deadlineIso || new Date(Date.now() + 30 * 86400000).toISOString(),
      priority:       localTask.priority || 'Medium',
      status:         'Pending',
      sourceType:     'MANUAL_WORKFLOW',
      trackerRowKey:  buildManualWorkflowKey(workflowTaskId),
      trackerMeta: {
        workflowTaskId,
        taskType:   localTask.taskType,
        department: localTask.department,
        notes:      localTask.notes,
      },
      workflowTaskId,
    });
    return { ok: true, task: created.task };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
