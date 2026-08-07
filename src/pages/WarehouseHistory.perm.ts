import type { PageDef } from '../lib/permissionsCatalog';

const def: PageDef = {
  key: 'view_warehouse_history',
  label: 'Receiving History',
  to: '/warehouse/history',
  group: 'warehouse',
  order: 5,
};

export default def;
