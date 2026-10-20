import type { FastifyInstance } from 'fastify';
import { type AggFn, aggregate } from '../../engine/aggregate.js';
import { type ApiDeps, ctxOf, HttpError, nowRoute } from '../http.js';
import { parseBool, parseDisplayMode, parseFields } from '../serialize.js';

type Q = Record<string, string | undefined>;

const HAVING_RE = /^(count|avg|sum|min|max)\^([a-z0-9_.*]+)\^(>|<|=|>=|<=|!=)\^(-?\d+(?:\.\d+)?)$/i;

/** Aggregate API: GET /api/now/stats/{tableName}. */
export function registerStatsApi(app: FastifyInstance, deps: ApiDeps): void {
  nowRoute(app, 'GET', '/stats/:tableName', async (req) => {
    const ctx = ctxOf(req, deps);
    const { tableName } = req.params as { tableName: string };
    if (!deps.platform.registry.has(tableName)) throw new HttpError(400, `Invalid table ${tableName}`);
    const q = req.query as Q;
    const meta = deps.platform.registry.table(tableName);
    const d = deps.platform.acl.canTable(ctx, meta.name, 'read');
    if (!d.allowed) throw new HttpError(403, 'Insufficient rights to query records', `ACL denied read on ${tableName}`);
    const aggregates: { fn: AggFn; field: string }[] = [];
    for (const [param, fn] of [
      ['sysparm_avg_fields', 'AVG'],
      ['sysparm_sum_fields', 'SUM'],
      ['sysparm_min_fields', 'MIN'],
      ['sysparm_max_fields', 'MAX'],
    ] as const) {
      for (const f of parseFields(q[param])) aggregates.push({ fn, field: f });
    }
    const groupBy = parseFields(q.sysparm_group_by);
    const having = parseFields(q.sysparm_having).map((h) => {
      const m = HAVING_RE.exec(h);
      if (!m) throw new HttpError(400, `Invalid sysparm_having expression ${h}`);
      return { fn: m[1].toUpperCase() as AggFn, field: m[2], op: m[3] as '>', value: Number(m[4]) };
    });
    const orderBy = parseFields(q.sysparm_order_by).map((o) => {
      const desc = /\^DESC$/i.test(o);
      return { expr: o.replace(/\^(DESC|ASC)$/i, ''), desc };
    });
    const rows = aggregate(ctx, tableName, { query: q.sysparm_query, groupBy, aggregates, having, orderBy });
    const display = parseDisplayMode(q.sysparm_display_value);
    const wantCount = parseBool(q.sysparm_count) || (aggregates.length === 0);
    const statsOf = (r: (typeof rows)[number]) => {
      const stats: Record<string, unknown> = {};
      if (wantCount) stats.count = String(r.count);
      for (const a of aggregates) {
        const key = a.fn.toLowerCase();
        const bucket = (stats[key] ??= {}) as Record<string, string>;
        const v = r.values[`${key}.${a.field}`];
        bucket[a.field] = v === null || v === undefined ? '' : String(Number.isInteger(v) ? v : Number(v.toFixed(4)));
      }
      return stats;
    };
    if (!groupBy.length) {
      const r = rows[0] ?? { groups: [], count: 0, values: {} };
      return { result: { stats: statsOf(r) } };
    }
    return {
      result: rows.map((r) => ({
        stats: statsOf(r),
        groupby_fields: r.groups.map((g) =>
          display === 'false' ? { field: g.field, value: g.value } : { field: g.field, value: g.value, display_value: g.display },
        ),
      })),
    };
  });
}
