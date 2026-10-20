import type { AppModule } from '../../engine/module.js';

/** Business schedules, holidays and business-time calculations. */
export const schedulesModule: AppModule = {
  id: 'schedules',
  name: 'Schedules',
  description: 'Business schedules, holidays and business-time calculations.',
  dependsOn: ['platform'],
};
