/**
 * CMDB REST APIs: the platform-compatible CMDB Instance and Meta APIs (cmdb.md 10,
 * rest-api.md 7 and 8), an identify-and-reconcile endpoint, and the product APIs used by
 * the dependency map and CMDB Health pages.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, baseUrl, ctxOf, HttpError, intParam, nowRoute } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import { QueryCompiler } from '../../engine/query/compiler.js';
import type { Rec } from '../../engine/record.js';
import { SYSTEM_COLUMN_NAMES, type TableMeta } from '../../engine/types.js';
import { isSysId } from '../../engine/util.js';
import { toApiValue } from '../../engine/values.js';
import { relationshipRules, suggestionsFor } from './governance.js';
import { cmdbEngine } from './graph.js';
import { computeHealth, runHealthJob } from './health.js';
import { type IreOutput, type IrePayload, type IreRelation, runIre, upsertRelation } from './ire.js';

type Q = Record<string, string | undefined>;

const READ_ROLES = ['itil', 'cmdb_read', 'asset'];
const WRITE_ROLES = ['itil'];

function requireRoles(ctx: Context, roles: string[]): void {
  if (!ctx.hasAnyRole(roles))
    throw new HttpError(403, 'Insufficient rights', `Requires one of the roles: ${roles.join(', ')}`);
}

/** The class named in the URL: 404 when unknown, 400 when not a configuration item class. */
function ciClass(ctx: Context, className: string): TableMeta {
  const meta = ctx.registry.tryTable(className);
  if (!meta?.ancestors.includes('cmdb'))
    throw new HttpError(404, `Class ${className} not found`, 'Invalid class name');
  if (!meta.ancestors.includes('cmdb_ci'))
    throw new HttpError(
      400,
      `${className} is not a cmdb_ci class`,
      'The class must be cmdb_ci or one of its descendants',
    );
  return meta;
}

function body(req: FastifyRequest): Record<string, unknown> {
  const b = Array.isArray(req.body) ? req.body[0] : req.body;
  if (!b || typeof b !== 'object')
    throw new HttpError(400, 'Exception while reading request', 'The payload is not valid JSON.');
  return b as Record<string, unknown>;
}

function validSource(ctx: Context, source: unknown): string {
  if (typeof source !== 'string' || !source.trim())
    throw new HttpError(400, 'Source is required', 'Provide a discovery source in "source"');
  const ok = ctx.platform.choices
    .list('cmdb_ci', 'discovery_source', { includeInactive: true })
    .some((c) => c.value === source);
  if (!ok)
    throw new HttpError(400, `Invalid source ${source}`, 'The source must be a discovery_source choice');
  return source;
}

/** Client attributes minus system fields (sys_id is handled by the caller). */
function cleanAttributes(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([k]) => !SYSTEM_COLUMN_NAMES.has(k)),
  );
}

// ------------------------------------------------------------- read model

function attributes(ctx: Context, rec: Rec, base: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, col] of rec.table.columns) {
    if (!col.storage || col.type === 'password2') continue;
    if (!ctx.platform.acl.canField(ctx, rec.className, name, 'read', rec)) continue;
    const value = toApiValue(col, rec.get(name));
    if ((col.type === 'reference' || col.type === 'document_id') && col.reference) {
      out[name] =
        value === ''
          ? ''
          : {
              display_value: rec.display(name),
              link: `${base}/api/now/table/${col.reference}/${value}`,
              value,
            };
    } else out[name] = value;
  }
  out.sys_domain = {
    display_value: 'global',
    link: `${base}/api/now/table/sys_user_group/global`,
    value: 'global',
  };
  return out;
}

interface RelationView {
  sys_id: string;
  type: { display_value: string; link: string; value: string };
  target: { display_value: string; link: string; value: string };
}

function relations(
  ctx: Context,
  ciId: string,
  base: string,
): { outbound: RelationView[]; inbound: RelationView[] } {
  const rows = ctx.platform.db.all<Record<string, string | null>>(
    `SELECT r."sys_id", r."parent", r."child", r."type", t."name" AS type_name, p."name" AS parent_name, c."name" AS child_name
     FROM "cmdb_rel_ci" r LEFT JOIN "cmdb_rel_type" t ON t."sys_id" = r."type"
     LEFT JOIN "cmdb" p ON p."sys_id" = r."parent" LEFT JOIN "cmdb" c ON c."sys_id" = r."child"
     WHERE r."parent" = ? OR r."child" = ? ORDER BY t."name", r."sys_created_on", r.rowid`,
    [ciId, ciId],
  );
  const view = (
    r: Record<string, string | null>,
    target: string,
    targetName: string | null,
  ): RelationView => ({
    sys_id: String(r.sys_id),
    type: {
      display_value: r.type_name ?? '',
      link: `${base}/api/now/table/cmdb_rel_type/${r.type}`,
      value: String(r.type ?? ''),
    },
    target: {
      display_value: targetName ?? '',
      link: `${base}/api/now/cmdb/instance/cmdb_ci/${target}`,
      value: target,
    },
  });
  return {
    outbound: rows.filter((r) => r.parent === ciId).map((r) => view(r, String(r.child), r.child_name)),
    inbound: rows.filter((r) => r.child === ciId).map((r) => view(r, String(r.parent), r.parent_name)),
  };
}

function instanceView(ctx: Context, rec: Rec, base: string) {
  const { outbound, inbound } = relations(ctx, rec.sysId, base);
  return { attributes: attributes(ctx, rec, base), outbound_relations: outbound, inbound_relations: inbound };
}

// ------------------------------------------------------------- relations

interface RelationInput {
  type: string;
  target: string;
}

function relationInputs(ctx: Context, raw: unknown, label: string): RelationInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, `${label} must be an array`);
  return raw.map((r: Record<string, unknown>) => {
    const type = String((r?.type as { value?: string })?.value ?? r?.type ?? '');
    const target = String((r?.target as { value?: string })?.value ?? r?.target ?? '');
    if (!type || !target) throw new HttpError(400, `Each of ${label} needs a type and a target`);
    const typeRow = ctx.platform.db.get<{ sys_id: string }>(
      `SELECT "sys_id" FROM "cmdb_rel_type" WHERE "sys_id" = ? OR "name" = ?`,
      [type, type],
    );
    if (!typeRow) throw new HttpError(400, `Invalid relationship type ${type}`);
    if (
      !isSysId(target) ||
      !ctx.platform.db.get(`SELECT "sys_id" FROM "cmdb" WHERE "sys_id" = ?`, [target])
    ) {
      throw new HttpError(
        400,
        `Invalid relation target ${target}`,
        'The target must be the sys_id of an existing CI',
      );
    }
    return { type: typeRow.sys_id, target };
  });
}

function irePayloadFor(
  className: string,
  values: Record<string, unknown>,
  out: RelationInput[],
  inb: RelationInput[],
): IrePayload {
  const rels: IreRelation[] = [
    ...out.map((r) => ({ parent: 0, child: r.target, type: r.type })),
    ...inb.map((r) => ({ parent: r.target, child: 0, type: r.type })),
  ];
  return { items: [{ className, values }], relations: rels };
}

/** Maps IRE item errors to the CMDB API error response. */
function ireFailure(out: IreOutput): void {
  const item = out.items[0];
  const err = item?.errors[0];
  if (err) {
    if (err.error === 'MISSING_DEPENDENCY' || err.error === 'MULTIPLE_DEPENDENCIES') {
      throw new HttpError(
        400,
        'Exception while executing request: null',
        `${err.error}: ${err.message}. Check logs for error trace or enable glide.rest.debug property to verify REST request processing`,
      );
    }
    throw new HttpError(400, err.message, err.error);
  }
  const relErr = out.relations.find((r) => r.errors.length)?.errors[0];
  if (relErr) throw new HttpError(400, relErr.message, relErr.error);
}

function canTable(ctx: Context, table: string, op: 'create' | 'write' | 'delete'): void {
  if (!ctx.platform.acl.canTable(ctx, table, op).allowed)
    throw new HttpError(403, 'Operation Failed', `ACL Exception ${op} failed due to security constraints`);
}

// --------------------------------------------------------------- Meta API

const ICONS: [string, string][] = [
  ['cmdb_ci_server', 'server'],
  ['cmdb_ci_computer', 'computer'],
  ['cmdb_ci_netgear', 'network'],
  ['cmdb_ci_storage_device', 'storage'],
  ['cmdb_ci_database', 'database'],
  ['cmdb_ci_db_instance', 'database'],
  ['cmdb_ci_appl', 'app'],
  ['cmdb_ci_service', 'service'],
  ['cmdb_ci_business_app', 'business_app'],
  ['cmdb_ci_vm_instance', 'vm'],
  ['cmdb_ci_cluster', 'cluster'],
];

function iconUrl(meta: TableMeta): string {
  const hit = ICONS.find(([cls]) => meta.ancestors.includes(cls));
  return hit ? `images/app.ngbsm/${hit[1]}.svg` : 'images/app.ngbsm/generic.svg';
}

function maxLength(meta: TableMeta, name: string): string {
  const c = meta.columns.get(name)!;
  if (c.maxLength) return String(c.maxLength);
  if (c.type === 'reference' || c.type === 'GUID') return '32';
  return c.type === 'string' ? '255' : '40';
}

function identificationRules(ctx: Context, meta: TableMeta) {
  for (const cls of meta.ancestors) {
    const rule = ctx.platform.db.get<Record<string, unknown>>(
      `SELECT * FROM "cmdb_identifier" WHERE "applies_to" = ? ORDER BY ("active" = 0), "sys_created_on" LIMIT 1`,
      [cls],
    );
    if (!rule) continue;
    const entry = (e: Record<string, unknown>) => ({
      order: Number(e.order ?? 100),
      attributes: String(e.attributes ?? ''),
      table: (e.table as string) || null,
      referenced_field: (e.referenced_field as string) || null,
      condition: (e.condition as string) || null,
      active: e.active !== 0,
      allow_null_attribute: e.allow_null_attribute === 1,
      allow_fallback: e.allow_fallback === 1,
      exact_count_match: e.exact_count_match === 1,
    });
    const entries = ctx.platform.db.all<Record<string, unknown>>(
      `SELECT * FROM "cmdb_identifier_entry" WHERE "identifier" = ? ORDER BY "order"`,
      [rule.sys_id as string],
    );
    const related = ctx.platform.db.all<Record<string, unknown>>(
      `SELECT * FROM "cmdb_related_entry" WHERE "identifier" = ? ORDER BY "order"`,
      [rule.sys_id as string],
    );
    return {
      name: String(rule.name ?? ''),
      description: String(rule.description ?? ''),
      active: rule.active !== 0,
      is_independent: rule.is_independent !== 0,
      applies_to: String(rule.applies_to),
      identifiers: entries.map(entry),
      related_rules: related.map(entry),
    };
  }
  return null;
}

function metaView(ctx: Context, meta: TableMeta) {
  return {
    name: meta.name,
    label: meta.label,
    parent: meta.parent ?? '',
    children: [...meta.children],
    icon: '',
    icon_url: iconUrl(meta),
    is_extendable: true,
    attributes: [...meta.columns.values()].map((c) => ({
      element: c.name,
      label: c.label,
      type: c.type,
      max_length: maxLength(meta, c.name),
      is_mandatory: String(!!c.mandatory),
      is_read_only: String(!!c.readOnly || !!c.system),
      is_inherited: String(c.definedOn !== meta.name),
      is_display: String(meta.displayField === c.name),
      default_value:
        typeof c.defaultValue === 'function' || c.defaultValue === undefined || c.defaultValue === null
          ? null
          : String(c.defaultValue),
    })),
    relationship_rules: relationshipRules(ctx.platform, meta.name),
    identification_rules: identificationRules(ctx, meta),
  };
}

// ------------------------------------------------------------- routes

export function registerCmdbApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const engine = () => cmdbEngine(platform);

  nowRoute(app, 'GET', '/cmdb/instance/:className', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const { className } = req.params as { className: string };
    ciClass(ctx, className);
    const q = req.query as Q;
    const max = platform.properties.getNumber('glide.rest.query.max_limit', 10000);
    const limit = intParam(q.sysparm_limit, 10000, 1, Math.max(max, 1));
    const offset = intParam(q.sysparm_offset, 0, 0);
    const query = q.sysparm_query ?? '';
    if (query && platform.properties.getBool('glide.invalid_query.returns_no_rows', false)) {
      if (QueryCompiler.compile(platform.registry, className, query, ctx.env).invalid.length)
        return { result: [] };
    }
    const recs = ctx.query(className, { query, limit, offset });
    return { result: recs.map((r) => ({ sys_id: r.sysId, name: r.str('name') })) };
  });

  nowRoute(app, 'GET', '/cmdb/instance/:className/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const { className, sysId } = req.params as { className: string; sysId: string };
    ciClass(ctx, className);
    const rec = ctx.get(className, sysId);
    if (!rec) throw new NotFoundError();
    return { result: instanceView(ctx, rec, baseUrl(req, deps)) };
  });

  nowRoute(app, 'POST', '/cmdb/instance/:className', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, WRITE_ROLES);
    const { className } = req.params as { className: string };
    ciClass(ctx, className);
    const b = body(req);
    const source = validSource(ctx, b.source);
    canTable(ctx, className, 'create');
    const out = relationInputs(ctx, b.outbound_relations, 'outbound_relations');
    const inb = relationInputs(ctx, b.inbound_relations, 'inbound_relations');
    const result = runIre(ctx.elevated(), irePayloadFor(className, cleanAttributes(b.attributes), out, inb), {
      source,
    });
    ireFailure(result);
    const rec = ctx.elevated().get('cmdb', result.items[0].sysId!);
    if (!rec) throw new NotFoundError();
    return { result: instanceView(ctx, rec, baseUrl(req, deps)) };
  });

  const update = async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, WRITE_ROLES);
    const { className, sysId } = req.params as { className: string; sysId: string };
    ciClass(ctx, className);
    const b = body(req);
    const source = validSource(ctx, b.source);
    const rec = ctx.get(className, sysId);
    if (!rec) throw new NotFoundError();
    canTable(ctx, rec.className, 'write');
    const values = { ...cleanAttributes(b.attributes), sys_id: rec.sysId };
    const result = runIre(ctx.elevated(), { items: [{ className: rec.className, values }] }, { source });
    ireFailure(result);
    const fresh = ctx.elevated().get('cmdb', rec.sysId) ?? rec;
    return { result: instanceView(ctx, fresh, baseUrl(req, deps)) };
  };
  nowRoute(app, 'PUT', '/cmdb/instance/:className/:sysId', update);
  nowRoute(app, 'PATCH', '/cmdb/instance/:className/:sysId', update);

  nowRoute(app, 'POST', '/cmdb/instance/:className/:sysId/relation', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, WRITE_ROLES);
    const { className, sysId } = req.params as { className: string; sysId: string };
    ciClass(ctx, className);
    const b = body(req);
    validSource(ctx, b.source);
    const rec = ctx.get(className, sysId);
    if (!rec) throw new NotFoundError();
    canTable(ctx, 'cmdb_rel_ci', 'create');
    const out = relationInputs(ctx, b.outbound_relations, 'outbound_relations');
    const inb = relationInputs(ctx, b.inbound_relations, 'inbound_relations');
    const sys = ctx.elevated();
    platform.db.tx(() => {
      for (const r of out) upsertRelation(sys, rec.sysId, r.target, r.type);
      for (const r of inb) upsertRelation(sys, r.target, rec.sysId, r.type);
    });
    return { result: instanceView(ctx, rec, baseUrl(req, deps)) };
  });

  nowRoute(
    app,
    'DELETE',
    '/cmdb/instance/:className/:sysId/relation/:relSysId',
    async (req, reply: FastifyReply) => {
      const ctx = ctxOf(req, deps);
      requireRoles(ctx, WRITE_ROLES);
      const { className, sysId, relSysId } = req.params as {
        className: string;
        sysId: string;
        relSysId: string;
      };
      ciClass(ctx, className);
      const rec = ctx.get(className, sysId);
      if (!rec) throw new NotFoundError();
      const rel = ctx.get('cmdb_rel_ci', relSysId);
      if (!rel || (rel.str('parent') !== rec.sysId && rel.str('child') !== rec.sysId))
        throw new NotFoundError();
      ctx.delete(rel);
      return reply.code(200).send();
    },
  );

  nowRoute(app, 'GET', '/cmdb/meta/:className', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const { className } = req.params as { className: string };
    const meta = platform.registry.tryTable(className);
    if (!meta?.ancestors.includes('cmdb'))
      throw new HttpError(404, `Class ${className} not found`, 'Invalid class name');
    return { result: metaView(ctx, meta) };
  });

  const identify = (dryRun: boolean) => async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, WRITE_ROLES);
    const b = body(req);
    if (!Array.isArray(b.items)) throw new HttpError(400, 'The payload must contain an items array');
    const q = req.query as Q;
    const source = validSource(ctx, q.sysparm_data_source ?? b.source ?? 'ServiceNow');
    return { result: runIre(ctx.elevated(), b as unknown as IrePayload, { source, dryRun }) };
  };
  nowRoute(app, 'POST', '/identifyreconcile', identify(false));
  nowRoute(app, 'POST', '/identifyreconcile/query', identify(true));

  // ------------------------------------------------- product APIs (/api/app/cmdb)

  const readableCi = (ctx: Context, ciId: string): Rec => {
    const ci = ctx.get('cmdb', ciId);
    if (!ci) throw new NotFoundError();
    return ci;
  };

  app.get('/api/app/cmdb/graph/:ciId', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const { ciId } = req.params as { ciId: string };
    readableCi(ctx, ciId);
    const q = req.query as Q;
    const direction = q.direction === 'up' || q.direction === 'down' ? q.direction : 'both';
    return engine().graph(ciId, {
      depth: intParam(q.depth, 2, 1, 49),
      direction,
      types: q.types
        ? q.types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      showAll: q.show_all === 'true',
      maxNodes: q.max_nodes ? intParam(q.max_nodes, 1000, 1) : undefined,
    });
  });

  app.get('/api/app/cmdb/impact/:ciId', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const { ciId } = req.params as { ciId: string };
    readableCi(ctx, ciId);
    const eng = engine();
    const impact = eng.impact([ciId]);
    const levels = eng.closure([ciId], 'up');
    const info = eng.info([...levels.keys()]);
    const row = (id: string) => {
      const ci = info.get(id) ?? eng.info([id]).get(id);
      return {
        sys_id: id,
        name: ci?.name ?? '',
        class: ci?.sys_class_name ?? '',
        level: levels.get(id) ?? 0,
      };
    };
    return {
      result: {
        upstream: [...levels.keys()].map(row),
        services: impact.services.map(row),
        offerings: impact.offerings.map(row),
      },
    };
  });

  app.get('/api/app/cmdb/suggestions/:ciId', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const { ciId } = req.params as { ciId: string };
    const ci = readableCi(ctx, ciId);
    return { result: suggestionsFor(platform, ci.className) };
  });

  app.get('/api/app/cmdb/health', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, READ_ROLES);
    const report = computeHealth(ctx.elevated());
    const limit = intParam((req.query as Q).failures, 200, 0, 5000);
    return {
      result: {
        ...report,
        failures: report.failures.slice(0, limit),
        failure_count: report.failures.length,
        last_run: platform.properties.get('resolvr.cmdb.health.last_run') ?? null,
      },
    };
  });

  app.post('/api/app/cmdb/health/run', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, ['cmdb_admin', 'admin']);
    const report = runHealthJob(ctx.elevated());
    return {
      result: { computed_at: report.computed_at, overall: report.overall, failures: report.failures.length },
    };
  });
}
