import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { AppModule, RelatedListDef } from '../../engine/module.js';
import type { SchemaRegistry } from '../../engine/registry.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { clock } from '../../engine/util.js';
import { SERVICES } from '../contracts.js';
import { registerSlaApi } from './api.js';
import { SLA_PROPS, SlaEngine, slaEngine } from './engine.js';
import { SLA_EVENTS } from './notify.js';
import { seedSla } from './seed.js';
import { slaTables } from './tables.js';

export { SlaEngine, slaEngine } from './engine.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The SLA update jobs and the planned_end_time window each one recalculates. */
export const SLA_UPDATE_JOBS = [
  {
    id: 'sla.update.10min',
    name: 'SLA update (breach within 10 min)',
    intervalMs: MIN,
    from: 0,
    to: 10 * MIN,
  },
  {
    id: 'sla.update.1hour',
    name: 'SLA update (breach within 1 hour)',
    intervalMs: 10 * MIN,
    from: 10 * MIN,
    to: HOUR,
  },
  { id: 'sla.update.1day', name: 'SLA update (breach within 1 day)', intervalMs: HOUR, from: HOUR, to: DAY },
  {
    id: 'sla.update.30days',
    name: 'SLA update (breach within 30 days)',
    intervalMs: DAY,
    from: DAY,
    to: 30 * DAY,
  },
  {
    id: 'sla.update.later',
    name: 'SLA update (breach after 30 days)',
    intervalMs: 5 * DAY,
    from: 30 * DAY,
    to: 365 * DAY,
  },
  {
    id: 'sla.update.breached',
    name: 'SLA update (already breached)',
    intervalMs: DAY,
    from: -365 * DAY,
    to: 0,
  },
];

/** task_sla fields only the engine maintains. */
const ENGINE_FIELDS = [
  'stage',
  'active',
  'start_time',
  'end_time',
  'pause_time',
  'pause_duration',
  'business_pause_duration',
  'duration',
  'business_duration',
  'percentage',
  'business_percentage',
  'time_left',
  'business_time_left',
  'planned_end_time',
  'original_breach_time',
  'has_breached',
  'schedule',
  'timezone',
];

const TASK_SLA_COLUMNS = [
  'sla',
  'stage',
  'has_breached',
  'business_percentage',
  'business_time_left',
  'planned_end_time',
  'start_time',
];

/** Dot path on a table that must end in a reference to cmn_schedule. */
function endsInSchedule(registry: SchemaRegistry, table: string, path: string): boolean | null {
  let meta = registry.tryTable(table);
  if (!meta) return null;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const col = meta.columns.get(parts[i]);
    if (col?.type !== 'reference' || !col.reference) return false;
    if (i === parts.length - 1) return col.reference === 'cmn_schedule';
    meta = registry.tryTable(col.reference);
    if (!meta) return null;
  }
  return false;
}

const slaRules: BusinessRuleDef[] = [
  {
    name: 'SLA definition: validate',
    table: 'contract_sla',
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.bool('active'),
    run(cur, _prev, ctx) {
      const table = ctx.registry.tryTable(cur.str('collection'));
      if (table && !table.ancestors.includes('task'))
        return cur.abort('The table of an SLA definition must be task or a table extending task');
      if (!cur.str('duration_type')) {
        const max = ctx.platform.properties.getNumber(SLA_PROPS.maxDuration, 1095) * DAY;
        const d = cur.num('duration') ?? 0;
        if (d <= 0) return cur.abort('A user specified duration must be greater than zero');
        if (d > max)
          return cur.abort(`The duration cannot exceed ${max / DAY} days (${SLA_PROPS.maxDuration})`);
      }
      if (cur.bool('retroactive') && !cur.str('set_start_to'))
        return cur.abort('"Set start to" is required for a retroactive start');
      if (cur.str('flow') && cur.str('workflow'))
        return cur.abort('An SLA definition cannot use both a flow and a workflow');
      if (cur.str('schedule_source') === 'task_field') {
        const path = cur.str('schedule_source_field');
        if (!path || endsInSchedule(ctx.registry, cur.str('collection'), path) === false)
          return cur.abort('The schedule source field must be a reference to a schedule');
      }
    },
  },
  {
    name: 'Task SLA: engine-owned fields',
    table: 'task_sla',
    when: 'before',
    actions: ['update'],
    order: 10,
    condition: (_cur, _prev, ctx) =>
      !slaEngine(ctx.platform)?.isEngineContext(ctx) && !ctx.hasRole('sla_admin'),
    run(cur) {
      for (const f of ENGINE_FIELDS) if (cur.changed(f)) cur.setRaw(f, cur.prev(f));
    },
  },
  {
    name: 'Task SLA: calculate on display',
    table: 'task_sla',
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.platform.properties.getBool(SLA_PROPS.calcOnDisplay)) return;
      const m = /(?:^|\^)task=([0-9a-f]{32})(?=\^|$)/.exec(qb.encoded());
      if (m) slaEngine(ctx.platform)?.refreshTask(ctx, m[1]);
    },
  },
];

/** SLA definitions and task SLA timers. */
export const slaModule: AppModule = {
  id: 'sla',
  name: 'Service Level Management',
  description: 'SLA definitions and task SLA timers.',
  dependsOn: ['task', 'schedules'],
  tables: slaTables,
  roles: [
    {
      name: 'sla_manager',
      description: 'Maintains SLA definitions and reviews repair logs',
      contains: ['flow_operator'],
    },
    {
      name: 'sla_admin',
      description: 'Administers Service Level Management: properties, definitions and repair',
      contains: ['sla_manager', 'schedule_admin', 'flow_operator'],
    },
  ],
  acls: [
    { name: 'contract_sla', operation: 'read', roles: ['itil', 'sla_manager'] },
    ...(['write', 'create', 'delete'] as const).map((operation) => ({
      name: 'contract_sla',
      operation,
      roles: ['sla_manager'],
    })),
    { name: 'task_sla', operation: 'read', roles: ['itil', 'sla_manager'] },
    { name: 'task_sla', operation: 'write', roles: ['sla_admin'] },
    { name: 'task_sla', operation: 'create', roles: ['sla_admin'] },
    { name: 'task_sla', operation: 'delete', roles: ['admin'] },
    { name: 'sla_condition_class', operation: 'read', roles: ['itil', 'sla_manager'] },
    ...(['write', 'create', 'delete'] as const).map((operation) => ({
      name: 'sla_condition_class',
      operation,
      roles: ['sla_admin'],
    })),
    ...['resolvr_sla_timer', 'sla_repair_log', 'sla_repair_log_entry'].map((name) => ({
      name,
      operation: 'read' as const,
      roles: ['sla_manager'],
    })),
    ...['resolvr_sla_timer', 'sla_repair_log', 'sla_repair_log_entry'].flatMap((name) =>
      (['write', 'create', 'delete'] as const).map((operation) => ({ name, operation, roles: ['admin'] })),
    ),
  ],
  properties: [
    {
      name: 'com.snc.sla.engine.version',
      value: '2011',
      type: 'choicelist',
      choices: '2011',
      description: 'SLA engine version (ResolvrNow implements 2011 only)',
    },
    {
      name: SLA_PROPS.async,
      value: 'false',
      type: 'boolean',
      description: 'Run the SLA engine after commit in a background job',
    },
    {
      name: SLA_PROPS.compat,
      value: 'false',
      type: 'boolean',
      description: 'Use the Breached and Achieved stages',
    },
    { name: SLA_PROPS.conditionClass, value: 'SLAConditionBase', description: 'Default SLA condition rules' },
    {
      name: SLA_PROPS.pctLimit,
      value: '1000',
      type: 'integer',
      description:
        'Update jobs skip task SLAs above this actual percentage; 0 stops job calculations; blank = no limit',
    },
    {
      name: SLA_PROPS.maxDuration,
      value: '1095',
      type: 'integer',
      description: 'Maximum SLA duration in days',
    },
    {
      name: SLA_PROPS.workflowForBreached,
      value: 'false',
      type: 'boolean',
      description: 'Start the workflow for SLAs already breached when attached',
    },
    {
      name: SLA_PROPS.flowForBreached,
      value: 'false',
      type: 'boolean',
      description: 'Start the flow (percentage timers) for SLAs already breached when attached',
    },
    {
      name: SLA_PROPS.plannedAfterBreach,
      value: 'false',
      type: 'boolean',
      description: 'Keep recalculating the breach time after a breach',
    },
    {
      name: SLA_PROPS.useTimeLeft,
      value: 'false',
      type: 'boolean',
      description: 'Detect breaches from the time left instead of the rounded percentage',
    },
    {
      name: SLA_PROPS.calcOnDisplay,
      value: 'false',
      type: 'boolean',
      description: "Recalculate a task's SLAs when they are displayed",
    },
    {
      name: SLA_PROPS.alwaysBusiness,
      value: 'true',
      type: 'boolean',
      description: 'Without a schedule, business fields copy the actual fields',
    },
    { name: SLA_PROPS.repair, value: 'true', type: 'boolean', description: 'Enable SLA repair' },
    {
      name: 'com.snc.sla.run_old_sla_engine',
      value: 'false',
      type: 'boolean',
      description: 'Legacy escalation engine (not supported, ignored)',
    },
    {
      name: SLA_PROPS.legacy,
      value: 'false',
      type: 'boolean',
      description: 'Maintain task.made_sla and task.sla_due from task SLAs',
    },
    {
      name: SLA_PROPS.notifications,
      value: 'true',
      type: 'boolean',
      description:
        'Email assignees (and managers) at 50, 75 and 100 % when the notifications module is installed',
    },
  ],
  events: [
    {
      name: SLA_EVENTS.warning50,
      table: 'task_sla',
      description: 'A task SLA reached 50 % of its target (parm1 = task, parm2 = threshold)',
    },
    { name: SLA_EVENTS.warning75, table: 'task_sla', description: 'A task SLA reached 75 % of its target' },
    { name: SLA_EVENTS.breached, table: 'task_sla', description: 'A task SLA breached (100 %)' },
  ],
  rules: slaRules,
  jobs: [
    ...SLA_UPDATE_JOBS.map((j) => ({
      id: j.id,
      name: j.name,
      intervalMs: j.intervalMs,
      run: (ctx: Context) => {
        slaEngine(ctx.platform)?.runUpdateJob(ctx, j);
      },
    })),
    {
      id: 'sla.timers',
      name: 'SLA percentage timers',
      intervalMs: 30_000,
      run(ctx) {
        slaEngine(ctx.platform)?.fireDueTimers(ctx, clock.now().getTime());
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'sla',
        title: 'Service Level Management',
        icon: 'timer',
        roles: ['itil', 'sla_manager'],
        order: 60,
        modules: [
          { title: 'SLA Definitions', table: 'contract_sla', query: 'ORDERBYname', roles: ['sla_manager'] },
          { title: 'Active Task SLAs', table: 'task_sla', query: 'active=true^ORDERBYplanned_end_time' },
          { title: 'Breached', table: 'task_sla', query: 'has_breached=true^ORDERBYDESCplanned_end_time' },
          { title: 'Paused', table: 'task_sla', query: 'stage=paused^active=true' },
          { title: 'All Task SLAs', table: 'task_sla', query: 'ORDERBYDESCsys_created_on' },
          {
            title: 'Schedules',
            table: 'cmn_schedule',
            query: 'ORDERBYname',
            roles: ['sla_manager'],
            separator: true,
          },
          { title: 'Relative Durations', table: 'cmn_relative_duration', roles: ['sla_manager'] },
          { title: 'Condition Rules', table: 'sla_condition_class', roles: ['sla_admin'] },
          {
            title: 'Repair Logs',
            table: 'sla_repair_log',
            query: 'ORDERBYDESCstarted',
            roles: ['sla_manager'],
          },
          {
            title: 'Percentage Timers',
            table: 'resolvr_sla_timer',
            query: 'state=pending^ORDERBYfire_at',
            roles: ['sla_admin'],
          },
        ],
      },
    ],
    lists: [
      {
        table: 'contract_sla',
        columns: ['name', 'type', 'target', 'collection', 'duration', 'schedule', 'active'],
      },
      { table: 'task_sla', columns: ['task', ...TASK_SLA_COLUMNS] },
      { table: 'resolvr_sla_timer', columns: ['task_sla', 'threshold', 'fire_at', 'state'] },
      { table: 'sla_repair_log', columns: ['started', 'finished', 'initiated_by', 'state'] },
      { table: 'sla_repair_log_entry', columns: ['type', 'task', 'sla', 'task_sla_id'] },
    ],
    forms: [
      {
        table: 'contract_sla',
        sections: [
          {
            left: ['name', 'type', 'target', 'collection', 'active'],
            right: [
              'duration_type',
              'duration',
              'relative_duration_works_on',
              'schedule_source',
              'schedule',
              'schedule_source_field',
              'timezone_source',
              'timezone',
            ],
          },
          {
            caption: 'Start condition',
            fields: [
              'start_condition',
              'retroactive',
              'set_start_to',
              'retroactive_pause',
              'when_to_cancel',
              'cancel_condition',
            ],
          },
          { caption: 'Pause condition', fields: ['pause_condition', 'when_to_resume', 'resume_condition'] },
          { caption: 'Stop condition', fields: ['stop_condition'] },
          { caption: 'Reset condition', fields: ['reset_condition', 'reset_action'] },
          {
            caption: 'Advanced',
            left: ['condition_class', 'flow', 'workflow'],
            right: ['vendor', 'enable_logging'],
          },
        ],
        relatedLists: [
          {
            table: 'task_sla',
            field: 'sla',
            label: 'Task SLAs',
            columns: ['task', 'stage', 'has_breached', 'business_percentage', 'planned_end_time'],
          },
        ],
      },
      {
        table: 'task_sla',
        highlights: ['stage', 'has_breached', 'business_percentage', 'planned_end_time'],
        sections: [
          {
            left: ['task', 'sla', 'stage', 'active', 'has_breached', 'schedule', 'timezone'],
            right: ['start_time', 'planned_end_time', 'original_breach_time', 'pause_time', 'end_time'],
          },
          {
            caption: 'Actual time',
            left: ['duration', 'percentage', 'time_left'],
            right: ['pause_duration'],
          },
          {
            caption: 'Business time',
            left: ['business_duration', 'business_percentage', 'business_time_left'],
            right: ['business_pause_duration'],
          },
        ],
        relatedLists: [
          {
            table: 'resolvr_sla_timer',
            field: 'task_sla',
            label: 'Percentage Timers',
            columns: ['threshold', 'fire_at', 'state'],
          },
        ],
      },
      {
        table: 'resolvr_sla_timer',
        sections: [{ left: ['task_sla', 'threshold'], right: ['fire_at', 'state'] }],
      },
      {
        table: 'sla_repair_log',
        sections: [
          { left: ['initiated_by', 'state'], right: ['started', 'finished'] },
          { fields: ['request'] },
        ],
        relatedLists: [
          {
            table: 'sla_repair_log_entry',
            field: 'repair_log',
            label: 'Entries',
            columns: ['type', 'task', 'sla', 'task_sla_id'],
          },
        ],
      },
      {
        table: 'sla_repair_log_entry',
        sections: [
          { left: ['repair_log', 'type', 'task'], right: ['sla', 'task_sla_id'] },
          { fields: ['values'] },
        ],
      },
      { table: 'sla_condition_class', sections: [{ left: ['name'], right: ['active'] }] },
    ],
    uiActions: [
      {
        id: 'sla.repair',
        table: 'task',
        label: 'Repair SLAs',
        roles: ['admin', 'sla_admin'],
        order: 900,
        confirm: 'Rebuild the SLAs of this record from its history?',
        condition: (_rec, ctx) => !!slaEngine(ctx.platform)?.repairEnabled(),
        run(rec, ctx) {
          const engine = slaEngine(ctx.platform);
          if (!engine) return { error: 'SLA engine not available' };
          engine.repair(ctx, [rec.sysId]);
          const n = ctx.elevated().count('task_sla', `task=${rec.sysId}`);
          return { message: `SLAs repaired: ${n} task SLA${n === 1 ? '' : 's'}` };
        },
      },
      {
        id: 'sla.recalculate',
        table: 'task_sla',
        label: 'Recalculate',
        roles: ['itil', 'sla_manager'],
        condition: 'active=true',
        run(rec, ctx) {
          slaEngine(ctx.platform)?.refreshTask(ctx, rec.str('task'));
          return { message: 'Task SLA recalculated' };
        },
      },
    ],
    uiPolicies: [
      {
        id: 'sla.def.schedule',
        table: 'contract_sla',
        name: 'Schedule from the definition',
        condition: 'schedule_source=sla_definition',
        reverseIfFalse: true,
        actions: [{ field: 'schedule', visible: true }],
      },
      {
        id: 'sla.def.schedule_field',
        table: 'contract_sla',
        name: 'Schedule from a task field',
        condition: 'schedule_source=task_field',
        reverseIfFalse: true,
        actions: [{ field: 'schedule_source_field', visible: true, mandatory: true }],
      },
      {
        id: 'sla.def.timezone',
        table: 'contract_sla',
        name: 'Definition time zone',
        condition: 'timezone_source=sla.timezone',
        reverseIfFalse: true,
        actions: [{ field: 'timezone', visible: true, mandatory: true }],
      },
      {
        id: 'sla.def.duration',
        table: 'contract_sla',
        name: 'User specified duration',
        condition: 'duration_typeISEMPTY',
        reverseIfFalse: true,
        actions: [{ field: 'duration', visible: true, mandatory: true }],
      },
      {
        id: 'sla.def.retroactive',
        table: 'contract_sla',
        name: 'Retroactive start',
        condition: 'retroactive=true',
        reverseIfFalse: true,
        actions: [
          { field: 'set_start_to', visible: true, mandatory: true },
          { field: 'retroactive_pause', visible: true },
        ],
      },
      {
        id: 'sla.def.cancel',
        table: 'contract_sla',
        name: 'Cancel condition',
        condition: 'when_to_cancel=on_condition',
        reverseIfFalse: true,
        actions: [{ field: 'cancel_condition', visible: true }],
      },
      {
        id: 'sla.def.resume',
        table: 'contract_sla',
        name: 'Resume condition',
        condition: 'when_to_resume=on_condition',
        reverseIfFalse: true,
        actions: [{ field: 'resume_condition', visible: true }],
      },
    ],
  },
  register(platform) {
    const engine = new SlaEngine(platform);
    platform.services.set(SERVICES.sla, engine);
    platform.hooks.on(['insert', 'update'], 'task', 'sla', (rec, prev, ctx) =>
      engine.onTaskWrite(rec, prev, ctx),
    );
  },
  afterBoot(platform) {
    // Show task SLAs on every task form (copies, so other modules' layouts are not mutated).
    const related: RelatedListDef = {
      table: 'task_sla',
      field: 'task',
      label: 'Task SLAs',
      columns: TASK_SLA_COLUMNS,
    };
    for (const [key, form] of platform.forms) {
      if (!platform.registry.tryTable(form.table)?.ancestors.includes('task')) continue;
      if (form.relatedLists?.some((r) => r.table === 'task_sla')) continue;
      platform.forms.set(key, { ...form, relatedLists: [...(form.relatedLists ?? []), related] });
    }
  },
  seedVersion: 1,
  seed(ctx) {
    seedSla(ctx);
  },
  http(app, deps) {
    registerSlaApi(app as FastifyInstance, deps as ApiDeps);
  },
};
