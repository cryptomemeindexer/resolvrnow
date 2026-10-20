# ResolvrNow spec: Problem Management

Area: Problem Management, including problem tasks, known errors and Known Error articles, workarounds, root cause analysis, duplicates, major problems, problem models, and the problem-to-incident synchronization.
Companions: [`incident.md`](incident.md) and [`data/incident-problem.json`](data/incident-problem.json).
Reference release: ServiceNow "Brazil" public documentation. Status: draft v1, 2026-10-21.

## 0. Conventions

Same as `incident.md` section 0: **[Documented]** means stated in the public docs or the SDK table metadata; **[Inferred]** means convention, reconciliation or ResolvrNow decision. Property names without the `resolvr.` prefix are ServiceNow names. "Coordinator" means a user with `problem_coordinator` (or a role containing it).

Main sources (under `https://www.servicenow.com/docs/r/it-service-management/problem-management/`): `exploring-problem-management.html`, `understanding-state-mgmt-transitions.html`, `understanding-state-trans-prob-task.html`, `problem-form.html`, `problem-task-form.html`, `problem-mgmt-properties.html`, `sync-btwn-inci-prob.html`, `quick-start-tests-pm.html`. Marketing page `https://www.servicenow.com/products/problem-management.html` confirms the six states.

## 1. Module layout

| ResolvrNow module | ServiceNow plugin mirrored | Contents | Basis |
|---|---|---|---|
| `problem` | com.snc.problem | problem table on task | Documented |
| `problem.lookups` | com.snc.best_practice.problem.jakarta | impact/urgency/priority lookup, work note on priority change, major problem | Documented |
| `problem.bp` | com.snc.best_practice.problem.madrid | problem roles, workaround/cause/fix fields, KB search and attach, communicate workaround/fix, clear assignee on group change | Documented |
| `problem.states` | com.snc.best_practice.problem.madrid.state_model | guided state model (section 6) and problem tasks (section 7) | Documented |
| `problem.kb` | com.snc.best_practice.problem.madrid.knowledge | Known Error articles and the Known Error knowledge base | Documented |
| `problem.models` | property com.snc.problem_management.models.enabled | data-driven problem and task models | Documented |
| `itsm.roles` | com.snc.itsm.roles.problem_management | sn_problem_read, sn_problem_write | Documented |

ResolvrNow ships the "new instance" variant only: no legacy states (Open, Pending Change, Known Error, Closed/Resolved) except as inactive choices for imports **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-plugins.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/activate-pm-best-practice-madrid.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/act-pm-best-prac-madrid-state-mod.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/act-pm-best-prac-madrid-know-int.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/act-pm-best-prac-jakarta.html.

## 2. Tables

| Table | Extends | Numbering | Purpose | Basis |
|---|---|---|---|---|
| `problem` | `task` | prefix `PRB`, counter 40000, first `PRB0040001` | problems | Documented (SDK) |
| `problem_task` | `task` | prefix `PTASK`, counter 10000 | units of work on a problem | Documented (table), Inferred (numbering) |
| `dl_problem_priority` | data lookup | none | problem impact x urgency -> priority | Documented |
| `kb_template_known_error_article` | `kb_knowledge` | KB numbering | Known Error articles | Documented |
| `prb_model` / `prb_task_model` | none | none | problem and problem task models | Documented |
| `prb_model_state`, `prb_model_transition`, `prb_model_transition_condition` | none | none | model states, transitions, conditions | Documented (concepts), Inferred (table names) |
| `task_ci`, `task_cmdb_ci_service`, `task_outage` | | | shared with incident (Affected CIs, Impacted Services, Outages) | Documented |

`problem` and `problem_task` are domain separated **[Documented]**; ResolvrNow v1 stores but does not enforce domains **[Inferred]**. Auditing is on for `problem` (SDK `audit: true`) **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/installed-with-pm.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/installed-with-madrid-know-int.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-models.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/domain-separation-and-problem-management.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-configure-forms.html.

## 3. Problem fields

| Field | Label | Type | Reference / choices | Default | Notes | Basis |
|---|---|---|---|---|---|---|
| number | Number | string | | next PRB number | RO | Documented |
| first_reported_by_task | Origin task | reference | task (active, not self) | set when created from a task | | Documented (SDK) |
| category / subcategory | Category / Subcategory | choice | `problem.category`, `problem.subcategory` (dependent) | | | Documented (SDK) |
| business_service / service_offering / cmdb_ci | Service / Service Offering / Configuration item | reference | | | CI class hints the problem type | Documented |
| state | State | integer | `problem.state` | 101 | RO on the form; changed only by actions | Documented |
| problem_state | Problem state | integer | `problem.problem_state` | mirrors state | legacy field | Documented (SDK), Inferred (mirror) |
| resolution_code | Resolution code | choice | `problem.resolution_code` | | RO, set by actions | Documented |
| duplicate_of | Duplicate of | reference | problem, not self, not itself a duplicate | | required for Mark Duplicate | Documented |
| impact / urgency / priority | Impact / Urgency / Priority | integer | task choices | 3 / 3 / computed | priority RO (section 13) | Documented |
| assignment_group / assigned_to | Assignment group / Assigned to | reference | assigned_to limited to problem_coordinator, problem_manager, problem_admin | | the assignee is the problem coordinator | Documented |
| short_description | Problem statement | string(160) | | | label override on problem; drives Related Search | Documented (label), Inferred (column) |
| description | Description | string(4000) | | | | Documented |
| work_notes / work_notes_list | Work notes / Work notes list | journal_input / glide_list | | | | Documented |
| workaround | Workaround | html | | | Analysis Information | Documented |
| cause_notes | Cause notes | html | | | root cause analysis result | Documented |
| fix_notes | Fix notes | html | | | Resolution Information | Documented |
| primary_known_error_article | Primary Known Error article | reference | kb_template_known_error_article (active) | | | Documented |
| known_error | Known error | boolean | | false | root cause known, workaround exists, no permanent fix | Documented (SDK hint) |
| workaround_applied | Workaround applied | boolean | | false | | Documented (SDK) |
| workaround_communicated_at / _by | Workaround communicated / by | glide_date_time / reference | | | RO, set by Communicate Workaround | Documented (SDK), Inferred (setter) |
| fix_communicated_at / _by | Fix communicated / by | glide_date_time / reference | | | RO, set by Communicate Fix | Documented (SDK), Inferred (setter) |
| confirmed_at / confirmed_by | Confirmed / Confirmed by | glide_date_time / reference | | | RO, set by Confirm | Documented |
| fix_at / fix_by | Fix / Fix by | glide_date_time / reference | | | RO, set by Fix | Documented |
| resolved_at / resolved_by | Resolved / Resolved by | glide_date_time / reference | | | RO, set when state becomes 106 | Documented |
| closed_at / closed_by | Closed / Closed by | glide_date_time / reference | | | set when state becomes 107 | Documented (SDK), Inferred (setter) |
| close_notes | Resolution notes (risk accepted reason) | string(4000) | | | holds the Accept Risk reason | Inferred |
| reopen_count, reopened_at, reopened_by | Reopen count, Last reopened at, Last reopened by | integer, glide_date_time, reference | | 0 | RO, set by Re-analyze | Documented (SDK) |
| related_incidents | Related Incidents | integer | | 0 | count of incidents with problem_id = this | Documented (SDK), Inferred (maintenance) |
| rfc | Change request | reference | change_request | | first fix change | Documented (SDK) |
| major_problem | Major problem | boolean | | false | shows review field | Documented |
| review_outcome | Major problem review notes | string(4000) | | | lessons learned | Documented |
| prb_model | Model | reference | prb_model | default model | | Documented (SDK) |
| knowledge | Knowledge | boolean | | false | hidden on the default form when `problem.kb` is active; still honored by `knowledge.md` section 12 | Documented |

Form layout (sections **[Documented]**, placement **[Inferred]**): main (number, first_reported_by_task, category, subcategory, business_service, service_offering, cmdb_ci, state, resolution_code, duplicate_of, impact, urgency, priority, assignment_group, assigned_to, short_description, description, Related Search); Notes; Analysis Information (workaround, cause_notes, primary_known_error_article, known_error); Resolution Information (fix_notes, resolved_by, resolved_at, review_outcome when major_problem); Other Information (opened_by, opened_at, confirmed_by, confirmed_at, fix_by, fix_at). Related lists: Incidents, Problem Tasks (shown by default), Change Requests (fix tasks), Affected CIs, Impacted Services/CIs, Outages, Attached Knowledge **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/configure-problem-form-layout.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-sow.html (Service Operations Workspace tabs).

## 4. Problem task fields

| Field | Label | Type | Notes | Basis |
|---|---|---|---|---|
| number | Number | string | RO | Documented |
| problem | Source problem | reference problem | mandatory | Documented (label), Inferred (column) |
| problem_task_type | Type | choice | `rca` (Root Cause Analysis) or `general`; chosen at creation, then RO | Documented (labels), Inferred (values) |
| cmdb_ci, due_date, priority | Configuration item, Due date, Priority | task fields | | Documented |
| state | State | integer | `problem_task.state`, default 151, RO on the form | Documented |
| close_code | Close code | choice | `complete` or `canceled`, RO | Documented (labels), Inferred (values) |
| assignment_group / assigned_to | | reference | assignee is the problem task analyst | Documented |
| short_description, description, work_notes, work_notes_list | | | | Documented |
| cause_code | Cause code | choice | `problem_task.cause_code` | Documented (examples), Inferred (values) |
| workaround | Workaround | html | RCA tasks only | Documented |
| fix_notes | Proposed fix notes | html | RCA tasks only | Documented (label), Inferred (column) |
| close_notes | Close notes | string(4000) | General tasks; also stores the cancel reason | Documented (label), Inferred (cancel use) |
| closed_by / closed_at | Completed by / Completed | task fields | RO | Documented (labels), Inferred (columns) |
| prb_task_model | Model | reference prb_task_model | default per type | Inferred |
| reopen_count | Reopen count | integer | Re-assess from Closed adds 1 | Inferred |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-task-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-problem-task.html.

## 5. Choice lists

| Element | Values | Basis |
|---|---|---|
| problem.state | 101 New, 102 Assess, 103 Root Cause Analysis, 104 Fix in Progress, 106 Resolved, 107 Closed | Documented (labels; 101, 104, 107), Inferred (102, 103, 106) |
| problem.problem_state | same as problem.state; legacy inactive values 1 Open, 2 Known Error, 3 Pending Change, 4 Closed/Resolved | Documented (legacy values), Inferred (mirror) |
| problem.resolution_code | fix_applied Fix Applied, risk_accepted Risk Accepted, duplicate Duplicate, canceled Canceled | Documented (labels), Inferred (values) |
| problem.category | inquiry, software, hardware, network, database (mirrors incident) | Inferred |
| problem_task.state | 151 New, 152 Assess, 154 Work in Progress, 157 Closed; legacy inactive -5 Pending, 1 Open, 2 Work in Progress, 3 Closed Complete, 4 Closed Incomplete, 7 Closed Skipped | Documented (151, 154, 157, legacy), Inferred (152) |
| problem_task.problem_task_type | rca Root Cause Analysis, general General | Documented (labels), Inferred (values) |
| problem_task.close_code | complete Complete, canceled Canceled | Documented (labels), Inferred (values) |
| problem_task.cause_code | environmental_disaster, hardware_issue, people_process_documentation, software_issue, other | Documented (first three labels), Inferred (rest, values) |
| task.impact / urgency / priority | shared with incident | Documented |

Migration mappings from legacy values **[Documented]**: problem 1 to 101, 2 to 107 (risk accepted), 3 to 104, 4 to 107 (fix applied); task -5 and 1 to 151, 2 to 154, 3 to 157 (complete), 4 and 7 to 157 (canceled). ResolvrNow's import tool applies the same mapping **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/map-problem-state.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/map-problem-task-state.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-task-form.html.

## 6. Problem state model

### 6.1 States

| Value | Label | Meaning (paraphrased) | active | Basis |
|---|---|---|---|---|
| 101 | New | logged, not yet assessed | true | Documented |
| 102 | Assess | coordinator checks validity, scope and related incidents | true | Documented |
| 103 | Root Cause Analysis | cause and fix being investigated, possibly through RCA tasks | true | Documented |
| 104 | Fix in Progress | a fix (usually a change) is being applied | true | Documented |
| 106 | Resolved | fix applied, or risk accepted when that property is off; watching for recurrence | true | Documented (meaning), Inferred (active) |
| 107 | Closed | completed, risk accepted, duplicate or canceled (see resolution_code) | false | Documented (meaning), Inferred (active) |

### 6.2 Transitions (non-model lifecycle, equal to the base "General" model)

Rule `problem.state_guard` (before update) aborts any change of `state` that is not produced by an action below, with "Use the problem actions to change state" **[Inferred]** (the State field is read-only in the workspace **[Documented]**).

| # | Action | From | To | resolution_code | Roles | Required input | Side effects | Basis |
|---|---|---|---|---|---|---|---|---|
| P1 | (insert) | | 101, or 102 when the Assess dialog fields are already filled | | creators (section 19) | | defaults; problem_state mirror | Documented |
| P2 | Assess | 101 | 102 | | admin, problem_admin, problem_manager, problem_coordinator | Assess dialog fields: assignment_group, assigned_to, plus fields added to form view "Assess Dialog Form View" | | Documented (dialog), Inferred (default fields) |
| P3 | Confirm | 102 | 103 | | same | | confirmed_by, confirmed_at | Documented |
| P4 | Mark Duplicate | 102, 103 | 107 | duplicate | same | duplicate_of | related records moved (section 12); open tasks canceled (property) | Documented |
| P5 | Cancel | 101, 102, 103 | 107 | canceled | same | reason (work note) | open tasks canceled (property) | Documented (102, 103), Inferred (101, reason) |
| P6 | Fix | 103 | 104 | | problem_admin, problem_coordinator, problem_manager, admin | cause_notes, fix_notes | fix_by, fix_at | Documented (action, fields), Inferred (required input) |
| P7 | Accept Risk | 103, 104 | 107 if `problem.acceptrisk.move_to_closed` = true (default), else 106 | risk_accepted | same | cause_notes, close_notes (reason) | incident sync (section 10) | Documented |
| P8 | Re-analyze | 104 | 103 | cleared | same | | | Documented (action), Inferred (from 104) |
| P9 | Resolve | 104 | 106 | fix_applied | admin, problem_admin, problem_coordinator, problem_manager | fix_notes | resolved_by, resolved_at; incident sync | Documented |
| P10 | Complete | 106 | 107 | kept (fix_applied or risk_accepted) | same | | closed_by, closed_at, active false; open tasks canceled (property); incident sync for any incident still waiting | Documented (fix applied), Inferred (risk accepted) |
| P11 | Re-analyze | 106, 107 | 103 | cleared | role named by the matching property: completed (fix_applied), risk accepted, or canceled; default problem_manager | | reopen_count + 1, reopened_by, reopened_at; resolved_* and closed_* cleared; active true | Documented (properties, target state), Inferred (clearing) |
| P12 | Re-analyze a duplicate | 107 (duplicate) | | | nobody | | aborts "Duplicate problems cannot be re-analyzed" | Inferred |

Data rules: when state is 107 the record is read-only except work notes and Re-analyze **[Inferred]**. problem_state is copied from state on every write **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/assess-a-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/investigate-root-cause.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/resolve-and-complete-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/quick-start-tests-pm.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/exploring-problem-management.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-sow.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/add-field-in-assess-dialog-form.html.

## 7. Problem tasks

### 7.1 Lifecycle

| # | Action | From | To | close_code | Roles | Required input | Basis |
|---|---|---|---|---|---|---|---|
| K1 | (insert) | | 151, or 152 when the "PTASK Assess Dialog View" fields are filled | | itil, sn_problem_write, admin, problem_admin, problem_coordinator, problem_manager, problem_task_analyst | problem, problem_task_type | Documented |
| K2 | Assess | 151 | 152 | | problem_admin, problem_coordinator, problem_manager, problem_task_analyst, admin | assignment_group, assigned_to | Documented (action), Inferred (fields) |
| K3 | Start Work | 152 | 154 | | same | | Documented |
| K4 | Re-assess | 154 | 152 | | same | | Documented |
| K5 | Cancel | 151, 152, 154 | 157 | canceled | same | cancel reason (close_notes) | Documented (152), Inferred (151, 154) |
| K6 | Complete | 154 | 157 | complete | same | RCA: cause_code and fix_notes; General: close_notes | Documented (action), Inferred (inputs) |
| K7 | Re-assess (reopen) | 157 | 152 | cleared | role in `problem_task.closed.role.reaassess_from_closed` (default problem_coordinator); if the parent problem is 107, only when `problem_task.closed.can_reassess_on_closed_problem` = true | | Documented |

Closed tasks are read-only **[Inferred]**. Completing an RCA task does not copy anything to the problem; the coordinator copies cause and fix notes by hand **[Documented]**.

### 7.2 Problem and task interplay

| Rule | Behavior | Basis |
|---|---|---|
| Create on closed problem | inserting a task whose problem is 107 aborts unless `problem.closed.can_create_tasks` = true | Documented |
| Cascade on close | when the problem moves to 107 (any code), open tasks become 157 canceled if `problem.closed.cancel_open_tasks` = true (default) | Documented |
| All tasks done | when the last open task of a problem reaches 157, notify the coordinator | Documented |
| Task models | "New" offers the active task models allowed to the user's roles (interceptor); type follows the model | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/understanding-state-trans-prob-task.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-problem-task.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/assess-a-problem-task.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/complete-a-problem-task.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-properties.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-problem-task-model.html.

## 8. Linking incidents and other records

- Incidents link through `incident.problem_id`. Creating a problem from an incident links it and puts the incident On Hold / Awaiting Problem (incident.md section 14) **[Documented]**.
- "Add" on the Incidents related list attaches many incidents at once (multi-record associator); a scripted extension point `global.MRABulkAddRecordsFilter` filters candidates (older `global.BulkAddIncidentsFilter` still honored) **[Documented]**. ResolvrNow exposes an equivalent hook name `problem.bulk_add_filter` **[Inferred]**.
- Relating a closed incident is allowed only to the roles in `problem.role.relate_closed_incidents` (new instances: problem coordinators; upgrades: nobody) **[Documented]**.
- `problem.related_incidents_count` (after insert/update/delete on incident) keeps related_incidents current **[Inferred]**.
- "Add" on Change Requests links existing changes as fix records (change.parent = problem) **[Documented]** (action), **[Inferred]** (column).
- Affected CIs and Impacted Services/CIs work as on incidents **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/add-multiple-incidents-to-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/extension-point-for-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/add-multi-change-req-to-prob.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/add-multiple-cis-to-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-properties.html.

## 9. Workaround and fix communication

| Action | Visible when | Roles | Effect on each related incident not in state 6, 7, 8 | Basis |
|---|---|---|---|---|
| Communicate Workaround | workaround not empty and problem active | admin, problem_admin, problem_manager, problem_coordinator | work note with the workaround and a link to the problem, notifying assigned_to and the work notes list; plus a customer-visible comment with the workaround, notifying caller, assigned_to and watch list when the incident's close_code is "Known error" | Documented |
| Communicate Fix | fix_notes not empty | same | fix notes copied to the incident's comments (customer visible), notifying caller and assigned_to; when `com.snc.incident.communicate_prb_workaround_to_inc_worknotes` = true, copied to work notes instead, notifying assigned_to and the work notes list | Documented (both variants), Inferred (property as switch) |

Both actions stamp workaround_communicated_at/_by or fix_communicated_at/_by on the problem **[Inferred]**, and the same property also suppresses the comment copy of Communicate Workaround when true **[Inferred]**. Linking a Known Error article to the problem adds a work note with links to the problem and the article on every related incident **[Documented]**. System-written journal entries from these actions do not also trigger the generic incident.commented notification (no duplicate mail) **[Inferred]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/communicate-workaround.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/communicate-a-fix.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/sync-btwn-inci-prob.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/working-incident-record-form.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/incident-management-properties.html.

## 10. Problem to incident synchronization

Script action "Update Incident when Problem closes" (ResolvrNow: rule `problem.sync_incidents`, after update when state changes to 106 or 107) **[Documented]** name, **[Inferred]** trigger detail:

| Problem outcome | Incidents affected | Incident result | Notification | Basis |
|---|---|---|---|---|
| 106 or 107 with fix_applied | problem_id = problem, state 3, hold_reason 3 (Awaiting Problem) | state 6, close_code "Resolved by problem", close_notes naming the problem and pointing to the comments, fix notes added as a comment | caller and assigned_to | Documented |
| 106 or 107 with risk_accepted | same filter | state unchanged; risk accepted reason added as work note | assigned_to | Documented |
| 107 duplicate | per `problem.duplicate.records_to_move` | problem_id repointed to the surviving problem | none | Documented |
| 107 canceled | none | unchanged | none | Inferred |

The rule is idempotent: only incidents still On Hold / Awaiting Problem are touched, so firing at 106 and again at 107 changes nothing the second time **[Inferred]**. The legacy "Resolve Incidents" UI action and the legacy rules "SNC - ITIL - Resolve Related Incidents" and "SNC-ITIL-Close-related" (London and earlier) are not implemented **[Documented]** (legacy scope).

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/sync-btwn-inci-prob.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/t_CloseRelatedIncFromAPRB.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/c_ProblemManagementProcess.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inc-mgmt-best-prac-plugin-sd.html.

## 11. Known errors and Known Error articles

- `known_error` marks problems whose cause is known and which have a workaround but no permanent fix **[Documented]** (SDK hint). Module "Known Errors" lists problems with known_error = true **[Documented]** (module), **[Inferred]** (filter). ResolvrNow sets known_error = true when a Known Error article is created and leaves it user-editable **[Inferred]**.
- "Create Known Error Article" (related link) is shown when primary_known_error_article is empty; roles admin, problem_admin, problem_coordinator, problem_manager **[Documented]**. It creates a draft `kb_template_known_error_article` (table and columns owned by `knowledge.md` section 8) in the "Known Error" knowledge base: short_description from the problem statement, `kb_description` from description, `kb_workaround` from workaround, `kb_cause` from cause_notes, category from the problem (RO), source task = the problem; then it sets primary_known_error_article and links the article through `m2m_kb_task` **[Documented]** (article fields, KB, category, source), **[Inferred]** (column mapping, back-link).
- Article form extras: "Search for Duplicates" (by short description, category, topic), "Attachment link" (article shown as attachment on the problem instead of its text in a work note), "Display attachments", Valid to; "View Article" related link once it exists **[Documented]**.
- Publishing goes through the knowledge base workflow; depending on KB access, the article can be searchable by end users for incident deflection **[Documented]**.
- On incidents, choosing close_code "Known error" requires an attached Known Error article, and attaching a KE article whose source is a problem links the incident to that problem **[Documented]** (incident.md section 14).
- The Knowledge checkbox path (rule "Problem Create Knowledge": draft article from short description and work notes when the problem closes) is implemented by the knowledge module, `knowledge.md` section 12. The legacy "Post Knowledge" and "Post News" related links are not implemented in v1 **[Documented]** (legacy scope).

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/create-known-error-from-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/known-error-article-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/c_GatherProblemData.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/c_CreateKnowledge.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/t_PostKnowledge.html.

## 12. Root cause analysis, duplicates, major problems, changes

| Topic | Behavior | Basis |
|---|---|---|
| RCA by coordinator | coordinator records cause_notes and fix_notes on the problem | Documented |
| RCA by expert | coordinator creates a problem task of type Root Cause Analysis; the analyst fills cause_code, workaround, proposed fix notes | Documented |
| Duplicate | Mark Duplicate requires duplicate_of (not self, not a problem that is itself a duplicate); records listed in `problem.duplicate.records_to_move` (default incident.problem_id, sn_customerservice_case.problem, problem_task.problem) move to the surviving problem; missing tables are skipped | Documented (property), Inferred (skip) |
| Major problem | checking major_problem makes the next save require a work note and shows review_outcome ("Major problem review notes") in Resolution Information | Documented |
| Create change | "Create Normal Change" / "Create Emergency Change" (problem_coordinator, admin) create a saved change_request with parent = problem, copying short_description, description, cmdb_ci, priority, company; problem.rfc set if empty | Documented (actions), Inferred (copy, rfc) |
| Fix records complete | when every record found through `problem.fix.records` (default change_request.parent, rm_defect.parent, rm_release.parent, rm_enhancement.parent, sn_cim_register.source_id) is completed or canceled, notify the coordinator; each table needs its own watcher rule, for changes "Check Related Problem Fixes - Change Req" | Documented |
| Optional shortcuts | Create defect, Create enhancement, Create improvement initiative (only when those modules exist) | Documented |
| Outage | "Create Outage" works on problems (incident.md section 17) | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/investigate-root-cause.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/assess-a-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/categorize-major-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/fix-a-change.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/resolve-and-complete-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-sow.html, https://www.servicenow.com/docs/r/it-service-management/task-outage/t_AddTheUIActionToAnotherTaskForm.html.

## 13. Priority

Priority comes from `dl_problem_priority` with the same matrix as incidents (1/1 = 1 Critical ... 3/3 = 5 Planning), recalculated on every insert and update; the field is read-only **[Documented]**. Once a problem is saved, changing impact or urgency (and therefore priority) requires a work note on that update ("Work notes are required when the priority changes") **[Documented]** (rule), **[Inferred]** (message).

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/prioritise-problems.html.

## 14. Assignment

- "Populate Assignment Group based on CI/SO" also runs on problem when group and assignee are empty, using `com.snc.problem.ci_assignment_group.field_name` and `com.snc.problem.service_offering_assignment_group.field_name` **[Documented]**.
- Assignment rules exist for problems (examples: Network Problem by CI class, Database Problem by CI class Database) **[Documented]**; ResolvrNow seeds both inactive-safe (active only if the groups exist) **[Inferred]**.
- Changing assignment_group clears assigned_to **[Documented]**; reassignment_count works as on incident **[Inferred]**.
- assigned_to must hold problem_coordinator, problem_manager or problem_admin (state model active); for problem tasks problem_task_analyst is also allowed **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/t_DefineAnAssignRuleForPRBs.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/map-problem-state.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/map-problem-task-state.html.

## 15. Problem models

| Aspect | Specification | Basis |
|---|---|---|
| Switch | `com.snc.problem_management.models.enabled` (true for new instances); records created before enabling keep the non-model lifecycle | Documented |
| Default models | problem: General; task: Root cause analysis, General; each equals the non-model lifecycle | Documented |
| Model record | name, default model flag, active, description, advanced security (read roles, write roles, user criteria available / not available / can write) | Documented |
| Task model record | as above plus problem_task_type (custom models default to type Model) | Documented |
| States | model state rows: state value, initial state flag (first row is initial) | Documented |
| Transitions | from, to, automatic flag (automatic transitions fire when conditions hold and block manual selection) | Documented |
| Conditions | name, transition, description, requires (predefined condition, condition builder, or script), active; editing scripts needs `problem_model_script_admin` (not inherited by any role) | Documented |
| Engine | ResolvrNow evaluates the record's model: a state change is legal only if a transition from the current state exists and all its active conditions pass; after every update, automatic transitions out of the new state are tried once (chain limit 5) | Inferred |
| Default selection | prb_model defaults to the active model flagged default (SDK default script) | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-models.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/enable-problem-mgmt-models.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-problem-model.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-problem-task-model.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-model-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-task-model-form.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-model-state-transition-condition.html.

## 16. Business rules (ResolvrNow catalog)

Quoted names come from the docs **[Documented]**; others are ResolvrNow names **[Inferred]**.

| Rule | Table / when / order | Behavior |
|---|---|---|
| problem.defaults | problem / B insert / 10 | state 101, impact/urgency 3, prb_model default, first_reported_by_task when created from a task |
| problem.auto_assess | problem / B insert / 20 | P1: go to 102 when the Assess dialog fields are filled |
| problem.priority_lookup | problem / B insert, update / 60 | section 13 |
| problem.priority_worknote | problem / B update / 70 | section 13 |
| problem.state_guard | problem / B update / 100 | section 6.2 or model engine (section 15) |
| problem.action_stamps | problem / B update / 110 | confirmed_*, fix_*, resolved_*, closed_*, reopened_* and reopen_count per action |
| problem.state_mirror | problem / B insert, update / 120 | problem_state = state |
| problem.major_problem_worknote | problem / B update / 130 | work note required when major_problem changes to true |
| "Populate Assignment Group based on CI/SO" | problem / B insert, update / 900 | section 14 |
| problem.cancel_open_tasks | problem / A update / 200 | section 7.2 |
| problem.move_duplicate_records | problem / A update / 210 | section 12 |
| "Update Incident when Problem closes" | problem / A update / 220 (script action on event) | section 10 |
| problem.events | problem / A insert, update / 100 | section 18 |
| problem_task.defaults, problem_task.auto_assess, problem_task.state_guard | problem_task / B insert, update | sections 7.1 and 7.2 |
| problem_task.all_closed_notify | problem_task / A update | section 7.2 |
| "Check Related Problem Fixes - Change Req" | change_request / A update | section 12 |
| problem.related_incidents_count | incident / A insert, update, delete | section 8 |
| problem.query | problem, problem_task / Q | users without a problem-reading role see nothing |

## 17. UI actions

| Action | Placement | Visible when | Roles | Basis |
|---|---|---|---|---|
| Assess | form button | state 101 | admin, problem_admin, problem_manager, problem_coordinator | Documented |
| Confirm | form button | state 102 | same | Documented |
| Mark Duplicate | form button | state 102 or 103 | same | Documented |
| Cancel | form button | state 101 to 103 | same | Documented |
| Fix | form button | state 103 | same | Documented |
| Accept Risk | form button | state 103 or 104 | same | Documented |
| Re-analyze | form button | state 104; or 106/107 (not duplicate) and the user holds the role named by the matching property | per property | Documented |
| Resolve | form button | state 104 | same as Fix | Documented |
| Complete | form button | state 106 | same | Documented |
| Communicate Workaround / Communicate Fix | related links | section 9 | admin, problem_admin, problem_manager, problem_coordinator | Documented |
| Create Known Error Article / View Article | related links | primary_known_error_article empty / set | same | Documented |
| Create Normal Change / Create Emergency Change | form context menu | state 103 or 104 | problem_coordinator, admin | Documented (actions), Inferred (states) |
| Add (Incidents, Change Requests) | related list | problem active (closed incidents per property) | itil, admin, problem_admin, problem_coordinator, problem_manager | Documented |
| New (Problem Tasks) | related list | problem active, or closed with `problem.closed.can_create_tasks` | itil, sn_problem_write, problem roles, problem_task_analyst | Documented |
| Create Outage | form context menu | always | itil, admin | Documented |
| Problem task: Assess, Start Work, Re-assess, Cancel, Complete | form buttons | section 7.1 | problem_admin, problem_coordinator, problem_manager, problem_task_analyst, admin | Documented |

Navigation modules: Problem > Create New, Open, Known Errors, All; Problem > Administration > Problem Properties, Problem Models (`prb_model.list`), Problem Task Models (`prb_task_model.list`) **[Documented]**.

## 18. Events and notifications

Event names follow ServiceNow style and are **[Inferred]**: problem.inserted, problem.updated, problem.assigned, problem.assigned.to.group, problem.worknoted, problem.state.changed (parm1 = new state, parm2 = action), problem.workaround.communicated, problem.fix.communicated, problem.fix_records.completed, problem_task.assigned, problem_task.all_closed.

| Notification | Trigger | Recipients | Basis |
|---|---|---|---|
| Problem assigned to me / to my group | problem.assigned / problem.assigned.to.group | assigned_to / group members | Inferred |
| Problem updated | problem.state.changed | assigned_to, work notes list | Documented (updates trigger mail), Inferred (audience) |
| All fix records completed | problem.fix_records.completed | coordinator (assigned_to) | Documented |
| All problem tasks completed | problem_task.all_closed | coordinator | Documented |
| Problem task assigned to me | problem_task.assigned | task assignee | Inferred |
| Incident workaround / fix / resolved by problem / risk accepted | sections 9 and 10 | as listed there | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/c_ProblemManagementProcess.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/resolve-and-complete-problem.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/complete-a-problem-task.html.

## 19. Roles and access control

| Role | Contains | Purpose | Basis |
|---|---|---|---|
| problem_task_analyst | | works problem tasks | Documented |
| problem_coordinator | problem_task_analyst, itil | owns problems and tasks through their lifecycle | Documented |
| problem_manager | problem_coordinator | owns the process, configures settings, default re-analyze role | Documented |
| problem_admin | problem_manager | can also delete problems and problem tasks | Documented |
| sn_problem_read | | read problems and related records | Documented |
| sn_problem_write | sn_problem_read, template_editor | create and edit problems and tasks (lifecycle actions still need coordinator roles) | Documented (roles), Inferred (action split) |
| sn_service_desk_agent | sn_problem_write and other ITSM write roles | tier-1 | Documented |
| business_stakeholder | sn_problem_read and other read roles | read and approve | Documented |
| problem_model_script_admin | | edit model condition scripts | Documented |

| Operation | Allowed | Basis |
|---|---|---|
| read problem / problem_task | itil, sn_problem_read, problem roles, admin; ESS users none | Documented ("only Problem users"), Inferred (ESS) |
| create | itil, sn_problem_write, admin, problem_admin, problem_manager, problem_coordinator (tasks: also problem_task_analyst) | Documented |
| write | as create, plus the task assignee (problem_task_analyst) on own tasks | Inferred |
| delete | problem_admin, admin | Documented |
| unauthenticated | denied | Inferred |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/installed-with-madrid-best-prac.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/prob-roles-instld-itsm-roles.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-a-problem-v2.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/domain-separation-and-problem-management.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-model-state-transition-condition.html.

## 20. Properties

| Property | Type | Default | Purpose | Basis |
|---|---|---|---|---|
| problem.acceptrisk.move_to_closed | boolean | true | Accept Risk goes to Closed instead of Resolved | Documented |
| problem.closed.can_create_tasks | boolean | false | allow tasks on closed problems | Documented |
| problem.closed.role.reanalyze_from_canceled | choice (role) | problem_manager | who can re-analyze canceled problems | Documented |
| problem.closed.role.reanalyze_from_closed_riskaccepted | choice (role) | problem_manager | who can re-analyze risk-accepted problems | Documented |
| problem.closed.role.reanalyze_from_completed | choice (role) | problem_manager | who can re-analyze fix-applied problems | Documented |
| problem.closed.cancel_open_tasks | boolean | true | cancel open tasks when the problem closes | Documented |
| problem_task.closed.role.reaassess_from_closed | choice (role) | problem_coordinator | who can re-assess closed tasks (name spelled as documented) | Documented |
| problem_task.closed.can_reassess_on_closed_problem | boolean | false (new) / true (upgrade) | re-assess tasks of closed problems | Documented |
| problem.fix.records | string | change_request.parent, rm_defect.parent, rm_release.parent, rm_enhancement.parent, sn_cim_register.source_id | fix records to watch | Documented |
| problem.duplicate.records_to_move | string | incident.problem_id, sn_customerservice_case.problem, problem_task.problem | records moved by Mark Duplicate | Documented |
| problem.role.relate_closed_incidents | choice | problem_coordinator (new) / nobody (upgrade) | who may relate closed incidents | Documented |
| com.snc.problem.create_from_incident.attributes | string | number, description, short_description, cmdb_ci, impact, urgency, priority, company, sys_domain, business_service, category, subcategory | copy list | Documented |
| com.snc.problem.create_from_incident.copy_attachments | boolean | false | copy attachments and KB links from the incident | Documented (name), Inferred (default) |
| com.snc.problem.create_from_interaction.save | boolean | true (new) | save problem created from interaction | Documented |
| glide.problem.interaction.allow_create | boolean | false | allow problem creation from interaction | Documented |
| com.snc.problem_management.models.enabled | boolean | true | problem models | Documented |
| com.snc.problem.ci_assignment_group.field_name / service_offering_assignment_group.field_name | string | support_group | group population columns | Documented (names), Inferred (default) |
| com.snc.incident.communicate_prb_workaround_to_inc_worknotes | boolean | false | section 9 switch (incident property) | Documented (name), Inferred (default) |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-mgmt-properties.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-a-problem-v2.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/enable-problem-mgmt-models.html.

## 21. KPIs

Same daily computation and period aggregation as incident.md section 23 **[Documented]**.

| KPI | Formula | Basis |
|---|---|---|
| Number of open problems | problems created on or before D with empty closed_at | Documented |
| Number of new / closed problems | created on D / closed on D | Documented |
| Problem backlog growth | new - closed | Documented |
| Average age of open problems (days) | sum(age in hours of open) / open / 24 | Documented |
| Average close time (days) | sum(closed_at - opened_at in hours, closed on D) / closed / 24 | Documented |
| % new critical problems | new with priority 1 / new x 100 | Documented |
| % open classified as known error | open with known_error = true / open x 100 | Documented |
| % open with at least one incident | open with related_incidents > 0 / open x 100 | Documented |
| % closed on first assignment | closed with reassignment_count = 0 / closed x 100 | Documented |
| % reassigned at least once; average reassignment of open | open with reassignment_count > 0 / open x 100; sum(reassignment_count) / open | Documented |
| % closed without close notes | closed with empty close_notes / closed x 100 (ResolvrNow also accepts fix_notes as "notes") | Documented, Inferred (fix_notes) |
| Open problems not updated in 30 / 90 days | open with sys_updated_on older than 30 / 90 days | Documented |
| Average age since last update (days) | sum(hours since sys_updated_on, open) / open / 24 | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-management-dashboard.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-premium-dashboard.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/problem-overview-dashboard.html.

## 22. Open questions

1. Numeric values 102, 103, 106 and 152 are platform conventions; the corpus names them but shows numbers only for 101, 104, 107, 151, 154, 157.
2. Resolution code and close code values (fix_applied, complete) and problem_task_type values are inferred.
3. Whether problem_state mirrors the new states or keeps legacy semantics on Brazil instances.
4. Exact Assess dialog fields and required inputs for Fix, Accept Risk and Complete.
5. Communicate Fix target (comments versus work notes) when the property is false; ResolvrNow follows the "Communicate a fix" page.
6. Column names for the problem task cancel reason and proposed fix notes.

## 23. Acceptance tests

1. Given an empty database, When the first problem is inserted, Then its number is `PRB0040001`, state = 101, problem_state = 101, priority = 5, and prb_model = the default "General" model.
2. Given a coordinator creates a problem with assignment_group and assigned_to filled, When it is saved, Then state = 102.
3. Given a problem in 101 without assigned_to, When Assess is invoked, Then it aborts asking for the Assess dialog fields; When assigned_to and assignment_group are provided, Then state = 102.
4. Given a problem in 102, When a coordinator runs Confirm, Then state = 103 and confirmed_by / confirmed_at are set.
5. Given a problem in 102 or 103, When a coordinator runs Cancel, Then state = 107, resolution_code = canceled, active = false.
6. Given problem B in 103 with two linked incidents and one problem task, and problem A active, When B is marked duplicate of A, Then B is 107 with resolution_code duplicate and duplicate_of = A, both incidents have problem_id = A, and the task's problem = A.
7. Given problem A, When a user marks A as duplicate of A, or of a problem that is itself a duplicate, Then the update aborts.
8. Given a problem in 103 with cause_notes and fix_notes, When Fix runs, Then state = 104 and fix_by / fix_at are set; Given empty fix_notes, Then Fix aborts.
9. Given move_to_closed = true and a problem in 103, When Accept Risk runs with a reason, Then state = 107 and resolution_code = risk_accepted; Given move_to_closed = false and a problem in 104, Then state = 106 with risk_accepted.
10. Given a problem in 104, When Resolve runs, Then state = 106, resolution_code = fix_applied, resolved_by / resolved_at are set; When Complete runs, Then state = 107 with fix_applied and closed_at set.
11. Given a closed fix-applied problem and default properties, When a problem_manager runs Re-analyze, Then state = 103, reopen_count = 1, reopened_by / reopened_at set, resolution_code empty; When a problem_coordinator who is not a manager tries, Then it is denied.
12. Given reanalyze_from_canceled = problem_coordinator and a canceled problem, When a coordinator runs Re-analyze, Then state = 103.
13. Given any problem state, When an API call sets state directly (for example 101 to 104), Then the update aborts and state is unchanged.
14. Given cancel_open_tasks = true and a problem with tasks in 151 and 154, When the problem is completed, Then both tasks are 157 with close_code canceled.
15. Given can_create_tasks = false and a closed problem, When a task is inserted for it, Then the insert aborts; with the property true, Then it succeeds.
16. Given a new RCA task with assignment fields filled, When saved, Then state = 152; When Start Work runs, Then 154; When Re-assess runs, Then 152 again.
17. Given a task in 152, When Cancel runs without a reason, Then it aborts; with a reason, Then state = 157, close_code = canceled, close_notes = the reason.
18. Given an RCA task in 154 with cause_code and fix_notes, When Complete runs, Then state = 157 and close_code = complete; Given it was the problem's last open task, Then a notification to the coordinator is queued.
19. Given a closed task on an active problem, When a problem_coordinator runs Re-assess, Then state = 152; Given the parent problem is closed and can_reassess_on_closed_problem = false, Then Re-assess is denied.
20. Given a problem with a workaround and three linked incidents (In Progress, On Hold, Resolved), When Communicate Workaround runs, Then the two active incidents each get a work note and a comment containing the workaround, the resolved one is unchanged, and workaround_communicated_at / _by are set.
21. Given property communicate_prb_workaround_to_inc_worknotes = false, When Communicate Fix runs, Then active related incidents get the fix notes as a comment and caller plus assigned_to are notified; with the property true, Then they get a work note and no comment.
22. Given an incident On Hold / Awaiting Problem and another In Progress, both linked, When the problem is resolved with fix_applied, Then the first becomes state 6 with close_code "Resolved by problem" and a comment holding the fix notes, the second is unchanged, and caller plus assignee of the first are notified; When the problem is later completed, Then no incident changes again.
23. Given an incident On Hold / Awaiting Problem, When the linked problem is risk accepted with reason R, Then the incident stays On Hold and has a work note containing R, and its assigned_to is notified.
24. Given a problem with a workaround and empty primary_known_error_article, When Create Known Error Article runs, Then a draft kb_template_known_error_article exists in the Known Error base with the workaround, cause and category, primary_known_error_article points to it, known_error = true, and the related link is no longer shown.
25. Given a saved problem with impact 3, urgency 3, When impact changes to 1 without a work note, Then the update aborts; with a work note, Then priority = 3.
26. Given a problem, When major_problem is set to true without a work note, Then the update aborts; with a work note, Then review_outcome becomes visible on the form.
27. Given a problem in 103, When a coordinator runs Create Normal Change, Then a saved change_request exists with parent = the problem and problem.rfc = that change; When that change (its only fix record) is closed, Then the coordinator is notified.
28. Given relate_closed_incidents = nobody, When an itil user adds a closed incident to a problem, Then it is denied; an open incident can be added and related_incidents increases by 1.
29. Given models are enabled and a custom model with states 101, 102, 107 and transitions 101 to 102 and 102 to 107 (automatic, condition assigned_to not empty), When the problem is assessed with an assignee, Then it moves to 107 automatically; When a user requests 101 to 107 directly, Then it aborts.
30. Given a user with only sn_problem_read, When they open a problem, Then they can read it but every update and every lifecycle action is denied; Given an ESS user, Then the problem list query returns no rows.
31. Given assigned_to is set to a user without problem_coordinator, problem_manager or problem_admin, When the problem is saved, Then the update aborts.
