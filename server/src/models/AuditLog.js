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
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ 'target.id': 1, createdAt: -1 });

const IMMUTABLE_ERROR = 'AuditLog records are immutable and cannot be modified after creation.';

auditLogSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error(IMMUTABLE_ERROR));
  next();
});

auditLogSchema.pre(
  ['updateOne', 'findOneAndUpdate', 'updateMany', 'findOneAndReplace', 'replaceOne',
    'deleteOne', 'findOneAndDelete', 'deleteMany'],
  function (next) { next(new Error(IMMUTABLE_ERROR)); },
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
