export interface SiteCoord {
  id: string;
  site_code: string;
  site_name: string | null;
  operator: string;
  latitude: number | null;
  longitude: number | null;
  city?: string | null;
  governorate?: string | null;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function fmtDist(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
}

/**
 * Returns { row, km } for the single closest site (with coordinates) to the
 * given point, or null if the sites array is empty, none have coordinates,
 * or the nearest is beyond maxKm (when provided).
 *
 * This mirrors the old app's `_sdbNearestSiteWithin(lat, lng, maxKm)`.
 * Accepts any array of sites — callers pass the full cross-operator dataset.
 */
export function nearestSiteWithin<T extends SiteCoord>(
  sites: T[],
  lat: number,
  lng: number,
  maxKm?: number,
): { row: T; km: number } | null {
  if (lat == null || lng == null) return null;
  let best: { row: T; km: number } | null = null;
  for (const r of sites) {
    if (r.latitude == null || r.longitude == null) continue;
    const km = haversineKm(lat, lng, r.latitude, r.longitude);
    if (!best || km < best.km) best = { row: r, km };
  }
  if (!best || (maxKm != null && best.km > maxKm)) return null;
  return best;
}
