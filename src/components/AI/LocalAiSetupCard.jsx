function formatBytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 0.8) return `About ${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `About ${Math.round(value / (1024 * 1024))} MB`;
}

function sourceLabel(value) {
  if (value === 'huggingface_download') return 'Hugging Face download';
  if (value === 'local_file') return 'Local file';
  return value || 'Configured local source';
}

export default function LocalAiSetupCard({ status, onDownload, onUseWithoutAi, busy }) {
  const resumed = status?.status === 'download_paused';

  return (
    <div className="ai-setup-card">
      <div className="ai-setup-card-header">
        <span className="ai-setup-kicker">Local AI Assistant Setup</span>
        <h2>
          {resumed
            ? 'Download paused — ready to resume.'
            : 'This app can run the assistant locally on your device.'}
        </h2>
        <p>
          {resumed
            ? 'Your progress is saved. Click Resume to continue from where you left off.'
            : 'Your contract data stays on this computer. No prompts, documents, RAG snippets, signing data, or workflow data are sent to cloud AI.'}
        </p>
      </div>

      <div className="ai-setup-grid">
        <div>
          <span>Model</span>
          <strong>{status?.activeModelDisplayName || 'Qwen 2.5 7B Instruct Q4'}</strong>
        </div>
        <div>
          <span>Download size</span>
          <strong>{formatBytes(status?.downloadSizeBytes)}</strong>
        </div>
        <div>
          <span>Model source</span>
          <strong>{sourceLabel(status?.modelSource)}</strong>
        </div>
        <div>
          <span>Runtime</span>
          <strong>{status?.runtime || 'Local runtime'}</strong>
        </div>
        <div>
          <span>Cloud AI</span>
          <strong>{status?.cloudEnabled ? 'Enabled' : 'Disabled'}</strong>
        </div>
        <div className="ai-setup-grid-wide">
          <span>Storage location</span>
          <strong>{status?.storageDir || status?.modelsDir || 'App models directory'}</strong>
        </div>
      </div>

      <div className="ai-setup-actions">
        <button type="button" className="ai-primary-btn" onClick={onDownload} disabled={busy}>
          {resumed ? 'Resume Download' : 'Download Model'}
        </button>
        <button type="button" className="ai-secondary-btn" onClick={onUseWithoutAi} disabled={busy}>
          Use App Without AI
        </button>
      </div>
    </div>
  );
}
