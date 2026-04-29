// Role-Based Access Control: default permission sets per role
const ROLE_PERMISSIONS = {
  admin: '*', // all permissions
  manager: [
    'contract:read', 'contract:write', 'contract:approve',
    'task:read', 'task:write', 'task:assign',
    'document:read', 'document:write', 'document:approve',
    'template:read', 'template:write',
    'signing:sign', 'signing:manage',
    'report:read',
  ],
  staff: [
    'contract:read', 'contract:write',
    'task:read', 'task:write',
    'document:read', 'document:write',
    'template:read',
    'signing:sign',
    'report:read',
  ],
  external: [
    'contract:read',
    'document:read',
    'signing:sign',
  ],
};

const can = (user, permission) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.permissions && user.permissions.length > 0) {
    return user.permissions.includes(permission);
  }
  const defaults = ROLE_PERMISSIONS[user.role] || [];
  return defaults.includes(permission);
};

const guard = (permission) => (req, res, next) => {
  if (!can(req.user, permission)) {
    return res.status(403).json({ error: 'Forbidden: insufficient permissions.' });
  }
  next();
};

module.exports = { can, guard, ROLE_PERMISSIONS };
