import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AbortError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock, parseGlideDateTime } from '../src/engine/util.js';
import {
  type EscalationEngine,
  escalationEngine,
  type OnCallService,
  oncallModule,
} from '../src/modules/oncall/index.js';
import { approveTimeOff } from '../src/modules/oncall/rules.js';
import type { RotaInfo } from '../src/modules/oncall/service.js';
import { schedulesModule } from '../src/modules/schedules/index.js';
import { bootPlatform, makeUser } from './helpers.js';

const MIN = 60_000;
const T = (s: string) => parseGlideDateTime(s)!.getTime();

let p: Platform;
let ctx: Context;
let svc: OnCallService;
let engine: EscalationEngine;
const users: Record<string, string> = {};

afterEach(() => {
  p?.close();
  clock.reset();
});

function boot(): void {
  p = bootPlatform([schedulesModule, oncallModule]);
  ctx = p.systemContext();
  svc = p.service<OnCallService>('oncall');
  engine = escalationEngine(p)!;
}

/** Network group (manager Mia) with Alice, Bob, Carol and Dave as members. */
function network(): Rec {
  users.mia = makeUser(p, 'mia', ['itil', 'rota_manager']);
  for (const n of ['alice', 'bob', 'carol', 'dave']) users[n] = makeUser(p, n, ['itil'], ['Network']);
  const group = ctx.first('sys_user_group', 'name=Network')!;
  ctx.update(group, { manager: users.mia });
  return group;
}

function rota(group: Rec, values: Record<string, unknown> = {}): Rec {
  return ctx.insert('cmn_rota', {
    name: 'Network on-call',
    group: group.sysId,
    state: 'published',
    ...values,
  });
}

function roster(
  r: Rec,
  members: [string, number, Record<string, unknown>?][],
  values: Record<string, unknown> = {},
): Rec {
  const rec = ctx.insert('cmn_rota_roster', {
    rota: r.sysId,
    name: 'Primary',
    rotation_interval_type: 'weekly',
    rotation_day_of_week: '1',
    rotation_start_date: '2026-01-05',
    rotation_all_day: false,
    rotation_start_time: '08:00:00',
    ...values,
  });
  for (const [name, order, extra] of members)
    ctx.insert('cmn_rota_member', { roster: rec.sysId, member: users[name], order, ...(extra ?? {}) });
  return rec;
}

/** Example A of the spec: weekly Monday 08:00 rotation of Alice, Bob and Carol from 2026-01-05. */
function exampleA(values: Record<string, unknown> = {}) {
  const group = network();
  const shift = rota(group, values);
  const primary = roster(shift, [
    ['alice', 100],
    ['bob', 200],
    ['carol', 300],
  ]);
  return { group, shift, primary };
}

const nameOf = (id: string | null) => Object.entries(users).find(([, v]) => v === id)?.[0] ?? null;

function info(shift: Rec): { s: ReturnType<OnCallService['snapshot']>; r: RotaInfo } {
  const s = svc.snapshot(ctx);
  return { s, r: s.rota(ctx.get('cmn_rota', shift.sysId)!) };
}

function primaryAt(shift: Rec, at: string, index = 0) {
  const { s, r } = info(shift);
  const e = svc.onCall(s, r, r.rosters[index], T(at));
  return { user: nameOf(e.user), source: e.source, gap: e.gap };
}

function planAt(shift: Rec, at: string, task: Rec | null = null): string[][] {
  const { s, r } = info(shift);
  return svc.plan(s, r, T(at), task).map((l) => l.users.map((u) => nameOf(u) ?? u));
}

function task(values: Record<string, unknown> = {}): Rec {
  return ctx.insert('task', { short_description: 'Core switch unreachable', priority: 1, ...values });
}

function escalationOf(t: Rec): Rec {
  return ctx.first('on_call_escalation', `source=${t.sysId}^ORDERBYDESCsys_created_on`)!;
}

function comms(esc: Rec): string[] {
  return ctx
    .query('on_call_escalation_comm', {
      query: `escalation=${esc.sysId}`,
      orderBy: [{ field: 'sys_created_on', desc: false }],
    })
    .map((c) => `${nameOf(c.str('escalatee'))}@${c.str('sys_created_on').slice(11, 16)}`);
}

function tick(at: string): void {
  clock.freeze(at);
  p.scheduler.runNow('oncall.escalations');
}

describe('rotation and who is on call', () => {
  it('1-3: weekly rotation holders, plan and the time before the first slot', () => {
    boot();
    const { shift } = exampleA();
    expect(primaryAt(shift, '2026-01-21 10:00:00')).toEqual({ user: 'carol', source: 'rotation', gap: null });
    expect(planAt(shift, '2026-01-21 10:00:00')).toEqual([['carol'], ['alice'], ['bob']]);
    expect(primaryAt(shift, '2026-01-26 07:59:59').user).toBe('carol');
    expect(primaryAt(shift, '2026-01-26 08:00:00').user).toBe('alice');
    expect(primaryAt(shift, '2026-01-05 07:59:59')).toEqual({ user: null, source: null, gap: 'no_member' });
    expect(planAt(shift, '2026-01-05 07:59:59')).toEqual([]);
    const sched = ctx.get('cmn_schedule', shift.str('schedule'))!;
    expect(sched.str('type')).toBe('roster');
  });

  it('4: daily rotation at the start time or at midnight', () => {
    boot();
    const group = network();
    const shift = rota(group);
    const daily = {
      rotation_interval_type: 'daily',
      rotation_interval_count: 2,
      rotation_start_date: '2026-03-01',
      rotation_start_time: '09:00:00',
    };
    const r = roster(
      shift,
      [
        ['alice', 100],
        ['bob', 200],
        ['carol', 300],
      ],
      daily,
    );
    expect(primaryAt(shift, '2026-03-05 05:00:00').user).toBe('bob');
    p.properties.set('com.snc.on_call_rotation.factor_daily_rotation_interval_all_day', 'true');
    expect(primaryAt(shift, '2026-03-05 05:00:00').user).toBe('carol');
    p.properties.set('com.snc.on_call_rotation.factor_daily_rotation_interval_all_day', 'false');
    ctx.update(r, { rotation_all_day: true });
    expect(primaryAt(shift, '2026-03-05 05:00:00').user).toBe('carol');
  });

  it('5: weekly rotation that starts mid-week', () => {
    boot();
    const shift = rota(network());
    roster(
      shift,
      [
        ['alice', 100],
        ['bob', 200],
        ['carol', 300],
      ],
      { rotation_start_date: '2026-01-07' },
    );
    expect(
      ['2026-01-10 12:00:00', '2026-01-13 12:00:00', '2026-01-20 12:00:00'].map(
        (t) => primaryAt(shift, t).user,
      ),
    ).toEqual(['alice', 'bob', 'carol']);
  });

  it('6: monthly rotation on the last day of the month', () => {
    boot();
    const shift = rota(network());
    roster(
      shift,
      [
        ['alice', 100],
        ['bob', 200],
      ],
      {
        rotation_interval_type: 'monthly',
        rotation_month_day_type: 'last_day',
        rotation_start_date: '2026-01-15',
        rotation_all_day: true,
      },
    );
    expect(
      ['2026-01-20 12:00:00', '2026-02-27 12:00:00', '2026-02-28 12:00:00', '2026-03-31 00:00:00'].map(
        (t) => primaryAt(shift, t).user,
      ),
    ).toEqual(['alice', 'bob', 'alice', 'bob']);
  });

  it('7: hand-overs keep their local time across DST', () => {
    boot();
    const schedule = ctx.insert('cmn_schedule', {
      name: 'NY 24x7',
      type: 'roster',
      time_zone: 'America/New_York',
    });
    ctx.insert('cmn_schedule_span', {
      schedule: schedule.sysId,
      name: 'All day',
      start_date_time: '20000101T000000',
      end_date_time: '20000102T000000',
      repeat_type: 'daily',
    });
    const shift = rota(network(), { schedule: schedule.sysId });
    roster(
      shift,
      [
        ['alice', 100],
        ['bob', 200],
      ],
      { rotation_start_date: '2026-03-02', rotation_start_time: '09:00:00' },
    );
    expect(primaryAt(shift, '2026-03-02 13:59:59').user).toBeNull();
    expect(primaryAt(shift, '2026-03-02 14:00:00').user).toBe('alice');
    expect(primaryAt(shift, '2026-03-09 12:59:00').user).toBe('alice');
    expect(primaryAt(shift, '2026-03-09 13:00:00').user).toBe('bob');
  });

  it('8-10: membership changes take effect at the next hand-over', () => {
    boot();
    const { shift, primary } = exampleA();
    const slot = (k: number) =>
      `2026-${k < 4 ? '01' : '02'}-${String([5, 12, 19, 26, 2, 9, 16][k]).padStart(2, '0')} 09:00:00`;
    ctx.insert('cmn_rota_member', {
      roster: primary.sysId,
      member: users.dave,
      order: 150,
      from: '2026-01-21',
    });
    expect([2, 3, 4, 5, 6].map((k) => primaryAt(shift, slot(k)).user)).toEqual([
      'carol',
      'alice',
      'dave',
      'bob',
      'carol',
    ]);

    const dave = ctx.first('cmn_rota_member', `roster=${primary.sysId}^member=${users.dave}`)!;
    ctx.delete(dave);
    const bob = ctx.first('cmn_rota_member', `roster=${primary.sysId}^member=${users.bob}`)!;
    ctx.update(bob, { to: '2026-02-01' });
    expect([1, 4, 5].map((k) => primaryAt(shift, slot(k)).user)).toEqual(['bob', 'carol', 'alice']);

    ctx.update(bob, { to: '' });
    const alice = ctx.first('cmn_rota_member', `roster=${primary.sysId}^member=${users.alice}`)!;
    ctx.update(alice, { to: '2026-01-21' });
    ctx.update(bob, { to: '2026-01-21' });
    ctx.insert('cmn_rota_member', {
      roster: primary.sysId,
      member: users.bob,
      order: 100,
      from: '2026-01-21',
    });
    ctx.insert('cmn_rota_member', {
      roster: primary.sysId,
      member: users.alice,
      order: 200,
      from: '2026-01-21',
    });
    expect([2, 3, 4].map((k) => primaryAt(shift, slot(k)).user)).toEqual(['carol', 'bob', 'alice']);
  });

  it('11-13: time off, approved cover and coverage spans', () => {
    boot();
    const { group, shift, primary } = exampleA();
    ctx.insert('cmn_rota_member', {
      roster: primary.sysId,
      member: users.dave,
      order: 150,
      from: '2026-01-21',
    });
    const off = ctx.insert('roster_schedule_span', {
      type: 'time_off',
      group: group.sysId,
      user: users.bob,
      proposed_cover: users.carol,
      state: 'requested',
      start_date_time: '20260210T000000',
      end_date_time: '20260213T000000',
    });
    expect(primaryAt(shift, '2026-02-11 12:00:00')).toEqual({ user: 'bob', source: 'rotation', gap: null });
    expect(approveTimeOff(ctx, ctx.get('roster_schedule_span', off.sysId)!)).toBe(1);
    expect(primaryAt(shift, '2026-02-11 12:00:00')).toEqual({ user: 'carol', source: 'coverage', gap: null });
    expect(planAt(shift, '2026-02-11 12:00:00')).toEqual([['carol'], ['alice'], ['dave']]);

    clock.freeze('2026-02-11 12:00:00');
    const t = task({ assignment_group: group.sysId });
    const esc = escalationOf(t);
    const first = ctx.first('on_call_escalation_level', `escalation=${esc.sysId}^level=1`)!;
    expect(first.str('escalatees')).toBe(users.carol);
    expect(ctx.count('on_call_escalation_comm', `escalatee=${users.bob}`)).toBe(0);

    ctx.delete(ctx.first('roster_schedule_span', 'type=on_call^userISNOTEMPTY')!);
    expect(primaryAt(shift, '2026-02-11 12:00:00')).toEqual({ user: null, source: null, gap: 'time_off' });
    expect(planAt(shift, '2026-02-11 12:00:00')).toEqual([['carol'], ['alice'], ['dave']]);

    const secondary = roster(shift, [['dave', 100]], { name: 'Secondary', order: 200 });
    ctx.insert('roster_schedule_span', {
      type: 'on_call',
      roster: secondary.sysId,
      user: users.alice,
      start_date_time: '20260203T000000',
      end_date_time: '20260204T000000',
    });
    expect(primaryAt(shift, '2026-02-03 12:00:00', 1)).toEqual({
      user: 'alice',
      source: 'coverage',
      gap: null,
    });
    expect(primaryAt(shift, '2026-02-04 00:00:00', 1)).toEqual({
      user: 'dave',
      source: 'rotation',
      gap: null,
    });
  });

  it('12: a requested time off does not remove the holder; an approved one makes a gap and escalates to the secondary', () => {
    boot();
    const { group, shift } = exampleA();
    roster(shift, [['dave', 100]], { name: 'Secondary', order: 200 });
    const off = ctx.insert('roster_schedule_span', {
      type: 'time_off',
      group: group.sysId,
      user: users.carol,
      state: 'requested',
      start_date_time: '20260120T000000',
      end_date_time: '20260123T000000',
    });
    expect(primaryAt(shift, '2026-01-21 10:00:00').user).toBe('carol');
    ctx.update(off, { state: 'approved' });
    expect(primaryAt(shift, '2026-01-21 10:00:00')).toEqual({ user: null, source: null, gap: 'time_off' });
    expect(planAt(shift, '2026-01-21 10:00:00')).toEqual([['dave']]);
  });

  it('14: an inactive holder leaves a gap without shifting later slots', () => {
    boot();
    const { shift } = exampleA();
    ctx.update(ctx.get('sys_user', users.carol)!, { active: false });
    expect(primaryAt(shift, '2026-01-21 10:00:00')).toEqual({ user: null, source: null, gap: 'inactive' });
    expect(primaryAt(shift, '2026-01-27 10:00:00').user).toBe('alice');
    ctx.update(ctx.get('sys_user', users.carol)!, { active: true });
    expect(primaryAt(shift, '2026-01-21 10:00:00').user).toBe('carol');
  });

  it('15: shift schedules with holidays; draft shifts are ignored', () => {
    boot();
    const group = network();
    const holidays = ctx.insert('cmn_schedule', { name: 'Holidays', type: 'excluded' });
    ctx.insert('cmn_schedule_span', {
      schedule: holidays.sysId,
      name: 'Christmas',
      type: 'exclude',
      all_day: true,
      start_date_time: '20261225',
      end_date_time: '20261225',
    });
    const office = ctx.insert('cmn_schedule', {
      name: 'NY office hours',
      type: 'roster',
      time_zone: 'America/New_York',
    });
    ctx.insert('cmn_schedule_span', {
      schedule: office.sysId,
      name: 'Weekdays',
      start_date_time: '20000103T080000',
      end_date_time: '20000103T170000',
      repeat_type: 'weekdays',
    });
    ctx.insert('cmn_other_schedule', {
      schedule: office.sysId,
      child_schedule: holidays.sysId,
      type: 'include',
    });
    const shift = rota(group, { schedule: office.sysId });
    roster(shift, [['alice', 100]], { rotation_start_date: '2026-01-05' });
    expect(planAt(shift, '2026-12-21 15:00:00')).toEqual([['alice']]);
    expect(planAt(shift, '2026-12-19 17:00:00')).toEqual([]);
    expect(planAt(shift, '2026-12-25 15:00:00')).toEqual([]);
    ctx.update(shift, { state: 'draft' });
    expect(planAt(shift, '2026-12-21 15:00:00')).toEqual([]);
  });

  it('16-17: overlapping shifts follow the overlap rule and need permission', () => {
    boot();
    const group = network();
    const window = (name: string, start: string, end: string) => {
      const s = ctx.insert('cmn_schedule', { name, type: 'roster' });
      ctx.insert('cmn_schedule_span', {
        schedule: s.sysId,
        name,
        start_date_time: `20000101T${start}`,
        end_date_time: `20000101T${end}`,
        repeat_type: 'daily',
      });
      return s.sysId;
    };
    const emea = rota(group, { name: 'EMEA', schedule: window('EMEA', '060000', '150000') });
    roster(emea, [['alice', 100]]);
    expect(() => rota(group, { name: 'AMER', schedule: window('AMER', '140000', '230000') })).toThrow(
      AbortError,
    );
    const pref = ctx.insert('on_call_group_preference', {
      group: group.sysId,
      allow_rota_overlap: 'yes',
      escalation_rule_rota_overlap: 'incoming',
    });
    const amer = rota(group, { name: 'AMER', schedule: ctx.first('cmn_schedule', 'name=AMER')!.sysId });
    roster(amer, [['bob', 100]]);
    const pick = () => {
      const s = svc.snapshot(ctx);
      return svc.rotasForEscalation(s, group.sysId, T('2026-02-02 14:30:00')).map((r) => r.name);
    };
    expect(pick()).toEqual(['AMER']);
    ctx.update(pref, { escalation_rule_rota_overlap: 'outgoing' });
    expect(pick()).toEqual(['EMEA']);
    ctx.update(pref, { escalation_rule_rota_overlap: 'all' });
    expect(pick().sort()).toEqual(['AMER', 'EMEA']);
  });

  it('31: custom escalation policies chosen by condition, with their own step timing', () => {
    boot();
    const { shift } = exampleA({ use_custom_escalation: true });
    const p1 = ctx.insert('cmn_rota_escalation_set', {
      cmn_rota: shift.sysId,
      name: 'P1',
      order: 100,
      condition: 'priority=1',
    });
    ctx.insert('cmn_rota_esc_step_def', {
      cmn_rota_escalation_set: p1.sysId,
      escalation_level: 1,
      users: users.carol,
      reminder_num: 1,
      time_between_reminders: 5 * MIN,
      time_to_next_step: 10 * MIN,
    });
    ctx.insert('cmn_rota_esc_step_def', {
      cmn_rota_escalation_set: p1.sysId,
      escalation_level: 2,
      users: users.bob,
      group_manager: true,
    });
    const def = ctx.insert('cmn_rota_escalation_set', {
      cmn_rota: shift.sysId,
      name: 'Default',
      default: true,
    });
    ctx.insert('cmn_rota_esc_step_def', {
      cmn_rota_escalation_set: def.sysId,
      escalation_level: 1,
      users: users.alice,
    });
    const group = ctx.first('sys_user_group', 'name=Network')!;
    clock.freeze('2026-01-21 10:00:00');
    const urgent = task({ assignment_group: group.sysId });
    const minor = ctx.insert('task', { short_description: 'Printer queue stuck', priority: 3 });
    expect(planAt(shift, '2026-01-21 10:00:00', urgent)).toEqual([['carol'], ['bob', 'mia']]);
    expect(planAt(shift, '2026-01-21 10:00:00', minor)).toEqual([['alice']]);
    const esc = escalationOf(urgent);
    tick('2026-01-21 10:05:00');
    tick('2026-01-21 10:10:00');
    tick('2026-01-21 10:15:00');
    expect(comms(esc)).toEqual(['carol@10:00', 'carol@10:05', 'bob@10:15', 'mia@10:15']);
  });
});

describe('escalation', () => {
  /** Example D: Primary (2 reminders, 10 min, Carol) and Secondary (1 reminder, 5 min, Alice), catch-all group manager Mia. */
  function exampleD(primaryValues: Record<string, unknown> = {}) {
    const { group, shift } = exampleA({ catch_all: 'group_manager' });
    const primary = ctx.first('cmn_rota_roster', `rota=${shift.sysId}`)!;
    ctx.update(primary, { attempts: 2, time_between_reminders: 10 * MIN, ...primaryValues });
    roster(shift, [['alice', 100]], {
      name: 'Secondary',
      order: 200,
      attempts: 1,
      time_between_reminders: 5 * MIN,
    });
    clock.freeze('2026-01-21 10:00:00');
    const t = task({ assignment_group: group.sysId });
    return { group, shift, t, esc: escalationOf(t) };
  }

  it('18-19: pages level by level and ends exhausted when nobody answers', () => {
    boot();
    const { t, esc } = exampleD();
    expect(esc.bool('active')).toBe(true);
    expect(esc.str('category')).toBe('assign_by_acknowledgement');
    expect(esc.str('table')).toBe('task');
    expect(esc.str('source')).toBe(t.sysId);
    expect(ctx.first('on_call_escalation_level', `escalation=${esc.sysId}^level=1`)!.str('escalatees')).toBe(
      users.carol,
    );
    expect(comms(esc)).toEqual(['carol@10:00']);
    expect(ctx.count('sysevent', `name=oncall.escalation^parm1=${users.carol}`)).toBe(1);
    for (let m = 5; m <= 50; m += 5) tick(`2026-01-21 10:${String(m).padStart(2, '0')}:00`);
    expect(comms(esc)).toEqual([
      'carol@10:00',
      'carol@10:10',
      'carol@10:20',
      'alice@10:30',
      'alice@10:35',
      'mia@10:40',
      'mia@10:45',
    ]);
    expect(ctx.count('on_call_escalation_comm', `escalation=${esc.sysId}^catch_all=true`)).toBe(2);
    const done = ctx.get('on_call_escalation', esc.sysId)!;
    expect(done.bool('active')).toBe(false);
    expect(done.bool('acknowledged')).toBe(false);
    expect(done.str('end_reason')).toBe('exhausted');
    expect(done.str('end_time')).toBe('2026-01-21 10:50:00');
  });

  it('20: a rejection by every escalatee starts the next level at once', () => {
    boot();
    const { esc } = exampleD();
    for (const m of ['10', '20', '30']) tick(`2026-01-21 10:${m}:00`);
    clock.freeze('2026-01-21 10:33:00');
    expect(engine.respond(ctx, ctx.get('on_call_escalation', esc.sysId)!, users.alice, 'rejected').ok).toBe(
      true,
    );
    expect(comms(esc)).toEqual(['carol@10:00', 'carol@10:10', 'carol@10:20', 'alice@10:30', 'mia@10:33']);
    expect(ctx.first('on_call_escalation_comm', `escalatee=${users.alice}`)!.str('response')).toBe(
      'rejected',
    );
  });

  it('21: acceptance assigns the task and stops the escalation', () => {
    boot();
    const { t, esc } = exampleD();
    tick('2026-01-21 10:10:00');
    clock.freeze('2026-01-21 10:12:00');
    expect(engine.respond(ctx, ctx.get('on_call_escalation', esc.sysId)!, users.carol, 'accepted').ok).toBe(
      true,
    );
    const done = ctx.get('on_call_escalation', esc.sysId)!;
    expect(done.bool('acknowledged')).toBe(true);
    expect(done.str('acknowledged_by')).toBe(users.carol);
    expect(done.num('time_to_acknowledge')).toBe(12 * MIN);
    expect(ctx.get('task', t.sysId)!.str('assigned_to')).toBe(users.carol);
    expect(
      p.history.journal('task', t.sysId, ['work_notes']).some((j) => j.value.includes('acknowledged')),
    ).toBe(true);
    tick('2026-01-21 10:30:00');
    expect(comms(esc)).toEqual(['carol@10:00', 'carol@10:10']);
    expect(ctx.count('sysevent', 'name=on_call.escalation.acknowledged')).toBe(1);
  });

  it('22: a group change ends the running escalation or hands it to the new group', () => {
    boot();
    const { group, t, esc } = exampleD();
    const db = ctx.insert('sys_user_group', { name: 'Database' });
    clock.freeze('2026-01-21 10:15:00');
    ctx.update(ctx.get('task', t.sysId)!, { assignment_group: db.sysId });
    expect(ctx.get('on_call_escalation', esc.sysId)!.str('end_reason')).toBe('cancelled_group_change');
    expect(ctx.count('on_call_escalation', `source=${t.sysId}`)).toBe(1);
    tick('2026-01-21 10:40:00');
    expect(comms(esc)).toEqual(['carol@10:00']);

    ctx.insert('sys_user_grmember', { user: users.dave, group: db.sysId });
    const dbShift = rota(db, { name: 'Database on-call' });
    roster(dbShift, [['dave', 100]]);
    const t2 = task({ assignment_group: group.sysId });
    const esc2 = escalationOf(t2);
    ctx.update(ctx.get('task', t2.sysId)!, { assignment_group: db.sysId });
    expect(ctx.get('on_call_escalation', esc2.sysId)!.str('end_reason')).toBe('superseded');
    const next = ctx.first('on_call_escalation', `source=${t2.sysId}^active=true`)!;
    expect(next.sysId).not.toBe(esc2.sysId);
    expect(next.bool('active')).toBe(true);
    expect(comms(next)).toEqual(['dave@10:40']);
  });

  it('23, 27: only urgent unassigned tasks page; manual assignment and closure end the page', () => {
    boot();
    const { group } = exampleA();
    clock.freeze('2026-01-21 10:00:00');
    const minor = task({ priority: 3, assignment_group: group.sysId });
    expect(ctx.count('on_call_escalation', `source=${minor.sysId}`)).toBe(0);
    ctx.update(ctx.get('task', minor.sysId)!, { priority: 1 });
    expect(escalationOf(minor).bool('active')).toBe(true);
    ctx.update(ctx.get('task', minor.sysId)!, { assigned_to: users.bob });
    expect(escalationOf(minor).str('end_reason')).toBe('assigned');

    const assigned = task({ assignment_group: group.sysId, assigned_to: users.alice });
    expect(ctx.count('on_call_escalation', `source=${assigned.sysId}`)).toBe(0);
    const closing = task({ assignment_group: group.sysId });
    ctx.update(ctx.get('task', closing.sysId)!, { state: '3' });
    expect(escalationOf(closing).str('end_reason')).toBe('task_inactive');

    clock.freeze('2026-01-05 07:00:00');
    const early = task({ assignment_group: group.sysId });
    expect(escalationOf(early).str('end_reason')).toBe('no_on_call');
    expect(ctx.get('task', early.sysId)!.str('assigned_to')).toBe('');
    expect(p.history.journal('task', early.sysId, ['work_notes'])[0].value).toContain(
      'no one is on call for Network',
    );

    const quiet = ctx.insert('sys_user_group', { name: 'Facilities' });
    const other = task({ assignment_group: quiet.sysId });
    expect(ctx.count('on_call_escalation', `source=${other.sysId}`)).toBe(0);
  });

  it('24-25: a forced channel without an address fails without fallback; delivery callbacks only move forward', () => {
    boot();
    const { t, esc } = exampleD({ force_channel: 'sms' });
    const rows = ctx.query('on_call_escalation_comm', { query: `escalation=${esc.sysId}` });
    expect(rows.map((r) => [r.str('comm_type'), r.str('status')])).toEqual([['sms', 'failed']]);
    expect(rows[0].str('failure_reason')).toContain('No SMS address');
    expect(p.history.journal('task', t.sysId, ['work_notes'])[0].value).toContain(
      'On-call notification failed',
    );
    for (const m of ['10', '20', '30']) tick(`2026-01-21 10:${m}:00`);
    expect(comms(esc)).toEqual(['carol@10:00', 'alice@10:30']);

    const alice = ctx.first('on_call_escalation_comm', `escalatee=${users.alice}`)!;
    engine.deliveryStatus(ctx, alice, 'delivered');
    engine.deliveryStatus(ctx, ctx.get('on_call_escalation_comm', alice.sysId)!, 'sent');
    expect(ctx.get('on_call_escalation_comm', alice.sysId)!.str('status')).toBe('delivered');
    engine.deliveryStatus(ctx, ctx.get('on_call_escalation_comm', alice.sysId)!, 'failed', 'Mailbox full');
    expect(ctx.get('on_call_escalation_comm', alice.sysId)!.str('status')).toBe('failed');
    engine.deliveryStatus(ctx, ctx.get('on_call_escalation_comm', alice.sysId)!, 'delivered');
    expect(ctx.get('on_call_escalation_comm', alice.sysId)!.str('status')).toBe('failed');
  });

  it('30: with the "all" overlap rule each shift runs a track and one acceptance ends both', () => {
    boot();
    const { group, shift } = exampleA();
    ctx.insert('on_call_group_preference', {
      group: group.sysId,
      allow_rota_overlap: 'yes',
      escalation_rule_rota_overlap: 'all',
    });
    const other = rota(group, { name: 'Network backup' });
    roster(other, [['dave', 100]]);
    clock.freeze('2026-01-21 10:00:00');
    const t = task({ assignment_group: group.sysId });
    const esc = escalationOf(t);
    const firsts = ctx.query('on_call_escalation_level', { query: `escalation=${esc.sysId}^level=1` });
    expect(firsts.map((l) => nameOf(l.str('escalatees'))).sort()).toEqual(['carol', 'dave']);
    expect(firsts.map((l) => l.str('rota')).sort()).toEqual([shift.sysId, other.sysId].sort());
    engine.respond(ctx, esc, users.dave, 'accepted');
    expect(ctx.count('on_call_escalation_level', `escalation=${esc.sysId}^active=true`)).toBe(0);
    expect(ctx.get('task', t.sysId)!.str('assigned_to')).toBe(users.dave);
  });
});

describe('time off policy', () => {
  it('29: members follow the group policy; shift managers are exempt', () => {
    boot();
    const { group } = exampleA();
    const pref = ctx.insert('on_call_group_preference', { group: group.sysId, pto_approval: 'not_allowed' });
    const values = {
      type: 'time_off',
      group: group.sysId,
      user: users.bob,
      start_date_time: '20260302',
      end_date_time: '20260303',
    };
    const bob = p.contextAs('bob');
    expect(() => bob.insert('roster_schedule_span', values)).toThrow(AbortError);
    const mia = p.contextAs('mia');
    expect(mia.insert('roster_schedule_span', values).str('state')).toBe('approved');
    ctx.update(pref, { pto_approval: 'with_approval' });
    const requested = bob.insert('roster_schedule_span', {
      ...values,
      start_date_time: '20260310',
      end_date_time: '20260311',
    });
    expect(requested.str('state')).toBe('requested');
    expect(ctx.count('sysevent', 'name=on_call.timeoff.requested')).toBe(1);
    approveTimeOff(mia, ctx.get('roster_schedule_span', requested.sysId)!);
    expect(ctx.get('roster_schedule_span', requested.sysId)!.str('state')).toBe('approved');
    expect(() => p.contextAs('carol').insert('roster_schedule_span', values)).toThrow();
  });
});

describe('REST and demo data', () => {
  it('serves who is on call, the calendar and acknowledgements', async () => {
    boot();
    const { group, shift } = exampleA({ catch_all: 'group_manager' });
    const dir = mkdtempSync(join(tmpdir(), 'resolvrnow-oncall-'));
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
    makeUser(p, 'outsider', []);
    try {
      const cur = await app.inject({
        method: 'GET',
        url: `/api/app/oncall/${group.sysId}/current?at=${encodeURIComponent('2026-01-21 10:00:00')}`,
        headers: auth('alice'),
      });
      expect(cur.statusCode).toBe(200);
      const body = cur.json().result;
      expect(body.on_call.user_name).toBe('carol');
      expect(body.rotas[0].escalation_type).toBe('rotate_through_members');
      expect(body.rotas[0].rosters[0]).toMatchObject({ name: 'Primary', source: 'rotation', gap: null });
      expect(body.rotas[0].plan.map((l: { users: { user_name: string }[] }) => l.users[0].user_name)).toEqual(
        ['carol', 'alice', 'bob', 'mia'],
      );
      expect(body.rotas[0].plan[3].catch_all).toBe(true);

      const byName = await app.inject({
        method: 'GET',
        url: `/api/app/oncall/Network/current?at=${encodeURIComponent('2026-01-26 08:00:00')}`,
        headers: auth('alice'),
      });
      expect(byName.json().result.on_call.user_name).toBe('alice');
      const denied = await app.inject({
        method: 'GET',
        url: `/api/app/oncall/${group.sysId}/current`,
        headers: auth('outsider'),
      });
      expect(denied.statusCode).toBe(403);
      const unknown = await app.inject({
        method: 'GET',
        url: '/api/app/oncall/Nobody/current',
        headers: auth('alice'),
      });
      expect(unknown.statusCode).toBe(404);

      const cal = await app.inject({
        method: 'GET',
        url: `/api/app/oncall/${group.sysId}/schedule?from=${encodeURIComponent('2026-01-10 00:00:00')}&to=${encodeURIComponent('2026-01-24 00:00:00')}`,
        headers: auth('alice'),
      });
      expect(cal.statusCode).toBe(200);
      const segments = cal
        .json()
        .result.rotas[0].rosters[0].segments.map(
          (x: { start: string; user: { user_name: string } }) => `${x.start} ${x.user.user_name}`,
        );
      expect(segments).toEqual([
        '2026-01-10 00:00:00 alice',
        '2026-01-12 08:00:00 bob',
        '2026-01-19 08:00:00 carol',
      ]);

      clock.freeze('2026-01-21 10:00:00');
      const t = task({ assignment_group: group.sysId });
      clock.freeze('2026-01-21 10:04:00');
      const notPaged = await app.inject({
        method: 'POST',
        url: '/api/app/oncall/ack',
        headers: { ...auth('bob'), 'content-type': 'application/json' },
        payload: { task: t.sysId },
      });
      expect(notPaged.statusCode).toBe(403);
      const ack = await app.inject({
        method: 'POST',
        url: '/api/app/oncall/ack',
        headers: { ...auth('carol'), 'content-type': 'application/json' },
        payload: { task: t.sysId },
      });
      expect(ack.statusCode).toBe(200);
      expect(ack.json().result.escalation).toMatchObject({
        active: false,
        acknowledged: true,
        end_reason: 'accepted',
      });
      expect(ctx.get('task', t.sysId)!.str('assigned_to')).toBe(users.carol);
      const again = await app.inject({
        method: 'POST',
        url: '/api/app/oncall/ack',
        headers: { ...auth('carol'), 'content-type': 'application/json' },
        payload: { task: t.sysId },
      });
      expect(again.statusCode).toBe(409);
      expect(shift.sysId).toBeTruthy();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Northwind Labs demo shifts', () => {
    p = bootPlatform([schedulesModule, oncallModule], { demo: true });
    ctx = p.systemContext();
    svc = p.service<OnCallService>('oncall');
    expect(
      ctx.query('cmn_rota', { query: 'ORDERBYname' }).map((r) => `${r.str('name')}:${r.str('state')}`),
    ).toEqual(['Network Operations after hours:published', 'Service Desk 24x7:published']);
    const desk = ctx.first('sys_user_group', 'name=Service Desk')!;
    const s = svc.snapshot(ctx);
    const rotaInfo = s.rotasOf(desk.sysId)[0];
    const plan = svc.plan(s, rotaInfo, clock.now().getTime());
    expect(plan.length).toBeGreaterThanOrEqual(3);
    expect(plan[plan.length - 1].catchAll).toBe(true);
    expect(ctx.count('roster_schedule_span', 'type=on_call^userISNOTEMPTY')).toBe(1);
    expect(ctx.first('roster_schedule_span', 'type=time_off')!.str('state')).toBe('approved');
  });
});
