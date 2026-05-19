'use strict';

const {
  isCountQuery,
  normalizeMessage,
  parseDays,
  parsePeriod,
} = require('./AIRequestNormalizer');

const DEPARTMENT_ALIASES = [
  ['Finance', /\b(finance|financial|accounts?|accounting)\b/],
  ['HR', /\b(hr|human resources?|people team)\b/],
  ['Compliance', /\b(compliance|risk)\b/],
  ['Procurement', /\b(procurement|supply chain|purchasing)\b/],
  ['IT', /\b(it|information technology|technology)\b/],
  ['Operations', /\b(operations|ops)\b/],
  ['Legal', /\blegal department\b/],
];

const CONTRACT_STATUS_ALIASES = [
  ['Active', /\b(active|current|live)\b/],
  ['Draft', /\b(draft|in draft)\b/],
  ['Under Review', /\b(under review|being reviewed)\b/],
  ['Pending Signature', /\b(pending signature|awaiting signature)\b/],
  ['Expired', /\b(expired|already expired|have expired|has expired|past expiry|past expiration)\b/],
  ['Terminated', /\b(terminated)\b/],
  ['Cancelled', /\b(cancelled|canceled)\b/],
];

const CONTRACT_TYPE_ALIASES = [
  ['LOAN_AGREEMENT', /\bloan\s+(contract|contracts|agreement|agreements)\b/],
  ['GRANT_AGREEMENT', /\bgrant\s+(contract|contracts|agreement|agreements)\b/],
  ['SERVICE_PROVIDER_AGREEMENT', /\bservice provider\s+(contract|contracts|agreement|agreements)\b/],
  ['NDA', /\b(ndas?|non disclosure|non-disclosure)\b/],
  ['LEASE_AGREEMENT', /\blease\s+(contract|contracts|agreement|agreements)\b/],
  ['SOFTWARE_LICENSE', /\bsoftware\s+licen[cs]es?\b/],
  ['MSA', /\b(msa|master service)\b/],
  ['SOW', /\b(sow|statement of work)\b/],
  ['Employment', /\bemployment\s+(contract|contracts|agreement|agreements)\b/],
  ['Vendor', /\bvendor\s+(contract|contracts|agreement|agreements)\b/],
];

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const detectDepartments = (text) =>
  DEPARTMENT_ALIASES
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);

const detectPriority = (text) => {
  if (/\b(urgent|urgently|critical|highest priority)\b/.test(text)) return 'URGENT';
  if (/\b(high priority|important|priority items?|priority requests?)\b/.test(text)) return 'HIGH';
  if (/\b(low priority)\b/.test(text)) return 'LOW';
  return null;
};

const firstAlias = (text, aliases) => aliases.find(([, re]) => re.test(text))?.[0] || null;

const detectRequestedFields = (text) => {
  const fields = [];
  if (/\b(what did|what was|asked for|ask for|requested|submitted|came in|what do i have)\b/.test(text)) {
    fields.push('title', 'description', 'sourceType');
  }
  if (/\b(when do they want|want it|need it|due|deadline|target date|wanted by|when is it needed)\b/.test(text)) {
    fields.push('dueDate', 'targetDate');
  }
  if (/\b(who|assigned|owner|holder)\b/.test(text)) fields.push('assignedTo');
  if (/\b(status|stage|state)\b/.test(text)) fields.push('status');
  if (/\b(priority|urgent|important)\b/.test(text)) fields.push('priority');
  if (/\b(department|finance|hr|compliance|procurement|operations|it)\b/.test(text)) fields.push('department');
  return unique(fields);
};

const detectIntentHints = (text) => {
  const hints = [];
  if (isCountQuery(text)) hints.push('count');
  if (/\b(total value|value of|worth|how much|amount)\b/.test(text)) hints.push('value');
  if (/\b(progress|performance|how is legal doing|legal team)\b/.test(text)) hints.push('progress');
  if (/\b(status|stage|state|breakdown)\b/.test(text)) hints.push('status');
  if (/\b(timeline|history|what happened)\b/.test(text)) hints.push('timeline');
  if (/\b(attention|follow up|focus on|prioriti[sz]e)\b/.test(text)) hints.push('attention');
  if (/\b(what did|asked for|when do they want|want it|need it)\b/.test(text)) hints.push('field_answer');
  if (/\b(show|list|which|what|find|get|display|what do i have)\b/.test(text)) hints.push('list');
  return hints.length ? hints : ['summary'];
};

const detectDomainHints = (text) => {
  const hints = [];
  if (/\b(workflow|workflows|legal tracker|tracker task|tracker tasks|tracker row|manual workflow|manual task)\b/.test(text)) {
    hints.push('workflows', 'tasks');
  }
  if (/\b(contract|contracts|agreement|agreements|counterparty|renewal|expiry|expired|expiring)\b/.test(text)) hints.push('contracts');
  if (/\b(task|tasks|workload|overloaded)\b/.test(text)) hints.push('tasks');
  if (/\b(sign|signed|signing|signature|signatures|signatory|signatories)\b/.test(text)) hints.push('signing');
  if (/\b(document|documents|file|files|uploaded)\b/.test(text)) hints.push('documents');
  if (/\b(report|dashboard|progress|analytics|summary|health|sla|department summary|what changed recently)\b/.test(text)) hints.push('reports');
  if (/\b(notification|notifications|alert|alerts|inbox)\b/.test(text)) hints.push('notifications');
  return unique(hints);
};

const normalizeQuery = (message) => {
  const raw = String(message || '');
  const text = normalizeMessage(raw)
    .replace(/\bask for\b/g, 'asked for')
    .replace(/\bwant it\b/g, 'want it')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    raw,
    text,
    tokens: text.split(/\s+/).filter(Boolean),
    period: parsePeriod(text),
    days: parseDays(raw),
    departments: detectDepartments(text),
    priority: detectPriority(text),
    contractStatus: firstAlias(text, CONTRACT_STATUS_ALIASES),
    contractType: firstAlias(text, CONTRACT_TYPE_ALIASES),
    requestedFields: detectRequestedFields(text),
    intentHints: detectIntentHints(text),
    domainHints: detectDomainHints(text),
  };
};

module.exports = {
  normalizeQuery,
};
