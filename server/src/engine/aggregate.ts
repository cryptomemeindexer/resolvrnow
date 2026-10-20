import type { Context } from './context.js';
import type { SqlParam } from './db.js';
import { QueryCompiler } from './query/compiler.js';
import { parseEncodedQuery } from './query/parser.js';
import { QueryBuilder } from './querybuilder.js';

export type AggFn = 'COUNT' | 'AVG' | 'SUM' | 'MIN' | 'MAX' | 'COUNT_DISTINCT';

export interface AggregateRequest {
  query?: string | null;
  groupBy?: string[];
  aggregates?: { fn: AggFn; field: string }[];
  /** Include COUNT(*) (default true). */
  count?: boolean;
  /** ORDERBY expressions: field or `COUNT`/`AVG(field)` with optional DESC. */
  orderBy?: { expr: string; desc?: boolean }[];
  /** e.g. [{fn:'COUNT', field:'*', op:'>', value: 2}] */
  having?: { fn: AggFn; field: string; op: '>' | '<' | '=' | '>=' | '<=' | '!='; value: number }[];
  limit?: number;
  /** Group by a date bucket: day|week|month|quarter|year (applied to a date groupBy field). */
  trend?: { field: string; interval: 'day' | 'week' | 'month' | 'quarter' | 'year' };
}

export interface AggregateRow {
  groups: { field: string; value: string; display: string }[];
  count: number;
  values: Record<string, number | null>;
}

const BUCKET: Record<string, string> = {
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
  quarter: 'Q',
  year: '%Y',
};

/** Grouped aggregation used by the Stats API, reports and dashboards. */
export function aggregate(ctx: Context, table: string, req: AggregateRequest): AggregateRow[] {
  const meta = ctx.registry.table(table);
  const qb = new QueryBuilder(table).addEncodedQuery(req.query ?? '');
  // Query business rules (row-level restrictions) also apply to aggregates.
  for (const rule of ctx.platform.rules.select(table, 'before', 'query')) {
    if (!ctx.workflow || ctx.user.isSystem) break;
    rule.query?.(qb, ctx);
  }
  const compiler = new QueryCompiler(ctx.registry, meta, ctx.env);
  const parsed = qb.parsed();
  const groupFields = [...(req.groupBy ?? []), ...parseEncodedQuery(req.query ?? '').groupBy];
  // Resolve group/aggregate expressions before build() so joins get registered.
  const groupExprs = groupFields.map((g) => {
    const r = compiler.resolve(g);
    if (!r) throw new Error(`Invalid group by field ${g}`);
    let expr = r.sql;
    if (req.trend && req.trend.field === g) {
      expr =
        req.trend.interval === 'quarter'
          ? `(strftime('%Y', ${r.sql}) || '-Q' || ((CAST(strftime('%m', ${r.sql}) AS INTEGER) + 2) / 3))`
          : `strftime('${BUCKET[req.trend.interval]}', ${r.sql})`;
    }
    return { field: g, expr, col: r.col };
  });
  const aggExprs = (req.aggregates ?? []).map((a) => {
    const r = compiler.resolve(a.field);
    if (!r) throw new Error(`Invalid aggregate field ${a.field}`);
    const sql = a.fn === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${r.sql})` : `${a.fn}(${r.sql})`;
    return { key: `${a.fn.toLowerCase()}.${a.field}`, sql };
  });
  const c = compiler.build(parsed);
  const select = [
    ...groupExprs.map((g, i) => `${g.expr} AS g${i}`),
    'COUNT(*) AS cnt',
    ...aggExprs.map((a, i) => `${a.sql} AS a${i}`),
  ];
  let sql = `SELECT ${select.join(', ')} FROM ${c.from} ${c.joins.join(' ')} WHERE ${c.where}`;
  const params: SqlParam[] = [...c.params];
  if (groupExprs.length) sql += ` GROUP BY ${groupExprs.map((_, i) => `g${i}`).join(', ')}`;
  if (req.having?.length) {
    const hs = req.having.map((h) => {
      const r = h.field === '*' ? { sql: '*' } : compiler.resolve(h.field);
      if (!r) throw new Error(`Invalid having field ${h.field}`);
      params.push(h.value);
      return `${h.fn === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${r.sql})` : `${h.fn}(${r.sql})`} ${h.op} ?`;
    });
    sql += ` HAVING ${hs.join(' AND ')}`;
  }
  if (req.orderBy?.length) {
    const os = req.orderBy.map((o) => {
      const e = o.expr.toUpperCase() === 'COUNT' ? 'cnt' : (() => {
        const gi = groupExprs.findIndex((g) => g.field === o.expr);
        if (gi >= 0) return `g${gi}`;
        const ai = aggExprs.findIndex((a) => a.key.toUpperCase() === o.expr.toUpperCase().replace('(', '.').replace(')', ''));
        return ai >= 0 ? `a${ai}` : 'cnt';
      })();
      return `${e} ${o.desc ? 'DESC' : 'ASC'}`;
    });
    sql += ` ORDER BY ${os.join(', ')}`;
  } else if (groupExprs.length) {
    sql += ` ORDER BY ${groupExprs.map((_, i) => `g${i}`).join(', ')}`;
  }
  if (req.limit) {
    sql += ' LIMIT ?';
    params.push(req.limit);
  }
  const rows = ctx.platform.db.all<Record<string, unknown>>(sql, params);
  return rows.map((r) => ({
    groups: groupExprs.map((g, i) => {
      const raw = r[`g${i}`];
      const value = raw === null || raw === undefined ? '' : String(raw);
      let display = value;
      if (g.col && value && !req.trend) {
        if ((g.col.type === 'reference' || g.col.type === 'document_id') && g.col.reference) {
          display = ctx.displayOf(g.col.reference, value) || value;
        } else {
          display = ctx.platform.choices.label(g.col.definedOn, g.col.name, value) ??
            (g.col.type === 'boolean' ? (value === '1' ? 'true' : 'false') : value);
        }
      }
      if (g.col?.type === 'boolean' && value !== '') return { field: g.field, value: value === '1' ? 'true' : 'false', display };
      return { field: g.field, value, display };
    }),
    count: Number(r.cnt ?? 0),
    values: Object.fromEntries(aggExprs.map((a, i) => [a.key, r[`a${i}`] === null ? null : Number(r[`a${i}`])])),
  }));
}
