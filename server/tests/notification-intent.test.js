const test = require('node:test');
const assert = require('node:assert/strict');

const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');

test('IntentRouter routes notification list questions to the notifications tool', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('what are my notifications?'), {
    type: 'tool_call',
    toolName: 'list_my_notifications',
    arguments: { unread_only: false, limit: 10 },
  });
});

test('IntentRouter routes unread notification counts to the count tool', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('how many unread notifications do I have?'), {
    type: 'tool_call',
    toolName: 'count_my_notifications',
    arguments: { unread_only: true },
  });
});

test('IntentRouter preserves explicit notification page navigation', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('open notifications'), {
    type: 'tool_call',
    toolName: 'navigate_to_page',
    arguments: { page: 'notifications' },
  });
});

test('IntentRouter leaves backend notification implementation questions for RAG/model handling', () => {
  const router = new IntentRouter();

  assert.equal(router.route('what fields are in the notification model?'), null);
});
