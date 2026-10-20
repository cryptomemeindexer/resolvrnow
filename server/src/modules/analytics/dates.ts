import { clock, parseGlideDateTime, toGlideDate, toGlideDateTime } from '../../engine/util.js';
import type { Bucket } from './grouping.js';

/**
 * Calendar helpers for report buckets and daily indicator scores. Days, weeks and months
 * are UTC calendar periods, matching how date-times are stored.
 */

const DAY_MS = 86_400_000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function todayDate(): string {
  return toGlideDate(clock.now());
}

export function addDays(date: string, n: number): string {
  const d = parseGlideDateTime(date)!;
  return toGlideDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + n * DAY_MS));
}

export function dayStart(date: string): string {
  return `${date.slice(0, 10)} 00:00:00`;
}

export function dayEnd(date: string): string {
  return `${date.slice(0, 10)} 23:59:59`;
}

/** Inclusive list of dates (`YYYY-MM-DD`). */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from.slice(0, 10); d <= to.slice(0, 10) && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && parseGlideDateTime(v) !== null;
}

/**
 * Runs `fn` with the platform clock moved to `at`, so relative date macros in conditions
 * (`gs.daysAgoStart(30)`, `gs.nowDateTime()`, "today") evaluate as of a past date.
 * The engine is synchronous, so nothing else observes the shifted clock, and shifting
 * back by the same amount restores both frozen and running clocks exactly.
 */
export function withClockAt<T>(at: string, fn: () => T): T {
  const target = parseGlideDateTime(at);
  if (!target) return fn();
  const delta = target.getTime() - clock.now().getTime();
  if (delta === 0) return fn();
  clock.advance(delta);
  try {
    return fn();
  } finally {
    clock.advance(-delta);
  }
}

// ------------------------------------------------------------------ buckets

function monthKey(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Bucket key of a stored date or date-time (same keys the SQL buckets produce). */
export function bucketKeyOf(bucket: Bucket, value: string): string | null {
  const d = parseGlideDateTime(value);
  if (!d) return null;
  const date = toGlideDate(d);
  switch (bucket) {
    case 'date':
      return date;
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7;
      return addDays(date, -dow);
    }
    case 'month':
      return date.slice(0, 7);
    case 'quarter':
      return `${date.slice(0, 4)}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case 'year':
      return date.slice(0, 4);
    case 'dayofweek':
      return String(d.getUTCDay() + 1);
    case 'hour':
      return String(d.getUTCHours()).padStart(2, '0');
  }
}

/** UTC start (inclusive) and end (exclusive) of a calendar bucket; null for cyclic buckets. */
export function bucketRange(bucket: Bucket, key: string): { start: string; end: string } | null {
  switch (bucket) {
    case 'date':
      return isValidDate(key) ? { start: key, end: addDays(key, 1) } : null;
    case 'week':
      return isValidDate(key) ? { start: key, end: addDays(key, 7) } : null;
    case 'month': {
      const m = /^(\d{4})-(\d{2})$/.exec(key);
      if (!m) return null;
      return { start: `${monthKey(+m[1], +m[2])}-01`, end: `${monthKey(+m[1], +m[2] + 1)}-01` };
    }
    case 'quarter': {
      const m = /^(\d{4})-Q([1-4])$/.exec(key);
      if (!m) return null;
      const first = (+m[2] - 1) * 3 + 1;
      return { start: `${monthKey(+m[1], first)}-01`, end: `${monthKey(+m[1], first + 3)}-01` };
    }
    case 'year':
      return /^\d{4}$/.test(key) ? { start: `${key}-01-01`, end: `${Number(key) + 1}-01-01` } : null;
    default:
      return null;
  }
}

/** Every bucket key from `from` to `to` inclusive (calendar buckets only), capped at `max`. */
export function bucketSequence(bucket: Bucket, from: string, to: string, max = 400): string[] | null {
  if (bucket === 'dayofweek') return ['1', '2', '3', '4', '5', '6', '7'];
  if (bucket === 'hour') return Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const out: string[] = [];
  let key: string | null = from;
  while (key && key <= to) {
    out.push(key);
    if (out.length > max) return null;
    const r = bucketRange(bucket, key);
    if (!r) return null;
    key = bucketKeyOf(bucket, r.end);
  }
  return out;
}

export function bucketLabel(bucket: Bucket, key: string): string {
  if (bucket === 'dayofweek') return DAY_NAMES[Number(key) - 1] ?? key;
  if (bucket === 'hour') return `${key}:00`;
  return key;
}

/** Lower-case day name for DATEPART drilldowns. */
export function dayName(key: string): string | null {
  return DAY_NAMES[Number(key) - 1]?.toLowerCase() ?? null;
}

export function nowGlideTime(): string {
  return toGlideDateTime(clock.now());
}
