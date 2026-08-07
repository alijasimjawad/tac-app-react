import type { PageDef } from '../lib/permissionsCatalog';

const def: PageDef = {
  key: 'view_warehouse_movements',
  label: 'Stock Movements',
  to: '/warehouse/movements',
  group: 'warehouse',
  order: 5,
};

export default def;
