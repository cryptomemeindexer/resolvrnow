import type { AppModule } from '../../engine/module.js';
import { taskStates } from '../task/index.js';
import { INCIDENT_ACLS, INCIDENT_QUERY_RULES } from './acls.js';
import { INCIDENT_MODULE_CHOICES } from './choices.js';
import { seedIncidentDemo } from './demo.js';
import { INCIDENT_EVENTS } from './events.js';
import { ICM_RULES } from './icm.js';
import { INCIDENT_JOBS } from './jobs.js';
import { MIM_RULES } from './mim.js';
import { INCIDENT_NOTIFICATIONS, seedNotifications } from './notifications.js';
import { OUTAGE_RULES } from './outage.js';
import { INCIDENT_PROPERTIES } from './properties.js';
import { INCIDENT_ROLES } from './roles.js';
import { INCIDENT_RULES } from './rules.js';
import { seedIncidentData } from './seed.js';
import { INCIDENT_TABLES } from './tables.js';
import { INCIDENT_UI, pruneRelatedLists } from './ui.js';

/** Incidents, incident tasks, major incidents, communication plans, outages, priority and auto-close. */
export const incidentModule: AppModule = {
  id: 'incident',
  name: 'Incident Management',
  description:
    'Incidents, incident tasks, major incidents, communication plans, outages, priority and auto-close.',
  dependsOn: ['task'],
  tables: INCIDENT_TABLES,
  choices: INCIDENT_MODULE_CHOICES,
  roles: INCIDENT_ROLES,
  acls: INCIDENT_ACLS,
  rules: [...INCIDENT_RULES, ...MIM_RULES, ...ICM_RULES, ...OUTAGE_RULES, ...INCIDENT_QUERY_RULES],
  properties: INCIDENT_PROPERTIES,
  events: INCIDENT_EVENTS,
  jobs: INCIDENT_JOBS,
  ui: INCIDENT_UI,
  register(platform) {
    const states = taskStates(platform);
    states.register('incident', { closed: ['7', '8'], resolved: ['6'], defaultClosed: '7' });
    states.register('incident_alert', { closed: ['3', '7'], defaultClosed: '3' });
    states.register('incident_alert_task', { closed: ['3', '7'], defaultClosed: '3' });
    states.enablePriorityLookup('incident');
    pruneRelatedLists(platform);
  },
  seedVersion: 1,
  seed: seedIncidentData,
  afterBoot(platform) {
    seedNotifications(platform, INCIDENT_NOTIFICATIONS, 'resolvr.incident.notifications.seeded');
  },
  demo: seedIncidentDemo,
};
