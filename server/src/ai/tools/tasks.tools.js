const Task     = require('../../models/Task');
const Contract = require('../../models/Contract');
const {
  contractVisibilityFilter,
  isObjectIdLike,
  mergeFilters,
  taskVisibilityFilter,
} = require('../security/DataScope');

module.exports = [
  {
    name: 'list_my_tasks',
    description: 'List the current user\'s open tasks, optionally filtered by status or priority.',
    riskLevel: 'low',
    requiredPermissions: ['task:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status:   { type: 'string', enum: ['Pending', 'In Progress', 'Overdue'] },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Urgent'] },
        limit:    { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { status, priority, limit = 10 } = args;
      const filter = mergeFilters({
        assignedTo: context.userId,
        status: { $nin: ['Completed', 'Cancelled'] },
      }, taskVisibilityFilter(context.user));
      if (status)   filter.status   = status;
      if (priority) filter.priority = priority;

      const tasks = await Task.find(filter)
        .populate('contract', 'title contractId')
        .sort({ deadline: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'success',
        data: {
          tasks: tasks.map(t => ({
            _id: t._id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            deadline: t.deadline,
            type: t.type,
            contract: t.contract?.title,
            contractId: t.contract?.contractId,
          })),
          count: tasks.length,
        },
      };
    },
  },

  {
    name: 'list_overdue_tasks',
    description: 'List tasks whose deadline has passed and are not yet completed or cancelled.',
    riskLevel: 'low',
    requiredPermissions: ['task:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mine_only: { type: 'boolean' },
        limit:     { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { mine_only = false, limit = 10 } = args;
      const filter = mergeFilters({
        deadline: { $lt: new Date() },
        status: { $nin: ['Completed', 'Cancelled'] },
      }, mine_only ? { assignedTo: context.userId } : taskVisibilityFilter(context.user));
      if (mine_only) filter.assignedTo = context.userId;

      const tasks = await Task.find(filter)
        .populate('assignedTo', 'name')
        .populate('contract', 'title contractId')
        .sort({ deadline: 1 })
        .limit(limit)
        .lean();

      const mappedTasks = tasks.map(t => ({
        _id: t._id,
        title: t.title,
        priority: t.priority,
        deadline: t.deadline,
        assignedTo: t.assignedTo?.name,
        contract: t.contract?.title,
      }));

      return {
        type: 'success',
        data: {
          tasks: mappedTasks,
          count: tasks.length,
          message: tasks.length
            ? `Found ${tasks.length} overdue task${tasks.length !== 1 ? 's' : ''}.`
            : mine_only
              ? 'You have no overdue tasks.'
              : 'There are no overdue tasks.',
        },
      };
    },
  },

  {
    name: 'create_task',
    description: 'Create a new task and assign it to a user, optionally linked to a contract.',
    riskLevel: 'medium',
    requiredPermissions: ['task:write', 'task:assign'],
    schema: {
      type: 'object',
      required: ['title', 'assignedTo', 'deadline'],
      additionalProperties: false,
      properties: {
        title:       { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 1000 },
        assignedTo:  { type: 'string', pattern: '^[a-fA-F0-9]{24}$', description: 'User ID to assign the task to' },
        deadline:    { type: 'string', description: 'ISO 8601 date string' },
        priority:    { type: 'string', enum: ['Low', 'Medium', 'High', 'Urgent'] },
        type:        { type: 'string', enum: ['Drafting', 'Review', 'Approval', 'Signing', 'Negotiation', 'Other'] },
        contractId:  { type: 'string', description: 'Contract ID to link to' },
      },
    },
    async execute(args, context) {
      const { title, description, assignedTo, deadline, priority = 'Medium', type = 'Other', contractId } = args;
      const parsedDeadline = new Date(deadline);
      if (Number.isNaN(parsedDeadline.getTime())) {
        return { type: 'error', message: 'Invalid task deadline.' };
      }

      let contractRef;
      if (contractId) {
        const contractLookup = isObjectIdLike(contractId)
          ? { $or: [{ contractId }, { _id: contractId }] }
          : { contractId };
        const c = await Contract.findOne(mergeFilters(
          contractLookup,
          contractVisibilityFilter(context.user)
        )).select('_id').lean();
        contractRef = c?._id;
        if (!contractRef) {
          return { type: 'not_found', message: `No accessible contract found for "${contractId}".` };
        }
      }

      const task = await Task.create({
        title,
        description,
        assignedTo,
        assignedBy: context.userId,
        deadline: parsedDeadline,
        priority,
        type,
        contract: contractRef,
        status: 'Pending',
      });

      return {
        type: 'success',
        data: {
          _id: task._id,
          title: task.title,
          status: task.status,
          deadline: task.deadline,
          message: `Task "${title}" created and assigned.`,
        },
      };
    },
  },

  {
    name: 'get_task_summary',
    description: 'Get a count breakdown of tasks by status for the current user or the whole team.',
    riskLevel: 'low',
    requiredPermissions: ['task:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mine_only: { type: 'boolean' },
      },
    },
    async execute(args, context) {
      const { mine_only = true } = args;
      const base = mine_only
        ? mergeFilters({ assignedTo: context.userId }, taskVisibilityFilter(context.user))
        : taskVisibilityFilter(context.user);

      const [pending, inProgress, overdue, completed] = await Promise.all([
        Task.countDocuments(mergeFilters(base, { status: 'Pending' })),
        Task.countDocuments(mergeFilters(base, { status: 'In Progress' })),
        Task.countDocuments(mergeFilters(base, { deadline: { $lt: new Date() }, status: { $nin: ['Completed', 'Cancelled'] } })),
        Task.countDocuments(mergeFilters(base, { status: 'Completed' })),
      ]);

      return {
        type: 'success',
        data: { pending, inProgress, overdue, completed, scope: mine_only ? 'mine' : 'team' },
      };
    },
  },
];
