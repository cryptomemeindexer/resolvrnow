import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ApiDeps, baseUrl, ctxOf, HttpError } from '../../api/http.js';
import { serializeRecord } from '../../api/serialize.js';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import { slaEngine } from './engine.js';

const FIELDS = [
  'sla',
  'stage',
  'active',
  'has_breached',
  'start_time',
  'end_time',
  'pause_time',
  'planned_end_time',
  'original_breach_time',
  'duration',
  'business_duration',
  'pause_duration',
  'business_pause_duration',
  'percentage',
  'business_percentage',
  'time_left',
  'business_time_left',
  'schedule',
  'timezone',
];

function serialize(ctx: Context, req: FastifyRequest, deps: ApiDeps, rec: Rec) {
  return {
    sys_id: rec.sysId,
    target: rec.str('sla.target'),
    ...serializeRecord(ctx, rec, {
      displayValue: 'all',
      excludeReferenceLink: true,
      fields: FIELDS,
      baseUrl: baseUrl(req, deps),
    }),
  };
}

/** "First to breach": the running SLA that breaches next, else the first breached one, else the latest finished. */
export function preferredSla(rows: Rec[]): Rec | null {
  const running = rows.filter((r) => r.bool('active') && r.str('stage') !== 'paused');
  const byBreach = (a: Rec, b: Rec) =>
    (a.str('planned_end_time') || '9999').localeCompare(b.str('planned_end_time') || '9999');
  const notBreached = running.filter((r) => !r.bool('has_breached')).sort(byBreach);
  if (notBreached.length) return notBreached[0];
  if (running.length) return running.sort(byBreach)[0];
  const paused = rows.filter((r) => r.bool('active')).sort(byBreach);
  if (paused.length) return paused[0];
  return rows.slice().sort((a, b) => b.str('end_time').localeCompare(a.str('end_time')))[0] ?? null;
}

function requireRepair(deps: ApiDeps, ctx: Context, roles: string[]) {
  const engine = slaEngine(deps.platform);
  if (!engine) throw new HttpError(503, 'SLA engine not available');
  if (!ctx.hasAnyRole(roles)) throw new HttpError(403, 'Insufficient rights to repair SLAs');
  if (!engine.repairEnabled())
    throw new HttpError(403, 'SLA repair is disabled', 'Set com.snc.sla.repair.enabled to true');
  return engine;
}

function taskOf(ctx: Context, table: string, sysId: string): Rec {
  const meta = ctx.registry.tryTable(table);
  if (!meta) throw new HttpError(400, `Invalid table ${table}`);
  if (!meta.ancestors.includes('task')) throw new HttpError(400, `${table} is not a task table`);
  const rec = ctx.get(table, sysId);
  if (!rec) throw new NotFoundError();
  return rec;
}

/** ResolvrNow SLA endpoints. */
export function registerSlaApi(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/api/app/sla/repair/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const engine = requireRepair(deps, ctx, ['admin', 'itil', 'sla_admin']);
    const { table, sysId } = req.params as { table: string; sysId: string };
    const task = taskOf(ctx, table, sysId);
    const log = engine.repair(ctx, [task.sysId]);
    deps.platform.scheduleWork();
    const rows = ctx.elevated().query('task_sla', { query: `task=${task.sysId}` });
    return {
      result: {
        repair_log: log.sysId,
        state: log.str('state'),
        task_slas: rows.map((r) => serialize(ctx, req, deps, r)),
      },
    };
  });

  app.post('/api/app/sla/repair', async (req) => {
    const ctx = ctxOf(req, deps);
    const engine = requireRepair(deps, ctx, ['admin', 'sla_admin']);
    const body = (req.body ?? {}) as { task?: unknown; task_sla?: unknown };
    const list = (v: unknown) =>
      (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
        .map((x) => String(x).trim())
        .filter(isSysId);
    const tasks = new Set(list(body.task));
    for (const id of list(body.task_sla)) {
      const ts = ctx.elevated().get('task_sla', id);
      if (ts) tasks.add(ts.str('task'));
    }
    if (!tasks.size) throw new HttpError(400, 'Provide "task" or "task_sla" sys_ids');
    const log = engine.repair(ctx, [...tasks]);
    deps.platform.scheduleWork();
    return { result: { repair_log: log.sysId, state: log.str('state'), tasks: [...tasks] } };
  });

  app.get('/api/app/sla/task/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    const task = taskOf(ctx, table, sysId);
    if (!deps.platform.acl.canTable(ctx, 'task_sla', 'read').allowed)
      throw new HttpError(403, 'Insufficient rights to read task SLAs');
    slaEngine(deps.platform)?.refreshTask(ctx, task.sysId);
    const target = String((req.query as Record<string, string>).target ?? '');
    const rows = ctx
      .elevated()
      .query('task_sla', { query: `task=${task.sysId}`, orderBy: [{ field: 'sys_created_on', desc: false }] })
      .filter((r) => !target || r.str('sla.target') === target);
    const preferred = preferredSla(rows);
    return {
      result: {
        task: task.sysId,
        preferred: preferred?.sysId ?? null,
        task_slas: rows.map((r) => serialize(ctx, req, deps, r)),
      },
    };
  });
}
