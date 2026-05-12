const ALPHA_THRESHOLD = 12;
const LIGHT_PIXEL_THRESHOLD = 238;

const OUTPUT_SIZE = {
  signature: { width: 720, height: 180 },
  initials: { width: 240, height: 120 },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const isLightPixel = (red, green, blue) =>
  red >= LIGHT_PIXEL_THRESHOLD && green >= LIGHT_PIXEL_THRESHOLD && blue >= LIGHT_PIXEL_THRESHOLD;

const contentBounds = (imageData) => {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= ALPHA_THRESHOLD) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
};

const makeCleanImageData = (ctx, width, height) => {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha <= ALPHA_THRESHOLD || isLightPixel(red, green, blue)) {
      data[index + 3] = 0;
    }
  }

  return imageData;
};

export const normalizeSignatureCanvas = (sourceCanvas, options = {}) => {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null;

  const kind = options.kind === 'initials' ? 'initials' : 'signature';
  const outputSize = OUTPUT_SIZE[kind];
  const sourceCtx = sourceCanvas.getContext('2d');
  if (!sourceCtx) return null;
  const cleaned = makeCleanImageData(sourceCtx, sourceCanvas.width, sourceCanvas.height);
  const bounds = contentBounds(cleaned);
  if (!bounds) return null;

  const cleanedCanvas = window.document.createElement('canvas');
  cleanedCanvas.width = sourceCanvas.width;
  cleanedCanvas.height = sourceCanvas.height;
  const cleanedCtx = cleanedCanvas.getContext('2d');
  if (!cleanedCtx) return null;
  cleanedCtx.putImageData(cleaned, 0, 0);

  const cropPaddingX = Math.ceil((bounds.maxX - bounds.minX + 1) * (kind === 'initials' ? 0.12 : 0.06));
  const cropPaddingY = Math.ceil((bounds.maxY - bounds.minY + 1) * (kind === 'initials' ? 0.06 : 0.01));
  const cropLeft = clamp(bounds.minX - cropPaddingX, 0, sourceCanvas.width - 1);
  const cropTop = clamp(bounds.minY - cropPaddingY, 0, sourceCanvas.height - 1);
  const cropRight = clamp(bounds.maxX + cropPaddingX, cropLeft + 1, sourceCanvas.width);
  const cropBottom = clamp(bounds.maxY + cropPaddingY, cropTop + 1, sourceCanvas.height);
  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;

  const outputCanvas = window.document.createElement('canvas');
  outputCanvas.width = outputSize.width;
  outputCanvas.height = outputSize.height;
  const outputCtx = outputCanvas.getContext('2d');
  if (!outputCtx) return null;
  outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

  const targetPaddingX = kind === 'initials' ? 10 : 16;
  const targetPaddingY = kind === 'initials' ? 4 : 0;
  const maxWidth = outputCanvas.width - targetPaddingX * 2;
  const maxHeight = outputCanvas.height - targetPaddingY * 2;
  const scale = Math.min(maxWidth / cropWidth, maxHeight / cropHeight);
  const drawWidth = Math.max(1, cropWidth * scale);
  const drawHeight = Math.max(1, cropHeight * scale);
  const drawX = (outputCanvas.width - drawWidth) / 2;
  const drawY = (outputCanvas.height - drawHeight) / 2;

  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = 'high';
  outputCtx.drawImage(
    cleanedCanvas,
    cropLeft,
    cropTop,
    cropWidth,
    cropHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight
  );

  return outputCanvas.toDataURL('image/png');
};

export const normalizeSignatureDataUrl = (dataUrl, options = {}) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const maxSourceWidth = options.kind === 'initials' ? 600 : 1200;
      const maxSourceHeight = options.kind === 'initials' ? 360 : 600;
      const naturalWidth = image.naturalWidth || image.width || 1;
      const naturalHeight = image.naturalHeight || image.height || 1;
      const scale = Math.min(
        maxSourceWidth / naturalWidth,
        maxSourceHeight / naturalHeight,
        1
      );
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(normalizeSignatureCanvas(canvas, options) || dataUrl);
    };
    image.onerror = () => reject(new Error('Could not read that image file.'));
    image.src = dataUrl;
  });
