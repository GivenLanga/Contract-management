import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Header from '../Layout/Header';
import Badge from '../common/Badge';
import { getContractsForApp, LEGAL_FOLDER_UPDATED } from '../../services/legalFolderStore';
import './ContractList.css';

const STATUS_OPTIONS = ['All', 'Active', 'Draft', 'Under Review', 'Pending Signature', 'Expired'];
const SORT_OPTIONS = [
  { label: 'Newest First', key: 'createdDate', dir: 'desc' },
  { label: 'Oldest First', key: 'createdDate', dir: 'asc' },
  { label: 'Value (High→Low)', key: 'value', dir: 'desc' },
  { label: 'Value (Low→High)', key: 'value', dir: 'asc' },
  { label: 'Title A→Z', key: 'title', dir: 'asc' },
];

const fmt = (v) =>
  v === 0
    ? '—'
    : new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(v);

const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr) - new Date()) / 86400000);
};

const timeAgo = (d) => {
  const diff = Math.round((new Date() - new Date(d)) / 86400000);
  if (diff < 1) return 'today';
  if (diff === 1) return '1 day ago';
  if (diff < 7) return `${diff} days ago`;
  if (diff < 14) return '1 week ago';
  if (diff < 30) return `${Math.floor(diff / 7)} weeks ago`;
  if (diff < 60) return '1 month ago';
  if (diff < 365) return `${Math.floor(diff / 30)} months ago`;
  if (diff < 730) return '1 year ago';
  return `${Math.floor(diff / 365)} years ago`;
};

export default function ContractList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [contractRecords, setContractRecords] = useState(() => getContractsForApp());
  const [now] = useState(() => Date.now());
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [sortIdx, setSortIdx] = useState(0);
  const [viewMode, setViewMode] = useState('table');
  const [dragOrder, setDragOrder] = useState(null);
  const dragSrc = useRef(null);

  useEffect(() => {
    const refresh = () => {
      setContractRecords(getContractsForApp());
      setDragOrder(null);
    };
    window.addEventListener(LEGAL_FOLDER_UPDATED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(LEGAL_FOLDER_UPDATED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const filtered = useMemo(() => {
    const { key, dir } = SORT_OPTIONS[sortIdx];
    const base = contractRecords
      .filter((c) => {
        const matchSearch =
          !search ||
          c.title.toLowerCase().includes(search.toLowerCase()) ||
          c.counterparty.toLowerCase().includes(search.toLowerCase()) ||
          c.id.toLowerCase().includes(search.toLowerCase()) ||
          c.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));
        const matchStatus = statusFilter === 'All' || c.status === statusFilter;
        const matchType = typeFilter === 'All' || c.type === typeFilter;
        return matchSearch && matchStatus && matchType;
      })
      .sort((a, b) => {
        let aVal = a[key], bVal = b[key];
        if (typeof aVal === 'string') aVal = aVal.toLowerCase();
        if (typeof bVal === 'string') bVal = bVal.toLowerCase();
        if (aVal < bVal) return dir === 'asc' ? -1 : 1;
        if (aVal > bVal) return dir === 'asc' ? 1 : -1;
        return 0;
      });
    if (!dragOrder) return base;
    const map = Object.fromEntries(base.map((c) => [c.id, c]));
    return dragOrder.filter((id) => map[id]).map((id) => map[id]);
  }, [contractRecords, search, statusFilter, typeFilter, sortIdx, dragOrder]);

  const typeOptions = useMemo(() => {
    const importedTypes = contractRecords
      .map((contract) => contract.type)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return ['All', ...new Set(importedTypes)];
  }, [contractRecords]);

  const handleDragStart = (e, idx) => {
    dragSrc.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragSrc.current === idx) return;
    const reordered = [...filtered];
    const [moved] = reordered.splice(dragSrc.current, 1);
    reordered.splice(idx, 0, moved);
    dragSrc.current = idx;
    setDragOrder(reordered.map((c) => c.id));
  };

  const handleDragEnd = () => {
    dragSrc.current = null;
  };

  return (
    <div className="contract-list">
      <Header
        title="Contracts"
        subtitle={`${filtered.length} contract${filtered.length !== 1 ? 's' : ''} found`}
      />

      <div className="contract-list__content">
        {/* Toolbar */}
        <div className="contract-list__toolbar">
          <div className="contract-list__search">
            <span>🔍</span>
            <input
              type="text"
              placeholder="Search by title, party, ID, or tag…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setDragOrder(null);
              }}
            />
            {search && (
              <button
                className="contract-list__clear"
                onClick={() => {
                  setSearch('');
                  setDragOrder(null);
                }}
              >
                ✕
              </button>
            )}
          </div>

          <div className="contract-list__filters">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setDragOrder(null);
              }}
            >
              {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setDragOrder(null);
              }}
            >
              {typeOptions.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select
              value={sortIdx}
              onChange={(e) => {
                setSortIdx(Number(e.target.value));
                setDragOrder(null);
              }}
            >
              {SORT_OPTIONS.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
            </select>
          </div>

          <div className="contract-list__view-toggle">
            <button
              className={viewMode === 'table' ? 'active' : ''}
              onClick={() => setViewMode('table')}
              title="Table view"
            >☰</button>
            <button
              className={viewMode === 'cards' ? 'active' : ''}
              onClick={() => setViewMode('cards')}
              title="Card view"
            >⊞</button>
          </div>
        </div>

        {/* Table View */}
        {viewMode === 'table' && (
          <div className="contract-list__table-wrap">
            <table className="contract-list__table">
              <thead>
                <tr>
                  <th style={{ width: 32, paddingRight: 0 }}></th>
                  <th>ID</th>
                  <th>Contract Title</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Counterparty</th>
                  <th>Value</th>
                  <th>End Date</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="contract-list__empty">
                      <span>🔍</span>
                      <p>No contracts match your filters.</p>
                    </td>
                  </tr>
                )}
                {filtered.map((c, idx) => {
                  const days = daysUntil(c.endDate);
                  const isExpiringSoon = days !== null && days > 0 && days <= 90;

                  let pct = null;
                  let barColor = '#10b981';
                  if (c.startDate && c.endDate) {
                    const start = new Date(c.startDate).getTime();
                    const end = new Date(c.endDate).getTime();
                    pct = Math.min(100, Math.max(0, Math.round((now - start) / (end - start) * 100)));
                    if (pct >= 90 || isExpiringSoon) barColor = '#ef4444';
                    else if (pct >= 70) barColor = '#f59e0b';
                    else barColor = '#10b981';
                  }

                  return (
                    <tr
                      key={c.id}
                      className={`contract-list__row${isExpiringSoon ? ' contract-list__row--expiring' : ''}`}
                      onClick={() => navigate(`/contracts/${c.id}`)}
                      draggable
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDragEnd={handleDragEnd}
                      style={{ cursor: 'grab' }}
                    >
                      <td
                        className="contract-list__drag-handle"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⠿
                      </td>
                      <td className="contract-list__id">{c.id}</td>
                      <td className="contract-list__title">
                        <span className="contract-list__title-text">{c.title}</span>
                        <div className="contract-list__tags">
                          {c.tags.slice(0, 2).map((t) => (
                            <span key={t} className="contract-list__tag">{t}</span>
                          ))}
                        </div>
                      </td>
                      <td><Badge status={c.type} size="sm" /></td>
                      <td><Badge status={c.status} size="sm" /></td>
                      <td className="contract-list__party">{c.counterparty}</td>
                      <td className="contract-list__value">{fmt(c.value)}</td>
                      <td className="contract-list__date">
                        {c.endDate ? (
                          <div className="date-progress">
                            <span className={`date-progress__label${isExpiringSoon ? ' date-progress__label--soon' : ''}`}>
                              {c.endDate}
                            </span>
                            {pct !== null && (
                              <>
                                <div className="date-progress__bar-track">
                                  <div
                                    className="date-progress__bar-fill"
                                    style={{ width: pct + '%', background: barColor }}
                                  />
                                </div>
                                <span className="date-progress__sub">
                                  {isExpiringSoon
                                    ? `Expires in ${days}d`
                                    : pct >= 100
                                    ? `Expired ${timeAgo(c.endDate)}`
                                    : `${pct}% elapsed`}
                                </span>
                              </>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Card View */}
        {viewMode === 'cards' && (
          <div className="contract-list__cards">
            {filtered.length === 0 && (
              <div className="contract-list__no-results">
                <span>🔍</span>
                <p>No contracts match your filters.</p>
              </div>
            )}
            {filtered.map((c) => (
              <div
                key={c.id}
                className="contract-list__card"
                onClick={() => navigate(`/contracts/${c.id}`)}
              >
                <div className="contract-list__card-header">
                  <span className="contract-list__card-id">{c.id}</span>
                  <Badge status={c.status} size="sm" />
                </div>
                <h4 className="contract-list__card-title">{c.title}</h4>
                <p className="contract-list__card-party">{c.counterparty}</p>
                <div className="contract-list__card-meta">
                  <Badge status={c.type} size="sm" />
                  <Badge status={c.priority} size="sm" />
                </div>
                <div className="contract-list__card-footer">
                  <span className="contract-list__card-value">{fmt(c.value)}</span>
                  <span className="contract-list__card-date">{c.endDate ? `Ends ${c.endDate}` : 'No end date'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
