import './StatCard.css';

export default function StatCard({ label, value, sub, icon, trend, color = 'blue', onClick }) {
  return (
    <div className={`stat-card stat-card--${color}${onClick ? ' stat-card--clickable' : ''}`} onClick={onClick}>
      <div className="stat-card__header">
        <span className="stat-card__icon">{icon}</span>
        {trend !== undefined && (
          <span className={`stat-card__trend ${trend >= 0 ? 'stat-card__trend--up' : 'stat-card__trend--down'}`}>
            {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
          </span>
        )}
      </div>
      <div className="stat-card__body">
        <div className="stat-card__value">{value}</div>
        <div className="stat-card__label">{label}</div>
        {sub && <div className="stat-card__sub">{sub}</div>}
      </div>
    </div>
  );
}
