import type { AppModule } from '../../engine/module.js';

/** Record-triggered flows with actions, approvals and waits. */
export const flowModule: AppModule = {
  id: 'flow',
  name: 'Flows',
  description: 'Record-triggered flows with actions, approvals and waits.',
  dependsOn: ['task', 'approvals'],
};
