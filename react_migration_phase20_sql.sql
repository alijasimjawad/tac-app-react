-- Phase 20: Car Trip point-to-point distance/time
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- What this adds:
--   public.daily_activities.trip_legs — a jsonb array with one entry per
--   leg of the route (start→stop1, stop1→stop2, …), so
--   trip_legs.length === trip_stops.length:
--     [{ "distanceKm": 12.3, "minutes": 15 }, { "distanceKm": 45.2, "minutes": 52 }, ...]
--
-- "minutes" is null for legs that only got a straight-line (haversine)
-- distance because road routing (Mapbox Directions) wasn't available for
-- that calculation — same "snapshot, not recalculated retroactively"
-- philosophy as every other trip column.
--
-- Used to show point-to-point distance/time in the WhatsApp "Car Trip
-- Details" Route line (e.g. "Site A → Site B (12.30 km, 15 min)")
-- instead of just the total for the whole trip.

alter table public.daily_activities
  add column if not exists trip_legs jsonb;
