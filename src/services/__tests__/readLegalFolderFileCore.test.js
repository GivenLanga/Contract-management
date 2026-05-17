import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Buffer } from 'buffer';

const require = createRequire(import.meta.url);
const { readLegalFolderFileFromRoot } = require('../../../electron/readLegalFolderFileCore.js');

let root;

async function writeFixture(relativePath, content = 'docx') {
  const absolutePath = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, content);
  return absolutePath;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'contractiq-read-file-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('readLegalFolderFileFromRoot', () => {
  it('rejects path traversal', async () => {
    const result = await readLegalFolderFileFromRoot({ relativePath: '../secret.docx' }, {
      legalFolderRoot: root,
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL_BLOCKED' });
  });

  it('rejects absolute paths', async () => {
    const result = await readLegalFolderFileFromRoot({ relativePath: path.join(root, 'Templates/file.docx') }, {
      legalFolderRoot: root,
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL_BLOCKED' });
  });

  it('rejects unsupported extensions', async () => {
    await writeFixture('Templates/app.exe', 'binary');

    const result = await readLegalFolderFileFromRoot({ relativePath: 'Templates/app.exe' }, {
      legalFolderRoot: root,
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_EXTENSION' });
  });

  it('reads an allowed DOCX inside the Legal Folder', async () => {
    await writeFixture('Templates/Addendum Template.docx', 'docx-body');

    const result = await readLegalFolderFileFromRoot({ relativePath: 'Templates/Addendum Template.docx' }, {
      legalFolderRoot: root,
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toMatchObject({
      ok: true,
      fileName: 'Addendum Template.docx',
      extension: '.docx',
      relativePath: 'Templates/Addendum Template.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(Buffer.from(result.arrayBuffer).toString()).toBe('docx-body');
  });

  it('does not expose absolute paths in the success payload', async () => {
    await writeFixture('Templates/Addendum Template.docx', 'docx-body');

    const result = await readLegalFolderFileFromRoot({ relativePath: 'Templates/Addendum Template.docx' }, {
      legalFolderRoot: root,
      fsModule: fs,
      pathModule: path,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.absolutePath).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
