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
  ['How many contracts are awaiting signature?', 'count_documents_in_signing_platform'],
  ['Which contracts need renewal?', 'get_contract_renewal_candidates'],
  ['Show loan agreements.', 'get_contracts_by_type', { contractType: 'LOAN_AGREEMENT' }],
  ['Show grant agreements.', 'get_contracts_by_type', { contractType: 'GRANT_AGREEMENT' }],
  ['Show service provider agreements.', 'get_contracts_by_type', { contractType: 'SERVICE_PROVIDER_AGREEMENT' }],
  ['Show contracts with ThaboTech.', 'get_contracts_by_counterparty'],
  ['Show contracts missing signed copies.', 'get_contracts_missing_signed_copy'],

  // Workflows / Tasks
  ['Show tracker tasks.', 'query_tasks'],
  ['What tracker tasks are overdue?', 'query_tasks'],
  ['Show manual workflow tasks.', 'query_tasks'],
  ['Show unassigned workflow tasks.', 'query_tasks'],
  ['What is due today?', 'query_tasks'],
  ['What is due this week?', 'query_tasks'],
  ['What is overdue?', 'list_overdue_tasks'],
  ['What is waiting for manager review?', 'query_reports_summary'],
  ['What is waiting for business input?', 'query_reports_summary'],
  ['What has had no update recently?', 'query_reports_summary'],
  ['What needs my attention today?', 'query_tasks'],
  ["What's the legal team's progress this month?", 'query_reports_summary', { reportType: 'tasks' }],

  // Tasks
  ['How many tasks do I have?', 'get_task_summary'],
  ['Show my tasks.', 'list_my_tasks'],
  ['Show overdue tasks.', 'list_overdue_tasks'],
  ['What tasks are due today?', 'list_my_tasks'],
  ['Who is overloaded on the team?', 'get_task_summary'],
  ['Show team workload.', 'get_task_summary'],
  ['How many tasks were completed this month?', 'get_task_summary'],

  // Signing
  ['How many documents have been signed?', 'count_signed_documents'],
  ['How many agreements have been signed?', 'get_signed_agreements_summary'],
  ['Which documents are awaiting signature?', 'list_pending_signatures'],
  ['Which agreements are awaiting signature?', 'list_pending_signatures'],
  ['What was sent for signature?', 'query_signing'],
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
  ['How is legal doing this month?', 'query_reports_summary'],
  ['Show workflow progress.', 'query_reports_summary'],
  ['Show contract health.', 'get_contract_management_summary'],
  ['Show signing summary.', 'get_app_overview'],
  ['Show department summary.', 'get_app_overview'],
  ['What changed recently?', 'get_app_overview'],
];

test('app-data QA suite covers at least 50 deterministic routing cases', () => {
  assert.equal(cases.length >= 50, true);
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
