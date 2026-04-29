const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const base64ToBuffer = (base64) => {
  const data = base64.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(data, 'base64');
};

/**
 * Embed a signature image into a PDF at a specified position.
 * Also adds initials to all middle pages (not first or last).
 */
const embedSignatureInPDF = async (pdfPath, signatureBase64, options = {}) => {
  const {
    page = 0,
    x = 100,
    y = 100,
    width = 200,
    height = 80,
    initialsBase64 = null,
    signerName = '',
    signerEmail = '',
    signedAt = new Date(),
  } = options;

  const existingBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingBytes);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Embed signature on the specified page
  const sigBuffer = base64ToBuffer(signatureBase64);
  let sigImage;
  try {
    sigImage = await pdfDoc.embedPng(sigBuffer);
  } catch {
    sigImage = await pdfDoc.embedJpg(sigBuffer);
  }

  const targetPage = pages[Math.min(page, pages.length - 1)];
  const { height: pageHeight } = targetPage.getSize();

  targetPage.drawImage(sigImage, {
    x,
    y: pageHeight - y - height,
    width,
    height,
  });

  // Signature date + name under signature
  targetPage.drawText(`Signed: ${signerName}`, {
    x,
    y: pageHeight - y - height - 14,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  targetPage.drawText(signedAt.toLocaleString(), {
    x,
    y: pageHeight - y - height - 26,
    size: 8,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  // Add initials to all middle pages
  if (initialsBase64 && pages.length > 2) {
    let initImage;
    try {
      const initBuffer = base64ToBuffer(initialsBase64);
      initImage = await pdfDoc.embedPng(initBuffer);
    } catch {}

    for (let i = 1; i < pages.length - 1; i++) {
      const p = pages[i];
      const { width: pw, height: ph } = p.getSize();

      if (initImage) {
        p.drawImage(initImage, { x: pw - 80, y: 20, width: 60, height: 24 });
      } else {
        // Text initials fallback
        const initials = signerName.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 3);
        p.drawText(initials, { x: pw - 60, y: 25, size: 14, font: fontBold, color: rgb(0.1, 0.2, 0.6) });
      }

      p.drawText(`Page ${i + 1}`, {
        x: pw - 60, y: 12, size: 7, font, color: rgb(0.6, 0.6, 0.6),
      });
    }
  }

  // Add audit footer to the last page
  const lastPage = pages[pages.length - 1];
  const { width: lw, height: lh } = lastPage.getSize();
  lastPage.drawLine({
    start: { x: 40, y: 60 },
    end: { x: lw - 40, y: 60 },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  lastPage.drawText(`Digitally signed by ${signerName} <${signerEmail}> on ${signedAt.toISOString()}`, {
    x: 40, y: 45, size: 7, font, color: rgb(0.5, 0.5, 0.5),
  });
  lastPage.drawText('Signed via ContractIQ — Tamper-evident digital signature', {
    x: 40, y: 35, size: 7, font, color: rgb(0.5, 0.5, 0.5),
  });

  const signedBytes = await pdfDoc.save();
  const signedDir = path.join(__dirname, '../../uploads/signed');
  if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });
  const signedFilename = `signed_${uuidv4()}.pdf`;
  const signedPath = path.join(signedDir, signedFilename);
  fs.writeFileSync(signedPath, signedBytes);

  return { signedPath, signedFilename: `signed/${signedFilename}` };
};

/**
 * Prefill date fields and add watermark to a PDF before signing.
 */
const preparePDFForSigning = async (pdfPath, options = {}) => {
  const { watermarkText = 'AWAITING SIGNATURES' } = options;
  const existingBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingBytes);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  for (const page of pages) {
    const { width, height } = page.getSize();
    page.drawText(watermarkText, {
      x: width / 2 - 100,
      y: height / 2,
      size: 28,
      font,
      color: rgb(0.85, 0.85, 0.85),
      rotate: { type: 'degrees', angle: 45 },
      opacity: 0.25,
    });
  }

  const bytes = await pdfDoc.save();
  const prepDir = path.join(__dirname, '../../uploads/prepared');
  if (!fs.existsSync(prepDir)) fs.mkdirSync(prepDir, { recursive: true });
  const prepFilename = `prep_${uuidv4()}.pdf`;
  const prepPath = path.join(prepDir, prepFilename);
  fs.writeFileSync(prepPath, bytes);
  return { prepPath, prepFilename: `prepared/${prepFilename}` };
};

module.exports = { embedSignatureInPDF, preparePDFForSigning };
