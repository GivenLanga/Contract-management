'use strict';
const mongoose = require('mongoose');

const TASK_TYPES = [
  // Legacy — kept for backward compatibility
  'Drafting', 'Review', 'Approval', 'Signing', 'Negotiation', 'Other',
  // Legal workflow task types
  'ASSIGN_REQUEST', 'INTAKE_REVIEW', 'LEGAL_REVIEW', 'DRAFT_DOCUMENT',
  'MANAGER_APPROVAL', 'REQUEST_REVISIONS', 'BUSINESS_INPUT', 'UPLOAD_DOCUMENT',
  'PREPARE_FOR_SIGNATURE', 'SEND_SIGNATURE_EMAIL', 'FOLLOW_UP_SIGNATURE',
  'STORE_SIGNED_DOCUMENT', 'CLOSE_REQUEST', 'RESOLVE_COMMENT', 'GENERAL_TASK',
];

const taskSchema = new mongoose.Schema({
  title:        { type: String, required: true, trim: true },
  description:  { type: String, trim: true },

  // Legacy contract link — preserved for existing tasks
  contract:     { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  // Legal Request link — the source of truth for workflow tasks
  legalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalRequest' },

  assignedTo:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deadline:     { type: Date, required: true },

  priority:     { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  status: {
    type: String,
    enum: ['Pending', 'In Progress', 'Blocked', 'Completed', 'Overdue', 'Cancelled'],
    default: 'Pending',
  },
  type: { type: String, enum: TASK_TYPES, default: 'Other' },

  completedAt:   { type: Date },
  completedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  blockedReason: { type: String },
  progressNote:  { type: String },

  attachments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],
  statusHistory: [{
    status:    { type: String },
    note:      { type: String },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

taskSchema.index({ legalRequest: 1 });
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ deadline: 1 });
taskSchema.index({ type: 1, status: 1 });

taskSchema.pre('save', function (next) {
  // Only set completedAt automatically; statusHistory is written explicitly by callers
  // so they can include changedBy. Pushing here as well would double-write every entry.
  if (this.isModified('status') && this.status === 'Completed' && !this.completedAt) {
    this.completedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Task', taskSchema);
