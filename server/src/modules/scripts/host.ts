import { type AggFn, type AggregateRequest, aggregate } from '../../engine/aggregate.js';
import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import { evalMacro } from '../../engine/query/macros.js';
import { QueryBuilder } from '../../engine/querybuilder.js';
import { Rec } from '../../engine/record.js';
import {
  type ColumnMeta,
  type Internal,
  JOURNAL_TYPES,
  SYSTEM_COLUMN_NAMES,
  type TableMeta,
} from '../../engine/types.js';
import {
  isSysId,
  newSysId,
  normalizeDateTime,
  nowGlide,
  parseGlideDateTime,
  toGlideDateTime,
} from '../../engine/util.js';
import { formatDateTimeInZone, toApiValue, toInternal } from '../../engine/values.js';
import { writeSyslog } from './log.js';

/**
 * Host side of the sandbox API. Every function receives the execution state of the script that
 * is currently running and the JSON-decoded arguments sent by the prelude. Nothing coming from a
 * script is trusted: handles, table names, field names and values are validated here, and the
 * engine (registry, query compiler, ACL service) remains the only path to data.
 */

/** What the host functions need from the script runtime. */
export interface HostRuntime {
  maxRows(): number;
  includeSource(name: string): { n: string; src: string } | null;
}

export interface ExecOptions {
  ctx: Context;
  source: string;
  /** File name used in stack traces and error messages. */
  file: string;
  /** syslog source for gs.log() output and for errors. */
  label: string;
  /** `current` binding (undefined = not defined in the script, null = defined as null). */
  current?: Rec | null;
  previous?: Rec | null;
  /** Business-rule phase of `current`: before, after, async, display or query. */
  phase?: string;
  /** Query business rule: `current` collects conditions into this builder. */
  liveQuery?: { table: string; qb: QueryBuilder };
  /** Extra global variables (plain values, records, host callbacks). */
  vars?: Record<string, unknown>;
  /** ACL scripts: records cannot be written and no side effects are allowed. */
  readOnly?: boolean;
  /** Default message used when the script aborts the current operation. */
  abortMessage?: string;
  /** Time limit for this script (defaults to resolvr.script.timeout_ms). */
  timeoutMs?: number;
}

export interface Cursor {
  table: TableMeta | null;
  secure: boolean;
  role: 'record' | 'current' | 'previous' | 'query';
  rows: Rec[];
  pos: number;
  rec: Rec | null;
  /** Values assigned before a record exists, kept for updateMultiple(): field -> [value, displayValue]. */
  pending: Map<string, [unknown, boolean]>;
  lastError: string | null;
  qb?: QueryBuilder;
  /** Journal entries already present on `current` when the script started. */
  journalBase?: number;
}

export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Error';
  }
}

const MAX_CURSORS = 10_000;
const MAX_OUTPUT_LINES = 5_000;
const MAX_SYSLOG_ROWS = 1_000;
const MAX_LOG_LENGTH = 4_000;
const HARD_MAX_ROWS = 100_000;
const LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const TABLE_RE = /^[A-Za-z0-9_]{1,80}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]{0,79}(\.[A-Za-z_][A-Za-z0-9_]{0,79}){0,9}$/;
const PROPERTY_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const EVENT_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const MACRO_ARG_RE = /^[A-Za-z0-9_:. -]{0,40}$/;
/** Tables scripts can never open (session tokens). */
const BLOCKED_TABLES = new Set(['sys_user_session']);
/** Fields whose stored value never leaves the host. */
const SECRET_FIELDS = new Set(['mfa_secret', 'token_hash', 'csrf_token']);
const DATE_FUNCTIONS = new Set([
  'nowDateTime',
  'now',
  'nowNoTZ',
  'beginningOfToday',
  'endOfToday',
  'beginningOfYesterday',
  'endOfYesterday',
  'beginningOfTomorrow',
  'endOfTomorrow',
  'beginningOfThisWeek',
  'endOfThisWeek',
  'beginningOfLastWeek',
  'endOfLastWeek',
  'beginningOfNextWeek',
  'endOfNextWeek',
  'beginningOfThisMonth',
  'endOfThisMonth',
  'beginningOfLastMonth',
  'endOfLastMonth',
  'beginningOfNextMonth',
  'endOfNextMonth',
  'beginningOfThisQuarter',
  'endOfThisQuarter',
  'beginningOfLastQuarter',
  'endOfLastQuarter',
  'beginningOfThisYear',
  'endOfThisYear',
  'beginningOfLastYear',
  'endOfLastYear',
  'beginningOfNextYear',
  'endOfNextYear',
  'minutesAgo',
  'minutesAgoStart',
  'minutesAgoEnd',
  'hoursAgo',
  'hoursAgoStart',
  'hoursAgoEnd',
  'daysAgo',
  'daysAgoStart',
  'daysAgoEnd',
  'monthsAgo',
  'monthsAgoStart',
  'monthsAgoEnd',
  'quartersAgo',
  'quartersAgoStart',
  'quartersAgoEnd',
  'yearsAgo',
  'dateGenerate',
]);
const AGGREGATE_FNS = new Set<AggFn>(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const HAVING_OPS = new Set(['>', '<', '=', '>=', '<=', '!=']);

// --------------------------------------------------------------- execution

/** Per-execution state: the identity, the data contexts and the cursors handed to the script. */
export class ExecState {
  readonly platform: Platform;
  /** Same user, no ACL checks: what GlideRecord uses. */
  readonly data: Context;
  /** Same user with ACL checks: what GlideRecordSecure and canRead() use. */
  readonly secure: Context;
  readonly cursors = new Map<number, Cursor>();
  readonly callbacks = new Map<number, (...args: unknown[]) => unknown>();
  readonly output: string[] = [];
  readonly errorMessages: string[] = [];
  deadline = Number.POSITIVE_INFINITY;
  private nextHandle = 1;
  private syslogRows = 0;

  constructor(
    readonly runtime: HostRuntime,
    readonly ctx: Context,
    readonly opts: ExecOptions,
  ) {
    this.platform = ctx.platform;
    this.data = ctx.elevated();
    this.secure = ctx.derive({ acl: true });
  }

  add(c: Cursor): number {
    if (this.cursors.size >= MAX_CURSORS) throw new HostError('Too many GlideRecord objects in one script');
    const h = this.nextHandle++;
    this.cursors.set(h, c);
    return h;
  }

  cursor(h: unknown): Cursor {
    const c = typeof h === 'number' ? this.cursors.get(h) : undefined;
    if (!c) throw new HostError('Invalid record handle');
    return c;
  }

  log(level: string, text: string, source?: string | null): void {
    const lvl = LEVELS.has(level) ? level : 'info';
    const msg = text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH)}...` : text;
    if (this.output.length < MAX_OUTPUT_LINES) this.output.push(lvl === 'info' ? msg : `[${lvl}] ${msg}`);
    if (lvl === 'debug' || this.syslogRows >= MAX_SYSLOG_ROWS) return;
    this.syslogRows++;
    writeSyslog(this.platform, lvl, source || this.opts.label, msg, this.ctx.user.userName);
  }

  /** The JSON environment the prelude's setup() turns into globals. */
  env(includes: string[], clockOffset: number): Record<string, unknown> {
    const u = this.ctx.user;
    const env: Record<string, unknown> = {
      user: { id: u.sysId, name: u.userName, display: u.name },
      offset: clockOffset,
      includes,
      readOnly: !!this.opts.readOnly,
    };
    const { liveQuery, current, previous, vars } = this.opts;
    if (liveQuery) {
      const t = this.platform.registry.table(liveQuery.table);
      const c = newCursor(t, false, 'query');
      c.qb = liveQuery.qb;
      env.current = { h: this.add(c), t: t.name, live: true };
    } else if (current !== undefined) {
      env.current = current ? { h: this.add(recordCursor(current, 'current')), t: current.className } : null;
    }
    if (previous !== undefined) {
      env.previous = previous
        ? { h: this.add(recordCursor(previous, 'previous')), t: previous.className }
        : null;
    }
    if (vars) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vars)) out[k] = this.describe(v, 0);
      env.vars = out;
    }
    return env;
  }

  /** Describes a host value for the sandbox (records become GlideRecords, functions host callbacks). */
  private describe(v: unknown, depth: number): unknown {
    if (v === null || v === undefined) return { k: 'v', v: null };
    if (v instanceof Rec) return { k: 'gr', h: this.add(recordCursor(v, 'record')), t: v.className };
    if (typeof v === 'function') {
      const id = this.callbacks.size + 1;
      this.callbacks.set(id, v as (...args: unknown[]) => unknown);
      return { k: 'fn', id };
    }
    if (typeof v !== 'object') return { k: 'v', v: typeof v === 'bigint' ? String(v) : v };
    if (v instanceof Date) return { k: 'v', v: toGlideDateTime(v) };
    if (depth >= 5) return { k: 'v', v: null };
    if (Array.isArray(v)) return { k: 'arr', a: v.slice(0, 10_000).map((x) => this.describe(x, depth + 1)) };
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const p: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) p[k] = this.describe(x, depth + 1);
      return { k: 'obj', p };
    }
    return { k: 'v', v: jsonSafe(v) };
  }
}

function jsonSafe(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Rec) return { table: v.className, sys_id: v.sysId };
  try {
    return JSON.parse(
      JSON.stringify(v, (_k, x) => (x instanceof Rec ? { table: x.className, sys_id: x.sysId } : x)) ??
        'null',
    );
  } catch {
    return String(v);
  }
}

export function newCursor(table: TableMeta | null, secure: boolean, role: Cursor['role'] = 'record'): Cursor {
  return { table, secure, role, rows: [], pos: -1, rec: null, pending: new Map(), lastError: null };
}

function recordCursor(rec: Rec, role: Cursor['role']): Cursor {
  const c = newCursor(rec.table, false, role);
  c.rows = [rec];
  c.pos = 0;
  c.rec = rec;
  if (role === 'current') c.journalBase = rec.journal.length;
  return c;
}

// --------------------------------------------------------------- arguments

function str(v: unknown, what: string, max = 1_000_000): string {
  if (typeof v !== 'string') throw new HostError(`Invalid ${what}`);
  if (v.length > max) throw new HostError(`${what} is too long`);
  return v;
}

function optStr(v: unknown, what: string, max = 1_000_000): string | null {
  return v === null || v === undefined ? null : str(v, what, max);
}

function field(v: unknown): string {
  const s = str(v, 'field name', 200);
  if (!FIELD_RE.test(s)) throw new HostError(`Invalid field name: ${s}`);
  return s;
}

function path(v: unknown): string {
  const s = str(v, 'field name', 1000);
  if (!PATH_RE.test(s)) throw new HostError(`Invalid field name: ${s}`);
  return s;
}

function scalar(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return str(v, 'value');
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  throw new HostError('Invalid value');
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HostError(`Invalid ${what}`);
  return v as Record<string, unknown>;
}

function list(v: unknown, what: string, max: number): unknown[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new HostError(`Invalid ${what}`);
  return v;
}

interface WriteOpts {
  workflow: boolean;
  autoSysFields: boolean;
}

function writeOpts(v: unknown): WriteOpts {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { workflow: o.w !== false, autoSysFields: o.a !== false };
}

// ------------------------------------------------------------------ helpers

function tableOf(st: ExecState, name: unknown): TableMeta | null {
  if (typeof name !== 'string' || !TABLE_RE.test(name) || BLOCKED_TABLES.has(name)) return null;
  return st.platform.registry.tryTable(name) ?? null;
}

function isSecret(col: ColumnMeta): boolean {
  return col.type === 'password2' || SECRET_FIELDS.has(col.name);
}

function cursorCtx(st: ExecState, c: Cursor, workflow: boolean): Context {
  const base = c.secure ? st.secure : st.data;
  return workflow ? base : base.derive({ workflow: false });
}

function requireWritable(st: ExecState, c: Cursor): void {
  if (st.opts.readOnly) throw new HostError('Records cannot be modified from this script');
  if (c.role === 'previous') throw new HostError('previous is read-only');
  if (c.role === 'query') throw new HostError('The record of a query business rule cannot be saved');
}

function isAbort(e: unknown): e is Error {
  return e instanceof AbortError || e instanceof AccessError;
}

interface Walk {
  target: Rec | null;
  col: ColumnMeta | undefined;
  field: string;
  hops: Rec[];
}

/** Follows a dot-walked path from a record. */
function walk(rec: Rec, p: string): Walk {
  const parts = p.split('.');
  const last = parts[parts.length - 1];
  let cur: Rec | null = rec;
  const hops: Rec[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const c: ColumnMeta | undefined = cur.column(parts[i]);
    if (!c || (c.type !== 'reference' && c.type !== 'document_id'))
      return { target: null, col: undefined, field: last, hops };
    const next: Rec | null = cur.ref(parts[i]);
    if (!next) return { target: null, col: undefined, field: last, hops };
    hops.push(next);
    cur = next;
  }
  return { target: cur, col: cur.column(last), field: last, hops };
}

function canReadPath(st: ExecState, c: Cursor, w: Walk): boolean {
  if (!c.secure || !w.target) return true;
  const acl = st.platform.acl;
  for (const hop of w.hops) if (!acl.canTable(st.secure, hop.className, 'read', hop).allowed) return false;
  return acl.canField(st.secure, w.target.className, w.field, 'read', w.target);
}

/** Stored value as the script sees it: getValue() ('raw') or toString() ('str'). */
function readValue(st: ExecState, c: Cursor, p: string, mode: 'raw' | 'str'): string | null {
  const empty = mode === 'raw' ? null : '';
  const rec = c.rec;
  if (!rec) {
    const pending = c.pending.get(p);
    return pending && pending[0] !== null && pending[0] !== undefined ? String(pending[0]) : empty;
  }
  const w = walk(rec, p);
  if (!w.target || !w.col || isSecret(w.col) || !canReadPath(st, c, w)) return empty;
  const col = w.col;
  if (JOURNAL_TYPES.has(col.type)) {
    const entry = [...w.target.journal].reverse().find((j) => j.field === w.field);
    return entry ? entry.value : empty;
  }
  const v = w.target.get(w.field);
  if (v === null || v === undefined || v === '')
    return mode === 'str' && col.type === 'boolean' ? 'false' : empty;
  if (col.type === 'boolean') {
    const b = v === 1 || v === '1' || v === 'true';
    return mode === 'raw' ? (b ? '1' : '0') : b ? 'true' : 'false';
  }
  return toApiValue(col, v);
}

/** Converts a comparison value to the stored representation of a column. */
function comparable(rec: Rec, col: ColumnMeta, v: unknown): Internal {
  let x = toInternal(col, v);
  if (typeof x === 'string') {
    const resolve =
      ((col.type === 'reference' || col.type === 'document_id') && !isSysId(x)) ||
      (col.type === 'integer' && !/^-?\d+$/.test(x));
    if (resolve) {
      const r = rec.host.resolveInput(rec.table, col, x);
      if (r !== undefined) x = r;
    }
  }
  return x;
}

function applyPending(rec: Rec, c: Cursor): void {
  for (const [f, [v, display]] of c.pending) rec.set(f, v, { displayValue: display });
}

function cloneRecord(ctx: Context, src: Rec): Rec {
  const copy = ctx.newRecord(src.className);
  for (const [name, col] of src.table.columns) {
    if (!col.storage || SYSTEM_COLUMN_NAMES.has(name) || name === 'number') continue;
    copy.setRaw(name, src.data[name] ?? null);
  }
  return copy;
}

const cmp = (v: Internal | undefined): string => (v === null || v === undefined ? '' : String(v));

/** Copies the values a script changed on an in-flight record onto a freshly loaded copy. */
function copyChanges(src: Rec, dst: Rec, journalBase: number): void {
  for (const [name, col] of src.table.columns) {
    if (!col.storage || SYSTEM_COLUMN_NAMES.has(name)) continue;
    if (cmp(src.data[name]) !== cmp(dst.data[name])) dst.setRaw(name, src.data[name] ?? null);
  }
  dst.journal.push(...src.journal.slice(journalBase));
}

function buildQuery(st: ExecState, table: string, spec: unknown): { qb: QueryBuilder; defaulted: boolean } {
  const o = obj(spec, 'query');
  const qb = new QueryBuilder(table);
  for (const f of list(o.q, 'query', 1000)) qb.addEncodedQuery(str(f, 'query', 100_000));
  for (const item of list(o.o, 'order', 50)) {
    const [f, desc] = list(item, 'order', 2);
    qb.orderBy.push({ field: path(f), desc: desc === true });
  }
  let defaulted = false;
  if (typeof o.l === 'number') qb.limit = int(o.l, 0, HARD_MAX_ROWS, 0);
  else {
    qb.limit = Math.min(st.runtime.maxRows(), HARD_MAX_ROWS);
    defaulted = true;
  }
  if (typeof o.s === 'number') qb.offset = int(o.s, 0, Number.MAX_SAFE_INTEGER, 0);
  return { qb, defaulted };
}

function runQuery(st: ExecState, c: Cursor, spec: unknown): Rec[] {
  if (!c.table) return [];
  const o = obj(spec, 'query');
  const { qb, defaulted } = buildQuery(st, c.table.name, o);
  let rows: Rec[];
  try {
    rows = cursorCtx(st, c, o.w !== false).query(c.table.name, qb);
  } catch (e) {
    if (e instanceof AccessError) return [];
    throw e;
  }
  if (defaulted && qb.limit !== undefined && rows.length >= qb.limit) {
    st.log(
      'warn',
      `Query on ${c.table.name} stopped at ${qb.limit} rows (resolvr.script.max_rows); use setLimit() or chooseWindow() to page`,
    );
  }
  return rows;
}

function save(c: Cursor, id: string, fn: () => void): string | null {
  try {
    fn();
    c.lastError = null;
    return id;
  } catch (e) {
    if (isAbort(e)) {
      c.lastError = e.message;
      return null;
    }
    throw e;
  }
}

function zonedToUtc(local: string, tz: string | null): string {
  const d = parseGlideDateTime(local);
  if (!d) return '';
  if (!tz || tz === 'UTC' || tz === 'GMT') return toGlideDateTime(d);
  let guess = d.getTime();
  for (let i = 0; i < 2; i++) {
    const shown = parseGlideDateTime(formatDateTimeInZone(toGlideDateTime(new Date(guess)), tz));
    if (!shown) break;
    guess += d.getTime() - shown.getTime();
  }
  return toGlideDateTime(new Date(guess));
}

function tableMeta(st: ExecState, t: unknown): Record<string, unknown> {
  const m = tableOf(st, t);
  if (!m) return { v: false, n: typeof t === 'string' ? t : '', l: '', d: '', f: {} };
  const f: Record<string, [string, string | null, string]> = {};
  for (const [name, col] of m.columns) {
    f[name] = [col.type, col.type === 'reference' ? (col.reference ?? null) : null, col.label];
  }
  return { v: true, n: m.name, l: m.label, d: m.displayField, f };
}

// ----------------------------------------------------------- host functions

type HostFn = (st: ExecState, a: unknown[]) => unknown;

export const HOST_FUNCTIONS: Record<string, HostFn> = {
  meta: (st, [t]) => tableMeta(st, t),

  'gr.new': (st, [t, secure]) => {
    const table = tableOf(st, t);
    return { h: st.add(newCursor(table, secure === true)), v: !!table };
  },

  'gr.query': (st, [h, spec]) => {
    const c = st.cursor(h);
    c.rows = runQuery(st, c, spec);
    c.pos = -1;
    c.rec = null;
    return c.rows.length;
  },

  'gr.next': (st, [h]) => {
    const c = st.cursor(h);
    if (c.pos + 1 < c.rows.length) {
      c.pos++;
      c.rec = c.rows[c.pos];
      return true;
    }
    c.pos = c.rows.length;
    c.rec = null;
    return false;
  },

  'gr.hasNext': (st, [h]) => {
    const c = st.cursor(h);
    return c.pos + 1 < c.rows.length;
  },

  'gr.get': (st, [h, a, b, two, wf]) => {
    const c = st.cursor(h);
    c.rows = [];
    c.pos = -1;
    c.rec = null;
    if (!c.table) return false;
    const table = c.table.name;
    const ctx = cursorCtx(st, c, wf !== false);
    let rec: Rec | null = null;
    try {
      if (two === true) {
        const value = scalar(b);
        if (value !== null && value !== '') {
          const qb = new QueryBuilder(table).addQuery(path(a), value);
          qb.limit = 1;
          rec = ctx.query(table, qb)[0] ?? null;
        }
      } else {
        const key = optStr(a, 'value', 1000) ?? '';
        if (isSysId(key)) rec = ctx.get(table, key);
        else if (key) {
          const qb = new QueryBuilder(table).addQuery(c.table.displayField, key);
          qb.limit = 1;
          rec = ctx.query(table, qb)[0] ?? null;
        }
      }
    } catch (e) {
      if (!(e instanceof AccessError)) throw e;
      rec = null;
    }
    if (rec) {
      c.rows = [rec];
      c.pos = 0;
      c.rec = rec;
    }
    return !!rec;
  },

  'gr.init': (st, [h]) => {
    const c = st.cursor(h);
    if (c.role !== 'record') throw new HostError('This record cannot be re-initialized');
    if (!c.table) throw new HostError('Invalid table');
    c.rec = st.data.newRecord(c.table.name);
    c.rows = [];
    c.pos = -1;
    c.pending.clear();
    c.lastError = null;
    return null;
  },

  'gr.getv': (st, [h, p, mode]) => readValue(st, st.cursor(h), path(p), mode === 'raw' ? 'raw' : 'str'),

  'gr.disp': (st, [h, p]) => {
    const c = st.cursor(h);
    const rec = c.rec;
    if (!rec) return '';
    if (p === null || p === undefined) return rec.displayValue();
    const w = walk(rec, path(p));
    if (!w.target || !w.col || isSecret(w.col) || !canReadPath(st, c, w)) return '';
    if (JOURNAL_TYPES.has(w.col.type)) return readValue(st, c, path(p), 'str') ?? '';
    return w.target.display(w.field);
  },

  'gr.set': (st, [h, f, v, display]) => {
    const c = st.cursor(h);
    requireWritable(st, c);
    if (!c.table) throw new HostError('Invalid table');
    const name = field(f);
    const value = scalar(v);
    let rec = c.rec;
    if (!rec) {
      rec = st.data.newRecord(c.table.name);
      c.rec = rec;
    }
    if (name === 'sys_id') {
      if (!rec.isNew()) throw new HostError('sys_id can only be set on a new record');
      if (!isSysId(value)) throw new HostError('Invalid sys_id');
      rec.data.sys_id = value;
      return null;
    }
    const col = rec.column(name);
    if (!col) return null;
    if (c.secure && !st.platform.acl.canField(st.secure, rec.className, name, 'write', rec)) return null;
    rec.set(name, value, { displayValue: display === true });
    c.pending.set(name, [value, display === true]);
    return null;
  },

  'gr.chg': (st, [h, f, mode, v]) => {
    const c = st.cursor(h);
    const rec = c.rec;
    if (!rec || c.role === 'previous') return false;
    if (f === null || f === undefined) return rec.changes().length > 0;
    const name = path(f);
    if (name.includes('.')) return false;
    const col = rec.column(name);
    if (!col) return false;
    if (mode === 'to') return rec.changedTo(name, comparable(rec, col, scalar(v)));
    if (mode === 'from') return rec.changedFrom(name, comparable(rec, col, scalar(v)));
    return rec.changed(name);
  },

  'gr.info': (st, [h]) => {
    const c = st.cursor(h);
    const rec = c.rec;
    return {
      id: rec ? rec.sysId : null,
      n: rec ? rec.isNew() : false,
      v: !!rec,
      c: rec ? rec.className : (c.table?.name ?? null),
      op: rec ? rec.operation : null,
    };
  },

  'gr.ins': (st, [h, o]) => {
    const c = st.cursor(h);
    requireWritable(st, c);
    const opts = writeOpts(o);
    if (!c.table) {
      c.lastError = 'Invalid table';
      return null;
    }
    const ctx = cursorCtx(st, c, opts.workflow);
    let rec = c.rec;
    if (!rec) {
      rec = ctx.newRecord(c.table.name);
      applyPending(rec, c);
      c.rec = rec;
    } else if (rec.operation) {
      st.log(
        'warn',
        `insert() ignored on ${rec.className} ${rec.sysId}: the record is being saved by the current operation`,
      );
      return rec.sysId;
    } else if (!rec.isNew()) {
      rec = cloneRecord(ctx, rec);
      c.rec = rec;
    }
    const target = rec;
    const id = save(c, target.sysId, () => {
      ctx.insert(target, {}, { autoSysFields: opts.autoSysFields });
    });
    if (id) {
      c.rows = [target];
      c.pos = 0;
    } else {
      target.operation = null;
      target.abortMessage = null;
    }
    return id;
  },

  'gr.upd': (st, [h, o]) => {
    const c = st.cursor(h);
    requireWritable(st, c);
    const opts = writeOpts(o);
    if (!c.table) {
      c.lastError = 'Invalid table';
      return null;
    }
    const rec = c.rec;
    if (!rec || (rec.isNew() && !rec.operation)) return HOST_FUNCTIONS['gr.ins'](st, [h, o]);
    const ctx = cursorCtx(st, c, opts.workflow);
    if (rec.operation) {
      // The record is in the middle of the operation that triggered this script.
      if (st.opts.phase === 'before' || rec.operation === 'delete') {
        st.log(
          'warn',
          `update() ignored on ${rec.className} ${rec.sysId}: the record is being saved by the current operation`,
        );
        return rec.sysId;
      }
      const fresh = st.data.get(rec.className, rec.sysId);
      if (!fresh) {
        c.lastError = 'Record not found';
        return null;
      }
      copyChanges(rec, fresh, c.journalBase ?? rec.journal.length);
      c.journalBase = rec.journal.length;
      return save(c, fresh.sysId, () => {
        ctx.update(fresh, {}, { autoSysFields: opts.autoSysFields });
      });
    }
    return save(c, rec.sysId, () => {
      ctx.update(rec, {}, { autoSysFields: opts.autoSysFields });
    });
  },

  'gr.del': (st, [h, o]) => {
    const c = st.cursor(h);
    requireWritable(st, c);
    const opts = writeOpts(o);
    const rec = c.rec;
    if (!rec || rec.isNew()) return false;
    if (rec.operation)
      throw new HostError('The record being processed cannot be deleted from its own business rule');
    const ok = save(c, rec.sysId, () => cursorCtx(st, c, opts.workflow).delete(rec)) !== null;
    if (ok) c.rec = null;
    return ok;
  },

  'gr.updm': (st, [h, spec, o]) => {
    const c = st.cursor(h);
    requireWritable(st, c);
    const opts = writeOpts(o);
    if (!c.table || c.pending.size === 0) return 0;
    const ctx = cursorCtx(st, c, opts.workflow);
    let n = 0;
    for (const rec of runQuery(st, c, spec)) {
      applyPending(rec, c);
      if (save(c, rec.sysId, () => ctx.update(rec, {}, { autoSysFields: opts.autoSysFields })) !== null) n++;
    }
    c.pending.clear();
    return n;
  },

  'gr.delm': (st, [h, spec, o]) => {
    const c = st.cursor(h);
    requireWritable(st, c);
    const opts = writeOpts(o);
    if (!c.table) return 0;
    const ctx = cursorCtx(st, c, opts.workflow);
    let n = 0;
    for (const rec of runQuery(st, c, spec)) {
      if (save(c, rec.sysId, () => ctx.delete(rec)) !== null) n++;
    }
    return n;
  },

  'gr.ref': (st, [h, p]) => {
    const c = st.cursor(h);
    const name = path(p);
    let meta: TableMeta | null = c.rec?.table ?? c.table;
    let target: Rec | null = c.rec;
    for (const part of name.split('.')) {
      const col = meta?.columns.get(part);
      if (col?.type !== 'reference' || !col.reference)
        throw new HostError(`${name} is not a reference field`);
      target = target ? target.ref(part) : null;
      meta = target?.table ?? tableOf(st, col.reference);
    }
    const table = meta;
    if (target && c.secure && !st.platform.acl.canTable(st.secure, target.className, 'read', target).allowed)
      target = null;
    const nc = newCursor(table, c.secure);
    if (target) {
      nc.rows = [target];
      nc.pos = 0;
      nc.rec = target;
    }
    return { h: st.add(nc), t: table?.name ?? '', tv: !!table };
  },

  'gr.can': (st, [h, op]) => {
    const c = st.cursor(h);
    if (!c.table) return false;
    if (op !== 'read' && op !== 'write' && op !== 'create' && op !== 'delete')
      throw new HostError('Invalid operation');
    const rec = c.rec;
    return st.platform.acl.canTable(st.secure, rec ? rec.className : c.table.name, op, rec).allowed;
  },

  'gr.abort': (st, [h, on]) => {
    const c = st.cursor(h);
    if (st.opts.readOnly) throw new HostError('setAbortAction() is not available in this script');
    const rec = c.rec;
    if (!rec) return null;
    if (on === true) {
      const msg = st.errorMessages[st.errorMessages.length - 1] || st.opts.abortMessage || undefined;
      rec.abort(msg);
    } else {
      rec.abortMessage = null;
    }
    return null;
  },

  'gr.aborted': (st, [h]) => !!st.cursor(h).rec?.abortMessage,

  'gr.err': (st, [h]) => st.cursor(h).lastError,

  'gr.journal': (st, [h, f, n]) => {
    const c = st.cursor(h);
    const rec = c.rec;
    const name = path(f);
    if (!rec || rec.isNew() || name.includes('.')) return '';
    const col = rec.column(name);
    if (!col || !JOURNAL_TYPES.has(col.type)) return '';
    if (c.secure && !st.platform.acl.canField(st.secure, rec.className, name, 'read', rec)) return '';
    const count = int(n, -1, 10_000, 1);
    let entries = st.platform.history.journal(rec.className, rec.sysId, [name]);
    if (count > 0) entries = entries.slice(0, count);
    return st.platform.history.formatJournal(
      entries,
      (x) => rec.column(x)?.label ?? x,
      (u) =>
        st.platform.db.get<{ name: string }>(`SELECT "name" FROM "sys_user" WHERE "user_name" = ?`, [u])
          ?.name || u,
    );
  },

  'gr.qset': (st, [h, frags]) => {
    const c = st.cursor(h);
    if (c.role !== 'query' || !c.qb) return null;
    for (const f of list(frags, 'query', 1000)) c.qb.addEncodedQuery(str(f, 'query', 100_000));
    return null;
  },

  'ga.run': (st, [t, spec]) => {
    const table = tableOf(st, t);
    if (!table) throw new HostError(`Invalid table: ${String(t)}`);
    const o = obj(spec, 'aggregate');
    const qb = new QueryBuilder(table.name);
    for (const f of list(o.q, 'query', 1000)) qb.addEncodedQuery(str(f, 'query', 100_000));
    const fn = (v: unknown): AggFn => {
      if (typeof v !== 'string' || !AGGREGATE_FNS.has(v as AggFn)) throw new HostError('Invalid aggregate');
      return v as AggFn;
    };
    const req: AggregateRequest = {
      query: qb.encoded(),
      groupBy: list(o.grp, 'group by', 20).map(path),
      aggregates: [],
      orderBy: [],
      having: [],
    };
    for (const item of list(o.aggs, 'aggregate', 50)) {
      const [f, x] = list(item, 'aggregate', 2);
      const agg = fn(f);
      if (x === null || x === undefined) {
        if (agg !== 'COUNT') throw new HostError(`${agg} needs a field`);
        continue;
      }
      req.aggregates!.push({ fn: agg, field: path(x) });
    }
    for (const item of list(o.hav, 'having', 20)) {
      const [f, x, op, value] = list(item, 'having', 4);
      if (typeof op !== 'string' || !HAVING_OPS.has(op) || typeof value !== 'number')
        throw new HostError('Invalid having clause');
      req.having!.push({
        fn: fn(f),
        field: x === null || x === undefined ? '*' : path(x),
        op: op as '>',
        value,
      });
    }
    for (const item of list(o.o, 'order', 20)) {
      const [f, desc] = list(item, 'order', 2);
      req.orderBy!.push({ expr: path(f), desc: desc === true });
    }
    for (const item of list(o.oa, 'order', 20)) {
      const [f, x, desc] = list(item, 'order', 3);
      const agg = fn(f);
      req.orderBy!.push({
        expr: x === null || x === undefined ? 'COUNT' : `${agg}(${path(x)})`,
        desc: desc === true,
      });
    }
    if (typeof o.l === 'number') req.limit = int(o.l, 1, HARD_MAX_ROWS, HARD_MAX_ROWS);
    const ctx = o.w === false ? st.data.derive({ workflow: false }) : st.data;
    return aggregate(ctx, table.name, req).map((r) => ({
      g: Object.fromEntries(r.groups.map((g) => [g.field, [g.value, g.display]])),
      c: r.count,
      a: Object.fromEntries(
        Object.entries(r.values).map(([k, v]) => {
          const dot = k.indexOf('.');
          return [`${k.slice(0, dot).toUpperCase()}${k.slice(dot)}`, v];
        }),
      ),
    }));
  },

  'gs.log': (st, [level, msg, source]) => {
    st.log(typeof level === 'string' ? level : 'info', String(msg ?? ''), optStr(source, 'source', 100));
    return null;
  },

  'gs.hasRole': (st, [roles, exact]) => {
    const names = str(roles, 'role', 1000)
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    return names.some(
      (r) => r !== 'nobody' && (exact === true ? st.ctx.user.roles.has(r) : st.ctx.hasRole(r)),
    );
  },

  'gs.member': (st, [g]) => {
    const name = str(g, 'group', 200);
    const groups = st.ctx.user.groups;
    if (isSysId(name)) return groups.includes(name);
    const row = st.platform.db.get<{ sys_id: string }>(
      `SELECT "sys_id" FROM "sys_user_group" WHERE "name" = ?`,
      [name],
    );
    return !!row && groups.includes(row.sys_id);
  },

  'gs.user': (st) => {
    const u = st.ctx.user;
    const rec = u.sysId ? st.data.get('sys_user', u.sysId) : null;
    const s = (f: string) => (rec?.has(f) ? rec.str(f) : '');
    return {
      first: s('first_name'),
      last: s('last_name'),
      email: u.email ?? '',
      company: s('company'),
      department: s('department'),
      manager: u.managerId ?? '',
      location: s('location'),
      timeZone: u.timeZone ?? 'UTC',
      groups: [...u.groups],
      roles: [...u.roles].sort(),
    };
  },

  'gs.prop': (st, [n]) => {
    const name = str(n, 'property name', 200);
    if (!PROPERTY_RE.test(name)) return null;
    const row = st.platform.db.get<{ type: string | null }>(
      `SELECT "type" FROM "sys_properties" WHERE "name" = ?`,
      [name],
    );
    const def = st.platform.properties.definitions().find((d) => d.name === name);
    const type = row?.type ?? def?.type ?? '';
    if (/password/i.test(type) && !st.ctx.user.isAdmin && !st.ctx.user.isSystem) return null;
    return st.platform.properties.get(name) ?? null;
  },

  'gs.setprop': (st, [n, v]) => {
    if (st.opts.readOnly) throw new HostError('gs.setProperty() is not available in this script');
    const user = st.ctx.user;
    if (!user.isSystem && !user.isAdmin) throw new HostError('gs.setProperty() requires the admin role');
    const name = str(n, 'property name', 200);
    if (!PROPERTY_RE.test(name)) throw new HostError(`Invalid property name: ${name}`);
    st.platform.properties.set(name, str(v, 'property value', 100_000));
    return null;
  },

  'gs.event': (st, [n, h, p1, p2, when]) => {
    if (st.opts.readOnly) throw new HostError('gs.eventQueue() is not available in this script');
    const name = str(n, 'event name', 100);
    if (!EVENT_RE.test(name)) throw new HostError(`Invalid event name: ${name}`);
    const rec = h === null || h === undefined ? null : st.cursor(h).rec;
    const parm1 = optStr(p1, 'parm1', 4000);
    const parm2 = optStr(p2, 'parm2', 4000);
    const at = optStr(when, 'date', 100);
    if (!at) {
      st.ctx.queueEvent(name, rec, parm1, parm2);
      return null;
    }
    const processOn = normalizeDateTime(at);
    if (!processOn) throw new HostError(`Invalid date: ${at}`);
    if (!st.platform.registry.has('sysevent')) return null;
    const now = nowGlide();
    const user = st.ctx.user;
    st.platform.db.run(
      `INSERT INTO "sysevent" ("sys_id","sys_class_name","name","instance","table","parm1","parm2","state","queue","user_id","user_name","process_on","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        newSysId(),
        'sysevent',
        name,
        rec?.sysId ?? null,
        rec?.className ?? null,
        parm1,
        parm2,
        'ready',
        null,
        user.sysId,
        user.userName,
        processOn,
        now,
        user.userName,
        now,
        user.userName,
      ],
    );
    return null;
  },

  'gs.msg': (st, [type, text]) => {
    const m = str(text, 'message', 10_000);
    if (type === 'error') {
      st.ctx.addErrorMessage(m);
      st.errorMessages.push(m);
    } else {
      st.ctx.addInfoMessage(m);
    }
    return null;
  },

  'gs.guid': () => newSysId(),

  'gs.date': (st, [fn, args]) => {
    if (typeof fn !== 'string' || !DATE_FUNCTIONS.has(fn)) throw new HostError('Unknown date function');
    const a = list(args, 'arguments', 3).map((x) => {
      const s = str(x, 'argument', 40);
      if (!MACRO_ARG_RE.test(s)) throw new HostError('Invalid date argument');
      return `'${s}'`;
    });
    return evalMacro(`javascript:gs.${fn}(${a.join(',')})`, st.ctx.env) ?? '';
  },

  'gs.tz': (st, [dir, value]) => {
    const v = str(value, 'date', 100);
    const tz = st.ctx.timeZone();
    if (dir === 'parse') return zonedToUtc(v, tz);
    return formatDateTimeInZone(v, tz);
  },

  'gs.include': (st, [n]) => st.runtime.includeSource(str(n, 'include name', 200)),

  'gs.tableExists': (st, [t]) => !!tableOf(st, t),

  fn: (st, [id, args]) => {
    const f = typeof id === 'number' ? st.callbacks.get(id) : undefined;
    if (!f) throw new HostError('Invalid callback');
    return jsonSafe(f(...list(args, 'arguments', 100)));
  },
};
