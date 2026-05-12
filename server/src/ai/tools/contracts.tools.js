const Contract = require('../../models/Contract');
const LegalRequest = require('../../models/LegalRequest');
const Document = require('../../models/Document');
const {
  contractVisibilityFilter,
  documentVisibilityFilter,
  legalRequestVisibilityFilter,
  mergeFilters,
  safeRegExp,
  safeWordsRegExp,
} = require('../security/DataScope');
const { safeContractFields } = require('../security/FieldFilter');

const publicParties = (parties = []) => parties.map((party) => ({
  name: party.name,
  role: party.role,
  type: party.type,
  signingOrder: party.signingOrder,
}));

const EXPIRED_STATUS = 'Expired';
const NON_ACTIVE_EXPIRY_STATUSES = ['Terminated', 'Cancelled', EXPIRED_STATUS];

const startOfToday = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

const endOfDay = (date) => {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
};

const addDays = (date, days) =>
  new Date(date.getTime() + Number(days || 0) * 86400000);

const addMonths = (date, months) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + Number(months || 0));
  return result;
};

// LegalRequest types that only exist in the LegalRequest model
const LR_ONLY_TYPES = new Set([
  'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SERVICE_PROVIDER_AGREEMENT',
  'LEASE_AGREEMENT', 'SOFTWARE_LICENSE', 'COMPLIANCE_DOCUMENT',
  'PARTNERSHIP_MOU', 'COLLECTIONS_RECOVERY', 'INTERNAL_DOCUMENT', 'EXTERNAL_CONTRACT',
]);
// Contract types that only exist in the Contract model
const CONTRACT_ONLY_TYPES = new Set([
  'MSA', 'SOW', 'License', 'MOA', 'MOI', 'SLA', 'Employment', 'Vendor', 'Lease', 'Other',
]);
// 'NDA' exists in both models

const renewalCandidatesFilter = (days) => {
  const today = startOfToday();
  const future = endOfDay(addDays(today, days));
  return {
    autoRenew: { $ne: true },
    $or: [
      { status: EXPIRED_STATUS },
      { expiryDate: { $lt: today } },
      { endDate: { $lt: today } },
      { expiryDate: { $gte: today, $lte: future } },
      { endDate: { $gte: today, $lte: future } },
    ],
  };
};

const futureExpiryFilter = (days) => {
  const from = startOfToday();
  const to = endOfDay(addDays(from, days));
  return {
    status: { $nin: NON_ACTIVE_EXPIRY_STATUSES },
    $or: [
      { expiryDate: { $gte: from, $lte: to } },
      { endDate: { $gte: from, $lte: to } },
    ],
  };
};

const expiredFilter = () => {
  const today = startOfToday();
  return {
    $or: [
      { status: EXPIRED_STATUS },
      { expiryDate: { $lt: today } },
      { endDate: { $lt: today } },
    ],
  };
};

module.exports = [
  {
    name: 'search_contracts',
    description: 'Search contracts by title, type, status, counterparty, or keyword.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query:  { type: 'string', minLength: 1, maxLength: 200 },
        status: { type: 'string', enum: ['Draft','Under Review','Pending Approval','Approved','Pending Signature','Active','Expired','Terminated','Cancelled'] },
        type:   { type: 'string', maxLength: 80 },
        limit:  { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { query, status, type, limit = 8 } = args;
      const words  = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2).slice(0, 10);
      const regex  = safeWordsRegExp(query);
      const exactQuery = safeRegExp(query);
      const filter = mergeFilters({
        $or: [
          { title: regex },
          { description: regex },
          { contractId: exactQuery },
          { 'parties.name': regex },
          { tags: { $in: words } },
        ],
      }, contractVisibilityFilter(context.user));
      if (status) filter.status = status;
      if (type)   filter.type   = type;

      const contracts = await Contract.find(filter)
        .populate('createdBy', 'name')
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      return {
        type: 'success',
        data: {
          contracts: contracts.map((c) => {
            const safe = safeContractFields(c, context.user);
            return {
              _id: safe._id, contractId: safe.contractId, title: safe.title,
              type: safe.type, status: safe.status,
              expiryDate: safe.expiryDate,
              counterparty: safe.counterparty,
              createdBy: safe.createdBy?.name,
            };
          }),
          count: contracts.length,
        },
      };
    },
  },

  {
    name: 'count_expiring_contracts',
    description: 'Count contracts expiring within a specified number of days.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['days'],
      additionalProperties: false,
      properties: {
        days: { type: 'number', minimum: 1, maximum: 365 },
      },
    },
    async execute(args, context) {
      const { days } = args;
      const count = await Contract.countDocuments(mergeFilters(
        futureExpiryFilter(days),
        contractVisibilityFilter(context.user)
      ));
      return {
        type: 'success',
        data: {
          count,
          days,
          mode: 'expiring',
          message: count === 1
            ? `1 contract is expiring within ${days} days.`
            : `${count} contracts are expiring within ${days} days.`,
        },
      };
    },
  },

  {
    name: 'list_expiring_contracts',
    description: 'List contracts expiring within a given number of days, sorted by soonest first.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['days'],
      additionalProperties: false,
      properties: {
        days:  { type: 'number', minimum: 1, maximum: 365 },
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { days, limit = 10 } = args;
      const contracts = await Contract.find(mergeFilters(
        futureExpiryFilter(days),
        contractVisibilityFilter(context.user)
      ))
        .populate('createdBy', 'name')
        .sort({ expiryDate: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'success',
        data: {
          contracts: contracts.map((c) => {
            const safe = safeContractFields(c, context.user);
            return {
              _id: safe._id, contractId: safe.contractId, title: safe.title,
              status: safe.status, expiryDate: safe.expiryDate, endDate: safe.endDate,
              parties: safe.parties?.map((p) => p.name),
            };
          }),
          count: contracts.length,
          days,
          mode: 'expiring',
          message: contracts.length === 1
            ? `1 contract is expiring within ${days} days.`
            : `${contracts.length} contracts are expiring within ${days} days.`,
        },
      };
    },
  },

  {
    name: 'get_expired_contracts',
    description: 'Count or list contracts that have already expired based on past expiry/end dates or Expired status.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        countOnly: { type: 'boolean' },
        limit:     { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { countOnly = false, limit = 10 } = args;
      const filter = mergeFilters(expiredFilter(), contractVisibilityFilter(context.user));
      const count = await Contract.countDocuments(filter);

      const data = {
        count,
        mode: 'expired',
        message: count === 1
          ? '1 contract has expired.'
          : `${count} contracts have expired.`,
      };

      if (!countOnly) {
        const contracts = await Contract.find(filter)
          .populate('createdBy', 'name')
          .sort({ expiryDate: -1, endDate: -1 })
          .limit(limit)
          .lean();

        data.contracts = contracts.map((c) => {
          const safe = safeContractFields(c, context.user);
          return {
            _id: safe._id,
            contractId: safe.contractId,
            title: safe.title,
            status: safe.status,
            expiryDate: safe.expiryDate,
            endDate: safe.endDate,
            counterparty: safe.counterparty,
          };
        });
      }

      return { type: 'success', data };
    },
  },

  {
    name: 'get_contract_status',
    description: 'Get full status, parties, value, and key dates for a named contract.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    async execute(args, context) {
      const queryRegex = safeRegExp(args.query);
      const c = await Contract.findOne(mergeFilters({
        $or: [
          { title: queryRegex },
          { contractId: queryRegex },
        ],
      }, contractVisibilityFilter(context.user))).populate('createdBy assignedTo', 'name email').lean();

      if (!c) return { type: 'not_found', message: `No contract found for "${args.query}".` };
      const safe = safeContractFields(c, context.user);
      return {
        type: 'success',
        data: {
          contractId: safe.contractId,
          title: safe.title,
          status: safe.status,
          type: safe.type,
          parties: safe.parties,
          expiryDate: safe.expiryDate,
          startDate: safe.startDate,
          value: safe.value,
          currency: safe.currency,
          createdBy: c.createdBy?.name,
          assignedTo: c.assignedTo?.map(u => u.name),
        },
      };
    },
  },

  {
    name: 'show_contract_parties',
    description: 'List all parties and signatories for a contract.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 } },
    },
    async execute(args, context) {
      const c = await Contract.findOne(mergeFilters(
        { title: safeRegExp(args.query) },
        contractVisibilityFilter(context.user)
      )).lean();
      if (!c) return { type: 'not_found', message: `Contract not found: "${args.query}".` };
      const safe = safeContractFields(c, context.user);
      return { type: 'success', data: { title: safe.title, parties: safe.parties || publicParties(c.parties) } };
    },
  },

  {
    name: 'summarise_contract_metadata',
    description: 'Summarise the key metadata of a contract: status, dates, value, parties, and type.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 } },
    },
    async execute(args, context) {
      const queryRegex = safeRegExp(args.query);
      const c = await Contract.findOne(mergeFilters({
        $or: [{ title: queryRegex }, { contractId: queryRegex }],
      }, contractVisibilityFilter(context.user))).lean();
      if (!c) return { type: 'not_found', message: `Contract not found: "${args.query}".` };
      const safe = safeContractFields(c, context.user);
      return {
        type: 'success',
        data: {
          summary: {
            id: safe.contractId, title: safe.title, type: safe.type, status: safe.status,
            value: `${safe.currency || 'USD'} ${(safe.value || 0).toLocaleString()}`,
            startDate: safe.startDate, expiryDate: safe.expiryDate,
            parties: safe.parties || publicParties(c.parties), priority: safe.priority, department: safe.department,
          },
        },
      };
    },
  },

  // ── New contract intelligence tools ──────────────────────────────────────

  {
    name: 'get_contract_status_summary',
    description: 'Get contract counts grouped by status (active, draft, expired, pending, etc.). Pass a status to filter to one group, or omit for a full breakdown.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['Draft', 'Under Review', 'Pending Approval', 'Approved', 'Pending Signature',
                 'Active', 'Expired', 'Terminated', 'Cancelled'],
        },
      },
    },
    async execute(args, context) {
      const scope = contractVisibilityFilter(context.user);
      const { status } = args;

      if (status) {
        const count = await Contract.countDocuments(mergeFilters(scope, { status }));
        const label = status.toLowerCase();
        return {
          type: 'contract_summary',
          category: `${label.replace(/\s+/g, '_')}_contracts`,
          title: `${status} Contracts`,
          summary: count === 1 ? `1 contract is ${label}.` : `${count} contracts are ${label}.`,
          metrics: { count, status },
          items: [],
        };
      }

      const rows = await Contract.aggregate([
        { $match: scope },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      const byStatus = {};
      let total = 0;
      for (const row of rows) {
        if (row._id) { byStatus[row._id] = row.count; total += row.count; }
      }
      const breakdown = Object.entries(byStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([s, c]) => `${c} ${s.toLowerCase()}`)
        .join(', ');
      return {
        type: 'contract_summary',
        category: 'contract_status_breakdown',
        title: 'Contract Status Breakdown',
        summary: total ? `${total} contracts total: ${breakdown}.` : 'No contracts found.',
        metrics: { total, byStatus },
        items: [],
      };
    },
  },

  {
    name: 'get_contract_value_summary',
    description: 'Get the total monetary value of contracts, optionally filtered by status, department, or type.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['Draft', 'Under Review', 'Pending Approval', 'Approved', 'Pending Signature',
                 'Active', 'Expired', 'Terminated', 'Cancelled'],
        },
        department:   { type: 'string', maxLength: 100 },
        contractType: { type: 'string', maxLength: 80 },
      },
    },
    async execute(args, context) {
      const { status, department, contractType } = args;
      const scope = contractVisibilityFilter(context.user);
      const extra = {};
      if (status) extra.status = status;
      if (department) extra.department = safeRegExp(department);
      if (contractType) extra.type = contractType;

      const filter = mergeFilters(scope, extra);
      const [result] = await Contract.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalValue: { $sum: '$value' },
            count: { $sum: 1 },
            currency: { $first: '$currency' },
          },
        },
      ]);
      const totalValue = result?.totalValue || 0;
      const count = result?.count || 0;
      const currency = result?.currency || 'ZAR';
      const label = [status, department, contractType].filter(Boolean).join(', ') || 'all';
      const formatted = totalValue.toLocaleString();
      return {
        type: 'contract_value_summary',
        category: 'contract_value',
        title: status ? `${status} Contract Value` : 'Contract Value Summary',
        summary: count
          ? `The total value of ${label} contracts is ${currency} ${formatted} across ${count} contract${count !== 1 ? 's' : ''}.`
          : `No ${label} contracts found.`,
        metrics: { totalValue, count, currency, filters: { status, department, contractType } },
        items: [],
      };
    },
  },

  {
    name: 'get_contracts_by_type',
    description: 'List contracts or legal requests of a specific type (e.g. LOAN_AGREEMENT, NDA, MSA, GRANT_AGREEMENT, SERVICE_PROVIDER_AGREEMENT).',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['contractType'],
      additionalProperties: false,
      properties: {
        contractType: {
          type: 'string',
          enum: [
            'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SERVICE_PROVIDER_AGREEMENT',
            'NDA', 'LEASE_AGREEMENT', 'SOFTWARE_LICENSE', 'COMPLIANCE_DOCUMENT',
            'PARTNERSHIP_MOU', 'COLLECTIONS_RECOVERY', 'INTERNAL_DOCUMENT', 'EXTERNAL_CONTRACT',
            'MSA', 'SOW', 'License', 'MOA', 'MOI', 'SLA', 'Employment', 'Vendor', 'Lease', 'Other',
          ],
        },
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { contractType, limit = 10 } = args;
      const items = [];
      const isLrType = LR_ONLY_TYPES.has(contractType);
      const isContractType = CONTRACT_ONLY_TYPES.has(contractType);
      const isBoth = contractType === 'NDA';

      if (isContractType || isBoth) {
        const filter = mergeFilters({ type: contractType }, contractVisibilityFilter(context.user));
        const contracts = await Contract.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
        for (const c of contracts) {
          const safe = safeContractFields(c, context.user);
          items.push({
            source: 'contract', id: safe.contractId, title: safe.title,
            status: safe.status, expiryDate: safe.expiryDate,
            counterparty: safe.counterparty,
          });
        }
      }

      if (isLrType || isBoth) {
        const lrType = isLrType ? contractType : 'NDA';
        const filter = mergeFilters({ requestType: lrType }, legalRequestVisibilityFilter(context.user));
        const requests = await LegalRequest.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
        for (const lr of requests) {
          items.push({
            source: 'legal_request', id: lr.requestId, title: lr.title,
            status: lr.status, counterparty: lr.counterpartyName,
          });
        }
      }

      const typeName = contractType.replace(/_/g, ' ').toLowerCase();
      const count = items.length;
      return {
        type: 'contract_summary',
        category: 'contracts_by_type',
        title: `${contractType.replace(/_/g, ' ')} Contracts`,
        summary: count
          ? `Found ${count} ${typeName} contract${count !== 1 ? 's' : ''}.`
          : `No ${typeName} contracts found.`,
        metrics: { count, contractType },
        items: items.slice(0, limit),
      };
    },
  },

  {
    name: 'get_contracts_by_counterparty',
    description: 'Find contracts and legal requests involving a specific counterparty or company.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      required: ['counterparty'],
      additionalProperties: false,
      properties: {
        counterparty: { type: 'string', minLength: 1, maxLength: 200 },
        limit:        { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { counterparty, limit = 10 } = args;
      const regex = safeRegExp(counterparty);

      const [contracts, requests] = await Promise.all([
        Contract.find(mergeFilters({ 'parties.name': regex }, contractVisibilityFilter(context.user)))
          .sort({ updatedAt: -1 }).limit(limit).lean(),
        LegalRequest.find(mergeFilters({ counterpartyName: regex }, legalRequestVisibilityFilter(context.user)))
          .sort({ updatedAt: -1 }).limit(limit).lean(),
      ]);

      const items = [
        ...contracts.map((c) => {
          const safe = safeContractFields(c, context.user);
          return { source: 'contract', id: safe.contractId, title: safe.title, status: safe.status, expiryDate: safe.expiryDate };
        }),
        ...requests.map((lr) => ({
          source: 'legal_request', id: lr.requestId, title: lr.title, status: lr.status,
        })),
      ];

      const count = items.length;
      return {
        type: 'contract_summary',
        category: 'contracts_by_counterparty',
        title: `Contracts with ${counterparty}`,
        summary: count
          ? `Found ${count} contract${count !== 1 ? 's' : ''} involving ${counterparty}.`
          : `No contracts found for "${counterparty}".`,
        metrics: { count, counterparty },
        items: items.slice(0, limit),
      };
    },
  },

  {
    name: 'get_contract_renewal_candidates',
    description: 'Find contracts that have expired or are expiring soon and may need renewal (excludes auto-renew contracts).',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days:  { type: 'number', minimum: 1, maximum: 365 },
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { days = 60, limit = 10 } = args;
      const filter = mergeFilters(renewalCandidatesFilter(days), contractVisibilityFilter(context.user));
      const count = await Contract.countDocuments(filter);
      const contracts = await Contract.find(filter)
        .sort({ expiryDate: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'contract_summary',
        category: 'renewal_candidates',
        title: 'Contracts Needing Renewal',
        summary: count
          ? `${count} contract${count !== 1 ? 's' : ''} may need renewal (expired or expiring within ${days} days).`
          : 'No contracts currently need renewal.',
        metrics: { count, days },
        items: contracts.map((c) => {
          const safe = safeContractFields(c, context.user);
          return {
            id: safe.contractId, title: safe.title, status: safe.status,
            expiryDate: safe.expiryDate, endDate: safe.endDate, autoRenew: c.autoRenew,
          };
        }),
      };
    },
  },

  {
    name: 'get_contracts_missing_signed_copy',
    description: 'Find contracts in Active, Approved, or Pending Signature status that have no signed document on file.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read', 'document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { limit = 10 } = args;

      const signedContractIds = await Document.distinct('contract', {
        contract: { $ne: null },
        status: 'Signed',
      });

      const filter = mergeFilters({
        status: { $in: ['Active', 'Approved', 'Pending Signature'] },
        _id: { $nin: signedContractIds },
      }, contractVisibilityFilter(context.user));

      const count = await Contract.countDocuments(filter);
      const contracts = await Contract.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();

      return {
        type: 'contract_summary',
        category: 'missing_signed_copy',
        title: 'Contracts Missing Signed Copy',
        summary: count
          ? `${count} contract${count !== 1 ? 's are' : ' is'} missing a signed document on file.`
          : 'All active/approved contracts have signed copies on file.',
        metrics: { count },
        items: contracts.map((c) => {
          const safe = safeContractFields(c, context.user);
          return { id: safe.contractId, title: safe.title, status: safe.status, expiryDate: safe.expiryDate };
        }),
      };
    },
  },

  {
    name: 'get_signed_agreements_summary',
    description: 'Summarise signed agreements by counting signed documents and distinct linked contracts, without exposing signing evidence or signing links.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read', 'document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { limit = 10 } = args;
      const documentScope = documentVisibilityFilter(context.user);
      const contractScope = contractVisibilityFilter(context.user);

      const signedDocFilter = mergeFilters(documentScope, { status: 'Signed' });
      const signedContractIds = await Document.distinct('contract', mergeFilters(
        signedDocFilter,
        { contract: { $ne: null } },
      ));

      const [signedDocumentCount, signedAgreementCount, signedDocs] = await Promise.all([
        Document.countDocuments(signedDocFilter),
        signedContractIds.length
          ? Contract.countDocuments(mergeFilters(contractScope, { _id: { $in: signedContractIds } }))
          : Promise.resolve(0),
        Document.find(signedDocFilter)
          .populate('contract', 'contractId title status')
          .sort({ updatedAt: -1 })
          .limit(limit)
          .lean(),
      ]);

      const note = signedDocumentCount !== signedAgreementCount
        ? 'Signed document count may differ from signed agreement count because one agreement can have multiple signed documents or no linked contract.'
        : 'Signed agreement count is based on distinct linked contracts with signed documents.';

      return {
        type: 'signing_summary',
        category: 'signed_agreements',
        title: 'Signed Agreements',
        summary: `${signedAgreementCount} agreement${signedAgreementCount !== 1 ? 's have' : ' has'} signed documents on file. ${signedDocumentCount} signed document${signedDocumentCount !== 1 ? 's were' : ' was'} found.`,
        metrics: {
          signedAgreementCount,
          signedDocumentCount,
          duplicatesPossible: signedDocumentCount !== signedAgreementCount,
        },
        items: signedDocs.map((doc) => ({
          id: String(doc._id),
          title: doc.contract?.title || doc.name,
          documentName: doc.name,
          contractId: doc.contract?.contractId || null,
          status: doc.status,
          signedAt: doc.updatedAt,
        })),
        warnings: signedDocumentCount ? [note] : [],
      };
    },
  },

  {
    name: 'get_contract_management_summary',
    description: 'Get a comprehensive contract management health overview: active, draft, expired, expiring soon, awaiting signature, missing signed copies, total active value, and renewal candidates.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const scope = contractVisibilityFilter(context.user);
      const today = startOfToday();
      const in30Days = endOfDay(addDays(today, 30));

      const signedContractIds = await Document.distinct('contract', {
        contract: { $ne: null },
        status: 'Signed',
      });

      const [
        active, draft, expired, expiringSoon,
        pendingSignature, missingSignedCopy, renewalCandidates, valueRows,
      ] = await Promise.all([
        Contract.countDocuments(mergeFilters(scope, { status: 'Active' })),
        Contract.countDocuments(mergeFilters(scope, { status: 'Draft' })),
        Contract.countDocuments(mergeFilters(scope, expiredFilter())),
        Contract.countDocuments(mergeFilters(scope, {
          status: { $nin: NON_ACTIVE_EXPIRY_STATUSES },
          $or: [
            { expiryDate: { $gte: today, $lte: in30Days } },
            { endDate:    { $gte: today, $lte: in30Days } },
          ],
        })),
        Contract.countDocuments(mergeFilters(scope, { status: 'Pending Signature' })),
        Contract.countDocuments(mergeFilters(scope, {
          status: { $in: ['Active', 'Approved', 'Pending Signature'] },
          _id: { $nin: signedContractIds },
        })),
        Contract.countDocuments(mergeFilters(scope, renewalCandidatesFilter(60))),
        Contract.aggregate([
          { $match: mergeFilters(scope, { status: 'Active' }) },
          { $group: { _id: null, totalValue: { $sum: '$value' }, currency: { $first: '$currency' } } },
        ]),
      ]);

      const totalActiveValue = valueRows[0]?.totalValue || 0;
      const currency = valueRows[0]?.currency || 'ZAR';

      const concerns = [];
      if (expired > 0)          concerns.push(`${expired} expired`);
      if (expiringSoon > 0)     concerns.push(`${expiringSoon} expiring within 30 days`);
      if (pendingSignature > 0) concerns.push(`${pendingSignature} awaiting signature`);
      if (missingSignedCopy > 0) concerns.push(`${missingSignedCopy} missing signed copy`);
      if (renewalCandidates > 0) concerns.push(`${renewalCandidates} need renewal`);

      const concernStr = concerns.length
        ? ` Attention needed: ${concerns.join('; ')}.`
        : ' No immediate concerns.';

      return {
        type: 'contract_management_summary',
        category: 'contract_health',
        title: 'Contract Management Summary',
        summary: `${active} active contracts (total value: ${currency} ${totalActiveValue.toLocaleString()}).${concernStr}`,
        metrics: {
          active, draft, expired, expiringSoon, pendingSignature,
          missingSignedCopy, renewalCandidates, totalActiveValue, currency,
        },
        items: [],
      };
    },
  },

  {
    name: 'query_contracts',
    description: 'Query visible contracts with structured filters for status, type, department, counterparty, expiry, signature state, and counts.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['Draft', 'Under Review', 'Pending Approval', 'Approved', 'Pending Signature', 'Active', 'Expired', 'Terminated', 'Cancelled'],
            },
            contractType: { type: 'string', maxLength: 80 },
            department: { type: 'string', maxLength: 100 },
            counterparty: { type: 'string', maxLength: 200 },
            activeOnly: { type: 'boolean' },
            expiredOnly: { type: 'boolean' },
            expiringWithinDays: { type: 'number', minimum: 1, maximum: 365 },
            signedOnly: { type: 'boolean' },
            awaitingSignatureOnly: { type: 'boolean' },
            missingSignedCopyOnly: { type: 'boolean' },
          },
        },
        requestedFields: { type: 'array' },
        countOnly: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
        sortBy: { type: 'string', enum: ['updatedAt', 'expiryDate', 'value', 'status'] },
      },
    },
    async execute(args, context) {
      const { filters = {}, countOnly = false, limit = 20, sortBy = 'updatedAt' } = args;
      const scope = contractVisibilityFilter(context.user);
      let extra = {};

      if (filters.expiredOnly || filters.status === 'Expired') {
        extra = mergeFilters(extra, expiredFilter());
      } else if (filters.expiringWithinDays) {
        extra = mergeFilters(extra, futureExpiryFilter(filters.expiringWithinDays));
      } else if (filters.status) {
        extra.status = filters.status;
      }
      if (filters.activeOnly) extra.status = 'Active';
      if (filters.awaitingSignatureOnly) extra.status = 'Pending Signature';
      if (filters.contractType) extra.type = filters.contractType;
      if (filters.department) extra.department = safeRegExp(filters.department);
      if (filters.counterparty) extra['parties.name'] = safeRegExp(filters.counterparty);

      const filter = mergeFilters(scope, extra);
      const count = await Contract.countDocuments(filter);
      const statusLabel = filters.status || (filters.activeOnly ? 'Active' : filters.expiredOnly ? 'Expired' : null);
      const category = statusLabel ? `${statusLabel.toLowerCase().replace(/\s+/g, '_')}_contracts` : 'contracts';
      const title = statusLabel ? `${statusLabel} Contracts` : 'Contracts';
      const summary = statusLabel
        ? count === 1
          ? `1 contract is ${statusLabel.toLowerCase()}.`
          : `${count} contracts are ${statusLabel.toLowerCase()}.`
        : count === 1
          ? '1 visible contract found.'
          : `${count} visible contracts found.`;

      if (countOnly) {
        return {
          type: 'count_summary',
          category,
          title,
          summary,
          metrics: { count, filters },
          items: [],
        };
      }

      const sort = sortBy === 'expiryDate'
        ? { expiryDate: 1, endDate: 1 }
        : sortBy === 'value'
          ? { value: -1 }
          : sortBy === 'status'
            ? { status: 1, updatedAt: -1 }
            : { updatedAt: -1 };

      const contracts = await Contract.find(filter)
        .populate('createdBy assignedTo', 'name')
        .sort(sort)
        .limit(limit)
        .lean();

      return {
        type: 'contract_summary',
        category,
        title,
        summary,
        metrics: { count, returned: contracts.length, filters },
        items: contracts.map((contract) => {
          const safe = safeContractFields(contract, context.user);
          return {
            id: safe.contractId,
            _id: safe._id,
            title: safe.title,
            type: safe.type,
            status: safe.status,
            value: safe.value,
            currency: safe.currency,
            department: safe.department,
            counterparty: safe.counterparty,
            expiryDate: safe.expiryDate,
            endDate: safe.endDate,
            assignedTo: safe.assignedTo?.map((u) => u.name).filter(Boolean).join(', ') || null,
          };
        }),
      };
    },
  },

  {
    name: 'query_contract_value',
    description: 'Calculate visible contract value totals, optionally grouped by department, type, or status.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['Draft', 'Under Review', 'Pending Approval', 'Approved', 'Pending Signature', 'Active', 'Expired', 'Terminated', 'Cancelled'],
            },
            contractType: { type: 'string', maxLength: 80 },
            department: { type: 'string', maxLength: 100 },
            expiredOnly: { type: 'boolean' },
          },
        },
        groupBy: { type: 'string', enum: ['department', 'type', 'status', null] },
      },
    },
    async execute(args, context) {
      const { filters = {}, groupBy = null } = args;
      const scope = contractVisibilityFilter(context.user);
      let extra = {};
      if (filters.expiredOnly || filters.status === 'Expired') extra = mergeFilters(extra, expiredFilter());
      else if (filters.status) extra.status = filters.status;
      if (filters.contractType) extra.type = filters.contractType;
      if (filters.department) extra.department = safeRegExp(filters.department);

      const filter = mergeFilters(scope, extra);
      const groupField = groupBy === 'department' ? '$department'
        : groupBy === 'type' ? '$type'
          : groupBy === 'status' ? '$status'
            : null;

      const rows = await Contract.aggregate([
        { $match: filter },
        {
          $group: {
            _id: groupField,
            totalValue: { $sum: '$value' },
            count: { $sum: 1 },
            currency: { $first: '$currency' },
          },
        },
        { $sort: { totalValue: -1 } },
      ]);

      const totalValue = rows.reduce((sum, row) => sum + (row.totalValue || 0), 0);
      const count = rows.reduce((sum, row) => sum + (row.count || 0), 0);
      const currency = rows[0]?.currency || 'ZAR';
      const label = filters.status ? `${filters.status.toLowerCase()} contracts` : 'all permitted contracts';
      const summary = count
        ? `The total value of ${label} is ${currency} ${totalValue.toLocaleString()} across ${count} contract${count !== 1 ? 's' : ''}.`
        : `No ${label} found.`;

      return {
        type: 'contract_value_summary',
        category: groupBy ? `contract_value_by_${groupBy}` : 'total_contract_value',
        title: groupBy ? `Contract Value by ${groupBy}` : 'Total Contract Value',
        summary,
        metrics: { totalValue, count, currency, filters, groupBy },
        items: [],
        sections: groupBy
          ? rows.map((row) => ({
            key: String(row._id || 'unspecified'),
            label: String(row._id || 'Unspecified'),
            metrics: { totalValue: row.totalValue || 0, count: row.count || 0, currency: row.currency || currency },
            items: [],
          }))
          : [],
      };
    },
  },
];
