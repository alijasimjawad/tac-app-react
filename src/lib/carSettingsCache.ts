import { supabase } from './supabase';

const RATE_KEY = 'car_km_rate_iqd';
const DEFAULT_RATE = 275;

let _rate = DEFAULT_RATE;
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureCarKmRateLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const { data } = await supabase.from('app_settings').select('value').eq('key', RATE_KEY).maybeSingle();
    const n = data?.value ? parseFloat(data.value) : NaN;
    if (!isNaN(n) && n > 0) _rate = n;
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

/** Current global car KM rate (IQD per km) — synchronous getter, call ensureCarKmRateLoaded() first. */
export function getCarKmRate(): number { return _rate; }
export function invalidateCarKmRate(): void { _loaded = false; }

export async function saveCarKmRate(rate: number): Promise<{ error: string | null }> {
  const { error } = await supabase.from('app_settings')
    .upsert({ key: RATE_KEY, value: String(rate), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { error: error.message };
  _rate = rate;
  _loaded = true;
  return { error: null };
}
