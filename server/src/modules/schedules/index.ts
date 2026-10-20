import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { AppModule } from '../../engine/module.js';
import { SERVICES } from '../contracts.js';
import { registerSchedulesApi } from './api.js';
import { ScheduleEngine } from './engine.js';
import { schedulesRules } from './rules.js';
import { demoSchedules, seedSchedules } from './seed.js';
import { schedulesTables } from './tables.js';

export { ScheduleEngine, scheduleEngine } from './engine.js';

const TABLES = ['cmn_schedule', 'cmn_schedule_span', 'cmn_other_schedule', 'cmn_relative_duration'];

/** Business schedules, holidays and business-time calculations. */
export const schedulesModule: AppModule = {
  id: 'schedules',
  name: 'Schedules',
  description: 'Business schedules, holidays and business-time calculations.',
  dependsOn: ['platform'],
  tables: schedulesTables,
  roles: [
    { name: 'schedule_admin', description: 'Maintains business schedules, holidays and relative durations' },
  ],
  acls: [
    ...TABLES.map((name) => ({ name, operation: 'read' as const, roles: ['snc_internal'] })),
    ...TABLES.flatMap((name) =>
      (['write', 'create', 'delete'] as const).map((operation) => ({
        name,
        operation,
        roles: ['schedule_admin'],
      })),
    ),
  ],
  properties: [
    {
      name: 'glide.schedules.repeat_nth',
      value: 'day',
      type: 'choicelist',
      choices: 'day,week',
      description: 'Monthly "nth weekday" entries repeat on the same weekday index (day) or week row (week)',
    },
    {
      name: 'glide.schedules.fifth',
      value: 'last',
      type: 'choicelist',
      choices: 'last,next,strict',
      description:
        'When a month has no fifth weekday: use the last one, the first of the next month, or skip',
    },
  ],
  rules: schedulesRules,
  ui: {
    navigation: [
      {
        id: 'schedules',
        title: 'Schedules',
        icon: 'calendar-clock',
        roles: ['schedule_admin', 'itil'],
        order: 880,
        modules: [
          { title: 'Schedules', table: 'cmn_schedule', query: 'ORDERBYname' },
          { title: 'Schedule Entries', table: 'cmn_schedule_span' },
          { title: 'Holiday Schedules', table: 'cmn_schedule', query: 'type=excluded^ORDERBYname' },
          { title: 'Relative Durations', table: 'cmn_relative_duration', roles: ['schedule_admin'] },
        ],
      },
    ],
    lists: [
      {
        table: 'cmn_schedule',
        columns: ['name', 'type', 'time_zone', 'parent', 'description', 'sys_updated_on'],
      },
      {
        table: 'cmn_schedule_span',
        columns: ['name', 'schedule', 'type', 'start_date_time', 'end_date_time', 'all_day', 'repeat_type'],
      },
      { table: 'cmn_other_schedule', columns: ['schedule', 'child_schedule', 'type'] },
      {
        table: 'cmn_relative_duration',
        columns: ['name', 'duration_amount', 'duration_unit', 'active', 'description'],
      },
    ],
    forms: [
      {
        table: 'cmn_schedule',
        sections: [
          { left: ['name', 'type', 'time_zone'], right: ['parent', 'read_only'] },
          { fields: ['description'] },
        ],
        relatedLists: [
          {
            table: 'cmn_schedule_span',
            field: 'schedule',
            label: 'Schedule Entries',
            columns: ['name', 'type', 'start_date_time', 'end_date_time', 'all_day', 'repeat_type'],
          },
          {
            table: 'cmn_other_schedule',
            field: 'schedule',
            label: 'Child Schedules',
            columns: ['child_schedule', 'type'],
          },
        ],
      },
      {
        table: 'cmn_schedule_span',
        sections: [
          {
            left: ['name', 'schedule', 'type', 'show_as'],
            right: ['start_date_time', 'end_date_time', 'all_day'],
          },
          {
            caption: 'Repeat',
            left: ['repeat_type', 'repeat_count', 'days_of_week', 'repeat_until'],
            right: ['monthly_type', 'yearly_type', 'month', 'float_week', 'float_day'],
          },
          { fields: ['notes'] },
        ],
      },
      { table: 'cmn_other_schedule', sections: [{ left: ['schedule', 'child_schedule'], right: ['type'] }] },
      {
        table: 'cmn_relative_duration',
        sections: [
          { left: ['name', 'active'], right: ['duration_amount', 'duration_unit'] },
          { fields: ['description'] },
        ],
      },
    ],
    uiPolicies: [
      {
        id: 'schedules.span.weekly',
        table: 'cmn_schedule_span',
        name: 'Days of week only for weekly entries',
        condition: 'repeat_type=weekly',
        reverseIfFalse: true,
        actions: [{ field: 'days_of_week', visible: true }],
      },
      {
        id: 'schedules.span.monthly',
        table: 'cmn_schedule_span',
        name: 'Monthly options',
        condition: 'repeat_type=monthly',
        reverseIfFalse: true,
        actions: [{ field: 'monthly_type', visible: true }],
      },
      {
        id: 'schedules.span.yearly',
        table: 'cmn_schedule_span',
        name: 'Yearly options',
        condition: 'repeat_type=yearly',
        reverseIfFalse: true,
        actions: [
          { field: 'yearly_type', visible: true },
          { field: 'month', visible: true },
          { field: 'float_week', visible: true },
          { field: 'float_day', visible: true },
        ],
      },
    ],
  },
  register(platform) {
    const engine = new ScheduleEngine(platform);
    platform.services.set(SERVICES.schedules, engine);
    const changed = () => engine.invalidate();
    for (const t of ['cmn_schedule', 'cmn_schedule_span', 'cmn_other_schedule'])
      platform.hooks.on(['insert', 'update', 'delete'], t, 'schedules-cache', changed);
  },
  seedVersion: 1,
  seed(ctx) {
    seedSchedules(ctx);
  },
  demo(ctx) {
    demoSchedules(ctx);
  },
  http(app, deps) {
    registerSchedulesApi(app as FastifyInstance, deps as ApiDeps);
  },
};
