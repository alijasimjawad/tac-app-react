import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
// Previously this page had no permission entry at all — only reachable via a
// hardcoded isAdmin check in Sidebar.tsx (admins still get it automatically
// since hasPerm() always returns true for role === 'admin').
const def: PageDef = {
  key: 'view_live_trips',
  label: 'Live Trips',
  to: '/live-trips',
  group: 'admin',
  order: 0,
};

export default def;
