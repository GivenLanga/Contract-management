'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const documentTools = require('../src/ai/tools/documents.tools');
const taskTools = require('../src/ai/tools/tasks.tools');
const overviewTools = require('../src/ai/tools/overview.tools');
const Contract = require('../src/models/Contract');
const Document = require('../src/models/Document');
const Task = require('../src/models/Task');

const findTool = (tools, name) => tools.find((tool) => tool.name === name);

test('get_expired_documents returns unsupported metadata instead of using model', async () => {
  const tool = findTool(documentTools, 'get_expired_documents');
  const result = await tool.execute({}, { user: { role: 'admin' } });

  assert.equal(result.type, 'unsupported_metadata');
  assert.equal(result.category, 'document_expiry');
  assert.match(result.summary, /Documents do not have expiry dates/i);
});

test('get_task_summary returns structured task_summary, not legacy Done-prone success data', async () => {
  const original = Task.countDocuments;
  const values = [1, 2, 3, 4];
  let index = 0;
  Task.countDocuments = async () => values[index++] ?? 0;

  try {
    const tool = findTool(taskTools, 'get_task_summary');
    const result = await tool.execute({ mine_only: true }, { userId: 'u1', user: { _id: 'u1', role: 'staff' } });

    assert.equal(result.type, 'task_summary');
    assert.equal(result.metrics.pending, 1);
    assert.equal(result.metrics.inProgress, 2);
    assert.equal(result.metrics.overdue, 3);
    assert.equal(result.metrics.completed, 4);
    assert.doesNotMatch(result.summary, /^Done\.?$/i);
  } finally {
    Task.countDocuments = original;
  }
});

test('query_reports_summary returns workflow/task metrics without request metrics', async () => {
  const originalContractCount = Contract.countDocuments;
  const originalDocumentCount = Document.countDocuments;
  const originalTaskCount = Task.countDocuments;

  const contractCounts = [5, 1];
  const documentCounts = [3, 2, 4];
  const taskCounts = [7, 2, 4];
  Contract.countDocuments = async () => contractCounts.shift() ?? 0;
  Document.countDocuments = async () => documentCounts.shift() ?? 0;
  Task.countDocuments = async () => taskCounts.shift() ?? 0;

  try {
    const tool = findTool(overviewTools, 'query_reports_summary');
    const result = await tool.execute({ reportType: 'tasks', period: 'this_month' }, { user: { role: 'admin' } });

    assert.equal(result.type, 'report_summary');
    assert.equal(result.category, 'tasks');
    assert.equal(result.metrics.openTasks, 7);
    assert.equal(result.metrics.overdueTasks, 2);
    assert.equal(result.metrics.workflowTasks, 4);
    assert.equal(Object.hasOwn(result.metrics, 'openRequests'), false);
  } finally {
    Contract.countDocuments = originalContractCount;
    Document.countDocuments = originalDocumentCount;
    Task.countDocuments = originalTaskCount;
  }
});

test('query_tasks applies tracker workflow filters and returns structured task_summary', async () => {
  const originalCount = Task.countDocuments;
  const originalFind = Task.find;

  Task.countDocuments = async (filter) => {
    assert.match(JSON.stringify(filter), /LEGAL_TRACKER/);
    return 1;
  };
  Task.find = () => {
    const chain = {
      populate: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: async () => [{
        _id: 'task1',
        title: 'Review tracker row',
        status: 'Pending',
        priority: 'Urgent',
        deadline: new Date('2026-05-16T00:00:00.000Z'),
        type: 'LEGAL_REVIEW',
        sourceType: 'LEGAL_TRACKER',
        assignedTo: { name: 'Legal User' },
      }],
    };
    return chain;
  };

  try {
    const tool = findTool(taskTools, 'query_tasks');
    const result = await tool.execute({
      filters: { sourceType: 'LEGAL_TRACKER', overdueOnly: true },
      limit: 20,
    }, { userId: 'u1', user: { _id: 'u1', role: 'admin' } });

    assert.equal(result.type, 'task_summary');
    assert.equal(result.metrics.count, 1);
    assert.equal(result.items[0].sourceType, 'LEGAL_TRACKER');
    assert.doesNotMatch(result.summary, /^Done\.?$/i);
  } finally {
    Task.countDocuments = originalCount;
    Task.find = originalFind;
  }
});
