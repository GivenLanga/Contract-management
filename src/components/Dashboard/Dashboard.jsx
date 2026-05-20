import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { LEGAL_FOLDER_UPDATED } from '../../services/legalFolderStore';
import { subscribeToSigning } from '../../services/signingStore';
import { getDashboardData } from '../../services/dashboardSelectors';
import { DASHBOARD_CONTRACT_PIPELINE, formatPortfolioValue } from '../../services/contractPortfolioSelectors';
import Header from '../Layout/Header';
import './Dashboard.css';

const EMPTY_OPERATIONS = {
  activeWorkflows: 0,
  overdueTasks: 0,
  dueToday: 0,
  unassignedTasks: 0,
  trackerTasks: 0,
  trackerWarnings: 0,
  signatureFollowUps: 0,
  workQueueItems: [],
};

const EMPTY_CONTRACT_SUMMARY = {
  totalSignedContracts: 0,
  activeContracts: 0,
  expiringIn30Days: 0,
  contractsWithValue: 0,
  contractsMissingValue: 0,
  portfolioValue: 0,
};

const EMPTY_PIPELINE = {
  active: 0,
  expiringSoon: 0,
  expired: 0,
  unknown: 0,
  items: DASHBOARD_CONTRACT_PIPELINE.map((item) => ({ ...item, count: 0 })),
};

function TaskOpsDashboard({ operations, loading }) {
  const navigate = useNavigate();

  if (loading) return <div className="dashboard__loading">Loading work queue...</div>;

  const stats = operations || EMPTY_OPERATIONS;
  const cardDefs = [
    { key: 'active', label: 'Active Workflows', value: stats.activeWorkflows, color: 'blue', to: '/workflows' },
    { key: 'overdue', label: 'Overdue Tasks', value: stats.overdueTasks, color: 'red', to: '/tasks', urgent: stats.overdueTasks > 0 },
    { key: 'dueToday', label: 'Due Today', value: stats.dueToday, color: 'orange', to: '/tasks' },
    { key: 'unassigned', label: 'Unassigned Tasks', value: stats.unassignedTasks, color: 'amber', to: '/tasks?tab=unassigned', urgent: stats.unassignedTasks > 0 },
    { key: 'tracker', label: 'Tracker Tasks', value: stats.trackerTasks, color: 'teal', to: '/workflows' },
    { key: 'signatures', label: 'Signature Follow-ups', value: stats.signatureFollowUps, color: 'purple', to: '/tasks?tab=signature-follow-ups' },
  ];

  return (
    <div className="dashboard__ops-grid">
      {cardDefs.map((card) => (
        <button
          key={card.key}
          className={`dashboard__ops-card dashboard__ops-card--${card.color}${card.urgent ? ' dashboard__ops-card--urgent' : ''}`}
          onClick={() => navigate(card.to)}
        >
          <span className="dashboard__ops-value">{card.value ?? 0}</span>
          <span className="dashboard__ops-label">{card.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { user, isManager } = useAuth();
  const navigate = useNavigate();
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async ({ showLoading = false } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const data = await getDashboardData({ user, isManager });
      setDashboardData(data);
      if (import.meta.env.DEV) {
        console.info('[Dashboard Diagnostics]', data.diagnostics);
      }
    } catch (error) {
      console.warn('[Dashboard] failed to load current product data', error);
      setDashboardData(null);
    } finally {
      setLoading(false);
    }
  }, [isManager, user]);

  useEffect(() => {
    loadDashboard({ showLoading: true });

    const refresh = () => loadDashboard();
    window.addEventListener(LEGAL_FOLDER_UPDATED, refresh);
    window.addEventListener('storage', refresh);
    const unsubscribeSigning = subscribeToSigning(refresh);

    return () => {
      window.removeEventListener(LEGAL_FOLDER_UPDATED, refresh);
      window.removeEventListener('storage', refresh);
      unsubscribeSigning();
    };
  }, [loadDashboard]);

  const greeting = user?.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Welcome back';
  const today = new Date().toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const operations = dashboardData?.operations || EMPTY_OPERATIONS;
  const contractSummary = dashboardData?.contractSummary || EMPTY_CONTRACT_SUMMARY;
  const contractPipeline = dashboardData?.contractPipeline || EMPTY_PIPELINE;
  const attention = dashboardData?.contractsNeedingAttention || [];
  const pipelineTotal = contractPipeline.items.reduce((sum, item) => sum + item.count, 0);

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
        <div className="dashboard__section-label">Operations Overview</div>

        <TaskOpsDashboard operations={operations} loading={loading} />

        <div className="dashboard__section-label" style={{ marginTop: 8 }}>Contract Portfolio</div>

        <div className="dashboard__kpi-row">
          {[
            { label: 'Total Signed Contracts', value: contractSummary.totalSignedContracts, color: 'blue', onClick: () => navigate('/contracts') },
            { label: 'Active Contracts', value: contractSummary.activeContracts, color: 'green', onClick: () => navigate('/contracts?status=Active') },
            { label: 'Expiring in 30d', value: contractSummary.expiringIn30Days, color: 'orange', onClick: () => navigate('/contracts?status=Expiring%20Soon') },
            {
              label: 'Portfolio Value',
              value: formatPortfolioValue(contractSummary.portfolioValue),
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

        <div className="dashboard__card">
          <div className="dashboard__card-header">
            <h3 className="dashboard__card-title">Contract Pipeline</h3>
            <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
          </div>
          <div className="dashboard__pipeline">
            {contractPipeline.items.map((item) => {
              const pct = pipelineTotal > 0 ? Math.round((item.count / pipelineTotal) * 100) : 0;
              return (
                <div
                  key={item.key}
                  className="dashboard__pipeline-item"
                  onClick={() => navigate(`/contracts?status=${encodeURIComponent(item.status)}`)}
                >
                  <div className="dashboard__pipeline-header">
                    <span className="dashboard__pipeline-label">{item.label}</span>
                    <span className="dashboard__pipeline-count">{item.count}</span>
                  </div>
                  <div className="dashboard__pipeline-track">
                    <div className="dashboard__pipeline-fill" style={{ width: `${pct}%`, background: item.color }} />
                  </div>
                  <span className="dashboard__pipeline-pct">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="dashboard__card">
          <div className="dashboard__card-header">
            <h3 className="dashboard__card-title">Contracts Needing Attention</h3>
            <button className="dashboard__view-all" onClick={() => navigate('/contracts?status=Expiring%20Soon')}>View all</button>
          </div>
          {attention.length > 0 ? (
            <div className="dashboard__attention">
              {attention.map((contract) => (
                <div
                  key={contract.id}
                  className="dashboard__attention-item"
                  onClick={() => navigate(`/contracts/${contract.id}`)}
                >
                  <div className="dashboard__attention-left">
                    <span className="dashboard__attention-title">{contract.title}</span>
                    <span className="dashboard__attention-dept">
                      {[contract.counterparty, contract.type || contract.category].filter(Boolean).join(' - ')}
                    </span>
                  </div>
                  <div className="dashboard__attention-mid">
                    <span className={`dashboard__attention-status dashboard__attention-status--${statusCls(contract.portfolioStatus)}`}>
                      {contract.portfolioStatus}
                    </span>
                    <span className="dashboard__attention-value">{formatContractValue(contract)}</span>
                  </div>
                  <div className="dashboard__attention-right">
                    <span className="dashboard__attention-date">{formatDate(contract.endDate)}</span>
                    <span className="dashboard__attention-days">{daysRemainingLabel(contract.daysRemaining)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="dashboard__empty-state">No signed contracts are expiring soon.</div>
          )}
        </div>

        {import.meta.env.DEV && dashboardData?.diagnostics && (
          <details className="dashboard__diagnostics">
            <summary>Dashboard Diagnostics</summary>
            <pre>{JSON.stringify(dashboardData.diagnostics, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-ZA');
}

function daysRemainingLabel(days) {
  if (days === null || days === undefined) return '—';
  if (days === 0) return 'Due today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

function formatContractValue(contract) {
  if (contract.contractValueDisplay) return contract.contractValueDisplay;
  return Number(contract.value) > 0 ? formatPortfolioValue(contract.value) : '—';
}

function statusCls(status) {
  const map = {
    Active: 'active',
    'Expiring Soon': 'expiring',
    Expired: 'expired',
    Unknown: 'unknown',
  };
  return map[status] || 'default';
}
