import type { AppModule } from '../../engine/module.js';

/** Reports, dashboards and ITSM KPIs. */
export const analyticsModule: AppModule = {
  id: 'analytics',
  name: 'Analytics',
  description: 'Reports, dashboards and ITSM KPIs.',
  dependsOn: ['task'],
};
