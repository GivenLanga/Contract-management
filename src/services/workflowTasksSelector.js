// Shared selector for Tasks page workflow data.
// Reads the same localStorage stores as Workflows page — ensures both pages see identical data.

import { trackerTasks as trackerTasksStore, manualTasks as manualTasksStore } from './legalTrackerStore';
import { getSigningDocuments } from './signingStore';
import { documents as documentsApi } from './api';

export function calcDueState(dateVal) {
  if (!dateVal) return 'unknown';
  const now  = Date.now();
  const d    = new Date(dateVal).getTime();
  if (isNaN(d)) return 'unknown';
  const diff = d - now;
  if (diff < 0)            return 'overdue';
  if (diff < 86400000)     return 'today';
  if (diff < 7 * 86400000) return 'soon';
  return 'ok';
}

// Normalize a raw localStorage tracker item into the shape Tasks page expects.
// The output is intentionally compatible with AssignModal and DoneConfirmModal, which
// read task.rowNumber, task.legalTrackerId, task.sheetName, etc. at the top level.
export function normalizeWorkflowItemForTaskView(raw, type) {
  if (type === 'TRACKER') {
    const dueDate    = raw.deadline || null;
    const isComplete = raw.appStatus === 'completed';
    return {
      id:             raw.id,
      _id:            null,
      _type:          'TRACKER',
      sourceType:     'LEGAL_TRACKER',
      title:          raw.description || raw.taskType || 'Tracker Task',
      description:    raw.description,
      parties:        raw.parties,
      taskType:       raw.taskType,
      department:     raw.department,
      purpose:        raw.purpose,
      keyLearning:    raw.keyLearning,
      // Assignee as object so WorkflowItemRow and AssignModal share the same accessor
      assignee:       raw.assignee ? { name: raw.assignee } : null,
      assignedTo:     raw.assignee ? { name: raw.assignee } : null,
      dueDate,
      deadline:       dueDate,
      rawDeadlineText: raw.rawDeadlineText,
      status:         isComplete ? 'Completed' : (raw.status || 'Active'),
      appStatus:      raw.appStatus,
      progress:       raw.progress,
      pipelineStage:  raw.pipelineStage,
      dueState:       isComplete ? null : calcDueState(dueDate),
      completedAt:    raw.completedAt || null,
      syncStatus:     raw.syncStatus || null,
      // Tracker-specific top-level fields (required by AssignModal & DoneConfirmModal)
      legalTrackerId: raw.legalTrackerId,
      workbookName:   raw.workbookName,
      sheetName:      raw.sheetName,
      rowNumber:      raw.rowNumber,
      rowKey:         raw.rowKey,
      // Also packaged as trackerMeta for the existing TaskList assign/done handlers
      trackerMeta: {
        legalTrackerId:  raw.legalTrackerId,
        workbookName:    raw.workbookName,
        sheetName:       raw.sheetName,
        rowNumber:       raw.rowNumber,
        rowKey:          raw.rowKey,
        taskType:        raw.taskType,
        parties:         raw.parties,
        department:      raw.department,
        rawDeadlineText: raw.rawDeadlineText,
      },
    };
  }

  if (type === 'MANUAL') {
    const dueDate    = raw.dueDate || null;
    const isComplete = raw.status === 'Completed';
    return {
      id:            raw.id,
      _id:           null,
      _type:         'MANUAL',
      sourceType:    'MANUAL_WORKFLOW',
      title:         raw.title,
      description:   raw.description,
      notes:         raw.notes,
      taskType:      raw.taskType,
      department:    raw.department,
      assignee:      raw.assignee ? { name: raw.assignee } : null,
      assignedTo:    raw.assignee ? { name: raw.assignee } : null,
      dueDate,
      deadline:      dueDate,
      status:        isComplete ? 'Completed' : (raw.status || 'Pending'),
      appStatus:     isComplete ? 'completed' : null,
      pipelineStage: raw.pipelineStage,
      dueState:      isComplete ? null : calcDueState(dueDate),
      completedAt:   raw.completedAt || null,
      workflowTaskId: raw.id,
      trackerMeta: {
        workflowTaskId: raw.id,
        taskType:   raw.taskType,
        department: raw.department,
        notes:      raw.notes,
      },
    };
  }

  return { ...raw };
}

export function isCompletedWorkflowItem(item) {
  return item.appStatus === 'completed' || item.status === 'Completed';
}

export function isActiveWorkflowItem(item) {
  return !isCompletedWorkflowItem(item);
}

// Returns all workflow items (active + completed), normalized for the Tasks page.
export function loadAllWorkflowItems() {
  const trackerItems = trackerTasksStore.get();
  const manualItems  = manualTasksStore.get();
  return [
    ...trackerItems.map(t => normalizeWorkflowItemForTaskView(t, 'TRACKER')),
    ...manualItems.map(m => normalizeWorkflowItemForTaskView(m, 'MANUAL')),
  ];
}

export function getActiveWorkflowTasksForTasksPage() {
  return loadAllWorkflowItems().filter(isActiveWorkflowItem);
}

// Merges server documents with local signing records, same logic as SigningDashboard.
// Returns all docs where status === 'Pending Signature' (the Sent — Waiting set).
export async function getSignatureFollowUpsForTasksPage() {
  const localDocs = getSigningDocuments();
  let serverDocs  = [];
  try {
    const data = await documentsApi.list({ limit: 200 });
    serverDocs  = data.documents || [];
  } catch {
    // offline / no server — fall back to local only
  }

  const merged = new Map();
  // Server takes priority, same merge strategy as SigningDashboard
  serverDocs.forEach(doc => merged.set(doc._id, doc));
  localDocs.forEach(doc => {
    if (!merged.has(doc._id)) merged.set(doc._id, doc);
  });

  return Array.from(merged.values()).filter(d => d.status === 'Pending Signature');
}
