import type { AppModule } from '../../engine/module.js';

/** Change requests, change tasks, CAB, risk, conflicts, schedules and change API. */
export const changeModule: AppModule = {
  id: 'change',
  name: 'Change Management',
  description: 'Change requests, change tasks, CAB, risk, conflicts, schedules and change API.',
  dependsOn: ['task', 'cmdb', 'approvals', 'schedules'],
};
