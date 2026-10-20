# ResolvrNow platform core specification

Scope: everything the ITSM modules (Incident, Problem, Change, Request, Knowledge) depend on: identity and roles, access control, the dictionary, the record save pipeline (business rules and engines), UI metadata (UI policies, UI actions, forms, lists), history (journal, audit, activity stream), routing (assignment and data lookup rules), metrics and state models.

Companion specs: `notifications-events.md` (events, email), `approvals-flows.md` (approvals, Workflow Studio subset). Machine-readable data: `data/platform.json`.

## 0. Conventions

| Marker | Meaning |
|---|---|
| **[Documented]** | Stated in the public ServiceNow "Brazil" documentation corpus; the URL is cited in the section header. Restated in our own words. |
| **[Inferred]** | Not stated in the corpus. Derived from the SDK data model (`server/src/schema/sdk/sdk-tables.json`), from widely known platform behavior, or a ResolvrNow design decision (then labelled "ResolvrNow decision"). |

Engine mapping used throughout:

| Concern | ResolvrNow mechanism |
|---|---|
| Table and field metadata | TypeScript `TableDef` declarations, registered in `SchemaRegistry`, mirrored into `sys_db_object`, `sys_dictionary`, `sys_dictionary_override`, `sys_choice`. Runtime dictionary edits write the mirror rows and call `registry.addColumn` [Inferred, ResolvrNow decision]. |
| Storage | SQLite, one physical table per hierarchy root, `sys_class_name` discriminator (table per hierarchy) [Inferred, ResolvrNow decision]. |
| Server logic | Native TypeScript rules or sandboxed QuickJS scripts exposing `current`, `previous`, `gs`, `GlideRecord`, `GlideRecordSecure`, `g_scratchpad`, `action` [Inferred, ResolvrNow decision]. |
| Request context | `ctx = {userId, realUserId, roles (closure), groups, elevatedRoles, sessionId, interactive, messages[], scratchpad}` built once per request [Inferred, ResolvrNow decision]. |
| Module metadata | Modules (see `docs/dev/modules.md`) declare `rules`, `acls`, `ui` (navigation, lists, forms, uiActions, uiPolicies), `events`, `eventHandlers`, `jobs`, `properties`. Declarations are mirrored into `sys_script`, `sys_security_acl` (+ `native_id`), `sys_ui_*`, `sysevent_register`, `sys_properties` so the Table API shows them; native code stays authoritative for native entries [Inferred, ResolvrNow decision]. |
| Deferred work | Durable SQLite queues: `sysevent` (events), `sys_trigger` (async business-rule jobs), `sys_flow_context` (flows), `sys_email` (outbound mail), drained by an in-process scheduler outside the request transaction [Inferred, ResolvrNow decision]. |

---

## 1. Users, groups and roles

Sources: https://www.servicenow.com/docs/r/platform-administration/user-administration/exploring-user-administration.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/user.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_CreateAGroup.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_AddAUserToAGroup.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/c_ConfigGroupTypesForAssignGroups.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_CreateARole.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_AssignRoleToGroup.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_AssignARoleToAUser.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_AddARoleToAnExistingRole.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_CreateAGroupRole.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/r_BaseSystemRoles.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/base-system-roles.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/r_SpecialAdministrativeRoles.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/c_DelegateRoles.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_PreventARoleFromBeingDelegated.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/audit-user-roles.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/time-limited-role-overview.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/c_ImpersonateAUser.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_ImpersonateAUserInUI16.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/c_LogImpersonations.html · https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/user-access-knowledge.html · https://www.servicenow.com/docs/r/roles-by-product/roles_knowledgemanagement.html · https://www.servicenow.com/docs/r/roles-by-product/roles_servicecatalog.html

### 1.1 Tables

| Table | Purpose | Key fields | Basis |
|---|---|---|---|
| `sys_user` | Person or service account | `user_name` (login ID), `first_name`, `last_name`, `name`, `email`, `active` (default true), `locked_out`, `web_service_access_only`, `identity_type` (human, machine, ai_agent, unclassified), `manager`, `company`, `department`, `location`, `title`, `vip`, `time_zone`, `preferred_language`, `notification` (integer, default 2), `user_password`, `last_login_time`, `failed_attempts`, `roles` (read-only role summary) | SDK; meaning Documented |
| `sys_user_group` | Group of users | `name`, `manager`, `email`, `parent`, `active`, `type` (list of `sys_user_group_type`), `include_members`, `exclude_manager`, `default_assignee`, `description` | SDK + Documented |
| `sys_user_grmember` | Membership | `user`, `group` | Documented (used by the assignment-group qualifier example) |
| `sys_user_role` | Role | `name` (immutable after save), `description`, `elevated_privilege`, `can_delegate` (default true), `grantable` (default true), `assignable_by`, `includes_roles`, `suffix` | SDK + Documented |
| `sys_user_role_contains` | Role containment | `role` (container), `contains` (contained role) | SDK |
| `sys_group_has_role` | Role granted to group | `group`, `role`, `inherits` (default true: members receive the role) | Documented ("Group Roles" form) |
| `sys_user_has_role` | Effective/explicit role rows per user | `user`, `role`, `inherited`, `granted_by` (group), `included_in_role`, `inheritance_count`, `state` | Table Documented (role engine); columns Inferred |
| `sys_user_delegate` | Delegation windows | see `approvals-flows.md` §5 | Inferred |
| `sys_audit_role` | Role change log | `user`, `role`, `operation` (added/removed), `granted_by` (group), `count_after_change`, `changed_by` | Documented |

Display fields: `sys_user.name`, `sys_user_group.name`, `sys_user_role.name` [Inferred]. `sys_user.name` is maintained as "first_name last_name" on insert/update when the user did not supply it [Inferred].

### 1.2 Effective roles

Rules:
- A user holds the roles assigned directly plus every role of every group they belong to; changing groups changes roles [Documented].
- A child group inherits the parent group's roles; members of the child are not members of the parent (so parent-group assignment pickers do not list child members) [Documented].
- A role that contains another role grants everything the contained role grants, transitively [Documented].
- A group role with `inherits=false` is held by the group but not passed to members [Documented].
- The "role engine" keeps `sys_user_has_role` in sync whenever `sys_user`, `sys_user_group`, `sys_user_grmember` or `sys_user_role` change; it runs both as a before and an after engine (§4.2) [Documented].
- New roles apply at the user's next session [Documented]. ResolvrNow bumps a global `roleVersion` counter on any change to the four tables; sessions recompute their role closure on the next request when the counter moved (ResolvrNow decision, superset of the documented behavior) [Inferred].
- Elevated-privilege roles (for example `security_admin`) are never active at login; they become active only after an explicit elevation in the session [Documented].

Algorithm [Inferred]:

```
effectiveRoles(user, session):
  explicit = { r.role | r in sys_user_has_role(user=user, inherited=false, state='active') }
  viaGroups = {}
  for m in sys_user_grmember(user=user):
     g = m.group
     while g != null:                                  // child inherits parent roles
        viaGroups += { gr.role | gr in sys_group_has_role(group=g, inherits=true) }
        g = g.parent                                   // guard against cycles (visited set)
  base = explicit ∪ viaGroups
  closure = fixpoint(base, r -> { c.contains | c in sys_user_role_contains(role=r) })
  return { r ∈ closure | !r.elevated_privilege or r ∈ session.elevated }
```

Materialization (role engine, ResolvrNow) [Inferred]: for every role reached through a group or containment, ResolvrNow upserts a `sys_user_has_role` row with `inherited=true`, `granted_by=<group>` and/or `included_in_role=<container>`, incrementing `inheritance_count` per distinct source and deleting the row when the count reaches zero. This keeps `GET /api/now/table/sys_user_has_role` compatible. `sys_user.roles` is a comma list of the closure, refreshed by the same engine. Each add/remove writes `sys_audit_role` [Documented].

Role checks:
- `gs.hasRole(x)`: true if `x` is in the closure, or the user has `admin` and `x != 'nobody'` (admin passes every role check) [Documented for admin; nobody handling Inferred].
- `gs.hasRoleExactly(x)`: closure membership only, no admin bypass [Inferred].
- Group checks `gs.getUser().isMemberOf(name|sys_id)` use `sys_user_grmember` only, not parent groups [Inferred].

Granting rules (enforced by before rules on `sys_user_has_role`, `sys_group_has_role`, `sys_user_grmember`) [Documented]:

| Rule | Error |
|---|---|
| Only a holder of `admin` may grant `admin` (to a user or a group, or add a user to a group carrying `admin`). | abort, message "insufficient rights" |
| Only a holder of an elevated `security_admin` may grant `security_admin` (same three paths). | abort |
| Inherited rows (`inherited=true`) cannot be deleted from the user; remove the membership instead. | abort |
| `sys_user_role.name` cannot change after insert. | abort |
| `admin`, `public`, `role_delegator` are never delegable; a role delegator may only delegate roles they hold, for groups they manage, and only roles with `can_delegate=true` and `grantable=true`. | abort (delegation is v2 scope) |

### 1.3 Group semantics used by other modules

| Behavior | Basis |
|---|---|
| Inactive groups stay valid in existing references but are hidden from non-admin lists, reference pickers and auto-complete. ResolvrNow: a `sys_user_group` before-query rule adds `active=true` for non-admin interactive sessions on picker/list endpoints only. | Documented (behavior), Inferred (mechanism) |
| Group `type` categorizes groups (base types `catalog`, `itil`, `survey`); the base qualifier on `task.assignment_group` keeps groups whose type is `itil` (groups with an empty type are also allowed). | Documented |
| `include_members`: members also receive individual mails when mail goes to the group; approval mails always reach every member. `exclude_manager`: manager does not receive group notifications. | Documented (details in notifications spec §3.4) |
| Removing a parent from a group copies the parent's roles to the child, synchronously unless `glide.ui.schedule_job_for_group_parent_change=true`. | Documented |

### 1.4 Base roles relevant to ITSM

"Contains" lists are as documented (trimmed to ITSM-relevant entries for `admin`). Full machine list in `data/platform.json` → `constants.baseRoles`.

| Role | What it grants (ResolvrNow meaning) | Contains | Basis |
|---|---|---|---|
| `admin` | Passes every role check and every ACL whose `admin_overrides=true`; cannot pass `nobody`. | catalog_admin, catalog, import_admin, image_admin, personalize_dictionary, user_criteria_admin, sp_admin, ... | Documented |
| `itil` | Base fulfiller: open/update/close incidents, problems, changes; read CMDB; may be assigned tasks (task `assigned_to` qualifier keeps itil users). | agent_workspace_user, cmdb_read, cmdb_query_builder, email_composer, snc_platform_rest_api_access, sn_incident_write, sn_problem_write, sn_change_write, sn_request_write, template_editor, view_changer, survey_reader, ... | Documented |
| `itil_admin` | Team lead: delete incidents, problems, changes (with itil); full CMDB control. | assessment_admin, cmdb_read, sn_bm_client.benchmark_data_viewer | Documented |
| `approver_user` | Act on approvals routed to them (plus requester abilities). | none | Documented |
| `approval_admin` | View/modify approvals not assigned to them. | none | Documented |
| `catalog_admin` | Manage Service Catalog (catalogs, categories, items), no scripting. | user_criteria_admin, catalog_builder_editor, catalog_template_editor, catalog, catalog_lookup_admin | Documented |
| `catalog` | Read and some write on catalog requests, tasks, items. | none | Documented |
| `catalog_editor` / `catalog_manager` | Edit items in assigned catalogs/categories; manager also assigns editors. | none | Documented |
| `knowledge` | Contribute to the default knowledge base, Knowledge menu. | none | Documented |
| `knowledge_admin` | Administer all knowledge bases (not scoped ones). | knowledge (subordinate) | Documented |
| `knowledge_manager` | Administer knowledge bases they manage; auto-granted to KB managers. | knowledge (subordinate) | Documented |
| `user_admin` | Administer users, groups, locations, companies. | skill_admin, fsm_skill_admin, territory_admin | Documented |
| `assignment_rule_admin`, `business_rule_admin`, `client_script_admin`, `ui_action_admin`, `ui_policy_admin`, `form_admin`, `script_include_admin` | CRUD on the matching metadata tables only. | none | Documented |
| `personalize` | Configure forms, lists, rules, controls, scripts. | personalize_control, personalize_rules, personalize_dictionary, personalize_choices, personalize_styles, personalize_responses, personalize_list, personalize_form | Documented |
| `personalize_rules` | Configure business rules and scripts. | business_rule_admin, client_script_admin, ui_policy_admin, ui_action_admin | Documented |
| `personalize_choices` | Edit choices; must be granted explicitly (not via ACL) to use "Show Choice List". | none | Documented |
| `template_editor`, `view_changer`, `list_updater`, `task_editor` | Personal templates; switch views; "Update selected/entire list"; edit protected task fields. | none | Documented |
| `snc_platform_rest_api_access` | Table, Import Set, Aggregate and Attachment REST APIs when their API ACLs are active. | none | Documented |
| `impersonator` | Impersonate users; never an admin user. | none | Documented |
| `security_admin` | Elevated; required to create/modify ACLs. | none | Documented (elevation), Inferred (scope) |
| `public` / `user` / `nobody` | Unauthenticated access / no function / no one, including admin. | none | Documented |
| `snc_internal` / `snc_external` | Explicit roles: internal vs external users (see 1.5). | none | Documented |
| `metric_admin`, `state_model_admin`, `data_lookup_admin`, `flow_designer`, `action_designer` | Manage metric definitions / state models / priority lookups / flows / actions. | none | Documented |

### 1.5 Explicit roles `snc_internal` / `snc_external`

- Provided by the Explicit Roles plugin (`com.glide.explicit_roles`); when active, every existing user gets `snc_internal`; external identities (customers, consumers, kiosk users) carry `snc_external` instead [Documented].
- Knowledge bases created while the plugin is active receive default user criteria: "has snc_internal" for read and "has snc_internal plus another role" for contribute [Documented].
- ResolvrNow decision [Inferred]: property `resolvr.explicit_roles.enabled` (default true). An after-insert rule on `sys_user` grants `snc_internal` unless the creating request explicitly granted `snc_external`. Self-service ACL seeds reference `snc_internal`, never "any authenticated user", so external users see nothing by default.

### 1.6 Impersonation

Documented behavior: requires `impersonator` (or `admin`); `impersonator` cannot impersonate a user holding `admin`; the target needs a `user_name`; the session then behaves exactly as the target (menus, roles, ACLs) and every write is attributed to the target; impersonating a locked-out or inactive user logs the session out on its first action; impersonation ends on logout or when another user is impersonated; begin and end are logged (`glide.sys.log_impersonation` for interactive sessions, `glide.sys.log_impersonation.non_interactive` for others, default users system/guest/soap.guest excluded); impersonating an application admin does not unlock that application's protected modules unless the impersonator holds the role.

ResolvrNow implementation [Inferred]:

| Item | Rule |
|---|---|
| Session fields | `realUserId` (who logged in), `userId` (effective). Request context is built from `userId`; `ctx.impersonator = realUserId` when different. |
| API | `POST /api/app/session/impersonate {user}` (UI only; not accepted on Basic-auth REST calls), `POST /api/app/session/unimpersonate`. |
| Checks | caller has `impersonator` or `admin`; target active; target has no `admin` unless caller has `admin`; target `locked_out=false`. |
| Attribution | `sys_created_by`, `sys_updated_by`, `sys_audit.user`, journal `sys_created_by` = target's `user_name`. |
| Logging | `syslog` rows "Impersonate Begin"/"Impersonate End" with both user names when the property is true (default true). |

### 1.7 Time-limited roles

Documented: only `admin`, `snc_read_only`, `impersonator`, `snc_required_script_writer_permission`; at most 5 days and 4 concurrent assignments per user; hidden from the user's Roles list. ResolvrNow: out of scope for v1 [Inferred].

---

## 2. Access control (ACLs)

Sources: https://www.servicenow.com/docs/r/it-service-management/change-management/t_CreateNewACL.html · https://www.servicenow.com/docs/r/platform-administration/c_ChoiceListSecurity.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/r_ConfigListEditorContextSecurity.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/r_ExampleRestrictATable.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/r_ExampleRestrictAField.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/r_ExampleRestrictAFieldWithAScript.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/r_ExRestrictAFieldWithACondition.html · https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/c_RESTAPI.html · https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/base-system-roles.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_BusinessRules.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/read-only-option.html · https://www.servicenow.com/docs/r/platform-administration/c_ActivityFormatter.html

Note: the corpus does not contain the general "Access control list rules" chapter; the evaluation algorithm below is therefore mostly **[Inferred]** from the SDK model and well-known platform behavior, anchored by the documented examples listed.

### 2.1 Data model (SDK)

| Field (`sys_security_acl`) | Type | Meaning |
|---|---|---|
| `name` | string, mandatory | Object name: `incident`, `incident.short_description`, `incident.*`, `*.number`, `*`, or a non-record object name (REST API name, script include, UI page). |
| `type` | ref `sys_security_type`, default `record` | Object type. |
| `operation` | ref `sys_security_operation` | read, write, create, delete, list_edit, ... |
| `active` | boolean, default true | Inactive ACLs are ignored. |
| `admin_overrides` | boolean, default true | A user with `admin` passes this ACL without evaluation. |
| `decision_type` | `allow` (Allow If, default) / `deny` (Deny Unless) | See 2.4. |
| `condition` | conditions (encoded query) on the target table | Must match the record. |
| `script` | script (when `advanced=true`) | Must yield true. |
| `applies_to` | conditions | Restricts which records the ACL is considered for [Inferred semantics]. |
| roles | m2m `sys_security_acl_role(sys_security_acl, sys_user_role)` | User needs one of them. |
| `security_attribute`, `controlled_by_refs`, `local_or_existing` | | Not evaluated by ResolvrNow v1 (`controlled_by_refs` is ignored; `security_attribute` evaluated as a named reusable condition if present) [Inferred]. |

`sys_security_operation` names (ResolvrNow enforces the first seven) [Inferred]: `read`, `write`, `create`, `delete`, `list_edit` [Documented], `execute`, `report_view` [Documented], `personalize_choices` [Documented], `report_on`, `save_as_template`, `add_to_list`, `query_range`, `query_match`.

`sys_security_type` names supported by ResolvrNow [Inferred]: `record`, `rest_endpoint`, `client_callable_script_include`, `ui_page`, `processor`.

### 2.2 Name matching (record type)

| Pattern | Matches |
|---|---|
| `<table>` | Row-level (table) ACL for that table only. |
| `*` | Row-level ACL for every table. |
| `<table>.<field>` | That field on that table (and on child tables, through the ancestor walk). |
| `<table>.*` | Every field of that table. |
| `*.<field>` | That field name on any table. |
| `*.*` | Every field of every table. |

### 2.3 Evaluation order

Let `T` be the record's class (`sys_class_name`) and `A = [T, parent(T), ..., root]`. Names are tried from most to least specific; the **first name level that holds at least one active, applicable ACL for the operation decides**; less specific levels are not consulted [Inferred; this is also the order implemented in `server/src/engine/services/acl.ts`]:

| Step | Table (row) check | Field check for field `f` |
|---|---|---|
| 1 | `T` | `T.f` |
| 2 | each ancestor of `T`, nearest first | `P.f` for each ancestor `P`, nearest first |
| 3 | `*` | `*.f` (any table, this field) |
| 4 | (none) | `T.*` |
| 5 | (none) | `P.*` for each ancestor, nearest first |
| 6 | (none) | `*.*` |

Example: reading `incident.priority` tries `incident.priority`, `task.priority`, `*.priority`, `incident.*`, `task.*`, `*.*`.

When no field-level ACL exists at any step, field access follows the row-level decision (allowed when the row is allowed); when no row-level ACL exists at any step, the default decision applies (deny, except admin) [Inferred, ResolvrNow decision matching the engine].

### 2.4 Decision algorithm [Inferred]

```
canPerform(op, record, field?):            // field = null → row-level check
  if !rowLevelAllowed(op, record): return false
  if field == null: return true
  fieldOp = (op == 'create' and noFieldAclAtAnyLevel('create', record, field)) ? 'write' : op
  return decide(fieldOp, fieldLevels(record, field), record)

rowLevelAllowed(op, record) = decide(op, tableLevels(record), record)

decide(op, levels, record):
  // 1. Deny-Unless ACLs: every applicable one, at any level, must pass
  for acl in allApplicable(op, levels, decision_type='deny'):
     if !passes(acl, record): return false
  // 2. Allow-If ACLs: the first level with an applicable ACL decides, OR across that level
  for level in levels:
     acls = applicable(op, level, decision_type='allow')
     if acls not empty: return any(passes(a, record) for a in acls)
  // 3. nothing matched
  return levels are field levels ? true                 // field follows the row decision
                                 : defaultDecision(op)  // row: admin → true, everyone else → false

applicable(acl, record) = acl.active and acl.type='record' and acl.operation=op
                          and (acl.applies_to empty or matches(acl.applies_to, record))

passes(acl, record):
  if roleNames(acl) contains 'nobody': return false            // beats admin override [Documented]
  if acl.admin_overrides and user has admin: return true
  rolesOk     = roleNames(acl) empty or any(r in ctx.roles for r in roleNames(acl))
  conditionOk = acl.condition empty or matches(acl.condition, record)
  scriptOk    = !acl.advanced or acl.script empty or truthy(runScript(acl.script, {current: record}))
  return rolesOk and conditionOk and scriptOk                  // AND inside one ACL
```

Key semantics:

| Rule | Basis |
|---|---|
| Inside one ACL, roles AND condition AND script must all pass; an empty part passes. | Inferred |
| Several Allow-If ACLs on the same decisive level are OR'ed. | Inferred |
| Row-level and field-level checks are AND'ed: a field is readable only if the row is readable and the field ACL passes. | Inferred |
| `admin_overrides=true` lets admin skip the ACL; clearing it makes the ACL bind admins too (documented list-edit examples rely on this). | Documented |
| The `nobody` role denies everyone, including admin, regardless of `admin_overrides`. | Documented |
| Script ACLs: the script may assign `answer` or end with a boolean expression; `current` is the record, `gs` the session; anything other than true denies. Scripts run in the sandbox with no write access (GlideRecord writes throw). | Documented (answer pattern in examples), Inferred (sandbox rule) |
| Conditions are encoded queries evaluated in memory against the record, supporting `javascript:` dynamic values (`gs.getUserID()`, `getMyGroups()`). For `create`, the proposed record (defaults + input) is used. | Inferred |
| Default when no row-level ACL matches (property `glide.sm.default_mode`, ResolvrNow default `deny`): deny, except admin. Fields without any field ACL follow the row decision. ResolvrNow seeds explicit row ACLs for every table it ships. | Inferred, ResolvrNow decision |
| Business rules and server scripts using `GlideRecord` ignore ACLs; `GlideRecordSecure` and the REST/UI layers enforce them. | Documented |
| `write` ACL denial on a field with read access renders the field read-only; denial of `read` hides the value. | Inferred |
| `list_edit` gates cell editing in lists; editing a cell requires `write` and `list_edit` on the field, on its dependency parents and on fields depending on it. | Documented |
| `personalize_choices` on `table.field` or `table.*` lets a user edit choices for that field. | Documented |
| Activity formatter only shows changes and journal entries for fields the viewer can read (e.g. self-service users do not see work notes). | Documented |

### 2.5 Where ACLs apply

| Surface | Behavior | Basis |
|---|---|---|
| UI list | Rows failing row-level `read` are removed after the page query; the UI states how many rows security removed. Cells failing field `read` render empty. | Inferred |
| UI form | Row `read` required to open; field `read`/`write` drive hidden/read-only; `create` required for "New"; `delete` for Delete. | Inferred |
| Table API GET (list) | `sysparm_limit` is applied before ACL filtering, so a page can hold fewer rows than requested. Fields failing `read` are omitted from each result object. | Documented |
| Table API GET by sys_id | Unreadable or missing: HTTP 404, error message "No Record found", detail "Record doesn't exist or ACL restricts the record retrieval". | Inferred |
| Table API POST | Row `create` denied → HTTP 403. Field values without `create` (fallback `write`) access are dropped silently. | Inferred |
| Table API PUT/PATCH | Row `write` denied → 403; fields without field `write` are dropped silently (not an error). | Inferred |
| Table API DELETE | Row `delete` denied → 403. | Inferred |
| REST API ACLs (`type=rest_endpoint`) | One ACL per API (for example "Table API"); the Table, Aggregate, Import Set and Attachment API ACLs exist but are inactive by default; when active they require `snc_platform_rest_api_access` (contained in `itil`). | Documented |
| Web-service table flag | `sys_db_object.ws_access=false` blocks all REST access to the table (HTTP 403) regardless of ACLs. | Documented (flag), Inferred (status) |
| Dot-walked fields (`caller_id.email`) | Requires row `read` on the referenced record and field `read` on `sys_user.email`. | Inferred |
| Reference pickers | Show only rows the user can read, then apply the reference qualifier (qualifiers are not security). | Documented (qualifier ≠ security), Inferred (order) |

### 2.6 Implementation notes [Inferred, ResolvrNow decision]

- Compile ACLs per `(type, operation, name)` into an in-memory index rebuilt when `sys_security_acl` or `sys_security_acl_role` change.
- Per-request memo: key `(op, sys_class_name, sys_id, field)`.
- Condition-only and role-only Allow-If ACLs at the decisive row level may be pushed into SQL as `OR`'ed predicates for list queries; script ACLs force post-filtering. Pushdown must not change which rows are visible. By default the documented "limit before ACL" paging is kept (`resolvr.rest.acl_pushdown=false`); setting it to true filters before paging, which `rest-api.md` also allows as the stricter option.
- Creating or editing `sys_security_acl` requires elevated `security_admin` [Documented for elevated ACL edits].

---

## 3. Dictionary

Sources: https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_DataDictionaryTables.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_SystemDictionary.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/table-extension-and-classes.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/r_GlobalDefaultFields.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/r_DictionaryEntryForm.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/read-only-option.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_DictionaryAttributes.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_DictionaryOverrides.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/t_DefineADictionaryOverride.html · https://www.servicenow.com/docs/r/platform-administration/r_FieldTypes.html · https://www.servicenow.com/docs/r/platform-administration/r_DatabaseFieldTypes.html · https://www.servicenow.com/docs/r/platform-administration/r_ValidDataTypeChanges.html · https://www.servicenow.com/docs/r/platform-administration/c_JournalFields.html · https://www.servicenow.com/docs/r/platform-administration/t_CreatingADocumentIDField.html · https://www.servicenow.com/docs/r/platform-administration/condition-field-types.html · https://www.servicenow.com/docs/r/platform-administration/c_ChoiceLists.html · https://www.servicenow.com/docs/r/platform-administration/c_DetermValsAssocWChoicesScripting.html · https://www.servicenow.com/docs/r/platform-administration/c_IntValsForDfltChoiceList.html · https://www.servicenow.com/docs/r/platform-administration/c_BPForStateFieldChoiceValues.html · https://www.servicenow.com/docs/r/platform-administration/t_ViewChoiceListDefinitions.html · https://www.servicenow.com/docs/r/platform-administration/t_MakingAFieldDependent.html · https://www.servicenow.com/docs/r/platform-administration/c_ReferenceField.html · https://www.servicenow.com/docs/r/platform-administration/t_CascadeDeleteRules.html · https://www.servicenow.com/docs/r/platform-administration/t_DefineTheReferenceKey.html · https://www.servicenow.com/docs/r/platform-administration/c_DisplayValues.html · https://www.servicenow.com/docs/r/platform-administration/t_SelectTheDisplayValue.html · https://www.servicenow.com/docs/r/platform-administration/c_ReferenceQualifiers.html · https://www.servicenow.com/docs/r/platform-administration/t_ConfigureReferenceQualifiers.html · https://www.servicenow.com/docs/r/platform-administration/c_UseTheINSTANCEOFOperator.html · https://www.servicenow.com/docs/r/platform-administration/c_ManagingRecordNumbering.html · https://www.servicenow.com/docs/r/platform-administration/t_AutoNumberingRecordsInATable.html · https://www.servicenow.com/docs/r/platform-administration/t_PreventNumberingGaps.html · https://www.servicenow.com/docs/r/platform-administration/c_EnforcingUniqueNumbering.html · https://www.servicenow.com/docs/r/platform-administration/t_SpecifyingADefaultValue.html · https://www.servicenow.com/docs/r/platform-administration/t_MakingAFieldMandatory.html · https://www.servicenow.com/docs/r/platform-administration/t_RequiringUniqueValuesForAField.html · https://www.servicenow.com/docs/r/platform-administration/c_DataPolicy.html · https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html

### 3.1 Tables and mirroring

- `sys_db_object` holds one row per table (name, label, `super_class`, `is_extendable`, `number_ref` → `sys_number`, access flags, `ws_access`) [Documented/SDK].
- `sys_dictionary` holds one "collection" row per table (internal type `collection`, element empty) plus one row per column; attributes set on the collection row apply to the table [Documented].
- `sys_documentation` holds labels/hints per language [Documented]. ResolvrNow stores English labels in `sys_dictionary.column_label` and mirrors to `sys_documentation` (v2) [Inferred].
- Every table gets system fields `sys_id` (GUID), `sys_created_on`, `sys_created_by`, `sys_updated_on`, `sys_updated_by`, `sys_mod_count`, and `sys_class_name` when extensible [Documented]. `sys_created_by`/`sys_updated_by` store the user name string, not a reference [Documented].
- Extension models: ResolvrNow implements table-per-hierarchy for all hierarchies (task, cmdb, sys_metadata) [Documented model; ResolvrNow decision to use it everywhere]. Querying a parent returns child rows; querying a child filters `sys_class_name IN (child + descendants)`.
- Dictionary changes on a parent apply to all children unless overridden [Documented]. Type changes on populated columns are allowed only between logical types sharing a physical type (e.g. string ↔ choice), string → GUID only when all values are sys_ids [Documented].
- `extensions_only=true` on a table (task) forbids inserting rows of exactly that class [Documented attribute]; ResolvrNow returns HTTP 400 on such inserts [Inferred].

### 3.2 Field types

Storage classes refer to SQLite affinity used by ResolvrNow (`server/src/engine/types.ts`). "API value" is `sysparm_display_value=false` output; "display" is `true` output [Inferred unless noted].

| Type | Storage | API value | Display value / notes |
|---|---|---|---|
| `string` | text | as stored | Max length is logical; ≤254 renders single-line, ≥255 multi-line [Documented] |
| `choice` | text | choice value | Choice label in session language |
| `integer` | integer | decimal string | Choice label if choices exist; else number |
| `longint` | integer | decimal string | |
| `decimal` | real | 2 fraction digits by default (`scale` attribute) [Documented] | Locale formatted |
| `float` | real | scale 7 [Documented] | |
| `currency`, `price` | real (+ currency code via attributes) | "USD;12.50" style in ResolvrNow v2; v1 plain number | Formatted with symbol [Documented: 4 internal digits for currency] |
| `percent_complete` | real | number | Bar in UI |
| `boolean` | integer 0/1 | "true"/"false" | "true"/"false"; mandatory has no effect [Documented] |
| `glide_date_time` | text `YYYY-MM-DD HH:MM:SS` UTC | UTC string | User time zone and format [Documented] |
| `glide_date` | text `YYYY-MM-DD` | as stored | User date format |
| `glide_time` | text `1970-01-01 HH:MM:SS` | as stored | Time in user zone |
| `due_date` | text UTC date-time | as glide_date_time | as glide_date_time |
| `glide_duration`, `timer` | integer milliseconds (ResolvrNow) | `1970-01-01 HH:MM:SS` epoch offset string | "N Days HH:MM:SS" |
| `reference` | text(32) sys_id (or `reference_key` value) | sys_id + link object | Display field of target (§3.8) [Documented] |
| `glide_list` | text, comma-separated sys_ids (and raw emails for user lists) | comma list | Comma list of display values |
| `document_id` | text(32) sys_id; table in `dependent` field | sys_id | Display value of target in the dependent table [Documented] |
| `journal`, `journal_input`, `journal_list` | none (rows in `sys_journal_field`) | latest entries text | §7.1 [Documented] |
| `html`, `translated_html` | text | raw HTML | Sanitized HTML (`html_sanitize` attribute) |
| `translated_text` | text | value | Translation per session language |
| `multi_two_lines`, `wiki_text`, `url`, `email`, `phone_number`, `ph_number`, `ip_address` | text | as stored | `url` clickable when locked [Documented] |
| `GUID` | text(32) | as stored | |
| `sys_class_name`, `table_name` | text(80) | table name | Table label |
| `field_name`, `field_list` | text | element name(s), dependent on a table field | Labels |
| `conditions` | text encoded query | encoded query | Human-readable when `readable` attribute [Documented] |
| `condition_string`, `script`, `script_plain`, `script_server` | text | source | |
| `json`, `name_values` | text (JSON) | JSON string | |
| `user_roles` | text comma role names | | |
| `password` | text one-way hash | never returned | `********` |
| `password2` | text encrypted | never returned in clear | `********` |
| `image`, `user_image` | text (attachment ref) | | |
| `domain_id` | text(32) | | ResolvrNow: always `global` (no domain separation v1) |
| `days_of_week` | text digits `1..7` | | |
| `variables` | none (catalog variable tables) | | Out of platform scope |

### 3.3 Dictionary entry attributes that ResolvrNow honors

| Field / attribute | Semantics | Basis |
|---|---|---|
| `mandatory` | Value required on UI submit. Not enforced for web services or scripts (use data policy, §5.3). | Documented |
| `read_only` + `read_only_option` | `display_read_only`: read-only in UI only, API/scripts may write. `client_script_modifiable`: UI read-only, client scripts may set it, server APIs (Table API, GlideRecordSecure) may not. `strict_read_only`: nobody may change it. `instance_configured`: behavior from `glide.read_only.legacy_read_only_behavior` (default `client_script_modifiable`). Plain `GlideRecord` server scripts are not blocked except under strict. | Documented (ResolvrNow: strict also blocks GlideRecord, Inferred) |
| `default_value` | Constant (stored value, not label) or `javascript:` expression; applied when a new record is initialized and again at insert if still empty. `use_dynamic_default` + `dynamic_default_value` → `sys_filter_option_dynamic.script`. | Documented |
| `unique` | Unique index; refused while duplicates exist. | Documented |
| `max_length` | Only meaningful for strings; ResolvrNow rejects longer values with HTTP 400 on API writes (ResolvrNow decision; SN truncates/maps to physical type). | Documented (meaning), Inferred (ResolvrNow behavior) |
| `display` | Marks the table's display field; setting it clears the flag on the table's other fields. | Documented |
| `active` | Inactive columns are hidden from forms/lists/condition builder but still queryable and writable via API and scripts. | Documented |
| `virtual` + `calculation` (`virtual_type` script/formula) | Calculated field: computed before before-rules and recomputed after them; stored value used for sort/filter. | Documented |
| `dependent` / `dependent_on_field` | Choice or reference depends on another field (§3.7). | Documented |
| `audit` (collection row) | Table audited (§7.2). | Documented |
| Attributes: `no_audit`, `no_audit_delete`, `close_states`, `default_close_state`, `default_work_state`, `extensions_only`, `ref_qual_elements`, `ref_auto_completer`, `ref_ac_columns`, `tree_picker`, `no_email`, `ignore_filter_on_new`, `base_table`, `skip_root`, `types`, `readable`, `knowledge_search`, `scale`, `max_unit`, `no_attachment`, `update_synch` | As named; the bold ones drive engine behavior: `no_audit` (field skipped by audit), `no_audit_delete` (no `sys_audit_delete`), `close_states` (§9.3), `extensions_only` (§3.1). | Documented |

### 3.4 Dictionary overrides

- Overridable aspects: reference qualifier, attributes, default value, calculation, dependent field, display flag, mandatory, read-only, read-only option [Documented].
- Each aspect has an `<aspect>_override` boolean in `sys_dictionary_override`; only checked aspects apply [Documented].
- An override on table `C` applies to `C` and its descendants; a deeper override wins [Documented].
- An attribute override replaces the whole attribute set (base attributes are ignored) [Documented].
- Display override: only fields existing on the base table may become the child's display field [Documented].

Resolution [Inferred]: `effective(field, T) = base dictionary entry`, then for each table `X` in `reverse(ancestors(T))` from the definer down to `T`, apply the overrides recorded for `(X, field)`. ResolvrNow `TableDef.overrides` maps 1:1 to `sys_dictionary_override` rows.

### 3.5 Choice lists

Data: `sys_choice(name, element, language, value, label, sequence, inactive, dependent_value, hint)` [Documented form fields]; `sys_choice_set(name, element)` groups them as one application file [Documented].

| Rule | Basis |
|---|---|
| Choice values are at most 40 characters; numeric values must be in [-999, 999]. | Documented |
| `sys_dictionary.choice`: 0 none, 1 dropdown with "-- None --", 2 suggestion (free text allowed), 3 dropdown without "-- None --" (requires a default). Dependent choice fields always keep "-- None --". | Labels Documented, integer codes Inferred |
| "-- None --" has no sys_choice row; its value is `""` client-side and `"0"`-like empty server-side; ResolvrNow stores NULL and exposes `""` in API. A row with value `NULL_OVERRIDE` relabels "-- None --". | Documented (NULL_OVERRIDE, client/server values), Inferred (ResolvrNow storage) |
| Choice lists can be shared: `choice_table` + `choice_field` make a field reuse another field's live choices. | Documented |
| Lookup order for `(table T, element e, language l)`: rows with `name = T` (first ancestor of T that has rows for `e` wins), language `l` falling back to `en`; inactive rows are excluded from pickers but still resolve labels. Stored values without a choice row display as the raw value (optionally highlighted as invalid). | Documented (invalid highlighting), Inferred (ancestor walk) |
| Ordering: `sequence` ascending, then label. | Inferred |
| Integer choice values matter to rules: e.g. problem state 1 Open, 2 Known Error, 3 Pending Change, 4 Closed/Resolved; task state 3/4 are closed values used by baseline task rules; for new task states use negative values for active states and values above the existing closed values for inactive ones. | Documented |
| ResolvrNow `ColumnDef.choices` are mirrored to `sys_choice` (`registry.codeChoices`); DB rows layered on top by `ChoiceService`. | Inferred (matches current engine) |

### 3.6 Choice API used by clients [Inferred, ResolvrNow decision]

`GET /api/app/choices/{table}/{element}?dependent_value=...&language=...` returns `{value,label,sequence,dependent_value,inactive}[]`. When a state model is active for the record (§9.2) the endpoint accepts `sys_id` and returns only reachable states.

### 3.7 Dependent fields

- A choice or reference field may depend on another field of the same table; for choices, rows whose `dependent_value` equals the parent value are offered (incident subcategory depends on category) [Documented].
- Fields cannot depend on dot-walked (derived) fields [Documented].
- Reference dependency (e.g. `assigned_to` dependent on `assignment_group`): the picker offers only users who are members of the selected group [Documented example, mechanism Inferred]. ResolvrNow rule: if the reference targets `sys_user` and the parent field references `sys_user_group`, filter by `sys_user_grmember`; otherwise filter where the target's field named like the parent field equals the parent value [Inferred].
- Dependencies never block server writes; they are UI filters [Inferred].

### 3.8 Reference fields and display values

| Topic | Rule | Basis |
|---|---|---|
| Storage | sys_id of the target, or the value of `reference_key` (a unique, mandatory field of the target) | Documented |
| Cascade rule on target delete | `clear` (default: blank the reference), `delete`/`cascade` (delete referencing rows), `delete_no_workflow` (delete without business rules), `restrict` (refuse delete while referenced), `none` (leave dangling) | Documented |
| Dynamic creation | Unknown display value on input creates a target record using `dynamic_creation_script` | Documented |
| Reference floats | Enables "Edit" on one-to-many related lists | Documented |
| Display value lookup order | 1) field with display=true on the most specific table of the referenced record, 2) display field on its parent tables, 3) a field named `name`, `u_name` or `x_name`, 4) `number`, `u_number`, `x_number`, 5) the field named by `glide.record.display_value_default`, 6) `sys_created_on` | Documented |
| Task display | `number` is the display value for task tables | Documented |
| Input by display value | With `sysparm_input_display_value=true`, a reference may be given its display value; ResolvrNow resolves an exact display-field match (case-insensitive), then `sys_id`; ambiguity → error 400 | Documented (feature), Inferred (resolution) |

Reference qualifiers [Documented unless noted]:

| Kind (`use_reference_qualifier`) | Storage | Evaluation |
|---|---|---|
| `simple` | `reference_qual_condition` (condition builder, up to 13 conditions) | Encoded query appended to the picker query |
| `dynamic` | `dynamic_ref_qual` → `sys_filter_option_dynamic` | The option's script returns an encoded query (`current` available) |
| `advanced` | `reference_qual` | Either a static encoded query (`vendor=true`) or `javascript:` code returning an encoded query; `current` is the record being edited (unsaved values included); `listEditRefQualTag` is set when edited from a tagged related list |

- Qualifiers filter pickers and auto-complete only; they are not a security mechanism and are not enforced on server writes [Documented]. ResolvrNow exposes `GET /api/app/reference/{table}/{field}?q=...` that evaluates the qualifier with the posted form state [Inferred].
- `INSTANCEOF` operator: `sys_class_nameINSTANCEOFcmdb_ci_server` matches the class and all subclasses [Documented].
- A dictionary qualifier applies to the table and its children; an override changes it for a child and its descendants only [Documented].
- `ref_qual_elements` attribute lists fields whose change must re-run the qualifier [Documented].

### 3.9 Record numbering (`sys_number`)

| Field | Meaning | Basis |
|---|---|---|
| `category` | Table the format applies to (one format per table) | Documented |
| `prefix` | e.g. INC, CHG, PRB, REQ, KB, SCTASK, TASK | Documented / SDK |
| `number` | Base number (default 1000) | Documented |
| `maximum_digits` | Minimum digits after the prefix (default 7), left-padded with zeros; numbers can grow longer | Documented |

Rules:
- The running counter lives in `sys_number_counter`; raising the base above the counter jumps the sequence; the counter never moves backwards [Documented]. ResolvrNow allocation (atomic, same SQLite transaction): `last = counter ?? base`; `next = max(last, base) + 1`; store `counter = next`; return `prefix + leftPad(next, maximum_digits)`. With base 10000 the first incident is INC0010001 [Inferred; matches the developer guide and `engine/services/numbers.ts`]. The v1 engine keeps the counter in `sys_number.number` itself; moving to a separate `sys_number_counter` row is required before lowering the base can be supported without numbers going backwards.
- The number field (`task.number`) default is `javascript:getNextObjNumberPadded()` which allocates by the record's own class; changing `maximum_digits` re-pads existing records with that function (`getNextObjNumber()` variant does not) [Documented]. ResolvrNow v1 does not re-pad existing rows [Inferred].
- Timing: by default a number is allocated when the new-record form is initialized, so abandoned forms leave gaps; `glide.itil.assign.number.on.insert=true` defers allocation to insert; an aborted insert still consumes a number [Documented]. ResolvrNow default: allocate at insert (`true`) for API and UI (ResolvrNow decision) [Inferred].
- Uniqueness is not enforced by default; a unique index or a before-insert rule can enforce it [Documented]. ResolvrNow adds a non-unique index on `number` [Inferred].
- Resolution for tables without their own `sys_number`: use the nearest ancestor's format and counter (e.g. a custom task child gets TASK numbers) [Inferred].
- Resetting numbering affects new records only [Documented].
- Watermarks use the `sys_number` row of `sys_watermark` (prefix MSG) [Documented].

---

## 4. Record save pipeline and business rules

Sources: https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_BusinessRules.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_BusinessRulesInScopedApps.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/t_CreatingABusinessRule.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_UsingPredefinedGlobalVariables.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/r_BsnsRlClntScptsCntrlFldVl.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_ScriptingWithDisplayBusinessRules.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_TaskActiveStateMgmtBusRule.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_InstallationSettings.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_PrecBetweenAssignmentAndBusRules.html · https://www.servicenow.com/docs/r/build-workflows/approvals/execution-order-scripts-engines.html · https://www.servicenow.com/docs/r/api-reference/scripts/r_SettingAGlideRecordVariableToNull.html · https://www.servicenow.com/docs/r/platform-user-interface/r_OpAvailableFiltersQueries.html

### 4.1 Business rule record (`sys_script`, SDK)

| Field | Meaning |
|---|---|
| `name`, `collection` (table, or `global`), `active`, `advanced`, `order` (default 100) | Identity and sort |
| `when` | `before`, `after`, `async`, `display` (SDK also lists `async_always` and `before_display`; ResolvrNow treats `before_display` as `display` and `async_always` as `async` that also runs during upgrades) [SDK; mapping Inferred] |
| `action_insert`, `action_update`, `action_delete`, `action_query` | Operations |
| `filter_condition` | Condition builder (encoded query) |
| `condition` | Script condition (advanced) |
| `role_conditions` | User must hold one of these roles |
| `template` | "Set field values" actions as `field=value^field2=value2` [Inferred encoding] |
| `add_message` + `message` | Info message action |
| `abort_action` | Abort action |
| `script` | Script body |
| `priority`, `access`, `client_callable`, `is_rest`, `rest_*` | Not used by ResolvrNow v1 |

### 4.2 Execution order around a database operation [Documented]

```
 (client scripts / UI policies already ran in the browser)
 1. before rules with order < 1000
 2. before engines (no fixed order among them): approval, assignment rules, escalation,
    data policy, field normalization, role engine, execution plan, update version,
    data lookup, workflow (default workflows)
 3. before rules with order >= 1000
 4. database insert / update / delete
 5. after rules with order < 1000
 6. after engines: label, listener, table notifications, role engine, text index,
    update sync, workflow (deferred), trigger engine (Workflow Studio flows)
 7. email notifications ordered by weight (record-operation notifications, then event-based)
 8. after rules with order >= 1000
 async rules: queued as scheduled jobs; run later in the background
```

ResolvrNow concrete pipeline for `insert/update/delete(record, ctx)` [Inferred, ResolvrNow decision]:

| Step | ResolvrNow action |
|---|---|
| 0 | Load `previous` (update/delete) as an immutable snapshot of the stored row. |
| 1 | Insert only: initialize defaults (dictionary/override, `javascript:` defaults in sandbox), allocate number (§3.9). |
| 2 | API path only: drop input fields failing field ACLs (§2.5), apply input. Server scripts skip this. |
| 3 | Compute calculated fields. |
| 4 | Before rules order < 1000. |
| 5 | Before engines implemented by ResolvrNow, in this fixed order: role engine (identity tables), state-model check (§9.2), data lookup (§8.2), assignment rules (§8.1), approval engine (classic rules, approvals spec §4), data policy (§5.3). |
| 6 | Before rules order ≥ 1000; recompute calculated fields. |
| 7 | Validation: mandatory per data policy, `max_length`, `unique`, `strict_read_only`, cascade `restrict`. Any failure or `setAbortAction(true)` → skip DB write, report. |
| 8 | DB write; system fields (`sys_updated_on/by`, `sys_mod_count+1`) unless `autoSysFields(false)`; journal inserts (§7.1); audit rows (§7.2); cascade actions on delete. |
| 9 | After rules order < 1000. |
| 10 | After engines: role engine sync, metrics hook (§9.1), table notifications (record-operation notifications → `sys_email`), flow trigger engine (enqueue `sys_flow_context`). |
| 11 | After rules order ≥ 1000. |
| 12 | Enqueue async rules (`sys_trigger`, one job per rule, ordered by rule `order`) and commit. Events queued with `gs.eventQueue` commit with the transaction. |

Rules on parent tables run for child records (a `task` rule runs for `incident`); within a phase, rules are sorted by `order`, then by `name`, then `sys_id` for determinism [Inferred].

### 4.3 Conditions

- A rule runs only if all are true: active, operation flag, `role_conditions` (any role, empty = true), `filter_condition`, `condition` script [Documented: filter and script condition are evaluated together].
- String comparisons in filter conditions are case-sensitive [Documented].
- Filter conditions may use change operators evaluated against `previous`: `VALCHANGES` (changes), `CHANGESFROM`, `CHANGESTO` [Documented operators].
- Async rules cannot call `changes()`/`changesTo()`/`changesFrom()` in scripts (no `previous`), but their filter/condition fields can, because they are evaluated before queueing; `glide.businessrule.async_condition_check=true` re-evaluates the condition when the job runs [Documented].

### 4.4 No-code actions

| Action | Effect | Basis |
|---|---|---|
| Set field values | Assign a literal, "same as" another field, or a dynamic value (e.g. current user) | Documented |
| Add message | Queue an info message for the session (UI shows it; REST ignores) | Documented (ResolvrNow REST behavior Inferred) |
| Abort action | Prevent the DB operation; no other actions or script run; message still possible | Documented |

On REST, an aborted insert/update/delete returns HTTP 403 with `error.message="Operation Failed"` and `error.detail` = joined session error messages [Inferred].

### 4.5 Script semantics

| API | Semantics | Basis |
|---|---|---|
| `current` | The record being processed; field assignment changes the pending write. In before rules changes are saved automatically; never call `current.update()` there. | Documented |
| `previous` | Stored state before the first update/delete of this execution context; null for inserts; absent in async rules. | Documented |
| `g_scratchpad` | Display rules only; serialized to the client with the form. | Documented |
| `gs` | GlideSystem subset (getUserID, getUserName, hasRole, eventQueue, addInfoMessage, addErrorMessage, getProperty, nowDateTime, log, isInteractive, getUser). | Documented (gs exists), Inferred (subset) |
| `field.changes()` / `changesTo(v)` / `changesFrom(v)` | Compare `current` to `previous` (insert: previous treated as empty). | Inferred |
| `current.operation()` | `insert`, `update`, `delete`. | Documented |
| `setAbortAction(true)` | Marks the DB action as aborted; the current script and later rules still run; only the DB write is skipped. Must be called from the record's own scope. `isActionAborted()` reads the flag. | Documented |
| `setWorkflow(false)` | On a GlideRecord about to write: skip business rules (all phases) and engines (assignment, data lookup, approval, notifications, flow triggers, metrics) for that operation; audit, journal and system fields still apply. | Documented (skips rules), Inferred (engine list) |
| `autoSysFields(false)` | Do not touch `sys_updated_*`/`sys_mod_count` (and `sys_created_*` on insert if supplied). | Inferred |
| `field = 'NULL'` | Literal string NULL clears a field to its initial null state (not for reference input from imports). | Documented |
| User variables | Script top-level variables leak to later rules in the same transaction; ResolvrNow runs each rule in a fresh function scope instead (ResolvrNow decision). | Documented (leak), Inferred (ResolvrNow isolation) |

### 4.6 Recursion

- `current.update()` inside a rule re-runs insert/update rules for the record and can loop; the platform detects a rule re-entering itself, stops it and logs an error [Documented].
- ResolvrNow [Inferred]: maintain a stack of `(table, sys_id, ruleId)`; a rule already on the stack for the same record is skipped with a `syslog` warning; nested record operations deeper than 16 throw `RecursionError` and abort the outermost operation.

### 4.7 Query rules

- `when=before`, `action_query=true`; they add conditions to the query before it runs (typical: restrict non-itil users to their own incidents via `caller_id`/`opened_by`/`watch_list`) [Documented example].
- Only query rules of the table being queried run, not those of tables reached through reference fields [Documented]. Rules defined on ancestors of the queried table also run [Inferred].
- ResolvrNow applies query rules to every `GlideRecord.query()`, REST list/get, UI list and reference picker; `GlideRecord.setWorkflow(false)` before `query()` skips them [Inferred].
- `gs.isInteractive()` is true for UI sessions and false for REST/scheduler/script [Inferred].

### 4.8 Display and async rules

- Display rules run after the record is read and before the form is sent; changes to `current` are not saved; values appear as if stored [Documented]. ResolvrNow runs them in `GET /api/app/ui/form/...` only, not in the Table API [Inferred].
- Async rules become jobs created during the save and run later; execution order among them is not guaranteed and rapid successive updates can race [Documented]. ResolvrNow enqueues the job only if the DB operation was not aborted; the job receives a fresh `current` loaded by sys_id and no `previous` [Inferred].

### 4.9 Baseline task rules ResolvrNow must ship [Documented]

| Rule | Table | Behavior |
|---|---|---|
| Task Active State Management (order 50) | task | When `state` changes, compare old/new against `close_states` (attribute on the state field, inherited): active→inactive sets `active=false`, inactive→active sets `active=true`. |
| mark closed | task | State changes to 3 (Closed Complete) or 4 (Closed Incomplete) → `active=false`. |
| task closer | task | `active` changes true→false while state is not 3/4 → state = 3. |
| task reopener | task | `active` changes false→true while state is 3/4 → state = 1 (Open). |
| mark_closed / incident reopen | incident | Driven by `incident_state` (legacy field): 7 → inactive; <7 and inactive → active. Modules may replace these with the generic rule. |

---

## 5. UI policies, data policies, UI actions, client scripts

Sources: https://www.servicenow.com/docs/r/platform-administration/t_CreateAUIPolicy.html · https://www.servicenow.com/docs/r/platform-administration/c_DataPolicy.html · https://www.servicenow.com/docs/r/platform-administration/r_DataPolicyFields.html · https://www.servicenow.com/docs/r/platform-administration/c_UIActions.html · https://www.servicenow.com/docs/r/platform-administration/t_EditingAUIAction.html · https://www.servicenow.com/docs/r/platform-administration/t_OverrideOrRmvAUIActionForExtTbl.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/r_BsnsRlClntScptsCntrlFldVl.html · https://www.servicenow.com/docs/r/platform-administration/state-management/implement-process-flow-state-model.html

### 5.1 UI policies (`sys_ui_policy`, `sys_ui_policy_action`)

Fields [Documented labels; column names Inferred]: `table`, `active`, `short_description`, `order`, `conditions`, `global`, `view`, `reverse_if_false`, `on_load`, `inherit`, `run_scripts`, `script_true`, `script_false`, `ui_type` (0 desktop, 1 mobile/portal, 10 both). Action rows: `ui_policy`, `table`, `field`, `mandatory`, `visible`, `disabled` (read-only), each `ignore` ("Leave alone") / `true` / `false`.

Evaluation (client-side, by the ResolvrNow form engine) [Documented unless noted]:
1. Collect active policies for the form table; include ancestor-table policies with `inherit=true`; keep `global=true` or `view = current view` (blank view on a non-global policy means default view).
2. Run order: the child table's policies first, then the parent's; within a table, ascending `order`. Later actions win, so a parent rule can override a child rule regardless of order numbers.
3. Conditions use the condition builder only and can reference fields not on the form.
4. On load (if `on_load=true`) and whenever a user changes a field value on the form: if conditions true → apply actions (and `script_true`); if false and `reverse_if_false` → apply the inverse of each non-ignored action (and `script_false`). Changes made by UI actions, context menus or list editing do not re-trigger evaluation.
5. If the named field is absent from the form, the action targets a catalog variable of that name.
6. ResolvrNow precedence when two states conflict on one field [Inferred]: mandatory beats hidden (a mandatory empty field cannot be hidden), read-only beats mandatory only when the field already has a value.

UI policies never run on the server; list edits bypass them, so equivalent server logic must exist (data policy, ACL or business rule) [Documented].

### 5.2 Server exposure [Inferred, ResolvrNow decision]

`GET /api/app/ui/form/{table}/{sys_id|-1}?sysparm_view=` returns: sections and elements (§6), field metadata (type, label, mandatory, read-only after ACL + dictionary), values with display values, `g_scratchpad`, applicable UI policies with actions, client scripts (source text), and visible UI actions. The ResolvrNow web client evaluates policies and scripts.

### 5.3 Data policies (`sys_data_policy2`, `sys_data_policy_rule`)

- Same idea as UI policies but enforced on all writes: forms, imports, web services, mobile; by default every GlideRecord operation including REST Table API and scripted REST [Documented].
- Fields: table (`model_table`), `inherit`, `reverse_if_false`, `active`, `short_description`, `description`, `apply_import_set`, `apply_soap`, `enforce_ui` (use as UI policy), `conditions`; rules: `table`, `field`, `disabled` (read-only), `mandatory` with Leave alone/True/False [Documented labels; column names Inferred].
- Opt-outs exist for SOAP targets, import sets and client side; UI submissions are always checked [Documented].
- ResolvrNow enforcement [Inferred]: before engine step; when conditions match (or reverse applies), a mandatory-true field that is empty after rules, or a read-only-true field whose value changed, aborts the write with message "Data Policy Exception: <field label> is mandatory" (or "is read only"). Plain server `GlideRecord` writes are also checked unless `setWorkflow(false)`.

### 5.4 UI actions (`sys_ui_action`, SDK)

Placements: `form_button`, `form_context_menu`, `form_link` (Related Links), `list_banner_button`, `list_button` (bottom), `list_context_menu`, `list_choice` (actions menu), `list_link`; workspace flags `form_button_v2`, `form_menu_button_v2` [Documented].

Visibility algorithm for record `r` of class `T`, placement `p` [Documented rules, Inferred ordering]:
1. Candidates: active actions with `p=true` whose `table` is `T`, an ancestor of `T`, or `global`.
2. Override: an action on a more specific table with the same `action_name` (or pointing at it via `sys_overrides`) replaces the inherited one; removing an inherited action for one child is done with a condition on the parent action.
3. `show_insert` (new, unsaved record) / `show_update` (existing record).
4. Required roles: user needs at least one (empty = everyone).
5. `condition` script, evaluated on the server with `current`; empty or referencing an empty field → true. For list context menus `current` is unavailable; list banner buttons evaluate against the first row only; list bottom buttons and list choices are shown regardless and evaluated per record at execution.
6. View visibility (`sys_ui_action_view`): no rules → all views; an exclude rule hides it on that view; any include rule restricts it to the included views.
7. De-duplicate actions whose `name` and `action_name` are both identical.
8. Sort by `order` (buttons left to right, menus top to bottom).

Execution [Documented semantics; endpoint Inferred]:
- `client=false`: `POST /api/app/action/{table}/{sys_id|-1}/{actionId}` (actionId = UI action sys_id or `action_name`; body `{fields}`) → apply submitted field values to `current` without saving → re-check visibility → run `script` with `current` and `action` (`action.setRedirectURL(url|record)`) → script normally calls `current.update()`/`insert()` → respond with redirect and session messages.
- `client=true`: the browser runs the `onclick` function from `script`; to also run server code the client calls `gsftSubmit(null, formElement, action_name)`, which posts the form with that `action_name`; the server then runs the same script server-side (the script typically checks `typeof window == 'undefined'`).
- Built-in action names used by forms [Inferred]: `sysverb_insert` (Submit), `sysverb_update` (Update), `sysverb_insert_and_stay`, `sysverb_delete`, `sysverb_cancel`. Insert/Insert-and-stay on task tables are hidden unless `glide.ui.task.insert=true` [Documented property].

### 5.5 Client scripts (conceptual)

- `sys_script_client`: `table`, `type` (`onLoad`, `onChange` with `field`, `onSubmit`, `onCellEdit`), `ui_type` (0/1/10), `view`, `global`, `applies_extended` (inherited by child tables), `order`, `isolate_script`, `script`, `condition` [SDK].
- They run only in browsers and only on forms (`onCellEdit` in lists); any rule they implement must be duplicated server-side to cover lists, imports and APIs [Documented].
- ResolvrNow web client supports a `g_form` subset: `getValue`, `setValue`, `setMandatory`, `setReadOnly`, `setDisplay`/`setVisible`, `addInfoMessage`, `addErrorMessage`, `showFieldMsg`, `clearOptions`/`addOption`/`removeOption`, `getReference(callback)`, `isNewRecord`, `getTableName`; `onSubmit` returning false cancels the submit [Inferred].

---

## 6. Forms, views, sections, related lists and lists

Sources: https://www.servicenow.com/docs/r/platform-administration/configure-form-layout.html · https://www.servicenow.com/docs/r/platform-administration/advanced-form-administration.html · https://www.servicenow.com/docs/r/platform-administration/c_Formatters.html · https://www.servicenow.com/docs/r/platform-administration/c_ActivityFormatter.html · https://www.servicenow.com/docs/r/platform-user-interface/c_UsingForms.html · https://www.servicenow.com/docs/r/platform-user-interface/c_EmbeddedLists.html · https://www.servicenow.com/docs/r/platform-user-interface/c_RelatedLists.html · https://www.servicenow.com/docs/r/platform-user-interface/t_CreateDefinedRelatedLists.html · https://www.servicenow.com/docs/r/platform-user-interface/t_ConfigureTheEditOption.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/t_ConfigureTheListLayout.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/t_ConfigureListControls.html · https://www.servicenow.com/docs/r/platform-administration/list-administration/t_ConfigureListCalculations.html

### 6.1 Metadata tables (SDK)

| Table | Role |
|---|---|
| `sys_ui_view` | Named view (`name`, `title`, `roles`, `hidden`); default view has an empty name [Inferred] |
| `sys_ui_section` | Section of a form: `name` (table), `view`, `caption`, `title`, `header`, `roles`, `sys_user` (personal) |
| `sys_ui_form` + `sys_ui_form_section` | Form per (table, view) and ordered section list (`position`) |
| `sys_ui_element` | Item in a section: `element`, `position`, `type` (`element`, `.split`/`split`, `.begin_split`, `.end_split`, `formatter` + `sys_ui_formatter`, `list` (embedded list), `annotation`, `chart`, `component`) |
| `sys_ui_formatter` | Formatter (`formatter` = macro name, e.g. `activity.xml`) |
| `sys_ui_related_list` + `sys_ui_related_list_entry` | Related lists per (table, view): entries with `related_list` key, `position`, `filter`, `order_by` |
| `sys_relationship` | Defined relationships ("Applies to", "Queries from", `query_with` script, advanced `apply_to`/`query_from`, `insert_callback`) |
| `sys_ui_list` + `sys_ui_list_element` | List layout per (table, view, optional parent/relationship, optional user); columns with `position` and aggregate flags (`sum`, `average_value`, `min_value`, `max_value`) |
| `sys_ui_list_control` | List control per table/related list (labels, omit flags, edit type, roles) |
| `sysrule_view` | View rules (table, condition, view, device type, script) |
| `sys_user_preference` | Personal settings (tabbed forms, personal list columns, collapsed sections) |

Module-declared layouts map onto these tables [Inferred, ResolvrNow decision]: `ui.forms[].sections[]` → one `sys_ui_section` per section (default view) whose `left`/`right` arrays become elements wrapped in `.begin_split` / `.split` / `.end_split`, `fields` become plain elements, `caption` becomes the section caption; `relatedLists[{table, field}]` → `sys_ui_related_list_entry.related_list = "<table>.<field>"`; `ui.lists[].columns` → `sys_ui_list` + `sys_ui_list_element` (default view). Rows created by an administrator override the module defaults for the same (table, view).

### 6.2 Form resolution [Inferred unless noted]

1. View: explicit `sysparm_view` → first matching `sysrule_view` (by `order`, `overrides_user_preference=true`) → user preference `<table>.view` → default view.
2. Sections: `sys_ui_form_section` for (table, view) ordered by `position`; if none, `sys_ui_section` rows for (table, view); if the view has no sections, fall back to the default view; if the table has none, walk up the table hierarchy.
3. Personal sections (`sys_user` set) override the shared ones for that user when form personalization is enabled.
4. Sections with `roles` are hidden from users lacking all of them.
5. The first section's caption becomes the form title; each later section is a tab when tabbed forms are on (`tabbed.forms` preference) [Documented].
6. Elements between `.begin_split`/`.split`/`.end_split` render as two (or more, with `glide.ui.form_multiple_splits`) columns [Documented].
7. A field may appear only once in editable form; duplicates must be read-only [Documented].
8. Journal fields and the activity formatter must be contiguous in one section in the classic UI [Documented].
9. Only one activity formatter per form; activity formatter is available on audited tables (task and sysapproval_approver by default) [Documented].

### 6.3 Lists [Documented unless noted]

- Columns per (table, view); the first non-reference column links to the record.
- Personal lists override the admin layout until reset.
- List calculations apply per view and are visible to everyone; total/average are not offered for strings and dates; grouped lists show per-group calculations.
- Inactive columns stay in admin-configured lists until removed.
- `glide.ui.list.allow_extended_fields=true` allows child-table fields on parent lists.
- Fallback when no layout exists [Inferred]: number/display field, `short_description`, `state`, `sys_updated_on`, limited to fields present.

### 6.4 Related lists [Documented unless noted]

| Key format in `related_list` | Meaning |
|---|---|
| `<child_table>.<ref_field>` | One-to-many: child rows whose `ref_field` = parent sys_id (e.g. `incident.problem_id` on problem) [Inferred format] |
| `REL:<sys_relationship sys_id>` | Defined relationship using `query_with(current, parent)` [Inferred format] |
| `<m2m_table>.<field>` | Many-to-many through a junction table [Inferred format] |

- Creating a record from a related list applies the list filter to the new record and fills the related field for reference, string, boolean and choice fields whose filter uses "is"/"=".
- "Edit" exists for one-to-many and many-to-many lists; one-to-many needs `reference_floats=true` on the child reference; defined relationships add records automatically and have no Edit.
- Embedded lists save with the parent form; new rows are removed immediately, existing rows are deleted on save.
- List control fields (`omit_new_button`, `omit_edit_button`, `omit_if_empty`, `omit_filters`, `omit_links`, `new_roles`, `filter_roles`, `link_roles`, `list_edit_type`, `list_edit_ref_qual_tag`, `label`) adjust each list.

---

## 7. Activity stream, journal fields and audit

Sources: https://www.servicenow.com/docs/r/platform-administration/c_JournalFields.html · https://www.servicenow.com/docs/r/platform-administration/c_JournalFieldDisplayLimits.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/r_JournalFields.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/r_ImportantTaskTableFields.html · https://www.servicenow.com/docs/r/platform-administration/c_ActivityFormatter.html · https://www.servicenow.com/docs/r/platform-administration/limit-activity-stream-entries.html · https://www.servicenow.com/docs/r/platform-user-interface/c_activity-streams.html · https://www.servicenow.com/docs/r/platform-user-interface/c_DisplayActivityStreams.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_DictionaryAttributes.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/user.html

### 7.1 Journal fields

| Type | Accepts input | Shows history | In activity stream | Basis |
|---|---|---|---|---|
| `journal` | yes | below the input | yes | Documented |
| `journal_input` | yes | no (entries go to the activity formatter) | yes for `comments`/`work_notes` | Documented |
| `journal_list` | no | merged view of the journal fields it depends on, chronological | no, separate block | Documented |

- Task fields: `comments` (Additional comments, journal_input, any user who can update), `work_notes` (journal_input, itil users), `comments_and_work_notes` (journal_list), `approval_history` (journal) [Documented].
- Journal fields appear in the activity stream even when table audit is off [Documented].
- Storage [Inferred]: each non-empty assignment inserts `sys_journal_field(name=<table>, element=<field>, element_id=<sys_id>, value, sys_created_on, sys_created_by)`. Reading `current.work_notes` returns `""` (input buffer); `getJournalEntry(n)` returns the n most recent entries (`-1` = all) formatted as `"<YYYY-MM-DD HH:MM:SS in session TZ> - <user display name> (<field label>)\n<text>\n\n"`. `setValue()` is not supported for journals; direct assignment is [Documented].
- `glide.email.journal.lines` (default 3, -1 = all) caps entries rendered in notifications [Documented]. Display limits: `glide.max_journal_list_size`, `glide.shortened_journal_length`, `glide.history.max_entries` (default 250) [Documented].
- Visibility [Inferred seeds]: `task.work_notes` read/write requires `itil`; `task.comments` readable/writable by anyone who can read/write the record (callers via their record ACLs).

### 7.2 Audit

Audited tables: collection dictionary `audit=true` (task tables, `sys_security_acl`, `sysevent_email_action`, ...) [SDK `audit` flags, Documented setting]. Fields with `no_audit` attribute are skipped [Documented]; system fields are never audited [Inferred].

`sys_audit` row per changed audited field per write [Inferred columns]:

| Field | Value |
|---|---|
| `tablename` | Record class |
| `documentkey` | Record sys_id |
| `fieldname` | Column name |
| `oldvalue` / `newvalue` | Stored values (journal additions use `oldvalue="JOURNAL FIELD ADDITION"` and the entry text as `newvalue`) |
| `user` | `user_name` of the session user (impersonated user when impersonating) |
| `reason` | Optional (e.g. "Approval", "Inbound email") |
| `record_checkpoint` | `sys_mod_count` after the write |
| `internal_checkpoint` | Monotonic sequence ordering writes within the same second (integer in ResolvrNow) |
| `sys_created_on` | Write time |

- Insert writes one row per non-empty audited field with empty `oldvalue` (ResolvrNow decision, gives the "Created" entry) [Inferred].
- Delete writes `sys_audit_delete` with a JSON snapshot unless the table has `no_audit_delete` [Documented attribute, Inferred format].
- `sys_history_set` (one per record and viewing user/language) and `sys_history_line` (one per change) are the history cache built from audit and journal data. ResolvrNow builds them lazily on `GET` of those tables or of the History view and otherwise computes the stream directly (§7.3) [Inferred].
- When `system` or `guest` update login fields (last login, failed attempts, locked out), the change is visible only through audit history [Documented].

### 7.3 Activity stream composition [Documented content, Inferred algorithm]

Sources merged, newest first, capped at `glide.history.max_entries` (250):

| Entry | Source | Visibility |
|---|---|---|
| Field changes | `sys_audit` rows grouped by (`documentkey`, `record_checkpoint`) into one entry with user and time | Only fields in the activity field list (`glide.ui.<table>_activity.fields`, e.g. `glide.ui.incident_activity.fields`) and readable by the viewer |
| Comments / work notes | `sys_journal_field` | Field `read` ACL |
| Emails | `sys_email` with `instance=<sys_id>`, type `sent` or `received`, labelled "Emails - autogenerated" / "Emails - correspondence" | Only roles listed in `glide.ui.activity.email_roles` (default `itil`; empty list = everyone); an email appears only once sent |
| Attachments | `sys_attachment` with `table_sys_id=<sys_id>` | Row read on the record |
| Mentions | `live_notification` rows are not journal entries | ResolvrNow v2 |

- User shown as full name or user ID per `glide.ui.activity.displayname` [Documented].
- Per-entry size capped by `glide.max_activity_size` (default 102400 bytes) [Documented].
- ResolvrNow API: `GET /api/app/activity/{table}/{sys_id}?limit=&types=` returns `{entries:[{type, created_on, user, user_display, fields:[{name,label,old_display,new_display}] | journal:{field,value} | email:{subject,recipients,type,sys_id} | attachment:{file_name,sys_id}}]}` [Inferred].

---

## 8. Assignment rules and data lookup rules

Sources: https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_DefineAssignmentRules.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_AssignmentRulesModule.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_DataLookupRules.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_PrecBetweenAssignmentAndBusRules.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/r_BaselineAssignmentRulesExample.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/t_AssignmentModuleRule.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/t_DataLookupRule.html · https://www.servicenow.com/docs/r/platform-administration/c_DataLookRecMatchSupport.html · https://www.servicenow.com/docs/r/platform-administration/r_CreateCustomDataLookups.html · https://www.servicenow.com/docs/r/it-service-management/incident-management/def-prio-lookup-rules.html · https://www.servicenow.com/docs/r/it-service-management/problem-management/prioritise-problems.html

### 8.1 Assignment rules (`sysrule_assignment`, SDK)

Fields: `name`, `active`, `table` (default incident), `condition`, `match_conditions` (ALL/ANY), `user`, `group`, `script`, `order` (execution order, from `sysrule`) [SDK + Documented].

Documented preconditions: the record was created or updated (unsaved form edits never trigger rules); the record has neither `assigned_to` nor `assignment_group` (rules never overwrite, including defaults and earlier rules); only the first matching rule by lowest order runs; on equal order, the first matching rule wins.

Algorithm (before engine, §4.2) [Inferred details]:

```
assignmentEngine(r):
  if r.assigned_to or r.assignment_group: return
  rules = sysrule_assignment(active=true, table ∈ [class(r)] + ancestors(class(r)))
          sorted by order, then name
  for rule in rules:
     ok = match_conditions == 'ANY' ? anyTopLevelTermMatches(rule.condition, r)
                                     : matches(rule.condition, r)        // empty = true
     if !ok: continue
     if rule.script:
        id = runScript(rule.script, {current: r})                       // returns a sys_id
        if id is a sys_user: r.assigned_to = id
        else if id is a sys_user_group: r.assignment_group = id
     else:
        if rule.user:  r.assigned_to = rule.user
        if rule.group: r.assignment_group = rule.group
     return                                                              // first match only
```

Baseline examples worth seeding in the ITSM module [Documented]: Networking (incident, category=network → group Network), Database or Software, Service Desk (incident, active=true → Service Desk), SC item fulfillment (Field Services), IT Hardware (sc_req_item).

### 8.2 Data lookup rules

Tables (SDK): `dl_definition(name, source_table, matcher_table, active, run_on_form_change, run_on_insert, run_on_update)`, `dl_definition_rel_match(dl_definition, source_table_field, matcher_table_field, exact_match)`, `dl_definition_rel_set(dl_definition, source_table_field, matcher_table_field, always_replace)`, `dl_matcher(active, order)` as the base of every matcher table [SDK].

Documented rules: matcher tables extend `dl_matcher` and each row must be unique; definitions are not inherited by child tables (a definition on task does not match incident records); lookups need at least one matcher and one setter; journal fields are not supported; "run on form change" ignores changes made by other lookups; with `exact_match` off, empty matcher cells are wildcards; with it on, an empty source value only matches an empty matcher cell; `always_replace` off keeps existing (including default) values; data lookups and assignment rules can coexist (after assignment, duplicate rules are ignored unless replace is set).

Algorithm [Inferred]:

```
dataLookupEngine(r, op):                                  // op: insert | update | form_change
  for d in dl_definition(active=true, source_table=class(r)):     // exact table only
     if !(op=='insert' && d.run_on_insert || op=='update' && d.run_on_update
          || op=='form_change' && d.run_on_form_change): continue
     M = rel_match(d); S = rel_set(d); if M empty or S empty: continue
     for row in d.matcher_table(active=true) ordered by order asc, sys_created_on asc:
        if all(m in M: cellMatches(row[m.matcher_table_field], r[m.source_table_field], m.exact_match)):
           for s in S:
              if s.always_replace or isEmpty(r[s.source_table_field]):
                 r[s.source_table_field] = row[s.matcher_table_field]
           break                                          // first row wins
cellMatches(cell, value, exact) = exact ? cell == value : (isEmpty(cell) or cell == value)
```

`form_change` runs from `POST /api/app/ui/lookup/{table}` with the unsaved form state and returns the setter values (no save) [Inferred].

### 8.3 Priority lookup pattern

- Matcher table `dl_u_priority(impact, urgency, priority, order, active)` extends `dl_matcher`; definition "Priority Lookup" on `incident` with matchers impact, urgency and setter priority (`always_replace=true`); the Priority field is read-only on forms via a UI policy ("Priority is managed by Data Lookup") [Documented names; flags Inferred]. Problem uses `dl_problem_priority` [Documented].
- Activating the data lookup plugin replaces the older `calculatePriority` business rule [Documented]. ResolvrNow ships the lookup, not the rule.
- Seed rows (impact/urgency → priority) [Documented]:

| Impact \ Urgency | 1 High | 2 Medium | 3 Low |
|---|---|---|---|
| 1 High | 1 Critical | 2 High | 3 Moderate |
| 2 Medium | 2 High | 3 Moderate | 4 Low |
| 3 Low | 3 Moderate | 4 Low | 5 Planning (incident page shows 4 Low; see note) |

Note: the incident priority-lookup page lists 3/3 → 4 Low while the generic data-lookup page and the problem page list 3/3 → 5 Planning. ResolvrNow seeds 5 Planning (data-driven, editable) and flags this as an open question.

---

## 9. Metrics and state management

Sources: https://www.servicenow.com/docs/r/platform-administration/c_MetricDefinitionSupport.html · https://www.servicenow.com/docs/r/platform-administration/create-metric.html · https://www.servicenow.com/docs/r/platform-administration/c_SampleFieldValueDurationScript.html · https://www.servicenow.com/docs/r/platform-administration/c_MetricInstance.html · https://www.servicenow.com/docs/r/platform-administration/state-management/state-model.html · https://www.servicenow.com/docs/r/platform-administration/state-management/add-state-model.html · https://www.servicenow.com/docs/r/platform-administration/state-management/installed-state-model.html · https://www.servicenow.com/docs/r/platform-administration/c_BPForStateFieldChoiceValues.html · https://www.servicenow.com/docs/r/build-workflows/business-rules-classic/c_TaskActiveStateMgmtBusRule.html

### 9.1 Metrics

`metric_definition` [Documented fields]: `number`, `name`, `table` (one table), `field` (must be audited; `sys_` fields unsupported except `sys_domain`), `type` (`field_value_duration` or `script`), `timeline`, `active`, `description`, `script`.

`metric_instance` [Documented: definition, value, id, duration, calculation_complete; others Inferred]: `definition`, `id` (sys_id of the measured record), `table`, `field`, `field_value` (stored value), `value` (display value, e.g. assignee name), `start`, `end`, `duration`, `business_duration`, `calculation_complete`.

Documented behavior: definitions only measure changes after they exist; baseline metrics work on task tables because a "metric events" business rule on task produces the events that drive processing (other tables need that rule copied); a duration script may stop processing by setting `answer=false` and can close sibling durations (`mi.endDuration()`); script metrics must write `metric_instance` themselves.

ResolvrNow processing [Inferred]: the after-engine hook queues event `metric.update` (parm1 = comma list of changed fields) for audited tables that have active definitions; the event handler runs:

```
for d in metric_definition(active, table ∈ [class(r)] + ancestors(class(r))):
  if d.type == 'field_value_duration' and (op == insert ? r[d.field] nonEmpty : d.field ∈ changed):
     open = metric_instance(definition=d, id=r.sys_id, calculation_complete=false)
     for mi in open: mi.end = now; mi.duration = now - mi.start; mi.calculation_complete = true
     answer = true
     if d.script: answer = runScript(d.script, {current: r, mi: MetricInstance(d, r), definition: d})
     if answer !== false:
        insert metric_instance(definition=d, id=r.sys_id, table, field=d.field,
              field_value=r[d.field], value=display(r[d.field]), start=now, calculation_complete=false)
  if d.type == 'script': runScript(d.script, {current: r, definition: d})
```

### 9.2 State models

Tables [Documented]: `sys_state_model(name, table, order, active, description, condition, common_exit_condition)` and `sys_state_transition(state_model, state, order, terminal_state, description, enter_condition, exit_condition)`; role `state_model_admin`. Applies to task-extending tables.

Documented semantics: once active, the State choice list only offers states allowed by the transitions; any state change that violates them is refused from every channel (UI, scripts, REST, SOAP); models are evaluated in `order`; the model's condition selects which records it governs; shipped example models (copies of change models) are inactive and must not be enabled for change requests. Example: if "Completed" has enter condition "State is Confirmed", only Confirmed records can move to Completed, and a Confirmed record offers Completed as its only next state.

ResolvrNow enforcement (before engine) [Inferred]:

```
stateModelCheck(r, previous):
  if previous == null or r.state == previous.state: return OK
  m = first active sys_state_model(table = class(r)) by order whose condition matches r (empty = match)
  if m == null: return OK
  tFrom = transition(m, previous.state); tTo = transition(m, r.state)
  if tTo == null: deny
  if tFrom != null and tFrom.terminal_state: deny
  probe = copy(r) with state = previous.state         // conditions describe the pre-transition record
  if !matches(m.common_exit_condition, probe): deny
  if tFrom != null and !matches(tFrom.exit_condition, probe): deny
  if !matches(tTo.enter_condition, probe): deny
  return OK
deny → abort with error "Invalid state transition from <label> to <label>"; REST 403 "Operation Failed"
```

Choice filtering: for a record in state S, offer S plus every state X with a transition such that the same checks pass for the move S → X.

### 9.3 Task active-state management

- `close_states` (semicolon list of inactive values) on the task-state dictionary entry, plus optional `default_close_state` (default 3) and `default_work_state` (default 2), drive the TaskStateUtil helpers and the "Task Active State Management" rule (order 50) [Documented].
- Prefer `current.active.changesTo(false|true)` in custom rules rather than per-table close rules [Documented].
- ResolvrNow ships TaskStateUtil-equivalent helpers in the sandbox: `isClosed(record)`, `defaultCloseState(table)`, `defaultWorkState(table)`, `inactiveStates(table)` [Inferred].

---

## 10. Acceptance tests

Each test runs against a fresh ResolvrNow database seeded with platform data from `data/platform.json`.

1. **Effective roles via group.** Given user U in group G and `sys_group_has_role(G, itil, inherits=true)`, when U makes a request, then `gs.hasRole('itil')` is true and a `sys_user_has_role(U, itil, inherited=true, granted_by=G)` row exists.
2. **Group role not inherited.** Given `sys_group_has_role(G, catalog, inherits=false)` and U ∈ G, when U's roles are computed, then `catalog` is absent.
3. **Parent group inheritance is one-way.** Given group C with parent P, P has role `itil`, user X ∈ C, user Y ∈ P only, when roles are computed, then X has `itil`; and a picker on `assigned_to` filtered by group P does not list X.
4. **Containment closure.** Given `personalize` contains `personalize_rules` which contains `business_rule_admin`, when user U holds only `personalize`, then `gs.hasRole('business_rule_admin')` is true.
5. **Admin passes role checks but not nobody.** Given an admin user, when `gs.hasRole('itil')` and an ACL requiring role `nobody` with `admin_overrides=true` are evaluated, then the first is true and the ACL fails.
6. **Grant admin restriction.** Given user A with `user_admin` but not `admin`, when A inserts `sys_user_has_role(user=B, role=admin)`, then the insert is aborted and no row exists.
7. **Inherited role cannot be removed directly.** Given an inherited `sys_user_has_role` row, when a user_admin deletes it, then the delete is aborted with an error.
8. **Elevated role inactive until elevation.** Given U holds `security_admin` (elevated_privilege=true), when U logs in, then `gs.hasRole('security_admin')` is false until U calls the elevate endpoint, after which it is true.
9. **Impersonation attribution.** Given admin A impersonates itil user B, when A updates INC0010001, then `sys_updated_by='B.user_name'`, the `sys_audit.user` is B's user name, and a syslog "Impersonate Begin" row names A and B.
10. **Impersonator cannot impersonate admin.** Given user I with only `impersonator`, when I tries to impersonate an admin, then the call returns 403 and the session user is unchanged.
11. **ACL order: field before wildcard.** Given ACLs `incident.priority` (read, role itil) and `*.*` (read, no roles), when an ESS user without itil reads an incident they can row-read, then `priority` is omitted and `short_description` is returned.
11b. **`*.field` before `table.*`.** Given ACLs `*.priority` (read, role itil) and `incident.*` (read, no roles), when a non-itil user reads an incident, then `priority` is omitted (the `*.priority` level decides first) and other fields are returned.
11c. **No field ACL follows the row.** Given only a row-level `incident` read ACL that the user passes and no field ACL of any level, when the user reads the incident, then every field is returned.
12. **ACL inheritance through parent table.** Given only `task.work_notes` (read, role itil) exists for that field, when a non-itil user reads an incident they can row-read, then `work_notes` is hidden.
13. **First matching level decides.** Given `incident` read ACL requiring `itil` and `task` read ACL with no requirements, when a non-itil user reads an incident, then access is denied (task ACL is not consulted).
14. **OR across ACLs at the same level.** Given two `incident` read ACLs, one requiring `itil` and one with condition `caller_id=javascript:gs.getUserID()`, when caller C (no itil) reads their own incident, then access is granted; for another caller's incident it is denied.
15. **AND inside one ACL.** Given one `incident` write ACL with role `itil` and condition `active=true`, when an itil user updates a closed (active=false) incident via PATCH, then the response is 403.
16. **Deny-Unless.** Given a Deny-Unless ACL on `incident` read with condition `company=javascript:gs.getUser().getCompanyID()` and an Allow-If ACL requiring itil, when an itil user from another company reads an incident, then it is denied.
17. **Admin override off.** Given ACL `incident` list_edit with script `answer=false` and `admin_overrides=false`, when an admin edits a cell in the incident list, then the edit is refused.
18. **REST limit before ACL.** Given 10 incidents of which the caller can read 3, when `GET /api/now/table/incident?sysparm_limit=5` is issued, then at most 5 rows were considered and only the readable ones among them are returned (fewer than 5 is valid).
19. **REST write silently drops non-writable fields.** Given field ACL `incident.priority` write requiring itil_admin, when an itil user PATCHes `{priority:1, short_description:"x"}`, then status is 200, `short_description` changed and `priority` unchanged.
20. **REST get of unreadable record.** Given a record the user cannot read, when GET by sys_id, then status 404 with the "ACL restricts the record retrieval" detail.
21. **Dictionary override default.** Given `task.priority` default 4 and an override on incident default 5, when a change_request and an incident are inserted without priority, then change priority=4 and incident priority=5.
22. **Override inheritance.** Given an override on table C and a grandchild G without its own override, when a G record is created, then the C override value applies.
23. **Display value resolution.** Given a table with fields `u_name` and `number` and no display flag, when a reference to it is rendered, then `u_name` is the display value; after setting `display=true` on `number`, `number` is used and `u_name.display` is false.
24. **Choice fallback by language.** Given choices for incident.category in `en` only and a session language `fr`, when choices are requested, then the `en` labels are returned ordered by sequence.
25. **Dependent choice.** Given subcategory choices with `dependent_value=hardware` and `dependent_value=software`, when choices are requested with `dependent_value=software`, then only software subcategories are returned.
26. **Reference qualifier is not security.** Given `task.assignment_group` qualifier `type=itil`, when a PATCH sets assignment_group to a non-itil-type group, then the write succeeds; and the picker endpoint does not list that group.
27. **Advanced qualifier with current.** Given `assignment_group` advanced qualifier `javascript:"sys_idIN" + groupsOf(current.assigned_to)`, when the picker is called with unsaved `assigned_to=U`, then only U's groups are listed.
28. **Cascade restrict.** Given `incident.caller_id` cascade rule `restrict` and an incident referencing user U, when U is deleted, then the delete fails and U still exists.
29. **Numbering format.** Given `sys_number(incident, prefix INC, number 10000, maximum_digits 7)` and no incident yet, when two incidents are inserted, then numbers are INC0010001 and INC0010002.
30. **Number base raise.** Given the last incident number 10002, when `sys_number.number` is set to 20000, then the next incident is INC0020001; when the base is later set back to 15000, the next is INC0020002 (never backwards).
31. **Number on insert only.** Given `glide.itil.assign.number.on.insert=true`, when the new-incident form is opened and abandoned, then no number is consumed.
32. **Before rule order and engines.** Given before rules R1 (order 100) and R2 (order 1000) on incident and an assignment rule matching, when R1 records `current.assignment_group` and R2 records it too, then R1 saw it empty and R2 saw the rule's group.
33. **setAbortAction continues rules.** Given before rule A (order 100) calling `setAbortAction(true)` and before rule B (order 200) writing a syslog row, when an insert happens, then no incident is created, the syslog row exists, and REST returns 403.
34. **previous across nested updates.** Given an after-insert rule that updates the same incident twice in one context, when the second update's before rule reads `previous.state`, then it equals the state before the first update.
35. **setWorkflow(false) skips rules but audits.** Given a before-update rule that sets `description='x'`, when a script updates an incident with `setWorkflow(false)`, then description is unchanged and a `sys_audit` row exists for the changed field.
36. **Query rule.** Given the "incident query" rule (non-itil users see only rows where they are caller, opener or watcher), when an ESS user lists incidents via REST, then only those rows are returned and the count header reflects the restricted query.
37. **Display rule scratchpad.** Given a display rule setting `g_scratchpad.vip=current.caller_id.vip`, when the form endpoint loads a VIP caller's incident, then `g_scratchpad.vip==true` and the Table API GET for the same record has no scratchpad.
38. **Async rule has no previous.** Given an async update rule logging `previous == null`, when an incident is updated and the job runs, then the log shows true and the job ran after commit.
39. **Recursion guard.** Given an after-update rule that calls `current.update()`, when an incident is updated, then the rule runs once, a recursion warning is logged and the request succeeds.
40. **UI policy order child-first.** Given incident policy (order 500) showing `urgency` and task policy (order 100, inherit) hiding it, both with the same condition, when the incident form evaluates them, then `urgency` is hidden.
41. **Reverse if false.** Given a policy "state=6 → close_notes mandatory" with reverse_if_false, when state changes 6 → 2 on the form, then close_notes is no longer mandatory.
42. **Data policy blocks REST.** Given a data policy on problem "state=4 → close_notes mandatory", when PATCH sets state=4 with empty close_notes, then status 403 and the message names close_notes.
43. **UI action override.** Given task action "Resolve" (action_name `resolve_task`) and incident action with the same action_name, when an incident form loads, then only the incident action is listed.
44. **UI action roles and condition.** Given an action requiring role `itil_admin` with condition `current.active==true`, when an itil-only user opens an active incident, then the action is absent; for an itil_admin user it is present; on a closed incident it is absent.
45. **View visibility.** Given an action with an include rule for view `ess`, when the incident form loads in the default view, then the action is absent; in view `ess` it is present.
46. **Form fallback to default view.** Given incident sections only for the default view, when the form is requested with `sysparm_view=mobile`, then the default sections are returned.
47. **Related list from filter.** Given the problem form's `incident.problem_id` related list, when "New" is used from it, then the new incident has `problem_id` set to the problem.
48. **Journal visibility.** Given an incident with one comment and one work note, when the caller (no itil) fetches the activity stream, then the comment is present and the work note is absent; an itil user sees both.
49. **Journal storage.** Given an update setting `work_notes="abc"`, when `sys_journal_field` is queried, then one row (element=work_notes, element_id=<sys_id>, value="abc") exists and `GET incident` returns `work_notes` as the formatted latest entry when display values are requested.
50. **Audit row per field.** Given incident audited, when an update changes state and priority, then two `sys_audit` rows share the same `record_checkpoint` equal to the new `sys_mod_count`.
51. **no_audit attribute.** Given `incident.u_secret` with `no_audit`, when it changes, then no `sys_audit` row is written for it.
52. **Activity email visibility.** Given `glide.ui.activity.email_roles=itil` and a sent email targeting the incident, when the caller fetches the activity stream, then no email entry appears; an itil user sees it.
53. **Assignment rule only when unassigned.** Given rule "category=network → group Network", when an incident with category network and an assignment group already set is inserted, then the group is unchanged; without a group it becomes Network.
54. **Assignment rule first match by order.** Given rules A (order 100, group G1) and B (order 50, group G2) both matching, when an incident is inserted, then assignment_group=G2.
55. **Data lookup wildcard.** Given a matcher row with empty urgency and `exact_match=false`, when an incident with impact 1 and any urgency is inserted, then priority is the row's priority.
56. **Priority lookup replace.** Given the seeded priority lookup, when an incident is updated from impact 3/urgency 3 to impact 1/urgency 1, then priority becomes 1 regardless of the previous value.
57. **Data lookup not inherited.** Given a definition on task, when an incident is inserted, then the lookup does not run.
58. **Metric duration.** Given an active field_value_duration metric on incident.assigned_to, when an incident is assigned to U1 at t0 then U2 at t1, then the U1 instance has `end=t1`, `duration=t1-t0`, `calculation_complete=true`, and a U2 instance is open.
59. **State model refusal.** Given an active model on a task table where "Completed" requires "State is Confirmed", when a record in "Held" is PATCHed to Completed, then 403 and state unchanged; from "Confirmed" it succeeds.
60. **State choices filtered.** Given the same model, when choices for state are requested for a Confirmed record, then only Confirmed and Completed are returned.
61. **Task active state management.** Given `close_states=3;4;7` on task.state, when a task moves from 2 to 3, then `active=false`; when moved back to 2, then `active=true`.
