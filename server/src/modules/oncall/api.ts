import type { FastifyInstance } from 'fastify';
import { type ApiDeps, ctxOf, HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { clock, isSysId, parseGlideDateTime, toGlideDateTime } from '../../engine/util.js';
import { DAY } from '../schedules/time.js';
import type { EscalationEngine, Response } from './escalation.js';
import {
  ONCALL_PROPS,
  type OnCallService,
  type OnCallSnapshot,
  type PlanLevel,
  type RotaInfo,
} from './service.js';

const MAX_WINDOW = 92 * DAY;
const glide = (t: number) => toGlideDateTime(new Date(t));

function userRef(s: OnCallSnapshot, id: string | null) {
  const u = s.user(id);
  return u ? { sys_id: u.id, name: u.name, user_name: u.userName } : null;
}

function escalationType(rota: RotaInfo): string {
  if (rota.rec.bool('use_custom_escalation')) return 'custom';
  return rota.rosters.length > 1 ? 'rotate_through_rosters' : 'rotate_through_members';
}

function planJson(s: OnCallSnapshot, levels: PlanLevel[]) {
  return levels.map((l) => ({
    level: l.level,
    users: l.users.map((u) => userRef(s, u)).filter(Boolean),
    catch_all: l.catchAll,
    attempts: l.attempts,
    time_between_reminders_ms: l.timeBetween,
    wait_ms: l.wait,
  }));
}

function instant(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const t = parseGlideDateTime(String(v))?.getTime();
  if (t === undefined || !Number.isFinite(t)) throw new HttpError(400, `Invalid date-time '${String(v)}'`);
  return t;
}

function canRead(deps: ApiDeps, ctx: Context): boolean {
  const roles = (
    deps.platform.properties.get(ONCALL_PROPS.readRoles) ?? 'itil,rota_manager,rota_admin,oc_read'
  )
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return ctx.hasAnyRole([...roles, 'admin']);
}

/** Who is on call for a group at an instant, per shift, with each shift's escalation chain. */
export function whoIsOnCall(service: OnCallService, ctx: Context, group: Rec, at: number) {
  const s = service.snapshot(ctx);
  const rotas = s.rotasOf(group.sysId);
  const escalating = new Set(service.rotasForEscalation(s, group.sysId, at).map((r) => r.id));
  const out = rotas.map((rota) => {
    const active = service.rotaActiveAt(s, rota, at);
    const window = active
      ? service.activeIntervals(s, rota, at - 8 * DAY, at + 8 * DAY).find(([a, b]) => a <= at && at < b)
      : undefined;
    return {
      rota: rota.id,
      name: rota.name,
      time_zone: rota.zone,
      escalation_type: escalationType(rota),
      active,
      escalates: escalating.has(rota.id),
      active_from: window ? glide(window[0]) : null,
      active_to: window ? glide(window[1]) : null,
      rosters: rota.rosters.map((r) => {
        const entry = active ? service.onCall(s, rota, r, at) : { user: null, source: null, gap: null };
        return {
          roster: r.id,
          name: r.name,
          order: r.order,
          user: userRef(s, entry.user),
          source: entry.source,
          gap: entry.gap,
        };
      }),
      plan: planJson(s, service.plan(s, rota, at)),
    };
  });
  const primary = out.find((r) => r.escalates && r.plan.length)?.plan[0]?.users[0] ?? null;
  return {
    group: { sys_id: group.sysId, name: group.str('name') },
    at: glide(at),
    on_call: primary,
    rotas: out,
  };
}

/** On-call calendar of a group: who is on call per roster across a window. */
export function scheduleOf(service: OnCallService, ctx: Context, group: Rec, from: number, to: number) {
  const s = service.snapshot(ctx);
  return {
    group: { sys_id: group.sysId, name: group.str('name') },
    from: glide(from),
    to: glide(to),
    rotas: s.rotasOf(group.sysId).map((rota) => ({
      rota: rota.id,
      name: rota.name,
      time_zone: rota.zone,
      active: service
        .activeIntervals(s, rota, from, to)
        .map(([a, b]) => ({ start: glide(a), end: glide(b) })),
      rosters: rota.rosters.map((r) => ({
        roster: r.id,
        name: r.name,
        order: r.order,
        segments: service.segments(s, rota, r, from, to).map((seg) => ({
          start: glide(seg.start),
          end: glide(seg.end),
          user: userRef(s, seg.entry.user),
          source: seg.entry.source,
          gap: seg.entry.gap,
        })),
      })),
    })),
  };
}

function escalationJson(ctx: Context, e: Rec) {
  const levels = ctx.elevated().query('on_call_escalation_level', {
    query: `escalation=${e.sysId}`,
    orderBy: [{ field: 'level', desc: false }],
  });
  return {
    sys_id: e.sysId,
    task: { table: e.str('table'), sys_id: e.str('source'), display_value: e.display('source') },
    group: e.display('group'),
    active: e.bool('active'),
    acknowledged: e.bool('acknowledged'),
    acknowledged_by: e.display('acknowledged_by'),
    end_reason: e.str('end_reason'),
    levels: levels.map((l) => ({
      level: l.num('level'),
      rota: l.display('rota'),
      users: l.display('escalatees'),
      catch_all: l.bool('catch_all'),
      active: l.bool('active'),
      outcome: l.str('outcome'),
    })),
  };
}

export function registerOncallApi(
  app: FastifyInstance,
  deps: ApiDeps,
  service: OnCallService,
  engine: EscalationEngine,
): void {
  const groupFor = (ctx: Context, idOrName: string) => {
    if (!canRead(deps, ctx)) throw new HttpError(403, 'Insufficient rights to read on-call calendars');
    const group = service.resolveGroup(ctx, decodeURIComponent(idOrName));
    if (!group) throw new NotFoundError('No Record found', `Unknown group '${idOrName}'`);
    return group;
  };

  app.get('/api/app/oncall/:groupId/current', async (req) => {
    const ctx = ctxOf(req, deps);
    const group = groupFor(ctx, (req.params as { groupId: string }).groupId);
    return {
      result: whoIsOnCall(
        service,
        ctx,
        group,
        instant((req.query as Record<string, string>).at, clock.now().getTime()),
      ),
    };
  });

  app.get('/api/app/oncall/who_is_on_call', async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Record<string, string>;
    if (!q.group) throw new HttpError(400, 'group is required');
    const result = whoIsOnCall(service, ctx, groupFor(ctx, q.group), instant(q.at, clock.now().getTime()));
    return {
      result: q.rota
        ? { ...result, rotas: result.rotas.filter((r) => r.rota === q.rota || r.name === q.rota) }
        : result,
    };
  });

  app.get('/api/app/oncall/:groupId/schedule', async (req) => {
    const ctx = ctxOf(req, deps);
    const group = groupFor(ctx, (req.params as { groupId: string }).groupId);
    const q = req.query as Record<string, string>;
    const from = instant(q.from, clock.now().getTime());
    const to = instant(q.to, from + 7 * DAY);
    if (to <= from) throw new HttpError(400, '"to" must be after "from"');
    if (to - from > MAX_WINDOW) throw new HttpError(400, 'Window too large (maximum 92 days)');
    return { result: scheduleOf(service, ctx, group, from, to) };
  });

  /** Acknowledge (or decline) a page: body { escalation | task, response?: accept | reject, user? }. */
  const respond = (ctx: Context, escalation: Rec, body: Record<string, unknown>) => {
    const raw = String(body.response ?? 'accept').toLowerCase();
    const response: Response = raw.startsWith('rej') || raw === 'decline' ? 'rejected' : 'accepted';
    let userId = ctx.user.sysId ?? '';
    if (body.user && ctx.hasAnyRole(['rota_admin', 'admin'])) {
      const u = ctx
        .elevated()
        .getBy('sys_user', isSysId(body.user) ? 'sys_id' : 'user_name', String(body.user));
      if (!u) throw new HttpError(400, `Unknown user '${String(body.user)}'`);
      userId = u.sysId;
    }
    const levels = ctx
      .elevated()
      .query('on_call_escalation_level', { query: `escalation=${escalation.sysId}^started_atISNOTEMPTY` });
    const isEscalatee = levels.some((l) => l.str('escalatees').split(',').includes(userId));
    if (!isEscalatee && !ctx.hasAnyRole(['rota_admin', 'rota_manager', 'admin']))
      throw new HttpError(403, 'You were not paged for this escalation');
    const outcome = engine.respond(ctx, escalation, userId, response);
    deps.platform.scheduleWork();
    const fresh = ctx.elevated().get('on_call_escalation', escalation.sysId)!;
    if (!outcome.ok) throw new HttpError(409, outcome.message);
    return { result: { message: outcome.message, escalation: escalationJson(ctx, fresh) } };
  };

  app.post('/api/app/oncall/ack', async (req) => {
    const ctx = ctxOf(req, deps);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sys = ctx.elevated();
    let escalation: Rec | null = null;
    if (isSysId(body.escalation)) escalation = sys.get('on_call_escalation', body.escalation);
    else if (isSysId(body.task)) {
      escalation =
        sys.first('on_call_escalation', `source=${body.task}^active=true`) ??
        sys.first('on_call_escalation', `source=${body.task}^ORDERBYDESCsys_created_on`);
    } else throw new HttpError(400, 'Provide "escalation" or "task"');
    if (!escalation) throw new NotFoundError('No Record found', 'No on-call escalation found');
    return respond(ctx, escalation, body);
  });

  app.post('/api/app/oncall/escalations/:sysId/respond', async (req) => {
    const ctx = ctxOf(req, deps);
    const escalation = ctx.elevated().get('on_call_escalation', (req.params as { sysId: string }).sysId);
    if (!escalation) throw new NotFoundError();
    return respond(ctx, escalation, (req.body ?? {}) as Record<string, unknown>);
  });

  /** Delivery status callback from a messaging provider. */
  app.post('/api/app/oncall/comm/:sysId/status', async (req) => {
    const ctx = ctxOf(req, deps);
    if (!ctx.hasAnyRole(['rota_admin', 'admin', 'rest_service']))
      throw new HttpError(403, 'Insufficient rights');
    const comm = ctx.elevated().get('on_call_escalation_comm', (req.params as { sysId: string }).sysId);
    if (!comm) throw new NotFoundError();
    const body = (req.body ?? {}) as { status?: string; reason?: string };
    const updated = engine.deliveryStatus(
      ctx,
      comm,
      String(body.status ?? 'sent'),
      String(body.reason ?? ''),
    );
    return {
      result: {
        sys_id: updated.sysId,
        status: ctx.elevated().get('on_call_escalation_comm', updated.sysId)?.str('status'),
      },
    };
  });
}
