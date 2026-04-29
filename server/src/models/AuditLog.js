const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true },
  category: {
    type: String,
    enum: ['auth', 'contract', 'task', 'document', 'signature', 'template', 'user', 'system'],
    required: true,
  },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  performedByEmail: { type: String },
  target: {
    type: { type: String },
    id: { type: mongoose.Schema.Types.ObjectId },
    label: { type: String },
  },
  metadata: { type: mongoose.Schema.Types.Mixed },
  ipAddress: { type: String },
  userAgent: { type: String },
  result: { type: String, enum: ['success', 'failure'], default: 'success' },
  errorMessage: { type: String },
}, { timestamps: true });

auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
