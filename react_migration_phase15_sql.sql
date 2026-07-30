-- Phase 15: section columns on public.expense_claims
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- Why: My Expenses now has a "Section" dropdown (dependent on the chosen
-- Project, same pattern as Daily Activities) that is required whenever the
-- selected project has entries in public.sections. Previously the form
-- captured and validated the selection but never saved it, so the table/
-- detail view had nothing to display. This adds the two columns needed to
-- persist and display it.
--
-- section_id references public.sections(id); section_label is a denormalized
-- copy of the section's display label at submit time so historical claims
-- keep showing the right text even if the section is later renamed/removed.

alter table public.expense_claims add column if not exists section_id     uuid references public.sections(id);
alter table public.expense_claims add column if not exists section_label  text;
