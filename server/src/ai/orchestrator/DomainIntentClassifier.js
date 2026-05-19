'use strict';

const {
  hasAny,
  isCountQuery,
  isListQuery,
  normalizeMessage,
  parsePeriod,
} = require('./AIRequestNormalizer');

const CATEGORIES = {
  APP_DATA_QUERY: 'APP_DATA_QUERY',
  DOCUMENT_CONTENT_QUERY: 'DOCUMENT_CONTENT_QUERY',
  APP_HELP_QUERY: 'APP_HELP_QUERY',
  DRAFTING_QUERY: 'DRAFTING_QUERY',
  NAVIGATION_QUERY: 'NAVIGATION_QUERY',
  SMALL_TALK_OR_IDENTITY: 'SMALL_TALK_OR_IDENTITY',
  GENERAL: 'GENERAL',
};

const DOMAIN_TERMS = {
  contracts: ['contract', 'contracts', 'agreement', 'agreements', 'counterparty', 'renewal', 'expiry', 'expired', 'expiring'],
  workflows: ['workflow', 'workflows', 'legal tracker', 'tracker task', 'tracker tasks', 'manual workflow'],
  tasks: ['task', 'tasks', 'workload', 'overloaded', 'assigned work'],
  signing: ['sign', 'signed', 'signing', 'signature', 'signatures', 'signatory', 'signatories'],
  documents: ['document', 'documents', 'file', 'files', 'upload', 'uploaded'],
  reports: ['report', 'reports', 'dashboard', 'progress', 'analytics', 'summary', 'health', 'sla'],
  notifications: ['notification', 'notifications', 'alert', 'alerts', 'inbox'],
  users: ['user', 'users', 'team member', 'department', 'departments'],
};

const detectDomain = (text) => {
  for (const [domain, terms] of Object.entries(DOMAIN_TERMS)) {
    if (hasAny(text, ...terms)) return domain;
  }
  return 'general';
};

const detectQueryType = (text) => {
  if (/\b(total value|value of|worth|how much|revenue|amount)\b/.test(text)) return 'value';
  if (/\b(progress|performance|how is .* doing|how are .* doing)\b/.test(text)) return 'progress';
  if (isCountQuery(text)) return 'count';
  if (/\b(status|state|stage|breakdown)\b/.test(text)) return 'status';
  if (/\b(summary|overview|dashboard|report|analytics|health)\b/.test(text)) return 'summary';
  if (isListQuery(text)) return 'list';
  if (/\bdraft|write|prepare|generate|rewrite\b/.test(text)) return 'draft';
  if (/\bhow does|how do|what does .* mean|explain|what is .* process\b/.test(text)) return 'help';
  return 'detail';
};

class DomainIntentClassifier {
  classify(message) {
    const normalized = normalizeMessage(message);
    const queryType = detectQueryType(normalized);
    const domain = detectDomain(normalized);
    const normalizedTerms = normalized.split(/\s+/).filter(Boolean);

    if (!normalized) {
      return this._result({ normalized, domain: 'general', queryType: 'detail', category: CATEGORIES.GENERAL, confidence: 0 });
    }

    if (/^(hi|hello|hey|thanks|thank you|who are you|what are you)\b/.test(normalized)) {
      return this._result({ normalized, domain: 'general', queryType: 'help', category: CATEGORIES.SMALL_TALK_OR_IDENTITY, confidence: 0.95, normalizedTerms });
    }

    if (/\b(navigate|go to|open|switch to|take me to|bring me to)\b/.test(normalized)) {
      return this._result({ normalized, domain: 'navigation', queryType: 'navigate', category: CATEGORIES.NAVIGATION_QUERY, confidence: 0.95, normalizedTerms });
    }

    if (/\b(draft|write|prepare|generate|rewrite)\b/.test(normalized) &&
        /\b(addendum|contract|agreement|nda|clause|letter|notice|template|amendment)\b/.test(normalized)) {
      return this._result({ normalized, domain: 'drafting', queryType: 'draft', category: CATEGORIES.DRAFTING_QUERY, confidence: 0.95, normalizedTerms });
    }

    if (/\b(clause|provision|section|paragraph|wording|termination|indemnity|liability|what does .* say|summari[sz]e this|explain this contract)\b/.test(normalized)) {
      return this._result({ normalized, domain: 'documents', queryType: 'detail', category: CATEGORIES.DOCUMENT_CONTENT_QUERY, confidence: 0.8, normalizedTerms });
    }

    if (/\b(model|schema|route|endpoint|api|controller|middleware|field|fields|backend|server|code|implementation)\b/.test(normalized)) {
      return this._result({ normalized, domain: 'help', queryType: 'help', category: CATEGORIES.APP_HELP_QUERY, confidence: 0.85, normalizedTerms });
    }

    if (/\b(how does|how do|how is .* calculated|what does .* mean|explain|walk me through)\b/.test(normalized) &&
        /\b(app|workflow|signing|sla|dashboard|status|permission|process)\b/.test(normalized)) {
      return this._result({ normalized, domain: 'help', queryType: 'help', category: CATEGORIES.APP_HELP_QUERY, confidence: 0.8, normalizedTerms });
    }

    const appData = this._looksLikeAppData(normalized, domain, queryType);
    if (appData) {
      return this._result({
        normalized,
        domain,
        queryType,
        category: CATEGORIES.APP_DATA_QUERY,
        confidence: 0.85,
        normalizedTerms,
        period: parsePeriod(normalized),
      });
    }

    return this._result({ normalized, domain, queryType, category: CATEGORIES.GENERAL, confidence: 0.45, normalizedTerms });
  }

  _looksLikeAppData(text, domain, queryType) {
    if (domain !== 'general' && ['count', 'list', 'summary', 'status', 'value', 'progress', 'detail'].includes(queryType)) {
      if (/\b(source code|backend route|schema internals|implementation)\b/.test(text)) return false;
      return true;
    }

    return /\b(how many|count|total|status|due|overdue|expired|expiring|active|signed|pending|assigned|workload|progress|dashboard|report|value|waiting for manager|waiting for business|no update|needs my attention|need my attention|attention today|legal team|workflow|tracker|task|tasks|how is legal doing|how are legal doing|what changed recently|recent changes)\b/.test(text);
  }

  _result(result) {
    const category = result.category;
    const requiresTool = category === CATEGORIES.APP_DATA_QUERY || category === CATEGORIES.NAVIGATION_QUERY;
    return {
      domain: result.domain,
      queryType: result.queryType,
      category,
      requiresTool,
      allowModel: category !== CATEGORIES.APP_DATA_QUERY && category !== CATEGORIES.NAVIGATION_QUERY,
      allowRag: category === CATEGORIES.DOCUMENT_CONTENT_QUERY || category === CATEGORIES.APP_HELP_QUERY,
      confidence: result.confidence,
      normalized: result.normalized,
      normalizedTerms: result.normalizedTerms || [],
      period: result.period,
    };
  }
}

module.exports = { CATEGORIES, DomainIntentClassifier };
