import type { Context } from '../../engine/context.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { scheduleEngine } from './engine.js';
import { formatLocal, isValidZone, parseLocal } from './time.js';

const WINDOW_TYPES = new Set(['maintenance', 'blackout']);

/** Schedule ids in the tree of `scheduleId`: itself, its parent chain and its child schedules. */
function treeOf(ctx: Context, scheduleId: string): string[] {
  const seen = new Set<string>();
  const stack = [scheduleId];
  while (stack.length) {
    const id = stack.pop()!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = ctx.platform.db.get<{ parent: string | null }>(
      `SELECT "parent" FROM "cmn_schedule" WHERE "sys_id" = ?`,
      [id],
    );
    if (row?.parent) stack.push(row.parent);
    for (const l of ctx.platform.db.all<{ child_schedule: string }>(
      `SELECT "child_schedule" FROM "cmn_other_schedule" WHERE "schedule" = ?`,
      [id],
    )) {
      stack.push(l.child_schedule);
    }
  }
  return [...seen];
}

export const schedulesRules: BusinessRuleDef[] = [
  {
    name: 'Schedule entry: normalise date-times',
    table: 'cmn_schedule_span',
    when: 'before',
    actions: ['insert', 'update'],
    order: 10,
    run(cur) {
      for (const f of ['start_date_time', 'end_date_time']) {
        const raw = cur.str(f);
        if (!raw) continue;
        const v = parseLocal(raw);
        if (!v) {
          cur.abort(`Invalid ${f.replace(/_/g, ' ')} '${raw}': use YYYYMMDDTHHMMSS`);
          return;
        }
        const dateOnly = /^\d{8}$|^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
        if (dateOnly && cur.isNew() && !cur.touched.has('all_day')) cur.setRaw('all_day', 1);
        const norm = formatLocal(v);
        if (norm !== raw) cur.setRaw(f, norm);
      }
      const s = parseLocal(cur.str('start_date_time'));
      const e = parseLocal(cur.str('end_date_time'));
      if (s && e && !cur.bool('all_day') && e.day * 86400 + e.sec <= s.day * 86400 + s.sec) {
        cur.abort('The end of a schedule entry must be after its start');
      }
    },
  },
  {
    name: 'Schedule entry: maintenance and blackout windows cannot be mixed',
    table: 'cmn_schedule_span',
    when: 'before',
    actions: ['insert', 'update'],
    order: 20,
    condition: (cur) =>
      WINDOW_TYPES.has(cur.str('type')) && (cur.isNew() || cur.changed('type') || cur.changed('schedule')),
    run(cur, _prev, ctx) {
      const engine = scheduleEngine(ctx.platform);
      const scheduleId = cur.str('schedule');
      if (!engine || !scheduleId) return;
      const other = cur.str('type') === 'maintenance' ? 'blackout' : 'maintenance';
      const conflict = treeOf(ctx, scheduleId).some((id) =>
        engine.entries(id).some((e) => e.span.id !== cur.sysId && e.span.type === other),
      );
      if (conflict)
        cur.abort(`A schedule tree cannot contain both maintenance and blackout entries (found ${other})`);
    },
  },
  {
    name: 'Schedule: validate time zone and parent',
    table: 'cmn_schedule',
    when: 'before',
    actions: ['insert', 'update'],
    order: 10,
    run(cur, _prev, ctx) {
      const zone = cur.str('time_zone');
      if (zone && zone !== 'floating' && !isValidZone(zone)) {
        cur.abort(`Unknown time zone '${zone}'`);
        return;
      }
      const parent = cur.str('parent');
      if (!parent || (!cur.isNew() && !cur.changed('parent'))) return;
      if (parent === cur.sysId || treeOf(ctx, parent).includes(cur.sysId)) {
        cur.abort('A schedule cannot be its own parent');
        return;
      }
      const engine = scheduleEngine(ctx.platform);
      if (engine && !engine.hasIncludedTime(parent)) {
        cur.abort(
          'The parent schedule has no active entries: a parent made only of exclusions is not allowed',
        );
      }
    },
  },
  {
    name: 'Schedule: warn when there are no active entries',
    table: 'cmn_schedule',
    when: 'after',
    actions: ['update'],
    run(cur, _prev, ctx) {
      const engine = scheduleEngine(ctx.platform);
      if (engine && !engine.hasIncludedTime(cur.sysId))
        ctx.addInfoMessage(`Schedule '${cur.str('name')}' has no active entries`);
    },
  },
  {
    name: 'Child schedule: prevent self links',
    table: 'cmn_other_schedule',
    when: 'before',
    actions: ['insert', 'update'],
    run(cur, _prev, ctx) {
      const parent = cur.str('schedule');
      const child = cur.str('child_schedule');
      if (parent && child && (parent === child || treeOf(ctx, child).includes(parent))) {
        cur.abort('A schedule cannot include itself as a child schedule');
      }
    },
  },
];
