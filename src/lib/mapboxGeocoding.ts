// Mapbox Geocoding helper — forward-geocodes a free-text place/address
// search into candidate lat/lng results, using the same VITE_MAPBOX_TOKEN
// already configured for map tiles. Biased toward Iraq since that's where
// all trips/sites are, but still works for a general place name if given.

import { getMapboxToken } from './mapboxTiles';

export interface GeocodeResult {
  id: string;
  placeName: string;
  lat: number;
  lng: number;
}

export async function searchPlaces(query: string): Promise<GeocodeResult[]> {
  const token = getMapboxToken();
  const q = query.trim();
  if (!token || !q) return [];
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
    `?access_token=${token}&country=iq&language=en&limit=6`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const features: unknown[] = Array.isArray(data?.features) ? data.features : [];
    return features.map((f) => {
      const feat = f as { id: string; place_name: string; center: [number, number] };
      return {
        id: feat.id,
        placeName: feat.place_name,
        lat: feat.center[1],
        lng: feat.center[0],
      };
    });
  } catch {
    return [];
  }
}
