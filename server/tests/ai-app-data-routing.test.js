'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');
const { DomainIntentClassifier, CATEGORIES } = require('../src/ai/orchestrator/DomainIntentClassifier');
const { CapabilityMatcher } = require('../src/ai/orchestrator/CapabilityMatcher');

const router = new IntentRouter();
const classifier = new DomainIntentClassifier();
const matcher = new CapabilityMatcher(classifier);

const cases = [
  // Contracts / Agreements
  ['How many agreements are active?', 'get_contract_status_summary', { status: 'Active' }],
  ['How many contracts are active?', 'get_contract_status_summary', { status: 'Active' }],
  ['Show active agreements.', 'get_contract_status_summary', { status: 'Active' }],
  ['How many contracts have expired?', 'get_expired_contracts'],
  ['How many agreements have expired?', 'get_expired_contracts'],
  ['Which contracts are expiring in 30 days?', 'list_expiring_contracts', { days: 30 }],
  ['Which contracts expire this month?', 'list_expiring_contracts'],
  ['Which contracts expire in the next 3 months?', 'list_expiring_contracts', { days: 90 }],
  ['What is the total value of all contracts?', 'get_contract_value_summary'],
  ["What's the total value of the all the contracts?", 'get_contract_value_summary'],
  ['What is the value of active contracts?', 'get_contract_value_summary', { status: 'Active' }],
  ['Show contract value by department.', 'get_contract_value_summary'],
  ['How many agreements have been signed?', 'get_signed_agreements_summary'],
  ['How many contracts are awaiting signature?', 'get_awaiting_signature'],
  ['Which contracts need renewal?', 'get_contract_renewal_candidates'],
  ['Show loan agreements.', 'get_contracts_by_type', { contractType: 'LOAN_AGREEMENT' }],
  ['Show grant agreements.', 'get_contracts_by_type', { contractType: 'GRANT_AGREEMENT' }],
  ['Show service provider agreements.', 'get_contracts_by_type', { contractType: 'SERVICE_PROVIDER_AGREEMENT' }],
  ['Show contracts with ThaboTech.', 'get_contracts_by_counterparty'],
  ['Show contracts missing signed copies.', 'get_contracts_missing_signed_copy'],

  // Legal Requests / Workflow
  ['What was submitted in legal requests?', 'get_submitted_legal_requests'],
  ['What was requested in the legal requests?', 'get_submitted_legal_requests', { status: 'ALL' }],
  ['Show submitted legal requests this week.', 'get_submitted_legal_requests', { period: 'this_week' }],
  ['What legal requests came in today?', 'get_submitted_legal_requests', { period: 'today', status: 'ALL' }],
  ['What is due today?', 'get_due_today'],
  ['What is due this week?', 'get_due_this_week'],
  ['What is overdue?', 'get_overdue_requests'],
  ['What is waiting for manager review?', 'get_waiting_for_manager'],
  ['What is waiting for business input?', 'get_waiting_for_business'],
  ['What has had no update recently?', 'get_no_update_requests'],
  ['What needs my attention today?', 'get_manager_attention_summary'],
  ["What's the legal team's progress this month?", 'get_legal_team_progress', { period: 'this_month' }],
  ['Show legal request tasks.', 'get_legal_request_tasks'],
  ['What task are in the legal requests?', 'get_legal_request_tasks'],

  // Tasks
  ['How many tasks do I have?', 'get_task_summary'],
  ['Show my tasks.', 'list_my_tasks'],
  ['Show overdue tasks.', 'list_overdue_tasks'],
  ['What tasks are due today?', 'list_my_tasks'],
  ['Who is overloaded on the team?', 'get_workload_by_user'],
  ['Show team workload.', 'get_workload_by_user'],
  ['How many tasks were completed this month?', 'get_task_summary'],

  // Signing
  ['How many documents have been signed?', 'count_signed_documents'],
  ['How many agreements have been signed?', 'get_signed_agreements_summary'],
  ['Which documents are awaiting signature?', 'list_pending_signatures'],
  ['Which agreements are awaiting signature?', 'get_awaiting_signature'],
  ['What was sent for signature?', 'get_signature_email_sent'],
  ['Who still needs to sign?', 'list_pending_signatures'],
  ['Show pending signatures.', 'list_pending_signatures'],

  // Documents
  ['How many documents have expired?', 'get_expired_documents'],
  ['Show signed documents.', 'count_signed_documents'],
  ['Show recent uploaded documents.', 'get_document_status_summary', { recent: true }],
  ['Which documents are missing signed copies?', 'get_contracts_missing_signed_copy'],

  // Reports / Dashboard
  ['Give me a dashboard summary.', 'get_app_overview'],
  ['Give me a contract management summary.', 'get_contract_management_summary'],
  ['How is legal doing this month?', 'get_legal_team_progress'],
  ['Show SLA summary.', 'get_internal_sla_summary'],
  ['Show contract health.', 'get_contract_management_summary'],
  ['Show signing summary.', 'get_app_overview'],
  ['Show department summary.', 'get_app_overview'],
  ['What changed recently?', 'get_app_overview'],
];

test('app-data QA suite covers at least 60 deterministic routing cases', () => {
  assert.equal(cases.length >= 60, true);
});

for (const [message, toolName, argsPartial] of cases) {
  test(`routes app-data query without model: ${message}`, () => {
    const classification = classifier.classify(message);
    assert.equal(classification.category, CATEGORIES.APP_DATA_QUERY, `Expected APP_DATA_QUERY for "${message}"`);
    assert.equal(classification.allowModel, false);

    const result = router.route(message);
    assert.equal(result?.type, 'tool_call', `Expected direct tool_call for "${message}", got ${result?.type || 'null'}`);
    assert.equal(result.toolName, toolName, `Wrong tool for "${message}"`);

    if (argsPartial) {
      for (const [key, value] of Object.entries(argsPartial)) {
        assert.deepEqual(result.arguments?.[key], value, `Wrong arg ${key} for "${message}"`);
      }
    }
  });
}

test('CapabilityMatcher reports no model allowance for app-data misses', () => {
  const match = matcher.match('How many documents have expired?');
  assert.equal(match.matched, true);
  assert.equal(match.classification.allowModel, false);
  assert.equal(match.route.toolName, 'get_expired_documents');
});
