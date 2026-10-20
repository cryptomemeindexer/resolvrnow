import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { clock } from '../../engine/util.js';
import { DAY, isoDateOf, isoWeekday, ymdOf } from '../schedules/time.js';
import { approveTimeOff } from './rules.js';

function user(ctx: Context, userName: string): string | null {
  return ctx.first('sys_user', `user_name=${userName}`)?.sysId ?? null;
}

function rosterSchedule(ctx: Context, name: string, zone: string, spans: Record<string, unknown>[]): string {
  const existing = ctx.first('cmn_schedule', `name=${name}`);
  if (existing) return existing.sysId;
  const s = ctx.insert('cmn_schedule', {
    name,
    type: 'roster',
    time_zone: zone,
    description: 'On-call shift schedule (Northwind Labs demo).',
  });
  for (const span of spans)
    ctx.insert('cmn_schedule_span', { schedule: s.sysId, show_as: 'on_call', ...span });
  return s.sysId;
}

function roster(ctx: Context, rota: Rec, name: string, order: number, start: string, members: string[]): Rec {
  const r = ctx.insert('cmn_rota_roster', {
    rota: rota.sysId,
    name,
    order,
    rotation_interval_type: 'weekly',
    rotation_interval_count: 1,
    rotation_day_of_week: '1',
    rotation_start_date: start,
    rotation_all_day: false,
    rotation_start_time: '09:00:00',
    attempts: 1,
    time_between_reminders: 10 * 60_000,
  });
  members.forEach((m, i) => {
    const id = user(ctx, m);
    if (id) ctx.insert('cmn_rota_member', { roster: r.sysId, member: id, order: (i + 1) * 100 });
  });
  return r;
}

/** Northwind Labs on-call shifts for the Service Desk and Network Operations groups. */
export function seedOncallDemo(ctx: Context): void {
  const desk = ctx.first('sys_user_group', 'name=Service Desk');
  const network = ctx.first('sys_user_group', 'name=Network Operations');
  if (!desk || !network || ctx.count('cmn_rota') > 0) return;
  const today = Math.floor(clock.now().getTime() / DAY);
  const monday = today - (isoWeekday(today) - 1);
  const start = isoDateOf(monday - 14);

  ctx.insert('on_call_group_preference', {
    group: desk.sysId,
    shift_managers: user(ctx, 'priya.nair') ?? '',
    pto_approval: 'with_approval',
    escalation_rule_rota_overlap: 'all',
  });
  const deskRota = ctx.insert('cmn_rota', {
    name: 'Service Desk 24x7',
    group: desk.sysId,
    schedule: rosterSchedule(ctx, 'Service Desk on-call (24x7)', 'America/Chicago', [
      {
        name: 'Around the clock',
        start_date_time: '20000101T000000',
        end_date_time: '20000102T000000',
        repeat_type: 'daily',
      },
    ]),
    manager: user(ctx, 'priya.nair'),
    color: '#2563eb',
    catch_all: 'group_manager',
  });
  roster(ctx, deskRota, 'Primary', 100, start, ['alex.rivera', 'noor.haddad', 'hannah.lee']);
  roster(ctx, deskRota, 'Secondary', 200, start, ['ravi.menon', 'priya.nair']);
  ctx.update(deskRota, { state: 'published' });

  const netRota = ctx.insert('cmn_rota', {
    name: 'Network Operations after hours',
    group: network.sysId,
    schedule: rosterSchedule(ctx, 'Network Operations after hours', 'America/Chicago', [
      {
        name: 'Weeknights',
        start_date_time: '20000103T180000',
        end_date_time: '20000104T080000',
        repeat_type: 'weekdays',
      },
      {
        name: 'Weekends',
        start_date_time: '20000101T000000',
        end_date_time: '20000103T080000',
        repeat_type: 'weekly',
        days_of_week: '6',
      },
    ]),
    manager: user(ctx, 'marcus.chen'),
    color: '#16a34a',
    catch_all: 'individual',
    catch_all_member: user(ctx, 'maya.cohen'),
  });
  roster(ctx, netRota, 'Primary', 100, start, ['marcus.chen']);
  ctx.update(netRota, { state: 'published' });

  const noor = user(ctx, 'noor.haddad');
  const hannah = user(ctx, 'hannah.lee');
  if (noor && hannah) {
    const from = ymdOf(monday + 9);
    const to = ymdOf(monday + 11);
    const span = ctx.insert('roster_schedule_span', {
      schedule: deskRota.str('schedule'),
      type: 'time_off',
      group: desk.sysId,
      user: noor,
      proposed_cover: hannah,
      state: 'requested',
      name: 'Time off: family visit',
      all_day: true,
      start_date_time: `${from}T000000`,
      end_date_time: `${to}T235959`,
    });
    approveTimeOff(ctx, span);
  }
}
