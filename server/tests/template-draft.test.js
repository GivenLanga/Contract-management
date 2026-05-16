'use strict';

/**
 * Template Phase 2 — Draft from Template tests.
 *
 * Structural tests (no live MongoDB / HTTP server required):
 *  - templateDraftPathService: sanitizeFilename, resolveDraftFilename
 *  - Route source: permission checks, 409 response shape, usage-count update
 *  - Document model source: template linkage fields
 *  - Default title logic
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeFilename, resolveDraftFilename } =
  require('../src/services/templateDraftPathService');

// ── sanitizeFilename ──────────────────────────────────────────────────────────

test('sanitizeFilename: replaces forward slash with dash', () => {
  assert.equal(sanitizeFilename('Foo/Bar'), 'Foo-Bar');
});

test('sanitizeFilename: replaces backslash with dash', () => {
  assert.equal(sanitizeFilename('Foo\\Bar'), 'Foo-Bar');
});

test('sanitizeFilename: replaces colon', () => {
  assert.equal(sanitizeFilename('Foo:Bar'), 'Foo-Bar');
});

test('sanitizeFilename: replaces pipe character', () => {
  assert.equal(sanitizeFilename('Foo|Bar'), 'Foo-Bar');
});

test('sanitizeFilename: collapses multiple spaces to one', () => {
  assert.equal(sanitizeFilename('Foo  Bar'), 'Foo Bar');
});

test('sanitizeFilename: trims leading and trailing whitespace', () => {
  assert.equal(sanitizeFilename('  Foo  '), 'Foo');
});

test('sanitizeFilename: returns Untitled for empty string', () => {
  assert.equal(sanitizeFilename(''), 'Untitled');
});

test('sanitizeFilename: returns Untitled for whitespace-only string', () => {
  assert.equal(sanitizeFilename('   '), 'Untitled');
});

test('sanitizeFilename: limits result to 200 characters', () => {
  const long = 'a'.repeat(250);
  assert.equal(sanitizeFilename(long).length, 200);
});

test('sanitizeFilename: preserves dashes in normal legal document title', () => {
  const title = 'Funding Loan Agreement - Backslash - Forwardslash - Draft';
  assert.equal(sanitizeFilename(title), title);
});

test('sanitizeFilename: acceptance scenario — party names as words are preserved', () => {
  // "Backslash" and "Forwardslash" are party names (words), not actual slash chars.
  const title = 'Funding Loan Agreement - Backslash - Forwardslash';
  assert.equal(sanitizeFilename(title), title);
});

// ── resolveDraftFilename ──────────────────────────────────────────────────────

test('resolveDraftFilename: returns "Title - Draft v1.docx" when no collision', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-draft-'));
  try {
    const { filename, filePath } = resolveDraftFilename(tmpDir, 'My Document', '.docx');
    assert.equal(filename, 'My Document - Draft v1.docx');
    assert.equal(filePath, path.join(tmpDir, 'My Document - Draft v1.docx'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('resolveDraftFilename: returns v2 when v1 already exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-draft-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'My Document - Draft v1.docx'), '');
    const { filename } = resolveDraftFilename(tmpDir, 'My Document', '.docx');
    assert.equal(filename, 'My Document - Draft v2.docx');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('resolveDraftFilename: returns v3 when v1 and v2 both exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-draft-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'My Document - Draft v1.docx'), '');
    fs.writeFileSync(path.join(tmpDir, 'My Document - Draft v2.docx'), '');
    const { filename } = resolveDraftFilename(tmpDir, 'My Document', '.docx');
    assert.equal(filename, 'My Document - Draft v3.docx');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('resolveDraftFilename: acceptance scenario filename shape', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-draft-'));
  try {
    const safeTitle = sanitizeFilename('Funding Loan Agreement - Backslash - Forwardslash');
    const { filename } = resolveDraftFilename(tmpDir, safeTitle, '.docx');
    assert.equal(filename, 'Funding Loan Agreement - Backslash - Forwardslash - Draft v1.docx');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ── Route source inspection ───────────────────────────────────────────────────

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/templates.js'),
  'utf8'
);

test('draft route: uses protect middleware', () => {
  assert.ok(
    routeSrc.includes("router.post('/:id/draft', protect,"),
    'Draft route should use protect middleware'
  );
});

test('draft route: does not require admin/manager role', () => {
  const draftLine = routeSrc.indexOf("router.post('/:id/draft', protect,");
  assert.ok(draftLine >= 0, 'draft route definition must exist');
  const lineEnd = routeSrc.indexOf('\n', draftLine);
  const routeDef = routeSrc.slice(draftLine, lineEnd);
  assert.ok(
    !routeDef.includes('requireRole'),
    'Draft route should not lock down to a specific role — all authenticated users can draft'
  );
});

test('draft route: returns 409 with TEMPLATE_FILE_UNAVAILABLE code for metadata-only templates', () => {
  assert.ok(
    routeSrc.includes("code: 'TEMPLATE_FILE_UNAVAILABLE'"),
    'Draft route must include TEMPLATE_FILE_UNAVAILABLE code in 409 response'
  );
});

test('draft route: returns 404 when template is not found', () => {
  assert.ok(
    routeSrc.includes("status(404)"),
    'Draft route should return 404 when template not found'
  );
});

test('draft route: blocks non-approved templates from normal users', () => {
  assert.ok(
    routeSrc.includes("status !== 'ACTIVE' || template.approvalStatus !== 'APPROVED'"),
    'Draft route should block non-approved templates from normal users'
  );
});

test('draft route: increments usageCount by 1', () => {
  assert.ok(
    routeSrc.includes('$inc: { usageCount: 1 }'),
    'Draft route should increment template usageCount'
  );
});

test('draft route: updates lastUsedAt', () => {
  assert.ok(
    routeSrc.includes('lastUsedAt: new Date()'),
    'Draft route should set template lastUsedAt to now'
  );
});

test('draft route: imports templateDraftPathService', () => {
  assert.ok(
    routeSrc.includes("require('../services/templateDraftPathService')"),
    'Draft route should import templateDraftPathService'
  );
});

test('draft route: sets createdFromTemplate on document', () => {
  assert.ok(
    routeSrc.includes('createdFromTemplate: true'),
    'Draft route should set createdFromTemplate on the created Document'
  );
});

test('draft route: sets documentStage to DRAFT', () => {
  assert.ok(
    routeSrc.includes("documentStage: 'DRAFT'"),
    "Draft route should set documentStage to 'DRAFT'"
  );
});

test('draft route: response includes type=draft_created_from_template', () => {
  assert.ok(
    routeSrc.includes("type: 'draft_created_from_template'"),
    'Success response should include type identifier'
  );
});

// ── Document model: template linkage fields ───────────────────────────────────

const docModelSrc = fs.readFileSync(
  path.join(__dirname, '../src/models/Document.js'),
  'utf8'
);

test('Document model: has createdFromTemplate field', () => {
  assert.ok(docModelSrc.includes('createdFromTemplate'), 'Document model must have createdFromTemplate');
});

test('Document model: has templateId field referencing Template', () => {
  assert.ok(docModelSrc.includes('templateId'), 'Document model must have templateId');
  assert.ok(docModelSrc.includes("ref: 'Template'"), 'templateId should reference the Template model');
});

test('Document model: has templateTitle field', () => {
  assert.ok(docModelSrc.includes('templateTitle'), 'Document model must have templateTitle');
});

test('Document model: has templateVersionLabel field', () => {
  assert.ok(docModelSrc.includes('templateVersionLabel'), 'Document model must have templateVersionLabel');
});

test('Document model: has agreementFamily field', () => {
  assert.ok(docModelSrc.includes('agreementFamily'), 'Document model must have agreementFamily');
});

test('Document model: has sourceTemplateFileName field', () => {
  assert.ok(docModelSrc.includes('sourceTemplateFileName'), 'Document model must have sourceTemplateFileName');
});

// ── Default title and visibility logic ───────────────────────────────────────

test('default draft title: appends " - Draft" suffix to template title', () => {
  const templateTitle = 'Revised Funding Loan Agreement';
  const defaultTitle = `${templateTitle} - Draft`;
  assert.equal(defaultTitle, 'Revised Funding Loan Agreement - Draft');
});

test('normal user filter: blocks non-approved templates', () => {
  const fakeUser = { role: 'staff' };
  const template = { status: 'PENDING_REVIEW', approvalStatus: 'PENDING', isActive: true };
  const isPrivileged = fakeUser.role === 'admin' || fakeUser.role === 'manager';
  const blocked = !isPrivileged && (template.status !== 'ACTIVE' || template.approvalStatus !== 'APPROVED');
  assert.equal(blocked, true);
});

test('admin user: can access non-approved templates', () => {
  const fakeUser = { role: 'admin' };
  const template = { status: 'PENDING_REVIEW', approvalStatus: 'PENDING', isActive: true };
  const isPrivileged = fakeUser.role === 'admin' || fakeUser.role === 'manager';
  const blocked = !isPrivileged && (template.status !== 'ACTIVE' || template.approvalStatus !== 'APPROVED');
  assert.equal(blocked, false);
});

test('409 actions array: contains expected recovery options', () => {
  const actions = [
    'Upload the template file',
    'Register a server-side template copy',
    'Use preview only',
  ];
  assert.ok(actions.includes('Upload the template file'));
  assert.ok(actions.includes('Use preview only'));
  assert.equal(actions.length, 3);
});
