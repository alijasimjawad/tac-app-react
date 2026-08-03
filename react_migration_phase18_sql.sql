-- Phase 18: Car Trip target point (destination) fields
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- What this adds:
--   public.daily_activities.target_lat / target_lng — a snapshot of the
--   trip's destination coordinates, computed once at save time (same
--   "snapshot, not recalculated retroactively" philosophy as start_lat/
--   start_lng and the distance/rate/cost columns from Phase 17).
--
-- Previously the destination was derived live from the Sites DB (public.sites,
-- matched by site_code) every time the trip distance was calculated, with
-- nothing persisted. That silently broke for any site not yet added to
-- Sites DB. These new columns let the app fall back to manual entry or a
-- map-picked point for such sites, and persist whichever value was used
-- (Sites DB auto-fill, manual entry, or map pick) so it doesn't need to be
-- re-entered every time the activity is edited.

alter table public.daily_activities
  add column if not exists target_lat double precision,
  add column if not exists target_lng double precision;
