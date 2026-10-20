# Change Management: ResolvrNow implementation spec

Baseline: public ServiceNow documentation for the "Brazil" release, ServiceNow SDK table metadata (MIT), ResolvrNow engine design.
Companion files: `docs/spec/change-api.md` (REST API) and `docs/spec/data/change.json` (choices, extra tables, constants).

## 0. Conventions

- **[Documented]**: a fact stated in public ServiceNow docs or the SDK schema (source cited per section).
- **[Inferred]**: a reconstruction or a ResolvrNow design decision. Safe to revise when evidence appears. "ResolvrNow decision" is used when we deliberately choose behavior that the docs do not pin down.
- Change requests and change tasks are rows of the `task` hierarchy (`sys_class_name` = `change_request` / `change_task`). All state values are integers stored in `task.state`.
- Column names come from the SDK schema (`server/src/schema/sdk/sdk-tables.json`, loaded by `server/src/schema/sdk.ts`) when present, otherwise from `data/change.json`, whose `tables` section uses the same column shape so the adapter can load it.
- Times are stored in UTC (`YYYY-MM-DD HH:mm:ss`), rendered in the user time zone.

Sources (overview): https://www.servicenow.com/docs/r/it-service-management/change-management/c_ITILChangeManagement.html, https://www.servicenow.com/docs/r/it-service-management/change-management/exploring-change-management.html

## 1. Data model overview

| Table | Label | Extends | Numbering | Purpose | Prov. |
|---|---|---|---|---|---|
| `change_request` | Change Request | `task` | `CHG`, start 30000, 7 digits (CHG0030022) | The change record | Documented (SDK, API samples) |
| `change_task` | Change Task | `task` | `CTASK`, start 10000, 7 digits | Unit of work under a change | Documented table and prefix; start number Inferred |
| `chg_model` | Change Model | none (ResolvrNow) | none | Model: states, transitions, presets, security | Documented |
| `sttrm_state_transition` | Model State Transition | none | none | From/to transitions of a model | Documented (named in API sample) |
| `sttrm_state`, `sttrm_transition_condition`, `sttrm_condition_type`, `sttrm_state_field_policy`, `sttrm_attribute`, `sttrm_state_attribute` | Model engine | none | none | States, conditions, field policies, attributes | Inferred names |
| `chg_template` (+ `chg_template_field_policy`, `chg_template_category`, `chg_template_task`) | Change Template | none | none | Model-based templates | `chg_template` Documented (SDK reference); others Inferred |
| `std_change_properties`, `std_change_proposal`, `std_change_record_producer`, `std_change_producer_version`, `std_change_template` | Standard change catalog | proposal extends `task` (Inferred); producer extends `sc_cat_item_producer` (Inferred) | proposal `STDCHG` (Inferred) | Standard change catalog | Documented names |
| `std_change_task_template` | Change task template | none | none | Tasks created with a standard change | Inferred name |
| `conflict` | Conflict | none | none | Conflict detection results | Documented |
| `cmn_schedule_condition` and children `cmn_schedule_blackout`, `cmn_schedule_maintenance`, `cmn_schedule_information` | Schedules | `cmn_schedule` | none | Blackout/maintenance/information windows | Documented |
| `chg_lockdown`, `chg_lockdown_change` | Change lockdown | `cmn_schedule_condition` (Inferred) | none | Pause in-flight changes | Inferred names (feature Documented) |
| `risk_conditions` | Risk Conditions | none | none | Risk calculator rules | Documented |
| `change_risk_asmt`, `change_risk_asmt_threshold` (+ ResolvrNow `change_risk_asmt_question`, `change_risk_asmt_result`) | Risk assessment | none | none | Questionnaire risk | First two Documented; ResolvrNow tables Inferred |
| `sn_chg_probability_risk_lookup` | Calculated risk lookup | none | none | Impact x success probability to risk | Documented |
| `chg_policy`, `chg_policy_approval`, `chg_policy_input`, `chg_policy_decision`, `chg_approval_definition` | Approval policies | `chg_policy_approval` extends `chg_policy` | none | Policy-driven approvals | `chg_policy_approval` Documented; others Inferred |
| `cab_definition`, `cab_meeting`, `cab_agenda_item`, `cab_attendee`, `cab_runtime_state` | CAB workbench | `mtg_*` parents | none | CAB meetings | Documented |
| `chg_mgt_worker` | Change Management Worker | none | none | Async jobs (conflicts, CI association, scheduling) | Documented |
| `chg_soc_definition`, `chg_soc_definition_child`, `chg_soc_style_rule_core` (+ 3 style tables) | Change schedules | none | none | Calendar definitions | Documented |
| `task_ci`, `task_cmdb_ci_service`, `task_service_offering` | Task relations | none | none | Affected CIs, impacted services, offerings | First two Documented; shared with CMDB spec |
| `sysapproval_approver`, `sysapproval_group` | Approvals | none | none | Platform approval records | Platform (shared) |
| `rm_product`, `rm_release`, `rm_release_phase`, `rm_task`, `rm_m2m_release_task` | Release Management | `task` family (Inferred) | Inferred | Releases (section 23) | Documented names |

### 1.1 Notable `change_request` columns

| Column | Type | Meaning in ResolvrNow | Prov. |
|---|---|---|---|
| `type` | string choice | standard, normal, emergency (default from model) | Documented |
| `chg_model` | ref `chg_model` | Governs states and transitions; default from default model | Documented |
| `chg_model_template` | ref `chg_template` | Template used at creation | Documented (SDK) |
| `std_change_producer_version` | ref, read-only | Standard template version used | Documented |
| `start_date` / `end_date` | date-time | Planned start / planned end | Documented |
| `work_start` / `work_end` (task) | date-time | Actual start / actual end | Documented |
| `risk`, `impact`, `priority` | integer choice | See section 6 | Documented |
| `cab_required`, `cab_date`, `cab_date_time`, `cab_delegate`, `cab_recommendation` | mixed | CAB support (section 5) | Documented |
| `conflict_status`, `conflict_last_run`, `exclude_from_conflict_detection`, `outside_maintenance_schedule` | mixed | Conflict detection (section 7) | Documented |
| `on_hold`, `on_hold_reason` (free text, 4000), `on_hold_task` (glide_list `change_task`) | mixed | Hold handling (section 3.6) | Documented |
| `unauthorized` | boolean | Unauthorized change flag (section 14) | Documented |
| `close_code`, `close_notes` | choice / text | Closure (section 11) | Documented |
| `review_comments`, `review_date`, `review_status` | mixed | Post-implementation review | Documented columns; choices Inferred |
| `phase`, `phase_state` | choice | Legacy phase tracking, defaults `requested` / `open` | Documented |
| `scope` | integer choice | 1 Massive to 5 Tiny, default 3 | Documented |
| `justification`, `implementation_plan`, `backout_plan`, `test_plan`, `risk_impact_analysis`, `change_plan` | text 4000 | Planning tab | Documented |
| `copied_from` | ref `change_request` | Source of Copy Change | Documented |
| `is_bulk`, `proposed_change` | boolean / text | Mass update CI class | Documented (API payload) |
| `child_changes_creation_status`, `primary_change` | choice / ref | Scaled change (section 22) | Documented |
| `risk_and_compliance_category`, `risk_and_compliance_attributes` | ref / json-like | Compliance dynamic schema; ResolvrNow stores JSON text | Documented columns; storage Inferred |

Dictionary overrides on `change_request` (ResolvrNow): `state` default -5, `approval` default `not requested`, `risk` default empty (form shows "-- None --" until set), `impact` 3, `urgency` 3, `priority` 4, `category` `Other`, `phase` `requested`, `phase_state` `open`, `scope` 3, `conflict_status` `Not Run`. **[Documented]** for state/impact/priority/urgency/scope/phase/conflict defaults (API create sample, SDK); risk default empty **[Documented]** by the create form doc (the API field table claims default 3, see open questions).

Sources: SDK schema; https://www.servicenow.com/docs/r/api-reference/rest-apis/change-management-api.html; https://www.servicenow.com/docs/r/it-service-management/change-management/t_CreateAChange.html

## 2. Change types and change models

### 2.1 Types

| Type value | Label | Pre-approved | CAB | Path (base model) | Prov. |
|---|---|---|---|---|---|
| `standard` | Standard | yes | no | New, Scheduled, Implement, Review, Closed | Documented |
| `normal` | Normal | no | yes | New, Assess, Authorize, Scheduled, Implement, Review, Closed | Documented |
| `emergency` | Emergency | no | yes (CAB approval group) | New, Authorize, Scheduled, Implement, Review, Closed | Documented |

- Standard: low risk, repeatable, proven; created from a published template; no group, peer or CAB approval. **[Documented]**
- Normal: everything that is neither standard nor emergency; peer/technical review in Assess, change management and CAB authorization in Authorize. **[Documented]**
- Emergency: urgent fix (fix-on-fail, imminent failure, security patch); skips Assess and goes to Authorize for the CAB approval group. **[Documented]**
- Adding custom types (e.g. `expedited`) is a choice-list extension plus a model; ResolvrNow supports it through models only (no per-type script includes). **[Inferred]** ResolvrNow decision.
- `type` is read-only on the form; it is set by the model preset. The doc notes the field shows "Model" when the model defines no type. ResolvrNow stores an empty type and renders the label "Model". **[Documented]** display; storage **[Inferred]**.
- Legacy type values routine/comprehensive map to standard/normal (pre-Geneva upgrade). Not needed for ResolvrNow. **[Documented]**

### 2.2 Base change models

| Model | ITIL process | Type preset | States (initial first) | Approvals | Prov. |
|---|---|---|---|---|---|
| Normal | normal | `normal` | New, Assess, Authorize, Scheduled, Implement, Review, Closed, Canceled | Assess + Authorize | Documented |
| Standard | standard | `standard` | New, Scheduled, Implement, Review, Closed, Canceled | none | Documented |
| Emergency | emergency | `emergency` | New, Authorize, Scheduled, Implement, Review, Closed, Canceled | Authorize (CAB) | Documented |
| Unauthorized Change | none | `emergency`, `unauthorized=true` | Review, Authorize, Closed, Canceled | Authorize | States Documented via field policies; Canceled Inferred |
| Change Registration | none | `normal`, short description "Automated : Change" | Review, Closed, Canceled | none ("record of an automated change") | Documented (API sample, field policies); initial state Inferred |
| Cloud Infrastructure | none | Inferred | New, Authorize, Implement, Closed, Canceled | Authorize | Authorize/Closed Documented; others Inferred |
| DevOps, DevOps simplified, App, Low Risk, Patching | none | Inferred | Inferred | Inferred | Names Documented; ResolvrNow seeds them as optional |

Model columns (see `data/change.json`): `name`, `description`, `active`, `default_change_model`, `available_in_ui` ("Available in Create New"), `color` (default `#cbcbcb`), `record_preset` (encoded `field=value^...^EQ`), `table_name` (`change_request`), `state_field` (`state`), `itil_change_process`, `implementation_states`, security (`advanced_security`, `read_roles`, `write_roles`, available-for and not-available-for user criteria, can-write user criteria), template management (`template_proposer`, `template_approval_users`, `template_approval_groups`). **[Documented]** columns via API and form docs; physical names of security/template columns **[Inferred]**.

Rules:
- Only one active model per domain may carry a given `itil_change_process`; saving a second one aborts. A user without write access to the currently designated model cannot reassign the process. **[Documented]**
- Preset fields become read-only on change requests created from the model. **[Documented]**
- Property `com.snc.change_management.change_model.type_compatibility` (default false): when false changes are created only through models; when true type-only (legacy) creation is also allowed. `...change_model.hide` hides the model picker. A type with no matching model marks the model "Legacy". **[Documented]**

### 2.3 Model resolution at create time

1. If `chg_model` is given (sys_id or name), use it; reject inactive or unreadable models with 400. **[Inferred]**
2. Else if `type` is given, use the active model whose `itil_change_process` equals the type; if none is designated, fall back to the seeded base model of that name. **[Documented]** (ChangeRequest API behavior)
3. Else use the model with `default_change_model=true`; else Normal. The docs warn this default can change by release; clients should always send one of them. **[Documented]**
4. Apply `record_preset`, set `type` from preset (or leave empty), set `state` to the model's initial state. **[Inferred]**
5. Note: Copy Change may reset an emergency copy to the default model; ResolvrNow instead keeps the source model when `type` is in the copy attribute list. **[Documented]** quirk; ResolvrNow behavior **[Inferred]**.

### 2.4 Model engine (states, transitions, conditions)

- `sttrm_state`: `model`, `state` (integer value), `initial_state`, `order`. Adding the first state marks it initial. **[Documented]** behavior, **[Inferred]** names.
- `sttrm_state_transition`: `model`, `from_state`, `to_state`, `automatic_transition`, `name` (e.g. "Implement to Review"), `active`. Several transition records may exist for the same from/to pair, each with its own condition set. **[Documented]** (nextstates API sample).
- `sttrm_transition_condition`: `state_transition`, `name`, `description`, `requires` (reference to `sttrm_condition_type`: base types "Mandatory Fields", "Transition Condition" (condition builder), "Transition Script", plus reusable predefined types created by change managers), `condition`, `script`, `fields`, `active`, `policy_managed`. Editing scripts requires role `change_model_script_admin`; others see the script read-only. **[Documented]** behavior; reference modeling **[Inferred]**
- A transition is available when all of its active conditions pass. A from/to move is allowed when at least one active transition record for that pair is available. **[Inferred]** from the API, which lists alternative transition records per target state.
- Automatic transitions: after any update (and on the `change_model.evaluate` event with the change sys_id as parameter, or the "Evaluate Change Model" flow action) the engine evaluates automatic transitions out of the current state and moves the record when one passes. ResolvrNow evaluates at most 5 hops per save to avoid loops. **[Documented]** event/action; hop limit **[Inferred]**.
- Base conditions referenced in docs: "No active Change Tasks" (automatic Implement to Review) and "Not On hold" (manual Implement to Review). **[Documented]**

### 2.5 Model attributes

| Attribute | Effect when present on a state | Prov. |
|---|---|---|
| `allow_ci_modification` | `cmdb_ci` and affected CIs editable only in states carrying it. If no state of the model has it, CI is editable only in the initial state. Violations abort with "Configuration item cannot change for Change Requests in this state". | Documented |
| `allow_implementation` | Proposed CI changes (mass update CI) may be applied in these states; complements `implementation_states`. | Documented |
| `allow_conflict_detection` | If present on any state, automatic conflict detection runs only when the change is in such a state. | Documented |
| `allow_child_change_creation` | Scaled change trigger state (section 22). | Documented (as "Allow Child Change Creation") |

Server API (ResolvrNow `ChangeRequest` helper): `hasStateAttribute(name)`, `modelContainsAttribute(name)`, `getStateAttributes()`; client mirror in the workspace form scratchpad: `hasStateAttribute`, `containsAttribute`. **[Documented]**

### 2.6 State field policies

One policy = one field in one model state: Mandatory and/or Read only. Enforced on the server for every write path (form, flow, REST, scripts) when `com.snc.change_management.enforce_data_requirements` is true (default). Error texts: "Mandatory fields must be populated: <labels>" and "Read-only fields can't be modified: <labels>". **[Documented]**

Exceptions **[Documented]**:
- On a state change, a field blocks only if it is read-only in both the old and new state.
- Values set by the model `record_preset` at insert are not blocked.
- A field that is mandatory and read-only and still empty may be filled once.

Making a field mandatory auto-maintains a "State Field Policy Managed" condition (type mandatory fields) on every transition into that state; it is rebuilt when policies or transitions change and deleted when empty. Copying a model copies its policies. **[Documented]** Effective rules = state policies (current and target) + mandatory-field transition conditions + template field policies. **[Documented]**

Default mandatory fields (all policies mandatory-only) **[Documented]**:

| Model | State | Mandatory |
|---|---|---|
| Normal | Assess, Authorize, Scheduled, Implement, Review | assignment_group |
| Normal | Closed | assignment_group, close_code, close_notes |
| Standard | Scheduled, Implement, Review | assignment_group |
| Standard | Closed | assignment_group, close_code, close_notes |
| Emergency | Authorize, Scheduled, Implement, Review | assignment_group |
| Emergency | Closed | close_code, close_notes |
| Unauthorized Change | Review | assignment_group |
| Unauthorized Change | Authorize | assignment_group, cmdb_ci, short_description, description |
| Unauthorized Change | Closed | assignment_group, close_code, close_notes |
| Change Registration | Review | assignment_group |
| Change Registration | Closed | assignment_group, description, close_code, close_notes |
| Change Registration | Canceled | description |
| Cloud Infrastructure | Authorize | assignment_group |
| Cloud Infrastructure | Closed | cmdb_ci, short_description, start_date, end_date, close_code, close_notes |

Sources: https://www.servicenow.com/docs/r/it-service-management/change-management/manage-change-models.html, .../change-types.html, .../create-a-change-model.html, .../configure-change-model-states.html, .../state-field-policies-change-models.html, .../default-state-field-policies.html, .../change-model-attributes.html, .../change-model-attribute-apis.html, .../create-predefined-transition-condition-type.html, .../model-script-editor-roles.html, .../attach-process-change-model.html, .../itil_change_process_models.html, .../change-models-properties.html, .../t_AddNewChangeType.html (all under https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 3. State model

### 3.1 State values

| Value | Label | Requester notified on entry | Can cancel from | Meaning | Prov. |
|---|---|---|---|---|---|
| -5 | New | no | yes | Draft; requester may save repeatedly | Documented |
| -4 | Assess | no | yes | Peer review and technical approval | Documented |
| -3 | Authorize | no | yes | Change management and CAB authorize and schedule | Documented |
| -2 | Scheduled | yes | yes | Authorized, waiting for planned start | Documented |
| -1 | Implement | yes | yes | Work in progress | Documented |
| 0 | Review | yes | no | Work done, post-implementation review | Documented |
| 3 | Closed | no | no | Complete | Documented |
| 4 | Canceled | yes | n/a | No longer required (any state except Closed; the Cancel action is disabled in Review) | Documented |

Legacy values 1 (Open), 2 (Work in Progress), 7 (Closed Skipped) are unused by the state model; old "Closed Incomplete" mapped to Closed with `successful_issues`, "Closed Skipped" to Canceled with `unsuccessful`. ResolvrNow does not seed these. **[Documented]**

Internal state names (state handler names, accepted by REST): `draft` (New), `assess`, `authorize`, `scheduled`, `implement`, `review`, `closed`, `canceled`. **[Documented]** (tutorial scripts use `draft` for New and `implement`, `review`, `closed`, `canceled`); `new` is accepted as a ResolvrNow alias for `draft`. **[Inferred]**

### 3.2 Allowed transitions

Normal **[Documented]** unless marked:

| From | To | Driver |
|---|---|---|
| New | Assess | UI action Request Approval; requires assignment_group, not on hold |
| New | Canceled | Cancel Change |
| Assess | Authorize | Automatic when Assess approvals are approved |
| Assess | New | Assess approval rejected, or Revert to New |
| Assess | Canceled | Cancel Change |
| Authorize | Scheduled | Automatic when Authorize approvals are approved (or skipped, see 4.2) |
| Authorize | New | Authorize approval rejected |
| Authorize | Canceled | Cancel Change |
| Scheduled | Implement | UI action Implement (user decides when planned start arrives) |
| Scheduled | Canceled | Cancel Change |
| Implement | Review | UI action Review (condition "Not On hold"), or automatic when "No active Change Tasks" |
| Implement | Canceled | Cancel Change |
| Review | Closed | UI action Close; close_code and close_notes mandatory |

Standard **[Documented]**: New to Scheduled (Request Approval; pre-approved, no approval records), New to Canceled, Scheduled to Implement, Scheduled to Canceled, Implement to Review, Implement to Canceled, Review to Closed. A rejected standard change (if an approval is configured) returns to New.

Emergency **[Documented]**: New to Authorize (Request Approval), New to Canceled, Authorize to Scheduled (approved), Authorize to New (rejected or Revert to New), Authorize to Canceled, Scheduled to Implement, Scheduled to Canceled, Implement to Review, Implement to Canceled, Review to Closed.

Unauthorized Change: created in Review; Review to Authorize (Request Approval); Authorize to Review (approved, creates a post-implementation review task); Review to Closed. **[Documented]** Authorize to Review on rejection and Authorize to Canceled **[Inferred]** (no New state exists in this model).

The same lists are machine-readable in `data/change.json` under `constants.stateTransitions`.

### 3.3 Transition validation (business rule "Change: validate state transition", before update)

Order **[Inferred]** (behaviors Documented):
1. Closed and Canceled are terminal: reject any state change.
2. If `on_hold` is true, only Canceled is allowed. **[Documented]**
3. Canceled is rejected from Review and Closed. **[Documented]**
4. The target must be a `to_state` of an active transition from the current state in the record's model; otherwise abort "Invalid state transition: <from> to <to>".
5. At least one transition record for the pair must pass all its conditions; otherwise abort listing failing condition names.
6. State field policies of the target apply (section 2.6).
7. System callers (flows, approval callbacks, the model evaluator) use the same validator; they may take automatic transitions and transitions marked approval-driven, which the UI does not offer as buttons.

### 3.4 Field editability by state

| State | Editable | Prov. |
|---|---|---|
| New | Everything (primary CI only here unless the model says otherwise) | Documented |
| Assess / Authorize | Read-only to prevent post-approval edits | Documented |
| Scheduled | Notes and status fields; description read-only | Documented |
| Implement / Review | Description and planning read-only; activity and closure editable | Documented |
| Closed / Canceled | Read-only except work notes | Inferred |

To edit planning data after approval the user reverts to New (normal/emergency) or raises a new change. **[Documented]**

### 3.5 Revert to New, type changes, cancellation

- Revert to New (context menu): normal from Assess, emergency from Authorize. Cancels all pending approvals, restarts the model flow, sets `approval` to `not requested`. **[Documented]** (approval reset **[Inferred]**).
- Type changes (ACL `change_request.type`): allowed only in New and only while no approval record exists. Standard to Normal or Emergency; Normal to Emergency and back. A rejected normal or emergency change returns to New, so its type can be changed and resubmitted. ResolvrNow also re-resolves the model when the type changes. **[Documented]** (model re-resolution **[Inferred]**).
- Cancel Change: prompts for a reason, appends it to work notes, sets state 4, clears `on_hold`, cancels active change tasks and pending approvals. **[Documented]**

### 3.6 On hold

Requires plugins Core and State Model in ServiceNow; always on in ResolvrNow. **[Documented]**

| Event | Effect | Prov. |
|---|---|---|
| `on_hold` set true | Pending approvals become `not_required` (remembered); all active change tasks not already held get `on_hold=true` and the change's `on_hold_reason`; sys_ids written to `on_hold_task` | Documented (on_hold_task usage Inferred) |
| `on_hold` cleared | Remembered approvals return to `requested`; tasks in `on_hold_task` released and their reason cleared; manually held tasks stay held | Documented |
| While on hold | Only Canceled is reachable | Documented |
| Canceled while on hold | `on_hold` forced to false | Documented |
| Approval policy activity | Completes early when the change goes on hold (finish condition) and restarts on release | Documented |

Sources: https://www.servicenow.com/docs/r/it-service-management/change-management/c_ChangeStateModel.html, .../normal-standard-emergency-states.html, .../t_ConfigStateModelTransit.html, .../t_AddANewState.html, .../state-model-activate-tasks.html, .../t_PlaceAChangeRequestOnHold.html, .../t_ProcessAChangeRequest.html, .../unauthorized-change-request.html, .../migrate-change-mgmt-pre-geneva.html; API nextstates sample in https://www.servicenow.com/docs/r/api-reference/rest-apis/change-management-api.html

## 4. Approvals

### 4.1 Records and the `approval` field

- Approvals are `sysapproval_approver` rows (`approver`, `sysapproval`/`document_id` = change, `state`), plus `sysapproval_group` for group approvals. States used: `requested`, `approved`, `rejected`, `not_required` (No Longer Required), `cancelled`. **[Documented]** (platform)
- `change_request.approval` (task field): `not requested` at creation; `requested` while any approval stage is open; `approved` once final authorization completes (entering Scheduled); `rejected` on rejection; back to `not requested` on Revert to New. **[Inferred]** (labels "Not Yet Requested" and "Approved" Documented in API samples).
- Approvers with only the `approval_user` role act on the approval record, which exposes: number, requested_by, cmdb_ci, type, start_date, end_date, risk, impact, short_description, description, justification, implementation_plan, risk_impact_analysis, backout_plan. **[Documented]**
- Bulk approve/reject from the "My Approvals" list; approval history can be shown in the change activity stream. **[Documented]**

### 4.2 Who approves (base flows)

| Type / model | State | Approvers | Completion rule | Prov. |
|---|---|---|---|---|
| Normal | Assess | Members of `assignment_group` (peer/technical review) | First response from any member | Documented |
| Normal | Authorize, risk High or Very High or Moderate | CAB approval group | First response (ResolvrNow default) | Documented that CAB is used; rule Inferred |
| Normal | Authorize, risk Low | Manager of `assignment_group` | Single approval | Documented |
| Normal | Authorize, manager already approved in Assess | none: Authorize is skipped, change goes to Scheduled | n/a | Documented |
| Standard | n/a | none (pre-approved): Request Approval sets approval `approved` and moves to Scheduled | n/a | Documented |
| Emergency | Authorize | CAB approval group | First response (ResolvrNow default) | Documented / rule Inferred |
| Unauthorized | Authorize | Change Management group | First response | Inferred |
| Change Registration | n/a | none | n/a | Documented |

ResolvrNow seeds groups "CAB Approval" and "Change Management". The change manager (`change_manager` field, users with role `change_manager`) is not an approver by default; policies may add them. **[Inferred]**

### 4.3 Approval outcomes

- Approved: the model advances (Assess to Authorize, Authorize to Scheduled, Unauthorized Authorize to Review). **[Documented]**
- Rejected (normal, emergency): state New, other pending approvals `not_required`, rejection comments added to work notes; type may now be changed. **[Documented]** (work-note copy **[Inferred]**)
- Rejecting through REST requires `comments`. **[Documented]**
- Duplicate approvers: when a user belongs to several approving groups, only one approval is generated. **[Documented]**

### 4.4 Change approval policies

Components **[Documented]**: policy inputs (variables, default `change_request` reference input; normal policy adds boolean `manager_approved`), decisions (ordered, condition over inputs, answer = approval definition), approval definitions. Execution mode: `first_match` (lowest order wins) or `all_matches`. An approval definition is applied at most once even if several decisions point to it.

Approval definition fields **[Documented]** (names **[Inferred]**):

| Field | Values |
|---|---|
| `approval_action` | `approve` (auto-approved record for `user`), `reject` (auto-rejected record), `user` (approval for one user), `group` (approvals for group members) |
| `mandatory` | policy waits for this definition's outcome |
| `approver_source` | `definition` (fixed user/group) or `change_request` (field on the change, e.g. `assignment_group.manager`) |
| `wait_for` | `first_response`, `all_responses`, `percentage` |
| `percentage` | empty or <= 0: first response; >= 100: all; else that share, rounded half up (2.49 to 2, 2.5 to 3) |

Policy result **[Documented]**: Approved when all mandatory definitions are satisfied; Rejected on any rejection; Skipped when no decision matches or no approval could be generated (treated as Approved if the caller has no Skipped branch); Canceled; Error. The flow action "Apply Change Approval Policy" takes a policy, the change, and a due-date behavior (none, approve, reject or cancel on due date). Work-note messages written by DevOps policies are fixed strings plus policy name and action label. **[Documented]**

Base policies to seed: "Normal Change Policy" (Assess: assignment group; Authorize: CAB or manager by risk, using `manager_approved`), "Emergency Change Policy" (Authorize: CAB). **[Inferred]** (names), behavior from 4.2.

E-signature for approvals is optional (change_request and std_change_proposal supported). ResolvrNow: out of scope v1. **[Documented]** feature.

Sources: .../t_ProcessAChangeRequest.html, .../t_UpdateWorkflow.html, .../change-approval-policy.html, .../create-approval-definitions.html, .../create-change-policy.html, .../create-policy-input.html, .../create-decisions.html, .../change-approval-policiy-wf-activity.html, .../use-apply-change-approval-policy-flow-activity.html, .../change-approval-policy-decision-builder.html, .../approval-e-signature-changes.html, .../change-flow-actions.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 5. CAB (Change Advisory Board)

### 5.1 Fields on the change

`cab_required` (default false), `cab_date` (date), `cab_date_time`, `cab_delegate` (user with itil or sn_change_read), `cab_recommendation` (4000). CAB fields are shown for normal and emergency changes from Authorize onward. When a change is added as an agenda item, `cab_date` (and `cab_date_time`) take the meeting start time. **[Documented]**

### 5.2 CAB tables

| Table | Key fields | Prov. |
|---|---|---|
| `cab_definition` (recurring series, schedule-based) | name, manager, delegates, board_members, board_groups, rolling_window (days), cab_type, time_zone, locations, active, conference_details, use_filter_dates, notification_lead_time, auto_add_agenda_decisions, auto_add_changes, change_condition (with sort), time_per_agenda_item, complete_preapproved, related_schedules; schedule entries | Documented fields; names Inferred |
| `cab_meeting` (one occurrence) | name, cab_definition, manager, delegates, board_groups, board_members, state, start, end, meeting_notes, locations, conference_details, changes_start_after, changes_start_on_or_before, use_filter_dates, complete_preapproved, time_per_agenda_item, notification_lead_time, auto_add_agenda_decisions | Documented fields |
| `cab_agenda_item` | meeting, task (change_request or std_change_proposal), order, notification_recipients, short_description, state, decision, allotted_time, elapsed_time | Documented |
| `cab_attendee` | meeting, attendee, attendee_type (manager, delegate, board_member, requester), response (accept, tentative, decline, no_response), connected | Documented responses; rest Inferred |
| `cab_runtime_state` | meeting, current agenda item, host, timer state | Documented table; fields Inferred |

Meeting states: Pending (default), In Progress, Complete, Canceled; set automatically by Start/End meeting; CAB manager may cancel a future meeting. **[Documented]**

### 5.3 Behaviors

- Refresh CAB Meetings: generate meetings for the rolling window from schedule entries minus related schedules (e.g. holidays). Example: weekly schedule, 28-day window: 3 meetings. Meetings inherit definition criteria. **[Documented]** ResolvrNow window: occurrences whose start lies in [now, now + rolling window days); existing meetings are matched by definition and start time so refresh is idempotent. **[Inferred]**
- Auto agenda: when `auto_add_changes`, Refresh Agenda Items adds active changes matching `change_condition` whose planned start falls in the meeting window (`changes_start_after` < start_date <= `changes_start_on_or_before`, unless `use_filter_dates` delegates the window to the condition). Default window is from this meeting start to the next meeting start. **[Documented]** window fields; default window **[Inferred]**.
- Requesters of added changes are notified; new attendees receive invitations after refresh; "Send meeting request to attendees" resends. **[Documented]**
- Complete pre-approved changes: agenda items for pre-approved (standard) changes start Complete. **[Documented]**
- Workbench actions (manager or hosting delegate): Start meeting, End meeting, Pause, Next (skip), Restore, Promote, Demote, take notes, Share notes (In Progress or Complete only). Approvers on the current item see Approve/Reject with a comment prompt. Decisions are auto-noted when `auto_add_agenda_decisions`: "(CAB Automation) - <number> - <decision> - <manager> - <time> <timezone>". **[Documented]**
- Meeting timer color by elapsed share of meeting duration: 0 to 50% green, 50 to 70% yellow, 75 to 100% orange, over 100% red (ResolvrNow treats 70 to 75% as yellow). **[Documented]** thresholds; gap handling **[Inferred]**.
- Calendar in the workbench: day/week/month, blackout and maintenance windows, related changes by same assignee, group or CI. **[Documented]**
- Property `sn_change_cab.com.snc.change_management.cab.use_sow_meeting` chooses workspace or classic workbench. ResolvrNow has only the workspace. **[Documented]**

Sources: .../cab-workbench.html, .../define-your-cab.html, .../create-a-cab-meeting.html, .../view-cab-meeting-details.html, .../refresh-cab-meeting-agenda-items.html, .../send-cab-meeting-request-attendees.html, .../attend-cab-meeting-using-cab-workbench.html, .../add-new-agenda-items.html, .../manage-cab-meeting-using-cab-workbench.html, .../instlled-with-cab-wrkbench.html, .../domain-separation-change-mgt.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 6. Risk and impact

### 6.1 Values

| Field | Value: label | Prov. |
|---|---|---|
| `risk` | 1: Very High, 2: High, 3: Moderate, 4: Low, empty: None | 3 and 4 Documented (API samples); 1 and 2 Inferred; High/Moderate/Low as user choices Documented |
| `impact` | 1: 1 - High, 2: 2 - Medium, 3: 3 - Low (default 3) | Documented |
| `urgency` | 1: 1 - High, 2: 2 - Medium, 3: 3 - Low (default 3) | Documented |
| `priority` | 1: 1 - Critical, 2: 2 - High, 3: 3 - Moderate, 4: 4 - Low (default 4); 5: 5 - Planning inherited from task | 1 to 4 Documented; 5 Inferred |

"Highest risk" means the lowest non-empty numeric risk value. Priority on change is user-set (no impact x urgency calculation by default). **[Inferred]**

### 6.2 Risk calculator (risk conditions)

Property `glide.ui.risk_calculate_rule` **[Documented]**:
- `ui_action` (default): related link "Calculate Risk" shown only to admin/itil when at least one active condition matches; each applied rule shows the new values.
- `business_rule`: evaluate before insert/update, except while a risk assessment is attached to the change (completing an assessment needs a human).
- `none`: disabled.

`risk_conditions` evaluation **[Documented]**: active rules sorted by `order` ascending; the first matching rule wins and the rest are ignored. A rule has a condition (condition builder, keyword search not supported) or an advanced script that sets `answer` true/false; outputs are fixed `risk` and/or `impact` values, or a "script values" script that sets both. Inactivate rather than delete base rules.

Seed rules (ResolvrNow) **[Inferred]** from documented examples and names:

| Order | Name | Condition | Sets |
|---|---|---|---|
| 100 | Insufficient lead time (Normal) | model is Normal and start_date < now + 7 days | risk 2 (High) |
| 110 | Insufficient lead time (Standard) | model is Standard and start_date < now + 3 days | risk 3 (Moderate) |
| 200 | Critical service affected | cmdb_ci is a service with business criticality 1 or 2 | risk 2, impact 1 |
| 900 | DevOps risk (inactive) | committer risk score based | inactive by default |

### 6.3 Risk assessment (questionnaire)

- `change_risk_asmt`: name, state (`draft`, `published`), description, condition (which changes get it; first matching published assessment is attached). One category per assessment recommended. **[Documented]**
- Questions (ResolvrNow `change_risk_asmt_question`, replacing the asmt metric category and metric tables): question, order, mandatory, active, weight, answer options with numeric values, depends_on. **[Inferred]** ResolvrNow simplification of the assessment framework.
- Thresholds `change_risk_asmt_threshold`: assessment, risk, `score_greater_than`. **[Documented]**
- Score = sum(answer value x question weight x category weight). Resulting risk = the risk of the threshold with the largest `score_greater_than` strictly below the score (example: score 7, Moderate threshold 6: Moderate). **[Documented]** formula; tie handling **[Inferred]**.
- The "Risk Assessment" related link appears only for normal or emergency changes in New, Assess or Authorize that match an assessment. Re-opening asks whether to edit the existing answers. After submit the form shows: assessment result, risk condition applied, final risk. **[Documented]**

### 6.4 Combining methods

All active engines run (risk conditions, risk assessment, calculated risk score); the highest risk wins and is written to `risk`; `impact` comes from the winning risk condition when it sets one. Users can still override manually. **[Documented]** The "Calculated Risk Score" engine looks up `sn_chg_probability_risk_lookup` (impact x success probability band High/Medium/Low, nine default rows, duplicates blocked) where the band comes from success probability definitions (change model success, change success score, or calculated combination). ResolvrNow v1 ships the lookup with the default matrix in `constants.riskMatrix` and computes model success as the share of closed changes of that model with close code `successful` over 90 days (High >= 90%, Medium >= 70%, else Low). **[Documented]** lookup concept; matrix and thresholds **[Inferred]**.

REST: `PATCH /api/sn_chg_rest/change/{sys_id}/risk` runs the same evaluation. **[Documented]**

Sources: .../change-risk-conflict-analysis.html, .../r_ChangeRiskCalculator.html, .../define-risk-and-impact-conditions.html, .../c_RskAsmtCalc.html, .../t_DefineARiskAssessment.html, .../t_AssessRisk.html, .../migrated-risk-assessment-components.html, .../risk-lookup.html, .../success-probability-definition.html, .../installed-with-change-risk-calc.html, .../r_ChangeManagementProperties.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 7. Conflict detection

### 7.1 Preconditions and triggers

- Needs `cmdb_ci` (or affected CIs in advanced mode), `start_date` and `end_date`; skipped when `exclude_from_conflict_detection` is true (such changes are also never reported as conflicting). Inactive changes are never conflicting. **[Documented]**
- Triggers **[Documented]**: save that changes `cmdb_ci`, `start_date`, `end_date` or `state` (property `change.conflict.refresh.conflicts`); manual "Check Conflicts" (Conflicts tab, roles in `change.conflict.role`); REST POST conflict; scheduled checker jobs: "< 1 Week Away" daily, "< 1 Month Away" every 2 days, ">= 1 Month Away" every 7 days. If any model state has `allow_conflict_detection`, automatic runs happen only in those states. A new change inside an enforced lockdown is placed on hold on submit regardless of state.
- Execution: asynchronous job tracked in `chg_mgt_worker` (ResolvrNow) instead of the flow or progress worker choice (`change.conflict.useprogressworker`). Cancel clears results and sets status "Not Run"; it does not stop future automatic runs. **[Documented]** cancel semantics; worker usage **[Inferred]**.

### 7.2 Checks and conflict types

| Check (property gate) | Conflict type label | Value | Prov. |
|---|---|---|---|
| Another active change on the same CI overlaps (`change.conflict.currentci`) | CI Already Scheduled | `ci_already_scheduled` | label Documented, value Inferred |
| Change on a parent CI overlaps (mode advanced or relationship walk) | Parent CI Already Scheduled | `parent_ci_already_scheduled` | label Documented |
| Change on a child CI overlaps | Child CI Already Scheduled | `child_ci_already_scheduled` | label Documented |
| Window not inside an applicable maintenance window (`currentwindow`, `ci_maint_sched`) | Not In Maintenance Window | `not_in_maintenance_window` | Documented |
| Parent CI maintenance window (`relatedparentwindow`) | Parent Not In Maintenance Window | `parent_not_in_maintenance_window` | label Documented |
| Child CI maintenance window (`relatedchildwindow`) | Child Not In Maintenance Window | `child_not_in_maintenance_window` | label Documented |
| Inside a blackout for CI, parent or child (`blackout`, `relatedparentblackout`, `relatedchildblackout`) | Blackout | `blackout` (related_configuration_item set for parent/child) | label Documented |
| Assignee already scheduled on another overlapping change (`assigned_to`) | Assigned To Already Scheduled | `assigned_to_already_scheduled` | check Documented; label Inferred |
| Inside an enforced lockdown (`lockdown`) | Inside Change Lockdown | `inside_change_lockdown` | label Documented |
| Related application services affected (`relatedservices`) | (as above, on service CIs) | n/a | Documented |
| Information schedules (`information`, related parent/child variants) | none (display only, no conflict rows) | n/a | Documented |

Rules **[Documented]** unless marked:
- Mode `basic`: compare this change's CI with other changes' CI and affected CIs. Mode `advanced`: compare this change's CI and affected CIs with the other changes' CI and affected CIs. Upgrades default to basic.
- Parent/child relations come from CMDB relationships (`cmdb_rel_ci`); a schedule on an upstream service covers downstream CIs. Dynamic CI groups act as parent of their members.
- `change.conflict.allow_contiguous_changes` (default true): touching windows (end == other start) do not overlap. Overlap test: `a.start < b.end && b.start < a.end`. **[Inferred]** formula.
- `change.conflict.consolidated_conflicts` (default true): one row per (type, schedule) or (type, conflicting change).
- `change.conflict.max_count`: cap per type, minimum 1000.
- Maintenance check: the planned window must lie entirely inside one span of an applicable maintenance schedule; when no maintenance schedule applies there is no conflict. **[Inferred]**
- `outside_maintenance_schedule` is system-set: true when the primary CI or an affected CI fails its maintenance schedule (parents/children not considered); user edits are ignored; a warning per item is shown on save.
- `change.conflict.populateimpactedcis`: add services of conflicting CIs to impacted services; `identifymostcritical`: flag the most critical affected service.

### 7.3 Schedules

All three types extend `cmn_schedule_condition` (extends `cmn_schedule`) and share: name, description, time_zone (Floating = evaluate in the viewer's zone), `source` (`service`, `change_request`, `ci_class`), `applies_to` (CI class, only for ci_class; may be a dynamic CI group), `condition` (on CIs, or on change requests for source change_request; dot-walked fields are not evaluated), `category`, `assignment_group`, `assigned_to`; spans in `cmn_schedule_span`; child schedules refine coverage. Deleting a schedule deletes its spans and children. **[Documented]**

| Type | Table | Conflict when | Categories | Prov. |
|---|---|---|---|---|
| Maintenance | `cmn_schedule_maintenance` | change outside window | Preventive, Patching, General | Documented |
| Blackout | `cmn_schedule_blackout` | change inside window | Hard Freeze, Soft Freeze | Documented |
| Information | `cmn_schedule_information` | never | Holiday, Global event, Organisational event | Documented |

A CI can also point to a plain `cmn_schedule` of type `maintenance` through `cmdb_ci.maintenance_schedule` (gate `change.conflict.ci_maint_sched`); this suits small CI sets, while condition schedules suit broad sets. Conflict rows copy the schedule category. **[Documented]**

### 7.4 Results

- `conflict` rows (ResolvrNow columns: `change`, `conflicting_change`, `configuration_item`, `related_configuration_item`, `schedule`, `type`, `category`, `last_checked`); each run replaces the previous rows of the change. **[Documented]** concept and `change`/`type`; other names **[Inferred]**.
- `conflict_status`: `Not Run` (default, also after cancel), `Conflict`, `No Conflict`; `conflict_last_run` = run time. **[Documented]**
- `change.conflict.show_conflict_message`: `user_preference` (default), `always`, `never`. **[Documented]**

### 7.5 Scheduling assistant (next available slot)

Search forward from the planned start (or a given start, or now) for up to `change.conflict.next_available.schedule_window` days (90) and return up to `change.conflict.next_available.choice_limit` (100) slots of the requested duration that produce no blocking conflict for the CI. Enforced lockdown periods are excluded. Choosing a slot rewrites `start_date`/`end_date`. If none: message "No slots found for <n> days from now". **[Documented]**

Sources: .../c_ConflictDetection.html, .../configure-conflict-properties.html, .../t_CreateBlkoutMaintSched.html, .../use-maintenance-schedule-management.html, .../schedule-types-conflict-detection.html, .../create-information-schedule.html, .../schedule-categories-reference.html, .../monitor-maintenance-schedule.html, .../change-conflict-calendar.html, .../use-conflict-calendar.html, .../t_RunAutomatedConflictDetection.html, .../t_RunManualConflictDetection.html, .../configuring-maintenance-schedules-best-practices.html, .../r_InstlldWthConfDetection.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 8. Change lockdown

Purpose: change managers pause all or part of in-flight changes during critical events. **[Documented]**

- Fields: name, description, time_zone (default Floating), `filter_by_ci` (shows CI condition), `source`, `applies_to` (default `cmdb_ci`), `condition` (CI condition), `change_condition`, `assignment_group`/`assigned_to` (approvers), `state` (read-only). Schedule entries define the period; at least one entry is required before Preview. **[Documented]** (physical names **[Inferred]**)
- States and actions **[Documented]**:

| State | Actions | Holds changes |
|---|---|---|
| Draft | Preview, Update, Request Approval, Delete | no |
| Awaiting Approval | Preview, Revert to Draft, Cancel Lockdown, Delete | no |
| Enforced | Cancel Lockdown, Delete | yes |
| Cancelled | Delete | no (terminal, not reusable) |

- Request Approval creates approvals for the assignment group or user; approval moves to Enforced, rejection back to Draft; Revert to Draft marks the approval not required. **[Documented]**
- On Enforced: matching changes (planned window overlapping a span, change condition true, CI condition when filtered) are written to `chg_lockdown_change` and get `on_hold=true` with `on_hold_reason` naming the lockdown. Cancel after enforcement releases them, except changes that were already on hold for another reason. **[Documented]**
- Preview lists number, short description, model, type, state, planned start/end, capped by `com.snc.change_management.lockdown.preview.max_changes` (1000); the cap affects the preview only. **[Documented]**
- Conflict detection reports "Inside Change Lockdown" and holds the change; rescheduling outside the period removes the conflict and clears the reason. **[Documented]**

Sources: .../change-lockdown.html, .../create-change-lockdown.html, .../manage-change-lockdown.html, .../set-lockdown-preview-maximum.html, .../change-lockdown-states.html, .../lockdown-conflict-detection.html, .../limit-conflict-detection-state.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 9. Planned versus actual dates

| Concept | Column | Rules | Prov. |
|---|---|---|---|
| Planned start / end | `start_date` / `end_date` | Required for conflict detection and scheduling; end must be after start (ResolvrNow aborts otherwise) | Documented use; validation Inferred |
| Actual start / end | `work_start` / `work_end` | Entered during Implement as work begins and ends (normal, emergency). ResolvrNow defaults `work_start` on entry to Implement and `work_end` on entry to Review when empty | Documented manual entry; defaults Inferred |
| Requested by date | `requested_by_date` | Informational | Documented |
| Change task planned dates | `change_task.planned_start_date` / `planned_end_date` | Implementation tasks must lie within the change's planned window | Documented |

Standard changes hide some schedule fields because they are pre-approved. **[Documented]**

## 10. Change tasks

Columns (beyond task): `change_request` (also mirrored in `parent`), `change_task_type`, `planned_start_date`, `planned_end_date`, `on_hold`, `on_hold_reason`, `created_from` (`manual` default, `workflow`), `close_code`; inherits assignment, CI, descriptions, `close_notes`, `work_start`/`work_end`. **[Documented]** concepts; physical names of type/planned columns **[Inferred]**.

| State value | Label | Meaning | Prov. |
|---|---|---|---|
| -5 | Pending | Waiting for a predecessor or start time | label Documented, value Inferred |
| 1 | Open | Ready, not started (default for manual tasks) | label Documented, value Inferred |
| 2 | In Progress | Being worked | label Documented, value Inferred |
| 3 | Closed | Done; requires close_code and close_notes | label Documented, value Inferred |
| 4 | Canceled | Not required | label Documented, value Inferred |

Types: `planning`, `implementation`, `testing`, `review` (labels Documented, values Inferred). Flow-generated tasks default to Planning. **[Documented]**

Rules:
- Closed and Canceled are terminal; a submitted closed task cannot go back to Open or In Progress. Close codes are per task. **[Documented]**
- Entering Implement creates two flow tasks: "Implement" (type implementation) and "Post-implementation testing" (type testing), `created_from=workflow`, editable and cancelable; canceling them does not affect the change. **[Documented]** (types **[Inferred]**)
- Moving to Review cancels open flow-created tasks; manually created tasks are not touched. **[Documented]**
- The change cannot close while any change task is active (message about open change tasks). Canceling the change cancels all active tasks. **[Documented]**
- On hold sync with the parent: section 3.6. **[Documented]**
- New task notifies `assigned_to`. Existing tasks can be re-parented by editing `change_request`; the New button never attaches an existing task. **[Documented]**
- Approval engine for change tasks: `glide.approval_engine.change_task` = `process_guide`. ResolvrNow: change tasks have no approvals in v1. **[Documented]** property; scope **[Inferred]**.
- Multiple dates option (UI only): create N copies per selected date ("Number of copies"). **[Documented]**

Sources: .../create-a-change-task.html, .../t_ProcessAChangeRequest.html, .../t_PlaceAChangeRequestOnHold.html, .../copy-a-change-request.html, .../r_ChangeManagementProperties.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 11. Close codes and post-implementation review

| `close_code` value | Label | Prov. |
|---|---|---|
| `successful` | Successful | Documented |
| `successful_issues` | Successful with issues | Documented |
| `unsuccessful` | Unsuccessful | Documented |

- Close requires `close_code` and `close_notes` (state field policy on Closed) and no active change tasks. `closed_at`/`closed_by` are set; `active` becomes false. **[Documented]** (closed_at/by **[Inferred]** from task semantics)
- Review state: the requester evaluates success; `review_comments`, `review_date`, `review_status` capture the post-implementation review (PIR). ResolvrNow sets `review_date` on entry to Review if empty. **[Documented]** columns; automation **[Inferred]**.
- Close codes feed change success score (successful x3, successful with issues x-2, unsuccessful x-5; P1/P2/P3 incidents caused by change x-10/-5/-2) and standard template success rates. **[Documented]**

## 12. Standard changes (catalog, proposals, templates)

### 12.1 Model

| Table | Role | Prov. |
|---|---|---|
| `std_change_properties` | Single settings record: catalog, category, two-step, mandatory / default / restricted / read-only / fields-to-copy lists for change and change task values | Documented |
| `std_change_proposal` | Proposal to create, modify or retire a template (task-like: number, state, approvals, attachments, sample change requests) | Documented |
| `std_change_record_producer` | Published template (catalog item, sometimes called the standard change producer) offered in the Standard Change Catalog; carries the change field values | Documented |
| `std_change_producer_version` | Template version: producer, proposal, version, counts and percentages of successful and unsuccessful changes created from it | Documented |
| `std_change_template` | Template value holder | Documented (purpose Inferred) |
| `std_change_task_template` | Change task templates on a proposal (name, order, short description, task values) | Inferred name; feature Documented |

### 12.2 Proposal lifecycle

| Step | Effect | Prov. |
|---|---|---|
| Propose (form, or "Propose a Standard Change Template" from an existing change copying configured change and task fields) | Proposal in New; task templates may be added only while New | Documented |
| Request Approval | State In Progress; approvals for Change Management group members (or model approvers) | Documented |
| Approved | Template published (new producer or new version); Change Management group notified | Documented |
| Rejected | Proposal back to New | Documented |
| Modify Template | Proposal of kind modify; on approval a new version; only later changes use it | Documented |
| Retire Template | Proposal of kind retire with justification; on approval template inactive | Documented |

Proposal states (ResolvrNow): 1 New, 2 In Progress, 3 Closed Complete (approved), 4 Closed Incomplete (canceled). Kind: 1 New, 2 Modify, 3 Retire. **[Inferred]**

### 12.3 Creating a standard change

- From the catalog (categories filtered by user criteria; itil can view). If `two_step` is true (default on new instances) the requester sees a pre-filled change and must Submit; else the record is inserted on selection. **[Documented]**
- The change gets template values, `type=standard`, Standard model, `std_change_producer_version`; read-only fields keep template values; attachments of the proposal and template are copied; task templates create change tasks ordered by `order`. **[Documented]**
- Standard changes cannot be copied (Copy Change hidden) and mass CI update is not available. **[Documented]**
- REST create from template: description, backout_plan, test_plan and implementation_plan cannot be overridden. **[Documented]**

Sources: .../c_StandardChangeCatalogPlugin.html, .../t_ConfigureTheStandardChangeCatalog.html, .../create-a-standard-change-task-template.html, .../propose-standard-chg-template.html, .../attach-files-change-templates.html, .../manage-standard-change-template.html, .../t_RaiseNewStdCngeFmTempl.html, .../r_InstlldWthStdChgCat.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 13. Change templates (enhanced data model)

Independent of the standard catalog; usable for any model. **[Documented]**

- `chg_template`: name, short_description, `chg_model`, active, `state`, template field values, `previous_template`, categories (hierarchical `chg_template_category` with parent and order), field policies (mandatory, read-only), child task templates, approvers tab, metrics (closed change count). **[Documented]**
- States: Draft, Proposed (Publish; not editable), Published (approved; immediately usable if active; also when no approvers are configured), Pending Retirement (Retire), Retired. Reject from Proposed returns to Draft; reject of retirement returns to Published. Copy makes a Draft with `previous_template`; "Copy and retire" retires the original when the copy publishes. Only Draft templates are editable. **[Documented]**
- Approvers come from the model's template approval users and groups; proposers are "anyone who can modify" or "anyone who can read" the model. Flows: "STTRM Template Publish Approval", "STTRM Template Retire Approval". **[Documented]**
- Field effect at creation: template field policies combine with state field policies (mandatory or read-only if either says so). **[Documented]**

Sources: .../change-templates.html, .../change-data-model.html, .../create-change-template.html, .../configure-template-categories.html, .../modify-or-retire-template.html, .../review-change-template.html, .../retire-a-change-template.html, .../change-template-management-flows.html, .../create-a-change-request-template.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 14. Emergency and unauthorized changes

Emergency: see sections 2 and 3. Only emergency changes show the `unauthorized` checkbox on the form. **[Documented]**

Unauthorized change (ResolvrNow implements the change side; detection is out of scope):
- Trigger: event `ci.change.unplanned` raised when a monitored CI changes outside a valid change. Processing is enabled by the unauthorized properties ("Enable event processing", default false; also `com.snc.change_request.enable_unauthorized`, default false). **[Documented]**
- Checks before creating: CI class is included; CI part of an application service; no unauthorized change for this CI within the notification ignore period (default 1 day); no change matches the configured valid-change query (e.g. active changes in Implement or Review for that CI). **[Documented]** ResolvrNow exposes `POST` of the event through its event API. **[Inferred]**
- Created record: type emergency, model Unauthorized Change, `unauthorized=true`, state Review, assignment group "Change Management", `cmdb_ci` = the CI, description listing changed CI fields and new values. Notification to the assignment group and the CI's managed_by, owned_by, assigned_to. **[Documented]**
- Flow: Request Approval to Authorize; on approval back to Review and a change task "Post Implementation Review" for the Change Management group (ResolvrNow type `review`). **[Documented]** (task type **[Inferred]**)
- Clearing the flag: a change_manager may clear it (reason in work notes), turning it into a regular emergency change; an itil user clears it by creating an outage of type Outage or Degradation from the change. Without an outage the flow goes Authorize to Review, skipping Scheduled and Implement. **[Documented]**

Sources: .../unauthorized-change-request.html, .../unauth-change-properties.html, .../disable-unauth-notification.html, .../change-types.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 15. Affected CIs, impacted services, copy, creation entry points

- Affected CIs (`task_ci`: task, ci_item, manual_proposed_change) and Impacted Services/CIs (`task_cmdb_ci_service`: task, cmdb_ci_service, manually_added) are many-to-many with `cmdb_ci`. Multiple CI association is enabled for task tables listed in `com.snc.task.associate_ci` (default `change_request,incident`). **[Documented]**
- Affected CIs can be added after New even when the primary CI is locked. Adding a dynamic CI group adds its members; removing it removes them. **[Documented]**
- Refresh Impacted Services (UI action, REST, automatically when leaving New, and from conflict detection when `change.conflict.populateimpactedcis`): rebuild non-manual rows from affected CIs (`com.snc.change_request.refresh_impacted.include_affected_cis` true: all affected CIs through service associations; false: primary CI through CMDB traversal), optionally service offerings and business applications. Manually added rows survive. **[Documented]**
- From a CI list: "Add to existing Change Request" / "Add to new Change Request"; service-class CIs go to impacted services, others to affected CIs. **[Documented]**
- From incident or problem: "Create Normal Change", "Create Standard Change", "Create Emergency Change" copy short_description, description, cmdb_ci, priority, company and link the source (incident `rfc`, problem link). **[Documented]** (link field **[Inferred]** as `rfc`)
- Related lists: Incidents Fixed by Change (`incident.rfc`), Incidents Caused by Change (`incident.caused_by`), Problems, Approvers, Change Tasks, CAB Agenda Items (hidden when empty), Affected CIs, Impacted Services/CIs, Service Offerings, Conflicts, Outages. **[Documented]** names; join fields **[Inferred]**.
- Copy Change (`com.snc.change_request.enable_copy`, default true): form only, not for standard changes, from active or canceled changes. Copies `com.snc.change_request.copy.attributes`; related lists in `...copy.related_lists` with their attribute lists; manual change tasks only (`created_from=manual`); attachments when enabled; sets `copied_from`; all other fields default. **[Documented]**

Sources: .../c_AffectedCIsAndImpactedServices.html, .../refresh-impacted-services-cis.html, .../refreshing-impacted-services-properties.html, .../t_CreateAChangeFromACI.html, .../copy-a-change-request.html, .../configure-copy-change-request.html, .../t_ExtendMultipleCIAssociation.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/); https://www.servicenow.com/docs/r/it-service-management/incident-management/t_PromoteAnIncident.html

## 16. UI actions

Visibility pattern for state buttons: user has itil (or sn_change_write) and the target is a valid next state of the model (`isNext`), or valid and all conditions pass (`canMoveTo`). ResolvrNow action names follow `state_model_move_to_<state>`. **[Documented]** pattern (tutorial).

| Action | Where / when | Effect | Prov. |
|---|---|---|---|
| Request Approval | Form, state New, not on hold | normal: Assess; emergency: Authorize; standard: Scheduled; unauthorized (in Review): Authorize | Documented |
| Implement | Scheduled | to Implement; creates implementation and testing tasks | Documented |
| Review | Implement | to Review; cancels open flow tasks | Documented |
| Close | Review | to Closed; needs close fields, no active tasks | Documented |
| Cancel Change | Context menu, any state except Review/Closed/Canceled | reason prompt, to Canceled | Documented |
| Revert to New | Context menu; normal in Assess, emergency in Authorize | to New, approvals canceled | Documented |
| Check Conflicts | Conflicts tab (needs CI, dates, not excluded) | start conflict job; dialog with progress and Cancel | Documented |
| Conflict Calendar / Scheduling Assistant | Header, after CI and dates saved | slot picker | Documented |
| Calculate Risk | Related link (ui_action mode, admin/itil, matching rule exists) | apply first matching risk condition | Documented |
| Risk Assessment | Related link (normal/emergency, New/Assess/Authorize, matching assessment) | open questionnaire | Documented |
| Edit Risk Conditions | Context menu | open risk_conditions | Documented |
| Copy Change | Form, enable_copy, not standard | prefilled new change | Documented |
| Propose a Standard Change Template | Context menu | new proposal from this change | Documented |
| Refresh Impacted Services | Context menu | rebuild impacted lists | Documented |
| View Calendar | Header | change schedule calendar | Documented |
| Show Flows | Form | running flows of the change | Documented |
| Place on hold | `on_hold` checkbox with reason | section 3.6 | Documented |
| Approve / Reject | Approval record, CAB workbench | approval outcome | Documented |

## 17. Notifications and events

| Name | Trigger | Recipients | Prov. |
|---|---|---|---|
| Change request state change | state becomes Scheduled, Implement, Review or Canceled | `requested_by`, never the user who made the update | Documented |
| Approval request | `sysapproval_approver` inserted with state requested | approver | Inferred (platform) |
| Change task assigned | change_task inserted or reassigned with `assigned_to` | assigned_to | Documented |
| Unauthorized change created | unauthorized change insert | assignment group, CI managed_by, owned_by, assigned_to | Documented |
| CAB meeting invitation / agenda | meeting refresh or manual send; change added to agenda | attendees; change requester | Documented |
| CAB notes shared | Share notes | attendees | Documented |
| Standard proposal decision | proposal approved or rejected | Change Management group members | Documented |
| Lockdown approval | Request Approval on lockdown | assignment group or user | Documented |

Events: `sn_change.state.updated` (when `com.snc.change_request.event.state_updated.enabled`, filtered by `...state_updated.states`, empty = all), `change_model.evaluate` (param: change sys_id), `ci.change.unplanned`. **[Documented]** ResolvrNow also emits `change_request.inserted` / `change_request.updated` per platform conventions. **[Inferred]**

Sources: .../configure-state-change-notifications.html, .../r_ChangeManagementProperties.html, .../attach-process-change-model.html, .../unauthorized-change-request.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 18. Roles and access

| Role | Purpose | Contains | Prov. |
|---|---|---|---|
| `itil` | Create, update, process changes and tasks; view standard templates; propose | n/a | Documented |
| `change_manager` | Models, templates, approval policies, lockdowns, unauthorized flag, exclude from conflicts | n/a | Documented |
| `sn_change_read` | Read all changes and the CAB workbench | sn_cmdb_user, dependency_views, view_changer, cmdb_read, app_service_user, cmdb_query_builder_read | Documented |
| `sn_change_write` | Write change records | sn_change_read, template_editor, cmdb_query_builder | Documented |
| `sn_change_admin` | Change properties without global admin | sn_change_write, sn_change_cab.cab_manager, change_manager | Documented |
| `sn_change_cab.cab_manager` | CAB definitions and meetings | n/a | Documented |
| `approval_user` / `approver_user` | Act on approval records only | n/a | Documented |
| `business_stakeholder` | Read and approve across ITSM | sn_change_read, approver roles | Documented |
| `change_model_script_admin` | Edit scripted transition conditions | n/a (assign directly) | Documented |
| `sn_chg_soc.change_soc_admin` | Administer change schedules | n/a | Documented |
| `itil_admin` | Risk conditions, assessments, schedules | n/a | Documented |
| `sn_service_desk_agent` | Tier 1 agent | sn_change_write and other writes | Documented |

ACL notes: `change_request.type` write only in New with no approvals (section 3.5); `exclude_from_conflict_detection` and `unauthorized` write: change_manager; REST: DELETE change_manager/admin, GET change_manager/itil/sn_change_read/admin, PATCH/POST change_manager/itil/admin. Model read restricted by `com.snc.change_management.change_model.default_read_roles` and model read/write roles. **[Documented]** (exclude/unauthorized ACL **[Inferred]** from role statements)

Sources: .../installed-with-cm-itsm-roles.html, .../installed-with-business-stakeholder-change.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/); API roles in https://www.servicenow.com/docs/r/api-reference/rest-apis/change-management-api.html

## 19. Properties

Full list with defaults in `data/change.json` (`constants.properties`). Highlights **[Documented]**:

| Property | Default | Use |
|---|---|---|
| `glide.ui.risk_calculate_rule` | `ui_action` | risk engine mode |
| `com.snc.change_management.enforce_data_requirements` | true | server-side policies on all write paths |
| `com.snc.change_management.change_model.type_compatibility` | false | allow type-only changes |
| `com.snc.change_request.enable_copy` / `...attach.enable_copy` | true / true | copy change |
| `com.snc.change_request.copy.attributes` | category,cmdb_ci,priority,risk,impact,type,assignment_group,assigned_to,short_description,description,change_plan,backout_plan,test_plan | copied fields |
| `com.snc.change_request.copy.related_lists` | task_ci,task_cmdb_ci_service,change_task | copied lists |
| `com.snc.change_request.enable_unauthorized` | false | unauthorized changes |
| `com.snc.change_request.event.state_updated.enabled` / `.states` | false / empty | state event |
| `change.conflict.mode` | basic | conflict scope |
| `change.conflict.next_available.schedule_window` / `.choice_limit` | 90 / 100 | assistant |
| `change.conflict.allow_contiguous_changes` / `consolidated_conflicts` / `lockdown` / `information` | true each | conflict behavior |
| `change.conflict.max_count` | 1000 (minimum) | cap |
| `com.snc.change_management.lockdown.preview.max_changes` | 1000 | lockdown preview |
| `sn_chg_soc.change_soc_initial_limit` / `scroll_load_limit` / `total_limit` / `schedule_window_days` | 40 / 20 / 1000 / 30 | calendar |

## 20. Change schedule calendar (ResolvrNow UI)

- Definitions (`chg_soc_definition`): name, active, start/end date fields (must differ, insert aborts otherwise), condition with sort, record summary left/right columns, show blackout and maintenance with colors, sharing (everyone, users, groups, roles), owner, owner group. Related definitions (`chg_soc_definition_child`) add related records such as change tasks (table, reference field, start/end fields, condition). Style rules: default, per definition, per related definition (all extend `chg_soc_style_rule_core`). **[Documented]**
- Default styles: risk High red, Moderate orange, Low green; blackout gray; maintenance light blue. **[Documented]**
- Windows shown only for the primary CI, within `sn_chg_soc.schedule_window_days` before and after each change. Loading: initial 40 changes, 20 per scroll, 1000 total. Landing page tabs: Pinned, Your Schedules, All Schedules. Non-owners with only itil may create, copy and view, not edit or delete; copying another user's schedule makes the copier the owner. **[Documented]**
- ResolvrNow endpoint for the view: `GET /api/app/change_schedule/{definition}/spans?from=&to=` returning change spans, related spans and window spans (ResolvrNow extension, not ServiceNow compatible). **[Inferred]**

Sources: .../change-schedule.html, .../change-schedules-view.html, .../create-chng-sch-from-chng-sch-def.html, .../add-related-tasks-to-chng-schedule.html, .../style-rules-definition.html, .../installed-cm-changeschedule.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 21. ResolvrNow implementation checklist

Business rules (all **[Inferred]** designs implementing the documented behaviors above):

| # | Name | When | Logic |
|---|---|---|---|
| BR1 | change: defaults and model | before insert | resolve model (2.3), apply preset, initial state, phase defaults, conflict status |
| BR2 | change: validate transition | before update, state changes | 3.3 |
| BR3 | change: state field policies | before insert/update | 2.6 messages |
| BR4 | change: type change guard | before update, type changes | 3.5 |
| BR5 | change: CI modification guard | before update, cmdb_ci changes | 2.5 |
| BR6 | change: assignment from CI/offering | before insert/update, group and assignee empty | CI field from `com.snc.change_request.ci_assignment_group.field_name` (default `support_group`), then offering |
| BR7 | change: risk (business rule mode) | before insert/update | 6.2, skipped when assessment attached |
| BR8 | change: conflict trigger | async after insert/update | 7.1 |
| BR9 | change: on hold sync | after update, on_hold changes | 3.6 |
| BR10 | change: cancel cascade | after update to Canceled | tasks and approvals |
| BR11 | change: close guard | before update to Closed | active tasks check |
| BR12 | change: implement / review entry | after update | task creation, actual dates, cancel flow tasks, refresh impacted services when leaving New |
| BR13 | change: events and notifications | after update | 17 |
| BR14 | change_task: guards | before insert/update | planned window inside change for implementation tasks, close fields, terminal states, number |
| BR15 | change_task: auto review | after update | trigger model evaluation of the parent (Implement to Review when no active tasks) |

Flows (ResolvrNow flow engine): Normal Assess, Normal Authorize, Normal Implement, Standard, Standard Implement, Emergency Authorize, Emergency Implement, Emergency Review, Unauthorized Authorize, Unauthorized Review, Standard Proposal, Template Publish Approval, Template Retire Approval, Lockdown Approval. Names mirror the documented base flows. **[Documented]** names, **[Inferred]** content.

Scheduled jobs: conflict checker (3 cadences), CAB meeting refresh (daily), success score metrics (daily 02:00 UTC, optional), worker processor (every few seconds). **[Documented]** for the first and third.

## 22. Scaled change (brief)

A primary change with many affected CIs generates one child change per CI when it enters a state carrying "Allow Child Change Creation" (via a flow). Children copy short description, category, description, justification, implementation plan, risk and impact analysis, backout plan, test plan and point to the parent via `primary_change`. Parent `child_changes_creation_status`: `in_progress`, `completed`, `completed_with_errors`. Batches tracked by `chg_mgt_worker` (type "Child change requests creation"). Properties: `sn_major_change.affected_ci_threshold` 2000, `...threshold_enforcement_mode` `warning` or `blocking` (invalid value means warning), `...child_change_generation_batch_size` 500. Children archived six months after the parent goes inactive. ResolvrNow: phase 2. **[Documented]**

Sources: .../scaled-change-overview.html, .../installed-with-scaled-change.html (prefix https://www.servicenow.com/docs/r/it-service-management/change-management/)

## 23. Release Management (light)

Plugin `com.snc.release_management_v2`; roles `release_v2_admin` (contains `release_v2_user`), `release_v2_user` (read modules, no updates), `sn_release_read` (business stakeholder read). **[Documented]**

| Table | Purpose | Key fields | Prov. |
|---|---|---|---|
| `rm_product` | Optional product grouping, may link a CI | number, cmdb_ci, assignment_group, assigned_to, short_description, description, work_notes | Documented |
| `rm_release` | Release, may have child releases | number, release type (major, minor, upgrade, patch), priority, state, percent_complete, short_description, description, planned start/end, planned duration (days, computed) | Documented |
| `rm_release_phase` | Phase of a release | priority, state, percent_complete, descriptions, planned dates, duration | Documented |
| `rm_task` | Task under a phase | standard task fields | Documented |
| `rm_m2m_release_task` | Scope: work items and change requests in a release (projects, epics, stories, defects, enhancements, incidents, problems, changes) | release, task | Documented |

State categories **[Documented]**:

| Category | rm_release | rm_task |
|---|---|---|
| pending (default pending) | -5 | -5 |
| open (default open) | 1 | 1 |
| work in progress (default 2) | 2, 4, 10 | 2 |
| completed / default close | 3 | 3 |
| close states | 3, 7 | 3, 4, 7 |
| skipped (default 7) | 4, 7 | 4, 7 |

ResolvrNow labels (Inferred): rm_release -5 Draft, 1 Scoping, 2 Work in Progress, 10 Testing, 4 Deploying, 3 Completed, 7 Canceled; rm_task -5 Pending, 1 Open, 2 Work in Progress, 3 Closed Complete, 4 Closed Incomplete, 7 Closed Skipped. A phase completes when all its tasks close. "Generate change" links scoped work to change requests through `rm_m2m_release_task`. **[Inferred]** labels; linkage concept **[Documented]**.

Sources: https://www.servicenow.com/docs/r/it-service-management/release-management/c_ITILReleaseManagement.html, .../components-installed-with-release-management-v2.html, .../default-state-categories-for-release-and-release-task-tables.html, .../c_Release.html, .../t_DefineARelease.html, .../t_DefineAReleasePhase.html, .../t_ScopeARelease.html, .../business-stakeholder-role-for-release-management.html (prefix https://www.servicenow.com/docs/r/it-service-management/release-management/)

## 24. DevOps Change Velocity (overview)

Concept **[Documented]**: pipeline tools (Jenkins, GitHub Actions, Azure DevOps, GitLab, Harness, others) send events; a pipeline step with change control enabled creates a change request (category `DevOps`) carrying commits, work items, artifact versions, test, quality and security summaries; the pipeline pauses until a decision, then resumes or fails.

Lifecycle **[Documented]**:
- Created change goes to Assess to request approval (when an assignment group is set). Approved (auto or manual): Implement, job runs, then Closed with close code successful or unsuccessful from the job result. Rejected: step execution rejected, change back to New, pipeline terminated. Canceled: pipeline canceled.
- Change receipts: the pipeline does not pause; the change is created in post-implement states (toggle `sn_devops.enable_change_receipt_state_transition`).
- Approval flows (only one active): Manual Approval (default), Minimal Automation, Advanced Automation (approved changes go to Scheduled and move to Implement at their start date). Policies "DevOps Change Request Minimal Automation Policy", "...Advanced Automation Policy", "DevOps Model Change Policy" yield auto approve, auto reject or manual approval from DevOps data (e.g. failed test count). Demo: low risk auto approval when failed tests = 0.
- Configurable states: `sn_devops.change_request.implement_state`, post implement, cancel (4), closed (3); default field values via the Default Change Handler subflow (`sn_devops.change_request_handler_subflow`).
- Integration API (`/api/sn_devops/...`, v2 token header `Authorization: sn_devops.DevOpsToken <tool_sys_id>:<token>`): GET/POST `devops/orchestration/changeControl` (is the task under change control; register callback URL), PUT `devops/orchestration/changeControl/{id}`, GET `devops/orchestration/changeInfo` (change for a pipeline run), PUT `devops/orchestration/changeInfo?changeRequestNumber=` (update fields; cancel only from implement with reason; close from implement or post implement with close code and notes).

Minimal ResolvrNow-compatible implementation **[Inferred]**:
1. Tables `sn_devops_tool` (name, type, token hash), `sn_devops_step` (pipeline, stage name, change_control, template, assignment_group), `sn_devops_callback` (step execution URL, callback URL, change_request, state).
2. Endpoint `POST changeControl`: find step by tool and task name; when change control is on, create a change (model DevOps or Normal, category DevOps, template values, work notes with execution details), store callback, return `{changeControl:true}`.
3. Approval: reuse the change approval policy engine with a policy input carrying pipeline data (failed tests, branch); seed one Minimal Automation policy.
4. On change state Implement (approved) or New (rejected) or Canceled: POST to the callback URL with the decision; close the change on job completion from `changeInfo` PUT.
5. GET `changeInfo` returns number, sys_id, state, type, risk, priority, approvers and planned dates for a pipeline/build/stage.

Sources: https://www.servicenow.com/docs/r/it-service-management/devops-change-velocity/devops-landing-page-new.html, .../dev-ops-landing-page.html, .../dev-ops-change-acceleration.html, .../app-devops.html (prefix https://www.servicenow.com/docs/r/it-service-management/devops-change-velocity/); https://www.servicenow.com/docs/r/api-reference/rest-apis/devops-api.html

## 25. Open questions and uncertainties

1. Risk numeric values: samples show Moderate=3 and Low=4; the API field table says 1 High, 2 Moderate, 3 Low, default 3. ResolvrNow uses 1 Very High, 2 High, 3 Moderate, 4 Low, default empty.
2. `review_status` choices are undocumented; ResolvrNow values are placeholders.
3. Physical names of model engine, lockdown, approval-policy, conflict and template tables and many columns are inferred (only `sttrm_state_transition`, `chg_model`, `chg_template`, `conflict`, `chg_mgt_worker`, `risk_conditions`, `change_risk_asmt*`, `cab_*`, `std_change_*` are documented).
4. Unauthorized change rejection target state and cancel path are undocumented.
5. Change task state numbers and CTASK start number are inferred.
6. Default approval completion rule for CAB groups (first response versus all) is undocumented.
7. Calculated risk matrix contents and success probability bands are only shown as images in the docs.
8. Release state labels beyond the numeric categories are inferred.
9. Conflict type values other than `not_in_maintenance_window` are inferred.
10. Whether the Request Approval on standard changes creates any approval record (ResolvrNow: none).

## 26. Acceptance tests

Setup assumed: models Normal, Standard, Emergency, Unauthorized Change, Change Registration seeded; groups "Network" (manager Mia; members Mia, Bob, Ann), "CAB Approval" (member Carl), "Change Management"; user Uma with itil; CI `web01` (support_group Network).

1. Given Uma creates a change with `chg_model=Normal`, When it is saved, Then number matches `CHG\d{7}` starting at CHG0030000, `type=normal`, `state=-5`, `approval=not requested`, `conflict_status=Not Run`, `phase=requested`.
2. Given a change created with only `type=emergency`, When saved, Then `chg_model` is the model designated for the emergency ITIL process (Emergency).
3. Given a normal change in New without `assignment_group`, When Request Approval is applied, Then the save is rejected with "Mandatory fields must be populated: Assignment group".
4. Given a normal change in New with group Network, When Request Approval, Then state is -4, a group approval for Network exists, and approvals in state `requested` exist for Mia, Bob and Ann.
5. Given a normal change in Assess, When Bob approves, Then remaining Assess approvals become `not_required` and state becomes -3 (Authorize).
6. Given a normal change in Authorize with risk 2 (High), When Authorize approvals are generated, Then one requested approval exists for each member of "CAB Approval".
7. Given a normal change with risk 4 (Low) whose Assess approval was given by Mia (group manager), When it reaches Authorize, Then it moves to Scheduled (-2) without new approvals.
8. Given a normal change in Authorize, When Carl rejects with comments, Then state is -5, `approval=rejected`, other pending approvals are `not_required`, and the comment appears in work notes.
9. Given a normal change in Assess, When Revert to New is executed, Then state is -5, pending approvals are cancelled and `approval=not requested`.
10. Given an emergency change in New with group Network, When Request Approval, Then state is -3 (Assess skipped).
11. Given a standard change created from a published template, When Request Approval, Then state is -2, `approval=approved`, and no `sysapproval_approver` rows exist.
12. Given a change in Review, When a user sets state to 4, Then the update is rejected (cannot cancel from Review).
13. Given a normal change in New, When a user sets state directly to -1 (Implement), Then the update is rejected as an invalid transition.
14. Given a change in Scheduled, When Implement is applied, Then state is -1 and two change tasks exist ("Implement" type implementation, "Post-implementation testing" type testing) with `created_from=workflow`, and `work_start` is set.
15. Given a change in Implement whose only active tasks are flow-created, When Review is applied, Then those tasks are Canceled (4) and the change state is 0.
16. Given a change in Implement with one manual task Open, When Review is applied, Then the manual task remains Open, and closing the change is rejected until the task is closed or canceled.
17. Given a change in Implement whose last active task is closed, When the task closes, Then the model's automatic transition moves the change to Review.
18. Given a change in Review, When Close is applied without `close_code`, Then it is rejected; with `close_code=successful` and `close_notes`, Then state is 3 and `active=false`.
19. Given a change in Assess with pending approvals, When `on_hold=true` with reason "Vendor", Then pending approvals become `not_required`, active tasks get `on_hold=true` and reason "Vendor"; When `on_hold` is cleared, Then those approvals return to `requested` and task holds are cleared.
20. Given an on-hold change in Scheduled, When state is set to -1, Then rejected; When set to 4, Then accepted and `on_hold=false`.
21. Given a canceled change, When it had two active tasks, Then both tasks are Canceled.
22. Given a normal change in Assess with an approval record, When `type` is changed to emergency, Then rejected; Given a rejected change back in New, When type changes normal to emergency, Then accepted.
23. Given a change in Assess (model without `allow_ci_modification`), When `cmdb_ci` changes, Then aborted with "Configuration item cannot change for Change Requests in this state".
24. Given risk conditions order 100 (High) and 200 (Moderate) both matching, When Calculate Risk runs, Then `risk=2` from the order 100 rule only.
25. Given `glide.ui.risk_calculate_rule=business_rule` and a matching condition, When the change is saved, Then risk is set automatically; Given an attached risk assessment, Then the rule does not run.
26. Given an assessment with thresholds High>10, Moderate>6, Low>0, When answers score 7, Then assessment risk is Moderate; combined with a risk condition giving High, Then final `risk=2`.
27. Given two active changes on `web01` with windows 10:00 to 12:00 and 11:00 to 13:00, When conflict detection runs on the first, Then a `conflict` row of type `ci_already_scheduled` referencing the second exists and `conflict_status=Conflict`.
28. Given windows 10:00 to 12:00 and 12:00 to 14:00 and `allow_contiguous_changes=true`, When detection runs, Then no conflict and `conflict_status=No Conflict`.
29. Given a blackout schedule on CI class of `web01` covering the change window, When detection runs, Then a `blackout` conflict referencing the schedule and its category (e.g. Hard Freeze) exists.
30. Given a maintenance schedule applying to `web01` that does not cover the window, When detection runs, Then a `not_in_maintenance_window` conflict exists and `outside_maintenance_schedule=true`.
31. Given an information schedule covering the window, When detection runs, Then no conflict rows are created for it.
32. Given `exclude_from_conflict_detection=true` on change B overlapping change A, When detection runs on A, Then B is not reported.
33. Given a running conflict job, When DELETE conflict is called, Then conflicts are cleared and `conflict_status=Not Run`.
34. Given a lockdown in Draft with a schedule entry, When approved, Then state is Enforced and every matching change has `on_hold=true` and a reason naming the lockdown; When canceled, Then those changes are released except ones held before.
35. Given a change created inside an enforced lockdown window, When submitted, Then it has an `inside_change_lockdown` conflict and `on_hold=true`.
36. Given a CI whose maintenance window is free on Saturdays 08:00 to 11:00, When the scheduling assistant is asked for 3 hours, Then the first slot returned starts Saturday 08:00 and selecting it rewrites `start_date`/`end_date`.
37. Given a standard change proposal in New with two task templates, When approved, Then a published template version exists and a change created from it has those two tasks in template order and `std_change_producer_version` set.
38. Given a published standard change, When Copy Change is requested, Then it is refused.
39. Given an implementation change task with planned dates outside the parent window, When saved, Then it is rejected.
40. Given `ci.change.unplanned` for CI `db01` with event processing enabled and no valid change, When processed, Then an emergency change with `unauthorized=true`, state 0, group Change Management and `cmdb_ci=db01` exists; a second event within 1 day creates nothing.
41. Given that unauthorized change, When Request Approval and approval, Then state returns to 0 and a change task "Post Implementation Review" for Change Management exists.
42. Given a change moving to Scheduled, When saved by Uma who is also `requested_by`, Then no state change email is sent to Uma; if requested by Bob, Then Bob receives it.
43. Given a CAB definition with a weekly Monday 10:00 entry, a related holiday schedule covering the second following Monday, a 28-day rolling window, and now = Monday 12:00, When Refresh CAB Meetings runs, Then meetings exist for the 1st, 3rd and 4th following Mondays only; running it again creates no duplicates.
44. Given a CAB meeting with auto add and a matching change whose planned start is in the meeting window, When agenda is refreshed, Then an agenda item exists, the requester is notified and the change `cab_date` equals the meeting start date.
45. Given model Normal with a transition Implement to Review that has condition "No active Change Tasks" (automatic) and another with "Not On hold" (manual), When GET nextstates is called for a change in Implement with an open task, Then both transitions are listed and only the manual one has `transition_available=true`.
