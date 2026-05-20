import { describe, expect, it } from 'vitest';
import {
  getContractPortfolioSummary,
  getContractsNeedingAttention,
  getDashboardContractPipeline,
  getSignedPortfolioContracts,
} from '../contractPortfolioSelectors';

const now = new Date('2026-05-20T12:00:00.000Z');

const signedBase = {
  lifecycleStage: 'SIGNED',
  sourcePath: 'Contracts/2026/Services/Acme/Signed/Agreement.pdf',
  title: 'Signed Agreement',
  counterparty: 'Acme',
  type: 'Service',
};

describe('contractPortfolioSelectors', () => {
  it('counts signed contracts only and excludes drafts, finals, and templates', () => {
    const signedContracts = getSignedPortfolioContracts([
      { ...signedBase, id: 'active', expiryDate: '2026-07-01', contractValue: 100 },
      { ...signedBase, id: 'soon', title: 'Soon Agreement', expiryDate: '2026-05-31', contractValue: 200 },
      { ...signedBase, id: 'expired', title: 'Expired Agreement', expiryDate: '2026-05-01', contractValue: 300 },
      { ...signedBase, id: 'unknown', title: 'Unknown Agreement' },
      { ...signedBase, id: 'draft', lifecycleStage: 'DRAFT', sourcePath: 'Contracts/Drafts/Draft.docx' },
      { ...signedBase, id: 'final', lifecycleStage: 'FINAL', sourcePath: 'Contracts/Final/Final.docx' },
      { ...signedBase, id: 'template', lifecycleStage: 'TEMPLATE', sourcePath: 'Templates/NDA.docx' },
    ], { now });

    const summary = getContractPortfolioSummary(signedContracts, { now });
    const pipeline = getDashboardContractPipeline(signedContracts);

    expect(signedContracts).toHaveLength(4);
    expect(summary).toMatchObject({
      totalSignedContracts: 4,
      activeContracts: 1,
      expiringIn30Days: 1,
      expiredContracts: 1,
      unknownContracts: 1,
      portfolioValue: 600,
    });
    expect(pipeline).toMatchObject({
      active: 1,
      expiringSoon: 1,
      expired: 1,
      unknown: 1,
    });
    expect(pipeline.items.map((item) => item.label)).toEqual([
      'Active',
      'Expiring Soon',
      'Expired',
      'Unknown',
    ]);
  });

  it('sorts contracts needing attention by nearest future expiry and excludes expired or unknown dates', () => {
    const signedContracts = getSignedPortfolioContracts([
      { ...signedBase, id: 'later', title: 'Later Agreement', expiryDate: '2026-06-30' },
      { ...signedBase, id: 'soon', title: 'Soon Agreement', expiryDate: '2026-05-31' },
      { ...signedBase, id: 'expired', title: 'Expired Agreement', expiryDate: '2026-05-01' },
      { ...signedBase, id: 'unknown', title: 'Unknown Agreement' },
    ], { now });

    const attention = getContractsNeedingAttention(signedContracts, { now, limit: 10 });

    expect(attention.map((contract) => contract.id)).toEqual(['soon', 'later']);
    expect(attention[0]).toMatchObject({
      id: 'soon',
      portfolioStatus: 'Expiring Soon',
      daysRemaining: 11,
    });
  });

  it('returns a zero portfolio value when signed contracts have no extracted values', () => {
    const signedContracts = getSignedPortfolioContracts([
      { ...signedBase, id: 'no-value', expiryDate: '2026-07-01', contractValue: null, value: 0 },
    ], { now });

    expect(getContractPortfolioSummary(signedContracts, { now })).toMatchObject({
      portfolioValue: 0,
      contractsWithValue: 0,
      contractsMissingValue: 1,
    });
  });
});
