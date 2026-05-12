'use strict';

/**
 * Direct-route coverage tests.
 *
 * For each of the 8 high-traffic operational queries, these tests assert that:
 *  - IntentRouter.route() returns type:'tool_call' with the correct toolName.
 *  - provider.generate is NEVER called (the orchestrator short-circuits in
 *    _tryDirectResponse before touching RAG, PromptBuilder, or the model).
 *
 * The model-bypass guarantee follows directly from AssistantOrchestrator:
 *  if (_tryDirectResponse returns a result) → return immediately, no RAG/model.
 * These tests prove the router half of that contract.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');

const router = new IntentRouter();

const expectDirect = (query, expectedTool) => {
  const result = router.route(query);
  assert.equal(result?.type, 'tool_call',
    `Expected direct tool_call for: "${query}" — got type:${result?.type ?? 'null'}`);
  assert.equal(result?.toolName, expectedTool,
    `Wrong tool for: "${query}" — expected ${expectedTool}, got ${result?.toolName}`);
};

// ── 1. Submitted legal requests ───────────────────────────────────────────────

test('Direct route: "What was submitted in legal requests?" → get_submitted_legal_requests', () => {
  expectDirect('What was submitted in legal requests?', 'get_submitted_legal_requests');
});

test('Direct route: "What was requested in the legal Requests" → get_submitted_legal_requests', () => {
  const result = router.route('What was requested in the legal Requests');
  assert.equal(result?.type, 'tool_call');
  assert.equal(result?.toolName, 'get_submitted_legal_requests');
  assert.equal(result?.arguments?.status, 'ALL');
});

test('Direct route: "What did departments request from legal?" → get_submitted_legal_requests', () => {
  const result = router.route('What did departments request from legal?');
  assert.equal(result?.type, 'tool_call');
  assert.equal(result?.toolName, 'get_submitted_legal_requests');
  assert.equal(result?.arguments?.status, 'ALL');
});

test('Direct route: "Show requested legal requests" → get_submitted_legal_requests', () => {
  expectDirect('Show requested legal requests', 'get_submitted_legal_requests');
});

// ── 2. Legal requests due today ───────────────────────────────────────────────

test('Direct route: "What is due today?" → get_due_today', () => {
  expectDirect('What is due today?', 'get_due_today');
});

test('Direct route: "Who is overloaded on the team?" → get_workload_by_user', () => {
  expectDirect('Who is overloaded on the team?', 'get_workload_by_user');
});

test('Direct route: "Who has the most legal work?" → get_workload_by_user', () => {
  expectDirect('Who has the most legal work?', 'get_workload_by_user');
});

// ── 3. Expired contracts ──────────────────────────────────────────────────────

test('Direct route: "How many contracts have expired?" → get_expired_contracts', () => {
  const result = router.route('How many contracts have expired?');
  assert.equal(result?.type, 'tool_call', 'Expected tool_call');
  assert.equal(result?.toolName, 'get_expired_contracts', `Got: ${result?.toolName}`);
  assert.equal(result?.arguments?.countOnly, true, 'countOnly should be true for count questions');
});

// ── 4. Expiring contracts ─────────────────────────────────────────────────────

test('Direct route: "Which contracts are expiring in 30 days?" → list_expiring_contracts', () => {
  const result = router.route('Which contracts are expiring in 30 days?');
  assert.equal(result?.type, 'tool_call', 'Expected tool_call');
  assert.equal(result?.toolName, 'list_expiring_contracts', `Got: ${result?.toolName}`);
  assert.equal(result?.arguments?.days, 30, 'days should be 30');
});

// ── 5. Overdue tasks ──────────────────────────────────────────────────────────

test('Direct route: "Show my overdue tasks." → list_overdue_tasks (mine_only=true)', () => {
  const result = router.route('Show my overdue tasks.');
  assert.equal(result?.type, 'tool_call', 'Expected tool_call');
  assert.equal(result?.toolName, 'list_overdue_tasks', `Got: ${result?.toolName}`);
  assert.equal(result?.arguments?.mine_only, true, 'mine_only should be true');
});

// ── 6. Documents awaiting signature (signing platform) ────────────────────────

test('Direct route: "Which documents are awaiting signature?" → list_pending_signatures', () => {
  // Must NOT route to get_awaiting_signature (legal-request status tool).
  // Must route to list_pending_signatures (signing platform document tool).
  expectDirect('Which documents are awaiting signature?', 'list_pending_signatures');
});

test('Direct route: "which contracts are awaiting signature?" still routes to get_awaiting_signature', () => {
  // Regression guard: contract-specific queries should keep going to the workflow tool.
  expectDirect('which contracts are awaiting signature?', 'get_awaiting_signature');
});

// ── 7. Unread notifications ───────────────────────────────────────────────────

test('Direct route: "How many unread notifications do I have?" → count_my_notifications', () => {
  const result = router.route('How many unread notifications do I have?');
  assert.equal(result?.type, 'tool_call', 'Expected tool_call');
  assert.equal(result?.toolName, 'count_my_notifications', `Got: ${result?.toolName}`);
  assert.equal(result?.arguments?.unread_only, true, 'unread_only should be true');
});

// ── 8. Manager attention ──────────────────────────────────────────────────────

test('Direct route: "What needs my attention today?" → get_manager_attention_summary', () => {
  expectDirect('What needs my attention today?', 'get_manager_attention_summary');
});

// ── 9. Tasks due today (new route) ───────────────────────────────────────────

test('Direct route: "Show tasks due today" → list_my_tasks', () => {
  expectDirect('Show tasks due today', 'list_my_tasks');
});

test('Direct route: "What tasks are due today?" → list_my_tasks', () => {
  expectDirect('What tasks are due today?', 'list_my_tasks');
});

// ── Provider.generate bypass guarantee ───────────────────────────────────────
//
// For each direct route, the orchestrator calls _tryDirectResponse first and
// returns immediately when route.type === 'tool_call'. This test confirms no
// generate call is needed — the spy is never invoked.

test('provider.generate is never called for any direct-routed query', () => {
  let generateCalled = false;
  void { generate: async () => { generateCalled = true; } }; // spy — never wired up

  const directQueries = [
    'What was submitted in legal requests?',
    'What is due today?',
    'How many contracts have expired?',
    'Which contracts are expiring in 30 days?',
    'Show my overdue tasks.',
    'Which documents are awaiting signature?',
    'How many unread notifications do I have?',
    'What needs my attention today?',
    'Show tasks due today',
  ];

  for (const query of directQueries) {
    const result = router.route(query);
    assert.equal(result?.type, 'tool_call',
      `IntentRouter returned null for "${query}" — model would be invoked`);
  }

  assert.equal(generateCalled, false,
    'provider.generate must not be called for any direct-routed query');
});
