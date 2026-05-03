const Document = require('../../models/Document');
const { documentVisibilityFilter, mergeFilters, safeRegExp } = require('../security/DataScope');

module.exports = [
  {
    name: 'search_documents',
    description: 'Search documents by name, contract, or status.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query:  { type: 'string', minLength: 1, maxLength: 200 },
        status: {
          type: 'string',
          enum: ['Draft', 'Under Review', 'Approved', 'Rejected', 'Pending Signature', 'Signed', 'Archived'],
        },
        limit:  { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { query, status, limit = 8 } = args;
      const regex  = safeRegExp(query);
      const filter = mergeFilters(
        { $or: [{ name: regex }, { originalName: regex }] },
        documentVisibilityFilter(context.user)
      );
      if (status) filter.status = status;

      const docs = await Document.find(filter)
        .populate('uploadedBy', 'name')
        .populate('contract', 'title contractId')
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      return {
        type: 'success',
        data: {
          documents: docs.map(d => ({
            _id: d._id,
            name: d.name,
            status: d.status,
            type: d.type,
            size: d.size,
            contract: d.contract?.title,
            uploadedBy: d.uploadedBy?.name,
            updatedAt: d.updatedAt,
          })),
          count: docs.length,
        },
      };
    },
  },

  {
    name: 'get_document_status',
    description: 'Get the full status and metadata for a specific document by name.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    async execute(args, context) {
      const doc = await Document.findOne(mergeFilters(
        { name: safeRegExp(args.query) },
        documentVisibilityFilter(context.user)
      ))
        .populate('uploadedBy', 'name email')
        .populate('contract', 'title contractId status')
        .lean();

      if (!doc) return { type: 'not_found', message: `No document found for "${args.query}".` };

      return {
        type: 'success',
        data: {
          name: doc.name,
          status: doc.status,
          type: doc.type,
          version: doc.version,
          size: doc.size,
          contract: doc.contract ? { title: doc.contract.title, contractId: doc.contract.contractId, status: doc.contract.status } : null,
          uploadedBy: doc.uploadedBy?.name,
          isLocked: doc.isLocked,
          signers: doc.signers?.length || 0,
          updatedAt: doc.updatedAt,
        },
      };
    },
  },
];
