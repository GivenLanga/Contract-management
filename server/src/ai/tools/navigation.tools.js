const PAGE_MAP = {
  dashboard:     '/dashboard',
  contracts:     '/contracts',
  contract:      '/contracts',
  documents:     '/documents',
  document:      '/documents',
  legal:         '/legal-folder',
  'legal folder': '/legal-folder',
  legalfolder:   '/legal-folder',
  signing:       '/signing',
  sign:          '/signing',
  signatures:    '/signing',
  tasks:         '/tasks',
  task:          '/tasks',
  workflows:     '/workflows',
  workflow:      '/workflows',
  templates:     '/templates',
  template:      '/templates',
  notifications: '/notifications',
  notification:  '/notifications',
  reports:       '/reports',
  report:        '/reports',
  analytics:     '/reports',
  settings:      '/settings',
  setting:       '/settings',
  users:           '/settings/users',
  profile:         '/profile',
  'ai audit':      '/ai/audit',
  'audit log':     '/ai/audit',
};

const TOOL_DESCRIPTIONS = [
  { tool: 'search_contracts',          description: 'Search contracts by title, type, status, or counterparty' },
  { tool: 'get_contract_status',       description: 'Get full details and status for a specific contract' },
  { tool: 'get_expired_contracts',      description: 'Count or list contracts that have already expired' },
  { tool: 'count_expiring_contracts',  description: 'Count contracts expiring within N days' },
  { tool: 'list_expiring_contracts',   description: 'List contracts expiring within N days' },
  { tool: 'show_contract_parties',     description: 'Show all parties and signatories for a contract' },
  { tool: 'summarise_contract_metadata', description: 'Summarise key metadata of a contract' },
  { tool: 'list_pending_signatures',   description: 'List documents in the signing platform awaiting signatures' },
  { tool: 'count_documents_in_signing_platform', description: 'Count documents in the signing platform' },
  { tool: 'list_my_pending_signatures', description: 'List documents that need your signature' },
  { tool: 'count_my_pending_signatures', description: 'Count documents that need your signature' },
  { tool: 'list_external_party_pending_signatures', description: 'List documents waiting on external party signatures' },
  { tool: 'count_external_party_pending_signatures', description: 'Count documents waiting on external party signatures' },
  { tool: 'get_signing_status',        description: 'Get signer progress for a document' },
  { tool: 'open_document_in_signing',  description: 'Navigate to the signing view for a document' },
  { tool: 'show_current_drafters',     description: 'See who is currently drafting documents' },
  { tool: 'list_my_tasks',             description: 'List your open tasks' },
  { tool: 'list_overdue_tasks',        description: 'List overdue tasks for you or the team' },
  { tool: 'create_task',               description: 'Create and assign a new task' },
  { tool: 'get_task_summary',          description: 'Get a task count breakdown by status' },
  { tool: 'search_documents',          description: 'Search documents by name or status' },
  { tool: 'get_document_status',       description: 'Get details and status for a specific document' },
  { tool: 'list_my_notifications',     description: 'List your notifications or unread alerts' },
  { tool: 'count_my_notifications',    description: 'Count your notifications or unread alerts' },
  { tool: 'navigate_to_page',          description: 'Navigate to a specific page in the application' },
];

module.exports = [
  {
    name: 'navigate_to_page',
    description: 'Navigate to a specific page or section within the application.',
    riskLevel: 'low',
    requiredPermissions: [],
    schema: {
      type: 'object',
      required: ['page'],
      additionalProperties: false,
      properties: {
        page: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    async execute(args) {
      const key  = args.page.toLowerCase().trim();
      const path = PAGE_MAP[key];

      if (!path) {
        const suggestions = Object.keys(PAGE_MAP)
          .filter(k => k.includes(key) || key.includes(k))
          .slice(0, 3);
        return {
          type: 'not_found',
          message: `Unknown page "${args.page}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
        };
      }

      return {
        type: 'navigation',
        data: { path, label: args.page, message: `Navigating to ${args.page}.` },
      };
    },
  },

  {
    name: 'show_help',
    description: 'Show the user what the assistant can do and what questions they can ask.',
    riskLevel: 'low',
    requiredPermissions: [],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      return {
        type: 'success',
        data: {
          message: 'Here is what I can help you with:',
          capabilities: TOOL_DESCRIPTIONS,
          examples: [
            'How many contracts expire in the next 30 days?',
            'Search for the Acme service agreement',
            'List my overdue tasks',
            'Who is currently drafting documents?',
            'Show pending signatures',
            'What are my notifications?',
            'Navigate to the signing page',
            'What is the status of contract C-2024-001?',
          ],
        },
      };
    },
  },
];
