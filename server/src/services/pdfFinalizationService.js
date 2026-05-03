const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const FINALIZED_DIR = path.join(__dirname, '../../uploads/finalized');

const optionalRequire = (name) => {
  try { return require(name); } catch { return null; }
};

const base64ToBuffer = (value) => {
  const payload = String(value || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(payload, 'base64');
};

const sha256Buffer = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const signatureFieldTypes = new Set(['signature', 'initials']);
const valueFieldTypes = new Set(['date', 'text', 'number', 'checkbox', 'radio', 'dropdown']);

const truthyValue = (value) => value === true || value === 'true' || value === 'on' || value === '1';

const resolvePlacement = (signatureOrField, fields = []) => {
  const field = signatureOrField?.fieldId
    ? fields.find((item) => item.id && item.id === signatureOrField.fieldId)
    : signatureOrField;
  const signature = signatureOrField || {};
  const position = signature.position || {};
  return {
    page: Number(signature.page || field?.page || 1),
    x: Number(position.x ?? field?.x ?? 100),
    y: Number(position.y ?? field?.y ?? 100),
    width: Number(position.width ?? field?.width ?? 200),
    height: Number(position.height ?? field?.height ?? 60),
    origin: position.origin || field?.coordinateOrigin || 'normalized',
    role: signature.signerRole || field?.role || 'Signatory',
    field,
  };
};

const placementToPdfRect = (page, placement) => {
  const pageSize = page.getSize();
  if (placement.origin === 'normalized') {
    const width = placement.width * pageSize.width;
    const height = placement.height * pageSize.height;
    return {
      x: placement.x * pageSize.width,
      y: pageSize.height - (placement.y * pageSize.height) - height,
      width,
      height,
    };
  }
  if (placement.origin === 'pdf') {
    return {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    };
  }
  return {
    x: placement.x,
    y: pageSize.height - placement.y - placement.height,
    width: placement.width,
    height: placement.height,
  };
};

const drawSignature = async (pdfDoc, page, signature, placement, font) => {
  const rect = placementToPdfRect(page, placement);
  if (signature.signatureData) {
    const buffer = base64ToBuffer(signature.signatureData);
    let image;
    try { image = await pdfDoc.embedPng(buffer); }
    catch { image = await pdfDoc.embedJpg(buffer); }
    page.drawImage(image, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }

  page.drawText(`Signed by ${signature.signerName || signature.signerEmail}`, {
    x: rect.x, y: Math.max(8, rect.y - 10), size: 7, font, color: rgb(0.25, 0.25, 0.25),
  });
  page.drawText(new Date(signature.signedAt || Date.now()).toISOString(), {
    x: rect.x, y: Math.max(8, rect.y - 19), size: 6, font, color: rgb(0.42, 0.42, 0.42),
  });
};

const drawInitials = async (pdfDoc, page, signature, placement) => {
  const data = signature.initialsData || signature.signatureData;
  if (!data) return;
  const rect = placementToPdfRect(page, placement);
  const buffer = base64ToBuffer(data);
  let image;
  try { image = await pdfDoc.embedPng(buffer); }
  catch { image = await pdfDoc.embedJpg(buffer); }
  page.drawImage(image, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
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

// Build and append a certificate-of-completion page to the PDF
const appendCertificatePage = async (pdfDoc, { doc, signatures, finalPdfHash }) => {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const certPage = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = certPage.getSize();
  const margin = 48;
  let y = height - 72 - 28;

  // ── Header band ──────────────────────────────────────────────────────────
  certPage.drawRectangle({ x: 0, y: height - 72, width, height: 72, color: rgb(0.102, 0.157, 0.267) });
  certPage.drawText('Certificate of Completion', { x: margin, y: height - 44, size: 18, font: fontBold, color: rgb(1, 1, 1) });
  certPage.drawText('ContractIQ — Tamper-evident Signing Record', { x: margin, y: height - 62, size: 9, font, color: rgb(0.7, 0.8, 1) });
  // ── Document info ─────────────────────────────────────────────────────────
  const drawRow = (label, value, yPos, labelColor = rgb(0.45, 0.45, 0.45)) => {
    certPage.drawText(label, { x: margin, y: yPos, size: 8, font, color: labelColor });
    certPage.drawText(String(value || '—'), { x: margin + 120, y: yPos, size: 8, font, color: rgb(0.1, 0.1, 0.1) });
    return yPos - 15;
  };

  certPage.drawText('Document Details', { x: margin, y, size: 11, font: fontBold, color: rgb(0.102, 0.157, 0.267) });
  y -= 18;

  y = drawRow('Document Name', doc.name, y);
  y = drawRow('Document ID', String(doc._id), y);
  y = drawRow('Status', doc.status, y);
  y = drawRow('Finalized At', new Date().toUTCString(), y);
  y = drawRow('SHA-256 Hash', finalPdfHash ? finalPdfHash.substring(0, 48) + '…' : '—', y);
  y -= 12;

  // ── Signing Order ─────────────────────────────────────────────────────────
  certPage.drawText('Signing Configuration', { x: margin, y, size: 11, font: fontBold, color: rgb(0.102, 0.157, 0.267) });
  y -= 18;
  y = drawRow('Signing Order', doc.signingOrder === 'sequential' ? 'Sequential' : 'Parallel', y);
  y = drawRow('Total Signers', String((doc.signers || []).length), y);
  y -= 12;

  // ── Separator ─────────────────────────────────────────────────────────────
  certPage.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: rgb(0.82, 0.82, 0.82) });
  y -= 20;

  // ── Signers table ─────────────────────────────────────────────────────────
  certPage.drawText('Signer Records', { x: margin, y, size: 11, font: fontBold, color: rgb(0.102, 0.157, 0.267) });
  y -= 18;

  // Table header
  const cols = { name: margin, role: margin + 130, method: margin + 220, status: margin + 300, date: margin + 360 };
  certPage.drawRectangle({ x: margin - 4, y: y - 4, width: width - margin * 2 + 8, height: 18, color: rgb(0.94, 0.96, 1) });
  const headerColor = rgb(0.3, 0.3, 0.5);
  certPage.drawText('Signer', { x: cols.name, y, size: 8, font: fontBold, color: headerColor });
  certPage.drawText('Role', { x: cols.role, y, size: 8, font: fontBold, color: headerColor });
  certPage.drawText('Method', { x: cols.method, y, size: 8, font: fontBold, color: headerColor });
  certPage.drawText('Status', { x: cols.status, y, size: 8, font: fontBold, color: headerColor });
  certPage.drawText('Signed At (UTC)', { x: cols.date, y, size: 8, font: fontBold, color: headerColor });
  y -= 20;

  // Signer rows from the document signers list (includes not-signed if any)
  const signerMap = {};
  for (const sig of signatures) signerMap[sig.signerEmail] = sig;

  for (const signer of (doc.signers || [])) {
    const sig = signerMap[signer.email];
    const isSigned = signer.signingStatus === 'signed' || Boolean(sig);
    const rowColor = isSigned ? rgb(0.94, 1, 0.96) : rgb(1, 0.96, 0.94);

    certPage.drawRectangle({ x: margin - 4, y: y - 4, width: width - margin * 2 + 8, height: 17, color: rowColor });

    const nameText = (signer.name || signer.email || '').slice(0, 20);
    certPage.drawText(nameText, { x: cols.name, y, size: 7.5, font, color: rgb(0.1, 0.1, 0.1) });
    certPage.drawText((signer.role || '—').slice(0, 14), { x: cols.role, y, size: 7.5, font, color: rgb(0.2, 0.2, 0.4) });
    certPage.drawText(sig?.method || '—', { x: cols.method, y, size: 7.5, font, color: rgb(0.3, 0.3, 0.3) });
    certPage.drawText(isSigned ? 'Signed' : (signer.signingStatus === 'rejected' ? 'Rejected' : 'Pending'), {
      x: cols.status, y, size: 7.5, font: fontBold,
      color: isSigned ? rgb(0.06, 0.5, 0.2) : signer.signingStatus === 'rejected' ? rgb(0.7, 0.1, 0.1) : rgb(0.6, 0.4, 0),
    });
    const dateStr = sig?.signedAt ? new Date(sig.signedAt).toUTCString().replace(' GMT', '') : '—';
    certPage.drawText(dateStr.slice(0, 30), { x: cols.date, y, size: 7, font, color: rgb(0.35, 0.35, 0.35) });

    // Email on next mini-row
    y -= 12;
    certPage.drawText(signer.email || '', { x: cols.name, y, size: 6.5, font, color: rgb(0.45, 0.45, 0.45) });

    // IP if available
    if (sig?.ipAddress) {
      certPage.drawText(`IP: ${sig.ipAddress}`, { x: cols.role, y, size: 6.5, font, color: rgb(0.5, 0.5, 0.5) });
    }
    y -= 14;
  }

  // ── Separator ─────────────────────────────────────────────────────────────
  y -= 4;
  certPage.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: rgb(0.82, 0.82, 0.82) });
  y -= 16;

  // ── Audit hash block ──────────────────────────────────────────────────────
  certPage.drawText('Tamper Detection', { x: margin, y, size: 11, font: fontBold, color: rgb(0.102, 0.157, 0.267) });
  y -= 16;
  certPage.drawText('This certificate was automatically generated by ContractIQ at the time of document finalization.', {
    x: margin, y, size: 8, font, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 13;
  if (finalPdfHash) {
    certPage.drawText(`Document SHA-256: ${finalPdfHash}`, { x: margin, y, size: 7, font, color: rgb(0.3, 0.3, 0.3) });
    y -= 12;
  }
  certPage.drawText('Any modification to this PDF after finalization will invalidate the above hash.', {
    x: margin, y, size: 7.5, font, color: rgb(0.5, 0.5, 0.5),
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  certPage.drawLine({ start: { x: margin, y: 36 }, end: { x: width - margin, y: 36 }, thickness: 0.5, color: rgb(0.82, 0.82, 0.82) });
  certPage.drawText(`Generated by ContractIQ · ${new Date().toUTCString()}`, {
    x: margin, y: 22, size: 7, font, color: rgb(0.55, 0.55, 0.55),
  });
  certPage.drawText('Page ' + pdfDoc.getPageCount(), {
    x: width - margin - 40, y: 22, size: 7, font, color: rgb(0.55, 0.55, 0.55),
  });
};

const flattenPdfBytes = async ({ pdfPath, signatures = [], fields = [] }) => {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const field of fields.filter((item) => valueFieldTypes.has(item.type) && item.filled)) {
    const page = pages[Math.max(0, Math.min(pages.length - 1, Number(field.page || 1) - 1))];
    drawValueField(page, field, font);
  }

  for (const signature of signatures) {
    const placement = resolvePlacement(signature, fields);
    const page = pages[Math.max(0, Math.min(pages.length - 1, placement.page - 1))];
    if (placement.field?.type === 'initials') {
      await drawInitials(pdfDoc, page, signature, placement);
    } else if (!placement.field || signatureFieldTypes.has(placement.field.type)) {
      await drawSignature(pdfDoc, page, signature, placement, font);
    }
  }

  try {
    const form = pdfDoc.getForm();
    form.flatten({ updateFieldAppearances: true });
  } catch {
    // PDFs without AcroForm fields do not need form flattening.
  }

  const lastPage = pages[pages.length - 1];
  const { width } = lastPage.getSize();
  const auditY = 34;
  lastPage.drawLine({
    start: { x: 40, y: auditY + 18 },
    end: { x: width - 40, y: auditY + 18 },
    thickness: 0.5,
    color: rgb(0.72, 0.72, 0.72),
  });
  lastPage.drawText(`Finalized by ContractIQ at ${new Date().toISOString()}`, {
    x: 40, y: auditY + 6, size: 7, font, color: rgb(0.38, 0.38, 0.38),
  });

  return { pdfDoc, bytes: Buffer.from(await pdfDoc.save({ useObjectStreams: false })) };
};

const applyX509DigitalSignature = async (pdfBytes) => {
  const certificatePath = process.env.PDF_SIGNING_P12_PATH;
  const passphrase = process.env.PDF_SIGNING_P12_PASSWORD || '';

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
      reason: process.env.PDF_SIGNING_REASON || 'ContractIQ finalized signing package',
      signatureLength: Number(process.env.PDF_SIGNING_SIGNATURE_LENGTH) || 12000,
    });
    const signer = new P12Signer(p12Buffer, { passphrase });
    const signed = await signpdf.sign(pdfWithPlaceholder, signer);
    return { bytes: Buffer.from(signed), status: 'signed', certificateFingerprint: sha256Buffer(p12Buffer) };
  } catch (error) {
    return { bytes: pdfBytes, status: 'failed', reason: error.message };
  }
};

const finalizePdf = async ({ doc, signatures = [], requestedBy }) => {
  if (!doc?.path || !fs.existsSync(doc.path)) {
    throw new Error('Document file is not available for finalization.');
  }
  if (doc.type !== 'pdf') {
    throw new Error('Only PDF documents can be finalized into sealed signed PDFs.');
  }

  // Flatten + embed signatures
  const { bytes: flattenedBytes } = await flattenPdfBytes({
    pdfPath: doc.path,
    signatures,
    fields: doc.signingFields || [],
  });

  // Compute hash of flattened content (before certificate page)
  const flattenedHash = sha256Buffer(flattenedBytes);

  // Append the certificate-of-completion page
  const flattenedDocWithCert = await PDFDocument.load(flattenedBytes);
  await appendCertificatePage(flattenedDocWithCert, { doc, signatures, finalPdfHash: flattenedHash });
  const bytesWithCert = Buffer.from(await flattenedDocWithCert.save({ useObjectStreams: false }));

  // Apply X.509 signature over the full PDF (including certificate page)
  const digitalSignature = await applyX509DigitalSignature(bytesWithCert);
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
    finalizedAt: new Date(),
    finalizedBy: requestedBy?._id,
  };
};

module.exports = {
  finalizePdf,
  flattenPdfBytes: async (opts) => (await flattenPdfBytes(opts)).bytes,
  sha256Buffer,
  applyX509DigitalSignature,
};
