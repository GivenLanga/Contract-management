'use strict';
const mongoose = require('mongoose');

const signatureRequestSchema = new mongoose.Schema({
  legalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalRequest', required: true },
  document:     { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },

  title:        { type: String, trim: true },
  message:      { type: String },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  status: {
    type: String,
    enum: ['DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'FULLY_SIGNED', 'EXPIRED', 'CANCELLED'],
    default: 'DRAFT',
  },

  sentAt:       { type: Date },
  expiresAt:    { type: Date },
  completedAt:  { type: Date },
}, { timestamps: true });

signatureRequestSchema.index({ legalRequest: 1 });
signatureRequestSchema.index({ status: 1 });

module.exports = mongoose.model('SignatureRequest', signatureRequestSchema);
