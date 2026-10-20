import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { flowEngine } from './engine.js';
import { parseJson } from './runtime.js';
import { CONTEXT_TABLE, FLOW_TABLE, LOG_TABLE } from './tables.js';
import type { FlowDefinition, Plan, RunState } from './types.js';

const pair = (rec: Rec, field: string) => ({ value: rec.str(field), display_value: rec.display(field) });

function requireRole(ctx: Context, roles: string[]): void {
  if (!ctx.hasAnyRole(roles))
    throw new HttpError(403, 'Insufficient rights', `Requires one of the roles: ${roles.join(', ')}`);
}

const VIEW_ROLES = ['flow_designer', 'flow_operator'];

function flowSummary(ctx: Context, f: Rec): Record<string, unknown> {
  const def = parseJson<FlowDefinition | null>(f.str('resolvr_definition'), null);
  const counts = ctx.platform.db.all<{ state: string; n: number }>(
    `SELECT "state", COUNT(*) AS "n" FROM "sys_flow_context" WHERE "flow" = ? GROUP BY "state"`,
    [f.sysId],
  );
  const last = ctx.platform.db.get<{ sys_id: string; state: string; sys_created_on: string }>(
    `SELECT "sys_id","state","sys_created_on" FROM "sys_flow_context" WHERE "flow" = ? ORDER BY "sys_created_on" DESC, rowid DESC LIMIT 1`,
    [f.sysId],
  );
  return {
    sys_id: f.sysId,
    name: f.str('name'),
    internal_name: f.str('internal_name'),
    description: f.str('description'),
    type: f.str('type'),
    status: f.str('status'),
    active: f.bool('active'),
    run_as: f.str('run_as'),
    trigger: def?.trigger ?? null,
    next_run: f.str('resolvr_next_run'),
    updated_on: f.str('sys_updated_on'),
    executions: Object.fromEntries(counts.map((c) => [c.state, c.n])),
    last_execution: last ? { sys_id: last.sys_id, state: last.state, started: last.sys_created_on } : null,
  };
}

export function contextSummary(c: Rec): Record<string, unknown> {
  return {
    sys_id: c.sysId,
    name: c.str('name'),
    flow: pair(c, 'flow'),
    state: c.str('state'),
    source_table: c.str('source_table'),
    source_record: { value: c.str('source_record'), display_value: c.display('source_record') },
    calling_source: c.str('calling_source'),
    is_test_run: c.bool('is_test_run'),
    created_on: c.str('sys_created_on'),
    started: c.str('resolvr_started'),
    ended: c.str('resolvr_ended'),
    run_time: c.num('run_time') ?? 0,
    error_message: c.str('error_message'),
  };
}

/** Execution details for the UI: summary, runtime state and the per-step log. */
export function contextDetail(ctx: Context, c: Rec): Record<string, unknown> {
  const run = parseJson<RunState | null>(c.str('attributes'), null);
  const plan = parseJson<Plan | null>(c.str('plan'), null);
  const logs = ctx.query(LOG_TABLE, {
    query: `context=${c.sysId}`,
    orderBy: [{ field: 'sequence', desc: false }],
    limit: 2000,
  });
  return {
    ...contextSummary(c),
    trigger: plan
      ? {
          table: plan.trigger.table,
          sys_id: plan.trigger.sys_id,
          operation: plan.trigger.operation,
          user: plan.trigger.user,
        }
      : null,
    inputs: plan?.inputs ?? {},
    variables: run?.vars ?? {},
    steps: run?.steps ?? {},
    outputs: run?.outputs ?? {},
    waiting_for: run?.wait ?? null,
    error: run?.error ?? null,
    logs: logs.map((l) => ({
      sequence: l.num('sequence'),
      step_id: l.str('step_id'),
      step_type: l.str('step_type'),
      action: l.str('action'),
      label: l.str('label'),
      state: l.str('state'),
      level: l.str('level'),
      message: l.str('message'),
      inputs: parseJson<unknown>(l.str('inputs'), null),
      outputs: parseJson<unknown>(l.str('outputs'), null),
      started: l.str('started'),
      ended: l.str('ended'),
      duration_ms: l.num('duration_ms') ?? 0,
      iteration: l.num('iteration'),
    })),
  };
}

export function registerFlowApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const findFlow = (ctx: Context, id: string): Rec => {
    const f = flowEngine(platform).findFlow(ctx.elevated(), id);
    if (!f) throw new NotFoundError();
    return f;
  };

  app.get('/api/app/flows', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRole(ctx, VIEW_ROLES);
    const q = req.query as Record<string, string | undefined>;
    const query = [q.type ? `type=${q.type}` : '', q.active ? `active=${q.active}` : '', 'ORDERBYname']
      .filter(Boolean)
      .join('^');
    const flows = ctx.elevated().query(FLOW_TABLE, { query, limit: 1000 });
    return { result: flows.map((f) => flowSummary(ctx, f)) };
  });

  app.get('/api/app/flows/contexts/:id', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRole(ctx, VIEW_ROLES);
    const { id } = req.params as { id: string };
    const c = ctx.elevated().get(CONTEXT_TABLE, id);
    if (!c) throw new NotFoundError();
    return { result: contextDetail(ctx.elevated(), c) };
  });

  const cancel = async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    requireRole(ctx, VIEW_ROLES);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: unknown };
    const engine = flowEngine(platform);
    if (!ctx.elevated().get(CONTEXT_TABLE, id)) throw new NotFoundError();
    const done = platform.db.tx(() =>
      engine.cancel(
        ctx,
        id,
        typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Cancelled by user',
      ),
    );
    if (!done) throw new HttpError(409, 'The execution is not running');
    platform.scheduleWork();
    return { result: contextSummary(ctx.elevated().get(CONTEXT_TABLE, id)!) };
  };
  app.post('/api/app/flows/contexts/:id/cancel', cancel);
  /** Path used by the specification. */
  app.post('/api/app/flow/context/:id/cancel', cancel);

  app.get('/api/app/flows/:id', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRole(ctx, VIEW_ROLES);
    const f = findFlow(ctx, (req.params as { id: string }).id);
    return {
      result: { ...flowSummary(ctx, f), definition: parseJson<unknown>(f.str('resolvr_definition'), null) },
    };
  });

  app.get('/api/app/flows/:id/executions', async (req) => {
    const ctx = ctxOf(req, deps);
    requireRole(ctx, VIEW_ROLES);
    const f = findFlow(ctx, (req.params as { id: string }).id);
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '100', 10) || 100, 1), 1000);
    const query = `flow=${f.sysId}${q.state ? `^stateIN${q.state}` : ''}`;
    const rows = ctx.elevated().query(CONTEXT_TABLE, {
      query,
      orderBy: [{ field: 'sys_created_on', desc: true }],
      limit,
    });
    return { result: rows.map(contextSummary) };
  });

  const run = async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    const params = req.params as { id?: string; name?: string };
    const f = findFlow(ctx, params.id ?? params.name ?? '');
    const isDesigner = ctx.hasRole('flow_designer');
    if (
      !isDesigner &&
      !(f.bool('callable_by_client_api') && f.bool('active') && f.str('status') === 'published')
    ) {
      throw new HttpError(403, 'Insufficient rights', 'Requires the flow_designer role');
    }
    const body = (req.body ?? {}) as {
      record?: { table?: string; sys_id?: string };
      table?: string;
      sys_id?: string;
      inputs?: unknown;
    };
    const table = body.record?.table ?? body.table;
    const sysId = body.record?.sys_id ?? body.sys_id;
    let record: Rec | null = null;
    if (table || sysId) {
      if (!table || !sysId || !platform.registry.has(table))
        throw new HttpError(400, 'record needs a valid table and sys_id');
      record = ctx.get(table, sysId);
      if (!record) throw new NotFoundError();
    }
    const inputs =
      body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : {};
    const c = flowEngine(platform).startNow(ctx, f, {
      record,
      inputs,
      source: params.name ? 'api' : 'manual',
      operation: params.name ? 'api' : 'manual',
    });
    platform.scheduleWork();
    return { result: contextDetail(ctx.elevated(), c) };
  };

  app.post('/api/app/flows/:id/run', run);
  /** API trigger (spec): start a flow by internal name. */
  app.post('/api/app/flow/:name/start', run);
}
