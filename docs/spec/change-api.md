# Change Management REST API (`sn_chg_rest`): ResolvrNow spec

Companion of `docs/spec/change.md` (behavior) and `docs/spec/data/change.json` (choices and constants).
Primary source: https://www.servicenow.com/docs/r/api-reference/rest-apis/change-management-api.html (Brazil). Examples below are written for ResolvrNow with fictional identifiers.

Legend: **[Documented]** = stated in the API reference; **[Inferred]** = ResolvrNow decision or reconstruction.

## 1. Base URL, versions, formats, roles

| Item | Value | Prov. |
|---|---|---|
| Default URL | `/api/sn_chg_rest/change...` | Documented |
| Versioned URL | `/api/sn_chg_rest/{api_version}/change...`, ResolvrNow serves `v1` and treats the unversioned path as latest (`v1`) | Documented form; version set Inferred |
| Request/response format | JSON (default) or XML via `Accept` / `Content-Type`. ResolvrNow v1 implements JSON; XML returns 406 | Documented / ResolvrNow decision |
| Auth | Same as Table API (basic, OAuth bearer, session) | Inferred (platform) |
| Roles: GET | `change_manager`, `itil`, `sn_change_read`, `admin` | Documented |
| Roles: POST, PATCH | `change_manager`, `itil`, `admin` | Documented |
| Roles: DELETE | `change_manager`, `admin` | Documented |
| Roles: scheduling endpoints | docs say `sn_change_writer`; ResolvrNow accepts `sn_change_write`, `itil`, `change_manager`, `admin` | Documented text (likely typo); ResolvrNow decision |

Record ACLs (read/write per field) still apply after the role gate. **[Inferred]**

## 2. Common behaviors

### 2.1 Record representation

Every field of a returned record is an object:

```json
"state": { "value": -5, "display_value": "New" },
"start_date": { "value": "2026-11-07 15:00:00", "display_value": "2026-11-07 08:00:00", "display_value_internal": "2026-11-07 08:00:00" }
```

- `value`: stored value. ResolvrNow emits integers for integer fields (state, risk, impact, priority, urgency, scope), booleans as JSON booleans, everything else as strings; references are sys_id strings. **[Documented]** samples mix numbers (`-5`, `3.0`) and strings (`"-5"`); ResolvrNow normalizes to integers. **[Inferred]**
- `display_value`: label, reference display value, or date in the caller's time zone. **[Documented]**
- `display_value_internal`: only for date and date-time fields; the caller-zone value in internal format. **[Documented]**
- All valid fields of the table are returned (including inherited `task` fields). `sysparm_fields` is not part of this API; ResolvrNow accepts it as an optional extension. **[Documented]** / **[Inferred]**

Envelope: `{"result": <object>}` for single records, `{"result": [<object>, ...]}` for lists. The docs show some single-record type endpoints wrapped in an array; ResolvrNow always returns an object for single-record endpoints. **[Inferred]** (see open questions in change.md).

### 2.2 Input rules (create and update)

- Fields may be passed as query parameters, in the JSON body, or both; body values override query values. **[Documented]**
- Unknown fields, read-only fields (ACL or dictionary), and fields owned by business rules are ignored and listed in `result.__meta.ignoredFields` (array of names). **[Documented]**
- `encrypted_fields` (comma-separated field names, query or body): the listed fields are set through the display-value setter. ResolvrNow has no field encryption; it honors the display-value semantics (so callers may pass labels for choice fields and display names for references). **[Documented]** semantics; encryption out of scope **[Inferred]**.
- With `com.snc.change_management.enforce_data_requirements=true` (default), state field policies, transition validation, type rules and CI modification rules apply exactly as for the UI; violations return 400 with the business rule message. **[Documented]**
- `state` accepts the numeric value or the state handler name (`draft` for New, `assess`, `authorize`, `scheduled`, `implement`, `review`, `closed`, `canceled`; `new` accepted as an alias). **[Inferred]** (the docs use a name in a task example; handler names come from the state model tutorials).
- One record per call; multi-record creation is not supported. **[Documented]**

### 2.3 Filtering, sorting, paging (list endpoints)

| Parameter | Meaning | Default | Prov. |
|---|---|---|---|
| name-value pairs | `field=value` equality filters, ANDed; display values accepted for choice and reference fields; mutually exclusive with `sysparm_query` (ResolvrNow: if both given, 400) | none | Documented / ResolvrNow rule Inferred |
| `sysparm_query` | Encoded query (`^`, `^OR`, `=`, `!=`, `LIKE`, `STARTSWITH`, `ENDSWITH`, `ORDERBY`, `ORDERBYDESC`); invalid parts ignored unless `glide.invalid_query.returns_no_rows=true` | none | Documented |
| `textSearch` | Full-text search across fields (ResolvrNow: global text index of the table) | none | Documented |
| `order` | Sort field | `number` for change lists, `name` for models (docs also show `name` for the generic list; ResolvrNow uses `number`) | Documented / Inferred |
| `sysparm_limit` | Page size | 500 | Documented |
| `sysparm_offset` | Start index, must be >= 0 | 0 | Documented |

ResolvrNow adds `X-Total-Count` and RFC 5988 `Link` headers like the Table API. **[Inferred]**

### 2.4 Errors

```json
{ "error": { "message": "Invalid state transition", "detail": "Change cannot move from New to Implement" }, "status": "failure" }
```

| Code | When | Prov. |
|---|---|---|
| 200 | Success (most endpoints, including deletes and conflict start) | Documented |
| 202 | Async worker accepted (schedule endpoints, CI association) | Documented |
| 400 | Malformed input, failed validation, approval not allowed for the caller, missing CI or dates for scheduling | Documented |
| 401 | Not authenticated | Documented |
| 403 | No write access to planned dates (first_available) or role missing | Documented / Inferred |
| 404 | Record not found or not readable | Documented |
| 500 | Server error | Documented |

### 2.5 Asynchronous workers

Long operations create a `chg_mgt_worker` record and return its envelope immediately **[Documented]**:

```json
{ "result": {
  "worker": { "sysId": "<worker id>", "link": "https://<host>/api/sn_chg_rest/change/worker/<worker id>" },
  "request": "<original request as JSON text>",
  "state": { "value": 1, "display_value": "Waiting" },
  "type": "schedule",
  "messages": { "errorMessages": [], "warningMessages": [], "infoMessages": [] }
} }
```

| state.value | display_value | Prov. |
|---|---|---|
| 1 | Waiting | Documented |
| 2 | In-Progress | Inferred value |
| 3 | Complete | Documented |
| 4 | Error | Inferred value |

`type` values: `schedule`, `affected`, `impacted`, `offering`, plus ResolvrNow `conflict` and `child_changes`. Completed schedule workers add `payload.spans[]` of `{start:{value,display_value}, end:{value,display_value}}`; other process-specific keys may appear (for example `ignored_cmdb_ci_sys_ids`). **[Documented]** (extra types **[Inferred]**)

## 3. Endpoint catalog

All paths are relative to `/api/sn_chg_rest[/v1]`.

| # | Method | Path | Purpose | Success |
|---|---|---|---|---|
| 1 | GET | `/change` | List changes (any type) | 200 |
| 2 | POST | `/change` | Create a change from a model or type | 200 |
| 3 | GET | `/change/{sys_id}` | Get one change | 200 |
| 4 | PATCH | `/change/{sys_id}` | Update a change | 200 |
| 5 | DELETE | `/change/{sys_id}` | Delete a change | 200 |
| 6 | GET | `/change/normal` | List normal changes | 200 |
| 7 | POST | `/change/normal` | Create a normal change (query parameters) | 200 |
| 8 | GET, PATCH, DELETE | `/change/normal/{sys_id}` | Normal change by id | 200 |
| 9 | GET | `/change/emergency` | List emergency changes | 200 |
| 10 | POST | `/change/emergency` | Create an emergency change (query parameters) | 200 |
| 11 | GET, PATCH, DELETE | `/change/emergency/{sys_id}` | Emergency change by id | 200 |
| 12 | GET | `/change/standard` | List standard changes | 200 |
| 13 | POST | `/change/standard/{standard_change_template_id}` | Create a standard change from a template | 200 |
| 14 | GET, PATCH, DELETE | `/change/standard/{sys_id}` | Standard change by id | 200 |
| 15 | GET | `/change/standard/template` | List standard change templates | 200 |
| 16 | GET | `/change/standard/template/{sys_id}` | One template | 200 |
| 17 | PATCH | `/change/{sys_id}/risk` (also `/change/standard/{sys_id}/risk`) | Evaluate risk and impact | 200 |
| 18 | GET | `/change/model` | List models | 200 |
| 19 | GET | `/change/model/{sys_id}` | One model | 200 |
| 20 | GET | `/change/{change_sys_id}/nextstates` | Available states and transition conditions | 200 |
| 21 | PATCH (ResolvrNow also POST) | `/change/{sys_id}/approvals` | Approve or reject as the caller | 200 |
| 22 | POST | `/change/{sys_id}/conflict` | Start conflict checking | 200 |
| 23 | GET | `/change/{sys_id}/conflict` | Status and results of conflict checking | 200 |
| 24 | DELETE | `/change/{sys_id}/conflict` | Cancel running conflict checking | 200 |
| 25 | GET | `/change/{change_sys_id}/schedule` | Find available slots for a change | 202 |
| 26 | PATCH | `/change/{change_sys_id}/schedule/first_available` | Move the change to the first free slot | 202 |
| 27 | GET | `/change/ci/{cmdb_ci_sys_id}/schedule` | Find available slots for a CI (no change needed) | 202 |
| 28 | GET | `/change/{sys_id}/ci` | List associated CIs by association type | 200 |
| 29 | POST | `/change/{sys_id}/ci` | Associate CIs (async) | 202 |
| 30 | POST | `/change/{sys_id}/refresh_impacted_services` | Rebuild impacted services (async) | 200 |
| 31 | GET | `/change/{change_sys_id}/task` | List tasks of a change | 200 |
| 32 | POST | `/change/{change_sys_id}/task` | Create a task | 200 |
| 33 | PATCH | `/change/{change_sys_id}/task/{task_sys_id}` | Update a task | 200 |
| 34 | DELETE | `/change/{change_sys_id}/task/{task_sys_id}` | Delete a task | 200 |
| 35 | GET | `/change/worker/{sys_id}` | Worker status and payload | 200 |

All endpoints and status codes are **[Documented]**, except the PATCH/POST tolerance on #21 and the alias on #17 (the reference shows both a standard-specific title and a generic URL, and a POST sample for a PATCH endpoint), which are ResolvrNow decisions **[Inferred]**.

## 4. Endpoint details

### 4.1 Generic change endpoints (#1 to #5)

- **GET `/change`**: list with the parameters of section 2.3. `result` is an array of change records (every field, value/display_value pairs). **[Documented]**
- **POST `/change`**: creates one change. Callers should pass `chg_model` (model name, e.g. `Normal`, `Cloud Infrastructure`; ResolvrNow also accepts a sys_id) or `type`. When both are present, the model governs and `type` is only a category; if the model's `record_preset` sets `type`, the preset value wins (ResolvrNow decision, **[Inferred]**). With neither, ResolvrNow applies the default model (behavior may differ by release in ServiceNow). Any other field may be set; `encrypted_fields` allowed. Response: full new record (state = model initial state, typically -5). Resolution rules: change.md 2.3. **[Documented]**
- **GET `/change/{sys_id}`**: one record. 404 if missing. **[Documented]**
- **PATCH `/change/{sys_id}`**: updates fields from body and query. Validation from change.md applies (transitions, policies, type, CI). Response: full updated record plus `__meta.ignoredFields` when relevant. **[Documented]**
- **DELETE `/change/{sys_id}`**: deletes and returns the record as it was before deletion. ResolvrNow cascades to change tasks, `task_ci`, `task_cmdb_ci_service`, `conflict` rows, pending approvals and workers. **[Documented]** response; cascade **[Inferred]**.

### 4.2 Type-specific endpoints (#6 to #14)

- Lists (`/change/normal`, `/change/emergency`, `/change/standard`) add an implicit `type=<type>` filter; same parameters as section 2.3, default order `number`. **[Documented]**
- `GET|PATCH|DELETE /change/<type>/{sys_id}`: as the generic endpoint, but ResolvrNow returns 404 when the record's type differs from the path type. **[Inferred]**
- `POST /change/normal` and `POST /change/emergency`: create one change "based on the default record" of that type; fields come from query parameters (the reference lists no body). ResolvrNow also accepts a JSON body with the same semantics. New record has state New (-5) and the type fixed by the path; fields that do not exist or are read-only are reported in `__meta.ignoredFields`. **[Documented]** (body tolerance **[Inferred]**)
- `POST /change/standard/{standard_change_template_id}`: id is a `std_change_record_producer` sys_id. Creates a standard change with the template's current version values (`std_change_producer_version`, task templates, attachments). Query parameters may override template fields except `description`, `backout_plan`, `test_plan`, `implementation_plan`, ACL read-only fields, fields restricted by `std_change_properties`, and fields not present in the template; those are ignored and reported. 404 for unknown or inactive (retired) templates. **[Documented]** (retired 404 **[Inferred]**)

### 4.3 Standard templates (#15, #16)

`GET /change/standard/template` lists published, readable templates (`std_change_record_producer` rows) with name-value filters, `textSearch`, `order` (default `number`) and `sysparm_limit`. Each element has all producer fields plus `template: {value: <template sys_id>, display_value: <template name>}`. `GET .../template/{sys_id}` returns one. **[Documented]**

### 4.4 Risk (#17)

`PATCH /change/{sys_id}/risk`, no body. Runs risk conditions (first match by order) and, when a risk assessment is complete for the change, combines with it keeping the highest risk; writes `risk` and `impact`. Response: record with `risk` and `impact`. 400 when the evaluation fails (detail in `error`). Works for any type in ResolvrNow (the reference title mentions standard changes only). **[Documented]** / scope **[Inferred]**

### 4.5 Models (#18, #19)

Returns `chg_model` records: `name`, `sys_name`, `description`, `active`, `available_in_ui`, `default_change_model`, `color` (default `#cbcbcb`), `record_preset` (encoded `field=value^...^EQ`), `table_name` (`change_request`), `state_field` (`state`), `sys_class_name` (`chg_model`), domain and system fields. Default order `name`. ResolvrNow filters out models the caller cannot read (model read roles, `com.snc.change_management.change_model.default_read_roles`). **[Documented]**

### 4.6 Next states (#20)

Response **[Documented]**:

| Field | Meaning |
|---|---|
| `available_states` | Array of state values (strings) reachable from the current state, including the current state |
| `state_label` | Map of state value to label for every listed state |
| `state_transitions` | Array of arrays: one inner array per target state; each element is one transition record with `sys_id`, `display_value` (e.g. "Implement to Review"), `from_state`, `to_state`, `transition_available`, `automatic_transition`, `conditions[]` of `{passed, condition:{name, description, sys_id}}` |

For legacy type-driven changes (no model) only `available_states` and `state_label` are returned. **[Documented]** ResolvrNow computes `passed` with the same evaluator used by the transition guard (change.md 3.3). **[Inferred]**

### 4.7 Approvals (#21)

Body: `state` (`approved` or `rejected`, required), `comments` (required when rejecting). ResolvrNow finds the caller's own approval for this change in state `requested` (direct, or as delegate); none found returns 400 ("user lacks authority to approve or reject"). The decision is recorded, the approval engine runs, and the response is the change after any resulting transition (for example state Scheduled after the final approval). **[Documented]** (delegate handling **[Inferred]**)

### 4.8 Conflicts (#22 to #24)

- **POST**: starts a run (change.md section 7) and returns `{"result": "<run sys_id>"}`. 400 if the change lacks CI or planned dates or is excluded. **[Documented]** (precondition errors **[Inferred]**)
- **GET**: `{status, last_run, record_count, job_status, conflicts[]}`. `conflicts` holds full `conflict` records (value/display_value pairs, e.g. `change`, `type`). `record_count` = number of records checked by the run (ResolvrNow: change requests evaluated against this one). The reference sample reports `status: "Conflict"` with an empty list and warns this can happen; ResolvrNow returns the change's `conflict_status` (`Not Run`, `Conflict`, `No Conflict`). `job_status` (ResolvrNow): `"0"` not run, `"1"` running, `"2"` complete, `"3"` canceled, `"4"` error. **[Documented]** shape; status mapping and codes **[Inferred]**
- **DELETE**: cancels the running job, clears conflicts, sets `conflict_status=Not Run`; returns 200 with no body (400 if cancel fails). **[Documented]**

### 4.9 Scheduling (#25 to #27)

| Endpoint | Input | Preconditions (400) | Prov. |
|---|---|---|---|
| `GET /change/{id}/schedule` | none | change has `cmdb_ci`, `start_date`, `end_date`, readable fields | Documented |
| `PATCH /change/{id}/schedule/first_available` | body `duration_in_seconds` (required, integer or numeric string), `planned_start_time` (UTC `yyyy-mm-dd hh:mm:ss`, optional, default now) | change has `cmdb_ci`; valid inputs; 403 if no write access to planned dates | Documented |
| `GET /change/ci/{ci}/schedule` | query `duration_in_seconds` (required), `planned_start_time` (optional) | CI exists and is readable; valid inputs | Documented |

All return a worker (202). The worker request records the caller time zone. Completion: `payload.spans` lists free windows inside `change.conflict.next_available.schedule_window` days (90), at most `choice_limit` (100). For first_available the worker updates the change and reports `infoMessages: ["Change has been updated"]` or "No slots found for <n> days from now". For the change endpoint without a duration, ResolvrNow uses the change's planned duration. **[Documented]** (duration default **[Inferred]**)

### 4.10 CIs and impacted services (#28 to #30)

- **GET `/change/{id}/ci?association_type=affected|impacted|offering`** (required): rows of `task_ci` (key `ci_item`), `task_cmdb_ci_service` (key `cmdb_ci_service`) or the service offering relation, each with all fields; name-value filters, `sysparm_limit` (500), `sysparm_offset`. **[Documented]**
- **POST `/change/{id}/ci`**: body `association_type` (required), `cmdb_ci_sys_ids` (array or comma-separated string, required), `refresh_impacted_services` (boolean, default false, only with `affected`). Returns a worker (type = association type). Invalid ids go to `errorMessages`/`warningMessages`, already associated ids to `infoMessages`. Respects CI modification rules for affected CIs. **[Documented]** (rule enforcement **[Inferred]**)
- **POST `/change/{id}/refresh_impacted_services`**: no body; returns a worker (type `impacted`, 200). **[Documented]**

### 4.11 Change tasks (#31 to #34)

- **GET**: tasks whose `change_request` (parent) is the change; filters, `order`, `sysparm_limit` (500), `sysparm_offset`, `textSearch`. **[Documented]**
- **POST**: query parameters set fields of the new `change_task` (ResolvrNow also accepts a body); `change_request` and `parent` are forced to the path change; unknown or read-only fields ignored and reported. Response includes `parent` and `sys_id`. **[Documented]**
- **PATCH**: verifies the task belongs to the change (else 404), applies change-task rules (planned window, close fields, terminal states). **[Documented]** association check; rules **[Inferred]** from change.md section 10.
- **DELETE**: verifies association, deletes, returns the deleted record (`sys_id`, `parent`, all fields). **[Documented]**

### 4.12 Worker (#35)

Returns the worker envelope of section 2.5 with current state, messages, and payload. 404 when unknown. **[Documented]**

## 5. Examples (ResolvrNow)

Identifiers: change `5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f`, CI `aa10bb20cc30dd40ee50ff6011223344`, group Network `0d9c8b7a6f5e4d3c2b1a090807060504`, template `7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f`.

### 5.1 Create a normal change through the generic endpoint

```http
POST /api/sn_chg_rest/v1/change
Content-Type: application/json

{ "chg_model": "Normal",
  "short_description": "Rotate TLS certificates on web tier",
  "cmdb_ci": "aa10bb20cc30dd40ee50ff6011223344",
  "assignment_group": "0d9c8b7a6f5e4d3c2b1a090807060504",
  "start_date": "2026-11-07 08:00:00",
  "end_date": "2026-11-07 10:00:00",
  "favorite_color": "blue" }
```

```json
{ "result": {
  "sys_id": { "value": "5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f", "display_value": "5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f" },
  "number": { "value": "CHG0030107", "display_value": "CHG0030107" },
  "type": { "value": "normal", "display_value": "Normal" },
  "chg_model": { "value": "<Normal model sys_id>", "display_value": "Normal" },
  "state": { "value": -5, "display_value": "New" },
  "approval": { "value": "not requested", "display_value": "Not Yet Requested" },
  "risk": { "value": "", "display_value": "" },
  "impact": { "value": 3, "display_value": "3 - Low" },
  "conflict_status": { "value": "Not Run", "display_value": "Not Run" },
  "start_date": { "value": "2026-11-07 08:00:00", "display_value": "2026-11-07 09:00:00", "display_value_internal": "2026-11-07 09:00:00" },
  "__meta": { "ignoredFields": ["favorite_color"] }
} }
```

(Display values shown for a caller in UTC+1; remaining fields omitted.)

### 5.2 Inspect next states, then request approval

```http
GET /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/nextstates
```

```json
{ "result": {
  "available_states": ["-5", "-4", "4"],
  "state_label": { "-5": "New", "-4": "Assess", "4": "Canceled" },
  "state_transitions": [
    [ { "sys_id": "<transition id>", "display_value": "New to Assess", "from_state": "-5", "to_state": "-4",
        "transition_available": true, "automatic_transition": false,
        "conditions": [
          { "passed": true, "condition": { "name": "Not On hold", "description": null, "sys_id": "<cond id>" } },
          { "passed": true, "condition": { "name": "State Field Policy Managed", "description": null, "sys_id": "<cond id>" } } ] } ],
    [ { "sys_id": "<transition id>", "display_value": "New to Canceled", "from_state": "-5", "to_state": "4",
        "transition_available": true, "automatic_transition": false, "conditions": [] } ]
  ] } }
```

```http
PATCH /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f
Content-Type: application/json

{ "state": "assess" }
```

Response: record with `state {value:-4, display_value:"Assess"}` and `approval {value:"requested"}`. If the group were empty the response would be 400: `{"error":{"message":"Mandatory fields must be populated: Assignment group","detail":""},"status":"failure"}`.

### 5.3 Approve as a group member

```http
PATCH /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/approvals
Content-Type: application/json

{ "state": "approved" }
```

Response: the change, now `state -3 (Authorize)`. A caller without a pending approval gets 400. A rejection without `comments` gets 400.

### 5.4 Conflict check

```http
POST /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/conflict
```
```json
{ "result": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b" }
```
```http
GET /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/conflict
```
```json
{ "result": {
  "status": "Conflict", "last_run": "2026-10-21 09:14:03", "record_count": "1", "job_status": "2",
  "conflicts": [ {
    "change": { "value": "5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f", "display_value": "CHG0030107" },
    "conflicting_change": { "value": "", "display_value": "" },
    "configuration_item": { "value": "aa10bb20cc30dd40ee50ff6011223344", "display_value": "web01" },
    "schedule": { "value": "<blackout id>", "display_value": "Year-end freeze" },
    "category": { "value": "hard_freeze", "display_value": "Hard Freeze" },
    "type": { "value": "blackout", "display_value": "Blackout" } } ] } }
```

### 5.5 Move to the first free slot

```http
PATCH /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/schedule/first_available
Content-Type: application/json

{ "duration_in_seconds": 7200, "planned_start_time": "2026-11-07 08:00:00" }
```

202 with a worker in state 1. Polling `GET /api/sn_chg_rest/change/worker/<id>` later returns state 3 and `infoMessages: ["Change has been updated"]`; the change's planned dates now hold the slot.

### 5.6 Standard change from a template

```http
POST /api/sn_chg_rest/change/standard/7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f?cmdb_ci=aa10bb20cc30dd40ee50ff6011223344&implementation_plan=skip%20steps
```

Response: new change, `type standard`, `state -5`, template values applied, `std_change_producer_version` set, `__meta.ignoredFields: ["implementation_plan"]`.

### 5.7 Change tasks

```http
POST /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/task?short_description=Drain%20node%20A&change_task_type=implementation&planned_start_date=2026-11-07%2008:00:00&planned_end_date=2026-11-07%2008:30:00
```

Then close it:

```http
PATCH /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/task/<task id>
Content-Type: application/json

{ "state": 3, "close_code": "successful", "close_notes": "Node drained" }
```

Planned dates outside the change window return 400; closing without close fields returns 400.

### 5.8 Associate affected CIs

```http
POST /api/sn_chg_rest/change/5b2e8f10c4a94d7e8e1f2a3b4c5d6e7f/ci
Content-Type: application/json

{ "association_type": "affected", "cmdb_ci_sys_ids": ["aa10bb20cc30dd40ee50ff6011223344", "nonexistent0000000000000000000000"], "refresh_impacted_services": true }
```

202 worker; when complete, `errorMessages` mentions the invalid id and the valid CI is listed by `GET .../ci?association_type=affected`.

## 6. ResolvrNow implementation notes

1. Mount as a scripted REST service `sn_chg_rest` with versions `v1` (default). Route `/change/standard/template` and `/change/model` before `/change/{sys_id}` patterns; `/change/ci/{id}/schedule` and `/change/worker/{id}` likewise. **[Inferred]**
2. Reuse the Table API serializer for value/display_value pairs and the encoded query compiler (`server/src/engine/query`). **[Inferred]**
3. All writes go through the record engine so business rules, ACLs and state model validation run identically to the UI. **[Documented]** requirement (enforce_data_requirements)
4. Workers: insert `chg_mgt_worker`, process on the async queue, update `state`, `messages`, `payload`. Keep finished workers 7 days. **[Inferred]**
5. Audit: API updates are journaled like UI updates. **[Inferred]**
6. Not implemented in v1: XML, field encryption, e-signature fields (`sn_esign_*` returned empty). **[Inferred]**

## 7. API acceptance checks

1. GET `/change?sysparm_query=active=true^ORDERBYnumber&sysparm_limit=2&sysparm_offset=2` returns the 3rd and 4th active changes by number.
2. GET `/change?state=New` (label) equals GET `/change?state=-5`.
3. POST `/change` with `chg_model=Standard` and `type=standard` creates a change governed by the Standard model (state New, no approvals on Request Approval); with `chg_model=Change Registration` and `type=emergency` the preset type `normal` wins.
4. PATCH with an unknown field returns 200 and lists it in `__meta.ignoredFields`.
5. PATCH `state=implement` on a New normal change returns 400 and leaves the record unchanged.
6. DELETE as an itil-only user returns 403; as change_manager returns 200 with the pre-delete record, and GET afterwards returns 404.
7. GET `/change/normal/{id}` for an emergency change returns 404.
8. PATCH `/approvals` with `rejected` and no comments returns 400.
9. GET `/change/ci/{ci}/schedule` without `duration_in_seconds` returns 400; with it returns 202 and a worker link.
10. GET `/change/{id}/nextstates` for a Closed change returns `available_states: ["3"]` and no transitions.
