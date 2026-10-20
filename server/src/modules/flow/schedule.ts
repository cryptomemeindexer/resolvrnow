import { parseDuration, parseGlideDateTime } from '../../engine/util.js';
import type { ScheduledTrigger } from './types.js';

const DAY = 86_400_000;
const ISO_DURATION =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/** Milliseconds of an ISO-8601 duration (PT1H, P3D, P1W...); also accepts "2 hours", "01:30:00" or a number of ms. */
export function durationMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const m = ISO_DURATION.exec(s);
  if (m && s.length > 1 && !s.toUpperCase().endsWith('T')) {
    const n = (i: number) => Number(m[i] ?? 0);
    return Math.round(
      n(1) * 365 * DAY +
        n(2) * 30 * DAY +
        n(3) * 7 * DAY +
        n(4) * DAY +
        n(5) * 3_600_000 +
        n(6) * 60_000 +
        n(7) * 1000,
    );
  }
  if (/^P/i.test(s)) return null;
  return parseDuration(s);
}

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function weekdays(v: ScheduledTrigger['days_of_week']): number[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = new Set<number>();
  for (const raw of list) {
    const s = String(raw).trim().toLowerCase();
    if (/^\d+$/.test(s))
      out.add(Number(s) % 7); // ISO 1 = Monday ... 7 = Sunday (0 also Sunday)
    else if (DAY_NAMES[s.slice(0, 3)] !== undefined) out.add(DAY_NAMES[s.slice(0, 3)]);
  }
  return out.size ? [...out] : [1];
}

/** Time of day in ms after midnight from "HH:MM[:SS]" (or the time part of a date-time). */
function timeOfDay(at: string | undefined): number {
  if (!at) return 0;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(at.trim());
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000;
}

function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Next run of a scheduled trigger strictly after `after` (UTC, the system time zone).
 * Returns null when a one-time schedule already ran.
 */
export function nextRun(trigger: ScheduledTrigger, after: Date, alreadyRan = false): Date | null {
  const tod = timeOfDay(trigger.at);
  switch (trigger.repeat) {
    case 'once': {
      if (alreadyRan) return null;
      return parseGlideDateTime(trigger.at) ?? after;
    }
    case 'daily': {
      let t = startOfDay(after) + tod;
      if (t <= after.getTime()) t += DAY;
      return new Date(t);
    }
    case 'weekly': {
      const days = weekdays(trigger.days_of_week);
      for (let i = 0; i <= 7; i++) {
        const t = startOfDay(after) + i * DAY + tod;
        if (t > after.getTime() && days.includes(new Date(t).getUTCDay())) return new Date(t);
      }
      return null;
    }
    case 'monthly': {
      const want = Math.min(Math.max(Number(trigger.day_of_month ?? 1) || 1, 1), 31);
      for (let i = 0; i < 3; i++) {
        const y = after.getUTCFullYear();
        const mo = after.getUTCMonth() + i;
        const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        const t = Date.UTC(y, mo, Math.min(want, last)) + tod;
        if (t > after.getTime()) return new Date(t);
      }
      return null;
    }
    case 'interval': {
      const every = durationMs(trigger.every);
      return every && every > 0 ? new Date(after.getTime() + every) : null;
    }
    default:
      return null;
  }
}
