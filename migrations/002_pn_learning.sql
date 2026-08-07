-- ============================================================
-- Migration 002 — Learned PN → Item Mapping Infrastructure
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to run on a fresh schema or re-run.
-- Depends on: 001_warehouse_phase1.sql (item_code_mappings table)
-- ============================================================

-- ── Add audit / control columns ───────────────────────────────────────────────
-- is_active: allows deactivating a stale mapping without deleting it.
-- source:    records how the mapping was created ('RECEIVING' | 'MANUAL' | etc.)
-- created_by: users.id of the operator who triggered the mapping.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'item_code_mappings' AND column_name = 'is_active'
  ) THEN
    ALTER TABLE item_code_mappings ADD COLUMN is_active boolean NOT NULL DEFAULT true;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'item_code_mappings' AND column_name = 'source'
  ) THEN
    ALTER TABLE item_code_mappings ADD COLUMN source text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'item_code_mappings' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE item_code_mappings ADD COLUMN created_by text;
  END IF;
END $$;

-- ── Replace absolute unique constraint with active-only partial index ──────────
--
-- Option B: Drop UNIQUE(code_type, external_code) and replace with a partial
-- unique index that only covers active rows.
--
-- Why: The old constraint blocks the deactivate + re-insert correction workflow.
-- If a mapping is wrong (e.g. PN X learned as item A but the correct item is B),
-- the operator can set is_active = false on the wrong row and insert a corrected one.
-- The partial index permits this because the deactivated row is excluded from the
-- uniqueness check.
--
-- The partial index uses UPPER(TRIM(...)) so that case and whitespace differences
-- in external_code never create phantom duplicates.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'item_code_mappings'
      AND constraint_name = 'item_code_mappings_code_type_external_code_key'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE item_code_mappings
      DROP CONSTRAINT item_code_mappings_code_type_external_code_key;
  END IF;
END $$;

-- Active-only normalized unique index (idempotent via IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS idx_icm_active_code_unique
  ON item_code_mappings (code_type, UPPER(TRIM(external_code)))
  WHERE is_active = true;

-- ── Supporting index for received_by lookups ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_icm_item ON item_code_mappings(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_icm_source ON item_code_mappings(source);
