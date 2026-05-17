import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  CONTRACT_STATUS,
  deriveContractStatus,
  extractContractMetadataFromText,
  extractContractValue,
  extractDates,
} = require('../../../electron/services/contractMetadataExtractor.js');

describe('contract status derivation', () => {
  it('signed contract with future expiry is Active', () => {
    expect(deriveContractStatus({ expiryDate: '2026-12-31' }, { today: '2026-05-17' })).toBe(CONTRACT_STATUS.ACTIVE);
  });

  it('signed contract with past expiry is Expired', () => {
    expect(deriveContractStatus({ expiryDate: '2026-01-01' }, { today: '2026-05-17' })).toBe(CONTRACT_STATUS.EXPIRED);
  });

  it('signed contract expiring within 30 days is Expiring Soon', () => {
    expect(deriveContractStatus({ expiryDate: '2026-06-01' }, { today: '2026-05-17' })).toBe(CONTRACT_STATUS.EXPIRING_SOON);
  });

  it('signed contract with no date is Unknown', () => {
    expect(deriveContractStatus({}, { today: '2026-05-17' })).toBe(CONTRACT_STATUS.UNKNOWN);
  });

  it('terminated contract is Terminated', () => {
    expect(deriveContractStatus({ terminationDate: '2026-02-01', expiryDate: '2027-01-01' }, { today: '2026-05-17' })).toBe(CONTRACT_STATUS.TERMINATED);
  });
});

describe('contract date extraction', () => {
  it('extracts "expires on 30 June 2026"', () => {
    expect(extractDates('This agreement expires on 30 June 2026.')).toMatchObject({
      expiryDate: '2026-06-30',
      endDate: '2026-06-30',
    });
  });

  it('extracts "valid until 31 December 2027"', () => {
    expect(extractDates('The contract remains valid until 31 December 2027.')).toMatchObject({
      expiryDate: '2027-12-31',
      endDate: '2027-12-31',
    });
  });

  it('extracts Effective Date: 16 May 2026', () => {
    expect(extractDates('Effective Date: 16 May 2026')).toMatchObject({
      effectiveDate: '2026-05-16',
      startDate: '2026-05-16',
    });
  });

  it('extracts Commencement Date: 1 January 2026', () => {
    expect(extractDates('Commencement Date: 1 January 2026')).toMatchObject({
      commencementDate: '2026-01-01',
      startDate: '2026-01-01',
    });
  });

  it('extracts dd/mm/yyyy safely as South African date order', () => {
    expect(extractDates('Expiry Date: 16/05/2026')).toMatchObject({
      expiryDate: '2026-05-16',
      endDate: '2026-05-16',
    });
  });
});

describe('contract value extraction', () => {
  it('extracts Contract Value: R 510 000', () => {
    expect(extractContractValue('Contract Value: R 510 000')).toMatchObject({
      contractValue: 510000,
      currency: 'ZAR',
      contractValueDisplay: 'R 510 000',
    });
  });

  it('extracts Loan Amount: R1,000,000', () => {
    expect(extractContractValue('Loan Amount: R1,000,000')).toMatchObject({
      contractValue: 1000000,
      contractValueDisplay: 'R 1 000 000',
    });
  });

  it('extracts ZAR 1 200 000', () => {
    expect(extractContractValue('Total Contract Value: ZAR 1 200 000')).toMatchObject({
      contractValue: 1200000,
      contractValueDisplay: 'R 1 200 000',
    });
  });

  it('extracts R1.2 million', () => {
    expect(extractContractValue('Funding Amount: R1.2 million')).toMatchObject({
      contractValue: 1200000,
      contractValueDisplay: 'R 1 200 000',
    });
  });

  it('warns when equally ranked amounts are ambiguous', () => {
    const result = extractContractValue('Amount: R 100 000. Amount: R 200 000.');
    expect(result.contractValue).toBeNull();
    expect(result.warnings).toContain('Multiple amounts detected; contract value requires review.');
  });
});

describe('contract metadata extraction from text', () => {
  it('returns a complete metadata model from deterministic text', () => {
    const result = extractContractMetadataFromText(`
      Funding Loan Agreement
      Loan Amount: R 510 000
      Effective Date: 1 January 2026
      Expiry Date: 30 June 2026
    `, { today: '2026-05-17' });

    expect(result).toMatchObject({
      agreementFamily: 'FUNDING_LOAN_AGREEMENT',
      contractStatus: 'ACTIVE',
      contractStatusLabel: 'Active',
      contractValue: 510000,
      contractValueDisplay: 'R 510 000',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-06-30',
      endDate: '2026-06-30',
    });
    expect(result.extraction.fieldsFound).toEqual(expect.arrayContaining([
      'contractValue',
      'effectiveDate',
      'expiryDate',
      'contractStatus',
    ]));
  });
});
