'use strict';

/**
 * Template discovery service tests (unit-level, no MongoDB).
 *
 * Tests the logic that filters and deduplicates template candidates without
 * running a real database — we verify the classifier and filter helpers that
 * the discovery service relies on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classify,
  cleanTitle,
  isTemplatePath,
  shouldSkip,
  isSupportedExtension,
} = require('../src/services/templateClassifier');

// ── Template folder detection ─────────────────────────────────────────────────

test('discovery: detects loose files inside Root/Templates', () => {
  const files = [
    { name: 'Addendum Template 1.docx', sourcePath: 'Root/Templates/Addendum Template 1.docx' },
    { name: 'Assistance Agreement Template.docx', sourcePath: 'Root/Templates/Assistance Agreement Template.docx' },
    { name: 'Consultancy Agreement Template - Individuals.docx', sourcePath: 'Root/Templates/Consultancy Agreement Template - Individuals.docx' },
    { name: 'Master Services Agreement Template - Juristic Entities.docx', sourcePath: 'Root/Templates/Master Services Agreement Template - Juristic Entities.docx' },
    { name: 'Once-Off Service Agreement Template - Juristic Entities.docx', sourcePath: 'Root/Templates/Once-Off Service Agreement Template - Juristic Entities.docx' },
    { name: 'Revised Funding Loan Agreement template (v2) [20022023].docx', sourcePath: 'Root/Templates/Revised Funding Loan Agreement template (v2) [20022023].docx' },
  ];

  for (const file of files) {
    assert.equal(
      isTemplatePath(file.sourcePath),
      true,
      `Expected template path for: ${file.name}`
    );
    assert.equal(
      shouldSkip(file.name),
      false,
      `Expected not to skip: ${file.name}`
    );
    assert.equal(
      isSupportedExtension(file.name),
      true,
      `Expected supported extension for: ${file.name}`
    );
  }
});

test('discovery: detects loose files inside Contracts/Templates', () => {
  const sourcePath = 'SharedFolder/Contracts/Templates/Master Services Agreement.docx';
  assert.equal(isTemplatePath(sourcePath), true);
});

test('discovery: does not require category subfolders', () => {
  // File sits directly in Templates/ with no subfolder — should still be detected
  const sourcePath = 'Root/Templates/SomeAgreement.docx';
  assert.equal(isTemplatePath(sourcePath), true);
});

test('discovery: ignores ~$ temporary Word files', () => {
  assert.equal(shouldSkip('~$Funding Loan Agreement.docx'), true);
  assert.equal(shouldSkip('~$Master Services Agreement Template.docx'), true);
});

test('discovery: handles filenames with brackets and parentheses', () => {
  const name = 'Revised Funding Loan Agreement template (v2) [20022023].docx';
  assert.equal(shouldSkip(name), false);
  assert.equal(isSupportedExtension(name), true);
  const { title, version } = cleanTitle(name);
  assert.ok(title.length > 0);
  assert.equal(version, 'v2');
});

// ── Classification of discovery candidates ────────────────────────────────────

const ACCEPTANCE_SCENARIO = [
  {
    name: 'Addendum Template 1.docx',
    expectFamily: 'ADDENDUM',
    expectCategory: 'Addenda',
  },
  {
    name: 'Consultancy Agreement Template - Individuals.docx',
    expectFamily: 'CONSULTANCY_AGREEMENT',
    expectCategory: 'Consultancy',
  },
  {
    name: 'Master Services Agreement Template - Juristic Entities.docx',
    expectFamily: 'MASTER_SERVICE_AGREEMENT',
    expectCategory: 'Services',
  },
  {
    name: 'Once-Off Service Agreement Template - Juristic Entities.docx',
    expectFamily: 'ONCE_OFF_SERVICE_AGREEMENT',
    expectCategory: 'Services',
  },
  {
    name: 'Revised Funding Loan Agreement template (v2) [20022023].docx',
    expectFamily: 'FUNDING_LOAN_AGREEMENT',
    expectCategory: 'Loans',
  },
];

for (const scenario of ACCEPTANCE_SCENARIO) {
  test(`discovery: classifies "${scenario.name}" correctly`, () => {
    const { agreementFamily, category } = classify(scenario.name, 'Templates');
    assert.equal(agreementFamily, scenario.expectFamily, `Wrong family for ${scenario.name}`);
    assert.equal(category, scenario.expectCategory, `Wrong category for ${scenario.name}`);
  });
}

test('discovery: Assistance Agreement Template imported with medium or low confidence', () => {
  const { confidence, requiresReview } = classify('Assistance Agreement Template.docx', 'Templates');
  // This is ambiguous — should flag for review if low confidence
  if (confidence === 'low') {
    assert.equal(requiresReview, true);
  }
  // Either way it should not be high confidence
  assert.notEqual(confidence, 'high');
});

// ── Title cleanup for acceptance scenario ─────────────────────────────────────

test('discovery: clean titles match acceptance scenario expectations', () => {
  const cases = [
    { input: 'Addendum Template 1.docx', expectedFragment: 'Addendum' },
    { input: 'Assistance Agreement Template.docx', expectedFragment: 'Assistance Agreement' },
    { input: 'Consultancy Agreement Template - Individuals.docx', expectedFragment: 'Individuals' },
    { input: 'Master Services Agreement Template - Juristic Entities.docx', expectedFragment: 'Juristic Entities' },
    { input: 'Once-Off Service Agreement Template - Juristic Entities.docx', expectedFragment: 'Juristic Entities' },
    { input: 'Revised Funding Loan Agreement template (v2) [20022023].docx', expectedFragment: 'Funding Loan' },
  ];

  for (const { input, expectedFragment } of cases) {
    const { title } = cleanTitle(input);
    assert.ok(
      title.includes(expectedFragment),
      `Expected "${expectedFragment}" in title "${title}" (from "${input}")`
    );
    assert.ok(
      !title.toLowerCase().includes('template'),
      `Word "template" should be removed from "${title}"`
    );
    assert.ok(
      !title.includes('.docx'),
      `Extension should be removed from "${title}"`
    );
  }
});

// ── Alias folder detection ────────────────────────────────────────────────────

test('discovery: detects alias folder names', () => {
  const aliasPaths = [
    'Root/Legal Templates/file.docx',
    'Root/Contract Templates/file.docx',
    'Root/Standard Templates/file.docx',
    'Root/Approved Templates/file.docx',
    'Root/Precedents/file.docx',
    'Root/Boilerplates/file.docx',
    'Root/Forms/file.docx',
  ];

  for (const p of aliasPaths) {
    assert.equal(isTemplatePath(p), true, `Expected template path: ${p}`);
  }
});

test('discovery: non-template paths are rejected', () => {
  const nonTemplatePaths = [
    'Root/Contracts/Funding Loan/2026/file.docx',
    'Root/2026/Company Name/Signed/file.docx',
    'Root/Documents/file.docx',
  ];

  for (const p of nonTemplatePaths) {
    assert.equal(isTemplatePath(p), false, `Expected NOT template path: ${p}`);
  }
});
