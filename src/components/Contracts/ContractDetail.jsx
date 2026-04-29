import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Header from '../Layout/Header';
import Badge from '../common/Badge';
import { getContractsForApp, LEGAL_FOLDER_UPDATED } from '../../services/legalFolderStore';
import './ContractDetail.css';

const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr) - new Date()) / 86400000);
};

const timeAgo = (d) => {
  const diff = Math.round((new Date() - new Date(d)) / 86400000);
  if (diff < 1) return 'today';
  if (diff === 1) return '1 day ago';
  if (diff < 7) return `${diff} days ago`;
  if (diff < 14) return '1 week ago';
  if (diff < 30) return `${Math.floor(diff / 7)} weeks ago`;
  if (diff < 60) return '1 month ago';
  if (diff < 365) return `${Math.floor(diff / 30)} months ago`;
  if (diff < 730) return '1 year ago';
  return `${Math.floor(diff / 365)} years ago`;
};

const STAGES = ['Authoring', 'Review', 'Negotiation', 'Approval', 'Signature', 'Execution'];

const approvalStatusIcon = {
  Approved: '✅',
  Pending: '⏳',
  'In Review': '🔍',
  Rejected: '❌',
};

export default function ContractDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');
  const [contractRecords, setContractRecords] = useState(() => getContractsForApp());
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => setContractRecords(getContractsForApp());
    window.addEventListener(LEGAL_FOLDER_UPDATED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(LEGAL_FOLDER_UPDATED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const contract = contractRecords.find((c) => c.id === id);

  if (!contract) {
    return (
      <div className="contract-detail">
        <Header title="Contract Not Found" />
        <div className="contract-detail__not-found">
          <span>📄</span>
          <h3>Contract not found</h3>
          <p>The contract "{id}" does not exist.</p>
          <button onClick={() => navigate('/contracts')}>← Back to Contracts</button>
        </div>
      </div>
    );
  }

  const formatCurrency = (v) =>
    v === 0 ? '—' : new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(v);

  const approvers = contract.approvers || [];
  const clauses = contract.clauses || [];
  const activity = contract.activity || [];
  const tags = contract.tags || [];
  const relatedDocuments = contract.relatedDocuments?.length
    ? contract.relatedDocuments
    : [
        { _id: `${contract.id}-main`, name: `${contract.title}.pdf`, type: 'pdf' },
        { _id: `${contract.id}-scope`, name: 'Exhibit A - Scope of Work.pdf', type: 'pdf' },
        { _id: `${contract.id}-redlines`, name: 'Redlines v2.3.docx', type: 'docx' },
      ];

  const stageIndex = STAGES.findIndex(
    (s) => s.toLowerCase() === contract.stage?.toLowerCase()
  );

  const tabs = ['overview', 'approvals', 'clauses', 'activity'];

  return (
    <div className="contract-detail">
      <Header
        title={contract.title}
        subtitle={`${contract.id} · ${contract.counterparty}`}
      />

      <div className="contract-detail__content">
        {/* Breadcrumb */}
        <div className="contract-detail__breadcrumb">
          <button onClick={() => navigate('/contracts')}>Contracts</button>
          <span>›</span>
          <span>{contract.id}</span>
        </div>

        {/* Top bar */}
        <div className="contract-detail__top-bar">
          <div className="contract-detail__badges">
            <Badge status={contract.status} size="lg" />
            <Badge status={contract.type} size="lg" />
          </div>
          <div className="contract-detail__actions">
            <button
              className="contract-detail__btn contract-detail__btn--secondary"
              onClick={() => navigate(`/contracts/${id}/edit`)}
            >
              Edit
            </button>
          </div>
        </div>

        {/* Lifecycle Timeline */}
        <div className="contract-detail__card">
          <h3 className="contract-detail__section-title">Contract Lifecycle</h3>
          <div className="contract-detail__timeline">
            {STAGES.map((stage, i) => (
              <div key={stage} className="contract-detail__stage">
                <div className="contract-detail__stage-top">
                  {i > 0 && (
                    <div className={`contract-detail__stage-line${i <= stageIndex ? ' contract-detail__stage-line--done' : ''}`} />
                  )}
                  <div className={`contract-detail__stage-circle${
                    i < stageIndex ? ' contract-detail__stage-circle--done' :
                    i === stageIndex ? ' contract-detail__stage-circle--current' : ''
                  }`}>
                    {i < stageIndex ? '✓' : i + 1}
                  </div>
                  {i < STAGES.length - 1 && (
                    <div className={`contract-detail__stage-line${i < stageIndex ? ' contract-detail__stage-line--done' : ''}`} />
                  )}
                </div>
                <span className={`contract-detail__stage-label${i <= stageIndex ? ' contract-detail__stage-label--active' : ''}`}>
                  {stage}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Main grid */}
        <div className="contract-detail__grid">
          {/* Left column */}
          <div className="contract-detail__main">
            {/* Tabs */}
            <div className="contract-detail__tabs">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  className={`contract-detail__tab${activeTab === tab ? ' contract-detail__tab--active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <div className="contract-detail__card">
                <h3 className="contract-detail__section-title">Contract Details</h3>
                <div className="contract-detail__fields">
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Description</span>
                    <span className="contract-detail__field-value contract-detail__field-value--full">{contract.description}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Counterparty</span>
                    <span className="contract-detail__field-value">{contract.counterparty}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Contract Owner</span>
                    <span className="contract-detail__field-value">
                      <span className="contract-detail__avatar">{(contract.owner || 'Legal').split(' ').map(w => w[0]).join('').slice(0,2)}</span>
                      {contract.owner || 'Legal Team'}
                    </span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Department</span>
                    <span className="contract-detail__field-value">{contract.department}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Contract Value</span>
                    <span className="contract-detail__field-value contract-detail__field-value--bold">{formatCurrency(contract.value)}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Start Date</span>
                    <span className="contract-detail__field-value">{contract.startDate || '—'}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">End Date</span>
                    <span className="contract-detail__field-value">{contract.endDate || '—'}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Renewal Date</span>
                    <span className="contract-detail__field-value">{contract.renewalDate || '—'}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Created Date</span>
                    <span className="contract-detail__field-value">{contract.createdDate}</span>
                  </div>
                  <div className="contract-detail__field">
                    <span className="contract-detail__field-label">Tags</span>
                    <span className="contract-detail__field-value">
                      <div className="contract-detail__tags">
                        {tags.map((t) => (
                          <span key={t} className="contract-detail__tag">{t}</span>
                        ))}
                      </div>
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Approvals Tab */}
            {activeTab === 'approvals' && (
              <div className="contract-detail__card">
                <h3 className="contract-detail__section-title">Approval Chain</h3>
                <div className="contract-detail__approvals">
                  {approvers.map((approver, i) => (
                    <div key={i} className="contract-detail__approver">
                      <div className="contract-detail__approver-step">{i + 1}</div>
                      <div className="contract-detail__approver-info">
                        <span className="contract-detail__approver-name">{approver.name}</span>
                        <span className="contract-detail__approver-role">{approver.role}</span>
                      </div>
                      <div className="contract-detail__approver-right">
                        <span className={`contract-detail__approver-status contract-detail__approver-status--${approver.status.toLowerCase().replace(/\s+/g, '-')}`}>
                          {approvalStatusIcon[approver.status]} {approver.status}
                        </span>
                        {approver.date && (
                          <span className="contract-detail__approver-date">{approver.date}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Clauses Tab */}
            {activeTab === 'clauses' && (
              <div className="contract-detail__card">
                <h3 className="contract-detail__section-title">Key Clauses</h3>
                <div className="contract-detail__clauses">
                  {clauses.map((clause, i) => (
                    <div key={i} className="contract-detail__clause">
                      <span className="contract-detail__clause-icon">📌</span>
                      <div className="contract-detail__clause-info">
                        <span className="contract-detail__clause-name">{clause}</span>
                        <span className="contract-detail__clause-status">Standard clause · Reviewed</span>
                      </div>
                      <button className="contract-detail__clause-view">View</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Activity Tab */}
            {activeTab === 'activity' && (
              <div className="contract-detail__card">
                <h3 className="contract-detail__section-title">Activity Log</h3>
                <div className="contract-detail__activity-log">
                  {activity.map((a, i) => (
                    <div key={i} className="contract-detail__activity-item">
                      <div className="contract-detail__activity-line" />
                      <div className="contract-detail__activity-dot" />
                      <div className="contract-detail__activity-content">
                        <span className="contract-detail__activity-action">{a.action}</span>
                        <span className="contract-detail__activity-meta">{a.user} · {a.date}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div className="contract-detail__sidebar">
            <div className="contract-detail__card">
              <h3 className="contract-detail__section-title">Quick Info</h3>
              <div className="contract-detail__quick-info">
                {[['Status', contract.status], ['Type', contract.type]].map(([label, val]) => (
                  <div key={label} className="contract-detail__qi-item">
                    <span className="contract-detail__qi-label">{label}</span>
                    <Badge status={val} />
                  </div>
                ))}
                <div className="contract-detail__qi-item contract-detail__qi-item--col">
                  <span className="contract-detail__qi-label">End Date</span>
                  {contract.endDate ? (() => {
                    const days = daysUntil(contract.endDate);
                    const expiring = days !== null && days > 0 && days <= 90;
                    let pct = null, barColor = '#10b981';
                    if (contract.startDate && contract.endDate) {
                      const start = new Date(contract.startDate).getTime();
                      const end = new Date(contract.endDate).getTime();
                      pct = Math.min(100, Math.max(0, Math.round((now - start) / (end - start) * 100)));
                      barColor = pct >= 90 || expiring ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';
                    }
                    return (
                      <div style={{ width: '100%' }}>
                        <div className={`contract-detail__qi-date${expiring ? ' contract-detail__qi-date--soon' : ''}`}>
                          {contract.endDate}
                        </div>
                        {pct !== null && (
                          <>
                            <div className="date-progress__bar-track">
                              <div className="date-progress__bar-fill" style={{ width: pct + '%', background: barColor }} />
                            </div>
                            <div className="date-progress__sub" style={{ marginTop: 4 }}>
                              {expiring ? `Expires in ${days}d` : pct >= 100 ? `Expired ${timeAgo(contract.endDate)}` : `${pct}% elapsed`}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })() : <span style={{ fontSize: 13, color: '#94a3b8' }}>—</span>}
                </div>
              </div>
            </div>

            <div className="contract-detail__card">
              <h3 className="contract-detail__section-title">Pending Actions</h3>
              {approvers.filter(a => a.status === 'Pending' || a.status === 'In Review').length === 0 ? (
                <p className="contract-detail__no-actions">No pending actions.</p>
              ) : (
                <div className="contract-detail__pending">
                  {approvers
                    .filter((a) => a.status === 'Pending' || a.status === 'In Review')
                    .map((a, i) => (
                      <div key={i} className="contract-detail__pending-item">
                        <span className="contract-detail__pending-icon">⏳</span>
                        <div>
                          <span className="contract-detail__pending-name">{a.name}</span>
                          <span className="contract-detail__pending-role">{a.role}</span>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="contract-detail__card">
              <h3 className="contract-detail__section-title">Related Documents</h3>
              <div className="contract-detail__docs">
                {relatedDocuments.map((doc) => (
                  <div key={doc._id || doc.name} className="contract-detail__doc-item" title={doc.sourcePath || doc.name}>
                    <span>📎</span>
                    <div className="contract-detail__doc-info">
                      <span className="contract-detail__doc-name">{doc.name}</span>
                      {doc.sourcePath && <span className="contract-detail__doc-path">{doc.sourcePath}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
