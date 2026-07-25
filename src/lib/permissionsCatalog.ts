// ── Permissions catalog — single source of truth ────────────────────────────
//
// Sidebar.tsx (nav visibility) and UserManagement.tsx (the permission editor
// toggles) both import from this file instead of keeping their own hardcoded
// copies.
//
// HOW TO ADD A NEW PERMISSION-GATED PAGE (fully automatic — nothing to edit
// in this file):
//   1. Build the page as usual (e.g. src/pages/VehicleLog.tsx).
//   2. Add a sibling file src/pages/VehicleLog.perm.ts — copy an existing one
//      (e.g. SiteLookup.perm.ts) and change key/label/to/group/order.
//   3. Inside the page itself, add the access guard:
//        if (!hasPerm('view_vehicle_log')) { ...access denied... }
// That's it. This file auto-discovers every `*.perm.ts` file under
// src/pages/ at build time and both the sidebar and the User Management
// editor pick the new entry up automatically.

export interface PermDef {
  key: string;
  label: string;
}

export interface NavPermDef extends PermDef {
  to: string;
}

export type PermGroup = 'core' | 'daily' | 'finance' | 'hr' | 'admin';

export interface PageDef extends NavPermDef {
  group: PermGroup;
  // Controls display order within its group (lower first). Optional — ties
  // fall back to discovery order.
  order?: number;
  // Grants this permission by default for Engineer/Technician roles until an
  // admin explicitly overrides it for a specific user in User Management —
  // see hasPerm() in AuthContext.tsx for how explicit values always win.
  fieldRoleDefault?: boolean;
}

// ── Auto-discovery of every colocated `*.perm.ts` file under src/pages/ ────

const permModules = import.meta.glob<{ default: PageDef }>('../pages/*.perm.ts', { eager: true });

const allPageDefs: PageDef[] = Object.values(permModules)
  .map(m => m.default)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

function byGroup(group: PermGroup): NavPermDef[] {
  return allPageDefs.filter(d => d.group === group);
}

// ── View permissions tied to a specific route ───────────────────────────────

export const VIEW_CORE: NavPermDef[] = byGroup('core');
export const VIEW_DAILY_WORK: NavPermDef[] = byGroup('daily');
export const VIEW_FINANCE: NavPermDef[] = byGroup('finance');
export const VIEW_HR: NavPermDef[] = byGroup('hr');
export const VIEW_ADMIN: NavPermDef[] = byGroup('admin');

// Keys that default to GRANTED for Engineer/Technician roles when the
// permission hasn't been explicitly set by an admin yet — collected
// automatically from each page's own `fieldRoleDefault: true` flag. Once an
// admin explicitly toggles one of these on or off for a specific user in
// User Management, that explicit value always wins over this default (see
// hasPerm() in AuthContext.tsx).
//
// Daily Activities deliberately does NOT set this flag — engineers/
// technicians have it hidden by default per an earlier, explicit request;
// admins can still grant it to individual users.
export const FIELD_ROLE_DEFAULT_KEYS: string[] = allPageDefs
  .filter(d => d.fieldRoleDefault)
  .map(d => d.key);

// ── Not page/route based — kept here directly ───────────────────────────────

// Real, enforced permission (MyExpenses.tsx / SiteLookup.tsx gate on it) but
// My Expenses is always in the sidebar rather than being a distinct nav link
// controlled by this key, so it isn't part of the auto-discovered page defs.
export const VIEW_OTHER: PermDef[] = [
  { key: 'view_my_expenses', label: 'My Expenses' },
];

// Action permissions (table/section actions, not tied to a route).
export const ACTION_DEFS: PermDef[] = [
  { key: 'add_rows',       label: 'Add Rows' },
  { key: 'edit_rows',      label: 'Edit Rows' },
  { key: 'delete_rows',    label: 'Delete Rows' },
  { key: 'add_columns',    label: 'Add Columns' },
  { key: 'export_excel',   label: 'Export to Excel' },
  { key: 'add_section',    label: 'Add Section' },
  { key: 'rename_section', label: 'Rename Section' },
  { key: 'delete_section', label: 'Delete Section' },
];
