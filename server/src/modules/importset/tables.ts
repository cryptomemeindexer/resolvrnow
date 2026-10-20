import type { ChoiceDef, ColumnDef, TableDef } from '../../engine/types.js';

const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  ...extra,
});
const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const bool = (name: string, label: string, def: boolean): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: def ? 'true' : 'false',
});
const choices = (...pairs: [string, string][]): ChoiceDef[] =>
  pairs.map(([value, label], i) => ({ value, label, sequence: i + 1 }));

export const IMPORT_SET_STATES = choices(
  ['loading', 'Loading'],
  ['loaded', 'Loaded'],
  ['processed', 'Processed'],
  ['cancelled', 'Cancelled'],
);

export const ROW_STATES = choices(
  ['pending', 'Pending'],
  ['inserted', 'Inserted'],
  ['updated', 'Updated'],
  ['ignored', 'Ignored'],
  ['skipped', 'Skipped'],
  ['error', 'Error'],
);

/**
 * Import sets: staging tables extend `sys_import_set_row`; rows are loaded into an import set
 * and moved into target tables by transform maps (field maps with coalesce keys).
 */
export const importSetTables: TableDef[] = [
  {
    name: 'sys_import_set',
    label: 'Import Set',
    displayField: 'number',
    number: { prefix: 'ISET', start: 10000 },
    columns: [
      str('number', 'Number', { maxLength: 40, readOnly: true }),
      { name: 'table_name', label: 'Import set table', type: 'table_name' },
      str('short_description', 'Short description', { maxLength: 160 }),
      str('state', 'State', { choices: IMPORT_SET_STATES, defaultValue: 'loading' }),
      str('mode', 'Mode', {
        choices: choices(['synchronous', 'Synchronous'], ['asynchronous', 'Asynchronous']),
        defaultValue: 'asynchronous',
      }),
      ref('multi_import_set', 'Multiple import set', 'sys_multi_import_set'),
      ref('run_after', 'Run after', 'sys_import_set'),
      { name: 'row_count', label: 'Rows', type: 'integer', defaultValue: '0' },
      { name: 'load_completed', label: 'Load completed', type: 'glide_date_time' },
      { name: 'processed', label: 'Transform completed', type: 'glide_date_time' },
    ],
  },
  {
    name: 'sys_multi_import_set',
    label: 'Multiple Import Set',
    displayField: 'number',
    number: { prefix: 'MISET', start: 10000 },
    columns: [
      str('number', 'Number', { maxLength: 40, readOnly: true }),
      str('state', 'State', { choices: IMPORT_SET_STATES, defaultValue: 'loading' }),
      str('short_description', 'Short description', { maxLength: 160 }),
    ],
  },
  {
    name: 'sys_import_set_row',
    label: 'Import Set Row',
    extensible: true,
    displayField: 'sys_import_row',
    columns: [
      ref('sys_import_set', 'Set', 'sys_import_set', { cascade: 'delete' }),
      { name: 'sys_import_row', label: 'Row', type: 'integer' },
      str('sys_import_state', 'State', { choices: ROW_STATES, defaultValue: 'pending' }),
      str('sys_import_state_comment', 'Comment', { maxLength: 4000 }),
      { name: 'sys_target_table', label: 'Target table', type: 'table_name' },
      {
        name: 'sys_target_sys_id',
        label: 'Target record',
        type: 'document_id',
        dependentOn: 'sys_target_table',
      },
      ref('sys_transform_map', 'Transform map', 'sys_transform_map'),
      str('sys_row_error', 'Row error', { maxLength: 4000 }),
      {
        name: 'resolvr_transform_results',
        label: 'Transform results',
        type: 'json',
        internal: true,
        readOnly: true,
      },
    ],
  },
  {
    name: 'sys_transform_map',
    label: 'Table Transform Map',
    displayField: 'name',
    columns: [
      str('name', 'Name', { mandatory: true }),
      { name: 'source_table', label: 'Source table', type: 'table_name', mandatory: true, indexed: true },
      { name: 'target_table', label: 'Target table', type: 'table_name', mandatory: true },
      bool('active', 'Active', true),
      { name: 'order', label: 'Order', type: 'integer', defaultValue: '100' },
      bool('run_business_rules', 'Run business rules', true),
      bool('copy_empty_fields', 'Copy empty fields', false),
      str('enforce_mandatory_fields', 'Enforce mandatory fields', {
        choices: choices(
          ['no', 'No'],
          ['onlyMappedFields', 'Only mapped fields'],
          ['allFields', 'All fields'],
        ),
        defaultValue: 'no',
      }),
      str('description', 'Description', { maxLength: 1000 }),
    ],
  },
  {
    name: 'sys_transform_entry',
    label: 'Field Map',
    displayField: 'target_field',
    columns: [
      ref('map', 'Transform map', 'sys_transform_map', { mandatory: true, cascade: 'delete' }),
      str('source_field', 'Source field'),
      str('target_field', 'Target field', { mandatory: true }),
      bool('coalesce', 'Coalesce', false),
      str('choice_action', 'Choice action', {
        choices: choices(['create', 'Create'], ['reject', 'Reject'], ['ignore', 'Ignore']),
        defaultValue: 'create',
      }),
      str('reference_value_field', 'Referenced value field name'),
    ],
  },
  {
    name: 'sys_rest_insert_multiple',
    label: 'REST Insert Multiple',
    displayField: 'source_table',
    columns: [
      { name: 'source_table', label: 'Source table', type: 'table_name', mandatory: true },
      str('column_mapping', 'Column mapping', {
        choices: choices(['label', 'Column label'], ['name', 'Column name']),
        defaultValue: 'label',
      }),
      str('transform', 'Transform', {
        choices: choices(['asynchronous', 'Asynchronous'], ['synchronous', 'Synchronous']),
        defaultValue: 'asynchronous',
      }),
      bool('active', 'Active', true),
    ],
  },
];
