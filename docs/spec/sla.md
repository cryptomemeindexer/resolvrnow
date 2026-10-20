# Service Level Management: SLA engine specification

ResolvrNow spec, clean-room. Covers SLA definitions (`contract_sla`), task SLAs (`task_sla`), the attach/pause/resume/stop/reset/cancel lifecycle, business-time math, update jobs, percentage timers and notifications, repair, and legacy task fields. Schedule math (`cmn_schedule`, time zones, `add`/`duration`) is defined in `schedules.md` and is a dependency of this document.

Conventions: **[Documented]** = stated in the Brazil docs cited in the section. **[Inferred]** = ResolvrNow decision or unstated platform behaviour. Instants are UTC (`YYYY-MM-DD HH:MM:SS` stored, ms precision in memory); durations are integer ms (REST value form `1970-01-01 HH:MM:SS`, per engine `util.ts`). `S.add`, `S.duration`, `S.nextInSchedule` refer to the ScheduleCalc API in `schedules.md` section 5, called with the task SLA's schedule and zone.

Main sources:
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/service-level-management-concepts.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/t_CreateAnSLADefinition.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_SLAProcessing.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_SLAConditions.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/r_SLATransitions.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/r_ElapsedTimeCounting.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_SLADuration.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_SLASchedule.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_TimeZonesInSLAs.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/r_TaskSLATable.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/t_UseSLARetroactiveStartAndPause.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/t_ConfigureSLAProperties.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_ScheduledJobsForSLA.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/r_InstalledWithServiceLevelMgmt.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_SLANotifications.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/flows-for-sla.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_RepairSLAs.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_LegacySLAFields.html
- https://www.servicenow.com/docs/r/it-service-management/service-level-management/sla-timer-configurations.html

## 1. Concepts

| Concept | Rule | Status |
|---|---|---|
| SLA definition | Criteria (table, duration, schedule, conditions) that make a task SLA attach | [Documented] |
| Task SLA | One `task_sla` row per definition attached to a task; a task can carry many | [Documented] |
| Type | `SLA`, `OLA`, `Underpinning contract`; reporting only, no engine effect | [Documented] |
| Target | `response`, `resolution` or empty (None); filtering/reporting and timer selection only | [Documented] |
| Engine | ResolvrNow implements the "2011" engine. The 2010 engine and the pre-2010 escalation engine are not implemented; their visible effects are emulated by the compatibility property (section 7.6) | [Documented engine versions] [Inferred scope] |
| Roles | `sla_admin` (properties, repair, definitions), `sla_manager` (definitions, repair logs); both contain `flow_operator` | [Documented] |

## 2. Data model

### 2.1 contract_sla (SLA Definition), extends sys_metadata [SDK]

| Column | Type / default | Meaning | Status |
|---|---|---|---|
| name | string | Display name | [Documented] |
| type | string, default `SLA`; choices SLA, OLA, Underpinning contract | Reporting | [Documented] |
| target | string; choices response, resolution (empty = None) | Reporting, timer selection | [Documented] |
| collection | table_name, default `incident` | Task table the SLA applies to; must be `task` or a descendant | [Documented] |
| active | boolean, true | Only active definitions attach | [Inferred] |
| duration_type | reference cmn_relative_duration; empty = "User specified duration" | Fixed vs relative duration | [Documented] |
| duration | glide_duration | Fixed duration; days count as 24 h blocks of schedule time; max `com.snc.sla.maximum_duration` days | [Documented] |
| relative_duration_works_on | string `Task record` (default) / `SLA record` | Record handed to the relative calculator as `current` | [Documented] |
| schedule_source | `no_schedule`, `sla_definition` (default), `task_field` | Where the schedule comes from | [Documented] |
| schedule | reference cmn_schedule | Used when source = sla_definition | [Documented] |
| schedule_source_field | field_name (dot-walk on collection) | Task path to a cmn_schedule reference, e.g. `cmdb_ci.schedule` | [Documented] |
| timezone_source | default `task.caller_id.time_zone`; also `sla.timezone`, `task.cmdb_ci.location.time_zone`, `task.location.time_zone`, `task.caller_id.location.time_zone` | Zone used for schedule math | [Documented] |
| timezone | string (IANA) | Used when source = sla.timezone | [Documented] |
| start_condition, stop_condition, pause_condition, resume_condition, cancel_condition, reset_condition | conditions (encoded query on collection, max 1000) | Lifecycle conditions | [Documented] |
| when_to_cancel | `no_match` (Start conditions are not met), `on_condition` (Cancel conditions are met), `never` | Cancel policy | [Documented] |
| when_to_resume | `no_match` (Pause conditions are not met), `on_condition` (Resume conditions are met) | Resume policy | [Documented] |
| reset_action | `cancel` (default), `complete` | What happens to the running task SLA on reset | [SDK] |
| retroactive | boolean false | Start time taken from a task date field | [Documented] |
| set_start_to | field_name on collection (date/time fields) | Retroactive start source, e.g. `opened_at`, `sys_created_on` | [Documented] |
| retroactive_pause | boolean, default true | Replay pause time between retroactive start and attach; only for user-specified durations | [Documented] |
| condition_class | reference sla_condition_class | Overrides the global condition rules | [Documented] |
| flow / workflow | reference sys_hub_flow (default "Default SLA Flow") / wf_workflow; mutually exclusive | Started when the task SLA attaches | [Documented] |
| vendor | reference core_company | Informational | [Documented] |
| enable_logging | boolean false | Per-definition debug log of condition matches and before/after values | [Documented] |
| adv_condition_type | none (default), advanced, advanced_journal, advanced_system, advanced_journal_and_system | ResolvrNow stores, ignores (no scripted conditions) | [SDK] [Inferred] |
| sys_overrides | reference contract_sla | Domain override of another definition | [SDK] |
| sys_domain | domain_id, global | Domain separation | [SDK] |

Defaults note: the docs show "Start conditions are not met" as the form default for `when_to_cancel`, and contradict each other for `when_to_resume`; the SDK dictionary declares `on_condition` for both. ResolvrNow applies the SDK dictionary defaults on REST/table inserts and the "Create SLA definition" UI pre-fills `no_match` for both [Inferred].

Validation [Inferred]: user-specified duration must be > 0 and <= `com.snc.sla.maximum_duration` days; `set_start_to` required when `retroactive`; `schedule_source_field` must end in a reference to `cmn_schedule`; flow and workflow cannot both be set.

### 2.2 task_sla (Task SLA)

| Column | Type | Meaning | Status |
|---|---|---|---|
| task | reference task | Owning task | [Documented] |
| sla | reference contract_sla | Definition | [Documented] |
| stage | string, default `in_progress`; choices section 2.3 | Lifecycle stage | [Documented] |
| active | boolean | true while in_progress or paused (also breached stage in compatibility mode) | [Inferred] |
| start_time | glide_date_time | SLA start (may be retroactive, may be in the future) | [Documented] |
| end_time ("Stop time") | glide_date_time | When completed or cancelled | [Documented] |
| pause_time | glide_date_time | Start of the current pause; cleared on resume | [Inferred clear] |
| pause_duration | glide_duration | Total actual paused time of finished pauses | [Documented] |
| business_pause_duration | glide_duration | Total paused time that fell inside the schedule | [Documented] |
| duration ("Actual elapsed time") | glide_duration | Start to calc point minus pause_duration | [Documented] |
| business_duration | glide_duration | Schedule time from start to calc point minus business_pause_duration | [Documented] |
| percentage, business_percentage | percent_complete (2 decimals) | Elapsed / target duration | [Documented] |
| time_left, business_time_left | glide_duration | Remaining actual / schedule time to breach | [Documented] |
| planned_end_time ("Breach time") | glide_date_time | Instant the SLA breaches given pauses so far | [Documented] |
| original_breach_time | glide_date_time | planned_end_time computed at attach | [Documented] |
| has_breached | boolean | Breach flag (2011 engine) | [Documented] |
| schedule | reference cmn_schedule | Schedule snapshot taken at attach | [Documented] |
| timezone | string | Zone snapshot taken at attach | [Documented] |

### 2.3 Stage values

| Value | Label | When | Status |
|---|---|---|---|
| in_progress | In progress | Running (also after breach in 2011 mode) | [Documented] |
| paused | Paused | Pause condition holds | [Documented] |
| completed | Completed | Stop condition met, or reset with reset_action complete | [Documented] |
| cancelled | Cancelled | Cancel rule met, or reset with reset_action cancel | [Documented] |
| breached | Breached | Only when `com.snc.sla.compatibility.breach` = true | [Documented] |
| achieved | Achieved | Compatibility mode label for a completed, non-breached SLA | [Documented] |

### 2.4 Supporting tables

| Table | Purpose | Status |
|---|---|---|
| sla_condition_class (name, class_name -> script include, active) | Condition rule sets; ResolvrNow ships `SLAConditionBase` (default) and `SLAConditionSimple` as TypeScript strategies keyed by name | [Documented] |
| cmn_relative_duration | Relative durations (schedules.md 7) | [Documented] |
| sla_repair_log, sla_repair_log_entry (type Before repair / After repair, task_sla snapshot) | Repair audit | [Documented] |
| sla_timer_config, sla_timer_config_mapping | Preferred-SLA selection for timer widgets (section 11) | [Documented] |
| service_offering_sla | Offering-specific SLA definitions (optional, section 6.1) | [Documented name] |
| resolvr_sla_timer (task_sla, threshold, fire_at, state pending/fired/cancelled) | ResolvrNow internal percentage timers (section 9) | [Inferred, ResolvrNow-only] |

## 3. Properties

| Property | Default | Effect | Status |
|---|---|---|---|
| com.snc.sla.engine.version | 2011 | ResolvrNow accepts only 2011 | [Documented] |
| com.snc.sla.engine.async | false | Run the engine after commit in a background job instead of the synchronous business rule | [Documented] |
| com.snc.sla.compatibility.breach | false | Use `breached`/`achieved` stages (7.6) | [Documented] |
| com.snc.sla.default_conditionclass | SLAConditionBase | Global condition rules | [Documented] |
| com.snc.sla.calculation.percentage | 1000 | Update jobs skip SLAs whose actual percentage exceeds this; 0 stops all job calculations; blank = no limit | [Documented] |
| com.snc.sla.maximum_duration | 1095 (days) | Max definition duration | [Documented] |
| com.snc.sla.workflow.run_for_breached / com.snc.sla.flow.run_for_breached | false | Start workflow/flow even if already breached at attach | [Documented] |
| com.snc.sla.calculate_planned_end_time_after_breach | false | Keep recomputing planned_end_time after breach | [Documented] |
| com.snc.sla.calculation.use_time_left | false | Breach test uses time left instead of the rounded percentage | [Documented] |
| glide.sla.calculate_on_display | false | Recalculate a task's SLAs when its form/record is read | [Documented] |
| com.snc.sla.always_populate_business_fields | true (new installs) | With no schedule, business fields copy actual fields; false leaves them empty | [Documented] |
| com.snc.sla.repair.enabled | true (new installs) | Enables repair | [Documented] |
| com.snc.sla.run_old_sla_engine | false | Legacy escalation engine; ResolvrNow ignores | [Documented] |
| com.snc.sla.*.log, com.snc.sla.log.destination | notice | Logging levels | [Documented] |
| resolvr.sla.sync_legacy_task_fields | false | Maintain task.made_sla / task.sla_due (section 11) | [Inferred, ResolvrNow-only] |

## 4. When the engine runs

1. Business rule "Run SLAs" on `task` (all descendants), after insert and after update, runs `processTask(current, previous, now)` when at least one active definition exists for the record's class [Documented rule name] [Inferred trigger].
2. If `com.snc.sla.engine.async` = true, the same call is queued as a background job after commit with `now` = commit time [Documented].
3. Updates made with engines disabled (ResolvrNow equivalent of `setWorkflow(false)`) do not run the engine [Documented].
4. Updates to `task_sla` by the engine never re-run task business rules on the parent task (no recursion) [Documented guidance].
5. Deleting a task deletes its task SLAs [Inferred].

## 5. Condition evaluation

`matches(cond, task)`: the encoded query is evaluated in memory with ResolvrNow's matcher (`query/matcher.ts`, `MatchSubject` with `previous()` so `VALCHANGES`, `CHANGESFROM`, `CHANGESTO` work on updates; on insert every field counts as changed). Dot-walked fields use current referenced values [Documented: dot-walks are never replayed]. An empty condition never matches [Inferred]; consequently a definition with an empty start condition never attaches.

Rule set `SLAConditionBase` (default) [Documented semantics]:

| Hook | Returns true when |
|---|---|
| attach | start matches AND stop does not match AND NOT (when_to_cancel = on_condition AND cancel matches) |
| complete | stop matches |
| reattach | reset matches AND start matches |
| cancel | when_to_cancel = no_match: start does not match; on_condition: cancel matches; never: false |
| pause | pause matches AND NOT (when_to_resume = on_condition AND resume matches) [Inferred tie-break] |
| resume | when_to_resume = no_match: pause does not match; on_condition: resume matches |

Rule set `SLAConditionSimple` [Documented intent, Inferred detail]: each hook checks only its own condition (attach = start matches; cancel = cancel matches; complete = stop matches; pause = pause matches; resume = resume matches; reattach = reset matches).

Relative durations: pause and resume are never evaluated (pause is not compatible with relative durations) [Documented incompatibility] [Inferred behaviour].

## 6. Lifecycle algorithm

### 6.1 processTask(task, previous, now)

```
defs = active contract_sla where collection == task.sys_class_name            [Inferred: exact class]
       (+ service_offering_sla definitions whose offering == task.service_offering, if that plugin is on)
active = task_sla where task == task.sys_id and stage in (in_progress, paused[, breached])

queue = list(active); fresh = {}
# Pass 1: new SLAs                                                             [Documented]
for D in defs where no row in active has sla == D:
    if rules(D).attach(task): ts = attach(D, task, now); queue.append(ts); fresh.add(ts)   # see 6.3

# Pass 2: one transition per task SLA per run, in this order                   [Documented order]
while queue: ts = queue.pop_front(); D = ts.sla; r = rules(D)
    if r.complete(task):                 complete(ts, now)
    elif ts not in fresh and r.reattach(task):                   # [Inferred] fresh rows skip reattach,
        (D.reset_action == complete ? complete : cancel)(ts, now) # otherwise a VALCHANGES reset would
        ts2 = attach(D, task, now); queue.append(ts2); fresh.add(ts2)   # fire again on insert
    elif r.cancel(task):                 cancel(ts, now)
    elif ts.stage == in_progress and not relative(D) and r.pause(task):  pause(ts, now)
    elif ts.stage == paused and r.resume(task):                          resume(ts, now)
    else:                                calculate(ts, now)                # refresh timings
```

Consequences [Documented]: a start condition contained in the stop condition never attaches; a pause condition implied by the start condition gives an SLA that attaches already paused; a pause state outside the start condition cancels instead of pausing. A completed or cancelled task SLA does not block a new attach of the same definition (e.g. reopened incident) [Inferred].

### 6.2 State machine

| From | Event | To | Side effects |
|---|---|---|---|
| (none) | attach | in_progress (or paused if pause hook true in pass 2) | 6.3 |
| in_progress | pause | paused | pause_time = now; timings frozen; pending timers cancelled |
| paused | resume | in_progress | pause_duration += now - pause_time; business_pause_duration += S.duration(pause_time, now); pause_time = null; recompute planned_end_time and timers |
| in_progress / paused | complete | completed (compat: achieved or breached) | close pause as in resume; end_time = now; final calculate at now; active = false; cancel timers |
| in_progress / paused | cancel | cancelled | close pause; end_time = now; final calculate; active = false; cancel timers |
| in_progress / paused | reattach | completed or cancelled per reset_action, plus a new task SLA | as complete/cancel, then 6.3 |
| completed, cancelled | any | unchanged | terminal (only repair rewrites) |

The pause bookkeeping fields change only when a pause ends [Documented: pause duration updates after leaving pause].

### 6.3 attach(D, task, now)

1. Zone `z` = value at D.timezone_source (`sla.timezone` uses D.timezone); empty or invalid -> system zone `glide.sys.default.tz` [Documented fallback].
2. Schedule `S`: no_schedule -> null; sla_definition -> D.schedule (null if empty); task_field -> value of D.schedule_source_field on task (null if empty) [Documented]. Null means 24x7.
3. `start_time` = task[D.set_start_to] if D.retroactive and that value is non-empty, else `now` [Documented]. A start in the future is kept; elapsed stays 0 until then [Documented: expected start].
4. Insert `task_sla` {stage in_progress, active true, pause totals 0, schedule S, timezone z}.
5. Retroactive pause [Documented intent, Inferred algorithm]: if D.retroactive and D.retroactive_pause and duration is user-specified and start_time < now, replay task history (ResolvrNow `sys_audit`) over `[start_time, now]`: reconstruct the task version effective at start_time and at every later audited update; walk them in time order applying the pause/resume hooks; each closed pause adds `t_end - t_begin` to pause_duration and `S.duration(t_begin, t_end)` to business_pause_duration; if the last state is paused, set stage paused and pause_time = that pause's begin. Tables without audit skip the replay.
6. `calculate(ts, now)`; set `original_breach_time = planned_end_time`.
7. If `has_breached` is already true and the matching `run_for_breached` property is false, do not start flow/workflow/timers [Documented]. Otherwise start them (section 9).

### 6.4 Complete, cancel, reset
Complete and cancel close any open pause first (same arithmetic as resume, at `now`), then compute final timings at `end_time = now` [Inferred for cancel]. Completion never clears `has_breached` [Documented: completes regardless of breach].

## 7. Time calculations

### 7.1 Target duration T
- User-specified: `T = D.duration` (read from the definition at every calculation, so definition edits affect running SLAs; schedule and zone stay snapshotted) [Inferred].
- Relative: `planned_end_time` comes from the calculator (7.4), and `T = S.duration(start_time, planned_end_time)` (or the plain difference without schedule), fixed at attach [Inferred].

### 7.2 calculate(ts, now)
```
n  = ts.stage == paused ? ts.pause_time : (ts.active ? now : ts.end_time)
P  = pause_duration; BP = business_pause_duration
duration          = max(0, (n - start) - P)
business_duration = S ? max(0, S.duration(start, n) - BP)
                      : (always_populate_business_fields ? duration : null)
if user-specified and not (has_breached and not calculate_planned_end_time_after_breach):
    planned_end_time = S ? S.add(start, T + BP) : start + T + P
percentage          = round2(100 * duration / T)
business_percentage = business_duration == null ? null : round2(100 * business_duration / T)
time_left           = max(0, planned_end_time - n)
business_time_left  = S ? max(0, T - business_duration) : (always_populate ? time_left : null)
```
All formulas **[Documented]** for meaning (elapsed minus pause, breach time adjusted by business pause when a schedule exists and by actual pause otherwise, percentages against the definition duration: e.g. 60.5 h actual and 1.5 h business on an 8 h SLA give 756.25 % and 18.75 %). Rounding `round2` = half-up to 2 decimals [Documented]. When `S.add` returns null, planned_end_time is left empty and the SLA never breaches [Inferred].

### 7.3 Breach test (after every calculate) [Documented]
```
eff_pct  = business_percentage ?? percentage
eff_left = S ? business_time_left : time_left
breachedNow = use_time_left ? (eff_left <= 0 and n >= start) : (eff_pct >= 100.00)
if breachedNow and not has_breached: has_breached = true; (compat) stage = breached; fire 100 % timer if still pending
```
`has_breached` never returns to false outside repair [Inferred]. In 2011 mode the stage stays `in_progress` and timing continues until the stop condition [Documented].

### 7.4 Relative durations [Documented rules, Inferred mechanics]
`planned_end_time = calculator(D.duration_type, ctx)` where ctx = {start_time, schedule S, zone z, current = task or task SLA per relative_duration_works_on}. "Breach on Due Date": use task.due_date; empty or already past at attach -> start_time + 1 s; outside the schedule -> `S.nextInSchedule(due)` (schedule 08:00-16:00, due Wed 2017-01-11 20:30 gives Thu 2017-01-12 08:00). Other calculators: schedules.md section 7.

### 7.5 Recalculation triggers
On every engine run for the task (pass 2 else-branch), on each update job (section 8), on timer fire, on resume/complete/cancel, and on task read when `glide.sla.calculate_on_display` is true [Documented].

### 7.6 Compatibility mode (`com.snc.sla.compatibility.breach` = true) [Documented]
On breach, stage becomes `breached` (still active, still timing). On complete: stage = `breached` if has_breached else `achieved`. Paused/resume work as usual from `breached` (resume returns to `breached` when has_breached) [Inferred].

## 8. SLA update jobs [Documented names, cadences and windows]

Each job recalculates (`calculate` + breach test) active task SLAs in stage in_progress (or breached) whose `planned_end_time` falls in its window, skipping rows with `percentage > com.snc.sla.calculation.percentage` (unless blank; 0 disables all). Paused rows are not recalculated.

| sysauto name | Repeat | Selects planned_end_time in |
|---|---|---|
| SLA update (breach within 10 min) | 1 min | [now, now + 10 min) |
| SLA update (breach within 1 hour) | 10 min | [now + 10 min, now + 1 h) |
| SLA update (breach within 1 day) | 1 h | [now + 1 h, now + 24 h) |
| SLA update (breach within 30 days) | 1 day | [now + 1 day, now + 30 days) |
| SLA update (breach after 30 days) | 5 days | [now + 30 days, now + 365 days) |
| SLA update (already breached) | 1 day | [now - 365 days, now) |

Writes from jobs use engine-disabled updates so the task is not touched [Inferred].

## 9. Percentage timers, flows and notifications

ResolvrNow implements "Default SLA Flow" natively [Inferred]: at attach (subject to 6.3 step 7) it creates `resolvr_sla_timer` rows for thresholds 50, 75 and 100 of business elapsed percentage [Documented thresholds and business basis]:
```
fire_at(p) = S ? S.add(start, p/100 * T + BP) : start + p/100 * T + P
```
- Timers already past at creation fire immediately, in ascending order [Inferred].
- On pause: pending timers -> cancelled. On resume: recreate pending thresholds with the new BP/P. On complete/cancel: cancel all [Documented: timers do not advance while paused].
- On fire: `calculate(ts, now)`; if the stage is still running, queue the event; the 100 timer also performs the breach test.

| Threshold | Event (table task_sla, parm1 = task sys_id, parm2 = threshold) | Recipients | Status |
|---|---|---|---|
| 50 % | `sla.warning.50` | task.assigned_to, task.cmdb_ci.supported_by | [Documented recipients] [Inferred event names] |
| 75 % | `sla.warning.75` | task.assigned_to, task.assigned_to.manager | [Documented recipients] |
| 100 % | `sla.breached` | task.assigned_to, task.assigned_to.manager | [Documented recipients] |

A definition whose `flow`/`workflow` is cleared gets no timers or events. Custom flows are out of scope for v1; ResolvrNow exposes the events so notifications can be configured on them [Inferred]. Notification bodies must not rely on stored percentages being current (they reflect the last calculation) [Documented caveat].

## 10. Repair [Documented purpose, Inferred algorithm]

Available when `com.snc.sla.repair.enabled`. Input: task SLAs or tasks (never whole definitions). For each task:
1. Create `sla_repair_log` (initiated_by, start, end, state); write a "Before repair" entry per existing task SLA.
2. Delete the task's task SLAs and pending timers.
3. Rebuild versions of the task from `sys_audit` (creation then each update, in time order). For each version at time `t_i`, run `processTask(version_i, version_{i-1}, t_i)` with flows suppressed. Dot-walked values use current data.
4. Final `calculate(ts, now)` for active rows; recreate timers (flows run normally from now; thresholds already passed are not re-sent [Inferred]).
5. Write an "After repair" entry per resulting task SLA (only-before = deleted, only-after = new).
ResolvrNow endpoint: `POST /api/app/sla/repair` body `{"task_sla": [sys_id...]}` or `{"task": [sys_id...]}`, role sla_admin, returns the repair log sys_id [Inferred, ResolvrNow-only].

## 11. Legacy task fields and preferred SLA

- `task.made_sla` (default true), `task.sla_due`, `task.escalation` are legacy and the 2011 engine does not update them [Documented]. Equivalents: `task_sla.planned_end_time` for SLA due, `NOT task_sla.has_breached` for made SLA [Documented].
- When `resolvr.sla.sync_legacy_task_fields` = true, after each engine run ResolvrNow sets `made_sla = false` once any task SLA of the task has breached (never back to true) and `sla_due = min(planned_end_time)` over in_progress task SLAs (empty when none), written without re-running engines [Inferred, ResolvrNow-only].
- Preferred SLA ("First to breach") for UI timers: among the task's task SLAs filtered by optional target, pick the in_progress one with the earliest planned_end_time; if all running ones are breached, the one that breached first; include completed/cancelled only when the config's show flags are set (defaults when no config: first to breach, show cancelled and completed true) [Documented].

## 12. REST surface

`contract_sla`, `task_sla`, `sla_condition_class`, `cmn_relative_duration` are exposed through the generic Table API. `task_sla` time fields are engine-owned: client writes to them are ignored (except by sla_admin during repair tooling) [Documented guidance: do not write engine fields] [Inferred enforcement].

## 13. Acceptance tests

Fixtures: system zone UTC; incident states 1 New, 2 In Progress, 3 On Hold, 6 Resolved, 8 Canceled. **P1** = {collection incident, duration 8 h, schedule none, start `priority=1^active=true`, stop `state=6`, pause `state=3`, when_to_cancel no_match, when_to_resume no_match, reset_action cancel, flow default}. **W** = "8-5 weekdays" 08:00-17:00 weekdays, floating. 2025-03-03 is a Monday. The clock is frozen per step with the engine's test clock.

1. Given P1, When an incident is inserted at Mon 09:00 with priority 1, state 1, Then one task SLA exists: stage in_progress, active, start 09:00, planned_end_time and original_breach_time 17:00, has_breached false, timezone UTC.
2. Given P1, When an incident is inserted with priority 1 and state 6, Then no task SLA is created.
3. Given test 1, When calculated at 13:00, Then duration 4 h, percentage 50.00, time_left 4 h, business fields equal to actual ones.
4. Given test 1 and `always_populate_business_fields` false, When calculated at 13:00, Then business_duration, business_percentage and business_time_left are empty.
5. Given test 1, When state becomes 3 at 10:00 and the SLA is calculated at 11:00, Then stage paused, pause_time 10:00, duration 1 h, pause_duration 0.
6. Given test 5, When state becomes 2 at 12:00, Then stage in_progress, pause_duration 2 h, pause_time empty, planned_end_time 19:00.
7. Given test 6, When state becomes 6 at 18:00, Then stage completed, active false, end_time 18:00, duration 7 h, percentage 87.50, has_breached false.
8. Given test 1 with no further updates, When the 1-minute job runs at 17:00:00, Then has_breached true, stage in_progress, percentage 100.00, time_left 0.
9. Given test 8, When the incident is resolved at 18:00, Then stage completed and has_breached stays true.
10. Given `com.snc.sla.compatibility.breach` true, When test 8 runs, Then stage breached; after resolve stage stays breached; an SLA resolved before breach ends in stage achieved.
11. Given P1 and P2 (same as P1 with `priority=2`), When priority changes 1 -> 2 at 10:00, Then the P1 task SLA is cancelled with end_time 10:00 and a P2 task SLA starts at 10:00.
12. Given P1 with when_to_cancel never, When priority changes to 2, Then the P1 task SLA stays in_progress.
13. Given P1 with when_to_cancel on_condition and cancel `state=8`, When priority changes to 2, Then nothing changes; When state becomes 8, Then the task SLA is cancelled; and an insert matching start and `state=8` attaches nothing.
14. Given P1 with reset `assignment_groupVALCHANGES` and reset_action cancel, When the incident is inserted with a group, Then exactly one task SLA exists; When the group changes at 11:00, Then the old task SLA is cancelled and a new one starts at 11:00 with planned end 19:00.
15. Given test 14 with reset_action complete, Then the old task SLA ends in stage completed.
16. Given P1 with pause `active=true` (implied by start), When the incident is inserted at 09:00, Then the task SLA attaches already paused with pause_time 09:00.
17. Given P1 with start `state IN1,2^priority=1` and pause `state=3`, When state becomes 3, Then the task SLA is cancelled, not paused.
18. Given P1 with when_to_resume on_condition and resume `state=2`, When a paused SLA's state goes 3 -> 1, Then it stays paused; When 1 -> 2, Then it resumes.
19. Given P1 with schedule W, When an incident starts Mon 14:00, Then planned_end_time is Tue 13:00; at Tue 09:00 business_duration 4 h, business_percentage 50.00, duration 19 h, percentage 237.50.
20. Given P1 with schedule W, When an incident opens Fri 2025-03-07 21:00 and is calculated Mon 2025-03-10 09:30, Then business_duration 1 h 30 min (18.75 %) and duration 60 h 30 min (756.25 %).
21. Given P1 with duration 1 day and schedule W, When the SLA starts Mon 08:00, Then planned_end_time is Wed 17:00.
22. Given P1 with schedule W started Mon 09:00, When paused 11:00 and resumed 14:00 the same day, Then pause_duration 3 h, business_pause_duration 3 h, planned_end_time Tue 11:00.
23. Given P1 with schedule W started Mon 09:00, When paused Mon 16:00 and resumed Tue 09:00, Then pause_duration 17 h, business_pause_duration 2 h, planned_end_time Tue 10:00.
24. Given P1 with retroactive true and set_start_to opened_at, When an incident opened at 08:00 as priority 3 becomes priority 1 at 11:00, Then start_time 08:00, planned_end_time 16:00, duration at 11:00 is 3 h.
25. Given test 24 where priority becomes 1 at 17:30, Then has_breached is true at attach and no timers or events are created; with `com.snc.sla.flow.run_for_breached` true the 50, 75 and 100 events are queued immediately in that order.
26. Given P1 retroactive with retroactive_pause true and audit history state 1 at 08:00, 3 at 09:00, 2 at 10:00, priority 1 at 11:00, Then pause_duration 1 h and planned_end_time 17:00; with retroactive_pause false, pause_duration 0 and planned end 16:00.
27. Given P1 with schedule W and timezone_source caller, When the caller zone is America/New_York and the incident starts 2025-03-03 12:00Z, Then task_sla.timezone is America/New_York and planned_end_time is 21:00Z.
28. Given test 27 with a caller without a zone, Then task_sla.timezone is the system zone (UTC) and planned_end_time is Tue 2025-03-04 11:00Z (5 h on Monday from 12:00Z, then 3 h from Tuesday 08:00Z).
29. Given P1 with duration 4 h, schedule W, zone America/New_York, When the SLA starts Fri 2025-03-07 21:00Z (16:00 EST), Then planned_end_time is Mon 2025-03-10 15:00Z across the DST change.
30. Given P1 with schedule "W excluding holidays" and an excluded Tue 2025-03-04, When the SLA starts Mon 16:00, Then planned_end_time is Wed 2025-03-05 15:00.
31. Given schedule_source task_field with field `cmdb_ci.schedule`, When the CI has schedule W, Then task_sla.schedule = W; When the CI has none, Then task_sla.schedule is empty and 24x7 math applies.
32. Given P1 (8 h, no schedule) at 28 799.6 s elapsed, Then with use_time_left false percentage rounds to 100.00 and has_breached becomes true; with use_time_left true has_breached stays false until time_left reaches 0.
33. Given P1 started 09:00, Then `resolvr_sla_timer` rows fire `sla.warning.50` at 13:00, `sla.warning.75` at 15:00 and `sla.breached` at 17:00; When paused 12:00 to 13:00, Then they move to 14:00, 16:00 and 18:00; When completed at 15:30, Then the 100 timer is cancelled.
34. Given the 50 % event, Then notifications go to the assignee and the CI's supported_by user; the 75 % and 100 % ones go to the assignee and the assignee's manager.
35. Given task SLAs with planned_end_time now + 5 min, now + 2 days, now - 400 days, and one breached with percentage 1200, Then only the first is picked by the 10-minute job, the second by the 30-day job, and the last two by no job.
36. Given a breached SLA and `calculate_planned_end_time_after_breach` false, When it is paused and resumed for 1 h, Then planned_end_time does not move; with the property true it moves by 1 h.
37. Given a relative definition "Breach on Due Date" with schedule 08:00-16:00 weekdays, When due_date is Wed 2017-01-11 20:30, Then planned_end_time is Thu 2017-01-12 08:00; When due_date is empty or in the past, Then planned_end_time = start_time + 1 s.
38. Given relative "End of next business day" with schedule W, When the SLA starts Fri 2025-03-07 10:00, Then planned_end_time is Mon 2025-03-10 17:00, and setting state 3 does not pause it.
39. Given an incident resolved (task SLA completed) and later reopened to state 2, Then a second P1 task SLA attaches and the completed one is untouched.
40. Given P1 resolution and a response definition (stop `assigned_toISNOTEMPTY`), When a P1 incident is inserted and assigned 20 min later, Then two task SLAs attach and only the response one completes at the assignment.
41. Given a definition with an empty start condition, When any incident is saved, Then it never attaches.
42. Given the duration of P1 is changed from 8 h to 10 h while a task SLA runs, When the next calculation happens, Then planned_end_time moves by 2 h; When repair runs, Then the log has one Before and one After entry and the rebuilt SLA equals a fresh replay of the audit history.
43. Given `resolvr.sla.sync_legacy_task_fields` false, When a task SLA breaches, Then task.made_sla stays true; with it true, made_sla becomes false and sla_due equals the earliest in_progress planned_end_time.
44. Given `com.snc.sla.engine.async` true, When an incident is inserted, Then no task SLA exists inside the insert transaction and one exists after the background job with start_time equal to the commit time.
