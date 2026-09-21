-- ============================================================
-- Migration 013 — Clear Warehouse Transactional Data (go-live reset)
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- ⚠️  DESTRUCTIVE — permanently deletes rows. Take a backup first
--    (BackupRestore page in the app, or Supabase's own backup/export)
--    before running this.
--
-- What this clears:
--   - All goods receipts (SMR-originated and manual), their line items,
--     scan sessions/log
--   - All goods issues, their line items, issued assets
--   - All inventory assets (serialized stock records)
--   - All stock balances and stock movements
--   - All Customer SMR documents, lines, and scans
--
-- What this KEEPS (reference/master data, untouched):
--   - inventory_items (item master / catalog)
--   - item_code_mappings (learned barcode/PN mappings)
--   - warehouses
--   - projects, users, team_members, everything outside the warehouse module
--
-- Also resets the GR-xxxxx / GI-xxxxx numbering sequences back to 1,
-- so the first receipt/issue after this reset is 00001.
-- ============================================================

BEGIN;

-- Movements have no dependents — safe to clear first.
DELETE FROM stock_movements;

-- Cascades to goods_issue_items + goods_issue_assets.
DELETE FROM goods_issues;

-- Now safe: nothing left referencing inventory_assets.
DELETE FROM inventory_assets;

DELETE FROM stock_balances;

-- Clear SMR documents before goods_receipts, since smr_documents.goods_receipt_id
-- references goods_receipts (cascades to smr_lines + smr_line_scans).
DELETE FROM smr_documents;

-- Cascades to goods_receipt_items, receiving_scan_sessions, receiving_scan_log.
DELETE FROM goods_receipts;

-- Restart numbering from 00001.
ALTER SEQUENCE goods_receipt_seq RESTART WITH 1;
ALTER SEQUENCE goods_issue_seq   RESTART WITH 1;

COMMIT;
