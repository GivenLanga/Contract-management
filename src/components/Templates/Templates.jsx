import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Header from '../Layout/Header';
import Modal from '../common/Modal';
import { getLegalFolderImport, addDocumentToLegalFolderImport, LEGAL_FOLDER_UPDATED } from '../../services/legalFolderStore';
import { getLegalFolderFile } from '../../services/legalFolderFileStore';
import { getLegalFolderHandle } from '../../services/legalFolderHandle';
import {
  getLegalFolderStatus,
  ensureLegalFolderWriteAccess,
  reauthorizeLegalFolder,
  FOLDER_STATE,
} from '../../services/legalFolderAccess';
import { scanDocx, isScannable } from '../../services/templateDocumentScanner';
import {
  buildDraftDestination,
  writeDraftToFolder,
  mapAgreementFamilyToFolder,
  getExistingCategoryFolders,
} from '../../services/legalFolderPathBuilder';
import { createDraftDocx } from '../../services/templateDraftWriter';
import { openDraft } from '../../services/draftOpenService';
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
        type="text"
        value={value || ''}
        onChange={(e) => onChange(placeholder.key, e.target.value)}
        placeholder={placeholder.label}
      />
    </div>
  );
}

// ── Navigate helper (dispatches to app router) ────────────────────────────────

function navigateTo(path, state) {
  window.dispatchEvent(new CustomEvent('navigate', { detail: { path, state } }));
}

// ── Countdown progress ring ────────────────────────────────────────────────────

function CountdownRing({ countdown, total = 5, size = 18, strokeWidth = 2.5 }) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = Math.max(0, Math.min(1, countdown / total));
  const dashoffset = circumference * (1 - progress);
  return (
    <svg
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: 'middle', transform: 'rotate(-90deg)', flexShrink: 0 }}
    >
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="white" strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashoffset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.9s linear' }}
      />
    </svg>
  );
}

// ── Draft from Template Modal ─────────────────────────────────────────────────
// Phases:
//   checking          — initial: check write access + load file
//   disconnected      — no Legal Folder index at all
//   unsupported-browser — browser lacks File System Access API
//   write-reauth-required — index exists but write handle is missing / permission revoked
//   unavailable       — file not in IDB cache
//   form              — ready to fill in and submit
//   submitting        — creating draft
//   done              — success

function DraftModal({ template, onClose, onCreated }) {
  const [phase, setPhase] = useState('checking');
  const [retryKey, setRetryKey] = useState(0);

  const [scanResult, setScanResult] = useState(null);
  const [fileRecord, setFileRecord] = useState(null);
  const [scanError, setScanError] = useState('');
  const [existingFolders, setExistingFolders] = useState([]);

  const [documentTitle, setDocumentTitle] = useState(template?.title || template?.name || '');
  const [counterparty, setCounterparty] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [categoryOverride, setCategoryOverride] = useState('');
  const [notes, setNotes] = useState('');
  const [phValues, setPhValues] = useState({});

  const [submitError, setSubmitError] = useState('');
  const [draftResult, setDraftResult] = useState(null);

  const [isReauthing, setIsReauthing] = useState(false);
  const [reauthError, setReauthError] = useState('');
  const [sourceName, setSourceName] = useState(null);

  // ── Open Draft (post-creation) ──────────────────────────────────────────────
  const [countdown, setCountdown] = useState(5);
  const [autoOpenEnabled, setAutoOpenEnabled] = useState(false);
  const [openStatus, setOpenStatus] = useState(null); // null | 'opening' | 'success' | 'failed'
  const [openResult, setOpenResult] = useState(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const setPhValue = useCallback((key, val) => {
    setPhValues((prev) => ({ ...prev, [key]: val }));
  }, []);

  // ── Access check + file load ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Step 1: check write access (loads handle from IDB, queries permission)
      let status;
      try {
        status = await getLegalFolderStatus();
      } catch {
        status = null;
      }
      if (cancelled) return;

      if (!status || status.state === FOLDER_STATE.DISCONNECTED) {
        setPhase('disconnected');
        return;
      }

      if (status.state === FOLDER_STATE.UNSUPPORTED_BROWSER) {
        setSourceName(status.sourceName);
        setPhase('unsupported-browser');
        return;
      }

      if (status.state !== FOLDER_STATE.WRITE_READY) {
        // WRITE_REAUTH_REQUIRED or INDEX_ONLY
        setSourceName(status.sourceName);
        setPhase('write-reauth-required');
        return;
      }

      // Step 2: load file from IDB cache
      let record;
      try {
        record = await getLegalFolderFile(template._id);
      } catch {
        record = null;
      }
      if (cancelled) return;

      if (!record || !record.blob) {
        setPhase('unavailable');
        return;
      }

      setFileRecord(record);

      // Step 3: prefetch existing category folders for destination preview
      const rootHandle = getLegalFolderHandle();
      if (rootHandle) {
        const folders = await getExistingCategoryFolders(rootHandle).catch(() => []);
        if (!cancelled) setExistingFolders(folders);
      }

      // Step 4: scan for placeholders
      if (isScannable(template.extension)) {
        try {
          const result = await scanDocx(record.blob, template.title);
          if (!cancelled) setScanResult(result);
        } catch (err) {
          if (!cancelled) setScanError(`Scan warning: ${err.message}`);
        }
      }

      if (!cancelled) setPhase('form');
    }

    run();
    return () => { cancelled = true; };
  }, [template._id, template.extension, template.title, retryKey]);

  // ── Re-authorize handler ────────────────────────────────────────────────────
  const handleReauthorize = async () => {
    setIsReauthing(true);
    setReauthError('');
    try {
      const result = await reauthorizeLegalFolder();
      if (result.success) {
        // Re-run access check and file load with the fresh handle
        setPhase('checking');
        setRetryKey((k) => k + 1);
      } else if (result.reason === 'cancelled') {
        // User dismissed the picker — do nothing
      } else if (result.reason === 'name_mismatch') {
        setReauthError(
          `The selected folder does not look like the connected Legal Folder. ` +
          `Please select the folder named "${result.expectedName}". ` +
          `You selected "${result.selectedName}".`
        );
      } else {
        setReauthError('Authorization failed. Please try again.');
      }
    } catch (err) {
      setReauthError(err.message || 'Authorization failed. Please try again.');
    } finally {
      setIsReauthing(false);
    }
  };

  // ── Open Draft handlers ─────────────────────────────────────────────────────

  const handleOpenDraft = useCallback(async () => {
    if (openStatus === 'opening' || !draftResult) return;
    setAutoOpenEnabled(false);
    setOpenStatus('opening');
    try {
      const result = await openDraft({
        fileName: draftResult.fileName,
        relativePath: draftResult.relativePath,
        displayPath: draftResult.displayPath,
        legalFolderSourceId: draftResult.legalFolderSourceId,
        templateTitle: draftResult.templateTitle,
        mimeType: draftResult.mimeType,
        extension: draftResult.extension,
      });
      setOpenResult(result);
      setOpenStatus(result.ok ? 'success' : 'failed');
    } catch (err) {
      setOpenResult({ ok: false, method: 'unsupported', message: err?.message || 'Failed to open.' });
      setOpenStatus('failed');
    }
  }, [draftResult, openStatus]);

  const handleCloseDone = useCallback(() => {
    setAutoOpenEnabled(false);
    onClose();
  }, [onClose]);

  const handleCopyPath = useCallback(async () => {
    if (!draftResult?.displayPath) return;
    try {
      await navigator.clipboard.writeText(draftResult.displayPath);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      // clipboard API unavailable — silent
    }
  }, [draftResult]);

  // Countdown auto-open: decrements every 1s and calls handleOpenDraft at zero.
  // Clears itself when autoOpenEnabled becomes false (Close clicked or manual open).
  useEffect(() => {
    if (phase !== 'done' || !autoOpenEnabled) return;
    if (countdown <= 0) {
      handleOpenDraft();
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, countdown, autoOpenEnabled, handleOpenDraft]);

  // ── Submit handler ──────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!counterparty.trim()) {
      setSubmitError('A counterparty name is required to determine the draft folder.');
      return;
    }

    setPhase('submitting');
    setSubmitError('');

    // Re-check write access from the user gesture — may call requestPermission
    const writeState = await ensureLegalFolderWriteAccess();
    if (writeState !== FOLDER_STATE.WRITE_READY) {
      setPhase('write-reauth-required');
      return;
    }

    const rootHandle = getLegalFolderHandle();
    if (!rootHandle) {
      setPhase('write-reauth-required');
      return;
    }

    try {
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

      const destination = await buildDraftDestination({
        rootHandle,
        agreementFamily: template.agreementFamily,
        templateCategory: categoryOverride.trim() || template.category,
        counterparty: counterparty.trim(),
        documentTitle: documentTitle.trim() || template.title,
      });

      // Write directly to Legal Folder — no OS save dialog, no anchor download
      await writeDraftToFolder(destination.directoryHandle, destination.fileName, blob);

      const now = new Date().toISOString();
      addDocumentToLegalFolderImport({
        _id: `DRAFT-${Date.now().toString(36)}`,
        name: destination.fileName,
        type: 'docx',
        size: blob.size,
        status: 'Draft',
        updatedAt: now,
        uploadedBy: { name: counterparty.trim() },
        contract: { id: null, title: documentTitle.trim() || template.title },
        source: 'shared-folder',
        sourcePath: destination.relativePath,
        company: counterparty.trim(),
        year: String(new Date().getFullYear()),
        documentStage: 'DRAFT',
        createdFromTemplate: true,
        templateSourceKey: template.sourceKey,
        templateTitle: template.title || template.name,
        agreementFamily: template.agreementFamily,
        createdAt: now,
      });

      const snapshot = getLegalFolderImport();
      setDraftResult({
        fileName: destination.fileName,
        displayPath: destination.displayPath,
        relativePath: destination.relativePath,
        legalFolderSourceId: snapshot.source?.name || null,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: 'docx',
        templateTitle: template.title || template.name,
        warnings,
      });
      setCountdown(5);
      setAutoOpenEnabled(true);
      setOpenStatus(null);
      setOpenResult(null);
      setPhase('done');
      onCreated?.();
    } catch (err) {
      setSubmitError(
        err.message ||
        'Failed to write draft to Legal Folder. Check that the folder is still connected.'
      );
      setPhase('form');
    }
  };

  // ── Destination preview ─────────────────────────────────────────────────────
  const destinationPreview = useMemo(() => {
    const year = new Date().getFullYear();
    const resolvedCategory = categoryOverride.trim() ||
      mapAgreementFamilyToFolder(template.agreementFamily, template.category, existingFolders);
    const safeTitle = (documentTitle.trim() || template.title || 'Draft').slice(0, 100);
    const cp = counterparty.trim();
    if (!cp) return null;
    const parts = ['Contracts', String(year), resolvedCategory, cp, 'Drafts'];
    const fileName = `${safeTitle} - ${cp} - Draft v1.docx`;
    return { parts, fileName };
  }, [counterparty, categoryOverride, documentTitle, template.agreementFamily, template.category, existingFolders, template.title]);

  // ── Phase renders ───────────────────────────────────────────────────────────

  if (phase === 'checking') {
    return (
      <Modal isOpen onClose={onClose} title="Preparing Draft" size="md">
        <div className="templates__draft-scanning">
          <div className="templates__state-spinner">⏳</div>
          <p>Checking Legal Folder access…</p>
        </div>
      </Modal>
    );
  }

  if (phase === 'disconnected') {
    return (
      <Modal isOpen onClose={onClose} title="No Legal Folder Connected" size="md">
        <div className="templates__draft-unavailable">
          <span className="templates__draft-unavail-icon">📂</span>
          <p><strong>No Legal Folder is connected.</strong></p>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            Connect a Legal Folder to create drafts directly in your folder.
          </p>
          <div className="templates__use-actions" style={{ justifyContent: 'center' }}>
            <button
              className="templates__btn templates__btn--secondary"
              onClick={() => { onClose(); navigateTo('/documents'); }}
            >
              Go to Legal Folder
            </button>
            <button className="templates__btn templates__btn--secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (phase === 'unsupported-browser') {
    return (
      <Modal isOpen onClose={onClose} title="Browser Not Supported for Direct Folder Writing" size="md">
        <div className="templates__draft-unavailable">
          <span className="templates__draft-unavail-icon">🌐</span>
          <p><strong>Legal Folder write access is not supported in this browser.</strong></p>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            ContractIQ can display templates from the synced Legal Folder index
            {sourceName ? ` (${sourceName})` : ''}, but this browser cannot grant direct write
            access to save drafts into the folder.
          </p>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            Use Chrome or Edge for Legal Folder write access.
          </p>
          <div className="templates__use-actions" style={{ justifyContent: 'center' }}>
            <button
              className="templates__btn templates__btn--secondary"
              onClick={() => { onClose(); navigateTo('/documents'); }}
            >
              Go to Legal Folder
            </button>
            <button className="templates__btn templates__btn--secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (phase === 'write-reauth-required') {
    return (
      <Modal isOpen onClose={onClose} title="Legal Folder Write Access Required" size="md">
        <div className="templates__draft-unavailable">
          <span className="templates__draft-unavail-icon">🔐</span>
          <p><strong>Legal Folder write access is not available.</strong></p>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            Templates were loaded from your connected Legal Folder index
            {sourceName ? ` (${sourceName})` : ''}, but ContractIQ needs write permission
            to save a draft directly into that folder. Re-authorize the Legal Folder with
            read/write access.
          </p>
          {reauthError && (
            <p
              className="templates__error-inline"
              style={{ maxWidth: '380px', textAlign: 'center' }}
            >
              {reauthError}
            </p>
          )}
          <div className="templates__draft-reauth-actions">
            <button
              className="templates__btn templates__btn--primary"
              onClick={handleReauthorize}
              disabled={isReauthing}
            >
              {isReauthing ? 'Authorizing…' : 'Re-authorize Legal Folder'}
            </button>
            <button
              className="templates__btn templates__btn--secondary"
              onClick={() => { onClose(); navigateTo('/documents'); }}
            >
              Go to Legal Folder
            </button>
            <button className="templates__btn templates__btn--secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

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

  if (phase === 'done' && draftResult) {
    const isBrowserFallback = openStatus === 'failed' && openResult?.method === 'browser_fallback';
    const isOtherError = openStatus === 'failed' && !isBrowserFallback;

    return (
      <Modal isOpen onClose={handleCloseDone} title="Draft Created" size="md">
        <div className="templates__draft-result">
          <div className="templates__draft-success-icon">✅</div>
          <h3 className="templates__draft-success-title">Draft saved to Legal Folder.</h3>
          <div className="templates__draft-result-grid">
            <div><span>File</span><strong>{draftResult.fileName}</strong></div>
            <div>
              <span>Path</span>
              <strong style={{ wordBreak: 'break-all', fontSize: '12px' }}>
                {draftResult.displayPath}
              </strong>
            </div>
            <div><span>Template</span><strong>{template.title || template.name}</strong></div>
          </div>

          {draftResult.warnings?.length > 0 && (
            <div className="templates__draft-warnings">
              {draftResult.warnings.map((w, i) => (
                <p key={i} className="templates__draft-warning">⚠️ {w}</p>
              ))}
            </div>
          )}

          {openStatus === 'success' && (
            <p className="templates__open-status templates__open-status--ok">Opening draft…</p>
          )}

          {isBrowserFallback && (
            <div className="templates__open-fallback">
              <p>
                Automatic opening requires the ContractIQ desktop app. Open the draft from the
                Legal Folder path shown above.
              </p>
              <div className="templates__open-fallback-actions">
                <button
                  className="templates__btn templates__btn--secondary"
                  onClick={handleCopyPath}
                  data-testid="copy-path-btn"
                >
                  {copyFeedback ? 'Copied!' : 'Copy Path'}
                </button>
                <button
                  className="templates__btn templates__btn--secondary"
                  data-testid="view-in-folder-btn"
                  onClick={() => {
                    handleCloseDone();
                    navigateTo('/documents', { focusPath: draftResult.relativePath });
                  }}
                >
                  View in Legal Folder
                </button>
              </div>
            </div>
          )}

          {isOtherError && (
            <p className="templates__error-inline" style={{ textAlign: 'center' }}>
              {openResult?.message || "Couldn't open the file automatically."}
            </p>
          )}

          <div className="templates__use-actions">
            <button
              className="templates__btn templates__btn--secondary"
              onClick={handleCloseDone}
            >
              Close
            </button>
            {openStatus !== 'success' && (
              <button
                className="templates__btn templates__btn--primary templates__open-btn"
                onClick={handleOpenDraft}
                disabled={openStatus === 'opening'}
                data-testid="open-draft-btn"
              >
                {openStatus === 'opening' ? (
                  'Opening…'
                ) : (
                  <>
                    {autoOpenEnabled && countdown > 0 && (
                      <CountdownRing countdown={countdown} />
                    )}
                    {autoOpenEnabled && countdown > 0
                      ? `Open Draft in ${countdown}s`
                      : 'Open Draft'}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  // ── Draft form ──────────────────────────────────────────────────────────────
  const placeholders = scanResult?.placeholders || [];
  const blankFields = scanResult?.blankFields || [];
  const isSubmitting = phase === 'submitting';

  const groupedPh = placeholders.reduce((acc, ph) => {
    if (!acc[ph.group]) acc[ph.group] = [];
    acc[ph.group].push(ph);
    return acc;
  }, {});

  return (
    <Modal isOpen onClose={onClose} title="Draft from Template" size="lg">
      <div className="templates__draft-form">
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
          <div className="templates__use-field">
            <label>Document Title <span style={{ color: '#dc2626' }}>*</span></label>
            <input
              type="text"
              value={documentTitle}
              onChange={(e) => setDocumentTitle(e.target.value)}
              placeholder="e.g. Once-Off Service Agreement - ABC Suppliers Pty Ltd"
              required
            />
          </div>

          <div className="templates__draft-row">
            <div className="templates__use-field">
              <label>Counterparty / Company Name <span style={{ color: '#dc2626' }}>*</span></label>
              <input
                type="text"
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder="e.g. ABC Suppliers Pty Ltd"
                required
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
            <label>
              Category Override
              <span className="templates__optional"> (optional — auto-detected from agreement type)</span>
            </label>
            <input
              type="text"
              value={categoryOverride}
              onChange={(e) => setCategoryOverride(e.target.value)}
              placeholder={
                mapAgreementFamilyToFolder(template.agreementFamily, template.category, existingFolders) ||
                'e.g. Assistance Agreements'
              }
            />
          </div>

          <div className="templates__draft-destination">
            <div className="templates__draft-destination-label">Draft destination</div>
            {destinationPreview ? (
              <div className="templates__draft-destination-path">
                {destinationPreview.parts.join(' / ')} / <strong>{destinationPreview.fileName}</strong>
              </div>
            ) : (
              <div className="templates__draft-destination-empty">
                Enter a counterparty to determine the draft folder.
              </div>
            )}
          </div>

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
              disabled={isSubmitting || !counterparty.trim()}
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

// ── Write-access banner (shown when index exists but write is not ready) ──────

function WriteAccessBanner({ folderStatus, onReauthorize, isReauthing }) {
  if (!folderStatus || !folderStatus.hasIndex || folderStatus.canWrite) return null;

  if (folderStatus.state === FOLDER_STATE.UNSUPPORTED_BROWSER) {
    return (
      <div className="templates__write-banner templates__write-banner--warn" data-testid="write-access-banner">
        <span>
          Templates are available from your Legal Folder index. Your browser does not support direct
          folder write access — use Chrome or Edge to create drafts directly in the folder.
        </span>
        <button
          className="templates__btn templates__btn--secondary"
          onClick={() => navigateTo('/documents')}
        >
          Go to Legal Folder
        </button>
      </div>
    );
  }

  return (
    <div className="templates__write-banner" data-testid="write-access-banner">
      <span>
        Templates are available from your Legal Folder index. Re-authorize write access to create
        drafts directly in the folder.
      </span>
      <button
        className="templates__btn templates__btn--primary"
        onClick={onReauthorize}
        disabled={isReauthing}
      >
        {isReauthing ? 'Authorizing…' : 'Enable Write Access'}
      </button>
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

  const [folderStatus, setFolderStatus] = useState(null);
  const [reauthingBanner, setReauthingBanner] = useState(false);

  // Load folder capability status on mount
  useEffect(() => {
    let cancelled = false;
    getLegalFolderStatus().then((s) => {
      if (!cancelled) setFolderStatus(s);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Refresh local data and folder status whenever the Legal Folder changes
  useEffect(() => {
    const onUpdate = () => {
      setLocalData(collectLocalTemplates());
      getLegalFolderStatus().then(setFolderStatus).catch(() => {});
    };
    window.addEventListener(LEGAL_FOLDER_UPDATED, onUpdate);
    return () => window.removeEventListener(LEGAL_FOLDER_UPDATED, onUpdate);
  }, []);

  const { templates: allTemplates, source } = localData;

  const categories = ['All', ...new Set(allTemplates.map((t) => t.category).filter(Boolean))].sort();
  const filtered = allTemplates.filter((t) => {
    const matchesSearch = !search || t.title.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !category || category === 'All' || t.category === category;
    return matchesSearch && matchesCategory;
  });

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
      const legalFolderSource = { id: source.name, name: source.name, syncedAt: source.syncedAt };
      const res = await templatesApi.discover(candidates, legalFolderSource);
      setSyncResult(res.summary);
    } catch (err) {
      setSyncResult({ imported: 0, updated: 0, failed: 1, warnings: [err.message || 'Backend index sync failed.'] });
    } finally {
      setSyncing(false);
    }
  };

  const handleBannerReauthorize = async () => {
    setReauthingBanner(true);
    try {
      const result = await reauthorizeLegalFolder();
      if (result.success) {
        const updated = await getLegalFolderStatus();
        setFolderStatus(updated);
        if (updated.canWrite) {
          setToast('Write access enabled. You can now create drafts directly in your Legal Folder.');
          setTimeout(() => setToast(''), 5000);
        }
      } else if (result.reason === 'name_mismatch') {
        setToast(`Please select the folder named "${result.expectedName}". You selected "${result.selectedName}".`);
        setTimeout(() => setToast(''), 6000);
      } else if (result.reason !== 'cancelled') {
        setToast('Authorization failed. Please try again.');
        setTimeout(() => setToast(''), 4000);
      }
    } catch {
      setToast('Authorization failed. Please try again.');
      setTimeout(() => setToast(''), 4000);
    } finally {
      setReauthingBanner(false);
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

      {/* Write access banner — shown when index is connected but write is not ready */}
      <WriteAccessBanner
        folderStatus={folderStatus}
        onReauthorize={handleBannerReauthorize}
        isReauthing={reauthingBanner}
      />

      <div className="templates__content">
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
                  navigateTo('/documents');
                }}
              >
                Go to Legal Folder
              </a>
            </div>
          </div>
        )}

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

        {source && allTemplates.length > 0 && filtered.length === 0 && (
          <div className="templates__state">
            <span>🔍</span>
            <p>No templates match your search.</p>
            <button className="templates__btn templates__btn--secondary" onClick={() => { setSearch(''); setCategory('All'); }}>
              Clear filters
            </button>
          </div>
        )}

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
