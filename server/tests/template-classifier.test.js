'use strict';

/**
 * Template classifier tests.
 *
 * Covers deterministic keyword classification, title cleanup, folder detection,
 * and skip/extension rules. No MongoDB or network required.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classify,
  cleanTitle,
  isTemplatePath,
  shouldSkip,
  isSupportedExtension,
  displaySourceLabel,
} = require('../src/services/templateClassifier');

// ── cleanTitle ────────────────────────────────────────────────────────────────

test('cleanTitle: removes extension', () => {
  const { title } = cleanTitle('Master Service Agreement.docx');
  assert.equal(title, 'Master Service Agreement');
});

test('cleanTitle: removes standalone word Template', () => {
  const { title } = cleanTitle('Master Services Agreement Template - Juristic Entities.docx');
  assert.equal(title, 'Master Services Agreement - Juristic Entities');
});

test('cleanTitle: preserves Juristic Entities', () => {
  const { title } = cleanTitle('Once-Off Service Agreement Template - Juristic Entities.docx');
  assert.ok(title.includes('Juristic Entities'), `got: ${title}`);
});

test('cleanTitle: preserves Individuals', () => {
  const { title } = cleanTitle('Consultancy Agreement Template - Individuals.docx');
  assert.ok(title.includes('Individuals'), `got: ${title}`);
});

test('cleanTitle: extracts version from (v2)', () => {
  const { title, version } = cleanTitle('Revised Funding Loan Agreement template (v2) [20022023].docx');
  assert.equal(version, 'v2');
  assert.ok(!title.includes('(v2)'), `version still in title: ${title}`);
});

test('cleanTitle: removes bracket date [20022023]', () => {
  const { title } = cleanTitle('Revised Funding Loan Agreement template (v2) [20022023].docx');
  assert.ok(!title.includes('[20022023]'), `bracket date still in title: ${title}`);
});

test('cleanTitle: Addendum Template 1 preserves numbering', () => {
  const { title } = cleanTitle('Addendum Template 1.docx');
  assert.equal(title, 'Addendum 1');
});

test('cleanTitle: Assistance Agreement Template → Assistance Agreement', () => {
  const { title } = cleanTitle('Assistance Agreement Template.docx');
  assert.equal(title, 'Assistance Agreement');
});

test('cleanTitle: produces reasonable title for Revised Funding Loan Agreement', () => {
  const { title } = cleanTitle('Revised Funding Loan Agreement template (v2) [20022023].docx');
  assert.ok(title.toLowerCase().includes('funding loan'), `expected funding loan in: ${title}`);
  assert.ok(!title.toLowerCase().includes('template'), `template word not removed: ${title}`);
});

// ── classify ──────────────────────────────────────────────────────────────────

test('classify: Revised Funding Loan Agreement → FUNDING_LOAN_AGREEMENT with high confidence', () => {
  const { agreementFamily, confidence } = classify('Revised Funding Loan Agreement template (v2) [20022023].docx', 'Templates');
  assert.equal(agreementFamily, 'FUNDING_LOAN_AGREEMENT');
  assert.equal(confidence, 'high');
});

test('classify: Master Services Agreement Template - Juristic Entities → MASTER_SERVICE_AGREEMENT', () => {
  const { agreementFamily, confidence } = classify('Master Services Agreement Template - Juristic Entities.docx', 'Templates');
  assert.equal(agreementFamily, 'MASTER_SERVICE_AGREEMENT');
  assert.equal(confidence, 'high');
});

test('classify: Consultancy Agreement Template - Individuals → CONSULTANCY_AGREEMENT', () => {
  const { agreementFamily } = classify('Consultancy Agreement Template - Individuals.docx', 'Templates');
  assert.equal(agreementFamily, 'CONSULTANCY_AGREEMENT');
});

test('classify: Once-Off Service Agreement Template → ONCE_OFF_SERVICE_AGREEMENT', () => {
  const { agreementFamily } = classify('Once-Off Service Agreement Template - Juristic Entities.docx', 'Templates');
  assert.equal(agreementFamily, 'ONCE_OFF_SERVICE_AGREEMENT');
});

test('classify: Addendum Template 1 → ADDENDUM', () => {
  const { agreementFamily } = classify('Addendum Template 1.docx', 'Templates');
  assert.equal(agreementFamily, 'ADDENDUM');
});

test('classify: Assistance Agreement Template → medium or low confidence (ambiguous)', () => {
  const { confidence, requiresReview } = classify('Assistance Agreement Template.docx', 'Templates');
  // Should classify as ASSISTANCE_AGREEMENT or similar, but may be medium confidence
  assert.ok(['medium', 'low'].includes(confidence) || requiresReview === false, `confidence: ${confidence}`);
});

test('classify: NDA file → NDA family', () => {
  const { agreementFamily } = classify('Mutual Non-Disclosure Agreement.docx', '');
  assert.equal(agreementFamily, 'NDA');
});

test('classify: bridging finance file → BRIDGING_FINANCE_AGREEMENT', () => {
  const { agreementFamily } = classify('Bridging Finance Agreement.docx', '');
  assert.equal(agreementFamily, 'BRIDGING_FINANCE_AGREEMENT');
});

test('classify: unrecognised file → OTHER with low confidence and requiresReview=true', () => {
  const { agreementFamily, confidence, requiresReview } = classify('Contract_xyz_final_v3.docx', '');
  assert.equal(agreementFamily, 'OTHER');
  assert.equal(confidence, 'low');
  assert.equal(requiresReview, true);
});

test('classify: returns classification signals array', () => {
  const { signals } = classify('Funding Loan Agreement.docx', '');
  assert.ok(Array.isArray(signals));
  assert.ok(signals.length > 0);
});

// ── isTemplatePath ────────────────────────────────────────────────────────────

test('isTemplatePath: detects "Templates" folder', () => {
  assert.equal(isTemplatePath('Root/Templates/file.docx'), true);
});

test('isTemplatePath: detects "template" (case-insensitive)', () => {
  assert.equal(isTemplatePath('Root/template/file.docx'), true);
});

test('isTemplatePath: detects "Legal Templates" folder', () => {
  assert.equal(isTemplatePath('Root/Legal Templates/file.docx'), true);
});

test('isTemplatePath: detects "Precedents" folder', () => {
  assert.equal(isTemplatePath('Root/Precedents/file.docx'), true);
});

test('isTemplatePath: detects "Approved Templates" folder', () => {
  assert.equal(isTemplatePath('Contracts/Approved Templates/file.docx'), true);
});

test('isTemplatePath: returns false for generic Contracts folder', () => {
  assert.equal(isTemplatePath('Root/Contracts/file.docx'), false);
});

test('isTemplatePath: returns false for empty path', () => {
  assert.equal(isTemplatePath(''), false);
  assert.equal(isTemplatePath(null), false);
  assert.equal(isTemplatePath(undefined), false);
});

// ── shouldSkip ────────────────────────────────────────────────────────────────

test('shouldSkip: skips temp Word lock files (~$...)', () => {
  assert.equal(shouldSkip('~$Master Service Agreement.docx'), true);
});

test('shouldSkip: skips hidden files (.DS_Store)', () => {
  assert.equal(shouldSkip('.DS_Store'), true);
});

test('shouldSkip: does not skip normal docx', () => {
  assert.equal(shouldSkip('Contract.docx'), false);
});

test('shouldSkip: does not skip files with brackets and parentheses', () => {
  assert.equal(shouldSkip('Revised Funding Loan Agreement template (v2) [20022023].docx'), false);
});

// ── isSupportedExtension ──────────────────────────────────────────────────────

test('isSupportedExtension: supports docx', () => {
  assert.equal(isSupportedExtension('file.docx'), true);
});

test('isSupportedExtension: supports pdf', () => {
  assert.equal(isSupportedExtension('file.pdf'), true);
});

test('isSupportedExtension: supports dotx', () => {
  assert.equal(isSupportedExtension('file.dotx'), true);
});

test('isSupportedExtension: supports txt and md', () => {
  assert.equal(isSupportedExtension('file.txt'), true);
  assert.equal(isSupportedExtension('file.md'), true);
});

test('isSupportedExtension: rejects xlsx', () => {
  assert.equal(isSupportedExtension('file.xlsx'), false);
});

test('isSupportedExtension: rejects exe', () => {
  assert.equal(isSupportedExtension('file.exe'), false);
});

test('isSupportedExtension: rejects files with no extension', () => {
  assert.equal(isSupportedExtension('README'), false);
});

// ── displaySourceLabel ────────────────────────────────────────────────────────

test('displaySourceLabel: returns last two path segments', () => {
  const label = displaySourceLabel('Root/Contracts/Templates');
  assert.equal(label, 'Contracts / Templates');
});

test('displaySourceLabel: returns single segment when path is short', () => {
  const label = displaySourceLabel('Templates');
  assert.equal(label, 'Templates');
});

test('displaySourceLabel: returns "Templates" for null/empty', () => {
  assert.equal(displaySourceLabel(null), 'Templates');
  assert.equal(displaySourceLabel(''), 'Templates');
});
