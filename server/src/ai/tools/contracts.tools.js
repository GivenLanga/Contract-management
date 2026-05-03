const Contract = require('../../models/Contract');
const {
  contractVisibilityFilter,
  mergeFilters,
  safeRegExp,
  safeWordsRegExp,
} = require('../security/DataScope');

const publicParties = (parties = []) => parties.map((party) => ({
  name: party.name,
  role: party.role,
  type: party.type,
  signingOrder: party.signingOrder,
}));

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
          contracts: contracts.map(c => ({
            _id: c._id, contractId: c.contractId, title: c.title,
            type: c.type, status: c.status,
            expiryDate: c.expiryDate,
            counterparty: c.parties?.find(p => p.type === 'external')?.name,
            createdBy: c.createdBy?.name,
          })),
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
      const from = new Date();
      const to   = new Date(Date.now() + days * 86400000);
      const count = await Contract.countDocuments(mergeFilters({
        expiryDate: { $gte: from, $lte: to },
        status: { $nin: ['Terminated', 'Cancelled'] },
      }, contractVisibilityFilter(context.user)));
      return { type: 'success', data: { count, days } };
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
      const from = new Date();
      const to   = new Date(Date.now() + days * 86400000);
      const contracts = await Contract.find(mergeFilters({
        expiryDate: { $gte: from, $lte: to },
        status: { $nin: ['Terminated', 'Cancelled'] },
      }, contractVisibilityFilter(context.user)))
        .populate('createdBy', 'name')
        .sort({ expiryDate: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'success',
        data: {
          contracts: contracts.map(c => ({
            _id: c._id, contractId: c.contractId, title: c.title,
            status: c.status, expiryDate: c.expiryDate,
            parties: c.parties?.map(p => p.name),
          })),
          count: contracts.length,
          days,
        },
      };
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
      return {
        type: 'success',
        data: {
          contractId: c.contractId, title: c.title, status: c.status,
          type: c.type, parties: publicParties(c.parties),
          expiryDate: c.expiryDate, startDate: c.startDate,
          value: c.value, currency: c.currency,
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
      return { type: 'success', data: { title: c.title, parties: publicParties(c.parties) } };
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
      return {
        type: 'success',
        data: {
          summary: {
            id: c.contractId, title: c.title, type: c.type, status: c.status,
            value: `${c.currency || 'USD'} ${(c.value || 0).toLocaleString()}`,
            startDate: c.startDate, expiryDate: c.expiryDate,
            parties: publicParties(c.parties), priority: c.priority, department: c.department,
          },
        },
      };
    },
  },
];
