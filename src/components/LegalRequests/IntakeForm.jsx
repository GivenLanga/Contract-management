import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { legalRequests as lrApi } from '../../services/api';
import { REQUEST_TYPE_LABELS } from './lrHelpers';
import Header from '../Layout/Header';
import './IntakeForm.css';

const DEPARTMENTS = [
  'Finance', 'Human Resources', 'Operations', 'Legal', 'Procurement',
  'Compliance', 'IT', 'Marketing', 'Executive', 'Other',
];

const empty = {
  title: '',
  requestType: '',
  documentCategory: '',
  internalOrExternal: '',
  counterpartyName: '',
  contractValue: '',
  priority: 'MEDIUM',
  reasonForRequest: '',
  notes: '',
  department: '',
  dueDate: '',
};

export default function IntakeForm() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm]     = useState({ ...empty, department: user?.department || '' });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.contractValue) delete payload.contractValue;
      if (!payload.dueDate)       delete payload.dueDate;
      if (!payload.counterpartyName) delete payload.counterpartyName;
      const { request } = await lrApi.create(payload);
      navigate(`/legal-requests/${request._id}`);
    } catch (err) {
      setError(err.message || 'Failed to submit request.');
      setSaving(false);
    }
  };

  const isExternal = form.internalOrExternal === 'EXTERNAL';

  return (
    <div className="intake">
      <Header
        title="New Legal Request"
        subtitle="Submit a new request to the legal team"
      />

      <div className="intake__body">
        <form className="intake__form" onSubmit={handleSubmit} noValidate>

          {/* Track indicator */}
          <div className="intake__track-selector">
            <button
              type="button"
              className={`intake__track-btn${form.internalOrExternal === 'INTERNAL' ? ' intake__track-btn--active intake__track-btn--internal' : ''}`}
              onClick={() => set('internalOrExternal', 'INTERNAL')}
            >
              <span className="intake__track-icon">🏛</span>
              <span className="intake__track-label">Internal Document</span>
              <span className="intake__track-hint">Policies, board resolutions, HR, finance approvals · 4-day SLA</span>
            </button>
            <button
              type="button"
              className={`intake__track-btn${form.internalOrExternal === 'EXTERNAL' ? ' intake__track-btn--active intake__track-btn--external' : ''}`}
              onClick={() => set('internalOrExternal', 'EXTERNAL')}
            >
              <span className="intake__track-icon">🤝</span>
              <span className="intake__track-label">External Contract</span>
              <span className="intake__track-hint">Supplier agreements, NDAs, leases, MOUs · 7-day target</span>
            </button>
          </div>

          {!form.internalOrExternal && (
            <p className="intake__track-required">Select a track above to continue.</p>
          )}

          {form.internalOrExternal && (
            <>
              <div className="intake__section">
                <h3 className="intake__section-title">Request Details</h3>
                <div className="intake__grid">
                  <div className="intake__field intake__field--full">
                    <label className="intake__label">Request Title <span className="intake__required">*</span></label>
                    <input
                      className="intake__input"
                      type="text"
                      value={form.title}
                      onChange={e => set('title', e.target.value)}
                      placeholder="e.g. Supplier SLA — ThaboTech Solutions"
                      required
                    />
                  </div>

                  <div className="intake__field">
                    <label className="intake__label">Request Type <span className="intake__required">*</span></label>
                    <select
                      className="intake__select"
                      value={form.requestType}
                      onChange={e => set('requestType', e.target.value)}
                      required
                    >
                      <option value="">Select type…</option>
                      {Object.entries(REQUEST_TYPE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>

                  <div className="intake__field">
                    <label className="intake__label">Document Category</label>
                    <input
                      className="intake__input"
                      type="text"
                      value={form.documentCategory}
                      onChange={e => set('documentCategory', e.target.value)}
                      placeholder="e.g. Service Providers, Compliance"
                    />
                  </div>

                  <div className="intake__field">
                    <label className="intake__label">Requesting Department</label>
                    <select
                      className="intake__select"
                      value={form.department}
                      onChange={e => set('department', e.target.value)}
                    >
                      <option value="">Select department…</option>
                      {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>

                  <div className="intake__field">
                    <label className="intake__label">Priority</label>
                    <select
                      className="intake__select"
                      value={form.priority}
                      onChange={e => set('priority', e.target.value)}
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                      <option value="URGENT">Urgent</option>
                    </select>
                  </div>
                </div>
              </div>

              {isExternal && (
                <div className="intake__section">
                  <h3 className="intake__section-title">Counterparty & Contract</h3>
                  <div className="intake__grid">
                    <div className="intake__field">
                      <label className="intake__label">Counterparty Name</label>
                      <input
                        className="intake__input"
                        type="text"
                        value={form.counterpartyName}
                        onChange={e => set('counterpartyName', e.target.value)}
                        placeholder="e.g. ThaboTech Solutions (Pty) Ltd"
                      />
                    </div>
                    <div className="intake__field">
                      <label className="intake__label">Estimated Contract Value (ZAR)</label>
                      <input
                        className="intake__input"
                        type="number"
                        value={form.contractValue}
                        onChange={e => set('contractValue', e.target.value)}
                        placeholder="0.00"
                        min="0"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="intake__section">
                <h3 className="intake__section-title">Timing</h3>
                <div className="intake__grid">
                  <div className="intake__field">
                    <label className="intake__label">Required Completion Date</label>
                    <input
                      className="intake__input"
                      type="date"
                      value={form.dueDate}
                      onChange={e => set('dueDate', e.target.value)}
                    />
                    <span className="intake__hint">
                      Leave blank to use the standard {isExternal ? '7' : '4'}-day SLA from today.
                    </span>
                  </div>
                </div>
              </div>

              <div className="intake__section">
                <h3 className="intake__section-title">Background & Notes</h3>
                <div className="intake__grid">
                  <div className="intake__field intake__field--full">
                    <label className="intake__label">Reason for Request</label>
                    <textarea
                      className="intake__textarea"
                      rows={3}
                      value={form.reasonForRequest}
                      onChange={e => set('reasonForRequest', e.target.value)}
                      placeholder="Describe the business need and context for this request…"
                    />
                  </div>
                  <div className="intake__field intake__field--full">
                    <label className="intake__label">Additional Notes</label>
                    <textarea
                      className="intake__textarea"
                      rows={2}
                      value={form.notes}
                      onChange={e => set('notes', e.target.value)}
                      placeholder="Any other information the legal team should know…"
                    />
                  </div>
                </div>
              </div>

              {error && <div className="intake__error">{error}</div>}

              <div className="intake__actions">
                <button type="button" className="intake__btn intake__btn--secondary" onClick={() => navigate(-1)}>
                  Cancel
                </button>
                <button type="submit" className="intake__btn intake__btn--primary" disabled={saving}>
                  {saving ? 'Submitting…' : 'Submit Request'}
                </button>
              </div>
            </>
          )}
        </form>

        <aside className="intake__sidebar">
          <div className="intake__info-card">
            <h4 className="intake__info-title">What happens next?</h4>
            <ol className="intake__info-steps">
              <li>Your request is submitted and the legal manager is notified immediately.</li>
              <li>The manager reviews it and assigns a legal team member.</li>
              <li>You can track progress here — no need to email legal for updates.</li>
              <li>You will be notified when the request is completed.</li>
            </ol>
          </div>
          <div className="intake__info-card intake__info-card--sla">
            <h4 className="intake__info-title">SLA Targets</h4>
            <div className="intake__sla-row">
              <span className="intake__sla-badge intake__sla-badge--internal">Internal</span>
              <span>4 calendar days</span>
            </div>
            <div className="intake__sla-row">
              <span className="intake__sla-badge intake__sla-badge--external">External</span>
              <span>7 calendar days (excl. external party delays)</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
