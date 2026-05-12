const mongoose = require('mongoose');
const crypto = require('crypto');
const { stableJson } = require('../utils/stableJson');

const computeImageHash = (dataUri) =>
  crypto.createHash('sha256')
    .update(String(dataUri || '').replace(/^data:[^;]+;base64,/, ''))
    .digest('hex');

const computeSignatureAuditHash = (signature) => {
  const payload = {
    version: 2,
    document: String(signature.document || ''),
    signerEmail: String(signature.signerEmail || '').toLowerCase().trim(),
    signerName: signature.signerName || '',
    signerRole: signature.signerRole || '',
    signedAt: signature.signedAt instanceof Date
      ? signature.signedAt.toISOString()
      : String(signature.signedAt || ''),
    method: signature.method || '',
    fieldId: signature.fieldId || '',
    page: signature.page || '',
    position: signature.position || null,
    signatureImageHash: signature.signatureImageHash || computeImageHash(signature.signatureData),
    initialsImageHash: signature.initialsImageHash || (signature.initialsData ? computeImageHash(signature.initialsData) : ''),
    ipAddress: signature.ipAddress || '',
    userAgent: signature.userAgent || '',
    evidence: signature.evidence || null,
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
};

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
  idempotencyKey: { type: String },
  isValid: { type: Boolean, default: true },
  witnessedBy: { type: String },
  auditHash: { type: String },
}, { timestamps: true });

signatureSchema.pre('save', function (next) {
  this.signerEmail = String(this.signerEmail || '').toLowerCase().trim();
  if (!this.signatureImageHash && this.signatureData) {
    this.signatureImageHash = computeImageHash(this.signatureData);
  }
  if (!this.initialsImageHash && this.initialsData) {
    this.initialsImageHash = computeImageHash(this.initialsData);
  }
  if (!this.auditHash) this.auditHash = computeSignatureAuditHash(this);
  next();
});

signatureSchema.index({ document: 1, signerEmail: 1 }, { unique: true });
signatureSchema.index({ document: 1, signerEmail: 1, idempotencyKey: 1 }, { sparse: true });
signatureSchema.statics.computeAuditHash = computeSignatureAuditHash;

module.exports = mongoose.model('Signature', signatureSchema);
