import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { legalRequests as lrApi } from '../../services/api';
import Header from '../Layout/Header';
import {
  STATUS_LABELS, PRIORITY_COLORS, STATUS_COLORS, HOLDER_LABELS, HOLDER_COLORS,
  REQUEST_TYPE_LABELS, getDaysLabel, formatCurrency,
} from './lrHelpers';
import './LegalRequestList.css';

const FILTER_PRESETS = [
  { key: 'all',             label: 'All Active',   query: {} },
  { key: 'overdue',         label: 'Overdue',       query: { overdue: 'true' } },
  { key: 'dueToday',        label: 'Due Today',     query: { dueToday: 'true' } },
  { key: 'dueThisWeek',     label: 'This Week',     query: { dueThisWeek: 'true' } },
  { key: 'unassigned',      label: 'Unassigned',    query: { unassigned: 'true' } },
  { key: 'withManager',     label: 'With Manager',  query: { status: 'WITH_MANAGER' } },
  { key: 'waitingExternal', label: 'Ext. Feedback',  query: { currentHolder: 'EXTERNAL_PARTY' } },
  { key: 'noUpdate',        label: 'No Update 3d',  query: { noUpdate: 'true' } },
];

export default function LegalRequestList() {
  const { user, isManager } = useAuth();
  const navigate            = useNavigate();
  const [searchParams]      = useSearchParams();

  const [items, setItems]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [preset, setPreset]   = useState('all');
  const [filterIO, setFilterIO] = useState('');   // INTERNAL | EXTERNAL | ''
  const [filterPri, setFilterPri] = useState(''); // priority

  const fetchRequests = useCallback(async (extraQuery = {}) => {
    setLoading(true);
    try {
      const params = { limit: 100, ...extraQuery };
      if (search)    params.search = search;
      if (filterIO)  params.internalOrExternal = filterIO;
      if (filterPri) params.priority = filterPri;
      const data = await lrApi.list(params);
      setItems(data.requests || []);
      setTotal(data.total || 0);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [search, filterIO, filterPri]);

  useEffect(() => {
    const found = FILTER_PRESETS.find(p => p.key === preset);
    fetchRequests(found?.query || {});
  }, [preset, fetchRequests]);

  // Support ?preset=overdue from Dashboard click-through
  useEffect(() => {
    const p = searchParams.get('preset');
    if (p && FILTER_PRESETS.find(fp => fp.key === p)) setPreset(p);
  }, [searchParams]);

  const currentPreset = FILTER_PRESETS.find(p => p.key === preset);

  return (
    <div className="lrl">
      <Header
        title="Legal Requests"
        subtitle="Track every legal request from submission to completion"
        actions={
          <button className="lrl__new-btn" onClick={() => navigate('/legal-requests/new')}>
            + New Request
          </button>
        }
      />

      <div className="lrl__body">
        {/* Preset filter tabs */}
        <div className="lrl__preset-tabs">
          {FILTER_PRESETS.map(p => (
            <button
              key={p.key}
              className={`lrl__preset-tab${preset === p.key ? ' lrl__preset-tab--active' : ''}`}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Search + secondary filters */}
        <div className="lrl__filters">
          <input
            className="lrl__search"
            type="text"
            placeholder="Search title, counterparty, reference…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchRequests(currentPreset?.query)}
          />
          <select className="lrl__filter-select" value={filterIO} onChange={e => setFilterIO(e.target.value)}>
            <option value="">All tracks</option>
            <option value="INTERNAL">Internal</option>
            <option value="EXTERNAL">External</option>
          </select>
          <select className="lrl__filter-select" value={filterPri} onChange={e => setFilterPri(e.target.value)}>
            <option value="">All priorities</option>
            <option value="URGENT">Urgent</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
          <span className="lrl__total">{total} request{total !== 1 ? 's' : ''}</span>
        </div>

        {/* Table */}
        {loading ? (
          <div className="lrl__loading">Loading…</div>
        ) : items.length === 0 ? (
          <div className="lrl__empty">
            <span className="lrl__empty-icon">⚖</span>
            <p>No requests match the current filters.</p>
            {isManager && (
              <button className="lrl__new-btn" onClick={() => navigate('/legal-requests/new')}>
                Submit the first request
              </button>
            )}
          </div>
        ) : (
          <div className="lrl__list">
            {items.map(r => <RequestRow key={r._id} request={r} onClick={() => navigate(`/legal-requests/${r._id}`)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestRow({ request: r, onClick }) {
  const days    = getDaysLabel(r.dueDate);
  const priClr  = PRIORITY_COLORS[r.priority] || PRIORITY_COLORS.MEDIUM;
  const stsClr  = STATUS_COLORS[r.status]     || STATUS_COLORS.SUBMITTED;
  const hldClr  = HOLDER_COLORS[r.currentHolder] || '#94a3b8';

  return (
    <div className="lrl__row" onClick={onClick} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}>
      {/* Left: type track + title */}
      <div className="lrl__row-main">
        <div className="lrl__row-badges">
          <span className={`lrl__track-badge lrl__track-badge--${r.internalOrExternal?.toLowerCase()}`}>
            {r.internalOrExternal === 'INTERNAL' ? 'Internal' : 'External'}
          </span>
          {r.requestType && (
            <span className="lrl__type-badge">{REQUEST_TYPE_LABELS[r.requestType] || r.requestType}</span>
          )}
          <span
            className="lrl__priority-badge"
            style={{ background: priClr.bg, color: priClr.color, border: `1px solid ${priClr.border}` }}
          >
            {r.priority}
          </span>
        </div>
        <span className="lrl__title">{r.title}</span>
        {r.counterpartyName && <span className="lrl__counterparty">{r.counterpartyName}</span>}
        {r.requestId && <span className="lrl__ref">{r.requestId}</span>}
      </div>

      {/* Status */}
      <div className="lrl__row-status">
        <span
          className="lrl__status-badge"
          style={{ background: stsClr.bg, color: stsClr.color }}
        >
          {STATUS_LABELS[r.status] || r.status}
        </span>
        <span className="lrl__holder" style={{ color: hldClr }}>
          {HOLDER_LABELS[r.currentHolder] || r.currentHolder}
        </span>
      </div>

      {/* Assigned */}
      <div className="lrl__row-owner">
        {r.assignedTo ? (
          <>
            <span className="lrl__avatar">{initials(r.assignedTo.name)}</span>
            <span className="lrl__owner-name">{r.assignedTo.name}</span>
          </>
        ) : (
          <span className="lrl__unassigned">Unassigned</span>
        )}
      </div>

      {/* Due date */}
      <div className="lrl__row-due">
        {days ? (
          <span className={`lrl__days lrl__days--${days.cls}`}>{days.label}</span>
        ) : (
          <span className="lrl__days lrl__days--ok">No due date</span>
        )}
        {r.dueDate && (
          <span className="lrl__due-date">{new Date(r.dueDate).toLocaleDateString('en-ZA')}</span>
        )}
      </div>

      {/* Next action */}
      <div className="lrl__row-action">
        <span className="lrl__next-action">{r.nextAction}</span>
      </div>
    </div>
  );
}

function initials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
