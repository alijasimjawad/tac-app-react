-- Phase 16: public.projects table — single source of truth for the project list
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- Why: the list of projects (Zain, Nokia, Huawei, IPT, MOJ, General) was
-- hardcoded independently in ~8 different files across the app. They had
-- drifted out of sync — e.g. MOJ Project was present in Sidebar/Dashboard/
-- NetworkScopes/MyExpenses but missing from FinRevenue/DailyActivities/
-- FinProjExp/finHelpers, so it silently couldn't be selected there. This
-- table becomes the single source of truth; the app now reads it via
-- src/lib/projectsCache.ts instead of hardcoding the list per file. Adding
-- a new project going forward only requires inserting a row here — no
-- code changes needed to make it appear across the app (Section support
-- for a new project still requires matching rows in public.sections keyed
-- by projects.key).

create table if not exists public.projects (
  id           uuid        primary key default gen_random_uuid(),
  key          text        not null unique,   -- e.g. 'zain', 'moj', 'general' — matches public.sections.project_name
  display_name text        not null,          -- e.g. 'Zain Project', 'MOJ Project', 'General'
  has_sections boolean     not null default true,  -- false for entries like 'General' that have no Section dropdown
  sort_order   int         not null default 0,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

alter table public.projects enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'projects'
      and policyname = 'Authenticated users can read projects'
  ) then
    execute $policy$
      create policy "Authenticated users can read projects"
        on public.projects
        for select
        to authenticated
        using (true)
    $policy$;
  end if;
end $$;

insert into public.projects (key, display_name, has_sections, sort_order) values
  ('zain',   'Zain Project',   true,  1),
  ('nokia',  'Nokia Project',  true,  2),
  ('huawei', 'Huawei Project', true,  3),
  ('ipt',    'IPT Project',    true,  4),
  ('moj',    'MOJ Project',    true,  5),
  ('general','General',        false, 6)
on conflict (key) do nothing;
