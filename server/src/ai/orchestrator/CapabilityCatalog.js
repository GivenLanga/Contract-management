'use strict';

const CAPABILITIES = [
  // Contracts / agreements
  { id: 'contracts.count.all', domain: 'contracts', queryTypes: ['count', 'summary'], toolName: 'get_contract_status_summary', defaultArgs: {}, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.list', domain: 'contracts', queryTypes: ['list', 'filter'], toolName: 'query_contracts', defaultArgs: { filters: {}, limit: 20 }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.count.active', domain: 'contracts', queryTypes: ['count', 'status', 'list'], toolName: 'get_contract_status_summary', defaultArgs: { status: 'Active' }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.count.draft', domain: 'contracts', queryTypes: ['count', 'status', 'list'], toolName: 'get_contract_status_summary', defaultArgs: { status: 'Draft' }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.count.expired', domain: 'contracts', queryTypes: ['count', 'list'], toolName: 'get_expired_contracts', defaultArgs: { countOnly: true }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.count.expiring_soon', domain: 'contracts', queryTypes: ['count', 'list'], toolName: 'count_expiring_contracts', defaultArgs: { days: 30 }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.list.expiring_soon', domain: 'contracts', queryTypes: ['list'], toolName: 'list_expiring_contracts', defaultArgs: { days: 30 }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.count.awaiting_signature', domain: 'contracts', queryTypes: ['count', 'list'], toolName: 'get_awaiting_signature', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'contracts.count.signed', domain: 'contracts', queryTypes: ['count', 'summary'], toolName: 'get_signed_agreements_summary', defaultArgs: {}, resultType: 'signing_summary', modelAllowed: false },
  { id: 'contracts.value.total', domain: 'contracts', queryTypes: ['value'], toolName: 'get_contract_value_summary', defaultArgs: {}, resultType: 'contract_value_summary', modelAllowed: false },
  { id: 'contracts.value.by_department', domain: 'contracts', queryTypes: ['value'], toolName: 'query_contract_value', defaultArgs: { filters: {}, groupBy: 'department' }, resultType: 'contract_value_summary', modelAllowed: false },
  { id: 'contracts.value.active', domain: 'contracts', queryTypes: ['value'], toolName: 'get_contract_value_summary', defaultArgs: { status: 'Active' }, resultType: 'contract_value_summary', modelAllowed: false },
  { id: 'contracts.value.expired', domain: 'contracts', queryTypes: ['value'], toolName: 'get_contract_value_summary', defaultArgs: { status: 'Expired' }, resultType: 'contract_value_summary', modelAllowed: false },
  { id: 'contracts.by_type', domain: 'contracts', queryTypes: ['list', 'count'], toolName: 'get_contracts_by_type', defaultArgs: {}, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.by_counterparty', domain: 'contracts', queryTypes: ['list'], toolName: 'get_contracts_by_counterparty', defaultArgs: {}, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.renewal_candidates', domain: 'contracts', queryTypes: ['list', 'summary'], toolName: 'get_contract_renewal_candidates', defaultArgs: { days: 60 }, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.missing_signed_copy', domain: 'contracts', queryTypes: ['list', 'summary'], toolName: 'get_contracts_missing_signed_copy', defaultArgs: {}, resultType: 'contract_summary', modelAllowed: false },
  { id: 'contracts.management_summary', domain: 'contracts', queryTypes: ['summary'], toolName: 'get_contract_management_summary', defaultArgs: {}, resultType: 'contract_management_summary', modelAllowed: false },

  // Legal requests / workflow
  { id: 'legal_requests.list', domain: 'legal_requests', queryTypes: ['list', 'summary', 'filter'], toolName: 'query_legal_requests', defaultArgs: { filters: {}, period: 'all', limit: 20 }, resultType: 'legal_request_summary', modelAllowed: false },
  { id: 'legal_requests.submitted', domain: 'legal_requests', queryTypes: ['list', 'summary'], toolName: 'get_submitted_legal_requests', defaultArgs: { period: 'this_week' }, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.requested', domain: 'legal_requests', queryTypes: ['list', 'summary'], toolName: 'get_submitted_legal_requests', defaultArgs: { period: 'this_week', status: 'ALL' }, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.urgent', domain: 'legal_requests', queryTypes: ['list', 'filter'], toolName: 'query_legal_requests', defaultArgs: { filters: { priority: 'URGENT', urgentOnly: true }, period: 'all', limit: 20 }, resultType: 'legal_request_summary', modelAllowed: false },
  { id: 'legal_requests.by_department', domain: 'legal_requests', queryTypes: ['list', 'filter'], toolName: 'query_legal_requests', defaultArgs: { period: 'all', limit: 20 }, resultType: 'legal_request_summary', modelAllowed: false },
  { id: 'legal_requests.finance', domain: 'legal_requests', queryTypes: ['list', 'filter'], toolName: 'query_legal_requests', defaultArgs: { filters: { department: 'Finance' }, period: 'all', limit: 20 }, resultType: 'legal_request_summary', modelAllowed: false },
  { id: 'legal_requests.by_status', domain: 'legal_requests', queryTypes: ['list', 'status'], toolName: 'query_legal_requests', defaultArgs: { period: 'all', limit: 20 }, resultType: 'legal_request_summary', modelAllowed: false },
  { id: 'legal_requests.my_action', domain: 'legal_requests', queryTypes: ['list', 'attention'], toolName: 'query_legal_requests', defaultArgs: { filters: { assignedTo: 'me' }, period: 'all', limit: 20 }, resultType: 'legal_request_summary', modelAllowed: false },
  { id: 'legal_requests.field_answer', domain: 'legal_requests', queryTypes: ['detail', 'filter'], toolName: 'query_legal_requests', defaultArgs: { period: 'all', limit: 20 }, resultType: 'field_answer', modelAllowed: false },
  { id: 'legal_requests.department_requested_items', domain: 'legal_requests', queryTypes: ['detail', 'filter'], toolName: 'query_legal_requests', defaultArgs: { period: 'all', limit: 20 }, resultType: 'table_summary', modelAllowed: false },
  { id: 'legal_requests.due_today', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_due_today', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.due_this_week', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_due_this_week', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.overdue', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_overdue_requests', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.unassigned', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_unassigned_requests', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.waiting_manager', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_waiting_for_manager', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.waiting_business', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_waiting_for_business', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.no_update', domain: 'legal_requests', queryTypes: ['list'], toolName: 'get_no_update_requests', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.signature_email_sent', domain: 'legal_requests', queryTypes: ['list', 'summary'], toolName: 'get_signature_email_sent', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'legal_requests.tasks', domain: 'legal_requests', queryTypes: ['list', 'summary'], toolName: 'get_legal_request_tasks', defaultArgs: { limit: 20 }, resultType: 'task_summary', modelAllowed: false },
  { id: 'legal_requests.progress_this_month', domain: 'reports', queryTypes: ['progress', 'summary'], toolName: 'get_legal_team_progress', defaultArgs: { period: 'this_month' }, resultType: 'report_summary', modelAllowed: false },
  { id: 'legal_requests.manager_attention', domain: 'legal_requests', queryTypes: ['summary'], toolName: 'get_manager_attention_summary', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },

  // Tasks
  { id: 'tasks.my_summary', domain: 'tasks', queryTypes: ['count', 'summary'], toolName: 'get_task_summary', defaultArgs: { mine_only: true }, resultType: 'task_summary', modelAllowed: false },
  { id: 'tasks.by_legal_request', domain: 'tasks', queryTypes: ['list'], toolName: 'query_tasks', defaultArgs: { filters: { linkedLegalRequest: true }, limit: 20 }, resultType: 'task_summary', modelAllowed: false },
  { id: 'tasks.my_list', domain: 'tasks', queryTypes: ['list'], toolName: 'list_my_tasks', defaultArgs: { limit: 10 }, resultType: 'task_summary', modelAllowed: false },
  { id: 'tasks.overdue', domain: 'tasks', queryTypes: ['list', 'count'], toolName: 'list_overdue_tasks', defaultArgs: { mine_only: false, limit: 10 }, resultType: 'task_summary', modelAllowed: false },
  { id: 'tasks.due_today', domain: 'tasks', queryTypes: ['list'], toolName: 'list_my_tasks', defaultArgs: { due: 'today', limit: 10 }, resultType: 'task_summary', modelAllowed: false },
  { id: 'tasks.due_this_week', domain: 'tasks', queryTypes: ['list'], toolName: 'list_my_tasks', defaultArgs: { due: 'this_week', limit: 10 }, resultType: 'task_summary', modelAllowed: false },
  { id: 'tasks.team_workload', domain: 'tasks', queryTypes: ['summary'], toolName: 'get_workload_by_user', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'tasks.completed_this_month', domain: 'tasks', queryTypes: ['count', 'summary'], toolName: 'get_task_summary', defaultArgs: { mine_only: false, period: 'this_month' }, resultType: 'task_summary', modelAllowed: false },

  // Signing
  { id: 'signing.awaiting_signature', domain: 'signing', queryTypes: ['list', 'count'], toolName: 'list_pending_signatures', defaultArgs: { limit: 10 }, resultType: 'signing_summary', modelAllowed: false },
  { id: 'signing.sent_for_signature', domain: 'signing', queryTypes: ['list', 'count'], toolName: 'query_signing', defaultArgs: { filters: { sentForSignature: true }, limit: 20 }, resultType: 'signing_summary', modelAllowed: false },
  { id: 'signing.fully_signed', domain: 'signing', queryTypes: ['list', 'count'], toolName: 'query_signing', defaultArgs: { filters: { fullySigned: true }, limit: 20 }, resultType: 'signing_summary', modelAllowed: false },
  { id: 'signing.count_awaiting_signature', domain: 'signing', queryTypes: ['count'], toolName: 'count_documents_in_signing_platform', defaultArgs: {}, resultType: 'signing_summary', modelAllowed: false },
  { id: 'signing.fully_signed_documents', domain: 'signing', queryTypes: ['count', 'list'], toolName: 'count_signed_documents', defaultArgs: {}, resultType: 'signing_summary', modelAllowed: false },
  { id: 'signing.pending_signatories', domain: 'signing', queryTypes: ['list'], toolName: 'list_pending_signatures', defaultArgs: { limit: 10 }, resultType: 'signing_summary', modelAllowed: false },

  // Documents
  { id: 'documents.status_summary', domain: 'documents', queryTypes: ['count', 'summary'], toolName: 'get_document_status_summary', defaultArgs: {}, resultType: 'document_summary', modelAllowed: false },
  { id: 'documents.signed', domain: 'documents', queryTypes: ['count', 'list'], toolName: 'count_signed_documents', defaultArgs: {}, resultType: 'signing_summary', modelAllowed: false },
  { id: 'documents.awaiting_signature', domain: 'documents', queryTypes: ['count', 'list'], toolName: 'list_pending_signatures', defaultArgs: { limit: 10 }, resultType: 'signing_summary', modelAllowed: false },
  { id: 'documents.recent_uploads', domain: 'documents', queryTypes: ['list'], toolName: 'get_document_status_summary', defaultArgs: { recent: true, limit: 10 }, resultType: 'document_summary', modelAllowed: false },
  { id: 'documents.expired_if_metadata_exists', domain: 'documents', queryTypes: ['count', 'list'], toolName: 'get_expired_documents', defaultArgs: {}, resultType: 'unsupported_metadata', modelAllowed: false },

  // Reports / dashboard / notifications
  { id: 'reports.dashboard_summary', domain: 'reports', queryTypes: ['summary'], toolName: 'query_reports_summary', defaultArgs: { reportType: 'dashboard' }, resultType: 'dashboard_summary', modelAllowed: false },
  { id: 'reports.legal_team_progress', domain: 'reports', queryTypes: ['progress', 'summary'], toolName: 'get_legal_team_progress', defaultArgs: { period: 'this_month' }, resultType: 'report_summary', modelAllowed: false },
  { id: 'dashboard.overview', domain: 'dashboard', queryTypes: ['summary'], toolName: 'get_app_overview', defaultArgs: {}, resultType: 'dashboard_summary', modelAllowed: false },
  { id: 'dashboard.contract_health', domain: 'dashboard', queryTypes: ['summary'], toolName: 'get_contract_management_summary', defaultArgs: {}, resultType: 'contract_management_summary', modelAllowed: false },
  { id: 'dashboard.sla_summary', domain: 'dashboard', queryTypes: ['summary'], toolName: 'get_internal_sla_summary', defaultArgs: {}, resultType: 'workflow_summary', modelAllowed: false },
  { id: 'notifications.unread_count', domain: 'notifications', queryTypes: ['count'], toolName: 'count_my_notifications', defaultArgs: { unread_only: true }, resultType: 'notification_summary', modelAllowed: false },
  { id: 'notifications.latest', domain: 'notifications', queryTypes: ['list'], toolName: 'list_my_notifications', defaultArgs: { unread_only: false, limit: 10 }, resultType: 'notification_summary', modelAllowed: false },
];

const BY_ID = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));

const getCapability = (id) => BY_ID.get(id) || null;

module.exports = { CAPABILITIES, getCapability };
