import { useState } from 'react';
import { markLinkedTaskCompleted, markLinkedTaskSyncFailed } from '../../services/trackerTaskBridge';

// What will be written to Excel when a task is marked Done
const EXCEL_WRITES = [
  { field: 'Progress', value: 'Completed', description: 'Marks task as done in Progress column' },
];

function MetaRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="done__meta-row">
      <span className="done__meta-label">{label}</span>
      <span className="done__meta-value">{value}</span>
    </div>
  );
}

function fmtDate(val) {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleDateString('en-ZA');
}

export default function DoneConfirmModal({ task, onClose, onConfirmed }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError]           = useState('');

  const isTracker = task?.sourceType === 'LEGAL_TRACKER' || task?._type === 'TRACKER';

  async function handleConfirm() {
    if (!task) return;
    setConfirming(true);
    setError('');

    if (isTracker && window.contractiq?.trackerUpdateRow) {
      let res;
      try {
        res = await window.contractiq.trackerUpdateRow({
          rowNumber:    task.rowNumber,
          fieldUpdates: { progress: 'Completed' },
        });
      } catch (err) {
        res = { ok: false, message: String(err?.message || err) };
      }

      if (!res?.ok) {
        if (res?.code === 'FILE_LOCKED') {
          setError('Legal Tracker is open or locked. Close it in Excel and retry.');
        } else {
          setError(res?.message || 'Spreadsheet sync pending — could not write Progress column.');
        }
        markLinkedTaskSyncFailed(task, res?.message || 'Excel write failed.').catch(() => {});
        setConfirming(false);
        return;
      }

      markLinkedTaskCompleted(task).catch(() => {});
    }

    setConfirming(false);
    onConfirmed?.();
  }

  if (!task) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box done__modal-box" onClick={e => e.stopPropagation()}>

        <div className="modal-header">
          <div>
            <h3 className="modal-title">Mark tracker task as done?</h3>
            {isTracker && (
              <p className="done__subtitle">
                {task.legalTrackerId || `Row ${task.rowNumber}`} · {task.workbookName}
              </p>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* Task context */}
          <div className="done__context">
            <h4 className="done__context-heading">Task details</h4>
            <MetaRow label="Task type"          value={task.taskType || task.title} />
            <MetaRow label="Parties"            value={task.parties} />
            <MetaRow label="Description"        value={task.description} />
            <MetaRow label="Current progress"   value={task.progress || task.status} />
            <MetaRow label="Assignee"           value={typeof task.assignee === 'object' ? task.assignee?.name : task.assignee} />
            <MetaRow label="Deadline"           value={task.rawDeadlineText || fmtDate(task.deadline) || fmtDate(task.dueDate)} />
            <MetaRow label="Department"         value={task.department} />
            {task.keyLearning && (
              <MetaRow label="Key learning"     value={task.keyLearning} />
            )}
          </div>

          {/* What will change in Excel */}
          {isTracker && (
            <div className="done__excel-changes">
              <h4 className="done__context-heading">What will be written to Excel</h4>
              {EXCEL_WRITES.map(w => (
                <div key={w.field} className="done__excel-row">
                  <span className="done__excel-field">{w.field}</span>
                  <span className="done__excel-arrow">→</span>
                  <span className="done__excel-value">{w.value}</span>
                  <span className="done__excel-desc">{w.description}</span>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="done__error" role="alert">{error}</div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn modal-btn--ghost" onClick={onClose} disabled={confirming}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn modal-btn--primary"
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? 'Marking done…' : 'Mark Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
