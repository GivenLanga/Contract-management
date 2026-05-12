import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
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

const TRAIL_OPTIONS = [
  {
    value: 'standard',
    title: 'Default audit trail',
    desc: 'Records the current identity, consent, device, IP, timestamp, field, and document hash evidence.',
  },
  {
    value: 'photo',
    title: 'Picture',
    desc: 'Captures a still photo from the signer camera when they start signing externally.',
  },
  {
    value: 'video',
    title: 'Video',
    desc: 'Records camera video from the first external signing action until the signer previews the signature.',
  },
  {
    value: 'ron',
    title: 'Remote Online Notarization (RON)',
    desc: 'Requires a notary profile, signer identity proofing, camera/microphone readiness, audio/video evidence, and RON journal metadata.',
  },
];

// South African identity proofing methods (no KBA in SA law)
const RON_IDENTITY_OPTIONS = [
  {
    value: 'sa_id_document',
    label: 'SA ID Document',
    desc: 'Signer uploads their South African ID book or smart ID card for visual verification by the notary.',
  },
  {
    value: 'passport_document',
    label: 'Passport',
    desc: 'Signer uploads a valid passport for visual verification before the notarial session.',
  },
  {
    value: 'personal_knowledge',
    label: 'Personal knowledge',
    desc: 'The Notary Public personally knows and can identify the signer (attestation required in the journal).',
  },
];

const SA_PROVINCES = [
  { code: 'GP', name: 'Gauteng' },
  { code: 'WC', name: 'Western Cape' },
  { code: 'KZN', name: 'KwaZulu-Natal' },
  { code: 'EC', name: 'Eastern Cape' },
  { code: 'FS', name: 'Free State' },
  { code: 'LP', name: 'Limpopo' },
  { code: 'MP', name: 'Mpumalanga' },
  { code: 'NC', name: 'Northern Cape' },
  { code: 'NW', name: 'North West' },
];

const SA_DOCUMENT_TYPES = [
  { value: 'antenuptial_contract', label: 'Antenuptial Contract (ANC)' },
  { value: 'power_of_attorney', label: 'Power of Attorney' },
  { value: 'affidavit', label: 'Sworn Affidavit / Declaration' },
  { value: 'academic_transcript', label: 'Academic Transcript / Diploma' },
  { value: 'property_agreement', label: 'Property / Financial Agreement' },
  { value: 'other', label: 'Other Notarial Document' },
];

const emptyRonConfig = () => ({
  identityMethod: 'sa_id_document',
  notary: {
    name: '',
    email: '',
    province: '',
    admissionNumber: '',
    commissionExpiresAt: '',
    venue: '',
  },
});

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
    required: true,
  }));

const initialEnvelopeStep = (mode, fields) => {
  if (mode === 'prepare') return 1;
  if (mode === 'review') return 2;
  return fields.length > 0 ? 2 : 1;
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

const FIELD_TYPE_PRIORITY = {
  signature: 50,
  initials: 45,
  date: 40,
  dropdown: 35,
  checkbox: 35,
  radio: 35,
  number: 35,
  text: 10,
};
const GENERAL_OVERLAP_LIMIT = 0.42;
const TEXT_OVERLAP_LIMIT = 0.18;
const FIELD_ALIGNMENT_GROUP_DISTANCE = 0.09;
const FIELD_ALIGNMENT_TOLERANCE = 0.0035;
const FIELD_ALIGNMENT_SNAP_DISTANCE = 0.018;
const INITIALS_ALIGNMENT_TOLERANCE = 0.001;

const fieldLayoutPriority = (field) => FIELD_TYPE_PRIORITY[field?.type] || 20;

const fieldSignerKey = (field = {}) =>
  field.assignedTo || field.role || 'unassigned';

const normalizedRect = (field, pageMetrics) => {
  const metric = pageMetric(pageMetrics, field.page);
  const geometry = toNormalizedGeometry(field, metric);
  return {
    ...geometry,
    page: Number(field.page || 1),
    right: geometry.x + geometry.width,
    bottom: geometry.y + geometry.height,
    area: geometry.width * geometry.height,
  };
};

const overlapStats = (a, b, pageMetrics) => {
  const ar = normalizedRect(a, pageMetrics);
  const br = normalizedRect(b, pageMetrics);
  if (ar.page !== br.page) return null;
  const width = Math.min(ar.right, br.right) - Math.max(ar.x, br.x);
  const height = Math.min(ar.bottom, br.bottom) - Math.max(ar.y, br.y);
  if (width <= 0 || height <= 0) return null;
  const area = width * height;
  const aRatio = area / Math.max(ar.area, 0.000001);
  const bRatio = area / Math.max(br.area, 0.000001);
  return {
    area,
    aRatio,
    bRatio,
    smallerRatio: area / Math.max(Math.min(ar.area, br.area), 0.000001),
  };
};

const shouldFlagOverlap = (a, b, stats) => {
  if (!stats) return false;
  if (stats.smallerRatio >= GENERAL_OVERLAP_LIMIT) return true;
  if (a.type === 'text' && stats.aRatio >= TEXT_OVERLAP_LIMIT) return true;
  if (b.type === 'text' && stats.bRatio >= TEXT_OVERLAP_LIMIT) return true;
  return false;
};

const preferredField = (a, b) => {
  const priorityDelta = fieldLayoutPriority(a) - fieldLayoutPriority(b);
  if (priorityDelta !== 0) return priorityDelta > 0 ? a : b;
  const confidenceDelta = Number(a.confidence || 0) - Number(b.confidence || 0);
  if (Math.abs(confidenceDelta) > 0.001) return confidenceDelta >= 0 ? a : b;
  return a;
};

const findFieldOverlapIssues = (fields = [], pageMetrics = { 1: PAGE_FALLBACK }) => {
  const issues = [];
  for (let i = 0; i < fields.length; i += 1) {
    for (let j = i + 1; j < fields.length; j += 1) {
      const stats = overlapStats(fields[i], fields[j], pageMetrics);
      if (!shouldFlagOverlap(fields[i], fields[j], stats)) continue;
      issues.push({ a: fields[i], b: fields[j], stats });
    }
  }
  return issues;
};

const sanitizeOverlappedTextFields = (fields = [], pageMetrics = { 1: PAGE_FALLBACK }) => {
  let next = [...fields];
  const removed = [];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < next.length && !changed; i += 1) {
      for (let j = i + 1; j < next.length && !changed; j += 1) {
        const a = next[i];
        const b = next[j];
        const stats = overlapStats(a, b, pageMetrics);
        if (!stats) continue;

        let remove = null;
        let keep = null;
        if (a.type === 'text' && b.type === 'text' && stats.smallerRatio >= TEXT_OVERLAP_LIMIT) {
          keep = preferredField(a, b);
          remove = keep.id === a.id ? b : a;
        } else if (a.type === 'text' && stats.aRatio >= TEXT_OVERLAP_LIMIT) {
          remove = a;
          keep = b;
        } else if (b.type === 'text' && stats.bRatio >= TEXT_OVERLAP_LIMIT) {
          remove = b;
          keep = a;
        }

        if (remove) {
          removed.push({ removed: remove, kept: keep });
          next = next.filter((field) => field.id !== remove.id);
          changed = true;
        }
      }
    }
  }

  return { fields: next, removed, issues: findFieldOverlapIssues(next, pageMetrics) };
};

const median = (values = []) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const guideAxisForEdge = (edge) =>
  edge === 'top' || edge === 'bottom' ? 'horizontal' : 'vertical';

const fieldEdgeValue = (entry, edge) => {
  if (edge === 'right') return entry.rect.right;
  if (edge === 'top') return entry.rect.y;
  if (edge === 'bottom') return entry.rect.bottom;
  return entry.rect.x;
};

const fieldAlignmentTarget = (items = [], edge = 'left', activeFieldId = null) => {
  const anchors = activeFieldId && items.length > 1
    ? items.filter((entry) => entry.field.id !== activeFieldId)
    : items;

  if (anchors.length === 1) return fieldEdgeValue(anchors[0], edge);

  return median(anchors.map((entry) => fieldEdgeValue(entry, edge)));
};

const fieldAlignmentGuideBounds = (items = [], axis = 'vertical') => {
  if (axis === 'horizontal') {
    const left = Math.max(0, Math.min(...items.map((entry) => entry.rect.x)) - FIELD_ALIGNMENT_SNAP_DISTANCE);
    const right = Math.min(1, Math.max(...items.map((entry) => entry.rect.right)) + FIELD_ALIGNMENT_SNAP_DISTANCE);
    return {
      left,
      width: Math.max(0.04, right - left),
    };
  }

  const top = Math.max(0, Math.min(...items.map((entry) => entry.rect.y)) - FIELD_ALIGNMENT_SNAP_DISTANCE);
  const bottom = Math.min(1, Math.max(...items.map((entry) => entry.rect.bottom)) + FIELD_ALIGNMENT_SNAP_DISTANCE);
  return {
    top,
    height: Math.max(0.04, bottom - top),
  };
};

const fieldAlignmentClusters = (items = [], edge = 'left') => {
  const clusters = [];
  [...items]
    .sort((a, b) => fieldEdgeValue(a, edge) - fieldEdgeValue(b, edge))
    .forEach((item) => {
      const value = fieldEdgeValue(item, edge);
      const cluster = clusters.find((candidate) =>
        Math.abs(candidate.anchor - value) <= FIELD_ALIGNMENT_GROUP_DISTANCE
      );
      if (cluster) {
        cluster.items.push(item);
        cluster.anchor = median(cluster.items.map((entry) => fieldEdgeValue(entry, edge)));
      } else {
        clusters.push({ anchor: value, items: [item] });
      }
    });
  return clusters;
};

const findFieldAlignmentGuides = (fields = [], pageMetrics = { 1: PAGE_FALLBACK }, activeFieldId = null) => {
  const activeField = fields.find((field) => field.id === activeFieldId);
  const activeSignerKey = activeField ? fieldSignerKey(activeField) : null;
  const edges = activeField?.type === 'initials'
    ? ['left', 'right', 'top', 'bottom']
    : ['left', 'right'];
  const groupsBySigner = new Map();

  fields
    .forEach((field) => {
      if (activeSignerKey && fieldSignerKey(field) !== activeSignerKey) return;
      const rect = normalizedRect(field, pageMetrics);
      const key = fieldSignerKey(field);
      if (!groupsBySigner.has(key)) groupsBySigner.set(key, []);
      groupsBySigner.get(key).push({ field, rect });
    });

  const issues = [];
  const guidesByPage = new Map();

  for (const groupFields of groupsBySigner.values()) {
    edges.forEach((edge) => {
      const axis = guideAxisForEdge(edge);
      const candidates = axis === 'horizontal'
        ? groupFields.filter((entry) => entry.field.type === 'initials')
        : groupFields;

      fieldAlignmentClusters(candidates, edge)
        .filter((cluster) => cluster.items.length >= 2)
        .forEach((cluster) => {
          const target = fieldAlignmentTarget(cluster.items, edge, activeFieldId);
          const misaligned = cluster.items.filter((entry) =>
            Math.abs(fieldEdgeValue(entry, edge) - target) > FIELD_ALIGNMENT_TOLERANCE
          );
          const status = misaligned.length ? 'warning' : 'aligned';
          const pages = [...new Set(cluster.items.map((entry) => entry.rect.page))];

          pages.forEach((page) => {
            const pageItems = cluster.items.filter((entry) => entry.rect.page === page);
            const bounds = fieldAlignmentGuideBounds(pageItems, axis);
            const guide = {
              page,
              axis,
              edge,
              value: target,
              ...bounds,
              status,
              ids: cluster.items.map((entry) => entry.field.id),
            };
            if (!guidesByPage.has(page)) guidesByPage.set(page, []);
            guidesByPage.get(page).push(guide);
          });

          misaligned.forEach((entry) => {
            issues.push({
              field: entry.field,
              edge,
              delta: fieldEdgeValue(entry, edge) - target,
            });
          });
        });
    });
  }

  return { issues, guidesByPage };
};

const roundFieldGeometry = (geometry) => ({
  ...geometry,
  x: Number(geometry.x.toFixed(6)),
  y: Number(geometry.y.toFixed(6)),
  width: Number(geometry.width.toFixed(6)),
  height: Number(geometry.height.toFixed(6)),
});

const fieldSnapTargets = (field, fields = [], pageMetrics = { 1: PAGE_FALLBACK }) => {
  const signerKey = fieldSignerKey(field);

  return fields
    .filter((candidate) =>
      candidate.id !== field.id &&
      fieldSignerKey(candidate) === signerKey
    )
    .flatMap((candidate) => {
      const rect = normalizedRect(candidate, pageMetrics);
      const targets = [
        { side: 'left', x: rect.x },
        { side: 'right', x: rect.right },
      ];
      if (field.type === 'initials' && candidate.type === 'initials') {
        targets.push(
          { side: 'top', y: rect.y },
          { side: 'bottom', y: rect.bottom }
        );
      }
      return targets;
    });
};

const snapFieldGeometry = (field, geometry, fields = [], pageMetrics = { 1: PAGE_FALLBACK }, mode = 'move') => {
  const targets = fieldSnapTargets(field, fields, pageMetrics);
  if (!targets.length) return roundFieldGeometry(geometry);

  const current = {
    ...geometry,
    x: clamp(geometry.x, 0, 1 - geometry.width),
    y: clamp(geometry.y, 0, 1 - geometry.height),
    width: clamp(geometry.width, 0.018, 1),
    height: clamp(geometry.height, 0.018, 1),
  };
  current.width = clamp(current.width, 0.018, 1 - current.x);
  current.height = clamp(current.height, 0.018, 1 - current.y);

  let bestX = null;
  let bestY = null;

  const consider = (side, targetX, nextGeometry) => {
    const distance = Math.abs((side === 'right' ? current.x + current.width : current.x) - targetX);
    if (distance > FIELD_ALIGNMENT_SNAP_DISTANCE) return;
    if (!bestX || distance < bestX.distance) bestX = { distance, geometry: nextGeometry };
  };

  const considerY = (side, targetY, nextGeometry) => {
    const distance = Math.abs((side === 'bottom' ? current.y + current.height : current.y) - targetY);
    if (distance > FIELD_ALIGNMENT_SNAP_DISTANCE) return;
    if (!bestY || distance < bestY.distance) bestY = { distance, geometry: nextGeometry };
  };

  for (const target of targets) {
    if (mode === 'resize') {
      if (target.side === 'right') {
        const width = target.x - current.x;
        if (width >= 0.018 && current.x + width <= 1) {
          consider('right', target.x, { ...current, width });
        }
      } else if (target.side === 'bottom') {
        const height = target.y - current.y;
        if (height >= 0.018 && current.y + height <= 1) {
          considerY('bottom', target.y, { ...current, height });
        }
      }
      continue;
    }

    if (target.side === 'left') {
      consider('left', target.x, {
        ...current,
        x: clamp(target.x, 0, 1 - current.width),
      });
    } else if (target.side === 'right') {
      const snappedX = target.x - current.width;
      if (snappedX < 0 || snappedX > 1 - current.width) continue;
      consider('right', target.x, {
        ...current,
        x: snappedX,
      });
    } else if (target.side === 'top') {
      considerY('top', target.y, {
        ...current,
        y: clamp(target.y, 0, 1 - current.height),
      });
    } else if (target.side === 'bottom') {
      const snappedY = target.y - current.height;
      if (snappedY < 0 || snappedY > 1 - current.height) continue;
      considerY('bottom', target.y, {
        ...current,
        y: snappedY,
      });
    }
  }

  const snapped = { ...current };
  if (bestX?.geometry) {
    snapped.x = bestX.geometry.x;
    snapped.width = bestX.geometry.width;
  }
  if (bestY?.geometry) {
    snapped.y = bestY.geometry.y;
    snapped.height = bestY.geometry.height;
  }

  return roundFieldGeometry(snapped);
};

const normalizedGeometryPatch = (field, pageMetrics, target) => {
  const metric = pageMetric(pageMetrics, field.page);
  const current = toNormalizedGeometry(field, metric);
  const next = {
    x: Number(clamp(target.x, 0, 1 - current.width).toFixed(6)),
    y: Number(clamp(target.y, 0, 1 - current.height).toFixed(6)),
    width: Number(clamp(target.width ?? current.width, 0.015, 1).toFixed(6)),
    height: Number(clamp(target.height ?? current.height, 0.015, 1).toFixed(6)),
  };

  next.x = Number(clamp(next.x, 0, 1 - next.width).toFixed(6));
  next.y = Number(clamp(next.y, 0, 1 - next.height).toFixed(6));

  if (
    Math.abs(current.x - next.x) <= INITIALS_ALIGNMENT_TOLERANCE &&
    Math.abs(current.y - next.y) <= INITIALS_ALIGNMENT_TOLERANCE &&
    Math.abs(current.width - next.width) <= INITIALS_ALIGNMENT_TOLERANCE &&
    Math.abs(current.height - next.height) <= INITIALS_ALIGNMENT_TOLERANCE &&
    field.coordinateOrigin === 'normalized'
  ) {
    return field;
  }

  return {
    ...field,
    ...next,
    coordinateOrigin: 'normalized',
  };
};

const alignInitialsToPreviousPages = (fields = [], pageMetrics = { 1: PAGE_FALLBACK }, changedFieldId = null) => {
  const initials = fields.filter((field) => field.type === 'initials');
  if (initials.length < 2) return fields;

  const bySigner = new Map();
  initials.forEach((field) => {
    const key = fieldSignerKey(field);
    if (!bySigner.has(key)) bySigner.set(key, []);
    bySigner.get(key).push(field);
  });

  const replacements = new Map();

  for (const group of bySigner.values()) {
    const ordered = [...group].sort((a, b) => {
      const ap = Number(a.page || 1);
      const bp = Number(b.page || 1);
      if (ap !== bp) return ap - bp;
      const ag = toNormalizedGeometry(a, pageMetric(pageMetrics, ap));
      const bg = toNormalizedGeometry(b, pageMetric(pageMetrics, bp));
      return ag.y - bg.y || ag.x - bg.x;
    });

    let previousPage = null;
    let previousGeometry = null;
    for (const field of ordered) {
      const page = Number(field.page || 1);
      const current = replacements.get(field.id) || field;
      const currentGeometry = toNormalizedGeometry(current, pageMetric(pageMetrics, page));

      if (previousGeometry && page !== previousPage) {
        const shouldAlign =
          !changedFieldId ||
          field.id === changedFieldId ||
          ordered.some((candidate) => candidate.id === changedFieldId && Number(candidate.page || 1) <= page);

        if (shouldAlign) {
          const aligned = normalizedGeometryPatch(current, pageMetrics, previousGeometry);
          replacements.set(field.id, aligned);
          previousGeometry = toNormalizedGeometry(aligned, pageMetric(pageMetrics, page));
        } else {
          previousGeometry = currentGeometry;
        }
      } else {
        previousGeometry = currentGeometry;
      }

      previousPage = page;
    }
  }

  if (!replacements.size) return fields;

  let changed = false;
  const next = fields.map((field) => {
    const replacement = replacements.get(field.id);
    if (!replacement || replacement === field) return field;
    changed = true;
    return replacement;
  });

  return changed ? next : fields;
};


// ── Component ─────────────────────────────────────────────────────────────────

export default function SigningEnvelope() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const envelopeMode = searchParams.get('mode');
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

  const [step, setStep] = useState(() => initialEnvelopeStep(envelopeMode, initFields(doc)));
  const [signers, setSigners] = useState(() => initSigners(doc));
  const [fields, setFields] = useState(() => initFields(doc));
  const [selId, setSelId] = useState(null);
  const [activeSi, setActiveSi] = useState(0);
  const [signingOrder, setSigningOrder] = useState('parallel');
  const [message, setMessage] = useState('');
  const [evidenceMode, setEvidenceMode] = useState(() => doc?.signingEvidence?.mode || 'standard');
  const [ronConfig, setRonConfig] = useState(() => ({
    ...emptyRonConfig(),
    ...(doc?.signingEvidence?.ron || {}),
    notary: {
      ...emptyRonConfig().notary,
      ...(doc?.signingEvidence?.ron?.notary || {}),
    },
  }));
  const [ronActionBusy, setRonActionBusy] = useState('');
  const [ronRecordingReference, setRonRecordingReference] = useState('');
  const [ronRecordingFile, setRonRecordingFile] = useState(null);
  const [ronStampFile, setRonStampFile] = useState(null);
  const [ronStampUploading, setRonStampUploading] = useState(false);
  const [saDocumentType, setSaDocumentType] = useState(() => doc?.signingEvidence?.saDocumentType || '');
  const [apostilleRequired, setApostilleRequired] = useState(() => Boolean(doc?.signingEvidence?.apostilleRequired));
  const [sessionSchedule, setSessionSchedule] = useState('immediate'); // 'immediate' | 'scheduled'
  const [scheduledAt, setScheduledAt] = useState(() => {
    const raw = doc?.signingEvidence?.scheduledAt || doc?.signingEvidence?.ron?.session?.scheduledAt;
    return raw ? new Date(raw).toISOString().slice(0, 16) : '';
  });
  const [trailOpen, setTrailOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepSummary, setPrepSummary] = useState(null);
  const [error, setError] = useState('');
  const [devPreview, setDevPreview] = useState(null);
  const [activeGuideFieldId, setActiveGuideFieldId] = useState(null);

  const canvasWrapRef = useRef(null);
  const docxMeasureRef = useRef(null);
  const dragRef = useRef(null);

  const handlePdfLoad = useCallback(({ pageCount: loadedPageCount, pageMetrics: loadedMetrics }) => {
    setPageCount(Math.max(1, loadedPageCount || 1));
    setPageMetrics(Object.keys(loadedMetrics || {}).length ? loadedMetrics : { 1: PAGE_FALLBACK });
  }, []);

  useEffect(() => {
    if (!doc) return;
    const nextFields = initFields(doc);
    setSigners(initSigners(doc));
    setFields(nextFields);
    setEvidenceMode(doc.signingEvidence?.mode || 'standard');
    setRonConfig({
      ...emptyRonConfig(),
      ...(doc.signingEvidence?.ron || {}),
      notary: {
        ...emptyRonConfig().notary,
        ...(doc.signingEvidence?.ron?.notary || {}),
      },
    });
    setStep(initialEnvelopeStep(envelopeMode, nextFields));
  }, [docId, doc, envelopeMode]);

  const selField = fields.find((f) => f.id === selId) ?? null;
  const ronMissingFields = useMemo(() => {
    if (evidenceMode !== 'ron') return [];
    const notary = ronConfig.notary || {};
    const required = [
      ['notary full name', notary.name],
      ['notary email', notary.email],
      ['High Court province', notary.province],
      ['admission or commission number', notary.admissionNumber],
      ['commission expiration date', notary.commissionExpiresAt],
      ['notarial venue or city', notary.venue],
    ];
    return required.filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
  }, [evidenceMode, ronConfig]);
  const canStep1 = signers.length > 0 && signers.every((s) => s.email && s.name) && ronMissingFields.length === 0;
  const previewKind = pdfBlob ? 'pdf' : docxHtml ? 'docx' : fileRecord?.blob ? 'file' : 'none';
  const fieldOverlapIssues = useMemo(() => findFieldOverlapIssues(fields, pageMetrics), [fields, pageMetrics]);
  const overlappingFieldIds = useMemo(
    () => new Set(fieldOverlapIssues.flatMap((issue) => [issue.a.id, issue.b.id])),
    [fieldOverlapIssues],
  );
  const fieldAlignment = useMemo(
    () => activeGuideFieldId
      ? findFieldAlignmentGuides(fields, pageMetrics, activeGuideFieldId)
      : { issues: [], guidesByPage: new Map() },
    [activeGuideFieldId, fields, pageMetrics],
  );
  const misalignedGuideFieldIds = useMemo(
    () => new Set(fieldAlignment.issues.map((issue) => issue.field.id)),
    [fieldAlignment],
  );
  const canProceedFromFields = fields.length > 0 && fields.every((field) => field.assignedTo) && fieldOverlapIssues.length === 0;
  const docxMetric = docxHtml?.metrics || PAGE_FALLBACK;
  const selectedTrailOption = TRAIL_OPTIONS.find((option) => option.value === evidenceMode) || TRAIL_OPTIONS[0];
  const selectedRonIdentity = RON_IDENTITY_OPTIONS.find((option) => option.value === ronConfig.identityMethod) || RON_IDENTITY_OPTIONS[0];
  const ronSession = doc?.signingEvidence?.ron?.session || ronConfig.session || null;
  const ronIdentityRecords = Array.isArray(doc?.signingEvidence?.ron?.identity?.signers)
    ? doc.signingEvidence.ron.identity.signers
    : Object.values(doc?.signingEvidence?.ron?.identity?.signers || {});

  const updateRonNotary = (key, value) => {
    setRonConfig((current) => ({
      ...current,
      notary: {
        ...(current.notary || {}),
        [key]: value,
      },
    }));
  };

  const updateRonSession = async (action, payload = {}) => {
    if (!isMongoId(docId)) {
      setError('Save this document to the signing system before starting a RON session.');
      return;
    }
    setError('');
    setRonActionBusy(action);
    try {
      const result = await signingApi.ronSession(docId, { action, ...payload });
      setRemoteDoc((current) => ({
        ...(current || doc || {}),
        signingEvidence: result.signingEvidence || current?.signingEvidence || doc?.signingEvidence,
      }));
      setRonConfig((current) => ({
        ...current,
        ...(result.signingEvidence?.ron || {}),
        notary: {
          ...(current.notary || {}),
          ...(result.signingEvidence?.ron?.notary || {}),
        },
      }));
    } catch (err) {
      setError(err.message || 'Could not update the RON session.');
    } finally {
      setRonActionBusy('');
    }
  };

  const uploadRonRecording = async () => {
    if (!ronRecordingFile) {
      setError('Choose the RON session recording file first.');
      return;
    }
    if (!isMongoId(docId)) {
      setError('Save this document to the signing system before storing a RON recording.');
      return;
    }
    setError('');
    setRonActionBusy('recording');
    try {
      const formData = new FormData();
      formData.append('recording', ronRecordingFile);
      const result = await signingApi.ronRecording(docId, formData);
      setRemoteDoc((current) => ({
        ...(current || doc || {}),
        signingEvidence: result.signingEvidence || current?.signingEvidence || doc?.signingEvidence,
      }));
      setRonRecordingFile(null);
    } catch (err) {
      setError(err.message || 'Could not store the RON recording.');
    } finally {
      setRonActionBusy('');
    }
  };

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
    setFields((f) => alignInitialsToPreviousPages([
      ...f,
      {
        ...createField({ type: ft.type, signer, page: activePage, x, y }),
        id,
      },
    ], pageMetrics, id));
    setSelId(id);
  }, [signers, activeSi, activePage, pageMetrics]);

  const addFieldAtPoint = useCallback((ft, clientX, clientY) => {
    const pageEl = pageElementFromPoint(clientX, clientY);
    if (!pageEl) return;
    const signer = signers[activeSi];
    const base = createField({ type: ft.type, signer, page: Number(pageEl.dataset.envPageNumber) || 1 });
    const dropped = geometryFromPoint(clientX, clientY, base, pageEl);
    if (!dropped) return;
    const id = uid();
    setFields((current) => alignInitialsToPreviousPages([
      ...current,
      {
        ...base,
        ...dropped,
        id,
        coordinateOrigin: 'normalized',
      },
    ], pageMetrics, id));
    setActivePage(dropped.page);
    setSelId(id);
  }, [activeSi, geometryFromPoint, pageElementFromPoint, pageMetrics, signers]);

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
    setActiveGuideFieldId(fieldId);
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
      setFields((prev) => {
        const moved = prev.map((f) => {
          if (f.id !== d.fieldId) return f;
          if (d.mode === 'resize') {
            const width = clamp(d.start.width + dx, 0.018, 1 - d.start.x);
            const height = clamp(d.start.height + dy, 0.018, 1 - d.start.y);
            const next = snapFieldGeometry(
              f,
              {
                page: f.page,
                x: d.start.x,
                y: d.start.y,
                width,
                height,
              },
              prev,
              pageMetrics,
              'resize'
            );
            return {
              ...f,
              ...next,
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
              const movingField = {
                ...f,
                page: next.page,
                width: d.start.width,
                height: d.start.height,
                coordinateOrigin: 'normalized',
              };
              const snapped = snapFieldGeometry(
                movingField,
                {
                  ...next,
                  width: d.start.width,
                  height: d.start.height,
                },
                prev,
                pageMetrics,
                'move'
              );
              setActivePage(next.page);
              return {
                ...f,
                ...snapped,
                coordinateOrigin: 'normalized',
              };
            }
          }
          const next = snapFieldGeometry(
            f,
            {
              page: f.page,
              x: clamp(d.start.x + dx, 0, 1 - d.start.width),
              y: clamp(d.start.y + dy, 0, 1 - d.start.height),
              width: d.start.width,
              height: d.start.height,
            },
            prev,
            pageMetrics,
            'move'
          );
          return {
            ...f,
            ...next,
            coordinateOrigin: 'normalized',
          };
        });
        return moved;
      });
    };

    const onUp = () => {
      dragRef.current = null;
      setActiveGuideFieldId(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
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
    if (!canStep1) {
      if (ronMissingFields.length) setError(`Complete RON setup: ${ronMissingFields.join(', ')}.`);
      return;
    }

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
        evidenceMode,
        ronConfig,
      };
      const prepared = await signingApi.prepare(targetDocId, payload);
      const preparedFields = prepared.fields || prepared.document?.signingFields || [];
      const cleanedLayout = sanitizeOverlappedTextFields(initFields({ signingFields: preparedFields }), pageMetrics);
      const alignedFields = alignInitialsToPreviousPages(cleanedLayout.fields, pageMetrics);

      setRemoteDoc(prepared.document || targetDoc);
      setFields(alignedFields);
      setPrepSummary({
        fieldCount: alignedFields.length,
        removedFieldCount: cleanedLayout.removed.length,
        overlapCount: cleanedLayout.issues.length,
        status: prepared.preparation?.status,
        reviewRequired: Boolean(prepared.preparation?.reviewRequired),
      });
      if (cleanedLayout.issues.length) {
        setError('Some detected fields still overlap. Move or remove the highlighted fields before sending.');
      }
      setStep(2);

      if (targetDocId !== docId || envelopeMode !== 'review') {
        navigate(`/signing/envelope/${targetDocId}?mode=review`, { replace: true });
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
    if (ronMissingFields.length) { setError(`Complete RON setup: ${ronMissingFields.join(', ')}.`); setStep(1); return; }
    if (!fields.length) { setError('Add at least one field before sending this envelope.'); return; }
    if (fields.some((field) => !field.assignedTo)) { setError('Every field must be assigned to a signer.'); return; }
    const cleanedLayout = sanitizeOverlappedTextFields(fields, pageMetrics);
    if (cleanedLayout.removed.length) {
      setFields(cleanedLayout.fields);
      setSelId(null);
    }
    if (cleanedLayout.issues.length) {
      setStep(2);
      setSelId(cleanedLayout.issues[0].a.id);
      setError('Resolve overlapping fields before sending. Text fields cannot be hidden behind signature, date, or other text fields.');
      return;
    }
    setSending(true);
    try {
      const normalizedFields = cleanedLayout.fields.map((field) => normalizeFieldForStorage(field, pageMetrics));
      const payload = {
        signers: signers.map((s) => ({ name: s.name, email: s.email, role: s.role, userId: s.userId || undefined })),
        fields: normalizedFields,
        pageMetrics,
        signingOrder,
        message,
        evidenceMode,
        ronConfig,
        // SA-specific notarization fields
        ...(evidenceMode === 'ron' ? {
          saDocumentType: saDocumentType || undefined,
          apostilleRequired,
          scheduledAt: sessionSchedule === 'scheduled' && scheduledAt ? scheduledAt : undefined,
        } : {}),
      };
      if (isMongoId(docId)) {
        const result = await signingApi.requestSigning(docId, payload);
        if (result?.devPreview?.enabled) {
          setDevPreview(result.devPreview);
          setSending(false);
          return;
        }
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
    const hasOverlap = overlappingFieldIds.has(field.id);
    const isMisalignedGuideField = activeGuideFieldId && misalignedGuideFieldIds.has(field.id);
    const fieldTitle = hasOverlap
      ? 'This field overlaps another field. Move or remove it before sending.'
      : isMisalignedGuideField
        ? 'This field is not aligned with nearby fields.'
        : undefined;

    return (
      <div
        key={field.id}
        className={`env-fbox env-fbox--${field.type}${isSel ? ' env-fbox--sel' : ''}${hasOverlap ? ' env-fbox--overlap' : ''}${isMisalignedGuideField ? ' env-fbox--misaligned' : ''}`}
        style={{
          ...fieldPercentStyle(field, metric),
          '--fc': color,
        }}
        title={fieldTitle}
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
    const guides = fieldAlignment.guidesByPage.get(pageNumber) || [];
    return (
      <div
        className="env-page-overlay"
        onClick={() => setSelId(null)}
        onDragOver={onPageDragOver}
        onDrop={onPageDrop}
      >
        {guides.map((guide) => (
          <span
            key={`${pageNumber}_${guide.edge}_${guide.ids.join('_')}`}
            className={`env-align-guide env-align-guide--${guide.axis} env-align-guide--${guide.edge} env-align-guide--${guide.status}`}
            style={guide.axis === 'horizontal'
              ? {
                  top: `${guide.value * 100}%`,
                  left: `${guide.left * 100}%`,
                  width: `${guide.width * 100}%`,
                }
              : {
                  left: `${guide.value * 100}%`,
                  top: `${guide.top * 100}%`,
                  height: `${guide.height * 100}%`,
                }}
            aria-hidden="true"
          />
        ))}
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

              <div className="env-trail-control">
                <button
                  type="button"
                  className="env-trail-button"
                  onClick={() => setTrailOpen((open) => !open)}
                  aria-expanded={trailOpen}
                >
                  <span>Trail</span>
                  <strong>{selectedTrailOption.title}</strong>
                </button>
                {trailOpen && (
                  <div className="env-trail-menu">
                    {TRAIL_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`env-trail-option${evidenceMode === option.value ? ' env-trail-option--active' : ''}`}
                        onClick={() => {
                          setEvidenceMode(option.value);
                          setTrailOpen(false);
                        }}
                      >
                        <span>{option.title}</span>
                        <small>{option.desc}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {evidenceMode === 'ron' && (
                <div className="env-ron-panel">
                  <div className="env-ron-head">
                    <div>
                      <h3>South African Notarization</h3>
                      <p>Remote notarization session conducted by a Notary Public admitted by the High Court of South Africa. The session will be recorded and the document sealed with the notary stamp.</p>
                    </div>
                    <span>Live A/V</span>
                  </div>

                  <div className="env-ron-section-label">Notary Public details</div>
                  <div className="env-ron-grid">
                    <label className="env-field env-field--grow">
                      <span>Notary full name *</span>
                      <input
                        value={ronConfig.notary?.name || ''}
                        onChange={(e) => updateRonNotary('name', e.target.value)}
                        placeholder="As it appears on High Court admission"
                      />
                    </label>
                    <label className="env-field env-field--grow">
                      <span>Notary email *</span>
                      <input
                        type="email"
                        value={ronConfig.notary?.email || ''}
                        onChange={(e) => updateRonNotary('email', e.target.value)}
                        placeholder="notary@example.co.za"
                      />
                    </label>
                    <label className="env-field">
                      <span>High Court Province *</span>
                      <select
                        value={ronConfig.notary?.province || ''}
                        onChange={(e) => updateRonNotary('province', e.target.value)}
                      >
                        <option value="">Select province</option>
                        {SA_PROVINCES.map((p) => (
                          <option key={p.code} value={p.code}>{p.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="env-field env-field--grow">
                      <span>Admission / Commission No. *</span>
                      <input
                        value={ronConfig.notary?.admissionNumber || ''}
                        onChange={(e) => updateRonNotary('admissionNumber', e.target.value)}
                        placeholder="High Court admission number"
                      />
                    </label>
                    <label className="env-field">
                      <span>Commission expires *</span>
                      <input
                        type="date"
                        value={ronConfig.notary?.commissionExpiresAt || ''}
                        onChange={(e) => updateRonNotary('commissionExpiresAt', e.target.value)}
                      />
                    </label>
                    <label className="env-field env-field--grow">
                      <span>Notarial venue / city *</span>
                      <input
                        value={ronConfig.notary?.venue || ''}
                        onChange={(e) => updateRonNotary('venue', e.target.value)}
                        placeholder="e.g. Johannesburg, Cape Town"
                      />
                    </label>
                  </div>

                  <div className="env-ron-section-label">Document type</div>
                  <div className="env-ron-grid">
                    <label className="env-field env-field--grow">
                      <span>SA notarial document type</span>
                      <select value={saDocumentType} onChange={(e) => setSaDocumentType(e.target.value)}>
                        <option value="">Select type (optional)</option>
                        {SA_DOCUMENT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="env-field env-field--grow">
                      <span>Apostille required</span>
                      <select value={apostilleRequired ? 'yes' : 'no'} onChange={(e) => setApostilleRequired(e.target.value === 'yes')}>
                        <option value="no">No — for use in South Africa only</option>
                        <option value="yes">Yes — document will be used abroad (DIRCO Apostille)</option>
                      </select>
                    </label>
                  </div>

                  <div className="env-ron-section-label">Session scheduling</div>
                  <div className="env-ron-schedule">
                    <div className="env-ron-choice-row">
                      {[
                        { value: 'immediate', label: 'Sign immediately', desc: 'Send the link now — the notary and client can join at any time.' },
                        { value: 'scheduled', label: 'Schedule a date & time', desc: 'Book a specific time for the live notarization session.' },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`env-ron-choice${sessionSchedule === opt.value ? ' env-ron-choice--active' : ''}`}
                          onClick={() => setSessionSchedule(opt.value)}
                        >
                          <strong>{opt.label}</strong>
                          <small>{opt.desc}</small>
                        </button>
                      ))}
                    </div>
                    {sessionSchedule === 'scheduled' && (
                      <label className="env-field" style={{ marginTop: '12px' }}>
                        <span>Session date &amp; time (SA time — SAST, UTC+2)</span>
                        <input
                          type="datetime-local"
                          value={scheduledAt}
                          min={new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 16)}
                          onChange={(e) => setScheduledAt(e.target.value)}
                        />
                      </label>
                    )}
                  </div>

                  <div className="env-ron-section-label">Signer identity proofing</div>
                  <div className="env-ron-identity">
                    <div className="env-ron-choice-row">
                      {RON_IDENTITY_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`env-ron-choice${ronConfig.identityMethod === option.value ? ' env-ron-choice--active' : ''}`}
                          onClick={() => setRonConfig((current) => ({ ...current, identityMethod: option.value }))}
                        >
                          <strong>{option.label}</strong>
                          <small>{option.desc}</small>
                        </button>
                      ))}
                    </div>
                  </div>

                  {ronMissingFields.length > 0 && (
                    <div className="env-ron-warning">
                      Please complete: {ronMissingFields.join(', ')}.
                    </div>
                  )}
                </div>
              )}

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
                {preparing ? 'Detecting fields...' : 'Next →'}
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
                      className="env-ftype-btn"
                      onClick={() => addField(ft)}
                      draggable
                      onDragStart={(event) => onPaletteDragStart(event, ft)}
                      title={ft.desc}
                    >
                      {ft.icon && ft.icon !== ft.label && <span className="env-ftype-icon">{ft.icon}</span>}
                      <span className="env-ftype-label">{ft.label}</span>
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
              {prepSummary?.removedFieldCount > 0 && ` · removed ${prepSummary.removedFieldCount} hidden text field${prepSummary.removedFieldCount === 1 ? '' : 's'}`}
              {fieldOverlapIssues.length > 0 && ` · ${fieldOverlapIssues.length} overlap${fieldOverlapIssues.length === 1 ? '' : 's'} to fix`}
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
              <h2>Audit Trail Evidence</h2>
              <div className="env-review-row">
                <div className="env-flow-bubble env-flow-bubble--final">T</div>
                <div className="env-review-info">
                  <div className="env-review-name">{selectedTrailOption.title}</div>
                  <div className="env-review-meta">
                    {selectedTrailOption.desc}
                    {evidenceMode === 'ron' && ronConfig.notary?.name
                      ? ` Notary: ${ronConfig.notary.name} (${SA_PROVINCES.find(p => p.code === ronConfig.notary.province)?.name || ronConfig.notary.province || 'province pending'}). Identity: ${selectedRonIdentity.label}.`
                      : ''}
                  </div>
                </div>
                <button
                  className="env-review-edit"
                  onClick={() => setStep(1)}
                  title="Edit audit trail evidence"
                >
                  Edit
                </button>
              </div>

              {evidenceMode === 'ron' && (
                <div className="env-ron-session-panel">
                  <div className="env-ron-session-head">
                    <div>
                      <h3>Live notarization session</h3>
                      <p>
                        Status: <strong>{ronSession?.status || 'created'}</strong>
                        {ronSession?.scheduledAt && ` · Scheduled: ${new Date(ronSession.scheduledAt).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}`}
                        {' · '}Recording: {ronSession?.recordingStatus || 'pending'}
                      </p>
                    </div>
                    {ronSession?.meetingUrl && (
                      <a href={ronSession.meetingUrl} target="_blank" rel="noreferrer" className="env-review-edit">
                        Open Room
                      </a>
                    )}
                  </div>

                  {/* Notary workflow: schedule → start → verify identity → client signs → stamp → seal → end */}
                  <div className="env-ron-workflow">
                    <div className={`env-ron-step${ronSession?.scheduledAt || ronSession?.notaryStartedAt ? ' env-ron-step--done' : ''}`}>
                      <span>1</span>Schedule session
                    </div>
                    <div className={`env-ron-step${ronSession?.notaryStartedAt ? ' env-ron-step--done' : ''}`}>
                      <span>2</span>Start live session
                    </div>
                    <div className={`env-ron-step${ronIdentityRecords.some(r => r.status === 'verified') ? ' env-ron-step--done' : ''}`}>
                      <span>3</span>Verify signer identity
                    </div>
                    <div className={`env-ron-step${ronSession?.recordingStatus === 'stored' ? ' env-ron-step--done' : ''}`}>
                      <span>4</span>Client signs
                    </div>
                    <div className={`env-ron-step${doc?.signingEvidence?.ron?.notaryStamp?.appliedAt ? ' env-ron-step--done' : ''}`}>
                      <span>5</span>Apply stamp
                    </div>
                    <div className={`env-ron-step${ronSession?.status === 'completed' ? ' env-ron-step--done' : ''}`}>
                      <span>6</span>End session
                    </div>
                  </div>

                  <div className="env-ron-session-actions">
                    {(!ronSession?.scheduledAt && ronSession?.status !== 'live') && (
                      <button
                        type="button"
                        className="env-btn env-btn--ghost env-btn--sm"
                        disabled={ronActionBusy === 'start'}
                        onClick={() => updateRonSession('start')}
                      >
                        {ronActionBusy === 'start' ? 'Starting...' : 'Start Session Now'}
                      </button>
                    )}
                    {ronConfig.identityMethod === 'personal_knowledge' && signers.map((signer) => (
                      <button
                        key={signer.email}
                        type="button"
                        className="env-btn env-btn--ghost env-btn--sm"
                        disabled={ronActionBusy === 'verify_personal_knowledge'}
                        onClick={() => updateRonSession('verify_personal_knowledge', { signerEmail: signer.email })}
                      >
                        Verify {signer.name.split(' ')[0] || signer.email}
                      </button>
                    ))}

                    {/* Notary stamp upload */}
                    <div className="env-ron-stamp-row">
                      <label className="env-ron-stamp-label">
                        <strong>Notary stamp image</strong>
                        <span> (PNG/JPG, transparent background recommended)</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          onChange={(e) => setRonStampFile(e.target.files?.[0] || null)}
                          style={{ display: 'none' }}
                          id="notary-stamp-upload"
                        />
                        <label htmlFor="notary-stamp-upload" className="env-btn env-btn--ghost env-btn--sm" style={{ cursor: 'pointer' }}>
                          {ronStampFile ? ronStampFile.name : doc?.signingEvidence?.ron?.notaryStamp ? 'Replace stamp' : 'Upload stamp'}
                        </label>
                      </label>
                      {ronStampFile && (
                        <button
                          type="button"
                          className="env-btn env-btn--ghost env-btn--sm"
                          disabled={ronStampUploading || !isMongoId(docId)}
                          onClick={async () => {
                            if (!isMongoId(docId)) return;
                            setRonStampUploading(true);
                            try {
                              const form = new FormData();
                              form.append('stamp', ronStampFile);
                              await signingApi.ronStamp(docId, form);
                              setRonStampFile(null);
                            } catch (err) {
                              setError(err.message);
                            } finally {
                              setRonStampUploading(false);
                            }
                          }}
                        >
                          {ronStampUploading ? 'Uploading...' : 'Save stamp'}
                        </button>
                      )}
                      {doc?.signingEvidence?.ron?.notaryStamp?.appliedAt && (
                        <span className="env-ron-stamp-ok">✓ Stamp stored — will be embedded in finalized PDF</span>
                      )}
                    </div>

                    <button
                      type="button"
                      className="env-btn env-btn--ghost env-btn--sm"
                      disabled={ronActionBusy === 'seal'}
                      onClick={() => updateRonSession('seal', { pkiProvider: 'x509-p12' })}
                    >
                      {ronActionBusy === 'seal' ? 'Sealing...' : 'Apply PKI Seal & End Session'}
                    </button>
                  </div>
                  <div className="env-ron-recording-row">
                    <input
                      type="file"
                      accept="video/webm,video/mp4,audio/webm,audio/mp4,audio/mpeg"
                      onChange={(event) => setRonRecordingFile(event.target.files?.[0] || null)}
                    />
                    <button
                      type="button"
                      className="env-btn env-btn--ghost env-btn--sm"
                      disabled={ronActionBusy === 'recording'}
                      onClick={() => { void uploadRonRecording(); }}
                    >
                      {ronActionBusy === 'recording' ? 'Uploading...' : 'Store Recording'}
                    </button>
                    <input
                      value={ronRecordingReference}
                      onChange={(event) => setRonRecordingReference(event.target.value)}
                      placeholder="Recording reference, S3 key, or local evidence path"
                    />
                    <button
                      type="button"
                      className="env-btn env-btn--primary env-btn--sm"
                      disabled={ronActionBusy === 'complete'}
                      onClick={() => updateRonSession('complete', { recordingReference: ronRecordingReference })}
                    >
                      {ronActionBusy === 'complete' ? 'Saving...' : 'Complete Session'}
                    </button>
                  </div>
                  <div className="env-ron-identity-list">
                    {signers.map((signer) => {
                      const identity = ronIdentityRecords.find((record) =>
                        String(record.signerEmail || '').trim().toLowerCase() === String(signer.email || '').trim().toLowerCase()
                      ) || {};
                      return (
                        <span key={signer.email}>
                          {signer.name}: {identity.status || 'identity pending'}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
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

      {/* ══ DEV PREVIEW ═════════════════════════════════════════════════════ */}
      {devPreview && (
        <div className="env-scroll-area">
          <div className="env-centered-body">
            <div className="env-dev-banner">
              <span className="env-dev-badge">DEV</span>
              Signing request sent. Open each link below to simulate that signer's experience.
            </div>

            <div className="env-card">
              <h2>Signer Preview Links</h2>
              {devPreview.signers.map((s, i) => (
                <div key={i} className="env-dev-signer-row">
                  <div className="env-dev-signer-info">
                    <div className="env-dev-signer-name">{s.name}</div>
                    <div className="env-dev-signer-meta">{s.email} · <em>{s.role}</em></div>
                  </div>
                  {s.signingUrl ? (
                    <a
                      className="env-btn env-btn--primary"
                      href={s.signingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Sign as {s.name.split(' ')[0]} →
                    </a>
                  ) : (
                    <span className="env-dev-waiting">Waiting for turn</span>
                  )}
                </div>
              ))}
            </div>

            <div className="env-step-footer">
              <button className="env-btn env-btn--ghost" onClick={() => navigate('/signing')}>
                ← Back to Dashboard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
