import type { FormLayoutDef, ListLayoutDef, ModuleUiDef, RelatedListDef } from '../../engine/module.js';
import { cmdbEngine } from './graph.js';

const relationships: RelatedListDef = {
  table: 'cmdb_rel_ci',
  query: 'parent={sys_id}^ORchild={sys_id}',
  label: 'Relationships',
  columns: ['parent', 'type', 'child', 'port'],
};
const affectedTasks: RelatedListDef = {
  table: 'task_ci',
  field: 'ci_item',
  label: 'Affected tasks',
  columns: ['task', 'task.short_description', 'task.state', 'applied'],
};
const primaryTasks: RelatedListDef = {
  table: 'task',
  field: 'cmdb_ci',
  label: 'Tasks',
  columns: ['number', 'short_description', 'sys_class_name', 'state', 'assigned_to'],
};
const services: RelatedListDef = {
  table: 'svc_ci_assoc',
  field: 'ci_id',
  label: 'Member of services',
  columns: ['service_id'],
};
const ciRelated = [relationships, affectedTasks, primaryTasks, services];

const header = (extra: string[] = []) => ({
  left: ['name', 'sys_class_name', 'asset_tag', 'serial_number', 'model_id', 'manufacturer', ...extra],
  right: ['operational_status', 'install_status', 'location', 'support_group', 'assigned_to', 'managed_by'],
});

const ownership = {
  caption: 'Ownership',
  left: ['owned_by', 'managed_by_group', 'company', 'department'],
  right: ['cost_center', 'vendor', 'warranty_expiration', 'asset'],
};
const discovery = {
  caption: 'Discovery',
  left: ['discovery_source', 'first_discovered', 'last_discovered'],
  right: ['duplicate_of', 'unverified', 'attested', 'sys_updated_on'],
};
const network = { caption: 'Network', left: ['ip_address', 'mac_address'], right: ['fqdn', 'dns_domain'] };

const forms: FormLayoutDef[] = [
  {
    table: 'cmdb_ci',
    highlights: ['operational_status', 'install_status', 'support_group'],
    sections: [header(), { fields: ['short_description'] }, ownership, discovery],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_hardware',
    highlights: ['operational_status', 'install_status', 'hardware_status'],
    sections: [
      header(['hardware_status', 'hardware_substatus']),
      { fields: ['short_description'] },
      network,
      ownership,
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_computer',
    highlights: ['operational_status', 'install_status', 'assigned_to'],
    sections: [
      header(['hardware_status', 'hardware_substatus']),
      {
        caption: 'Platform',
        left: ['os', 'os_version', 'os_service_pack', 'form_factor', 'virtual'],
        right: ['cpu_name', 'cpu_count', 'cpu_core_count', 'ram', 'disk_space'],
      },
      network,
      ownership,
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_server',
    highlights: ['operational_status', 'used_for', 'support_group'],
    sections: [
      header(['host_name', 'classification', 'used_for']),
      {
        caption: 'Platform',
        left: ['os', 'os_version', 'os_service_pack', 'virtual', 'dr_backup'],
        right: ['cpu_name', 'cpu_count', 'cpu_core_count', 'ram', 'disk_space'],
      },
      { ...network, right: ['fqdn', 'dns_domain', 'firewall_status', 'internet_facing'] },
      ownership,
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_linux_server',
    highlights: ['operational_status', 'used_for', 'support_group'],
    sections: [
      header(['host_name', 'classification', 'used_for']),
      {
        caption: 'Platform',
        left: ['os', 'os_version', 'kernel_release', 'virtual', 'dr_backup'],
        right: ['cpu_name', 'cpu_count', 'cpu_core_count', 'ram', 'disk_space'],
      },
      { ...network, right: ['fqdn', 'dns_domain', 'firewall_status', 'internet_facing'] },
      ownership,
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_netgear',
    highlights: ['operational_status', 'install_status', 'support_group'],
    sections: [
      header(['firmware_version']),
      { caption: 'Capabilities', left: ['ports', 'can_route'], right: ['can_switch', 'default_gateway'] },
      network,
      ownership,
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_appl',
    highlights: ['operational_status', 'used_for', 'support_group'],
    sections: [
      {
        left: ['name', 'sys_class_name', 'version', 'edition', 'used_for'],
        right: ['operational_status', 'install_status', 'support_group', 'managed_by', 'owned_by'],
      },
      {
        caption: 'Runtime',
        left: ['install_directory', 'config_directory'],
        right: ['tcp_port', 'running_process'],
      },
      { fields: ['short_description'] },
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_db_instance',
    highlights: ['operational_status', 'version', 'support_group'],
    sections: [
      {
        left: ['name', 'sys_class_name', 'instance_name', 'version', 'edition'],
        right: ['operational_status', 'install_status', 'support_group', 'managed_by', 'tcp_port'],
      },
      { fields: ['short_description'] },
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_database',
    highlights: ['operational_status', 'type', 'support_group'],
    sections: [
      {
        left: ['name', 'sys_class_name', 'type', 'version'],
        right: ['operational_status', 'install_status', 'support_group', 'owned_by'],
      },
      { fields: ['short_description'] },
      discovery,
    ],
    relatedLists: ciRelated,
  },
  {
    table: 'cmdb_ci_service',
    highlights: ['operational_status', 'busines_criticality', 'owned_by'],
    sections: [
      {
        left: ['number', 'name', 'sys_class_name', 'service_classification', 'parent'],
        right: ['operational_status', 'busines_criticality', 'used_for', 'owned_by', 'support_group'],
      },
      { fields: ['short_description'] },
      {
        caption: 'Service details',
        left: ['portfolio_status', 'service_status', 'consumer_type'],
        right: ['managed_by_group', 'change_control', 'business_unit'],
      },
    ],
    relatedLists: [
      {
        table: 'service_offering',
        field: 'parent',
        label: 'Offerings',
        columns: ['number', 'name', 'operational_status', 'support_group'],
      },
      {
        table: 'svc_ci_assoc',
        field: 'service_id',
        label: 'Service CIs',
        columns: ['ci_id', 'ci_id.sys_class_name', 'ci_id.operational_status'],
      },
      relationships,
      {
        table: 'task_cmdb_ci_service',
        field: 'cmdb_ci_service',
        label: 'Impacted by tasks',
        columns: ['task', 'task.short_description', 'manually_added'],
      },
      primaryTasks,
    ],
  },
  {
    table: 'service_offering',
    highlights: ['operational_status', 'parent', 'support_group'],
    sections: [
      {
        left: ['number', 'name', 'parent', 'service_classification', 'technical_contact'],
        right: ['operational_status', 'busines_criticality', 'support_group', 'owned_by', 'price'],
      },
      { fields: ['description'] },
    ],
    relatedLists: [
      relationships,
      {
        table: 'task_service_offering',
        field: 'service_offering',
        label: 'Tasks',
        columns: ['task', 'task.short_description', 'manually_added'],
      },
    ],
  },
  {
    table: 'cmdb_ci_business_app',
    highlights: ['operational_status', 'business_criticality', 'it_application_owner'],
    sections: [
      {
        left: ['number', 'name', 'application_type', 'architecture_type', 'platform'],
        right: [
          'operational_status',
          'business_criticality',
          'it_application_owner',
          'owned_by',
          'support_group',
        ],
      },
      { fields: ['short_description'] },
      {
        caption: 'Portfolio',
        left: ['user_base', 'install_type', 'technology_stack'],
        right: ['data_classification', 'url', 'active'],
      },
    ],
    relatedLists: [relationships, primaryTasks],
  },
  {
    table: 'cmdb_rel_ci',
    sections: [{ left: ['parent', 'type', 'child'], right: ['port', 'connection_strength'] }],
  },
  {
    table: 'cmdb_rel_type',
    sections: [{ left: ['name', 'parent_descriptor'], right: ['child_descriptor'] }],
    relatedLists: [
      {
        table: 'cmdb_rel_type_suggest',
        field: 'cmdb_rel_type',
        label: 'Suggested relationships',
        columns: ['base_class', 'dependent_class', 'parent'],
      },
    ],
  },
  {
    table: 'cmdb_identifier',
    sections: [
      { left: ['name', 'applies_to'], right: ['is_independent', 'active'] },
      { fields: ['description'] },
    ],
    relatedLists: [
      {
        table: 'cmdb_identifier_entry',
        field: 'identifier',
        label: 'Identifier entries',
        columns: [
          'order',
          'attributes',
          'table',
          'referenced_field',
          'allow_null_attribute',
          'exact_count_match',
          'active',
        ],
      },
      {
        table: 'cmdb_related_entry',
        field: 'identifier',
        label: 'Related entries',
        columns: ['order', 'table', 'referenced_field', 'attributes', 'active'],
      },
    ],
  },
  {
    table: 'reconcile_duplicate_task',
    sections: [
      { left: ['number', 'cmdb_ci', 'state'], right: ['assignment_group', 'assigned_to', 'priority'] },
      { fields: ['short_description', 'description', 'duplicates'] },
      { caption: 'Notes', fields: ['work_notes'] },
    ],
  },
  {
    table: 'resolvr_reclassification_task',
    sections: [
      {
        left: ['number', 'cmdb_ci', 'state', 'reclassification_type'],
        right: ['current_class', 'target_class', 'source', 'assigned_to'],
      },
      { fields: ['short_description', 'description'] },
      { caption: 'Notes', fields: ['work_notes'] },
    ],
  },
];

const ciColumns = [
  'name',
  'sys_class_name',
  'operational_status',
  'install_status',
  'location',
  'support_group',
  'sys_updated_on',
];

const lists: ListLayoutDef[] = [
  { table: 'cmdb_ci', columns: ciColumns, defaultOrder: 'name' },
  {
    table: 'cmdb_ci_hardware',
    columns: [
      'name',
      'sys_class_name',
      'serial_number',
      'model_id',
      'hardware_status',
      'location',
      'assigned_to',
    ],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_computer',
    columns: ['name', 'serial_number', 'model_id', 'os', 'assigned_to', 'location', 'hardware_status'],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_server',
    columns: [
      'name',
      'sys_class_name',
      'ip_address',
      'os',
      'os_version',
      'used_for',
      'location',
      'operational_status',
      'support_group',
    ],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_netgear',
    columns: [
      'name',
      'sys_class_name',
      'ip_address',
      'model_id',
      'firmware_version',
      'location',
      'operational_status',
    ],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_appl',
    columns: ['name', 'sys_class_name', 'version', 'used_for', 'operational_status', 'support_group'],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_database',
    columns: ['name', 'type', 'version', 'operational_status', 'support_group', 'owned_by'],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_service',
    columns: [
      'number',
      'name',
      'sys_class_name',
      'service_classification',
      'busines_criticality',
      'operational_status',
      'owned_by',
    ],
    defaultOrder: 'name',
  },
  {
    table: 'service_offering',
    columns: ['number', 'name', 'parent', 'operational_status', 'support_group', 'busines_criticality'],
    defaultOrder: 'name',
  },
  {
    table: 'cmdb_ci_business_app',
    columns: [
      'number',
      'name',
      'application_type',
      'business_criticality',
      'it_application_owner',
      'operational_status',
    ],
    defaultOrder: 'name',
  },
  { table: 'cmdb_rel_ci', columns: ['parent', 'type', 'child', 'port', 'sys_updated_on'] },
  {
    table: 'cmdb_rel_type',
    columns: ['name', 'parent_descriptor', 'child_descriptor'],
    defaultOrder: 'name',
  },
  { table: 'cmdb_rel_type_suggest', columns: ['base_class', 'cmdb_rel_type', 'dependent_class', 'parent'] },
  { table: 'cmdb_identifier', columns: ['name', 'applies_to', 'is_independent', 'active'] },
  {
    table: 'cmdb_reconciliation_definition',
    columns: ['applies_to', 'discovery_source', 'priority', 'attributes', 'active'],
  },
  { table: 'cmdb_health_result', columns: ['ci', 'relationship', 'metric', 'state', 'details', 'last_run'] },
  { table: 'task_ci', columns: ['task', 'ci_item', 'manual_proposed_change', 'applied'] },
  { table: 'task_cmdb_ci_service', columns: ['task', 'cmdb_ci_service', 'manually_added'] },
  {
    table: 'cmdb_model',
    columns: ['display_name', 'manufacturer', 'model_number', 'sys_class_name', 'status'],
    defaultOrder: 'display_name',
  },
];

const READERS = ['itil', 'cmdb_read', 'asset'];

export const cmdbUi: ModuleUiDef = {
  navigation: [
    {
      id: 'cmdb',
      title: 'Configuration',
      icon: 'network',
      roles: READERS,
      order: 60,
      modules: [
        { title: 'Servers', table: 'cmdb_ci_server', query: 'ORDERBYname' },
        {
          title: 'Computers',
          table: 'cmdb_ci_computer',
          query: 'sys_class_nameINcmdb_ci_computer,cmdb_ci_pc_hardware^ORDERBYname',
        },
        { title: 'Network Gear', table: 'cmdb_ci_netgear', query: 'ORDERBYname' },
        { title: 'Storage', table: 'cmdb_ci_storage_device', query: 'ORDERBYname' },
        { title: 'Virtual Machines', table: 'cmdb_ci_vm_instance', query: 'ORDERBYname' },
        { title: 'Applications', table: 'cmdb_ci_appl', query: 'ORDERBYname', separator: true },
        { title: 'Database Instances', table: 'cmdb_ci_db_instance', query: 'ORDERBYname' },
        { title: 'Databases', table: 'cmdb_ci_database', query: 'ORDERBYname' },
        { title: 'Business Applications', table: 'cmdb_ci_business_app', query: 'ORDERBYname' },
        {
          title: 'Business Services',
          table: 'cmdb_ci_service',
          query: 'sys_class_nameINcmdb_ci_service,cmdb_ci_service_business^ORDERBYname',
          separator: true,
        },
        { title: 'Application Services', table: 'cmdb_ci_service_auto', query: 'ORDERBYname' },
        { title: 'Technical Services', table: 'cmdb_ci_service_technical', query: 'ORDERBYname' },
        { title: 'Service Offerings', table: 'service_offering', query: 'ORDERBYname' },
        { title: 'All CIs', table: 'cmdb_ci', query: 'ORDERBYname', separator: true },
        { title: 'Relationships', table: 'cmdb_rel_ci', query: 'ORDERBYDESCsys_updated_on' },
        { title: 'CMDB Health', route: '/workspace/cmdb/health' },
        { title: 'De-duplication Tasks', table: 'reconcile_duplicate_task', query: 'active=true' },
        { title: 'Reclassification Tasks', table: 'resolvr_reclassification_task', query: 'active=true' },
        { title: 'Relationship Types', table: 'cmdb_rel_type', roles: ['cmdb_admin'], separator: true },
        { title: 'Suggested Relationships', table: 'cmdb_rel_type_suggest', roles: ['cmdb_admin'] },
        { title: 'Identification Rules', table: 'cmdb_identifier', roles: ['cmdb_admin'] },
        { title: 'Reconciliation Rules', table: 'cmdb_reconciliation_definition', roles: ['cmdb_admin'] },
        { title: 'Health Results', table: 'cmdb_health_result', roles: ['cmdb_admin'] },
        { title: 'Compliance Rules', table: 'resolvr_cmdb_compliance_rule', roles: ['cmdb_admin'] },
      ],
    },
  ],
  forms,
  lists,
  uiActions: [
    {
      id: 'cmdb.dependency_map',
      table: 'cmdb_ci',
      label: 'Dependency map',
      order: 10,
      saveFirst: false,
      run: (rec) => ({ redirect: `/workspace/cmdb/map/${rec.sysId}` }),
    },
    {
      id: 'cmdb.refresh_impacted_services',
      table: 'task',
      label: 'Refresh impacted services',
      roles: ['itil'],
      order: 400,
      condition: (rec) =>
        rec.className !== 'reconcile_duplicate_task' &&
        rec.className !== 'resolvr_reclassification_task' &&
        rec.bool('active'),
      run(rec, ctx) {
        const { services, offerings } = cmdbEngine(ctx.platform).refreshImpactedServices(ctx, rec);
        return {
          message: `Impacted services refreshed (${services} service${services === 1 ? '' : 's'}, ${offerings} offering${offerings === 1 ? '' : 's'} added)`,
        };
      },
    },
  ],
};
