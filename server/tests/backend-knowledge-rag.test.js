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

test('BackendKnowledgeRagService indexes public route summaries without indexing .env', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-rag-'));
  writeFile(path.join(root, '.env'), 'JWT_SECRET=do-not-index-this');
  writeFile(path.join(root, 'src/routes/auth.js'), `
    const express = require('express');
    const router = express.Router();
    router.post('/login', async () => {});
    router.get('/me', async () => {});
    module.exports = router;
  `);

  const service = new BackendKnowledgeRagService({
    rootDir: root,
    sourceDirs: ['src', '.env'],
    includeSource: false,
  });

  const index = service.reindex();
  assert.equal(index.files.some((file) => file.includes('.env')), false);

  const result = await service.retrieve({
    user: { role: 'staff' },
    query: 'Which authentication API endpoints exist?',
  });

  const context = service.formatContext(result);
  assert.match(context, /POST \/login/);
  assert.match(context, /GET \/me/);
  assert.doesNotMatch(context, /do-not-index-this/);
  assert.equal(result.snippets.every((snippet) => snippet.audience === 'public'), true);
});

test('BackendKnowledgeRagService does not trigger on ordinary contract data questions', () => {
  const service = new BackendKnowledgeRagService();
  assert.equal(service.shouldRetrieve('Search for the NDA contract'), false);
  assert.equal(service.shouldRetrieve('What fields are on the contract schema?'), true);
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
  assert.equal(adminResult.snippets.some((snippet) => snippet.audience === 'internal'), true);
});
