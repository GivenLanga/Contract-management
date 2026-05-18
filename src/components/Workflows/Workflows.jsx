import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { legalRequests as lrApi, tasks as tasksApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import Header from '../Layout/Header';
import {
  STATUS_LABELS, STATUS_COLORS, HOLDER_LABELS, HOLDER_COLORS,
  PRIORITY_COLORS, REQUEST_TYPE_LABELS, getDaysLabel,
} from '../LegalRequests/lrHelpers';
import { trackerConfig, trackerTasks as trackerTasksStore, manualTasks as manualTasksStore, workflowTemplates } from '../../services/legalTrackerStore';
import LegalTrackerCard from './LegalTrackerCard';
import AssignModal      from './AssignModal';
import ManualTaskModal  from './ManualTaskModal';
import TemplateModal    from './TemplateModal';
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

// ── Filter tabs ────────────────────────────────────────────────────────────────
function itemDueDate(item)       { return item.dueDate || item.deadline || null; }
function itemAssignee(item)      { return item.assignedTo || (item.assignee ? { name: item.assignee } : null); }
function itemLastUpdate(item)    { return item.lastStatusChangeAt || item.lastSyncedAt || item.updatedAt || null; }
function itemPipelineStage(item) {
  if (item._type === 'LR') return null; // LR uses status-based pipeline mapping
  return item.pipelineStage || 'intake';
}

const FILTER_TABS = [
  { key: 'all',          label: 'All Active',      filter: () => true },
  { key: 'overdue',      label: 'Overdue',         filter: (r) => { const d = itemDueDate(r); return d && new Date(d) < new Date(); }},
  { key: 'dueToday',     label: 'Due Today',       filter: (r) => {
    const d = itemDueDate(r); if (!d) return false;
    const dd = new Date(d); const n = new Date();
    return dd >= n && dd <= new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59);
  }},
  { key: 'dueThisWeek',  label: 'Due This Week',   filter: (r) => {
    const d = itemDueDate(r); if (!d) return false;
    const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + 7);
    const dd = new Date(d); return dd >= now && dd <= end;
  }},
  { key: 'unassigned',   label: 'Unassigned',      filter: (r) => !itemAssignee(r) },
  { key: 'withManager',  label: 'With Manager',    filter: (r) => r.status === 'WITH_MANAGER' || r.pipelineStage === 'manager' },
  { key: 'withBusiness', label: 'With Business',   filter: (r) => r.status === 'WITH_BUSINESS_DEPARTMENT' || r.pipelineStage === 'business' },
  { key: 'signature',    label: 'Signature Track', filter: (r) => ['READY_FOR_SIGNATURE','SENT_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(r.status) || r.pipelineStage === 'signature' },
  { key: 'noUpdate',     label: 'No Update 3d',    filter: (r) => { const u = itemLastUpdate(r); return u && new Date(u) < new Date(Date.now() - 3 * 86400000); }},
  { key: 'tracker',      label: 'Tracker',         filter: (r) => r._type === 'TRACKER' },
  { key: 'manual',       label: 'Manual',          filter: (r) => r._type === 'MANUAL' },
];

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

// ── Default export ─────────────────────────────────────────────────────────────
export default function Workflows() {
  const navigate   = useNavigate();
  const { user, isManager } = useAuth();

  // ── Server data ──────────────────────────────────────────────────────────────
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab]           = useState('all');
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

  // ── Load server data ──────────────────────────────────────────────────────────
  const load = useCallback(() => {
    setLoading(true);
    lrApi.workflowDashboard()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
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
  async function handleCompleteTrackerTask(task) {
    const fieldUpdates = { progress: 'Completed' };
    if (window.contractiq?.trackerUpdateRow) {
      const res = await window.contractiq.trackerUpdateRow({ rowNumber: task.rowNumber, fieldUpdates });
      if (!res?.ok) showToastMsg('Spreadsheet sync pending — could not write Progress column.');
    }
    const updated = trackerItems.map(t =>
      t.id === task.id ? { ...t, appStatus: 'completed', progress: 'Completed', pipelineStage: 'complete' } : t
    );
    setTrackerItems(updated);
    trackerTasksStore.set(updated);
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

  // ── Manual tasks ──────────────────────────────────────────────────────────────
  function handleManualTaskSaved(task) {
    setShowManual(false);
    manualTasksStore.add(task);
    setManualItems(manualTasksStore.get());
    showToastMsg('Manual task added.');
  }

  function handleCompleteManualTask(task) {
    manualTasksStore.update(task.id, { status: 'Completed', pipelineStage: 'complete' });
    setManualItems(manualTasksStore.get());
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

  // ── Merged item list ──────────────────────────────────────────────────────────
  const allItems = useMemo(() => {
    const lrItems = (data?.requests || []).map(r => normalizeItem(r, 'LR'));
    const tkItems = trackerItems
      .filter(t => t.appStatus !== 'completed')
      .map(t => normalizeItem(t, 'TRACKER'));
    const mnItems = manualItems
      .filter(m => m.status !== 'Completed')
      .map(m => normalizeItem(m, 'MANUAL'));
    return [...lrItems, ...tkItems, ...mnItems];
  }, [data, trackerItems, manualItems]);

  // ── Filter logic ──────────────────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    let list = allItems;

    const applyCardFilter = (key) => {
      const now = new Date(); const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
      switch (key) {
        case 'overdue':     return list.filter(r => { const d = itemDueDate(r); return d && new Date(d) < now; });
        case 'dueToday':    return list.filter(r => { const d = itemDueDate(r); if (!d) return false; const dd = new Date(d); const eod = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59); return dd >= now && dd <= eod; });
        case 'dueThisWeek': return list.filter(r => { const d = itemDueDate(r); if (!d) return false; const dd = new Date(d); return dd >= now && dd <= weekEnd; });
        case 'withManager': return list.filter(r => r.status === 'WITH_MANAGER' || r.pipelineStage === 'manager');
        case 'withBusiness':return list.filter(r => r.status === 'WITH_BUSINESS_DEPARTMENT' || r.pipelineStage === 'business');
        case 'readyForSig': return list.filter(r => r.status === 'READY_FOR_SIGNATURE' || r.pipelineStage === 'signature');
        case 'awaitingSig': return list.filter(r => ['SENT_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(r.status));
        case 'noUpdate3':   return list.filter(r => { const u = itemLastUpdate(r); return u && new Date(u) < new Date(Date.now() - 3 * 86400000); });
        case 'unassigned':  return list.filter(r => !itemAssignee(r));
        default: return list;
      }
    };

    if (activeCardFilter && activeCardFilter !== 'active') {
      list = applyCardFilter(activeCardFilter);
    } else if (!activeCardFilter) {
      const tab = FILTER_TABS.find(t => t.key === activeTab);
      if (tab) list = list.filter(tab.filter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r => {
        const a = itemAssignee(r);
        return (
          (r.title || r.description || '').toLowerCase().includes(q) ||
          (r.requestId || r.legalTrackerId || '').toLowerCase().includes(q) ||
          (r.counterpartyName || r.parties || '').toLowerCase().includes(q) ||
          (r.department || '').toLowerCase().includes(q) ||
          (a?.name || '').toLowerCase().includes(q)
        );
      });
    }

    return list;
  }, [allItems, activeTab, search, activeCardFilter]);

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
      items: filteredItems.filter(item => {
        if (item._type === 'LR') return col.statuses.includes(item.status);
        return item.pipelineStage === col.key;
      }),
    }));
  }, [filteredItems]);

  // ── Card click handler ────────────────────────────────────────────────────────
  const handleCardClick = (key) => {
    setActiveCardFilter(prev => prev === key ? null : key);
    setActiveTab('all');
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

  const { bottlenecks = [] } = data || {};

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
            <button className="wf__action-btn" onClick={() => navigate('/legal-requests/new')}>
              + New Legal Request
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
              placeholder="Search by title, reference, owner, counterparty…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {!activeCardFilter && (
            <div className="wf__filter-tabs">
              {FILTER_TABS.map(t => (
                <button
                  key={t.key}
                  className={`wf__filter-tab${activeTab === t.key ? ' wf__filter-tab--active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {filteredItems.length === 0 ? (
            <div className="wf__empty">No workflows match the current filter.</div>
          ) : (
            <div className="wf__workflow-list">
              <div className="wf__workflow-header-row">
                <span>Request / Task</span>
                <span>Stage / Status</span>
                <span>Owner</span>
                <span>Due</span>
                <span>Actions</span>
              </div>
              {filteredItems.map(item => {
                if (item._type === 'LR') {
                  return <WorkflowRow key={item._id} request={item} onClick={() => navigate(`/legal-requests/${item._id}`)} />;
                }
                if (item._type === 'TRACKER') {
                  return (
                    <TrackerTaskRow
                      key={item.id}
                      task={item}
                      isManager={isManager}
                      onAssign={() => handleOpenAssign(item)}
                      onComplete={() => handleCompleteTrackerTask(item)}
                    />
                  );
                }
                return (
                  <ManualTaskRow
                    key={item.id}
                    task={item}
                    isManager={isManager}
                    onAssign={() => handleOpenAssign(item)}
                    onComplete={() => handleCompleteManualTask(item)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* ── Workflow Pipeline ───────────────────────────────────────────── */}
        <div className="wf__section">
          <h2 className="wf__section-title">Workflow Pipeline</h2>
          <p className="wf__section-sub">Requests and tracker tasks grouped by workflow stage. Wide columns indicate bottlenecks.</p>
          <div className="wf__pipeline">
            {pipelineData.map(col => (
              <PipelineColumn key={col.key} col={col} navigate={navigate} />
            ))}
          </div>
        </div>

        {/* ── Bottlenecks ─────────────────────────────────────────────────── */}
        {bottlenecks.some(b => b.count > 0) && (
          <div className="wf__section">
            <h2 className="wf__section-title">Bottlenecks</h2>
            <p className="wf__section-sub">Where legal requests are currently stuck.</p>
            <div className="wf__bottlenecks">
              {bottlenecks.filter(b => b.count > 0).map(b => (
                <BottleneckCard key={b.status} b={b} onClick={() => navigate(`/legal-requests?status=${b.status}`)} />
              ))}
            </div>
          </div>
        )}

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

function WorkflowRow({ request: r, onClick }) {
  const days    = getDaysLabel(r.dueDate);
  const stsClr  = STATUS_COLORS[r.status] || { bg: '#f8fafc', color: '#475569' };
  const priClr  = PRIORITY_COLORS[r.priority] || PRIORITY_COLORS.MEDIUM;
  const hldClr  = HOLDER_COLORS[r.currentHolder] || '#94a3b8';
  const initials = r.assignedTo?.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '—';

  return (
    <div className={`wf__workflow-row${days?.cls === 'overdue' ? ' wf__workflow-row--overdue' : ''}`} onClick={onClick}>
      <div className="wf__row-request">
        <div className="wf__row-badges">
          <span className="wf__source-badge wf__source-badge--lr">LR</span>
          <span className={`wf__track-badge wf__track-badge--${r.internalOrExternal?.toLowerCase()}`}>
            {r.internalOrExternal === 'INTERNAL' ? 'INT' : 'EXT'}
          </span>
          <span className="wf__priority-badge" style={{ background: priClr.bg, color: priClr.color }}>
            {r.priority}
          </span>
        </div>
        <span className="wf__row-ref">{r.requestId}</span>
        <span className="wf__row-title">{r.title}</span>
        <span className="wf__row-type">{REQUEST_TYPE_LABELS[r.requestType] || r.requestType}</span>
      </div>
      <div className="wf__row-stage">
        <span className="wf__status-pill" style={{ background: stsClr.bg, color: stsClr.color }}>
          {STATUS_LABELS[r.status] || r.status}
        </span>
        <span className="wf__holder-pill" style={{ color: hldClr }}>
          {HOLDER_LABELS[r.currentHolder] || r.currentHolder}
        </span>
      </div>
      <div className="wf__row-owner">
        {r.assignedTo ? (
          <>
            <span className="wf__owner-avatar">{initials}</span>
            <span className="wf__owner-name">{r.assignedTo.name}</span>
          </>
        ) : <span className="wf__unassigned">Unassigned</span>}
      </div>
      <div className="wf__row-due">
        {days ? <span className={`wf__days wf__days--${days.cls}`}>{days.label}</span> : '—'}
      </div>
      <div className="wf__row-action">
        {r.nextAction && <span className="wf__next-action">{r.nextAction}</span>}
      </div>
    </div>
  );
}

function TrackerTaskRow({ task: t, isManager, onAssign, onComplete }) {
  const dueState = t.dueState || calcDueState(t.deadline);
  const assigneeInitials = t.assignee?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || null;

  return (
    <div className={`wf__workflow-row wf__tracker-row${dueState === 'overdue' ? ' wf__workflow-row--overdue' : ''}`}>
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
        {t.deadline ? (
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
        {isManager && (
          <button className="wf__row-btn wf__row-btn--assign" onClick={e => { e.stopPropagation(); onAssign(); }}>
            Assign
          </button>
        )}
        <button className="wf__row-btn wf__row-btn--done" onClick={e => { e.stopPropagation(); onComplete(); }}>
          Done
        </button>
      </div>
    </div>
  );
}

function ManualTaskRow({ task: t, isManager, onAssign, onComplete }) {
  const dueState = calcDueState(t.dueDate);
  const assigneeInitials = t.assignee?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || null;

  return (
    <div className={`wf__workflow-row wf__manual-row${dueState === 'overdue' ? ' wf__workflow-row--overdue' : ''}`}>
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
        {t.dueDate ? (
          <span className={`wf__days wf__days--${dueState}`}>
            {dueState === 'overdue' ? 'Overdue' : new Date(t.dueDate).toLocaleDateString('en-ZA')}
          </span>
        ) : '—'}
      </div>
      <div className="wf__row-action">
        {isManager && (
          <button className="wf__row-btn wf__row-btn--assign" onClick={e => { e.stopPropagation(); onAssign(); }}>
            Assign
          </button>
        )}
        <button className="wf__row-btn wf__row-btn--done" onClick={e => { e.stopPropagation(); onComplete(); }}>
          Done
        </button>
      </div>
    </div>
  );
}

function PipelineColumn({ col, navigate }) {
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
          const isLR   = item._type === 'LR';
          const title  = isLR ? item.title : (item.description || item.title || 'Tracker Task');
          const ref    = isLR ? item.requestId : item.legalTrackerId;
          const due    = isLR ? item.dueDate : (item.deadline || item.dueDate);
          const days   = getDaysLabel(due);
          const assignee = isLR ? item.assignedTo : (item.assignee ? { name: item.assignee } : null);
          return (
            <div
              key={item._id || item.id}
              className="wf__pipe-item"
              onClick={() => isLR && navigate(`/legal-requests/${item._id}`)}
              style={!isLR ? { cursor: 'default' } : undefined}
            >
              <div className="wf__pipe-item-badges">
                {!isLR && (
                  <span className={`wf__pipe-source wf__pipe-source--${item._type?.toLowerCase()}`}>
                    {item._type === 'TRACKER' ? 'T' : 'M'}
                  </span>
                )}
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
            onClick={() => col.statuses?.length && navigate(`/legal-requests?status=${col.statuses[0]}`)}
          >
            +{col.items.length - 4} more →
          </button>
        )}
        {col.items.length === 0 && <div className="wf__pipe-empty">—</div>}
      </div>
    </div>
  );
}

function BottleneckCard({ b, onClick }) {
  return (
    <div className="wf__bottleneck" onClick={onClick}>
      <div className="wf__bottleneck-header">
        <span className="wf__bottleneck-label">{b.label}</span>
        <span className="wf__bottleneck-count">{b.count}</span>
      </div>
      <div className="wf__bottleneck-meta">
        <span>Avg wait: <strong>{b.avgWaitDays}d</strong></span>
      </div>
      {b.oldest && <div className="wf__bottleneck-oldest">Oldest: {b.oldest.title}</div>}
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
