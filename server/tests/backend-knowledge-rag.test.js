const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BackendKnowledgeRagService } = require('../src/ai/rag/BackendKnowledgeRagService');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

test('BackendKnowledgeRagService indexes curated help without exposing route summaries to managers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-rag-'));
  writeFile(path.join(root, '.env'), 'JWT_SECRET=do-not-index-this');
  writeFile(path.join(root, 'src/routes/auth.js'), `
    const express = require('express');
    const router = express.Router();
    router.post('/login', async () => {});
    router.get('/me', async () => {});
    module.exports = router;
  `);
  writeFile(path.join(root, 'src/services/signingService.js'), `
    const STATUSES = ['SENT', 'PARTIALLY_SIGNED', 'FULLY_SIGNED'];
    module.exports = { STATUSES };
  `);

  const service = new BackendKnowledgeRagService({
    rootDir: root,
    sourceDirs: ['src', '.env'],
    includeSource: false,
  });

  // reindex() is async — must be awaited
  const index = await service.reindex();
  assert.equal(index.files.some((file) => file.includes('.env')), false);

  // Manager role gets curated help, not route internals.
  const result = await service.retrieve({
    user: { role: 'manager' },
    query: 'How does the signing process work?',
  });

  const context = service.formatContext(result);
  assert.match(context, /Signing statuses include/);
  assert.doesNotMatch(context, /do-not-index-this/);
  assert.doesNotMatch(context, /POST \/login/);
  assert.equal(result.snippets.every((snippet) => snippet.audience === 'help'), true);
});

test('BackendKnowledgeRagService does not trigger on ordinary contract data questions', () => {
  const service = new BackendKnowledgeRagService();
  assert.equal(service.shouldRetrieve('Search for the NDA contract'), false);
  assert.equal(service.shouldRetrieve('What fields are on the contract schema?'), true);
  assert.equal(service.shouldRetrieve('Show backend routes', { role: 'external' }), false);
});

test('BackendKnowledgeRagService keeps sanitized source chunks internal-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-rag-'));
  writeFile(path.join(root, 'src/services/demoService.js'), `
    const marker = 'implementationDetailForAdmins';
    const accidentalSecret = 'apiKey=1234567890abcdef';
    module.exports = { marker, accidentalSecret };
  `);

  const service = new BackendKnowledgeRagService({
    rootDir: root,
    sourceDirs: ['src'],
    includeSource: true,
  });

  const staffResult = await service.retrieve({
    user: { role: 'staff' },
    query: 'implementationDetailForAdmins service implementation',
  });
  assert.equal(staffResult, null);

  const adminResult = await service.retrieve({
    user: { role: 'admin' },
    query: 'implementationDetailForAdmins service implementation',
  });
  const context = service.formatContext(adminResult);

  assert.match(context, /implementationDetailForAdmins/);
  assert.match(context, /\[redacted-secret\]/);
  assert.doesNotMatch(context, /1234567890abcdef/);
  assert.equal(adminResult.snippets.some((snippet) => snippet.audience === 'source'), true);
});

test('BackendKnowledgeRagService allows staff help but not source code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-rag-'));
  writeFile(path.join(root, 'src/services/signingService.js'), `
    const STATUSES = ['SENT', 'FULLY_SIGNED'];
    module.exports = { STATUSES };
  `);
  writeFile(path.join(root, 'src/services/demoService.js'), `
    const implementationOnly = 'sourceOnlyMarker';
    module.exports = { implementationOnly };
  `);

  const service = new BackendKnowledgeRagService({
    rootDir: root,
    sourceDirs: ['src'],
    includeSource: true,
  });

  const help = await service.retrieve({
    user: { role: 'staff' },
    query: 'signing process statuses',
  });
  assert.equal(help.snippets.every((snippet) => snippet.audience === 'help'), true);

  const source = await service.retrieve({
    user: { role: 'staff' },
    query: 'sourceOnlyMarker implementation',
  });
  assert.equal(source, null);
});
