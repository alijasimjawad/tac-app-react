import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { cacheOk, getSitesByOperator, loadPreview as loadSitePreview, ensureFullLoad as ensureSitesFullLoad, invalidateCache } from '../lib/sitesCache';
import { haversineKm, fmtDist } from '../lib/sitesNearest';
import styles from './SitesDB.module.css';

// Fix Leaflet's broken marker icon paths in bundled environments
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const OPERATORS = ['Zain', 'Asia Cell'] as const;
type Operator = typeof OPERATORS[number];

const SITES_DEFAULT_LIMIT = 50;

// ── Import / Enrich shared utilities ──
const SDB_IMPORT_FIELD_MAP: Record<string, string> = {
  sitecode: 'site_code', siteid: 'site_code', code: 'site_code', id: 'site_code',
  sitename: 'site_name', name: 'site_name',
  governorate: 'governorate', gov: 'governorate',
  city: 'city',
  latitude: 'latitude', lat: 'latitude',
  longitude: 'longitude', lng: 'longitude', lon: 'longitude', long: 'longitude',
  sitetype: 'site_type', type: 'site_type',
  towerheightm: 'tower_height', towerheight: 'tower_height', height: 'tower_height',
  topology: 'topology',
  cabinatype: 'cabina_type',
  installationtype: 'installation_type',
  antenna: 'antenna',
  vendor: 'vendor',
  status: 'status',
};

const SDB_ENRICH_FIELDS = [
  { id: 'governorate',       label: 'Governorate' },
  { id: 'city',              label: 'City' },
  { id: 'latitude',          label: 'Latitude' },
  { id: 'longitude',         label: 'Longitude' },
  { id: 'site_type',         label: 'Site Type' },
  { id: 'tower_height',      label: 'Tower Height' },
  { id: 'topology',          label: 'Topology' },
  { id: 'cabina_type',       label: 'Cabina Type' },
  { id: 'installation_type', label: 'Installation Type' },
  { id: 'antenna',           label: 'Antenna' },
  { id: 'vendor',            label: 'Vendor' },
  { id: 'status',            label: 'Status' },
];

function normHeader(h: unknown): string {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface Site {
  id: string;
  operator: string;
  site_code: string;
  site_name: string | null;
  governorate: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  site_type: string | null;
  cabina_type: string | null;
  installation_type: string | null;
  tower_height: number | null;
  topology: string | null;
  antenna: string | null;
  vendor: string | null;
  status: string | null;
}

type ImportRow = Omit<Site, 'id'>;

interface HealthField {
  key: string;
  label: string;
  test: (r: Site) => boolean;
}

const HEALTH_FIELDS: HealthField[] = [
  { key: 'geo',               label: 'Missing Coordinates',       test: r => r.latitude == null || r.longitude == null },
  { key: 'site_type',         label: 'Missing Site Type',         test: r => !r.site_type },
  { key: 'tower_height',      label: 'Missing Tower Height',      test: r => r.tower_height == null },
  { key: 'topology',          label: 'Missing Topology',          test: r => !r.topology },
  { key: 'cabina_type',       label: 'Missing Cabina Type',       test: r => !r.cabina_type },
  { key: 'installation_type', label: 'Missing Installation Type', test: r => !r.installation_type },
  { key: 'antenna',           label: 'Missing Antenna',           test: r => !r.antenna },
  { key: 'vendor',            label: 'Missing Vendor',            test: r => !r.vendor },
  { key: 'governorate',       label: 'Missing Governorate',       test: r => !r.governorate },
  { key: 'city',              label: 'Missing City',              test: r => !r.city },
  { key: 'status',            label: 'Missing Status',            test: r => !r.status },
];

function healthLabel(key: string) {
  return HEALTH_FIELDS.find(f => f.key === key)?.label ?? 'Data Health filter';
}

function rowMatchesHealth(r: Site, key: string) {
  if (!key) return true;
  const f = HEALTH_FIELDS.find(x => x.key === key);
  return f ? f.test(r) : true;
}

// ── Edit form state shape ──
interface EditForm {
  operator: string;
  site_code: string;
  site_name: string;
  governorate: string;
  city: string;
  latitude: string;
  longitude: string;
  site_type: string;
  tower_height: string;
  topology: string;
  cabina_type: string;
  installation_type: string;
  antenna: string;
  vendor: string;
  status: string;
}

function emptyForm(op: string): EditForm {
  return {
    operator: op, site_code: '', site_name: '', governorate: '',
    city: '', latitude: '', longitude: '', site_type: '',
    tower_height: '', topology: '', cabina_type: '', installation_type: '',
    antenna: '', vendor: '', status: '',
  };
}

function siteToForm(s: Site): EditForm {
  return {
    operator: s.operator,
    site_code: s.site_code,
    site_name: s.site_name ?? '',
    governorate: s.governorate ?? '',
    city: s.city ?? '',
    latitude: s.latitude != null ? String(s.latitude) : '',
    longitude: s.longitude != null ? String(s.longitude) : '',
    site_type: s.site_type ?? '',
    tower_height: s.tower_height != null ? String(s.tower_height) : '',
    topology: s.topology ?? '',
    cabina_type: s.cabina_type ?? '',
    installation_type: s.installation_type ?? '',
    antenna: s.antenna ?? '',
    vendor: s.vendor ?? '',
    status: s.status ?? '',
  };
}

// ─────────────────────────────────────────────────
// Map sub-component — keeps the Leaflet instance in
// a ref so it isn't destroyed on filter re-renders.
// Rendered with display:none when list view is active,
// so pan/zoom state is preserved across view switches.
// ─────────────────────────────────────────────────
interface SiteMapViewProps {
  sites: Site[];
  onViewSite: (site: Site) => void;
}

function SiteMapView({ sites, onViewSite }: SiteMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<L.Map | null>(null);
  const clusterRef   = useRef<L.MarkerClusterGroup | null>(null);
  // Keep a stable ref to the callback so marker popups don't close over a stale value
  const onViewRef    = useRef(onViewSite);
  useEffect(() => { onViewRef.current = onViewSite; }, [onViewSite]);

  // Initialize map once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current).setView([33.3152, 44.3661], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const cluster = L.markerClusterGroup();
    map.addLayer(cluster);
    mapRef.current     = map;
    clusterRef.current = cluster;
    return () => {
      map.remove();
      mapRef.current     = null;
      clusterRef.current = null;
    };
  }, []);

  // Re-paint markers whenever the filtered site list changes
  useEffect(() => {
    const map     = mapRef.current;
    const cluster = clusterRef.current;
    if (!map || !cluster) return;

    cluster.clearLayers();
    const withCoords = sites.filter(r => r.latitude != null && r.longitude != null);

    withCoords.forEach(r => {
      const marker = L.marker([r.latitude!, r.longitude!]);

      // Build popup using a DOM node so we can attach a React-safe click handler
      const popup = document.createElement('div');
      popup.style.cssText = 'font-family:inherit;min-width:180px';

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:2px';
      title.textContent = r.site_name || r.site_code || 'Site';

      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:12px;color:#64748b;margin-bottom:8px';
      meta.textContent = [r.site_code, r.governorate].filter(Boolean).join(' · ');

      const btn = document.createElement('button');
      btn.textContent = 'View Details';
      btn.style.cssText = 'padding:4px 12px;font-size:12px;font-weight:600;background:#eff6ff;color:#2563eb;border:1.5px solid #bfdbfe;border-radius:6px;cursor:pointer;font-family:inherit';
      btn.addEventListener('click', () => onViewRef.current(r));

      popup.appendChild(title);
      popup.appendChild(meta);
      popup.appendChild(btn);

      marker.bindPopup(popup);
      cluster.addLayer(marker);
    });

    if (withCoords.length > 0) {
      try {
        map.fitBounds(cluster.getBounds(), { padding: [30, 30], maxZoom: 14 });
      } catch {
        // getBounds throws if cluster is empty; safe to ignore
      }
    }
    setTimeout(() => map.invalidateSize(), 50);
  }, [sites]);

  return <div ref={containerRef} className={styles.mapContainer} />;
}

// ─────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────
export default function SitesDB() {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';

  // ── Data ──
  const [dataCache, setDataCache] = useState<Record<string, Site[]>>({});
  const [loading, setLoading] = useState(false);
  const [operator, setOperator] = useState<Operator>('Zain');

  // ── View ──
  const [view, setView] = useState<'list' | 'map'>('list');

  // ── Filters ──
  const [search, setSearch] = useState('');
  const [govFilter, setGovFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [healthFilter, setHealthFilter] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [bulkIds, setBulkIds] = useState<string[]>([]);

  // ── Modals ──
  const [detailRow, setDetailRow] = useState<Site | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyForm('Zain'));
  const [editErr, setEditErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);

  // ── Nearest-site modal ──
  const [nearestOpen, setNearestOpen] = useState(false);
  const [nearestLat, setNearestLat] = useState('');
  const [nearestLng, setNearestLng] = useState('');
  const [nearestStatus, setNearestStatus] = useState('');
  const [nearestResults, setNearestResults] = useState<{ site: Site; km: number }[]>([]);
  const [nearestLocating, setNearestLocating] = useState(false);

  // ── Import/Enrich modal ──
  const [importOpen, setImportOpen] = useState(false);
  const [importOperator, setImportOperator] = useState<string>('Zain');
  const [importFileName, setImportFileName] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importNewRows, setImportNewRows] = useState<ImportRow[]>([]);
  const [importDupRows, setImportDupRows] = useState<ImportRow[]>([]);
  const [importInvalidCount, setImportInvalidCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importDragOver, setImportDragOver] = useState(false);
  const [enrichDragOver, setEnrichDragOver] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const enrichFileRef = useRef<HTMLInputElement>(null);
  const importRawRowsRef = useRef<Record<string, unknown>[]>([]);
  const enrichRowsRef    = useRef<Record<string, unknown>[]>([]);
  const enrichHeadersRef = useRef<string[]>([]);
  const enrichCodeKeyRef = useRef<string | null>(null);
  const enrichOpKeyRef   = useRef<string | null>(null);
  const [enrichFileName, setEnrichFileName] = useState('');
  const [enrichStatus,   setEnrichStatus]   = useState('');
  const [enrichChecked,  setEnrichChecked]  = useState<Set<string>>(new Set(['governorate', 'city', 'latitude', 'longitude']));
  const [enrichReady,    setEnrichReady]    = useState(false);

  // ── Toast ──
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load data on mount using module-level cache ──
  // Pattern mirrors old app: instant from cache if fresh, else fast preview
  // first paint + background full load for all operators.
  useEffect(() => {
    let alive = true;

    if (cacheOk()) {
      // Instant path: cache is warm, populate all operators immediately
      const fromCache: Record<string, Site[]> = {};
      OPERATORS.forEach(op => { fromCache[op] = getSitesByOperator(op) as Site[]; });
      setDataCache(fromCache);
      return;
    }

    // Fast preview for current operator → first paint without blank screen
    setLoading(true);
    loadSitePreview(operator).then(rows => {
      if (!alive) return;
      if (rows.length) {
        setDataCache(prev => ({ ...prev, [operator]: rows as Site[] }));
        setLoading(false);
      }
    });

    // Full load in background — populates ALL operators when done
    ensureSitesFullLoad(() => {
      if (!alive) return;
      const fromCache: Record<string, Site[]> = {};
      OPERATORS.forEach(op => { fromCache[op] = getSitesByOperator(op) as Site[]; });
      setDataCache(fromCache);
      setLoading(false);
    });

    return () => { alive = false; };
  }, []);

  function switchOperator(op: Operator) {
    setOperator(op);
    setSearch('');
    setGovFilter('');
    setTypeFilter('');
    setHealthFilter('');
    setBulkIds([]);
    setBulkText('');
    if (op in dataCache) return; // already have data
    // Load preview for this operator while background full load continues
    loadSitePreview(op).then(rows => {
      if (rows.length) setDataCache(prev => ({ ...prev, [op]: rows as Site[] }));
    });
  }

  // ── Derived data ──
  const opRows: Site[] = dataCache[operator] ?? [];
  const allSites: Site[] = Object.values(dataCache).flat();

  const anyFilterActive = !!(search.trim() || govFilter || typeFilter || healthFilter || bulkIds.length);

  const filtered = opRows.filter(r => {
    if (govFilter  && (r.governorate ?? '') !== govFilter)  return false;
    if (typeFilter && (r.site_type ?? '') !== typeFilter)    return false;
    if (healthFilter && !rowMatchesHealth(r, healthFilter))  return false;
    if (bulkIds.length && !bulkIds.includes((r.site_code ?? '').trim().toLowerCase())) return false;
    const q = search.trim().toLowerCase();
    if (q) {
      return (r.site_code ?? '').toLowerCase().includes(q) ||
             (r.site_name ?? '').toLowerCase().includes(q) ||
             (r.governorate ?? '').toLowerCase().includes(q) ||
             (r.city ?? '').toLowerCase().includes(q);
    }
    return true;
  });

  const visible = anyFilterActive ? filtered : filtered.slice(0, SITES_DEFAULT_LIMIT);

  const mapSubtitle = `${filtered.filter(r => r.latitude != null && r.longitude != null).length.toLocaleString()} site${filtered.filter(r => r.latitude != null).length !== 1 ? 's' : ''} on map`;
  const listSubtitle = anyFilterActive
    ? `${filtered.length.toLocaleString()} result${filtered.length !== 1 ? 's' : ''}`
    : `Showing ${Math.min(SITES_DEFAULT_LIMIT, opRows.length)} of ${opRows.length.toLocaleString()} — search or filter to find a specific site.`;
  const subtitle = loading ? 'Loading…' : view === 'map' ? mapSubtitle : listSubtitle;

  const govOptions = [...new Set(opRows.map(r => r.governorate).filter(Boolean) as string[])].sort();
  const typeOptions = [...new Set(opRows.map(r => r.site_type).filter(Boolean) as string[])].sort();

  // ── Bulk filter ──
  function applyBulkFilter() {
    const ids = bulkText.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    setBulkIds([...new Set(ids)]);
  }
  function clearBulkFilter() { setBulkIds([]); setBulkText(''); }
  function clearAllFilters() {
    setSearch(''); setGovFilter(''); setTypeFilter('');
    setHealthFilter(''); setBulkIds([]); setBulkText('');
  }

  // ── Health filter ──
  function applyHealthFilter(key: string) {
    setHealthFilter(key);
    setSearch(''); setGovFilter(''); setTypeFilter('');
    setView('list');
    setHealthOpen(false);
  }

  // ── Detail modal ──
  function openDetail(site: Site) { setDetailRow(site); }

  // ── Nearest-site modal ──
  function openNearestModal() {
    setNearestLat('');
    setNearestLng('');
    setNearestStatus('');
    setNearestResults([]);
    setNearestOpen(true);
  }

  function runNearestSearch(lat: number, lng: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setNearestStatus('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
      setNearestResults([]);
      return;
    }
    const ranked = allSites
      .filter(r => r.latitude != null && r.longitude != null)
      .map(r => ({ site: r, km: haversineKm(lat, lng, r.latitude!, r.longitude!) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 15);

    setNearestStatus(
      ranked.length
        ? `Nearest ${ranked.length} site${ranked.length !== 1 ? 's' : ''} to ${lat.toFixed(5)}, ${lng.toFixed(5)}:`
        : 'No sites with coordinates found.',
    );
    setNearestResults(ranked);
  }

  function nearestSearch() {
    const lat = parseFloat(nearestLat);
    const lng = parseFloat(nearestLng);
    runNearestSearch(lat, lng);
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setNearestStatus('Geolocation is not available on this device/browser — enter coordinates manually.');
      return;
    }
    setNearestLocating(true);
    setNearestStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setNearestLat(String(lat));
        setNearestLng(String(lng));
        setNearestLocating(false);
        runNearestSearch(lat, lng);
      },
      () => {
        setNearestLocating(false);
        setNearestStatus('Could not get your location — enter coordinates manually.');
      },
      { timeout: 8000, enableHighAccuracy: true },
    );
  }

  // ── Edit/Add modal ──
  function openAddModal() {
    if (!isAdmin) return;
    setEditId(null);
    setEditForm(emptyForm(operator));
    setEditErr('');
    setEditOpen(true);
  }

  function openEditModal(site: Site) {
    if (!isAdmin) return;
    setEditId(site.id);
    setEditForm(siteToForm(site));
    setEditErr('');
    setDetailRow(null);
    setEditOpen(true);
  }

  function setField(key: keyof EditForm, val: string) {
    setEditForm(prev => ({ ...prev, [key]: val }));
  }

  async function saveSite() {
    setEditErr('');
    const code = editForm.site_code.trim();
    if (!code) { setEditErr('Site Code is required.'); return; }
    if (!editForm.operator) { setEditErr('Operator is required.'); return; }

    let lat: number | null = null;
    let lng: number | null = null;
    let height: number | null = null;

    if (editForm.latitude.trim() !== '') {
      lat = Number(editForm.latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) { setEditErr('Latitude must be a number between -90 and 90.'); return; }
    }
    if (editForm.longitude.trim() !== '') {
      lng = Number(editForm.longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) { setEditErr('Longitude must be a number between -180 and 180.'); return; }
    }
    if (editForm.tower_height.trim() !== '') {
      height = Number(editForm.tower_height);
      if (isNaN(height)) { setEditErr('Tower Height must be a number.'); return; }
    }

    const payload: Omit<Site, 'id'> = {
      operator: editForm.operator,
      site_code: code,
      site_name: editForm.site_name.trim() || null,
      governorate: editForm.governorate.trim() || null,
      city: editForm.city.trim() || null,
      latitude: lat,
      longitude: lng,
      site_type: editForm.site_type.trim() || null,
      tower_height: height,
      topology: editForm.topology.trim() || null,
      cabina_type: editForm.cabina_type.trim() || null,
      installation_type: editForm.installation_type.trim() || null,
      antenna: editForm.antenna.trim() || null,
      vendor: editForm.vendor.trim() || null,
      status: editForm.status.trim() || null,
    };

    setSaving(true);
    try {
      if (editId) {
        const { error } = await supabase.from('sites').update(payload).eq('id', editId);
        if (error) throw error;
        setDataCache(prev => ({
          ...prev,
          [payload.operator]: (prev[payload.operator] ?? []).map(s =>
            s.id === editId ? { ...s, ...payload } : s
          ),
        }));
        invalidateCache();
        showToast('Site updated', true);
      } else {
        const { data, error } = await supabase.from('sites').insert(payload).select('id').single();
        if (error) throw error;
        const newSite: Site = { id: (data as { id: string }).id, ...payload };
        setDataCache(prev => ({
          ...prev,
          [payload.operator]: [...(prev[payload.operator] ?? []), newSite],
        }));
        invalidateCache();
        showToast('Site added', true);
      }
      setEditOpen(false);
      setEditId(null);
    } catch (e: unknown) {
      setEditErr(e instanceof Error ? e.message : 'Save failed');
    }
    setSaving(false);
  }

  // ── Delete ──
  function openDeleteModal() { if (!isAdmin || !detailRow) return; setDeleteOpen(true); }

  async function confirmDelete() {
    if (!detailRow) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('sites').delete().eq('id', detailRow.id);
      if (error) throw error;
      setDataCache(prev => ({
        ...prev,
        [detailRow.operator]: (prev[detailRow.operator] ?? []).filter(s => s.id !== detailRow.id),
      }));
      invalidateCache();
      setDeleteOpen(false);
      setDetailRow(null);
      showToast('Site deleted', true);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Delete failed', false);
    }
    setDeleting(false);
  }

  // ── Export ──
  function exportSites() {
    if (!filtered.length) { showToast('No sites to export', false); return; }
    const data = filtered.map(r => ({
      'Operator':          r.operator        ?? '',
      'Site Code':         r.site_code       ?? '',
      'Site Name':         r.site_name       ?? '',
      'Governorate':       r.governorate     ?? '',
      'City':              r.city            ?? '',
      'Latitude':          r.latitude  != null ? r.latitude  : '',
      'Longitude':         r.longitude != null ? r.longitude : '',
      'Site Type':         r.site_type       ?? '',
      'Tower Height (m)':  r.tower_height != null ? r.tower_height : '',
      'Topology':          r.topology        ?? '',
      'Cabina Type':       r.cabina_type     ?? '',
      'Installation Type': r.installation_type ?? '',
      'Antenna':           r.antenna         ?? '',
      'Vendor':            r.vendor          ?? '',
      'Status':            r.status          ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [
      { wch: 12 }, { wch: 14 }, { wch: 26 }, { wch: 16 }, { wch: 16 },
      { wch: 11 }, { wch: 11 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 10 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, operator.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 31));
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Sites_DB_${operator.replace(/\s+/g, '_')}_${dateStr}.xlsx`);
    showToast(`Exported ${filtered.length} site${filtered.length !== 1 ? 's' : ''}`, true);
  }

  // ── Import / Enrich modal ──
  const allOperatorsLoaded = OPERATORS.every(op => op in dataCache);

  function openImportModal() {
    if (!isAdmin) return;
    importRawRowsRef.current = [];
    enrichRowsRef.current = [];
    enrichHeadersRef.current = [];
    enrichCodeKeyRef.current = null;
    enrichOpKeyRef.current = null;
    setImportOperator(operator);
    setImportFileName('');
    setImportStatus('');
    setImportNewRows([]);
    setImportDupRows([]);
    setImportInvalidCount(0);
    setImporting(false);
    setImportDragOver(false);
    setEnrichDragOver(false);
    setEnrichFileName('');
    setEnrichStatus('');
    setEnrichChecked(new Set(['governorate', 'city', 'latitude', 'longitude']));
    setEnrichReady(false);
    setImportOpen(true);
  }

  function processImportRows(rawRows: Record<string, unknown>[], op: string) {
    if (!allOperatorsLoaded) {
      setImportStatus('Full site list still loading — wait a moment then re-select the file.');
      return;
    }
    const existingKeys = new Set(
      allSites.map(r => `${(r.operator ?? '').trim().toLowerCase()}|${(r.site_code ?? '').trim().toLowerCase()}`)
    );
    const newRows: ImportRow[] = [];
    const dupRows: ImportRow[] = [];
    let invalidCount = 0;
    const seenInBatch = new Set<string>();

    for (const raw of rawRows) {
      const norm: Record<string, unknown> = {};
      for (const k of Object.keys(raw)) {
        const field = SDB_IMPORT_FIELD_MAP[normHeader(k)];
        if (field) norm[field] = raw[k];
      }
      if (!Object.values(norm).some(v => String(v ?? '').trim() !== '')) continue;

      const site_code = String(norm['site_code'] ?? '').trim();
      if (!site_code) { invalidCount++; continue; }

      const latRaw = norm['latitude'],    lngRaw = norm['longitude'],   hRaw = norm['tower_height'];
      const lat    = latRaw !== undefined && String(latRaw).trim() !== '' ? parseFloat(String(latRaw)) : null;
      const lng    = lngRaw !== undefined && String(lngRaw).trim() !== '' ? parseFloat(String(lngRaw)) : null;
      const height = hRaw   !== undefined && String(hRaw).trim()   !== '' ? parseFloat(String(hRaw))   : null;

      const payload: ImportRow = {
        operator: op, site_code,
        site_name:         String(norm['site_name']         ?? '').trim() || null,
        governorate:       String(norm['governorate']       ?? '').trim() || null,
        city:              String(norm['city']              ?? '').trim() || null,
        latitude:          Number.isFinite(lat)    ? lat    : null,
        longitude:         Number.isFinite(lng)    ? lng    : null,
        site_type:         String(norm['site_type']         ?? '').trim() || null,
        tower_height:      Number.isFinite(height) ? height : null,
        topology:          String(norm['topology']          ?? '').trim() || null,
        cabina_type:       String(norm['cabina_type']       ?? '').trim() || null,
        installation_type: String(norm['installation_type'] ?? '').trim() || null,
        antenna:           String(norm['antenna']           ?? '').trim() || null,
        vendor:            String(norm['vendor']            ?? '').trim() || null,
        status:            String(norm['status']            ?? '').trim() || null,
      };

      const key = `${op.toLowerCase()}|${site_code.toLowerCase()}`;
      if (existingKeys.has(key) || seenInBatch.has(key)) {
        dupRows.push(payload);
      } else {
        seenInBatch.add(key);
        newRows.push(payload);
      }
    }
    setImportNewRows(newRows);
    setImportDupRows(dupRows);
    setImportInvalidCount(invalidCount);
    setImportStatus('');
  }

  function handleImportOperatorChange(op: string) {
    setImportOperator(op);
    if (importRawRowsRef.current.length) {
      if (!op) {
        setImportStatus('Select an operator above first.');
        setImportNewRows([]); setImportDupRows([]); setImportInvalidCount(0);
      } else {
        processImportRows(importRawRowsRef.current, op);
      }
    }
  }

  function handleImportFile(file: File) {
    if (!importOperator) { setImportStatus('Select an operator above first.'); return; }
    setImportFileName(file.name);
    setImportStatus('Reading file…');
    setImportNewRows([]); setImportDupRows([]); setImportInvalidCount(0);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target!.result as ArrayBuffer, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }) as Record<string, unknown>[];
        importRawRowsRef.current = rows;
        processImportRows(rows, importOperator);
      } catch (err) {
        setImportStatus(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.onerror = () => setImportStatus('Could not read file.');
    reader.readAsArrayBuffer(file);
  }

  async function confirmImport() {
    const rows = importNewRows;
    if (!rows.length) return;
    setImporting(true);
    const CHUNK = 200;
    let inserted = 0;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { data, error } = await supabase.from('sites').insert(chunk).select('id, operator, site_code');
        if (error) throw error;
        const chunkSites = ((data ?? []) as { id: string; operator: string; site_code: string }[]).map(d => {
          const match = chunk.find(c => c.site_code === d.site_code && c.operator === d.operator);
          return match ? ({ ...match, id: d.id } as Site) : null;
        }).filter(Boolean) as Site[];
        if (chunkSites.length) {
          setDataCache(prev => ({ ...prev, [importOperator]: [...(prev[importOperator] ?? []), ...chunkSites] }));
          invalidateCache();
        }
        inserted += (data ?? []).length;
        setImportStatus(`Imported ${inserted} of ${rows.length}…`);
      }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Import failed', false);
      setImporting(false);
      return;
    }
    showToast(`Imported ${inserted} new site${inserted !== 1 ? 's' : ''}`, true);
    setImportNewRows([]);
    setImportStatus(`Done — ${inserted} site${inserted !== 1 ? 's' : ''} added.`);
    setImporting(false);
  }

  function enrichFindSite(row: Record<string, unknown>): Site | null {
    const codeKey = enrichCodeKeyRef.current;
    if (!codeKey) return null;
    const code = String(row[codeKey] ?? '').trim().toLowerCase();
    if (!code) return null;
    const opKey = enrichOpKeyRef.current;
    const op = opKey ? String(row[opKey] ?? '').trim().toLowerCase() : null;
    return allSites.find(s =>
      String(s.site_code ?? '').trim().toLowerCase() === code &&
      (!op || String(s.operator ?? '').trim().toLowerCase() === op)
    ) ?? null;
  }

  function handleEnrichFile(file: File) {
    if (!allOperatorsLoaded) {
      setEnrichStatus('Full site list still loading — wait a moment then re-select the file.');
      return;
    }
    setEnrichFileName(file.name);
    setEnrichStatus('Reading file…');
    setEnrichReady(false);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target!.result as ArrayBuffer, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }) as Record<string, unknown>[];
        if (!rows.length) { setEnrichStatus('No rows found in this file.'); return; }

        const headers = Object.keys(rows[0]);
        const codeKey = headers.find(h => ['siteid', 'sitecode', 'code', 'id', 'siteidcode'].includes(normHeader(h))) ?? null;
        if (!codeKey) { setEnrichStatus('Could not find a Site Code / Site ID column in this file.'); return; }
        const opKey = headers.find(h => normHeader(h) === 'operator') ?? null;

        enrichRowsRef.current    = rows;
        enrichHeadersRef.current = headers;
        enrichCodeKeyRef.current = codeKey;
        enrichOpKeyRef.current   = opKey;

        const matched = rows.filter(r => {
          const c = String(r[codeKey] ?? '').trim().toLowerCase();
          if (!c) return false;
          const o = opKey ? String(r[opKey] ?? '').trim().toLowerCase() : null;
          return allSites.some(s =>
            String(s.site_code ?? '').trim().toLowerCase() === c &&
            (!o || String(s.operator ?? '').trim().toLowerCase() === o)
          );
        }).length;
        setEnrichStatus(`${matched} of ${rows.length} row${rows.length !== 1 ? 's' : ''} matched a site in the DB (by "${codeKey}").`);
        setEnrichReady(true);
      } catch (err) {
        setEnrichStatus(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.onerror = () => setEnrichStatus('Could not read file.');
    reader.readAsArrayBuffer(file);
  }

  function enrichDownload() {
    const rows = enrichRowsRef.current;
    if (!rows.length) return;
    const checked = SDB_ENRICH_FIELDS.filter(f => enrichChecked.has(f.id));
    if (!checked.length) { showToast('Pick at least one field to append', false); return; }

    const headers = enrichHeadersRef.current;
    const outRows = rows.map(row => {
      const site = enrichFindSite(row);
      const extra: Record<string, unknown> = {};
      for (const f of checked) {
        const v = site ? (site[f.id as keyof Site] ?? null) : null;
        extra[f.label] = v != null ? v : '';
      }
      return { ...row, ...extra };
    });

    const ws = XLSX.utils.json_to_sheet(outRows, { header: [...headers, ...checked.map(f => f.label)] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enriched');
    XLSX.writeFile(wb, `Enriched_Sites_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Enriched file downloaded', true);
  }

  // ── Render helpers ──
  function statusBadge(s: string | null) {
    if (!s) return null;
    const isOnAir = s.toLowerCase() === 'onair';
    return <span className={isOnAir ? styles.statusBadgeOnAir : styles.statusBadgeOther}>{s}</span>;
  }

  function df(label: string, value: string | number | null, icon: React.ReactNode) {
    return (
      <div className={styles.detailField} key={label}>
        <div className={styles.detailIcon}>{icon}</div>
        <div className={styles.detailBody}>
          <span className={styles.detailLabel}>{label}</span>
          <span className={styles.detailValue}>{value != null && value !== '' ? String(value) : '—'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Page header ── */}
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>Sites DB</h2>
        <div className={styles.subtitle}>{subtitle}</div>
      </div>

      {/* ── Operator tabs + List/Map toggle ── */}
      <div className={styles.tabRow}>
        <div className={styles.tabGroup}>
          {OPERATORS.map(op => (
            <button
              key={op}
              className={`${styles.tabBtn} ${operator === op ? styles.tabBtnActive : ''}`}
              onClick={() => switchOperator(op)}
            >
              {op}
            </button>
          ))}
        </div>
        <div className={styles.tabGroup}>
          <button
            className={`${styles.tabBtn} ${view === 'list' ? styles.tabBtnActive : ''}`}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            className={`${styles.tabBtn} ${view === 'map' ? styles.tabBtnActive : ''}`}
            onClick={() => setView('map')}
          >
            Map
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search site code, name, governorate, city…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className={styles.filterSelect}
          value={govFilter}
          onChange={e => setGovFilter(e.target.value)}
        >
          <option value="">All Governorates</option>
          {govOptions.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <select
          className={styles.filterSelect}
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
        >
          <option value="">All Site Types</option>
          {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        {healthFilter && (
          <span className={styles.healthChip}>
            {healthLabel(healthFilter)}
            <button className={styles.healthChipX} onClick={() => setHealthFilter('')} title="Clear filter">×</button>
          </span>
        )}

        {anyFilterActive && (
          <button className={`${styles.btnGhost} ${styles.btnClearFilters}`} onClick={clearAllFilters}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
            Clear Filters
          </button>
        )}

        <div className={styles.toolbarRight}>
          <button className={styles.btnGhost} onClick={openNearestModal}>
            Find Nearest Site
          </button>
          <button className={styles.btnGhost} onClick={() => setHealthOpen(true)}>
            Data Health
          </button>
          <button className={styles.btnGhost} onClick={exportSites}>
            Export
          </button>
          {isAdmin && (
            <>
              <button className={styles.btnGhost} onClick={openImportModal}>
                Import / Enrich
              </button>
              <button className={styles.btnPrimary} onClick={openAddModal}>
                + Add Site
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Bulk filter ── */}
      <div className={styles.bulkFilter}>
        <div className={styles.bulkFilterLabel}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
          </svg>
          Bulk Filter by Site IDs
        </div>
        <div className={styles.bulkFilterRow}>
          <textarea
            className={styles.bulkTextarea}
            placeholder="Paste IDs separated by spaces, commas, semicolons, or newlines"
            value={bulkText}
            onChange={e => setBulkText(e.target.value)}
          />
          <button className={styles.btnPrimary} onClick={applyBulkFilter}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
            </svg>
            Filter
          </button>
        </div>
        {bulkIds.length > 0 && (
          <div className={styles.bulkStatus}>
            Filtering to <strong style={{ margin: '0 3px' }}>{bulkIds.length}</strong> pasted ID{bulkIds.length !== 1 ? 's' : ''}
            <button className={styles.bulkStatusClear} onClick={clearBulkFilter}>Clear</button>
          </div>
        )}
      </div>

      {/* ── Map view (always mounted, hidden when list view is active to preserve pan/zoom) ── */}
      <div style={{ display: view === 'map' ? 'block' : 'none' }}>
        <SiteMapView sites={filtered} onViewSite={openDetail} />
      </div>

      {/* ── List view ── */}
      {view === 'list' && (
        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Site Code</th>
                  <th>Site Name</th>
                  <th>Governorate</th>
                  <th>City</th>
                  <th>Latitude</th>
                  <th>Longitude</th>
                  <th>Site Type</th>
                  <th>Tower Height</th>
                  <th>Topology</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className={styles.empty}>Loading…</td></tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={10} className={styles.empty}>
                      {operator === 'Asia Cell' ? 'No Asia Cell sites yet.' : 'No sites match the current search.'}
                    </td>
                  </tr>
                ) : visible.map(r => (
                  <tr key={r.id}>
                    <td className={styles.siteCodeCell}>{r.site_code || '—'}</td>
                    <td>{r.site_name || '—'}</td>
                    <td>{r.governorate || '—'}</td>
                    <td>{r.city || '—'}</td>
                    <td className={styles.monoCell}>{r.latitude != null ? r.latitude : '—'}</td>
                    <td className={styles.monoCell}>{r.longitude != null ? r.longitude : '—'}</td>
                    <td>{r.site_type || '—'}</td>
                    <td>{r.tower_height != null ? r.tower_height : '—'}</td>
                    <td>{r.topology || '—'}</td>
                    <td>
                      <button className={styles.viewBtn} onClick={() => openDetail(r)}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          SITE DETAIL MODAL
      ══════════════════════════════════════════ */}
      {detailRow && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setDetailRow(null); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>
                {detailRow.site_name || detailRow.site_code || 'Site Detail'}
              </h3>
              <button className={styles.modalClose} onClick={() => setDetailRow(null)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.detailBadgeRow}>
                <span className={styles.opBadge}>{detailRow.operator || '—'}</span>
                {statusBadge(detailRow.status)}
              </div>

              {detailRow.latitude != null && detailRow.longitude != null && (
                <div className={styles.mapsRow}>
                  <a
                    className={`${styles.mapsLink} ${styles.mapsLinkGoogle}`}
                    href={`https://www.google.com/maps?q=${detailRow.latitude},${detailRow.longitude}`}
                    target="_blank" rel="noreferrer"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                      <circle cx="12" cy="10" r="3"/>
                    </svg>
                    Google Maps
                  </a>
                  <a
                    className={`${styles.mapsLink} ${styles.mapsLinkWaze}`}
                    href={`https://waze.com/ul?ll=${detailRow.latitude},${detailRow.longitude}&navigate=yes`}
                    target="_blank" rel="noreferrer"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="3 11 22 2 13 21 11 13 3 11"/>
                    </svg>
                    Waze
                  </a>
                </div>
              )}

              <div className={styles.detailGrid}>
                {df('Site Code',        detailRow.site_code, <SvgCode />)}
                {df('Site Name',        detailRow.site_name, <SvgName />)}
                {df('Governorate',      detailRow.governorate, <SvgMap />)}
                {df('City',             detailRow.city, <SvgPin />)}
                {df('Latitude',         detailRow.latitude, <SvgNav />)}
                {df('Longitude',        detailRow.longitude, <SvgNav />)}
                {df('Site Type',        detailRow.site_type, <SvgLayers />)}
                {df('Tower Height (m)', detailRow.tower_height, <SvgTrend />)}
                {df('Topology',         detailRow.topology, <SvgShare />)}
                {df('Cabina Type',      detailRow.cabina_type, <SvgBox />)}
                {df('Installation',     detailRow.installation_type, <SvgTool />)}
                {df('Antenna',          detailRow.antenna, <SvgAntenna />)}
                {df('Vendor',           detailRow.vendor, <SvgBriefcase />)}
              </div>
            </div>
            <div className={styles.modalFooter}>
              {isAdmin ? (
                <>
                  <button className={styles.btnDanger} onClick={openDeleteModal}>Delete</button>
                  <div className={styles.modalFooterRight}>
                    <button className={styles.btnGhost} onClick={() => setDetailRow(null)}>Close</button>
                    <button className={styles.btnPrimary} onClick={() => openEditModal(detailRow)}>Edit</button>
                  </div>
                </>
              ) : (
                <button className={styles.btnGhost} onClick={() => setDetailRow(null)} style={{ marginLeft: 'auto' }}>Close</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          FIND NEAREST SITE MODAL
      ══════════════════════════════════════════ */}
      {nearestOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setNearestOpen(false); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>Find Nearest Site</h3>
              <button className={styles.modalClose} onClick={() => setNearestOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.nearestCoordRow}>
                <div className={styles.nearestField}>
                  <label>Latitude</label>
                  <input
                    type="number"
                    step="any"
                    placeholder="e.g. 33.3152"
                    value={nearestLat}
                    onChange={e => setNearestLat(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') nearestSearch(); }}
                  />
                </div>
                <div className={styles.nearestField}>
                  <label>Longitude</label>
                  <input
                    type="number"
                    step="any"
                    placeholder="e.g. 44.3661"
                    value={nearestLng}
                    onChange={e => setNearestLng(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') nearestSearch(); }}
                  />
                </div>
                <button
                  className={styles.btnGhost}
                  onClick={useMyLocation}
                  disabled={nearestLocating}
                  style={{ alignSelf: 'flex-end' }}
                >
                  {nearestLocating ? 'Locating…' : 'Use My Location'}
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={nearestSearch}
                  style={{ alignSelf: 'flex-end' }}
                >
                  Search
                </button>
              </div>

              {nearestStatus && (
                <div className={styles.nearestStatus}>{nearestStatus}</div>
              )}

              {nearestResults.map(({ site: r, km }) => (
                <div key={r.id} className={styles.nearestRow}>
                  <div className={styles.nearestInfo}>
                    <div className={styles.nearestCode}>
                      {r.site_code || '—'}{' '}
                      <span className={styles.nearestOp}>· {r.operator}</span>
                    </div>
                    <div className={styles.nearestMeta}>
                      {[r.site_name, r.city, r.governorate].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <div className={styles.nearestRight}>
                    <span className={styles.nearestDist}>{fmtDist(km)}</span>
                    <button
                      className={styles.viewBtn}
                      onClick={() => { setNearestOpen(false); openDetail(r); }}
                    >
                      View
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className={styles.modalFooter}>
              <div className={styles.modalFooterRight}>
                <button className={styles.btnGhost} onClick={() => setNearestOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          ADD / EDIT MODAL
      ══════════════════════════════════════════ */}
      {editOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setEditOpen(false); }}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>{editId ? 'Edit Site' : 'Add Site'}</h3>
              <button className={styles.modalClose} onClick={() => setEditOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.editGrid}>
                <div className={styles.editField}>
                  <label>Operator *</label>
                  <select value={editForm.operator} onChange={e => setField('operator', e.target.value)}>
                    {OPERATORS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.editField}>
                  <label>Site Code *</label>
                  <input type="text" value={editForm.site_code} onChange={e => setField('site_code', e.target.value)} placeholder="e.g. ZN001" />
                </div>
                <div className={styles.editField}>
                  <label>Site Name</label>
                  <input type="text" value={editForm.site_name} onChange={e => setField('site_name', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Governorate</label>
                  <input type="text" value={editForm.governorate} onChange={e => setField('governorate', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>City</label>
                  <input type="text" value={editForm.city} onChange={e => setField('city', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Latitude</label>
                  <input type="number" step="any" value={editForm.latitude} onChange={e => setField('latitude', e.target.value)} placeholder="-90 to 90" />
                </div>
                <div className={styles.editField}>
                  <label>Longitude</label>
                  <input type="number" step="any" value={editForm.longitude} onChange={e => setField('longitude', e.target.value)} placeholder="-180 to 180" />
                </div>
                <div className={styles.editField}>
                  <label>Site Type</label>
                  <input type="text" value={editForm.site_type} onChange={e => setField('site_type', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Tower Height (m)</label>
                  <input type="number" step="any" value={editForm.tower_height} onChange={e => setField('tower_height', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Topology</label>
                  <input type="text" value={editForm.topology} onChange={e => setField('topology', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Cabina Type</label>
                  <input type="text" value={editForm.cabina_type} onChange={e => setField('cabina_type', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Installation Type</label>
                  <input type="text" value={editForm.installation_type} onChange={e => setField('installation_type', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Antenna</label>
                  <input type="text" value={editForm.antenna} onChange={e => setField('antenna', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Vendor</label>
                  <input type="text" value={editForm.vendor} onChange={e => setField('vendor', e.target.value)} />
                </div>
                <div className={styles.editField}>
                  <label>Status</label>
                  <input type="text" value={editForm.status} onChange={e => setField('status', e.target.value)} placeholder="e.g. OnAir" />
                </div>
              </div>
              {editErr && <div className={styles.editErr}>{editErr}</div>}
            </div>
            <div className={styles.modalFooter}>
              <div className={styles.modalFooterRight}>
                <button className={styles.btnGhost} onClick={() => setEditOpen(false)}>Cancel</button>
                <button className={styles.btnPrimary} onClick={saveSite} disabled={saving}>
                  {saving ? 'Saving…' : editId ? 'Save Changes' : 'Add Site'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          DELETE MODAL
      ══════════════════════════════════════════ */}
      {deleteOpen && detailRow && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setDeleteOpen(false); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>Delete Site</h3>
              <button className={styles.modalClose} onClick={() => setDeleteOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <p className={styles.deleteMsg}>
                Are you sure you want to delete{' '}
                <strong>"{detailRow.site_name || detailRow.site_code}"</strong>?
                This action cannot be undone.
              </p>
            </div>
            <div className={styles.modalFooter}>
              <div className={styles.modalFooterRight}>
                <button className={styles.btnGhost} onClick={() => setDeleteOpen(false)}>Cancel</button>
                <button className={styles.btnDanger} onClick={confirmDelete} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          IMPORT / ENRICH MODAL
      ══════════════════════════════════════════ */}
      {importOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setImportOpen(false); }}>
          <div className={`${styles.modal} ${styles.modalTools}`} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <div>
                <h3 className={styles.modalTitle}>Sites DB Tools</h3>
                <p className={styles.toolsSubtitle}>
                  Import new sites into the database, or enrich your own spreadsheet with data already in the Sites DB.
                </p>
              </div>
              <button className={styles.modalClose} onClick={() => setImportOpen(false)}>×</button>
            </div>

            <div className={styles.modalBody}>

              {/* ── Card 1: Import Sites ── */}
              <div className={styles.sdbToolCard}>
                <div className={styles.sdbToolHead}>
                  <div className={`${styles.sdbToolIcon} ${styles.sdbIconBlue}`}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/>
                      <path d="M12 12v9"/>
                      <path d="m16 16-4-4-4 4"/>
                    </svg>
                  </div>
                  <div>
                    <div className={styles.sdbToolTitle}>Import Sites</div>
                    <div className={styles.sdbToolDesc}>
                      1. Choose the operator. 2. Upload any Excel — matching columns (Site Code, Latitude, Longitude, Governorate, etc.) are detected automatically, whatever the file has; anything not found is left blank. New site codes are added — codes that already exist for that operator are skipped and highlighted below (nothing gets overwritten).
                    </div>
                  </div>
                </div>

                <div style={{ marginBottom: 12, maxWidth: 260 }}>
                  <label className={styles.sdbFieldLabel}>1. Operator</label>
                  <select
                    className={styles.sdbSelect}
                    value={importOperator}
                    onChange={e => handleImportOperatorChange(e.target.value)}
                  >
                    <option value="">Select operator…</option>
                    {OPERATORS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>

                <div className={styles.sdbToolRow}>
                  <div
                    className={`${styles.sdbDropzone} ${importDragOver ? styles.sdbDropzoneOver : ''}`}
                    onClick={() => importFileRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setImportDragOver(true); }}
                    onDragLeave={() => setImportDragOver(false)}
                    onDrop={e => {
                      e.preventDefault(); setImportDragOver(false);
                      const f = e.dataTransfer.files?.[0]; if (f) handleImportFile(f);
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/>
                      <path d="M12 12v9"/>
                      <path d="m16 16-4-4-4 4"/>
                    </svg>
                    <div className={styles.sdbDropzoneMain}><b>Drop Excel here</b> or click to browse</div>
                    <div className={styles.sdbDropzoneFile}>{importFileName || 'No file selected'}</div>
                  </div>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }}
                  />
                  <div className={styles.sdbToolActions}>
                    <button
                      className={styles.btnPrimary}
                      onClick={confirmImport}
                      disabled={!importNewRows.length || importing}
                    >
                      {importing ? 'Importing…' : 'Import & Merge'}
                    </button>
                  </div>
                </div>

                {importStatus && <div className={styles.sdbToolStatus}>{importStatus}</div>}

                {(importNewRows.length > 0 || importDupRows.length > 0 || importInvalidCount > 0) && (
                  <div style={{ marginTop: 14 }}>
                    <div className={styles.importCards}>
                      <div className={`${styles.importCard} ${styles.importCardGreen}`}>
                        <div className={styles.importCardCount}>{importNewRows.length}</div>
                        <div className={styles.importCardLabel}>New sites to import</div>
                      </div>
                      <div className={`${styles.importCard} ${styles.importCardAmber}`}>
                        <div className={styles.importCardCount}>{importDupRows.length}</div>
                        <div className={styles.importCardLabel}>Duplicates skipped</div>
                      </div>
                      {importInvalidCount > 0 && (
                        <div className={`${styles.importCard} ${styles.importCardRed}`}>
                          <div className={styles.importCardCount}>{importInvalidCount}</div>
                          <div className={styles.importCardLabel}>Invalid (missing Site Code)</div>
                        </div>
                      )}
                    </div>

                    {importDupRows.length > 0 && (
                      <>
                        <div className={styles.importListTitle}>Duplicates — already in Sites DB, not imported</div>
                        <div className={`${styles.importList} ${styles.importListAmber}`}>
                          {importDupRows.map((r, i) => (
                            <div key={i} className={styles.importListRow}>
                              <div>
                                <div className={styles.importListCode}>
                                  {r.site_code}{' '}
                                  <span className={styles.importListOp}>· {r.operator}</span>
                                </div>
                                <div className={styles.importListMeta}>{r.site_name || '—'}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {importNewRows.length > 0 && (
                      <>
                        <div className={styles.importListTitle}>New sites — will be added</div>
                        <div className={styles.importList}>
                          {importNewRows.slice(0, 300).map((r, i) => (
                            <div key={i} className={styles.importListRow}>
                              <div style={{ minWidth: 0 }}>
                                <div className={styles.importListCode}>
                                  {r.site_code}{' '}
                                  <span className={styles.importListOp}>· {r.operator}</span>
                                </div>
                                <div className={styles.importListMeta}>
                                  {[r.site_name, r.city, r.governorate].filter(Boolean).join(' · ') || '—'}
                                </div>
                              </div>
                              {r.latitude == null || r.longitude == null
                                ? <span className={styles.noCoordsTag}>no coords</span>
                                : <span className={styles.coordsTag}>{r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}</span>
                              }
                            </div>
                          ))}
                          {importNewRows.length > 300 && (
                            <div className={styles.importListMore}>…and {importNewRows.length - 300} more</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* ── Card 2: Enrich Sheet ── */}
              <div className={styles.sdbToolCard}>
                <div className={styles.sdbToolHead}>
                  <div className={`${styles.sdbToolIcon} ${styles.sdbIconGreen}`}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                    </svg>
                  </div>
                  <div>
                    <div className={styles.sdbToolTitle}>Enrich Sheet with Sites DB</div>
                    <div className={styles.sdbToolDesc}>
                      Upload any Excel that has a Site Code column. Pick which fields to append — they'll be added as new columns on the right of your sheet, then downloaded as a new file.
                    </div>
                  </div>
                </div>

                <div className={styles.sdbToolRow}>
                  <div
                    className={`${styles.sdbDropzone} ${enrichDragOver ? styles.sdbDropzoneOver : ''}`}
                    onClick={() => enrichFileRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setEnrichDragOver(true); }}
                    onDragLeave={() => setEnrichDragOver(false)}
                    onDrop={e => {
                      e.preventDefault(); setEnrichDragOver(false);
                      const f = e.dataTransfer.files?.[0]; if (f) handleEnrichFile(f);
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                    </svg>
                    <div className={styles.sdbDropzoneMain}><b>Drop Excel here</b> or click to browse</div>
                    <div className={styles.sdbDropzoneFile}>{enrichFileName || 'No file selected'}</div>
                  </div>
                  <input
                    ref={enrichFileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleEnrichFile(f); e.target.value = ''; }}
                  />
                  <div className={styles.sdbToolActions}>
                    <button
                      className={styles.btnPrimary}
                      onClick={enrichDownload}
                      disabled={!enrichReady || enrichChecked.size === 0}
                    >
                      Enrich & Download
                    </button>
                  </div>
                </div>

                <div className={styles.sdbAppendBar}>
                  <span className={styles.sdbAppendLabel}>Append:</span>
                  {SDB_ENRICH_FIELDS.map(f => (
                    <label key={f.id} className={styles.sdbAppendCheck}>
                      <input
                        type="checkbox"
                        checked={enrichChecked.has(f.id)}
                        onChange={e => {
                          setEnrichChecked(prev => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(f.id) : next.delete(f.id);
                            return next;
                          });
                        }}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>

                {enrichStatus && <div className={styles.sdbToolStatus}>{enrichStatus}</div>}
              </div>

            </div>

            <div className={styles.modalFooter}>
              <div className={styles.modalFooterRight}>
                <button className={styles.btnGhost} onClick={() => setImportOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          DATA HEALTH MODAL
      ══════════════════════════════════════════ */}
      {healthOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setHealthOpen(false); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>Data Health — {operator}</h3>
              <button className={styles.modalClose} onClick={() => setHealthOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              {loading ? (
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>Loading…</p>
              ) : opRows.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
                  No sites for {operator} yet.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>
                    {opRows.length.toLocaleString()} site{opRows.length !== 1 ? 's' : ''} total
                  </p>
                  {HEALTH_FIELDS.map(f => {
                    const missing = opRows.filter(f.test).length;
                    const pct = opRows.length ? Math.round((missing / opRows.length) * 100) : 0;
                    return (
                      <div key={f.key} className={styles.healthRow}>
                        <div className={styles.healthRowLeft}>
                          <div className={styles.healthRowName}>{f.label}</div>
                          <div className={styles.healthRowCount}>
                            {missing.toLocaleString()} of {opRows.length.toLocaleString()} ({pct}%)
                          </div>
                        </div>
                        {missing > 0 ? (
                          <button className={styles.viewBtn} onClick={() => applyHealthFilter(f.key)}>
                            View
                          </button>
                        ) : (
                          <span className={styles.healthComplete}>✓ Complete</span>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            <div className={styles.modalFooter}>
              <div className={styles.modalFooterRight}>
                <button className={styles.btnGhost} onClick={() => setHealthOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Inline SVG icon components ── */
function SvgCode() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/>
    <line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>
  </svg>;
}
function SvgName() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
  </svg>;
}
function SvgMap() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
    <line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
  </svg>;
}
function SvgPin() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
  </svg>;
}
function SvgNav() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="3 11 22 2 13 21 11 13 3 11"/>
  </svg>;
}
function SvgLayers() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
  </svg>;
}
function SvgTrend() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
    <polyline points="17 6 23 6 23 12"/>
  </svg>;
}
function SvgShare() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
  </svg>;
}
function SvgBox() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
  </svg>;
}
function SvgTool() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>;
}
function SvgAntenna() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="2"/>
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>
  </svg>;
}
function SvgBriefcase() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
  </svg>;
}
