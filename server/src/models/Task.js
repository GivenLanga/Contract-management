const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deadline: { type: Date, required: true },
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  status: {
    type: String,
    enum: ['Pending', 'In Progress', 'Completed', 'Overdue', 'Cancelled'],
    default: 'Pending',
  },
  type: {
    type: String,
    enum: ['Drafting', 'Review', 'Approval', 'Signing', 'Negotiation', 'Other'],
    default: 'Other',
  },
  completedAt: { type: Date },
  progressNote: { type: String },
  attachments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],
  statusHistory: [{
    status: { type: String },
    note: { type: String },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

taskSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    this.statusHistory.push({
      status: this.status,
      changedAt: new Date(),
    });
    if (this.status === 'Completed' && !this.completedAt) {
      this.completedAt = new Date();
    }
  }
  next();
});

module.exports = mongoose.model('Task', taskSchema);
