const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: [
      'task_assigned', 'task_completed', 'task_overdue',
      'document_uploaded', 'document_approved', 'document_rejected',
      'signing_request', 'signing_completed', 'signing_all_done',
      'contract_expiry_30', 'contract_expiry_7', 'contract_expiry_today',
      'comment_added', 'comment_resolved',
      'approval_request', 'approval_done',
      'general',
    ],
    required: true,
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  readAt: { type: Date },
  relatedTo: {
    type: { type: String, enum: ['contract', 'task', 'document', 'signature'] },
    id: { type: mongoose.Schema.Types.ObjectId },
    label: { type: String },
  },
  emailSent: { type: Boolean, default: false },
  priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
}, { timestamps: true });

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
