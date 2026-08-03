// Real road-based routing, used to upgrade the app's straight-line
// (haversine) distance/time estimates to real driving distance/duration +
// an actual road path for the map (Route Planner, Car Trip calculator,
// live trip maps).
//
// This used to call OpenRouteService (HeiGIT), but that account started
// rejecting every request with HTTP 403 "Access to this API has been
// disallowed" — a known, recurring issue on HeiGIT's side (see their own
// support forum: ask.openrouteservice.org has multiple open threads about
// this exact error, including cases where the dashboard shows a healthy
// key but the API rejects it anyway). Since it's not something fixable
// from our side and the app already has a working Mapbox token (used for
// map tiles), routing now goes through the Mapbox Directions API instead,
// reusing that same token.
//
// This is deliberately kept OFF the hot path of the planning algorithm
// itself (nearest-neighbor ordering, 2-opt optimization, day-splitting) —
// those run many thousands of pairwise distance checks per plan and must
// stay synchronous/local (haversine). Road routing is only called once per
// team-per-day (or once per trip/site pair), after the order is already
// decided, to refine the numbers shown to the user and draw a real road
// path on the map. If the call fails for any reason, the caller should keep
// the existing straight-line values — this module never throws.

import { getMapboxToken, hasMapboxToken } from './mapboxTiles';

const MAPBOX_DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

export interface RoadRoutePoint {
  latitude: number;
  longitude: number;
}

export interface RoadRouteLeg {
  distanceKm: number;
  minutes: number;
}

export interface RoadRoute {
  distanceKm: number;
  minutes: number;
  /** [lat, lng] pairs, ready to hand straight to Leaflet's L.polyline(). */
  geometry: [number, number][];
  /** Per-leg breakdown between each consecutive pair of input waypoints,
   *  in the same order (legs.length === points.length - 1) — used to show
   *  point-to-point distance/time (e.g. the Car Trip WhatsApp route line). */
  legs: RoadRouteLeg[];
}

/** True if a road-routing token (Mapbox) is configured for this environment. */
export function hasRoadRoutingToken(): boolean {
  return hasMapboxToken();
}

/**
 * Fetches the real driving distance/duration + road geometry for an ordered
 * list of waypoints (start location and/or stops, in visit order), via the
 * Mapbox Directions API.
 * Returns null (never throws) if there's no token, fewer than 2 points, the
 * request fails, or the response can't be parsed — callers should treat null
 * as "keep using the straight-line estimate for this leg/day".
 */
export async function getRoadRoute(points: RoadRoutePoint[]): Promise<RoadRoute | null> {
  const token = getMapboxToken();
  if (!token || points.length < 2) return null;

  try {
    const coordsPath = points.map(p => `${p.longitude},${p.latitude}`).join(';');
    const url = `${MAPBOX_DIRECTIONS_URL}/${coordsPath}?geometries=geojson&overview=full&access_token=${token}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[Mapbox Directions] request failed: HTTP ${res.status} ${res.statusText}`, body);
      return null;
    }

    const data = await res.json();
    const route = data?.routes?.[0];
    const coords: [number, number][] | undefined = route?.geometry?.coordinates;
    if (!route || route.distance == null || route.duration == null || !coords?.length) {
      console.warn('[Mapbox Directions] response missing route/geometry', data);
      return null;
    }

    const rawLegs: { distance?: number; duration?: number }[] = route.legs || [];
    const legs: RoadRouteLeg[] = rawLegs.map((l) => ({
      distanceKm: (l.distance ?? 0) / 1000,
      minutes: (l.duration ?? 0) / 60,
    }));

    return {
      distanceKm: route.distance / 1000,
      minutes: route.duration / 60,
      geometry: coords.map(([lng, lat]: [number, number]) => [lat, lng]),
      legs,
    };
  } catch (err) {
    console.warn('[Mapbox Directions] request threw', err);
    return null;
  }
}
