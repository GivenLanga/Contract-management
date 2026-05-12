'use strict';
/**
 * AI Contract QA test suite.
 *
 * Tests IntentRouter routing, OperationalQueryGuard coverage, and tool-level
 * date/filter logic for 37+ realistic contract-management questions.
 *
 * Seeded mock data verifies the expired vs. expiring distinction with known dates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { IntentRouter } = require('../src/ai/orchestrator/IntentRouter');
const { ToolRegistry } = require('../src/ai/tools/ToolRegistry');
const { isOperationalQuery } = require('../src/ai/orchestrator/OperationalQueryGuard');
const contractTools = require('../src/ai/tools/contracts.tools');
const Contract = require('../src/models/Contract');
const Document = require('../src/models/Document');

const router = new IntentRouter();
const registry = new ToolRegistry();
const route = (msg) => router.route(msg);

// ── Helpers ────────────────────────────────────────────────────────────────

const expectRoute = (msg, toolName, argsPartial) => {
  const result = route(msg);
  assert.equal(result?.type, 'tool_call', `Expected tool_call for: "${msg}"`);
  assert.equal(result?.toolName, toolName, `Wrong tool for: "${msg}" — got ${result?.toolName}`);
  if (argsPartial) {
    for (const [k, v] of Object.entries(argsPartial)) {
      assert.deepEqual(result.arguments[k], v, `Wrong arg ${k} for: "${msg}"`);
    }
  }
};

const expectRegistered = (toolName) => {
  assert.ok(registry.get(toolName), `Tool not registered: ${toolName}`);
};

const expectOperational = (msg) => {
  assert.equal(isOperationalQuery(msg), true, `Should be operational query: "${msg}"`);
};

// ── 1. Tool registration ───────────────────────────────────────────────────

test('All new contract tools are registered in ToolRegistry', () => {
  for (const name of [
    'get_contract_status_summary',
    'get_contract_value_summary',
    'get_contracts_by_type',
    'get_contracts_by_counterparty',
    'get_contract_renewal_candidates',
    'get_contracts_missing_signed_copy',
    'get_contract_management_summary',
  ]) {
    expectRegistered(name);
  }
});

// ── 2. Expired vs. expiring disambiguation (critical) ─────────────────────

test('Expired count question routes to get_expired_contracts', () => {
  expectRoute('How many contracts have expired?', 'get_expired_contracts', { countOnly: true });
});

test('Expired list question routes to get_expired_contracts', () => {
  expectRoute('Show expired contracts', 'get_expired_contracts', { countOnly: false });
  expectRoute('Which contracts are already expired?', 'get_expired_contracts', { countOnly: false });
  expectRoute('List all past expiry contracts', 'get_expired_contracts');
});

test('Expiring-soon question routes to expiring tools, NOT expired', () => {
  const r30 = route('Which contracts are expiring in 30 days?');
  assert.equal(r30?.toolName, 'list_expiring_contracts');
  assert.notEqual(r30?.toolName, 'get_expired_contracts');

  const c30 = route('How many contracts expire in 30 days?');
  assert.equal(c30?.toolName, 'count_expiring_contracts');
  assert.notEqual(c30?.toolName, 'get_expired_contracts');
});

test('Expiring-soon question passes correct days argument', () => {
  expectRoute('Which contracts expire in the next 30 days?', 'list_expiring_contracts', { days: 30 });
  expectRoute('How many contracts expire in 90 days?', 'count_expiring_contracts', { days: 90 });
  expectRoute('Which contracts expire in the next 3 months?', 'list_expiring_contracts', { days: 90 });
});

test('"expires this month" routes to list_expiring_contracts with ~30 days', () => {
  const r = route('Which contracts expire this month?');
  assert.equal(r?.toolName, 'list_expiring_contracts');
  assert.ok(r?.arguments?.days >= 28 && r?.arguments?.days <= 31, 'days should be ~30');
});

test('"expire soon" routes to expiring, not expired', () => {
  const r = route('Which contracts expire soon?');
  assert.equal(r?.toolName, 'list_expiring_contracts');
  assert.notEqual(r?.toolName, 'get_expired_contracts');
});

// ── 3. Contract status queries ─────────────────────────────────────────────

test('"active contracts" routes to get_contract_status_summary with status=Active', () => {
  expectRoute('How many active contracts are there?', 'get_contract_status_summary', { status: 'Active' });
  expectRoute('Show active contracts', 'get_contract_status_summary', { status: 'Active' });
  expectRoute('Which contracts are active?', 'get_contract_status_summary', { status: 'Active' });
});

test('"draft contracts" routes to get_contract_status_summary with status=Draft', () => {
  expectRoute('Show draft contracts', 'get_contract_status_summary', { status: 'Draft' });
  expectRoute('How many contracts are in draft?', 'get_contract_status_summary', { status: 'Draft' });
});

test('"under review" contracts route correctly', () => {
  expectRoute('Which contracts are under review?', 'get_contract_status_summary', { status: 'Under Review' });
});

test('"pending approval" contracts route correctly', () => {
  expectRoute('Which contracts are pending approval?', 'get_contract_status_summary', { status: 'Pending Approval' });
});

test('Generic status breakdown routes to get_contract_status_summary with no args', () => {
  expectRoute('Give me a contract status breakdown', 'get_contract_status_summary', {});
  expectRoute('Show contracts by status', 'get_contract_status_summary', {});
});

// ── 4. Contract value queries ──────────────────────────────────────────────

test('"total value of active contracts" routes to get_contract_value_summary', () => {
  expectRoute('What is the total value of active contracts?', 'get_contract_value_summary', { status: 'Active' });
});

test('"value of expired contracts" routes to get_contract_value_summary', () => {
  expectRoute('What is the value of expired contracts?', 'get_contract_value_summary', { status: 'Expired' });
});

test('"contract value" without status routes to get_contract_value_summary with no args', () => {
  const r = route('What is the total contract value?');
  assert.equal(r?.toolName, 'get_contract_value_summary');
});

// ── 5. Contract type/category queries ─────────────────────────────────────

test('"loan agreements" routes to get_contracts_by_type with LOAN_AGREEMENT', () => {
  expectRoute('Show me all loan agreements', 'get_contracts_by_type', { contractType: 'LOAN_AGREEMENT' });
  expectRoute('List loan agreements', 'get_contracts_by_type', { contractType: 'LOAN_AGREEMENT' });
});

test('"grant agreements" routes to get_contracts_by_type with GRANT_AGREEMENT', () => {
  expectRoute('Show me all grant agreements', 'get_contracts_by_type', { contractType: 'GRANT_AGREEMENT' });
});

test('"service provider agreements" routes correctly', () => {
  expectRoute('Show service provider agreements', 'get_contracts_by_type', { contractType: 'SERVICE_PROVIDER_AGREEMENT' });
});

test('"NDAs" routes to get_contracts_by_type with NDA', () => {
  expectRoute('Show me all NDAs', 'get_contracts_by_type', { contractType: 'NDA' });
  expectRoute('List non-disclosure agreements', 'get_contracts_by_type', { contractType: 'NDA' });
});

test('"lease agreements" routes to get_contracts_by_type with LEASE_AGREEMENT', () => {
  expectRoute('Show lease agreements', 'get_contracts_by_type', { contractType: 'LEASE_AGREEMENT' });
});

test('"MSA contracts" routes to get_contracts_by_type with MSA', () => {
  expectRoute('Show all MSA contracts', 'get_contracts_by_type', { contractType: 'MSA' });
  expectRoute('List master service agreements', 'get_contracts_by_type', { contractType: 'MSA' });
});

test('"software licenses" routes to get_contracts_by_type with SOFTWARE_LICENSE', () => {
  expectRoute('Show software licenses', 'get_contracts_by_type', { contractType: 'SOFTWARE_LICENSE' });
});

// ── 6. Counterparty queries ────────────────────────────────────────────────

test('"contracts with [company]" routes to get_contracts_by_counterparty', () => {
  const r = route('Show contracts with ThaboTech');
  assert.equal(r?.toolName, 'get_contracts_by_counterparty');
  assert.ok(r?.arguments?.counterparty?.toLowerCase().includes('thabotech'), 'Should include counterparty name');
});

test('"agreements for [company]" routes to get_contracts_by_counterparty', () => {
  const r = route('Show agreements for Acme Corp');
  assert.equal(r?.toolName, 'get_contracts_by_counterparty');
  assert.ok(r?.arguments?.counterparty?.toLowerCase().includes('acme'), 'Should include counterparty name');
});

// ── 7. Renewal queries ─────────────────────────────────────────────────────

test('"contracts needing renewal" routes to get_contract_renewal_candidates', () => {
  expectRoute('Which contracts need renewal?', 'get_contract_renewal_candidates');
  expectRoute('Which contracts are up for renewal?', 'get_contract_renewal_candidates');
  expectRoute('Which expired contracts should be renewed?', 'get_contract_renewal_candidates');
  expectRoute('Show renewal candidates', 'get_contract_renewal_candidates');
});

// ── 8. Missing signed copy ─────────────────────────────────────────────────

test('"missing signed copy" routes to get_contracts_missing_signed_copy', () => {
  expectRoute('Which contracts are missing signed copies?', 'get_contracts_missing_signed_copy');
  expectRoute('Show contracts with no signed copy', 'get_contracts_missing_signed_copy');
  expectRoute('Which contracts have no signed document?', 'get_contracts_missing_signed_copy');
});

// ── 9. Management summary ──────────────────────────────────────────────────

test('Contract management summary routes to get_contract_management_summary', () => {
  expectRoute('Give me a contract management summary', 'get_contract_management_summary');
  expectRoute('What is the overall contract health?', 'get_contract_management_summary');
  expectRoute('Show the contract overview', 'get_contract_management_summary');
});

// ── 10. Awaiting signature — contract context vs. document platform context ─

test('"contracts awaiting signature" does NOT route to signing platform document tool', () => {
  const r = route('Which contracts are awaiting signature?');
  assert.notEqual(r?.toolName, 'list_pending_signatures',
    '"contracts awaiting signature" should not route to document signing platform');
  assert.notEqual(r?.toolName, 'count_documents_in_signing_platform');
});

test('"documents pending signature" still routes to signing platform tool', () => {
  const r = route('Show documents pending signature');
  assert.equal(r?.toolName, 'list_pending_signatures');
});

// ── 11. OperationalQueryGuard coverage ────────────────────────────────────

test('OperationalQueryGuard detects contract management questions', () => {
  expectOperational('How many contracts have expired?');
  expectOperational('Which contracts expire soon?');
  expectOperational('How many active contracts are there?');
  expectOperational('What is the total value of active contracts?');
  expectOperational('Show loan agreements');
  expectOperational('Which contracts need renewal?');
  expectOperational('Which contracts are missing signed copies?');
  expectOperational('Show contracts with ThaboTech');
  expectOperational('Give me a contract management summary');
  expectOperational('Which contracts are under review?');
});

// ── 12. Seeded mock-data: expired vs. expiring date logic ──────────────────

test('get_expired_contracts: past-date and Expired-status contracts are counted; future contracts are not', async () => {
  const TODAY = new Date('2026-05-12T00:00:00.000Z'); // fixed test date

  const mockContracts = [
    // A: Explicitly Expired status — must be counted
    { _id: 'A', status: 'Expired',  expiryDate: new Date('2026-04-01'), endDate: null },
    // B: Active status but expiryDate in the PAST — must be counted
    { _id: 'B', status: 'Active',   expiryDate: new Date('2026-05-10'), endDate: null },
    // C: Active, expires in 5 days (future) — must NOT be in expired count
    { _id: 'C', status: 'Active',   expiryDate: new Date('2026-05-17'), endDate: null },
    // D: Active, expires in 120 days — must NOT be in expired count
    { _id: 'D', status: 'Active',   expiryDate: new Date('2026-09-10'), endDate: null },
    // E: Active, endDate in the past, no expiryDate — must be counted
    { _id: 'E', status: 'Active',   expiryDate: null, endDate: new Date('2026-05-11') },
    // F: No expiry date, Active — must NOT be in expired count
    { _id: 'F', status: 'Active',   expiryDate: null, endDate: null },
  ];

  const originalCount = Contract.countDocuments;
  const originalFind  = Contract.find;

  let capturedExpiredFilter;
  Contract.countDocuments = async (filter) => {
    capturedExpiredFilter = filter;
    // Simulate: count documents matching the filter against our mock set
    return mockContracts.filter((c) => {
      const beforeToday = (d) => d && new Date(d) < TODAY;
      return (
        c.status === 'Expired' ||
        beforeToday(c.expiryDate) ||
        beforeToday(c.endDate)
      );
    }).length;
  };
  Contract.find = () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });

  try {
    const tool = contractTools.find((t) => t.name === 'get_expired_contracts');
    const result = await tool.execute({ countOnly: true }, { user: { role: 'admin' } });

    // A + B + E = 3 expired
    assert.equal(result.data.count, 3, 'Expired count should be 3 (A=Expired status, B=past expiryDate, E=past endDate)');
    assert.equal(result.data.mode, 'expired');
    assert.ok(
      result.data.message.includes('have expired') || result.data.message.includes('has expired'),
      `Message should say "have expired" not "expiring soon": "${result.data.message}"`
    );
    assert.ok(!result.data.message.toLowerCase().includes('expiring within'),
      `Expired result must not say "expiring within": "${result.data.message}"`);

    // Verify the filter structure uses past-date semantics
    const orClauses = capturedExpiredFilter.$or || [];
    const hasStatusClause  = orClauses.some((c) => c.status === 'Expired');
    const hasExpiryClause  = orClauses.some((c) => c.expiryDate?.$lt instanceof Date);
    const hasEndDateClause = orClauses.some((c) => c.endDate?.$lt instanceof Date);
    assert.ok(hasStatusClause,  'Filter must check status === "Expired"');
    assert.ok(hasExpiryClause,  'Filter must check expiryDate < today');
    assert.ok(hasEndDateClause, 'Filter must check endDate < today');
  } finally {
    Contract.countDocuments = originalCount;
    Contract.find = originalFind;
  }
});

test('count_expiring_contracts: only future-window contracts are counted', async () => {
  const TODAY = new Date('2026-05-12T00:00:00.000Z');

  const mockContracts = [
    // A: Already expired — must NOT be in expiring count
    { _id: 'A', status: 'Expired',  expiryDate: new Date('2026-04-01') },
    // B: Expires in 5 days — must be in 30-day expiring count
    { _id: 'B', status: 'Active',   expiryDate: new Date('2026-05-17') },
    // C: Expires in 25 days — must be in 30-day expiring count
    { _id: 'C', status: 'Active',   expiryDate: new Date('2026-06-06') },
    // D: Expires in 100 days — must NOT be in 30-day expiring count
    { _id: 'D', status: 'Active',   expiryDate: new Date('2026-08-20') },
    // E: Past expiryDate, Active status — must NOT be in expiring count
    { _id: 'E', status: 'Active',   expiryDate: new Date('2026-05-10') },
  ];

  const original = Contract.countDocuments;
  let capturedFilter;
  Contract.countDocuments = async (filter) => {
    capturedFilter = filter;
    const from = TODAY;
    const to   = new Date(TODAY.getTime() + 30 * 86400000);
    return mockContracts.filter((c) => {
      if (['Terminated', 'Cancelled', 'Expired'].includes(c.status)) return false;
      const inWindow = (d) => d && new Date(d) >= from && new Date(d) <= to;
      return inWindow(c.expiryDate) || inWindow(c.endDate);
    }).length;
  };

  try {
    const tool = contractTools.find((t) => t.name === 'count_expiring_contracts');
    const result = await tool.execute({ days: 30 }, { user: { role: 'admin' } });

    // B + C = 2 expiring within 30 days
    assert.equal(result.data.count, 2, 'Expiring count should be 2 (B=5d, C=25d); not A or E (past) or D (100d)');
    assert.equal(result.data.mode, 'expiring');
    assert.ok(
      result.data.message.includes('expiring within'),
      `Message should say "expiring within": "${result.data.message}"`
    );
    assert.ok(!result.data.message.toLowerCase().includes('have expired'),
      `Expiring message must not say "have expired": "${result.data.message}"`);

    // Filter must exclude Expired/Terminated/Cancelled status
    assert.ok(capturedFilter.status?.$nin?.includes('Expired'), 'Filter must exclude Expired status');
    // Filter must use future-date bounds
    const orClauses = capturedFilter.$or || [];
    const expiryClause = orClauses.find((c) => c.expiryDate);
    assert.ok(expiryClause?.expiryDate?.$gte instanceof Date, 'Filter must have expiryDate.$gte (future start)');
    assert.ok(expiryClause?.expiryDate?.$lte instanceof Date, 'Filter must have expiryDate.$lte (future end)');
    // Allow ±24h to account for timezone differences in startOfToday()
    const dayBefore = new Date(TODAY.getTime() - 86400000);
    assert.ok(
      expiryClause.expiryDate.$gte >= dayBefore,
      'expiryDate.$gte must be within 24h before today (timezone-safe check)'
    );
  } finally {
    Contract.countDocuments = original;
  }
});

test('get_contract_renewal_candidates: returns both expired and expiring-soon contracts', async () => {
  const original = Contract.countDocuments;
  let capturedFilter;
  Contract.countDocuments = async (filter) => {
    capturedFilter = filter;
    return 4;
  };
  const origFind = Contract.find;
  Contract.find = () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });

  try {
    const tool = contractTools.find((t) => t.name === 'get_contract_renewal_candidates');
    const result = await tool.execute({ days: 60 }, { user: { role: 'admin' } });

    assert.equal(result.type, 'contract_summary');
    assert.equal(result.category, 'renewal_candidates');
    assert.ok(result.summary.includes('renewal'), `Summary should mention renewal: "${result.summary}"`);
    assert.equal(result.metrics.count, 4);

    // Filter must include both past and future dates (expired + expiring soon)
    const orClauses = capturedFilter.$or || [];
    const hasExpiredStatus = orClauses.some((c) => c.status === 'Expired');
    const hasPastDate      = orClauses.some((c) => c.expiryDate?.$lt instanceof Date);
    const hasFutureDate    = orClauses.some((c) => c.expiryDate?.$gte instanceof Date);
    assert.ok(hasExpiredStatus, 'Renewal filter must include Expired status');
    assert.ok(hasPastDate,      'Renewal filter must include past dates');
    assert.ok(hasFutureDate,    'Renewal filter must include future dates');
    // Must exclude auto-renew contracts
    assert.deepEqual(capturedFilter.autoRenew, { $ne: true }, 'Renewal filter must exclude autoRenew=true');
  } finally {
    Contract.countDocuments = original;
    Contract.find = origFind;
  }
});

test('get_contract_management_summary returns correct structure', async () => {
  const mockCounts = {
    active: 12, draft: 3, expired: 5, expiringSoon: 2,
    pendingSignature: 1, missingSignedCopy: 4, renewalCandidates: 6,
  };
  let callIndex = 0;
  const originalCount   = Contract.countDocuments;
  const originalAggregate = Contract.aggregate;
  const originalDistinct  = Document.distinct;

  Document.distinct = async () => [];
  Contract.countDocuments = async () => {
    const vals = [
      mockCounts.active, mockCounts.draft, mockCounts.expired,
      mockCounts.expiringSoon, mockCounts.pendingSignature,
      mockCounts.missingSignedCopy, mockCounts.renewalCandidates,
    ];
    return vals[callIndex++] ?? 0;
  };
  Contract.aggregate = async () => [{ totalValue: 2450000, currency: 'ZAR' }];

  try {
    const tool = contractTools.find((t) => t.name === 'get_contract_management_summary');
    const result = await tool.execute({}, { user: { role: 'admin' } });

    assert.equal(result.type, 'contract_management_summary');
    assert.equal(result.category, 'contract_health');
    assert.equal(result.metrics.active, 12);
    assert.equal(result.metrics.expired, 5);
    assert.equal(result.metrics.expiringSoon, 2);
    assert.equal(result.metrics.totalActiveValue, 2450000);
    assert.ok(result.summary.includes('12 active'), `Summary must show active count: "${result.summary}"`);
    assert.ok(result.summary.includes('ZAR'), `Summary must show currency: "${result.summary}"`);
  } finally {
    Contract.countDocuments = originalCount;
    Contract.aggregate = originalAggregate;
    Document.distinct = originalDistinct;
  }
});

test('get_contract_status_summary with status arg returns count for that status', async () => {
  const original = Contract.countDocuments;
  Contract.countDocuments = async () => 7;
  try {
    const tool = contractTools.find((t) => t.name === 'get_contract_status_summary');
    const result = await tool.execute({ status: 'Active' }, { user: { role: 'admin' } });
    assert.equal(result.type, 'contract_summary');
    assert.equal(result.metrics.count, 7);
    assert.equal(result.metrics.status, 'Active');
    assert.ok(result.summary.includes('active'), `Summary should mention active: "${result.summary}"`);
  } finally {
    Contract.countDocuments = original;
  }
});

test('get_contract_value_summary returns correct total and currency', async () => {
  const original = Contract.aggregate;
  Contract.aggregate = async () => [{ totalValue: 1850000, count: 8, currency: 'ZAR' }];
  try {
    const tool = contractTools.find((t) => t.name === 'get_contract_value_summary');
    const result = await tool.execute({ status: 'Active' }, { user: { role: 'admin' } });
    assert.equal(result.type, 'contract_value_summary');
    assert.equal(result.metrics.totalValue, 1850000, 'Value should be 1850000');
    assert.equal(result.metrics.count, 8, 'Count should be 8');
    assert.equal(result.metrics.currency, 'ZAR', 'Currency should be ZAR');
    // toLocaleString() format varies by locale — just check the currency and that value digits appear
    assert.ok(result.summary.includes('ZAR'), 'Summary should include currency');
    assert.ok(result.summary.includes('8 contract'), 'Summary should mention count');
  } finally {
    Contract.aggregate = original;
  }
});

// ── 13. Response wording correctness ──────────────────────────────────────

test('get_expired_contracts message wording says "expired" not "expiring"', async () => {
  const original = Contract.countDocuments;
  Contract.countDocuments = async () => 5;
  const origFind = Contract.find;
  Contract.find = () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });
  try {
    const tool = contractTools.find((t) => t.name === 'get_expired_contracts');
    const result = await tool.execute({ countOnly: true }, { user: { role: 'admin' } });
    const msg = result.data.message.toLowerCase();
    assert.ok(msg.includes('have expired') || msg.includes('has expired'),
      `Should say "have expired": "${result.data.message}"`);
    assert.ok(!msg.includes('expiring within'), `Must not say "expiring within": "${result.data.message}"`);
    assert.ok(!msg.includes('expiring soon'),   `Must not say "expiring soon": "${result.data.message}"`);
  } finally {
    Contract.countDocuments = original;
    Contract.find = origFind;
  }
});

test('count_expiring_contracts message wording says "expiring within" not "expired"', async () => {
  const original = Contract.countDocuments;
  Contract.countDocuments = async () => 3;
  try {
    const tool = contractTools.find((t) => t.name === 'count_expiring_contracts');
    const result = await tool.execute({ days: 30 }, { user: { role: 'admin' } });
    const msg = result.data.message.toLowerCase();
    assert.ok(msg.includes('expiring within'), `Should say "expiring within": "${result.data.message}"`);
    assert.ok(!msg.includes('have expired'), `Must not say "have expired": "${result.data.message}"`);
  } finally {
    Contract.countDocuments = original;
  }
});

test('get_expired_contracts zero-count message is accurate', async () => {
  const original = Contract.countDocuments;
  Contract.countDocuments = async () => 0;
  const origFind = Contract.find;
  Contract.find = () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });
  try {
    const tool = contractTools.find((t) => t.name === 'get_expired_contracts');
    const result = await tool.execute({ countOnly: true }, { user: { role: 'admin' } });
    assert.ok(!result.data.message.toLowerCase().includes('expiring'),
      `Zero expired message must not say "expiring": "${result.data.message}"`);
  } finally {
    Contract.countDocuments = original;
    Contract.find = origFind;
  }
});

// ── 14. Contracts by type tool structure ──────────────────────────────────

test('get_contracts_by_type returns contract_summary type with contractType in metrics', async () => {
  const originalFind   = Contract.find;
  const originalLRFind = require('../src/models/LegalRequest').find;

  Contract.find = () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
  require('../src/models/LegalRequest').find = () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });

  try {
    const tool = contractTools.find((t) => t.name === 'get_contracts_by_type');
    const result = await tool.execute({ contractType: 'LOAN_AGREEMENT' }, { user: { role: 'admin' } });
    assert.equal(result.type, 'contract_summary');
    assert.equal(result.metrics.contractType, 'LOAN_AGREEMENT');
    assert.equal(result.category, 'contracts_by_type');
  } finally {
    Contract.find = originalFind;
    require('../src/models/LegalRequest').find = originalLRFind;
  }
});

// ── 15. Contracts by counterparty ─────────────────────────────────────────

test('get_contracts_by_counterparty returns contract_summary with counterparty in metrics', async () => {
  const originalFind   = Contract.find;
  const LegalRequest   = require('../src/models/LegalRequest');
  const originalLRFind = LegalRequest.find;

  Contract.find = () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([
    { _id: '1', title: 'ThaboTech Agreement', status: 'Active', parties: [{ name: 'ThaboTech', type: 'external', role: 'vendor', signingOrder: 1 }] },
  ]) }) }) });
  LegalRequest.find = () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });

  try {
    const tool = contractTools.find((t) => t.name === 'get_contracts_by_counterparty');
    const result = await tool.execute({ counterparty: 'ThaboTech' }, { user: { role: 'admin' } });
    assert.equal(result.type, 'contract_summary');
    assert.equal(result.metrics.counterparty, 'ThaboTech');
    assert.ok(result.metrics.count >= 1, 'Should find at least one match');
    assert.ok(result.summary.toLowerCase().includes('thabotech'), `Summary should mention counterparty: "${result.summary}"`);
  } finally {
    Contract.find = originalFind;
    LegalRequest.find = originalLRFind;
  }
});

// ── 16. Missing signed copy ────────────────────────────────────────────────

test('get_contracts_missing_signed_copy excludes contracts that have signed docs', async () => {
  const originalDistinct = Document.distinct;
  const originalCount    = Contract.countDocuments;
  const origFind         = Contract.find;

  Document.distinct = async () => ['contractId1', 'contractId2'];
  Contract.countDocuments = async (filter) => {
    // Verify that the filter excludes the known-signed IDs
    const excludedIds = filter._id?.$nin || filter.$and?.find((c) => c._id)?._id?.$nin || [];
    assert.ok(excludedIds.length > 0, 'Filter must exclude known signed contract IDs');
    return 2;
  };
  Contract.find = () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });

  try {
    const tool = contractTools.find((t) => t.name === 'get_contracts_missing_signed_copy');
    const result = await tool.execute({}, { user: { role: 'admin' } });
    assert.equal(result.type, 'contract_summary');
    assert.equal(result.category, 'missing_signed_copy');
    assert.equal(result.metrics.count, 2);
  } finally {
    Document.distinct = originalDistinct;
    Contract.countDocuments = originalCount;
    Contract.find = origFind;
  }
});
