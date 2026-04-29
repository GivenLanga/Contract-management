const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User no longer exists or is inactive.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  }
  next();
};

const requirePermission = (permission) => (req, res, next) => {
  const hasPermission =
    req.user.role === 'admin' ||
    (req.user.permissions && req.user.permissions.includes(permission));
  if (!hasPermission) {
    return res.status(403).json({ error: 'Insufficient permissions.' });
  }
  next();
};

const audit = (action, category) => async (req, res, next) => {
  res.on('finish', async () => {
    try {
      await AuditLog.create({
        action,
        category,
        performedBy: req.user?._id,
        performedByEmail: req.user?.email,
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        result: res.statusCode < 400 ? 'success' : 'failure',
      });
    } catch (e) {
      // Non-blocking — audit failure should not break requests
    }
  });
  next();
};

module.exports = { protect, requireRole, requirePermission, audit };
