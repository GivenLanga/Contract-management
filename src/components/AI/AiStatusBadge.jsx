const STATUS_LABELS = {
  idle: 'Checking local AI',
  checking: 'Checking local AI',
  not_installed: 'Setup required',
  downloading: 'Downloading model',
  download_paused: 'Download paused',
  verifying: 'Verifying model',
  installed: 'Model installed',
  starting: 'Starting local AI',
  ready: 'Local AI ready',
  error: 'AI unavailable',
  disabled: 'AI disabled',
};

export default function AiStatusBadge({ status }) {
  const state = status?.status || 'checking';
  const label = STATUS_LABELS[state] || 'Checking local AI';

  return (
    <div className={`ai-runtime-badge ai-runtime-badge--${state}`} aria-label={`Assistant status: ${label}`}>
      <span className="ai-runtime-badge-dot" />
      <span>{label}</span>
    </div>
  );
}
