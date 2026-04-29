import './Badge.css';

export default function Badge({ status, type = 'status', size = 'md' }) {
  const key = (status || '').toLowerCase().replace(/\s+/g, '-');
  return (
    <span className={`badge badge--${key} badge--${size}`}>
      {status}
    </span>
  );
}
