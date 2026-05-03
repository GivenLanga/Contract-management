const test = require('node:test');
const assert = require('node:assert/strict');

const { ToolCallParser } = require('../src/ai/parsing/ToolCallParser');

const registry = {
  get(name) {
    return name === 'search_contracts'
      ? {
        name,
        schema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
      }
      : null;
  },
};

test('ToolCallParser extracts embedded JSON tool calls', () => {
  const parser = new ToolCallParser();
  const call = parser.parse({
    type: 'assistant_message',
    content: 'Use this: {"type":"tool_call","toolName":"search_contracts","arguments":{"query":"NDA"}}',
  }, registry);

  assert.deepEqual(call, {
    toolName: 'search_contracts',
    arguments: { query: 'NDA' },
  });
});

test('ToolCallParser ignores unknown tools', () => {
  const parser = new ToolCallParser();
  const call = parser.parse({
    type: 'assistant_message',
    content: '{"type":"tool_call","toolName":"delete_everything","arguments":{}}',
  }, registry);

  assert.equal(call, null);
});

test('ToolCallParser coerces simple function-call syntax', () => {
  const parser = new ToolCallParser();
  const call = parser.parse({
    type: 'assistant_message',
    content: 'search_contracts("Vendor NDA")',
  }, registry);

  assert.deepEqual(call, {
    toolName: 'search_contracts',
    arguments: { query: 'Vendor NDA' },
  });
});
