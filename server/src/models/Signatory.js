'use strict';
const mongoose = require('mongoose');

const signatorySchema = new mongoose.Schema({
  signatureRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'SignatureRequest', required: true },
  legalRequest:     { type: mongoose.Schema.Types.ObjectId, ref: 'LegalRequest', required: true },

  // Internal user or external party
  user:             { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  externalName:     { type: String, trim: true },
  externalEmail:    { type: String, trim: true, lowercase: true },

  role:             { type: String, trim: true },  // e.g. "CEO", "CFO", "Witness"
  signingOrder:     { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['PENDING', 'EMAIL_SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'EXPIRED'],
    default: 'PENDING',
  },

  emailSentAt:  { type: Date },
  viewedAt:     { type: Date },
  signedAt:     { type: Date },
  declinedAt:   { type: Date },
  declineReason:{ type: String },

  signatureToken: { type: String, unique: true, sparse: true },
  ipAddress:      { type: String },
  userAgent:      { type: String },
}, { timestamps: true });

signatorySchema.index({ signatureRequest: 1, signingOrder: 1 });
signatorySchema.index({ legalRequest: 1 });
signatorySchema.index({ externalEmail: 1 });

module.exports = mongoose.model('Signatory', signatorySchema);
