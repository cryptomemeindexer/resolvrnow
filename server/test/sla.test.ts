import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AbortError } from '../src/engine/errors.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import type { NotificationService, OutboundEmail } from '../src/modules/contracts.js';
import { schedulesModule } from '../src/modules/schedules/index.js';
import { SLA_UPDATE_JOBS, slaEngine, slaModule } from '../src/modules/sla/index.js';
import { taskStates } from '../src/modules/task/index.js';
import { bootPlatform, makeUser } from './helpers.js';

const MIN = 60_000;
const H = 60 * MIN;

/** Minimal incident and CI tables so the tests do not depend on the incident or CMDB modules. */
const fixtures: AppModule = {
  id: 'sla_fixtures',
  name: 'SLA test fixtures',
  dependsOn: ['task', 'schedules'],
  tables: [
    {
      name: 'incident',
      label: 'Incident',
      extends: 'task',
      number: { prefix: 'INC', start: 10000 },
      columns: [{ name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user' }],
    },
    {
      name: 'cmdb_ci',
      label: 'Configuration Item',
      displayField: 'name',
      columns: [
        { name: 'name', label: 'Name', type: 'string' },
        { name: 'schedule', label: 'Schedule', type: 'reference', reference: 'cmn_schedule' },
        { name: 'supported_by', label: 'Supported by', type: 'reference', reference: 'sys_user' },
      ],
    },
  ],
  register(platform) {
    taskStates(platform).register('incident', { closed: ['7', '8'], resolved: ['6'] });
  },
};

let p: Platform;
let ctx: Context;

function boot(): void {
  p = bootPlatform([schedulesModule, slaModule, fixtures]);
  ctx = p.systemContext();
  for (const d of ctx.query('contract_sla')) ctx.delete(d);
}

afterEach(() => {
  p?.close();
  clock.reset();
});

const at = (t: string) => clock.freeze(t);

/** The spec's P1 fixture: 8 h, no schedule, pause on hold, stop on resolve. */
function defineP1(over: Record<string, unknown> = {}): Rec {
  return ctx.insert('contract_sla', {
    name: 'P1',
    collection: 'incident',
    duration: 8 * H,
    schedule_source: 'no_schedule',
    start_condition: 'priority=1^active=true',
    stop_condition: 'state=6',
    pause_condition: 'state=3',
    when_to_cancel: 'no_match',
    when_to_resume: 'no_match',
    reset_action: 'cancel',
    ...over,
  });
}

function incident(values: Record<string, unknown> = {}): Rec {
  return ctx.insert('incident', {
    short_description: 'Payroll portal down',
    state: '1',
    priority: 1,
    ...values,
  });
}

function update(inc: Rec, values: Record<string, unknown>): Rec {
  return ctx.update(ctx.get('incident', inc.sysId)!, values);
}

function taskSlas(inc: Rec): Rec[] {
  return ctx.query('task_sla', { query: `task=${inc.sysId}` });
}

function only(inc: Rec): Rec {
  const list = taskSlas(inc);
  expect(list).toHaveLength(1);
  return list[0];
}

/** Recalculates the task's open SLAs at the frozen time and reloads one. */
function calc(ts: Rec): Rec {
  slaEngine(p)!.refreshTask(ctx, ts.str('task'));
  return ctx.get('task_sla', ts.sysId)!;
}

function weekdays(
  name = 'W',
  extra: Record<string, unknown> = {},
  span: Record<string, unknown> = {},
): string {
  const s = ctx.insert('cmn_schedule', { name, ...extra });
  ctx.insert('cmn_schedule_span', {
    schedule: s.sysId,
    name: 'Weekdays',
    start_date_time: '20000103T080000',
    end_date_time: '20000103T170000',
    repeat_type: 'weekdays',
    ...span,
  });
  return s.sysId;
}

function events(name: string): Rec[] {
  return ctx.query('sysevent', {
    query: `name=${name}`,
    orderBy: [{ field: 'sys_created_on', desc: false }],
  });
}

function runJob(id: string): void {
  p.scheduler.runNow(id);
}

describe('module setup', () => {
  it('seeds the example incident definitions and condition rules', () => {
    p = bootPlatform([schedulesModule, slaModule, fixtures]);
    ctx = p.systemContext();
    const names = ctx.query('contract_sla', { query: 'ORDERBYname' }).map((d) => d.str('name'));
    expect(names).toEqual([
      'P1 resolution (4 hour)',
      'P1 response (15 minute)',
      'P2 resolution (8 hour)',
      'P3 resolution (3 business days)',
    ]);
    const p3 = ctx.first('contract_sla', 'name=P3 resolution (3 business days)')!;
    expect(p3.display('schedule')).toBe('8-5 weekdays excluding holidays');
    expect(p3.num('duration')).toBe(27 * H);
    expect(ctx.count('sla_condition_class')).toBe(2);
    expect(p.services.get('sla')).toBeDefined();
  });

  it('attaches the seeded P1 resolution and response SLAs to a P1 incident', () => {
    p = bootPlatform([schedulesModule, slaModule, fixtures]);
    ctx = p.systemContext();
    at('2025-03-03 09:00:00');
    const inc = incident();
    const list = taskSlas(inc).map((t) => [t.display('sla'), t.str('planned_end_time')]);
    expect(list).toEqual([
      ['P1 resolution (4 hour)', '2025-03-03 13:00:00'],
      ['P1 response (15 minute)', '2025-03-03 09:15:00'],
    ]);
  });

  it('adds the task SLA related list to task forms without mutating them', () => {
    boot();
    const form = p.forms.get('task:default')!;
    expect(form.relatedLists?.some((r) => r.table === 'task_sla')).toBe(true);
    const plain = bootPlatform();
    expect(plain.forms.get('task:default')!.relatedLists?.some((r) => r.table === 'task_sla') ?? false).toBe(
      false,
    );
    plain.close();
  });

  it('validates definitions', () => {
    boot();
    expect(() => defineP1({ duration: 0 })).toThrow(AbortError);
    expect(() => defineP1({ collection: 'sys_user' })).toThrow(AbortError);
    expect(() => defineP1({ retroactive: true, set_start_to: '' })).toThrow(AbortError);
    expect(() =>
      defineP1({ schedule_source: 'task_field', schedule_source_field: 'short_description' }),
    ).toThrow(AbortError);
    expect(() =>
      defineP1({ schedule_source: 'task_field', schedule_source_field: 'cmdb_ci.schedule' }),
    ).not.toThrow();
  });
});

describe('lifecycle (2011 engine)', () => {
  it('1-3: attaches on insert and calculates elapsed time', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const inc = incident();
    let ts = only(inc);
    expect(ts.str('stage')).toBe('in_progress');
    expect(ts.bool('active')).toBe(true);
    expect(ts.str('start_time')).toBe('2025-03-03 09:00:00');
    expect(ts.str('planned_end_time')).toBe('2025-03-03 17:00:00');
    expect(ts.str('original_breach_time')).toBe('2025-03-03 17:00:00');
    expect(ts.bool('has_breached')).toBe(false);
    expect(ts.str('timezone')).toBe('UTC');
    expect(incident({ state: '6' }) && ctx.count('task_sla')).toBe(1);
    at('2025-03-03 13:00:00');
    ts = calc(ts);
    expect(ts.num('duration')).toBe(4 * H);
    expect(ts.num('percentage')).toBe(50);
    expect(ts.num('time_left')).toBe(4 * H);
    expect(ts.num('business_duration')).toBe(4 * H);
    expect(ts.num('business_percentage')).toBe(50);
    expect(ts.num('business_time_left')).toBe(4 * H);
  });

  it('4: business fields stay empty without a schedule when always_populate is off', () => {
    boot();
    p.properties.set('com.snc.sla.always_populate_business_fields', 'false');
    defineP1();
    at('2025-03-03 09:00:00');
    const inc = incident();
    at('2025-03-03 13:00:00');
    const ts = calc(only(inc));
    expect(ts.num('duration')).toBe(4 * H);
    expect(ts.get('business_duration')).toBeNull();
    expect(ts.get('business_percentage')).toBeNull();
    expect(ts.get('business_time_left')).toBeNull();
  });

  it('5-7: pause, resume and completion', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const inc = incident();
    at('2025-03-03 10:00:00');
    update(inc, { state: '3' });
    at('2025-03-03 11:00:00');
    let ts = calc(only(inc));
    expect(ts.str('stage')).toBe('paused');
    expect(ts.str('pause_time')).toBe('2025-03-03 10:00:00');
    expect(ts.num('duration')).toBe(H);
    expect(ts.num('pause_duration')).toBe(0);
    at('2025-03-03 12:00:00');
    update(inc, { state: '2' });
    ts = only(inc);
    expect(ts.str('stage')).toBe('in_progress');
    expect(ts.num('pause_duration')).toBe(2 * H);
    expect(ts.str('pause_time')).toBe('');
    expect(ts.str('planned_end_time')).toBe('2025-03-03 19:00:00');
    at('2025-03-03 18:00:00');
    update(inc, { state: '6' });
    ts = only(inc);
    expect(ts.str('stage')).toBe('completed');
    expect(ts.bool('active')).toBe(false);
    expect(ts.str('end_time')).toBe('2025-03-03 18:00:00');
    expect(ts.num('duration')).toBe(7 * H);
    expect(ts.num('percentage')).toBe(87.5);
    expect(ts.bool('has_breached')).toBe(false);
  });

  it('8-9: the update job detects the breach; completion keeps it', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const inc = incident();
    at('2025-03-03 16:55:00');
    runJob('sla.update.10min');
    expect(only(inc).bool('has_breached')).toBe(false);
    at('2025-03-03 17:00:00');
    runJob('sla.update.10min');
    let ts = only(inc);
    expect(ts.bool('has_breached')).toBe(true);
    expect(ts.str('stage')).toBe('in_progress');
    expect(ts.num('percentage')).toBe(100);
    expect(ts.num('time_left')).toBe(0);
    at('2025-03-03 18:00:00');
    update(inc, { state: '6' });
    ts = only(inc);
    expect(ts.str('stage')).toBe('completed');
    expect(ts.bool('has_breached')).toBe(true);
  });

  it('10: compatibility mode uses the breached and achieved stages', () => {
    boot();
    p.properties.set('com.snc.sla.compatibility.breach', 'true');
    defineP1();
    at('2025-03-03 09:00:00');
    const late = incident();
    const early = incident();
    at('2025-03-03 12:00:00');
    update(early, { state: '6' });
    expect(only(early).str('stage')).toBe('achieved');
    at('2025-03-03 17:00:00');
    runJob('sla.update.10min');
    expect(only(late).str('stage')).toBe('breached');
    expect(only(late).bool('active')).toBe(true);
    at('2025-03-03 18:00:00');
    update(late, { state: '6' });
    expect(only(late).str('stage')).toBe('breached');
    expect(only(late).bool('active')).toBe(false);
  });

  it('11: a priority change cancels P1 and starts P2', () => {
    boot();
    defineP1();
    defineP1({ name: 'P2', start_condition: 'priority=2^active=true' });
    at('2025-03-03 09:00:00');
    const inc = incident();
    at('2025-03-03 10:00:00');
    update(inc, { priority: 2 });
    const [p1, p2] = taskSlas(inc);
    expect(p1.display('sla')).toBe('P1');
    expect(p1.str('stage')).toBe('cancelled');
    expect(p1.str('end_time')).toBe('2025-03-03 10:00:00');
    expect(p2.display('sla')).toBe('P2');
    expect(p2.str('stage')).toBe('in_progress');
    expect(p2.str('start_time')).toBe('2025-03-03 10:00:00');
  });

  it('12-13: cancel policies never and on_condition', () => {
    boot();
    const def = defineP1({ when_to_cancel: 'never' });
    at('2025-03-03 09:00:00');
    const a = incident();
    update(a, { priority: 2 });
    expect(only(a).str('stage')).toBe('in_progress');

    ctx.update(def, {
      when_to_cancel: 'on_condition',
      cancel_condition: 'state=8',
      start_condition: 'priority=1',
    });
    const b = incident();
    update(b, { priority: 2 });
    expect(only(b).str('stage')).toBe('in_progress');
    update(b, { state: '8' });
    expect(only(b).str('stage')).toBe('cancelled');
    const c = incident({ state: '8' });
    expect(taskSlas(c)).toHaveLength(0);
  });

  it('14-15: reset conditions cancel or complete the running SLA and start a new one', () => {
    boot();
    const def = defineP1({ reset_condition: 'assignment_groupVALCHANGES' });
    const g1 = ctx.insert('sys_user_group', { name: 'Service Desk' });
    const g2 = ctx.insert('sys_user_group', { name: 'Network Operations' });
    at('2025-03-03 09:00:00');
    const inc = incident({ assignment_group: g1.sysId });
    expect(taskSlas(inc)).toHaveLength(1);
    at('2025-03-03 11:00:00');
    update(inc, { assignment_group: g2.sysId });
    const [old, fresh] = taskSlas(inc);
    expect(old.str('stage')).toBe('cancelled');
    expect(fresh.str('stage')).toBe('in_progress');
    expect(fresh.str('start_time')).toBe('2025-03-03 11:00:00');
    expect(fresh.str('planned_end_time')).toBe('2025-03-03 19:00:00');

    ctx.update(def, { reset_action: 'complete' });
    update(inc, { assignment_group: g1.sysId });
    expect(taskSlas(inc).map((t) => t.str('stage'))).toEqual(['cancelled', 'completed', 'in_progress']);
  });

  it('16: a pause condition implied by the start condition attaches paused', () => {
    boot();
    defineP1({ pause_condition: 'active=true' });
    at('2025-03-03 09:00:00');
    const ts = only(incident());
    expect(ts.str('stage')).toBe('paused');
    expect(ts.str('pause_time')).toBe('2025-03-03 09:00:00');
  });

  it('17: a pause state outside the start condition cancels', () => {
    boot();
    defineP1({ start_condition: 'stateIN1,2^priority=1' });
    at('2025-03-03 09:00:00');
    const inc = incident();
    update(inc, { state: '3' });
    expect(only(inc).str('stage')).toBe('cancelled');
  });

  it('18: resume on condition', () => {
    boot();
    defineP1({ when_to_resume: 'on_condition', resume_condition: 'state=2' });
    at('2025-03-03 09:00:00');
    const inc = incident();
    update(inc, { state: '3' });
    expect(only(inc).str('stage')).toBe('paused');
    update(inc, { state: '1' });
    expect(only(inc).str('stage')).toBe('paused');
    update(inc, { state: '2' });
    expect(only(inc).str('stage')).toBe('in_progress');
  });

  it('39-41: reopening attaches a new SLA; response and resolution run independently; empty start never attaches', () => {
    boot();
    defineP1();
    defineP1({
      name: 'P1 response',
      duration: 15 * MIN,
      stop_condition: 'assigned_toISNOTEMPTY',
      pause_condition: '',
    });
    defineP1({ name: 'Never', start_condition: '' });
    const agent = makeUser(p, 'abel.agent', ['itil']);
    at('2025-03-03 09:00:00');
    const inc = incident();
    expect(taskSlas(inc).map((t) => t.display('sla'))).toEqual(['P1', 'P1 response']);
    at('2025-03-03 09:20:00');
    update(inc, { assigned_to: agent });
    expect(taskSlas(inc).map((t) => `${t.display('sla')}:${t.str('stage')}`)).toEqual([
      'P1:in_progress',
      'P1 response:completed',
    ]);
    at('2025-03-03 10:00:00');
    update(inc, { state: '6' });
    at('2025-03-03 11:00:00');
    update(inc, { state: '2' });
    const p1 = taskSlas(inc).filter((t) => t.display('sla') === 'P1');
    expect(p1.map((t) => t.str('stage'))).toEqual(['completed', 'in_progress']);
    expect(p1[0].str('end_time')).toBe('2025-03-03 10:00:00');
    expect(p1[1].str('start_time')).toBe('2025-03-03 11:00:00');
  });
});

describe('business time', () => {
  it('19-20: elapsed business and actual time on 8-5 weekdays', () => {
    boot();
    const W = weekdays();
    defineP1({ schedule_source: 'sla_definition', schedule: W });
    at('2025-03-03 14:00:00');
    const a = incident();
    expect(only(a).str('planned_end_time')).toBe('2025-03-04 13:00:00');
    at('2025-03-04 09:00:00');
    let ts = calc(only(a));
    expect(ts.num('business_duration')).toBe(4 * H);
    expect(ts.num('business_percentage')).toBe(50);
    expect(ts.num('duration')).toBe(19 * H);
    expect(ts.num('percentage')).toBe(237.5);
    expect(ts.num('business_time_left')).toBe(4 * H);

    at('2025-03-07 21:00:00');
    const b = incident();
    at('2025-03-10 09:30:00');
    ts = calc(only(b));
    expect(ts.num('business_duration')).toBe(1.5 * H);
    expect(ts.num('business_percentage')).toBe(18.75);
    expect(ts.num('duration')).toBe(60.5 * H);
    expect(ts.num('percentage')).toBe(756.25);
  });

  it('21: a one-day duration is 24 h of schedule time', () => {
    boot();
    const W = weekdays();
    defineP1({ schedule_source: 'sla_definition', schedule: W, duration: 24 * H });
    at('2025-03-03 08:00:00');
    // 9 h Monday + 9 h Tuesday + 6 h Wednesday (the spec example assumes 8 h days and quotes 17:00).
    expect(only(incident()).str('planned_end_time')).toBe('2025-03-05 14:00:00');
  });

  it('22-23: pauses inside and outside the schedule', () => {
    boot();
    const W = weekdays();
    defineP1({ schedule_source: 'sla_definition', schedule: W });
    at('2025-03-03 09:00:00');
    const a = incident();
    const b = incident();
    at('2025-03-03 11:00:00');
    update(a, { state: '3' });
    at('2025-03-03 14:00:00');
    update(a, { state: '2' });
    let ts = only(a);
    expect(ts.num('pause_duration')).toBe(3 * H);
    expect(ts.num('business_pause_duration')).toBe(3 * H);
    expect(ts.str('planned_end_time')).toBe('2025-03-04 11:00:00');

    at('2025-03-03 16:00:00');
    update(b, { state: '3' });
    at('2025-03-04 09:00:00');
    update(b, { state: '2' });
    ts = only(b);
    expect(ts.num('pause_duration')).toBe(17 * H);
    expect(ts.num('business_pause_duration')).toBe(2 * H);
    expect(ts.str('planned_end_time')).toBe('2025-03-04 10:00:00');
    at('2025-03-04 09:30:00');
    ts = calc(ts);
    expect(ts.num('business_duration')).toBe(7.5 * H);
    expect(ts.num('business_percentage')).toBe(93.75);
    expect(ts.num('business_time_left')).toBe(0.5 * H);
  });

  it('27-29: time zones from the caller, the system and the definition', () => {
    boot();
    const W = weekdays();
    defineP1({ schedule_source: 'sla_definition', schedule: W, timezone_source: 'task.caller_id.time_zone' });
    const ny = ctx.insert('sys_user', {
      user_name: 'nina.york',
      first_name: 'Nina',
      last_name: 'York',
      time_zone: 'America/New_York',
    });
    const nozone = ctx.insert('sys_user', { user_name: 'zed.none', first_name: 'Zed', last_name: 'None' });
    at('2025-03-03 12:00:00');
    let ts = only(incident({ caller_id: ny.sysId }));
    expect(ts.str('timezone')).toBe('America/New_York');
    expect(ts.str('planned_end_time')).toBe('2025-03-03 21:00:00');
    ts = only(incident({ caller_id: nozone.sysId }));
    expect(ts.str('timezone')).toBe('UTC');
    expect(ts.str('planned_end_time')).toBe('2025-03-04 11:00:00');

    defineP1({
      name: 'P2 NY',
      start_condition: 'priority=2',
      duration: 4 * H,
      schedule_source: 'sla_definition',
      schedule: W,
      timezone_source: 'sla.timezone',
      timezone: 'America/New_York',
    });
    at('2025-03-07 21:00:00');
    ts = only(incident({ priority: 2 }));
    expect(ts.str('planned_end_time')).toBe('2025-03-10 15:00:00');
  });

  it('30: excluded days in a child schedule', () => {
    boot();
    const holidays = ctx.insert('cmn_schedule', { name: 'Holidays', type: 'excluded' });
    ctx.insert('cmn_schedule_span', {
      schedule: holidays.sysId,
      name: 'Closure',
      type: 'exclude',
      all_day: true,
      start_date_time: '20250304',
      end_date_time: '20250304',
    });
    const W = weekdays('W excluding holidays');
    ctx.insert('cmn_other_schedule', { schedule: W, child_schedule: holidays.sysId, type: 'include' });
    defineP1({ schedule_source: 'sla_definition', schedule: W });
    at('2025-03-03 16:00:00');
    expect(only(incident()).str('planned_end_time')).toBe('2025-03-05 15:00:00');
  });

  it('31: schedule taken from a task field', () => {
    boot();
    const W = weekdays();
    defineP1({ schedule_source: 'task_field', schedule_source_field: 'cmdb_ci.schedule' });
    const withSchedule = ctx.insert('cmdb_ci', { name: 'payroll-db01', schedule: W });
    const without = ctx.insert('cmdb_ci', { name: 'wiki01' });
    at('2025-03-03 14:00:00');
    let ts = only(incident({ cmdb_ci: withSchedule.sysId }));
    expect(ts.str('schedule')).toBe(W);
    expect(ts.str('planned_end_time')).toBe('2025-03-04 13:00:00');
    ts = only(incident({ cmdb_ci: without.sysId }));
    expect(ts.str('schedule')).toBe('');
    expect(ts.str('planned_end_time')).toBe('2025-03-03 22:00:00');
  });
});

describe('breach detection, retroactive start and relative durations', () => {
  it('24-26: retroactive start with and without retroactive pause', () => {
    boot();
    const def = defineP1({ retroactive: true, set_start_to: 'opened_at', retroactive_pause: false });
    at('2025-03-03 08:00:00');
    const a = incident({ priority: 3 });
    at('2025-03-03 11:00:00');
    update(a, { priority: 1 });
    let ts = only(a);
    expect(ts.str('start_time')).toBe('2025-03-03 08:00:00');
    expect(ts.str('planned_end_time')).toBe('2025-03-03 16:00:00');
    expect(ts.num('duration')).toBe(3 * H);

    ctx.update(def, { retroactive_pause: true });
    at('2025-03-03 08:00:00');
    const b = incident({ priority: 3 });
    at('2025-03-03 09:00:00');
    update(b, { state: '3' });
    at('2025-03-03 10:00:00');
    update(b, { state: '2' });
    at('2025-03-03 11:00:00');
    update(b, { priority: 1 });
    ts = only(b);
    expect(ts.num('pause_duration')).toBe(H);
    expect(ts.str('planned_end_time')).toBe('2025-03-03 17:00:00');
    expect(ts.num('duration')).toBe(2 * H);

    ctx.update(def, { retroactive_pause: false });
    at('2025-03-03 08:00:00');
    const c = incident({ priority: 3 });
    at('2025-03-03 17:30:00');
    update(c, { priority: 1 });
    ts = only(c);
    expect(ts.bool('has_breached')).toBe(true);
    expect(ctx.count('resolvr_sla_timer', `task_sla=${ts.sysId}`)).toBe(0);
    expect(events('sla.breached')).toHaveLength(0);

    p.properties.set('com.snc.sla.flow.run_for_breached', 'true');
    at('2025-03-03 08:00:00');
    const d = incident({ priority: 3 });
    at('2025-03-03 17:30:00');
    update(d, { priority: 1 });
    const names = ctx
      .query('sysevent', { query: `nameSTARTSWITHsla.^parm1=${d.sysId}` })
      .map((e) => e.str('name'));
    expect(names).toEqual(['sla.warning.50', 'sla.warning.75', 'sla.breached']);
  });

  it('32: rounded percentage versus time left', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const a = incident();
    clock.freeze(new Date(Date.UTC(2025, 2, 3, 9) + 28_799_600));
    let ts = calc(only(a));
    expect(ts.num('percentage')).toBe(100);
    expect(ts.bool('has_breached')).toBe(true);

    p.properties.set('com.snc.sla.calculation.use_time_left', 'true');
    at('2025-03-03 09:00:00');
    const b = incident();
    clock.freeze(new Date(Date.UTC(2025, 2, 3, 9) + 28_799_600));
    ts = calc(only(b));
    expect(ts.num('time_left')).toBe(400);
    expect(ts.bool('has_breached')).toBe(false);
    at('2025-03-03 17:00:00');
    expect(calc(ts).bool('has_breached')).toBe(true);
  });

  it('36: breach time after a breach', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const a = incident();
    at('2025-03-03 17:30:00');
    calc(only(a));
    update(a, { state: '3' });
    at('2025-03-03 18:30:00');
    update(a, { state: '2' });
    expect(only(a).str('planned_end_time')).toBe('2025-03-03 17:00:00');

    p.properties.set('com.snc.sla.calculate_planned_end_time_after_breach', 'true');
    at('2025-03-03 09:00:00');
    const b = incident();
    at('2025-03-03 17:30:00');
    calc(only(b));
    update(b, { state: '3' });
    at('2025-03-03 18:30:00');
    update(b, { state: '2' });
    expect(only(b).str('planned_end_time')).toBe('2025-03-03 18:00:00');
  });

  it('37: relative duration "Breach on Due Date"', () => {
    boot();
    const s = weekdays('8-4 weekdays', {}, { end_date_time: '20000103T160000' });
    const due = ctx.first('cmn_relative_duration', 'name=Breach on Due Date')!;
    defineP1({ duration_type: due.sysId, duration: null, schedule_source: 'sla_definition', schedule: s });
    at('2017-01-09 10:00:00');
    expect(only(incident({ due_date: '2017-01-11 20:30:00' })).str('planned_end_time')).toBe(
      '2017-01-12 08:00:00',
    );
    expect(only(incident()).str('planned_end_time')).toBe('2017-01-09 10:00:01');
    expect(only(incident({ due_date: '2017-01-01 10:00:00' })).str('planned_end_time')).toBe(
      '2017-01-09 10:00:01',
    );
  });

  it('38: relative "End of next business day" is never paused', () => {
    boot();
    const W = weekdays();
    const eob = ctx.first('cmn_relative_duration', 'name=End of next business day')!;
    defineP1({ duration_type: eob.sysId, duration: null, schedule_source: 'sla_definition', schedule: W });
    at('2025-03-07 10:00:00');
    const inc = incident();
    expect(only(inc).str('planned_end_time')).toBe('2025-03-10 17:00:00');
    update(inc, { state: '3' });
    expect(only(inc).str('stage')).toBe('in_progress');
    at('2025-03-10 08:30:00');
    const ts = calc(only(inc));
    expect(ts.num('business_duration')).toBe(7.5 * H);
    expect(ts.num('business_percentage')).toBe(46.88);
  });
});

describe('timers, events and notifications', () => {
  it('33: percentage timers fire at 50/75/100 % and follow pauses', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const a = incident();
    const timers = (inc: Rec) =>
      ctx
        .query('resolvr_sla_timer', {
          query: `task_sla=${only(inc).sysId}^state=pending`,
          orderBy: [{ field: 'threshold', desc: false }],
        })
        .map((t) => t.str('fire_at'));
    expect(timers(a)).toEqual(['2025-03-03 13:00:00', '2025-03-03 15:00:00', '2025-03-03 17:00:00']);
    at('2025-03-03 12:59:59');
    runJob('sla.timers');
    expect(events('sla.warning.50')).toHaveLength(0);
    at('2025-03-03 13:00:00');
    runJob('sla.timers');
    expect(events('sla.warning.50').map((e) => [e.str('parm1'), e.str('parm2'), e.str('table')])).toEqual([
      [a.sysId, '50', 'task_sla'],
    ]);
    at('2025-03-03 15:00:00');
    runJob('sla.timers');
    at('2025-03-03 17:00:00');
    runJob('sla.timers');
    expect(events('sla.warning.75')).toHaveLength(1);
    expect(events('sla.breached')).toHaveLength(1);
    expect(only(a).bool('has_breached')).toBe(true);

    at('2025-03-04 09:00:00');
    const b = incident();
    at('2025-03-04 12:00:00');
    update(b, { state: '3' });
    expect(timers(b)).toEqual([]);
    at('2025-03-04 13:00:00');
    update(b, { state: '2' });
    expect(timers(b)).toEqual(['2025-03-04 14:00:00', '2025-03-04 16:00:00', '2025-03-04 18:00:00']);
    at('2025-03-04 14:00:00');
    runJob('sla.timers');
    at('2025-03-04 15:30:00');
    update(b, { state: '6' });
    const states = ctx.query('resolvr_sla_timer', {
      query: `task_sla=${only(b).sysId}^state!=cancelled`,
      orderBy: [{ field: 'threshold', desc: false }],
    });
    expect(states.map((t) => `${t.num('threshold')}:${t.str('state')}`)).toEqual(['50:fired']);
    expect(
      ctx.count('resolvr_sla_timer', `task_sla=${only(b).sysId}^threshold=100^state=cancelled`),
    ).toBeGreaterThan(0);
  });

  it('34: notifications go to the assignee with the CI contact at 50 % and the manager afterwards', () => {
    boot();
    const sent: OutboundEmail[] = [];
    const mailer: NotificationService = {
      send: (_c, email) => {
        sent.push(email);
        return null;
      },
      render: (_c, t) => t,
    };
    p.services.set('notifications', mailer);
    defineP1();
    const manager = makeUser(p, 'mia.manager');
    const agent = makeUser(p, 'abel.agent', ['itil']);
    ctx.update(ctx.get('sys_user', agent)!, { manager });
    const support = makeUser(p, 'sam.support');
    const ci = ctx.insert('cmdb_ci', { name: 'payroll-app', supported_by: support });
    at('2025-03-03 09:00:00');
    incident({ assigned_to: agent, cmdb_ci: ci.sysId });
    for (const t of ['13:00:00', '15:00:00', '17:00:00']) {
      at(`2025-03-03 ${t}`);
      runJob('sla.timers');
    }
    expect(sent.map((e) => [e.notification, e.to])).toEqual([
      ['sla.warning.50', [agent, support]],
      ['sla.warning.75', [agent, manager]],
      ['sla.breached', [agent, manager]],
    ]);
    expect(sent[2].subject).toContain('breached');
  });

  it('35: update jobs pick task SLAs by breach-time window and percentage limit', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const rows = [incident(), incident(), incident(), incident()].map(only);
    const now = Date.UTC(2025, 2, 3, 9);
    const set = (ts: Rec, planned: number, pct: number) =>
      p.db.run(`UPDATE "task_sla" SET "planned_end_time" = ?, "percentage" = ? WHERE "sys_id" = ?`, [
        new Date(planned).toISOString().replace('T', ' ').slice(0, 19),
        pct,
        ts.sysId,
      ]);
    set(rows[0], now + 5 * MIN, 99);
    set(rows[1], now + 2 * 24 * H, 1);
    set(rows[2], now - 400 * 24 * H, 2000);
    set(rows[3], now - 24 * H, 1200);
    const engine = slaEngine(p)!;
    const picked = Object.fromEntries(
      SLA_UPDATE_JOBS.map((j) => [
        j.id,
        engine.selectRunning(ctx, j, now).map((ts) => rows.findIndex((r) => r.sysId === ts.sysId)),
      ]),
    );
    expect(picked).toEqual({
      'sla.update.10min': [0],
      'sla.update.1hour': [],
      'sla.update.1day': [],
      'sla.update.30days': [1],
      'sla.update.later': [],
      'sla.update.breached': [],
    });
    p.properties.set('com.snc.sla.calculation.percentage', '');
    expect(engine.selectRunning(ctx, SLA_UPDATE_JOBS[5], now)).toHaveLength(1);
    p.properties.set('com.snc.sla.calculation.percentage', '0');
    expect(engine.selectRunning(ctx, SLA_UPDATE_JOBS[0], now)).toHaveLength(0);
  });
});

describe('repair, legacy fields, async engine and field protection', () => {
  it('42: definition edits move the breach time; repair rebuilds from history', () => {
    boot();
    const def = defineP1();
    at('2025-03-03 09:00:00');
    const inc = incident();
    at('2025-03-03 10:00:00');
    update(inc, { state: '3' });
    at('2025-03-03 11:00:00');
    update(inc, { state: '2' });
    expect(only(inc).str('planned_end_time')).toBe('2025-03-03 18:00:00');
    ctx.update(def, { duration: 10 * H });
    at('2025-03-03 12:00:00');
    const before = calc(only(inc));
    expect(before.str('planned_end_time')).toBe('2025-03-03 20:00:00');

    const log = slaEngine(p)!.repair(ctx, [inc.sysId]);
    expect(log.str('state')).toBe('complete');
    const entries = ctx.query('sla_repair_log_entry', { query: `repair_log=${log.sysId}` });
    expect(entries.map((e) => e.str('type')).sort()).toEqual(['after', 'before']);
    const rebuilt = only(inc);
    expect(rebuilt.sysId).not.toBe(before.sysId);
    for (const f of [
      'stage',
      'start_time',
      'planned_end_time',
      'pause_duration',
      'duration',
      'percentage',
      'has_breached',
    ]) {
      expect(rebuilt.str(f), f).toBe(before.str(f));
    }
    expect(rebuilt.str('original_breach_time')).toBe('2025-03-03 19:00:00');
    expect(ctx.count('resolvr_sla_timer', `task_sla=${rebuilt.sysId}^state=pending`)).toBe(3);
  });

  it('43: legacy made_sla and sla_due are only maintained when enabled', () => {
    boot();
    defineP1();
    at('2025-03-03 09:00:00');
    const a = incident();
    at('2025-03-03 17:00:00');
    runJob('sla.update.10min');
    expect(ctx.get('incident', a.sysId)!.bool('made_sla')).toBe(true);

    p.properties.set('resolvr.sla.sync_legacy_task_fields', 'true');
    at('2025-03-04 09:00:00');
    const b = incident();
    expect(ctx.get('incident', b.sysId)!.str('sla_due')).toBe('2025-03-04 17:00:00');
    at('2025-03-04 17:00:00');
    runJob('sla.update.10min');
    const task = ctx.get('incident', b.sysId)!;
    expect(task.bool('made_sla')).toBe(false);
    expect(task.str('sla_due')).toBe('2025-03-04 17:00:00');
  });

  it('44: the async engine attaches after commit with the commit time', () => {
    boot();
    p.properties.set('com.snc.sla.engine.async', 'true');
    defineP1();
    at('2025-03-03 09:00:00');
    const inc = incident();
    expect(taskSlas(inc)).toHaveLength(0);
    clock.advance(5 * MIN);
    p.drain();
    expect(only(inc).str('start_time')).toBe('2025-03-03 09:00:00');
  });

  it('protects engine-owned fields from client writes and cascades task deletes', () => {
    boot();
    defineP1();
    makeUser(p, 'sla.boss', ['sla_admin']);
    makeUser(p, 'plain.writer', []);
    makeUser(p, 'abel.agent', ['itil']);
    at('2025-03-03 09:00:00');
    const inc = incident();
    const ts = only(inc);
    const boss = p.contextAs('sla.boss');
    boss.update(boss.get('task_sla', ts.sysId)!, { planned_end_time: '2030-01-01 00:00:00' });
    expect(only(inc).str('planned_end_time')).toBe('2030-01-01 00:00:00');
    const agent = p.contextAs('abel.agent').elevated();
    agent.update(agent.get('task_sla', ts.sysId)!, {
      planned_end_time: '2031-01-01 00:00:00',
      stage: 'completed',
    });
    expect(only(inc).str('planned_end_time')).toBe('2030-01-01 00:00:00');
    expect(only(inc).str('stage')).toBe('in_progress');
    const plain = p.contextAs('plain.writer');
    expect(() =>
      plain.update(plain.get('task_sla', ts.sysId)!, { planned_end_time: '2031-01-01 00:00:00' }),
    ).toThrow();
    ctx.delete(ctx.get('incident', inc.sysId)!);
    expect(ctx.count('task_sla')).toBe(0);
    expect(ctx.count('resolvr_sla_timer')).toBe(0);
  });
});

describe('REST', () => {
  it('repairs a record through /api/app/sla/repair/:table/:sysId', async () => {
    boot();
    defineP1();
    makeUser(p, 'abel.agent', ['itil']);
    makeUser(p, 'no.roles', []);
    at('2025-03-03 09:00:00');
    const inc = incident();
    const dir = mkdtempSync(join(tmpdir(), 'resolvrnow-sla-'));
    const config: ServerConfig = {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      dbFile: ':memory:',
      attachmentDir: join(dir, 'att'),
      publicUrl: 'https://resolvrnow.test',
      webDir: null,
      demo: false,
      secureCookies: false,
    };
    const app = await buildApp(p, config);
    const auth = (u: string) => ({
      authorization: `Basic ${Buffer.from(`${u}:Password1!`).toString('base64')}`,
    });
    try {
      const anon = await app.inject({ method: 'POST', url: `/api/app/sla/repair/incident/${inc.sysId}` });
      expect(anon.statusCode).toBe(401);
      const denied = await app.inject({
        method: 'POST',
        url: `/api/app/sla/repair/incident/${inc.sysId}`,
        headers: auth('no.roles'),
      });
      expect(denied.statusCode).toBe(403);
      const ok = await app.inject({
        method: 'POST',
        url: `/api/app/sla/repair/incident/${inc.sysId}`,
        headers: auth('abel.agent'),
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json().result;
      expect(body.state).toBe('complete');
      expect(body.task_slas).toHaveLength(1);
      expect(body.task_slas[0].planned_end_time).toEqual({
        display_value: '2025-03-03 17:00:00',
        value: '2025-03-03 17:00:00',
      });
      const summary = await app.inject({
        method: 'GET',
        url: `/api/app/sla/task/incident/${inc.sysId}`,
        headers: auth('abel.agent'),
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().result.preferred).toBe(body.task_slas[0].sys_id);
      const missing = await app.inject({
        method: 'POST',
        url: `/api/app/sla/repair/incident/${'0'.repeat(32)}`,
        headers: auth('abel.agent'),
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
