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

// GET /api/tasks
router.get('/', protect, async (req, res) => {
  try {
    const { status, assignedTo, assignedBy, contract, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (req.user.role === 'staff') {
      filter.$or = [{ assignedTo: req.user._id }, { assignedBy: req.user._id }];
    }
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (assignedBy) filter.assignedBy = assignedBy;
    if (contract) filter.contract = contract;

    const tasks = await Task.find(filter)
      .populate('assignedTo', 'name email avatar role')
      .populate('assignedBy', 'name email')
      .populate('contract', 'title contractId')
      .populate('attachments', 'name filename type')
      .sort({ deadline: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Task.countDocuments(filter);
    res.json({ tasks, total, page: parseInt(page), pages: Math.ceil(total / limit) });
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
  body('assignedTo').notEmpty().withMessage('Assignee required'),
  body('deadline').isISO8601().withMessage('Valid deadline required'),
], validate, async (req, res) => {
  try {
    const { title, description, contract, assignedTo, deadline, priority, type } = req.body;

    const assignee = await User.findById(assignedTo);
    if (!assignee) return res.status(404).json({ error: 'Assignee not found.' });

    const task = await Task.create({
      title, description, contract, assignedTo, deadline, priority, type,
      assignedBy: req.user._id,
      status: 'Pending',
    });

    await task.populate('assignedTo', 'name email');
    await task.populate('assignedBy', 'name email');

    // Notify assignee
    await Notification.create({
      recipient: assignedTo,
      type: 'task_assigned',
      title: 'New Task Assigned',
      message: `${req.user.name} assigned you: "${title}"`,
      relatedTo: { type: 'task', id: task._id, label: title },
    });

    // Email notification (async, non-blocking)
    if (assignee.notificationPreferences?.taskAssignment !== false) {
      emailService.sendTaskAssignment(assignee, task, req.user).catch(console.error);
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

    const isOwner = task.assignedTo.toString() === req.user._id.toString();
    const isManager = ['admin', 'manager'].includes(req.user.role);
    if (!isOwner && !isManager) return res.status(403).json({ error: 'Forbidden.' });

    const prevStatus = task.status;
    const { title, description, deadline, priority, status, progressNote } = req.body;

    if (title) task.title = title;
    if (description !== undefined) task.description = description;
    if (deadline) task.deadline = deadline;
    if (priority) task.priority = priority;
    if (progressNote !== undefined) task.progressNote = progressNote;

    if (status && status !== prevStatus) {
      task.status = status;
      task.statusHistory.push({ status, changedBy: req.user._id, changedAt: new Date() });
      if (status === 'Completed' && !task.completedAt) task.completedAt = new Date();

      // Notify assigner when task is completed
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
