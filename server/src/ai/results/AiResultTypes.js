'use strict';

const STRUCTURED_RESULT_TYPES = new Set([
  'count_summary',
  'list_summary',
  'field_answer',
  'table_summary',
  'contract_summary',
  'contract_value_summary',
  'contract_management_summary',
  'workflow_summary',
  'legal_request_summary',
  'task_summary',
  'signing_summary',
  'document_summary',
  'report_summary',
  'dashboard_summary',
  'unsupported_metadata',
  'clarification_required',
  'drafting_unavailable',
  'tool_error',
]);

const isStructuredResult = (result) =>
  Boolean(result && STRUCTURED_RESULT_TYPES.has(result.type));

const clarificationRequired = ({ title = 'Clarification Needed', summary, category = 'app_data', options = [] }) => ({
  type: 'clarification_required',
  category,
  title,
  summary,
  metrics: {},
  items: [],
  options,
});

module.exports = {
  STRUCTURED_RESULT_TYPES,
  clarificationRequired,
  isStructuredResult,
};
