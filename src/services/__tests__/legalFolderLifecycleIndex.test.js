import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LegalFolderLifecycleIndex } = require('../../../electron/services/legalFolderLifecycleIndex.js');

const draft = {
  sourceId: 'src-1',
  fileName: 'Agreement - Draft v1.docx',
  relativePath: 'Contracts/2026/Service Providers/ABC/Drafts/Agreement - Draft v1.docx',
  extension: 'docx',
  fileSize: 100,
  lifecycleStage: 'DRAFT',
  counterparty: 'ABC',
};

describe('LegalFolderLifecycleIndex', () => {
  it('add event upserts metadata', () => {
    const index = new LegalFolderLifecycleIndex();
    index.upsertFileMetadata(draft);
    expect(index.getDrafts('src-1')).toHaveLength(1);
  });

  it('change event updates modified time without duplicating', () => {
    const index = new LegalFolderLifecycleIndex([draft]);
    index.upsertFileMetadata({ ...draft, fileSize: 200, lastModified: '2026-05-17T00:00:00.000Z' });
    expect(index.getDrafts('src-1')).toHaveLength(1);
    expect(index.getDrafts('src-1')[0].fileSize).toBe(200);
  });

  it('unlink event removes metadata', () => {
    const index = new LegalFolderLifecycleIndex([draft]);
    expect(index.removeFileMetadata(draft.relativePath, 'src-1')).toBe(true);
    expect(index.getDrafts('src-1')).toHaveLength(0);
  });

  it('repeated scan does not duplicate records', () => {
    const index = new LegalFolderLifecycleIndex();
    index.replaceSourceFiles('src-1', [draft]);
    index.replaceSourceFiles('src-1', [draft]);
    expect(index.getAllFiles('src-1')).toHaveLength(1);
  });

  it('disconnect clears source index', () => {
    const index = new LegalFolderLifecycleIndex([draft, { ...draft, sourceId: 'src-2' }]);
    index.clearIndexForSource('src-1');
    expect(index.getAllFiles('src-1')).toHaveLength(0);
    expect(index.getAllFiles('src-2')).toHaveLength(1);
  });

  it('gets final, signed, template, and counterparty views', () => {
    const index = new LegalFolderLifecycleIndex([
      draft,
      { ...draft, relativePath: 'Contracts/2026/Service Providers/ABC/Final/A.docx', lifecycleStage: 'FINAL' },
      { ...draft, relativePath: 'Contracts/2026/Service Providers/ABC/Signed/A.pdf', lifecycleStage: 'SIGNED' },
      { ...draft, relativePath: 'Templates/A.docx', lifecycleStage: 'TEMPLATE' },
    ]);
    expect(index.getFinalDocuments('src-1')).toHaveLength(1);
    expect(index.getSignedDocuments('src-1')).toHaveLength(1);
    expect(index.getTemplates('src-1')).toHaveLength(1);
    expect(index.getFilesByCounterparty('ABC', 'src-1')).toHaveLength(4);
  });

  it('preserves signed contract metadata fields', () => {
    const index = new LegalFolderLifecycleIndex();
    index.upsertFileMetadata({
      ...draft,
      relativePath: 'Contracts/2026/Loans/ABC/Signed/Loan.pdf',
      lifecycleStage: 'SIGNED',
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      contractValue: 510000,
      contractValueDisplay: 'R 510 000',
      currency: 'ZAR',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-06-30',
      endDate: '2026-06-30',
      extraction: {
        confidence: 'high',
        warnings: [],
        fieldsFound: ['contractValue', 'expiryDate'],
      },
    });

    expect(index.getSignedDocuments('src-1')[0]).toMatchObject({
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      contractValue: 510000,
      contractValueDisplay: 'R 510 000',
      currency: 'ZAR',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-06-30',
      endDate: '2026-06-30',
      extraction: {
        confidence: 'high',
        fieldsFound: ['contractValue', 'expiryDate'],
      },
    });
  });
});
