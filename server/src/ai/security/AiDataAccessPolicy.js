const { can } = require('../../middleware/rbac');
const { getAiCapabilities } = require('./AiCapabilities');

const SOURCE_LEVELS = new Set(['source', 'source_code', 'backend_source', 'internal']);
const HELP_LEVELS = new Set(['help', 'product', 'summary', 'public', 'backend_help']);
const HIGH_RISK_ACTIONS = new Set([
  'delete_contract',
  'delete_document',
  'delete_signed_document',
  'modify_signed_document',
  'approve_contract',
  'send_legal_notice',
  'change_permissions',
  'export_all_data',
  'override_workflow_history',
  'remove_audit_logs',
]);

const MEDIUM_RISK_ACTIONS = new Set([
  'create_task',
  'assign_task',
  'send_reminder',
  'send_signature_email',
  'change_workflow_status',
  'update_metadata',
  'add_comment',
  'generate_draft',
  'export_report',
]);

class AiDataAccessPolicy {
  constructor(capabilityResolver = getAiCapabilities) {
    this._capabilityResolver = capabilityResolver;
  }

  capabilities(user) {
    return this._capabilityResolver(user);
  }

  canUseTool(user, tool) {
    if (!tool) return { allowed: false, reason: 'Unknown tool.' };

    for (const perm of (tool.requiredPermissions || [])) {
      if (!can(user, perm)) {
        return { allowed: false, reason: `You do not have the "${perm}" permission.` };
      }
    }

    return { allowed: true };
  }

  canUseBackendRag(user, level = 'help') {
    const caps = this.capabilities(user);
    const normalized = String(level || '').toLowerCase();
    if (SOURCE_LEVELS.has(normalized)) return caps.backendSourceRag;
    if (HELP_LEVELS.has(normalized)) return caps.backendHelpRag;
    return false;
  }

  canUseDocumentRag(user) {
    return this.capabilities(user).documentRag;
  }

  canViewField(user, resourceType, fieldName) {
    const caps = this.capabilities(user);
    const field = String(fieldName || '').toLowerCase();
    const resource = String(resourceType || '').toLowerCase();

    if (/(password|token|secret|apikey|authorization|cookie|privatekey|credential|session)/i.test(field)) {
      return false;
    }
    if (/(signaturedata|initialsdata|evidence|fingerprint|certificate|secureurl|signinglink)/i.test(field)) {
      return false;
    }
    if (resource === 'audit' && !caps.auditRead) return false;
    if (field === 'email' && resource === 'user' && !caps.userDirectoryRead) return false;
    if (/(notes|risk|privileged|privatecomment|managernote)/i.test(field) && !caps.isAdmin && !caps.isManager) {
      return false;
    }
    return true;
  }

  canPerformAiAction(user, action) {
    const caps = this.capabilities(user);
    if (!caps.actionsAllowed) return { allowed: false, reason: 'AI actions are not enabled for this user role.' };
    if (this.isHighRiskAction(action)) {
      return { allowed: false, reason: 'This action must be completed in the application UI.' };
    }
    if (this.isMediumRiskAction(action)) {
      return { allowed: true, requiresConfirmation: true };
    }
    return { allowed: true, requiresConfirmation: false };
  }

  isHighRiskAction(action) {
    return HIGH_RISK_ACTIONS.has(String(action || '').toLowerCase());
  }

  isMediumRiskAction(action) {
    return MEDIUM_RISK_ACTIONS.has(String(action || '').toLowerCase());
  }
}

module.exports = {
  AiDataAccessPolicy,
  HIGH_RISK_ACTIONS,
  MEDIUM_RISK_ACTIONS,
};
