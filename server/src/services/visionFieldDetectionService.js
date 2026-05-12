const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const hasVisionModel = () =>
  Boolean(process.env.IDP_YOLO_MODEL_PATH || process.env.IDP_VISION_MODEL_PATH || process.env.CV_YOLO_MODEL_PATH);

const visionEnabled = () =>
  process.env.IDP_VISION_ENABLED === 'true' || hasVisionModel();

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

const pageMetricFor = (pageMetrics, pageNumber) =>
  pageMetrics?.[Math.max(0, pageNumber - 1)] || pageMetrics?.[0] || { page: pageNumber, width: 612, height: 792 };

const percentBox = (field) => ({
  x: clamp(finiteNumber(field.xPercent), 0, 100),
  y: clamp(finiteNumber(field.yPercent), 0, 100),
  width: clamp(finiteNumber(field.widthPercent), 0, 100),
  height: clamp(finiteNumber(field.heightPercent), 0, 100),
});

const visionPercentToPdfField = (field, pageMetrics = []) => {
  const pageNumber = Math.max(1, Math.round(finiteNumber(field.page, 1)));
  const metric = pageMetricFor(pageMetrics, pageNumber);
  const pageWidth = finiteNumber(metric.width, 612) || 612;
  const pageHeight = finiteNumber(metric.height, 792) || 792;
  const box = percentBox(field);

  const width = (box.width / 100) * pageWidth;
  const height = (box.height / 100) * pageHeight;
  const x = (box.x / 100) * pageWidth;
  const top = (box.y / 100) * pageHeight;

  return {
    source: 'yolo-cv',
    detector: field.detector || 'yolo-document-layout',
    rawType: field.rawType || '',
    type: field.type || 'signature',
    page: pageNumber,
    x,
    y: pageHeight - top - height,
    width,
    height,
    confidence: finiteNumber(field.confidence, 0.5),
    context: field.rawType || field.type || '',
    detection: {
      detector: field.detector || 'yolo-document-layout',
      rawType: field.rawType || '',
      coordinateOrigin: field.coordinateOrigin || 'percent-top-left',
      normalizedPercent: box,
      pixelBox: field.pixelBox || [],
      imageWidth: field.imageWidth,
      imageHeight: field.imageHeight,
      dpi: field.dpi,
      pageWidth,
      pageHeight,
    },
  };
};

const detectVisionFields = ({ pdfPath, pageMetrics = [] }) => new Promise((resolve) => {
  const diagnostics = {
    provider: 'yolo-cv',
    enabled: visionEnabled(),
    fields: 0,
  };

  if (!diagnostics.enabled) {
    diagnostics.reason = 'Set IDP_VISION_ENABLED=true and IDP_YOLO_MODEL_PATH to enable YOLO/CNN field detection.';
    resolve({ fields: [], diagnostics });
    return;
  }

  const script = process.env.IDP_VISION_WORKER || path.join(__dirname, '../../idp/yolo_field_detector.py');
  if (!fs.existsSync(script)) {
    diagnostics.error = 'YOLO vision worker script not found.';
    resolve({ fields: [], diagnostics });
    return;
  }

  const python = process.env.IDP_PYTHON_BIN || 'python3';
  const child = spawn(python, [script, pdfPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IDP_VISION_DPI: process.env.IDP_VISION_DPI || '300',
    },
  });

  const MAX_STDOUT_BYTES = Number(process.env.IDP_VISION_MAX_OUTPUT_BYTES) || 4 * 1024 * 1024; // 4 MB
  let stdout = '';
  let stdoutBytes = 0;
  let stderr = '';
  const timeout = setTimeout(() => {
    diagnostics.error = 'YOLO vision worker timed out.';
    child.kill('SIGTERM');
  }, Number(process.env.IDP_VISION_TIMEOUT_MS) || 60000);

  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      diagnostics.error = 'YOLO vision worker output exceeded size limit.';
      child.kill('SIGTERM');
      return;
    }
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    clearTimeout(timeout);
    diagnostics.error = error.message;
    resolve({ fields: [], diagnostics });
  });
  child.on('close', () => {
    clearTimeout(timeout);
    try {
      const parsed = stdout ? JSON.parse(stdout) : {};
      const rawFields = parsed.fields || [];
      const fields = rawFields.map((field) => visionPercentToPdfField(field, pageMetrics));
      diagnostics.fields = fields.length;
      diagnostics.worker = parsed.diagnostics || {};
      if (stderr.trim()) diagnostics.stderr = stderr.trim().slice(0, 1000);
      resolve({ fields, diagnostics });
    } catch (error) {
      diagnostics.error = error.message;
      diagnostics.stderr = stderr.trim().slice(0, 1000);
      resolve({ fields: [], diagnostics });
    }
  });
});

module.exports = {
  detectVisionFields,
  visionPercentToPdfField,
};
