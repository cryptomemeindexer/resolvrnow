import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { parseGlideDateTime, toGlideDateTime } from '../../engine/util.js';
import { T } from './constants.js';
import { DAY_MS, schedulesOf } from './util.js';

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

export function toMs(glide: string | null | undefined): number | null {
  const d = parseGlideDateTime(glide);
  return d ? d.getTime() : null;
}

export function toGlide(ms: number): string {
  return toGlideDateTime(new Date(ms));
}

export function overlaps(a: Interval, b: Interval, contiguousAllowed = true): boolean {
  return contiguousAllowed ? a.start < b.end && b.start < a.end : a.start <= b.end && b.start <= a.end;
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  let out = mergeIntervals(base);
  for (const r of mergeIntervals(remove)) {
    const next: Interval[] = [];
    for (const i of out) {
      if (r.end <= i.start || r.start >= i.end) {
        next.push(i);
        continue;
      }
      if (r.start > i.start) next.push({ start: i.start, end: r.start });
      if (r.end < i.end) next.push({ start: r.end, end: i.end });
    }
    out = next;
  }
  return out;
}

// --------------------------------------------------------------- span expansion

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** Parses span values: `YYYYMMDDTHHMMSS`, `YYYYMMDD` or `YYYY-MM-DD HH:MM:SS`. */
export function parseSpanDate(v: string | null | undefined): LocalParts | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$/.exec(s);
  if (!m) m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
}

/** Local wall-clock parts as if they were UTC (a "naive" timestamp for calendar arithmetic). */
function naive(p: LocalParts): number {
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function offsetMs(tz: string, utcMs: number): number {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  return asUtc - utcMs;
}

/** Converts a naive local timestamp in `tz` to UTC epoch milliseconds. */
export function naiveToUtc(naiveMs: number, tz: string | null | undefined): number {
  if (!tz || /^(floating|utc|gmt|etc\/utc)$/i.test(tz)) return naiveMs;
  try {
    const first = naiveMs - offsetMs(tz, naiveMs);
    return naiveMs - offsetMs(tz, first);
  } catch {
    return naiveMs;
  }
}

function isoDow(dayMs: number): number {
  const d = new Date(dayMs).getUTCDay();
  return d === 0 ? 7 : d;
}

function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function occursOn(span: Rec, day: number, firstDay: number): boolean {
  const repeat = span.str('repeat_type');
  const every = Math.max(1, Number.parseInt(span.str('repeat_count') || '1', 10) || 1);
  const dow = isoDow(day);
  switch (repeat) {
    case '':
      return day === firstDay;
    case 'daily':
      return Math.round((day - firstDay) / DAY_MS) % every === 0;
    case 'weekdays':
      return dow <= 5;
    case 'weekends':
      return dow >= 6;
    case 'weekMWF':
      return dow === 1 || dow === 3 || dow === 5;
    case 'weekTT':
      return dow === 2 || dow === 4;
    case 'weekly': {
      const days = span.str('days_of_week') || String(isoDow(firstDay));
      if (!days.includes(String(dow))) return false;
      const weekOf = (ms: number) => ms - (isoDow(ms) - 1) * DAY_MS;
      return Math.round((weekOf(day) - weekOf(firstDay)) / (7 * DAY_MS)) % every === 0;
    }
    case 'monthly': {
      const a = new Date(firstDay);
      const b = new Date(day);
      const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
      return b.getUTCDate() === a.getUTCDate() && months % every === 0;
    }
    case 'yearly': {
      const a = new Date(firstDay);
      const b = new Date(day);
      return (
        b.getUTCMonth() === a.getUTCMonth() &&
        b.getUTCDate() === a.getUTCDate() &&
        (b.getUTCFullYear() - a.getUTCFullYear()) % every === 0
      );
    }
    default:
      return day === firstDay;
  }
}

/**
 * Occurrences of a schedule entry overlapping [from, to). Supports one-off entries and
 * daily, weekday, weekend, weekly, monthly (same day of month) and yearly repeats.
 */
export function expandSpan(span: Rec, tz: string | null, from: number, to: number): Interval[] {
  const startParts = parseSpanDate(span.str('start_date_time'));
  if (!startParts) return [];
  const endParts = parseSpanDate(span.str('end_date_time'));
  let s0 = naive(startParts);
  let e0 = endParts ? naive(endParts) : s0 + DAY_MS;
  if (span.bool('all_day')) {
    s0 = startOfDay(s0);
    e0 = startOfDay(endParts ? naive(endParts) : s0) + DAY_MS;
  }
  const length = e0 - s0;
  if (length <= 0) return [];
  const firstDay = startOfDay(s0);
  const timeOfDay = s0 - firstDay;
  const untilRaw = span.str('repeat_until');
  const until =
    /^\d{8}$/.test(untilRaw) && untilRaw !== '00000000'
      ? naive(parseSpanDate(untilRaw)!)
      : Number.POSITIVE_INFINITY;
  const out: Interval[] = [];
  const push = (startNaive: number) => {
    const start = naiveToUtc(startNaive, tz);
    const end = naiveToUtc(startNaive + length, tz);
    if (start < to && end > from) out.push({ start, end });
  };
  if (!span.str('repeat_type')) {
    push(s0);
    return out;
  }
  // Walk local days that can produce an occurrence overlapping the range (12h slack for zones).
  const firstCandidate = Math.max(firstDay, startOfDay(from - length - DAY_MS / 2));
  const lastCandidate = startOfDay(to + DAY_MS / 2);
  for (let day = firstCandidate; day <= lastCandidate; day += DAY_MS) {
    if (day > until) break;
    if (occursOn(span, day, firstDay)) push(day + timeOfDay);
  }
  return out;
}

/**
 * Included time of a schedule over [from, to): included entries minus excluded entries,
 * clipped to the range unless `clip` is false (calendar display).
 */
export function scheduleIntervals(
  ctx: Context,
  scheduleId: string,
  from: number,
  to: number,
  clip = true,
): Interval[] {
  const sys = ctx.elevated();
  const schedule = sys.get(T.schedule, scheduleId);
  if (!schedule) return [];
  const tz = schedule.str('time_zone') || ctx.platform.properties.get('glide.sys.default.tz', 'UTC') || 'UTC';
  const spans = sys.query(T.span, `schedule=${scheduleId}`);
  const included: Interval[] = [];
  const excluded: Interval[] = [];
  for (const span of spans) {
    const list = expandSpan(span, tz, from, to);
    if (span.str('type') === 'exclude') excluded.push(...list);
    else included.push(...list);
  }
  const out = subtractIntervals(included, excluded);
  return clip ? out.map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) })) : out;
}

/** True when any part of the window falls inside the schedule. */
export function windowTouchesSchedule(ctx: Context, scheduleId: string, start: number, end: number): boolean {
  const svc = schedulesOf(ctx.platform);
  if (svc) {
    try {
      return svc.businessMs(ctx.elevated(), scheduleId, toGlide(start), toGlide(end)) > 0;
    } catch {
      // fall back to the local evaluation
    }
  }
  return scheduleIntervals(ctx, scheduleId, start, end).length > 0;
}

/** True when the whole window lies inside the schedule. */
export function windowInsideSchedule(ctx: Context, scheduleId: string, start: number, end: number): boolean {
  const svc = schedulesOf(ctx.platform);
  if (svc) {
    try {
      return svc.businessMs(ctx.elevated(), scheduleId, toGlide(start), toGlide(end)) >= end - start - 1000;
    } catch {
      // fall back to the local evaluation
    }
  }
  const merged = mergeIntervals(scheduleIntervals(ctx, scheduleId, start, end));
  return merged.some((i) => i.start <= start && i.end >= end);
}
