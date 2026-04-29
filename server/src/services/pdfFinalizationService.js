const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const FINALIZED_DIR = path.join(__dirname, '../../uploads/finalized');

const optionalRequire = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

const base64ToBuffer = (value) => {
  const payload = String(value || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(payload, 'base64');
};

const sha256Buffer = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const resolvePlacement = (signature, fields = []) => {
  const field = fields.find((item) => item.id && item.id === signature.fieldId);
  const position = signature.position || {};
  return {
    page: Number(signature.page || field?.page || 1),
    x: Number(position.x ?? field?.x ?? 100),
    y: Number(position.y ?? field?.y ?? 100),
    width: Number(position.width ?? field?.width ?? 200),
    height: Number(position.height ?? field?.height ?? 60),
    origin: position.origin || field?.coordinateOrigin || 'top-left',
    role: signature.signerRole || field?.role || 'Signatory',
  };
};

const drawSignature = async (pdfDoc, page, signature, placement, font) => {
  const pageSize = page.getSize();
  const y = placement.origin === 'pdf'
    ? placement.y
    : pageSize.height - placement.y - placement.height;
  const x = placement.x;

  if (signature.signatureData) {
    const buffer = base64ToBuffer(signature.signatureData);
    let image;
    try {
      image = await pdfDoc.embedPng(buffer);
    } catch {
      image = await pdfDoc.embedJpg(buffer);
    }
    page.drawImage(image, {
      x,
      y,
      width: placement.width,
      height: placement.height,
    });
  }

  page.drawText(`Signed by ${signature.signerName || signature.signerEmail}`, {
    x,
    y: Math.max(8, y - 10),
    size: 7,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });
  page.drawText(new Date(signature.signedAt || Date.now()).toISOString(), {
    x,
    y: Math.max(8, y - 19),
    size: 6,
    font,
    color: rgb(0.42, 0.42, 0.42),
  });
};

const flattenPdfBytes = async ({ pdfPath, signatures = [], fields = [] }) => {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const signature of signatures) {
    const placement = resolvePlacement(signature, fields);
    const page = pages[Math.max(0, Math.min(pages.length - 1, placement.page - 1))];
    await drawSignature(pdfDoc, page, signature, placement, font);
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
    x: 40,
    y: auditY + 6,
    size: 7,
    font,
    color: rgb(0.38, 0.38, 0.38),
  });

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
};

const applyX509DigitalSignature = async (pdfBytes) => {
  const certificatePath = process.env.PDF_SIGNING_P12_PATH;
  const passphrase = process.env.PDF_SIGNING_P12_PASSWORD || '';

  if (!certificatePath) {
    return {
      bytes: pdfBytes,
      status: 'skipped',
      reason: 'PDF_SIGNING_P12_PATH is not configured',
    };
  }
  if (!fs.existsSync(certificatePath)) {
    return {
      bytes: pdfBytes,
      status: 'failed',
      reason: 'Configured X.509 certificate file was not found',
    };
  }

  const signpdfModule = optionalRequire('@signpdf/signpdf');
  const p12Module = optionalRequire('@signpdf/signer-p12');
  const placeholderModule = optionalRequire('@signpdf/placeholder-plain');

  if (!signpdfModule || !p12Module || !placeholderModule) {
    return {
      bytes: pdfBytes,
      status: 'failed',
      reason: 'Install @signpdf/signpdf, @signpdf/signer-p12, and @signpdf/placeholder-plain to enable X.509 PDF signing',
    };
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
    return {
      bytes: Buffer.from(signed),
      status: 'signed',
      certificateFingerprint: sha256Buffer(p12Buffer),
    };
  } catch (error) {
    return {
      bytes: pdfBytes,
      status: 'failed',
      reason: error.message,
    };
  }
};

const finalizePdf = async ({ doc, signatures = [], requestedBy }) => {
  if (!doc?.path || !fs.existsSync(doc.path)) {
    throw new Error('Document file is not available for finalization.');
  }
  if (doc.type !== 'pdf') {
    throw new Error('Only PDF documents can be finalized into sealed signed PDFs.');
  }

  const flattenedBytes = await flattenPdfBytes({
    pdfPath: doc.path,
    signatures,
    fields: doc.signingFields || [],
  });
  const flattenedHash = sha256Buffer(flattenedBytes);
  const digitalSignature = await applyX509DigitalSignature(flattenedBytes);
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
  flattenPdfBytes,
  sha256Buffer,
  applyX509DigitalSignature,
};
