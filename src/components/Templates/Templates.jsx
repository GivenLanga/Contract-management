import { useState } from 'react';
import Header from '../Layout/Header';
import Badge from '../common/Badge';
import Modal from '../common/Modal';
import { templates } from '../../data/mockData';
import './Templates.css';

const CATEGORIES = ['All', 'Services', 'Confidentiality', 'Technology', 'Procurement', 'Compliance', 'HR', 'Business Development'];

export default function Templates() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [selected, setSelected] = useState(null);
  const [showUseModal, setShowUseModal] = useState(false);

  const filtered = templates.filter((t) => {
    const matchSearch = !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()) ||
      t.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()));
    const matchCat = category === 'All' || t.category === category;
    return matchSearch && matchCat;
  });

  return (
    <div className="templates">
      <Header
        title="Contract Templates"
        subtitle={`${templates.length} templates in the library`}
      />

      <div className="templates__content">
        {/* Toolbar */}
        <div className="templates__toolbar">
          <div className="templates__search">
            <span>🔍</span>
            <input
              type="text"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="templates__categories">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                className={`templates__cat-btn${category === c ? ' templates__cat-btn--active' : ''}`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <button className="templates__new-btn">+ New Template</button>
        </div>

        {/* Grid */}
        <div className="templates__grid">
          {filtered.map((t) => (
            <div key={t.id} className="templates__card">
              <div className="templates__card-header">
                <div className="templates__card-icon">{getCategoryIcon(t.category)}</div>
                <Badge status={t.type} size="sm" />
              </div>
              <h3 className="templates__card-name">{t.name}</h3>
              <p className="templates__card-desc">{t.description}</p>

              <div className="templates__card-tags">
                {t.tags.map((tag) => (
                  <span key={tag} className="templates__tag">{tag}</span>
                ))}
              </div>

              <div className="templates__card-meta">
                <span className="templates__meta-item">📂 {t.category}</span>
                <span className="templates__meta-item">v{t.version}</span>
                <span className="templates__meta-item">Used {t.usageCount}×</span>
              </div>

              <div className="templates__card-footer">
                <span className="templates__updated">Updated {t.lastUpdated}</span>
                <div className="templates__card-actions">
                  <button
                    className="templates__btn templates__btn--secondary"
                    onClick={() => setSelected(t)}
                  >
                    Preview
                  </button>
                  <button
                    className="templates__btn templates__btn--primary"
                    onClick={() => { setSelected(t); setShowUseModal(true); }}
                  >
                    Use
                  </button>
                </div>
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="templates__empty">
              <span>📋</span>
              <p>No templates match your search.</p>
            </div>
          )}
        </div>
      </div>

      {/* Preview Modal */}
      {selected && !showUseModal && (
        <Modal
          isOpen={Boolean(selected)}
          onClose={() => setSelected(null)}
          title={selected.name}
          size="lg"
        >
          <div className="templates__preview">
            <div className="templates__preview-header">
              <Badge status={selected.type} />
              <span className="templates__preview-version">Version {selected.version}</span>
            </div>
            <p className="templates__preview-desc">{selected.description}</p>

            <div className="templates__preview-grid">
              <div><span>Category</span><strong>{selected.category}</strong></div>
              <div><span>Owner</span><strong>{selected.owner}</strong></div>
              <div><span>Last Updated</span><strong>{selected.lastUpdated}</strong></div>
              <div><span>Usage Count</span><strong>{selected.usageCount} times</strong></div>
            </div>

            <div className="templates__preview-clauses">
              <h4>Standard Sections</h4>
              {getSampleClauses(selected.type).map((c) => (
                <div key={c} className="templates__preview-clause">
                  <span>§</span>
                  <span>{c}</span>
                </div>
              ))}
            </div>

            <div className="templates__preview-actions">
              <button className="templates__btn templates__btn--secondary" onClick={() => setSelected(null)}>Close</button>
              <button className="templates__btn templates__btn--primary" onClick={() => setShowUseModal(true)}>
                Use This Template →
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Use Template Modal */}
      <Modal
        isOpen={showUseModal}
        onClose={() => { setShowUseModal(false); setSelected(null); }}
        title={`Use Template: ${selected?.name}`}
        size="md"
      >
        <div className="templates__use-form">
          <p className="templates__use-intro">This will create a new contract draft based on <strong>{selected?.name}</strong>.</p>
          <div className="templates__use-field">
            <label>Contract Title</label>
            <input type="text" placeholder={`${selected?.name} – [Counterparty]`} />
          </div>
          <div className="templates__use-field">
            <label>Counterparty</label>
            <input type="text" placeholder="Counterparty name" />
          </div>
          <div className="templates__use-field">
            <label>Owner</label>
            <input type="text" defaultValue="Sarah Mitchell" />
          </div>
          <div className="templates__use-actions">
            <button
              className="templates__btn templates__btn--secondary"
              onClick={() => { setShowUseModal(false); setSelected(null); }}
            >
              Cancel
            </button>
            <button
              className="templates__btn templates__btn--primary"
              onClick={() => { setShowUseModal(false); setSelected(null); }}
            >
              Create Contract Draft →
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function getCategoryIcon(category) {
  const icons = {
    Services: '⚙️',
    Confidentiality: '🔒',
    Technology: '💻',
    Procurement: '📦',
    Compliance: '✅',
    HR: '👥',
    'Business Development': '🤝',
  };
  return icons[category] || '📄';
}

function getSampleClauses(type) {
  const clauses = {
    MSA: ['Definitions & Scope', 'Service Levels (SLA)', 'IP Ownership', 'Liability Limitation', 'Payment Terms', 'Termination & Remedies'],
    NDA: ['Confidential Information Definition', 'Obligations of Receiving Party', 'Exclusions from Confidentiality', 'Return or Destruction', 'Term & Termination'],
    SOW: ['Project Scope', 'Deliverables & Milestones', 'Payment Schedule', 'Change Control Process', 'IP Assignment', 'Acceptance Criteria'],
    Vendor: ['Goods & Services Description', 'Pricing & Payment', 'Delivery Terms', 'Warranty & Indemnification', 'Audit Rights'],
    License: ['License Grant', 'Restrictions', 'Updates & Support', 'Audit Rights', 'Termination'],
    Employment: ['Position & Duties', 'Compensation & Benefits', 'Confidentiality', 'Non-Compete', 'Termination'],
    DPA: ['Data Categories & Purposes', 'Processor Obligations', 'Security Measures', 'Sub-processor List', 'Data Subject Rights'],
    Partnership: ['Scope of Partnership', 'Revenue Sharing', 'IP Rights', 'Exclusivity', 'Governance & Disputes', 'Exit Provisions'],
  };
  return clauses[type] || ['General Terms', 'Governing Law', 'Dispute Resolution'];
}
