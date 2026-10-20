/** Reference data the CMDB needs on every instance (cmdb.md 4.2, 5.1, 8, 9). */
import type { Context } from '../../engine/context.js';
import { DEFAULT_WEIGHTS } from './health.js';

/** Relationship types (parent descriptor, child descriptor), with the documented sys_ids where known. */
export const RELATIONSHIP_TYPES: { parent: string; child: string; sys_id?: string }[] = [
  { parent: 'Depends on', child: 'Used by', sys_id: '1a9cb166f1571100a92eb60da2bce5c5' },
  { parent: 'Runs on', child: 'Runs', sys_id: '60bc4e22c0a8010e01f074cbe6bd73c3' },
  { parent: 'Hosted on', child: 'Hosts' },
  { parent: 'Contains', child: 'Contained by' },
  { parent: 'Members', child: 'Member of' },
  { parent: 'Connects to', child: 'Connected by' },
  { parent: 'Owns', child: 'Owned by' },
  { parent: 'Manages', child: 'Managed by' },
  { parent: 'Defines resources for', child: 'Gets resources from' },
  { parent: 'Provides', child: 'Provided by' },
  { parent: 'Consumes', child: 'Consumed by' },
  { parent: 'Uses', child: 'Used by' },
  { parent: 'Exchanges data with', child: 'Exchanges data with', sys_id: '607ad1b2c0a8010e01941856b365af90' },
  { parent: 'Receives data from', child: 'Sends data to' },
  { parent: 'Virtualizes', child: 'Virtualized by' },
  { parent: 'Instantiates', child: 'Instantiated by' },
  { parent: 'Provisioned From', child: 'Provisioned' },
  { parent: 'IP Connection', child: 'IP Connection' },
  { parent: 'Powers', child: 'Is Powered By' },
  { parent: 'Provides Power for', child: 'Receives Power From' },
  { parent: 'In Rack', child: 'Rack contains' },
  { parent: 'Applicative Flow To', child: 'Applicative Flow From' },
  { parent: 'Implement End Point To', child: 'Implement End Point From' },
  { parent: 'Use End Point To', child: 'Use End Point From' },
  { parent: 'Cluster of', child: 'Cluster' },
];

export const REL = {
  DEPENDS_ON: 'Depends on::Used by',
  RUNS_ON: 'Runs on::Runs',
  HOSTED_ON: 'Hosted on::Hosts',
  CONTAINS: 'Contains::Contained by',
  MEMBERS: 'Members::Member of',
  CONNECTS_TO: 'Connects to::Connected by',
  OWNS: 'Owns::Owned by',
  USES: 'Uses::Used by',
  VIRTUALIZES: 'Virtualizes::Virtualized by',
  PROVIDES: 'Provides::Provided by',
} as const;

/** sys_id of a relationship type by name (null when missing). */
export function relTypeId(ctx: Context, name: string): string | null {
  return (
    ctx.platform.db.get<{ sys_id: string }>(`SELECT "sys_id" FROM "cmdb_rel_type" WHERE "name" = ?`, [name])
      ?.sys_id ?? null
  );
}

function seedRelationshipTypes(ctx: Context): void {
  for (const t of RELATIONSHIP_TYPES) {
    const name = `${t.parent}::${t.child}`;
    if (relTypeId(ctx, name)) continue;
    ctx.insert('cmdb_rel_type', {
      ...(t.sys_id ? { sys_id: t.sys_id } : {}),
      name,
      parent_descriptor: t.parent,
      child_descriptor: t.child,
    });
  }
}

interface EntrySeed {
  order: number;
  attributes: string;
  table?: string;
  referenced_field?: string;
  condition?: string;
  exact_count_match?: boolean;
}

interface RuleSeed {
  name: string;
  description: string;
  applies_to: string;
  is_independent: boolean;
  entries: EntrySeed[];
  related?: { order: number; table: string; referenced_field: string; attributes: string }[];
}

const IDENTIFICATION_RULES: RuleSeed[] = [
  {
    name: 'Hardware Rule',
    description: 'Identifies hardware by serial numbers, then name, then network adapters.',
    applies_to: 'cmdb_ci_hardware',
    is_independent: true,
    entries: [
      {
        order: 100,
        table: 'cmdb_serial_number',
        referenced_field: 'cmdb_ci',
        attributes: 'serial_number,serial_number_type',
        condition: 'valid=true^absent=false^EQ',
        exact_count_match: true,
      },
      { order: 200, attributes: 'serial_number' },
      { order: 300, attributes: 'name' },
      {
        order: 400,
        table: 'cmdb_ci_network_adapter',
        referenced_field: 'cmdb_ci',
        attributes: 'ip_address,mac_address',
        condition: 'install_status!=100^EQ',
        exact_count_match: true,
      },
    ],
    related: [
      {
        order: 100,
        table: 'cmdb_print_queue_instance',
        referenced_field: 'installed_on',
        attributes: 'name',
      },
    ],
  },
  {
    name: 'Application Rule',
    description: 'Applications are identified by name on the host they run on.',
    applies_to: 'cmdb_ci_appl',
    is_independent: false,
    entries: [{ order: 100, attributes: 'name' }],
  },
  {
    name: 'Network Adapter Rule',
    description: 'Network adapters are identified by name and MAC address on their owning hardware.',
    applies_to: 'cmdb_ci_network_adapter',
    is_independent: false,
    entries: [{ order: 100, attributes: 'name,mac_address' }],
  },
  {
    name: 'Service Rule',
    description: 'Services are identified by name.',
    applies_to: 'cmdb_ci_service',
    is_independent: true,
    entries: [{ order: 100, attributes: 'name' }],
  },
  {
    name: 'Business Application Rule',
    description: 'Business applications are identified by number, then name.',
    applies_to: 'cmdb_ci_business_app',
    is_independent: true,
    entries: [
      { order: 100, attributes: 'number' },
      { order: 200, attributes: 'name' },
    ],
  },
];

function seedIdentificationRules(ctx: Context): void {
  for (const r of IDENTIFICATION_RULES) {
    if (ctx.first('cmdb_identifier', `applies_to=${r.applies_to}`)) continue;
    const rule = ctx.insert('cmdb_identifier', {
      name: r.name,
      description: r.description,
      applies_to: r.applies_to,
      is_independent: r.is_independent,
      active: true,
    });
    for (const e of r.entries) {
      ctx.insert('cmdb_identifier_entry', {
        identifier: rule.sysId,
        order: e.order,
        attributes: e.attributes,
        table: e.table ?? null,
        referenced_field: e.referenced_field ?? null,
        condition: e.condition ?? null,
        exact_count_match: !!e.exact_count_match,
        active: true,
      });
    }
    for (const rel of r.related ?? [])
      ctx.insert('cmdb_related_entry', { identifier: rule.sysId, ...rel, active: true });
  }
}

const HOSTING: [string, string, string][] = [
  ['cmdb_ci_appl', REL.RUNS_ON, 'cmdb_ci_hardware'],
  ['cmdb_ci_appl', REL.RUNS_ON, 'cmdb_ci_vm_instance'],
];

const CONTAINMENT: [string, string, string][] = [
  ['cmdb_ci_app_server_tomcat', REL.CONTAINS, 'cmdb_ci_app_server_tomcat_war'],
  ['cmdb_ci_hardware', REL.OWNS, 'cmdb_ci_network_adapter'],
];

/** Suggested relationships: [base class, type, dependent class, base class is parent]. */
const SUGGESTIONS: [string, string, string, boolean][] = [
  ['cmdb_ci_appl', REL.RUNS_ON, 'cmdb_ci_hardware', true],
  ['cmdb_ci_appl', REL.RUNS_ON, 'cmdb_ci_vm_instance', true],
  ['cmdb_ci_appl', REL.DEPENDS_ON, 'cmdb_ci_appl', true],
  ['cmdb_ci_appl', REL.DEPENDS_ON, 'cmdb_ci_database', true],
  ['cmdb_ci_computer', REL.CONTAINS, 'cmdb_ci_storage_device', true],
  ['cmdb_ci_hardware', REL.OWNS, 'cmdb_ci_network_adapter', true],
  ['cmdb_ci_hardware', REL.CONNECTS_TO, 'cmdb_ci_netgear', true],
  ['cmdb_ci_server', REL.DEPENDS_ON, 'cmdb_ci_storage_device', true],
  ['cmdb_ci_lb', REL.DEPENDS_ON, 'cmdb_ci_web_server', true],
  ['cmdb_ci_netgear', REL.CONNECTS_TO, 'cmdb_ci_netgear', true],
  ['cmdb_ci_cluster', REL.MEMBERS, 'cmdb_ci_server', true],
  ['cmdb_ci_database', REL.HOSTED_ON, 'cmdb_ci_db_instance', true],
  ['cmdb_ci_esx_server', REL.VIRTUALIZES, 'cmdb_ci_vm_instance', true],
  ['cmdb_ci_service', REL.DEPENDS_ON, 'cmdb_ci', true],
  ['cmdb_ci_service_auto', REL.DEPENDS_ON, 'cmdb_ci_appl', true],
  ['cmdb_ci_service_auto', REL.DEPENDS_ON, 'cmdb_ci_service_auto', true],
  ['service_offering', REL.DEPENDS_ON, 'cmdb_ci_service_auto', true],
  ['service_offering', REL.CONTAINS, 'cmdb_ci_service_auto', true],
  ['cmdb_ci_business_app', REL.USES, 'cmdb_ci_service_auto', true],
  ['cmdb_ci_business_app', REL.USES, 'cmdb_ci_information_object', true],
  ['cmdb_ci_business_app', REL.PROVIDES, 'cmdb_ci_business_capability', true],
];

function seedGovernance(ctx: Context): void {
  const meta = (table: string, rows: [string, string, string][]) => {
    for (const [parent, type, child] of rows) {
      const typeId = relTypeId(ctx, type);
      if (!typeId || ctx.first(table, `parent_type=${parent}^child_type=${child}^rel_type=${typeId}`))
        continue;
      ctx.insert(table, { parent_type: parent, rel_type: typeId, child_type: child, active: true });
    }
  };
  meta('cmdb_metadata_hosting', HOSTING);
  meta('cmdb_metadata_containment', CONTAINMENT);
  for (const [base, type, dependent, parent] of SUGGESTIONS) {
    const typeId = relTypeId(ctx, type);
    if (
      !typeId ||
      ctx.first(
        'cmdb_rel_type_suggest',
        `base_class=${base}^dependent_class=${dependent}^cmdb_rel_type=${typeId}`,
      )
    )
      continue;
    ctx.insert('cmdb_rel_type_suggest', {
      base_class: base,
      cmdb_rel_type: typeId,
      dependent_class: dependent,
      parent,
    });
  }
}

function seedHealth(ctx: Context): void {
  if (!ctx.first('cmdb_health_staleness_rule', 'applies_to=cmdb_ci')) {
    ctx.insert('cmdb_health_staleness_rule', { applies_to: 'cmdb_ci', effective_duration: 60 * 86_400_000 });
  }
  const parents: Record<string, string> = {
    completeness: 'overall',
    correctness: 'overall',
    compliance: 'overall',
    required: 'completeness',
    recommended: 'completeness',
    orphan: 'correctness',
    staleness: 'correctness',
    duplicate: 'correctness',
    audit: 'compliance',
  };
  for (const [name, parent] of Object.entries(parents)) {
    if (ctx.first('cmdb_health_metric_pref', `name=${name}`)) continue;
    ctx.insert('cmdb_health_metric_pref', {
      name,
      parent_kpi: parent,
      weight: DEFAULT_WEIGHTS[name],
      active: true,
    });
  }
}

/** CSDM life cycle stages and their statuses (cmdb.md 9, asset.md 3 and 7). */
export const LIFE_CYCLE: Record<string, string[]> = {
  Ideation: ['Draft', 'Under Evaluation'],
  Design: ['Build'],
  Purchase: ['On Order'],
  Inventory: ['Available', 'Reserved', 'Preallocated', 'Pending Repair'],
  Deploy: ['In Stock', 'Pending Transfer', 'In Transit'],
  Operational: ['In Use', 'In Maintenance', 'Renewed', 'Pending Retirement'],
  'End of Operation': ['Retired'],
  Defective: ['In Stock'],
  Missing: ['Lost', 'Stolen'],
  'End of Life': [
    'Pending Disposal',
    'Disposed',
    'Sold',
    'Donated',
    'Vendor Credit',
    'RMA',
    'Lease Return',
    'Buyout',
    'Expired',
    'Retired',
  ],
  TBD: ['TBD'],
};

function seedLifeCycle(ctx: Context): void {
  Object.entries(LIFE_CYCLE).forEach(([stage, statuses], i) => {
    const s =
      ctx.first('life_cycle_stage', `name=${stage}`) ??
      ctx.insert('life_cycle_stage', { name: stage, order: (i + 1) * 10 });
    for (const status of statuses) {
      if (!ctx.first('life_cycle_stage_status', `name=${status}^life_cycle_stage=${s.sysId}`)) {
        ctx.insert('life_cycle_stage_status', { name: status, life_cycle_stage: s.sysId });
      }
    }
  });
}

/** Life cycle stage and status sys_ids for a CSDM pair, or null. */
export function lifeCyclePair(
  ctx: Context,
  stage: string,
  status: string,
): { stage: string; status: string } | null {
  const row = ctx.platform.db.get<{ stage: string; status: string }>(
    `SELECT s."sys_id" AS stage, st."sys_id" AS status FROM "life_cycle_stage" s JOIN "life_cycle_stage_status" st ON st."life_cycle_stage" = s."sys_id"
     WHERE s."name" = ? AND st."name" = ? LIMIT 1`,
    [stage, status],
  );
  return row ?? null;
}

export function seedCmdb(ctx: Context): void {
  seedRelationshipTypes(ctx);
  seedIdentificationRules(ctx);
  seedGovernance(ctx);
  seedHealth(ctx);
  seedLifeCycle(ctx);
}
