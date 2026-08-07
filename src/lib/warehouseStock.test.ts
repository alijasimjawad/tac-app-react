import { describe, it, expect } from 'vitest';
import {
  computeAvailable,
  buildPnCountMap,
  buildGrRefMap,
  matchesStockFilter,
  matchesStockSearch,
  type StockRow,
} from './warehouseStock';

const baseRow: StockRow = {
  balanceId:      'bal-1',
  itemId:         'item-1',
  itemCode:       'ARGA',
  itemName:       'ARGA Radio Module',
  trackingMethod: 'SERIALIZED',
  warehouseId:    'wrh-1',
  warehouseName:  'Hilla Warehouse',
  onHand:         4,
  reserved:       1,
  available:      3,
  updatedAt:      '2026-08-07T00:00:00Z',
};

// ── computeAvailable() ────────────────────────────────────────────────────────

describe('computeAvailable()', () => {
  it('returns onHand - reserved when result is positive', () => {
    expect(computeAvailable(10, 3)).toBe(7);
  });
  it('returns 0 when reserved equals onHand', () => {
    expect(computeAvailable(5, 5)).toBe(0);
  });
  it('returns 0 (not negative) when reserved exceeds onHand', () => {
    expect(computeAvailable(3, 5)).toBe(0);
  });
  it('returns onHand when reserved is 0', () => {
    expect(computeAvailable(4, 0)).toBe(4);
  });
  it('returns 0 for both zero', () => {
    expect(computeAvailable(0, 0)).toBe(0);
  });
});

// ── buildPnCountMap() ─────────────────────────────────────────────────────────

describe('buildPnCountMap()', () => {
  it('counts one PN for a single entry', () => {
    const map = buildPnCountMap([{ inventory_item_id: 'item-a' }]);
    expect(map.get('item-a')).toBe(1);
  });
  it('counts multiple PNs for the same item', () => {
    const map = buildPnCountMap([
      { inventory_item_id: 'item-a' },
      { inventory_item_id: 'item-a' },
      { inventory_item_id: 'item-a' },
    ]);
    expect(map.get('item-a')).toBe(3);
  });
  it('counts different items independently', () => {
    const map = buildPnCountMap([
      { inventory_item_id: 'item-a' },
      { inventory_item_id: 'item-b' },
      { inventory_item_id: 'item-b' },
    ]);
    expect(map.get('item-a')).toBe(1);
    expect(map.get('item-b')).toBe(2);
  });
  it('returns empty map for empty input', () => {
    expect(buildPnCountMap([]).size).toBe(0);
  });
  it('does not count entries from other item IDs', () => {
    const map = buildPnCountMap([{ inventory_item_id: 'item-b' }]);
    expect(map.get('item-a')).toBeUndefined();
  });
});

// ── buildGrRefMap() ───────────────────────────────────────────────────────────

describe('buildGrRefMap()', () => {
  it('maps UUID to receipt number', () => {
    const map = buildGrRefMap([
      { id: 'uuid-1', receipt_number: 'GR-202608-00001' },
      { id: 'uuid-2', receipt_number: 'GR-202608-00002' },
    ]);
    expect(map.get('uuid-1')).toBe('GR-202608-00001');
    expect(map.get('uuid-2')).toBe('GR-202608-00002');
  });
  it('returns empty map for empty input', () => {
    expect(buildGrRefMap([]).size).toBe(0);
  });
  it('last entry wins for duplicate IDs', () => {
    const map = buildGrRefMap([
      { id: 'uuid-1', receipt_number: 'GR-A' },
      { id: 'uuid-1', receipt_number: 'GR-B' },
    ]);
    expect(map.get('uuid-1')).toBe('GR-B');
  });
});

// ── matchesStockFilter() ──────────────────────────────────────────────────────

describe('matchesStockFilter()', () => {
  it('all: includes rows with stock', () => {
    expect(matchesStockFilter(baseRow, 'all')).toBe(true);
  });
  it('all: includes rows with zero stock', () => {
    expect(matchesStockFilter({ ...baseRow, onHand: 0, reserved: 0, available: 0 }, 'all')).toBe(true);
  });
  it('in_stock: rows with onHand > 0 pass', () => {
    expect(matchesStockFilter(baseRow, 'in_stock')).toBe(true);
  });
  it('in_stock: rows with onHand = 0 fail', () => {
    expect(matchesStockFilter({ ...baseRow, onHand: 0 }, 'in_stock')).toBe(false);
  });
  it('zero_stock: rows with onHand = 0 pass', () => {
    expect(matchesStockFilter({ ...baseRow, onHand: 0 }, 'zero_stock')).toBe(true);
  });
  it('zero_stock: rows with onHand > 0 fail', () => {
    expect(matchesStockFilter(baseRow, 'zero_stock')).toBe(false);
  });
  it('reserved: rows with reserved > 0 pass', () => {
    expect(matchesStockFilter(baseRow, 'reserved')).toBe(true);
  });
  it('reserved: rows with reserved = 0 fail', () => {
    expect(matchesStockFilter({ ...baseRow, reserved: 0 }, 'reserved')).toBe(false);
  });
  it('quantity items pass in_stock filter when onHand > 0', () => {
    expect(matchesStockFilter({ ...baseRow, trackingMethod: 'QUANTITY', onHand: 10 }, 'in_stock')).toBe(true);
  });
  it('quantity items fail in_stock filter when onHand = 0', () => {
    expect(matchesStockFilter({ ...baseRow, trackingMethod: 'QUANTITY', onHand: 0 }, 'in_stock')).toBe(false);
  });
});

// ── matchesStockSearch() ──────────────────────────────────────────────────────

describe('matchesStockSearch()', () => {
  it('matches item code case-insensitively', () => {
    expect(matchesStockSearch(baseRow, 'arga')).toBe(true);
    expect(matchesStockSearch(baseRow, 'ARGA')).toBe(true);
    expect(matchesStockSearch(baseRow, 'Arga')).toBe(true);
  });
  it('matches partial item code', () => {
    expect(matchesStockSearch(baseRow, 'RG')).toBe(true);
  });
  it('matches item name case-insensitively', () => {
    expect(matchesStockSearch(baseRow, 'radio')).toBe(true);
    expect(matchesStockSearch(baseRow, 'RADIO')).toBe(true);
  });
  it('returns true for empty search', () => {
    expect(matchesStockSearch(baseRow, '')).toBe(true);
  });
  it('returns false for non-matching search', () => {
    expect(matchesStockSearch(baseRow, 'FXDA')).toBe(false);
  });
  it('does not search warehouse name', () => {
    expect(matchesStockSearch(baseRow, 'Hilla')).toBe(false);
  });
});
