const mongoose = require('mongoose');

const signatureSchema = new mongoose.Schema({
  document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
  signedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  signerEmail: { type: String, required: true },
  signerName: { type: String, required: true },
  signerRole: { type: String }, // lender, borrower, witness, etc.
  signatureData: { type: String, required: true }, // base64 PNG
  initialsData: { type: String }, // base64 PNG for initials
  method: { type: String, enum: ['drawn', 'uploaded', 'typed'], default: 'drawn' },
  signatureImageHash: { type: String },
  initialsImageHash: { type: String },
  fieldId: { type: String },
  page: { type: Number },
  position: {
    x: { type: Number },
    y: { type: Number },
    width: { type: Number },
    height: { type: Number },
    origin: { type: String, enum: ['pdf', 'top-left', 'normalized'] },
  },
  signedAt: { type: Date, default: Date.now },
  ipAddress: { type: String },
  userAgent: { type: String },
  evidence: { type: mongoose.Schema.Types.Mixed },
  isValid: { type: Boolean, default: true },
  witnessedBy: { type: String },
  auditHash: { type: String },
}, { timestamps: true });

signatureSchema.pre('save', function (next) {
  const crypto = require('crypto');
  if (!this.signatureImageHash && this.signatureData) {
    this.signatureImageHash = crypto.createHash('sha256')
      .update(String(this.signatureData).replace(/^data:[^;]+;base64,/, ''))
      .digest('hex');
  }
  if (!this.initialsImageHash && this.initialsData) {
    this.initialsImageHash = crypto.createHash('sha256')
      .update(String(this.initialsData).replace(/^data:[^;]+;base64,/, ''))
      .digest('hex');
  }
  const payload = `${this.signerEmail}:${this.document}:${this.signedAt}:${this.signatureImageHash || ''}:${this.evidence?.strokeHash || ''}`;
  this.auditHash = crypto.createHash('sha256').update(payload).digest('hex');
  next();
});

module.exports = mongoose.model('Signature', signatureSchema);
