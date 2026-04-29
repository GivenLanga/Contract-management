import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getSigningDocument, requestSigning } from '../../services/signingStore';
import './SigningEnvelope.css';

const ROLES = [
  'Signatory',
  'Party 1',
  'Party 2',
  'Client',
  'Service Provider',
  'Provider',
  'Beneficiary',
  'Company',
  'Consultant',
  'Lender',
  'Borrower',
  'Witness',
  'Director',
  'Company Secretary',
  'Other',
];

const signersFromDocument = (doc) => {
  const roles = doc?.inferredSignerRoles?.length
    ? doc.inferredSignerRoles
    : doc?.signingFields?.map((field) => field.role).filter(Boolean);

  return (roles?.length ? roles : ['Party 1', 'Party 2']).map((role) => ({
    name: '',
    email: '',
    role,
    type: 'external',
    userId: '',
  }));
};

export default function SigningEnvelope() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [doc] = useState(() => getSigningDocument(docId));
  const [internalUsers] = useState(() => user?.email
    ? [{ _id: user._id || user.email, name: user.name || user.email, email: user.email }]
    : []);
  const [signers, setSigners] = useState(() => signersFromDocument(getSigningDocument(docId)));
  const [signingOrder, setSigningOrder] = useState('parallel'); // parallel | sequential
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const addSigner = () => {
    setSigners((s) => [...s, { name: '', email: '', role: 'Signatory', type: 'external', userId: '' }]);
  };

  const removeSigner = (i) => {
    setSigners((s) => s.filter((_, idx) => idx !== i));
  };

  const updateSigner = (i, field, value) => {
    setSigners((s) => {
      const next = [...s];
      next[i] = { ...next[i], [field]: value };
      // Auto-fill name/email when selecting an internal user
      if (field === 'userId' && value) {
        const u = internalUsers.find((u) => u._id === value);
        if (u) { next[i].name = u.name; next[i].email = u.email; next[i].type = 'internal'; }
      }
      return next;
    });
  };

  const handleSend = async (e) => {
    e.preventDefault();
    setError('');
    const invalid = signers.find((s) => !s.email || !s.name);
    if (invalid) {
      setError('All signers must have a name and email address.');
      return;
    }
    setSending(true);
    try {
      const fields = signers.map((s, i) => ({
        id: `field_${i}`,
        type: 'signature',
        page: 0,
        x: 100,
        y: 200 + i * 120,
        width: 220,
        height: 80,
        assignedTo: s.email,
        role: s.role,
        required: true,
        filled: false,
      }));

      requestSigning(docId, {
        signers: signers.map((s) => ({
          name: s.name,
          email: s.email,
          role: s.role,
          userId: s.userId || undefined,
        })),
        fields,
        signingOrder,
        message,
      }, user);

      navigate(`/signing/view/${docId}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  if (!doc) {
    return (
      <div className="env-loading">
        <p>Document not found. Sync Legal Folder first.</p>
        <button className="env-back" onClick={() => navigate('/signing')}>Back to Signing</button>
      </div>
    );
  }

  return (
    <div className="env-root">
      <div className="env-header">
        <button className="env-back" onClick={() => navigate('/signing')}>← Back</button>
        <div className="env-header-title">
          <h1>Send for Signature</h1>
          <p>Configure who needs to sign <strong>{doc?.name}</strong></p>
        </div>
      </div>

      <div className="env-body">
        {/* Document card */}
        <div className="env-doc-card">
          <span className="env-doc-icon">{doc?.type === 'pdf' ? '📄' : '📝'}</span>
          <div className="env-doc-info">
            <div className="env-doc-name">{doc?.name}</div>
            <div className="env-doc-meta">
              {doc?.type?.toUpperCase()} · {doc?.contract?.title || 'No contract linked'}
              · Uploaded by {doc?.uploadedBy?.name}
            </div>
          </div>
          <span className="env-doc-status">{doc?.status}</span>
        </div>

        <form className="env-form" onSubmit={handleSend}>
          {error && <div className="env-error">{error}</div>}

          {/* Signing order */}
          <div className="env-section">
            <h2 className="env-section-title">Signing Order</h2>
            <div className="env-order-options">
              {[
                { value: 'parallel', label: 'Everyone at once', desc: 'All signers receive the document simultaneously', icon: '⚡' },
                { value: 'sequential', label: 'One at a time', desc: 'Each signer receives it after the previous one signs', icon: '→' },
              ].map((o) => (
                <label
                  key={o.value}
                  className={`env-order-card${signingOrder === o.value ? ' env-order-card--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="signingOrder"
                    value={o.value}
                    checked={signingOrder === o.value}
                    onChange={() => setSigningOrder(o.value)}
                    hidden
                  />
                  <span className="env-order-icon">{o.icon}</span>
                  <div>
                    <div className="env-order-label">{o.label}</div>
                    <div className="env-order-desc">{o.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Signers */}
          <div className="env-section">
            <div className="env-section-header">
              <h2 className="env-section-title">Signers</h2>
              <button type="button" className="env-add-btn" onClick={addSigner}>
                + Add Signer
              </button>
            </div>

            <div className="env-signers-list">
              {signers.map((signer, i) => (
                <div key={i} className="env-signer-row">
                  <div className="env-signer-number">{i + 1}</div>

                  <div className="env-signer-fields">
                    <div className="env-field-row">
                      <div className="env-field">
                        <label>Type</label>
                        <select
                          value={signer.type}
                          onChange={(e) => updateSigner(i, 'type', e.target.value)}
                        >
                          <option value="internal">Internal staff</option>
                          <option value="external">External party</option>
                        </select>
                      </div>

                      {signer.type === 'internal' ? (
                        <div className="env-field env-field--grow">
                          <label>Select User</label>
                          <select
                            value={signer.userId}
                            onChange={(e) => updateSigner(i, 'userId', e.target.value)}
                            required
                          >
                            <option value="">Choose a team member...</option>
                            {internalUsers.map((u) => (
                              <option key={u._id} value={u._id}>
                                {u.name} — {u.email}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <>
                          <div className="env-field env-field--grow">
                            <label>Full Name *</label>
                            <input
                              value={signer.name}
                              onChange={(e) => updateSigner(i, 'name', e.target.value)}
                              placeholder="e.g. John Smith"
                              required
                            />
                          </div>
                          <div className="env-field env-field--grow">
                            <label>Email Address *</label>
                            <input
                              type="email"
                              value={signer.email}
                              onChange={(e) => updateSigner(i, 'email', e.target.value)}
                              placeholder="john@company.com"
                              required
                            />
                          </div>
                        </>
                      )}

                      <div className="env-field">
                        <label>Role</label>
                        <select value={signer.role} onChange={(e) => updateSigner(i, 'role', e.target.value)}>
                          {ROLES.map((r) => <option key={r}>{r}</option>)}
                        </select>
                      </div>

                      {signers.length > 1 && (
                        <button
                          type="button"
                          className="env-remove-btn"
                          onClick={() => removeSigner(i)}
                          title="Remove signer"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {signer.email && (
                      <div className="env-signer-preview">
                        <div className="env-signer-avatar">
                          {(signer.name || signer.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="env-signer-preview-info">
                          <span className="env-signer-preview-name">{signer.name || '(no name)'}</span>
                          <span className="env-signer-preview-email">{signer.email}</span>
                        </div>
                        <span className="env-signer-preview-role">{signer.role}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Personal message */}
          <div className="env-section">
            <h2 className="env-section-title">Message to Signers <span className="env-optional">(optional)</span></h2>
            <textarea
              className="env-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Please review and sign this document at your earliest convenience..."
            />
          </div>

          {/* Signing flow preview */}
          <div className="env-section">
            <h2 className="env-section-title">Signing Flow Preview</h2>
            <div className="env-flow-preview">
              <div className="env-flow-step env-flow-step--done">
                <div className="env-flow-dot env-flow-dot--done">✓</div>
                <div className="env-flow-label">Document prepared by {user?.name}</div>
              </div>
              {signers.map((s, i) => (
                <div key={i} className="env-flow-step">
                  <div className="env-flow-dot">{i + 1}</div>
                  <div className="env-flow-label">
                    {s.name || s.email || `Signer ${i + 1}`}
                    {s.role && <span className="env-flow-role"> · {s.role}</span>}
                  </div>
                </div>
              ))}
              <div className="env-flow-step">
                <div className="env-flow-dot env-flow-dot--final">⚖</div>
                <div className="env-flow-label">Document fully executed — moved to Legal Folder</div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="env-footer">
            <button type="button" className="env-btn env-btn--cancel" onClick={() => navigate('/signing')}>
              Cancel
            </button>
            <button type="submit" className="env-btn env-btn--send" disabled={sending}>
              {sending ? 'Sending...' : `✉ Send to ${signers.length} Signer${signers.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
