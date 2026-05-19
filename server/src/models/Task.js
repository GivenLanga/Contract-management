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

const SOURCE_TYPES = [
  'LEGAL_TRACKER',
  'MANUAL_WORKFLOW',
  'SIGNATURE_FOLLOW_UP',
  'DOCUMENT_REVIEW',
  'GENERAL',
  'LEGAL_REQUEST', // TODO: Remove legacy LegalRequest source after data review.
];
const SYNC_STATUSES = ['SYNCED', 'SYNC_PENDING', 'SYNC_FAILED', 'CONFLICT', 'LOCAL_ONLY'];

const taskSchema = new mongoose.Schema({
  title:        { type: String, required: true, trim: true },
  description:  { type: String, trim: true },

  // Legacy contract link — preserved for existing tasks
  contract:     { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  // TODO: Remove legacy LegalRequest fields in a future database migration after data review.
  legalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalRequest' },

  // assignedTo is optional for MANUAL_WORKFLOW and LEGAL_TRACKER source tasks
  assignedTo:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deadline:     { type: Date },

  priority:     { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  status: {
    type: String,
    enum: ['Pending', 'In Progress', 'Blocked', 'Completed', 'Overdue', 'Cancelled'],
    default: 'Pending',
  },
  type: { type: String, enum: TASK_TYPES, default: 'Other' },

  // ── Workflow source tracking ───────────────────────────────────────────────────
  // Discriminates between tasks originating from the Legal Tracker spreadsheet,
  // manual workflow entries, documents, general work, or signature follow-ups.
  sourceType:    { type: String, enum: SOURCE_TYPES },

  // Stable dedup key for tracker-backed tasks: LEGAL_TRACKER::{id}::{sheet}::{row}
  trackerRowKey: { type: String, sparse: true },

  // JSON metadata from the Excel row (workbook name, sheet, row number, parties, etc.)
  // Never stores an absolute file path.
  trackerMeta:   { type: mongoose.Schema.Types.Mixed },

  // Excel write-back sync state for LEGAL_TRACKER tasks
  syncStatus:    { type: String, enum: SYNC_STATUSES },
  lastSyncedAt:  { type: Date },

  // workflowTaskId links MANUAL_WORKFLOW backend tasks to localStorage manual task
  workflowTaskId: { type: String },

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

taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ deadline: 1 });
taskSchema.index({ type: 1, status: 1 });
taskSchema.index({ trackerRowKey: 1 }, { sparse: true });
taskSchema.index({ sourceType: 1, status: 1 });

taskSchema.pre('save', function (next) {
  // Only set completedAt automatically; statusHistory is written explicitly by callers
  // so they can include changedBy. Pushing here as well would double-write every entry.
  if (this.isModified('status') && this.status === 'Completed' && !this.completedAt) {
    this.completedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Task', taskSchema);
