import type { AppModule } from '../../engine/module.js';

/** SLA definitions and task SLA timers. */
export const slaModule: AppModule = {
  id: 'sla',
  name: 'Service Level Management',
  description: 'SLA definitions and task SLA timers.',
  dependsOn: ['task', 'schedules'],
};
