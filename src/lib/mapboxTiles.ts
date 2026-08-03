// Mapbox raster tile helper — used to upgrade the app's Leaflet basemaps
// from free OpenStreetMap tiles to Mapbox's Streets/Satellite tiles once a
// Mapbox default public token is configured. Falls back to plain OSM tiles
// (no token required) if VITE_MAPBOX_TOKEN is not set, so the app keeps
// working even without Mapbox configured.

import L from 'leaflet';

export type MapboxStyle = 'streets' | 'satellite';

const MAPBOX_STYLE_ID: Record<MapboxStyle, string> = {
  streets: 'streets-v12',
  satellite: 'satellite-streets-v12',
};

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const MAPBOX_ATTRIBUTION =
  '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function getMapboxToken(): string {
  return (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || '';
}

export function hasMapboxToken(): boolean {
  return getMapboxToken().length > 0;
}

/** Returns the Leaflet tile URL template for the given style, or the OSM
 * fallback URL if no Mapbox token is configured. */
export function tileUrlFor(style: MapboxStyle): string {
  const token = getMapboxToken();
  if (!token) return OSM_TILE_URL;
  const styleId = MAPBOX_STYLE_ID[style];
  return `https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/256/{z}/{x}/{y}@2x?access_token=${token}`;
}

export function tileAttributionFor(): string {
  return hasMapboxToken() ? MAPBOX_ATTRIBUTION : OSM_ATTRIBUTION;
}

export interface AddBaseLayerOptions {
  maxZoom?: number;
  attributionControl?: boolean;
}

/**
 * Creates and adds a Leaflet tile layer for the given style to the map,
 * returning the layer so callers can swap it out later (e.g. from the
 * Streets/Satellite toggle control).
 */
export function addBaseLayer(
  map: L.Map,
  style: MapboxStyle,
  opts: AddBaseLayerOptions = {}
): L.TileLayer {
  const layer = L.tileLayer(tileUrlFor(style), {
    maxZoom: opts.maxZoom ?? 19,
    attribution: opts.attributionControl === false ? undefined : tileAttributionFor(),
  });
  layer.addTo(map);
  return layer;
}

/**
 * Custom vanilla-Leaflet control offering a Streets/Satellite toggle.
 * Intended for the app's primary full-page interactive maps only
 * (RoutePlanner, SitesDB list map) — smaller/embedded maps just use
 * addBaseLayer() directly with the 'streets' style, no toggle needed.
 */
export function createStyleToggleControl(
  map: L.Map,
  currentLayer: { layer: L.TileLayer },
  opts: AddBaseLayerOptions = {}
): L.Control {
  const StyleToggle = L.Control.extend({
    options: { position: 'topright' as L.ControlPosition },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-bar mapbox-style-toggle');
      container.style.background = '#fff';
      container.style.borderRadius = '6px';
      container.style.overflow = 'hidden';
      container.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';
      container.style.display = 'flex';

      let active: MapboxStyle = 'streets';

      const makeBtn = (label: string, style: MapboxStyle) => {
        const btn = L.DomUtil.create('a', '', container);
        btn.href = '#';
        btn.innerText = label;
        btn.style.padding = '6px 10px';
        btn.style.fontSize = '12px';
        btn.style.fontWeight = '600';
        btn.style.textDecoration = 'none';
        btn.style.color = style === active ? '#fff' : '#333';
        btn.style.background = style === active ? '#1a73e8' : '#fff';
        btn.style.display = 'inline-block';
        btn.style.cursor = 'pointer';
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (active === style) return;
          active = style;
          map.removeLayer(currentLayer.layer);
          currentLayer.layer = addBaseLayer(map, style, opts);
          streetsBtn.style.color = active === 'streets' ? '#fff' : '#333';
          streetsBtn.style.background = active === 'streets' ? '#1a73e8' : '#fff';
          satBtn.style.color = active === 'satellite' ? '#fff' : '#333';
          satBtn.style.background = active === 'satellite' ? '#1a73e8' : '#fff';
        };
        return btn;
      };

      const streetsBtn = makeBtn('Streets', 'streets');
      const satBtn = makeBtn('Satellite', 'satellite');

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      return container;
    },
  });

  const control = new StyleToggle();
  control.addTo(map);
  return control;
}
