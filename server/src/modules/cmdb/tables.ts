import type { ColumnDef, TableDef } from '../../engine/types.js';
import { sdkColumn, sdkColumnNames, sdkTable } from '../../schema/sdk.js';
import {
  ASSET_TRACKING_STRATEGY,
  BUSINESS_CRITICALITY,
  CI_INSTALL_STATUS,
  CI_OPERATIONAL_STATUS,
  CONNECTION_STRENGTH,
  DISCOVERY_SOURCES,
  HEALTH_METRIC,
  HEALTH_STATE,
  MODEL_STATUS,
  ORPHAN_OPERATOR,
  RECLASSIFICATION_TYPE,
  SERIAL_NUMBER_TYPE,
  SERVICE_CLASSIFICATION,
  USED_FOR,
} from './choices.js';
import { ciClasses } from './classes.js';
import {
  bool,
  choice,
  cls,
  col,
  cond,
  dt,
  int,
  ref,
  str,
  strChoice,
  tableName,
  withoutScripts,
} from './columns.js';

const DAY_MS = 86_400_000;

/** The SDK's `cmdb` labels are partly lower-case column names; reuse the `cmdb_ci` wording. */
function cmdbLabels(): Record<string, Partial<ColumnDef>> {
  const out: Record<string, Partial<ColumnDef>> = {};
  for (const name of sdkColumnNames('cmdb')) {
    const own = sdkColumn('cmdb', name);
    const better = sdkColumn('cmdb_ci', name);
    if (own && better && own.label !== better.label && own.label === own.label.toLowerCase())
      out[name] = { label: better.label };
  }
  return out;
}

const merge = (...patches: Record<string, Partial<ColumnDef>>[]) => {
  const out: Record<string, Partial<ColumnDef>> = {};
  for (const p of patches) for (const [k, v] of Object.entries(p)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
};

const baseTables: TableDef[] = [
  withoutScripts(
    sdkTable('cmdb', {
      displayField: 'name',
      audit: true,
      extensible: true,
      textIndex: ['name', 'serial_number', 'asset_tag'],
      exclude: ['sys_class_path'],
      columns: [str('sys_class_path', 'Class path', 100, { readOnly: true, internal: true, noAudit: true })],
      patch: merge(cmdbLabels(), {
        name: { indexed: true },
        serial_number: { indexed: true },
        install_status: { choices: CI_INSTALL_STATUS, defaultValue: '1', label: 'Status' },
        asset: { cascade: 'clear' },
        model_id: { cascade: 'restrict', label: 'Model ID' },
        company: { referenceQual: undefined },
      }),
    }),
  ),
  withoutScripts(
    sdkTable('cmdb_ci', {
      audit: true,
      extensible: true,
      textIndex: ['name', 'short_description', 'ip_address', 'fqdn'],
      exclude: sdkColumnNames('cmdb'),
      patch: {
        operational_status: {
          choices: CI_OPERATIONAL_STATUS,
          defaultValue: '1',
          label: 'Operational status',
        },
        discovery_source: { choices: DISCOVERY_SOURCES, maxLength: 40 },
        environment: { choices: USED_FOR },
        duplicate_of: { readOnly: true },
        ip_address: { indexed: true },
        mac_address: { indexed: true },
        fqdn: { indexed: true },
        first_discovered: { readOnly: true },
        life_cycle_stage_status: { dependentOn: undefined },
      },
    }),
  ),
  withoutScripts(
    sdkTable('cmdb_ci_service', {
      audit: true,
      extensible: true,
      exclude: sdkColumnNames('cmdb_ci'),
      patch: {
        number: { readOnly: true, indexed: true },
        service_classification: { choices: SERVICE_CLASSIFICATION },
        busines_criticality: { choices: BUSINESS_CRITICALITY, label: 'Business criticality' },
        used_for: { choices: USED_FOR },
        service_status: { dependentOn: undefined },
      },
    }),
  ),
  withoutScripts(
    sdkTable('service_offering', {
      audit: true,
      exclude: sdkColumnNames('cmdb_ci_service'),
      patch: { contract: { referenceQual: undefined } },
    }),
  ),
  withoutScripts(
    sdkTable('cmdb_ci_business_app', {
      audit: true,
      exclude: sdkColumnNames('cmdb_ci'),
      patch: {
        number: { readOnly: true, indexed: true },
        platform_host: { referenceQual: 'architecture_type=platform_host' },
      },
    }),
  ),
  withoutScripts(
    sdkTable('cmdb_model', {
      displayField: 'display_name',
      audit: true,
      extensible: true,
      textIndex: ['name', 'display_name', 'model_number'],
      patch: {
        asset_tracking_strategy: { choices: ASSET_TRACKING_STRATEGY, maxLength: 40 },
        status: { choices: MODEL_STATUS },
        cmdb_ci_class: {
          type: 'table_name',
          hint: 'CI class created for assets of this model (overrides the category)',
        },
        display_name: { readOnly: true },
        name: { mandatory: true },
      },
    }),
  ),
  cls('cmdb_hardware_product_model', 'Hardware Model', 'cmdb_model'),
  cls('cmdb_consumable_product_model', 'Consumable Model', 'cmdb_model'),
  cls('cmdb_facility_product_model', 'Facility Model', 'cmdb_model'),
  cls('cmdb_contract_product_model', 'Contract Model', 'cmdb_model'),
  cls('cmdb_software_product_model', 'Software Model', 'cmdb_model'),
  cls('cmdb_application_product_model', 'Application Model', 'cmdb_model'),
  cls('cmdb_service_product_model', 'Service Model', 'cmdb_model'),
];

const relationshipTables: TableDef[] = [
  {
    name: 'cmdb_rel_type',
    label: 'CI Relationship Type',
    displayField: 'name',
    columns: [
      str('name', 'Name', 255, { mandatory: true, indexed: true }),
      str('parent_descriptor', 'Parent descriptor', 100, { mandatory: true }),
      str('child_descriptor', 'Child descriptor', 100, { mandatory: true }),
    ],
  },
  {
    name: 'cmdb_rel_ci',
    label: 'CI Relationship',
    plural: 'CI Relationships',
    displayField: 'parent',
    audit: true,
    columns: [
      ref('parent', 'Parent', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      ref('type', 'Type', 'cmdb_rel_type', { mandatory: true, cascade: 'restrict' }),
      ref('child', 'Child', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      str('port', 'Port', 40),
      strChoice('connection_strength', 'Connection strength', CONNECTION_STRENGTH),
    ],
    indexes: [['parent', 'child', 'type', 'port']],
  },
  {
    name: 'cmdb_rel_type_suggest',
    label: 'Suggested Relationship',
    displayField: 'base_class',
    columns: [
      tableName('base_class', 'Base class', { mandatory: true }),
      ref('cmdb_rel_type', 'Relationship type', 'cmdb_rel_type', { mandatory: true, cascade: 'delete' }),
      tableName('dependent_class', 'Dependent class', { mandatory: true }),
      bool('parent', 'Base class is parent', true),
    ],
  },
  {
    name: 'cmdb_metadata_hosting',
    label: 'CMDB Metadata Hosting Rules',
    displayField: 'parent_type',
    columns: [
      tableName('parent_type', 'Hosted class', { mandatory: true }),
      ref('rel_type', 'Relationship type', 'cmdb_rel_type', { mandatory: true, cascade: 'delete' }),
      tableName('child_type', 'Host class', { mandatory: true }),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'cmdb_metadata_containment',
    label: 'CMDB Metadata Containment Rules',
    displayField: 'parent_type',
    columns: [
      tableName('parent_type', 'Container class', { mandatory: true }),
      ref('rel_type', 'Relationship type', 'cmdb_rel_type', { mandatory: true, cascade: 'delete' }),
      tableName('child_type', 'Contained class', { mandatory: true }),
      bool('active', 'Active', true),
      tableName('root_type', 'Containment root'),
    ],
  },
  {
    name: 'cmdb_rel_person',
    label: 'CI Relationship to User',
    displayField: 'ci',
    columns: [
      ref('ci', 'Configuration item', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      ref('user', 'User', 'sys_user', { mandatory: true, cascade: 'delete' }),
      ref('type', 'Type', 'cmdb_rel_type', { mandatory: true }),
    ],
  },
  {
    name: 'cmdb_rel_group',
    label: 'CI Relationship to Group',
    displayField: 'ci',
    columns: [
      ref('ci', 'Configuration item', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      ref('group', 'Group', 'sys_user_group', { mandatory: true, cascade: 'delete' }),
      ref('type', 'Type', 'cmdb_rel_type', { mandatory: true }),
    ],
  },
  {
    name: 'sys_rel_source',
    label: 'Relationship Source',
    displayField: 'source',
    columns: [
      ref('rel', 'Relationship', 'cmdb_rel_ci', { cascade: 'delete' }),
      str('source', 'Source', 100),
      dt('last_scan', 'Last scan'),
    ],
  },
];

const ireTables: TableDef[] = [
  {
    name: 'cmdb_identifier',
    label: 'CI Identifier',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('description', 'Description', 1000),
      tableName('applies_to', 'Applies to', { mandatory: true, indexed: true }),
      bool('is_independent', 'Independent', true),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'cmdb_identifier_entry',
    label: 'CI Identifier Entry',
    displayField: 'attributes',
    columns: [
      ref('identifier', 'Identifier', 'cmdb_identifier', { mandatory: true, cascade: 'delete' }),
      int('order', 'Order', { defaultValue: '100' }),
      str('attributes', 'Criterion attributes', 1000, { mandatory: true }),
      tableName('table', 'Search on table'),
      str('referenced_field', 'Referenced field', 80),
      bool('allow_null_attribute', 'Allow null attribute'),
      bool('allow_fallback', 'Allow fallback to parent rule'),
      bool('exact_count_match', 'Exact count match'),
      cond('condition', 'Condition'),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'cmdb_related_entry',
    label: 'Related Entry',
    displayField: 'table',
    columns: [
      ref('identifier', 'Identifier', 'cmdb_identifier', { cascade: 'delete' }),
      tableName('table', 'Table', { mandatory: true }),
      str('referenced_field', 'Referenced field', 80, { mandatory: true }),
      str('attributes', 'Attributes', 1000),
      int('order', 'Order', { defaultValue: '100' }),
      bool('allow_null_attribute', 'Allow null attribute'),
      cond('condition', 'Condition'),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'cmdb_reconciliation_definition',
    label: 'Reconciliation Definition',
    displayField: 'discovery_source',
    columns: [
      tableName('applies_to', 'Applies to', { mandatory: true }),
      strChoice('discovery_source', 'Discovery source', DISCOVERY_SOURCES, { mandatory: true }),
      int('priority', 'Priority', { defaultValue: '100' }),
      str('attributes', 'Attributes', 4000, { hint: 'Comma list; empty means all attributes' }),
      str('update_with_null', 'Update with null', 4000),
      cond('filter_condition', 'Filter condition'),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'cmdb_data_refresh_rule',
    label: 'Data Refresh Rule',
    displayField: 'discovery_source',
    columns: [
      tableName('applies_to', 'Applies to', { mandatory: true }),
      strChoice('discovery_source', 'Discovery source', DISCOVERY_SOURCES, { mandatory: true }),
      col('effective_duration', 'Effective duration', 'glide_duration', { defaultValue: 0 }),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'cmdb_datasource_last_update',
    label: 'Data Source Last Update',
    displayField: 'source',
    columns: [
      ref('ci', 'Configuration item', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      str('source', 'Source', 100, { mandatory: true }),
      dt('last_updated', 'Last updated'),
    ],
    indexes: [['ci', 'source']],
  },
  {
    name: 'sys_object_source',
    label: 'Source',
    displayField: 'name',
    columns: [
      str('name', 'Source name', 100, { mandatory: true }),
      str('id', 'Native key', 255, { mandatory: true }),
      tableName('target_table', 'Target table'),
      str('target_sys_id', 'Target sys_id', 32, { indexed: true }),
      dt('last_scan', 'Last scan'),
    ],
    indexes: [['name', 'id']],
  },
  {
    name: 'cmdb_serial_number',
    label: 'Serial Number',
    displayField: 'serial_number',
    columns: [
      ref('cmdb_ci', 'Configuration item', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      str('serial_number', 'Serial number', 255, { mandatory: true, indexed: true }),
      strChoice('serial_number_type', 'Serial number type', SERIAL_NUMBER_TYPE),
      bool('valid', 'Valid', true),
      bool('absent', 'Absent'),
    ],
  },
  {
    name: 'cmdb_group',
    label: 'CMDB Group',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('description', 'Description', 1000),
      tableName('table', 'Table', { defaultValue: 'cmdb_ci' }),
      cond('condition', 'Condition'),
    ],
  },
];

const taskLinkTables: TableDef[] = [
  {
    name: 'task_ci',
    label: 'Affected CI',
    plural: 'Affected CIs',
    displayField: 'ci_item',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, cascade: 'delete' }),
      ref('ci_item', 'Configuration item', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
      bool('manual_proposed_change', 'Manual proposed change'),
      bool('applied', 'Applied'),
      dt('applied_date', 'Applied date'),
    ],
    indexes: [['task', 'ci_item']],
  },
  {
    name: 'task_cmdb_ci_service',
    label: 'Impacted Service/CI',
    plural: 'Impacted Services/CIs',
    displayField: 'cmdb_ci_service',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, cascade: 'delete' }),
      ref('cmdb_ci_service', 'Service', 'cmdb_ci_service', { mandatory: true, cascade: 'delete' }),
      bool('manually_added', 'Manually added'),
    ],
    indexes: [['task', 'cmdb_ci_service']],
  },
  {
    name: 'task_service_offering',
    label: 'Service Offering',
    plural: 'Service Offerings',
    displayField: 'service_offering',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, cascade: 'delete' }),
      ref('service_offering', 'Service offering', 'service_offering', { mandatory: true, cascade: 'delete' }),
      bool('manually_added', 'Manually added'),
    ],
    indexes: [['task', 'service_offering']],
  },
  {
    name: 'svc_ci_assoc',
    label: 'Service Configuration Item Association',
    displayField: 'ci_id',
    columns: [
      ref('service_id', 'Service', 'cmdb_ci_service', { mandatory: true, cascade: 'delete' }),
      ref('ci_id', 'Configuration item', 'cmdb_ci', { mandatory: true, cascade: 'delete' }),
    ],
    indexes: [['service_id', 'ci_id']],
  },
  {
    name: 'reconcile_duplicate_task',
    label: 'De-duplication Task',
    extends: 'task',
    number: { prefix: 'DDT', start: 10000 },
    columns: [col('duplicates', 'Duplicate CIs', 'glide_list', { reference: 'cmdb_ci', maxLength: 4000 })],
  },
  {
    name: 'resolvr_reclassification_task',
    label: 'CI Reclassification Task',
    extends: 'task',
    number: { prefix: 'RCT', start: 10000 },
    columns: [
      tableName('current_class', 'Current class'),
      tableName('target_class', 'Requested class'),
      choice('reclassification_type', 'Reclassification type', RECLASSIFICATION_TYPE),
      str('source', 'Discovery source', 40),
    ],
  },
];

const healthTables: TableDef[] = [
  {
    name: 'cmdb_health_inclusion_rule',
    label: 'Health Inclusion Rule',
    displayField: 'applies_to',
    columns: [
      tableName('applies_to', 'Applies to', { mandatory: true }),
      cond('condition', 'Condition'),
      str('metrics', 'Metrics', 255, { hint: 'Comma list of metrics; empty means every metric' }),
    ],
  },
  {
    name: 'cmdb_health_metric_pref',
    label: 'CMDB Health Metric Preference',
    displayField: 'name',
    columns: [
      str('name', 'Name', 40, { mandatory: true }),
      str('parent_kpi', 'Parent KPI', 40),
      col('weight', 'Weight', 'decimal'),
      bool('active', 'Active', true),
      col('failure_threshold', 'Failure threshold', 'decimal'),
    ],
  },
  {
    name: 'cmdb_health_orphan_rule',
    label: 'Orphan Rule',
    displayField: 'applies_to',
    columns: [
      tableName('applies_to', 'Applies to', { mandatory: true }),
      cond('attributes', 'Attribute condition'),
      strChoice('operator', 'Operator', ORPHAN_OPERATOR, { defaultValue: 'and' }),
      ref('relationship_type', 'Missing relationship type', 'cmdb_rel_type'),
      tableName('related_class', 'Missing related class'),
    ],
  },
  {
    name: 'cmdb_health_staleness_rule',
    label: 'Staleness Rule',
    displayField: 'applies_to',
    columns: [
      tableName('applies_to', 'Applies to', { mandatory: true }),
      col('effective_duration', 'Effective duration', 'glide_duration', { defaultValue: 60 * DAY_MS }),
    ],
  },
  {
    name: 'cmdb_health_result',
    label: 'CMDB Health Result',
    displayField: 'metric',
    columns: [
      ref('ci', 'Configuration item', 'cmdb_ci', { cascade: 'delete' }),
      ref('relationship', 'Relationship', 'cmdb_rel_ci', { cascade: 'delete' }),
      strChoice('metric', 'Metric', HEALTH_METRIC, { mandatory: true }),
      strChoice('state', 'State', HEALTH_STATE, { mandatory: true }),
      str('details', 'Details', 4000),
      dt('last_run', 'Last run'),
    ],
  },
  {
    name: 'resolvr_cmdb_recommended_field',
    label: 'Recommended CI Field',
    displayField: 'element',
    columns: [
      tableName('applies_to', 'Applies to', { mandatory: true }),
      str('element', 'Field', 80, { mandatory: true }),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'resolvr_cmdb_compliance_rule',
    label: 'CMDB Compliance Rule',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      tableName('applies_to', 'Applies to', { mandatory: true }),
      cond('condition', 'Compliant when', {
        hint: 'CIs of the class that do not match this condition fail the audit',
      }),
      str('description', 'Description', 1000),
      bool('active', 'Active', true),
    ],
  },
];

const lifeCycleTables: TableDef[] = [
  {
    name: 'life_cycle_stage',
    label: 'Life Cycle Stage',
    displayField: 'name',
    columns: [str('name', 'Name', 100, { mandatory: true }), int('order', 'Order')],
  },
  {
    name: 'life_cycle_stage_status',
    label: 'Life Cycle Stage Status',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      ref('life_cycle_stage', 'Life cycle stage', 'life_cycle_stage', { cascade: 'delete' }),
    ],
  },
];

export const cmdbTables: TableDef[] = [
  ...baseTables,
  ...ciClasses,
  ...relationshipTables,
  ...ireTables,
  ...taskLinkTables,
  ...healthTables,
  ...lifeCycleTables,
];
