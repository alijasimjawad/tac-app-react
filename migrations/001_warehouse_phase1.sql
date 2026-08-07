-- ============================================================
-- Migration 001 — Warehouse & Inventory Phase 1
-- Apply via: Supabase SQL Editor (copy and run the whole file)
-- ============================================================

-- ── Shared updated_at trigger ─────────────────────────────────────────────────
-- Safe to run even if the function already exists from another module.
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
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code        text UNIQUE NOT NULL,
  item_name        text NOT NULL,
  item_type        text,
  manufacturer     text,
  part_number      text,
  category         text,
  tracking_method  text NOT NULL DEFAULT 'SERIALIZED'
                        CHECK (tracking_method IN ('SERIALIZED','QUANTITY')),
  unit             text NOT NULL DEFAULT 'pcs',
  is_active        boolean NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_inventory_items_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_inventory_items_code       ON inventory_items(item_code);
CREATE INDEX IF NOT EXISTS idx_inventory_items_part_no    ON inventory_items(part_number);
CREATE INDEX IF NOT EXISTS idx_inventory_items_item_type  ON inventory_items(item_type);

-- ── item_code_mappings ────────────────────────────────────────────────────────
-- Maps scanned codes (PN / manufacturer codes) to Item Master records.
-- This allows the scanner to auto-resolve future scans.
CREATE TABLE IF NOT EXISTS item_code_mappings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  manufacturer        text,
  code_type           text NOT NULL, -- 'PART_NUMBER' | 'ITEM_TYPE' | 'MANUFACTURER_CODE'
  external_code       text NOT NULL,
  parsing_profile     text,          -- 'generic' | 'nokia' | 'huawei' | 'ericsson'
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_type, external_code)
);

CREATE INDEX IF NOT EXISTS idx_item_mappings_code ON item_code_mappings(external_code);

-- ── goods_receipts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goods_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number        text UNIQUE NOT NULL,
  warehouse_id          uuid NOT NULL REFERENCES warehouses(id),
  supplier_name         text,
  delivery_note_number  text,
  purchase_order_number text,
  receipt_date          date NOT NULL,
  status                text NOT NULL DEFAULT 'DRAFT'
                             CHECK (status IN ('DRAFT','PENDING_REVIEW','POSTED','CANCELLED')),
  notes                 text,
  received_by           text NOT NULL,
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

-- ── goods_receipt_items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id  uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity          integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  part_number       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_receipt ON goods_receipt_items(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_item    ON goods_receipt_items(inventory_item_id);

-- ── inventory_assets ─────────────────────────────────────────────────────────
-- One row per physical serialized device.
CREATE TABLE IF NOT EXISTS inventory_assets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id        uuid NOT NULL REFERENCES inventory_items(id),
  serial_number            text NOT NULL,
  serial_number_normalized text NOT NULL, -- UPPER(TRIM(serial_number)) — enforces uniqueness
  part_number              text,
  warehouse_id             uuid REFERENCES warehouses(id),
  status                   text NOT NULL DEFAULT 'IN_STOCK'
                                CHECK (status IN ('IN_STOCK','RESERVED','ISSUED','INSTALLED','RETURNED','DAMAGED','SCRAPPED')),
  source_receipt_id        uuid REFERENCES goods_receipts(id),
  raw_scan_value           text,
  barcode_symbology        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (serial_number_normalized)
);

CREATE OR REPLACE TRIGGER trg_inventory_assets_updated_at
  BEFORE UPDATE ON inventory_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_assets_sn_normalized ON inventory_assets(serial_number_normalized);
CREATE INDEX IF NOT EXISTS idx_assets_item           ON inventory_assets(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_assets_warehouse      ON inventory_assets(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_assets_status         ON inventory_assets(status);

-- ── stock_balances ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_balances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id),
  quantity_on_hand    integer NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved   integer NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, inventory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_balances_warehouse ON stock_balances(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_balances_item      ON stock_balances(inventory_item_id);

-- ── stock_movements ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id),
  asset_id            uuid REFERENCES inventory_assets(id),
  movement_type       text NOT NULL,
                      -- 'RECEIPT' | 'ISSUE' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'RETURN' | 'ADJUSTMENT'
  quantity            integer NOT NULL,
  reference_type      text,   -- 'GOODS_RECEIPT' | 'ISSUE_ORDER' | etc.
  reference_id        uuid,
  performed_by        text NOT NULL,
  movement_date       date NOT NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movements_warehouse ON stock_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_movements_item       ON stock_movements(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_movements_date       ON stock_movements(movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_movements_type       ON stock_movements(movement_type);

-- ── receiving_scan_sessions ───────────────────────────────────────────────────
-- Tracks a scanning session (may span multiple scans before confirmation).
CREATE TABLE IF NOT EXISTS receiving_scan_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid REFERENCES warehouses(id),
  status        text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','REVIEWING','POSTED','CANCELLED')),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_scan_sessions_updated_at
  BEFORE UPDATE ON receiving_scan_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── receiving_scan_entries ────────────────────────────────────────────────────
-- Each line scanned or manually entered in a session.
CREATE TABLE IF NOT EXISTS receiving_scan_entries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid NOT NULL REFERENCES receiving_scan_sessions(id) ON DELETE CASCADE,
  inventory_item_id        uuid REFERENCES inventory_items(id),
  item_type_raw            text,
  part_number_raw          text,
  serial_number_raw        text,
  serial_number_normalized text,
  raw_scan_value           text NOT NULL,
  symbology                text,
  validation_status        text NOT NULL DEFAULT 'PENDING'
                                CHECK (validation_status IN ('VALID','PENDING','DUPLICATE','ERROR')),
  validation_message       text,
  scanned_at               timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_entries_session ON receiving_scan_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_scan_entries_sn      ON receiving_scan_entries(serial_number_normalized);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- All tables: authenticated users can read and write.
-- Fine-grained access control is handled at application level via hasPerm().

ALTER TABLE warehouses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_code_mappings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_assets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements         ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_scan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_scan_entries  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- warehouses
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='warehouses' AND policyname='wrh_authenticated_all') THEN
    CREATE POLICY wrh_authenticated_all ON warehouses FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- inventory_items
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventory_items' AND policyname='wrh_items_authenticated_all') THEN
    CREATE POLICY wrh_items_authenticated_all ON inventory_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- item_code_mappings
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='item_code_mappings' AND policyname='wrh_mappings_authenticated_all') THEN
    CREATE POLICY wrh_mappings_authenticated_all ON item_code_mappings FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- goods_receipts
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='goods_receipts' AND policyname='wrh_receipts_authenticated_all') THEN
    CREATE POLICY wrh_receipts_authenticated_all ON goods_receipts FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- goods_receipt_items
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='goods_receipt_items' AND policyname='wrh_receipt_items_authenticated_all') THEN
    CREATE POLICY wrh_receipt_items_authenticated_all ON goods_receipt_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- inventory_assets
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventory_assets' AND policyname='wrh_assets_authenticated_all') THEN
    CREATE POLICY wrh_assets_authenticated_all ON inventory_assets FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- stock_balances
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock_balances' AND policyname='wrh_balances_authenticated_all') THEN
    CREATE POLICY wrh_balances_authenticated_all ON stock_balances FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- stock_movements
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock_movements' AND policyname='wrh_movements_authenticated_all') THEN
    CREATE POLICY wrh_movements_authenticated_all ON stock_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- receiving_scan_sessions
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='receiving_scan_sessions' AND policyname='wrh_sessions_authenticated_all') THEN
    CREATE POLICY wrh_sessions_authenticated_all ON receiving_scan_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  -- receiving_scan_entries
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='receiving_scan_entries' AND policyname='wrh_entries_authenticated_all') THEN
    CREATE POLICY wrh_entries_authenticated_all ON receiving_scan_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Seed data ─────────────────────────────────────────────────────────────────
INSERT INTO warehouses (code, name, location)
VALUES
  ('HILLA',   'Hilla Warehouse',   'Hilla, Babylon Province'),
  ('BAGHDAD', 'Baghdad Warehouse', 'Baghdad')
ON CONFLICT (code) DO NOTHING;

-- Example Item Master entries (common Nokia telecom device types)
INSERT INTO inventory_items (item_code, item_name, item_type, manufacturer, tracking_method, category)
VALUES
  ('ABIO',  'ABIO Radio Unit',  'ABIO',  'Nokia',  'SERIALIZED', 'Radio Equipment'),
  ('FXDA',  'FXDA Radio Unit',  'FXDA',  'Nokia',  'SERIALIZED', 'Radio Equipment'),
  ('FXEA',  'FXEA Radio Unit',  'FXEA',  'Nokia',  'SERIALIZED', 'Radio Equipment')
ON CONFLICT (item_code) DO NOTHING;
