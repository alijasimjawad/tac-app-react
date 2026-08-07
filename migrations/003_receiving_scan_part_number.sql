-- ============================================================
-- Migration 003 — Add part_number to receiving_scan_log
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to run on a fresh schema or re-run.
-- Depends on: 001_warehouse_phase1.sql (receiving_scan_log table)
-- ============================================================
--
-- Why: receiving_scan_log currently has no part_number column.
-- The per-SN PN captured during scanning was lost after save.
-- post_goods_receipt() (migration 004) reads this column to populate
-- inventory_assets.part_number with the exact PN seen on that physical unit.
-- Rows inserted before this migration will have part_number = NULL.
-- The RPC stores that NULL as-is — no fallback to goods_receipt_items.part_number.
-- Principle: UNKNOWN PN is safer than a wrong inferred PN on a physical unit.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receiving_scan_log' AND column_name = 'part_number'
  ) THEN
    ALTER TABLE receiving_scan_log ADD COLUMN part_number text;
  END IF;
END $$;
