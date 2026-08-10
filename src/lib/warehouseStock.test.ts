import { describe, it, expect } from 'vitest';
import {
  computeAvailable,
  buildPnCountMap,
  buildGrRefMap,
  matchesStockFilter,
  matchesStockSearch,
  computeLineItemPn,
  buildPnSearchIndex,
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
  projectId:      'proj-1',
  projectName:    'Nokia Project',
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

// ── computeLineItemPn() ───────────────────────────────────────────────────────

describe('computeLineItemPn()', () => {
  it('falls back to fallbackPn when no scan logs present', () => {
    expect(computeLineItemPn([], '474800A.102')).toBe('474800A.102');
  });
  it('returns — when no scan logs and no fallback PN', () => {
    expect(computeLineItemPn([], null)).toBe('—');
  });
  it('returns — when no scan logs and empty fallback', () => {
    expect(computeLineItemPn([], '')).toBe('—');
  });
  it('shows the PN when all scan logs share the same PN', () => {
    expect(computeLineItemPn([
      { part_number: '474800A.102' },
      { part_number: '474800A.102' },
      { part_number: '474800A.102' },
    ], null)).toBe('474800A.102');
  });
  it('returns — when scan logs all have null PN', () => {
    expect(computeLineItemPn([
      { part_number: null },
      { part_number: null },
    ], '474800A.102')).toBe('—');
  });
  it('returns Multiple PNs (2) for two distinct PNs', () => {
    expect(computeLineItemPn([
      { part_number: '474800A.102' },
      { part_number: '474800A.103' },
    ], null)).toBe('Multiple PNs (2)');
  });
  it('returns Multiple PNs (3) for three distinct PNs', () => {
    expect(computeLineItemPn([
      { part_number: 'PN-A' },
      { part_number: 'PN-B' },
      { part_number: 'PN-C' },
    ], null)).toBe('Multiple PNs (3)');
  });
  it('ignores null entries when computing distinct PNs', () => {
    expect(computeLineItemPn([
      { part_number: '474800A.102' },
      { part_number: null },
      { part_number: '474800A.102' },
    ], null)).toBe('474800A.102');
  });
  it('returns Multiple PNs when mix of null and two distinct PNs', () => {
    expect(computeLineItemPn([
      { part_number: 'PN-A' },
      { part_number: null },
      { part_number: 'PN-B' },
    ], null)).toBe('Multiple PNs (2)');
  });
  it('ignores fallback when scan logs are present (even if all null)', () => {
    expect(computeLineItemPn([{ part_number: null }], 'FALLBACK')).toBe('—');
  });
});

// ── buildPnSearchIndex() ──────────────────────────────────────────────────────

describe('buildPnSearchIndex()', () => {
  it('returns empty map for empty input', () => {
    expect(buildPnSearchIndex([]).size).toBe(0);
  });
  it('indexes a single PN for a single item', () => {
    const idx = buildPnSearchIndex([{ inventory_item_id: 'item-a', external_code: '474800A.102' }]);
    expect(idx.get('item-a')).toEqual(['474800a.102']);
  });
  it('stores PNs lowercased for case-insensitive search', () => {
    const idx = buildPnSearchIndex([{ inventory_item_id: 'item-a', external_code: 'PN-UPPER' }]);
    expect(idx.get('item-a')).toEqual(['pn-upper']);
  });
  it('accumulates multiple PNs for the same item', () => {
    const idx = buildPnSearchIndex([
      { inventory_item_id: 'item-a', external_code: 'PN-A' },
      { inventory_item_id: 'item-a', external_code: 'PN-B' },
    ]);
    const pns = idx.get('item-a')!;
    expect(pns).toHaveLength(2);
    expect(pns).toContain('pn-a');
    expect(pns).toContain('pn-b');
  });
  it('keeps different items independent', () => {
    const idx = buildPnSearchIndex([
      { inventory_item_id: 'item-a', external_code: 'PN-A' },
      { inventory_item_id: 'item-b', external_code: 'PN-B' },
    ]);
    expect(idx.get('item-a')).toEqual(['pn-a']);
    expect(idx.get('item-b')).toEqual(['pn-b']);
  });
  it('does not put item-b PNs into item-a index', () => {
    const idx = buildPnSearchIndex([
      { inventory_item_id: 'item-b', external_code: 'PN-B' },
    ]);
    expect(idx.get('item-a')).toBeUndefined();
  });
  it('learned PN search finds the right item', () => {
    const idx = buildPnSearchIndex([
      { inventory_item_id: 'item-arga', external_code: '474800A.102' },
      { inventory_item_id: 'item-fxda', external_code: '471234B.001' },
    ]);
    const query = '474800a.102';
    // Simulate the filter: find items where any indexed PN includes the query
    const match = (itemId: string) => (idx.get(itemId) ?? []).some(pn => pn.includes(query));
    expect(match('item-arga')).toBe(true);
    expect(match('item-fxda')).toBe(false);
  });
  it('seed PN field (inventory_items.part_number) is independent of buildPnSearchIndex', () => {
    // buildPnSearchIndex only uses item_code_mappings entries — it has no knowledge
    // of inventory_items.part_number. These two sources must never be merged silently.
    const idx = buildPnSearchIndex([]);
    // An item with a seed PN but no learned mappings returns undefined here
    expect(idx.get('item-with-seed-pn-only')).toBeUndefined();
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
