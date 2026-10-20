# ResolvrNow events and notifications specification

Scope: the system event queue, email notifications (definition, triggering, recipients, content, duplicates, watermarks, digests), the outbound email record and delivery, inbound email processing, and notification preferences.

Conventions: **[Documented]** = stated in the ServiceNow Brazil docs corpus (URL cited per section, restated in our own words); **[Inferred]** = derived from the SDK data model, known platform behavior or a ResolvrNow decision. Cross references: `platform-core.md` (save pipeline §4.2, ACLs §2), `approvals-flows.md` (approval emails), `data/platform.json` (choices, tables, properties).

ResolvrNow engine stance [Inferred, ResolvrNow decision]: the engine is synchronous. Everything that ServiceNow does "later" (event processing, email generation for events, digests, SMTP sending, inbound processing) is written to a durable SQLite queue inside the request transaction and drained by an in-process scheduler loop that runs outside any request transaction. Each queue item is processed in its own transaction.

---

## 1. System events

Sources: https://www.servicenow.com/docs/r/platform-administration/system-events/system-events-landing.html · https://www.servicenow.com/docs/r/platform-administration/system-events/exploring-system-events.html · https://www.servicenow.com/docs/r/platform-administration/system-events/events.html · https://www.servicenow.com/docs/r/platform-administration/system-events/c_EventRegistry.html · https://www.servicenow.com/docs/r/platform-administration/system-events/auto-job-scheduling.html · https://www.servicenow.com/docs/r/platform-administration/system-events/t_CreateYourOwnEvent.html · https://www.servicenow.com/docs/r/platform-administration/system-events/move_event.html · https://www.servicenow.com/docs/r/platform-administration/system-events/t_PassEventParameters.html · https://www.servicenow.com/docs/r/platform-administration/system-events/t_RegisterAnEvent.html · https://www.servicenow.com/docs/r/platform-administration/system-events/t_ReprocessAnEvent.html · https://www.servicenow.com/docs/r/platform-administration/system-events/event-logs-2.html · https://www.servicenow.com/docs/r/platform-administration/system-events/r_EventStates.html · https://www.servicenow.com/docs/r/platform-administration/system-events/r_BuildAScript.html · https://www.servicenow.com/docs/r/platform-administration/system-events/r_GlobalEvents.html · https://www.servicenow.com/docs/r/platform-administration/system-events/r_ScriptActions.html · https://www.servicenow.com/docs/r/platform-administration/system-events/r_ChangeEventsSampleScripts.html · https://www.servicenow.com/docs/r/platform-administration/r_BaselineEmailNotifications.html

### 1.1 Event record (`sysevent`)

| Field | Meaning | Basis |
|---|---|---|
| `name` | Event name, conventionally `<table>.<action>` (e.g. `incident.commented`) | Documented |
| `parm1`, `parm2` | Free strings passed by the producer (sys_id, field value, recipient list) | Documented |
| `table` | Table of the record that raised the event | Documented |
| `instance` | sys_id of that record | Documented |
| `state` | `ready`, `processed`, `error`, `transferred` | Documented |
| `queue` | Processor queue name (empty = default queue) | Documented |
| `processed` | When processing started | Documented |
| `processing_duration` | Milliseconds spent ("Processing time") | Documented label, Inferred column |
| `uri` | Request URI that produced the event | Documented |
| `user_id`, `user_name` | Session user who queued the event (the "event creator") | Documented (`event.user_id`), Inferred (`user_name`) |
| `process_on` | Earliest processing time (scheduled events) | Inferred |
| `claimed_by` | Worker that claimed it | Inferred |
| `resolvr_snapshot` | JSON image of the record at queue time (ResolvrNow extension, used when the record no longer exists, e.g. delete events) | Inferred, ResolvrNow decision |
| `sys_created_on` | Queue time ("Created") | Documented |

States [Documented]: `ready` = waiting in the queue; `processed` = handled (handling does not imply any consumer acted); `error` = processing failed (often bad parameters), can be reprocessed; `transferred` = moved to another table shard and duplicated there (ResolvrNow never shards; accepted on import only).

### 1.2 Producing events

- Business rules decide when to queue an event: "if a condition holds for the record, queue event X" [Documented].
- API `gs.eventQueue(name, record, parm1, parm2[, queue])`: record is usually `current` (a GlideRecord in scheduled scripts) [Documented]. ResolvrNow also offers `gs.eventQueueScheduled(name, record, parm1, parm2, glideDateTime)` setting `process_on` [Inferred].
- The insert into `sysevent` bypasses business rules on the event table [Documented].
- ResolvrNow rules [Inferred]: `table` = record class, `instance` = record sys_id, `user_id`/`user_name` = session user, `resolvr_snapshot` captured for every event; the row commits with the producing transaction (an aborted/rolled-back save leaves no event).
- Baseline parameter conventions [Documented]: `<table>.inserted`, `.updated`, `.commented` carry `(gs.getUserID(), gs.getUserName())`; `change.assigned` carries (new assignee display value, previous assignee display value); `change.priority.1` carries (new priority, old priority); calendar events carry assignee references.
- Global helper: a business rule can call a global events function for a table, which queues `<table>.inserted`, `.updated`, `.commented`, `.assigned`, `.inactive` as applicable [Documented]. ResolvrNow ships it as `gs.globalEvents(current, previous)` in the sandbox [Inferred].

### 1.3 Event registry (`sysevent_register`, SDK)

Fields: `event_name`, `table`, `queue` (lowercase letters/underscore only), `priority` (lower = earlier, default 100), `derived_priority`, `caller_access` (restriction/tracking), `fired_by` (informational only), `description`, `preserve_null_parm1` [SDK + Documented].

- Registration makes the event selectable by notifications and script actions [Documented].
- Priority ordering is active while `com.glide.sysevent.priority.enabled=true` (default) [Documented].
- ResolvrNow processes unregistered events too and writes a `syslog` warning once per name per day [Inferred].

### 1.4 Processing

Documented: scheduled jobs read the queue and dispatch each event to handlers (script actions, notifications, workflow activities, inactivity monitors); custom queues isolate busy events; events can be moved between the default and an isolated queue; "Reprocess Event" puts an event back in the queue; queue registration chooses parallel or sequential processing (sequential = strictly one at a time, order preserved; the choice is immutable after creation); upgrade-time processing is limited to events listed in `glide.event_processor.upgrade_safe_events` unless `glide.event_processor.all_events_upgrade_safe=true`.

ResolvrNow processor [Inferred]:

```
every resolvr.events.poll_interval_ms (default 1000):
  for queue in registered queues ∪ {default}:
     batch = sysevent(state='ready', queue=queue, process_on <= now or empty)
             order by registry priority asc, sys_created_on asc, sys_id asc   limit 200
     for ev in batch (sequentially):
        mark processed=now, claimed_by=worker
        record = load(ev.table, ev.instance) ?? fromSnapshot(ev.resolvr_snapshot)
        errors = []
        run script actions for ev.name             (§1.5)  collecting errors
        run event notifications for ev.name        (§2)    collecting errors
        resume waiting flow contexts subscribed to ev.name (approvals-flows §8)
        ev.state = errors empty ? 'processed' : 'error'; ev.processing_duration = elapsed
```

- Each handler runs in its own transaction as the event creator (`user_id`) when that user is active, else as `system` [Inferred].
- "Reprocess" sets `state='ready'` and clears `processed` [Documented action].
- Retention: processed events older than 7 days are deleted by a cleanup job (ResolvrNow default, property `resolvr.events.retention_days`) [Inferred].

### 1.5 Script actions (`sysevent_script_action`, SDK)

Fields: `name`, `event_name`, `active` (default false), `order` (execution order), `condition_script`, `script`, `synchronous` [SDK + Documented]. The script receives `event` (the `sysevent` GlideRecord: `event.parm1`, `event.parm2`, `event.sys_created_on`, `event.user_id`) and `current` (the record the event was queued for) [Documented]. The condition script is evaluated first; the script runs only when it is true [Documented]. Role to manage: `sysevent_script_action_admin` or admin [Documented].

ResolvrNow [Inferred]: `synchronous=true` runs the action immediately after the producing transaction commits, before the request returns; otherwise it runs in the event processor, ordered by `order`.

### 1.6 Baseline ITSM events

From the baseline notification catalogue [Documented]:

| Event | Producer rule | Typical consumer |
|---|---|---|
| `incident.inserted`, `incident.updated`, `incident.commented`, `incident.assigned`, `incident.assigned.to.group` | incident events | Incident Opened, Incident Opened & Unassigned, Incident Commented, Email assigned to / to group, Incident Resolved, Incident Closed |
| `change.inserted`, `change.updated`, `change.assigned`, `change.assigned.to.group`, `change.commented`, `change.worknoted`, `change.approved`, `change.rejected`, `change.priority.1`, `change.risk.1`, `change.calendar.notify`, `change.calendar.notify.remove` | change events, task events | Change notifications |
| `change_task.assigned`, `change_task.assigned.to.group`, `change_task.worknoted` | change task events | Change task notifications |
| `problem.worknoted`, `problem_task.assigned`, `problem_task.assigned.to.group`, `problem_task.worknoted` | problem / problem task events | Problem notifications |
| `approval.inserted`, `approval.rejected`, `approval.rejected.by.other` | approver changes / approval events | Approval Request, Approval Rejected (by Other) |
| `request.approval.inserted`, `request.approval.rejected`, `request.approval.cancelled` | approval events | Catalog approval notifications |
| `sc_request.approved`, `sc_request.assigned`, `sc_request.updated`, `sc_request.requested_for`, `sc_req_item.assigned`, `sc_req_item.delivery`, `sc_task.assigned.to.user`, `sc_task.assigned.to.group` | sc_request / sc_task events | Request notifications |
| `task.approved` | task events | Task approved |
| `kb.submission.closed_created`, `kb.submission.closed_duplicate`, `kb.submission.closed_invalid` | KB event | Knowledge notifications |
| `reminder.notify`, `reminder.notify.delete`, `reminder.notify.email` | reminder engine | Reminders |

Module specs own the producing rules; the platform owns the queue, the registry and the dispatch.

---

## 2. Email notifications

Sources: https://www.servicenow.com/docs/r/platform-administration/c_EmailNotifications.html · https://www.servicenow.com/docs/r/platform-administration/t_CreateANotification.html · https://www.servicenow.com/docs/r/platform-administration/create-notification-categories.html · https://www.servicenow.com/docs/r/platform-administration/control-visibility-emails.html · https://www.servicenow.com/docs/r/platform-administration/c_OptSpecifyingAdvancedCond.html · https://www.servicenow.com/docs/r/platform-administration/notification-variables.html · https://www.servicenow.com/docs/r/platform-administration/c_EnablingLinksToServiceNowRecords.html · https://www.servicenow.com/docs/r/platform-administration/c_ChangeTheLinkText.html · https://www.servicenow.com/docs/r/platform-administration/c_LinkToRelatedRecords.html · https://www.servicenow.com/docs/r/platform-administration/email-unsubscribe.html · https://www.servicenow.com/docs/r/platform-administration/c_ScriptingForEmailNotifications.html · https://www.servicenow.com/docs/r/platform-administration/r_MailScriptAPI.html · https://www.servicenow.com/docs/r/platform-administration/r_ExScptEmlNtfn.html · https://www.servicenow.com/docs/r/platform-administration/c_HandlingLineBreaks.html · https://www.servicenow.com/docs/r/platform-administration/c_SpecifyingTheTimeZone.html · https://www.servicenow.com/docs/r/platform-administration/c_EmailTemplates.html · https://www.servicenow.com/docs/r/platform-administration/t_CreateAnEmailTemplate.html · https://www.servicenow.com/docs/r/platform-administration/r_ConstructAnEmailMessage.html · https://www.servicenow.com/docs/r/platform-administration/email-layouts.html · https://www.servicenow.com/docs/r/platform-administration/create-email-layout.html · https://www.servicenow.com/docs/r/platform-administration/c_WorkingWithWatermarks.html · https://www.servicenow.com/docs/r/platform-administration/t_CreatingCustomWatermarkPrefixes.html · https://www.servicenow.com/docs/r/platform-administration/t_OmitWatermarksIndEmailNotif.html · https://www.servicenow.com/docs/r/platform-administration/t_HidingWatermarksGlobally.html · https://www.servicenow.com/docs/r/platform-administration/email-digests.html · https://www.servicenow.com/docs/r/platform-administration/create-digest-intervals.html · https://www.servicenow.com/docs/r/platform-administration/configure-email-digest.html · https://www.servicenow.com/docs/r/platform-administration/c_JournalFields.html · https://www.servicenow.com/docs/r/platform-user-interface/c_DotWalking.html · https://www.servicenow.com/docs/r/platform-user-interface/t_ConfigNotifications4WatchLists.html · https://www.servicenow.com/docs/r/platform-administration/user-administration/t_CreateAGroup.html · https://www.servicenow.com/docs/r/build-workflows/approvals/c_ReceiveNotifications.html · https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/c_PrecBetweenAssignmentAndBusRules.html

### 2.1 Notification record (`sysevent_email_action`, extends `sysrule`, SDK)

| Tab | Fields |
|---|---|
| Header | `name`, `collection` (table), `type` (`email` default; meeting invitation), `active`, `category` (→ `sys_notification_category`, mandatory), `digestable` (Allow Digest), `description`, `order` |
| When to send | `generation_type` (`engine` default = record inserted or updated, `event`, `triggered`), `weight` (default 0), `condition`, `action_insert`, `action_update`, `event_name`, `advanced_condition` |
| Who will receive | `recipient_users`, `recipient_fields`, `recipient_groups`, `exclude_delegates`, `send_self` (default true), `event_parm_1`, `event_parm_2`, `subscribable`, `mandatory`, `force_delivery` |
| What it will contain | `template`, `subject` (100), `message_html`, `message_text`, `sms_alternate`, `importance`, `content_type` (default `text/html`), `include_attachments`, `omit_watermark`, `from`, `reply_to`, `push_message_only`, `message_list`, `style` (stationery), `enable_dynamic_translation` |
| What digest will contain | `digest_type` (`single` default / `multiple`), `default_digest` (enable by default), `default_interval`, `digest_template`, `digest_subject`, `digest_html`, `digest_separator_html` (default `<br><hr><br>`), `digest_text`, `digest_separator_text`, `digest_from`, `digest_reply_to` |

Value sets [Inferred unless noted]: `generation_type` = `engine` | `event` | `triggered`; `type` = `email` | `vcalendar`; `content_type` = `multipart/alternative` (HTML and plain text) | `text/html` (HTML only, default [SDK]) | `text/plain`; `importance` = `low` | `high`; `digest_type` = `single` | `multiple` [Documented labels].

### 2.2 When to send

| Rule | Basis |
|---|---|
| `engine`: fires after a DB insert (`action_insert`) and/or update (`action_update`) on the table when `condition` matches. | Documented |
| `event`: fires when an event named `event_name` is processed for a record of the table. | Documented |
| `triggered`: fires only when a flow's notification step names it. | Documented (send-when option), Inferred (value) |
| `condition` (condition builder) and `advanced_condition` (script) must both be true; the script sees `current` and `event` and either returns a boolean or sets `answer`; when unscripted branches leave `answer` untouched its last assigned value counts. | Documented |
| Notifications on `task` itself are unsupported; ResolvrNow refuses to save `collection=task` (HTTP 400). Notifications on other parent tables apply to child-class records. | Documented (task), Inferred (rest) |
| Engine timing: produced by the "table notifications" after-engine, i.e. after after-rules with order < 1000; record-operation notifications are emitted before event-based ones, both ordered by weight. | Documented |
| No notifications are produced for writes done with `setWorkflow(false)`. | Inferred |
| Change operators (`VALCHANGES`, `CHANGESTO`, `CHANGESFROM`) work for `engine` notifications (previous known); for `event` notifications they evaluate false. | Inferred |
| Event-based conditions are evaluated against the record as loaded at processing time (snapshot if deleted). | Inferred |

### 2.3 Who receives: resolution algorithm

```
recipients(n, current, event, actor):
  T = new OrderedSet()                                     // entries: {user?, address}
  addUsers(T, n.recipient_users)                                                  [Documented]
  for g in n.recipient_groups: expandGroup(T, g, isApproval(n))                   [Documented]
  for path in n.recipient_fields (dot-walk allowed):                              [Documented]
     v = dotwalk(current, path)
     reference to sys_user        → add user
     reference to sys_user_group  → expandGroup
     glide_list (watch_list etc.) → each token: user sys_id → user; group sys_id → expandGroup;
                                    email address → raw address
     string containing addresses  → raw addresses
  if n.generation_type == 'event':
     if n.event_parm_1: addTokens(T, split(event.parm1, ','))                     [Documented]
     if n.event_parm_2: addTokens(T, split(event.parm2, ','))
        // token = user sys_id | group sys_id | user_name | email address        [Inferred]
  if n.subscribable: add users holding an active subscription row for n           [Inferred]
  if !n.exclude_delegates: for each user u in T: add active notification delegates of u   [Documented option]
  FILTER:
     drop users with active=false                                                  [Documented]
     drop users without a usable address (primary email device, else sys_user.email)  [Documented]
     drop actor (event.user_id, or session user for engine) unless n.send_self    [Documented]
     drop users who unsubscribed from n, unless n.mandatory or n.force_delivery   [Inferred]
     drop users with sys_user.notification == 1 (disabled), unless n.force_delivery   [Inferred]
     drop the instance's own sending address                                      [Documented]
  do NOT filter by ACLs: recipients may lack read access to the record             [Documented]
  return T

expandGroup(T, g, isApproval):
  if g.email nonEmpty: add g.email
  if g.email empty or g.include_members or isApproval:                            [Documented: approval exception]
     add each member u (sys_user_grmember)
     if g.manager and !g.exclude_manager: add g.manager                           [Documented meaning, Inferred placement]
```

Notes:
- Recipient lists are static (`recipient_users`, `recipient_groups`) or record-dependent (`recipient_fields`) [Documented].
- Watch lists notify only when a notification names `watch_list` in `recipient_fields` [Documented].
- More than `glide.email.smtp.max_recipients` (default 100) recipients split into several `sys_email` rows of at most 100 recipients each; keep lists under 1000 [Documented].
- A recipient explanation log is written per email (included/excluded with reason) when `glide.notification.recipient.include_logging` / `exclude_logging` are true (default true) [Documented].
- Each recipient gets one copy of the content rendered once per email (not per recipient) [Inferred]; per-recipient personalization requires mail scripts using `email.addAddress` (v2: per-recipient rendering).

### 2.4 What it contains: assembly

1. Content source [Documented]: notification `subject`, `message_html`, `message_text`, `sms_alternate` override the matching fields of `template` (`sysevent_email_template`) when non-empty; empty ones fall back to the template.
2. Template compatibility [Documented]: selectable templates share the notification's scope and table, or share its scope with no table, or share its table in global scope.
3. Layout [Documented]: if the template references `sys_email_layout`, the layout HTML (`layout`, or `advanced_layout` when `advanced=true`) wraps the body at `${notification:body}`; layouts may contain static content, styles and unsubscribe/preference links; with no body content the layout is skipped.
4. Variables are resolved (2.5), mail scripts run (2.6), line breaks normalized (mail scripts with `new_lines_to_html=true` get newline → `<br>`; legacy non-rich bodies get newlines wrapped in `<div>`) [Documented].
5. Watermark appended unless `omit_watermark` (2.8).
6. `include_attachments=true` copies the target record's attachments to `sys_email_attachment` [Documented].
7. SMS channel: uses `sms_alternate` (140 chars), else the subject [Documented].

### 2.5 Variable syntax and rendering

Syntax: `${name}` or `${name+parameters}` [Documented].

| Variable | Output | Basis |
|---|---|---|
| `${field}` | Value of the field on `current`, rendered as display value (choice label, reference display value) | Documented (field value), Inferred (display value) |
| `${ref.field}`, `${ref.ref2.field}` | Dot-walked value (recommended depth ≤ 3) | Documented |
| `${image_field}` | Image URL, used inside `<img src>` | Documented |
| `${URI}` | Link to the record whose text is `LINK` | Documented |
| `${URI_REF}` | Link whose text is the record's display value | Documented |
| `${ref.URI}`, `${ref.URI_REF}` | Link to the referenced record (e.g. `${sysapproval.URI_REF}` on approvals) | Documented |
| `${URI+&sysparm_view=x}` | Link with extra URL parameters (including scriptlets) | Documented |
| `${CMS_URI+site/page}` | Link to a CMS/portal page with the record key | Documented |
| `${mail_script:name}` | Output of `sys_script_email` named `name` | Documented |
| `${notification:body}` | Body slot inside a layout | Documented |
| `${NOTIF_UNSUB}`, `${NOTIF_UNSUB+link_text="..."}` | Mailto unsubscribe link (2.10) | Documented |
| `${NOTIF_PREFS}`, `${NOTIF_PREFS+link_text="..."}` | Link to the user's preferences for this notification | Documented |
| `${comments}` / `${comments:n}` | All / last n comment entries | Documented |
| `${comments_and_work_notes}` / `${comments_and_work_notes:n}` | Merged journal entries | Documented |
| `${event.parm1}`, `${event.parm2}` | Event parameters | Documented |

Rendering rules [Inferred unless noted]:
- Journal variables without `:n` use `glide.email.journal.lines` (default 3; -1 = all) [Documented]; HTML cannot restyle `${comments}` output [Documented].
- Date-time values render in the system time zone (not the recipient's); `glide.email.append.timezone=true` appends the zone abbreviation [Documented].
- Links are absolute: `glide.servlet.uri` + `nav_to.do?uri=<table>.do?sys_id=<sys_id>` (ResolvrNow: `/<table>.do?sys_id=` route of the ResolvrNow UI) [Inferred]; workspace links require mail scripts [Documented].
- Unknown variables or empty dot-walks render as empty strings.
- In HTML bodies, field values are HTML-escaped except `html`/`translated_html` fields, which are sanitized (ResolvrNow security decision).
- Subjects are plain text; newlines removed; truncated to 160 characters (`sys_email.subject` length) [SDK length].
- Only one `${number}` should appear in a subject, because inbound matching cannot choose between several numbers [Documented].

### 2.6 Mail scripts (`sys_script_email`)

- Reusable scripts referenced as `${mail_script:name}`; inline `<mail_script>...</mail_script>` blocks are converted into `sys_script_email` rows on save of rich-HTML notifications/templates [Documented]. ResolvrNow executes inline blocks in legacy bodies as well [Inferred].
- Globals [Documented]: `template` (`print(text)`, `space(n)`), `email_action` (the notification), `event` (the event; empty for engine notifications), `email` (outbound object: `addAddress('cc'|'bcc', address, displayName)`, `setFrom`, `setReplyTo`, `setSubject`, `setBody`), `current`.
- Addresses passed to `setFrom`/`setReplyTo` must be valid, optionally `Display Name <addr>`, which overrides the instance display name [Documented].
- Mail scripts can be sanitized when invoked as `${{mail_script:name}}` with an HTML sanitizer configured [Documented]; ResolvrNow always sanitizes script output inserted into HTML except `<a>`, `<img>`, table and basic formatting tags [Inferred].

### 2.7 Weight and duplicate suppression

Documented: a notification's weight ranks it among duplicates; notifications with the same target table and the same recipients are duplicates when weights differ; with equal weights they are duplicates only if subject and body match (ignoring the watermark); among duplicates only the highest weight is sent, the rest move to the Skipped mailbox; the default weight 0 always sends; the SMTP sender runs every minute (the effective window); the "Ignore Duplicates" business rule enforces this.

ResolvrNow algorithm (runs in the sender job before transmitting) [Inferred]:

```
pending = sys_email(type='send-ready') grouped by (target_table, instance, normalizedRecipientSet)
for group in pending with size > 1:
   weighted = [e in group | e.weight > 0]
   if weighted not empty:
      keep = argmax(weight) over weighted (ties: keep all distinct by subject+bodyWithoutWatermark)
      skip every other weighted e
   skip any e whose (subject, bodyWithoutWatermark) equals an earlier kept/zero-weight e
skipped e: type='send-ignored', state='ignored', mailbox=Skipped, error_string='Duplicate of <sys_id>'
```

### 2.8 Watermarks

| Rule | Basis |
|---|---|
| Every notification email carries a watermark label used to match replies to the record. | Documented |
| Format: `Ref:` + prefix (default `MSG`) + auto-number + `_` + random characters; the label after `Ref:` is 31 characters by default (e.g. `Ref:MSG0000008_aLJc130zDhCVuh3spXmt`). | Documented |
| The prefix lives in Number Maintenance on the `sys_watermark` row; colons are not allowed in custom prefixes; changing it affects only new mails. | Documented |
| `omit_watermark` on a notification suppresses it; `glide.email.watermark.visible=false` hides it in HTML bodies globally (text bodies always show it). | Documented |
| ResolvrNow stores `sys_watermark(number, source_table, source_id, email)`; the HTML body gets `<div style="display:inline|none">Ref:...</div>` at the end; the text body gets a final `Ref:...` line; numbers: `MSG` + 7 digits + `_` + 20 random `[A-Za-z0-9]`. | Inferred |

### 2.9 Digests

Documented: digests bundle a notification's occurrences for a recipient over an interval; admins mark notifications as digest-capable (`digestable`), choose `digest_type` (single target record vs multiple target records), optionally force (`default_digest`) and set `default_interval`; base intervals are 1 hour, 4 hours, 1 day, 7 days (`sys_email_digest_interval`, allowed range 1 hour to 7 days, in-use intervals cannot be deleted); users opt in per notification and pick an interval; content accumulates in `sys_email_digest_part` and `sys_email_digest_part_user`; a job every 15 minutes sends digests whose interval elapsed; the interval starts at the first occurrence; single-type digests never mix records; users who are not recipients of the notification never get its digest; digests apply only to email (not SMS, push, activity stream); turning digest off stops collection, re-enabling restores saved content.

ResolvrNow algorithm [Inferred]:

```
on generate(n, recipient u, current):
  if n.digestable and (pref(u,n).digest or (no pref and n.default_digest)):
     interval = pref(u,n).digest_interval ?? n.default_interval
     key = (n, u, n.digest_type == 'single' ? current.sys_id : '*')
     part = openPart(key) ?? create(sys_email_digest_part{send_after: now + interval.interval})
     append fragment rendered from digest_html/digest_text (template digest_template)
     → no individual email for u
every 15 min:
  for part with send_after <= now:
     body = join(fragments, digest_separator_html | digest_separator_text)
     create sys_email(subject=render(digest_subject), from=digest_from, reply_to=digest_reply_to, recipients=u)
     close part
```

### 2.10 Unsubscribe and preference links

- `${NOTIF_UNSUB}` builds a mailto link to the instance; the subject starts with `Unsubscribe from` and the body carries JSON naming `notification_id` (sys_id) and `unsub_token` (instance identifier); the "Unsubscribe from Notification" inbound action processes it without login [Documented].
- `${NOTIF_PREFS}` links to the authenticated preferences page for that notification [Documented].
- Unsubscribing a primary address unsubscribes all of the user's addresses; secondary addresses can be unsubscribed individually [Documented].
- ResolvrNow: the inbound action upserts `cmn_notif_message(user, notification, active=false)` after verifying the token equals `resolvr.instance_id` [Inferred].

### 2.11 Email access restriction

`email_access_restriction(notification, conditions, description)`: emails produced by that notification are readable only by users satisfying `conditions`, enforced by the `sys_email` read ACL [Documented]. ResolvrNow evaluates the conditions against the reading user's `sys_user` record [Inferred].

### 2.12 Preview

ResolvrNow endpoint `POST /api/app/notification/{sys_id}/preview {record, event?}` returns subject, bodies and the recipient explanation (who would receive, who is excluded and why), without creating `sys_email` [Inferred; preview with recipient reasons is Documented as a feature].

---

## 3. Outbound email record and delivery

Sources: https://www.servicenow.com/docs/r/platform-administration/r_EmailLogs.html · https://www.servicenow.com/docs/r/platform-administration/troubleshooting-notification-emails.html · https://www.servicenow.com/docs/r/platform-administration/message-logs-individual-emails.html · https://www.servicenow.com/docs/r/platform-administration/t_CreateANotification.html

### 3.1 `sys_email` fields (SDK + Documented)

| Field | Meaning |
|---|---|
| `type` | Lifecycle status (3.2); default `received` |
| `state` | `ready` (default), `processed`, `error`, `ignored` |
| `mailbox` | → `sys_mailbox`; derived from type and state |
| `receive_type` | Inbound classification: `new` (default), `reply`, `forward`, or empty |
| `target_table`, `instance` | Target record (document_id) |
| `subject` (160), `body` (HTML), `body_text`, `content_type`, `headers`, `importance` | Content |
| `recipients`, `direct` (To), `copied` (Cc), `blind_copied` (Bcc), `reply_to` | Addresses |
| `user` (string), `user_id` (→ sys_user) | Sender user for inbound / triggering user for outbound |
| `message_id`, `uid`, `checkpoint` | Protocol identifiers |
| `notification_type` | `SMTP` (default), `SMS`, empty |
| `weight` | Copied from the notification |
| `error_string` | Server error for failed sends |
| `deleted` | Inbound: removed from the remote mailbox |
| `status` | Free-text status |

Related: `sys_email_attachment(email, attachment, file_name, content_disposition, action, action_reason, source)` [SDK]; "Originating event and notification" list → ResolvrNow table `sys_email_log(email, notification, event)` [Documented list, Inferred table]; per-email log entries `syslog_email` (kept 7 days) [Documented].

### 3.2 Lifecycle

| `type` | `state` | Mailbox | Meaning | Basis |
|---|---|---|---|---|
| `send-ready` | `ready` | Outbox | Generated, waiting for the sender | Documented |
| `sent` | `processed` | Sent | Delivered without error | Documented |
| `send-failed` | `error` | Failed | Permanent failure (5xx, retries exhausted) | Documented |
| `send-ignored` | `ignored` | Skipped | Not sent: duplicate, no recipient address, sending disabled for it | Documented |
| `send-retry-backoff` | `ready` | Outbox | 4xx failure; retry after 1, 5, 10, 20, 40, 60, 120, 120 minutes until `glide.email.smtp.claim.lookback.hrs` elapses | Documented |
| `send-retry-delayed` | `ready` | Outbox | Address validation failure; retry every 30 minutes until lookback elapses | Documented |
| `send-translation-ready` | `ready` | Outbox | Generated by email translation | Documented |
| `received` | `ready` → `processed` / `error` | Inbox | Inbound message | Documented |
| `received-ignored` | `ignored` | Junk | Inbound spam/auto-reply/untrusted | Documented |
| `draft` | `ready` | Drafts | Composed in the email client, not sent | Inferred |

Rules:
- All inbound emails that went through inbound actions end in `state=processed`, even when no action matched [Documented].
- Email appears in the activity stream only once sent [Documented].
- ResolvrNow sender job [Inferred]: every `resolvr.email.sender.interval_ms` (default 60000) when `glide.email.smtp.active=true`: run duplicate suppression (2.7), then for each `send-ready`/due retry email build MIME (From = notification `from` or `glide.email.user`, Reply-To, Message-ID `<sys_id.random@host>`, To = recipients), hand to the transport (SMTP, or the `sink` transport in tests) and update type/state; when outbound is disabled, emails stay in Outbox.

---

## 4. Inbound email

Sources: https://www.servicenow.com/docs/r/platform-administration/processing-inbound-emails.html · https://www.servicenow.com/docs/r/platform-administration/c_InboundEmailActions.html · https://www.servicenow.com/docs/r/platform-administration/inbound-action-processing.html · https://www.servicenow.com/docs/r/platform-administration/inbound-action-type-criteria.html · https://www.servicenow.com/docs/r/platform-administration/t_EnablingAutomaticUserCreation.html · https://www.servicenow.com/docs/r/platform-administration/r_SetFieldValsFromTheEmailBody.html · https://www.servicenow.com/docs/r/platform-administration/r_OrderedEmailProcessingPlugin.html · https://www.servicenow.com/docs/r/platform-administration/t_CreatingAnInboundEmailAction.html · https://www.servicenow.com/docs/r/platform-administration/r_AccessingEmailObjsWithVars.html · https://www.servicenow.com/docs/r/platform-administration/r_MatchingEmailToExistingUsers.html · https://www.servicenow.com/docs/r/platform-administration/r_ImpUserRunInboundActions.html · https://www.servicenow.com/docs/r/platform-administration/r_InboundEmailActionExamples.html · https://www.servicenow.com/docs/r/platform-administration/parse-email.html · https://www.servicenow.com/docs/r/platform-administration/c_WorkingWithWatermarks.html · https://www.servicenow.com/docs/r/platform-administration/email-unsubscribe.html

### 4.1 Intake [Inferred]

A reader job (IMAP/POP adapter) or `POST /api/app/email/inbound` (raw RFC 822) creates `sys_email(type='received', state='ready')` with headers, subject, `body` (HTML), `body_text`, addresses, `message_id`, `uid`, `user` (From address). Auto-replies (`Auto-Submitted` not `no`, `Precedence: bulk|junk|list`) and mail from the instance's own address become `received-ignored`. Encrypted bodies are stripped (instances cannot read encrypted mail) [Documented].

### 4.2 Classification (`receive_type`) [Documented]

| Order | Type | Criteria |
|---|---|---|
| 1 | `forward` | Subject begins with a forward prefix (`glide.email.forward_subject_prefix`, default `fw:,fwd:`, case-insensitive; empty property falls back to the default) **and** the body contains a forward header string such as `From:`. Wins even when a watermark or record number is present. |
| 2 | `reply` | Any of: (a) a known watermark in subject or body (with several watermarks in the body, the last one counts); (b) no watermark, subject begins with a reply prefix (`glide.email.reply_subject_prefix`, default `re:,aw:,r:,Accepted:,Tentative:,Declined:`, matched case-sensitively) and contains a known record number; (c) no watermark, the In-Reply-To / reply header names the message ID of an email that carried a watermark; (d) Outlook thread-index header, only when `glide.inbound.email.classify.by.thread_index=true`. |
| 3 | `new` | Everything else, including replies whose watermark or record number does not resolve to an existing record. |

Treating forwards as replies: put the forward prefixes into the reply list and set the forward property to some non-prefix text [Documented].

### 4.3 Target resolution

- Watermark: look up `sys_watermark.number` (text after `Ref:`); the email targets `(source_table, source_id)` [Documented lookup, Inferred columns]. Both randomized and legacy (non-random) watermarks are accepted [Documented].
- Record number [Documented]: the token must start with a known prefix and be delimited by whitespace (or line edges); a leading quote/asterisk prevents prefix recognition, a trailing quote/asterisk prevents the record lookup; with several numbers the outcome is unpredictable (ResolvrNow: first left-most valid number, ResolvrNow decision). Prefix → table via `sys_number.prefix` [Inferred]. Not found → treated as `new`.
- In-Reply-To: `sys_email.message_id` of an outbound email → its `target_table`/`instance` [Inferred].

### 4.4 Sender matching and impersonation [Documented]

- `email.from` resolves to the address of an **active** user whose email matches (inactive users are never matched); several active matches → the first one, so addresses should be unique.
- Inbound actions run impersonating the matched user; with no match they impersonate `guest`; a locked-out impersonated user makes the action fail.
- Senders from untrusted domains are processed as guest unless filtered.
- Automatic user creation: `glide.pop3readerjob.create_caller=true` plus `glide.user.trusted_domain` (no wildcards) creates a user whose `user_name` and `email` are the full address and whose name comes from the display name ("User, New" becomes "New User"); with the property false, unknown senders run as guest; users still need ACL rights on records they create/update; locking out `guest` stops untrusted senders.

### 4.5 Inbound action selection and execution

Table `sysevent_in_email_action` (not in SDK) [Documented labels, Inferred columns]: `name`, `collection` (target table), `action` (`record_action` | `reply_email`), `active`, `stop_processing`, `type` (`new` | `reply` | `forward`), `required_roles`, `order`, `from` (→ sys_user), `filter_condition` / `condition_script`, `template` (field actions), `reply_email` (HTML), `script`, `description`.

Selection [Documented]: inbound flows run first (a flow that stops processing ends it); then active actions ordered by `order` ascending; an action runs only if its `type` equals the email's receive type, for replies the resolved target belongs to the action's table, the condition is true, the sender holds a required role (when listed) and matches `from` (when set). `stop_processing` (or `event.state="stop_processing"` in the script) ends evaluation. Each action should have a unique order, otherwise stop processing may not prevent same-order actions [Documented].

Execution [Inferred unless noted]:

```
for action in candidates:
  current = (type == 'reply') ? load(target) : newRecord(action.collection)   // defaults applied
  apply action.template field actions (e.g. caller_id ← sender)
  run action.script(current, event, email, logger)
  if current has unsaved changes and !current.isActionAborted(): save (insert or update)
  if action.action == 'reply_email': queue sys_email reply to sender with rendered reply_email
  if first produced record: attach the email's attachments to it                 [Documented]
  if action.stop_processing or event.state == 'stop_processing': break
sys_email.state = 'processed'; target_table/instance = first produced or updated record   [Documented state]
```

### 4.6 Script environment [Documented]

| Variable | Content |
|---|---|
| `email.to` / `email.direct` / `email.copied` | To+Cc / To / Cc addresses (comma lists; RFC 2822 comma separation required) |
| `email.body_text` / `email.body_html` | Plain / HTML body (ResolvrNow: `body_text` of replies is cut at the first reply separator, 4.8) |
| `email.from` | Matched user's email, else the header address |
| `email.from_sys_id` | Matched user's sys_id |
| `email.origemail` | Raw sender header address; `email.fromAddress` computed from headers when `glide.email.inbound_action.extract_from_header=true` |
| `email.subject`, `email.recipients`, `email.recipients_array`, `email.content_type`, `email.headers`, `email.importance` | As named |
| `email.body.<name>` | Lines `name:value` on their own line; name lowercased, spaces become underscores; not usable to set reference fields by display value |
| `sys_email` | The inbound email record |
| `event` | Originating event (`event.parm1`, `event.parm2`; `event.state` for stop processing) |
| `logger` | `logger.log(msg)` with source `email.<sys_id>` |
| `current` | Target or new record |

`gs.createUser()` is not available in inbound actions [Documented].

### 4.7 Default actions (seeded by the Incident module) [Documented]

| Name | Type | Table | Effect |
|---|---|---|---|
| Create Incident | new | incident | New incident; `caller_id` and `opened_by` = matched user; body to comments/description |
| Update Incident (BP) | reply | incident | Adds "reply from: <origemail>" plus body to comments; optional `assign`, `priority`, `category`, `short_description` from `name:value` lines |
| Create Incident (Forwarded) | forward | incident | New incident even if a watermark exists |
| Update Approval Request | reply | sysapproval_approver | See approvals spec §6 [Inferred name] |
| Unsubscribe from Notification | new | cmn_notif_message | 2.10 |

### 4.8 Reply separators [Documented]

Email Reply Separators (`name`, `active`, `type` string/regex, `order`, `separator`, `language`, `short_description`) isolate the newest message of a thread; all active separators apply regardless of language; a regex taking more than 10 seconds is skipped. ResolvrNow table `sys_email_reply_separator` [Inferred name]; seeds: `-----Original Message-----`, regex `^On .+ wrote:$`, regex `^From: .+$` [Inferred].

### 4.9 Character sets and domains [Documented]

ASCII-7/UTF-8 preserved; ISO-8859-1 converted to Windows-1252; other charsets flattened to plain text. Inbound actions should live in the global domain; created records take the caller's domain (global when the caller is unknown). ResolvrNow has no domain separation in v1.

---

## 5. Notification preferences

Sources: https://www.servicenow.com/docs/r/platform-administration/t_CreateANotification.html · https://www.servicenow.com/docs/r/platform-administration/create-notification-categories.html · https://www.servicenow.com/docs/r/platform-administration/configure-email-digest.html · https://www.servicenow.com/docs/r/platform-administration/r_PushMessageArchitecture.html · https://www.servicenow.com/docs/r/platform-administration/email-unsubscribe.html

| Element | Rule | Basis |
|---|---|---|
| Channels | Recipients need an active user record and a valid address on their primary channel in `cmn_notif_device` (email, SMS, push devices). ResolvrNow auto-creates a primary email device from `sys_user.email` and keeps it in sync. | Documented (device requirement), Inferred (auto device) |
| Subscribable notifications | Listed in each user's preferences under their category; users choose channels per notification; the notification and channel must be enabled for delivery. | Documented |
| Categories | `sys_notification_category`; a category appears in preferences once at least one active notification uses it; do not leave notifications "Uncategorized". | Documented |
| Opt-out storage | `cmn_notif_message(user, notification, device, active, digest, digest_interval, filter_condition)`; `active=false` = unsubscribed. | Inferred |
| Mandatory / force delivery | `mandatory`: users cannot unsubscribe; `force_delivery`: deliver even when the user disabled notifications. | Inferred (SDK fields) |
| Global switch | `sys_user.notification`: 2 = enabled (default), 1 = disabled. | SDK default, Inferred values |
| Digest preference | Per notification: enabled flag and interval (2.9). | Documented |
| Self-service API | `GET/PUT /api/app/notification/preferences` lists categories, notifications, channels, digest settings for the session user. | Inferred |

---

## 6. Properties

| Property | Default | Meaning | Basis |
|---|---|---|---|
| `glide.email.smtp.active` | true | Send outbound email | Inferred |
| `glide.email.read.active` | true | Read inbound email | Inferred |
| `glide.email.user` | instance address | Default From | Inferred |
| `glide.servlet.uri` | instance URL | Base for links | Documented (used in examples) |
| `glide.email.smtp.max_recipients` | 100 | Recipients per email | Documented |
| `glide.email.journal.lines` | 3 | Journal entries in emails (-1 all) | Documented |
| `glide.email.append.timezone` | true | Append system TZ to date-times | Documented name, Inferred default |
| `glide.email.watermark.visible` | true | Show watermark in HTML | Documented |
| `glide.email.reply_subject_prefix` | `re:,aw:,r:,Accepted:,Tentative:,Declined:` | Reply prefixes (case-sensitive) | Documented |
| `glide.email.forward_subject_prefix` | `fw:,fwd:` | Forward prefixes (case-insensitive) | Documented |
| `glide.inbound.email.classify.by.thread_index` | false | Outlook thread-index replies | Documented |
| `glide.email.inbound_action.extract_from_header` | false | Compute `email.fromAddress` from headers | Documented |
| `glide.pop3readerjob.create_caller` | false | Create users from unknown senders | Documented name, Inferred default |
| `glide.user.trusted_domain` | (empty) | Trusted domains for user creation | Documented |
| `glide.email.smtp.claim.lookback.hrs` | 24 | Retry window | Documented name, Inferred default |
| `glide.notification.recipient.include_logging` / `exclude_logging` | true | Recipient reason logging | Documented |
| `com.glide.sysevent.priority.enabled` | true | Process events by registry priority | Documented |
| `glide.event_processor.all_events_upgrade_safe` | false | Process all events during upgrades | Documented |
| `glide.event_processor.upgrade_safe_events` | (empty) | Events processed during upgrades | Documented |
| `resolvr.events.poll_interval_ms` | 1000 | Event processor tick | Inferred |
| `resolvr.email.sender.interval_ms` | 60000 | Sender tick (documented 1 minute job) | Inferred |
| `resolvr.events.retention_days` | 7 | Processed event retention | Inferred |
| `resolvr.instance_id` | generated | Unsubscribe token | Inferred |

---

## 7. Acceptance tests

1. **Event row.** Given an after rule calling `gs.eventQueue('incident.commented', current, gs.getUserID(), gs.getUserName())`, when a comment is added to INC0010001, then a `sysevent` row exists with name `incident.commented`, table `incident`, instance = the incident sys_id, parm1 = user sys_id, parm2 = user name, state `ready`.
2. **Rollback removes events.** Given a before rule that aborts the update after another rule queued an event, when the update is attempted, then no `sysevent` row is committed.
3. **Event bypasses rules.** Given a before-insert business rule on `sysevent`, when `gs.eventQueue` is called, then that rule does not run.
4. **Priority order.** Given registered events A (priority 200) and B (priority 50), both ready in the default queue, A queued first, when the processor ticks, then B is processed before A.
5. **Scheduled event.** Given `gs.eventQueueScheduled('x.y', rec, '', '', now+10min)`, when the processor ticks now, then the event stays `ready`; after 10 minutes it is processed.
6. **Script action.** Given an active script action on `incident.assigned` with condition `event.parm1 != ''`, when the event is processed with parm1 set, then the script runs with `current` = the incident and `event.parm1` readable; with empty parm1 it does not run.
7. **Error state and reprocess.** Given a script action that throws, when its event is processed, then state is `error`; when "Reprocess" is invoked and the script is fixed, then state becomes `processed`.
8. **Deleted record snapshot.** Given `incident.deleted` queued in a delete rule, when processed after the delete, then the notification renders `${number}` from the snapshot.
9. **Engine notification on insert.** Given an active notification on incident (engine, inserted, condition `priority=1`), when a priority 1 incident is inserted, then one `sys_email` (type `send-ready`) is created after the transaction; for priority 3, none.
10. **Change operator.** Given an engine notification on update with condition `stateCHANGESTO6`, when an incident moves 2 → 6, then an email is created; when updated again while staying 6, none.
11. **Event notification.** Given a notification with `generation_type=event`, `event_name=incident.commented`, when the event is processed, then the email is created by the event processor and `sys_email_log` links email, notification and event.
12. **Advanced condition AND.** Given condition `priority=1` and advanced condition setting `answer=false`, when a priority 1 incident is inserted, then no email is created.
13. **Task table refused.** Given a new notification with table `task`, when it is saved, then the API returns 400.
14. **Recipients from fields and dot-walk.** Given `recipient_fields=caller_id,assignment_group,caller_id.manager`, when the email is generated, then the caller, the caller's manager and the group's recipients are addressed.
15. **Group without include members.** Given group G with email `g@x` and `include_members=false`, when G is a recipient, then only `g@x` is addressed; with `include_members=true` the active members are added too.
16. **Approval group exception.** Given the same group as an approval notification recipient, when the email is generated, then every member is addressed regardless of `include_members`.
17. **Event parm recipients.** Given `event_parm_1=true` and parm1 = "<user sys_id>,ext@example.com", when the event notification fires, then both the user and `ext@example.com` are recipients.
18. **Send to event creator off.** Given `send_self=false` and the commenter is also the assignee recipient, when the commenter adds a comment, then the commenter is not a recipient and the exclusion log names the reason.
19. **Inactive and address-less users excluded.** Given recipients U1 inactive and U2 without email or device, when generated, then neither is addressed and both appear in the exclusion log.
20. **ACLs ignored for recipients.** Given a caller without read access to the incident, when an engine notification targets the caller, then the caller still receives it.
21. **Recipient split.** Given 250 recipients and `glide.email.smtp.max_recipients=100`, when generated, then 3 `sys_email` rows with 100, 100 and 50 recipients are created.
22. **Template fallback.** Given a notification with empty subject and template subject `${number} updated`, when generated for INC0010005, then the subject is `INC0010005 updated`; when the notification subject is `Hi`, then the subject is `Hi`.
23. **Layout body slot.** Given a template using a layout containing `<header/>${notification:body}<footer/>`, when generated, then the body is header + rendered template body + footer.
24. **Variables.** Given body `${caller_id.manager.name} ${URI_REF} ${comments:2}` on an incident with 3 comments, then the manager's name, a link whose text is the incident number, and the last two comments appear.
25. **Journal default lines.** Given `glide.email.journal.lines=3` and 5 work notes, when `${work_notes}` renders, then exactly 3 entries appear.
26. **Mail script.** Given mail script `cc_watchers` calling `email.addAddress('cc', 'w@x', 'W')`, when referenced via `${mail_script:cc_watchers}`, then `sys_email.copied` contains `w@x`.
27. **Weight duplicate.** Given "Incident Commented" (weight 10) and "Incident Closed" (weight 20) both generated for the same caller and incident within one sender cycle, when the sender runs, then Closed is sent and Commented becomes `send-ignored` in Skipped.
28. **Weight zero always sends.** Given two weight-0 notifications with different subjects for the same recipients and record, when the sender runs, then both are sent.
29. **Equal weight identical content.** Given two weight-5 emails with identical subject and body except watermark, when the sender runs, then one is sent and one is skipped.
30. **Watermark format.** Given a generated email, then its body ends with `Ref:MSG` followed by 7 digits, `_` and 20 alphanumerics, and a `sys_watermark` row maps it to the incident; with `omit_watermark=true` there is no watermark.
31. **Hidden watermark.** Given `glide.email.watermark.visible=false`, then the HTML body wraps the watermark in a hidden element and the text body still shows it.
32. **Digest single.** Given a digestable notification (single) and user U with an hourly digest, when it fires 3 times for INC1 and twice for INC2 within the hour, then no individual emails are sent and after the interval two digests (INC1 with 3 parts, INC2 with 2 parts) are created.
33. **Digest non-recipient.** Given U enabled the digest but is not a recipient of an occurrence, when the notification fires, then nothing is collected for U.
34. **Retry backoff.** Given the transport returns 451 for an email, when the sender runs, then type becomes `send-retry-backoff` and the next attempt is not before +1 minute, then +5; a 550 response makes it `send-failed`.
35. **Inbound reply by watermark.** Given an outbound email with watermark W for INC1, when an email arrives whose body contains W (no RE: prefix), then `receive_type=reply`, the target is INC1, and "Update Incident (BP)" appends the reply to comments.
36. **Last watermark wins.** Given a body containing watermarks for INC1 then INC2, when processed, then the target is INC2.
37. **Forward beats watermark.** Given subject `FW: problem` and a body containing `From:` and INC1's watermark, when processed, then `receive_type=forward` and a new incident is created.
38. **Reply by number.** Given subject `RE: about INC0010001` and no watermark, when processed, then it updates INC0010001; with subject `Re: about INC0010001` and the default property, it is classified `new` (case-sensitive reply prefix).
39. **Quoted number not recognized.** Given subject `RE: Example "INC0010001"`, when processed, then a new incident is created.
40. **Unknown sender as guest.** Given sender `x@unknown.org` with automatic user creation off, when a new email arrives, then actions run as `guest` and the incident's caller is empty or guest per action script.
41. **Auto user creation.** Given creation on, trusted domain `company.com`, sender `"User, New" <new.user@company.com>`, when processed, then a user with `user_name=new.user@company.com`, name "New User" is created and is the caller.
42. **Stop processing.** Given actions A (order 100, condition subject starts with `chg:`, stop processing) and B (order 300, create incident), when an email with subject `chg: router` arrives, then only A runs and no incident is created.
43. **Required roles.** Given an action requiring `itil`, when a sender without itil triggers it, then it is skipped and the next action is evaluated.
44. **Body name:value.** Given body line `My Field:abc`, then `email.body.my_field == 'abc'`.
45. **Attachments to first record.** Given a new email with 2 attachments creating an incident, then the incident owns both attachments.
46. **Processed regardless.** Given no inbound action matches, when processed, then the email's state is `processed`.
47. **Unsubscribe.** Given a `${NOTIF_UNSUB}` email reply with a valid token for notification N from user U, when processed, then `cmn_notif_message(U, N).active=false` and U no longer receives N unless N is mandatory.
48. **Global opt-out.** Given `sys_user.notification=1` for U, when a non-forced notification targets U, then U is excluded; with `force_delivery=true`, U receives it.
49. **Delegates.** Given U delegates notifications to D for this week and `exclude_delegates=false`, when a notification targets U, then D also receives it; with `exclude_delegates=true`, D does not.
50. **Email access restriction.** Given a restriction on notification N allowing only users with `vip=true`, when a non-VIP itil user reads a `sys_email` produced by N, then access is denied.
