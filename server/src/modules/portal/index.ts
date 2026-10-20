import type { AppModule } from '../../engine/module.js';

/** Self-service portal APIs: taxonomy, universal requests, surveys, favorites. */
export const portalModule: AppModule = {
  id: 'portal',
  name: 'Employee Portal',
  description: 'Self-service portal APIs: taxonomy, universal requests, surveys, favorites.',
  dependsOn: ['catalog', 'knowledge', 'incident'],
};
