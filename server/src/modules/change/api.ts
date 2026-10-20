import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, baseUrl, ctxOf, errorBody, HttpError, intParam } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { AbortError, AccessError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { JOURNAL_TYPES, type TableMeta } from '../../engine/types.js';
import { clock, durationToValue, isSysId, nowGlide } from '../../engine/util.js';
import { canDecideDirectly, decideAsApprover, directDecision, pendingApprovalFor } from './approvals.js';
import {
  clearConflictResults,
  conflictPrecondition,
  findSlots,
  runConflictDetection,
  slotToJson,
} from './conflicts.js';
import { APPROVAL_STATES, PROP, parseChangeState, T } from './constants.js';
import { changeModels } from './model.js';
import { applyRisk } from './risk.js';
import { refreshImpactedServices } from './rules.js';
import { toGlide, toMs } from './schedules.js';
import { createStandardChange, findProducer } from './standard.js';
import { ChangeTransitionError, nextStates } from './transitions.js';
import { approvalsOf, readJson } from './util.js';
import { createWorker, queueWorker, workerEnvelope } from './workers.js';

const ROLES = {
  read: ['change_manager', 'itil', 'sn_change_read', 'admin'],
  approve: ['change_manager', 'itil', 'sn_change_read', 'admin', 'approver_user', 'approval_user'],
  write: ['change_manager', 'itil', 'admin'],
  delete: ['change_manager', 'admin'],
  schedule: ['sn_change_write', 'itil', 'change_manager', 'admin'],
};

const LIST_PARAMS = new Set([
  'sysparm_query',
  'sysparm_limit',
  'sysparm_offset',
  'sysparm_fields',
  'sysparm_display_value',
  'sysparm_exclude_reference_link',
  'sysparm_suppress_pagination_header',
  'textSearch',
  'order',
  'api_version',
  'association_type',
]);
const INPUT_PARAMS = new Set([
  'api_version',
  'encrypted_fields',
  'sysparm_fields',
  'sysparm_display_value',
  'sysparm_input_display_value',
]);
const DATE_TYPES = new Set(['glide_date_time', 'glide_date', 'due_date']);

type Q = Record<string, string | undefined>;
type Handler = (req: FastifyRequest, reply: FastifyReply, ctx: Context) => unknown;

// --------------------------------------------------------------- serializer

function journalText(ctx: Context, rec: Rec, field: string): string {
  const entries = ctx.platform.history.journal(rec.className, rec.sysId, [field]);
  return ctx.platform.history.formatJournal(
    entries,
    (f) => rec.column(f)?.label ?? f,
    (u) =>
      ctx.platform.db.get<{ name: string }>(`SELECT "name" FROM "sys_user" WHERE "user_name" = ?`, [u])
        ?.name || u,
  );
}

/** Value/display_value pair of one field (integers and booleans as JSON numbers and booleans). */
function fieldJson(ctx: Context, rec: Rec, field: string): Record<string, unknown> {
  const col = rec.column(field);
  if (!col) return { value: '', display_value: '' };
  if (!ctx.platform.acl.canField(ctx, rec.className, field, 'read', rec))
    return { value: '', display_value: '' };
  if (JOURNAL_TYPES.has(col.type)) return { value: '', display_value: journalText(ctx, rec, field) };
  const raw = rec.get(field);
  let value: unknown;
  if (col.type === 'boolean') value = raw === 1 || raw === '1' || raw === 'true';
  else if (raw === null || raw === undefined || raw === '') value = '';
  else if (col.type === 'integer') value = Number(raw);
  else if (col.type === 'glide_duration') value = durationToValue(Number(raw));
  else if (col.type === 'password2') value = '';
  else value = String(raw);
  const display = rec.display(field);
  const out: Record<string, unknown> = { value, display_value: display };
  if (DATE_TYPES.has(col.type)) out.display_value_internal = display;
  return out;
}

export function serializeChange(ctx: Context, rec: Rec, fields: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = fields.length
    ? fields
    : [...rec.table.columns.values()]
        .filter((c) => c.storage || JOURNAL_TYPES.has(c.type))
        .map((c) => c.name);
  for (const f of names) {
    if (f === 'resolvr_hold_approvals') continue;
    out[f] = fieldJson(ctx, rec, f);
  }
  return out;
}

const parseFields = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

// ------------------------------------------------------------------- input

function collectInput(req: FastifyRequest): { input: Record<string, unknown>; displayFields: Set<string> } {
  const q = (req.query ?? {}) as Q;
  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) if (!INPUT_PARAMS.has(k) && v !== undefined) input[k] = v;
  for (const [k, v] of Object.entries(body)) if (!INPUT_PARAMS.has(k)) input[k] = v;
  const enc = String(body.encrypted_fields ?? q.encrypted_fields ?? '');
  return { input, displayFields: new Set(parseFields(enc)) };
}

interface SplitOptions {
  insert: boolean;
  /** Read-only dictionary fields the caller may still set (rules decide). */
  allow?: string[];
  /** Fields that are always ignored for this endpoint. */
  deny?: string[];
}

/** Separates settable fields from ignored ones (unknown, read-only, system or ACL protected). */
function splitInput(
  ctx: Context,
  rec: Rec,
  input: Record<string, unknown>,
  opts: SplitOptions,
): { values: Record<string, unknown>; ignored: string[] } {
  const values: Record<string, unknown> = {};
  const ignored: string[] = [];
  const acl = ctx.platform.acl;
  for (const [k, v] of Object.entries(input)) {
    const col = rec.column(k);
    if (!col || opts.deny?.includes(k)) {
      ignored.push(k);
      continue;
    }
    if (k === 'sys_id') {
      if (opts.insert && isSysId(v)) values[k] = v;
      else ignored.push(k);
      continue;
    }
    if (col.system || k === 'number' || (col.readOnly && !opts.allow?.includes(k))) {
      ignored.push(k);
      continue;
    }
    if (!JOURNAL_TYPES.has(col.type)) {
      const op = opts.insert ? 'create' : 'write';
      const ok =
        acl.canField(ctx, rec.className, k, op, rec) ||
        (opts.insert && acl.canField(ctx, rec.className, k, 'write', rec));
      if (!ok) {
        ignored.push(k);
        continue;
      }
    }
    values[k] = v;
  }
  if (rec.table.name === T.change && 'state' in values) {
    const parsed = parseChangeState(values.state);
    if (parsed === null)
      throw new HttpError(400, 'Invalid state', `"${String(values.state)}" is not a change state`);
    values.state = parsed;
  }
  return { values, ignored };
}

/** Applies display-value inputs (encrypted_fields semantics) on the record before saving. */
function applyDisplayInputs(
  rec: Rec,
  values: Record<string, unknown>,
  displayFields: Set<string>,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (displayFields.has(k)) rec.set(k, v, { displayValue: true });
    else rest[k] = v;
  }
  return rest;
}

function withMeta(result: Record<string, unknown>, ignored: string[]): Record<string, unknown> {
  if (ignored.length) result.__meta = { ignoredFields: ignored };
  return result;
}

// ------------------------------------------------------------------- lists

function filterValue(ctx: Context, meta: TableMeta, field: string, value: string): string {
  if (meta.name === T.change && field === 'state') {
    const s = parseChangeState(value);
    return s === null ? value : String(s);
  }
  const col = meta.columns.get(field);
  if (col && col.type !== 'reference' && ctx.platform.choices.hasChoices(meta.name, field)) {
    return ctx.platform.choices.resolve(meta.name, field, value) ?? value;
  }
  return value;
}

function listQuery(ctx: Context, meta: TableMeta, q: Q, implicit: string, defaultOrder: string): string {
  const pairs = Object.entries(q).filter(
    ([k, v]) => !LIST_PARAMS.has(k) && v !== undefined && meta.columns.has(k),
  );
  if (pairs.length && q.sysparm_query) {
    throw new HttpError(
      400,
      'Invalid query',
      'Name-value pair filters cannot be combined with sysparm_query',
    );
  }
  const terms: string[] = [];
  if (implicit) terms.push(implicit);
  for (const [k, v] of pairs) terms.push(`${k}=${filterValue(ctx, meta, k, String(v))}`);
  if (q.sysparm_query) terms.push(q.sysparm_query);
  if (q.textSearch) terms.push(`123TEXTQUERY321=${q.textSearch}`);
  let query = terms.join('^');
  if (!/ORDERBY/.test(q.sysparm_query ?? '')) {
    const order = (q.order || defaultOrder).trim();
    const desc = order.startsWith('-');
    const field = desc ? order.slice(1) : order;
    if (meta.columns.has(field)) query += `${query ? '^' : ''}${desc ? 'ORDERBYDESC' : 'ORDERBY'}${field}`;
  }
  return query;
}

function linkHeader(
  req: FastifyRequest,
  deps: ApiDeps,
  total: number,
  limit: number,
  offset: number,
): string {
  const base = baseUrl(req, deps);
  const url = new URL(req.url, base);
  const make = (off: number) => {
    const u = new URL(url.toString());
    u.searchParams.set('sysparm_limit', String(limit));
    u.searchParams.set('sysparm_offset', String(off));
    return `<${base}${u.pathname}?${u.searchParams.toString()}>`;
  };
  const links = [`${make(0)};rel="first"`];
  if (offset > 0) links.push(`${make(Math.max(0, offset - limit))};rel="prev"`);
  if (offset + limit < total) links.push(`${make(offset + limit)};rel="next"`);
  links.push(`${make(total === 0 ? 0 : Math.floor((total - 1) / limit) * limit)};rel="last"`);
  return links.join(',');
}

function listRecords(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: Context,
  deps: ApiDeps,
  table: string,
  opts: { implicit?: string; defaultOrder?: string; filter?: (r: Rec) => boolean } = {},
): { result: Record<string, unknown>[] } {
  const q = (req.query ?? {}) as Q;
  const meta = ctx.registry.table(table);
  const query = listQuery(ctx, meta, q, opts.implicit ?? '', opts.defaultOrder ?? 'number');
  if (q.sysparm_offset !== undefined && Number(q.sysparm_offset) < 0)
    throw new HttpError(400, 'Invalid offset', 'sysparm_offset must be zero or more');
  const limit = intParam(q.sysparm_limit, 500, 1, 10000);
  const offset = intParam(q.sysparm_offset, 0, 0);
  let recs = ctx.query(table, { query, limit, offset });
  if (opts.filter) recs = recs.filter(opts.filter);
  const total = ctx.count(table, query);
  reply.header('X-Total-Count', String(total));
  reply.header('Link', linkHeader(req, deps, total, limit, offset));
  const fields = parseFields(q.sysparm_fields);
  return { result: recs.map((r) => serializeChange(ctx, r, fields)) };
}

// ------------------------------------------------------------------ helpers

function changeById(ctx: Context, id: string, type?: string): Rec {
  const rec = ctx.get(T.change, id);
  if (!rec || (type && rec.str('type') !== type)) throw new NotFoundError();
  return rec;
}

function fresh(ctx: Context, rec: Rec): Rec {
  return ctx.elevated().get(rec.className, rec.sysId) ?? rec;
}

function respond(
  req: FastifyRequest,
  ctx: Context,
  rec: Rec,
  ignored: string[] = [],
): { result: Record<string, unknown> } {
  const fields = parseFields(((req.query ?? {}) as Q).sysparm_fields);
  return { result: withMeta(serializeChange(ctx, fresh(ctx, rec), fields), ignored) };
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Maps business rule failures to the 400 responses of this API. */
function mapError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ChangeTransitionError) return reply.code(400).send(errorBody(e.title, e.detail));
  if (e instanceof AbortError) return reply.code(400).send(errorBody(e.message, ''));
  throw e;
}

// ------------------------------------------------------------------- routes

export function registerChangeApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const models = changeModels(platform);

  const route = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    roles: string[],
    handler: Handler,
  ) => {
    for (const prefix of ['/api/sn_chg_rest', '/api/sn_chg_rest/v1']) {
      app.route({
        method,
        url: `${prefix}${path}`,
        handler: async (req, reply) => {
          const accept = String(req.headers.accept ?? '');
          if (accept && /xml/i.test(accept) && !/json|\*\/\*/i.test(accept)) {
            return reply.code(406).send(errorBody('Not acceptable', 'Only JSON is supported'));
          }
          const ctx = ctxOf(req, deps);
          if (!ctx.hasAnyRole(roles))
            throw new HttpError(
              403,
              'Insufficient rights',
              'User does not have the role required for this operation',
            );
          try {
            return await handler(req, reply, ctx);
          } catch (e) {
            return mapError(reply, e);
          }
        },
      });
    }
  };

  // ------------------------------------------------------------ create
  const create = (req: FastifyRequest, ctx: Context, type?: 'normal' | 'emergency') => {
    const { input, displayFields } = collectInput(req);
    const draft = ctx.newRecord(T.change);
    const { values, ignored } = splitInput(ctx, draft, input, {
      insert: true,
      allow: type ? [] : ['type'],
      deny: type ? ['type', 'chg_model', 'state'] : ['state'],
    });
    if (type) {
      const model = models.forType(type);
      if (!model)
        throw new HttpError(400, 'Invalid change type', `No change model is available for type "${type}"`);
      values.chg_model = model.sysId;
      values.type = type;
    }
    const rest = applyDisplayInputs(draft, values, displayFields);
    const rec = ctx.insert(draft, rest);
    return respond(req, ctx, rec, ignored);
  };

  const update = (req: FastifyRequest, ctx: Context, rec: Rec) => {
    const { input, displayFields } = collectInput(req);
    const { values, ignored } = splitInput(ctx, rec, input, {
      insert: false,
      allow: ['type'],
      deny: ['chg_model'],
    });
    const rest = applyDisplayInputs(rec, values, displayFields);
    ctx.update(rec, rest);
    return respond(req, ctx, rec, ignored);
  };

  const remove = (req: FastifyRequest, ctx: Context, rec: Rec) => {
    const before = respond(req, ctx, rec);
    ctx.delete(rec);
    return before;
  };

  // Generic change endpoints
  route('GET', '/change', ROLES.read, (req, reply, ctx) => listRecords(req, reply, ctx, deps, T.change));
  route('POST', '/change', ROLES.write, (req, _reply, ctx) => create(req, ctx));

  // Models (registered before /change/:id)
  route('GET', '/change/model', ROLES.read, (req, reply, ctx) =>
    listRecords(req, reply, ctx, deps, T.model, {
      defaultOrder: 'name',
      filter: (r) => canReadModel(ctx, r),
    }),
  );
  route('GET', '/change/model/:id', ROLES.read, (req, _reply, ctx) => {
    const rec = ctx.get(T.model, (req.params as { id: string }).id);
    if (!rec || !canReadModel(ctx, rec)) throw new NotFoundError();
    return respond(req, ctx, rec);
  });

  // Standard change templates
  route('GET', '/change/standard/template', ROLES.read, (req, reply, ctx) =>
    listRecords(req, reply, ctx, deps, T.producer, {
      implicit: 'active=true^retired!=true',
      defaultOrder: 'name',
    }),
  );
  route('GET', '/change/standard/template/:id', ROLES.read, (req, _reply, ctx) => {
    const rec = ctx.get(T.producer, (req.params as { id: string }).id);
    if (!rec) throw new NotFoundError();
    return respond(req, ctx, rec);
  });

  // Type specific endpoints
  for (const type of ['normal', 'emergency', 'standard'] as const) {
    route('GET', `/change/${type}`, ROLES.read, (req, reply, ctx) =>
      listRecords(req, reply, ctx, deps, T.change, { implicit: `type=${type}` }),
    );
    route('GET', `/change/${type}/:id`, ROLES.read, (req, _reply, ctx) =>
      respond(req, ctx, changeById(ctx, (req.params as { id: string }).id, type)),
    );
    route('PATCH', `/change/${type}/:id`, ROLES.write, (req, _reply, ctx) =>
      update(req, ctx, changeById(ctx, (req.params as { id: string }).id, type)),
    );
    route('DELETE', `/change/${type}/:id`, ROLES.delete, (req, _reply, ctx) =>
      remove(req, ctx, changeById(ctx, (req.params as { id: string }).id, type)),
    );
    if (type !== 'standard')
      route('POST', `/change/${type}`, ROLES.write, (req, _reply, ctx) => create(req, ctx, type));
  }
  route('POST', '/change/standard/:id', ROLES.write, (req, _reply, ctx) => {
    const templateId = (req.params as { id: string }).id;
    if (!findProducer(ctx, templateId))
      throw new NotFoundError('No Record found', 'Standard change template not found or retired');
    const { input } = collectInput(req);
    const { values, ignored } = splitInput(ctx, ctx.newRecord(T.change), input, {
      insert: true,
      deny: ['type', 'chg_model', 'state'],
    });
    const { change, ignored: templateIgnored } = createStandardChange(ctx, templateId, values);
    return respond(req, ctx, change, [...ignored, ...templateIgnored]);
  });

  // Generic record endpoints
  route('GET', '/change/:id', ROLES.read, (req, _reply, ctx) =>
    respond(req, ctx, changeById(ctx, (req.params as { id: string }).id)),
  );
  route('PATCH', '/change/:id', ROLES.write, (req, _reply, ctx) =>
    update(req, ctx, changeById(ctx, (req.params as { id: string }).id)),
  );
  route('DELETE', '/change/:id', ROLES.delete, (req, _reply, ctx) =>
    remove(req, ctx, changeById(ctx, (req.params as { id: string }).id)),
  );

  // Risk
  const risk = (req: FastifyRequest, ctx: Context, type?: string) => {
    const rec = changeById(ctx, (req.params as { id: string }).id, type);
    applyRisk(ctx, rec);
    return respond(req, ctx, rec);
  };
  route('PATCH', '/change/:id/risk', ROLES.write, (req, _reply, ctx) => risk(req, ctx));
  route('PATCH', '/change/standard/:id/risk', ROLES.write, (req, _reply, ctx) => risk(req, ctx, 'standard'));

  // Next states
  route('GET', '/change/:id/nextstates', ROLES.read, (req, _reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    return { result: nextStates(ctx, rec) };
  });

  // Approvals
  const approvals = (req: FastifyRequest, ctx: Context) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const { input } = collectInput(req);
    const decision = String(input.state ?? '')
      .trim()
      .toLowerCase();
    const comments = String(input.comments ?? '').trim();
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new HttpError(400, 'Invalid approval state', 'state must be approved or rejected');
    }
    if (decision === 'rejected' && !comments)
      throw new HttpError(400, 'Comments are required', 'Comments are required when rejecting a change');
    try {
      if (approvalsOf(ctx.platform)) {
        if (!pendingApprovalFor(ctx, rec.sysId)) throw new InvalidError('No pending approval');
        decideAsApprover(ctx, rec, decision, comments);
      } else {
        if (!canDecideDirectly(ctx) || !APPROVAL_STATES.includes(rec.num('state') ?? 0))
          throw new InvalidError('No pending approval');
        directDecision(ctx, rec, decision, comments);
      }
    } catch (e) {
      if (e instanceof InvalidError || e instanceof AccessError) {
        throw new HttpError(
          400,
          'Approval not allowed',
          'User lacks authority to approve or reject this change',
        );
      }
      throw e;
    }
    return respond(req, ctx, rec);
  };
  route('PATCH', '/change/:id/approvals', ROLES.approve, (req, _reply, ctx) => approvals(req, ctx));
  route('POST', '/change/:id/approvals', ROLES.approve, (req, _reply, ctx) => approvals(req, ctx));

  // Conflicts
  route('POST', '/change/:id/conflict', ROLES.write, (req, _reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const reason = conflictPrecondition(rec);
    if (reason) throw new HttpError(400, 'Conflict checking cannot start', reason);
    const worker = createWorker(ctx, 'conflict', {
      change: rec,
      ciId: rec.str('cmdb_ci'),
      request: { change: rec.sysId },
    });
    const run = runConflictDetection(ctx, rec.sysId);
    ctx.elevated().update(worker, {
      state: 3,
      started_at: run.lastRun,
      completed_at: nowGlide(),
      payload: JSON.stringify({ record_count: run.checked, conflicts: run.conflicts.length }),
    });
    return { result: worker.sysId };
  });
  route('GET', '/change/:id/conflict', ROLES.read, (req, _reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const worker = ctx
      .elevated()
      .first(T.worker, `task=${rec.sysId}^type=conflict`, [{ field: 'sys_created_on', desc: true }]);
    const payload = readJson<{ record_count?: number; canceled?: boolean }>(worker?.str('payload'), {});
    const state = worker?.num('state') ?? 0;
    const jobStatus = !worker ? '0' : payload.canceled ? '3' : state === 3 ? '2' : state === 4 ? '4' : '1';
    const rows = ctx.query(T.conflict, {
      query: `change=${rec.sysId}`,
      orderBy: [{ field: 'type', desc: false }],
    });
    return {
      result: {
        status: rec.str('conflict_status') || 'Not Run',
        last_run: rec.str('conflict_last_run'),
        record_count: String(payload.record_count ?? 0),
        job_status: jobStatus,
        conflicts: rows.map((r) => serializeChange(ctx, r)),
      },
    };
  });
  route('DELETE', '/change/:id/conflict', ROLES.write, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    clearConflictResults(ctx, rec.sysId);
    const worker = ctx
      .elevated()
      .first(T.worker, `task=${rec.sysId}^type=conflict`, [{ field: 'sys_created_on', desc: true }]);
    if (worker) {
      const payload = readJson<Record<string, unknown>>(worker.str('payload'), {});
      ctx.elevated().update(worker, { payload: JSON.stringify({ ...payload, canceled: true }) });
    }
    return reply.code(200).send();
  });

  // Scheduling assistant
  const scheduleParams = (input: Record<string, unknown>, required: boolean, fallbackMs: number | null) => {
    const rawDuration = input.duration_in_seconds;
    let durationMs: number | null = null;
    if (rawDuration !== undefined && rawDuration !== '') {
      const n = Number(rawDuration);
      if (!Number.isFinite(n) || n <= 0 || !/^\d+(\.0+)?$/.test(String(rawDuration).trim())) {
        throw new HttpError(400, 'Invalid duration', 'duration_in_seconds must be a positive integer');
      }
      durationMs = n * 1000;
    } else if (required) {
      throw new HttpError(400, 'Missing duration', 'duration_in_seconds is required');
    } else {
      durationMs = fallbackMs;
    }
    const startRaw = input.planned_start_time;
    let from = clock.now().getTime();
    if (startRaw !== undefined && startRaw !== '') {
      const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(startRaw))
        ? toMs(String(startRaw))
        : null;
      if (ms === null)
        throw new HttpError(
          400,
          'Invalid planned start time',
          'planned_start_time must be yyyy-mm-dd hh:mm:ss (UTC)',
        );
      from = ms;
    }
    if (!durationMs) throw new HttpError(400, 'Missing duration', 'duration_in_seconds is required');
    return { durationMs, from };
  };
  const slotSearch = (ctx: Context, ciId: string, change: Rec | null, durationMs: number, from: number) => {
    const props = ctx.platform.properties;
    const windowDays = props.getNumber(PROP.slotWindowDays, 90);
    return {
      windowDays,
      slots: findSlots(ctx, {
        ciId,
        change,
        durationMs,
        from,
        windowDays,
        limit: props.getNumber(PROP.slotLimit, 100),
        stepMs: props.getNumber(PROP.slotStepMinutes, 30) * 60_000,
      }),
    };
  };
  route('GET', '/change/:id/schedule', ROLES.schedule, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    if (!rec.str('cmdb_ci') || !rec.str('start_date') || !rec.str('end_date')) {
      throw new HttpError(
        400,
        'Missing schedule data',
        'The change needs a configuration item, a planned start date and a planned end date',
      );
    }
    const { input } = collectInput(req);
    const planned = (toMs(rec.str('end_date')) ?? 0) - (toMs(rec.str('start_date')) ?? 0);
    const { durationMs, from } = scheduleParams(input, false, planned > 0 ? planned : null);
    const worker = createWorker(ctx, 'schedule', {
      change: rec,
      ciId: rec.str('cmdb_ci'),
      request: { ...input, time_zone: ctx.user.timeZone },
    });
    queueWorker(ctx, worker, (wctx) => {
      const { slots, windowDays } = slotSearch(wctx, rec.str('cmdb_ci'), rec, durationMs, from);
      return {
        payload: { spans: slots.map((s) => slotToJson(wctx, s)) },
        messages: slots.length ? {} : { warningMessages: [`No slots found for ${windowDays} days from now`] },
      };
    });
    return reply.code(202).send({ result: workerEnvelope(worker, baseUrl(req, deps)) });
  });
  route('PATCH', '/change/:id/schedule/first_available', ROLES.schedule, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    if (!rec.str('cmdb_ci'))
      throw new HttpError(400, 'Missing configuration item', 'The change needs a configuration item');
    const acl = ctx.platform.acl;
    if (
      !acl.canField(ctx, T.change, 'start_date', 'write', rec) ||
      !acl.canField(ctx, T.change, 'end_date', 'write', rec) ||
      !acl.canTable(ctx, T.change, 'write', rec).allowed
    ) {
      throw new HttpError(403, 'Insufficient rights', 'User cannot write the planned dates of this change');
    }
    const { input } = collectInput(req);
    const { durationMs, from } = scheduleParams(input, true, null);
    const worker = createWorker(ctx, 'schedule', {
      change: rec,
      ciId: rec.str('cmdb_ci'),
      request: { ...input, time_zone: ctx.user.timeZone },
    });
    queueWorker(ctx, worker, (wctx) => {
      const { slots, windowDays } = slotSearch(wctx, rec.str('cmdb_ci'), rec, durationMs, from);
      if (!slots.length)
        return { messages: { warningMessages: [`No slots found for ${windowDays} days from now`] } };
      const target = wctx.get(T.change, rec.sysId);
      if (!target) return { error: true, messages: { errorMessages: ['The change no longer exists'] } };
      wctx.update(target, { start_date: toGlide(slots[0].start), end_date: toGlide(slots[0].end) });
      return {
        payload: { spans: [slotToJson(wctx, slots[0])] },
        messages: { infoMessages: ['Change has been updated'] },
      };
    });
    return reply.code(202).send({ result: workerEnvelope(worker, baseUrl(req, deps)) });
  });
  route('GET', '/change/ci/:id/schedule', ROLES.schedule, (req, reply, ctx) => {
    const ciId = (req.params as { id: string }).id;
    if (!ctx.registry.has('cmdb_ci') || !isSysId(ciId) || !ctx.get('cmdb_ci', ciId)) {
      throw new HttpError(
        400,
        'Invalid configuration item',
        'The configuration item does not exist or cannot be read',
      );
    }
    const { input } = collectInput(req);
    const { durationMs, from } = scheduleParams(input, true, null);
    const worker = createWorker(ctx, 'schedule', {
      ciId,
      request: { ...input, time_zone: ctx.user.timeZone },
    });
    queueWorker(ctx, worker, (wctx) => {
      const { slots, windowDays } = slotSearch(wctx, ciId, null, durationMs, from);
      return {
        payload: { spans: slots.map((s) => slotToJson(wctx, s)) },
        messages: slots.length ? {} : { warningMessages: [`No slots found for ${windowDays} days from now`] },
      };
    });
    return reply.code(202).send({ result: workerEnvelope(worker, baseUrl(req, deps)) });
  });

  // Associated CIs and impacted services
  const ASSOCIATIONS: Record<string, { table: string; key: string }> = {
    affected: { table: T.taskCi, key: 'ci_item' },
    impacted: { table: T.taskService, key: 'cmdb_ci_service' },
    offering: { table: T.taskOffering, key: 'service_offering' },
  };
  route('GET', '/change/:id/ci', ROLES.read, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const type = String(((req.query ?? {}) as Q).association_type ?? '');
    const assoc = ASSOCIATIONS[type];
    if (!assoc)
      throw new HttpError(
        400,
        'Invalid association type',
        'association_type must be affected, impacted or offering',
      );
    return listRecords(req, reply, ctx, deps, assoc.table, {
      implicit: `task=${rec.sysId}`,
      defaultOrder: 'sys_created_on',
    });
  });
  route('POST', '/change/:id/ci', ROLES.write, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const body = bodyOf(req);
    const type = String(body.association_type ?? '');
    const assoc = ASSOCIATIONS[type];
    if (!assoc)
      throw new HttpError(
        400,
        'Invalid association type',
        'association_type must be affected, impacted or offering',
      );
    const rawIds = body.cmdb_ci_sys_ids;
    const ids = (Array.isArray(rawIds) ? rawIds.map(String) : String(rawIds ?? '').split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'Missing configuration items', 'cmdb_ci_sys_ids is required');
    const refresh =
      type === 'affected' &&
      ['true', '1'].includes(String(body.refresh_impacted_services ?? '').toLowerCase());
    const worker = createWorker(ctx, type, { change: rec, request: body });
    queueWorker(ctx, worker, (wctx) => {
      const sys = wctx.elevated();
      const errors: string[] = [];
      const infos: string[] = [];
      const target = assoc.key === 'service_offering' ? 'service_offering' : 'cmdb_ci';
      let added = 0;
      for (const id of ids) {
        if (!isSysId(id) || !wctx.registry.has(target) || !sys.get(target, id)) {
          errors.push(
            `${id} is not a valid ${target === 'cmdb_ci' ? 'configuration item' : 'service offering'}`,
          );
          continue;
        }
        if (sys.first(assoc.table, `task=${rec.sysId}^${assoc.key}=${id}`)) {
          infos.push(`${id} is already associated`);
          continue;
        }
        sys.insert(assoc.table, {
          task: rec.sysId,
          [assoc.key]: id,
          ...(type === 'affected' ? {} : { manually_added: true }),
        });
        added++;
      }
      if (refresh) {
        const change = sys.get(T.change, rec.sysId);
        if (change) infos.push(`${refreshImpactedServices(wctx, change)} impacted service(s) refreshed`);
      }
      return {
        payload: {
          added,
          ignored_cmdb_ci_sys_ids: errors.length
            ? ids.filter((i) => errors.some((m) => m.startsWith(i)))
            : [],
        },
        messages: { errorMessages: errors, infoMessages: infos },
      };
    });
    return reply.code(202).send({ result: workerEnvelope(worker, baseUrl(req, deps)) });
  });
  route('POST', '/change/:id/refresh_impacted_services', ROLES.write, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const worker = createWorker(ctx, 'impacted', { change: rec, request: {} });
    queueWorker(ctx, worker, (wctx) => {
      const change = wctx.elevated().get(T.change, rec.sysId);
      const n = change ? refreshImpactedServices(wctx, change) : 0;
      return {
        payload: { impacted_services: n },
        messages: { infoMessages: [`${n} impacted service(s) linked`] },
      };
    });
    return reply.code(200).send({ result: workerEnvelope(worker, baseUrl(req, deps)) });
  });

  // Change tasks
  const taskOf = (ctx: Context, changeId: string, taskId: string): Rec => {
    const task = ctx.get(T.task, taskId);
    if (!task || task.str('change_request') !== changeId) throw new NotFoundError();
    return task;
  };
  route('GET', '/change/:id/task', ROLES.read, (req, reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    return listRecords(req, reply, ctx, deps, T.task, { implicit: `change_request=${rec.sysId}` });
  });
  route('POST', '/change/:id/task', ROLES.write, (req, _reply, ctx) => {
    const rec = changeById(ctx, (req.params as { id: string }).id);
    const { input, displayFields } = collectInput(req);
    const draft = ctx.newRecord(T.task);
    const { values, ignored } = splitInput(ctx, draft, input, {
      insert: true,
      deny: ['change_request', 'parent'],
    });
    const rest = applyDisplayInputs(draft, values, displayFields);
    const task = ctx.insert(draft, { ...rest, change_request: rec.sysId, parent: rec.sysId });
    return respond(
      req,
      ctx,
      task,
      ignored.filter((f) => f !== 'change_request' && f !== 'parent'),
    );
  });
  route('PATCH', '/change/:id/task/:task', ROLES.write, (req, _reply, ctx) => {
    const { id, task: taskId } = req.params as { id: string; task: string };
    changeById(ctx, id);
    const task = taskOf(ctx, id, taskId);
    const { input, displayFields } = collectInput(req);
    const { values, ignored } = splitInput(ctx, task, input, {
      insert: false,
      deny: ['change_request', 'parent'],
    });
    const rest = applyDisplayInputs(task, values, displayFields);
    ctx.update(task, rest);
    return respond(req, ctx, task, ignored);
  });
  route('DELETE', '/change/:id/task/:task', ROLES.delete, (req, _reply, ctx) => {
    const { id, task: taskId } = req.params as { id: string; task: string };
    changeById(ctx, id);
    const task = taskOf(ctx, id, taskId);
    const before = respond(req, ctx, task);
    ctx.delete(task);
    return before;
  });

  // Workers
  route('GET', '/change/worker/:id', ROLES.read, (req, _reply, ctx) => {
    const worker = ctx.elevated().get(T.worker, (req.params as { id: string }).id);
    if (!worker) throw new NotFoundError();
    return { result: workerEnvelope(worker, baseUrl(req, deps)) };
  });
}

function canReadModel(ctx: Context, model: Rec): boolean {
  const roles = model
    .str('read_roles')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return !roles.length || ctx.hasAnyRole(roles);
}
