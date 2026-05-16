'use strict';

/**
 * Template Phase 1 Fixes — Sync Idempotency & Source Ownership tests.
 *
 * Structural tests (no live MongoDB / HTTP server required):
 *  - computeSourceKey: stable hash output, different source → different key
 *  - templateDiscoveryService: source inspection for upsert, stale removal, skippedDuplicates
 *  - Template model: new fields present
 *  - templates.js routes: disconnect-source, visibilityFilter, sourceKind on upload
 *  - Phase 2 regression: draft route still works for SERVER_UPLOAD, 409 for LEGAL_FOLDER_SYNC
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { computeSourceKey } = require('../src/services/templateDiscoveryService');

// ── computeSourceKey ──────────────────────────────────────────────────────────

test('computeSourceKey: returns a 64-char hex string (SHA-256)', () => {
  const key = computeSourceKey('sa_mock_contracts_pack', { sourcePath: 'Root/Templates/foo.docx' });
  assert.equal(typeof key, 'string');
  assert.equal(key.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(key), 'key must be lowercase hex');
});

test('computeSourceKey: same source + same path produces same key (idempotent)', () => {
  const c = { sourcePath: 'Root/Templates/Revised Funding Loan Agreement template (v2) [20022023].docx' };
  const k1 = computeSourceKey('sa_mock_contracts_pack', c);
  const k2 = computeSourceKey('sa_mock_contracts_pack', c);
  assert.equal(k1, k2);
});

test('computeSourceKey: different source + same path produces different key', () => {
  const c = { sourcePath: 'Root/Templates/foo.docx' };
  const k1 = computeSourceKey('source_a', c);
  const k2 = computeSourceKey('source_b', c);
  assert.notEqual(k1, k2);
});

test('computeSourceKey: same source + different path produces different key', () => {
  const k1 = computeSourceKey('source_a', { sourcePath: 'Root/Templates/foo.docx' });
  const k2 = computeSourceKey('source_a', { sourcePath: 'Root/Templates/bar.docx' });
  assert.notEqual(k1, k2);
});

test('computeSourceKey: path normalised to lowercase (case-insensitive filenames)', () => {
  const k1 = computeSourceKey('src', { sourcePath: 'Root/Templates/Foo.DOCX' });
  const k2 = computeSourceKey('src', { sourcePath: 'root/templates/foo.docx' });
  assert.equal(k1, k2);
});

test('computeSourceKey: backslashes normalised to forward slashes', () => {
  const k1 = computeSourceKey('src', { sourcePath: 'Root\\Templates\\foo.docx' });
  const k2 = computeSourceKey('src', { sourcePath: 'Root/Templates/foo.docx' });
  assert.equal(k1, k2);
});

test('computeSourceKey: falls back to candidate.name when sourcePath is absent', () => {
  const key = computeSourceKey('src', { name: 'foo.docx' });
  assert.equal(key.length, 64);
  // Must match when name is used
  const key2 = computeSourceKey('src', { name: 'foo.docx' });
  assert.equal(key, key2);
});

// ── Discovery service source inspection ───────────────────────────────────────

const discoverySrc = fs.readFileSync(
  path.join(__dirname, '../src/services/templateDiscoveryService.js'),
  'utf8'
);

test('discovery service: exports computeSourceKey', () => {
  assert.ok(
    discoverySrc.includes('module.exports = { discoverTemplates, computeSourceKey }'),
    'computeSourceKey must be exported'
  );
});

test('discovery service: upserts by sourceKind + sourceKey (idempotent dedup)', () => {
  assert.ok(
    discoverySrc.includes("findOne({ sourceKind: 'LEGAL_FOLDER_SYNC', sourceKey }"),
    'Must look up existing record by sourceKind + sourceKey before creating'
  );
});

test('discovery service: deduplicates candidates within the same payload', () => {
  assert.ok(
    discoverySrc.includes("return 'duplicate'"),
    'Must return duplicate outcome when same path appears twice in payload'
  );
  assert.ok(
    discoverySrc.includes('skippedDuplicates'),
    'Summary must include skippedDuplicates counter'
  );
});

test('discovery service: removes stale LEGAL_FOLDER_SYNC records after sync', () => {
  assert.ok(
    discoverySrc.includes('Template.deleteMany('),
    'Must call Template.deleteMany for stale record removal'
  );
  assert.ok(
    discoverySrc.includes("sourceKind: 'LEGAL_FOLDER_SYNC'"),
    'Stale removal must filter by LEGAL_FOLDER_SYNC sourceKind'
  );
  assert.ok(
    discoverySrc.includes('legalFolderSourceId: String(legalFolderSourceId)'),
    'Stale removal must be scoped to the specific source'
  );
  assert.ok(
    discoverySrc.includes('sourceKey: { $nin: Array.from(seenSourceKeys) }'),
    'Stale removal must exclude keys seen in this sync'
  );
});

test('discovery service: sets sourceKind LEGAL_FOLDER_SYNC on discovered templates', () => {
  assert.ok(
    discoverySrc.includes("sourceKind: 'LEGAL_FOLDER_SYNC'"),
    'New LEGAL_FOLDER_SYNC records must carry sourceKind field'
  );
});

test('discovery service: sets sourceKind SERVER_UPLOAD on disk-scanned templates', () => {
  assert.ok(
    discoverySrc.includes("sourceKind: 'SERVER_UPLOAD'"),
    'Disk-scanned templates must use SERVER_UPLOAD sourceKind'
  );
});

test('discovery service: stores legalFolderSourceId on discovered records', () => {
  assert.ok(
    discoverySrc.includes('legalFolderSourceId'),
    'Service must store legalFolderSourceId on LEGAL_FOLDER_SYNC records'
  );
});

test('discovery service: does not copy or write discovered files to disk', () => {
  // The service must NOT call fs.copyFile or fs.writeFile for candidate records
  assert.ok(
    !discoverySrc.includes('fs.copyFileSync') && !discoverySrc.includes('fs.writeFileSync'),
    'Discovery service must not copy/write candidate files to server disk'
  );
});

// ── Template model: new fields ────────────────────────────────────────────────

const modelSrc = fs.readFileSync(
  path.join(__dirname, '../src/models/Template.js'),
  'utf8'
);

test('Template model: has sourceKind field', () => {
  assert.ok(modelSrc.includes('sourceKind'), 'Template model must have sourceKind field');
  assert.ok(
    modelSrc.includes("'LEGAL_FOLDER_SYNC'") && modelSrc.includes("'SERVER_UPLOAD'"),
    'sourceKind enum must include LEGAL_FOLDER_SYNC and SERVER_UPLOAD'
  );
});

test('Template model: has legalFolderSourceId field', () => {
  assert.ok(modelSrc.includes('legalFolderSourceId'), 'Template model must have legalFolderSourceId');
});

test('Template model: has sourceKey field', () => {
  assert.ok(modelSrc.includes('sourceKey'), 'Template model must have sourceKey');
});

test('Template model: has isOrphaned field', () => {
  assert.ok(modelSrc.includes('isOrphaned'), 'Template model must have isOrphaned');
});

test('Template model: has unique sparse index on (sourceKind, sourceKey)', () => {
  assert.ok(
    modelSrc.includes('unique: true, sparse: true'),
    'Must have unique sparse compound index for idempotent sync'
  );
  assert.ok(
    modelSrc.includes('sourceKind: 1, sourceKey: 1'),
    'Index must include sourceKind and sourceKey'
  );
});

// ── templates.js routes ───────────────────────────────────────────────────────

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/templates.js'),
  'utf8'
);

test('routes: POST /disconnect-source exists and requires admin/manager', () => {
  assert.ok(
    routeSrc.includes("router.post('/disconnect-source', protect, requireRole('admin', 'manager')"),
    'disconnect-source route must exist with admin/manager guard'
  );
});

test('routes: disconnect-source deletes only LEGAL_FOLDER_SYNC templates for the source', () => {
  assert.ok(
    routeSrc.includes("sourceKind: 'LEGAL_FOLDER_SYNC'"),
    'disconnect-source must filter by LEGAL_FOLDER_SYNC sourceKind'
  );
  assert.ok(
    routeSrc.includes('legalFolderSourceId: String(legalFolderSourceId)'),
    'disconnect-source must filter by legalFolderSourceId'
  );
});

test('routes: disconnect-source does not delete SERVER_UPLOAD templates', () => {
  // The deleteMany in disconnect-source should NOT include SERVER_UPLOAD in the filter
  const disconnectBlock = routeSrc.slice(
    routeSrc.indexOf("router.post('/disconnect-source'"),
    routeSrc.indexOf("router.post('/disconnect-source'") + 600
  );
  assert.ok(
    !disconnectBlock.includes("'SERVER_UPLOAD'"),
    'disconnect-source deleteMany must not reference SERVER_UPLOAD (would accidentally delete them)'
  );
});

test('routes: visibilityFilter excludes isOrphaned templates', () => {
  assert.ok(
    routeSrc.includes('isOrphaned: { $ne: true }'),
    'visibilityFilter must exclude orphaned templates from all queries'
  );
});

test('routes: GET /templates list excludes orphaned through visibilityFilter', () => {
  // visibilityFilter is applied to both admin and normal user queries
  const filterFn = routeSrc.slice(
    routeSrc.indexOf('function visibilityFilter'),
    routeSrc.indexOf('function visibilityFilter') + 300
  );
  const adminBranch = filterFn.includes('isOrphaned: { $ne: true }');
  assert.ok(adminBranch, 'Admin branch of visibilityFilter must also exclude orphaned templates');
});

test('routes: POST /discover passes legalFolderSource to discoverTemplates', () => {
  assert.ok(
    routeSrc.includes('legalFolderSource = req.body.legalFolderSource'),
    'Discover route must extract legalFolderSource from request body'
  );
  assert.ok(
    routeSrc.includes('legalFolderSource,'),
    'Discover route must pass legalFolderSource to discoverTemplates'
  );
});

test('routes: discover response includes skippedDuplicates and removedStale', () => {
  assert.ok(
    routeSrc.includes('skippedDuplicates: summary.skippedDuplicates'),
    'Discover response must include skippedDuplicates'
  );
  assert.ok(
    routeSrc.includes('removedStale: summary.removedStale'),
    'Discover response must include removedStale'
  );
});

test('routes: uploaded templates get sourceKind SERVER_UPLOAD', () => {
  assert.ok(
    routeSrc.includes("sourceKind: 'SERVER_UPLOAD'"),
    'Template upload routes must set sourceKind to SERVER_UPLOAD'
  );
});

test('routes: diagnostics returns bySource breakdown', () => {
  assert.ok(
    routeSrc.includes('bySource'),
    'Diagnostics route must return bySource array for source-level health'
  );
  assert.ok(
    routeSrc.includes('legalFolderSourceId'),
    'bySource must group by legalFolderSourceId'
  );
});

// ── Phase 2 regression: draft route unchanged ─────────────────────────────────

test('Phase 2 regression: draft route still returns 409 for metadata-only templates', () => {
  assert.ok(
    routeSrc.includes("code: 'TEMPLATE_FILE_UNAVAILABLE'"),
    'Draft route must still return 409 TEMPLATE_FILE_UNAVAILABLE for templates without a file'
  );
});

test('Phase 2 regression: draft route still increments usageCount for SERVER_UPLOAD templates', () => {
  assert.ok(
    routeSrc.includes('$inc: { usageCount: 1 }'),
    'Draft route must still increment usageCount on successful draft creation'
  );
});

test('Phase 2 regression: draft route still sets documentStage DRAFT', () => {
  assert.ok(
    routeSrc.includes("documentStage: 'DRAFT'"),
    "Draft route must still set documentStage to 'DRAFT'"
  );
});

test('Phase 2 regression: draft route still sets createdFromTemplate linkage', () => {
  assert.ok(
    routeSrc.includes('createdFromTemplate: true'),
    'Draft route must still set createdFromTemplate on the created Document'
  );
});

// ── Acceptance scenario: sourceKey stability ──────────────────────────────────

test('acceptance: acceptance-scenario file produces stable sourceKey across simulated syncs', () => {
  const sourceId = 'sa_mock_contracts_pack';
  const candidate = {
    name: 'Revised Funding Loan Agreement template (v2) [20022023].docx',
    sourcePath: 'Root/Templates/Revised Funding Loan Agreement template (v2) [20022023].docx',
    size: 258985,
  };

  // Simulate three syncs — all must produce identical key
  const keys = [
    computeSourceKey(sourceId, candidate),
    computeSourceKey(sourceId, candidate),
    computeSourceKey(sourceId, candidate),
  ];

  assert.equal(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
  // Must be a valid SHA-256 hex
  assert.ok(/^[0-9a-f]{64}$/.test(keys[0]));
});

test('acceptance: different candidates from same source have different sourceKeys', () => {
  const sourceId = 'sa_mock_contracts_pack';
  const files = [
    { sourcePath: 'Root/Templates/Addendum Template 1.docx' },
    { sourcePath: 'Root/Templates/Consultancy Agreement Template - Individuals.docx' },
    { sourcePath: 'Root/Templates/Master Services Agreement Template - Juristic Entities.docx' },
    { sourcePath: 'Root/Templates/Once-Off Service Agreement Template - Juristic Entities.docx' },
    { sourcePath: 'Root/Templates/Revised Funding Loan Agreement template (v2) [20022023].docx' },
  ];

  const keys = files.map((c) => computeSourceKey(sourceId, c));
  const uniqueKeys = new Set(keys);
  assert.equal(uniqueKeys.size, files.length, 'All distinct files must produce distinct sourceKeys');
});
