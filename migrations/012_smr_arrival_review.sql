-- ============================================================
-- Migration 012 — SMR Arrival Review (post-completion confirm step)
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to run on a fresh schema or re-run.
-- Depends on: 011_smr_receiving.sql
--
-- Purpose:
--   Once an SMR is finalized (COMPLETED, goods_receipt created as
--   PENDING_REVIEW), the material still has to travel from the pickup
--   point to the actual receiving warehouse. This migration adds a
--   second, independent confirmation pass — "arrival review" — done by
--   the warehouse keeper at the real destination, separate from the
--   original pickup scan captured during SMR reconciliation.
--
--   smr_line_scans already records the pickup scan (stage default
--   'PICKUP'). This migration adds a `stage` column so a second scan of
--   the same serial can be recorded at arrival ('ARRIVAL') without
--   colliding with the pickup row, plus an `arrival_confirmed` flag on
--   smr_lines so non-serialized lines can be tick-confirmed without a
--   scan at all.
-- ============================================================

-- ── smr_lines: arrival confirmation ─────────────────────────────────────────
ALTER TABLE smr_lines
  ADD COLUMN IF NOT EXISTS arrival_confirmed     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arrival_confirmed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_confirmed_by  text; -- users.id stored as text

CREATE INDEX IF NOT EXISTS idx_smr_lines_arrival_confirmed ON smr_lines(arrival_confirmed);

-- ── smr_line_scans: pickup vs. arrival stage ────────────────────────────────
ALTER TABLE smr_line_scans
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'PICKUP';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smr_line_scans_stage_check'
  ) THEN
    ALTER TABLE smr_line_scans
      ADD CONSTRAINT smr_line_scans_stage_check CHECK (stage IN ('PICKUP','ARRIVAL'));
  END IF;
END $$;

-- Replace the old (smr_line_id, serial_number_normalized) unique constraint
-- with one that includes stage, so the same serial can be recorded once at
-- pickup and once again at arrival without conflicting.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smr_line_scans_smr_line_id_serial_number_normalized_key'
  ) THEN
    ALTER TABLE smr_line_scans
      DROP CONSTRAINT smr_line_scans_smr_line_id_serial_number_normalized_key;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smr_line_scans_line_serial_stage_key'
  ) THEN
    ALTER TABLE smr_line_scans
      ADD CONSTRAINT smr_line_scans_line_serial_stage_key
        UNIQUE (smr_line_id, serial_number_normalized, stage);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_smr_line_scans_stage ON smr_line_scans(stage);

-- ── User Reference Note ───────────────────────────────────────────────────────
-- arrival_confirmed_by (smr_lines) stores public.users.id as text — same
-- convention as smr_documents.created_by / smr_line_scans.scanned_by.
