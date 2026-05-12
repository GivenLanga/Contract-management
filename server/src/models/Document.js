const mongoose = require('mongoose');
const crypto = require('crypto');

const documentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  originalName: { type: String, required: true },
  filename: { type: String, required: true },
  path: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number },
  type: { type: String, enum: ['pdf', 'docx', 'doc', 'other'], default: 'pdf' },
  contract:     { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  task:         { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
  legalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalRequest' },
  documentStage: {
    type: String,
    enum: ['SUPPORTING', 'DRAFT', 'FINAL', 'SIGNATURE_READY', 'SIGNED', 'OTHER'],
    default: 'OTHER',
  },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['Draft', 'Under Review', 'Approved', 'Rejected', 'Pending Signature', 'Signed', 'Archived', 'Declined'],
    default: 'Draft',
  },
  version: { type: Number, default: 1 },
  parentDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  isInLegalFolder: { type: Boolean, default: false },
  legalFolderPath: { type: String },
  isLocked: { type: Boolean, default: false },
  lockedPassword: { type: String, select: false },
  lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lockedAt: { type: Date },
  distributedTo: [{
    email: { type: String },
    name: { type: String },
    type: { type: String, enum: ['internal', 'external'] },
    sentAt: { type: Date, default: Date.now },
  }],
  signers: [{
    email: { type: String },
    name: { type: String },
    role: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    order: { type: Number },
    authMethod: { type: String, default: 'email' },
    token: { type: String }, // legacy plaintext token, migrated to tokenHash on first use
    tokenHash: { type: String },
    tokenIssuedAt: { type: Date },
    tokenExpiresAt: { type: Date },
    authCodeHash: { type: String },
    authCodeExpiresAt: { type: Date },
    authCodeAttempts: { type: Number, default: 0 },
    authCodeLastSentAt: { type: Date },
    authTotalFailedAttempts: { type: Number, default: 0 },
    authLockedUntil: { type: Date },
    authVerifiedAt: { type: Date },
    authSessionHash: { type: String },
    authSessionExpiresAt: { type: Date },
    signingStatus: { type: String, enum: ['not_signed', 'signed', 'rejected', 'declined'], default: 'not_signed' },
    sentAt: { type: Date },
    viewedAt: { type: Date },
    signedAt: { type: Date },
    declinedAt: { type: Date },
    rejectionReason: { type: String },
    lastReminderAt: { type: Date },
  }],
  signingOrder: { type: String, enum: ['parallel', 'sequential'], default: 'parallel' },
  signingEvidence: {
    mode: {
      type: String,
      enum: ['standard', 'photo', 'video', 'ron'],
      default: 'standard',
    },
    requirePhoto: { type: Boolean, default: false },
    requireVideo: { type: Boolean, default: false },
    requireAudio: { type: Boolean, default: false },
    ronRequested: { type: Boolean, default: false },
    ron: {
      providerModel: { type: String },
      identityMethod: { type: String },
      notary: {
        name: { type: String },
        email: { type: String },
        commissionState: { type: String },  // Legacy / non-SA jurisdictions
        commissionNumber: { type: String },
        commissionExpiresAt: { type: String },
        county: { type: String },           // Legacy / non-SA jurisdictions
        province: { type: String },         // SA: High Court province code (GP, WC, KZN…)
        admissionNumber: { type: String },  // SA: High Court admission number
        venue: { type: String },            // SA: Notarial venue / city
      },
      notaryStamp: { type: mongoose.Schema.Types.Mixed }, // Uploaded stamp image metadata
      requirements: { type: mongoose.Schema.Types.Mixed },
      session: { type: mongoose.Schema.Types.Mixed },
      identity: { type: mongoose.Schema.Types.Mixed },
      journal: { type: mongoose.Schema.Types.Mixed },
      seal: { type: mongoose.Schema.Types.Mixed },
    },
    scheduledAt: { type: Date },           // Session scheduled time (null = immediate)
    saDocumentType: { type: String },      // SA: ANC, POA, affidavit, transcript, property, other
    apostilleRequired: { type: Boolean, default: false },
    apostilleStatus: {
      type: String,
      enum: ['not_required', 'pending', 'submitted', 'received'],
      default: 'not_required',
    },
    configuredAt: { type: Date },
    configuredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  signingFields: [{
    id: { type: String },
    type: { type: String, enum: ['signature', 'initials', 'date', 'text', 'number', 'checkbox', 'radio', 'dropdown'] },
    fieldMeta: { type: mongoose.Schema.Types.Mixed }, // per-type options (dropdown choices, checkbox value, etc.)
    page: { type: Number },
    x: { type: Number },
    y: { type: Number },
    width: { type: Number },
    height: { type: Number },
    coordinateOrigin: { type: String, enum: ['pdf', 'top-left', 'normalized'], default: 'normalized' },
    fieldValue: { type: mongoose.Schema.Types.Mixed },
    assignedTo: { type: String }, // email
    role: { type: String },
    required: { type: Boolean, default: true },
    filled: { type: Boolean, default: false },
    filledBy: { type: String },
    filledAt: { type: Date },
    source: {
      type: String,
      enum: ['anchor', 'yolo-cv', 'layoutlmv3', 'textract', 'opencv-ocr', 'heuristic-keyword', 'heuristic-default', 'manual'],
      default: 'manual',
    },
    confidence: { type: Number, default: 1 },
    anchor: { type: String },
    context: { type: String },
    detection: { type: mongoose.Schema.Types.Mixed },
  }],
  signingPreparation: {
    status: {
      type: String,
      enum: ['not_started', 'prepared', 'needs_review', 'failed'],
      default: 'not_started',
    },
    preparedAt: { type: Date },
    preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    detectionVersion: { type: String },
    strategy: { type: mongoose.Schema.Types.Mixed },
    diagnostics: { type: mongoose.Schema.Types.Mixed },
    pageMetrics: { type: mongoose.Schema.Types.Mixed },
    sourceFileHash: { type: String },
    reviewRequired: { type: Boolean, default: false },
    fieldsHash: { type: String },
    errorMessage: { type: String },
  },
  finalization: {
    status: {
      type: String,
      enum: ['not_started', 'finalized', 'failed'],
      default: 'not_started',
    },
    finalizedAt: { type: Date },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    finalizedFilename: { type: String },
    finalizedPath: { type: String },
    flattenedHash: { type: String },
    finalPdfHash: { type: String },
    byteLength: { type: Number },
    digitalSignatureStatus: { type: String, enum: ['signed', 'skipped', 'failed'] },
    certificateFingerprint: { type: String },
    signatureStandard: { type: String },
    errorMessage: { type: String },
    certificatePath: { type: String },
    certificateHash: { type: String },
  },
  tags: [{ type: String }],
  description: { type: String },
}, { timestamps: true });

documentSchema.methods.setPassword = function (password) {
  const key = process.env.ENCRYPTION_KEY || 'default-32-char-key-please-change';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc',
    Buffer.from(key.padEnd(32).slice(0, 32)),
    iv
  );
  const encrypted = cipher.update(password, 'utf8', 'hex') + cipher.final('hex');
  // Format: <32-char iv hex>:<ciphertext hex>
  this.lockedPassword = `${iv.toString('hex')}:${encrypted}`;
  this.isLocked = true;
};

documentSchema.methods.verifyPassword = function (password) {
  const key = process.env.ENCRYPTION_KEY || 'default-32-char-key-please-change';
  try {
    const stored = String(this.lockedPassword || '');
    let iv;
    let encrypted;
    // New format: <32-hex IV>:<ciphertext>
    if (stored.length > 33 && stored[32] === ':') {
      iv = Buffer.from(stored.slice(0, 32), 'hex');
      encrypted = stored.slice(33);
    } else {
      // Legacy format (zero IV) — still supported for existing records until re-set
      iv = Buffer.alloc(16, 0);
      encrypted = stored;
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc',
      Buffer.from(key.padEnd(32).slice(0, 32)),
      iv
    );
    const decrypted = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
    return decrypted === password;
  } catch {
    return false;
  }
};

module.exports = mongoose.model('Document', documentSchema);
