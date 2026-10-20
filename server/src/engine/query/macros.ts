import { clock } from '../util.js';
import {
  addUnits,
  type CalendarUnit,
  endOf,
  fromLocal,
  glide,
  localDate,
  localGlide,
  normalizeZone,
  parseUnit,
  parseUtc,
  startOf,
} from './datetime.js';

/**
 * Evaluates the `javascript:` value macros that appear in encoded queries and
 * dictionary defaults. Only a fixed allow-list of side-effect-free functions is
 * supported (string literals and `+` concatenation of allowed calls are accepted);
 * nothing is ever passed to a JavaScript evaluator.
 */
export interface MacroEnv {
  userId: string | null;
  userName?: string | null;
  /** Lazily resolves the current user's group sys_ids. */
  myGroups?: () => string[];
  /** Lazily resolves the current user's manager sys_id. */
  managerId?: () => string | null;
  /**
   * IANA time zone of the session user. Day, week, month, quarter and year bounds are
   * computed in this zone and returned as UTC values. Null or missing means UTC.
   */
  timeZone?: string | null;
}

type Fn = (args: string[], env: MacroEnv) => string | null;

const zone = (env: MacroEnv): string | null => normalizeZone(env.timeZone);
const nowMs = (): number => clock.now().getTime();
const num = (v: string | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Start/end of the bucket `shift` units away from now. */
function bucket(unit: CalendarUnit, shift: number): [Fn, Fn] {
  return [
    (_a, env) => {
      const tz = zone(env);
      return glide(startOf(addUnits(nowMs(), tz, unit, shift), tz, unit));
    },
    (_a, env) => {
      const tz = zone(env);
      return glide(endOf(addUnits(nowMs(), tz, unit, shift), tz, unit));
    },
  ];
}

/** Window from the start of the bucket `back` units ago to the end of the current `endUnit` bucket. */
function rolling(unit: CalendarUnit, back: number, endUnit: CalendarUnit = unit): [Fn, Fn] {
  return [
    (_a, env) => {
      const tz = zone(env);
      return glide(startOf(addUnits(nowMs(), tz, unit, -back), tz, unit));
    },
    (_a, env) => {
      const tz = zone(env);
      return glide(endOf(nowMs(), tz, endUnit));
    },
  ];
}

/** Window from the start of the next bucket to the end of the bucket `n` units ahead. */
function ahead(unit: CalendarUnit, n: number): [Fn, Fn] {
  return [
    (_a, env) => {
      const tz = zone(env);
      return glide(startOf(addUnits(nowMs(), tz, unit, 1), tz, unit));
    },
    (_a, env) => {
      const tz = zone(env);
      return glide(endOf(addUnits(nowMs(), tz, unit, n), tz, unit));
    },
  ];
}

/** Bounds of the day one year ago. */
function oneYearAgo(): [Fn, Fn] {
  return [
    (_a, env) => {
      const tz = zone(env);
      return glide(startOf(addUnits(nowMs(), tz, 'year', -1), tz, 'day'));
    },
    (_a, env) => {
      const tz = zone(env);
      return glide(endOf(addUnits(nowMs(), tz, 'year', -1), tz, 'day'));
    },
  ];
}

/**
 * Named bound pairs: `gs.beginningOf<Name>()` / `gs.endOf<Name>()`. The names are the
 * date-picker periods; their exact extents are ResolvrNow decisions (encoded-query spec 5.3).
 */
const BOUNDS: Record<string, [Fn, Fn]> = {
  Today: bucket('day', 0),
  Yesterday: bucket('day', -1),
  Tomorrow: bucket('day', 1),
  ThisWeek: bucket('week', 0),
  LastWeek: bucket('week', -1),
  NextWeek: bucket('week', 1),
  ThisMonth: bucket('month', 0),
  LastMonth: bucket('month', -1),
  NextMonth: bucket('month', 1),
  ThisQuarter: bucket('quarter', 0),
  LastQuarter: bucket('quarter', -1),
  NextQuarter: bucket('quarter', 1),
  Last2Quarters: rolling('quarter', 2, 'day'),
  Next2Quarters: ahead('quarter', 2),
  ThisYear: bucket('year', 0),
  LastYear: bucket('year', -1),
  NextYear: bucket('year', 1),
  Last2Years: rolling('year', 2, 'day'),
  OneYearAgo: oneYearAgo(),
  CurrentMinute: bucket('minute', 0),
  LastMinute: bucket('minute', -1),
  Last15Minutes: rolling('minute', 15),
  Last30Minutes: rolling('minute', 30),
  Last45Minutes: rolling('minute', 45),
  CurrentHour: bucket('hour', 0),
  LastHour: bucket('hour', -1),
  Last2Hours: rolling('hour', 2),
  Last7Days: rolling('day', 7),
  Last30Days: rolling('day', 30),
  Last60Days: rolling('day', 60),
  Last90Days: rolling('day', 90),
  Last120Days: rolling('day', 120),
  Last3Months: rolling('month', 3, 'day'),
  Last6Months: rolling('month', 6, 'day'),
  Last9Months: rolling('month', 9, 'day'),
  Last12Months: rolling('month', 12, 'day'),
};

/** `gs.beginningOfDay([dateTime])` style bounds around now or an explicit UTC date-time. */
function around(unit: CalendarUnit, end: boolean): Fn {
  return ([at], env) => {
    const tz = zone(env);
    const base = at ? parseUtc(at) : nowMs();
    if (base === null) return null;
    return glide(end ? endOf(base, tz, unit) : startOf(base, tz, unit));
  };
}

function agoPoint(unit: CalendarUnit): Fn {
  return ([n], env) => glide(addUnits(nowMs(), zone(env), unit, -num(n)));
}

function agoStart(unit: CalendarUnit): Fn {
  return ([n], env) => {
    const tz = zone(env);
    return glide(startOf(addUnits(nowMs(), tz, unit, -num(n)), tz, unit));
  };
}

function agoEnd(unit: CalendarUnit): Fn {
  return ([n], env) => {
    const tz = zone(env);
    return glide(endOf(addUnits(nowMs(), tz, unit, -num(n)), tz, unit));
  };
}

/** `D HH:MM:SS` (or `HH:MM:SS`) to the epoch-based duration value `1970-01-0X HH:MM:SS`. */
function durationDate(v: string | undefined): string | null {
  const m = /^\s*(?:(\d+)\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(v ?? '');
  if (!m) return null;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2])) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000;
  return glide(ms);
}

function fns(): Record<string, Fn> {
  const out: Record<string, Fn> = {
    'gs.nowDateTime': () => glide(nowMs()),
    'gs.nowNoTZ': () => glide(nowMs()),
    'gs.nowGlideDateTime': () => glide(nowMs()),
    'new GlideDateTime().getValue': () => glide(nowMs()),
    'new GlideDateTime().getDisplayValue': (_a, env) => localGlide(nowMs(), zone(env)),
    'gs.now': (_a, env) => localDate(nowMs(), zone(env)),
    'gs.yesterday': (_a, env) => glide(addUnits(nowMs(), zone(env), 'day', -1)),
    'gs.lastWeek': (_a, env) => glide(addUnits(nowMs(), zone(env), 'week', -1)),
    'gs.beginningOfDay': around('day', false),
    'gs.endOfDay': around('day', true),
    'gs.beginningOfWeek': around('week', false),
    'gs.endOfWeek': around('week', true),
    'gs.beginningOfMonth': around('month', false),
    'gs.endOfMonth': around('month', true),
    'gs.beginningOfYear': around('year', false),
    'gs.endOfYear': around('year', true),
    'gs.minutesAgo': agoPoint('minute'),
    'gs.minutesAgoStart': agoStart('minute'),
    'gs.minutesAgoEnd': agoEnd('minute'),
    'gs.hoursAgo': agoPoint('hour'),
    'gs.hoursAgoStart': agoStart('hour'),
    'gs.hoursAgoEnd': agoEnd('hour'),
    'gs.hoursAgoLocal': ([n], env) => localGlide(addUnits(nowMs(), zone(env), 'hour', -num(n)), zone(env)),
    'gs.daysAgo': agoPoint('day'),
    'gs.daysAgoStart': agoStart('day'),
    'gs.daysAgoEnd': agoEnd('day'),
    'gs.daysAgoLocal': ([n], env) => localGlide(addUnits(nowMs(), zone(env), 'day', -num(n)), zone(env)),
    'gs.monthsAgo': agoPoint('month'),
    'gs.monthsAgoStart': agoStart('month'),
    'gs.monthsAgoEnd': agoEnd('month'),
    'gs.quartersAgo': agoPoint('quarter'),
    'gs.quartersAgoStart': agoStart('quarter'),
    'gs.quartersAgoEnd': agoEnd('quarter'),
    'gs.yearsAgo': agoPoint('year'),
    /** A wall-clock date and time in the user's zone, returned as a UTC value. */
    'gs.dateGenerate': ([date, time], env) => {
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? '').trim());
      if (!d) return null;
      const t = !time || time === 'start' ? '00:00:00' : time === 'end' ? '23:59:59' : time;
      const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
      if (!tm) return null;
      return glide(fromLocal(zone(env), +d[1], +d[2], +d[3], +tm[1], +tm[2], +(tm[3] ?? 0)));
    },
    'gs.getDurationDate': ([v]) => durationDate(v),
    'gs.getUserID': (_a, env) => env.userId ?? '',
    'gs.getUser().getID': (_a, env) => env.userId ?? '',
    'gs.getUserName': (_a, env) => env.userName ?? '',
    'gs.getUser().getName': (_a, env) => env.userName ?? '',
    'gs.getUser().getUserName': (_a, env) => env.userName ?? '',
    getMyGroups: (_a, env) => (env.myGroups?.() ?? []).join(','),
    'gs.getUser().getMyGroups': (_a, env) => (env.myGroups?.() ?? []).join(','),
    'gs.getUser().getManagerID': (_a, env) => env.managerId?.() ?? '',
    getMyAssignments: (_a, env) => env.userId ?? '',
    getMyApprovals: (_a, env) => env.userId ?? '',
  };
  for (const [name, [begin, end]] of Object.entries(BOUNDS)) {
    out[`gs.beginningOf${name}`] = begin;
    out[`gs.endOf${name}`] = end;
  }
  return out;
}

const FNS = fns();

/** Macros that produce a list of sys_ids; `=` against them means "is one of". */
const LIST_FNS = new Set(['getMyGroups', 'gs.getUser().getMyGroups', 'getMyAssignments', 'getMyApprovals']);

const CALL_RE = /^((?:new\s+)?[A-Za-z_]\w*(?:(?:\(\))?\.[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/;

export class MacroError extends Error {}

/**
 * Splits `s` on `sep` characters that are outside quotes and parentheses.
 * Returns null when quotes or parentheses are unbalanced.
 */
export function splitTopLevel(s: string, sep: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return null;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote || depth !== 0) return null;
  out.push(cur);
  return out;
}

/**
 * Splits a compound operand (`low@high`, `label@start@end`) on `@` signs that are not
 * inside a macro's quoted arguments. Unbalanced input falls back to a plain split.
 */
export function splitValue(value: string, sep = '@'): string[] {
  return splitTopLevel(value, sep) ?? value.split(sep);
}

function unquote(s: string): string | null {
  const m = /^'((?:[^'\\]|\\[\s\S])*)'$/.exec(s) ?? /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(s);
  if (!m) return null;
  return m[1].replace(/\\([\s\S])/g, '$1');
}

function evalOperand(s: string, env: MacroEnv): string | null {
  if (!s) return null;
  const lit = unquote(s);
  if (lit !== null) return lit;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return s;
  const m = CALL_RE.exec(s);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ');
  const fn = FNS[name];
  if (!fn) return null;
  const rawArgs = m[2].trim() ? splitTopLevel(m[2], ',') : [];
  if (!rawArgs) return null;
  const args = rawArgs.map((a) => {
    const t = a.trim();
    return unquote(t) ?? t;
  });
  return fn(args, env);
}

function macroBody(expr: string): string {
  return expr
    .replace(/^\s*javascript\s*:/i, '')
    .trim()
    .replace(/;\s*$/, '')
    .trim();
}

/** Evaluates a `javascript:` macro; returns null when the expression is not supported. */
export function evalMacro(expr: string, env: MacroEnv): string | null {
  const parts = splitTopLevel(macroBody(expr), '+');
  if (!parts?.length) return null;
  let out = '';
  for (const p of parts) {
    const v = evalOperand(p.trim(), env);
    if (v === null) return null;
    out += v;
  }
  return out;
}

export function isMacro(v: string): boolean {
  return /^\s*javascript\s*:/i.test(v);
}

/** True when the macro returns a list of sys_ids (the user's groups, assignments or approvals). */
export function macroIsList(v: string): boolean {
  if (!isMacro(v)) return false;
  const m = CALL_RE.exec(macroBody(v));
  return !!m && LIST_FNS.has(m[1].replace(/\s+/g, ' '));
}

/** Resolves a value that may be a macro; unsupported macros resolve to null. */
export function resolveValue(v: string, env: MacroEnv): string | null {
  return isMacro(v) ? evalMacro(v, env) : v;
}

/**
 * Well-known dynamic filter options (sys_filter_option_dynamic) referenced by DYNAMIC
 * conditions. The platform module seeds them as rows; more can be added at runtime with
 * `registerDynamicFilter`.
 */
export const DYNAMIC_FILTERS: Record<string, { label: string; script: string }> = {
  '54635e965f510100a9ad2572f2b4774c': { label: 'Me', script: 'javascript:gs.getUserID()' },
  '90d1921e5f510100a9ad2572f2b477fe': { label: 'Me', script: 'javascript:gs.getUserID()' },
  d6435e965f510100a9ad2572f2b47744: { label: 'One of My Groups', script: 'javascript:getMyGroups()' },
  '2a0e2e365f510100a9ad2572f2b477e9': {
    label: 'My Manager',
    script: 'javascript:gs.getUser().getManagerID()',
  },
};

/** Adds (or replaces) a dynamic filter option. The script must use the macro allow-list. */
export function registerDynamicFilter(sysId: string, label: string, script: string): void {
  DYNAMIC_FILTERS[sysId] = { label, script: isMacro(script) ? script : `javascript:${script}` };
}

/** Values a DYNAMIC option resolves to (an empty list matches nothing); null for unknown options. */
export function resolveDynamic(id: string, env: MacroEnv): string[] | null {
  const dyn = DYNAMIC_FILTERS[id.trim()];
  if (!dyn) return null;
  const v = resolveValue(dyn.script, env);
  if (v === null) return null;
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Parsed `@unit@ago|ahead@n` spec of the RELATIVE operators (`n` is negative for `ago`). */
export interface RelativeSpec {
  unit: CalendarUnit;
  n: number;
}

export function parseRelative(spec: string): RelativeSpec | null {
  const parts = spec.split('@').filter((p) => p !== '');
  if (parts.length < 3) return null;
  const [u, dir, n] = parts;
  const unit = parseUnit(u);
  const d = dir.trim().toLowerCase();
  if (!unit || (d !== 'ago' && d !== 'ahead') || !/^\d+$/.test(n.trim())) return null;
  return { unit, n: d === 'ahead' ? Number(n) : -Number(n) };
}

/** Resolves `@unit@ago|ahead@n` as used by RELATIVE* operators to an absolute UTC timestamp. */
export function relativeInstant(spec: string, env?: MacroEnv): string | null {
  const r = parseRelative(spec);
  if (!r) return null;
  return glide(addUnits(nowMs(), normalizeZone(env?.timeZone), r.unit, r.n));
}

/** The local unit bucket containing the RELATIVE anchor (used by RELATIVEEE). */
export function relativeBounds(spec: string, env?: MacroEnv): [string, string] | null {
  const r = parseRelative(spec);
  if (!r) return null;
  const tz = normalizeZone(env?.timeZone);
  const anchor = addUnits(nowMs(), tz, r.unit, r.n);
  return [glide(startOf(anchor, tz, r.unit)), glide(endOf(anchor, tz, r.unit))];
}

const LABEL_NAMES: Record<string, string> = {};
for (const name of Object.keys(BOUNDS)) {
  const words = name
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    .toLowerCase();
  LABEL_NAMES[words] = name;
}
LABEL_NAMES['current week'] = 'ThisWeek';
LABEL_NAMES['current month'] = 'ThisMonth';
LABEL_NAMES['current quarter'] = 'ThisQuarter';
LABEL_NAMES['current year'] = 'ThisYear';

/** Bound pair for a date-picker label such as `Today`, `Last 7 days` or `This quarter`. */
export function labelBounds(label: string, env: MacroEnv): [string, string] | null {
  const key = label.replace(/[_+]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const name = LABEL_NAMES[key];
  if (!name) return null;
  const [b, e] = BOUNDS[name];
  const s = b([], env);
  const t = e([], env);
  return s === null || t === null ? null : [s, t];
}

/**
 * Bounds of an ON / NOTON operand: `label@start@end`, a bare date-picker label, or a bare
 * `YYYY-MM-DD` date (the whole local day). Returns UTC values, or null when unusable.
 */
export function onBounds(value: string, env: MacroEnv): [string, string] | null {
  const parts = splitValue(value);
  if (parts.length >= 3) {
    const start = resolveValue(parts[1], env);
    const end = resolveValue(parts[2], env);
    if (start !== null && end !== null && parseUtc(start) !== null && parseUtc(end) !== null) {
      return [widen(start, false), widen(end, true)];
    }
    return labelBounds(parts[0], env);
  }
  if (parts.length !== 1) return null;
  const lb = labelBounds(parts[0], env);
  if (lb) return lb;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0].trim());
  if (!d) return null;
  const tz = zone(env);
  const start = fromLocal(tz, +d[1], +d[2], +d[3]);
  return [glide(start), glide(endOf(start, tz, 'day'))];
}

/** A bare date bound covers the whole day. */
function widen(v: string, end: boolean): string {
  const t = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t} ${end ? '23:59:59' : '00:00:00'}` : t;
}
