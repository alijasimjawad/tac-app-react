import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
const def: PageDef = {
  key: 'view_exp_claims',
  label: 'Expense Claims (Admin)',
  to: '/finance/expense-claims',
  group: 'finance',
  order: 9,
};

export default def;
