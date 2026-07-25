// ── Permissions catalog — single source of truth ────────────────────────────
//
// Sidebar.tsx (nav visibility) and UserManagement.tsx (the permission editor
// toggles) both import from this file instead of keeping their own hardcoded
// copies. To add a new permission-gated page/link, add one entry here and
// wire the matching `hasPerm(key)` check into the page itself — both the
// sidebar and the User Management editor pick it up automatically.

export interface PermDef {
  key: string;
  label: string;
}

export interface NavPermDef extends PermDef {
  to: string;
}

// ── View permissions tied to a specific route ───────────────────────────────

export const VIEW_CORE: NavPermDef[] = [
  { key: 'view_dashboard', label: 'Dashboard', to: '/dashboard' },
];

export const VIEW_DAILY_WORK: NavPermDef[] = [
  { key: 'view_daily_activities', label: 'Daily Activities', to: '/daily-activities' },
  { key: 'view_site_lookup',      label: 'Site Lookup',      to: '/site-lookup' },
  { key: 'view_route_planner',    label: 'Route Planner',    to: '/route-planner' },
  { key: 'view_sites_db',         label: 'Sites DB',         to: '/sites-db' },
  { key: 'view_my_attendance',    label: 'My Attendance',    to: '/attendance' },
  { key: 'view_my_trips',         label: 'My Trips',         to: '/my-trips' },
];

// Keys in this list default to GRANTED for Engineer/Technician roles when the
// permission hasn't been explicitly set by an admin yet — this preserves the
// "default field nav" (Sites DB / My Attendance / My Trips / My Expenses)
// those roles have always had. Once an admin explicitly toggles one of these
// on or off for a specific user in User Management, that explicit value always
// wins over this default (see hasPerm() in AuthContext.tsx).
//
// Daily Activities is deliberately NOT in this list — engineers/technicians
// have it hidden by default per an earlier, explicit request; admins can still
// grant it to individual users.
export const FIELD_ROLE_DEFAULT_KEYS: string[] = [
  'view_sites_db',
  'view_my_attendance',
  'view_my_trips',
];

export const VIEW_FINANCE: NavPermDef[] = [
  { key: 'view_fin_team',      label: 'Team Members',           to: '/finance/team' },
  { key: 'view_fin_revenue',   label: 'Revenue',                to: '/finance/revenue' },
  { key: 'view_fin_genexp',    label: 'General Expenses',       to: '/finance/general-expenses' },
  { key: 'view_fin_projexp',   label: 'Project Expenses',       to: '/finance/project-expenses' },
  { key: 'view_fin_dashboard', label: 'Finance Dashboard',      to: '/finance/dashboard' },
  { key: 'view_fin_report',    label: 'Monthly Report',         to: '/finance/monthly-report' },
  { key: 'view_fin_clients',   label: 'Clients',                to: '/finance/clients' },
  { key: 'view_fin_invoices',  label: 'Invoices',               to: '/finance/invoices' },
  { key: 'view_exp_claims',    label: 'Expense Claims (Admin)', to: '/finance/expense-claims' },
];

export const VIEW_HR: NavPermDef[] = [
  { key: 'view_hr_profiles', label: 'Employee Profiles', to: '/hr-profiles' },
];

export const VIEW_ADMIN: NavPermDef[] = [
  { key: 'view_activity_log', label: 'Activity Log', to: '/activity-log' },
];

// Real, enforced permission (MyExpenses.tsx / SiteLookup.tsx gate on it) but
// My Expenses is always in the sidebar rather than being a distinct nav link
// controlled by this key, so it isn't in a nav group above.
export const VIEW_OTHER: PermDef[] = [
  { key: 'view_my_expenses', label: 'My Expenses' },
];

// ── Action permissions (table/section actions, not tied to a route) ────────

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
