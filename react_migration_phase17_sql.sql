-- Phase 17: Car / Car-KM Expense tracking
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- What this adds:
--   1. public.cars          — company-owned vehicles
--   2. public.saved_points  — reusable named start points (lat/lng), a
--                             convenience layer on top of manual entry
--   3. public.app_settings  — generic key/value config store (first use:
--                             the global car KM rate, seeded at 275 IQD/km)
--   4. public.daily_activities — new car-trip columns (car, driver, start
--                             point, and a snapshot of distance/rate/cost
--                             computed once at save time — does NOT change
--                             retroactively if the global rate changes later)
--   5. public.expense_claims — new linkage/snapshot columns so a car trip
--                             can auto-create a linked "pending" claim that
--                             shows up in Finance > Expense Claims for
--                             awareness/approval into Project Expenses
--                             (company cost), WITHOUT ever being paid out to
--                             the driver via Payslips — see is_car_trip below.
--
-- This is cost tracking only, not a reimbursement to the driver/employee.
-- App code must filter out is_car_trip = true rows from any personal
-- (My Expenses / My Work) or payslip-aggregation query.

-- ── 1. cars ──────────────────────────────────────────────────────────────
create table if not exists public.cars (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,               -- e.g. 'Hilux - White'
  plate_number text,
  owner_id     uuid        references public.team_members(id) on delete set null,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

alter table public.cars enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'cars'
      and policyname = 'Authenticated users can manage cars'
  ) then
    execute $policy$
      create policy "Authenticated users can manage cars"
        on public.cars
        for all
        to authenticated
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;

-- ── 2. saved_points ──────────────────────────────────────────────────────
create table if not exists public.saved_points (
  id           uuid             primary key default gen_random_uuid(),
  name         text             not null,           -- e.g. 'Baghdad Warehouse'
  latitude     double precision not null,
  longitude    double precision not null,
  is_active    boolean          not null default true,
  created_at   timestamptz      not null default now()
);

alter table public.saved_points enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'saved_points'
      and policyname = 'Authenticated users can manage saved points'
  ) then
    execute $policy$
      create policy "Authenticated users can manage saved points"
        on public.saved_points
        for all
        to authenticated
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;

-- ── 3. app_settings (generic key/value config) ──────────────────────────
create table if not exists public.app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_settings'
      and policyname = 'Authenticated users can manage app settings'
  ) then
    execute $policy$
      create policy "Authenticated users can manage app settings"
        on public.app_settings
        for all
        to authenticated
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;

insert into public.app_settings (key, value) values
  ('car_km_rate_iqd', '275')
on conflict (key) do nothing;

-- ── 4. daily_activities — car-trip columns ──────────────────────────────
alter table public.daily_activities
  add column if not exists car_id             uuid references public.cars(id) on delete set null,
  add column if not exists driver_id          uuid references public.team_members(id) on delete set null,
  add column if not exists start_point_name   text,
  add column if not exists start_lat          double precision,
  add column if not exists start_lng          double precision,
  add column if not exists trip_distance_km   numeric(10,2),
  add column if not exists trip_rate_iqd      numeric(10,2),
  add column if not exists trip_cost_iqd      numeric(12,2),
  add column if not exists trip_distance_source text;  -- 'road' | 'straight'

-- ── 5. expense_claims — car-trip linkage/snapshot columns ───────────────
alter table public.expense_claims
  add column if not exists is_car_trip        boolean not null default false,
  add column if not exists daily_activity_id  uuid references public.daily_activities(id) on delete set null,
  add column if not exists car_id             uuid references public.cars(id) on delete set null,
  add column if not exists car_trip_distance_km numeric(10,2),
  add column if not exists car_trip_rate_iqd    numeric(10,2);
