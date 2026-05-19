import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { tasks as tasksApi, reports as reportsApi } from '../../services/api';
import { getDaysLabel } from '../../services/dateDisplay';
import Header from '../Layout/Header';
import './Dashboard.css';

const SOURCE_LABELS = {
  LEGAL_TRACKER: 'Tracker',
  MANUAL_WORKFLOW: 'Manual workflow',
  SIGNATURE_FOLLOW_UP: 'Signature follow-up',
  DOCUMENT_REVIEW: 'Document review',
  GENERAL: 'General',
  LEGAL_REQUEST: 'Legacy work item',
};

function TaskOpsDashboard({ user, isManager }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, taskData] = await Promise.all([
        tasksApi.stats(),
        tasksApi.list(isManager ? { limit: 10 } : { assignedTo: user._id, limit: 10 }),
      ]);
      setStats(statsData || {});
      setItems((taskData?.tasks || []).filter((t) => !['Completed', 'Cancelled'].includes(t.status)));
    } catch {
      setStats(null);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [isManager, user._id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="dashboard__loading">Loading work queue...</div>;
  if (!stats) return null;

  const cardDefs = isManager
    ? [
        { key: 'active', label: 'Active Workflows', value: stats.openTasks, color: 'blue', to: '/workflows' },
        { key: 'overdue', label: 'Overdue Tasks', value: stats.teamOverdue, color: 'red', to: '/tasks', urgent: stats.teamOverdue > 0 },
        { key: 'dueToday', label: 'Due Today', value: stats.teamDueToday, color: 'orange', to: '/tasks' },
        { key: 'unassigned', label: 'Unassigned Tasks', value: stats.unassignedTasks, color: 'amber', to: '/tasks', urgent: stats.unassignedTasks > 0 },
        { key: 'tracker', label: 'Tracker Tasks', value: stats.trackerBackedTasks, color: 'teal', to: '/workflows' },
        { key: 'signatures', label: 'Sig. Follow-ups', value: stats.signatureFollowups, color: 'purple', to: '/tasks' },
      ]
    : [
        { key: 'mine', label: 'My Open Tasks', value: stats.myOpenTasks, color: 'blue', to: '/tasks' },
        { key: 'dueToday', label: 'Due Today', value: stats.myDueToday, color: 'orange', to: '/tasks' },
        { key: 'overdue', label: 'Overdue', value: stats.myOverdue, color: 'red', to: '/tasks', urgent: stats.myOverdue > 0 },
        { key: 'signatures', label: 'Sig. Follow-ups', value: stats.mySignatureFollowups, color: 'teal', to: '/tasks' },
        { key: 'done', label: 'Done This Week', value: stats.completedThisWeek, color: 'green' },
      ];

  return (
    <>
      <div className={isManager ? 'dashboard__ops-grid' : 'dashboard__member-grid'}>
        {cardDefs.map((card) => (
          <button
            key={card.key}
            className={
              isManager
                ? `dashboard__ops-card dashboard__ops-card--${card.color}${card.urgent ? ' dashboard__ops-card--urgent' : ''}`
                : `dashboard__member-stat dashboard__member-stat--${card.color}`
            }
            onClick={card.to ? () => navigate(card.to) : undefined}
            style={!card.to ? { cursor: 'default' } : undefined}
          >
            <span className={isManager ? 'dashboard__ops-value' : 'dashboard__member-value'}>{card.value ?? 0}</span>
            <span className={isManager ? 'dashboard__ops-label' : 'dashboard__member-label'}>{card.label}</span>
          </button>
        ))}
      </div>

      {items.length > 0 && (
        <div className="dashboard__card">
          <div className="dashboard__card-header">
            <h3 className="dashboard__card-title">{isManager ? 'Team Work Queue' : 'My Work Queue'}</h3>
            <button className="dashboard__view-all" onClick={() => navigate('/tasks')}>View all</button>
          </div>
          <div className="dashboard__work-queue">
            {items.slice(0, 10).map((task) => (
              <WorkQueueItem key={task._id} task={task} onClick={() => navigate('/tasks')} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function WorkQueueItem({ task, onClick }) {
  const days = getDaysLabel(task.deadline);
  const meta = task.trackerMeta || {};
  const source = SOURCE_LABELS[task.sourceType] || 'Task';

  return (
    <div className="dashboard__wq-item" onClick={onClick}>
      <div className="dashboard__wq-left">
        <div className="dashboard__wq-badges">
          <span className="dashboard__wq-track">{source}</span>
          <span className="dashboard__wq-priority">{task.priority || 'Medium'}</span>
        </div>
        <span className="dashboard__wq-title">{task.title}</span>
        {(meta.legalTrackerId || meta.parties || task.progressNote) && (
          <span className="dashboard__wq-action">
            {[meta.legalTrackerId, meta.parties, task.progressNote].filter(Boolean).join(' - ')}
          </span>
        )}
      </div>

      <div className="dashboard__wq-mid">
        <span className="dashboard__wq-status">{task.status}</span>
        <span className="dashboard__wq-holder">{task.type?.replace(/_/g, ' ') || 'Task'}</span>
      </div>

      <div className="dashboard__wq-right">
        {task.assignedTo ? (
          <div className="dashboard__wq-owner">
            <span className="dashboard__wq-avatar">
              {task.assignedTo.name?.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
            </span>
            <span className="dashboard__wq-owner-name">{task.assignedTo.name}</span>
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

export default function Dashboard() {
  const { user, isManager } = useAuth();
  const navigate = useNavigate();
  const [contractStats, setContractStats] = useState(null);

  useEffect(() => {
    reportsApi.summary().then(setContractStats).catch(() => {});
  }, []);

  const greeting = user?.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Welcome back';
  const today = new Date().toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="dashboard">
      <Header
        title="Dashboard"
        subtitle={`${greeting} - ${today}`}
        actions={
          <button className="dashboard__submit-btn" onClick={() => navigate('/workflows')}>
            Open Workflows
          </button>
        }
      />

      <div className="dashboard__content">
        <div className="dashboard__section-label">
          {isManager ? 'Operations Overview' : 'My Work Queue'}
        </div>

        <TaskOpsDashboard user={user} isManager={isManager} />

        {contractStats && (
          <>
            <div className="dashboard__section-label" style={{ marginTop: 8 }}>Contract Portfolio</div>

            <div className="dashboard__kpi-row">
              {[
                { label: 'Total Contracts', value: contractStats.kpis?.count ?? '-', color: 'blue', onClick: () => navigate('/contracts') },
                { label: 'Active', value: contractStats.kpis?.activeCount ?? '-', color: 'green', onClick: () => navigate('/contracts?status=Active') },
                { label: 'Expiring in 30d', value: contractStats.kpis?.expiringIn30 ?? '-', color: 'orange', onClick: () => navigate('/contracts') },
                {
                  label: 'Portfolio Value',
                  value: contractStats.kpis?.totalValue
                    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(contractStats.kpis.totalValue)
                    : '-',
                  color: 'purple',
                },
              ].map((k) => (
                <button
                  key={k.label}
                  className={`dashboard__kpi-card dashboard__kpi-card--${k.color}`}
                  onClick={k.onClick}
                  style={!k.onClick ? { cursor: 'default' } : undefined}
                >
                  <span className="dashboard__kpi-val">{k.value}</span>
                  <span className="dashboard__kpi-lbl">{k.label}</span>
                </button>
              ))}
            </div>

            {contractStats.byStatus?.length > 0 && (
              <div className="dashboard__card">
                <div className="dashboard__card-header">
                  <h3 className="dashboard__card-title">Contract Pipeline</h3>
                  <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
                </div>
                <div className="dashboard__pipeline">
                  {contractStats.byStatus
                    .filter((s) => s.count > 0)
                    .slice(0, 6)
                    .map((s) => {
                      const total = contractStats.byStatus.reduce((a, b) => a + b.count, 0);
                      const pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
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

            {contractStats.attention?.length > 0 && (
              <div className="dashboard__card">
                <div className="dashboard__card-header">
                  <h3 className="dashboard__card-title">Contracts Needing Attention</h3>
                  <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
                </div>
                <div className="dashboard__attention">
                  {contractStats.attention.slice(0, 6).map((c) => (
                    <div
                      key={c._id}
                      className="dashboard__attention-item"
                      onClick={() => navigate(`/contracts/${c._id}`)}
                    >
                      <div className="dashboard__attention-left">
                        <span className="dashboard__attention-title">{c.title}</span>
                        <span className="dashboard__attention-dept">{c.department || '-'}</span>
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
  Active: '#10b981',
  Draft: '#94a3b8',
  'Under Review': '#f59e0b',
  'Pending Approval': '#f59e0b',
  'Pending Signature': '#8b5cf6',
  Approved: '#4f8ef7',
  Expired: '#ef4444',
  Terminated: '#94a3b8',
};

function statusCls(status) {
  const map = {
    Active: 'active',
    Draft: 'draft',
    Expired: 'expired',
    'Pending Signature': 'pending',
    'Pending Approval': 'pending',
  };
  return map[status] || 'default';
}
