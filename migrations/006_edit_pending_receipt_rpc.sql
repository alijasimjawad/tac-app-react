-- ============================================================
-- Migration 006 — update_pending_goods_receipt() RPC
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: CREATE OR REPLACE is safe to re-run.
-- Depends on: 001_warehouse_phase1.sql, 003_receiving_scan_part_number.sql
-- ============================================================
--
-- Atomically replaces the scan log + line items for a PENDING_REVIEW receipt
-- and updates its header fields. Uses FOR UPDATE to prevent a concurrent post
-- or concurrent edit from racing this call.
--
-- SECURITY INVOKER: runs as the calling authenticated user so RLS policies
-- continue to apply normally (same design as post_goods_receipt).
--
-- PN policy for goods_receipt_items.part_number (summary field only):
--   ALL units share the SAME non-null PN → store it.
--   Any unit has a null PN while another has non-null → NULL.
--   Multiple distinct PNs → NULL.
--   All-null → NULL.
-- Per-SN receiving_scan_log.part_number is always authoritative.

CREATE OR REPLACE FUNCTION update_pending_goods_receipt(
  p_receipt_id            uuid,
  p_supplier_name         text,
  p_delivery_note_number  text,
  p_purchase_order_number text,
  p_receipt_date          date,
  p_notes                 text,
  p_scan_entries          jsonb
  -- [{inventory_item_id, serial_number, part_number, raw_scan_value,
  --   barcode_symbology, scanned_manually}]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_receipt      goods_receipts%ROWTYPE;
  v_old_count    integer;
  v_new_count    integer;
  v_dup_sn       text;
  v_existing_sn  text;
BEGIN
  -- ── 1. Lock receipt row (concurrent-edit / concurrent-post protection) ───────
  SELECT * INTO v_receipt
  FROM goods_receipts
  WHERE id = p_receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found: %', p_receipt_id;
  END IF;

  IF v_receipt.status != 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'Receipt % is not PENDING_REVIEW (current: %)',
      v_receipt.receipt_number, v_receipt.status;
  END IF;

  -- ── 2. Capture old scan count for diff reporting ──────────────────────────
  SELECT count(*) INTO v_old_count
  FROM receiving_scan_log
  WHERE goods_receipt_id = p_receipt_id;

  v_new_count := jsonb_array_length(p_scan_entries);

  -- ── 3. No intra-batch duplicate serial numbers ────────────────────────────
  SELECT UPPER(TRIM(e->>'serial_number')) INTO v_dup_sn
  FROM jsonb_array_elements(p_scan_entries) AS e
  WHERE (e->>'serial_number') IS NOT NULL
  GROUP BY UPPER(TRIM(e->>'serial_number'))
  HAVING count(*) > 1
  LIMIT 1;

  IF v_dup_sn IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate serial number in new entry set: %', v_dup_sn;
  END IF;

  -- ── 4. No SNs already present in inventory_assets ────────────────────────
  -- PENDING_REVIEW receipts have no inventory_assets rows yet, so this only
  -- guards against SNs that are genuinely IN_STOCK/ISSUED/etc from other receipts.
  SELECT ia.serial_number_normalized INTO v_existing_sn
  FROM jsonb_array_elements(p_scan_entries) AS e
  JOIN inventory_assets ia
    ON ia.serial_number_normalized = UPPER(TRIM(e->>'serial_number'))
  WHERE (e->>'serial_number') IS NOT NULL
  LIMIT 1;

  IF v_existing_sn IS NOT NULL THEN
    RAISE EXCEPTION 'Serial number already in inventory: %', v_existing_sn;
  END IF;

  -- ── 5. Replace scan log atomically ───────────────────────────────────────
  DELETE FROM receiving_scan_log WHERE goods_receipt_id = p_receipt_id;

  INSERT INTO receiving_scan_log (
    goods_receipt_id,
    inventory_item_id,
    serial_number,
    part_number,
    raw_scan_value,
    barcode_symbology,
    scanned_manually
  )
  SELECT
    p_receipt_id,
    (e->>'inventory_item_id')::uuid,
    e->>'serial_number',
    e->>'part_number',
    e->>'raw_scan_value',
    e->>'barcode_symbology',
    COALESCE((e->>'scanned_manually')::boolean, false)
  FROM jsonb_array_elements(p_scan_entries) AS e;

  -- ── 6. Replace line items with PN policy ─────────────────────────────────
  DELETE FROM goods_receipt_items WHERE goods_receipt_id = p_receipt_id;

  INSERT INTO goods_receipt_items (
    goods_receipt_id,
    inventory_item_id,
    quantity,
    part_number
  )
  SELECT
    p_receipt_id,
    (e->>'inventory_item_id')::uuid,
    count(*),
    CASE
      WHEN count(*) FILTER (WHERE (e->>'part_number') IS NULL) = 0
       AND count(DISTINCT e->>'part_number') = 1
      THEN max(e->>'part_number')
      ELSE NULL
    END
  FROM jsonb_array_elements(p_scan_entries) AS e
  WHERE (e->>'inventory_item_id') IS NOT NULL
  GROUP BY (e->>'inventory_item_id')::uuid;

  -- ── 7. Update header fields ───────────────────────────────────────────────
  UPDATE goods_receipts
  SET
    supplier_name          = p_supplier_name,
    delivery_note_number   = p_delivery_note_number,
    purchase_order_number  = p_purchase_order_number,
    receipt_date           = p_receipt_date,
    notes                  = p_notes,
    updated_at             = now()
  WHERE id = p_receipt_id;

  RETURN jsonb_build_object(
    'success',         true,
    'receipt_number',  v_receipt.receipt_number,
    'old_count',       v_old_count,
    'new_count',       v_new_count
  );
END;
$$;

-- Allow any authenticated user to call this function.
-- Application layer enforces wrh_receive_edit permission before the call.
GRANT EXECUTE ON FUNCTION update_pending_goods_receipt(uuid, text, text, text, date, text, jsonb)
  TO authenticated;
