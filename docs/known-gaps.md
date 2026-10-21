# Known gaps

ResolvrNow is young. This page lists what is not built yet, or is built differently from the
behaviour the specifications in `docs/spec/` describe. Each item is a good first contribution.

## Engine

- **Record cache.** Each context caches the records it has read; elevated and derived contexts do
  not invalidate each other, so `Rec.ref()` can return stale data after a write made through
  another context.
- **Denied table reads.** `Context.query` throws when the table-level read ACL denies access;
  the reference platform returns no rows.
- **Class changes on insert.** A before-insert rule cannot change a new record's class.
- **Hooks.** Insert hooks receive an already-committed record, and hooks run even when a
  context turns workflow off.
- **Shutdown.** There is no module shutdown hook, so `platform.close()` does not stop the
  scripting worker (it is unreferenced, so the process still exits).
- **Aggregates.** Group labels are read from the table that defines a column (an incident's
  state can show task labels), empty strings and NULL form separate groups, and weeks split at
  year end. Analytics works around these inside its module.

## REST API

- No rate limiting, OAuth, public tables or multipart batch responses.
- Tag queries and Unicode case folding are not supported in encoded queries.
- The Account and attachment-attribute endpoints need `customer_account` and
  `sys_attachment_attribute`, which no module defines yet.

## Scripting

- Promises inside scripts never resolve.
- Display business rules and `g_scratchpad` are not wired into forms.
- After `setAbortAction`, later before rules do not run.

## Incident and problem

- Custom problem models (only the defaults are seeded).
- Reopening by inbound email, creating a change or request from an incident, assignment rules,
  a major incident workbench and copying attachments between records.

## Change

- Lockdown, approval policies, change templates (the tables exist), schedule definitions,
  recurring CAB meetings, scaled change, release management and copying a change.
- The risk questionnaire is available through the API only.

## Service catalog

- Catalog client scripts are returned to the browser but not run, and the portal does not run
  them either.
- Execution plans run in order only, with no rollback. Adding items to an existing request,
  drafts and cloning are not built.
- Order guides work through the catalog API but have no page in the employee portal yet.

## Knowledge

- Attachment text is not indexed for search.
- Subscriptions, comment likes and knowledge blocks.

## CMDB and assets

- Partial payload storage, per-source insert limits and CSDM offering checks.
- The state mapping tables are reference data; asset and CI sync uses mappings in code.

## SLAs and on-call

- On-call trigger rules, contact preferences, reminders and gap reports, and SLA timer
  configuration.
- Paging only fires for groups with a published shift and an unassigned task.

## Notifications

- No SMS, push or meeting invitations.
- Inbound email arrives through a JSON webhook; there is no IMAP or raw RFC 822 intake.
- Events for deleted records carry no snapshot of the record.

## Approvals and flows

- The "My approvals" list does not include approvals delegated to you (the approvals API does).
- Flow schedules run in UTC, and runs are limited by instruction count rather than time.

## Analytics

- Days and trend buckets are UTC.
- No result caching, breakdowns, thresholds or scheduled report emails.
- Historical KPI scores before the first snapshot are estimated from opened, resolved and closed
  times.

## AI

- MCP over HTTP accepts bearer tokens only (no OAuth).
- Generative skills return plain text, not structured output.
- Sentiment analysis and chat summaries are not built; clusters are computed on request and
  similarity indexes live in memory.

## Workspace and portal

- The portal ships in English. The server already serves Arabic strings with right-to-left
  layout; the web client has the plumbing but no language switch.
- No visual designer for forms, lists or UI policies; change them through their `sys_*` tables.
