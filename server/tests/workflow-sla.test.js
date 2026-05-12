'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const SLA           = require('../src/ai/config/legalWorkflowSla');
const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');
const { isOperationalQuery } = require('../src/ai/orchestrator/OperationalQueryGuard');
const workflowTools = require('../src/ai/tools/workflow.tools');
const LegalRequest = require('../src/models/LegalRequest');

// ── SLA config values ─────────────────────────────────────────────────────────

test('SLA config has correct internal turnaround', () => {
  assert.equal(SLA.INTERNAL_TURNAROUND_DAYS, 4);
});

test('SLA config has correct external turnaround', () => {
  assert.equal(SLA.EXTERNAL_TURNAROUND_DAYS, 7);
});

test('SLA config has correct no-update threshold', () => {
  assert.equal(SLA.NO_UPDATE_THRESHOLD_DAYS, 3);
});

test('SLA config has correct signature reminder days', () => {
  assert.equal(SLA.SIGNATURE_REMINDER_DAYS, 2);
});

test('SLA config has correct signature escalation days', () => {
  assert.equal(SLA.SIGNATURE_ESCALATION_DAYS, 4);
});

// ── IntentRouter — workflow intents ───────────────────────────────────────────

const router = new IntentRouter();

test('IntentRouter routes "what needs my attention today" to manager attention', () => {
  assert.deepEqual(router.route('what needs my attention today?'), {
    type: 'tool_call',
    toolName: 'get_manager_attention_summary',
    arguments: {},
  });
});

test('IntentRouter routes "what should I follow up on" to manager attention', () => {
  const r = router.route('what should I follow up on?');
  assert.equal(r?.toolName, 'get_manager_attention_summary');
});

test('IntentRouter routes "what is due today" to get_due_today', () => {
  assert.deepEqual(router.route('what is due today?'), {
    type: 'tool_call',
    toolName: 'get_due_today',
    arguments: {},
  });
});

test('IntentRouter routes "due today" to get_due_today', () => {
  const r = router.route('what is due today');
  assert.equal(r?.toolName, 'get_due_today');
});

test('IntentRouter does NOT route "what tasks are due today" to get_due_today', () => {
  const r = router.route('what tasks are due today?');
  // Should not go to get_due_today (which is for legal requests)
  assert.notEqual(r?.toolName, 'get_due_today');
});

test('IntentRouter routes "what is due this week" to get_due_this_week', () => {
  const r = router.route('what is due this week?');
  assert.equal(r?.toolName, 'get_due_this_week');
});

test('IntentRouter routes "what is overdue" to get_overdue_requests', () => {
  const r = router.route('what is overdue?');
  assert.equal(r?.toolName, 'get_overdue_requests');
});

test('IntentRouter routes "overdue requests" to get_overdue_requests', () => {
  const r = router.route('show me overdue requests');
  assert.equal(r?.toolName, 'get_overdue_requests');
});

test('IntentRouter routes "overdue tasks" to list_overdue_tasks (not get_overdue_requests)', () => {
  const r = router.route('show me overdue tasks');
  assert.equal(r?.toolName, 'list_overdue_tasks');
});

test('IntentRouter routes "what is unassigned" to get_unassigned_requests', () => {
  const r = router.route('what is unassigned?');
  assert.equal(r?.toolName, 'get_unassigned_requests');
});

test('IntentRouter routes "waiting for manager" to get_waiting_for_manager', () => {
  const r = router.route('what is waiting for manager review?');
  assert.equal(r?.toolName, 'get_waiting_for_manager');
});

test('IntentRouter routes "waiting for business" to get_waiting_for_business', () => {
  const r = router.route('what is waiting for business department input?');
  assert.equal(r?.toolName, 'get_waiting_for_business');
});

test('IntentRouter routes "ready for signature" (requests) to get_ready_for_signature', () => {
  const r = router.route('which approved requests are ready for signature?');
  assert.equal(r?.toolName, 'get_ready_for_signature');
});

test('IntentRouter routes "awaiting signature requests" to get_awaiting_signature', () => {
  const r = router.route('which requests are still awaiting signature?');
  assert.equal(r?.toolName, 'get_awaiting_signature');
});

test('IntentRouter routes "internal SLA" to get_internal_sla_summary', () => {
  assert.deepEqual(router.route('show me internal SLA compliance'), {
    type: 'tool_call',
    toolName: 'get_internal_sla_summary',
    arguments: {},
  });
});

test('IntentRouter routes "external SLA" to get_external_sla_summary', () => {
  assert.deepEqual(router.route('show me external SLA compliance'), {
    type: 'tool_call',
    toolName: 'get_external_sla_summary',
    arguments: {},
  });
});

test('IntentRouter routes generic "SLA summary" to get_internal_sla_summary', () => {
  const r = router.route('show me the SLA summary for this month');
  assert.equal(r?.toolName, 'get_internal_sla_summary');
});

test('IntentRouter routes "missed SLA" to get_internal_sla_summary', () => {
  const r = router.route('which requests missed the SLA?');
  assert.equal(r?.toolName, 'get_internal_sla_summary');
});

test('IntentRouter routes "who is overloaded" to get_workload_by_user', () => {
  const r = router.route('who is overloaded on the team?');
  assert.equal(r?.toolName, 'get_workload_by_user');
});

test('IntentRouter routes "team workload" to get_workload_by_user', () => {
  const r = router.route('show me team workload summary');
  assert.equal(r?.toolName, 'get_workload_by_user');
});

test('IntentRouter routes "who has the most legal work" to get_workload_by_user', () => {
  const r = router.route('Who has the most legal work?');
  assert.equal(r?.toolName, 'get_workload_by_user');
});

test('IntentRouter routes "no update" to get_no_update_requests', () => {
  const r = router.route('which requests have had no update?');
  assert.equal(r?.toolName, 'get_no_update_requests');
});

test('IntentRouter routes "stuck" to get_no_update_requests', () => {
  const r = router.route('what is stuck?');
  assert.equal(r?.toolName, 'get_no_update_requests');
});

test('IntentRouter routes "signature emails sent" to get_signature_email_sent', () => {
  const r = router.route('what signature emails have been sent?');
  assert.equal(r?.toolName, 'get_signature_email_sent');
});

test('IntentRouter routes workflow history with ID to get_workflow_history', () => {
  const r = router.route('show me the workflow history for request LR-2025-12345');
  assert.deepEqual(r, {
    type: 'tool_call',
    toolName: 'get_workflow_history',
    arguments: { legalRequestId: 'LR-2025-12345' },
  });
});

// ── OperationalQueryGuard ─────────────────────────────────────────────────────

test('OperationalQueryGuard detects "how many overdue"', () => {
  assert.equal(isOperationalQuery('how many overdue requests are there?'), true);
});

test('OperationalQueryGuard detects "what is due today"', () => {
  assert.equal(isOperationalQuery('what is due today?'), true);
});

test('OperationalQueryGuard detects "show me contracts pending signature"', () => {
  assert.equal(isOperationalQuery('show me contracts pending signature'), true);
});

test('OperationalQueryGuard detects SLA questions', () => {
  assert.equal(isOperationalQuery('did we meet our SLA this month?'), true);
});

test('OperationalQueryGuard detects "who is overloaded"', () => {
  assert.equal(isOperationalQuery('who is overloaded?'), true);
});

test('OperationalQueryGuard detects workload questions', () => {
  assert.equal(isOperationalQuery('show me the team workload'), true);
});

test('get_workload_by_user aggregation uses valid MongoDB $unwind option', async () => {
  const tool = workflowTools.find((candidate) => candidate.name === 'get_workload_by_user');
  const originalCountDocuments = LegalRequest.countDocuments;
  const originalAggregate = LegalRequest.aggregate;
  let pipeline;

  LegalRequest.countDocuments = async () => 0;
  LegalRequest.aggregate = async (input) => {
    pipeline = input;
    return [{
      _id: null,
      total: 0,
      overdue: 0,
      awaitingSig: 0,
      userInfo: null,
    }];
  };

  try {
    const result = await tool.execute({}, { user: { role: 'manager' }, userId: 'manager1' });
    assert.equal(result.type, 'workflow_summary');
    assert.equal(result.title, 'Team Workload by User');
    const unwindStage = pipeline.find((stage) => stage.$unwind);
    assert.equal(unwindStage.$unwind.preserveNullAndEmptyArrays, true);
    assert.equal(Object.prototype.hasOwnProperty.call(unwindStage.$unwind, 'preserveNullAndEmpty'), false);
  } finally {
    LegalRequest.countDocuments = originalCountDocuments;
    LegalRequest.aggregate = originalAggregate;
  }
});

test('OperationalQueryGuard does not flag simple greetings', () => {
  assert.equal(isOperationalQuery('hello, how are you?'), false);
});

test('OperationalQueryGuard does not flag navigation requests', () => {
  assert.equal(isOperationalQuery('take me to the dashboard'), false);
});

test('OperationalQueryGuard does not flag who-am-I questions', () => {
  assert.equal(isOperationalQuery('who are you?'), false);
});

test('OperationalQueryGuard detects "my tasks" questions', () => {
  assert.equal(isOperationalQuery('what are my tasks?'), true);
});

test('OperationalQueryGuard detects expiring contract questions', () => {
  assert.equal(isOperationalQuery('which contracts are expiring soon?'), true);
});
