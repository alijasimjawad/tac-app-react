import { describe, it, expect } from 'vitest';
import { detectColumns, buildImportPreview } from './itemImportHelpers';

// ── detectColumns() ───────────────────────────────────────────────────────────

describe('detectColumns()', () => {
  it('matches exact known headers', () => {
    const cols = detectColumns(['Item Code', 'Item Description', 'Serial Number']);
    expect(cols).toEqual({ codeKey: 'Item Code', nameKey: 'Item Description', serialKey: 'Serial Number' });
  });

  it('is case- and whitespace-insensitive', () => {
    const cols = detectColumns(['  item   code ', 'ITEM_DESCRIPTION', 'serial.no']);
    expect(cols.codeKey).toBe('  item   code ');
    expect(cols.nameKey).toBe('ITEM_DESCRIPTION');
    expect(cols.serialKey).toBe('serial.no');
  });

  it('falls back to generic aliases (code/name/sn)', () => {
    const cols = detectColumns(['Code', 'Name', 'SN']);
    expect(cols).toEqual({ codeKey: 'Code', nameKey: 'Name', serialKey: 'SN' });
  });

  it('returns nulls when no matching header exists', () => {
    const cols = detectColumns(['Plnt', 'Qty', 'HSN', 'COO']);
    expect(cols).toEqual({ codeKey: null, nameKey: null, serialKey: null });
  });

  it('does not match unrelated headers containing substrings', () => {
    const cols = detectColumns(['Item Code Note', 'Descriptionish']);
    expect(cols.codeKey).toBeNull();
    expect(cols.nameKey).toBeNull();
  });
});

// ── buildImportPreview() ──────────────────────────────────────────────────────

const cols = { codeKey: 'Item Code', nameKey: 'Item Description', serialKey: 'Serial Number' };

describe('buildImportPreview()', () => {
  it('dedupes multiple rows sharing the same item code', () => {
    const rows = [
      { 'Item Code': 'ABIA', 'Item Description': 'ABIA BB Unit', 'Serial Number': 'SN1' },
      { 'Item Code': 'ABIA', 'Item Description': 'ABIA BB Unit', 'Serial Number': 'SN2' },
      { 'Item Code': 'ABIA', 'Item Description': 'ABIA BB Unit', 'Serial Number': 'SN3' },
    ];
    const preview = buildImportPreview(rows, cols, new Set());
    expect(preview.uniqueCodes).toBe(1);
    expect(preview.newItems).toHaveLength(1);
    expect(preview.newItems[0]).toMatchObject({
      item_code: 'ABIA', item_name: 'ABIA BB Unit', part_number: 'ABIA',
      tracking_method: 'SERIALIZED', sourceRowCount: 3,
    });
  });

  it('normalizes code casing/whitespace as the dedupe key', () => {
    const rows = [
      { 'Item Code': ' abia ', 'Item Description': 'x', 'Serial Number': 'SN1' },
      { 'Item Code': 'ABIA', 'Item Description': 'x', 'Serial Number': 'SN2' },
    ];
    const preview = buildImportPreview(rows, cols, new Set());
    expect(preview.uniqueCodes).toBe(1);
    expect(preview.newItems[0].item_code).toBe('ABIA');
  });

  it('picks the longest non-empty description seen for a code', () => {
    const rows = [
      { 'Item Code': 'X1', 'Item Description': 'Short', 'Serial Number': 'S1' },
      { 'Item Code': 'X1', 'Item Description': 'A much longer description', 'Serial Number': 'S2' },
    ];
    const preview = buildImportPreview(rows, cols, new Set());
    expect(preview.newItems[0].item_name).toBe('A much longer description');
  });

  it('skips codes that already exist in the item master', () => {
    const rows = [
      { 'Item Code': 'ABIA', 'Item Description': 'x', 'Serial Number': 'S1' },
      { 'Item Code': 'NEWX', 'Item Description': 'y', 'Serial Number': 'S2' },
    ];
    const preview = buildImportPreview(rows, cols, new Set(['ABIA']));
    expect(preview.existingSkipped).toBe(1);
    expect(preview.newItems).toHaveLength(1);
    expect(preview.newItems[0].item_code).toBe('NEWX');
  });

  it('counts rows with no usable code as invalid and excludes them', () => {
    const rows = [
      { 'Item Code': '', 'Item Description': 'x', 'Serial Number': 'S1' },
      { 'Item Code': '   ', 'Item Description': 'y', 'Serial Number': 'S2' },
      { 'Item Code': 'OK1', 'Item Description': 'z', 'Serial Number': 'S3' },
    ];
    const preview = buildImportPreview(rows, cols, new Set());
    expect(preview.invalidRows).toBe(2);
    expect(preview.newItems).toHaveLength(1);
  });

  it('infers SERIALIZED tracking when a serial column is present', () => {
    const preview = buildImportPreview(
      [{ 'Item Code': 'A', 'Item Description': 'x', 'Serial Number': 'S1' }],
      cols, new Set(),
    );
    expect(preview.hasSerialColumn).toBe(true);
    expect(preview.newItems[0].tracking_method).toBe('SERIALIZED');
  });

  it('infers QUANTITY tracking when there is no serial column', () => {
    const noSerialCols = { codeKey: 'Item Code', nameKey: 'Item Description', serialKey: null };
    const preview = buildImportPreview(
      [{ 'Item Code': 'A', 'Item Description': 'x' }],
      noSerialCols, new Set(),
    );
    expect(preview.hasSerialColumn).toBe(false);
    expect(preview.newItems[0].tracking_method).toBe('QUANTITY');
  });

  it('falls back to the item code as the name when no description is found', () => {
    const preview = buildImportPreview(
      [{ 'Item Code': 'NONAME', 'Item Description': '', 'Serial Number': 'S1' }],
      cols, new Set(),
    );
    expect(preview.newItems[0].item_name).toBe('NONAME');
  });

  it('sorts new items alphabetically by code', () => {
    const rows = [
      { 'Item Code': 'ZZZ', 'Item Description': 'z', 'Serial Number': 'S1' },
      { 'Item Code': 'AAA', 'Item Description': 'a', 'Serial Number': 'S2' },
    ];
    const preview = buildImportPreview(rows, cols, new Set());
    expect(preview.newItems.map(i => i.item_code)).toEqual(['AAA', 'ZZZ']);
  });

  it('reports total row count and unique code count independently of dedup', () => {
    const rows = [
      { 'Item Code': 'A', 'Item Description': 'x', 'Serial Number': 'S1' },
      { 'Item Code': 'A', 'Item Description': 'x', 'Serial Number': 'S2' },
      { 'Item Code': 'B', 'Item Description': 'y', 'Serial Number': 'S3' },
    ];
    const preview = buildImportPreview(rows, cols, new Set());
    expect(preview.totalRows).toBe(3);
    expect(preview.uniqueCodes).toBe(2);
  });
});
