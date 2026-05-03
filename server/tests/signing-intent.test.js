const test = require('node:test');
const assert = require('node:assert/strict');

const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');

test('IntentRouter routes current-user signing counts to my pending signature tool', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('how many contracts need my signature'), {
    type: 'tool_call',
    toolName: 'count_my_pending_signatures',
    arguments: {},
  });
});

test('IntentRouter routes current-user signing lists to my pending signature list tool', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('what do I need to sign?'), {
    type: 'tool_call',
    toolName: 'list_my_pending_signatures',
    arguments: { limit: 10 },
  });
});

test('IntentRouter routes external party signing questions to external pending signature tool', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('how many documents need external party signature?'), {
    type: 'tool_call',
    toolName: 'count_external_party_pending_signatures',
    arguments: {},
  });
});

test('IntentRouter handles signing platform count questions including common typo', () => {
  const router = new IntentRouter();

  assert.deepEqual(router.route('How many documents are in the signign platform?'), {
    type: 'tool_call',
    toolName: 'count_documents_in_signing_platform',
    arguments: {},
  });
});

test('IntentRouter leaves signing implementation questions for backend RAG/model handling', () => {
  const router = new IntentRouter();

  assert.equal(router.route('what fields are in the signing route implementation?'), null);
});
