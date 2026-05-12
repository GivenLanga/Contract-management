import './WorkflowSummaryCard.css';

const PRIORITY_LABELS = { URGENT: 'Urgent', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

const STATUS_BADGE_CLASS = {
  overdueDays: 'badge--overdue',
  dueToday:    'badge--due-today',
  dueSoon:     'badge--due-soon',
};

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ItemBadges({ item }) {
  const badges = [];

  if (item.overdueDays > 0) {
    badges.push(<span key="overdue" className="wf-badge wf-badge--overdue">{item.overdueDays}d overdue</span>);
  } else if (item.daysRemaining === 0) {
    badges.push(<span key="today" className="wf-badge wf-badge--today">Due today</span>);
  } else if (item.daysRemaining !== null && item.daysRemaining <= 3) {
    badges.push(<span key="soon" className="wf-badge wf-badge--soon">{item.daysRemaining}d left</span>);
  }

  if (item.signatureStatus === 'awaiting_signature' || item.signatureStatus === 'email_sent') {
    const label = item.escalationDue ? 'Escalation due' : item.reminderDue ? 'Reminder due' : 'Awaiting sig.';
    const cls   = item.escalationDue ? 'wf-badge--escalation' : 'wf-badge--signature';
    badges.push(<span key="sig" className={`wf-badge ${cls}`}>{label}</span>);
  }
  if (item.signatureStatus === 'fully_signed') {
    badges.push(<span key="signed" className="wf-badge wf-badge--signed">Signed</span>);
  }

  if (item.currentHolder === 'BUSINESS_DEPARTMENT') {
    badges.push(<span key="biz" className="wf-badge wf-badge--business">With Business</span>);
  }
  if (item.currentHolder === 'LEGAL_MANAGER' && item.status === 'WITH_MANAGER') {
    badges.push(<span key="mgr" className="wf-badge wf-badge--manager">With Manager</span>);
  }

  if (item.slaMissed) {
    badges.push(<span key="sla" className="wf-badge wf-badge--overdue">SLA missed</span>);
  }

  return badges.length > 0 ? <div className="wf-item-badges">{badges}</div> : null;
}

function WorkflowItem({ item }) {
  const title = item.title || item.name || item.documentName || item.legalRequestTitle || 'Untitled';
  const id = item.id || item.contractId || item.legalRequestId || item._id || item.documentName || '—';
  const meta = [
    item.status?.replace(/_/g, ' '),
    item.type || item.requestType || item.documentStage,
    item.assignedTo && `Assigned: ${item.assignedTo}`,
    item.department,
    item.counterparty && `Counterparty: ${item.counterparty}`,
    item.contract && `Contract: ${item.contract}`,
    item.dueDate && `Due: ${formatDate(item.dueDate)}`,
    item.expiryDate && `Expires: ${formatDate(item.expiryDate)}`,
    item.signedAt && `Signed: ${formatDate(item.signedAt)}`,
    item.updatedAt && `Updated: ${formatDate(item.updatedAt)}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="wf-item">
      <div className="wf-item-header">
        <span className="wf-item-id">{id}</span>
        {item.priority && item.priority !== 'MEDIUM' && (
          <span className={`wf-priority wf-priority--${item.priority.toLowerCase()}`}>
            {PRIORITY_LABELS[item.priority] || item.priority}
          </span>
        )}
        <span className="wf-item-type">{item.internalOrExternal || ''}</span>
      </div>
      <div className="wf-item-title">{title}</div>
      {meta && <div className="wf-item-meta">{meta}</div>}
      {item.legalRequestId && <div className="wf-item-action">Legal request: {item.legalRequestId}</div>}
      {item.nextAction && <div className="wf-item-action">Next: {item.nextAction}</div>}
      <ItemBadges item={item} />
    </div>
  );
}

function MetricChips({ metrics }) {
  if (!metrics || !Object.keys(metrics).length) return null;
  const entries = Object.entries(metrics).filter(
    ([k, v]) => typeof v === 'number' && !['slaThresholdDays', 'lookaheadDays', 'periodDays', 'thresholdDays'].includes(k)
  );
  if (!entries.length) return null;

  const label = (k) => k
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace('Pct', '%')
    .replace('Avg ', 'Avg. ')
    .trim();

  const formatValue = (k, v) => {
    if (typeof v === 'number' && /value|amount/i.test(k)) {
      return `${metrics.currency || 'ZAR'} ${v.toLocaleString()}`;
    }
    if (typeof v === 'number' && k.endsWith('Pct')) return `${v}%`;
    return v;
  };

  return (
    <div className="wf-metrics">
      {entries.map(([k, v]) => (
        <span key={k} className="wf-metric-chip">
          <strong>{formatValue(k, v)}</strong>
          <span>{label(k)}</span>
        </span>
      ))}
    </div>
  );
}

function SectionGroup({ section }) {
  if (!section.items?.length) return null;
  return (
    <div className="wf-section">
      <div className="wf-section-label">{section.label} ({section.items.length})</div>
      {section.items.map((item) => (
        <WorkflowItem key={item._id || item.id} item={item} />
      ))}
    </div>
  );
}

function HistoryTimeline({ history }) {
  if (!history?.length) return null;
  return (
    <div className="wf-history">
      {history.map((ev, i) => (
        <div key={i} className="wf-history-event">
          <div className="wf-history-dot" />
          <div className="wf-history-body">
            <div className="wf-history-meta">
              <span>{new Date(ev.timestamp).toLocaleString()}</span>
              <span>{ev.changedBy}</span>
            </div>
            <div className="wf-history-status">
              {ev.oldStatus && <span className="wf-status-old">{ev.oldStatus.replace(/_/g, ' ')}</span>}
              {ev.oldStatus && ev.newStatus && <span className="wf-arrow">→</span>}
              <span className="wf-status-new">{ev.newStatus?.replace(/_/g, ' ')}</span>
            </div>
            {ev.comment && <div className="wf-history-comment">{ev.comment}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function TeamWorkload({ team }) {
  if (!team?.length) return null;
  return (
    <div className="wf-team">
      {team.map((member) => (
        <div key={member.userId || member.name} className="wf-team-row">
          <span className="wf-team-name">{member.name}</span>
          <span className="wf-team-stat">{member.total} total</span>
          {member.overdue > 0 && <span className="wf-badge wf-badge--overdue">{member.overdue} overdue</span>}
          {member.awaitingSignature > 0 && (
            <span className="wf-badge wf-badge--signature">{member.awaitingSignature} sig pending</span>
          )}
        </div>
      ))}
    </div>
  );
}

function ResultTable({ columns, rows }) {
  if (!columns?.length || !rows?.length) return null;
  const valueFor = (value) => {
    if (!value) return '—';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
    return value;
  };
  return (
    <div className="wf-table-wrap">
      <table className="wf-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label || column.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.id || row._id || rowIndex}>
              {columns.map((column) => (
                <td key={column.key}>{valueFor(row[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function WorkflowSummaryCard({ data }) {
  if (!data) return null;

  return (
    <div className="wf-card">
      <div className="wf-card-header">
        <span className="wf-card-title">{data.title}</span>
      </div>

      {data.metrics && <MetricChips metrics={data.metrics} />}

      {/* Manager attention sections */}
      {data.sections?.map((section) => (
        <SectionGroup key={section.key} section={section} />
      ))}

      {/* Standard item list */}
      {data.items?.length > 0 && (
        <div className="wf-items">
          {data.items.map((item) => (
            <WorkflowItem key={item._id || item.id} item={item} />
          ))}
        </div>
      )}

      {/* Field/table answers */}
      <ResultTable columns={data.columns} rows={data.rows} />

      {/* Workflow history timeline */}
      {data.history && <HistoryTimeline history={data.history} />}

      {/* Team workload rows */}
      {data.team && <TeamWorkload team={data.team} />}
    </div>
  );
}
