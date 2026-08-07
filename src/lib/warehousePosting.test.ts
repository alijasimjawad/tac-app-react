import { describe, it, expect } from 'vitest';

// ── SQL-level integration test specifications ─────────────────────────────────
// The tests below are marked it.todo() because they require a live Supabase
// instance with migrations 001–004 applied. They document the DB invariants
// that post_goods_receipt() MUST satisfy and must be verified manually or via
// a separate integration test suite against a test DB before shipping.
//
// Per-SN PN policy (Issue 1):
//   inventory_assets.part_number = receiving_scan_log.part_number ONLY.
//   goods_receipt_items.part_number is NEVER used as a fallback, because one
//   line item may cover units with distinct PNs (PN-A / PN-B / PN-C).
//   UNKNOWN PN (NULL) is safer than an INFERRED WRONG PN.
//
// Authorization model (Issue 2):
//   SECURITY INVOKER + GRANT TO authenticated mirrors the existing TAC RLS model
//   (all warehouse tables: FOR ALL TO authenticated USING (true) WITH CHECK (true)).
//   post_goods_receipt() has no DB-level permission gate beyond "is authenticated".
//   The wrh_receive_post permission check is FRONTEND-ONLY via hasPerm().
//   This is a known limitation consistent with the existing TAC security posture.

describe('post_goods_receipt() — SQL invariants (integration test specs)', () => {
  // ── Per-SN PN policy ────────────────────────────────────────────────────────
  it.todo('SERIALIZED: asset.part_number = scan_log.part_number, not gri.part_number');
  it.todo('SERIALIZED: NULL scan-log PN → NULL asset PN (no fallback to grouped PN)');
  it.todo('SERIALIZED: three SNs with PN-A / PN-B / NULL → assets get PN-A / PN-B / NULL');
  it.todo('SERIALIZED: scan-log PN-A for SN001 never propagates to SN002 with NULL PN');

  // ── Pre-migration (legacy) receipts ─────────────────────────────────────────
  it.todo('LEGACY: old PENDING_REVIEW receipts (scan_log.part_number=NULL) post with asset.part_number=NULL');
  it.todo('LEGACY: no fallback to gri.part_number for pre-migration rows — NULL is the correct outcome');

  // ── Validation gates ─────────────────────────────────────────────────────────
  it.todo('rejects receipt that does not exist');
  it.todo('rejects receipt with status != PENDING_REVIEW (already POSTED or CANCELLED)');
  it.todo('rejects receipt with NULL warehouse_id (schema-level impossible but checked defensively)');
  it.todo('rejects receipt with no line items');
  it.todo('rejects when any line item references an inactive inventory item');
  it.todo('rejects when any line item has quantity <= 0');
  it.todo('rejects when intra-receipt duplicate serial numbers are detected');
  it.todo('rejects when any SN is already present in inventory_assets');
  it.todo('rejects SERIALIZED line when scan-log count != gri.quantity');

  // ── Stock integrity ──────────────────────────────────────────────────────────
  it.todo('SERIALIZED: one inventory_assets row per scan-log row, with asset_id linked in stock_movements');
  it.todo('QUANTITY: zero inventory_assets rows, one stock_movements row with asset_id=NULL');
  it.todo('stock_balances.quantity_on_hand INCREMENTS on each post, never overwrites');
  it.todo('stock_balances.quantity_reserved is NOT touched during posting');
  it.todo('status becomes POSTED only after all assets, movements, and balances are written (last step)');
  it.todo('FOR UPDATE lock prevents two concurrent posts of the same receipt');

  // ── Authorization ────────────────────────────────────────────────────────────
  it.todo('any authenticated session can call post_goods_receipt via Supabase RPC — no DB-level role gate');
  it.todo('wrh_receive_post permission is enforced only in WarehouseHistory.tsx via hasPerm()');
});

import {
  formatPostingToast,
  isAlreadyPostedError,
  isDuplicateSnError,
  isQuantityMismatchError,
  isInactiveItemError,
  extractSnFromError,
  friendlyPostingError,
  type PostReceiptSuccess,
} from './warehousePosting';

const baseResult: PostReceiptSuccess = {
  success:           true,
  receipt_number:    'GR-202608-00001',
  assets_created:    3,
  movements_created: 3,
};

// ── formatPostingToast() ──────────────────────────────────────────────────────

describe('formatPostingToast()', () => {
  it('includes receipt number', () => {
    expect(formatPostingToast(baseResult)).toContain('GR-202608-00001');
  });

  it('includes assets_created count with plural', () => {
    expect(formatPostingToast(baseResult)).toContain('3 assets created');
  });

  it('uses singular asset when count is 1', () => {
    expect(formatPostingToast({ ...baseResult, assets_created: 1 })).toContain('1 asset created');
  });

  it('includes movements_created count with plural', () => {
    expect(formatPostingToast(baseResult)).toContain('3 movements recorded');
  });

  it('uses singular movement when count is 1', () => {
    expect(formatPostingToast({ ...baseResult, movements_created: 1 })).toContain('1 movement recorded');
  });

  it('omits assets line when assets_created is 0', () => {
    const msg = formatPostingToast({ ...baseResult, assets_created: 0 });
    expect(msg).not.toContain('asset');
  });

  it('omits movements line when movements_created is 0', () => {
    const msg = formatPostingToast({ ...baseResult, movements_created: 0 });
    expect(msg).not.toContain('movement');
  });
});

// ── isAlreadyPostedError() ────────────────────────────────────────────────────

describe('isAlreadyPostedError()', () => {
  it('returns true for PENDING_REVIEW status error', () => {
    expect(isAlreadyPostedError('Receipt GR-001 is not in PENDING_REVIEW status (current: POSTED)')).toBe(true);
  });

  it('returns false for unrelated messages', () => {
    expect(isAlreadyPostedError('Duplicate serial number within receipt: ABC123')).toBe(false);
  });
});

// ── isDuplicateSnError() ──────────────────────────────────────────────────────

describe('isDuplicateSnError()', () => {
  it('returns true for intra-receipt duplicate SN message', () => {
    expect(isDuplicateSnError('Duplicate serial number within receipt: K9241817927')).toBe(true);
  });

  it('returns true for SN already in inventory message', () => {
    expect(isDuplicateSnError('Serial number already in inventory: K9241817927')).toBe(true);
  });

  it('returns false for unrelated messages', () => {
    expect(isDuplicateSnError('Receipt GR-001 is not in PENDING_REVIEW status')).toBe(false);
  });
});

// ── isQuantityMismatchError() ─────────────────────────────────────────────────

describe('isQuantityMismatchError()', () => {
  it('returns true for scan count mismatch message', () => {
    expect(isQuantityMismatchError('Item ABIO scan count (2) does not match line item quantity (3)')).toBe(true);
  });

  it('returns false for unrelated messages', () => {
    expect(isQuantityMismatchError('Duplicate serial number within receipt: K9241817927')).toBe(false);
  });
});

// ── isInactiveItemError() ─────────────────────────────────────────────────────

describe('isInactiveItemError()', () => {
  it('returns true for inactive item message', () => {
    expect(isInactiveItemError('Item ABIO is not active')).toBe(true);
  });

  it('returns false for unrelated messages', () => {
    expect(isInactiveItemError('Receipt GR-001 has no line items')).toBe(false);
  });
});

// ── extractSnFromError() ──────────────────────────────────────────────────────

describe('extractSnFromError()', () => {
  it('extracts SN from already-in-inventory message', () => {
    expect(extractSnFromError('Serial number already in inventory: K9241817927')).toBe('K9241817927');
  });

  it('extracts SN from duplicate-within-receipt message', () => {
    expect(extractSnFromError('Duplicate serial number within receipt: K9241817927')).toBe('K9241817927');
  });

  it('returns null for messages without a recognizable SN pattern', () => {
    expect(extractSnFromError('Receipt GR-001 is not in PENDING_REVIEW status')).toBeNull();
  });
});

// ── friendlyPostingError() ────────────────────────────────────────────────────

describe('friendlyPostingError()', () => {
  it('returns friendly message for already-posted error', () => {
    expect(friendlyPostingError('not in PENDING_REVIEW status')).toBe('This receipt has already been posted.');
  });

  it('returns SN in message for duplicate SN error', () => {
    const msg = friendlyPostingError('Serial number already in inventory: K9241817927');
    expect(msg).toContain('K9241817927');
  });

  it('returns generic duplicate message when no SN can be extracted', () => {
    expect(friendlyPostingError('Duplicate serial number')).toBe('A duplicate serial number was detected.');
  });

  it('returns friendly message for quantity mismatch', () => {
    expect(friendlyPostingError('scan count (2) does not match line item quantity (3)'))
      .toBe('Scan count does not match receipt quantity for one or more items.');
  });

  it('returns friendly message for inactive item', () => {
    expect(friendlyPostingError('Item ABIO is not active'))
      .toBe('One or more items in this receipt are no longer active.');
  });

  it('returns the raw message for unknown errors', () => {
    const raw = 'some unexpected database error';
    expect(friendlyPostingError(raw)).toBe(raw);
  });
});
