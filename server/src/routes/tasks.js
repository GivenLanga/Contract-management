'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const Task = require('../models/Task');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const emailService = require('../services/emailService');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const LEGAL_TASK_TYPES = [
  'ASSIGN_REQUEST', 'INTAKE_REVIEW', 'LEGAL_REVIEW', 'DRAFT_DOCUMENT',
  'MANAGER_APPROVAL', 'REQUEST_REVISIONS', 'BUSINESS_INPUT', 'UPLOAD_DOCUMENT',
  'PREPARE_FOR_SIGNATURE', 'SEND_SIGNATURE_EMAIL', 'FOLLOW_UP_SIGNATURE',
  'STORE_SIGNED_DOCUMENT', 'CLOSE_REQUEST', 'RESOLVE_COMMENT', 'GENERAL_TASK',
];

// GET /api/tasks/stats — summary card counts for the Tasks dashboard
router.get('/stats', protect, async (req, res) => {
  try {
    const now      = new Date();
    const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const weekStart= new Date(now); weekStart.setDate(now.getDate() - 7);

    const openFilter = { status: { $nin: ['Completed', 'Cancelled'] } };
    const myFilter   = { ...openFilter, assignedTo: req.user._id };

    const [
      openTasks, teamDueToday, teamOverdue, unassignedTasks,
      trackerBackedTasks, manualWorkflowTasks,
      myOpenTasks, myDueToday, myOverdue, mySignatureFollowups,
      waitingForManager, businessInput, signatureFollowups, completedThisWeek,
    ] = await Promise.all([
      Task.countDocuments(openFilter),
      Task.countDocuments({ ...openFilter, deadline: { $gte: now, $lte: todayEnd } }),
      Task.countDocuments({ status: { $nin: ['Completed', 'Cancelled'] }, deadline: { $lt: now } }),
      Task.countDocuments({ ...openFilter, $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] }),
      Task.countDocuments({ ...openFilter, sourceType: 'LEGAL_TRACKER' }),
      Task.countDocuments({ ...openFilter, sourceType: 'MANUAL_WORKFLOW' }),
      Task.countDocuments(myFilter),
      Task.countDocuments({ ...myFilter, deadline: { $gte: now, $lte: todayEnd } }),
      Task.countDocuments({ assignedTo: req.user._id, status: { $nin: ['Completed', 'Cancelled'] }, deadline: { $lt: now } }),
      Task.countDocuments({ ...myFilter, type: { $in: ['FOLLOW_UP_SIGNATURE', 'SEND_SIGNATURE_EMAIL'] } }),
      Task.countDocuments({ ...openFilter, type: 'MANAGER_APPROVAL' }),
      Task.countDocuments({ ...openFilter, type: 'BUSINESS_INPUT' }),
      Task.countDocuments({ ...openFilter, type: { $in: ['FOLLOW_UP_SIGNATURE', 'SEND_SIGNATURE_EMAIL'] } }),
      Task.countDocuments({ assignedTo: req.user._id, status: 'Completed', completedAt: { $gte: weekStart } }),
    ]);

    res.json({
      openTasks,
      teamDueToday,
      teamOverdue,
      unassignedTasks,
      trackerBackedTasks,
      manualWorkflowTasks,
      myOpenTasks,
      myDueToday,
      myOverdue,
      mySignatureFollowups,
      waitingForManager,
      businessInput,
      signatureFollowups,
      completedThisWeek,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks
router.get('/', protect, async (req, res) => {
  try {
    const {
      status, assignedTo, assignedBy, contract,
      taskType, overdue, dueToday, sourceType, trackerRowKey,
      unassigned, excludeCompleted, workflowTasks, completedAfter,
      excludeUnassigned, sort: sortParam,
      page = 1, limit = 50,
    } = req.query;
    const filter = {};
    const now    = new Date();

    if (req.user.role === 'staff') {
      filter.$or = [{ assignedTo: req.user._id }, { assignedBy: req.user._id }];
    }

    if (status)          filter.status = status;
    if (assignedTo)      filter.assignedTo = assignedTo;
    if (assignedBy)      filter.assignedBy = assignedBy;
    if (contract)        filter.contract = contract;
    if (taskType)        filter.type = taskType;
    if (trackerRowKey)   filter.trackerRowKey = trackerRowKey;

    // workflowTasks=true filters both source types together; falls back to single sourceType
    if (workflowTasks === 'true') {
      filter.sourceType = { $in: ['LEGAL_TRACKER', 'MANUAL_WORKFLOW'] };
    } else if (sourceType) {
      filter.sourceType = sourceType;
    }

    if (excludeCompleted === 'true') {
      if (!filter.status) filter.status = { $nin: ['Completed', 'Cancelled'] };
    }

    // unassigned=true: show tasks with no assignee (manager-only tab in UI)
    if (unassigned === 'true') {
      filter.$or = [{ assignedTo: null }, { assignedTo: { $exists: false } }];
      if (!filter.status) filter.status = { $nin: ['Completed', 'Cancelled'] };
    }

    // excludeUnassigned=true: team tab — only show tasks that have an assignee
    if (excludeUnassigned === 'true') {
      filter.assignedTo = { $exists: true, $ne: null };
    }

    if (overdue === 'true') {
      filter.deadline = { $lt: now };
      if (!filter.status) filter.status = { $nin: ['Completed', 'Cancelled'] };
    }
    if (dueToday === 'true') {
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      filter.deadline = { $gte: now, $lte: end };
    }

    // completedAfter: date-range filter for Completed tab
    if (completedAfter) {
      filter.completedAt = { $gte: new Date(completedAfter) };
    }

    const sortOrder = sortParam === 'completedAt_desc' ? { completedAt: -1 } : { deadline: 1 };

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate('assignedTo', 'name email avatar role')
        .populate('assignedBy', 'name email')
        .populate('contract', 'title contractId')
        .populate('attachments', 'name filename type')
        .sort(sortOrder)
        .skip((page - 1) * parseInt(limit))
        .limit(parseInt(limit)),
      Task.countDocuments(filter),
    ]);

    res.json({ tasks, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('assignedTo', 'name email avatar role department')
      .populate('assignedBy', 'name email')
      .populate('contract', 'title contractId type')
      .populate('attachments')
      .populate('statusHistory.changedBy', 'name');
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks (managers only)
router.post('/', protect, requireRole('admin', 'manager'), [
  body('title').trim().notEmpty().withMessage('Title required'),
  body('assignedTo').custom((value, { req: r }) => {
    const noAssigneeOk = ['MANUAL_WORKFLOW', 'LEGAL_TRACKER'].includes(r.body.sourceType);
    if (!value && !noAssigneeOk) throw new Error('Assignee required');
    return true;
  }),
  body('deadline').optional({ nullable: true }).isISO8601().withMessage('Valid deadline required'),
], validate, async (req, res) => {
  try {
    const {
      title, description, contract, assignedTo, deadline, priority, type,
      sourceType, trackerRowKey, trackerMeta, syncStatus, workflowTaskId,
    } = req.body;

    let assignee = null;
    if (assignedTo) {
      assignee = await User.findById(assignedTo);
      if (!assignee) return res.status(404).json({ error: 'Assignee not found.' });
    }

    const taskData = {
      title, description, contract, assignedTo: assignedTo || undefined,
      deadline: deadline || undefined, priority, type,
      assignedBy: req.user._id,
      status: 'Pending',
    };
    if (sourceType)      taskData.sourceType = sourceType;
    if (trackerRowKey)   taskData.trackerRowKey = trackerRowKey;
    if (trackerMeta)     taskData.trackerMeta = trackerMeta;
    if (syncStatus)      taskData.syncStatus = syncStatus;
    if (workflowTaskId)  taskData.workflowTaskId = workflowTaskId;

    const task = await Task.create(taskData);

    await task.populate('assignedTo', 'name email');
    await task.populate('assignedBy', 'name email');

    if (assignedTo && assignee) {
      await Notification.create({
        recipient: assignedTo,
        type: 'task_assigned',
        title: 'New Task Assigned',
        message: `${req.user.name} assigned you: "${title}"`,
        relatedTo: { type: 'task', id: task._id, label: title },
      });

      if (assignee.notificationPreferences?.taskAssignment !== false) {
        emailService.sendTaskAssignment(assignee, task, req.user).catch(console.error);
      }
    }

    await AuditLog.create({
      action: `Task created: ${title}`,
      category: 'task',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      target: { type: 'task', id: task._id, label: title },
    });

    res.status(201).json({ task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tasks/:id
router.put('/:id', protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const isOwner   = task.assignedTo?.toString() === req.user._id.toString();
    const isManager = ['admin', 'manager'].includes(req.user.role);
    if (!isOwner && !isManager) return res.status(403).json({ error: 'Forbidden.' });

    const prevStatus = task.status;
    const {
      title, description, deadline, priority, status, progressNote, blockedReason,
      syncStatus, lastSyncedAt, trackerMeta, assignedTo,
    } = req.body;

    if (title)                       task.title = title;
    if (description !== undefined)   task.description = description;
    if (deadline)                    task.deadline = deadline;
    if (priority)                    task.priority = priority;
    if (progressNote !== undefined)  task.progressNote = progressNote;
    if (blockedReason !== undefined) task.blockedReason = blockedReason;
    if (syncStatus !== undefined)    task.syncStatus = syncStatus;
    if (lastSyncedAt !== undefined)  task.lastSyncedAt = lastSyncedAt;
    if (trackerMeta !== undefined)   task.trackerMeta = trackerMeta;

    if (assignedTo !== undefined) {
      let newAssignee = null;
      if (assignedTo) {
        newAssignee = await User.findById(assignedTo);
        if (!newAssignee) return res.status(404).json({ error: 'Assignee not found.' });
      }
      const prevAssigneeId = task.assignedTo?.toString();
      task.assignedTo = assignedTo || undefined;
      if (assignedTo && newAssignee && assignedTo.toString() !== prevAssigneeId) {
        await Notification.create({
          recipient: assignedTo,
          type: 'task_assigned',
          title: 'Task Assigned',
          message: `${req.user.name} assigned you: "${task.title}"`,
          relatedTo: { type: 'task', id: task._id, label: task.title },
        });
        if (newAssignee.notificationPreferences?.taskAssignment !== false) {
          emailService.sendTaskAssignment(newAssignee, task, req.user).catch(console.error);
        }
      }
    }

    if (status && status !== prevStatus) {
      task.status = status;
      task.statusHistory.push({ status, changedBy: req.user._id, changedAt: new Date() });
      if (status === 'Completed') {
        if (!task.completedAt) task.completedAt = new Date();
        task.completedBy = req.user._id;
      }

      if (status === 'Completed' && task.assignedBy) {
        const [manager, assignee] = await Promise.all([
          User.findById(task.assignedBy),
          User.findById(task.assignedTo),
        ]);
        if (manager) {
          await Notification.create({
            recipient: task.assignedBy,
            type: 'task_completed',
            title: 'Task Completed',
            message: `${assignee?.name || 'User'} completed: "${task.title}"`,
            relatedTo: { type: 'task', id: task._id, label: task.title },
          });
          if (manager.notificationPreferences?.taskCompletion !== false) {
            emailService.sendTaskCompletion(manager, task, assignee || req.user).catch(console.error);
          }
        }
      }
    }

    await task.save();
    await task.populate('assignedTo', 'name email avatar');
    await task.populate('assignedBy', 'name email');

    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json({ message: 'Task deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
