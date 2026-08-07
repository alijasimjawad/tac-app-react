-- ============================================================
-- Migration 001 — Warehouse & Inventory Phase 1 (rev 2)
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to run on a fresh schema or re-run.
-- Does NOT modify any existing TAC tables.
-- ============================================================

-- ── Shared updated_at trigger ─────────────────────────────────────────────────
-- CREATE OR REPLACE is safe if the function already exists in another module.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── warehouses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        UNIQUE NOT NULL,
  name        text        NOT NULL,
  location    text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_warehouses_updated_at
  BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── inventory_items (Item Master) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code        text    UNIQUE NOT NULL,
  item_name        text    NOT NULL,
  item_type        text,
  manufacturer     text,
  part_number      text,
  category         text,
  tracking_method  text    NOT NULL DEFAULT 'SERIALIZED'
                           CHECK (tracking_method IN ('SERIALIZED','QUANTITY')),
  unit             text    NOT NULL DEFAULT 'pcs',
  is_active        boolean NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_inventory_items_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_inventory_items_code      ON inventory_items(item_code);
CREATE INDEX IF NOT EXISTS idx_inventory_items_part_no   ON inventory_items(part_number);
CREATE INDEX IF NOT EXISTS idx_inventory_items_item_type ON inventory_items(item_type);

-- ── item_code_mappings ────────────────────────────────────────────────────────
-- Maps manufacturer/scanned codes → Item Master. Populated in Phase 2.
CREATE TABLE IF NOT EXISTS item_code_mappings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  manufacturer      text,
  code_type         text NOT NULL, -- 'PART_NUMBER' | 'ITEM_TYPE' | 'MANUFACTURER_CODE'
  external_code     text NOT NULL,
  parsing_profile   text,          -- 'generic' | 'nokia' | 'huawei' | 'ericsson'
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_type, external_code)
);

CREATE INDEX IF NOT EXISTS idx_item_mappings_code ON item_code_mappings(external_code);

-- ── goods_receipts ────────────────────────────────────────────────────────────
-- receipt_number is generated server-side from a global sequence.
-- Format: GR-YYYYMM-NNNNN  (e.g. GR-202608-00001)
-- The sequence is global (not per-month) so numbers are always unique even
-- across month boundaries and under concurrent inserts.
-- received_by stores users.id (text) — see User Reference note at bottom.

CREATE SEQUENCE IF NOT EXISTS goods_receipt_seq START WITH 1;

CREATE TABLE IF NOT EXISTS goods_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number        text UNIQUE NOT NULL
                             DEFAULT 'GR-' || TO_CHAR(NOW(), 'YYYYMM')
                                          || '-' || LPAD(nextval('goods_receipt_seq')::text, 5, '0'),
  warehouse_id          uuid NOT NULL REFERENCES warehouses(id),
  supplier_name         text,
  delivery_note_number  text,
  purchase_order_number text,
  receipt_date          date NOT NULL,
  status                text NOT NULL DEFAULT 'DRAFT'
                             CHECK (status IN ('DRAFT','PENDING_REVIEW','POSTED','CANCELLED')),
  notes                 text,
  received_by           text NOT NULL, -- users.id stored as text; no FK (see User Reference note)
  posted_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_goods_receipts_updated_at
  BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_goods_receipts_warehouse  ON goods_receipts(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_date       ON goods_receipts(receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_status     ON goods_receipts(status);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_created_at ON goods_receipts(created_at DESC);

-- ── goods_receipt_items ───────────────────────────────────────────────────────
-- One row per inventory_item type in a receipt. quantity = number of units.
CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id  uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity          integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  part_number       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gri_receipt ON goods_receipt_items(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_gri_item    ON goods_receipt_items(inventory_item_id);

-- ── inventory_assets ─────────────────────────────────────────────────────────
-- One row per physical serialized device. Only SERIALIZED items have assets.
-- serial_number_normalized is enforced at DB level via trigger below.
CREATE TABLE IF NOT EXISTS inventory_assets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id        uuid NOT NULL REFERENCES inventory_items(id),
  serial_number            text NOT NULL,
  serial_number_normalized text NOT NULL, -- always UPPER(TRIM(serial_number)) — set by trigger
  part_number              text,
  warehouse_id             uuid REFERENCES warehouses(id),
  status                   text NOT NULL DEFAULT 'IN_STOCK'
                                CHECK (status IN (
                                  'IN_STOCK','RESERVED','ISSUED',
                                  'INSTALLED','RETURNED','DAMAGED','SCRAPPED'
                                )),
  source_receipt_id        uuid REFERENCES goods_receipts(id),
  raw_scan_value           text,
  barcode_symbology        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (serial_number_normalized)
);

-- DB-level normalization: serial_number_normalized is always UPPER(TRIM(serial_number)).
-- This fires before INSERT and before UPDATE, overwriting whatever the caller provides.
CREATE OR REPLACE FUNCTION normalize_asset_serial()
RETURNS TRIGGER AS $$
BEGIN
  NEW.serial_number_normalized := UPPER(TRIM(NEW.serial_number));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_assets_normalize_sn
  BEFORE INSERT OR UPDATE ON inventory_assets
  FOR EACH ROW EXECUTE FUNCTION normalize_asset_serial();

CREATE OR REPLACE TRIGGER trg_inventory_assets_updated_at
  BEFORE UPDATE ON inventory_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_assets_sn_normalized ON inventory_assets(serial_number_normalized);
CREATE INDEX IF NOT EXISTS idx_assets_item           ON inventory_assets(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_assets_warehouse      ON inventory_assets(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_assets_status         ON inventory_assets(status);

-- ── stock_balances ────────────────────────────────────────────────────────────
-- Current quantity counts per warehouse per item. Updated by Phase 3 posting.
-- quantity_on_hand >= 0: stock cannot go negative (enforced by constraint).
-- Phase 3 posting logic must verify available quantity before issuing.
CREATE TABLE IF NOT EXISTS stock_balances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity_on_hand  integer NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved integer NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, inventory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_balances_warehouse ON stock_balances(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_balances_item      ON stock_balances(inventory_item_id);

-- ── stock_movements ───────────────────────────────────────────────────────────
-- Append-only audit trail. No updated_at — rows are never modified after insert.
-- Canonical movement_type values (enforced by Phase 3 application logic):
--   RECEIVE | ISSUE | TRANSFER_IN | TRANSFER_OUT | RETURN | ADJUSTMENT | DAMAGE | SCRAP
-- performed_by stores users.id as text; see User Reference note below.
CREATE TABLE IF NOT EXISTS stock_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  asset_id          uuid REFERENCES inventory_assets(id),
  movement_type     text NOT NULL,
  quantity          integer NOT NULL,         -- positive for IN, negative for OUT
  reference_type    text,                     -- 'GOODS_RECEIPT' | 'ISSUE_ORDER' | 'TRANSFER' | etc.
  reference_id      uuid,
  performed_by      text NOT NULL,            -- users.id stored as text
  movement_date     date NOT NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movements_warehouse ON stock_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_movements_item      ON stock_movements(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_movements_date      ON stock_movements(movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_movements_type      ON stock_movements(movement_type);

-- ── receiving_scan_sessions ───────────────────────────────────────────────────
-- One row per receipt save from the WarehouseReceive wizard.
-- Stores who scanned and aggregate scan counts for reporting.
-- Columns match exactly what WarehouseReceive.tsx inserts at save time.
CREATE TABLE IF NOT EXISTS receiving_scan_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  operator_id      text,           -- users.id of the scanner (text, see User Reference note)
  total_scans      integer NOT NULL DEFAULT 0,
  valid_scans      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_sessions_receipt ON receiving_scan_sessions(goods_receipt_id);

-- ── receiving_scan_log ────────────────────────────────────────────────────────
-- Permanent per-item scan record. One row per valid scan submitted with a receipt.
-- Provides full audit of which serial numbers arrived on which receipt.
-- Columns match exactly what WarehouseReceive.tsx inserts into this table.
CREATE TABLE IF NOT EXISTS receiving_scan_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id  uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES inventory_items(id),
  serial_number     text NOT NULL,
  raw_scan_value    text NOT NULL,
  barcode_symbology text,
  scanned_manually  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_log_receipt ON receiving_scan_log(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_scan_log_sn      ON receiving_scan_log(serial_number);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- All warehouse tables: any authenticated session may read and write.
-- Fine-grained access control is enforced at the application layer via hasPerm().
--
-- WARNING: This means any authenticated user can DELETE any warehouse row at
-- the database level, bypassing hasPerm(). This is consistent with existing
-- TAC tables (cars, saved_points, app_settings — all use FOR ALL USING (true)).
-- Acceptable for the current single-tenant deployment model. Review before any
-- external API exposure or multi-tenant expansion.

ALTER TABLE warehouses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_code_mappings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_assets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements         ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_scan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_scan_log      ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='warehouses'
      AND policyname='wrh_authenticated_all') THEN
    CREATE POLICY wrh_authenticated_all ON warehouses
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventory_items'
      AND policyname='wrh_items_authenticated_all') THEN
    CREATE POLICY wrh_items_authenticated_all ON inventory_items
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='item_code_mappings'
      AND policyname='wrh_mappings_authenticated_all') THEN
    CREATE POLICY wrh_mappings_authenticated_all ON item_code_mappings
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='goods_receipts'
      AND policyname='wrh_receipts_authenticated_all') THEN
    CREATE POLICY wrh_receipts_authenticated_all ON goods_receipts
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='goods_receipt_items'
      AND policyname='wrh_receipt_items_authenticated_all') THEN
    CREATE POLICY wrh_receipt_items_authenticated_all ON goods_receipt_items
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventory_assets'
      AND policyname='wrh_assets_authenticated_all') THEN
    CREATE POLICY wrh_assets_authenticated_all ON inventory_assets
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock_balances'
      AND policyname='wrh_balances_authenticated_all') THEN
    CREATE POLICY wrh_balances_authenticated_all ON stock_balances
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock_movements'
      AND policyname='wrh_movements_authenticated_all') THEN
    CREATE POLICY wrh_movements_authenticated_all ON stock_movements
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='receiving_scan_sessions'
      AND policyname='wrh_sessions_authenticated_all') THEN
    CREATE POLICY wrh_sessions_authenticated_all ON receiving_scan_sessions
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='receiving_scan_log'
      AND policyname='wrh_scan_log_authenticated_all') THEN
    CREATE POLICY wrh_scan_log_authenticated_all ON receiving_scan_log
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Seed data ─────────────────────────────────────────────────────────────────
INSERT INTO warehouses (code, name, location)
VALUES
  ('HILLA',   'Hilla Warehouse',   'Hilla, Babylon Province'),
  ('BAGHDAD', 'Baghdad Warehouse', 'Baghdad')
ON CONFLICT (code) DO NOTHING;

-- Seed Item Master: category values match the frontend CATEGORIES dropdown.
-- 'Radio' not 'Radio Equipment' — matches the exact values the filter expects.
INSERT INTO inventory_items (item_code, item_name, item_type, manufacturer, tracking_method, category)
VALUES
  ('ABIO', 'ABIO Radio Unit', 'ABIO', 'Nokia', 'SERIALIZED', 'Radio'),
  ('FXDA', 'FXDA Radio Unit', 'FXDA', 'Nokia', 'SERIALIZED', 'Radio'),
  ('FXEA', 'FXEA Radio Unit', 'FXEA', 'Nokia', 'SERIALIZED', 'Radio')
ON CONFLICT (item_code) DO NOTHING;

-- ── User Reference Note ───────────────────────────────────────────────────────
-- received_by (goods_receipts), performed_by (stock_movements), and
-- operator_id (receiving_scan_sessions) all store public.users.id as text.
--
-- Why text, not uuid FK:
--   1. Consistent with existing TAC text-user-reference columns.
--   2. Not all users have a team_members row (admin accounts have users row only).
--   3. Phase 3 can add a proper FK migration once the reference table is confirmed.
--
-- Canonical reference: public.users.id (the app-level PK, NOT auth.uid()).
-- Frontend resolves display names by querying public.users where id IN (perfIds).
-- Do NOT join to team_members for these columns.
