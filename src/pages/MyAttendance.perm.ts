import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
// fieldRoleDefault: Engineer/Technician users see this by default until an
// admin explicitly turns it off for them in User Management.
const def: PageDef = {
  key: 'view_my_attendance',
  label: 'My Attendance',
  to: '/attendance',
  group: 'daily',
  order: 5,
  fieldRoleDefault: true,
};

export default def;
