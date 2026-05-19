const PAGE_ALIASES = [
  { page: 'dashboard',     terms: ['dashboard', 'home', 'overview', 'main page'] },
  { page: 'contracts',     terms: ['contracts', 'contract list', 'contract page', 'all contracts'] },
  { page: 'documents',     terms: ['documents', 'document list', 'document page', 'all documents'] },
  { page: 'legal folder',  terms: ['legal folder', 'legal files', 'legal documents'] },
  { page: 'signing',       terms: ['signing', 'signature', 'signatures', 'signing page', 'signing dashboard', 'sign page'] },
  { page: 'tasks',         terms: ['tasks', 'task list', 'task page', 'all tasks', 'my tasks page'] },
  { page: 'workflows',     terms: ['workflows', 'workflow'] },
  { page: 'templates',     terms: ['templates', 'template'] },
  { page: 'notifications', terms: ['notifications', 'notification center', 'alerts'] },
  { page: 'reports',       terms: ['reports', 'analytics', 'reporting'] },
  { page: 'settings',      terms: ['settings', 'preferences', 'configuration'] },
  { page: 'users',           terms: ['users', 'user management', 'team members', 'user list'] },
  { page: 'profile',         terms: ['profile', 'my profile', 'account'] },
];

const NAVIGATION_VERB = /\b(navigate|go|take me|send me|open|view|show|switch|bring me)\b/i;
const DIRECT_NAVIGATION_VERB = /\b(navigate|take me|send me|open|switch|bring me)\b|\bgo (?:to|into|open|back to)\b/i;
const HELP_RE = /^\s*(help|what can you do|what can i ask|show help|capabilities)\??\s*$/i;
const NOTIFICATION_RE = /\b(notifications?|alerts?|inbox)\b/;
const BACKEND_TECH_RE = /\b(model|schema|route|endpoint|api|service|controller|permission|field|backend|server|code|implementation)\b/;
const SIGNING_RE = /\b(sign|signs|signed|signing|signature|signatures|signign)\b/;
const { CapabilityMatcher } = require('./CapabilityMatcher');

const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/'/g, '')           // contract apostrophes: what's → whats, don't → dont
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseDays = (text, fallback = 30) => {
  const match = String(text || '').match(/\b(?:next|within|in)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/i);
  if (match) {
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1;
    return Math.min(Math.max(Number(match[1]) * multiplier, 1), 365);
  }
  if (/\bnext\s+quarter\b/i.test(text)) return 90;
  if (/\bnext\s+month\b/i.test(text)) return 30;
  if (/\bthis\s+month\b/i.test(text)) return 30;
  return fallback;
};

const hasAny = (text, ...words) => words.some((w) => text.includes(w));
const hasAll = (text, ...words) => words.every((w) => text.includes(w));

class IntentRouter {
  constructor(opts = {}) {
    this._capabilityMatcher = opts.capabilityMatcher || new CapabilityMatcher();
  }

  route(message) {
    const raw = String(message || '');
    const text = normalize(raw);
    if (!text) return null;

    // ── Identity ──────────────────────────────────────────────────────────────
    if (/^\s*(who are you|what are you|introduce yourself)\??\s*$/i.test(raw)) {
      return {
        type: 'message',
        content: 'I am your AI legal assistant for this contract management app. I can search contracts, check workflow tasks, signing status, reports, and answer questions using your Legal Folder when it is indexed.',
      };
    }

    // ── Help ─────────────────────────────────────────────────────────────────
    if (HELP_RE.test(raw)) {
      return { type: 'tool_call', toolName: 'show_help', arguments: {} };
    }

    // ── Legal Folder document count ───────────────────────────────────────────
    if (this._isLegalFolderCountQuestion(text)) {
      return { type: 'legal_folder_count' };
    }

    const notificationIntent = this._routeNotificationIntent(text);
    if (notificationIntent) return notificationIntent;

    // ── Legal workflow intents (before signing/task to allow specific disambiguation) ───
    const workflowIntent = this._routeWorkflowIntent(text, raw);
    if (workflowIntent) return workflowIntent;

    const signingIntent = this._routeSigningIntent(text);
    if (signingIntent) return signingIntent;

    // ── App overview / dashboard summary ──────────────────────────────────────
    // "contract overview"/"contract health" is a contract-specific summary, not the app overview
    const isContractSpecificOverview =
      hasAny(text, 'contract', 'contracts') &&
      hasAny(text, 'overview', 'health', 'summary', 'register');
    if (
      !isContractSpecificOverview &&
      hasAny(text, 'overview', 'dashboard', 'app summary', 'system summary', 'everything', 'whole app', 'all stats', 'big picture')
    ) {
      return { type: 'tool_call', toolName: 'get_app_overview', arguments: {} };
    }

    // ── Drafters ──────────────────────────────────────────────────────────────
    if (hasAny(text, 'currently', 'current', 'active', 'who is', 'who are') && hasAny(text, 'drafting', 'drafter', 'drafters')) {
      return { type: 'tool_call', toolName: 'show_current_drafters', arguments: {} };
    }
    if (hasAny(text, 'who') && hasAny(text, 'draft', 'drafting', 'working on')) {
      return { type: 'tool_call', toolName: 'show_current_drafters', arguments: {} };
    }
    // Only route to drafters for "who" questions, not for status/count/list questions
    if (
      hasAny(text, 'in draft', 'under review', 'being reviewed') &&
      hasAny(text, 'document', 'contract') &&
      !this._isCountQuestion(text) && !this._isListQuestion(text)
    ) {
      return { type: 'tool_call', toolName: 'show_current_drafters', arguments: {} };
    }

    // ── Overdue tasks ─────────────────────────────────────────────────────────
    if (hasAny(text, 'overdue') && hasAny(text, 'task', 'tasks')) {
      return {
        type: 'tool_call',
        toolName: 'list_overdue_tasks',
        arguments: { mine_only: hasAny(text, 'my', 'mine', 'me'), limit: 10 },
      };
    }
    if (hasAny(text, 'past due', 'late task', 'late tasks', 'missed deadline')) {
      return {
        type: 'tool_call',
        toolName: 'list_overdue_tasks',
        arguments: { mine_only: hasAny(text, 'my', 'mine', 'me'), limit: 10 },
      };
    }

    // ── Tasks due today ────────────────────────────────────────────────────────
    if (hasAny(text, 'task', 'tasks') && hasAny(text, 'due today')) {
      return { type: 'tool_call', toolName: 'list_my_tasks', arguments: { limit: 10 } };
    }

    // ── Task summary / breakdown ───────────────────────────────────────────────
    if (hasAny(text, 'task') && hasAny(text, 'summary', 'breakdown', 'status', 'count', 'overview', 'how many')) {
      return {
        type: 'tool_call',
        toolName: 'get_task_summary',
        arguments: { mine_only: !hasAny(text, 'team', 'all', 'everyone', 'whole') },
      };
    }
    if (hasAll(text, 'whats', 'happening') || hasAll(text, "what's", 'happening') || hasAll(text, 'what is', 'happening')) {
      return { type: 'tool_call', toolName: 'get_task_summary', arguments: { mine_only: true } };
    }
    if (hasAll(text, 'whats', 'going on') || hasAll(text, "what's", 'going on')) {
      return { type: 'tool_call', toolName: 'get_task_summary', arguments: { mine_only: true } };
    }
    if (hasAny(text, 'give me a summary', 'quick summary', 'status update', 'update me')) {
      return { type: 'tool_call', toolName: 'get_task_summary', arguments: { mine_only: true } };
    }

    // ── My tasks ─────────────────────────────────────────────────────────────
    if (hasAll(text, 'my', 'task') || hasAll(text, 'my', 'tasks')) {
      return { type: 'tool_call', toolName: 'list_my_tasks', arguments: { limit: 10 } };
    }
    if (hasAny(text, 'show tasks', 'list tasks', 'open tasks', 'pending tasks', 'active tasks') && hasAny(text, 'my', 'mine', 'me', 'i have', 'assigned to me')) {
      return { type: 'tool_call', toolName: 'list_my_tasks', arguments: { limit: 10 } };
    }
    if (hasAny(text, 'what tasks', 'which tasks') && hasAny(text, 'i have', 'do i have', 'assigned to me', 'my')) {
      return { type: 'tool_call', toolName: 'list_my_tasks', arguments: { limit: 10 } };
    }
    if (hasAny(text, 'tasks assigned to me', 'tasks for me', 'my open tasks', 'my pending tasks')) {
      return { type: 'tool_call', toolName: 'list_my_tasks', arguments: { limit: 10 } };
    }

    // ── Contract-specific intelligence (status, value, type, counterparty, renewal, health)
    const contractEnrichIntent = this._routeContractEnrichIntent(text, raw);
    if (contractEnrichIntent) return contractEnrichIntent;

    // ── Expired contracts (past) ─────────────────────────────────────────────
    if (hasAny(text, 'contract', 'contracts', 'agreement', 'agreements') && this._isExpiredContractQuery(text)) {
      const countOnly = this._isCountQuestion(text);
      return {
        type: 'tool_call',
        toolName: 'get_expired_contracts',
        arguments: countOnly ? { countOnly: true } : { countOnly: false, limit: 10 },
      };
    }

    // ── Expiring contracts (future) ──────────────────────────────────────────
    if (hasAny(text, 'contract', 'contracts', 'agreement', 'agreements') && this._isExpiringContractQuery(text)) {
      const days = parseDays(raw);
      const wantsList = this._isListQuestion(text);
      return {
        type: 'tool_call',
        toolName: wantsList ? 'list_expiring_contracts' : 'count_expiring_contracts',
        arguments: { days },
      };
    }

    const capabilityIntent = this._routeCapabilityIntent(raw);
    if (capabilityIntent) return capabilityIntent;

    // ── Navigation ────────────────────────────────────────────────────────────
    const page = this._pageFromNavigation(text);
    if (page) {
      return { type: 'tool_call', toolName: 'navigate_to_page', arguments: { page } };
    }

    return null;
  }

  _routeCapabilityIntent(raw) {
    const match = this._capabilityMatcher.match(raw);
    if (!match?.matched || !match.route || match.confidence < 0.75) return null;
    return match.route;
  }

  // ── Contract enrichment routing ───────────────────────────────────────────
  _routeContractEnrichIntent(text, raw) {
    const hasContractWord = hasAny(text, 'contract', 'contracts', 'agreement', 'agreements');

    // Contract management summary / health overview (must come first — broad catch-all)
    if (hasContractWord && (
      hasAny(text, 'management summary', 'contract health', 'contract overview', 'contract register',
        'contract summary', 'overall contract', 'contract status overview') ||
      (hasAny(text, 'overview', 'summary', 'health') && hasAny(text, 'contract', 'contracts') &&
       !hasAny(text, 'task', 'request', 'document', 'workflow', 'signing'))
    )) {
      return { type: 'tool_call', toolName: 'get_contract_management_summary', arguments: {} };
    }

    // Renewal candidates — match if "renewal"/"renew" present; the expired-contracts check
    // no longer fires if a renewal intent is detected (renewal is the primary concern).
    // Does NOT require a contract word — "show renewal candidates" has no contract word.
    if (hasAny(text, 'renew', 'renewal') && !BACKEND_TECH_RE.test(text)) {
      const days = parseDays(raw) || 60;
      return { type: 'tool_call', toolName: 'get_contract_renewal_candidates', arguments: { days } };
    }

    // Missing signed copy
    if (hasContractWord && (
      hasAny(text, 'missing signed', 'no signed copy', 'without signed copy',
        'missing signature copy', 'no signed document', 'unsigned copy')
    )) {
      return { type: 'tool_call', toolName: 'get_contracts_missing_signed_copy', arguments: {} };
    }

    // Contract value — check before status so "value of active contracts" hits value, not status
    if (hasContractWord && !BACKEND_TECH_RE.test(text) && (
      hasAny(text, 'total value', 'contract value', 'value of', 'total worth',
        'what is the value', 'how much', 'highest value', 'high value', 'value by department')
    )) {
      const status = this._extractContractStatusArg(text);
      return {
        type: 'tool_call',
        toolName: 'get_contract_value_summary',
        arguments: status ? { status } : {},
      };
    }

    // Contract by type (specific type keywords; must check before generic status check)
    const contractType = this._extractContractType(text);
    if (contractType) {
      return { type: 'tool_call', toolName: 'get_contracts_by_type', arguments: { contractType } };
    }

    // Contract by counterparty
    const counterpartyMatch =
      raw.match(/\bcontracts?\s+(?:with|for|involving)\s+([^?]+?)(?:\s*\?|$)/i) ||
      raw.match(/\b(?:show|list|find|get)\s+(?:all\s+)?(?:contracts?|agreements?)\s+(?:with|for|involving)\s+([^?]+?)(?:\s*\?|$)/i) ||
      raw.match(/\bagreements?\s+(?:with|for|involving)\s+([^?]+?)(?:\s*\?|$)/i);
    if (counterpartyMatch && hasContractWord && !BACKEND_TECH_RE.test(text)) {
      const counterparty = counterpartyMatch[1].trim().slice(0, 100);
      if (counterparty.length > 1) {
        return { type: 'tool_call', toolName: 'get_contracts_by_counterparty', arguments: { counterparty } };
      }
    }

    // Contract status summary — skip 'Expired' (handled by dedicated expired tool below)
    // and skip signing-subject phrases (handled by signing/workflow tools)
    if (hasContractWord && !SIGNING_RE.test(text)) {
      const status = this._extractContractStatusArg(text);
      if (status && status !== 'Expired') {
        return {
          type: 'tool_call',
          toolName: 'get_contract_status_summary',
          arguments: { status },
        };
      }
      if (
        hasAny(text, 'status breakdown', 'status summary', 'by status', 'contract breakdown',
          'breakdown of contracts', 'all statuses') ||
        (this._isCountQuestion(text) && hasContractWord &&
         !this._isExpiredContractQuery(text) && !this._isExpiringContractQuery(text) &&
         !hasAny(text, 'task', 'document', 'request', 'notification'))
      ) {
        return { type: 'tool_call', toolName: 'get_contract_status_summary', arguments: {} };
      }
    }

    return null;
  }

  _extractContractStatusArg(text) {
    if (/\b(active)\b/.test(text))                    return 'Active';
    if (/\b(draft)\b/.test(text))                     return 'Draft';
    if (/\bunder\s+review\b/.test(text))              return 'Under Review';
    if (/\bpending\s+approval\b/.test(text))          return 'Pending Approval';
    if (/\b(approved)\b/.test(text))                  return 'Approved';
    if (/\b(expired)\b/.test(text))                   return 'Expired';
    if (/\b(terminated)\b/.test(text))                return 'Terminated';
    if (/\b(cancelled|canceled)\b/.test(text))        return 'Cancelled';
    return null;
  }

  _extractContractType(text) {
    if (/\bloan\s+agreements?\b/.test(text))                              return 'LOAN_AGREEMENT';
    if (/\bgrant\s+agreements?\b/.test(text))                             return 'GRANT_AGREEMENT';
    if (/\bservice\s+provider\s+agreements?\b/.test(text))                return 'SERVICE_PROVIDER_AGREEMENT';
    if (/\b(ndas?|non.?disclosure\s+agreements?)\b/.test(text))           return 'NDA';
    if (/\blease\s+agreements?\b/.test(text))                             return 'LEASE_AGREEMENT';
    if (/\bsoftware\s+licen[cs]es?\b/.test(text))                         return 'SOFTWARE_LICENSE';
    if (/\bpartnership\s+(?:mou|memorandum)\b/.test(text))                return 'PARTNERSHIP_MOU';
    if (/\bcollections?\s+(?:recovery|contracts?)\b/.test(text))          return 'COLLECTIONS_RECOVERY';
    if (/\bcompliance\s+(?:documents?|contracts?)\b/.test(text))          return 'COMPLIANCE_DOCUMENT';
    if (/\b(msa|master\s+service\s+agreements?)\b/.test(text))            return 'MSA';
    if (/\b(sow|statement\s+of\s+work)\b/.test(text))                     return 'SOW';
    if (/\b(moa|mou|memorandum\s+of\s+(?:understanding|agreement))\b/.test(text)) return 'MOA';
    if (/\bemployment\s+(?:contracts?|agreements?)\b/.test(text))         return 'Employment';
    if (/\bvendor\s+(?:contracts?|agreements?)\b/.test(text))             return 'Vendor';
    return null;
  }

  _isLegalFolderCountQuestion(text) {
    const hasLegalContext = /\blegal (folder|document|documents|files|file)\b/.test(text)
      || /\b(legal folder|legal files)\b/.test(text);
    const hasCountIntent = /\b(how many|count|number of|total|list|show|display)\b/.test(text);
    const hasFileIntent = /\b(file|files|document|documents)\b/.test(text);
    return hasLegalContext && (hasCountIntent || hasFileIntent);
  }

  _isCountQuestion(text) {
    return /\b(how many|count|number of|total)\b/.test(text);
  }

  _isListQuestion(text) {
    return /\b(list|show|which|what)\b/.test(text) || text.startsWith('list') || text.startsWith('show');
  }

  _isExpiredContractQuery(text) {
    return /\b(expired|already expired|have expired|has expired|past expiry|past expiration|past renewal|past end date|past contract end|out of term)\b/.test(text);
  }

  _isExpiringContractQuery(text) {
    return /\b(expiring|expires? soon|expires? within|expires? in|expires? next|expires? this|expire soon|expire within|expire in|expire next|expire this|expiry soon|upcoming expiry|about to expire|coming up for renewal|renewal due|renewals? soon|end soon|ends soon|ending soon|end this month|ending this month|next month|next quarter|next \d{1,3} (days?|weeks?|months?))\b/.test(text);
  }

  _routeNotificationIntent(text) {
    if (!NOTIFICATION_RE.test(text)) return null;
    if (BACKEND_TECH_RE.test(text)) return null;

    if (this._isNotificationNavigation(text)) {
      return { type: 'tool_call', toolName: 'navigate_to_page', arguments: { page: 'notifications' } };
    }

    const unreadOnly = /\b(unread|new|unseen|unopened)\b/.test(text);
    const countOnly = /\b(how many|count|number of|total)\b/.test(text);

    if (countOnly) {
      return {
        type: 'tool_call',
        toolName: 'count_my_notifications',
        arguments: { unread_only: unreadOnly },
      };
    }

    return {
      type: 'tool_call',
      toolName: 'list_my_notifications',
      arguments: { unread_only: unreadOnly, limit: 10 },
    };
  }

  _isNotificationNavigation(text) {
    if (DIRECT_NAVIGATION_VERB.test(text)) return true;

    const namesNotificationPage = /\b(notification center|notifications? (page|screen|section))\b/.test(text);
    if (!namesNotificationPage) return false;

    return /\b(show|view|take me|bring me)\b/.test(text);
  }

  _routeSigningIntent(text) {
    if (!SIGNING_RE.test(text)) return null;
    if (BACKEND_TECH_RE.test(text)) return null;

    const countOnly = /\b(how many|count|number of|total)\b/.test(text);
    const listArgs = { limit: 10 };
    const choose = (countTool, listTool) => ({
      type: 'tool_call',
      toolName: countOnly ? countTool : listTool,
      arguments: countOnly ? {} : listArgs,
    });

    if (
      hasAny(text, 'contract', 'contracts', 'agreement', 'agreements') &&
      hasAny(text, 'already signed', 'been signed', 'were signed', 'fully signed', 'executed', 'signed contract', 'signed contracts', 'signed agreement', 'signed agreements') &&
      !hasAny(text, 'document', 'documents', 'pdf', 'file')
    ) {
      return { type: 'tool_call', toolName: 'get_signed_agreements_summary', arguments: {} };
    }

    if (hasAny(text, 'already signed', 'been signed', 'were signed', 'have signed', 'completed signing', 'fully signed')) {
      return { type: 'tool_call', toolName: 'count_signed_documents', arguments: {} };
    }
    if (hasAny(text, 'signed contracts', 'signed documents', 'completed signatures', 'completed documents')) {
      return { type: 'tool_call', toolName: 'count_signed_documents', arguments: {} };
    }
    if (countOnly && hasAny(text, 'signed') && !hasAny(text, 'pending', 'await', 'waiting', 'need', 'needs', 'require', 'ready', 'to be')) {
      return { type: 'tool_call', toolName: 'count_signed_documents', arguments: {} };
    }

    if (hasAny(text, 'external party', 'external parties', 'counterparty', 'counter party', 'outside party', 'outside parties')) {
      return choose('count_external_party_pending_signatures', 'list_external_party_pending_signatures');
    }

    if (
      hasAny(text, 'my signature', 'for my signature', 'ready for my signature', 'need my signature', 'needs my signature') ||
      hasAny(text, 'need to sign', 'have to sign', 'must sign', 'should sign', 'got to sign') ||
      hasAny(text, 'anything to sign', 'something to sign')
    ) {
      return choose('count_my_pending_signatures', 'list_my_pending_signatures');
    }

    if (
      hasAny(text, 'in the signing platform', 'on the signing platform', 'signing platform', 'signign platform', 'in signing', 'on signing') ||
      hasAny(text, 'pending signature', 'awaiting signature', 'waiting for signature', 'ready to be signed', 'ready to sign', 'ready for signing', 'ready for signature') ||
      (countOnly && hasAny(text, 'signature', 'signing', 'sign') && !hasAny(text, 'already', 'been', 'completed'))
    ) {
      return choose('count_documents_in_signing_platform', 'list_pending_signatures');
    }

    return null;
  }

  _routeWorkflowIntent(text, raw) {
    const taskFilters = {};
    if (hasAny(text, 'legal tracker', 'tracker task', 'tracker tasks', 'tracker row', 'tracker rows')) {
      taskFilters.sourceType = 'LEGAL_TRACKER';
    }
    if (hasAny(text, 'manual workflow', 'manual task', 'manual tasks')) {
      taskFilters.sourceType = 'MANUAL_WORKFLOW';
    }
    if (hasAny(text, 'due today', 'attention today', 'needs my attention', 'need my attention', 'whats next for me')) {
      taskFilters.dueRange = 'today';
    } else if (hasAny(text, 'due this week', 'due next week', 'due this month') || hasAll(text, 'due', 'week')) {
      taskFilters.dueRange = 'this_week';
    }
    if (hasAny(text, 'unassigned', 'not assigned', 'no owner', 'nobody assigned', 'has no owner', 'without owner')) {
      taskFilters.unassignedOnly = true;
    }
    if (hasAny(text, 'overdue', 'past due', 'late')) {
      if (Object.keys(taskFilters).length) {
        return { type: 'tool_call', toolName: 'query_tasks', arguments: { filters: { ...taskFilters, overdueOnly: true }, limit: 20 } };
      }
      if (!hasAny(text, 'contract', 'contracts', 'document', 'documents')) {
        return { type: 'tool_call', toolName: 'list_overdue_tasks', arguments: { mine_only: hasAny(text, 'my', 'mine', 'me'), limit: 10 } };
      }
    }

    if (Object.keys(taskFilters).length) {
      return { type: 'tool_call', toolName: 'query_tasks', arguments: { filters: taskFilters, limit: 20 } };
    }

    if (
      hasAny(text, 'what should i follow up', 'what should follow up', 'what to work on', 'focus on') ||
      hasAll(text, 'manager', 'attention')
    ) {
      return { type: 'tool_call', toolName: 'query_tasks', arguments: { filters: { dueRange: 'today' }, limit: 20 } };
    }

    if (
      hasAny(text, 'waiting for manager', 'with manager', 'manager review', 'manager action',
        'pending manager', 'manager approval', 'waiting on manager', 'in manager review',
        'waiting for business', 'with business', 'business input', 'business review',
        'no update', 'no activity', 'no progress', 'stale', 'no movement', 'stuck', 'blocking', 'blocked', 'bottleneck')
    ) {
      return { type: 'tool_call', toolName: 'query_reports_summary', arguments: { reportType: 'tasks', period: 'this_month' } };
    }

    if (hasAny(text, 'ready for signature', 'ready to be signed', 'final documents ready for signing')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }

    if (hasAny(text, 'signature email', 'signature emails', 'signing email', 'signing emails', 'sent for signature', 'sent to sign')) {
      return { type: 'tool_call', toolName: 'query_signing', arguments: { filters: { sentForSignature: true }, limit: 20 } };
    }

    if (
      hasAny(text, 'team workload', 'workload summary', 'whos handling most', 'who handles most',
        'workload by user', 'workload per person', 'most legal work') ||
      (hasAny(text, 'workload', 'overloaded') && !hasAny(text, 'contract', 'contracts', 'document', 'documents'))
    ) {
      return { type: 'tool_call', toolName: 'get_task_summary', arguments: { mine_only: false } };
    }

    if (hasAny(text, 'workflow progress', 'legal team progress', 'how is legal doing', 'how are legal doing')) {
      return { type: 'tool_call', toolName: 'query_reports_summary', arguments: { reportType: 'tasks', period: 'this_month' } };
    }

    return null;
  }

  _pageFromNavigation(text) {
    const explicitNavigation = NAVIGATION_VERB.test(text)
      || /\b(page|screen|section)\b/.test(text);
    if (!explicitNavigation) return null;

    const hit = PAGE_ALIASES.find(({ terms }) => terms.some((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(text);
    }));

    return hit?.page || null;
  }
}

module.exports = { IntentRouter };
