import { useState } from 'react';

const TASK_TYPES = [
  'Contract Review', 'Drafting', 'Legal Advice', 'Compliance', 'Due Diligence',
  'Negotiation', 'Litigation', 'Regulatory', 'Internal Policy', 'Other',
];

export default function ManualTaskModal({ onClose, onSaved, currentUser }) {
  const [form, setForm] = useState({
    title:      '',
    description:'',
    taskType:   '',
    department: '',
    dueDate:    '',
    priority:   'Medium',
    assignee:   '',
    notes:      '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState('');

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) { setError('Title is required.'); return; }
    setSubmitting(true);
    setError('');

    const task = {
      id:          `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sourceType:  'MANUAL',
      title:       form.title.trim(),
      description: form.description.trim(),
      taskType:    form.taskType,
      department:  form.department.trim(),
      dueDate:     form.dueDate || null,
      priority:    form.priority,
      assignee:    form.assignee.trim() || null,
      status:      'Pending',
      notes:       form.notes.trim(),
      createdBy:   currentUser?.name || 'Manager',
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
      pipelineStage: form.assignee.trim() ? 'assigned' : 'intake',
      dueState:    calcDueState(form.dueDate),
    };

    setSubmitting(false);
    onSaved?.(task);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Add Manual Task</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <form className="mtm__form" onSubmit={handleSubmit}>
            <div className="mtm__row mtm__row--2">
              <label className="asgn__label">
                Title *
                <input
                  className="asgn__input"
                  type="text"
                  placeholder="Task title"
                  value={form.title}
                  onChange={e => set('title', e.target.value)}
                  required
                />
              </label>
              <label className="asgn__label">
                Task Type
                <select className="asgn__select" value={form.taskType} onChange={e => set('taskType', e.target.value)}>
                  <option value="">— Select type —</option>
                  {TASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>

            <label className="asgn__label">
              Description
              <textarea
                className="asgn__textarea"
                placeholder="Describe the task…"
                rows={3}
                value={form.description}
                onChange={e => set('description', e.target.value)}
              />
            </label>

            <div className="mtm__row mtm__row--3">
              <label className="asgn__label">
                Department
                <input className="asgn__input" type="text" value={form.department} onChange={e => set('department', e.target.value)} placeholder="e.g. Finance" />
              </label>
              <label className="asgn__label">
                Assignee (name)
                <input className="asgn__input" type="text" value={form.assignee} onChange={e => set('assignee', e.target.value)} placeholder="Leave blank → Unassigned" />
              </label>
              <label className="asgn__label">
                Due Date
                <input className="asgn__input" type="date" value={form.dueDate} onChange={e => set('dueDate', e.target.value)} />
              </label>
            </div>

            <div className="mtm__row mtm__row--2">
              <label className="asgn__label">
                Priority
                <select className="asgn__select" value={form.priority} onChange={e => set('priority', e.target.value)}>
                  {['Low', 'Medium', 'High', 'Urgent'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="asgn__label">
                Notes
                <input className="asgn__input" type="text" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Additional notes" />
              </label>
            </div>

            {error && <p className="asgn__error">{error}</p>}

            <div className="modal-footer">
              <button type="button" className="modal-btn modal-btn--ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="modal-btn modal-btn--primary" disabled={submitting}>
                {submitting ? 'Adding…' : 'Add Task'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function calcDueState(dateStr) {
  if (!dateStr) return 'unknown';
  const now  = Date.now();
  const d    = new Date(dateStr).getTime();
  if (isNaN(d)) return 'unknown';
  const diff = d - now;
  if (diff < 0)            return 'overdue';
  if (diff < 86400000)     return 'today';
  if (diff < 7 * 86400000) return 'soon';
  return 'ok';
}
