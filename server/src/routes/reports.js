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

// GET /api/reports/summary — all analytics data in one request
router.get('/summary', protect, async (req, res) => {
  try {
    const { period = 'last6m' } = req.query;
    const now = new Date();
    const DAYS = { last30: 30, last90: 90, last6m: 180, thisYear: 365 };
    const days = DAYS[period] || 180;
    const periStart = new Date(now.getTime() - days * 86400000);
    const prevStart = new Date(now.getTime() - days * 2 * 86400000);
    const in30      = new Date(now.getTime() + 30 * 86400000);
    const in90      = new Date(now.getTime() + 90 * 86400000);
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const [byStatus, byType, byDept, monthlyRaw, expiringIn30, expiringIn90, currAgg, prevAgg, attention] =
      await Promise.all([
        Contract.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$value' } } },
          { $sort: { count: -1 } },
        ]),
        Contract.aggregate([
          { $group: { _id: '$type', count: { $sum: 1 }, value: { $sum: '$value' } } },
          { $sort: { count: -1 } },
        ]),
        Contract.aggregate([
          { $match: { department: { $exists: true, $ne: null, $ne: '' } } },
          { $group: { _id: '$department', count: { $sum: 1 }, value: { $sum: '$value' } } },
          { $sort: { value: -1 } },
        ]),
        Contract.aggregate([
          { $match: { createdAt: { $gte: new Date(now.getTime() - 180 * 86400000) } } },
          { $group: {
              _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
              created:  { $sum: 1 },
              executed: { $sum: { $cond: [{ $in: ['$status', ['Active']] }, 1, 0] } },
              expired:  { $sum: { $cond: [{ $eq: ['$status', 'Expired'] }, 1, 0] } },
          }},
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]),
        Contract.countDocuments({
          $or: [
            { endDate:    { $gte: now, $lte: in30 } },
            { expiryDate: { $gte: now, $lte: in30 } },
          ],
          status: { $nin: ['Terminated', 'Cancelled', 'Expired'] },
        }),
        Contract.countDocuments({
          $or: [
            { endDate:    { $gte: now, $lte: in90 } },
            { expiryDate: { $gte: now, $lte: in90 } },
          ],
          status: { $nin: ['Terminated', 'Cancelled', 'Expired'] },
        }),
        Contract.aggregate([
          { $match: { createdAt: { $gte: periStart } } },
          { $group: {
              _id: null,
              totalValue: { $sum: '$value' },
              count: { $sum: 1 },
              avgCycleMs: {
                $avg: { $cond: [{ $and: ['$startDate', '$createdAt'] }, { $subtract: ['$startDate', '$createdAt'] }, null] },
              },
          }},
        ]),
        Contract.aggregate([
          { $match: { createdAt: { $gte: prevStart, $lt: periStart } } },
          { $group: { _id: null, totalValue: { $sum: '$value' }, count: { $sum: 1 } } },
        ]),
        Contract.find({
          $or: [
            { status: 'Pending Signature' },
            { status: 'Pending Approval' },
            { endDate:    { $gte: now, $lte: new Date(now.getTime() + 60 * 86400000) } },
            { expiryDate: { $gte: now, $lte: new Date(now.getTime() + 60 * 86400000) } },
          ],
        })
          .populate('createdBy', 'name email')
          .sort({ endDate: 1, createdAt: -1 })
          .limit(10),
      ]);

    // Fill monthly slots for last 6 months
    const slots = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      slots[`${d.getFullYear()}-${d.getMonth()}`] = { month: MONTH_NAMES[d.getMonth()], created: 0, executed: 0, expired: 0 };
    }
    for (const m of monthlyRaw) {
      const k = `${m._id.year}-${m._id.month - 1}`;
      if (slots[k]) { slots[k].created = m.created; slots[k].executed = m.executed; slots[k].expired = m.expired; }
    }

    const curr = currAgg[0] || { totalValue: 0, count: 0, avgCycleMs: null };
    const prev = prevAgg[0] || { totalValue: 0, count: 0 };

    res.json({
      byStatus,
      byType,
      byDept,
      monthly: Object.values(slots),
      expiringIn30,
      expiringIn90,
      attention,
      kpis: {
        totalValue:     curr.totalValue,
        prevTotalValue: prev.totalValue,
        count:          curr.count,
        prevCount:      prev.count,
        avgCycleDays:   curr.avgCycleMs ? Math.round(curr.avgCycleMs / 86400000) : 0,
        activeCount:    (byStatus.find(s => s._id === 'Active') || {}).count || 0,
        expiringIn30,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
