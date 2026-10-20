import { type AggFn, aggregate } from '../../engine/aggregate.js';
import type { Context } from '../../engine/context.js';
import type { SqlParam } from '../../engine/db.js';
import { InvalidError } from '../../engine/errors.js';
import { QueryCompiler } from '../../engine/query/compiler.js';
import { parseEncodedQuery, stringifyQuery } from '../../engine/query/parser.js';
import { QueryBuilder } from '../../engine/querybuilder.js';
import { type ColumnMeta, DATE_TYPES, type TableMeta } from '../../engine/types.js';
import { bucketRange } from './dates.js';

/**
 * Grouped aggregation for reports and indicators.
 *
 * The engine's `aggregate()` (also behind the Stats API) is used whenever it covers the
 * request. This module extends it for what it cannot express yet: Monday-based week
 * buckets keyed by date, day-of-week and hour-of-day buckets, standard deviation,
 * average age (AVG_AGE), count distinct that ignores empty strings and SQL predicates
 * such as "resolved the day it opened". The extension builds SQL through the engine's
 * QueryCompiler exactly like aggregate() does, so query business rules, dot-walk joins
 * and class restrictions behave the same. Empty strings and NULLs form one empty group.
 */

export type Bucket = 'date' | 'week' | 'month' | 'quarter' | 'year' | 'dayofweek' | 'hour';
export type MeasureFn = 'COUNT' | 'COUNT_DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'STDDEV' | 'AVG_AGE';

export interface Dimension {
  field: string;
  bucket?: Bucket | null;
}

export interface Measure {
  fn: MeasureFn;
  field?: string | null;
  /** Reference instant for AVG_AGE (`YYYY-MM-DD HH:MM:SS`). */
  asOf?: string;
}

/** Comparisons the encoded query cannot express, evaluated in SQL. */
export interface Predicate {
  name: 'same_day';
  args: [string, string];
}

export interface GroupRow {
  /** Raw group values ('' for empty); booleans as 'true'/'false', buckets as keys. */
  keys: string[];
  count: number;
  value: number | null;
}

export interface ResolvedField {
  col: ColumnMeta;
  /** Table the last path segment was resolved on (for choice lists). */
  table: TableMeta;
}

/** Buckets the engine aggregate() computes natively, mapped to its interval names. */
const NATIVE_BUCKETS: Partial<Record<Bucket, 'day' | 'month' | 'quarter' | 'year'>> = {
  date: 'day',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

// COUNT_DISTINCT goes through the extension, which does not count empty strings as a value.
const NATIVE_FNS: ReadonlySet<MeasureFn> = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

const BUCKET_SQL: Record<Bucket, (expr: string) => string> = {
  date: (e) => `strftime('%Y-%m-%d', ${e})`,
  week: (e) => `date(${e}, '-6 days', 'weekday 1')`,
  month: (e) => `strftime('%Y-%m', ${e})`,
  quarter: (e) => `(strftime('%Y', ${e}) || '-Q' || ((CAST(strftime('%m', ${e}) AS INTEGER) + 2) / 3))`,
  year: (e) => `strftime('%Y', ${e})`,
  // Sunday = 1 ... Saturday = 7, the numbering DATEPART conditions use.
  dayofweek: (e) => `(CAST(strftime('%w', ${e}) AS INTEGER) + 1)`,
  hour: (e) => `strftime('%H', ${e})`,
};

/** Resolves a (dot-walked) field path against the schema; null when it does not exist. */
export function resolveField(ctx: Context, table: string, path: string): ResolvedField | null {
  let meta = ctx.registry.tryTable(table);
  if (!meta || !path) return null;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const col: ColumnMeta | undefined = meta.columns.get(parts[i]);
    if (!col) return null;
    if (i === parts.length - 1) return { col, table: meta };
    if (col.type !== 'reference' || !col.reference) return null;
    const next = ctx.registry.tryTable(col.reference);
    if (!next) return null;
    meta = next;
  }
  return null;
}

/** Like resolveField, but throws a 400 for unknown or non-stored fields. */
export function requireField(ctx: Context, table: string, path: string, purpose: string): ResolvedField {
  const f = resolveField(ctx, table, path);
  if (!f?.col.storage) throw new InvalidError(`Invalid ${purpose} field ${path} for table ${table}`);
  return f;
}

export function isDateField(f: ResolvedField | null): boolean {
  return !!f && DATE_TYPES.has(f.col.type);
}

/** ANDs encoded queries (NQ-safe) and drops ordering and grouping terms. */
export function andQueries(table: string, ...parts: (string | null | undefined)[]): string {
  const qb = new QueryBuilder(table);
  for (const p of parts) if (p?.trim()) qb.addEncodedQuery(p);
  const parsed = qb.parsed();
  return stringifyQuery({ blocks: parsed.blocks, orderBy: [], groupBy: [], invalid: [] });
}

/** Encoded query term with caret escaping. */
export function term(field: string, op: string, value: string): string {
  return `${field}${op}${value.replace(/\^/g, '^^')}`;
}

/** `field=value`, or `fieldISEMPTY` for the empty group. */
export function equalsTerm(field: string, value: string): string {
  return value === '' ? `${field}ISEMPTY` : term(field, '=', value);
}

/** Terms the parser or compiler would ignore (unknown fields, unsupported operators). */
export function invalidTerms(ctx: Context, table: string, query: string): string[] {
  if (!query.trim()) return [];
  try {
    return [...new Set(QueryCompiler.compile(ctx.registry, table, query, ctx.env).invalid)];
  } catch {
    return parseEncodedQuery(query).invalid;
  }
}

/** Grouped aggregation over `table` for the records matching `query`, as the context's user. */
export function groupAggregate(
  ctx: Context,
  table: string,
  query: string,
  dims: Dimension[],
  measure: Measure,
  predicate: Predicate | null = null,
): GroupRow[] {
  for (const d of dims) requireField(ctx, table, d.field, 'group by');
  if (measure.fn !== 'COUNT') requireField(ctx, table, measure.field ?? '', 'aggregation');
  const bucketed = dims.filter((d) => d.bucket);
  const native =
    !predicate &&
    NATIVE_FNS.has(measure.fn) &&
    bucketed.length <= 1 &&
    bucketed.every((d) => NATIVE_BUCKETS[d.bucket!]) &&
    new Set(dims.map((d) => d.field)).size === dims.length;
  return native
    ? viaEngine(ctx, table, query, dims, measure)
    : viaSql(ctx, table, query, dims, measure, predicate);
}

/** Ungrouped aggregate: count and value of the matching records. */
export function totalAggregate(
  ctx: Context,
  table: string,
  query: string,
  measure: Measure,
  predicate: Predicate | null = null,
): { count: number; value: number | null } {
  const row = groupAggregate(ctx, table, query, [], measure, predicate)[0];
  if (!row) return { count: 0, value: measure.fn === 'COUNT' || measure.fn === 'COUNT_DISTINCT' ? 0 : null };
  return { count: row.count, value: row.value };
}

function viaEngine(
  ctx: Context,
  table: string,
  query: string,
  dims: Dimension[],
  measure: Measure,
): GroupRow[] {
  const trendDim = dims.find((d) => d.bucket);
  const rows = aggregate(ctx, table, {
    query,
    groupBy: dims.map((d) => d.field),
    aggregates: measure.fn === 'COUNT' ? [] : [{ fn: measure.fn as AggFn, field: measure.field! }],
    trend: trendDim ? { field: trendDim.field, interval: NATIVE_BUCKETS[trendDim.bucket!]! } : undefined,
  });
  const key = measure.fn === 'COUNT' ? null : `${measure.fn.toLowerCase()}.${measure.field}`;
  const mapped = rows.map((r) => ({
    keys: r.groups.map((g) => g.value),
    count: r.count,
    value: key ? (r.values[key] ?? null) : r.count,
  }));
  return mergeEmptyGroups(
    mapped,
    measure,
    (keys) =>
      totalAggregate(
        ctx,
        table,
        andQueries(table, query, ...dims.map((d, i) => keyTerm(d, keys[i]))),
        measure,
      ).value,
  );
}

/** Terms selecting one group key of a dimension (calendar buckets become date ranges). */
function keyTerm(d: Dimension, key: string): string {
  if (key === '') return `${d.field}ISEMPTY`;
  const range = d.bucket ? bucketRange(d.bucket, key) : null;
  if (!range) return equalsTerm(d.field, key);
  return `${term(d.field, '>=', `${range.start} 00:00:00`)}^${term(d.field, '<', `${range.end} 00:00:00`)}`;
}

/**
 * aggregate() groups NULL and empty strings separately although both read as empty.
 * Rows that collapse onto the same keys are merged; non-additive measures are recomputed.
 */
function mergeEmptyGroups(
  rows: GroupRow[],
  measure: Measure,
  recompute: (keys: string[]) => number | null,
): GroupRow[] {
  const byKey = new Map<string, GroupRow[]>();
  for (const r of rows) {
    const k = r.keys.join('\u0000');
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  if (byKey.size === rows.length) return rows;
  return [...byKey.values()].map((list) => {
    if (list.length === 1) return list[0];
    const count = list.reduce((n, r) => n + r.count, 0);
    const values = list.map((r) => r.value).filter((v): v is number => v !== null);
    let value: number | null;
    if (measure.fn === 'COUNT') value = count;
    else if (measure.fn === 'SUM') value = values.length ? values.reduce((a, b) => a + b, 0) : null;
    else if (measure.fn === 'MIN') value = values.length ? Math.min(...values) : null;
    else if (measure.fn === 'MAX') value = values.length ? Math.max(...values) : null;
    else value = recompute(list[0].keys);
    return { keys: list[0].keys, count, value };
  });
}

function applyQueryRules(ctx: Context, qb: QueryBuilder): void {
  if (!ctx.workflow || ctx.user.isSystem) return;
  for (const rule of ctx.platform.rules.select(qb.table, 'before', 'query')) {
    try {
      rule.query?.(qb, ctx);
    } catch (e) {
      ctx.platform.reportError(`query rule ${rule.id}`, e);
    }
  }
}

function viaSql(
  ctx: Context,
  table: string,
  query: string,
  dims: Dimension[],
  measure: Measure,
  predicate: Predicate | null,
): GroupRow[] {
  const meta = ctx.registry.table(table);
  const qb = new QueryBuilder(table).addEncodedQuery(query);
  applyQueryRules(ctx, qb);
  const compiler = new QueryCompiler(ctx.registry, meta, ctx.env);
  // Resolve every expression before build() so dot-walk joins are registered.
  const groups = dims.map((d) => {
    const r = compiler.resolve(d.field);
    if (!r) throw new InvalidError(`Invalid group by field ${d.field}`);
    // NULLIF folds empty strings into the NULL (empty) group.
    return {
      expr: d.bucket ? BUCKET_SQL[d.bucket](r.sql) : `NULLIF(${r.sql}, '')`,
      col: r.col,
      bucketed: !!d.bucket,
    };
  });
  const selectParams: SqlParam[] = [];
  const measures: string[] = [];
  if (measure.fn !== 'COUNT') {
    const r = compiler.resolve(measure.field ?? '');
    if (!r) throw new InvalidError(`Invalid aggregation field ${measure.field}`);
    switch (measure.fn) {
      case 'COUNT_DISTINCT':
        measures.push(`COUNT(DISTINCT NULLIF(${r.sql}, ''))`);
        break;
      case 'STDDEV':
        measures.push(`SUM(${r.sql})`, `SUM(${r.sql} * ${r.sql})`, `COUNT(${r.sql})`);
        break;
      case 'AVG_AGE':
        measures.push(`AVG(julianday(?) - julianday(${r.sql}))`);
        selectParams.push(measure.asOf ?? '');
        break;
      default:
        measures.push(`${measure.fn}(${r.sql})`);
    }
  }
  let predicateSql: string | null = null;
  if (predicate) {
    const [a, b] = predicate.args.map((f) => compiler.resolve(f));
    if (!a || !b) throw new InvalidError(`Invalid predicate ${predicate.name}(${predicate.args.join(',')})`);
    predicateSql = `(${a.sql} IS NOT NULL AND ${b.sql} IS NOT NULL AND substr(${a.sql}, 1, 10) = substr(${b.sql}, 1, 10))`;
  }
  const c = compiler.build(qb.parsed());
  const select = [
    ...groups.map((g, i) => `${g.expr} AS g${i}`),
    'COUNT(*) AS cnt',
    ...measures.map((m, i) => `${m} AS m${i}`),
  ];
  let sql = `SELECT ${select.join(', ')} FROM ${c.from} ${c.joins.join(' ')} WHERE ${c.where}`;
  if (predicateSql) sql += ` AND ${predicateSql}`;
  if (groups.length) sql += ` GROUP BY ${groups.map((_, i) => `g${i}`).join(', ')}`;
  const rows = ctx.platform.db.all<Record<string, unknown>>(sql, [...selectParams, ...c.params]);
  return rows.map((r) => {
    const count = Number(r.cnt ?? 0);
    let value: number | null;
    if (measure.fn === 'COUNT') value = count;
    else if (measure.fn === 'STDDEV') value = stddev(r.m0, r.m1, r.m2);
    else value = r.m0 === null || r.m0 === undefined ? null : Number(r.m0);
    return {
      keys: groups.map((g, i) => {
        const raw = r[`g${i}`];
        if (raw === null || raw === undefined) return '';
        if (!g.bucketed && g.col?.type === 'boolean') return Number(raw) === 1 ? 'true' : 'false';
        return String(raw);
      }),
      count,
      value,
    };
  });
}

/** Sample standard deviation from SUM(x), SUM(x*x) and COUNT(x); null below two values. */
function stddev(sum: unknown, sumSq: unknown, n: unknown): number | null {
  const s = Number(sum ?? 0);
  const s2 = Number(sumSq ?? 0);
  const k = Number(n ?? 0);
  if (k < 2) return null;
  const variance = (s2 - (s * s) / k) / (k - 1);
  return Math.sqrt(Math.max(0, variance));
}
