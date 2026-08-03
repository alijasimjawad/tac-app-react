-- Phase 21: Car Trip round-trip option
-- Run this in the Supabase project that tac-app-react points to
-- (check VITE_SUPABASE_URL in .env — it is the gauejhgitzcqjvzalshf project)
--
-- What this adds:
--   public.daily_activities.round_trip — boolean flag, true when the trip's
--   route includes a final leg back from the last stop to the start point
--   (in addition to the outbound start→stop(s) route). When true, the extra
--   return leg is folded into trip_distance_km / trip_cost_iqd / trip_legs
--   the same way every other leg is — see calcCarTrip() in
--   src/pages/DailyActivities.tsx.
--
-- Defaults to false so every existing activity keeps its current one-way
-- behavior — same "snapshot, not recalculated retroactively" philosophy as
-- every other trip column.

alter table public.daily_activities
  add column if not exists round_trip boolean default false;
