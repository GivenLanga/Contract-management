'use strict';
const mongoose = require('mongoose');

const ALL_STATUSES = [
  'SUBMITTED', 'INTAKE_REVIEW', 'ASSIGNED', 'IN_LEGAL_REVIEW',
  'INTERNAL_LEGAL_REVIEW', 'SENT_TO_EXTERNAL_PARTY', 'WAITING_FOR_EXTERNAL_PARTY',
  'EXTERNAL_FEEDBACK_RECEIVED', 'NEGOTIATION_AMENDMENTS', 'WITH_BUSINESS_DEPARTMENT',
  'WITH_MANAGER', 'REVISIONS_REQUIRED', 'MANAGER_APPROVED', 'APPROVED',
  'READY_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED', 'FULLY_SIGNED',
  'STORED', 'FINALIZED', 'CLOSED', 'ON_HOLD', 'CANCELLED',
];

const REQUEST_TYPES = [
  'INTERNAL_DOCUMENT', 'EXTERNAL_CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT',
  'SERVICE_PROVIDER_AGREEMENT', 'NDA', 'LEASE_AGREEMENT', 'SOFTWARE_LICENSE',
  'COMPLIANCE_DOCUMENT', 'PARTNERSHIP_MOU', 'COLLECTIONS_RECOVERY', 'OTHER',
];

const legalRequestSchema = new mongoose.Schema({
  requestId: { type: String, unique: true, sparse: true },

  title:               { type: String, required: true, trim: true },
  requestType:         { type: String, enum: REQUEST_TYPES, required: true },
  documentCategory:    { type: String, trim: true },
  internalOrExternal:  { type: String, enum: ['INTERNAL', 'EXTERNAL'], required: true },

  submittedAt:          { type: Date, default: Date.now },
  dueDate:              { type: Date },
  targetDate:           { type: Date },   // auto-calculated original; preserved when manager overrides dueDate
  dueDateOverrideReason:{ type: String },
  completedAt:          { type: Date },
  lastStatusChangeAt:   { type: Date, default: Date.now },

  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  department:  { type: String, trim: true },
  assignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  managerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  status: { type: String, enum: ALL_STATUSES, default: 'SUBMITTED' },
  currentHolder: {
    type: String,
    enum: ['LEGAL_MANAGER', 'LEGAL_TEAM_MEMBER', 'BUSINESS_DEPARTMENT',
           'EXTERNAL_PARTY', 'SIGNATORIES', 'SYSTEM_ADMIN', 'NONE'],
    default: 'LEGAL_MANAGER',
  },
  nextAction:      { type: String },
  escalationLevel: { type: Number, default: 0 },

  priority:       { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], default: 'MEDIUM' },
  contractValue:  { type: Number },
  currency:       { type: String, default: 'ZAR' },
  counterpartyName: { type: String, trim: true },

  reasonForRequest: { type: String },
  notes:            { type: String },
  overdueReason:    { type: String },

  // SLA day counters — updated automatically on each status transition
  legalWorkingDays:     { type: Number, default: 0 },
  externalDelayDays:    { type: Number, default: 0 },
  businessWaitingDays:  { type: Number, default: 0 },
  signatureWaitingDays: { type: Number, default: 0 },
  totalElapsedDays:     { type: Number, default: 0 },

  // Signature tracking
  businessOwnerId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  signatureRequestedAt:      { type: Date },
  signatureEmailSentAt:      { type: Date },
  fullySignedAt:             { type: Date },
  pendingSignatoriesCount:   { type: Number, default: 0 },
  completedSignatoriesCount: { type: Number, default: 0 },
  isFullySigned:             { type: Boolean, default: false },

  linkedContract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  attachments:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],
}, { timestamps: true });

legalRequestSchema.pre('save', async function () {
  if (!this.requestId) {
    const year = new Date().getFullYear();
    let attempts = 0;
    while (attempts < 10) {
      const rand = Math.floor(Math.random() * 90000) + 10000;
      const candidate = `LR-${year}-${rand}`;
      // eslint-disable-next-line no-await-in-loop
      const clash = await mongoose.model('LegalRequest').findOne({ requestId: candidate }).lean();
      if (!clash) { this.requestId = candidate; return; }
      attempts++;
    }
    throw new Error('Could not generate a unique requestId after 10 attempts');
  }
});

legalRequestSchema.index({ status: 1, dueDate: 1 });
legalRequestSchema.index({ assignedTo: 1, status: 1 });
legalRequestSchema.index({ internalOrExternal: 1 });
legalRequestSchema.index({ submittedBy: 1 });
legalRequestSchema.index({ lastStatusChangeAt: 1 });

module.exports = mongoose.model('LegalRequest', legalRequestSchema);
