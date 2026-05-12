const MIN_PDF_RECT_SIZE = 4;
const SIGNATURE_IMAGE_PADDING = 1.5;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const finiteNumber = (value, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const base64ToBuffer = (value) => {
  const payload = String(value || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(payload, 'base64');
};

const validDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const formatUtcTimestamp = (value) => {
  const date = validDate(value);
  if (!date) return 'Signing time unavailable';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
};

/**
 * Convert a logical placement (normalized, top-left, or pdf-origin coordinates)
 * to a clamped, validated PDF-space rectangle (bottom-left origin, points).
 *
 * Throws if the placement resolves to a zero or negative rect.
 */
const placementToPdfRect = (page, placement) => {
  const pageSize = page.getSize();
  let rect;

  if (placement.origin === 'normalized') {
    const width = finiteNumber(placement.width) * pageSize.width;
    const height = finiteNumber(placement.height) * pageSize.height;
    rect = {
      x: finiteNumber(placement.x) * pageSize.width,
      y: pageSize.height - (finiteNumber(placement.y) * pageSize.height) - height,
      width,
      height,
    };
  } else if (placement.origin === 'pdf') {
    rect = {
      x: finiteNumber(placement.x),
      y: finiteNumber(placement.y),
      width: finiteNumber(placement.width),
      height: finiteNumber(placement.height),
    };
  } else {
    rect = {
      x: finiteNumber(placement.x),
      y: pageSize.height - finiteNumber(placement.y) - finiteNumber(placement.height),
      width: finiteNumber(placement.width),
      height: finiteNumber(placement.height),
    };
  }

  const numbers = [rect.x, rect.y, rect.width, rect.height];
  if (!numbers.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    const fieldLabel = placement.field?.id ? ` field ${placement.field.id}` : '';
    throw new Error(`Invalid signing placement${fieldLabel}.`);
  }

  const width = clamp(rect.width, MIN_PDF_RECT_SIZE, pageSize.width);
  const height = clamp(rect.height, MIN_PDF_RECT_SIZE, pageSize.height);
  return {
    x: clamp(rect.x, 0, Math.max(0, pageSize.width - width)),
    y: clamp(rect.y, 0, Math.max(0, pageSize.height - height)),
    width,
    height,
  };
};

const insetRect = (rect, padding) => {
  const nextPadding = Math.max(0, Math.min(padding, rect.width / 3, rect.height / 3));
  return {
    x: rect.x + nextPadding,
    y: rect.y + nextPadding,
    width: Math.max(MIN_PDF_RECT_SIZE, rect.width - nextPadding * 2),
    height: Math.max(MIN_PDF_RECT_SIZE, rect.height - nextPadding * 2),
  };
};

const imageFitRect = (image, rect) => {
  const imageWidth = finiteNumber(image?.width, 0);
  const imageHeight = finiteNumber(image?.height, 0);
  if (imageWidth <= 0 || imageHeight <= 0) return rect;
  const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
};

module.exports = {
  MIN_PDF_RECT_SIZE,
  SIGNATURE_IMAGE_PADDING,
  clamp,
  finiteNumber,
  base64ToBuffer,
  validDate,
  formatUtcTimestamp,
  placementToPdfRect,
  insetRect,
  imageFitRect,
};
