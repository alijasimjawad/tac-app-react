import { describe, it, expect } from 'vitest';
import {
  groupTextItemsIntoRows,
  extractHeaderFields,
  findLineItemTableHeaderRow,
  findLineItemTableRows,
  parseLineItemRow,
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
