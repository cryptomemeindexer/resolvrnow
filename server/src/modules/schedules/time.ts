/**
 * Calendar and time-zone arithmetic for schedules.
 *
 * Instants are UTC milliseconds. A "local" value is a wall-clock time in some zone
 * expressed as milliseconds as if that wall clock were UTC; a "day" is the number of
 * whole days since 1970-01-01 of a local calendar date.
 */

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

export function dayOf(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

export function civil(day: number): CivilDate {
  const dt = new Date(day * DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (((idx % 12) + 12) % 12) + 1 };
}

/** `20250305` → day number; null for 0/empty/invalid. */
export function dayFromYmd(v: unknown): number | null {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m) return null;
  return dayOf(+m[1], +m[2], +m[3]);
}

export function ymdOf(day: number): string {
  const c = civil(day);
  return `${c.y}${pad(c.m)}${pad(c.d)}`;
}

export function isoDateOf(day: number): string {
  const c = civil(day);
  return `${c.y}-${pad(c.m)}-${pad(c.d)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export interface LocalDateTime {
  day: number;
  /** Seconds since local midnight. */
  sec: number;
}

/**
 * Parses a schedule entry date-time: `YYYYMMDDTHHMMSS`, `YYYYMMDD`, `YYYY-MM-DD HH:MM:SS`
 * or `YYYY-MM-DD` (wall clock, no zone).
 */
export function parseLocal(v: unknown): LocalDateTime | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$/.exec(s);
  if (!m) m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return { day: dayOf(+y, +mo, +d), sec: +h * 3600 + +mi * 60 + +se };
}

/** Canonical stored form `YYYYMMDDTHHMMSS`. */
export function formatLocal(v: LocalDateTime): string {
  const h = Math.floor(v.sec / 3600);
  const mi = Math.floor((v.sec % 3600) / 60);
  const s = v.sec % 60;
  return `${ymdOf(v.day)}T${pad(h)}${pad(mi)}${pad(s)}`;
}

export function localMs(v: LocalDateTime): number {
  return v.day * DAY + v.sec * 1000;
}

// ------------------------------------------------------------------ zones

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Z', 'Etc/Universal', 'Universal']);
const formatters = new Map<string, Intl.DateTimeFormat>();
const invalidZones = new Set<string>();
const offsetMemo = new Map<string, number>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone || zone === 'floating') return false;
  if (UTC_ZONES.has(zone)) return true;
  if (invalidZones.has(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    invalidZones.add(zone);
    return false;
  }
}

/** Offset of `zone` at instant `t` (local wall clock minus UTC), in ms. */
export function offsetAt(zone: string, t: number): number {
  if (UTC_ZONES.has(zone)) return 0;
  const sec = Math.floor(t / 1000);
  const key = `${zone}|${sec}`;
  const hit = offsetMemo.get(key);
  if (hit !== undefined) return hit;
  let y = 1970;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of formatter(zone).formatToParts(new Date(sec * 1000))) {
    if (p.type === 'year') y = +p.value;
    else if (p.type === 'month') mo = +p.value;
    else if (p.type === 'day') d = +p.value;
    else if (p.type === 'hour') h = +p.value % 24;
    else if (p.type === 'minute') mi = +p.value;
    else if (p.type === 'second') s = +p.value;
  }
  const off = Date.UTC(y, mo - 1, d, h, mi, s) - sec * 1000;
  if (offsetMemo.size > 200_000) offsetMemo.clear();
  offsetMemo.set(key, off);
  return off;
}

export function toLocal(zone: string, t: number): number {
  return t + offsetAt(zone, t);
}

/**
 * Local wall clock to UTC. An ambiguous time (fall-back overlap) takes the earlier,
 * pre-transition offset. A time inside a spring-forward gap resolves to the first
 * instant after the gap (02:30 on a 02:00-03:00 gap night becomes 03:00 local).
 */
export function toUtc(zone: string, local: number): number {
  if (UTC_ZONES.has(zone)) return local;
  const before = offsetAt(zone, local - DAY);
  const after = offsetAt(zone, local + DAY);
  const t1 = local - before;
  if (before === after && offsetAt(zone, t1) === before) return t1;
  const t2 = local - after;
  if (offsetAt(zone, t1) === before) return t1;
  if (offsetAt(zone, t2) === after) return t2;
  // Inside a gap: binary search for the transition instant.
  let lo = Math.min(t1, t2);
  let hi = Math.max(t1, t2);
  const loOffset = offsetAt(zone, lo);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (mid <= lo) break;
    if (offsetAt(zone, mid) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Local calendar day of an instant in a zone. */
export function localDay(zone: string, t: number): number {
  return Math.floor(toLocal(zone, t) / DAY);
}

/** Seconds since local midnight of an instant in a zone. */
export function localSecond(zone: string, t: number): number {
  const l = toLocal(zone, t);
  return Math.floor((l - Math.floor(l / DAY) * DAY) / 1000);
}
