// Pure helpers for WarehouseReceiveEdit QUANTITY item handling.
// No Supabase imports — all functions are pure and testable.

export interface QuantityLineItem {
  inventoryItemId: string;
  itemCode:        string;
  itemName:        string;
  quantity:        number;
}

export interface QuantityEntryForRpc {
  inventory_item_id: string;
  quantity:          number;
}

/** Maps quantity line state to the RPC payload shape. Filters lines with qty <= 0. */
export function buildQuantityEntries(lines: QuantityLineItem[]): QuantityEntryForRpc[] {
  return lines
    .filter(l => l.quantity > 0)
    .map(l => ({ inventory_item_id: l.inventoryItemId, quantity: l.quantity }));
}

/** Returns a new lines array with the given item's quantity adjusted by delta, minimum 1. */
export function adjustQuantityLine(
  lines:           QuantityLineItem[],
  inventoryItemId: string,
  delta:           number,
): QuantityLineItem[] {
  return lines.map(l =>
    l.inventoryItemId === inventoryItemId
      ? { ...l, quantity: Math.max(1, l.quantity + delta) }
      : l,
  );
}

/**
 * Returns a new lines array with the given item's quantity set from a raw string input.
 * Parses as integer; falls back to 1 on invalid or zero input.
 */
export function setQuantityLineQty(
  lines:           QuantityLineItem[],
  inventoryItemId: string,
  rawValue:        string,
): QuantityLineItem[] {
  const parsed = parseInt(rawValue, 10);
  const qty = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  return lines.map(l =>
    l.inventoryItemId === inventoryItemId ? { ...l, quantity: qty } : l,
  );
}

/**
 * Returns true if any quantity differs or if lengths differ.
 * Assumes lines are ordered stably (same order as originalQuantityLines).
 */
export function hasQuantityChanges(
  current:  QuantityLineItem[],
  original: QuantityLineItem[],
): boolean {
  if (current.length !== original.length) return true;
  return current.some((c, i) => c.quantity !== original[i].quantity);
}
