import { supabase } from './supabase';

export interface SectionMeta {
  id: string;
  project_name: string;
  section_name: string;
  section_label: string;
  columns: string[];
  custom_columns: string[];
  is_custom: boolean;
  is_deleted: boolean;
  created_at: string;
  /** FK into public.capex_projects — null means "unassigned", which the
   *  Dashboard's top-bar project selector treats as visible under every
   *  capex project (see react_migration_phase22_sql.sql). */
  capex_project_id: string | null;
}

let _sections: SectionMeta[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureSectionsLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const { data } = await supabase
      .from('sections')
      .select('*')
      .order('created_at', { ascending: true });
    _sections = (data ?? []) as SectionMeta[];
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

export function getSections(): SectionMeta[] { return _sections; }
export function sectionsLoaded(): boolean { return _loaded; }
export function invalidateSections(): void { _loaded = false; }
