const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ['MOA', 'MOI', 'NDA', 'MSA', 'SOW', 'SLA', 'Employment', 'Vendor', 'Lease', 'Other'],
    required: true,
  },
  description: { type: String },
  category: { type: String, default: 'General' },
  filename: { type: String, required: true },
  path: { type: String, required: true },
  fileType: { type: String, enum: ['docx', 'pdf'], default: 'docx' },
  fields: [{
    name: { type: String },
    placeholder: { type: String },
    type: { type: String, enum: ['text', 'date', 'number', 'select'] },
    required: { type: Boolean, default: false },
    options: [{ type: String }],
  }],
  usageCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tags: [{ type: String }],
  previewImage: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Template', templateSchema);
