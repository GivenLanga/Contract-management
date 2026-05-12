const test = require('node:test');
const assert = require('node:assert/strict');

const { visionPercentToPdfField } = require('../src/services/visionFieldDetectionService');
const {
  assignFieldsToSigners,
  buildMiddlePageInitialFields,
  finalizeDetectedFieldLayout,
  mergeFields,
  pathGeometryFromOperatorList,
  textLayoutFieldsFromLines,
} = require('../src/services/documentIdpService');

test('visionPercentToPdfField converts top-left percentage boxes to PDF coordinates', () => {
  const field = visionPercentToPdfField({
    type: 'signature',
    page: 2,
    xPercent: 10,
    yPercent: 20,
    widthPercent: 30,
    heightPercent: 5,
    confidence: 0.91,
    rawType: 'signature_line',
    pixelBox: [300, 600, 1200, 750],
    imageWidth: 3000,
    imageHeight: 3000,
    dpi: 300,
  }, [
    { page: 1, width: 600, height: 800 },
    { page: 2, width: 612, height: 792 },
  ]);

  assert.equal(field.source, 'yolo-cv');
  assert.equal(field.type, 'signature');
  assert.equal(field.page, 2);
  assert.equal(field.x, 61.2);
  assert.equal(field.width, 183.6);
  assert.equal(field.height, 39.6);
  assert.equal(field.y, 594);
  assert.deepEqual(field.detection.normalizedPercent, {
    x: 10,
    y: 20,
    width: 30,
    height: 5,
  });
});

test('mergeFields preserves explicit AI/CV checkbox field types', () => {
  const [field] = mergeFields([
    {
      type: 'checkbox',
      page: 1,
      x: 120,
      y: 300,
      width: 22,
      height: 22,
      source: 'yolo-cv',
      confidence: 0.88,
      rawType: 'checkbox',
    },
  ], [
    { page: 1, width: 612, height: 792 },
  ]);

  assert.equal(field.type, 'checkbox');
  assert.equal(field.source, 'yolo-cv');
});

test('mergeFields preserves stacked text fields with matching x positions', () => {
  const fields = mergeFields([
    {
      type: 'text',
      page: 1,
      x: 144,
      y: 447,
      width: 189,
      height: 15,
      source: 'heuristic-keyword',
      confidence: 0.82,
      context: 'Full Name: __________________________________',
    },
    {
      type: 'text',
      page: 1,
      x: 144,
      y: 430,
      width: 189,
      height: 15,
      source: 'heuristic-keyword',
      confidence: 0.82,
      context: 'Title: __________________________________',
    },
  ], [
    { page: 1, width: 612, height: 792 },
  ]);

  assert.deepEqual(fields.map((field) => field.context), [
    'Full Name: __________________________________',
    'Title: __________________________________',
  ]);
});

test('finalizeDetectedFieldLayout removes hidden same-space text fields', () => {
  const fields = finalizeDetectedFieldLayout(mergeFields([
    {
      type: 'text',
      page: 1,
      x: 144,
      y: 430,
      width: 189,
      height: 20,
      source: 'heuristic-keyword',
      confidence: 0.82,
      context: 'Name: __________________________________',
    },
    {
      type: 'date',
      page: 1,
      x: 144,
      y: 430,
      width: 189,
      height: 24,
      source: 'heuristic-keyword',
      confidence: 0.82,
      context: 'Date: __________________________________',
    },
  ], [
    { page: 1, width: 612, height: 792 },
  ]));

  assert.equal(fields.fields.length, 1);
  assert.equal(fields.fields[0].type, 'date');
  assert.equal(fields.removedFields.length, 1);
  assert.equal(fields.removedFields[0].type, 'text');
  assert.equal(fields.overlaps.length, 0);
});

test('finalizeDetectedFieldLayout trims stacked fields instead of leaving overlaps', () => {
  const layout = finalizeDetectedFieldLayout(mergeFields([
    {
      type: 'text',
      page: 1,
      x: 144,
      y: 500,
      width: 189,
      height: 24,
      source: 'heuristic-keyword',
      confidence: 0.82,
      context: 'Full Name: __________________________________',
    },
    {
      type: 'text',
      page: 1,
      x: 144,
      y: 488,
      width: 189,
      height: 24,
      source: 'heuristic-keyword',
      confidence: 0.82,
      context: 'Title: __________________________________',
    },
  ], [
    { page: 1, width: 612, height: 792 },
  ]));

  const [top, bottom] = layout.fields;
  assert.equal(layout.fields.length, 2);
  assert.equal(layout.overlaps.length, 0);
  assert.ok(bottom.y + bottom.height <= top.y);
});

test('textLayoutFieldsFromLines sizes explicit Date fields before the next label', () => {
  const metric = { page: 2, width: 612, height: 792 };
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Date: ______________________ Signature: ______________________________',
      y: 500,
      runs: [
        { textIndex: 6, textEnd: 28, x: 110, y: 500, width: 132, chars: 22 },
        { textIndex: 40, textEnd: 70, x: 330, y: 500, width: 180, chars: 30 },
      ],
    },
  ], 2, metric, [{ email: 'signer@example.com' }]);

  const dateField = fields.find((field) => field.type === 'date');
  const signatureField = fields.find((field) => field.type === 'signature');

  assert.equal(dateField.x, 110);
  assert.equal(dateField.width, 132);
  assert.equal(signatureField.x, 330);
  assert.equal(signatureField.width, 180);
});

test('textLayoutFieldsFromLines treats each on-this-day execution blank as its own value field', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'SIGNED at ______________________ on this ______ day of ______________________ 20____.',
      y: 500,
      runs: [
        { textIndex: 10, textEnd: 30, x: 120, y: 500, width: 110, chars: 20 },
        { textIndex: 39, textEnd: 45, x: 300, y: 500, width: 40, chars: 6 },
        { textIndex: 53, textEnd: 75, x: 380, y: 500, width: 120, chars: 22 },
        { textIndex: 78, textEnd: 82, x: 520, y: 500, width: 24, chars: 4 },
      ],
    },
  ], 2, { page: 2, width: 612, height: 792 }, [{ email: 'signer@example.com' }]);

  const textFields = fields.filter((field) => field.type === 'text');
  const numberFields = fields.filter((field) => field.type === 'number');

  assert.equal(fields.some((field) => field.type === 'date'), false);
  assert.equal(textFields.length, 2);
  assert.deepEqual(textFields.map((field) => field.x), [120, 380]);
  assert.deepEqual(textFields.map((field) => field.detection.fragmentRole), ['execution-place', 'month']);
  assert.equal(numberFields.length, 2);
  assert.deepEqual(numberFields.map((field) => field.x), [300, 520]);
  assert.deepEqual(numberFields.map((field) => field.detection.fragmentRole), ['day', 'year']);
});

test('buildMiddlePageInitialFields skips first and last page', () => {
  const fields = buildMiddlePageInitialFields([
    { page: 1, width: 612, height: 792 },
    { page: 2, width: 612, height: 792 },
    { page: 3, width: 612, height: 792 },
    { page: 4, width: 612, height: 792 },
  ], [
    { email: 'a@example.com', role: 'Party A' },
    { email: 'b@example.com', role: 'Party B' },
  ]);

  assert.equal(fields.length, 4);
  assert.deepEqual([...new Set(fields.map((field) => field.page))], [2, 3]);
  assert.ok(fields.every((field) => field.type === 'initials'));
  assert.ok(fields.every((field) => field.required));
});

test('textLayoutFieldsFromLines can use drawn horizontal PDF lines', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Signature:',
      y: 420,
      runs: [],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [
    { source: 'pdf-path-line', x: 160, y: 420, width: 240, chars: 48 },
  ]);

  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'signature');
  assert.equal(fields[0].x, 160);
  assert.equal(fields[0].width, 240);
});

test('textLayoutFieldsFromLines ignores body text that merely mentions signature blocks', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Blank signature blocks, schedules, and annexures must be completed. No warranty is created by this clause.',
      y: 635,
      runs: [],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [
    { source: 'pdf-path-line', x: 60, y: 635, width: 475, chars: 95 },
  ]);

  assert.equal(fields.some((field) => field.type === 'signature'), false);
});

test('textLayoutFieldsFromLines trims drawn line fields before later text', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Date Terms',
      y: 420,
      runs: [],
      items: [
        { text: 'Date', textIndex: 0, textEnd: 4, x: 50, y: 420, width: 26, height: 12, charWidth: 6.5 },
        { text: 'Terms', textIndex: 5, textEnd: 10, x: 220, y: 420, width: 34, height: 12, charWidth: 6.8 },
      ],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [
    { source: 'pdf-path-line', x: 80, y: 420, width: 220, chars: 44 },
  ]);

  const dateField = fields.find((field) => field.type === 'date');

  assert.ok(dateField.x > 76);
  assert.ok(dateField.x + dateField.width < 220);
});

test('assignFieldsToSigners keeps execution-date fragments with the nearest signature block', () => {
  const assigned = assignFieldsToSigners([
    {
      id: 'place_a',
      type: 'text',
      page: 3,
      x: 125,
      y: 627,
      width: 112,
      height: 26,
      detection: { isInlineDateClause: true, clauseLineId: 'a', fragmentRole: 'execution-place' },
    },
    {
      id: 'sig_a',
      type: 'signature',
      page: 3,
      x: 68,
      y: 485,
      width: 328,
      height: 30,
    },
    {
      id: 'year_b',
      type: 'number',
      page: 3,
      x: 480,
      y: 455,
      width: 24,
      height: 28,
      detection: { isInlineDateClause: true, clauseLineId: 'b', fragmentRole: 'year' },
    },
    {
      id: 'sig_b',
      type: 'signature',
      page: 3,
      x: 68,
      y: 313,
      width: 328,
      height: 30,
    },
  ], [
    { email: 'a@example.com', role: 'Party A' },
    { email: 'b@example.com', role: 'Party B' },
  ]);

  assert.equal(assigned.find((field) => field.id === 'place_a').assignedTo, 'a@example.com');
  assert.equal(assigned.find((field) => field.id === 'sig_a').assignedTo, 'a@example.com');
  assert.equal(assigned.find((field) => field.id === 'year_b').assignedTo, 'b@example.com');
  assert.equal(assigned.find((field) => field.id === 'sig_b').assignedTo, 'b@example.com');
});

test('assignFieldsToSigners assigns one complete repeated signing block before moving to the next signer', () => {
  const signerBlockHint = (signerIndex) => ({ signerIndex, signerAssignmentSource: 'signer-block' });
  const assigned = assignFieldsToSigners([
    {
      id: 'top_place',
      type: 'text',
      page: 5,
      x: 114,
      y: 516,
      width: 125,
      height: 28,
      detection: { ...signerBlockHint(0), isInlineDateClause: true, clauseLineId: 'top', fragmentRole: 'execution-place' },
    },
    {
      id: 'top_day',
      type: 'number',
      page: 5,
      x: 286,
      y: 516,
      width: 47,
      height: 28,
      detection: { ...signerBlockHint(0), isInlineDateClause: true, clauseLineId: 'top', fragmentRole: 'day' },
    },
    {
      id: 'top_sig',
      type: 'signature',
      page: 5,
      x: 144,
      y: 464,
      width: 189,
      height: 30,
      detection: signerBlockHint(1),
    },
    {
      id: 'top_name',
      type: 'text',
      page: 5,
      x: 144,
      y: 447,
      width: 189,
      height: 20,
      detection: signerBlockHint(1),
    },
    {
      id: 'bottom_place',
      type: 'text',
      page: 5,
      x: 114,
      y: 378,
      width: 125,
      height: 28,
      detection: { ...signerBlockHint(1), isInlineDateClause: true, clauseLineId: 'bottom', fragmentRole: 'execution-place' },
    },
    {
      id: 'bottom_sig',
      type: 'signature',
      page: 5,
      x: 144,
      y: 326,
      width: 189,
      height: 30,
      detection: signerBlockHint(1),
    },
    {
      id: 'bottom_name',
      type: 'text',
      page: 5,
      x: 144,
      y: 309,
      width: 189,
      height: 20,
      detection: signerBlockHint(1),
    },
  ], [
    { email: 'a@example.com', role: 'Party A' },
    { email: 'b@example.com', role: 'Party B' },
  ]);

  for (const id of ['top_place', 'top_day', 'top_sig', 'top_name']) {
    assert.equal(assigned.find((field) => field.id === id).assignedTo, 'a@example.com', id);
  }
  for (const id of ['bottom_place', 'bottom_sig', 'bottom_name']) {
    assert.equal(assigned.find((field) => field.id === id).assignedTo, 'b@example.com', id);
  }
});

test('assignFieldsToSigners assigns repeated table signing groups sequentially without signatures', () => {
  const signerBlockHint = { signerIndex: 0, signerAssignmentSource: 'signer-block' };
  const assigned = assignFieldsToSigners([
    {
      id: 'company_place',
      type: 'text',
      page: 2,
      x: 135,
      y: 725,
      width: 236,
      height: 18,
      context: 'Signed at:-',
    },
    {
      id: 'company_date',
      type: 'date',
      page: 2,
      x: 135,
      y: 700,
      width: 236,
      height: 18,
      context: 'Date:-',
    },
    {
      id: 'company_name',
      type: 'text',
      page: 2,
      x: 135,
      y: 610,
      width: 236,
      height: 16,
      context: 'Name',
      detection: signerBlockHint,
    },
    {
      id: 'company_designation',
      type: 'text',
      page: 2,
      x: 135,
      y: 589,
      width: 236,
      height: 16,
      context: 'Designation',
      detection: signerBlockHint,
    },
    {
      id: 'consultant_place',
      type: 'text',
      page: 2,
      x: 135,
      y: 482,
      width: 236,
      height: 16,
      context: 'Signed at:-',
      detection: signerBlockHint,
    },
    {
      id: 'consultant_date',
      type: 'date',
      page: 2,
      x: 135,
      y: 465,
      width: 236,
      height: 16,
      context: 'Date:-',
      detection: signerBlockHint,
    },
  ], [
    { email: 'a@example.com', role: 'Party A' },
    { email: 'b@example.com', role: 'Party B' },
  ]);

  for (const id of ['company_place', 'company_date', 'company_name', 'company_designation']) {
    assert.equal(assigned.find((field) => field.id === id).assignedTo, 'a@example.com', id);
  }
  for (const id of ['consultant_place', 'consultant_date']) {
    assert.equal(assigned.find((field) => field.id === id).assignedTo, 'b@example.com', id);
  }
});

test('textLayoutFieldsFromLines detects sign, full name, and title line fields', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Sign: ____________________',
      y: 520,
      runs: [
        { textIndex: 6, textEnd: 26, x: 120, y: 520, width: 140, chars: 20 },
      ],
    },
    {
      text: 'Full Name: ______________________________',
      y: 480,
      runs: [
        { textIndex: 11, textEnd: 41, x: 150, y: 480, width: 210, chars: 30 },
      ],
    },
    {
      text: 'Title ____________________',
      y: 440,
      runs: [
        { textIndex: 6, textEnd: 26, x: 125, y: 440, width: 150, chars: 20 },
      ],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }]);

  const signatureField = fields.find((field) => field.type === 'signature');
  const textFields = fields.filter((field) => field.type === 'text');

  assert.equal(signatureField.x, 120);
  assert.equal(signatureField.width, 140);
  assert.deepEqual(textFields.map((field) => field.x), [150, 125]);
  assert.deepEqual(textFields.map((field) => field.width), [210, 150]);
});

test('textLayoutFieldsFromLines treats designation as text, not signature', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Designation: ____________________',
      y: 420,
      runs: [
        { textIndex: 13, textEnd: 33, x: 150, y: 420, width: 180, chars: 20 },
      ],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }]);

  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'text');
});

test('textLayoutFieldsFromLines detects Place as a text field', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Place: ____________________',
      y: 420,
      runs: [
        { textIndex: 7, textEnd: 27, x: 150, y: 420, width: 180, chars: 20 },
      ],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }]);

  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'text');
  assert.equal(fields[0].detector, 'pdfjs-text-underline-text');
  assert.equal(fields[0].x, 150);
});

test('textLayoutFieldsFromLines ignores table prose that mentions sign authority', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'I warrant that I have been duly authorised to sign this document',
      y: 324,
      runs: [],
      items: [
        { text: 'I warrant that I have been duly authorised to sign this document', textIndex: 0, textEnd: 62, x: 68, y: 324, width: 330, height: 12, charWidth: 5.3 },
      ],
      x: 68,
      right: 398,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 300, width: 370, height: 60 },
    { x: 420, y: 300, width: 140, height: 60 },
  ]);

  assert.equal(fields.length, 0);
});

test('textLayoutFieldsFromLines skips inline table blanks without an empty adjacent cell', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Designation: ______________________________',
      y: 324,
      runs: [
        { textIndex: 13, textEnd: 43, x: 132, y: 324, width: 238, chars: 30 },
      ],
      items: [
        { text: 'Designation:', textIndex: 0, textEnd: 12, x: 68, y: 324, width: 62, height: 12, charWidth: 5.2 },
        { text: '______________________________', textIndex: 13, textEnd: 43, x: 132, y: 324, width: 238, height: 12, charWidth: 7.9 },
      ],
      x: 68,
      right: 370,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 300, width: 220, height: 60 },
    { x: 270, y: 300, width: 220, height: 60 },
  ]);

  assert.equal(fields.length, 0);
});

test('textLayoutFieldsFromLines places table signatures inside the table cell area', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Signature',
      y: 324,
      runs: [],
      items: [
        { text: 'Signature', textIndex: 0, textEnd: 9, x: 68, y: 324, width: 54, height: 12, charWidth: 6 },
      ],
      x: 68,
      right: 122,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 300, width: 110, height: 60 },
    { x: 160, y: 300, width: 260, height: 60 },
  ]);

  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'signature');
  assert.equal(Number(fields[0].x.toFixed(1)), 166.5);
  assert.equal(Number(fields[0].y.toFixed(1)), 304.8);
  assert.equal(Number(fields[0].width.toFixed(1)), 247);
  assert.equal(Number(fields[0].height.toFixed(1)), 50.4);
  assert.equal(fields[0].detector, 'pdfjs-table-signature-cell');
});

test('textLayoutFieldsFromLines skips occupied target table cells', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Signature',
      y: 324,
      runs: [],
      items: [
        { text: 'Signature', textIndex: 0, textEnd: 9, x: 68, y: 324, width: 54, height: 12, charWidth: 6 },
      ],
      x: 68,
      right: 122,
      height: 12,
    },
    {
      text: 'For Company',
      y: 324,
      runs: [],
      items: [
        { text: 'For Company', textIndex: 0, textEnd: 11, x: 178, y: 324, width: 78, height: 12, charWidth: 7 },
      ],
      x: 178,
      right: 256,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 300, width: 110, height: 60 },
    { x: 160, y: 300, width: 260, height: 60 },
  ]);

  assert.equal(fields.length, 0);
});

test('textLayoutFieldsFromLines does not jump over occupied adjacent table cells', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Signature',
      y: 324,
      runs: [],
      items: [
        { text: 'Signature', textIndex: 0, textEnd: 9, x: 68, y: 324, width: 54, height: 12, charWidth: 6 },
      ],
      x: 68,
      right: 122,
      height: 12,
    },
    {
      text: 'Occupied',
      y: 324,
      runs: [],
      items: [
        { text: 'Occupied', textIndex: 0, textEnd: 8, x: 178, y: 324, width: 58, height: 12, charWidth: 7.2 },
      ],
      x: 178,
      right: 236,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 300, width: 110, height: 60 },
    { x: 160, y: 300, width: 140, height: 60 },
    { x: 300, y: 300, width: 220, height: 60 },
  ]);

  assert.equal(fields.length, 0);
});

test('textLayoutFieldsFromLines places table text fields inside the table cell area', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Full Name',
      y: 224,
      runs: [],
      items: [
        { text: 'Full Name', textIndex: 0, textEnd: 9, x: 68, y: 224, width: 58, height: 12, charWidth: 6.4 },
      ],
      x: 68,
      right: 126,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 200, width: 120, height: 44 },
    { x: 170, y: 200, width: 250, height: 44 },
  ]);

  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'text');
  assert.equal(Number(fields[0].x.toFixed(1)), 176.3);
  assert.equal(Number(fields[0].y.toFixed(1)), 205);
  assert.equal(Number(fields[0].width.toFixed(1)), 237.5);
  assert.equal(Number(fields[0].height.toFixed(1)), 34);
  assert.equal(fields[0].detector, 'pdfjs-table-text-cell');
});

test('textLayoutFieldsFromLines places table fields in the adjacent blank cell, not on the label text', () => {
  const targetCell = { x: 160, y: 300, width: 260, height: 44 };
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Name ______________________________',
      y: 324,
      runs: [
        { textIndex: 5, textEnd: 35, x: 178, y: 324, width: 210, chars: 30 },
      ],
      items: [
        { text: 'Name', textIndex: 0, textEnd: 4, x: 68, y: 324, width: 34, height: 12, charWidth: 8.5 },
        { text: '______________________________', textIndex: 5, textEnd: 35, x: 178, y: 324, width: 210, height: 12, charWidth: 7 },
      ],
      x: 68,
      right: 388,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 300, width: 110, height: 44 },
    targetCell,
  ]);

  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'text');
  assert.ok(fields[0].x >= targetCell.x);
  assert.ok(fields[0].x + fields[0].width <= targetCell.x + targetCell.width);
  assert.ok(fields[0].y >= targetCell.y);
  assert.ok(fields[0].y + fields[0].height <= targetCell.y + targetCell.height);
});

test('textLayoutFieldsFromLines prevents table fields from overlapping each other', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Full Name',
      y: 352,
      runs: [],
      items: [
        { text: 'Full Name', textIndex: 0, textEnd: 9, x: 68, y: 352, width: 58, height: 12, charWidth: 6.4 },
      ],
      x: 68,
      right: 126,
      height: 12,
    },
    {
      text: 'Title',
      y: 320,
      runs: [],
      items: [
        { text: 'Title', textIndex: 0, textEnd: 5, x: 68, y: 320, width: 28, height: 12, charWidth: 5.6 },
      ],
      x: 68,
      right: 96,
      height: 12,
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }], [], [
    { x: 50, y: 345, width: 110, height: 45 },
    { x: 160, y: 345, width: 220, height: 45 },
    { x: 50, y: 300, width: 110, height: 45 },
    { x: 160, y: 300, width: 220, height: 45 },
  ]);

  assert.equal(fields.length, 2);
  assert.equal(fields.every((field) => field.type === 'text'), true);
  const [first, second] = fields;
  const yOverlap = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  const xOverlap = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  assert.equal(xOverlap * yOverlap, 0);
});

test('textLayoutFieldsFromLines keeps stacked line text fields equal height and non-overlapping', () => {
  const fields = textLayoutFieldsFromLines([
    {
      text: 'Full Name: ____________________',
      y: 500,
      runs: [
        { textIndex: 11, textEnd: 31, x: 150, y: 500, width: 180, chars: 20 },
      ],
    },
    {
      text: 'Title: ____________________',
      y: 486,
      runs: [
        { textIndex: 7, textEnd: 27, x: 150, y: 486, width: 180, chars: 20 },
      ],
    },
    {
      text: 'Capacity: ____________________',
      y: 472,
      runs: [
        { textIndex: 10, textEnd: 30, x: 150, y: 472, width: 180, chars: 20 },
      ],
    },
  ], 1, { page: 1, width: 612, height: 792 }, [{ email: 'signer@example.com' }]);

  const textFields = fields.filter((field) => field.type === 'text');
  assert.equal(textFields.length, 3);
  assert.deepEqual([...new Set(textFields.map((field) => field.height))], [14, 12]);
  assert.ok(textFields[1].y + textFields[1].height <= textFields[0].y);
  assert.ok(textFields[2].y + textFields[2].height <= textFields[1].y);
});

test('pathGeometryFromOperatorList applies PDF transforms to table rectangles', () => {
  const ops = {
    save: 10,
    restore: 11,
    transform: 12,
    constructPath: 91,
  };
  const geometry = pathGeometryFromOperatorList({
    fnArray: [ops.save, ops.transform, ops.constructPath, ops.restore],
    argsArray: [
      null,
      [1, 0, 0, 1, 50, 75],
      [20, [], [0, 0, 200, 60]],
      null,
    ],
  }, { page: 1, width: 612, height: 792 }, ops);

  assert.equal(geometry.tableCells.length, 1);
  assert.deepEqual(
    {
      x: geometry.tableCells[0].x,
      y: geometry.tableCells[0].y,
      width: geometry.tableCells[0].width,
      height: geometry.tableCells[0].height,
    },
    { x: 50, y: 75, width: 200, height: 60 }
  );
});

test('pathGeometryFromOperatorList derives table cells from rectangle edges and divider lines', () => {
  const ops = {
    constructPath: 91,
  };
  const geometry = pathGeometryFromOperatorList({
    fnArray: [ops.constructPath, ops.constructPath, ops.constructPath],
    argsArray: [
      [20, [], [50, 300, 470, 420]],
      [20, [], [170, 300, 170, 420]],
      [20, [], [50, 360, 470, 360]],
    ],
  }, { page: 1, width: 612, height: 792 }, ops);

  const gridCells = geometry.tableCells.filter((cell) => cell.source === 'pdf-path-table-grid');

  assert.equal(gridCells.length, 4);
  assert.ok(gridCells.some((cell) =>
    cell.x === 170 &&
    cell.y === 360 &&
    cell.width === 300 &&
    cell.height === 60
  ));
});

test('table detection handles compact signing rows without leaking generic underline fields', () => {
  const ops = { constructPath: 91 };
  const line = (left, y, right) => [20, [], [left, y, right, y]];
  const vline = (x, bottom, top) => [20, [], [x, bottom, x, top]];
  const geometry = pathGeometryFromOperatorList({
    fnArray: Array(16).fill(ops.constructPath),
    argsArray: [
      line(49, 746, 377),
      line(49, 722, 377),
      line(49, 697, 377),
      line(49, 627, 377),
      line(49, 607, 377),
      line(49, 586, 377),
      line(49, 556, 377),
      line(49, 497, 377),
      line(49, 479, 377),
      line(49, 462, 377),
      line(49, 423, 377),
      line(49, 401, 377),
      vline(49, 401, 746),
      vline(128, 586, 746),
      vline(128, 462, 497),
      vline(377, 401, 746),
    ],
  }, { page: 1, width: 595, height: 842 }, ops);

  const hasCell = (x, y, width, height) =>
    geometry.tableCells.some((cell) =>
      cell.x === x &&
      cell.y === y &&
      cell.width === width &&
      cell.height === height
    );

  assert.equal(hasCell(128, 607, 249, 20), true);
  assert.equal(hasCell(49, 401, 328, 22), true);

  const item = (text, x, y, width) => ({
    text,
    textIndex: 0,
    textEnd: text.length,
    x,
    y,
    width,
    height: 10,
    charWidth: width / Math.max(1, text.length),
  });
  const lines = [
    { text: 'Signed at:-', y: 736, x: 55, right: 107, height: 10, items: [item('Signed at:-', 55, 736, 52)], runs: [] },
    { text: 'Date:-', y: 712, x: 55, right: 83, height: 10, items: [item('Date:-', 55, 712, 28)], runs: [] },
    { text: 'Name', y: 615, x: 55, right: 82, height: 10, items: [item('Name', 55, 615, 27)], runs: [] },
    { text: 'Designation', y: 594, x: 55, right: 112, height: 10, items: [item('Designation', 55, 594, 57)], runs: [] },
    {
      text: 'I warrant that I have been duly authorised to sign this',
      y: 576,
      x: 133,
      right: 367,
      height: 10,
      items: [item('I warrant that I have been duly authorised to sign this', 133, 576, 234)],
      runs: [],
    },
    { text: 'Agreement', y: 565, x: 133, right: 182, height: 10, items: [item('Agreement', 133, 565, 49)], runs: [] },
    { text: 'Signed at:-', y: 488, x: 55, right: 107, height: 10, items: [item('Signed at:-', 55, 488, 52)], runs: [] },
    { text: 'Date:-', y: 470, x: 55, right: 83, height: 10, items: [item('Date:-', 55, 470, 28)], runs: [] },
    {
      text: '[INSERT NAME OF CONSULTANT]',
      y: 411,
      x: 55,
      right: 219,
      height: 10,
      items: [item('[INSERT NAME OF CONSULTANT]', 55, 411, 164)],
      runs: [],
    },
  ];

  const fields = textLayoutFieldsFromLines(
    lines,
    1,
    { page: 1, width: 595, height: 842 },
    [{ email: 'signer@example.com' }],
    geometry.horizontalLines,
    geometry.tableCells
  );

  assert.deepEqual(fields.map((field) => field.context), [
    'Signed at:-',
    'Date:-',
    'Name',
    'Designation',
    'Signed at:-',
    'Date:-',
  ]);
  assert.equal(fields.some((field) => field.type === 'signature'), false);
  assert.equal(fields.some((field) => String(field.detector).startsWith('pdfjs-text-underline')), false);
  assert.ok(fields.every((field) =>
    field.x >= field.detection.tableCell.x &&
    field.x + field.width <= field.detection.tableCell.x + field.detection.tableCell.width &&
    field.y >= field.detection.tableCell.y &&
    field.y + field.height <= field.detection.tableCell.y + field.detection.tableCell.height
  ));
});
