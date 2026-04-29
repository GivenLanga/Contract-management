import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Header from '../Layout/Header';
import { templates } from '../../data/mockData';
import { getContractsForApp } from '../../services/legalFolderStore';
import './ContractForm.css';

const TYPES = ['Addendum', 'Assistance', 'Consultancy', 'Loan', 'MSA', 'Service', 'NDA', 'SOW', 'Vendor', 'License', 'Employment', 'DPA', 'Partnership', 'Agreement'];
const DEPARTMENTS = ['Legal', 'IT', 'Finance', 'Engineering', 'HR', 'Operations', 'Procurement', 'Business Development', 'Compliance'];

export default function ContractForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);
  const existing = isEdit ? getContractsForApp().find((c) => c.id === id) : null;

  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    title: existing?.title || '',
    type: existing?.type || 'MSA',
    counterparty: existing?.counterparty || '',
    department: existing?.department || 'Legal',
    owner: existing?.owner || 'Sarah Mitchell',
    priority: existing?.priority || 'Medium',
    value: existing?.value || '',
    startDate: existing?.startDate || '',
    endDate: existing?.endDate || '',
    renewalDate: existing?.renewalDate || '',
    description: existing?.description || '',
    tags: existing?.tags?.join(', ') || '',
    template: '',
  });
  const [saved, setSaved] = useState(false);

  const update = (field, value) => setFormData((f) => ({ ...f, [field]: value }));

  const steps = [
    { label: 'Details', icon: '📋' },
    { label: 'Parties', icon: '🤝' },
    { label: 'Terms', icon: '📅' },
    { label: 'Review', icon: '✅' },
  ];

  const handleSave = (e) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => {
      navigate('/contracts');
    }, 1500);
  };

  return (
    <div className="contract-form">
      <Header
        title={isEdit ? `Edit Contract – ${id}` : 'Create New Contract'}
        subtitle={isEdit ? 'Modify existing contract details' : 'Fill in the details to create a new contract'}
      />

      <div className="contract-form__content">
        {/* Breadcrumb */}
        <div className="contract-form__breadcrumb">
          <button onClick={() => navigate('/contracts')}>Contracts</button>
          <span>›</span>
          <span>{isEdit ? `Edit ${id}` : 'New Contract'}</span>
        </div>

        {/* Step indicator */}
        <div className="contract-form__steps">
          {steps.map((s, i) => (
            <div
              key={s.label}
              className={`contract-form__step${step === i + 1 ? ' contract-form__step--active' : ''}${step > i + 1 ? ' contract-form__step--done' : ''}`}
              onClick={() => setStep(i + 1)}
            >
              <div className="contract-form__step-circle">
                {step > i + 1 ? '✓' : i + 1}
              </div>
              <span className="contract-form__step-label">{s.label}</span>
              {i < steps.length - 1 && (
                <div className={`contract-form__step-line${step > i + 1 ? ' contract-form__step-line--done' : ''}`} />
              )}
            </div>
          ))}
        </div>

        <form className="contract-form__form" onSubmit={handleSave}>
          {/* Step 1: Details */}
          {step === 1 && (
            <div className="contract-form__card">
              <h3 className="contract-form__section-title">Contract Details</h3>

              <div className="contract-form__field-group">
                <div className="contract-form__field contract-form__field--full">
                  <label>Contract Title <span className="contract-form__required">*</span></label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => update('title', e.target.value)}
                    placeholder="e.g., Master Service Agreement – Acme Corp"
                    required
                  />
                </div>

                <div className="contract-form__field contract-form__field--full">
                  <label>Contract Type <span className="contract-form__required">*</span></label>
                  <select value={formData.type} onChange={(e) => update('type', e.target.value)}>
                    {TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </div>

                <div className="contract-form__field contract-form__field--full">
                  <label>Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => update('description', e.target.value)}
                    placeholder="Brief description of the contract scope and purpose..."
                    rows={4}
                  />
                </div>

                <div className="contract-form__field contract-form__field--full">
                  <label>Use Template (Optional)</label>
                  <select value={formData.template} onChange={(e) => update('template', e.target.value)}>
                    <option value="">— Start from scratch —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>
                    ))}
                  </select>
                  {formData.template && (
                    <p className="contract-form__hint">
                      Template selected. Clauses and terms will be pre-populated.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Parties */}
          {step === 2 && (
            <div className="contract-form__card">
              <h3 className="contract-form__section-title">Parties & Ownership</h3>

              <div className="contract-form__field-group">
                <div className="contract-form__field contract-form__field--full">
                  <label>Counterparty Name <span className="contract-form__required">*</span></label>
                  <input
                    type="text"
                    value={formData.counterparty}
                    onChange={(e) => update('counterparty', e.target.value)}
                    placeholder="e.g., Acme Corporation Inc."
                    required
                  />
                </div>

                <div className="contract-form__field">
                  <label>Contract Owner <span className="contract-form__required">*</span></label>
                  <input
                    type="text"
                    value={formData.owner}
                    onChange={(e) => update('owner', e.target.value)}
                    placeholder="Responsible person"
                    required
                  />
                </div>

                <div className="contract-form__field">
                  <label>Department</label>
                  <select value={formData.department} onChange={(e) => update('department', e.target.value)}>
                    {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
                  </select>
                </div>

                <div className="contract-form__field contract-form__field--full">
                  <label>Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={formData.tags}
                    onChange={(e) => update('tags', e.target.value)}
                    placeholder="e.g., SaaS, Annual, Technology"
                  />
                </div>
              </div>

              <div className="contract-form__approvers-section">
                <h4 className="contract-form__subsection-title">Approval Chain</h4>
                <div className="contract-form__approver-list">
                  {['Legal Counsel', 'Department Head', 'CFO'].map((role, i) => (
                    <div key={role} className="contract-form__approver-item">
                      <span className="contract-form__approver-step">{i + 1}</span>
                      <div className="contract-form__approver-details">
                        <span className="contract-form__approver-role">{role}</span>
                        <select className="contract-form__approver-select">
                          <option>James Porter</option>
                          <option>Linda Hayes</option>
                          <option>Sarah Mitchell</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Terms */}
          {step === 3 && (
            <div className="contract-form__card">
              <h3 className="contract-form__section-title">Contract Terms & Dates</h3>

              <div className="contract-form__field-group">
                <div className="contract-form__field">
                  <label>Contract Value ($)</label>
                  <input
                    type="number"
                    value={formData.value}
                    onChange={(e) => update('value', e.target.value)}
                    placeholder="0"
                    min={0}
                  />
                </div>

                <div className="contract-form__field">
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => update('startDate', e.target.value)}
                  />
                </div>

                <div className="contract-form__field">
                  <label>End / Expiry Date</label>
                  <input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) => update('endDate', e.target.value)}
                  />
                </div>

                <div className="contract-form__field">
                  <label>Renewal Reminder Date</label>
                  <input
                    type="date"
                    value={formData.renewalDate}
                    onChange={(e) => update('renewalDate', e.target.value)}
                  />
                </div>

                <div className="contract-form__field contract-form__field--full">
                  <label>Key Clauses</label>
                  <div className="contract-form__clauses-picker">
                    {['Liability Cap', 'IP Ownership', 'Data Privacy', 'SLA Guarantee', 'Non-Compete', 'Termination', 'Confidentiality', 'Audit Rights'].map((clause) => (
                      <label key={clause} className="contract-form__clause-check">
                        <input type="checkbox" defaultChecked={['Liability Cap', 'IP Ownership'].includes(clause)} />
                        {clause}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="contract-form__field contract-form__field--full">
                  <label>Document Upload</label>
                  <div className="contract-form__upload-zone">
                    <span>📎</span>
                    <p>Drag & drop contract documents here, or <span>browse files</span></p>
                    <span className="contract-form__upload-hint">PDF, DOCX, up to 25MB</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div className="contract-form__card">
              <h3 className="contract-form__section-title">Review & Submit</h3>

              {saved ? (
                <div className="contract-form__success">
                  <span>✅</span>
                  <h4>{isEdit ? 'Contract Updated!' : 'Contract Created!'}</h4>
                  <p>Redirecting to contracts list...</p>
                </div>
              ) : (
                <>
                  <div className="contract-form__review-grid">
                    {[
                      { label: 'Title', value: formData.title || '—' },
                      { label: 'Type', value: formData.type },
                      { label: 'Counterparty', value: formData.counterparty || '—' },
                      { label: 'Owner', value: formData.owner },
                      { label: 'Department', value: formData.department },
                      { label: 'Priority', value: formData.priority },
                      { label: 'Value', value: formData.value ? `$${Number(formData.value).toLocaleString()}` : '—' },
                      { label: 'Start Date', value: formData.startDate || '—' },
                      { label: 'End Date', value: formData.endDate || '—' },
                      { label: 'Tags', value: formData.tags || '—' },
                    ].map(({ label, value }) => (
                      <div key={label} className="contract-form__review-field">
                        <span className="contract-form__review-label">{label}</span>
                        <span className="contract-form__review-value">{value}</span>
                      </div>
                    ))}
                  </div>

                  <div className="contract-form__review-desc">
                    <span className="contract-form__review-label">Description</span>
                    <p className="contract-form__review-value">{formData.description || '—'}</p>
                  </div>

                  <div className="contract-form__submit-section">
                    <label className="contract-form__submit-select-label">Submit Action</label>
                    <select className="contract-form__submit-select">
                      <option>Save as Draft</option>
                      <option>Submit for Legal Review</option>
                      <option>Submit for Approval</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Navigation */}
          <div className="contract-form__nav">
            <button
              type="button"
              className="contract-form__nav-btn contract-form__nav-btn--secondary"
              onClick={() => step > 1 ? setStep(step - 1) : navigate('/contracts')}
            >
              {step > 1 ? '← Back' : 'Cancel'}
            </button>

            {step < 4 ? (
              <button
                type="button"
                className="contract-form__nav-btn contract-form__nav-btn--primary"
                onClick={() => setStep(step + 1)}
              >
                Continue →
              </button>
            ) : (
              <button
                type="submit"
                className="contract-form__nav-btn contract-form__nav-btn--primary"
                disabled={saved}
              >
                {isEdit ? '💾 Update Contract' : '🚀 Create Contract'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
