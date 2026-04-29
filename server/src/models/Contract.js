const mongoose = require('mongoose');

const partySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String },
  role: { type: String }, // lender, borrower, vendor, client, etc.
  type: { type: String, enum: ['internal', 'external'], default: 'external' },
  signingOrder: { type: Number, default: 1 },
}, { _id: false });

const contractSchema = new mongoose.Schema({
  contractId: { type: String, unique: true },
  title: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ['MSA', 'NDA', 'SOW', 'License', 'MOA', 'MOI', 'SLA', 'Employment', 'Vendor', 'Lease', 'Other'],
    required: true,
  },
  status: {
    type: String,
    enum: ['Draft', 'Under Review', 'Pending Approval', 'Approved', 'Pending Signature', 'Active', 'Expired', 'Terminated', 'Cancelled'],
    default: 'Draft',
  },
  description: { type: String },
  value: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  parties: [partySchema],
  startDate: { type: Date },
  endDate: { type: Date },
  expiryDate: { type: Date },
  renewalDate: { type: Date },
  autoRenew: { type: Boolean, default: false },
  tags: [{ type: String }],
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium' },
  department: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  approvers: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    comment: { type: String },
    respondedAt: { type: Date },
  }],
  expiryAlertsSent: {
    thirtyDay: { type: Boolean, default: false },
    sevenDay: { type: Boolean, default: false },
    onDay: { type: Boolean, default: false },
  },
  isLocked: { type: Boolean, default: false },
  lockedPassword: { type: String, select: false },
  legalFolderPath: { type: String },
  templateUsed: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
}, { timestamps: true });

contractSchema.pre('save', function (next) {
  if (!this.contractId) {
    const year = new Date().getFullYear();
    const rand = Math.floor(Math.random() * 9000) + 1000;
    this.contractId = `CLM-${year}-${rand}`;
  }
  next();
});

module.exports = mongoose.model('Contract', contractSchema);
