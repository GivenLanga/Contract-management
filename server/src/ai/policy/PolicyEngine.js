const { AiDataAccessPolicy } = require('../security/AiDataAccessPolicy');

class PolicyEngine {
  constructor(dataAccessPolicy = new AiDataAccessPolicy()) {
    this._dataAccessPolicy = dataAccessPolicy;
  }

  /**
   * Decide whether the tool call may proceed.
   * Returns { allowed, reason, requiresConfirmation }
   */
  evaluate(tool, user) {
    if (!tool) {
      return { allowed: false, reason: 'Unknown tool.', requiresConfirmation: false };
    }

    const permission = this._dataAccessPolicy.canUseTool(user, tool);
    if (!permission.allowed) {
      return { allowed: false, reason: permission.reason, requiresConfirmation: false };
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
