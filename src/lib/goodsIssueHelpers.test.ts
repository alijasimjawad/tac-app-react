import { describe, it, expect } from 'vitest';
import {
  destinationTypeRequiresId,
  validateDestination,
  isDuplicateAsset,
  validateSerializedCount,
  validateQuantityIssue,
  checkAssetBelongsToIssue,
  checkAssetItemMatch,
  isDuplicateItem,
  canCancelIssue,
  canPostIssue,
  computeAvailableQty,
  type DestinationType,
} from './goodsIssueHelpers';

// ── destinationTypeRequiresId() ───────────────────────────────────────────────

describe('destinationTypeRequiresId()', () => {
  it.each<DestinationType>(['TEAM_MEMBER', 'USER'])('%s requires id', type => {
    expect(destinationTypeRequiresId(type)).toBe(true);
  });
  it.each<DestinationType>(['SITE', 'VEHICLE', 'EXTERNAL', 'OTHER'])('%s does not require id', type => {
    expect(destinationTypeRequiresId(type)).toBe(false);
  });
});

// ── validateDestination() ─────────────────────────────────────────────────────

describe('validateDestination()', () => {
  it('returns null when VEHICLE with label and no id', () => {
    expect(validateDestination('VEHICLE', null, 'Truck 01')).toBeNull();
  });
  it('returns error when label is empty', () => {
    expect(validateDestination('EXTERNAL', null, '')).not.toBeNull();
  });
  it('returns error when label is whitespace-only', () => {
    expect(validateDestination('OTHER', null, '   ')).not.toBeNull();
  });
  it('returns null for SITE with id and label (matched)', () => {
    expect(validateDestination('SITE', 'site-uuid', 'AL-001 — Main Site')).toBeNull();
  });
  it('returns null for SITE without id when label provided (unmatched site)', () => {
    expect(validateDestination('SITE', null, 'AL-001 — Main Site')).toBeNull();
  });
  it('returns null for SITE with free-text label and no id', () => {
    expect(validateDestination('SITE', null, 'CUSTOM-SITE-123')).toBeNull();
  });
  it('returns error for SITE without id AND without label', () => {
    expect(validateDestination('SITE', null, '')).not.toBeNull();
  });
  it('returns error for TEAM_MEMBER without id', () => {
    expect(validateDestination('TEAM_MEMBER', null, 'John Doe')).not.toBeNull();
  });
  it('returns null for USER with id and label', () => {
    expect(validateDestination('USER', 'user-uuid', 'Ali Jasim')).toBeNull();
  });
});

// ── isDuplicateAsset() ────────────────────────────────────────────────────────

describe('isDuplicateAsset()', () => {
  it('returns true when id is in list', () => {
    expect(isDuplicateAsset(['a', 'b', 'c'], 'b')).toBe(true);
  });
  it('returns false when id is not in list', () => {
    expect(isDuplicateAsset(['a', 'b', 'c'], 'd')).toBe(false);
  });
  it('returns false for empty list', () => {
    expect(isDuplicateAsset([], 'a')).toBe(false);
  });
});

// ── validateSerializedCount() ─────────────────────────────────────────────────

describe('validateSerializedCount()', () => {
  it('returns null when counts match', () => {
    expect(validateSerializedCount(3, 3)).toBeNull();
  });
  it('returns error when too few scanned', () => {
    expect(validateSerializedCount(1, 3)).not.toBeNull();
  });
  it('returns error when too many scanned', () => {
    expect(validateSerializedCount(4, 3)).not.toBeNull();
  });
  it('returns null for 0 === 0', () => {
    expect(validateSerializedCount(0, 0)).toBeNull();
  });
  it('includes singular "asset" when qty is 1', () => {
    const msg = validateSerializedCount(0, 1);
    expect(msg).toMatch(/1 asset[^s]/);
  });
  it('includes plural "assets" when qty > 1', () => {
    const msg = validateSerializedCount(0, 2);
    expect(msg).toMatch(/2 assets/);
  });
});

// ── validateQuantityIssue() ───────────────────────────────────────────────────

describe('validateQuantityIssue()', () => {
  it('returns null when requested equals available', () => {
    expect(validateQuantityIssue(5, 5)).toBeNull();
  });
  it('returns null when requested is less than available', () => {
    expect(validateQuantityIssue(3, 10)).toBeNull();
  });
  it('returns error when requested exceeds available', () => {
    expect(validateQuantityIssue(6, 5)).not.toBeNull();
  });
  it('returns error when requested is 0', () => {
    expect(validateQuantityIssue(0, 10)).not.toBeNull();
  });
  it('returns error when requested is negative', () => {
    expect(validateQuantityIssue(-1, 10)).not.toBeNull();
  });
});

// ── checkAssetBelongsToIssue() ────────────────────────────────────────────────

describe('checkAssetBelongsToIssue()', () => {
  it('returns null when project and warehouse both match', () => {
    expect(checkAssetBelongsToIssue('proj-1', 'proj-1', 'wrh-1', 'wrh-1')).toBeNull();
  });
  it('returns error when project differs', () => {
    expect(checkAssetBelongsToIssue('proj-2', 'proj-1', 'wrh-1', 'wrh-1')).not.toBeNull();
  });
  it('returns error when warehouse differs', () => {
    expect(checkAssetBelongsToIssue('proj-1', 'proj-1', 'wrh-2', 'wrh-1')).not.toBeNull();
  });
  it('returns error when asset has null project (legacy)', () => {
    expect(checkAssetBelongsToIssue(null, 'proj-1', 'wrh-1', 'wrh-1')).not.toBeNull();
  });
  it('returns error when asset has null warehouse', () => {
    expect(checkAssetBelongsToIssue('proj-1', 'proj-1', null, 'wrh-1')).not.toBeNull();
  });
  it('returns project error before warehouse error', () => {
    const msg = checkAssetBelongsToIssue('proj-2', 'proj-1', 'wrh-2', 'wrh-1');
    expect(msg).toMatch(/project/i);
  });
});

// ── checkAssetItemMatch() ─────────────────────────────────────────────────────

describe('checkAssetItemMatch()', () => {
  it('returns null when asset item matches line item', () => {
    expect(checkAssetItemMatch('item-uuid-1', 'item-uuid-1')).toBeNull();
  });
  it('returns error when asset item differs from line item', () => {
    expect(checkAssetItemMatch('item-uuid-2', 'item-uuid-1')).not.toBeNull();
  });
  it('error message mentions item type', () => {
    const msg = checkAssetItemMatch('item-uuid-2', 'item-uuid-1');
    expect(msg).toMatch(/item type/i);
  });
});

// ── isDuplicateItem() ─────────────────────────────────────────────────────────

describe('isDuplicateItem()', () => {
  it('returns true when item already in lines', () => {
    expect(isDuplicateItem([{ itemId: 'a' }, { itemId: 'b' }], 'b')).toBe(true);
  });
  it('returns false when item not in lines', () => {
    expect(isDuplicateItem([{ itemId: 'a' }, { itemId: 'b' }], 'c')).toBe(false);
  });
  it('returns false for empty lines', () => {
    expect(isDuplicateItem([], 'a')).toBe(false);
  });
});

// ── computeAvailableQty() — SERIALIZED reserved-aware check ──────────────────
// This mirrors the RPC logic: v_available := GREATEST(0, quantity_on_hand - quantity_reserved)

describe('computeAvailableQty() — SERIALIZED path', () => {
  it('reduces available by reserved amount', () => {
    expect(computeAvailableQty(10, 3)).toBe(7);
  });
  it('returns 0 when all on-hand is reserved', () => {
    expect(computeAvailableQty(5, 5)).toBe(0);
  });
  it('returns 0 (never negative) when reserved exceeds on-hand', () => {
    expect(computeAvailableQty(3, 7)).toBe(0);
  });
});

// ── canCancelIssue() ──────────────────────────────────────────────────────────

describe('canCancelIssue()', () => {
  it('returns true for DRAFT', () => expect(canCancelIssue('DRAFT')).toBe(true));
  it('returns false for POSTED', () => expect(canCancelIssue('POSTED')).toBe(false));
  it('returns false for CANCELLED', () => expect(canCancelIssue('CANCELLED')).toBe(false));
});

// ── canPostIssue() ────────────────────────────────────────────────────────────

describe('canPostIssue()', () => {
  it('returns true for DRAFT', () => expect(canPostIssue('DRAFT')).toBe(true));
  it('returns false for POSTED', () => expect(canPostIssue('POSTED')).toBe(false));
  it('returns false for CANCELLED', () => expect(canPostIssue('CANCELLED')).toBe(false));
});

// ── computeAvailableQty() ─────────────────────────────────────────────────────

describe('computeAvailableQty()', () => {
  it('returns onHand - reserved when positive', () => {
    expect(computeAvailableQty(10, 3)).toBe(7);
  });
  it('returns 0 when reserved equals onHand', () => {
    expect(computeAvailableQty(5, 5)).toBe(0);
  });
  it('returns 0 (not negative) when reserved exceeds onHand', () => {
    expect(computeAvailableQty(3, 7)).toBe(0);
  });
  it('returns onHand when reserved is 0', () => {
    expect(computeAvailableQty(8, 0)).toBe(8);
  });
  it('returns 0 for both zero', () => {
    expect(computeAvailableQty(0, 0)).toBe(0);
  });
});
