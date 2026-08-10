// ── Shared Warehouse & Inventory types ────────────────────────────────────────

import type { OcrCandidateDetail } from './labelOcr';

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  location: string | null;
  is_active: boolean;
}

export interface InventoryItem {
  id: string;
  item_code: string;
  item_name: string;
  item_type: string | null;
  manufacturer: string | null;
  part_number: string | null;
  category: string | null;
  tracking_method: 'SERIALIZED' | 'QUANTITY';
  unit: string;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoodsReceipt {
  id: string;
  receipt_number: string;
  warehouse_id: string;
  project_id: string | null;
  supplier_name: string | null;
  delivery_note_number: string | null;
  purchase_order_number: string | null;
  receipt_date: string;
  status: 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'CANCELLED';
  notes: string | null;
  received_by: string;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoodsReceiptItem {
  id: string;
  goods_receipt_id: string;
  inventory_item_id: string;
  quantity: number;
  part_number: string | null;
}

export interface InventoryAsset {
  id: string;
  inventory_item_id: string;
  serial_number: string;
  serial_number_normalized: string;
  part_number: string | null;
  warehouse_id: string | null;
  project_id: string | null;
  status: 'IN_STOCK' | 'RESERVED' | 'ISSUED' | 'INSTALLED' | 'RETURNED' | 'DAMAGED' | 'SCRAPPED';
  source_receipt_id: string | null;
  raw_scan_value: string | null;
  barcode_symbology: string | null;
  created_at: string;
  updated_at: string;
}

export interface StockBalance {
  id: string;
  warehouse_id: string;
  inventory_item_id: string;
  project_id: string | null;
  quantity_on_hand: number;
  quantity_reserved: number;
  updated_at: string;
}

export interface StockMovement {
  id: string;
  warehouse_id: string;
  inventory_item_id: string;
  asset_id: string | null;
  project_id: string | null;
  movement_type: string;
  quantity: number;
  reference_type: string | null;
  reference_id: string | null;
  performed_by: string;
  movement_date: string;
  notes: string | null;
  created_at: string;
}

// ── Scan session types (client-side) ─────────────────────────────────────────

// Classification of a raw scan's content (independent of item master match)
export type ScanClassification = 'VALID_ITEM' | 'PARTIAL_ITEM' | 'AUXILIARY_CODE' | 'UNKNOWN_CODE' | 'DUPLICATE' | 'UNKNOWN_IDENTIFIER';

// Duplicate scans never become entries; 'ERROR' reserved for future use
export type ScanEntryStatus = 'VALID' | 'PENDING' | 'ERROR';

// Outcome of the smart-label merge engine (barcode + OCR combination)
export type MergeScenario = 'BARCODE_ONLY' | 'OCR_ONLY' | 'MERGED' | 'CONFLICT';

export interface ItemCodeMapping {
  id:                string;
  inventory_item_id: string;
  manufacturer:      string | null;
  code_type:         string;
  external_code:     string;
  parsing_profile:   string | null;
  is_active:         boolean;
  source:            string | null;
  created_by:        string | null;
  created_at:        string;
}

export interface ScanEntry {
  localId: string;           // client-side UUID (crypto.randomUUID())
  rawValue: string;
  symbology: string;
  serialNumber: string | null;
  serialNumberNorm: string | null;  // UPPER(TRIM(serialNumber))
  partNumber: string | null;
  itemTypeRaw: string | null;
  resolvedItemId: string | null;
  resolvedItemName: string | null;
  resolvedItemCode: string | null;
  resolvedByMapping?: boolean;       // true when item resolved via learned PN mapping
  status: ScanEntryStatus;
  statusMsg: string | null;
  scannedAt: string;         // ISO timestamp
  manually: boolean;
  parsingProfile: string;
  parseStatus: 'RESOLVED' | 'PARTIAL' | 'FAILED';   // parser-level outcome
  matchStatus: 'MATCHED' | 'UNMATCHED' | 'NO_PN' | 'NEEDS_REVIEW';  // item master lookup outcome
  scanClassification: ScanClassification;
  // OCR-augmented fields — present only when OCR was run on this entry
  ocrRawText?:      string | null;
  ocrItemType?:     string | null;
  ocrPartNumber?:   string | null;
  ocrSerialNumber?: string | null;
  mergeConflicts?:  string[];
  mergeScenario?:   MergeScenario;
  ocrDurationMs?:   number;
  // Phase B+ OCR diagnostics
  ocrStatus?:       'RUNNING' | 'DONE' | 'FAILED';
  ocrCanvasSize?:   string;   // "1280×720" — captured at scan time
  ocrMergeApplied?: boolean;  // whether OCR added meaningful data
  ocrAmbiguous?:    boolean;  // true when multiple plausible item types, none selected
  ocrCandidates?:   OcrCandidateDetail[];  // per-candidate scoring breakdown
  ocrPasses?: Array<{
    passId:     string;   // 'A' | 'B' | 'C' | 'D'
    label:      string;
    rawText:    string;
    confidence: number;   // 0–100 from Tesseract
    durationMs: number;
    candidates: string[]; // item type tokens accepted in this pass
  }>;
  // Set for UNKNOWN_IDENTIFIER entries — the raw scan value that was not recognizable
  unknownIdentifierRaw?: string | null;
}

export interface SessionDetails {
  warehouseId: string;
  projectId: string;
  receiptDate: string;       // YYYY-MM-DD
  supplierName: string;
  deliveryNote: string;
  poNumber: string;
  notes: string;
}

// ── Goods Issue types ─────────────────────────────────────────────────────────

export type DestinationType = 'SITE' | 'TEAM_MEMBER' | 'USER' | 'VEHICLE' | 'EXTERNAL' | 'OTHER';
export type GoodsIssueStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';

export interface GoodsIssue {
  id:                string;
  issue_number:      string;
  warehouse_id:      string;
  project_id:        string;
  issue_date:        string;
  destination_type:  DestinationType;
  destination_id:    string | null;
  destination_label: string;
  notes:             string | null;
  status:            GoodsIssueStatus;
  issued_by:         string;
  posted_at:         string | null;
  created_at:        string;
  updated_at:        string;
}

export interface GoodsIssueItem {
  id:                string;
  goods_issue_id:    string;
  inventory_item_id: string;
  quantity:          number;
  created_at:        string;
}

export interface GoodsIssueAsset {
  id:                  string;
  goods_issue_id:      string;
  goods_issue_item_id: string;
  inventory_asset_id:  string;
  created_at:          string;
}

// ── Normalizer ────────────────────────────────────────────────────────────────

export function normalizeSN(sn: string): string {
  return sn.trim().toUpperCase();
}
