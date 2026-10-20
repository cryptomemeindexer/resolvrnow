import { randomBytes } from 'node:crypto';

/** 32 lowercase hex characters, the same shape as a ServiceNow sys_id. */
export function newSysId(): string {
  return randomBytes(16).toString('hex');
}

export const SYS_ID_RE = /^[0-9a-f]{32}$/;
export function isSysId(v: unknown): v is string {
  return typeof v === 'string' && SYS_ID_RE.test(v);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Internal date-time format: `YYYY-MM-DD HH:MM:SS` in UTC. */
export function toGlideDateTime(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
}

export function toGlideDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Overridable clock so tests and SLA simulations can control time. */
let clockOffsetMs = 0;
let frozen: number | null = null;
export const clock = {
  now(): Date {
    return new Date(frozen ?? Date.now() + clockOffsetMs);
  },
  freeze(at: Date | string | null): void {
    frozen = at === null ? null : typeof at === 'string' ? parseGlideDateTime(at)!.getTime() : at.getTime();
  },
  advance(ms: number): void {
    if (frozen !== null) frozen += ms;
    else clockOffsetMs += ms;
  },
  reset(): void {
    frozen = null;
    clockOffsetMs = 0;
  },
};

export function nowGlide(): string {
  return toGlideDateTime(clock.now());
}

/** Parses `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD`, or ISO 8601 strings as UTC. */
export function parseGlideDateTime(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', tz] = m;
    if (tz) {
      const t = Date.parse(s.replace(' ', 'T'));
      return Number.isNaN(t) ? null : new Date(t);
    }
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, mo, d, y, h = '0', mi = '0', se = '0'] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

export function normalizeDateTime(v: unknown): string | null {
  const d = parseGlideDateTime(v);
  return d ? toGlideDateTime(d) : null;
}

export function normalizeDate(v: unknown): string | null {
  const d = parseGlideDateTime(v);
  return d ? toGlideDate(d) : null;
}

/**
 * Durations are stored as milliseconds. The REST "value" representation follows
 * the platform convention of a date-time offset from the epoch, e.g. `1970-01-01 02:30:00`.
 */
export function durationToValue(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  return toGlideDateTime(new Date(ms));
}

export function parseDuration(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const d = parseGlideDateTime(s);
  if (d && /^\d{4}-/.test(s)) return d.getTime();
  // "2 Days 3 Hours 10 Minutes 5 Seconds" / "3h 10m" / "1d"
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s))) {
    matched = true;
    const n = Number(mm[1]);
    const u = mm[2].toLowerCase();
    if (u.startsWith('d')) total += n * 86400000;
    else if (u.startsWith('h')) total += n * 3600000;
    else if (u === 'm' || u.startsWith('min')) total += n * 60000;
    else total += n * 1000;
  }
  if (matched) return Math.round(total);
  // HH:MM:SS
  const hms = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hms) return (+hms[1] * 3600 + +hms[2] * 60 + +(hms[3] ?? 0)) * 1000;
  return null;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  let secs = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(secs / 86400);
  secs -= days * 86400;
  const hours = Math.floor(secs / 3600);
  secs -= hours * 3600;
  const mins = Math.floor(secs / 60);
  secs -= mins * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} Day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} Hour${hours === 1 ? '' : 's'}`);
  if (mins) parts.push(`${mins} Minute${mins === 1 ? '' : 's'}`);
  if (secs && days === 0) parts.push(`${secs} Second${secs === 1 ? '' : 's'}`);
  return (ms < 0 ? '-' : '') + (parts.join(' ') || '0 Seconds');
}

export function addMs(glide: string, ms: number): string {
  const d = parseGlideDateTime(glide)!;
  return toGlideDateTime(new Date(d.getTime() + ms));
}

export function diffMs(a: string, b: string): number {
  return parseGlideDateTime(a)!.getTime() - parseGlideDateTime(b)!.getTime();
}

export function isTruthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 'y'].includes(v.trim().toLowerCase());
  return false;
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe identifier ${name}`);
  return `"${name}"`;
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
