import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { AppModule } from '../../engine/module.js';
import type { AclDef } from '../../engine/services/acl.js';
import type { PropertyDef } from '../../engine/services/properties.js';
import { SERVICES } from '../contracts.js';
import { registerCmdbApi } from './api.js';
import { loadCmdbDemo } from './demo.js';
import { CmdbEngine } from './graph.js';
import { runHealthJob } from './health.js';
import { cmdbRules } from './rules.js';
import { seedCmdb } from './seed.js';
import { cmdbTables } from './tables.js';
import { cmdbUi } from './ui.js';

export { CmdbEngine, cmdbEngine } from './graph.js';
export { type IreOutput, type IrePayload, runIre } from './ire.js';

const READERS = ['itil', 'cmdb_read', 'asset'];
const CONFIG_TABLES = [
  'cmdb_rel_type',
  'cmdb_rel_type_suggest',
  'cmdb_metadata_hosting',
  'cmdb_metadata_containment',
  'cmdb_identifier',
  'cmdb_identifier_entry',
  'cmdb_related_entry',
  'cmdb_reconciliation_definition',
  'cmdb_data_refresh_rule',
  'cmdb_health_inclusion_rule',
  'cmdb_health_metric_pref',
  'cmdb_health_orphan_rule',
  'cmdb_health_staleness_rule',
  'cmdb_health_result',
  'resolvr_cmdb_recommended_field',
  'resolvr_cmdb_compliance_rule',
  'cmdb_group',
  'sys_object_source',
  'sys_rel_source',
  'cmdb_datasource_last_update',
  'cmdb_serial_number',
];

const crud = (name: string, read: string[], write: string[], del = write): AclDef[] => [
  { name, operation: 'read', roles: read },
  { name, operation: 'write', roles: write },
  { name, operation: 'create', roles: write },
  { name, operation: 'delete', roles: del },
];

const acls: AclDef[] = [
  ...crud('cmdb', READERS, ['itil', 'cmdb_admin', 'asset'], ['cmdb_admin', 'asset']),
  {
    name: 'cmdb',
    operation: 'read',
    condition: 'assigned_to=javascript:gs.getUserID()',
    description: 'Users can read the CIs assigned to them',
  },
  ...crud('cmdb_rel_ci', READERS, ['itil', 'cmdb_admin', 'asset']),
  ...crud('cmdb_rel_person', READERS, ['itil', 'cmdb_admin']),
  ...crud('cmdb_rel_group', READERS, ['itil', 'cmdb_admin']),
  ...crud('svc_ci_assoc', READERS, ['itil', 'cmdb_admin']),
  ...crud('task_ci', ['itil', 'cmdb_read'], ['itil']),
  ...crud('task_cmdb_ci_service', ['itil', 'cmdb_read'], ['itil']),
  ...crud('task_service_offering', ['itil', 'cmdb_read'], ['itil']),
  ...CONFIG_TABLES.flatMap((t) => crud(t, READERS, ['cmdb_admin'])),
  ...crud(
    'cmdb_model',
    ['itil', 'cmdb_read', 'asset', 'snc_internal'],
    ['cmdb_admin', 'asset', 'catalog_admin'],
  ),
  ...crud('life_cycle_stage', ['snc_internal'], ['cmdb_admin']),
  ...crud('life_cycle_stage_status', ['snc_internal'], ['cmdb_admin']),
];

const bool = (name: string, value: boolean, description: string): PropertyDef => ({
  name,
  value: String(value),
  type: 'boolean',
  description,
});
const int = (name: string, value: number, description: string): PropertyDef => ({
  name,
  value: String(value),
  type: 'integer',
  description,
});

const properties: PropertyDef[] = [
  bool(
    'glide.required.attribute.enabled',
    true,
    'Identification rejects inserts with empty mandatory attributes',
  ),
  bool('glide.class.upgrade.enabled', true, 'Identification may move a CI to a subclass'),
  bool('glide.class.downgrade.enabled', true, 'Identification may move a CI to a parent class'),
  bool(
    'glide.class.switch.enabled',
    true,
    'Identification may move a CI to another branch of the class tree',
  ),
  bool('glide.reconciliation.override.null', true, 'A lower priority source may fill empty attributes'),
  bool('glide.identification_engine.skip_duplicates', true, 'Use the oldest CI of a small duplicate set'),
  int(
    'glide.identification_engine.skip_duplicates.threshold',
    5,
    'Largest duplicate set for which the oldest CI is used',
  ),
  bool(
    'glide.identification_engine.enable_identifier_optional_condition',
    false,
    'Apply the conditions of identifier entries',
  ),
  bool(
    'glide.identification_engine.skip_sys_object_source_matching',
    false,
    'Ignore source native keys during identification',
  ),
  bool(
    'glide.identification_engine.populate_sys_rel_source',
    false,
    'Record the source of relationships created by identification',
  ),
  bool(
    'cmdb.dependent.ci.cascade.op.enabled',
    true,
    'Delete dependent CIs left without the CI they are hosted on or contained in',
  ),
  bool(
    'cmdb.dependent.ci.cascade.retire.enabled',
    false,
    'Retire (instead of delete) orphaned dependent CIs',
  ),
  int('glide.bsm.max_levels', 3, 'Default depth of dependency maps (1 to 49)'),
  int('glide.bsm.max_nodes', 1000, 'Maximum nodes in a dependency map'),
  int('glide.bsm.max_num_rels', 100, 'Relationships fetched per node in a dependency map'),
  bool(
    'glide.cmdb.health.staleness_exclude_dependent_cis',
    false,
    'Exclude dependent CIs from the staleness metric',
  ),
  {
    name: 'glide.cmdb.health.ci_ownership_field',
    value: 'managed_by_group',
    description: 'Field used for CI ownership in health charts',
  },
  bool(
    'change.refresh_impacted.include_affected_cis',
    true,
    'Use service CI associations when refreshing impacted services',
  ),
  bool('resolvr.cmdb.health.job_enabled', false, 'Run the daily CMDB Health job'),
];

/** CMDB classes, relationships, dependency views, impact analysis and CMDB APIs. */
export const cmdbModule: AppModule = {
  id: 'cmdb',
  name: 'Configuration Management',
  description: 'CMDB classes, relationships, dependency views, impact analysis and CMDB APIs.',
  dependsOn: ['task'],
  tables: cmdbTables,
  roles: [
    { name: 'cmdb_read', description: 'Read-only access to configuration items and relationships' },
    {
      name: 'cmdb_admin',
      description: 'Administers CI classes, identification, reconciliation and CMDB Health',
      contains: ['cmdb_read'],
    },
  ],
  acls,
  rules: cmdbRules,
  properties,
  jobs: [
    {
      id: 'cmdb.health',
      name: 'CMDB Health',
      description: 'Computes completeness, correctness and compliance results',
      intervalMs: 86_400_000,
      run(ctx) {
        if (ctx.platform.properties.getBool('resolvr.cmdb.health.job_enabled', false)) runHealthJob(ctx);
      },
    },
  ],
  ui: cmdbUi,
  register(platform) {
    platform.services.set(SERVICES.cmdb, new CmdbEngine(platform));
  },
  seedVersion: 1,
  seed: seedCmdb,
  demo: loadCmdbDemo,
  http(app, deps) {
    registerCmdbApi(app as FastifyInstance, deps as ApiDeps);
  },
};
