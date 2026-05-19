import { useState, useEffect, useRef } from 'react';

// ── Editable field definitions ─────────────────────────────────────────────────
export const EDITABLE_TRACKER_FIELDS = [
  { key: 'taskType',      label: 'Task type',            type: 'text',     section: 'matter'    },
  { key: 'parties',       label: 'Parties',              type: 'text',     section: 'matter'    },
  { key: 'description',   label: 'Description',          type: 'textarea', section: 'matter'    },
  { key: 'purpose',       label: 'Purpose',              type: 'text',     section: 'matter'    },
  { key: 'progress',      label: 'Progress',             type: 'text',     section: 'status'    },
  { key: 'status',        label: 'Status',               type: 'text',     section: 'status'    },
  { key: 'dateOfRequest', label: 'Date of Request',      type: 'text',     section: 'dates'     },
  { key: 'deadline',      label: 'Deadline / submission',type: 'text',     section: 'dates'     },
  { key: 'department',    label: 'Internal Department',  type: 'text',     section: 'ownership' },
  { key: 'assignee',      label: 'Assignee',             type: 'text',     section: 'ownership' },
  { key: 'keyLearning',   label: 'Key Learning',         type: 'textarea', section: 'notes'     },
];

const EDITABLE_MANUAL_FIELDS = [
  { key: 'title',       label: 'Title',            type: 'text',     section: 'matter'    },
  { key: 'description', label: 'Description',      type: 'textarea', section: 'matter'    },
  { key: 'taskType',    label: 'Task type',         type: 'text',     section: 'matter'    },
  { key: 'department',  label: 'Department',        type: 'text',     section: 'ownership' },
  { key: 'assignee',    label: 'Assignee',          type: 'text',     section: 'ownership' },
  { key: 'status',      label: 'Status',            type: 'text',     section: 'status'    },
  { key: 'notes',       label: 'Notes',             type: 'textarea', section: 'notes'     },
];

function fmtDate(val) {
  if (!val) return '—';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleDateString('en-ZA');
}

function DrawerField({ label, value, editing, editType, editValue, onChange }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="rd__field">
      <span className="rd__field-label">{label}</span>
      {editing ? (
        editType === 'textarea' ? (
          <textarea
            className="rd__edit-textarea"
            value={editValue ?? ''}
            onChange={e => onChange(e.target.value)}
            rows={3}
          />
        ) : (
          <input
            className="rd__edit-input"
            type="text"
            value={editValue ?? ''}
            onChange={e => onChange(e.target.value)}
          />
        )
      ) : (
        <span className={`rd__field-value${empty ? ' rd__field-value--empty' : ''}`}>
          {empty ? '—' : String(value)}
        </span>
      )}
    </div>
  );
}

function DrawerSection({ title, children }) {
  return (
    <div className="rd__section">
      <h4 className="rd__section-title">{title}</h4>
      {children}
    </div>
  );
}

// ── Tracker drawer content ─────────────────────────────────────────────────────
function TrackerDrawerContent({ task: t, mode, edits, onEditChange, isCompleted, isManager, saveError, onEdit, onSave, onCancel, onAssign, onComplete, onOpenTracker, syncing }) {
  const editing = mode === 'edit';
  const saving  = mode === 'saving';

  function fieldVal(key) { return editing ? (edits[key] ?? '') : (t[key] ?? ''); }
  function editField(key, val) { onEditChange(key, val); }

  const dueStateLabel = { overdue: 'Overdue', today: 'Due today', soon: 'Due soon', ok: 'Upcoming', unknown: '—' };
  const dueStateCls   = { overdue: 'rd__badge--red', today: 'rd__badge--orange', soon: 'rd__badge--blue', ok: 'rd__badge--green', unknown: 'rd__badge--muted' };

  const warnings = t.warnings || [];

  return (
    <div className="rd__content">
      {/* ── A. Matter summary ─────────────────────────────── */}
      <DrawerSection title="Matter summary">
        <DrawerField label="Task type"   value={t.taskType}    editing={editing} editType="text"     editValue={fieldVal('taskType')}    onChange={v => editField('taskType', v)} />
        <DrawerField label="Parties"     value={t.parties}     editing={editing} editType="text"     editValue={fieldVal('parties')}     onChange={v => editField('parties', v)} />
        <DrawerField label="Description" value={t.description} editing={editing} editType="textarea" editValue={fieldVal('description')} onChange={v => editField('description', v)} />
        <DrawerField label="Purpose"     value={t.purpose}     editing={editing} editType="text"     editValue={fieldVal('purpose')}     onChange={v => editField('purpose', v)} />
      </DrawerSection>

      {/* ── B. Workflow status ────────────────────────────── */}
      <DrawerSection title="Workflow status">
        <DrawerField label="Progress"       value={t.progress}      editing={editing} editType="text" editValue={fieldVal('progress')} onChange={v => editField('progress', v)} />
        <DrawerField label="Status"         value={t.status}        editing={editing} editType="text" editValue={fieldVal('status')}   onChange={v => editField('status', v)} />
        {!editing && (
          <>
            <div className="rd__field">
              <span className="rd__field-label">App status</span>
              <span className={`rd__badge ${isCompleted ? 'rd__badge--green' : 'rd__badge--blue'}`}>
                {isCompleted ? 'Completed' : 'Active'}
              </span>
            </div>
            <div className="rd__field">
              <span className="rd__field-label">Pipeline stage</span>
              <span className="rd__field-value">{t.pipelineStage || '—'}</span>
            </div>
          </>
        )}
      </DrawerSection>

      {/* ── C. Dates ──────────────────────────────────────── */}
      <DrawerSection title="Dates">
        <DrawerField label="Date of Request"      value={fmtDate(t.dateOfRequest)} editing={editing} editType="text" editValue={fieldVal('dateOfRequest')} onChange={v => editField('dateOfRequest', v)} />
        <DrawerField label="Deadline / submission" value={t.rawDeadlineText || fmtDate(t.deadline)} editing={editing} editType="text" editValue={fieldVal('deadline')} onChange={v => editField('deadline', v)} />
        {!editing && t.deadline && (
          <div className="rd__field">
            <span className="rd__field-label">Parsed deadline</span>
            <span className="rd__field-value">{fmtDate(t.deadline)}</span>
          </div>
        )}
        {!editing && (
          <div className="rd__field">
            <span className="rd__field-label">Due state</span>
            <span className={`rd__badge ${dueStateCls[t.dueState] || 'rd__badge--muted'}`}>
              {dueStateLabel[t.dueState] || t.dueState || '—'}
            </span>
          </div>
        )}
        {!editing && t.completedAt && (
          <div className="rd__field">
            <span className="rd__field-label">Completed date</span>
            <span className="rd__field-value">{fmtDate(t.completedAt)}</span>
          </div>
        )}
      </DrawerSection>

      {/* ── D. Ownership ──────────────────────────────────── */}
      <DrawerSection title="Ownership">
        <DrawerField label="Internal Department" value={t.department} editing={editing} editType="text" editValue={fieldVal('department')} onChange={v => editField('department', v)} />
        <DrawerField label="Assignee"            value={t.assignee}   editing={editing} editType="text" editValue={fieldVal('assignee')}   onChange={v => editField('assignee', v)} />
        {!editing && t.assignedTo && (
          <div className="rd__field">
            <span className="rd__field-label">Mapped user</span>
            <span className="rd__field-value">{t.assignedTo?.name || t.assignedTo}</span>
          </div>
        )}
      </DrawerSection>

      {/* ── E. Notes / Learning ───────────────────────────── */}
      <DrawerSection title="Notes / Learning">
        <DrawerField label="Key Learning" value={t.keyLearning} editing={editing} editType="textarea" editValue={fieldVal('keyLearning')} onChange={v => editField('keyLearning', v)} />
      </DrawerSection>

      {/* ── F. Excel source ───────────────────────────────── */}
      {!editing && (
        <DrawerSection title="Excel source">
          <div className="rd__field"><span className="rd__field-label">Workbook</span><span className="rd__field-value">{t.workbookName || '—'}</span></div>
          <div className="rd__field"><span className="rd__field-label">Sheet</span><span className="rd__field-value">{t.sheetName || '—'}</span></div>
          <div className="rd__field"><span className="rd__field-label">Row number</span><span className="rd__field-value">{t.rowNumber ?? '—'}</span></div>
          <div className="rd__field"><span className="rd__field-label">Row key</span><span className="rd__field-value rd__monospace">{t.legalTrackerId || '—'}</span></div>
          <div className="rd__field"><span className="rd__field-label">Last synced</span><span className="rd__field-value">{fmtDate(t.lastSyncedAt) || '—'}</span></div>
        </DrawerSection>
      )}

      {/* ── Warnings ──────────────────────────────────────── */}
      {warnings.length > 0 && !editing && (
        <DrawerSection title="Sync warnings">
          <div className="rd__warn-list">
            {warnings.map((w, i) => (
              <div key={i} className="rd__warn-item">
                <span className="rd__warn-severity">Warning</span>
                <span className="rd__warn-msg">{typeof w === 'string' ? w : w?.message || String(w)}</span>
              </div>
            ))}
          </div>
        </DrawerSection>
      )}

      {/* ── Save error ────────────────────────────────────── */}
      {saveError && (
        <div className="rd__save-error" role="alert">{saveError}</div>
      )}

      {mode === 'success' && (
        <div className="rd__save-success">Changes saved to spreadsheet.</div>
      )}

      {/* ── Action footer ─────────────────────────────────── */}
      <div className="rd__action-row">
        {!editing && !saving && !isCompleted && isManager && (
          <button className="rd__btn rd__btn--primary" onClick={onEdit}>Edit</button>
        )}
        {editing && (
          <>
            <button className="rd__btn rd__btn--primary" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button className="rd__btn rd__btn--ghost" onClick={onCancel}>Cancel</button>
          </>
        )}
        {!editing && !isCompleted && isManager && (
          <button className="rd__btn rd__btn--assign" onClick={onAssign}>Assign</button>
        )}
        {!editing && !isCompleted && (
          <button className="rd__btn rd__btn--done" onClick={onComplete}>Mark Done</button>
        )}
        {!editing && (
          <button className="rd__btn rd__btn--ghost" onClick={onOpenTracker} disabled={syncing}>
            Open Tracker
          </button>
        )}
      </div>
    </div>
  );
}

// ── Manual drawer content ──────────────────────────────────────────────────────
function ManualDrawerContent({ task: t, isCompleted, isManager, onAssign, onComplete }) {
  return (
    <div className="rd__content">
      <DrawerSection title="Task details">
        <div className="rd__field"><span className="rd__field-label">Title</span><span className="rd__field-value">{t.title || '—'}</span></div>
        <div className="rd__field"><span className="rd__field-label">Description</span><span className="rd__field-value">{t.description || '—'}</span></div>
        <div className="rd__field"><span className="rd__field-label">Task type</span><span className="rd__field-value">{t.taskType || '—'}</span></div>
        <div className="rd__field"><span className="rd__field-label">Department</span><span className="rd__field-value">{t.department || '—'}</span></div>
        <div className="rd__field"><span className="rd__field-label">Priority</span><span className="rd__field-value">{t.priority || '—'}</span></div>
      </DrawerSection>

      <DrawerSection title="Status">
        <div className="rd__field"><span className="rd__field-label">Status</span><span className="rd__field-value">{t.status || '—'}</span></div>
        <div className="rd__field"><span className="rd__field-label">Assignee</span><span className="rd__field-value">{t.assignee || '—'}</span></div>
      </DrawerSection>

      <DrawerSection title="Dates">
        <div className="rd__field"><span className="rd__field-label">Due date</span><span className="rd__field-value">{fmtDate(t.dueDate)}</span></div>
        <div className="rd__field"><span className="rd__field-label">Created at</span><span className="rd__field-value">{fmtDate(t.createdAt)}</span></div>
        <div className="rd__field"><span className="rd__field-label">Updated at</span><span className="rd__field-value">{fmtDate(t.updatedAt)}</span></div>
      </DrawerSection>

      {t.notes && (
        <DrawerSection title="Notes">
          <div className="rd__field"><span className="rd__field-label">Notes</span><span className="rd__field-value">{t.notes}</span></div>
        </DrawerSection>
      )}

      <div className="rd__action-row">
        {!isCompleted && isManager && (
          <button className="rd__btn rd__btn--assign" onClick={onAssign}>Assign</button>
        )}
        {!isCompleted && (
          <button className="rd__btn rd__btn--done" onClick={onComplete}>Mark Done</button>
        )}
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────
export default function TrackerRowDrawer({ task, isManager, onClose, onSaved, onAssign, onComplete, onOpenTracker, syncing }) {
  const [mode, setMode]           = useState('view');
  const [edits, setEdits]         = useState({});
  const [saveError, setSaveError] = useState('');
  const drawerRef = useRef(null);

  // Reset state when a different task is opened
  useEffect(() => {
    setMode('view');
    setEdits({});
    setSaveError('');
  }, [task?.id]);

  // Close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleEdit() {
    const initial = {};
    EDITABLE_TRACKER_FIELDS.forEach(f => {
      const raw = task?.[f.key];
      initial[f.key] = (raw instanceof Date) ? fmtDate(raw) : (raw ?? '');
    });
    setEdits(initial);
    setMode('edit');
  }

  function handleCancel() {
    setEdits({});
    setMode('view');
    setSaveError('');
  }

  async function handleSave() {
    if (!window.contractiq?.trackerUpdateRow) {
      setSaveError('Desktop bridge not available. Cannot write to spreadsheet.');
      return;
    }
    // Only send fields that changed
    const changes = {};
    EDITABLE_TRACKER_FIELDS.forEach(f => {
      const original = (() => {
        const raw = task?.[f.key];
        return (raw instanceof Date) ? fmtDate(raw) : String(raw ?? '');
      })();
      const edited = String(edits[f.key] ?? '');
      if (edited !== original) changes[f.key] = edited;
    });

    if (Object.keys(changes).length === 0) {
      setMode('view');
      return;
    }

    setMode('saving');
    setSaveError('');

    let res;
    try {
      res = await window.contractiq.trackerUpdateRow({
        rowNumber:    task.rowNumber,
        fieldUpdates: changes,
      });
    } catch (err) {
      res = { ok: false, message: String(err?.message || err) };
    }

    if (res?.ok) {
      setMode('success');
      const updated = { ...task, ...changes };
      onSaved?.(updated);
      setTimeout(() => setMode('view'), 1800);
    } else if (res?.code === 'FILE_LOCKED') {
      setMode('error');
      setSaveError('Legal Tracker is open or locked. Close it in Excel and retry.');
    } else {
      setMode('error');
      setSaveError(res?.message || 'Save failed. Changes were not written to the spreadsheet.');
    }
  }

  function handleEditChange(key, val) {
    setEdits(prev => ({ ...prev, [key]: val }));
  }

  if (!task) return null;

  const isTracker   = task.sourceType === 'LEGAL_TRACKER' || task._type === 'TRACKER';
  const isCompleted = task.appStatus === 'completed' || task.status === 'Completed';

  return (
    <>
      <div className="rd__overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="rd__drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={isTracker ? 'Legal Tracker Row Details' : 'Manual Task Details'}
      >
        {/* Header */}
        <div className="rd__header">
          <div className="rd__header-text">
            <h2 className="rd__title">
              {isTracker ? 'Legal Tracker Row Details' : 'Manual Task Details'}
            </h2>
            <p className="rd__subtitle">
              {isTracker
                ? `${task.legalTrackerId || `row-${task.rowNumber}`} · ${task.sheetName || 'Sheet'} · ${task.workbookName || 'Workbook'}`
                : task.title || task.id}
            </p>
          </div>
          <button className="rd__close" onClick={onClose} aria-label="Close drawer">✕</button>
        </div>

        {/* Scrollable body */}
        <div className="rd__body">
          {isTracker ? (
            <TrackerDrawerContent
              task={task}
              mode={mode}
              edits={edits}
              onEditChange={handleEditChange}
              isCompleted={isCompleted}
              isManager={isManager}
              saveError={saveError}
              onEdit={handleEdit}
              onSave={handleSave}
              onCancel={handleCancel}
              onAssign={onAssign}
              onComplete={onComplete}
              onOpenTracker={onOpenTracker}
              syncing={syncing}
            />
          ) : (
            <ManualDrawerContent
              task={task}
              isCompleted={isCompleted}
              isManager={isManager}
              onAssign={onAssign}
              onComplete={onComplete}
            />
          )}
        </div>
      </div>
    </>
  );
}
