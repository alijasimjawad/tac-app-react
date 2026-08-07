// ── Shared Warehouse & Inventory types ────────────────────────────────────────

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
  quantity_on_hand: number;
  quantity_reserved: number;
  updated_at: string;
}

export interface StockMovement {
  id: string;
  warehouse_id: string;
  inventory_item_id: string;
  asset_id: string | null;
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

export type ScanEntryStatus = 'VALID' | 'PENDING' | 'DUPLICATE' | 'ERROR';

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
  status: ScanEntryStatus;
  statusMsg: string | null;
  scannedAt: string;         // ISO timestamp
  manually: boolean;
}

export interface SessionDetails {
  warehouseId: string;
  receiptDate: string;       // YYYY-MM-DD
  supplierName: string;
  deliveryNote: string;
  poNumber: string;
  notes: string;
}

// ── Normalizer ────────────────────────────────────────────────────────────────

export function normalizeSN(sn: string): string {
  return sn.trim().toUpperCase();
}
