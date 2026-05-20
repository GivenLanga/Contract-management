import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { renderDocxPreview } from '../../services/docxPreviewRenderer';
import { canRenderDocxPreview, getLegalFolderFile } from '../../services/legalFolderFileStore';
import { getSigningDocument, signDocument, subscribeToSigning } from '../../services/signingStore';
import { documents, signing as signingApi } from '../../services/api';
import { collectSigningClientEvidence } from '../../services/signingEvidenceClient';
import PdfDocumentPreview from './PdfDocumentPreview';
import SignatureModal from './SignatureModal';
import {
  PAGE_FALLBACK,
  SIGNATURE_FIELD_TYPES,
  VALUE_FIELD_TYPES,
  defaultFieldValue,
  fieldDisplayValue,
  fieldPercentStyle,
  fieldTypeConfig,
  pageMetric,
} from '../../services/signingFields';
import './SigningViewer.css';

const TEXT_PREVIEW_TYPES = new Set(['txt', 'md', 'csv', 'json']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

const isPdf = (doc, fileRecord) =>
  doc?.type === 'pdf' ||
  fileRecord?.mimeType === 'application/pdf';

const isImage = (doc, fileRecord) =>
  (IMAGE_TYPES.has(doc?.type) || fileRecord?.mimeType?.startsWith('image/'));

const isDocxPreview = (fileRecord, formattedPreview) =>
  fileRecord?.renderType === 'docx-preview' && Boolean(formattedPreview?.html);

const isTextPreview = (doc, previewText) =>
  Boolean(previewText) || TEXT_PREVIEW_TYPES.has(doc?.type);

const paragraphsFrom = (text) =>
  String(text || '')
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean);

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.5;
const DEFAULT_PAGE_METRICS = PAGE_FALLBACK;
const PREVIEW_LOG_PREFIX = '[SigningPreview]';
const isMongoId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));
const normalizedEmail = (value) => String(value || '').trim().toLowerCase();
const cssEscape = (value) => {
  if (typeof window !== 'undefined' && window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
};

const typeFromBlob = (doc, blob) => {
  const explicitType = String(doc?.type || '').toLowerCase();
  if (explicitType) return explicitType;
  const mimeType = blob?.type || '';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === DOCX_MIME) return 'docx';
  if (mimeType === DOC_MIME) return 'doc';
  const name = String(doc?.filename || doc?.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.doc')) return 'doc';
  return 'other';
};

const previewLog = (level, message, details = undefined) => {
  const logger = console[level] || console.log;
  if (details === undefined) logger(`${PREVIEW_LOG_PREFIX} ${message}`);
  else logger(`${PREVIEW_LOG_PREFIX} ${message}`, details);
};

const clampZoom = (value) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

const formatFileSize = (bytes) => {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
};

const isPageBreakNode = (node) =>
  node?.nodeType === 1 && node.hasAttribute('data-docx-page-break');

const isPageChromeNode = (node) =>
  node?.nodeType === 1 && node.classList?.contains('docx-page-chrome');

const pageHasContent = (page) =>
  page?.dataset?.docxExplicitPage === 'true' ||
  Array.from(page.childNodes).some((node) => {
    if (isPageBreakNode(node) || isPageChromeNode(node)) return false;
    if (node.nodeType === 3) return Boolean(node.textContent.trim());
    return true;
  });

const createDocxPage = (ownerDocument) => {
  const page = ownerDocument.createElement('article');
  page.className = 'docx-page';
  return page;
};

const markOverflowingPages = (root) => {
  Array.from(root.children).forEach((page) => {
    page.classList.remove('docx-page--overflowing');
    if (page.scrollHeight > page.clientHeight + 2) {
      page.classList.add('docx-page--overflowing');
    }
  });
};

const textChunks = (text) => {
  const chunks = [];
  let current = '';
  for (const token of String(text || '').match(/\S+\s*|\s+/g) || []) {
    if (current && (current + token).length > 120) {
      chunks.push(current);
      current = token;
    } else {
      current += token;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

const htmlSegmentsFromNode = (node) =>
  Array.from(node.childNodes || []).flatMap((child) => {
    if (child.nodeType === 3) {
      return textChunks(child.textContent).map((chunk) => {
        const span = node.ownerDocument.createElement('span');
        span.textContent = chunk;
        return span.innerHTML;
      });
    }

    if (child.nodeType !== 1) return [];

    const tag = child.tagName?.toLowerCase();
    const text = child.textContent || '';
    if ((tag === 'span' || tag === 'strong' || tag === 'em' || tag === 'a') && text.length > 160 && child.children.length === 0) {
      return textChunks(text).map((chunk) => {
        const clone = child.cloneNode(false);
        clone.textContent = chunk;
        return clone.outerHTML;
      });
    }

    return [child.outerHTML];
  });

const cloneBlockWithSegments = (node, segments) => {
  const clone = node.cloneNode(false);
  clone.innerHTML = segments.join('');
  return clone;
};

const canSplitBlock = (node) => {
  if (node?.nodeType !== 1) return false;
  const tag = node.tagName?.toLowerCase();
  return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) && (node.textContent || '').trim().length > 0;
};

const canSplitTable = (node) =>
  node?.nodeType === 1 && node.tagName?.toLowerCase() === 'table' && node.rows?.length > 1;

const canSplitSingleCellTable = (node) =>
  node?.nodeType === 1 &&
  node.tagName?.toLowerCase() === 'table' &&
  node.rows?.length === 1 &&
  node.rows[0]?.cells?.length === 1 &&
  node.rows[0].cells[0].childNodes.length > 1;

const nodeSummary = (node) => {
  if (!node) return 'unknown';
  if (node.nodeType === 3) return `text:${String(node.textContent || '').trim().slice(0, 40)}`;
  const tag = node.tagName?.toLowerCase() || node.localName || 'node';
  const className = node.className ? `.${String(node.className).trim().replace(/\s+/g, '.')}` : '';
  const text = String(node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return `${tag}${className}${text ? ` "${text}"` : ''}`;
};

const tableShellForRows = (table) => {
  const clone = table.cloneNode(false);
  const tbody = table.tBodies?.[0]?.cloneNode(false) || table.ownerDocument.createElement('tbody');
  clone.appendChild(tbody);
  return { table: clone, rowHost: tbody };
};

const singleCellTableShell = (table) => {
  const sourceRow = table.rows[0];
  const sourceCell = sourceRow.cells[0];
  const clone = table.cloneNode(false);
  const tbody = table.tBodies?.[0]?.cloneNode(false) || table.ownerDocument.createElement('tbody');
  const row = sourceRow.cloneNode(false);
  const cell = sourceCell.cloneNode(false);
  row.appendChild(cell);
  tbody.appendChild(row);
  clone.appendChild(tbody);
  return { table: clone, cell };
};

const paginateDocxPages = (root, sourceHtml) => {
  if (sourceHtml) root.innerHTML = sourceHtml;

  const originalPages = Array.from(root.children).filter((node) => node.classList?.contains('docx-page'));
  const nodes = originalPages.flatMap((page) =>
    Array.from(page.childNodes).filter((node) => !isPageChromeNode(node))
  );
  const diagnostics = {
    sourceHtmlLength: sourceHtml?.length || 0,
    sourcePageCount: originalPages.length,
    sourceNodeCount: nodes.length,
    explicitBreaks: 0,
    splitBlocks: 0,
    splitTables: 0,
    splitSingleCellTables: 0,
    unsplitOverflowNodes: [],
    outputPageCount: originalPages.length || 1,
    overflowingPages: 0,
  };
  if (!nodes.length) return { pageCount: originalPages.length || 1, diagnostics };

  root.textContent = '';

  let page = createDocxPage(root.ownerDocument);
  root.appendChild(page);

  const startNextPage = () => {
    page = createDocxPage(root.ownerDocument);
    root.appendChild(page);
  };

  const appendSplitBlock = (node) => {
    if (!canSplitBlock(node)) return false;

    const segments = htmlSegmentsFromNode(node);
    if (segments.length < 2) return false;

    let cursor = 0;
    while (cursor < segments.length) {
      const remaining = segments.length - cursor;
      const clone = cloneBlockWithSegments(node, []);
      page.appendChild(clone);

      let low = 1;
      let high = remaining;
      let best = 0;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        clone.innerHTML = segments.slice(cursor, cursor + mid).join('');
        if (page.scrollHeight <= page.clientHeight + 2) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (best === 0) {
        clone.innerHTML = segments[cursor] || '&nbsp;';
        cursor += 1;
      } else {
        clone.innerHTML = segments.slice(cursor, cursor + best).join('');
        cursor += best;
      }

      if (cursor < segments.length) startNextPage();
    }

    diagnostics.splitBlocks += 1;
    return true;
  };

  const appendSplitTable = (node) => {
    if (!canSplitTable(node)) return false;

    const rows = Array.from(node.rows);
    let cursor = 0;

    while (cursor < rows.length) {
      const hadPriorContent = pageHasContent(page);
      const { table, rowHost } = tableShellForRows(node);
      page.appendChild(table);

      let added = 0;
      while (cursor + added < rows.length) {
        const row = rows[cursor + added].cloneNode(true);
        rowHost.appendChild(row);

        if (page.scrollHeight > page.clientHeight + 2) {
          if (added === 0 && hadPriorContent) {
            page.removeChild(table);
            startNextPage();
            break;
          }

          if (added > 0) {
            rowHost.removeChild(row);
            break;
          }

          added = 1;
          break;
        }

        added += 1;
      }

      if (!table.isConnected) continue;
      if (added === 0) {
        page.removeChild(table);
        return false;
      }

      cursor += added;
      if (cursor < rows.length) startNextPage();
    }

    diagnostics.splitTables += 1;
    return true;
  };

  const appendSplitSingleCellTable = (node) => {
    if (!canSplitSingleCellTable(node)) return false;

    const sourceCell = node.rows[0].cells[0];
    const cellNodes = Array.from(sourceCell.childNodes || []).filter((child) =>
      child.nodeType !== 3 || Boolean(child.textContent.trim())
    );
    let cursor = 0;

    while (cursor < cellNodes.length) {
      const hadPriorContent = pageHasContent(page);
      const { table, cell } = singleCellTableShell(node);
      page.appendChild(table);

      let added = 0;
      while (cursor + added < cellNodes.length) {
        const child = cellNodes[cursor + added].cloneNode(true);
        cell.appendChild(child);

        if (page.scrollHeight > page.clientHeight + 2) {
          if (added === 0 && hadPriorContent) {
            page.removeChild(table);
            startNextPage();
            break;
          }

          if (added > 0) {
            cell.removeChild(child);
            break;
          }

          added = 1;
          break;
        }

        added += 1;
      }

      if (!table.isConnected) continue;
      if (added === 0) {
        page.removeChild(table);
        return false;
      }

      cursor += added;
      if (cursor < cellNodes.length) startNextPage();
    }

    diagnostics.splitSingleCellTables += 1;
    return true;
  };

  const appendAcrossPages = (node) => {
    if (appendSplitBlock(node) || appendSplitSingleCellTable(node) || appendSplitTable(node)) return;

    page.appendChild(node);
    if (page.scrollHeight > page.clientHeight + 2) {
      diagnostics.unsplitOverflowNodes.push(nodeSummary(node));
      startNextPage();
    }
  };

  nodes.forEach((node) => {
    if (isPageBreakNode(node)) {
      diagnostics.explicitBreaks += 1;
      page.appendChild(node);
      page.dataset.docxExplicitPage = 'true';
      startNextPage();
      return;
    }

    page.appendChild(node);
    if (page.scrollHeight > page.clientHeight + 2 && page.childNodes.length > 1) {
      page.removeChild(node);
      if (pageHasContent(page)) page.classList.remove('docx-page--overflowing');
      startNextPage();
      appendAcrossPages(node);
    } else if (page.scrollHeight > page.clientHeight + 2 && page.childNodes.length === 1) {
      page.removeChild(node);
      appendAcrossPages(node);
    }
  });

  Array.from(root.children).forEach((candidate) => {
    if (!pageHasContent(candidate) && root.children.length > 1) candidate.remove();
  });

  markOverflowingPages(root);
  diagnostics.outputPageCount = Array.from(root.children).filter(pageHasContent).length || 1;
  diagnostics.overflowingPages = Array.from(root.children).filter((node) =>
    node.classList?.contains('docx-page--overflowing')
  ).length;
  return { pageCount: diagnostics.outputPageCount, diagnostics };
};

const decorateDocxPages = (root, chrome) => {
  if (!root) return;
  Array.from(root.children).forEach((page) => {
    Array.from(page.querySelectorAll(':scope > .docx-page-chrome')).forEach((node) => node.remove());

    if (chrome?.headerHtml) {
      const header = root.ownerDocument.createElement('div');
      header.className = 'docx-page-chrome docx-header';
      header.innerHTML = chrome.headerHtml;
      page.appendChild(header);
    }

    if (chrome?.footerHtml) {
      const footer = root.ownerDocument.createElement('div');
      footer.className = 'docx-page-chrome docx-footer';
      footer.innerHTML = chrome.footerHtml;
      page.appendChild(footer);
    }
  });
};

export default function SigningViewer() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();

  const [revision, setRevision] = useState(0);
  const [signingField, setSigningField] = useState(null);
  const [signatureFocus, setSignatureFocus] = useState('signature');
  const [signatureDraft, setSignatureDraft] = useState(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [includeLocationEvidence, setIncludeLocationEvidence] = useState(false);
  const [captureMode, setCaptureMode] = useState('signature');
  const [submittingSignature, setSubmittingSignature] = useState(false);
  const [signingError, setSigningError] = useState('');
  const [certificateDownloading, setCertificateDownloading] = useState(false);
  const [certificateError, setCertificateError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState(() => (
    searchParams.get('panel') === 'activity' ? 'activity' : 'signers'
  ));
  const [success, setSuccess] = useState(false);
  const [fileRecord, setFileRecord] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [pdfBlob, setPdfBlob] = useState(null);
  const [previewText, setPreviewText] = useState('');
  const [formattedPreview, setFormattedPreview] = useState(null);
  const [fileLoading, setFileLoading] = useState(true);
  const [fileError, setFileError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState('fit-width');
  const [activePage, setActivePage] = useState(1);
  const [docxPages, setDocxPages] = useState([]);
  const [docxPageCount, setDocxPageCount] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(1);
  const [pdfPageMetrics, setPdfPageMetrics] = useState({ 1: PAGE_FALLBACK });
  const [fieldValues, setFieldValues] = useState({});
  const [remoteDoc, setRemoteDoc] = useState(null);
  const [remoteSignatures, setRemoteSignatures] = useState([]);
  const docxPagesRef = useRef(null);
  const previewShellRef = useRef(null);
  const previewScrollRef = useRef(null);
  const paginationRunRef = useRef(0);
  const localDoc = useMemo(() => {
    void revision;
    return getSigningDocument(docId);
  }, [docId, revision]);
  const doc = localDoc || remoteDoc;

  useEffect(() => subscribeToSigning(() => setRevision((value) => value + 1)), []);
  useEffect(() => {
    if (searchParams.get('panel') === 'activity') setActiveTab('activity');
  }, [searchParams]);
  useEffect(() => {
    setSignatureDraft(null);
    setConsentAccepted(false);
    setSigningError('');
    setSubmittingSignature(false);
  }, [docId]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    const loadFile = async () => {
      previewLog('info', 'Preview load started', { docId, revision });
      setFileLoading(true);
      setFileError('');
      setFileRecord(null);
      setPreviewUrl('');
      setPdfBlob(null);
      setPreviewText('');
      setFormattedPreview(null);
      setDocxPages([]);
      setDocxPageCount(1);
      setPdfPageCount(1);
      setPdfPageMetrics({ 1: PAGE_FALLBACK });
      setActivePage(1);
      setFitMode('fit-width');

      try {
        let knownDoc = localDoc;
        if (!knownDoc && isMongoId(docId)) {
          const data = await documents.get(docId);
          knownDoc = data.document;
          if (!cancelled) setRemoteDoc(data.document);
        }

        let record = await getLegalFolderFile(docId);
        if (!record?.blob && isMongoId(docId)) {
          const res = await fetch(documents.viewUrl(docId));
          if (res.ok) {
            const blob = await res.blob();
            record = {
              docId,
              name: knownDoc?.name || 'Document',
              type: typeFromBlob(knownDoc, blob),
              mimeType: blob.type,
              size: blob.size,
              blob,
            };
          }
        }
        if (!record?.blob) {
          previewLog('warn', 'No cached preview file found', { docId });
          if (!cancelled) {
            setFileError('Sync the Legal Folder again so the signing room can open the source file.');
          }
          return;
        }

        let renderType = record.type;
        let text = record.textContent || '';
        let docxPreview = null;
        let pdfPages = 1;
        previewLog('info', 'Preview file record loaded', {
          docId,
          name: record.name,
          type: record.type,
          mimeType: record.mimeType,
          size: record.size,
          canRenderDocx: canRenderDocxPreview(record),
        });

        if (canRenderDocxPreview(record)) {
          docxPreview = await renderDocxPreview(record.blob);
          renderType = 'docx-preview';
          text = '';
          previewLog('info', 'DOCX render completed', {
            docId,
            name: record.name,
            size: record.size,
            metrics: docxPreview.metrics,
            diagnostics: docxPreview.diagnostics,
          });
        } else if (isPdf({ type: record.type }, record)) {
          previewLog('info', 'PDF preview source loaded', {
            docId,
            name: record.name,
            size: record.size,
          });
        } else if (!text && TEXT_PREVIEW_TYPES.has(record.type)) {
          text = await record.blob.text();
        }

        objectUrl = URL.createObjectURL(record.blob);

        if (!cancelled) {
          setFileRecord({
            ...record,
            renderType,
          });
          setPreviewUrl(objectUrl);
          setPdfBlob(isPdf({ type: record.type }, record) ? record.blob : null);
          setPreviewText(text);
          setFormattedPreview(docxPreview);
          setPdfPageCount(pdfPages);
        }
      } catch (error) {
        previewLog('error', 'File preview load failed', {
          docId,
          message: error.message,
          stack: error.stack,
        });
        if (!cancelled) {
          setFileError(error.message || 'Could not preview this file.');
        }
      } finally {
        if (!cancelled) {
          setFileLoading(false);
        }
      }
    };

    loadFile();

    return () => {
      cancelled = true;
      previewLog('info', 'Preview load cleanup', { docId, hadObjectUrl: Boolean(objectUrl) });
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, revision, localDoc]);

  useLayoutEffect(() => {
    if (!formattedPreview?.html || !docxPagesRef.current) return undefined;

    let cancelled = false;
    const root = docxPagesRef.current;
    const frames = [];

    const schedulePagination = () => {
      frames.push(requestAnimationFrame(() => {
        if (cancelled || !root.isConnected) return;
        const runId = paginationRunRef.current + 1;
        paginationRunRef.current = runId;
        const before = {
          childCount: root.children.length,
          htmlLength: root.innerHTML.length,
          scrollHeight: root.scrollHeight,
        };
        const result = paginateDocxPages(root, formattedPreview.html);
        decorateDocxPages(root, formattedPreview.chrome);
        const renderedPages = Array.from(root.querySelectorAll(':scope > .docx-page'));
        setDocxPages(renderedPages.map((page) => page.innerHTML));
        const after = {
          childCount: root.children.length,
          htmlLength: root.innerHTML.length,
          scrollHeight: root.scrollHeight,
        };
        previewLog('info', 'DOCX pagination pass', {
          runId,
          docId,
          zoom,
          before,
          after,
          diagnostics: result.diagnostics,
        });
        if (result.diagnostics.outputPageCount <= result.diagnostics.sourcePageCount && result.diagnostics.overflowingPages > 0) {
          previewLog('warn', 'DOCX pagination still has oversized source-page-like output', result.diagnostics);
        }
        requestAnimationFrame(() => {
          if (!root.isConnected) return;
          const livePageCount = root.querySelectorAll(':scope > .docx-page').length;
          if (livePageCount !== result.pageCount) {
            previewLog('warn', 'DOCX page DOM count changed after pagination', {
              runId,
              expected: result.pageCount,
              livePageCount,
              htmlLength: root.innerHTML.length,
            });
          }
        });
        setDocxPageCount(result.pageCount);
      }));
    };

    schedulePagination();
    document.fonts?.ready?.then(schedulePagination);

    return () => {
      cancelled = true;
      frames.forEach((frame) => cancelAnimationFrame(frame));
    };
  }, [docId, formattedPreview?.html, formattedPreview?.chrome, zoom]);

  useEffect(() => {
    if (localDoc || !isMongoId(docId)) return undefined;
    let cancelled = false;
    documents.get(docId)
      .then((data) => { if (!cancelled) setRemoteDoc(data.document); })
      .catch(() => { if (!cancelled) setRemoteDoc(null); });
    return () => { cancelled = true; };
  }, [docId, revision, localDoc]);

  useEffect(() => {
    if (localDoc || !isMongoId(docId)) {
      setRemoteSignatures([]);
      return undefined;
    }
    let cancelled = false;
    signingApi.getSignatures(docId)
      .then((data) => { if (!cancelled) setRemoteSignatures(data.signatures || []); })
      .catch(() => { if (!cancelled) setRemoteSignatures([]); });
    return () => { cancelled = true; };
  }, [docId, revision, localDoc]);

  const signatures = useMemo(() => (
    localDoc
      ? (doc?.signatures || [])
      : (remoteSignatures.length ? remoteSignatures : (doc?.signatures || []))
  ), [doc?.signatures, localDoc, remoteSignatures]);
  const auditLogs = doc?.auditLogs || [];
  const signerIdentity = useMemo(
    () => ({ name: user?.name || user?.email || '', email: user?.email || '' }),
    [user?.email, user?.name],
  );
  const allowUnassignedSignerFields = !doc?.signers?.length || doc.signers.length <= 1;
  const signerFields = useMemo(
    () => (doc?.signingFields || []).filter((field) => (
      normalizedEmail(field.assignedTo) === normalizedEmail(user?.email) ||
      (allowUnassignedSignerFields && !field.assignedTo)
    )),
    [allowUnassignedSignerFields, doc?.signingFields, user?.email],
  );
  const myPendingSignatureField = signerFields.find(
    (field) => field.type === 'signature' && !field.filled
  );
  const myPendingInitialsField = signerFields.find(
    (field) => field.type === 'initials' && !field.filled
  );
  const hasSigned = user?.email
    ? signatures.some((signature) => normalizedEmail(signature.signerEmail) === normalizedEmail(user.email))
    : false;
  const allSigned = doc?.signingFields?.length > 0
    ? doc.signingFields.every((field) => field.filled)
    : signatures.length > 0 && doc?.status === 'Signed';
  const signingMode = searchParams.get('mode') === 'sign';
  const canSign = Boolean(signingMode && doc && !hasSigned && !allSigned && (myPendingSignatureField || !doc.signingFields?.length));
  const totalFields = doc?.signingFields?.length || 0;
  const completedFields = doc?.signingFields?.filter((field) => field.filled).length || 0;
  const fieldProgress = totalFields > 0 ? Math.round((completedFields / totalFields) * 100) : (hasSigned ? 100 : 0);
  const myRequiredFields = signerFields.filter((field) => field.required);
  const previewKind = isPdf(doc, fileRecord)
    ? 'pdf'
    : isImage(doc, fileRecord)
      ? 'image'
      : isDocxPreview(fileRecord, formattedPreview)
        ? 'docx'
        : isTextPreview(doc, previewText)
          ? 'text'
          : 'other';

  useEffect(() => {
    const root = docxPagesRef.current;
    if (!root || previewKind !== 'docx') return undefined;

    const observer = new MutationObserver(() => {
      const livePageCount = root.querySelectorAll(':scope > .docx-page').length;
      if (livePageCount > 0 && livePageCount <= (formattedPreview?.diagnostics?.sourcePageCount || 0)) {
        previewLog('warn', 'DOCX pages container mutation left only source page count visible', {
          livePageCount,
          sourcePageCount: formattedPreview?.diagnostics?.sourcePageCount,
          htmlLength: root.innerHTML.length,
        });
      }
    });

    observer.observe(root, { childList: true });
    return () => observer.disconnect();
  }, [previewKind, formattedPreview?.diagnostics?.sourcePageCount]);

  const sourcePageCount = formattedPreview
    ? (formattedPreview.html.match(/class="docx-page"/g)?.length ?? 1)
    : 1;
  const pageCount = previewKind === 'pdf'
    ? pdfPageCount
    : formattedPreview
      ? Math.max(docxPageCount, sourcePageCount)
      : 1;
  const pageStatus = previewKind === 'pdf'
    ? `Page ${Math.min(activePage, pageCount)} of ${pageCount}`
    : `Page ${Math.min(activePage, pageCount)} of ${pageCount}`;
  const fileSizeLabel = formatFileSize(fileRecord?.size || doc?.size);
  const previewTypeLabel = previewKind === 'docx'
    ? 'DOCX preview'
    : previewKind === 'pdf'
      ? 'PDF preview'
      : previewKind === 'text'
        ? 'Text preview'
        : previewKind === 'image'
      ? 'Image preview'
      : doc?.type ? `${doc.type.toUpperCase()} file` : 'File preview';

  const handlePdfLoad = useCallback(({ pageCount: loadedPageCount, pageMetrics }) => {
    setPdfPageCount(Math.max(1, loadedPageCount || 1));
    setPdfPageMetrics(Object.keys(pageMetrics || {}).length ? pageMetrics : { 1: PAGE_FALLBACK });
  }, []);

  const updateFieldValue = (fieldId, value) => {
    setSigningError('');
    setFieldValues((current) => ({ ...current, [fieldId]: value }));
  };

  const fieldIsMine = (field) => (
    normalizedEmail(field.assignedTo) === normalizedEmail(user?.email) ||
    (allowUnassignedSignerFields && !field.assignedTo)
  );
  const valueFieldComplete = (field, value) => {
    if (field.type === 'checkbox' || field.type === 'radio') return value === true || value === 'true';
    return String(value ?? '').trim().length > 0;
  };
  const valueFieldDisplay = (field, value) => {
    if (field.type === 'checkbox' || field.type === 'radio') return value === true || value === 'true' ? '✓' : '';
    return String(value ?? '').trim();
  };

  const draftHasSignature = Boolean(signatureDraft?.signatureData);
  const draftHasInitials = !myPendingInitialsField || Boolean(signatureDraft?.initialsData);
  const draftReadyToSend = draftHasSignature && draftHasInitials;

  const signatureForField = (field) => {
    if (!field) return null;
    const fieldEmail = normalizedEmail(field.filledBy || field.assignedTo);
    return signatures.find((signature) => (
      (field.type === 'signature' && signature.fieldId && signature.fieldId === field.id) ||
      (fieldEmail && normalizedEmail(signature.signerEmail) === fieldEmail) ||
      (!fieldEmail && field.assignedTo && normalizedEmail(signature.signerEmail) === normalizedEmail(field.assignedTo))
    )) || null;
  };
  const draftImageForField = (field) => {
    if (!signatureDraft || field.filled || !fieldIsMine(field)) return '';
    if (field.type === 'signature') return signatureDraft.signatureData;
    if (field.type === 'initials') return signatureDraft.initialsData;
    return '';
  };
  const imageForField = (field) => {
    const draftImage = draftImageForField(field);
    if (draftImage) return draftImage;
    if (!field.filled) return '';
    const signature = signatureForField(field);
    return field.type === 'initials' ? signature?.initialsData : signature?.signatureData;
  };

  const fieldIsComplete = (field) => {
    if (field.filled) return true;
    if (SIGNATURE_FIELD_TYPES.has(field.type)) return Boolean(draftImageForField(field));
    if (VALUE_FIELD_TYPES.has(field.type)) {
      return valueFieldComplete(field, fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity));
    }
    return false;
  };
  const missingRequiredField = myRequiredFields.find((field) => !fieldIsComplete(field)) || null;
  const allRequiredFieldsComplete = myRequiredFields.every(fieldIsComplete);
  const myCompletedRequiredFields = myRequiredFields.filter(fieldIsComplete).length;
  const myRequiredProgress = myRequiredFields.length
    ? Math.round((myCompletedRequiredFields / myRequiredFields.length) * 100)
    : (hasSigned ? 100 : 0);

  const openSignatureModal = (field = myPendingSignatureField, focus = 'signature') => {
    const targetField = field?.type === 'signature' ? field : myPendingSignatureField;
    setSigningError('');
    setSignatureFocus(focus);
    setCaptureMode(focus === 'initials' ? 'initials' : 'signature');
    setSigningField(targetField || null);
    setShowModal(true);
  };

  const openField = (field) => {
    if (!fieldIsMine(field) || field.filled || (!canSign && !signatureDraft)) return;
    if (field.type === 'signature') {
      openSignatureModal(field, 'signature');
    } else if (field.type === 'initials') {
      openSignatureModal(field, 'initials');
    }
  };

  const scrollToField = (field) => {
    if (!field?.id) return;
    const target = previewScrollRef.current?.querySelector(`[data-sv-field-id="${cssEscape(field.id)}"]`);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    window.setTimeout(() => {
      const focusTarget = target.matches('button, input, select, textarea')
        ? target
        : target.querySelector('button, input, select, textarea');
      focusTarget?.focus?.({ preventScroll: true });
    }, 240);
  };

  const handleNextRequiredField = () => {
    setSuccess(false);
    setSigningError('');
    if (!missingRequiredField) {
      if (!signatureDraft) openSignatureModal(myPendingSignatureField, 'signature');
      return;
    }

    scrollToField(missingRequiredField);
    if (SIGNATURE_FIELD_TYPES.has(missingRequiredField.type)) {
      window.setTimeout(() => openField(missingRequiredField), 280);
    }
  };

  const renderSigningField = (field, metric) => {
    const cfg = fieldTypeConfig(field.type);
    const isMine = fieldIsMine(field);
    const draftImage = imageForField(field);
    const editable = canSign && isMine && !field.filled;
    const canEditDraft = Boolean(signatureDraft && isMine && !field.filled && SIGNATURE_FIELD_TYPES.has(field.type));
    const isMissingRequired = Boolean(signingMode && field.required && isMine && !fieldIsComplete(field));
    const value = fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity);
    const className = [
      'sv-doc-field',
      `sv-doc-field--${field.type}`,
      field.filled ? 'sv-doc-field--filled' : '',
      draftImage && !field.filled ? 'sv-doc-field--preview' : '',
      editable ? 'sv-doc-field--editable' : '',
      canEditDraft ? 'sv-doc-field--editable' : '',
      isMine ? 'sv-doc-field--mine' : '',
      isMissingRequired ? 'sv-doc-field--missing' : '',
    ].filter(Boolean).join(' ');

    if (VALUE_FIELD_TYPES.has(field.type) && editable) {
      const common = {
        className,
        style: fieldPercentStyle(field, metric),
        'data-sv-field-id': field.id,
        'aria-label': `${cfg.label}${field.required ? ' required' : ''}`,
      };
      if (field.type === 'checkbox' || field.type === 'radio') {
        return (
          <label key={field.id} {...common}>
            <input
              type="checkbox"
              checked={value === true || value === 'true'}
              onChange={(event) => updateFieldValue(field.id, event.target.checked)}
            />
          </label>
        );
      }
      return (
        <label key={field.id} {...common}>
          <input
            type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
            value={value ?? ''}
            required={field.required}
            placeholder={cfg.label}
            onChange={(event) => updateFieldValue(field.id, event.target.value)}
          />
        </label>
      );
    }

    if (VALUE_FIELD_TYPES.has(field.type)) {
      const displayValue = field.filled
        ? fieldDisplayValue(field)
        : valueFieldDisplay(field, value);
      return (
        <div
          key={field.id}
          className={className}
          style={fieldPercentStyle(field, metric)}
          data-sv-field-id={field.id}
          aria-label={`${cfg.label}${field.required ? ' required' : ''}`}
        >
          {displayValue || cfg.label}
          {field.required && !field.filled && !displayValue && <span>*</span>}
        </div>
      );
    }

    return (
      <button
        key={field.id}
        type="button"
        className={className}
        style={fieldPercentStyle(field, metric)}
        data-sv-field-id={field.id}
        onClick={() => openField(field)}
        disabled={(!editable && !canEditDraft) || !SIGNATURE_FIELD_TYPES.has(field.type)}
        title={field.filled ? `${cfg.label} complete` : cfg.label}
      >
        {draftImage ? (
          <img src={draftImage} alt={field.type === 'initials' ? 'Initials' : 'Signature'} className="sv-doc-field-img" />
        ) : (
          field.filled ? (fieldDisplayValue(field) || 'Done') : cfg.label
        )}
        {field.required && !field.filled && !draftImage && <span>*</span>}
      </button>
    );
  };

  const renderPdfFieldOverlay = ({ pageNumber, width, height }) => {
    const pageFields = (doc?.signingFields || []).filter((field) => Number(field.page || 1) === pageNumber);
    if (!pageFields.length) return null;
    const metric = { width, height };
    return (
      <div className="sv-field-layer">
        {pageFields.map((field) => renderSigningField(field, metric))}
      </div>
    );
  };

  useEffect(() => {
    if (!doc?.signingFields?.length) {
      setFieldValues((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    setFieldValues((current) => {
      const next = { ...current };
      let changed = false;
      for (const field of doc.signingFields) {
        if (!VALUE_FIELD_TYPES.has(field.type)) continue;
        if (!Object.prototype.hasOwnProperty.call(next, field.id)) {
          next[field.id] = defaultFieldValue(field, signerIdentity);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [doc?.signingFields, signerIdentity]);

  const setZoomToFit = useCallback((mode) => {
    setFitMode(mode);
    if (!['pdf', 'docx', 'text'].includes(previewKind)) return;

    const shellRect = previewShellRef.current?.getBoundingClientRect();
    if (!shellRect?.width || !shellRect?.height) return;

    const metrics = previewKind === 'pdf'
      ? pageMetric(pdfPageMetrics, activePage)
      : formattedPreview?.metrics || DEFAULT_PAGE_METRICS;
    const pageWidth = metrics.width || DEFAULT_PAGE_METRICS.width;
    const pageHeight = metrics.height || metrics.minHeight || DEFAULT_PAGE_METRICS.height;
    const availableWidth = Math.max(240, shellRect.width - 96);
    const availableHeight = Math.max(240, shellRect.height - 64);
    const nextZoom = mode === 'fit-page'
      ? Math.min(availableWidth / pageWidth, availableHeight / pageHeight)
      : availableWidth / pageWidth;

    setZoom(clampZoom(nextZoom));
  }, [activePage, formattedPreview?.metrics, pdfPageMetrics, previewKind]);

  const adjustZoom = (delta) => {
    setFitMode('custom');
    setZoom((z) => clampZoom(z + delta));
  };

  useEffect(() => {
    if (!['pdf', 'docx', 'text'].includes(previewKind) || !previewShellRef.current) return undefined;
    const frame = requestAnimationFrame(() => setZoomToFit('fit-width'));
    return () => cancelAnimationFrame(frame);
  }, [docId, previewKind, formattedPreview?.html, previewText, setZoomToFit]);

  useEffect(() => {
    if (fitMode === 'custom' || !['pdf', 'docx', 'text'].includes(previewKind)) return undefined;
    const shell = previewShellRef.current;
    if (!shell) return undefined;
    const observer = new ResizeObserver(() => setZoomToFit(fitMode));
    observer.observe(shell);
    return () => observer.disconnect();
  }, [fitMode, previewKind, formattedPreview?.metrics?.width, formattedPreview?.metrics?.height, setZoomToFit]);

  useEffect(() => {
    const scroller = previewScrollRef.current;
    if (!scroller || !['pdf', 'docx', 'text'].includes(previewKind)) return undefined;

    let frame = 0;
    const updateVisiblePage = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const pages = Array.from(scroller.querySelectorAll('.pdf-preview-page, .sv-docx-page-shell, .sv-document-page'));
        if (!pages.length) {
          setActivePage(1);
          return;
        }

        const box = scroller.getBoundingClientRect();
        const viewportLine = box.top + Math.min(box.height * 0.42, 360);
        let bestPage = 1;
        let bestDistance = Number.POSITIVE_INFINITY;

        pages.forEach((page, index) => {
          const rect = page.getBoundingClientRect();
          const distance = viewportLine < rect.top
            ? rect.top - viewportLine
            : viewportLine > rect.bottom
              ? viewportLine - rect.bottom
              : 0;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestPage = index + 1;
          }
        });

        setActivePage(bestPage);
      });
    };

    updateVisiblePage();
    scroller.addEventListener('scroll', updateVisiblePage, { passive: true });
    window.addEventListener('resize', updateVisiblePage);

    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', updateVisiblePage);
      window.removeEventListener('resize', updateVisiblePage);
    };
  }, [previewKind, docxPageCount, pdfPageCount, formattedPreview?.html, zoom, previewText]);

  const wordCount = useMemo(() => {
    if (formattedPreview?.html) {
      return formattedPreview.html.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    }
    if (previewText) return previewText.trim().split(/\s+/).filter(Boolean).length;
    return 0;
  }, [formattedPreview, previewText]);

  const valuesForSubmission = () => {
    const valuesForSubmission = {};
    signerFields.forEach((field) => {
      if (VALUE_FIELD_TYPES.has(field.type) && !field.filled) {
        const value = fieldValues[field.id] ?? defaultFieldValue(field, signerIdentity);
        if (field.required || valueFieldComplete(field, value)) {
          valuesForSubmission[field.id] = value;
        }
      }
    });
    return valuesForSubmission;
  };

  const handleSignComplete = async (payload) => {
    setSignatureDraft((current) => ({
      ...(current || {}),
      ...payload,
      fieldId: payload.fieldId || current?.fieldId,
      page: payload.page || current?.page,
      position: payload.position || current?.position,
      method: payload.method || current?.method,
      signerRole: payload.signerRole || current?.signerRole,
      signatureTelemetry: payload.signatureTelemetry || current?.signatureTelemetry,
    }));
    setSigningError('');
    setSuccess(false);
    setShowModal(false);
    setActiveTab('signers');
  };

  const submitSignatureDraft = async () => {
    if (!signatureDraft?.signatureData) {
      setSigningError('Add your signature before sending.');
      return;
    }
    if (!draftHasInitials) {
      setSigningError('Add your initials before sending.');
      return;
    }
    if (!allRequiredFieldsComplete) {
      setSigningError('Complete all required fields on the document before sending.');
      if (missingRequiredField) scrollToField(missingRequiredField);
      return;
    }
    if (!consentAccepted) {
      setSigningError('Accept electronic signature consent before sending.');
      return;
    }

    setSubmittingSignature(true);
    setSigningError('');
    try {
      const clientEvidence = await collectSigningClientEvidence({
        scope: `${docId}:${user?.email || 'signer'}`,
        includeLocation: includeLocationEvidence,
      });
      const signingPayload = {
        ...signatureDraft,
        fieldValues: valuesForSubmission(),
        consentAccepted,
        clientEvidence,
      };
      if (isMongoId(docId) && remoteDoc) {
        const result = await signingApi.sign(docId, signingPayload);
        if (result?.signature) {
          setRemoteSignatures((current) => [
            ...current.filter((signature) => signature._id !== result.signature._id),
            result.signature,
          ]);
        }
        const refreshed = await documents.get(docId);
        setRemoteDoc(refreshed.document);
      } else {
        signDocument(docId, signingPayload, user);
      }
      setSignatureDraft(null);
      setConsentAccepted(false);
      setIncludeLocationEvidence(false);
      setSuccess(true);
      setRevision((value) => value + 1);
    } catch (err) {
      setSigningError(err.message || 'Unable to send the signed document.');
    } finally {
      setSubmittingSignature(false);
    }
  };

  const primarySigningLabel = (() => {
    if (submittingSignature) return 'Sending...';
    if (!signatureDraft) return missingRequiredField ? 'Next Required Field' : 'Sign This Document';
    if (!draftReadyToSend) return !draftHasInitials ? 'Add Initials' : 'Add Signature';
    if (!allRequiredFieldsComplete) return 'Next Required Field';
    return 'Send Signed Document';
  })();
  const primarySigningVerb = signatureDraft && draftReadyToSend && allRequiredFieldsComplete ? 'Send' : 'Next';
  const primarySigningDisabled = Boolean(
    submittingSignature ||
    (signatureDraft && draftReadyToSend && allRequiredFieldsComplete && !consentAccepted)
  );
  const handlePrimarySigningAction = () => {
    if (!signatureDraft) {
      if (missingRequiredField) handleNextRequiredField();
      else openSignatureModal(myPendingSignatureField, 'signature');
      return;
    }
    if (!draftReadyToSend) {
      openSignatureModal(!draftHasInitials && myPendingInitialsField ? myPendingInitialsField : myPendingSignatureField, !draftHasInitials ? 'initials' : 'signature');
      return;
    }
    if (!allRequiredFieldsComplete) {
      handleNextRequiredField();
      return;
    }
    submitSignatureDraft();
  };

  const formatTime = (date) => {
    const parsed = new Date(date);
    if (!Number.isFinite(parsed.getTime())) return '-';
    return parsed.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  };
  const compactHash = (hash) => {
    const value = String(hash || '').trim();
    if (!value) return '-';
    if (value.length <= 24) return value;
    return `${value.slice(0, 12)}...${value.slice(-8)}`;
  };
  const downloadBlobFile = (filename, blob) => {
    const url = window.URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = filename;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };
  const handleDownloadCertificate = async () => {
    if (!isMongoId(docId)) {
      setCertificateError('The Certificate of Completion is available after server finalization.');
      return;
    }
    setCertificateDownloading(true);
    setCertificateError('');
    try {
      const result = await signingApi.completionCertificate(docId);
      if (!result?.blob) throw new Error('Certificate download failed.');
      const baseName = String(doc?.name || 'document').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
      downloadBlobFile(result.filename || `${baseName}_certificate_of_completion.pdf`, result.blob);
    } catch (error) {
      setCertificateError(error.message || 'Could not download the Certificate of Completion.');
    } finally {
      setCertificateDownloading(false);
    }
  };
  const signerRows = useMemo(() => {
    const fields = doc?.signingFields || [];
    const signatureByEmail = new Map(
      signatures
        .filter((signature) => signature.signerEmail)
        .map((signature) => [normalizedEmail(signature.signerEmail), signature])
    );
    const fieldsByEmail = new Map();
    const unassignedFields = [];

    fields.forEach((field) => {
      const email = normalizedEmail(field.assignedTo);
      if (!email) {
        unassignedFields.push(field);
        return;
      }
      if (!fieldsByEmail.has(email)) fieldsByEmail.set(email, []);
      fieldsByEmail.get(email).push(field);
    });

    const rows = (doc?.signers || []).map((signer) => {
      const email = normalizedEmail(signer.email);
      const signerFieldsForEmail = fieldsByEmail.get(email) || [];
      const signature = signatureByEmail.get(email);
      const completedFieldsForEmail = signerFieldsForEmail.filter((field) => field.filled).length;
      return {
        key: email || signer._id || signer.name || signer.role,
        name: signature?.signerName || signer.name || signer.email || 'Signer',
        email: signer.email || '',
        role: signer.role || 'Signatory',
        isMe: email && email === normalizedEmail(user?.email),
        signed: signer.signingStatus === 'signed' || Boolean(signature) || (signerFieldsForEmail.length > 0 && completedFieldsForEmail === signerFieldsForEmail.length),
        signedAt: signer.signedAt || signature?.signedAt || signerFieldsForEmail.find((field) => field.filled)?.filledAt,
        fieldCount: signerFieldsForEmail.length,
        completedFields: completedFieldsForEmail,
      };
    });

    fieldsByEmail.forEach((signerFieldsForEmail, email) => {
      if (rows.some((row) => normalizedEmail(row.email) === email)) return;
      const signature = signatureByEmail.get(email);
      const completedFieldsForEmail = signerFieldsForEmail.filter((field) => field.filled).length;
      rows.push({
        key: email,
        name: signature?.signerName || signerFieldsForEmail[0]?.assignedTo || 'Signer',
        email,
        role: signerFieldsForEmail[0]?.role || signature?.signerRole || 'Signatory',
        isMe: email === normalizedEmail(user?.email),
        signed: Boolean(signature) || completedFieldsForEmail === signerFieldsForEmail.length,
        signedAt: signature?.signedAt || signerFieldsForEmail.find((field) => field.filled)?.filledAt,
        fieldCount: signerFieldsForEmail.length,
        completedFields: completedFieldsForEmail,
      });
    });

    if (unassignedFields.length) {
      const completedFieldsForEmail = unassignedFields.filter((field) => field.filled).length;
      rows.push({
        key: 'unassigned',
        name: 'Any signer',
        email: '',
        role: unassignedFields[0]?.role || 'Signatory',
        isMe: allowUnassignedSignerFields,
        signed: completedFieldsForEmail === unassignedFields.length,
        signedAt: unassignedFields.find((field) => field.filled)?.filledAt,
        fieldCount: unassignedFields.length,
        completedFields: completedFieldsForEmail,
      });
    }

    if (!rows.length && signatures.length) {
      return signatures.map((signature) => ({
        key: signature._id || signature.signerEmail,
        name: signature.signerName || signature.signerEmail || 'Signer',
        email: signature.signerEmail || '',
        role: signature.signerRole || 'Signatory',
        isMe: normalizedEmail(signature.signerEmail) === normalizedEmail(user?.email),
        signed: true,
        signedAt: signature.signedAt,
        fieldCount: 0,
        completedFields: 0,
      }));
    }

    return rows;
  }, [allowUnassignedSignerFields, doc?.signers, doc?.signingFields, signatures, user?.email]);
  const finalization = doc?.finalization || {};
  const finalizationComplete = finalization.status === 'finalized';
  const canDownloadCertificate = isMongoId(docId) && (doc?.status === 'Signed' || finalizationComplete);
  const returnTo = location.state?.returnTo;
  const handleBack = () => {
    if (returnTo) {
      navigate(returnTo);
      return;
    }
    if (typeof window !== 'undefined' && window.history.length > 1 && location.key !== 'default') {
      navigate(-1);
      return;
    }
    navigate('/signing');
  };

  if (!doc) {
    return (
      <div className="sv-error">
        <h2>Document not found</h2>
        <p>Sync the Legal Folder, then open this signing room again.</p>
        <button onClick={handleBack}>Back to {location.state?.returnLabel || 'Signing'}</button>
      </div>
    );
  }

  const docType = doc.type ? `${doc.type.toUpperCase()} document` : 'Shared folder document';
  const previewParagraphs = paragraphsFrom(previewText);

  return (
    <div className="sv-root">
      <div className="sv-topbar">
        <button className="sv-back" onClick={handleBack}>
          Back
        </button>
        <div className="sv-topbar-doc">
          <span className="sv-topbar-icon">📄</span>
          <div>
            <div className="sv-topbar-title">{doc.name}</div>
            <div className="sv-topbar-meta">
              {doc.contract?.title && <span>{doc.contract.title} · </span>}
              Source: {doc.sourcePath || 'Legal Folder'}
            </div>
          </div>
        </div>
        <div className="sv-topbar-status">
          <span className={`sv-status-pill sv-status--${doc.status?.toLowerCase().replace(/\s+/g, '-')}`}>
            {doc.status}
          </span>
          {allSigned && <span className="sv-all-signed-badge">Fully Executed</span>}
        </div>
        {previewUrl && (
          <div className="sv-topbar-actions">
            <a className="sv-btn sv-btn--outline" href={previewUrl} target="_blank" rel="noreferrer">
              Open File
            </a>
          </div>
        )}
      </div>

      {success && (
        <div className="sv-success-banner">
          Your signature has been recorded in the signing audit trail.
          <button onClick={() => setSuccess(false)}>x</button>
        </div>
      )}

      {allSigned && doc.status === 'Signed' && (
        <div className="sv-completed-banner">
          This document has been fully signed by all required parties.
        </div>
      )}

      <div className="sv-body">
        <div className="sv-doc-panel">
          <div className="sv-preview-toolbar" role="toolbar" aria-label="Document preview controls">
            <div className="sv-preview-toolbar__meta" aria-live="polite">
              <strong>{previewTypeLabel}</strong>
              {!fileLoading && !fileError && <span>{pageStatus}</span>}
              {wordCount > 0 && <span>{wordCount.toLocaleString()} words</span>}
              {fileSizeLabel && <span>{fileSizeLabel}</span>}
            </div>
            <div className="sv-preview-toolbar__actions">
              <button
                type="button"
                className={`sv-tool-btn${fitMode === 'fit-width' ? ' sv-tool-btn--active' : ''}`}
                onClick={() => setZoomToFit('fit-width')}
                disabled={fileLoading || Boolean(fileError) || previewKind === 'image' || previewKind === 'other'}
                aria-pressed={fitMode === 'fit-width'}
              >
                Fit width
              </button>
              <button
                type="button"
                className={`sv-tool-btn${fitMode === 'fit-page' ? ' sv-tool-btn--active' : ''}`}
                onClick={() => setZoomToFit('fit-page')}
                disabled={fileLoading || Boolean(fileError) || previewKind === 'image' || previewKind === 'other'}
                aria-pressed={fitMode === 'fit-page'}
              >
                Fit page
              </button>
              <div className="sv-zoom-control" aria-label="Zoom controls">
                <button
                  type="button"
                  className="sv-icon-btn"
                  onClick={() => adjustZoom(-0.1)}
                  disabled={fileLoading || Boolean(fileError) || previewKind === 'image' || previewKind === 'other'}
                  aria-label="Zoom out"
                >
                  −
                </button>
                <input
                  type="range"
                  className="sv-zoom-slider"
                  min={Math.round(ZOOM_MIN * 100)}
                  max={Math.round(ZOOM_MAX * 100)}
                  step={5}
                  value={Math.round(zoom * 100)}
                  onChange={(e) => {
                    setFitMode('custom');
                    setZoom(clampZoom(Number(e.target.value) / 100));
                  }}
                  disabled={fileLoading || Boolean(fileError) || previewKind === 'image' || previewKind === 'other'}
                  aria-label="Zoom percentage"
                />
                <button
                  type="button"
                  className="sv-icon-btn"
                  onClick={() => adjustZoom(0.1)}
                  disabled={fileLoading || Boolean(fileError) || previewKind === 'image' || previewKind === 'other'}
                  aria-label="Zoom in"
                >
                  +
                </button>
                <span className="sv-zoom-value">{Math.round(zoom * 100)}%</span>
              </div>
            </div>
          </div>

          <div className="sv-preview-shell" ref={previewShellRef}>
            {fileLoading ? (
              <div className="sv-file-loading">
                <div className="sv-spinner" />
                <p>Opening document...</p>
              </div>
            ) : fileError ? (
              <div className="sv-doc-placeholder">
                <div className="sv-doc-placeholder-icon">📝</div>
                <h3>{doc.name}</h3>
                <p>{fileError}</p>
                <div className="sv-source-card">
                  <span>Legal Folder path</span>
                  <strong>{doc.sourcePath || doc.name}</strong>
                </div>
              </div>
            ) : previewKind === 'pdf' ? (
              <div className="sv-pdf-preview" ref={previewScrollRef}>
                <PdfDocumentPreview
                  blob={pdfBlob}
                  zoom={zoom}
                  className="sv-pdf-document"
                  pageClassName="sv-pdf-page"
                  onDocumentLoad={handlePdfLoad}
                  renderOverlay={renderPdfFieldOverlay}
                />
              </div>
            ) : previewKind === 'image' ? (
              <div className="sv-image-preview">
                <img src={previewUrl} alt={doc.name} />
              </div>
            ) : previewKind === 'docx' ? (
              <div className="sv-docx-preview" ref={previewScrollRef}>
                <div
                  ref={docxPagesRef}
                  className="sv-docx-pages sv-docx-pages--measure"
                  data-docx-source-pages={sourcePageCount}
                  style={{
                    '--docx-page-width': `${formattedPreview.metrics.width}px`,
                    '--docx-page-height': `${formattedPreview.metrics.height || formattedPreview.metrics.minHeight}px`,
                    '--docx-page-min-height': `${formattedPreview.metrics.minHeight}px`,
                    '--docx-margin-top': `${formattedPreview.metrics.marginTop}px`,
                    '--docx-margin-right': `${formattedPreview.metrics.marginRight}px`,
                    '--docx-margin-bottom': `${formattedPreview.metrics.marginBottom}px`,
                    '--docx-margin-left': `${formattedPreview.metrics.marginLeft}px`,
                    fontFamily: formattedPreview.metrics.fontFamily,
                  }}
                />
                <div className="sv-docx-rendered-pages" style={{ zoom }}>
                  {(docxPages.length ? docxPages : [formattedPreview.html]).map((pageHtml, index) => {
                    const pageNumber = index + 1;
                    const metric = formattedPreview.metrics || PAGE_FALLBACK;
                    return (
                      <div
                        key={pageNumber}
                        className="sv-docx-page-shell"
                        data-sv-page-number={pageNumber}
                        style={{
                          '--docx-page-width': `${metric.width}px`,
                          '--docx-page-height': `${metric.height || metric.minHeight}px`,
                          '--docx-page-min-height': `${metric.minHeight}px`,
                          '--docx-margin-top': `${metric.marginTop}px`,
                          '--docx-margin-right': `${metric.marginRight}px`,
                          '--docx-margin-bottom': `${metric.marginBottom}px`,
                          '--docx-margin-left': `${metric.marginLeft}px`,
                          fontFamily: metric.fontFamily,
                        }}
                      >
                        <article
                          className="docx-page"
                          dangerouslySetInnerHTML={{ __html: pageHtml }}
                        />
                        {renderPdfFieldOverlay({
                          pageNumber,
                          width: metric.width,
                          height: metric.height || metric.minHeight || PAGE_FALLBACK.height,
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : previewKind === 'text' ? (
              <div className="sv-text-preview" ref={previewScrollRef}>
                <div className="sv-document-page" style={{ zoom }}>
                  <div className="sv-document-title">{doc.name}</div>
                  {previewParagraphs.length > 0 ? (
                    previewParagraphs.map((paragraph, index) => (
                      <p key={`${paragraph.slice(0, 24)}-${index}`} className="sv-doc-paragraph">
                        {paragraph}
                      </p>
                    ))
                  ) : (
                    <p className="sv-doc-paragraph sv-doc-paragraph--muted">
                      No readable text was found in this file.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="sv-doc-placeholder">
                <div className="sv-doc-placeholder-icon">📝</div>
                <h3>{doc.name}</h3>
                <p>{docType}</p>
                <div className="sv-source-card">
                  <span>Legal Folder path</span>
                  <strong>{doc.sourcePath || doc.name}</strong>
                </div>
                {previewUrl && (
                  <a className="sv-btn sv-btn--primary" href={previewUrl} target="_blank" rel="noreferrer">
                    Open Source File
                  </a>
                )}
              </div>
            )}

            {canSign && !fileLoading && !fileError && (
              <div className="sv-floating-sign">
                <button
                  className="sv-btn sv-btn--sign"
                  disabled={primarySigningDisabled}
                  onClick={handlePrimarySigningAction}
                >
                  {primarySigningLabel}
                </button>
              </div>
            )}
          </div>

          <div className="sv-preview-footer">
            <span>{pageStatus}</span>
            <span className="sv-preview-footer__sep" />
            <span>Audit-ready preview</span>
            {previewKind === 'docx' && <span>Rendered from Word document structure</span>}
            {previewUrl && (
              <a href={previewUrl} target="_blank" rel="noreferrer">
                Open source
              </a>
            )}
          </div>
        </div>

        <div className="sv-side-panel">
          <div className="sv-side-tabs">
            {['signers', 'activity'].map((tabName) => (
              <button
                key={tabName}
                className={`sv-side-tab${activeTab === tabName ? ' sv-side-tab--active' : ''}`}
                onClick={() => setActiveTab(tabName)}
              >
                {tabName === 'signers' ? 'Signers' : 'Activity'}
              </button>
            ))}
          </div>

          {activeTab === 'signers' && (
            <div className="sv-signers-panel">
              {canSign && (
                <div className="sv-my-action">
                  <div className="sv-my-action-label">Your action required</div>
                  <button
                    className="sv-sign-btn"
                    disabled={primarySigningDisabled}
                    onClick={handlePrimarySigningAction}
                  >
                    <span>{primarySigningVerb}</span>
                    {primarySigningLabel}
                  </button>
                  {signatureDraft && (
                    <button
                      className="sv-sign-btn sv-sign-btn--secondary"
                      type="button"
                      onClick={() => openSignatureModal(myPendingSignatureField)}
                    >
                      <span>Edit</span>
                      Signature
                    </button>
                  )}
                  {signatureDraft && draftReadyToSend && (
                    <>
                      <label className="sv-consent-check">
                        <input
                          type="checkbox"
                          checked={consentAccepted}
                          onChange={(event) => {
                            setConsentAccepted(event.target.checked);
                            if (event.target.checked && signingError === 'Accept electronic signature consent before sending.') {
                              setSigningError('');
                            }
                          }}
                        />
                        <span>I agree to use electronic records and signatures for this document.</span>
                      </label>
                      <label className="sv-consent-check sv-consent-check--optional">
                        <input
                          type="checkbox"
                          checked={includeLocationEvidence}
                          onChange={(event) => setIncludeLocationEvidence(event.target.checked)}
                        />
                        <span>Include my location in the signing evidence. Your browser will ask for permission before sharing it.</span>
                      </label>
                    </>
                  )}
                  {missingRequiredField && (
                    <p className="sv-sign-legal">
                      {myRequiredFields.length - myCompletedRequiredFields} required field{myRequiredFields.length - myCompletedRequiredFields === 1 ? '' : 's'} left.
                    </p>
                  )}
                  {signingError && <p className="sv-sign-error" role="alert">{signingError}</p>}
                  <p className="sv-sign-legal">
                    {draftReadyToSend
                      ? 'Review the placed signature and initials on the document before sending.'
                      : signatureDraft
                        ? 'Add the remaining signature or initials before sending.'
                      : 'By signing you agree this is your legally binding signature.'}
                  </p>
                </div>
              )}

              <div className="sv-field-summary">
                <div className="sv-field-summary__header">
                  <span>{signingMode ? 'Your required fields' : 'Signing progress'}</span>
                  <strong>
                    {signingMode && myRequiredFields.length > 0
                      ? `${myCompletedRequiredFields} of ${myRequiredFields.length} complete`
                      : totalFields > 0
                        ? `${completedFields} of ${totalFields} fields complete`
                        : hasSigned ? 'Signed' : 'No fields placed'}
                  </strong>
                </div>
                <div className="sv-field-progress" aria-hidden="true">
                  <span style={{ width: `${signingMode ? myRequiredProgress : fieldProgress}%` }} />
                </div>
                {signingMode && missingRequiredField && (
                  <button type="button" className="sv-next-field-btn" onClick={handleNextRequiredField}>
                    Next required field
                  </button>
                )}
                {signingMode && totalFields > 0 && (
                  <div className="sv-field-summary__small">
                    Envelope: {completedFields} of {totalFields} fields complete
                  </div>
                )}
              </div>

              {hasSigned && (
                <div className="sv-signed-notice">
                  <span>✅</span>
                  <span>You have signed this document.</span>
                </div>
              )}

              <div className="sv-signers-title">All Signers</div>

              {signerRows.length > 0 ? (
                signerRows.map((row, index) => (
                  <div
                    key={row.key || row.email || index}
                    className={`sv-signer-card${row.signed ? ' sv-signer-card--signed' : ''}${row.isMe ? ' sv-signer-card--me' : ''}`}
                  >
                    <div className="sv-signer-avatar">
                      {(row.name || row.email || 'S').charAt(0).toUpperCase()}
                    </div>
                    <div className="sv-signer-info">
                      <div className="sv-signer-email">{row.name}</div>
                      <div className="sv-signer-role">
                        {row.role}
                        {row.isMe && <span className="sv-you-tag">You</span>}
                      </div>
                      {row.fieldCount > 0 && (
                        <div className="sv-signer-fields">
                          {row.completedFields} of {row.fieldCount} field{row.fieldCount === 1 ? '' : 's'} complete
                        </div>
                      )}
                      {row.signed ? (
                        <div className="sv-signer-signed">
                          Signed {formatTime(row.signedAt)}
                        </div>
                      ) : (
                        <div className="sv-signer-pending">Awaiting signature</div>
                      )}
                    </div>
                    <div className="sv-signer-status-icon">
                      {row.signed ? '✅' : '⏳'}
                    </div>
                  </div>
                ))
              ) : (
                <div className="sv-no-signers">No signers configured yet.</div>
              )}

              {signatures.length > 0 && (
                <div className="sv-sig-previews">
                  <div className="sv-signers-title">Captured Signatures</div>
                  {signatures.map((signature) => (
                    <div key={signature._id} className="sv-sig-preview-card">
                      <div className="sv-sig-preview-images">
                        <img
                          src={signature.signatureData}
                          alt={`Signature of ${signature.signerName}`}
                          className="sv-sig-preview-img"
                        />
                        {signature.initialsData && (
                          <img
                            src={signature.initialsData}
                            alt={`Initials of ${signature.signerName}`}
                            className="sv-sig-preview-img sv-sig-preview-img--initials"
                          />
                        )}
                      </div>
                      <div className="sv-sig-preview-meta">
                        <span>{signature.signerName}</span>
                        <span>{formatTime(signature.signedAt)}</span>
                        <span className="sv-sig-method">{signature.method}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="sv-activity-panel">
              {auditLogs.length === 0 && signatures.length === 0 ? (
                <p className="sv-no-activity">No activity recorded yet.</p>
              ) : (
                <div className="sv-timeline">
                  {signatures.map((signature) => (
                    <div key={`sig-${signature._id}`} className="sv-timeline-item sv-timeline-item--sig">
                      <div className="sv-timeline-dot sv-timeline-dot--green" />
                      <div className="sv-timeline-content">
                        <div className="sv-timeline-action">
                          <strong>{signature.signerName}</strong> signed ({signature.signerRole})
                        </div>
                        <div className="sv-timeline-time">{formatTime(signature.signedAt)}</div>
                        <div className="sv-timeline-hash">
                          Hash: {signature.auditHash?.slice(0, 16)}...
                        </div>
                      </div>
                    </div>
                  ))}
                  {auditLogs.map((log, index) => (
                    <div key={`log-${index}`} className="sv-timeline-item">
                      <div className="sv-timeline-dot" />
                      <div className="sv-timeline-content">
                        <div className="sv-timeline-action">{log.action}</div>
                        <div className="sv-timeline-time">
                          {log.performedBy?.name || log.performedByEmail || 'ContractIQ'} · {formatTime(log.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {allSigned && (
                <div className="sv-audit-cert">
                  <div className="sv-audit-cert-header">
                    <span>⚖</span> {finalizationComplete ? 'Digital Completion Certificate' : 'Signing Evidence'}
                  </div>
                  <div className="sv-audit-cert-body">
                    <p>
                      This document was electronically signed by all required parties. Detailed evidence is stored in the audit trail.
                    </p>
                    <div className="sv-audit-cert-row"><span>Document:</span><span>{doc.name}</span></div>
                    <div className="sv-audit-cert-row"><span>Parties:</span><span>{signatures.length} signer{signatures.length !== 1 ? 's' : ''}</span></div>
                    <div className="sv-audit-cert-row"><span>Completed:</span><span>{signatures.length > 0 ? formatTime(signatures[signatures.length - 1].signedAt) : '-'}</span></div>
                    <div className="sv-audit-cert-row"><span>Final PDF:</span><span>{finalizationComplete ? 'Finalized' : (finalization.status || 'Pending')}</span></div>
                    <div className="sv-audit-cert-row"><span>Finalized:</span><span>{finalization.finalizedAt ? formatTime(finalization.finalizedAt) : '-'}</span></div>
                    <div className="sv-audit-cert-row"><span>PDF hash:</span><span>{compactHash(finalization.finalPdfHash)}</span></div>
                    <div className="sv-audit-cert-row"><span>Digital seal:</span><span>{finalization.digitalSignatureStatus || 'not configured'}</span></div>
                    <div className="sv-audit-cert-row"><span>Platform:</span><span>ContractIQ Signing</span></div>
                    {canDownloadCertificate && (
                      <div className="sv-audit-cert-actions">
                        <button
                          type="button"
                          className="sv-btn sv-btn--primary"
                          onClick={handleDownloadCertificate}
                          disabled={certificateDownloading}
                        >
                          {certificateDownloading ? 'Preparing Certificate...' : 'Download Certificate PDF'}
                        </button>
                        {certificateError && <p className="sv-cert-error">{certificateError}</p>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <SignatureModal
          document={doc}
          signingField={signingField || myPendingSignatureField}
          captureMode={captureMode}
          initialFocus={signatureFocus}
          submitLabel={captureMode === 'initials' ? 'Save Initials' : 'Preview Signature'}
          onClose={() => setShowModal(false)}
          onSigned={handleSignComplete}
        />
      )}
    </div>
  );
}
