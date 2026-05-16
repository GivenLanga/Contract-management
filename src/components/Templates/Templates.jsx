import { useState, useEffect, useCallback } from 'react';
import Header from '../Layout/Header';
import Modal from '../common/Modal';
import { getLegalFolderImport, LEGAL_FOLDER_UPDATED } from '../../services/legalFolderStore';
import { getLegalFolderFile } from '../../services/legalFolderFileStore';
import { getLegalFolderHandle } from '../../services/legalFolderHandle';
import { scanDocx, isScannable } from '../../services/templateDocumentScanner';
import { buildDraftPath, writeToLegalFolder } from '../../services/legalFolderPathBuilder';
import { createDraftDocx, downloadDraft } from '../../services/templateDraftWriter';
import { templates as templatesApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import './Templates.css';

// ── Template folder detection ─────────────────────────────────────────────────

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

// ── Contract type → agreement family ─────────────────────────────────────────

const TYPE_TO_FAMILY = {
  Addendum: 'ADDENDUM',
  Assistance: 'ASSISTANCE_AGREEMENT',
  Consultancy: 'CONSULTANCY_AGREEMENT',
  Loan: 'FUNDING_LOAN_AGREEMENT',
  MSA: 'MASTER_SERVICE_AGREEMENT',
  Service: 'ONCE_OFF_SERVICE_AGREEMENT',
  NDA: 'NDA',
  SOW: 'SOW',
  Vendor: 'VENDOR_AGREEMENT',
  License: 'LICENSE_AGREEMENT',
  Employment: 'EMPLOYMENT_AGREEMENT',
  DPA: 'DPA',
  Partnership: 'PARTNERSHIP_AGREEMENT',
  Agreement: 'GENERAL_CONTRACT',
  Imported: 'OTHER',
};

// ── Local template list from connected Legal Folder ───────────────────────────

function collectLocalTemplates() {
  const snapshot = getLegalFolderImport();
  if (!snapshot.source) return { templates: [], source: null };

  const contractById = new Map((snapshot.contracts || []).map((c) => [c.id, c]));

  const templates = (snapshot.documents || [])
    .filter((doc) => doc.sourcePath && isTemplatePath(doc.sourcePath))
    .map((doc) => {
      const contract = contractById.get(doc.contract?.id);
      const ext = (doc.type || '').toLowerCase();
      const title = (doc.name || '').replace(/\.[^.]+$/, '');
      const agreementFamily = TYPE_TO_FAMILY[contract?.type] || 'OTHER';

      return {
        _id: doc._id,
        name: title,
        title,
        originalFileName: doc.name,
        agreementFamily,
        category: contract?.type || 'General',
        extension: ext,
        fileType: ext,
        fileSize: doc.size || 0,
        sourcePath: doc.sourcePath,
        updatedAt: doc.updatedAt,
        sourceKind: 'LEGAL_FOLDER_SYNC',
      };
    });

  return { templates, source: snapshot.source };
}

// ── Icon helpers ──────────────────────────────────────────────────────────────

const FAMILY_ICONS = {
  FUNDING_LOAN_AGREEMENT: '💰',
  LOAN_AGREEMENT: '💰',
  ASSISTANCE_AGREEMENT: '🤝',
  MASTER_SERVICE_AGREEMENT: '⚙️',
  ONCE_OFF_SERVICE_AGREEMENT: '⚙️',
  CONSULTANCY_AGREEMENT: '💼',
  ADDENDUM: '📎',
  NDA: '🔒',
  MOU: '🤝',
  EMPLOYMENT_AGREEMENT: '👥',
  VENDOR_AGREEMENT: '📦',
  LEASE_AGREEMENT: '🏠',
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

// ── Placeholder form field ────────────────────────────────────────────────────

function PlaceholderField({ placeholder, value, onChange }) {
  const inputId = `ph-${placeholder.key}`;
  return (
    <div className="templates__use-field">
      <label htmlFor={inputId}>
        {placeholder.label}
        {placeholder.required && <span style={{ color: '#dc2626' }}> *</span>}
        <span className="templates__optional"> ({placeholder.raw})</span>
      </label>
      <input
        id={inputId}
        type={placeholder.key.includes('DATE') ? 'text' : 'text'}
        value={value || ''}
        onChange={(e) => onChange(placeholder.key, e.target.value)}
        placeholder={placeholder.label}
      />
    </div>
  );
}

// ── Draft from Template Modal (client-side) ───────────────────────────────────

function DraftModal({ template, onClose, onCreated }) {
  const [phase, setPhase] = useState('scanning'); // scanning | unavailable | form | submitting | done
  const [scanResult, setScanResult] = useState(null);
  const [fileRecord, setFileRecord] = useState(null);
  const [scanError, setScanError] = useState('');

  const [documentTitle, setDocumentTitle] = useState(template?.title || template?.name || '');
  const [counterparty, setCounterparty] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [category, setCategory] = useState(template?.category || '');
  const [notes, setNotes] = useState('');
  const [phValues, setPhValues] = useState({});

  const [submitError, setSubmitError] = useState('');
  const [draftResult, setDraftResult] = useState(null);

  const setPhValue = useCallback((key, val) => {
    setPhValues((prev) => ({ ...prev, [key]: val }));
  }, []);

  // Load file from IndexedDB and scan on mount
  useEffect(() => {
    let cancelled = false;

    async function loadAndScan() {
      try {
        const record = await getLegalFolderFile(template._id);
        if (cancelled) return;

        if (!record || !record.blob) {
          setPhase('unavailable');
          return;
        }

        setFileRecord(record);

        if (isScannable(template.extension)) {
          try {
            const result = await scanDocx(record.blob, template.title);
            if (!cancelled) setScanResult(result);
          } catch (err) {
            if (!cancelled) setScanError(`Scan warning: ${err.message}`);
          }
        }

        if (!cancelled) setPhase('form');
      } catch (err) {
        if (!cancelled) {
          setScanError(err.message || 'Could not read template file from cache.');
          setPhase('unavailable');
        }
      }
    }

    loadAndScan();
    return () => { cancelled = true; };
  }, [template._id, template.extension, template.title]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setPhase('submitting');
    setSubmitError('');

    try {
      // Merge all values: named placeholder fields + common fields
      const values = { ...phValues };
      if (counterparty) {
        values['COMPANY NAME'] = counterparty;
        values['COMPANY'] = counterparty;
        values['COUNTERPARTY'] = counterparty;
        values['COUNTERPARTY NAME'] = counterparty;
      }
      if (effectiveDate) {
        values['EFFECTIVE DATE'] = effectiveDate;
        values['DATE'] = effectiveDate;
        values['COMMENCEMENT DATE'] = effectiveDate;
      }

      const { blob, warnings } = await createDraftDocx(fileRecord.blob, values);

      const year = new Date().getFullYear();
      const pathInfo = buildDraftPath({
        year: String(year),
        agreementFamily: template.agreementFamily,
        category: category || template.category,
        counterparty,
        documentTitle: documentTitle.trim() || template.title,
      });

      // Try writing to Legal Folder; fall back to download
      let writtenPath = null;
      const rootHandle = getLegalFolderHandle();
      if (rootHandle) {
        try {
          const writeResult = await writeToLegalFolder(rootHandle, pathInfo, blob);
          writtenPath = writeResult.displayPath;
        } catch {
          // Write-back failed — download fallback below
        }
      }

      if (!writtenPath) {
        downloadDraft(blob, `${pathInfo.baseFileName} v1.docx`);
      }

      setDraftResult({
        blob,
        fileName: writtenPath ? writtenPath.split('/').pop() : `${pathInfo.baseFileName} v1.docx`,
        displayPath: writtenPath || pathInfo.displayPath,
        writtenToFolder: !!writtenPath,
        warnings,
      });

      setPhase('done');
      onCreated?.();
    } catch (err) {
      setSubmitError(err.message || 'Failed to create draft.');
      setPhase('form');
    }
  };

  // ── Scanning state ───────────────────────────────────────────────────────────
  if (phase === 'scanning') {
    return (
      <Modal isOpen onClose={onClose} title="Preparing Template" size="md">
        <div className="templates__draft-scanning">
          <div className="templates__state-spinner">⏳</div>
          <p>Analyzing template file…</p>
          <p className="templates__draft-scanning-sub">Detecting placeholders and form fields.</p>
        </div>
      </Modal>
    );
  }

  // ── File unavailable state ───────────────────────────────────────────────────
  if (phase === 'unavailable') {
    return (
      <Modal isOpen onClose={onClose} title="Template File Not Cached" size="md">
        <div className="templates__draft-unavailable">
          <span className="templates__draft-unavail-icon">📂</span>
          <p>
            The template file is not available in the browser cache.
            Please go to <strong>Legal Folder</strong> and sync the shared folder to reload files.
          </p>
          {scanError && <p className="templates__error-inline">{scanError}</p>}
          <div className="templates__use-actions" style={{ justifyContent: 'center' }}>
            <button className="templates__btn templates__btn--secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Done state ───────────────────────────────────────────────────────────────
  if (phase === 'done' && draftResult) {
    return (
      <Modal isOpen onClose={onClose} title="Draft Created" size="md">
        <div className="templates__draft-result">
          <div className="templates__draft-success-icon">✅</div>
          <h3 className="templates__draft-success-title">
            {draftResult.writtenToFolder ? 'Draft saved to Legal Folder.' : 'Draft downloaded.'}
          </h3>
          <div className="templates__draft-result-grid">
            <div><span>File</span><strong>{draftResult.fileName}</strong></div>
            <div><span>Path</span><strong style={{ wordBreak: 'break-all', fontSize: '12px' }}>{draftResult.displayPath}</strong></div>
            <div><span>Template</span><strong>{template.title || template.name}</strong></div>
          </div>
          {draftResult.warnings && draftResult.warnings.length > 0 && (
            <div className="templates__draft-warnings">
              {draftResult.warnings.map((w, i) => (
                <p key={i} className="templates__draft-warning">⚠️ {w}</p>
              ))}
            </div>
          )}
          {!draftResult.writtenToFolder && (
            <p style={{ fontSize: '13px', color: '#64748b', marginTop: '8px' }}>
              The draft was downloaded. To enable automatic write-back, reconnect the Legal Folder — the app will request edit access.
            </p>
          )}
          <div className="templates__use-actions">
            {!draftResult.writtenToFolder && (
              <button
                className="templates__btn templates__btn--secondary"
                onClick={() => downloadDraft(draftResult.blob, draftResult.fileName)}
              >
                Download Again
              </button>
            )}
            <button className="templates__btn templates__btn--primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Draft form ───────────────────────────────────────────────────────────────
  const placeholders = scanResult?.placeholders || [];
  const blankFields = scanResult?.blankFields || [];
  const isSubmitting = phase === 'submitting';

  // Group placeholders by their group label
  const groupedPh = placeholders.reduce((acc, ph) => {
    if (!acc[ph.group]) acc[ph.group] = [];
    acc[ph.group].push(ph);
    return acc;
  }, {});

  return (
    <Modal isOpen onClose={onClose} title="Draft from Template" size="lg">
      <div className="templates__draft-form">
        {/* Template info strip */}
        <div className="templates__draft-template-info">
          <div className="templates__draft-template-icon">{getIcon(template)}</div>
          <div>
            <div className="templates__draft-template-name">{template.title || template.name}</div>
            <div className="templates__draft-template-meta">
              {template.extension && (
                <span className="templates__badge templates__badge--version">{template.extension.toUpperCase()}</span>
              )}
              {template.category && template.category !== 'General' && (
                <span className="templates__badge templates__badge--family">{template.category}</span>
              )}
              {formatBytes(template.fileSize) && (
                <span className="templates__badge templates__badge--version">{formatBytes(template.fileSize)}</span>
              )}
            </div>
          </div>
        </div>

        {scanError && <p className="templates__error-inline" style={{ marginBottom: '12px' }}>⚠️ {scanError}</p>}

        {placeholders.length > 0 && (
          <div className="templates__draft-scan-summary">
            ✅ {placeholders.length} placeholder{placeholders.length !== 1 ? 's' : ''} detected
            {blankFields.length > 0 && ` · ${blankFields.length} form field${blankFields.length !== 1 ? 's' : ''}`}
          </div>
        )}

        <form className="templates__draft-fields" onSubmit={handleSubmit}>
          {/* Standard fields */}
          <div className="templates__use-field">
            <label>Document Title <span style={{ color: '#dc2626' }}>*</span></label>
            <input
              type="text"
              value={documentTitle}
              onChange={(e) => setDocumentTitle(e.target.value)}
              placeholder="e.g. Assistance Agreement - Counterparty Name"
              required
            />
          </div>

          <div className="templates__draft-row">
            <div className="templates__use-field">
              <label>Counterparty / Company Name</label>
              <input
                type="text"
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder="e.g. Lwams Africa Proprietary Limited"
              />
            </div>
            <div className="templates__use-field">
              <label>Effective Date</label>
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </div>
          </div>

          <div className="templates__use-field">
            <label>Category <span className="templates__optional">(optional — determines folder in Legal Folder)</span></label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={template.category || 'e.g. Assistance Agreements'}
            />
          </div>

          {/* Detected placeholder fields, grouped */}
          {Object.entries(groupedPh).map(([group, fields]) => (
            <div key={group} className="templates__ph-group">
              <div className="templates__ph-group-label">{group}</div>
              {fields.map((ph) => (
                <PlaceholderField
                  key={ph.key}
                  placeholder={ph}
                  value={phValues[ph.key] || ''}
                  onChange={setPhValue}
                />
              ))}
            </div>
          ))}

          <div className="templates__use-field">
            <label>Notes <span className="templates__optional">(optional)</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes for this draft"
              rows={2}
            />
          </div>

          {submitError && <p className="templates__error-inline">{submitError}</p>}

          <div className="templates__use-actions">
            <button
              type="button"
              className="templates__btn templates__btn--secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="templates__btn templates__btn--primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating Draft…' : 'Create Draft'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

// ── Preview Modal ─────────────────────────────────────────────────────────────

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
            {template.extension && (
              <span className="templates__badge templates__badge--version">{template.extension.toUpperCase()}</span>
            )}
            <span className="templates__badge templates__badge--approved">Legal Folder</span>
          </div>
        </div>

        <div className="templates__preview-grid">
          <div><span>File</span><strong>{template.originalFileName || '—'}</strong></div>
          <div><span>Category</span><strong>{template.category || '—'}</strong></div>
          <div><span>File Type</span><strong>{(template.extension || '').toUpperCase() || '—'}</strong></div>
          <div><span>File Size</span><strong>{formatBytes(template.fileSize) || '—'}</strong></div>
          <div><span>Source</span><strong>{template.sourcePath || '—'}</strong></div>
          <div><span>Last Updated</span><strong>{formatDate(template.updatedAt)}</strong></div>
        </div>

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

// ── Sync result banner ────────────────────────────────────────────────────────

function SyncBanner({ result, onDismiss }) {
  if (!result) return null;
  const { imported, updated, failed, warnings } = result;
  const isError = failed > 0 || (imported === 0 && updated === 0 && warnings?.length > 0);
  return (
    <div className={`templates__sync-banner ${isError ? 'templates__sync-banner--warn' : 'templates__sync-banner--ok'}`}>
      <span>
        {isError
          ? `⚠️ Backend index: ${imported} imported, ${updated} updated, ${failed} failed.`
          : `✅ Backend index updated: ${imported} imported, ${updated} updated.`}
        {warnings?.length > 0 && ` ${warnings[0]}`}
      </span>
      <button onClick={onDismiss}>✕</button>
    </div>
  );
}

// ── Template Card ─────────────────────────────────────────────────────────────

function TemplateCard({ template, onPreview, onUse }) {
  const title = template.title || template.name;
  return (
    <div className="templates__card">
      <div className="templates__card-header">
        <div className="templates__card-icon">{getIcon(template)}</div>
        <div className="templates__card-badges">
          <span className="templates__badge templates__badge--approved">Legal Folder</span>
          {template.extension && (
            <span className="templates__badge templates__badge--version">{template.extension.toUpperCase()}</span>
          )}
        </div>
      </div>

      <h3 className="templates__card-name">{title}</h3>

      {template.agreementFamily && template.agreementFamily !== 'OTHER' && (
        <span className="templates__family-chip">
          {template.agreementFamily.replace(/_/g, ' ')}
        </span>
      )}

      <div className="templates__card-meta">
        {template.category && template.category !== 'General' && (
          <span className="templates__meta-item">📂 {template.category}</span>
        )}
        {formatBytes(template.fileSize) && (
          <span className="templates__meta-item">{formatBytes(template.fileSize)}</span>
        )}
      </div>

      <div className="templates__card-footer">
        <span className="templates__updated">Updated {formatDate(template.updatedAt)}</span>
        <div className="templates__card-actions">
          <button className="templates__btn templates__btn--secondary" onClick={onPreview}>Preview</button>
          <button className="templates__btn templates__btn--primary" onClick={onUse}>Use</button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Templates() {
  const { isManager } = useAuth();

  const [localData, setLocalData] = useState(() => collectLocalTemplates());
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [draftTemplate, setDraftTemplate] = useState(null);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [toast, setToast] = useState('');

  // Refresh local data whenever the Legal Folder changes (connect / disconnect / sync)
  useEffect(() => {
    const onUpdate = () => setLocalData(collectLocalTemplates());
    window.addEventListener(LEGAL_FOLDER_UPDATED, onUpdate);
    return () => window.removeEventListener(LEGAL_FOLDER_UPDATED, onUpdate);
  }, []);

  const { templates: allTemplates, source } = localData;

  // Filter
  const categories = ['All', ...new Set(allTemplates.map((t) => t.category).filter(Boolean))].sort();
  const filtered = allTemplates.filter((t) => {
    const matchesSearch = !search || t.title.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !category || category === 'All' || t.category === category;
    return matchesSearch && matchesCategory;
  });

  // Optional: push candidates to backend for RAG indexing (not for display)
  const handleSync = async () => {
    if (!source) {
      setToast('No Legal Folder connected. Connect a shared folder first.');
      setTimeout(() => setToast(''), 4000);
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    try {
      const candidates = allTemplates.map((t) => ({
        name: t.originalFileName,
        sourcePath: t.sourcePath,
        size: t.fileSize,
        _id: t._id,
        updatedAt: t.updatedAt,
      }));
      const legalFolderSource = {
        id: source.name,
        name: source.name,
        syncedAt: source.syncedAt,
      };
      const res = await templatesApi.discover(candidates, legalFolderSource);
      setSyncResult(res.summary);
    } catch (err) {
      setSyncResult({ imported: 0, updated: 0, failed: 1, warnings: [err.message || 'Backend index sync failed.'] });
    } finally {
      setSyncing(false);
    }
  };

  const noFolder = !source;
  const noTemplates = source && allTemplates.length === 0;

  return (
    <div className="templates">
      <Header
        title="Contract Templates"
        subtitle={
          source
            ? `${allTemplates.length} template${allTemplates.length !== 1 ? 's' : ''} from ${source.name}`
            : 'No Legal Folder connected'
        }
      />

      {toast && <div className="templates__toast">{toast}</div>}
      <SyncBanner result={syncResult} onDismiss={() => setSyncResult(null)} />

      <div className="templates__content">
        {/* Toolbar — only shown when folder is connected */}
        {source && (
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
              {categories.map((c) => (
                <button
                  key={c}
                  className={`templates__cat-btn${category === c ? ' templates__cat-btn--active' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>

            {isManager && (
              <div className="templates__toolbar-actions">
                <button
                  className="templates__sync-btn"
                  onClick={handleSync}
                  disabled={syncing}
                  title="Push template metadata to backend search index"
                >
                  {syncing ? 'Indexing…' : '🔄 Index for Search'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Empty: no Legal Folder connected */}
        {noFolder && (
          <div className="templates__state">
            <span>📂</span>
            <p><strong>No Legal Folder connected.</strong></p>
            <p style={{ color: '#64748b' }}>
              Connect or sync a Legal Folder to discover templates.
            </p>
            <div className="templates__empty-actions">
              <a
                href="/documents"
                className="templates__btn templates__btn--primary"
                onClick={(e) => {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent('navigate', { detail: '/documents' }));
                  // Fallback: navigate to Legal Folder page
                  const link = document.querySelector('[href="/documents"]') || document.querySelector('[data-route="/documents"]');
                  if (link) link.click();
                }}
              >
                Go to Legal Folder
              </a>
            </div>
          </div>
        )}

        {/* Empty: folder connected but no templates found */}
        {noTemplates && (
          <div className="templates__state">
            <span>📋</span>
            <p><strong>No templates found in {source.name}.</strong></p>
            <p style={{ color: '#64748b' }}>
              Templates are files inside a <code>Templates/</code> folder in your shared folder.
            </p>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Example path: <code>{source.name}/Templates/Assistance Agreement Template.docx</code>
            </p>
          </div>
        )}

        {/* No results from filter */}
        {source && allTemplates.length > 0 && filtered.length === 0 && (
          <div className="templates__state">
            <span>🔍</span>
            <p>No templates match your search.</p>
            <button className="templates__btn templates__btn--secondary" onClick={() => { setSearch(''); setCategory('All'); }}>
              Clear filters
            </button>
          </div>
        )}

        {/* Template Grid */}
        {filtered.length > 0 && (
          <div className="templates__grid">
            {filtered.map((t) => (
              <TemplateCard
                key={t._id}
                template={t}
                onPreview={() => setPreviewTemplate(t)}
                onUse={() => setDraftTemplate(t)}
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
          onUse={(t) => setDraftTemplate(t)}
        />
      )}

      {draftTemplate && (
        <DraftModal
          template={draftTemplate}
          onClose={() => setDraftTemplate(null)}
          onCreated={() => {}}
        />
      )}
    </div>
  );
}
