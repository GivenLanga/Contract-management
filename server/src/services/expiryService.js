const cron = require('node-cron');
const Contract = require('../models/Contract');
const User = require('../models/User');
const Notification = require('../models/Notification');
const emailService = require('./emailService');

const checkExpiry = async () => {
  console.log('[ExpiryService] Running contract expiry check...');
  const now = new Date();

  const thirtyDaysOut = new Date(now);
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const sevenDaysOut = new Date(now);
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);

  const todayStart = new Date(now.setHours(0, 0, 0, 0));
  const todayEnd = new Date(now.setHours(23, 59, 59, 999));

  const contracts = await Contract.find({
    status: { $nin: ['Terminated', 'Cancelled', 'Expired'] },
    expiryDate: { $exists: true, $ne: null },
  }).populate('createdBy assignedTo', 'name email notificationPreferences');

  for (const contract of contracts) {
    const expiry = new Date(contract.expiryDate);
    const recipients = [contract.createdBy, ...contract.assignedTo].filter(Boolean);

    // 30-day alert
    if (!contract.expiryAlertsSent.thirtyDay && expiry <= thirtyDaysOut && expiry > sevenDaysOut) {
      for (const user of recipients) {
        if (user?.email && user?.notificationPreferences?.contractExpiry !== false) {
          await emailService.sendExpiryAlert(user, contract, 30);
          await Notification.create({
            recipient: user._id,
            type: 'contract_expiry_30',
            title: 'Contract Expiring in 30 Days',
            message: `"${contract.title}" expires on ${expiry.toLocaleDateString()}.`,
            priority: 'normal',
            relatedTo: { type: 'contract', id: contract._id, label: contract.title },
          });
        }
      }
      await Contract.findByIdAndUpdate(contract._id, { 'expiryAlertsSent.thirtyDay': true });
      console.log(`[ExpiryService] 30-day alert sent for: ${contract.title}`);
    }

    // 7-day alert
    if (!contract.expiryAlertsSent.sevenDay && expiry <= sevenDaysOut && expiry >= todayStart) {
      for (const user of recipients) {
        if (user?.email && user?.notificationPreferences?.contractExpiry !== false) {
          await emailService.sendExpiryAlert(user, contract, 7);
          await Notification.create({
            recipient: user._id,
            type: 'contract_expiry_7',
            title: 'Contract Expiring in 7 Days',
            message: `"${contract.title}" expires on ${expiry.toLocaleDateString()}. Action required.`,
            priority: 'high',
            relatedTo: { type: 'contract', id: contract._id, label: contract.title },
          });
        }
      }
      await Contract.findByIdAndUpdate(contract._id, { 'expiryAlertsSent.sevenDay': true });
      console.log(`[ExpiryService] 7-day alert sent for: ${contract.title}`);
    }

    // Expiry day alert
    if (!contract.expiryAlertsSent.onDay && expiry >= todayStart && expiry <= todayEnd) {
      for (const user of recipients) {
        if (user?.email && user?.notificationPreferences?.contractExpiry !== false) {
          await emailService.sendExpiryAlert(user, contract, 0);
          await Notification.create({
            recipient: user._id,
            type: 'contract_expiry_today',
            title: 'Contract Expired Today',
            message: `"${contract.title}" has expired today.`,
            priority: 'high',
            relatedTo: { type: 'contract', id: contract._id, label: contract.title },
          });
        }
      }
      await Contract.findByIdAndUpdate(contract._id, {
        'expiryAlertsSent.onDay': true,
        status: 'Expired',
      });
      console.log(`[ExpiryService] Expiry-day alert sent for: ${contract.title}`);
    }
  }

  console.log(`[ExpiryService] Check complete. Processed ${contracts.length} contracts.`);
};

// Run daily at 9:00 AM
cron.schedule('0 9 * * *', () => {
  checkExpiry().catch((err) => console.error('[ExpiryService] Error:', err.message));
});

// Also run on startup (after a 10s delay to ensure DB is connected)
setTimeout(() => {
  checkExpiry().catch((err) => console.error('[ExpiryService] Startup check error:', err.message));
}, 10000);

module.exports = { checkExpiry };
