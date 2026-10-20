import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { AppModule, RelatedListDef } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { AclDef } from '../../engine/services/acl.js';
import { clock } from '../../engine/util.js';
import { SERVICES } from '../contracts.js';
import { scheduleEngine } from '../schedules/engine.js';
import { registerOncallApi } from './api.js';
import { seedOncallDemo } from './demo.js';
import { EscalationEngine, ONCALL_EVENTS } from './escalation.js';
import { approveTimeOff, groupOfRecord, managesGroup, oncallRules } from './rules.js';
import { ONCALL_PROPS, OnCallService } from './service.js';
import { oncallTables } from './tables.js';

export { EscalationEngine } from './escalation.js';
export { OnCallService, onCallService } from './service.js';

const CONFIG_TABLES = [
  'cmn_rota',
  'cmn_rota_roster',
  'cmn_rota_member',
  'cmn_rota_escalation_set',
  'cmn_rota_esc_step_def',
  'on_call_group_preference',
];
const LOG_TABLES = [
  'on_call_escalation',
  'on_call_escalation_level',
  'on_call_escalation_con_attempt',
  'on_call_escalation_comm',
];
const READERS = ['itil', 'oc_read'];
const WRITE_OPS = ['write', 'create', 'delete'] as const;

export function escalationEngine(platform: Platform): EscalationEngine | undefined {
  return platform.services.get('oncall.escalations') as EscalationEngine | undefined;
}

const managedRecord = (rec: Rec | null, ctx: Context) => !rec || managesGroup(ctx, groupOfRecord(ctx, rec));

/** Rota managers maintain the entries of their own shifts' schedules. */
const managedShiftSchedule = (rec: Rec | null, ctx: Context) => {
  if (!rec) return true;
  const scheduleId = rec.table.name === 'cmn_schedule' ? rec.sysId : rec.str('schedule');
  const rota = scheduleId ? ctx.elevated().first('cmn_rota', `schedule=${scheduleId}`) : null;
  return !!rota && managesGroup(ctx, rota.str('group'));
};

const oncallAcls: AclDef[] = [
  ...[...CONFIG_TABLES, 'roster_schedule_span', ...LOG_TABLES].map((name) => ({
    name,
    operation: 'read' as const,
    roles: READERS,
  })),
  ...[...CONFIG_TABLES, 'roster_schedule_span'].flatMap((name) =>
    WRITE_OPS.map((operation) => ({ name, operation, roles: ['rota_manager'], script: managedRecord })),
  ),
  {
    name: 'roster_schedule_span',
    operation: 'create',
    roles: ['itil'],
    condition: 'type=time_off^user=javascript:gs.getUserID()',
    description: 'Members request their own time off',
  },
  {
    name: 'roster_schedule_span',
    operation: 'write',
    roles: ['itil'],
    condition: 'type=time_off^user=javascript:gs.getUserID()^state=requested',
  },
  ...LOG_TABLES.flatMap((name) => WRITE_OPS.map((operation) => ({ name, operation, roles: ['admin'] }))),
  ...(['cmn_schedule', 'cmn_schedule_span'] as const).flatMap((name) =>
    WRITE_OPS.map((operation) => ({
      name,
      operation,
      roles: ['rota_manager'],
      script: managedShiftSchedule,
    })),
  ),
];

function respondAction(response: 'accepted' | 'rejected') {
  return (rec: Rec, ctx: Context) => {
    const engine = escalationEngine(ctx.platform);
    const escalation =
      rec.table.name === 'on_call_escalation'
        ? rec
        : ctx.elevated().first('on_call_escalation', `source=${rec.sysId}^active=true`);
    if (!engine || !escalation || !ctx.user.sysId) return { error: 'No active on-call escalation' };
    const r = engine.respond(ctx, escalation, ctx.user.sysId, response);
    return r.ok ? { message: r.message } : { error: r.message };
  };
}

/** Whether the current user was paged by an active level of the escalation (or of the task's escalation). */
function pagedNow(rec: Rec, ctx: Context): boolean {
  const escalation =
    rec.table.name === 'on_call_escalation'
      ? rec
      : ctx.elevated().first('on_call_escalation', `source=${rec.sysId}^active=true`);
  if (!escalation?.bool('active') || !ctx.user.sysId) return false;
  return ctx
    .elevated()
    .query('on_call_escalation_level', { query: `escalation=${escalation.sysId}^active=true` })
    .some((l) => l.str('escalatees').split(',').includes(ctx.user.sysId!));
}

/** Rotas, rosters, escalation policies and who-is-on-call. */
export const oncallModule: AppModule = {
  id: 'oncall',
  name: 'On-Call Scheduling',
  description: 'Rotas, rosters, escalation policies and who-is-on-call.',
  dependsOn: ['task', 'schedules'],
  tables: oncallTables,
  roles: [
    { name: 'oc_read', description: 'Read-only access to on-call calendars and escalations' },
    {
      name: 'rota_manager',
      description: 'Manages the on-call shifts of the groups they manage',
      contains: ['oc_read'],
    },
    {
      name: 'rota_admin',
      description: 'Administers every on-call shift, roster and escalation policy',
      contains: ['rota_manager', 'schedule_admin'],
    },
  ],
  acls: oncallAcls,
  properties: [
    {
      name: ONCALL_PROPS.logEscalations,
      value: 'true',
      type: 'boolean',
      description: 'Write on-call escalation contact attempts and notifications',
    },
    {
      name: ONCALL_PROPS.allowOverlap,
      value: 'false',
      type: 'boolean',
      description: 'Allow overlapping published shifts in a group',
    },
    {
      name: ONCALL_PROPS.overlapRule,
      value: 'all',
      type: 'choicelist',
      choices: 'outgoing,incoming,all',
      description: 'Shifts that escalate when several are active at once',
    },
    {
      name: ONCALL_PROPS.pto,
      value: 'with_approval',
      type: 'choicelist',
      choices: 'with_approval,without_approval,not_allowed',
      description: 'Time off policy for group members',
    },
    {
      name: ONCALL_PROPS.dailyAtMidnight,
      value: 'false',
      type: 'boolean',
      description: 'Daily rotations hand over at midnight instead of the roster start time',
    },
    {
      name: ONCALL_PROPS.readRoles,
      value: 'itil,rota_manager,rota_admin,oc_read',
      description: 'Roles that may read on-call calendars',
    },
    {
      name: ONCALL_PROPS.autoEscalate,
      value: 'true',
      type: 'boolean',
      description: 'Page the on-call people when an urgent unassigned task reaches a group',
    },
    {
      name: ONCALL_PROPS.maxPriority,
      value: '2',
      type: 'integer',
      description: 'Tasks with this priority or more urgent (lower number) trigger an on-call escalation',
    },
    {
      name: ONCALL_PROPS.requireUnassigned,
      value: 'true',
      type: 'boolean',
      description: 'Only escalate tasks that have no assignee',
    },
  ],
  events: [
    {
      name: ONCALL_EVENTS.escalation,
      table: 'task',
      description: 'An on-call person is paged (parm1 = user, parm2 = escalation level)',
    },
    {
      name: ONCALL_EVENTS.started,
      table: 'on_call_escalation',
      description: 'An on-call escalation started',
    },
    {
      name: ONCALL_EVENTS.acknowledged,
      table: 'on_call_escalation',
      description: 'An on-call escalation was acknowledged (parm1 = user)',
    },
    {
      name: ONCALL_EVENTS.ended,
      table: 'on_call_escalation',
      description: 'An on-call escalation ended (parm2 = reason)',
    },
    {
      name: ONCALL_EVENTS.deliveryFailed,
      table: 'on_call_escalation',
      description: 'An on-call notification could not be delivered',
    },
    {
      name: ONCALL_EVENTS.timeoffRequested,
      table: 'roster_schedule_span',
      description: 'Time off was requested',
    },
    {
      name: ONCALL_EVENTS.timeoffApproved,
      table: 'roster_schedule_span',
      description: 'Time off was approved',
    },
    {
      name: ONCALL_EVENTS.timeoffRejected,
      table: 'roster_schedule_span',
      description: 'Time off was rejected',
    },
  ],
  rules: oncallRules,
  jobs: [
    {
      id: 'oncall.escalations',
      name: 'On-Call Escalation Timer',
      intervalMs: 30_000,
      run(ctx) {
        escalationEngine(ctx.platform)?.processDue(ctx, clock.now().getTime());
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'oncall',
        title: 'On-Call Scheduling',
        icon: 'phone-call',
        roles: ['itil', 'oc_read'],
        order: 70,
        modules: [
          { title: 'Shifts', table: 'cmn_rota', query: 'ORDERBYname' },
          { title: 'Rosters', table: 'cmn_rota_roster', query: 'ORDERBYrota' },
          { title: 'Members', table: 'cmn_rota_member', query: 'ORDERBYroster' },
          {
            title: 'Time Off',
            table: 'roster_schedule_span',
            query: 'type=time_off^ORDERBYDESCstart_date_time',
          },
          {
            title: 'Coverage',
            table: 'roster_schedule_span',
            query: 'type=on_call^userISNOTEMPTY^ORDERBYDESCstart_date_time',
          },
          {
            title: 'Active Escalations',
            table: 'on_call_escalation',
            query: 'active=true^ORDERBYDESCsys_created_on',
            separator: true,
          },
          { title: 'Escalation History', table: 'on_call_escalation', query: 'ORDERBYDESCsys_created_on' },
          { title: 'Escalation Policies', table: 'cmn_rota_escalation_set', roles: ['rota_manager'] },
          { title: 'Group Preferences', table: 'on_call_group_preference', roles: ['rota_manager'] },
        ],
      },
    ],
    lists: [
      {
        table: 'cmn_rota',
        columns: ['name', 'group', 'state', 'schedule', 'manager', 'catch_all', 'active'],
      },
      {
        table: 'cmn_rota_roster',
        columns: [
          'name',
          'rota',
          'order',
          'rotation_interval_type',
          'rotation_start_date',
          'attempts',
          'time_between_reminders',
        ],
      },
      { table: 'cmn_rota_member', columns: ['member', 'roster', 'order', 'from', 'to'] },
      {
        table: 'roster_schedule_span',
        columns: ['name', 'type', 'user', 'group', 'roster', 'start_date_time', 'end_date_time', 'state'],
      },
      {
        table: 'on_call_escalation',
        columns: [
          'source',
          'group',
          'active',
          'acknowledged',
          'acknowledged_by',
          'end_reason',
          'sys_created_on',
        ],
      },
      {
        table: 'on_call_escalation_level',
        columns: [
          'escalation',
          'rota',
          'level',
          'escalatees',
          'catch_all',
          'active',
          'started_at',
          'outcome',
        ],
      },
      {
        table: 'on_call_escalation_comm',
        columns: ['escalatee', 'comm_type', 'comm_value', 'status', 'response', 'sys_created_on'],
      },
      {
        table: 'cmn_rota_escalation_set',
        columns: ['name', 'cmn_rota', 'default', 'table', 'order', 'active'],
      },
      {
        table: 'cmn_rota_esc_step_def',
        columns: [
          'escalation_level',
          'name',
          'rosters',
          'users',
          'reminder_num',
          'time_between_reminders',
          'time_to_next_step',
        ],
      },
      {
        table: 'on_call_group_preference',
        columns: ['group', 'allow_rota_overlap', 'escalation_rule_rota_overlap', 'pto_approval'],
      },
    ],
    forms: [
      {
        table: 'cmn_rota',
        highlights: ['state', 'group', 'catch_all'],
        sections: [
          {
            left: ['name', 'group', 'schedule', 'manager', 'color'],
            right: ['state', 'active', 'use_custom_escalation', 'override_user_preference'],
          },
          { caption: 'Catch all', left: ['catch_all', 'catch_all_member'], right: ['catch_all_roster'] },
          {
            caption: 'Reminders',
            left: ['send_reminders', 'reminder_lead_time'],
            right: ['coverage_interval', 'coverage_lead'],
          },
        ],
        relatedLists: [
          {
            table: 'cmn_rota_roster',
            field: 'rota',
            label: 'Rosters',
            columns: [
              'name',
              'order',
              'rotation_interval_type',
              'rotation_start_date',
              'attempts',
              'time_between_reminders',
            ],
          },
          {
            table: 'cmn_rota_escalation_set',
            field: 'cmn_rota',
            label: 'Escalation Policies',
            columns: ['name', 'default', 'table', 'order', 'active'],
          },
        ],
      },
      {
        table: 'cmn_rota_roster',
        sections: [
          {
            left: ['name', 'rota', 'order', 'active'],
            right: ['attempts', 'time_between_reminders', 'time_before_escalation', 'force_channel'],
          },
          {
            caption: 'Rotation',
            left: [
              'rotation_interval_type',
              'rotation_interval_count',
              'rotation_day_of_week',
              'rotation_month_day_type',
              'rotation_day',
            ],
            right: ['rotation_start_date', 'rotation_start_time', 'rotation_all_day'],
          },
        ],
        relatedLists: [
          {
            table: 'cmn_rota_member',
            field: 'roster',
            label: 'Members',
            columns: ['member', 'order', 'from', 'to'],
          },
        ],
      },
      {
        table: 'cmn_rota_member',
        sections: [{ left: ['roster', 'member', 'order'], right: ['from', 'to'] }],
      },
      {
        table: 'roster_schedule_span',
        sections: [
          {
            left: ['name', 'type', 'user', 'group', 'roster', 'state'],
            right: ['schedule', 'start_date_time', 'end_date_time', 'all_day', 'proposed_cover'],
          },
          {
            caption: 'Repeat',
            left: ['repeat_type', 'repeat_count', 'days_of_week'],
            right: ['repeat_until'],
          },
          { fields: ['notes'] },
        ],
      },
      {
        table: 'on_call_escalation',
        highlights: ['active', 'acknowledged', 'end_reason'],
        sections: [
          {
            left: ['source', 'table', 'group', 'category', 'subflow'],
            right: [
              'active',
              'acknowledged',
              'acknowledged_by',
              'acknowledged_at',
              'time_to_acknowledge',
              'end_time',
              'end_reason',
              'next_action_at',
            ],
          },
        ],
        relatedLists: [
          {
            table: 'on_call_escalation_level',
            field: 'escalation',
            label: 'Levels',
            columns: [
              'rota',
              'level',
              'escalatees',
              'catch_all',
              'active',
              'started_at',
              'ends_at',
              'outcome',
            ],
          },
          {
            table: 'on_call_escalation_comm',
            field: 'escalation',
            label: 'Notifications',
            columns: ['escalatee', 'comm_type', 'comm_value', 'status', 'response', 'sys_created_on'],
          },
        ],
      },
      {
        table: 'cmn_rota_escalation_set',
        sections: [
          {
            left: ['name', 'cmn_rota', 'default', 'active', 'order'],
            right: ['table', 'override_user_preference'],
          },
          { fields: ['condition', 'description'] },
        ],
        relatedLists: [
          {
            table: 'cmn_rota_esc_step_def',
            field: 'cmn_rota_escalation_set',
            label: 'Steps',
            columns: [
              'escalation_level',
              'name',
              'rosters',
              'users',
              'groups',
              'reminder_num',
              'time_to_next_step',
            ],
          },
        ],
      },
      {
        table: 'cmn_rota_esc_step_def',
        sections: [
          {
            left: ['cmn_rota_escalation_set', 'escalation_level', 'name'],
            right: ['reminder_num', 'time_between_reminders', 'time_to_next_step'],
          },
          {
            caption: 'Audience',
            left: ['rosters', 'users', 'groups'],
            right: ['group_manager', 'group_manager_field', 'devices'],
          },
        ],
      },
      {
        table: 'on_call_group_preference',
        sections: [
          {
            left: ['group', 'shift_managers', 'first_day_of_week'],
            right: ['allow_rota_overlap', 'escalation_rule_rota_overlap', 'pto_approval'],
          },
        ],
      },
    ],
    uiActions: [
      {
        id: 'oncall.publish',
        table: 'cmn_rota',
        label: 'Publish',
        style: 'primary',
        roles: ['rota_manager'],
        condition: 'state=draft',
        run(rec, ctx) {
          ctx.update(rec, { state: 'published' });
          return { message: `Shift ${rec.str('name')} published` };
        },
      },
      {
        id: 'oncall.draft',
        table: 'cmn_rota',
        label: 'Set to draft',
        roles: ['rota_manager'],
        condition: 'state=published',
        run(rec, ctx) {
          ctx.update(rec, { state: 'draft' });
          return { message: `Shift ${rec.str('name')} is a draft again and no longer escalates` };
        },
      },
      {
        id: 'oncall.ack',
        table: 'on_call_escalation',
        label: 'Acknowledge',
        style: 'primary',
        condition: pagedNow,
        run: respondAction('accepted'),
      },
      {
        id: 'oncall.decline',
        table: 'on_call_escalation',
        label: 'Decline',
        condition: pagedNow,
        run: respondAction('rejected'),
      },
      {
        id: 'oncall.ack_task',
        table: 'task',
        label: 'Acknowledge on-call page',
        style: 'primary',
        order: 50,
        condition: pagedNow,
        run: respondAction('accepted'),
      },
      {
        id: 'oncall.timeoff.approve',
        table: 'roster_schedule_span',
        label: 'Approve time off',
        style: 'primary',
        roles: ['rota_manager'],
        condition: 'type=time_off^state=requested',
        run(rec, ctx) {
          if (!managesGroup(ctx, rec.str('group')))
            return { error: 'Only the managers of this group can approve its time off' };
          const covers = approveTimeOff(ctx, rec);
          return {
            message: covers
              ? `Time off approved; ${covers} coverage entr${covers === 1 ? 'y' : 'ies'} created`
              : 'Time off approved',
          };
        },
      },
      {
        id: 'oncall.timeoff.reject',
        table: 'roster_schedule_span',
        label: 'Reject time off',
        style: 'destructive',
        roles: ['rota_manager'],
        condition: 'type=time_off^state=requested',
        run(rec, ctx) {
          if (!managesGroup(ctx, rec.str('group')))
            return { error: 'Only the managers of this group can reject its time off' };
          ctx.elevated().update(rec, { state: 'rejected' });
          ctx.queueEvent(ONCALL_EVENTS.timeoffRejected, rec, rec.str('user'), rec.str('group'));
          return { message: 'Time off rejected' };
        },
      },
    ],
    uiPolicies: [
      {
        id: 'oncall.catch_all_member',
        table: 'cmn_rota',
        name: 'Catch-all individual',
        condition: 'catch_all=individual',
        reverseIfFalse: true,
        actions: [{ field: 'catch_all_member', visible: true, mandatory: true }],
      },
      {
        id: 'oncall.catch_all_roster',
        table: 'cmn_rota',
        name: 'Catch-all roster',
        condition: 'catch_all=all',
        reverseIfFalse: true,
        actions: [{ field: 'catch_all_roster', visible: true }],
      },
      {
        id: 'oncall.roster.weekly',
        table: 'cmn_rota_roster',
        name: 'Weekly rotation day',
        condition: 'rotation_interval_type=weekly',
        reverseIfFalse: true,
        actions: [{ field: 'rotation_day_of_week', visible: true }],
      },
      {
        id: 'oncall.roster.monthly',
        table: 'cmn_rota_roster',
        name: 'Monthly rotation day',
        condition: 'rotation_interval_type=monthly',
        reverseIfFalse: true,
        actions: [
          { field: 'rotation_month_day_type', visible: true },
          { field: 'rotation_day', visible: true },
        ],
      },
      {
        id: 'oncall.roster.start_time',
        table: 'cmn_rota_roster',
        name: 'Rotation start time',
        condition: 'rotation_all_day=false',
        reverseIfFalse: true,
        actions: [{ field: 'rotation_start_time', visible: true }],
      },
    ],
  },
  register(platform) {
    const service = new OnCallService(platform);
    const engine = new EscalationEngine(platform, service);
    platform.services.set(SERVICES.oncall, service);
    platform.services.set('oncall.escalations', engine);
    // Coverage, time off and extra time live in the shift schedule but are not shift time.
    scheduleEngine(platform)?.addSpanFilter(
      (span) => span.className !== 'roster_schedule_span' || (!span.str('user') && !span.str('group')),
    );
    platform.hooks.on(['insert', 'update'], 'task', 'oncall', (rec, prev, ctx) =>
      engine.onTaskWrite(rec, prev, ctx),
    );
  },
  afterBoot(platform) {
    const add = (match: (table: string) => boolean, related: RelatedListDef) => {
      for (const [key, form] of platform.forms) {
        if (!match(form.table) || form.relatedLists?.some((r) => r.table === related.table)) continue;
        platform.forms.set(key, { ...form, relatedLists: [...(form.relatedLists ?? []), related] });
      }
    };
    add((t) => t === 'sys_user_group', {
      table: 'cmn_rota',
      field: 'group',
      label: 'On-Call Shifts',
      columns: ['name', 'state', 'schedule', 'manager'],
    });
    add((t) => !!platform.registry.tryTable(t)?.ancestors.includes('task'), {
      table: 'on_call_escalation',
      field: 'source',
      label: 'On-Call Escalations',
      columns: ['group', 'active', 'acknowledged', 'acknowledged_by', 'end_reason', 'sys_created_on'],
    });
  },
  demo(ctx) {
    seedOncallDemo(ctx);
  },
  http(app, deps) {
    const d = deps as ApiDeps;
    const service = d.platform.service<OnCallService>(SERVICES.oncall);
    const engine = escalationEngine(d.platform);
    if (engine) registerOncallApi(app as FastifyInstance, d, service, engine);
  },
};
