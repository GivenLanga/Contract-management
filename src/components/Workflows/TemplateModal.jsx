import { useState } from 'react';
import { MAX_TEMPLATES } from '../../services/legalTrackerStore';

const PRIORITY_OPTIONS = ['Low', 'Medium', 'High', 'Urgent'];

const EMPTY_FORM = {
  name:                 '',
  description:          '',
  taskType:             '',
  defaultDepartment:    '',
  defaultDueOffsetDays: 7,
  defaultPriority:      'Medium',
  sla:                  '',
  checklistItems:       [],
  icon:                 '📋',
  color:                '#4f8ef7',
};

export default function TemplateModal({ templates, onClose, onAdd, onRemove, onUpdate }) {
  const [view, setView]         = useState('list'); // 'list' | 'add' | 'edit'
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm]         = useState(EMPTY_FORM);
  const [checklistInput, setChecklistInput] = useState('');
  const [error, setError]       = useState('');

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function addChecklistItem() {
    const item = checklistInput.trim();
    if (!item) return;
    setForm(prev => ({ ...prev, checklistItems: [...prev.checklistItems, item] }));
    setChecklistInput('');
  }

  function removeChecklistItem(i) {
    setForm(prev => ({ ...prev, checklistItems: prev.checklistItems.filter((_, idx) => idx !== i) }));
  }

  function openAdd() {
    if (templates.length >= MAX_TEMPLATES) {
      setError(`You can track a maximum of ${MAX_TEMPLATES} workflow templates.`);
      return;
    }
    setError('');
    setForm(EMPTY_FORM);
    setChecklistInput('');
    setView('add');
  }

  function openEdit(tpl) {
    setError('');
    setForm({ ...EMPTY_FORM, ...tpl });
    setChecklistInput('');
    setEditTarget(tpl.id);
    setView('edit');
  }

  function handleSave() {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setError('');
    if (view === 'add') {
      try { onAdd?.(form); }
      catch (e) { setError(e.message); return; }
    } else {
      onUpdate?.(editTarget, form);
    }
    setView('list');
  }

  const canAdd = templates.length < MAX_TEMPLATES;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            {view === 'list' ? 'Workflow Templates' : view === 'add' ? 'New Template' : 'Edit Template'}
          </h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {view === 'list' && (
              <button
                className={`modal-btn modal-btn--primary${canAdd ? '' : ' modal-btn--disabled'}`}
                onClick={openAdd}
                disabled={!canAdd}
                title={!canAdd ? `Maximum ${MAX_TEMPLATES} templates` : undefined}
              >
                + Add Template
              </button>
            )}
            <button className="modal-close" onClick={view === 'list' ? onClose : () => setView('list')}>
              {view === 'list' ? '✕' : '← Back'}
            </button>
          </div>
        </div>

        <div className="modal-body">
          {error && <p className="asgn__error tpl__error">{error}</p>}

          {view === 'list' && (
            <>
              <p className="tpl__count">
                {templates.length} / {MAX_TEMPLATES} templates
              </p>
              <div className="tpl__list">
                {templates.map(tpl => (
                  <div key={tpl.id} className="tpl__row" style={{ borderLeftColor: tpl.color || '#94a3b8' }}>
                    <span className="tpl__row-icon">{tpl.icon || '📋'}</span>
                    <div className="tpl__row-body">
                      <p className="tpl__row-name">{tpl.name}</p>
                      <p className="tpl__row-desc">{tpl.description}</p>
                      {tpl.sla && <span className="tpl__row-sla">SLA: {tpl.sla}</span>}
                    </div>
                    <div className="tpl__row-actions">
                      <button className="modal-btn modal-btn--ghost tpl__edit-btn" onClick={() => openEdit(tpl)}>
                        Edit
                      </button>
                      <button className="modal-btn modal-btn--danger" onClick={() => onRemove?.(tpl.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {templates.length === 0 && (
                  <p className="tpl__empty">No templates yet. Add your first workflow template.</p>
                )}
              </div>
            </>
          )}

          {(view === 'add' || view === 'edit') && (
            <div className="tpl__form">
              <div className="mtm__row mtm__row--2">
                <label className="asgn__label">
                  Name *
                  <input className="asgn__input" type="text" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Template name" />
                </label>
                <label className="asgn__label">
                  Task Type
                  <input className="asgn__input" type="text" value={form.taskType} onChange={e => set('taskType', e.target.value)} placeholder="e.g. Internal, External" />
                </label>
              </div>

              <label className="asgn__label">
                Description
                <textarea className="asgn__textarea" rows={2} value={form.description} onChange={e => set('description', e.target.value)} />
              </label>

              <div className="mtm__row mtm__row--3">
                <label className="asgn__label">
                  SLA
                  <input className="asgn__input" type="text" value={form.sla} onChange={e => set('sla', e.target.value)} placeholder="e.g. 7 days" />
                </label>
                <label className="asgn__label">
                  Default Due Offset (days)
                  <input className="asgn__input" type="number" min={1} value={form.defaultDueOffsetDays} onChange={e => set('defaultDueOffsetDays', Number(e.target.value))} />
                </label>
                <label className="asgn__label">
                  Default Priority
                  <select className="asgn__select" value={form.defaultPriority} onChange={e => set('defaultPriority', e.target.value)}>
                    {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
              </div>

              <div className="mtm__row mtm__row--2">
                <label className="asgn__label">
                  Icon (emoji)
                  <input className="asgn__input" type="text" maxLength={4} value={form.icon} onChange={e => set('icon', e.target.value)} />
                </label>
                <label className="asgn__label">
                  Color
                  <input className="asgn__input" type="color" value={form.color} onChange={e => set('color', e.target.value)} />
                </label>
              </div>

              <label className="asgn__label">
                Checklist Steps
                <div className="tpl__checklist-input-row">
                  <input
                    className="asgn__input"
                    type="text"
                    placeholder="Add a step and press Enter"
                    value={checklistInput}
                    onChange={e => setChecklistInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } }}
                  />
                  <button type="button" className="modal-btn modal-btn--ghost" onClick={addChecklistItem}>Add</button>
                </div>
                <ol className="tpl__checklist-preview">
                  {form.checklistItems.map((item, i) => (
                    <li key={i} className="tpl__checklist-item">
                      {item}
                      <button type="button" className="tpl__checklist-rm" onClick={() => removeChecklistItem(i)}>✕</button>
                    </li>
                  ))}
                </ol>
              </label>

              <div className="modal-footer">
                <button type="button" className="modal-btn modal-btn--ghost" onClick={() => setView('list')}>Cancel</button>
                <button type="button" className="modal-btn modal-btn--primary" onClick={handleSave}>
                  {view === 'add' ? 'Add Template' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
