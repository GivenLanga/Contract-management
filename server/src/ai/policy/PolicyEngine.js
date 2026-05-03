const { can } = require('../../middleware/rbac');

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

class PolicyEngine {
  /**
   * Decide whether the tool call may proceed.
   * Returns { allowed, reason, requiresConfirmation }
   */
  evaluate(tool, user) {
    if (!tool) {
      return { allowed: false, reason: 'Unknown tool.', requiresConfirmation: false };
    }

    // Permission check
    for (const perm of (tool.requiredPermissions || [])) {
      if (!can(user, perm)) {
        return { allowed: false, reason: `You do not have the "${perm}" permission.`, requiresConfirmation: false };
      }
    }

    const risk = tool.riskLevel || 'low';

    if (risk === 'low') {
      return { allowed: true, requiresConfirmation: false };
    }

    if (risk === 'medium') {
      return { allowed: true, requiresConfirmation: true };
    }

    // high risk — always block via AI; must be done through the UI directly
    return {
      allowed: false,
      reason: 'This action requires manual confirmation through the application interface.',
      requiresConfirmation: false,
    };
  }
}

module.exports = { PolicyEngine };
