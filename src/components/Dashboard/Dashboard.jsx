import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { legalRequests as lrApi, reports as reportsApi } from '../../services/api';
import Header from '../Layout/Header';
import {
  STATUS_LABELS, STATUS_COLORS, HOLDER_LABELS, HOLDER_COLORS,
  PRIORITY_COLORS, REQUEST_TYPE_LABELS, getDaysLabel, formatCurrency,
} from '../LegalRequests/lrHelpers';
import './Dashboard.css';

// ── Manager Dashboard ─────────────────────────────────────────────────────────
function ManagerDashboard({ user }) {
  const navigate = useNavigate();
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    lrApi.managerDashboard()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="dashboard__loading">Loading dashboard…</div>;
  if (!data)   return null;

  const { cards, recentItems } = data;

  const cardDefs = [
    { key: 'overdue',         label: 'Overdue',           value: cards.overdue,         color: 'red',    preset: 'overdue',        urgent: cards.overdue > 0 },
    { key: 'dueToday',        label: 'Due Today',         value: cards.dueToday,        color: 'orange', preset: 'dueToday',       urgent: cards.dueToday > 0 },
    { key: 'dueThisWeek',     label: 'Due This Week',     value: cards.dueThisWeek,     color: 'blue',   preset: 'dueThisWeek' },
    { key: 'unassigned',      label: 'Unassigned',        value: cards.unassigned,      color: 'amber',  preset: 'unassigned',     urgent: cards.unassigned > 0 },
    { key: 'waitingForManager',label:'With Manager',      value: cards.waitingForManager,color:'purple', preset: 'withManager' },
    { key: 'waitingForExternal',label:'With External',    value: cards.waitingForExternal,color:'teal',  preset: 'waitingExternal' },
    { key: 'escalated',       label: 'Escalated',         value: cards.escalated,       color: 'red',    preset: 'overdue' },
    { key: 'noUpdate',        label: 'No Update 7d',      value: cards.noUpdate,        color: 'gray',   preset: 'noUpdate' },
  ];

  return (
    <>
      {/* KPI cards */}
      <div className="dashboard__ops-grid">
        {cardDefs.map(c => (
          <button
            key={c.key}
            className={`dashboard__ops-card dashboard__ops-card--${c.color}${c.urgent ? ' dashboard__ops-card--urgent' : ''}`}
            onClick={() => navigate(`/legal-requests?preset=${c.preset}`)}
          >
            <span className="dashboard__ops-value">{c.value}</span>
            <span className="dashboard__ops-label">{c.label}</span>
          </button>
        ))}
      </div>

      {/* Work queue preview */}
      {recentItems.length > 0 && (
        <div className="dashboard__card">
          <div className="dashboard__card-header">
            <h3 className="dashboard__card-title">Urgent Work Queue</h3>
            <button className="dashboard__view-all" onClick={() => navigate('/legal-requests')}>View all</button>
          </div>
          <div className="dashboard__work-queue">
            {recentItems.slice(0, 10).map(r => <WorkQueueItem key={r._id} request={r} onClick={() => navigate(`/legal-requests/${r._id}`)} />)}
          </div>
        </div>
      )}
    </>
  );
}

// ── Team Member Dashboard ─────────────────────────────────────────────────────
function MemberDashboard({ user }) {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    lrApi.memberDashboard()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="dashboard__loading">Loading your queue…</div>;
  if (!data)   return null;

  const { cards, myItems } = data;

  return (
    <>
      <div className="dashboard__member-grid">
        <MemberStat label="My Tasks"       value={cards.myTasks}          color="blue"   onClick={() => navigate('/legal-requests')} />
        <MemberStat label="Due Today"      value={cards.dueToday}         color="orange" onClick={() => navigate('/legal-requests?preset=dueToday')} />
        <MemberStat label="Due This Week"  value={cards.dueThisWeek}      color="blue"   onClick={() => navigate('/legal-requests?preset=dueThisWeek')} />
        <MemberStat label="Overdue"        value={cards.overdue}          color="red"    onClick={() => navigate('/legal-requests?preset=overdue')} />
        <MemberStat label="Done This Qtr"  value={cards.completedThisQtr} color="green"  />
      </div>

      {myItems.length > 0 && (
        <div className="dashboard__card">
          <div className="dashboard__card-header">
            <h3 className="dashboard__card-title">My Queue</h3>
            <button className="dashboard__view-all" onClick={() => navigate('/legal-requests')}>View all</button>
          </div>
          <div className="dashboard__work-queue">
            {myItems.slice(0, 10).map(r => <WorkQueueItem key={r._id} request={r} onClick={() => navigate(`/legal-requests/${r._id}`)} />)}
          </div>
        </div>
      )}
    </>
  );
}

function MemberStat({ label, value, color, onClick }) {
  return (
    <button
      className={`dashboard__member-stat dashboard__member-stat--${color}`}
      onClick={onClick}
      style={!onClick ? { cursor: 'default' } : {}}
    >
      <span className="dashboard__member-value">{value}</span>
      <span className="dashboard__member-label">{label}</span>
    </button>
  );
}

// ── Work queue item ───────────────────────────────────────────────────────────
function WorkQueueItem({ request: r, onClick }) {
  const days   = getDaysLabel(r.dueDate);
  const stsClr = STATUS_COLORS[r.status] || STATUS_COLORS.SUBMITTED;
  const priClr = PRIORITY_COLORS[r.priority] || PRIORITY_COLORS.MEDIUM;
  const hldClr = HOLDER_COLORS[r.currentHolder] || '#94a3b8';

  return (
    <div className="dashboard__wq-item" onClick={onClick}>
      <div className="dashboard__wq-left">
        <div className="dashboard__wq-badges">
          <span className={`dashboard__wq-track dashboard__wq-track--${r.internalOrExternal?.toLowerCase()}`}>
            {r.internalOrExternal === 'INTERNAL' ? 'INT' : 'EXT'}
          </span>
          <span
            className="dashboard__wq-priority"
            style={{ background: priClr.bg, color: priClr.color }}
          >{r.priority}</span>
        </div>
        <span className="dashboard__wq-title">{r.title}</span>
        {r.nextAction && <span className="dashboard__wq-action">{r.nextAction}</span>}
      </div>

      <div className="dashboard__wq-mid">
        <span
          className="dashboard__wq-status"
          style={{ background: stsClr.bg, color: stsClr.color }}
        >
          {STATUS_LABELS[r.status] || r.status}
        </span>
        <span className="dashboard__wq-holder" style={{ color: hldClr }}>
          {HOLDER_LABELS[r.currentHolder] || r.currentHolder}
        </span>
      </div>

      <div className="dashboard__wq-right">
        {r.assignedTo ? (
          <div className="dashboard__wq-owner">
            <span className="dashboard__wq-avatar">
              {r.assignedTo.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
            </span>
            <span className="dashboard__wq-owner-name">{r.assignedTo.name}</span>
          </div>
        ) : (
          <span className="dashboard__wq-unassigned">Unassigned</span>
        )}
        {days && (
          <span className={`dashboard__wq-days dashboard__wq-days--${days.cls}`}>{days.label}</span>
        )}
      </div>
    </div>
  );
}

// ── Root Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, isManager } = useAuth();
  const navigate = useNavigate();
  const [contractStats, setContractStats] = useState(null);

  useEffect(() => {
    reportsApi.summary().then(setContractStats).catch(() => {});
  }, []);

  const greeting = user?.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Welcome back';
  const today    = new Date().toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="dashboard">
      <Header
        title="Dashboard"
        subtitle={`${greeting} — ${today}`}
        actions={
          <button className="dashboard__submit-btn" onClick={() => navigate('/legal-requests/new')}>
            + New Legal Request
          </button>
        }
      />

      <div className="dashboard__content">
        {/* ── Operational section ── */}
        <div className="dashboard__section-label">
          {isManager ? 'Operations Overview' : 'My Work Queue'}
        </div>

        {isManager
          ? <ManagerDashboard user={user} />
          : <MemberDashboard  user={user} />
        }

        {/* ── Contract portfolio section (real data from reports API) ── */}
        {contractStats && (
          <>
            <div className="dashboard__section-label" style={{ marginTop: 8 }}>Contract Portfolio</div>

            <div className="dashboard__kpi-row">
              {[
                { label: 'Total Contracts', value: contractStats.kpis?.count ?? '—',         color: 'blue',   onClick: () => navigate('/contracts') },
                { label: 'Active',          value: contractStats.kpis?.activeCount ?? '—',    color: 'green',  onClick: () => navigate('/contracts?status=Active') },
                { label: 'Expiring in 30d', value: contractStats.kpis?.expiringIn30 ?? '—',  color: 'orange', onClick: () => navigate('/contracts') },
                { label: 'Portfolio Value', value: contractStats.kpis?.totalValue
                    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(contractStats.kpis.totalValue)
                    : '—',                                                                     color: 'purple' },
              ].map(k => (
                <button
                  key={k.label}
                  className={`dashboard__kpi-card dashboard__kpi-card--${k.color}`}
                  onClick={k.onClick}
                  style={!k.onClick ? { cursor: 'default' } : {}}
                >
                  <span className="dashboard__kpi-val">{k.value}</span>
                  <span className="dashboard__kpi-lbl">{k.label}</span>
                </button>
              ))}
            </div>

            {/* Status breakdown */}
            {contractStats.byStatus?.length > 0 && (
              <div className="dashboard__card">
                <div className="dashboard__card-header">
                  <h3 className="dashboard__card-title">Contract Pipeline</h3>
                  <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
                </div>
                <div className="dashboard__pipeline">
                  {contractStats.byStatus
                    .filter(s => s.count > 0)
                    .slice(0, 6)
                    .map(s => {
                      const total = contractStats.byStatus.reduce((a, b) => a + b.count, 0);
                      const pct   = total > 0 ? Math.round((s.count / total) * 100) : 0;
                      const color = STATUS_PIPE_COLOR[s._id] || '#94a3b8';
                      return (
                        <div
                          key={s._id}
                          className="dashboard__pipeline-item"
                          onClick={() => navigate(`/contracts?status=${encodeURIComponent(s._id)}`)}
                        >
                          <div className="dashboard__pipeline-header">
                            <span className="dashboard__pipeline-label">{s._id}</span>
                            <span className="dashboard__pipeline-count">{s.count}</span>
                          </div>
                          <div className="dashboard__pipeline-track">
                            <div className="dashboard__pipeline-fill" style={{ width: `${pct}%`, background: color }} />
                          </div>
                          <span className="dashboard__pipeline-pct">{pct}%</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Contracts needing attention */}
            {contractStats.attention?.length > 0 && (
              <div className="dashboard__card">
                <div className="dashboard__card-header">
                  <h3 className="dashboard__card-title">Contracts Needing Attention</h3>
                  <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
                </div>
                <div className="dashboard__attention">
                  {contractStats.attention.slice(0, 6).map(c => (
                    <div
                      key={c._id}
                      className="dashboard__attention-item"
                      onClick={() => navigate(`/contracts/${c._id}`)}
                    >
                      <div className="dashboard__attention-left">
                        <span className="dashboard__attention-title">{c.title}</span>
                        <span className="dashboard__attention-dept">{c.department || '—'}</span>
                      </div>
                      <div className="dashboard__attention-right">
                        <span className={`dashboard__attention-status dashboard__attention-status--${statusCls(c.status)}`}>
                          {c.status}
                        </span>
                        {c.endDate && (
                          <span className="dashboard__attention-date">
                            {new Date(c.endDate).toLocaleDateString('en-ZA')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const STATUS_PIPE_COLOR = {
  Active:              '#10b981',
  Draft:               '#94a3b8',
  'Under Review':      '#f59e0b',
  'Pending Approval':  '#f59e0b',
  'Pending Signature': '#8b5cf6',
  Approved:            '#4f8ef7',
  Expired:             '#ef4444',
  Terminated:          '#94a3b8',
};

function statusCls(status) {
  const map = {
    Active: 'active', Draft: 'draft', Expired: 'expired',
    'Pending Signature': 'pending', 'Pending Approval': 'pending',
  };
  return map[status] || 'default';
}
