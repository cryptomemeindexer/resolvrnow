import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type ApiDeps, ctxOf, HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { SERVICES } from '../contracts.js';
import type { NotificationEngine } from './engine.js';
import type { InboundEmailInput } from './inbound.js';

/** Header carrying the shared secret of the inbound email webhook. */
export const WEBHOOK_SECRET_HEADER = 'x-resolvr-webhook-secret';

function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function requireAdmin(ctx: Context): void {
  if (!ctx.hasRole('notification_admin') && !ctx.hasRole('admin'))
    throw new HttpError(403, 'Insufficient rights', 'Requires the notification_admin role');
}

/** Product routes: inbound email webhook, notification preview, preferences, outbox control. */
export function registerNotificationApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const engine = platform.services.get(SERVICES.notifications) as NotificationEngine | undefined;
  if (!engine) return;
  engine.configureServer({ publicUrl: deps.config.publicUrl, attachmentDir: deps.config.attachmentDir });

  app.post('/api/app/email/inbound', async (req, reply) => {
    const secret = engine.inboundSecret();
    if (!secret)
      throw new HttpError(
        503,
        'Inbound email webhook is not configured',
        'Set the resolvr.email.inbound_secret property',
      );
    const given = req.headers[WEBHOOK_SECRET_HEADER];
    if (typeof given !== 'string' || !given || !sameSecret(given, secret)) {
      throw new HttpError(
        401,
        'Invalid webhook secret',
        `Provide the shared secret in the X-Resolvr-Webhook-Secret header`,
      );
    }
    if (!platform.properties.getBool('glide.email.read.active', true))
      throw new HttpError(503, 'Inbound email processing is disabled');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(400, 'Expected a JSON object');
    const result = engine.inbound.receive(body as InboundEmailInput);
    platform.scheduleWork();
    return reply.code(200).send({ result });
  });

  app.post('/api/app/notification/:sysId/preview', async (req) => {
    const ctx = ctxOf(req, deps);
    requireAdmin(ctx);
    const { sysId } = req.params as { sysId: string };
    const body = (req.body ?? {}) as {
      record?: unknown;
      event?: { name?: string; parm1?: string; parm2?: string };
    };
    const result = engine.preview(ctx, sysId, String(body.record ?? ''), body.event ?? null);
    return { result };
  });

  app.post('/api/app/email/outbox/process', async (req) => {
    const ctx = ctxOf(req, deps);
    requireAdmin(ctx);
    const result = await engine.processOutbox();
    return { result };
  });

  app.get('/api/app/notification/preferences', async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: preferences(engine, ctx) };
  });

  app.put('/api/app/notification/preferences', async (req) => {
    const ctx = ctxOf(req, deps);
    const userId = ctx.user.sysId;
    if (!userId) throw new HttpError(400, 'Preferences belong to a user');
    const body = (req.body ?? {}) as {
      notifications_enabled?: boolean;
      preferences?: {
        notification?: string;
        subscribed?: boolean;
        digest?: boolean;
        digest_interval?: string | null;
      }[];
    };
    const sys = ctx.elevated();
    platform.db.tx(() => {
      if (typeof body.notifications_enabled === 'boolean') {
        const user = sys.get('sys_user', userId);
        if (user) sys.update(user, { notification: body.notifications_enabled ? 2 : 1 });
      }
      for (const p of body.preferences ?? []) {
        if (!p.notification) continue;
        const n = sys.get('sysevent_email_action', p.notification);
        if (!n) throw new HttpError(400, `Unknown notification ${p.notification}`);
        if (p.subscribed === false && n.bool('mandatory'))
          throw new HttpError(400, `"${n.str('name')}" is mandatory`);
        const values: Record<string, unknown> = {};
        if (typeof p.subscribed === 'boolean') values.active = p.subscribed;
        if (typeof p.digest === 'boolean') values.digest = p.digest && n.bool('digestable');
        if (p.digest_interval !== undefined) values.digest_interval = p.digest_interval || null;
        const existing = sys.first('cmn_notif_message', `user=${userId}^notification=${n.sysId}`);
        if (existing) sys.update(existing, values);
        else
          sys.insert('cmn_notif_message', { user: userId, notification: n.sysId, active: true, ...values });
      }
    });
    return { result: preferences(engine, ctx) };
  });
}

/** The session user's preferences: global switch, devices and per-notification choices by category. */
function preferences(engine: NotificationEngine, ctx: Context) {
  const platform = engine.platform;
  const userId = ctx.user.sysId;
  const sys = ctx.elevated();
  const user = userId ? sys.get('sys_user', userId) : null;
  const subs = new Map(
    (userId ? sys.query('cmn_notif_message', { query: `user=${userId}` }) : []).map(
      (s) => [s.str('notification'), s] as const,
    ),
  );
  const categories = new Map<string, { sys_id: string | null; name: string; notifications: unknown[] }>();
  for (const n of sys.query('sysevent_email_action', { query: 'active=true' })) {
    const table = n.str('collection');
    if (table && !platform.registry.has(table)) continue;
    const catId = n.str('category') || null;
    const key = catId ?? '';
    if (!categories.has(key))
      categories.set(key, {
        sys_id: catId,
        name: catId ? n.display('category') : 'Uncategorized',
        notifications: [],
      });
    const sub = subs.get(n.sysId);
    categories.get(key)!.notifications.push({
      sys_id: n.sysId,
      name: n.str('name'),
      description: n.str('description'),
      table,
      mandatory: n.bool('mandatory'),
      subscribable: n.bool('subscribable'),
      subscribed: sub ? sub.bool('active') : !n.bool('subscribable'),
      digestable: n.bool('digestable'),
      digest: sub ? sub.bool('digest') : n.bool('default_digest'),
      digest_interval: sub?.str('digest_interval') || n.str('default_interval') || null,
    });
  }
  return {
    notifications_enabled: user ? (user.num('notification') ?? 2) !== 1 : true,
    devices: userId
      ? sys.query('cmn_notif_device', { query: `user=${userId}` }).map((d) => ({
          sys_id: d.sysId,
          name: d.str('name'),
          type: d.str('type'),
          email_address: d.str('email_address'),
          primary_email: d.bool('primary_email'),
          active: d.bool('active'),
        }))
      : [],
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
