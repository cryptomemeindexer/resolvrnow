import type { ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';

const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, label, type: 'string', ...extra });
const bool = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, label, type: 'integer', ...extra });
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});

export const platformTables: TableDef[] = [
  sdkTable('sys_user', {
    displayField: 'name',
    audit: true,
    textIndex: ['name', 'user_name', 'email', 'title'],
    exclude: ['ldap_server', 'default_perspective', 'hashed_user_id', 'manager_hp1', 'edu_status', 'last_password'],
    patch: {
      user_name: { mandatory: true, unique: true, indexed: true, maxLength: 40 },
      email: { indexed: true },
      user_password: { type: 'password2', noAudit: true, label: 'Password' },
      roles: { readOnly: true },
      accumulated_roles: { readOnly: true, internal: true },
      name: { readOnly: true },
    },
    columns: [str('mfa_secret', 'MFA secret', { internal: true, noAudit: true })],
  }),
  sdkTable('sys_user_group', {
    displayField: 'name',
    audit: true,
    exclude: ['parent_hp1'],
    patch: { name: { mandatory: true, indexed: true }, type: { reference: 'sys_user_group_type' } },
    textIndex: ['name', 'description'],
  }),
  {
    name: 'sys_user_group_type',
    label: 'Group Type',
    displayField: 'name',
    columns: [str('name', 'Name', { mandatory: true }), str('description', 'Description', { maxLength: 1000 })],
  },
  {
    name: 'sys_user_grmember',
    label: 'Group Member',
    displayField: 'user',
    audit: true,
    columns: [
      ref('user', 'User', 'sys_user', { mandatory: true, cascade: 'delete' }),
      ref('group', 'Group', 'sys_user_group', { mandatory: true, cascade: 'delete' }),
    ],
    indexes: [['user', 'group']],
  },
  sdkTable('sys_user_role', {
    displayField: 'name',
    patch: { name: { mandatory: true, unique: true, indexed: true } },
  }),
  sdkTable('sys_user_role_contains', {
    displayField: 'role',
    patch: { role: { cascade: 'delete' }, contains: { cascade: 'delete' } },
  }),
  {
    name: 'sys_user_has_role',
    label: 'User Role',
    displayField: 'role',
    audit: true,
    columns: [
      ref('user', 'User', 'sys_user', { mandatory: true, cascade: 'delete' }),
      ref('role', 'Role', 'sys_user_role', { mandatory: true, cascade: 'delete' }),
      bool('inherited', 'Inherited', { readOnly: true, defaultValue: 'false' }),
      ref('granted_by', 'Granted by', 'sys_user_group'),
      str('state', 'State', {
        defaultValue: 'active',
        choices: [
          { value: 'active', label: 'Active' },
          { value: 'requested', label: 'Requested' },
          { value: 'pending', label: 'Pending' },
        ],
      }),
    ],
  },
  {
    name: 'sys_group_has_role',
    label: 'Group Role',
    displayField: 'role',
    audit: true,
    columns: [
      ref('group', 'Group', 'sys_user_group', { mandatory: true, cascade: 'delete' }),
      ref('role', 'Role', 'sys_user_role', { mandatory: true, cascade: 'delete' }),
      bool('inherits', 'Inherits', { defaultValue: 'true' }),
    ],
  },
  {
    name: 'sys_user_delegate',
    label: 'Delegate',
    columns: [
      ref('user', 'User', 'sys_user', { mandatory: true }),
      ref('delegate', 'Delegate', 'sys_user', { mandatory: true }),
      dt('starts', 'Starts'),
      dt('ends', 'Ends'),
      bool('approvals', 'Approvals', { defaultValue: 'true' }),
      bool('assignments', 'Assignments', { defaultValue: 'true' }),
      bool('notifications', 'Notifications', { defaultValue: 'true' }),
      bool('invitations', 'Meeting invitations', { defaultValue: 'true' }),
    ],
  },
  sdkTable('sys_user_preference', { displayField: 'name' }),
  {
    name: 'sys_api_token',
    label: 'API Token',
    displayField: 'name',
    columns: [
      str('name', 'Name', { mandatory: true }),
      ref('user', 'User', 'sys_user', { mandatory: true, cascade: 'delete' }),
      str('token_hash', 'Token hash', { internal: true, noAudit: true }),
      str('token_prefix', 'Prefix', { readOnly: true }),
      dt('expires', 'Expires'),
      dt('last_used', 'Last used', { readOnly: true }),
      bool('active', 'Active', { defaultValue: 'true' }),
    ],
  },
  {
    name: 'sys_user_session',
    label: 'User Session',
    system: true,
    columns: [
      ref('user', 'User', 'sys_user', { cascade: 'delete' }),
      str('token_hash', 'Token hash', { internal: true, noAudit: true, indexed: true }),
      str('csrf_token', 'CSRF token', { internal: true, noAudit: true }),
      dt('expires', 'Expires'),
      dt('last_seen', 'Last seen'),
      str('ip_address', 'IP address'),
      str('user_agent', 'User agent', { maxLength: 500 }),
    ],
  },
  sdkTable('core_company', {
    displayField: 'name',
    exclude: ['theme', 'apple_icon', 'banner_image', 'banner_image_light', 'banner_text', 'vendor_type'],
    textIndex: ['name'],
  }),
  sdkTable('cmn_location', {
    displayField: 'name',
    exclude: ['life_cycle_stage', 'life_cycle_stage_status', 'phone_territory', 'parent_hp1'],
    textIndex: ['name', 'full_name', 'city'],
  }),
  sdkTable('cmn_department', { displayField: 'name', exclude: ['business_unit', 'parent_hp1'] }),
  sdkTable('cmn_cost_center', { displayField: 'name' }),
  sdkTable('cmn_building', { displayField: 'name' }),
  // Dictionary mirror
  sdkTable('sys_db_object', {
    displayField: 'name',
    patch: { super_class: { reference: 'sys_db_object' } },
    columns: [str('module', 'Module', { readOnly: true }), bool('custom', 'Custom', { defaultValue: 'false' })],
  }),
  sdkTable('sys_dictionary', {
    displayField: 'element',
    patch: {
      internal_type: { type: 'string', reference: undefined },
      reference: { type: 'table_name', reference: undefined },
      name: { indexed: true },
    },
    exclude: ['calculation'],
    columns: [bool('custom', 'Custom', { defaultValue: 'false' })],
  }),
  {
    name: 'sys_choice',
    label: 'Choice',
    displayField: 'label',
    columns: [
      { name: 'name', label: 'Table', type: 'table_name', mandatory: true, indexed: true },
      str('element', 'Element', { mandatory: true }),
      str('value', 'Value', { maxLength: 100 }),
      str('label', 'Label', { maxLength: 255 }),
      int('sequence', 'Sequence'),
      str('dependent_value', 'Dependent value'),
      bool('inactive', 'Inactive', { defaultValue: 'false' }),
      str('language', 'Language', { defaultValue: 'en', maxLength: 40 }),
      str('hint', 'Hint', { maxLength: 255 }),
    ],
    indexes: [['name', 'element']],
  },
  sdkTable('sys_number', {
    displayField: 'prefix',
    patch: { category: { type: 'table_name', reference: undefined } },
  }),
  sdkTable('sys_journal_field', {
    displayField: 'element',
    patch: { element_id: { indexed: true } },
  }),
  {
    name: 'sys_audit',
    label: 'Audit',
    system: true,
    columns: [
      { name: 'tablename', label: 'Table', type: 'table_name', indexed: true },
      str('documentkey', 'Document key', { indexed: true }),
      str('fieldname', 'Field name'),
      { name: 'oldvalue', label: 'Old value', type: 'string', maxLength: 8000 },
      { name: 'newvalue', label: 'New value', type: 'string', maxLength: 8000 },
      str('user', 'User'),
      str('reason', 'Reason'),
      int('record_checkpoint', 'Record update count'),
      int('internal_checkpoint', 'Internal checkpoint'),
    ],
  },
  {
    name: 'sys_audit_delete',
    label: 'Deleted Records',
    system: true,
    columns: [
      { name: 'tablename', label: 'Table', type: 'table_name' },
      str('documentkey', 'Document key', { indexed: true }),
      str('display_value', 'Display value'),
      { name: 'payload', label: 'Payload', type: 'json' },
    ],
  },
  sdkTable('sys_properties', {
    displayField: 'name',
    patch: { name: { unique: true, indexed: true } },
  }),
  sdkTable('sys_attachment', {
    displayField: 'file_name',
    patch: { table_sys_id: { indexed: true } },
    columns: [str('storage_path', 'Storage path', { internal: true })],
  }),
  {
    name: 'sysevent',
    label: 'Event',
    system: true,
    displayField: 'name',
    columns: [
      str('name', 'Name', { indexed: true }),
      str('instance', 'Instance'),
      { name: 'table', label: 'Table', type: 'table_name' },
      { name: 'parm1', label: 'Parm1', type: 'string', maxLength: 4000 },
      { name: 'parm2', label: 'Parm2', type: 'string', maxLength: 4000 },
      str('state', 'State', {
        indexed: true,
        choices: [
          { value: 'ready', label: 'Ready' },
          { value: 'processing', label: 'Processing' },
          { value: 'processed', label: 'Processed' },
          { value: 'error', label: 'Error' },
        ],
      }),
      dt('process_on', 'Process on'),
      dt('processed', 'Processed'),
      str('queue', 'Queue'),
      str('user_id', 'User ID'),
      str('user_name', 'User name'),
    ],
  },
  sdkTable('sysevent_register', { displayField: 'event_name' }),
  {
    name: 'syslog',
    label: 'System Log',
    system: true,
    columns: [
      str('level', 'Level', {
        choices: [
          { value: 'info', label: 'Information' },
          { value: 'warn', label: 'Warning' },
          { value: 'error', label: 'Error' },
          { value: 'debug', label: 'Debug' },
        ],
      }),
      str('source', 'Source'),
      { name: 'message', label: 'Message', type: 'string', maxLength: 4000 },
    ],
  },
  sdkTable('sys_filter_option_dynamic', { displayField: 'label' }),
  // Access control
  sdkTable('sys_security_acl', {
    displayField: 'name',
    exclude: ['security_attribute', 'controlled_by_refs', 'applies_to', 'local_or_existing'],
    patch: {
      operation: {
        type: 'string',
        reference: undefined,
        defaultValue: 'read',
        choices: ['read', 'write', 'create', 'delete', 'report_view', 'execute'].map((v) => ({ value: v, label: v })),
      },
      type: {
        type: 'string',
        reference: undefined,
        defaultValue: 'record',
        choices: [
          { value: 'record', label: 'record' },
          { value: 'rest_endpoint', label: 'REST_Endpoint' },
          { value: 'ui_page', label: 'ui_page' },
        ],
      },
      name: { indexed: true },
    },
    columns: [str('native_id', 'Native ID', { readOnly: true, internal: true })],
  }),
  {
    name: 'sys_security_acl_role',
    label: 'Access Role',
    columns: [
      ref('sys_security_acl', 'Access control', 'sys_security_acl', { mandatory: true, cascade: 'delete' }),
      ref('sys_user_role', 'Role', 'sys_user_role', { mandatory: true, cascade: 'delete' }),
    ],
  },
  // Business rules and UI actions (native rules are mirrored here so they can be inspected and deactivated)
  sdkTable('sys_script', {
    label: 'Business Rule',
    displayField: 'name',
    exclude: ['rest_method', 'rest_service', 'rest_method_text', 'rest_service_text', 'rest_variables', 'is_rest', 'access', 'client_callable', 'priority'],
    patch: {
      when: {
        choices: [
          { value: 'before', label: 'before' },
          { value: 'after', label: 'after' },
          { value: 'async', label: 'async' },
          { value: 'display', label: 'display' },
        ],
        defaultValue: 'before',
      },
    },
    columns: [str('native_id', 'Native ID', { readOnly: true, internal: true }), str('module', 'Module', { readOnly: true })],
  }),
  sdkTable('sys_ui_action', {
    label: 'UI Action',
    displayField: 'name',
    include: ['action_name', 'active', 'client', 'comments', 'condition', 'form_button', 'form_link', 'form_context_menu', 'hint', 'list_button', 'list_choice', 'name', 'order', 'script', 'show_insert', 'show_update', 'table'],
    columns: [str('native_id', 'Native ID', { readOnly: true, internal: true }), str('module', 'Module', { readOnly: true })],
  }),
  {
    name: 'sys_script_include',
    label: 'Script Include',
    displayField: 'name',
    columns: [
      str('name', 'Name', { mandatory: true }),
      str('api_name', 'API name'),
      { name: 'script', label: 'Script', type: 'script', maxLength: 100000 },
      bool('active', 'Active', { defaultValue: 'true' }),
      bool('client_callable', 'Client callable', { defaultValue: 'false' }),
      str('description', 'Description', { maxLength: 4000 }),
    ],
  },
  {
    name: 'sysauto_script',
    label: 'Scheduled Script Execution',
    displayField: 'name',
    columns: [
      str('name', 'Name', { mandatory: true }),
      bool('active', 'Active', { defaultValue: 'true' }),
      { name: 'run_period', label: 'Repeat interval', type: 'glide_duration' },
      dt('run_start', 'Starting'),
      dt('last_run', 'Last run', { readOnly: true }),
      { name: 'script', label: 'Run this script', type: 'script', maxLength: 100000 },
      ref('run_as', 'Run as', 'sys_user'),
    ],
  },
];
