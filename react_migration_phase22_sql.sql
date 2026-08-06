-- Phase 22: Project/Year selector (top bar)
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- What this adds:
--   public.capex_projects — a NEW, separate concept from the existing
--   public.projects table. public.projects holds operator/client names
--   (Zain, Nokia, Huawei, IPT, MOJ) and already drives the Dashboard's
--   per-operator cards, Network Scopes routing, the Daily Activities
--   "Project" field, etc. — that table and everything built on it is
--   UNCHANGED by this migration.
--
--   capex_projects instead represents budget/fiscal-year groupings shown
--   in the new top-bar dropdown (e.g. "Capex 2025", "Capex26"). One of
--   them can be flagged is_current (shown with a "current" badge in the
--   dropdown) — that is independent from whichever one a given user has
--   *selected* in their own browser (stored client-side).
--
--   public.sections.capex_project_id is a new NULLABLE column linking an
--   existing section (a site batch under one operator project) to one
--   capex_projects row. It defaults to NULL so every existing section is
--   "unassigned" — the Dashboard treats unassigned sections as visible
--   under every capex project, so nothing on the dashboard changes for
--   any user until sections are explicitly tagged to a capex project via
--   a future admin UI.

create table if not exists public.capex_projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  is_current  boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.sections
  add column if not exists capex_project_id uuid references public.capex_projects(id) on delete set null;

-- Seed two starter rows matching the user's example so the dropdown isn't
-- empty on first load. Safe to edit/delete afterwards from the "Manage
-- projects / New" entry in the dropdown (which just inserts into this
-- table) — remove this INSERT if you'd rather start with an empty list.
insert into public.capex_projects (name, is_current, sort_order)
select 'Capex 2025', true, 0
where not exists (select 1 from public.capex_projects);

insert into public.capex_projects (name, is_current, sort_order)
select 'Capex26', false, 1
where not exists (select 1 from public.capex_projects where name = 'Capex26');
