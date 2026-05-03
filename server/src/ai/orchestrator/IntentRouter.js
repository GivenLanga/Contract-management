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
  { page: 'users',         terms: ['users', 'user management', 'team members', 'user list'] },
  { page: 'profile',       terms: ['profile', 'my profile', 'account'] },
];

const NAVIGATION_VERB = /\b(navigate|go|take me|send me|open|view|show|switch|bring me)\b/i;
const DIRECT_NAVIGATION_VERB = /\b(navigate|take me|send me|open|switch|bring me)\b|\bgo (?:to|into|open|back to)\b/i;
const HELP_RE = /^\s*(help|what can you do|what can i ask|show help|capabilities)\??\s*$/i;
const NOTIFICATION_RE = /\b(notifications?|alerts?|inbox)\b/;
const BACKEND_TECH_RE = /\b(model|schema|route|endpoint|api|service|controller|permission|field|backend|server|code|implementation)\b/;
const SIGNING_RE = /\b(sign|signs|signed|signing|signature|signatures|signign)\b/;

const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/'/g, '')           // contract apostrophes: what's → whats, don't → dont
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseDays = (text, fallback = 30) => {
  const match = String(text || '').match(/\b(?:next|within|in)\s+(\d{1,3})\s+days?\b/i);
  if (!match) return fallback;
  return Math.min(Math.max(Number(match[1]), 1), 365);
};

const hasAny = (text, ...words) => words.some((w) => text.includes(w));
const hasAll = (text, ...words) => words.every((w) => text.includes(w));

class IntentRouter {
  route(message) {
    const raw = String(message || '');
    const text = normalize(raw);
    if (!text) return null;

    // ── Identity ──────────────────────────────────────────────────────────────
    if (/^\s*(who are you|what are you|introduce yourself)\??\s*$/i.test(raw)) {
      return {
        type: 'message',
        content: 'I am your AI legal assistant for this contract management app. I can search contracts, check tasks and signing status, navigate workflows, and answer questions using your Legal Folder when it is indexed.',
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

    const signingIntent = this._routeSigningIntent(text);
    if (signingIntent) return signingIntent;

    // ── "Ready to be signed" / "to be signed" = pending, NOT completed ───────
    // Must come before the already-signed block because "to be signed" contains "signed"
    if (hasAny(text, 'ready to be signed', 'ready to sign', 'ready for signing', 'ready for signature', 'ready for my signature')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    if (hasAny(text, 'in the signing platform', 'in signing', 'on the signing')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    if (text.includes('to be signed') && !hasAny(text, 'already', 'have been', 'has been', 'were', 'fully')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }

    // ── Already-signed queries (must come BEFORE general sign checks — "signed" contains "sign") ──
    // "have been signed", "already signed", "signed contracts", "completed signing"
    if (hasAny(text, 'already signed', 'been signed', 'were signed', 'have signed', 'completed signing', 'fully signed')) {
      return { type: 'tool_call', toolName: 'count_signed_documents', arguments: {} };
    }
    // Exclude "ready", "to be signed" so "how many are ready to be signed" stays as pending
    if (hasAny(text, 'how many') && hasAny(text, 'signed') && !hasAny(text, 'pending', 'await', 'waiting', 'need', 'needs', 'require', 'ready', 'to be')) {
      return { type: 'tool_call', toolName: 'count_signed_documents', arguments: {} };
    }
    if (hasAny(text, 'signed contracts', 'signed documents', 'completed signatures', 'completed documents')) {
      return { type: 'tool_call', toolName: 'count_signed_documents', arguments: {} };
    }

    // ── Signing / Signature questions ─────────────────────────────────────────
    // "pending signature", "awaiting signature", "waiting for signature"
    if (hasAny(text, 'pending') && hasAny(text, 'signature', 'signing', 'sign')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    if (hasAny(text, 'awaiting', 'waiting') && hasAny(text, 'signature', 'signing', 'sign')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    // "need my/our signature", "need to be signed", "require signature"
    if (hasAny(text, 'need', 'needs', 'require', 'requires') && hasAny(text, 'signature', 'signing')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    // "contracts/documents I need to sign", "what do I need to sign"
    if (hasAny(text, 'need to sign', 'have to sign', 'must sign', 'should sign', 'got to sign')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    // "show/list documents for signing", "what is waiting for my signature"
    if (hasAny(text, 'for signing', 'for my signature', 'for signature')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    // "how many contracts/documents need signing" — only if NOT about completed/signed state
    if (hasAny(text, 'how many') && hasAny(text, 'signature', 'signing') && !hasAny(text, 'already', 'been', 'completed')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    if (hasAny(text, 'how many') && text.includes('sign') && !text.includes('signed') && !hasAny(text, 'already', 'been', 'completed')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }
    // "anything to sign", "do i have anything to sign"
    if (hasAny(text, 'anything to sign', 'something to sign', 'documents to sign', 'contracts to sign')) {
      return { type: 'tool_call', toolName: 'list_pending_signatures', arguments: { limit: 10 } };
    }

    // ── App overview / dashboard summary ──────────────────────────────────────
    if (hasAny(text, 'overview', 'dashboard', 'app summary', 'system summary', 'everything', 'whole app', 'all stats', 'big picture')) {
      return { type: 'tool_call', toolName: 'get_app_overview', arguments: {} };
    }

    // ── Drafters ──────────────────────────────────────────────────────────────
    if (hasAny(text, 'currently', 'current', 'active', 'who is', 'who are') && hasAny(text, 'drafting', 'drafter', 'drafters')) {
      return { type: 'tool_call', toolName: 'show_current_drafters', arguments: {} };
    }
    if (hasAny(text, 'who') && hasAny(text, 'draft', 'drafting', 'working on')) {
      return { type: 'tool_call', toolName: 'show_current_drafters', arguments: {} };
    }
    if (hasAny(text, 'in draft', 'under review', 'being reviewed') && hasAny(text, 'document', 'contract')) {
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

    // ── Expiring contracts ────────────────────────────────────────────────────
    if (hasAny(text, 'contract', 'contracts') && hasAny(text, 'expir', 'renew', 'expiring soon', 'about to expire')) {
      const days = parseDays(raw);
      const wantsList = hasAny(text, 'list', 'show', 'which', 'what') || text.startsWith('list') || text.startsWith('show');
      return {
        type: 'tool_call',
        toolName: wantsList ? 'list_expiring_contracts' : 'count_expiring_contracts',
        arguments: { days },
      };
    }
    if (hasAny(text, 'contract') && hasAny(text, 'ending', 'end soon', 'end this month', 'ending soon')) {
      return { type: 'tool_call', toolName: 'list_expiring_contracts', arguments: { days: parseDays(raw, 30) } };
    }

    // ── Navigation ────────────────────────────────────────────────────────────
    const page = this._pageFromNavigation(text);
    if (page) {
      return { type: 'tool_call', toolName: 'navigate_to_page', arguments: { page } };
    }

    return null;
  }

  _isLegalFolderCountQuestion(text) {
    const hasLegalContext = /\blegal (folder|document|documents|files|file)\b/.test(text)
      || /\b(legal folder|legal files)\b/.test(text);
    const hasCountIntent = /\b(how many|count|number of|total|list|show|display)\b/.test(text);
    const hasFileIntent = /\b(file|files|document|documents)\b/.test(text);
    return hasLegalContext && (hasCountIntent || hasFileIntent);
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
