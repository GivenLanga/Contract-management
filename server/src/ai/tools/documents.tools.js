const Document = require('../../models/Document');
const { documentVisibilityFilter, mergeFilters, safeRegExp } = require('../security/DataScope');
const { safeDocumentFields } = require('../security/FieldFilter');

module.exports = [
  {
    name: 'get_document_status_summary',
    description: 'Summarise documents by status, signed state, pending signature state, or recent uploads.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['Draft', 'Under Review', 'Approved', 'Rejected', 'Pending Signature', 'Signed', 'Archived', 'Declined'],
        },
        recent: { type: 'boolean' },
        limit:  { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { status, recent = false, limit = 10 } = args;
      const scope = documentVisibilityFilter(context.user);

      if (recent) {
        const docs = await Document.find(scope)
          .populate('uploadedBy', 'name')
          .populate('contract', 'title contractId status')
          .sort({ createdAt: -1, updatedAt: -1 })
          .limit(limit)
          .lean();

        return {
          type: 'document_summary',
          category: 'recent_uploads',
          title: 'Recent Uploaded Documents',
          summary: docs.length
            ? `Showing ${docs.length} recently uploaded document${docs.length !== 1 ? 's' : ''}.`
            : 'No recent uploaded documents found.',
          metrics: { count: docs.length },
          items: docs.map((doc) => {
            const safe = safeDocumentFields(doc, context.user);
            return {
              id: safe._id,
              title: safe.name,
              status: safe.status,
              type: safe.type,
              documentStage: safe.documentStage,
              uploadedBy: safe.uploadedBy?.name,
              contract: safe.contract?.title,
              updatedAt: safe.updatedAt,
            };
          }),
        };
      }

      if (status) {
        const filter = mergeFilters(scope, { status });
        const count = await Document.countDocuments(filter);
        const docs = await Document.find(filter)
          .populate('uploadedBy', 'name')
          .populate('contract', 'title contractId status')
          .sort({ updatedAt: -1 })
          .limit(limit)
          .lean();

        return {
          type: 'document_summary',
          category: `${status.toLowerCase().replace(/\s+/g, '_')}_documents`,
          title: `${status} Documents`,
          summary: count === 1
            ? `1 document is ${status.toLowerCase()}.`
            : `${count} documents are ${status.toLowerCase()}.`,
          metrics: { count, status },
          items: docs.map((doc) => {
            const safe = safeDocumentFields(doc, context.user);
            return {
              id: safe._id,
              title: safe.name,
              status: safe.status,
              type: safe.type,
              documentStage: safe.documentStage,
              uploadedBy: safe.uploadedBy?.name,
              contract: safe.contract?.title,
              updatedAt: safe.updatedAt,
            };
          }),
        };
      }

      const rows = await Document.aggregate([
        { $match: scope },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);
      const byStatus = {};
      let total = 0;
      for (const row of rows) {
        if (row._id) {
          byStatus[row._id] = row.count;
          total += row.count;
        }
      }

      return {
        type: 'document_summary',
        category: 'document_status_summary',
        title: 'Document Status Summary',
        summary: total ? `${total} documents total.` : 'No documents found.',
        metrics: { total, byStatus },
        items: [],
      };
    },
  },

  {
    name: 'get_expired_documents',
    description: 'Return expired document metadata if document expiry dates are configured; otherwise explain that document expiry is unsupported.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, _context) {
      const hasExpiryMetadata = Boolean(
        Document.schema.path('expiryDate') ||
        Document.schema.path('expiresAt') ||
        Document.schema.path('endDate')
      );

      if (!hasExpiryMetadata) {
        return {
          type: 'unsupported_metadata',
          category: 'document_expiry',
          title: 'Document Expiry Not Available',
          summary: 'Documents do not have expiry dates in this system. I can check expired contracts instead.',
          metrics: {},
          items: [],
          actions: [{ toolName: 'get_expired_contracts', label: 'Check expired contracts' }],
        };
      }

      return {
        type: 'unsupported_metadata',
        category: 'document_expiry',
        title: 'Document Expiry Not Available',
        summary: 'Document expiry metadata exists but is not mapped for AI queries yet. Use the Documents screen filters for now.',
        metrics: {},
        items: [],
      };
    },
  },

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
          documents: docs.map((d) => {
            const safe = safeDocumentFields(d, context.user);
            return {
              _id: safe._id,
              name: safe.name,
              status: safe.status,
              type: safe.type,
              size: safe.size,
              contract: safe.contract?.title,
              uploadedBy: safe.uploadedBy?.name,
              updatedAt: safe.updatedAt,
            };
          }),
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

      const safe = safeDocumentFields(doc, context.user);
      return {
        type: 'success',
        data: {
          name: safe.name,
          status: safe.status,
          type: safe.type,
          version: safe.version,
          size: safe.size,
          contract: safe.contract,
          uploadedBy: safe.uploadedBy?.name,
          isLocked: safe.isLocked,
          signers: safe.signersCount || 0,
          updatedAt: safe.updatedAt,
        },
      };
    },
  },

  {
    name: 'query_documents',
    description: 'Query visible document metadata with structured filters for status, signed state, awaiting-signature state, recent uploads, and expiry metadata support.',
    riskLevel: 'low',
    requiredPermissions: ['document:read'],
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
              enum: ['Draft', 'Under Review', 'Approved', 'Rejected', 'Pending Signature', 'Signed', 'Archived', 'Declined'],
            },
            signedOnly: { type: 'boolean' },
            awaitingSignatureOnly: { type: 'boolean' },
            recentOnly: { type: 'boolean' },
            expiredOnly: { type: 'boolean' },
          },
        },
        countOnly: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { filters = {}, countOnly = false, limit = 20 } = args;

      if (filters.expiredOnly) {
        const hasExpiryMetadata = Boolean(
          Document.schema.path('expiryDate') ||
          Document.schema.path('expiresAt') ||
          Document.schema.path('endDate')
        );
        if (!hasExpiryMetadata) {
          return {
            type: 'unsupported_metadata',
            category: 'document_expiry',
            title: 'Document Expiry Not Available',
            summary: 'Documents do not have expiry dates in this system. I can check expired contracts instead.',
            metrics: {},
            items: [],
            actions: [{ toolName: 'get_expired_contracts', label: 'Check expired contracts' }],
          };
        }
      }

      const extra = {};
      if (filters.status) extra.status = filters.status;
      if (filters.signedOnly) extra.status = 'Signed';
      if (filters.awaitingSignatureOnly) extra.status = 'Pending Signature';
      const filter = mergeFilters(documentVisibilityFilter(context.user), extra);
      const count = await Document.countDocuments(filter);

      if (countOnly) {
        return {
          type: 'count_summary',
          category: 'document_count',
          title: 'Document Count',
          summary: count === 1 ? '1 visible document found.' : `${count} visible documents found.`,
          metrics: { count, filters },
          items: [],
        };
      }

      const docs = await Document.find(filter)
        .populate('uploadedBy', 'name')
        .populate('contract', 'title contractId status')
        .sort(filters.recentOnly ? { createdAt: -1, updatedAt: -1 } : { updatedAt: -1 })
        .limit(limit)
        .lean();

      return {
        type: 'document_summary',
        category: filters.recentOnly ? 'recent_documents' : 'documents',
        title: filters.recentOnly ? 'Recent Uploaded Documents' : 'Documents',
        summary: docs.length
          ? `${docs.length} visible document${docs.length !== 1 ? 's' : ''} found.`
          : 'No visible documents were found.',
        metrics: { count, returned: docs.length, filters },
        items: docs.map((doc) => {
          const safe = safeDocumentFields(doc, context.user);
          return {
            id: safe._id,
            title: safe.name,
            name: safe.name,
            status: safe.status,
            type: safe.type,
            documentStage: safe.documentStage,
            uploadedBy: safe.uploadedBy?.name,
            contract: safe.contract?.title,
            updatedAt: safe.updatedAt,
          };
        }),
      };
    },
  },
];
