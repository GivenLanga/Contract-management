// Shared display helpers for Legal Request components

export const STATUS_LABELS = {
  SUBMITTED:                  'Submitted',
  INTAKE_REVIEW:              'Intake Review',
  ASSIGNED:                   'Assigned',
  IN_LEGAL_REVIEW:            'In Legal Review',
  INTERNAL_LEGAL_REVIEW:      'Internal Review',
  SENT_TO_EXTERNAL_PARTY:     'Sent for External Review (Email)',
  WAITING_FOR_EXTERNAL_PARTY: 'Waiting for External Feedback',
  EXTERNAL_FEEDBACK_RECEIVED: 'External Feedback Received',
  NEGOTIATION_AMENDMENTS:     'Negotiation / Amendments',
  WITH_BUSINESS_DEPARTMENT:   'With Business Dept.',
  WITH_MANAGER:               'With Manager',
  REVISIONS_REQUIRED:         'Revisions Required',
  MANAGER_APPROVED:           'Manager Approved',
  APPROVED:                   'Approved',
  READY_FOR_SIGNATURE:        'Ready for Signature',
  SENT_FOR_SIGNATURE:         'Sent for Signature',
  PARTIALLY_SIGNED:           'Partially Signed',
  FULLY_SIGNED:               'Fully Signed',
  STORED:                     'Stored',
  FINALIZED:                  'Finalized',
  CLOSED:                     'Closed',
  ON_HOLD:                    'On Hold',
  CANCELLED:                  'Cancelled',
};

export const REQUEST_TYPE_LABELS = {
  INTERNAL_DOCUMENT:         'Internal Document',
  EXTERNAL_CONTRACT:         'External Contract',
  LOAN_AGREEMENT:            'Loan Agreement',
  GRANT_AGREEMENT:           'Grant Agreement',
  SERVICE_PROVIDER_AGREEMENT:'Service Provider',
  NDA:                       'NDA',
  LEASE_AGREEMENT:           'Lease Agreement',
  SOFTWARE_LICENSE:          'Software License',
  COMPLIANCE_DOCUMENT:       'Compliance',
  PARTNERSHIP_MOU:           'Partnership / MOU',
  COLLECTIONS_RECOVERY:      'Collections',
  OTHER:                     'Other',
};

export const PRIORITY_COLORS = {
  LOW:    { bg: '#f8fafc', color: '#64748b', border: '#e2e8f0' },
  MEDIUM: { bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
  HIGH:   { bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  URGENT: { bg: '#fff1f2', color: '#be123c', border: '#fecdd3' },
};

export const STATUS_COLORS = {
  SUBMITTED:                  { bg: '#f8fafc', color: '#475569' },
  INTAKE_REVIEW:              { bg: '#f8fafc', color: '#475569' },
  ASSIGNED:                   { bg: '#eff6ff', color: '#1d4ed8' },
  IN_LEGAL_REVIEW:            { bg: '#eff6ff', color: '#1d4ed8' },
  INTERNAL_LEGAL_REVIEW:      { bg: '#eff6ff', color: '#1d4ed8' },
  SENT_TO_EXTERNAL_PARTY:     { bg: '#f0fdfa', color: '#0f766e' },
  WAITING_FOR_EXTERNAL_PARTY: { bg: '#f0fdfa', color: '#0f766e' },
  EXTERNAL_FEEDBACK_RECEIVED: { bg: '#f0fdf4', color: '#15803d' },
  NEGOTIATION_AMENDMENTS:     { bg: '#fefce8', color: '#a16207' },
  WITH_BUSINESS_DEPARTMENT:   { bg: '#fff7ed', color: '#c2410c' },
  WITH_MANAGER:               { bg: '#f5f3ff', color: '#7c3aed' },
  REVISIONS_REQUIRED:         { bg: '#fff1f2', color: '#be123c' },
  MANAGER_APPROVED:           { bg: '#f5f3ff', color: '#7c3aed' },
  APPROVED:                   { bg: '#f0fdf4', color: '#15803d' },
  READY_FOR_SIGNATURE:        { bg: '#f5f3ff', color: '#7c3aed' },
  SENT_FOR_SIGNATURE:         { bg: '#eff6ff', color: '#1d4ed8' },
  PARTIALLY_SIGNED:           { bg: '#fefce8', color: '#a16207' },
  FULLY_SIGNED:               { bg: '#f0fdf4', color: '#15803d' },
  STORED:                     { bg: '#f8fafc', color: '#475569' },
  FINALIZED:                  { bg: '#f0fdf4', color: '#15803d' },
  CLOSED:                     { bg: '#f8fafc', color: '#94a3b8' },
  ON_HOLD:                    { bg: '#f8fafc', color: '#94a3b8' },
  CANCELLED:                  { bg: '#fef2f2', color: '#ef4444' },
};

export const HOLDER_LABELS = {
  LEGAL_MANAGER:     'Legal Manager',
  LEGAL_TEAM_MEMBER: 'Legal Team',
  BUSINESS_DEPARTMENT:'Business Dept.',
  EXTERNAL_PARTY:    'External Party',
  SIGNATORIES:       'Signatories',
  SYSTEM_ADMIN:      'System',
  NONE:              '—',
};

export const HOLDER_COLORS = {
  LEGAL_MANAGER:      '#8b5cf6',
  LEGAL_TEAM_MEMBER:  '#4f8ef7',
  BUSINESS_DEPARTMENT:'#f59e0b',
  EXTERNAL_PARTY:     '#0d9488',
  SIGNATORIES:        '#10b981',
  SYSTEM_ADMIN:       '#94a3b8',
  NONE:               '#94a3b8',
};

export function getDaysLabel(dueDate) {
  if (!dueDate) return null;
  const now  = new Date();
  const due  = new Date(dueDate);
  const diff = Math.round((due - now) / 86400000);
  if (diff < 0)  return { label: `Overdue by ${Math.abs(diff)}d`, cls: 'overdue' };
  if (diff === 0) return { label: 'Due today',     cls: 'today' };
  if (diff <= 3)  return { label: `Due in ${diff}d`, cls: 'soon' };
  return { label: `Due in ${diff}d`, cls: 'ok' };
}

export function formatCurrency(value, currency = 'ZAR') {
  if (!value) return null;
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}
