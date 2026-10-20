# Employee portal API

JSON endpoints behind the ResolvrNow employee self-service portal: home page, taxonomy topics, unified search, universal requests, My Tickets, the ticket
page, To-dos, favorites, surveys, guided tours and UI strings in English and Arabic.

Implementation: `server/src/modules/portal/`. Behaviour comes from
`docs/spec/portal-and-virtual-agent.md` (sections 2 to 5) and the table and choice definitions in
`docs/spec/data/catalog-knowledge.json`.

## Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/app/portal` |
| Authentication | Session cookie (writes need the `X-UserToken` CSRF header), HTTP Basic or a bearer API token. Every endpoint except `GET /i18n/:lang` returns `401` when anonymous. |
| Envelope | Success: `{ "result": ... }`. Errors: `{ "error": { "message", "detail" }, "status": "failure" }` |
| Status codes | `400` invalid input, `403` action not available, `404` unknown record or no access (the portal never reveals that a ticket exists), `503` feature not installed |
| Dates | UTC strings `YYYY-MM-DD HH:MM:SS`; the client renders relative times |
| Language | Server-rendered labels (state badges, module names, timeline steps, actions, greeting) use `?lang=en|ar`, else the user's `sys_user.preferred_language`, else English |
| Access | Every call runs in the caller's context. ACLs apply, and end users additionally only see tickets they requested, opened, watch or must approve. Agents (`itil`, `sn_uni_req.routing_agent`, `admin`) see department records through ACLs. |
| Optional modules | Catalog, knowledge, incident and approval features appear when those tables or services are installed; the portal boots on top of `task` alone. |

## Data model

| Table | Purpose |
|---|---|
| `taxonomy` | A classification tree (for example "Employee") |
| `topic` | Department, topic or sub-topic: `name`, `description`, `icon` (lucide name), `order`, `parent_topic`, `topic_path` (maintained), `banner_image_url`, user criteria, `resolvr_ur_service` (request routing), `resolvr_featured` |
| `m2m_connected_content` | Topic to catalog item, knowledge article or quick link (`content_type`, `featured`, `order`) |
| `sn_ex_sp_quick_link` | Shortcut: `content_type` url, page, catalog or knowledge; `page` is a portal page id; `show_on_home` |
| `sp_favorite` | A user's favorite catalog item, article, quick link or topic |
| `resolvr_announcement` | Banner with a display window, `display_style` normal or urgent, `dismissible` |
| `universal_request` | Extends task, numbers `UR0010001...`. `opened_for`, `primary_task`, `department`, `service`, `resolvr_topic`, `state_reason`, `needs_resolution_review`, `confirm_due` |
| `universal_request_state_mapping` | Primary ticket table and state to UR state and reason |
| `sn_uni_req_department`, `sn_uni_req_service` | Departments and the tables that fulfil their requests |
| `asmt_metric_type`, `asmt_metric` | Survey definitions and questions (scale, numeric, boolean, string) |
| `asmt_condition` | Survey trigger: table, condition, user field, send percentage, repeat interval |
| `asmt_assessment_instance` | A survey sent to one user (`AINST...`), states ready, wip, complete, canceled |
| `asmt_metric_result` | One answer: `actual_value`, `normalized_value` (value x weight), `string_value` |
| `sys_embedded_tour_guide`, `sys_embedded_tour_step` | Guided tours per portal page |

Seeded reference data: the state mapping rows below, department "IT" with services "IT incident"
(`incident`) and "IT request" (`sc_req_item`), and the "Request satisfaction" survey (Overall
satisfaction 1 to 5, Met expectations yes/no, Comments) with triggers on closed incidents, closed
requested items and closed universal requests.

## Language

### `GET /i18n/:lang`

Public. UI strings for the portal. `ar` (or any `ar-*` tag) returns Arabic with `dir: "rtl"`;
other languages fall back to English. Missing keys fall back to English.

```json
{ "result": { "lang": "ar", "requested": "ar-SA", "supported": ["en", "ar"], "fallback": "en",
  "name": "العربية", "dir": "rtl", "rtl": true,
  "languages": [{ "code": "en", "name": "English", "dir": "ltr" }, { "code": "ar", "name": "العربية", "dir": "rtl" }],
  "strings": { "nav.my_tickets": "تذاكري", "badge.action_needed": "مطلوب إجراء", "...": "..." } } }
```

Keys are grouped by area: `nav.*`, `search.*`, `greeting.*`, `home.*`, `topic.*`, `type.*`,
`tickets.*`, `badge.*`, `ticket.*`, `timeline.*`, `action.*`, `module.*`, `survey.*`, `favorites.*`,
`request.*`, `approvals.*`, `error.*`. Placeholders use `{name}`.

### `POST /language`

Body `{ "lang": "ar" }`. Stores `sys_user.preferred_language` and returns the same bundle as
`GET /i18n/:lang`.

## Home

### `GET /home`

```json
{ "result": {
  "user": { "sys_id": "...", "name": "Olivia Martin", "first_name": "Olivia", "user_name": "olivia.martin" },
  "greeting": { "key": "greeting.morning", "text": "Good morning, Olivia" },
  "language": { "lang": "en", "dir": "ltr" },
  "support": { "phone": "", "email": "", "hours": "" },
  "quick_links": [{ "sys_id": "...", "name": "Report an issue", "content_type": "page", "page": "report_issue", "icon": "circle-alert", "url": "", "catalog_item": null, "knowledge": null, "order": 10 }],
  "announcements": [{ "sys_id": "...", "title": "Planned maintenance", "summary": "...", "style": "normal", "link": null, "dismissible": true, "from": "...", "to": "..." }],
  "featured_topics": [{ "sys_id": "...", "name": "Hardware", "description": "...", "icon": "laptop", "path": "IT > Hardware", "children": 3 }],
  "recent_items": [ "ticket rows, see GET /tickets" ],
  "counts": { "open_tickets": 4, "pending_approvals": 0, "pending_surveys": 1, "favorites": 2 },
  "tables": { "universal_request": true, "catalog": true, "knowledge": true, "incident": true } } }
```

- The greeting follows the hour in the user's time zone (morning 05:00 to 11:59, afternoon to
  17:59, evening otherwise).
- Support values come from `com.glide.cs.general.support_phone`, `_email` and `_hours`.
- Featured topics are topics flagged `resolvr_featured`, else the first level below the departments.
- Recent items: the user's most recently updated tickets (`resolvr.portal.home.recent_items`, 5),
  with the same de-duplication as My Tickets.

## Topics

### `GET /topics?taxonomy=<sys_id>`

Tree of active, visible topics (department, topic, sub-topic...). Each node: `sys_id`, `name`,
`description`, `icon`, `banner_image_url`, `order`, `path`, `parent`, `taxonomy`, `featured`,
`children`, and `quick_links` (quick links connected to that node, for the mega menu). A topic with
user criteria checks enabled is hidden from users who do not match; a sub-topic disappears with a
hidden or inactive parent.

### `GET /topics/:id?type=all|catalog|knowledge|quick_link&sort=popular|name|newest`

```json
{ "result": {
  "topic": { "sys_id": "...", "name": "Hardware", "description": "...", "icon": "laptop", "path": "IT > Hardware", "...": "..." },
  "breadcrumb": [{ "sys_id": "...", "name": "IT" }, { "sys_id": "...", "name": "Hardware" }],
  "children": [{ "sys_id": "...", "name": "Laptops & Desktops", "description": "...", "icon": "monitor", "order": 10 }],
  "filter": "all", "sort": "popular",
  "counts": { "all": 10, "catalog": 6, "knowledge": 4, "quick_link": 0 },
  "content": [{ "type": "catalog", "type_label": "Request", "table": "sc_cat_item", "sys_id": "...", "title": "Standard Laptop",
    "short_description": "...", "icon": "", "picture": "", "url": "", "page": "sc_cat_item", "popularity": 4,
    "updated": "...", "featured": false, "order": 100, "favorite": true, "topic": { "sys_id": "...", "name": "Hardware" } }],
  "can_request": true } }
```

Content covers the topic and all its sub-topics: connected content rows plus items and articles
whose `taxonomy_topic` is in that set. Only active, portal-visible catalog items the user may read
(including the catalog module's own visibility rules, through its `access(ctx).canViewItem`, when it
is installed) and published, current articles the user may read are returned. Popularity is the number of
requested items ordered in the last `resolvr.portal.popularity_days` (90) days for catalog items and
the view count for articles; the `popular` sort puts featured content first. Counts ignore the type
filter so the filter chips can show them.

## Quick links and announcements

| Endpoint | Description |
|---|---|
| `GET /quick-links` | Home page quick links (`show_on_home`), in order, filtered by Available For / Not Available For user criteria |
| `GET /announcements` | Active announcements inside their display window, minus the ones the user dismissed |
| `POST /announcements/:id/dismiss` | Hides a dismissible announcement for the user (stored as a user preference); `400` when not dismissible |

Portal page ids used by quick links and content: `index`, `report_issue`, `sc_home`, `sc_cat_item`,
`my_requests`, `kb_home`, `kb_article_view`, `emp_taxonomy_topic`.

## Search

### `GET /search?q=&source=all|knowledge|catalog&topic=&kb=&type=&limit=&offset=`

Unified search over published knowledge articles the user may read and orderable catalog items
(name, short description, meta). Knowledge results come from the knowledge module's search service
when it is installed (relevance ranking, snippets, `ts_query_kb` logging), else from a text query
on `kb_knowledge`.

```json
{ "result": {
  "query": "vpn", "source": "all", "filters": { "topic": null, "kb": null, "type": null },
  "limit": 5, "offset": 0, "total": 3,
  "groups": [
    { "source": "knowledge", "label": "Knowledge Articles", "total": 2, "results": [{ "type": "knowledge", "sys_id": "...", "number": "KB0010001",
      "title": "Reconnect the VPN client", "snippet": "...", "knowledge_base": { "sys_id": "...", "name": "IT Knowledge" },
      "article_type": { "value": "text", "label": "Text" }, "views": 50, "score": 0, "favorite": false, "updated": "..." }] },
    { "source": "catalog", "label": "Catalog Items", "total": 1, "results": [{ "type": "catalog", "sys_id": "...", "title": "VPN Access",
      "short_description": "...", "price": "", "action_label": "Request", "favorite": false }] } ],
  "facets": {
    "source": [{ "value": "all", "label": "All", "count": 3 }, { "value": "knowledge", "label": "Knowledge Articles", "count": 2 }, { "value": "catalog", "label": "Catalog Items", "count": 1 }],
    "topic": [{ "value": "<topic sys_id>", "label": "Network", "count": 2 }],
    "knowledge_base": [{ "value": "<kb sys_id>", "label": "IT Knowledge", "count": 2 }],
    "article_type": [{ "value": "text", "label": "Text", "count": 1 }, { "value": "html", "label": "HTML", "count": 1 }] },
  "message": null } }
```

- With `source=all`, each group holds its first 5 results; with a single source, `limit` and
  `offset` page inside it.
- `topic` (includes sub-topics) filters both sources; `kb` and `type` filter articles.
- Knowledge facets (topic, knowledge base, type of article) are counted before the facet filters
  are applied and are omitted when `source=catalog`.
- `message` holds "No results found" text when nothing matched.
- `resolvr.portal.search.catalog_requires_topic` (false) limits catalog results to items connected
  to a topic.

## Universal requests

### `POST /requests`

Raises a universal request (UR) from the portal.

```json
{ "description": "Laptop fan is loud\nIt runs at full speed all day.",
  "short_description": "optional, defaults to the first line",
  "topic": "<topic sys_id, optional>",
  "opened_for": "<sys_user sys_id, optional; agents only>",
  "attachments": [{ "file_name": "error.txt", "content_type": "text/plain", "data": "<base64>" }, "<sys_id of a staged attachment>"] }
```

An attachment is either inline (base64) or the sys_id of a file the user staged earlier on their own
user record (`POST /api/now/attachment/file?table_name=sys_user&table_sys_id=<my sys_id>`); staged
files are moved onto the new request.

Returns `201` with a ticket row (see My Tickets) plus `routed` and a localized `message`.

Routing: the topic's `resolvr_ur_service` (or the closest ancestor topic's) names a department
service and its fulfilment table. When that table is installed, the portal creates the primary
ticket at once (for example an incident for the IT topic) with:

- `short_description`, `description`, `universal_request`, `opened_by`, `contact_type` self-service;
- the requester in the table's requester field (`caller_id`, `requested_for`, ...); for incidents
  the field pairs in `sn_inc_uni_req.incident.universal_request.copy_fields` (`caller_id=opened_for`);
- the service or department routing group as `assignment_group`;
- a parent `sc_request` when the table is `sc_req_item`.

Otherwise the UR stays New with state reason `routing` for a routing agent. Validation: empty
description `400`, unknown or inactive topic `400`, `opened_for` another user without an agent role
`403`, at most 10 attachments of 25 MB each.

Agents route or close URs from the workspace record page with the UI actions **Route to incident**
(`universal_request.route_incident`), **Route to request** (`universal_request.route_request`) and
**Close** (`universal_request.close`, mandatory closing note). Routing is offered while the UR is open
and has no active primary ticket.

State mapping (seeded, editable in `universal_request_state_mapping`):

| Primary table | Primary states | UR state |
|---|---|---|
| `sc_req_item` | Pending, Open, Work in Progress | In Progress |
| `sc_req_item` | Closed Complete, Closed Incomplete, Closed Skipped | Closed (Canceled when the item stage is Request Cancelled) |
| `incident` | New, In Progress, On Hold | In Progress |
| `incident` | Resolved | Awaiting, reason Confirm response |
| `incident` | Closed | Closed |
| `incident` | Canceled | Canceled |
| any other task | open / closed state | In Progress / Closed |

When a UR has `needs_resolution_review` and its primary ticket closes, the UR waits in Awaiting
(reason Confirm response) until the requester confirms, or until `confirm_due`
(`resolvr.ur.confirm_auto_close_days`, 5) when the hourly job `portal.ur_confirm_autoclose` closes
it. A closed or canceled UR keeps its outcome while the primary ticket stays closed.

Comments synchronise both ways between a UR and its primary ticket and keep their author. Work notes
are never copied. A task created with `universal_request` set becomes the primary ticket when the UR
has none.

## My Tickets

### `GET /tickets?view=open|closed|all&q=&sort=updated|created|number&order=desc|asc&limit=20&offset=0`

Everything the user requested or that was opened for them: universal requests (`opened_for` or
`opened_by`), incidents (`caller_id` or `opened_by`), requested items (`requested_for` or
`opened_by`), requests, problems they reported and plain tasks they opened. Rules:

- a record that belongs to one of the user's URs is replaced by the UR;
- a request is hidden when one of its requested items is listed;
- `q` matches the number prefix or the title.

```json
{ "result": { "total": 12, "limit": 20, "offset": 0, "view": "open", "tickets": [{
  "table": "universal_request", "sys_id": "...", "number": "UR0010001", "title": "Laptop fan is loud",
  "module": { "key": "department", "label": "IT" },
  "state": { "value": "2", "label": "In Progress", "badge": "in_progress", "badge_label": "In Progress" },
  "created": "2026-10-21 08:12:00", "updated": "2026-10-21 09:40:11", "active": true,
  "survey_pending": false, "survey_instance": null }] } }
```

Module labels: the UR department, else IT Incident, IT Request, Request, Problem or General.

User-facing badges (one vocabulary for every ticket type):

| Badge | Universal request | Requested item | Incident |
|---|---|---|---|
| `submitted` | New | waiting for approval, approval not requested | New |
| `awaiting_approval` | primary item approval requested | approval requested | |
| `in_progress` | In Progress | fulfillment or delivery | In Progress, On Hold |
| `action_needed` | Awaiting | | On Hold awaiting caller, Resolved |
| `closed` | Closed | closed | Closed |
| `cancelled` | Canceled | Request Cancelled or rejected | Canceled |

## Ticket page

### `GET /tickets/:table/:id`

Any task table. Returns `404` for unknown tables, non-task tables, records the user cannot read,
and records the user is not involved in (requester, opener, watcher, approver) unless they are an
agent. A requester who opens the department record behind one of their URs receives the UR, with
`redirected_from` set.

```json
{ "result": {
  "table": "sc_req_item", "sys_id": "...", "number": "RITM0010020", "title": "New Mobile Phone", "description": "...",
  "module": { "key": "module.it_request", "label": "IT Request" },
  "header": { "number": "RITM0010020", "created": "...", "updated": "...", "state": { "value": "2", "label": "Work in Progress", "badge": "in_progress", "badge_label": "In Progress" } },
  "summary": [
    { "name": "item", "label": "Item", "value": "<cat_item sys_id>", "display_value": "New Mobile Phone" },
    { "name": "requested_for", "label": "Requested for", "value": "...", "display_value": "Olivia Martin" },
    { "name": "assignment_group", "label": "Assignment group", "value": "...", "display_value": "Hardware Support" },
    { "name": "assigned_to", "label": "Assigned to", "value": "", "display_value": "" },
    { "name": "stage", "label": "Stage", "value": "delivery", "display_value": "Delivery" } ],
  "variables": [{ "name": "color", "label": "Color", "value": "silver", "display_value": "Silver" }],
  "activity": [{ "type": "comment", "sys_id": "...", "value": "Please bring your old phone", "created_on": "...", "created_by": "jamal.wright", "user_name": "Jamal Wright", "user_id": "...", "is_me": false }],
  "attachments": [{ "sys_id": "...", "file_name": "photo.png", "content_type": "image/png", "size_bytes": 1234, "created_on": "...", "created_by": "...", "download_url": "/api/app/portal/tickets/sc_req_item/<id>/attachments/<att>" }],
  "timeline": [
    { "key": "submitted", "label": "Submitted", "status": "done", "at": "..." },
    { "key": "awaiting_approval", "label": "Awaiting Approval", "status": "done", "at": "..." },
    { "key": "fulfillment", "label": "Fulfillment", "status": "current", "at": "..." },
    { "key": "closed", "label": "Closed", "status": "pending", "at": null } ],
  "actions": [{ "name": "comment", "label": "Add comment", "style": "default", "comment": "required" }],
  "can_comment": true, "survey": null, "primary": null, "redirected_from": null,
  "opened_for": { "sys_id": "...", "display_value": "Olivia Martin" }, "requested_by": { "sys_id": "...", "display_value": "Olivia Martin" },
  "active": true } }
```

- Summary: item (catalog item of a requested item, else the title), requested for, assignment
  group, assigned to and stage (item stage, else state), read from the primary ticket for a UR.
- Variables: submitted catalog variables of a requested item, rendered by the catalog service
  when it is installed (masked values, multi-row sets); otherwise read from `sc_item_option` (answers
  of a record producer from `question_answer` for other records), skipping layout-only and hidden
  variables and showing display values for references and choices.
- Activity: customer-visible comments of the record and, for a UR, of its primary ticket,
  de-duplicated, newest first, at most `glide.service_portal.stream_entry_limit` (100). Work notes
  are never returned.
- Timeline steps: `submitted`, `awaiting_approval`, `fulfillment`, `closed` for requested items;
  `submitted`, `in_progress`, `resolved`, `closed` for incidents; `submitted`, `in_progress`,
  `closed` otherwise. Status is `done`, `current`, `pending` or `skipped` (no approval needed). A
  rejected or cancelled ticket keeps its reached steps and ends with a `cancelled` step.
- `primary` (table, sys_id, number of the department record) is only returned to agents.

### `POST /tickets/:table/:id/comment`

Body `{ "comment": "..." }`. Adds a customer-visible comment as the user (only on open tickets,
`400` otherwise) and returns the refreshed ticket page payload. Comments on a UR reach its primary
ticket.

### `POST /tickets/:table/:id/action/:name`

Body `{ "comment": "..." }` (required when the action says so). Returns `{ message, ticket }`.
Actions are offered to the requester side only and follow the ticket state:

| Action | Offered when | Effect |
|---|---|---|
| `resolve` | incident (or UR primary incident) New, In Progress or On Hold, not a major incident | incident Resolved with close code "Resolved by caller" |
| `accept` (alias `close`) | incident Resolved | incident Closed (UR closes through the mapping) |
| `reopen` (alias `reject`), comment required | incident Resolved | incident back to In Progress |
| `cancel` | requested item waiting for approval; UR not yet routed | item Closed Incomplete with stage Request Cancelled (through the catalog service when installed, which also stops approvals and tasks and rolls the request up); UR Canceled |
| `confirm` | UR Awaiting with reason Confirm response and no active primary ticket | UR Closed |

Unavailable actions return `403`.

### `POST /tickets/:table/:id/attachments` and `GET /tickets/:table/:id/attachments/:attachmentId`

Upload a file to an open ticket (`{ "file_name", "content_type", "data": "<base64>" }`, `201`) and
download an attachment of the ticket or of the primary ticket behind a UR. Access follows the ticket
page rules.

## To-dos

### `GET /approvals`

```json
{ "result": {
  "approvals": [{ "sys_id": "...", "state": { "value": "requested", "label": "Requested" }, "created": "...", "due_date": "",
    "approver": { "sys_id": "...", "display_value": "Maya Cohen" }, "on_behalf_of": null,
    "target": { "table": "sc_req_item", "table_label": "Requested Item", "sys_id": "...", "number": "RITM0010004", "title": "...",
      "requested_for": { "sys_id": "...", "display_value": "..." }, "item": { "sys_id": "...", "display_value": "..." }, "price": "1200", "variables": [] } }],
  "tasks": [ "ticket rows of open tasks assigned to the user (end users only)" ],
  "counts": { "approvals": 1, "tasks": 0 } } }
```

Pending `sysapproval_approver` rows (state requested) where the user is the approver or holds an
active approval delegation (`sys_user_delegate`). Empty when no approval table is installed.

### `POST /approvals/:id/approve` and `POST /approvals/:id/reject`

Body `{ "comment": "..." }` (required to reject). Decides through the approvals service when it is
installed, else updates the approval row. `404` for approvals of other users, `400` when already
decided.

## Favorites

| Endpoint | Description |
|---|---|
| `GET /favorites` | The user's favorites: `sys_id`, `table`, `document`, `type` (catalog, knowledge, quick_link, topic), `type_label`, `title`, `short_description`, `icon`, `url`, `page`, `added`. Targets that were removed or are no longer visible are hidden, not deleted. |
| `POST /favorites` | Body `{ "table": "sc_cat_item", "sys_id": "..." }`. `201` when created, `200` with the existing favorite when it already exists, `400` for unsupported tables, `404` for records the user cannot see. |
| `DELETE /favorites/:id` | Removes a favorite by its own sys_id or by the record's sys_id. Always `204` (idempotent). |

## Surveys

When a ticket newly matches an active `asmt_condition` (for example a universal request entering
Closed), an after business rule creates one survey instance for the user in the condition's user
field, unless one already exists for the same record and user, the user received the same survey
within `repeat_interval_days`, or the send percentage says otherwise. Department records that
belong to a UR are surveyed through the UR. The daily job `portal.survey_expiry` cancels instances
past their due date. `resolvr.portal.surveys.enabled` switches sending off.

| Endpoint | Description |
|---|---|
| `GET /surveys?state=pending|all` | The user's instances (open ones first): `sys_id`, `number`, `state`, `open`, `survey`, `due_date`, `taken_on`, `percent_answered`, `trigger` (table, number, title of the ticket) |
| `GET /surveys/:id` | Instance plus `questions` (`sys_id`, `name`, `question`, `datatype`, `scale_min`, `scale_max`, `mandatory`, `answer`) and `read_only`. Only the user it was sent to (or survey readers) |
| `POST /surveys/:id` | Body `{ "answers": { "<question sys_id or name>": value }, "rating": 4, "comment": "...", "save": false }`. `rating` fills the first scale question and `comment` the first text question. Validates mandatory answers and scale ranges (`400`), writes `asmt_metric_result` rows and completes the instance (`save: true` keeps it in progress) |

## Guided tours

| Endpoint | Description |
|---|---|
| `GET /tours?page=index` | Active tours for the page (or for every page) that the user's roles allow, with ordered `steps` (`target` CSS selector, `title`, `content`, `placement`) and `done` |
| `POST /tours/:id/done` | Marks the tour as completed for the user (preference `resolvr.tour.<sys_id>.done`) |

## Administration

The workspace navigation "Portal" lists Topics, Taxonomies, Connected Content, Quick Links,
Announcements, Guided Tours, Universal Requests (open, unrouted, mine, all), UR departments,
services and state mapping, Surveys, Survey Instances, Survey Results and Survey Triggers, each with
form and list layouts.

Roles: `sp_admin` (contains `taxonomy_admin` and `guided_tour_admin`), `taxonomy_admin`,
`guided_tour_admin`, `sn_uni_req.routing_agent`, `sn_uni_req.admin` (contains the routing agent
role), `survey_admin` (contains `survey_reader`), `survey_reader` (also contained in `itil`).

Properties: `resolvr.ur.confirm_auto_close_days`, `sn_inc_uni_req.incident.universal_request.copy_fields`,
`glide.service_portal.stream_entry_limit`, `com.glide.cs.general.support_phone`, `_email`, `_hours`,
`resolvr.portal.search.catalog_requires_topic`, `resolvr.portal.surveys.enabled`,
`resolvr.portal.home.recent_items`, `resolvr.portal.popularity_days`.

Events: `universal_request.routed` (parm1 primary sys_id, parm2 table) and `survey.instance.ready`
(parm1 user, parm2 ticket number).

## Demo data

With demo data enabled, the portal adds the Northwind Labs "Employee" taxonomy with the IT
department (routed to the IT incident service) and its topics Hardware, Software, Access & Accounts,
Network & Connectivity, Security and Workplace (each with sub-topics), the quick links Report an
issue, Request something, My tickets and Knowledge, a planned maintenance announcement, a welcome
tour, five universal requests (routed to incidents when the incident module is installed) and
surveys. Catalog items and knowledge articles created by the demo data of other modules are
connected to the matching topics by name, whichever module loads first.
