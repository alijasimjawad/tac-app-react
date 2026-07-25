import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
const def: PageDef = {
  key: 'view_fin_invoices',
  label: 'Invoices',
  to: '/finance/invoices',
  group: 'finance',
  order: 8,
};

export default def;
