import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../../context/NotificationContext', () => ({
  useNotifications: () => ({ notifications: [], unreadCount: 0, markRead: vi.fn(), markAllRead: vi.fn(), deleteNotification: vi.fn() }),
  NotificationProvider: ({ children }) => children,
}));

vi.mock('../../../services/api', () => ({
  tasks: {
    list:   vi.fn(),
    get:    vi.fn(),
    stats:  vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findByTrackerKey: vi.fn(),
  },
  auth: {
    users: vi.fn(),
  },
  documents: {
    list: vi.fn(),
  },
  signing: {
    remind: vi.fn(),
  },
}));

vi.mock('../../../services/trackerTaskBridge', () => ({
  retryExcelSync:           vi.fn(),
  upsertTrackerTask:        vi.fn(),
  updateManualTaskAssignee: vi.fn().mockResolvedValue({ ok: true }),
  createManualWorkflowTask: vi.fn(),
  completeManualTask:       vi.fn().mockResolvedValue({ ok: true }),
  markLinkedTaskCompleted:  vi.fn().mockResolvedValue({ ok: true }),
  markLinkedTaskSyncFailed: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../services/legalTrackerStore', () => ({
  trackerTasks: {
    get: vi.fn().mockReturnValue([]),
    set: vi.fn(),
  },
  manualTasks: {
    get:    vi.fn().mockReturnValue([]),
    add:    vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../services/signingStore', () => ({
  getSigningDocuments: vi.fn().mockReturnValue([]),
}));

const mockUseAuth = vi.fn();
vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { tasks as tasksApi, auth as authApi, documents as documentsApi, signing as signingApi } from '../../../services/api';
import { upsertTrackerTask, createManualWorkflowTask } from '../../../services/trackerTaskBridge';
import { trackerTasks as trackerTasksStore, manualTasks as manualTasksStore } from '../../../services/legalTrackerStore';
import { getSigningDocuments } from '../../../services/signingStore';
import TaskList from '../TaskList';

// ── Auth fixtures ──────────────────────────────────────────────────────────────
const STAFF_USER   = { user: { _id: 'user-faith', name: 'Faith', email: 'faith@example.com', role: 'staff' },   isManager: false };
const MANAGER_USER = { user: { _id: 'mgr-1',     name: 'Manager', email: 'mgr@example.com', role: 'manager' }, isManager: true  };

// ── localStorage tracker fixtures ─────────────────────────────────────────────
const LS_TRACKER = {
  id:             'lt-1',
  legalTrackerId: 'Legal-row-6',
  description:    'Update Contracts Management spreadsheet',
  taskType:       'Legal',
  parties:        'Internal',
  department:     'Legal',
  deadline:       '2026-07-01T00:00:00.000Z',
  assignee:       null,
  appStatus:      'active',
  progress:       'In Progress',
  pipelineStage:  'review',
  rowNumber:      6,
  workbookName:   'Legal Tracker.xlsx',
  sheetName:      'Active Matters',
};

const LS_TRACKER_ASSIGNED = { ...LS_TRACKER, id: 'lt-2', assignee: 'Faith', pipelineStage: 'assigned' };
const LS_TRACKER_OVERDUE  = { ...LS_TRACKER, id: 'lt-ov', deadline: '2025-01-01T00:00:00.000Z' };
const LS_TRACKER_COMPLETED = {
  ...LS_TRACKER, id: 'lt-done',
  appStatus: 'completed', progress: 'Completed',
  completedAt: '2026-05-10T09:00:00.000Z',
};
const LS_TRACKER_COMPLETED_LATE = {
  ...LS_TRACKER, id: 'lt-late',
  appStatus:   'completed', progress: 'Completed',
  deadline:    '2026-04-01T00:00:00.000Z',
  completedAt: '2026-05-10T09:00:00.000Z',
};
const LS_TRACKER_MANAGER = {
  ...LS_TRACKER, id: 'lt-mgr',
  assignee: 'Manager', pipelineStage: 'manager',
};

const LS_MANUAL = {
  id:          'mt-1',
  title:       'Draft policy memo',
  description: 'Draft a policy memo for compliance',
  taskType:    'Internal Policy',
  department:  'Compliance',
  dueDate:     '2026-07-15T00:00:00.000Z',
  assignee:    null,
  status:      'Pending',
  pipelineStage: 'intake',
};
const LS_MANUAL_ASSIGNED  = { ...LS_MANUAL, id: 'mt-2', assignee: 'Faith' };
const LS_MANUAL_COMPLETED = { ...LS_MANUAL, id: 'mt-done', status: 'Completed', completedAt: '2026-05-10T09:00:00.000Z' };

// ── Signing fixtures ───────────────────────────────────────────────────────────
const SIGNING_PENDING = {
  _id:       'doc-sig-1',
  name:      'NDA - Acme Corp',
  type:      'NDA',
  status:    'Pending Signature',
  signers:   [
    { email: 'alice@example.com', name: 'Alice', role: 'Party 1' },
    { email: 'bob@example.com',   name: 'Bob',   role: 'Party 2' },
  ],
  signatures:   [],
  signingFields:[{ id: 'f1', required: true, filled: false }, { id: 'f2', required: true, filled: false }],
  preparedBy:   { name: 'Manager', email: 'mgr@example.com', _id: 'mgr-1' },
  uploadedBy:   { name: 'Faith', email: 'faith@example.com', _id: 'user-faith' },
  updatedAt:    '2026-05-15T10:00:00.000Z',
  auditLogs:    [{ action: 'Envelope sent to 2 signers', performedBy: { name: 'Manager' }, createdAt: '2026-05-15T10:00:00.000Z' }],
};
const SIGNING_READY   = { _id: 'doc-ready',   name: 'Service Agreement', status: 'Ready for Signature', signers: [], signatures: [] };
const SIGNING_SIGNED  = { _id: 'doc-signed',  name: 'Fully Signed NDA',  status: 'Signed',             signers: [{ email: 'a@b.com', name: 'A', role: 'Signer' }], signatures: [{ signerName: 'A' }] };
const SIGNING_DECLINED= { _id: 'doc-declined',name: 'Declined Contract', status: 'Declined',           signers: [], signatures: [] };

// ── MongoDB task fixtures (Approvals tab) ──────────────────────────────────────
const APPROVAL_TASK = {
  _id:        'bk-approval-1',
  title:      'Manager Approval: NDA Review',
  type:       'MANAGER_APPROVAL',
  sourceType: 'MANUAL_WORKFLOW',
  trackerMeta:{ taskType: 'Review', department: 'Legal', workflowTaskId: 'wf-1' },
  assignedTo: { _id: 'mgr-1', name: 'Manager', role: 'manager' },
  assignedBy: { _id: 'mgr-1', name: 'Manager' },
  deadline:   '2026-07-01T00:00:00.000Z',
  priority:   'High',
  status:     'Pending',
  syncStatus: null,
};
const APPROVAL_TASK_SYNC_FAILED = {
  ...APPROVAL_TASK,
  _id:        'bk-approval-sf',
  status:     'Completed',
  syncStatus: 'SYNC_FAILED',
  sourceType: 'LEGAL_TRACKER',
  trackerMeta:{ ...APPROVAL_TASK.trackerMeta, rowNumber: 6 },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function setupApprovalApi(tasks = [APPROVAL_TASK]) {
  tasksApi.list.mockResolvedValue({ tasks, total: tasks.length });
  authApi.users.mockResolvedValue({ users: [] });
  documentsApi.list.mockResolvedValue({ documents: [] });
}

function renderTaskList() {
  return render(<MemoryRouter><TaskList /></MemoryRouter>);
}

function renderTaskListAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><TaskList /></MemoryRouter>);
}

function renderAsManager() {
  mockUseAuth.mockReturnValue(MANAGER_USER);
  return render(<MemoryRouter><TaskList /></MemoryRouter>);
}

async function switchToTab(labelPattern) {
  const btn = await screen.findByRole('button', { name: labelPattern });
  await act(async () => { fireEvent.click(btn); });
  return btn;
}

// ── Global beforeEach ─────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  delete window.contractiq;
  trackerTasksStore.get.mockReturnValue([]);
  manualTasksStore.get.mockReturnValue([]);
  getSigningDocuments.mockReturnValue([]);
  documentsApi.list.mockResolvedValue({ documents: [] });
  tasksApi.list.mockResolvedValue({ tasks: [], total: 0 });
  authApi.users.mockResolvedValue({ users: [] });
  signingApi.remind.mockResolvedValue({ message: 'Reminder sent.' });
  mockUseAuth.mockReturnValue(STAFF_USER);
});

// ═════════════════════════════════════════════════════════════════════════════
// §1 — Tab presence
// ═════════════════════════════════════════════════════════════════════════════

it('(tab-1) Tasks page shows Workflow Tasks tab for non-manager', async () => {
  renderTaskList();
  expect(await screen.findByRole('button', { name: /^workflow tasks$/i })).toBeInTheDocument();
});

it('(tab-2) Tasks page does NOT show Tracker Tasks tab', async () => {
  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });
  expect(screen.queryByRole('button', { name: /^tracker tasks$/i })).toBeNull();
});

it('(tab-3) Tasks page does NOT show Manual Tasks tab', async () => {
  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });
  expect(screen.queryByRole('button', { name: /^manual tasks$/i })).toBeNull();
});

it('(tab-4) Tasks page does NOT show Business Input tab', async () => {
  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });
  expect(screen.queryByRole('button', { name: /^business input$/i })).toBeNull();
});

it('(tab-5) Tasks page shows Signature Follow-Ups tab', async () => {
  renderTaskList();
  expect(await screen.findByRole('button', { name: /signature follow-ups/i })).toBeInTheDocument();
});

it('(tab-6) Tasks page shows Completed tab', async () => {
  renderTaskList();
  expect(await screen.findByRole('button', { name: /^completed$/i })).toBeInTheDocument();
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — + New Task button
// ═════════════════════════════════════════════════════════════════════════════

it('(btn-7) + New Task button shown for manager, not + New Contract', async () => {
  renderAsManager();
  expect(await screen.findByRole('button', { name: /\+ new task/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /\+ new contract/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /\+ manual task/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /\+ assign task/i })).toBeNull();
});

it('(btn-8) Clicking + New Task opens ManualTaskModal', async () => {
  renderAsManager();
  const btn = await screen.findByRole('button', { name: /\+ new task/i });
  await act(async () => { fireEvent.click(btn); });
  expect(await screen.findByText(/add manual task/i)).toBeInTheDocument();
});

it('(btn-9) Saving new task adds to manualTasks localStorage', async () => {
  createManualWorkflowTask.mockResolvedValue({ ok: true, task: { _id: 'mn-new' } });
  renderAsManager();

  const btn = await screen.findByRole('button', { name: /\+ new task/i });
  await act(async () => { fireEvent.click(btn); });

  const titleInput = await screen.findByPlaceholderText(/task title/i);
  fireEvent.change(titleInput, { target: { value: 'New test task' } });
  await act(async () => { fireEvent.submit(document.querySelector('.mtm__form')); });

  expect(manualTasksStore.add).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'New test task', sourceType: 'MANUAL_WORKFLOW' })
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — Data connection: localStorage → Workflow Tasks tab
// ═════════════════════════════════════════════════════════════════════════════

it('(dc-1) 10 tracker + 1 manual active items → Workflow Tasks shows 11 rows', async () => {
  const trackerItems = Array.from({ length: 10 }, (_, i) => ({
    ...LS_TRACKER, id: `lt-${i}`, description: `Tracker task ${i}`,
  }));
  trackerTasksStore.get.mockReturnValue(trackerItems);
  manualTasksStore.get.mockReturnValue([LS_MANUAL]);

  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(11);
  });
});

it('(dc-2) Workflow Tasks includes unassigned tracker items', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]); // no assignee
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  expect(await screen.findByText('Unassigned')).toBeInTheDocument();
  expect(await screen.findByText(LS_TRACKER.description)).toBeInTheDocument();
});

it('(dc-3) Workflow Tasks includes assigned tracker items', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_ASSIGNED]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  expect(await screen.findByText('Faith')).toBeInTheDocument();
  expect(await screen.findByText(LS_TRACKER.description)).toBeInTheDocument();
});

it('(dc-4) Workflow Tasks includes manual workflow items', async () => {
  manualTasksStore.get.mockReturnValue([LS_MANUAL]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  expect(await screen.findByText(LS_MANUAL.title)).toBeInTheDocument();
  expect(await screen.findByText('Manual')).toBeInTheDocument();
});

it('(dc-5) Workflow Tasks excludes completed tracker items (appStatus=completed)', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_COMPLETED, LS_TRACKER]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  await screen.findByText(LS_TRACKER.description); // active one visible
  // Only 1 row — the completed one is excluded
  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(1);
  });
});

it('(dc-6) Workflow Tasks excludes completed manual items (status=Completed)', async () => {
  manualTasksStore.get.mockReturnValue([LS_MANUAL_COMPLETED, LS_MANUAL]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  await screen.findByText(LS_MANUAL.title);
  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(1);
  });
});

it('(dc-7) Workflow Tasks KPI card count matches active localStorage items', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER, LS_TRACKER_ASSIGNED, LS_TRACKER_COMPLETED]);
  manualTasksStore.get.mockReturnValue([LS_MANUAL]);

  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });

  // 2 active trackers + 1 active manual = 3
  const statValues = document.querySelectorAll('.tl__stat-value');
  const workflowStat = Array.from(statValues).find(el => el.textContent === '3');
  expect(workflowStat).toBeTruthy();
});

it('(dc-8) Workflow Tasks does NOT call tasksApi.list', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);
  await screen.findByText(LS_TRACKER.description);

  // The API should only be called for approvals, not for the workflow tab
  const workflowCalls = tasksApi.list.mock.calls.filter(
    ([params]) => params?.workflowTasks === 'true'
  );
  expect(workflowCalls.length).toBe(0);
});

it('(dc-9) Tracker badge shows "Tracker", not "Manual Workflow" or "Tracker Tasks"', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  expect(await screen.findByText('Tracker')).toBeInTheDocument();
  expect(screen.queryByText('Tracker Tasks')).toBeNull();
  expect(screen.queryByText('Manual Workflow')).toBeNull();
});

it('(dc-10) Manual badge shows "Manual", not "Manual Workflow"', async () => {
  manualTasksStore.get.mockReturnValue([LS_MANUAL]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  expect(await screen.findByText('Manual')).toBeInTheDocument();
  expect(screen.queryByText('Manual Workflow')).toBeNull();
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — Tab filtering
// ═════════════════════════════════════════════════════════════════════════════

it('(tf-1) My Tasks shows items assigned to current user, not others', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_ASSIGNED, LS_TRACKER_MANAGER]);
  renderTaskList(); // default tab = My Tasks, user = Faith

  // Faith's item should show, Manager's should not
  expect(await screen.findByText(LS_TRACKER.description)).toBeInTheDocument();
  const rows = document.querySelectorAll('.tl__row');
  expect(rows.length).toBe(1);
});

it('(tf-2) Team Tasks shows all assigned items', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_ASSIGNED, LS_TRACKER_MANAGER, LS_TRACKER]);
  renderAsManager();
  await switchToTab(/^team tasks$/i);

  // 2 assigned items, 1 unassigned excluded
  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(2);
  });
});

it('(tf-3) Team Tasks excludes unassigned items', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]);  // no assignee
  renderAsManager();
  await switchToTab(/^team tasks$/i);

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(0);
  });
  expect(screen.getByText(/no tasks in this view/i)).toBeInTheDocument();
});

it('(tf-4) Unassigned shows items without assignee', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER, LS_TRACKER_ASSIGNED]);
  renderAsManager();
  await switchToTab(/^unassigned$/i);

  // Only the unassigned item
  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(1);
  });
  expect(screen.getAllByText('Unassigned').length).toBeGreaterThanOrEqual(1);
});

it('(tf-4b) Tasks tab query opens Unassigned directly', async () => {
  const assigned = { ...LS_TRACKER_ASSIGNED, description: 'Assigned tracker task' };
  trackerTasksStore.get.mockReturnValue([LS_TRACKER, assigned]);
  mockUseAuth.mockReturnValue(MANAGER_USER);

  renderTaskListAt('/tasks?tab=unassigned');

  expect(await screen.findByText(LS_TRACKER.description)).toBeInTheDocument();
  expect(screen.queryByText(assigned.description)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^unassigned$/i })).toHaveClass('tl__tab--active');
});

it('(tf-5) Overdue shows items whose deadline is in the past', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_OVERDUE, LS_TRACKER]);
  renderTaskList();
  await switchToTab(/^overdue$/i);

  // Only the overdue item (deadline in 2025)
  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(1);
  });
  expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(1);
});

it('(tf-6) Overdue tab excludes completed items', async () => {
  const completedOverdue = {
    ...LS_TRACKER_OVERDUE, id: 'lt-comp-ov',
    appStatus: 'completed', completedAt: '2026-01-15T00:00:00.000Z',
  };
  trackerTasksStore.get.mockReturnValue([completedOverdue]);
  renderTaskList();
  await switchToTab(/^overdue$/i);

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(0);
  });
});

it('(tf-7) Completed tab shows completed tracker and manual items', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_COMPLETED]);
  manualTasksStore.get.mockReturnValue([LS_MANUAL_COMPLETED]);
  renderTaskList();
  await switchToTab(/^completed$/i);

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(2);
  });
  // Both show Completed status
  const pills = document.querySelectorAll('.tl__status-pill');
  expect(Array.from(pills).every(p => p.textContent === 'Completed')).toBe(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — Assignment from Tasks
// ═════════════════════════════════════════════════════════════════════════════

it('(asgn-16) Assigning tracker item updates trackerTasksStore with assignee name', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]);
  upsertTrackerTask.mockResolvedValue({ ok: true, created: true });
  authApi.users.mockResolvedValue({ users: [{ _id: 'u-faith', name: 'Faith', role: 'staff' }] });

  renderAsManager();
  await switchToTab(/^workflow tasks$/i);

  const assignBtn = await screen.findByRole('button', { name: /^assign$/i });
  await act(async () => { fireEvent.click(assignBtn); });

  const select = await screen.findByRole('combobox');
  fireEvent.change(select, { target: { value: 'u-faith' } });
  await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });

  await waitFor(() => {
    expect(trackerTasksStore.set).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 6, assignee: 'Faith' })
      ])
    );
  });
});

it('(asgn-17) AssignModal opens with user selector when Assign clicked', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]);
  authApi.users.mockResolvedValue({ users: [{ _id: 'u-faith', name: 'Faith', role: 'staff' }] });

  renderAsManager();
  await switchToTab(/^workflow tasks$/i);

  const assignBtn = await screen.findByRole('button', { name: /^assign$/i });
  await act(async () => { fireEvent.click(assignBtn); });

  expect(await screen.findByRole('combobox')).toBeInTheDocument();
  expect(screen.getByText(/assign to/i)).toBeInTheDocument();
});

it('(asgn-18) Assigning manual item updates manualTasksStore and does NOT call Excel', async () => {
  const mockWrite = vi.fn();
  window.contractiq = { trackerUpdateRow: mockWrite };
  manualTasksStore.get.mockReturnValue([LS_MANUAL]);
  authApi.users.mockResolvedValue({ users: [{ _id: 'u-faith', name: 'Faith', role: 'staff' }] });

  renderAsManager();
  await switchToTab(/^workflow tasks$/i);

  const assignBtn = await screen.findByRole('button', { name: /^assign$/i });
  await act(async () => { fireEvent.click(assignBtn); });

  const select = await screen.findByRole('combobox');
  fireEvent.change(select, { target: { value: 'u-faith' } });
  await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });

  await waitFor(() => expect(manualTasksStore.update).toHaveBeenCalled());
  expect(mockWrite).not.toHaveBeenCalled();
});

it('(asgn-19) After assigning unassigned item, it leaves Unassigned tab and appears in Team Tasks', async () => {
  const updatedTracker = { ...LS_TRACKER, assignee: 'Faith' };
  trackerTasksStore.get
    .mockReturnValueOnce([LS_TRACKER])         // initial load (unassigned)
    .mockReturnValue([updatedTracker]);         // after assign reload

  authApi.users.mockResolvedValue({ users: [{ _id: 'u-faith', name: 'Faith', role: 'staff' }] });
  renderAsManager();
  await switchToTab(/^unassigned$/i);
  expect(await screen.findByRole('button', { name: /^assign$/i })).toBeInTheDocument();

  const assignBtn = screen.getByRole('button', { name: /^assign$/i });
  await act(async () => { fireEvent.click(assignBtn); });
  const select = await screen.findByRole('combobox');
  fireEvent.change(select, { target: { value: 'u-faith' } });
  await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });

  // After reload, Unassigned should be empty
  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 — Done / Completion from Tasks
// ═════════════════════════════════════════════════════════════════════════════

it('(d-1) Clicking Done on tracker item opens DoneConfirmModal', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_ASSIGNED]); // assignee = Faith
  renderTaskList(); // renders as Faith (STAFF_USER) — isOwner

  await switchToTab(/^workflow tasks$/i);
  const doneBtn = await screen.findByRole('button', { name: /^done$/i });
  await act(async () => { fireEvent.click(doneBtn); });

  expect(await screen.findByText(/mark tracker task as done/i)).toBeInTheDocument();
});

it('(d-2) After confirming Done, tracker item removed from active Workflow Tasks', async () => {
  const completed = { ...LS_TRACKER_ASSIGNED, appStatus: 'completed', completedAt: new Date().toISOString() };
  trackerTasksStore.get
    .mockReturnValueOnce([LS_TRACKER_ASSIGNED])
    .mockReturnValue([completed]);

  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  const doneBtn = await screen.findByRole('button', { name: /^done$/i });
  await act(async () => { fireEvent.click(doneBtn); });

  const confirmBtn = await screen.findByRole('button', { name: /mark done/i });
  await act(async () => { fireEvent.click(confirmBtn); });

  await waitFor(() => {
    expect(trackerTasksStore.set).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: LS_TRACKER_ASSIGNED.id, appStatus: 'completed' })
      ])
    );
  });
});

it('(d-3) Completing tracker item with Electron writes to Excel', async () => {
  const mockWrite = vi.fn().mockResolvedValue({ ok: true });
  window.contractiq = { trackerUpdateRow: mockWrite };
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_ASSIGNED]);

  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  const doneBtn = await screen.findByRole('button', { name: /^done$/i });
  await act(async () => { fireEvent.click(doneBtn); });

  const confirmBtn = await screen.findByRole('button', { name: /mark done/i });
  await act(async () => { fireEvent.click(confirmBtn); });

  await waitFor(() => {
    expect(mockWrite).toHaveBeenCalledWith({
      rowNumber:    6,
      fieldUpdates: { progress: 'Completed' },
    });
  });
});

it('(d-4) Completing manual item does not call Excel, calls completeManualTask', async () => {
  const mockWrite = vi.fn();
  window.contractiq = { trackerUpdateRow: mockWrite };
  manualTasksStore.get.mockReturnValue([LS_MANUAL_ASSIGNED]);

  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  const doneBtn = await screen.findByRole('button', { name: /^done$/i });
  await act(async () => { fireEvent.click(doneBtn); });

  const confirmBtn = await screen.findByRole('button', { name: /mark done/i });
  await act(async () => { fireEvent.click(confirmBtn); });

  await waitFor(() => expect(manualTasksStore.update).toHaveBeenCalled());
  expect(mockWrite).not.toHaveBeenCalled();
});

// ═════════════════════════════════════════════════════════════════════════════
// §7 — Signature Follow-Ups: must read server + local merged docs
// ═════════════════════════════════════════════════════════════════════════════

it('(sf-1) Shows Pending Signature docs from documents.list (server)', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_PENDING] });
  getSigningDocuments.mockReturnValue([]);

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('NDA - Acme Corp')).toBeInTheDocument();
  expect(screen.getByText('0/2 signed')).toBeInTheDocument();
});

it('(sf-2) 21 Pending Signature server docs → Shows 21 rows', async () => {
  const docs21 = Array.from({ length: 21 }, (_, i) => ({
    ...SIGNING_PENDING,
    _id: `doc-${i}`,
    name: `Document ${i}`,
  }));
  documentsApi.list.mockResolvedValue({ documents: docs21 });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(21);
  });
});

it('(sf-3) Signature Follow-Ups excludes Ready for Signature docs', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_READY, SIGNING_PENDING] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  await screen.findByText('NDA - Acme Corp');
  expect(screen.queryByText('Service Agreement')).toBeNull();
});

it('(sf-4) Signature Follow-Ups excludes Signed docs', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_SIGNED, SIGNING_PENDING] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  await screen.findByText('NDA - Acme Corp');
  expect(screen.queryByText('Fully Signed NDA')).toBeNull();
});

it('(sf-5) Signature Follow-Ups excludes Declined docs', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_DECLINED, SIGNING_PENDING] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  await screen.findByText('NDA - Acme Corp');
  expect(screen.queryByText('Declined Contract')).toBeNull();
});

it('(sf-6) Open Signing button navigates to the specific signing document view', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_PENDING] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  const btn = await screen.findByRole('button', { name: /open signing/i });
  fireEvent.click(btn);
  expect(mockNavigate).toHaveBeenCalledWith('/signing/view/doc-sig-1', {
    state: {
      returnTo: '/tasks?tab=signature-follow-ups',
      returnTab: 'signature-follow-ups',
      returnLabel: 'Signature Follow-Ups',
    },
  });
});

it('(sf-7) Local signing docs also shown when server is offline', async () => {
  documentsApi.list.mockRejectedValue(new Error('offline'));
  getSigningDocuments.mockReturnValue([SIGNING_PENDING]);

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('NDA - Acme Corp')).toBeInTheDocument();
});

it('(sf-8) Server docs merged with local — server takes priority, no duplicates', async () => {
  const serverDoc = { ...SIGNING_PENDING, name: 'NDA - Server Version' };
  const localDoc  = { ...SIGNING_PENDING, name: 'NDA - Local Version'  }; // same _id
  documentsApi.list.mockResolvedValue({ documents: [serverDoc] });
  getSigningDocuments.mockReturnValue([localDoc]);

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  // Server version wins (same _id)
  expect(await screen.findByText('NDA - Server Version')).toBeInTheDocument();
  expect(screen.queryByText('NDA - Local Version')).toBeNull();
  const rows = document.querySelectorAll('.tl__row');
  expect(rows.length).toBe(1);
});

it('(sf-9) Partial signer progress shows signed and pending states separately', async () => {
  const partial = {
    ...SIGNING_PENDING,
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Party 1', signingStatus: 'signed', signedAt: '2026-05-16T10:00:00.000Z' },
      { email: 'bob@example.com', name: 'Bob', role: 'Party 2', signingStatus: 'not_signed' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [partial] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('1/2 signed')).toBeInTheDocument();
  expect(screen.getByText(/Alice — Party 1 · Signed/i)).toBeInTheDocument();
  expect(screen.getByText(/Bob — Party 2 · Pending/i)).toBeInTheDocument();
  expect(screen.getByText('Partially Signed')).toBeInTheDocument();
  expect(screen.getByText('✓')).toHaveClass('tl__signer-badge--signed');
});

it('(sf-10) Send Reminder opens confirmation with pending signers only', async () => {
  const partial = {
    ...SIGNING_PENDING,
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Party 1', signingStatus: 'signed', signedAt: '2026-05-16T10:00:00.000Z' },
      { email: 'bob@example.com', name: 'Bob', role: 'Party 2', signingStatus: 'not_signed' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [partial] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  fireEvent.click(await screen.findByRole('button', { name: /send reminder/i }));

  expect(await screen.findByText('Send signature reminder?')).toBeInTheDocument();
  expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  expect(screen.queryByText('alice@example.com')).toBeNull();
});

it('(sf-11) Confirming Send Reminder calls reminder API only for pending signers', async () => {
  const partial = {
    ...SIGNING_PENDING,
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Party 1', signingStatus: 'signed', signedAt: '2026-05-16T10:00:00.000Z' },
      { email: 'bob@example.com', name: 'Bob', role: 'Party 2', signingStatus: 'not_signed' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [partial] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  fireEvent.click(await screen.findByRole('button', { name: /send reminder/i }));
  const confirmButtons = screen.getAllByRole('button', { name: /^send reminder$/i });
  fireEvent.click(confirmButtons[confirmButtons.length - 1]);

  await waitFor(() => {
    expect(signingApi.remind).toHaveBeenCalledWith('doc-sig-1', 'bob@example.com');
  });
  expect(signingApi.remind).toHaveBeenCalledTimes(1);
  expect(signingApi.remind).not.toHaveBeenCalledWith('doc-sig-1', 'alice@example.com');
  expect(await screen.findByText(/Reminder sent to 1 pending signer/i)).toBeInTheDocument();
});

it('(sf-12) Send Reminder failure is visible', async () => {
  signingApi.remind.mockRejectedValue(new Error('Reminder service not configured.'));
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_PENDING] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  fireEvent.click(await screen.findByRole('button', { name: /send reminder/i }));
  const confirmButtons = screen.getAllByRole('button', { name: /^send reminder$/i });
  fireEvent.click(confirmButtons[confirmButtons.length - 1]);

  expect((await screen.findAllByText('Reminder service not configured.')).length).toBeGreaterThan(0);
});

it('(sf-13) Fully signed Pending Signature docs are hidden from follow-ups', async () => {
  const fullySigned = {
    ...SIGNING_PENDING,
    _id: 'doc-fully-pending',
    name: 'Fully signed but stale status',
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Party 1', signedAt: '2026-05-16T10:00:00.000Z' },
      { email: 'bob@example.com', name: 'Bob', role: 'Party 2', hasSigned: true },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [fullySigned, SIGNING_PENDING] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('NDA - Acme Corp')).toBeInTheDocument();
  expect(screen.queryByText('Fully signed but stale status')).toBeNull();
});

it('(sf-14) Signature Follow-Ups does not render Audit Trail in Actions', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_PENDING] });

  renderAsManager();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByRole('button', { name: /open signing/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /audit trail/i })).toBeNull();
});

it('(sf-15) Prepared By cell shows the preparer name only', async () => {
  const prepared = { ...SIGNING_PENDING, preparedBy: { name: 'Admin', email: 'admin@example.com' } };
  documentsApi.list.mockResolvedValue({ documents: [prepared] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('Admin')).toBeInTheDocument();
  expect(document.querySelector('.tl__owner-role')).toBeNull();
});

it('(sf-16) Missing preparer displays dash', async () => {
  const missingPreparer = { ...SIGNING_PENDING, preparedBy: null, uploadedBy: null };
  documentsApi.list.mockResolvedValue({ documents: [missingPreparer] });

  renderAsManager();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('NDA - Acme Corp')).toBeInTheDocument();
  expect(document.querySelector('.tl__col-owner').textContent).toBe('—');
});

it('(sf-17) Tasks tab query opens Signature Follow-Ups directly', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_PENDING] });

  renderTaskListAt('/tasks?tab=signature-follow-ups');

  expect(await screen.findByText('NDA - Acme Corp')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /signature follow-ups/i })).toHaveClass('tl__tab--active');
});

it('(sf-18) Reminder badges render in the right-side signer row slot', async () => {
  const reminded = {
    ...SIGNING_PENDING,
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Party 1', signingStatus: 'not_signed', lastReminderAt: '2026-05-20T08:00:00.000Z' },
      { email: 'bob@example.com', name: 'Bob', role: 'Party 2', signingStatus: 'not_signed', lastReminderAt: '2026-05-20T08:00:00.000Z' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [reminded] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  const signerRows = await screen.findAllByText(/Reminder sent/i);
  const inlineBadges = signerRows.filter((node) => node.classList.contains('tl__reminded-badge'));
  expect(inlineBadges).toHaveLength(2);
  inlineBadges.forEach((badge) => {
    const row = badge.closest('.tl__signer-line');
    expect(row.children[0]).toHaveClass('tl__signer-badge');
    expect(row.children[1]).toHaveClass('tl__signer-main');
    expect(row.children[2]).toHaveClass('tl__reminded-badge');
  });
});

it('(sf-19) Long signer names keep reminder badge separate from signer text', async () => {
  const reminded = {
    ...SIGNING_PENDING,
    signers: [
      {
        email: 'long@example.com',
        name: 'A very long signer name that should not push the reminder badge into the text',
        role: 'Lender',
        signingStatus: 'not_signed',
        lastReminderAt: '2026-05-20T08:00:00.000Z',
      },
      { email: 'signed@example.com', name: 'Signed Person', role: 'Borrower', signingStatus: 'signed', signedAt: '2026-05-20T07:00:00.000Z' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [reminded] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  const longName = await screen.findByText(/A very long signer name/i);
  expect(longName).toHaveClass('tl__signer-main');
  expect(longName.nextElementSibling).toHaveClass('tl__reminded-badge');
  const signedName = screen.getByText(/Signed Person/i);
  expect(signedName).toHaveClass('tl__signer-main');
  expect(signedName.nextElementSibling).toHaveClass('tl__reminder-slot');
});

it('(sf-20) Remind Again button still opens reminder modal', async () => {
  const reminded = {
    ...SIGNING_PENDING,
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Party 1', signingStatus: 'not_signed', lastReminderAt: '2026-05-20T08:00:00.000Z' },
      { email: 'bob@example.com', name: 'Bob', role: 'Party 2', signingStatus: 'not_signed' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [reminded] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  fireEvent.click(await screen.findByRole('button', { name: /remind again/i }));
  expect(await screen.findByText('Send signature reminder?')).toBeInTheDocument();
});

it('(sf-21) Signer status badges still show Signed, Pending, and Viewed', async () => {
  const mixed = {
    ...SIGNING_PENDING,
    signers: [
      { email: 'signed@example.com', name: 'Signed', role: 'Party 1', signingStatus: 'signed', signedAt: '2026-05-20T07:00:00.000Z' },
      { email: 'viewed@example.com', name: 'Viewed', role: 'Party 2', signingStatus: 'not_signed', viewedAt: '2026-05-20T08:00:00.000Z' },
      { email: 'pending@example.com', name: 'Pending', role: 'Party 3', signingStatus: 'not_signed' },
    ],
  };
  documentsApi.list.mockResolvedValue({ documents: [mixed] });

  renderTaskList();
  await switchToTab(/signature follow-ups/i);

  expect(await screen.findByText('✓')).toHaveClass('tl__signer-badge--signed');
  expect(screen.getByText('Viewed')).toHaveClass('tl__signer-badge--viewed');
  expect(screen.getByText('Pending')).toHaveClass('tl__signer-badge--pending');
});

// ═════════════════════════════════════════════════════════════════════════════
// §8 — KPI cards
// ═════════════════════════════════════════════════════════════════════════════

it('(kpi-1) Sig Follow-ups KPI matches pending signing docs count', async () => {
  documentsApi.list.mockResolvedValue({ documents: [SIGNING_PENDING] });
  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });

  // Wait for async signing load
  await waitFor(() => {
    const sigLabel = screen.getByText('Sig. Follow-ups');
    const card = sigLabel.closest('button');
    expect(card.querySelector('.tl__stat-value').textContent).toBe('1');
  });
});

it('(kpi-2) Workflow Tasks KPI is 0 when localStorage is empty', async () => {
  trackerTasksStore.get.mockReturnValue([]);
  manualTasksStore.get.mockReturnValue([]);
  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });

  const allWfLabels = screen.getAllByText('Workflow Tasks');
  const kpiLabel    = allWfLabels.find(el => el.classList.contains('tl__stat-label'));
  const card        = kpiLabel.closest('button');
  expect(card.querySelector('.tl__stat-value').textContent).toBe('0');
});

// ═════════════════════════════════════════════════════════════════════════════
// §9 — Completed tab with date filter
// ═════════════════════════════════════════════════════════════════════════════

it('(cpl-28) Completed tab shows date-range filter dropdown', async () => {
  renderTaskList();
  await switchToTab(/^completed$/i);
  expect(await screen.findByRole('combobox', { name: /completed date range/i })).toBeInTheDocument();
});

it('(cpl-29) Completed filter "Past week" shows items within last 7 days', async () => {
  const recent = {
    ...LS_TRACKER_COMPLETED, id: 'lt-recent',
    completedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  };
  const old = {
    ...LS_TRACKER_COMPLETED, id: 'lt-old',
    completedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  };
  trackerTasksStore.get.mockReturnValue([recent, old]);

  renderTaskList();
  await switchToTab(/^completed$/i);

  const filter = await screen.findByRole('combobox', { name: /completed date range/i });
  await act(async () => { fireEvent.change(filter, { target: { value: 'week' } }); });

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(1);
  });
});

it('(cpl-30) Completed filter "All time" shows all completed items', async () => {
  const veryOld = { ...LS_TRACKER_COMPLETED, id: 'lt-very-old', completedAt: '2020-01-01T00:00:00.000Z' };
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_COMPLETED, veryOld]);

  renderTaskList();
  await switchToTab(/^completed$/i);

  const filter = await screen.findByRole('combobox', { name: /completed date range/i });
  await act(async () => { fireEvent.change(filter, { target: { value: 'all' } }); });

  await waitFor(() => {
    expect(document.querySelectorAll('.tl__row').length).toBe(2);
  });
});

it('(cpl-31) Completed late task shows "Completed late" label', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_COMPLETED_LATE]);
  renderTaskList();
  await switchToTab(/^completed$/i);

  const filter = await screen.findByRole('combobox', { name: /completed date range/i });
  await act(async () => { fireEvent.change(filter, { target: { value: 'all' } }); });

  expect(await screen.findByText('Completed late')).toBeInTheDocument();
  expect(document.querySelectorAll('.tl__row--overdue').length).toBe(0);
});

// ═════════════════════════════════════════════════════════════════════════════
// §10 — Approvals tab (MongoDB-backed MANAGER_APPROVAL tasks)
// ═════════════════════════════════════════════════════════════════════════════

it('(ap-1) Approvals tab fetches from tasksApi.list with taskType=MANAGER_APPROVAL', async () => {
  setupApprovalApi([APPROVAL_TASK]);
  renderAsManager();
  await switchToTab(/^approvals$/i);

  await waitFor(() => {
    expect(tasksApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'MANAGER_APPROVAL' })
    );
  });
});

it('(ap-2) Approvals tab shows approval task title', async () => {
  setupApprovalApi([APPROVAL_TASK]);
  renderAsManager();
  await switchToTab(/^approvals$/i);

  expect(await screen.findByText('Manager Approval: NDA Review')).toBeInTheDocument();
});

it('(ap-3) Sync-failed approval shows tl__row--sync-failed CSS class', async () => {
  setupApprovalApi([APPROVAL_TASK_SYNC_FAILED]);
  renderAsManager();
  await switchToTab(/^approvals$/i);

  await screen.findByText('Manager Approval: NDA Review');
  expect(document.querySelector('.tl__row--sync-failed')).not.toBeNull();
});

it('(ap-4) Sync-failed approval shows Retry Sync button', async () => {
  setupApprovalApi([APPROVAL_TASK_SYNC_FAILED]);
  renderAsManager();
  await switchToTab(/^approvals$/i);

  expect(await screen.findByRole('button', { name: /retry sync/i })).toBeInTheDocument();
});

// ═════════════════════════════════════════════════════════════════════════════
// §11 — Misc / regression
// ═════════════════════════════════════════════════════════════════════════════

it('(reg-1) Workflows button navigates to /workflows', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER_ASSIGNED]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  const btn = await screen.findByRole('button', { name: /^workflows$/i });
  fireEvent.click(btn);
  expect(mockNavigate).toHaveBeenCalledWith('/workflows');
});

it('(reg-2) search filters workflow items by title', async () => {
  const itemA = { ...LS_TRACKER, id: 'lt-a', description: 'NDA Review Matter', legalTrackerId: 'LR-001' };
  const itemB = { ...LS_TRACKER, id: 'lt-b', description: 'Employment Contract', legalTrackerId: 'LR-002' };
  trackerTasksStore.get.mockReturnValue([itemA, itemB]);

  renderTaskList();
  await switchToTab(/^workflow tasks$/i);
  await waitFor(() => expect(document.querySelectorAll('.tl__row').length).toBe(2));

  const searchInput = screen.getByPlaceholderText(/search tasks/i);
  fireEvent.change(searchInput, { target: { value: 'NDA' } });

  await waitFor(() => expect(document.querySelectorAll('.tl__row').length).toBe(1));
  expect(screen.getByText('NDA Review Matter')).toBeInTheDocument();
});

it('(reg-3) search filters by legalTrackerId', async () => {
  const itemA = { ...LS_TRACKER, id: 'lt-a', legalTrackerId: 'LR-006' };
  const itemB = { ...LS_TRACKER, id: 'lt-b', legalTrackerId: 'LR-099' };
  trackerTasksStore.get.mockReturnValue([itemA, itemB]);

  renderTaskList();
  await switchToTab(/^workflow tasks$/i);
  await waitFor(() => expect(document.querySelectorAll('.tl__row').length).toBe(2));

  const searchInput = screen.getByPlaceholderText(/search tasks/i);
  fireEvent.change(searchInput, { target: { value: 'LR-006' } });

  await waitFor(() => expect(document.querySelectorAll('.tl__row').length).toBe(1));
  expect(screen.getByText('LR-006')).toBeInTheDocument();
});

it('(reg-4) Tracker task detail shows legalTrackerId, parties, workbookName', async () => {
  trackerTasksStore.get.mockReturnValue([LS_TRACKER]);
  renderTaskList();
  await switchToTab(/^workflow tasks$/i);

  expect(await screen.findByText('Legal-row-6')).toBeInTheDocument();
  expect(screen.getAllByText('Internal').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('Legal Tracker.xlsx')).toBeInTheDocument();
});

it('(reg-5) No legacy Legal Requests tab in the tab list', async () => {
  renderTaskList();
  await screen.findByRole('button', { name: /^my tasks$/i });
  expect(screen.queryByText(/legal requests/i)).toBeNull();
  expect(screen.queryByText(/legal request/i)).toBeNull();
});

it('(reg-6) Workflow Tasks tab visible for staff (non-managerOnly)', async () => {
  renderTaskList(); // STAFF_USER default
  await screen.findByRole('button', { name: /^my tasks$/i });
  expect(screen.getByRole('button', { name: /^workflow tasks$/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^team tasks$/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^unassigned$/i })).toBeNull();
});

it('(reg-7) Workflow Tasks tab is not manager-only — visible to staff users', async () => {
  renderTaskList();
  expect(await screen.findByRole('button', { name: /^workflow tasks$/i })).toBeInTheDocument();
});
