-- Phase 14: personal-profile columns on public.users
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- Why: some admin accounts (e.g. company owners) intentionally have no row
-- in public.team_members because that table represents paid/payroll staff.
-- Those accounts previously had no way to edit their own personal info
-- (phone, photo, address, emergency contact, etc.) since HR Profiles only
-- reads/writes public.team_members. This adds the same personal-info
-- columns directly to public.users (minus payroll fields) so any logged-in
-- user can maintain their own profile via the new "My Profile" page.
--
-- No changes to public.team_members. No changes to payroll/salary logic.
-- monthly_salary is intentionally NOT added here.

alter table public.users add column if not exists phone                    text;
alter table public.users add column if not exists national_id              text;
alter table public.users add column if not exists date_of_birth            date;
alter table public.users add column if not exists address                  text;
alter table public.users add column if not exists emergency_contact_name   text;
alter table public.users add column if not exists emergency_contact_phone  text;
alter table public.users add column if not exists start_date               date;
alter table public.users add column if not exists notes                    text;
alter table public.users add column if not exists profile_photo_url        text;
