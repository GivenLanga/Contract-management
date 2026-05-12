import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { legalRequests as lrApi, auth as authApi } from '../../services/api';
import Header from '../Layout/Header';
import {
  STATUS_LABELS, PRIORITY_COLORS, STATUS_COLORS, HOLDER_LABELS, HOLDER_COLORS,
  REQUEST_TYPE_LABELS, getDaysLabel, formatCurrency,
} from './lrHelpers';
import './LegalRequestDetail.css';

export default function LegalRequestDetail() {
  const { id }     = useParams();
  const navigate   = useNavigate();
  const { user, isManager } = useAuth();

  const [request, setRequest]    = useState(null);
  const [history, setHistory]    = useState([]);
  const [allowed, setAllowed]    = useState([]);
  const [users, setUsers]        = useState([]);
  const [loading, setLoading]    = useState(true);
  const [error, setError]        = useState('');

  // Modals
  const [showTransition, setShowTransition] = useState(false);
  const [showAssign, setShowAssign]         = useState(false);
  const [showDueDate, setShowDueDate]       = useState(false);

  const [selectedStatus, setSelectedStatus] = useState('');
  const [comment, setComment]               = useState('');
  const [newAssignee, setNewAssignee]       = useState('');
  const [newDueDate, setNewDueDate]         = useState('');
  const [dueDateReason, setDueDateReason]   = useState('');
  const [saving, setSaving]                 = useState(false);
  const [transitionError, setTransitionError] = useState('');
  const [assignError, setAssignError]         = useState('');
  const [dueDateError, setDueDateError]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await lrApi.get(id);
      setRequest(detail.request);
      setHistory(detail.history || []);
      setAllowed(detail.allowedTransitions || []);
    } catch {
      setError('Could not load request.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isManager) return;
    authApi.users()
      .then(d => setUsers((d.users || []).filter(u => ['admin','manager','staff'].includes(u.role))))
      .catch(() => {});
  }, [isManager]);

  const handleTransition = async () => {
    if (!selectedStatus) return;
    setSaving(true);
    setTransitionError('');
    try {
      await lrApi.updateStatus(id, selectedStatus, comment);
      await load();
      setShowTransition(false);
      setSelectedStatus(''); setComment('');
    } catch (err) {
      setTransitionError(err.message);
    } finally { setSaving(false); }
  };

  const handleAssign = async () => {
    if (!newAssignee) return;
    setSaving(true);
    setAssignError('');
    try {
      await lrApi.assign(id, newAssignee);
      await load();
      setShowAssign(false); setNewAssignee('');
    } catch (err) {
      setAssignError(err.message);
    } finally { setSaving(false); }
  };

  const handleDueDateOverride = async () => {
    if (!newDueDate || !dueDateReason) return;
    setSaving(true);
    setDueDateError('');
    try {
      await lrApi.overrideDueDate(id, newDueDate, dueDateReason);
      await load();
      setShowDueDate(false); setNewDueDate(''); setDueDateReason('');
    } catch (err) {
      setDueDateError(err.message);
    } finally { setSaving(false); }
  };

  if (loading) return <div className="lrd__loading">Loading…</div>;
  if (error && !request) return <div className="lrd__loading">{error}</div>;
  if (!request) return null;

  const days    = getDaysLabel(request.dueDate);
  const priClr  = PRIORITY_COLORS[request.priority] || PRIORITY_COLORS.MEDIUM;
  const stsClr  = STATUS_COLORS[request.status]     || STATUS_COLORS.SUBMITTED;
  const hldClr  = HOLDER_COLORS[request.currentHolder] || '#94a3b8';

  const stageHours = request.lastStatusChangeAt
    ? Math.round((Date.now() - new Date(request.lastStatusChangeAt)) / 3600000)
    : 0;
  const stageLabel = stageHours >= 24
    ? `${Math.floor(stageHours / 24)}d ${stageHours % 24}h in this stage`
    : `${stageHours}h in this stage`;

  return (
    <div className="lrd">
      <Header
        title={request.title}
        subtitle={`${request.requestId} · Submitted ${new Date(request.submittedAt).toLocaleDateString('en-ZA')}`}
        actions={
          <button className="lrd__back-btn" onClick={() => navigate('/legal-requests')}>
            ← All Requests
          </button>
        }
      />

      <div className="lrd__body">
        {/* ── Left panel ── */}
        <div className="lrd__main">

          {/* Status banner */}
          <div className="lrd__status-banner">
            <div className="lrd__banner-left">
              <span
                className="lrd__status-pill"
                style={{ background: stsClr.bg, color: stsClr.color }}
              >
                {STATUS_LABELS[request.status] || request.status}
              </span>
              <span className="lrd__holder-pill" style={{ color: hldClr }}>
                Currently with: <strong>{HOLDER_LABELS[request.currentHolder]}</strong>
              </span>
              <span className="lrd__stage-time">{stageLabel}</span>
            </div>

            <div className="lrd__banner-right">
              {days && (
                <span className={`lrd__days lrd__days--${days.cls}`}>{days.label}</span>
              )}
              {allowed.length > 0 && (
                <button
                  className="lrd__action-btn lrd__action-btn--primary"
                  onClick={() => setShowTransition(true)}
                >
                  Move to next step
                </button>
              )}
              {isManager && (
                <button
                  className="lrd__action-btn lrd__action-btn--secondary"
                  onClick={() => setShowAssign(true)}
                >
                  Assign
                </button>
              )}
              {isManager && (
                <button
                  className="lrd__action-btn lrd__action-btn--ghost"
                  onClick={() => setShowDueDate(true)}
                >
                  Override due date
                </button>
              )}
            </div>
          </div>

          {/* Next action */}
          {request.nextAction && (
            <div className="lrd__next-action">
              <span className="lrd__next-action-label">Next action:</span>
              {request.nextAction}
            </div>
          )}

          {/* Workflow history / timeline */}
          <div className="lrd__card">
            <h3 className="lrd__card-title">Workflow Timeline</h3>
            <div className="lrd__timeline">
              {history.length === 0 && <p className="lrd__timeline-empty">No history yet.</p>}
              {history.map((h, i) => {
                const isAssignment = h.actionType === 'ASSIGNMENT_CHANGE';
                const isDueDateOvr = h.actionType === 'DUE_DATE_OVERRIDE';
                const isStatusChange = !isAssignment && !isDueDateOvr;
                return (
                  <div key={h._id || i} className="lrd__timeline-entry">
                    <div className={`lrd__timeline-dot${isAssignment ? ' lrd__timeline-dot--assign' : isDueDateOvr ? ' lrd__timeline-dot--date' : ''}`} />
                    {i < history.length - 1 && <div className="lrd__timeline-line" />}
                    <div className="lrd__timeline-body">
                      <div className="lrd__timeline-row">
                        <span className="lrd__timeline-date">
                          {new Date(h.changedAt).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                        <span className="lrd__timeline-user">{h.changedBy?.name || '—'}</span>
                        {isAssignment && <span className="lrd__timeline-type-badge lrd__timeline-type-badge--assign">Reassigned</span>}
                        {isDueDateOvr && <span className="lrd__timeline-type-badge lrd__timeline-type-badge--date">Due Date Override</span>}
                      </div>
                      {isStatusChange && (
                        <div className="lrd__timeline-statuses">
                          {h.oldStatus && (
                            <>
                              <span className="lrd__timeline-status lrd__timeline-status--old">
                                {STATUS_LABELS[h.oldStatus] || h.oldStatus}
                              </span>
                              <span className="lrd__timeline-arrow">→</span>
                            </>
                          )}
                          <span className="lrd__timeline-status lrd__timeline-status--new">
                            {STATUS_LABELS[h.newStatus] || h.newStatus}
                          </span>
                          {h.newHolder && (
                            <span className="lrd__timeline-holder" style={{ color: HOLDER_COLORS[h.newHolder] || '#94a3b8' }}>
                              · {HOLDER_LABELS[h.newHolder] || h.newHolder}
                            </span>
                          )}
                        </div>
                      )}
                      {h.comment && <p className="lrd__timeline-comment">{h.comment}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* SLA breakdown */}
          <div className="lrd__card">
            <h3 className="lrd__card-title">SLA Breakdown</h3>
            <div className="lrd__sla-grid">
              <SLACell label="Total Elapsed"  value={`${request.totalElapsedDays}d`}        color="#4f8ef7" />
              <SLACell label="Legal Working"  value={`${request.legalWorkingDays}d`}         color="#8b5cf6" />
              <SLACell label="External Party" value={`${request.externalDelayDays}d`}        color="#0d9488" />
              <SLACell label="Business Dept." value={`${request.businessWaitingDays}d`}      color="#f59e0b" />
              <SLACell label="Sig. Waiting"   value={`${request.signatureWaitingDays || 0}d`} color="#f43f5e" />
            </div>
            {request.externalDelayDays > 0 && (
              <p className="lrd__sla-note">
                External party delays of {request.externalDelayDays} day{request.externalDelayDays !== 1 ? 's' : ''} are excluded from the legal team SLA.
              </p>
            )}
          </div>
          {/* Signature status */}
          {(request.signatureRequestedAt || request.pendingSignatoriesCount > 0 || request.isFullySigned) && (
            <div className="lrd__card">
              <h3 className="lrd__card-title">Signature Status</h3>
              <div className="lrd__sig-grid">
                <div className="lrd__sig-cell">
                  <span className="lrd__sig-value">
                    {request.completedSignatoriesCount || 0} / {(request.completedSignatoriesCount || 0) + (request.pendingSignatoriesCount || 0)}
                  </span>
                  <span className="lrd__sig-label">Signed</span>
                </div>
                <div className="lrd__sig-cell">
                  <span className={`lrd__sig-badge ${request.isFullySigned ? 'lrd__sig-badge--done' : 'lrd__sig-badge--pending'}`}>
                    {request.isFullySigned ? 'Fully Signed' : request.pendingSignatoriesCount > 0 ? 'Pending' : 'Not Started'}
                  </span>
                </div>
              </div>
              {request.signatureRequestedAt && (
                <p className="lrd__sig-date">
                  Requested: {new Date(request.signatureRequestedAt).toLocaleDateString('en-ZA')}
                  {request.fullySignedAt && ` · Completed: ${new Date(request.fullySignedAt).toLocaleDateString('en-ZA')}`}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Right panel ── */}
        <aside className="lrd__sidebar">
          <div className="lrd__card">
            <h3 className="lrd__card-title">Request Details</h3>
            <dl className="lrd__dl">
              <dt>Track</dt>
              <dd>
                <span className={`lrd__track-badge lrd__track-badge--${request.internalOrExternal?.toLowerCase()}`}>
                  {request.internalOrExternal === 'INTERNAL' ? 'Internal' : 'External'}
                </span>
              </dd>

              <dt>Request Type</dt>
              <dd>{REQUEST_TYPE_LABELS[request.requestType] || request.requestType}</dd>

              {request.documentCategory && <><dt>Category</dt><dd>{request.documentCategory}</dd></>}

              <dt>Priority</dt>
              <dd>
                <span
                  className="lrd__priority-pill"
                  style={{ background: priClr.bg, color: priClr.color, border: `1px solid ${priClr.border}` }}
                >
                  {request.priority}
                </span>
              </dd>

              <dt>Department</dt>
              <dd>{request.department || '—'}</dd>

              <dt>Submitted by</dt>
              <dd>{request.submittedBy?.name || '—'}</dd>

              <dt>Assigned to</dt>
              <dd>
                {request.assignedTo ? (
                  <span className="lrd__person">{request.assignedTo.name}</span>
                ) : (
                  <span className="lrd__unassigned">Unassigned</span>
                )}
              </dd>

              <dt>Manager</dt>
              <dd>{request.managerId?.name || '—'}</dd>

              {request.counterpartyName && (
                <><dt>Counterparty</dt><dd>{request.counterpartyName}</dd></>
              )}

              {request.contractValue && (
                <><dt>Contract Value</dt><dd>{formatCurrency(request.contractValue, request.currency)}</dd></>
              )}

              <dt>Submitted</dt>
              <dd>{new Date(request.submittedAt).toLocaleDateString('en-ZA')}</dd>

              <dt>Due Date</dt>
              <dd>
                {request.dueDate ? new Date(request.dueDate).toLocaleDateString('en-ZA') : '—'}
                {request.dueDateOverrideReason && (
                  <span className="lrd__override-note">Override: {request.dueDateOverrideReason}</span>
                )}
              </dd>

              {request.targetDate && request.dueDateOverrideReason && (
                <><dt>Original Target</dt><dd>{new Date(request.targetDate).toLocaleDateString('en-ZA')}</dd></>
              )}

              {request.completedAt && (
                <><dt>Completed</dt><dd>{new Date(request.completedAt).toLocaleDateString('en-ZA')}</dd></>
              )}
            </dl>
          </div>

          {(request.reasonForRequest || request.notes) && (
            <div className="lrd__card">
              <h3 className="lrd__card-title">Background</h3>
              {request.reasonForRequest && (
                <>
                  <p className="lrd__bg-label">Reason for Request</p>
                  <p className="lrd__bg-text">{request.reasonForRequest}</p>
                </>
              )}
              {request.notes && (
                <>
                  <p className="lrd__bg-label" style={{ marginTop: 12 }}>Notes</p>
                  <p className="lrd__bg-text">{request.notes}</p>
                </>
              )}
            </div>
          )}

          {request.overdueReason && (
            <div className="lrd__card lrd__card--warn">
              <h3 className="lrd__card-title">Overdue Reason</h3>
              <p className="lrd__bg-text">{request.overdueReason}</p>
            </div>
          )}
        </aside>
      </div>

      {/* ── Transition modal ── */}
      {showTransition && (
        <div className="lrd__overlay" onClick={() => setShowTransition(false)}>
          <div className="lrd__modal" onClick={e => e.stopPropagation()}>
            <h3 className="lrd__modal-title">Move to next step</h3>
            <div className="lrd__modal-options">
              {allowed.map(s => (
                <button
                  key={s}
                  className={`lrd__status-option${selectedStatus === s ? ' lrd__status-option--selected' : ''}`}
                  style={selectedStatus === s ? { background: STATUS_COLORS[s]?.bg, color: STATUS_COLORS[s]?.color } : {}}
                  onClick={() => setSelectedStatus(s)}
                >
                  {STATUS_LABELS[s] || s}
                </button>
              ))}
            </div>
            <textarea
              className="lrd__modal-comment"
              rows={3}
              placeholder="Optional comment…"
              value={comment}
              onChange={e => setComment(e.target.value)}
            />
            {transitionError && <p className="lrd__modal-error">{transitionError}</p>}
            <div className="lrd__modal-actions">
              <button className="lrd__action-btn lrd__action-btn--ghost" onClick={() => { setShowTransition(false); setTransitionError(''); }}>Cancel</button>
              <button className="lrd__action-btn lrd__action-btn--primary" disabled={!selectedStatus || saving} onClick={handleTransition}>
                {saving ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign modal ── */}
      {showAssign && (
        <div className="lrd__overlay" onClick={() => setShowAssign(false)}>
          <div className="lrd__modal" onClick={e => e.stopPropagation()}>
            <h3 className="lrd__modal-title">Assign to Team Member</h3>
            <select
              className="lrd__modal-select"
              value={newAssignee}
              onChange={e => setNewAssignee(e.target.value)}
            >
              <option value="">Select team member…</option>
              {users.filter(u => ['admin','manager','staff'].includes(u.role)).map(u => (
                <option key={u._id} value={u._id}>{u.name} ({u.role})</option>
              ))}
            </select>
            {assignError && <p className="lrd__modal-error">{assignError}</p>}
            <div className="lrd__modal-actions">
              <button className="lrd__action-btn lrd__action-btn--ghost" onClick={() => { setShowAssign(false); setAssignError(''); }}>Cancel</button>
              <button className="lrd__action-btn lrd__action-btn--primary" disabled={!newAssignee || saving} onClick={handleAssign}>
                {saving ? 'Saving…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Override due date modal ── */}
      {showDueDate && (
        <div className="lrd__overlay" onClick={() => setShowDueDate(false)}>
          <div className="lrd__modal" onClick={e => e.stopPropagation()}>
            <h3 className="lrd__modal-title">Override Due Date</h3>
            <p className="lrd__modal-hint">
              Original target: {request.targetDate ? new Date(request.targetDate).toLocaleDateString('en-ZA') : '—'}
            </p>
            <label className="lrd__modal-label">New Due Date</label>
            <input
              className="lrd__modal-input"
              type="date"
              value={newDueDate}
              onChange={e => setNewDueDate(e.target.value)}
            />
            <label className="lrd__modal-label">Reason for Override</label>
            <textarea
              className="lrd__modal-comment"
              rows={2}
              placeholder="e.g. Board pack submission deadline"
              value={dueDateReason}
              onChange={e => setDueDateReason(e.target.value)}
            />
            {dueDateError && <p className="lrd__modal-error">{dueDateError}</p>}
            <div className="lrd__modal-actions">
              <button className="lrd__action-btn lrd__action-btn--ghost" onClick={() => { setShowDueDate(false); setDueDateError(''); }}>Cancel</button>
              <button
                className="lrd__action-btn lrd__action-btn--primary"
                disabled={!newDueDate || !dueDateReason || saving}
                onClick={handleDueDateOverride}
              >
                {saving ? 'Saving…' : 'Save Override'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SLACell({ label, value, color }) {
  return (
    <div className="lrd__sla-cell">
      <span className="lrd__sla-value" style={{ color }}>{value}</span>
      <span className="lrd__sla-label">{label}</span>
    </div>
  );
}
