import { useState, useEffect, useCallback } from 'react';
import Header from '../Layout/Header';
import Badge from '../common/Badge';
import Modal from '../common/Modal';
import { templates as templatesApi } from '../../services/api';
import { getLegalFolderImport } from '../../services/legalFolderStore';
import { useAuth } from '../../context/AuthContext';
import './Templates.css';

// Folder names recognised as template sources — mirrors backend templateClassifier
const TEMPLATE_FOLDER_NAMES = new Set([
  'templates', 'template', 'legal templates', 'contract templates',
  'standard templates', 'approved templates', 'precedents', 'boilerplates', 'forms',
]);

function isTemplatePath(sourcePath) {
  if (!sourcePath) return false;
  return String(sourcePath)
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .some((part) => TEMPLATE_FOLDER_NAMES.has(part.trim()));
}

function collectTemplateCandidates() {
  const snapshot = getLegalFolderImport();
  const docs = snapshot.documents || [];
  return docs.filter((d) => d.sourcePath && isTemplatePath(d.sourcePath));
}

// ── Icon helpers ──────────────────────────────────────────────────────────────

const FAMILY_ICONS = {
  FUNDING_LOAN_AGREEMENT: '💰',
  LOAN_AGREEMENT: '💰',
  BRIDGING_FINANCE_AGREEMENT: '🏦',
  GRANT_AGREEMENT: '🎁',
  ASSISTANCE_AGREEMENT: '🤝',
  MASTER_SERVICE_AGREEMENT: '⚙️',
  ONCE_OFF_SERVICE_AGREEMENT: '⚙️',
  SERVICE_PROVIDER_AGREEMENT: '⚙️',
  CONSULTANCY_AGREEMENT: '💼',
  SLA: '📊',
  VENDOR_AGREEMENT: '📦',
  LEASE_AGREEMENT: '🏠',
  LEASE_ADDENDUM: '🏠',
  ADDENDUM: '📎',
  AMENDMENT_AGREEMENT: '✏️',
  NDA: '🔒',
  CONFIDENTIALITY_AGREEMENT: '🔒',
  MOU: '🤝',
  MOA: '🤝',
  EMPLOYMENT_AGREEMENT: '👥',
  RENEWAL_LETTER: '🔄',
  TERMINATION_NOTICE: '🚫',
  BOARD_RESOLUTION: '🏛️',
  POPIA_CLAUSE: '✅',
  FICA_COMPLIANCE: '✅',
  GENERAL_CONTRACT: '📄',
  OTHER: '📄',
};

function getIcon(template) {
  return FAMILY_ICONS[template.agreementFamily] || '📄';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-ZA', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function confidenceLabel(confidence) {
  if (!confidence || confidence === 'high') return null;
  return confidence === 'medium' ? 'Review' : 'Needs Review';
}

// ── New Template Upload Modal ─────────────────────────────────────────────────

function UploadModal({ onClose, onSuccess }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [agreementFamily, setAgreementFamily] = useState('');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) { setError('Please choose a file.'); return; }
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (title) fd.append('title', title);
      if (category) fd.append('category', category);
      if (agreementFamily) fd.append('agreementFamily', agreementFamily);
      if (tags) fd.append('tags', tags);
      if (description) fd.append('description', description);
      await templatesApi.upload(fd);
      onSuccess('Template uploaded successfully.');
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Upload New Template" size="md">
      <form className="templates__upload-form" onSubmit={handleSubmit}>
        <div className="templates__upload-drop">
          <input
            id="tpl-file"
            type="file"
            accept=".docx,.dotx,.doc,.pdf"
            onChange={(e) => setFile(e.target.files[0] || null)}
            style={{ display: 'none' }}
          />
          <label htmlFor="tpl-file" className="templates__upload-label">
            {file ? (
              <span className="templates__upload-chosen">📎 {file.name}</span>
            ) : (
              <>
                <span className="templates__upload-icon">📂</span>
                <span>Choose file — DOCX, DOTX, DOC, or PDF</span>
              </>
            )}
          </label>
        </div>

        <div className="templates__use-field">
          <label>Title <span className="templates__optional">(optional — auto-derived from filename)</span></label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Master Services Agreement" />
        </div>

        <div className="templates__use-field">
          <label>Category <span className="templates__optional">(optional)</span></label>
          <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Services, Loans, Compliance" />
        </div>

        <div className="templates__use-field">
          <label>Description <span className="templates__optional">(optional)</span></label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this template"
            rows={2}
          />
        </div>

        <div className="templates__use-field">
          <label>Tags <span className="templates__optional">(optional, comma-separated)</span></label>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. Services, Standard, Recurring" />
        </div>

        {error && <p className="templates__error-inline">{error}</p>}

        <div className="templates__use-actions">
          <button type="button" className="templates__btn templates__btn--secondary" onClick={onClose} disabled={uploading}>Cancel</button>
          <button type="submit" className="templates__btn templates__btn--primary" disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload Template'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Preview Modal (metadata) ──────────────────────────────────────────────────

function PreviewModal({ template, onClose, onUse }) {
  return (
    <Modal isOpen onClose={onClose} title={template.title || template.name} size="lg">
      <div className="templates__preview">
        <div className="templates__preview-header">
          <div className="templates__preview-badges">
            {template.agreementFamily && template.agreementFamily !== 'OTHER' && (
              <span className="templates__badge templates__badge--family">
                {template.agreementFamily.replace(/_/g, ' ')}
              </span>
            )}
            {template.versionLabel && (
              <span className="templates__badge templates__badge--version">{template.versionLabel}</span>
            )}
            {template.approvalStatus === 'APPROVED'
              ? <span className="templates__badge templates__badge--approved">Approved</span>
              : <span className="templates__badge templates__badge--pending">{template.approvalStatus}</span>
            }
            {confidenceLabel(template.classificationConfidence) && (
              <span className="templates__badge templates__badge--review">
                {confidenceLabel(template.classificationConfidence)}
              </span>
            )}
          </div>
        </div>

        {template.description && (
          <p className="templates__preview-desc">{template.description}</p>
        )}

        <div className="templates__preview-grid">
          <div><span>Original File</span><strong>{template.originalFileName || '—'}</strong></div>
          <div><span>Category</span><strong>{template.category || '—'}</strong></div>
          <div><span>File Type</span><strong>{(template.extension || template.fileType || '').toUpperCase() || '—'}</strong></div>
          <div><span>File Size</span><strong>{formatBytes(template.fileSize) || '—'}</strong></div>
          <div><span>Source</span><strong>{template.displaySource || template.sourceFolder || '—'}</strong></div>
          <div><span>Source Type</span><strong>{template.sourceType || '—'}</strong></div>
          <div><span>Last Updated</span><strong>{formatDate(template.updatedAt)}</strong></div>
          <div><span>Usage Count</span><strong>{template.usageCount ?? 0} times</strong></div>
        </div>

        {template.tags && template.tags.length > 0 && (
          <div className="templates__preview-tags">
            {template.tags.map((tag) => (
              <span key={tag} className="templates__tag">{tag}</span>
            ))}
          </div>
        )}

        {template.classificationSignals && template.classificationSignals.length > 0 && (
          <div className="templates__preview-signals">
            <h4>Classification Signals</h4>
            <div className="templates__signals-list">
              {template.classificationSignals.map((s) => (
                <span key={s} className="templates__signal">{s}</span>
              ))}
            </div>
          </div>
        )}

        <div className="templates__preview-actions">
          <button className="templates__btn templates__btn--secondary" onClick={onClose}>Close</button>
          <button className="templates__btn templates__btn--primary" onClick={() => { onClose(); onUse(template); }}>
            Use This Template →
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Phase 2 Placeholder Modal ─────────────────────────────────────────────────

function UseModal({ template, onClose }) {
  return (
    <Modal isOpen onClose={onClose} title={`Use Template: ${template?.title || template?.name}`} size="md">
      <div className="templates__use-form">
        <div className="templates__phase2-notice">
          <span className="templates__phase2-icon">🚧</span>
          <div>
            <h4>Draft from Template — Phase 2</h4>
            <p>
              Full drafting workflow (contract title, counterparty, clause customisation)
              will be available in Phase 2.
            </p>
            <p className="templates__phase2-sub">
              The template <strong>{template?.title || template?.name}</strong> is registered
              and ready. Download it below to use it immediately.
            </p>
          </div>
        </div>

        <div className="templates__use-actions">
          <button className="templates__btn templates__btn--secondary" onClick={onClose}>Close</button>
          {template?._id && (
            <a
              className="templates__btn templates__btn--primary"
              href={templatesApi.downloadUrl(template._id)}
              target="_blank"
              rel="noreferrer"
            >
              Download Template
            </a>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Sync result banner ────────────────────────────────────────────────────────

function SyncBanner({ result, onDismiss }) {
  if (!result) return null;
  const { imported, updated, failed, warnings } = result;
  const hasWarnings = warnings && warnings.length > 0;
  const isError = failed > 0 || (imported === 0 && updated === 0 && hasWarnings);

  return (
    <div className={`templates__sync-banner ${isError ? 'templates__sync-banner--warn' : 'templates__sync-banner--ok'}`}>
      <span>
        {isError
          ? `⚠️ Templates sync: ${imported} imported, ${updated} updated, ${failed} failed.`
          : `✅ Templates synced: ${imported} imported, ${updated} updated.`}
        {hasWarnings && ` ${warnings[0]}`}
      </span>
      <button onClick={onDismiss}>✕</button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Templates() {
  const { isManager } = useAuth();

  const [templatesList, setTemplatesList] = useState([]);
  const [facets, setFacets] = useState({ categories: [], agreementFamilies: [], tags: [] });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [useTemplate, setUseTemplate] = useState(null);
  const [showUpload, setShowUpload] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [toast, setToast] = useState('');

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (search) params.search = search;
      if (category && category !== 'All') params.category = category;

      const [listRes, facetsRes] = await Promise.all([
        templatesApi.list(params),
        templatesApi.facets(),
      ]);

      setTemplatesList(listRes.templates || []);
      setTotal(listRes.total || (listRes.templates || []).length);
      setFacets(facetsRes || { categories: [], agreementFamilies: [], tags: [] });
    } catch (err) {
      setError(err.message || 'Failed to load templates.');
    } finally {
      setLoading(false);
    }
  }, [search, category]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const candidates = collectTemplateCandidates();
      const res = await templatesApi.discover(candidates);
      setSyncResult(res.summary);
      await loadTemplates();
    } catch (err) {
      setSyncResult({ imported: 0, updated: 0, failed: 1, warnings: [err.message || 'Sync failed.'] });
    } finally {
      setSyncing(false);
    }
  };

  const handleUploadSuccess = async (msg) => {
    setShowUpload(false);
    setToast(msg);
    setTimeout(() => setToast(''), 4000);
    await loadTemplates();
  };

  const dynamicCategories = ['All', ...facets.categories.filter(Boolean)];

  return (
    <div className="templates">
      <Header
        title="Contract Templates"
        subtitle={`${total} template${total !== 1 ? 's' : ''} in the library`}
      />

      {toast && <div className="templates__toast">{toast}</div>}
      <SyncBanner result={syncResult} onDismiss={() => setSyncResult(null)} />

      <div className="templates__content">
        {/* Toolbar */}
        <div className="templates__toolbar">
          <div className="templates__search">
            <span>🔍</span>
            <input
              type="text"
              placeholder="Search templates…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="templates__categories">
            {dynamicCategories.map((c) => (
              <button
                key={c}
                className={`templates__cat-btn${category === c ? ' templates__cat-btn--active' : ''}`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="templates__toolbar-actions">
            {isManager && (
              <button
                className="templates__sync-btn"
                onClick={handleSync}
                disabled={syncing}
                title="Scan Legal Folder for template files and import them"
              >
                {syncing ? 'Syncing…' : '🔄 Sync from Legal Folder'}
              </button>
            )}
            {isManager && (
              <button className="templates__new-btn" onClick={() => setShowUpload(true)}>
                + New Template
              </button>
            )}
          </div>
        </div>

        {/* States */}
        {loading && (
          <div className="templates__state">
            <span className="templates__state-spinner">⏳</span>
            <p>Loading templates…</p>
          </div>
        )}

        {!loading && error && (
          <div className="templates__state templates__state--error">
            <span>⚠️</span>
            <p>{error}</p>
            <button className="templates__btn templates__btn--secondary" onClick={loadTemplates}>Retry</button>
          </div>
        )}

        {!loading && !error && templatesList.length === 0 && (
          <div className="templates__state">
            <span>📋</span>
            {isManager ? (
              <>
                <p>No templates found.</p>
                <div className="templates__empty-actions">
                  <button className="templates__btn templates__btn--primary" onClick={handleSync} disabled={syncing}>
                    {syncing ? 'Syncing…' : '🔄 Sync Templates from Legal Folder'}
                  </button>
                  <button className="templates__btn templates__btn--secondary" onClick={() => setShowUpload(true)}>
                    Upload Template
                  </button>
                </div>
              </>
            ) : (
              <p>No approved templates are currently available. Contact your admin.</p>
            )}
          </div>
        )}

        {/* Template Grid */}
        {!loading && !error && templatesList.length > 0 && (
          <div className="templates__grid">
            {templatesList.map((t) => (
              <TemplateCard
                key={t._id}
                template={t}
                onPreview={() => setPreviewTemplate(t)}
                onUse={() => setUseTemplate(t)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {previewTemplate && (
        <PreviewModal
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
          onUse={(t) => setUseTemplate(t)}
        />
      )}

      {useTemplate && (
        <UseModal template={useTemplate} onClose={() => setUseTemplate(null)} />
      )}

      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onSuccess={handleUploadSuccess} />
      )}
    </div>
  );
}

// ── Template Card ─────────────────────────────────────────────────────────────

function TemplateCard({ template, onPreview, onUse }) {
  const title = template.title || template.name;
  const confLabel = confidenceLabel(template.classificationConfidence);

  return (
    <div className="templates__card">
      <div className="templates__card-header">
        <div className="templates__card-icon">{getIcon(template)}</div>
        <div className="templates__card-badges">
          {template.approvalStatus === 'APPROVED' && template.status === 'ACTIVE'
            ? <span className="templates__badge templates__badge--approved">Active</span>
            : <span className="templates__badge templates__badge--pending">{template.status || 'Pending'}</span>
          }
          {confLabel && (
            <span className="templates__badge templates__badge--review">{confLabel}</span>
          )}
        </div>
      </div>

      <h3 className="templates__card-name">{title}</h3>

      {template.agreementFamily && template.agreementFamily !== 'OTHER' && (
        <span className="templates__family-chip">
          {template.agreementFamily.replace(/_/g, ' ')}
        </span>
      )}

      {template.description && (
        <p className="templates__card-desc">{template.description}</p>
      )}

      {template.tags && template.tags.length > 0 && (
        <div className="templates__card-tags">
          {template.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="templates__tag">{tag}</span>
          ))}
        </div>
      )}

      <div className="templates__card-meta">
        <span className="templates__meta-item">📂 {template.displaySource || template.category || '—'}</span>
        {template.versionLabel && (
          <span className="templates__meta-item">{template.versionLabel}</span>
        )}
        {template.usageCount > 0 && (
          <span className="templates__meta-item">Used {template.usageCount}×</span>
        )}
      </div>

      <div className="templates__card-footer">
        <span className="templates__updated">Updated {formatDate(template.updatedAt)}</span>
        <div className="templates__card-actions">
          <button className="templates__btn templates__btn--secondary" onClick={onPreview}>
            Preview
          </button>
          <button className="templates__btn templates__btn--primary" onClick={onUse}>
            Use
          </button>
        </div>
      </div>
    </div>
  );
}
