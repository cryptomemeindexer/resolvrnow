import type { ModuleUiDef } from '../../engine/module.js';
import { SERVICES } from '../contracts.js';
import type { NotificationEngine } from './engine.js';

const ADMIN = ['notification_admin'];
const OUTBOX = 'typeINsend-ready,send-retry-backoff,send-retry-delayed^ORDERBYDESCsys_created_on';

export const notificationsUi: ModuleUiDef = {
  navigation: [
    {
      id: 'email',
      title: 'Email',
      icon: 'mail',
      roles: ADMIN,
      order: 920,
      modules: [
        { title: 'Notifications', table: 'sysevent_email_action', query: 'ORDERBYcollection^ORDERBYname' },
        { title: 'Templates', table: 'sysevent_email_template', query: 'ORDERBYname' },
        { title: 'Layouts', table: 'sys_email_layout' },
        { title: 'Mail Scripts', table: 'sys_script_email' },
        { title: 'Outbox', table: 'sys_email', query: OUTBOX, separator: true },
        { title: 'Sent', table: 'sys_email', query: 'type=sent^ORDERBYDESCsys_updated_on' },
        { title: 'Failed', table: 'sys_email', query: 'type=send-failed^ORDERBYDESCsys_updated_on' },
        { title: 'Skipped', table: 'sys_email', query: 'type=send-ignored^ORDERBYDESCsys_updated_on' },
        { title: 'Inbox', table: 'sys_email', query: 'type=received^ORDERBYDESCsys_created_on' },
        { title: 'Junk', table: 'sys_email', query: 'type=received-ignored^ORDERBYDESCsys_created_on' },
        { title: 'All Email', table: 'sys_email', query: 'ORDERBYDESCsys_created_on' },
        {
          title: 'Inbound Actions',
          table: 'sysevent_in_email_action',
          query: 'ORDERBYorder',
          separator: true,
        },
        { title: 'Reply Separators', table: 'sys_email_reply_separator', query: 'ORDERBYorder' },
        { title: 'Categories', table: 'sys_notification_category', separator: true },
        { title: 'Digest Intervals', table: 'sys_email_digest_interval' },
        { title: 'Subscriptions', table: 'cmn_notif_message' },
        { title: 'Devices', table: 'cmn_notif_device' },
        { title: 'Access Restrictions', table: 'email_access_restriction' },
        { title: 'Watermarks', table: 'sys_watermark', query: 'ORDERBYDESCsys_created_on' },
      ],
    },
    {
      id: 'my_notifications',
      title: 'Notification Preferences',
      icon: 'bell',
      order: 880,
      modules: [
        { title: 'My Subscriptions', table: 'cmn_notif_message', query: 'user=javascript:gs.getUserID()' },
        { title: 'My Devices', table: 'cmn_notif_device', query: 'user=javascript:gs.getUserID()' },
      ],
    },
  ],
  lists: [
    {
      table: 'sysevent_email_action',
      columns: [
        'name',
        'collection',
        'generation_type',
        'event_name',
        'category',
        'weight',
        'active',
        'sys_updated_on',
      ],
    },
    {
      table: 'sysevent_email_template',
      columns: ['name', 'collection', 'subject', 'email_layout', 'sys_updated_on'],
    },
    { table: 'sys_email_layout', columns: ['name', 'description', 'advanced', 'sys_updated_on'] },
    { table: 'sys_script_email', columns: ['name', 'description', 'resolvr_native', 'new_lines_to_html'] },
    {
      table: 'sys_email',
      columns: [
        'sys_created_on',
        'type',
        'subject',
        'recipients',
        'user',
        'target_table',
        'instance',
        'state',
      ],
    },
    {
      table: 'sysevent_in_email_action',
      columns: ['order', 'name', 'type', 'collection', 'resolvr_handler', 'stop_processing', 'active'],
    },
    { table: 'sys_email_reply_separator', columns: ['order', 'name', 'type', 'separator', 'active'] },
    { table: 'cmn_notif_message', columns: ['user', 'notification', 'active', 'digest', 'digest_interval'] },
    {
      table: 'cmn_notif_device',
      columns: ['user', 'name', 'type', 'email_address', 'primary_email', 'active'],
    },
    { table: 'sys_watermark', columns: ['number', 'source_table', 'source_id', 'email', 'sys_created_on'] },
    { table: 'sys_email_log', columns: ['email', 'notification', 'event', 'sys_created_on'] },
    { table: 'syslog_email', columns: ['sys_created_on', 'level', 'message'] },
    {
      table: 'resolvr_email_preview',
      columns: ['subject', 'notification', 'target_table', 'instance', 'sys_created_on'],
    },
  ],
  forms: [
    {
      table: 'sysevent_email_action',
      highlights: ['collection', 'generation_type', 'active'],
      sections: [
        {
          left: ['name', 'collection', 'category', 'active'],
          right: ['type', 'order', 'weight', 'mandatory'],
        },
        { fields: ['description'] },
        {
          caption: 'When to send',
          left: ['generation_type', 'event_name', 'action_insert', 'action_update'],
          right: ['force_delivery', 'subscribable'],
        },
        { fields: ['condition', 'advanced_condition'] },
        {
          caption: 'Who will receive',
          left: ['recipient_users', 'recipient_groups', 'recipient_fields'],
          right: ['event_parm_1', 'event_parm_2', 'send_self', 'exclude_delegates'],
        },
        {
          caption: 'What it will contain',
          left: ['template', 'content_type', 'importance', 'from', 'reply_to'],
          right: ['omit_watermark', 'include_attachments'],
        },
        { fields: ['subject', 'message_html', 'message_text', 'sms_alternate'] },
        {
          caption: 'Digest',
          left: ['digestable', 'default_digest', 'default_interval', 'digest_type'],
          right: ['digest_template', 'digest_subject', 'digest_from', 'digest_reply_to'],
        },
        { fields: ['digest_html', 'digest_text', 'digest_separator_html', 'digest_separator_text'] },
      ],
      relatedLists: [
        {
          table: 'sys_email_log',
          field: 'notification',
          label: 'Emails generated',
          columns: ['email', 'event', 'sys_created_on'],
        },
        {
          table: 'cmn_notif_message',
          field: 'notification',
          label: 'Subscriptions',
          columns: ['user', 'active', 'digest'],
        },
        {
          table: 'email_access_restriction',
          field: 'notification',
          label: 'Access restrictions',
          columns: ['conditions', 'description'],
        },
      ],
    },
    {
      table: 'sysevent_email_template',
      sections: [
        { left: ['name', 'collection'], right: ['email_layout'] },
        { fields: ['subject', 'message_html', 'message_text', 'sms_alternate'] },
      ],
      relatedLists: [
        {
          table: 'sysevent_email_action',
          field: 'template',
          label: 'Notifications using this template',
          columns: ['name', 'collection', 'active'],
        },
      ],
    },
    {
      table: 'sys_email_layout',
      sections: [
        { left: ['name', 'advanced'], right: ['description'] },
        { fields: ['layout', 'advanced_layout'] },
      ],
    },
    {
      table: 'sys_script_email',
      sections: [
        { left: ['name', 'new_lines_to_html'], right: ['resolvr_native'] },
        { fields: ['description', 'script'] },
      ],
    },
    {
      table: 'sys_email',
      highlights: ['type', 'state', 'receive_type'],
      sections: [
        {
          left: ['type', 'state', 'mailbox', 'receive_type', 'notification_type'],
          right: ['sys_created_on', 'target_table', 'instance', 'user', 'user_id'],
        },
        {
          left: ['recipients', 'copied', 'blind_copied', 'reply_to'],
          right: ['weight', 'importance', 'resolvr_attempts', 'resolvr_next_attempt'],
        },
        { fields: ['subject', 'body'] },
        {
          caption: 'Delivery',
          fields: ['error_string', 'status', 'message_id', 'headers', 'body_text', 'content_type'],
        },
      ],
      relatedLists: [
        {
          table: 'syslog_email',
          field: 'email',
          label: 'Email log',
          columns: ['sys_created_on', 'level', 'message'],
        },
        {
          table: 'sys_email_log',
          field: 'email',
          label: 'Originating notification',
          columns: ['notification', 'event'],
        },
        {
          table: 'sys_email_attachment',
          field: 'email',
          label: 'Attachments',
          columns: ['file_name', 'attachment', 'source'],
        },
        {
          table: 'sys_watermark',
          field: 'email',
          label: 'Watermarks',
          columns: ['number', 'source_table', 'source_id'],
        },
      ],
    },
    {
      table: 'sysevent_in_email_action',
      highlights: ['type', 'collection', 'active'],
      sections: [
        {
          left: ['name', 'type', 'collection', 'action', 'resolvr_handler'],
          right: ['order', 'active', 'stop_processing', 'required_roles', 'from'],
        },
        { fields: ['description'] },
        { caption: 'When to run', fields: ['filter_condition', 'condition_script'] },
        { caption: 'Actions', fields: ['template', 'script', 'reply_email'] },
      ],
    },
    {
      table: 'sys_email_reply_separator',
      sections: [
        { left: ['name', 'type', 'separator'], right: ['order', 'active', 'language'] },
        { fields: ['short_description'] },
      ],
    },
    {
      table: 'cmn_notif_message',
      sections: [
        { left: ['user', 'notification', 'device'], right: ['active', 'digest', 'digest_interval'] },
        { fields: ['filter_condition'] },
      ],
    },
    {
      table: 'cmn_notif_device',
      sections: [
        {
          left: ['user', 'name', 'type'],
          right: ['email_address', 'phone_number', 'primary_email', 'active', 'order'],
        },
      ],
    },
    {
      table: 'resolvr_email_preview',
      sections: [
        { left: ['notification', 'target_table', 'instance'], right: ['sys_created_on', 'sys_created_by'] },
        { fields: ['subject', 'recipients', 'excluded', 'body', 'body_text'] },
      ],
    },
  ],
  uiActions: [
    {
      id: 'sysevent_email_action.preview',
      table: 'sysevent_email_action',
      label: 'Preview',
      actionName: 'preview_notification',
      roles: ADMIN,
      order: 50,
      saveFirst: true,
      prompt: [{ field: 'preview_record', label: 'Record (sys_id or number)', mandatory: true }],
      run(rec, ctx, input) {
        const engine = ctx.platform.services.get(SERVICES.notifications) as NotificationEngine;
        const ref = String(input.preview_record ?? '').trim();
        const p = engine.preview(ctx, rec.sysId, ref);
        const preview = ctx.elevated().insert('resolvr_email_preview', {
          notification: rec.sysId,
          target_table: p.target?.table ?? null,
          instance: p.target?.sys_id ?? null,
          subject: p.subject,
          recipients:
            p.recipients
              .map((r) => `${r.name ? `${r.name} <${r.address}>` : r.address}: ${r.reason}`)
              .join('\n') || '(nobody)',
          excluded: p.excluded.map((x) => `${x.who}: ${x.reason}`).join('\n'),
          body: p.body,
          body_text: p.body_text,
        });
        return {
          message: `Preview of "${rec.str('name')}" for ${p.target?.display_value ?? 'no record'}: ${p.recipients.length} recipient(s)`,
          redirect: `/workspace/record/resolvr_email_preview/${preview.sysId}`,
        };
      },
    },
    {
      id: 'sys_email.resend',
      table: 'sys_email',
      label: 'Send again',
      roles: ADMIN,
      order: 50,
      saveFirst: false,
      condition: 'typeINsend-failed,send-ignored,sent',
      confirm: 'Queue this email for delivery again?',
      run(rec, ctx) {
        const engine = ctx.platform.services.get(SERVICES.notifications) as NotificationEngine;
        ctx.elevated().update(rec, {
          type: 'send-ready',
          state: 'ready',
          mailbox: engine.mailboxId('Outbox'),
          error_string: '',
          resolvr_attempts: 0,
          resolvr_next_attempt: null,
        });
        return { message: 'Email queued; it will be sent on the next sender run' };
      },
    },
    {
      id: 'sys_email.reprocess',
      table: 'sys_email',
      label: 'Reprocess',
      roles: ADMIN,
      order: 60,
      saveFirst: false,
      condition: 'type=received',
      confirm: 'Run the inbound email actions for this email again?',
      run(rec, ctx) {
        const engine = ctx.platform.services.get(SERVICES.notifications) as NotificationEngine;
        const r = engine.inbound.reprocess(rec);
        return {
          message: `Reprocessed as ${r.receive_type}${r.actions.length ? `: ${r.actions.join(', ')}` : ' (no action matched)'}`,
        };
      },
    },
  ],
};
