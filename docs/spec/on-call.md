# On-Call Scheduling (ResolvrNow specification)

Scope: shifts (rotas), rosters, members and rotation, on-call schedules and spans, time off and coverage, who-is-on-call computation, escalation policies, trigger rules, escalation execution and logging, acknowledgement, reminders, properties, jobs and API surface. Generic schedule evaluation (`cmn_schedule`, `cmn_schedule_span`, time zones, child/holiday schedules) is defined in `schedules.md`; this document only adds on-call specific usage.

Conventions: **[Documented]** = stated in the public ServiceNow Brazil docs cited in the section. **[Inferred]** = ResolvrNow design choice consistent with the docs. In field tables the *Basis* column uses `Doc` (label and column name both documented), `Doc label` (label/concept documented, column name chosen by ResolvrNow) or `Inf` (ResolvrNow design). Instants are stored UTC `YYYY-MM-DD HH:MM:SS`, durations in milliseconds, "now" comes from the engine's mockable clock. All on-call logic lives in one TypeScript service (`OnCallService`) built from pure functions so it can be tested with a frozen clock **[Inferred]**.

## 1. Sources

| Topic | URL (prefix `https://www.servicenow.com/docs/r/it-service-management/on-call-scheduling/` unless absolute) |
|---|---|
| Overview, terms, capabilities | `c_OnCallScheduling.html`, `exploring-on-call-scheduling.html`, `c_OnCallSchedulingConcepts.html`, `on-call-scheduling-capabilities.html` |
| Engines | `oncall-schedule-engine.html`, `on-call-new-trigger-engine.html` |
| Tables, jobs, properties, domains | `tables-oob-oncall.html`, `scheduled-jobs-oob-oncall.html`, `on-call-properties.html`, `domain-separation-on-call-scheduling.html`, `quick-start-tests-oncallscheduling.html` |
| Shifts, rosters, members | `create-update-schedule-oncall.html`, `config-roster-oncall.html`, `update-shift-from-calendar-oncall.html`, `config-update-shift-oncall.html`, `schedule-entry-update-oncall.html`, `add-new-emplyee-to-roster-oncall.html`, `set-member-rotation-order-oncall.html`, `remove-member-from-roster-oncall.html`, `set-shift-to-draft-oncall.html`, `create-shift-template.html`, `create-group-template.html`, `config-group-prefs-oncall.html` |
| Time off, gaps, reminders | `schedule-time-off-and-cover-oncall.html`, `manage-time-off-requests-oncall.html`, `resolv-gap-conflct-timeoff-oncall.html`, `send-shift-remind-email-oncall.html`, `config-lead-time-reminders-oncall.html` |
| Escalation | `escalations-oncall.html`, `designing-escalation-process-oncall.html`, `create-trigger-rule-oncall.html`, `configure-tables-for-escalation-trigger-rule.html`, `create-custom-esc-policy-oncall.html`, `escalation-remind-settings-oncall.html`, `track-escalation-progress-oncall.html`, `view-escalation-logs-oncall.html`, `delivery-status-tracking-oncall.html` |
| Channels, preferences | `config-my-contact-prefs-oncall.html`, `override-contact-prefs-oncall.html`, `config-oncall-communication-channel.html`, `config-contact-sources-oncall.html`, `custom-on-call-channel-integration.html` |
| Subflows, workflows, reports | `subflows-installed-on-call-scheduling.html`, `workflows-oncall.html`, `workflow-activities-oncall.html`, `viewing-performance-report-oncall.html`, `viewing-esc-oview-report-oncall.html`, `roles-assigning-oncall.html` |
| Elsewhere | `https://www.servicenow.com/docs/r/platform-administration/time-configuration/r_ScheduleEntryFields.html`, `.../time-configuration/create-events-next-experience-ui.html`, `.../time-configuration/c_ParentAndChildSchedules.html`, `https://www.servicenow.com/docs/r/it-service-management/incident-management/major-incident-assignment.html`, `https://www.servicenow.com/docs/r/it-service-management/itsm-mcp-server-tools-reference.html`, `https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_OnCallRotationAPI.html` (title only, page not in corpus) |

## 2. Concepts

| Term | Table | Meaning | Basis |
|---|---|---|---|
| Shift (legacy name rota) | `cmn_rota` | A group's on-call arrangement; its schedule says when it is active | **[Documented]** |
| Roster | `cmn_rota_roster` | Ordered set of members for a shift; usually one per level (primary, secondary, tertiary) | **[Documented]** |
| Member | `cmn_rota_member` | User in a roster, valid between From and To dates; must belong to the shift's group | **[Documented]** |
| Rotation | (computed) | Handing the duty between roster members at interval boundaries | **[Documented]** |
| Escalation | `on_call_escalation*` | Ordered series of notifications for a task until someone accepts | **[Documented]** |
| Escalation policy | `cmn_rota_escalation_set`, `cmn_rota_esc_step_def` | Custom ordered steps overriding the default escalation type | **[Documented]** |
| Trigger rule | `trigger_rule` (extends `sysrule_assignment`) | When a task should start an escalation and which action runs | **[Documented]** |
| Catch-all | fields on `cmn_rota` | Who is notified when nobody on the path accepted | **[Documented]** |
| Gap / conflict | (computed) | Gap: required coverage with nobody available. Conflict: same user primary and secondary at once | **[Documented]** |

## 3. Data model

All tables below are created by ResolvrNow's on-call module. Domain separated: `cmn_rota`, `cmn_rota_escalation`, `cmn_rota_escalation_set`, `cmn_rota_esc_step_def`, `on_call_group_preference`, `sys_on_call_contact_source`, both template tables and all `on_call_escalation*` log tables; children inherit domain from their master record (`cmn_rota_roster.rota`, `cmn_rota_member.roster`, `roster_schedule_span.schedule`, `cmn_rota_escalation_set.cmn_rota`, `cmn_rota_esc_step_def.cmn_rota_escalation_set`, `on_call_escalation_level.escalation`, `on_call_escalation_con_attempt.escalation_level`, `on_call_escalation_comm.contact_attempt`) **[Documented]**. The domain-master attribute names give us the documented column names of those reference fields. Full column definitions are in `data/cmdb-sla.json` (merged from the on-call fragment).

### 3.1 `cmn_rota` (Shift)

| Field | Type | Details | Basis |
|---|---|---|---|
| name | string(100) | Shift name shown on calendars | Doc label |
| group | reference `sys_user_group`, mandatory | Owning group | Doc label |
| schedule | reference `cmn_schedule` | When the shift is active. Schedule `type = roster`; `time_zone` is the shift time zone; holidays come from a child schedule (see `schedules.md`) | Doc label |
| active | boolean, default true | | Doc label |
| state | choice `draft`, `published`; default `draft` | Draft shifts are ignored by every computation | Doc label |
| manager | reference `sys_user` | Shift manager | Doc label |
| color | string(7) | Calendar background color | Doc label |
| catch_all | choice `none`, `group_manager`, `rota_manager`, `individual`, `all`; default `none` | Final escalation audience | Doc label |
| catch_all_member | reference `sys_user` | Used when `catch_all = individual` | Doc label |
| catch_all_roster | reference `cmn_rota_roster` | Used when `catch_all = all`; empty means every roster of the shift | Inf |
| use_custom_escalation | boolean, default false | Set by "Override escalation"; cleared by "Reset escalation" | Doc label |
| override_user_preference | boolean, default false | Use shift contact preferences instead of members' own | Doc label |
| send_reminders | boolean, default false | Shift-level "Send On-Call Reminders" | Doc label |
| reminder_lead_time | integer (days) | Shift-level reminder lead time | Doc label |
| coverage_interval, coverage_lead | choice `daily`/`weekly`, integer | iCal subscription window ("Get coverage for") | Doc label |
| template | reference `sys_on_call_shift_template` | "Based on" | Doc label |

Escalation type is derived, not stored: `custom` when `use_custom_escalation`, otherwise `rotate_through_members` with exactly one active roster and `rotate_through_rosters` with several **[Documented]**.

### 3.2 `cmn_rota_roster` (Roster) and `cmn_rota_member` (On-call Member)

| Field | Type | Details | Basis |
|---|---|---|---|
| rota | reference `cmn_rota`, mandatory | Parent shift | Doc |
| name, active, order | string, boolean (default true), integer | Lower order escalates first | Doc label |
| rotation_interval_type | choice `daily`, `weekly`, `monthly`; default `weekly` | | Doc label |
| rotation_interval_count | integer >= 1, default 1 | "Rotate every" | Doc label |
| rotation_day_of_week | choice `1`..`7` (1 = Monday, ISO) | Weekly only | Doc label |
| rotation_month_day_type | choice `last_day`, `specific_day` | Monthly only | Doc label |
| rotation_day | integer 1..31 | Monthly `specific_day` | Doc label |
| rotation_start_date | glide_date, mandatory | | Doc label |
| rotation_start_time | glide_time, default `00:00:00` | Ignored when `rotation_all_day` | Doc label |
| rotation_all_day | boolean, default true | Rotate at local midnight | Doc label |
| attempts | integer, default 0 | "# reminders" (R) | Doc label |
| time_between_reminders | glide_duration, default 900000 (15 min) | T; default 15 min is documented | Doc label |
| time_before_escalation | glide_duration, read only | Always `(attempts + 1) * time_between_reminders` | Doc label |
| force_channel | choice of channel codes (section 5.4) or empty | Forced communication channel, no fallback | Doc label |
| send_reminders, reminder_lead_time | boolean, integer (days) | Roster-level shift reminders | Doc label |

`cmn_rota_member`: `roster` (reference `cmn_rota_roster`, mandatory, Doc), `member` (reference `sys_user`, mandatory, Doc label), `order` (integer, Doc label), `from` (glide_date, inclusive, Doc label), `to` (glide_date, Doc label). ResolvrNow treats `to` as **exclusive** so that a move or swap (old record gets To = D, new record gets From = D) never yields two records for one user on date D **[Inferred]**. Initially members are populated from the group and all must belong to it **[Documented]**. A member added or re-ordered becomes effective at the next rotation boundary; past slots never change **[Documented]**.

### 3.3 Schedules and `roster_schedule_span`

`roster_schedule_span` extends `cmn_schedule_span`, adds a `group` reference and the `on_call` value to `type` **[Documented]**; `show_as` gains `on_call` **[Documented]**. A schedule of type roster is shown only in on-call calendars **[Documented]**. Added ResolvrNow columns **[Inferred]**: `user` (reference `sys_user`), `roster` (reference `cmn_rota_roster`), `proposed_cover` (reference `sys_user`, documented label "Propose cover"), `state` (choice `requested`, `approved`, `rejected`, `cancelled`; default `approved`). Every span has `schedule` = the shift's schedule (domain master, Doc).

| Kind | type | group | user | roster | Effect | Basis |
|---|---|---|---|---|---|---|
| Shift entry | `on_call` | empty | empty | empty | Makes the shift active (group must stay empty, documented) | **[Documented]** |
| Extra time | `on_call` | shift group | empty | empty | Adds active time to the shift ("Schedule extra time") | **[Inferred]** |
| Coverage | `on_call` | shift group | U | R | U is on call for roster R inside the span, only while the shift is active | **[Inferred]** |
| Time off | `time_off` | group (empty = all groups) | U | empty | U unavailable when `state = approved`; `requested` is only tentative | **[Inferred]** |

With `com.snc.on_call_rotation.support_legacy_spans = true`, plain `cmn_schedule_span` rows with the same shapes are also read **[Documented]**.

### 3.4 Escalation policy, contact preferences, channels

| Table | Key columns | Basis |
|---|---|---|
| `cmn_rota_escalation_set` (Shift Escalation Set) | `cmn_rota` (ref, Doc), `name`, `default` (bool), `table` (table_name), `condition` (conditions), `description`, `active`, `override_user_preference`, `order` (smaller first) | Doc label |
| `cmn_rota_esc_step_def` (Shift Escalation Step Definition) | `cmn_rota_escalation_set` (ref, Doc), `name`, `escalation_level` (int), `time_to_next_step` (duration, W), `reminder_num` (int, R), `time_between_reminders` (duration, T), audience: `rosters` (glide_list roster), `groups` (glide_list group), `users` (glide_list user), `devices` (string list), `group_manager` (bool), `group_manager_field` (dot path on `sys_user_group`, default `manager`) | Doc label |
| `cmn_rota_contact_preference` (Shift Contact Preference) | `rota`, `escalation_set` (empty = default escalation), `contact_attempt` (int, 1-based), `channels` (CSV of channel codes) | Inf names |
| `on_call_user_preference` (availability) | `user`, `name`, `active`, `schedule` (ref `cmn_schedule`, empty = always), `order` | Doc label |
| `on_call_user_contact_preference` | `user_preference`, `user`, `contact_attempt`, `channels` | Doc label |
| `on_call_communication_type` | `name`, `value` (channel code), `active` | Inf names |
| `on_call_communication_channel_config` | `channel_type`, `channel_default`, `channel_subflow`, `order`, `table`, `conditions`, `accept_keyword`, `reject_keyword`, user/device/catch-all `title`, `message`, `accept_instruction`, `reject_instruction` | Doc label |
| `sys_on_call_contact_source` | `name`, `table`, `user_field`, `active`, `source_type`, `source` | Doc label |
| `on_call_group_preference` | `group`, `shift_managers` (glide_list user), `allow_rota_overlap` (`default`/`yes`/`no`), `escalation_rule_rota_overlap` (`default`/`outgoing`/`incoming`/`all`), `pto_approval` (`default`/`with_approval`/`without_approval`/`not_allowed`), `first_day_of_week` | Doc label |
| `sys_on_call_group_template`, `sys_on_call_shift_template` | group: `name`, `description`; shift: `name`, `schedule_type`, `all_day`, `start_time`, `end_time`, `end_time_day`, `repeat_on` (days_of_week), `group_template`, `time_zone`, `specify_holiday_schedule` | Doc label |
| `cmn_rota_escalation` (Rotation Escalation) | Legacy list of escalations (`rota`, `task`, `event`); ResolvrNow creates the table but never writes it | Inf |

Deferred (names documented, not implemented in phase 1): `on_call_template_contact_attempt`, `on_call_template_contact_preference`, `on_call_template_escalation_policy`, `on_call_template_escalation_step`, report views `v_on_call`, `v_rotation`, `v_user_rotation`, `v_alternate_rotation` (ResolvrNow serves the same data through the computed endpoints of section 8) **[Documented]** names.

### 3.5 `trigger_rule` and `trigger_rule_table_cfg`

`trigger_rule` extends `sysrule_assignment` (so it inherits `name`, `order` "Execution order" default 100, `active`, `table`, `condition`, `match_conditions` ALL/ANY, `group`) **[Documented]**. Added fields (labels **[Documented]**, names **[Inferred]**): `run_trigger` (`once` "Run once", `trigger_field_changes` "Every time trigger field changes"; default `once`), `trigger_fields` (field_list), `trigger_when` (`condition_matches`, `default`; default `condition_matches`), `trigger_action` (`subflow`, `workflow`, `script`; default `subflow`), `trigger_subflow` (ref `sys_hub_flow`), `trigger_workflow` (ref `wf_workflow`), `trigger_script` (script). Group-level rule: `group` set and `assignment_group` not in `trigger_fields`; otherwise global **[Documented]**. Only task tables, plus non-task tables listed in `trigger_rule_table_cfg` (`table`, `trigger_group_field`, `trigger_user_field`, `trigger_condition_fields`, `journal_field`), are allowed **[Documented]**. Defaults when no config row exists: group field `assignment_group`, user field `assigned_to`, journal `work_notes` **[Inferred]**.

### 3.6 Escalation log tables

| Table | Columns (Doc = documented setting of the logging activities) |
|---|---|
| `on_call_escalation` | `group`, `table`, `source` (document id of task), `trigger_rule`, `subflow`, `parent_escalation_level`, `category` (`assign_by_acknowledgement`, `auto_assignment`, `notify_manual_assignment`, `conferencing`; Doc codes), `channels` (CSV, Doc), `ignore_default_reminders` (Doc), `active` (Doc), `acknowledged` (Doc), ResolvrNow: `acknowledged_by`, `acknowledged_at`, `time_to_acknowledge` (duration, Doc label), `end_time`, `end_reason`, `next_action_at` |
| `on_call_escalation_level` | `escalation` (Doc), `rota` (Doc), `level` (Doc), `escalatees` (glide_list user), `devices`, `catch_all` (Doc), ResolvrNow runtime: `active`, `started_at`, `attempts` (R), `time_between_reminders` (T), `wait_after` (W), `attempts_made`, `next_attempt_at`, `ends_at`, `outcome` (`pending`, `accepted`, `rejected`, `no_response`, `failed`, `cancelled`) |
| `on_call_escalation_con_attempt` | `escalation`, `escalation_level` (Doc), `rota`, `level`, `attempt` (Doc "ContactAttempt" number) |
| `on_call_escalation_comm` | `contact_attempt` (Doc), `escalation`, `escalatee_type` (`user`/`device`, Doc), `escalatee`, `comm_type` (channel code), `comm_value` (address), `status` (`sent`, `delivered`, `failed`; Doc), `failure_reason` (Doc label), `notification_id`, `response` (`accepted`, `accepted_other_device`, `auto_assigned`, `rejected`, `rejected_other_device`, `invalid_response`, empty; Doc labels), `responded_at`, `catch_all` (Doc) |
| `on_call_escalation_response` | `workflow_context`, `escalatee` (user), `table`, `record`, `response` (`accepted`/`rejected`); rows are deleted once consumed (Doc) |

Logging is written only when `com.snc.on_call_rotation.log_escalations` is true (default true) **[Documented]**; ResolvrNow always keeps the runtime columns it needs and skips only the comm/attempt rows when logging is off **[Inferred]**.

### 3.7 Member change requests

`on_call_add_member` (`from_date`, `add_after_member`, `rota`, `member`, `rosters`, `current_roster`), `on_call_remove_member` (`from_date`, `rosters`, `delete_member`, `member`, `current_roster`, `rota`), `on_call_swap_member` (`from_date`, `member`, `current_roster`, `rota`, `move_type` `move_after`/`swap`, `target_member`, `rosters`) **[Documented]** labels. An after-insert business rule applies the change to every roster in `rosters` **[Inferred]**: add inserts a member with `from = from_date` and `order` = midway between the target and its successor (renumber in steps of 100 if no gap); remove sets `to = from_date` or deletes the row when `delete_member` (history lost, documented warning); move/swap closes the old rows (`to = from_date`) and inserts new rows (`from = from_date`) with the new orders.

## 4. Who is on call

### 4.1 Shift activity and time zone

```
tzOf(rota) = rota.schedule.time_zone, or system tz (glide.sys.default.tz) when empty or floating      [Inferred]
rotaActiveAt(rota, t) = rota.active && rota.state == 'published'
    && ( isInSchedule(rota.schedule, tzOf(rota), t), entries where group is empty   # schedules.md section 5, honours child/holiday schedules
         || exists extra-time span of rota covering t )
```
Span ends shown by the UI as `HH:59:59` are normalized to the next whole minute; all intervals are half open `[start, end)` **[Inferred]** (the docs show 8 a.m. to 8 p.m. as 08:00:00 to 19:59:59, **[Documented]**).

### 4.2 Rotation boundaries (per roster)

```
n   = max(1, R.rotation_interval_count)
tod = (R.rotation_all_day || (R.rotation_interval_type == 'daily' && prop.factor_daily_rotation_interval_all_day)) ? 00:00 : R.rotation_start_time
d0  = R.rotation_start_date;   B[0] = local(d0, tod, tz)
daily:   B[k] = local(d0 + k*n days, tod, tz)
weekly:  a0 = first date >= d0 whose ISO weekday == (R.rotation_day_of_week ?? weekday(d0)); a_j = a0 + 7*n*j days
monthly: anchor(m) = last day of month m (last_day) or min(R.rotation_day, last day of m) (specific_day)
         a0 = first anchor date >= d0; a_j = anchor(month(a0) + n*j)
weekly, monthly: B = [B[0]] followed by every local(a_j, tod, tz) strictly greater than B[0]
slot(R, t) = largest k with B[k] <= t, or -1 when t < B[0] (no one on call yet)
```
Boundaries are local wall-clock times, so they keep their local hour across DST changes **[Inferred]**. The midnight/start-time behaviour of daily rotation follows the documented property **[Documented]**; a partial first period when the start date is not an anchor day is **[Inferred]**.

### 4.3 Slot holder (2024 engine semantics)

The new engine continues from the previous rotation and starts the next turn with someone who has not just served, instead of recomputing from scratch **[Documented]**. ResolvrNow formalizes this as a successor rule **[Inferred]**:
```
eligible(R, d) = members of R with (from empty or from <= d) and (to empty or d < to), one row per user
                 (latest from wins), sorted by (order, sys_id)
holder(R, 0) = first(eligible(R, date(B[0])))
holder(R, k) = E = eligible(R, date(B[k])); p = holder(R, k-1)
               first m in E with (m.order, m.sys_id) > (p.order, p.sys_id), else first(E); null when E empty
```
While membership is unchanged between slots j and k, `holder(k) = E[(indexOf(holder(j)) + k - j) mod |E|]`; implementations must use this to jump over runs (cost proportional to membership changes, not slots). Inactive users and users who left the group are not skipped by rotation: they produce gaps **[Documented]** (gap reasons list).

### 4.4 Availability, time off and coverage

```
available(u, rota, t) = u.active && u is member of rota.group && !timeOff(u, rota.group, t)
timeOff(u, g, t)      = exists time_off span, state approved, user u, group in (g, empty), covering t
onCall(R, t):                                   # current on-call user of one roster
  for cov in coverage spans of R covering t, newest sys_created_on first:
      if available(cov.user, R.rota, t): return (cov.user, 'coverage')
  k = slot(R, t); h = k < 0 ? null : holder(R, k)
  return h && available(h.member, R.rota, t) ? (h.member, 'rotation') : null     # null = gap
```
Approving a time off that names a cover creates one coverage span per roster of the requester in that group for the same window; a manager's "Provide coverage" creates the same spans directly **[Inferred]** (coverage and proposed cover are **[Documented]** features). Members on time off are never part of an escalation path **[Documented]**.

### 4.5 Escalation plan of a shift at instant t

```
escalationPlan(rota, t, task):
  if !rotaActiveAt(rota, t): return []
  if rota.use_custom_escalation and (set = pickSet(rota, task)):          # 5.3
      levels = steps(set) ordered by escalation_level, each -> audience(step, t)
  else rosters = active rosters by (order, sys_id)
      if |rosters| == 0: return []
      if |rosters| == 1:                                                   # rotate through members
          R = rosters[0]; k = slot(R, t); if k < 0: return []
          rest = eligible(R, date(B[k])) starting after holder(R, k), wrapping, filtered by available
          levels = [onCall(R, t)] + rest
      else levels = [onCall(R, t) for R in rosters]                       # rotate through rosters
      drop nulls; drop users already seen; each level takes its roster's R and T, W = T
  if rota.catch_all != 'none': append level(catchAllUsers(rota, t), catch_all = true, timing of last level)
```
`catchAllUsers`: `group_manager` = `rota.group.manager`; `rota_manager` = `rota.manager`, else group preference `shift_managers`; `individual` = `catch_all_member`; `all` = every available member of `catch_all_roster` (or of all rosters) **[Inferred]** codes, choices **[Documented]**. Custom step audience = `onCall(R)` for its rosters, its users, the level-1 users of each listed group's plan (all active group members when that group has no active shift), the manager reached through `group_manager_field`, and its devices **[Inferred]**. Catch-all users must respond like any other escalatee and can be assigned **[Documented]**.

### 4.6 Several shifts at once

```
rotasForEscalation(group, t):
  A = published active shifts of group with rotaActiveAt(r, t)
  if |A| <= 1: return A
  rule = group preference escalation_rule_rota_overlap ('default' -> property)
  start(r) = start of r's active interval containing t
  incoming = argmax start(r); outgoing = argmin start(r)        # ties: lower sys_id
  return rule == 'incoming' ? [incoming] : rule == 'outgoing' ? [outgoing] : A
```
Overlap needs `allow_rota_overlap` (group preference, `default` -> property); otherwise publishing a shift whose active time intersects another published shift of the group is rejected **[Documented]** options, **[Inferred]** enforcement point. With rule `all`, one escalation track per shift runs in parallel **[Documented]**.

### 4.7 Worked examples (all UTC, `rotation_all_day = false`, start time 08:00)

Example A: roster Primary, weekly, every 1, day of week Monday, start 2026-01-05 (Monday); members Alice (100), Bob (200), Carol (300).

| k | B[k] | holder A | holder B (Dave added, from 2026-01-21, order 150) |
|---|---|---|---|
| 0 | 2026-01-05 08:00 | Alice | Alice |
| 1 | 2026-01-12 08:00 | Bob | Bob |
| 2 | 2026-01-19 08:00 | Carol | Carol (Dave not yet eligible) |
| 3 | 2026-01-26 08:00 | Alice | Alice |
| 4 | 2026-02-02 08:00 | Bob | Dave |
| 5 | 2026-02-09 08:00 | Carol | Bob |

At 2026-01-21 10:00 (A): slot 2, primary Carol, plan [Carol, Alice, Bob]. Example C: in variant B, Bob has approved time off 2026-02-10 00:00 to 2026-02-13 00:00 with approved cover Carol; at 2026-02-11 12:00 `onCall(Primary)` = Carol (coverage) and the plan is [Carol, Alice, Dave] (Bob excluded, duplicate Carol dropped). Without the cover, Primary shows a gap and the plan is the same.

### 4.8 Gaps and conflicts

For a window, split each active interval of a shift at slot boundaries and at time-off/coverage edges; a piece where `onCall(R)` is null is a gap for roster R (reason `time_off`, `inactive`, `not_in_group` or `no_member`); a piece where one user is `onCall` for two rosters of the same shift is a conflict **[Documented]** definitions, **[Inferred]** method.

## 5. Escalation

### 5.1 Trigger rule evaluation (after business rule on every table enabled for trigger rules, ordered after assignment rules) **[Inferred]** unless noted

```
onTaskWrite(task, previous, op):
  cfg = trigger_rule_table_cfg(task) or defaults; esc = active on_call_escalation for (table, source)
  if esc and task.active == false: end(esc, 'task_inactive')
  if esc and task[cfg.user] changed and the writer is not the escalation engine: end(esc, 'assigned')
  for rule in active trigger_rule where task INSTANCEOF rule.table order by (order, sys_id):
     fires = rule.run_trigger == 'once' ? no earlier escalation of (task, rule)
                                        : op == insert || some field of rule.trigger_fields changed
     if fires && rule.trigger_when == 'condition_matches': fires = match(rule.condition, rule.match_conditions, task)
     if !fires: continue
     group = groupLevel(rule) ? rule.group (also written to task[cfg.group]) : task[cfg.group]
     if !group: continue
     if esc: end(esc, 'superseded')
     runAction(rule, task, group); return                     # first matching rule wins
  if esc and task[cfg.group] changed: end(esc, 'cancelled_group_change')       # [Documented]
```
Trigger rules behave like assignment rules **[Documented]**. `trigger_when = default` runs the action without checking conditions **[Documented]**. Script actions need `admin` or `rota_admin` and `workflow` is the legacy option **[Documented]**; ResolvrNow maps workflow and subflow names to the same TypeScript handlers and runs scripts as registered server hooks **[Inferred]**.

### 5.2 Action handlers (documented subflows)

| Subflow (sys_hub_flow name) | ResolvrNow behaviour | Basis |
|---|---|---|
| On-Call: Assign | `assigned_to` = first user of the plan at now; no notification unless `notify_assignee`; nobody available: nothing | **[Documented]** |
| On-Call: Assign and Notify | Same, then notifies the assignee; ends when nobody is available (escalation logged with `end_reason = no_on_call`) | **[Documented]** |
| On-Call: Assign by Acknowledgement | Full escalation (5.3) over preferred channels, assign on accept; per-shift tracks when several shifts apply | **[Documented]** |
| On-Call: Escalations by Email | Same as above with channels forced to `email` | **[Documented]** |
| On-Call: Check Assignment Response / Assign by Acknowledgement Voice | Inbound SMS / voice response adapters calling `respond()` | **[Documented]** |
| On-Call: Time-off approval | Approval request to shift managers and group manager | **[Documented]** |
| On-Call: Conference Call Escalation | Sequential voice calls, time between reminders fixed at 60 s | **[Documented]** |

Major incidents: when the group has an active shift and someone is available, the major incident is assigned to that on-call user **[Documented]**.

### 5.3 Policy selection and timing

`pickSet(rota, task)`: active sets of the shift whose `table` is empty or matches `task INSTANCEOF table` and whose `condition` matches, by `order` ascending; else the set with `default = true`; else none (default escalation type) **[Documented]** fields, **[Inferred]** order of evaluation.
```
level i of a track starts at s_i (s_1 = escalation start); R = attempts, T = time between reminders
attempt j (1..R+1) is due at s_i + (j-1)*T
default levels: s_(i+1) = s_i + (R+1)*T                        # "time before escalation"   [Documented]
custom steps:   s_(i+1) = s_i + R*T + W, W = time_to_next_step (empty -> T)   [Documented] W after last reminder
conferencing:   T = 60 s for every level                         [Documented]
reject by every escalatee of level i at x: s_(i+1) = x          ("resumes immediately")   [Documented]
accept by anyone at x: escalation ends for all tracks
after the last level (catch-all included) a track ends 'no_response'; when all tracks ended -> active = false,
acknowledged = false, end_reason = 'exhausted'
```
The timer job processes due rows in time order; if a run is late and several attempts of one level are overdue, only the latest one is sent, and level starts keep their absolute schedule **[Inferred]**. Notifications of one attempt go to all selected channels at the same time **[Documented]**.

### 5.4 Contact resolution

Channel codes: `email`, `sms`, `voice`, `slack`, `ms_teams`, `mobile_push` (plus custom providers) **[Documented]** channels, **[Inferred]** codes.
```
channelsFor(user, rota, set, roster, attempt j, t):
  if roster.force_channel: return [roster.force_channel]                         # no fallback [Documented]
  if set?.override_user_preference || rota.override_user_preference:
      return cmn_rota_contact_preference(rota, set) for attempt min(j, maxAttempt)
  up = active on_call_user_preference of user whose schedule contains t (empty schedule = always), lowest order
  if up: return its on_call_user_contact_preference for attempt min(j, maxAttempt)
  return ['email']                                                                  # [Inferred]
```
Addresses: `email` -> `sys_user.email`, `sms`/`voice` -> `sys_user.mobile_phone`, other channels -> provider identity. A missing address yields a comm row with `status = failed` and a reason; no other channel is tried and no further attempt is made at that level (the track moves on at the level's normal end) **[Documented]** failure behaviour, **[Inferred]** timing.

### 5.5 Responses and delivery status

| Input | Effect | Basis |
|---|---|---|
| Reply containing the accept keyword (email, SMS, voice key, Slack/Teams/push button) | comm `response = accepted`; task `assigned_to` = user (group field unchanged); escalation `active = false`, `acknowledged = true`, `acknowledged_by`, `time_to_acknowledge`; journal entry on `cfg.journal_field` | **[Documented]** outcome, **[Inferred]** fields |
| Reject keyword | comm `response = rejected`; when every escalatee of the level rejected, next level starts now | **[Documented]** |
| Response from another device of the same user | `accepted_other_device` / `rejected_other_device`, same effect | **[Documented]** values |
| Unrecognized text | `invalid_response`, no state change | **[Documented]** value |
| Response after the escalation ended | Recorded on the comm row only | **[Inferred]** |
| Provider status callbacks | `sent`, `delivered`, `failed`; unknown codes map to `sent` and log an error; out-of-order callbacks keep the most advanced state (`failed` is terminal from any state) | **[Documented]** |
| Delivery failure | Work note on the task: recipient, channel, reason, failure time, escalation step; only failures are noted | **[Documented]** |

Keywords come from `on_call_communication_channel_config` (most specific table match by `order`, else the channel default) **[Documented]**; ResolvrNow defaults `ACCEPT` / `REJECT` and correlates replies through a message number placeholder `{message_number}` **[Inferred]**.

### 5.6 Escalation state machine

| From | Event | To | Side effects |
|---|---|---|---|
| none | rule fires, plan non empty | active, level 1 attempt 1 | insert escalation, level, attempt, comm rows; event `on_call.escalation.started` |
| none | rule fires, plan empty | ended `no_on_call` | journal entry "no one on call" |
| active | attempt due | active | attempt row, comm rows per channel |
| active | level elapsed or all rejected | active, next level | level `outcome` = `no_response`/`rejected` |
| active | accept | ended `accepted` (acknowledged) | assignment, journal entry, other tracks cancelled |
| active | last level elapsed in every track | ended `exhausted` | journal entry |
| active | group changed without matching rule / new rule fired / manual assignment / task inactive | ended `cancelled_group_change` / `superseded` / `assigned` / `task_inactive` | pending attempts dropped |

## 6. Reminders, time off and properties

Shift reminders **[Documented]**: lead time = roster value, else shift value, else 2 days; with daily rotation and a lead time above 1 day no reminder is sent. ResolvrNow sends the reminder for slot k on the first daily job run whose date (shift time zone) is between `date(B[k]) - lead` and `date(B[k])`, once per (roster, user, B[k]) tracked in `resolvr_on_call_reminder`, when `roster.send_reminders || rota.send_reminders` **[Inferred]**. The email includes the user's time zone when `reminders.showtz` is true **[Documented]**. "Resend" clears the tracking row **[Inferred]**.

Time off policy: group `pto_approval` (`default` -> property `pto.configuration`) applies to plain members; admin, rota_admin, rota_manager and group managers are exempt **[Documented]** and their rows are stored `approved` **[Inferred]**. `not_allowed` rejects the insert, `without_approval` stores `approved`, `with_approval` stores `requested` and starts the approval; approve sets `approved` (and creates cover spans), reject sets `rejected`, both notify the requester **[Documented]** behaviour, **[Inferred]** states.

| Property | Default | Meaning | Basis |
|---|---|---|---|
| com.snc.on_call_rotation.log_escalations | true | Write escalation log tables | **[Documented]** |
| com.snc.on_call_rotation.allow_rota_overlap | false | Allow overlapping shifts in a group | **[Documented]**, default **[Inferred]** |
| com.snc.on_call_rotation.escalation_rule_rota_overlap | all | `outgoing`, `incoming`, `all` | **[Documented]** options, default **[Inferred]** |
| com.snc.on_call_rotation.pto.configuration | with_approval | `with_approval`, `without_approval`, `not_allowed` | **[Documented]** options, default **[Inferred]** |
| com.snc.on_call_rotation.pto.approval.required | true | Legacy switch, read only when `pto.configuration` is empty | **[Documented]** name |
| com.snc.on_call_rotation.factor_daily_rotation_interval_all_day | false | Daily rotation at midnight instead of roster start time | **[Documented]**, default **[Inferred]** |
| com.snc.on_call_rotation.support_legacy_spans | false | Also read time off/coverage from `cmn_schedule_span` | **[Documented]**, default **[Inferred]** |
| com.snc.on_call_rotation.reminders.showtz | true | Time zone in reminder emails | **[Documented]**, default **[Inferred]** |
| com.snc.on_call_rotation.new_trigger_engine | true | High-priority queue launch; ResolvrNow always behaves as true | **[Documented]**, default **[Inferred]** |
| com.snc.on_call_rotation.calendar_read_roles | itil,rota_manager,rota_admin,oc_read | Roles that may read calendars and lookups | **[Documented]**, default **[Inferred]** |
| com.snc.on_call_rotation.landing_page.group_limit / max_groups | 20 / 300 | Landing page batch size / maximum | **[Documented]** |
| com.snc.on_call_rotation.landing_page.show_pending_actions | true | Show gaps/conflicts badges to managers | **[Documented]**, default **[Inferred]** |
| com.snc.notify.default.on_call_escalation_level | -1 | Users fetched from the plan for conference calls (-1 all, 1 first level) | **[Documented]**, default **[Inferred]** |
| com.snc.notify.default.conference_call_follow_on_call_escalation | false | Follow the escalation path (60 s reminders) for conference calls | **[Documented]**, default **[Inferred]** |
| com.snc.iam.on_call_escalation_level | 2 | Levels offered as group contacts (primary and secondary by default) | **[Documented]**, value **[Inferred]** |
| UI only: calendar_macro, contrast, show_legacy_calendar, cover.color, timeoff.color, use_slack_for_dm, use_msteams_for_dm, landing_page.* (pinned_notification, notification_timeout, show_wizard_btn), com.snc.on_call.announcement_message, log.level, access.debug | stored, ignored by the engine | | **[Documented]** names |

## 7. Scheduled jobs and events

| Job | Cadence | Behaviour | Basis |
|---|---|---|---|
| On-Call Reminders | daily (ResolvrNow 00:05 system tz) | Section 6 | **[Documented]** |
| On-Call Gaps Conflicts Report | weekly | Section 4.8 (ResolvrNow window: next 7 days), emailed to shift managers, group managers and admins | **[Documented]** |
| On-Call Escalation Timer | every 30 s (`resolvr.on_call.escalation_timer_seconds`) | Advances rows with `next_action_at <= now` | **[Inferred]** |
| On-Call Upgrade shifts to 2024 schedule engine | on demand | Not needed: ResolvrNow has one engine | **[Documented]** name |

Events (ResolvrNow names) **[Inferred]**: `on_call.escalation.started`, `on_call.escalation.notify`, `on_call.escalation.acknowledged`, `on_call.escalation.ended`, `on_call.delivery.failed`, `on_call.shift.reminder`, `on_call.timeoff.requested`, `on_call.timeoff.approved`, `on_call.timeoff.rejected`, `on_call.gaps_report`. Email notifications subscribe to these events.

## 8. API surface and roles

* Table API (`/api/now/table/<table>`) on every table of section 3 with standard ACLs **[Inferred]**.
* Script APIs exist under these names (pages not in the corpus): `OnCallRotation`, `OCRotationV2`, `OCRotation`, `OCRotaMember`, `OCRotaICalendar`, `OCRotaICalendarSNC`, `OnCallContactPreferenceUtil`, `OnCallContactPrefTemplate`, `OnCallEscalationTemplateSNC`; workflow activities use `getEscalationPlan()` **[Documented]** names. ResolvrNow exposes `OnCallService.whoIsOnCall(group, at)`, `getEscalationPlan(group, at, task?)`, `startEscalation(task, rule)`, `respond(escalation, user, response, channel)`, `gapsAndConflicts(group, from, to)` **[Inferred]**.
* ResolvrNow extension endpoints (not ServiceNow compatible, mirror the documented MCP tool operations `who_is_on_call`, `my_next_shift`, `timeoff_request` analyze/create) **[Inferred]**: `GET /api/app/oncall/who_is_on_call?group=&rota=&at=` returns `{group, at, rotas:[{rota, name, escalation_type, active_from, active_to, rosters:[{roster, name, order, user, source, gap}], plan:[{level, users, catch_all, attempts, time_between_reminders_ms}]}]}`; `GET /api/app/oncall/my_next_shift`; `POST /api/app/oncall/timeoff` with `mode = analyze|create`; `POST /api/app/oncall/escalations/{sys_id}/respond`; `GET /api/app/oncall/calendar.ics?group=&token=` (iCal subscription, coverage window from `coverage_interval`/`coverage_lead`).
* Roles **[Documented]**: `sn_on_call_admin` (contains `rota_admin`), `rota_admin` (all shifts, trigger rules with workflow/subflow, includes `assignment_rule_admin`), `rota_manager` (only groups they manage: group manager, delegated role, or listed in `shift_managers`; trigger rules with workflow only), `itil` (read own groups, request time off), `oc_read` (read only), `rota_prem_dashboard_user`, deprecated `roster_admin`. Script trigger actions need `admin` or `rota_admin`.

## Acceptance tests

Fixtures: Example A/B/C of 4.7 (UTC shift schedule 24x7, group Network, manager Mia). Example D: shift with rosters Primary (attempts 2, T 10 min, holder Carol) and Secondary (attempts 1, T 5 min, holder Alice), catch-all `group_manager`, trigger rule "P1 Network" (`On-Call: Assign by Acknowledgement`, condition `priority=1`), incident created 10:00:00.

1. Given Example A, when computing who is on call at 2026-01-21 10:00, then Primary = Carol (source rotation) and plan users = [Carol, Alice, Bob].
2. Given Example A, when evaluated at 2026-01-26 07:59:59 and 08:00:00, then the holders are Carol and Alice.
3. Given Example A, when evaluated at 2026-01-05 07:59:59, then Primary is a gap and the plan is empty.
4. Given a daily roster (every 2 days, start 2026-03-01 09:00, members A, B, C, all day false, property false), when evaluated at 2026-03-05 05:00, then holder = B; with `rotation_all_day = true`, or with `factor_daily_rotation_interval_all_day = true`, holder = C.
5. Given a weekly roster starting Wednesday 2026-01-07 08:00 with rotation day Monday and members A, B, C, when evaluated at 2026-01-10, 2026-01-13 and 2026-01-20, then holders are A, B, C.
6. Given a monthly `last_day` roster starting 2026-01-15, all day, members A, B, when evaluated at 2026-01-20, 2026-02-27, 2026-02-28 12:00 and 2026-03-31 00:00, then holders are A, B, A, B.
7. Given a weekly Monday 09:00 roster in America/New_York starting 2026-03-02 with members A, B, when boundaries are computed, then B[0] = 2026-03-02 14:00:00 UTC and B[1] = 2026-03-09 13:00:00 UTC, so 12:59 UTC on 03-09 is A and 13:00 is B.
8. Given Example B, when holders of slots 2 to 6 are computed, then they are Carol, Alice, Dave, Bob, Carol.
9. Given Example A and Bob's member row with `to = 2026-02-01`, when computing slots 1, 4, 5, then holders are Bob, Carol, Alice.
10. Given Example A and a swap of Alice and Bob from 2026-01-21, when computing slots 2, 3, 4, then holders are Carol, Bob, Alice.
11. Given Example C, when an escalation starts at 2026-02-11 12:00, then level 1 is Carol and no comm row targets Bob.
12. Given a two-roster shift whose Primary holder has approved time off without cover, when computing who is on call, then Primary is a gap with reason `time_off` and escalation level 1 is the Secondary holder; with the time off still `requested`, the Primary holder is on call.
13. Given a coverage span for Secondary by Dave from 2026-02-03 00:00 to 2026-02-04 00:00, when evaluated at 2026-02-03 12:00 and 2026-02-04 00:00, then Secondary is Dave and then the rotation holder.
14. Given the holder is set inactive, when computing who is on call, then the roster shows a gap with reason `inactive`, and after reactivation the same holder returns while later slot holders are unchanged.
15. Given a shift on schedule "8-5 weekdays" (America/New_York) with a holiday child schedule containing 2026-12-25, when evaluated on Saturday 12:00 local and on 2026-12-25 10:00 local, then no shift is active and the plan is empty; a shift in state `draft` is ignored at any time.
16. Given shifts EMEA (06:00 to 15:00) and AMER (14:00 to 23:00) with overlap allowed, when escalating at 14:30, then rule `incoming` selects AMER, `outgoing` selects EMEA and `all` selects both.
17. Given overlap not allowed for the group, when publishing a second shift whose active time intersects an existing published shift, then the write is rejected with a validation error.
18. Given Example D, when the incident is inserted, then one `on_call_escalation` exists with `active = true`, `category = assign_by_acknowledgement`, `table = incident`, `source` = incident sys_id, plus a level 1 row for Carol and comm rows at 10:00.
19. Given Example D with no responses, when the clock runs to 11:00, then comm rows exist for Carol at 10:00, 10:10, 10:20, Alice at 10:30, 10:35, Mia (`catch_all = true`) at 10:40, 10:45, and at 10:50 the escalation has `active = false`, `acknowledged = false`, `end_reason = exhausted`.
20. Given Example D, when Alice rejects at 10:33, then Mia's first notification is at 10:33 and Alice's comm row has `response = rejected`.
21. Given Example D, when Carol accepts at 10:12, then `assigned_to = Carol`, `acknowledged = true`, `time_to_acknowledge` = 12 min, a journal entry exists and no comm row is created after 10:12.
22. Given Example D, when at 10:15 the assignment group changes to Database and no rule matches, then the escalation ends with `cancelled_group_change` and no further notifications are sent.
23. Given a rule with `run_trigger = once`, when priority changes 1 to 2 to 1, then no second escalation starts; given `trigger_field_changes` on `priority`, when priority changes, then a new escalation starts and the old one ends `superseded`.
24. Given Primary has `force_channel = sms` and Carol has no mobile phone, when level 1 starts, then one comm row has `comm_type = sms`, `status = failed`, a failure reason, no email row exists, a failure work note is added, and Alice is still notified at 10:30.
25. Given a comm row, when callbacks `delivered` then `sent` arrive in that order, then its status stays `delivered`; when `failed` arrives later, then it becomes `failed`.
26. Given a `conferencing` escalation on a roster with T = 15 min, when attempts are scheduled, then they are 60 s apart.
27. Given rule action `On-Call: Assign`, when it fires, then `assigned_to` = Carol and no comm rows exist; given `On-Call: Assign and Notify` with no active shift, then `assigned_to` stays empty and the escalation ends `no_on_call`.
28. Given roster lead 1 day and shift lead 3 days for a slot starting 2026-02-02 08:00, when the daily job runs, then the reminder is sent on 2026-02-01 only once; with both leads empty it is sent on 2026-01-31; on a daily roster with lead 3 nothing is sent.
29. Given group `pto_approval = not_allowed`, when an itil member inserts a time off, then it is rejected while a rota_manager's identical insert is stored `approved`; with `with_approval` the member's row is `requested` until approved.
30. Given overlap rule `all` with two active shifts, when an escalation starts, then two level 1 rows (one per shift) exist, and an accept on one ends both tracks.
31. Given a custom shift with sets "P1" (order 100, `priority=1`) and "Default" (`default = true`), when a P1 and a P3 incident escalate, then P1 uses the P1 steps and P3 the default set, and a step with R = 1, T = 5 min, W = 10 min starts the next step 15 min after it began.
