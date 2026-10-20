/**
 * ITSM tools exposed over MCP. Every tool runs as the authenticated user: reads and
 * writes go through that user's context, so ACLs and business rules apply. Requester
 * (non-agent) access follows the documented ownership rules: own records only,
 * reduced fields, comments instead of work notes.
 */
import { z } from 'zod';
import type { Context } from '../../../engine/context.js';
import { AccessError } from '../../../engine/errors.js';
import type { Platform } from '../../../engine/platform.js';
import { QueryBuilder } from '../../../engine/querybuilder.js';
import type { Rec } from '../../../engine/record.js';
import { addMs, nowGlide } from '../../../engine/util.js';
import { formatDateTimeInZone } from '../../../engine/values.js';
import { type ApprovalService, optionalService, SERVICES } from '../../contracts.js';
import { textSimilarity } from '../ml/similarity.js';
import { analyze, plainText, truncate } from '../ml/text.js';
import type { AiEngine } from '../service.js';
import { canSeeWorkNotes } from '../skills/context.js';
import { stateKind } from '../skills/defs.js';

export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_STATE'
  | 'VALIDATION'
  | 'CONFIRMATION_REQUIRED';

/** A business error returned to the client as a tool result with isError. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolEnv {
  ctx: Context;
  platform: Platform;
  engine: AiEngine | undefined;
  baseUrl: string;
  /** Records the record a call touched (for the call log). */
  touch(rec: Rec): void;
  /** Throws CONFIRMATION_REQUIRED (with a token) unless args carry a valid confirmation token. */
  confirm(tool: string, args: Args, preview: Record<string, unknown>): void;
}

export type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  dotted: string;
  title: string;
  description: string;
  input: Record<string, z.ZodType>;
  readOnly: boolean;
  idempotent: boolean;
  visible(ctx: Context): boolean;
  run(env: ToolEnv, args: Args): Record<string, unknown>;
}

// ------------------------------------------------------------------ helpers

const s = (a: Args, k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
const b = (a: Args, k: string, d = false): boolean => (typeof a[k] === 'boolean' ? (a[k] as boolean) : d);
const n = (a: Args, k: string, d: number, min: number, max: number): number =>
  typeof a[k] === 'number' && Number.isFinite(a[k])
    ? Math.min(max, Math.max(min, Math.trunc(a[k] as number)))
    : d;
const obj = (a: Args, k: string): Record<string, string> => {
  const v = a[k];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([key, val]) => [
      key,
      val === null || val === undefined ? '' : String(val),
    ]),
  );
};
const list = (a: Args, k: string): string[] =>
  Array.isArray(a[k]) ? (a[k] as unknown[]).map(String).filter(Boolean) : [];

const has = (p: Platform, table: string) => p.registry.has(table);
const isFulfiller = (ctx: Context) =>
  ctx.user.isSystem || ctx.hasAnyRole(['itil', 'sn_incident_read', 'sn_incident_write']);
const canWriteIncidents = (ctx: Context) =>
  ctx.user.isSystem || ctx.hasAnyRole(['itil', 'sn_incident_write']);
const isChangeReader = (ctx: Context) =>
  ctx.hasAnyRole(['itil', 'sn_change_read', 'sn_change_write', 'change_manager']);
const isChangeWriter = (ctx: Context) => ctx.hasAnyRole(['itil', 'sn_change_write', 'change_manager']);

/** Words of a natural reference such as "my latest request" that do not name its subject. */
const REFERENCE_WORDS = new Set(
  analyze(
    'my latest last recent newest most current open ticket tickets request requests incident incidents issue issues status update',
    {
      keepStopWords: true,
    },
  ),
);

const notFound = (what: string) =>
  new ToolError('NOT_FOUND', `${what} was not found or you do not have access to it`);

function byNumberOrId(ctx: Context, table: string, number: string, sysId: string): Rec | null {
  if (sysId) return ctx.get(table, sysId);
  if (!number) return null;
  const qb = new QueryBuilder(table).addQuery('number', number.toUpperCase());
  qb.limit = 1;
  return ctx.query(table, qb)[0] ?? null;
}

function requireKey(a: Args, numberKey = 'number', idKey = 'sys_id'): { number: string; sysId: string } {
  const number = s(a, numberKey);
  const sysId = s(a, idKey);
  if (!number && !sysId) throw new ToolError('VALIDATION', `${numberKey} or ${idKey} is required`);
  return { number, sysId };
}

/** Requester ownership of a task-like record. */
function owns(ctx: Context, rec: Rec): boolean {
  const me = ctx.user.sysId;
  if (!me) return false;
  return ['caller_id', 'opened_by', 'requested_for'].some((f) => rec.has(f) && rec.str(f) === me);
}

function linkFor(env: ToolEnv, rec: Rec): string {
  return `${env.baseUrl}/workspace/record/${rec.className}/${rec.sysId}`;
}

function display(ctx: Context, rec: Rec, field: string): string {
  if (!rec.has(field) || !ctx.platform.acl.canField(ctx, rec.className, field, 'read', rec)) return '';
  const col = rec.column(field);
  if (col?.type === 'html') return plainText(rec.str(field));
  return rec.display(field);
}

function fieldsOf(ctx: Context, rec: Rec, fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!rec.has(f)) continue;
    const v = display(ctx, rec, f);
    if (v !== '') out[f] = v;
  }
  return out;
}

function summary(ctx: Context, rec: Rec): Record<string, unknown> {
  return {
    sys_id: rec.sysId,
    number: rec.has('number') ? rec.str('number') : rec.displayValue(),
    ...fieldsOf(ctx, rec, [
      'short_description',
      'state',
      'priority',
      'assignment_group',
      'assigned_to',
      'sys_updated_on',
    ]),
  };
}

function activity(ctx: Context, rec: Rec, includeWorkNotes: boolean, limit = 20): Record<string, string>[] {
  const fields = ['comments', ...(includeWorkNotes ? ['work_notes'] : [])].filter((f) => rec.has(f));
  if (!fields.length) return [];
  return ctx.platform.history
    .journal(rec.className, rec.sysId, fields)
    .slice(0, limit)
    .map((j) => ({ type: j.element, at: j.sys_created_on, by: j.sys_created_by, text: j.value }));
}

/** Resolves a user/group/CI reference from a sys_id, name, user name or email. */
function resolveRef(ctx: Context, table: string, value: string, what: string): string {
  if (!value) return '';
  const w = ctx.elevated();
  if (/^[0-9a-f]{32}$/.test(value) && w.get(table, value)) return value;
  const meta = ctx.platform.registry.tryTable(table);
  if (!meta) throw new ToolError('VALIDATION', `${what} cannot be resolved: table ${table} is not installed`);
  const keys = [meta.displayField, 'name', 'user_name', 'email'].filter(
    (k, i, arr) => meta.columns.has(k) && arr.indexOf(k) === i,
  );
  for (const k of keys) {
    const qb = new QueryBuilder(table).addQuery(k, value);
    qb.limit = 1;
    const hit = w.query(table, qb)[0];
    if (hit) return hit.sysId;
  }
  throw new ToolError('VALIDATION', `${what} "${value}" was not found`);
}

function closeCodeForCaller(p: Platform): string {
  const choices = p.choices.list('incident', 'close_code');
  return (
    choices.find((c) => /caller/i.test(c.value) || /caller/i.test(c.label))?.value ?? 'Resolved by caller'
  );
}

const INCIDENT_FIELDS = [
  'short_description',
  'description',
  'state',
  'priority',
  'impact',
  'urgency',
  'category',
  'subcategory',
  'caller_id',
  'opened_by',
  'opened_at',
  'assignment_group',
  'assigned_to',
  'cmdb_ci',
  'business_service',
  'contact_type',
  'problem_id',
  'parent_incident',
  'close_code',
  'close_notes',
  'resolved_at',
  'sys_updated_on',
];

const REQUESTER_FIELDS = [
  'short_description',
  'description',
  'state',
  'priority',
  'urgency',
  'impact',
  'opened_by',
  'opened_at',
];

function incidentDetails(
  env: ToolEnv,
  rec: Rec,
  requested: string[],
  fulfiller: boolean,
): Record<string, unknown> {
  const ctx = env.ctx;
  const fields = fulfiller ? (requested.length ? requested : INCIDENT_FIELDS) : REQUESTER_FIELDS;
  const view = fulfiller ? ctx : ctx.elevated();
  return {
    sys_id: rec.sysId,
    number: rec.str('number'),
    ...fieldsOf(view, rec, fields),
    link: linkFor(env, rec),
    activity: activity(ctx, rec, fulfiller && canSeeWorkNotes(ctx, rec)),
  };
}

/** Finds an incident for the caller: agents through their ACLs, requesters among their own records. */
function findIncident(ctx: Context, number: string, sysId: string): Rec | null {
  if (isFulfiller(ctx)) return byNumberOrId(ctx, 'incident', number, sysId);
  const rec = byNumberOrId(ctx.elevated(), 'incident', number, sysId);
  return rec && owns(ctx, rec) ? rec : null;
}

function insertAsRequester(ctx: Context, table: string, values: Record<string, unknown>): Rec {
  try {
    return ctx.insert(table, values);
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    return ctx.elevated().insert(table, values);
  }
}

function kbHit(
  env: ToolEnv,
  h: {
    sys_id: string;
    number: string;
    title: string;
    score: number;
    knowledge_base?: string;
    snippet?: string;
    table: string;
  },
) {
  return {
    number: h.number,
    sys_id: h.sys_id,
    title: h.title,
    relevance: h.score,
    knowledge_base: h.knowledge_base ?? '',
    snippet: h.snippet ?? '',
    url: `${env.baseUrl}/workspace/record/${h.table}/${h.sys_id}`,
  };
}

function publishedArticle(env: ToolEnv, number: string, sysId: string): Rec {
  const rec = byNumberOrId(env.ctx, 'kb_knowledge', number, sysId);
  if (
    !rec ||
    (rec.has('workflow_state') && rec.str('workflow_state') !== 'published') ||
    (rec.has('active') && !rec.bool('active'))
  ) {
    throw notFound(`Published knowledge article ${number || sysId}`);
  }
  return rec;
}

// ------------------------------------------------------------------ session tokens

/** Signed, stateless session for requester_create_incident. */
export interface CreateSession {
  u: string;
  d: string;
  g: string;
  e: number;
}

// ------------------------------------------------------------------ definitions

export function toolDefinitions(sessions: {
  sign(s: CreateSession): string;
  verify(token: string): CreateSession | null;
}): ToolDef[] {
  const incidentKey = {
    number: z.string().optional().describe('Incident number, for example INC0010023'),
    sys_id: z.string().optional().describe('Incident sys_id'),
  };

  const tools: ToolDef[] = [
    {
      name: 'incident_get_details',
      dotted: 'sn_itsm_mcp_server.incident.get_details',
      title: 'Get incident details',
      description:
        'Return one incident by number or sys_id. Agents get the full record with assignment, CI and the activity stream (work notes included); a requester gets a reduced field set with comments only, and only for incidents they reported.',
      input: {
        ...incidentKey,
        fields: z.array(z.string()).optional().describe('Optional subset of fields (agents only)'),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'incident'),
      run(env, a) {
        const { number, sysId } = requireKey(a);
        const rec = findIncident(env.ctx, number, sysId);
        if (!rec) throw notFound(`Incident ${number || sysId}`);
        env.touch(rec);
        return incidentDetails(env, rec, list(a, 'fields'), isFulfiller(env.ctx));
      },
    },
    {
      name: 'incident_search',
      dotted: 'resolvr.incident.search',
      title: 'Search incidents',
      description:
        'Search incidents with an encoded query and/or keywords (agents). Returns number, short description, state, priority and assignment.',
      input: {
        query: z.string().optional().describe('Encoded query, for example active=true^priority=1'),
        text: z
          .string()
          .optional()
          .describe('Keywords matched against number, short description and description'),
        active: z.boolean().optional(),
        assigned_to_me: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'incident') && isFulfiller(ctx),
      run(env, a) {
        const qb = new QueryBuilder('incident');
        if (s(a, 'query')) qb.addEncodedQuery(s(a, 'query'));
        if (s(a, 'text')) qb.addQuery('123TEXTQUERY321', s(a, 'text'));
        if (typeof a.active === 'boolean') qb.addQuery('active', a.active);
        if (b(a, 'assigned_to_me')) qb.addQuery('assigned_to', env.ctx.user.sysId ?? '');
        if (!qb.orderBy.length) qb.orderByDesc('sys_updated_on');
        const total = env.ctx.count('incident', qb);
        qb.limit = n(a, 'limit', 20, 1, 100);
        qb.offset = n(a, 'offset', 0, 0, 1_000_000);
        const recs = env.ctx.query('incident', qb);
        return { total, count: recs.length, results: recs.map((r) => summary(env.ctx, r)) };
      },
    },
    {
      name: 'incident_search_similar',
      dotted: 'sn_itsm_mcp_server.incident.search_similar',
      title: 'Find similar incidents',
      description:
        'Find incidents similar to a given incident (by number) or to a free-text description, ranked by a 0-100 similarity score.',
      input: {
        number: z.string().optional(),
        text: z.string().optional(),
        active_only: z.boolean().optional(),
        opened_within_days: z.number().int().min(1).max(3650).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'incident') && isFulfiller(ctx),
      run(env, a) {
        if (!env.engine) throw new ToolError('INVALID_STATE', 'Similarity search is not available');
        const limit = n(a, 'limit', 10, 1, 50);
        const days = n(a, 'opened_within_days', 0, 0, 3650);
        const since = days ? addMs(nowGlide(), -days * 86_400_000) : '';
        const filter = (r: Rec) =>
          (!b(a, 'active_only') || r.bool('active')) &&
          (!since || (r.str('opened_at') || r.str('sys_created_on')) >= since);
        let text = s(a, 'text');
        const exclude: string[] = [];
        if (s(a, 'number')) {
          const src = byNumberOrId(env.ctx, 'incident', s(a, 'number'), '');
          if (!src) throw notFound(`Incident ${s(a, 'number')}`);
          env.touch(src);
          text = env.engine.similarity.textOf(src);
          exclude.push(src.sysId);
        }
        if (!text) throw new ToolError('VALIDATION', 'number or text is required');
        const hits = env.engine.similarity.similarToText(env.ctx, text, 'incident', {
          limit,
          minScore: 10,
          exclude,
          filter,
        });
        return {
          count: hits.length,
          results: hits.map((h) => ({
            number: h.number,
            sys_id: h.sys_id,
            short_description: h.title,
            state: h.state ?? '',
            score: h.score,
          })),
        };
      },
    },
    {
      name: 'incident_create',
      dotted: 'resolvr.incident.create',
      title: 'Create an incident',
      description:
        'Create an incident. Agents may set the caller, assignment and configuration item; any other user creates an incident for themselves (short description, description, urgency).',
      input: {
        short_description: z.string().min(3),
        description: z.string().optional(),
        urgency: z.enum(['1', '2', '3']).optional(),
        impact: z.enum(['1', '2', '3']).optional(),
        category: z.string().optional(),
        caller: z.string().optional().describe('User name, email or sys_id (agents only)'),
        assignment_group: z.string().optional().describe('Group name or sys_id (agents only)'),
        assigned_to: z.string().optional().describe('User name or sys_id (agents only)'),
        cmdb_ci: z.string().optional().describe('Configuration item name or sys_id (agents only)'),
        work_notes: z.string().optional(),
      },
      readOnly: false,
      idempotent: false,
      visible: (ctx) => has(ctx.platform, 'incident'),
      run(env, a) {
        const ctx = env.ctx;
        const values: Record<string, unknown> = {
          short_description: s(a, 'short_description'),
          description: s(a, 'description') || undefined,
        };
        if (s(a, 'urgency')) values.urgency = s(a, 'urgency');
        if (canWriteIncidents(ctx)) {
          if (s(a, 'impact')) values.impact = s(a, 'impact');
          if (s(a, 'category')) values.category = s(a, 'category');
          values.caller_id = s(a, 'caller')
            ? resolveRef(ctx, 'sys_user', s(a, 'caller'), 'Caller')
            : ctx.user.sysId;
          if (s(a, 'assignment_group'))
            values.assignment_group = resolveRef(
              ctx,
              'sys_user_group',
              s(a, 'assignment_group'),
              'Assignment group',
            );
          if (s(a, 'assigned_to'))
            values.assigned_to = resolveRef(ctx, 'sys_user', s(a, 'assigned_to'), 'Assignee');
          if (s(a, 'cmdb_ci'))
            values.cmdb_ci = resolveRef(ctx, 'cmdb_ci', s(a, 'cmdb_ci'), 'Configuration item');
          if (s(a, 'work_notes')) values.work_notes = s(a, 'work_notes');
          const rec = ctx.insert('incident', values);
          env.touch(rec);
          return { status: 'created', ...summary(ctx, rec), link: linkFor(env, rec) };
        }
        const extra = [
          'impact',
          'category',
          'caller',
          'assignment_group',
          'assigned_to',
          'cmdb_ci',
          'work_notes',
        ].filter((k) => s(a, k));
        if (extra.length) throw new ToolError('FORBIDDEN', `Only agents can set: ${extra.join(', ')}`);
        values.caller_id = ctx.user.sysId;
        const rec = insertAsRequester(ctx, 'incident', values);
        env.touch(rec);
        return {
          status: 'created',
          number: rec.str('number'),
          sys_id: rec.sysId,
          state: rec.display('state'),
          link: linkFor(env, rec),
        };
      },
    },
    {
      name: 'incident_modify',
      dotted: 'sn_itsm_mcp_server.incident.modify',
      title: 'Update an incident',
      description:
        'Update an incident. Agents may add work notes and comments, reassign (assignment_group, assigned_to), resolve, or set other writable fields; business rules run. A requester may only, on an incident they reported: add a comment, escalate (escalate=true with escalation_reason, sent alone), or resolve an active incident (needs a confirmation_token from a first call).',
      input: {
        ...incidentKey,
        work_notes: z.string().optional(),
        comments: z.string().optional(),
        assigned_to: z.string().optional().describe('User name, email or sys_id'),
        assignment_group: z.string().optional().describe('Group name or sys_id'),
        fields: z.record(z.string(), z.string()).optional().describe('Other writable fields (agents only)'),
        escalate: z.boolean().optional(),
        escalation_reason: z.string().optional(),
        resolve: z.boolean().optional(),
        close_code: z.string().optional(),
        close_notes: z.string().optional(),
        confirmation_token: z.string().optional(),
      },
      readOnly: false,
      idempotent: false,
      visible: (ctx) => has(ctx.platform, 'incident'),
      run(env, a) {
        const ctx = env.ctx;
        const { number, sysId } = requireKey(a);
        if (isFulfiller(ctx) && !canWriteIncidents(ctx))
          throw new ToolError('FORBIDDEN', 'Your role allows reading incidents but not updating them');
        const rec = findIncident(ctx, number, sysId);
        if (!rec) throw notFound(`Incident ${number || sysId}`);
        env.touch(rec);
        if (canWriteIncidents(ctx)) {
          const values: Record<string, unknown> = {};
          if (s(a, 'work_notes')) values.work_notes = s(a, 'work_notes');
          if (s(a, 'comments')) values.comments = s(a, 'comments');
          if (s(a, 'assignment_group'))
            values.assignment_group = resolveRef(
              ctx,
              'sys_user_group',
              s(a, 'assignment_group'),
              'Assignment group',
            );
          if (s(a, 'assigned_to'))
            values.assigned_to = resolveRef(ctx, 'sys_user', s(a, 'assigned_to'), 'Assignee');
          for (const [k, v] of Object.entries(obj(a, 'fields'))) {
            if (!rec.has(k) || k.startsWith('sys_') || k === 'number')
              throw new ToolError('VALIDATION', `Unknown or read-only field ${k}`);
            if (!ctx.platform.acl.canField(ctx, rec.className, k, 'write', rec))
              throw new ToolError('FORBIDDEN', `You cannot write the field ${k}`);
            values[k] = v;
          }
          if (b(a, 'escalate')) values.urgency = '1';
          if (b(a, 'resolve')) {
            values.state = '6';
            if (s(a, 'close_code')) values.close_code = s(a, 'close_code');
            if (s(a, 'close_notes')) values.close_notes = s(a, 'close_notes');
          }
          if (!Object.keys(values).length) throw new ToolError('VALIDATION', 'Nothing to update');
          ctx.update(rec, values);
          return { status: 'updated', ...summary(ctx, rec), updated_fields: Object.keys(values) };
        }
        // Requester on an incident they reported.
        const forbidden = ['work_notes', 'assigned_to', 'assignment_group', 'close_code'].filter((k) =>
          s(a, k),
        );
        if (forbidden.length || Object.keys(obj(a, 'fields')).length) {
          throw new ToolError(
            'FORBIDDEN',
            'Requesters can only comment on, escalate or resolve their own incidents',
          );
        }
        const w = ctx.elevated();
        const kind = stateKind(rec);
        if (b(a, 'escalate')) {
          if (s(a, 'comments') || b(a, 'resolve'))
            throw new ToolError('VALIDATION', 'Send escalate alone, with escalation_reason');
          const reason = s(a, 'escalation_reason');
          if (!reason) throw new ToolError('VALIDATION', 'escalation_reason is required to escalate');
          if (kind === 'resolved' || kind === 'closed' || kind === 'canceled')
            throw new ToolError(
              'INVALID_STATE',
              'Resolved, closed or canceled incidents cannot be escalated',
            );
          if (rec.str('urgency') === '1')
            throw new ToolError('INVALID_STATE', 'The incident already has the highest urgency');
          const dayAgo = addMs(nowGlide(), -86_400_000);
          const recent = ctx.platform.history
            .audit(rec.className, rec.sysId)
            .some((x) => x.fieldname === 'urgency' && x.newvalue === '1' && x.sys_created_on >= dayAgo);
          if (recent)
            throw new ToolError('INVALID_STATE', 'The incident was already escalated in the last 24 hours');
          w.update(rec, { urgency: '1', comments: `Escalation requested by the caller: ${reason}` });
          return { status: 'escalated', number: rec.str('number'), urgency: rec.display('urgency') };
        }
        if (b(a, 'resolve')) {
          if (kind !== 'new' && kind !== 'wip')
            throw new ToolError('INVALID_STATE', 'Only active, unresolved incidents can be resolved');
          env.confirm(
            'incident_modify',
            { sys_id: rec.sysId, resolve: true },
            { number: rec.str('number'), action: 'resolve' },
          );
          w.update(rec, {
            state: '6',
            close_code: closeCodeForCaller(ctx.platform),
            close_notes: s(a, 'close_notes') || 'Resolved by the caller.',
            ...(s(a, 'comments') ? { comments: s(a, 'comments') } : {}),
          });
          return { status: 'resolved', number: rec.str('number'), state: rec.display('state') };
        }
        if (!s(a, 'comments'))
          throw new ToolError('VALIDATION', 'Nothing to update: send comments, escalate or resolve');
        w.update(rec, { comments: s(a, 'comments') });
        return { status: 'commented', number: rec.str('number') };
      },
    },
    {
      name: 'task_add_note',
      dotted: 'resolvr.task.add_note',
      title: 'Add a note to a task',
      description:
        'Add a work note (agents) or a customer-visible comment to any task (incident, problem, change, request item...) identified by its number. Requesters can comment on their own records only.',
      input: { number: z.string(), work_notes: z.string().optional(), comments: z.string().optional() },
      readOnly: false,
      idempotent: false,
      visible: () => true,
      run(env, a) {
        const ctx = env.ctx;
        const number = s(a, 'number');
        if (!s(a, 'work_notes') && !s(a, 'comments'))
          throw new ToolError('VALIDATION', 'work_notes or comments is required');
        const agent = ctx.hasRole('itil') || ctx.user.isSystem;
        let rec = agent ? byNumberOrId(ctx, 'task', number, '') : null;
        if (!agent) {
          const found = byNumberOrId(ctx.elevated(), 'task', number, '');
          rec = found && owns(ctx, found) ? found : null;
        }
        if (!rec) throw notFound(`Task ${number}`);
        env.touch(rec);
        if (!agent) {
          if (s(a, 'work_notes')) throw new ToolError('FORBIDDEN', 'Only agents can add work notes');
          ctx.elevated().update(rec, { comments: s(a, 'comments') });
          return { status: 'commented', number: rec.str('number') };
        }
        const values: Record<string, unknown> = {};
        if (s(a, 'work_notes')) values.work_notes = s(a, 'work_notes');
        if (s(a, 'comments')) values.comments = s(a, 'comments');
        ctx.update(rec, values);
        return {
          status: 'updated',
          number: rec.str('number'),
          table: rec.className,
          updated_fields: Object.keys(values),
        };
      },
    },
    {
      name: 'incident_search_similar_kb',
      dotted: 'sn_itsm_mcp_server.incident.search_similar_kb',
      title: 'Search knowledge articles',
      description:
        'Search active, published knowledge articles from a query or from an incident (its short description and description). Each hit has the article number, a 0-100 relevance score, knowledge base, title and URL.',
      input: {
        query: z.string().optional(),
        incident_number: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'kb_knowledge') && isFulfiller(ctx),
      run(env, a) {
        if (!env.engine) throw new ToolError('INVALID_STATE', 'Knowledge search is not available');
        let text = s(a, 'query');
        if (s(a, 'incident_number')) {
          const inc = has(env.platform, 'incident')
            ? byNumberOrId(env.ctx, 'incident', s(a, 'incident_number'), '')
            : null;
          if (!inc) throw notFound(`Incident ${s(a, 'incident_number')}`);
          env.touch(inc);
          text = `${text} ${env.engine.similarity.textOf(inc)}`.trim();
        }
        if (!text) throw new ToolError('VALIDATION', 'query or incident_number is required');
        const hits = env.engine.similarity.suggestKnowledge(env.ctx, text, {
          limit: n(a, 'limit', 5, 1, 20),
          minScore: 10,
        });
        return { count: hits.length, results: hits.map((h) => kbHit(env, h)) };
      },
    },
    {
      name: 'incident_get_kb_details',
      dotted: 'sn_itsm_mcp_server.incident.get_kb_details',
      title: 'Get a knowledge article',
      description:
        'Return one published knowledge article (title, knowledge base, state, publish date and full body) by number or sys_id.',
      input: {
        number: z.string().optional().describe('For example KB0012345'),
        sys_id: z.string().optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'kb_knowledge') && isFulfiller(ctx),
      run(env, a) {
        const { number, sysId } = requireKey(a);
        const rec = publishedArticle(env, number, sysId);
        env.touch(rec);
        return {
          sys_id: rec.sysId,
          number: rec.str('number'),
          title: rec.str('short_description'),
          ...fieldsOf(env.ctx, rec, [
            'kb_knowledge_base',
            'kb_category',
            'workflow_state',
            'published',
            'valid_to',
            'author',
          ]),
          body: truncate(plainText(rec.str('text')), 20_000),
          url: linkFor(env, rec),
        };
      },
    },
    {
      name: 'incident_attach_kb',
      dotted: 'sn_itsm_mcp_server.incident.attach_kb',
      title: 'Attach a knowledge article to an incident',
      description:
        'Link an active, published knowledge article to an incident (numbers or sys_ids). Returns {status: "attached", incident, kb_number, message}.',
      input: {
        incident: z.string().describe('Incident number or sys_id'),
        kb_article: z.string().describe('Article number or sys_id'),
      },
      readOnly: false,
      idempotent: false,
      visible: (ctx) =>
        has(ctx.platform, 'incident') && has(ctx.platform, 'kb_knowledge') && canWriteIncidents(ctx),
      run(env, a) {
        const ctx = env.ctx;
        const incKey = s(a, 'incident');
        const kbKey = s(a, 'kb_article');
        const isId = (v: string) => /^[0-9a-f]{32}$/.test(v);
        const inc = byNumberOrId(ctx, 'incident', isId(incKey) ? '' : incKey, isId(incKey) ? incKey : '');
        if (!inc) throw notFound(`Incident ${incKey}`);
        const art = publishedArticle(env, isId(kbKey) ? '' : kbKey, isId(kbKey) ? kbKey : '');
        if (!ctx.platform.acl.canTable(ctx, inc.className, 'write', inc).allowed)
          throw new ToolError('FORBIDDEN', 'You cannot update this incident');
        env.touch(inc);
        const kbNumber = art.str('number');
        if (has(ctx.platform, 'm2m_kb_task')) {
          const w = ctx.elevated();
          if (!w.first('m2m_kb_task', `kb_knowledge=${art.sysId}^task=${inc.sysId}`))
            w.insert('m2m_kb_task', { kb_knowledge: art.sysId, task: inc.sysId });
        }
        ctx.update(inc, {
          work_notes: `Knowledge article ${kbNumber} (${art.str('short_description')}) attached.`,
        });
        return {
          status: 'attached',
          incident: inc.str('number'),
          kb_number: kbNumber,
          message: `${kbNumber} is now linked to ${inc.str('number')}`,
        };
      },
    },
    {
      name: 'requester_create_incident',
      dotted: 'sn_itsm_mcp_server.requester.create_incident',
      title: 'Report an issue (guided)',
      description:
        'Guided incident creation for the signed-in user. First call with a description: returns suggested knowledge articles, possible duplicates among your open incidents and the proposed fields, plus a session_id. Then call again with session_id and choice.type = solved_by_article, is_duplicate (choice.id = incident number), continue (review) or submit (create).',
      input: {
        description: z.string().optional(),
        session_id: z.string().optional(),
        choice: z
          .object({
            type: z.enum(['solved_by_article', 'use_catalog_item', 'is_duplicate', 'continue', 'submit']),
            id: z.string().optional(),
          })
          .optional(),
        urgency: z.enum(['1', '2', '3']).optional(),
      },
      readOnly: false,
      idempotent: false,
      visible: (ctx) => has(ctx.platform, 'incident') && !!ctx.user.sysId,
      run(env, a) {
        const ctx = env.ctx;
        const me = ctx.user.sysId!;
        const ownOpen = () =>
          ctx.elevated().query('incident', {
            query: `active=true^caller_id=${me}^ORopened_by=${me}`,
            orderBy: [{ field: 'sys_updated_on', desc: true }],
            limit: 50,
          });
        if (!s(a, 'session_id')) {
          const description = s(a, 'description');
          if (description.length < 5)
            throw new ToolError('VALIDATION', 'Describe the issue (description) to start');
          const urgency = s(a, 'urgency') || '3';
          const session = sessions.sign({ u: me, d: description, g: urgency, e: Date.now() + 3_600_000 });
          const articles = env.engine
            ? env.engine.similarity.suggestKnowledge(ctx, description, { limit: 3 }).map((h) => kbHit(env, h))
            : [];
          const duplicates = ownOpen()
            .map((r) => ({
              r,
              score: Math.max(
                textSimilarity(description, r.str('short_description')),
                textSimilarity(description, `${r.str('short_description')} ${r.str('description')}`),
              ),
            }))
            .filter((x) => x.score >= 40)
            .slice(0, 3)
            .map((x) => ({
              number: x.r.str('number'),
              short_description: x.r.str('short_description'),
              state: x.r.display('state'),
              score: x.score,
            }));
          return {
            step: 'review',
            session_id: session,
            proposed: {
              short_description: truncate(description.split(/(?<=[.!?])\s/)[0], 160),
              description,
              urgency,
            },
            suggested_articles: articles,
            possible_duplicates: duplicates,
            next: 'Call again with session_id and choice.type: solved_by_article, is_duplicate (choice.id), continue or submit.',
          };
        }
        const session = sessions.verify(s(a, 'session_id'));
        if (!session || session.u !== me)
          throw new ToolError(
            'VALIDATION',
            'The session_id is invalid or expired; start again with a description',
          );
        const choice = (a.choice ?? { type: 'continue' }) as { type: string; id?: string };
        if (choice.type === 'solved_by_article')
          return {
            step: 'done',
            outcome: 'deflected',
            message: 'Glad the article helped. No incident was created.',
          };
        if (choice.type === 'use_catalog_item')
          throw new ToolError(
            'VALIDATION',
            'Catalog redirection is not available through this tool; order the item from the portal',
          );
        if (choice.type === 'is_duplicate') {
          const dup = ownOpen().find(
            (r) =>
              r.str('number').toUpperCase() === String(choice.id ?? '').toUpperCase() ||
              r.sysId === choice.id,
          );
          if (!dup) throw notFound(`Open incident ${choice.id ?? ''}`);
          ctx
            .elevated()
            .update(dup, { comments: `Additional information from the requester:\n${session.d}` });
          env.touch(dup);
          return { step: 'done', outcome: 'commented', incident: dup.str('number'), link: linkFor(env, dup) };
        }
        const urgency = s(a, 'urgency') || session.g;
        if (choice.type === 'continue') {
          return {
            step: 'confirm',
            session_id: s(a, 'session_id'),
            fields: {
              short_description: truncate(session.d.split(/(?<=[.!?])\s/)[0], 160),
              description: session.d,
              urgency,
            },
            next: 'Call again with the same session_id and choice.type = submit to create the incident.',
          };
        }
        const rec = insertAsRequester(ctx, 'incident', {
          short_description: truncate(session.d.split(/(?<=[.!?])\s/)[0], 160),
          description: session.d,
          urgency,
          caller_id: me,
        });
        env.touch(rec);
        return {
          step: 'done',
          outcome: 'created',
          number: rec.str('number'),
          sys_id: rec.sysId,
          link: linkFor(env, rec),
        };
      },
    },
    {
      name: 'requester_check_status',
      dotted: 'sn_itsm_mcp_server.requester.check_status',
      title: 'Check my ticket status',
      description:
        'Status of the signed-in user\'s own incident or requested item, by number or by a natural reference such as "my latest request" or "vpn". Incidents: number, short description, description, priority, urgency, impact, state, created by and on. Requested items: number, approval, state, stage, estimated delivery.',
      input: {
        number: z.string().optional(),
        reference: z.string().optional(),
        include_closed: z.boolean().optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) =>
        (has(ctx.platform, 'incident') || has(ctx.platform, 'sc_req_item')) && !!ctx.user.sysId,
      run(env, a) {
        const ctx = env.ctx;
        const me = ctx.user.sysId!;
        const w = ctx.elevated();
        const active = b(a, 'include_closed') ? '' : 'active=true^';
        const order = [{ field: 'sys_updated_on', desc: true }];
        const recs: Rec[] = [];
        if (has(ctx.platform, 'incident'))
          recs.push(
            ...w.query('incident', {
              query: `${active}caller_id=${me}^ORopened_by=${me}`,
              orderBy: order,
              limit: 100,
            }),
          );
        if (has(ctx.platform, 'sc_req_item'))
          recs.push(
            ...w.query('sc_req_item', {
              query: `${active}requested_for=${me}^ORopened_by=${me}`,
              orderBy: order,
              limit: 100,
            }),
          );
        recs.sort((x, y) => (x.str('sys_updated_on') < y.str('sys_updated_on') ? 1 : -1));
        let match: Rec | undefined;
        if (s(a, 'number'))
          match = recs.find((r) => r.str('number').toUpperCase() === s(a, 'number').toUpperCase());
        else if (s(a, 'reference')) {
          const ref = s(a, 'reference');
          // "my latest ticket" names no subject: take the most recent; "my VPN ticket" is matched by text.
          const subject = analyze(ref).filter((t) => !REFERENCE_WORDS.has(t));
          if (!subject.length) match = recs[0];
          else {
            const best = recs
              .map((r) => ({
                r,
                score: textSimilarity(
                  subject.join(' '),
                  `${r.str('short_description')} ${r.has('description') ? r.str('description') : ''}`,
                ),
              }))
              .sort((x, y) => y.score - x.score)[0];
            match = best && best.score > 0 ? best.r : undefined;
          }
        } else throw new ToolError('VALIDATION', 'number or reference is required');
        if (!match) throw notFound(`Ticket ${s(a, 'number') || s(a, 'reference')}`);
        env.touch(match);
        const isRitm = match.table.ancestors.includes('sc_req_item');
        const record = isRitm
          ? {
              number: match.str('number'),
              type: 'requested_item',
              ...fieldsOf(w, match, ['short_description', 'approval', 'state', 'stage', 'due_date']),
              requested_for_me: match.str('requested_for') === me,
            }
          : {
              number: match.str('number'),
              type: 'incident',
              ...fieldsOf(w, match, [
                'short_description',
                'description',
                'priority',
                'urgency',
                'impact',
                'state',
                'opened_by',
              ]),
              created_on: match.str('opened_at') || match.str('sys_created_on'),
            };
        return {
          record,
          other_open: recs
            .filter((r) => r !== match)
            .slice(0, 5)
            .map((r) => ({ number: r.str('number'), short_description: r.str('short_description') })),
        };
      },
    },
    {
      name: 'request_modify',
      dotted: 'sn_itsm_mcp_server.request.modify',
      title: 'Comment on my request',
      description:
        "Add a customer-visible comment to the signed-in user's own requested item (RITM). Incident numbers and closed or cancelled items are rejected.",
      input: { number: z.string().describe('RITM number'), comment: z.string().min(1) },
      readOnly: false,
      idempotent: false,
      visible: (ctx) => has(ctx.platform, 'sc_req_item') && !!ctx.user.sysId,
      run(env, a) {
        const ctx = env.ctx;
        const number = s(a, 'number');
        if (has(ctx.platform, 'incident') && byNumberOrId(ctx.elevated(), 'incident', number, '')) {
          throw new ToolError(
            'VALIDATION',
            `${number} is an incident; use incident_modify to comment on incidents`,
          );
        }
        const ritm = byNumberOrId(ctx.elevated(), 'sc_req_item', number, '');
        if (!ritm || !owns(ctx, ritm)) throw notFound(`Requested item ${number}`);
        if (ritm.has('active') && !ritm.bool('active'))
          throw new ToolError('INVALID_STATE', 'Closed or cancelled requested items cannot be commented on');
        env.touch(ritm);
        ctx.elevated().update(ritm, { comments: s(a, 'comment') });
        return { status: 'commented', number: ritm.str('number') };
      },
    },
    {
      name: 'problem_get_details',
      dotted: 'resolvr.problem.get_details',
      title: 'Get problem details',
      description:
        'Return one problem by number or sys_id with its cause, workaround and fix notes, and the incidents linked to it.',
      input: { number: z.string().optional(), sys_id: z.string().optional() },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'problem') && isFulfiller(ctx),
      run(env, a) {
        const { number, sysId } = requireKey(a);
        const rec = byNumberOrId(env.ctx, 'problem', number, sysId);
        if (!rec) throw notFound(`Problem ${number || sysId}`);
        env.touch(rec);
        const incidents =
          has(env.platform, 'incident') && env.platform.registry.table('incident').columns.has('problem_id')
            ? env.ctx
                .query('incident', { query: `problem_id=${rec.sysId}`, limit: 50 })
                .map((r) => summary(env.ctx, r))
            : [];
        return {
          sys_id: rec.sysId,
          number: rec.str('number'),
          ...fieldsOf(env.ctx, rec, [
            'short_description',
            'description',
            'state',
            'priority',
            'category',
            'cmdb_ci',
            'assignment_group',
            'assigned_to',
            'known_error',
            'cause_notes',
            'workaround',
            'fix_notes',
            'rfc',
          ]),
          linked_incidents: incidents,
          link: linkFor(env, rec),
        };
      },
    },
    {
      name: 'problem_search',
      dotted: 'resolvr.problem.search',
      title: 'Search problems',
      description: 'Search problems with an encoded query and/or keywords.',
      input: {
        query: z.string().optional(),
        text: z.string().optional(),
        active: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'problem') && isFulfiller(ctx),
      run(env, a) {
        const qb = new QueryBuilder('problem');
        if (s(a, 'query')) qb.addEncodedQuery(s(a, 'query'));
        if (s(a, 'text')) qb.addQuery('123TEXTQUERY321', s(a, 'text'));
        if (typeof a.active === 'boolean') qb.addQuery('active', a.active);
        if (!qb.orderBy.length) qb.orderByDesc('sys_updated_on');
        qb.limit = n(a, 'limit', 20, 1, 100);
        const recs = env.ctx.query('problem', qb);
        return { count: recs.length, results: recs.map((r) => summary(env.ctx, r)) };
      },
    },
    {
      name: 'change_query',
      dotted: 'sn_itsm_mcp_server.change.query',
      title: 'Query change requests',
      description:
        'Change queries. operation=read (number or numbers), search (encoded query and/or text, paged), get_state_info (current state and the states of the model), similar_change_and_issues (similar changes and the incidents they caused).',
      input: {
        operation: z.enum([
          'read',
          'search',
          'similar_change_and_issues',
          'aggregate_by',
          'get_state_info',
          'check_schedules_and_conflicts',
          'data_quality',
        ]),
        numbers: z.array(z.string()).optional(),
        number: z.string().optional(),
        query: z.string().optional(),
        text: z.string().optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'change_request') && isChangeReader(ctx),
      run(env, a) {
        const ctx = env.ctx;
        const op = s(a, 'operation');
        const fields = list(a, 'fields').length
          ? list(a, 'fields')
          : [
              'short_description',
              'description',
              'type',
              'state',
              'risk',
              'impact',
              'priority',
              'start_date',
              'end_date',
              'assignment_group',
              'assigned_to',
              'cmdb_ci',
              'justification',
              'implementation_plan',
              'backout_plan',
              'test_plan',
            ];
        if (op === 'read') {
          const numbers = [...list(a, 'numbers'), ...(s(a, 'number') ? [s(a, 'number')] : [])];
          if (!numbers.length) throw new ToolError('VALIDATION', 'number or numbers is required');
          const out = numbers.map((num) => {
            const rec = byNumberOrId(ctx, 'change_request', num, '');
            if (!rec) return { number: num, error: 'NOT_FOUND' };
            env.touch(rec);
            return {
              sys_id: rec.sysId,
              number: rec.str('number'),
              ...fieldsOf(ctx, rec, fields),
              link: linkFor(env, rec),
            };
          });
          return { results: out };
        }
        if (op === 'search') {
          const qb = new QueryBuilder('change_request');
          if (s(a, 'query')) qb.addEncodedQuery(s(a, 'query'));
          if (s(a, 'text')) qb.addQuery('123TEXTQUERY321', s(a, 'text'));
          if (!qb.orderBy.length) qb.orderByDesc('sys_updated_on');
          const total = ctx.count('change_request', qb);
          qb.limit = n(a, 'limit', 20, 1, 100);
          qb.offset = n(a, 'offset', 0, 0, 1_000_000);
          const recs = ctx.query('change_request', qb);
          return {
            total,
            count: recs.length,
            results: recs.map((r) => ({
              ...summary(ctx, r),
              ...fieldsOf(ctx, r, ['type', 'risk', 'start_date', 'end_date']),
            })),
          };
        }
        if (op === 'get_state_info') {
          const rec = byNumberOrId(ctx, 'change_request', s(a, 'number'), '');
          if (!rec) throw notFound(`Change ${s(a, 'number')}`);
          env.touch(rec);
          return {
            number: rec.str('number'),
            state: rec.str('state'),
            state_label: rec.display('state'),
            states: ctx.platform.choices
              .list(rec.className, 'state')
              .map((c) => ({ value: c.value, label: c.label })),
          };
        }
        if (op === 'similar_change_and_issues') {
          if (!env.engine) throw new ToolError('INVALID_STATE', 'Similarity search is not available');
          let text = s(a, 'text');
          const exclude: string[] = [];
          if (s(a, 'number')) {
            const rec = byNumberOrId(ctx, 'change_request', s(a, 'number'), '');
            if (!rec) throw notFound(`Change ${s(a, 'number')}`);
            env.touch(rec);
            text = env.engine.similarity.textOf(rec);
            exclude.push(rec.sysId);
          }
          if (!text) throw new ToolError('VALIDATION', 'number or text is required');
          const causedBy =
            has(ctx.platform, 'incident') && ctx.platform.registry.table('incident').columns.has('caused_by');
          const hits = env.engine.similarity.similarToText(ctx, text, 'change_request', {
            limit: n(a, 'limit', 5, 1, 20),
            minScore: 10,
            exclude,
          });
          return {
            results: hits.map((h) => ({
              number: h.number,
              short_description: h.title,
              state: h.state ?? '',
              score: h.score,
              incidents_caused: causedBy
                ? ctx
                    .query('incident', { query: `caused_by=${h.sys_id}`, limit: 10 })
                    .map((r) => r.str('number'))
                : [],
            })),
          };
        }
        throw new ToolError('VALIDATION', `Operation ${op} is not available in this version`);
      },
    },
    {
      name: 'change_lifecycle',
      dotted: 'sn_itsm_mcp_server.change.lifecycle',
      title: 'Create or update a change request',
      description:
        'Change request lifecycle. operation=create (type normal, standard or emergency, plus fields) or update (number with fields, work_notes, comments, or a state transition that needs a confirmation_token from a first call).',
      input: {
        operation: z.enum(['create', 'update', 'calculate_risk', 'upsert_task', 'planned_outage']),
        number: z.string().optional(),
        type: z.enum(['normal', 'standard', 'emergency']).optional(),
        fields: z.record(z.string(), z.string()).optional(),
        state: z.string().optional().describe('Target state value or label'),
        work_notes: z.string().optional(),
        comments: z.string().optional(),
        confirmation_token: z.string().optional(),
      },
      readOnly: false,
      idempotent: false,
      visible: (ctx) => has(ctx.platform, 'change_request') && isChangeWriter(ctx),
      run(env, a) {
        const ctx = env.ctx;
        const op = s(a, 'operation');
        const fields = obj(a, 'fields');
        const meta = ctx.platform.registry.table('change_request');
        for (const k of Object.keys(fields)) {
          if (!meta.columns.has(k) || k.startsWith('sys_') || k === 'number')
            throw new ToolError('VALIDATION', `Unknown or read-only field ${k}`);
        }
        if (op === 'create') {
          const values: Record<string, unknown> = { ...fields };
          if (s(a, 'type') && meta.columns.has('type')) values.type = s(a, 'type');
          if (!values.short_description)
            throw new ToolError('VALIDATION', 'fields.short_description is required');
          if (s(a, 'work_notes')) values.work_notes = s(a, 'work_notes');
          const rec = ctx.insert('change_request', values);
          env.touch(rec);
          return { status: 'created', ...summary(ctx, rec), link: linkFor(env, rec) };
        }
        if (op === 'update') {
          const rec = byNumberOrId(ctx, 'change_request', s(a, 'number'), '');
          if (!rec) throw notFound(`Change ${s(a, 'number')}`);
          env.touch(rec);
          const values: Record<string, unknown> = { ...fields };
          if (s(a, 'work_notes')) values.work_notes = s(a, 'work_notes');
          if (s(a, 'comments')) values.comments = s(a, 'comments');
          if (s(a, 'state')) {
            const target = ctx.platform.choices.resolve(rec.className, 'state', s(a, 'state'));
            if (target === undefined) throw new ToolError('VALIDATION', `Unknown state ${s(a, 'state')}`);
            env.confirm(
              'change_lifecycle',
              { sys_id: rec.sysId, state: target },
              {
                number: rec.str('number'),
                from: rec.display('state'),
                to: ctx.platform.choices.label(rec.className, 'state', target) ?? target,
              },
            );
            values.state = target;
          }
          if (!Object.keys(values).length) throw new ToolError('VALIDATION', 'Nothing to update');
          ctx.update(rec, values);
          return { status: 'updated', ...summary(ctx, rec), updated_fields: Object.keys(values) };
        }
        throw new ToolError('VALIDATION', `Operation ${op} is not available in this version`);
      },
    },
    {
      name: 'cmdb_ci_lookup',
      dotted: 'resolvr.cmdb.ci_lookup',
      title: 'Look up configuration items',
      description:
        'Find configuration items by name, class, IP address, serial number or encoded query. Returns class, status, location and support group.',
      input: {
        name: z.string().optional(),
        class: z.string().optional().describe('CMDB class table, for example cmdb_ci_server'),
        ip_address: z.string().optional(),
        serial_number: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => has(ctx.platform, 'cmdb_ci') && isFulfiller(ctx),
      run(env, a) {
        const ctx = env.ctx;
        const cls = s(a, 'class');
        const table =
          cls && ctx.platform.registry.tryTable(cls)?.ancestors.includes('cmdb_ci') ? cls : 'cmdb_ci';
        const meta = ctx.platform.registry.table(table);
        const qb = new QueryBuilder(table);
        if (s(a, 'name')) qb.addQuery('name', 'LIKE', s(a, 'name'));
        if (s(a, 'ip_address') && meta.columns.has('ip_address'))
          qb.addQuery('ip_address', s(a, 'ip_address'));
        if (s(a, 'serial_number') && meta.columns.has('serial_number'))
          qb.addQuery('serial_number', s(a, 'serial_number'));
        if (s(a, 'query')) qb.addEncodedQuery(s(a, 'query'));
        qb.orderByAsc('name');
        qb.limit = n(a, 'limit', 20, 1, 100);
        const recs = ctx.query(table, qb);
        return {
          count: recs.length,
          results: recs.map((r) => ({
            sys_id: r.sysId,
            name: r.str('name'),
            class: r.table.label,
            ...fieldsOf(ctx, r, [
              'operational_status',
              'install_status',
              'ip_address',
              'serial_number',
              'location',
              'assigned_to',
              'support_group',
              'managed_by',
              'short_description',
            ]),
          })),
        };
      },
    },
    {
      name: 'lookup_users',
      dotted: 'sn_itsm_mcp_server.lookup_users',
      title: 'Look up users',
      description: 'Find active users by name (or user name or email), by role, or by group membership.',
      input: {
        name: z.string().optional(),
        role: z.string().optional(),
        group: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => isFulfiller(ctx),
      run(env, a) {
        const ctx = env.ctx;
        if (!s(a, 'name') && !s(a, 'role') && !s(a, 'group'))
          throw new ToolError('VALIDATION', 'name, role or group is required');
        const qb = new QueryBuilder('sys_user').addQuery('active', true);
        if (s(a, 'name')) {
          const v = s(a, 'name').replace(/\^/g, '');
          qb.addEncodedQuery(`nameLIKE${v}^ORuser_nameLIKE${v}^ORemailLIKE${v}`);
        }
        const w = ctx.elevated();
        if (s(a, 'role')) {
          const role = w.first('sys_user_role', `name=${s(a, 'role').replace(/\^/g, '')}`);
          if (!role) return { count: 0, results: [] };
          const ids = w
            .query('sys_user_has_role', { query: `role=${role.sysId}`, limit: 2000 })
            .map((r) => r.str('user'));
          qb.addEncodedQuery(`sys_idIN${ids.join(',') || 'none'}`);
        }
        if (s(a, 'group')) {
          const gid = resolveRef(ctx, 'sys_user_group', s(a, 'group'), 'Group');
          const ids = w
            .query('sys_user_grmember', { query: `group=${gid}`, limit: 2000 })
            .map((r) => r.str('user'));
          qb.addEncodedQuery(`sys_idIN${ids.join(',') || 'none'}`);
        }
        qb.orderByAsc('name');
        qb.limit = n(a, 'limit', 20, 1, 100);
        const recs = ctx.query('sys_user', qb);
        return {
          count: recs.length,
          results: recs.map((r) => ({
            sys_id: r.sysId,
            user_name: r.str('user_name'),
            ...fieldsOf(ctx, r, ['name', 'email', 'title', 'department', 'location']),
          })),
        };
      },
    },
    {
      name: 'lookup_assignment_groups',
      dotted: 'sn_itsm_mcp_server.lookup_assignment_groups',
      title: 'Look up assignment groups',
      description: 'Find active assignment groups by name or keyword, optionally with their members.',
      input: {
        query: z.string().optional(),
        include_members: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      readOnly: true,
      idempotent: true,
      visible: (ctx) => isFulfiller(ctx),
      run(env, a) {
        const ctx = env.ctx;
        const qb = new QueryBuilder('sys_user_group').addQuery('active', true);
        if (s(a, 'query')) {
          const v = s(a, 'query').replace(/\^/g, '');
          qb.addEncodedQuery(`nameLIKE${v}^ORdescriptionLIKE${v}`);
        }
        qb.orderByAsc('name');
        qb.limit = n(a, 'limit', 20, 1, 100);
        const recs = ctx.query('sys_user_group', qb);
        return {
          count: recs.length,
          results: recs.map((g) => {
            const out: Record<string, unknown> = {
              sys_id: g.sysId,
              ...fieldsOf(ctx, g, ['name', 'description', 'manager', 'email']),
            };
            if (b(a, 'include_members')) {
              out.members = ctx
                .elevated()
                .query('sys_user_grmember', { query: `group=${g.sysId}`, limit: 200 })
                .map((m) => ({ sys_id: m.str('user'), name: m.display('user') }));
            }
            return out;
          }),
        };
      },
    },
    {
      name: 'get_session_timezone',
      dotted: 'sn_itsm_mcp_server.get_session_timezone',
      title: 'Session time zone',
      description:
        "Return the caller's time zone and the current date-time (UTC and local). Call it before interpreting dates or relative phrases such as 'yesterday'.",
      input: {},
      readOnly: true,
      idempotent: true,
      visible: () => true,
      run(env) {
        const tz = env.ctx.user.timeZone || env.platform.properties.get('glide.sys.default.tz') || 'UTC';
        const now = nowGlide();
        return { time_zone: tz, now_utc: now, now_local: formatDateTimeInZone(now, tz) };
      },
    },
    {
      name: 'task_approval_decision',
      dotted: 'sn_itsm_mcp_server.task_approval_decision',
      title: 'Approve or reject',
      description:
        'Record an approve or reject decision on the oldest approval waiting for the signed-in user on a change request or requested item. The first call returns a confirmation_token; call again with it to record the decision.',
      input: {
        number: z.string().describe('CHG or RITM number'),
        decision: z.enum(['approve', 'reject']),
        comments: z.string().optional(),
        confirmation_token: z.string().optional(),
      },
      readOnly: false,
      idempotent: false,
      visible: (ctx) => has(ctx.platform, 'sysapproval_approver') && !!ctx.user.sysId,
      run(env, a) {
        const ctx = env.ctx;
        const w = ctx.elevated();
        const target = byNumberOrId(w, 'task', s(a, 'number'), '');
        if (!target) throw notFound(`Record ${s(a, 'number')}`);
        const meta = ctx.platform.registry.table('sysapproval_approver');
        const link = meta.columns.has('sysapproval') ? 'sysapproval' : 'document_id';
        const approval = w.first(
          'sysapproval_approver',
          `${link}=${target.sysId}^approver=${ctx.user.sysId}^state=requested`,
          [{ field: 'sys_created_on', desc: false }],
        );
        if (!approval) throw notFound(`An approval waiting for you on ${s(a, 'number')}`);
        env.touch(target);
        const decision = s(a, 'decision') === 'approve' ? 'approved' : 'rejected';
        env.confirm(
          'task_approval_decision',
          { approval: approval.sysId, decision },
          { number: target.str('number'), decision },
        );
        const svc = optionalService<ApprovalService>(ctx.platform, SERVICES.approvals);
        if (svc) svc.decide(ctx, approval, decision, s(a, 'comments') || undefined);
        else
          w.update(approval, {
            state: decision,
            ...(s(a, 'comments') ? { comments: s(a, 'comments') } : {}),
          });
        return { status: decision, number: target.str('number'), approval: approval.sysId };
      },
    },
  ];
  return tools;
}
