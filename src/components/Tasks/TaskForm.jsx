import { useState, useEffect } from 'react';
import { tasks as tasksApi } from '../../services/api';
import { TASK_TYPES } from './taskConstants';
import './TaskForm.css';

export default function TaskForm({ task, users, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    assignedTo: '',
    deadline: '',
    priority: 'Medium',
    type: 'Other',
    progressNote: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (task) {
      setForm({
        title:        task.title || '',
        description:  task.description || '',
        assignedTo:   task.assignedTo?._id || '',
        deadline:     task.deadline ? new Date(task.deadline).toISOString().slice(0, 16) : '',
        priority:     task.priority || 'Medium',
        type:         task.type || 'Other',
        progressNote: task.progressNote || '',
      });
    }
  }, [task]);

  const handleChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = { ...form };
      if (task) {
        await tasksApi.update(task._id, payload);
      } else {
        await tasksApi.create(payload);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-form-modal">
        <div className="task-form-header">
          <h2>{task ? 'Edit Task' : 'Assign New Task'}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form className="task-form" onSubmit={handleSubmit}>
          {error && <div className="form-error">{error}</div>}

          <div className="form-field">
            <label>Task Title *</label>
            <input name="title" value={form.title} onChange={handleChange} required placeholder="e.g. Draft NDA for Apex Technologies" />
          </div>

          <div className="form-field">
            <label>Description</label>
            <textarea name="description" value={form.description} onChange={handleChange} rows={3} placeholder="Task details and instructions..." />
          </div>

          <div className="form-row">
            <div className="form-field">
              <label>Assign To *</label>
              <select name="assignedTo" value={form.assignedTo} onChange={handleChange} required>
                <option value="">Select team member...</option>
                {users.map((u) => (
                  <option key={u._id} value={u._id}>{u.name} ({u.role})</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label>Deadline *</label>
              <input type="datetime-local" name="deadline" value={form.deadline} onChange={handleChange} required />
            </div>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label>Priority</label>
              <select name="priority" value={form.priority} onChange={handleChange}>
                {['Low', 'Medium', 'High', 'Urgent'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>

            <div className="form-field">
              <label>Task Type</label>
              <select name="type" value={form.type} onChange={handleChange}>
                {TASK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {task && (
            <div className="form-field">
              <label>Progress Note</label>
              <input name="progressNote" value={form.progressNote} onChange={handleChange} placeholder="e.g. Faith is currently drafting..." />
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-submit" disabled={loading}>
              {loading ? 'Saving...' : task ? 'Update Task' : 'Assign Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
