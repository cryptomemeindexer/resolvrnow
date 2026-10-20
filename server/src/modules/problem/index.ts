import type { AppModule } from '../../engine/module.js';
import { seedNotifications } from '../incident/notifications.js';
import { taskStates } from '../task/index.js';
import { PROBLEM_ACLS, PROBLEM_QUERY_RULES, PROBLEM_ROLES } from './acls.js';
import { PROBLEM_MODULE_CHOICES } from './choices.js';
import { PROBLEM_EVENTS, PROBLEM_NOTIFICATIONS, PROBLEM_PROPERTIES } from './config.js';
import { seedProblemDemo } from './demo.js';
import { PROBLEM_RULES } from './rules.js';
import { seedProblemData } from './seed.js';
import { PROBLEM_TABLES } from './tables.js';
import { PROBLEM_UI } from './ui.js';

/** Problems, problem tasks, known errors, workarounds and the problem to incident synchronization. */
export const problemModule: AppModule = {
  id: 'problem',
  name: 'Problem Management',
  description:
    'Problems, problem tasks, known errors, workarounds and the problem to incident synchronization.',
  dependsOn: ['incident'],
  tables: PROBLEM_TABLES,
  choices: PROBLEM_MODULE_CHOICES,
  roles: PROBLEM_ROLES,
  acls: PROBLEM_ACLS,
  rules: [...PROBLEM_RULES, ...PROBLEM_QUERY_RULES],
  properties: PROBLEM_PROPERTIES,
  events: PROBLEM_EVENTS,
  ui: PROBLEM_UI,
  register(platform) {
    const states = taskStates(platform);
    states.register('problem', { closed: ['107'], resolved: ['106'], defaultClosed: '107' });
    states.register('problem_task', { closed: ['157'], defaultClosed: '157' });
  },
  seedVersion: 1,
  seed: seedProblemData,
  afterBoot(platform) {
    seedNotifications(platform, PROBLEM_NOTIFICATIONS, 'resolvr.problem.notifications.seeded');
  },
  demo: seedProblemDemo,
};
