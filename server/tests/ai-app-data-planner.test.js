'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AppDataQueryPlanner } = require('../src/ai/orchestrator/AppDataQueryPlanner');
const { ToolRegistry } = require('../src/ai/tools/ToolRegistry');

const planner = new AppDataQueryPlanner();
const registry = new ToolRegistry();

const cases = [
  {
    message: 'What needs my attention today?',
    domain: 'legal_requests',
    intent: 'attention',
    capabilityId: 'legal_requests.manager_attention',
    toolName: 'get_manager_attention_summary',
  },
  {
    message: 'What do i have in the legal requests',
    domain: 'legal_requests',
    intent: 'list',
    capabilityId: 'legal_requests.list',
    toolName: 'query_legal_requests',
    args: { period: 'all' },
  },
  {
    message: 'Whats urgent in the legal requests',
    domain: 'legal_requests',
    intent: 'list',
    capabilityId: 'legal_requests.urgent',
    toolName: 'query_legal_requests',
    args: { filters: { priority: 'URGENT', urgentOnly: true } },
  },
  {
    message: 'In the legal requests, what did finance ask for and when do they want it',
    domain: 'legal_requests',
    intent: 'field_answer',
    capabilityId: 'legal_requests.department_requested_items',
    toolName: 'query_legal_requests',
    answerShape: 'table',
    args: { filters: { department: 'Finance' } },
    requestedFields: ['title', 'description', 'requestType', 'documentCategory', 'dueDate', 'targetDate'],
  },
  {
    message: 'What task are in the legal requests',
    domain: 'legal_requests',
    intent: 'list',
    capabilityId: 'legal_requests.tasks',
    toolName: 'get_legal_request_tasks',
  },
  {
    message: 'how many agreements are active',
    domain: 'contracts',
    intent: 'count',
    capabilityId: 'contracts.active.count',
    toolName: 'query_contracts',
    args: { filters: { status: 'Active' }, countOnly: true },
  },
  {
    message: 'Whats the total value of the all the contracts',
    domain: 'contracts',
    intent: 'value',
    capabilityId: 'contracts.value.total',
    toolName: 'query_contract_value',
  },
  {
    message: "Whats the legal team's progress this month",
    domain: 'reports',
    intent: 'progress',
    capabilityId: 'reports.legal_team_progress',
    toolName: 'get_legal_team_progress',
    args: { period: 'this_month' },
  },
  {
    message: 'How many documents have expired',
    domain: 'documents',
    intent: 'count',
    capabilityId: 'documents.expired_if_supported',
    toolName: 'query_documents',
    args: { filters: { expiredOnly: true }, countOnly: true },
  },
  {
    message: 'Show urgent Finance legal requests',
    domain: 'legal_requests',
    intent: 'list',
    capabilityId: 'legal_requests.finance',
    toolName: 'query_legal_requests',
    args: { filters: { department: 'Finance', priority: 'URGENT', urgentOnly: true } },
  },
  {
    message: 'Which legal requests are closed',
    domain: 'legal_requests',
    intent: 'list',
    capabilityId: 'legal_requests.by_status',
    toolName: 'query_legal_requests',
    args: { filters: { status: 'CLOSED', closedOnly: true } },
  },
];

const assertPartial = (actual, partial, label) => {
  for (const [key, expected] of Object.entries(partial || {})) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      assertPartial(actual?.[key], expected, `${label}.${key}`);
    } else {
      assert.deepEqual(actual?.[key], expected, `${label}.${key}`);
    }
  }
};

for (const c of cases) {
  test(`AppDataQueryPlanner selects deterministic tool: ${c.message}`, () => {
    const plan = planner.plan(c.message);
    assert.equal(plan.isAppDataQuery, true);
    assert.equal(plan.domain, c.domain);
    assert.equal(plan.intent, c.intent);
    assert.equal(plan.capabilityId, c.capabilityId);
    assert.equal(plan.toolName, c.toolName);
    assert.equal(plan.confidence >= 0.75, true);
    assert.equal(Boolean(registry.get(plan.toolName)), true, `Tool does not exist: ${plan.toolName}`);
    assert.equal(plan.answerShape, c.answerShape || plan.answerShape);
    assertPartial(plan.args, c.args, 'args');
    for (const field of c.requestedFields || []) {
      assert.equal(plan.requestedFields.includes(field), true, `Missing requested field ${field}`);
    }
  });
}

test('AppDataQueryPlanner refuses to plan drafting as app-data', () => {
  const plan = planner.plan('draft an addendum');
  assert.equal(plan.isAppDataQuery, false);
  assert.equal(plan.toolName, null);
});
