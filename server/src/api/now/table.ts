import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Context } from '../../engine/context.js';
import { AccessError, NotFoundError } from '../../engine/errors.js';
import { QueryCompiler } from '../../engine/query/compiler.js';
import { fromLocal, glide, normalizeZone } from '../../engine/query/datetime.js';
import { DYNAMIC_FILTERS, registerDynamicFilter } from '../../engine/query/macros.js';
import { type ParsedQuery, parseEncodedQuery, stringifyQuery } from '../../engine/query/parser.js';
import { checkQuery } from '../../engine/query/validate.js';
import type { Rec } from '../../engine/record.js';
import type { ColumnMeta, TableMeta } from '../../engine/types.js';
import { isSysId, quoteIdent } from '../../engine/util.js';
import {
  type ApiDeps,
  apiVersion,
  baseUrl,
  ctxOf,
  debugLog,
  HttpError,
  nowRoute,
  queryParam,
} from '../http.js';
import {
  parseBool,
  parseDisplayMode,
  parseFields,
  type SerializeOptions,
  serializeRecord,
  viewFields,
} from '../serialize.js';

type Q = Record<string, unknown>;

/** The table named in the URL; unknown tables are a 400 like on the platform. */
export function tableOf(deps: ApiDeps, name: string): TableMeta {
  const t = deps.platform.registry.tryTable(name);
  if (!t) throw new HttpError(400, `Invalid table ${name}`);
  return t;
}

/** Serialization options from the standard sysparm parameters (REST mode). */
export function serializeOptions(req: FastifyRequest, deps: ApiDeps, table?: TableMeta): SerializeOptions {
  const q = req.query as Q;
  const view = queryParam(q.sysparm_view);
  return {
    displayValue: parseDisplayMode(queryParam(q.sysparm_display_value)),
    excludeReferenceLink: parseBool(q.sysparm_exclude_reference_link),
    fields: parseFields(q.sysparm_fields),
    baseUrl: baseUrl(req, deps),
    table,
    viewFields: table && view ? viewFields(deps.platform, table, view) : null,
    strict: true,
  };
}

function isChoiceField(ctx: Context, table: string, col: ColumnMeta): boolean {
  return col.type === 'choice' || !!col.choices?.length || ctx.platform.choices.hasChoices(table, col.name);
}

/** Date-time input given in the user's time zone (sysparm_input_display_value=true), as UTC. */
function localInputToUtc(value: unknown, tz: string | null): unknown {
  if (typeof value !== 'string' || !tz) return value;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*$/.exec(value);
  if (!m) return value;
  return glide(fromLocal(tz, +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)));
}

/**
 * Drops fields the caller may not write. System fields are never client-writable (except
 * sys_id and the class on insert), unknown names are ignored, and an empty string leaves a
 * choice field unchanged. With `inputDisplayValue`, date-times are read in the user's zone.
 */
export function writableBody(
  ctx: Context,
  rec: Rec,
  body: Record<string, unknown>,
  isInsert: boolean,
  opts: { inputDisplayValue?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tz = opts.inputDisplayValue ? normalizeZone(ctx.user.timeZone) : null;
  for (const [k, v] of Object.entries(body)) {
    const col = rec.column(k);
    if (!col) continue;
    if (k === 'sys_id') {
      if (isInsert) out[k] = v;
      continue;
    }
    if (col.system && k !== 'sys_class_name') continue;
    if (k === 'sys_class_name' && !isInsert) continue;
    if (v === '' && isChoiceField(ctx, rec.className, col)) continue;
    // Journal fields (work notes, comments) are checked like any other field.
    if (!ctx.platform.acl.canField(ctx, rec.className, k, isInsert ? 'create' : 'write', rec)) continue;
    out[k] = col.type === 'glide_date_time' || col.type === 'due_date' ? localInputToUtc(v, tz) : v;
  }
  return out;
}

/** The request body as one record: a JSON array contributes its first element only. */
function bodyRecord(req: FastifyRequest): Record<string, unknown> {
  let body = req.body as unknown;
  if (Array.isArray(body)) body = body[0] ?? {};
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object')
    throw new HttpError(400, 'Exception while reading request', 'The payload is not a JSON object.');
  return body as Record<string, unknown>;
}

function noResponseBody(req: FastifyRequest): boolean {
  return parseBool(req.headers['x-no-response-body']);
}

/** Write failures caused by ACLs use the platform's message and detail. */
function writeError(e: unknown, op: 'Insert' | 'Update' | 'Delete'): unknown {
  if (e instanceof AccessError)
    return new HttpError(403, 'Operation Failed', `ACL Exception ${op} Failed due to security constraints`);
  return e;
}

function limitParam(v: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, max);
  return Math.min(n, max);
}

function offsetParam(v: string | undefined): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `field=value` URL pairs as an encoded query (AND). Choice and reference fields accept
 * display values here, which are resolved to stored values.
 */
export function fieldFilters(ctx: Context, table: TableMeta, q: Q): string {
  const terms: string[] = [];
  for (const [k, raw] of Object.entries(q)) {
    if (k.startsWith('sysparm_')) continue;
    const value = queryParam(raw);
    if (value === undefined) continue;
    let stored = value;
    const parts = k.split('.');
    let t: TableMeta | undefined = table;
    let col: ColumnMeta | undefined;
    for (let i = 0; i < parts.length && t; i++) {
      col = t.columns.get(parts[i]);
      if (!col) break;
      if (i < parts.length - 1) t = col.reference ? ctx.registry.tryTable(col.reference) : undefined;
    }
    if (col && t && value !== '') {
      if (col.type === 'reference' && !isSysId(value)) {
        const r = ctx.resolveInput(t, col, value);
        if (typeof r === 'string') stored = r;
      } else if (isChoiceField(ctx, t.name, col)) {
        const r = ctx.platform.choices.resolve(t.name, col.name, value);
        if (r !== undefined) stored = r;
      }
    }
    terms.push(`${k}=${stored.replace(/\^/g, '^^')}`);
  }
  return terms.join('^');
}

/**
 * Dynamic filter options referenced by a query are read from sys_filter_option_dynamic, so
 * options added by administrators work (their script must use the macro allow-list).
 */
function loadDynamicOptions(ctx: Context, parsed: ParsedQuery): void {
  if (!ctx.registry.has('sys_filter_option_dynamic')) return;
  const ids = new Set<string>();
  for (const block of parsed.blocks) {
    for (const cluster of block) {
      for (const c of cluster) {
        if (c.op === 'DYNAMIC') ids.add(c.value.trim());
        if (c.op === 'IN_HIERARCHY_DYNAMIC') ids.add(c.value.replace(/%40/gi, '@').split('@').pop()!.trim());
      }
    }
  }
  for (const id of ids) {
    if (!isSysId(id)) continue;
    const row = ctx.platform.db.get<{ label: string | null; script: string | null; active: number | null }>(
      `SELECT "label","script","active" FROM "sys_filter_option_dynamic" WHERE "sys_id" = ?`,
      [id],
    );
    if (!row?.script || row.active === 0) continue;
    const known = DYNAMIC_FILTERS[id];
    const script = row.script.trim();
    if (!known || known.script.replace(/^javascript:/i, '') !== script.replace(/^javascript:/i, '')) {
      registerDynamicFilter(id, row.label ?? known?.label ?? id, script);
    }
  }
}

export interface ListQuery {
  /** Encoded query to run (validated; dropped terms removed). */
  query: string;
  /** Strict mode (glide.invalid_query.returns_no_rows) with invalid terms: return nothing. */
  noRows: boolean;
  invalid: string[];
}

/**
 * Builds the list query from `sysparm_query` (or the `field=value` pairs when it is absent),
 * validates it for the caller and records ignored terms as session debug lines.
 */
export function listQuery(
  req: FastifyRequest,
  ctx: Context,
  table: TableMeta,
  q: Q = req.query as Q,
): ListQuery {
  const raw = queryParam(q.sysparm_query);
  const encoded = raw !== undefined && raw.trim() !== '' ? raw : fieldFilters(ctx, table, q);
  const parsed = parseEncodedQuery(encoded);
  loadDynamicOptions(ctx, parsed);
  const checked = checkQuery(ctx.registry, table.name, parsed, {
    canRead: (t, f) => ctx.platform.acl.canField(ctx, t, f, 'read'),
  });
  const compiled = QueryCompiler.compile(ctx.registry, table.name, checked.query, ctx.env);
  const invalid = [...checked.dropped, ...compiled.invalid];
  for (const t of invalid) debugLog(req, `Invalid query term ignored: ${t}`);
  const strict = ctx.platform.properties.getBool('glide.invalid_query.returns_no_rows', false);
  return { query: stringifyQuery(checked.query), noRows: strict && invalid.length > 0, invalid };
}

/**
 * `Link` header with first / prev / next / last. Each URL repeats the request's parameters
 * with only sysparm_limit and sysparm_offset replaced. Without a total (sysparm_no_count),
 * `next` is offered when the page was full and `last` is omitted.
 */
export function linkHeader(
  req: FastifyRequest,
  base: string,
  total: number | null,
  limit: number,
  offset: number,
  pageRows: number,
): string {
  const url = new URL(req.url, base);
  const make = (off: number) => {
    const u = new URL(url.toString());
    u.searchParams.set('sysparm_limit', String(limit));
    u.searchParams.set('sysparm_offset', String(off));
    return `<${base}${u.pathname}?${u.searchParams.toString()}>`;
  };
  const links = [`${make(0)};rel="first"`];
  if (offset > 0) links.push(`${make(Math.max(0, offset - limit))};rel="prev"`);
  const hasNext = total === null ? pageRows >= limit : offset + limit < total;
  if (hasNext) links.push(`${make(offset + limit)};rel="next"`);
  if (total !== null) {
    const lastOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
    links.push(`${make(lastOffset)};rel="last"`);
  }
  return links.join(',');
}

export function registerTableApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;

  nowRoute(app, 'GET', '/table/:tableName', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { tableName } = req.params as { tableName: string };
    const q = req.query as Q;
    const meta = tableOf(deps, tableName);
    const maxLimit = platform.properties.getNumber('glide.rest.query.max_limit', 10000);
    const limit = limitParam(queryParam(q.sysparm_limit), 10000, maxLimit);
    const offset = offsetParam(queryParam(q.sysparm_offset));
    const lq = listQuery(req, ctx, meta, q);
    const recs = lq.noRows ? [] : ctx.query(meta.name, { query: lq.query, limit, offset });
    // The documented v1 quirk: a valid query without hits is a 404 there (configurable).
    if (
      recs.length === 0 &&
      apiVersion(req) === 'v1' &&
      platform.properties.getBool('resolvr.rest.v1_empty_result_404', true)
    ) {
      throw new NotFoundError();
    }
    const noCount = parseBool(q.sysparm_no_count);
    const total = noCount ? null : lq.noRows ? 0 : ctx.count(meta.name, lq.query);
    if (total !== null) reply.header('X-Total-Count', String(total));
    if (!parseBool(q.sysparm_suppress_pagination_header)) {
      reply.header('Link', linkHeader(req, baseUrl(req, deps), total, limit, offset, recs.length));
    }
    const opts = serializeOptions(req, deps, meta);
    return { result: recs.map((r) => serializeRecord(ctx, r, opts)) };
  });

  nowRoute(app, 'GET', '/table/:tableName/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { tableName, sysId } = req.params as { tableName: string; sysId: string };
    const meta = tableOf(deps, tableName);
    const rec = ctx.get(meta.name, sysId);
    if (!rec) throw new NotFoundError();
    return { result: serializeRecord(ctx, rec, serializeOptions(req, deps, meta)) };
  });

  nowRoute(app, 'POST', '/table/:tableName', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { tableName } = req.params as { tableName: string };
    const q = req.query as Q;
    const meta = tableOf(deps, tableName);
    const body = bodyRecord(req);
    let draft = ctx.newRecord(meta.name);
    const cls = body.sys_class_name;
    if (typeof cls === 'string' && cls !== meta.name && platform.registry.isA(cls, meta.name))
      draft = ctx.newRecord(cls);
    const requestedId = body.sys_id;
    if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
      const id = String(requestedId);
      if (!isSysId(id))
        throw new HttpError(400, 'Invalid sys_id', `sys_id ${id} is not a 32 character hexadecimal value`);
      const taken = platform.db.get(`SELECT "sys_id" FROM ${quoteIdent(meta.physical)} WHERE "sys_id" = ?`, [
        id,
      ]);
      if (taken) throw new HttpError(400, 'Invalid sys_id', `A record with sys_id ${id} already exists`);
    }
    const inputDisplayValue = parseBool(q.sysparm_input_display_value);
    const values = writableBody(ctx, draft, body, true, { inputDisplayValue });
    const { sys_class_name: _c, ...rest } = values;
    let rec: Rec;
    try {
      rec = ctx.insert(draft, rest, {
        displayValue: inputDisplayValue,
        autoSysFields: !parseBool(q.sysparm_suppress_auto_sys_field),
      });
    } catch (e) {
      throw writeError(e, 'Insert');
    }
    reply.code(201).header('Location', `${baseUrl(req, deps)}/api/now/table/${meta.name}/${rec.sysId}`);
    if (noResponseBody(req)) return reply.send();
    const fresh = ctx.derive({ acl: false }).get(rec.className, rec.sysId) ?? rec;
    return { result: serializeRecord(ctx, fresh, serializeOptions(req, deps, meta)) };
  });

  const update = async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(req, deps);
    const { tableName, sysId } = req.params as { tableName: string; sysId: string };
    const q = req.query as Q;
    const meta = tableOf(deps, tableName);
    const body = bodyRecord(req);
    const rec = ctx.get(meta.name, sysId);
    if (!rec) throw new NotFoundError();
    const inputDisplayValue = parseBool(q.sysparm_input_display_value);
    const values = writableBody(ctx, rec, body, false, { inputDisplayValue });
    try {
      ctx.update(rec, values, {
        displayValue: inputDisplayValue,
        autoSysFields: !parseBool(q.sysparm_suppress_auto_sys_field),
      });
    } catch (e) {
      throw writeError(e, 'Update');
    }
    if (noResponseBody(req)) return reply.code(200).send();
    const fresh = ctx.derive({ acl: false }).get(rec.className, rec.sysId) ?? rec;
    return { result: serializeRecord(ctx, fresh, serializeOptions(req, deps, meta)) };
  };
  // PUT and PATCH are both partial updates; neither creates a record.
  nowRoute(app, 'PUT', '/table/:tableName/:sysId', update);
  nowRoute(app, 'PATCH', '/table/:tableName/:sysId', update);

  nowRoute(app, 'DELETE', '/table/:tableName/:sysId', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { tableName, sysId } = req.params as { tableName: string; sysId: string };
    const meta = tableOf(deps, tableName);
    const rec = ctx.get(meta.name, sysId);
    if (!rec) throw new NotFoundError();
    try {
      ctx.delete(rec);
    } catch (e) {
      throw writeError(e, 'Delete');
    }
    return reply.code(204).send();
  });
}
