import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getSigningDocument, requestSigning } from '../../services/signingStore';
import { getLegalFolderFile, canRenderDocxPreview } from '../../services/legalFolderFileStore';
import { renderDocxPreview } from '../../services/docxPreviewRenderer';
import { decorateDocxPages, paginateDocxPages } from '../../services/docxPagination';
import { documents, signing as signingApi } from '../../services/api';
import PdfDocumentPreview from './PdfDocumentPreview';
import {
  FIELD_TYPES,
  PAGE_FALLBACK,
  createField,
  fieldPercentStyle,
  fieldTypeConfig,
  normalizeFieldForStorage,
  pageMetric,
  toNormalizedGeometry,
  clamp,
} from '../../services/signingFields';
import './SigningEnvelope.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNER_COLORS = ['#2563eb', '#059669', '#dc2626', '#7c3aed', '#ea580c', '#0891b2'];
const sc = (i) => SIGNER_COLORS[i % SIGNER_COLORS.length];

const ROLES = [
  'Signatory', 'Party 1', 'Party 2', 'Client', 'Service Provider',
  'Beneficiary', 'Company', 'Consultant', 'Lender', 'Borrower',
  'Witness', 'Director', 'Company Secretary', 'Other',
];

const uid = () => `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const isMongoId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));
const isPdfRecord = (record) =>
  record?.type === 'pdf' || record?.mimeType === 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

// ── Helpers ───────────────────────────────────────────────────────────────────

const initSigners = (doc) => {
  if (doc?.signers?.length) {
    return doc.signers.map((signer, i) => ({
      id: signer.id || signer._id || `signer_${i}`,
      name: signer.name || '',
      email: signer.email || '',
      role: signer.role || `Signer ${i + 1}`,
      type: signer.type || 'external',
      userId: signer.userId || '',
    }));
  }

  const roles = doc?.inferredSignerRoles?.length
    ? doc.inferredSignerRoles
    : doc?.signingFields?.map((f) => f.role).filter(Boolean);
  return (roles?.length ? roles : ['Party 1', 'Party 2']).map((role, i) => ({
    id: `signer_${i}`, name: '', email: '', role, type: 'external', userId: '',
  }));
};

const initFields = (doc) =>
  (doc?.signingFields || []).map((field, index) => ({
    ...field,
    id: field.id || `field_${index}`,
  }));

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

const mimeForRecord = (record) => {
  if (record?.mimeType) return record.mimeType;
  if (record?.type === 'pdf') return 'application/pdf';
  if (record?.type === 'docx') return DOCX_MIME;
  if (record?.type === 'doc') return DOC_MIME;
  return record?.blob?.type || 'application/octet-stream';
};

const docxPageHtml = (html) => {
  if (!html || typeof DOMParser === 'undefined') return [];
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
  const pages = Array.from(parsed.querySelectorAll('.docx-page'));
  return pages.length ? pages.map((page) => page.innerHTML) : [html];
};

const finiteMetric = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
};

const docxPageVars = (metric = PAGE_FALLBACK) => ({
  '--docx-page-width': `${finiteMetric(metric.width, PAGE_FALLBACK.width)}px`,
  '--docx-page-height': `${finiteMetric(metric.height || metric.minHeight, PAGE_FALLBACK.height)}px`,
  '--docx-page-min-height': `${finiteMetric(metric.minHeight || metric.height, PAGE_FALLBACK.height)}px`,
  '--docx-margin-top': `${finiteMetric(metric.marginTop, 96)}px`,
  '--docx-margin-right': `${finiteMetric(metric.marginRight, 96)}px`,
  '--docx-margin-bottom': `${finiteMetric(metric.marginBottom, 96)}px`,
  '--docx-margin-left': `${finiteMetric(metric.marginLeft, 96)}px`,
});


// ── Component ─────────────────────────────────────────────────────────────────

export default function SigningEnvelope() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const localDoc = useMemo(() => getSigningDocument(docId), [docId]);
  const [remoteDoc, setRemoteDoc] = useState(null);
  const doc = localDoc || remoteDoc;

  const docRef = useRef(doc);
  useEffect(() => { docRef.current = doc; });

  useEffect(() => {
    if (localDoc || !isMongoId(docId)) return undefined;
    let cancelled = false;
    documents.get(docId)
      .then((data) => { if (!cancelled) setRemoteDoc(data.document); })
      .catch(() => { if (!cancelled) setRemoteDoc(null); });
    return () => { cancelled = true; };
  }, [docId, localDoc]);

  const [fileRecord, setFileRecord] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [pdfBlob, setPdfBlob] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState(null);
  const [docxHtml, setDocxHtml] = useState(null);
  const [docxPages, setDocxPages] = useState([]);
  const [pageMetrics, setPageMetrics] = useState({ 1: PAGE_FALLBACK });
  const [pageCount, setPageCount] = useState(1);
  const [activePage, setActivePage] = useState(1);
  const [zoom, setZoom] = useState(1.15);

  useEffect(() => {
    if (!docId) return undefined;
    let objectUrl = null;
    let cancelled = false;

    setPdfLoading(true);
    setFileRecord(null);
    setPreviewUrl('');
    setPdfBlob(null);
    setPdfError(null);
    setDocxHtml(null);
    setDocxPages([]);
    setPageMetrics({ 1: PAGE_FALLBACK });
    setPageCount(1);

    const load = async () => {
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
          if (!cancelled) {
            setPdfError('File not found. Re-sync the Legal Folder or upload the document to the server before placing fields.');
          }
          return;
        }

        let renderType = record.type;
        let docxPreview = null;

        if (canRenderDocxPreview(record)) {
          docxPreview = await renderDocxPreview(record.blob);
          renderType = 'docx-preview';
        }

        objectUrl = URL.createObjectURL(record.blob);

        if (!cancelled) {
          const pages = docxPreview ? docxPageHtml(docxPreview.html) : [];
          const metrics = docxPreview
            ? Object.fromEntries(pages.map((_, i) => [i + 1, docxPreview.metrics || PAGE_FALLBACK]))
            : { 1: PAGE_FALLBACK };
          setFileRecord({ ...record, renderType });
          setPreviewUrl(objectUrl);
          setPdfBlob(isPdfRecord(record) ? record.blob : null);
          setDocxHtml(docxPreview || null);
          setDocxPages(pages);
          setPageMetrics(metrics);
          setPageCount(Math.max(1, pages.length || 1));
        }
      } catch (err) {
        if (!cancelled) setPdfError(err?.message || 'Could not load the document preview.');
      } finally {
        if (!cancelled) setPdfLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, localDoc]);

  const [step, setStep] = useState(1);
  const [signers, setSigners] = useState(() => initSigners(doc));
  const [fields, setFields] = useState(() => initFields(doc));
  const [selId, setSelId] = useState(null);
  const [activeSi, setActiveSi] = useState(0);
  const [signingOrder, setSigningOrder] = useState('parallel');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepSummary, setPrepSummary] = useState(null);
  const [error, setError] = useState('');

  const canvasWrapRef = useRef(null);
  const docxMeasureRef = useRef(null);
  const dragRef = useRef(null);

  const handlePdfLoad = useCallback(({ pageCount: loadedPageCount, pageMetrics: loadedMetrics }) => {
    setPageCount(Math.max(1, loadedPageCount || 1));
    setPageMetrics(Object.keys(loadedMetrics || {}).length ? loadedMetrics : { 1: PAGE_FALLBACK });
  }, []);

  useEffect(() => {
    if (!doc) return;
    setSigners(initSigners(doc));
    setFields(initFields(doc));
  }, [docId, doc]);

  const selField = fields.find((f) => f.id === selId) ?? null;
  const canStep1 = signers.length > 0 && signers.every((s) => s.email && s.name);
  const previewKind = pdfBlob ? 'pdf' : docxHtml ? 'docx' : fileRecord?.blob ? 'file' : 'none';
  const canProceedFromFields = fields.length > 0 && fields.every((field) => field.assignedTo);
  const docxMetric = docxHtml?.metrics || PAGE_FALLBACK;

  useLayoutEffect(() => {
    if (step !== 2 || previewKind !== 'docx' || !docxHtml?.html || !docxMeasureRef.current) return undefined;

    const root = docxMeasureRef.current;
    const frames = [];
    let cancelled = false;

    const applyPagination = () => {
      if (cancelled) return;
      const frame = requestAnimationFrame(() => {
        if (cancelled || !root.isConnected) return;

        const result = paginateDocxPages(root, docxHtml.html);
        decorateDocxPages(root, docxHtml.chrome);
        const pages = Array.from(root.querySelectorAll(':scope > .docx-page'));
        const nextPages = pages.length ? pages.map((page) => page.innerHTML) : docxPageHtml(docxHtml.html);
        const nextPageCount = Math.max(1, nextPages.length || result.pageCount || 1);
        const nextMetrics = Object.fromEntries(
          Array.from({ length: nextPageCount }, (_, index) => [index + 1, docxMetric])
        );

        setDocxPages(nextPages);
        setPageCount(nextPageCount);
        setPageMetrics(nextMetrics);
        setActivePage((page) => Math.min(page, nextPageCount));
      });
      frames.push(frame);
    };

    applyPagination();
    document.fonts?.ready?.then(applyPagination);

    return () => {
      cancelled = true;
      frames.forEach((frame) => cancelAnimationFrame(frame));
    };
  }, [docxHtml?.chrome, docxHtml?.html, docxMetric, previewKind, step]);

  useEffect(() => {
    const scroller = canvasWrapRef.current;
    if (!scroller) return undefined;

    let frame = 0;
    const updateActivePage = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const pages = Array.from(scroller.querySelectorAll('[data-env-page-number]'));
        if (!pages.length) {
          setActivePage(1);
          return;
        }
        const rect = scroller.getBoundingClientRect();
        const focusY = rect.top + rect.height * 0.42;
        let bestPage = 1;
        let bestDistance = Number.POSITIVE_INFINITY;
        pages.forEach((page) => {
          const pageRect = page.getBoundingClientRect();
          const distance = focusY < pageRect.top
            ? pageRect.top - focusY
            : focusY > pageRect.bottom
              ? focusY - pageRect.bottom
              : 0;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestPage = Number(page.dataset.envPageNumber) || 1;
          }
        });
        setActivePage(bestPage);
      });
    };

    updateActivePage();
    scroller.addEventListener('scroll', updateActivePage, { passive: true });
    window.addEventListener('resize', updateActivePage);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', updateActivePage);
      window.removeEventListener('resize', updateActivePage);
    };
  }, [previewKind, pageCount, zoom]);

  // ── Signer management ──────────────────────────────────────────────────────

  const addSigner = () =>
    setSigners((s) => [...s, { id: uid(), name: '', email: '', role: 'Signatory', type: 'external', userId: '' }]);

  const removeSigner = (idx) => {
    const email = signers[idx]?.email;
    setSigners((s) => s.filter((_, i) => i !== idx));
    if (email) setFields((f) => f.filter((field) => field.assignedTo !== email));
    if (activeSi >= signers.length - 1) setActiveSi(Math.max(0, signers.length - 2));
  };

  const updateSigner = (idx, k, v) =>
    setSigners((s) => { const n = [...s]; n[idx] = { ...n[idx], [k]: v }; return n; });

  // ── Field management ───────────────────────────────────────────────────────

  const pageElementFromPoint = useCallback((clientX, clientY) => {
    const scroller = canvasWrapRef.current;
    if (!scroller) return null;

    const direct = document
      .elementsFromPoint(clientX, clientY)
      .map((node) => node.closest?.('[data-env-page-number]'))
      .find(Boolean);
    if (direct && scroller.contains(direct)) return direct;

    const pages = Array.from(scroller.querySelectorAll('[data-env-page-number]'));
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const xDistance = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const yDistance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const distance = xDistance * xDistance + yDistance * yDistance;
      if (distance < bestDistance) {
        best = page;
        bestDistance = distance;
      }
    }
    return best;
  }, []);

  const geometryFromPoint = useCallback((clientX, clientY, fieldConfig, pageEl, pointerOffset = null) => {
    const rect = pageEl?.getBoundingClientRect();
    if (!rect) return null;
    const cfg = fieldTypeConfig(fieldConfig.type);
    const width = fieldConfig.width ?? cfg.width;
    const height = fieldConfig.height ?? cfg.height;
    const offsetX = pointerOffset?.x ?? width / 2;
    const offsetY = pointerOffset?.y ?? height / 2;
    return {
      page: Number(pageEl.dataset.envPageNumber) || 1,
      x: Number(clamp((clientX - rect.left) / rect.width - offsetX, 0, 1 - width).toFixed(6)),
      y: Number(clamp((clientY - rect.top) / rect.height - offsetY, 0, 1 - height).toFixed(6)),
      width,
      height,
    };
  }, []);

  const addField = useCallback((ft) => {
    const signer = signers[activeSi];
    const pageEl = canvasWrapRef.current?.querySelector(`[data-env-page-number="${activePage}"]`);
    const wrapRect = canvasWrapRef.current?.getBoundingClientRect();
    const pageRect = pageEl?.getBoundingClientRect();
    const x = pageRect && wrapRect
      ? clamp((wrapRect.left + wrapRect.width / 2 - pageRect.left) / pageRect.width, 0.08, 0.92)
      : 0.5;
    const y = pageRect && wrapRect
      ? clamp((wrapRect.top + wrapRect.height * 0.42 - pageRect.top) / pageRect.height, 0.08, 0.92)
      : 0.45;
    const id = uid();
    setFields((f) => [
      ...f,
      {
        ...createField({ type: ft.type, signer, page: activePage, x, y }),
        id,
      },
    ]);
    setSelId(id);
  }, [signers, activeSi, activePage]);

  const addFieldAtPoint = useCallback((ft, clientX, clientY) => {
    const pageEl = pageElementFromPoint(clientX, clientY);
    if (!pageEl) return;
    const signer = signers[activeSi];
    const base = createField({ type: ft.type, signer, page: Number(pageEl.dataset.envPageNumber) || 1 });
    const dropped = geometryFromPoint(clientX, clientY, base, pageEl);
    if (!dropped) return;
    const id = uid();
    setFields((current) => [
      ...current,
      {
        ...base,
        ...dropped,
        id,
        coordinateOrigin: 'normalized',
      },
    ]);
    setActivePage(dropped.page);
    setSelId(id);
  }, [activeSi, geometryFromPoint, pageElementFromPoint, signers]);

  const onPaletteDragStart = useCallback((event, ft) => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/x-contractiq-field-type', ft.type);
    event.dataTransfer.setData('text/plain', ft.type);
  }, []);

  const onPageDragOver = useCallback((event) => {
    if (Array.from(event.dataTransfer.types || []).includes('application/x-contractiq-field-type')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onPageDrop = useCallback((event) => {
    const type = event.dataTransfer.getData('application/x-contractiq-field-type') || event.dataTransfer.getData('text/plain');
    const ft = FIELD_TYPES.find((item) => item.type === type);
    if (!ft) return;
    event.preventDefault();
    event.stopPropagation();
    addFieldAtPoint(ft, event.clientX, event.clientY);
  }, [addFieldAtPoint]);

  const removeField = useCallback((id) => {
    setFields((f) => f.filter((field) => field.id !== id));
    setSelId((s) => (s === id ? null : s));
  }, []);

  const updateField = useCallback(
    (id, updates) =>
      setFields((f) => f.map((field) => (field.id === id ? { ...field, ...updates } : field))),
    [],
  );

  // ── Drag-to-reposition ────────────────────────────────────────────────────

  const onFieldPointerDown = useCallback((e, fieldId, mode = 'move') => {
    e.preventDefault();
    e.stopPropagation();
    setSelId(fieldId);
    const pageEl = e.currentTarget.closest('[data-env-page-number]');
    const pageRect = pageEl?.getBoundingClientRect();
    const field = fields.find((item) => item.id === fieldId);
    if (!pageRect || !field) return;
    const metric = pageMetric(pageMetrics, field.page);
    const geometry = toNormalizedGeometry(field, metric);
    const pointerOffset = {
      x: clamp((e.clientX - pageRect.left) / pageRect.width - geometry.x, 0, geometry.width),
      y: clamp((e.clientY - pageRect.top) / pageRect.height - geometry.y, 0, geometry.height),
    };

    dragRef.current = {
      fieldId,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      page: field.page,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      pointerOffset,
      start: geometry,
    };

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.sx) / d.pageWidth;
      const dy = (ev.clientY - d.sy) / d.pageHeight;
      setFields((prev) =>
        prev.map((f) => {
          if (f.id !== d.fieldId) return f;
          if (d.mode === 'resize') {
            const width = clamp(d.start.width + dx, 0.018, 1 - d.start.x);
            const height = clamp(d.start.height + dy, 0.018, 1 - d.start.y);
            return {
              ...f,
              x: d.start.x,
              y: d.start.y,
              width: Number(width.toFixed(6)),
              height: Number(height.toFixed(6)),
              coordinateOrigin: 'normalized',
            };
          }
          const targetPage = pageElementFromPoint(ev.clientX, ev.clientY);
          if (targetPage) {
            const next = geometryFromPoint(
              ev.clientX,
              ev.clientY,
              {
                ...f,
                page: Number(targetPage.dataset.envPageNumber) || f.page,
                x: d.start.x,
                y: d.start.y,
                width: d.start.width,
                height: d.start.height,
                coordinateOrigin: 'normalized',
              },
              targetPage,
              d.pointerOffset
            );
            if (next) {
              setActivePage(next.page);
              return {
                ...f,
                page: next.page,
                x: next.x,
                y: next.y,
                width: d.start.width,
                height: d.start.height,
                coordinateOrigin: 'normalized',
              };
            }
          }
          return {
            ...f,
            x: Number(clamp(d.start.x + dx, 0, 1 - d.start.width).toFixed(6)),
            y: Number(clamp(d.start.y + dy, 0, 1 - d.start.height).toFixed(6)),
            width: d.start.width,
            height: d.start.height,
            coordinateOrigin: 'normalized',
          };
        }),
      );
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [fields, geometryFromPoint, pageElementFromPoint, pageMetrics]);

  // ── Automated preparation ─────────────────────────────────────────────────

  const uploadLocalDocumentForPreparation = async () => {
    if (!fileRecord?.blob) {
      throw new Error('Open the document preview before running field detection.');
    }

    const fileName = fileRecord.name || doc?.name || 'document';
    const file = new File([fileRecord.blob], fileName, { type: mimeForRecord(fileRecord) });
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', doc?.name || fileName);
    formData.append('description', `Imported from Legal Folder for signing preparation: ${doc?.sourcePath || fileName}`);
    const uploaded = await documents.upload(formData);
    return uploaded.document;
  };

  const prepareEnvelopeFields = async () => {
    setError('');
    setPrepSummary(null);
    if (!canStep1) return;

    setPreparing(true);
    try {
      let targetDocId = docId;
      let targetDoc = doc;

      if (!isMongoId(targetDocId)) {
        targetDoc = await uploadLocalDocumentForPreparation();
        targetDocId = targetDoc._id;
      }

      const payload = {
        signers: signers.map((s) => ({
          name: s.name,
          email: s.email,
          role: s.role,
          userId: s.userId || undefined,
        })),
        signingOrder,
      };
      const prepared = await signingApi.prepare(targetDocId, payload);
      const preparedFields = prepared.fields || prepared.document?.signingFields || [];

      setRemoteDoc(prepared.document || targetDoc);
      setFields(initFields({ signingFields: preparedFields }));
      setPrepSummary({
        fieldCount: preparedFields.length,
        status: prepared.preparation?.status,
        reviewRequired: Boolean(prepared.preparation?.reviewRequired),
      });
      setStep(2);

      if (targetDocId !== docId) {
        navigate(`/signing/envelope/${targetDocId}`, { replace: true });
      }
    } catch (err) {
      setError(err.message || 'Could not detect signing fields.');
    } finally {
      setPreparing(false);
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────────

  const handleSend = async () => {
    setError('');
    const bad = signers.find((s) => !s.email || !s.name);
    if (bad) { setError('All signers require a name and email address.'); return; }
    if (!fields.length) { setError('Add at least one field before sending this envelope.'); return; }
    if (fields.some((field) => !field.assignedTo)) { setError('Every field must be assigned to a signer.'); return; }
    setSending(true);
    try {
      const normalizedFields = fields.map((field) => normalizeFieldForStorage(field, pageMetrics));
      const payload = {
        signers: signers.map((s) => ({ name: s.name, email: s.email, role: s.role, userId: s.userId || undefined })),
        fields: normalizedFields,
        pageMetrics,
        signingOrder,
        message,
      };
      if (isMongoId(docId)) {
        await signingApi.requestSigning(docId, payload);
      } else {
        requestSigning(docId, payload, user);
      }
      navigate(`/signing/view/${docId}`);
    } catch (err) {
      setError(err.message);
      setSending(false);
    }
  };

  const renderFieldBox = (field, metric) => {
    const si = signers.findIndex((s) => s.email === field.assignedTo);
    const color = sc(si >= 0 ? si : 0);
    const ft = fieldTypeConfig(field.type);
    const isSel = field.id === selId;

    return (
      <div
        key={field.id}
        className={`env-fbox env-fbox--${field.type}${isSel ? ' env-fbox--sel' : ''}`}
        style={{
          ...fieldPercentStyle(field, metric),
          '--fc': color,
        }}
        onPointerDown={(e) => onFieldPointerDown(e, field.id)}
        onClick={(e) => { e.stopPropagation(); setSelId(field.id); }}
      >
        <span className="env-fbox-label">{ft?.label}</span>
        {isSel && (
          <>
            <button
              className="env-fbox-del"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); removeField(field.id); }}
              title="Remove field"
            >x</button>
            <span
              className="env-fbox-resize"
              onPointerDown={(e) => onFieldPointerDown(e, field.id, 'resize')}
              title="Resize field"
            />
          </>
        )}
        {field.required && <span className="env-fbox-req">*</span>}
      </div>
    );
  };

  const renderOverlay = ({ pageNumber, width, height }) => {
    const metric = { width, height };
    return (
      <div
        className="env-page-overlay"
        onClick={() => setSelId(null)}
        onDragOver={onPageDragOver}
        onDrop={onPageDrop}
      >
        {fields
          .filter((field) => Number(field.page || 1) === pageNumber)
          .map((field) => renderFieldBox(field, metric))}
      </div>
    );
  };

  // ── Not found ─────────────────────────────────────────────────────────────

  if (!doc) {
    return (
      <div className="env-notfound">
        <div className="env-notfound-icon">📄</div>
        <p>Document not found. Please return to the signing dashboard.</p>
        <button className="env-btn env-btn--primary" onClick={() => navigate('/signing')}>← Back to Signing</button>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="env-root">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="env-header">
        <button className="env-back-btn" onClick={() => navigate('/signing')} title="Back to signing">
          ←
        </button>
        <div className="env-header-doc">
          <span className="env-doc-type-badge">{doc.type?.toUpperCase()}</span>
          <div className="env-header-doc-text">
            <div className="env-header-doc-name">{doc.name}</div>
            <div className="env-header-doc-sub">
              {doc.contract?.title || 'Signing'} · Uploaded by {doc.uploadedBy?.name}
            </div>
          </div>
        </div>
        <ol className="env-stepbar">
          {[['Recipients', 1], ['Place Fields', 2], ['Review & Send', 3]].map(([label, n]) => (
            <li
              key={n}
              className={`env-stepbar-item${step === n ? ' is-active' : step > n ? ' is-done' : ''}`}
              onClick={() => n < step && setStep(n)}
              style={{ cursor: n < step ? 'pointer' : 'default' }}
            >
              <div className="env-stepbar-dot">{step > n ? '✓' : n}</div>
              <span className="env-stepbar-label">{label}</span>
              {n < 3 && <div className="env-stepbar-line" />}
            </li>
          ))}
        </ol>
      </header>

      {/* ══ STEP 1: Recipients ══════════════════════════════════════════════ */}
      {step === 1 && (
        <div className="env-scroll-area">
          <div className="env-centered-body">

            <div className="env-card">
              <div className="env-card-head">
                <h2>Who needs to sign?</h2>
                <button className="env-add-btn" type="button" onClick={addSigner}>
                  + Add Signer
                </button>
              </div>

              <div className="env-signers-list">
                {signers.map((signer, i) => (
                  <div key={signer.id} className="env-signer-row">
                    <div className="env-signer-badge" style={{ background: sc(i) }}>
                      {i + 1}
                    </div>

                    <div className="env-signer-inputs">
                      <div className="env-input-row">
                        <label className="env-field env-field--grow">
                          <span>Full Name *</span>
                          <input
                            value={signer.name}
                            onChange={(e) => updateSigner(i, 'name', e.target.value)}
                            placeholder="Jane Smith"
                          />
                        </label>
                        <label className="env-field env-field--grow">
                          <span>Email Address *</span>
                          <input
                            type="email"
                            value={signer.email}
                            onChange={(e) => updateSigner(i, 'email', e.target.value)}
                            placeholder="jane@company.com"
                          />
                        </label>
                        <label className="env-field">
                          <span>Role</span>
                          <select value={signer.role} onChange={(e) => updateSigner(i, 'role', e.target.value)}>
                            {ROLES.map((r) => <option key={r}>{r}</option>)}
                          </select>
                        </label>
                        {signers.length > 1 && (
                          <button
                            type="button"
                            className="env-remove-signer"
                            onClick={() => removeSigner(i)}
                            title="Remove this signer"
                          >✕</button>
                        )}
                      </div>

                      {signer.email && (
                        <div className="env-signer-preview">
                          <div className="env-signer-avatar" style={{ background: sc(i) }}>
                            {(signer.name || signer.email).charAt(0).toUpperCase()}
                          </div>
                          <div className="env-signer-preview-info">
                            <span>{signer.name || '(no name)'}</span>
                            <span>{signer.email}</span>
                          </div>
                          <span className="env-role-chip">{signer.role}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {error && <div className="env-error">{error}</div>}

            <div className="env-step-footer">
              <button className="env-btn env-btn--ghost" onClick={() => navigate('/signing')}>Cancel</button>
              <button
                className="env-btn env-btn--primary"
                disabled={!canStep1 || preparing}
                onClick={prepareEnvelopeFields}
              >
                {preparing ? 'Detecting fields...' : 'Detect Fields →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ STEP 2: Field Editor ═════════════════════════════════════════════ */}
      {step === 2 && (
        <>
          <div className="env-editor">

            {/* Canvas — left panel */}
            <div className="env-canvas-wrap" ref={canvasWrapRef}>
              <div className="env-canvas-inner">
                {pdfLoading && (
                  <div className="env-page env-page--placeholder" style={{ width: PAGE_FALLBACK.width, height: PAGE_FALLBACK.height }}>
                    <div className="env-page-placeholder">
                      <div className="env-pdf-spinner" />
                      <small>Loading document...</small>
                    </div>
                  </div>
                )}

                {!pdfLoading && pdfError && (
                  <div className="env-page env-page--placeholder" style={{ width: PAGE_FALLBACK.width, height: PAGE_FALLBACK.height }}>
                    <div className="env-page-placeholder env-page-placeholder--error">
                      <span>!</span>
                      <p>Preview unavailable</p>
                      <small>{pdfError}</small>
                    </div>
                  </div>
                )}

                {!pdfLoading && previewKind === 'pdf' && (
                  <PdfDocumentPreview
                    blob={pdfBlob}
                    zoom={zoom}
                    className="sv-pdf-document"
                    pageClassName="sv-pdf-page"
                    onDocumentLoad={handlePdfLoad}
                    renderOverlay={renderOverlay}
                  />
                )}

                {!pdfLoading && previewKind === 'docx' && (
                  <div className="env-docx-document">
                    <div
                      ref={docxMeasureRef}
                      className="env-docx-measure"
                      aria-hidden="true"
                      style={{
                        ...docxPageVars(docxMetric),
                        fontFamily: docxMetric.fontFamily,
                      }}
                    />
                    {docxPages.map((pageHtml, index) => {
                      const pageNumber = index + 1;
                      const metric = pageMetric(pageMetrics, pageNumber);
                      return (
                        <div
                          key={pageNumber}
                          className="env-page env-docx-page-shell"
                          data-env-page-number={pageNumber}
                          style={{
                            ...docxPageVars(metric),
                            width: metric.width * zoom,
                            height: metric.height * zoom,
                          }}
                        >
                          <article
                            className="docx-page"
                            style={{
                              transform: `scale(${zoom})`,
                              transformOrigin: 'top left',
                              fontFamily: docxMetric.fontFamily,
                            }}
                            dangerouslySetInnerHTML={{ __html: pageHtml }}
                          />
                          {renderOverlay({ pageNumber, width: metric.width, height: metric.height })}
                        </div>
                      );
                    })}
                  </div>
                )}

                {!pdfLoading && previewKind === 'file' && (
                  <div
                    className="env-page env-page--placeholder"
                    data-env-page-number="1"
                    style={{ width: PAGE_FALLBACK.width * zoom, height: PAGE_FALLBACK.height * zoom }}
                  >
                    <div className="env-page-placeholder">
                      <span>File</span>
                      <p>{doc.name}</p>
                      <small>This file type uses a generic signing page. Open the source file separately to review it.</small>
                      {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer">Open source file</a>}
                    </div>
                    {renderOverlay({ pageNumber: 1, width: PAGE_FALLBACK.width, height: PAGE_FALLBACK.height })}
                  </div>
                )}
              </div>
            </div>

            {/* Palette — right panel */}
            <aside className="env-palette">

              {/* Signer selector */}
              <div className="env-pal-block">
                <div className="env-pal-head">Placing fields for</div>
                <div className="env-stabs">
                  {signers.map((s, i) => (
                    <button
                      key={s.id}
                      className={`env-stab${activeSi === i ? ' env-stab--on' : ''}`}
                      onClick={() => setActiveSi(i)}
                    >
                      <span className="env-stab-dot" style={{ background: sc(i) }} />
                      <span className="env-stab-name">{s.name || s.email || `Signer ${i + 1}`}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Field type palette */}
              <div className="env-pal-block">
                <div className="env-pal-head">Add a field</div>
                <div className="env-ftypes">
                  {FIELD_TYPES.map((ft) => (
                    <button
                      key={ft.type}
                      className={`env-ftype-btn${ft.required ? ' env-ftype-btn--req' : ''}`}
                      onClick={() => addField(ft)}
                      draggable
                      onDragStart={(event) => onPaletteDragStart(event, ft)}
                      title={ft.desc}
                    >
                      {ft.icon && ft.icon !== ft.label && <span className="env-ftype-icon">{ft.icon}</span>}
                      <span className="env-ftype-label">{ft.label}</span>
                      {ft.required && <span className="env-ftype-star">★</span>}
                    </button>
                  ))}
                </div>
              </div>

              {/* Selected field properties */}
              {selField && (
                <div className="env-pal-block env-prop-panel">
                  <div className="env-pal-head">Field Properties</div>

                  <label className="env-prop-row">
                    <span>Assigned to</span>
                    <select
                      value={selField.assignedTo}
                      onChange={(e) => {
                        const s = signers.find((s) => s.email === e.target.value);
                        updateField(selField.id, { assignedTo: e.target.value, role: s?.role || '' });
                      }}
                    >
                      {signers.map((s) => (
                        <option key={s.id} value={s.email}>{s.name || s.email || '(unnamed)'}</option>
                      ))}
                    </select>
                  </label>

                  <label className="env-prop-row env-prop-check">
                    <span>Required</span>
                    <input
                      type="checkbox"
                      checked={selField.required}
                      onChange={(e) => updateField(selField.id, { required: e.target.checked })}
                    />
                  </label>

                  <div className="env-prop-position">
                    Page {selField.page} · X {Math.round(toNormalizedGeometry(selField, pageMetric(pageMetrics, selField.page)).x * 100)}%
                    &nbsp;·&nbsp;Y {Math.round(toNormalizedGeometry(selField, pageMetric(pageMetrics, selField.page)).y * 100)}%
                    &nbsp;·&nbsp;{Math.round(toNormalizedGeometry(selField, pageMetric(pageMetrics, selField.page)).width * 100)}% x {Math.round(toNormalizedGeometry(selField, pageMetric(pageMetrics, selField.page)).height * 100)}%
                  </div>

                  <button
                    className="env-btn env-btn--danger env-btn--sm"
                    onClick={() => removeField(selField.id)}
                  >
                    Remove Field
                  </button>
                </div>
              )}

              {/* Per-signer field count */}
              <div className="env-pal-block">
                <div className="env-pal-head">Summary</div>
                {signers.map((s, i) => {
                  const count = fields.filter((f) => f.assignedTo === s.email).length;
                  return (
                    <div key={s.id} className="env-pal-count-row">
                      <span className="env-pal-dot" style={{ background: sc(i) }} />
                      <span className="env-pal-count-name">{s.name || s.email || `Signer ${i + 1}`}</span>
                      <span className={`env-pal-count-badge${count === 0 ? ' is-zero' : ''}`}>
                        {count} field{count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="env-pal-tip">
                Drag a field type onto any page, or drag placed fields between pages.
              </div>
            </aside>
          </div>

          {/* Editor footer */}
          <div className="env-editor-footer">
            <button className="env-btn env-btn--ghost" onClick={() => setStep(1)}>← Back</button>
            <span className="env-editor-footer-info">
              Page {activePage} of {pageCount} · {fields.length} field{fields.length !== 1 ? 's' : ''} placed
              {fields.length === 0 && ' — add at least one field'}
              {prepSummary?.fieldCount > 0 && ` · detected ${prepSummary.fieldCount}`}
            </span>
            <div className="env-zoom-actions">
              <button className="env-icon-btn" type="button" onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}>-</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button className="env-icon-btn" type="button" onClick={() => setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))))}>+</button>
            </div>
            <button className="env-btn env-btn--primary" disabled={!canProceedFromFields} onClick={() => setStep(3)}>
              Review &amp; Send →
            </button>
          </div>
        </>
      )}

      {/* ══ STEP 3: Review & Send ════════════════════════════════════════════ */}
      {step === 3 && (
        <div className="env-scroll-area">
          <div className="env-centered-body">

            {/* Signing order */}
            <div className="env-card">
              <h2>Signing Order</h2>
              <div className="env-order-grid">
                {[
                  { v: 'parallel',   icon: '⚡', title: 'Everyone at once',  desc: 'All signers receive their invitation simultaneously.' },
                  { v: 'sequential', icon: '↓',  title: 'One at a time',     desc: 'Each signer is notified only after the previous one completes.' },
                ].map((o) => (
                  <label
                    key={o.v}
                    className={`env-order-card${signingOrder === o.v ? ' env-order-card--on' : ''}`}
                  >
                    <input
                      type="radio"
                      name="order"
                      value={o.v}
                      checked={signingOrder === o.v}
                      onChange={() => setSigningOrder(o.v)}
                      hidden
                    />
                    <div className="env-order-icon">{o.icon}</div>
                    <div>
                      <div className="env-order-title">{o.title}</div>
                      <div className="env-order-desc">{o.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Signer summary */}
            <div className="env-card">
              <h2>Signer Summary</h2>
              {signers.map((s, i) => {
                const sf = fields.filter((f) => f.assignedTo === s.email);
                return (
                  <div key={s.id} className="env-review-row">
                    <div className="env-review-avatar" style={{ background: sc(i) }}>
                      {(s.name || s.email).charAt(0).toUpperCase()}
                    </div>
                    <div className="env-review-info">
                      <div className="env-review-name">{s.name}</div>
                      <div className="env-review-meta">{s.email} · <em>{s.role}</em></div>
                      <div className="env-review-chips">
                        {sf.length === 0 ? (
                          <span className="env-chip env-chip--warn">⚠ No fields assigned</span>
                        ) : (
                          sf.map((f) => {
                            const ft = FIELD_TYPES.find((t) => t.type === f.type);
                            return (
                              <span key={f.id} className="env-chip">
                                {ft?.label}{f.required ? ' *' : ''}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </div>
                    <button
                      className="env-review-edit"
                      onClick={() => setStep(2)}
                      title="Edit fields"
                    >
                      Edit
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Message */}
            <div className="env-card">
              <h2>
                Message to Signers
                <span className="env-optional"> (optional)</span>
              </h2>
              <textarea
                className="env-message"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Please review and sign this document at your earliest convenience…"
              />
            </div>

            {/* Signing flow */}
            <div className="env-card">
              <h2>Signing Flow</h2>
              <div className="env-flow">
                <div className="env-flow-node env-flow-node--done">
                  <div className="env-flow-bubble env-flow-bubble--done">✓</div>
                  <span>Document prepared by <strong>{user?.name}</strong></span>
                </div>
                {signers.map((s, i) => (
                  <div key={s.id} className="env-flow-node">
                    <div
                      className="env-flow-bubble"
                      style={{ background: sc(i), color: '#fff' }}
                    >
                      {i + 1}
                    </div>
                    <span>
                      {s.name || s.email}
                      <em> · {s.role}</em>
                      {signingOrder === 'sequential' && i > 0 && (
                        <span className="env-flow-seq-note"> (after signer {i})</span>
                      )}
                    </span>
                  </div>
                ))}
                <div className="env-flow-node">
                  <div className="env-flow-bubble env-flow-bubble--final">⚖</div>
                  <span>Document fully executed &amp; sealed</span>
                </div>
              </div>
            </div>

            {error && <div className="env-error">{error}</div>}

            <div className="env-step-footer">
              <button className="env-btn env-btn--ghost" onClick={() => setStep(2)}>← Back</button>
              <button
                className="env-btn env-btn--send"
                disabled={sending || !canProceedFromFields}
                onClick={handleSend}
              >
                {sending
                  ? 'Sending…'
                  : `✉ Send to ${signers.length} Signer${signers.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
