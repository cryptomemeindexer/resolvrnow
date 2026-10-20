import type { Rec } from '../../engine/record.js';
import {
  civil,
  DAY,
  dayFromYmd,
  dayOf,
  daysInMonth,
  isoWeekday,
  localDay,
  toUtc,
} from '../schedules/time.js';

/** How a roster hands the duty over (on-call.md section 4.2). */
export interface RotationSpec {
  type: 'daily' | 'weekly' | 'monthly';
  every: number;
  /** ISO weekday of the weekly hand-over (1 = Monday). */
  dayOfWeek: number;
  monthDayType: 'last_day' | 'specific_day';
  monthDay: number;
  /** Local date of the first slot. */
  startDay: number;
  /** Local time of day of every hand-over, in seconds. */
  startSec: number;
}

export interface MemberRow {
  id: string;
  user: string;
  order: number;
  /** First local day the member is on the roster (inclusive). */
  from: number | null;
  /** First local day the member is no longer on the roster (exclusive). */
  to: number | null;
}

function parseTime(v: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(v.trim());
  return m ? +m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0) : 0;
}

export function rotationOf(roster: Rec, dailyAtMidnight: boolean): RotationSpec | null {
  const startDay = dayFromYmd(roster.str('rotation_start_date'));
  if (startDay === null) return null;
  const raw = roster.str('rotation_interval_type');
  const type = raw === 'daily' || raw === 'monthly' ? raw : 'weekly';
  const midnight = roster.bool('rotation_all_day') || (type === 'daily' && dailyAtMidnight);
  return {
    type,
    every: Math.max(1, roster.num('rotation_interval_count') ?? 1),
    dayOfWeek: Number(roster.str('rotation_day_of_week')) || isoWeekday(startDay),
    monthDayType: roster.str('rotation_month_day_type') === 'specific_day' ? 'specific_day' : 'last_day',
    monthDay: Math.min(31, Math.max(1, roster.num('rotation_day') ?? 1)),
    startDay,
    startSec: midnight ? 0 : parseTime(roster.str('rotation_start_time') || '00:00:00'),
  };
}

function monthIndex(day: number): number {
  const c = civil(day);
  return c.y * 12 + (c.m - 1);
}

function anchorOf(spec: RotationSpec, month: number): number {
  const y = Math.floor(month / 12);
  const m = (month % 12) + 1;
  const last = daysInMonth(y, m);
  return dayOf(y, m, spec.monthDayType === 'last_day' ? last : Math.min(spec.monthDay, last));
}

/** Local date of hand-over `k` (k = 0 is the rotation start). */
export function boundaryDay(spec: RotationSpec, k: number): number {
  if (k <= 0) return spec.startDay;
  if (spec.type === 'daily') return spec.startDay + k * spec.every;
  if (spec.type === 'weekly') {
    const a0 = spec.startDay + ((spec.dayOfWeek - isoWeekday(spec.startDay) + 7) % 7);
    const skip = a0 === spec.startDay ? 1 : 0;
    return a0 + 7 * spec.every * (skip + k - 1);
  }
  let m0 = monthIndex(spec.startDay);
  if (anchorOf(spec, m0) < spec.startDay) m0++;
  const skip = anchorOf(spec, m0) === spec.startDay ? 1 : 0;
  return anchorOf(spec, m0 + spec.every * (skip + k - 1));
}

export function boundaryInstant(spec: RotationSpec, k: number, zone: string): number {
  return toUtc(zone, boundaryDay(spec, k) * DAY + spec.startSec * 1000);
}

/** Largest slot index whose hand-over is at or before `t`; -1 before the rotation starts. */
export function slotAt(spec: RotationSpec, zone: string, t: number): number {
  if (t < boundaryInstant(spec, 0, zone)) return -1;
  let lo = 0;
  let hi = Math.max(0, localDay(zone, t) - spec.startDay + 2);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (boundaryInstant(spec, mid, zone) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Smallest slot index whose hand-over date is on or after `day`. */
export function firstSlotFrom(spec: RotationSpec, day: number): number {
  if (day <= spec.startDay) return 0;
  let lo = 0;
  let hi = day - spec.startDay + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (boundaryDay(spec, mid) >= day) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const byOrder = (a: MemberRow, b: MemberRow): number =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Members on the roster on a local date: one row per user (latest start wins), by order. */
export function eligible(members: MemberRow[], day: number): MemberRow[] {
  const byUser = new Map<string, MemberRow>();
  for (const m of members) {
    if (m.from !== null && m.from > day) continue;
    if (m.to !== null && day >= m.to) continue;
    const cur = byUser.get(m.user);
    if (!cur || (m.from ?? Number.NEGATIVE_INFINITY) > (cur.from ?? Number.NEGATIVE_INFINITY))
      byUser.set(m.user, m);
  }
  return [...byUser.values()].sort(byOrder);
}

/** The member after `prev` in roster order, wrapping; the first member when there was none. */
export function successor(list: MemberRow[], prev: MemberRow | null): MemberRow | null {
  if (!list.length) return null;
  if (!prev) return list[0];
  return list.find((m) => byOrder(m, prev) > 0) ?? list[0];
}

function advance(list: MemberRow[], from: MemberRow | null, steps: number): MemberRow | null {
  if (!from || !list.length) return null;
  const i = Math.max(0, list.indexOf(from));
  return list[(i + steps) % list.length];
}

/**
 * Holder of slot `k`: each turn passes to the next member after the previous holder. Runs of
 * slots with unchanged membership are skipped arithmetically, so the cost follows membership
 * changes rather than the number of slots.
 */
export function holderAt(spec: RotationSpec, members: MemberRow[], k: number): MemberRow | null {
  if (k < 0) return null;
  const changes = [
    ...new Set(members.flatMap((m) => [m.from, m.to]).filter((d): d is number => d !== null)),
  ].sort((a, b) => a - b);
  let i = 0;
  let list = eligible(members, boundaryDay(spec, 0));
  let holder: MemberRow | null = list[0] ?? null;
  while (i < k) {
    const day = boundaryDay(spec, i);
    const next = changes.find((c) => c > day);
    const changeSlot = next === undefined ? Number.POSITIVE_INFINITY : firstSlotFrom(spec, next);
    if (k < changeSlot) return advance(list, holder, k - i);
    const prev = advance(list, holder, changeSlot - 1 - i);
    i = changeSlot;
    list = eligible(members, boundaryDay(spec, i));
    holder = successor(list, prev);
  }
  return holder;
}

export function memberFromRecord(rec: Rec): MemberRow {
  return {
    id: rec.sysId,
    user: rec.str('member'),
    order: rec.num('order') ?? 100,
    from: dayFromYmd(rec.str('from')),
    to: dayFromYmd(rec.str('to')),
  };
}
