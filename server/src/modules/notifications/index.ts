import type { AppModule } from '../../engine/module.js';

/** Email notifications, outbound email, templates, inbound email actions. */
export const notificationsModule: AppModule = {
  id: 'notifications',
  name: 'Notifications',
  description: 'Email notifications, outbound email, templates, inbound email actions.',
  dependsOn: ['platform'],
};
