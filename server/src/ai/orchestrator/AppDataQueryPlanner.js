'use strict';

const { CATEGORIES, DomainIntentClassifier } = require('./DomainIntentClassifier');
const { normalizeQuery } = require('./QueryNormalizer');
const { clarificationRequired } = require('../results/AiResultFactory');

const hasAny = (text, ...terms) => terms.some((term) => text.includes(term));

const progressPeriod = (normalized) =>
  ['today', 'this_week', 'this_month', 'this_year'].includes(normalized.period)
    ? normalized.period
    : 'this_month';

const plan = (overrides) => ({
  isAppDataQuery: true,
  domain: overrides.domain || 'unknown',
  intent: overrides.intent || 'summary',
  capabilityId: overrides.capabilityId || null,
  toolName: overrides.toolName || null,
  args: overrides.args || {},
  filters: overrides.filters || overrides.args?.filters || {},
  requestedFields: overrides.requestedFields || [],
  answerShape: overrides.answerShape || 'metric_summary',
  confidence: overrides.confidence ?? 0.9,
  reason: overrides.reason || 'Matched deterministic app-data capability.',
  classification: overrides.classification,
  normalizedQuery: overrides.normalized?.text,
});

class AppDataQueryPlanner {
  constructor(opts = {}) {
    this._classifier = opts.classifier || new DomainIntentClassifier();
  }

  plan(message) {
    const normalized = normalizeQuery(message);
    const classification = this._classifier.classify(message);

    if (/\blegal folder\b/.test(normalized.text)) {
      return this._notAppData(normalized, classification, 'Legal Folder count/search remains with the existing router.');
    }

    if (classification.category !== CATEGORIES.APP_DATA_QUERY) {
      return this._notAppData(normalized, classification, `Category ${classification.category} is not app data.`);
    }

    const generalOperationalPlan = this._generalOperational(normalized, classification);
    if (generalOperationalPlan) return generalOperationalPlan;

    const documentPlan = this._documents(normalized, classification);
    if (documentPlan) return documentPlan;

    const contractPlan = this._contracts(normalized, classification);
    if (contractPlan) return contractPlan;

    const taskPlan = this._tasks(normalized, classification);
    if (taskPlan) return taskPlan;

    const signingPlan = this._signing(normalized, classification);
    if (signingPlan) return signingPlan;

    const reportPlan = this._reports(normalized, classification);
    if (reportPlan) return reportPlan;

    const notificationPlan = this._notifications(normalized, classification);
    if (notificationPlan) return notificationPlan;

    return plan({
      domain: classification.domain || 'unknown',
      intent: classification.queryType || 'unknown',
      answerShape: 'clarification',
      confidence: 0.5,
      classification,
      normalized,
      reason: 'The query asks for app data, but no safe backend capability matched.',
    });
  }

  _generalOperational(n, classification) {
    const text = n.text;
	    if (hasAny(text, 'attention today', 'needs my attention', 'need my attention', 'what should i follow up')) {
	      return plan({
	        domain: 'tasks',
	        intent: 'list',
	        capabilityId: 'tasks.attention_today',
	        toolName: 'query_tasks',
	        args: { filters: { dueRange: 'today' }, limit: 20 },
	        requestedFields: ['title', 'status', 'priority', 'deadline', 'assignedTo', 'sourceType'],
	        answerShape: 'cards',
	        confidence: 0.96,
	        classification,
	        normalized: n,
	        reason: 'Matched general manager-attention operational query.',
	      });
	    }
	    if (/\bdue today\b/.test(text) && !/\btasks?\b/.test(text)) {
	      return plan({
	        domain: 'tasks',
	        intent: 'list',
	        capabilityId: 'tasks.due_today',
	        toolName: 'query_tasks',
	        args: { filters: { dueRange: 'today' }, limit: 20 },
	        requestedFields: ['title', 'status', 'priority', 'deadline', 'assignedTo', 'sourceType'],
	        answerShape: 'cards',
	        confidence: 0.94,
	        classification,
	        normalized: n,
	        reason: 'Matched general due-today task query.',
	      });
	    }
	    if (/\bdue this week\b/.test(text) && !/\btasks?\b/.test(text)) {
	      return plan({
	        domain: 'tasks',
	        intent: 'list',
	        capabilityId: 'tasks.due_this_week',
	        toolName: 'query_tasks',
	        args: { filters: { dueRange: 'this_week' }, limit: 20 },
	        requestedFields: ['title', 'status', 'priority', 'deadline', 'assignedTo', 'sourceType'],
	        answerShape: 'cards',
	        confidence: 0.94,
	        classification,
	        normalized: n,
	        reason: 'Matched general due-this-week task query.',
	      });
	    }
	    if (/\boverdue\b/.test(text) && !/\b(tasks?|contracts?|documents?)\b/.test(text)) {
	      return plan({
	        domain: 'tasks',
	        intent: 'list',
	        capabilityId: 'tasks.overdue',
	        toolName: 'list_overdue_tasks',
	        args: { mine_only: false, limit: 20 },
	        requestedFields: ['title', 'status', 'priority', 'deadline', 'assignedTo', 'sourceType'],
	        answerShape: 'cards',
	        confidence: 0.94,
	        classification,
	        normalized: n,
	        reason: 'Matched general overdue task query.',
	      });
	    }
    return null;
  }

  toToolCall(queryPlan) {
    if (!queryPlan?.isAppDataQuery || !queryPlan.toolName) return null;
    return {
      type: 'tool_call',
      toolName: queryPlan.toolName,
      arguments: queryPlan.args || {},
      capabilityId: queryPlan.capabilityId,
    };
  }

  clarification(queryPlan) {
    const domain = queryPlan?.domain && queryPlan.domain !== 'unknown'
      ? queryPlan.domain.replace(/_/g, ' ')
      : 'app data';
    return clarificationRequired({
      title: 'Choose a System Lookup',
      summary: `I need to use a backend tool for ${domain}, but I could not select one confidently. Please ask for a count, list, status, value, due-date, signing, or progress lookup.`,
	      options: ['contracts', 'tasks', 'signing', 'documents', 'reports'],
	    });
	  }

  _notAppData(normalized, classification, reason) {
    return {
      isAppDataQuery: false,
      domain: classification.domain || 'unknown',
      intent: classification.queryType || 'unknown',
      capabilityId: null,
      toolName: null,
      args: {},
      filters: {},
      requestedFields: [],
      answerShape: 'clarification',
      confidence: classification.confidence || 0,
      reason,
      classification,
      normalizedQuery: normalized.text,
    };
  }

  _contracts(n, classification) {
    const text = n.text;
    if (!n.domainHints.includes('contracts')) return null;

    const filters = {};
    if (n.contractStatus) filters.status = n.contractStatus;
    if (n.contractType) filters.contractType = n.contractType;
    if (n.departments.length) filters.department = n.departments[0];
    if (/\b(expired|already expired|have expired|has expired|past expiry|past expiration)\b/.test(text)) {
      filters.expiredOnly = true;
      filters.status = 'Expired';
    } else if (/\b(expiring|expire soon|expires soon|expire in|expires in|within \d|next \d|this month|next month)\b/.test(text)) {
      filters.expiringWithinDays = n.days || 30;
    }

    if (/\b(total value|value of|worth|how much|amount)\b/.test(text)) {
      return plan({
        domain: 'contracts',
        intent: 'value',
        capabilityId: filters.status === 'Active' ? 'contracts.value.active' : filters.status === 'Expired' ? 'contracts.value.expired' : 'contracts.value.total',
        toolName: 'query_contract_value',
        args: { filters, groupBy: hasAny(text, 'by department') ? 'department' : hasAny(text, 'by type') ? 'type' : null },
        filters,
        requestedFields: ['value', 'currency', 'status', 'department', 'type'],
        answerShape: 'metric_summary',
        confidence: 0.95,
        classification,
        normalized: n,
        reason: 'Matched contract value query.',
      });
    }

    if (/\bmissing signed|no signed copy|without signed copy|missing final\b/.test(text)) {
      return plan({
        domain: 'contracts',
        intent: 'list',
        capabilityId: 'contracts.missing_signed_copy',
        toolName: 'get_contracts_missing_signed_copy',
        args: {},
        filters: { missingSignedCopyOnly: true },
        requestedFields: ['title', 'status', 'documentStage'],
        answerShape: 'cards',
        confidence: 0.93,
        classification,
        normalized: n,
        reason: 'Matched missing signed copy query.',
      });
    }

    if (/\brenew|renewal\b/.test(text)) {
      return plan({
        domain: 'contracts',
        intent: 'list',
        capabilityId: 'contracts.renewal_candidates',
        toolName: 'get_contract_renewal_candidates',
        args: { days: n.days || 60 },
        filters: { renewalCandidates: true },
        requestedFields: ['title', 'expiryDate', 'endDate', 'status'],
        answerShape: 'cards',
        confidence: 0.93,
        classification,
        normalized: n,
        reason: 'Matched renewal candidate query.',
      });
    }

    return plan({
      domain: 'contracts',
      intent: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'list',
      capabilityId: filters.status === 'Active' ? 'contracts.active.count' : filters.status === 'Expired' ? 'contracts.expired.count' : 'contracts.list',
      toolName: 'query_contracts',
      args: {
        filters,
        countOnly: /\b(how many|count|number of)\b/.test(text),
        limit: 20,
      },
      filters,
      requestedFields: ['contractId', 'title', 'type', 'status', 'expiryDate', 'endDate', 'value', 'department', 'counterparty'],
      answerShape: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'cards',
      confidence: 0.9,
      classification,
      normalized: n,
      reason: 'Matched generic contract query.',
    });
  }

  _tasks(n, classification) {
    const text = n.text;
    if (!n.domainHints.includes('tasks')) return null;
    if (/\b(workload|overloaded|most work|capacity)\b/.test(text)) {
      return plan({
        domain: 'tasks',
        intent: 'summary',
        capabilityId: 'tasks.team_workload',
        toolName: 'get_task_summary',
        args: { mine_only: false, period: progressPeriod(n) },
        requestedFields: ['pending', 'inProgress', 'overdue', 'completed'],
        answerShape: 'metric_summary',
        confidence: 0.95,
        classification,
        normalized: n,
        reason: 'Matched team workload query.',
      });
    }
    const filters = {};
    if (/\boverdue|past due|late\b/.test(text)) filters.overdueOnly = true;
    if (/\bcompleted\b/.test(text)) filters.completedThisMonth = n.period === 'this_month';
    if (/\bdue today\b/.test(text)) filters.dueRange = 'today';
    if (/\bdue this week\b/.test(text)) filters.dueRange = 'this_week';
    if (/\btracker\b/.test(text)) filters.sourceType = 'LEGAL_TRACKER';
    if (/\bmanual workflow|manual task\b/.test(text)) filters.sourceType = 'MANUAL_WORKFLOW';
    if (/\bsignature follow[- ]?ups?\b/.test(text)) filters.sourceType = 'SIGNATURE_FOLLOW_UP';
    if (/\bunassigned|not assigned|no owner|without owner\b/.test(text)) filters.unassignedOnly = true;
    if (/\b(my|i have|assigned to me)\b/.test(text)) filters.assignedTo = 'me';
    return plan({
      domain: 'tasks',
      intent: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'list',
      capabilityId: filters.sourceType ? 'tasks.by_source' : 'tasks.my_list',
      toolName: 'query_tasks',
      args: { filters, countOnly: /\b(how many|count|number of)\b/.test(text), limit: 20 },
      filters,
      requestedFields: ['title', 'status', 'priority', 'deadline', 'assignedTo', 'sourceType'],
      answerShape: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'cards',
      confidence: 0.88,
      classification,
      normalized: n,
      reason: 'Matched generic task query.',
    });
  }

  _documents(n, classification) {
    const text = n.text;
    if (!n.domainHints.includes('documents')) return null;
    const filters = {};
    if (/\bexpired|past expiry|past expiration\b/.test(text)) filters.expiredOnly = true;
    if (/\bsigned\b/.test(text)) filters.signedOnly = true;
    if (/\bawaiting signature|pending signature\b/.test(text)) filters.awaitingSignatureOnly = true;
    if (/\brecent|uploaded\b/.test(text)) filters.recentOnly = true;
    return plan({
      domain: 'documents',
      intent: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'list',
      capabilityId: filters.expiredOnly ? 'documents.expired_if_supported' : 'documents.status_summary',
      toolName: 'query_documents',
      args: { filters, countOnly: /\b(how many|count|number of)\b/.test(text), limit: 20 },
      filters,
      requestedFields: ['title', 'status', 'type', 'documentStage', 'updatedAt'],
      answerShape: filters.expiredOnly ? 'metric_summary' : 'cards',
      confidence: 0.9,
      classification,
      normalized: n,
      reason: 'Matched generic document query.',
    });
  }

  _signing(n, classification) {
    const text = n.text;
    if (!n.domainHints.includes('signing')) return null;
    const filters = {};
    if (/\bsent for signature|signature email|sent to sign\b/.test(text)) filters.sentForSignature = true;
    if (/\bfully signed|been signed|signed agreements?|signed documents?|executed\b/.test(text)) filters.fullySigned = true;
    if (/\bawaiting signature|pending signature|who still needs to sign|needs to sign\b/.test(text)) filters.awaitingSignature = true;
    return plan({
      domain: 'signing',
      intent: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'list',
      capabilityId: filters.fullySigned ? 'signing.fully_signed' : filters.sentForSignature ? 'signing.sent_for_signature' : 'signing.awaiting_signature',
      toolName: 'query_signing',
      args: { filters, countOnly: /\b(how many|count|number of)\b/.test(text), limit: 20 },
      filters,
      requestedFields: ['name', 'status', 'signingProgress', 'signers'],
      answerShape: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'cards',
      confidence: 0.88,
      classification,
      normalized: n,
      reason: 'Matched generic signing query.',
    });
  }

  _reports(n, classification) {
    const text = n.text;
    if (!n.domainHints.includes('reports')) return null;
    if (/\bworkflow|tasks?|progress\b/.test(text)) {
      return plan({
        domain: 'reports',
        intent: 'progress',
        capabilityId: 'reports.workflow_progress',
        toolName: 'query_reports_summary',
        args: { reportType: 'tasks', period: progressPeriod(n) },
        requestedFields: ['openTasks', 'overdueTasks', 'workflowTasks'],
        answerShape: 'metric_summary',
        confidence: 0.92,
        classification,
        normalized: n,
        reason: 'Matched report progress query.',
      });
    }
    return plan({
      domain: 'reports',
      intent: 'summary',
      capabilityId: 'reports.dashboard_summary',
      toolName: 'query_reports_summary',
      args: { reportType: this._reportType(text), period: n.period },
      requestedFields: ['metrics', 'summary'],
      answerShape: 'metric_summary',
      confidence: 0.86,
      classification,
      normalized: n,
      reason: 'Matched generic report/dashboard query.',
    });
  }

  _notifications(n, classification) {
    const text = n.text;
    if (!n.domainHints.includes('notifications')) return null;
    return plan({
      domain: 'notifications',
      intent: /\b(how many|count|number of)\b/.test(text) ? 'count' : 'list',
      capabilityId: /\b(unread|new|count|how many)\b/.test(text) ? 'notifications.unread_count' : 'notifications.latest',
      toolName: /\b(unread|new|count|how many)\b/.test(text) ? 'count_my_notifications' : 'list_my_notifications',
      args: /\b(unread|new|count|how many)\b/.test(text) ? { unread_only: true } : { unread_only: false, limit: 10 },
      requestedFields: ['title', 'message', 'priority', 'createdAt'],
      answerShape: /\b(unread|new|count|how many)\b/.test(text) ? 'count' : 'cards',
      confidence: 0.85,
      classification,
      normalized: n,
      reason: 'Matched notification query.',
    });
  }

  _reportType(text) {
    if (/\bsla\b/.test(text)) return 'sla';
    if (/\bcontract health|contract management|contracts?\b/.test(text)) return 'contract_health';
    if (/\bsigning|signature\b/.test(text)) return 'signing';
    if (/\btasks?\b/.test(text)) return 'tasks';
    if (/\bdepartment\b/.test(text)) return 'department';
    return 'dashboard';
  }
}

module.exports = { AppDataQueryPlanner };
