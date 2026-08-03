// Real road-based routing via OpenRouteService (HeiGIT), used to upgrade the
// Route Planner's straight-line (haversine) distance/time estimates to real
// driving distance/duration + an actual road path for the map, once a plan
// has already been generated.
//
// This is deliberately kept OFF the hot path of the planning algorithm
// itself (nearest-neighbor ordering, 2-opt optimization, day-splitting) —
// those run many thousands of pairwise distance checks per plan and must
// stay synchronous/local (haversine). ORS is only called once per
// team-per-day, after the plan's stop order and day grouping are already
// decided, to refine the numbers shown to the user and draw a real road
// path on the map. If the call fails for any reason, the caller should keep
// the existing straight-line values — this module never throws.

// HeiGIT is migrating off api.openrouteservice.org in favour of
// api.heigit.org — the confirmed working base path (per HeiGIT's own forum
// guidance) is "https://api.heigit.org/openrouteservice" with no trailing
// slash, followed by the standard v2 directions path.
const ORS_BASE_URL = 'https://api.heigit.org/openrouteservice';

export interface RoadRoutePoint {
  latitude: number;
  longitude: number;
}

export interface RoadRoute {
  distanceKm: number;
  minutes: number;
  /** [lat, lng] pairs, ready to hand straight to Leaflet's L.polyline(). */
  geometry: [number, number][];
}

export function getOrsToken(): string {
  return (import.meta.env.VITE_ORS_TOKEN as string | undefined) || '';
}

export function hasOrsToken(): boolean {
  return getOrsToken().length > 0;
}

/**
 * Fetches the real driving distance/duration + road geometry for an ordered
 * list of waypoints (start location and/or stops, in visit order).
 * Returns null (never throws) if there's no token, fewer than 2 points, the
 * request fails, or the response can't be parsed — callers should treat null
 * as "keep using the straight-line estimate for this leg/day".
 */
export async function getRoadRoute(points: RoadRoutePoint[]): Promise<RoadRoute | null> {
  const token = getOrsToken();
  if (!token || points.length < 2) return null;

  try {
    const res = await fetch(`${ORS_BASE_URL}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        coordinates: points.map(p => [p.longitude, p.latitude]),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ORS] request failed: HTTP ${res.status} ${res.statusText}`, body);
      return null;
    }

    const data = await res.json();
    const feature = data?.features?.[0];
    const summary = feature?.properties?.summary;
    const coords: [number, number][] | undefined = feature?.geometry?.coordinates;
    if (!summary || !coords?.length) {
      console.warn('[ORS] response missing summary/geometry', data);
      return null;
    }

    return {
      distanceKm: summary.distance / 1000,
      minutes: summary.duration / 60,
      geometry: coords.map(([lng, lat]: [number, number]) => [lat, lng]),
    };
  } catch (err) {
    console.warn('[ORS] request threw', err);
    return null;
  }
}
