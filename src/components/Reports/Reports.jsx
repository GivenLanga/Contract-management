import Header from '../Layout/Header';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
  LineChart, Line, Area, AreaChart,
} from 'recharts';
import { contracts, contractsByType, monthlyData } from '../../data/mockData';
import './Reports.css';

const COLORS = ['#4f8ef7', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316'];

const statusData = [
  { name: 'Active', value: 4, color: '#10b981' },
  { name: 'Under Review', value: 2, color: '#f59e0b' },
  { name: 'Draft', value: 1, color: '#94a3b8' },
  { name: 'Pending Signature', value: 1, color: '#8b5cf6' },
  { name: 'Expired', value: 1, color: '#ef4444' },
];

const cycleTimeData = [
  { type: 'NDA', days: 3 },
  { type: 'DPA', days: 12 },
  { type: 'Vendor', days: 16 },
  { type: 'SOW', days: 21 },
  { type: 'License', days: 18 },
  { type: 'Employment', days: 14 },
  { type: 'MSA', days: 28 },
  { type: 'Partnership', days: 45 },
];

const valueByDept = [
  { dept: 'Legal', value: 540000 },
  { dept: 'IT', value: 120000 },
  { dept: 'BD', value: 1200000 },
  { dept: 'Ops', value: 320000 },
  { dept: 'HR', value: 210000 },
  { dept: 'Compliance', value: 55000 },
  { dept: 'Procurement', value: 75000 },
];

const renewalTrendData = [
  { month: 'May', onTime: 3, missed: 0 },
  { month: 'Jun', onTime: 2, missed: 1 },
  { month: 'Jul', onTime: 4, missed: 0 },
  { month: 'Aug', onTime: 3, missed: 0 },
  { month: 'Sep', onTime: 5, missed: 1 },
  { month: 'Oct', onTime: 2, missed: 0 },
];

const kpiCards = [
  { label: 'Total Contract Value', value: '$2.47M', sub: 'Across all active', icon: '💰', color: 'blue' },
  { label: 'Avg. Cycle Time', value: '18 days', sub: 'Draft to execution', icon: '⏱', color: 'purple' },
  { label: 'Renewal Rate', value: '87%', sub: 'Contracts renewed on time', icon: '🔄', color: 'green' },
  { label: 'Compliance Score', value: '94%', sub: 'GDPR & policy adherence', icon: '✅', color: 'green' },
];

export default function Reports() {
  const formatCurrency = (v) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v);

  return (
    <div className="reports">
      <Header
        title="Reports & Analytics"
        subtitle="Contract performance insights and metrics"
      />

      <div className="reports__content">
        {/* KPI strip */}
        <div className="reports__kpi-row">
          {kpiCards.map((k) => (
            <div key={k.label} className={`reports__kpi reports__kpi--${k.color}`}>
              <div className="reports__kpi-icon">{k.icon}</div>
              <div className="reports__kpi-body">
                <div className="reports__kpi-value">{k.value}</div>
                <div className="reports__kpi-label">{k.label}</div>
                <div className="reports__kpi-sub">{k.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Row 1: Activity + Status distribution */}
        <div className="reports__row">
          <div className="reports__card reports__card--lg">
            <div className="reports__card-header">
              <h3>Contract Activity</h3>
              <span>Last 6 months</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'rgba(79,142,247,0.05)' }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="created" name="Created" fill="#4f8ef7" radius={[4,4,0,0]} />
                <Bar dataKey="executed" name="Executed" fill="#10b981" radius={[4,4,0,0]} />
                <Bar dataKey="expired" name="Expired" fill="#ef4444" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Status Distribution</h3>
              <span>{contracts.length} total</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={85} paddingAngle={3}>
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Row 2: Cycle time + Value by dept */}
        <div className="reports__row">
          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Avg. Cycle Time by Contract Type</h3>
              <span>Days from draft to execution</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={cycleTimeData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis dataKey="type" type="category" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} width={80} />
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'rgba(79,142,247,0.05)' }} />
                <Bar dataKey="days" name="Days" fill="#8b5cf6" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Contract Value by Department</h3>
              <span>USD</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={valueByDept}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                <XAxis dataKey="dept" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => [`$${v.toLocaleString()}`, 'Value']} contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'rgba(79,142,247,0.05)' }} />
                <Bar dataKey="value" name="Value" fill="#4f8ef7" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Row 3: Renewal trend + Type volume */}
        <div className="reports__row">
          <div className="reports__card reports__card--lg">
            <div className="reports__card-header">
              <h3>Renewal Trend</h3>
              <span>On-time vs. missed renewals</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={renewalTrendData}>
                <defs>
                  <linearGradient id="colorOnTime" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorMissed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#8b9bb4' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ border: '1px solid #e8edf3', borderRadius: 8, fontSize: 12 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="onTime" name="On-Time" stroke="#10b981" fill="url(#colorOnTime)" strokeWidth={2} />
                <Area type="monotone" dataKey="missed" name="Missed" stroke="#ef4444" fill="url(#colorMissed)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="reports__card">
            <div className="reports__card-header">
              <h3>Volume by Type</h3>
              <span>Contract count</span>
            </div>
            <div className="reports__type-list">
              {contractsByType.map((item, i) => {
                const maxCount = Math.max(...contractsByType.map(c => c.count));
                return (
                  <div key={item.type} className="reports__type-row">
                    <span className="reports__type-name">{item.type}</span>
                    <div className="reports__type-track">
                      <div
                        className="reports__type-fill"
                        style={{ width: `${(item.count / maxCount) * 100}%`, background: COLORS[i % COLORS.length] }}
                      />
                    </div>
                    <span className="reports__type-count">{item.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Export row */}
        <div className="reports__export-bar">
          <span>📊 Export Reports</span>
          <div className="reports__export-btns">
            <button className="reports__export-btn">📥 PDF Report</button>
            <button className="reports__export-btn">📊 Excel Export</button>
            <button className="reports__export-btn">📧 Schedule Email</button>
          </div>
        </div>
      </div>
    </div>
  );
}
