import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { cacheOk, getSitesByOperator, loadPreview as loadSitePreview, ensureFullLoad as ensureSitesFullLoad, invalidateCache } from '../lib/sitesCache';
import { haversineKm, fmtDist } from '../lib/sitesNearest';
import { addBaseLayer, createStyleToggleControl } from '../lib/mapboxTiles';
import styles from './SitesDB.module.css';

delete (L.Icon.Default.prototype as any)._getIconUrl; // eslint-disable-line @typescript-eslint/no-explicit-any
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const OPERATORS = ['Zain', 'Asia Cell'] as const;
type Operator = typeof OPERATORS[number];

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

type HealthStatus = 'complete' | 'nocoords' | 'incomplete' | 'review';

function siteHealthStatus(r: Site): { label: string; status: HealthStatus } {
  const issues = HEALTH_FIELDS.filter(f => f.test(r));
  if (issues.length === 0) return { label: 'Complete', status: 'complete' };
  if (r.latitude == null || r.longitude == null) return { label: 'No Coords', status: 'nocoords' };
  if (issues.length <= 2) return { label: 'Incomplete', status: 'incomplete' };
  return { label: 'Needs Review', status: 'review' };
}

interface EditForm {
  operator: string; site_code: string; site_name: string; governorate: string;
  city: string; latitude: string; longitude: string; site_type: string;
  tower_height: string; topology: string; cabina_type: string; installation_type: string;
  antenna: string; vendor: string; status: string;
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
    operator: s.operator, site_code: s.site_code,
    site_name: s.site_name ?? '', governorate: s.governorate ?? '',
    city: s.city ?? '', latitude: s.latitude != null ? String(s.latitude) : '',
    longitude: s.longitude != null ? String(s.longitude) : '',
    site_type: s.site_type ?? '', tower_height: s.tower_height != null ? String(s.tower_height) : '',
    topology: s.topology ?? '', cabina_type: s.cabina_type ?? '',
    installation_type: s.installation_type ?? '', antenna: s.antenna ?? '',
    vendor: s.vendor ?? '', status: s.status ?? '',
  };
}

interface SiteMapViewProps { sites: Site[]; onViewSite: (site: Site) => void; }

function SiteMapView({ sites, onViewSite }: SiteMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<L.Map | null>(null);
  const clusterRef   = useRef<L.MarkerClusterGroup | null>(null);
  const onViewRef    = useRef(onViewSite);
  useEffect(() => { onViewRef.current = onViewSite; }, [onViewSite]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current).setView([33.3152, 44.3661], 6);
    const baseLayer = { layer: addBaseLayer(map, 'streets') };
    createStyleToggleControl(map, baseLayer);
    const cluster = L.markerClusterGroup();
    map.addLayer(cluster);
    mapRef.current = map; clusterRef.current = cluster;
    return () => { map.remove(); mapRef.current = null; clusterRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current; const cluster = clusterRef.current;
    if (!map || !cluster) return;
    cluster.clearLayers();
    const withCoords = sites.filter(r => r.latitude != null && r.longitude != null);
    withCoords.forEach(r => {
      const marker = L.marker([r.latitude!, r.longitude!]);
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
      popup.appendChild(title); popup.appendChild(meta); popup.appendChild(btn);
      marker.bindPopup(popup); cluster.addLayer(marker);
    });
    if (withCoords.length > 0) {
      try { map.fitBounds(cluster.getBounds(), { padding: [30, 30], maxZoom: 14 }); } catch { /* empty */ }
    }
    setTimeout(() => map.invalidateSize(), 50);
  }, [sites]);

  return <div ref={containerRef} className={styles.mapContainer} />;
}

interface SiteMiniMapProps { lat: number; lng: number; }

function SiteMiniMap({ lat, lng }: SiteMiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: false, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    }).setView([lat, lng], 14);
    addBaseLayer(map, 'streets');
    L.marker([lat, lng]).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);
    return () => { map.remove(); mapRef.current = null; };
  }, [lat, lng]);

  return <div ref={containerRef} className={styles.drawerMapThumb} />;
}

// ── Main component ──────────────────────────────────────────────────────────────

export default function SitesDB() {
  const { currentUser, hasPerm } = useAuth();

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
  const [bulkExpanded, setBulkExpanded] = useState(false);

  // ── Pagination ──
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

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
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

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

  // ── Load data ──
  useEffect(() => {
    let alive = true;
    if (cacheOk()) {
      const fromCache: Record<string, Site[]> = {};
      OPERATORS.forEach(op => { fromCache[op] = getSitesByOperator(op) as Site[]; });
      setDataCache(fromCache);
      return;
    }
    setLoading(true);
    loadSitePreview(operator).then(rows => {
      if (!alive) return;
      if (rows.length) { setDataCache(prev => ({ ...prev, [operator]: rows as Site[] })); setLoading(false); }
    });
    ensureSitesFullLoad(() => {
      if (!alive) return;
      const fromCache: Record<string, Site[]> = {};
      OPERATORS.forEach(op => { fromCache[op] = getSitesByOperator(op) as Site[]; });
      setDataCache(fromCache);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [search, govFilter, typeFilter, healthFilter, bulkIds, operator]);

  // Close row action menu on outside click
  useEffect(() => {
    if (!rowMenuId) return;
    const close = () => setRowMenuId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [rowMenuId]);

  function openDeleteModalFor(site: Site) {
    if (!hasPerm('sitesdb_delete')) return;
    setDetailRow(site); setDeleteOpen(true);
  }

  function switchOperator(op: Operator) {
    setOperator(op);
    setSearch(''); setGovFilter(''); setTypeFilter('');
    setHealthFilter(''); setBulkIds([]); setBulkText('');
    if (op in dataCache) return;
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

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pagedSites = filtered.slice(page * pageSize, (page + 1) * pageSize);

  const govOptions = [...new Set(opRows.map(r => r.governorate).filter(Boolean) as string[])].sort();
  const typeOptions = [...new Set(opRows.map(r => r.site_type).filter(Boolean) as string[])].sort();

  // Summary card values
  const zainCount = (dataCache['Zain'] ?? []).length;
  const asiaCellCount = (dataCache['Asia Cell'] ?? []).length;
  const dataIssuesCount = opRows.filter(r => HEALTH_FIELDS.some(f => f.test(r))).length;

  // Bulk text parsed count (for collapsed header display)
  const parsedBulkCount = bulkText.trim()
    ? [...new Set(bulkText.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))].length
    : 0;

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
    setView('list'); setHealthOpen(false);
  }

  // ── Detail drawer ──
  function openDetail(site: Site) { setDetailRow(site); }

  // ── Nearest-site modal ──
  function openNearestModal() {
    setNearestLat(''); setNearestLng(''); setNearestStatus(''); setNearestResults([]);
    setNearestOpen(true);
  }

  function runNearestSearch(lat: number, lng: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setNearestStatus('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
      setNearestResults([]); return;
    }
    const ranked = allSites
      .filter(r => r.latitude != null && r.longitude != null)
      .map(r => ({ site: r, km: haversineKm(lat, lng, r.latitude!, r.longitude!) }))
      .sort((a, b) => a.km - b.km).slice(0, 15);
    setNearestStatus(
      ranked.length
        ? `Nearest ${ranked.length} site${ranked.length !== 1 ? 's' : ''} to ${lat.toFixed(5)}, ${lng.toFixed(5)}:`
        : 'No sites with coordinates found.',
    );
    setNearestResults(ranked);
  }

  function nearestSearch() { runNearestSearch(parseFloat(nearestLat), parseFloat(nearestLng)); }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setNearestStatus('Geolocation is not available on this device/browser — enter coordinates manually.'); return;
    }
    setNearestLocating(true); setNearestStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = pos.coords.latitude; const lng = pos.coords.longitude;
        setNearestLat(String(lat)); setNearestLng(String(lng));
        setNearestLocating(false); runNearestSearch(lat, lng);
      },
      () => { setNearestLocating(false); setNearestStatus('Could not get your location — enter coordinates manually.'); },
      { timeout: 8000, enableHighAccuracy: true },
    );
  }

  // ── Edit/Add modal ──
  function openAddModal() {
    if (!hasPerm('sitesdb_add')) return;
    setEditId(null); setEditForm(emptyForm(operator)); setEditErr(''); setEditOpen(true);
  }

  function openEditModal(site: Site) {
    if (!hasPerm('sitesdb_edit')) return;
    setEditId(site.id); setEditForm(siteToForm(site)); setEditErr('');
    setDetailRow(null); setEditOpen(true);
  }

  function setField(key: keyof EditForm, val: string) {
    setEditForm(prev => ({ ...prev, [key]: val }));
  }

  async function saveSite() {
    setEditErr('');
    const code = editForm.site_code.trim();
    if (!code) { setEditErr('Site Code is required.'); return; }
    if (!editForm.operator) { setEditErr('Operator is required.'); return; }
    let lat: number | null = null, lng: number | null = null, height: number | null = null;
    if (editForm.latitude.trim() !== '') {
      lat = Number(editForm.latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) { setEditErr('Latitude must be between -90 and 90.'); return; }
    }
    if (editForm.longitude.trim() !== '') {
      lng = Number(editForm.longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) { setEditErr('Longitude must be between -180 and 180.'); return; }
    }
    if (editForm.tower_height.trim() !== '') {
      height = Number(editForm.tower_height);
      if (isNaN(height)) { setEditErr('Tower Height must be a number.'); return; }
    }
    const payload: Omit<Site, 'id'> = {
      operator: editForm.operator, site_code: code,
      site_name: editForm.site_name.trim() || null, governorate: editForm.governorate.trim() || null,
      city: editForm.city.trim() || null, latitude: lat, longitude: lng,
      site_type: editForm.site_type.trim() || null, tower_height: height,
      topology: editForm.topology.trim() || null, cabina_type: editForm.cabina_type.trim() || null,
      installation_type: editForm.installation_type.trim() || null,
      antenna: editForm.antenna.trim() || null, vendor: editForm.vendor.trim() || null,
      status: editForm.status.trim() || null,
    };
    setSaving(true);
    try {
      if (editId) {
        const { error } = await supabase.from('sites').update(payload).eq('id', editId);
        if (error) throw error;
        setDataCache(prev => ({
          ...prev,
          [payload.operator]: (prev[payload.operator] ?? []).map(s => s.id === editId ? { ...s, ...payload } : s),
        }));
        invalidateCache(); showToast('Site updated', true);
        logActivity({ userFullName: currentUser?.full_name ?? currentUser?.username, action: 'Edited Site', details: `Edited site: ${payload.operator} - ${payload.site_code}` });
      } else {
        const { data, error } = await supabase.from('sites').insert(payload).select('id').single();
        if (error) throw error;
        const newSite: Site = { id: (data as { id: string }).id, ...payload };
        setDataCache(prev => ({ ...prev, [payload.operator]: [...(prev[payload.operator] ?? []), newSite] }));
        invalidateCache(); showToast('Site added', true);
        logActivity({ userFullName: currentUser?.full_name ?? currentUser?.username, action: 'Added Site', details: `Added site: ${payload.operator} - ${payload.site_code}` });
      }
      setEditOpen(false); setEditId(null);
    } catch (e: unknown) { setEditErr(e instanceof Error ? e.message : 'Save failed'); }
    setSaving(false);
  }

  // ── Delete ──
  function openDeleteModal() { if (!hasPerm('sitesdb_delete') || !detailRow) return; setDeleteOpen(true); }

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
      invalidateCache(); setDeleteOpen(false); setDetailRow(null); showToast('Site deleted', true);
      logActivity({ userFullName: currentUser?.full_name ?? currentUser?.username, action: 'Deleted Site', details: `Deleted site: ${detailRow.operator} - ${detailRow.site_code}` });
    } catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Delete failed', false); }
    setDeleting(false);
  }

  // ── Export ──
  function exportSites() {
    if (!filtered.length) { showToast('No sites to export', false); return; }
    const data = filtered.map(r => ({
      'Operator': r.operator ?? '', 'Site Code': r.site_code ?? '', 'Site Name': r.site_name ?? '',
      'Governorate': r.governorate ?? '', 'City': r.city ?? '',
      'Latitude': r.latitude != null ? r.latitude : '', 'Longitude': r.longitude != null ? r.longitude : '',
      'Site Type': r.site_type ?? '', 'Tower Height (m)': r.tower_height != null ? r.tower_height : '',
      'Topology': r.topology ?? '', 'Cabina Type': r.cabina_type ?? '',
      'Installation Type': r.installation_type ?? '', 'Antenna': r.antenna ?? '',
      'Vendor': r.vendor ?? '', 'Status': r.status ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, operator.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 31));
    XLSX.writeFile(wb, `Sites_DB_${operator.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast(`Exported ${filtered.length} site${filtered.length !== 1 ? 's' : ''}`, true);
  }

  // ── Import / Enrich ──
  const allOperatorsLoaded = OPERATORS.every(op => op in dataCache);

  function openImportModal() {
    if (!hasPerm('sitesdb_import') && !hasPerm('sitesdb_enrich_export')) return;
    importRawRowsRef.current = []; enrichRowsRef.current = []; enrichHeadersRef.current = [];
    enrichCodeKeyRef.current = null; enrichOpKeyRef.current = null;
    setImportOperator(operator); setImportFileName(''); setImportStatus('');
    setImportNewRows([]); setImportDupRows([]); setImportInvalidCount(0);
    setImporting(false); setImportDragOver(false); setEnrichDragOver(false);
    setEnrichFileName(''); setEnrichStatus('');
    setEnrichChecked(new Set(['governorate', 'city', 'latitude', 'longitude']));
    setEnrichReady(false); setImportOpen(true);
  }

  function processImportRows(rawRows: Record<string, unknown>[], op: string) {
    if (!allOperatorsLoaded) { setImportStatus('Full site list still loading — wait a moment then re-select the file.'); return; }
    const existingKeys = new Set(allSites.map(r => `${(r.operator ?? '').trim().toLowerCase()}|${(r.site_code ?? '').trim().toLowerCase()}`));
    const newRows: ImportRow[] = []; const dupRows: ImportRow[] = []; let invalidCount = 0;
    const seenInBatch = new Set<string>();
    for (const raw of rawRows) {
      const norm: Record<string, unknown> = {};
      for (const k of Object.keys(raw)) { const field = SDB_IMPORT_FIELD_MAP[normHeader(k)]; if (field) norm[field] = raw[k]; }
      if (!Object.values(norm).some(v => String(v ?? '').trim() !== '')) continue;
      const site_code = String(norm['site_code'] ?? '').trim();
      if (!site_code) { invalidCount++; continue; }
      const latRaw = norm['latitude'], lngRaw = norm['longitude'], hRaw = norm['tower_height'];
      const lat = latRaw !== undefined && String(latRaw).trim() !== '' ? parseFloat(String(latRaw)) : null;
      const lng = lngRaw !== undefined && String(lngRaw).trim() !== '' ? parseFloat(String(lngRaw)) : null;
      const height = hRaw !== undefined && String(hRaw).trim() !== '' ? parseFloat(String(hRaw)) : null;
      const payload: ImportRow = {
        operator: op, site_code,
        site_name: String(norm['site_name'] ?? '').trim() || null,
        governorate: String(norm['governorate'] ?? '').trim() || null,
        city: String(norm['city'] ?? '').trim() || null,
        latitude: Number.isFinite(lat) ? lat : null,
        longitude: Number.isFinite(lng) ? lng : null,
        site_type: String(norm['site_type'] ?? '').trim() || null,
        tower_height: Number.isFinite(height) ? height : null,
        topology: String(norm['topology'] ?? '').trim() || null,
        cabina_type: String(norm['cabina_type'] ?? '').trim() || null,
        installation_type: String(norm['installation_type'] ?? '').trim() || null,
        antenna: String(norm['antenna'] ?? '').trim() || null,
        vendor: String(norm['vendor'] ?? '').trim() || null,
        status: String(norm['status'] ?? '').trim() || null,
      };
      const key = `${op.toLowerCase()}|${site_code.toLowerCase()}`;
      if (existingKeys.has(key) || seenInBatch.has(key)) { dupRows.push(payload); } else { seenInBatch.add(key); newRows.push(payload); }
    }
    setImportNewRows(newRows); setImportDupRows(dupRows); setImportInvalidCount(invalidCount); setImportStatus('');
  }

  function handleImportOperatorChange(op: string) {
    setImportOperator(op);
    if (importRawRowsRef.current.length) {
      if (!op) { setImportStatus('Select an operator above first.'); setImportNewRows([]); setImportDupRows([]); setImportInvalidCount(0); }
      else { processImportRows(importRawRowsRef.current, op); }
    }
  }

  function handleImportFile(file: File) {
    if (!importOperator) { setImportStatus('Select an operator above first.'); return; }
    setImportFileName(file.name); setImportStatus('Reading file…');
    setImportNewRows([]); setImportDupRows([]); setImportInvalidCount(0);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target!.result as ArrayBuffer, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }) as Record<string, unknown>[];
        importRawRowsRef.current = rows; processImportRows(rows, importOperator);
      } catch (err) { setImportStatus(`Could not read file: ${err instanceof Error ? err.message : String(err)}`); }
    };
    reader.onerror = () => setImportStatus('Could not read file.');
    reader.readAsArrayBuffer(file);
  }

  async function confirmImport() {
    const rows = importNewRows;
    if (!rows.length) return;
    setImporting(true); const CHUNK = 200; let inserted = 0;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { data, error } = await supabase.from('sites').insert(chunk).select('id, operator, site_code');
        if (error) throw error;
        const chunkSites = ((data ?? []) as { id: string; operator: string; site_code: string }[]).map(d => {
          const match = chunk.find(c => c.site_code === d.site_code && c.operator === d.operator);
          return match ? ({ ...match, id: d.id } as Site) : null;
        }).filter(Boolean) as Site[];
        if (chunkSites.length) { setDataCache(prev => ({ ...prev, [importOperator]: [...(prev[importOperator] ?? []), ...chunkSites] })); invalidateCache(); }
        inserted += (data ?? []).length;
        setImportStatus(`Imported ${inserted} of ${rows.length}…`);
      }
    } catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Import failed', false); setImporting(false); return; }
    showToast(`Imported ${inserted} new site${inserted !== 1 ? 's' : ''}`, true);
    logActivity({ userFullName: currentUser?.full_name ?? currentUser?.username, action: 'Imported Sites', details: `Imported ${inserted} site${inserted !== 1 ? 's' : ''} — ${importOperator}` });
    setImportNewRows([]); setImportStatus(`Done — ${inserted} site${inserted !== 1 ? 's' : ''} added.`); setImporting(false);
  }

  function enrichFindSite(row: Record<string, unknown>): Site | null {
    const codeKey = enrichCodeKeyRef.current; if (!codeKey) return null;
    const code = String(row[codeKey] ?? '').trim().toLowerCase(); if (!code) return null;
    const opKey = enrichOpKeyRef.current;
    const op = opKey ? String(row[opKey] ?? '').trim().toLowerCase() : null;
    return allSites.find(s =>
      String(s.site_code ?? '').trim().toLowerCase() === code &&
      (!op || String(s.operator ?? '').trim().toLowerCase() === op)
    ) ?? null;
  }

  function handleEnrichFile(file: File) {
    if (!allOperatorsLoaded) { setEnrichStatus('Full site list still loading — wait a moment then re-select the file.'); return; }
    setEnrichFileName(file.name); setEnrichStatus('Reading file…'); setEnrichReady(false);
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
        enrichRowsRef.current = rows; enrichHeadersRef.current = headers;
        enrichCodeKeyRef.current = codeKey; enrichOpKeyRef.current = opKey;
        const matched = rows.filter(r => {
          const c = String(r[codeKey] ?? '').trim().toLowerCase(); if (!c) return false;
          const o = opKey ? String(r[opKey] ?? '').trim().toLowerCase() : null;
          return allSites.some(s => String(s.site_code ?? '').trim().toLowerCase() === c && (!o || String(s.operator ?? '').trim().toLowerCase() === o));
        }).length;
        setEnrichStatus(`${matched} of ${rows.length} row${rows.length !== 1 ? 's' : ''} matched a site in the DB (by "${codeKey}").`);
        setEnrichReady(true);
      } catch (err) { setEnrichStatus(`Could not read file: ${err instanceof Error ? err.message : String(err)}`); }
    };
    reader.onerror = () => setEnrichStatus('Could not read file.');
    reader.readAsArrayBuffer(file);
  }

  function enrichDownload() {
    const rows = enrichRowsRef.current; if (!rows.length) return;
    const checked = SDB_ENRICH_FIELDS.filter(f => enrichChecked.has(f.id));
    if (!checked.length) { showToast('Pick at least one field to append', false); return; }
    const headers = enrichHeadersRef.current;
    const outRows = rows.map(row => {
      const site = enrichFindSite(row);
      const extra: Record<string, unknown> = {};
      for (const f of checked) { const v = site ? (site[f.id as keyof Site] ?? null) : null; extra[f.label] = v != null ? v : ''; }
      return { ...row, ...extra };
    });
    const ws = XLSX.utils.json_to_sheet(outRows, { header: [...headers, ...checked.map(f => f.label)] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enriched');
    XLSX.writeFile(wb, `Enriched_Sites_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Enriched file downloaded', true);
    logActivity({ userFullName: currentUser?.full_name ?? currentUser?.username, action: 'Enriched Sheet', details: `Enriched sheet: ${enrichFileName || 'file'} (${rows.length} rows)` });
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

  if (!hasPerm('view_sites_db')) {
    return (
      <div className={styles.page}>
        <p style={{ color: 'var(--text-muted)', marginTop: 40 }}>You do not have permission to view this page.</p>
      </div>
    );
  }

  const healthStatusClsMap: Record<HealthStatus, string> = {
    complete: styles.healthBadgeGreen,
    nocoords: styles.healthBadgeRed,
    incomplete: styles.healthBadgeAmber,
    review: styles.healthBadgeRed,
  };

  const showStart = filtered.length === 0 ? 0 : page * pageSize + 1;
  const showEnd = Math.min((page + 1) * pageSize, filtered.length);

  return (
    <div className={styles.page}>
      {toast && <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>{toast.msg}</div>}

      {/* ── Page Actions ── */}
      <div className={styles.pageActions}>
        {hasPerm('sitesdb_export') && (
          <button className={styles.btnGhost} onClick={exportSites}>
            <ExportIcon /> Export
          </button>
        )}
        {(hasPerm('sitesdb_import') || hasPerm('sitesdb_enrich_export')) && (
          <button className={styles.btnGhost} onClick={openImportModal}>
            <ImportIcon /> Import / Enrich
          </button>
        )}
        {hasPerm('sitesdb_add') && (
          <button className={styles.btnPrimary} onClick={openAddModal}>
            <PlusIcon /> Add Site
          </button>
        )}
      </div>

      {/* ── Summary Cards ── */}
      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardIcon} style={{ background: '#eff6ff' }}>
            <DatabaseIcon color="#2563eb" />
          </div>
          <div className={styles.summaryCardBody}>
            <div className={styles.summaryCardVal}>{(zainCount + asiaCellCount).toLocaleString()}</div>
            <div className={styles.summaryCardLabel}>Total Sites</div>
            <div className={styles.summaryCardSub}>All operators</div>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardIcon} style={{ background: '#f0fdf4' }}>
            <TowerIcon color="#16a34a" />
          </div>
          <div className={styles.summaryCardBody}>
            <div className={styles.summaryCardVal}>{zainCount.toLocaleString()}</div>
            <div className={styles.summaryCardLabel}>Zain Sites</div>
            <div className={styles.summaryCardSub}>
              {(zainCount + asiaCellCount) > 0 ? `${((zainCount / (zainCount + asiaCellCount)) * 100).toFixed(1)}% of total` : '—'}
            </div>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardIcon} style={{ background: '#faf5ff' }}>
            <TowerIcon color="#7c3aed" />
          </div>
          <div className={styles.summaryCardBody}>
            <div className={styles.summaryCardVal}>{asiaCellCount.toLocaleString()}</div>
            <div className={styles.summaryCardLabel}>Asia Cell Sites</div>
            <div className={styles.summaryCardSub}>
              {(zainCount + asiaCellCount) > 0 ? `${((asiaCellCount / (zainCount + asiaCellCount)) * 100).toFixed(1)}% of total` : '—'}
            </div>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardIcon} style={{ background: '#fff7ed' }}>
            <AlertTriIcon color="#d97706" />
          </div>
          <div className={styles.summaryCardBody}>
            <div className={`${styles.summaryCardVal} ${dataIssuesCount > 0 ? styles.summaryValWarn : ''}`}>
              {dataIssuesCount.toLocaleString()}
            </div>
            <div className={styles.summaryCardLabel}>Data Issues · {operator}</div>
            <div className={styles.summaryCardSub}>{dataIssuesCount > 0 ? 'Need attention' : 'All clear'}</div>
          </div>
        </div>
      </div>

      {/* ── Controls Row ── */}
      <div className={styles.controlsRow}>
        <div className={styles.segGroupWrap}>
          <span className={styles.segGroupLabel}>Operator</span>
          <div className={styles.segGroup}>
            {OPERATORS.map(op => (
              <button
                key={op}
                className={`${styles.segBtn} ${operator === op ? styles.segBtnActive : ''}`}
                onClick={() => switchOperator(op)}
              >
                {op}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.segGroupWrap}>
          <span className={styles.segGroupLabel}>View</span>
          <div className={styles.segGroup}>
            <button className={`${styles.segBtn} ${view === 'list' ? styles.segBtnActive : ''}`} onClick={() => setView('list')}>
              <ListIcon /> List
            </button>
            <button className={`${styles.segBtn} ${view === 'map' ? styles.segBtnActive : ''}`} onClick={() => setView('map')}>
              <MapIconSm /> Map
            </button>
          </div>
        </div>
        <div className={styles.controlsRight}>
          <button className={styles.btnGhost} onClick={openNearestModal}>
            <NearestIcon /> Find Nearest
          </button>
          <button className={styles.btnGhost} onClick={() => setHealthOpen(true)}>
            <HealthIcon /> Data Health
          </button>
        </div>
      </div>

      {/* ── Filter Card ── */}
      <div className={styles.filterCard}>
        <div className={styles.filterRow}>
          <div className={styles.searchWrap}>
            <SearchIcon />
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Search by site code, name, city, or governorate…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">
                <XSmIcon />
              </button>
            )}
          </div>
          <select className={styles.filterSelect} value={govFilter} onChange={e => setGovFilter(e.target.value)}>
            <option value="">All Governorates</option>
            {govOptions.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select className={styles.filterSelect} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Site Types</option>
            {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {healthFilter && (
            <span className={styles.healthChip}>
              {healthLabel(healthFilter)}
              <button className={styles.healthChipX} onClick={() => setHealthFilter('')}>×</button>
            </span>
          )}
          {anyFilterActive && (
            <button className={styles.btnClearFilters} onClick={clearAllFilters}>
              <XSmIcon /> Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Bulk Filter (collapsible) ── */}
      <div className={styles.bulkFilter}>
        <button
          className={styles.bulkFilterHeader}
          onClick={() => setBulkExpanded(e => !e)}
          aria-expanded={bulkExpanded}
        >
          <div className={styles.bulkFilterHeaderLeft}>
            <FunnelIcon />
            <span>Bulk Filter by Site IDs</span>
            {bulkIds.length > 0 && (
              <span className={styles.bulkActiveBadge}>{bulkIds.length} active</span>
            )}
          </div>
          <ChevronIcon expanded={bulkExpanded} />
        </button>
        {bulkExpanded && (
          <div className={styles.bulkFilterBody}>
            <textarea
              className={styles.bulkTextarea}
              placeholder="Paste IDs separated by spaces, commas, semicolons, or newlines"
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
            />
            <div className={styles.bulkFilterActions}>
              {parsedBulkCount > 0 && (
                <span className={styles.bulkParsedCount}>{parsedBulkCount} IDs parsed</span>
              )}
              <button className={styles.btnPrimary} onClick={applyBulkFilter} disabled={!bulkText.trim()}>
                Apply Filter
              </button>
              {(bulkIds.length > 0 || bulkText) && (
                <button className={styles.btnGhost} onClick={clearBulkFilter}>Clear</button>
              )}
            </div>
            {bulkIds.length > 0 && (
              <div className={styles.bulkStatus}>
                Filtering to <strong>{bulkIds.length}</strong> pasted ID{bulkIds.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Map view (always mounted) ── */}
      <div style={{ display: view === 'map' ? 'block' : 'none' }}>
        <SiteMapView sites={filtered} onViewSite={openDetail} />
      </div>

      {/* ── List view ── */}
      {view === 'list' && (
        <>
          {/* Results toolbar */}
          <div className={styles.resultsToolbar}>
            <span className={styles.resultsCount}>
              {loading ? 'Loading…' : `${filtered.length.toLocaleString()} site${filtered.length !== 1 ? 's' : ''}`}
              {anyFilterActive && opRows.length > 0 && (
                <span className={styles.resultsTotal}> of {opRows.length.toLocaleString()} total</span>
              )}
            </span>
          </div>

          {/* Table */}
          <div className={styles.tableCard}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Site Code</th>
                    <th>Site Name</th>
                    <th>Governorate</th>
                    <th>City</th>
                    <th>Site Type</th>
                    <th className={styles.thRight}>Tower Ht.</th>
                    <th>Topology</th>
                    <th>Data Health</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className={styles.skeletonRow}>
                        {Array.from({ length: 9 }).map((_, j) => (
                          <td key={j}><div className={styles.skeletonCell} style={{ width: j === 8 ? 32 : '80%' }} /></td>
                        ))}
                      </tr>
                    ))
                  ) : pagedSites.length === 0 ? (
                    <tr>
                      <td colSpan={9}>
                        <div className={styles.emptyState}>
                          <div className={styles.emptyIcon}><EmptyIcon /></div>
                          <div className={styles.emptyTitle}>No sites found</div>
                          <div className={styles.emptyDesc}>Try adjusting your search or filters.</div>
                          {anyFilterActive && (
                            <button className={styles.btnGhost} onClick={clearAllFilters}>Clear filters</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    pagedSites.map(r => {
                      const hs = siteHealthStatus(r);
                      return (
                        <tr key={r.id} className={styles.tableRow} onClick={() => openDetail(r)}>
                          <td className={styles.siteCodeCell}>{r.site_code || '—'}</td>
                          <td className={styles.siteNameCell}>{r.site_name || '—'}</td>
                          <td className={styles.tdMuted}>{r.governorate || '—'}</td>
                          <td className={styles.tdMuted}>{r.city || '—'}</td>
                          <td>{r.site_type || '—'}</td>
                          <td className={styles.tdRight}>{r.tower_height != null ? `${r.tower_height} m` : '—'}</td>
                          <td className={styles.tdMuted}>{r.topology || '—'}</td>
                          <td>
                            <span className={`${styles.healthBadge} ${healthStatusClsMap[hs.status]}`}>
                              {hs.label}
                            </span>
                          </td>
                          <td className={styles.tdActions} onClick={e => e.stopPropagation()}>
                            <div className={styles.rowActionsGroup}>
                              <button
                                className={styles.rowActionBtn}
                                onClick={() => openDetail(r)}
                                title="View details"
                                aria-label="View site details"
                              >
                                <EyeIcon />
                              </button>
                              {(hasPerm('sitesdb_edit') || hasPerm('sitesdb_delete')) && (
                                <div className={styles.rowMenuWrap}>
                                  <button
                                    className={styles.rowActionBtn}
                                    onClick={e => { e.stopPropagation(); setRowMenuId(rowMenuId === r.id ? null : r.id); }}
                                    title="More actions"
                                    aria-label="More actions"
                                  >
                                    <MoreIcon />
                                  </button>
                                  {rowMenuId === r.id && (
                                    <div className={styles.rowMenu} onClick={e => e.stopPropagation()}>
                                      {hasPerm('sitesdb_edit') && (
                                        <button className={styles.rowMenuItem} onClick={() => { setRowMenuId(null); openEditModal(r); }}>
                                          <EditPenIcon /> Edit
                                        </button>
                                      )}
                                      {hasPerm('sitesdb_delete') && (
                                        <button className={`${styles.rowMenuItem} ${styles.rowMenuItemDanger}`} onClick={() => { setRowMenuId(null); openDeleteModalFor(r); }}>
                                          <TrashIcon /> Delete
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className={styles.mobileCards}>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => <div key={i} className={styles.mobileSkelCard} />)
            ) : pagedSites.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}><EmptyIcon /></div>
                <div className={styles.emptyTitle}>No sites found</div>
                <div className={styles.emptyDesc}>Try adjusting your search or filters.</div>
                {anyFilterActive && <button className={styles.btnGhost} onClick={clearAllFilters}>Clear filters</button>}
              </div>
            ) : (
              pagedSites.map(r => {
                const hs = siteHealthStatus(r);
                return (
                  <div key={r.id} className={styles.mobileCard} onClick={() => openDetail(r)}>
                    <div className={styles.mobileCardTop}>
                      <span className={styles.mobileCardCode}>{r.site_code || '—'}</span>
                      <span className={`${styles.healthBadge} ${healthStatusClsMap[hs.status]}`}>{hs.label}</span>
                    </div>
                    <div className={styles.mobileCardName}>{r.site_name || '—'}</div>
                    <div className={styles.mobileCardMeta}>
                      {[r.governorate, r.city].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div className={styles.mobileCardMeta}>
                      {[r.site_type, r.tower_height != null ? `${r.tower_height} m` : null].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pagination */}
          {!loading && filtered.length > 0 && (
            <div className={styles.pagination}>
              <span className={styles.paginationInfo}>
                Showing {showStart}–{showEnd} of {filtered.length.toLocaleString()}
              </span>
              <div className={styles.paginationControls}>
                <select
                  className={styles.pageSizeSelect}
                  value={pageSize}
                  onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
                <button
                  className={styles.pageBtn}
                  disabled={page === 0}
                  onClick={() => setPage(p => p - 1)}
                  aria-label="Previous page"
                >
                  <ChevLeftIcon />
                </button>
                {(() => {
                  const pages: (number | '…')[] = [];
                  if (totalPages <= 7) {
                    for (let i = 0; i < totalPages; i++) pages.push(i);
                  } else if (page < 4) {
                    pages.push(0, 1, 2, 3, 4, '…', totalPages - 1);
                  } else if (page > totalPages - 5) {
                    pages.push(0, '…', totalPages - 5, totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1);
                  } else {
                    pages.push(0, '…', page - 1, page, page + 1, '…', totalPages - 1);
                  }
                  return pages.map((p, i) =>
                    p === '…' ? (
                      <span key={`e${i}`} className={styles.pageEllipsis}>…</span>
                    ) : (
                      <button
                        key={p}
                        className={`${styles.pageBtn} ${page === p ? styles.pageBtnActive : ''}`}
                        onClick={() => setPage(p as number)}
                      >
                        {(p as number) + 1}
                      </button>
                    )
                  );
                })()}
                <button
                  className={styles.pageBtn}
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                  aria-label="Next page"
                >
                  <ChevRightIcon />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ══ SITE DETAIL DRAWER ══ */}
      {detailRow && (
        <>
          <div className={styles.drawerOverlay} onClick={() => setDetailRow(null)} />
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="Site details">
            <div className={styles.drawerHdr}>
              <div className={styles.drawerHdrInfo}>
                <div className={styles.drawerCode}>{detailRow.site_code}</div>
                <div className={styles.drawerSiteName}>{detailRow.site_name || '—'}</div>
                <div className={styles.drawerBadges}>
                  <span className={styles.opBadge}>{detailRow.operator}</span>
                  {(() => { const hs = siteHealthStatus(detailRow); return <span className={`${styles.healthBadge} ${healthStatusClsMap[hs.status]}`}>{hs.label}</span>; })()}
                  {statusBadge(detailRow.status)}
                </div>
              </div>
              <div className={styles.drawerHdrActions}>
                {hasPerm('sitesdb_delete') && (
                  <button className={styles.drawerIconBtnDanger} onClick={openDeleteModal} aria-label="Delete site" title="Delete site">
                    <TrashIcon />
                  </button>
                )}
                <button className={styles.drawerClose} onClick={() => setDetailRow(null)} aria-label="Close">
                  <XIcon />
                </button>
              </div>
            </div>

            <div className={styles.drawerBody}>
              {detailRow.latitude != null && detailRow.longitude != null && (
                <SiteMiniMap lat={detailRow.latitude} lng={detailRow.longitude} />
              )}

              {detailRow.latitude != null && detailRow.longitude != null && (
                <div className={styles.mapsRow}>
                  <a className={`${styles.mapsLink} ${styles.mapsLinkGoogle}`}
                    href={`https://www.google.com/maps?q=${detailRow.latitude},${detailRow.longitude}`}
                    target="_blank" rel="noreferrer">
                    <MapPinIcon /> Google Maps
                  </a>
                  <a className={`${styles.mapsLink} ${styles.mapsLinkWaze}`}
                    href={`https://waze.com/ul?ll=${detailRow.latitude},${detailRow.longitude}&navigate=yes`}
                    target="_blank" rel="noreferrer">
                    <WazeIcon /> Waze
                  </a>
                </div>
              )}

              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Location</div>
                <div className={styles.detailGrid}>
                  {df('Governorate', detailRow.governorate, <SvgMap />)}
                  {df('City', detailRow.city, <SvgPin />)}
                  {df('Latitude', detailRow.latitude, <SvgNav />)}
                  {df('Longitude', detailRow.longitude, <SvgNav />)}
                </div>
              </div>

              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Technical</div>
                <div className={styles.detailGrid}>
                  {df('Site Type', detailRow.site_type, <SvgLayers />)}
                  {df('Tower Height', detailRow.tower_height != null ? `${detailRow.tower_height} m` : null, <SvgTrend />)}
                  {df('Topology', detailRow.topology, <SvgShare />)}
                  {df('Cabina Type', detailRow.cabina_type, <SvgBox />)}
                  {df('Installation', detailRow.installation_type, <SvgTool />)}
                  {df('Antenna', detailRow.antenna, <SvgAntenna />)}
                  {df('Vendor', detailRow.vendor, <SvgBriefcase />)}
                </div>
              </div>

              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>
                  Data Health
                  <span className={styles.drawerHealthCount}>
                    {HEALTH_FIELDS.length - HEALTH_FIELDS.filter(f => f.test(detailRow)).length}/{HEALTH_FIELDS.length} passing
                  </span>
                </div>
                <div className={styles.drawerHealthList}>
                  {HEALTH_FIELDS.map(f => {
                    const failing = f.test(detailRow);
                    const fieldName = f.label.replace(/^Missing /, '');
                    return (
                      <div key={f.key} className={`${styles.drawerHealthItem} ${failing ? styles.drawerHealthItemFail : styles.drawerHealthItemPass}`}>
                        {failing ? <AlertSmIcon /> : <CheckSmIcon />} {failing ? f.label : `${fieldName} present`}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className={styles.drawerFooter}>
              <div className={styles.drawerFooterRight}>
                <button className={styles.btnGhost} onClick={() => setDetailRow(null)}>Close</button>
                {hasPerm('sitesdb_edit') && (
                  <button className={styles.btnPrimary} onClick={() => openEditModal(detailRow)}>Edit Site</button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ══ FIND NEAREST SITE MODAL ══ */}
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
                  <input type="number" step="any" placeholder="e.g. 33.3152" value={nearestLat}
                    onChange={e => setNearestLat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') nearestSearch(); }} />
                </div>
                <div className={styles.nearestField}>
                  <label>Longitude</label>
                  <input type="number" step="any" placeholder="e.g. 44.3661" value={nearestLng}
                    onChange={e => setNearestLng(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') nearestSearch(); }} />
                </div>
                <button className={styles.btnGhost} onClick={useMyLocation} disabled={nearestLocating} style={{ alignSelf: 'flex-end' }}>
                  {nearestLocating ? 'Locating…' : 'Use My Location'}
                </button>
                <button className={styles.btnPrimary} onClick={nearestSearch} style={{ alignSelf: 'flex-end' }}>Search</button>
              </div>
              {nearestStatus && <div className={styles.nearestStatus}>{nearestStatus}</div>}
              {nearestResults.map(({ site: r, km }) => (
                <div key={r.id} className={styles.nearestRow}>
                  <div className={styles.nearestInfo}>
                    <div className={styles.nearestCode}>{r.site_code || '—'} <span className={styles.nearestOp}>· {r.operator}</span></div>
                    <div className={styles.nearestMeta}>{[r.site_name, r.city, r.governorate].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                  <div className={styles.nearestRight}>
                    <span className={styles.nearestDist}>{fmtDist(km)}</span>
                    <button className={styles.viewBtn} onClick={() => { setNearestOpen(false); openDetail(r); }}>View</button>
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

      {/* ══ ADD / EDIT MODAL ══ */}
      {editOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setEditOpen(false); }}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>{editId ? 'Edit Site' : 'Add Site'}</h3>
              <button className={styles.modalClose} onClick={() => setEditOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.editGrid}>
                <div className={styles.editField}><label>Operator *</label>
                  <select value={editForm.operator} onChange={e => setField('operator', e.target.value)}>
                    {OPERATORS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.editField}><label>Site Code *</label>
                  <input type="text" value={editForm.site_code} onChange={e => setField('site_code', e.target.value)} placeholder="e.g. ZN001" />
                </div>
                <div className={styles.editField}><label>Site Name</label>
                  <input type="text" value={editForm.site_name} onChange={e => setField('site_name', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Governorate</label>
                  <input type="text" value={editForm.governorate} onChange={e => setField('governorate', e.target.value)} />
                </div>
                <div className={styles.editField}><label>City</label>
                  <input type="text" value={editForm.city} onChange={e => setField('city', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Latitude</label>
                  <input type="number" step="any" value={editForm.latitude} onChange={e => setField('latitude', e.target.value)} placeholder="-90 to 90" />
                </div>
                <div className={styles.editField}><label>Longitude</label>
                  <input type="number" step="any" value={editForm.longitude} onChange={e => setField('longitude', e.target.value)} placeholder="-180 to 180" />
                </div>
                <div className={styles.editField}><label>Site Type</label>
                  <input type="text" value={editForm.site_type} onChange={e => setField('site_type', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Tower Height (m)</label>
                  <input type="number" step="any" value={editForm.tower_height} onChange={e => setField('tower_height', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Topology</label>
                  <input type="text" value={editForm.topology} onChange={e => setField('topology', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Cabina Type</label>
                  <input type="text" value={editForm.cabina_type} onChange={e => setField('cabina_type', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Installation Type</label>
                  <input type="text" value={editForm.installation_type} onChange={e => setField('installation_type', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Antenna</label>
                  <input type="text" value={editForm.antenna} onChange={e => setField('antenna', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Vendor</label>
                  <input type="text" value={editForm.vendor} onChange={e => setField('vendor', e.target.value)} />
                </div>
                <div className={styles.editField}><label>Status</label>
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

      {/* ══ DELETE MODAL ══ */}
      {deleteOpen && detailRow && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setDeleteOpen(false); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <h3 className={styles.modalTitle}>Delete Site</h3>
              <button className={styles.modalClose} onClick={() => setDeleteOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <p className={styles.deleteMsg}>
                Are you sure you want to delete <strong>"{detailRow.site_name || detailRow.site_code}"</strong>? This action cannot be undone.
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

      {/* ══ IMPORT / ENRICH MODAL ══ */}
      {importOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setImportOpen(false); }}>
          <div className={`${styles.modal} ${styles.modalTools}`} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHdr}>
              <div>
                <h3 className={styles.modalTitle}>Sites DB Tools</h3>
                <p className={styles.toolsSubtitle}>Import new sites into the database, or enrich your own spreadsheet with Sites DB data.</p>
              </div>
              <button className={styles.modalClose} onClick={() => setImportOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              {hasPerm('sitesdb_import') && (
                <div className={styles.sdbToolCard}>
                  <div className={styles.sdbToolHead}>
                    <div className={`${styles.sdbToolIcon} ${styles.sdbIconBlue}`}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/>
                      </svg>
                    </div>
                    <div>
                      <div className={styles.sdbToolTitle}>Import Sites</div>
                      <div className={styles.sdbToolDesc}>1. Choose the operator. 2. Upload any Excel — matching columns are detected automatically. New site codes are added — duplicates are skipped.</div>
                    </div>
                  </div>
                  <div style={{ marginBottom: 12, maxWidth: 260 }}>
                    <label className={styles.sdbFieldLabel}>1. Operator</label>
                    <select className={styles.sdbSelect} value={importOperator} onChange={e => handleImportOperatorChange(e.target.value)}>
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
                      onDrop={e => { e.preventDefault(); setImportDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleImportFile(f); }}
                    >
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/>
                      </svg>
                      <div className={styles.sdbDropzoneMain}><b>Drop Excel here</b> or click to browse</div>
                      <div className={styles.sdbDropzoneFile}>{importFileName || 'No file selected'}</div>
                    </div>
                    <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
                    <div className={styles.sdbToolActions}>
                      <button className={styles.btnPrimary} onClick={confirmImport} disabled={!importNewRows.length || importing}>
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
                                <div className={styles.importListCode}>{r.site_code} <span className={styles.importListOp}>· {r.operator}</span></div>
                                <div className={styles.importListMeta}>{r.site_name || '—'}</div>
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
                                  <div className={styles.importListCode}>{r.site_code} <span className={styles.importListOp}>· {r.operator}</span></div>
                                  <div className={styles.importListMeta}>{[r.site_name, r.city, r.governorate].filter(Boolean).join(' · ') || '—'}</div>
                                </div>
                                {r.latitude == null || r.longitude == null
                                  ? <span className={styles.noCoordsTag}>no coords</span>
                                  : <span className={styles.coordsTag}>{r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}</span>}
                              </div>
                            ))}
                            {importNewRows.length > 300 && <div className={styles.importListMore}>…and {importNewRows.length - 300} more</div>}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {hasPerm('sitesdb_enrich_export') && (
                <div className={styles.sdbToolCard}>
                  <div className={styles.sdbToolHead}>
                    <div className={`${styles.sdbToolIcon} ${styles.sdbIconGreen}`}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                      </svg>
                    </div>
                    <div>
                      <div className={styles.sdbToolTitle}>Enrich Sheet with Sites DB</div>
                      <div className={styles.sdbToolDesc}>Upload any Excel with a Site Code column. Pick fields to append — they'll be added as new columns and downloaded.</div>
                    </div>
                  </div>
                  <div className={styles.sdbToolRow}>
                    <div
                      className={`${styles.sdbDropzone} ${enrichDragOver ? styles.sdbDropzoneOver : ''}`}
                      onClick={() => enrichFileRef.current?.click()}
                      onDragOver={e => { e.preventDefault(); setEnrichDragOver(true); }}
                      onDragLeave={() => setEnrichDragOver(false)}
                      onDrop={e => { e.preventDefault(); setEnrichDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleEnrichFile(f); }}
                    >
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                      </svg>
                      <div className={styles.sdbDropzoneMain}><b>Drop Excel here</b> or click to browse</div>
                      <div className={styles.sdbDropzoneFile}>{enrichFileName || 'No file selected'}</div>
                    </div>
                    <input ref={enrichFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleEnrichFile(f); e.target.value = ''; }} />
                    <div className={styles.sdbToolActions}>
                      <button className={styles.btnPrimary} onClick={enrichDownload} disabled={!enrichReady || enrichChecked.size === 0}>
                        Enrich & Download
                      </button>
                    </div>
                  </div>
                  <div className={styles.sdbAppendBar}>
                    <span className={styles.sdbAppendLabel}>Append:</span>
                    {SDB_ENRICH_FIELDS.map(f => (
                      <label key={f.id} className={styles.sdbAppendCheck}>
                        <input type="checkbox" checked={enrichChecked.has(f.id)}
                          onChange={e => setEnrichChecked(prev => { const next = new Set(prev); e.target.checked ? next.add(f.id) : next.delete(f.id); return next; })} />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  {enrichStatus && <div className={styles.sdbToolStatus}>{enrichStatus}</div>}
                </div>
              )}
            </div>
            <div className={styles.modalFooter}>
              <div className={styles.modalFooterRight}>
                <button className={styles.btnGhost} onClick={() => setImportOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ DATA HEALTH MODAL ══ */}
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
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>No sites for {operator} yet.</p>
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
                          <div className={styles.healthRowCount}>{missing.toLocaleString()} of {opRows.length.toLocaleString()} ({pct}%)</div>
                        </div>
                        {missing > 0
                          ? <button className={styles.viewBtn} onClick={() => applyHealthFilter(f.key)}>View</button>
                          : <span className={styles.healthComplete}>✓ Complete</span>}
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

/* ── Inline icon components ── */
function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function ExportIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>; }
function ImportIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>; }
function DatabaseIcon({ color }: { color: string }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>; }
function TowerIcon({ color }: { color: string }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>; }
function AlertTriIcon({ color }: { color: string }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="m10.29 3.86-8.34 14.42A2 2 0 0 0 3.66 21H20.34a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function ListIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>; }
function MapIconSm() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>; }
function NearestIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>; }
function HealthIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>; }
function SearchIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--text-muted)' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function XSmIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>; }
function XIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>; }
function FunnelIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>; }
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}><polyline points="6 9 12 15 18 9"/></svg>;
}
function ChevLeftIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>; }
function ChevRightIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>; }
function EyeIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>; }
function MoreIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>; }
function EditPenIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>; }
function EmptyIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>; }
function MapPinIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>; }
function WazeIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>; }
function AlertSmIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}><path d="m10.29 3.86-8.34 14.42A2 2 0 0 0 3.66 21H20.34a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function CheckSmIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>; }

/* ── Detail field SVG icons ── */
function SvgCode() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>; }
function SvgName() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>; }
function SvgMap() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>; }
function SvgPin() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>; }
function SvgNav() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>; }
function SvgLayers() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>; }
function SvgTrend() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>; }
function SvgShare() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>; }
function SvgBox() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>; }
function SvgTool() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>; }
function SvgAntenna() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>; }
function SvgBriefcase() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>; }

// Suppress unused warnings for SVG helpers defined but not yet referenced
void SvgCode; void SvgName;
