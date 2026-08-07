// ── Warehouse Stock — pure helpers for real inventory view ────────────────────

/** Available = max(0, onHand − reserved). Never negative. */
export function computeAvailable(onHand: number, reserved: number): number {
  return Math.max(0, onHand - reserved);
}

export interface PnCountEntry {
  inventory_item_id: string;
}

/** Count learned PN mappings per inventory_item_id. */
export function buildPnCountMap(mappings: PnCountEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of mappings) {
    map.set(m.inventory_item_id, (map.get(m.inventory_item_id) ?? 0) + 1);
  }
  return map;
}

export interface GrRef {
  id:             string;
  receipt_number: string;
}

/** Map receipt UUID → receipt_number for reference column display. */
export function buildGrRefMap(receipts: GrRef[]): Map<string, string> {
  return new Map(receipts.map(r => [r.id, r.receipt_number]));
}

export type StockStateFilter = 'all' | 'in_stock' | 'zero_stock' | 'reserved';

export interface StockRow {
  balanceId:      string | null;
  itemId:         string;
  itemCode:       string;
  itemName:       string;
  trackingMethod: 'SERIALIZED' | 'QUANTITY';
  warehouseId:    string;
  warehouseName:  string;
  onHand:         number;
  reserved:       number;
  available:      number;
  updatedAt:      string | null;
}

export function matchesStockFilter(row: StockRow, filter: StockStateFilter): boolean {
  switch (filter) {
    case 'in_stock':   return row.onHand > 0;
    case 'zero_stock': return row.onHand === 0;
    case 'reserved':   return row.reserved > 0;
    default:           return true;
  }
}

export function matchesStockSearch(row: StockRow, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  return (
    row.itemCode.toLowerCase().includes(lower) ||
    row.itemName.toLowerCase().includes(lower)
  );
}

// ── Line-item PN display (Receiving History modal) ─────────────────────────────

/**
 * Determines the correct PN display string for a single line item, using
 * per-SN scan log data as the truth source for SERIALIZED items.
 *
 * - No scan logs present   → fall back to goods_receipt_items.part_number (or '—')
 * - All logs share one PN  → show that PN
 * - Multiple distinct PNs  → "Multiple PNs (N)"
 * - All PNs are null       → '—'
 */
export function computeLineItemPn(
  itemLogs: Array<{ part_number: string | null }>,
  fallbackPn: string | null,
): string {
  if (itemLogs.length === 0) return fallbackPn || '—';
  const distinct = [...new Set(
    itemLogs.map(l => l.part_number).filter((p): p is string => p !== null)
  )];
  if (distinct.length === 0) return '—';
  if (distinct.length === 1) return distinct[0];
  return `Multiple PNs (${distinct.length})`;
}

// ── Learned-PN search index (Item Master) ──────────────────────────────────────

export interface PnSearchEntry {
  inventory_item_id: string;
  external_code:     string;
}

/**
 * Builds a Map<itemId, lowercasedPN[]> for O(1) per-item search.
 * Storing PNs already lowercased avoids repeated .toLowerCase() during filter.
 */
export function buildPnSearchIndex(mappings: PnSearchEntry[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of mappings) {
    const list = map.get(m.inventory_item_id) ?? [];
    list.push(m.external_code.toLowerCase());
    map.set(m.inventory_item_id, list);
  }
  return map;
}
