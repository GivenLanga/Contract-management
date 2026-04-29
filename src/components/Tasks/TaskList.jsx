import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { tasks as tasksApi, auth as authApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import TaskForm from './TaskForm';
import './TaskList.css';

const STATUS_COLORS = {
  Pending: 'status--pending',
  'In Progress': 'status--progress',
  Completed: 'status--completed',
  Overdue: 'status--overdue',
  Cancelled: 'status--cancelled',
};

const PRIORITY_COLORS = {
  Low: 'priority--low',
  Medium: 'priority--medium',
  High: 'priority--high',
  Urgent: 'priority--urgent',
};

export default function TaskList() {
  const { user, isManager } = useAuth();
  const navigate = useNavigate();
  const [taskData, setTaskData] = useState({ tasks: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [filter, setFilter] = useState({ status: '', assignedTo: '' });
  const [users, setUsers] = useState([]);
  const [activeTab, setActiveTab] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.assignedTo) params.assignedTo = filter.assignedTo;
      if (activeTab === 'mine') params.assignedTo = user._id;
      if (activeTab === 'assigned') params.assignedBy = user._id;

      const data = await tasksApi.list(params);
      setTaskData(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filter, activeTab, user._id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (isManager) {
      authApi.users().then((d) => setUsers(d.users || [])).catch(() => {});
    }
  }, [isManager]);

  const handleStatusUpdate = async (task, newStatus) => {
    try {
      await tasksApi.update(task._id, { status: newStatus });
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this task?')) return;
    try {
      await tasksApi.delete(id);
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  const isOverdue = (deadline, status) =>
    status !== 'Completed' && status !== 'Cancelled' && new Date(deadline) < new Date();

  const formatDeadline = (d) => {
    const date = new Date(d);
    const diff = Math.ceil((date - new Date()) / 86400000);
    if (diff < 0) return { text: `${Math.abs(diff)}d overdue`, cls: 'deadline--overdue' };
    if (diff === 0) return { text: 'Due today', cls: 'deadline--today' };
    if (diff <= 3) return { text: `${diff}d left`, cls: 'deadline--soon' };
    return { text: date.toLocaleDateString(), cls: '' };
  };

  return (
    <div className="task-list-page">
      <div className="task-list-header">
        <div>
          <h1 className="task-list-title">Task Management</h1>
          <p className="task-list-sub">
            {taskData.total} task{taskData.total !== 1 ? 's' : ''}
          </p>
        </div>
        {isManager && (
          <button className="btn btn-primary" onClick={() => { setEditTask(null); setShowForm(true); }}>
            + Assign Task
          </button>
        )}
      </div>

      <div className="task-tabs">
        {['all', 'mine', 'assigned'].map((t) => (
          <button
            key={t}
            className={`task-tab${activeTab === t ? ' task-tab--active' : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t === 'all' ? 'All Tasks' : t === 'mine' ? 'My Tasks' : 'Assigned by Me'}
          </button>
        ))}
      </div>

      <div className="task-filters">
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All Statuses</option>
          {['Pending', 'In Progress', 'Completed', 'Overdue', 'Cancelled'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {isManager && (
          <select value={filter.assignedTo} onChange={(e) => setFilter((f) => ({ ...f, assignedTo: e.target.value }))}>
            <option value="">All Users</option>
            {users.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="task-loading">Loading tasks...</div>
      ) : taskData.tasks.length === 0 ? (
        <div className="task-empty">
          <div className="task-empty-icon">📋</div>
          <p>No tasks found.</p>
          {isManager && (
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>Assign First Task</button>
          )}
        </div>
      ) : (
        <div className="task-grid">
          {taskData.tasks.map((task) => {
            const deadline = formatDeadline(task.deadline);
            const overdue = isOverdue(task.deadline, task.status);
            return (
              <div key={task._id} className={`task-card${overdue ? ' task-card--overdue' : ''}`}>
                <div className="task-card-top">
                  <div className="task-card-meta">
                    <span className={`task-priority ${PRIORITY_COLORS[task.priority] || ''}`}>
                      {task.priority}
                    </span>
                    <span className="task-type">{task.type}</span>
                  </div>
                  <span className={`task-status ${STATUS_COLORS[task.status] || ''}`}>
                    {task.status}
                  </span>
                </div>

                <h3 className="task-card-title">{task.title}</h3>
                {task.description && <p className="task-card-desc">{task.description}</p>}

                <div className="task-card-info">
                  <div className="task-assignee">
                    <div className="task-avatar">
                      {task.assignedTo?.name?.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="task-assignee-name">{task.assignedTo?.name}</div>
                      <div className="task-assignee-role">{task.assignedTo?.role}</div>
                    </div>
                  </div>
                  <div className={`task-deadline ${deadline.cls}`}>{deadline.text}</div>
                </div>

                {task.contract && (
                  <div className="task-contract-link">
                    📄 {task.contract.title}
                  </div>
                )}

                {task.progressNote && (
                  <div className="task-progress-note">
                    <span>Status:</span> {task.progressNote}
                  </div>
                )}

                {task.status === 'Completed' && task.completedAt && (
                  <div className="task-completed-info">
                    Completed: {new Date(task.completedAt).toLocaleDateString()}
                  </div>
                )}

                <div className="task-card-actions">
                  {task.assignedTo?._id === user._id && task.status !== 'Completed' && (
                    <>
                      {task.status === 'Pending' && (
                        <button className="btn-sm btn-outline" onClick={() => handleStatusUpdate(task, 'In Progress')}>
                          Start
                        </button>
                      )}
                      <button className="btn-sm btn-success" onClick={() => handleStatusUpdate(task, 'Completed')}>
                        Mark Complete
                      </button>
                    </>
                  )}
                  {isManager && (
                    <>
                      <button className="btn-sm btn-outline" onClick={() => { setEditTask(task); setShowForm(true); }}>
                        Edit
                      </button>
                      <button className="btn-sm btn-danger" onClick={() => handleDelete(task._id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <TaskForm
          task={editTask}
          users={users}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}
    </div>
  );
}
