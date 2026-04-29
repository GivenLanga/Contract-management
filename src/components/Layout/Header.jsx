import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../../context/NotificationContext';
import './Header.css';

export default function Header({ title, subtitle }) {
  const [searchQuery, setSearchQuery] = useState('');
  const navigate = useNavigate();
  const { unreadCount } = useNotifications();

  const handleSearch = (e) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      navigate(`/contracts?search=${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery('');
    }
  };

  return (
    <header className="header">
      <div className="header__left">
        <h1 className="header__title">{title}</h1>
        {subtitle && <p className="header__subtitle">{subtitle}</p>}
      </div>

      <div className="header__right">
        <div className="header__search">
          <span className="header__search-icon">🔍</span>
          <input
            className="header__search-input"
            type="text"
            placeholder="Search contracts, parties, tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearch}
          />
        </div>

        <div className="header__actions">
          <button
            className="header__icon-btn"
            onClick={() => navigate('/notifications')}
            aria-label="Notifications"
          >
            🔔
            {unreadCount > 0 && (
              <span className="header__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
            )}
          </button>

          <button
            className="header__new-btn"
            onClick={() => navigate('/contracts/new')}
          >
            + New Contract
          </button>
        </div>
      </div>
    </header>
  );
}
