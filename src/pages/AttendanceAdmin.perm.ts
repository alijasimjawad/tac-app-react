import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
// Previously this page had no permission entry at all — only reachable via a
// hardcoded isAdmin check in Sidebar.tsx (admins still get it automatically
// since hasPerm() always returns true for role === 'admin').
const def: PageDef = {
  key: 'view_attendance_admin',
  label: 'Attendance (Admin)',
  to: '/attendance-admin',
  group: 'hr',
  order: 2,
};

export default def;
