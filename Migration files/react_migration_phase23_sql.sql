-- Phase 23: Row-level Capex Project/Year tagging (corrected design)
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- Why: phase22 tagged public.sections.capex_project_id and filtered the
-- Dashboard at the section level. That was the wrong model — the user
-- wants the scopes/sections TREE (project names, section names like
-- ASIA_Huawei, the nav itself) to always look identical no matter which
-- capex project/year is selected. Only the underlying SITE DATA (rows)
-- should differ per year: switching from Capex 2025 to Capex26 should
-- show the same scopes and sections, just empty until 2026 data is
-- entered.
--
-- What this does:
--   1. Adds public.rows.capex_project_id (nullable FK to capex_projects).
--   2. Backfills every existing row to whichever capex_projects row is
--      currently flagged is_current (Capex 2025), so selecting Capex 2025
--      shows exactly what everyone sees today, and selecting Capex26
--      shows the same sections with zero rows until new data is added.
--
-- public.sections.capex_project_id (added in phase22) is left in place,
-- unused. It's harmless — nothing reads it after this migration.

alter table public.rows
  add column if not exists capex_project_id uuid references public.capex_projects(id) on delete set null;

update public.rows
set capex_project_id = (select id from public.capex_projects where is_current = true limit 1)
where capex_project_id is null;
