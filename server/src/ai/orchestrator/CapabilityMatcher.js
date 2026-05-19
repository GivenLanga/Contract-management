'use strict';

const { getCapability } = require('./CapabilityCatalog');
const { DomainIntentClassifier, CATEGORIES } = require('./DomainIntentClassifier');
const {
  hasAny,
  isCountQuery,
  isListQuery,
  normalizeMessage,
  parseDays,
  parsePeriod,
} = require('./AIRequestNormalizer');

const STATUS_PATTERNS = [
  ['Active', /\b(active|current|live)\b/],
  ['Draft', /\b(draft|in draft)\b/],
  ['Under Review', /\b(under review|being reviewed)\b/],
  ['Pending Approval', /\b(pending approval|awaiting approval)\b/],
  ['Pending Signature', /\b(pending signature|awaiting signature|ready for signature)\b/],
  ['Approved', /\b(approved)\b/],
  ['Expired', /\b(expired|past expiry|past expiration|already expired|have expired|has expired)\b/],
  ['Terminated', /\b(terminated)\b/],
  ['Cancelled', /\b(cancelled|canceled)\b/],
];

const CONTRACT_TYPE_PATTERNS = [
  ['LOAN_AGREEMENT', /\bloan\s+(contract|contracts|agreement|agreements)\b/],
  ['GRANT_AGREEMENT', /\bgrant\s+(contract|contracts|agreement|agreements)\b/],
  ['SERVICE_PROVIDER_AGREEMENT', /\bservice provider\s+(contract|contracts|agreement|agreements)\b/],
  ['NDA', /\b(ndas?|non disclosure|non-disclosure)\b/],
  ['LEASE_AGREEMENT', /\blease\s+(contract|contracts|agreement|agreements)\b/],
  ['SOFTWARE_LICENSE', /\bsoftware\s+licen[cs]es?\b/],
  ['MSA', /\b(msa|master service)\b/],
  ['SOW', /\b(sow|statement of work)\b/],
  ['MOA', /\b(moa|mou|memorandum)\b/],
  ['Employment', /\bemployment\s+(contract|contracts|agreement|agreements)\b/],
  ['Vendor', /\bvendor\s+(contract|contracts|agreement|agreements)\b/],
];

const cloneArgs = (args) => ({ ...(args || {}) });

class CapabilityMatcher {
  constructor(classifier = new DomainIntentClassifier()) {
    this._classifier = classifier;
  }

  match(message) {
    const raw = String(message || '');
    const text = normalizeMessage(raw);
    const classification = this._classifier.classify(raw);

    if (!text || ![CATEGORIES.APP_DATA_QUERY, CATEGORIES.NAVIGATION_QUERY].includes(classification.category)) {
      return { matched: false, classification };
    }

    const features = this._features(raw, text, classification);
    const selected = this._selectCapability(features);
    if (!selected) return { matched: false, classification, confidence: 0.4 };

    const capability = getCapability(selected.id);
    if (!capability) return { matched: false, classification, confidence: 0.4 };

    const args = { ...cloneArgs(capability.defaultArgs), ...cloneArgs(selected.args) };
    return {
      matched: true,
      confidence: selected.confidence || 0.9,
      capability,
      classification,
      route: {
        type: 'tool_call',
        toolName: capability.toolName,
        arguments: args,
        capabilityId: capability.id,
      },
    };
  }

  _features(raw, text, classification) {
    const status = STATUS_PATTERNS.find(([, re]) => re.test(text))?.[0] || null;
    const contractType = CONTRACT_TYPE_PATTERNS.find(([, re]) => re.test(text))?.[0] || null;
    const counterparty = this._extractCounterparty(raw);
    const count = isCountQuery(text);
    const list = isListQuery(text) && !count;
    const period = parsePeriod(text);

    return {
      raw,
      text,
      classification,
      count,
      list,
      period,
      days: parseDays(raw),
      domain: classification.domain,
      status,
      contractType,
      counterparty,
      hasContracts: hasAny(text, 'contract', 'contracts', 'agreement', 'agreements'),
      hasDocuments: hasAny(text, 'document', 'documents', 'file', 'files'),
      hasWorkflows: hasAny(text, 'workflow', 'workflows', 'tracker', 'legal tracker', 'manual workflow'),
      hasTasks: hasAny(text, 'task', 'tasks', 'workload', 'overloaded', 'workflow task', 'tracker task'),
      hasSigning: hasAny(text, 'sign', 'signed', 'signing', 'signature', 'signatures', 'signatory', 'signatories'),
      wantsValue: /\b(total value|value of|worth|how much|amount)\b/.test(text),
      wantsProgress: /\b(progress|performance|how is legal doing|how is the legal team doing|legal team)\b/.test(text),
      wantsDashboard: /\b(dashboard|overview|summary|report|analytics|health|what changed recently|big picture)\b/.test(text),
      wantsExpired: /\b(expired|already expired|have expired|has expired|past expiry|past expiration)\b/.test(text),
      wantsExpiring: /\b(expiring|expire soon|expires soon|expire within|expires within|expire in|expires in|next \d|this month|next month|next quarter)\b/.test(text),
      wantsSigned: /\b(signed|fully signed|executed|been signed|have been signed)\b/.test(text),
      wantsAwaitingSignature: /\b(awaiting signature|pending signature|still needs to sign|still need to sign|needs to sign|need to sign|who still needs to sign)\b/.test(text),
      wantsSentForSignature: /\b(sent for signature|sent to sign|signature email|signature emails|signing email)\b/.test(text),
      wantsTracker: /\b(legal tracker|tracker task|tracker tasks|tracker row|tracker rows)\b/.test(text),
      wantsManualWorkflow: /\b(manual workflow|manual task|manual tasks)\b/.test(text),
      wantsDueToday: /\bdue today\b/.test(text),
      wantsDueWeek: /\bdue this week|due next week|due within|due in\b/.test(text),
      wantsOverdue: /\boverdue|past due|late\b/.test(text),
      wantsWaitingManager: /\b(waiting for manager|with manager|manager review|manager approval|pending manager)\b/.test(text),
      wantsWaitingBusiness: /\b(waiting for business|with business|business input|business review|pending business)\b/.test(text),
      wantsNoUpdate: /\b(no update|stale|stuck|no activity|no progress|no movement)\b/.test(text),
      wantsUnassigned: /\b(unassigned|not assigned|no owner|without owner)\b/.test(text),
      wantsRenewal: /\b(renew|renewal|need renewal|needs renewal)\b/.test(text),
      wantsMissingSignedCopy: /\b(missing signed|no signed copy|without signed copy|missing final|missing signed copy)\b/.test(text),
      wantsWorkload: /\b(workload|overloaded|most legal work|most work|capacity)\b/.test(text),
      wantsRecentUploads: /\b(recent uploaded|recent uploads|recent documents|uploaded documents|recently uploaded)\b/.test(text),
      wantsNotifications: /\b(notification|notifications|alert|alerts|inbox)\b/.test(text),
    };
  }

  _selectCapability(f) {
    if (f.hasContracts) {
      if (f.wantsValue) {
        if (f.status === 'Active') return this._cap('contracts.value.active', {}, 0.96);
        if (f.status === 'Expired') return this._cap('contracts.value.expired', {}, 0.96);
        return this._cap('contracts.value.total', {}, 0.95);
      }
      if (f.wantsSigned && !f.hasDocuments) return this._cap('contracts.count.signed', {}, 0.95);
      if (f.wantsAwaitingSignature) return this._cap('contracts.count.awaiting_signature', {}, 0.92);
      if (f.wantsRenewal) return this._cap('contracts.renewal_candidates', { days: f.days || 60 }, 0.94);
      if (f.wantsMissingSignedCopy) return this._cap('contracts.missing_signed_copy', {}, 0.94);
      if (f.wantsExpired) return this._cap('contracts.count.expired', { countOnly: f.count }, 0.97);
      if (f.wantsExpiring) {
        return f.count
          ? this._cap('contracts.count.expiring_soon', { days: f.days }, 0.96)
          : this._cap('contracts.list.expiring_soon', { days: f.days }, 0.96);
      }
      if (f.contractType) return this._cap('contracts.by_type', { contractType: f.contractType }, 0.95);
      if (f.counterparty) return this._cap('contracts.by_counterparty', { counterparty: f.counterparty }, 0.9);
      if (f.wantsDashboard || /\b(management|health|register|overall)\b/.test(f.text)) {
        return this._cap('contracts.management_summary', {}, 0.9);
      }
      if (f.status) return this._cap(`contracts.count.${String(f.status).toLowerCase().replace(/\s+/g, '_')}`, { status: f.status }, 0.9);
      if (f.count) return this._cap('contracts.count.all', {}, 0.86);
    }

    if (f.hasWorkflows || /\blegal team\b/.test(f.text)) {
      if (f.wantsTracker) return this._cap('workflows.tracker_tasks', {}, 0.95);
      if (f.wantsManualWorkflow) return this._cap('workflows.manual_tasks', {}, 0.94);
      if (f.wantsProgress) return this._cap('reports.workflow_progress', { period: this._progressPeriod(f) }, 0.94);
      if (f.wantsDueToday) return this._cap('workflows.due_today', {}, 0.95);
      if (f.wantsDueWeek) return this._cap('tasks.due_this_week', {}, 0.9);
      if (f.wantsOverdue) return this._cap('workflows.overdue_tasks', {}, 0.95);
      if (f.wantsUnassigned) return this._cap('workflows.unassigned_tasks', {}, 0.93);
      if (f.wantsWaitingManager || f.wantsWaitingBusiness || f.wantsNoUpdate) return this._cap('workflows.summary', { period: this._progressPeriod(f) }, 0.88);
      if (f.wantsWorkload) return this._cap('tasks.team_workload', {}, 0.94);
      if (f.hasTasks || f.list) return this._cap('tasks.by_source', { filters: {}, limit: 20 }, 0.86);
    }

    if (f.hasTasks) {
      if (f.wantsWorkload) return this._cap('tasks.team_workload', {}, 0.94);
      if (f.wantsOverdue) return this._cap('tasks.overdue', { mine_only: /\b(my|mine|me)\b/.test(f.text), limit: 10 }, 0.93);
      if (f.wantsDueToday) return this._cap('tasks.due_today', {}, 0.94);
      if (f.wantsDueWeek) return this._cap('tasks.due_this_week', {}, 0.9);
      if (/\bcompleted\b/.test(f.text)) return this._cap('tasks.completed_this_month', { period: this._progressPeriod(f) }, 0.88);
      if (f.count || /\b(summary|breakdown|overview)\b/.test(f.text)) {
        return this._cap('tasks.my_summary', { mine_only: !/\b(team|all|everyone|whole)\b/.test(f.text), period: f.period === 'this_week' ? 'all' : f.period }, 0.9);
      }
      return this._cap('tasks.my_list', { limit: 10 }, 0.86);
    }

    if (f.hasDocuments) {
      if (f.wantsMissingSignedCopy) return this._cap('contracts.missing_signed_copy', {}, 0.88);
      if (f.wantsExpired) return this._cap('documents.expired_if_metadata_exists', {}, 0.97);
      if (f.wantsRecentUploads) return this._cap('documents.recent_uploads', {}, 0.9);
      if (f.wantsAwaitingSignature) {
        return f.count
          ? this._cap('signing.count_awaiting_signature', {}, 0.93)
          : this._cap('documents.awaiting_signature', { limit: 10 }, 0.93);
      }
      if (f.wantsSigned) return this._cap('documents.signed', {}, 0.93);
      if (f.count || f.wantsDashboard || f.status) return this._cap('documents.status_summary', f.status ? { status: f.status } : {}, 0.86);
    }

    if (f.hasSigning || f.wantsAwaitingSignature) {
      if (f.wantsSentForSignature) return this._cap('signing.sent_for_signature', {}, 0.88);
      if (f.wantsDashboard) return this._cap('dashboard.overview', {}, 0.82);
      if (f.wantsSigned) return this._cap('signing.fully_signed_documents', {}, 0.9);
      if (f.count) return this._cap('signing.count_awaiting_signature', {}, 0.9);
      return this._cap('signing.pending_signatories', {}, 0.88);
    }

    if (f.wantsNotifications) {
      return f.count || /\bunread\b/.test(f.text)
        ? this._cap('notifications.unread_count', { unread_only: /\bunread|new\b/.test(f.text) }, 0.9)
        : this._cap('notifications.latest', {}, 0.85);
    }

    if (f.wantsProgress && /\blegal\b/.test(f.text)) {
      return this._cap('reports.workflow_progress', { period: this._progressPeriod(f) }, 0.9);
    }

    if (f.wantsDashboard) {
      if (/\bcontract health|contract management|contract summary\b/.test(f.text)) {
        return this._cap('dashboard.contract_health', {}, 0.9);
      }
      return this._cap('dashboard.overview', {}, 0.82);
    }

    return null;
  }

  _cap(id, args, confidence) {
    return { id, args, confidence };
  }

  _progressPeriod(f) {
    if (f.period === 'today') return 'today';
    if (f.period === 'this_week') return 'this_week';
    if (f.period === 'this_year') return 'this_year';
    return 'this_month';
  }

  _extractCounterparty(raw) {
    const match = String(raw || '').match(/\b(?:contracts?|agreements?)\s+(?:with|for|involving)\s+([^?]+?)(?:\s*\?|$)/i);
    const value = match?.[1]?.trim();
    return value && value.length > 1 ? value.slice(0, 100) : null;
  }
}

module.exports = { CapabilityMatcher };
