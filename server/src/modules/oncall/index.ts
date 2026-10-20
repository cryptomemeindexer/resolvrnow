import type { AppModule } from '../../engine/module.js';

/** Rotas, rosters, escalation policies and who-is-on-call. */
export const oncallModule: AppModule = {
  id: 'oncall',
  name: 'On-Call Scheduling',
  description: 'Rotas, rosters, escalation policies and who-is-on-call.',
  dependsOn: ['schedules'],
};
