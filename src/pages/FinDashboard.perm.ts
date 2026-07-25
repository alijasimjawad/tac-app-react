import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
const def: PageDef = {
  key: 'view_fin_dashboard',
  label: 'Finance Dashboard',
  to: '/finance/dashboard',
  group: 'finance',
  order: 5,
};

export default def;
