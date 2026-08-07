-- ============================================================
-- Migration 004 — Real post_goods_receipt() RPC function
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: CREATE OR REPLACE is safe to re-run.
-- Depends on: 001_warehouse_phase1.sql, 003_receiving_scan_part_number.sql
-- ============================================================
--
-- Replaces the client-side direct status update in WarehouseHistory.tsx.
-- Atomically validates, creates inventory_assets (SERIALIZED items),
-- writes stock_movements, upserts stock_balances, then marks the receipt POSTED.
-- All work happens in a single transaction — any validation failure rolls back
-- every write performed so far in the call.
--
-- SECURITY INVOKER: runs as the calling authenticated user so RLS policies
-- (FOR ALL TO authenticated USING (true)) continue to apply normally.
--
-- Double-post protection: FOR UPDATE lock on goods_receipts ensures a second
-- concurrent call sees the already-POSTED status and raises before doing any work.

CREATE OR REPLACE FUNCTION post_goods_receipt(
  p_receipt_id   uuid,
  p_performed_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_receipt          goods_receipts%ROWTYPE;
  v_item             record;
  v_scan             record;
  v_asset_id         uuid;
  v_scan_count       integer;
  v_dup_sn           text;
  v_existing_sn      text;
  v_assets_created   integer := 0;
  v_movements_created integer := 0;
BEGIN
  -- ── 1. Lock receipt row (double-post protection) ───────────────────────────
  SELECT * INTO v_receipt
  FROM goods_receipts
  WHERE id = p_receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found: %', p_receipt_id;
  END IF;

  IF v_receipt.status != 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'Receipt % is not in PENDING_REVIEW status (current: %)',
      v_receipt.receipt_number, v_receipt.status;
  END IF;

  -- warehouse_id is NOT NULL at schema level, but validate explicitly for clarity
  IF v_receipt.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Receipt % has no warehouse assigned', v_receipt.receipt_number;
  END IF;

  -- ── 2. Must have at least one line item ────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM goods_receipt_items WHERE goods_receipt_id = p_receipt_id
  ) THEN
    RAISE EXCEPTION 'Receipt % has no line items', v_receipt.receipt_number;
  END IF;

  -- ── 3. No intra-receipt duplicate serial numbers ───────────────────────────
  SELECT UPPER(TRIM(serial_number)) INTO v_dup_sn
  FROM receiving_scan_log
  WHERE goods_receipt_id = p_receipt_id
  GROUP BY UPPER(TRIM(serial_number))
  HAVING count(*) > 1
  LIMIT 1;

  IF v_dup_sn IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate serial number within receipt: %', v_dup_sn;
  END IF;

  -- ── 4. No serial numbers already present in inventory_assets ──────────────
  SELECT rsl.serial_number INTO v_existing_sn
  FROM receiving_scan_log rsl
  WHERE rsl.goods_receipt_id = p_receipt_id
    AND EXISTS (
      SELECT 1 FROM inventory_assets ia
      WHERE ia.serial_number_normalized = UPPER(TRIM(rsl.serial_number))
    )
  LIMIT 1;

  IF v_existing_sn IS NOT NULL THEN
    RAISE EXCEPTION 'Serial number already in inventory: %', v_existing_sn;
  END IF;

  -- ── 5. Process each line item ──────────────────────────────────────────────
  FOR v_item IN
    SELECT
      gri.inventory_item_id,
      gri.quantity,
      ii.tracking_method,
      ii.is_active,
      ii.item_code
    FROM goods_receipt_items gri
    JOIN inventory_items ii ON ii.id = gri.inventory_item_id
    WHERE gri.goods_receipt_id = p_receipt_id
  LOOP
    IF NOT v_item.is_active THEN
      RAISE EXCEPTION 'Item % is not active', v_item.item_code;
    END IF;

    IF v_item.quantity <= 0 THEN
      RAISE EXCEPTION 'Item % has quantity <= 0', v_item.item_code;
    END IF;

    IF v_item.tracking_method = 'SERIALIZED' THEN
      -- ── Validate scan count matches declared quantity ─────────────────────
      SELECT count(*) INTO v_scan_count
      FROM receiving_scan_log
      WHERE goods_receipt_id    = p_receipt_id
        AND inventory_item_id   = v_item.inventory_item_id;

      IF v_scan_count != v_item.quantity THEN
        RAISE EXCEPTION 'Item % scan count (%) does not match line item quantity (%)',
          v_item.item_code, v_scan_count, v_item.quantity;
      END IF;

      -- ── One inventory_asset row per scan log entry ────────────────────────
      -- part_number is taken ONLY from receiving_scan_log.part_number.
      -- NULL is stored as-is — we never inherit another unit's PN from
      -- goods_receipt_items because one line item may cover units with
      -- different PNs (e.g. PN-A / PN-B / PN-C for the same item type).
      FOR v_scan IN
        SELECT *
        FROM receiving_scan_log
        WHERE goods_receipt_id  = p_receipt_id
          AND inventory_item_id = v_item.inventory_item_id
      LOOP
        INSERT INTO inventory_assets (
          inventory_item_id,
          serial_number,
          part_number,
          warehouse_id,
          status,
          source_receipt_id,
          raw_scan_value,
          barcode_symbology
        ) VALUES (
          v_item.inventory_item_id,
          v_scan.serial_number,
          v_scan.part_number,
          v_receipt.warehouse_id,
          'IN_STOCK',
          p_receipt_id,
          v_scan.raw_scan_value,
          v_scan.barcode_symbology
        )
        RETURNING id INTO v_asset_id;

        INSERT INTO stock_movements (
          warehouse_id,
          inventory_item_id,
          asset_id,
          movement_type,
          quantity,
          reference_type,
          reference_id,
          performed_by,
          movement_date
        ) VALUES (
          v_receipt.warehouse_id,
          v_item.inventory_item_id,
          v_asset_id,
          'RECEIVE',
          1,
          'GOODS_RECEIPT',
          p_receipt_id,
          p_performed_by,
          v_receipt.receipt_date
        );

        v_assets_created    := v_assets_created + 1;
        v_movements_created := v_movements_created + 1;
      END LOOP;

      -- ── UPSERT stock_balances += scan count ───────────────────────────────
      INSERT INTO stock_balances (warehouse_id, inventory_item_id, quantity_on_hand, quantity_reserved)
      VALUES (v_receipt.warehouse_id, v_item.inventory_item_id, v_scan_count, 0)
      ON CONFLICT (warehouse_id, inventory_item_id) DO UPDATE
        SET quantity_on_hand = stock_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
            updated_at       = now();

    ELSE
      -- ── QUANTITY tracking: one movement row, no asset rows ────────────────
      INSERT INTO stock_movements (
        warehouse_id,
        inventory_item_id,
        asset_id,
        movement_type,
        quantity,
        reference_type,
        reference_id,
        performed_by,
        movement_date
      ) VALUES (
        v_receipt.warehouse_id,
        v_item.inventory_item_id,
        NULL,
        'RECEIVE',
        v_item.quantity,
        'GOODS_RECEIPT',
        p_receipt_id,
        p_performed_by,
        v_receipt.receipt_date
      );

      v_movements_created := v_movements_created + 1;

      -- ── UPSERT stock_balances += line item quantity ───────────────────────
      INSERT INTO stock_balances (warehouse_id, inventory_item_id, quantity_on_hand, quantity_reserved)
      VALUES (v_receipt.warehouse_id, v_item.inventory_item_id, v_item.quantity, 0)
      ON CONFLICT (warehouse_id, inventory_item_id) DO UPDATE
        SET quantity_on_hand = stock_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
            updated_at       = now();
    END IF;
  END LOOP;

  -- ── 6. Mark receipt as POSTED (last step — only reached on full success) ───
  UPDATE goods_receipts
  SET status    = 'POSTED',
      posted_at = now()
  WHERE id = p_receipt_id;

  RETURN jsonb_build_object(
    'success',           true,
    'receipt_number',    v_receipt.receipt_number,
    'assets_created',    v_assets_created,
    'movements_created', v_movements_created
  );
END;
$$;

-- Allow any authenticated user to call this function.
-- Application layer enforces wrh_receive_post permission before the call.
GRANT EXECUTE ON FUNCTION post_goods_receipt(uuid, text) TO authenticated;
