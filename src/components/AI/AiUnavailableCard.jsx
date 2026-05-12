export default function AiUnavailableCard({ status, onRetry, onUseWithoutAi, onEnable, busy }) {
  const disabled = status?.status === 'disabled';
  const errors = status?.model?.errors || status?.localVerification?.errors || [];
  const primaryError = errors[0] || status?.error || status?.message;
  const wrongFormat = /GGUF|safetensors|format/i.test(primaryError || '');
  const toolCallFailed = /tool-call/i.test(primaryError || '');

  return (
    <div className="ai-setup-card ai-setup-card--unavailable">
      <div className="ai-setup-card-header">
        <span className="ai-setup-kicker">{disabled ? 'AI disabled' : 'AI unavailable'}</span>
        <h2>
          {disabled
            ? 'The app is running without the AI assistant.'
            : wrongFormat
            ? 'This runtime expects a GGUF model.'
            : toolCallFailed
            ? 'The local model failed the tool-call format test.'
            : 'The local AI model is not ready.'}
        </h2>
        <p>
          {disabled
            ? 'You can turn local AI back on when you are ready to finish setup.'
            : primaryError || 'Cloud AI is disabled, so no remote provider was used.'}
        </p>
      </div>

      {!disabled && (
        <ul className="ai-recovery-list">
          <li>{wrongFormat ? 'Select or download a compatible GGUF model' : 'Verify the local model file'}</li>
          <li>{toolCallFailed ? 'Use a model with stricter JSON/tool-call formatting' : 'Check the local runtime configuration'}</li>
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
