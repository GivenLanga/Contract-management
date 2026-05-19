import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Header from '../Layout/Header';
import { getDaysLabel } from '../../services/dateDisplay';
import { trackerConfig, trackerTasks as trackerTasksStore, manualTasks as manualTasksStore, workflowTemplates } from '../../services/legalTrackerStore';
import { completeManualTask } from '../../services/trackerTaskBridge';
import LegalTrackerCard   from './LegalTrackerCard';
import AssignModal        from './AssignModal';
import ManualTaskModal    from './ManualTaskModal';
import TemplateModal      from './TemplateModal';
import TrackerRowDrawer   from './TrackerRowDrawer';
import DoneConfirmModal   from './DoneConfirmModal';
import './Workflows.css';

// ── Pipeline column definitions ────────────────────────────────────────────────
const PIPELINE_COLS = [
  { key: 'intake',     label: 'Intake',             statuses: ['SUBMITTED', 'INTAKE_REVIEW'],                        color: '#64748b' },
  { key: 'assigned',   label: 'Assigned',            statuses: ['ASSIGNED'],                                          color: '#4f8ef7' },
  { key: 'review',     label: 'Legal Review',        statuses: ['IN_LEGAL_REVIEW', 'INTERNAL_LEGAL_REVIEW'],          color: '#4f8ef7' },
  { key: 'external',   label: 'Ext. Review (Email)', statuses: ['SENT_TO_EXTERNAL_PARTY', 'WAITING_FOR_EXTERNAL_PARTY', 'EXTERNAL_FEEDBACK_RECEIVED', 'NEGOTIATION_AMENDMENTS'], color: '#0d9488' },
  { key: 'business',   label: 'With Business',       statuses: ['WITH_BUSINESS_DEPARTMENT'],                          color: '#f59e0b' },
  { key: 'manager',    label: 'With Manager',        statuses: ['WITH_MANAGER', 'REVISIONS_REQUIRED', 'MANAGER_APPROVED', 'APPROVED'], color: '#8b5cf6' },
  { key: 'signature',  label: 'Signature',           statuses: ['READY_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'], color: '#10b981' },
  { key: 'complete',   label: 'Done',                statuses: ['FULLY_SIGNED', 'STORED', 'FINALIZED', 'CLOSED'],     color: '#94a3b8' },
];

// ── Item normalizers ───────────────────────────────────────────────────────────
function itemDueDate(item)    { return item.dueDate || item.deadline || null; }
function itemAssignee(item)   { return item.assignedTo || (item.assignee ? { name: item.assignee } : null); }
function itemLastUpdate(item) { return item.lastStatusChangeAt || item.lastSyncedAt || item.updatedAt || null; }

// ── Primary tabs ───────────────────────────────────────────────────────────────
const PRIMARY_TABS = [
  { key: 'all',       label: 'All' },
  { key: 'tracker',   label: 'Tracker' },
  { key: 'manual',    label: 'Manual' },
  { key: 'completed', label: 'Completed' },
  { key: 'warnings',  label: 'Warnings' },
];

// ── Secondary filters per primary tab ─────────────────────────────────────────
const SECONDARY_FILTERS = {
  all: [
    { key: 'all',          label: 'All Active' },
    { key: 'overdue',      label: 'Overdue' },
    { key: 'dueToday',     label: 'Due Today' },
    { key: 'dueThisWeek',  label: 'Due This Week' },
    { key: 'unassigned',   label: 'Unassigned' },
    { key: 'withManager',  label: 'With Manager' },
    { key: 'withBusiness', label: 'With Business' },
    { key: 'signature',    label: 'Signature Track' },
    { key: 'noUpdate',     label: 'No Update 3d' },
  ],
  tracker: [
    { key: 'all',          label: 'All Active' },
    { key: 'overdue',      label: 'Overdue' },
    { key: 'dueToday',     label: 'Due Today' },
    { key: 'dueThisWeek',  label: 'Due This Week' },
    { key: 'unassigned',   label: 'Unassigned' },
    { key: 'withManager',  label: 'With Manager' },
    { key: 'withBusiness', label: 'With Business' },
    { key: 'signature',    label: 'Signature Track' },
    { key: 'noUpdate',     label: 'No Update 3d' },
  ],
  manual: [
    { key: 'all',          label: 'All Active' },
    { key: 'overdue',      label: 'Overdue' },
    { key: 'dueToday',     label: 'Due Today' },
    { key: 'dueThisWeek',  label: 'Due This Week' },
    { key: 'unassigned',   label: 'Unassigned' },
    { key: 'assigned',     label: 'Assigned' },
  ],
  completed: [
    { key: 'all',               label: 'All Completed' },
    { key: 'trackerCompleted',  label: 'Tracker Completed' },
    { key: 'manualCompleted',   label: 'Manual Completed' },
    { key: 'completedThisWeek', label: 'Completed This Week' },
  ],
  warnings: [
    { key: 'all',             label: 'All Warnings' },
    { key: 'dateParsing',     label: 'Date Parsing' },
    { key: 'missingAssignee', label: 'Missing Assignee' },
    { key: 'missingDeadline', label: 'Missing Deadline' },
    { key: 'spreadsheetSync', label: 'Spreadsheet Sync' },
    { key: 'mappingIssues',   label: 'Mapping Issues' },
  ],
};

// ── Warning builder ────────────────────────────────────────────────────────────
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
      type = 'dateParsing'; suggestedFix = 'Update the deadline cell to a valid date format (DD/MM/YYYY).';
    } else if (lower.includes('missing') && lower.includes('deadline')) {
      type = 'missingDeadline'; suggestedFix = 'Add a deadline date to the Deadline column.';
    } else if (lower.includes('missing') && (lower.includes('assignee') || lower.includes('assigned'))) {
      type = 'missingAssignee'; suggestedFix = 'Add an assignee name to the Assignee column.';
    } else if (lower.includes('column') || lower.includes('mapping') || lower.includes('header')) {
      type = 'mappingIssues'; severity = 'Error'; suggestedFix = 'Check that your spreadsheet has the expected header row.';
    } else if (lower.includes('lock') || lower.includes('sync') || lower.includes('write') || lower.includes('pending')) {
      type = 'spreadsheetSync'; suggestedFix = 'Close the spreadsheet in Excel and retry sync.';
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

// ── Search matcher ─────────────────────────────────────────────────────────────
function matchesSearch(item, q) {
  const assignee = itemAssignee(item);
  return (
    (item.title || item.description || '').toLowerCase().includes(q) ||
    (item.legalTrackerId || item.workflowTaskId || '').toLowerCase().includes(q) ||
    (item.counterpartyName || item.parties || '').toLowerCase().includes(q) ||
    (item.department || '').toLowerCase().includes(q) ||
    (item.taskType || '').toLowerCase().includes(q) ||
    (item.status || item.progress || '').toLowerCase().includes(q) ||
    (assignee?.name || item.assignee || '').toLowerCase().includes(q) ||
    (item.rowNumber != null ? String(item.rowNumber) : '').includes(q)
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────
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

function normalizeItem(raw, type) {
  return { ...raw, _type: type };
}

function isCompletedWorkflowTask(task) {
  return task.appStatus === 'completed' || task.status === 'Completed';
}

// Returns a structured completion outcome for tasks that are done.
// Never returns "Overdue" — uses a separate tone system: success / warning / muted.
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

  // Deadline known, but no completedAt — cannot determine lateness
  return { label: 'Completed', tone: 'success', detail: `deadline: ${deadlineStr}`, outcome: 'COMPLETED_DATE_UNKNOWN' };
}

// ── Default export ─────────────────────────────────────────────────────────────
export default function Workflows() {
  const navigate   = useNavigate();
  const { user, isManager } = useAuth();

  // ── Server data ──────────────────────────────────────────────────────────────
  const [data, setData]       = useState({ cards: {} });
  const [loading, setLoading] = useState(true);

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [primaryTab, setPrimaryTab]         = useState('all');
  const [secondaryFilter, setSecondaryFilter] = useState('all');
  const [search, setSearch]                 = useState('');
  const [activeCardFilter, setActiveCardFilter] = useState(null);
  const [rulesOpen, setRulesOpen]           = useState(false);

  // ── Tracker state ────────────────────────────────────────────────────────────
  const [trackerCfg, setTrackerCfg]         = useState(null);
  const [trackerItems, setTrackerItems]     = useState([]);
  const [manualItems, setManualItems]       = useState([]);
  const [templates, setTemplates]           = useState([]);
  const [syncing, setSyncing]               = useState(false);
  const [toast, setToast]                   = useState(null);

  // ── Modal state ──────────────────────────────────────────────────────────────
  const [showAssign, setShowAssign]         = useState(false);
  const [assignTarget, setAssignTarget]     = useState(null);
  const [showManual, setShowManual]         = useState(false);
  const [showTemplates, setShowTemplates]   = useState(false);

  // ── Row details drawer ────────────────────────────────────────────────────────
  const [drawerTask, setDrawerTask]         = useState(null);

  // ── Done confirmation modal ───────────────────────────────────────────────────
  const [doneTarget, setDoneTarget]         = useState(null);

  // ── Refresh view state ────────────────────────────────────────────────────────
  const load = useCallback(() => {
    setLoading(true);
    setData({ cards: {} });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Load tracker data from localStorage ──────────────────────────────────────
  useEffect(() => {
    const cfg = trackerConfig.get();
    if (cfg) setTrackerCfg(cfg);
    setTrackerItems(trackerTasksStore.get());
    setManualItems(manualTasksStore.get());
    setTemplates(workflowTemplates.get());
  }, []);

  // ── Listen for tracker file changes from Electron ─────────────────────────────
  useEffect(() => {
    if (!window.contractiq?.onTrackerFileChanged) return;
    const off = window.contractiq.onTrackerFileChanged((payload) => {
      if (payload.ok && payload.tasks) {
        setTrackerItems(payload.tasks);
        trackerTasksStore.set(payload.tasks);
        setTrackerCfg(prev => prev
          ? { ...prev, lastSyncedAt: payload.lastSyncedAt, rowsImported: payload.rowsImported, warnings: payload.warnings }
          : prev);
        trackerConfig.set({ ...(trackerConfig.get() || {}), lastSyncedAt: payload.lastSyncedAt });
        showToastMsg('Legal Tracker updated.');
      } else if (payload.code === 'DISCONNECTED') {
        setTrackerCfg(null);
        setTrackerItems([]);
      }
    });
    return off;
  }, []);

  // ── Toast helper ──────────────────────────────────────────────────────────────
  function showToastMsg(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // ── Tracker actions ───────────────────────────────────────────────────────────
  async function handleConnectTracker(mode) {
    if (!window.contractiq?.trackerChooseFile) return;
    const result = await window.contractiq.trackerChooseFile();
    if (!result?.ok) return;
    const cfg = {
      workbookName: result.workbookName,
      sheetName:    result.sheetName,
      lastSyncedAt: result.lastSyncedAt,
      rowsImported: result.rowsImported,
      warnings:     result.warnings || [],
      watchStatus:  result.watchStatus || 'watching',
    };
    setTrackerCfg(cfg);
    setTrackerItems(result.tasks || []);
    trackerConfig.set(cfg);
    trackerTasksStore.set(result.tasks || []);
    showToastMsg(`Legal Tracker connected. ${result.rowsImported} rows imported.`);
  }

  async function handleSyncTracker() {
    if (!window.contractiq?.trackerSync) return;
    setSyncing(true);
    const result = await window.contractiq.trackerSync();
    setSyncing(false);
    if (result?.ok) {
      const cfg = {
        ...trackerCfg,
        lastSyncedAt: result.lastSyncedAt,
        rowsImported: result.rowsImported,
        warnings:     result.warnings || [],
        watchStatus:  result.watchStatus,
      };
      setTrackerCfg(cfg);
      setTrackerItems(result.tasks || []);
      trackerConfig.set(cfg);
      trackerTasksStore.set(result.tasks || []);
      showToastMsg('Tracker synced.');
    } else {
      showToastMsg(result?.message || 'Sync failed.');
    }
  }

  async function handleDisconnectTracker() {
    if (!window.contractiq?.trackerDisconnect) return;
    await window.contractiq.trackerDisconnect();
    setTrackerCfg(null);
    setTrackerItems([]);
    trackerConfig.clear();
    trackerTasksStore.clear();
    showToastMsg('Legal Tracker disconnected.');
  }

  async function handleOpenTracker() {
    await window.contractiq?.trackerOpenFile?.();
  }

  // ── Tracker row completion ────────────────────────────────────────────────────
  function handleOpenDoneConfirm(task) {
    setDrawerTask(null); // close drawer if open
    setDoneTarget(task);
  }

  function handleDoneConfirmed(task) {
    const updated = trackerItems.map(t =>
      t.id === task.id ? { ...t, appStatus: 'completed', progress: 'Completed', pipelineStage: 'complete' } : t
    );
    setTrackerItems(updated);
    trackerTasksStore.set(updated);
    setDoneTarget(null);
    showToastMsg('Task marked as completed.');
  }

  // ── Tracker row assignment ────────────────────────────────────────────────────
  function handleOpenAssign(task) {
    setAssignTarget(task);
    setShowAssign(true);
  }

  function handleAssigned({ assignedUser, results }) {
    setShowAssign(false);
    if (assignedUser && assignTarget?._type === 'TRACKER') {
      const updated = trackerItems.map(t =>
        t.id === assignTarget.id ? { ...t, assignee: assignedUser.name, pipelineStage: 'assigned' } : t
      );
      setTrackerItems(updated);
      trackerTasksStore.set(updated);
    }
    if (assignedUser && assignTarget?._type === 'MANUAL') {
      manualTasksStore.update(assignTarget.id, { assignee: assignedUser.name, pipelineStage: 'assigned' });
      setManualItems(manualTasksStore.get());
    }
    showToastMsg(results?.taskCreated
      ? `Assigned to ${assignedUser.name}. Task created in Tasks section.`
      : `Assigned to ${assignedUser.name}.`);
  }

  // ── Drawer row saved ─────────────────────────────────────────────────────────
  function handleDrawerRowSaved(updatedTask) {
    if (updatedTask._type === 'TRACKER' || updatedTask.sourceType === 'LEGAL_TRACKER') {
      const updated = trackerItems.map(t => t.id === updatedTask.id ? { ...t, ...updatedTask } : t);
      setTrackerItems(updated);
      trackerTasksStore.set(updated);
      // Keep drawer open with updated task
      setDrawerTask(prev => prev?.id === updatedTask.id ? { ...prev, ...updatedTask } : prev);
    } else {
      manualTasksStore.update(updatedTask.id, updatedTask);
      setManualItems(manualTasksStore.get());
    }
    showToastMsg('Row updated in spreadsheet.');
  }

  // ── Manual tasks ──────────────────────────────────────────────────────────────
  function handleManualTaskSaved(task) {
    setShowManual(false);
    manualTasksStore.add(task);
    setManualItems(manualTasksStore.get());
    showToastMsg('Manual task added.');
  }

  function handleCompleteManualTask(task) {
    manualTasksStore.update(task.id, { status: 'Completed', pipelineStage: 'complete', completedAt: new Date().toISOString() });
    setManualItems(manualTasksStore.get());
    setDoneTarget(null);
    setDrawerTask(null);
    // Fire-and-forget: update the linked backend task so Tasks page reflects completion
    completeManualTask(task).catch(() => {});
    showToastMsg('Task completed.');
  }

  // ── Templates ─────────────────────────────────────────────────────────────────
  function handleTemplateAdd(tpl) {
    const updated = workflowTemplates.add(tpl);
    setTemplates([...updated]);
  }

  function handleTemplateRemove(id) {
    const updated = workflowTemplates.remove(id);
    setTemplates([...updated]);
  }

  function handleTemplateUpdate(id, patch) {
    const updated = workflowTemplates.update(id, patch);
    setTemplates([...updated]);
  }

  // ── All active items (tracker + manual workflow tasks) ───────────────────────
  const allItems = useMemo(() => {
    const tkItems = trackerItems.filter(t => t.appStatus !== 'completed').map(t => normalizeItem(t, 'TRACKER'));
    const mnItems = manualItems.filter(m => m.status !== 'Completed').map(m => normalizeItem(m, 'MANUAL'));
    return [...tkItems, ...mnItems];
  }, [trackerItems, manualItems]);

  // ── Card-filtered items (used by pipeline + card-filter override in list) ─────
  const cardFilteredItems = useMemo(() => {
    if (!activeCardFilter || activeCardFilter === 'active') return allItems;
    const now = new Date();
    const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
    const eod = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    switch (activeCardFilter) {
      case 'overdue':     return allItems.filter(r => { const d = itemDueDate(r); return d && new Date(d) < now; });
      case 'dueToday':    return allItems.filter(r => { const d = itemDueDate(r); if (!d) return false; const dd = new Date(d); return dd >= now && dd <= eod; });
      case 'dueThisWeek': return allItems.filter(r => { const d = itemDueDate(r); if (!d) return false; const dd = new Date(d); return dd >= now && dd <= weekEnd; });
      case 'withManager': return allItems.filter(r => r.status === 'WITH_MANAGER' || r.pipelineStage === 'manager');
      case 'withBusiness':return allItems.filter(r => r.status === 'WITH_BUSINESS_DEPARTMENT' || r.pipelineStage === 'business');
      case 'readyForSig': return allItems.filter(r => r.status === 'READY_FOR_SIGNATURE' || r.pipelineStage === 'signature');
      case 'awaitingSig': return allItems.filter(r => ['SENT_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(r.status));
      case 'noUpdate3':   return allItems.filter(r => { const u = itemLastUpdate(r); return u && new Date(u) < new Date(Date.now() - 3 * 86400000); });
      case 'unassigned':  return allItems.filter(r => !itemAssignee(r));
      default: return allItems;
    }
  }, [allItems, activeCardFilter]);

  // ── Primary tab counts ────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const activeTk = trackerItems.filter(t => t.appStatus !== 'completed').length;
    const activeMn = manualItems.filter(m => m.status !== 'Completed').length;
    return {
      all:       activeTk + activeMn,
      tracker:   activeTk,
      manual:    activeMn,
      completed: trackerItems.filter(t => t.appStatus === 'completed').length
                 + manualItems.filter(m => m.status === 'Completed').length,
      warnings:  (trackerCfg?.warnings || []).length,
    };
  }, [trackerItems, manualItems, trackerCfg]);

  // ── Workflow list items (Active Legal Workflows section) ──────────────────────
  const workflowListItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    if (activeCardFilter) {
      let items = cardFilteredItems;
      if (q) items = items.filter(item => matchesSearch(item, q));
      return items;
    }

    if (primaryTab === 'warnings') {
      return buildWarnings(trackerCfg, secondaryFilter, q);
    }

    const now = new Date();
    const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
    const eod = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    let items = [];

    const applyActiveFilters = (list) => {
      switch (secondaryFilter) {
        case 'overdue':      return list.filter(t => { const d = itemDueDate(t); return d && new Date(d) < now; });
        case 'dueToday':     return list.filter(t => { const d = itemDueDate(t); if (!d) return false; const dd = new Date(d); return dd >= now && dd <= eod; });
        case 'dueThisWeek':  return list.filter(t => { const d = itemDueDate(t); if (!d) return false; const dd = new Date(d); return dd >= now && dd <= weekEnd; });
        case 'unassigned':   return list.filter(t => !itemAssignee(t));
        case 'withManager':  return list.filter(t => t.pipelineStage === 'manager'  || t.status === 'WITH_MANAGER');
        case 'withBusiness': return list.filter(t => t.pipelineStage === 'business' || t.status === 'WITH_BUSINESS_DEPARTMENT');
        case 'signature':    return list.filter(t => t.pipelineStage === 'signature' || ['READY_FOR_SIGNATURE','SENT_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(t.status));
        case 'noUpdate':     return list.filter(t => { const u = itemLastUpdate(t); return u && new Date(u) < new Date(Date.now() - 3 * 86400000); });
        default:             return list;
      }
    };

    if (primaryTab === 'all') {
      const tkItems = trackerItems.filter(t => t.appStatus !== 'completed').map(t => normalizeItem(t, 'TRACKER'));
      const mnItems = manualItems.filter(m => m.status !== 'Completed').map(m => normalizeItem(m, 'MANUAL'));
      items = applyActiveFilters([...tkItems, ...mnItems]);
    } else if (primaryTab === 'tracker') {
      items = applyActiveFilters(
        trackerItems.filter(t => t.appStatus !== 'completed').map(t => normalizeItem(t, 'TRACKER'))
      );
    } else if (primaryTab === 'manual') {
      const base = manualItems.filter(m => m.status !== 'Completed').map(m => normalizeItem(m, 'MANUAL'));
      if (secondaryFilter === 'assigned')   items = base.filter(m => !!m.assignee);
      else                                  items = applyActiveFilters(base);
    } else if (primaryTab === 'completed') {
      const compTk = trackerItems.filter(t => t.appStatus === 'completed').map(t => normalizeItem(t, 'TRACKER'));
      const compMn = manualItems.filter(m => m.status === 'Completed').map(m => normalizeItem(m, 'MANUAL'));
      if (secondaryFilter === 'trackerCompleted')  items = compTk;
      else if (secondaryFilter === 'manualCompleted') items = compMn;
      else if (secondaryFilter === 'completedThisWeek') {
        const weekStart = new Date(now - 7 * 86400000);
        items = [...compTk, ...compMn].filter(t => {
          const d = t.completedAt || t.updatedAt || t.lastSyncedAt;
          return d && new Date(d) >= weekStart;
        });
      } else {
        items = [...compTk, ...compMn];
      }
    }

    if (q) items = items.filter(item => matchesSearch(item, q));
    return items;
  }, [primaryTab, secondaryFilter, trackerItems, manualItems, trackerCfg, activeCardFilter, cardFilteredItems, search]);

  // ── Empty-state message per tab ───────────────────────────────────────────────
  const emptyStateMsg = (() => {
    if (activeCardFilter) return 'No workflows match the current filter.';
    const filtered = secondaryFilter !== 'all' || search.trim();
    switch (primaryTab) {
      case 'all':       return filtered ? 'No records match the current filter.' : 'No active tasks found.';
      case 'tracker':   return filtered ? 'No records match the current filter.' : 'No active tracker tasks found.';
      case 'manual':    return filtered ? 'No records match the current filter.' : 'No manual workflow tasks found.';
      case 'completed': return filtered ? 'No records match the current filter.' : 'No completed tasks found.';
      case 'warnings':  return filtered ? 'No records match the current filter.' : 'No tracker warnings found.';
      default:          return 'No records match the current filter.';
    }
  })();

  // ── Merged KPI cards ─────────────────────────────────────────────────────────
  const mergedCards = useMemo(() => {
    const base = data?.cards || {};
    const now  = new Date();
    const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
    const eod  = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const activeTk  = trackerItems.filter(t => t.appStatus !== 'completed');
    const activeMn  = manualItems.filter(m => m.status !== 'Completed');

    const count = (items, fn) => items.filter(fn).length;

    return {
      active:           (base.active || 0) + activeTk.length + activeMn.length,
      overdue:          (base.overdue || 0)
                          + count(activeTk, t => t.deadline && new Date(t.deadline) < now)
                          + count(activeMn, m => m.dueDate  && new Date(m.dueDate)  < now),
      dueToday:         (base.dueToday || 0)
                          + count(activeTk, t => { const d = t.deadline  && new Date(t.deadline);  return d && d >= now && d <= eod; })
                          + count(activeMn, m => { const d = m.dueDate   && new Date(m.dueDate);   return d && d >= now && d <= eod; }),
      dueThisWeek:      (base.dueThisWeek || 0)
                          + count(activeTk, t => { const d = t.deadline  && new Date(t.deadline);  return d && d >= now && d <= weekEnd; })
                          + count(activeMn, m => { const d = m.dueDate   && new Date(m.dueDate);   return d && d >= now && d <= weekEnd; }),
      unassigned:       (base.unassigned || 0)
                          + count(activeTk, t => !t.assignee)
                          + count(activeMn, m => !m.assignee),
      withManager:      (base.withManager || 0)  + count(activeTk, t => t.pipelineStage === 'manager'),
      withBusiness:     (base.withBusiness || 0) + count(activeTk, t => t.pipelineStage === 'business'),
      readyForSignature:(base.readyForSignature || 0) + count(activeTk, t => t.pipelineStage === 'signature'),
      awaitingSignature:(base.awaitingSignature || 0),
      noUpdate3:        (base.noUpdate3 || 0)
                          + count(activeTk, t => new Date(t.lastSyncedAt) < new Date(Date.now() - 3 * 86400000))
                          + count(activeMn, m => new Date(m.updatedAt)    < new Date(Date.now() - 3 * 86400000)),
    };
  }, [data, trackerItems, manualItems]);

  // ── Pipeline data ─────────────────────────────────────────────────────────────
  const pipelineData = useMemo(() => {
    return PIPELINE_COLS.map(col => ({
      ...col,
      items: cardFilteredItems.filter(item => {
        return item.pipelineStage === col.key;
      }),
    }));
  }, [cardFilteredItems]);

  // ── Card click handler ────────────────────────────────────────────────────────
  const handleCardClick = (key) => {
    setActiveCardFilter(prev => prev === key ? null : key);
  };

  // ── Loading state ─────────────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="workflows">
        <Header title="Workflows" subtitle="Track legal workloads, tracker tasks, approvals, deadlines, and signing pipeline." />
        <div className="workflows__loading">Loading workflow data…</div>
      </div>
    );
  }

  return (
    <div className="workflows">
      <Header
        title="Workflows"
        subtitle="Track legal workloads, tracker tasks, approvals, deadlines, and signing pipeline."
        actions={
          <>
            <button className="wf__refresh-btn" onClick={load} disabled={loading} title="Refresh workflow data">
              {loading ? '…' : '↻'}
            </button>
            <button className="wf__action-btn" onClick={() => navigate('/tasks')}>
              Open Tasks
            </button>
          </>
        }
      />

      <div className="workflows__content">

        {/* ── Tracker action bar ──────────────────────────────────────────── */}
        <div className="wf__tracker-bar">
          <button className="wf__tbar-btn wf__tbar-btn--primary" onClick={() => handleConnectTracker('choose')}>
            {trackerCfg ? '↻ Reconnect Tracker' : '+ Connect Legal Tracker'}
          </button>
          {trackerCfg && (
            <button className="wf__tbar-btn" onClick={handleSyncTracker} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Tracker'}
            </button>
          )}
          {isManager && (
            <button className="wf__tbar-btn" onClick={() => setShowManual(true)}>
              + Add Manual Task
            </button>
          )}
          <button className="wf__tbar-btn" onClick={() => setShowTemplates(true)}>
            Manage Templates
          </button>
        </div>

        {/* ── Summary KPI cards ───────────────────────────────────────────── */}
        <div className="wf__cards">
          <WfCard label="Active Workflows"  value={mergedCards.active}           color="blue"   active={activeCardFilter === 'active'}       onClick={() => handleCardClick('active')} />
          <WfCard label="Overdue"           value={mergedCards.overdue}          color="red"    active={activeCardFilter === 'overdue'}      onClick={() => handleCardClick('overdue')}    urgent={mergedCards.overdue > 0} />
          <WfCard label="Due Today"         value={mergedCards.dueToday}         color="orange" active={activeCardFilter === 'dueToday'}    onClick={() => handleCardClick('dueToday')}   urgent={mergedCards.dueToday > 0} />
          <WfCard label="Due This Week"     value={mergedCards.dueThisWeek}      color="indigo" active={activeCardFilter === 'dueThisWeek'} onClick={() => handleCardClick('dueThisWeek')} />
          <WfCard label="Unassigned"        value={mergedCards.unassigned}       color="violet" active={activeCardFilter === 'unassigned'}  onClick={() => handleCardClick('unassigned')}  urgent={mergedCards.unassigned > 0} />
          <WfCard label="With Manager"      value={mergedCards.withManager}      color="purple" active={activeCardFilter === 'withManager'} onClick={() => handleCardClick('withManager')} />
          <WfCard label="With Business"     value={mergedCards.withBusiness}     color="amber"  active={activeCardFilter === 'withBusiness'}onClick={() => handleCardClick('withBusiness')} />
          <WfCard label="Ready for Sign."   value={mergedCards.readyForSignature}color="green"  active={activeCardFilter === 'readyForSig'} onClick={() => handleCardClick('readyForSig')} />
          <WfCard label="Awaiting Sign."    value={mergedCards.awaitingSignature}color="teal"   active={activeCardFilter === 'awaitingSig'} onClick={() => handleCardClick('awaitingSig')} />
          <WfCard label="No Update 3d"      value={mergedCards.noUpdate3}        color="gray"   active={activeCardFilter === 'noUpdate3'}   onClick={() => handleCardClick('noUpdate3')} />
        </div>

        {/* ── Legal Tracker connection card ───────────────────────────────── */}
        <LegalTrackerCard
          config={trackerCfg}
          tasks={trackerItems}
          syncing={syncing}
          onConnect={handleConnectTracker}
          onSync={handleSyncTracker}
          onDisconnect={handleDisconnectTracker}
          onOpenTracker={handleOpenTracker}
        />

        {/* ── Active Legal Workflows ──────────────────────────────────────── */}
        <div className="wf__section">
          <div className="wf__section-header">
            <div>
              <h2 className="wf__section-title">Active Legal Workflows</h2>
              {activeCardFilter && (
                <button className="wf__clear-filter" onClick={() => setActiveCardFilter(null)}>
                  Clear filter ✕
                </button>
              )}
            </div>
            <input
              className="wf__search"
              placeholder="Search title, reference, owner, parties, status…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Primary tab row — hidden when a KPI card filter is active */}
          {!activeCardFilter && (
            <>
              <div className="wf__primary-tabs">
                {PRIMARY_TABS.map(pt => (
                  <button
                    key={pt.key}
                    className={`wf__primary-tab${primaryTab === pt.key ? ' wf__primary-tab--active' : ''}`}
                    onClick={() => { setPrimaryTab(pt.key); setSecondaryFilter('all'); }}
                  >
                    {pt.label}
                    <span className="wf__primary-tab-count">{tabCounts[pt.key] ?? 0}</span>
                  </button>
                ))}
              </div>

              {/* Secondary filter chips */}
              <div className="wf__secondary-filters">
                {(SECONDARY_FILTERS[primaryTab] || []).map(sf => (
                  <button
                    key={sf.key}
                    className={`wf__secondary-chip${secondaryFilter === sf.key ? ' wf__secondary-chip--active' : ''}`}
                    onClick={() => setSecondaryFilter(sf.key)}
                  >
                    {sf.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Content */}
          {workflowListItems.length === 0 ? (
            <div className="wf__empty">{emptyStateMsg}</div>
          ) : primaryTab === 'warnings' && !activeCardFilter ? (
            <div className="wf__warn-list">
              {workflowListItems.map(w => (
                <WarningRow key={w.id} warning={w} onRetrySync={handleSyncTracker} />
              ))}
            </div>
          ) : (
            <div className="wf__workflow-list">
              <div className="wf__workflow-header-row">
                <span>Workflow Task</span>
                <span>Stage / Status</span>
                <span>Owner</span>
                <span>{primaryTab === 'completed' ? 'Completion' : 'Due'}</span>
                <span>Actions</span>
              </div>
              {workflowListItems.map(item => {
                const isCompleted = item.appStatus === 'completed' || item.status === 'Completed';
                if (item._type === 'TRACKER') {
                  return (
                    <TrackerTaskRow
                      key={item.id}
                      task={item}
                      isManager={isManager}
                      isCompleted={isCompleted}
                      onRowClick={() => setDrawerTask(item)}
                      onAssign={() => handleOpenAssign(item)}
                      onComplete={() => handleOpenDoneConfirm(item)}
                    />
                  );
                }
                return (
                  <ManualTaskRow
                    key={item.id}
                    task={item}
                    isManager={isManager}
                    isCompleted={isCompleted}
                    onRowClick={() => setDrawerTask(item)}
                    onAssign={() => handleOpenAssign(item)}
                    onComplete={() => handleOpenDoneConfirm(item)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* ── Workflow Pipeline ───────────────────────────────────────────── */}
        <div className="wf__section">
          <h2 className="wf__section-title">Workflow Pipeline</h2>
          <p className="wf__section-sub">Tracker and manual tasks grouped by workflow stage. Wide columns indicate bottlenecks.</p>
          <div className="wf__pipeline">
            {pipelineData.map(col => (
              <PipelineColumn key={col.key} col={col} />
            ))}
          </div>
        </div>

        {/* ── Workflow Templates ──────────────────────────────────────────── */}
        <div className="wf__section">
          <button className="wf__rules-toggle" onClick={() => setRulesOpen(o => !o)}>
            <span className="wf__section-title">Workflow Templates</span>
            <span className="wf__rules-arrow">{rulesOpen ? '▲' : '▼'}</span>
          </button>
          {rulesOpen && (
            <>
              {isManager && (
                <div className="wf__rules-manage-row">
                  <button className="wf__tbar-btn" onClick={() => setShowTemplates(true)}>
                    Manage Templates
                  </button>
                  <span className="wf__rules-count">{templates.length} / 5 templates</span>
                </div>
              )}
              <div className="wf__rules-grid">
                {templates.map(tpl => (
                  <WorkflowRuleCard key={tpl.id} rule={tpl} />
                ))}
              </div>
            </>
          )}
        </div>

      </div>

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      {toast && (
        <div className="wf__toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {showAssign && (
        <AssignModal
          task={assignTarget}
          onClose={() => setShowAssign(false)}
          onAssigned={handleAssigned}
        />
      )}

      {showManual && (
        <ManualTaskModal
          currentUser={user}
          onClose={() => setShowManual(false)}
          onSaved={handleManualTaskSaved}
        />
      )}

      {showTemplates && (
        <TemplateModal
          templates={templates}
          onClose={() => setShowTemplates(false)}
          onAdd={handleTemplateAdd}
          onRemove={handleTemplateRemove}
          onUpdate={handleTemplateUpdate}
        />
      )}

      {/* ── Row details drawer ──────────────────────────────────────────────── */}
      {drawerTask && (
        <TrackerRowDrawer
          task={drawerTask}
          isManager={isManager}
          syncing={syncing}
          onClose={() => setDrawerTask(null)}
          onSaved={handleDrawerRowSaved}
          onAssign={() => {
            const t = drawerTask;
            setDrawerTask(null);
            setAssignTarget({ ...t, _type: t._type || 'TRACKER' });
            setShowAssign(true);
          }}
          onComplete={() => handleOpenDoneConfirm(drawerTask)}
          onOpenTracker={handleOpenTracker}
        />
      )}

      {/* ── Done confirmation modal ─────────────────────────────────────────── */}
      {doneTarget && (
        <DoneConfirmModal
          task={doneTarget}
          onClose={() => setDoneTarget(null)}
          onConfirmed={() => {
            if (doneTarget._type === 'TRACKER' || doneTarget.sourceType === 'LEGAL_TRACKER') {
              handleDoneConfirmed(doneTarget);
            } else {
              handleCompleteManualTask(doneTarget);
            }
          }}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function WfCard({ label, value, color, active, onClick, urgent }) {
  return (
    <button
      className={`wf__card wf__card--${color}${active ? ' wf__card--active' : ''}${urgent ? ' wf__card--urgent' : ''}`}
      onClick={onClick}
    >
      <span className="wf__card-value">{value ?? '—'}</span>
      <span className="wf__card-label">{label}</span>
    </button>
  );
}

function TrackerTaskRow({ task: t, isManager, isCompleted, onRowClick, onAssign, onComplete }) {
  const outcome  = isCompleted ? getCompletionOutcome(t) : null;
  const dueState = isCompleted ? null : (t.dueState || calcDueState(t.deadline));
  const assigneeInitials = t.assignee?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || null;

  let rowClass = 'wf__workflow-row wf__tracker-row wf__workflow-row--clickable';
  if (isCompleted) {
    rowClass += outcome?.tone === 'warning' ? ' wf__workflow-row--completed-late' : ' wf__workflow-row--completed';
  } else if (dueState === 'overdue') {
    rowClass += ' wf__workflow-row--overdue';
  }

  return (
    <div className={rowClass} onClick={onRowClick} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onRowClick?.()}>
      <div className="wf__row-request">
        <div className="wf__row-badges">
          <span className="wf__source-badge wf__source-badge--tracker">Tracker</span>
          {t.taskType && <span className="wf__row-type-badge">{t.taskType}</span>}
        </div>
        <span className="wf__row-ref">{t.legalTrackerId}</span>
        <span className="wf__row-title">{t.description || t.taskType || 'Tracker Task'}</span>
        {t.parties && <span className="wf__row-type">{t.parties}</span>}
      </div>
      <div className="wf__row-stage">
        <span className="wf__status-pill" style={{ background: '#f0fdfa', color: '#0f766e' }}>
          {t.progress || t.status || 'Active'}
        </span>
        {t.department && <span className="wf__holder-pill" style={{ color: '#64748b' }}>{t.department}</span>}
      </div>
      <div className="wf__row-owner">
        {t.assignee ? (
          <>
            {assigneeInitials && <span className="wf__owner-avatar">{assigneeInitials}</span>}
            <span className="wf__owner-name">{t.assignee}</span>
          </>
        ) : <span className="wf__unassigned">Unassigned</span>}
      </div>
      <div className="wf__row-due">
        {isCompleted ? (
          <div className="wf__completion-cell">
            <span className={`wf__days wf__days--completion-${outcome.tone}`}>{outcome.label}</span>
            {outcome.detail && <span className="wf__completion-detail">{outcome.detail}</span>}
          </div>
        ) : t.deadline ? (
          <span className={`wf__days wf__days--${dueState}`}>
            {dueState === 'overdue' ? 'Overdue'
              : dueState === 'today' ? 'Due today'
              : dueState === 'soon'  ? 'Due soon'
              : new Date(t.deadline).toLocaleDateString('en-ZA')}
          </span>
        ) : t.rawDeadlineText ? (
          <span className="wf__days">{t.rawDeadlineText}</span>
        ) : '—'}
      </div>
      <div className="wf__row-action">
        {!isCompleted && isManager && (
          <button className="wf__row-btn wf__row-btn--assign" onClick={e => { e.stopPropagation(); onAssign(); }}>
            Assign
          </button>
        )}
        {!isCompleted && (
          <button className="wf__row-btn wf__row-btn--done" onClick={e => { e.stopPropagation(); onComplete(); }}>
            Done
          </button>
        )}
        {isCompleted && <span className="wf__completed-badge">Completed</span>}
      </div>
    </div>
  );
}

function ManualTaskRow({ task: t, isManager, isCompleted, onRowClick, onAssign, onComplete }) {
  const outcome  = isCompleted ? getCompletionOutcome(t) : null;
  const dueState = isCompleted ? null : calcDueState(t.dueDate);
  const assigneeInitials = t.assignee?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || null;

  let rowClass = 'wf__workflow-row wf__manual-row wf__workflow-row--clickable';
  if (isCompleted) {
    rowClass += outcome?.tone === 'warning' ? ' wf__workflow-row--completed-late' : ' wf__workflow-row--completed';
  } else if (dueState === 'overdue') {
    rowClass += ' wf__workflow-row--overdue';
  }

  return (
    <div className={rowClass} onClick={onRowClick} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onRowClick?.()}>
      <div className="wf__row-request">
        <div className="wf__row-badges">
          <span className="wf__source-badge wf__source-badge--manual">Manual</span>
          {t.taskType && <span className="wf__row-type-badge">{t.taskType}</span>}
        </div>
        <span className="wf__row-title">{t.title}</span>
        {t.description && <span className="wf__row-type">{t.description}</span>}
      </div>
      <div className="wf__row-stage">
        <span className="wf__status-pill" style={{ background: '#f5f3ff', color: '#7c3aed' }}>
          {t.status || 'Pending'}
        </span>
        {t.department && <span className="wf__holder-pill" style={{ color: '#64748b' }}>{t.department}</span>}
      </div>
      <div className="wf__row-owner">
        {t.assignee ? (
          <>
            {assigneeInitials && <span className="wf__owner-avatar">{assigneeInitials}</span>}
            <span className="wf__owner-name">{t.assignee}</span>
          </>
        ) : <span className="wf__unassigned">Unassigned</span>}
      </div>
      <div className="wf__row-due">
        {isCompleted ? (
          <div className="wf__completion-cell">
            <span className={`wf__days wf__days--completion-${outcome.tone}`}>{outcome.label}</span>
            {outcome.detail && <span className="wf__completion-detail">{outcome.detail}</span>}
          </div>
        ) : t.dueDate ? (
          <span className={`wf__days wf__days--${dueState}`}>
            {dueState === 'overdue' ? 'Overdue' : new Date(t.dueDate).toLocaleDateString('en-ZA')}
          </span>
        ) : '—'}
      </div>
      <div className="wf__row-action">
        {!isCompleted && isManager && (
          <button className="wf__row-btn wf__row-btn--assign" onClick={e => { e.stopPropagation(); onAssign(); }}>
            Assign
          </button>
        )}
        {!isCompleted && (
          <button className="wf__row-btn wf__row-btn--done" onClick={e => { e.stopPropagation(); onComplete(); }}>
            Done
          </button>
        )}
        {isCompleted && <span className="wf__completed-badge">Completed</span>}
      </div>
    </div>
  );
}

function WarningRow({ warning, onRetrySync }) {
  const clrMap = {
    Error:   { bg: '#fef2f2', color: '#dc2626', border: '#fca5a5' },
    Warning: { bg: '#fffbeb', color: '#92400e', border: '#fde68a' },
    Info:    { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  };
  const clr = clrMap[warning.severity] || clrMap.Warning;
  return (
    <div className="wf__warn-row" style={{ borderLeftColor: clr.border }}>
      <div className="wf__warn-header">
        <span className="wf__warn-badge" style={{ background: clr.bg, color: clr.color }}>{warning.severity}</span>
        <span className="wf__warn-source">Legal Tracker</span>
        {warning.rowNumber != null && <span className="wf__warn-row-num">Row {warning.rowNumber}</span>}
      </div>
      <p className="wf__warn-msg">{warning.message}</p>
      {warning.suggestedFix && <p className="wf__warn-fix">Fix: {warning.suggestedFix}</p>}
      {warning.type === 'spreadsheetSync' && (
        <div className="wf__warn-actions">
          <button className="wf__row-btn wf__row-btn--assign" onClick={onRetrySync}>Retry Sync</button>
        </div>
      )}
    </div>
  );
}

function PipelineColumn({ col }) {
  const hasItems = col.items.length > 0;
  return (
    <div className={`wf__pipe-col${hasItems ? ' wf__pipe-col--has-items' : ''}`}>
      <div className="wf__pipe-col-header" style={{ borderTopColor: col.color }}>
        <span className="wf__pipe-col-label">{col.label}</span>
        <span className="wf__pipe-col-count" style={{ background: hasItems ? col.color : '#e2e8f0', color: hasItems ? '#fff' : '#94a3b8' }}>
          {col.items.length}
        </span>
      </div>
      <div className="wf__pipe-items">
        {col.items.slice(0, 4).map(item => {
          const title  = item.description || item.title || 'Tracker Task';
          const ref    = item.legalTrackerId || item.workflowTaskId || item.id;
          const due    = item.deadline || item.dueDate;
          const days   = getDaysLabel(due);
          const assignee = item.assignee ? { name: item.assignee } : null;
          return (
            <div
              key={item._id || item.id}
              className="wf__pipe-item"
              style={{ cursor: 'default' }}
            >
              <div className="wf__pipe-item-badges">
                <span className={`wf__pipe-source wf__pipe-source--${item._type?.toLowerCase()}`}>
                  {item._type === 'TRACKER' ? 'T' : 'M'}
                </span>
                <span className="wf__pipe-ref">{ref}</span>
              </div>
              <span className="wf__pipe-title">{title}</span>
              <div className="wf__pipe-footer">
                {assignee && (
                  <span className="wf__pipe-avatar">
                    {assignee.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                  </span>
                )}
                {days && <span className={`wf__pipe-days wf__pipe-days--${days.cls}`}>{days.label}</span>}
              </div>
            </div>
          );
        })}
        {col.items.length > 4 && (
          <button
            className="wf__pipe-more"
            type="button"
          >
            +{col.items.length - 4} more →
          </button>
        )}
        {col.items.length === 0 && <div className="wf__pipe-empty">—</div>}
      </div>
    </div>
  );
}

function WorkflowRuleCard({ rule }) {
  const steps = rule.steps || rule.checklistItems || [];
  return (
    <div className="wf__rule-card" style={{ borderTopColor: rule.color }}>
      <div className="wf__rule-header">
        <span className="wf__rule-icon">{rule.icon}</span>
        <div>
          <h4 className="wf__rule-name">{rule.name}</h4>
          <span className="wf__rule-sla">SLA: {rule.sla || rule.defaultDueOffsetDays + 'd'}</span>
        </div>
      </div>
      <p className="wf__rule-desc">{rule.description}</p>
      <ol className="wf__rule-steps">
        {steps.map((s, i) => <li key={i} className="wf__rule-step">{s}</li>)}
      </ol>
    </div>
  );
}
