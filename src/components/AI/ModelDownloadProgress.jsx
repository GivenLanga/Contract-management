import { useEffect, useRef, useState } from 'react';

function formatBytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60)  return `${seconds}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return `${h}h ${m}m left`;
}

// Stall = no new bytes for 2 consecutive polls (~5 s)
const STALL_POLLS = 2;

export default function ModelDownloadProgress({ status, onCancel, busy }) {
  const progress    = status?.progress || {};
  const isDownloading = status?.status === 'downloading';

  const percentage    = Math.max(0, Math.min(100, progress.percentage || 0));
  const fillPct       = progress.downloadedBytes > 0 && percentage < 1 ? 2 : percentage;
  const eta           = formatEta(progress.estimatedSecondsRemaining);
  const speedMBs      = progress.speedBytesPerSecond > 0
    ? `${formatBytes(progress.speedBytesPerSecond)}/s`
    : null;

  // Stall detection
  const prevBytesRef   = useRef(null);
  const stalledCountRef = useRef(0);
  const [stallState, setStallState] = useState('active'); // 'active' | 'stalled' | 'resumed'
  const resumedTimerRef = useRef(null);

  useEffect(() => {
    if (!isDownloading) {
      stalledCountRef.current = 0;
      prevBytesRef.current = null;
      setStallState('active');
      return;
    }

    const current = progress.downloadedBytes || 0;

    if (prevBytesRef.current === null) {
      prevBytesRef.current = current;
      return;
    }

    if (current > prevBytesRef.current) {
      // Bytes advanced — clear any stall
      if (stalledCountRef.current >= STALL_POLLS) {
        // Was stalled, now resumed
        setStallState('resumed');
        clearTimeout(resumedTimerRef.current);
        resumedTimerRef.current = setTimeout(() => setStallState('active'), 4000);
      } else {
        setStallState('active');
      }
      stalledCountRef.current = 0;
    } else {
      stalledCountRef.current += 1;
      if (stalledCountRef.current >= STALL_POLLS) setStallState('stalled');
    }

    prevBytesRef.current = current;
  }, [progress.downloadedBytes, isDownloading]);

  useEffect(() => () => clearTimeout(resumedTimerRef.current), []);

  const barClass = isDownloading
    ? `ai-progress-fill ai-progress-fill--${stallState}`
    : 'ai-progress-fill';

  return (
    <div className="ai-setup-card ai-setup-card--progress">
      <div className="ai-setup-card-header">
        <span className="ai-setup-kicker">Local AI Assistant Setup</span>
        <h2>
          {isDownloading
            ? stallState === 'stalled'
              ? 'Download interrupted — retrying automatically…'
              : stallState === 'resumed'
              ? 'Download resumed'
              : 'Downloading local AI model…'
            : status?.message || 'Preparing local AI…'}
        </h2>
      </div>

      {isDownloading ? (
        <>
          {/* Bytes / percentage row */}
          <div className="ai-progress-meta">
            <span>
              {formatBytes(progress.downloadedBytes)}
              <span className="ai-progress-meta-sep"> / </span>
              {formatBytes(progress.totalBytes || status?.downloadSizeBytes)}
            </span>
            <strong className={stallState === 'stalled' ? 'ai-progress-pct--stalled' : ''}>
              {progress.downloadedBytes > 0 && percentage < 1 ? '<1' : percentage}%
            </strong>
          </div>

          {/* Progress bar */}
          <div
            className="ai-progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percentage}
            aria-label={`Download ${percentage}% complete`}
          >
            <span className={barClass} style={{ width: `${fillPct}%` }} />
          </div>

          {/* Status row */}
          <div className="ai-progress-status-row">
            {stallState === 'stalled' && (
              <span className="ai-progress-stall-badge">
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="9" stroke="#f59e0b" strokeWidth="2"/>
                  <path d="M10 6v4" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="10" cy="14" r="1" fill="#f59e0b"/>
                </svg>
                No data received — will resume automatically
              </span>
            )}
            {stallState === 'resumed' && (
              <span className="ai-progress-resume-badge">
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="9" stroke="#22c55e" strokeWidth="2"/>
                  <path d="M6 10l3 3 5-5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Download resumed
              </span>
            )}
            {stallState === 'active' && (
              <span className="ai-progress-subtext">
                {[speedMBs, eta].filter(Boolean).join('  ·  ') || 'Starting…'}
              </span>
            )}
          </div>

          <div className="ai-setup-actions">
            <button
              type="button"
              className="ai-secondary-btn"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel download
            </button>
          </div>
        </>
      ) : (
        <div className="ai-progress-track ai-progress-track--indeterminate" aria-hidden="true">
          <span className="ai-progress-fill" />
        </div>
      )}
    </div>
  );
}
