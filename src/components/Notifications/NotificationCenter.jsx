import { useNotifications } from '../../context/NotificationContext';
import './NotificationCenter.css';

const TYPE_ICONS = {
  task_assigned: '📋',
  task_completed: '✅',
  task_overdue: '⚠️',
  document_uploaded: '📄',
  document_approved: '✅',
  document_rejected: '❌',
  signing_request: '✍️',
  signing_completed: '🖊',
  signing_all_done: '✅',
  contract_expiry_30: '⏰',
  contract_expiry_7: '🚨',
  contract_expiry_today: '🔴',
  comment_added: '💬',
  approval_request: '👍',
  approval_done: '✔️',
  general: '📢',
};

const PRIORITY_COLORS = {
  high: 'notif-priority--high',
  normal: '',
  low: 'notif-priority--low',
};

export default function NotificationCenter() {
  const { notifications, unreadCount, loading, markRead, markAllRead, dismiss } = useNotifications();

  const timeAgo = (date) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(date).toLocaleDateString();
  };

  return (
    <div className="notif-center">
      <div className="notif-header">
        <div>
          <h1>Notifications</h1>
          <p>
            {unreadCount > 0 ? (
              <><span className="notif-unread-badge">{unreadCount}</span> unread</>
            ) : (
              'All caught up'
            )}
          </p>
        </div>
        {unreadCount > 0 && (
          <button className="notif-mark-all-btn" onClick={markAllRead}>
            Mark all as read
          </button>
        )}
      </div>

      {loading ? (
        <div className="notif-loading">Loading notifications...</div>
      ) : notifications.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon">🔔</div>
          <h3>No notifications</h3>
          <p>You're all caught up! Notifications about tasks, documents, and signing requests will appear here.</p>
        </div>
      ) : (
        <div className="notif-list">
          {notifications.map((n) => (
            <div
              key={n._id}
              className={`notif-item${!n.read ? ' notif-item--unread' : ''}${PRIORITY_COLORS[n.priority] ? ` ${PRIORITY_COLORS[n.priority]}` : ''}`}
              onClick={() => !n.read && markRead(n._id)}
            >
              <div className="notif-icon-wrap">
                <span className="notif-icon">{TYPE_ICONS[n.type] || '📢'}</span>
                {!n.read && <span className="notif-dot" />}
              </div>

              <div className="notif-content">
                <div className="notif-title">{n.title}</div>
                <div className="notif-message">{n.message}</div>
                <div className="notif-time">{timeAgo(n.createdAt)}</div>
              </div>

              <button
                className="notif-dismiss"
                onClick={(e) => { e.stopPropagation(); dismiss(n._id); }}
                title="Dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
