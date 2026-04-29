const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const IDP_VERSION = '2026.04-idp-v1';
const NORMALIZED_DIR = path.join(__dirname, '../../uploads/normalized');
const ANCHOR_PATTERN = /\{\{([A-Za-z0-9_:-]+)\}\}/g;
const SOURCE_PRIORITY = {
  anchor: 100,
  textract: 80,
  layoutlmv3: 75,
  'opencv-ocr': 55,
  'heuristic-keyword': 45,
  'heuristic-default': 10,
};

const SIGNATURE_WORDS = /\b(sign|signature|signed by|sign here|authorized signatory)\b/i;
const DATE_WORDS = /\b(date|dated)\b/i;
const INITIAL_WORDS = /\b(initial|initials)\b/i;
const NAME_WORDS = /\b(print name|printed name|name)\b/i;

const optionalRequire = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

const sha256File = (filePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const inferFieldType = (label = '') => {
  if (DATE_WORDS.test(label)) return 'date';
  if (INITIAL_WORDS.test(label)) return 'initials';
  if (NAME_WORDS.test(label)) return 'text';
  return 'signature';
};

const parseSignerIndex = (label = '') => {
  const match = String(label).match(/(?:signer|party|sig|signature|date|initials?)[_-]?(\d+)/i);
  return match ? Math.max(0, Number(match[1]) - 1) : null;
};

const getPdfPageMetrics = async (pdfPath) => {
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return pdfDoc.getPages().map((page, index) => {
    const size = page.getSize();
    return {
      page: index + 1,
      width: size.width,
      height: size.height,
      rotation: page.getRotation().angle || 0,
    };
  });
};

const normalizeDocumentToPdf = (doc) => new Promise((resolve, reject) => {
  if (doc.type === 'pdf') {
    resolve({
      pdfPath: doc.path,
      converted: false,
      diagnostics: { provider: 'normalizer', sourceType: 'pdf', converted: false },
    });
    return;
  }

  if (!['docx', 'doc'].includes(doc.type)) {
    reject(new Error('Automated signing preparation currently requires PDF, DOC, or DOCX input.'));
    return;
  }

  if (!fs.existsSync(NORMALIZED_DIR)) fs.mkdirSync(NORMALIZED_DIR, { recursive: true });
  const libreOffice = process.env.LIBREOFFICE_BIN || 'soffice';
  const child = spawn(libreOffice, [
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    NORMALIZED_DIR,
    doc.path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error('DOCX to PDF normalization timed out. Install LibreOffice or upload a PDF source.'));
  }, Number(process.env.IDP_NORMALIZE_TIMEOUT_MS) || 30000);

  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    clearTimeout(timeout);
    reject(new Error(`DOCX to PDF normalization failed: ${error.message}`));
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    const expected = path.join(
      NORMALIZED_DIR,
      `${path.basename(doc.path, path.extname(doc.path))}.pdf`
    );
    if (code !== 0 || !fs.existsSync(expected)) {
      reject(new Error(`DOCX to PDF normalization failed. ${stderr.trim() || 'LibreOffice did not produce a PDF.'}`));
      return;
    }
    resolve({
      pdfPath: expected,
      converted: true,
      diagnostics: {
        provider: 'normalizer',
        sourceType: doc.type,
        converted: true,
        output: expected,
      },
    });
  });
});

const normalizePdfField = (field, pageMetrics) => {
  const pageNumber = Math.max(1, Number(field.page) || 1);
  const page = pageMetrics[pageNumber - 1] || pageMetrics[0] || { width: 612, height: 792 };
  const width = Math.max(24, Math.min(Number(field.width) || 180, page.width));
  const height = Math.max(16, Math.min(Number(field.height) || 36, page.height));
  const x = Math.max(0, Math.min(Number(field.x) || 0, page.width - width));
  const y = Math.max(0, Math.min(Number(field.y) || 0, page.height - height));

  return {
    id: field.id,
    type: inferFieldType(field.type || field.name || field.anchor || field.context),
    page: pageNumber,
    x,
    y,
    width,
    height,
    assignedTo: field.assignedTo || '',
    role: field.role || '',
    required: field.required !== false,
    filled: false,
    source: field.source || 'heuristic-default',
    confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 0.5,
    anchor: field.anchor || '',
    context: field.context || field.name || '',
    coordinateOrigin: 'pdf',
    detection: {
      detector: field.detector || field.source || 'unknown',
      rawType: field.rawType || '',
      pageWidth: page.width,
      pageHeight: page.height,
      signerIndex: Number.isInteger(field.signerIndex) ? field.signerIndex : parseSignerIndex(field.name || field.anchor || ''),
    },
  };
};

const overlapRatio = (a, b) => {
  if (a.page !== b.page) return 0;
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y, b.y);
  const top = Math.min(a.y + a.height, b.y + b.height);
  const area = Math.max(0, right - left) * Math.max(0, top - bottom);
  const minArea = Math.min(a.width * a.height, b.width * b.height) || 1;
  return area / minArea;
};

const centerDistance = (a, b) => {
  if (a.page !== b.page) return Number.POSITIVE_INFINITY;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
};

const mergeFields = (fields, pageMetrics) => {
  const normalized = fields
    .map((field) => normalizePdfField(field, pageMetrics))
    .sort((a, b) => (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0));
  const merged = [];

  for (const field of normalized) {
    const duplicate = merged.find((item) =>
      item.type === field.type &&
      (overlapRatio(item, field) > 0.35 || centerDistance(item, field) < 28)
    );
    if (!duplicate) merged.push(field);
  }

  return merged
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
    .map((field, index) => ({
      ...field,
      id: field.id || `auto_${field.type}_${field.page}_${index + 1}`,
    }));
};

const assignFieldsToSigners = (fields, signers = []) => {
  const signerList = Array.isArray(signers) ? signers : [];
  return fields.map((field, index) => {
    const signerIndex = Number.isInteger(field.detection?.signerIndex)
      ? field.detection.signerIndex
      : field.type === 'signature' || field.type === 'date' || field.type === 'initials'
        ? index % Math.max(1, signerList.length)
        : -1;
    const signer = signerIndex >= 0 ? signerList[signerIndex] : null;
    return {
      ...field,
      assignedTo: field.assignedTo || signer?.email || '',
      role: field.role || signer?.role || '',
    };
  });
};

const extractAnchorsWithPdfJs = async (pdfPath, pageMetrics) => {
  const diagnostics = { provider: 'pdfjs-dist', available: false, fields: 0 };
  let pdfjsLib;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    diagnostics.error = `pdfjs-dist unavailable: ${error.message}`;
    return { fields: [], diagnostics };
  }

  diagnostics.available = true;
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
  const pdf = await loadingTask.promise;
  const fields = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent({ includeMarkedContent: false });
    const metric = pageMetrics[pageNumber - 1] || page.getViewport({ scale: 1 });

    for (const item of text.items || []) {
      const value = item.str || '';
      if (!value.includes('{{')) continue;
      for (const match of value.matchAll(ANCHOR_PATTERN)) {
        const charWidth = value.length ? (Number(item.width) || 0) / value.length : 0;
        const [, , , , rawX, rawY] = item.transform || [1, 0, 0, 1, 0, 0];
        const fieldWidth = Math.max(110, Math.min(260, (match[0].length * charWidth) || 160));
        const fieldHeight = 32;

        fields.push({
          source: 'anchor',
          detector: 'pdfjs-text-layer',
          anchor: match[0],
          name: match[1],
          type: inferFieldType(match[1]),
          page: pageNumber,
          x: rawX + match.index * charWidth,
          y: Math.max(0, rawY - 8),
          width: fieldWidth,
          height: fieldHeight,
          confidence: 1,
          context: match[1],
          pageWidth: metric.width,
          pageHeight: metric.height,
        });
      }
    }
  }

  diagnostics.fields = fields.length;
  return { fields, diagnostics };
};

const detectWithTextract = async (pdfPath, pageMetrics) => {
  const diagnostics = { provider: 'textract', enabled: process.env.AWS_TEXTRACT_ENABLED === 'true', fields: 0 };
  if (!diagnostics.enabled) return { fields: [], diagnostics };

  const textract = optionalRequire('@aws-sdk/client-textract');
  if (!textract) {
    diagnostics.error = '@aws-sdk/client-textract is not installed';
    return { fields: [], diagnostics };
  }

  const { TextractClient, AnalyzeDocumentCommand } = textract;
  const client = new TextractClient({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });
  const response = await client.send(new AnalyzeDocumentCommand({
    Document: { Bytes: fs.readFileSync(pdfPath) },
    FeatureTypes: ['FORMS', 'SIGNATURES', 'LAYOUT'],
  }));

  const fields = [];
  const blocks = response.Blocks || [];
  for (const block of blocks) {
    const text = block.Text || '';
    const isDetectedSignature = block.BlockType === 'SIGNATURE';
    const isKeyword = block.BlockType === 'LINE' && (SIGNATURE_WORDS.test(text) || DATE_WORDS.test(text) || INITIAL_WORDS.test(text));
    if (!isDetectedSignature && !isKeyword) continue;

    const metric = pageMetrics[(block.Page || 1) - 1] || { width: 612, height: 792 };
    const box = block.Geometry?.BoundingBox || {};
    const width = Math.max(100, (Number(box.Width) || 0.2) * metric.width);
    const height = Math.max(28, (Number(box.Height) || 0.04) * metric.height);
    const x = (Number(box.Left) || 0) * metric.width;
    const top = (Number(box.Top) || 0) * metric.height;

    fields.push({
      source: 'textract',
      detector: 'amazon-textract',
      rawType: block.BlockType,
      type: isDetectedSignature ? 'signature' : inferFieldType(text),
      page: block.Page || 1,
      x,
      y: metric.height - top - height - (isKeyword ? 8 : 0),
      width,
      height,
      confidence: (Number(block.Confidence) || 0) / 100,
      context: text,
    });
  }

  diagnostics.fields = fields.length;
  diagnostics.modelVersion = response.AnalyzeDocumentModelVersion;
  return { fields, diagnostics };
};

const detectWithLayoutLm = async (pdfPath, pageMetrics) => {
  const endpoint = process.env.LAYOUTLMV3_ENDPOINT;
  const diagnostics = { provider: 'layoutlmv3', enabled: Boolean(endpoint), fields: 0 };
  if (!endpoint) return { fields: [], diagnostics };

  const fetch = optionalRequire('node-fetch');
  if (!fetch) {
    diagnostics.error = 'node-fetch is not installed';
    return { fields: [], diagnostics };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.LAYOUTLMV3_API_KEY ? { Authorization: `Bearer ${process.env.LAYOUTLMV3_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      documentBase64: fs.readFileSync(pdfPath).toString('base64'),
      pageMetrics,
      task: 'signing-field-detection',
      labels: ['signature', 'date', 'initials', 'text'],
    }),
  });

  if (!response.ok) {
    diagnostics.error = `LayoutLMv3 endpoint returned ${response.status}`;
    return { fields: [], diagnostics };
  }

  const payload = await response.json();
  const fields = (payload.fields || []).map((field) => ({
    ...field,
    source: 'layoutlmv3',
    detector: field.detector || 'layoutlmv3-endpoint',
    confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : 0.75,
  }));

  diagnostics.fields = fields.length;
  diagnostics.modelVersion = payload.modelVersion;
  return { fields, diagnostics };
};

const runPythonDetector = (pdfPath, pageMetrics) => new Promise((resolve) => {
  const diagnostics = { provider: 'python-opencv-tesseract', enabled: process.env.IDP_DISABLE_PYTHON_FALLBACK !== 'true', fields: 0 };
  if (!diagnostics.enabled) return resolve({ fields: [], diagnostics });

  const script = process.env.IDP_PYTHON_WORKER || path.join(__dirname, '../../idp/detect_fields.py');
  if (!fs.existsSync(script)) {
    diagnostics.error = 'Python IDP worker script not found';
    return resolve({ fields: [], diagnostics });
  }

  const python = process.env.IDP_PYTHON_BIN || 'python3';
  const child = spawn(python, [script, pdfPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IDP_PAGE_METRICS: JSON.stringify(pageMetrics),
    },
  });

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    diagnostics.error = 'Python IDP worker timed out';
    child.kill('SIGTERM');
  }, Number(process.env.IDP_PYTHON_TIMEOUT_MS) || 25000);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
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
      diagnostics.fields = parsed.fields?.length || 0;
      diagnostics.worker = parsed.diagnostics || {};
      if (stderr.trim()) diagnostics.stderr = stderr.trim().slice(0, 1000);
      resolve({
        fields: (parsed.fields || []).map((field) => ({
          ...field,
          source: field.source || 'opencv-ocr',
          detector: field.detector || 'python-idp-worker',
        })),
        diagnostics,
      });
    } catch (error) {
      diagnostics.error = error.message;
      diagnostics.stderr = stderr.trim().slice(0, 1000);
      resolve({ fields: [], diagnostics });
    }
  });
});

const buildDefaultFields = (pageMetrics, signers = []) => {
  const page = pageMetrics[pageMetrics.length - 1] || { page: 1, width: 612, height: 792 };
  const signerList = Array.isArray(signers) && signers.length ? signers : [{ role: 'Signatory', email: '' }];

  return signerList.flatMap((signer, index) => {
    const y = Math.max(72, 96 + index * 82);
    return [
      {
        source: 'heuristic-default',
        detector: 'last-page-signature-block',
        type: 'signature',
        page: page.page,
        x: 72,
        y,
        width: Math.min(240, page.width - 144),
        height: 46,
        confidence: 0.25,
        context: signer.role || `Signer ${index + 1}`,
        assignedTo: signer.email || '',
        role: signer.role || '',
      },
      {
        source: 'heuristic-default',
        detector: 'last-page-date-block',
        type: 'date',
        page: page.page,
        x: Math.min(340, page.width - 190),
        y,
        width: 150,
        height: 28,
        confidence: 0.25,
        context: `${signer.role || `Signer ${index + 1}`} date`,
        assignedTo: signer.email || '',
        role: signer.role || '',
      },
    ];
  });
};

const prepareSigningDocument = async ({ doc, signers = [], strategy = {} }) => {
  if (!doc?.path || !fs.existsSync(doc.path)) {
    throw new Error('Document file is not available for IDP preparation.');
  }

  const normalized = await normalizeDocumentToPdf(doc);
  const pageMetrics = await getPdfPageMetrics(normalized.pdfPath);
  const sourceFileHash = sha256File(normalized.pdfPath);
  const diagnostics = [normalized.diagnostics];

  const anchorResult = await extractAnchorsWithPdfJs(normalized.pdfPath, pageMetrics);
  diagnostics.push(anchorResult.diagnostics);

  const textractResult = await detectWithTextract(normalized.pdfPath, pageMetrics).catch((error) => ({
    fields: [],
    diagnostics: { provider: 'textract', error: error.message },
  }));
  diagnostics.push(textractResult.diagnostics);

  const layoutLmResult = await detectWithLayoutLm(normalized.pdfPath, pageMetrics).catch((error) => ({
    fields: [],
    diagnostics: { provider: 'layoutlmv3', error: error.message },
  }));
  diagnostics.push(layoutLmResult.diagnostics);

  const pythonResult = strategy.skipFallback ? { fields: [], diagnostics: { provider: 'python-opencv-tesseract', skipped: true } }
    : await runPythonDetector(normalized.pdfPath, pageMetrics);
  diagnostics.push(pythonResult.diagnostics);

  let candidates = [
    ...anchorResult.fields,
    ...textractResult.fields,
    ...layoutLmResult.fields,
    ...pythonResult.fields,
  ];

  if (!candidates.length) {
    candidates = buildDefaultFields(pageMetrics, signers);
    diagnostics.push({ provider: 'heuristic-default', fields: candidates.length, reviewRequired: true });
  }

  const fields = assignFieldsToSigners(mergeFields(candidates, pageMetrics), signers);
  const reviewRequired = fields.some((field) => field.confidence < 0.75 || field.source === 'heuristic-default');
  const fieldsHash = crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');

  return {
    fields,
    metadata: {
      status: reviewRequired ? 'needs_review' : 'prepared',
      preparedAt: new Date(),
      detectionVersion: IDP_VERSION,
      strategy: {
        anchors: true,
        textract: process.env.AWS_TEXTRACT_ENABLED === 'true',
        layoutlmv3: Boolean(process.env.LAYOUTLMV3_ENDPOINT),
        pythonFallback: process.env.IDP_DISABLE_PYTHON_FALLBACK !== 'true',
        defaultFallback: true,
      },
      diagnostics,
      pageMetrics,
      sourceFileHash,
      reviewRequired,
      fieldsHash,
      normalizedPdfPath: normalized.pdfPath,
      normalizedFromOffice: normalized.converted,
    },
  };
};

module.exports = {
  IDP_VERSION,
  prepareSigningDocument,
  normalizeDocumentToPdf,
  extractAnchorsWithPdfJs,
  getPdfPageMetrics,
  mergeFields,
  detectWithLayoutLm,
  inferFieldType,
};
