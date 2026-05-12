'use strict';
const LegalRequest    = require('../models/LegalRequest');
const WorkflowHistory = require('../models/WorkflowHistory');
const Notification    = require('../models/Notification');
const User            = require('../models/User');
const Task            = require('../models/Task');

// ── Due-date rules ────────────────────────────────────────────────────────────
const DUE_DAYS = { INTERNAL: 4, EXTERNAL: 7 };

function addCalendarDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(a, b) {
  return Math.round(Math.abs(new Date(b) - new Date(a)) / 86400000);
}

function calculateDueDate(internalOrExternal, submittedAt = new Date()) {
  const days = DUE_DAYS[internalOrExternal] || 7;
  return addCalendarDays(submittedAt, days);
}

// ── Status → currentHolder mapping ───────────────────────────────────────────
const HOLDER_MAP = {
  SUBMITTED:                  'LEGAL_MANAGER',
  INTAKE_REVIEW:              'LEGAL_MANAGER',
  ASSIGNED:                   'LEGAL_TEAM_MEMBER',
  IN_LEGAL_REVIEW:            'LEGAL_TEAM_MEMBER',
  INTERNAL_LEGAL_REVIEW:      'LEGAL_TEAM_MEMBER',
  SENT_TO_EXTERNAL_PARTY:     'EXTERNAL_PARTY',
  WAITING_FOR_EXTERNAL_PARTY: 'EXTERNAL_PARTY',
  EXTERNAL_FEEDBACK_RECEIVED: 'LEGAL_TEAM_MEMBER',
  NEGOTIATION_AMENDMENTS:     'LEGAL_TEAM_MEMBER',
  WITH_BUSINESS_DEPARTMENT:   'BUSINESS_DEPARTMENT',
  WITH_MANAGER:               'LEGAL_MANAGER',
  REVISIONS_REQUIRED:         'LEGAL_TEAM_MEMBER',
  MANAGER_APPROVED:           'LEGAL_MANAGER',
  APPROVED:                   'LEGAL_TEAM_MEMBER',
  READY_FOR_SIGNATURE:        'LEGAL_MANAGER',
  SENT_FOR_SIGNATURE:         'SIGNATORIES',
  PARTIALLY_SIGNED:           'SIGNATORIES',
  FULLY_SIGNED:               'LEGAL_TEAM_MEMBER',
  STORED:                     'SYSTEM_ADMIN',
  FINALIZED:                  'LEGAL_TEAM_MEMBER',
  CLOSED:                     'SYSTEM_ADMIN',
  ON_HOLD:                    'LEGAL_MANAGER',
  CANCELLED:                  'SYSTEM_ADMIN',
};

// ── Status → next action text ─────────────────────────────────────────────────
const NEXT_ACTION_MAP = {
  SUBMITTED:                  'Legal manager to review and assign',
  INTAKE_REVIEW:              'Legal manager to check completeness and assign',
  ASSIGNED:                   'Assigned legal team member to begin review',
  IN_LEGAL_REVIEW:            'Legal team member to complete review and prepare draft',
  INTERNAL_LEGAL_REVIEW:      'Legal team member to complete internal review',
  SENT_TO_EXTERNAL_PARTY:     'Awaiting external party response',
  WAITING_FOR_EXTERNAL_PARTY: 'Follow up with external party if no response within 2 days',
  EXTERNAL_FEEDBACK_RECEIVED: 'Legal team member to review external feedback',
  NEGOTIATION_AMENDMENTS:     'Legal team member to incorporate amendments',
  WITH_BUSINESS_DEPARTMENT:   'Business department to provide required input',
  WITH_MANAGER:               'Manager to approve or request changes',
  REVISIONS_REQUIRED:         'Legal team member to action requested revisions',
  MANAGER_APPROVED:           'Prepare document for signature',
  APPROVED:                   'Finalise and prepare for signature or closing',
  READY_FOR_SIGNATURE:        'Initiate signature process',
  SENT_FOR_SIGNATURE:         'Awaiting signatures from all parties',
  PARTIALLY_SIGNED:           'Awaiting remaining signatures',
  FULLY_SIGNED:               'Store signed document and close request',
  STORED:                     'Close request',
  FINALIZED:                  'Close request',
  CLOSED:                     'No further action required',
  ON_HOLD:                    'Resume when hold reason is resolved',
  CANCELLED:                  'No further action required',
};

// ── Valid transitions per status ──────────────────────────────────────────────
const ALLOWED_TRANSITIONS = {
  SUBMITTED:                  ['INTAKE_REVIEW', 'ASSIGNED', 'ON_HOLD', 'CANCELLED'],
  INTAKE_REVIEW:              ['ASSIGNED', 'ON_HOLD', 'CANCELLED'],
  ASSIGNED:                   ['IN_LEGAL_REVIEW', 'INTERNAL_LEGAL_REVIEW', 'ON_HOLD', 'CANCELLED'],
  IN_LEGAL_REVIEW:            ['WITH_MANAGER', 'REVISIONS_REQUIRED', 'WITH_BUSINESS_DEPARTMENT', 'ON_HOLD'],
  INTERNAL_LEGAL_REVIEW:      ['WITH_MANAGER', 'REVISIONS_REQUIRED', 'WITH_BUSINESS_DEPARTMENT', 'SENT_TO_EXTERNAL_PARTY', 'ON_HOLD'],
  SENT_TO_EXTERNAL_PARTY:     ['WAITING_FOR_EXTERNAL_PARTY', 'EXTERNAL_FEEDBACK_RECEIVED'],
  WAITING_FOR_EXTERNAL_PARTY: ['EXTERNAL_FEEDBACK_RECEIVED', 'ON_HOLD'],
  EXTERNAL_FEEDBACK_RECEIVED: ['NEGOTIATION_AMENDMENTS', 'WITH_MANAGER', 'REVISIONS_REQUIRED'],
  NEGOTIATION_AMENDMENTS:     ['WITH_MANAGER', 'SENT_TO_EXTERNAL_PARTY'],
  WITH_BUSINESS_DEPARTMENT:   ['IN_LEGAL_REVIEW', 'INTERNAL_LEGAL_REVIEW', 'WITH_MANAGER'],
  WITH_MANAGER:               ['REVISIONS_REQUIRED', 'MANAGER_APPROVED', 'APPROVED', 'ON_HOLD'],
  REVISIONS_REQUIRED:         ['IN_LEGAL_REVIEW', 'INTERNAL_LEGAL_REVIEW', 'WITH_MANAGER'],
  MANAGER_APPROVED:           ['READY_FOR_SIGNATURE', 'STORED', 'CLOSED'],
  APPROVED:                   ['FINALIZED', 'CLOSED'],
  READY_FOR_SIGNATURE:        ['SENT_FOR_SIGNATURE', 'ON_HOLD'],
  SENT_FOR_SIGNATURE:         ['PARTIALLY_SIGNED', 'FULLY_SIGNED'],
  PARTIALLY_SIGNED:           ['FULLY_SIGNED', 'SENT_FOR_SIGNATURE'],
  FULLY_SIGNED:               ['STORED', 'CLOSED'],
  STORED:                     ['CLOSED'],
  FINALIZED:                  ['CLOSED'],
  ON_HOLD:                    ['ASSIGNED', 'INTAKE_REVIEW', 'CANCELLED'],
  CLOSED:                     [],
  CANCELLED:                  [],
};

const TERMINAL_STATUSES = new Set(['CLOSED', 'CANCELLED', 'FULLY_SIGNED', 'STORED']);

function getCurrentHolder(status) { return HOLDER_MAP[status] || 'NONE'; }
function getNextAction(status)    { return NEXT_ACTION_MAP[status] || ''; }
function getAllowedTransitions(status) { return ALLOWED_TRANSITIONS[status] || []; }

// ── SLA counter recalculation ─────────────────────────────────────────────────
async function recomputeSLATotals(legalRequestId) {
  const [request, history] = await Promise.all([
    LegalRequest.findById(legalRequestId),
    // Only STATUS_CHANGE events define time segments; other action types (ASSIGNMENT_CHANGE,
    // DUE_DATE_OVERRIDE) don't change the holder and must not add spurious boundary points.
    WorkflowHistory.find({
      legalRequest: legalRequestId,
      $or: [{ actionType: 'STATUS_CHANGE' }, { actionType: { $exists: false } }],
    }).sort({ changedAt: 1 }),
  ]);
  if (!request) return;

  let legalWorkingDays     = 0;
  let externalDelayDays    = 0;
  let businessWaitingDays  = 0;
  let signatureWaitingDays = 0;

  const events = history.map(h => ({ date: new Date(h.changedAt), holder: h.newHolder }));
  const end = request.completedAt ? new Date(request.completedAt) : new Date();
  events.push({ date: end, holder: null });

  for (let i = 0; i < events.length - 1; i++) {
    const days   = daysBetween(events[i].date, events[i + 1].date);
    const holder = events[i].holder;
    if (holder === 'LEGAL_MANAGER' || holder === 'LEGAL_TEAM_MEMBER') legalWorkingDays += days;
    else if (holder === 'EXTERNAL_PARTY')      externalDelayDays    += days;
    else if (holder === 'BUSINESS_DEPARTMENT') businessWaitingDays  += days;
    else if (holder === 'SIGNATORIES')         signatureWaitingDays += days;
  }

  const totalElapsedDays = daysBetween(request.submittedAt, end);

  await LegalRequest.findByIdAndUpdate(legalRequestId, {
    legalWorkingDays, externalDelayDays, businessWaitingDays, signatureWaitingDays, totalElapsedDays,
  });
}

// ── Auto task creation on status transitions ──────────────────────────────────
// Maps a new LR status to the task that should be created automatically.
// assignToFn returns the userId to assign to; returns null to skip creation.
// dueDays: null → use request.dueDate; 0 → today; N → today + N days.
function lrPriorityToTask(p) {
  return { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' }[p] || 'Medium';
}

const TASK_AUTO_MAP = {
  SUBMITTED: {
    titleFn: (r) => `Review intake and assign legal owner — ${r.title}`,
    type: 'ASSIGN_REQUEST',
    assignToFn: (r) => r.managerId,
    dueDays: 1,
  },
  INTAKE_REVIEW: {
    titleFn: (r) => `Validate intake information — ${r.title}`,
    type: 'INTAKE_REVIEW',
    assignToFn: (r) => r.managerId,
    dueDays: 1,
  },
  ASSIGNED: {
    titleFn: (r) => `Start legal review — ${r.title}`,
    type: 'LEGAL_REVIEW',
    assignToFn: (r) => r.assignedTo,
    dueDays: null,
  },
  IN_LEGAL_REVIEW: {
    titleFn: (r) => `Complete legal review — ${r.title}`,
    type: 'LEGAL_REVIEW',
    assignToFn: (r) => r.assignedTo,
    dueDays: null,
  },
  INTERNAL_LEGAL_REVIEW: {
    titleFn: (r) => `Complete internal legal review — ${r.title}`,
    type: 'LEGAL_REVIEW',
    assignToFn: (r) => r.assignedTo,
    dueDays: null,
  },
  WITH_MANAGER: {
    titleFn: (r) => `Approve or request revisions — ${r.title}`,
    type: 'MANAGER_APPROVAL',
    assignToFn: (r) => r.managerId,
    dueDays: 1,
  },
  REVISIONS_REQUIRED: {
    titleFn: (r) => `Action requested revisions — ${r.title}`,
    type: 'REQUEST_REVISIONS',
    assignToFn: (r) => r.assignedTo,
    dueDays: 1,
  },
  WITH_BUSINESS_DEPARTMENT: {
    titleFn: (r) => `Provide business input — ${r.title}`,
    type: 'BUSINESS_INPUT',
    assignToFn: (r) => r.submittedBy || r.managerId,
    dueDays: 1,
  },
  READY_FOR_SIGNATURE: {
    titleFn: (r) => `Send signature request emails — ${r.title}`,
    type: 'SEND_SIGNATURE_EMAIL',
    assignToFn: (r) => r.assignedTo || r.managerId,
    dueDays: 0,
  },
  SENT_FOR_SIGNATURE: {
    titleFn: (r) => `Monitor signature completion — ${r.title}`,
    type: 'FOLLOW_UP_SIGNATURE',
    assignToFn: (r) => r.assignedTo || r.managerId,
    dueDays: 2,
  },
  PARTIALLY_SIGNED: {
    titleFn: (r) => `Follow up on remaining signatures — ${r.title}`,
    type: 'FOLLOW_UP_SIGNATURE',
    assignToFn: (r) => r.assignedTo || r.managerId,
    dueDays: 1,
  },
  FULLY_SIGNED: {
    titleFn: (r) => `Store signed document and close request — ${r.title}`,
    type: 'STORE_SIGNED_DOCUMENT',
    assignToFn: (r) => r.assignedTo || r.managerId,
    dueDays: 0,
  },
  STORED: {
    titleFn: (r) => `Close legal request — ${r.title}`,
    type: 'CLOSE_REQUEST',
    assignToFn: (r) => r.assignedTo || r.managerId,
    dueDays: 0,
  },
};

async function autoCreateTask(request, newStatus, createdBy) {
  const spec = TASK_AUTO_MAP[newStatus];
  if (!spec) return;

  const assignToId = spec.assignToFn(request);
  if (!assignToId) return;

  // Prevent duplicate open tasks of the same type, but allow re-creation when the
  // existing task is Blocked (so a status loop back through a stage creates a fresh task).
  const existing = await Task.findOne({
    legalRequest: request._id,
    type: spec.type,
    status: { $nin: ['Completed', 'Cancelled', 'Blocked'] },
  });
  if (existing) return;

  const now      = new Date();
  const deadline = spec.dueDays === null
    ? (request.dueDate || addCalendarDays(now, 3))
    : addCalendarDays(now, Math.max(spec.dueDays, 1));

  await Task.create({
    title:        spec.titleFn(request),
    legalRequest: request._id,
    assignedTo:   assignToId,
    assignedBy:   createdBy._id,
    deadline,
    priority:     lrPriorityToTask(request.priority),
    type:         spec.type,
    status:       'Pending',
  });
}

// ── Core status-transition function ──────────────────────────────────────────
async function updateStatus(requestId, newStatus, performedByUser, comment = '') {
  const request = await LegalRequest.findById(requestId);
  if (!request) throw new Error('Legal request not found');

  // 1. Validate the transition is permitted by the workflow graph
  const allowed = getAllowedTransitions(request.status);
  if (!allowed.includes(newStatus)) {
    throw new Error(`Transition from ${request.status} to ${newStatus} is not permitted`);
  }

  // 2. Authorization: only managers/admins or the assigned team member may advance a request
  const isManager  = ['admin', 'manager'].includes(performedByUser.role);
  const isAssignee = request.assignedTo?.toString() === performedByUser._id.toString();
  if (!isManager && !isAssignee) {
    throw new Error('You are not authorised to update the status of this request');
  }

  const oldStatus  = request.status;
  const oldHolder  = request.currentHolder;
  const newHolder  = getCurrentHolder(newStatus);
  const nextAction = getNextAction(newStatus);
  const now        = new Date();

  request.status             = newStatus;
  request.currentHolder      = newHolder;
  request.nextAction         = nextAction;
  request.lastStatusChangeAt = now;
  if (TERMINAL_STATUSES.has(newStatus) && !request.completedAt) {
    request.completedAt = now;
  }
  if (newStatus === 'READY_FOR_SIGNATURE' && !request.signatureRequestedAt) {
    request.signatureRequestedAt = now;
  }
  if (newStatus === 'SENT_FOR_SIGNATURE' && !request.signatureEmailSentAt) {
    request.signatureEmailSentAt = now;
  }
  if (newStatus === 'FULLY_SIGNED' && !request.fullySignedAt) {
    request.fullySignedAt = now;
    request.isFullySigned = true;
  }
  await request.save();

  await WorkflowHistory.create({
    legalRequest: requestId,
    oldStatus,
    newStatus,
    oldHolder,
    newHolder,
    changedBy: performedByUser._id,
    comment,
    actionType: 'STATUS_CHANGE',
  });

  await recomputeSLATotals(requestId);
  await triggerNotifications(request, newStatus, performedByUser)
    .catch(err => console.error('[triggerNotifications]', err));
  await autoCreateTask(request, newStatus, performedByUser)
    .catch(err => console.error('[autoCreateTask]', err));

  return LegalRequest.findById(requestId)
    .populate('assignedTo', 'name email avatar')
    .populate('submittedBy', 'name email department')
    .populate('managerId', 'name email');
}

// ── Notification triggers ─────────────────────────────────────────────────────
async function triggerNotifications(request, newStatus, actor) {
  // 4-hour dedup window: the same title+request won't re-notify within 4 hours
  const dedupeWindow = new Date(Date.now() - 4 * 3600 * 1000);

  const send = async (recipientId, title, message) => {
    if (!recipientId) return;
    const recent = await Notification.findOne({
      recipient: recipientId,
      title,
      'relatedTo.id': request._id,
      createdAt: { $gte: dedupeWindow },
    });
    if (recent) return;
    await Notification.create({
      recipient: recipientId,
      type: 'general',
      title,
      message,
      priority: request.priority === 'URGENT' ? 'high' : 'normal',
      relatedTo: { type: 'contract', id: request._id, label: request.title },
    });
  };

  if (newStatus === 'ASSIGNED' && request.assignedTo) {
    const due = request.dueDate ? new Date(request.dueDate).toLocaleDateString('en-ZA') : 'TBD';
    await send(request.assignedTo, 'Legal Request Assigned',
      `You have been assigned: "${request.title}". Due: ${due}`);
  }

  if (newStatus === 'WITH_MANAGER' && request.managerId) {
    await send(request.managerId, 'Approval Required',
      `"${request.title}" requires your review and approval.`);
  }

  if (newStatus === 'REVISIONS_REQUIRED' && request.assignedTo) {
    await send(request.assignedTo, 'Revisions Requested',
      `Revisions requested for: "${request.title}". Please action immediately.`);
  }

  if (['FULLY_SIGNED', 'CLOSED', 'APPROVED', 'FINALIZED'].includes(newStatus)) {
    const submitterId = request.submittedBy?.toString?.();
    const actorId     = actor._id.toString();
    if (submitterId && submitterId !== actorId) {
      await send(request.submittedBy, 'Legal Request Update',
        `Your request "${request.title}" has been ${newStatus.replace(/_/g, ' ').toLowerCase()}.`);
    }
  }

  // Previously missing milestone notifications
  if (newStatus === 'WITH_BUSINESS_DEPARTMENT' && request.submittedBy) {
    await send(request.submittedBy, 'Your Input is Required',
      `Legal requires your input on "${request.title}". Please review and respond.`);
  }

  if (newStatus === 'SENT_TO_EXTERNAL_PARTY' && request.managerId) {
    await send(request.managerId, 'Sent for External Review',
      `"${request.title}" has been sent for external review (email).`);
  }

  if (newStatus === 'READY_FOR_SIGNATURE') {
    if (request.assignedTo) {
      await send(request.assignedTo, 'Ready for Signature',
        `"${request.title}" is ready — please initiate the signature process.`);
    }
    if (request.managerId) {
      await send(request.managerId, 'Ready for Signature',
        `"${request.title}" is ready for signature.`);
    }
  }

  if (newStatus === 'SENT_FOR_SIGNATURE' && request.submittedBy) {
    const submitterId = request.submittedBy?.toString?.();
    if (submitterId && submitterId !== actor._id.toString()) {
      await send(request.submittedBy, 'Sent for Signature',
        `"${request.title}" has been sent to signatories. You will be notified when complete.`);
    }
  }
}

// ── Manager dashboard aggregations ────────────────────────────────────────────
async function getManagerDashboard() {
  const now      = new Date();
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const weekEnd  = new Date(now); weekEnd.setDate(now.getDate() + 7);
  const threeDaysAgo = new Date(now); threeDaysAgo.setDate(now.getDate() - 3);
  const active   = { $nin: ['CLOSED', 'CANCELLED', 'FULLY_SIGNED', 'STORED'] };

  const [
    dueToday, dueThisWeek, overdue, unassigned,
    waitingForManager, waitingForExternal, escalated, noUpdate, recentItems,
  ] = await Promise.all([
    LegalRequest.countDocuments({ status: active, dueDate: { $gte: now, $lte: todayEnd } }),
    LegalRequest.countDocuments({ status: active, dueDate: { $gte: now, $lte: weekEnd } }),
    LegalRequest.countDocuments({ status: active, dueDate: { $lt: now } }),
    LegalRequest.countDocuments({ status: active, assignedTo: null }),
    LegalRequest.countDocuments({ status: 'WITH_MANAGER' }),
    LegalRequest.countDocuments({ status: { $in: ['WAITING_FOR_EXTERNAL_PARTY', 'SENT_TO_EXTERNAL_PARTY'] } }),
    LegalRequest.countDocuments({ status: active, escalationLevel: { $gte: 1 } }),
    LegalRequest.countDocuments({ status: active, lastStatusChangeAt: { $lt: threeDaysAgo } }),
    LegalRequest.find({ status: active })
      .populate('assignedTo', 'name avatar')
      .populate('submittedBy', 'name department')
      .sort({ priority: -1, dueDate: 1 })
      .limit(25),
  ]);

  return {
    cards: { dueToday, dueThisWeek, overdue, unassigned, waitingForManager, waitingForExternal, escalated, noUpdate },
    recentItems,
  };
}

// ── Team member dashboard aggregations ───────────────────────────────────────
async function getMemberDashboard(userId) {
  const now      = new Date();
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const weekEnd  = new Date(now); weekEnd.setDate(now.getDate() + 7);
  const qtrStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const active   = { $nin: ['CLOSED', 'CANCELLED', 'STORED'] };

  const myFilter = { assignedTo: userId, status: active };

  const [myTasks, dueToday, dueThisWeek, overdue, completedThisQtr, myItems] = await Promise.all([
    LegalRequest.countDocuments(myFilter),
    LegalRequest.countDocuments({ ...myFilter, dueDate: { $gte: now, $lte: todayEnd } }),
    LegalRequest.countDocuments({ ...myFilter, dueDate: { $gte: now, $lte: weekEnd } }),
    LegalRequest.countDocuments({ ...myFilter, dueDate: { $lt: now } }),
    LegalRequest.countDocuments({
      assignedTo: userId,
      status: { $in: ['CLOSED', 'FULLY_SIGNED', 'APPROVED', 'FINALIZED'] },
      completedAt: { $gte: qtrStart },
    }),
    LegalRequest.find(myFilter)
      .populate('submittedBy', 'name department')
      .sort({ dueDate: 1 })
      .limit(30),
  ]);

  return { cards: { myTasks, dueToday, dueThisWeek, overdue, completedThisQtr }, myItems };
}

module.exports = {
  calculateDueDate,
  getCurrentHolder,
  getNextAction,
  getAllowedTransitions,
  updateStatus,
  recomputeSLATotals,
  getManagerDashboard,
  getMemberDashboard,
};
