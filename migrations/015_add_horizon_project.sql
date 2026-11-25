-- ============================================================
-- Migration 015 — Add the "Horizon Project"
-- Apply via: Supabase SQL Editor (paste entire file and run)
-- Idempotent: safe to re-run (does nothing if 'horizon' already exists).
--
-- Projects are read from the `projects` table (projectsCache.ts), so this one
-- row is all that's needed: Horizon then appears in the sidebar Projects list,
-- in every project dropdown (Daily Activities, Expenses, Invoices, Warehouse
-- issue/receive, etc.) and as a "Horizon Project" toggle in User Management.
--
--   key           'horizon'          -> stored in sections.project_name; permission key view_horizon
--   display_name  'Horizon Project'  -> shown everywhere in the UI
--   has_sections  true               -> gets the Section dropdown like Nokia/Zain
--   sort_order    placed after the last real project, before 'General'
-- ============================================================

DO $$
DECLARE
  next_order integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects WHERE key = 'horizon') THEN
    RAISE NOTICE 'Horizon project already exists — nothing to do.';
    RETURN;
  END IF;

  SELECT COALESCE(MAX(sort_order), 0) + 1 INTO next_order
  FROM public.projects WHERE key <> 'general';

  INSERT INTO public.projects (key, display_name, has_sections, sort_order, is_active)
  VALUES ('horizon', 'Horizon Project', true, next_order, true);

  -- keep 'General' last
  UPDATE public.projects
  SET sort_order = GREATEST(sort_order, next_order + 1)
  WHERE key = 'general';
END $$;

-- Check the result:
-- SELECT key, display_name, has_sections, sort_order, is_active FROM public.projects ORDER BY sort_order;
