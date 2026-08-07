import { describe, it, expect } from 'vitest';
import { buildLineItemsFromEntries, type EditScanEntryForRpc } from './editReceiptHelpers';

const makeEntry = (
  inventoryItemId: string,
  serialNumber:    string,
  partNumber:      string | null = null,
): EditScanEntryForRpc => ({
  inventory_item_id: inventoryItemId,
  serial_number:     serialNumber,
  part_number:       partNumber,
  raw_scan_value:    serialNumber,
  barcode_symbology: null,
  scanned_manually:  false,
});

describe('buildLineItemsFromEntries()', () => {
  it('returns empty array for empty input', () => {
    expect(buildLineItemsFromEntries([])).toHaveLength(0);
  });

  it('single item no PN → quantity=1, partNumber=null', () => {
    const r = buildLineItemsFromEntries([makeEntry('item-1', 'SN-A', null)]);
    expect(r).toHaveLength(1);
    expect(r[0].inventoryItemId).toBe('item-1');
    expect(r[0].quantity).toBe(1);
    expect(r[0].partNumber).toBeNull();
  });

  it('single item single PN → partNumber stored', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', '474800A.102'),
      makeEntry('item-1', 'SN-B', '474800A.102'),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].quantity).toBe(2);
    expect(r[0].partNumber).toBe('474800A.102');
  });

  it('single item multiple distinct PNs → partNumber=null', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', '474800A.101'),
      makeEntry('item-1', 'SN-B', '474800A.102'),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].quantity).toBe(2);
    expect(r[0].partNumber).toBeNull();
  });

  it('three distinct PNs → null', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-A'),
      makeEntry('item-1', 'SN-B', 'PN-B'),
      makeEntry('item-1', 'SN-C', 'PN-C'),
    ]);
    expect(r[0].partNumber).toBeNull();
  });

  it('multiple items → independent line items', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-A'),
      makeEntry('item-2', 'SN-B', 'PN-B'),
    ]);
    expect(r).toHaveLength(2);
    expect(r.find(x => x.inventoryItemId === 'item-1')?.partNumber).toBe('PN-A');
    expect(r.find(x => x.inventoryItemId === 'item-2')?.partNumber).toBe('PN-B');
  });

  it('mixed: item-1 has PN, item-2 has no PN → independent decisions', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-A'),
      makeEntry('item-2', 'SN-B', null),
    ]);
    expect(r.find(x => x.inventoryItemId === 'item-1')?.partNumber).toBe('PN-A');
    expect(r.find(x => x.inventoryItemId === 'item-2')?.partNumber).toBeNull();
  });

  it('any null PN present — one null + one non-null → null (not safe to summarise)', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', null),
      makeEntry('item-1', 'SN-B', '474800A.102'),
    ]);
    expect(r[0].partNumber).toBeNull();
  });

  // ── Explicit policy matrix ────────────────────────────────────────────────
  it('policy: PN-A + PN-A → PN-A', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-A'),
      makeEntry('item-1', 'SN-B', 'PN-A'),
    ]);
    expect(r[0].partNumber).toBe('PN-A');
  });

  it('policy: PN-A + PN-B → NULL', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-A'),
      makeEntry('item-1', 'SN-B', 'PN-B'),
    ]);
    expect(r[0].partNumber).toBeNull();
  });

  it('policy: PN-A + NULL → NULL', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-A'),
      makeEntry('item-1', 'SN-B', null),
    ]);
    expect(r[0].partNumber).toBeNull();
  });

  it('policy: NULL + NULL → NULL', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', null),
      makeEntry('item-1', 'SN-B', null),
    ]);
    expect(r[0].partNumber).toBeNull();
  });

  it('all-null PNs → partNumber=null', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', null),
      makeEntry('item-1', 'SN-B', null),
    ]);
    expect(r[0].partNumber).toBeNull();
  });

  it('counts quantity correctly for five entries', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry('item-1', `SN-${i}`, 'PN-X'));
    const r = buildLineItemsFromEntries(entries);
    expect(r[0].quantity).toBe(5);
    expect(r[0].partNumber).toBe('PN-X');
  });

  it('single entry with PN → quantity=1, partNumber stored', () => {
    const r = buildLineItemsFromEntries([makeEntry('item-1', 'SN-A', 'PN-A')]);
    expect(r[0].partNumber).toBe('PN-A');
    expect(r[0].quantity).toBe(1);
  });

  it('multiple items multiple entries → correct totals per item', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-1', 'PN-A'),
      makeEntry('item-1', 'SN-2', 'PN-A'),
      makeEntry('item-1', 'SN-3', 'PN-A'),
      makeEntry('item-2', 'SN-4', 'PN-B'),
      makeEntry('item-2', 'SN-5', 'PN-B'),
    ]);
    const i1 = r.find(x => x.inventoryItemId === 'item-1')!;
    const i2 = r.find(x => x.inventoryItemId === 'item-2')!;
    expect(i1.quantity).toBe(3);
    expect(i2.quantity).toBe(2);
  });

  it('two items one with PN conflict → null for that item only', () => {
    const r = buildLineItemsFromEntries([
      makeEntry('item-1', 'SN-A', 'PN-X'),
      makeEntry('item-1', 'SN-B', 'PN-Y'),
      makeEntry('item-2', 'SN-C', 'PN-Z'),
    ]);
    expect(r.find(x => x.inventoryItemId === 'item-1')?.partNumber).toBeNull();
    expect(r.find(x => x.inventoryItemId === 'item-2')?.partNumber).toBe('PN-Z');
  });

  it('preserves inventory_item_id exactly as given', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const r = buildLineItemsFromEntries([makeEntry(id, 'SN-A', null)]);
    expect(r[0].inventoryItemId).toBe(id);
  });
});
