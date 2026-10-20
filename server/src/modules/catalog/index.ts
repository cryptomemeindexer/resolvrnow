import type { AppModule } from '../../engine/module.js';

/** Catalogs, items, variables, cart, requests and fulfillment. */
export const catalogModule: AppModule = {
  id: 'catalog',
  name: 'Service Catalog & Request Management',
  description: 'Catalogs, items, variables, cart, requests and fulfillment.',
  dependsOn: ['task', 'approvals'],
};
