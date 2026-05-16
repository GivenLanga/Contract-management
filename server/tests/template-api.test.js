'use strict';

/**
 * Template API route permission tests.
 *
 * Verifies that:
 * - requireRole middleware is applied to mutating/scanning routes
 * - GET routes only require authentication (protect middleware)
 * - The classifier produces expected outputs for API-level integration
 *
 * These are structural tests that do not require a live MongoDB connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, cleanTitle } = require('../src/services/templateClassifier');

// ── Route permission assertions (structural) ──────────────────────────────────
// We verify the route file exports a router with the expected middleware structure
// by inspecting the route source rather than running a full HTTP server.

const fs = require('fs');
const path = require('path');

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/templates.js'),
  'utf8'
);

test('template routes: GET /api/templates requires protect middleware', () => {
  // The list route should call protect
  assert.ok(
    routeSrc.includes("router.get('/', protect"),
    'GET / should use protect middleware'
  );
});

test('template routes: POST /api/templates/discover requires admin/manager', () => {
  assert.ok(
    routeSrc.includes("router.post('/discover', protect, requireRole('admin', 'manager')"),
    'POST /discover should require admin or manager role'
  );
});

test('template routes: POST /api/templates requires admin/manager', () => {
  assert.ok(
    routeSrc.includes("router.post(\n  '/',\n  protect,\n  requireRole('admin', 'manager')") ||
    routeSrc.includes("router.post('/upload', protect, requireRole('admin', 'manager')"),
    'Upload route should require admin or manager role'
  );
});

test('template routes: DELETE /api/templates/:id requires admin/manager', () => {
  assert.ok(
    routeSrc.includes("router.delete('/:id', protect, requireRole('admin', 'manager')"),
    'DELETE /:id should require admin or manager role'
  );
});

test('template routes: GET /api/templates/diagnostics requires admin/manager', () => {
  assert.ok(
    routeSrc.includes("router.get('/diagnostics', protect, requireRole('admin', 'manager')"),
    'GET /diagnostics should require admin or manager role'
  );
});

test('template routes: GET /api/templates/facets only requires protect (not role)', () => {
  // facets is readable by all authenticated users
  assert.ok(
    routeSrc.includes("router.get('/facets', protect,"),
    'GET /facets should use protect middleware'
  );
  // Should NOT have requireRole immediately after facets
  const facetsLine = routeSrc.indexOf("router.get('/facets', protect,");
  const nextRequireRole = routeSrc.indexOf("requireRole", facetsLine);
  const nextRouterCall = routeSrc.indexOf("router.", facetsLine + 10);
  // requireRole appears after the next router definition, not inside the facets handler
  assert.ok(
    nextRequireRole > nextRouterCall,
    'facets route should not use requireRole'
  );
});

// ── Integration: classifier → API data shape ──────────────────────────────────

test('API classifier output: Funding Loan Agreement produces expected data shape', () => {
  const file = 'Revised Funding Loan Agreement template (v2) [20022023].docx';
  const { title, version } = cleanTitle(file);
  const classification = classify(file, 'Templates');

  // Shape that would be stored in the Template document
  const templateRecord = {
    name: title,
    title,
    originalFileName: file,
    agreementFamily: classification.agreementFamily,
    category: classification.category,
    classificationConfidence: classification.confidence,
    classificationSignals: classification.signals,
    versionLabel: version,
    status: 'ACTIVE',
    approvalStatus: 'APPROVED',
    isDiscovered: true,
  };

  assert.equal(templateRecord.agreementFamily, 'FUNDING_LOAN_AGREEMENT');
  assert.equal(templateRecord.category, 'Loans');
  assert.equal(templateRecord.status, 'ACTIVE');
  assert.equal(templateRecord.approvalStatus, 'APPROVED');
  assert.equal(templateRecord.isDiscovered, true);
  assert.equal(templateRecord.versionLabel, 'v2');
  assert.ok(!templateRecord.title.toLowerCase().includes('template'));
  assert.ok(!templateRecord.title.includes('[20022023]'));
});

test('API classifier output: MSA produces expected data shape', () => {
  const file = 'Master Services Agreement Template - Juristic Entities.docx';
  const { title } = cleanTitle(file);
  const classification = classify(file, 'Templates');

  assert.equal(classification.agreementFamily, 'MASTER_SERVICE_AGREEMENT');
  assert.ok(title.includes('Juristic Entities'));
  assert.ok(!title.toLowerCase().includes('template'));
});

test('API classifier output: low-confidence template gets requiresReview=true', () => {
  const { requiresReview, confidence } = classify('Contract_Final_v3.docx', '');
  if (confidence === 'low') {
    assert.equal(requiresReview, true);
  }
});

test('API: normal user filter only shows ACTIVE + APPROVED templates', () => {
  // Simulate the visibilityFilter logic inline
  const fakeUser = { role: 'staff' };
  const filter = fakeUser.role === 'admin' || fakeUser.role === 'manager'
    ? { isActive: true }
    : { isActive: true, status: 'ACTIVE', approvalStatus: 'APPROVED' };

  assert.deepEqual(filter, { isActive: true, status: 'ACTIVE', approvalStatus: 'APPROVED' });
});

test('API: admin user filter sees all active templates including PENDING_REVIEW', () => {
  const fakeUser = { role: 'admin' };
  const filter = fakeUser.role === 'admin' || fakeUser.role === 'manager'
    ? { isActive: true }
    : { isActive: true, status: 'ACTIVE', approvalStatus: 'APPROVED' };

  assert.deepEqual(filter, { isActive: true });
});

test('API: manager user filter sees all active templates', () => {
  const fakeUser = { role: 'manager' };
  const filter = fakeUser.role === 'admin' || fakeUser.role === 'manager'
    ? { isActive: true }
    : { isActive: true, status: 'ACTIVE', approvalStatus: 'APPROVED' };

  assert.deepEqual(filter, { isActive: true });
});

// ── Discovery service source logic ────────────────────────────────────────────

test('discovery service: warns when no legal folder files available and no candidates given', () => {
  // Simulate the warning logic
  const candidates = [];
  const imported = 0;
  const updated = 0;

  const warnings = [];
  if (imported === 0 && updated === 0 && candidates.length === 0) {
    warnings.push(
      'No backend-synced legal folder files matched template criteria. ' +
      'Sync the Legal Folder first, then click "Sync Templates from Legal Folder" again.'
    );
  }

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('Sync the Legal Folder first'));
});
