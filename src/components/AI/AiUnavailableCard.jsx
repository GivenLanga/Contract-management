export default function AiUnavailableCard({ status, onRetry, onUseWithoutAi, onEnable, busy }) {
  const disabled = status?.status === 'disabled';

  return (
    <div className="ai-setup-card ai-setup-card--unavailable">
      <div className="ai-setup-card-header">
        <span className="ai-setup-kicker">{disabled ? 'AI disabled' : 'AI unavailable'}</span>
        <h2>{disabled ? 'The app is running without the AI assistant.' : 'The local AI model could not be downloaded or started.'}</h2>
        <p>
          {disabled
            ? 'You can turn local AI back on when you are ready to finish setup.'
            : status?.error || status?.message || 'You can retry the download, check your internet connection, or use the app without AI.'}
        </p>
      </div>

      {!disabled && (
        <ul className="ai-recovery-list">
          <li>Retry the download</li>
          <li>Check your internet connection</li>
          <li>Use the app without AI</li>
        </ul>
      )}

      <div className="ai-setup-actions">
        {disabled ? (
          <button type="button" className="ai-primary-btn" onClick={onEnable} disabled={busy}>
            Enable Local AI
          </button>
        ) : (
          <button type="button" className="ai-primary-btn" onClick={onRetry} disabled={busy}>
            Retry
          </button>
        )}
        {!disabled && (
          <button type="button" className="ai-secondary-btn" onClick={onUseWithoutAi} disabled={busy}>
            Use App Without AI
          </button>
        )}
      </div>
    </div>
  );
}
