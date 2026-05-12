const test = require('node:test');
const assert = require('node:assert/strict');

const Contract = require('../src/models/Contract');
const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');
const { ToolRegistry } = require('../src/ai/tools/ToolRegistry');
const contractTools = require('../src/ai/tools/contracts.tools');
const { isOperationalQuery } = require('../src/ai/orchestrator/OperationalQueryGuard');
const { MockProvider } = require('../src/ai/providers/MockProvider');

const router = new IntentRouter();

const route = (message) => router.route(message);

test('IntentRouter routes expired contract count questions to expired-contract tool', () => {
  assert.deepEqual(route('How many contracts have expired?'), {
    type: 'tool_call',
    toolName: 'get_expired_contracts',
    arguments: { countOnly: true },
  });
});

test('IntentRouter routes expired contract list questions to expired-contract tool', () => {
  assert.deepEqual(route('Show expired contracts'), {
    type: 'tool_call',
    toolName: 'get_expired_contracts',
    arguments: { countOnly: false, limit: 10 },
  });
  assert.deepEqual(route('Which contracts are already expired?'), {
    type: 'tool_call',
    toolName: 'get_expired_contracts',
    arguments: { countOnly: false, limit: 10 },
  });
});

test('IntentRouter keeps future expiring queries separate from expired queries', () => {
  assert.deepEqual(route('Which contracts are expiring in 30 days?'), {
    type: 'tool_call',
    toolName: 'list_expiring_contracts',
    arguments: { days: 30 },
  });
  assert.deepEqual(route('Which contracts expire soon?'), {
    type: 'tool_call',
    toolName: 'list_expiring_contracts',
    arguments: { days: 30 },
  });
  assert.deepEqual(route('How many contracts expire next month?'), {
    type: 'tool_call',
    toolName: 'count_expiring_contracts',
    arguments: { days: 30 },
  });
});

test('IntentRouter routes "expired AND need renewal" to renewal-candidates tool, not expiring tool', () => {
  // When the user says "expired and need renewal", the intent is RENEWAL (future action),
  // not just listing expired contracts. get_contract_renewal_candidates covers both expired
  // and soon-expiring contracts, which is the right answer for a renewal question.
  const result = route('How many contracts have expired and need renewal?');
  assert.equal(result?.type, 'tool_call');
  assert.equal(result?.toolName, 'get_contract_renewal_candidates',
    'Renewal language should route to renewal candidates, not just expired list');
  // Crucially: must never route to the expiring-soon tool
  assert.notEqual(result?.toolName, 'count_expiring_contracts',
    'Must not use expiring-soon tool for an expired/renewal question');
  assert.notEqual(result?.toolName, 'list_expiring_contracts',
    'Must not use expiring-soon tool for an expired/renewal question');
});

test('ToolRegistry registers dedicated expired-contract tool', () => {
  const registry = new ToolRegistry();
  assert.equal(Boolean(registry.get('get_expired_contracts')), true);
});

test('OperationalQueryGuard treats expired contract questions as live-data queries', () => {
  assert.equal(isOperationalQuery('How many contracts have expired?'), true);
  assert.equal(isOperationalQuery('Which contracts expire soon?'), true);
});

test('MockProvider distinguishes expired from expiring contracts', async () => {
  const provider = new MockProvider();
  const expired = await provider.generate({ messages: [{ role: 'user', content: 'How many contracts have expired?' }] });
  assert.equal(expired.toolName, 'get_expired_contracts');

  const expiring = await provider.generate({ messages: [{ role: 'user', content: 'How many contracts are expiring in 30 days?' }] });
  assert.equal(expiring.toolName, 'count_expiring_contracts');
});

test('count_expiring_contracts uses future expiry/end-date filtering', async () => {
  const tool = contractTools.find((candidate) => candidate.name === 'count_expiring_contracts');
  const original = Contract.countDocuments;
  let capturedFilter;
  Contract.countDocuments = async (filter) => {
    capturedFilter = filter;
    return 2;
  };

  try {
    const result = await tool.execute({ days: 30 }, { user: { role: 'admin' } });
    assert.equal(result.data.mode, 'expiring');
    assert.equal(result.data.message, '2 contracts are expiring within 30 days.');
    assert.equal(capturedFilter.status.$nin.includes('Expired'), true);
    assert.equal(capturedFilter.$or.length, 2);
    assert.ok(capturedFilter.$or[0].expiryDate.$gte instanceof Date);
    assert.ok(capturedFilter.$or[0].expiryDate.$lte instanceof Date);
    assert.ok(capturedFilter.$or[1].endDate.$gte instanceof Date);
    assert.ok(capturedFilter.$or[1].endDate.$lte instanceof Date);
  } finally {
    Contract.countDocuments = original;
  }
});

test('get_expired_contracts uses past expiry/end-date or Expired status filtering', async () => {
  const tool = contractTools.find((candidate) => candidate.name === 'get_expired_contracts');
  const original = Contract.countDocuments;
  let capturedFilter;
  Contract.countDocuments = async (filter) => {
    capturedFilter = filter;
    return 5;
  };

  try {
    const result = await tool.execute({ countOnly: true }, { user: { role: 'admin' } });
    assert.equal(result.data.mode, 'expired');
    assert.equal(result.data.message, '5 contracts have expired.');
    assert.equal(capturedFilter.$or.some((clause) => clause.status === 'Expired'), true);
    assert.equal(capturedFilter.$or.some((clause) => clause.expiryDate?.$lt instanceof Date), true);
    assert.equal(capturedFilter.$or.some((clause) => clause.endDate?.$lt instanceof Date), true);
  } finally {
    Contract.countDocuments = original;
  }
});
