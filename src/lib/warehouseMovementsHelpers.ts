// Pure helpers for Stock Movements page enrichment and display.
// No Supabase imports — all functions are pure and testable in isolation.

export interface AssetInfo {
  serialNumber: string;
  partNumber:   string | null;   // null means genuinely unknown — display '—', never fall back
  assetStatus:  string;
}

export interface ItemInfo {
  itemCode:       string;
  itemName:       string;
  trackingMethod: string;        // 'SERIALIZED' | 'QUANTITY'
}

export type MovementDirection = 'IN' | 'OUT';

// ── Direction ────────────────────────────────────────────────────────────────

/** Derives movement direction from the stored signed quantity. */
export function deriveDirection(quantity: number): MovementDirection {
  return quantity >= 0 ? 'IN' : 'OUT';
}

// ── Map builders ──────────────────────────────────────────────────────────────

/**
 * Builds an O(1) lookup map from a raw inventory_assets result set.
 * Called once per page load with the asset rows fetched for that page.
 * PN is preserved as-is — null means the per-SN PN was not scanned.
 */
export function buildAssetMap(
  assets: Array<{ id: string; serial_number: string; part_number: string | null; status: string }>,
): Map<string, AssetInfo> {
  const map = new Map<string, AssetInfo>();
  for (const a of assets) {
    map.set(a.id, {
      serialNumber: a.serial_number,
      partNumber:   a.part_number,
      assetStatus:  a.status,
    });
  }
  return map;
}

/**
 * Builds an O(1) item lookup map.
 * Must be called without is_active filtering — historical movements may reference
 * deactivated items and must still resolve correctly.
 */
export function buildItemMap(
  items: Array<{ id: string; item_code: string; item_name: string; tracking_method: string }>,
): Map<string, ItemInfo> {
  const map = new Map<string, ItemInfo>();
  for (const i of items) {
    map.set(i.id, {
      itemCode:       i.item_code,
      itemName:       i.item_name,
      trackingMethod: i.tracking_method,
    });
  }
  return map;
}

/**
 * Builds an O(1) warehouse name lookup map.
 * Must be called without is_active filtering — same reason as buildItemMap.
 */
export function buildWarehouseMap(
  warehouses: Array<{ id: string; name: string }>,
): Map<string, string> {
  return new Map(warehouses.map(w => [w.id, w.name]));
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface MovementSearchRow {
  itemCode:       string;
  itemName:       string;
  serialNumber?:  string | null;
  partNumber?:    string | null;
  receiptNumber?: string;
}

/**
 * Client-side movement search across item code, item name, SN, PN, and GR number.
 * Case-insensitive substring match. Returns true when query is empty.
 * Null/absent fields are skipped gracefully — never produce false positives.
 */
export function matchesMovementSearch(row: MovementSearchRow, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    row.itemCode.toLowerCase().includes(q) ||
    row.itemName.toLowerCase().includes(q) ||
    (row.serialNumber  != null && row.serialNumber.toLowerCase().includes(q))  ||
    (row.partNumber    != null && row.partNumber.toLowerCase().includes(q))    ||
    (row.receiptNumber != null && row.receiptNumber.toLowerCase().includes(q))
  );
}

// ── Row enrichment ────────────────────────────────────────────────────────────

export interface RawMovementInput {
  warehouse_id:      string;
  inventory_item_id: string;
  asset_id:          string | null;
  quantity:          number;
  performed_by:      string;
  reference_type:    string | null;
  reference_id:      string | null;
}

export interface MovementEnrichment {
  warehouseName:  string;
  itemCode:       string;
  itemName:       string;
  trackingMethod: string | null;
  performerName:  string;
  receiptNumber:  string | undefined;
  serialNumber:   string | null;
  partNumber:     string | null;
  assetStatus:    string | null;
  direction:      MovementDirection;
}

/**
 * Derives all display fields for a single movement row from the pre-built lookup maps.
 * Pure function — no side effects, no async, safe for use inside .map().
 *
 * Fallback hierarchy (all fields):
 *   - warehouse/item/performer: '—' when FK not found in map (deactivated or test data)
 *   - serialNumber/partNumber/assetStatus: null when no asset linked (QUANTITY items or pre-migration rows)
 *   - receiptNumber: undefined when reference_type !== 'GOODS_RECEIPT' or reference_id is null
 */
export function enrichMovementRow(
  row:      RawMovementInput,
  itemMap:  Map<string, ItemInfo>,
  wrhMap:   Map<string, string>,
  assetMap: Map<string, AssetInfo>,
  perfMap:  Map<string, string>,
  grMap:    Map<string, string>,
): MovementEnrichment {
  const item    = itemMap.get(row.inventory_item_id);
  const asset   = row.asset_id != null ? assetMap.get(row.asset_id) : undefined;
  const receipt = (row.reference_type === 'GOODS_RECEIPT' && row.reference_id != null)
    ? grMap.get(row.reference_id)
    : undefined;

  return {
    warehouseName:  wrhMap.get(row.warehouse_id) ?? '—',
    itemCode:       item?.itemCode                ?? '—',
    itemName:       item?.itemName                ?? '—',
    trackingMethod: item?.trackingMethod          ?? null,
    performerName:  perfMap.get(row.performed_by) ?? (row.performed_by || '—'),
    receiptNumber:  receipt,
    serialNumber:   asset?.serialNumber           ?? null,
    partNumber:     asset?.partNumber             ?? null,
    assetStatus:    asset?.assetStatus            ?? null,
    direction:      deriveDirection(row.quantity),
  };
}

// ── Baghdad timezone display formatters ───────────────────────────────────────
// Baghdad is UTC+3 with no DST (permanent offset). Both helpers share one
// Intl.DateTimeFormat instance and extract parts explicitly so the output
// format (YYYY-MM-DD and HH:MM AM/PM) is locale-independent.

const _baghdadFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Baghdad',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

function _baghdadParts(isoTimestamp: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const { type, value } of _baghdadFmt.formatToParts(new Date(isoTimestamp))) {
    parts[type] = value;
  }
  return parts;
}

/** Returns 'YYYY-MM-DD' for a UTC ISO timestamp converted to Asia/Baghdad local time. */
export function formatBaghdadDate(isoTimestamp: string): string {
  const p = _baghdadParts(isoTimestamp);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Returns '01:21 AM' / '10:21 PM' for a UTC ISO timestamp converted to Asia/Baghdad local time. */
export function formatBaghdadTime(isoTimestamp: string): string {
  const p = _baghdadParts(isoTimestamp);
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}
