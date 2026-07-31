import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
const def: PageDef = {
  key: 'view_fin_payslips',
  label: 'Payslips',
  to: '/finance/payslips',
  group: 'finance',
  order: 10,
};

export default def;
