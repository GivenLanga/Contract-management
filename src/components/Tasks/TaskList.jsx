import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { tasks as tasksApi, auth as authApi, signing as signingApi } from '../../services/api';
import { retryExcelSync, completeManualTask } from '../../services/trackerTaskBridge';
import { trackerTasks as trackerTasksStore, manualTasks as manualTasksStore } from '../../services/legalTrackerStore';
import {
  loadAllWorkflowItems,
  isActiveWorkflowItem,
  isCompletedWorkflowItem,
  getSignatureFollowUpsForTasksPage,
  calcDueState,
} from '../../services/workflowTasksSelector';
import {
  getDocumentSigningStatus,
  getPendingReminderSigners,
  getSignerProgress,
  selectSentWaitingSigningDocuments,
} from '../../services/signingDocumentSelectors';
import { useAuth } from '../../context/AuthContext';
import { getDaysLabel } from '../../services/dateDisplay';
import TaskForm from './TaskForm';
import AssignModal    from '../Workflows/AssignModal';
import ManualTaskModal from '../Workflows/ManualTaskModal';
import DoneConfirmModal from '../Workflows/DoneConfirmModal';
import Header from '../Layout/Header';
import Modal from '../common/Modal';
import './TaskList.css';

const TASK_TYPE_LABELS = {
  ASSIGN_REQUEST:       'Assign Work',
  INTAKE_REVIEW:        'Intake Review',
  LEGAL_REVIEW:         'Legal Review',
  DRAFT_DOCUMENT:       'Draft Document',
  MANAGER_APPROVAL:     'Manager Approval',
  REQUEST_REVISIONS:    'Request Changes',
  BUSINESS_INPUT:       'Business Input',
  UPLOAD_DOCUMENT:      'Upload Document',
  PREPARE_FOR_SIGNATURE:'Prepare for Signature',
  SEND_SIGNATURE_EMAIL: 'Send Signature Email',
  FOLLOW_UP_SIGNATURE:  'Follow-up Signature',
  STORE_SIGNED_DOCUMENT:'Store Signed Document',
  CLOSE_REQUEST:        'Close Work Item',
  RESOLVE_COMMENT:      'Resolve Comment',
  GENERAL_TASK:         'General Task',
};

const TASK_STATUS_COLORS = {
  Pending:      { bg: '#f8fafc', color: '#475569' },
  'In Progress':{ bg: '#eff6ff', color: '#1d4ed8' },
  Blocked:      { bg: '#fff1f2', color: '#be123c' },
  Completed:    { bg: '#f0fdf4', color: '#15803d' },
  Overdue:      { bg: '#fef2f2', color: '#dc2626' },
  Cancelled:    { bg: '#f8fafc', color: '#94a3b8' },
};

const TASK_PRIORITY_COLORS = {
  Low:    { bg: '#f8fafc', color: '#64748b' },
  Medium: { bg: '#eff6ff', color: '#2563eb' },
  High:   { bg: '#fff7ed', color: '#c2410c' },
  Urgent: { bg: '#fff1f2', color: '#be123c' },
};

// Completed tab date-range options
const COMPLETED_FILTERS = [
  { value: 'week',    label: 'Past week'     },
  { value: 'month',   label: 'Past month'    },
  { value: '3months', label: 'Past 3 months' },
  { value: '6months', label: 'Past 6 months' },
  { value: 'year',    label: 'Past year'     },
  { value: 'all',     label: 'All time'      },
];

const TABS = [
  { key: 'mine',       label: 'My Tasks',            managerOnly: false },
  { key: 'team',       label: 'Team Tasks',           managerOnly: true  },
  { key: 'workflow',   label: 'Workflow Tasks',       managerOnly: false },
  { key: 'unassigned', label: 'Unassigned',           managerOnly: true  },
  { key: 'overdue',    label: 'Overdue',              managerOnly: false },
  { key: 'approvals',  label: 'Approvals',            managerOnly: false },
  { key: 'signatures', label: 'Signature Follow-Ups', managerOnly: false },
  { key: 'completed',  label: 'Completed',            managerOnly: false },
];

const TASK_TAB_QUERY = {
  mine: 'mine',
  team: 'team',
  workflow: 'workflow',
  unassigned: 'unassigned',
  overdue: 'overdue',
  approvals: 'approvals',
  'signature-follow-ups': 'signatures',
  signatures: 'signatures',
  completed: 'completed',
};

const tabFromQuery = (value) => TASK_TAB_QUERY[String(value || '').toLowerCase()] || null;

const SIGNATURE_FOLLOW_UP_RETURN_STATE = {
  returnTo: '/tasks?tab=signature-follow-ups',
  returnTab: 'signature-follow-ups',
  returnLabel: 'Signature Follow-Ups',
};

export default function TaskList() {
  const { user, isManager } = useAuth();
  const navigate            = useNavigate();
  const [searchParams]      = useSearchParams();

  // ── Local workflow items (localStorage: tracker + manual) ────────────────────
  const [localItems, setLocalItems] = useState([]);

  // ── Approval tasks from backend (MANAGER_APPROVAL type MongoDB records) ──────
  const [approvalTasks, setApprovalTasks] = useState([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);

  // ── Signature follow-ups (merged server + local) ─────────────────────────────
  const [signingDocs, setSigningDocs] = useState([]);

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab]           = useState(() => tabFromQuery(searchParams.get('tab')) || 'mine');
  const [search, setSearch]                 = useState('');
  const [completedFilter, setCompletedFilter] = useState('month');
  const [users, setUsers]                   = useState([]);

  // ── Modal state ──────────────────────────────────────────────────────────────
  const [showForm, setShowForm]             = useState(false);
  const [editTask, setEditTask]             = useState(null);
  const [showAssign, setShowAssign]         = useState(false);
  const [assignTarget, setAssignTarget]     = useState(null);
  const [showNewTask, setShowNewTask]       = useState(false);
  const [doneTarget, setDoneTarget]         = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [syncFeedback, setSyncFeedback]     = useState({});
  const [reminderTarget, setReminderTarget] = useState(null);
  const [reminderSending, setReminderSending] = useState(false);
  const [signatureFeedback, setSignatureFeedback] = useState({});

  // ── Load localStorage items (synchronous) ────────────────────────────────────
  function reloadLocalItems() {
    setLocalItems(loadAllWorkflowItems());
  }

  // ── Load approval tasks from backend ─────────────────────────────────────────
  const loadApprovals = useCallback(async () => {
    setApprovalsLoading(true);
    try {
      const data = await tasksApi.list({ taskType: 'MANAGER_APPROVAL' });
      setApprovalTasks(data.tasks || []);
    } catch { /* silent */ }
    finally { setApprovalsLoading(false); }
  }, []);

  // ── Load signature follow-ups (merged server + local) ────────────────────────
  const loadSignatureFollowUps = useCallback(async () => {
    try {
      const docs = await getSignatureFollowUpsForTasksPage({ user, isManager });
      setSigningDocs(docs);
    } catch {
      // Fallback: local only
      try {
        const { getSigningDocuments } = await import('../../services/signingStore');
        const local = getSigningDocuments();
        setSigningDocs(selectSentWaitingSigningDocuments(local, { user, isManager }));
      } catch { setSigningDocs([]); }
    }
  }, [isManager, user]);

  // ── Initial mount: load everything ───────────────────────────────────────────
  useEffect(() => {
    reloadLocalItems();
    loadSignatureFollowUps();
    if (isManager) {
      authApi.users().then(d => setUsers(d.users || [])).catch(() => {});
    }
  }, [isManager, loadSignatureFollowUps]);

  useEffect(() => {
    const requestedTab = tabFromQuery(searchParams.get('tab'));
    if (requestedTab && requestedTab !== activeTab) setActiveTab(requestedTab);
  }, [activeTab, searchParams]);

  // ── Load approvals when switching to that tab ─────────────────────────────────
  useEffect(() => {
    if (activeTab === 'approvals') loadApprovals();
  }, [activeTab, loadApprovals]);

  // ── Dev diagnostics ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (import.meta.env.PROD) return;
    if (activeTab === 'workflow') {
      const trackerRaw = trackerTasksStore.get();
      const manualRaw  = manualTasksStore.get();
      console.log('[Tasks Workflow Diagnostics]', {
        workflowsSourceTotal:       trackerRaw.length + manualRaw.length,
        workflowsTrackerActive:     trackerRaw.filter(t => t.appStatus !== 'completed').length,
        workflowsManualActive:      manualRaw.filter(m => m.status !== 'Completed').length,
        workflowsActiveTotal:       localItems.filter(isActiveWorkflowItem).length,
        tasksWorkflowSelectorTotal: localItems.length,
        afterTabFilterTotal:        localItems.filter(isActiveWorkflowItem).length,
        sampleWorkflowSourceItem:   trackerRaw[0] || manualRaw[0] || null,
        sampleTasksWorkflowItem:    localItems[0] || null,
      });
    }
    if (activeTab === 'signatures') {
      console.log('[Tasks Signature Follow-Up Diagnostics]', {
        signingSentWaitingTotal:           signingDocs.length,
        signatureFollowUpSelectorTotal:    signingDocs.length,
        sampleSentWaitingItem:             signingDocs[0] || null,
        rejectedSigningItems:              [],
      });
    }
  }, [activeTab, localItems, signingDocs]);

  // ── Derived collections ───────────────────────────────────────────────────────
  const activeItems = useMemo(
    () => localItems.filter(isActiveWorkflowItem),
    [localItems],
  );

  const completedItems = useMemo(() => {
    const items = localItems.filter(isCompletedWorkflowItem);
    return items.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  }, [localItems]);

  // ── KPI cards (computed from localStorage + signingDocs) ─────────────────────
  const kpiStats = useMemo(() => {
    const now       = new Date();
    const eod       = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const weekStart = new Date(now.getTime() - 7 * 86400000);

    const myActive = activeItems.filter(i => i.assignee?.name === user?.name);

    return {
      myOpenTasks:      myActive.length,
      myDueToday:       myActive.filter(i => {
        const d = i.deadline && new Date(i.deadline);
        return d && d >= now && d <= eod;
      }).length,
      myOverdue:        myActive.filter(i => i.dueState === 'overdue').length,
      waitingForManager: activeItems.filter(i => i.pipelineStage === 'manager').length,
      workflowTasks:    activeItems.length,
      sigFollowUps:     signingDocs.length,
      completedThisWeek: completedItems.filter(i => {
        const d = i.completedAt && new Date(i.completedAt);
        return d && d >= weekStart;
      }).length,
    };
  }, [activeItems, completedItems, signingDocs, user]);

  // ── Visible items for current tab (+ search filter) ──────────────────────────
  const visibleItems = useMemo(() => {
    let items;
    switch (activeTab) {
      case 'mine':      items = activeItems.filter(i => i.assignee?.name === user?.name); break;
      case 'team':      items = activeItems.filter(i => !!i.assignee); break;
      case 'workflow':  items = activeItems; break;
      case 'unassigned':items = activeItems.filter(i => !i.assignee); break;
      case 'overdue':   items = activeItems.filter(i => i.dueState === 'overdue'); break;
      case 'completed': {
        let comp = completedItems;
        if (completedFilter !== 'all') {
          const dayMap = { week: 7, month: 30, '3months': 90, '6months': 180, year: 365 };
          const days = dayMap[completedFilter];
          if (days) {
            const cutoff = new Date(new Date().getTime() - days * 86400000);
            comp = comp.filter(i => i.completedAt && new Date(i.completedAt) >= cutoff);
          }
        }
        items = comp; break;
      }
      case 'approvals': items = approvalTasks; break;
      default:          items = [];
    }

    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(item => {
      // Normalized workflow item
      if (item._type === 'TRACKER' || item._type === 'MANUAL') {
        return (
          (item.title       || '').toLowerCase().includes(q) ||
          (item.parties     || '').toLowerCase().includes(q) ||
          (item.department  || '').toLowerCase().includes(q) ||
          (item.taskType    || '').toLowerCase().includes(q) ||
          (item.legalTrackerId || '').toLowerCase().includes(q) ||
          (item.assignee?.name || '').toLowerCase().includes(q)
        );
      }
      // MongoDB task (approvals)
      const meta = item.trackerMeta || {};
      return (
        (item.title                  || '').toLowerCase().includes(q) ||
        (item.assignedTo?.name       || '').toLowerCase().includes(q) ||
        (meta.legalTrackerId         || '').toLowerCase().includes(q) ||
        (meta.parties                || '').toLowerCase().includes(q) ||
        (meta.department             || '').toLowerCase().includes(q)
      );
    });
  }, [activeTab, activeItems, completedItems, approvalTasks, search, completedFilter, user]);

  const visibleSigningDocs = useMemo(() => {
    if (!search.trim()) return signingDocs;
    const q = search.toLowerCase();
    return signingDocs.filter((doc) => {
      const progress = getSignerProgress(doc);
      return (
        (doc.name || '').toLowerCase().includes(q) ||
        (doc.type || '').toLowerCase().includes(q) ||
        (doc.status || '').toLowerCase().includes(q) ||
        (doc.preparedBy?.name || doc.uploadedBy?.name || '').toLowerCase().includes(q) ||
        progress.signers.some((signer) => (
          (signer.name || '').toLowerCase().includes(q) ||
          (signer.email || '').toLowerCase().includes(q) ||
          (signer.role || '').toLowerCase().includes(q)
        ))
      );
    });
  }, [search, signingDocs]);

  // ── Debug panel data (workflow tab, dev only) ─────────────────────────────────
  const workflowDebugInfo = useMemo(() => {
    if (activeTab !== 'workflow') return null;
    const trackerRaw = trackerTasksStore.get();
    const manualRaw  = manualTasksStore.get();
    return {
      trackerActive: trackerRaw.filter(t => t.appStatus !== 'completed').length,
      manualActive:  manualRaw.filter(m => m.status !== 'Completed').length,
      selectorTotal: localItems.length,
      afterFilter:   activeItems.length,
    };
  }, [activeTab, localItems, activeItems]);

  // ── Done: mark workflow item complete ─────────────────────────────────────────
  function handleDoneConfirmed() {
    const item = doneTarget;
    if (!item) return;

    if (item._type === 'TRACKER') {
      const items = trackerTasksStore.get();
      trackerTasksStore.set(items.map(t =>
        t.id === item.id
          ? { ...t, appStatus: 'completed', progress: 'Completed', pipelineStage: 'complete', completedAt: new Date().toISOString() }
          : t
      ));
    } else {
      manualTasksStore.update(item.id, {
        status: 'Completed', pipelineStage: 'complete', completedAt: new Date().toISOString(),
      });
      completeManualTask({ id: item.id, workflowTaskId: item.id }).catch(() => {});
    }

    setDoneTarget(null);
    reloadLocalItems();
  }

  // ── Assign: update localStorage after AssignModal resolves ───────────────────
  function handleAssignedFromTasks({ assignedUser }) {
    setShowAssign(false);
    if (!assignedUser || !assignTarget) return;

    if (assignTarget._type === 'TRACKER' || assignTarget.sourceType === 'LEGAL_TRACKER') {
      const rowNum = assignTarget.rowNumber ?? assignTarget.trackerMeta?.rowNumber;
      if (rowNum != null) {
        const items = trackerTasksStore.get();
        trackerTasksStore.set(items.map(t =>
          t.rowNumber === rowNum
            ? { ...t, assignee: assignedUser.name, pipelineStage: 'assigned' }
            : t
        ));
      }
    } else if (assignTarget._type === 'MANUAL' || assignTarget.sourceType === 'MANUAL_WORKFLOW') {
      const wfId = assignTarget.id || assignTarget.workflowTaskId || assignTarget.trackerMeta?.workflowTaskId;
      if (wfId) {
        manualTasksStore.update(wfId, { assignee: assignedUser.name, pipelineStage: 'assigned' });
      }
    }

    reloadLocalItems();
  }

  // ── Approvals: status update (MongoDB-backed tasks only) ─────────────────────
  const handleStatusUpdate = async (task, newStatus) => {
    try {
      await tasksApi.update(task._id, { status: newStatus });
      loadApprovals();
    } catch (e) {
      alert(e.message);
    }
  };

  async function handleRetrySync(task) {
    setSyncFeedback(prev => ({ ...prev, [task._id]: { status: 'syncing' } }));
    const result = await retryExcelSync(task);
    if (result.ok) {
      setSyncFeedback(prev => ({ ...prev, [task._id]: { status: 'ok' } }));
    } else {
      setSyncFeedback(prev => ({
        ...prev,
        [task._id]: { status: 'fail', message: result.message || 'Retry failed.' },
      }));
    }
  }

  const handleDelete = async (id) => {
    try {
      await tasksApi.delete(id);
      setDeleteConfirmId(null);
      loadApprovals();
    } catch (e) {
      alert(e.message);
    }
  };

  const updateReminderTimestamps = useCallback((docId, signers, remindedAt) => {
    const remindedEmails = new Set(signers.map((signer) => String(signer.email || '').toLowerCase()));
    setSigningDocs((prev) => prev.map((doc) => {
      if (doc._id !== docId || !Array.isArray(doc.signers)) return doc;
      return {
        ...doc,
        signers: doc.signers.map((signer) => (
          remindedEmails.has(String(signer.email || '').toLowerCase())
            ? { ...signer, lastReminderAt: remindedAt }
            : signer
        )),
      };
    }));
  }, []);

  const handleConfirmReminder = async () => {
    if (!reminderTarget) return;
    const pendingSigners = getPendingReminderSigners(reminderTarget);
    if (pendingSigners.length === 0) {
      setSignatureFeedback((prev) => ({
        ...prev,
        [reminderTarget._id]: { type: 'info', message: 'All signers have completed signing.' },
      }));
      setReminderTarget(null);
      return;
    }

    if (typeof signingApi?.remind !== 'function') {
      setSignatureFeedback((prev) => ({
        ...prev,
        [reminderTarget._id]: { type: 'error', message: 'Reminder service not configured.' },
      }));
      return;
    }

    setReminderSending(true);
    const results = await Promise.allSettled(
      pendingSigners.map((signer) => signingApi.remind(reminderTarget._id, signer.email))
    );
    setReminderSending(false);

    const failed = results
      .map((result, index) => ({ result, signer: pendingSigners[index] }))
      .filter(({ result }) => result.status === 'rejected');

    if (failed.length) {
      const message = failed[0].result.reason?.message || 'Failed to send reminder.';
      setSignatureFeedback((prev) => ({
        ...prev,
        [reminderTarget._id]: { type: 'error', message },
      }));
      return;
    }

    const remindedAt = new Date().toISOString();
    updateReminderTimestamps(reminderTarget._id, pendingSigners, remindedAt);
    setSignatureFeedback((prev) => ({
      ...prev,
      [reminderTarget._id]: {
        type: 'success',
        message: `Reminder sent to ${pendingSigners.length} pending signer${pendingSigners.length === 1 ? '' : 's'}.`,
      },
    }));
    setReminderTarget(null);
  };

  // ── New Task: save to localStorage (ManualTaskModal creates backend task too) ─
  function handleNewTaskSaved(localTask) {
    setShowNewTask(false);
    manualTasksStore.add(localTask);
    reloadLocalItems();
  }

  const isSignaturesTab = activeTab === 'signatures';
  const isApprovalsTab  = activeTab === 'approvals';
  const loading         = isApprovalsTab && approvalsLoading;
  const reminderPendingSigners = reminderTarget ? getPendingReminderSigners(reminderTarget) : [];
  const reminderFeedback = reminderTarget ? signatureFeedback[reminderTarget._id] : null;

  return (
    <div className="tl">
      <Header
        title="Tasks"
        subtitle="Track legal workflow tasks, approvals, and signature follow-ups."
        actions={
          isManager && (
            <button className="tl__new-btn" onClick={() => setShowNewTask(true)}>
              + New Task
            </button>
          )
        }
      />

      <div className="tl__body">

        {/* ── KPI summary cards ────────────────────────────────────────────── */}
        <div className="tl__stats">
          <StatCard label="My Open Tasks"       value={kpiStats.myOpenTasks}       color="blue"   onClick={() => setActiveTab('mine')} />
          <StatCard label="Due Today"           value={kpiStats.myDueToday}        color="orange" onClick={() => setActiveTab('mine')} />
          <StatCard label="Overdue"             value={kpiStats.myOverdue}         color="red"    onClick={() => setActiveTab('overdue')} urgent={kpiStats.myOverdue > 0} />
          <StatCard label="Waiting for Manager" value={kpiStats.waitingForManager} color="purple" onClick={() => setActiveTab('approvals')} />
          <StatCard label="Workflow Tasks"      value={kpiStats.workflowTasks}     color="amber"  onClick={() => setActiveTab('workflow')} />
          <StatCard label="Sig. Follow-ups"     value={kpiStats.sigFollowUps}      color="teal"   onClick={() => setActiveTab('signatures')} />
          <StatCard label="Done This Week"      value={kpiStats.completedThisWeek} color="green"  onClick={() => setActiveTab('completed')} />
        </div>

        {/* ── Tabs + search + completed filter ─────────────────────────────── */}
        <div className="tl__toolbar">
          <div className="tl__tabs">
            {TABS.map(t => {
              if (t.managerOnly && !isManager) return null;
              return (
                <button
                  key={t.key}
                  className={`tl__tab${activeTab === t.key ? ' tl__tab--active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="tl__toolbar-right">
            {activeTab === 'completed' && (
              <select
                className="tl__completed-filter"
                value={completedFilter}
                onChange={e => setCompletedFilter(e.target.value)}
                aria-label="Completed date range"
              >
                {COMPLETED_FILTERS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            )}
            <input
              className="tl__search"
              placeholder={isSignaturesTab ? 'Search documents, signers…' : 'Search tasks, tracker rows, owners…'}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* ── Content ─────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="tl__loading">Loading tasks…</div>

        ) : isSignaturesTab ? (
          visibleSigningDocs.length === 0 ? (
            <div className="tl__empty">
              <div className="tl__empty-icon">✅</div>
              <p>{signingDocs.length === 0 ? 'No pending signature requests.' : 'No signature follow-ups match this search.'}</p>
            </div>
          ) : (
            <div className="tl__task-list">
              <div className="tl__list-header">
                <span>Document</span>
                <span>Signers</span>
                <span>Prepared By</span>
                <span>Sent</span>
                <span>Status</span>
                <span>Actions</span>
              </div>
              {visibleSigningDocs.map(doc => (
                <SignatureFollowUpRow
                  key={doc._id}
                  doc={doc}
                  feedback={signatureFeedback[doc._id]}
                  onOpenSigning={() => navigate(`/signing/view/${doc._id}`, { state: SIGNATURE_FOLLOW_UP_RETURN_STATE })}
                  onReminderRequest={() => setReminderTarget(doc)}
                />
              ))}
            </div>
          )

        ) : isApprovalsTab ? (
          /* Approvals: MongoDB-backed MANAGER_APPROVAL tasks */
          visibleItems.length === 0 ? (
            <div className="tl__empty">
              <div className="tl__empty-icon">✅</div>
              <p>No approval tasks.</p>
            </div>
          ) : (
            <div className="tl__task-list">
              <div className="tl__list-header">
                <span>Task</span>
                <span>Source / Context</span>
                <span>Assigned To</span>
                <span>Due</span>
                <span>Status</span>
                <span>Actions</span>
              </div>
              {visibleItems.map(task => (
                <TaskRow
                  key={task._id}
                  task={task}
                  user={user}
                  isManager={isManager}
                  confirmingDelete={deleteConfirmId === task._id}
                  syncFeedback={syncFeedback[task._id]}
                  onStatusUpdate={handleStatusUpdate}
                  onRetrySync={handleRetrySync}
                  onEdit={() => { setEditTask(task); setShowForm(true); }}
                  onDeleteRequest={() => setDeleteConfirmId(task._id)}
                  onDeleteConfirm={() => handleDelete(task._id)}
                  onDeleteCancel={() => setDeleteConfirmId(null)}
                  onOpenWorkflows={() => navigate('/workflows')}
                  onAssign={(t) => { setAssignTarget(t); setShowAssign(true); }}
                />
              ))}
            </div>
          )

        ) : /* Workflow-based tabs: localStorage items */ (
          <>
            {/* Dev debug panel — shown when Workflow Tasks tab is empty */}
            {activeTab === 'workflow' && visibleItems.length === 0 && workflowDebugInfo && (
              <details className="tl__debug-panel">
                <summary className="tl__debug-toggle">Workflow Debug</summary>
                <div className="tl__debug-body">
                  <p>Active workflows available from Workflows store: {workflowDebugInfo.trackerActive + workflowDebugInfo.manualActive}</p>
                  <p>Tracker active: {workflowDebugInfo.trackerActive}</p>
                  <p>Manual active: {workflowDebugInfo.manualActive}</p>
                  <p>Items received by Tasks selector: {workflowDebugInfo.selectorTotal}</p>
                  <p>Items after Tasks filter: {workflowDebugInfo.afterFilter}</p>
                </div>
              </details>
            )}

            {visibleItems.length === 0 ? (
              <div className="tl__empty">
                <div className="tl__empty-icon">✅</div>
                <p>No tasks in this view.</p>
                {isManager && activeTab !== 'completed' && (
                  <button className="tl__new-btn" onClick={() => setShowNewTask(true)}>
                    Create First Task
                  </button>
                )}
              </div>
            ) : (
              <div className="tl__task-list">
                <div className="tl__list-header">
                  <span>Task</span>
                  <span>Source / Context</span>
                  <span>Assigned To</span>
                  <span>Due</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {visibleItems.map(item => (
                  <WorkflowItemRow
                    key={item.id}
                    item={item}
                    user={user}
                    isManager={isManager}
                    onDone={setDoneTarget}
                    onAssign={(i) => { setAssignTarget(i); setShowAssign(true); }}
                    onOpenWorkflows={() => navigate('/workflows')}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────────── */}
      {showForm && (
        <TaskForm
          task={editTask}
          users={users}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadApprovals(); }}
        />
      )}

      {showAssign && (
        <AssignModal
          task={assignTarget}
          onClose={() => setShowAssign(false)}
          onAssigned={handleAssignedFromTasks}
        />
      )}

      {showNewTask && (
        <ManualTaskModal
          currentUser={user}
          onClose={() => setShowNewTask(false)}
          onSaved={handleNewTaskSaved}
        />
      )}

      {doneTarget && (
        <DoneConfirmModal
          task={doneTarget}
          onClose={() => setDoneTarget(null)}
          onConfirmed={handleDoneConfirmed}
        />
      )}

      <Modal
        isOpen={Boolean(reminderTarget)}
        onClose={() => {
          if (!reminderSending) setReminderTarget(null);
        }}
        title="Send signature reminder?"
        size="md"
      >
        {reminderTarget && (
          <div className="tl__reminder-modal">
            <p className="tl__reminder-copy">
              This will send a reminder to pending signers who have not completed signing.
            </p>
            <div className="tl__reminder-document">{reminderTarget.name}</div>

            {reminderPendingSigners.length > 0 ? (
              <div className="tl__reminder-list">
                {reminderPendingSigners.map((signer) => (
                  <div key={signer.email} className="tl__reminder-signer">
                    <div>
                      <span className="tl__reminder-name">{signer.name}</span>
                      <span className="tl__reminder-email">{signer.email}</span>
                    </div>
                    <span className="tl__reminder-role">{signer.role}</span>
                    <span className="tl__signer-badge tl__signer-badge--pending">{signer.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tl__reminder-empty">All signers have completed signing.</div>
            )}

            {reminderFeedback && (
              <div className={`tl__signature-feedback tl__signature-feedback--${reminderFeedback.type}`} role="alert">
                {reminderFeedback.message}
              </div>
            )}

            <div className="tl__modal-actions">
              <button
                className="tl__action tl__action--edit"
                type="button"
                disabled={reminderSending}
                onClick={() => setReminderTarget(null)}
              >
                Cancel
              </button>
              <button
                className="tl__action tl__action--remind"
                type="button"
                disabled={reminderSending || reminderPendingSigners.length === 0}
                onClick={handleConfirmReminder}
              >
                {reminderSending ? 'Sending…' : 'Send Reminder'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, onClick, urgent }) {
  return (
    <button
      className={`tl__stat tl__stat--${color}${urgent ? ' tl__stat--urgent' : ''}`}
      onClick={onClick}
    >
      <span className="tl__stat-value">{value ?? 0}</span>
      <span className="tl__stat-label">{label}</span>
    </button>
  );
}

// ── WorkflowItemRow ───────────────────────────────────────────────────────────
// Renders normalized localStorage workflow items (tracker + manual).
function WorkflowItemRow({ item, user, isManager, onDone, onAssign, onOpenWorkflows }) {
  const isTracker  = item._type === 'TRACKER';
  const isCompleted = isCompletedWorkflowItem(item);
  const isOwner    = item.assignee?.name === user?.name;
  const dueState   = item.dueState || calcDueState(item.deadline);

  const badge = isTracker
    ? { label: 'Tracker', cls: 'tl__source-badge--tracker' }
    : { label: 'Manual',  cls: 'tl__source-badge--manual'  };

  const wasLate = isCompleted && item.completedAt && item.deadline &&
    new Date(item.completedAt) > new Date(item.deadline);

  return (
    <div className={`tl__row${dueState === 'overdue' && !isCompleted ? ' tl__row--overdue' : ''}`}>
      {/* Col 1: Task */}
      <div className="tl__col-task">
        <div className="tl__task-badges">
          <span className={`tl__source-badge ${badge.cls}`}>{badge.label}</span>
          {item.taskType && <span className="tl__task-type">{item.taskType}</span>}
        </div>
        <span className="tl__task-title">{item.title}</span>
        {item.parties && <span className="tl__task-note">{item.parties}</span>}
      </div>

      {/* Col 2: Source / Context */}
      <div className="tl__col-lr">
        <div className="tl__tracker-context">
          {isTracker && item.legalTrackerId && (
            <span className="tl__lr-ref">{item.legalTrackerId}</span>
          )}
          {isTracker && item.parties && (
            <span className="tl__lr-title">{item.parties}</span>
          )}
          {item.department && <span className="tl__lr-type">{item.department}</span>}
          {isTracker && item.workbookName && (
            <span className="tl__lr-workbook">{item.workbookName}</span>
          )}
          {!isTracker && <span className="tl__lr-none">Manual workflow</span>}
        </div>
      </div>

      {/* Col 3: Assignee */}
      <div className="tl__col-owner">
        {item.assignee ? (
          <>
            <span className="tl__owner-avatar">
              {item.assignee.name?.charAt(0).toUpperCase() || '?'}
            </span>
            <div>
              <span className="tl__owner-name">{item.assignee.name}</span>
            </div>
          </>
        ) : <span className="tl__lr-none">Unassigned</span>}
      </div>

      {/* Col 4: Due */}
      <div className="tl__col-due">
        {isCompleted ? (
          <span className={wasLate ? 'tl__completed-late' : 'tl__completed-date'}>
            {wasLate
              ? 'Completed late'
              : item.completedAt
                ? `Done ${new Date(item.completedAt).toLocaleDateString('en-ZA')}`
                : 'Completed'}
          </span>
        ) : item.deadline ? (
          <span className={`tl__days tl__days--${dueState}`}>
            {dueState === 'overdue' ? 'Overdue'
              : dueState === 'today' ? 'Due today'
              : dueState === 'soon'  ? 'Due soon'
              : new Date(item.deadline).toLocaleDateString('en-ZA')}
          </span>
        ) : item.rawDeadlineText ? (
          <span className="tl__days">{item.rawDeadlineText}</span>
        ) : '—'}
      </div>

      {/* Col 5: Status */}
      <div className="tl__col-status">
        <span
          className="tl__status-pill"
          style={isCompleted
            ? { background: '#f0fdf4', color: '#15803d' }
            : { background: '#f8fafc', color: '#475569' }}
        >
          {isCompleted ? 'Completed' : (item.status || 'Active')}
        </span>
      </div>

      {/* Col 6: Actions */}
      <div className="tl__col-actions">
        {!isCompleted && (isOwner || isManager) && (
          <button className="tl__action tl__action--complete" onClick={() => onDone(item)}>
            Done
          </button>
        )}
        {isManager && !isCompleted && (
          <button className="tl__action tl__action--assign" onClick={() => onAssign(item)}>
            {item.assignee ? 'Reassign' : 'Assign'}
          </button>
        )}
        <button className="tl__action tl__action--workflows" onClick={onOpenWorkflows}>
          Workflows
        </button>
      </div>
    </div>
  );
}

// ── Signature Follow-Up row ───────────────────────────────────────────────────
function SignatureFollowUpRow({ doc, feedback, onOpenSigning, onReminderRequest }) {
  const progress = getSignerProgress(doc);
  const { signedCount, totalSigners, pendingCount } = progress;
  const pendingReminderSigners = getPendingReminderSigners(doc);
  const sentEntry    = (doc.auditLogs || []).find(l => /sent/i.test(l.action || ''));
  const sentDate     = sentEntry?.createdAt || doc.updatedAt;
  const preparedBy   = doc.preparedBy || doc.uploadedBy || null;
  const statusLabel  = getDocumentSigningStatus(doc);
  const statusClass  = statusLabel === 'Partially Signed'
    ? 'tl__status-pill--partial'
    : statusLabel === 'Completed'
      ? 'tl__status-pill--complete'
      : 'tl__status-pill--pending-signature';
  const lastReminderAt = progress.signers
    .map((signer) => signer.lastReminderAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const visibleSigners = [
    ...progress.signers.filter((signer) => !signer.hasSigned),
    ...progress.signers.filter((signer) => signer.hasSigned),
  ].slice(0, 6);
  const hiddenSignerCount = Math.max(0, progress.signers.length - visibleSigners.length);
  const reminderDisabled = pendingCount === 0 || pendingReminderSigners.length === 0;

  return (
    <div className="tl__row">
      <div className="tl__col-task">
        <div className="tl__task-badges">
          <span className="tl__source-badge tl__source-badge--sig">Signing</span>
          {doc.type && <span className="tl__task-type">{doc.type}</span>}
        </div>
        <span className="tl__task-title">{doc.name}</span>
      </div>

      <div className="tl__col-lr tl__signers-cell">
        <span className="tl__lr-ref">{signedCount}/{totalSigners} signed</span>
        {visibleSigners.map((signer) => (
          <span
            key={`${signer.email || signer.name}:${signer.role}`}
            className={`tl__signer-line${signer.hasSigned ? ' tl__signer-line--signed' : ''}`}
          >
            <span className={`tl__signer-badge ${signer.hasSigned ? 'tl__signer-badge--signed' : signer.status === 'Viewed' ? 'tl__signer-badge--viewed' : 'tl__signer-badge--pending'}`}>
              {signer.hasSigned ? '✓' : signer.status === 'Viewed' ? 'Viewed' : 'Pending'}
            </span>
            <span className="tl__signer-main">{signer.name || signer.email} — {signer.role} · {signer.status}</span>
            {signer.lastReminderAt
              ? <span className="tl__reminded-badge">Reminder sent</span>
              : <span className="tl__reminder-slot" aria-hidden="true" />}
          </span>
        ))}
        {hiddenSignerCount > 0 && (
          <span className="tl__lr-none">+{hiddenSignerCount} more signer{hiddenSignerCount === 1 ? '' : 's'}</span>
        )}
      </div>

      <div className="tl__col-owner">
        {preparedBy ? (
          <>
            <span className="tl__owner-avatar">
              {preparedBy.name?.charAt(0).toUpperCase() || '?'}
            </span>
            <div>
              <span className="tl__owner-name">{preparedBy.name || preparedBy.email || '—'}</span>
            </div>
          </>
        ) : <span className="tl__lr-none">—</span>}
      </div>

      <div className="tl__col-due">
        {sentDate ? (
          <span className="tl__days tl__days--ok">
            {new Date(sentDate).toLocaleDateString('en-ZA')}
          </span>
        ) : <span className="tl__lr-none">—</span>}
      </div>

      <div className="tl__col-status">
        <span className={`tl__status-pill ${statusClass}`}>
          {statusLabel}
        </span>
      </div>

      <div className="tl__col-actions">
        <button className="tl__action tl__action--workflows" onClick={onOpenSigning}>
          Open Signing
        </button>
        <button
          className="tl__action tl__action--remind"
          disabled={reminderDisabled}
          title={pendingCount === 0 ? 'All signers have completed signing.' : 'Send reminder to pending signers'}
          onClick={onReminderRequest}
        >
          {lastReminderAt ? 'Remind Again' : 'Send Reminder'}
        </button>
        {lastReminderAt && (
          <span className="tl__action-note">Reminder sent {new Date(lastReminderAt).toLocaleDateString('en-ZA')}</span>
        )}
        {pendingCount === 0 && (
          <span className="tl__action-note">All signers have completed signing.</span>
        )}
        {feedback && (
          <span className={`tl__signature-feedback tl__signature-feedback--${feedback.type}`} role="status">
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}

// ── TaskRow (kept for Approvals tab — MongoDB-backed MANAGER_APPROVAL tasks) ──
function TaskRow({
  task, user, isManager, confirmingDelete, syncFeedback,
  onStatusUpdate, onRetrySync, onEdit, onDeleteRequest, onDeleteConfirm, onDeleteCancel,
  onOpenWorkflows, onAssign,
}) {
  const days   = getDaysLabel(task.deadline);
  const stsClr = TASK_STATUS_COLORS[task.status] || TASK_STATUS_COLORS['Pending'];
  const priClr = TASK_PRIORITY_COLORS[task.priority] || TASK_PRIORITY_COLORS.Medium;
  const isOwner = task.assignedTo?._id === user._id || task.assignedTo?._id?.toString() === user._id?.toString();
  const isDone  = ['Completed', 'Cancelled'].includes(task.status);
  const isTracker = task.sourceType === 'LEGAL_TRACKER';
  const isManual  = task.sourceType === 'MANUAL_WORKFLOW';
  const meta      = task.trackerMeta || {};
  const syncBadge = { LEGAL_TRACKER: { label: 'Tracker', cls: 'tl__source-badge--tracker' }, MANUAL_WORKFLOW: { label: 'Manual', cls: 'tl__source-badge--manual' } }[task.sourceType];

  const showRetry     = isTracker && task.status === 'Completed' && task.syncStatus === 'SYNC_FAILED';
  const syncIsSyncing = syncFeedback?.status === 'syncing';

  const wasCompletedLate = task.status === 'Completed' && task.completedAt && task.deadline &&
    new Date(task.completedAt) > new Date(task.deadline);

  return (
    <div className={`tl__row${days?.cls === 'overdue' && !isDone ? ' tl__row--overdue' : ''}${isTracker && task.syncStatus === 'SYNC_FAILED' ? ' tl__row--sync-failed' : ''}`}>
      <div className="tl__col-task">
        <div className="tl__task-badges">
          {syncBadge && <span className={`tl__source-badge ${syncBadge.cls}`}>{syncBadge.label}</span>}
          <span className="tl__task-type">{TASK_TYPE_LABELS[task.type] || task.type}</span>
          <span className="tl__task-pri" style={{ background: priClr.bg, color: priClr.color }}>{task.priority}</span>
        </div>
        <span className="tl__task-title">{task.title}</span>
        {task.progressNote && <span className="tl__task-note">{task.progressNote}</span>}
        {isTracker && task.syncStatus && task.syncStatus !== 'SYNCED' && (
          <span className={`tl__sync-status tl__sync-status--${task.syncStatus.toLowerCase().replace('_', '-')}`}>
            {task.syncStatus === 'SYNC_FAILED'  && 'Excel sync failed'}
            {task.syncStatus === 'SYNC_PENDING' && 'Excel sync pending'}
            {task.syncStatus === 'LOCAL_ONLY'   && 'Local only — no desktop'}
            {task.syncStatus === 'CONFLICT'     && 'Conflict'}
          </span>
        )}
        {syncFeedback?.status === 'fail' && <span className="tl__sync-status tl__sync-status--sync-failed">{syncFeedback.message}</span>}
        {syncFeedback?.status === 'ok'   && <span className="tl__sync-status tl__sync-status--synced">Excel synced</span>}
      </div>

      <div className="tl__col-lr">
        {isTracker ? (
          <div className="tl__tracker-context">
            {meta.legalTrackerId && <span className="tl__lr-ref">{meta.legalTrackerId}</span>}
            {meta.parties        && <span className="tl__lr-title">{meta.parties}</span>}
            {meta.taskType       && <span className="tl__lr-type">{meta.taskType}</span>}
            {meta.workbookName   && <span className="tl__lr-workbook">{meta.workbookName}</span>}
          </div>
        ) : isManual ? (
          <div className="tl__tracker-context">
            {meta.taskType   && <span className="tl__lr-type">{meta.taskType}</span>}
            {meta.department && <span className="tl__lr-type">{meta.department}</span>}
            <span className="tl__lr-none">Manual workflow</span>
          </div>
        ) : (
          <span className="tl__lr-none">Approval task</span>
        )}
      </div>

      <div className="tl__col-owner">
        {task.assignedTo ? (
          <>
            <span className="tl__owner-avatar">{task.assignedTo.name?.charAt(0).toUpperCase()}</span>
            <div>
              <span className="tl__owner-name">{task.assignedTo.name}</span>
              <span className="tl__owner-role">{task.assignedTo.role}</span>
            </div>
          </>
        ) : <span className="tl__lr-none">Unassigned</span>}
      </div>

      <div className="tl__col-due">
        {days && !isDone ? (
          <span className={`tl__days tl__days--${days.cls}`}>{days.label}</span>
        ) : task.deadline ? (
          <span className="tl__days">{new Date(task.deadline).toLocaleDateString('en-ZA')}</span>
        ) : '—'}
        {task.status === 'Completed' && task.completedAt && (
          <span className={`tl__completed-date${wasCompletedLate ? ' tl__completed-late' : ''}`}>
            {wasCompletedLate ? 'Completed late' : `Done ${new Date(task.completedAt).toLocaleDateString('en-ZA')}`}
          </span>
        )}
      </div>

      <div className="tl__col-status">
        <span className="tl__status-pill" style={{ background: stsClr.bg, color: stsClr.color }}>
          {task.status}
        </span>
      </div>

      <div className="tl__col-actions">
        {isOwner && !isDone && (
          <>
            {task.status === 'Pending' && (
              <button className="tl__action tl__action--start" onClick={() => onStatusUpdate(task, 'In Progress')}>
                Start
              </button>
            )}
            <button className="tl__action tl__action--complete" onClick={() => onStatusUpdate(task, 'Completed')} disabled={syncIsSyncing}>
              {syncIsSyncing ? 'Syncing…' : 'Done'}
            </button>
          </>
        )}
        {isManager && !isDone && (isTracker || isManual) && (
          <button className="tl__action tl__action--assign" onClick={() => onAssign(task)}>Assign</button>
        )}
        {showRetry && (
          <button className="tl__action tl__action--retry" onClick={() => onRetrySync(task)} disabled={syncIsSyncing}>
            {syncIsSyncing ? '…' : 'Retry Sync'}
          </button>
        )}
        {(isTracker || isManual) && (
          <button className="tl__action tl__action--workflows" onClick={onOpenWorkflows}>Workflows</button>
        )}
        {isManager && (
          confirmingDelete ? (
            <>
              <span className="tl__action-confirm-label">Delete?</span>
              <button className="tl__action tl__action--confirm-yes" onClick={onDeleteConfirm}>Yes</button>
              <button className="tl__action tl__action--confirm-no"  onClick={onDeleteCancel}>No</button>
            </>
          ) : (
            <>
              <button className="tl__action tl__action--edit"   onClick={onEdit}>Edit</button>
              <button className="tl__action tl__action--delete" onClick={onDeleteRequest}>Del</button>
            </>
          )
        )}
      </div>
    </div>
  );
}
