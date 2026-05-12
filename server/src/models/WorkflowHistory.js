'use strict';
const mongoose = require('mongoose');

const workflowHistorySchema = new mongoose.Schema({
  legalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalRequest', required: true },
  oldStatus:    { type: String },
  newStatus:    { type: String, required: true },
  oldHolder:    { type: String },
  newHolder:    { type: String },
  changedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  comment:      { type: String },
  attachment:   { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  actionType: {
    type: String,
    enum: ['STATUS_CHANGE', 'ASSIGNMENT_CHANGE', 'DUE_DATE_OVERRIDE',
           'DOCUMENT_UPLOAD', 'SIGNATURE_EMAIL_SENT', 'COMMENT_ADDED',
           'TASK_COMPLETED', 'TASK_CREATED', 'SIGNATURE_COMPLETED'],
    default: 'STATUS_CHANGE',
  },
}, { timestamps: { createdAt: 'changedAt', updatedAt: false } });

workflowHistorySchema.index({ legalRequest: 1, changedAt: 1 });

module.exports = mongoose.model('WorkflowHistory', workflowHistorySchema);
