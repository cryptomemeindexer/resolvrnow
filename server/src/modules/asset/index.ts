import type { AppModule } from '../../engine/module.js';

/** Hardware and software assets, lifecycle and asset/CI synchronization. */
export const assetModule: AppModule = {
  id: 'asset',
  name: 'Asset Management',
  description: 'Hardware and software assets, lifecycle and asset/CI synchronization.',
  dependsOn: ['cmdb'],
};
