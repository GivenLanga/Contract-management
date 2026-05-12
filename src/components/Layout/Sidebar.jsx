import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useNotifications } from '../../context/NotificationContext';
import './Sidebar.css';

const navItems = [
  {
    section: 'MAIN',
    items: [
      { to: '/',               label: 'Dashboard',       icon: '⊞', exact: true },
      { to: '/legal-requests', label: 'Legal Requests',  icon: '⚖' },
    ],
  },
  {
    section: 'CONTRACTS',
    items: [
      { to: '/contracts',  label: 'Contracts', icon: '📄' },
      { to: '/tasks',      label: 'Tasks',     icon: '✅' },
      { to: '/templates',  label: 'Templates', icon: '📋' },
      { to: '/workflows',  label: 'Workflows', icon: '⚡' },
    ],
  },
  {
    section: 'DOCUMENTS',
    items: [
      { to: '/legal-folder', label: 'Legal Folder', icon: '⚖' },
      { to: '/signing', label: 'Signing', icon: '✍️' },
    ],
  },
  {
    section: 'INTELLIGENCE',
    items: [
      { to: '/ai', label: 'AI Assistant', icon: '🤖' },
      { to: '/notifications', label: 'Notifications', icon: '🔔', showBadge: true },
      { to: '/reports', label: 'Reports & Analytics', icon: '📊' },
    ],
  },
  {
    section: 'ADMIN',
    items: [
      { to: '/settings', label: 'Settings', icon: '⚙️' },
    ],
  },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { user, logout } = useAuth();
  const { unreadCount } = useNotifications();
  const navigate = useNavigate();

  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar__brand">
        <div className="sidebar__logo">
          <span className="sidebar__logo-icon">⚖</span>
          {!collapsed && <span className="sidebar__logo-text">ContractIQ</span>}
        </div>
        <button className="sidebar__toggle" onClick={onToggle} aria-label="Toggle sidebar">
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      <nav className="sidebar__nav">
        {navItems.map(({ section, items }) => (
          <div key={section} className="sidebar__section">
            {!collapsed && <span className="sidebar__section-label">{section}</span>}
            {items.map(({ to, label, icon, exact, showBadge }) => (
              <NavLink
                key={to}
                to={to}
                end={exact}
                className={({ isActive }) =>
                  `sidebar__link${isActive ? ' sidebar__link--active' : ''}`
                }
              >
                <span className="sidebar__icon">{icon}</span>
                {!collapsed && <span className="sidebar__label">{label}</span>}
                {showBadge && unreadCount > 0 && (
                  <span className="sidebar__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div className="sidebar__footer">
          <div className="sidebar__user">
            <div className="sidebar__avatar">{initials}</div>
            <div className="sidebar__user-info">
              <span className="sidebar__user-name">{user?.name || 'User'}</span>
              <span className="sidebar__user-role">{user?.role}</span>
            </div>
          </div>
          <button className="sidebar__logout" onClick={logout} title="Sign out">
            ⏻
          </button>
        </div>
      )}
    </aside>
  );
}
