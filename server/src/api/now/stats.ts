import type { FastifyInstance } from 'fastify';
import type { Context } from '../../engine/context.js';
import type { SqlParam } from '../../engine/db.js';
import { QueryCompiler } from '../../engine/query/compiler.js';
import { QueryBuilder } from '../../engine/querybuilder.js';
import type { ColumnMeta, TableMeta } from '../../engine/types.js';
import { NUMERIC_TYPES } from '../../engine/types.js';
import { type ApiDeps, ctxOf, HttpError, nowRoute, queryParam } from '../http.js';
import { parseBool, parseDisplayMode, parseFields } from '../serialize.js';
import { listQuery, tableOf } from './table.js';

type Q = Record<string, unknown>;
type Agg = 'AVG' | 'SUM' | 'MIN' | 'MAX';

const HAVING_RE = /^(count|avg|sum|min|max)\^([a-z0-9_.*]+)\^(>=|<=|!=|>|<|=)\^(-?\d+(?:\.\d+)?)$/i;

interface AggExpr {
  fn: Agg;
  field: string;
  sql: string;
  col: ColumnMeta | null;
  /** Requested by the client (false for expressions used only by sysparm_order_by). */
  output: boolean;
}

/** Formats an aggregate as the platform does: strings, averages with four decimals, durations in seconds. */
function formatAgg(a: AggExpr, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const isNumeric = !!a.col && NUMERIC_TYPES.has(a.col.type);
  if (!isNumeric && a.fn !== 'AVG' && a.fn !== 'SUM') return String(raw);
  let n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  if (a.col?.type === 'glide_duration') n /= 1000;
  if (a.fn === 'AVG') return n.toFixed(4);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

function groupDisplay(ctx: Context, col: ColumnMeta | null, table: TableMeta, value: string): string {
  if (!col || value === '') return value;
  if ((col.type === 'reference' || col.type === 'document_id') && col.reference)
    return ctx.displayOf(col.reference, value) || value;
  if (col.type === 'boolean') return value === '1' || value === 'true' ? 'true' : 'false';
  if (col.type === 'sys_class_name') return ctx.registry.tryTable(value)?.label ?? value;
  return ctx.platform.choices.label(table.name, col.name, value) ?? value;
}

/** Aggregate API: GET /api/now/stats/{tableName}. */
export function registerStatsApi(app: FastifyInstance, deps: ApiDeps): void {
  nowRoute(app, 'GET', '/stats/:tableName', async (req) => {
    const ctx = ctxOf(req, deps);
    const { tableName } = req.params as { tableName: string };
    const meta = tableOf(deps, tableName);
    const q = req.query as Q;
    const d = deps.platform.acl.canTable(ctx, meta.name, 'read');
    if (!d.allowed)
      throw new HttpError(403, 'Insufficient rights to query records', `ACL denied read on ${tableName}`);

    const lq = listQuery(req, ctx, meta, q);
    const qb = new QueryBuilder(meta.name).addEncodedQuery(lq.query);
    if (lq.noRows) qb.addEncodedQuery('sys_idISEMPTY');
    // Query business rules (row-level restrictions) also apply to aggregates.
    if (ctx.workflow && !ctx.user.isSystem) {
      for (const rule of deps.platform.rules.select(meta.name, 'before', 'query')) {
        try {
          rule.query?.(qb, ctx);
        } catch (e) {
          deps.platform.reportError(`query rule ${rule.id}`, e);
        }
      }
    }
    const compiler = new QueryCompiler(ctx.registry, meta, ctx.env);

    const groups: { field: string; expr: string; col: ColumnMeta | null; table: TableMeta }[] = [];
    for (const g of parseFields(q.sysparm_group_by)) {
      const r = compiler.resolve(g);
      if (r?.col?.storage) groups.push({ field: g, expr: r.sql, col: r.col, table: r.table });
    }
    const aggs: AggExpr[] = [];
    const addAgg = (fn: Agg, field: string, output: boolean): AggExpr | null => {
      const existing = aggs.find((a) => a.fn === fn && a.field === field);
      if (existing) {
        existing.output ||= output;
        return existing;
      }
      const r = compiler.resolve(field);
      if (!r?.col?.storage) return null;
      const a: AggExpr = { fn, field, sql: `${fn}(${r.sql})`, col: r.col, output };
      aggs.push(a);
      return a;
    };
    for (const [param, fn] of [
      ['sysparm_avg_fields', 'AVG'],
      ['sysparm_min_fields', 'MIN'],
      ['sysparm_max_fields', 'MAX'],
      ['sysparm_sum_fields', 'SUM'],
    ] as const) {
      for (const f of parseFields(q[param])) addAgg(fn, f, true);
    }
    const wantCount = parseBool(q.sysparm_count);

    const having: { sql: string; value: number }[] = [];
    for (const h of parseFields(q.sysparm_having)) {
      const m = HAVING_RE.exec(h);
      if (!m)
        throw new HttpError(
          400,
          `Invalid sysparm_having expression ${h}`,
          'Expected aggregate^field^operator^value',
        );
      const fn = m[1].toUpperCase();
      const field = m[2];
      const r = field === '*' ? null : compiler.resolve(field);
      if (field === '*' ? fn !== 'COUNT' : !r?.col?.storage) {
        throw new HttpError(400, `Invalid sysparm_having expression ${h}`, `Unknown field ${field}`);
      }
      having.push({ sql: `${fn}(${r ? r.sql : '*'}) ${m[3] === '!=' ? '<>' : m[3]} ?`, value: Number(m[4]) });
    }

    const order: string[] = [];
    for (const o of parseFields(q.sysparm_order_by)) {
      const parts = o.split('^').map((p) => p.trim());
      let desc = false;
      if (parts.length > 1 && /^(desc|asc)$/i.test(parts[parts.length - 1]))
        desc = parts.pop()!.toUpperCase() === 'DESC';
      const dir = desc ? 'DESC' : 'ASC';
      if (parts.length === 1 && parts[0].toUpperCase() === 'COUNT') {
        order.push(`cnt ${dir}`);
      } else if (parts.length === 2 && /^(avg|sum|min|max)$/i.test(parts[0])) {
        const a = addAgg(parts[0].toUpperCase() as Agg, parts[1], false);
        if (a) order.push(`a${aggs.indexOf(a)} ${dir}`);
      } else if (parts.length === 2 && parts[0].toUpperCase() === 'COUNT') {
        order.push(`cnt ${dir}`);
      } else if (parts.length === 1) {
        const gi = groups.findIndex((g) => g.field === parts[0]);
        if (gi >= 0) order.push(`g${gi} ${dir}`);
      }
    }

    const c = compiler.build(qb.parsed());
    const select = [
      ...groups.map((g, i) => `${g.expr} AS g${i}`),
      'COUNT(*) AS cnt',
      ...aggs.map((a, i) => `${a.sql} AS a${i}`),
    ];
    let sql = `SELECT ${select.join(', ')} FROM ${c.from} ${c.joins.join(' ')} WHERE ${c.where}`;
    const params: SqlParam[] = [...c.params];
    if (groups.length) sql += ` GROUP BY ${groups.map((_, i) => `g${i}`).join(', ')}`;
    if (having.length) {
      sql += ` HAVING ${having.map((h) => h.sql).join(' AND ')}`;
      params.push(...having.map((h) => h.value));
    }
    if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
    else if (groups.length) sql += ` ORDER BY ${groups.map((_, i) => `g${i}`).join(', ')}`;
    const rows = deps.platform.db.all<Record<string, unknown>>(sql, params);

    const display = parseDisplayMode(queryParam(q.sysparm_display_value));
    const statsOf = (r: Record<string, unknown>) => {
      const stats: Record<string, unknown> = {};
      if (wantCount) stats.count = String(r.cnt ?? 0);
      aggs.forEach((a, i) => {
        if (!a.output) return;
        const key = a.fn.toLowerCase();
        const bucket = (stats[key] ??= {}) as Record<string, string>;
        bucket[a.field] = formatAgg(a, r[`a${i}`]);
      });
      return stats;
    };
    if (!groups.length) {
      return { result: { stats: statsOf(rows[0] ?? { cnt: 0 }) } };
    }
    return {
      result: rows.map((r) => ({
        stats: statsOf(r),
        groupby_fields: groups.map((g, i) => {
          const raw = r[`g${i}`];
          let value = raw === null || raw === undefined ? '' : String(raw);
          if (g.col?.type === 'boolean' && value !== '') value = value === '1' ? 'true' : 'false';
          if (display === 'false') return { field: g.field, value };
          const disp = groupDisplay(ctx, g.col, g.table, value);
          return display === 'true'
            ? { field: g.field, value: disp }
            : { field: g.field, value, display_value: disp };
        }),
      })),
    };
  });
}
