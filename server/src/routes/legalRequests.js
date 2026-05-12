'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const LegalRequest    = require('../models/LegalRequest');
const WorkflowHistory = require('../models/WorkflowHistory');
const Notification    = require('../models/Notification');
const User            = require('../models/User');
const Task            = require('../models/Task');
const {
  calculateDueDate, updateStatus, getAllowedTransitions,
  getManagerDashboard, getMemberDashboard,
} = require('../services/legalWorkflowService');
const { protect, requireRole } = require('../middleware/auth');
const { runDeadlineMonitor } = require('../services/legalDeadlineMonitorService');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ── Dashboard endpoints (must come before /:id) ───────────────────────────────

// GET /api/legal-requests/dashboard/manager
router.get('/dashboard/manager', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    res.json(await getManagerDashboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/legal-requests/dashboard/member
router.get('/dashboard/member', protect, async (req, res) => {
  try {
    res.json(await getMemberDashboard(req.user._id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/legal-requests/transitions/:status
router.get('/transitions/:status', protect, (req, res) => {
  res.json({ transitions: getAllowedTransitions(req.params.status) });
});

// GET /api/legal-requests/workflow-dashboard — all data needed by the Workflows tab
router.get('/workflow-dashboard', protect, async (req, res) => {
  try {
    const now          = new Date();
    const todayEnd     = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const weekEnd      = new Date(now); weekEnd.setDate(now.getDate() + 7);
    const threeDaysAgo = new Date(now); threeDaysAgo.setDate(now.getDate() - 3);
    const active       = { $nin: ['CLOSED', 'CANCELLED'] };
    const activeFilter = { status: active };

    // Role-based scoping: staff see only their own requests
    if (req.user.role === 'staff') {
      activeFilter.$or = [{ assignedTo: req.user._id }, { submittedBy: req.user._id }];
    }

    const [
      activeCount, overdueCount, dueTodayCount, dueThisWeekCount, unassignedCount,
      withManagerCount, withBusinessCount,
      readyForSigCount, awaitingSigCount, noUpdate3Count,
      requests,
    ] = await Promise.all([
      LegalRequest.countDocuments(activeFilter),
      LegalRequest.countDocuments({ ...activeFilter, dueDate: { $lt: now } }),
      LegalRequest.countDocuments({ ...activeFilter, dueDate: { $gte: now, $lte: todayEnd } }),
      LegalRequest.countDocuments({ ...activeFilter, dueDate: { $gte: now, $lte: weekEnd } }),
      LegalRequest.countDocuments({ ...activeFilter, assignedTo: null }),
      LegalRequest.countDocuments({ ...activeFilter, status: 'WITH_MANAGER' }),
      LegalRequest.countDocuments({ ...activeFilter, status: 'WITH_BUSINESS_DEPARTMENT' }),
      LegalRequest.countDocuments({ status: 'READY_FOR_SIGNATURE' }),
      LegalRequest.countDocuments({ status: { $in: ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] } }),
      LegalRequest.countDocuments({ ...activeFilter, lastStatusChangeAt: { $lt: threeDaysAgo } }),
      LegalRequest.find(activeFilter)
        .select('title requestId requestType internalOrExternal status currentHolder priority dueDate lastStatusChangeAt assignedTo submittedBy managerId counterpartyName department nextAction')
        .populate('assignedTo', 'name avatar')
        .populate('submittedBy', 'name department')
        .populate('managerId', 'name')
        .lean()
        .sort({ dueDate: 1 })
        .limit(200),
    ]);

    // Bottleneck stats: per stuck-category, compute count + avg wait + oldest item
    const BOTTLENECK_STATUSES = [
      { status: 'WITH_MANAGER',             label: 'With Manager' },
      { status: 'WITH_BUSINESS_DEPARTMENT', label: 'With Business Dept.' },
      { status: 'SENT_FOR_SIGNATURE',       label: 'Awaiting Signature' },
      { status: 'PARTIALLY_SIGNED',         label: 'Partially Signed' },
    ];

    const stuckItems = requests.filter(r =>
      BOTTLENECK_STATUSES.some(b => b.status === r.status)
    );

    const bottlenecks = BOTTLENECK_STATUSES.map(({ status, label }) => {
      const items = stuckItems.filter(r => r.status === status);
      const avgWaitDays = items.length
        ? Math.round(items.reduce((s, r) => s + (now - new Date(r.lastStatusChangeAt)) / 86400000, 0) / items.length * 10) / 10
        : 0;
      const oldest = items[0] || null;
      return { status, label, count: items.length, avgWaitDays, oldest };
    });

    // Overdue and no-update bottleneck entries
    const overdueItems  = requests.filter(r => r.dueDate && new Date(r.dueDate) < now).slice(0, 8);
    const noUpdateItems = requests.filter(r => new Date(r.lastStatusChangeAt) < threeDaysAgo).slice(0, 8);

    res.json({
      cards: {
        active: activeCount, overdue: overdueCount, dueToday: dueTodayCount,
        dueThisWeek: dueThisWeekCount, unassigned: unassignedCount,
        withManager: withManagerCount, withBusiness: withBusinessCount,
        readyForSignature: readyForSigCount, awaitingSignature: awaitingSigCount,
        noUpdate3: noUpdate3Count,
      },
      requests,
      bottlenecks,
      overdueItems,
      noUpdateItems,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/legal-requests/monitor/deadlines — admin/manager triggered or cron
router.post('/monitor/deadlines', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const results = await runDeadlineMonitor();
    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Collection endpoints ──────────────────────────────────────────────────────

// GET /api/legal-requests
router.get('/', protect, async (req, res) => {
  try {
    const {
      status, assignedTo, department, internalOrExternal, priority,
      overdue, unassigned, dueToday, dueThisWeek, currentHolder,
      noUpdate, page = 1, limit = 50, search,
    } = req.query;

    const filter = {};
    const now    = new Date();

    // Staff see only their own assigned + submitted requests
    if (req.user.role === 'staff') {
      filter.$or = [{ assignedTo: req.user._id }, { submittedBy: req.user._id }];
    }

    if (status)             filter.status = status;
    if (assignedTo)         filter.assignedTo = assignedTo;
    if (department)         filter.department = department;
    if (internalOrExternal) filter.internalOrExternal = internalOrExternal;
    if (priority)           filter.priority = priority;
    if (currentHolder)      filter.currentHolder = currentHolder;

    if (unassigned === 'true') filter.assignedTo = null;

    if (overdue === 'true') {
      filter.dueDate = { $lt: now };
      if (!filter.status) filter.status = { $nin: ['CLOSED', 'CANCELLED', 'FULLY_SIGNED', 'STORED'] };
    }
    if (dueToday === 'true') {
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      filter.dueDate = { $gte: now, $lte: end };
    }
    if (dueThisWeek === 'true') {
      const end = new Date(now); end.setDate(now.getDate() + 7);
      filter.dueDate = { $gte: now, $lte: end };
    }
    if (noUpdate === 'true') {
      const cutoff = new Date(now); cutoff.setDate(now.getDate() - 3);
      filter.lastStatusChangeAt = { $lt: cutoff };
      if (!filter.status) filter.status = { $nin: ['CLOSED', 'CANCELLED'] };
    }
    if (search) {
      const re = { $regex: search, $options: 'i' };
      filter.$or = [{ title: re }, { counterpartyName: re }, { requestId: re }, { department: re }];
    }

    const [requests, total] = await Promise.all([
      LegalRequest.find(filter)
        .populate('assignedTo', 'name email avatar')
        .populate('submittedBy', 'name email department')
        .populate('managerId', 'name email')
        .sort({ dueDate: 1, createdAt: -1 })
        .skip((page - 1) * parseInt(limit))
        .limit(parseInt(limit)),
      LegalRequest.countDocuments(filter),
    ]);

    res.json({ requests, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/legal-requests — intake form submission
router.post('/', protect, [
  body('title').trim().notEmpty().withMessage('Title required'),
  body('requestType').notEmpty().withMessage('Request type required'),
  body('internalOrExternal').isIn(['INTERNAL', 'EXTERNAL']).withMessage('Must be INTERNAL or EXTERNAL'),
], validate, async (req, res) => {
  try {
    const {
      title, requestType, documentCategory, internalOrExternal,
      counterpartyName, contractValue, priority, reasonForRequest,
      notes, department, dueDate,
    } = req.body;

    const submittedAt       = new Date();
    const calculatedDueDate = calculateDueDate(internalOrExternal, submittedAt);

    // Find the first available manager to set as default manager
    const manager = await User.findOne({ role: { $in: ['admin', 'manager'] }, isActive: true });

    const request = await LegalRequest.create({
      title, requestType, documentCategory, internalOrExternal,
      counterpartyName, contractValue: contractValue ? Number(contractValue) : undefined,
      priority: priority || 'MEDIUM',
      reasonForRequest, notes, department,
      submittedBy:  req.user._id,
      submittedAt,
      dueDate:      dueDate ? new Date(dueDate) : calculatedDueDate,
      targetDate:   calculatedDueDate,
      managerId:    manager?._id,
      status:       'SUBMITTED',
      currentHolder:'LEGAL_MANAGER',
      nextAction:   'Legal manager to review and assign',
    });

    // Log the initial history entry
    await WorkflowHistory.create({
      legalRequest: request._id,
      newStatus:    'SUBMITTED',
      newHolder:    'LEGAL_MANAGER',
      changedBy:    req.user._id,
      comment:      `Request submitted by ${req.user.name}`,
      actionType:   'STATUS_CHANGE',
    });

    // Notify manager
    if (manager) {
      await Notification.create({
        recipient: manager._id,
        type:      'general',
        title:     'New Legal Request',
        message:   `${req.user.name} (${req.user.department || 'Unknown dept.'}) submitted: "${title}"`,
        priority:  priority === 'URGENT' ? 'high' : 'normal',
        relatedTo: { type: 'contract', id: request._id, label: title },
      });
    }

    await request.populate('submittedBy', 'name email department');
    res.status(201).json({ request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single-resource endpoints ─────────────────────────────────────────────────

// GET /api/legal-requests/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const [request, history] = await Promise.all([
      LegalRequest.findById(req.params.id)
        .populate('assignedTo', 'name email avatar department')
        .populate('submittedBy', 'name email department')
        .populate('managerId', 'name email')
        .populate('linkedContract', 'title contractId'),
      WorkflowHistory.find({ legalRequest: req.params.id })
        .populate('changedBy', 'name email')
        .sort({ changedAt: 1 }),
    ]);

    if (!request) return res.status(404).json({ error: 'Legal request not found.' });

    res.json({ request, history, allowedTransitions: getAllowedTransitions(request.status) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/legal-requests/:id/status — status transition
router.put('/:id/status', protect, [
  body('status').notEmpty().withMessage('Status required'),
], validate, async (req, res) => {
  try {
    const { status, comment } = req.body;
    const request = await updateStatus(req.params.id, status, req.user, comment || '');
    res.json({ request, allowedTransitions: getAllowedTransitions(status) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/legal-requests/:id/assign
router.put('/:id/assign', protect, requireRole('admin', 'manager'), [
  body('assignedTo').notEmpty().withMessage('Assignee required'),
], validate, async (req, res) => {
  try {
    const request = await LegalRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found.' });

    const prevAssigned = request.assignedTo?.toString();
    const oldStatus    = request.status;
    const oldHolder    = request.currentHolder;

    // Persist the new assignee first so updateStatus() sees it when it does findById
    request.assignedTo = req.body.assignedTo;
    await request.save();

    let resultRequest;
    if (['SUBMITTED', 'INTAKE_REVIEW'].includes(oldStatus)) {
      // Route through updateStatus so SLA recompute, auto-task creation,
      // notifications, and history all fire through the canonical path
      resultRequest = await updateStatus(req.params.id, 'ASSIGNED', req.user, `Assigned by ${req.user.name}`);
    } else {
      // Status doesn't change — record the reassignment only
      await WorkflowHistory.create({
        legalRequest: request._id,
        oldStatus,
        newStatus:  oldStatus,
        oldHolder,
        newHolder:  oldHolder,
        changedBy:  req.user._id,
        comment:    `Reassigned by ${req.user.name}`,
        actionType: 'ASSIGNMENT_CHANGE',
      });
      resultRequest = await LegalRequest.findById(req.params.id)
        .populate('assignedTo', 'name email avatar')
        .populate('submittedBy', 'name email department')
        .populate('managerId', 'name email');
    }

    // Notify the new assignee if the assignment actually changed
    if (req.body.assignedTo !== prevAssigned) {
      const due = request.dueDate ? new Date(request.dueDate).toLocaleDateString('en-ZA') : 'TBD';
      Notification.create({
        recipient: req.body.assignedTo,
        type:      'general',
        title:     'Legal Request Assigned',
        message:   `${req.user.name} assigned you: "${request.title}". Due: ${due}`,
        priority:  request.priority === 'URGENT' ? 'high' : 'normal',
        relatedTo: { type: 'contract', id: request._id, label: request.title },
      }).catch(err => console.error('[assign notify]', err));
    }

    res.json({ request: resultRequest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/legal-requests/:id/override-due-date
router.put('/:id/override-due-date', protect, requireRole('admin', 'manager'), [
  body('dueDate').isISO8601().withMessage('Valid date required'),
  body('reason').notEmpty().withMessage('Reason required'),
], validate, async (req, res) => {
  try {
    const request = await LegalRequest.findByIdAndUpdate(
      req.params.id,
      { dueDate: new Date(req.body.dueDate), dueDateOverrideReason: req.body.reason },
      { new: true }
    );
    if (!request) return res.status(404).json({ error: 'Not found.' });

    await WorkflowHistory.create({
      legalRequest: request._id,
      oldStatus:    request.status,
      newStatus:    request.status,
      newHolder:    request.currentHolder,
      changedBy:    req.user._id,
      comment:      `Due date changed to ${new Date(req.body.dueDate).toLocaleDateString('en-ZA')}. Reason: ${req.body.reason}`,
      actionType:   'DUE_DATE_OVERRIDE',
    });

    res.json({ request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/legal-requests/:id — general field update
router.put('/:id', protect, async (req, res) => {
  try {
    const allowed = ['title', 'notes', 'contractValue', 'counterpartyName', 'priority', 'overdueReason', 'documentCategory', 'department'];
    const update  = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    }

    const request = await LegalRequest.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('assignedTo', 'name email')
      .populate('submittedBy', 'name email');
    if (!request) return res.status(404).json({ error: 'Not found.' });
    res.json({ request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/legal-requests/:id — admin only
router.delete('/:id', protect, requireRole('admin'), async (req, res) => {
  try {
    const request = await LegalRequest.findByIdAndDelete(req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found.' });
    await Promise.all([
      WorkflowHistory.deleteMany({ legalRequest: req.params.id }),
      Task.deleteMany({ legalRequest: req.params.id }),
    ]);
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
