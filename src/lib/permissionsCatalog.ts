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

// Action permissions (table/section actions, not tied to a route) — scoped
// per page so an admin can grant e.g. full CRUD on Daily Activities to an
// Engineer without also granting it on Sites DB. Each scope's actions get
// their own key prefix (da_ = Daily Activities, sdb_ = Sites DB).
export interface ActionScope {
  id: string;
  label: string;
  actions: PermDef[];
}

export const ACTION_SCOPES: ActionScope[] = [
  {
    id: 'daily_activities',
    label: 'Daily Activities',
    actions: [
      { key: 'da_add_rows',    label: 'Add Rows' },
      { key: 'da_edit_rows',   label: 'Edit Rows' },
      { key: 'da_delete_rows', label: 'Delete Rows' },
    ],
  },
  {
    id: 'sites_db',
    label: 'Sites DB',
    actions: [
      { key: 'sdb_add_rows',       label: 'Add Rows' },
      { key: 'sdb_edit_rows',      label: 'Edit Rows' },
      { key: 'sdb_delete_rows',    label: 'Delete Rows' },
      { key: 'sdb_add_columns',    label: 'Add Columns' },
      { key: 'sdb_export_excel',   label: 'Export to Excel' },
      { key: 'sdb_add_section',    label: 'Add Section' },
      { key: 'sdb_rename_section', label: 'Rename Section' },
      { key: 'sdb_delete_section', label: 'Delete Section' },
    ],
  },
  {
    id: 'fin_exp_claims',
    label: 'Expense Claims (Admin)',
    actions: [
      { key: 'fin_exp_claims_approve', label: 'Approve Claims' },
      { key: 'fin_exp_claims_reject',  label: 'Reject Claims' },
      { key: 'fin_exp_claims_edit',    label: 'Edit Claims' },
      { key: 'fin_exp_claims_delete',  label: 'Delete Claims' },
      { key: 'fin_exp_claims_export',  label: 'Export to Excel' },
    ],
  },
  {
    id: 'fin_revenue',
    label: 'Revenue',
    actions: [
      { key: 'fin_revenue_add',          label: 'Add Revenue' },
      { key: 'fin_revenue_edit',         label: 'Edit Revenue' },
      { key: 'fin_revenue_delete',       label: 'Delete Revenue' },
      { key: 'fin_revenue_sync',         label: 'Sync Revenue' },
      { key: 'fin_revenue_fix_sections', label: 'Fix Sections' },
      { key: 'fin_revenue_export',       label: 'Export' },
    ],
  },
  {
    id: 'fin_team',
    label: 'Team Members',
    actions: [
      { key: 'fin_team_add',           label: 'Add Member' },
      { key: 'fin_team_edit',          label: 'Edit Member' },
      { key: 'fin_team_toggle_active', label: 'Activate/Deactivate' },
      { key: 'fin_team_delete',        label: 'Delete Member' },
      { key: 'fin_team_bulk_update',   label: 'Bulk Update' },
      { key: 'fin_team_bulk_add',      label: 'Bulk Add' },
      { key: 'fin_team_export',        label: 'Export' },
    ],
  },
  {
    id: 'fin_projexp',
    label: 'Project Expenses',
    actions: [
      { key: 'fin_projexp_add',    label: 'Add Expense' },
      { key: 'fin_projexp_edit',   label: 'Edit Expense' },
      { key: 'fin_projexp_delete', label: 'Delete Expense' },
      { key: 'fin_projexp_export', label: 'Export' },
    ],
  },
  {
    id: 'fin_invoices',
    label: 'Invoices',
    actions: [
      { key: 'fin_invoices_add',            label: 'Add Invoice' },
      { key: 'fin_invoices_edit',           label: 'Edit Invoice' },
      { key: 'fin_invoices_delete',         label: 'Delete Invoice' },
      { key: 'fin_invoices_record_payment', label: 'Record Payment' },
      { key: 'fin_invoices_download_pdf',   label: 'Download PDF' },
      { key: 'fin_invoices_add_item',       label: 'Add Line Item' },
    ],
  },
  {
    id: 'fin_clients',
    label: 'Clients',
    actions: [
      { key: 'fin_clients_add',    label: 'Add Client' },
      { key: 'fin_clients_edit',   label: 'Edit Client' },
      { key: 'fin_clients_delete', label: 'Delete Client' },
    ],
  },
  {
    id: 'fin_report',
    label: 'Monthly Report',
    actions: [
      { key: 'fin_report_adjust_salary', label: 'Adjust Salary' },
      { key: 'fin_report_adjust_all',    label: 'Adjust All' },
      { key: 'fin_report_export',        label: 'Export' },
    ],
  },
  {
    id: 'fin_payslips',
    label: 'Payslips',
    actions: [
      { key: 'fin_payslips_download_pdf', label: 'Download PDF' },
    ],
  },
  {
    id: 'fin_performance',
    label: 'Team Performance',
    actions: [
      { key: 'fin_performance_export', label: 'Export CSV' },
    ],
  },
  {
    id: 'fin_genexp',
    label: 'General Expenses',
    actions: [
      { key: 'fin_genexp_add',    label: 'Add Expense' },
      { key: 'fin_genexp_edit',   label: 'Edit Expense' },
      { key: 'fin_genexp_delete', label: 'Delete Expense' },
      { key: 'fin_genexp_export', label: 'Export' },
    ],
  },
  {
    id: 'hr_profiles',
    label: 'Employee Profiles',
    actions: [
      { key: 'hr_profiles_edit',         label: 'Edit Profile' },
      { key: 'hr_profiles_upload_photo', label: 'Upload Photo' },
      { key: 'hr_profiles_upload_doc',   label: 'Upload Document' },
      { key: 'hr_profiles_delete_doc',   label: 'Delete Document' },
    ],
  },
  {
    id: 'mywork_expenses',
    label: 'My Expenses',
    actions: [
      { key: 'mywork_expenses_add',    label: 'Add Expense' },
      { key: 'mywork_expenses_edit',   label: 'Edit Expense' },
      { key: 'mywork_expenses_delete', label: 'Delete Expense' },
    ],
  },
  {
    id: 'sitesdb_master',
    label: 'Sites DB (Master List)',
    actions: [
      { key: 'sitesdb_add',           label: 'Add Site' },
      { key: 'sitesdb_edit',          label: 'Edit Site' },
      { key: 'sitesdb_delete',        label: 'Delete Site' },
      { key: 'sitesdb_export',        label: 'Export' },
      { key: 'sitesdb_import',        label: 'Import' },
      { key: 'sitesdb_enrich_export', label: 'Enrich & Download' },
    ],
  },
  {
    id: 'activity_log',
    label: 'Activity Log',
    actions: [
      { key: 'activity_log_export', label: 'Export' },
      { key: 'activity_log_clear',  label: 'Clear Log' },
    ],
  },
  {
    id: 'attendance_admin',
    label: 'Attendance (Admin)',
    actions: [
      { key: 'attendance_admin_add',  label: 'Add Entry' },
      { key: 'attendance_admin_edit', label: 'Edit Entry' },
    ],
  },
  {
    id: 'live_trips',
    label: 'Live Trips',
    actions: [
      { key: 'live_trips_force_complete', label: 'Force Complete Trip' },
    ],
  },
  {
    id: 'fin_cars',
    label: 'Cars & Trips',
    actions: [
      { key: 'fin_cars_add',            label: 'Add Car' },
      { key: 'fin_cars_edit',           label: 'Edit Car' },
      { key: 'fin_cars_delete',         label: 'Delete Car' },
      { key: 'fin_cars_manage_points',  label: 'Manage Saved Points' },
      { key: 'fin_cars_edit_rate',      label: 'Edit KM Rate' },
    ],
  },
];

// Flattened list of every scoped action key — used where a page just needs
// to iterate/init all of them regardless of scope (e.g. UserManagement.tsx).
export const ACTION_DEFS: PermDef[] = ACTION_SCOPES.flatMap(s => s.actions);

// Maps each new scoped action key back to the single global key actions used
// before they were split per page. hasPerm() (AuthContext.tsx) and
// UserManagement.tsx's edit-modal init both fall back to this so any user
// already granted e.g. `add_rows` keeps working identically on both Daily
// Activities and Sites DB until an admin explicitly sets one of the new
// scoped keys for that user (which always wins from then on).
export const LEGACY_ACTION_KEY: Record<string, string> = {
  da_add_rows: 'add_rows', da_edit_rows: 'edit_rows', da_delete_rows: 'delete_rows',
  sdb_add_rows: 'add_rows', sdb_edit_rows: 'edit_rows', sdb_delete_rows: 'delete_rows',
  sdb_add_columns: 'add_columns', sdb_export_excel: 'export_excel',
  sdb_add_section: 'add_section', sdb_rename_section: 'rename_section', sdb_delete_section: 'delete_section',
};

// Finance/HR/Sites-DB-master/Activity-Log action keys below are NEW — before
// this rework, their buttons had NO permission check at all, so anyone who
// could see the page (i.e. had the page's `view_*` permission) could already
// add/edit/delete/export freely. To avoid silently taking away access people
// already rely on, hasPerm() (AuthContext.tsx) falls back to "can this user
// view the parent page?" for any key listed here that an admin hasn't
// explicitly set yet. An admin can still lock a specific user down to
// view-only by explicitly switching one of these off in User Management —
// that explicit value always wins from then on.
//
// A few exceptions are deliberately NOT listed here because they were already
// admin-only in practice (a hardcoded role check, not an open button):
// `sitesdb_delete`, `sitesdb_add`, `sitesdb_edit`, `sitesdb_import`,
// `sitesdb_enrich_export`, `activity_log_clear`, and `fin_exp_claims_edit`.
// Those simply fall through to "false for non-admins", matching their prior
// real behavior exactly.
export const LEGACY_OPEN_ACTIONS: Record<string, string> = {
  fin_exp_claims_approve: 'view_exp_claims',
  fin_exp_claims_reject: 'view_exp_claims',
  fin_exp_claims_delete: 'view_exp_claims',
  fin_exp_claims_export: 'view_exp_claims',

  fin_revenue_add: 'view_fin_revenue',
  fin_revenue_edit: 'view_fin_revenue',
  fin_revenue_delete: 'view_fin_revenue',
  fin_revenue_sync: 'view_fin_revenue',
  fin_revenue_fix_sections: 'view_fin_revenue',
  fin_revenue_export: 'view_fin_revenue',

  fin_team_add: 'view_fin_team',
  fin_team_edit: 'view_fin_team',
  fin_team_toggle_active: 'view_fin_team',
  fin_team_delete: 'view_fin_team',
  fin_team_bulk_update: 'view_fin_team',
  fin_team_bulk_add: 'view_fin_team',
  fin_team_export: 'view_fin_team',

  fin_projexp_add: 'view_fin_projexp',
  fin_projexp_edit: 'view_fin_projexp',
  fin_projexp_delete: 'view_fin_projexp',
  fin_projexp_export: 'view_fin_projexp',

  fin_invoices_add: 'view_fin_invoices',
  fin_invoices_edit: 'view_fin_invoices',
  fin_invoices_delete: 'view_fin_invoices',
  fin_invoices_record_payment: 'view_fin_invoices',
  fin_invoices_download_pdf: 'view_fin_invoices',
  fin_invoices_add_item: 'view_fin_invoices',

  fin_clients_add: 'view_fin_clients',
  fin_clients_edit: 'view_fin_clients',
  fin_clients_delete: 'view_fin_clients',

  fin_report_adjust_salary: 'view_fin_report',
  fin_report_adjust_all: 'view_fin_report',
  fin_report_export: 'view_fin_report',

  fin_payslips_download_pdf: 'view_fin_payslips',

  fin_performance_export: 'view_fin_performance',

  fin_genexp_add: 'view_fin_genexp',
  fin_genexp_edit: 'view_fin_genexp',
  fin_genexp_delete: 'view_fin_genexp',
  fin_genexp_export: 'view_fin_genexp',

  hr_profiles_edit: 'view_hr_profiles',
  hr_profiles_upload_photo: 'view_hr_profiles',
  hr_profiles_upload_doc: 'view_hr_profiles',
  hr_profiles_delete_doc: 'view_hr_profiles',

  mywork_expenses_add: 'view_my_expenses',
  mywork_expenses_edit: 'view_my_expenses',
  mywork_expenses_delete: 'view_my_expenses',

  sitesdb_export: 'view_sites_db',

  activity_log_export: 'view_activity_log',
};
