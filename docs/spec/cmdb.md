# CMDB and CSDM specification

ResolvrNow spec, clean-room. Covers the CI class hierarchy, core CI attributes and lifecycle fields, relationships, identification and reconciliation (IRE), dependency traversal and impact analysis, CI links on tasks, CMDB Health, the CSDM service model, and the CMDB Instance and Meta REST APIs. Asset to CI synchronisation is specified in `asset.md` section 6; schedules referenced by CIs in `schedules.md`.

Conventions: **[Documented]** = stated in the Brazil docs or the SDK data model; **[Inferred]** = ResolvrNow decision or unstated platform behaviour. Field names come from the SDK JSON (`server/src/schema/sdk/sdk-tables.json` (formerly `sdk-tables.json`)) when present; new tables and columns are listed in `docs/spec/data/cmdb-sla.json`.

## 1. Storage and class mechanics

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/c_ConfigurationManagementDatabase.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/t_ManuallyReclassifyCI.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/manage-dependent-ci.html

| Rule | Status |
|---|---|
| `cmdb` (Base Configuration Item) is the root; descendants of `cmdb` that are not under `cmdb_ci` are non-IT CIs; `cmdb_ci` and below are IT CIs | [Documented] |
| ResolvrNow stores every CI of every class in the single physical table of the `cmdb` root; `sys_class_name` holds the class; queries on a class return the class and its descendants; `INSTANCEOF` uses the registry | [Documented model] [Inferred ResolvrNow mapping] |
| `sys_class_path` is an opaque, sortable ancestry string (platform example `/!!/!2/!(/!!/!0`); ResolvrNow computes it from the registry, clients must not parse it | [Documented field] [Inferred encoding] |
| Only classes under `cmdb_ci` appear in dependency maps and relation formatters | [Documented] |
| Reclassification keeps the `sys_id`; upgrade = move to a descendant, downgrade = move to an ancestor, switch = other branch (downgrade plus upgrade). Columns not defined on the new class are cleared (data loss on downgrade/switch) | [Documented] |
| Deleting a CI deletes its `cmdb_rel_ci` rows; dependent CIs left without their dependency become orphan dependent CIs, cascade-deleted when `cmdb.dependent.ci.cascade.op.enabled` (default true) and cascade-retired when `cmdb.dependent.ci.cascade.retire.enabled` (default false) | [Documented] |

## 2. Class hierarchy

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/cmdb-tables-details.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/class-hardware.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/class-computer.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/class-server.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-meta-api.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/manage-tech-servs-domain.html

Parent links marked [D] are stated in the docs, SDK or Meta API sample; [I] are ResolvrNow choices consistent with the platform.

| Class | Label | Parent | Key own attributes |
|---|---|---|---|
| cmdb | Base Configuration Item | none | SDK set: name, asset, install_status, location, company, ... [D] |
| cmdb_ci | Configuration Item | cmdb [D] | SDK set incl. operational_status, discovery_source, first/last_discovered, duplicate_of, life_cycle_stage(_status), maintenance_schedule, schedule [D] |
| cmdb_ci_hardware | Hardware | cmdb_ci [D] | hardware_status, hardware_substatus, default_gateway [D] |
| cmdb_ci_computer | Computer | cmdb_ci_hardware [D] | os, os_version, os_service_pack, os_address_width, os_domain, cpu_count, cpu_core_count, cpu_core_thread, cpu_name, cpu_speed, cpu_type, cpu_manufacturer (core_company), ram, disk_space, virtual, form_factor, chassis_type, cd_rom, cd_speed, floppy, object_id [D] |
| cmdb_ci_pc_hardware | Personal Computer | cmdb_ci_computer [D] | none |
| cmdb_ci_server | Server | cmdb_ci_computer [D] | classification, firewall_status, host_name, used_for, dr_backup (cmdb_ci_server), internet_facing [D] |
| cmdb_ci_linux_server | Linux Server | cmdb_ci_server [D] | kernel_release [D] |
| cmdb_ci_win_server | Windows Server | cmdb_ci_server [D] | none |
| cmdb_ci_unix_server | UNIX Server | cmdb_ci_server [D] | none |
| cmdb_ci_solaris_server, cmdb_ci_aix_server, cmdb_ci_hpux_server | Solaris / AIX / HPUX Server | cmdb_ci_unix_server [I] | none |
| cmdb_ci_virtualization_server, cmdb_ci_esx_server | Virtualization / ESX Server | cmdb_ci_server, then cmdb_ci_virtualization_server [D] | none |
| cmdb_ci_mainframe | IBM Mainframe | cmdb_ci_server [D] | none |
| cmdb_ci_lb | Load Balancer | cmdb_ci_server [D] | none |
| cmdb_ci_storage_switch | Storage Switch | cmdb_ci_computer [D] | none |
| cmdb_ci_netgear | Network Gear | cmdb_ci_hardware [D] | ports, can_route, can_switch, firmware_version [I] |
| cmdb_ci_ip_router, cmdb_ci_ip_switch | IP Router / IP Switch | cmdb_ci_netgear [D] | none |
| cmdb_ci_ip_firewall, cmdb_ci_wap_network | IP Firewall / Wireless Access Point | cmdb_ci_netgear [I] | none |
| cmdb_ci_network_adapter | Network Adapter | cmdb_ci_hardware [I] | cmdb_ci (owning hardware), mac_address, ip_address [D] |
| cmdb_ci_storage_device | Storage Device | cmdb_ci_hardware [I] | size_bytes [I] |
| cmdb_ci_disk, cmdb_ci_san | Disk / Storage Area Network | cmdb_ci_storage_device [I] | none |
| cmdb_ci_storage_volume, cmdb_ci_storage_pool, cmdb_ci_file_system | Storage Volume / Pool / File System | cmdb_ci [I] | none |
| cmdb_ci_ip_address | IP Address | cmdb_ci [I] | ip_address, netmask, ip_version, nic (cmdb_ci_network_adapter) [D concept] |
| cmdb_ci_vm_instance | Virtual Machine Instance | cmdb_ci [I] | object_id, cpus, memory, state [I] |
| cmdb_ci_vmware_instance, cmdb_ci_hyper_v_instance | VMware / Hyper-V VM Instance | cmdb_ci_vm_instance [D] | none |
| cmdb_ci_cluster | Cluster | cmdb_ci [I] | cluster_status [I] |
| cmdb_ci_win_cluster, cmdb_ci_unix_cluster | Windows / UNIX Cluster | cmdb_ci_cluster [I] | none |
| cmdb_ci_cluster_node | Cluster Node | cmdb_ci [I] | cluster (cmdb_ci_cluster), server (cmdb_ci_server) [I] |
| cmdb_ci_database | Database | cmdb_ci [D] | type, version [I] |
| cmdb_ci_appl | Application | cmdb_ci [I] | version, edition, install_directory, config_directory, tcp_port, running_process, used_for [I] |
| cmdb_ci_db_instance | Database Instance | cmdb_ci_appl [I] | instance_name, version [I] |
| cmdb_ci_db_ora_instance, cmdb_ci_db_mssql_instance, cmdb_ci_db_mysql_instance, cmdb_ci_db_postgresql_instance | DB instances | cmdb_ci_db_instance [I] | mssql: instance_name [D] |
| cmdb_ci_app_server (tomcat, jboss, weblogic, websphere children) | Application Server | cmdb_ci_appl [I] | none |
| cmdb_ci_web_server (apache, nginx, iis children) | Web Server | cmdb_ci_appl [I] | none |
| cmdb_ci_spkg | Software | cmdb_ci [I] | version [I] |
| cmdb_ci_service | Service (business service) | cmdb_ci [D] | number BSN, service_classification, busines_criticality, used_for, owned_by, support_group, parent (cmdb_ci_service), portfolio_status [D] |
| cmdb_ci_service_business | Business Service | cmdb_ci_service [D] | none |
| cmdb_ci_service_technical | Technology Management Service | cmdb_ci_service [I] | none |
| cmdb_ci_service_auto | Service Instance (application service) | cmdb_ci_service [D] | none |
| cmdb_ci_service_discovered | Mapped Application Service | cmdb_ci_service_auto [D] | none |
| cmdb_ci_query_based_service | Dynamic CI Group | cmdb_ci_service_auto [D] | cmdb_group (cmdb_group) [I name] |
| cmdb_ci_service_by_tags | Tag-based service instance | cmdb_ci_service_auto [D] | none |
| service_offering | Offering | cmdb_ci_service [D] | parent (owning service), price, contract, technical_contact [D] |
| cmdb_ci_business_app | Business Application | cmdb_ci [D] | number APM, application_type, business_criticality, it_application_owner, platform_host [D] |
| cmdb_ci_business_capability, cmdb_ci_information_object, cmdb_ci_business_process | Capability / Information Object / Business Process | cmdb_ci [I] | none |
| cmdb_ci_endpoint, cmdb_ci_qualifier | Endpoint / Qualifier | cmdb_ci [I] | none |

The CMDB CI Class Models store app adds many more classes; ResolvrNow registers further classes declaratively without engine changes [Documented app] [Inferred].

## 3. Core CI attributes and lifecycle

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/cmdb-table-property-descriptions.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/cmdb-ci-lifecycle-mgmt.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/cmdb-asset-CI-IBI-sync-options.html

`install_status` (label Status; integer; default 1) [Documented, SDK `cmdb` choices]:

| Value | Label |
|---|---|
| 1 | Installed |
| 2 | On Order |
| 3 | In Maintenance |
| 4 | Pending Install |
| 5 | Pending Repair |
| 6 | In Stock |
| 7 | Retired |
| 8 | Stolen |
| 100 | Absent |

`operational_status` (integer; default 1) [value 1 Operational Documented; others Inferred]:

| Value | Label |
|---|---|
| 1 | Operational |
| 2 | Non-Operational |
| 3 | Repair in Progress |
| 4 | DR Standby |
| 5 | Ready |
| 6 | Retired |
| 7 | Pipeline |
| 8 | Catalog |

Coupling rules (CI before-insert/update business rule) [Documented]: operational_status set to Retired forces install_status (and hardware_status) to Retired; install_status/hardware_status set to Retired forces operational_status Retired; leaving Retired on the operational side sets install_status Installed; leaving Retired on the status side sets operational_status Non-Operational. Hardware status values and asset state mapping: `asset.md` 6.4 to 6.6.

Other lifecycle and provenance fields [Documented]: `first_discovered` (set at first insert by IRE), `last_discovered` (updated on every IRE processing; a payload value is applied only if newer), `discovery_source` (choices in the JSON: ServiceNow, ManualEntry, ImportSet, EventManagement, Tivoli, SCCM, ServiceWatch, Other Automated), `duplicate_of` (set by IRE de-duplication), `life_cycle_stage`/`life_cycle_stage_status` (references, CSDM life cycle), `attested`, `attestation_status`, `unverified`, `skip_sync` (asset sync opt-out), `environment`, `used_for` (Production, Staging, QA, Test, Development, Demonstration, Training, Disaster Recovery), `maintenance_schedule` and `schedule` (cmn_schedule).

Rules [Documented]: Service Mapping ignores hosts whose operational_status is not 1 or whose install_status is 100. New incidents and problems exclude Retired CIs from the `cmdb_ci` picker (ResolvrNow reference qualifier `operational_status!=6`).

## 4. Relationships

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/c_CIRelationships.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/r_SuggestedRelationshipModel.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/relationship-governance.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/c_ServiceRulesMetadata.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/r_CMDBRecordTypes.html

### 4.1 Tables

| Table | Columns | Status |
|---|---|---|
| cmdb_rel_ci | parent (cmdb_ci), child (cmdb_ci), type (cmdb_rel_type), port (string), connection_strength [I] | [Documented table, parent/child/type, port] |
| cmdb_rel_type | name `Parent descriptor::Child descriptor`, parent_descriptor, child_descriptor | [Documented name format] [Inferred columns] |
| cmdb_rel_type_suggest | base_class, cmdb_rel_type, dependent_class, parent (true when the base class is the parent) | [Documented table and labels] [Inferred columns] |
| cmdb_metadata_hosting, cmdb_metadata_containment | parent_type, rel_type, child_type (+ containment group root) | [Documented tables] [Inferred columns] |
| cmdb_rel_person, cmdb_rel_group | ci, user / group, type (e.g. Log Reviewed by::Reviews logs for, Backup done by::Does backups for) | [Documented relation kinds] [Inferred tables] |
| sys_rel_source | relationship, source, last_scan; filled only when `glide.identification_engine.populate_sys_rel_source` | [Documented] |

Reading rule [Documented]: `parent --(parent descriptor)--> child`. Example: "Depends on::Used by" with parent A and child B reads "A depends on B" and "B is used by A". A CI's **downstream** relationships are those where it is the parent; **upstream** ones are those where it is the child.

Integrity [Inferred]: parent != child; parent, child, type mandatory; (parent, child, type, port) unique (duplicates are a health failure, so ResolvrNow rejects them on insert); CI delete cascades its relationship rows.

### 4.2 Seeded relationship types (cmdb_rel_type)

| Name (parent::child) | Typical use | Status |
|---|---|---|
| Depends on::Used by | parent needs child; sys_id 1a9cb166f1571100a92eb60da2bce5c5 | [Documented] |
| Runs on::Runs | software runs on hardware/VM (Tomcat runs on Linux server) | [Documented] |
| Hosted on::Hosts | element hosted on platform (cloud resource on logical datacenter) | [Documented] |
| Contains::Contained by | containment (Tomcat contains WAR; offering contains service instance) | [Documented] |
| Members::Member of | cluster has members | [Documented] |
| Connects to::Connected by | network connection | [Documented] |
| Owns::Owned by | ownership (hardware owns network adapter, IP address) | [Documented] |
| Manages::Managed by | management (vCenter manages datacenter) | [Documented] |
| Defines resources for::Gets resources from | resource pools | [Documented] |
| Provides::Provided by | capability provision (business app or service provides capability) | [Documented name] [Inferred direction] |
| Consumes::Consumed by | business app consumes service instance (pre CSDM v5) | [Documented] |
| Uses::Used by | business app uses application service (CSDM v5); business app uses information object | [Documented] |
| Exchanges data with::Exchanges data with | sys_id 607ad1b2c0a8010e01941856b365af90 | [Documented] |
| Receives data from::Sends data to | data flow | [Documented] |
| Virtualizes::Virtualized by, Instantiates::Instantiated by, Provisioned From::Provisioned | virtualization, cloud | [Documented] |
| IP Connection::IP Connection, Powers::Is Powered By, Provides Power for::Receives Power From, In Rack::Rack contains | infrastructure | [Documented] |
| Applicative Flow To::Applicative Flow From, Implement End Point To::Implement End Point From, Use End Point To::Use End Point From | service-model internals (built-in valid) | [Documented] |
| Cluster of::Cluster | cluster to cluster CI grouping | [Inferred] |

### 4.3 Suggested relationships and governance [Documented]
- Suggestions for a CI are all `cmdb_rel_type_suggest` rows whose base class is the CI's class or any ancestor (for a Linux server: linux_server, server, computer, hardware, cmdb_ci).
- A relationship is **valid** if it matches any governance rule: a dependent relationship rule (hosting/containment), a suggested relationship, a reference rule, or a built-in endpoint rule; rules apply to subclasses (inheritance). Several types between the same two classes may be valid. ResolvrNow stores invalid relationships but reports them (Health, 8.3); it does not block them [Inferred].
- Hosting rules: flat pairs (dependent CI type, relation, host type), e.g. Application Runs on::Runs Hardware. Containment rules: a tree rooted at a CI type, e.g. Tomcat Contains::Contained by WAR. Constraints: a type that is a containment child cannot be a containment root nor appear in a hosting rule; a containment root cannot be a hosting child; a hosting child cannot appear in containment; a hosting parent cannot be a containment child; hosting rules cannot form loops. ResolvrNow validates these on insert of metadata rows.

## 5. Identification and reconciliation (IRE)

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/ire.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/c_IdentificationRules.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/best-practices-id-reconcile.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/r_ReconciliationRulesPrinciples.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/id-engine-error-messages.html

### 5.1 Rule tables
- `cmdb_identifier`: name, description, applies_to (class), is_independent, active. One rule per class; a class without its own rule uses the nearest ancestor's rule (including entries); defining a rule on the child replaces the inherited one entirely [Documented].
- `cmdb_identifier_entry`: identifier, order (lower first), attributes (comma list), table (empty = main table; else lookup table referencing the CI through `referenced_field`), allow_null_attribute, allow_fallback (dependent rules: fall back to the parent class rule), exact_count_match (lookup), condition (applied only when `glide.identification_engine.enable_identifier_optional_condition`), active [Documented via Meta API and rule form].
- `cmdb_related_entry` (related entries): table, referenced_field, attributes, order, condition; used to upsert related rows, never to identify [Documented].
- `cmdb_reconciliation_definition` (static rules): applies_to, discovery_source, priority (smaller wins; sources without a rule rank lowest), attributes (empty = all), update_with_null list, filter condition, active; data refresh rules: (discovery_source, applies_to, effective_duration) [Documented].
- `sys_object_source`: name (source_name), id (source_native_key), target_table, target_sys_id, last_scan [Documented table] [Inferred columns].

Seeded rule (Hardware, applies to cmdb_ci_hardware, independent) [Documented]: order 100 lookup `cmdb_serial_number` (serial_number, serial_number_type; condition `valid=true^absent=false`; exact count), 200 `serial_number`, 300 `name`, 400 lookup `cmdb_ci_network_adapter` (ip_address, mac_address; condition `install_status!=100`; exact count). ResolvrNow also seeds [Inferred]: Application rule (cmdb_ci_appl, dependent on Runs on::Runs host; attributes name), Network Adapter (dependent, Owned by hardware; name, mac_address), Service rule (cmdb_ci_service; name), Business Application (number, then name).

### 5.2 Payload
```json
{ "items": [ { "className": "cmdb_ci_linux_server", "values": { "name": "lnx01", "serial_number": "ABC" },
               "lookup": [ { "className": "cmdb_serial_number", "values": { "serial_number": "ABC", "serial_number_type": "system" } } ],
               "sys_object_source_info": { "source_name": "SCCM", "source_native_key": "16777219", "source_recency_timestamp": "2025-03-03 13:00:00" },
               "internal_id": "a" } ],
  "relations": [ { "parent": 0, "child": 1, "type": "Runs on::Runs" } ],
  "settings": { "updateWithoutUpgrade": false, "updateWithoutDowngrade": false, "updateWithoutSwitch": false } }
```
Relations reference items by index or `internal_id`; `type` is the relationship type name [Documented]. Recommended max 500 items; system fields in `values` are rejected [Documented guidance].

### 5.3 Identification algorithm (ResolvrNow v1) [Documented steps, Inferred ordering details]
```
identify(item):
  if item.values.sys_id: return CI(sys_id) or error INVALID_INPUT_DATA
  if sys_object_source_info and not skip_sys_object_source_matching:
      hit = sys_object_source(name, id); if hit: return hit.target
  rule = nearest active cmdb_identifier for item.className; none -> IDENTIFICATION_RULE_MISSING
  scope = CIs INSTANCEOF rule.applies_to
  if not rule.is_independent:
      dep = the payload relation whose type/classes satisfy a hosting rule (item = hosted side)
            or containment rule (item = contained side); none -> MISSING_DEPENDENCY; >1 -> MULTIPLE_DEPENDENCIES
      depCI = identify(other end) first (max 2 dependency levels)
      scope = scope restricted to CIs having that relationship type with depCI
  usable = false
  for e in active entries ordered by order:
      vals = attribute values (main item or lookup items); skip e if any is empty and not allow_null_attribute,
             or if all are empty
      usable = true
      matches = main ? scope where all attributes equal : CIs referenced by matching lookup rows
                (exact_count_match: every payload lookup row must match the same CI; else max matched count wins)
      if |matches| == 1: return it
      if |matches| > 1: return dedupe(matches)
  if not usable: error MISSING_MATCHING_ATTRIBUTES
  if dependent and rule entries gave no match and allow_fallback: retry with the parent class rule
  return INSERT
dedupe(m): if skip_duplicates (true) and |m| < skip_duplicates.threshold (5):
              main = oldest sys_created_on; others.duplicate_of = main; create de-duplication task; return main
           else error MULTIPLE_DUPLICATE_RECORDS (de-duplication task still created)
```
Insert path: IRE data source rules can forbid a source to create a class (INSERT_NOT_ALLOWED_FOR_SOURCE); dictionary-mandatory fields must be present when `glide.required.attribute.enabled` (REQUIRED_ATTRIBUTE_EMPTY); `first_discovered` = payload value or now [Documented]. Duplicate items inside one payload are merged when deduplicate_payloads is on, else DUPLICATE_PAYLOAD_RECORDS [Documented]. Partial items (identifiable later via source keys) are stored in `cmdb_ire_partial_payloads` for 90 days; incomplete ones in `cmdb_ire_incomplete_payloads` [Documented]; ResolvrNow v1 may implement them as plain log tables [Inferred].

Reclassification [Documented]: when the matched CI's class differs from `className`, apply upgrade/downgrade/switch only if allowed by the payload settings flags (precedence) and `glide.class.upgrade.enabled`, `glide.class.downgrade.enabled`, `glide.class.switch.enabled` (all default true); otherwise update in place and raise a reclassification task (RECLASSIFICATION_NOT_ALLOWED in output).

### 5.4 Reconciliation (update path) [Documented rules, Inferred tracking]
For each attribute in `values` on an update by source `src`:
1. Find the governing static rules: rules for the CI's class override those of ancestors; rules listing the attribute override "all attributes" rules; dynamic rules (CMDB 360) are out of scope for v1.
2. No governing rule: the write is allowed.
3. Otherwise `src` must own a rule; if a governing source with a smaller priority number has updated this CI (ResolvrNow table `cmdb_datasource_last_update`: ci, source, last_updated) and is not stale per its data refresh rule, the attribute is skipped.
4. Empty incoming values never overwrite non-empty ones unless listed in `update_with_null`; `glide.reconciliation.override.null` (true) lets a lower-priority source fill an empty field.
Always: `last_discovered` (unless the payload value is older), `discovery_source = src`, and `sys_object_source.last_scan` are updated. Clearing `duplicate_of` happens when IRE updates any other attribute of a duplicate CI [Documented].

## 6. Dependency views and impact analysis

Sources: https://www.servicenow.com/docs/r/servicenow-platform/dependency-views/c_NextGenBSMMaps.html, https://www.servicenow.com/docs/r/servicenow-platform/dependency-views/properties-dependency-views.html, https://www.servicenow.com/docs/r/servicenow-platform/dependency-views/t_CreateMapScript.html, https://www.servicenow.com/docs/r/it-service-management/change-management/refresh-impacted-services-cis.html

Traversal [Documented limits, Inferred algorithm]:
```
graph(root, direction in {up, down, both}, levels = glide.bsm.max_levels (3, range 1..49),
      maxNodes = glide.bsm.max_nodes (1000), maxRelsPerNode = glide.bsm.max_num_rels (100), typeFilter?)
  BFS from root; down follows cmdb_rel_ci where parent = node (to child); up follows child = node (to parent)
  per node take at most maxRelsPerNode edges (ordered by type name, then sys_id); stop adding nodes at maxNodes
  qualifier CIs (cmdb_ci_qualifier) and endpoints are skipped through (edge contracted) unless the
  "Show All Relationships" dependency type is chosen
  returns { nodes: [{sys_id, name, sys_class_name, level}], edges: [{sys_id, parent, child, type}] }
```
Impact rule [Inferred, consistent with documented descriptor meanings]: a failing CI impacts every **upstream** CI (its parents, recursively), because parents depend on, run on, are hosted on or contain their children. Example: Linux server (child of "Tomcat Runs on Linux") failing impacts Tomcat, the service instance that depends on Tomcat, the offering that depends on that service instance, and the business service owning the offering (via `service_offering.parent`). Impact traversal is unbounded in depth but cycle-safe; `glide.bsm.*` limits apply only to maps.

Affected services for a task (used by Incident/Change "Refresh Impacted Services") [Documented flow]:
1. Seed set = task.cmdb_ci + all `task_ci.ci_item` rows of the task.
2. Services = CIs INSTANCEOF `cmdb_ci_service` (excluding `service_offering`) found in: `svc_ci_assoc` rows whose ci_id is in the seed set (when `change.refresh_impacted.include_affected_cis`), plus the upstream closure of the seed set (ResolvrNow implementation of the CIUtils service lookup).
3. Delete `task_cmdb_ci_service` rows of the task with manually_added = false, insert one row per service (manually_added false). Offerings found in the closure populate `task_service_offering` the same way.
Maps also expose a dependency type hook (named server-side filters) with built-ins "Default" and "Show All Relationships" [Documented].

## 7. CI links on tasks

Sources: https://www.servicenow.com/docs/r/it-service-management/change-management/itsm-change-use-case-product-view.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/pm-use-case-product-view.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/track-ci.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/cmdb-tables-details.html

| Table / field | Columns | Rule | Status |
|---|---|---|---|
| task.cmdb_ci | reference cmdb_ci | Primary CI | [Documented] |
| task.business_service, task.service_offering | references cmdb_ci_service, service_offering | CSDM service context; offering list filtered by parent = business_service | [Documented fields] [Inferred filter] |
| task_ci (Affected CIs) | task, ci_item, manual_proposed_change (Change), applied, applied_date | Many CIs per task; ResolvrNow auto-adds task.cmdb_ci when it is set or changed (old auto row kept) | [Documented table and Change column] [Inferred auto-add] |
| task_cmdb_ci_service (Impacted Services/CIs) | task, cmdb_ci_service, manually_added | Filled by refresh (section 6) or manually | [Documented] |
| task_service_offering | task, service_offering, manually_added | Offerings related list | [Documented list] [Inferred columns] |
| svc_ci_assoc | service_id (cmdb_ci_service), ci_id (cmdb_ci) | Membership of CIs in service instances | [Documented] |

Uniqueness: (task, ci_item), (task, cmdb_ci_service), (task, service_offering) [Inferred]. Incident "Asset Action" on affected CIs (No action, Update/Repair, Swap, Retire; events `sn_hamp_asset.swap`/`sn_hamp_asset.retire`) belongs to the HAM plugin and is out of scope for v1 [Documented].

## 8. CMDB Health

Sources: https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/r_CMDBHealthMetrics.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/overview-cmdb-health.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/config-cmdb-health-metric-weights.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/t_CreateCMDBHealthOrphanRule.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/t_CreateCMDBHealthStaleRule.html, https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/create-health-inclusion-rule.html

### 8.1 Metrics [Documented definitions]

| KPI | Metric | A CI (or relationship) fails when |
|---|---|---|
| Completeness | Required | a dictionary-mandatory field of its class is empty |
| Completeness | Recommended | a field marked recommended for its class (or ancestor) is empty; none are marked by default |
| Correctness | Orphan | it matches its class orphan rule (attribute condition AND/OR relationship condition: no relationships at all, or lacking given relationship type/class); one rule per class |
| Correctness | Staleness | `sys_updated_on` older than the effective duration of the nearest staleness rule; seed rule on cmdb_ci = 60 days; dependent CIs excluded when `glide.cmdb.health.staleness_exclude_dependent_cis` |
| Correctness | Duplicate | it belongs to a set of independent CIs sharing the same identifier-entry values; failures per set = size - 1 |
| Compliance | Audit | it fails any compliance audit of the latest complete audit run (KPI absent when no audits exist) |
| Relationships | Duplicate / Orphan / Stale | same parent, child, type and port / missing parent or child / parent or child stale; also counts relations not compliant with suggested, hosting or containment rules |

Health inclusion rules (applies_to class, condition, metrics) restrict which CIs are evaluated; child-class rules replace parent ones; none by default [Documented].

### 8.2 Scoring [Documented weights where stated, Inferred elsewhere]
- Metric score per class = 100 x (evaluated - failed) / evaluated (100 when nothing is evaluated).
- KPI score = weighted mean of its metric scores: Completeness = Required 60 %, Recommended 40 % [Documented]; Correctness = Orphan, Staleness, Duplicate one third each [Inferred]; Compliance = Audit 100 %.
- Overall = weighted mean of the KPIs present, equal weights by default [Inferred]; weights stored in `cmdb_health_metric_pref` (weighted average contribution, must sum to 100 per level) [Documented].
- Results per CI and metric in `cmdb_health_result` (ci, metric, state pass/fail, details, last_run) [Inferred name]; scorecards aggregate by class, service and health group.
- Jobs: one "CMDB Health Dashboard" job per KPI, disabled at install, daily when enabled; a metric processor stops after `glide.cmdb.health.metricProcessor.maxRunningTime` (120 min) [Documented]. Ownership charts use `glide.cmdb.health.ci_ownership_field` (managed_by_group) [Documented].

## 9. CSDM

Sources: https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/csdm-content-frame-exploring.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/foundation-domain.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/design-domain.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/build-domain.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/manage-tech-servs-domain.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/sell-consume-domain.html, https://www.servicenow.com/docs/r/servicenow-platform/common-service-data-model-csdm/ci-relationships.html

| Domain | Tables | ResolvrNow v1 |
|---|---|---|
| Foundation | cmn_location, core_company, cmn_department, business_unit, sys_user, sys_user_group, cmdb_model (+ product model classes), ast_contract, cmdb_group | yes (SDK) |
| Ideation and Strategy | sn_align_core_planning_item, sn_align_core_product_idea | no |
| Design and Planning | cmdb_ci_business_app, cmdb_ci_business_capability, cmdb_ci_information_object | business app yes |
| Build and Integration | agile development component | no |
| Service Delivery | cmdb_ci_service_technical, service_offering (technical), cmdb_ci_service_auto and children, cmdb_ci_query_based_service, cmdb_ci_appl, infrastructure CIs | yes |
| Service Consumption | cmdb_ci_service_business (and legacy cmdb_ci_service), service_offering (business), sc_catalog | yes |
| Manage Portfolio | spm_service_portfolio, spm_taxonomy_node | no |

Required relationships [Documented]: business offering Depends on::Used by service instance; service instance Depends on::Used by application and Depends on::Used by (or Sends data to) another service instance; application Runs on::Runs infrastructure CI; technology management offering Contains::Contained by service instance or dynamic CI group; business application Uses::Used by service instance (v5; earlier Consumes::Consumed by; only application services); business application Uses::Used by information object; capability with business application/business service via Provides::Provided by; business service to offering and technology service to offering via the `service_offering.parent` reference (not a relationship); dynamic CI group members via its CMDB group query.

Rules for ResolvrNow [Inferred unless noted]:
- `service_classification` on cmdb_ci_service family: Business Service, Application Service, Technical Service, Service Offering, Shared Service, Billable Service [Documented values]; ResolvrNow derives it from class on insert (offering of a technical service = Technical Service).
- Every operational business or technology management service should have at least one offering [Documented guidance]; ResolvrNow reports, not blocks.
- Business application data belongs in cmdb_ci_business_app, never cmdb_ci_appl [Documented].
- A CI linked through a dynamic CI group can belong to only one technology management offering [Documented]; ResolvrNow warns on conflict.
- CSDM life cycle: `life_cycle_stage`/`life_cycle_stage_status` pairs (Ideation, Purchase, Design, Inventory, Deploy, Operational, End of Operation, Defective, Missing, End of Life) [Documented stage list]; sync with legacy status fields governed by `csdm.lifecycle.migration.activated` and `csdm.lifecycle.sync.between.ci.and.asset.activated` (default false) as in `asset.md` 6.10 [Documented].

## 10. REST APIs

Common [Documented]: role `itil`; JSON or XML (`Accept`, `Content-Type`); versioned form `/api/now/{api_version}/cmdb/...` (ResolvrNow accepts `v1`) and default form `/api/now/cmdb/...`. Errors: `{"error": {"message": "...", "detail": "..."}, "status": "failure"}` with 400 (bad request), 401, 404 (class or record not found), 405 (API disabled), 500. `className` must be `cmdb_ci` or a descendant, else 400 [Inferred].

Sources: https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-instance-api.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-meta-api.html

### 10.1 CMDB Instance API

| Method and path | Request | Response (200) |
|---|---|---|
| GET /now/cmdb/instance/{className} | `sysparm_query` (encoded query, ORDERBY allowed, invalid parts ignored unless `glide.invalid_query.returns_no_rows`), `sysparm_limit` (default 10000), `sysparm_offset` (default 0) | `{"result": [{"sys_id": "...", "name": "..."}]}` for CIs INSTANCEOF className |
| GET /now/cmdb/instance/{className}/{sys_id} | none | `{"result": {"attributes": {...}, "outbound_relations": [...], "inbound_relations": [...]}}` |
| POST /now/cmdb/instance/{className} | `{"attributes": {...}, "source": "<discovery_source choice>", "outbound_relations": [{"type": "<cmdb_rel_type sys_id>", "target": "<CI sys_id>"}], "inbound_relations": [...]}`; source required | created or matched CI, same shape as GET one |
| PUT /now/cmdb/instance/{className}/{sys_id} | `{"attributes": {...}, "source": "..."}` | updated CI; merge semantics (absent attributes untouched); relations untouched |
| PATCH /now/cmdb/instance/{className}/{sys_id} | same as PUT | same as PUT |
| POST /now/cmdb/instance/{className}/{sys_id}/relation | `{"outbound_relations": [...], "inbound_relations": [...], "source": "..."}` | the CI with all relations |
| DELETE /now/cmdb/instance/{className}/{sys_id}/relation/{rel_sys_id} | none | empty body |

Response details [Documented]:
- `attributes`: every column of the CI's actual class, as strings (`"true"`, `"2048"`, `""` for empty, date-times `YYYY-MM-DD HH:MM:SS`); non-empty references become `{"display_value", "link": "<base>/api/now/table/<table>/<sys_id>", "value"}`; empty references are `""`.
- Each relation: `{"sys_id": "<cmdb_rel_ci>", "type": {"display_value": "Depends on::Used by", "link": "<base>/api/now/table/cmdb_rel_type/<id>", "value": "<id>"}, "target": {"display_value": "<name>", "link": "<base>/api/now/cmdb/instance/cmdb_ci/<id>", "value": "<id>"}}`. Outbound = this CI is parent (target is child); inbound = this CI is child (target is parent).

Write semantics [Documented intent, Inferred mechanics]:
- POST runs IRE (section 5) with one item `{className, values: attributes}`, `source` as discovery source, and the relations converted to payload relations (outbound: this CI parent, target child; inbound: target parent). For a dependent class the relations must point to an existing CI, else 400 with MISSING_DEPENDENCY detail (the platform reports a generic failure).
- `source` not in the `discovery_source` choices -> 400.
- PUT/PATCH run reconciliation for `source`; attributes the source may not write are skipped silently.
- relation POST: the path CI is the parent for outbound entries; existing identical relationships are not duplicated.
- DELETE relation: `rel_sys_id` must have the path CI as parent or child, else 404.

### 10.2 CMDB Meta API

`GET /now/cmdb/meta/{className}` returns [Documented sample shape]:
```json
{"result": {"name": "cmdb_ci_computer", "label": "Computer", "parent": "cmdb_ci_hardware", "is_extendable": true,
  "children": ["cmdb_ci_server", "cmdb_ci_pc_hardware"], "icon": "<sys_id>", "icon_url": "images/app.ngbsm/computer.svg",
  "attributes": [{"element": "os_address_width", "label": "OS Address Width (bits)", "type": "integer", "max_length": "40",
                  "is_inherited": "false", "is_mandatory": "false", "is_read_only": "false", "is_display": "false", "default_value": null}],
  "relationship_rules": [{"parent": "cmdb_ci_computer", "relation_type": "<cmdb_rel_type sys_id>", "child": "cmdb_ci_storage_device"}],
  "identification_rules": {"name": "Hardware Rule", "description": "...", "active": true, "is_independent": true,
     "applies_to": "cmdb_ci_hardware",
     "identifiers": [{"order": 200, "attributes": "serial_number", "table": null, "referenced_field": null, "condition": null,
                      "active": true, "allow_null_attribute": false, "allow_fallback": false, "exact_count_match": false}],
     "related_rules": [{"table": "cmdb_print_queue_instance", "referenced_field": "installed_on", "attributes": "name", "order": 100, "...": "..."}]}}}
```
Rules [Inferred]: `children` = direct subclasses; `attributes` = all columns incl. inherited (`is_inherited` "true" when defined on an ancestor); `relationship_rules` = suggested relationships whose base class is exactly className, oriented parent/child; `identification_rules` = the effective (own or inherited) rule, `applies_to` naming the class that owns it; `icon`/`icon_url` from class metadata (may be empty in ResolvrNow).

## 11. Acceptance tests

1. Given the registry, When querying `cmdb_ci_server`, Then rows of cmdb_ci_linux_server and cmdb_ci_win_server are returned and `sys_class_nameINSTANCEOFcmdb_ci_computer` also matches them.
2. Given a cmdb_ci_linux_server with kernel_release set, When reclassified to cmdb_ci_win_server, Then sys_id is unchanged, sys_class_name is cmdb_ci_win_server and kernel_release is empty.
3. Given a CI, When operational_status is set to 6, Then install_status becomes 7; When install_status later changes to 1, Then operational_status becomes 2.
4. Given relationship type Depends on::Used by, When creating cmdb_rel_ci (parent A, child B), Then GET instance for A lists B under outbound_relations and GET for B lists A under inbound_relations with type display_value "Depends on::Used by".
5. Given an existing (A, B, Depends on::Used by, port empty), When the same row is inserted again, Then it is rejected; a row with parent = child is rejected.
6. Given suggestions on cmdb_ci_hardware and cmdb_ci_server, When listing suggestions for a Linux server, Then both appear.
7. Given suggested rule cmdb_ci_appl Runs on::Runs cmdb_ci_hardware, When validating a cmdb_ci_appl_dot_net Runs on a cmdb_ci_win_server relation, Then it is valid by inheritance.
8. Given the Hardware rule, When IRE receives a cmdb_ci_linux_server with serial_number "S1" and name "n1" and a CI with serial "S1" exists, Then that CI is updated (not inserted).
9. Given no serial match, When the payload has name "n1" equal to an existing computer's name, Then the computer is matched by the order-300 entry and upgraded to cmdb_ci_linux_server (class upgrade allowed).
10. Given `glide.class.downgrade.enabled` false, When a payload of class cmdb_ci_computer matches a cmdb_ci_server, Then the class is kept and a reclassification task exists.
11. Given three CIs with name "dup" and no serial, When IRE matches on name, Then the oldest is updated, the other two get duplicate_of = oldest, and one de-duplication task is created; with six such CIs IRE returns MULTIPLE_DUPLICATE_RECORDS.
12. Given a payload item without serial_number, name, or adapters, Then IRE returns MISSING_MATCHING_ATTRIBUTES and nothing is written.
13. Given the dependent Application rule, When an application item arrives without a Runs on::Runs relation, Then MISSING_DEPENDENCY; with the relation to an identified server, Then two applications with the same name on two different servers are two different CIs.
14. Given static rules Discovery priority 100 and ImportSet priority 200 on cmdb_ci_computer.name, When ImportSet updates name of a CI last updated by Discovery (no data refresh rule), Then name is unchanged but last_discovered and discovery_source are updated.
15. Given test 14 plus a data refresh rule for Discovery with effective duration 0, When ImportSet updates name, Then the new name is written.
16. Given a payload with last_discovered older than the CI's, Then last_discovered is not changed; without a value it is set to now; first_discovered is set only on insert.
17. Given chain Service S -Depends on-> Instance I -Depends on-> Tomcat T -Runs on-> Linux L, When computing impact of L, Then T, I and S are returned; with direction down from S and levels 2, Then I and T only.
18. Given the chain of test 17 and an incident with cmdb_ci = L and one manually added service M, When Refresh Impacted Services runs, Then task_cmdb_ci_service has I and S (manually_added false) and M is kept; running it twice gives no duplicates.
19. Given an incident whose cmdb_ci is set to L, Then a task_ci row (task, L) exists; changing cmdb_ci to L2 adds (task, L2) and keeps L.
20. Given a staleness rule of 60 days on cmdb_ci and 10 days on cmdb_ci_server, When a server was updated 20 days ago and a router 20 days ago, Then the server fails Staleness and the router passes; relationships touching the server are stale.
21. Given an orphan rule on cmdb_ci_disk "has no Contains::Contained by with cmdb_ci_computer", When a disk has no such relationship, Then it fails Orphan.
22. Given completeness results Required 80 and Recommended 50, Then the Completeness KPI is 68.
23. Given `GET /api/now/cmdb/instance/cmdb_ci_linux_server?sysparm_limit=1&sysparm_offset=1`, Then exactly the second Linux server (default order) is returned as {sys_id, name}.
24. Given POST /api/now/cmdb/instance/cmdb_ci_linux_server without `source`, Then 400 with status failure; with source "ServiceNow", attributes {name: "lnux999"} and one outbound relation, Then 200 and the response includes the new outbound relation.
25. Given PUT with attributes {ram: "4096"} and source "ServiceNow", Then ram changes, other attributes and relations are unchanged.
26. Given DELETE relation with a rel_sys_id not involving the path CI, Then 404; with a valid one, Then the cmdb_rel_ci row is gone.
27. Given GET /api/now/cmdb/meta/cmdb_ci_computer, Then parent is cmdb_ci_hardware, children include cmdb_ci_server, identification_rules.applies_to is cmdb_ci_hardware with four identifiers ordered 100..400, and inherited attributes carry is_inherited "true".
28. Given a business offering O (parent business service B) Depends on::Used by service instance I, When computing impact of a CI under I, Then O and B are impacted (B through O.parent).
