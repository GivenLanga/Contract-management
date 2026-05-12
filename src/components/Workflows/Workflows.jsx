import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { legalRequests as lrApi } from '../../services/api';
import Header from '../Layout/Header';
import {
  STATUS_LABELS, STATUS_COLORS, HOLDER_LABELS, HOLDER_COLORS,
  PRIORITY_COLORS, REQUEST_TYPE_LABELS, getDaysLabel,
} from '../LegalRequests/lrHelpers';
import './Workflows.css';

// ── Pipeline column definitions ────────────────────────────────────────────────
const PIPELINE_COLS = [
  { key: 'intake',     label: 'Intake',           statuses: ['SUBMITTED', 'INTAKE_REVIEW'],                        color: '#64748b' },
  { key: 'assigned',   label: 'Assigned',          statuses: ['ASSIGNED'],                                          color: '#4f8ef7' },
  { key: 'review',     label: 'Legal Review',      statuses: ['IN_LEGAL_REVIEW', 'INTERNAL_LEGAL_REVIEW'],          color: '#4f8ef7' },
  { key: 'external',   label: 'Ext. Review (Email)', statuses: ['SENT_TO_EXTERNAL_PARTY', 'WAITING_FOR_EXTERNAL_PARTY', 'EXTERNAL_FEEDBACK_RECEIVED', 'NEGOTIATION_AMENDMENTS'], color: '#0d9488' },
  { key: 'business',   label: 'With Business',     statuses: ['WITH_BUSINESS_DEPARTMENT'],                          color: '#f59e0b' },
  { key: 'manager',    label: 'With Manager',      statuses: ['WITH_MANAGER', 'REVISIONS_REQUIRED', 'MANAGER_APPROVED', 'APPROVED'], color: '#8b5cf6' },
  { key: 'signature',  label: 'Signature',         statuses: ['READY_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'], color: '#10b981' },
  { key: 'complete',   label: 'Done',              statuses: ['FULLY_SIGNED', 'STORED', 'FINALIZED', 'CLOSED'],     color: '#94a3b8' },
];

// ── Static workflow rules ──────────────────────────────────────────────────────
const WORKFLOW_RULES = [
  {
    name: 'Internal Document Workflow',
    sla: '4 days',
    icon: '📋',
    color: '#8b5cf6',
    description: 'Internal policies, board resolutions, HR documents, legal memos, compliance documents',
    steps: ['Submitted', 'Intake Review', 'Assigned', 'In Legal Review', 'With Manager', 'Finalized', 'Closed'],
  },
  {
    name: 'External Contract Workflow',
    sla: '7 days',
    icon: '📄',
    color: '#4f8ef7',
    description: 'Supplier contracts, loan agreements, grant agreements, NDAs, leases, external agreements',
    steps: ['Submitted', 'Intake Review', 'Assigned', 'Internal Legal Review', 'With Business Dept.', 'With Manager', 'Ready for Signature', 'Sent for Signature', 'Fully Signed', 'Stored', 'Closed'],
  },
  {
    name: 'Signature Workflow',
    sla: 'Triggered by Ready for Signature',
    icon: '✍️',
    color: '#10b981',
    description: 'Triggered automatically when a request reaches Ready for Signature status',
    steps: ['Generate / attach signature-ready document', 'Send signature request emails', 'Track pending signatories', 'Mark Partially Signed or Fully Signed', 'Store signed document', 'Close request'],
  },
];

// ── Filter tabs definition ─────────────────────────────────────────────────────
const FILTER_TABS = [
  { key: 'all',          label: 'All Active',          filter: () => true },
  { key: 'overdue',      label: 'Overdue',             filter: (r) => r.dueDate && new Date(r.dueDate) < new Date() },
  { key: 'dueToday',     label: 'Due Today',           filter: (r) => {
    if (!r.dueDate) return false;
    const d = new Date(r.dueDate); const n = new Date();
    return d >= n && d <= new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59);
  }},
  { key: 'dueThisWeek',  label: 'Due This Week',       filter: (r) => {
    if (!r.dueDate) return false;
    const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + 7);
    const d = new Date(r.dueDate);
    return d >= now && d <= end;
  }},
  { key: 'unassigned',   label: 'Unassigned',          filter: (r) => !r.assignedTo },
  { key: 'withManager',  label: 'With Manager',        filter: (r) => r.status === 'WITH_MANAGER' },
  { key: 'withBusiness', label: 'With Business',       filter: (r) => r.status === 'WITH_BUSINESS_DEPARTMENT' },
  { key: 'signature',    label: 'Signature Track',     filter: (r) => ['READY_FOR_SIGNATURE','SENT_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(r.status) },
  { key: 'noUpdate',     label: 'No Update 3d',        filter: (r) => new Date(r.lastStatusChangeAt) < new Date(Date.now() - 3 * 86400000) },
];

export default function Workflows() {
  const navigate = useNavigate();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [activeTab, setActiveTab]   = useState('all');
  const [search, setSearch]         = useState('');
  const [activeCardFilter, setActiveCardFilter] = useState(null);
  const [rulesOpen, setRulesOpen]   = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    lrApi.workflowDashboard()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Filtered workflow list
  const filteredRequests = useMemo(() => {
    if (!data?.requests) return [];
    let list = data.requests;

    // Card-level filter takes precedence
    if (activeCardFilter === 'overdue')   list = list.filter(r => r.dueDate && new Date(r.dueDate) < new Date());
    else if (activeCardFilter === 'dueToday') {
      const n = new Date(), end = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59);
      list = list.filter(r => r.dueDate && new Date(r.dueDate) >= n && new Date(r.dueDate) <= end);
    }
    else if (activeCardFilter === 'withManager')     list = list.filter(r => r.status === 'WITH_MANAGER');
    else if (activeCardFilter === 'withBusiness')    list = list.filter(r => r.status === 'WITH_BUSINESS_DEPARTMENT');
    else if (activeCardFilter === 'readyForSig')     list = list.filter(r => r.status === 'READY_FOR_SIGNATURE');
    else if (activeCardFilter === 'awaitingSig')     list = list.filter(r => ['SENT_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(r.status));
    else if (activeCardFilter === 'noUpdate3')        list = list.filter(r => new Date(r.lastStatusChangeAt) < new Date(Date.now() - 3 * 86400000));
    else if (activeCardFilter === 'unassigned')       list = list.filter(r => !r.assignedTo);
    else if (activeCardFilter === 'dueThisWeek') {
      const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + 7);
      list = list.filter(r => r.dueDate && new Date(r.dueDate) >= now && new Date(r.dueDate) <= end);
    }

    // Tab filter (only when no card filter)
    if (!activeCardFilter) {
      const tab = FILTER_TABS.find(t => t.key === activeTab);
      if (tab) list = list.filter(tab.filter);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.title?.toLowerCase().includes(q) ||
        r.requestId?.toLowerCase().includes(q) ||
        r.counterpartyName?.toLowerCase().includes(q) ||
        r.department?.toLowerCase().includes(q) ||
        r.assignedTo?.name?.toLowerCase().includes(q)
      );
    }

    return list;
  }, [data, activeTab, search, activeCardFilter]);

  // Pipeline: group filtered requests by column so it respects active filters
  const pipelineData = useMemo(() => {
    return PIPELINE_COLS.map(col => ({
      ...col,
      items: filteredRequests.filter(r => col.statuses.includes(r.status)),
    }));
  }, [filteredRequests]);

  const handleCardClick = (key) => {
    setActiveCardFilter(prev => prev === key ? null : key);
    setActiveTab('all');
  };

  if (loading) {
    return (
      <div className="workflows">
        <Header title="Workflows" subtitle="Track active legal request workflows, approvals, signatures, and bottlenecks." />
        <div className="workflows__loading">Loading workflow data…</div>
      </div>
    );
  }

  const { cards = {}, bottlenecks = [] } = data || {};

  return (
    <div className="workflows">
      <Header
        title="Workflows"
        subtitle="Track active legal request workflows, approvals, signatures, and bottlenecks."
        actions={
          <>
            <button className="wf__refresh-btn" onClick={load} disabled={loading} title="Refresh workflow data">
              {loading ? '…' : '↻'}
            </button>
            <button className="wf__new-btn" onClick={() => navigate('/legal-requests/new')}>
              + New Legal Request
            </button>
          </>
        }
      />

      <div className="workflows__content">

        {/* ── Summary cards ──────────────────────────────────────────────── */}
        <div className="wf__cards">
          <WfCard label="Active Workflows"  value={cards.active}           color="blue"   active={activeCardFilter === 'active'}       onClick={() => handleCardClick('active')} />
          <WfCard label="Overdue"           value={cards.overdue}          color="red"    active={activeCardFilter === 'overdue'}      onClick={() => handleCardClick('overdue')}    urgent={cards.overdue > 0} />
          <WfCard label="Due Today"         value={cards.dueToday}         color="orange" active={activeCardFilter === 'dueToday'}    onClick={() => handleCardClick('dueToday')}   urgent={cards.dueToday > 0} />
          <WfCard label="Due This Week"     value={cards.dueThisWeek}      color="indigo" active={activeCardFilter === 'dueThisWeek'} onClick={() => handleCardClick('dueThisWeek')} />
          <WfCard label="Unassigned"        value={cards.unassigned}       color="violet" active={activeCardFilter === 'unassigned'}  onClick={() => handleCardClick('unassigned')}  urgent={cards.unassigned > 0} />
          <WfCard label="With Manager"      value={cards.withManager}      color="purple" active={activeCardFilter === 'withManager'} onClick={() => handleCardClick('withManager')} />
          <WfCard label="With Business"     value={cards.withBusiness}     color="amber"  active={activeCardFilter === 'withBusiness'}onClick={() => handleCardClick('withBusiness')} />
          <WfCard label="Ready for Sign."   value={cards.readyForSignature}color="green"  active={activeCardFilter === 'readyForSig'} onClick={() => handleCardClick('readyForSig')} />
          <WfCard label="Awaiting Sign."    value={cards.awaitingSignature}color="teal"   active={activeCardFilter === 'awaitingSig'}  onClick={() => handleCardClick('awaitingSig')} />
          <WfCard label="No Update 3d"      value={cards.noUpdate3}        color="gray"   active={activeCardFilter === 'noUpdate3'}   onClick={() => handleCardClick('noUpdate3')} />
        </div>

        {/* ── Active Legal Workflows ─────────────────────────────────────── */}
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

          {filteredRequests.length === 0 ? (
            <div className="wf__empty">No workflows match the current filter.</div>
          ) : (
            <div className="wf__workflow-list">
              <div className="wf__workflow-header-row">
                <span>Request</span>
                <span>Stage / Holder</span>
                <span>Owner</span>
                <span>Due</span>
                <span>Next Action</span>
              </div>
              {filteredRequests.map(r => (
                <WorkflowRow key={r._id} request={r} onClick={() => navigate(`/legal-requests/${r._id}`)} />
              ))}
            </div>
          )}
        </div>

        {/* ── Workflow Pipeline ──────────────────────────────────────────── */}
        <div className="wf__section">
          <h2 className="wf__section-title">Workflow Pipeline</h2>
          <p className="wf__section-sub">Requests grouped by current workflow stage. Wide columns indicate bottlenecks.</p>
          <div className="wf__pipeline">
            {pipelineData.map(col => (
              <PipelineColumn key={col.key} col={col} navigate={navigate} />
            ))}
          </div>
        </div>

        {/* ── Bottlenecks ────────────────────────────────────────────────── */}
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

        {/* ── Workflow Rules & Templates ─────────────────────────────────── */}
        <div className="wf__section">
          <button className="wf__rules-toggle" onClick={() => setRulesOpen(o => !o)}>
            <span className="wf__section-title">Workflow Rules &amp; Templates</span>
            <span className="wf__rules-arrow">{rulesOpen ? '▲' : '▼'}</span>
          </button>
          {rulesOpen && (
            <div className="wf__rules-grid">
              {WORKFLOW_RULES.map(rule => (
                <WorkflowRuleCard key={rule.name} rule={rule} />
              ))}
            </div>
          )}
        </div>

      </div>
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
      {/* Col 1: Request */}
      <div className="wf__row-request">
        <div className="wf__row-badges">
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

      {/* Col 2: Stage / Holder */}
      <div className="wf__row-stage">
        <span className="wf__status-pill" style={{ background: stsClr.bg, color: stsClr.color }}>
          {STATUS_LABELS[r.status] || r.status}
        </span>
        <span className="wf__holder-pill" style={{ color: hldClr }}>
          {HOLDER_LABELS[r.currentHolder] || r.currentHolder}
        </span>
      </div>

      {/* Col 3: Owner */}
      <div className="wf__row-owner">
        {r.assignedTo ? (
          <>
            <span className="wf__owner-avatar">{initials}</span>
            <span className="wf__owner-name">{r.assignedTo.name}</span>
          </>
        ) : (
          <span className="wf__unassigned">Unassigned</span>
        )}
      </div>

      {/* Col 4: Due */}
      <div className="wf__row-due">
        {days ? (
          <span className={`wf__days wf__days--${days.cls}`}>{days.label}</span>
        ) : '—'}
      </div>

      {/* Col 5: Next action */}
      <div className="wf__row-action">
        {r.nextAction && <span className="wf__next-action">{r.nextAction}</span>}
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
        {col.items.slice(0, 4).map(r => {
          const days = getDaysLabel(r.dueDate);
          return (
            <div
              key={r._id}
              className="wf__pipe-item"
              onClick={() => navigate(`/legal-requests/${r._id}`)}
            >
              <span className="wf__pipe-ref">{r.requestId}</span>
              <span className="wf__pipe-title">{r.title}</span>
              <div className="wf__pipe-footer">
                {r.assignedTo && (
                  <span className="wf__pipe-avatar">
                    {r.assignedTo.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
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
            onClick={() => navigate(`/legal-requests?status=${col.statuses[0]}`)}
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
  const oldest = b.oldest;
  return (
    <div className="wf__bottleneck" onClick={onClick}>
      <div className="wf__bottleneck-header">
        <span className="wf__bottleneck-label">{b.label}</span>
        <span className="wf__bottleneck-count">{b.count}</span>
      </div>
      <div className="wf__bottleneck-meta">
        <span>Avg wait: <strong>{b.avgWaitDays}d</strong></span>
      </div>
      {oldest && (
        <div className="wf__bottleneck-oldest">
          Oldest: {oldest.title}
        </div>
      )}
    </div>
  );
}

function WorkflowRuleCard({ rule }) {
  return (
    <div className="wf__rule-card" style={{ borderTopColor: rule.color }}>
      <div className="wf__rule-header">
        <span className="wf__rule-icon">{rule.icon}</span>
        <div>
          <h4 className="wf__rule-name">{rule.name}</h4>
          <span className="wf__rule-sla">SLA: {rule.sla}</span>
        </div>
      </div>
      <p className="wf__rule-desc">{rule.description}</p>
      <ol className="wf__rule-steps">
        {rule.steps.map((s, i) => (
          <li key={i} className="wf__rule-step">{s}</li>
        ))}
      </ol>
    </div>
  );
}
