import { useState, useEffect } from 'react';
import { auth as authApi } from '../../services/api';
import { upsertTrackerTask, updateManualTaskAssignee } from '../../services/trackerTaskBridge';

export default function AssignModal({ task, onClose, onAssigned }) {
  const [users, setUsers]               = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [note, setNote]                 = useState('');
  const [updateSpreadsheet, setUpdateSpreadsheet] = useState(true);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState('');

  useEffect(() => {
    authApi.users()
      .then(d => setUsers(d.users || []))
      .catch(() => {});
  }, []);

  const isTracker = task?.sourceType === 'LEGAL_TRACKER' || task?._type === 'TRACKER';
  const isManual  = task?.sourceType === 'MANUAL_WORKFLOW' || task?._type === 'MANUAL';

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedUser) { setError('Please select a team member.'); return; }
    setSubmitting(true);
    setError('');

    const assignedUser = users.find(u => u._id === selectedUser);
    const results = { appUpdated: false, spreadsheetUpdated: false, taskCreated: false };

    // 1. Update spreadsheet assignee column (tracker tasks only)
    if (isTracker && updateSpreadsheet && window.contractiq?.trackerUpdateRow) {
      try {
        const res = await window.contractiq.trackerUpdateRow({
          rowNumber:    task.rowNumber,
          fieldUpdates: { assignee: assignedUser?.name || selectedUser },
        });
        results.spreadsheetUpdated = res?.ok;
        if (!res?.ok) setError(`Spreadsheet sync pending: ${res?.message || 'write failed'}`);
      } catch {
        setError('Spreadsheet sync pending — could not write to file.');
      }
    }

    // 2. Create or update linked backend task (upsert — no duplicates on re-assign)
    if (isTracker) {
      const bridgeResult = await upsertTrackerTask({
        trackerTask:    task,
        assignedUserId: selectedUser,
        note,
      });
      if (bridgeResult.ok) {
        results.taskCreated = bridgeResult.created;
        results.taskUpdated = !bridgeResult.created;
      } else {
        console.warn('[AssignModal] tracker upsert failed', bridgeResult.message);
      }
    }

    // 3. For manual workflow tasks, update the linked backend task assignee
    if (isManual) {
      const manualResult = await updateManualTaskAssignee({
        task,
        assignedUserId: selectedUser,
      });
      if (manualResult.ok) {
        results.taskUpdated = true;
      } else {
        console.warn('[AssignModal] manual task update failed', manualResult.code, manualResult.message);
      }
    }

    results.appUpdated = true;
    setSubmitting(false);
    onAssigned?.({ assignedUser, results, note });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Assign Task</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* Task summary */}
          <div className="asgn__summary">
            <span className={`asgn__source-badge ${isTracker ? 'asgn__source-badge--tracker' : 'asgn__source-badge--manual'}`}>
              {isTracker ? 'Legal Tracker' : 'Manual Workflow'}
            </span>
            {task?.taskType && (
              <span className="asgn__type-badge">{task.taskType}</span>
            )}
            <p className="asgn__task-title">
              {task?.description || task?.taskType || task?.title || 'Tracker Task'}
            </p>
            {task?.parties && <p className="asgn__task-meta"><strong>Parties:</strong> {task.parties}</p>}
            {task?.purpose && <p className="asgn__task-meta"><strong>Purpose:</strong> {task.purpose}</p>}
            {task?.department && <p className="asgn__task-meta"><strong>Department:</strong> {task.department}</p>}
            {(task?.deadline || task?.dueDate) && (
              <p className="asgn__task-meta">
                <strong>Deadline:</strong>{' '}
                {task.rawDeadlineText || (() => {
                  const d = new Date(task.deadline || task.dueDate);
                  return isNaN(d) ? '—' : d.toLocaleDateString('en-ZA');
                })()}
              </p>
            )}
            {(task?.assignee || task?.assignedTo) && (
              <p className="asgn__task-meta">
                <strong>Current assignee:</strong> {task.assignee || task.assignedTo?.name || '—'}
              </p>
            )}
            {task?.keyLearning && (
              <p className="asgn__task-meta asgn__task-meta--note">
                <strong>Notes:</strong> {task.keyLearning}
              </p>
            )}
          </div>

          <form className="asgn__form" onSubmit={handleSubmit}>
            <label className="asgn__label">
              Assign to
              <select
                className="asgn__select"
                value={selectedUser}
                onChange={e => setSelectedUser(e.target.value)}
                required
              >
                <option value="">— Select team member —</option>
                {users.map(u => (
                  <option key={u._id} value={u._id}>{u.name} ({u.role})</option>
                ))}
              </select>
            </label>

            <label className="asgn__label">
              Note (optional)
              <textarea
                className="asgn__textarea"
                placeholder="Any instructions or context…"
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={3}
              />
            </label>

            {isTracker && (
              <label className="asgn__checkbox-row">
                <input
                  type="checkbox"
                  checked={updateSpreadsheet}
                  onChange={e => setUpdateSpreadsheet(e.target.checked)}
                />
                Update Assignee column in spreadsheet
              </label>
            )}

            {error && <p className="asgn__error">{error}</p>}

            <div className="modal-footer">
              <button type="button" className="modal-btn modal-btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="modal-btn modal-btn--primary" disabled={submitting}>
                {submitting ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
