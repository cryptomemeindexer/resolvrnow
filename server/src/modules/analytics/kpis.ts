import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import { type Condition, parseEncodedQuery, stringifyQuery } from '../../engine/query/parser.js';
import type { Rec } from '../../engine/record.js';
import type { TableMeta } from '../../engine/types.js';
import { newSysId, nowGlide, quoteIdent } from '../../engine/util.js';
import { addDays, datesBetween, dayEnd, dayStart, isValidDate, todayDate, withClockAt } from './dates.js';
import {
  andQueries,
  groupAggregate,
  invalidTerms,
  type Measure,
  type Predicate,
  resolveField,
  term,
  totalAggregate,
} from './grouping.js';
import type { KpiAggregate, KpiDirection, KpiUnit } from './kpi-catalogue.js';

/**
 * Indicator (KPI) engine: computes scores from `pa_indicators` definitions, stores daily
 * scores in `pa_scores`, backfills history and builds scorecards (current value, previous
 * value, sparkline, target). Scores are organisation-wide and computed with system rights;
 * viewers need read access to the facts tables. Days are UTC calendar days.
 */

export interface Indicator {
  sysId: string;
  key: string;
  name: string;
  description: string;
  type: string;
  table: string | null;
  condition: string;
  aggregate: KpiAggregate;
  field: string | null;
  mode: 'snapshot' | 'period';
  dateField: string | null;
  predicate: Predicate | null;
  formula: string | null;
  unit: KpiUnit;
  precision: number;
  direction: KpiDirection;
  active: boolean;
}

/** Score window: [from, to] inclusive; `live` windows end now (snapshot = current state). */
export interface ScoreWindow {
  from: string;
  to: string;
  /** Score date of the window end (`YYYY-MM-DD`). */
  date: string;
  live: boolean;
}

export interface KpiValue {
  value: number | null;
  approximate: boolean;
  /** Tables the indicator needs that are not installed. */
  missing: string[];
}

export type KpiPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';
const PERIOD_DAYS: Record<KpiPeriod, number> = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };

// ====================================================================== definitions

function parsePredicate(src: string): Predicate | null {
  const m = /^\s*same_day\(\s*([a-z0-9_.]+)\s*,\s*([a-z0-9_.]+)\s*\)\s*$/i.exec(src);
  return m ? { name: 'same_day', args: [m[1], m[2]] } : null;
}

export function isFormula(ind: Pick<Indicator, 'type' | 'aggregate' | 'formula' | 'table'>): boolean {
  return ind.type === 'formula' || ind.aggregate === 'FORMULA';
}

export function indicatorFromRecord(
  rec: Rec,
  cubes: Map<string, { table: string; conditions: string }>,
): Indicator {
  const cube = cubes.get(rec.str('cube'));
  const table = cube?.table || null;
  const aggregate = (rec.str('aggregate') || 'COUNT').toUpperCase() as KpiAggregate;
  return {
    sysId: rec.sysId,
    key: rec.str('resolvr_key') || rec.sysId,
    name: rec.str('name'),
    description: rec.str('description'),
    type: rec.str('type') || 'automated',
    table,
    condition: table
      ? andQueries(table, cube?.conditions ?? '', rec.str('conditions'))
      : rec.str('conditions'),
    aggregate,
    field: rec.str('field') || null,
    mode: rec.str('mode') === 'snapshot' ? 'snapshot' : 'period',
    dateField: rec.str('date_field') || null,
    predicate: rec.str('predicate') ? parsePredicate(rec.str('predicate')) : null,
    formula: rec.str('formula') || null,
    unit: (rec.str('unit') || 'count') as KpiUnit,
    precision: rec.num('precision') ?? 2,
    direction: (rec.str('direction') || 'none') as KpiDirection,
    active: rec.bool('active'),
  };
}

/** Every indicator definition (active or not), keyed for lookups by key, sys_id and name. */
export class IndicatorSet {
  readonly list: Indicator[];
  private byId = new Map<string, Indicator>();

  constructor(platform: Platform) {
    const ctx = platform.systemContext();
    const cubes = new Map<string, { table: string; conditions: string }>();
    for (const c of ctx.query('pa_cubes'))
      cubes.set(c.sysId, { table: c.str('facts_table'), conditions: c.str('conditions') });
    this.list = ctx
      .query('pa_indicators', { orderBy: [{ field: 'name', desc: false }] })
      .map((r) => indicatorFromRecord(r, cubes));
    for (const i of this.list) {
      this.byId.set(i.sysId, i);
      if (!this.byId.has(i.key)) this.byId.set(i.key, i);
    }
    for (const i of this.list) if (!this.byId.has(i.name)) this.byId.set(i.name, i);
  }

  get(id: string): Indicator | undefined {
    return this.byId.get(id.trim());
  }
}

// ====================================================================== formulas

type Expr =
  | { k: 'num'; v: number }
  | { k: 'ref'; id: string }
  | { k: 'neg'; a: Expr }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Expr; b: Expr };

const formulaCache = new Map<string, Expr>();

/** Parses `[[ref]] / [[ref]] * 100` style formulas (numbers, + - * /, parentheses). */
export function parseFormula(src: string): Expr {
  const cached = formulaCache.get(src);
  if (cached) return cached;
  let i = 0;
  const fail = (msg: string): never => {
    throw new InvalidError(`Invalid formula: ${msg}`, src);
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const primary = (): Expr => {
    ws();
    if (src.startsWith('[[', i)) {
      const end = src.indexOf(']]', i + 2);
      if (end < 0) fail('unterminated [[reference]]');
      const id = src.slice(i + 2, end).trim();
      if (!id) fail('empty reference');
      i = end + 2;
      return { k: 'ref', id };
    }
    if (src[i] === '(') {
      i++;
      const e = sum();
      ws();
      if (src[i] !== ')') fail('missing )');
      i++;
      return e;
    }
    if (src[i] === '-') {
      i++;
      return { k: 'neg', a: primary() };
    }
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) fail(`unexpected "${src.slice(i, i + 10)}"`);
    i += m![0].length;
    return { k: 'num', v: Number(m![0]) };
  };
  const product = (): Expr => {
    let e = primary();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '*' && op !== '/') return e;
      i++;
      e = { k: 'bin', op, a: e, b: primary() };
    }
  };
  const sum = (): Expr => {
    let e = product();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '+' && op !== '-') return e;
      i++;
      e = { k: 'bin', op, a: e, b: product() };
    }
  };
  const expr = sum();
  ws();
  if (i < src.length) fail(`unexpected "${src.slice(i, i + 10)}"`);
  formulaCache.set(src, expr);
  return expr;
}

export function formulaRefs(src: string): string[] {
  return [...src.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
}

function evalExpr(e: Expr, ref: (id: string) => number | null): number | null {
  switch (e.k) {
    case 'num':
      return e.v;
    case 'ref':
      return ref(e.id);
    case 'neg': {
      const a = evalExpr(e.a, ref);
      return a === null ? null : -a;
    }
    default: {
      const a = evalExpr(e.a, ref);
      const b = evalExpr(e.b, ref);
      if (a === null || b === null) return null;
      switch (e.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        default:
          // Division by zero leaves a gap rather than a misleading number.
          return b === 0 ? null : a / b;
      }
    }
  }
}

/** Formula dependency cycle through `key`, or null. `formulas` maps indicator keys to formulas. */
export function findCycle(
  key: string,
  formulas: Map<string, string>,
  resolveKey: (ref: string) => string,
): string[] | null {
  const path: string[] = [];
  const done = new Set<string>();
  const visit = (k: string): string[] | null => {
    if (path.includes(k)) return [...path.slice(path.indexOf(k)), k];
    if (done.has(k)) return null;
    const f = formulas.get(k);
    if (!f) return null;
    path.push(k);
    for (const r of formulaRefs(f)) {
      const hit = visit(resolveKey(r));
      if (hit) return hit;
    }
    path.pop();
    done.add(k);
    return null;
  };
  return visit(key);
}

// ====================================================================== score storage

interface StoredScore {
  value: number | null;
  approximate: boolean;
}

function scoreColumns(platform: Platform) {
  const meta = platform.registry.table('pa_scores');
  const col = (n: string) => quoteIdent(meta.columns.get(n)!.physical);
  return { table: quoteIdent(meta.physical), col };
}

/** Stored total scores (element empty) of an indicator by date. */
export function readScores(
  platform: Platform,
  indicatorId: string,
  from: string,
  to: string,
): Map<string, StoredScore> {
  const { table, col } = scoreColumns(platform);
  const rows = platform.db.all<{ d: string; v: number | null; a: number | null }>(
    `SELECT ${col('start_at')} AS d, ${col('value')} AS v, ${col('approximate')} AS a FROM ${table}
     WHERE ${col('indicator')} = ? AND (${col('element')} IS NULL OR ${col('element')} = '') AND ${col('start_at')} BETWEEN ? AND ?`,
    [indicatorId, from, to],
  );
  return new Map(
    rows.map((r) => [String(r.d), { value: r.v === null ? null : Number(r.v), approximate: r.a === 1 }]),
  );
}

/**
 * Upserts a daily total score. Exact scores (collected live) are never replaced by
 * approximations. Written with SQL directly: scores are high-volume derived data with
 * no business rules.
 */
export function writeScore(
  platform: Platform,
  indicatorId: string,
  date: string,
  value: number | null,
  approximate: boolean,
): 'inserted' | 'updated' | 'kept' {
  const { table, col } = scoreColumns(platform);
  const existing = platform.db.get<{ sys_id: string; a: number | null; v: number | null }>(
    `SELECT "sys_id", ${col('approximate')} AS a, ${col('value')} AS v FROM ${table}
     WHERE ${col('indicator')} = ? AND (${col('element')} IS NULL OR ${col('element')} = '') AND ${col('start_at')} = ?`,
    [indicatorId, date],
  );
  const now = nowGlide();
  if (existing) {
    if (approximate && existing.a !== 1) return 'kept';
    if (existing.v === value && (existing.a === 1) === approximate) return 'kept';
    platform.db.run(
      `UPDATE ${table} SET ${col('value')} = ?, ${col('approximate')} = ?, "sys_updated_on" = ?, "sys_updated_by" = 'system',
       "sys_mod_count" = COALESCE("sys_mod_count", 0) + 1 WHERE "sys_id" = ?`,
      [value, approximate ? 1 : 0, now, existing.sys_id],
    );
    return 'updated';
  }
  platform.db.run(
    `INSERT INTO ${table} ("sys_id", "sys_class_name", ${col('indicator')}, ${col('element')}, ${col('start_at')}, ${col('value')},
     ${col('approximate')}, "sys_created_on", "sys_created_by", "sys_updated_on", "sys_updated_by", "sys_mod_count")
     VALUES (?, 'pa_scores', ?, NULL, ?, ?, ?, ?, 'system', ?, 'system', 0)`,
    [newSysId(), indicatorId, date, value, approximate ? 1 : 0, now, now],
  );
  return 'inserted';
}

// ====================================================================== computation

const LIFECYCLE_FIELDS = new Set(['state', 'active']);

function tableAt(platform: Platform, meta: TableMeta, prefix: string): TableMeta | null {
  let t: TableMeta | undefined = meta;
  for (const part of prefix.split('.').filter(Boolean)) {
    const col = t?.columns.get(part);
    if (!col?.reference) return null;
    t = platform.registry.tryTable(col.reference);
  }
  return t ?? null;
}

/**
 * Approximates a snapshot condition as of a past instant from record timestamps: terms on
 * `state`/`active` (which only describe the current state) are replaced by "opened before
 * and not resolved or closed by then". Other terms use current values (hence approximate).
 * Returns null when the condition cannot be approximated.
 */
export function historicCondition(
  platform: Platform,
  table: string,
  condition: string,
  asOf: string,
): string | null {
  const meta = platform.registry.tryTable(table);
  if (!meta) return null;
  const parsed = parseEncodedQuery(condition);
  if (parsed.blocks.length > 1) return null;
  const keep: Condition[][] = [];
  const lifecycle = new Map<string, { state: boolean }>();
  for (const cluster of parsed.blocks[0] ?? []) {
    const isLife = (c: Condition) => LIFECYCLE_FIELDS.has(c.field.split('.').pop() ?? '');
    const life = cluster.filter(isLife);
    if (!life.length) {
      keep.push(cluster);
      continue;
    }
    if (life.length !== cluster.length) return null;
    for (const c of cluster) {
      const name = c.field.split('.').pop()!;
      // Only "currently open" terms can be rewritten (active=true, state in open states).
      if (name === 'active' && !(c.op === '=' && /^(true|1)$/i.test(c.value))) return null;
      const prefix = c.field.slice(0, c.field.length - name.length);
      const info = lifecycle.get(prefix) ?? { state: false };
      if (name === 'state') info.state = true;
      lifecycle.set(prefix, info);
    }
  }
  const extra: string[] = [];
  const created = (t: TableMeta) =>
    t.columns.has('opened_at') ? 'opened_at' : t.columns.has('start_time') ? 'start_time' : 'sys_created_on';
  extra.push(term(created(meta), '<=', asOf));
  for (const [prefix, info] of lifecycle) {
    const t = tableAt(platform, meta, prefix);
    if (!t) return null;
    if (prefix) extra.push(term(`${prefix}${created(t)}`, '<=', asOf));
    if (t.columns.has('closed_at'))
      extra.push(`${prefix}closed_atISEMPTY^OR${term(`${prefix}closed_at`, '>', asOf)}`);
    if (info.state && t.columns.has('resolved_at')) {
      extra.push(`${prefix}resolved_atISEMPTY^OR${term(`${prefix}resolved_at`, '>', asOf)}`);
    }
  }
  const kept = stringifyQuery({ blocks: keep.length ? [keep] : [], orderBy: [], groupBy: [], invalid: [] });
  return andQueries(table, kept, ...extra);
}

export function dayWindow(date: string): ScoreWindow {
  const today = todayDate();
  const live = date >= today;
  return { from: dayStart(date), to: live ? nowGlide() : dayEnd(date), date, live };
}

/** Rolling window of `days` days ending today (live) or ending `endDate`. */
export function rollingWindow(days: number, endDate?: string): ScoreWindow {
  const end = endDate ?? todayDate();
  const w = dayWindow(end);
  return { ...w, from: dayStart(addDays(end, -(days - 1))) };
}

function measureFor(ind: Indicator, asOf: string): Measure {
  switch (ind.aggregate) {
    case 'COUNT':
      return { fn: 'COUNT' };
    case 'AVG_AGE':
      return { fn: 'AVG_AGE', field: ind.field ?? 'opened_at', asOf };
    default:
      return { fn: ind.aggregate as Measure['fn'], field: ind.field };
  }
}

const round = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000;

/** Computes indicator values with memoisation; scores of formulas reuse their inputs' values. */
export class KpiEngine {
  readonly ctx: Context;
  private memo = new Map<string, KpiValue>();
  private stored = new Map<string, Map<string, StoredScore | null>>();
  private invalid = new Map<string, string[]>();

  constructor(
    readonly platform: Platform,
    readonly indicators: IndicatorSet = new IndicatorSet(platform),
  ) {
    this.ctx = platform.systemContext();
  }

  /** Facts tables an indicator needs (formulas: all inputs, recursively). */
  tablesOf(ind: Indicator, seen = new Set<string>()): string[] {
    if (seen.has(ind.sysId)) return [];
    seen.add(ind.sysId);
    if (!isFormula(ind)) return ind.table ? [ind.table] : [];
    const out = new Set<string>();
    for (const r of formulaRefs(ind.formula ?? '')) {
      const input = this.indicators.get(r);
      if (input) for (const t of this.tablesOf(input, seen)) out.add(t);
    }
    return [...out];
  }

  missingTables(ind: Indicator): string[] {
    return this.tablesOf(ind).filter((t) => !this.platform.registry.has(t));
  }

  /**
   * Condition terms the query compiler would ignore (fields missing from the installed
   * schema). Such indicators get no value instead of a silently wrong one.
   */
  invalidTerms(ind: Indicator, seen = new Set<string>()): string[] {
    if (seen.has(ind.sysId)) return [];
    seen.add(ind.sysId);
    const cached = this.invalid.get(ind.sysId);
    if (cached) return cached;
    let out: string[] = [];
    if (isFormula(ind)) {
      for (const r of formulaRefs(ind.formula ?? '')) {
        const input = this.indicators.get(r);
        if (input) out.push(...this.invalidTerms(input, seen));
      }
    } else if (ind.table && this.platform.registry.has(ind.table)) {
      out = invalidTerms(this.ctx, ind.table, ind.condition);
      for (const f of [ind.field, ind.dateField, ...(ind.predicate?.args ?? [])]) {
        if (f && !resolveField(this.ctx, ind.table, f)) out.push(f);
      }
    }
    this.invalid.set(ind.sysId, out);
    return out;
  }

  /** Seeds the memo (backfill computes whole date ranges in one query). */
  remember(ind: Indicator, w: ScoreWindow, v: KpiValue): void {
    this.memo.set(`${ind.sysId}|${w.from}|${w.to}`, v);
  }

  value(ind: Indicator, w: ScoreWindow, stack: string[] = []): KpiValue {
    const key = `${ind.sysId}|${w.from}|${w.to}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    let out: KpiValue;
    if (stack.includes(ind.sysId)) {
      out = { value: null, approximate: false, missing: [] };
    } else if (isFormula(ind)) {
      out = this.formulaValue(ind, w, [...stack, ind.sysId]);
    } else if (ind.type === 'manual' || ind.type === 'external') {
      const s = this.storedScore(ind, w.date);
      out = { value: s?.value ?? null, approximate: false, missing: [] };
    } else {
      out = this.automatedValue(ind, w);
    }
    this.memo.set(key, out);
    return out;
  }

  private storedScore(ind: Indicator, date: string): StoredScore | null {
    let m = this.stored.get(ind.sysId);
    if (!m) {
      m = new Map();
      this.stored.set(ind.sysId, m);
    }
    if (!m.has(date)) m.set(date, readScores(this.platform, ind.sysId, date, date).get(date) ?? null);
    return m.get(date) ?? null;
  }

  /** Duration fields are stored in milliseconds; indicators in seconds report seconds. */
  private convert(ind: Indicator, v: number | null): number | null {
    if (v === null || ind.table === null || !ind.field || ind.unit !== 'seconds') return round(v);
    const col = resolveField(this.ctx, ind.table, ind.field)?.col;
    return round(col?.type === 'glide_duration' ? v / 1000 : v);
  }

  private formulaValue(ind: Indicator, w: ScoreWindow, stack: string[]): KpiValue {
    const missing = new Set<string>();
    let approximate = false;
    let expr: Expr;
    try {
      expr = parseFormula(ind.formula ?? '');
    } catch {
      return { value: null, approximate: false, missing: [] };
    }
    const value = evalExpr(expr, (id) => {
      const input = this.indicators.get(id);
      if (!input) return null;
      const v = this.value(input, w, stack);
      for (const t of v.missing) missing.add(t);
      approximate ||= v.approximate;
      return v.value;
    });
    return { value: missing.size ? null : round(value), approximate, missing: [...missing] };
  }

  private automatedValue(ind: Indicator, w: ScoreWindow): KpiValue {
    const table = ind.table;
    if (!table || !this.platform.registry.has(table))
      return { value: null, approximate: false, missing: table ? [table] : [] };
    if (this.invalidTerms(ind).length) return { value: null, approximate: false, missing: [] };
    if (ind.mode === 'period') {
      if (!ind.dateField) return { value: null, approximate: false, missing: [] };
      const q = andQueries(
        table,
        ind.condition,
        `${term(ind.dateField, '>=', w.from)}^${term(ind.dateField, '<=', w.to)}`,
      );
      const run = () => totalAggregate(this.ctx, table, q, measureFor(ind, w.to), ind.predicate).value;
      const v = w.live ? run() : withClockAt(w.to, run);
      return { value: this.convert(ind, v), approximate: false, missing: [] };
    }
    if (w.live) {
      const v = totalAggregate(
        this.ctx,
        table,
        ind.condition,
        measureFor(ind, nowGlide()),
        ind.predicate,
      ).value;
      return { value: this.convert(ind, v), approximate: false, missing: [] };
    }
    const stored = this.storedScore(ind, w.date);
    if (stored) return { value: stored.value, approximate: stored.approximate, missing: [] };
    return this.historicValue(ind, w.to);
  }

  /** Snapshot value as of a past instant, approximated from record timestamps. */
  historicValue(ind: Indicator, asOf: string): KpiValue {
    const table = ind.table!;
    const q = historicCondition(this.platform, table, ind.condition, asOf);
    if (q === null) return { value: null, approximate: true, missing: [] };
    const v = withClockAt(
      asOf,
      () => totalAggregate(this.ctx, table, q, measureFor(ind, asOf), ind.predicate).value,
    );
    return { value: this.convert(ind, v), approximate: true, missing: [] };
  }

  /**
   * Daily values of a period indicator over a date range in one grouped query, or null
   * when the indicator needs per-day evaluation (relative macros, AVG_AGE).
   */
  periodSeries(ind: Indicator, from: string, to: string): Map<string, number | null> | null {
    const table = ind.table;
    if (!table || !ind.dateField || ind.mode !== 'period' || ind.aggregate === 'AVG_AGE') return null;
    if (/javascript:/i.test(ind.condition) || !this.platform.registry.has(table)) return null;
    const q = andQueries(
      table,
      ind.condition,
      `${term(ind.dateField, '>=', dayStart(from))}^${term(ind.dateField, '<=', dayEnd(to))}`,
    );
    const rows = groupAggregate(
      this.ctx,
      table,
      q,
      [{ field: ind.dateField, bucket: 'date' }],
      measureFor(ind, dayEnd(to)),
      ind.predicate,
    );
    const zero =
      ind.aggregate === 'COUNT' || ind.aggregate === 'COUNT_DISTINCT' || ind.aggregate === 'SUM' ? 0 : null;
    const out = new Map<string, number | null>();
    for (const d of datesBetween(from, to)) out.set(d, zero);
    for (const r of rows) if (out.has(r.keys[0])) out.set(r.keys[0], this.convert(ind, r.value));
    return out;
  }
}

// ====================================================================== collection

export interface CollectResult {
  from: string;
  to: string;
  /** Indicators scored. */
  indicators: number;
  /** Scores inserted or changed. */
  scores: number;
  /** Indicators whose tables are not installed. */
  skipped: string[];
  /** Indicators that could not be computed (unknown fields, failures); others still run. */
  errors: { id: string; message: string }[];
}

export interface CollectOptions {
  from: string;
  to: string;
  /** Dates on or after this are recomputed; older dates are only filled when missing. */
  refreshFrom?: string;
  /** Restrict to these indicator keys. */
  keys?: string[];
}

/**
 * Computes and stores daily scores for a date range: period indicators exactly, snapshot
 * indicators live for today and approximated for past dates (flagged), formulas from their
 * inputs' scores of the same date. Indicators whose tables are not installed are skipped.
 */
export function collectScores(platform: Platform, opts: CollectOptions): CollectResult {
  const engine = new KpiEngine(platform);
  const today = todayDate();
  const to = opts.to > today ? today : opts.to;
  const dates = datesBetween(opts.from, to);
  const refreshFrom = opts.refreshFrom ?? opts.from;
  const wanted = opts.keys?.length ? new Set(opts.keys) : null;
  const active = engine.indicators.list.filter(
    (i) =>
      i.active &&
      i.type !== 'manual' &&
      i.type !== 'external' &&
      (!wanted || wanted.has(i.key) || wanted.has(i.sysId)),
  );
  const skipped: string[] = [];
  const errors: CollectResult['errors'] = [];
  let scores = 0;
  let count = 0;
  const collect = (ind: Indicator) => {
    const existing = readScores(platform, ind.sysId, dates[0] ?? opts.from, to);
    const todo = dates.filter((d) => d >= refreshFrom || !existing.has(d));
    if (!todo.length) return;
    const series = isFormula(ind) ? null : engine.periodSeries(ind, todo[0], todo[todo.length - 1]);
    for (const d of todo) {
      const w = dayWindow(d);
      // A snapshot collected live on its own day beats any later reconstruction.
      if (!isFormula(ind) && ind.mode === 'snapshot' && !w.live && existing.get(d)?.approximate === false)
        continue;
      let v: KpiValue;
      if (series?.has(d)) {
        v = { value: series.get(d) ?? null, approximate: false, missing: [] };
        engine.remember(ind, w, v);
      } else {
        v = engine.value(ind, w);
      }
      if (writeScore(platform, ind.sysId, d, v.value, v.approximate) !== 'kept') scores++;
    }
  };
  platform.db.tx(() => {
    const ordered = [...active.filter((i) => !isFormula(i)), ...active.filter((i) => isFormula(i))];
    for (const ind of ordered) {
      if (engine.missingTables(ind).length) {
        skipped.push(ind.key);
        continue;
      }
      const invalid = engine.invalidTerms(ind);
      if (invalid.length) {
        errors.push({ id: ind.key, message: `Unknown fields or terms: ${invalid.join(', ')}` });
        continue;
      }
      try {
        collect(ind);
        count++;
      } catch (e) {
        // One broken definition must not stop the collection of the others.
        errors.push({ id: ind.key, message: e instanceof Error ? e.message : String(e) });
      }
    }
  });
  if (errors.length)
    platform.log.warn(
      `[resolvrnow] indicator collection: ${errors.map((e) => `${e.id}: ${e.message}`).join('; ')}`,
    );
  return { from: opts.from, to, indicators: count, scores, skipped, errors };
}

/** Recomputes the last `days` days of scores (demo data, newly installed modules). */
export function backfillScores(
  platform: Platform,
  opts: { days?: number; from?: string; to?: string; keys?: string[] } = {},
): CollectResult {
  const to = opts.to && isValidDate(opts.to) ? opts.to : todayDate();
  const days = Math.min(
    731,
    Math.max(1, opts.days ?? platform.properties.getNumber('resolvr.analytics.backfill_days', 90)),
  );
  const from = opts.from && isValidDate(opts.from) ? opts.from : addDays(to, -(days - 1));
  return collectScores(platform, { from, to, refreshFrom: from, keys: opts.keys });
}

/** Scheduled job body: today's scores (live), yesterday finalized, and any gaps of the last days. */
export function runSnapshotJob(platform: Platform): CollectResult {
  const today = todayDate();
  const catchup = Math.min(
    90,
    Math.max(1, platform.properties.getNumber('resolvr.analytics.catchup_days', 7)),
  );
  return collectScores(platform, {
    from: addDays(today, -catchup),
    to: today,
    refreshFrom: addDays(today, -1),
  });
}

// ====================================================================== scorecards

export interface KpiTarget {
  value: number;
  gap: number | null;
  status: 'on_track' | 'off_track' | 'met' | 'not_met' | null;
  startAt: string;
  reviewDate: string | null;
  personal: boolean;
}

export interface KpiCard {
  id: string;
  sysId: string;
  name: string;
  description: string;
  type: string;
  unit: KpiUnit;
  precision: number;
  direction: KpiDirection;
  mode: 'snapshot' | 'period' | null;
  table: string | null;
  tables: string[];
  period: KpiPeriod;
  window: { from: string; to: string };
  previousWindow: { from: string; to: string };
  value: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  /** Whether the change is good or bad given the indicator's direction. */
  status: 'good' | 'bad' | 'neutral' | null;
  displayValue: string;
  previousDisplayValue: string;
  approximate: boolean;
  sparkline: { date: string; value: number | null; approximate: boolean }[];
  target: KpiTarget | null;
  /** Records behind the current value (automated indicators). */
  query: string | null;
  missingTable: boolean;
  missingTables: string[];
  noAccess: boolean;
  /** Condition terms or fields unknown to the installed schema (no value is computed). */
  invalidTerms: string[];
  error: string | null;
}

export function formatKpi(value: number | null, unit: KpiUnit, precision = 2): string {
  if (value === null) return '';
  const fixed = (v: number, p: number) => Number(v.toFixed(p)).toString();
  switch (unit) {
    case 'count':
      return fixed(value, Number.isInteger(value) ? 0 : Math.min(precision, 1));
    case 'percent':
      return `${fixed(value, Math.min(precision, 1))}%`;
    case 'seconds': {
      const abs = Math.abs(value);
      if (abs < 3600) return `${fixed(value / 60, 0)} min`;
      if (abs < 172_800) return `${fixed(value / 3600, 1)} h`;
      return `${fixed(value / 86_400, 1)} d`;
    }
    case 'days':
      return `${fixed(value, 1)} d`;
    default:
      return fixed(value, precision);
  }
}

function changeOf(value: number | null, previous: number | null, direction: KpiDirection) {
  if (value === null || previous === null)
    return { delta: null, deltaPct: null, trend: null, status: null } as const;
  const delta = round(value - previous)!;
  const deltaPct = previous === 0 ? null : round(((value - previous) / Math.abs(previous)) * 100);
  const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  let status: 'good' | 'bad' | 'neutral' = 'neutral';
  if (delta !== 0 && direction !== 'none') status = delta > 0 === (direction === 'maximize') ? 'good' : 'bad';
  return { delta, deltaPct, trend, status } as const;
}

function targetFor(ctx: Context, ind: Indicator, value: number | null): KpiTarget | null {
  const today = todayDate();
  const me = ctx.user.sysId;
  const rows = ctx
    .elevated()
    .query('pa_targets', {
      query: `indicator=${ind.sysId}^elementISEMPTY^start_at<=${today}`,
      orderBy: [{ field: 'start_at', desc: true }],
    })
    .filter((t) => !t.str('personal_for') || t.str('personal_for') === me);
  const t = rows.find((r) => r.str('personal_for')) ?? rows[0];
  if (!t) return null;
  const target = t.num('target');
  if (target === null) return null;
  const review = t.str('review_date') || null;
  let status: KpiTarget['status'] = null;
  if (value !== null && ind.direction !== 'none') {
    const ok = ind.direction === 'maximize' ? value >= target : value <= target;
    status = review && review < today ? (ok ? 'met' : 'not_met') : ok ? 'on_track' : 'off_track';
  }
  return {
    value: target,
    gap: value === null ? null : round(target - value),
    status,
    startAt: t.str('start_at'),
    reviewDate: review,
    personal: !!t.str('personal_for'),
  };
}

/** Records behind an automated indicator's value over a window (drilldown). */
function drilldownQuery(ind: Indicator, w: ScoreWindow): string | null {
  if (isFormula(ind) || !ind.table) return null;
  if (ind.mode === 'period' && ind.dateField) {
    return andQueries(
      ind.table,
      ind.condition,
      `${term(ind.dateField, '>=', w.from)}^${term(ind.dateField, '<=', w.to)}`,
    );
  }
  return ind.condition;
}

export interface ScorecardOptions {
  period?: KpiPeriod;
  /** Sparkline length in days (default 30). */
  days?: number;
}

/**
 * Scorecards for indicators: current value and previous-period value with the change and
 * whether it is good, a daily sparkline from stored scores (today computed live), and the
 * applicable target. `period=day` compares today with yesterday; week, month, quarter and
 * year compare rolling 7/30/90/365-day windows with the window before them.
 */
export function kpiScorecards(
  ctx: Context,
  indicators: Indicator[],
  opts: ScorecardOptions = {},
  engine?: KpiEngine,
): KpiCard[] {
  const eng = engine ?? new KpiEngine(ctx.platform);
  const period = opts.period ?? 'day';
  const n = PERIOD_DAYS[period];
  const today = todayDate();
  const cur = rollingWindow(n);
  const prev = rollingWindow(n, addDays(today, -n));
  const days = Math.min(366, Math.max(2, opts.days ?? 30));
  const sparkFrom = addDays(today, -(days - 1));
  return indicators.map((ind) => {
    const tables = eng.tablesOf(ind);
    const missing = tables.filter((t) => !ctx.registry.has(t));
    const noAccess =
      missing.length === 0 && tables.some((t) => !ctx.platform.acl.canTable(ctx, t, 'read').allowed);
    const card: KpiCard = {
      id: ind.key,
      sysId: ind.sysId,
      name: ind.name,
      description: ind.description,
      type: ind.type,
      unit: ind.unit,
      precision: ind.precision,
      direction: ind.direction,
      mode: isFormula(ind) ? null : ind.mode,
      table: ind.table,
      tables,
      period,
      window: { from: cur.from, to: cur.to },
      previousWindow: { from: prev.from, to: prev.to },
      value: null,
      previous: null,
      delta: null,
      deltaPct: null,
      trend: null,
      status: null,
      displayValue: '',
      previousDisplayValue: '',
      approximate: false,
      sparkline: [],
      target: null,
      query: null,
      missingTable: missing.length > 0,
      missingTables: missing,
      noAccess,
      invalidTerms: [],
      error: null,
    };
    if (missing.length || noAccess) return card;
    try {
      card.invalidTerms = eng.invalidTerms(ind);
      if (card.invalidTerms.length) return card;
      const c = eng.value(ind, cur);
      const p = eng.value(ind, prev);
      const change = changeOf(c.value, p.value, ind.direction);
      const stored = readScores(ctx.platform, ind.sysId, sparkFrom, addDays(today, -1));
      const todayValue = n === 1 ? c : eng.value(ind, dayWindow(today));
      card.value = c.value;
      card.previous = p.value;
      card.delta = change.delta;
      card.deltaPct = change.deltaPct;
      card.trend = change.trend;
      card.status = change.status;
      card.displayValue = formatKpi(c.value, ind.unit, ind.precision);
      card.previousDisplayValue = formatKpi(p.value, ind.unit, ind.precision);
      card.approximate = c.approximate || p.approximate;
      card.sparkline = datesBetween(sparkFrom, today).map((d) => {
        if (d === today) return { date: d, value: todayValue.value, approximate: todayValue.approximate };
        const s = stored.get(d);
        return { date: d, value: s?.value ?? null, approximate: s?.approximate ?? false };
      });
      card.target = targetFor(ctx, ind, c.value);
      card.query = drilldownQuery(ind, cur);
    } catch (e) {
      // A broken definition yields an error card; the other cards are still computed.
      card.error = e instanceof Error ? e.message : String(e);
    }
    return card;
  });
}
