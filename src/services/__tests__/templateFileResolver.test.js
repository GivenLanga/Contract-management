import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../legalFolderFileStore', () => ({
  getLegalFolderFile: vi.fn(),
}));

import { getLegalFolderFile } from '../legalFolderFileStore';
import {
  getTemplateRelativePath,
  resolveTemplateFile,
} from '../templateFileResolver';

const TEMPLATE = {
  _id: 'tpl-1',
  title: 'Addendum Template',
  fileName: 'Addendum Template.docx',
  originalFileName: 'Addendum Template.docx',
  relativePath: 'Templates/Addendum Template.docx',
  extension: 'docx',
  lifecycleStage: 'TEMPLATE',
};

function desktopSuccess(content = 'docx') {
  return {
    ok: true,
    fileName: 'Addendum Template.docx',
    extension: '.docx',
    relativePath: 'Templates/Addendum Template.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    arrayBuffer: new TextEncoder().encode(content).buffer,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete window.contractiq;
  getLegalFolderFile.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.contractiq;
});

describe('templateFileResolver', () => {
  it('reads via Electron Legal Folder file bridge in desktop mode', async () => {
    window.contractiq = {
      readLegalFolderFile: vi.fn().mockResolvedValue(desktopSuccess()),
    };

    const result = await resolveTemplateFile(TEMPLATE);

    expect(result.strategy).toBe('electron');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(window.contractiq.readLegalFolderFile).toHaveBeenCalledWith({
      relativePath: 'Templates/Addendum Template.docx',
    });
  });

  it('does not use browser cache before Electron file read', async () => {
    window.contractiq = {
      readLegalFolderFile: vi.fn().mockResolvedValue(desktopSuccess()),
    };

    await resolveTemplateFile(TEMPLATE);

    expect(getLegalFolderFile).not.toHaveBeenCalled();
  });

  it('uses the relativePath field first', async () => {
    expect(getTemplateRelativePath({
      ...TEMPLATE,
      relativePath: 'Templates/Primary.docx',
      sourcePath: 'Templates/Secondary.docx',
    })).toBe('Templates/Primary.docx');
  });

  it('uses sourcePath fallback and strips a root folder prefix', async () => {
    expect(getTemplateRelativePath({
      title: 'Template',
      sourcePath: 'Legal Folder/Templates/Addendum Template.docx',
    })).toBe('Templates/Addendum Template.docx');
  });

  it('normalizes backslash separators', async () => {
    expect(getTemplateRelativePath({
      title: 'Template',
      relativePath: 'Templates\\Addendum Template.docx',
    })).toBe('Templates/Addendum Template.docx');
  });

  it('rejects a missing path with a clear desktop error', async () => {
    window.contractiq = {
      readLegalFolderFile: vi.fn(),
    };

    await expect(resolveTemplateFile({ title: 'Template' })).rejects.toMatchObject({
      code: 'MISSING_RELATIVE_PATH',
      userMessage: 'The template record does not include a Legal Folder relative path.',
    });
  });

  it('maps FILE_NOT_FOUND to a Legal Folder missing-file message', async () => {
    window.contractiq = {
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: false,
        code: 'FILE_NOT_FOUND',
        message: 'No file',
      }),
    };

    await expect(resolveTemplateFile(TEMPLATE)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      userMessage: 'The template file could not be found in the connected Legal Folder.',
    });
  });

  it('maps LEGAL_FOLDER_ROOT_NOT_SET to a choose-folder message', async () => {
    window.contractiq = {
      readLegalFolderFile: vi.fn().mockResolvedValue({
        ok: false,
        code: 'LEGAL_FOLDER_ROOT_NOT_SET',
        message: 'No root',
      }),
    };

    await expect(resolveTemplateFile(TEMPLATE)).rejects.toMatchObject({
      code: 'LEGAL_FOLDER_ROOT_NOT_SET',
      userMessage: 'Choose your Legal Folder in ContractIQ Desktop before using templates.',
    });
  });

  it('uses IndexedDB cache in browser-only mode', async () => {
    const blob = new Blob(['cached'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    getLegalFolderFile.mockResolvedValue({
      blob,
      name: 'Addendum Template.docx',
      sourcePath: 'Templates/Addendum Template.docx',
    });

    const result = await resolveTemplateFile(TEMPLATE);

    expect(result.strategy).toBe('indexeddb');
    expect(result.blob).toBe(blob);
    expect(getLegalFolderFile).toHaveBeenCalledWith('tpl-1');
  });

  it('reports Template File Not Cached in browser-only mode when cache is missing', async () => {
    getLegalFolderFile.mockResolvedValue(null);

    await expect(resolveTemplateFile(TEMPLATE)).rejects.toMatchObject({
      code: 'TEMPLATE_FILE_NOT_CACHED',
      userMessage: 'The template file is not available in browser cache. Sync the Legal Folder again.',
    });
  });
});
