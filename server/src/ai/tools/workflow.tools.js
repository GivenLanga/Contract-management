'use strict';
const LegalRequest    = require('../../models/LegalRequest');
const WorkflowHistory = require('../../models/WorkflowHistory');
const Task            = require('../../models/Task');
const SLA             = require('../config/legalWorkflowSla');
const {
  isPrivilegedUser,
  legalRequestVisibilityFilter,
  mergeFilters,
  isObjectIdLike,
  safeRegExp,
  taskVisibilityFilter,
} = require('../security/DataScope');
const { safeLegalRequestFields, safeWorkflowHistoryEvent } = require('../security/FieldFilter');

// Keep these aligned with LegalRequest.status and legalWorkflowService.
const TERMINAL_STATUSES = ['CLOSED', 'CANCELLED', 'FULLY_SIGNED', 'STORED'];

// Statuses that count as "completed" for SLA purposes.
const COMPLETED_STATUSES = ['FULLY_SIGNED', 'STORED', 'FINALIZED', 'CLOSED'];

// Active workflow views should not include completed/cancelled records.
const INACTIVE_STATUSES = [...new Set([...TERMINAL_STATUSES, 'FINALIZED'])];

const msPerDay = 24 * 60 * 60 * 1000;

const daysBetween = (a, b) =>
  Math.round(Math.abs(new Date(b) - new Date(a)) / msPerDay);

const startOfDay = (d = new Date()) => {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
};

const endOfDay = (d = new Date()) => {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
};

const startOfPeriod = (period = 'this_month') => {
  const now = new Date();
  if (period === 'today') return startOfDay(now);
  if (period === 'this_week') return new Date(now.getTime() - 7 * msPerDay);
  if (period === 'this_year') return new Date(now.getFullYear(), 0, 1);
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

const formatItem = (lr, now = new Date()) => {
  const dueDate = lr.dueDate ? new Date(lr.dueDate) : null;
  const daysRemaining = dueDate ? Math.round((dueDate - now) / msPerDay) : null;
  const overdueDays = daysRemaining !== null && daysRemaining < 0 ? Math.abs(daysRemaining) : null;

  let signatureStatus = null;
  if (lr.isFullySigned) signatureStatus = 'fully_signed';
  else if (lr.pendingSignatoriesCount > 0) signatureStatus = 'awaiting_signature';
  else if (lr.signatureEmailSentAt) signatureStatus = 'email_sent';

  return {
    id: lr.requestId,
    _id: String(lr._id),
    title: lr.title,
    status: lr.status,
    requestType: lr.requestType,
    documentCategory: lr.documentCategory || null,
    description: lr.reasonForRequest || null,
    internalOrExternal: lr.internalOrExternal,
    currentHolder: lr.currentHolder,
    assignedTo: lr.assignedTo?.name || null,
    submittedBy: lr.submittedBy?.name || null,
    department: lr.department || null,
    dueDate: lr.dueDate || null,
    targetDate: lr.targetDate || null,
    submittedAt: lr.submittedAt || null,
    priority: lr.priority,
    nextAction: lr.nextAction || null,
    contractValue: lr.contractValue || null,
    currency: lr.currency || 'ZAR',
    counterpartyName: lr.counterpartyName || null,
    daysRemaining,
    overdueDays,
    signatureStatus,
  };
};

// Common query select — avoids fetching large fields.
const LR_SELECT = 'requestId title status requestType internalOrExternal currentHolder '
  + 'documentCategory assignedTo department dueDate targetDate priority nextAction contractValue currency '
  + 'counterpartyName lastStatusChangeAt submittedAt signatureEmailSentAt fullySignedAt '
  + 'isFullySigned pendingSignatoriesCount completedSignatoriesCount legalWorkingDays '
  + 'totalElapsedDays completedAt reasonForRequest';

const LEGAL_REQUEST_STATUSES = [
  'SUBMITTED', 'INTAKE_REVIEW', 'ASSIGNED', 'IN_LEGAL_REVIEW',
  'INTERNAL_LEGAL_REVIEW', 'SENT_TO_EXTERNAL_PARTY', 'WAITING_FOR_EXTERNAL_PARTY',
  'EXTERNAL_FEEDBACK_RECEIVED', 'NEGOTIATION_AMENDMENTS', 'WITH_BUSINESS_DEPARTMENT',
  'WITH_MANAGER', 'REVISIONS_REQUIRED', 'MANAGER_APPROVED', 'APPROVED',
  'READY_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED', 'FULLY_SIGNED',
  'STORED', 'FINALIZED', 'CLOSED', 'ON_HOLD', 'CANCELLED',
];

const humanize = (value) => String(value || '')
  .replace(/_/g, ' ')
  .toLowerCase()
  .replace(/\b\w/g, (c) => c.toUpperCase());

const periodFilter = (period) => {
  const now = new Date();
  if (period === 'today') return { submittedAt: { $gte: startOfDay(now), $lte: endOfDay(now) } };
  if (period === 'this_week') return { submittedAt: { $gte: new Date(now.getTime() - 7 * msPerDay) } };
  if (period === 'this_month') return { submittedAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } };
  return {};
};

const dueRangeFilter = (dueRange) => {
  const now = new Date();
  if (dueRange === 'today') return { dueDate: { $gte: startOfDay(now), $lte: endOfDay(now) } };
  if (dueRange === 'this_week') {
    const weekEnd = new Date(now.getTime() + 7 * msPerDay);
    return { dueDate: { $gte: startOfDay(now), $lte: endOfDay(weekEnd) } };
  }
  if (dueRange === 'overdue') return { dueDate: { $lt: startOfDay(now) } };
  return {};
};

const wantedBy = (item) => item.dueDate || item.targetDate || null;

const rowForLegalRequest = (item) => ({
  request: item.title,
  type: humanize(item.requestType || item.documentCategory || 'Request'),
  department: item.department || 'Unspecified',
  submitted: item.submittedAt || null,
  wantedBy: wantedBy(item),
  status: humanize(item.status),
  nextAction: item.nextAction || '',
});

module.exports = [

  // ── 1. get_due_today ───────────────────────────────────────────────────────
  {
    name: 'get_due_today',
    description: 'Return legal requests whose due date is today.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now  = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          dueDate: { $gte: startOfDay(now), $lte: endOfDay(now) },
          status: { $nin: INACTIVE_STATUSES },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ priority: -1, dueDate: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'workflow_summary',
        title: 'Due Today',
        summary: items.length
          ? `${items.length} legal request${items.length !== 1 ? 's' : ''} due today.`
          : 'No legal requests are due today.',
        items: items.map((lr) => formatItem(lr, now)),
        metrics: { count: items.length },
      };
    },
  },

  // ── 2. get_due_this_week ───────────────────────────────────────────────────
  {
    name: 'get_due_this_week',
    description: 'Return legal requests due within the next 7 days.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'number', minimum: 1, maximum: 30, description: 'Lookahead days (default 7)' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { days = 7, limit = 20 } = args;
      const now     = new Date();
      const weekEnd = new Date(now.getTime() + days * msPerDay);
      const filter  = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          dueDate: { $gte: startOfDay(now), $lte: endOfDay(weekEnd) },
          status: { $nin: INACTIVE_STATUSES },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ dueDate: 1, priority: -1 })
        .limit(limit)
        .lean();

      return {
        type: 'workflow_summary',
        title: `Due This Week (next ${days} days)`,
        summary: items.length
          ? `${items.length} legal request${items.length !== 1 ? 's' : ''} due within ${days} days.`
          : `No legal requests are due within the next ${days} days.`,
        items: items.map((lr) => formatItem(lr, now)),
        metrics: { count: items.length, lookaheadDays: days },
      };
    },
  },

  // ── 3. get_overdue_requests ────────────────────────────────────────────────
  {
    name: 'get_overdue_requests',
    description: 'Return active legal requests whose due date has passed.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          dueDate: { $lt: startOfDay(now) },
          status: { $nin: INACTIVE_STATUSES },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ dueDate: 1 })
        .limit(limit)
        .lean();

      const formatted = items.map((lr) => {
        const item = formatItem(lr, now);
        item.slaMissed = lr.internalOrExternal === 'INTERNAL'
          ? daysBetween(lr.submittedAt, now) > SLA.INTERNAL_TURNAROUND_DAYS
          : daysBetween(lr.submittedAt, now) > SLA.EXTERNAL_TURNAROUND_DAYS;
        return item;
      });

      return {
        type: 'workflow_summary',
        title: 'Overdue Legal Requests',
        summary: formatted.length
          ? `${formatted.length} overdue legal request${formatted.length !== 1 ? 's' : ''}.`
          : 'No overdue legal requests.',
        items: formatted,
        metrics: { count: formatted.length },
      };
    },
  },

  // ── 4. get_unassigned_requests ────────────────────────────────────────────
  {
    name: 'get_unassigned_requests',
    description: 'Return legal requests that have no assigned legal team owner.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }],
          status: { $nin: INACTIVE_STATUSES },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ submittedAt: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'workflow_summary',
        title: 'Unassigned Legal Requests',
        summary: items.length
          ? `${items.length} unassigned legal request${items.length !== 1 ? 's' : ''} need an owner.`
          : 'All legal requests have been assigned.',
        items: items.map((lr) => formatItem(lr, now)),
        metrics: { count: items.length },
      };
    },
  },

  // ── 5. get_waiting_for_manager ────────────────────────────────────────────
  {
    name: 'get_waiting_for_manager',
    description: 'Return legal requests currently waiting for manager action or review.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        { status: 'WITH_MANAGER' },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ dueDate: 1, priority: -1 })
        .limit(limit)
        .lean();

      return {
        type: 'workflow_summary',
        title: 'Waiting for Manager',
        summary: items.length
          ? `${items.length} request${items.length !== 1 ? 's' : ''} waiting for manager action.`
          : 'No requests are currently waiting for manager review.',
        items: items.map((lr) => formatItem(lr, now)),
        metrics: { count: items.length },
      };
    },
  },

  // ── 6. get_waiting_for_business ───────────────────────────────────────────
  {
    name: 'get_waiting_for_business',
    description: 'Return legal requests currently waiting for business department input.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        { status: 'WITH_BUSINESS_DEPARTMENT' },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ dueDate: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'workflow_summary',
        title: 'Waiting for Business Department',
        summary: items.length
          ? `${items.length} request${items.length !== 1 ? 's' : ''} waiting for business input.`
          : 'No requests are currently waiting for business department input.',
        items: items.map((lr) => formatItem(lr, now)),
        metrics: { count: items.length },
      };
    },
  },

  // ── 7. get_ready_for_signature ────────────────────────────────────────────
  {
    name: 'get_ready_for_signature',
    description: 'Return legal requests that are approved and ready to be sent for signature.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        { status: 'READY_FOR_SIGNATURE' },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ priority: -1, dueDate: 1 })
        .limit(limit)
        .lean();

      return {
        type: 'workflow_summary',
        title: 'Ready for Signature',
        summary: items.length
          ? `${items.length} request${items.length !== 1 ? 's' : ''} approved and ready for signature.`
          : 'No requests are currently ready for signature.',
        items: items.map((lr) => formatItem(lr, now)),
        metrics: { count: items.length },
      };
    },
  },

  // ── 8. get_signature_email_sent ───────────────────────────────────────────
  {
    name: 'get_signature_email_sent',
    description: 'Return legal requests where signature emails have already been sent to signatories.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          isFullySigned: { $ne: true },
          pendingSignatoriesCount: { $gt: 0 },
          signatureEmailSentAt: { $exists: true, $ne: null },
          status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ signatureEmailSentAt: 1 })
        .limit(limit)
        .lean();

      const formatted = items.map((lr) => {
        const item = formatItem(lr, now);
        const daysSinceSent = lr.signatureEmailSentAt
          ? Math.round((now - new Date(lr.signatureEmailSentAt)) / msPerDay)
          : null;
        item.daysSinceEmailSent = daysSinceSent;
        item.signatureEmailSentAt = lr.signatureEmailSentAt;
        item.pendingSignatoriesCount = lr.pendingSignatoriesCount;
        item.reminderDue = daysSinceSent !== null && daysSinceSent >= SLA.SIGNATURE_REMINDER_DAYS;
        item.escalationDue = daysSinceSent !== null && daysSinceSent >= SLA.SIGNATURE_ESCALATION_DAYS;
        return item;
      });

      return {
        type: 'workflow_summary',
        title: 'Signature Emails Sent',
        summary: formatted.length
          ? `${formatted.length} request${formatted.length !== 1 ? 's' : ''} have had signature emails sent and are awaiting responses.`
          : 'No requests currently have signature emails sent and pending.',
        items: formatted,
        metrics: { count: formatted.length },
      };
    },
  },

  // ── 9. get_awaiting_signature ─────────────────────────────────────────────
  {
    name: 'get_awaiting_signature',
    description: 'Return legal requests still waiting for one or more signatories to sign.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { limit = 20 } = args;
      const now   = new Date();
      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          isFullySigned: { $ne: true },
          pendingSignatoriesCount: { $gt: 0 },
          status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ signatureEmailSentAt: 1 })
        .limit(limit)
        .lean();

      const formatted = items.map((lr) => {
        const item = formatItem(lr, now);
        const daysSinceSent = lr.signatureEmailSentAt
          ? Math.round((now - new Date(lr.signatureEmailSentAt)) / msPerDay)
          : null;
        item.daysSinceEmailSent = daysSinceSent;
        item.pendingSignatoriesCount = lr.pendingSignatoriesCount;
        item.completedSignatoriesCount = lr.completedSignatoriesCount;
        item.reminderDue = daysSinceSent !== null && daysSinceSent >= SLA.SIGNATURE_REMINDER_DAYS;
        item.escalationDue = daysSinceSent !== null && daysSinceSent >= SLA.SIGNATURE_ESCALATION_DAYS;
        return item;
      });

      const reminderCount   = formatted.filter((i) => i.reminderDue).length;
      const escalationCount = formatted.filter((i) => i.escalationDue).length;

      return {
        type: 'workflow_summary',
        title: 'Awaiting Signature',
        summary: formatted.length
          ? `${formatted.length} request${formatted.length !== 1 ? 's' : ''} awaiting signature. ${reminderCount} reminder${reminderCount !== 1 ? 's' : ''} due, ${escalationCount} escalation${escalationCount !== 1 ? 's' : ''} due.`
          : 'No requests are currently awaiting signature.',
        items: formatted,
        metrics: { count: formatted.length, reminderDue: reminderCount, escalationDue: escalationCount },
      };
    },
  },

  // ── 10. get_no_update_requests ────────────────────────────────────────────
  {
    name: 'get_no_update_requests',
    description: `Return legal requests with no status change in the last ${SLA.NO_UPDATE_THRESHOLD_DAYS} days (stale/stuck requests).`,
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threshold_days: {
          type: 'number',
          minimum: 1,
          maximum: 30,
          description: `Days without update (default: ${SLA.NO_UPDATE_THRESHOLD_DAYS})`,
        },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { threshold_days = SLA.NO_UPDATE_THRESHOLD_DAYS, limit = 20 } = args;
      const now       = new Date();
      const threshold = new Date(now.getTime() - threshold_days * msPerDay);
      const filter    = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          lastStatusChangeAt: { $lt: threshold },
          status: { $nin: INACTIVE_STATUSES },
        },
      );
      const items = await LegalRequest.find(filter)
        .select(LR_SELECT)
        .populate('assignedTo', 'name')
        .sort({ lastStatusChangeAt: 1 })
        .limit(limit)
        .lean();

      const formatted = items.map((lr) => {
        const item = formatItem(lr, now);
        item.daysSinceUpdate = lr.lastStatusChangeAt
          ? Math.round((now - new Date(lr.lastStatusChangeAt)) / msPerDay)
          : null;
        return item;
      });

      return {
        type: 'workflow_summary',
        title: `No Update in ${threshold_days}+ Days`,
        summary: formatted.length
          ? `${formatted.length} request${formatted.length !== 1 ? 's' : ''} have had no status update in ${threshold_days} or more days.`
          : `All active requests have been updated within the last ${threshold_days} days.`,
        items: formatted,
        metrics: { count: formatted.length, thresholdDays: threshold_days },
      };
    },
  },

  // ── 11. get_workload_by_user ───────────────────────────────────────────────
  {
    name: 'get_workload_by_user',
    description: 'Return workload summary per legal team member. Privileged users see the full team; others see their own workload.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_args, context) {
      const now        = new Date();
      const today      = startOfDay(now);
      const weekEnd    = new Date(now.getTime() + 7 * msPerDay);
      const privileged = isPrivilegedUser(context.user);

      const baseFilter = privileged
        ? { status: { $nin: INACTIVE_STATUSES } }
        : mergeFilters(
            { assignedTo: context.userId, status: { $nin: INACTIVE_STATUSES } },
          );

      const [total, overdue, dueToday, dueWeek, waitingManager, awaitingSignature] =
        await Promise.all([
          LegalRequest.countDocuments(baseFilter),
          LegalRequest.countDocuments(mergeFilters(baseFilter, {
            dueDate: { $lt: today },
          })),
          LegalRequest.countDocuments(mergeFilters(baseFilter, {
            dueDate: { $gte: today, $lte: endOfDay(now) },
          })),
          LegalRequest.countDocuments(mergeFilters(baseFilter, {
            dueDate: { $gte: today, $lte: endOfDay(weekEnd) },
          })),
          LegalRequest.countDocuments(mergeFilters(baseFilter, {
            status: 'WITH_MANAGER',
          })),
          LegalRequest.countDocuments(mergeFilters(baseFilter, {
            isFullySigned: { $ne: true },
            pendingSignatoriesCount: { $gt: 0 },
            status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
          })),
        ]);

      if (privileged) {
        // Aggregate by assignedTo for team view
        const pipeline = [
          { $match: { status: { $nin: INACTIVE_STATUSES } } },
          {
            $group: {
              _id: '$assignedTo',
              total: { $sum: 1 },
              overdue: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, 1, 0] } },
              awaitingSig: {
                $sum: {
                  $cond: [
                    { $and: [
                      { $eq: ['$isFullySigned', false] },
                      { $gt: ['$pendingSignatoriesCount', 0] },
                    ]},
                    1, 0,
                  ],
                },
              },
            },
          },
          { $sort: { total: -1 } },
          { $limit: 20 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
          { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
        ];
        const rows = await LegalRequest.aggregate(pipeline);
        const team = rows.map((row) => ({
          userId: row._id ? String(row._id) : null,
          name: row.userInfo?.name || '(Unassigned)',
          total: row.total,
          overdue: row.overdue,
          awaitingSignature: row.awaitingSig,
        }));

        return {
          type: 'workflow_summary',
          title: 'Team Workload by User',
          summary: `Showing workload for ${team.length} team member${team.length !== 1 ? 's' : ''}.`,
          items: [],
          metrics: { total, overdue, dueToday, dueThisWeek: dueWeek, waitingManager, awaitingSignature },
          team,
        };
      }

      return {
        type: 'workflow_summary',
        title: 'My Workload',
        summary: `You have ${total} active request${total !== 1 ? 's' : ''}, ${overdue} overdue, ${dueToday} due today.`,
        items: [],
        metrics: { total, overdue, dueToday, dueThisWeek: dueWeek, waitingManager, awaitingSignature },
      };
    },
  },

  // ── 12. get_workflow_history ───────────────────────────────────────────────
  {
    name: 'get_workflow_history',
    description: 'Return the full workflow timeline / audit trail for a specific legal request.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      required: ['legalRequestId'],
      additionalProperties: false,
      properties: {
        legalRequestId: {
          type: 'string',
          description: 'The human-readable request ID (e.g. LR-2025-12345) or MongoDB ObjectId.',
        },
      },
    },
    async execute(args, context) {
      const { legalRequestId } = args;
      const lookup = isObjectIdLike(legalRequestId)
        ? { $or: [{ _id: legalRequestId }, { requestId: legalRequestId }] }
        : { requestId: { $regex: new RegExp(`^${legalRequestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } };

      const lr = await LegalRequest.findOne(
        mergeFilters(lookup, legalRequestVisibilityFilter(context.user)),
      ).select('requestId title status internalOrExternal department assignedTo submittedAt dueDate')
        .populate('assignedTo', 'name')
        .lean();

      if (!lr) {
        return { type: 'not_found', message: `No accessible legal request found for "${legalRequestId}".` };
      }

      const history = await WorkflowHistory.find({ legalRequest: lr._id })
        .populate('changedBy', 'name email')
        .sort({ changedAt: 1 })
        .lean();

      const events = history.map((h) => safeWorkflowHistoryEvent(h, context.user));

      return {
        type: 'workflow_summary',
        title: `Workflow History — ${lr.requestId}`,
        summary: `${events.length} event${events.length !== 1 ? 's' : ''} in the workflow timeline for "${lr.title}". Current status: ${lr.status}.`,
        items: [],
        history: events,
        metrics: { eventCount: events.length, currentStatus: lr.status },
      };
    },
  },

  // ── 13. get_internal_sla_summary ──────────────────────────────────────────
  {
    name: 'get_internal_sla_summary',
    description: `Return internal SLA compliance. Internal SLA: completed within ${SLA.INTERNAL_TURNAROUND_DAYS} calendar days of submission.`,
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_days: {
          type: 'number',
          minimum: 1,
          maximum: 365,
          description: 'Look-back period in days (default 90).',
        },
      },
    },
    async execute(args, context) {
      const { period_days = 90 } = args;
      const now        = new Date();
      const periodStart = new Date(now.getTime() - period_days * msPerDay);

      const baseFilter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          internalOrExternal: 'INTERNAL',
          submittedAt: { $gte: periodStart },
        },
      );
      const completedFilter = mergeFilters(baseFilter, {
        status: { $in: COMPLETED_STATUSES },
        completedAt: { $exists: true, $ne: null },
      });

      const [total, completed, active, overdue] = await Promise.all([
        LegalRequest.countDocuments(baseFilter),
        LegalRequest.countDocuments(completedFilter),
        LegalRequest.countDocuments(mergeFilters(baseFilter, { status: { $nin: INACTIVE_STATUSES } })),
        LegalRequest.countDocuments(mergeFilters(baseFilter, {
          dueDate: { $lt: now },
          status: { $nin: INACTIVE_STATUSES },
        })),
      ]);

      // Calculate within-SLA counts using aggregation
      const slaAgg = await LegalRequest.aggregate([
        { $match: completedFilter },
        {
          $project: {
            elapsedDays: {
              $divide: [{ $subtract: ['$completedAt', '$submittedAt'] }, msPerDay],
            },
          },
        },
        {
          $group: {
            _id: null,
            withinSla: {
              $sum: { $cond: [{ $lte: ['$elapsedDays', SLA.INTERNAL_TURNAROUND_DAYS] }, 1, 0] },
            },
            outsideSla: {
              $sum: { $cond: [{ $gt: ['$elapsedDays', SLA.INTERNAL_TURNAROUND_DAYS] }, 1, 0] },
            },
            avgDays: { $avg: '$elapsedDays' },
          },
        },
      ]);

      const slaRow      = slaAgg[0] || { withinSla: 0, outsideSla: 0, avgDays: null };
      const compliance  = completed > 0 ? Math.round((slaRow.withinSla / completed) * 100) : null;
      const avgDays     = slaRow.avgDays !== null ? Math.round(slaRow.avgDays * 10) / 10 : null;

      return {
        type: 'workflow_summary',
        title: `Internal SLA Summary (last ${period_days} days)`,
        summary: compliance !== null
          ? `Internal SLA compliance: ${compliance}% of completed requests finished within ${SLA.INTERNAL_TURNAROUND_DAYS} days. Average turnaround: ${avgDays} days.`
          : `${total} internal requests in the period; ${completed} completed, ${active} active, ${overdue} overdue.`,
        items: [],
        metrics: {
          totalRequests: total,
          completed,
          withinSla: slaRow.withinSla,
          missedSla: slaRow.outsideSla,
          compliancePct: compliance,
          avgTurnaroundDays: avgDays,
          activeRequests: active,
          overdueRequests: overdue,
          slaThresholdDays: SLA.INTERNAL_TURNAROUND_DAYS,
          periodDays: period_days,
        },
      };
    },
  },

  // ── 14. get_external_sla_summary ──────────────────────────────────────────
  {
    name: 'get_external_sla_summary',
    description: `Return external SLA compliance. External SLA: completed OR sent for signature within ${SLA.EXTERNAL_TURNAROUND_DAYS} calendar days. Signature completion time is tracked separately.`,
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_days: {
          type: 'number',
          minimum: 1,
          maximum: 365,
          description: 'Look-back period in days (default 90).',
        },
      },
    },
    async execute(args, context) {
      const { period_days = 90 } = args;
      const now         = new Date();
      const periodStart = new Date(now.getTime() - period_days * msPerDay);

      const baseFilter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        {
          internalOrExternal: 'EXTERNAL',
          submittedAt: { $gte: periodStart },
        },
      );

      const [total, completed, awaitingSig, overdue] = await Promise.all([
        LegalRequest.countDocuments(baseFilter),
        LegalRequest.countDocuments(mergeFilters(baseFilter, { status: { $in: COMPLETED_STATUSES } })),
        LegalRequest.countDocuments(mergeFilters(baseFilter, {
          isFullySigned: { $ne: true },
          pendingSignatoriesCount: { $gt: 0 },
          status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
        })),
        LegalRequest.countDocuments(mergeFilters(baseFilter, {
          dueDate: { $lt: now },
          status: { $nin: INACTIVE_STATUSES },
        })),
      ]);

      // SLA: completed or signatureEmailSentAt within EXTERNAL_TURNAROUND_DAYS
      const slaAgg = await LegalRequest.aggregate([
        {
          $match: mergeFilters(baseFilter, {
            $or: [
              { status: { $in: COMPLETED_STATUSES } },
              { signatureEmailSentAt: { $exists: true, $ne: null } },
            ],
          }),
        },
        {
          $project: {
            milestoneDate: {
              $cond: [
                {
                  $and: [
                    { $ifNull: ['$completedAt', false] },
                    { $ifNull: ['$signatureEmailSentAt', false] },
                  ],
                },
                {
                  $cond: [
                    { $lte: ['$signatureEmailSentAt', '$completedAt'] },
                    '$signatureEmailSentAt',
                    '$completedAt',
                  ],
                },
                { $ifNull: ['$signatureEmailSentAt', '$completedAt'] },
              ],
            },
            submittedAt: 1,
            signatureEmailSentAt: 1,
            fullySignedAt: 1,
          },
        },
        {
          $project: {
            legalElapsedDays: {
              $divide: [{ $subtract: ['$milestoneDate', '$submittedAt'] }, msPerDay],
            },
            signatureElapsedDays: {
              $cond: [
                { $and: [{ $ifNull: ['$fullySignedAt', false] }, { $ifNull: ['$signatureEmailSentAt', false] }] },
                { $divide: [{ $subtract: ['$fullySignedAt', '$signatureEmailSentAt'] }, msPerDay] },
                null,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            withinSla: {
              $sum: { $cond: [{ $lte: ['$legalElapsedDays', SLA.EXTERNAL_TURNAROUND_DAYS] }, 1, 0] },
            },
            outsideSla: {
              $sum: { $cond: [{ $gt: ['$legalElapsedDays', SLA.EXTERNAL_TURNAROUND_DAYS] }, 1, 0] },
            },
            avgLegalDays: { $avg: '$legalElapsedDays' },
            avgSignatureDays: { $avg: '$signatureElapsedDays' },
          },
        },
      ]);

      const slaRow          = slaAgg[0] || { withinSla: 0, outsideSla: 0, avgLegalDays: null, avgSignatureDays: null };
      const reachedMilestone = slaRow.withinSla + slaRow.outsideSla;
      const compliance      = reachedMilestone > 0
        ? Math.round((slaRow.withinSla / reachedMilestone) * 100)
        : null;
      const avgLegal   = slaRow.avgLegalDays   !== null ? Math.round(slaRow.avgLegalDays * 10) / 10 : null;
      const avgSignature = slaRow.avgSignatureDays !== null ? Math.round(slaRow.avgSignatureDays * 10) / 10 : null;

      return {
        type: 'workflow_summary',
        title: `External SLA Summary (last ${period_days} days)`,
        summary: compliance !== null
          ? `External SLA compliance: ${compliance}% of requests were completed or sent for signature within ${SLA.EXTERNAL_TURNAROUND_DAYS} days. Avg legal turnaround: ${avgLegal} days. Avg signature completion: ${avgSignature !== null ? `${avgSignature} days` : 'N/A'}.`
          : `${total} external requests in the period; ${completed} completed, ${awaitingSig} awaiting signature, ${overdue} overdue.`,
        items: [],
        metrics: {
          totalRequests: total,
          completed,
          awaitingSignature: awaitingSig,
          withinSla: slaRow.withinSla,
          missedSla: slaRow.outsideSla,
          compliancePct: compliance,
          avgLegalTurnaroundDays: avgLegal,
          avgSignatureCompletionDays: avgSignature,
          overdueRequests: overdue,
          slaThresholdDays: SLA.EXTERNAL_TURNAROUND_DAYS,
          periodDays: period_days,
        },
      };
    },
  },

  // ── 15. get_submitted_legal_requests ─────────────────────────────────────
  {
    name: 'get_submitted_legal_requests',
    description: 'Return legal requests that were recently submitted or are currently in Submitted status.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'this_week', 'this_month', 'all'],
          description: 'Time window for submittedAt (default: this_week)',
        },
        status: {
          type: 'string',
          enum: ['SUBMITTED', 'ALL'],
          description: 'Filter by workflow status (default: SUBMITTED — still in intake queue)',
        },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    async execute(args, context) {
      const { period = 'this_week', status = 'SUBMITTED', limit = 20 } = args;
      const now = new Date();

      let periodFilter = {};
      let periodLabel = 'this week';
      if (period === 'today') {
        periodFilter = { submittedAt: { $gte: startOfDay(now), $lte: endOfDay(now) } };
        periodLabel = 'today';
      } else if (period === 'this_week') {
        periodFilter = { submittedAt: { $gte: new Date(now.getTime() - 7 * msPerDay) } };
        periodLabel = 'this week';
      } else if (period === 'this_month') {
        periodFilter = { submittedAt: { $gte: new Date(now.getTime() - 30 * msPerDay) } };
        periodLabel = 'this month';
      }

      const filter = mergeFilters(
        legalRequestVisibilityFilter(context.user),
        { ...periodFilter, ...(status !== 'ALL' ? { status: 'SUBMITTED' } : {}) },
      );

      const items = await LegalRequest.find(filter)
        .select(LR_SELECT + ' submittedBy')
        .populate('assignedTo', 'name')
        .populate('submittedBy', 'name')
        .sort({ submittedAt: -1 })
        .limit(limit)
        .lean();

      const formatted = items.map((lr) => {
        const item = formatItem(lr, now);
        item.submittedBy = lr.submittedBy?.name || null;
        item.submittedAt = lr.submittedAt || null;
        return item;
      });

      return {
        type: 'workflow_summary',
        title: 'Submitted Legal Requests',
        summary: formatted.length
          ? `${formatted.length} legal request${formatted.length !== 1 ? 's' : ''} submitted ${period !== 'all' ? periodLabel : ''}.`.trim()
          : `No legal requests${period !== 'all' ? ` submitted ${periodLabel}` : ''} found.`,
        items: formatted,
        metrics: { count: formatted.length, period, status },
      };
    },
  },

  // ── 16. get_legal_team_progress ──────────────────────────────────────────
  {
    name: 'get_legal_team_progress',
    description: 'Return legal team progress for a period: submitted, completed, overdue, due, SLA compliance, waiting states, signing states, and task progress.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'string', enum: ['today', 'this_week', 'this_month', 'this_year'] },
      },
    },
    async execute(args, context) {
      const { period = 'this_month' } = args;
      const now = new Date();
      const start = startOfPeriod(period);
      const base = legalRequestVisibilityFilter(context.user);
      const taskScope = taskVisibilityFilter(context.user);
      const activeFilter = mergeFilters(base, { status: { $nin: INACTIVE_STATUSES } });
      const submittedFilter = mergeFilters(base, { submittedAt: { $gte: start } });
      const completedFilter = mergeFilters(base, {
        status: { $in: COMPLETED_STATUSES },
        completedAt: { $gte: start },
      });

      const [
        submitted,
        completed,
        active,
        overdue,
        due,
        waitingManager,
        waitingBusiness,
        awaitingSignature,
        tasksCompleted,
        tasksPending,
        completedRows,
      ] = await Promise.all([
        LegalRequest.countDocuments(submittedFilter),
        LegalRequest.countDocuments(completedFilter),
        LegalRequest.countDocuments(activeFilter),
        LegalRequest.countDocuments(mergeFilters(activeFilter, { dueDate: { $lt: startOfDay(now) } })),
        LegalRequest.countDocuments(mergeFilters(activeFilter, { dueDate: { $gte: startOfDay(now), $lte: endOfDay(new Date(now.getTime() + 7 * msPerDay)) } })),
        LegalRequest.countDocuments(mergeFilters(activeFilter, { status: 'WITH_MANAGER' })),
        LegalRequest.countDocuments(mergeFilters(activeFilter, { status: 'WITH_BUSINESS_DEPARTMENT' })),
        LegalRequest.countDocuments(mergeFilters(activeFilter, {
          isFullySigned: { $ne: true },
          pendingSignatoriesCount: { $gt: 0 },
          status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
        })),
        Task.countDocuments(mergeFilters(taskScope, { status: 'Completed', completedAt: { $gte: start } })),
        Task.countDocuments(mergeFilters(taskScope, { status: { $in: ['Pending', 'In Progress', 'Blocked', 'Overdue'] } })),
        LegalRequest.find(completedFilter)
          .select('internalOrExternal submittedAt completedAt signatureEmailSentAt legalWorkingDays totalElapsedDays')
          .lean(),
      ]);

      const withinSla = completedRows.filter((lr) => {
        const threshold = lr.internalOrExternal === 'EXTERNAL'
          ? SLA.EXTERNAL_TURNAROUND_DAYS
          : SLA.INTERNAL_TURNAROUND_DAYS;
        const elapsed = Number.isFinite(lr.legalWorkingDays) && lr.legalWorkingDays > 0
          ? lr.legalWorkingDays
          : lr.completedAt && lr.submittedAt
            ? Math.ceil((new Date(lr.completedAt) - new Date(lr.submittedAt)) / msPerDay)
            : null;
        return elapsed !== null && elapsed <= threshold;
      }).length;
      const slaCompliance = completedRows.length
        ? Math.round((withinSla / completedRows.length) * 100)
        : null;
      const periodLabel = period.replace('_', ' ');

      return {
        type: 'report_summary',
        category: 'legal_team_progress',
        title: `Legal Team Progress ${periodLabel}`,
        summary: slaCompliance !== null
          ? `Legal progress ${periodLabel}: ${submitted} submitted, ${completed} completed, ${overdue} overdue, ${slaCompliance}% SLA compliance.`
          : `Legal progress ${periodLabel}: ${submitted} submitted, ${completed} completed, ${overdue} overdue.`,
        metrics: {
          submitted,
          completed,
          active,
          overdue,
          dueSoon: due,
          awaitingManager: waitingManager,
          awaitingBusiness: waitingBusiness,
          awaitingSignature,
          tasksCompleted,
          tasksPending,
          slaCompliance,
          period,
        },
        items: [],
      };
    },
  },

  // ── 17. get_manager_attention_summary ─────────────────────────────────────
  {
    name: 'get_manager_attention_summary',
    description: 'Return a prioritized manager attention view: overdue, due today, unassigned, waiting for manager, stale, ready for signature, and escalations needed.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        item_limit: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'Max items per category (default 5)',
        },
      },
    },
    async execute(args, context) {
      const { item_limit = 5 } = args;
      const now    = new Date();
      const today  = startOfDay(now);
      const staleThreshold = new Date(now.getTime() - SLA.NO_UPDATE_THRESHOLD_DAYS * msPerDay);
      const base   = legalRequestVisibilityFilter(context.user);

      const [overdue, dueToday, unassigned, withManager, stale, readyForSig, awaitingSig] =
        await Promise.all([
          LegalRequest.find(mergeFilters(base, {
            dueDate: { $lt: today },
            status: { $nin: INACTIVE_STATUSES },
          }))
            .select(LR_SELECT).populate('assignedTo', 'name')
            .sort({ dueDate: 1 }).limit(item_limit).lean(),

          LegalRequest.find(mergeFilters(base, {
            dueDate: { $gte: today, $lte: endOfDay(now) },
            status: { $nin: INACTIVE_STATUSES },
          }))
            .select(LR_SELECT).populate('assignedTo', 'name')
            .sort({ priority: -1 }).limit(item_limit).lean(),

          LegalRequest.find(mergeFilters(base, {
            $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }],
            status: { $nin: INACTIVE_STATUSES },
          }))
            .select(LR_SELECT)
            .sort({ submittedAt: 1 }).limit(item_limit).lean(),

          LegalRequest.find(mergeFilters(base, {
            status: 'WITH_MANAGER',
          }))
            .select(LR_SELECT).populate('assignedTo', 'name')
            .sort({ dueDate: 1 }).limit(item_limit).lean(),

          LegalRequest.find(mergeFilters(base, {
            lastStatusChangeAt: { $lt: staleThreshold },
            status: { $nin: INACTIVE_STATUSES },
          }))
            .select(LR_SELECT).populate('assignedTo', 'name')
            .sort({ lastStatusChangeAt: 1 }).limit(item_limit).lean(),

          LegalRequest.find(mergeFilters(base, {
            status: 'READY_FOR_SIGNATURE',
          }))
            .select(LR_SELECT).populate('assignedTo', 'name')
            .sort({ priority: -1 }).limit(item_limit).lean(),

          LegalRequest.find(mergeFilters(base, {
            isFullySigned: { $ne: true },
            pendingSignatoriesCount: { $gt: 0 },
            status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
            signatureEmailSentAt: { $lt: new Date(now.getTime() - SLA.SIGNATURE_ESCALATION_DAYS * msPerDay) },
          }))
            .select(LR_SELECT).populate('assignedTo', 'name')
            .sort({ signatureEmailSentAt: 1 }).limit(item_limit).lean(),
        ]);

      const sections = [
        { key: 'overdue',         label: 'Overdue',               items: overdue.map((lr) => formatItem(lr, now)) },
        { key: 'dueToday',        label: 'Due Today',             items: dueToday.map((lr) => formatItem(lr, now)) },
        { key: 'unassigned',      label: 'Unassigned',            items: unassigned.map((lr) => formatItem(lr, now)) },
        { key: 'withManager',     label: 'Waiting for Manager',   items: withManager.map((lr) => formatItem(lr, now)) },
        { key: 'stale',           label: 'No Update (3+ days)',   items: stale.map((lr) => formatItem(lr, now)) },
        { key: 'readyForSig',     label: 'Ready for Signature',   items: readyForSig.map((lr) => formatItem(lr, now)) },
        { key: 'escalateSig',     label: 'Signature Escalation',  items: awaitingSig.map((lr) => formatItem(lr, now)) },
      ];

      const totalAttention = sections.reduce((sum, s) => sum + s.items.length, 0);

      const parts = sections
        .filter((s) => s.items.length > 0)
        .map((s) => `${s.items.length} ${s.label.toLowerCase()}`);

      return {
        type: 'workflow_summary',
        title: 'Manager Attention Summary',
        summary: totalAttention > 0
          ? `${totalAttention} item${totalAttention !== 1 ? 's' : ''} need attention: ${parts.join(', ')}.`
          : 'No immediate items require manager attention.',
        items: [],
        sections,
        metrics: {
          overdue: overdue.length,
          dueToday: dueToday.length,
          unassigned: unassigned.length,
          withManager: withManager.length,
          stale: stale.length,
          readyForSignature: readyForSig.length,
          signatureEscalation: awaitingSig.length,
          totalAttentionItems: totalAttention,
        },
      };
    },
  },

  {
    name: 'query_legal_requests',
    description: 'Query visible legal requests with structured filters such as department, priority, status, dates, holder, and requested output fields.',
    riskLevel: 'low',
    requiredPermissions: ['report:read'],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: LEGAL_REQUEST_STATUSES },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
            department: { type: 'string', maxLength: 100 },
            requestType: { type: 'string', maxLength: 80 },
            documentCategory: { type: 'string', maxLength: 120 },
            internalOrExternal: { type: 'string', enum: ['INTERNAL', 'EXTERNAL'] },
            assignedTo: { type: 'string', maxLength: 80 },
            submittedBy: { type: 'string', maxLength: 80 },
            currentHolder: {
              type: 'string',
              enum: ['LEGAL_MANAGER', 'LEGAL_TEAM_MEMBER', 'BUSINESS_DEPARTMENT', 'EXTERNAL_PARTY', 'SIGNATORIES', 'SYSTEM_ADMIN', 'NONE'],
            },
            dueRange: { type: 'string', enum: ['today', 'this_week', 'overdue'] },
            dateRange: { type: 'string', enum: ['today', 'this_week', 'this_month', 'all'] },
            urgentOnly: { type: 'boolean' },
            overdueOnly: { type: 'boolean' },
            closedOnly: { type: 'boolean' },
          },
        },
        requestedFields: { type: 'array' },
        period: { type: 'string', enum: ['today', 'this_week', 'this_month', 'all'] },
        limit: { type: 'number', minimum: 1, maximum: 50 },
        countOnly: { type: 'boolean' },
        sortBy: { type: 'string', enum: ['submittedAt', 'dueDate', 'priority', 'updatedAt'] },
        answerShape: { type: 'string', enum: ['count', 'cards', 'metric_summary', 'field_answer', 'table', 'timeline', 'clarification'] },
      },
    },
    async execute(args, context) {
      const {
        filters = {},
        requestedFields = [],
        period = 'all',
        limit = 20,
        countOnly = false,
        sortBy = 'updatedAt',
        answerShape = 'cards',
      } = args;

      const now = new Date();
      const extra = {
        ...periodFilter(period),
        ...dueRangeFilter(filters.dueRange || (filters.overdueOnly ? 'overdue' : null)),
      };

      if (filters.status) extra.status = filters.status;
      if (filters.closedOnly) extra.status = 'CLOSED';
      if (filters.priority) extra.priority = filters.priority;
      if (filters.urgentOnly) extra.priority = 'URGENT';
      if (filters.department) extra.department = safeRegExp(filters.department);
      if (filters.requestType) extra.requestType = filters.requestType;
      if (filters.documentCategory) extra.documentCategory = safeRegExp(filters.documentCategory);
      if (filters.internalOrExternal) extra.internalOrExternal = filters.internalOrExternal;
      if (filters.currentHolder) extra.currentHolder = filters.currentHolder;
      if (filters.assignedTo === 'me') extra.assignedTo = context.userId;
      if (filters.submittedBy === 'me') extra.submittedBy = context.userId;

      const filter = mergeFilters(legalRequestVisibilityFilter(context.user), extra);
      const total = await LegalRequest.countDocuments(filter);

      if (countOnly) {
        const subject = filters.department ? `${filters.department} legal requests` : 'legal requests';
        return {
          type: 'count_summary',
          category: 'legal_requests_count',
          title: 'Legal Request Count',
          summary: `${total} visible ${subject}${filters.priority ? ` with ${humanize(filters.priority)} priority` : ''}.`,
          metrics: { count: total, filters },
          items: [],
        };
      }

      const sort = sortBy === 'dueDate'
        ? { dueDate: 1, priority: -1 }
        : sortBy === 'priority'
          ? { priority: -1, dueDate: 1, submittedAt: -1 }
          : sortBy === 'submittedAt'
            ? { submittedAt: -1 }
            : { updatedAt: -1, submittedAt: -1 };

      const rows = await LegalRequest.find(filter)
        .select(`${LR_SELECT} submittedBy updatedAt`)
        .populate('assignedTo', 'name')
        .populate('submittedBy', 'name')
        .sort(sort)
        .limit(limit)
        .lean();

      const items = rows.map((lr) => {
        const safe = safeLegalRequestFields(lr, context.user);
        return {
          ...formatItem(lr, now),
          id: safe.id,
          description: lr.reasonForRequest || null,
          submittedBy: lr.submittedBy?.name || null,
          updatedAt: lr.updatedAt || null,
        };
      });

      const departmentLabel = filters.department ? `${filters.department} ` : '';
      const priorityLabel = filters.priority || filters.urgentOnly ? `${humanize(filters.priority || 'URGENT')} priority ` : '';
      const tableRequested = answerShape === 'table' || answerShape === 'field_answer' || requestedFields.includes('dueDate') || requestedFields.includes('targetDate');
      const type = tableRequested ? 'table_summary' : 'legal_request_summary';
      const category = tableRequested ? 'legal_request_field_answer' : 'legal_requests';
      const columns = tableRequested
        ? [
          { key: 'request', label: 'Request' },
          { key: 'type', label: 'Type' },
          { key: 'department', label: 'Department' },
          { key: 'submitted', label: 'Submitted' },
          { key: 'wantedBy', label: 'Wanted By' },
          { key: 'status', label: 'Status' },
          { key: 'nextAction', label: 'Next Action' },
        ]
        : [];
      const tableRows = tableRequested ? items.map(rowForLegalRequest) : [];

      let summary;
      if (filters.urgentOnly || filters.priority === 'URGENT') {
        summary = total
          ? `${total} urgent legal request${total !== 1 ? 's are' : ' is'} visible to you.`
          : 'No urgent legal requests are visible to you.';
      } else if (filters.department && tableRequested) {
        if (total === 0) {
          summary = `No visible legal requests from ${filters.department} were found.`;
        } else if (total === 1) {
          const first = items[0];
          const when = wantedBy(first) ? ` They want it by ${new Date(wantedBy(first)).toLocaleDateString()}.` : '';
          summary = `${filters.department} has 1 visible legal request: ${first.title || 'Untitled request'}.${when}`;
        } else {
          summary = `${filters.department} has ${total} visible legal requests. Here is what they asked for and when each is due.`;
        }
      } else if (filters.department) {
        summary = total
          ? `${total} visible legal request${total !== 1 ? 's' : ''} from ${filters.department}.`
          : `No visible legal requests from ${filters.department} were found.`;
      } else if (filters.status) {
        summary = total
          ? `${total} visible legal request${total !== 1 ? 's are' : ' is'} ${humanize(filters.status)}.`
          : `No visible legal requests are ${humanize(filters.status)}.`;
      } else {
        summary = total
          ? `You have ${total} visible ${departmentLabel}${priorityLabel}legal request${total !== 1 ? 's' : ''}.`
          : `No visible ${departmentLabel}${priorityLabel}legal requests were found.`;
      }

      return {
        type,
        category,
        title: tableRequested ? 'Legal Request Details' : 'Legal Requests',
        summary,
        metrics: { count: total, returned: items.length, filters, period },
        items,
        columns,
        rows: tableRows,
      };
    },
  },
];
