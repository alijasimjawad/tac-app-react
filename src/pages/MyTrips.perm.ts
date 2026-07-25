import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
// fieldRoleDefault: Engineer/Technician users see this by default until an
// admin explicitly turns it off for them in User Management.
const def: PageDef = {
  key: 'view_my_trips',
  label: 'My Trips',
  to: '/my-trips',
  group: 'daily',
  order: 6,
  fieldRoleDefault: true,
};

export default def;
