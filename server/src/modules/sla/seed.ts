import type { Context } from '../../engine/context.js';
import { CONDITION_CLASSES } from './conditions.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface SlaDefinitionSeed {
  name: string;
  target: 'response' | 'resolution';
  duration: number;
  priority: number;
  stop: string;
  pause?: string;
  schedule?: string;
}

/**
 * Example incident definitions. Incident states: 1 New, 2 In Progress, 3 On Hold,
 * 6 Resolved, 7 Closed, 8 Canceled. "3 business days" is 27 hours of 8-5 schedule time.
 */
export const SEED_DEFINITIONS: SlaDefinitionSeed[] = [
  {
    name: 'P1 resolution (4 hour)',
    target: 'resolution',
    duration: 4 * HOUR,
    priority: 1,
    stop: 'stateIN6,7',
    pause: 'state=3',
  },
  {
    name: 'P2 resolution (8 hour)',
    target: 'resolution',
    duration: 8 * HOUR,
    priority: 2,
    stop: 'stateIN6,7',
    pause: 'state=3',
  },
  {
    name: 'P3 resolution (3 business days)',
    target: 'resolution',
    duration: 27 * HOUR,
    priority: 3,
    stop: 'stateIN6,7',
    pause: 'state=3',
    schedule: '8-5 weekdays excluding holidays',
  },
  {
    name: 'P1 response (15 minute)',
    target: 'response',
    duration: 15 * MIN,
    priority: 1,
    stop: 'assigned_toISNOTEMPTY^ORstateIN6,7',
  },
];

export function seedSla(ctx: Context): void {
  for (const name of [CONDITION_CLASSES.base, CONDITION_CLASSES.simple]) {
    if (!ctx.first('sla_condition_class', `name=${name}`))
      ctx.insert('sla_condition_class', { name, active: true });
  }
  for (const d of SEED_DEFINITIONS) {
    if (ctx.first('contract_sla', `name=${d.name}`)) continue;
    const schedule = d.schedule ? ctx.first('cmn_schedule', `name=${d.schedule}`) : null;
    ctx.insert('contract_sla', {
      name: d.name,
      type: 'SLA',
      target: d.target,
      collection: 'incident',
      active: true,
      duration: d.duration,
      schedule_source: schedule ? 'sla_definition' : 'no_schedule',
      schedule: schedule?.sysId ?? null,
      timezone_source: 'task.caller_id.time_zone',
      start_condition: `priority=${d.priority}^active=true`,
      stop_condition: d.stop,
      pause_condition: d.pause ?? '',
      when_to_cancel: 'no_match',
      when_to_resume: 'no_match',
      reset_action: 'cancel',
    });
  }
}
