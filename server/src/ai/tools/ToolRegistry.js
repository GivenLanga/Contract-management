const contractTools      = require('./contracts.tools');
const signingTools       = require('./signing.tools');
const taskTools          = require('./tasks.tools');
const documentTools      = require('./documents.tools');
const navTools           = require('./navigation.tools');
const overviewTools      = require('./overview.tools');
const notificationTools  = require('./notifications.tools');
const workflowTools      = require('./workflow.tools');

class ToolRegistry {
  constructor() {
    this._tools = new Map();
    for (const tool of [
      ...contractTools,
      ...signingTools,
      ...taskTools,
      ...documentTools,
      ...navTools,
      ...overviewTools,
      ...notificationTools,
      ...workflowTools,
    ]) {
      this._tools.set(tool.name, tool);
    }
  }

  get(name) {
    return this._tools.get(name) || null;
  }

  all() {
    return Array.from(this._tools.values());
  }

  /** Return a minimal descriptor list suitable for injecting into a system prompt. */
  toPromptList() {
    return this.all().map(t => ({ name: t.name, description: t.description }));
  }
}

module.exports = { ToolRegistry };
