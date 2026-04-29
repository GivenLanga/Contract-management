const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: {
    type: String,
    enum: ['admin', 'manager', 'staff', 'external'],
    default: 'staff',
  },
  department: { type: String, trim: true },
  title: { type: String, trim: true },
  phone: { type: String, trim: true },
  avatar: { type: String },
  isActive: { type: Boolean, default: true },
  permissions: [{
    type: String,
    enum: [
      'contract:read', 'contract:write', 'contract:delete', 'contract:approve',
      'task:read', 'task:write', 'task:assign',
      'document:read', 'document:write', 'document:delete', 'document:approve',
      'template:read', 'template:write',
      'signing:sign', 'signing:manage',
      'report:read',
      'user:manage',
    ],
  }],
  notificationPreferences: {
    taskAssignment: { type: Boolean, default: true },
    taskCompletion: { type: Boolean, default: true },
    documentUpload: { type: Boolean, default: true },
    signingRequest: { type: Boolean, default: true },
    contractExpiry: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true },
  },
  lastLogin: { type: Date },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.generateToken = function () {
  return jwt.sign(
    { id: this._id, role: this.role, email: this.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
