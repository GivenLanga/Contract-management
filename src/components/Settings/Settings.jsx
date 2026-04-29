import { useState } from 'react';
import Header from '../Layout/Header';
import { users } from '../../data/mockData';
import './Settings.css';

const TABS = ['General', 'Users & Roles', 'Notifications', 'Integrations', 'Security'];

export default function Settings() {
  const [activeTab, setActiveTab] = useState('General');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="settings">
      <Header
        title="Settings"
        subtitle="Configure your CLM platform preferences"
      />

      <div className="settings__content">
        <div className="settings__tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`settings__tab${activeTab === tab ? ' settings__tab--active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="settings__panel">
          {activeTab === 'General' && <GeneralSettings onSave={handleSave} saved={saved} />}
          {activeTab === 'Users & Roles' && <UsersSettings />}
          {activeTab === 'Notifications' && <NotificationsSettings onSave={handleSave} saved={saved} />}
          {activeTab === 'Integrations' && <IntegrationsSettings />}
          {activeTab === 'Security' && <SecuritySettings onSave={handleSave} saved={saved} />}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings({ onSave, saved }) {
  return (
    <div className="settings__section">
      <div className="settings__card">
        <h3 className="settings__card-title">Organization</h3>
        <div className="settings__fields">
          <div className="settings__field">
            <label>Organization Name</label>
            <input type="text" defaultValue="Meridian Health Group" />
          </div>
          <div className="settings__field">
            <label>Primary Contact Email</label>
            <input type="email" defaultValue="contracts@meridianhealth.com" />
          </div>
          <div className="settings__field">
            <label>Default Contract Owner</label>
            <select>
              <option>Sarah Mitchell</option>
              <option>James Porter</option>
              <option>Tom Nguyen</option>
            </select>
          </div>
          <div className="settings__field">
            <label>Fiscal Year Start</label>
            <select>
              <option>January</option>
              <option>April</option>
              <option>July</option>
              <option>October</option>
            </select>
          </div>
          <div className="settings__field settings__field--full">
            <label>Default Currency</label>
            <select>
              <option>USD – US Dollar</option>
              <option>EUR – Euro</option>
              <option>GBP – British Pound</option>
            </select>
          </div>
        </div>
      </div>

      <div className="settings__card">
        <h3 className="settings__card-title">Contract Defaults</h3>
        <div className="settings__fields">
          <div className="settings__field">
            <label>Default Contract Duration</label>
            <select><option>1 Year</option><option>2 Years</option><option>3 Years</option><option>Custom</option></select>
          </div>
          <div className="settings__field">
            <label>Renewal Reminder (days before)</label>
            <input type="number" defaultValue={90} min={1} max={365} />
          </div>
          <div className="settings__field">
            <label>Default Governing Law</label>
            <input type="text" defaultValue="State of Delaware, USA" />
          </div>
          <div className="settings__field">
            <label>Value Threshold for CFO Approval</label>
            <input type="number" defaultValue={50000} />
          </div>
        </div>
      </div>

      <div className="settings__save-row">
        <button className="settings__save-btn" onClick={onSave}>
          {saved ? '✅ Saved!' : '💾 Save Changes'}
        </button>
      </div>
    </div>
  );
}

function UsersSettings() {
  const roles = ['Admin', 'Legal Counsel', 'Contract Manager', 'Approver', 'Viewer'];
  return (
    <div className="settings__section">
      <div className="settings__card">
        <div className="settings__card-top">
          <h3 className="settings__card-title">Users</h3>
          <button className="settings__add-btn">+ Invite User</button>
        </div>
        <div className="settings__users-table">
          <div className="settings__users-header">
            <span>User</span>
            <span>Role</span>
            <span>Department</span>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {users.map((u) => (
            <div key={u.id} className="settings__user-row">
              <div className="settings__user-cell">
                <div className="settings__user-avatar">{u.avatar}</div>
                <div>
                  <span className="settings__user-name">{u.name}</span>
                </div>
              </div>
              <div className="settings__user-cell">
                <select className="settings__role-select" defaultValue={u.role}>
                  {roles.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="settings__user-cell settings__user-dept">{u.department}</div>
              <div className="settings__user-cell">
                <span className="settings__status-active">Active</span>
              </div>
              <div className="settings__user-cell">
                <button className="settings__user-btn">Edit</button>
                <button className="settings__user-btn settings__user-btn--danger">Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="settings__card">
        <h3 className="settings__card-title">Role Permissions</h3>
        <div className="settings__permissions">
          {[
            { perm: 'Create Contracts', admin: true, legal: true, manager: true, approver: false, viewer: false },
            { perm: 'Edit Contracts', admin: true, legal: true, manager: true, approver: false, viewer: false },
            { perm: 'Approve Contracts', admin: true, legal: true, manager: false, approver: true, viewer: false },
            { perm: 'Delete Contracts', admin: true, legal: false, manager: false, approver: false, viewer: false },
            { perm: 'View All Contracts', admin: true, legal: true, manager: true, approver: true, viewer: true },
            { perm: 'Manage Templates', admin: true, legal: true, manager: false, approver: false, viewer: false },
            { perm: 'Run Reports', admin: true, legal: true, manager: true, approver: false, viewer: false },
            { perm: 'Manage Users', admin: true, legal: false, manager: false, approver: false, viewer: false },
          ].map((p) => (
            <div key={p.perm} className="settings__perm-row">
              <span className="settings__perm-name">{p.perm}</span>
              {['admin', 'legal', 'manager', 'approver', 'viewer'].map((role) => (
                <span key={role} className={`settings__perm-check ${p[role] ? 'settings__perm-check--yes' : 'settings__perm-check--no'}`}>
                  {p[role] ? '✓' : '—'}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NotificationsSettings({ onSave, saved }) {
  const [notifs, setNotifs] = useState({
    renewalReminder: true,
    approvalRequest: true,
    signatureComplete: true,
    contractExpiry: true,
    weeklyDigest: false,
    systemAlerts: true,
  });

  const toggle = (key) => setNotifs((n) => ({ ...n, [key]: !n[key] }));

  const items = [
    { key: 'renewalReminder', label: 'Renewal Reminders', desc: 'Notify when a contract is nearing its renewal date' },
    { key: 'approvalRequest', label: 'Approval Requests', desc: 'Notify when a contract is submitted for your approval' },
    { key: 'signatureComplete', label: 'Signature Completed', desc: 'Notify when all parties have signed a contract' },
    { key: 'contractExpiry', label: 'Contract Expiry Alerts', desc: 'Notify when a contract has expired' },
    { key: 'weeklyDigest', label: 'Weekly Digest', desc: 'Weekly summary of contract activity and upcoming renewals' },
    { key: 'systemAlerts', label: 'System Alerts', desc: 'Important platform and security notifications' },
  ];

  return (
    <div className="settings__section">
      <div className="settings__card">
        <h3 className="settings__card-title">Notification Preferences</h3>
        <div className="settings__notifs">
          {items.map((item) => (
            <div key={item.key} className="settings__notif-row">
              <div className="settings__notif-info">
                <span className="settings__notif-label">{item.label}</span>
                <span className="settings__notif-desc">{item.desc}</span>
              </div>
              <button
                className={`settings__toggle${notifs[item.key] ? ' settings__toggle--on' : ''}`}
                onClick={() => toggle(item.key)}
              >
                <span className="settings__toggle-thumb" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="settings__card">
        <h3 className="settings__card-title">Reminder Schedule</h3>
        <div className="settings__fields">
          <div className="settings__field">
            <label>First Renewal Reminder</label>
            <select><option>90 days before</option><option>60 days before</option><option>30 days before</option></select>
          </div>
          <div className="settings__field">
            <label>Second Renewal Reminder</label>
            <select><option>30 days before</option><option>14 days before</option><option>7 days before</option></select>
          </div>
          <div className="settings__field">
            <label>Escalation (no action after)</label>
            <select><option>14 days</option><option>7 days</option><option>3 days</option></select>
          </div>
          <div className="settings__field">
            <label>Notification Channel</label>
            <select><option>Email</option><option>Email + Slack</option><option>Email + Teams</option></select>
          </div>
        </div>
      </div>

      <div className="settings__save-row">
        <button className="settings__save-btn" onClick={onSave}>
          {saved ? '✅ Saved!' : '💾 Save Changes'}
        </button>
      </div>
    </div>
  );
}

function IntegrationsSettings() {
  const integrations = [
    { name: 'DocuSign', desc: 'E-signature integration for contract execution', icon: '✍️', status: 'Connected', color: '#10b981' },
    { name: 'Salesforce CRM', desc: 'Sync contract data with CRM opportunities', icon: '☁️', status: 'Connected', color: '#10b981' },
    { name: 'Microsoft 365', desc: 'SharePoint document storage and Teams notifications', icon: '💼', status: 'Disconnected', color: '#94a3b8' },
    { name: 'Slack', desc: 'Real-time workflow notifications in Slack channels', icon: '💬', status: 'Disconnected', color: '#94a3b8' },
    { name: 'SAP ERP', desc: 'Vendor and procurement data synchronization', icon: '🏢', status: 'Connected', color: '#10b981' },
    { name: 'Google Drive', desc: 'Document storage and collaboration', icon: '📂', status: 'Disconnected', color: '#94a3b8' },
    { name: 'Workday HR', desc: 'Employment contract sync with HR system', icon: '👥', status: 'Disconnected', color: '#94a3b8' },
    { name: 'Jira', desc: 'Track contract tasks as Jira issues', icon: '🎯', status: 'Disconnected', color: '#94a3b8' },
  ];

  return (
    <div className="settings__section">
      <div className="settings__card">
        <div className="settings__card-top">
          <h3 className="settings__card-title">Integrations</h3>
          <span className="settings__connected-count">
            {integrations.filter(i => i.status === 'Connected').length} connected
          </span>
        </div>
        <div className="settings__integrations-grid">
          {integrations.map((intg) => (
            <div key={intg.name} className="settings__integration-card">
              <div className="settings__integration-header">
                <span className="settings__integration-icon">{intg.icon}</span>
                <span className="settings__integration-status" style={{ color: intg.color }}>
                  {intg.status === 'Connected' ? '● ' : '○ '}{intg.status}
                </span>
              </div>
              <h4 className="settings__integration-name">{intg.name}</h4>
              <p className="settings__integration-desc">{intg.desc}</p>
              <button className={`settings__integration-btn${intg.status === 'Connected' ? ' settings__integration-btn--connected' : ''}`}>
                {intg.status === 'Connected' ? 'Configure' : 'Connect'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SecuritySettings({ onSave, saved }) {
  return (
    <div className="settings__section">
      <div className="settings__card">
        <h3 className="settings__card-title">Authentication</h3>
        <div className="settings__fields">
          <div className="settings__field settings__field--full">
            <label>Single Sign-On (SSO)</label>
            <select><option>Disabled</option><option>SAML 2.0</option><option>OpenID Connect</option><option>OAuth 2.0</option></select>
          </div>
          <div className="settings__field">
            <label>Multi-Factor Authentication</label>
            <select><option>Required for all users</option><option>Optional</option><option>Disabled</option></select>
          </div>
          <div className="settings__field">
            <label>Session Timeout (minutes)</label>
            <input type="number" defaultValue={60} min={5} max={480} />
          </div>
          <div className="settings__field">
            <label>Password Policy</label>
            <select><option>Strong (12+ chars, special)</option><option>Medium (8+ chars)</option></select>
          </div>
        </div>
      </div>

      <div className="settings__card">
        <h3 className="settings__card-title">Data & Privacy</h3>
        <div className="settings__fields">
          <div className="settings__field">
            <label>Data Encryption</label>
            <select><option>AES-256 at rest + in transit</option><option>TLS in transit only</option></select>
          </div>
          <div className="settings__field">
            <label>Audit Log Retention</label>
            <select><option>7 years</option><option>5 years</option><option>3 years</option><option>1 year</option></select>
          </div>
          <div className="settings__field settings__field--full">
            <label>IP Allowlist (optional)</label>
            <input type="text" placeholder="e.g., 192.168.1.0/24, 10.0.0.0/8" />
          </div>
        </div>
      </div>

      <div className="settings__save-row">
        <button className="settings__save-btn" onClick={onSave}>
          {saved ? '✅ Saved!' : '💾 Save Changes'}
        </button>
      </div>
    </div>
  );
}
