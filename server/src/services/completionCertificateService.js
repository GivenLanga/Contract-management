const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE = { width: 612, height: 792 };
const MARGIN = 42;
const COLORS = {
  ink: rgb(0.08, 0.12, 0.22),
  muted: rgb(0.38, 0.45, 0.55),
  line: rgb(0.82, 0.86, 0.92),
  panel: rgb(0.96, 0.98, 1),
  navy: rgb(0.10, 0.15, 0.27),
  green: rgb(0.06, 0.50, 0.20),
  white: rgb(1, 1, 1),
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const safePdfText = (value) => String(value ?? '-')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');

const formatUtc = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
};

const compactHash = (value, length = 64) => {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.length <= length ? text : `${text.slice(0, length - 13)}...${text.slice(-10)}`;
};

const limitText = (value, maxLength = 900) => {
  const text = safePdfText(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}... [truncated]`;
};

const latestDate = (values) => {
  const dates = values
    .map((value) => {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0] || null;
};

const safeJson = (value) => {
  if (!value) return '-';
  try {
    return JSON.stringify(value, (key, item) => (
      ['signatureData', 'initialsData', 'tokenBase64', 'responseBase64'].includes(key) ? '[binary evidence omitted]' : item
    ));
  } catch {
    return '-';
  }
};

const formatLocationEvidence = (location) => {
  if (!location) return '-';
  if (location.status !== 'captured') return `${location.status || 'not_available'}${location.reason ? ` (${location.reason})` : ''}`;
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  const accuracy = Number(location.accuracyMeters);
  return [
    Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : 'coordinates unavailable',
    Number.isFinite(accuracy) ? `accuracy ${Math.round(accuracy)}m` : '',
    location.positionTimestamp ? `device time ${formatUtc(location.positionTimestamp)}` : '',
  ].filter(Boolean).join(' | ');
};

const formatDeviceEvidence = (clientEvidence) => {
  if (!clientEvidence) return '-';
  const device = clientEvidence.device || {};
  return [
    clientEvidence.deviceSessionId ? `session ${clientEvidence.deviceSessionId}` : '',
    clientEvidence.deviceProfileHash ? `device hash ${compactHash(clientEvidence.deviceProfileHash, 32)}` : '',
    device.timezone ? `timezone ${device.timezone}` : '',
    device.language ? `language ${device.language}` : '',
    device.screen?.width && device.screen?.height ? `screen ${device.screen.width}x${device.screen.height}` : '',
  ].filter(Boolean).join(' | ') || '-';
};

const formatTimestampEvidence = (trustedTimestamp) => {
  if (!trustedTimestamp) return '-';
  return [
    trustedTimestamp.status || 'unknown',
    trustedTimestamp.standard || '',
    trustedTimestamp.tsaUrl ? `TSA ${trustedTimestamp.tsaUrl}` : '',
    trustedTimestamp.tokenHash ? `token ${compactHash(trustedTimestamp.tokenHash, 32)}` : '',
    trustedTimestamp.responseHash ? `response ${compactHash(trustedTimestamp.responseHash, 32)}` : '',
    trustedTimestamp.receivedAt ? `received ${formatUtc(trustedTimestamp.receivedAt)}` : '',
  ].filter(Boolean).join(' | ');
};

const formatMediaEvidence = (mediaEvidence) => {
  if (!mediaEvidence) return '-';
  return [
    mediaEvidence.mode || 'standard',
    mediaEvidence.photo?.sha256 ? `photo ${compactHash(mediaEvidence.photo.sha256, 32)}` : '',
    mediaEvidence.video?.sha256 ? `video ${compactHash(mediaEvidence.video.sha256, 32)}` : '',
    mediaEvidence.evidenceHash ? `media evidence ${compactHash(mediaEvidence.evidenceHash, 32)}` : '',
    mediaEvidence.complete === false ? 'incomplete' : '',
  ].filter(Boolean).join(' | ') || '-';
};

const wrapText = (text, font, size, maxWidth) => {
  const words = safePdfText(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return ['-'];
  const lines = [];
  let line = '';

  const pushLongWord = (word) => {
    let chunk = '';
    for (const char of word) {
      const next = `${chunk}${char}`;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        chunk = next;
      } else {
        if (chunk) lines.push(chunk);
        chunk = char;
      }
    }
    return chunk;
  };

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      return;
    }
    if (line) lines.push(line);
    line = font.widthOfTextAtSize(word, size) <= maxWidth ? word : pushLongWord(word);
  });
  if (line) lines.push(line);
  return lines;
};

const contentFromDataUri = (dataUri) => {
  const value = String(dataUri || '').trim();
  if (!value) return null;
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (match) return Buffer.from(match[2], 'base64');
  return Buffer.from(value.replace(/^base64,/, ''), 'base64');
};

const embedDataUriImage = async (pdfDoc, dataUri) => {
  const bytes = contentFromDataUri(dataUri);
  if (!bytes?.length) return null;
  try {
    return await pdfDoc.embedPng(bytes);
  } catch {
    try {
      return await pdfDoc.embedJpg(bytes);
    } catch {
      return null;
    }
  }
};

const countPdfPages = async (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const pdf = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    return null;
  }
};

const signerRowsFor = (doc, signatures) => {
  const signatureByEmail = new Map(signatures.map((signature) => [normalizeEmail(signature.signerEmail), signature]));
  const rows = (doc.signers || []).map((signer) => {
    const signature = signatureByEmail.get(normalizeEmail(signer.email));
    return {
      name: signer.name || signature?.signerName || signer.email || 'Signer',
      email: signer.email || signature?.signerEmail || '',
      role: signer.role || signature?.signerRole || 'Signatory',
      status: signer.signingStatus || (signature ? 'signed' : 'not_signed'),
      authMethod: signer.authMethod || 'email',
      sentAt: signer.sentAt,
      viewedAt: signer.viewedAt,
      verifiedAt: signer.authVerifiedAt,
      signedAt: signer.signedAt || signature?.signedAt,
      signature,
    };
  });

  signatures.forEach((signature) => {
    const email = normalizeEmail(signature.signerEmail);
    if (!email || rows.some((row) => normalizeEmail(row.email) === email)) return;
    rows.push({
      name: signature.signerName || signature.signerEmail || 'Signer',
      email: signature.signerEmail || '',
      role: signature.signerRole || 'Signatory',
      status: 'signed',
      authMethod: signature.evidence?.authMethod || '-',
      signedAt: signature.signedAt,
      signature,
    });
  });

  return rows;
};

const createCompletionCertificatePdf = async ({ doc, signatures = [], auditLogs = [], generatedBy }) => {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);
  const finalization = doc.finalization || {};
  const fields = doc.signingFields || [];
  const completedFields = fields.filter((field) => field.filled).length;
  const requiredFields = fields.filter((field) => field.required !== false);
  const completedRequiredFields = requiredFields.filter((field) => field.filled).length;
  const signerRows = signerRowsFor(doc, signatures);
  const completedAt = finalization.finalizedAt || latestDate([
    ...signatures.map((signature) => signature.signedAt),
    ...signerRows.map((signer) => signer.signedAt),
  ]);
  const pageCount = await countPdfPages(finalization.finalizedPath || doc.path);

  let page;
  let y;

  const addPage = (first = false) => {
    page = pdfDoc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
    if (!first) {
      page.drawText('ContractIQ Digital Certificate of Completion', {
        x: MARGIN,
        y,
        size: 9,
        font: fontBold,
        color: COLORS.muted,
      });
      y -= 22;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE.width - MARGIN, y },
        thickness: 0.6,
        color: COLORS.line,
      });
      y -= 18;
    }
  };

  const ensureSpace = (height) => {
    if (y - height < MARGIN + 34) addPage(false);
  };

  const drawText = (text, x, baseline, options = {}) => {
    page.drawText(safePdfText(text), {
      x,
      y: baseline,
      size: options.size || 9,
      font: options.font || font,
      color: options.color || COLORS.ink,
      maxWidth: options.maxWidth,
    });
  };

  const drawWrapped = (text, x, baseline, width, options = {}) => {
    const size = options.size || 8.5;
    const lineHeight = options.lineHeight || size + 3;
    const selectedFont = options.font || font;
    const lines = wrapText(text, selectedFont, size, width);
    lines.forEach((line, index) => {
      drawText(line, x, baseline - index * lineHeight, {
        size,
        font: selectedFont,
        color: options.color || COLORS.ink,
      });
    });
    return baseline - lines.length * lineHeight;
  };

  const drawSection = (title) => {
    ensureSpace(38);
    y -= 6;
    drawText(title, MARGIN, y, { size: 11, font: fontBold, color: COLORS.navy });
    y -= 9;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE.width - MARGIN, y },
      thickness: 0.8,
      color: COLORS.line,
    });
    y -= 16;
  };

  const drawRows = (rows) => {
    const labelWidth = 136;
    const valueX = MARGIN + labelWidth + 12;
    const valueWidth = PAGE.width - MARGIN * 2 - labelWidth - 12;
    rows.forEach(([label, value, options = {}]) => {
      const selectedFont = options.mono ? fontMono : font;
      const displayValue = limitText(value || '-', options.maxLength || 900);
      const valueLines = wrapText(displayValue, selectedFont, 8.5, valueWidth);
      const height = Math.max(16, valueLines.length * 11 + 4);
      ensureSpace(height);
      drawText(label, MARGIN, y, { size: 8.5, font: fontBold, color: COLORS.muted });
      valueLines.forEach((line, index) => {
        drawText(line, valueX, y - index * 11, {
          size: 8.5,
          font: selectedFont,
          color: options.color || COLORS.ink,
        });
      });
      y -= height;
    });
  };

  const drawSummaryPanel = () => {
    const panelHeight = 88;
    ensureSpace(panelHeight + 12);
    page.drawRectangle({
      x: MARGIN,
      y: y - panelHeight,
      width: PAGE.width - MARGIN * 2,
      height: panelHeight,
      color: COLORS.panel,
      borderColor: COLORS.line,
      borderWidth: 0.8,
    });
    const columns = [
      ['Status', finalization.status === 'finalized' ? 'Finalized' : doc.status || 'Completed'],
      ['Completed at', formatUtc(completedAt)],
      ['Signers', `${signatures.length} recorded signature${signatures.length === 1 ? '' : 's'}`],
      ['Required fields', `${completedRequiredFields} of ${requiredFields.length} complete`],
    ];
    columns.forEach(([label, value], index) => {
      const colWidth = (PAGE.width - MARGIN * 2) / 4;
      const x = MARGIN + index * colWidth + 14;
      drawText(label, x, y - 24, { size: 8, font: fontBold, color: COLORS.muted });
      drawWrapped(value, x, y - 43, colWidth - 26, { size: 9, font: fontBold, color: index === 0 ? COLORS.green : COLORS.ink });
    });
    y -= panelHeight + 18;
  };

  const drawSignatureImage = async (signature, x, topY) => {
    const image = await embedDataUriImage(pdfDoc, signature.signatureData);
    if (!image) return;
    const maxWidth = 132;
    const maxHeight = 48;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawRectangle({
      x,
      y: topY - maxHeight - 7,
      width: maxWidth,
      height: maxHeight + 8,
      color: COLORS.white,
      borderColor: COLORS.line,
      borderWidth: 0.5,
    });
    page.drawImage(image, {
      x: x + (maxWidth - width) / 2,
      y: topY - maxHeight - 3 + (maxHeight - height) / 2,
      width,
      height,
    });
  };

  const drawSignatureRecord = async (signature, index) => {
    const rows = [
      ['Signer', signature.signerName || signature.signerEmail || 'Signer'],
      ['Email', signature.signerEmail || '-'],
      ['Role', signature.signerRole || '-'],
      ['Method', signature.method || '-'],
      ['Signed at', formatUtc(signature.signedAt)],
      ['IP address', signature.ipAddress || signature.evidence?.ipAddress || '-'],
      ['Audit hash', compactHash(signature.auditHash), { mono: true }],
      ['Evidence hash', compactHash(signature.evidence?.evidenceHash), { mono: true }],
      ['Trusted timestamp', formatTimestampEvidence(signature.evidence?.trustedTimestamp)],
      ['Device evidence', formatDeviceEvidence(signature.evidence?.clientEvidence)],
      ['Location evidence', formatLocationEvidence(signature.evidence?.clientEvidence?.location)],
      ['Photo/video evidence', formatMediaEvidence(signature.evidence?.mediaEvidence)],
      ['Signature image hash', compactHash(signature.signatureImageHash || signature.evidence?.signatureImageHash), { mono: true }],
      ['Initials image hash', compactHash(signature.initialsImageHash || signature.evidence?.initialsImageHash), { mono: true }],
      ['User agent', limitText(signature.userAgent || signature.evidence?.userAgent || '-', 260)],
    ];
    const labelWidth = 94;
    const valueWidth = 266;
    const rowHeights = rows.map(([, value, options = {}]) => (
      Math.max(13, wrapText(limitText(value || '-', 260), options.mono ? fontMono : font, 7.3, valueWidth).length * 9)
    ));
    const cardHeight = 42 + rowHeights.reduce((sum, height) => sum + height, 0);
    ensureSpace(cardHeight + 12);
    const topY = y;
    page.drawRectangle({
      x: MARGIN,
      y: topY - cardHeight,
      width: PAGE.width - MARGIN * 2,
      height: cardHeight,
      color: index % 2 === 0 ? COLORS.panel : COLORS.white,
      borderColor: COLORS.line,
      borderWidth: 0.7,
    });
    drawText(`Signature record ${index + 1}`, MARGIN + 12, topY - 18, { size: 9, font: fontBold, color: COLORS.navy });
    await drawSignatureImage(signature, PAGE.width - MARGIN - 148, topY - 11);

    let rowY = topY - 36;
    rows.forEach(([label, value, options = {}], rowIndex) => {
      const selectedFont = options.mono ? fontMono : font;
      drawText(label, MARGIN + 12, rowY, { size: 7.3, font: fontBold, color: COLORS.muted });
      wrapText(limitText(value || '-', 260), selectedFont, 7.3, valueWidth).forEach((line, lineIndex) => {
        drawText(line, MARGIN + 12 + labelWidth, rowY - lineIndex * 9, {
          size: 7.3,
          font: selectedFont,
          color: COLORS.ink,
        });
      });
      rowY -= rowHeights[rowIndex];
    });
    y = topY - cardHeight - 14;
  };

  addPage(true);
  page.drawRectangle({ x: 0, y: PAGE.height - 116, width: PAGE.width, height: 116, color: COLORS.navy });
  drawText('Digital Certificate of Completion', MARGIN, PAGE.height - 48, { size: 21, font: fontBold, color: COLORS.white });
  drawText('ContractIQ signing evidence record', MARGIN, PAGE.height - 69, { size: 10, font, color: rgb(0.78, 0.86, 1) });
  drawText(`Certificate ID: COC-${doc._id}`, MARGIN, PAGE.height - 91, { size: 8.5, font: fontMono, color: COLORS.white });
  drawText(`Generated: ${formatUtc(new Date())}`, PAGE.width - 222, PAGE.height - 91, { size: 8.5, font, color: COLORS.white });
  y = PAGE.height - 142;

  drawSummaryPanel();
  drawWrapped(
    'This certificate summarizes the completed electronic signing transaction and the audit evidence captured by ContractIQ. Keep it with the finalized document to verify signer intent, completion timing, and document integrity.',
    MARGIN,
    y,
    PAGE.width - MARGIN * 2,
    { size: 9, color: COLORS.muted, lineHeight: 13 },
  );
  y -= 44;

  drawSection('Document and Envelope');
  drawRows([
    ['Document name', doc.name],
    ['Envelope / document ID', String(doc._id || '-')],
    ['Original filename', doc.originalName || doc.filename || '-'],
    ['Document type', doc.type || '-'],
    ['Page count', pageCount ? String(pageCount) : '-'],
    ['Uploaded by', doc.uploadedBy?.email ? `${doc.uploadedBy.name || 'Owner'} <${doc.uploadedBy.email}>` : String(doc.uploadedBy || '-')],
    ['Signing order', doc.signingOrder || 'parallel'],
    ['Fields completed', `${completedFields} of ${fields.length}`],
    ['Required fields completed', `${completedRequiredFields} of ${requiredFields.length}`],
  ]);

  if (doc.signingEvidence?.mode === 'ron') {
    const ron = doc.signingEvidence.ron || {};
    const notary = ron.notary || {};
    const session = ron.session || {};
    const seal = ron.seal || {};
    drawSection('Remote Online Notarization Evidence');
    drawRows([
      ['RON package', 'Requested'],
      ['Notary', notary.email ? `${notary.name || 'Notary'} <${notary.email}>` : (notary.name || '-')],
      ['Commission', [notary.commissionState, notary.commissionNumber].filter(Boolean).join(' / ') || '-'],
      ['Commission expires', notary.commissionExpiresAt || '-'],
      ['County / venue', notary.county || '-'],
      ['Identity proofing', ron.identityMethod || '-'],
      ['Live session provider', session.provider || '-'],
      ['Live session status', session.status || '-'],
      ['Session started / completed', `${formatUtc(session.notaryStartedAt)} / ${formatUtc(session.completedAt)}`],
      ['Recording storage / hash', `${session.recordingStorage || session.recording?.storage || '-'} / ${session.recordingSha256 || session.recording?.sha256 || '-'}`],
      ['Notary seal', seal.appliedAt ? `Applied at ${formatUtc(seal.appliedAt)}` : 'not applied'],
      ['Required evidence', 'Live audio/video, signer identity proofing, electronic journal, tamper-evident certificate'],
    ]);
  }

  drawSection('Final PDF Integrity');
  drawRows([
    ['Finalization status', finalization.status || 'not_started'],
    ['Finalized at', formatUtc(finalization.finalizedAt)],
    ['Final PDF hash', finalization.finalPdfHash || '-', { mono: true }],
    ['Flattened PDF hash', finalization.flattenedHash || '-', { mono: true }],
    ['Source file hash', doc.signingPreparation?.sourceFileHash || '-', { mono: true }],
    ['Fields hash', doc.signingPreparation?.fieldsHash || '-', { mono: true }],
    ['Digital seal', finalization.digitalSignatureStatus || 'not configured'],
    ['Certificate fingerprint', finalization.certificateFingerprint || '-', { mono: true }],
    ['Signature standard', finalization.signatureStandard || '-'],
    ['Final PDF size', finalization.byteLength ? `${finalization.byteLength} bytes` : '-'],
  ]);

  drawSection('Recipient Events');
  if (signerRows.length) {
    signerRows.forEach((signer, index) => {
      drawRows([
        [`Recipient ${index + 1}`, `${signer.name} <${signer.email || '-'}>`],
        ['Role / status', `${signer.role} / ${signer.status}`],
        ['Authentication', signer.authMethod || '-'],
        ['Sent / viewed', `${formatUtc(signer.sentAt)} / ${formatUtc(signer.viewedAt)}`],
        ['Verified / signed', `${formatUtc(signer.verifiedAt)} / ${formatUtc(signer.signedAt)}`],
      ]);
      y -= 4;
    });
  } else {
    drawRows([['Recipients', 'No recipient records were available.']]);
  }

  drawSection('Signature Evidence');
  if (signatures.length) {
    for (let index = 0; index < signatures.length; index += 1) {
      await drawSignatureRecord(signatures[index], index);
    }
  } else {
    drawRows([['Signatures', 'No signature records were available.']]);
  }

  drawSection('Field Completion Detail');
  if (fields.length) {
    fields.forEach((field, index) => {
      drawRows([
        [`Field ${index + 1}`, `${field.type || 'field'} on page ${field.page || 1}`],
        ['Field ID / role', `${field.id || '-'} / ${field.role || '-'}`],
        ['Assigned to', field.assignedTo || 'Any signer'],
        ['Required / filled', `${field.required === false ? 'No' : 'Yes'} / ${field.filled ? 'Yes' : 'No'}`],
        ['Filled by / at', `${field.filledBy || '-'} / ${formatUtc(field.filledAt)}`],
        ['Value', ['signature', 'initials'].includes(field.type) ? '[signature image evidence stored in signature record]' : (field.fieldValue ?? '-')],
      ]);
      y -= 2;
    });
  } else {
    drawRows([['Fields', 'No placed signing fields were available.']]);
  }

  drawSection('Audit Timeline');
  if (auditLogs.length) {
    auditLogs.forEach((log, index) => {
      drawRows([
        [`Event ${index + 1}`, log.action || 'Activity event'],
        ['Time', formatUtc(log.createdAt)],
        ['Actor', log.performedBy?.email ? `${log.performedBy.name || 'User'} <${log.performedBy.email}>` : (log.performedByEmail || 'ContractIQ')],
        ['Category / result', `${log.category || '-'} / ${log.result || 'success'}`],
        ['IP / user agent', `${log.ipAddress || '-'} / ${log.userAgent || '-'}`],
        ['Metadata', safeJson(log.metadata)],
      ]);
      y -= 3;
    });
  } else {
    drawRows([['Audit events', 'No audit log events were available.']]);
  }

  drawSection('Certificate Generation');
  drawRows([
    ['Generated by', generatedBy?.email ? `${generatedBy.name || 'User'} <${generatedBy.email}>` : 'ContractIQ'],
    ['Generated at', formatUtc(new Date())],
    ['Purpose', 'PDF certificate for the completed ContractIQ signing package.'],
  ]);

  const pages = pdfDoc.getPages();
  pages.forEach((certificatePage, index) => {
    certificatePage.drawLine({
      start: { x: MARGIN, y: 32 },
      end: { x: PAGE.width - MARGIN, y: 32 },
      thickness: 0.5,
      color: COLORS.line,
    });
    certificatePage.drawText(safePdfText(`ContractIQ Certificate of Completion - ${doc._id}`), {
      x: MARGIN,
      y: 18,
      size: 7,
      font,
      color: COLORS.muted,
    });
    certificatePage.drawText(`Page ${index + 1} of ${pages.length}`, {
      x: PAGE.width - MARGIN - 64,
      y: 18,
      size: 7,
      font,
      color: COLORS.muted,
    });
  });

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
};

module.exports = {
  createCompletionCertificatePdf,
};
