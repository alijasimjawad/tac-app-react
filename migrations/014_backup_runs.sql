-- ============================================================
-- Migration 014 — Backup run log
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to re-run.
--
-- The Google Apps Script hourly backup (scripts/google-apps-script/
-- tac-auto-backup.gs) writes one row here after every run, using the
-- Supabase service key (which bypasses RLS). The Backup & Restore page reads
-- the latest row to show the REAL backup status instead of a fixed banner.
--
-- Rows hold only run metadata (time, counts, file name, errors) — no table
-- data — so read access for any signed-in user is harmless.
-- ============================================================

CREATE TABLE IF NOT EXISTS backup_runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at        timestamptz NOT NULL DEFAULT now(),
  ok            boolean     NOT NULL,
  partial       boolean     NOT NULL DEFAULT false,
  file_name     text,
  file_size     bigint,
  table_count   integer,
  total_records integer,
  daily_file    text,
  hourly_kept   integer,
  daily_kept    integer,
  errors        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  warnings      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  duration_ms   integer
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_run_at ON backup_runs (run_at DESC);

ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'backup_runs' AND policyname = 'rls_backup_runs_read'
  ) THEN
    CREATE POLICY rls_backup_runs_read
      ON backup_runs FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
