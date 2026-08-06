import { supabase } from './supabase';

// This is a SEPARATE concept from projectsCache.ts (which holds operator/
// client names — Zain, Nokia, Huawei, IPT, MOJ — and drives the Dashboard's
// per-operator cards, Network Scopes routing, etc.). capex_projects holds
// budget/fiscal-year groupings (e.g. "Capex 2025", "Capex26") shown in the
// new top-bar dropdown — see react_migration_phase22_sql.sql.

export interface CapexProject {
  id: string;
  name: string;
  is_current: boolean;
  sort_order: number;
  created_at: string;
}

let _projects: CapexProject[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureCapexProjectsLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const { data } = await supabase
      .from('capex_projects')
      .select('*')
      .order('sort_order', { ascending: true });
    _projects = (data ?? []) as CapexProject[];
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

export function getCapexProjects(): CapexProject[] { return _projects; }
export function capexProjectsLoaded(): boolean { return _loaded; }
export function invalidateCapexProjects(): void { _loaded = false; }

/** The project flagged is_current in the DB (shown with a "current" badge
 *  in the dropdown) — falls back to the first project if none is flagged. */
export function getDefaultCapexProject(): CapexProject | null {
  return _projects.find(p => p.is_current) ?? _projects[0] ?? null;
}

/** Inserts a new capex project row (used by the dropdown's "New" link) and
 *  refreshes the local cache so callers see it immediately. */
export async function addCapexProject(name: string): Promise<CapexProject | null> {
  const sortOrder = _projects.length ? Math.max(..._projects.map(p => p.sort_order)) + 1 : 0;
  const { data, error } = await supabase
    .from('capex_projects')
    .insert({ name: name.trim(), sort_order: sortOrder })
    .select()
    .single();
  if (error || !data) return null;
  invalidateCapexProjects();
  await ensureCapexProjectsLoaded();
  return data as CapexProject;
}

/** Renames a capex project row and refreshes the local cache. */
export async function renameCapexProject(id: string, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const { error } = await supabase
    .from('capex_projects')
    .update({ name: trimmed })
    .eq('id', id);
  if (error) return false;
  invalidateCapexProjects();
  await ensureCapexProjectsLoaded();
  return true;
}

/** Deletes a capex project row. Rows tagged to it are NOT deleted — the
 *  `rows.capex_project_id` FK is ON DELETE SET NULL, so that site data
 *  simply becomes untagged rather than being destroyed. */
export async function deleteCapexProject(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('capex_projects')
    .delete()
    .eq('id', id);
  if (error) return false;
  invalidateCapexProjects();
  await ensureCapexProjectsLoaded();
  return true;
}

/** Marks a project as "current" (org-wide, shown as the CURRENT badge for
 *  every user) and clears the flag on every other project. Called whenever
 *  someone explicitly picks a project in the top-bar dropdown, so "current"
 *  always tracks the most recently selected project rather than being a
 *  separately-managed setting. */
export async function setCurrentCapexProject(id: string): Promise<boolean> {
  const { error: clearErr } = await supabase
    .from('capex_projects')
    .update({ is_current: false })
    .neq('id', id);
  if (clearErr) return false;
  const { error: setErr } = await supabase
    .from('capex_projects')
    .update({ is_current: true })
    .eq('id', id);
  if (setErr) return false;
  invalidateCapexProjects();
  await ensureCapexProjectsLoaded();
  return true;
}
