import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '../../engine/errors.js';
import { type ApiDeps, baseUrl, ctxOf, HttpError, nowRoute, queryParam, versionedRoute } from '../http.js';
import { type SerializeOptions, serializeRecord } from '../serialize.js';
import { linkHeader, listQuery } from './table.js';

type Q = Record<string, unknown>;

const ACCOUNT_TABLE = 'customer_account';

/**
 * Account API (GET /api/now/account and /api/now/account/{id}) over `customer_account`.
 * Records are flat: every value is a string and references are bare sys_ids. The API is
 * available when a module installs the customer_account table.
 */
export function registerAccountApi(app: FastifyInstance, deps: ApiDeps): void {
  const prepare = (req: Parameters<typeof ctxOf>[0]) => {
    const ctx = ctxOf(req, deps);
    const table = ctx.registry.tryTable(ACCOUNT_TABLE);
    if (!table)
      throw new HttpError(
        400,
        'Requested URI does not represent any resource',
        'The account table is not installed',
      );
    if (!ctx.hasRole('csm_ws_integration'))
      throw new HttpError(403, 'Operation Failed', 'The csm_ws_integration role is required');
    const opts: SerializeOptions = {
      displayValue: 'false',
      excludeReferenceLink: true,
      fields: [],
      baseUrl: baseUrl(req, deps),
      table,
      strict: true,
    };
    return { ctx, table, opts };
  };

  nowRoute(app, 'GET', '/account', async (req, reply) => {
    const { ctx, table, opts } = prepare(req);
    const q = req.query as Q;
    const n = Number.parseInt(String(queryParam(q.sysparm_limit) ?? ''), 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 10;
    const o = Number.parseInt(String(queryParam(q.sysparm_offset) ?? ''), 10);
    const offset = Number.isFinite(o) && o > 0 ? o : 0;
    const lq = listQuery(req, ctx, table, { sysparm_query: queryParam(q.sysparm_query) ?? '' });
    const recs = lq.noRows ? [] : ctx.query(table.name, { query: lq.query, limit, offset });
    const total = lq.noRows ? 0 : ctx.count(table.name, lq.query);
    reply.header('X-Total-Count', String(total));
    reply.header('Link', linkHeader(req, baseUrl(req, deps), total, limit, offset, recs.length));
    return { result: recs.map((r) => serializeRecord(ctx, r, opts)), hasMore: offset + limit < total };
  });

  nowRoute(app, 'GET', '/account/:id', async (req) => {
    const { ctx, table, opts } = prepare(req);
    const rec = ctx.get(table.name, (req.params as { id: string }).id);
    if (!rec) throw new NotFoundError();
    return { result: serializeRecord(ctx, rec, opts) };
  });
}

/**
 * User Role Inheritance API: GET /api/global/user_role_inheritance?user_sysid=...
 * Lists how a user holds each role: `/<role>` for a direct grant (extended by one segment
 * per contained role) and `[<group>]/<role>` for roles that come from a group.
 */
export function registerRoleInheritanceApi(app: FastifyInstance, deps: ApiDeps): void {
  versionedRoute(app, 'GET', '/api/global', '/user_role_inheritance', async (req) => {
    const ctx = ctxOf(req, deps);
    if (!ctx.hasRole('user_admin'))
      throw new HttpError(403, 'Operation Failed', 'The user_admin role is required');
    const userId = queryParam((req.query as Q).user_sysid)?.trim();
    if (!userId) throw new HttpError(400, 'Missing required parameter', 'user_sysid must be supplied');
    const db = deps.platform.db;
    const user = db.get<{ user_name: string }>(`SELECT "user_name" FROM "sys_user" WHERE "sys_id" = ?`, [
      userId,
    ]);
    if (!user) throw new HttpError(404, 'No Record found', `User ${userId} does not exist`);

    const roleName = new Map<string, string>();
    const nameOf = (id: string) => {
      let n = roleName.get(id);
      if (n === undefined) {
        n =
          db.get<{ name: string }>(`SELECT "name" FROM "sys_user_role" WHERE "sys_id" = ?`, [id])?.name ?? '';
        roleName.set(id, n);
      }
      return n;
    };
    const hasContains = ctx.registry.has('sys_user_role_contains');
    const contained = (id: string) =>
      hasContains
        ? db
            .all<{ contains: string }>(
              `SELECT "contains" FROM "sys_user_role_contains" WHERE "role" = ? ORDER BY rowid`,
              [id],
            )
            .map((r) => r.contains)
        : [];
    const expand = (prefix: string, roleId: string, out: string[], seen: Set<string>) => {
      const name = nameOf(roleId);
      if (!name || seen.has(roleId)) return;
      const path = `${prefix}/${name}`;
      out.push(path);
      const next = new Set(seen).add(roleId);
      for (const c of contained(roleId)) expand(path, c, out, next);
    };

    const fromRole: string[] = [];
    const direct = db.all<{ role: string }>(
      `SELECT "role" FROM "sys_user_has_role" WHERE "user" = ? AND ("state" IS NULL OR "state" = 'active') AND ("inherited" IS NULL OR "inherited" = 0) AND ("granted_by" IS NULL OR "granted_by" = '') ORDER BY rowid`,
      [userId],
    );
    for (const r of direct) expand('', r.role, fromRole, new Set());

    const fromGroup: string[] = [];
    if (ctx.registry.has('sys_group_has_role')) {
      const groups = deps.platform.users.groupsOf(userId);
      const lineage: string[] = [];
      const stack = [...groups];
      while (stack.length) {
        const g = stack.shift()!;
        if (lineage.includes(g)) continue;
        lineage.push(g);
        const parent = db.get<{ parent: string | null }>(
          `SELECT "parent" FROM "sys_user_group" WHERE "sys_id" = ?`,
          [g],
        )?.parent;
        if (parent) stack.push(parent);
      }
      for (const g of lineage) {
        const name =
          db.get<{ name: string }>(`SELECT "name" FROM "sys_user_group" WHERE "sys_id" = ?`, [g])?.name ?? g;
        for (const r of db.all<{ role: string }>(
          `SELECT "role" FROM "sys_group_has_role" WHERE "group" = ? ORDER BY rowid`,
          [g],
        )) {
          expand(`[${name}]`, r.role, fromGroup, new Set());
        }
      }
    }
    return { result: { user_name: user.user_name, from_role: fromRole, from_group: fromGroup } };
  });
}
