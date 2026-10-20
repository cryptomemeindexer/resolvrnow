import type { Context } from '../../engine/context.js';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_DIGEST_INTERVALS,
  DEFAULT_INBOUND_ACTIONS,
  DEFAULT_LAYOUT_HTML,
  DEFAULT_LAYOUT_NAME,
  DEFAULT_MAILBOXES,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REPLY_SEPARATORS,
  DEFAULT_TEMPLATES,
} from './content.js';
import { NATIVE_MAIL_SCRIPTS } from './mailscripts.js';
import { randomAlnum } from './util.js';

/** Inserts `values` into `table` unless a row with `field = key` already exists; returns its sys_id. */
function ensure(
  ctx: Context,
  table: string,
  field: string,
  key: string,
  values: Record<string, unknown>,
): string {
  const existing = ctx.first(table, `${field}=${key}`);
  if (existing) return existing.sysId;
  return ctx.insert(table, { [field]: key, ...values }).sysId;
}

/** Built-in mail scripts are listed in sys_script_email so admins can see what they do. */
export function mirrorNativeMailScripts(ctx: Context): void {
  for (const [name, def] of Object.entries(NATIVE_MAIL_SCRIPTS)) {
    ensure(ctx, 'sys_script_email', 'name', name, {
      resolvr_native: true,
      description: def.description,
      script: `// Built-in ResolvrNow mail script: ${def.description}\n// Use \${mail_script:${name}} in a notification, template or layout.`,
    });
  }
}

/** The guest user that unknown inbound senders are processed as. */
export function ensureGuestUser(ctx: Context): void {
  if (ctx.first('sys_user', 'user_name=guest')) return;
  ctx.insert('sys_user', {
    user_name: 'guest',
    first_name: 'Guest',
    last_name: '',
    active: true,
    notification: 1,
  });
}

/** Reference data, default layout/templates/notifications and inbound actions. */
export function seedNotifications(ctx: Context): void {
  const platform = ctx.platform;
  const id = platform.properties.get('resolvr.instance_id') ?? '';
  if (!id || id === '(generated)') platform.properties.set('resolvr.instance_id', randomAlnum(32));

  for (const name of DEFAULT_MAILBOXES) ensure(ctx, 'sys_mailbox', 'name', name, { system_mailbox: true });
  const categories = new Map<string, string>();
  for (const c of DEFAULT_CATEGORIES)
    categories.set(
      c.name,
      ensure(ctx, 'sys_notification_category', 'name', c.name, { short_description: c.short_description }),
    );
  for (const iv of DEFAULT_DIGEST_INTERVALS)
    ensure(ctx, 'sys_email_digest_interval', 'name', iv.name, { interval: iv.interval, active: true });
  for (const s of DEFAULT_REPLY_SEPARATORS) {
    ensure(ctx, 'sys_email_reply_separator', 'name', s.name, {
      type: s.type,
      separator: s.separator,
      order: s.order,
      short_description: s.short_description,
      active: true,
    });
  }
  mirrorNativeMailScripts(ctx);
  ensureGuestUser(ctx);

  const layoutId = ensure(ctx, 'sys_email_layout', 'name', DEFAULT_LAYOUT_NAME, {
    description: 'Branded ResolvrNow layout: header, body slot and a preferences footer.',
    layout: DEFAULT_LAYOUT_HTML,
    advanced: false,
  });
  const templates = new Map<string, string>();
  for (const t of DEFAULT_TEMPLATES) {
    templates.set(
      t.name,
      ensure(ctx, 'sysevent_email_template', 'name', t.name, {
        collection: t.collection,
        subject: t.subject,
        message_html: t.message_html,
        message_text: t.message_text ?? '',
        email_layout: layoutId,
      }),
    );
  }
  for (const n of DEFAULT_NOTIFICATIONS) {
    ensure(ctx, 'sysevent_email_action', 'name', n.name, {
      collection: n.collection,
      category: categories.get(n.category) ?? null,
      template: templates.get(n.template) ?? null,
      active: true,
      generation_type: n.generation_type,
      event_name: n.event_name ?? '',
      action_insert: !!n.action_insert,
      action_update: !!n.action_update,
      condition: n.condition ?? '',
      recipient_fields: n.recipient_fields ?? '',
      send_self: n.send_self ?? true,
      weight: n.weight ?? 0,
      order: n.order ?? 100,
      content_type: 'text/html',
      description: n.description,
    });
  }
  for (const a of DEFAULT_INBOUND_ACTIONS) {
    ensure(ctx, 'sysevent_in_email_action', 'name', a.name, {
      type: a.type,
      collection: a.collection,
      resolvr_handler: a.resolvr_handler,
      order: a.order,
      stop_processing: a.stop_processing,
      filter_condition: a.filter_condition ?? '',
      action: 'record_action',
      active: true,
      description: a.description,
    });
  }
}
