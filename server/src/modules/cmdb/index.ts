import type { AppModule } from '../../engine/module.js';

/** CMDB classes, relationships, dependency views, impact analysis and CMDB APIs. */
export const cmdbModule: AppModule = {
  id: 'cmdb',
  name: 'Configuration Management',
  description: 'CMDB classes, relationships, dependency views, impact analysis and CMDB APIs.',
  dependsOn: ['task'],
};
