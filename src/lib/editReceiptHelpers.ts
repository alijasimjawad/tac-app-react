// ── Edit Pending Goods Receipt — pure helpers ─────────────────────────────────

/** Shape sent in the p_scan_entries JSONB array to update_pending_goods_receipt(). */
export interface EditScanEntryForRpc {
  inventory_item_id: string;
  serial_number:     string;
  part_number:       string | null;
  raw_scan_value:    string;
  barcode_symbology: string | null;
  scanned_manually:  boolean;
}

export interface BuiltLineItem {
  inventoryItemId: string;
  quantity:        number;
  /** null when entries have multiple distinct PNs or no PN at all. */
  partNumber:      string | null;
}

/**
 * Mirrors the SQL PN policy inside update_pending_goods_receipt():
 *   - ALL units have the SAME non-null PN → stored.
 *   - Any unit has a null PN while another has non-null → null.
 *   - Multiple distinct PNs → null.
 *   - All units have null PN → null.
 * Used for testing and for computing preview counts before calling the RPC.
 */
export function buildLineItemsFromEntries(entries: EditScanEntryForRpc[]): BuiltLineItem[] {
  const grouped = new Map<string, EditScanEntryForRpc[]>();
  for (const e of entries) {
    const g = grouped.get(e.inventory_item_id);
    if (g) g.push(e);
    else grouped.set(e.inventory_item_id, [e]);
  }
  return Array.from(grouped.entries()).map(([itemId, rows]) => {
    const hasNullPn    = rows.some(r => r.part_number === null);
    const distinctPns  = new Set(rows.map(r => r.part_number).filter((p): p is string => p !== null));
    return {
      inventoryItemId: itemId,
      quantity:        rows.length,
      partNumber:      !hasNullPn && distinctPns.size === 1 ? [...distinctPns][0] : null,
    };
  });
}
