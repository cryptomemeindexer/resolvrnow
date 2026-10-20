import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { JOURNAL_TYPES } from '../../engine/types.js';
import { type ApiDeps, baseUrl, ctxOf, HttpError, intParam, nowRoute } from '../http.js';
import { parseBool, parseDisplayMode, parseFields, type SerializeOptions, serializeRecord } from '../serialize.js';

type Q = Record<string, string | undefined>;

function tableOf(deps: ApiDeps, name: string) {
  const t = deps.platform.registry.tryTable(name);
  if (!t) throw new HttpError(400, `Invalid table ${name}`);
  return t;
}

export function serializeOptions(req: FastifyRequest, deps: ApiDeps): SerializeOptions {
  const q = req.query as Q;
  return {
    displayValue: parseDisplayMode(q.sysparm_display_value),
    excludeReferenceLink: parseBool(q.sysparm_exclude_reference_link),
    fields: parseFields(q.sysparm_fields),
    baseUrl: baseUrl(req, deps),
  };
}

/** Drops fields the caller may not write; system fields are never client-writable (except sys_id on insert). */
export function writableBody(ctx: Context, rec: Rec, body: Record<string, unknown>, isInsert: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const col = rec.column(k);
    if (!col) continue;
    if (k === 'sys_id') {
      if (isInsert) out[k] = v;
      continue;
    }
    if (col.system && k !== 'sys_class_name') continue;
    if (k === 'sys_class_name' && !isInsert) continue;
    if (!JOURNAL_TYPES.has(col.type) && !ctx.platform.acl.canField(ctx, rec.className, k, isInsert ? 'create' : 'write', rec)) {
      // Field-level create ACLs are rare; fall back to write ACLs on insert.
      if (!isInsert || !ctx.platform.acl.canField(ctx, rec.className, k, 'write', rec)) continue;
    }
    out[k] = v;
  }
  return out;
}

function linkHeader(req: FastifyRequest, deps: ApiDeps, total: number, limit: number, offset: number): string {
  const url = new URL(req.url, baseUrl(req, deps));
  const make = (off: number) => {
    const u = new URL(url.toString());
    u.searchParams.set('sysparm_limit', String(limit));
    u.searchParams.set('sysparm_offset', String(off));
    return `<${baseUrl(req, deps)}${u.pathname}?${u.searchParams.toString()}>`;
  };
  const links = [`${make(0)};rel="first"`];
  if (offset > 0) links.push(`${make(Math.max(0, offset - limit))};rel="prev"`);
  if (offset + limit < total) links.push(`${make(offset + limit)};rel="next"`);
  const lastOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
  links.push(`${make(lastOffset)};rel="last"`);
  return links.join(',');
}

export function registerTableApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;

  nowRoute(app, 'GET', '/table/:tableName', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { tableName } = req.params as { tableName: string };
    const q = req.query as Q;
    tableOf(deps, tableName);
    const maxLimit = platform.properties.getNumber('glide.rest.query.max_limit', 10000);
    const limit = intParam(q.sysparm_limit, maxLimit, 1, maxLimit);
    const offset = intParam(q.sysparm_offset, 0, 0);
    const query = q.sysparm_query ?? '';
    const recs = ctx.query(tableName, { query, limit, offset });
    const opts = serializeOptions(req, deps);
    const result = recs.map((r) => serializeRecord(ctx, r, opts));
    if (!parseBool(q.sysparm_no_count)) {
      const total = ctx.count(tableName, query);
      reply.header('X-Total-Count', String(total));
      if (!parseBool(q.sysparm_suppress_pagination_header)) reply.header('Link', linkHeader(req, deps, total, limit, offset));
    }
    return { result };
  });

  nowRoute(app, 'GET', '/table/:tableName/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { tableName, sysId } = req.params as { tableName: string; sysId: string };
    tableOf(deps, tableName);
    const rec = ctx.get(tableName, sysId);
    if (!rec) throw new NotFoundError();
    return { result: serializeRecord(ctx, rec, serializeOptions(req, deps)) };
  });

  nowRoute(app, 'POST', '/table/:tableName', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { tableName } = req.params as { tableName: string };
    const q = req.query as Q;
    tableOf(deps, tableName);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new InvalidError('Exception while reading request', 'The payload is not valid JSON.');
    }
    let draft = ctx.newRecord(tableName);
    const cls = (body as Record<string, unknown>).sys_class_name;
    if (typeof cls === 'string' && cls !== tableName && platform.registry.isA(cls, tableName)) draft = ctx.newRecord(cls);
    const values = writableBody(ctx, draft, body as Record<string, unknown>, true);
    const { sys_class_name: _c, ...rest } = values;
    const rec = ctx.insert(draft, rest, {
      displayValue: parseBool(q.sysparm_input_display_value),
      autoSysFields: !parseBool(q.sysparm_suppress_auto_sys_field),
    });
    const fresh = ctx.derive({ acl: false }).get(rec.className, rec.sysId) ?? rec;
    reply.code(201).header('Location', `${baseUrl(req, deps)}/api/now/table/${tableName}/${rec.sysId}`);
    return { result: serializeRecord(ctx, fresh, serializeOptions(req, deps)) };
  });

  const update = async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    const { tableName, sysId } = req.params as { tableName: string; sysId: string };
    const q = req.query as Q;
    tableOf(deps, tableName);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new InvalidError('Exception while reading request', 'The payload is not valid JSON.');
    }
    const rec = ctx.get(tableName, sysId);
    if (!rec) throw new NotFoundError();
    const values = writableBody(ctx, rec, body as Record<string, unknown>, false);
    ctx.update(rec, values, {
      displayValue: parseBool(q.sysparm_input_display_value),
      autoSysFields: !parseBool(q.sysparm_suppress_auto_sys_field),
    });
    const fresh = ctx.derive({ acl: false }).get(rec.className, rec.sysId) ?? rec;
    return { result: serializeRecord(ctx, fresh, serializeOptions(req, deps)) };
  };
  nowRoute(app, 'PUT', '/table/:tableName/:sysId', update);
  nowRoute(app, 'PATCH', '/table/:tableName/:sysId', update);

  nowRoute(app, 'DELETE', '/table/:tableName/:sysId', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { tableName, sysId } = req.params as { tableName: string; sysId: string };
    tableOf(deps, tableName);
    const rec = ctx.get(tableName, sysId);
    if (!rec) throw new NotFoundError();
    ctx.delete(rec);
    return reply.code(204).send();
  });
}
