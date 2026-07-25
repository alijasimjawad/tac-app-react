import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
// fieldRoleDefault: Engineer/Technician users see this by default (scoped to
// their own activities only, see DailyActivities.tsx) until an admin
// explicitly turns it off for them in User Management.
const def: PageDef = {
  key: 'view_daily_activities',
  label: 'Daily Activities',
  to: '/daily-activities',
  group: 'daily',
  order: 1,
  fieldRoleDefault: true,
};

export default def;
