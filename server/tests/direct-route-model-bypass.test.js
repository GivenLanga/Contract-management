'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ACTIVE_MODEL_PROVIDER = 'mock';
process.env.NODE_ENV = 'test';
process.env.AI_DEBUG_TIMING = 'true';

const { AssistantOrchestrator } = require('../src/ai/orchestrator/AssistantOrchestrator');

const mockUser = {
  _id: 'u1',
  role: 'admin',
  email: 'admin@example.com',
  name: 'Admin User',
};

const makeOrchestrator = () => {
  const orch = new AssistantOrchestrator({ modelTimeoutMs: 50, retryTimeoutMs: 50, totalTimeoutMs: 200 });
  let generateCalls = 0;
  orch._provider = {
    family: 'local',
    generate: async () => {
      generateCalls += 1;
      return { type: 'assistant_message', content: 'model should not run' };
    },
    healthCheck: async () => ({ healthy: true }),
  };
  orch._handleToolCall = async (toolCall) => ({
    type: 'success',
    data: { toolName: toolCall.toolName, arguments: toolCall.arguments },
  });
  orch._rag = {
    shouldRetrieve: () => { throw new Error('RAG should not run for direct routes.'); },
    retrieve: async () => { throw new Error('RAG should not run for direct routes.'); },
    getCounts: async () => ({ syncedDocuments: 0, serverDocuments: 0 }),
  };
  orch._backendRag = {
    shouldRetrieve: () => { throw new Error('Backend RAG should not run for direct routes.'); },
    retrieve: async () => { throw new Error('Backend RAG should not run for direct routes.'); },
  };
  orch._audit = {
    logToolCall: async () => {},
    logSecurityEvent: async () => {},
    logRagRetrieval: async () => {},
    logAiTimeout: async () => {},
  };
  return { orch, getGenerateCalls: () => generateCalls };
};

const chatArgs = (message) => ({
  sessionId: `sess-${message}`,
  message,
  user: mockUser,
  ipAddress: '127.0.0.1',
});

for (const [message, toolName] of [
  ['What was requested in the legal Requests', 'query_legal_requests'],
  ['What do i have in the legal requests', 'query_legal_requests'],
  ['What task are in the legal requests', 'get_legal_request_tasks'],
  ['Who is overloaded on the team?', 'get_workload_by_user'],
  ['What needs my attention today?', 'get_manager_attention_summary'],
  ['What is due today?', 'get_due_today'],
  ['How many documents have expired?', 'query_documents'],
  ["What's the legal team's progress this month?", 'get_legal_team_progress'],
  ['How many agreements are active?', 'query_contracts'],
  ["What's the total value of the all the contracts?", 'query_contract_value'],
  ['Whats urgent in the legal requests', 'query_legal_requests'],
  ['In the legal requests, what did finance ask for and when do they want it', 'query_legal_requests'],
]) {
  test(`direct route bypasses model for "${message}"`, async () => {
    const { orch, getGenerateCalls } = makeOrchestrator();
    const startedAt = Date.now();
    const result = await orch.chat(chatArgs(message));

    assert.equal(getGenerateCalls(), 0);
    assert.equal(result.type, 'success');
    assert.equal(result.data.toolName, toolName);
    assert.equal(result._timing.modelSkipped, true);
    assert.equal(result._timing.ragSkipped, true);
    assert.equal(result._timing.tool, toolName);
    assert.equal(Date.now() - startedAt < 1500, true);
  });
}

test('underspecified drafting request returns fast clarification without model', async () => {
  const { orch, getGenerateCalls } = makeOrchestrator();
  const result = await orch.chat(chatArgs('draft an addendum'));

  assert.equal(getGenerateCalls(), 0);
  assert.equal(result.type, 'clarification_required');
  assert.equal(result._timing.modelSkipped, true);
  assert.equal(result._timing.ragSkipped, true);
});
