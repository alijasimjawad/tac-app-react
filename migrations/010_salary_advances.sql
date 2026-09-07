-- Migration 010 — Salary Advances (cash float / redistribution model)
--
-- Tables: advances, advance_distributions
--
-- What this does (business model):
--   An admin/team leader gives ONE lump-sum cash advance to a specific
--   "holder" team member (e.g. 150,000 IQD). That holder can then hand out
--   portions of that lump sum to OTHER team members as needed — each portion
--   is deducted in FULL from the recipient's very next payslip (a single
--   one-time deduction, not spread over installments). Whatever part of the
--   original lump sum the holder never redistributes ("leftover") is instead
--   deducted from the HOLDER's own next payslip. Both the recipients'
--   deductions and the holder's leftover deduction land in the same
--   `settlement_month`/`settlement_year` payroll period.
--
--   `advances`               — one row per lump sum given to a holder.
--   `advance_distributions`  — one row per portion the holder has handed out
--                              to a specific teammate (recipient_member_id).
--                              There is no row for the holder's own leftover
--                              share — it's derived as
--                              amount - SUM(distributions for that advance).
--
--   Payroll (FinPayslips.tsx / src/lib/advances.ts) reads both tables for the
--   selected month/year: recipients see their distributed share; the holder
--   sees their undistributed leftover. Both subtract from net pay.
--
--   NOTE: this replaces the original version of migration 010 (one advance
--   per employee, auto-generated even monthly repayment schedule) — that
--   model didn't match the actual requirement, and since this feature was
--   never confirmed as deployed, this migration drops and recreates the
--   tables outright instead of leaving two schema generations to reconcile.
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
--   for the admin page, and a plain team-member-identity match (like
--   MyExpenses.tsx / MyTrips.tsx already do for "My X" pages) for the
--   employee-facing My Advances page. There is no admin/team-leader helper
--   function in this database (no tac_is_admin(), no FK from team_members
--   to users) to build real per-identity RLS on, and every existing finance
--   table in this app already relies on app-layer checks instead — this
--   migration follows that same, already-established approach.
--
-- Safe to run multiple times.

BEGIN;

DROP TABLE IF EXISTS advance_distributions CASCADE;
DROP TABLE IF EXISTS advances CASCADE;

-- ── advances ──────────────────────────────────────────────────────────────────
-- One row = one lump-sum cash advance given to a holder, settled (recipient
-- shares + holder leftover both deducted) in a single payroll period.
CREATE TABLE advances (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_member_id   uuid        NOT NULL REFERENCES team_members(id),
  holder_member_name text        NOT NULL,                 -- snapshot, matches work_log/revenue pattern
  amount             numeric(15,0) NOT NULL CHECK (amount > 0),
  date_given         date        NOT NULL DEFAULT CURRENT_DATE,
  settlement_month   integer     NOT NULL CHECK (settlement_month BETWEEN 1 AND 12),
  settlement_year    integer     NOT NULL,
  reason             text,
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled','cancelled')),
  notes              text,
  added_by           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_advances_updated_at
  BEFORE UPDATE ON advances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── advance_distributions ─────────────────────────────────────────────────────
-- One row = one portion the holder has handed out to a specific teammate.
-- Deducted in full from that recipient's payslip for the parent advance's
-- settlement_month/settlement_year. The holder's own leftover share (amount
-- minus the sum of these rows) has no row of its own — it's computed on the
-- fly by src/lib/advances.ts.
CREATE TABLE advance_distributions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id            uuid        NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
  recipient_member_id   uuid        NOT NULL REFERENCES team_members(id),
  recipient_member_name text        NOT NULL,
  amount                numeric(15,0) NOT NULL CHECK (amount > 0),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_advances_holder     ON advances(holder_member_id);
CREATE INDEX idx_advances_status     ON advances(status);
CREATE INDEX idx_advances_settlement ON advances(settlement_year, settlement_month);

CREATE INDEX idx_adv_dist_advance    ON advance_distributions(advance_id);
-- Hot path: My Advances page + payroll look up a recipient's incoming shares.
CREATE INDEX idx_adv_dist_recipient  ON advance_distributions(recipient_member_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE advances               ENABLE ROW LEVEL SECURITY;
ALTER TABLE advance_distributions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_advances_all
  ON advances FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY rls_advance_distributions_all
  ON advance_distributions FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
