-- Phase 19: Car Trip multi-stop route (multiple sites in one trip)
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- What this adds:
--   public.daily_activities.trip_stops — a jsonb array of every destination
--   in the route, in visit order:
--     [{ "site": "SITE-001", "lat": 33.31, "lng": 44.36 }, ...]
--
-- Previously (Phase 18) a car trip could only have a single destination
-- (target_lat/target_lng), even when the Site ID field held multiple sites
-- (e.g. "SITE-001, SITE-002"). Multi-site trips are now calculated as a
-- full route — start point → stop 1 → stop 2 → … — summed exactly like the
-- Route Planner does for multi-site days, using the same "snapshot, not
-- recalculated retroactively" philosophy as every other trip column.
--
-- target_lat/target_lng are kept and still populated (with the *last*
-- stop's coordinates — the final destination) so any older code/queries
-- that only look at those two columns keep working unchanged.

alter table public.daily_activities
  add column if not exists trip_stops jsonb;
