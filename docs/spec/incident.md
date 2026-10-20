# ResolvrNow spec: Incident Management

Area: Incident Management (including Major Incident Management, incident tasks, parent/child incidents), Incident Communications Management, Task Outage, and the ITSM success KPIs for incidents.
Companions: [`problem.md`](problem.md) (Problem Management) and [`data/incident-problem.json`](data/incident-problem.json) (choices, extra tables, constants).
Reference release: ServiceNow "Brazil" public documentation. Status: draft v1, 2026-10-21.

## 0. Conventions

- **[Documented]**: stated in the public ServiceNow docs or in the MIT-licensed SDK table metadata (`server/src/schema/sdk/sdk-tables.json`, quoted as "SDK"). Restated in our own words.
- **[Inferred]**: not stated in those sources. Either a well-known platform convention, a reconciliation of conflicting pages, or a ResolvrNow design decision. Verify by black-box testing before claiming compatibility.
- Integer choice fields (state, impact, urgency, priority, hold_reason, severity) are stored as SQLite INTEGER and returned as strings by the Table API (`"state": "1"`), as ServiceNow does **[Documented]** (Table API sample response).
- Property names without a prefix are the ServiceNow names. Properties that exist only in ResolvrNow start with `resolvr.`.
- Vocabulary: *agent* = user with `itil`, `sn_incident_write` or `admin`; *ESS user* = user with no role; *MI* = major incident (`major_incident_state = accepted`).

Main sources (all under `https://www.servicenow.com/docs/r/it-service-management/`): `incident-management/c_IncidentManagement.html`, `incident-management/c_IncidentManagementStateModel.html`, `incident-management/incident-management-properties.html`, `incident-management/major-incident-management.html`, `incident-communications-management/c_IncidentAlertManagement.html`, `task-outage/task-outage.html`, `itsm-success-dashboard-indicators/sd-kpi-formulae.html`.

## 1. Module layout

| ResolvrNow module | ServiceNow plugin(s) mirrored | Contents | Basis |
|---|---|---|---|
| `incident` | com.snc.incident, com.snc.incident_management (state model), com.snc.incident_notification, com.snc.best_practice.incident.sandiego | incident table, state model, assignment, notifications, problem/KE integration | Documented |
| `incident.task` | part of com.snc.incident | incident_task table and sync | Documented |
| `incident.kcs` | com.snc.incident.knowledge | "Create Knowledge" related link; disables the Knowledge checkbox rule | Documented |
| `incident.mim` | com.snc.incident.mim (pulls in com.snc.iam, com.snc.incident.updates, com.snc.task_outage) | major incident fields, actions, trigger rules, PIR, workbench page | Documented |
| `icm` | com.snc.iam | incident communication plans and tasks | Documented |
| `task_outage` | com.snc.task_outage | task_outage m2m, Create Outage action | Documented |
| `itsm.roles` | com.snc.itsm.roles, com.snc.itsm.roles.incident_management, com.snc.business_stakeholder | granular roles | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-mgmt-plugins.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/activate-major-incident-management-plugin.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inc-mgmt-best-prac-plugin-sd.html.

## 2. Tables

| Table | Extends | Numbering | Purpose | Basis |
|---|---|---|---|---|
| `incident` | `task` | prefix `INC`, counter 10000, 7 digits, first record `INC0010001` | incidents (rows in `task`, `sys_class_name = incident`) | Documented (SDK) |
| `incident_task` | `task` | inherits `task` numbering (`TASK`, counter 20000) | work requested from other groups | Documented (table), Inferred (numbering) |
| `task_ci` | none | none | Affected CIs related list (task, ci_item); defined in `cmdb.md` | Documented (table), Inferred (columns) |
| `task_cmdb_ci_service` | none | none | Impacted Services/CIs related list; defined in `cmdb.md` | Documented |
| `task_service_offering` | none | none | Service Offerings related list; defined in `cmdb.md` | Documented |
| `dl_u_priority` | `dl_matcher` | none | impact x urgency -> priority rows; defined in `platform-core.md` | Documented |
| `resolvr_incident_strike` | none | none | caller strike counter per incident (section 8) | Inferred (ResolvrNow) |
| `major_incident_trigger_rule` | `sys_metadata` | none | MIM trigger rules | Documented |
| `incident_alert` | `comm_plan` | prefix `ICP` | incident communication plan | Documented |
| `incident_alert_task` | `comm_task` | prefix `ICT` | incident communication task | Documented |
| `task_outage` | none (m2m) | none | links any task to `cmdb_ci_outage` | Documented |
| `cmdb_ci_outage` | none | prefix `OUT` | outage records | Documented (table), Inferred (prefix) |
| `kb_template_incident_kcs_article` | `kb_knowledge` | KB numbering | KCS article created from an incident; defined in `knowledge.md` | Documented |
| `comm_plan`, `comm_task`, `comm_plan_definition`, `comm_task_definition` | `task` / `task` / none / none | none | Task Communications Management base tables used by ICM (minimal ResolvrNow columns) | Documented (comm_plan, comm_task), Inferred (definition tables, columns) |

Domain separation: `incident` and `incident_task` are domain separated (fulfillers see their domain, child domains and global) **[Documented]**. ResolvrNow v1 stores `sys_domain` but does not enforce domains **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/installed-with-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/comp-instal-itsm-enhanced-sec-features.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/domain-separation-incident-management.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/installed-with-mim.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/components-installed-with-icm.html.

## 3. Incident fields

Fields on `task` are inherited. "RO" = read-only on the form. Column names marked Inferred are not present in the SDK.

| Field | Label | Type | Reference / choices | Default | Notes | Basis |
|---|---|---|---|---|---|---|
| number | Number | string | auto | next INC number | RO | Documented |
| caller_id | Caller | reference | sys_user (dependent on company) | current user | mandatory on the form, optional when the incident comes from an alert, a change, or is an MI created from a candidate | Documented |
| opened_by / opened_at | Opened by / Opened | reference sys_user / glide_date_time | | current user / now | RO | Documented (SDK) |
| company / location | Company / Location | reference core_company / cmn_location | | copied from caller on insert when empty | | Documented (fields), Inferred (copy) |
| category | Category | string (choice) | `incident.category` | `inquiry` | | Documented (SDK default) |
| subcategory | Subcategory | string (choice) | `incident.subcategory`, dependent on category | empty | | Documented |
| business_service | Service | reference | cmdb_ci_service | | | Documented |
| service_offering | Service offering | reference | service_offering, qualifier `parent = business_service` | | | Documented (SDK) |
| cmdb_ci | Configuration item | reference | cmdb_ci, excludes CIs whose operational status blocks task creation | | | Documented (SDK) |
| contact_type | Channel | string (choice) | `incident.contact_type` | empty | label on the incident form is "Channel" | Documented |
| origin_table / origin_id | Origin table / Origin | table_name / document_id | | | system-set (for example an alert), RO | Documented |
| state | State | integer | `incident.state` | 1 | primary lifecycle field | Documented |
| incident_state | Incident state | integer | `incident.incident_state` | 1 | mirror of state (5.3) | Documented (SDK), Inferred (sync) |
| hold_reason | On hold reason | integer | `incident.hold_reason` | empty | visible and mandatory when state = 3 | Documented |
| impact / urgency | Impact / Urgency | integer | `task.impact` / `task.urgency` | 3 / 3 | | Documented (SDK) |
| priority | Priority | integer | `task.priority` | computed (section 6) | RO | Documented |
| severity | Severity | integer | `incident.severity` | 3 | not used for priority | Documented (SDK) |
| notify | Notify | integer | `incident.notify` | 1 | | Documented (SDK) |
| assignment_group | Assignment group | reference | sys_user_group | auto (section 7) | | Documented |
| assigned_to | Assigned to | reference | sys_user, qualifier `roles=itil`, dependent on assignment_group | | cleared when the group changes | Documented |
| reassignment_count | Reassignment count | integer | | 0 | RO | Documented (SDK) |
| short_description | Short description | string(160) | | | mandatory | Documented (field), Inferred (mandatory) |
| description | Description | string(4000) | | | | Documented |
| watch_list / work_notes_list | Watch list / Work notes list | glide_list | sys_user | | notification audiences for comments / work notes | Documented |
| comments / work_notes | Additional comments / Work notes | journal_input | | | comments are customer visible | Documented |
| parent_incident | Parent Incident | reference | incident, qualifier excludes self | | | Documented (SDK) |
| child_incidents | Child Incidents | integer | | 0 | RO, count of children | Documented (SDK), Inferred (maintenance) |
| problem_id | Problem | reference | problem | | | Documented |
| rfc | Change Request | reference | change_request | | | Documented |
| caused_by | Caused by Change | reference | change_request | | | Documented |
| close_code | Resolution code | string (choice) | `incident.close_code` | | mandatory to resolve/close | Documented (field), Inferred (mandatory) |
| close_notes | Resolution notes | string(4000) | | | mandatory to resolve/close; label overridden on incident | Documented (label), Inferred (mandatory) |
| resolved_by / resolved_at | Resolved by / Resolved | reference sys_user / glide_date_time | | | set on resolve | Documented |
| closed_by / closed_at | Closed by / Closed | reference / glide_date_time | | | set on close or cancel | Documented (SDK), Inferred (cancel) |
| reopen_count | Reopen count | integer | | 0 | RO | Documented |
| reopened_by / reopened_time | Last reopened by / Last reopened at | reference / glide_date_time | | | RO | Documented |
| knowledge | Knowledge | boolean | | false | hidden when module `incident.kcs` is active | Documented |
| calendar_stc / business_stc | Resolve time / Business resolve time | integer (seconds) | | | RO, set on resolve | Documented (SDK) |
| calendar_duration / business_duration | Duration / Business duration | glide_duration | | | RO, set on close | Documented (SDK) |
| business_impact | Business impact | string(4000) | | | MIM, prompted on propose/promote | Documented |
| cause | Probable cause | string(4000) | | | MIM tab | Documented |
| major_incident_state | Major incident state | string (choice) | `incident.major_incident_state` | empty | MIM extension | Documented (label), Inferred (column) |
| proposed_by / proposed_on | Proposed by / Proposed | reference sys_user / glide_date_time | | | MIM, RO | Documented (labels), Inferred (columns) |
| promoted_by / promoted_on | Promoted by / Promoted | reference sys_user / glide_date_time | | | MIM, RO | Documented (labels), Inferred (columns) |
| actions_taken | Actions taken | journal_input | | | MIM, internal only | Documented (label), Inferred (column) |
| overview / lessons_learned / timeline | Overview / Findings / Timeline | html | | | Post Incident Report tab | Documented (labels), Inferred (columns) |
| trigger_rule | Trigger rule | reference | major_incident_trigger_rule | | rule that proposed or promoted the incident | Inferred (ResolvrNow) |

Default form layout (ResolvrNow workspace "default" view) **[Documented]** section names, **[Inferred]** field placement:

| Section | Fields | Visible when |
|---|---|---|
| (main) | number, caller_id, category, subcategory, business_service, service_offering, cmdb_ci, contact_type, origin_id / state, hold_reason, impact, urgency, priority, assignment_group, assigned_to, short_description, description | always |
| Notes | watch_list, work_notes_list, comments, work_notes, actions_taken (MIM), activity stream | always |
| Related Records | parent_incident, problem_id, rfc, caused_by | always |
| Resolution Information | knowledge, close_code, close_notes, resolved_by, resolved_at | always (fields mandatory per 5.4) |
| Major Incident | major_incident_state, proposed_by, proposed_on, promoted_by, promoted_on, business_impact, cause | major_incident_state not empty |
| Post Incident Report | overview, lessons_learned, timeline | major_incident_state = accepted and state in (6, 7) |

Related lists: Incident Tasks, Child Incidents (incident.parent_incident), Affected CIs, Impacted Services/CIs, Task SLAs, Outages, Incident Communication Plans, Knowledge (attached articles), Requests (sc_request.parent), Interactions **[Documented]** (lists named in the docs) / **[Inferred]** (exact set and order).

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/create-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/view-major-info.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/resolve-and-close-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/reopening-incident.html.

## 4. Choice lists

Full lists with sequences live in `data/incident-problem.json`. Labels are documented; numeric values marked Inferred follow the well-known base values.

| Element | Values (value = label) | Basis |
|---|---|---|
| incident.state, incident.incident_state | 1 = New, 2 = In Progress, 3 = On Hold, 6 = Resolved, 7 = Closed, 8 = Canceled | Documented (labels, 7 = Closed), Inferred (other numbers) |
| incident.hold_reason | 1 = Awaiting Caller, 5 = Awaiting Change, 3 = Awaiting Problem, 4 = Awaiting Vendor | Documented (labels), Inferred (numbers) |
| task.impact, task.urgency | 1 = 1 - High, 2 = 2 - Medium, 3 = 3 - Low | Documented |
| task.priority | 1 = 1 - Critical, 2 = 2 - High, 3 = 3 - Moderate, 4 = 4 - Low, 5 = 5 - Planning | Documented |
| incident.severity | 1 = 1 - High, 2 = 2 - Medium, 3 = 3 - Low | Inferred |
| incident.contact_type (Channel) | chat, email, phone, monitoring, self-service, virtual_agent, walk-in | Documented (labels), Inferred (values) |
| incident.category | inquiry = Inquiry / Help, software, hardware, network, database | Documented (labels, `inquiry`), Inferred (other values) |
| incident.subcategory | inquiry: antivirus, email, internal application; software: email, os; hardware: cpu, disk, keyboard, memory, monitor, mouse; network: dhcp, dns, ip address, vpn, wireless; database: db2, sql server, oracle | Documented (labels), Inferred (values) |
| incident.close_code (active) | Duplicate, Known error, No resolution provided, Resolved by caller, Resolved by change, Resolved by problem, Resolved by request, Solution provided, Workaround provided, User error, Resolved - No response from caller | Documented ("Known error", "Resolved by problem", "Resolved - No response from caller"), Inferred (rest) |
| incident.close_code (legacy, inactive) | Solved (Work Around), Solved (Permanently), Solved Remotely (Work Around), Solved Remotely (Permanently), Not Solved (Not Reproducible), Not Solved (Too Costly), Closed/Resolved by Caller | Documented |
| incident.notify | 1 = Do Not Notify, 2 = Send Email | Inferred |
| incident.major_incident_state | proposed, accepted, rejected, canceled | Documented (labels), Inferred (values) |
| incident_task.state | -5 = Pending, 1 = Open, 2 = Work in Progress, 3 = Closed Complete, 4 = Closed Incomplete, 7 = Closed Skipped | Documented (Closed Incomplete, Closed Skipped), Inferred (rest) |

Close code values equal their labels (the field is a string and the documented UI page posts the label text as the value) **[Documented]**. Legacy codes are seeded `inactive` so imports and REST writes still validate **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/c_IncidentManagementStateModel.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/r_CategorizingIncidents.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/t_CreatingAUIAction.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/sync-btwn-inci-prob.html.

## 5. State model

### 5.1 States

| Value | Label | Meaning (paraphrased) | active | Basis |
|---|---|---|---|---|
| 1 | New | logged, not yet investigated | true | Documented |
| 2 | In Progress | assigned and under investigation | true | Documented |
| 3 | On Hold | waiting on another party; needs an On hold reason; can repeat | true | Documented |
| 6 | Resolved | fix or workaround delivered; caller may confirm or reject | true | Documented (meaning), Inferred (active) |
| 7 | Closed | resolution confirmed, by caller, admin or auto-close | false | Documented (meaning), Inferred (active) |
| 8 | Canceled | duplicate, unnecessary, or not an incident | false | Documented (meaning), Inferred (active) |

### 5.2 Transitions

Server-side rule `incident.state_guard` (before update) enforces the "Guard" column and aborts with the quoted message. UI actions (section 19) offer the guided path.

| # | From | To | Trigger | Who | Guard | Side effects | Basis |
|---|---|---|---|---|---|---|---|
| T1 | (insert) | 1 | create | anyone allowed to create | none | defaults, priority, assignment | Documented |
| T2 | 1 | 2 | state change; or assigned_to set while New and `resolvr.incident.assign_moves_to_in_progress` = true | agent | none | none | Inferred |
| T3 | 1, 2 | 3 | state change | agent | hold_reason required ("On hold reason is required"); when hold_reason = 1 the same update must add a comment | hold_reason 1 starts the strike cycle (8) | Documented (reasons, comment), Inferred (mandatory reason) |
| T4 | 3 | 2 | agent changes state, or the caller adds a comment (form, portal, email) | agent, caller | none | hold_reason cleared; caller-driven resume notifies assigned_to and watch list | Documented |
| T5 | 3 (reason 3) | 6 | linked problem Resolved/Closed with resolution code Fix Applied | system | none | close_code = "Resolved by problem", close_notes reference the problem, notify caller and assignee | Documented |
| T6 | 3 (reason 1) | 6 | strike cycle exhausted | system | `com.snc.incident.strike.count` > 0 | close_code = "Resolved - No response from caller", note that the caller did not answer | Documented |
| T7 | 1, 2, 3 | 6 | Resolve | agent, list_updater, caller on own non-MI incident | close_code and close_notes required ("Resolution code and resolution notes are required"); close_code "Known error" needs an attached Known Error article; ESS user cannot resolve an MI | resolved_by/at, calendar_stc, business_stc; children resolved (11); caller notified | Documented (roles, KE, MI), Inferred (message) |
| T8 | 6 | 2 | Reopen (form, portal, email link) | caller, opened_by, user with sn_incident_write or itil | ESS user cannot reopen an MI | reopen_count + 1, reopened_by, reopened_time; resolved_by, resolved_at, close_code, close_notes cleared; assignee notified | Documented (who, counters), Inferred (clearing, notification) |
| T9 | 6 | 7 | Close Incident; auto-close job | caller, itil_admin, admin; MI: major_incident_manager, admin | close_code and close_notes present | closed_by/at, durations, active = false, Knowledge rule, task and plan cascades | Documented |
| T10 | 1, 2, 3 | 7 | list "Update Selected" or API with resolution data | itil, list_updater, sn_incident_write, admin | close_code and close_notes required | as T9 (resolved_by/at filled if empty) | Documented (bulk close), Inferred (backfill) |
| T11 | 1, 2, 3 | 8 | state change to Canceled | agent | none | closed_by/at, active = false; MIM state proposed/accepted becomes canceled; tasks Closed Skipped; plans canceled (properties) | Documented (MIM, tasks), Inferred (who) |
| T12 | 7, 8 | any | | nobody | always aborts: "Closed or canceled incidents cannot change state" | a closed incident can only be "reopened" by email, which creates a new incident (10) | Documented (closed), Inferred (canceled) |
| T13 | 2, 3, 6 | 1; also 6 to 3 or 8 | any | nobody | aborts: "Invalid state transition" | none | Inferred |

Admins may still edit these fields on a closed or canceled incident: subcategory, business_service, service_offering, description, contact_type, watch_list, work_notes_list, parent_incident, problem_id, rfc, caused_by, resolved_by, resolved_at, reassignment_count **[Documented]**. All other fields are read-only for everyone once state is 7 or 8 **[Inferred]**.

### 5.3 `state` versus `incident_state`

`state` is the field to track and report on; `incident_state` is kept for legacy integrations **[Documented]**. Rule `incident.state_sync` (before insert/update, order 50): if only one of the two changed, copy it to the other; if both changed to different values, `state` wins **[Inferred]**. Both share the same choice values **[Inferred]**.

### 5.4 Field rules per state (UI policies plus server data policies)

| Condition | Rule | Basis |
|---|---|---|
| always | priority read-only (UI policy "Priority is managed by Data Lookup - set as read-only") | Documented |
| state = 3 | hold_reason visible and mandatory | Documented (visible), Inferred (mandatory) |
| state = 3 and hold_reason = 1 | comments mandatory on that update | Documented |
| state changes to 6 or 7 | close_code and close_notes mandatory | Inferred |
| state in (7, 8) | read-only except the admin list in 5.2 | Documented |
| state != 3 | hold_reason cleared by `incident.hold_rules` | Inferred |
| module incident.kcs active | knowledge checkbox hidden | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/c_IncidentManagementStateModel.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/resolve-and-close-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/t_ClosingIncidentsFromAList.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/reopening-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/close-major-incident.html.

## 6. Priority, impact, urgency, severity

Priority is derived from impact and urgency through the data lookup table `dl_u_priority` (columns impact, urgency, priority, active, order). The lookup runs on every insert and every update (data lookup "Run on insert" and "Run on update"), so a direct write to priority is overwritten whenever a matching active row exists **[Documented]** (lookup semantics) / **[Inferred]** (always-on for incident). If no row matches, priority keeps its value (default 4 from the SDK) **[Inferred]**.

| Impact \ Urgency | 1 - High | 2 - Medium | 3 - Low |
|---|---|---|---|
| 1 - High | 1 - Critical | 2 - High | 3 - Moderate |
| 2 - Medium | 2 - High | 3 - Moderate | 4 - Low |
| 3 - Low | 3 - Moderate | 4 - Low | 5 - Planning |

**[Documented]** Platform data lookup page (`dl_u_priority`) and the problem lookup page both give 3/3 = 5 - Planning. The incident "Define priority lookup rules" page shows a sample with 3/3 = 4 - Low. ResolvrNow seeds 5 (so a new incident with default impact 3 and urgency 3 gets 5 - Planning); admins (`data_lookup_admin`, `admin`) can edit rows.

Severity (1 High, 2 Medium, 3 Low, default 3) is an independent field with no derivation; a change to severity 1 fires `incident.severity.1` **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/def-prio-lookup-rules.html, https://www.servicenow.com/docs/r/platform-administration/r_CreateCustomDataLookups.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/prioritise-problems.html.

## 7. Assignment and reassignment

Order of evaluation on insert and update (all before rules):

1. Explicit values from the user or API always win.
2. `incident.populate_assignment_group` (order 900): when assignment_group and assigned_to are both empty, copy the CI's support group, else the service offering's support group. The CI field defaults to `support_group`; override with `com.snc.incident.ci_assignment_group.field_name`, and for offerings with `com.snc.incident.service_offering_assignment_group.field_name` **[Documented]** (rule name, properties), **[Inferred]** (order, default column).
3. Assignment rules (`sysrule_assignment`, managed by `assignment_rule_admin`) at order 1000 when the group is still empty **[Documented]** (rules exist), **[Inferred]** (order).
4. `task.clear_assignee_on_group_change`: if assignment_group changes and assigned_to did not change in the same update, assigned_to is cleared **[Documented]**.
5. `task.reassignment_counter`: when assignment_group changes from a non-empty value to another value, reassignment_count + 1 **[Inferred]**.

Visibility: a user without `admin`/`security_admin` cannot pick a group that holds those roles (or whose parent does) **[Documented]**. assigned_to choices are users with `itil` (SDK qualifier); ResolvrNow also accepts `sn_incident_write` **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/create-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/t_DefinAnAssignRuleIncidents.html.

## 8. On hold, caller response and strikes

- On hold reasons: Awaiting Caller, Awaiting Change, Awaiting Problem, Awaiting Vendor. An incident may go on hold several times **[Documented]**.
- Caller response: when the caller updates an incident that is On Hold (any reason) by comment, portal or email reply, ResolvrNow clears hold_reason, sets state 2, and notifies assigned_to and the watch list **[Documented]**.
- Strike automation (Awaiting Caller only) **[Documented]** behavior, **[Inferred]** mechanics:
  - Properties: `com.snc.incident.strike.count` (default 3, 0 disables) and `com.snc.incident.strike.wait_period` (business days, default 1).
  - ResolvrNow keeps a side table `resolvr_incident_strike` (incident, attempts, next_due) instead of adding columns to incident.
  - Entering On Hold / Awaiting Caller sends reminder 1 and sets next_due = now + wait_period (business days, default schedule). Job `Incident strike reminders` (every 15 minutes) sends reminders 2..N at each next_due. After reminder N and one more wait_period without a caller update, the incident is resolved (T6) with close_notes stating that the caller did not respond.
  - Any caller update or a state change away from 3/1 deletes the strike row.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/resolve-and-close-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-management-properties.html.

## 9. Resolution, caller confirmation, closure and auto-close

Resolution: resolving stops escalations, records resolved_by/resolved_at, and sends the caller the "resolved" notification built from template `incident.ess.resolve`, which carries a Reopen link **[Documented]**. calendar_stc = seconds from opened_at to resolved_at; business_stc = same span measured on `resolvr.incident.business_schedule` (calendar time when unset) **[Documented]** (fields), **[Inferred]** (schedule).

Caller confirmation **[Documented]** (behavior), **[Inferred]** (exact actions):

| Caller response | Effect |
|---|---|
| Accepts (Close on the portal ticket page or form) | T9, closed_by = caller |
| Rejects (Reopen link, Reopen button) | T8, incident back to In Progress, never auto-closed while reopened |
| No answer | auto-close after the configured delay |
| Replies to the resolution email with "Please reopen" after closure | new incident cloned from the closed one with the fields listed in `com.snc.incident.clone_fields_on_reopen` (empty list disables) |

When the caller resolves their own incident from the portal, ResolvrNow sets close_code "Resolved by caller" and close_notes "Resolved by caller" when empty **[Inferred]**. An optional satisfaction survey can be sent on closure (out of scope for v1) **[Documented]**.

Auto-close **[Documented]** unless marked:
- Scheduled job `Autoclose Incidents` (hourly **[Inferred]**) closes incidents in state 6 whose `resolved_at` (if `com.snc.incident.autoclose.basedon.resolved_at` = true, default for new instances) or `sys_updated_on` (if false) is older than `glide.ui.autoclose.time` days (default 7; 0 disables).
- The docs describe the delay as business days while the property label says days; ResolvrNow counts calendar days unless `resolvr.incident.autoclose.business_days` = true **[Inferred]**.
- MIs (`major_incident_state = accepted`) are never auto-closed.
- Updated by / closed_by = the user named in the job's run-as setting (SN: `fcRunAs`), default `system` **[Documented]** (setting), **[Inferred]** (default).
- An inactivity monitor that touches the incident resets the "updated" clock; this only matters when closing on the updated date.

Closure side effects (rule `incident.close_cascades`, after update when state changes to 7 or 8): incident tasks (13), communication plans (16), Knowledge checkbox article (14), task durations **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/c_IncidentResolutionAndRecovery.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/configure-incident-auto-close.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/change-default-user.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/t_UpdateTheResolvedIncidentNotificationTemplate.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-stnd-ticket-page.html.

## 10. Reopening

- Only Resolved incidents can be reopened; Closed and Canceled cannot **[Documented]** / **[Inferred]** (canceled).
- Allowed: the caller, the opened_by user, and agents with incident write access. On the portal, an agent sees Reopen only if assigned, caller or requester **[Documented]**.
- Effects: state 2, reopen_count + 1, reopened_by, reopened_time **[Documented]**; reopen_count counts every move out of Resolved or Closed **[Documented]** (SDK hint).
- Children: reopening by an agent also reopens resolved children; reopening by an ESS caller does not **[Documented]**.
- Email: a reply to a closed incident containing "Please reopen" in the subject creates a new incident (section 9) **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/reopening-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/parent-child-state-sync.html.

## 11. Parent and child incidents

`parent_incident` groups incidents with the same root issue. Rule `incident.parent_child_sync` (after update on the parent, order 200) **[Documented]** (table), **[Inferred]** (mechanics):

| Parent change | Children touched | Child result |
|---|---|---|
| to 2 (not a reopen) | active children in 1 or 3 | state 2, hold_reason cleared |
| to 3, reason Change, Problem or Vendor | active children in 1, 2, 3 | state 3 with the same reason |
| to 3, reason Caller | none | unchanged |
| to 6 | active children in 1, 2, 3 | state 6, parent's close_code and close_notes copied, parent's resolution notes added to the child's activity |
| to 7 | none | unchanged; children close by caller or auto-close |
| to 8 | none | unchanged |
| reopen by agent | children in 6 | reopened (T8 effects) |
| reopen by ESS caller | none | unchanged |
| parent becomes MIM proposed/accepted | none | unchanged |

- Linking a child (insert or `parent_incident` set) aligns the child with the parent's current state when the parent is in 2, 3 (non-caller reason) or 6 **[Documented]** (ATF test name), **[Inferred]** (details).
- Child updates run their own rules, so cascades are recursive; ResolvrNow stops at depth 10 **[Inferred]**.
- `incident.child_count` keeps parent.child_incidents = number of incidents pointing to it **[Inferred]**.
- Guard: a parent cannot be itself (SDK qualifier) or one of its descendants: "Parent incident would create a loop" **[Inferred]**.
- Resolving an MI resolves all its children and each caller is notified **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/parent-child-state-sync.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-management-process.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/quick-start-tests-im.html.

## 12. Copy incident and create child incident

| Aspect | Behavior | Basis |
|---|---|---|
| Enablement | `com.snc.incident.copy.enable`, `com.snc.incident.create.child.enable` | Documented |
| Who | agents for any incident; ESS user only for incidents they opened | Documented |
| Copied fields | `com.snc.incident.copy.attributes`, default: category, subcategory, business_service, cmdb_ci, impact, urgency, assignment_group, short_description, description, caused_by, location, company, problem_id, rfc, parent_incident | Documented (list), Inferred (column names) |
| Skipped | problem_id, rfc, parent_incident when the target is inactive; resolution data and knowledge are never copied | Documented |
| Related lists | `com.snc.incident.copy.related_lists`, default task_ci, task_cmdb_ci_service, task_service_offering; also allowed task_cmdb_ci_business_app; column lists in `com.snc.incident.copy.rl.task_ci.attributes` and `com.snc.incident.copy.rl.task_cmdb_ci_services.attributes` | Documented |
| Attachments | copied when `com.snc.incident.copy.attach` = true | Documented |
| Copy marker | new incident gets work note "Created from a similar incident: INCxxxxxxx" | Documented |
| Child | same copy, plus `parent_incident` = source | Documented |
| Closed source | Copy Incident stays available on closed incidents | Documented |

The copy is presented as an unsaved form prefilled with the values (user submits) **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/copy-incident-or-create-child-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-management-properties.html.

## 13. Incident tasks

- `incident_task` extends task; key fields: number, incident (reference incident, mandatory), cmdb_ci, state, priority, assignment_group, assigned_to, short_description, description, work_notes_list, work_notes **[Documented]**. Default state 1 Open **[Inferred]**.
- Created from the Incident Tasks related list or the "Create Incident Task" action; when assignment_group is blank, assignment rules apply; changing the group clears assigned_to; a closed task is read-only **[Documented]**.
- Closure cascade `incident.close_tasks` (after update when incident state changes to 7 or 8) when `com.snc.incident.incident_task.closure` = true (default for new instances): open tasks (state in -5, 1, 2) become 4 Closed Incomplete on Closed, 7 Closed Skipped on Canceled **[Documented]**.
- Role `sn_incident_task_assigned_user` lets the assigned agent read and write that task; without the granular role pack the agent cannot read work notes and cannot write assigned_to, short_description, description, priority, state, work notes **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/create-incident-task.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inci-inci-task-state-sync.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/installed-with-incident.html.

## 14. Links to problem, change, request and knowledge

| Action | Effect | Basis |
|---|---|---|
| Create Problem | new saved problem with `com.snc.problem.create_from_incident.attributes` (default number, description, short_description, cmdb_ci, impact, urgency, priority, company, sys_domain, business_service, category, subcategory); `number` is used to set problem.first_reported_by_task instead of being copied; incident.problem_id = new problem; incident goes On Hold / Awaiting Problem; attachments and KB links copied when `com.snc.problem.create_from_incident.copy_attachments` = true | Documented (attributes, hold, attachments), Inferred (number mapping) |
| Create Normal / Standard / Emergency Change | new saved change_request copying short_description, description, cmdb_ci, priority, company; incident.rfc = change; change.parent = incident | Documented (fields), Inferred (links) |
| Create Request | opens the catalog; resulting request linked to the incident; caller becomes Requested for; record producers link through `parent` | Documented |
| Attach Known Error article | if the article's source problem exists, incident.problem_id is set to it | Documented |
| Resolve with "Known error" | requires an attached Known Error article, otherwise abort "Attach a known error article" | Documented (prompt), Inferred (message) |
| Knowledge checkbox (KCS off) | on close, rule `Incident Create Knowledge` creates a draft kb_knowledge: short_description, text = comments, source = incident; with `glide.knowman.submission.workflow` it creates a submission instead (implemented by `knowledge.md` section 12) | Documented |
| Create Knowledge (KCS on) | related link visible when state = 6 and no article was created from this incident; opens a `kb_template_incident_kcs_article` draft (Issue, Resolution, Source Task; prefill per `knowledge.md` section 12) | Documented |
| Problem workaround / fix shared | incident activity gets a work note with a summary and links (problem, KE article); see problem.md section 9 | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/t_PromoteAnIncident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-request-from-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inc-mgmt-best-prac-plugin-sd.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-knowledge-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-a-knowledge-article.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-a-problem-v2.html.

## 15. Major Incident Management (module `incident.mim`)

### 15.1 Major incident state

| From | To | Trigger | Roles | Prompted input | Side effects | Basis |
|---|---|---|---|---|---|---|
| empty, rejected, canceled | proposed | "Propose Major Incident"; trigger rule (propose); module "Create Major Incident Candidate" | itil, sn_incident_write, admin; system | reason (work note), business_impact | proposed_by/proposed_on; assignment 15.2 | Documented (re-propose after reject: Inferred) |
| empty, proposed, rejected | accepted | "Promote to Major Incident"; trigger rule (promote); module "Create Major Incident" | major_incident_manager | work note, business_impact | promoted_by/promoted_on; assignment 15.2; optional new-MI mode 15.3; optional problem creation | Documented |
| proposed | rejected | "Reject Major Incident Candidate" (form or list, bulk) | major_incident_manager | rejection reason | incident state unchanged; assigned_to notified | Documented |
| accepted | canceled | "Demote Major Incident" | major_incident_manager | demotion reason | incident state unchanged | Documented |
| proposed, accepted | canceled | incident canceled (state 8) | system | | | Documented |

Rules: Propose and Promote are hidden when state is 6, 7 or 8 **[Documented]**. Proposal and acceptance never cascade state to children **[Documented]**. Reasons are written to work_notes **[Inferred]**. Users without roles cannot resolve, close or reopen an MI, even as caller; only major_incident_manager or admin can close one, manually, from Resolved **[Documented]**.

### 15.2 Assignment on MIM events

Group G = sys_user_group in `sn_major_inc_mgmt.major_incident_management_group` **[Documented]**.

| Event | assignment_group empty | assignment_group set |
|---|---|---|
| Proposed (manual or rule) | set to G; assigned_to = on-call user of G if on-call scheduling is active and someone is on shift, else empty | unchanged (group and assignee) |
| Promoted manually | set to G; assigned_to = promoter | replaced by G; assigned_to = promoter; notify previous group members and previous assignee |
| MI created directly | set to G; assigned_to = creator | unchanged |

**[Documented]** (table on the assignment page).

### 15.3 Promotion modes and copied data

`sn_major_inc_mgmt.com.snc.incident.mim.major_incident_creation` **[Documented]**: `promote` (the candidate itself becomes the MI) or `create_new` (a new incident becomes the MI and the candidate becomes its child; caller and company optional on the new MI). Values and default `promote` are **[Inferred]**. In `create_new` mode ResolvrNow copies `sn_major_inc_mgmt.com.snc.major_incident.create.copy.attributes` from the candidate and clears the candidate's major_incident_state with a work note pointing at the new MI **[Documented]** (copy property), **[Inferred]** (clearing). Trigger rule action "promote" under `create_new` also creates a new MI with the existing incident as child **[Documented]**.

When the MI is accepted and has no problem_id, a problem is created only if the flow "Create Problem from Major incident" is activated (inactive by default) **[Documented]**.

"Link to Major Incident" (list action, itil / sn_incident_write / admin) sets parent_incident of the selected incidents to the chosen MI **[Documented]**.

### 15.4 Trigger rules

Table `major_incident_trigger_rule`: name (unique), table (default incident), application, order (Execution Order), action (`propose` | `promote`), active, condition **[Documented]**. Base rules ship inactive **[Documented]**. Rule `incident.mim_trigger_rules` (async, insert and update) runs only when parent_incident is empty, major_incident_state is not proposed/accepted, and the incident is active; rules run in ascending order and the first match wins **[Documented]**. It sets `trigger_rule` and applies 15.1 as the system user **[Inferred]**.

### 15.5 Post Incident Report (PIR)

- Fields overview, lessons_learned (Findings), timeline; editable by the major incident manager while the MI is Resolved **[Documented]**.
- Timeline = merged activity of the incident, its communication plans and their tasks, sorted by time; "Regenerate PIR Timeline" rebuilds it (related link: state 6 and role major_incident_manager) **[Documented]**. "Preview PIR" (state 6 or 7, role itil) **[Documented]**. PDF export via `sn_major_inc_mgmt.pir_export_pdf_ui_page` is out of scope for v1.
- Time to Identify = from the earlier of first related alert or incident creation, to the first proposal (proposed path) or to promotion (direct path) **[Documented]**.

### 15.6 Workbench

ResolvrNow page for incidents with major_incident_state proposed or accepted ("View Workbench"): header with Resolve (when state != 6), promote/reject picker (when not accepted), editable state, and a duration timer from creation until resolution; tabs Summary, Communicate, Collaborate, Post Incident Report **[Documented]** (elements), **[Inferred]** (layout).

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-management.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-major-incident-candidate.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-a-major-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-assignment.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/accept-reject-major-incident-candidate.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/demote-major-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/close-major-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-trigger-rules.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/mi-workbench-pir-tab.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-workbench.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/asso-multi-inci-with-major-inci.html.

## 16. Incident Communications Management (module `icm`, brief)

| Item | Specification | Basis |
|---|---|---|
| Plan (`incident_alert`, ICP) | source_incident, type (Ad hoc, End User, Stakeholder, Technical), comm_plan_definition, state, assignment_group, assigned_to (defaults to creator), order, short_description, description, background (prefilled from source incident) | Documented (fields), Inferred (column names) |
| Plan states | Open, Closed, Canceled; created Open (current model) | Documented |
| Task (`incident_alert_task`, ICT) | incident_alert, source_incident, type, comm_task_definition, state, assignment_group, assigned_to, order, communication_frequency (once or recurring), due_in, last_communication_sent | Documented |
| Task states | Pending, Open, In Progress, Complete, Skipped | Documented |
| Channels | email, SMS (needs a telephony provider), conference, Slack | Documented |
| Attach by definition | plan definitions (table must be incident) attach plans and tasks when their conditions match the incident | Documented |
| Assignment | plan from an MI copies group and assignee when empty; task from that plan copies the plan's values when empty | Documented |
| Close Task | Complete if communicated at least once, otherwise Skipped; Snooze skips one occurrence of a recurring task and restarts its due timer; sending a one-time task completes it, a recurring one shows "Sent (Nx)" | Documented |
| Cascade incident to plans | rule `Cascade Closure of ICPs`: when `com.snc.incident.incident_alert.closure` = true (default false), incident Closed closes open plans, Canceled cancels them | Documented |
| Cascade plan to tasks | when `com.snc.iam.incident_alert_task.closure` = true (default false), plan closed or canceled sets open tasks to Complete (communicated at least once) or Skipped | Documented |
| Who closes a plan | ia_admin, admin, or the itil user assigned to it | Documented |
| Default contacts notified on plan creation | responsibilities Duty Manager, Incident Manager, Duty Director; optional: Business Director, Communication Manager, Crisis Action Manager, Crisis Action Team Member, Development personnel, Operations support personnel, Service Owner, Technical Support | Documented |
| Notifications (category "Incident Communication Plan") | New IA Raised, IA Actions Taken, IA Cancelled, IA Resolved Or Closed | Documented |

ResolvrNow numeric codes: plan 1 Open, 3 Closed, 7 Canceled; task -5 Pending, 1 Open, 2 In Progress, 3 Complete, 7 Skipped **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/incident-comm-plan-new-state-model.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/t_CreateAnAlertFromAnIncident.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/create-adhoc-inci-commu-task.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/close-an-inci-comm-plan.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/r_ResponsibilitiesForIncidentAlerts.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/t_SubscribeToANotification.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/mi-workbench-communicate-tab.html.

## 17. Task Outage (module `task_outage`, brief)

- `task_outage` is a many-to-many between `task` and `cmdb_ci_outage` **[Documented]**.
- "Create Outage" UI action on `task`, condition: record class is incident or problem (change_request too on new instances) **[Documented]**. Role itil or admin **[Documented]**. It opens a new outage with cmdb_ci and task_number prefilled and creates the task_outage link on save **[Inferred]** (link creation).
- Outage fields: number, cmdb_ci, type, begin, end, duration (end minus begin, computed), task_number, short_description; related links "Begin Outage Now" / "End Outage Now" set begin / end to now **[Documented]** (fields, links), **[Inferred]** (duration computation).
- Outage type choices: outage, degradation, planned **[Inferred]**.
- The Outages related list appears on incident, problem and change forms; the Tasks related list on outages lets itil users associate several tasks **[Documented]**. Admin role: sn_task_outage_admin **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/task-outage/task-outage.html, https://www.servicenow.com/docs/r/it-service-management/task-outage/t_AddTheUIActionToAnotherTaskForm.html, https://www.servicenow.com/docs/r/it-service-management/task-outage/t_CreateAnOutageFromATask.html, https://www.servicenow.com/docs/r/it-service-management/task-outage/t_AssociateATaskToAnOutage.html, https://www.servicenow.com/docs/r/it-service-management/task-outage/components-instld-with-task-outage.html.

## 18. Business rules (ResolvrNow catalog)

Names in quotes are ServiceNow rule names that appear in the docs **[Documented]**; the rest are ResolvrNow names **[Inferred]**. "B" before, "A" after, "Q" query, "S" scheduled.

| Rule | Table / when / order | Condition | Behavior |
|---|---|---|---|
| incident.defaults | incident / B insert / 10 | always | caller_id = current user if empty; company/location from caller; state 1; impact/urgency 3; category inquiry |
| incident.state_sync | incident / B insert, update / 50 | state or incident_state changed | section 5.3 |
| incident.priority_lookup | incident / B insert, update / 60 | always | section 6 |
| incident.state_guard | incident / B update / 100 | state changed | transition table 5.2; abort with message |
| incident.hold_rules | incident / B insert, update / 110 | always | hold_reason mandatory on 3, cleared otherwise; comment required for Awaiting Caller |
| incident.caller_resume | incident / B update / 120 | state = 3 and comments changed by caller | T4 |
| incident.resolve_fields | incident / B update / 130 | state changes to 6 | resolved_by/at, stc fields, KE check, ESS-on-MI check |
| incident.reopen | incident / B update / 140 | previous state 6 and new state 2 | T8 effects |
| incident.close_fields | incident / B update / 150 | state changes to 7 or 8 | closed_by/at, active false, durations, resolution backfill |
| "Populate Assignment Group based on CI/SO" | incident / B insert, update / 900 | group and assignee empty | section 7 |
| task.clear_assignee_on_group_change, task.reassignment_counter | task / B update / 950 | assignment_group changed | section 7 |
| incident.events | incident / A insert, update / 100 | always | queue events (section 20) |
| incident.parent_child_sync | incident / A update / 200 | state changed and child_incidents > 0 | section 11 |
| incident.child_count | incident / A insert, update, delete / 210 | parent_incident changed or record deleted | recount old and new parent |
| incident.close_tasks | incident / A update / 300 | state changes to 7 or 8 and property on | section 13 |
| "Cascade Closure of ICPs" | incident / A update / 310 | state changes to 7 or 8 and property on | section 16 |
| "Incident Create Knowledge" | task / async update (owned by `knowledge.md` section 12) | state changes to 7, knowledge = true, KCS off | section 14 |
| incident.problem_from_ke | m2m_kb_task / A insert | task is an incident and the article is a KE article whose source is a problem | set incident.problem_id |
| incident.mim_cancel | incident / B update / 160 | state changes to 8 and MIM state proposed/accepted | MIM state canceled |
| incident.mim_trigger_rules | incident / async insert, update | 15.4 preconditions | 15.4 |
| "incident query" | incident / Q | user lacks itil, sn_incident_read, admin | restrict to caller_id = me OR opened_by = me OR watch_list contains me |
| "Update Incident when Problem closes" (script action) | problem event | see problem.md 10 | T5 and risk-accepted work note |
| "Autoclose Incidents" job running "incident autoclose" | S hourly | property > 0 | section 9 |
| Incident strike reminders | S every 15 min | strike rows due | section 8 |

Abort semantics: a before rule aborts by throwing the engine's abort error with a user-facing message; the REST API returns 403 with that message for business-rule aborts (ResolvrNow convention) **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/create-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/logging-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-knowledge-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/close-an-inci-comm-plan.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inc-mgmt-best-prac-plugin-sd.html.

## 19. UI actions

| Action | Placement | Visible when | Roles / users | Effect | Basis |
|---|---|---|---|---|---|
| Resolve | form button, portal action, list (bulk) | state in (1, 2, 3); not (ESS and MI) | agent, list_updater, caller | dialog for close_code and close_notes, then T7 | Documented |
| Reopen / Reopen incident | form button, portal action, email link | state = 6; not (ESS and MI) | caller, opened_by, sn_incident_write, itil | T8 | Documented |
| Close Incident | form button, portal action | state = 6 | caller, itil_admin, admin; MI: major_incident_manager, admin | T9 | Documented |
| Close incidents (optional sample) | list action | state != 7 | as configured | dialog for close_code and notes, sets state 7 on selected rows | Documented |
| Create Problem | form context menu | state not in (6, 7, 8) and problem_id empty | itil, itil_admin, sn_incident_write, admin | section 14 | Documented (action, roles), Inferred (condition) |
| Create Normal / Standard / Emergency Change | form context menu | active and rfc empty | itil, itil_admin, sn_incident_write, admin | section 14 | Documented (actions), Inferred (condition) |
| Create Request | form context menu | active | itil, sn_incident_write | section 14 | Documented |
| Copy Incident | form context menu | `com.snc.incident.copy.enable`; any state | agent; ESS on own | section 12 | Documented |
| Create Child Incident | form context menu | `com.snc.incident.create.child.enable`; state not in (7, 8) | agent | section 12 | Documented (action), Inferred (state) |
| Create Incident Task | form context menu, related list New | active | itil, sn_incident_write, admin | new incident_task with incident set | Documented |
| Create Knowledge | related link, context menu | state = 6, KCS on, no article from this incident | itil, sn_incident_write, admin | section 14 | Documented |
| Propose Major Incident | form context menu, mobile menu | state not in (6, 7, 8); MIM state not proposed/accepted | itil, sn_incident_write, admin | 15.1 | Documented |
| Promote to Major Incident | form context menu, workbench | state not in (6, 7, 8); MIM state != accepted | major_incident_manager | 15.1 | Documented |
| Reject Major Incident Candidate | form context menu, list action | MIM state = proposed | major_incident_manager | 15.1 | Documented |
| Demote Major Incident | form context menu | MIM state = accepted | major_incident_manager | 15.1 | Documented |
| Link to Major Incident | list action | selected incidents active | itil, sn_incident_write, admin | 15.3 | Documented |
| View Workbench | form header | MIM state in (proposed, accepted) | sn_incident_read and above | 15.6 | Documented |
| Regenerate PIR Timeline | related link | MI and state = 6 | major_incident_manager | 15.5 | Documented |
| Preview PIR | related link | MI and state in (6, 7) | itil | 15.5 | Documented |
| New communication plan | related list New, workbench Add | active | major_incident_manager, ia_admin, admin | 16 | Documented |
| Create Outage | form context menu | class in (incident, problem, change_request) | itil, admin | 17 | Documented |
| Email | form header menu | always | agent | compose mail to caller and assignee | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/resolve-and-close-an-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/reopening-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/t_PromoteAnIncident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/copy-incident-or-create-child-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/create-major-incident-candidate.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/mi-workbench-pir-tab.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/t_CreatingAUIAction.html.

## 20. Events and notifications

Events (queued by `incident.events` and the MIM rules; all names **[Inferred]**, following ServiceNow naming):

| Event | Fired when | parm1 / parm2 |
|---|---|---|
| incident.inserted | insert | user id / user name |
| incident.updated | any update | user id / user name |
| incident.assigned | assigned_to changes to a value | new / previous assignee |
| incident.assigned.to.group | assignment_group changes to a value | new / previous group |
| incident.commented | comments added on update | author |
| incident.worknoted | work_notes added | author |
| incident.priority.1 / incident.severity.1 | priority / severity changes to 1 | new / previous |
| incident.escalated | escalation increases | new / previous |
| incident.resolved, incident.closed, incident.canceled, incident.reopened | matching transition | user |
| incident.caller.responded | T4 by caller | caller |
| incident.strike.reminder / incident.strike.resolved | section 8 | attempt number |
| incident.mim.proposed, .accepted, .rejected, .demoted, .reassigned | 15.1 / 15.2 | user / reason |

Default notifications:

| Notification | Trigger | Recipients | Basis |
|---|---|---|---|
| Incident opened for me | incident.inserted | caller | Inferred |
| Incident assigned to my group | incident.assigned.to.group with empty assigned_to | group members | Inferred |
| Incident assigned to me | incident.assigned | assigned_to | Inferred |
| Incident commented | incident.commented by someone other than the recipient | caller, watch list | Documented (watch list), Inferred (caller) |
| Incident work noted | incident.worknoted | work notes list; shipped inactive (admin must enable) | Documented |
| Incident resolved (template incident.ess.resolve, Reopen link) | incident.resolved | caller | Documented |
| Caller responded | incident.caller.responded | assigned_to, watch list | Documented |
| Awaiting caller reminder | incident.strike.reminder | caller | Documented |
| Incident reopened | incident.reopened | assigned_to (else group) | Inferred |
| Resolved by problem / risk accepted | problem sync (problem.md 10) | caller and assigned_to / assigned_to | Documented |
| Workaround or fix communicated | problem.md 9 | assigned_to and work notes list (work note path); caller, assigned_to, watch list (comment path) | Documented |
| MI candidate rejected | incident.mim.rejected | assigned_to | Documented |
| MI reassigned on promotion | incident.mim.reassigned | previous group members, previous assignee | Documented |
| ICP notifications | section 16 | default and subscribed contacts | Documented |

End users must have notifications enabled to receive them (subscription preferences) **[Documented]**. Links in emails open the agent workspace for workspace users when `sow_email_notification_redirect` (or the per-table override `sow_email_notification_redirect.incident`, and `sn_major_inc_mgmt.sow_email_notification_redirect.mim` for MIs) is true; otherwise the classic form or portal ticket **[Documented]** (properties), **[Inferred]** (ResolvrNow routing).

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/t_ViewIncidentNotification.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/email-notif-redirt-inci-major-inci.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/c_IncidentManagementStateModel.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/accept-reject-major-incident-candidate.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-assignment.html.

## 21. Roles and access control

| Role | Contains | Purpose | Basis |
|---|---|---|---|
| itil | | legacy fulfiller: create, read, write incidents | Documented |
| itil_admin | itil | can close incidents | Documented |
| list_updater | | bulk list updates (resolve/close) | Documented |
| sn_incident_read | dependency_views, agent_workspace_user, view_changer, cmdb_read, cmdb_query_builder_read | read all incidents and the MI workbench | Documented |
| sn_incident_write | sn_incident_read, template_editor | write incidents | Documented |
| sn_service_desk_agent | sn_incident_write, sn_problem_write, sn_change_write, sn_request_write, tracked_file_reader | tier-1 agent | Documented |
| incident_manager | ia_admin, sn_comm_management.comm_plan_admin, sn_incident_write (itil on upgraded instances) | incident properties, trigger rules, plan definitions | Documented |
| sn_incident_admin | incident_manager, sn_sow_inc.sn_incident_sow_admin, sn_bm_client_benchmark_data_viewer | configure Incident Management | Documented |
| sn_incident_task_assigned_user | | access to tasks assigned to the user | Documented |
| major_incident_manager (also written mim_manager) | sn_comm_management.comm_plan_viewer, sn_comm_management.comm_plan_manager, ia_admin, sn_incident_write, sn_problem_write, sn_change_write, sn_request_write | accept, reject, demote, close MIs; ad hoc plans | Documented |
| sn_mim_admin | major_incident_manager, sn_iam_admin, sn_sow_mim.sn_mim_sow_admin | configure MIM | Documented |
| communication_manager | sn_comm_management.comm_plan_viewer, ia_admin, sn_incident_write, sn_problem_write, sn_change_write, sn_request_write | stakeholder communications | Documented |
| ia_admin / sn_iam_admin | contact_admin, sn_comm_management.comm_plan_manager, notify_view / ia_admin | plans, tasks, contacts | Documented |
| business_stakeholder | sn_incident_read, sn_problem_read, sn_change_read, sn_request_read, approver_user, sn_incident_comments_write | view and approve across ITSM | Documented |
| sn_task_outage_admin, data_lookup_admin, assignment_rule_admin | | configuration | Documented |

ACL summary (ResolvrNow):

| Operation on incident | Allowed | Basis |
|---|---|---|
| create | any authenticated user (ESS through portal, record producer or email) | Documented (channels), Inferred (ACL) |
| read | itil, sn_incident_read, admin; others only rows passing the "incident query" rule | Documented |
| write | itil, sn_incident_write, admin; ESS on own rows: watch_list, short_description, comments, plus Resolve/Reopen/Close actions | Documented |
| write on state 7/8 | admin only, limited field list (5.2) | Documented |
| delete | admin, sn_incident_admin | Inferred |
| any, unauthenticated | denied (deny-unless ACL) | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/inci-roles-instld-itsm-roles.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/installed-with-mim.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/installed-with-business-stakeholder-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-communications-management/components-installed-with-icm.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/logging-incident.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/comp-instal-itsm-enhanced-sec-features.html.

## 22. Properties

| Property | Type | Default | Purpose | Basis |
|---|---|---|---|---|
| glide.ui.autoclose.time | integer | 7 | days before resolved incidents auto-close; 0 disables | Documented |
| com.snc.incident.autoclose.basedon.resolved_at | boolean | true | auto-close on resolved_at (false: on sys_updated_on) | Documented |
| com.snc.incident.incident_task.closure | boolean | true | close open incident tasks on close/cancel | Documented |
| com.snc.incident.strike.count | integer | 3 | caller reminders before auto-resolve; 0 disables | Documented |
| com.snc.incident.strike.wait_period | integer | 1 | business days between reminders | Documented |
| com.snc.incident.incident_alert.closure | boolean | false | close/cancel plans with the incident | Documented |
| com.snc.iam.incident_alert_task.closure | boolean | false | close plan tasks with the plan | Documented |
| com.snc.incident.clone_fields_on_reopen | string | empty | fields cloned when "Please reopen" mail hits a closed incident | Documented (name), Inferred (default) |
| com.snc.incident.copy.enable / create.child.enable | boolean | true / true | copy and child actions | Documented (names), Inferred (defaults) |
| com.snc.incident.copy.attach | boolean | false | copy attachments | Documented (name), Inferred (default) |
| com.snc.incident.copy.attributes | string | see section 12 | copied fields | Documented |
| com.snc.incident.copy.related_lists | string | task_ci,task_cmdb_ci_service,task_service_offering | copied related lists | Documented |
| com.snc.incident.copy.rl.task_ci.attributes | string | ci_item | Affected CI columns | Documented (name), Inferred (default) |
| com.snc.incident.copy.rl.task_cmdb_ci_services.attributes | string | cmdb_ci_service,manually_added | Impacted Service columns | Documented (name), Inferred (default) |
| com.snc.incident.ci_assignment_group.field_name | string | support_group | CI column for group population | Documented (name), Inferred (default) |
| com.snc.incident.service_offering_assignment_group.field_name | string | support_group | offering column | Documented (name), Inferred (default) |
| com.snc.incident.communicate_prb_workaround_to_inc_worknotes | boolean | false | shared problem fix lands in work notes instead of comments | Documented (name), Inferred (default) |
| com.snc.incident.create_from_interaction.save | boolean | true | incident from interaction is saved immediately | Documented |
| com.snc.incident.create_from_interaction.copy_attachments | boolean | true | copy interaction attachments | Documented |
| glide.ui.incident_activity.fields | string | configurable | fields shown in the activity formatter | Documented |
| com.snc.problem.create_from_incident.attributes | string | see section 14 | fields copied to a new problem | Documented |
| com.snc.problem.create_from_incident.copy_attachments | boolean | false | copy attachments and KB links to new problem | Documented (name), Inferred (default) |
| glide.knowman.submission.workflow | boolean | false | knowledge from incidents becomes a submission | Documented (name), Inferred (default) |
| sn_major_inc_mgmt.com.snc.incident.mim.major_incident_creation | choice | promote | promote candidate or create a new MI | Documented (name), Inferred (values, default) |
| sn_major_inc_mgmt.major_incident_management_group | string (sys_id) | seeded "Major Incident Management" group | MI group | Documented (name), Inferred (default) |
| sn_major_inc_mgmt.com.snc.major_incident.create.copy.attributes | string | short_description,description,category,subcategory,impact,urgency,cmdb_ci,business_service | fields copied into a new MI | Documented (name), Inferred (default) |
| sn_major_inc_mgmt.com.snc.incident.mim.compose_email_on_iatasks | string | email | task types offering Compose Email in the workbench | Documented (name), Inferred (default) |
| sn_major_inc_mgmt.pir_export_pdf_ui_page | string | empty | custom PIR export page | Documented |
| sn_comm_management.default_email_recipient_field | choice | bcc | where recipients go on communication emails | Documented |
| sn_comm_management.email_client_recipient_items_enabled | boolean | false | recipient lists on communication emails | Documented (name), Inferred (default) |
| sow_email_notification_redirect (+ .incident, sn_major_inc_mgmt.sow_email_notification_redirect.mim) | boolean | false | email links open the workspace | Documented (names), Inferred (defaults) |
| resolvr.incident.assign_moves_to_in_progress | boolean | true | T2 automation | Inferred (ResolvrNow) |
| resolvr.incident.business_schedule | string (sys_id) | empty | schedule for business_stc and strikes | Inferred (ResolvrNow) |
| resolvr.incident.autoclose.business_days | boolean | false | count auto-close delay in business days | Inferred (ResolvrNow) |
| resolvr.incident.autoclose.run_as | string | system | user recorded by the auto-close job | Inferred (ResolvrNow) |

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-management-properties.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/configure-incident-auto-close.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-properties.html.

## 23. KPIs

Computation model **[Documented]**: indicators are computed daily; period scores (month, quarter, year) sum daily counts and average daily percentages; comparisons are period over period. Roles: `sn_sd.success_dashboard_admin`, `sn_sd.success_dashboard_read`, `sn_sd.success_dashboard_details_read` (record-level drill-down). Durations are in hours unless noted; "D" is the scored day.

| KPI | Formula | Basis |
|---|---|---|
| Mean time to resolve (MTTR, success dashboard) | mean over incidents closed on D of (closed_at - opened_at) | Documented |
| Average resolution time (days) | sum(resolved_at - opened_at, resolved on D) / (resolved count x 24) | Documented |
| Average close time (days) | sum(closed_at - opened_at, closed on D) / (closed count x 24); the doc writes "/ 24" for the second factor, read as a typo | Documented (formula), Inferred (typo fix) |
| % first assignment resolution | resolved on D with reassignment_count = 0 / resolved on D x 100 | Documented |
| % resolved without reassigning (legacy) | resolved by the first assigned group / resolved x 100 | Documented |
| First contact resolution (ResolvrNow) | resolved on D where reassignment_count = 0 and resolved_by = opened_by (an agent) / resolved on D x 100; proxy from docs: % resolved same day opened | Inferred (no FCR definition in docs) |
| % resolved same day opened | resolved with date(resolved_at) = date(opened_at) / resolved x 100 | Documented |
| % reopened | incidents whose reopened_time falls in the period / incidents resolved in the period x 100 | Documented (definition), Inferred (exact sets) |
| % breached SLAs | incidents closed on D with any breached task_sla / incidents closed on D x 100 | Documented (definition), Inferred (join) |
| % resolved in time (SLA) | resolved incidents whose resolution SLA did not breach / resolved incidents with a resolution SLA x 100 | Documented |
| Customer satisfaction | mean survey score on D for resolved tickets (survey module, not in v1) | Documented |
| Backlog (number of open incidents) | count of incidents with empty resolved_at at end of D | Documented |
| Backlog growth | new on D - resolved on D | Documented |
| Average age of open incidents (days) | sum(now - opened_at) over open / (open count x 24) | Documented |
| % new critical | new with priority 1 / new x 100 | Documented |
| % open not updated in 5 / 30 days | open with sys_updated_on older than 5 / 30 days / open x 100 | Documented |
| % open reassigned at least once; average reassignment of open | open with reassignment_count > 0 / open x 100; sum(reassignment_count) / open | Documented |
| % closed by self-service | closed with close_code in {Closed/Resolved by Caller, Resolved by caller} / closed x 100 | Documented (legacy code), Inferred (new code) |
| % not solved | closed with close_code in {Not Solved (Not Reproducible), Not Solved (Too Costly), No resolution provided} / closed x 100 | Documented (legacy codes), Inferred (new code) |
| Self-solved % | (self-solved via VA, KB, AI search answer, proactive engagement + automated resolutions) / (total ticket resolutions + those self-solved + password reset self-service) x 100 | Documented |
| Call deflection % | (catalog submissions + VA submissions + self-solved VA + self-solved KB) / (total tickets submitted + self-solved VA + self-solved KB) x 100 | Documented |
| Total ticket resolutions / total tickets submitted | incidents resolved + requested items closed + closed interactions without a ticket / incidents created + requested items created | Documented |
| MI: count, mean time to identify, MTTR | MIs accepted on D; mean Time to Identify (15.5); mean (resolved_at - opened_at) for MIs | Documented |
| MI nearing breach / overdue / unassigned | accepted, active MIs with an SLA at 75 percent or more / breached / empty assigned_to | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/itsm-success-dashboard-indicators/service-quality-ref.html, https://www.servicenow.com/docs/r/it-service-management/itsm-success-dashboard-indicators/performance-overview-ref.html, https://www.servicenow.com/docs/r/it-service-management/itsm-success-dashboard-indicators/itsm-sdb-dasboard-overview.html, https://www.servicenow.com/docs/r/it-service-management/itsm-success-dashboard-indicators/success-roles.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-management-dashboard.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-premium-dashboard.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-overview.html.

## 24. Open questions

1. Numeric values for states other than Closed (7), hold reasons, severity and notify are platform conventions, not stated in the corpus.
2. Priority 3/3: 5 - Planning (platform and problem lookups) versus 4 - Low (incident sample). ResolvrNow uses 5.
3. Auto-close delay: business days (doc text) versus days (property label). ResolvrNow default: calendar days, switchable.
4. MIM column names (proposed_by, promoted_on, lessons_learned, actions_taken) and the default of the promotion-mode property.
5. Fix communication target: comments ("Communicate a fix" page) versus work notes (Madrid sync table). ResolvrNow follows the property in section 22.
6. Complete close code list for Brazil zboot instances (only three of the new codes are named in the corpus).

## 25. Acceptance tests

1. Given an empty database, When an agent inserts the first incident, Then its number is `INC0010001` and the next is `INC0010002`.
2. Given an agent creates an incident with no other values, When it is saved, Then state = 1, incident_state = 1, impact = 3, urgency = 3, priority = 5, severity = 3, category = `inquiry`, caller_id = opened_by = the agent, active = true, reopen_count = 0.
3. Given an incident with impact 3 and urgency 3, When impact is set to 1 and urgency to 2, Then priority becomes 2; When urgency is then set to 3, Then priority becomes 3.
4. Given an incident with impact 2 and urgency 3 (priority 4), When an API call sets priority = 1 without changing impact or urgency, Then the stored priority is still 4.
5. Given an In Progress incident, When an agent sets state = 3 with no hold_reason, Then the update aborts with "On hold reason is required" and the stored state stays 2.
6. Given an In Progress incident, When an agent sets state = 3, hold_reason = 1 and no comment, Then the update aborts; When the same update includes a comment, Then it succeeds and a strike row with attempts = 1 exists.
7. Given an incident On Hold with hold_reason Awaiting Caller, When the caller adds a comment through the portal, Then state = 2, hold_reason is empty, the strike row is gone, and a "Caller responded" notification is queued for assigned_to and the watch list.
8. Given an incident On Hold / Awaiting Vendor, When a different agent adds a comment, Then state stays 3.
9. Given strike.count = 3 and wait_period = 1 and an incident On Hold / Awaiting Caller, When 4 business days pass with no caller update and the strike job runs after each due time, Then 3 reminders were sent and the incident is state 6 with close_code "Resolved - No response from caller".
10. Given strike.count = 0, When an incident goes On Hold / Awaiting Caller, Then no strike row is created and no reminder is sent.
11. Given an In Progress incident, When an agent sets state = 6 without close_code, Then the update aborts and nothing changes.
12. Given an incident opened at 10:00, When it is resolved at 12:00 with close_code "Solution provided" and notes, Then resolved_by = the agent, resolved_at = 12:00, calendar_stc = 7200, active = true, and event incident.resolved is queued with the caller as recipient of template `incident.ess.resolve`.
13. Given a resolved incident, When the caller closes it, Then state = 7, incident_state = 7, closed_by = caller, closed_at set, active = false, calendar_duration set.
14. Given a closed incident, When an agent sets state = 2, Then the update aborts with "Closed or canceled incidents cannot change state".
15. Given a resolved incident, When its caller selects Reopen, Then state = 2, reopen_count = 1, reopened_by = caller, reopened_time set, and resolved_at, resolved_by, close_code, close_notes are empty.
16. Given a resolved incident whose caller is user A, When ESS user B (not caller, not opener) calls Reopen, Then the request is denied and the incident stays resolved.
17. Given glide.ui.autoclose.time = 7 and autoclose.basedon.resolved_at = true, When the auto-close job runs, Then an incident resolved 8 days ago becomes state 7 with closed_by = the run-as user, and one resolved 6 days ago stays state 6.
18. Given autoclose.basedon.resolved_at = false, When the job runs, Then an incident resolved 10 days ago but updated 2 days ago stays state 6.
19. Given an accepted major incident resolved 30 days ago, When the auto-close job runs, Then it stays state 6.
20. Given a parent incident with two active children, When the parent is resolved with close_code "Workaround provided", Then both children are state 6 with the same close_code and close_notes and each child's activity contains the parent's resolution notes.
21. Given a resolved parent with resolved children, When the parent is closed, Then the children remain state 6.
22. Given a parent with an In Progress child, When the parent goes On Hold with reason Awaiting Vendor, Then the child is On Hold with reason Awaiting Vendor; When instead the reason is Awaiting Caller, Then the child stays In Progress.
23. Given a resolved parent and resolved child, When an agent reopens the parent, Then both are state 2 and the child's reopen_count = 1; When the caller (ESS) reopens a parent instead, Then the child stays resolved.
24. Given incidents A and B with B.parent_incident = A, When A.parent_incident is set to B, Then the update aborts with "Parent incident would create a loop"; and A.child_incidents = 1.
25. Given incident_task.closure = true and an incident with one Open and one Closed Complete task, When the incident is closed, Then the open task is state 4 and the other is unchanged; When another incident with an open task is canceled, Then that task is state 7.
26. Given an In Progress incident without a problem, When an agent runs Create Problem, Then a saved problem exists with the incident's short_description, cmdb_ci, impact, urgency, category; problem.first_reported_by_task = the incident; incident.problem_id = the problem; incident state = 3 with hold_reason 3.
27. Given an incident with assignment_group G1, When it changes to G2, Then reassignment_count = 1 and assigned_to is empty; When a new incident has an empty group and a CI whose support_group is G3, Then it is saved with assignment_group G3.
28. Given copy.enable = true, When an agent runs Copy Incident on a closed incident whose problem is inactive, Then the new incident has the configured attributes, no problem_id, no resolution fields, and a work note "Created from a similar incident: INC...".
29. Given an In Progress incident with empty assignment_group, When an agent proposes it with a reason and business impact, Then major_incident_state = proposed, proposed_by and proposed_on are set, and assignment_group = the MIM group property value.
30. Given a proposed candidate assigned to group G1 and user U1, When a major_incident_manager M promotes it (promote mode), Then major_incident_state = accepted, promoted_by = M, assignment_group = the MIM group, assigned_to = M, and notifications go to G1 members and U1; When a user without major_incident_manager tries the same, Then it is denied.
31. Given a proposed candidate, When a manager rejects it with a reason, Then major_incident_state = rejected, state unchanged, the reason is in work notes, and assigned_to is notified; Given an accepted MI, When it is demoted, Then major_incident_state = canceled and state unchanged.
32. Given an active trigger rule (order 100, condition priority = 1, action propose), When an agent saves a new priority-1 incident, Then after async rules run its major_incident_state = proposed and trigger_rule references the rule; When the incident has a parent_incident, Then the rule is not evaluated.
33. Given an accepted MI whose caller is an ESS user, When the caller tries Resolve, Close or Reopen, Then each is denied; When a major_incident_manager closes the resolved MI, Then it succeeds.
34. Given an incident with major_incident_state = proposed, When it is canceled, Then major_incident_state = canceled.
35. Given incident_alert.closure = true and incident_alert_task.closure = true, and an incident with an open plan having one task communicated twice and one never communicated, When the incident is closed, Then the plan is Closed, the first task is Complete and the second is Skipped.
36. Given an ESS user who is caller on incident A and on the watch list of incident B, When they query all incidents, Then only A, B and incidents they opened are returned.
37. Given a closed incident, When an admin updates problem_id, Then it succeeds; When the admin updates short_description, Then it aborts.
38. Given 10 incidents resolved on day D of which 3 had reassignment_count > 0, When the KPI job computes D, Then % first assignment resolution = 70; and given 4 new and 6 resolved on D, Then backlog growth = -2.
39. Given an incident, When an agent runs Create Outage and saves the outage, Then a cmdb_ci_outage row exists and a task_outage row links it to the incident.
