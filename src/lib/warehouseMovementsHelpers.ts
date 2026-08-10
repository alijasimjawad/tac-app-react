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

/**
 * Builds an O(1) project display_name lookup map.
 * Must be called without is_active filtering so inactive projects still resolve
 * correctly in historical movement and receipt views.
 */
export function buildProjectMap(
  projects: Array<{ id: string; display_name: string }>,
): Map<string, string> {
  return new Map(projects.map(p => [p.id, p.display_name]));
}

/**
 * Returns a project's display name, or 'Unassigned' for legacy rows with
 * null project_id (test data before Stage E NOT NULL enforcement).
 */
export function formatProjectName(
  projectId: string | null | undefined,
  projectMap: Map<string, string>,
): string {
  if (projectId == null) return 'Unassigned';
  return projectMap.get(projectId) ?? 'Unassigned';
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
  project_id?:       string | null;
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
  projectName:    string;
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
  row:        RawMovementInput,
  itemMap:    Map<string, ItemInfo>,
  wrhMap:     Map<string, string>,
  assetMap:   Map<string, AssetInfo>,
  perfMap:    Map<string, string>,
  grMap:      Map<string, string>,
  projectMap: Map<string, string> = new Map(),
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
    projectName:    formatProjectName(row.project_id, projectMap),
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

// ── Barcode symbology display formatter ───────────────────────────────────────
// Normalises the raw barcode_symbology DB value to a human-readable label.
//
// The DB contains two kinds of values:
//   1. ZXing numeric enum integers ("5", "4", "11", …) — written by the ZXing
//      fallback path before the write-path fix was applied.
//   2. Named strings from BarcodeDetector API ("DATA_MATRIX", "CODE_128", …),
//      or non-camera inputs ("USB_HID", "MANUAL", "OCR").
//
// Both are normalised to a single consistent display label here so historical
// rows ("5") and future rows ("DATA_MATRIX") display identically.

const _symbologyLabels: Record<string, string> = {
  // ── ZXing BarcodeFormat numeric enum values (legacy write-path) ──────────
  '0':  'Aztec',
  '1':  'Codabar',
  '2':  'Code 39',
  '3':  'Code 93',
  '4':  'Code 128',
  '5':  'DataMatrix',
  '6':  'EAN-8',
  '7':  'EAN-13',
  '8':  'ITF',
  '9':  'MaxiCode',
  '10': 'PDF 417',
  '11': 'QR Code',
  '12': 'RSS-14',
  '13': 'RSS Expanded',
  '14': 'UPC-A',
  '15': 'UPC-E',
  '16': 'UPC/EAN Ext',
  // ── Named strings from BarcodeDetector API (canonical post-fix values) ───
  'AZTEC':              'Aztec',
  'CODABAR':            'Codabar',
  'CODE_39':            'Code 39',
  'CODE_93':            'Code 93',
  'CODE_128':           'Code 128',
  'DATA_MATRIX':        'DataMatrix',
  'EAN_8':              'EAN-8',
  'EAN_13':             'EAN-13',
  'ITF':                'ITF',
  'MAXICODE':           'MaxiCode',
  'PDF_417':            'PDF 417',
  'QR_CODE':            'QR Code',
  'RSS_14':             'RSS-14',
  'RSS_EXPANDED':       'RSS Expanded',
  'UPC_A':              'UPC-A',
  'UPC_E':              'UPC-E',
  'UPC_EAN_EXTENSION':  'UPC/EAN Ext',
  // ── Non-camera input sources ─────────────────────────────────────────────
  'USB_HID': 'USB Scanner',
  'MANUAL':  'Manual',
  'OCR':     'OCR',
};

/**
 * Returns a human-readable barcode symbology label from a raw DB value.
 * Handles ZXing numeric integers ("5" → "DataMatrix"), BarcodeDetector named
 * strings ("DATA_MATRIX" → "DataMatrix"), and non-camera sources ("USB_HID" →
 * "USB Scanner"). Unknown values are returned as-is so nothing crashes.
 */
export function formatBarcodeSymbology(raw: string | null | undefined): string {
  if (!raw) return '—';
  return _symbologyLabels[raw] ?? _symbologyLabels[raw.toUpperCase()] ?? raw;
}
