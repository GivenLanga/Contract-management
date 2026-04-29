import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getSigningDocuments, subscribeToSigning } from '../../services/signingStore';
import './SigningDashboard.css';

const STATUS_BADGE = {
  'Ready for Signature': { cls: 'sd-badge--ready', label: 'Ready' },
  'Pending Signature': { cls: 'sd-badge--pending', label: 'Awaiting Signatures' },
  Signed: { cls: 'sd-badge--signed', label: 'Fully Signed' },
  Approved: { cls: 'sd-badge--approved', label: 'Approved' },
};

export default function SigningDashboard() {
  const { user, isManager } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('ready');
  const [docs, setDocs] = useState(() => getSigningDocuments());

  useEffect(() => subscribeToSigning(() => setDocs(getSigningDocuments())), []);

  const ready = docs.filter((d) => d.status === 'Ready for Signature');
  const pending = docs.filter((d) => d.status === 'Pending Signature');
  const completed = docs.filter((d) => d.status === 'Signed');
  const myPending = pending.filter((d) =>
    d.signingFields?.some((f) => (f.assignedTo === user?.email || !f.assignedTo) && !f.filled) || !d.signingFields?.length
  );
  const waitingOnOthers = pending.filter((d) =>
    isManager ||
    (user?._id && d.uploadedBy?._id === user._id) ||
    (user?.email && d.uploadedBy?.email === user.email)
  );

  const tabs = [
    { key: 'ready', label: 'Ready to Send', count: ready.length, icon: '📤' },
    { key: 'pending', label: 'Needs My Signature', count: myPending.length, icon: '✍️' },
    { key: 'watching', label: 'Sent — Waiting', count: waitingOnOthers.length, icon: '⏳' },
    { key: 'completed', label: 'Completed', count: completed.length, icon: '✅' },
  ];

  const sigProgress = (doc) => {
    const total = doc.signingFields?.length || 0;
    const filled = doc.signingFields?.filter((f) => f.filled).length || 0;
    return total > 0 ? Math.round((filled / total) * 100) : 0;
  };

  const DocCard = ({ doc, showSignBtn, showPrepareBtn }) => {
    const progress = sigProgress(doc);
    const badge = STATUS_BADGE[doc.status] || { cls: '', label: doc.status };
    const total = doc.signingFields?.length || 0;
    const filled = doc.signingFields?.filter((f) => f.filled).length || 0;

    return (
      <div className="sd-card" onClick={() => navigate(`/signing/view/${doc._id}`)}>
        <div className="sd-card-top">
          <div className="sd-card-icon">📄</div>
          <div className="sd-card-info">
            <div className="sd-card-name">{doc.name}</div>
            <div className="sd-card-meta">
              {doc.contract?.title
                ? <span>{doc.contract.title} · </span>
                : null}
              <span>Requested by {doc.uploadedBy?.name}</span>
            </div>
          </div>
          <span className={`sd-badge ${badge.cls}`}>{badge.label}</span>
        </div>

        {total > 0 && (
          <div className="sd-progress-row">
            <div className="sd-progress-bar">
              <div className="sd-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="sd-progress-label">{filled}/{total} signed</span>
          </div>
        )}

        {doc.signingFields && doc.signingFields.length > 0 && (
          <div className="sd-signers-row">
            {doc.signingFields.map((f, i) => (
              <span
                key={i}
                className={`sd-signer-chip${f.filled ? ' sd-signer-chip--done' : ''}`}
                title={f.assignedTo || 'Any signer'}
              >
                {f.filled ? '✅' : '⏳'} {f.role || 'Signatory'}
              </span>
            ))}
          </div>
        )}

        <div className="sd-card-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="sd-btn sd-btn--view"
            onClick={() => navigate(`/signing/view/${doc._id}`)}
          >
            Open Signing Room
          </button>
          {showPrepareBtn && (
            <button
              className="sd-btn sd-btn--send"
              onClick={() => navigate(`/signing/envelope/${doc._id}`)}
            >
              Prepare Envelope
            </button>
          )}
          {showSignBtn && doc.status !== 'Signed' && (
            <button
              className="sd-btn sd-btn--sign"
              onClick={() => navigate(`/signing/view/${doc._id}`)}
            >
              ✍️ Sign Now
            </button>
          )}
          {isManager && doc.status !== 'Signed' && (
            <button
              className="sd-btn sd-btn--audit"
              onClick={() => navigate(`/signing/view/${doc._id}`)}
            >
              Audit Trail
            </button>
          )}
        </div>

        <div className="sd-card-date">
          Last updated: {new Date(doc.updatedAt).toLocaleDateString()}
        </div>
      </div>
    );
  };

  const activeList =
    tab === 'ready' ? ready :
    tab === 'pending' ? myPending :
    tab === 'watching' ? waitingOnOthers :
    completed;

  return (
    <div className="sd-page">
      <div className="sd-header">
        <div className="sd-header-left">
          <h1>Digital Signing</h1>
          <p>Prepare, sign, and track documents synced from the Legal Folder</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="sd-stats">
        <div className="sd-stat">
          <div className="sd-stat-value">{myPending.length}</div>
          <div className="sd-stat-label">Needs my signature</div>
        </div>
        <div className="sd-stat">
          <div className="sd-stat-value">{ready.length}</div>
          <div className="sd-stat-label">Ready to send</div>
        </div>
        <div className="sd-stat">
          <div className="sd-stat-value">{completed.length}</div>
          <div className="sd-stat-label">Completed</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="sd-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`sd-tab${tab === t.key ? ' sd-tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
            {t.count > 0 && <span className="sd-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeList.length === 0 ? (
        <div className="sd-empty">
          <div className="sd-empty-icon">
            {tab === 'ready' ? '📁' : tab === 'pending' ? '✅' : tab === 'watching' ? '⏳' : '📁'}
          </div>
          <h3>
            {tab === 'ready' ? 'No Legal Folder documents ready'
              : tab === 'pending' ? 'Nothing needs your signature'
              : tab === 'watching' ? 'No documents sent out'
              : 'No completed signings yet'}
          </h3>
          <p>
            {tab === 'ready' ? 'Sync a shared folder in Legal Folder, then documents will appear here for envelope setup.'
              : tab === 'pending' ? 'When someone sends you a document to sign, it will appear here.'
              : tab === 'watching' ? 'Documents you send for signing will appear here.'
              : 'Fully signed documents appear here.'}
          </p>
          {tab === 'ready' && (
            <button className="sd-btn sd-btn--send" onClick={() => navigate('/legal-folder')}>
              Open Legal Folder
            </button>
          )}
        </div>
      ) : (
        <div className="sd-grid">
          {activeList.map((doc) => (
            <DocCard
              key={doc._id}
              doc={doc}
              showSignBtn={tab === 'pending'}
              showPrepareBtn={tab === 'ready' && isManager}
            />
          ))}
        </div>
      )}
    </div>
  );
}
