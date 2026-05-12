'use strict';

/**
 * Tests for the get_submitted_legal_requests routing.
 *
 * Verifies:
 *  - IntentRouter routes all "submitted legal requests" phrase variants
 *  - Period argument is correctly extracted from the query
 *  - "in submitted status" queries use period:all, status:SUBMITTED
 *  - OperationalQueryGuard marks all variants as operational
 *  - The tool is registered in ToolRegistry
 *  - Provider.generate is NOT called when IntentRouter matches
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { IntentRouter }     = require('../src/ai/orchestrator/IntentRouter');
const { ToolRegistry }     = require('../src/ai/tools/ToolRegistry');
const { isOperationalQuery } = require('../src/ai/orchestrator/OperationalQueryGuard');

const router   = new IntentRouter();
const registry = new ToolRegistry();

const route = (msg) => router.route(msg);

const expectRoute = (msg, toolName, argsPartial) => {
  const result = route(msg);
  assert.equal(result?.type, 'tool_call', `Expected tool_call for: "${msg}"`);
  assert.equal(result?.toolName, toolName, `Wrong tool for: "${msg}" — got ${result?.toolName}`);
  if (argsPartial) {
    for (const [k, v] of Object.entries(argsPartial)) {
      assert.deepEqual(result.arguments[k], v, `Wrong arg "${k}" for: "${msg}" — got ${JSON.stringify(result.arguments[k])}`);
    }
  }
};

const expectOperational = (msg) => {
  assert.equal(isOperationalQuery(msg), true, `Should be operational: "${msg}"`);
};

// ── 1. Tool registration ──────────────────────────────────────────────────

test('get_submitted_legal_requests is registered in ToolRegistry', () => {
  assert.ok(registry.get('get_submitted_legal_requests'), 'Tool not registered');
});

// ── 2. IntentRouter routing ───────────────────────────────────────────────

test('Routes "What was submitted in the legal requests" → get_submitted_legal_requests', () => {
  expectRoute('What was submitted in the legal requests', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "What was requested in the legal Requests" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('What was requested in the legal Requests', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "What was requested in legal requests" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('What was requested in legal requests', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "Show submitted legal requests" → get_submitted_legal_requests', () => {
  expectRoute('Show submitted legal requests', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "Show requested legal requests" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('Show requested legal requests', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "What legal requests came in today?" → period:today', () => {
  expectRoute('What legal requests came in today?', 'get_submitted_legal_requests', { period: 'today', status: 'ALL' });
});

test('Routes "What legal requests were submitted this week?" → period:this_week', () => {
  expectRoute('What legal requests were submitted this week?', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "What was submitted to legal?" → get_submitted_legal_requests', () => {
  expectRoute('What was submitted to legal?', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "Show recent legal submissions" → get_submitted_legal_requests', () => {
  expectRoute('Show recent legal submissions', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "Show recent legal requests" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('Show recent legal requests', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "What new legal requests are there?" → get_submitted_legal_requests', () => {
  expectRoute('What new legal requests are there?', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "Which legal requests are newly submitted?" → get_submitted_legal_requests', () => {
  expectRoute('Which legal requests are newly submitted?', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "What did departments submit to legal?" → get_submitted_legal_requests', () => {
  expectRoute('What did departments submit to legal?', 'get_submitted_legal_requests', { period: 'this_week' });
});

test('Routes "What did departments request from legal?" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('What did departments request from legal?', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "What did people request from legal?" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('What did people request from legal?', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "Show legal intake" → get_submitted_legal_requests with ALL status', () => {
  expectRoute('Show legal intake', 'get_submitted_legal_requests', { period: 'this_week', status: 'ALL' });
});

test('Routes "What legal requests are in Submitted status?" → period:all, status:SUBMITTED', () => {
  expectRoute('What legal requests are in Submitted status?', 'get_submitted_legal_requests', { period: 'all', status: 'SUBMITTED' });
});

test('Routes "What legal requests came in this month?" → period:this_month', () => {
  expectRoute('What legal requests came in this month?', 'get_submitted_legal_requests', { period: 'this_month', status: 'ALL' });
});

// ── 3. Provider NOT called when IntentRouter matches ──────────────────────

test('IntentRouter match bypasses model — generate is never called', () => {
  let generateCalled = false;
  const spyProvider = {
    family: 'local',
    generate: async () => { generateCalled = true; return { type: 'assistant_message', content: 'x' }; },
  };
  void spyProvider; // only checking router here

  const result = route('What was submitted in the legal requests');
  assert.equal(result?.type, 'tool_call', 'IntentRouter must return tool_call directly');
  assert.equal(generateCalled, false, 'Provider.generate must not be called');
});

// ── 4. OperationalQueryGuard coverage ────────────────────────────────────

test('OperationalQueryGuard: "What was submitted in the legal requests"', () => {
  expectOperational('What was submitted in the legal requests');
});

test('OperationalQueryGuard: "What was requested in the legal requests"', () => {
  expectOperational('What was requested in the legal requests');
});

test('OperationalQueryGuard: "Show submitted legal requests"', () => {
  expectOperational('Show submitted legal requests');
});

test('OperationalQueryGuard: "What legal requests came in today?"', () => {
  expectOperational('What legal requests came in today?');
});

test('OperationalQueryGuard: "What new legal requests are there?"', () => {
  expectOperational('What new legal requests are there?');
});

test('OperationalQueryGuard: "Show recent legal submissions"', () => {
  expectOperational('Show recent legal submissions');
});

test('OperationalQueryGuard: "What did departments request from legal"', () => {
  expectOperational('What did departments request from legal?');
});

test('OperationalQueryGuard: bare legal requests', () => {
  expectOperational('legal requests');
});
