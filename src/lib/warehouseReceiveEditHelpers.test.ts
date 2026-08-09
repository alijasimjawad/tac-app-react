import { describe, it, expect } from 'vitest';
import {
  buildQuantityEntries,
  adjustQuantityLine,
  setQuantityLineQty,
  hasQuantityChanges,
  type QuantityLineItem,
} from './warehouseReceiveEditHelpers';

const make = (id: string, qty: number): QuantityLineItem => ({
  inventoryItemId: id,
  itemCode:        id.toUpperCase(),
  itemName:        `Item ${id}`,
  quantity:        qty,
});

// ── buildQuantityEntries ──────────────────────────────────────────────────────

describe('buildQuantityEntries', () => {
  it('empty input returns empty array', () => {
    expect(buildQuantityEntries([])).toEqual([]);
  });

  it('maps a single line to RPC shape', () => {
    expect(buildQuantityEntries([make('i1', 5)])).toEqual([
      { inventory_item_id: 'i1', quantity: 5 },
    ]);
  });

  it('maps multiple lines preserving order', () => {
    const result = buildQuantityEntries([make('i1', 3), make('i2', 7)]);
    expect(result).toHaveLength(2);
    expect(result[0].inventory_item_id).toBe('i1');
    expect(result[1].quantity).toBe(7);
  });

  it('filters out lines with quantity 0', () => {
    const result = buildQuantityEntries([make('i1', 0), make('i2', 2)]);
    expect(result).toHaveLength(1);
    expect(result[0].inventory_item_id).toBe('i2');
  });
});

// ── adjustQuantityLine ────────────────────────────────────────────────────────

describe('adjustQuantityLine', () => {
  it('increases quantity by positive delta', () => {
    const result = adjustQuantityLine([make('i1', 3)], 'i1', 2);
    expect(result[0].quantity).toBe(5);
  });

  it('decreases quantity by negative delta', () => {
    const result = adjustQuantityLine([make('i1', 5)], 'i1', -2);
    expect(result[0].quantity).toBe(3);
  });

  it('cannot decrease below 1', () => {
    const result = adjustQuantityLine([make('i1', 1)], 'i1', -10);
    expect(result[0].quantity).toBe(1);
  });

  it('unknown inventoryItemId leaves array unchanged', () => {
    const lines = [make('i1', 3)];
    const result = adjustQuantityLine(lines, 'UNKNOWN', 5);
    expect(result[0].quantity).toBe(3);
  });
});

// ── setQuantityLineQty ────────────────────────────────────────────────────────

describe('setQuantityLineQty', () => {
  it('sets quantity from a valid numeric string', () => {
    const result = setQuantityLineQty([make('i1', 1)], 'i1', '12');
    expect(result[0].quantity).toBe(12);
  });

  it('clamps to 1 when value is "0"', () => {
    const result = setQuantityLineQty([make('i1', 5)], 'i1', '0');
    expect(result[0].quantity).toBe(1);
  });

  it('clamps to 1 on non-numeric input', () => {
    const result = setQuantityLineQty([make('i1', 5)], 'i1', 'abc');
    expect(result[0].quantity).toBe(1);
  });
});

// ── hasQuantityChanges ────────────────────────────────────────────────────────

describe('hasQuantityChanges', () => {
  it('returns false when all quantities are the same', () => {
    const orig = [make('i1', 3), make('i2', 5)];
    const curr = [make('i1', 3), make('i2', 5)];
    expect(hasQuantityChanges(curr, orig)).toBe(false);
  });

  it('returns true when a quantity changed', () => {
    const orig = [make('i1', 3)];
    const curr = [make('i1', 4)];
    expect(hasQuantityChanges(curr, orig)).toBe(true);
  });

  it('returns true when an item was removed (length differs)', () => {
    const orig = [make('i1', 3), make('i2', 5)];
    const curr = [make('i1', 3)];
    expect(hasQuantityChanges(curr, orig)).toBe(true);
  });
});
