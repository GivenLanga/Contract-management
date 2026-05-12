import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { tasks as tasksApi, auth as authApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { REQUEST_TYPE_LABELS, STATUS_COLORS, PRIORITY_COLORS, getDaysLabel } from '../LegalRequests/lrHelpers';
import TaskForm from './TaskForm';
import Header from '../Layout/Header';
import './TaskList.css';

const TASK_TYPE_LABELS = {
  ASSIGN_REQUEST:       'Assign Request',
  INTAKE_REVIEW:        'Intake Review',
  LEGAL_REVIEW:         'Legal Review',
  DRAFT_DOCUMENT:       'Draft Document',
  MANAGER_APPROVAL:     'Manager Approval',
  REQUEST_REVISIONS:    'Request Revisions',
  BUSINESS_INPUT:       'Business Input',
  UPLOAD_DOCUMENT:      'Upload Document',
  PREPARE_FOR_SIGNATURE:'Prepare for Signature',
  SEND_SIGNATURE_EMAIL: 'Send Signature Email',
  FOLLOW_UP_SIGNATURE:  'Follow-up Signature',
  STORE_SIGNED_DOCUMENT:'Store Signed Document',
  CLOSE_REQUEST:        'Close Request',
  RESOLVE_COMMENT:      'Resolve Comment',
  GENERAL_TASK:         'General Task',
  // Legacy types
  Drafting:    'Drafting',
  Review:      'Review',
  Approval:    'Approval',
  Signing:     'Signing',
  Negotiation: 'Negotiation',
  Other:       'General',
};

const TASK_STATUS_COLORS = {
  Pending:     { bg: '#f8fafc', color: '#475569' },
  'In Progress':{ bg: '#eff6ff', color: '#1d4ed8' },
  Blocked:     { bg: '#fff1f2', color: '#be123c' },
  Completed:   { bg: '#f0fdf4', color: '#15803d' },
  Overdue:     { bg: '#fef2f2', color: '#dc2626' },
  Cancelled:   { bg: '#f8fafc', color: '#94a3b8' },
};

const TASK_PRIORITY_COLORS = {
  Low:    { bg: '#f8fafc', color: '#64748b' },
  Medium: { bg: '#eff6ff', color: '#2563eb' },
  High:   { bg: '#fff7ed', color: '#c2410c' },
  Urgent: { bg: '#fff1f2', color: '#be123c' },
};

// Tab definitions
const TABS = [
  { key: 'mine',        label: 'My Tasks',             params: (uid) => ({ assignedTo: uid }) },
  { key: 'team',        label: 'Team Tasks',           params: ()    => ({}) },
  { key: 'overdue',     label: 'Overdue',              params: ()    => ({ overdue: 'true' }) },
  { key: 'approvals',   label: 'Approvals',            params: ()    => ({ taskType: 'MANAGER_APPROVAL' }) },
  { key: 'business',    label: 'Business Input',       params: ()    => ({ taskType: 'BUSINESS_INPUT' }) },
  { key: 'signatures',  label: 'Signature Follow-ups', params: ()    => ({ taskType: 'FOLLOW_UP_SIGNATURE' }) },
  { key: 'completed',   label: 'Completed',            params: ()    => ({ status: 'Completed' }) },
];

export default function TaskList() {
  const { user, isManager } = useAuth();
  const navigate            = useNavigate();

  const [taskData, setTaskData]       = useState({ tasks: [], total: 0 });
  const [stats, setStats]             = useState(null);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [editTask, setEditTask]       = useState(null);
  const [users, setUsers]             = useState([]);
  const [activeTab, setActiveTab]     = useState('mine');
  const [search, setSearch]           = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const tab = TABS.find(t => t.key === activeTab);
      const params = tab ? tab.params(user._id) : {};
      const data = await tasksApi.list(params);
      setTaskData(data);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [activeTab, user._id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    tasksApi.stats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (isManager) {
      authApi.users().then(d => setUsers(d.users || [])).catch(() => {});
    }
  }, [isManager]);

  const handleStatusUpdate = async (task, newStatus) => {
    try {
      await tasksApi.update(task._id, { status: newStatus });
      load();
      tasksApi.stats().then(setStats).catch(() => {});
    } catch (e) {
      alert(e.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await tasksApi.delete(id);
      setDeleteConfirmId(null);
      load();
      tasksApi.stats().then(setStats).catch(() => {});
    } catch (e) {
      alert(e.message);
    }
  };

  const visibleTasks = taskData.tasks.filter(t => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      t.title?.toLowerCase().includes(q) ||
      t.legalRequest?.title?.toLowerCase().includes(q) ||
      t.legalRequest?.requestId?.toLowerCase().includes(q) ||
      t.assignedTo?.name?.toLowerCase().includes(q) ||
      t.legalRequest?.counterpartyName?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="tl">
      <Header
        title="Tasks"
        subtitle="Track legal action items, approvals, drafting work, business input, and signature follow-ups."
        actions={
          isManager && (
            <button className="tl__new-btn" onClick={() => { setEditTask(null); setShowForm(true); }}>
              + Assign Task
            </button>
          )
        }
      />

      <div className="tl__body">

        {/* ── Summary cards ──────────────────────────────────────────────── */}
        {stats && (
          <div className="tl__stats">
            <StatCard label="My Open Tasks"       value={stats.myOpenTasks}       color="blue"   onClick={() => setActiveTab('mine')} />
            <StatCard label="Due Today"           value={stats.myDueToday}        color="orange" onClick={() => setActiveTab('mine')} />
            <StatCard label="Overdue"             value={stats.myOverdue}         color="red"    onClick={() => setActiveTab('overdue')} urgent={stats.myOverdue > 0} />
            <StatCard label="Waiting for Manager" value={stats.waitingForManager} color="purple" onClick={() => setActiveTab('approvals')} />
            <StatCard label="Business Input"      value={stats.businessInput}     color="amber"  onClick={() => setActiveTab('business')} />
            <StatCard label="Sig. Follow-ups"     value={stats.signatureFollowups}color="teal"   onClick={() => setActiveTab('signatures')} />
            <StatCard label="Done This Week"      value={stats.completedThisWeek} color="green"  onClick={() => setActiveTab('completed')} />
          </div>
        )}

        {/* ── Tabs + search ──────────────────────────────────────────────── */}
        <div className="tl__toolbar">
          <div className="tl__tabs">
            {TABS.map(t => {
              if (!isManager && t.key === 'team') return null;
              return (
                <button
                  key={t.key}
                  className={`tl__tab${activeTab === t.key ? ' tl__tab--active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <input
            className="tl__search"
            placeholder="Search tasks, legal requests, owners…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* ── Task list ──────────────────────────────────────────────────── */}
        {loading ? (
          <div className="tl__loading">Loading tasks…</div>
        ) : visibleTasks.length === 0 ? (
          <div className="tl__empty">
            <div className="tl__empty-icon">✅</div>
            <p>No tasks in this view.</p>
            {isManager && (
              <button className="tl__new-btn" onClick={() => { setEditTask(null); setShowForm(true); }}>
                Assign First Task
              </button>
            )}
          </div>
        ) : (
          <div className="tl__task-list">
            <div className="tl__list-header">
              <span>Task</span>
              <span>Legal Request</span>
              <span>Assigned To</span>
              <span>Due</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            {visibleTasks.map(task => (
              <TaskRow
                key={task._id}
                task={task}
                user={user}
                isManager={isManager}
                confirmingDelete={deleteConfirmId === task._id}
                onStatusUpdate={handleStatusUpdate}
                onEdit={() => { setEditTask(task); setShowForm(true); }}
                onDeleteRequest={() => setDeleteConfirmId(task._id)}
                onDeleteConfirm={() => handleDelete(task._id)}
                onDeleteCancel={() => setDeleteConfirmId(null)}
                onLrClick={(id) => navigate(`/legal-requests/${id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <TaskForm
          task={editTask}
          users={users}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); tasksApi.stats().then(setStats).catch(() => {}); }}
        />
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, onClick, urgent }) {
  return (
    <button
      className={`tl__stat tl__stat--${color}${urgent ? ' tl__stat--urgent' : ''}`}
      onClick={onClick}
    >
      <span className="tl__stat-value">{value ?? '—'}</span>
      <span className="tl__stat-label">{label}</span>
    </button>
  );
}

// ── Task row ──────────────────────────────────────────────────────────────────
function TaskRow({ task, user, isManager, confirmingDelete, onStatusUpdate, onEdit, onDeleteRequest, onDeleteConfirm, onDeleteCancel, onLrClick }) {
  const days    = getDaysLabel(task.deadline);
  const stsClr  = TASK_STATUS_COLORS[task.status] || TASK_STATUS_COLORS['Pending'];
  const priClr  = TASK_PRIORITY_COLORS[task.priority] || TASK_PRIORITY_COLORS.Medium;
  const lr      = task.legalRequest;
  const isOwner = task.assignedTo?._id === user._id || task.assignedTo?._id?.toString() === user._id?.toString();
  const isDone  = ['Completed', 'Cancelled'].includes(task.status);

  return (
    <div className={`tl__row${days?.cls === 'overdue' ? ' tl__row--overdue' : ''}`}>
      {/* Col 1: Task */}
      <div className="tl__col-task">
        <div className="tl__task-badges">
          <span className="tl__task-type">{TASK_TYPE_LABELS[task.type] || task.type}</span>
          <span className="tl__task-pri" style={{ background: priClr.bg, color: priClr.color }}>
            {task.priority}
          </span>
        </div>
        <span className="tl__task-title">{task.title}</span>
        {task.progressNote && (
          <span className="tl__task-note">{task.progressNote}</span>
        )}
      </div>

      {/* Col 2: Legal Request */}
      <div className="tl__col-lr">
        {lr ? (
          <button className="tl__lr-link" onClick={() => onLrClick(lr._id)}>
            <span className="tl__lr-ref">{lr.requestId}</span>
            <span className="tl__lr-title">{lr.title}</span>
            {lr.requestType && (
              <span className="tl__lr-type">{REQUEST_TYPE_LABELS[lr.requestType] || lr.requestType}</span>
            )}
          </button>
        ) : (
          <span className="tl__lr-none">General task</span>
        )}
      </div>

      {/* Col 3: Assignee */}
      <div className="tl__col-owner">
        {task.assignedTo ? (
          <>
            <span className="tl__owner-avatar">
              {task.assignedTo.name?.charAt(0).toUpperCase()}
            </span>
            <div>
              <span className="tl__owner-name">{task.assignedTo.name}</span>
              <span className="tl__owner-role">{task.assignedTo.role}</span>
            </div>
          </>
        ) : '—'}
      </div>

      {/* Col 4: Due */}
      <div className="tl__col-due">
        {days ? (
          <span className={`tl__days tl__days--${days.cls}`}>{days.label}</span>
        ) : task.deadline ? (
          <span className="tl__days">{new Date(task.deadline).toLocaleDateString('en-ZA')}</span>
        ) : '—'}
        {task.status === 'Completed' && task.completedAt && (
          <span className="tl__completed-date">Done {new Date(task.completedAt).toLocaleDateString('en-ZA')}</span>
        )}
      </div>

      {/* Col 5: Status */}
      <div className="tl__col-status">
        <span className="tl__status-pill" style={{ background: stsClr.bg, color: stsClr.color }}>
          {task.status}
        </span>
      </div>

      {/* Col 6: Actions */}
      <div className="tl__col-actions">
        {isOwner && !isDone && (
          <>
            {task.status === 'Pending' && (
              <button className="tl__action tl__action--start" onClick={() => onStatusUpdate(task, 'In Progress')}>
                Start
              </button>
            )}
            <button className="tl__action tl__action--complete" onClick={() => onStatusUpdate(task, 'Completed')}>
              Done
            </button>
          </>
        )}
        {isManager && (
          confirmingDelete ? (
            <>
              <span className="tl__action-confirm-label">Delete?</span>
              <button className="tl__action tl__action--confirm-yes" onClick={onDeleteConfirm}>Yes</button>
              <button className="tl__action tl__action--confirm-no"  onClick={onDeleteCancel}>No</button>
            </>
          ) : (
            <>
              <button className="tl__action tl__action--edit"   onClick={onEdit}>Edit</button>
              <button className="tl__action tl__action--delete" onClick={onDeleteRequest}>Del</button>
            </>
          )
        )}
      </div>
    </div>
  );
}
