'use strict';
const mongoose = require('mongoose');

const quarterlyPlanSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  year:        { type: Number, required: true },
  quarter:     { type: Number, required: true, min: 1, max: 4 },
  department:  { type: String, trim: true },
  description: { type: String },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  status: {
    type: String,
    enum: ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'],
    default: 'DRAFT',
  },

  startDate: { type: Date },
  endDate:   { type: Date },
}, { timestamps: true });

quarterlyPlanSchema.index({ year: 1, quarter: 1, department: 1 });

module.exports = mongoose.model('QuarterlyPlan', quarterlyPlanSchema);
