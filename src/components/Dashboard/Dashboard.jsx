import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';
import Header from '../Layout/Header';
import StatCard from '../common/StatCard';
import Badge from '../common/Badge';
import { kpiData, activities, upcomingRenewals, monthlyData, contractsByType } from '../../data/mockData';
import './Dashboard.css';

const PIE_COLORS = ['#4f8ef7', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316'];

const activityIcons = {
  signature: '✍️',
  review: '🔍',
  create: '📄',
  alert: '⚠️',
  execute: '✅',
  expiry: '⏰',
};

export default function Dashboard() {
  const navigate = useNavigate();

  const formatCurrency = (v) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

  return (
    <div className="dashboard">
      <Header
        title="Dashboard"
        subtitle={`Welcome back, Sarah — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`}
      />

      <div className="dashboard__content">
        {/* KPI Row */}
        <div className="dashboard__kpi-row">
          <StatCard
            label="Total Contracts"
            value={kpiData.totalContracts}
            icon="📄"
            color="blue"
            sub="All contract records"
            trend={12}
            onClick={() => navigate('/contracts')}
          />
          <StatCard
            label="Active Contracts"
            value={kpiData.activeContracts}
            icon="✅"
            color="green"
            sub="Currently in force"
            trend={8}
            onClick={() => navigate('/contracts?status=Active')}
          />
          <StatCard
            label="Pending Approval"
            value={kpiData.pendingApproval}
            icon="⏳"
            color="orange"
            sub="Awaiting sign-off"
            onClick={() => navigate('/contracts?status=Under+Review')}
          />
          <StatCard
            label="Total Contract Value"
            value={formatCurrency(kpiData.totalValue)}
            icon="💰"
            color="purple"
            sub="Across all active agreements"
            trend={5}
          />
          <StatCard
            label="Avg. Cycle Time"
            value={`${kpiData.avgCycleTime}d`}
            icon="⏱"
            color="blue"
            sub="Draft to execution"
            trend={-15}
          />
          <StatCard
            label="Renewals This Quarter"
            value={kpiData.renewalsThisQuarter}
            icon="🔄"
            color="orange"
            sub="Upcoming in 90 days"
          />
        </div>

        {/* Charts Row */}
        <div className="dashboard__charts-row">
          <div className="dashboard__card dashboard__card--chart">
            <div className="dashboard__card-header">
              <h3 className="dashboard__card-title">Contract Activity</h3>
              <span className="dashboard__card-sub">Last 6 months</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }}
                  cursor={{ fill: 'rgba(79,142,247,0.05)' }}
                />
                <Bar dataKey="created" name="Created" fill="#4f8ef7" radius={[4,4,0,0]} />
                <Bar dataKey="executed" name="Executed" fill="#10b981" radius={[4,4,0,0]} />
                <Bar dataKey="expired" name="Expired" fill="#ef4444" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="dashboard__card dashboard__card--chart">
            <div className="dashboard__card-header">
              <h3 className="dashboard__card-title">Contracts by Type</h3>
              <span className="dashboard__card-sub">Volume distribution</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={contractsByType}
                  dataKey="count"
                  nameKey="type"
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={3}
                >
                  {contractsByType.map((entry, index) => (
                    <Cell key={entry.type} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Bottom Row */}
        <div className="dashboard__bottom-row">
          {/* Upcoming Renewals */}
          <div className="dashboard__card">
            <div className="dashboard__card-header">
              <h3 className="dashboard__card-title">Upcoming Renewals</h3>
              <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
            </div>
            <div className="dashboard__renewals">
              {upcomingRenewals.map((r) => (
                <div
                  key={r.id}
                  className="dashboard__renewal-item"
                  onClick={() => navigate(`/contracts/${r.id}`)}
                >
                  <div className="dashboard__renewal-info">
                    <span className="dashboard__renewal-title">{r.title}</span>
                    <span className="dashboard__renewal-date">Renewal: {r.date}</span>
                  </div>
                  <div className="dashboard__renewal-right">
                    <span className={`dashboard__renewal-days dashboard__renewal-days--${r.risk}`}>
                      {r.daysLeft}d
                    </span>
                    <Badge status={r.risk === 'medium' ? 'Medium' : 'Low'} size="sm" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="dashboard__card">
            <div className="dashboard__card-header">
              <h3 className="dashboard__card-title">Recent Activity</h3>
              <button className="dashboard__view-all" onClick={() => navigate('/contracts')}>View all</button>
            </div>
            <div className="dashboard__activity">
              {activities.map((a) => (
                <div
                  key={a.id}
                  className="dashboard__activity-item"
                  onClick={() => navigate(`/contracts/${a.contractId}`)}
                >
                  <span className="dashboard__activity-icon">{activityIcons[a.type]}</span>
                  <div className="dashboard__activity-info">
                    <span className="dashboard__activity-text">{a.action}</span>
                    <span className="dashboard__activity-meta">{a.user} · {a.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Status Breakdown */}
        <div className="dashboard__card dashboard__status-bar-card">
          <div className="dashboard__card-header">
            <h3 className="dashboard__card-title">Contract Pipeline</h3>
            <span className="dashboard__card-sub">Current distribution by status</span>
          </div>
          <div className="dashboard__pipeline">
            {[
              { label: 'Draft', count: 1, color: '#94a3b8', pct: 12.5 },
              { label: 'Under Review', count: 2, color: '#f59e0b', pct: 25 },
              { label: 'Pending Signature', count: 1, color: '#8b5cf6', pct: 12.5 },
              { label: 'Active', count: 4, color: '#10b981', pct: 50 },
            ].map((s) => (
              <div key={s.label} className="dashboard__pipeline-item" onClick={() => navigate(`/contracts?status=${encodeURIComponent(s.label)}`)}>
                <div className="dashboard__pipeline-header">
                  <span className="dashboard__pipeline-label">{s.label}</span>
                  <span className="dashboard__pipeline-count">{s.count}</span>
                </div>
                <div className="dashboard__pipeline-track">
                  <div
                    className="dashboard__pipeline-fill"
                    style={{ width: `${s.pct}%`, background: s.color }}
                  />
                </div>
                <span className="dashboard__pipeline-pct">{s.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
