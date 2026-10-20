import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { clock } from '../../engine/util.js';
import { scheduleEngine } from '../schedules/engine.js';
import { DAY } from '../schedules/time.js';
import { ONCALL_EVENTS } from './escalation.js';
import { ONCALL_PROPS } from './service.js';

const OVERLAP_HORIZON = 28 * DAY;

/** The group a shift-related record belongs to. */
export function groupOfRecord(ctx: Context, rec: Rec | null): string {
  if (!rec) return '';
  const sys = ctx.elevated();
  switch (rec.table.name) {
    case 'cmn_rota':
    case 'on_call_group_preference':
      return rec.str('group');
    case 'cmn_rota_roster':
      return sys.get('cmn_rota', rec.str('rota'))?.str('group') ?? '';
    case 'cmn_rota_member':
      return groupOfRecord(ctx, sys.get('cmn_rota_roster', rec.str('roster')));
    case 'cmn_rota_escalation_set':
      return sys.get('cmn_rota', rec.str('cmn_rota'))?.str('group') ?? '';
    case 'cmn_rota_esc_step_def':
      return groupOfRecord(ctx, sys.get('cmn_rota_escalation_set', rec.str('cmn_rota_escalation_set')));
    case 'roster_schedule_span':
      return rec.str('group') || groupOfRecord(ctx, sys.get('cmn_rota_roster', rec.str('roster')));
    default:
      return '';
  }
}

/** Group managers, listed shift managers and on-call administrators manage a group's shifts. */
export function managesGroup(ctx: Context, groupId: string): boolean {
  if (ctx.hasRole('rota_admin')) return true;
  if (!groupId || !ctx.user.sysId) return false;
  const sys = ctx.elevated();
  if (sys.get('sys_user_group', groupId)?.str('manager') === ctx.user.sysId) return true;
  const pref = sys.first('on_call_group_preference', `group=${groupId}`);
  return (pref?.str('shift_managers') ?? '').split(',').includes(ctx.user.sysId);
}

function groupPreference(
  ctx: Context,
  groupId: string,
  field: string,
  property: string,
  fallback: string,
): string {
  const v = ctx.elevated().first('on_call_group_preference', `group=${groupId}`)?.str(field) || 'default';
  return v === 'default' ? ctx.platform.properties.get(property) || fallback : v;
}

/** A 24x7 roster schedule owned by the shift, created when a shift is saved without one. */
function createShiftSchedule(ctx: Context, rota: Rec): string {
  const sys = ctx.elevated();
  const schedule = sys.insert('cmn_schedule', {
    name: `${rota.str('name') || 'Shift'} schedule`,
    type: 'roster',
    read_only: true,
    document: 'cmn_rota',
    document_key: rota.sysId,
    description: 'Created for the on-call shift; edit its entries to change when the shift is active.',
  });
  sys.insert('cmn_schedule_span', {
    schedule: schedule.sysId,
    name: 'All day, every day',
    start_date_time: '20000101T000000',
    end_date_time: '20000102T000000',
    repeat_type: 'daily',
    show_as: 'on_call',
  });
  return schedule.sysId;
}

function overlapsAnotherShift(ctx: Context, rota: Rec): string | null {
  const engine = scheduleEngine(ctx.platform);
  if (!engine) return null;
  const from = clock.now().getTime();
  const to = from + OVERLAP_HORIZON;
  const zoneOf = (id: string | null) => engine.fixedZone(id) ?? engine.systemZone();
  const mine = engine.intervals(rota.str('schedule') || null, zoneOf(rota.str('schedule') || null), from, to);
  const others = ctx.elevated().query('cmn_rota', {
    query: `group=${rota.str('group')}^state=published^active=true^sys_id!=${rota.sysId}`,
  });
  for (const other of others) {
    const id = other.str('schedule') || null;
    const theirs = engine.intervals(id, zoneOf(id), from, to);
    if (mine.some(([a, b]) => theirs.some(([c, d]) => a < d && c < b))) return other.str('name');
  }
  return null;
}

export const oncallRules: BusinessRuleDef[] = [
  {
    name: 'Shift: create the shift schedule',
    table: 'cmn_rota',
    when: 'before',
    actions: ['insert', 'update'],
    order: 10,
    condition: (cur) => !cur.str('schedule'),
    run(cur, _prev, ctx) {
      cur.setRaw('schedule', createShiftSchedule(ctx, cur));
    },
  },
  {
    name: 'Shift: no overlapping published shifts unless allowed',
    table: 'cmn_rota',
    when: 'before',
    actions: ['insert', 'update'],
    order: 20,
    condition: (cur) =>
      cur.str('state') === 'published' &&
      cur.bool('active') &&
      (cur.isNew() ||
        cur.changed('state') ||
        cur.changed('schedule') ||
        cur.changed('group') ||
        cur.changed('active')),
    run(cur, _prev, ctx) {
      const allow = groupPreference(
        ctx,
        cur.str('group'),
        'allow_rota_overlap',
        ONCALL_PROPS.allowOverlap,
        'false',
      );
      if (allow === 'yes' || allow === 'true') return;
      const other = overlapsAnotherShift(ctx, cur);
      if (other)
        cur.abort(
          `The shift overlaps the published shift "${other}" and overlapping shifts are not allowed for this group`,
        );
    },
  },
  {
    name: 'Roster: time before escalation',
    table: 'cmn_rota_roster',
    when: 'before',
    actions: ['insert', 'update'],
    run(cur) {
      const attempts = cur.num('attempts') ?? 0;
      const between = cur.num('time_between_reminders') ?? 900_000;
      cur.setRaw('time_before_escalation', (attempts + 1) * between);
      if ((cur.num('rotation_interval_count') ?? 1) < 1) cur.setRaw('rotation_interval_count', 1);
    },
  },
  {
    name: 'On-call member: must belong to the shift group',
    table: 'cmn_rota_member',
    when: 'before',
    actions: ['insert'],
    run(cur, _prev, ctx) {
      const group = groupOfRecord(ctx, cur);
      if (!group || !cur.str('member')) return;
      const member = ctx.platform.db.get(
        `SELECT "sys_id" FROM "sys_user_grmember" WHERE "group" = ? AND "user" = ?`,
        [group, cur.str('member')],
      );
      if (!member) cur.abort(`${cur.display('member') || 'The user'} is not a member of the shift's group`);
    },
  },
  {
    name: 'Roster span: defaults',
    table: 'roster_schedule_span',
    when: 'before',
    actions: ['insert'],
    order: 5,
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      const roster = cur.str('roster') ? sys.get('cmn_rota_roster', cur.str('roster')) : null;
      const rota = roster ? sys.get('cmn_rota', roster.str('rota')) : null;
      if (!cur.str('group') && rota && cur.str('type') !== 'time_off') cur.setRaw('group', rota.str('group'));
      if (!cur.str('schedule')) {
        const groupId = cur.str('group') || rota?.str('group') || '';
        const shift = rota ?? (groupId ? sys.first('cmn_rota', `group=${groupId}^ORDERBYname`) : null);
        if (shift?.str('schedule')) cur.setRaw('schedule', shift.str('schedule'));
        else cur.abort('A roster span needs a shift schedule: no shift found for its group');
      }
      if (!cur.str('name'))
        cur.setRaw(
          'name',
          cur.str('type') === 'time_off'
            ? `Time off: ${cur.display('user')}`
            : `Cover: ${cur.display('user')}`,
        );
    },
  },
  {
    name: 'Time off: approval policy',
    table: 'roster_schedule_span',
    when: 'before',
    actions: ['insert'],
    order: 20,
    condition: 'type=time_off',
    run(cur, _prev, ctx) {
      const group = cur.str('group');
      const exempt =
        ctx.user.isSystem ||
        ctx.hasAnyRole(['rota_admin', 'rota_manager']) ||
        (!!group && managesGroup(ctx, group));
      if (exempt) {
        if (!cur.str('state')) cur.setRaw('state', 'approved');
        return;
      }
      const policy = group
        ? groupPreference(ctx, group, 'pto_approval', ONCALL_PROPS.pto, 'with_approval')
        : ctx.platform.properties.get(ONCALL_PROPS.pto) || 'with_approval';
      if (policy === 'not_allowed') return cur.abort('Time off requests are not allowed for this group');
      cur.setRaw('state', policy === 'without_approval' ? 'approved' : 'requested');
    },
  },
  {
    name: 'Time off: announce requests',
    table: 'roster_schedule_span',
    when: 'after',
    actions: ['insert'],
    condition: 'type=time_off^state=requested',
    run(cur, _prev, ctx) {
      ctx.queueEvent(ONCALL_EVENTS.timeoffRequested, cur, cur.str('user'), cur.str('group'));
    },
  },
];

/** Approving time off with a proposed cover creates one coverage span per roster of the requester. */
export function approveTimeOff(ctx: Context, span: Rec): number {
  const sys = ctx.elevated();
  sys.update(span, { state: 'approved' });
  let created = 0;
  const cover = span.str('proposed_cover');
  if (cover) {
    const group = span.str('group');
    const rotas = group ? sys.query('cmn_rota', { query: `group=${group}^active=true` }) : [];
    for (const rota of rotas) {
      for (const roster of sys.query('cmn_rota_roster', { query: `rota=${rota.sysId}^active=true` })) {
        if (!sys.count('cmn_rota_member', `roster=${roster.sysId}^member=${span.str('user')}`)) continue;
        sys.insert('roster_schedule_span', {
          schedule: rota.str('schedule'),
          type: 'on_call',
          show_as: 'on_call',
          group: rota.str('group'),
          roster: roster.sysId,
          user: cover,
          state: 'approved',
          name: `Cover for ${span.display('user')}`,
          start_date_time: span.str('start_date_time'),
          end_date_time: span.str('end_date_time'),
          all_day: span.bool('all_day'),
        });
        created++;
      }
    }
  }
  sys.queueEvent(ONCALL_EVENTS.timeoffApproved, span, span.str('user'), String(created));
  return created;
}
