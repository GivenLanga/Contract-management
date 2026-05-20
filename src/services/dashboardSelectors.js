import { trackerConfig } from './legalTrackerStore';
import {
  calcDueState,
  getSignatureFollowUpsForTasksPage,
  isActiveWorkflowItem,
  loadAllWorkflowItems,
} from './workflowTasksSelector';
import {
  getContractPortfolioSummary,
  getContractsNeedingAttention,
  getDashboardContractPipeline,
  getSignedContractsForDashboard,
} from './contractPortfolioSelectors';

const INACTIVE_WORKFLOW_STATUSES = new Set([
  'completed',
  'cancelled',
  'canceled',
  'archived',
  'deleted',
]);

const DUE_ORDER = {
  overdue: 0,
  today: 1,
  soon: 2,
  ok: 3,
  unknown: 4,
};

export function isDashboardActiveWorkflowItem(item) {
  const statuses = [item?.status, item?.appStatus]
    .map((status) => String(status || '').trim().toLowerCase())
    .filter(Boolean);
  return isActiveWorkflowItem(item) && !statuses.some((status) => INACTIVE_WORKFLOW_STATUSES.has(status));
}

export function isTrackerWorkflowItem(item) {
  return item?._type === 'TRACKER' || item?.sourceType === 'LEGAL_TRACKER';
}

export function isUnassignedWorkflowItem(item) {
  const assignee = item?.assignedTo ?? item?.assignee;
  if (!assignee) return true;
  if (typeof assignee === 'string') return assignee.trim() === '';
  if (Array.isArray(assignee)) return assignee.length === 0;
  return !assignee._id && !assignee.id && !assignee.name && !assignee.email;
}

const dueStateForItem = (item) =>
  item?.dueState || calcDueState(item?.deadline || item?.dueDate);

const workflowSort = (a, b) => {
  const aState = dueStateForItem(a);
  const bState = dueStateForItem(b);
  const byState = (DUE_ORDER[aState] ?? DUE_ORDER.unknown) - (DUE_ORDER[bState] ?? DUE_ORDER.unknown);
  if (byState !== 0) return byState;
  const aTime = new Date(a?.deadline || a?.dueDate || 8640000000000000).getTime();
  const bTime = new Date(b?.deadline || b?.dueDate || 8640000000000000).getTime();
  return aTime - bTime;
};

const trackerWarningCount = (activeItems) => {
  const configWarnings = trackerConfig.get()?.warnings?.length || 0;
  const syncWarnings = activeItems.filter((item) =>
    isTrackerWorkflowItem(item) && item.syncStatus && item.syncStatus !== 'SYNCED'
  ).length;
  return configWarnings + syncWarnings;
};

export async function getDashboardOperationsSummary({ user, isManager } = {}) {
  const activeItems = loadAllWorkflowItems()
    .filter(isDashboardActiveWorkflowItem)
    .sort(workflowSort);

  const signatureFollowUpDocuments = await getSignatureFollowUpsForTasksPage({ user, isManager })
    .catch(() => []);

  const overdueTasks = activeItems.filter((item) => dueStateForItem(item) === 'overdue').length;
  const dueToday = activeItems.filter((item) => dueStateForItem(item) === 'today').length;
  const trackerTasks = activeItems.filter(isTrackerWorkflowItem).length;

  return {
    activeWorkflows: activeItems.length,
    overdueTasks,
    dueToday,
    unassignedTasks: activeItems.filter(isUnassignedWorkflowItem).length,
    trackerTasks,
    trackerWarnings: trackerWarningCount(activeItems),
    signatureFollowUps: signatureFollowUpDocuments.length,
    signatureFollowUpDocuments,
    workQueueItems: activeItems,
  };
}

export async function getDashboardData({ user, isManager, now = new Date() } = {}) {
  const operations = await getDashboardOperationsSummary({ user, isManager });
  const signedContracts = getSignedContractsForDashboard(undefined, { now });
  const contractSummary = getContractPortfolioSummary(signedContracts, { now });
  const contractPipeline = getDashboardContractPipeline(signedContracts);
  const contractsNeedingAttention = getContractsNeedingAttention(signedContracts, { now, limit: 6 });

  const diagnostics = {
    workflowActive: operations.activeWorkflows,
    workflowOverdue: operations.overdueTasks,
    workflowDueToday: operations.dueToday,
    workflowUnassigned: operations.unassignedTasks,
    trackerActive: operations.trackerTasks,
    trackerWarnings: operations.trackerWarnings,
    signatureFollowUps: operations.signatureFollowUps,
    signedContracts: contractSummary.totalSignedContracts,
    activeContracts: contractSummary.activeContracts,
    expiringIn30Days: contractSummary.expiringIn30Days,
    expiredContracts: contractSummary.expiredContracts,
    unknownContracts: contractSummary.unknownContracts,
    contractsWithValue: contractSummary.contractsWithValue,
    contractsMissingValue: contractSummary.contractsMissingValue,
    portfolioValue: contractSummary.portfolioValue,
    contractsNeedingAttentionSample: contractsNeedingAttention.slice(0, 3).map((contract) => ({
      id: contract.id,
      title: contract.title,
      expiryDate: contract.endDate,
      daysRemaining: contract.daysRemaining,
      status: contract.portfolioStatus,
    })),
  };

  return {
    operations,
    contractSummary,
    contractPipeline,
    contractsNeedingAttention,
    signedContracts,
    diagnostics,
  };
}
