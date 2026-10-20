import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { diffMs, nowGlide } from '../../engine/util.js';

/** Task Outage: outages (`cmdb_ci_outage`) linked to incidents, problems and changes through `task_outage`. */
export const OUTAGE_TASK_CLASSES = ['incident', 'problem', 'change_request'];

export function linkOutage(ctx: Context, outageId: string, taskId: string): void {
  const sys = ctx.elevated();
  if (sys.count('task_outage', `task=${taskId}^outage=${outageId}`) === 0)
    sys.insert('task_outage', { task: taskId, outage: outageId });
}

export function beginOutageNow(ctx: Context, outage: Rec): Rec {
  return ctx.update(outage, { begin: nowGlide() });
}

export function endOutageNow(ctx: Context, outage: Rec): Rec {
  return ctx.update(outage, { end: nowGlide() });
}

export const OUTAGE_RULES: BusinessRuleDef[] = [
  {
    name: 'Outage: compute duration',
    table: 'cmdb_ci_outage',
    when: 'before',
    actions: ['insert', 'update'],
    order: 100,
    run(cur) {
      const begin = cur.str('begin');
      const end = cur.str('end');
      cur.setRaw('duration', begin && end ? Math.max(0, diffMs(end, begin)) : null);
    },
  },
  {
    name: 'Outage: link to the originating task',
    table: 'cmdb_ci_outage',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    condition: (cur) => cur.changed('task_number') && !!cur.str('task_number'),
    run(cur, _prev, ctx) {
      linkOutage(ctx, cur.sysId, cur.str('task_number'));
    },
  },
];
