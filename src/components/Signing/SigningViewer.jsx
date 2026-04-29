import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { renderDocxPreview } from '../../services/docxPreviewRenderer';
import { canRenderDocxPreview, getLegalFolderFile } from '../../services/legalFolderFileStore';
import { getSigningDocument, signDocument, subscribeToSigning } from '../../services/signingStore';
import SignatureModal from './SignatureModal';
import './SigningViewer.css';

const TEXT_PREVIEW_TYPES = new Set(['txt', 'md', 'csv', 'json']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

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
const DEFAULT_PAGE_METRICS = { width: 794, height: 1123 };
const PREVIEW_LOG_PREFIX = '[SigningPreview]';

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

const countPdfPages = async (blob) => {
  try {
    const text = new TextDecoder().decode(await blob.arrayBuffer());
    const matches = text.match(/\/Type\s*\/Page\b/g);
    return Math.max(1, matches?.length || 1);
  } catch {
    return 1;
  }
};

const pdfSourceWithParams = (url, fitMode, zoom) => {
  if (!url) return '';
  const params = new URLSearchParams({
    toolbar: '0',
    navpanes: '0',
    scrollbar: '1',
  });
  if (fitMode === 'fit-page') params.set('view', 'Fit');
  else if (fitMode === 'fit-width') params.set('view', 'FitH');
  else params.set('zoom', String(Math.round(zoom * 100)));
  return `${url}#${params.toString()}`;
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
  const { user } = useAuth();

  const [revision, setRevision] = useState(0);
  const [signingField, setSigningField] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState('signers');
  const [success, setSuccess] = useState(false);
  const [fileRecord, setFileRecord] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [formattedPreview, setFormattedPreview] = useState(null);
  const [fileLoading, setFileLoading] = useState(true);
  const [fileError, setFileError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState('fit-width');
  const [activePage, setActivePage] = useState(1);
  const [docxPageCount, setDocxPageCount] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(1);
  const docxPagesRef = useRef(null);
  const previewShellRef = useRef(null);
  const previewScrollRef = useRef(null);
  const paginationRunRef = useRef(0);

  useEffect(() => subscribeToSigning(() => setRevision((value) => value + 1)), []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    const loadFile = async () => {
      previewLog('info', 'Preview load started', { docId, revision });
      setFileLoading(true);
      setFileError('');
      setFileRecord(null);
      setPreviewUrl('');
      setPreviewText('');
      setFormattedPreview(null);
      setDocxPageCount(1);
      setPdfPageCount(1);
      setActivePage(1);
      setFitMode('fit-width');

      try {
        const record = await getLegalFolderFile(docId);
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
          pdfPages = await countPdfPages(record.blob);
          previewLog('info', 'PDF preview source loaded', {
            docId,
            name: record.name,
            size: record.size,
            detectedPages: pdfPages,
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
  }, [docId, revision]);

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

  const doc = getSigningDocument(docId);
  const signatures = doc?.signatures || [];
  const auditLogs = doc?.auditLogs || [];
  const myPendingField = doc?.signingFields?.find(
    (field) => (field.assignedTo === user?.email || !field.assignedTo) && !field.filled
  );
  const hasSigned = user?.email
    ? signatures.some((signature) => signature.signerEmail === user.email)
    : false;
  const allSigned = doc?.signingFields?.length > 0
    ? doc.signingFields.every((field) => field.filled)
    : signatures.length > 0 && doc?.status === 'Signed';
  const canSign = Boolean(doc && !hasSigned && !allSigned && (myPendingField || !doc.signingFields?.length));
  const totalFields = doc?.signingFields?.length || 0;
  const completedFields = doc?.signingFields?.filter((field) => field.filled).length || 0;
  const fieldProgress = totalFields > 0 ? Math.round((completedFields / totalFields) * 100) : (hasSigned ? 100 : 0);
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
    ? `${pageCount} page${pageCount === 1 ? '' : 's'}`
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

  const setZoomToFit = useCallback((mode) => {
    setFitMode(mode);
    if (!['docx', 'text'].includes(previewKind)) return;

    const shellRect = previewShellRef.current?.getBoundingClientRect();
    if (!shellRect?.width || !shellRect?.height) return;

    const metrics = formattedPreview?.metrics || DEFAULT_PAGE_METRICS;
    const pageWidth = metrics.width || DEFAULT_PAGE_METRICS.width;
    const pageHeight = metrics.height || metrics.minHeight || DEFAULT_PAGE_METRICS.height;
    const availableWidth = Math.max(240, shellRect.width - 96);
    const availableHeight = Math.max(240, shellRect.height - 64);
    const nextZoom = mode === 'fit-page'
      ? Math.min(availableWidth / pageWidth, availableHeight / pageHeight)
      : availableWidth / pageWidth;

    setZoom(clampZoom(nextZoom));
  }, [formattedPreview?.metrics, previewKind]);

  const adjustZoom = (delta) => {
    setFitMode('custom');
    setZoom((z) => clampZoom(z + delta));
  };

  useEffect(() => {
    if (!['docx', 'text'].includes(previewKind) || !previewShellRef.current) return undefined;
    const frame = requestAnimationFrame(() => setZoomToFit('fit-width'));
    return () => cancelAnimationFrame(frame);
  }, [docId, previewKind, formattedPreview?.html, previewText, setZoomToFit]);

  useEffect(() => {
    if (fitMode === 'custom' || !['docx', 'text'].includes(previewKind)) return undefined;
    const shell = previewShellRef.current;
    if (!shell) return undefined;
    const observer = new ResizeObserver(() => setZoomToFit(fitMode));
    observer.observe(shell);
    return () => observer.disconnect();
  }, [fitMode, previewKind, formattedPreview?.metrics?.width, formattedPreview?.metrics?.height, setZoomToFit]);

  useEffect(() => {
    const scroller = previewScrollRef.current;
    if (!scroller || !['docx', 'text'].includes(previewKind)) return undefined;

    let frame = 0;
    const updateVisiblePage = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const pages = Array.from(scroller.querySelectorAll('.docx-page, .sv-document-page'));
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
  }, [previewKind, docxPageCount, formattedPreview?.html, zoom, previewText]);

  const wordCount = useMemo(() => {
    if (formattedPreview?.html) {
      return formattedPreview.html.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    }
    if (previewText) return previewText.trim().split(/\s+/).filter(Boolean).length;
    return 0;
  }, [formattedPreview, previewText]);

  const openSignatureModal = (field = myPendingField) => {
    setSigningField(field || null);
    setShowModal(true);
  };

  const handleSignComplete = async (payload) => {
    signDocument(docId, payload, user);
    setShowModal(false);
    setSuccess(true);
    setRevision((value) => value + 1);
  };

  const signedByUser = (email) => signatures.find((signature) => signature.signerEmail === email);

  const formatTime = (date) => new Date(date).toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  if (!doc) {
    return (
      <div className="sv-error">
        <h2>Document not found</h2>
        <p>Sync the Legal Folder, then open this signing room again.</p>
        <button onClick={() => navigate('/signing')}>Back to Signing</button>
      </div>
    );
  }

  const docType = doc.type ? `${doc.type.toUpperCase()} document` : 'Shared folder document';
  const previewParagraphs = paragraphsFrom(previewText);

  return (
    <div className="sv-root">
      <div className="sv-topbar">
        <button className="sv-back" onClick={() => navigate('/signing')}>
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
              <div className="sv-iframe-wrap">
                <iframe
                  src={pdfSourceWithParams(previewUrl, fitMode, zoom)}
                  className="sv-iframe"
                  title={doc.name}
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
                  className="sv-docx-pages"
                  data-docx-source-pages={sourcePageCount}
                  style={{
                    zoom,
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
                  onClick={() => openSignatureModal(myPendingField)}
                >
                  Sign This Document
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
                    onClick={() => openSignatureModal(myPendingField)}
                  >
                    <span>✍️</span>
                    Sign This Document
                  </button>
                  <p className="sv-sign-legal">
                    By signing you agree this is your legally binding signature.
                  </p>
                </div>
              )}

              <div className="sv-field-summary">
                <div className="sv-field-summary__header">
                  <span>Signing progress</span>
                  <strong>
                    {totalFields > 0
                      ? `${completedFields} of ${totalFields} fields complete`
                      : hasSigned ? 'Signed' : 'Signature pending'}
                  </strong>
                </div>
                <div className="sv-field-progress" aria-hidden="true">
                  <span style={{ width: `${fieldProgress}%` }} />
                </div>
              </div>

              {hasSigned && (
                <div className="sv-signed-notice">
                  <span>✅</span>
                  <span>You have signed this document.</span>
                </div>
              )}

              <div className="sv-signers-title">All Signers</div>

              {doc.signingFields && doc.signingFields.length > 0 ? (
                doc.signingFields.map((field) => {
                  const signature = signedByUser(field.assignedTo);
                  const isMe = field.assignedTo === user?.email;
                  const name = signature?.signerName || field.assignedTo || 'Any signer';

                  return (
                    <div
                      key={field.id || `${field.role}-${field.assignedTo}`}
                      className={`sv-signer-card${field.filled ? ' sv-signer-card--signed' : ''}${isMe ? ' sv-signer-card--me' : ''}`}
                    >
                      <div className="sv-signer-avatar">
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <div className="sv-signer-info">
                        <div className="sv-signer-email">{name}</div>
                        <div className="sv-signer-role">
                          {field.role || 'Signatory'}
                          {isMe && <span className="sv-you-tag">You</span>}
                        </div>
                        {field.filled ? (
                          <div className="sv-signer-signed">
                            Signed {formatTime(field.filledAt || signature?.signedAt)}
                          </div>
                        ) : (
                          <div className="sv-signer-pending">Awaiting signature</div>
                        )}
                      </div>
                      <div className="sv-signer-status-icon">
                        {field.filled ? '✅' : '⏳'}
                      </div>
                    </div>
                  );
                })
              ) : signatures.length > 0 ? (
                signatures.map((signature) => (
                  <div key={signature._id} className="sv-signer-card sv-signer-card--signed">
                    <div className="sv-signer-avatar">{signature.signerName?.charAt(0).toUpperCase()}</div>
                    <div className="sv-signer-info">
                      <div className="sv-signer-email">{signature.signerName}</div>
                      <div className="sv-signer-role">{signature.signerRole}</div>
                      <div className="sv-signer-signed">Signed {formatTime(signature.signedAt)}</div>
                    </div>
                    <div className="sv-signer-status-icon">✅</div>
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
                      <img
                        src={signature.signatureData}
                        alt={`Signature of ${signature.signerName}`}
                        className="sv-sig-preview-img"
                      />
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
                    <span>⚖</span> Digital Witness Certificate
                  </div>
                  <div className="sv-audit-cert-body">
                    <p>This document was electronically signed by all required parties via ContractIQ.</p>
                    <div className="sv-audit-cert-row"><span>Document:</span><span>{doc.name}</span></div>
                    <div className="sv-audit-cert-row"><span>Parties:</span><span>{signatures.length} signer{signatures.length !== 1 ? 's' : ''}</span></div>
                    <div className="sv-audit-cert-row"><span>Completed:</span><span>{signatures.length > 0 ? formatTime(signatures[signatures.length - 1].signedAt) : '-'}</span></div>
                    <div className="sv-audit-cert-row"><span>Platform:</span><span>ContractIQ Signing</span></div>
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
          signingField={signingField || myPendingField}
          onClose={() => setShowModal(false)}
          onSigned={handleSignComplete}
        />
      )}
    </div>
  );
}
