import type { AppModule } from '../../engine/module.js';

/** Incidents, incident tasks, major incidents, priority and auto-close. */
export const incidentModule: AppModule = {
  id: 'incident',
  name: 'Incident Management',
  description: 'Incidents, incident tasks, major incidents, priority and auto-close.',
  dependsOn: ['task'],
};
