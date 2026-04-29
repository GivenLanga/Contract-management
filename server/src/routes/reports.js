const express = require('express');
const Task = require('../models/Task');
const Contract = require('../models/Contract');
const Document = require('../models/Document');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/reports/tasks — task completion report per user
router.get('/tasks', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { from, to, userId } = req.query;
    const filter = {};
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (userId) filter.assignedTo = userId;

    const tasks = await Task.find(filter)
      .populate('assignedTo', 'name email department')
      .populate('assignedBy', 'name email')
      .populate('contract', 'title contractId')
      .populate('attachments', 'name filename')
      .sort({ completedAt: -1, deadline: 1 });

    // Aggregate by user
    const byUser = {};
    for (const task of tasks) {
      const u = task.assignedTo;
      if (!u) continue;
      const uid = u._id.toString();
      if (!byUser[uid]) {
        byUser[uid] = {
          user: u,
          totalTasks: 0,
          completed: 0,
          inProgress: 0,
          overdue: 0,
          pending: 0,
          tasks: [],
        };
      }
      byUser[uid].totalTasks++;
      byUser[uid][task.status === 'Completed' ? 'completed'
        : task.status === 'In Progress' ? 'inProgress'
        : task.status === 'Overdue' ? 'overdue'
        : 'pending']++;
      byUser[uid].tasks.push(task);
    }

    res.json({ tasks, byUser: Object.values(byUser), total: tasks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/contracts — contract summary
router.get('/contracts', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const [total, byStatus, expiringIn30] = await Promise.all([
      Contract.countDocuments(),
      Contract.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$value' } } }]),
      Contract.countDocuments({
        expiryDate: { $lte: new Date(Date.now() + 30 * 86400000) },
        status: { $nin: ['Terminated', 'Cancelled', 'Expired'] },
      }),
    ]);
    res.json({ total, byStatus, expiringIn30 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/audit — audit log
router.get('/audit', protect, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { category, userId, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (userId) filter.performedBy = userId;

    const logs = await AuditLog.find(filter)
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await AuditLog.countDocuments(filter);
    res.json({ logs, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/kpis — dashboard KPIs
router.get('/kpis', protect, async (req, res) => {
  try {
    const [
      totalContracts, activeContracts, pendingTasks, completedTasksMonth,
      totalDocuments, signedDocuments, expiringContracts,
    ] = await Promise.all([
      Contract.countDocuments(),
      Contract.countDocuments({ status: 'Active' }),
      Task.countDocuments({ status: { $in: ['Pending', 'In Progress'] } }),
      Task.countDocuments({
        status: 'Completed',
        completedAt: { $gte: new Date(new Date().setDate(1)) },
      }),
      Document.countDocuments(),
      Document.countDocuments({ status: 'Signed' }),
      Contract.countDocuments({
        expiryDate: { $lte: new Date(Date.now() + 30 * 86400000) },
        status: { $nin: ['Terminated', 'Cancelled', 'Expired'] },
      }),
    ]);

    res.json({
      totalContracts, activeContracts, pendingTasks, completedTasksMonth,
      totalDocuments, signedDocuments, expiringContracts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
