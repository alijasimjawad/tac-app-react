// ── Existing-asset detection — pure helpers for scan-time SN blocking ─────────

import type { InventoryAsset } from './warehouseTypes';

export type AssetStatus = InventoryAsset['status'];

/** Minimal preloaded row from inventory_assets for O(1) SN lookup. */
export interface KnownAsset {
  serialNumberNorm:  string;
  inventoryItemId:   string;
  partNumber:        string | null;
  warehouseId:       string | null;
  status:            AssetStatus;
  sourceReceiptId:   string | null;
}

/** Message shown in the blocked-asset card when a scan is rejected. */
export interface BlockedMessage {
  headline:    string;   // Bold title line
  subtext:     string;   // Explanatory sentence
  allowReturn: boolean;  // true → show "Use Return workflow" hint
}

/** Build the O(1) lookup map. Key = serial_number_normalized. */
export function buildExistingAssetsMap(rows: KnownAsset[]): Map<string, KnownAsset> {
  const map = new Map<string, KnownAsset>();
  for (const r of rows) map.set(r.serialNumberNorm, r);
  return map;
}

/**
 * Returns the display message for a blocked scan.
 * Every status is explicitly handled — no fallthrough.
 */
export function getBlockMessage(status: AssetStatus): BlockedMessage {
  switch (status) {
    case 'IN_STOCK':
      return {
        headline:    'Already in Stock',
        subtext:     'This serial number is already tracked in inventory. Do not receive it again.',
        allowReturn: false,
      };
    case 'RESERVED':
      return {
        headline:    'Asset Reserved',
        subtext:     'This serial number is already reserved in the system. Do not receive it as a new item.',
        allowReturn: false,
      };
    case 'ISSUED':
      return {
        headline:    'Previously Issued Asset — use Return to Warehouse',
        subtext:     'This asset was issued from stock. Bring it back using the Return workflow, not a new goods receipt.',
        allowReturn: true,
      };
    case 'INSTALLED':
      return {
        headline:    'Installed Asset — return workflow required',
        subtext:     'This asset is recorded as installed. Use the Return to Warehouse workflow before receiving it again.',
        allowReturn: true,
      };
    case 'RETURNED':
      return {
        headline:    'Asset Pending Return Acceptance',
        subtext:     'This asset was returned but has not been formally accepted back into stock. Use the Accept Return workflow.',
        allowReturn: true,
      };
    case 'DAMAGED':
      return {
        headline:    'Damaged Asset',
        subtext:     'This asset is marked damaged and requires disposition review before being received.',
        allowReturn: false,
      };
    case 'SCRAPPED':
      return {
        headline:    'Scrapped Asset',
        subtext:     'This asset has been permanently scrapped and cannot be received.',
        allowReturn: false,
      };
  }
}
