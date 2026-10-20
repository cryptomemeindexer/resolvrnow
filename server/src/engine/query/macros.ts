import { clock, toGlideDateTime } from '../util.js';

/**
 * Evaluates the `javascript:` value macros that appear in encoded queries and
 * dictionary defaults. Only a fixed whitelist of side-effect-free functions is
 * supported; nothing is ever passed to a JavaScript evaluator.
 */
export interface MacroEnv {
  userId: string | null;
  userName?: string | null;
  /** Lazily resolves the current user's group sys_ids. */
  myGroups?: () => string[];
  /** Lazily resolves the current user's manager sys_id. */
  managerId?: () => string | null;
}

const DAY = 86400000;

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function endOfDay(d: Date): Date {
  return new Date(startOfDay(d).getTime() + DAY - 1000);
}
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(s.getTime() - dow * DAY);
}
function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), 28), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}
function startOfQuarter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}
function startOfYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

type Fn = (args: string[], env: MacroEnv) => string | null;

const g = (d: Date) => toGlideDateTime(d);

function rangeFns(): Record<string, Fn> {
  const now = () => clock.now();
  const fns: Record<string, Fn> = {
    'gs.nowDateTime': () => g(now()),
    'gs.now': () => g(now()).slice(0, 10),
    'gs.nowNoTZ': () => g(now()),
    'new GlideDateTime().getValue': () => g(now()),
    'gs.beginningOfToday': () => g(startOfDay(now())),
    'gs.endOfToday': () => g(endOfDay(now())),
    'gs.beginningOfYesterday': () => g(startOfDay(new Date(now().getTime() - DAY))),
    'gs.endOfYesterday': () => g(endOfDay(new Date(now().getTime() - DAY))),
    'gs.beginningOfTomorrow': () => g(startOfDay(new Date(now().getTime() + DAY))),
    'gs.endOfTomorrow': () => g(endOfDay(new Date(now().getTime() + DAY))),
    'gs.beginningOfThisWeek': () => g(startOfWeek(now())),
    'gs.endOfThisWeek': () => g(new Date(startOfWeek(now()).getTime() + 7 * DAY - 1000)),
    'gs.beginningOfLastWeek': () => g(new Date(startOfWeek(now()).getTime() - 7 * DAY)),
    'gs.endOfLastWeek': () => g(new Date(startOfWeek(now()).getTime() - 1000)),
    'gs.beginningOfNextWeek': () => g(new Date(startOfWeek(now()).getTime() + 7 * DAY)),
    'gs.endOfNextWeek': () => g(new Date(startOfWeek(now()).getTime() + 14 * DAY - 1000)),
    'gs.beginningOfThisMonth': () => g(startOfMonth(now())),
    'gs.endOfThisMonth': () => g(new Date(startOfMonth(addMonths(startOfMonth(now()), 1)).getTime() - 1000)),
    'gs.beginningOfLastMonth': () => g(startOfMonth(addMonths(startOfMonth(now()), -1))),
    'gs.endOfLastMonth': () => g(new Date(startOfMonth(now()).getTime() - 1000)),
    'gs.beginningOfNextMonth': () => g(startOfMonth(addMonths(startOfMonth(now()), 1))),
    'gs.endOfNextMonth': () => g(new Date(startOfMonth(addMonths(startOfMonth(now()), 2)).getTime() - 1000)),
    'gs.beginningOfThisQuarter': () => g(startOfQuarter(now())),
    'gs.endOfThisQuarter': () => g(new Date(addMonths(startOfQuarter(now()), 3).getTime() - 1000)),
    'gs.beginningOfLastQuarter': () => g(addMonths(startOfQuarter(now()), -3)),
    'gs.endOfLastQuarter': () => g(new Date(startOfQuarter(now()).getTime() - 1000)),
    'gs.beginningOfThisYear': () => g(startOfYear(now())),
    'gs.endOfThisYear': () => g(new Date(Date.UTC(now().getUTCFullYear() + 1, 0, 1) - 1000)),
    'gs.beginningOfLastYear': () => g(new Date(Date.UTC(now().getUTCFullYear() - 1, 0, 1))),
    'gs.endOfLastYear': () => g(new Date(startOfYear(now()).getTime() - 1000)),
    'gs.beginningOfNextYear': () => g(new Date(Date.UTC(now().getUTCFullYear() + 1, 0, 1))),
    'gs.endOfNextYear': () => g(new Date(Date.UTC(now().getUTCFullYear() + 2, 0, 1) - 1000)),
    'gs.minutesAgo': ([n]) => g(new Date(now().getTime() - Number(n || 0) * 60000)),
    'gs.minutesAgoStart': ([n]) => {
      const d = new Date(now().getTime() - Number(n || 0) * 60000);
      d.setUTCSeconds(0);
      return g(d);
    },
    'gs.minutesAgoEnd': ([n]) => {
      const d = new Date(now().getTime() - Number(n || 0) * 60000);
      d.setUTCSeconds(59);
      return g(d);
    },
    'gs.hoursAgo': ([n]) => g(new Date(now().getTime() - Number(n || 0) * 3600000)),
    'gs.hoursAgoStart': ([n]) => {
      const d = new Date(now().getTime() - Number(n || 0) * 3600000);
      d.setUTCMinutes(0, 0);
      return g(d);
    },
    'gs.hoursAgoEnd': ([n]) => {
      const d = new Date(now().getTime() - Number(n || 0) * 3600000);
      d.setUTCMinutes(59, 59);
      return g(d);
    },
    'gs.daysAgo': ([n]) => g(new Date(now().getTime() - Number(n || 0) * DAY)),
    'gs.daysAgoStart': ([n]) => g(startOfDay(new Date(now().getTime() - Number(n || 0) * DAY))),
    'gs.daysAgoEnd': ([n]) => g(endOfDay(new Date(now().getTime() - Number(n || 0) * DAY))),
    'gs.monthsAgo': ([n]) => g(addMonths(now(), -Number(n || 0))),
    'gs.monthsAgoStart': ([n]) => g(startOfMonth(addMonths(startOfMonth(now()), -Number(n || 0)))),
    'gs.monthsAgoEnd': ([n]) =>
      g(new Date(startOfMonth(addMonths(startOfMonth(now()), -Number(n || 0) + 1)).getTime() - 1000)),
    'gs.quartersAgo': ([n]) => g(addMonths(now(), -3 * Number(n || 0))),
    'gs.quartersAgoStart': ([n]) => g(addMonths(startOfQuarter(now()), -3 * Number(n || 0))),
    'gs.quartersAgoEnd': ([n]) => g(new Date(addMonths(startOfQuarter(now()), -3 * Number(n || 0) + 3).getTime() - 1000)),
    'gs.yearsAgo': ([n]) => g(addMonths(now(), -12 * Number(n || 0))),
    'gs.dateGenerate': ([date, time]) => {
      const t = !time || time === 'start' ? '00:00:00' : time === 'end' ? '23:59:59' : time;
      return `${date} ${t}`;
    },
    'gs.getUserID': (_a, env) => env.userId ?? '',
    'gs.getUser().getID': (_a, env) => env.userId ?? '',
    'gs.getUserName': (_a, env) => env.userName ?? '',
    'gs.getUser().getName': (_a, env) => env.userName ?? '',
    'getMyGroups': (_a, env) => (env.myGroups?.() ?? []).join(','),
    'gs.getUser().getMyGroups': (_a, env) => (env.myGroups?.() ?? []).join(','),
    'gs.getUser().getManagerID': (_a, env) => env.managerId?.() ?? '',
    'getMyAssignments': (_a, env) => env.userId ?? '',
  };
  return fns;
}

const FNS = rangeFns();

/** Matches `fn(args)` where fn is a dotted identifier path optionally containing `()` hops. */
const CALL_RE = /^\s*((?:new\s+)?[A-Za-z_][\w]*(?:(?:\(\))?\.[A-Za-z_]\w*)*)\s*\(([^)]*)\)\s*;?\s*$/;

export class MacroError extends Error {}

/** Evaluates a `javascript:` macro; returns null when the expression is not supported. */
export function evalMacro(expr: string, env: MacroEnv): string | null {
  const body = expr.replace(/^javascript:/i, '').trim();
  const m = CALL_RE.exec(body);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ');
  const fn = FNS[name];
  if (!fn) return null;
  const args = m[2]
    .split(',')
    .map((a) => a.trim().replace(/^['"]|['"]$/g, ''))
    .filter((a) => a !== '');
  return fn(args, env);
}

export function isMacro(v: string): boolean {
  return /^javascript:/i.test(v);
}

/** Resolves a value that may be a macro; unsupported macros resolve to null. */
export function resolveValue(v: string, env: MacroEnv): string | null {
  return isMacro(v) ? evalMacro(v, env) : v;
}

/** Well-known dynamic filter options (sys_filter_option_dynamic) referenced by DYNAMIC conditions. */
export const DYNAMIC_FILTERS: Record<string, { label: string; script: string }> = {
  '90d1921e5f510100a9ad2572f2b477fe': { label: 'Me', script: 'javascript:gs.getUserID()' },
  d6435e965f510100a9ad2572f2b47744: { label: 'One of My Groups', script: 'javascript:getMyGroups()' },
  '2a0e2e365f510100a9ad2572f2b477e9': { label: 'My Manager', script: 'javascript:gs.getUser().getManagerID()' },
};

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  quarter: 91 * DAY,
  year: 365 * DAY,
};

/** Resolves `@unit@ago|ahead@n` as used by RELATIVE* operators to an absolute timestamp. */
export function relativeInstant(spec: string): string | null {
  const parts = spec.split('@').filter(Boolean);
  if (parts.length < 3) return null;
  const [unit, dir, n] = parts;
  const ms = UNIT_MS[unit.toLowerCase()];
  if (!ms) return null;
  const delta = Number(n) * ms * (dir === 'ahead' ? 1 : -1);
  return toGlideDateTime(new Date(clock.now().getTime() + delta));
}
