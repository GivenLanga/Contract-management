const test = require('node:test');
const assert = require('node:assert/strict');

const { visionPercentToPdfField } = require('../src/services/visionFieldDetectionService');
const {
  buildMiddlePageInitialFields,
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
  const numberField = fields.find((field) => field.type === 'number');

  assert.equal(fields.some((field) => field.type === 'date'), false);
  assert.equal(textFields.length, 2);
  assert.deepEqual(textFields.map((field) => field.x), [300, 380]);
  assert.deepEqual(textFields.map((field) => field.width), [40, 120]);
  assert.equal(numberField.x, 520);
  assert.equal(numberField.width, 24);
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
    { x: 50, y: 300, width: 110, height: 90 },
    { x: 160, y: 300, width: 220, height: 90 },
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
  assert.deepEqual([...new Set(textFields.map((field) => field.height))], [14]);
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
