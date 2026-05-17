import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Header from '../Layout/Header';
import Badge from '../common/Badge';
import { getContractsForApp, LEGAL_FOLDER_UPDATED } from '../../services/legalFolderStore';
import { classifyLifecycleStage } from '../../services/legalFolderLifecycleClassifier';
import './ContractList.css';

const STATUS_OPTIONS = ['All', 'Active', 'Expired', 'Expiring Soon', 'Terminated', 'Unknown'];
const SORT_OPTIONS = [
  { label: 'Newest First', key: 'createdDate', dir: 'desc' },
  { label: 'Oldest First', key: 'createdDate', dir: 'asc' },
  { label: 'Value (High→Low)', key: 'value', dir: 'desc' },
  { label: 'Value (Low→High)', key: 'value', dir: 'asc' },
  { label: 'Title A→Z', key: 'title', dir: 'asc' },
];

const fmt = (v, displayValue = null) =>
  displayValue ||
  (v === 0 || v === null || v === undefined
    ? '—'
    : new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(v));

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

const CONTRACT_STATUS_LABELS = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  EXPIRING_SOON: 'Expiring Soon',
  TERMINATED: 'Terminated',
  UNKNOWN: 'Unknown',
};

const contractStatusLabel = (value) =>
  CONTRACT_STATUS_LABELS[String(value || '').toUpperCase()] || null;

const portfolioStatusForContract = (contract) => {
  if (contract?.contractStatusLabel && contract.contractStatusLabel !== 'Signed') return contract.contractStatusLabel;
  const fromCode = contractStatusLabel(contract?.contractStatus);
  if (fromCode) return fromCode;
  if (contract?.terminationDate) return 'Terminated';
  const endDate = contract?.expiryDate || contract?.expirationDate || contract?.endDate;
  if (!endDate) return 'Unknown';
  const today = new Date();
  const todayMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const end = new Date(`${String(endDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return 'Unknown';
  const days = Math.ceil((end.getTime() - todayMidnight.getTime()) / 86400000);
  if (days < 0) return 'Expired';
  if (days <= 30) return 'Expiring Soon';
  return 'Active';
};

const endDateForContract = (contract) =>
  contract?.expiryDate || contract?.expirationDate || contract?.endDate || contract?.terminationDate || null;

const optionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizePortfolioContract = (contract) => {
  const endDate = endDateForContract(contract);
  const status = portfolioStatusForContract({ ...contract, endDate });
  const value = optionalNumber(contract?.contractValue) ?? optionalNumber(contract?.value);
  return {
    ...contract,
    status,
    portfolioStatus: status,
    value,
    endDate,
    contractValueDisplay: contract?.contractValueDisplay || null,
  };
};

const CONTRACT_PATH_FIELDS = [
  'relativePath',
  'legalFolderPath',
  'sourcePath',
  'folderPath',
  'displayPath',
  'path',
  'filePath',
  'fullPath',
  'relativeFilePath',
  'legalFolderRelativePath',
  'sourceRelativePath',
];

const pathTextForRecord = (record = {}) =>
  CONTRACT_PATH_FIELDS.map((field) => record[field]).filter(Boolean).join(' ');

const hasSignedLikePath = (record = {}) =>
  /\b(signed|executed|completed|sign)\b/i.test(pathTextForRecord(record).replace(/[_-]/g, ' '));

const lifecycleDebugRecord = ({ record, classifierResult }) => ({
  title: record.title || record.name || null,
  fileName: record.fileName || record.name || null,
  relativePath: record.relativePath || null,
  legalFolderPath: record.legalFolderPath || null,
  sourcePath: record.sourcePath || null,
  folderPath: record.folderPath || null,
  displayPath: record.displayPath || null,
  path: record.path || null,
  filePath: record.filePath || null,
  fullPath: record.fullPath || null,
  relativeFilePath: record.relativeFilePath || null,
  legalFolderRelativePath: record.legalFolderRelativePath || null,
  sourceRelativePath: record.sourceRelativePath || null,
  lifecycleStage: record.lifecycleStage || null,
  documentStage: record.documentStage || null,
  status: record.status || null,
  classifierResult,
});

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

  // Classify all records and split into signed vs. everything else.
  const { signedRecords, stageCounts, lifecycleDiagnostics } = useMemo(() => {
    const counts = { total: contractRecords.length, drafts: 0, finals: 0, signed: 0, templates: 0, unknown: 0 };
    const signed = [];
    const classified = [];
    for (const c of contractRecords) {
      const classifierResult = classifyLifecycleStage(c);
      const { lifecycleStage } = classifierResult;
      classified.push({ record: c, classifierResult });
      if (lifecycleStage === 'SIGNED')   { counts.signed++;    signed.push(normalizePortfolioContract(c)); }
      else if (lifecycleStage === 'DRAFT')    counts.drafts++;
      else if (lifecycleStage === 'FINAL')    counts.finals++;
      else if (lifecycleStage === 'TEMPLATE') counts.templates++;
      else                                    counts.unknown++;
    }

    const recordsWithSignedInAnyPath = classified
      .filter(({ record }) => hasSignedLikePath(record))
      .map(lifecycleDebugRecord);
    const unknownRecordsWithSignedInAnyPath = classified
      .filter(({ record, classifierResult }) =>
        classifierResult.lifecycleStage === 'UNKNOWN' && hasSignedLikePath(record)
      )
      .map(lifecycleDebugRecord);

    if (import.meta.env.DEV) {
      console.info('[Contracts Diagnostics] lifecycle classifier trace', {
        totalReceivedFromGetContractsForApp: counts.total,
        signedDetectedByClassifier: counts.signed,
        unknownDetectedByClassifier: counts.unknown,
        recordsWithSignedInAnyPath,
        unknownRecordsWithSignedInAnyPath,
      });
      if (unknownRecordsWithSignedInAnyPath.length > 0) {
        console.warn('[Contracts Diagnostics] suspicious signed-like UNKNOWN records', unknownRecordsWithSignedInAnyPath);
      }
    }

    return {
      signedRecords: signed,
      stageCounts: counts,
      lifecycleDiagnostics: {
        recordsWithSignedInAnyPath,
        unknownRecordsWithSignedInAnyPath,
        unknownRecords: classified
          .filter(({ classifierResult }) => classifierResult.lifecycleStage === 'UNKNOWN')
          .map(lifecycleDebugRecord),
      },
    };
  }, [contractRecords]);

  const metadataDiagnostics = useMemo(() => {
    const statusCounts = signedRecords.reduce((acc, record) => {
      const key = record.portfolioStatus || record.status || 'Unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const extractionWarnings = signedRecords
      .filter((record) => record.extraction?.warnings?.length)
      .map((record) => ({
        fileName: record.fileName || record.name || record.title,
        relativePath: record.relativePath || record.sourcePath || null,
        warnings: record.extraction.warnings,
      }));
    const diagnostics = {
      totalSignedContracts: signedRecords.length,
      active: statusCounts.Active || 0,
      expired: statusCounts.Expired || 0,
      expiringSoon: statusCounts['Expiring Soon'] || 0,
      terminated: statusCounts.Terminated || 0,
      unknownStatus: statusCounts.Unknown || 0,
      withValue: signedRecords.filter((record) => Number(record.value) > 0 || record.contractValueDisplay).length,
      missingValue: signedRecords.filter((record) => !record.contractValueDisplay && !Number(record.value)).length,
      withEndDate: signedRecords.filter((record) => record.endDate).length,
      missingEndDate: signedRecords.filter((record) => !record.endDate).length,
      extractionWarnings,
    };
    if (import.meta.env.DEV) {
      console.info('[Contracts Diagnostics] metadata summary', diagnostics);
      console.info('[Contracts Diagnostics] metadata rows', signedRecords.map((record) => ({
        fileName: record.fileName || record.name || record.title,
        relativePath: record.relativePath || record.sourcePath || null,
        lifecycleStage: record.lifecycleStage || null,
        contractStatus: record.contractStatus || null,
        portfolioStatus: record.portfolioStatus || record.status || null,
        contractValueDisplay: record.contractValueDisplay || null,
        expiryDate: record.expiryDate || record.endDate || null,
        extractionWarnings: record.extraction?.warnings || [],
      })));
    }
    return diagnostics;
  }, [signedRecords]);

  const filtered = useMemo(() => {
    const { key, dir } = SORT_OPTIONS[sortIdx];
    const base = signedRecords
      .filter((c) => {
        const matchSearch =
          !search ||
          c.title.toLowerCase().includes(search.toLowerCase()) ||
          c.counterparty.toLowerCase().includes(search.toLowerCase()) ||
          c.id.toLowerCase().includes(search.toLowerCase()) ||
          c.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));
        const matchStatus = statusFilter === 'All' || c.portfolioStatus === statusFilter || c.status === statusFilter;
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
  }, [signedRecords, search, statusFilter, typeFilter, sortIdx, dragOrder]);

  const typeOptions = useMemo(() => {
    const importedTypes = signedRecords
      .map((contract) => contract.type)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return ['All', ...new Set(importedTypes)];
  }, [signedRecords]);

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
        subtitle={
          signedRecords.length === 0
            ? 'Signed contracts'
            : `${filtered.length} contract${filtered.length !== 1 ? 's' : ''} found`
        }
      />

      <div className="contract-list__content">
        {/* Empty state — no signed contracts in Legal Folder */}
        {signedRecords.length === 0 && (
          <div className="contract-list__signed-empty">
            <span role="img" aria-label="folder">📂</span>
            <h3>No signed contracts found.</h3>
            <p>Contracts appear here after documents are saved inside a Signed folder.</p>
            {stageCounts.total > 0 && (
              <div className="contract-list__diagnostics">
                <p className="contract-list__diagnostics-title">Detected in Legal Folder:</p>
                <ul>
                  {stageCounts.drafts > 0 && (
                    <li>{stageCounts.drafts} draft{stageCounts.drafts !== 1 ? 's' : ''}</li>
                  )}
                  {stageCounts.finals > 0 && (
                    <li>{stageCounts.finals} final document{stageCounts.finals !== 1 ? 's' : ''} ready for signing</li>
                  )}
                  {stageCounts.templates > 0 && (
                    <li>{stageCounts.templates} template{stageCounts.templates !== 1 ? 's' : ''}</li>
                  )}
                  {stageCounts.unknown > 0 && (
                    <li>{stageCounts.unknown} unknown document{stageCounts.unknown !== 1 ? 's' : ''}</li>
                  )}
                  <li>0 signed documents</li>
                </ul>
              </div>
            )}
            {import.meta.env.DEV && (
              <details className="contract-list__lifecycle-debug">
                <summary>Lifecycle Debug</summary>
                <dl>
                  <div><dt>Total records received</dt><dd>{stageCounts.total}</dd></div>
                  <div><dt>Signed detected</dt><dd>{stageCounts.signed}</dd></div>
                  <div><dt>Final detected</dt><dd>{stageCounts.finals}</dd></div>
                  <div><dt>Draft detected</dt><dd>{stageCounts.drafts}</dd></div>
                  <div><dt>Unknown detected</dt><dd>{stageCounts.unknown}</dd></div>
                  <div>
                    <dt>Unknown signed-like paths</dt>
                    <dd>{lifecycleDiagnostics.unknownRecordsWithSignedInAnyPath.length}</dd>
                  </div>
                </dl>
                {lifecycleDiagnostics.unknownRecords.slice(0, 10).length > 0 && (
                  <div className="contract-list__lifecycle-debug-list">
                    {lifecycleDiagnostics.unknownRecords.slice(0, 10).map((item, index) => (
                      <div key={`${item.relativePath || item.sourcePath || item.fileName || 'unknown'}-${index}`} className="contract-list__lifecycle-debug-item">
                        <strong>{item.fileName || 'Unknown file'}</strong>
                        <span>relativePath: {item.relativePath || 'missing'}</span>
                        <span>displayPath: {item.displayPath || 'missing'}</span>
                        <span>sourcePath: {item.sourcePath || 'missing'}</span>
                        <span>reason: {item.classifierResult?.reason || 'missing'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            )}
          </div>
        )}

        {/* Toolbar + table/cards — only shown when signed contracts exist */}
        {signedRecords.length > 0 && (
          <>
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

            {import.meta.env.DEV && (
              <details className="contract-list__lifecycle-debug">
                <summary>Contract Metadata Debug</summary>
                <dl>
                  <div><dt>Total signed contracts</dt><dd>{metadataDiagnostics.totalSignedContracts}</dd></div>
                  <div><dt>Active</dt><dd>{metadataDiagnostics.active}</dd></div>
                  <div><dt>Expired</dt><dd>{metadataDiagnostics.expired}</dd></div>
                  <div><dt>Expiring Soon</dt><dd>{metadataDiagnostics.expiringSoon}</dd></div>
                  <div><dt>Terminated</dt><dd>{metadataDiagnostics.terminated}</dd></div>
                  <div><dt>Unknown status</dt><dd>{metadataDiagnostics.unknownStatus}</dd></div>
                  <div><dt>With value</dt><dd>{metadataDiagnostics.withValue}</dd></div>
                  <div><dt>Missing value</dt><dd>{metadataDiagnostics.missingValue}</dd></div>
                  <div><dt>With end date</dt><dd>{metadataDiagnostics.withEndDate}</dd></div>
                  <div><dt>Missing end date</dt><dd>{metadataDiagnostics.missingEndDate}</dd></div>
                  <div><dt>Extraction warnings</dt><dd>{metadataDiagnostics.extractionWarnings.length}</dd></div>
                </dl>
              </details>
            )}

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
                  const isExpiringSoon = c.portfolioStatus === 'Expiring Soon' || (days !== null && days >= 0 && days <= 30);

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
                      <td><Badge status={c.portfolioStatus || c.status} size="sm" /></td>
                      <td className="contract-list__party">{c.counterparty}</td>
                      <td className="contract-list__value">{fmt(c.value, c.contractValueDisplay)}</td>
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
                      <Badge status={c.portfolioStatus || c.status} size="sm" />
                    </div>
                    <h4 className="contract-list__card-title">{c.title}</h4>
                    <p className="contract-list__card-party">{c.counterparty}</p>
                    <div className="contract-list__card-meta">
                      <Badge status={c.type} size="sm" />
                      <Badge status={c.priority} size="sm" />
                    </div>
                    <div className="contract-list__card-footer">
                      <span className="contract-list__card-value">{fmt(c.value, c.contractValueDisplay)}</span>
                      <span className="contract-list__card-date">{c.endDate ? `Ends ${c.endDate}` : 'No end date'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
