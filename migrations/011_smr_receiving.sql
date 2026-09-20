-- ============================================================
-- Migration 011 — Customer SMR Receiving
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to run on a fresh schema or re-run.
-- Depends on: 001_warehouse_phase1.sql (warehouses, inventory_items,
--             goods_receipts, update_updated_at_column()), and the
--             pre-existing `projects` table (not created by this repo).
--
-- Purpose:
--   An SMR (Stock Requisition) is a PDF issued by a customer's warehouse
--   (e.g. Zain, form type "OUT") listing material being sent out to TAC.
--   On TAC's side this is an inbound goods receipt. This migration adds
--   the tables needed to: upload the SMR PDF, hold the auto-extracted /
--   user-reviewed line items, and record camera scans (SN capture) done
--   at the customer's warehouse during pickup, reconciled against the
--   SMR's expected line items. Finalizing an SMR produces a normal
--   PENDING_REVIEW goods_receipts row that flows through the existing
--   post_goods_receipt() pipeline unchanged — this migration does not
--   add any new stock-posting logic.
-- ============================================================

-- ── smr_documents ─────────────────────────────────────────────────────────────
-- One row per uploaded SMR PDF (header fields transcribed from the form).
-- smr_number is the customer's own "S.R No." (e.g. BN2074) — not guaranteed
-- globally unique across different customers, so indexed but not UNIQUE.
CREATE TABLE IF NOT EXISTS smr_documents (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  smr_number                text        NOT NULL,
  customer_name             text,                 -- e.g. 'Zain'
  source_warehouse_name     text,                 -- customer's WH Name, e.g. 'Basra'
  source_location           text,
  form_type                 text,                 -- e.g. 'OUT'
  sr_date                   date,
  requester_name            text,
  requester_department      text,
  requester_phone           text,
  site_code                 text,
  project_id                uuid REFERENCES projects(id),
  project_name_raw          text,                 -- project name as printed on the PDF
  sub_reference             text,                 -- e.g. 'MRC'
  destination_warehouse_id  uuid        NOT NULL REFERENCES warehouses(id), -- TAC WH receiving the material
  pdf_file_path             text        NOT NULL, -- storage path in the employee-docs bucket
  pdf_file_name             text        NOT NULL, -- original filename
  status                    text        NOT NULL DEFAULT 'DRAFT'
                                        CHECK (status IN (
                                          'DRAFT','EXTRACTED','REVIEWED',
                                          'RECONCILING','COMPLETED','CANCELLED'
                                        )),
  goods_receipt_id          uuid REFERENCES goods_receipts(id), -- set once finalized
  created_by                text        NOT NULL, -- users.id stored as text (see 001 User Reference note)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_smr_documents_updated_at
  BEFORE UPDATE ON smr_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_smr_documents_number      ON smr_documents(smr_number);
CREATE INDEX IF NOT EXISTS idx_smr_documents_status      ON smr_documents(status);
CREATE INDEX IF NOT EXISTS idx_smr_documents_project     ON smr_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_smr_documents_dest_wh     ON smr_documents(destination_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_smr_documents_receipt     ON smr_documents(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_smr_documents_created_at  ON smr_documents(created_at DESC);

-- ── smr_lines ─────────────────────────────────────────────────────────────────
-- One row per line item on the SMR (auto-extracted, then user-editable in review).
-- expected_qty is numeric (not integer) because the sample SMR shows fractional
-- accepted quantities (e.g. 0.5, 0.3 — shared-cost partial units).
CREATE TABLE IF NOT EXISTS smr_lines (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  smr_document_id   uuid        NOT NULL REFERENCES smr_documents(id) ON DELETE CASCADE,
  line_index        integer     NOT NULL, -- position/"Index" column as printed on the PDF
  product_number_raw text,               -- PN as printed (pre-mapping)
  description_raw   text,
  expected_qty      numeric     NOT NULL DEFAULT 0 CHECK (expected_qty >= 0),
  has_serial_flag   boolean     NOT NULL DEFAULT false, -- PDF's serial-number column is a 0/1 flag, not a real SN
  po_reference      text,                 -- Comments column, e.g. 'PO#11375'
  matched_item_id   uuid REFERENCES inventory_items(id), -- resolved via PN mapping (learned or manual)
  match_confidence  text        NOT NULL DEFAULT 'UNMATCHED'
                                 CHECK (match_confidence IN ('EXACT','LEARNED','MANUAL','UNMATCHED')),
  received_qty      numeric     NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  status            text        NOT NULL DEFAULT 'PENDING'
                                 CHECK (status IN ('PENDING','PARTIAL','RECEIVED','NOT_RECEIVED')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_smr_lines_updated_at
  BEFORE UPDATE ON smr_lines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_smr_lines_document      ON smr_lines(smr_document_id);
CREATE INDEX IF NOT EXISTS idx_smr_lines_matched_item  ON smr_lines(matched_item_id);
CREATE INDEX IF NOT EXISTS idx_smr_lines_status        ON smr_lines(status);

-- ── smr_line_scans ────────────────────────────────────────────────────────────
-- Audit trail: every SN scanned (or manually entered) against a line while
-- reconciling at the customer's warehouse. serial_number_normalized is set by
-- trigger (mirrors inventory_assets' normalize pattern from migration 001).
CREATE TABLE IF NOT EXISTS smr_line_scans (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  smr_line_id              uuid        NOT NULL REFERENCES smr_lines(id) ON DELETE CASCADE,
  serial_number            text        NOT NULL,
  serial_number_normalized text        NOT NULL, -- always UPPER(TRIM(serial_number)) — set by trigger
  raw_scan_value           text        NOT NULL,
  barcode_symbology        text,
  scanned_manually         boolean     NOT NULL DEFAULT false,
  scanned_by               text,                 -- users.id stored as text
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (smr_line_id, serial_number_normalized)
);

CREATE OR REPLACE FUNCTION normalize_smr_scan_serial()
RETURNS TRIGGER AS $$
BEGIN
  NEW.serial_number_normalized := UPPER(TRIM(NEW.serial_number));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_smr_line_scans_normalize_sn
  BEFORE INSERT OR UPDATE ON smr_line_scans
  FOR EACH ROW EXECUTE FUNCTION normalize_smr_scan_serial();

CREATE INDEX IF NOT EXISTS idx_smr_line_scans_line ON smr_line_scans(smr_line_id);
CREATE INDEX IF NOT EXISTS idx_smr_line_scans_sn   ON smr_line_scans(serial_number_normalized);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Same convention as every other warehouse table (see 001's WARNING note):
-- any authenticated session may read/write at the DB level; fine-grained
-- access control is enforced at the application layer via hasPerm().

ALTER TABLE smr_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE smr_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE smr_line_scans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='smr_documents'
      AND policyname='wrh_smr_documents_authenticated_all') THEN
    CREATE POLICY wrh_smr_documents_authenticated_all ON smr_documents
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='smr_lines'
      AND policyname='wrh_smr_lines_authenticated_all') THEN
    CREATE POLICY wrh_smr_lines_authenticated_all ON smr_lines
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='smr_line_scans'
      AND policyname='wrh_smr_line_scans_authenticated_all') THEN
    CREATE POLICY wrh_smr_line_scans_authenticated_all ON smr_line_scans
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── User Reference Note ───────────────────────────────────────────────────────
-- created_by (smr_documents) and scanned_by (smr_line_scans) store
-- public.users.id as text — same convention as goods_receipts.received_by
-- and stock_movements.performed_by. See 001's User Reference note.
