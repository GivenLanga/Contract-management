import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getSigningDocuments, subscribeToSigning } from '../../services/signingStore';
import { selectSentWaitingSigningDocuments } from '../../services/signingDocumentSelectors';
import { documents, signing as signingApi } from '../../services/api';
import './SigningDashboard.css';

const STATUS_BADGE = {
  'Ready for Signature': { cls: 'sd-badge--ready', label: 'Ready' },
  Draft:                 { cls: 'sd-badge--ready', label: 'Ready' },
  'Pending Signature':  { cls: 'sd-badge--pending', label: 'Awaiting Signatures' },
  Signed:               { cls: 'sd-badge--signed',  label: 'Fully Signed' },
  Approved:             { cls: 'sd-badge--approved', label: 'Approved' },
  Declined:             { cls: 'sd-badge--declined', label: 'Declined' },
};

const isReadyForEnvelope = (doc) => doc?.status === 'Ready for Signature';
const envelopeRoute = (docId, mode) => `/signing/envelope/${docId}?mode=${mode}`;
const SIGNING_DASHBOARD_RETURN_STATE = {
  returnTo: '/signing',
  returnLabel: 'Signing',
};

const SIGNER_STATUS_META = {
  signed:     { cls: 'sd-signer-chip--signed',   icon: '✅', label: 'Signed' },
  rejected:   { cls: 'sd-signer-chip--rejected',  icon: '✖', label: 'Rejected' },
  declined:   { cls: 'sd-signer-chip--rejected',  icon: '✖', label: 'Declined' },
  viewed:     { cls: 'sd-signer-chip--viewed',    icon: '👁', label: 'Viewed' },
  not_signed: { cls: '',                           icon: '⏳', label: 'Pending' },
};

const signerStatusMeta = (signer) => {
  if (signer.signingStatus === 'signed') return SIGNER_STATUS_META.signed;
  if (signer.signingStatus === 'rejected' || signer.signingStatus === 'declined') return SIGNER_STATUS_META.rejected;
  if (signer.viewedAt) return SIGNER_STATUS_META.viewed;
  return SIGNER_STATUS_META.not_signed;
};

export default function SigningDashboard() {
  const { user, isManager } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('ready');
  const [docs, setDocs] = useState(() => getSigningDocuments());
  const [reminding, setReminding] = useState({});

  useEffect(() => {
    let cancelled = false;

    const mergeDocuments = (serverDocs = []) => {
      const localDocs = getSigningDocuments();
      const merged = new Map();
      serverDocs.forEach((doc) => merged.set(doc._id, doc));
      localDocs.forEach((doc) => {
        if (!merged.has(doc._id)) merged.set(doc._id, doc);
      });
      if (!cancelled) setDocs(Array.from(merged.values()));
    };

    const loadServerDocuments = () => {
      documents.list({ limit: 200 })
        .then((data) => mergeDocuments(data.documents || []))
        .catch(() => mergeDocuments());
    };

    loadServerDocuments();
    const unsubscribe = subscribeToSigning(loadServerDocuments);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const ready           = docs.filter((d) => isReadyForEnvelope(d));
  const pending         = docs.filter((d) => d.status === 'Pending Signature');
  const completed       = docs.filter((d) => d.status === 'Signed');
  const declined        = docs.filter((d) => d.status === 'Declined');
  const myPending = pending.filter((d) =>
    d.signingFields?.some((f) => (f.assignedTo === user?.email || !f.assignedTo) && !f.filled) ||
    !d.signingFields?.length
  );
  const waitingOnOthers = selectSentWaitingSigningDocuments(docs, { user, isManager });

  const tabs = [
    { key: 'ready',     label: 'Ready to Send',      count: ready.length,           icon: '📤' },
    { key: 'pending',   label: 'Needs My Signature',  count: myPending.length,       icon: '✍️' },
    { key: 'watching',  label: 'Sent — Waiting',      count: waitingOnOthers.length, icon: '⏳' },
    { key: 'completed', label: 'Completed',           count: completed.length,       icon: '✅' },
  ];

  const sigProgress = (doc) => {
    const total = doc.signingFields?.length || 0;
    const filled = doc.signingFields?.filter((f) => f.filled).length || 0;
    return total > 0 ? Math.round((filled / total) * 100) : 0;
  };

  const sendReminder = async (e, docId, signerEmail) => {
    e.stopPropagation();
    const key = `${docId}:${signerEmail}`;
    setReminding((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      await signingApi.remind(docId, signerEmail);
      setReminding((prev) => ({ ...prev, [key]: 'sent' }));
      setTimeout(() => setReminding((prev) => { const n = { ...prev }; delete n[key]; return n; }), 4000);
    } catch (err) {
      const msg = err?.response?.data?.error || 'Failed to send reminder';
      setReminding((prev) => ({ ...prev, [key]: 'error:' + msg }));
      setTimeout(() => setReminding((prev) => { const n = { ...prev }; delete n[key]; return n; }), 5000);
    }
  };

  const DocCard = ({ doc, showSignBtn, showPrepareBtn, showRemind }) => {
    const progress = sigProgress(doc);
    const badge = STATUS_BADGE[doc.status] || { cls: '', label: doc.status };
    const total = doc.signingFields?.length || 0;
    const filled = doc.signingFields?.filter((f) => f.filled).length || 0;
    const hasSingerList = Array.isArray(doc.signers) && doc.signers.length > 0;
    const openRoute = `/signing/view/${doc._id}`;
    const signRoute = `/signing/view/${doc._id}?mode=sign`;
    const prepareRoute = envelopeRoute(doc._id, 'prepare');

    return (
      <div className="sd-card" onClick={() => navigate(openRoute, { state: SIGNING_DASHBOARD_RETURN_STATE })}>
        <div className="sd-card-top">
          <div className="sd-card-icon">📄</div>
          <div className="sd-card-info">
            <div className="sd-card-name">{doc.name}</div>
            <div className="sd-card-meta">
              {doc.contract?.title ? <span>{doc.contract.title} · </span> : null}
              <span>Requested by {doc.uploadedBy?.name}</span>
              {doc.signingOrder === 'sequential' && (
                <span className="sd-order-badge">Sequential</span>
              )}
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

        {/* Per-signer status chips — prefer signers[] over signingFields[] */}
        {hasSingerList ? (
          <div className="sd-signers-row">
            {doc.signers.map((signer, i) => {
              const meta = signerStatusMeta(signer);
              const key = `${doc._id}:${signer.email}`;
              const reminderState = reminding[key];
              return (
                <div key={i} className="sd-signer-item">
                  <span className={`sd-signer-chip ${meta.cls}`} title={signer.email}>
                    {meta.icon} {signer.role || signer.name || signer.email}
                  </span>
                  {showRemind && signer.signingStatus !== 'signed' && signer.signingStatus !== 'rejected' && (
                    <button
                      className={`sd-remind-btn${reminderState === 'sent' ? ' sd-remind-btn--sent' : ''}`}
                      disabled={reminderState === 'loading' || reminderState === 'sent'}
                      onClick={(e) => sendReminder(e, doc._id, signer.email)}
                      title={`Send reminder to ${signer.email}`}
                    >
                      {reminderState === 'loading' ? '…'
                        : reminderState === 'sent' ? '✓ Sent'
                        : reminderState?.startsWith('error:') ? '⚠'
                        : '🔔'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : doc.signingFields?.length > 0 ? (
          <div className="sd-signers-row">
            {doc.signingFields.map((f, i) => (
              <span
                key={i}
                className={`sd-signer-chip${f.filled ? ' sd-signer-chip--signed' : ''}`}
                title={f.assignedTo || 'Any signer'}
              >
                {f.filled ? '✅' : '⏳'} {f.role || 'Signatory'}
              </span>
            ))}
          </div>
        ) : null}

        <div className="sd-card-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="sd-btn sd-btn--view"
            onClick={() => navigate(openRoute, { state: SIGNING_DASHBOARD_RETURN_STATE })}
          >
            View Document
          </button>
          {showPrepareBtn && (
            <button
              className="sd-btn sd-btn--send"
              onClick={() => navigate(prepareRoute)}
            >
              Upload For Signature
            </button>
          )}
          {showSignBtn && doc.status !== 'Signed' && (
            <button
              className="sd-btn sd-btn--sign"
              onClick={() => navigate(signRoute, { state: SIGNING_DASHBOARD_RETURN_STATE })}
            >
              ✍️ Sign Now
            </button>
          )}
          {isManager && (
            <button
              className="sd-btn sd-btn--audit"
              onClick={() => navigate(`/signing/view/${doc._id}?panel=activity`, { state: SIGNING_DASHBOARD_RETURN_STATE })}
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
    tab === 'ready'     ? ready :
    tab === 'pending'   ? myPending :
    tab === 'watching'  ? waitingOnOthers :
    completed;

  return (
    <div className="sd-page">
      <div className="sd-header">
        <div className="sd-header-left">
          <h1>Digital Signing</h1>
          <p>Prepare, sign, and track documents synced from the Legal Folder</p>
        </div>
      </div>

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
        {declined.length > 0 && (
          <div className="sd-stat sd-stat--declined">
            <div className="sd-stat-value">{declined.length}</div>
            <div className="sd-stat-label">Declined</div>
          </div>
        )}
      </div>

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

      {activeList.length === 0 ? (
        <div className="sd-empty">
          <div className="sd-empty-icon">
            {tab === 'ready' ? '📁' : tab === 'pending' ? '✅' : tab === 'watching' ? '⏳' : '📁'}
          </div>
          <h3>
            {tab === 'ready'     ? 'No Legal Folder documents ready'
              : tab === 'pending'   ? 'Nothing needs your signature'
              : tab === 'watching'  ? 'No documents sent out'
              : 'No completed signings yet'}
          </h3>
          <p>
            {tab === 'ready'     ? 'Sync a shared folder in Legal Folder, then documents will appear here for envelope setup.'
              : tab === 'pending'   ? 'When someone sends you a document to sign, it will appear here.'
              : tab === 'watching'  ? 'Documents you send for signing will appear here.'
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
              showPrepareBtn={tab === 'ready' && isManager && isReadyForEnvelope(doc)}
              showRemind={tab === 'watching' && isManager}
            />
          ))}
        </div>
      )}
    </div>
  );
}
