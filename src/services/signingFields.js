export const PAGE_FALLBACK = { width: 794, height: 1123 };

export const SIGNATURE_FIELD_TYPES = new Set(['signature', 'initials']);
export const VALUE_FIELD_TYPES = new Set(['date', 'text', 'number', 'checkbox', 'radio', 'dropdown']);

export const FIELD_TYPES = [
  { type: 'signature', label: 'Signature', icon: 'Sig', width: 0.28, height: 0.064, required: true, desc: 'Full signature field' },
  { type: 'initials', label: 'Initials', icon: 'Aa', width: 0.12, height: 0.038, required: true, desc: 'Initials acknowledgement' },
  { type: 'date', label: 'Date', icon: '📅', width: 0.18, height: 0.034, required: true, desc: 'Signing date field' },
  { type: 'text', label: 'Text', icon: 'T', width: 0.24, height: 0.036, required: true, desc: 'Free text field' },
  { type: 'number', label: 'Number', icon: '123', width: 0.16, height: 0.036, required: true, desc: 'Numeric field' },
  { type: 'checkbox', label: 'Checkbox', icon: 'Check', width: 0.034, height: 0.034, required: true, desc: 'Checkbox acknowledgement' },
  { type: 'radio', label: 'Radio', icon: '◉', width: 0.034, height: 0.034, required: true, desc: 'Single-choice option' },
  { type: 'dropdown', label: 'Dropdown', icon: 'List', width: 0.22, height: 0.036, required: true, desc: 'Dropdown choice field' },
];

const byType = new Map(FIELD_TYPES.map((item) => [item.type, item]));

const finiteNumber = (value, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export const clamp = (value, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const rounded = (value) => Number(clamp(value).toFixed(6));

export const fieldTypeConfig = (type) =>
  byType.get(type) || byType.get('text');

export const pageMetric = (pageMetrics, page = 1) => {
  if (Array.isArray(pageMetrics)) {
    return pageMetrics[page - 1] || PAGE_FALLBACK;
  }
  if (pageMetrics && typeof pageMetrics === 'object') {
    return pageMetrics[page] || pageMetrics[String(page)] || PAGE_FALLBACK;
  }
  return PAGE_FALLBACK;
};

export const isNormalizedField = (field) => {
  if (field?.coordinateOrigin === 'normalized') return true;
  return ['x', 'y', 'width', 'height'].every((key) => {
    const value = Number(field?.[key]);
    return Number.isFinite(value) && Math.abs(value) <= 1;
  });
};

export const toNormalizedGeometry = (field, metric = PAGE_FALLBACK) => {
  const cfg = fieldTypeConfig(field?.type);
  const pageWidth = finiteNumber(metric?.width, PAGE_FALLBACK.width) || PAGE_FALLBACK.width;
  const pageHeight = finiteNumber(metric?.height, PAGE_FALLBACK.height) || PAGE_FALLBACK.height;

  let x = finiteNumber(field?.x, 0);
  let y = finiteNumber(field?.y, 0);
  let width = finiteNumber(field?.width, cfg.width);
  let height = finiteNumber(field?.height, cfg.height);

  if (!isNormalizedField(field)) {
    if (field?.coordinateOrigin === 'pdf') {
      x /= pageWidth;
      width /= pageWidth;
      height /= pageHeight;
      y = (pageHeight - finiteNumber(field?.y, 0) - finiteNumber(field?.height, cfg.height * pageHeight)) / pageHeight;
    } else {
      x /= pageWidth;
      y /= pageHeight;
      width /= pageWidth;
      height /= pageHeight;
    }
  }

  width = clamp(width || cfg.width, 0.015, 1);
  height = clamp(height || cfg.height, 0.015, 1);

  return {
    x: rounded(clamp(x, 0, 1 - width)),
    y: rounded(clamp(y, 0, 1 - height)),
    width: rounded(width),
    height: rounded(height),
  };
};

export const normalizeFieldForStorage = (field, pageMetrics) => {
  const page = Math.max(1, Math.round(finiteNumber(field?.page, 1)));
  const geometry = toNormalizedGeometry(field, pageMetric(pageMetrics, page));
  return {
    ...field,
    ...geometry,
    page,
    required: true,
    coordinateOrigin: 'normalized',
  };
};

export const fieldPercentStyle = (field, metric) => {
  const geometry = toNormalizedGeometry(field, metric);
  return {
    left: `${geometry.x * 100}%`,
    top: `${geometry.y * 100}%`,
    width: `${geometry.width * 100}%`,
    height: `${geometry.height * 100}%`,
  };
};

export const createField = ({ type, signer, page = 1, x = 0.5, y = 0.45 }) => {
  const cfg = fieldTypeConfig(type);
  const width = cfg.width;
  const height = cfg.height;
  return {
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    page,
    x: rounded(clamp(x - width / 2, 0, 1 - width)),
    y: rounded(clamp(y - height / 2, 0, 1 - height)),
    width,
    height,
    coordinateOrigin: 'normalized',
    assignedTo: signer?.email || '',
    role: signer?.role || '',
    required: true,
    filled: false,
    source: 'manual',
    confidence: 1,
  };
};

export const defaultFieldValue = (field, signer) => {
  if (field?.fieldValue !== undefined) return field.fieldValue;
  if (field?.type === 'checkbox' || field?.type === 'radio') return false;
  if (field?.type === 'date') return new Date().toISOString().slice(0, 10);
  if (field?.fieldMeta?.autoFill === 'name') return signer?.name || '';
  if (field?.fieldMeta?.autoFill === 'email') return signer?.email || '';
  return '';
};

export const fieldDisplayValue = (field) => {
  const value = field?.fieldValue;
  if (field?.type === 'checkbox' || field?.type === 'radio') {
    return value === true || value === 'true' ? '✓' : '';
  }
  if (value === undefined || value === null) return '';
  return String(value);
};
