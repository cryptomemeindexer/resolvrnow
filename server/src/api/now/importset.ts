import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import type { TableMeta } from '../../engine/types.js';
import { isSysId } from '../../engine/util.js';
import {
  IMPORT_SET_SERVICE,
  type ImportSetService,
  type TransformResult,
} from '../../modules/importset/service.js';
import { type ApiDeps, baseUrl, ctxOf, HttpError, nowRoute, queryParam } from '../http.js';

/**
 * Import Set API: POST /api/now/import/{staging} (one row, synchronous transform),
 * POST /api/now/import/{staging}/insertMultiple (many rows, asynchronous by default) and
 * GET /api/now/import/{staging}/{sys_id}. Responses have no `result` wrapper object.
 */

type Q = Record<string, unknown>;

/** Staging values are strings; nested objects are flattened with `=` between key and value. */
export function stagingValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v).replace(/"((?:[^"\\]|\\.)*)":/g, '"$1"=');
  return String(v);
}

function serviceOf(deps: ApiDeps): ImportSetService {
  const s = deps.platform.services.get(IMPORT_SET_SERVICE) as ImportSetService | undefined;
  if (!s)
    throw new HttpError(
      400,
      'Requested URI does not represent any resource',
      'The import set module is not installed',
    );
  return s;
}

function stagingTable(ctx: Context, deps: ApiDeps, name: string): TableMeta {
  const svc = serviceOf(deps);
  const t = ctx.registry.tryTable(name);
  if (!t || !svc.isStagingTable(name))
    throw new HttpError(400, `Invalid table ${name}`, 'The table is not an import set staging table');
  return t;
}

function requireCreate(ctx: Context, table: TableMeta): void {
  if (!ctx.platform.acl.canTable(ctx, table.name, 'create').allowed) {
    throw new HttpError(403, 'Operation Failed', 'ACL Exception Insert Failed due to security constraints');
  }
}

/** Response entries in the documented key order, with a Table API link to the target record. */
function resultEntries(
  req: FastifyRequest,
  deps: ApiDeps,
  results: TransformResult[],
): Record<string, unknown>[] {
  const base = baseUrl(req, deps);
  return results.map((r) => {
    const { transform_map, table, display_name, display_value, status, sys_id, ...extra } = r;
    return {
      transform_map,
      table,
      display_name,
      display_value,
      record_link: sys_id ? `${base}/api/now/table/${table}/${sys_id}` : '',
      status,
      sys_id,
      ...extra,
    };
  });
}

/**
 * Maps request keys to staging columns. Single-row posts use column names; insertMultiple
 * uses column labels by default. The other form is accepted as a fallback.
 */
function stagingValues(
  table: TableMeta,
  record: Record<string, unknown>,
  prefer: 'name' | 'label',
): Record<string, string> {
  const loadable = (name: string | undefined) => {
    const c = name ? table.columns.get(name) : undefined;
    return !!c && !!c.storage && !c.system && !c.internal && !c.name.startsWith('sys_');
  };
  const byLabel = new Map<string, string>();
  for (const c of table.columns.values())
    if (loadable(c.name)) byLabel.set(c.label.trim().toLowerCase(), c.name);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    const byName = loadable(k) ? k : undefined;
    const label = byLabel.get(k.trim().toLowerCase());
    const col = prefer === 'name' ? (byName ?? label) : (label ?? byName);
    if (col) out[col] = stagingValue(v);
  }
  return out;
}

export function registerImportSetApi(app: FastifyInstance, deps: ApiDeps): void {
  nowRoute(app, 'POST', '/import/:staging', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { staging } = req.params as { staging: string };
    const table = stagingTable(ctx, deps, staging);
    requireCreate(ctx, table);
    let body = req.body as unknown;
    if (Array.isArray(body)) body = body[0];
    if (!body || typeof body !== 'object')
      throw new HttpError(400, 'Exception while reading request', 'The payload must be an object');
    const svc = serviceOf(deps);
    const set = svc.syncImportSet(ctx, table.name);
    const row = svc.insertRow(
      ctx,
      set,
      table.name,
      stagingValues(table, body as Record<string, unknown>, 'name'),
    );
    const results = svc.transformRow(ctx, row);
    reply.code(201);
    return {
      import_set: set.str('number'),
      staging_table: table.name,
      result: resultEntries(req, deps, results),
    };
  });

  nowRoute(app, 'POST', '/import/:staging/insertMultiple', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { staging } = req.params as { staging: string };
    const q = req.query as Q;
    const table = stagingTable(ctx, deps, staging);
    requireCreate(ctx, table);
    const body = req.body as { records?: unknown } | null;
    if (!body || typeof body !== 'object' || !Array.isArray(body.records)) {
      throw new HttpError(400, 'Exception while reading request', 'The payload must contain a records array');
    }
    const svc = serviceOf(deps);
    const sys = ctx.asSystem();
    const config = sys.first('sys_rest_insert_multiple', `source_table=${table.name}^active!=false`);
    const mapping = config?.str('column_mapping') === 'name' ? 'name' : 'label';
    const synchronous = config?.str('transform') === 'synchronous';

    let multi: Rec;
    const multiId = queryParam(q.multi_import_set_id);
    if (multiId) {
      const found = isSysId(multiId) ? sys.get('sys_multi_import_set', multiId) : null;
      if (!found)
        throw new HttpError(404, 'No Record found', `Multiple import set ${multiId} does not exist`);
      multi = found;
    } else {
      multi = svc.createMultiImportSet(ctx, table.name);
    }
    const runAfter = queryParam(q.run_after);
    if (runAfter && !(isSysId(runAfter) && sys.get('sys_import_set', runAfter))) {
      throw new HttpError(404, 'No Record found', `Import set ${runAfter} does not exist`);
    }
    const set = svc.createImportSet(ctx, table.name, synchronous ? 'synchronous' : 'asynchronous', {
      multiImportSet: multi.sysId,
      runAfter: runAfter || undefined,
    });
    for (const rec of body.records) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      svc.insertRow(ctx, set, table.name, stagingValues(table, rec as Record<string, unknown>, mapping));
    }
    svc.markLoaded(ctx, set);
    const user = ctx.user;
    if (synchronous) {
      svc.transformSet(ctx, set.sysId);
    } else {
      // Runs after the request, in order, like the platform's scheduled transform.
      deps.platform.enqueueAsync(`importset:${set.sysId}`, () =>
        svc.transformSet(deps.platform.contextFor(user), set.sysId),
      );
    }
    reply.code(201);
    return { import_set_id: set.sysId, multi_import_set_id: multi.sysId };
  });

  nowRoute(app, 'GET', '/import/:staging/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { staging, sysId } = req.params as { staging: string; sysId: string };
    const table = stagingTable(ctx, deps, staging);
    const row = ctx.get(table.name, sysId);
    if (!row) throw new NotFoundError();
    const set = row.str('sys_import_set')
      ? ctx.asSystem().get('sys_import_set', row.str('sys_import_set'))
      : null;
    return {
      import_set: set?.str('number') ?? '',
      staging_table: table.name,
      result: resultEntries(req, deps, serviceOf(deps).results(row)),
    };
  });
}
