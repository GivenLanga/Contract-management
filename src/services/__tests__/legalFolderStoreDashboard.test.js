import { beforeEach, describe, expect, it } from 'vitest';
import { clearLegalFolderImport, getContractsForApp } from '../legalFolderStore';

describe('legalFolderStore dashboard data source', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty contract list instead of mock fallback data when no Legal Folder import exists', () => {
    clearLegalFolderImport();

    expect(getContractsForApp()).toEqual([]);
  });
});
