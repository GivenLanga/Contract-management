'use strict';
const mongoose = require('mongoose');

const quarterlyPlanItemSchema = new mongoose.Schema({
  quarterlyPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'QuarterlyPlan', required: true },

  title:         { type: String, required: true, trim: true },
  description:   { type: String },
  requestType:   { type: String },
  counterparty:  { type: String, trim: true },
  estimatedValue:{ type: Number },
  targetMonth:   { type: Number, min: 1, max: 12 },
  priority:      { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], default: 'MEDIUM' },
  assignedTo:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  status: {
    type: String,
    enum: ['PLANNED', 'SUBMITTED', 'IN_PROGRESS', 'COMPLETED', 'DEFERRED', 'CANCELLED'],
    default: 'PLANNED',
  },

  notes: { type: String },
}, { timestamps: true });

quarterlyPlanItemSchema.index({ quarterlyPlan: 1 });

module.exports = mongoose.model('QuarterlyPlanItem', quarterlyPlanItemSchema);
