/**
 * Time-zone-aware calendar arithmetic for encoded queries.
 *
 * Stored date-times are UTC `YYYY-MM-DD HH:MM:SS` strings. Query bounds such as
 * "today" or "this week" are defined in the session user's time zone, so they are
 * computed on local calendar fields and converted back to UTC instants here.
 * Only the platform's Intl time zone database is used; no third-party library.
 */

const DAY = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export type CalendarUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface LocalParts {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0 = Sunday ... 6 = Saturday */
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    f = null;
  }
  formatters.set(tz, f);
  return f;
}

/** Returns a usable IANA zone name, or null for UTC, empty or unknown zones. */
export function normalizeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const t = String(tz).trim();
  if (!t || /^(utc|gmt|z|etc\/utc|etc\/gmt|etc\/uct|uct|universal|zulu)$/i.test(t)) return null;
  return formatter(t) ? t : null;
}

/** Offset in milliseconds of `tz` at the UTC instant `ms` (local = utc + offset). */
export function zoneOffset(tz: string | null, ms: number): number {
  if (!tz) return 0;
  const f = formatter(tz);
  if (!f) return 0;
  const secs = Math.floor(ms / 1000) * 1000;
  let y = 0;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of f.formatToParts(new Date(secs))) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        h = Number(p.value) % 24;
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        s = Number(p.value);
        break;
      default:
        break;
    }
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - secs;
}

/** Local calendar fields of a UTC instant. */
export function toLocal(ms: number, tz: string | null): LocalParts {
  const d = new Date(ms + zoneOffset(tz, ms));
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    dow: d.getUTCDay(),
  };
}

/**
 * UTC instant of a local wall-clock time. Out-of-range fields roll over (day 32 is the
 * 1st of the next month). Times inside a daylight-saving gap resolve to the earlier offset.
 */
export function fromLocal(tz: string | null, y: number, m: number, d = 1, h = 0, mi = 0, s = 0): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  if (!tz) return guess;
  const off1 = zoneOffset(tz, guess);
  let t = guess - off1;
  const off2 = zoneOffset(tz, t);
  if (off2 !== off1) {
    const t2 = guess - off2;
    if (zoneOffset(tz, t2) === off2) t = t2;
  }
  return t;
}

export function glide(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
}

/** Local wall-clock rendering of a UTC instant, `YYYY-MM-DD HH:MM:SS`. */
export function localGlide(ms: number, tz: string | null): string {
  const p = toLocal(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

export function localDate(ms: number, tz: string | null): string {
  return localGlide(ms, tz).slice(0, 10);
}

/** Parses a stored UTC value (`YYYY-MM-DD[ HH:MM:SS]`) to epoch milliseconds. */
export function parseUtc(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v).trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Adds calendar months to local fields, clamping the day to the target month's length. */
function addMonthsLocal(p: LocalParts, n: number): { y: number; m: number; d: number } {
  const idx = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return { y, m, d: Math.min(p.d, daysInMonth(y, m)) };
}

/** `ms` shifted by `n` units, using local calendar arithmetic for day-based and month-based units. */
export function addUnits(ms: number, tz: string | null, unit: CalendarUnit, n: number): number {
  switch (unit) {
    case 'second':
      return ms + n * 1000;
    case 'minute':
      return ms + n * 60_000;
    case 'hour':
      return ms + n * 3_600_000;
    case 'day':
    case 'week': {
      const p = toLocal(ms, tz);
      return fromLocal(tz, p.y, p.m, p.d + n * (unit === 'week' ? 7 : 1), p.h, p.mi, p.s);
    }
    default: {
      const p = toLocal(ms, tz);
      const months = unit === 'month' ? n : unit === 'quarter' ? 3 * n : 12 * n;
      const t = addMonthsLocal(p, months);
      return fromLocal(tz, t.y, t.m, t.d, p.h, p.mi, p.s);
    }
  }
}

/** Start of the local unit bucket containing `ms`. Weeks start on `firstDow` (0 = Sunday, 1 = Monday). */
export function startOf(ms: number, tz: string | null, unit: CalendarUnit, firstDow = 1): number {
  const p = toLocal(ms, tz);
  switch (unit) {
    case 'second':
      return Math.floor(ms / 1000) * 1000;
    case 'minute':
      return fromLocal(tz, p.y, p.m, p.d, p.h, p.mi, 0);
    case 'hour':
      return fromLocal(tz, p.y, p.m, p.d, p.h, 0, 0);
    case 'day':
      return fromLocal(tz, p.y, p.m, p.d);
    case 'week':
      return fromLocal(tz, p.y, p.m, p.d - ((p.dow - firstDow + 7) % 7));
    case 'month':
      return fromLocal(tz, p.y, p.m, 1);
    case 'quarter':
      return fromLocal(tz, p.y, Math.floor((p.m - 1) / 3) * 3 + 1, 1);
    default:
      return fromLocal(tz, p.y, 1, 1);
  }
}

/** Last second of the local unit bucket containing `ms`. */
export function endOf(ms: number, tz: string | null, unit: CalendarUnit, firstDow = 1): number {
  const start = startOf(ms, tz, unit, firstDow);
  if (unit === 'second') return start;
  if (unit === 'minute') return start + 59_000;
  if (unit === 'hour') return start + 3_599_000;
  // Step into the middle of the next bucket so DST transitions cannot land us in the same one.
  const next = startOf(addUnits(start, tz, unit, 1) + DAY / 2, tz, unit, firstDow);
  return next - 1000;
}

const UNIT_ALIASES: Record<string, CalendarUnit> = {
  second: 'second',
  seconds: 'second',
  minute: 'minute',
  minutes: 'minute',
  hour: 'hour',
  hours: 'hour',
  day: 'day',
  days: 'day',
  dayofweek: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  quarter: 'quarter',
  quarters: 'quarter',
  year: 'year',
  years: 'year',
};

export function parseUnit(v: string | null | undefined): CalendarUnit | null {
  if (!v) return null;
  return UNIT_ALIASES[v.trim().toLowerCase()] ?? null;
}

// ------------------------------------------------------------------ date parts (DATEPART)

export type DatePart = 'dayofweek' | 'hour' | 'week' | 'month' | 'quarter' | 'year' | 'dayofmonth';

const PART_ALIASES: Record<string, DatePart> = {
  dayofweek: 'dayofweek',
  day_of_week: 'dayofweek',
  weekday: 'dayofweek',
  hour: 'hour',
  hourofday: 'hour',
  hour_of_day: 'hour',
  week: 'week',
  weekofyear: 'week',
  week_of_year: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
  dayofmonth: 'dayofmonth',
  day_of_month: 'dayofmonth',
  day: 'dayofmonth',
};

export function parseDatePart(v: string): DatePart | null {
  return PART_ALIASES[v.trim().toLowerCase()] ?? null;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * Numeric value of a DATEPART operand. Days of the week sort Sunday (1) to Saturday (7),
 * so "before Monday" only matches Sunday. Months are 1-12, quarters 1-4.
 */
export function datePartValue(part: DatePart, raw: string): number | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (part === 'dayofweek') {
    const i = DAY_NAMES.findIndex((n) => n === v || n.slice(0, 3) === v);
    if (i >= 0) return i + 1;
  }
  if (part === 'month') {
    const i = MONTH_NAMES.findIndex((n) => n === v || n.slice(0, 3) === v);
    if (i >= 0) return i + 1;
  }
  if (part === 'quarter') {
    const q = /^q([1-4])$/.exec(v);
    if (q) return Number(q[1]);
  }
  if (part === 'hour') {
    const ampm = /^(\d{1,2})\s*(am|pm)$/.exec(v);
    if (ampm) {
      const h = Number(ampm[1]) % 12;
      return ampm[2] === 'pm' ? h + 12 : h;
    }
  }
  if (!/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  const range: Record<DatePart, [number, number]> = {
    dayofweek: [1, 7],
    hour: [0, 23],
    week: [1, 53],
    month: [1, 12],
    quarter: [1, 4],
    year: [1, 9999],
    dayofmonth: [1, 31],
  };
  const [lo, hi] = range[part];
  return n >= lo && n <= hi ? n : null;
}

/** ISO 8601 week number of a calendar date. */
export function isoWeek(y: number, m: number, d: number): number {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const diff = (date.getTime() - firstThursday.getTime()) / DAY;
  return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** Extracts a date part from local calendar fields. */
export function extractPart(p: LocalParts, part: DatePart): number {
  switch (part) {
    case 'dayofweek':
      return p.dow + 1;
    case 'hour':
      return p.h;
    case 'week':
      return isoWeek(p.y, p.m, p.d);
    case 'month':
      return p.m;
    case 'quarter':
      return Math.floor((p.m - 1) / 3) + 1;
    case 'year':
      return p.y;
    default:
      return p.d;
  }
}

// ------------------------------------------------------------------ SQL helpers

interface Segment {
  /** UTC instant (ms) from which `offset` applies. */
  from: number;
  /** Offset in seconds. */
  offset: number;
}

const segmentCache = new Map<string, Segment[]>();

/**
 * Offset history of a zone over a fixed window (1990 to 2060), found by sampling every
 * three days and bisecting each change down to the minute. Instants outside the
 * window use the nearest segment's offset.
 */
export function zoneSegments(tz: string): Segment[] {
  const hit = segmentCache.get(tz);
  if (hit) return hit;
  const start = Date.UTC(1990, 0, 1);
  const end = Date.UTC(2060, 0, 1);
  const step = 3 * DAY;
  const segs: Segment[] = [{ from: Number.NEGATIVE_INFINITY, offset: zoneOffset(tz, start) / 1000 }];
  let prevT = start;
  let prevOff = zoneOffset(tz, start);
  for (let t = start + step; t <= end; t += step) {
    const off = zoneOffset(tz, t);
    if (off !== prevOff) {
      let lo = prevT;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (mid <= lo) break;
        if (zoneOffset(tz, mid) === prevOff) lo = mid;
        else hi = mid;
      }
      segs.push({ from: hi, offset: off / 1000 });
      prevOff = off;
    }
    prevT = t;
  }
  segmentCache.set(tz, segs);
  return segs;
}

function offsetCase(col: string, segs: Segment[], lo: number, hi: number): string {
  if (lo === hi) return `'${segs[lo].offset >= 0 ? '+' : ''}${segs[lo].offset} seconds'`;
  const mid = Math.ceil((lo + hi + 1) / 2);
  const boundary = glide(segs[mid].from);
  return `(CASE WHEN ${col} < '${boundary}' THEN ${offsetCase(col, segs, lo, mid - 1)} ELSE ${offsetCase(col, segs, mid, hi)} END)`;
}

/**
 * SQL expression converting a UTC date-time column to the user's local wall-clock time.
 * Zones with daylight saving use a balanced CASE tree over the zone's offset history.
 */
export function localSql(col: string, tz: string | null): string {
  if (!tz) return col;
  const segs = zoneSegments(tz);
  if (segs.length === 1) {
    const o = segs[0].offset;
    return o === 0 ? col : `datetime(${col}, '${o >= 0 ? '+' : ''}${o} seconds')`;
  }
  return `datetime(${col}, ${offsetCase(col, segs, 0, segs.length - 1)})`;
}
