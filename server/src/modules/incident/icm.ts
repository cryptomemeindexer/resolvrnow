import type { Context } from '../../engine/context.js';
import { AbortError } from '../../engine/errors.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { recSubject } from '../../engine/rules.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { COMM_TASK_STATE, INC_STATE, PLAN_STATE, PROP } from './constants.js';
import { isMajorIncident, propBool } from './util.js';

/**
 * Incident Communications Management, minimal level: communication plans
 * (`incident_alert`) and their tasks (`incident_alert_task`), plan definitions that
 * attach plans to matching incidents, sending, closing and closure cascades.
 */

const OPEN_TASK_STATES = [
  COMM_TASK_STATE.PENDING,
  COMM_TASK_STATE.OPEN,
  COMM_TASK_STATE.IN_PROGRESS,
] as string[];

export function createCommunicationPlan(ctx: Context, inc: Rec, values: Record<string, unknown> = {}): Rec {
  if (!inc.bool('active')) throw new AbortError('Communication plans can only be added to active incidents');
  return ctx.insert('incident_alert', { source_incident: inc.sysId, ...values });
}

export function addCommunicationTask(ctx: Context, plan: Rec, values: Record<string, unknown>): Rec {
  return ctx.insert('incident_alert_task', { incident_alert: plan.sysId, ...values });
}

/** Records one communication: a one-time task completes, a recurring one stays in progress. */
export function sendCommunication(ctx: Context, task: Rec, message?: string): Rec {
  if (!OPEN_TASK_STATES.includes(task.str('state')))
    throw new AbortError('This communication task is already closed');
  const times = (task.num('times_performed') ?? 0) + 1;
  const recurring = task.str('communication_frequency') === 'recurring';
  ctx.update(task, {
    times_performed: times,
    last_communication_sent: nowGlide(),
    state: recurring ? COMM_TASK_STATE.IN_PROGRESS : COMM_TASK_STATE.COMPLETE,
    work_notes: message ? `Communication sent (${times}x): ${message}` : `Communication sent (${times}x)`,
  });
  return task;
}

/** Close Task: Complete when communicated at least once, otherwise Skipped. */
export function closeCommunicationTask(ctx: Context, task: Rec): Rec {
  if (!OPEN_TASK_STATES.includes(task.str('state'))) return task;
  ctx.update(task, { state: closedTaskState(task) });
  return task;
}

const closedTaskState = (task: Rec): string =>
  (task.num('times_performed') ?? 0) > 0 ? COMM_TASK_STATE.COMPLETE : COMM_TASK_STATE.SKIPPED;

export function closeCommunicationPlan(ctx: Context, plan: Rec, cancel = false): Rec {
  if (plan.str('state') !== PLAN_STATE.OPEN) return plan;
  ctx.update(plan, { state: cancel ? PLAN_STATE.CANCELED : PLAN_STATE.CLOSED });
  return plan;
}

/** Creates plans (and their tasks) from active definitions whose condition matches the incident. */
function attachPlansFromDefinitions(inc: Rec, ctx: Context): void {
  const sys = ctx.elevated();
  const defs = sys.query('comm_plan_definition', {
    query: 'active=true^tableISEMPTY^ORtable=incident^ORDERBYorder',
  });
  for (const def of defs) {
    if (!def.str('condition') || !matches(def.str('condition'), recSubject(inc, null, sys.registry), sys.env))
      continue;
    if (sys.count('incident_alert', `source_incident=${inc.sysId}^comm_plan_definition=${def.sysId}`) > 0)
      continue;
    const plan = sys.insert('incident_alert', {
      source_incident: inc.sysId,
      comm_plan_definition: def.sysId,
      type: def.str('type') || 'adhoc',
      short_description: def.str('short_description') || `${def.str('name')} for ${inc.str('number')}`,
    });
    for (const td of sys.query('comm_task_definition', {
      query: `comm_plan_definition=${def.sysId}^active=true^ORDERBYorder`,
    })) {
      const due = td.num('due_in');
      sys.insert('incident_alert_task', {
        incident_alert: plan.sysId,
        comm_task_definition: td.sysId,
        short_description: td.str('name'),
        channel: td.str('channel') || 'email',
        communication_frequency: td.str('communication_frequency') || 'once',
        due_in: due,
        due_date: due ? addMs(nowGlide(), due) : null,
        order: td.num('order'),
      });
    }
  }
}

export const ICM_RULES: BusinessRuleDef[] = [
  {
    name: 'Communication plan: defaults',
    table: 'incident_alert',
    when: 'before',
    actions: ['insert'],
    order: 50,
    run(cur, _prev, ctx) {
      const inc = cur.ref('source_incident');
      if (inc) {
        if (!cur.str('short_description'))
          cur.setRaw('short_description', `Communication plan for ${inc.str('number')}`);
        if (!cur.str('background')) {
          cur.setRaw(
            'background',
            [inc.str('short_description'), inc.str('description')].filter(Boolean).join('\n\n'),
          );
        }
        if (isMajorIncident(inc)) {
          if (!cur.str('assignment_group') && inc.str('assignment_group'))
            cur.setRaw('assignment_group', inc.str('assignment_group'));
          if (!cur.str('assigned_to') && inc.str('assigned_to'))
            cur.setRaw('assigned_to', inc.str('assigned_to'));
        }
      }
      if (!cur.str('assigned_to') && ctx.user.sysId) cur.setRaw('assigned_to', ctx.user.sysId);
    },
  },
  {
    name: 'Communication task: defaults from plan',
    table: 'incident_alert_task',
    when: 'before',
    actions: ['insert'],
    order: 50,
    run(cur) {
      const plan = cur.ref('incident_alert');
      if (!plan) return;
      cur.setRaw('comm_plan', plan.sysId);
      if (!cur.str('source_incident')) cur.setRaw('source_incident', plan.str('source_incident'));
      for (const f of ['assignment_group', 'assigned_to'])
        if (!cur.str(f) && plan.str(f)) cur.setRaw(f, plan.str(f));
      if (!cur.touched.has('state') && plan.str('state') === PLAN_STATE.OPEN)
        cur.setRaw('state', Number(COMM_TASK_STATE.OPEN));
    },
  },
  {
    name: 'Communication plan: events',
    table: 'incident_alert',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    run(cur, _prev, ctx) {
      const uid = ctx.user.sysId ?? '';
      if (cur.operation === 'insert') ctx.queueEvent('incident_alert.inserted', cur, uid, ctx.user.userName);
      if (cur.changed('actions_taken'))
        ctx.queueEvent('incident_alert.actions_taken', cur, uid, ctx.user.userName);
      if (cur.operation === 'insert' || !cur.changed('state')) return;
      if (cur.str('state') === PLAN_STATE.CLOSED)
        ctx.queueEvent('incident_alert.closed', cur, uid, ctx.user.userName);
      if (cur.str('state') === PLAN_STATE.CANCELED)
        ctx.queueEvent('incident_alert.canceled', cur, uid, ctx.user.userName);
    },
  },
  {
    name: 'Communication plan: close open tasks with the plan',
    table: 'incident_alert',
    when: 'after',
    actions: ['update'],
    order: 200,
    condition: (cur, _prev, ctx) =>
      cur.changed('state') &&
      cur.str('state') !== PLAN_STATE.OPEN &&
      propBool(ctx, PROP.alertTaskClosure, false),
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      for (const t of sys.query('incident_alert_task', {
        query: `incident_alert=${cur.sysId}^stateIN-5,1,2`,
      })) {
        sys.update(t, { state: closedTaskState(t) });
      }
    },
  },
  {
    name: 'Incident: close communication plans with the incident',
    table: 'incident',
    when: 'after',
    actions: ['update'],
    order: 310,
    condition: (cur, _prev, ctx) =>
      (cur.changedTo('state', INC_STATE.CLOSED) || cur.changedTo('state', INC_STATE.CANCELED)) &&
      propBool(ctx, PROP.alertClosure, false),
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      const cancel = cur.str('state') === INC_STATE.CANCELED;
      for (const plan of sys.query('incident_alert', {
        query: `source_incident=${cur.sysId}^state=${PLAN_STATE.OPEN}`,
      })) {
        closeCommunicationPlan(sys, plan, cancel);
      }
    },
  },
  {
    name: 'Incident: attach communication plans from definitions',
    table: 'incident',
    when: 'after',
    actions: ['insert', 'update'],
    order: 320,
    condition: (cur) => cur.bool('active'),
    run(cur, _prev, ctx) {
      attachPlansFromDefinitions(cur, ctx);
    },
  },
];
