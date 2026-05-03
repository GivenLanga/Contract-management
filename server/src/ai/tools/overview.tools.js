const Contract = require('../../models/Contract');
const Document  = require('../../models/Document');
const Task      = require('../../models/Task');
const {
  contractVisibilityFilter,
  documentVisibilityFilter,
  mergeFilters,
  taskVisibilityFilter,
} = require('../security/DataScope');

module.exports = [
  {
    name: 'get_app_overview',
    description: 'Get a live summary of the entire system: contract counts by status, document counts by status, task breakdown, and signing pipeline.',
    riskLevel: 'low',
    requiredPermissions: ['contract:read', 'document:read', 'task:read'],
    schema: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const userId = context?.userId;
      const contractScope = contractVisibilityFilter(context.user);
      const documentScope = documentVisibilityFilter(context.user);
      const taskScope = taskVisibilityFilter(context.user);

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
        userId
          ? Task.countDocuments(mergeFilters(taskScope, { assignedTo: userId, status: { $nin: ['Completed', 'Cancelled'] } }))
          : Promise.resolve(null),
        Task.countDocuments(mergeFilters(taskScope, { deadline: { $lt: new Date() }, status: { $nin: ['Completed', 'Cancelled'] } })),
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
          message: `System overview: ${totalContracts} contracts (${activeContracts} active), ${totalDocuments} documents (${pendingSignatureDocs} pending signature, ${signedDocs} signed), ${overdueTasks} overdue task${overdueTasks !== 1 ? 's' : ''}.`,
        },
      };
    },
  },
];
