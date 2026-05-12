const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const {
  MIN_PDF_RECT_SIZE,
  SIGNATURE_IMAGE_PADDING,
  base64ToBuffer,
  finiteNumber,
  clamp,
  formatUtcTimestamp,
  placementToPdfRect,
  insetRect,
  imageFitRect,
} = require('../utils/pdfHelpers');

const FINALIZED_DIR = path.join(__dirname, '../../uploads/finalized');

const optionalRequire = (name) => {
  try { return require(name); } catch { return null; }
};

const sha256Buffer = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const signatureFieldTypes = new Set(['signature', 'initials']);
const valueFieldTypes = new Set(['date', 'text', 'number', 'checkbox', 'radio', 'dropdown']);
const DEFAULT_FREE_SIGNATURE_RECT = {
  page: 1,
  x: 100,
  y: 100,
  width: 200,
  height: 60,
  origin: 'top-left',
};
const VISIBLE_SIGNATURE_CAPTIONS = process.env.SIGNING_VISIBLE_SIGNATURE_CAPTIONS === 'true';
const SIGNATURE_CAPTION_HEIGHT = 18;

const truthyValue = (value) => value === true || value === 'true' || value === 'on' || value === '1';
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const resolvePlacement = (signatureOrField, fields = []) => {
  const matchedField = signatureOrField?.fieldId
    ? fields.find((item) => item.id && item.id === signatureOrField.fieldId)
    : null;
  const directField = signatureOrField?.type ? signatureOrField : null;
  const field = matchedField || directField;
  const signature = signatureOrField || {};

  if (field) {
    return {
      page: finiteNumber(field.page, 1),
      x: finiteNumber(field.x, 0),
      y: finiteNumber(field.y, 0),
      width: finiteNumber(field.width, 0),
      height: finiteNumber(field.height, 0),
      origin: field.coordinateOrigin || 'normalized',
      role: signature.signerRole || field.role || 'Signatory',
      field,
    };
  }

  const position = signature.position || DEFAULT_FREE_SIGNATURE_RECT;
  return {
    page: finiteNumber(signature.page, DEFAULT_FREE_SIGNATURE_RECT.page),
    x: finiteNumber(position.x, DEFAULT_FREE_SIGNATURE_RECT.x),
    y: finiteNumber(position.y, DEFAULT_FREE_SIGNATURE_RECT.y),
    width: finiteNumber(position.width, DEFAULT_FREE_SIGNATURE_RECT.width),
    height: finiteNumber(position.height, DEFAULT_FREE_SIGNATURE_RECT.height),
    origin: position.origin || DEFAULT_FREE_SIGNATURE_RECT.origin,
    role: signature.signerRole || 'Signatory',
    field: null,
  };
};


const drawSignatureCaption = (page, signature, rect, font) => {
  if (!VISIBLE_SIGNATURE_CAPTIONS) return;
  const pageSize = page.getSize();
  const captionY = rect.y - SIGNATURE_CAPTION_HEIGHT - 2;
  if (captionY < 8) return;
  const signer = signature.signerName || signature.signerEmail || 'Signer';
  const captionWidth = Math.min(rect.width, pageSize.width - rect.x - 8);
  page.drawText(`Signed by ${signer}`, {
    x: rect.x,
    y: captionY + 9,
    size: 6.5,
    font,
    color: rgb(0.25, 0.25, 0.25),
    maxWidth: Math.max(24, captionWidth),
  });
  page.drawText(formatUtcTimestamp(signature.signedAt), {
    x: rect.x,
    y: captionY,
    size: 5.8,
    font,
    color: rgb(0.42, 0.42, 0.42),
    maxWidth: Math.max(24, captionWidth),
  });
};

const drawSignature = async (pdfDoc, page, signature, placement, font) => {
  const rect = placementToPdfRect(page, placement);
  if (signature.signatureData) {
    const buffer = base64ToBuffer(signature.signatureData);
    let image;
    try { image = await pdfDoc.embedPng(buffer); }
    catch { image = await pdfDoc.embedJpg(buffer); }
    page.drawImage(image, imageFitRect(image, insetRect(rect, SIGNATURE_IMAGE_PADDING)));
  }

  drawSignatureCaption(page, signature, rect, font);
};

const drawInitials = async (pdfDoc, page, signature, placement) => {
  const data = signature.initialsData || signature.signatureData;
  if (!data) return;
  const rect = placementToPdfRect(page, placement);
  const buffer = base64ToBuffer(data);
  let image;
  try { image = await pdfDoc.embedPng(buffer); }
  catch { image = await pdfDoc.embedJpg(buffer); }
  page.drawImage(image, imageFitRect(image, insetRect(rect, SIGNATURE_IMAGE_PADDING)));
};

const drawTextWithin = (page, text, rect, font, options = {}) => {
  const value = String(text ?? '').trim();
  if (!value) return;
  const size = options.size || Math.max(7, Math.min(11, rect.height * 0.45));
  const x = rect.x + 3;
  const y = rect.y + Math.max(3, (rect.height - size) / 2);
  page.drawText(value.slice(0, 160), {
    x,
    y,
    size,
    font,
    color: options.color || rgb(0.05, 0.08, 0.14),
    maxWidth: Math.max(8, rect.width - 6),
  });
};

const drawValueField = (page, field, font) => {
  const placement = resolvePlacement(field);
  const rect = placementToPdfRect(page, placement);

  if (field.type === 'checkbox' || field.type === 'radio') {
    const size = Math.min(rect.width, rect.height);
    const x = rect.x + Math.max(0, (rect.width - size) / 2);
    const y = rect.y + Math.max(0, (rect.height - size) / 2);
    page.drawRectangle({
      x,
      y,
      width: size,
      height: size,
      borderColor: rgb(0.05, 0.08, 0.14),
      borderWidth: 1,
      color: rgb(1, 1, 1),
    });
    if (truthyValue(field.fieldValue)) {
      page.drawLine({
        start: { x: x + size * 0.22, y: y + size * 0.52 },
        end: { x: x + size * 0.42, y: y + size * 0.28 },
        thickness: Math.max(1.2, size * 0.08),
        color: rgb(0.05, 0.36, 0.16),
      });
      page.drawLine({
        start: { x: x + size * 0.42, y: y + size * 0.28 },
        end: { x: x + size * 0.8, y: y + size * 0.78 },
        thickness: Math.max(1.2, size * 0.08),
        color: rgb(0.05, 0.36, 0.16),
      });
    }
    return;
  }

  const value = field.type === 'date' && !field.fieldValue && field.filledAt
    ? new Date(field.filledAt).toISOString().slice(0, 10)
    : field.fieldValue;
  drawTextWithin(page, value, rect, font);
};


const flattenPdfBytes = async ({ pdfPath, signatures = [], fields = [] }) => {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const renderedSignatureFieldIds = new Set();
  const renderedInitialFieldIds = new Set();

  for (const field of fields.filter((item) => valueFieldTypes.has(item.type) && item.filled)) {
    const page = pages[Math.max(0, Math.min(pages.length - 1, Number(field.page || 1) - 1))];
    drawValueField(page, field, font);
  }

  for (const signature of signatures) {
    const placement = resolvePlacement(signature, fields);
    const page = pages[Math.max(0, Math.min(pages.length - 1, placement.page - 1))];
    if (placement.field?.type === 'initials') {
      await drawInitials(pdfDoc, page, signature, placement);
      if (placement.field.id) renderedInitialFieldIds.add(placement.field.id);
    } else if (!placement.field || signatureFieldTypes.has(placement.field.type)) {
      await drawSignature(pdfDoc, page, signature, placement, font);
      if (placement.field?.id) renderedSignatureFieldIds.add(placement.field.id);
    }
  }

  const signaturesByEmail = new Map();
  for (const signature of signatures) {
    const signerEmail = normalizeEmail(signature.signerEmail);
    if (signerEmail && !signaturesByEmail.has(signerEmail)) {
      signaturesByEmail.set(signerEmail, signature);
    }
  }

  for (const field of fields.filter((item) => item.type === 'signature' && item.filled)) {
    if (field.id && renderedSignatureFieldIds.has(field.id)) continue;
    const signature = signaturesByEmail.get(normalizeEmail(field.filledBy)) || signaturesByEmail.get(normalizeEmail(field.assignedTo));
    if (!signature) continue;
    const placement = resolvePlacement(field, fields);
    const page = pages[Math.max(0, Math.min(pages.length - 1, placement.page - 1))];
    await drawSignature(pdfDoc, page, signature, placement, font);
    if (field.id) renderedSignatureFieldIds.add(field.id);
  }

  for (const field of fields.filter((item) => item.type === 'initials' && item.filled)) {
    if (field.id && renderedInitialFieldIds.has(field.id)) continue;
    const signature = signaturesByEmail.get(normalizeEmail(field.filledBy)) || signaturesByEmail.get(normalizeEmail(field.assignedTo));
    if (!signature) continue;
    const placement = resolvePlacement(field, fields);
    const page = pages[Math.max(0, Math.min(pages.length - 1, placement.page - 1))];
    await drawInitials(pdfDoc, page, signature, placement);
    if (field.id) renderedInitialFieldIds.add(field.id);
  }

  try {
    const form = pdfDoc.getForm();
    form.flatten({ updateFieldAppearances: true });
  } catch {
    // PDFs without AcroForm fields do not need form flattening.
  }

  return { pdfDoc, bytes: Buffer.from(await pdfDoc.save({ useObjectStreams: false })) };
};

const applyX509DigitalSignature = async (pdfBytes, options = {}) => {
  const certificatePath = options.certificatePath || process.env.PDF_SIGNING_P12_PATH;
  const passphrase = options.passphrase ?? process.env.PDF_SIGNING_P12_PASSWORD ?? '';
  const reason = options.reason || process.env.PDF_SIGNING_REASON || 'ContractIQ finalized signing package';

  if (!certificatePath) {
    return { bytes: pdfBytes, status: 'skipped', reason: 'PDF_SIGNING_P12_PATH is not configured' };
  }
  if (!fs.existsSync(certificatePath)) {
    return { bytes: pdfBytes, status: 'failed', reason: 'Configured X.509 certificate file was not found' };
  }

  const signpdfModule = optionalRequire('@signpdf/signpdf');
  const p12Module = optionalRequire('@signpdf/signer-p12');
  const placeholderModule = optionalRequire('@signpdf/placeholder-plain');

  if (!signpdfModule || !p12Module || !placeholderModule) {
    return { bytes: pdfBytes, status: 'failed', reason: 'Install @signpdf/signpdf, @signpdf/signer-p12, and @signpdf/placeholder-plain to enable X.509 PDF signing' };
  }

  try {
    const signpdf = signpdfModule.default || signpdfModule.signpdf || signpdfModule;
    const P12Signer = p12Module.P12Signer || p12Module.default || p12Module;
    const plainAddPlaceholder = placeholderModule.plainAddPlaceholder || placeholderModule.default || placeholderModule;
    const p12Buffer = fs.readFileSync(certificatePath);
    const pdfWithPlaceholder = plainAddPlaceholder({
      pdfBuffer: pdfBytes,
      reason,
      signatureLength: Number(process.env.PDF_SIGNING_SIGNATURE_LENGTH) || 12000,
    });
    const signer = new P12Signer(p12Buffer, { passphrase });
    const signed = await signpdf.sign(pdfWithPlaceholder, signer);
    return { bytes: Buffer.from(signed), status: 'signed', certificateFingerprint: sha256Buffer(p12Buffer) };
  } catch (error) {
    return { bytes: pdfBytes, status: 'failed', reason: error.message };
  }
};

const embedNotaryStamp = async (pdfDoc, stampFilePath) => {
  if (!stampFilePath || !fs.existsSync(stampFilePath)) return;
  try {
    const stampBuffer = fs.readFileSync(stampFilePath);
    let stampImage;
    try { stampImage = await pdfDoc.embedPng(stampBuffer); }
    catch { stampImage = await pdfDoc.embedJpg(stampBuffer); }
    const pages = pdfDoc.getPages();
    // Stamp goes in the bottom-right corner of every page
    for (const page of pages) {
      const { width, height } = page.getSize();
      const stampWidth = Math.min(110, width * 0.18);
      const stampHeight = stampWidth * (stampImage.height / stampImage.width);
      page.drawImage(stampImage, {
        x: width - stampWidth - 24,
        y: 24,
        width: stampWidth,
        height: stampHeight,
        opacity: 0.88,
      });
    }
  } catch {
    // Stamp embedding is best-effort; do not fail the finalization.
  }
};

const finalizePdf = async ({ doc, signatures = [], requestedBy }) => {
  if (!doc?.path || !fs.existsSync(doc.path)) {
    throw new Error('Document file is not available for finalization.');
  }
  if (doc.type !== 'pdf') {
    throw new Error('Only PDF documents can be finalized into sealed signed PDFs.');
  }

  const finalizedAt = new Date();

  // Flatten + embed signatures
  const { pdfDoc: flattenedDoc, bytes: preFlattenedBytes } = await flattenPdfBytes({
    pdfPath: doc.path,
    signatures,
    fields: doc.signingFields || [],
  });

  // Embed notary stamp if available (SA RON notarization); re-serialize if stamp was added
  const notaryStampPath = doc.signingEvidence?.ron?.notaryStamp?.filePath;
  let flattenedBytes = preFlattenedBytes;
  if (notaryStampPath) {
    await embedNotaryStamp(flattenedDoc, notaryStampPath);
    flattenedBytes = Buffer.from(await flattenedDoc.save({ useObjectStreams: false }));
  }

  // Compute hash of flattened content (includes stamp if present)
  const flattenedHash = sha256Buffer(flattenedBytes);

  // Apply X.509 signature over the flattened PDF
  const isRon = doc.signingEvidence?.mode === 'ron';
  const notary = doc.signingEvidence?.ron?.notary || {};
  const digitalSignature = await applyX509DigitalSignature(flattenedBytes, isRon ? {
    certificatePath: process.env.RON_NOTARY_P12_PATH || process.env.PDF_SIGNING_P12_PATH,
    passphrase: process.env.RON_NOTARY_P12_PASSWORD ?? process.env.PDF_SIGNING_P12_PASSWORD ?? '',
    reason: `RON notarization by ${notary.name || 'commissioned notary'}`,
  } : {});
  if (isRon && digitalSignature.status !== 'signed') {
    throw new Error(`RON notarization requires a notary PKI certificate. ${digitalSignature.reason || 'Digital signing failed.'}`);
  }
  const finalizedBytes = digitalSignature.bytes;
  const finalPdfHash = sha256Buffer(finalizedBytes);

  if (!fs.existsSync(FINALIZED_DIR)) fs.mkdirSync(FINALIZED_DIR, { recursive: true });
  const finalizedFilename = `finalized_${uuidv4()}.pdf`;
  const finalizedPath = path.join(FINALIZED_DIR, finalizedFilename);
  fs.writeFileSync(finalizedPath, finalizedBytes);

  return {
    finalizedPath,
    finalizedFilename: `finalized/${finalizedFilename}`,
    flattenedHash,
    finalPdfHash,
    byteLength: finalizedBytes.length,
    digitalSignature,
    finalizedAt,
    finalizedBy: requestedBy?._id,
  };
};

module.exports = {
  finalizePdf,
  flattenPdfBytes: async (opts) => (await flattenPdfBytes(opts)).bytes,
  sha256Buffer,
  applyX509DigitalSignature,
};
