import { supabase } from './supabase';

// ── Module-level sites cache (persists across navigations for the session) ──
// Mirrors the old app's _sitesDB / _sitesDBLoadTs / _sitesDBCacheOk /
// _loadSitesDBPreview / _ensureSitesDBFullLoad pattern.

export interface CachedSite {
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

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes — matches old app's _CACHE_TTL
const PREVIEW_LIMIT = 50;         // matches old app's _SITES_DEFAULT_LIMIT
const PAGE = 1000;

let _all: CachedSite[] = [];
let _loadTs = 0;
let _inFlight: Promise<void> | null = null;
const _previews: Record<string, CachedSite[]> = {};

export function cacheOk(): boolean {
  return _all.length > 0 && Date.now() - _loadTs < CACHE_TTL;
}

export function getAllSites(): CachedSite[] {
  return _all;
}

export function getSitesByOperator(op: string): CachedSite[] {
  return _all.filter(r => (r.operator || '') === op);
}

export function getPreview(op: string): CachedSite[] {
  return _previews[op] ?? [];
}

// Fetch a small preview (50 rows) for one operator — cached per operator so
// revisiting before the full load completes doesn't refetch.
export async function loadPreview(op: string): Promise<CachedSite[]> {
  if (_previews[op]) return _previews[op];
  const { data, error } = await supabase
    .from('sites')
    .select('*')
    .eq('operator', op)
    .order('site_code')
    .limit(PREVIEW_LIMIT);
  const rows = (error ? [] : (data ?? [])) as CachedSite[];
  _previews[op] = rows;
  return rows;
}

// Kicks off the full load exactly once — dedupes concurrent calls via a shared
// in-flight promise. Loads ALL operators in parallel pages. Calls onComplete
// (if provided) once data is ready (or immediately if cache is already warm).
export function ensureFullLoad(onComplete?: () => void): Promise<void> {
  if (cacheOk()) {
    onComplete?.();
    return Promise.resolve();
  }
  if (!_inFlight) {
    _inFlight = (async () => {
      const { count, error: cErr } = await supabase
        .from('sites')
        .select('*', { count: 'exact', head: true });
      if (cErr || count == null) return;
      const pages = Math.ceil(count / PAGE);
      const results = await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          supabase.from('sites').select('*').range(i * PAGE, i * PAGE + PAGE - 1)
        )
      );
      const all: CachedSite[] = [];
      for (const { data, error } of results) {
        if (error) return;
        all.push(...((data ?? []) as CachedSite[]));
      }
      _all = all;
      _loadTs = Date.now();
    })().finally(() => { _inFlight = null; });
  }
  if (onComplete) return _inFlight.then(() => { onComplete(); });
  return _inFlight;
}

// Call after any mutation so the next navigation re-fetches fresh data.
export function invalidateCache(): void {
  _loadTs = 0;
}
