// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notification templates use ${field} placeholders
import type { ChoiceDef, ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });
const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  ...extra,
});
const bool = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});
const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});

export const EMAIL_TYPE_CHOICES: ChoiceDef[] = [
  c('send-ready', 'Send-ready', 10),
  c('sent', 'Sent', 20),
  c('send-failed', 'Send-failed', 30),
  c('send-ignored', 'Send-ignored', 40),
  c('send-retry-backoff', 'Send-retry-backoff', 50),
  c('send-retry-delayed', 'Send-retry-delayed', 60),
  c('send-translation-ready', 'Send-translation-ready', 70),
  c('received', 'Received', 80),
  c('received-ignored', 'Received-ignored', 90),
  c('draft', 'Draft', 100),
];

export const EMAIL_STATE_CHOICES: ChoiceDef[] = [
  c('ready', 'Ready', 10),
  c('processed', 'Processed', 20),
  c('error', 'Error', 30),
  c('ignored', 'Ignored', 40),
];

export const RECEIVE_TYPE_CHOICES: ChoiceDef[] = [
  c('new', 'New', 10),
  c('reply', 'Reply', 20),
  c('forward', 'Forward', 30),
];

export const NOTIFICATION_TYPE_CHOICES: ChoiceDef[] = [c('SMTP', 'SMTP', 10), c('SMS', 'SMS', 20)];

export const GENERATION_TYPE_CHOICES: ChoiceDef[] = [
  c('engine', 'Record inserted or updated', 10),
  c('event', 'Event is fired', 20),
  c('triggered', 'Triggered (flow notification step)', 30),
];

export const ACTION_TYPE_CHOICES: ChoiceDef[] = [
  c('email', 'EMAIL', 10),
  c('vcalendar', 'Meeting Invitation', 20),
];

export const CONTENT_TYPE_CHOICES: ChoiceDef[] = [
  c('text/html', 'HTML only', 10),
  c('multipart/alternative', 'HTML and plain text', 20),
  c('text/plain', 'Plain text only', 30),
];

export const IMPORTANCE_CHOICES: ChoiceDef[] = [c('low', 'Low', 10), c('high', 'High', 20)];

export const DIGEST_TYPE_CHOICES: ChoiceDef[] = [
  c('single', 'Single target record', 10),
  c('multiple', 'Multiple target record', 20),
];

export const INBOUND_TYPE_CHOICES: ChoiceDef[] = RECEIVE_TYPE_CHOICES;

export const INBOUND_ACTION_CHOICES: ChoiceDef[] = [
  c('record_action', 'Record Action', 10),
  c('reply_email', 'Reply Email', 20),
];

/** ResolvrNow built-in inbound behaviours (handlers implemented in inbound.ts). */
export const INBOUND_HANDLER_CHOICES: ChoiceDef[] = [
  c('reply_comment', 'Add the reply to the record as a comment', 10),
  c('create_record', 'Create a record from the email', 20),
  c('approval_reply', 'Approve or reject from the reply', 30),
  c('unsubscribe', 'Unsubscribe the sender from a notification', 40),
];

export const SEPARATOR_TYPE_CHOICES: ChoiceDef[] = [c('string', 'String', 10), c('regex', 'Regex', 20)];

export const USER_NOTIFICATION_CHOICES: ChoiceDef[] = [c('2', 'Enable', 10), c('1', 'Disable', 20)];

export const DEVICE_TYPE_CHOICES: ChoiceDef[] = [
  c('Email', 'Email', 10),
  c('SMS', 'SMS', 20),
  c('Voice', 'Voice', 30),
  c('Push', 'Push', 40),
];

export const notificationTables: TableDef[] = [
  sdkTable('sys_notification_category', {
    extends: null,
    displayField: 'name',
    patch: { name: { mandatory: true, maxLength: 80 } },
  }),
  sdkTable('sys_email_digest_interval', {
    extends: null,
    displayField: 'name',
    patch: { name: { mandatory: true, maxLength: 80 } },
    columns: [bool('active', 'Active', { defaultValue: 'true' })],
  }),
  sdkTable('sys_email_layout', {
    extends: null,
    displayField: 'name',
    patch: { name: { mandatory: true } },
  }),
  sdkTable('sysevent_email_template', {
    extends: null,
    displayField: 'name',
    exclude: ['message', 'message_list', 'sys_version'],
    patch: { collection: { defaultValue: undefined }, subject: { maxLength: 160 } },
  }),
  sdkTable('sys_script_email', {
    extends: null,
    label: 'Email Script',
    displayField: 'name',
    patch: {
      name: { mandatory: true, indexed: true },
      script: { defaultValue: undefined, maxLength: 100000 },
    },
    columns: [
      bool('resolvr_native', 'Built-in', {
        readOnly: true,
        defaultValue: 'false',
        hint: 'Implemented natively by ResolvrNow; the script text is informational',
      }),
      str('description', 'Description', { maxLength: 1000 }),
    ],
  }),
  sdkTable('sysevent_email_action', {
    extends: null,
    displayField: 'name',
    audit: true,
    exclude: [
      'affected_field_on_event',
      'enable_dynamic_translation',
      'item',
      'item_table',
      'message',
      'message_list',
      'push_message_only',
      'style',
      'sys_version',
    ],
    columns: [
      str('name', 'Name', { mandatory: true, maxLength: 100 }),
      str('description', 'Description', { maxLength: 4000 }),
      int('order', 'Order', { defaultValue: '100' }),
    ],
    patch: {
      category: { mandatory: false, defaultValue: undefined },
      collection: { indexed: true },
      event_name: { indexed: true },
      generation_type: { choices: GENERATION_TYPE_CHOICES },
      type: { choices: ACTION_TYPE_CHOICES },
      content_type: { choices: CONTENT_TYPE_CHOICES },
      importance: { choices: IMPORTANCE_CHOICES },
      digest_type: { choices: DIGEST_TYPE_CHOICES },
      subject: { maxLength: 160 },
      weight: { defaultValue: '0' },
      action_insert: { defaultValue: 'false' },
      action_update: { defaultValue: 'false' },
      event_parm_1: { defaultValue: 'false' },
      event_parm_2: { defaultValue: 'false' },
      include_attachments: { defaultValue: 'false' },
    },
  }),
  sdkTable('email_access_restriction', {
    extends: null,
    displayField: 'notification',
    patch: { notification: { mandatory: true, cascade: 'delete' } },
  }),
  sdkTable('sys_mailbox', { extends: null, displayField: 'name' }),
  sdkTable('sys_email', {
    displayField: 'subject',
    patch: {
      type: { choices: EMAIL_TYPE_CHOICES, indexed: true },
      state: { choices: EMAIL_STATE_CHOICES, indexed: true },
      receive_type: { choices: RECEIVE_TYPE_CHOICES },
      notification_type: { choices: NOTIFICATION_TYPE_CHOICES },
      body: { type: 'html', maxLength: undefined, readOnly: true },
      body_text: { type: 'multi_two_lines', maxLength: undefined },
      headers: { type: 'multi_two_lines', maxLength: undefined },
      instance: { indexed: true },
      message_id: { indexed: true },
      importance: { choices: IMPORTANCE_CHOICES },
    },
    columns: [
      int('resolvr_attempts', 'Delivery attempts', { defaultValue: '0', readOnly: true }),
      dt('resolvr_next_attempt', 'Next attempt', { readOnly: true }),
    ],
  }),
  sdkTable('sys_email_attachment', {
    displayField: 'file_name',
  }),
  {
    name: 'sys_email_log',
    label: 'Email Log',
    system: true,
    columns: [
      ref('email', 'Email', 'sys_email', { cascade: 'delete' }),
      ref('notification', 'Notification', 'sysevent_email_action', { cascade: 'clear' }),
      ref('event', 'Event', 'sysevent'),
    ],
  },
  {
    name: 'syslog_email',
    label: 'Email Log Entry',
    system: true,
    columns: [
      ref('email', 'Email', 'sys_email', { cascade: 'delete' }),
      str('level', 'Level', {
        maxLength: 40,
        choices: [c('info', 'Information', 10), c('warn', 'Warning', 20), c('error', 'Error', 30)],
      }),
      str('message', 'Message', { maxLength: 4000 }),
    ],
  },
  {
    name: 'sys_watermark',
    label: 'Email Watermark',
    system: true,
    displayField: 'number',
    number: { prefix: 'MSG', start: 0, digits: 7 },
    columns: [
      str('number', 'Number', { maxLength: 40, indexed: true, readOnly: true }),
      { name: 'source_table', label: 'Source table', type: 'table_name' },
      str('source_id', 'Source ID', { maxLength: 32, indexed: true }),
      ref('email', 'Email', 'sys_email', { cascade: 'delete' }),
    ],
  },
  {
    name: 'sysevent_in_email_action',
    label: 'Inbound Email Action',
    displayField: 'name',
    audit: true,
    columns: [
      str('name', 'Name', { mandatory: true, maxLength: 100 }),
      { name: 'collection', label: 'Target table', type: 'table_name' },
      str('action', 'Action type', {
        maxLength: 40,
        defaultValue: 'record_action',
        choices: INBOUND_ACTION_CHOICES,
      }),
      bool('active', 'Active', { defaultValue: 'true' }),
      bool('stop_processing', 'Stop processing', { defaultValue: 'false' }),
      str('type', 'Type', { maxLength: 40, defaultValue: 'new', choices: INBOUND_TYPE_CHOICES }),
      { name: 'required_roles', label: 'Required roles', type: 'user_roles', maxLength: 1000 },
      int('order', 'Order', { defaultValue: '100' }),
      ref('from', 'From', 'sys_user'),
      {
        name: 'filter_condition',
        label: 'Condition',
        type: 'conditions',
        maxLength: 4000,
        hint: 'Encoded query evaluated against the received email (subject, body_text, user, recipients...)',
      },
      str('condition_script', 'Condition script', { maxLength: 1000 }),
      str('template', 'Field actions', {
        maxLength: 4000,
        hint: 'field=value pairs separated by ^; values may use ${email.subject}, ${email.body_text}, ${email.from}, ${email.from_sys_id} or ${email.body.<name>}',
      }),
      { name: 'reply_email', label: 'Reply email', type: 'html', maxLength: 8000 },
      { name: 'script', label: 'Script', type: 'script', maxLength: 100000 },
      str('resolvr_handler', 'Built-in behaviour', { maxLength: 40, choices: INBOUND_HANDLER_CHOICES }),
      str('description', 'Description', { maxLength: 4000 }),
    ],
  },
  {
    name: 'sys_email_reply_separator',
    label: 'Email Reply Separator',
    displayField: 'name',
    columns: [
      str('name', 'Name', { maxLength: 100, mandatory: true }),
      bool('active', 'Active', { defaultValue: 'true' }),
      str('type', 'Type', { maxLength: 40, defaultValue: 'string', choices: SEPARATOR_TYPE_CHOICES }),
      int('order', 'Order', { defaultValue: '100' }),
      str('separator', 'Separator', { maxLength: 1000, mandatory: true }),
      str('short_description', 'Short description', { maxLength: 160 }),
      str('language', 'Language', { maxLength: 40 }),
    ],
  },
  {
    name: 'cmn_notif_device',
    label: 'Notification Device',
    displayField: 'name',
    columns: [
      ref('user', 'User', 'sys_user', { mandatory: true, cascade: 'delete' }),
      str('name', 'Name', { maxLength: 100 }),
      str('type', 'Type', { maxLength: 40, defaultValue: 'Email', choices: DEVICE_TYPE_CHOICES }),
      { name: 'email_address', label: 'Email address', type: 'email', maxLength: 100, indexed: true },
      str('phone_number', 'Phone number', { maxLength: 40 }),
      bool('primary_email', 'Primary email', { defaultValue: 'false' }),
      bool('active', 'Active', { defaultValue: 'true' }),
      int('order', 'Order', { defaultValue: '100' }),
    ],
  },
  {
    name: 'cmn_notif_message',
    label: 'Notification Subscription',
    displayField: 'notification',
    columns: [
      ref('user', 'User', 'sys_user', { mandatory: true, cascade: 'delete' }),
      ref('notification', 'Notification', 'sysevent_email_action', { mandatory: true, cascade: 'delete' }),
      ref('device', 'Device', 'cmn_notif_device', { cascade: 'clear' }),
      bool('active', 'Subscribed', { defaultValue: 'true' }),
      { name: 'filter_condition', label: 'Filter', type: 'conditions', maxLength: 4000 },
      bool('digest', 'Digest', { defaultValue: 'false' }),
      ref('digest_interval', 'Digest interval', 'sys_email_digest_interval', {
        referenceQual: 'active=true',
      }),
    ],
    indexes: [['user', 'notification']],
  },
  {
    name: 'sys_email_digest_part',
    label: 'Email Digest Part',
    system: true,
    columns: [
      ref('notification', 'Notification', 'sysevent_email_action', { cascade: 'delete' }),
      { name: 'target_table', label: 'Target table', type: 'table_name' },
      { name: 'instance', label: 'Target', type: 'document_id', dependentOn: 'target_table' },
      str('subject', 'Subject', { maxLength: 160 }),
      { name: 'body', label: 'Body', type: 'html' },
      { name: 'body_text', label: 'Body text', type: 'multi_two_lines' },
    ],
  },
  {
    name: 'sys_email_digest_part_user',
    label: 'Email Digest Part User',
    system: true,
    columns: [
      ref('digest_part', 'Digest part', 'sys_email_digest_part', { cascade: 'delete' }),
      ref('user', 'User', 'sys_user', { cascade: 'delete' }),
      str('digest_key', 'Digest key', { maxLength: 100, indexed: true }),
      dt('send_after', 'Send after'),
      bool('sent', 'Sent', { defaultValue: 'false' }),
    ],
  },
  {
    name: 'resolvr_email_preview',
    label: 'Notification Preview',
    displayField: 'subject',
    columns: [
      ref('notification', 'Notification', 'sysevent_email_action', { readOnly: true, cascade: 'delete' }),
      { name: 'target_table', label: 'Target table', type: 'table_name', readOnly: true },
      { name: 'instance', label: 'Target', type: 'document_id', dependentOn: 'target_table', readOnly: true },
      str('subject', 'Subject', { maxLength: 160, readOnly: true }),
      { name: 'recipients', label: 'Would be sent to', type: 'multi_two_lines', readOnly: true },
      { name: 'excluded', label: 'Excluded recipients', type: 'multi_two_lines', readOnly: true },
      { name: 'body', label: 'Body', type: 'html', readOnly: true },
      { name: 'body_text', label: 'Body text', type: 'multi_two_lines', readOnly: true },
    ],
  },
];
