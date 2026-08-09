-- ============================================================
-- Migration 007 — update_pending_goods_receipt() v2
-- Extends the RPC to handle QUANTITY-tracked items alongside
-- SERIALIZED scan entries.
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: CREATE OR REPLACE + DROP IF EXISTS are safe to re-run.
-- Depends on: 006_edit_pending_receipt_rpc.sql
-- DO NOT EXECUTE this file until confirmed by the team.
-- ============================================================
--
-- p_quantity_entries: [{inventory_item_id, quantity}]
--   QUANTITY-tracked items have no serial numbers and no scan_log rows.
--   Their quantities are stated explicitly by the UI and stored directly
--   in goods_receipt_items.
--
-- Defaults to [] so old callers that omit it remain compatible
-- (though the old 7-param signature is dropped below).
--
-- Validation:
--   - Each quantity entry: item must exist with tracking_method = 'QUANTITY'.
--   - quantity must be > 0.
--   - No duplicate inventory_item_id within p_quantity_entries.
--
-- goods_receipt_items is rebuilt from:
--   1. SERIALIZED entries: grouped from p_scan_entries by inventory_item_id.
--   2. QUANTITY entries: direct inserts from p_quantity_entries.

CREATE OR REPLACE FUNCTION update_pending_goods_receipt(
  p_receipt_id            uuid,
  p_supplier_name         text,
  p_delivery_note_number  text,
  p_purchase_order_number text,
  p_receipt_date          date,
  p_notes                 text,
  p_scan_entries          jsonb,
  -- [{inventory_item_id, serial_number, part_number, raw_scan_value,
  --   barcode_symbology, scanned_manually}]
  p_quantity_entries      jsonb DEFAULT '[]'::jsonb
  -- [{inventory_item_id, quantity}]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_receipt       goods_receipts%ROWTYPE;
  v_old_count     integer;
  v_new_count     integer;
  v_dup_sn        text;
  v_existing_sn   text;
  v_dup_qty_item  text;
  v_bad_qty_item  text;
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
  -- guards against SNs genuinely IN_STOCK/ISSUED/etc from other receipts.
  SELECT ia.serial_number_normalized INTO v_existing_sn
  FROM jsonb_array_elements(p_scan_entries) AS e
  JOIN inventory_assets ia
    ON ia.serial_number_normalized = UPPER(TRIM(e->>'serial_number'))
  WHERE (e->>'serial_number') IS NOT NULL
  LIMIT 1;

  IF v_existing_sn IS NOT NULL THEN
    RAISE EXCEPTION 'Serial number already in inventory: %', v_existing_sn;
  END IF;

  -- ── 5. Validate p_quantity_entries ────────────────────────────────────────
  -- 5a. No duplicate inventory_item_id within quantity entries
  SELECT (e->>'inventory_item_id') INTO v_dup_qty_item
  FROM jsonb_array_elements(p_quantity_entries) AS e
  GROUP BY (e->>'inventory_item_id')
  HAVING count(*) > 1
  LIMIT 1;

  IF v_dup_qty_item IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate inventory_item_id in quantity entries: %', v_dup_qty_item;
  END IF;

  -- 5b. Each item must exist with tracking_method = 'QUANTITY' and quantity > 0
  SELECT (e->>'inventory_item_id') INTO v_bad_qty_item
  FROM jsonb_array_elements(p_quantity_entries) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_items ii
    WHERE ii.id = (e->>'inventory_item_id')::uuid
      AND ii.tracking_method = 'QUANTITY'
  )
     OR COALESCE((e->>'quantity')::integer, 0) <= 0
  LIMIT 1;

  IF v_bad_qty_item IS NOT NULL THEN
    RAISE EXCEPTION
      'Invalid quantity entry — item not found, wrong tracking method, or quantity ≤ 0: %',
      v_bad_qty_item;
  END IF;

  -- ── 6. Replace scan log atomically ───────────────────────────────────────
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

  -- ── 7. Replace line items ─────────────────────────────────────────────────
  DELETE FROM goods_receipt_items WHERE goods_receipt_id = p_receipt_id;

  -- SERIALIZED items: counted from p_scan_entries, grouped by inventory_item_id.
  -- PN policy: all-same-non-null → store it; any mismatch or null → NULL.
  INSERT INTO goods_receipt_items (goods_receipt_id, inventory_item_id, quantity, part_number)
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

  -- QUANTITY items: direct from p_quantity_entries with stated quantities.
  INSERT INTO goods_receipt_items (goods_receipt_id, inventory_item_id, quantity, part_number)
  SELECT
    p_receipt_id,
    (e->>'inventory_item_id')::uuid,
    (e->>'quantity')::integer,
    NULL
  FROM jsonb_array_elements(p_quantity_entries) AS e
  WHERE (e->>'inventory_item_id') IS NOT NULL;

  -- ── 8. Update header fields ───────────────────────────────────────────────
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

-- Drop the old 7-parameter signature from migration 006 — it is fully replaced
-- by the 8-parameter version above (the DEFAULT on p_quantity_entries means
-- existing callers that pass 7 named args still work via PostgREST routing).
DROP FUNCTION IF EXISTS update_pending_goods_receipt(uuid, text, text, text, date, text, jsonb);

-- Grant execute on the new 8-parameter signature.
GRANT EXECUTE ON FUNCTION update_pending_goods_receipt(uuid, text, text, text, date, text, jsonb, jsonb)
  TO authenticated;
