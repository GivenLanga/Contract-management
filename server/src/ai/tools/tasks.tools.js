const Task     = require('../../models/Task');
const Contract = require('../../models/Contract');
const LegalRequest = require('../../models/LegalRequest');
const {
  contractVisibilityFilter,
  isObjectIdLike,
  legalRequestVisibilityFilter,
  mergeFilters,
  taskVisibilityFilter,
} = require('../security/DataScope');
const { safeTaskFields } = require('../security/FieldFilter');

const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const periodStart = (period) => {
  const now = new Date();
  if (period === 'today') return startOfDay(now);
  if (period === 'this_week') return new Date(now.getTime() - 7 * 86400000);
  if (period === 'this_month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
};

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
        due:      { type: 'string', enum: ['today', 'this_week'] },
        limit:    { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const { status, priority, due, limit = 10 } = args;
      const filter = {
        assignedTo: context.userId,
        status: { $nin: ['Completed', 'Cancelled'] },
      };
      if (status)   filter.status   = status;
      if (priority) filter.priority = priority;
      if (due === 'today') {
        filter.deadline = { $gte: startOfDay(), $lte: endOfDay() };
      } else if (due === 'this_week') {
        filter.deadline = { $gte: startOfDay(), $lte: endOfDay(new Date(Date.now() + 7 * 86400000)) };
      }

      const tasks = await Task.find(filter)
        .populate('contract', 'title contractId')
        .sort({ deadline: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'success',
        data: {
          tasks: tasks.map((t) => {
            const safe = safeTaskFields(t, context.user);
            return {
              _id: safe._id,
              title: safe.title,
              status: safe.status,
              priority: safe.priority,
              deadline: safe.deadline,
              type: safe.type,
              contract: safe.contract?.title,
              contractId: safe.contract?.contractId,
            };
          }),
          count: tasks.length,
          message: tasks.length
            ? `Found ${tasks.length} task${tasks.length !== 1 ? 's' : ''}${due ? ` due ${due === 'today' ? 'today' : 'this week'}` : ''}.`
            : due
              ? `No tasks are due ${due === 'today' ? 'today' : 'this week'}.`
              : 'No open tasks found.',
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

      const tasks = await Task.find(filter)
        .populate('assignedTo', 'name')
        .populate('contract', 'title contractId')
        .sort({ deadline: 1 })
        .limit(limit)
        .lean();

      const mappedTasks = tasks.map((t) => {
        const safe = safeTaskFields(t, context.user);
        return {
          _id: safe._id,
          title: safe.title,
          priority: safe.priority,
          deadline: safe.deadline,
          assignedTo: safe.assignedTo?.name,
          contract: safe.contract?.title,
        };
      });

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
        period:    { type: 'string', enum: ['all', 'today', 'this_week', 'this_month'] },
      },
    },
    async execute(args, context) {
      const { mine_only = true, period = 'all' } = args;
      const base = mine_only
        ? { assignedTo: context.userId }
        : taskVisibilityFilter(context.user);

      const completedFilter = { status: 'Completed' };
      const start = periodStart(period);
      if (start) completedFilter.completedAt = { $gte: start };

      const [pending, inProgress, overdue, completed] = await Promise.all([
        Task.countDocuments(mergeFilters(base, { status: 'Pending' })),
        Task.countDocuments(mergeFilters(base, { status: 'In Progress' })),
        Task.countDocuments(mergeFilters(base, { deadline: { $lt: new Date() }, status: { $nin: ['Completed', 'Cancelled'] } })),
        Task.countDocuments(mergeFilters(base, completedFilter)),
      ]);

      return {
        type: 'task_summary',
        category: mine_only ? 'my_tasks' : 'team_tasks',
        title: mine_only ? 'My Task Summary' : 'Team Task Summary',
        summary: `Tasks: ${pending} pending, ${inProgress} in progress, ${overdue} overdue, ${completed} completed${period !== 'all' ? ` ${period.replace('_', ' ')}` : ''}.`,
        metrics: { pending, inProgress, overdue, completed, scope: mine_only ? 'mine' : 'team', period },
        items: [],
      };
    },
  },

  {
    name: 'get_legal_request_tasks',
    description: 'List tasks linked to legal requests, using the current user’s task and legal-request visibility.',
    riskLevel: 'low',
    requiredPermissions: ['task:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['Pending', 'In Progress', 'Blocked', 'Completed', 'Overdue', 'Cancelled'] },
        limit:  { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { status, limit = 20 } = args;
      const taskFilter = mergeFilters(
        taskVisibilityFilter(context.user),
        { legalRequest: { $ne: null } },
        status ? { status } : {},
      );

      const tasks = await Task.find(taskFilter)
        .populate('assignedTo', 'name')
        .populate('legalRequest', 'requestId title status dueDate targetDate department currentHolder')
        .sort({ deadline: 1, updatedAt: -1 })
        .limit(limit)
        .lean();

      const legalScope = legalRequestVisibilityFilter(context.user);
      const visibleRequestIds = await LegalRequest.find(legalScope).select('_id').lean();
      const visibleSet = new Set(visibleRequestIds.map((lr) => String(lr._id)));
      const visibleTasks = tasks.filter((task) => visibleSet.has(String(task.legalRequest?._id || task.legalRequest)));

      return {
        type: 'task_summary',
        category: 'legal_request_tasks',
        title: 'Legal Request Tasks',
        summary: visibleTasks.length
          ? `${visibleTasks.length} task${visibleTasks.length !== 1 ? 's are' : ' is'} linked to legal requests.`
          : 'No accessible tasks linked to legal requests were found.',
        metrics: { count: visibleTasks.length, status: status || 'ALL' },
        items: visibleTasks.map((task) => {
          const safe = safeTaskFields(task, context.user);
          return {
            id: safe._id,
            title: safe.title,
            status: safe.status,
            priority: safe.priority,
            dueDate: safe.deadline,
            type: safe.type,
            assignedTo: safe.assignedTo?.name || null,
            legalRequestId: task.legalRequest?.requestId || null,
            legalRequestTitle: task.legalRequest?.title || null,
            currentHolder: task.legalRequest?.currentHolder || null,
          };
        }),
      };
    },
  },

  {
    name: 'query_tasks',
    description: 'Query visible tasks with structured filters for assignee, legal-request linkage, due dates, overdue state, completion period, and counts.',
    riskLevel: 'low',
    requiredPermissions: ['task:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['Pending', 'In Progress', 'Blocked', 'Completed', 'Overdue', 'Cancelled'] },
            assignedTo: { type: 'string', maxLength: 80 },
            linkedLegalRequest: { type: 'boolean' },
            dueRange: { type: 'string', enum: ['today', 'this_week'] },
            overdueOnly: { type: 'boolean' },
            completedThisMonth: { type: 'boolean' },
          },
        },
        countOnly: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { filters = {}, countOnly = false, limit = 20 } = args;
      const extra = {};
      if (filters.status) extra.status = filters.status;
      if (filters.assignedTo === 'me') extra.assignedTo = context.userId;
      if (filters.linkedLegalRequest) extra.legalRequest = { $ne: null };
      if (filters.overdueOnly) {
        extra.deadline = { $lt: new Date() };
        extra.status = { $nin: ['Completed', 'Cancelled'] };
      }
      if (filters.dueRange === 'today') {
        extra.deadline = { $gte: startOfDay(), $lte: endOfDay() };
      } else if (filters.dueRange === 'this_week') {
        extra.deadline = { $gte: startOfDay(), $lte: endOfDay(new Date(Date.now() + 7 * 86400000)) };
      }
      if (filters.completedThisMonth) {
        extra.status = 'Completed';
        extra.completedAt = { $gte: periodStart('this_month') };
      }

      const filter = mergeFilters(taskVisibilityFilter(context.user), extra);
      const count = await Task.countDocuments(filter);

      if (countOnly) {
        return {
          type: 'count_summary',
          category: 'task_count',
          title: 'Task Count',
          summary: count === 1 ? '1 visible task found.' : `${count} visible tasks found.`,
          metrics: { count, filters },
          items: [],
        };
      }

      const tasks = await Task.find(filter)
        .populate('assignedTo', 'name')
        .populate('legalRequest', 'requestId title status dueDate targetDate department currentHolder')
        .populate('contract', 'title contractId')
        .sort({ deadline: 1, updatedAt: -1 })
        .limit(limit)
        .lean();

      const visibleRequestIds = filters.linkedLegalRequest
        ? await LegalRequest.find(legalRequestVisibilityFilter(context.user)).select('_id').lean()
        : null;
      const visibleSet = visibleRequestIds
        ? new Set(visibleRequestIds.map((lr) => String(lr._id)))
        : null;
      const visibleTasks = visibleSet
        ? tasks.filter((task) => visibleSet.has(String(task.legalRequest?._id || task.legalRequest)))
        : tasks;

      return {
        type: 'task_summary',
        category: filters.linkedLegalRequest ? 'legal_request_tasks' : 'tasks',
        title: filters.linkedLegalRequest ? 'Legal Request Tasks' : 'Tasks',
        summary: visibleTasks.length
          ? `${visibleTasks.length} visible task${visibleTasks.length !== 1 ? 's' : ''} found.`
          : 'No visible tasks were found.',
        metrics: { count, returned: visibleTasks.length, filters },
        items: visibleTasks.map((task) => {
          const safe = safeTaskFields(task, context.user);
          return {
            id: safe._id,
            title: safe.title,
            status: safe.status,
            priority: safe.priority,
            dueDate: safe.deadline,
            deadline: safe.deadline,
            type: safe.type,
            assignedTo: safe.assignedTo?.name || null,
            contract: safe.contract?.title || null,
            legalRequestId: task.legalRequest?.requestId || null,
            legalRequestTitle: task.legalRequest?.title || null,
            currentHolder: task.legalRequest?.currentHolder || null,
          };
        }),
      };
    },
  },
];
