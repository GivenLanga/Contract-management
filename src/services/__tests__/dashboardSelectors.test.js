import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../legalTrackerStore', () => ({
  trackerConfig: {
    get: vi.fn(),
  },
}));

vi.mock('../workflowTasksSelector', () => ({
  calcDueState: vi.fn(() => 'unknown'),
  getSignatureFollowUpsForTasksPage: vi.fn(),
  isActiveWorkflowItem: vi.fn((item) => item.appStatus !== 'completed' && item.status !== 'Completed'),
  loadAllWorkflowItems: vi.fn(),
}));

import { trackerConfig } from '../legalTrackerStore';
import {
  getSignatureFollowUpsForTasksPage,
  loadAllWorkflowItems,
} from '../workflowTasksSelector';
import { getDashboardOperationsSummary } from '../dashboardSelectors';

describe('dashboardSelectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackerConfig.get.mockReturnValue({ warnings: [] });
    getSignatureFollowUpsForTasksPage.mockResolvedValue([]);
    loadAllWorkflowItems.mockReturnValue([]);
  });

  it('builds operations counts from active workflow tasks and signature follow-ups', async () => {
    loadAllWorkflowItems.mockReturnValue([
      {
        id: 'tracker-today',
        _type: 'TRACKER',
        sourceType: 'LEGAL_TRACKER',
        title: 'Tracker today',
        status: 'Active',
        dueState: 'today',
        assignedTo: { name: 'Admin' },
      },
      {
        id: 'manual-overdue',
        _type: 'MANUAL',
        sourceType: 'MANUAL_WORKFLOW',
        title: 'Manual overdue',
        status: 'Pending',
        dueState: 'overdue',
        assignedTo: null,
      },
      {
        id: 'tracker-sync',
        _type: 'TRACKER',
        sourceType: 'LEGAL_TRACKER',
        title: 'Tracker sync warning',
        status: 'Active',
        dueState: 'ok',
        assignedTo: { name: 'Faith' },
        syncStatus: 'SYNC_FAILED',
      },
      {
        id: 'completed',
        _type: 'TRACKER',
        sourceType: 'LEGAL_TRACKER',
        title: 'Completed task',
        status: 'Completed',
        appStatus: 'completed',
        dueState: 'overdue',
      },
      {
        id: 'cancelled',
        _type: 'MANUAL',
        sourceType: 'MANUAL_WORKFLOW',
        title: 'Cancelled task',
        status: 'Cancelled',
        dueState: 'today',
      },
    ]);
    trackerConfig.get.mockReturnValue({ warnings: ['Missing assignee', 'Unparsed date', 'Spreadsheet sync', 'Mapping issue'] });
    getSignatureFollowUpsForTasksPage.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ _id: `sig-${index}` })));

    const result = await getDashboardOperationsSummary({
      user: { _id: 'mgr-1', name: 'Manager' },
      isManager: true,
    });

    expect(result).toMatchObject({
      activeWorkflows: 3,
      overdueTasks: 1,
      dueToday: 1,
      unassignedTasks: 1,
      trackerTasks: 2,
      trackerWarnings: 5,
      signatureFollowUps: 21,
    });
    expect(result.workQueueItems.map((item) => item.id)).toEqual([
      'manual-overdue',
      'tracker-today',
      'tracker-sync',
    ]);
  });
});
