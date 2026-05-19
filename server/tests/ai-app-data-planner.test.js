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
    domain: 'tasks',
    intent: 'list',
    capabilityId: 'tasks.attention_today',
    toolName: 'query_tasks',
    args: { filters: { dueRange: 'today' } },
  },
  {
    message: 'Show unassigned workflow tasks',
    domain: 'workflows',
    intent: 'list',
    capabilityId: 'tasks.my_list',
    toolName: 'query_tasks',
    args: { filters: { unassignedOnly: true } },
  },
  {
    message: 'What tracker tasks are overdue',
    domain: 'workflows',
    intent: 'list',
    capabilityId: 'tasks.by_source',
    toolName: 'query_tasks',
    args: { filters: { sourceType: 'LEGAL_TRACKER', overdueOnly: true } },
  },
  {
    message: 'Show manual workflow tasks',
    domain: 'workflows',
    intent: 'list',
    capabilityId: 'tasks.by_source',
    toolName: 'query_tasks',
    args: { filters: { sourceType: 'MANUAL_WORKFLOW' } },
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
    capabilityId: 'reports.workflow_progress',
    toolName: 'query_reports_summary',
    args: { reportType: 'tasks', period: 'this_month' },
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
    message: 'List my tasks',
    domain: 'tasks',
    intent: 'list',
    capabilityId: 'tasks.my_list',
    toolName: 'query_tasks',
    args: { filters: { assignedTo: 'me' } },
  },
  {
    message: 'Show signature follow-ups',
    domain: 'signing',
    intent: 'list',
    capabilityId: 'signing.awaiting_signature',
    toolName: 'query_signing',
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
