const Contract      = require('../../models/Contract');
const Document      = require('../../models/Document');
const Task          = require('../../models/Task');
const LegalRequest  = require('../../models/LegalRequest');
const {
  contractVisibilityFilter,
  documentVisibilityFilter,
  isPrivilegedUser,
  mergeFilters,
  taskVisibilityFilter,
  userId,
} = require('../security/DataScope');

module.exports = [
  {
    name: 'get_app_overview',
    description: 'Get a live summary of the entire system: contract counts by status, document counts by status, task breakdown, and signing pipeline.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read', 'document:read', 'task:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const uid = context?.userId;
      const contractScope = contractVisibilityFilter(context.user);
      const documentScope = documentVisibilityFilter(context.user);
      const taskScope = taskVisibilityFilter(context.user);

      const legalReqId = userId(context.user);
      const legalRequestScope = isPrivilegedUser(context.user)
        ? {}
        : legalReqId
          ? { $or: [{ assignedTo: legalReqId }, { submittedBy: legalReqId }] }
          : { _id: null };
      const legalActiveScope = mergeFilters(legalRequestScope, { status: { $nin: ['CLOSED', 'CANCELLED'] } });

      const [
        totalContracts,
        activeContracts,
        contractsByStatus,
        totalDocuments,
        pendingSignatureDocs,
        signedDocs,
        draftDocs,
        totalTasks,
        myOpenTasks,
        overdueTasks,
        openLegalRequests,
        overdueLegalRequests,
      ] = await Promise.all([
        Contract.countDocuments(contractScope),
        Contract.countDocuments(mergeFilters(contractScope, { status: 'Active' })),
        Contract.aggregate([
          { $match: contractScope },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Document.countDocuments(documentScope),
        Document.countDocuments(mergeFilters(documentScope, { status: 'Pending Signature' })),
        Document.countDocuments(mergeFilters(documentScope, { status: 'Signed' })),
        Document.countDocuments(mergeFilters(documentScope, { status: { $in: ['Draft', 'Under Review'] } })),
        Task.countDocuments(taskScope),
        uid
          ? Task.countDocuments(mergeFilters(taskScope, { assignedTo: uid, status: { $nin: ['Completed', 'Cancelled'] } }))
          : Promise.resolve(null),
        Task.countDocuments(mergeFilters(taskScope, { deadline: { $lt: new Date() }, status: { $nin: ['Completed', 'Cancelled'] } })),
        LegalRequest.countDocuments(legalActiveScope),
        LegalRequest.countDocuments(mergeFilters(legalActiveScope, { dueDate: { $lt: new Date() } })),
      ]);

      const statusBreakdown = {};
      for (const row of contractsByStatus) {
        if (row._id) statusBreakdown[row._id] = row.count;
      }

      return {
        type: 'success',
        data: {
          contracts: {
            total: totalContracts,
            active: activeContracts,
            byStatus: statusBreakdown,
          },
          documents: {
            total: totalDocuments,
            pendingSignature: pendingSignatureDocs,
            signed: signedDocs,
            inDraft: draftDocs,
          },
          tasks: {
            total: totalTasks,
            myOpen: myOpenTasks,
            overdue: overdueTasks,
          },
          legalRequests: {
            open: openLegalRequests,
            overdue: overdueLegalRequests,
          },
          message: `System overview: ${totalContracts} contracts (${activeContracts} active), ${totalDocuments} documents (${pendingSignatureDocs} pending signature, ${signedDocs} signed), ${overdueTasks} overdue task${overdueTasks !== 1 ? 's' : ''}, ${openLegalRequests} open legal request${openLegalRequests !== 1 ? 's' : ''}.`,
        },
      };
    },
  },

  {
    name: 'query_reports_summary',
    description: 'Return a deterministic dashboard/report summary for visible app data without using the local model.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read', 'document:read', 'task:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reportType: {
          type: 'string',
          enum: ['legal_progress', 'contract_health', 'sla', 'signing', 'tasks', 'dashboard', 'department'],
        },
        period: { type: 'string', enum: ['today', 'this_week', 'this_month', 'this_quarter', 'this_year', 'all'] },
      },
    },
    async execute(args, context) {
      const reportType = args.reportType || 'dashboard';
      const contractScope = contractVisibilityFilter(context.user);
      const documentScope = documentVisibilityFilter(context.user);
      const taskScope = taskVisibilityFilter(context.user);
      const legalReqId = userId(context.user);
      const legalRequestScope = isPrivilegedUser(context.user)
        ? {}
        : legalReqId
          ? { $or: [{ assignedTo: legalReqId }, { submittedBy: legalReqId }] }
          : { _id: null };

      const [
        activeContracts,
        expiredContracts,
        pendingSignatureDocs,
        signedDocs,
        openTasks,
        overdueTasks,
        openLegalRequests,
        overdueLegalRequests,
      ] = await Promise.all([
        Contract.countDocuments(mergeFilters(contractScope, { status: 'Active' })),
        Contract.countDocuments(mergeFilters(contractScope, { status: 'Expired' })),
        Document.countDocuments(mergeFilters(documentScope, { status: 'Pending Signature' })),
        Document.countDocuments(mergeFilters(documentScope, { status: 'Signed' })),
        Task.countDocuments(mergeFilters(taskScope, { status: { $nin: ['Completed', 'Cancelled'] } })),
        Task.countDocuments(mergeFilters(taskScope, { deadline: { $lt: new Date() }, status: { $nin: ['Completed', 'Cancelled'] } })),
        LegalRequest.countDocuments(mergeFilters(legalRequestScope, { status: { $nin: ['CLOSED', 'CANCELLED'] } })),
        LegalRequest.countDocuments(mergeFilters(legalRequestScope, { dueDate: { $lt: new Date() }, status: { $nin: ['CLOSED', 'CANCELLED'] } })),
      ]);

      const metrics = {
        activeContracts,
        expiredContracts,
        pendingSignatureDocs,
        signedDocs,
        openTasks,
        overdueTasks,
        openLegalRequests,
        overdueLegalRequests,
        reportType,
        period: args.period || 'all',
      };

      return {
        type: reportType === 'dashboard' ? 'dashboard_summary' : 'report_summary',
        category: reportType,
        title: reportType === 'dashboard' ? 'Dashboard Summary' : `${reportType.replace(/_/g, ' ')} Summary`,
        summary: `Summary: ${activeContracts} active contracts, ${openLegalRequests} open legal requests, ${openTasks} open tasks, ${pendingSignatureDocs} documents awaiting signature.`,
        metrics,
        items: [],
      };
    },
  },
];
