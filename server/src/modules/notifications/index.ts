// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notification templates use ${field} placeholders
import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import { InvalidError } from '../../engine/errors.js';
import type { AppModule } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import type { AclDef, AclOperation } from '../../engine/services/acl.js';
import type { PropertyDef } from '../../engine/services/properties.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { SERVICES } from '../contracts.js';
import { registerNotificationApi } from './api.js';
import { NotificationEngine } from './engine.js';
import { ensureGuestUser, mirrorNativeMailScripts, seedNotifications } from './seed.js';
import { notificationTables, USER_NOTIFICATION_CHOICES } from './tables.js';
import { notificationsUi } from './ui.js';

export { NotificationEngine } from './engine.js';
export {
  LogTransport,
  type MailMessage,
  type MailTransport,
  SmtpTransport,
  smtpTransportFromPlugin,
} from './transport.js';

/** The notification engine of a booted platform. */
export function notificationEngine(platform: Platform): NotificationEngine {
  return platform.service<NotificationEngine>(SERVICES.notifications);
}

const ADMIN_ROLE = 'notification_admin';
const ALL_OPS: AclOperation[] = ['read', 'write', 'create', 'delete'];

const ADMIN_TABLES = [
  'sysevent_email_action',
  'sysevent_email_template',
  'sys_email_layout',
  'sys_script_email',
  'sysevent_in_email_action',
  'sys_email_reply_separator',
  'email_access_restriction',
  'sys_mailbox',
  'sys_watermark',
  'sys_email_log',
  'syslog_email',
  'sys_email_attachment',
  'sys_email_digest_part',
  'sys_email_digest_part_user',
  'resolvr_email_preview',
];

const acls: AclDef[] = [
  ...ADMIN_TABLES.flatMap((name) => ALL_OPS.map((operation) => ({ name, operation, roles: [ADMIN_ROLE] }))),
  ...['sys_notification_category', 'sys_email_digest_interval'].flatMap((name) => [
    { name, operation: 'read' as const, roles: ['snc_internal'] },
    ...(['write', 'create', 'delete'] as const).map((operation) => ({
      name,
      operation,
      roles: [ADMIN_ROLE],
    })),
  ]),
  {
    name: 'sys_email',
    operation: 'read',
    roles: ['itil', ADMIN_ROLE],
    description: 'Agents read email; email access restrictions narrow it per notification',
    script: (rec, ctx) => {
      const engine = ctx.platform.services.get(SERVICES.notifications) as NotificationEngine | undefined;
      return !engine || engine.canReadEmail(ctx, rec);
    },
  },
  ...(['write', 'create', 'delete'] as const).map((operation) => ({
    name: 'sys_email',
    operation,
    roles: [ADMIN_ROLE],
  })),
  ...['cmn_notif_message', 'cmn_notif_device'].flatMap((name) => [
    ...ALL_OPS.map((operation) => ({
      name,
      operation,
      condition: 'user=javascript:gs.getUserID()',
      description: 'Users manage their own preferences',
    })),
    ...ALL_OPS.map((operation) => ({ name, operation, roles: [ADMIN_ROLE] })),
  ]),
];

const prop = (
  name: string,
  value: string,
  description: string,
  type: PropertyDef['type'] = 'string',
  choices?: string,
): PropertyDef => ({
  name,
  value,
  description,
  type,
  ...(choices ? { choices } : {}),
});

const properties: PropertyDef[] = [
  prop(
    'resolvr.email.transport',
    'log',
    'Outbound transport: log (record only) or smtp',
    'choicelist',
    'log,smtp',
  ),
  prop('resolvr.email.smtp.host', '', 'SMTP server (RESOLVRNOW_SMTP_HOST overrides)'),
  prop(
    'resolvr.email.smtp.port',
    '',
    'SMTP port, default 587, or 465 when secure (RESOLVRNOW_SMTP_PORT overrides)',
    'integer',
  ),
  prop('resolvr.email.smtp.secure', '', 'Use implicit TLS (RESOLVRNOW_SMTP_SECURE overrides)', 'boolean'),
  prop('resolvr.email.smtp.user', '', 'SMTP user name (RESOLVRNOW_SMTP_USER overrides)'),
  prop('resolvr.email.smtp.password', '', 'SMTP password (RESOLVRNOW_SMTP_PASS overrides)', 'password'),
  prop('resolvr.email.from_name', 'ResolvrNow', 'Display name of the sending address'),
  prop(
    'resolvr.email.inbound_secret',
    '',
    'Shared secret expected in the X-Resolvr-Webhook-Secret header of POST /api/app/email/inbound',
    'password',
  ),
  prop(
    'resolvr.email.default_layout',
    'ResolvrNow default',
    'Email layout used when a notification template has none (empty = no layout)',
  ),
  prop('resolvr.email.sender.interval_ms', '60000', 'Minimum time between outbound sender runs', 'integer'),
  prop('resolvr.instance_id', '', 'Token proving unsubscribe requests come from this instance (generated)'),
  prop('glide.email.smtp.active', 'true', 'Send outbound email', 'boolean'),
  prop('glide.email.read.active', 'true', 'Process inbound email', 'boolean'),
  prop(
    'glide.email.user',
    '',
    'Instance email address (From of outbound email; RESOLVRNOW_SMTP_FROM overrides)',
  ),
  prop('glide.servlet.uri', '', 'Base URL of links in emails (defaults to RESOLVRNOW_PUBLIC_URL)'),
  prop('glide.email.smtp.max_recipients', '100', 'Recipients per email; larger lists are split', 'integer'),
  prop(
    'glide.email.journal.lines',
    '3',
    'Journal entries rendered by ${comments} style variables (-1 = all)',
    'integer',
  ),
  prop('glide.email.append.timezone', 'true', 'Append the time zone to date-times in emails', 'boolean'),
  prop('glide.email.watermark.visible', 'true', 'Show the watermark in HTML bodies', 'boolean'),
  prop(
    'glide.email.reply_subject_prefix',
    're:,aw:,r:,Accepted:,Tentative:,Declined:',
    'Reply subject prefixes (case-sensitive)',
  ),
  prop('glide.email.forward_subject_prefix', 'fw:,fwd:', 'Forward subject prefixes (case-insensitive)'),
  prop(
    'glide.pop3readerjob.create_caller',
    'false',
    'Create users for unknown senders from trusted domains',
    'boolean',
  ),
  prop('glide.user.trusted_domain', '', 'Comma separated domains trusted for automatic user creation'),
  prop('glide.email.smtp.claim.lookback.hrs', '24', 'Hours during which failed sends are retried', 'integer'),
  prop(
    'glide.notification.recipient.include_logging',
    'true',
    'Log why each recipient was included',
    'boolean',
  ),
  prop('glide.notification.recipient.exclude_logging', 'true', 'Log why recipients were excluded', 'boolean'),
];

/** Email notifications, outbound email, templates, inbound email actions. */
export const notificationsModule: AppModule = {
  id: 'notifications',
  name: 'Notifications',
  description: 'Email notifications, outbound email, templates, inbound email actions.',
  dependsOn: ['platform'],
  tables: notificationTables,
  choices: { 'sys_user.notification': USER_NOTIFICATION_CHOICES },
  roles: [
    {
      name: ADMIN_ROLE,
      description: 'Manages email notifications, templates, mail scripts and inbound email actions',
    },
  ],
  acls,
  properties,
  rules: [
    {
      name: 'Notification: not on the task table',
      table: 'sysevent_email_action',
      when: 'before',
      actions: ['insert', 'update'],
      run(cur) {
        if (cur.str('collection') === 'task') {
          throw new InvalidError(
            'Notifications cannot be defined on the task table',
            'Choose a table that extends task, such as incident',
          );
        }
      },
    },
    {
      name: 'Subscription: mandatory notifications stay subscribed',
      table: 'cmn_notif_message',
      when: 'before',
      actions: ['insert', 'update'],
      condition: (cur) => !cur.bool('active'),
      run(cur, _prev, ctx) {
        const n = ctx.elevated().loadRaw('sysevent_email_action', cur.str('notification'));
        if (n?.bool('mandatory')) cur.abort(`"${n.str('name')}" is mandatory and cannot be unsubscribed`);
      },
    },
    {
      name: 'Digest interval: between one hour and seven days',
      table: 'sys_email_digest_interval',
      when: 'before',
      actions: ['insert', 'update'],
      run(cur) {
        const ms = cur.num('interval') ?? 0;
        if (ms < 3_600_000 || ms > 604_800_000)
          cur.abort('A digest interval must be between 1 hour and 7 days');
      },
    },
    {
      name: 'Digest interval: in-use intervals cannot be deleted',
      table: 'sys_email_digest_interval',
      when: 'before',
      actions: ['delete'],
      run(cur, _prev, ctx) {
        const sys = ctx.elevated();
        if (
          sys.count('sysevent_email_action', `default_interval=${cur.sysId}`) ||
          sys.count('cmn_notif_message', `digest_interval=${cur.sysId}`)
        ) {
          cur.abort('This digest interval is in use');
        }
      },
    },
  ],
  jobs: [
    {
      id: 'notifications.sender',
      name: 'Email sender',
      description: 'Delivers send-ready email (honours resolvr.email.sender.interval_ms)',
      intervalMs: 5_000,
      run: (ctx) => notificationEngine(ctx.platform).runSenderJob(),
    },
    {
      id: 'notifications.digests',
      name: 'Email digests',
      description: 'Sends digests whose interval has elapsed',
      intervalMs: 15 * 60_000,
      run: (ctx) => {
        notificationEngine(ctx.platform).processDigests(ctx);
      },
    },
    {
      id: 'notifications.cleanup',
      name: 'Email log cleanup',
      description: 'Removes email log entries older than 7 days and notification previews older than 1 day',
      intervalMs: 24 * 3_600_000,
      run: (ctx) => {
        const db = ctx.platform.db;
        const now = nowGlide();
        db.run(`DELETE FROM "syslog_email" WHERE "sys_created_on" < ?`, [addMs(now, -7 * 86_400_000)]);
        db.run(`DELETE FROM "resolvr_email_preview" WHERE "sys_created_on" < ?`, [addMs(now, -86_400_000)]);
      },
    },
  ],
  ui: notificationsUi,
  register(platform) {
    const engine = new NotificationEngine(platform);
    platform.services.set(SERVICES.notifications, engine);
    platform.hooks.on('insert', '*', 'notifications:record-insert', (rec, prev, ctx) =>
      engine.onRecord('insert', rec, prev, ctx),
    );
    platform.hooks.on('update', '*', 'notifications:record-update', (rec, prev, ctx) =>
      engine.onRecord('update', rec, prev, ctx),
    );
    platform.hooks.on(
      ['insert', 'update', 'delete'],
      'sysevent_email_action',
      'notifications:definitions',
      () => engine.invalidate(),
    );
    platform.hooks.on(['insert', 'update'], 'sys_user', 'notifications:primary-device', (rec, prev, ctx) =>
      engine.syncPrimaryDevice(rec, prev, ctx),
    );
    platform.events.on({
      event: '*',
      name: 'notifications',
      run: (ev, rec, ctx) => engine.onEvent(ev, rec, ctx),
    });
  },
  seedVersion: 1,
  seed: seedNotifications,
  afterBoot(platform) {
    const ctx = platform.systemContext();
    mirrorNativeMailScripts(ctx);
    ensureGuestUser(ctx);
  },
  http(app, deps) {
    registerNotificationApi(app as FastifyInstance, deps as ApiDeps);
  },
};
