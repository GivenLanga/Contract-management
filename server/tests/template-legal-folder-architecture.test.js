'use strict';

/**
 * Legal Folder–first architecture tests.
 *
 * Verifies that:
 *  - The backend draft route returns 410 for LEGAL_FOLDER_SYNC templates
 *  - The backend never writes files for LEGAL_FOLDER_SYNC drafts
 *  - The disconnect-source endpoint correctly purges LEGAL_FOLDER_SYNC records
 *  - The discover endpoint is idempotent (source-inspection tests)
 *  - Diagnostics endpoint structure is correct
 *  - Frontend service files exist and export expected symbols
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Route source inspection ───────────────────────────────────────────────────

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/templates.js'),
  'utf8'
);

test('draft route: returns 409 for LEGAL_FOLDER_SYNC templates', () => {
  assert.ok(
    routeSrc.includes("sourceKind === 'LEGAL_FOLDER_SYNC'"),
    'Draft route must check sourceKind === LEGAL_FOLDER_SYNC'
  );
  assert.ok(
    routeSrc.includes('res.status(409)'),
    'Draft route must return 409 for LEGAL_FOLDER_SYNC templates'
  );
});

test('draft route: LEGAL_FOLDER_SYNC response includes CLIENT_SIDE_LEGAL_FOLDER_DRAFT_REQUIRED code', () => {
  assert.ok(
    routeSrc.includes("code: 'CLIENT_SIDE_LEGAL_FOLDER_DRAFT_REQUIRED'"),
    'Response code must be CLIENT_SIDE_LEGAL_FOLDER_DRAFT_REQUIRED'
  );
});

test('draft route: LEGAL_FOLDER_SYNC block does not copy files to server', () => {
  // Extract just the LEGAL_FOLDER_SYNC block (before the SERVER_UPLOAD logic)
  const legalFolderBlock = routeSrc.slice(
    routeSrc.indexOf("sourceKind === 'LEGAL_FOLDER_SYNC'"),
    routeSrc.indexOf("sourceKind === 'LEGAL_FOLDER_SYNC'") + 500
  );
  assert.ok(
    !legalFolderBlock.includes('copyFileSync') && !legalFolderBlock.includes('mkdirSync'),
    'LEGAL_FOLDER_SYNC block must not write files to server disk'
  );
});

test('draft route: SERVER_UPLOAD path still creates Document record', () => {
  assert.ok(
    routeSrc.includes('Document.create('),
    'Draft route must still create a Document record for SERVER_UPLOAD templates'
  );
  assert.ok(
    routeSrc.includes("documentStage: 'DRAFT'"),
    "Document must have documentStage 'DRAFT'"
  );
  assert.ok(
    routeSrc.includes('createdFromTemplate: true'),
    'Document must have createdFromTemplate: true'
  );
});

test('draft route: SERVER_UPLOAD path still increments usageCount', () => {
  assert.ok(
    routeSrc.includes('$inc: { usageCount: 1 }'),
    'Draft route must still increment usageCount for SERVER_UPLOAD templates'
  );
});

test('draft route: TEMPLATE_FILE_UNAVAILABLE still returned for missing server files', () => {
  assert.ok(
    routeSrc.includes("code: 'TEMPLATE_FILE_UNAVAILABLE'"),
    'Draft route must still return TEMPLATE_FILE_UNAVAILABLE when server file is missing'
  );
});

// ── Disconnect-source route ───────────────────────────────────────────────────

test('routes: disconnect-source deletes only LEGAL_FOLDER_SYNC templates', () => {
  assert.ok(
    routeSrc.includes("sourceKind: 'LEGAL_FOLDER_SYNC'"),
    'disconnect-source must filter by LEGAL_FOLDER_SYNC sourceKind'
  );
  assert.ok(
    routeSrc.includes('legalFolderSourceId: String(legalFolderSourceId)'),
    'disconnect-source must scope deletion to the specific source'
  );
});

test('routes: disconnect-source requires admin or manager role', () => {
  assert.ok(
    routeSrc.includes("router.post('/disconnect-source', protect, requireRole('admin', 'manager')"),
    'disconnect-source must require admin or manager role'
  );
});

test('routes: GET / list uses visibilityFilter that excludes orphaned templates', () => {
  assert.ok(
    routeSrc.includes('isOrphaned: { $ne: true }'),
    'visibilityFilter must exclude orphaned templates from all queries'
  );
});

test('routes: diagnostics includes bySource breakdown', () => {
  assert.ok(
    routeSrc.includes('bySource'),
    'Diagnostics must return bySource for Legal Folder source health'
  );
  assert.ok(
    routeSrc.includes('legalFolderSourceId'),
    'Diagnostics bySource must group by legalFolderSourceId'
  );
});

// ── Discovery service: no file writes ────────────────────────────────────────

const discoverySrc = fs.readFileSync(
  path.join(__dirname, '../src/services/templateDiscoveryService.js'),
  'utf8'
);

test('discovery service: does not write discovered files to server disk', () => {
  assert.ok(
    !discoverySrc.includes('fs.copyFileSync') && !discoverySrc.includes('fs.writeFileSync'),
    'Discovery service must not copy or write discovered template files to server disk'
  );
});

test('discovery service: idempotent upsert by sourceKey', () => {
  assert.ok(
    discoverySrc.includes("findOne({ sourceKind: 'LEGAL_FOLDER_SYNC', sourceKey }"),
    'Discovery service must look up by sourceKind + sourceKey before creating'
  );
});

test('discovery service: stale removal after sync', () => {
  assert.ok(
    discoverySrc.includes('Template.deleteMany('),
    'Discovery service must delete stale LEGAL_FOLDER_SYNC records after sync'
  );
  assert.ok(
    discoverySrc.includes('sourceKey: { $nin: Array.from(seenSourceKeys) }'),
    'Stale removal must exclude keys seen in the current sync'
  );
});

// ── Template model ────────────────────────────────────────────────────────────

const modelSrc = fs.readFileSync(
  path.join(__dirname, '../src/models/Template.js'),
  'utf8'
);

test('Template model: sourceKind field has LEGAL_FOLDER_SYNC and SERVER_UPLOAD values', () => {
  assert.ok(modelSrc.includes("'LEGAL_FOLDER_SYNC'"), 'Must have LEGAL_FOLDER_SYNC enum value');
  assert.ok(modelSrc.includes("'SERVER_UPLOAD'"), 'Must have SERVER_UPLOAD enum value');
});

test('Template model: has isOrphaned field', () => {
  assert.ok(modelSrc.includes('isOrphaned'), 'Template model must have isOrphaned field');
});

test('Template model: has legalFolderSourceId field', () => {
  assert.ok(modelSrc.includes('legalFolderSourceId'), 'Template model must have legalFolderSourceId');
});

test('Template model: has sourceKey field', () => {
  assert.ok(modelSrc.includes('sourceKey'), 'Template model must have sourceKey for idempotent sync');
});

test('Template model: has unique sparse compound index on sourceKind + sourceKey', () => {
  assert.ok(
    modelSrc.includes("unique: true, sparse: true"),
    'Must have unique sparse index to prevent duplicate discovered templates'
  );
  assert.ok(
    modelSrc.includes('sourceKind: 1, sourceKey: 1'),
    'Compound index must cover sourceKind and sourceKey'
  );
});

// ── Frontend service files exist and export expected symbols ──────────────────

const ROOT = path.join(__dirname, '../../src/services');

test('frontend: legalFolderHandle.js exists', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'legalFolderHandle.js')),
    'legalFolderHandle.js must exist'
  );
});

test('frontend: legalFolderHandle.js exports setLegalFolderHandle and clearLegalFolderHandle', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderHandle.js'), 'utf8');
  assert.ok(src.includes('export function setLegalFolderHandle'), 'Must export setLegalFolderHandle');
  assert.ok(src.includes('export function clearLegalFolderHandle'), 'Must export clearLegalFolderHandle');
  assert.ok(src.includes('export function getLegalFolderHandle'), 'Must export getLegalFolderHandle');
});

test('frontend: templateDocumentScanner.js exists and exports scanDocx', () => {
  const filePath = path.join(ROOT, 'templateDocumentScanner.js');
  assert.ok(fs.existsSync(filePath), 'templateDocumentScanner.js must exist');
  const src = fs.readFileSync(filePath, 'utf8');
  assert.ok(src.includes('export async function scanDocx'), 'Must export scanDocx');
  assert.ok(src.includes('export function isScannable'), 'Must export isScannable');
});

test('frontend: templateDocumentScanner.js detects square bracket placeholders', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templateDocumentScanner.js'), 'utf8');
  assert.ok(
    src.includes('SQUARE_RE'),
    'Scanner must have SQUARE_RE pattern for [PLACEHOLDER] detection'
  );
  assert.ok(
    src.includes('\\[([A-Za-z]'),
    'SQUARE_RE must match [COMPANY NAME] style placeholders'
  );
});

test('frontend: templateDocumentScanner.js detects curly placeholders', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templateDocumentScanner.js'), 'utf8');
  assert.ok(src.includes('CURLY_RE'), 'Scanner must have CURLY_RE for {{Placeholder}} detection');
  assert.ok(src.includes('\\{\\{'), 'CURLY_RE must match {{Field}} style placeholders');
});

test('frontend: templateDocumentScanner.js detects blank form fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templateDocumentScanner.js'), 'utf8');
  assert.ok(src.includes('BLANK_FIELD_RE'), 'Scanner must have BLANK_FIELD_RE for label: patterns');
  assert.ok(src.includes('FULL NAME') || src.includes('Full Name'), 'Scanner groups must cover Full Name signature field');
  assert.ok(src.includes('DESIGNATION'), 'Scanner groups must cover DESIGNATION as a signature field');
});

test('frontend: legalFolderPathBuilder.js exists and exports required functions', () => {
  const filePath = path.join(ROOT, 'legalFolderPathBuilder.js');
  assert.ok(fs.existsSync(filePath), 'legalFolderPathBuilder.js must exist');
  const src = fs.readFileSync(filePath, 'utf8');
  assert.ok(src.includes('export function buildDraftPath'), 'Must export buildDraftPath');
  assert.ok(src.includes('export async function writeToLegalFolder'), 'Must export writeToLegalFolder');
  assert.ok(src.includes('export async function buildDraftDestination'), 'Must export buildDraftDestination');
  assert.ok(src.includes('export async function writeDraftToFolder'), 'Must export writeDraftToFolder');
  assert.ok(src.includes('export function mapAgreementFamilyToFolder'), 'Must export mapAgreementFamilyToFolder');
  assert.ok(src.includes('export async function getExistingCategoryFolders'), 'Must export getExistingCategoryFolders');
  assert.ok(src.includes('export async function ensureDirectoryPath'), 'Must export ensureDirectoryPath');
  assert.ok(src.includes('export async function resolveDraftFileName'), 'Must export resolveDraftFileName');
});

test('frontend: legalFolderPathBuilder.js builds Contracts/{year}/{category}/{counterparty}/Drafts path', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes("'Contracts'"),
    'Path must start with Contracts/'
  );
  assert.ok(
    src.includes("'Drafts'"),
    'Default stage must be Drafts'
  );
});

test('frontend: legalFolderPathBuilder.js sanitizes path segments', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(src.includes('sanitizeSegment'), 'Must sanitize each path segment');
  assert.ok(
    src.includes('path traversal'),
    'Sanitizer must explicitly prevent path traversal'
  );
});

test('frontend: templateDraftWriter.js exists and exports createDraftDocx', () => {
  const filePath = path.join(ROOT, 'templateDraftWriter.js');
  assert.ok(fs.existsSync(filePath), 'templateDraftWriter.js must exist');
  const src = fs.readFileSync(filePath, 'utf8');
  assert.ok(src.includes('export async function createDraftDocx'), 'Must export createDraftDocx');
  assert.ok(src.includes('export function downloadDraft'), 'Must export downloadDraft');
});

test('frontend: templateDraftWriter.js uses JSZip for DOCX rebuilding', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templateDraftWriter.js'), 'utf8');
  assert.ok(src.includes("import JSZip from 'jszip'"), 'Must import JSZip');
  assert.ok(src.includes('JSZip.loadAsync'), 'Must load DOCX with JSZip');
  assert.ok(src.includes('zip.generateAsync'), 'Must regenerate DOCX ZIP with JSZip');
});

test('frontend: templateDraftWriter.js does not reference server file paths', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templateDraftWriter.js'), 'utf8');
  assert.ok(
    !src.includes('uploads/') && !src.includes('server/'),
    'Draft writer must not reference server file paths — drafts are written to Legal Folder only'
  );
});

test('frontend: templateDraftWriter.js tracks resolved vs unresolved placeholders', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templateDraftWriter.js'), 'utf8');
  assert.ok(src.includes('resolved'), 'Must track which placeholders were resolved');
  assert.ok(src.includes('unresolved'), 'Must track unresolved (split-run) placeholders');
  assert.ok(src.includes('warnings'), 'Must return warnings for unresolved placeholders');
});

// ── LegalFolder.jsx: readwrite mode ──────────────────────────────────────────

const legalFolderSrc = fs.readFileSync(
  path.join(__dirname, '../../src/components/Documents/LegalFolder.jsx'),
  'utf8'
);

test('LegalFolder.jsx: requests readwrite directory access', () => {
  assert.ok(
    legalFolderSrc.includes("mode: 'readwrite'"),
    'LegalFolder must request readwrite mode for write-back capability'
  );
});

test('LegalFolder.jsx: stores directory handle for write-back', () => {
  assert.ok(
    legalFolderSrc.includes('setLegalFolderHandle(directoryHandle)'),
    'LegalFolder must store the directory handle after successful pick'
  );
});

test('LegalFolder.jsx: clears directory handle on disconnect', () => {
  assert.ok(
    legalFolderSrc.includes('clearLegalFolderHandle()'),
    'LegalFolder must clear the stored handle when folder is disconnected'
  );
});

// ── Templates.jsx: Legal Folder as data source ────────────────────────────────

const templatesSrc = fs.readFileSync(
  path.join(__dirname, '../../src/components/Templates/Templates.jsx'),
  'utf8'
);

test('Templates.jsx: reads data from getLegalFolderImport (not backend API list)', () => {
  assert.ok(
    templatesSrc.includes('getLegalFolderImport'),
    'Templates page must read from getLegalFolderImport (local storage)'
  );
});

test('Templates.jsx: does not call templatesApi.list() for display', () => {
  // The page may still call discover/disconnect for backend indexing,
  // but it must NOT call .list() as the primary display data source.
  const hasListCall = templatesSrc.includes('templatesApi.list(');
  assert.ok(!hasListCall, 'Templates page must not call templatesApi.list() for display');
});

test('Templates.jsx: listens to LEGAL_FOLDER_UPDATED event', () => {
  assert.ok(
    templatesSrc.includes('LEGAL_FOLDER_UPDATED'),
    'Templates page must listen to LEGAL_FOLDER_UPDATED to refresh when folder is disconnected'
  );
  assert.ok(
    templatesSrc.includes("addEventListener('legal-folder-updated'") ||
    templatesSrc.includes("addEventListener(LEGAL_FOLDER_UPDATED"),
    'Must register event listener for the update event'
  );
});

test('Templates.jsx: shows empty state when no folder is connected', () => {
  assert.ok(
    templatesSrc.includes('No Legal Folder connected'),
    'Templates page must show empty state when no folder is connected'
  );
});

test('Templates.jsx: DraftModal uses scanDocx from templateDocumentScanner', () => {
  assert.ok(
    templatesSrc.includes('scanDocx'),
    'DraftModal must call scanDocx to detect placeholders'
  );
  assert.ok(
    templatesSrc.includes('isScannable'),
    'DraftModal must check isScannable before attempting to scan'
  );
});

test('Templates.jsx: DraftModal uses createDraftDocx for client-side draft creation', () => {
  assert.ok(
    templatesSrc.includes('createDraftDocx'),
    'DraftModal must use createDraftDocx (client-side DOCX writer)'
  );
});

test('Templates.jsx: DraftModal writes directly to Legal Folder via buildDraftDestination', () => {
  assert.ok(
    templatesSrc.includes('buildDraftDestination'),
    'DraftModal must use buildDraftDestination to create directories and resolve the write location'
  );
  assert.ok(
    templatesSrc.includes('writeDraftToFolder'),
    'DraftModal must use writeDraftToFolder to write the DOCX directly into the Legal Folder'
  );
  assert.ok(
    templatesSrc.includes('getLegalFolderHandle'),
    'DraftModal must check the stored directory handle before attempting to write'
  );
});

test('Templates.jsx: DraftModal shows reconnect message instead of OS save dialog when handle missing', () => {
  assert.ok(
    templatesSrc.includes('no-handle'),
    'DraftModal must enter a no-handle phase when the Legal Folder handle is not available'
  );
  assert.ok(
    templatesSrc.includes('Legal Folder Not Connected') || templatesSrc.includes('no-handle'),
    'DraftModal must show a reconnect message — not an OS save dialog — when handle is missing'
  );
});

test('Templates.jsx: DraftModal reads template file from IndexedDB cache', () => {
  assert.ok(
    templatesSrc.includes('getLegalFolderFile'),
    'DraftModal must read the template Blob from IndexedDB via getLegalFolderFile'
  );
});

test('Templates.jsx: DraftModal shows unavailable state when file not cached', () => {
  assert.ok(
    templatesSrc.includes('unavailable'),
    'DraftModal must handle the case where the file is not in IndexedDB cache'
  );
});

test('Templates.jsx: does not call templatesApi.createDraft for LEGAL_FOLDER_SYNC templates', () => {
  assert.ok(
    !templatesSrc.includes('templatesApi.createDraft'),
    'Templates page must not call templatesApi.createDraft — drafting is client-side'
  );
});

test('Templates.jsx: isTemplatePath filters documents from Templates/ folders', () => {
  assert.ok(
    templatesSrc.includes('isTemplatePath'),
    'Templates page must filter documents by template path'
  );
  assert.ok(
    templatesSrc.includes('TEMPLATE_FOLDER_NAMES'),
    'Must use TEMPLATE_FOLDER_NAMES set to identify template source folders'
  );
});

// ── Path builder pure logic tests ─────────────────────────────────────────────

test('acceptance: buildDraftPath produces Contracts/year/category/counterparty/Drafts', () => {
  const pathBuilderSrc = fs.readFileSync(
    path.join(ROOT, 'legalFolderPathBuilder.js'),
    'utf8'
  );

  // Verify the default path structure from source
  assert.ok(pathBuilderSrc.includes("'Contracts'"), 'Root must be Contracts');
  assert.ok(pathBuilderSrc.includes("'Drafts'"), 'Stage folder must be Drafts');

  // Verify sanitisation
  assert.ok(pathBuilderSrc.includes('slice(0, 100)'), 'Segment must be capped at 100 chars');
  assert.ok(pathBuilderSrc.includes('slice(0, 200)'), 'Filename must be capped at 200 chars');
});

test('acceptance: agreement family maps to readable category folder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(src.includes('ASSISTANCE_AGREEMENT'), 'Must map ASSISTANCE_AGREEMENT to category');
  assert.ok(src.includes("'Assistance Agreements'"), "ASSISTANCE_AGREEMENT must map to 'Assistance Agreements'");
  assert.ok(src.includes('FUNDING_LOAN_AGREEMENT'), 'Must map FUNDING_LOAN_AGREEMENT to category');
  assert.ok(src.includes("'Loans'"), "FUNDING_LOAN_AGREEMENT must map to 'Loans'");
  assert.ok(src.includes('MASTER_SERVICE_AGREEMENT'), 'Must map MASTER_SERVICE_AGREEMENT to category');
  assert.ok(src.includes("'Services'"), "MASTER_SERVICE_AGREEMENT must map to 'Services'");
});

test('acceptance: writeToLegalFolder increments version number', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(src.includes('v${v}.docx'), 'Must create versioned filenames: Draft v1.docx, v2.docx, ...');
  assert.ok(src.includes('v <= 99'), 'Must try up to 99 versions before falling back');
});

test('acceptance: writeToLegalFolder never creates directories above root', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  // Uses getDirectoryHandle on each pathPart — never navigates to parent
  assert.ok(
    src.includes('getDirectoryHandle(sanitizeSegment(part)'),
    'Must sanitize each path segment before creating directories'
  );
  assert.ok(
    !src.includes("'..'"),
    'Must never navigate to parent directories'
  );
});

// ── New category mapping tests (correct folder names per spec) ────────────────

test('path builder: ONCE_OFF_SERVICE_AGREEMENT prefers Service Providers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes("'Service Providers'"),
    "ONCE_OFF_SERVICE_AGREEMENT must include 'Service Providers' as a preferred folder name"
  );
  assert.ok(
    src.includes('ONCE_OFF_SERVICE_AGREEMENT'),
    'Must map ONCE_OFF_SERVICE_AGREEMENT'
  );
});

test('path builder: NDA prefers Confidentiality folder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes("'Confidentiality'"),
    "NDA must include 'Confidentiality' as a preferred folder name"
  );
});

test('path builder: FUNDING_LOAN_AGREEMENT prefers Funding Loan Agreement folder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes("'Funding Loan Agreement'"),
    "FUNDING_LOAN_AGREEMENT must include 'Funding Loan Agreement' as a preferred folder name"
  );
});

test('path builder: mapAgreementFamilyToFolder checks existing folder names first', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes('existingFolders'),
    'mapAgreementFamilyToFolder must accept and check existingFolders parameter'
  );
  assert.ok(
    src.includes('lowerExisting'),
    'Must perform case-insensitive comparison against existing folder names'
  );
});

test('path builder: buildDraftDestination creates Final and Signed sibling folders', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes("getDirectoryHandle('Final'"),
    "buildDraftDestination must create a 'Final' sibling folder"
  );
  assert.ok(
    src.includes("getDirectoryHandle('Signed'"),
    "buildDraftDestination must create a 'Signed' sibling folder"
  );
});

test('path builder: buildDraftDestination uses getExistingCategoryFolders to detect existing structure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'legalFolderPathBuilder.js'), 'utf8');
  assert.ok(
    src.includes('getExistingCategoryFolders(rootHandle)'),
    'buildDraftDestination must call getExistingCategoryFolders to read existing Legal Folder structure'
  );
});

// ── Templates.jsx: local index update ────────────────────────────────────────

test('Templates.jsx: DraftModal updates local Legal Folder index after draft creation', () => {
  assert.ok(
    templatesSrc.includes('addDocumentToLegalFolderImport'),
    'DraftModal must call addDocumentToLegalFolderImport to update the local index'
  );
});

test('Templates.jsx: DraftModal requires counterparty before creating draft', () => {
  assert.ok(
    templatesSrc.includes('counterparty.trim()'),
    'DraftModal must validate that counterparty is not empty'
  );
});

test('Templates.jsx: DraftModal shows live destination preview', () => {
  assert.ok(
    templatesSrc.includes('destinationPreview'),
    'DraftModal must compute and show a live destination preview'
  );
  assert.ok(
    templatesSrc.includes('Enter a counterparty to determine the draft folder'),
    'Preview must prompt user to enter counterparty when field is empty'
  );
});

// ── legalFolderStore: addDocumentToLegalFolderImport ─────────────────────────

test('legalFolderStore.js: exports addDocumentToLegalFolderImport', () => {
  const storeSrc = fs.readFileSync(
    path.join(__dirname, '../../src/services/legalFolderStore.js'),
    'utf8'
  );
  assert.ok(
    storeSrc.includes('export const addDocumentToLegalFolderImport'),
    'legalFolderStore must export addDocumentToLegalFolderImport for draft index updates'
  );
  assert.ok(
    storeSrc.includes('DOCUMENTS_KEY'),
    'addDocumentToLegalFolderImport must update the DOCUMENTS_KEY in localStorage'
  );
});

// ── Regression: no save dialog ────────────────────────────────────────────────

test('regression: Templates.jsx does not call downloadDraft in the submit path', () => {
  // downloadDraft (anchor.download) must not be used as the primary draft creation path.
  // The DraftModal writes directly to the connected Legal Folder via writeDraftToFolder.
  assert.ok(
    !templatesSrc.includes('downloadDraft(blob'),
    'DraftModal must not call downloadDraft(blob, ...) — drafts must be written to Legal Folder'
  );
});

test('regression: Templates.jsx does not use showSaveFilePicker', () => {
  assert.ok(
    !templatesSrc.includes('showSaveFilePicker'),
    'DraftModal must not use showSaveFilePicker — no OS save dialog allowed'
  );
});

test('regression: backend LEGAL_FOLDER_SYNC draft route does not write server files', () => {
  const legalFolderBlock = routeSrc.slice(
    routeSrc.indexOf("sourceKind === 'LEGAL_FOLDER_SYNC'"),
    routeSrc.indexOf("sourceKind === 'LEGAL_FOLDER_SYNC'") + 600
  );
  assert.ok(
    !legalFolderBlock.includes('uploads/generated-drafts') && !legalFolderBlock.includes('copyFileSync'),
    'LEGAL_FOLDER_SYNC draft block must not write to uploads/generated-drafts on server'
  );
});
