import { useState, useEffect, useMemo, useCallback } from 'react';
import Header from '../Layout/Header';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell, Area, AreaChart, ReferenceLine,
} from 'recharts';
import { contracts as contractsApi, reports as reportsApi } from '../../services/api';
import './Reports.css';

// ─── Constants ───────────────────────────────────────────────────────────────
const COLORS = ['#4f8ef7','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#f97316'];
const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PERIOD_DAYS = { last30: 30, last90: 90, last6m: 180, thisYear: 365 };
const STATUS_COLOR = {
  Active: '#10b981', Draft: '#94a3b8', 'Under Review': '#f59e0b',
  'Pending Signature': '#8b5cf6', 'Pending Approval': '#3b82f6',
  Approved: '#10b981', Expired: '#ef4444', Terminated: '#6b7280',
};
const DATE_OPTIONS = [
  { key: 'last30',   label: 'Last 30 days' },
  { key: 'last90',   label: 'Last 90 days' },
  { key: 'last6m',   label: 'Last 6 months' },
  { key: 'thisYear', label: 'This year' },
];

// ─── Icons ───────────────────────────────────────────────────────────────────
function IconCurrency() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v2m0 8v2M9.5 10h3a1.5 1.5 0 0 1 0 3h-2a1.5 1.5 0 0 0 0 3H14" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt$ = (v) => {
  if (!v) return 'R0';
  if (v >= 1e6) return `R${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `R${Math.round(v / 1e3)}K`;
  return `R${v.toLocaleString()}`;
};
const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  : '—';
const pctChange = (a, b) => b > 0 ? +((a - b) / b * 100).toFixed(1) : null;

// ─── Client-side derivation (runs on filtered contract list) ─────────────────
function deriveFromContracts(all) {
  const now = new Date();

  // Status distribution
  const byStatus = Object.entries(
    all.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {})
  ).map(([name, value]) => ({ name, value, color: STATUS_COLOR[name] || '#94a3b8' }))
   .sort((a, b) => b.value - a.value);

  // Type distribution
  const byType = Object.entries(
    all.reduce((acc, c) => {
      if (!acc[c.type]) acc[c.type] = { count: 0, value: 0 };
      acc[c.type].count++;
      acc[c.type].value += c.value || 0;
      return acc;
    }, {})
  ).map(([type, d]) => ({ type, ...d })).sort((a, b) => b.count - a.count);

  // Value by department
  const byDept = Object.entries(
    all.filter(c => c.department).reduce((acc, c) => {
      acc[c.department] = (acc[c.department] || 0) + (c.value || 0);
      return acc;
    }, {})
  ).map(([dept, value]) => ({ dept, value })).sort((a, b) => b.value - a.value);

  // Monthly activity (last 6 months from contract data)
  const slots = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    slots[`${d.getFullYear()}-${d.getMonth()}`] = { month: MONTHS[d.getMonth()], created: 0, executed: 0, expired: 0 };
  }
  for (const c of all) {
    const d = new Date(c.createdAt || c.updatedAt);
    const k = `${d.getFullYear()}-${d.getMonth()}`;
    if (slots[k]) {
      slots[k].created++;
      if (c.status === 'Active') slots[k].executed++;
      if (c.status === 'Expired') slots[k].expired++;
    }
  }
  const monthly = Object.values(slots);

  // Cycle time per type
  const cycleByType = Object.entries(
    all.filter(c => c.startDate && c.createdAt && new Date(c.startDate) > new Date(c.createdAt)).reduce((acc, c) => {
      if (!acc[c.type]) acc[c.type] = { total: 0, n: 0 };
      acc[c.type].total += (new Date(c.startDate) - new Date(c.createdAt)) / 86400000;
      acc[c.type].n++;
      return acc;
    }, {})
  ).map(([type, { total, n }]) => ({ type, days: Math.round(total / n) }))
   .sort((a, b) => a.days - b.days);

  // Renewal trend (last 6 months by renewalDate)
  const renewSlots = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    renewSlots[`${d.getFullYear()}-${d.getMonth()}`] = { month: MONTHS[d.getMonth()], onTime: 0, missed: 0 };
  }
  for (const c of all) {
    if (!c.renewalDate) continue;
    const rd = new Date(c.renewalDate);
    const k = `${rd.getFullYear()}-${rd.getMonth()}`;
    if (renewSlots[k]) {
      if (c.status === 'Active') renewSlots[k].onTime++;
      else if (c.status === 'Expired') renewSlots[k].missed++;
    }
  }
  const renewalTrend = Object.values(renewSlots);

  // Avg cycle time across all
  const withCycle = all.filter(c => c.startDate && c.createdAt && new Date(c.startDate) > new Date(c.createdAt));
  const avgCycle = withCycle.length
    ? Math.round(withCycle.reduce((s, c) => s + (new Date(c.startDate) - new Date(c.createdAt)) / 86400000, 0) / withCycle.length)
    : 0;

  // Compliance
  const pendingApproval = all.filter(c =>
    c.status === 'Pending Approval' || c.approvers?.some(a => a.status === 'Pending')
  );
  const pendingSig     = all.filter(c => c.status === 'Pending Signature');
  const expiredContracts = all.filter(c => c.status === 'Expired');
  const compSeen = new Set();
  const compIssues = [...pendingApproval, ...pendingSig].filter(c => {
    const id = (c._id || c.id)?.toString();
    if (compSeen.has(id)) return false;
    compSeen.add(id);
    return true;
  });
  const compScore      = all.length ? Math.round(((all.length - compIssues.length) / all.length) * 100) : 100;
  const compBreakdown  = [
    { issue: 'Missing approvals',  count: pendingApproval.length },
    { issue: 'Pending signatures', count: pendingSig.length },
    { issue: 'Expired contracts',  count: expiredContracts.length },
    { issue: 'Rejected approvals', count: all.filter(c => c.approvers?.some(a => a.status === 'Rejected')).length },
  ].filter(i => i.count > 0);

  // Renewal rate
  const renewable  = all.filter(c => c.renewalDate && new Date(c.renewalDate) < now);
  const renewedOk  = renewable.filter(c => c.status === 'Active');
  const renewRate  = renewable.length ? Math.round((renewedOk.length / renewable.length) * 100) : null;

  // Expiry
  const in30 = new Date(now.getTime() + 30 * 86400000);
  const in90 = new Date(now.getTime() + 90 * 86400000);
  const expiring = (by) => all.filter(c => {
    const d = c.endDate || c.expiryDate;
    if (!d) return false;
    const exp = new Date(d);
    return exp >= now && exp <= by && !['Terminated','Cancelled','Expired'].includes(c.status);
  });
  const exp30 = expiring(in30);
  const exp90 = expiring(in90);
  const autoRenew = all.filter(c => c.autoRenew && expiring(in90).includes(c));

  // Attention table (deduplicated)
  const seen = new Set();
  const attention = [
    ...exp30.map(c => ({
      contract: c.title, owner: c.createdBy?.name || '—',
      issue: `Expiring in ${Math.ceil((new Date(c.endDate || c.expiryDate) - now) / 86400000)} days`,
      dueDate: fmtDate(c.endDate || c.expiryDate), priority: c.priority || 'Medium',
    })),
    ...pendingSig.map(c => ({
      contract: c.title, owner: c.createdBy?.name || '—',
      issue: 'Awaiting signature', dueDate: fmtDate(c.endDate), priority: c.priority || 'Medium',
    })),
    ...pendingApproval.map(c => ({
      contract: c.title, owner: c.createdBy?.name || '—',
      issue: 'Pending approval', dueDate: fmtDate(c.endDate), priority: c.priority || 'Medium',
    })),
  ].filter(item => { const ok = !seen.has(item.contract); seen.add(item.contract); return ok; })
   .slice(0, 8);

  // Risk
  const byRisk = [
    { level: 'Low',      cls: 'green',    count: all.filter(c => c.priority === 'Low').length },
    { level: 'Medium',   cls: 'amber',    count: all.filter(c => c.priority === 'Medium').length },
    { level: 'High',     cls: 'red',      count: all.filter(c => c.priority === 'High').length },
    { level: 'Critical', cls: 'critical', count: all.filter(c => c.priority === 'Critical').length },
  ];
  const highRisk = all
    .filter(c => c.priority === 'High' || c.priority === 'Critical')
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 5)
    .map(c => ({ contract: c.title, risk: c.priority, status: c.status, value: fmt$(c.value || 0) }));

  // Financial exposure
  const sum = (arr, fn) => arr.reduce((s, c) => s + (fn(c) || 0), 0);
  const activeVal   = sum(all.filter(c => c.status === 'Active'), c => c.value);
  const exp90Val    = sum(exp90, c => c.value);
  const highRiskVal = sum(all.filter(c => c.priority === 'High' || c.priority === 'Critical'), c => c.value);
  const pendingVal  = sum(pendingApproval, c => c.value);
  const unsignedVal = sum(pendingSig, c => c.value);

  // Dynamic insights
  const insights = [];
  if (exp30.length)         insights.push(`${exp30.length} contract${exp30.length !== 1 ? 's' : ''} expire within the next 30 days.`);
  if (highRisk.length)      insights.push(`${highRisk.length} high-risk contract${highRisk.length !== 1 ? 's' : ''} require attention.`);
  if (byDept[0])            insights.push(`${byDept[0].dept} holds the highest contract value at ${fmt$(byDept[0].value)}.`);
  if (avgCycle > 0)         insights.push(`Average contract cycle time is ${avgCycle} days from draft to execution.`);
  if (compScore < 90)       insights.push(`Compliance health at ${compScore}% — ${compIssues.length} issue${compIssues.length !== 1 ? 's' : ''} need resolution.`);
  if (autoRenew.length)     insights.push(`${autoRenew.length} contract${autoRenew.length !== 1 ? 's' : ''} set to auto-renew within 90 days.`);
  if (renewRate !== null)   insights.push(`Renewal rate is ${renewRate}%${renewRate >= 80 ? ' — on target.' : ' — below 80% target.'}`);

  return {
    byStatus, byType, byDept, monthly, renewalTrend, cycleByType,
    avgCycle, cycleCount: withCycle.length,
    compScore, compBreakdown,
    renewRate, renewableCount: renewable.length,
    exp30: exp30.length, exp90: exp90.length, autoRenew: autoRenew.length,
    attention, byRisk, highRisk,
    activeVal, exp90Val, highRiskVal, pendingVal, unsignedVal,
    insights: insights.slice(0, 6),
    total: all.length,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="reports__content">
      <div className="reports__sk-bar" />
      <div className="reports__kpi-row">
        {[0,1,2,3].map(i => <div key={i} className="reports__sk-kpi reports__sk-pulse" />)}
      </div>
      <div className="reports__sk-row">
        <div className="reports__sk-chart reports__sk-pulse" />
        <div className="reports__sk-chart reports__sk-pulse" />
      </div>
      <div className="reports__sk-row">
        <div className="reports__sk-chart reports__sk-pulse" />
        <div className="reports__sk-chart reports__sk-pulse" />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="reports__error-wrap">
      <div className="reports__error">
        <span className="reports__error-icon">⚠️</span>
        <p>{message || 'Failed to load report data.'}</p>
        <button className="reports__error-retry" onClick={onRetry}>Retry</button>
      </div>
    </div>
  );
}

function PriorityBadge({ value }) {
  return <span className={`reports__priority reports__priority--${(value || 'medium').toLowerCase()}`}>{value || 'Medium'}</span>;
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Reports() {
  // ── Data ──
  const [raw,     setRaw]     = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [retryKey, setRetryKey] = useState(0);

  // ── Filters ──
  const [dateRange,   setDateRange]   = useState('last6m');
  const [dept,        setDept]        = useState('');
  const [type,        setType]        = useState('');
  const [statusF,     setStatusF]     = useState('');
  const [owner,       setOwner]       = useState('');
  const [risk,        setRisk]        = useState('');
  const [showComp,    setShowComp]    = useState(false);

  const retry = useCallback(() => { setRetryKey(k => k + 1); setError(null); }, []);

  // ── Fetch ──
  useEffect(() => {
    setLoading(true);
    Promise.all([
      contractsApi.list({ limit: 2000 }),
      reportsApi.summary({ period: dateRange }),
    ])
      .then(([cData, sData]) => {
        setRaw(cData?.contracts || []);
        setSummary(sData || null);
        setError(null);
      })
      .catch(err => setError(err.message || 'Failed to load report data.'))
      .finally(() => setLoading(false));
  }, [retryKey, dateRange]);

  // ── Filter options from real data ──
  const filterOpts = useMemo(() => ({
    depts:    [...new Set(raw.map(c => c.department).filter(Boolean))].sort(),
    types:    [...new Set(raw.map(c => c.type).filter(Boolean))].sort(),
    statuses: [...new Set(raw.map(c => c.status).filter(Boolean))].sort(),
    owners:   [...new Set(raw.map(c => c.createdBy?.name).filter(Boolean))].sort(),
  }), [raw]);

  // ── Apply filters ──
  const filtered = useMemo(() => {
    const now = new Date();
    const days = PERIOD_DAYS[dateRange] || 180;
    const since = new Date(now.getTime() - days * 86400000);
    return raw.filter(c => {
      const created = new Date(c.createdAt || c.updatedAt);
      if (created < since) return false;
      if (dept    && c.department      !== dept)    return false;
      if (type    && c.type            !== type)    return false;
      if (statusF && c.status          !== statusF) return false;
      if (owner   && c.createdBy?.name !== owner)   return false;
      if (risk    && c.priority        !== risk)    return false;
      return true;
    });
  }, [raw, dateRange, dept, type, statusF, owner, risk]);

  // Previous period for trend comparison
  const prevPeriodTotal = useMemo(() => {
    // Prefer server-computed value (more accurate with larger datasets)
    if (summary?.kpis?.prevTotalValue !== undefined) return summary.kpis.prevTotalValue;
    const now = new Date();
    const days = PERIOD_DAYS[dateRange] || 180;
    const periStart = new Date(now.getTime() - days * 86400000);
    const prevStart = new Date(now.getTime() - days * 2 * 86400000);
    return raw
      .filter(c => { const d = new Date(c.createdAt || c.updatedAt); return d >= prevStart && d < periStart; })
      .reduce((s, c) => s + (c.value || 0), 0);
  }, [raw, dateRange, summary]);

  // ── Derived metrics ──
  const m = useMemo(() => deriveFromContracts(filtered), [filtered]);

  // ── Computed KPI values ──
  const totalVal  = useMemo(() => filtered.reduce((s, c) => s + (c.value || 0), 0), [filtered]);
  const valTrend  = pctChange(totalVal, prevPeriodTotal);
  const periodLabel = DATE_OPTIONS.find(o => o.key === dateRange)?.label ?? 'Last 6 months';

  const kpiCards = useMemo(() => [
    {
      label: 'Total Contract Value', value: fmt$(totalVal),
      sub: `${filtered.length} contract${filtered.length !== 1 ? 's' : ''} in period`,
      icon: <IconCurrency />, color: 'blue',
      trend: valTrend !== null
        ? `${valTrend >= 0 ? '↑' : '↓'} ${Math.abs(valTrend)}% vs previous period`
        : 'First period tracked',
      trendUp: valTrend !== null ? valTrend >= 0 : null,
    },
    {
      label: 'Avg. Cycle Time',
      value: m.avgCycle > 0 ? `${m.avgCycle} days` : '—',
      sub: m.cycleCount > 0 ? `Based on ${m.cycleCount} contracts` : 'No executed contracts yet',
      icon: <IconClock />, color: 'purple',
      trend: m.avgCycle > 0 ? (m.avgCycle <= 14 ? '✓ Within 14-day target' : `${m.avgCycle - 14} days over target`) : 'No data',
      trendUp: m.avgCycle > 0 ? m.avgCycle <= 14 : null,
    },
    {
      label: 'Renewal Rate',
      value: m.renewRate !== null ? `${m.renewRate}%` : '—',
      sub: m.renewableCount > 0 ? `${m.renewableCount} renewals tracked` : 'No renewals due yet',
      icon: <IconRefresh />, color: 'green',
      trend: m.renewRate !== null ? (m.renewRate >= 80 ? '✓ On target (≥80%)' : 'Below 80% target') : 'Insufficient data',
      trendUp: m.renewRate !== null ? m.renewRate >= 80 : null,
    },
    {
      label: 'Compliance Health', value: `${m.compScore}%`,
      sub: m.compBreakdown.reduce((s, i) => s + i.count, 0) + ' issues found',
      icon: m.compScore >= 90 ? <IconCheck /> : <IconAlert />, color: m.compScore >= 80 ? 'green' : 'amber',
      trend: m.compScore >= 90 ? 'Healthy' : m.compScore >= 70 ? 'Needs attention' : 'At risk',
      trendUp: m.compScore >= 80, isCompliance: true,
    },
  ], [totalVal, filtered.length, valTrend, m]);

  const formatCurrency = (v) =>
    new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', notation: 'compact', maximumFractionDigits: 0 }).format(v);

  const statusTotal = useMemo(() => m.byStatus.reduce((s, d) => s + d.value, 0), [m.byStatus]);

  // ── Loading / Error ──
  if (loading) return (
    <div className="reports">
      <Header title="Reports & Analytics" subtitle="Contract performance insights and metrics" />
      <Skeleton />
    </div>
  );
  if (error) return (
    <div className="reports">
      <Header title="Reports & Analytics" subtitle="Contract performance insights and metrics" />
      <ErrorState message={error} onRetry={retry} />
    </div>
  );

  return (
    <div className="reports">
      <Header title="Reports & Analytics" subtitle="Contract performance insights and metrics" />

      <div className="reports__content">

        {/* ── Global Filter Bar ── */}
        <div className="reports__filter-bar">
          <div className="reports__filter-top">
            <div className="reports__date-pills">
              <span className="reports__filter-label">Date Range:</span>
              {DATE_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  className={`reports__date-pill${dateRange === opt.key ? ' reports__date-pill--active' : ''}`}
                  onClick={() => setDateRange(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="reports__filter-dropdowns">
            {[
              { label: 'Department',    value: dept,    set: setDept,    opts: filterOpts.depts },
              { label: 'Contract Type', value: type,    set: setType,    opts: filterOpts.types },
              { label: 'Status',        value: statusF, set: setStatusF, opts: filterOpts.statuses },
              { label: 'Owner',         value: owner,   set: setOwner,   opts: filterOpts.owners },
              { label: 'Risk Level',    value: risk,    set: setRisk,    opts: ['Low','Medium','High','Critical'] },
            ].map(f => (
              <div key={f.label} className="reports__filter-group">
                <span className="reports__filter-label">{f.label}:</span>
                <select
                  className={`reports__filter-select${f.value ? ' reports__filter-select--active' : ''}`}
                  value={f.value}
                  onChange={e => f.set(e.target.value)}
                >
                  <option value="">All</option>
                  {f.opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            ))}
            {(dept || type || statusF || owner || risk) && (
              <button
                className="reports__filter-clear"
                onClick={() => { setDept(''); setType(''); setStatusF(''); setOwner(''); setRisk(''); }}
              >
                ✕ Clear filters
              </button>
            )}
          </div>
        </div>

        {raw.length >= 2000 && (
          <div className="reports__truncation-warning">
            Showing the most recent 2,000 contracts. Some aggregate figures may not reflect your full portfolio.
          </div>
        )}

        {/* ── Key Insights (data-driven) ── */}
        {m.insights.length > 0 && (
          <div className="reports__insights-bar">
            <div className="reports__insights-heading">Key Insights</div>
            <div className="reports__insights-list">
              {m.insights.map((insight, i) => (
                <div key={i} className="reports__insight-item">
                  <span className="reports__insight-num">{i + 1}</span>
                  {insight}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── KPI Cards ── */}
        <div className="reports__kpi-row">
          {kpiCards.map(k => (
            <div
              key={k.label}
              className={`reports__kpi reports__kpi--${k.color}${k.isCompliance ? ' reports__kpi--clickable' : ''}`}
              onClick={k.isCompliance ? () => setShowComp(true) : undefined}
              title={k.isCompliance ? 'Click for compliance breakdown' : undefined}
            >
              <div className="reports__kpi-icon">{k.icon}</div>
              <div className="reports__kpi-body">
                <div className="reports__kpi-value">{k.value}</div>
                <div className="reports__kpi-label">{k.label}</div>
                <div className="reports__kpi-sub">{k.sub}</div>
                {k.trend && (
                  <div className={`reports__kpi-trend${k.trendUp === true ? ' reports__kpi-trend--up' : k.trendUp === false ? ' reports__kpi-trend--down' : ''}`}>
                    {k.trend}
                  </div>
                )}
              </div>
              {k.isCompliance && <span className="reports__kpi-expand">Details ›</span>}
            </div>
          ))}
        </div>

        {/* ── Compliance Modal ── */}
        {showComp && (
          <div className="reports__overlay" onClick={() => setShowComp(false)}>
            <div className="reports__compliance-modal" onClick={e => e.stopPropagation()}>
              <div className="reports__compliance-header">
                <h3>Compliance Health Breakdown</h3>
                <button className="reports__modal-close" onClick={() => setShowComp(false)}>✕</button>
              </div>
              <p className="reports__compliance-score">
                Score: {m.compScore}% across {filtered.length} contract{filtered.length !== 1 ? 's' : ''}
              </p>
              {m.compBreakdown.length === 0
                ? <p className="reports__compliance-clean">✅ No compliance issues found.</p>
                : (
                  <div className="reports__compliance-list">
                    {m.compBreakdown.map(item => (
                      <div key={item.issue} className="reports__compliance-row">
                        <span className="reports__compliance-issue">{item.issue}</span>
                        <span className="reports__compliance-count">{item.count} contract{item.count !== 1 ? 's' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        )}

        {/* ── Financial Exposure ── */}
        <div className="reports__card">
          <div className="reports__card-header">
            <h3>Financial Exposure</h3>
            <span>{periodLabel}</span>
          </div>
          <div className="reports__exposure-row">
            {[
              { label: 'Active Contract Value',   value: fmt$(m.activeVal),   color: 'blue' },
              { label: 'Expiring in 90 Days',     value: fmt$(m.exp90Val),    color: 'amber' },
              { label: 'High-Risk Value',         value: fmt$(m.highRiskVal), color: 'red' },
              { label: 'Pending Approval Value',  value: fmt$(m.pendingVal),  color: 'purple' },
              { label: 'Unsigned Contract Value', value: fmt$(m.unsignedVal), color: 'gray' },
            ].map(e => (
              <div key={e.label} className={`reports__exposure-card reports__exposure-card--${e.color}`}>
                <div className="reports__exposure-value">{e.value}</div>
                <div className="reports__exposure-label">{e.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Expiry Cards ── */}
        <div className="reports__expiry-row">
          {[
            { count: m.exp30,     label: 'Expiring in 30 Days',    sub: 'Immediate action needed',    icon: '⏰', color: 'amber' },
            { count: m.exp90,     label: 'Expiring in 90 Days',    sub: 'Plan renewals now',          icon: '📅', color: 'blue' },
            { count: m.autoRenew, label: 'Auto-Renewals (90d)',    sub: 'Review before auto-renewal', icon: '🔄', color: 'purple' },
          ].map(c => (
            <div key={c.label} className={`reports__expiry-card reports__expiry-card--${c.color}`}>
              <div className="reports__expiry-icon">{c.icon}</div>
              <div className="reports__expiry-count">{c.count}</div>
              <div className="reports__expiry-label">{c.label}</div>
              <div className="reports__expiry-sub">{c.sub}</div>
            </div>
          ))}
        </div>

        {/* ── Contracts Requiring Attention ── */}
        {m.attention.length > 0 && (
          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Contracts Requiring Attention</h3>
              <span>{m.attention.length} item{m.attention.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="reports__table-wrap">
              <table className="reports__table">
                <thead>
                  <tr><th>Contract</th><th>Issue</th><th>Owner</th><th>Due Date</th><th>Priority</th></tr>
                </thead>
                <tbody>
                  {m.attention.map((row, i) => (
                    <tr key={i}>
                      <td className="reports__td-name">{row.contract}</td>
                      <td>{row.issue}</td>
                      <td>{row.owner}</td>
                      <td>{row.dueDate}</td>
                      <td><PriorityBadge value={row.priority} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Row 1: Contract Activity + Pipeline Status ── */}
        <div className="reports__row">
          <div className="reports__card reports__card--lg">
            <div className="reports__card-header">
              <h3>Contract Activity</h3>
              <span>{periodLabel}</span>
            </div>
            {/* Use summary.monthly if available (server aggregation) else client-computed */}
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary?.monthly || m.monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'rgba(79,142,247,0.05)' }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="created"  name="Created"  fill="#4f8ef7" radius={[4,4,0,0]} />
                <Bar dataKey="executed" name="Executed" fill="#10b981" radius={[4,4,0,0]} />
                <Bar dataKey="expired"  name="Expired"  fill="#ef4444" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Contract Pipeline Status</h3>
              <span>{statusTotal} total</span>
            </div>
            {m.byStatus.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie data={m.byStatus} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={38} outerRadius={65} paddingAngle={3}>
                      {m.byStatus.map(entry => <Cell key={entry.name} fill={entry.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="reports__status-legend">
                  {m.byStatus.map(entry => {
                    const pct = statusTotal > 0 ? Math.round((entry.value / statusTotal) * 100) : 0;
                    return (
                      <div key={entry.name} className="reports__status-row">
                        <div className="reports__status-dot" style={{ background: entry.color }} />
                        <span className="reports__status-name">{entry.name}</span>
                        <div className="reports__status-bar-track">
                          <div className="reports__status-bar-fill" style={{ width: `${pct}%`, background: entry.color }} />
                        </div>
                        <span className="reports__status-count">{entry.value}</span>
                        <span className="reports__status-pct">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="reports__empty-chart">No contracts in this period</div>
            )}
          </div>
        </div>

        {/* ── Row 2: Cycle Time + Value by Dept ── */}
        <div className="reports__row">
          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Avg. Cycle Time by Contract Type</h3>
              <span>Target: 14 days</span>
            </div>
            {m.cycleByType.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={m.cycleByType} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="type" type="category" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'rgba(79,142,247,0.05)' }} formatter={(v) => [`${v} days`, 'Avg cycle']} />
                    <ReferenceLine x={14} stroke="#4f8ef7" strokeDasharray="4 4" label={{ value: '14d target', position: 'insideTopRight', fontSize: 10, fill: '#4f8ef7' }} />
                    <Bar dataKey="days" name="Days" fill="#8b5cf6" radius={[0,4,4,0]} />
                  </BarChart>
                </ResponsiveContainer>
                {m.cycleByType.length > 0 && (
                  <div className="reports__card-insight">
                    <strong>Insight</strong> — {m.cycleByType[m.cycleByType.length - 1].type} takes the longest at {m.cycleByType[m.cycleByType.length - 1].days} days avg.
                  </div>
                )}
              </>
            ) : (
              <div className="reports__empty-chart">No executed contracts with cycle data</div>
            )}
          </div>

          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Contract Value by Department</h3>
              <span>ZAR</span>
            </div>
            {m.byDept.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={m.byDept}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                  <XAxis dataKey="dept" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => [fmt$(v), 'Value']} contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'rgba(79,142,247,0.05)' }} />
                  <Bar dataKey="value" name="Value" fill="#4f8ef7" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="reports__empty-chart">No department data available</div>
            )}
          </div>
        </div>

        {/* ── Row 3: Renewal Trend + Volume by Type ── */}
        <div className="reports__row">
          <div className="reports__card reports__card--lg">
            <div className="reports__card-header">
              <h3>Renewal Trend</h3>
              <span>On-time vs. missed renewals — last 6 months</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={m.renewalTrend}>
                <defs>
                  <linearGradient id="gOnTime" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gMissed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="onTime" name="On-Time" stroke="#10b981" fill="url(#gOnTime)" strokeWidth={2} />
                <Area type="monotone" dataKey="missed"  name="Missed"  stroke="#ef4444" fill="url(#gMissed)"  strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Volume by Type</h3>
              <span>Contract count</span>
            </div>
            {m.byType.length > 0 ? (
              <div className="reports__type-list">
                {m.byType.map((item, i) => {
                  const max = m.byType[0].count;
                  return (
                    <div key={item.type} className="reports__type-row">
                      <span className="reports__type-name">{item.type}</span>
                      <div className="reports__type-track">
                        <div className="reports__type-fill" style={{ width: `${(item.count / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
                      </div>
                      <span className="reports__type-count">{item.count}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="reports__empty-chart">No contract type data</div>
            )}
          </div>
        </div>

        {/* ── Risk Analytics ── */}
        <div className="reports__card">
          <div className="reports__card-header">
            <h3>Risk Overview</h3>
            <span>{periodLabel}</span>
          </div>
          <div className="reports__risk-overview">
            {m.byRisk.map(r => (
              <div key={r.level} className={`reports__risk-card reports__risk-card--${r.cls}`}>
                <div className="reports__risk-count">{r.count}</div>
                <div className="reports__risk-level">{r.level}</div>
              </div>
            ))}
          </div>
          {m.highRisk.length > 0 && (
            <>
              <h4 className="reports__section-subtitle">High-Risk Contracts</h4>
              <div className="reports__table-wrap">
                <table className="reports__table">
                  <thead>
                    <tr><th>Contract</th><th>Risk Level</th><th>Status</th><th>Value</th></tr>
                  </thead>
                  <tbody>
                    {m.highRisk.map((row, i) => (
                      <tr key={i}>
                        <td className="reports__td-name">{row.contract}</td>
                        <td><PriorityBadge value={row.risk} /></td>
                        <td>{row.status}</td>
                        <td>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>


      </div>
    </div>
  );
}
