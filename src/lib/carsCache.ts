import { supabase } from './supabase';

export interface CarMeta {
  id: string;
  name: string;
  plate_number: string | null;
  owner_id: string | null;
  is_active: boolean;
}

let _cars: CarMeta[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureCarsLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const { data } = await supabase
      .from('cars')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });
    _cars = (data ?? []) as CarMeta[];
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

export function getCars(): CarMeta[] { return _cars; }
export function carsLoaded(): boolean { return _loaded; }
export function invalidateCars(): void { _loaded = false; }

/** Look up a car's display name (e.g. 'Hilux - White') by id. */
export function getCarName(id: string | null | undefined): string {
  if (!id) return '—';
  return _cars.find(c => c.id === id)?.name || '—';
}

/** Look up a car's default driver (owner_id) by car id. */
export function getCarOwnerId(id: string | null | undefined): string | null {
  if (!id) return null;
  return _cars.find(c => c.id === id)?.owner_id ?? null;
}
