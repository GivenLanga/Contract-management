import { describe, it, expect, beforeEach, vi } from 'vitest';

// Provide a localStorage mock for the jsdom environment
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// Import after setting up localStorage mock
const { workflowTemplates, manualTasks, MAX_TEMPLATES } = await import('../../../services/legalTrackerStore');

describe('workflowTemplates', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it('returns default templates when nothing is stored', () => {
    const tpls = workflowTemplates.get();
    expect(tpls.length).toBe(3);
    expect(tpls[0].name).toBe('Internal Document Workflow');
  });

  // ── 26. Max 5 workflow templates enforced
  it('throws when adding a 6th template', () => {
    // Fill to max
    for (let i = 0; i < MAX_TEMPLATES - 3; i++) {
      workflowTemplates.add({ name: `Extra ${i}`, description: '', taskType: '', color: '#000', icon: '📋', sla: '', defaultDueOffsetDays: 7, defaultPriority: 'Medium', checklistItems: [] });
    }
    expect(() => {
      workflowTemplates.add({ name: 'Sixth', description: '', taskType: '', color: '#000', icon: '📋', sla: '', defaultDueOffsetDays: 7, defaultPriority: 'Medium', checklistItems: [] });
    }).toThrow(/maximum of 5/i);
  });

  it('allows adding up to the max (5)', () => {
    // Start fresh with 0 templates by overriding storage
    localStorageMock.setItem('clm_workflow_templates', JSON.stringify([]));
    for (let i = 0; i < MAX_TEMPLATES; i++) {
      workflowTemplates.add({ name: `T${i}`, description: '', taskType: '', color: '#000', icon: '📋', sla: '', defaultDueOffsetDays: 7, defaultPriority: 'Medium', checklistItems: [] });
    }
    expect(workflowTemplates.get().length).toBe(MAX_TEMPLATES);
  });

  it('removes a template by id', () => {
    const tpls = workflowTemplates.get();
    const idToRemove = tpls[0].id;
    const updated = workflowTemplates.remove(idToRemove);
    expect(updated.find(t => t.id === idToRemove)).toBeUndefined();
  });

  it('updates an existing template', () => {
    const tpls = workflowTemplates.get();
    const id = tpls[0].id;
    workflowTemplates.update(id, { name: 'Updated Name' });
    const after = workflowTemplates.get();
    expect(after.find(t => t.id === id).name).toBe('Updated Name');
  });
});

describe('manualTasks', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  // ── 24. Manual task without assignee appears under Unassigned
  it('stores manual task with null assignee', () => {
    manualTasks.add({
      id: 'mt-1',
      title: 'Review policy document',
      assignee: null,
      status: 'Pending',
      dueDate: null,
    });
    const tasks = manualTasks.get();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBeNull();
  });

  // ── 25. Manual task with assignee
  it('stores manual task with assignee name', () => {
    manualTasks.add({
      id: 'mt-2',
      title: 'Draft NDA',
      assignee: 'John Doe',
      status: 'Pending',
      dueDate: null,
    });
    const tasks = manualTasks.get();
    expect(tasks[0].assignee).toBe('John Doe');
  });

  it('updates a manual task', () => {
    manualTasks.add({ id: 'mt-3', title: 'Task A', assignee: null, status: 'Pending' });
    manualTasks.update('mt-3', { status: 'Completed' });
    const tasks = manualTasks.get();
    expect(tasks.find(t => t.id === 'mt-3').status).toBe('Completed');
  });

  it('removes a manual task by id', () => {
    manualTasks.add({ id: 'mt-4', title: 'Task B', assignee: null, status: 'Pending' });
    manualTasks.remove('mt-4');
    const tasks = manualTasks.get();
    expect(tasks.find(t => t.id === 'mt-4')).toBeUndefined();
  });
});
