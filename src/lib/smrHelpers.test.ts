import { describe, it, expect } from 'vitest';
import {
  computeSmrLineStatus,
  summarizeSmrLineStatuses,
  isSmrReconciliationComplete,
  matchPnToItem,
  countUniqueScans,
  isDuplicateScanForLine,
  hasFractionalQuantity,
  toIntegerReceiptQuantity,
  buildReceiptItemsFromSmrLines,
  type MatchedItemRef,
  type SmrLineStatus,
} from './smrHelpers';

// ── computeSmrLineStatus() ────────────────────────────────────────────────────

describe('computeSmrLineStatus()', () => {
  it('returns PENDING when nothing received and not marked not-received', () => {
    expect(computeSmrLineStatus(5, 0, false)).toBe('PENDING');
  });

  it('returns NOT_RECEIVED when nothing received and explicitly marked', () => {
    expect(computeSmrLineStatus(5, 0, true)).toBe('NOT_RECEIVED');
  });

  it('returns PARTIAL when received is less than expected', () => {
    expect(computeSmrLineStatus(5, 2, false)).toBe('PARTIAL');
  });

  it('returns RECEIVED when received equals expected', () => {
    expect(computeSmrLineStatus(5, 5, false)).toBe('RECEIVED');
  });

  it('returns RECEIVED when received exceeds expected', () => {
    expect(computeSmrLineStatus(5, 7, false)).toBe('RECEIVED');
  });

  it('handles fractional expected quantities (e.g. 0.5 accepted qty)', () => {
    expect(computeSmrLineStatus(0.5, 0.5, false)).toBe('RECEIVED');
    expect(computeSmrLineStatus(0.5, 0.3, false)).toBe('PARTIAL');
  });
});

// ── summarizeSmrLineStatuses() / isSmrReconciliationComplete() ───────────────

describe('summarizeSmrLineStatuses()', () => {
  const lines: Array<{ status: SmrLineStatus }> = [
    { status: 'RECEIVED' }, { status: 'RECEIVED' },
    { status: 'PARTIAL' },
    { status: 'NOT_RECEIVED' },
    { status: 'PENDING' },
  ];

  it('counts each status bucket correctly', () => {
    const summary = summarizeSmrLineStatuses(lines);
    expect(summary).toEqual({ total: 5, received: 2, partial: 1, notReceived: 1, pending: 1 });
  });

  it('returns all zeros for an empty list', () => {
    expect(summarizeSmrLineStatuses([])).toEqual({ total: 0, received: 0, partial: 0, notReceived: 0, pending: 0 });
  });
});

describe('isSmrReconciliationComplete()', () => {
  it('returns false for an empty document', () => {
    expect(isSmrReconciliationComplete([])).toBe(false);
  });

  it('returns false while any line is still PENDING', () => {
    expect(isSmrReconciliationComplete([{ status: 'RECEIVED' }, { status: 'PENDING' }])).toBe(false);
  });

  it('returns true once every line is resolved (RECEIVED/PARTIAL/NOT_RECEIVED)', () => {
    expect(isSmrReconciliationComplete([
      { status: 'RECEIVED' }, { status: 'PARTIAL' }, { status: 'NOT_RECEIVED' },
    ])).toBe(true);
  });
});

// ── matchPnToItem() ───────────────────────────────────────────────────────────

describe('matchPnToItem()', () => {
  const itemA: MatchedItemRef = { itemId: 'item-a', itemCode: 'ABIO', itemName: 'ABIO Radio Unit' };
  const itemB: MatchedItemRef = { itemId: 'item-b', itemCode: 'FXDA', itemName: 'FXDA Radio Unit' };
  const exactByPn   = new Map([['474800A.102', itemA]]);
  const learnedByPn = new Map([['998877', itemB]]);

  it('returns UNMATCHED for null/blank PN', () => {
    expect(matchPnToItem(null, exactByPn, learnedByPn).confidence).toBe('UNMATCHED');
    expect(matchPnToItem('   ', exactByPn, learnedByPn).confidence).toBe('UNMATCHED');
  });

  it('matches EXACT against inventory_items.part_number, case/whitespace-insensitive', () => {
    const result = matchPnToItem(' 474800a.102 ', exactByPn, learnedByPn);
    expect(result).toEqual({ itemId: 'item-a', itemCode: 'ABIO', itemName: 'ABIO Radio Unit', confidence: 'EXACT' });
  });

  it('falls back to LEARNED mapping when no exact match exists', () => {
    const result = matchPnToItem('998877', exactByPn, learnedByPn);
    expect(result).toEqual({ itemId: 'item-b', itemCode: 'FXDA', itemName: 'FXDA Radio Unit', confidence: 'LEARNED' });
  });

  it('prefers EXACT over LEARNED when both maps contain the key', () => {
    const learned = new Map([['474800A.102', itemB]]);
    const result = matchPnToItem('474800A.102', exactByPn, learned);
    expect(result.confidence).toBe('EXACT');
    expect(result.itemId).toBe('item-a');
  });

  it('returns UNMATCHED when the PN is in neither map', () => {
    expect(matchPnToItem('UNKNOWN-PN', exactByPn, learnedByPn).confidence).toBe('UNMATCHED');
  });
});

// ── countUniqueScans() / isDuplicateScanForLine() ─────────────────────────────

describe('countUniqueScans()', () => {
  it('returns 0 for no scans', () => {
    expect(countUniqueScans([])).toBe(0);
  });

  it('counts distinct normalized serials', () => {
    const scans = [
      { serialNumberNormalized: 'SN001' },
      { serialNumberNormalized: 'SN002' },
      { serialNumberNormalized: 'SN001' }, // duplicate re-scan
    ];
    expect(countUniqueScans(scans)).toBe(2);
  });
});

describe('isDuplicateScanForLine()', () => {
  const existing = [{ serialNumberNormalized: 'SN001' }, { serialNumberNormalized: 'SN002' }];

  it('returns true for an already-scanned serial', () => {
    expect(isDuplicateScanForLine(existing, 'SN001')).toBe(true);
  });

  it('returns false for a new serial', () => {
    expect(isDuplicateScanForLine(existing, 'SN003')).toBe(false);
  });

  it('returns false against an empty existing list', () => {
    expect(isDuplicateScanForLine([], 'SN001')).toBe(false);
  });
});

// ── hasFractionalQuantity() / toIntegerReceiptQuantity() ──────────────────────

describe('hasFractionalQuantity()', () => {
  it('returns false for whole numbers', () => {
    expect(hasFractionalQuantity(5)).toBe(false);
    expect(hasFractionalQuantity(0)).toBe(false);
  });

  it('returns true for fractional values like the SMR sample (0.5, 0.3)', () => {
    expect(hasFractionalQuantity(0.5)).toBe(true);
    expect(hasFractionalQuantity(0.3)).toBe(true);
  });
});

describe('toIntegerReceiptQuantity()', () => {
  it('rounds to the nearest integer', () => {
    expect(toIntegerReceiptQuantity(0.5)).toBe(1); // banker's-rounding-free: JS rounds .5 up
    expect(toIntegerReceiptQuantity(0.3)).toBe(0);
    expect(toIntegerReceiptQuantity(2.6)).toBe(3);
  });

  it('never returns negative quantities', () => {
    expect(toIntegerReceiptQuantity(-1)).toBe(0);
  });

  it('leaves whole numbers unchanged', () => {
    expect(toIntegerReceiptQuantity(7)).toBe(7);
  });
});

// ── buildReceiptItemsFromSmrLines() ───────────────────────────────────────────

describe('buildReceiptItemsFromSmrLines()', () => {
  it('returns an empty array for no lines', () => {
    expect(buildReceiptItemsFromSmrLines([])).toEqual([]);
  });

  it('skips unmatched lines', () => {
    const result = buildReceiptItemsFromSmrLines([
      { matchedItemId: null, receivedQty: 5, partNumberRaw: 'PN-1' },
    ]);
    expect(result).toEqual([]);
  });

  it('skips lines with zero or rounds-to-zero received quantity', () => {
    const result = buildReceiptItemsFromSmrLines([
      { matchedItemId: 'item-a', receivedQty: 0, partNumberRaw: 'PN-1' },
      { matchedItemId: 'item-b', receivedQty: 0.3, partNumberRaw: 'PN-2' }, // rounds to 0
    ]);
    expect(result).toEqual([]);
  });

  it('builds a single entry for one matched line', () => {
    const result = buildReceiptItemsFromSmrLines([
      { matchedItemId: 'item-a', receivedQty: 3, partNumberRaw: 'PN-1' },
    ]);
    expect(result).toEqual([{ inventory_item_id: 'item-a', quantity: 3, part_number: 'PN-1' }]);
  });

  it('aggregates multiple SMR lines that resolve to the same item', () => {
    const result = buildReceiptItemsFromSmrLines([
      { matchedItemId: 'item-a', receivedQty: 2, partNumberRaw: 'PN-1' },
      { matchedItemId: 'item-a', receivedQty: 3, partNumberRaw: 'PN-1-ALT' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(5);
  });

  it('rounds fractional received quantities before aggregating', () => {
    const result = buildReceiptItemsFromSmrLines([
      { matchedItemId: 'item-a', receivedQty: 0.6, partNumberRaw: 'PN-1' },
      { matchedItemId: 'item-a', receivedQty: 0.6, partNumberRaw: 'PN-1' },
    ]);
    // 0.6 rounds to 1 each → aggregated total 2
    expect(result[0].quantity).toBe(2);
  });
});
