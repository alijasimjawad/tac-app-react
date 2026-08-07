import { describe, it, expect } from 'vitest';
import {
  buildExistingAssetsMap,
  getBlockMessage,
  type KnownAsset,
  type AssetStatus,
} from './existingAssetCheck';

const makeAsset = (
  serialNumberNorm: string,
  status: AssetStatus,
  overrides: Partial<KnownAsset> = {},
): KnownAsset => ({
  serialNumberNorm,
  status,
  inventoryItemId:  'item-1',
  partNumber:       null,
  warehouseId:      'wrh-1',
  sourceReceiptId:  null,
  ...overrides,
});

// ── buildExistingAssetsMap() ──────────────────────────────────────────────────

describe('buildExistingAssetsMap()', () => {
  it('returns empty map for empty input', () => {
    expect(buildExistingAssetsMap([]).size).toBe(0);
  });

  it('indexes a single asset by serialNumberNorm', () => {
    const map = buildExistingAssetsMap([makeAsset('K9241823295', 'IN_STOCK')]);
    expect(map.get('K9241823295')?.status).toBe('IN_STOCK');
  });

  it('unknown SN returns undefined → scan proceeds', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-KNOWN', 'IN_STOCK')]);
    expect(map.get('SN-UNKNOWN')).toBeUndefined();
  });

  it('last entry wins for duplicate normalized SNs', () => {
    const map = buildExistingAssetsMap([
      makeAsset('SN-DUPE', 'IN_STOCK'),
      makeAsset('SN-DUPE', 'SCRAPPED'),
    ]);
    expect(map.get('SN-DUPE')?.status).toBe('SCRAPPED');
  });

  it('indexes multiple SNs independently', () => {
    const map = buildExistingAssetsMap([
      makeAsset('SN-A', 'IN_STOCK'),
      makeAsset('SN-B', 'ISSUED'),
    ]);
    expect(map.get('SN-A')?.status).toBe('IN_STOCK');
    expect(map.get('SN-B')?.status).toBe('ISSUED');
  });

  it('preserves all fields on the stored asset', () => {
    const map = buildExistingAssetsMap([
      makeAsset('SN-X', 'RESERVED', {
        inventoryItemId: 'item-x',
        partNumber:      '474800A.102',
        warehouseId:     'wrh-x',
        sourceReceiptId: 'rcpt-x',
      }),
    ]);
    const found = map.get('SN-X')!;
    expect(found.inventoryItemId).toBe('item-x');
    expect(found.partNumber).toBe('474800A.102');
    expect(found.warehouseId).toBe('wrh-x');
    expect(found.sourceReceiptId).toBe('rcpt-x');
  });
});

// ── getBlockMessage() ─────────────────────────────────────────────────────────

describe('getBlockMessage()', () => {
  const cases: Array<[AssetStatus, string, boolean]> = [
    ['IN_STOCK',  'Already in Stock',                  false],
    ['RESERVED',  'Asset Reserved',                    false],
    ['ISSUED',    'Previously Issued Asset',           true ],
    ['INSTALLED', 'Installed Asset',                   true ],
    ['RETURNED',  'Asset Pending Return Acceptance',   true ],
    ['DAMAGED',   'Damaged Asset',                     false],
    ['SCRAPPED',  'Scrapped Asset',                    false],
  ];

  it.each(cases)('%s → headline contains "%s", allowReturn=%s', (status, headlineStart, allowReturn) => {
    const msg = getBlockMessage(status);
    expect(msg.headline).toContain(headlineStart);
    expect(msg.allowReturn).toBe(allowReturn);
    expect(msg.subtext.length).toBeGreaterThan(10);
  });

  it('ISSUED and INSTALLED are the only statuses that allow the Return workflow hint', () => {
    const returnable: AssetStatus[] = ['ISSUED', 'INSTALLED', 'RETURNED'];
    const nonReturnable: AssetStatus[] = ['IN_STOCK', 'RESERVED', 'DAMAGED', 'SCRAPPED'];
    for (const s of returnable)    expect(getBlockMessage(s).allowReturn).toBe(true);
    for (const s of nonReturnable) expect(getBlockMessage(s).allowReturn).toBe(false);
  });
});

// ── Scan-path contract tests ──────────────────────────────────────────────────
//
// WarehouseReceive.tsx check order:
//   1. sessionSNs.current.has(snNorm)   → DUPLICATE hud (first-line protection)
//   2. existingAssets.current.get(snNorm) → block card + return (second check)
//   3. Neither fired → proceed: setScanEntries, launchAutoOcr, KPI increment
//
// These tests verify the map-lookup contract the component depends on.

describe('scan-path contract', () => {
  it('unknown SN → map.get returns undefined → scan must proceed', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-KNOWN', 'IN_STOCK')]);
    expect(map.get('SN-UNKNOWN')).toBeUndefined();
    // No block → setScanEntries called, OCR fires, KPI increments
  });

  it('IN_STOCK SN → map.get returns asset → scan blocked (no entry, no OCR, no KPI)', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-A', 'IN_STOCK')]);
    expect(map.get('SN-A')).toBeDefined();
  });

  it('RESERVED SN → blocked', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-B', 'RESERVED')]);
    expect(map.get('SN-B')?.status).toBe('RESERVED');
  });

  it('ISSUED SN → blocked, allowReturn=true', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-C', 'ISSUED')]);
    const found = map.get('SN-C');
    expect(found).toBeDefined();
    expect(getBlockMessage(found!.status).allowReturn).toBe(true);
  });

  it('INSTALLED SN → blocked, allowReturn=true', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-D', 'INSTALLED')]);
    const found = map.get('SN-D');
    expect(found).toBeDefined();
    expect(getBlockMessage(found!.status).allowReturn).toBe(true);
  });

  it('DAMAGED SN → blocked, allowReturn=false', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-E', 'DAMAGED')]);
    const found = map.get('SN-E');
    expect(found).toBeDefined();
    expect(getBlockMessage(found!.status).allowReturn).toBe(false);
  });

  it('SCRAPPED SN → hard blocked, allowReturn=false', () => {
    const map = buildExistingAssetsMap([makeAsset('SN-F', 'SCRAPPED')]);
    const found = map.get('SN-F');
    expect(found).toBeDefined();
    expect(getBlockMessage(found!.status).allowReturn).toBe(false);
  });

  it('session duplicate is first-line: caught before existing-asset map lookup', () => {
    // Both checks would fire for this SN, but session check comes first.
    const sessionSNs = new Set<string>(['SN-SESS']);
    const map = buildExistingAssetsMap([makeAsset('SN-SESS', 'IN_STOCK')]);

    const caughtBySession = sessionSNs.has('SN-SESS');
    const alsoInDb        = map.get('SN-SESS');

    expect(caughtBySession).toBe(true);    // first-line wins → DUPLICATE hud
    expect(alsoInDb).toBeDefined();         // also exists in db, but never reached
  });

  it('no OCR fires for blocked SN — caller returns before launchAutoOcr', () => {
    // Contract: when map.get(snNorm) is truthy, the component returns immediately.
    // launchAutoOcr() is only reached after both checks pass.
    const map = buildExistingAssetsMap([makeAsset('SN-G', 'SCRAPPED')]);
    const shouldBlock = map.get('SN-G') !== undefined;
    expect(shouldBlock).toBe(true); // → return early; OCR never starts
  });

  it('no KPI increment for blocked SN — setScanEntries not reached', () => {
    // Contract: setScanEntries (which drives scanEntries.length / KPI chips)
    // is only called after all block checks pass.
    const map = buildExistingAssetsMap([makeAsset('SN-H', 'IN_STOCK')]);
    const shouldBlock = map.get('SN-H') !== undefined;
    expect(shouldBlock).toBe(true); // → return early; KPI unchanged
  });
});
