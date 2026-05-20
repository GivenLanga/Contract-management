import { getContractsForApp } from './legalFolderStore';
import { classifyLifecycleStage } from './legalFolderLifecycleClassifier';

const MS_PER_DAY = 86400000;

export const DASHBOARD_CONTRACT_PIPELINE = [
  { key: 'active', label: 'Active', status: 'Active', color: '#10b981' },
  { key: 'expiringSoon', label: 'Expiring Soon', status: 'Expiring Soon', color: '#f59e0b' },
  { key: 'expired', label: 'Expired', status: 'Expired', color: '#ef4444' },
  { key: 'unknown', label: 'Unknown', status: 'Unknown', color: '#94a3b8' },
];

const CONTRACT_STATUS_LABELS = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  EXPIRING: 'Expiring Soon',
  EXPIRING_SOON: 'Expiring Soon',
  TERMINATED: 'Expired',
  UNKNOWN: 'Unknown',
};

export function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const parseDateOnlyUtc = (value) => {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const todayUtc = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export function daysUntilExpiry(dateValue, now = new Date()) {
  const expiry = parseDateOnlyUtc(dateValue);
  if (!expiry) return null;
  return Math.ceil((expiry.getTime() - todayUtc(now).getTime()) / MS_PER_DAY);
}

export const endDateForContract = (contract = {}) =>
  contract.expiryDate ||
  contract.expirationDate ||
  contract.endDate ||
  contract.terminationDate ||
  null;

const normalizedStatusLabel = (value) => {
  const raw = String(value || '').trim();
  if (!raw || /^signed$/i.test(raw)) return null;
  const upper = raw.replace(/\s+/g, '_').replace(/-/g, '_').toUpperCase();
  if (CONTRACT_STATUS_LABELS[upper]) return CONTRACT_STATUS_LABELS[upper];
  if (/expiring/i.test(raw)) return 'Expiring Soon';
  if (/expired|terminated/i.test(raw)) return 'Expired';
  if (/active/i.test(raw)) return 'Active';
  if (/unknown/i.test(raw)) return 'Unknown';
  return null;
};

export function portfolioStatusForContract(contract = {}, now = new Date()) {
  const endDate = endDateForContract(contract);
  const daysRemaining = daysUntilExpiry(endDate, now);

  if (daysRemaining !== null) {
    if (daysRemaining < 0) return 'Expired';
    if (daysRemaining <= 30) return 'Expiring Soon';
    return 'Active';
  }

  return (
    normalizedStatusLabel(contract.contractStatusLabel) ||
    normalizedStatusLabel(contract.contractStatus) ||
    normalizedStatusLabel(contract.portfolioStatus) ||
    normalizedStatusLabel(contract.status) ||
    'Unknown'
  );
}

export function normalizePortfolioContract(contract = {}, { now = new Date() } = {}) {
  const endDate = endDateForContract(contract);
  const status = portfolioStatusForContract({ ...contract, endDate }, now);
  const value = optionalNumber(contract.contractValue) ?? optionalNumber(contract.value);
  const daysRemaining = daysUntilExpiry(endDate, now);
  const id =
    contract.id ||
    contract._id ||
    contract.documentId ||
    contract.fileId ||
    contract.sourcePath ||
    contract.relativePath ||
    contract.title ||
    contract.name;

  return {
    ...contract,
    id,
    _id: contract._id || id,
    title: contract.title || contract.name || contract.fileName || 'Untitled contract',
    counterparty: contract.counterparty || contract.party || contract.client || contract.vendor || '-',
    type: contract.type || contract.contractType || contract.category || contract.agreementFamily || 'Agreement',
    category: contract.category || contract.department || contract.contractType || contract.type || '-',
    tags: Array.isArray(contract.tags) ? contract.tags : [],
    status,
    portfolioStatus: status,
    value,
    endDate,
    expiryDate: contract.expiryDate || contract.expirationDate || contract.endDate || endDate,
    daysRemaining,
    contractValueDisplay: contract.contractValueDisplay || null,
  };
}

export function getSignedPortfolioContracts(records = getContractsForApp(), options = {}) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => classifyLifecycleStage(record).lifecycleStage === 'SIGNED')
    .map((record) => normalizePortfolioContract(record, options));
}

export const getSignedContractsForDashboard = getSignedPortfolioContracts;

export function getContractPortfolioSummary(signedContracts = getSignedPortfolioContracts(), { now = new Date() } = {}) {
  const contracts = signedContracts.map((contract) =>
    contract.portfolioStatus ? contract : normalizePortfolioContract(contract, { now })
  );
  const contractsWithValue = contracts.filter((contract) => Number(contract.value) > 0);
  const portfolioValue = contractsWithValue.reduce((sum, contract) => sum + Number(contract.value), 0);

  return {
    totalSignedContracts: contracts.length,
    activeContracts: contracts.filter((contract) => contract.portfolioStatus === 'Active').length,
    expiringIn30Days: contracts.filter((contract) => {
      const days = contract.daysRemaining ?? daysUntilExpiry(contract.endDate, now);
      return days !== null && days >= 0 && days <= 30;
    }).length,
    expiredContracts: contracts.filter((contract) => contract.portfolioStatus === 'Expired').length,
    unknownContracts: contracts.filter((contract) => contract.portfolioStatus === 'Unknown').length,
    contractsWithValue: contractsWithValue.length,
    contractsMissingValue: contracts.length - contractsWithValue.length,
    portfolioValue,
  };
}

export function getDashboardContractPipeline(signedContracts = getSignedPortfolioContracts()) {
  const counts = signedContracts.reduce((acc, contract) => {
    const status = contract.portfolioStatus || contract.status || 'Unknown';
    if (status === 'Active') acc.active += 1;
    else if (status === 'Expiring Soon') acc.expiringSoon += 1;
    else if (status === 'Expired') acc.expired += 1;
    else acc.unknown += 1;
    return acc;
  }, { active: 0, expiringSoon: 0, expired: 0, unknown: 0 });

  return {
    ...counts,
    items: DASHBOARD_CONTRACT_PIPELINE.map((item) => ({
      ...item,
      count: counts[item.key],
    })),
  };
}

export function getContractsNeedingAttention(
  signedContracts = getSignedPortfolioContracts(),
  { now = new Date(), limit = 6 } = {}
) {
  const rows = signedContracts
    .map((contract) => ({
      ...contract,
      daysRemaining: contract.daysRemaining ?? daysUntilExpiry(contract.endDate, now),
    }))
    .filter((contract) => contract.daysRemaining !== null && contract.daysRemaining >= 0)
    .sort((a, b) => {
      if (a.daysRemaining !== b.daysRemaining) return a.daysRemaining - b.daysRemaining;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

  return limit ? rows.slice(0, limit) : rows;
}

export function formatPortfolioValue(value) {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}
