-- Phase 13: push_subscriptions table + authenticated-role RLS policy
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- user_id stores users.id (the app-level PK), NOT auth.uid() directly.
-- RLS resolves the current session via auth_user_id → auth.uid().

create table if not exists public.push_subscriptions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null unique references public.users(id) on delete cascade,
  subscription jsonb       not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'push_subscriptions'
      and policyname = 'Users manage their own push subscription'
  ) then
    execute $policy$
      create policy "Users manage their own push subscription"
        on public.push_subscriptions
        for all
        to authenticated
        using (
          user_id = (select id from public.users where auth_user_id = auth.uid())
        )
        with check (
          user_id = (select id from public.users where auth_user_id = auth.uid())
        )
    $policy$;
  end if;
end $$;
