import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ai as aiApi } from '../../services/api';
import './AIAssistant.css';

export default function AIAssistant() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: 'Hello! I\'m your AI legal assistant. I can help you find documents, search contract clauses, check expiry dates, and navigate your legal folder. What would you like to know?',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const messagesEndRef = useRef();

  useEffect(() => {
    aiApi.suggestions()
      .then((d) => setSuggestions(d.suggestions || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendQuery = async (query) => {
    if (!query.trim() || loading) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: query, timestamp: new Date() }]);
    setLoading(true);

    try {
      const result = await aiApi.query(query);
      const assistantMsg = {
        role: 'assistant',
        text: result.aiResponse || 'I found results for your query.',
        timestamp: new Date(),
        documents: result.documents || [],
        contracts: result.contracts || [],
        intent: result.intent,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: 'Sorry, I encountered an error processing your request. Please try again.',
        timestamp: new Date(),
        isError: true,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendQuery(input);
  };

  const formatTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="ai-assistant">
      <div className="ai-header">
        <div className="ai-header-icon">🤖</div>
        <div>
          <h1>AI Legal Assistant</h1>
          <p>Natural language document navigation powered by Qwen AI</p>
        </div>
        <div className="ai-status">
          <span className="ai-status-dot" />
          Online
        </div>
      </div>

      <div className="ai-body">
        <div className="ai-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`ai-message ai-message--${msg.role}${msg.isError ? ' ai-message--error' : ''}`}>
              <div className="ai-message-avatar">
                {msg.role === 'assistant' ? '🤖' : '👤'}
              </div>
              <div className="ai-message-content">
                <div className="ai-message-bubble">
                  <p>{msg.text}</p>
                </div>

                {msg.documents && msg.documents.length > 0 && (
                  <div className="ai-results">
                    <div className="ai-results-label">📁 Found {msg.documents.length} document{msg.documents.length !== 1 ? 's' : ''}</div>
                    {msg.documents.map((doc) => (
                      <Link
                        key={doc._id}
                        to="/legal-folder"
                        className="ai-doc-result"
                      >
                        <span className="ai-doc-icon">{doc.type === 'pdf' ? '📄' : '📝'}</span>
                        <div className="ai-doc-details">
                          <div className="ai-doc-name">{doc.name}</div>
                          <div className="ai-doc-meta">
                            {doc.type?.toUpperCase()} · {doc.status}
                            {doc.contract && ` · ${doc.contract.title}`}
                          </div>
                        </div>
                        <span className="ai-doc-arrow">→</span>
                      </Link>
                    ))}
                  </div>
                )}

                {msg.contracts && msg.contracts.length > 0 && (
                  <div className="ai-results">
                    <div className="ai-results-label">📋 Found {msg.contracts.length} contract{msg.contracts.length !== 1 ? 's' : ''}</div>
                    {msg.contracts.map((c) => (
                      <div key={c._id} className="ai-doc-result">
                        <span className="ai-doc-icon">📋</span>
                        <div className="ai-doc-details">
                          <div className="ai-doc-name">{c.title}</div>
                          <div className="ai-doc-meta">
                            {c.contractId} · Expires {c.expiryDate ? new Date(c.expiryDate).toLocaleDateString() : 'N/A'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="ai-message-time">{formatTime(msg.timestamp)}</div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="ai-message ai-message--assistant">
              <div className="ai-message-avatar">🤖</div>
              <div className="ai-message-content">
                <div className="ai-message-bubble ai-thinking">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {suggestions.length > 0 && messages.length <= 1 && (
          <div className="ai-suggestions">
            <div className="ai-suggestions-label">Try asking:</div>
            <div className="ai-suggestion-chips">
              {suggestions.map((s, i) => (
                <button key={i} className="ai-suggestion-chip" onClick={() => sendQuery(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <form className="ai-input-form" onSubmit={handleSubmit}>
          <input
            className="ai-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask me anything about your contracts and documents..."
            disabled={loading}
          />
          <button type="submit" className="ai-send-btn" disabled={!input.trim() || loading}>
            {loading ? '...' : '→'}
          </button>
        </form>
      </div>
    </div>
  );
}
