import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  classifyLegalFolderPath,
  shouldIgnoreLegalFolderPath,
} = require('../../../electron/services/legalFolderClassifier.js');

describe('Legal Folder path classification', () => {
  it('classifies Templates/Addendum.docx as TEMPLATE', () => {
    expect(classifyLegalFolderPath('Templates/Addendum.docx')).toMatchObject({
      lifecycleStage: 'TEMPLATE',
      isTemplate: true,
    });
  });

  it('classifies Contracts Drafts as DRAFT', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Service Providers/ABC/Drafts/file.docx')).toMatchObject({
      lifecycleStage: 'DRAFT',
      year: '2026',
      category: 'Service Providers',
      counterparty: 'ABC',
      stageFolder: 'Drafts',
    });
  });

  it('classifies Contracts Final as FINAL', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Service Providers/ABC/Final/file.docx')).toMatchObject({
      lifecycleStage: 'FINAL',
      year: '2026',
      category: 'Service Providers',
      counterparty: 'ABC',
      stageFolder: 'Final',
    });
  });

  it('classifies Contracts Signed as SIGNED', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Service Providers/ABC/Signed/file.pdf')).toMatchObject({
      lifecycleStage: 'SIGNED',
      year: '2026',
      category: 'Service Providers',
      counterparty: 'ABC',
      stageFolder: 'Signed',
    });
  });

  it('classifies Signed Documents as SIGNED in the Electron raw scan', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Service Providers/ABC/Signed Documents/file.pdf')).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_ALIAS',
      matchedSegment: 'Signed Documents',
      stageFolder: 'Signed Documents',
    });
  });

  it('classifies signed-like token folders as SIGNED in the Electron raw scan', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Service Providers/ABC/Client Signed Documents/file.pdf')).toMatchObject({
      lifecycleStage: 'SIGNED',
      reason: 'PATH_SEGMENT_SIGNED_TOKEN_RULE',
      matchedSegment: 'Client Signed Documents',
      stageFolder: 'Client Signed Documents',
    });
  });

  it('keeps Final/Signed Agreement.pdf as FINAL in the Electron raw scan', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Service Providers/ABC/Final/Signed Agreement.pdf')).toMatchObject({
      lifecycleStage: 'FINAL',
      matchedSegment: 'Final',
      stageFolder: 'Final',
    });
  });

  it('classifies Approved as FINAL', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Loans/XYZ/Approved/file.docx')).toMatchObject({
      lifecycleStage: 'FINAL',
      category: 'Loans',
      counterparty: 'XYZ',
      stageFolder: 'Approved',
    });
  });

  it('classifies Executed as SIGNED', () => {
    expect(classifyLegalFolderPath('Contracts/2026/Loans/XYZ/Executed/file.pdf')).toMatchObject({
      lifecycleStage: 'SIGNED',
      category: 'Loans',
      counterparty: 'XYZ',
      stageFolder: 'Executed',
    });
  });

  it('classifies unknown paths as UNKNOWN', () => {
    expect(classifyLegalFolderPath('Other/file.docx')).toMatchObject({
      lifecycleStage: 'UNKNOWN',
      isTemplate: false,
      isContractDocument: false,
    });
  });

  it('ignores temporary Office files', () => {
    expect(shouldIgnoreLegalFolderPath('Contracts/2026/Loans/XYZ/Drafts/~$file.docx')).toBe(true);
  });
});
