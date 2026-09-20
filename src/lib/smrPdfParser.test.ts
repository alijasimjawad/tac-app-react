import { describe, it, expect } from 'vitest';
import {
  groupTextItemsIntoRows,
  extractHeaderFields,
  findLineItemTableHeaderRow,
  findLineItemTableRows,
  parseLineItemRow,
  computeColumnBoundaries,
  type PositionedTextItem,
} from './smrPdfParser';

// ── groupTextItemsIntoRows() ──────────────────────────────────────────────────

describe('groupTextItemsIntoRows()', () => {
  it('clusters items on the same baseline into one row, sorted left-to-right', () => {
    const items: PositionedTextItem[] = [
      { str: 'World', x: 40, y: 100, width: 20 },
      { str: 'Hello', x: 10, y: 100, width: 20 },
    ];
    const rows = groupTextItemsIntoRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Hello World');
  });

  it('splits items into separate rows when y differs beyond tolerance', () => {
    const items: PositionedTextItem[] = [
      { str: 'Row1', x: 10, y: 100, width: 20 },
      { str: 'Row2', x: 10, y: 80, width: 20 },
    ];
    const rows = groupTextItemsIntoRows(items);
    expect(rows).toHaveLength(2);
  });

  it('orders rows top-to-bottom (descending PDF y)', () => {
    const items: PositionedTextItem[] = [
      { str: 'Bottom', x: 10, y: 50, width: 20 },
      { str: 'Top', x: 10, y: 500, width: 20 },
    ];
    const rows = groupTextItemsIntoRows(items);
    expect(rows[0].text).toBe('Top');
    expect(rows[1].text).toBe('Bottom');
  });

  it('ignores whitespace-only items', () => {
    const items: PositionedTextItem[] = [
      { str: '   ', x: 10, y: 100, width: 5 },
      { str: 'Real', x: 20, y: 100, width: 20 },
    ];
    const rows = groupTextItemsIntoRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Real');
  });
});

// ── extractHeaderFields() ──────────────────────────────────────────────────────

describe('extractHeaderFields()', () => {
  const headerRows = groupTextItemsIntoRows([
    { str: 'S.R No: BN2074', x: 10, y: 500, width: 50 },
    { str: 'WH Name: Basra', x: 10, y: 480, width: 50 },
    { str: 'Form Type: OUT', x: 10, y: 460, width: 50 },
    { str: 'Date: 30-Apr-2026', x: 10, y: 440, width: 50 },
    { str: 'Site Code: MM item 8459', x: 10, y: 420, width: 50 },
    { str: 'Project: Nokia CAPEX 2025 - MM Scope', x: 10, y: 400, width: 50 },
    { str: 'SUB: MRC', x: 10, y: 380, width: 50 },
  ]);
  const header = extractHeaderFields(headerRows);

  it('extracts the S.R number', () => {
    expect(header.smrNumber).toBe('BN2074');
  });

  it('extracts the source warehouse name', () => {
    expect(header.sourceWarehouseName).toBe('Basra');
  });

  it('extracts the form type', () => {
    expect(header.formType).toBe('OUT');
  });

  it('extracts the raw SR date string', () => {
    expect(header.srDateRaw).toBe('30-Apr-2026');
  });

  it('extracts the sub reference', () => {
    expect(header.subReference).toBe('MRC');
  });

  it('leaves fields null when no row matches', () => {
    const empty = extractHeaderFields(groupTextItemsIntoRows([{ str: 'unrelated text', x: 0, y: 0, width: 10 }]));
    expect(empty.smrNumber).toBeNull();
    expect(empty.requesterPhone).toBeNull();
  });
});

// ── Real-world regression: multi-column header layout (BN2074) ──────────────

describe('extractHeaderFields() — multi-column form layout with positional fallback', () => {
  // Captured verbatim (x/y/width) from the real BN2074 PDF. Several label/
  // value pairs are crammed onto one visual row (a 2-column form), which
  // breaks the regex-over-joined-row-text approach two different ways:
  //  - "Requester :" is immediately followed by the name, but then by the
  //    NEXT field's label ("WH Location") rather than any of the terminators
  //    HEADER_PATTERNS' regex lookahead expects — so it never matches at all.
  //  - "Project Name" is a label with no value on its own row; the actual
  //    project text is drawn on the row below it, roughly x-aligned.
  const realRows = groupTextItemsIntoRows([
    { str: 'Requester :',            x: 113.51, y: 522.24, width: 37.92 },
    { str: 'Mohamed Hassan Alwan',   x: 170.63, y: 522.24, width: 82.09 },
    { str: 'WH Location',            x: 288.35, y: 522.24, width: 43.15 },
    { str: 'Basrah',                 x: 438.24, y: 522.24, width: 22.11 },
    { str: 'SUB',                    x: 569.64, y: 522.24, width: 16.03 },
    { str: 'MRC',                    x: 635.06, y: 522.24, width: 16.90 },
    { str: 'Employee Phone :',       x: 113.52, y: 500.04, width: 60.93 },
    { str: '7901901627',             x: 190.20, y: 500.04, width: 43.21 },
    { str: 'Configuration',          x: 288.36, y: 500.04, width: 46.50 },
    { str: 'Basrah',                 x: 438.25, y: 500.04, width: 22.11 },
    { str: 'Project Name',           x: 601.82, y: 500.04, width: 44.90 },
    { str: 'Requester',              x: 122.74, y: 487.80, width: 34.33 },
    { str: 'Nokia CAPEX 2025 - MM',  x: 578.66, y: 487.80, width: 88.78 },
  ]);
  const header = extractHeaderFields(realRows);

  it('extracts the requester name even though it is followed by the next column\'s label on the same row', () => {
    expect(header.requesterName).toBe('Mohamed Hassan Alwan');
  });

  it('extracts the project name from the x-aligned row below its label', () => {
    expect(header.projectNameRaw).toBe('Nokia CAPEX 2025 - MM');
  });

  it('still extracts requester phone via the normal regex path (unaffected by the positional fallback)', () => {
    expect(header.requesterPhone).toBe('7901901627');
  });
});

// ── Line-item table location + parsing ────────────────────────────────────────

describe('findLineItemTableHeaderRow() / findLineItemTableRows() / parseLineItemRow()', () => {
  const tableItems: PositionedTextItem[] = [
    // header row
    { str: 'Index', x: 10, y: 300, width: 20 },
    { str: 'product number', x: 60, y: 300, width: 40 },
    { str: 'Item Description', x: 110, y: 300, width: 60 },
    { str: 'Accepted Qty', x: 220, y: 300, width: 40 },
    { str: 'serial number', x: 260, y: 300, width: 40 },
    { str: 'Comments', x: 300, y: 300, width: 40 },
    // data row 1 — whole-number qty, unflagged
    { str: '1', x: 10, y: 280, width: 10 },
    { str: '474800A.102', x: 60, y: 280, width: 40 },
    { str: 'RRU', x: 110, y: 280, width: 20 },
    { str: '2', x: 220, y: 280, width: 10 },
    { str: '0', x: 260, y: 280, width: 10 },
    { str: 'PO#11375', x: 300, y: 280, width: 30 },
    // data row 2 — fractional qty (matches the real BN2074 sample), flagged
    { str: '2', x: 10, y: 260, width: 10 },
    { str: '998877', x: 60, y: 260, width: 40 },
    { str: 'Cable', x: 110, y: 260, width: 20 },
    { str: '0.5', x: 220, y: 260, width: 10 },
    { str: '1', x: 260, y: 260, width: 10 },
    { str: 'PO#11358', x: 300, y: 260, width: 30 },
    // approval/signature block — must be excluded from line items
    { str: 'Approval', x: 10, y: 240, width: 30 },
    { str: 'Storekeeper', x: 60, y: 240, width: 30 },
  ];
  const rows = groupTextItemsIntoRows(tableItems);
  const headerRow = findLineItemTableHeaderRow(rows);

  it('locates the table header row by its column labels', () => {
    expect(headerRow).not.toBeNull();
    expect(headerRow!.text).toContain('Index');
  });

  it('returns null when no row matches the table header keywords', () => {
    expect(findLineItemTableHeaderRow(groupTextItemsIntoRows([{ str: 'unrelated', x: 0, y: 0, width: 10 }]))).toBeNull();
  });

  it('collects data rows and stops before the approval/signature block', () => {
    const dataRows = findLineItemTableRows(rows, headerRow!);
    expect(dataRows).toHaveLength(2);
    expect(dataRows.some(r => /approval/i.test(r.text))).toBe(false);
  });

  it('parses a whole-number-quantity, unflagged row correctly', () => {
    const dataRows = findLineItemTableRows(rows, headerRow!);
    expect(parseLineItemRow(dataRows[0], headerRow!)).toEqual({
      lineIndex: 1, productNumberRaw: '474800A.102', descriptionRaw: 'RRU',
      expectedQty: 2, hasSerialFlag: false, poReference: 'PO#11375',
    });
  });

  it('parses a fractional-quantity, flagged row correctly', () => {
    const dataRows = findLineItemTableRows(rows, headerRow!);
    expect(parseLineItemRow(dataRows[1], headerRow!)).toEqual({
      lineIndex: 2, productNumberRaw: '998877', descriptionRaw: 'Cable',
      expectedQty: 0.5, hasSerialFlag: true, poReference: 'PO#11358',
    });
  });

  it('returns null for a row with no leading numeric index (e.g. a stray caption)', () => {
    const strayRow = groupTextItemsIntoRows([{ str: 'Not a line', x: 10, y: 200, width: 30 }])[0];
    expect(parseLineItemRow(strayRow, headerRow!)).toBeNull();
  });

  it('returns null for an empty row', () => {
    expect(parseLineItemRow({ y: 0, items: [], text: '' }, headerRow!)).toBeNull();
  });
});

// ── computeColumnBoundaries() / real-world split-header regression ───────────

describe('computeColumnBoundaries() — multi-glyph-run header labels', () => {
  // Real PDFs frequently emit a multi-word column label (e.g. "Item
  // Description") as several separate glyph runs rather than one string.
  // Naively treating every header glyph run as its own column boundary
  // shifts every subsequent column — this is the bug reported against a
  // real uploaded SMR (description text merging into the part-number cell,
  // and the Comments/PO column reading the wrong value).
  const splitHeaderItems: PositionedTextItem[] = [
    { str: 'Index',       x: 10,  y: 300, width: 20 },
    { str: 'product',     x: 60,  y: 300, width: 20 },
    { str: 'number',      x: 82,  y: 300, width: 20 },
    { str: 'Item',        x: 140, y: 300, width: 15 },
    { str: 'Description', x: 158, y: 300, width: 40 },
    { str: 'Accepted',    x: 260, y: 300, width: 25 },
    { str: 'Qty',         x: 288, y: 300, width: 15 },
    { str: 'serial',      x: 340, y: 300, width: 20 },
    { str: 'number',      x: 363, y: 300, width: 20 },
    { str: 'Comments',    x: 420, y: 300, width: 30 },
  ];
  const dataItems: PositionedTextItem[] = [
    { str: '1',           x: 10,  y: 280, width: 10 },
    { str: '474800A.102', x: 60,  y: 280, width: 40 },
    { str: 'RRU',         x: 140, y: 280, width: 20 },
    { str: '2',           x: 260, y: 280, width: 10 },
    { str: '0',           x: 340, y: 280, width: 10 },
    { str: 'PO#11375',    x: 420, y: 280, width: 30 },
  ];

  it('collapses same-label word gaps and cuts only at true column gaps, yielding exactly 6 boundaries', () => {
    const boundaries = computeColumnBoundaries(splitHeaderItems, 6);
    expect(boundaries).toEqual([10, 60, 140, 260, 340, 420]);
  });

  it('parses a data row correctly against a split-glyph-run header (no description-into-PN merge)', () => {
    const rows = groupTextItemsIntoRows([...splitHeaderItems, ...dataItems]);
    const headerRow = findLineItemTableHeaderRow(rows);
    expect(headerRow).not.toBeNull();
    const dataRows = findLineItemTableRows(rows, headerRow!);
    expect(parseLineItemRow(dataRows[0], headerRow!)).toEqual({
      lineIndex: 1, productNumberRaw: '474800A.102', descriptionRaw: 'RRU',
      expectedQty: 2, hasSerialFlag: false, poReference: 'PO#11375',
    });
  });

  it('leaves boundaries untouched when header item count is already at or below the expected column count', () => {
    const smallHeader: PositionedTextItem[] = [
      { str: 'Index', x: 10, y: 0, width: 20 },
      { str: 'PN',    x: 60, y: 0, width: 20 },
    ];
    expect(computeColumnBoundaries(smallHeader, 6)).toEqual([10, 60]);
  });
});

// ── Real-world regression: header/data column-alignment mismatch (BN2074) ────

describe('parseLineItemRow() — ordinal mapping for center-aligned body columns', () => {
  // Captured verbatim from the actual customer-uploaded BN2074 PDF via
  // pdfjs-dist. The header row already has exactly one glyph run per
  // logical column (no splitting), but the "Item Description" label sits at
  // x=339.84 — well to the right of where the real (center-aligned)
  // description text starts in the data rows (x=286.08, x=304.80). Binning
  // data items against x >= header-label-x thresholds put the description
  // text inside the "product number" bucket, merging PN + description into
  // one field. Ordinal mapping (used whenever a row has exactly 6 items, in
  // the correct left-to-right column order) sidesteps this mismatch.
  const realHeaderItems: PositionedTextItem[] = [
    { str: 'Index',           x: 116.04, y: 441.48, width: 18.95 },
    { str: 'product number',  x: 168.84, y: 441.48, width: 54.95 },
    { str: 'Item Description',x: 339.84, y: 441.48, width: 56.38 },
    { str: 'Accepted Qty',    x: 483.96, y: 441.48, width: 43.82 },
    { str: 'serial number',   x: 543.84, y: 441.48, width: 47.39 },
    { str: 'Comments',        x: 625.68, y: 441.48, width: 35.62 },
  ];
  const realDataItems: PositionedTextItem[] = [
    // row 1 — long description, starts well left of the header label's x
    { str: '1',                                       x: 123.24, y: 429.72, width: 4.08 },
    { str: '476108A.203',                              x: 174.12, y: 429.72, width: 43.77 },
    { str: 'AQHC AirScale MAA 32T32R 192AE n41 320W',  x: 286.08, y: 429.72, width: 163.21 },
    { str: '0',                                        x: 503.52, y: 429.72, width: 4.08 },
    { str: '0',                                        x: 565.92, y: 429.72, width: 4.08 },
    { str: 'PO#11375',                                 x: 626.18, y: 429.72, width: 34.06 },
    // row 2 — shorter description, starts even further left (center-aligned)
    { str: '2',                                       x: 123.24, y: 418.80, width: 4.08 },
    { str: '470316A.210',                             x: 174.11, y: 418.80, width: 43.77 },
    { str: 'EMHA EDGE MECHANICAL 3U UNIT',             x: 304.80, y: 418.80, width: 125.75 },
    { str: '1',                                        x: 503.52, y: 418.80, width: 4.08 },
    { str: '0',                                        x: 565.92, y: 418.80, width: 4.08 },
    { str: 'PO#11375',                                 x: 626.18, y: 418.80, width: 34.06 },
  ];

  const rows = groupTextItemsIntoRows([...realHeaderItems, ...realDataItems]);
  const headerRow = findLineItemTableHeaderRow(rows);

  it('locates the real header row', () => {
    expect(headerRow).not.toBeNull();
  });

  it('does not merge description into the part-number cell for row 1', () => {
    const dataRows = findLineItemTableRows(rows, headerRow!);
    expect(parseLineItemRow(dataRows[0], headerRow!)).toEqual({
      lineIndex: 1,
      productNumberRaw: '476108A.203',
      descriptionRaw: 'AQHC AirScale MAA 32T32R 192AE n41 320W',
      expectedQty: 0,
      hasSerialFlag: false,
      poReference: 'PO#11375',
    });
  });

  it('does not merge description into the part-number cell for row 2 (even shorter/more-offset description)', () => {
    const dataRows = findLineItemTableRows(rows, headerRow!);
    expect(parseLineItemRow(dataRows[1], headerRow!)).toEqual({
      lineIndex: 2,
      productNumberRaw: '470316A.210',
      descriptionRaw: 'EMHA EDGE MECHANICAL 3U UNIT',
      expectedQty: 1,
      hasSerialFlag: false,
      poReference: 'PO#11375',
    });
  });

  it('filters out an unused trailing template row printed as literal "0" in every cell (BN2074 row 31)', () => {
    // Real coordinates for the PDF's final table row: an unfilled template
    // row where the customer's form printed "0" placeholders instead of
    // leaving the cells blank. Comments cell has no glyph run at all (5
    // items, not 6), so this exercises the x-boundary fallback path too.
    const placeholderRow = groupTextItemsIntoRows([
      { str: '31', x: 121.44, y: 99.24, width: 8.15 },
      { str: '0',  x: 194.04, y: 99.24, width: 4.08 },
      { str: '0',  x: 365.52, y: 99.24, width: 4.44 },
      { str: '0',  x: 503.52, y: 99.24, width: 4.08 },
      { str: '0',  x: 565.92, y: 99.24, width: 4.08 },
    ])[0];
    expect(parseLineItemRow(placeholderRow, headerRow!)).toBeNull();
  });
});
