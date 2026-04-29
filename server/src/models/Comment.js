const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
  text: { type: String, required: true, trim: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  position: {
    page: { type: Number },
    x: { type: Number },
    y: { type: Number },
    selectedText: { type: String },
  },
  resolved: { type: Boolean, default: false },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolvedAt: { type: Date },
  replies: [{
    text: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  }],
  isInternal: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Comment', commentSchema);
