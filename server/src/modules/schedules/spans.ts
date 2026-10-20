import type { Rec } from '../../engine/record.js';
import {
  civil,
  DAY,
  dayFromYmd,
  dayOf,
  daysInMonth,
  isoWeekday,
  type LocalDateTime,
  localMs,
  parseLocal,
} from './time.js';

/** Monthly "nth weekday" options (glide.schedules.repeat_nth / glide.schedules.fifth). */
export interface RepeatOptions {
  nth: 'day' | 'week';
  fifth: 'last' | 'next' | 'strict';
}

export const DEFAULT_REPEAT_OPTIONS: RepeatOptions = { nth: 'day', fifth: 'last' };

/** A schedule entry reduced to what occurrence expansion needs. */
export interface SpanDef {
  id: string;
  type: string;
  parent: string | null;
  /** Day number of the parent occurrence this entry replaces. */
  overrideDay: number | null;
  allDay: boolean;
  start: LocalDateTime | null;
  /** Wall-clock length of one occurrence in ms. */
  lengthMs: number;
  repeat: string;
  every: number;
  /** ISO weekdays (1 = Monday). */
  daysOfWeek: Set<number>;
  monthlyType: string;
  yearlyType: string;
  floatWeek: string;
  /** 1 = Sunday ... 7 = Saturday (the float_day numbering). */
  floatDay: number;
  month: number | null;
  until: number | null;
}

/** Builds a SpanDef from a cmn_schedule_span record (or a subclass). */
export function spanFromRecord(rec: Rec): SpanDef {
  const start = parseLocal(rec.str('start_date_time'));
  const end = parseLocal(rec.str('end_date_time'));
  const allDay = rec.bool('all_day');
  let lengthMs = 0;
  if (start) {
    if (allDay) lengthMs = Math.max(1, (end ? end.day : start.day) - start.day + 1) * DAY;
    else if (end) lengthMs = localMs(end) - localMs(start);
  }
  const dows = new Set<number>();
  for (const ch of rec.str('days_of_week')) {
    const n = Number(ch);
    if (n >= 1 && n <= 7) dows.add(n);
  }
  const until = rec.num('repeat_until');
  return {
    id: rec.sysId,
    type: rec.str('type'),
    parent: rec.str('parent') || null,
    overrideDay: dayFromYmd(rec.str('override_start_date')),
    allDay,
    start: start && allDay ? { day: start.day, sec: 0 } : start,
    lengthMs,
    repeat: rec.str('repeat_type'),
    every: Math.max(1, Number.parseInt(rec.str('repeat_count'), 10) || 1),
    daysOfWeek: dows,
    monthlyType: rec.str('monthly_type') || 'dom',
    yearlyType: rec.str('yearly_type') || 'doy',
    floatWeek: rec.str('float_week') || '1',
    floatDay: Number(rec.str('float_day')) || 1,
    month: Number(rec.str('month')) || null,
    until: until ? dayFromYmd(String(until)) : null,
  };
}

/** Occurrence index of a date's weekday within its month (1 = first). */
function weekdayIndex(day: number): number {
  return Math.ceil(civil(day).d / 7);
}

function weekdayCount(y: number, m: number, isoDow: number): number {
  const first = dayOf(y, m, 1);
  const offset = (isoDow - isoWeekday(first) + 7) % 7;
  return Math.floor((daysInMonth(y, m) - 1 - offset) / 7) + 1;
}

/** Row of the date in a month calendar whose weeks start on Sunday (1-based). */
function weekRow(day: number): number {
  const c = civil(day);
  const firstSun0 = isoWeekday(dayOf(c.y, c.m, 1)) % 7;
  return Math.floor((c.d - 1 + firstSun0) / 7) + 1;
}

function monthsBetween(a: number, b: number): number {
  const ca = civil(a);
  const cb = civil(b);
  return (cb.y - ca.y) * 12 + (cb.m - ca.m);
}

function isLastOfItsWeekday(day: number): boolean {
  const c = civil(day);
  return c.d + 7 > daysInMonth(c.y, c.m);
}

function monthlyOccurs(s: SpanDef, d: number, d0: number, opts: RepeatOptions): boolean {
  const diff = monthsBetween(d0, d);
  // The entry's start is its first occurrence; the rule applies from the next month on.
  if (diff === 0) return d === d0;
  const onMonth = (k: number) => k >= 0 && k % s.every === 0;
  const c = civil(d);
  switch (s.monthlyType) {
    case 'ldom':
      return c.d === daysInMonth(c.y, c.m) && onMonth(diff);
    case 'lwdom':
      return isoWeekday(d) === isoWeekday(d0) && isLastOfItsWeekday(d) && onMonth(diff);
    case 'nth': {
      const dow = isoWeekday(d0);
      if (isoWeekday(d) !== dow) return false;
      const n = opts.nth === 'week' ? weekRow(d0) : weekdayIndex(d0);
      const idx = weekdayIndex(d);
      if (onMonth(diff)) {
        const count = weekdayCount(c.y, c.m, dow);
        if (n <= count && idx === n) return true;
        const mode = opts.nth === 'week' ? 'last' : opts.fifth;
        if (n > count && mode === 'last' && idx === count) return true;
      }
      if (opts.nth === 'day' && opts.fifth === 'next' && idx === 1 && onMonth(diff - 1)) {
        const prevY = c.m === 1 ? c.y - 1 : c.y;
        const prevM = c.m === 1 ? 12 : c.m - 1;
        return n > weekdayCount(prevY, prevM, dow);
      }
      return false;
    }
    default:
      return c.d === civil(d0).d && onMonth(diff);
  }
}

function yearlyOccurs(s: SpanDef, d: number, d0: number): boolean {
  const c = civil(d);
  const c0 = civil(d0);
  const diff = c.y - c0.y;
  if (diff === 0) return d === d0;
  if (diff < 0 || diff % s.every !== 0) return false;
  if (s.yearlyType !== 'float') return c.m === c0.m && c.d === c0.d;
  if (c.m !== (s.month ?? c0.m)) return false;
  const dow = ((s.floatDay + 5) % 7) + 1;
  if (isoWeekday(d) !== dow) return false;
  if (s.floatWeek === 'last') return isLastOfItsWeekday(d);
  return weekdayIndex(d) === Number(s.floatWeek);
}

/** Whether a repeating entry has an occurrence starting on local date `d`. */
export function occursOn(s: SpanDef, d: number, opts: RepeatOptions = DEFAULT_REPEAT_OPTIONS): boolean {
  if (!s.start) return false;
  const d0 = s.start.day;
  if (d < d0) return false;
  const dow = isoWeekday(d);
  switch (s.repeat) {
    case 'daily':
      return (d - d0) % s.every === 0;
    case 'weekdays':
      return dow <= 5;
    case 'weekends':
      return dow >= 6;
    case 'weekMWF':
      return dow === 1 || dow === 3 || dow === 5;
    case 'weekTT':
      return dow === 2 || dow === 4;
    case 'weekly': {
      const days = s.daysOfWeek.size ? s.daysOfWeek : new Set([isoWeekday(d0)]);
      if (!days.has(dow)) return false;
      const weeks = (d - dow + 1 - (d0 - isoWeekday(d0) + 1)) / 7;
      return weeks % s.every === 0;
    }
    case 'monthly':
      return monthlyOccurs(s, d, d0, opts);
    case 'yearly':
      return yearlyOccurs(s, d, d0);
    default:
      return d === d0;
  }
}

/**
 * Local wall-clock occurrences `[start, end)` of an entry whose start date lies in
 * `[fromDay - length, toDay]`, skipping dates replaced by override entries.
 */
export function occurrences(
  s: SpanDef,
  fromDay: number,
  toDay: number,
  suppressed: ReadonlySet<number> | undefined,
  opts: RepeatOptions = DEFAULT_REPEAT_OPTIONS,
): [number, number][] {
  if (!s.start || s.lengthMs <= 0) return [];
  const out: [number, number][] = [];
  const startSec = s.start.sec * 1000;
  const first = Math.max(s.start.day, fromDay - Math.ceil(s.lengthMs / DAY));
  if (!s.repeat || s.repeat === 'specific') {
    const d = s.start.day;
    if (d >= first && d <= toDay && !suppressed?.has(d))
      out.push([d * DAY + startSec, d * DAY + startSec + s.lengthMs]);
    return out;
  }
  for (let d = first; d <= toDay; d++) {
    if (s.until !== null && d > s.until) break;
    if (suppressed?.has(d) || !occursOn(s, d, opts)) continue;
    out.push([d * DAY + startSec, d * DAY + startSec + s.lengthMs]);
  }
  return out;
}
