'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const documentTools = require('../src/ai/tools/documents.tools');
const taskTools = require('../src/ai/tools/tasks.tools');
const workflowTools = require('../src/ai/tools/workflow.tools');
const Document = require('../src/models/Document');
const Task = require('../src/models/Task');
const LegalRequest = require('../src/models/LegalRequest');

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

test('get_legal_team_progress returns report_summary with useful metrics', async () => {
  const originalLrCount = LegalRequest.countDocuments;
  const originalLrFind = LegalRequest.find;
  const originalTaskCount = Task.countDocuments;

  const counts = [14, 9, 11, 2, 4, 1, 1, 3];
  let lrIndex = 0;
  LegalRequest.countDocuments = async () => counts[lrIndex++] ?? 0;
  Task.countDocuments = async () => 7;
  LegalRequest.find = () => ({
    select: () => ({
      lean: async () => [
        { internalOrExternal: 'INTERNAL', submittedAt: new Date(), completedAt: new Date(), legalWorkingDays: 2 },
        { internalOrExternal: 'EXTERNAL', submittedAt: new Date(), completedAt: new Date(), legalWorkingDays: 6 },
      ],
    }),
  });

  try {
    const tool = findTool(workflowTools, 'get_legal_team_progress');
    const result = await tool.execute({ period: 'this_month' }, { user: { role: 'admin' } });

    assert.equal(result.type, 'report_summary');
    assert.equal(result.category, 'legal_team_progress');
    assert.equal(result.metrics.submitted, 14);
    assert.equal(result.metrics.completed, 9);
    assert.equal(result.metrics.overdue, 2);
    assert.equal(result.metrics.slaCompliance, 100);
    assert.match(result.summary, /Legal progress/i);
  } finally {
    LegalRequest.countDocuments = originalLrCount;
    LegalRequest.find = originalLrFind;
    Task.countDocuments = originalTaskCount;
  }
});

test('query_legal_requests applies urgent filter and returns structured legal_request_summary', async () => {
  const originalCount = LegalRequest.countDocuments;
  const originalFind = LegalRequest.find;

  LegalRequest.countDocuments = async (filter) => {
    assert.match(JSON.stringify(filter), /URGENT/);
    return 1;
  };
  LegalRequest.find = () => ({
    select: () => ({
      populate: () => ({
        populate: () => ({
          sort: () => ({
            limit: () => ({
              lean: async () => [{
                _id: 'lr1',
                requestId: 'LR-2026-00001',
                title: 'Urgent Finance Addendum',
                requestType: 'EXTERNAL_CONTRACT',
                status: 'SUBMITTED',
                priority: 'URGENT',
                department: 'Finance',
                dueDate: new Date('2026-05-16T00:00:00.000Z'),
                targetDate: new Date('2026-05-16T00:00:00.000Z'),
                submittedAt: new Date('2026-05-12T00:00:00.000Z'),
                reasonForRequest: 'Addendum for facility terms',
                assignedTo: { name: 'Legal User' },
                submittedBy: { name: 'Finance User' },
              }],
            }),
          }),
        }),
      }),
    }),
  });

  try {
    const tool = findTool(workflowTools, 'query_legal_requests');
    const result = await tool.execute({
      filters: { priority: 'URGENT', urgentOnly: true },
      period: 'all',
      limit: 20,
    }, { userId: 'u1', user: { _id: 'u1', role: 'admin' } });

    assert.equal(result.type, 'legal_request_summary');
    assert.equal(result.metrics.count, 1);
    assert.equal(result.items[0].priority, 'URGENT');
    assert.match(result.summary, /urgent legal request/i);
    assert.doesNotMatch(result.summary, /^Done\.?$/i);
  } finally {
    LegalRequest.countDocuments = originalCount;
    LegalRequest.find = originalFind;
  }
});

test('query_legal_requests returns Finance requested fields as table_summary', async () => {
  const originalCount = LegalRequest.countDocuments;
  const originalFind = LegalRequest.find;

  LegalRequest.countDocuments = async (filter) => {
    assert.ok(filter);
    return 1;
  };
  LegalRequest.find = () => ({
    select: () => ({
      populate: () => ({
        populate: () => ({
          sort: () => ({
            limit: () => ({
              lean: async () => [{
                _id: 'lr2',
                requestId: 'LR-2026-00002',
                title: 'Finance Service Agreement',
                requestType: 'SERVICE_PROVIDER_AGREEMENT',
                documentCategory: 'Agreement',
                status: 'IN_LEGAL_REVIEW',
                priority: 'HIGH',
                department: 'Finance',
                dueDate: new Date('2026-05-16T00:00:00.000Z'),
                targetDate: new Date('2026-05-16T00:00:00.000Z'),
                submittedAt: new Date('2026-05-12T00:00:00.000Z'),
                reasonForRequest: 'Review payment services terms',
                assignedTo: { name: 'Legal User' },
                submittedBy: { name: 'Finance User' },
              }],
            }),
          }),
        }),
      }),
    }),
  });

  try {
    const tool = findTool(workflowTools, 'query_legal_requests');
    const result = await tool.execute({
      filters: { department: 'Finance' },
      requestedFields: ['title', 'description', 'requestType', 'dueDate', 'targetDate'],
      answerShape: 'table',
      period: 'all',
      limit: 20,
    }, { userId: 'u1', user: { _id: 'u1', role: 'admin' } });

    assert.equal(result.type, 'table_summary');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].department, 'Finance');
    assert.equal(result.rows[0].wantedBy instanceof Date, true);
    assert.match(result.summary, /Finance has 1 visible legal request/i);
  } finally {
    LegalRequest.countDocuments = originalCount;
    LegalRequest.find = originalFind;
  }
});
