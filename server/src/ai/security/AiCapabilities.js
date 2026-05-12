const { can } = require('../../middleware/rbac');

const normalizedRole = (user) => String(user?.role || '').toLowerCase();

const hasPermission = (user, permission) =>
  can(user, permission) ||
  (Array.isArray(user?.permissions) && user.permissions.includes(permission));

const isAdmin = (user) => normalizedRole(user) === 'admin';
const isManager = (user) => normalizedRole(user) === 'manager';
const isStaff = (user) => normalizedRole(user) === 'staff';
const isBusiness = (user) => normalizedRole(user) === 'business';
const isExternal = (user) => normalizedRole(user) === 'external';

function getAiCapabilities(user) {
  const role = normalizedRole(user);
  const backendHelpRole = ['admin', 'manager', 'staff', 'business'].includes(role);

  return {
    role,
    workflowRead: hasPermission(user, 'workflow:read') || hasPermission(user, 'report:read'),
    contractRead: hasPermission(user, 'contract:read'),
    taskRead: hasPermission(user, 'task:read'),
    documentRead: hasPermission(user, 'document:read'),
    signingRead: hasPermission(user, 'signing:manage') || hasPermission(user, 'signing:sign') || hasPermission(user, 'document:read'),
    reportRead: hasPermission(user, 'report:read'),
    documentRag: hasPermission(user, 'document:read'),
    backendHelpRag: backendHelpRole && !isExternal(user),
    backendSourceRag: isAdmin(user) || hasPermission(user, 'developer:access') || hasPermission(user, 'user:manage'),
    auditRead: isAdmin(user) || isManager(user),
    userDirectoryRead: isAdmin(user) || isManager(user),
    actionsAllowed: Boolean(user) && !isExternal(user),
    destructiveActionsAllowed: false,
    isAdmin: isAdmin(user),
    isManager: isManager(user),
    isStaff: isStaff(user),
    isBusiness: isBusiness(user),
    isExternal: isExternal(user),
  };
}

module.exports = {
  getAiCapabilities,
};
