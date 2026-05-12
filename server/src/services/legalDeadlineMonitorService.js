'use strict';
const LegalRequest = require('../models/LegalRequest');
const Notification = require('../models/Notification');

async function runDeadlineMonitor() {
  const now   = new Date();
  const in48h = new Date(now.getTime() + 48 * 3600 * 1000);
  const active    = { $nin: ['CLOSED', 'CANCELLED', 'FULLY_SIGNED', 'STORED', 'FINALIZED'] };

  const [overdue, dueSoon, noUpdate] = await Promise.all([
    LegalRequest.find({ status: active, dueDate: { $lt: now } })
      .populate('assignedTo', 'name')
      .populate('managerId', 'name')
      .select('title requestId dueDate assignedTo managerId priority'),
    LegalRequest.find({ status: active, dueDate: { $gte: now, $lte: in48h } })
      .populate('assignedTo', 'name')
      .populate('managerId', 'name')
      .select('title requestId dueDate assignedTo managerId priority'),
    LegalRequest.find({
      status: active,
      lastStatusChangeAt: { $lt: new Date(now.getTime() - 3 * 86400000) },
    })
      .populate('assignedTo', 'name')
      .populate('managerId', 'name')
      .select('title requestId lastStatusChangeAt assignedTo managerId priority'),
  ]);

  const results = { overdue: overdue.length, dueSoon: dueSoon.length, noUpdate: noUpdate.length, notificationsSent: 0 };

  const dedupeWindow = new Date(now.getTime() - 20 * 3600 * 1000);

  async function notify(recipientId, title, message, relatedId, relatedLabel, priority = 'normal') {
    if (!recipientId) return;
    const recent = await Notification.findOne({
      recipient: recipientId,
      title,
      'relatedTo.id': relatedId,
      createdAt: { $gte: dedupeWindow },
    });
    if (recent) return;
    await Notification.create({
      recipient: recipientId,
      type: 'general',
      title,
      message,
      priority,
      relatedTo: { type: 'contract', id: relatedId, label: relatedLabel },
    });
    results.notificationsSent++;
  }

  for (const r of overdue) {
    const overdueDays = Math.ceil((now - new Date(r.dueDate)) / 86400000);
    const pri = r.priority === 'URGENT' ? 'high' : 'normal';
    await notify(r.assignedTo?._id, 'Legal Request Overdue',
      `"${r.title}" (${r.requestId}) is overdue by ${overdueDays} day(s). Please action immediately.`,
      r._id, r.title, pri);
    await notify(r.managerId?._id, 'Legal Request Overdue',
      `"${r.title}" (${r.requestId}) is overdue by ${overdueDays} day(s).`,
      r._id, r.title, pri);
  }

  for (const r of dueSoon) {
    const hoursLeft = Math.ceil((new Date(r.dueDate) - now) / 3600000);
    await notify(r.assignedTo?._id, 'Due Soon',
      `"${r.title}" (${r.requestId}) is due in ${hoursLeft} hour(s).`,
      r._id, r.title);
    await notify(r.managerId?._id, 'Due Soon',
      `"${r.title}" (${r.requestId}) is due in ${hoursLeft} hour(s).`,
      r._id, r.title);
  }

  for (const r of noUpdate) {
    const staleDays = Math.ceil((now - new Date(r.lastStatusChangeAt)) / 86400000);
    await notify(r.managerId?._id, 'Legal Request — No Update',
      `"${r.title}" (${r.requestId}) has had no status update for ${staleDays} day(s).`,
      r._id, r.title);
  }

  return results;
}

module.exports = { runDeadlineMonitor };
