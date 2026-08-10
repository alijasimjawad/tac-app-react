-- Migration 009 — Goods Issue tables + RPC
-- DO NOT execute until Stage E (migration 008) has been applied and verified.
--
-- Tables:   goods_issues, goods_issue_items, goods_issue_assets
-- Sequence: goods_issue_seq  (separate from goods_receipt_seq)
-- RPC:      post_goods_issue(p_issue_id uuid, p_performed_by text)

BEGIN;

-- ── Sequence ──────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS goods_issue_seq START WITH 1;

-- ── goods_issues ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goods_issues (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number     text        UNIQUE NOT NULL
                               DEFAULT 'GI-' || TO_CHAR(NOW(), 'YYYYMM')
                                             || '-' || LPAD(nextval('goods_issue_seq')::text, 5, '0'),
  warehouse_id     uuid        NOT NULL REFERENCES warehouses(id),
  project_id       uuid        NOT NULL REFERENCES projects(id),
  issue_date       date        NOT NULL,
  destination_type text        NOT NULL
                               CHECK (destination_type IN ('SITE','TEAM_MEMBER','USER','VEHICLE','EXTERNAL','OTHER')),
  destination_id   text,                         -- NULL for VEHICLE / EXTERNAL / OTHER
  destination_label text       NOT NULL,         -- snapshot of destination name
  notes            text,
  status           text        NOT NULL DEFAULT 'DRAFT'
                               CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  issued_by        text        NOT NULL,
  posted_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_goods_issues_updated_at
  BEFORE UPDATE ON goods_issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── goods_issue_items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goods_issue_items (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_issue_id    uuid        NOT NULL REFERENCES goods_issues(id) ON DELETE CASCADE,
  inventory_item_id uuid        NOT NULL REFERENCES inventory_items(id),
  quantity          integer     NOT NULL CHECK (quantity > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goods_issue_id, inventory_item_id)
);

-- ── goods_issue_assets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goods_issue_assets (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_issue_id       uuid        NOT NULL REFERENCES goods_issues(id) ON DELETE CASCADE,
  goods_issue_item_id  uuid        NOT NULL REFERENCES goods_issue_items(id) ON DELETE CASCADE,
  inventory_asset_id   uuid        NOT NULL REFERENCES inventory_assets(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goods_issue_id, inventory_asset_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_goods_issues_warehouse ON goods_issues(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_goods_issues_project   ON goods_issues(project_id);
CREATE INDEX IF NOT EXISTS idx_goods_issues_status    ON goods_issues(status);
CREATE INDEX IF NOT EXISTS idx_goods_issues_date      ON goods_issues(issue_date DESC);

CREATE INDEX IF NOT EXISTS idx_gi_items_issue         ON goods_issue_items(goods_issue_id);
CREATE INDEX IF NOT EXISTS idx_gi_items_item          ON goods_issue_items(inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_gi_assets_issue        ON goods_issue_assets(goods_issue_id);
CREATE INDEX IF NOT EXISTS idx_gi_assets_item         ON goods_issue_assets(goods_issue_item_id);
CREATE INDEX IF NOT EXISTS idx_gi_assets_asset        ON goods_issue_assets(inventory_asset_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE goods_issues       ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_issue_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_issue_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_goods_issues_all
  ON goods_issues FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY rls_goods_issue_items_all
  ON goods_issue_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY rls_goods_issue_assets_all
  ON goods_issue_assets FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── post_goods_issue RPC ──────────────────────────────────────────────────────
--
-- Atomically posts a DRAFT goods issue:
--   1. Locks goods_issues row (double-post guard)
--   2. Validates warehouse + project are active
--   3. Enforces SERIALIZED asset count == goods_issue_items.quantity
--   4. Validates each SERIALIZED asset is IN_STOCK in correct warehouse+project
--   5. Updates inventory_assets status → ISSUED
--   6. Inserts stock_movements (quantity = –1 per asset or –qty for QUANTITY)
--   7. Decrements stock_balances.quantity_on_hand
--   8. Sets goods_issues.status = POSTED
--
-- Items are processed in ORDER BY inventory_item_id to prevent deadlocks
-- when multiple concurrent issues run.
--
CREATE OR REPLACE FUNCTION post_goods_issue(
  p_issue_id     uuid,
  p_performed_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_issue         goods_issues%ROWTYPE;
  v_warehouse     warehouses%ROWTYPE;
  v_project       projects%ROWTYPE;
  v_item          goods_issue_items%ROWTYPE;
  v_asset_id      uuid;
  v_asset_row     inventory_assets%ROWTYPE;
  v_balance       stock_balances%ROWTYPE;
  v_available     integer;
  v_asset_count   integer;
  v_is_serialized boolean;
  v_assets_issued integer := 0;
  v_qty_lines     integer := 0;
BEGIN
  -- 1. Lock the goods_issues row (prevents double-post)
  SELECT * INTO v_issue
    FROM goods_issues
   WHERE id = p_issue_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods issue % not found', p_issue_id;
  END IF;

  -- 2. Status must be DRAFT
  IF v_issue.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Goods issue % is already % — cannot post',
      v_issue.issue_number, v_issue.status;
  END IF;

  -- 3. Validate warehouse is active
  SELECT * INTO v_warehouse FROM warehouses WHERE id = v_issue.warehouse_id;
  IF NOT FOUND OR NOT v_warehouse.is_active THEN
    RAISE EXCEPTION 'Warehouse is not active';
  END IF;

  -- 4. Validate project is active
  SELECT * INTO v_project FROM projects WHERE id = v_issue.project_id;
  IF NOT FOUND OR NOT v_project.is_active THEN
    RAISE EXCEPTION 'Project is not active';
  END IF;

  -- 5. Must have at least one line item
  IF NOT EXISTS (SELECT 1 FROM goods_issue_items WHERE goods_issue_id = p_issue_id) THEN
    RAISE EXCEPTION 'Goods issue % has no line items', v_issue.issue_number;
  END IF;

  -- 6. Process each line item (ORDER BY prevents deadlocks on concurrent issues)
  FOR v_item IN
    SELECT * FROM goods_issue_items
     WHERE goods_issue_id = p_issue_id
     ORDER BY inventory_item_id
  LOOP
    -- Determine tracking method
    SELECT tracking_method = 'SERIALIZED'
      INTO v_is_serialized
      FROM inventory_items
     WHERE id = v_item.inventory_item_id;

    -- Lock stock balance row
    SELECT * INTO v_balance
      FROM stock_balances
     WHERE warehouse_id      = v_issue.warehouse_id
       AND project_id        = v_issue.project_id
       AND inventory_item_id = v_item.inventory_item_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No stock balance for item % in this warehouse / project',
        v_item.inventory_item_id;
    END IF;

    IF v_is_serialized THEN
      -- ── SERIALIZED ──────────────────────────────────────────────────────────
      -- Enforce: asset count must equal quantity
      SELECT COUNT(*) INTO v_asset_count
        FROM goods_issue_assets
       WHERE goods_issue_item_id = v_item.id;

      IF v_asset_count <> v_item.quantity THEN
        RAISE EXCEPTION 'SERIALIZED item %: expected % asset(s), found %',
          v_item.inventory_item_id, v_item.quantity, v_asset_count;
      END IF;

      v_available := GREATEST(0, v_balance.quantity_on_hand - v_balance.quantity_reserved);
      IF v_item.quantity > v_available THEN
        RAISE EXCEPTION 'Insufficient available stock for SERIALIZED item %: requested %, available %',
          v_item.inventory_item_id, v_item.quantity, v_available;
      END IF;

      -- Process each asset (ORDER BY for inner lock ordering)
      FOR v_asset_id IN
        SELECT inventory_asset_id
          FROM goods_issue_assets
         WHERE goods_issue_item_id = v_item.id
         ORDER BY inventory_asset_id
      LOOP
        SELECT * INTO v_asset_row
          FROM inventory_assets
         WHERE id = v_asset_id
           FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Asset % not found', v_asset_id;
        END IF;

        IF v_asset_row.inventory_item_id <> v_item.inventory_item_id THEN
          RAISE EXCEPTION 'Asset % (SN: %) belongs to item %, expected %',
            v_asset_id, v_asset_row.serial_number,
            v_asset_row.inventory_item_id, v_item.inventory_item_id;
        END IF;

        IF v_asset_row.status <> 'IN_STOCK' THEN
          RAISE EXCEPTION 'Asset % (SN: %) status is %, not IN_STOCK',
            v_asset_id, v_asset_row.serial_number, v_asset_row.status;
        END IF;

        IF v_asset_row.warehouse_id <> v_issue.warehouse_id THEN
          RAISE EXCEPTION 'Asset % is in a different warehouse', v_asset_id;
        END IF;

        IF v_asset_row.project_id <> v_issue.project_id THEN
          RAISE EXCEPTION 'Asset % belongs to a different project', v_asset_id;
        END IF;

        -- Mark as ISSUED
        UPDATE inventory_assets
           SET status     = 'ISSUED',
               updated_at = now()
         WHERE id = v_asset_id;

        -- Insert outbound movement (quantity = -1 per asset)
        INSERT INTO stock_movements (
          warehouse_id, inventory_item_id, asset_id, project_id,
          movement_type, quantity, reference_type, reference_id,
          performed_by, movement_date, notes
        ) VALUES (
          v_issue.warehouse_id, v_item.inventory_item_id, v_asset_id, v_issue.project_id,
          'ISSUE', -1, 'GOODS_ISSUE', p_issue_id,
          p_performed_by, v_issue.issue_date, v_issue.notes
        );

        v_assets_issued := v_assets_issued + 1;
      END LOOP;

      -- Decrement on-hand
      UPDATE stock_balances
         SET quantity_on_hand = quantity_on_hand - v_item.quantity,
             updated_at       = now()
       WHERE id = v_balance.id;

    ELSE
      -- ── QUANTITY ─────────────────────────────────────────────────────────────
      v_available := GREATEST(0, v_balance.quantity_on_hand - v_balance.quantity_reserved);

      IF v_item.quantity > v_available THEN
        RAISE EXCEPTION 'Insufficient available stock for item %: requested %, available %',
          v_item.inventory_item_id, v_item.quantity, v_available;
      END IF;

      -- Insert outbound movement
      INSERT INTO stock_movements (
        warehouse_id, inventory_item_id, asset_id, project_id,
        movement_type, quantity, reference_type, reference_id,
        performed_by, movement_date, notes
      ) VALUES (
        v_issue.warehouse_id, v_item.inventory_item_id, NULL, v_issue.project_id,
        'ISSUE', -v_item.quantity, 'GOODS_ISSUE', p_issue_id,
        p_performed_by, v_issue.issue_date, v_issue.notes
      );

      -- Decrement on-hand
      UPDATE stock_balances
         SET quantity_on_hand = quantity_on_hand - v_item.quantity,
             updated_at       = now()
       WHERE id = v_balance.id;

      v_qty_lines := v_qty_lines + 1;
    END IF;
  END LOOP;

  -- 7. Mark issue as POSTED
  UPDATE goods_issues
     SET status     = 'POSTED',
         posted_at  = now(),
         updated_at = now()
   WHERE id = p_issue_id;

  RETURN jsonb_build_object(
    'issue_number',   v_issue.issue_number,
    'assets_issued',  v_assets_issued,
    'quantity_lines', v_qty_lines
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION post_goods_issue(uuid, text) TO authenticated;

COMMIT;
