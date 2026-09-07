-- Migration 010 — Salary Advances
--
-- Tables: advances, advance_distributions
--
-- What this does:
--   `advances` is one row per cash advance given to a team member (amount,
--   date given, how many months it's spread across). `advance_distributions`
--   is the generated month-by-month deduction schedule for that advance —
--   e.g. a 300,000 IQD advance over 3 installments starting March 2026
--   produces three rows: (Mar 2026, 100000), (Apr 2026, 100000),
--   (May 2026, 100000). The app writes both tables together (see
--   src/lib/advances.ts): creating/editing an advance regenerates its
--   distribution rows.
--
--   Payroll (FinPayslips.tsx) reads advance_distributions for the selected
--   month/year to compute each employee's "Advance Deducted" line and
--   subtract it from net pay.
--
-- Security model — matches every other finance table in this project
-- (see supabase_finance.sql: team_members, work_log, revenue,
-- general_expenses, project_expenses all use a single blanket RLS policy
-- with no per-identity restriction) and the most recent precedent in this
-- migrations/ folder (001-009, warehouse tables use
-- `FOR ALL TO authenticated USING (true) WITH CHECK (true)`):
--
--   RLS is enabled but the policy allows any authenticated Supabase session
--   full access. Access control is NOT enforced at the database level here.
--   It is enforced entirely in the app layer via hasPerm('view_fin_advances')
--   and the fin_advances_* action keys (see permissionsCatalog.ts /
--   AuthContext.tsx), exactly like general_expenses, project_expenses,
--   revenue, etc. already work. There is no admin/team-leader helper
--   function in this database (no tac_is_admin(), no FK from team_members
--   to users) to build real per-identity RLS on, and every existing finance
--   table in this app already relies on app-layer checks instead — this
--   migration follows that same, already-established approach rather than
--   inventing a one-off, fragile exception for just this feature.
--
-- Safe to run multiple times (IF NOT EXISTS everywhere).

BEGIN;

-- ── advances ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advances (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    uuid        NOT NULL REFERENCES team_members(id),
  member_name  text        NOT NULL,                 -- snapshot, matches work_log/revenue pattern
  amount       numeric(15,0) NOT NULL CHECK (amount > 0),
  date_given   date        NOT NULL DEFAULT CURRENT_DATE,
  installments integer     NOT NULL DEFAULT 1 CHECK (installments > 0),
  start_month  integer     NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_year   integer     NOT NULL,
  reason       text,
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  notes        text,
  added_by     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_advances_updated_at
  BEFORE UPDATE ON advances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── advance_distributions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advance_distributions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id  uuid        NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
  member_id   uuid        NOT NULL REFERENCES team_members(id),
  member_name text        NOT NULL,
  month       integer     NOT NULL CHECK (month BETWEEN 1 AND 12),
  year        integer     NOT NULL,
  amount      numeric(15,0) NOT NULL CHECK (amount >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advance_id, month, year)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_advances_member          ON advances(member_id);
CREATE INDEX IF NOT EXISTS idx_advances_status          ON advances(status);

CREATE INDEX IF NOT EXISTS idx_adv_dist_advance         ON advance_distributions(advance_id);
-- Hot path: payroll looks up deductions by member + month + year.
CREATE INDEX IF NOT EXISTS idx_adv_dist_member_month_yr ON advance_distributions(member_id, month, year);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE advances               ENABLE ROW LEVEL SECURITY;
ALTER TABLE advance_distributions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_advances_all
  ON advances FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY rls_advance_distributions_all
  ON advance_distributions FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
