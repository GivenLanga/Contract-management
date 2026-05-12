const mongoose = require('mongoose');
const crypto = require('crypto');

const ronJournalEntrySchema = new mongoose.Schema({
  document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
  event: { type: String, required: true },
  actorEmail: { type: String },
  signerEmail: { type: String },
  status: { type: String },
  recordingHash: { type: String },
  at: { type: Date, required: true },
  previousHash: { type: String, required: true },
  entryHash: { type: String, required: true },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

ronJournalEntrySchema.index({ document: 1, at: 1 });

const computeEntryHash = (entry, previousHash) => {
  const payload = [
    String(entry.document || ''),
    String(entry.event || ''),
    String(entry.actorEmail || ''),
    String(entry.signerEmail || ''),
    String(entry.status || ''),
    String(entry.recordingHash || ''),
    entry.at instanceof Date ? entry.at.toISOString() : String(entry.at || ''),
    String(previousHash || ''),
  ].join(':');
  return crypto.createHash('sha256').update(payload).digest('hex');
};

ronJournalEntrySchema.statics.appendEntry = async function (data) {
  const last = await this.findOne({ document: data.document }).sort({ at: -1 }).lean();
  const previousHash = last ? (last.entryHash || '') : '';
  const at = data.at instanceof Date ? data.at : new Date(data.at || Date.now());
  const entryHash = computeEntryHash({ ...data, at }, previousHash);
  return this.create({ ...data, at, previousHash, entryHash });
};

ronJournalEntrySchema.statics.verifyChain = async function (documentId) {
  const entries = await this.find({ document: documentId }).sort({ at: 1 }).lean();
  let expectedPrev = '';
  for (const entry of entries) {
    if (entry.previousHash !== expectedPrev) return { valid: false, brokenAt: entry._id };
    const recomputed = computeEntryHash(entry, entry.previousHash);
    if (recomputed !== entry.entryHash) return { valid: false, brokenAt: entry._id };
    expectedPrev = entry.entryHash;
  }
  return { valid: true, entryCount: entries.length };
};

const IMMUTABLE_ERROR = 'RonJournalEntry records are immutable.';

ronJournalEntrySchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error(IMMUTABLE_ERROR));
  next();
});

ronJournalEntrySchema.pre(
  ['updateOne', 'findOneAndUpdate', 'updateMany', 'findOneAndReplace', 'replaceOne',
    'deleteOne', 'findOneAndDelete', 'deleteMany'],
  function (next) { next(new Error(IMMUTABLE_ERROR)); },
);

module.exports = mongoose.model('RonJournalEntry', ronJournalEntrySchema);
