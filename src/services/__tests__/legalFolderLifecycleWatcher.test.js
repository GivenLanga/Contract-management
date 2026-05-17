import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  LegalFolderLifecycleWatcher,
  applyLifecycleEvent,
  buildFileMetadata,
  notificationForLifecycleEvent,
} = require('../../../electron/services/legalFolderLifecycleWatcher.js');
const { LegalFolderLifecycleIndex } = require('../../../electron/services/legalFolderLifecycleIndex.js');

let root;

async function writeFixture(relativePath, content = 'doc') {
  const absolutePath = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, content);
  return absolutePath;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'contractiq-lifecycle-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('legalFolderLifecycleWatcher events', () => {
  it('add event upserts metadata', async () => {
    const absolutePath = await writeFixture('Contracts/2026/Loans/XYZ/Final/file.docx');
    const index = new LegalFolderLifecycleIndex();
    const result = await applyLifecycleEvent(index, { eventType: 'add', absolutePath }, {
      rootPath: root,
      sourceId: 'src-1',
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result.action).toBe('upsert');
    expect(index.getFinalDocuments('src-1')).toHaveLength(1);
  });

  it('change event updates modified time', async () => {
    const absolutePath = await writeFixture('Contracts/2026/Loans/XYZ/Drafts/file.docx');
    const index = new LegalFolderLifecycleIndex();
    await applyLifecycleEvent(index, { eventType: 'add', absolutePath }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    await fs.promises.writeFile(absolutePath, 'changed');
    await applyLifecycleEvent(index, { eventType: 'change', absolutePath }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    expect(index.getDrafts('src-1')).toHaveLength(1);
    expect(index.getDrafts('src-1')[0].fileSize).toBe('changed'.length);
  });

  it('unlink event removes metadata', async () => {
    const absolutePath = await writeFixture('Contracts/2026/Loans/XYZ/Drafts/file.docx');
    const index = new LegalFolderLifecycleIndex();
    await applyLifecycleEvent(index, { eventType: 'add', absolutePath }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    await applyLifecycleEvent(index, {
      eventType: 'unlink',
      absolutePath,
      relativePath: 'Contracts/2026/Loans/XYZ/Drafts/file.docx',
    }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    expect(index.getDrafts('src-1')).toHaveLength(0);
  });

  it('moving Drafts to Final removes draft and adds final', async () => {
    const draftPath = await writeFixture('Contracts/2026/Loans/XYZ/Drafts/file.docx');
    const finalPath = await writeFixture('Contracts/2026/Loans/XYZ/Final/file.docx');
    const index = new LegalFolderLifecycleIndex();
    await applyLifecycleEvent(index, { eventType: 'add', absolutePath: draftPath }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    await applyLifecycleEvent(index, {
      eventType: 'unlink',
      absolutePath: draftPath,
      relativePath: 'Contracts/2026/Loans/XYZ/Drafts/file.docx',
    }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    await applyLifecycleEvent(index, { eventType: 'add', absolutePath: finalPath }, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path, logger: { info: vi.fn() } });
    expect(index.getDrafts('src-1')).toHaveLength(0);
    expect(index.getFinalDocuments('src-1')).toHaveLength(1);
  });

  it('live final file add triggers ready-for-signing notification', async () => {
    const absolutePath = await writeFixture('Contracts/2026/Loans/XYZ/Final/file.docx');
    const metadata = await buildFileMetadata(absolutePath, { rootPath: root, sourceId: 'src-1', fsModule: fs, pathModule: path });
    const notification = notificationForLifecycleEvent('add', metadata);
    expect(notification.message).toBe('Final contract detected: file.docx. Ready for signing.');
  });

  it('extracts signed contract metadata during lifecycle indexing', async () => {
    const absolutePath = await writeFixture(
      'Contracts/2026/Loans/Khula Data Capture Services Pty Ltd/Signed/Funding Loan Agreement.txt',
      [
        'Funding Loan Agreement',
        'Loan Amount: R 510 000',
        'Effective Date: 1 January 2026',
        'Expiry Date: 30 June 2099',
      ].join('\n')
    );

    const metadata = await buildFileMetadata(absolutePath, {
      rootPath: root,
      sourceId: 'src-1',
      fsModule: fs,
      pathModule: path,
    });

    expect(metadata).toMatchObject({
      lifecycleStage: 'SIGNED',
      counterparty: 'Khula Data Capture Services Pty Ltd',
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      contractValue: 510000,
      contractValueDisplay: 'R 510 000',
      effectiveDate: '2026-01-01',
      expiryDate: '2099-06-30',
      endDate: '2099-06-30',
    });
    expect(metadata.extraction.fieldsFound).toContain('contractValue');
  });
});

describe('legalFolderLifecycleWatcher scans', () => {
  it('initial scan does not spam notifications', async () => {
    await writeFixture('Templates/Addendum.docx');
    await writeFixture('Contracts/2026/Loans/XYZ/Drafts/file.docx');
    const onNotification = vi.fn();
    const watcher = new LegalFolderLifecycleWatcher({
      rootPath: root,
      sourceId: 'src-1',
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
      onNotification,
    });
    const payload = await watcher.fullScan({ notify: false });
    expect(payload.summary).toMatchObject({ templates: 1, drafts: 1 });
    expect(onNotification).not.toHaveBeenCalled();
  });
});
