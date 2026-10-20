import type { ChoiceDef, ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';

export const FLOW_TABLE = 'sys_hub_flow';
export const FLOW_ROOT = 'sys_hub_flow_block';
export const CONTEXT_TABLE = 'sys_flow_context';
export const SNAPSHOT_TABLE = 'resolvr_flow_snapshot';
export const LOG_TABLE = 'resolvr_flow_log';

/** Tables the flow engine writes itself; record triggers never fire on them. */
export const INTERNAL_ROOTS: ReadonlySet<string> = new Set([
  FLOW_ROOT,
  CONTEXT_TABLE,
  SNAPSHOT_TABLE,
  LOG_TABLE,
  'syslog',
]);

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const CONTEXT_STATES: ChoiceDef[] = [
  c('QUEUED', 'Queued', 10),
  c('IN_PROGRESS', 'In Progress', 20),
  c('WAITING', 'Waiting', 30),
  c('COMPLETE', 'Complete', 40),
  c('CANCELLED', 'Cancelled', 50),
  c('ERROR', 'Error', 60),
];

const LOG_STATES: ChoiceDef[] = [
  c('complete', 'Complete', 10),
  c('waiting', 'Waiting', 20),
  c('resumed', 'Resumed', 30),
  c('branch', 'Branch', 40),
  c('error', 'Error', 50),
  c('info', 'Information', 60),
];

const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  ...extra,
});
const json = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'json',
  ...extra,
});
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});
const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});

export const flowTables: TableDef[] = [
  sdkTable('sys_hub_flow_block', { displayField: 'name', exclude: ['label_cache'] }),
  sdkTable('sys_hub_flow_base', {
    displayField: 'name',
    exclude: [
      'access',
      'acls',
      'allow_high_security_roles',
      'annotation',
      'authored_on_release_version',
      'copied_from',
      'copied_from_name',
      'natlang',
      'remote_trigger_id',
      'sc_callable',
      'flow_priority',
      'outputs',
    ],
    patch: {
      status: {
        choices: [c('draft', 'Draft', 10), c('published', 'Published', 20)],
        choiceMode: 'dropdown_without_none',
      },
      type: {
        choices: [c('flow', 'Flow', 10), c('subflow', 'Subflow', 20)],
        choiceMode: 'dropdown_without_none',
      },
      run_as: {
        defaultValue: 'system',
        choices: [c('user', 'User who initiates session', 10), c('system', 'System user', 20)],
        choiceMode: 'dropdown_without_none',
      },
      run_with_roles: { readOnly: false, reference: 'sys_user_role' },
      internal_name: { indexed: true, maxLength: 255 },
      category: { reference: 'sys_hub_category' },
    },
  }),
  sdkTable('sys_hub_flow', {
    label: 'Flow',
    displayField: 'name',
    exclude: [
      'compiler_build',
      'display_name_after_preview',
      'generation_source',
      'master_snapshot_digest',
      'pre_compiled',
      'show_draft_actions',
      'show_triggered_flows',
      'updation_source',
      'version_record',
      'substatus',
    ],
    patch: {
      latest_snapshot: { type: 'reference', reference: SNAPSHOT_TABLE, readOnly: true, maxLength: undefined },
      master_snapshot: { type: 'reference', reference: SNAPSHOT_TABLE, readOnly: true, maxLength: undefined },
    },
    columns: [
      json('resolvr_definition', 'Definition', {
        hint: 'Flow definition (JSON, schema resolvr.flow/v1)',
        maxLength: 200000,
      }),
      {
        name: 'resolvr_trigger_table',
        label: 'Trigger table',
        type: 'table_name',
        readOnly: true,
        maxLength: 80,
      },
      str('resolvr_trigger_type', 'Trigger', {
        readOnly: true,
        maxLength: 40,
        choices: [c('record', 'Record', 10), c('scheduled', 'Scheduled', 20), c('api', 'Manual or API', 30)],
      }),
      dt('resolvr_next_run', 'Next scheduled run', { readOnly: true, indexed: true }),
    ],
  }),
  sdkTable('sys_flow_context', {
    label: 'Flow Execution',
    plural: 'Flow Executions',
    displayField: 'name',
    exclude: [
      'flow_catalog_model',
      'stages',
      'sys_lock_acquired',
      'sys_lock_owner',
      'sys_lock_touched',
      'signatures',
      'separate_reporting_values',
      'skip_schedule_cleanup',
      'engine_major_version',
      'engine_version',
      'design_source',
      'application',
      'origins',
      'transaction',
      'claimed_by',
    ],
    patch: {
      flow: { type: 'reference', reference: FLOW_TABLE, maxLength: undefined, indexed: true },
      snapshot: { type: 'reference', reference: SNAPSHOT_TABLE, maxLength: undefined },
      state: {
        type: 'string',
        maxLength: 40,
        choices: CONTEXT_STATES,
        defaultValue: 'QUEUED',
        indexed: true,
      },
      error_state: { type: 'string', maxLength: 40 },
      source_record: { indexed: true },
      error_message: { maxLength: 4000 },
    },
    columns: [
      str('resolvr_wait_on', 'Waiting on', { readOnly: true, indexed: true, maxLength: 80, internal: true }),
      dt('resolvr_wake_at', 'Resume at', { readOnly: true, indexed: true }),
      ref('resolvr_parent', 'Parent execution', CONTEXT_TABLE, { readOnly: true }),
      dt('resolvr_started', 'Started', { readOnly: true }),
      dt('resolvr_ended', 'Ended', { readOnly: true }),
    ],
  }),
  {
    name: SNAPSHOT_TABLE,
    label: 'Flow Snapshot',
    plural: 'Flow Snapshots',
    displayField: 'version',
    description:
      'Published, immutable copy of a flow definition; executions keep the snapshot they started with.',
    columns: [
      ref('flow', 'Flow', FLOW_TABLE, { cascade: 'delete' }),
      { name: 'version', label: 'Version', type: 'integer' },
      json('definition', 'Definition', { maxLength: 200000 }),
    ],
  },
  {
    name: LOG_TABLE,
    label: 'Flow Step Log',
    plural: 'Flow Step Logs',
    displayField: 'step_id',
    description: 'Per-step execution log of a flow context (status, timings, inputs, outputs, errors).',
    columns: [
      ref('context', 'Execution', CONTEXT_TABLE, { cascade: 'delete' }),
      ref('flow', 'Flow', FLOW_TABLE),
      { name: 'sequence', label: 'Sequence', type: 'integer' },
      str('step_id', 'Step', { maxLength: 100 }),
      str('step_type', 'Step type', { maxLength: 40 }),
      str('action', 'Action', { maxLength: 100 }),
      str('label', 'Label', { maxLength: 255 }),
      str('state', 'State', { maxLength: 40, choices: LOG_STATES }),
      str('level', 'Level', { maxLength: 20 }),
      str('message', 'Message', { maxLength: 4000 }),
      json('inputs', 'Inputs', { maxLength: 20000 }),
      json('outputs', 'Outputs', { maxLength: 20000 }),
      dt('started', 'Started'),
      dt('ended', 'Ended'),
      { name: 'duration_ms', label: 'Duration (ms)', type: 'integer' },
      { name: 'iteration', label: 'Iteration', type: 'integer' },
    ],
  },
];
