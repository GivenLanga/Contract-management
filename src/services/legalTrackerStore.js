// localStorage-backed state for Legal Tracker.
// The absolute file path never lives here — it stays in the Electron main process.

const KEYS = {
  config:       'clm_tracker_config',
  tasks:        'clm_tracker_tasks',
  manualTasks:  'clm_manual_tasks',
  templates:    'clm_workflow_templates',
};

const MAX_TEMPLATES = 5;

const DEFAULT_TEMPLATES = [
  {
    id:                   'tpl-internal',
    name:                 'Internal Document Workflow',
    description:          'Internal policies, board resolutions, HR documents, legal memos, compliance documents.',
    taskType:             'Internal',
    defaultDepartment:    '',
    defaultDueOffsetDays: 4,
    defaultPriority:      'Medium',
    checklistItems:       ['Intake Review', 'Assign', 'Legal Review', 'Manager Approval', 'Finalize'],
    sla:                  '4 days',
    icon:                 '📋',
    color:                '#8b5cf6',
  },
  {
    id:                   'tpl-external',
    name:                 'External Contract Workflow',
    description:          'Supplier contracts, NDAs, grant agreements, leases, external agreements.',
    taskType:             'External',
    defaultDepartment:    '',
    defaultDueOffsetDays: 7,
    defaultPriority:      'Medium',
    checklistItems:       ['Intake', 'Legal Review', 'Business Input', 'Manager Approval', 'Signature', 'Store'],
    sla:                  '7 days',
    icon:                 '📄',
    color:                '#4f8ef7',
  },
  {
    id:                   'tpl-signature',
    name:                 'Signature Workflow',
    description:          'Triggered when a request reaches Ready for Signature status.',
    taskType:             'Signature',
    defaultDepartment:    '',
    defaultDueOffsetDays: 3,
    defaultPriority:      'High',
    checklistItems:       ['Attach signature-ready document', 'Send signature emails', 'Track signatories', 'Mark Fully Signed', 'Store document'],
    sla:                  'Triggered by Ready for Signature',
    icon:                 '✍️',
    color:                '#10b981',
  },
];

function load(key, defaultVal) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : defaultVal;
  } catch {
    return defaultVal;
  }
}

function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (err) {
    console.warn('[trackerStore] save failed', key, err);
  }
}

// Tracker config — workbook metadata only (no absolute path)
export const trackerConfig = {
  get: ()       => load(KEYS.config, null),
  set: (config) => save(KEYS.config, config),
  clear: ()     => localStorage.removeItem(KEYS.config),
};

// Tracker-backed imported tasks
export const trackerTasks = {
  get:   ()      => load(KEYS.tasks, []),
  set:   (tasks) => save(KEYS.tasks, tasks),
  clear: ()      => localStorage.removeItem(KEYS.tasks),
};

// Manual workflow tasks
export const manualTasks = {
  get: () => load(KEYS.manualTasks, []),

  add(task) {
    const list = this.get();
    list.push(task);
    save(KEYS.manualTasks, list);
  },

  update(id, patch) {
    const list = this.get().map(t => t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t);
    save(KEYS.manualTasks, list);
  },

  remove(id) {
    save(KEYS.manualTasks, this.get().filter(t => t.id !== id));
  },
};

// Workflow templates (max MAX_TEMPLATES)
export const workflowTemplates = {
  get: () => load(KEYS.templates, DEFAULT_TEMPLATES),

  add(template) {
    const list = this.get();
    if (list.length >= MAX_TEMPLATES) {
      throw new Error(`You can track a maximum of ${MAX_TEMPLATES} workflow templates.`);
    }
    list.push({ ...template, id: `tpl-${Date.now()}` });
    save(KEYS.templates, list);
    return list;
  },

  update(id, patch) {
    const list = this.get().map(t => t.id === id ? { ...t, ...patch } : t);
    save(KEYS.templates, list);
    return list;
  },

  remove(id) {
    const list = this.get().filter(t => t.id !== id);
    save(KEYS.templates, list);
    return list;
  },

  reset() {
    save(KEYS.templates, DEFAULT_TEMPLATES);
    return DEFAULT_TEMPLATES;
  },
};

export { MAX_TEMPLATES, DEFAULT_TEMPLATES };
