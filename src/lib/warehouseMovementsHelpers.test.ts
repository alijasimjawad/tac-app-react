import { describe, it, expect } from 'vitest';
import {
  deriveDirection,
  buildAssetMap,
  buildItemMap,
  buildWarehouseMap,
  matchesMovementSearch,
  enrichMovementRow,
  formatBaghdadDate,
  formatBaghdadTime,
} from './warehouseMovementsHelpers';

// ── deriveDirection ───────────────────────────────────────────────────────────

describe('deriveDirection', () => {
  it('positive quantity → IN', () => expect(deriveDirection(1)).toBe('IN'));
  it('large positive → IN', () => expect(deriveDirection(100)).toBe('IN'));
  it('negative quantity → OUT', () => expect(deriveDirection(-1)).toBe('OUT'));
  it('large negative → OUT', () => expect(deriveDirection(-50)).toBe('OUT'));
  it('zero → IN (non-negative edge case)', () => expect(deriveDirection(0)).toBe('IN'));
});

// ── buildAssetMap ─────────────────────────────────────────────────────────────

describe('buildAssetMap', () => {
  it('maps asset id to serial_number, part_number, status', () => {
    const map = buildAssetMap([
      { id: 'a1', serial_number: 'K9241823295', part_number: '474800A.102', status: 'IN_STOCK' },
    ]);
    expect(map.get('a1')).toEqual({
      serialNumber: 'K9241823295',
      partNumber:   '474800A.102',
      assetStatus:  'IN_STOCK',
    });
  });

  it('preserves null part_number exactly — does not coerce to string', () => {
    const map = buildAssetMap([
      { id: 'a2', serial_number: 'K0000001', part_number: null, status: 'IN_STOCK' },
    ]);
    expect(map.get('a2')?.partNumber).toBeNull();
  });

  it('empty input returns empty map', () => {
    expect(buildAssetMap([]).size).toBe(0);
  });

  it('multiple assets all independently resolved', () => {
    const map = buildAssetMap([
      { id: 'a1', serial_number: 'SN1', part_number: 'PN1', status: 'IN_STOCK' },
      { id: 'a2', serial_number: 'SN2', part_number: 'PN2', status: 'ISSUED'   },
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a2')?.assetStatus).toBe('ISSUED');
    expect(map.get('a2')?.serialNumber).toBe('SN2');
  });
});

// ── buildItemMap ──────────────────────────────────────────────────────────────

describe('buildItemMap', () => {
  it('maps item id to code, name, tracking_method', () => {
    const map = buildItemMap([
      { id: 'i1', item_code: 'ABIO', item_name: 'ABIO Radio Unit', tracking_method: 'SERIALIZED' },
    ]);
    expect(map.get('i1')).toEqual({
      itemCode:       'ABIO',
      itemName:       'ABIO Radio Unit',
      trackingMethod: 'SERIALIZED',
    });
  });

  it('includes all items regardless of is_active — helper has no filter', () => {
    const items = [
      { id: 'i1', item_code: 'ACTIVE',  item_name: 'Active Item',      tracking_method: 'QUANTITY'  },
      { id: 'i2', item_code: 'RETIRED', item_name: 'Deactivated Item', tracking_method: 'SERIALIZED' },
    ];
    const map = buildItemMap(items);
    expect(map.size).toBe(2);
    expect(map.get('i2')?.itemCode).toBe('RETIRED');
  });

  it('empty input returns empty map', () => {
    expect(buildItemMap([]).size).toBe(0);
  });
});

// ── buildWarehouseMap ─────────────────────────────────────────────────────────

describe('buildWarehouseMap', () => {
  it('maps warehouse id to name', () => {
    const map = buildWarehouseMap([{ id: 'w1', name: 'Hilla Warehouse' }]);
    expect(map.get('w1')).toBe('Hilla Warehouse');
  });

  it('includes deactivated warehouses — helper has no filter', () => {
    const map = buildWarehouseMap([
      { id: 'w1', name: 'Active WH' },
      { id: 'w2', name: 'Closed WH' },
    ]);
    expect(map.get('w2')).toBe('Closed WH');
  });
});

// ── matchesMovementSearch ─────────────────────────────────────────────────────

describe('matchesMovementSearch', () => {
  const row = {
    itemCode:      'ABIO',
    itemName:      'ABIO Radio Unit',
    serialNumber:  'K9241823295',
    partNumber:    '474800A.102',
    receiptNumber: 'GR-202608-00003',
  };

  it('empty query → always true', () =>
    expect(matchesMovementSearch(row, '')).toBe(true));

  it('matches item code — case insensitive', () => {
    expect(matchesMovementSearch(row, 'abio')).toBe(true);
    expect(matchesMovementSearch(row, 'ABIO')).toBe(true);
  });

  it('matches item name substring', () =>
    expect(matchesMovementSearch(row, 'Radio')).toBe(true));

  it('matches serial number', () =>
    expect(matchesMovementSearch(row, 'K9241823295')).toBe(true));

  it('matches partial serial number', () =>
    expect(matchesMovementSearch(row, '924182')).toBe(true));

  it('matches part number', () =>
    expect(matchesMovementSearch(row, '474800A')).toBe(true));

  it('matches GR receipt number', () =>
    expect(matchesMovementSearch(row, 'GR-202608')).toBe(true));

  it('no match → false', () =>
    expect(matchesMovementSearch(row, 'ZZZNOMATCH')).toBe(false));

  it('null serialNumber — does not crash and does not match SN query', () => {
    const r = { ...row, serialNumber: null };
    expect(matchesMovementSearch(r, 'K9241')).toBe(false);
    expect(matchesMovementSearch(r, '')).toBe(true);
  });

  it('null partNumber — does not crash and does not match PN query', () => {
    const r = { ...row, partNumber: null };
    expect(matchesMovementSearch(r, '474800')).toBe(false);
  });

  it('absent receiptNumber — does not crash and does not match GR query', () => {
    const r = { itemCode: 'X', itemName: 'Y', serialNumber: null, partNumber: null };
    expect(matchesMovementSearch(r, 'GR-')).toBe(false);
  });
});

// ── enrichMovementRow ─────────────────────────────────────────────────────────

describe('enrichMovementRow', () => {
  const itemMap  = buildItemMap([
    { id: 'item1', item_code: 'ABIO', item_name: 'ABIO Radio', tracking_method: 'SERIALIZED' },
    { id: 'qty1',  item_code: 'SIM',  item_name: 'SIM Card',   tracking_method: 'QUANTITY'   },
  ]);
  const wrhMap   = buildWarehouseMap([
    { id: 'wrh1', name: 'Hilla Warehouse' },
  ]);
  const assetMap = buildAssetMap([
    { id: 'ast1', serial_number: 'K9241823295', part_number: '474800A.102', status: 'IN_STOCK' },
    { id: 'ast2', serial_number: 'K0000001',    part_number: null,          status: 'IN_STOCK' },
  ]);
  const perfMap = new Map([['usr1', 'Ali Jasim']]);
  const grMap   = new Map([['gr1', 'GR-202608-00001']]);

  const serializedRow = {
    warehouse_id:      'wrh1',
    inventory_item_id: 'item1',
    asset_id:          'ast1',
    quantity:          1,
    performed_by:      'usr1',
    reference_type:    'GOODS_RECEIPT',
    reference_id:      'gr1',
  };

  it('fully enriches a SERIALIZED movement row', () => {
    const e = enrichMovementRow(serializedRow, itemMap, wrhMap, assetMap, perfMap, grMap);
    expect(e.warehouseName).toBe('Hilla Warehouse');
    expect(e.itemCode).toBe('ABIO');
    expect(e.itemName).toBe('ABIO Radio');
    expect(e.trackingMethod).toBe('SERIALIZED');
    expect(e.performerName).toBe('Ali Jasim');
    expect(e.receiptNumber).toBe('GR-202608-00001');
    expect(e.serialNumber).toBe('K9241823295');
    expect(e.partNumber).toBe('474800A.102');
    expect(e.assetStatus).toBe('IN_STOCK');
    expect(e.direction).toBe('IN');
  });

  it('QUANTITY movement: asset_id null → serialNumber/partNumber/assetStatus all null', () => {
    const row = {
      warehouse_id: 'wrh1', inventory_item_id: 'qty1', asset_id: null,
      quantity: 5, performed_by: 'usr1', reference_type: 'GOODS_RECEIPT', reference_id: 'gr1',
    };
    const e = enrichMovementRow(row, itemMap, wrhMap, assetMap, perfMap, grMap);
    expect(e.serialNumber).toBeNull();
    expect(e.partNumber).toBeNull();
    expect(e.assetStatus).toBeNull();
    expect(e.trackingMethod).toBe('QUANTITY');
    expect(e.direction).toBe('IN');
  });

  it('negative quantity → OUT direction', () => {
    const e = enrichMovementRow({ ...serializedRow, quantity: -1 }, itemMap, wrhMap, assetMap, perfMap, grMap);
    expect(e.direction).toBe('OUT');
  });

  it('asset with null part_number → partNumber null (Phase 13 policy: display "—", never substitute)', () => {
    const row = { ...serializedRow, asset_id: 'ast2' };
    const e = enrichMovementRow(row, itemMap, wrhMap, assetMap, perfMap, grMap);
    expect(e.serialNumber).toBe('K0000001');
    expect(e.partNumber).toBeNull();
  });

  it('unknown inventory_item_id → itemCode/itemName fall back to "—", trackingMethod null', () => {
    const e = enrichMovementRow(
      { ...serializedRow, inventory_item_id: 'MISSING' }, itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.itemCode).toBe('—');
    expect(e.itemName).toBe('—');
    expect(e.trackingMethod).toBeNull();
  });

  it('unknown warehouse_id → warehouseName falls back to "—"', () => {
    const e = enrichMovementRow(
      { ...serializedRow, warehouse_id: 'MISSING' }, itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.warehouseName).toBe('—');
  });

  it('performer not in perfMap → falls back to raw performed_by value', () => {
    const e = enrichMovementRow(
      { ...serializedRow, performed_by: 'unknown-uuid-000' }, itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.performerName).toBe('unknown-uuid-000');
  });

  it('empty performed_by → falls back to "—"', () => {
    const e = enrichMovementRow(
      { ...serializedRow, performed_by: '' }, itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.performerName).toBe('—');
  });

  it('non-GOODS_RECEIPT reference → receiptNumber undefined', () => {
    const e = enrichMovementRow(
      { ...serializedRow, reference_type: 'MANUAL', reference_id: 'some-id' },
      itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.receiptNumber).toBeUndefined();
  });

  it('null reference_id → receiptNumber undefined', () => {
    const e = enrichMovementRow(
      { ...serializedRow, reference_type: 'GOODS_RECEIPT', reference_id: null },
      itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.receiptNumber).toBeUndefined();
  });

  it('GR reference_id not in grMap → receiptNumber undefined (missing/legacy GR)', () => {
    const e = enrichMovementRow(
      { ...serializedRow, reference_type: 'GOODS_RECEIPT', reference_id: 'gr-missing' },
      itemMap, wrhMap, assetMap, perfMap, grMap,
    );
    expect(e.receiptNumber).toBeUndefined();
  });
});

// ── formatBaghdadDate ─────────────────────────────────────────────────────────
// Baghdad = UTC+3, no DST. All midnight-rollover tests use 21:00 UTC as the
// transition point (21:00 UTC = 00:00 Baghdad).

describe('formatBaghdadDate', () => {
  it('returns YYYY-MM-DD in Baghdad local time', () => {
    // 2026-08-08 19:00 UTC = 2026-08-08 22:00 Baghdad — same calendar day
    expect(formatBaghdadDate('2026-08-08T19:00:00Z')).toBe('2026-08-08');
  });

  it('UTC timestamp before Baghdad midnight (21:00 UTC) rolls to next day', () => {
    // 2026-08-07 21:30 UTC = 2026-08-08 00:30 Baghdad
    expect(formatBaghdadDate('2026-08-07T21:30:00Z')).toBe('2026-08-08');
  });

  it('UTC timestamp one minute before Baghdad midnight stays on same day', () => {
    // 2026-08-07 20:59 UTC = 2026-08-07 23:59 Baghdad
    expect(formatBaghdadDate('2026-08-07T20:59:00Z')).toBe('2026-08-07');
  });

  it('exact Baghdad midnight (21:00 UTC) is start of next day', () => {
    // 2026-08-07 21:00 UTC = 2026-08-08 00:00 Baghdad
    expect(formatBaghdadDate('2026-08-07T21:00:00Z')).toBe('2026-08-08');
  });

  it('22:21 UTC shown in UI example rolls date forward', () => {
    // The UTC timestamp the user saw as "22:21 UTC" lives on 2026-08-08 in Baghdad
    expect(formatBaghdadDate('2026-08-07T22:21:00Z')).toBe('2026-08-08');
  });
});

// ── formatBaghdadTime ─────────────────────────────────────────────────────────

describe('formatBaghdadTime', () => {
  it('returns HH:MM AM/PM in Baghdad local time', () => {
    // 2026-08-07 19:21 UTC = 2026-08-07 22:21 Baghdad = 10:21 PM
    expect(formatBaghdadTime('2026-08-07T19:21:00Z')).toBe('10:21 PM');
  });

  it('UTC midnight shows 03:00 AM in Baghdad', () => {
    // 2026-08-07 00:00 UTC = 2026-08-07 03:00 Baghdad
    expect(formatBaghdadTime('2026-08-07T00:00:00Z')).toBe('03:00 AM');
  });

  it('22:21 UTC shown in user example displays as 01:21 AM Baghdad (midnight rollover)', () => {
    // This was the exact UTC time the user saw displayed incorrectly as "22:21 UTC"
    expect(formatBaghdadTime('2026-08-07T22:21:00Z')).toBe('01:21 AM');
  });

  it('21:30 UTC (30 min past Baghdad midnight) shows 12:30 AM', () => {
    expect(formatBaghdadTime('2026-08-07T21:30:00Z')).toBe('12:30 AM');
  });

  it('Baghdad noon (09:00 UTC) shows 12:00 PM', () => {
    expect(formatBaghdadTime('2026-08-07T09:00:00Z')).toBe('12:00 PM');
  });
});
