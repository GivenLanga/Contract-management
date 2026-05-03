import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ai as aiApi } from '../../services/api';
import AiStatusBadge from './AiStatusBadge';
import LocalAiSetupCard from './LocalAiSetupCard';
import ModelDownloadProgress from './ModelDownloadProgress';
import AiUnavailableCard from './AiUnavailableCard';
import { syncLegalFolderRagIndex } from '../../services/legalFolderRagSync';
import { syncSigningStateIndex } from '../../services/signingStateSync';
import './AIAssistant.css';

const SESSION_KEY = 'ai_session_id';

function getSessionId() {
  let sid = sessionStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderResultData(data) {
  if (!data) return null;

  // Contracts list
  if (data.contracts?.length) {
    return (
      <div className="ai-results">
        <div className="ai-results-label">
          Found {data.contracts.length} contract{data.contracts.length !== 1 ? 's' : ''}
        </div>
        {data.contracts.map((c) => (
          <div key={c._id} className="ai-result-item">
            <span className="ai-result-icon" aria-hidden="true">📋</span>
            <div className="ai-result-details">
              <div className="ai-result-name">{c.title}</div>
              <div className="ai-result-meta">
                {[c.contractId, c.status, c.expiryDate && `Expires ${new Date(c.expiryDate).toLocaleDateString()}`]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Documents list
  if (data.documents?.length) {
    return (
      <div className="ai-results">
        <div className="ai-results-label">
          Found {data.documents.length} document{data.documents.length !== 1 ? 's' : ''}
        </div>
        {data.documents.map((d) => (
          <div key={d._id} className="ai-result-item">
            <span className="ai-result-icon" aria-hidden="true">
              {d.type === 'pdf' ? '📄' : '📝'}
            </span>
            <div className="ai-result-details">
              <div className="ai-result-name">{d.name}</div>
              <div className="ai-result-meta">
                {[d.type?.toUpperCase(), d.status, d.contract].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Tasks list
  if (data.tasks?.length) {
    return (
      <div className="ai-results">
        <div className="ai-results-label">
          {data.tasks.length} task{data.tasks.length !== 1 ? 's' : ''}
        </div>
        {data.tasks.map((t) => (
          <div key={t._id} className="ai-result-item">
            <span className="ai-result-icon" aria-hidden="true">✅</span>
            <div className="ai-result-details">
              <div className="ai-result-name">{t.title}</div>
              <div className="ai-result-meta">
                {[t.priority, t.status, t.deadline && `Due ${new Date(t.deadline).toLocaleDateString()}`]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Notifications list
  if (data.notifications?.length) {
    return (
      <div className="ai-results">
        <div className="ai-results-label">
          {data.notifications.length} notification{data.notifications.length !== 1 ? 's' : ''}
        </div>
        {data.notifications.map((n) => (
          <div key={n._id} className="ai-result-item">
            <span className="ai-result-icon" aria-hidden="true">{n.read ? '✓' : '!'}</span>
            <div className="ai-result-details">
              <div className="ai-result-name">{n.title}</div>
              <div className="ai-result-meta">
                {[
                  n.read ? 'Read' : 'Unread',
                  n.priority,
                  n.relatedTo?.label,
                  n.createdAt && new Date(n.createdAt).toLocaleString(),
                ].filter(Boolean).join(' · ')}
              </div>
              {n.message && <div className="ai-result-meta">{n.message}</div>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Signers / signing status
  if (data.signers?.length) {
    return (
      <div className="ai-results">
        <div className="ai-results-label">
          Signers — {data.completedSigners}/{data.totalSigners} completed
        </div>
        {data.signers.map((s, i) => (
          <div key={i} className="ai-result-item">
            <span className="ai-result-icon" aria-hidden="true">{s.signed ? '✅' : '⏳'}</span>
            <div className="ai-result-details">
              <div className="ai-result-name">{s.name}</div>
              <div className="ai-result-meta">
                {s.role} · {s.signed ? `Signed ${new Date(s.signedAt).toLocaleDateString()}` : 'Pending'}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Help capabilities
  if (data.capabilities?.length) {
    return (
      <div className="ai-results">
        <div className="ai-results-label">{data.message}</div>
        {data.capabilities.map((c, i) => (
          <div key={i} className="ai-result-item ai-result-item--compact">
            <span className="ai-result-icon" aria-hidden="true">→</span>
            <div className="ai-result-details">
              <div className="ai-result-meta">{c.description}</div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Empty list responses are already covered by the message text.
  if (data.message && (
    (Array.isArray(data.tasks) && data.tasks.length === 0) ||
    (Array.isArray(data.documents) && data.documents.length === 0) ||
    (Array.isArray(data.contracts) && data.contracts.length === 0) ||
    (Array.isArray(data.notifications) && data.notifications.length === 0)
  )) {
    return null;
  }

  // Generic count/summary
  if (typeof data.count === 'number' || typeof data.pending === 'number') {
    return (
      <div className="ai-summary-chips">
        {Object.entries(data).map(([k, v]) =>
          typeof v === 'number' ? (
            <span key={k} className="ai-summary-chip">
              <strong>{v}</strong> {k.replace(/_/g, ' ')}
            </span>
          ) : null
        )}
      </div>
    );
  }

  return null;
}

export default function AIAssistant() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: "Hello! I'm your AI legal assistant. I can help you search contracts, check expiring agreements, manage tasks, review signing status, read notifications, and navigate the app. What would you like to know?",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const sessionId               = useRef(getSessionId());
  const messagesEndRef          = useRef(null);
  const inputRef                = useRef(null);
  const startInFlightRef        = useRef(false);
  const assistantReady          = aiStatus?.status === 'ready';

  const refreshAiStatus = useCallback(async () => {
    try {
      const status = await aiApi.status();
      setAiStatus(status);
      return status;
    } catch (err) {
      setAiStatus({
        status: 'error',
        mode: 'local',
        message: 'AI status could not be loaded.',
        error: err.message,
      });
      return null;
    }
  }, []);

  useEffect(() => {
    aiApi.suggestions().then((d) => setSuggestions(d.suggestions || [])).catch(() => {});
    syncLegalFolderRagIndex().catch(() => {});
    syncSigningStateIndex().catch(() => {});
  }, []);

  useEffect(() => {
    refreshAiStatus();
  }, [refreshAiStatus]);

  useEffect(() => {
    // Depend on the full aiStatus object (always a new reference after each fetch)
    // so the timer re-schedules after every poll, not just on status string changes.
    const fastStates = ['downloading', 'verifying', 'starting'];
    const midStates  = ['idle', 'checking', 'installed'];
    let delay;
    if (fastStates.includes(aiStatus?.status)) delay = 2500;
    else if (midStates.includes(aiStatus?.status)) delay = 5000;
    else delay = 30000;
    const timer = setTimeout(refreshAiStatus, delay);
    return () => clearTimeout(timer);
  }, [aiStatus, refreshAiStatus]);

  useEffect(() => {
    if (aiStatus?.status !== 'installed' || startInFlightRef.current || !aiStatus.activeModelId) return;

    let cancelled = false;
    startInFlightRef.current = true;
    setStatusBusy(true);
    aiApi.start(aiStatus.activeModelId)
      .then((status) => {
        if (!cancelled) setAiStatus(status);
      })
      .catch((err) => {
        if (!cancelled) {
          setAiStatus((prev) => ({
            ...(prev || {}),
            status: 'error',
            message: 'Local AI could not be started.',
            error: err.message,
          }));
        }
      })
      .finally(() => {
        startInFlightRef.current = false;
        if (!cancelled) setStatusBusy(false);
      });

    return () => { cancelled = true; };
  }, [aiStatus?.status, aiStatus?.activeModelId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const resetInputHeight = () => {
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const pushMessage = (msg) => setMessages((prev) => [...prev, msg]);

  const sendQuery = async (query) => {
    if (!query.trim() || loading || !assistantReady) return;
    setInput('');
    resetInputHeight();
    pushMessage({ role: 'user', text: query, timestamp: new Date() });
    setLoading(true);

    try {
      const result = await aiApi.chat(query, sessionId.current);
      sessionId.current = result.sessionId || sessionId.current;
      handleResult(result);
    } catch (err) {
      pushMessage({
        role: 'assistant',
        text: err.message || 'Sorry, I encountered an error. Please try again.',
        timestamp: new Date(),
        isError: true,
      });
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleResult = (result) => {
    const ts = new Date();

    if (result.type === 'navigation') {
      pushMessage({
        role: 'assistant',
        text: result.data?.message || `Navigating to ${result.data?.label}…`,
        timestamp: ts,
        navigationPath: result.data?.path,
        navigationLabel: result.data?.label,
      });
      setTimeout(() => navigate(result.data.path), 600);
      return;
    }

    if (result.type === 'confirmation_required') {
      pushMessage({
        role: 'assistant',
        text: result.message,
        timestamp: ts,
        confirmationId: result.confirmationId,
        toolName: result.toolName,
        confirmArgs: result.args,
      });
      return;
    }

    if (result.type === 'error') {
      pushMessage({ role: 'assistant', text: result.message, timestamp: ts, isError: true });
      return;
    }

    if (result.type === 'not_found') {
      pushMessage({ role: 'assistant', text: result.message, timestamp: ts });
      return;
    }

    if (result.type === 'clarification') {
      pushMessage({ role: 'assistant', text: result.content, timestamp: ts });
      return;
    }

    if (result.type === 'message') {
      pushMessage({ role: 'assistant', text: result.content, timestamp: ts });
      return;
    }

    // success — may have structured data
    const summary = buildSummaryText(result);
    pushMessage({
      role: 'assistant',
      text: summary,
      timestamp: ts,
      data: result.data,
    });
  };

  const buildSummaryText = (result) => {
    const d = result.data;
    if (!d) return 'Done.';
    if (typeof d.count === 'number' && d.days) return `${d.count} contract${d.count !== 1 ? 's' : ''} expiring within ${d.days} days.`;
    if (d.message) return d.message;
    if (d.contracts?.length) return `Found ${d.contracts.length} contract${d.contracts.length !== 1 ? 's' : ''}.`;
    if (d.documents?.length) return `Found ${d.documents.length} document${d.documents.length !== 1 ? 's' : ''}.`;
    if (d.tasks?.length) return `Found ${d.tasks.length} task${d.tasks.length !== 1 ? 's' : ''}.`;
    if (d.notifications?.length) return d.message || `Found ${d.notifications.length} notification${d.notifications.length !== 1 ? 's' : ''}.`;
    if (d.summary) return `${d.summary.title} — ${d.summary.status}, ${d.summary.value}`;
    if (d.title && d.parties) return `${d.title} — ${d.parties?.length || 0} parties.`;
    if (typeof d.count === 'number') return `Total: ${d.count}.`;
    if (d.pending !== undefined) return `Tasks: ${d.pending} pending, ${d.inProgress} in progress, ${d.overdue} overdue.`;
    if (d.drafters?.length) return `${d.drafters.length} user${d.drafters.length !== 1 ? 's' : ''} currently drafting.`;
    return 'Here are the results:';
  };

  const handleConfirm = async (confirmationId) => {
    setLoading(true);
    try {
      const result = await aiApi.confirm(confirmationId);
      setMessages((prev) => prev.map((m) =>
        m.confirmationId === confirmationId ? { ...m, confirmationId: null, confirmed: true } : m
      ));
      handleResult(result);
    } catch {
      pushMessage({ role: 'assistant', text: 'Confirmation failed. Please try again.', timestamp: new Date(), isError: true });
    } finally {
      setLoading(false);
    }
  };

  const handleDismissConfirmation = (confirmationId) => {
    setMessages((prev) => prev.map((m) =>
      m.confirmationId === confirmationId ? { ...m, confirmationId: null, dismissed: true } : m
    ));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendQuery(input);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendQuery(input);
    }
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
  };

  const handleDownloadModel = async () => {
    if (!aiStatus?.activeModelId) return;
    setStatusBusy(true);
    try {
      const status = await aiApi.downloadModel(aiStatus.activeModelId);
      setAiStatus(status);
    } catch (err) {
      setAiStatus((prev) => ({
        ...(prev || {}),
        status: 'error',
        message: 'The local AI model could not be downloaded.',
        error: err.message,
      }));
    } finally {
      setStatusBusy(false);
    }
  };

  const handleCancelDownload = async () => {
    if (!aiStatus?.activeModelId) return;
    setStatusBusy(true);
    try {
      setAiStatus(await aiApi.cancelDownload(aiStatus.activeModelId));
    } finally {
      setStatusBusy(false);
    }
  };

  const handleUseWithoutAi = async () => {
    setStatusBusy(true);
    try {
      setAiStatus(await aiApi.disable());
    } finally {
      setStatusBusy(false);
    }
  };

  const handleEnableAi = async () => {
    setStatusBusy(true);
    try {
      setAiStatus(await aiApi.enable());
    } catch (err) {
      setAiStatus((prev) => ({
        ...(prev || {}),
        status: 'error',
        message: 'Local AI could not be enabled.',
        error: err.message,
      }));
    } finally {
      setStatusBusy(false);
    }
  };

  const renderSetupPanel = () => {
    if (!aiStatus) {
      return <ModelDownloadProgress status={{ status: 'checking', message: 'Checking local AI model...' }} />;
    }

    if (['idle', 'checking', 'verifying', 'installed', 'starting'].includes(aiStatus.status)) {
      return <ModelDownloadProgress status={aiStatus} />;
    }

    if (aiStatus.status === 'downloading') {
      return <ModelDownloadProgress status={aiStatus} onCancel={handleCancelDownload} busy={statusBusy} />;
    }

    if (['not_installed', 'download_paused'].includes(aiStatus.status)) {
      return (
        <LocalAiSetupCard
          status={aiStatus}
          onDownload={handleDownloadModel}
          onUseWithoutAi={handleUseWithoutAi}
          busy={statusBusy}
        />
      );
    }

    if (aiStatus.status === 'disabled') {
      return (
        <AiUnavailableCard
          status={aiStatus}
          onRetry={handleDownloadModel}
          onUseWithoutAi={handleUseWithoutAi}
          onEnable={handleEnableAi}
          busy={statusBusy}
        />
      );
    }

    if (aiStatus.status === 'error') {
      // If a download was in progress when the error occurred, show the setup card
      // so the user gets a clear "Resume Download" button rather than a generic error card.
      const downloadError = /download|model|HTTP|stall|cancelled/i.test(aiStatus.error || aiStatus.message || '');
      if (downloadError) {
        return (
          <LocalAiSetupCard
            status={{ ...aiStatus, status: 'download_paused' }}
            onDownload={handleDownloadModel}
            onUseWithoutAi={handleUseWithoutAi}
            busy={statusBusy}
          />
        );
      }
      return (
        <AiUnavailableCard
          status={aiStatus}
          onRetry={handleDownloadModel}
          onUseWithoutAi={handleUseWithoutAi}
          onEnable={handleEnableAi}
          busy={statusBusy}
        />
      );
    }

    return null;
  };

  return (
    <div className="ai-assistant">
      <div className="ai-header">
        <div className="ai-header-icon" aria-hidden="true">🤖</div>
        <div className="ai-header-text">
          <h1>AI Legal Assistant</h1>
          <p>
            {assistantReady
              ? `Model: ${aiStatus.activeModelDisplayName} | Mode: Local`
              : 'Ask questions about your contracts, tasks, and documents'}
          </p>
        </div>
        <AiStatusBadge status={aiStatus} />
      </div>

      <div className="ai-body">
        {aiStatus?.status !== 'ready' && (
          <div className="ai-setup-panel">
            {renderSetupPanel()}
          </div>
        )}

        <div
          className="ai-messages"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`ai-message ai-message--${msg.role}${msg.isError ? ' ai-message--error' : ''}`}
            >
              <div className="ai-message-avatar" aria-hidden="true">
                {msg.role === 'assistant' ? '🤖' : '👤'}
              </div>
              <div className="ai-message-content">
                <div className="ai-message-bubble">
                  <p>{msg.text}</p>
                </div>

                {/* Structured data results */}
                {msg.data && renderResultData(msg.data)}

                {/* Confirmation card */}
                {msg.confirmationId && !msg.confirmed && !msg.dismissed && (
                  <div className="ai-confirm-card" role="group" aria-label="Action confirmation">
                    <p className="ai-confirm-desc">
                      Do you want to proceed with: <strong>{msg.toolName?.replace(/_/g, ' ')}</strong>?
                    </p>
                    <div className="ai-confirm-actions">
                      <button
                        className="ai-confirm-btn ai-confirm-btn--yes"
                        onClick={() => handleConfirm(msg.confirmationId)}
                        disabled={loading}
                      >
                        Confirm
                      </button>
                      <button
                        className="ai-confirm-btn ai-confirm-btn--no"
                        onClick={() => handleDismissConfirmation(msg.confirmationId)}
                        disabled={loading}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Navigation action badge */}
                {msg.navigationPath && (
                  <div className="ai-nav-badge">
                    <span aria-hidden="true">→</span> Navigating to {msg.navigationLabel}…
                  </div>
                )}

                <div className="ai-message-time" aria-label={`Sent at ${formatTime(msg.timestamp)}`}>
                  {formatTime(msg.timestamp)}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="ai-message ai-message--assistant" aria-label="Assistant is typing">
              <div className="ai-message-avatar" aria-hidden="true">🤖</div>
              <div className="ai-message-content">
                <div className="ai-message-bubble ai-thinking" aria-label="Thinking">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {suggestions.length > 0 && messages.length <= 1 && (
          <div className="ai-suggestions" aria-label="Suggested prompts">
            <div className="ai-suggestions-label">Try asking:</div>
            <div className="ai-suggestion-chips">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  className="ai-suggestion-chip"
                  onClick={() => sendQuery(s)}
                  disabled={loading || !assistantReady}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <form className="ai-input-form" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className="ai-input"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={assistantReady ? 'Ask about contracts, tasks, documents, notifications, or signatures' : 'Finish local AI setup to use the assistant'}
            disabled={loading || !assistantReady}
            rows={1}
            aria-label="Message"
            aria-multiline="true"
          />
          <button
            type="submit"
            className="ai-send-btn"
            disabled={!input.trim() || loading || !assistantReady}
            aria-label="Send message"
          >
            {loading ? (
              <span className="ai-send-spinner" aria-hidden="true" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
