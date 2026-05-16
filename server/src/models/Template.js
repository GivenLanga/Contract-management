'use strict';

const mongoose = require('mongoose');

const placeholderFieldSchema = new mongoose.Schema({
  name: String,
  placeholder: String,
  type: { type: String, enum: ['text', 'date', 'number', 'select'] },
  required: { type: Boolean, default: false },
  options: [String],
}, { _id: false });

const templateSchema = new mongoose.Schema({
  // ── Display identity ──────────────────────────────────────────────────────
  name: { type: String, required: true, trim: true },
  title: { type: String, trim: true },
  description: { type: String },
  originalFileName: { type: String },

  // ── File storage ──────────────────────────────────────────────────────────
  filename: { type: String },
  path: { type: String },
  filePath: { type: String },
  storageKey: { type: String },
  mimeType: { type: String },
  extension: { type: String, lowercase: true },
  fileSize: { type: Number, default: 0 },
  fileType: {
    type: String,
    enum: ['docx', 'dotx', 'doc', 'pdf', 'txt', 'md', 'other'],
    default: 'docx',
  },

  // ── Source provenance ─────────────────────────────────────────────────────
  sourcePath: { type: String },
  sourceFolder: { type: String },
  sourceType: {
    type: String,
    enum: ['UPLOADED', 'DISCOVERED', 'GENERATED'],
    default: 'UPLOADED',
  },

  // ── Relationships ─────────────────────────────────────────────────────────
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ── Classification ────────────────────────────────────────────────────────
  agreementFamily: { type: String, default: 'OTHER' },
  // Legacy type enum kept for backwards compat with existing records
  type: {
    type: String,
    enum: ['MOA', 'MOI', 'NDA', 'MSA', 'SOW', 'SLA', 'Employment', 'Vendor', 'Lease', 'Other'],
  },
  category: { type: String, default: 'General' },
  tags: [{ type: String }],
  versionLabel: { type: String },
  classificationConfidence: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium',
  },
  classificationSignals: [{ type: String }],

  // ── Content metadata ──────────────────────────────────────────────────────
  placeholderFields: [{ type: String }],
  clauseHeadings: [{ type: String }],
  // Legacy form fields schema (Phase 2 drafting)
  fields: [placeholderFieldSchema],

  // ── Status ────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED', 'PENDING_REVIEW'],
    default: 'ACTIVE',
  },
  approvalStatus: {
    type: String,
    enum: ['APPROVED', 'PENDING', 'REJECTED'],
    default: 'APPROVED',
  },
  isActive: { type: Boolean, default: true },

  // ── Source flags ──────────────────────────────────────────────────────────
  isDiscovered: { type: Boolean, default: false },
  isUploaded: { type: Boolean, default: false },
  isGenerated: { type: Boolean, default: false },

  // ── Usage tracking ────────────────────────────────────────────────────────
  usageCount: { type: Number, default: 0 },
  lastUsedAt: { type: Date },
  lastScannedAt: { type: Date },

  // ── Preview ───────────────────────────────────────────────────────────────
  previewImage: { type: String },
}, { timestamps: true });

// Compound index for deduplication during discovery
templateSchema.index({ originalFileName: 1, sourceFolder: 1 });
templateSchema.index({ storageKey: 1 }, { sparse: true });
templateSchema.index({ documentId: 1 }, { sparse: true });
templateSchema.index({ status: 1, approvalStatus: 1, isActive: 1 });
templateSchema.index({ agreementFamily: 1 });
templateSchema.index({ category: 1 });

module.exports = mongoose.model('Template', templateSchema);
