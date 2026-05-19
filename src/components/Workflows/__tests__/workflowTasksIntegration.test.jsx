import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../../services/api', () => ({
  auth:  { users: vi.fn() },
  tasks: {
    list:   vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../services/trackerTaskBridge', () => ({
  upsertTrackerTask:         vi.fn(),
  markLinkedTaskCompleted:   vi.fn(),
  markLinkedTaskSyncFailed:  vi.fn(),
  createManualWorkflowTask:  vi.fn(),
  updateManualTaskAssignee:  vi.fn(),
  completeManualTask:        vi.fn(),
}));

import { auth as authApi } from '../../../services/api';
import {
  upsertTrackerTask,
  markLinkedTaskCompleted,
  markLinkedTaskSyncFailed,
  createManualWorkflowTask,
  updateManualTaskAssignee,
  completeManualTask,
} from '../../../services/trackerTaskBridge';

import AssignModal     from '../AssignModal';
import DoneConfirmModal from '../DoneConfirmModal';
import ManualTaskModal from '../ManualTaskModal';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const TRACKER_TASK = {
  id:             'tk-1',
  _type:          'TRACKER',
  sourceType:     'LEGAL_TRACKER',
  legalTrackerId: 'Legal-row-6',
  workbookName:   'Legal Tracker.xlsx',
  sheetName:      'Active Matters',
  rowNumber:      6,
  taskType:       'Legal',
  description:    'Update Contracts Management spreadsheet',
  parties:        'Internal',
  department:     'Legal',
  priority:       'Medium',
  deadline:       '2026-06-30T00:00:00.000Z',
};

const USERS = [
  { _id: 'user-faith', name: 'Faith',   role: 'staff'   },
  { _id: 'user-john',  name: 'John',    role: 'manager' },
];

const mockClose     = vi.fn();
const mockAssigned  = vi.fn();
const mockConfirmed = vi.fn();
const mockSaved     = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  delete window.contractiq;
  authApi.users.mockResolvedValue({ users: USERS });
});

// ────────────────────────────────────────────────────────────────────────────────
// AssignModal tests
// ────────────────────────────────────────────────────────────────────────────────
describe('AssignModal', () => {

  it('(test 1) assign calls upsertTrackerTask and fires onAssigned with taskCreated info', async () => {
    upsertTrackerTask.mockResolvedValue({ ok: true, task: { _id: 'bk-new' }, created: true });

    render(<AssignModal task={TRACKER_TASK} onClose={mockClose} onAssigned={mockAssigned} />);
    await screen.findByText('— Select team member —');

    // Select Faith
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-faith' } });
    await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });

    await waitFor(() => expect(mockAssigned).toHaveBeenCalled());
    const { results } = mockAssigned.mock.calls[0][0];
    expect(upsertTrackerTask).toHaveBeenCalledWith(expect.objectContaining({
      trackerTask:    TRACKER_TASK,
      assignedUserId: 'user-faith',
    }));
    expect(results.appUpdated).toBe(true);
  });

  it('(test 2) re-assigning uses upsertTrackerTask which handles dedup via bridge', async () => {
    upsertTrackerTask.mockResolvedValue({ ok: true, task: { _id: 'bk-existing' }, created: false });

    render(<AssignModal task={TRACKER_TASK} onClose={mockClose} onAssigned={mockAssigned} />);
    await screen.findByText('— Select team member —');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-john' } });
    await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });

    await waitFor(() => expect(upsertTrackerTask).toHaveBeenCalledOnce());
    // The bridge handles dedup; modal just fires once regardless
    expect(upsertTrackerTask).toHaveBeenCalledTimes(1);
  });

  it('(test 20) assignee update calls trackerUpdateRow with assignee field', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ ok: true });
    window.contractiq = { trackerUpdateRow: mockWrite };
    upsertTrackerTask.mockResolvedValue({ ok: true, task: {}, created: true });

    render(<AssignModal task={TRACKER_TASK} onClose={mockClose} onAssigned={mockAssigned} />);
    await screen.findByText('— Select team member —');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-faith' } });

    await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });

    await waitFor(() => expect(mockWrite).toHaveBeenCalledWith({
      rowNumber:    6,
      fieldUpdates: { assignee: 'Faith' },
    }));
  });

  it('shows error when no user selected', async () => {
    render(<AssignModal task={TRACKER_TASK} onClose={mockClose} onAssigned={mockAssigned} />);
    await screen.findByText('— Select team member —');
    await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });
    expect(await screen.findByText(/select a team member/i)).toBeInTheDocument();
    expect(upsertTrackerTask).not.toHaveBeenCalled();
  });

  it('unchecking spreadsheet checkbox skips trackerUpdateRow even for tracker tasks', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ ok: true });
    window.contractiq = { trackerUpdateRow: mockWrite };
    upsertTrackerTask.mockResolvedValue({ ok: true, task: {}, created: true });

    render(<AssignModal task={TRACKER_TASK} onClose={mockClose} onAssigned={mockAssigned} />);
    await screen.findByText('— Select team member —');

    // Uncheck the spreadsheet checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox); // toggle off

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'user-faith' } });
    await act(async () => { fireEvent.submit(document.querySelector('.asgn__form')); });
    await waitFor(() => expect(mockAssigned).toHaveBeenCalled());
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// DoneConfirmModal tests
// ────────────────────────────────────────────────────────────────────────────────
describe('DoneConfirmModal', () => {

  it('(test 21) shows task context before confirming', () => {
    render(<DoneConfirmModal task={TRACKER_TASK} onClose={mockClose} onConfirmed={mockConfirmed} />);
    expect(screen.getByText('Task details')).toBeInTheDocument();
    expect(screen.getAllByText('Legal').length).toBeGreaterThan(0);
  });

  it('(test 21) Done update calls trackerUpdateRow with progress: Completed', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ ok: true });
    window.contractiq = { trackerUpdateRow: mockWrite };
    markLinkedTaskCompleted.mockResolvedValue({ ok: true });

    render(<DoneConfirmModal task={TRACKER_TASK} onClose={mockClose} onConfirmed={mockConfirmed} />);
    await act(async () => { fireEvent.click(screen.getByText('Mark Done')); });

    expect(mockWrite).toHaveBeenCalledWith({
      rowNumber:    6,
      fieldUpdates: { progress: 'Completed' },
    });
    await waitFor(() => expect(mockConfirmed).toHaveBeenCalled());
  });

  it('(test 5) after Excel write success calls markLinkedTaskCompleted', async () => {
    window.contractiq = { trackerUpdateRow: vi.fn().mockResolvedValue({ ok: true }) };
    markLinkedTaskCompleted.mockResolvedValue({ ok: true });

    render(<DoneConfirmModal task={TRACKER_TASK} onClose={mockClose} onConfirmed={mockConfirmed} />);
    await act(async () => { fireEvent.click(screen.getByText('Mark Done')); });

    await waitFor(() => expect(markLinkedTaskCompleted).toHaveBeenCalledWith(TRACKER_TASK));
  });

  it('(test 6) Excel write failure shows error and calls markLinkedTaskSyncFailed', async () => {
    window.contractiq = {
      trackerUpdateRow: vi.fn().mockResolvedValue({ ok: false, code: 'FILE_LOCKED' }),
    };
    markLinkedTaskSyncFailed.mockResolvedValue();

    render(<DoneConfirmModal task={TRACKER_TASK} onClose={mockClose} onConfirmed={mockConfirmed} />);
    await act(async () => { fireEvent.click(screen.getByText('Mark Done')); });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert').textContent).toMatch(/locked/i);
    });
    expect(mockConfirmed).not.toHaveBeenCalled();
    expect(markLinkedTaskSyncFailed).toHaveBeenCalledWith(TRACKER_TASK, expect.any(String));
  });

  it('(test 24) locked workbook shows "locked" error message', async () => {
    window.contractiq = {
      trackerUpdateRow: vi.fn().mockResolvedValue({ ok: false, code: 'FILE_LOCKED' }),
    };
    markLinkedTaskSyncFailed.mockResolvedValue();

    render(<DoneConfirmModal task={TRACKER_TASK} onClose={mockClose} onConfirmed={mockConfirmed} />);
    await act(async () => { fireEvent.click(screen.getByText('Mark Done')); });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/locked/i));
  });

  it('shows "What will be written to Excel" section for tracker tasks', () => {
    render(<DoneConfirmModal task={TRACKER_TASK} onClose={mockClose} onConfirmed={mockConfirmed} />);
    expect(screen.getByText('What will be written to Excel')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('does NOT show Excel section for manual tasks', () => {
    const manualTask = { id: 'mn-1', title: 'Manual task', sourceType: 'MANUAL_WORKFLOW', _type: 'MANUAL' };
    render(<DoneConfirmModal task={manualTask} onClose={mockClose} onConfirmed={mockConfirmed} />);
    expect(screen.queryByText('What will be written to Excel')).toBeNull();
  });

  it('(test 11) manual task completion does not call trackerUpdateRow', async () => {
    const mockWrite = vi.fn();
    window.contractiq = { trackerUpdateRow: mockWrite };
    const manualTask = { id: 'mn-1', title: 'Manual task', sourceType: 'MANUAL_WORKFLOW', _type: 'MANUAL' };

    render(<DoneConfirmModal task={manualTask} onClose={mockClose} onConfirmed={mockConfirmed} />);
    await act(async () => { fireEvent.click(screen.getByText('Mark Done')); });

    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockConfirmed).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// ManualTaskModal tests
// ────────────────────────────────────────────────────────────────────────────────
describe('ManualTaskModal', () => {
  const currentUser = { name: 'Manager', _id: 'mgr-1' };

  it('(test 10) saving a manual task calls createManualWorkflowTask for backend task', async () => {
    createManualWorkflowTask.mockResolvedValue({ ok: true, task: { _id: 'bk-mn-1' } });

    render(<ManualTaskModal onClose={mockClose} onSaved={mockSaved} currentUser={currentUser} />);

    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Review policy' } });
    await act(async () => { fireEvent.submit(document.querySelector('.mtm__form')); });

    await waitFor(() => expect(createManualWorkflowTask).toHaveBeenCalledWith(
      expect.objectContaining({ localTask: expect.objectContaining({ title: 'Review policy', sourceType: 'MANUAL_WORKFLOW' }) })
    ));
    expect(mockSaved).toHaveBeenCalled();
  });

  it('onSaved fires with local task even when backend fails', async () => {
    createManualWorkflowTask.mockRejectedValue(new Error('Offline'));

    render(<ManualTaskModal onClose={mockClose} onSaved={mockSaved} currentUser={currentUser} />);
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Offline task' } });
    await act(async () => { fireEvent.submit(document.querySelector('.mtm__form')); });

    // onSaved still fires (fire-and-forget backend)
    await waitFor(() => expect(mockSaved).toHaveBeenCalled());
  });

  it('local task has sourceType: MANUAL_WORKFLOW', async () => {
    createManualWorkflowTask.mockResolvedValue({ ok: true, task: {} });
    render(<ManualTaskModal onClose={mockClose} onSaved={mockSaved} currentUser={currentUser} />);
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Source test' } });
    await act(async () => { fireEvent.submit(document.querySelector('.mtm__form')); });

    await waitFor(() => expect(mockSaved).toHaveBeenCalled());
    const savedTask = mockSaved.mock.calls[0][0];
    expect(savedTask.sourceType).toBe('MANUAL_WORKFLOW');
  });

  it('title required — does not call bridge if empty', async () => {
    render(<ManualTaskModal onClose={mockClose} onSaved={mockSaved} currentUser={currentUser} />);
    await act(async () => { fireEvent.submit(document.querySelector('.mtm__form')); });
    expect(createManualWorkflowTask).not.toHaveBeenCalled();
    expect(mockSaved).not.toHaveBeenCalled();
  });

  it('(test 23) formula injection prefix: value with = in title', async () => {
    // The bridge preserves whatever title the modal provides — sanitization is in the workbook service
    // Here we just verify the local task stores the title as-is (sanitization is at Excel write time)
    createManualWorkflowTask.mockResolvedValue({ ok: true, task: {} });
    render(<ManualTaskModal onClose={mockClose} onSaved={mockSaved} currentUser={currentUser} />);
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: '=DROP(A1)' } });
    await act(async () => { fireEvent.submit(document.querySelector('.mtm__form')); });
    await waitFor(() => expect(mockSaved).toHaveBeenCalled());
    // Local task title stored unmodified — sanitization is only applied during Excel write
    expect(mockSaved.mock.calls[0][0].title).toBe('=DROP(A1)');
  });
});
