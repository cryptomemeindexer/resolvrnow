# ResolvrNow approvals and flows specification

Scope: the approval data model and lifecycle (individual and group approvals, approval rules, roll-up to `task.approval`, delegation, approval by email), the classic approval engine, Workflow Studio concepts, and the minimal flow engine ResolvrNow implements with its JSON definition format.

Conventions: **[Documented]** = stated in the ServiceNow Brazil docs corpus (URL cited per section, restated in our own words); **[Inferred]** = derived from the SDK data model, known platform behavior or a ResolvrNow decision. Cross references: `platform-core.md` (save pipeline §4.2, ACLs §2, journal §7), `notifications-events.md` (events §1, notifications §2, inbound email §4), `data/platform.json`.

---

## 1. Approval data model

Sources: https://www.servicenow.com/docs/r/build-workflows/approvals/r_Approvals.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_ApprovalStatus.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_MultipleApprovers.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_GeneApprovalsUsingWorkflows.html · https://www.servicenow.com/docs/r/platform-administration/c_LinkToRelatedRecords.html · https://www.servicenow.com/docs/r/platform-administration/c_ActivityFormatter.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/r_ImportantTaskTableFields.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/user.html

### 1.1 `sysapproval_approver` (Approval)

| Field | Type | Meaning | Basis |
|---|---|---|---|
| `approver` | reference sys_user | Person who must decide | Documented |
| `state` | string choice | 1.2 | Documented (subset) |
| `sysapproval` | reference task ("Approval for") | Task being approved; used by `${sysapproval.URI_REF}` | Documented |
| `document_id` | document_id ("Approving"), dependent on `source_table` | Record being approved on any table (approvals work for non-task tables too) | Documented |
| `source_table` | table_name | Table of `document_id` | Inferred |
| `comments` | journal_input | Approver comments | Documented |
| `group` | reference sysapproval_group | Group approval this row belongs to | Inferred |
| `order` | integer | Sequencing among approvals of a record | Inferred |
| `due_date`, `expected_start` | glide_date_time | Deadline / planned start | Inferred |
| `approval_column` | string, default `approval` | Field on the approved record that receives the roll-up | Inferred |
| `approval_journal_column` | string, default `approval_history` | Journal on the approved record that receives decisions | Inferred |
| `approval_source` | string | `ui`, `email`, `api`, `flow`, `rule` | Inferred |
| `iteration` | integer | Re-approval counter (incremented when a record is re-submitted) | Inferred |
| `flow_context` | reference sys_flow_context ("Flow") | Set when a flow's approval action created the row; not for business logic | Documented (a Flow field is populated), Inferred (column name) |
| `wf_activity` | reference | Classic workflow activity (always empty in ResolvrNow) | Inferred |

The table is audited and shows the activity formatter [Documented]. A summarizer formatter on the approval form shows the approved record's key fields [Documented].

### 1.2 Approval states

| Value | Label | Meaning | Basis |
|---|---|---|---|
| `not requested` | Not Yet Requested | Created but not asked; no notification is sent while in this state | Documented |
| `requested` | Requested | Waiting for the approver; notification sent on entry | Documented |
| `approved` | Approved | Approver accepted | Documented |
| `rejected` | Rejected | Approver refused | Documented |
| `cancelled` | Cancelled | Withdrawn because the record or process was cancelled | Inferred |
| `not_required` | No Longer Required | Outcome reached without this response | Inferred |
| `duplicate` | Duplicate | Same approver already asked for the same record and iteration | Inferred |

`task.approval` uses the same value set [Inferred; default `not requested` from SDK].

### 1.3 `sysapproval_group` (Group approval) [Inferred]

Extends `task`; one row per approving group: `parent` (record being approved), `assignment_group` (approving group), `approval` (group-level state, same values), `short_description`, `approval_set`, `due_date`, plus two **ResolvrNow extension** columns `resolvr_wait_for` (`first_response` default, `any`, `all`, `percentage`) and `resolvr_percentage` (integer). Member approvals (`sysapproval_approver.group = <row>`) are created for each active member of the group when the group approval becomes `requested`.

### 1.4 Approval fields on `task` (SDK)

| Field | Default | Meaning |
|---|---|---|
| `approval` | `not requested` | Roll-up state (§3) |
| `approval_history` | | Journal of decisions and comments |
| `approval_set` | | When the roll-up last reached approved/rejected [Inferred] |
| `upon_approval` | `proceed` | `proceed` (continue the process) or `do_nothing` (wait for a person) [Inferred values] |
| `upon_reject` | `cancel` | `cancel` (cancel the record and future work) or `goto` (return to `rejection_goto`) [Inferred values] |
| `rejection_goto` | | Task to reopen when `upon_reject=goto` |

### 1.5 `sys_user_delegate` [Inferred]

`user` (delegator), `delegate`, `starts`, `ends`, `approvals` (bool), `assignments` (bool), `notifications` (bool), `invitations` (bool). Active when `starts` is empty or ≤ now, and `ends` is empty or > now; `delegate != user`; delegate must be active. Documented basis: users can be delegates acting with a delegator's permissions; notifications have an "Exclude delegates" option (https://www.servicenow.com/docs/r/platform-administration/user-administration/user.html, https://www.servicenow.com/docs/r/platform-administration/t_CreateANotification.html).

---

## 2. Approval lifecycle

Sources: https://www.servicenow.com/docs/r/build-workflows/approvals/r_Approvals.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_GenAnApprovalUsingApprRules.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_GenApprovalsUsingApprsRelList.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_GeneApprovalsUsingWorkflows.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_ReceiveNotifications.html · https://www.servicenow.com/docs/r/platform-administration/r_ConstructAnEmailMessage.html · https://www.servicenow.com/docs/r/platform-administration/r_BaselineEmailNotifications.html · https://www.servicenow.com/docs/r/build-workflows/approvals/r_SetAutomaticApprovalRules.html

| Creation path | Initial state | Basis |
|---|---|---|
| Flow "Ask for Approval" action | `requested` (the action asks immediately) | Documented (path), Inferred (state) |
| Classic approval rule | `requested` | Documented |
| Manual add through the Approvers related list | `not requested`; the approver is emailed only when someone sets `requested` | Documented |
| Catalog item "Approved by" / "Approved by group" lists | gating approvals created on request submission (catalog module) | Documented |

Rules:
- The same approver is never added twice for one record by rules (rules and item approvals combined) [Documented]. ResolvrNow: a second insert for the same (`document_id`, `approver`, `iteration`) while the first is not cancelled is stored with state `duplicate` and no notification [Inferred].
- Entering `requested` (insert or update) queues `approval.inserted` (catalog requests: `request.approval.inserted`); the "Approval Request" notification on `sysapproval_approver` emails the approver with links to the record, to the approval, and mailto links that build an approve or reject reply (templates `change.itil.approve.role`, `mailto.approval`, `mailto.rejection`, layout with unsubscribe/preferences links) [Documented].
- Group recipients of approval notifications always get individual mails regardless of `include_members` [Documented].
- A decision (`approved`/`rejected`) is final for that row; changing it again requires approval_admin and re-runs the roll-up [Inferred].
- On a decision ResolvrNow appends to the approved record's `approval_history`: `"<approver display> <approved|rejected> <record display>"` plus the approval's latest comment, sets `approval_set`, and recomputes the roll-up (§3) [Inferred].
- Events [Documented names; triggers Inferred]: rejection queues `approval.rejected` (to the record's opener/assignee) and `approval.rejected.by.other` (to the other approvers whose rows become `not_required`); when the record's roll-up becomes approved, module events such as `change.approved`, `task.approved`, `sc_request.approved` are queued by module rules; the assignee is notified on approval [Documented].

---

## 3. Roll-up to the approved record

Sources: https://www.servicenow.com/docs/r/build-workflows/approvals/c_ApprovalStatus.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_MultipleApprovers.html · https://www.servicenow.com/docs/r/it-service-management/change-management/create-approval-definitions.html · https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/create-sf-step.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_ProcessApprovals.html

### 3.1 Classic roll-up (no rule attached) [Documented]

```
classicRollup(record):
  A = approvals(document_id = record) excluding states cancelled, not_required, duplicate   [exclusions Inferred]
  if any(a.state == 'rejected')                 → 'rejected'
  if A not empty and all(a.state == 'approved') → 'approved'
  if A empty or all(a.state == 'not requested') → 'not requested'
  otherwise                                     → 'requested'
```

With several approvers everyone must approve, and a single rejection rejects immediately [Documented].

### 3.2 Rule-based decisions (flows and group approvals)

Rule types and outcomes for a unit of N responders (members of one group, or the user list of one approval step):

| Rule | Approved when | Rejected when | Basis |
|---|---|---|---|
| `first_response` | the first response is an approval | the first response is a rejection | Documented ("First response") |
| `any` ("Anyone approves"; alias `anyone`) | at least one approval | everyone responded and nobody approved | Documented (approval), Inferred (rejection) |
| `all` ("All responses" / "All approve"; alias `everyone`) | all N approved | the first rejection | Documented |
| `percentage` p | approvals ≥ required | approvals + pending < required | Documented thresholds, Inferred formula |

Percentage details [Documented]: empty or ≤ 0 % behaves as first response; ≥ 100 % requires all responses; otherwise `required = roundHalfUp(N × p / 100)` (2.49 → 2, 2.5 → 3).

Composition [Inferred]: a step may contain several units (each group is a unit with its own rule; listed users form one unit with the step rule). The step is approved when every unit is approved and rejected as soon as one unit is rejected. When a unit or step is decided, its remaining `requested`/`not requested` rows become `not_required`; group rows (`sysapproval_group.approval`) mirror their unit's outcome.

### 3.3 Effects on the approved task [Inferred]

| Roll-up result | Effect |
|---|---|
| `approved` | `approval_set=now`; `upon_approval=proceed` lets waiting flows continue (event/condition wake-ups); `do_nothing` leaves progression to people. |
| `rejected` | `approval_set=now`; `upon_reject=cancel` cancels remaining approvals (`cancelled`), then calls the module hook `onApprovalRejected(record)` (platform default: state = default close-incomplete value, `active=false`); `goto` reopens `rejection_goto`. |
| record cancelled/closed while approvals pending | pending rows become `cancelled`. |

The roll-up is recomputed in an after rule on `sysapproval_approver` insert/update/delete (order 100) and writes `approval_column` on the approved record with `setWorkflow(true)` so module rules react [Inferred].

---

## 4. Classic approval engine and approval rules

Sources: https://www.servicenow.com/docs/r/build-workflows/approvals/c_ApprovalEngines.html · https://www.servicenow.com/docs/r/build-workflows/approvals/t_SetupAnApprovalEngine.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_ApprovalRules.html · https://www.servicenow.com/docs/r/build-workflows/approvals/r_SetAutomaticApprovalRules.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_GatingApprovals.html · https://www.servicenow.com/docs/r/build-workflows/approvals/t_SetUpAGatingApprViaApprovalRule.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_SetUpGatingApprBasedOnOrdItem.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_ProcessApprovals.html · https://www.servicenow.com/docs/r/build-workflows/approvals/execution-order-scripts-engines.html

Documented:
- Each task table selects an engine through property `glide.approval_engine.<table>`: Approval Rules, Process Guides (deprecated) or Turn engines off; tables whose approvals are managed by a flow or workflow must have engines off to avoid conflicts and performance issues.
- Classic approval rules are superseded by the flow "Ask for Approval" action but still run where configured.
- Approval rule fields: Name, Table, Active, Run Rule Before (evaluate before the record is saved), User, Group, Set State (value written to the record's approval field; only reliable with Run Rule Before), Condition, Script (returns the approver, e.g. the requester's manager).
- Several matching rules yield several approvers; duplicates collapse to one approval; rule-created approvals start as Requested; records start Not Yet Requested until something sets Requested.
- The approval engine runs among the before engines (platform-core §4.2).
- Catalog distinguishes gating approvals (before the request starts) from process approvals (inside fulfilment; a rejected line item is cancelled without cancelling the whole request).

ResolvrNow implementation [Inferred]: table `sysrule_approvals(name, table, active, run_before, user, group, set_state, condition, script, order)`; property values `approval_engine` | `process_guide` (treated as off) | `off` (ResolvrNow default for every table); when `approval_engine`, rules with `run_before=true` run in the before-engine phase and the others in the after phase:

```
for rule in sysrule_approvals(active, table ∈ [class(r)] + ancestors) ordered by order:
  if !matches(rule.condition, r): continue
  approvers = [rule.user] + members(rule.group) + toUsers(runScript(rule.script, {current: r}))
  for u in approvers (active users, de-duplicated): insert approval(state='requested', approval_source='rule')
  if rule.set_state and rule.run_before: r.approval = rule.set_state
```

---

## 5. Delegation [Inferred, see 1.5]

| Capability | Rule |
|---|---|
| Approvals | An active delegate with `approvals=true` may read and decide approvals whose `approver` is the delegator; the row keeps `approver`; the journal entry reads "<delegate> on behalf of <delegator>"; `sys_audit.reason="delegate"`. |
| Notifications | With `notifications=true`, the delegate receives copies of notifications sent to the delegator unless the notification sets `exclude_delegates`. |
| Assignments | `assignments=true` adds the delegator's assigned work to the delegate's "My Work" lists (UI only, no ACL change). |
| Invitations | `invitations=true` copies meeting invitations. |
| Validation | Before-insert rule refuses `delegate == user`, inactive delegates, and `ends < starts`. |

---

## 6. Approval by email reply

Sources: https://www.servicenow.com/docs/r/build-workflows/approvals/c_ReceiveNotifications.html · https://www.servicenow.com/docs/r/platform-administration/r_ConstructAnEmailMessage.html · https://www.servicenow.com/docs/r/platform-administration/c_InboundEmailActions.html · https://www.servicenow.com/docs/r/platform-administration/inbound-action-processing.html

Documented: approval emails include mailto links that compose an approve or reject reply addressed to the instance (text after the first lines of the template becomes the reply body); clients without HTML can reply with `state:approved` or `state:rejected` in the body; a suitable inbound action lets approvers answer with a plain yes or no; replies are matched to the approval by watermark.

ResolvrNow templates [Inferred]: `mailto.approval` renders `mailto:<glide.email.user>?subject=Re:${sysapproval} - approve&body=<watermark of this email>`; `mailto.rejection` the same with `reject`.

Inbound action "Update Approval Request" (type reply, table `sysapproval_approver`, order 100, stop processing) [Inferred]:

```
if current.state != 'requested': logger.log('approval not pending'); return
sender = email.from_sys_id
if sender != current.approver and !isActiveApprovalDelegate(sender, current.approver): log; return
text = email.body_text (already cut at the first reply separator)
decision =
   /\bstate\s*:\s*approved\b/i in text                     → 'approved'
   /\bstate\s*:\s*rejected\b/i in text                     → 'rejected'
   subject ends with '- approve' or first word of text ∈ {yes, approve, approved}   → 'approved'
   subject ends with '- reject'  or first word of text ∈ {no, reject, rejected}     → 'rejected'
if decision: current.state = decision; current.comments = text; current.approval_source = 'email'; current.update()
```

---

## 7. Approval security

Sources: https://www.servicenow.com/docs/r/platform-administration/user-administration/r_BaseSystemRoles.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/base-system-roles.html

Documented: `approver_user` can act on approvals routed to them; `approval_admin` can view and modify approvals not assigned to them.

ResolvrNow seed ACLs on `sysapproval_approver` [Inferred]:

| Operation | Allowed when |
|---|---|
| read (row) | approver is me, or I am an active approval delegate of the approver, or I hold `approval_admin`, or I can read the approved record |
| write (`state`, `comments`) | state is `requested` or `not requested` and (approver is me or active delegate), or `approval_admin` |
| write (`approver`, `document_id`, `sysapproval`) | `approval_admin` (admin overrides) |
| create | `itil` (manual approvers on tasks they can write) or `approval_admin` |
| delete | `admin` |

UI actions "Approve" and "Reject" (form buttons, list choices) appear when `state=='requested'` and the user passes the write rule; "Reject" requires a comment (client check plus server abort when `comments` is empty) [Inferred].

---

## 8. Workflow Studio concepts

Sources: https://www.servicenow.com/docs/r/build-workflows/workflow-studio/exploring-workflow-studio.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/workflow-studio-flows-subflows-and-actions-landing.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/getting-started-flow.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/exploring-flows.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/configuring-flow-designer.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/flows.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/subflows.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/actions.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/building-triggers.html · https://www.servicenow.com/docs/r/build-workflows/workflow-studio/flow-designer-reference.html · https://www.servicenow.com/docs/r/platform-administration/processing-inbound-emails.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_GeneApprovalsUsingWorkflows.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_PrecBetweenAssignmentAndBusRules.html

### 8.1 Building blocks [Documented]

| Concept | Description |
|---|---|
| Flow | A trigger plus an ordered sequence of actions, flow logic and subflow calls; has an error-handler section and a data panel of typed "pills" (trigger data, action outputs, flow variables). |
| Subflow | No trigger; declared inputs and outputs; called from flows, other subflows or scripts; outputs assigned with "Assign Subflow Outputs" (last assignment wins unless guarded by conditions). |
| Action | Reusable operation with inputs, steps and outputs; core actions (create/update/look up records, send email, ask for approval, log...) are not editable; spokes add application actions; every action exposes an Action Status (code, message). Custom actions require `action_designer`. |
| Trigger | Record-based (created/updated in a table, with conditions), schedule-based (date/time or repeating), application-based (service catalog, inbound email, ...); triggers can be saved and reused across flows. |
| Flow logic | If / Else If / Else, For Each, Do Until loops, parallel branches, wait for a duration, wait for a condition, make a decision (decision tables), set flow variables, call subflow, error handling. |
| Properties | Name, protection (none/read-only), application (fixed after creation), description, Run As (system user or the user who initiated the session; not inherited by child subflows), Run with roles (only with run-as-user; roles apply to the flow, not to the user). |
| Execution details | Each run creates a context record holding state and runtime values; full reporting is off by default in production and generated on manual tests. |
| Roles | `flow_designer` or `admin` to build flows/subflows; `action_designer` for actions. |

Documented limits and guidelines: at most 50 actions per flow (`sn_flow_designer.max_actions`), 25 recommended; For Each and Do Until should stay under 1000 iterations (`sn_flow_designer.max_iterations`, default 1000) and Look Up Records under 1000 rows; subflows should stay under 20 inputs; flows longer than about an hour hit the transaction quota; a flow may not call itself (A→B→A allowed up to three times); never sleep inside a flow, use waits or schedule triggers; parallel branches must not depend on each other; deactivate legacy automations before replacing them with flows.

Platform interplay [Documented]: the trigger engine starts flows after the database operation (after engines); a flow's approval action fills the approval's Flow field; inbound email flows run before inbound email actions; approval engines must be off for tables whose approvals a flow manages.

### 8.2 Tables (SDK)

| Table | ResolvrNow use |
|---|---|
| `sys_hub_flow_base` / `sys_hub_flow` | Definition header: `name`, `internal_name`, `type` (`flow` default, `subflow`), `status` (`draft` default, `published`), `active`, `run_as` (`user` default, `system`), `run_with_roles`, `description`, `category`, `callable_by_client_api`, `latest_snapshot`, `master_snapshot`. ResolvrNow adds the extension column `resolvr_definition` (json, §10). |
| `sys_hub_flow_component`, `sys_hub_flow_logic_instance_v2`, `sys_hub_flow_block` | ServiceNow's normalized graph; ResolvrNow exposes them read-only as derived rows (v2) and stores the graph in `resolvr_definition`. |
| `sys_flow_context` | Run record: `name`, `flow`, `state`, `source_table`, `source_record`, `run_time`, `error_message`, `error_state`, `plan` (json), `attributes` (json), `execution_id`, `is_test_run`, `reporting`. |
| `resolvr_flow_snapshot` | Published, immutable copy of a definition (`flow`, `version`, `definition` json); `sys_hub_flow.master_snapshot` stores its sys_id (product table, hence the `resolvr_` prefix) [Inferred]. |
| `wf_workflow`, `wf_context` | Classic workflow; present for API compatibility, never executed by ResolvrNow. |

`sys_flow_context.state` values [Inferred]: `QUEUED`, `IN_PROGRESS`, `WAITING`, `COMPLETE`, `CANCELLED`, `ERROR`.

---

## 9. Minimal subset ResolvrNow implements

Sources: as §8 (concepts and limits are Documented there); the selection below is a ResolvrNow decision [Inferred].

| Area | ResolvrNow v1 | Deferred |
|---|---|---|
| Definition | JSON document (§10) stored on `sys_hub_flow.resolvr_definition`; publish creates a `resolvr_flow_snapshot` row; running contexts keep their snapshot | Visual designer, saved triggers, decision tables |
| Triggers | `record` (created, updated, created_or_updated; condition; run mode), `scheduled` (once, daily, weekly, monthly, interval), `api` (manual start / subflow call) | Service catalog, inbound email, SLA, REST, external triggers |
| Flow logic | `if` / `else_if` / `else`, `for_each`, `do_until`, `wait_duration`, `wait_condition`, `set_variables`, `subflow`, `assign_outputs`, `end` | Parallel branches, make a decision, go back to, try/catch blocks |
| Actions | `create_record`, `update_record`, `delete_record`, `look_up_record`, `look_up_records`, `create_task`, `ask_for_approval`, `send_notification`, `send_email`, `fire_event`, `log`, `run_script` (admin-authored) | Spokes, custom action designer, MID steps |
| Approvals | `ask_for_approval` with users, groups, dynamic fields, rules from §3.2, due date with timeout outcome | Approval policies, conditional approver lists |
| Errors | Error handler steps; context `ERROR` with message | Error retries |
| Execution details | Step status, timings, outputs (redacted for password fields) in `sys_flow_context.attributes` when reporting is on | Full UI |

---

## 10. JSON flow definition format (proposal)

Sources: as §8 for the concepts it encodes (triggers, flow logic, actions, run-as, roles, limits) [Documented]; the document shape, key names and expression grammar are a ResolvrNow design [Inferred, ResolvrNow decision].

### 10.1 Document

| Key | Type | Required | Meaning |
|---|---|---|---|
| `schema` | string | yes | `resolvr.flow/v1` |
| `name`, `internal_name`, `description` | string | name, internal_name | Identity (internal_name: `[a-z0-9_]+`, unique) |
| `type` | `flow` \| `subflow` | yes | |
| `run_as` | `system` \| `user` | default `system` | `user` = the session user who caused the trigger (or the API caller) |
| `run_with_roles` | string[] | no | Extra roles while running, only with `run_as=user` |
| `trigger` | object | flows only | §10.2 |
| `inputs`, `outputs` | `{name, type, mandatory?, default?, label?}[]` | subflows | Types: `string`, `integer`, `decimal`, `boolean`, `date_time`, `reference:<table>`, `records:<table>`, `json` |
| `variables` | same shape | no | Flow variables, initialized to `default` |
| `steps` | Step[] | yes | §10.3 |
| `error_handler` | Step[] | no | Runs when a step fails; pill `error` = `{step, code, message}` |

### 10.2 Trigger

```json
{ "type": "record", "table": "change_request", "when": "created_or_updated",
  "condition": "type=normal^approval=not requested^state=-4", "run": "each_unique_change" }
```

| `type` | Keys |
|---|---|
| `record` | `table`; `when` = `created` \| `updated` \| `created_or_updated`; `condition` (encoded query, change operators allowed); `run` = `once` (first qualifying event per record, ever) \| `each_unique_change` (every qualifying update where a field named in the condition changed; default) \| `always` (every qualifying write) \| `if_not_running` (skip while a context for this record is QUEUED, IN_PROGRESS or WAITING) |
| `scheduled` | `repeat` = `once` \| `daily` \| `weekly` \| `monthly` \| `interval`; `at` (ISO time or date-time, system time zone), `days_of_week`, `day_of_month`, `every` (ISO-8601 duration for interval) |
| `api` | none; started by `POST /api/app/flow/{internal_name}/start` with `inputs`, or by `FlowAPI.startFlow(name, inputs)` in scripts |

Pills available from a record trigger: `trigger.current` (record), `trigger.previous` (record or null), `trigger.table`, `trigger.operation`, `trigger.user` (sys_id of the session user).

### 10.3 Steps

Common keys: `id` (unique within the document), `type`, `label` (optional), `when_error` = `fail` (default) \| `continue`.

| `type` | Keys | Outputs (as `steps.<id>.*`) |
|---|---|---|
| `action` | `action` (name from §9), `inputs` (object) | action-specific (§10.4) plus `status` `{code, message}` |
| `if` | `condition`, `then` (Step[]), `else_if` (`[{condition, steps}]`), `else` (Step[]) | none |
| `for_each` | `items` (pill resolving to a record list or array), `as` (pill name, default `item`), `steps` | `iterations` |
| `do_until` | `condition` (checked after each pass), `steps`, `max_iterations` (≤ 1000) | `iterations` |
| `wait_duration` | `duration` (ISO-8601) or `until` (date-time pill), optional `schedule` (cmn_schedule sys_id) | `resumed_at` |
| `wait_condition` | `record` (pill), `condition` (encoded query), `timeout` (ISO-8601, optional) | `timed_out` (bool) |
| `set_variables` | `values` `{name: value}` | none |
| `subflow` | `subflow` (internal_name), `inputs`, `wait` (default true) | the subflow's outputs, `context` |
| `assign_outputs` | `values` (subflow only) | none |
| `end` | `status` = `complete` \| `error`, `message` | none |

Values and conditions:
- `{{path}}` inserts a pill; a value that is exactly one pill keeps its type (record, number, list); otherwise text interpolation is used. Paths: `trigger.*`, `inputs.*`, `vars.*`, `steps.<id>.*`, `item.*`, `error.*`, `now`, `run_as_user`. Dot-walking through references is allowed (`trigger.current.assigned_to.manager`).
- A condition is either an encoded query on a record, `{"record": "{{trigger.current}}", "query": "priority=1"}`, or a comparison tree `{"all"|"any": [{"left": "{{steps.s2.count}}", "op": ">", "right": 0}, ...]}` with ops `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `starts_with`, `in`, `is_empty`, `is_not_empty`.

### 10.4 Action contracts

| Action | Inputs | Outputs |
|---|---|---|
| `create_record` / `create_task` | `table`, `values` (field → value; journal fields append), `wait_for_completion` (create_task only; waits until the task is inactive) | `record` |
| `update_record` | `record`, `values` | `record` |
| `delete_record` | `record` | none |
| `look_up_record` | `table`, `query`, `order_by` | `record`, `found` |
| `look_up_records` | `table`, `query`, `order_by`, `limit` (≤ 1000) | `records`, `count` |
| `ask_for_approval` | `record`; `approvers` `{users: [], groups: [], fields: ["assigned_to.manager"]}`; `rule` `{type: first_response \| any \| all \| percentage, percentage?}` for the user unit; `group_rule` (same shape, default `first_response`) per group; `due` (ISO duration or date-time) with `on_due` = `approve` \| `reject` \| `cancel`; `approval_field` (default `approval`), `journal_field` (default `approval_history`) | `approval_state` (`approved` \| `rejected` \| `cancelled`), `approvals` (records) |
| `send_notification` | `notification` (sys_id or name), `record` | none |
| `send_email` | `to`, `cc`, `subject`, `body`, `record` (target) | `email` |
| `fire_event` | `name`, `record`, `parm1`, `parm2` | none |
| `log` | `level` (`info` \| `warn` \| `error`), `message` | none |
| `run_script` | `script` (sandboxed; only in flows whose last editor holds admin) | `result` |

### 10.5 Example: normal change approval

```json
{
  "schema": "resolvr.flow/v1",
  "name": "Change - Normal - CAB approval",
  "internal_name": "change_normal_cab_approval",
  "type": "flow",
  "run_as": "system",
  "trigger": { "type": "record", "table": "change_request", "when": "created_or_updated",
               "condition": "type=normal^state=-4^approval=not requested", "run": "each_unique_change" },
  "variables": [ { "name": "rejections", "type": "integer", "default": 0 } ],
  "steps": [
    { "id": "mgr", "type": "action", "action": "ask_for_approval",
      "inputs": { "record": "{{trigger.current}}",
                  "approvers": { "fields": ["requested_by.manager"] },
                  "rule": { "type": "first_response" } } },
    { "id": "chk", "type": "if",
      "condition": { "all": [ { "left": "{{steps.mgr.approval_state}}", "op": "=", "right": "approved" } ] },
      "then": [
        { "id": "grp", "type": "action", "action": "look_up_record",
          "inputs": { "table": "sys_user_group", "query": "name=CAB Approval^active=true" } },
        { "id": "cab", "type": "action", "action": "ask_for_approval",
          "inputs": { "record": "{{trigger.current}}",
                      "approvers": { "groups": ["{{steps.grp.record}}"] },
                      "group_rule": { "type": "percentage", "percentage": 50 },
                      "due": "P3D", "on_due": "reject" } },
        { "id": "set", "type": "action", "action": "update_record",
          "inputs": { "record": "{{trigger.current}}",
                      "values": { "state": "{{steps.cab.approval_state == 'approved' ? -2 : -5}}" } } }
      ],
      "else": [
        { "id": "note", "type": "action", "action": "update_record",
          "inputs": { "record": "{{trigger.current}}",
                      "values": { "work_notes": "Rejected by manager", "state": -5 } } },
        { "id": "stop", "type": "end", "status": "complete" }
      ] }
  ],
  "error_handler": [
    { "id": "err", "type": "action", "action": "log",
      "inputs": { "level": "error", "message": "Approval flow failed at {{error.step}}: {{error.message}}" } }
  ]
}
```

Note: the ternary inside `{{...}}` is allowed only in the restricted expression grammar (comparisons, `? :`, `&&`, `||`, string/number literals); no function calls.

---

## 11. ResolvrNow flow runtime [Inferred, ResolvrNow decision]

Sources: https://www.servicenow.com/docs/r/build-workflows/workflow-studio/flows.html (limits, run-as, waits, no self-calls) · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_PrecBetweenAssignmentAndBusRules.html (trigger engine runs after the database operation).

```
TRIGGER (after engine, platform-core §4.2 step 10), for each published active flow F with record trigger on
          table ∈ [class(r)] + ancestors:
  skip if the write was done with setWorkflow(false)
  skip if the write originates from a context of F on the same record            // no self re-trigger
  op matches F.trigger.when and condition matches (previous known)
  run mode check (once / each_unique_change / always / if_not_running)
  insert sys_flow_context{state:'QUEUED', flow:F, snapshot:F.master_snapshot, source_table, source_record,
                          plan:{trigger:{current:image(r), previous:image(previous), operation, user}}}

RUNNER (scheduler, every resolvr.flows.poll_interval_ms, default 1000):
  pick QUEUED or due WAITING contexts in sys_created_on order
  ctx.state = 'IN_PROGRESS'; identity = run_as == 'system' ? system : trigger.user (+ run_with_roles)
  execute steps from the saved program counter; each action step commits in its own transaction
  record pills re-read the record from the database when dereferenced (trigger images serve `previous`)
  wait steps persist {kind, wake_at | (table, sys_id, query) | approval step id} in attributes,
     set state 'WAITING' and yield
  wake-ups: timer due; after-update hook on a watched record whose condition now matches;
            approval roll-up change for the context's approval step; subflow completion
  step failure: when_error=continue → record error, go on; else run error_handler then state 'ERROR'
  end step / last step: state 'COMPLETE' (or 'ERROR' for end{status:error}); run_time = active ms
  guards: > 1000 loop iterations → ERROR; > 3600 s active execution → ERROR "transaction quota";
          > 50 action steps → refused at publish
CANCEL: POST /api/app/flow/context/{sys_id}/cancel → state 'CANCELLED', pending approvals 'cancelled'
```

`ask_for_approval` runtime: creates units (one `sysapproval_group` per group, user approvals in one unit), inserts approvals with state `requested`, `approval_source='flow'`, `flow_context=<ctx>`, writes `requested` into the record's approval field, then waits; every approval change recomputes §3.2 for the step; the outcome is written to `approval_field`, remaining rows become `not_required`, and the step completes with `approval_state`. When `due` passes, `on_due` decides the outcome and pending rows become `not_required` (or `cancelled` for `cancel`).

---

## 12. Acceptance tests

1. **Manual approver starts not requested.** Given a change and an approver added via the related list, when saved, then state is `not requested` and no email is generated; when set to `requested`, then `approval.inserted` is queued and the Approval Request email addresses the approver.
2. **Classic roll-up all approve.** Given two requested approvals on a change with no flow, when both are approved, then `change_request.approval = approved` and `approval_set` is filled.
3. **Classic roll-up any reject.** Given two requested approvals, when one is rejected, then the change approval is `rejected` immediately and the other row becomes `not_required`.
4. **Roll-up not requested.** Given two approvals both `not requested`, then the record's approval is `not requested`; when one becomes `requested`, then the record's approval is `requested`.
5. **Cancelled rows ignored.** Given one approved and one cancelled approval, then the roll-up is `approved`.
6. **Duplicate approver.** Given an approval for U on record R, when a rule adds U again for R in the same iteration, then the new row has state `duplicate` and no email.
7. **First response rule.** Given a step with users A, B, C and rule `first_response`, when B rejects first, then the step is rejected and A, C become `not_required`.
8. **Any rule.** Given rule `any` with A, B, when A rejects, then the step is still pending; when B approves, then it is approved.
9. **All rule.** Given rule `all` with A, B, C, when A and B approve and C rejects, then the step is rejected.
10. **Percentage rounding.** Given rule `percentage` 50 with 5 approvers, then required = 3 (2.5 rounds up); after 2 approvals the step is pending, after the third it is approved and the remaining rows become `not_required`.
11. **Percentage impossible.** Given 50 % of 4 (required 2), when 3 reject, then the step is rejected.
12. **Percentage edge values.** Given percentage 0 or empty, then the first response decides; given 100, then all responses are required.
13. **Group approval.** Given a group G (3 members) with `group_rule=first_response`, when the step starts, then one `sysapproval_group` row and 3 member approvals exist; when one member approves, the group row is `approved`.
14. **Group email exception.** Given G with `include_members=false` and a group email, when member approvals are requested, then each member gets the Approval Request email.
15. **Approval history.** Given an approver approving with comment "ok", then the change's `approval_history` gains an entry naming the approver and containing "ok".
16. **Reject cancels.** Given a change with `upon_reject=cancel`, when its approval roll-up becomes `rejected`, then pending approvals become `cancelled` and the module hook ran.
17. **Approval rule engine.** Given `glide.approval_engine.change_request=approval_engine` and rule "category=network → user U, set_state requested, run_before", when a network change is inserted, then an approval for U exists in `requested` and the change approval is `requested`.
18. **Engine off by default.** Given no engine property, when the same change is inserted, then no rule-based approval is created.
19. **Delegate approves.** Given U delegates approvals to D (active window), when D approves U's approval through the Table API, then the update succeeds, `approver` stays U and the journal mentions D on behalf of U; after the window ends the same update returns 403.
20. **Non-approver blocked.** Given an itil user who is neither approver nor delegate nor approval_admin, when PATCHing `state=approved`, then the response is 403.
21. **approval_admin override.** Given an approval_admin, when PATCHing another user's requested approval to approved, then it succeeds.
22. **Email approve via mailto.** Given an Approval Request email with watermark W, when the approver replies with subject "Re:CHG0030001 - approve" and body containing W, then the approval becomes `approved` with `approval_source=email` and the reply text in comments.
23. **Email body keyword.** Given a reply whose body contains `state:rejected`, then the approval becomes `rejected`.
24. **Email from stranger.** Given a reply with W from a user who is not the approver or a delegate, then the approval is unchanged and the email log says not authorized.
25. **Email on decided approval.** Given an already approved approval, when a reply with `state:rejected` arrives, then nothing changes.
26. **Record trigger fires after commit.** Given a published flow on incident `created` with condition `priority=1`, when a P1 incident is inserted, then one `sys_flow_context` in `QUEUED` exists after the transaction and none for a P3 incident.
27. **setWorkflow(false) does not trigger.** Given the same flow, when a script inserts a P1 incident with `setWorkflow(false)`, then no context is created.
28. **Run once.** Given `run=once` on `updated` with condition `state=2`, when the record goes 1→2, 2→3, 3→2, then exactly one context exists.
29. **If not running.** Given `run=if_not_running` and a context WAITING for the record, when the record is updated again with a matching condition, then no new context is created.
30. **No self re-trigger.** Given a flow whose step updates the triggering record (still matching), when it runs, then no second context of that flow is created for the record.
31. **Ask for approval in flow.** Given the example flow (§10.5) and a matching change, when the manager approves, then the CAB step creates group approvals and the context is WAITING; when 50 % of the CAB approves, then the change state becomes -2 and the context is COMPLETE.
32. **Due date timeout.** Given `due=P3D, on_due=reject` and no responses, when 3 days pass, then the step outcome is `rejected`, pending approvals are `not_required` and the flow continues on the rejected path.
33. **Wait for condition.** Given a `wait_condition` on the triggering incident with `state=6` and timeout P1D, when the incident is resolved after 2 hours, then the context resumes within one runner tick with `timed_out=false`.
34. **Wait for duration.** Given `wait_duration PT1H`, when the context reaches it, then the state is WAITING and it resumes no earlier than one hour later.
35. **For-each limit.** Given `look_up_records` returning 1001 items consumed by `for_each`, then the context ends in ERROR with an iteration-limit message.
36. **Error handler.** Given an `update_record` step on a deleted record, when it fails, then the error handler's log step runs and the context state is ERROR with `error_message` set.
37. **Publish limit.** Given a definition with 51 action steps, when published, then the publish is refused with a validation error.
38. **Snapshot isolation.** Given a context WAITING on snapshot v1, when the flow is republished as v2, then the waiting context resumes with v1 steps while new triggers use v2.
39. **Run as user.** Given `run_as=user` and a trigger caused by ESS user E, when a step creates a record E cannot create, then the step fails with an ACL error; with `run_with_roles:["itil"]` it succeeds and `sys_created_by` is E.
40. **Cancel context.** Given a WAITING approval context, when cancelled through the API, then the context is CANCELLED and its requested approvals become `cancelled`.
