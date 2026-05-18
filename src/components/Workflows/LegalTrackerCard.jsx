import { useState, useRef } from 'react';

const isDesktop = () => Boolean(window.contractiq?.isDesktop);

const STATUS_LABELS = {
  watching:     { label: 'Watching',       color: '#15803d', bg: '#f0fdf4' },
  needs_resync: { label: 'Needs Resync',   color: '#b45309', bg: '#fffbeb' },
  missing_file: { label: 'Missing File',   color: '#dc2626', bg: '#fef2f2' },
  syncing:      { label: 'Syncing…',       color: '#2563eb', bg: '#eff6ff' },
  error:        { label: 'Error',          color: '#dc2626', bg: '#fef2f2' },
};

export default function LegalTrackerCard({ config, tasks, onConnect, onSync, onDisconnect, onOpenTracker, syncing }) {
  const [dragging, setDragging] = useState(false);
  const dropRef = useRef(null);

  const isConnected = Boolean(config);
  const watchStatus = config?.watchStatus || 'needs_resync';
  const statusMeta  = STATUS_LABELS[syncing ? 'syncing' : watchStatus] || STATUS_LABELS.needs_resync;

  const activeTasks    = tasks.filter(t => t.appStatus !== 'completed').length;
  const completedTasks = tasks.filter(t => t.appStatus === 'completed').length;
  const warnings       = config?.warnings?.length || 0;

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.name.endsWith('.xlsx')) return;
    onConnect?.('drop');
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave() {
    setDragging(false);
  }

  if (!isDesktop()) {
    return (
      <div className="ltc ltc--not-available">
        <div className="ltc__desktop-only-icon">🖥️</div>
        <div>
          <p className="ltc__title">Legal Tracker — Desktop Only</p>
          <p className="ltc__sub">Open ContractIQ Desktop to connect your Legal Tracker spreadsheet.</p>
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div
        ref={dropRef}
        className={`ltc ltc--disconnected${dragging ? ' ltc--dragging' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="ltc__icon">📊</div>
        <div className="ltc__body">
          <p className="ltc__title">Legal Tracker Not Connected</p>
          <p className="ltc__sub">
            Drag and drop your Legal Tracker Excel spreadsheet here, or choose it from your Legal Folder.
          </p>
          <div className="ltc__actions">
            <button className="ltc__btn ltc__btn--primary" onClick={() => onConnect?.('choose')}>
              Choose Legal Tracker
            </button>
            <button className="ltc__btn ltc__btn--ghost" onClick={() => {}}>
              View Expected Format
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ltc ltc--connected">
      <div className="ltc__connected-header">
        <div className="ltc__connected-title-row">
          <span className="ltc__workbook-icon">📊</span>
          <div>
            <p className="ltc__workbook-name">{config.workbookName}.xlsx</p>
            <p className="ltc__sheet-name">Sheet: {config.sheetName}</p>
          </div>
          <span className="ltc__watch-badge" style={{ background: statusMeta.bg, color: statusMeta.color }}>
            {statusMeta.label}
          </span>
        </div>
        <div className="ltc__meta-row">
          <MetaBit label="Rows imported"   value={config.rowsImported ?? tasks.length} />
          <MetaBit label="Active tasks"    value={activeTasks} />
          <MetaBit label="Completed"       value={completedTasks} />
          {warnings > 0 && <MetaBit label="Warnings" value={warnings} warn />}
          <MetaBit label="Last synced" value={config.lastSyncedAt
            ? new Date(config.lastSyncedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
            : '—'} />
        </div>
      </div>
      <div className="ltc__connected-actions">
        <button className="ltc__btn ltc__btn--primary" onClick={onSync} disabled={syncing}>
          {syncing ? 'Syncing…' : '↻ Sync Now'}
        </button>
        <button className="ltc__btn ltc__btn--ghost" onClick={onOpenTracker}>
          Open Tracker
        </button>
        <button className="ltc__btn ltc__btn--ghost" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
    </div>
  );
}

function MetaBit({ label, value, warn }) {
  return (
    <span className={`ltc__meta-bit${warn ? ' ltc__meta-bit--warn' : ''}`}>
      <span className="ltc__meta-val">{value}</span>
      <span className="ltc__meta-lbl">{label}</span>
    </span>
  );
}
