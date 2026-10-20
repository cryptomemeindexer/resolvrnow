# ResolvrNow spec: Agent workspace (Service Operations Workspace for ITSM equivalent)

Status: draft 1 (2026-10-21). Parity target: ServiceNow "Brazil" public documentation for Service Operations Workspace (SOW) for ITSM and Configurable Workspace UI.
Audience: engineers building `web/src/workspace/*` (React SPA) and the server endpoints it calls.
Companion files: `ai.md` (AI skills and recommendations shown here), `analytics.md` (dashboards, KPI cards), `data/ai-analytics.json` (`interaction` tables, workspace list definitions).
Behaviour of records (states, transitions, UI action conditions) is owned by `incident.md`, `problem.md`, `change.md`, `service-catalog.md`, `knowledge.md`, `sla.md`; this document defines how the workspace presents them.

## 0. Conventions and sources

- **[Documented]** = stated in the cited public page (paraphrased). **[Inferred]** = our design or general platform knowledge absent from the pages. Tables use a Basis column with the same words.
- ResolvrNow copy, layout and visual design are original; only names of fields, roles and records mirror ServiceNow.

| Prefix | URL |
|---|---|
| `[sow]` | https://www.servicenow.com/docs/r/it-service-management/service-operations-workspace/ |
| `[ux]` | https://www.servicenow.com/docs/r/platform-user-interface/ |
| `[otto]` | https://www.servicenow.com/docs/r/it-service-management/now-assist-for-it-service-management-itsm/ |
| `[itsm]` | https://www.servicenow.com/docs/r/it-service-management/ |

## 1. Personas and access

Sources: [sow]explore-sow.html, [sow]sow-ui-landing-page.html, [sow]terminology-used-in-sow-for-itsm.html, [itsm]exploring-l1-sd-ai-specialist.html

| Persona | Definition | Primary records | Landing variant | Basis |
|---|---|---|---|---|
| Tier 1 agent | `itil` (or `sn_sow.sow_home`) and member of a group flagged as service desk | Interactions, incidents, requests, catalog tasks | Tier 1 | Documented |
| Tier 2 agent | `itil`, not in a service desk group | Incidents, requests, changes, problems, major incidents | Tier 2 | Documented |
| Service desk manager | `sn_itsm_common.sn_service_desk_manager` | Team work, AI specialist onboarding and analytics | Tier 1 plus manager cards | Documented |
| Major incident manager | `major_incident_manager` | Major incidents, communications, post incident reports | Tier 2 | Documented |
| Workspace admin | `admin`, `workspace_admin` | Admin Center (overview, configurations, learning) | n/a | Documented |

Rules: the landing page needs `itil`; non-admin agents can be redirected from the classic UI to the workspace (globally, per group, or disabled), and classic module links can be redirected to workspace pages. **[Documented]** ResolvrNow stores "service desk group" as boolean `sys_user_group.resolvr_service_desk` (name Inferred) and redirects agents with `itil` to `/ws` after login unless the user preference `workspace.redirect=false`. **[Inferred]**

## 2. Shell

Sources: [sow]service-operations-workspace-ui.html, [sow]configuring-sow-to-improve-experience.html, [sow]explore-sow.html, [ux]contextual-sidebar-configurable-workspace.html

### 2.1 Frame

```
+----+-------------------------------------------------------------------------------+
|    | ResolvrNow Service Workspace   [ search records, KB, people (Ctrl+K) ]  (+) (AI) (bell 3) (status: Available v) (avatar) (?) |
| H  +-------------------------------------------------------------------------------+
| L  | [Home] [Incidents: My open x] [INC0010023 x] [IMS0001042 x] [+]                 |
| I  +-------------------------------------------------------------------------------+
| D  |                                                                               |
| B  |                         active tab content                                    |
| ...|                                                                               |
+----+-------------------------------------------------------------------------------+
 H=Home  L=Lists  I=Inbox  D=Dashboards  B=AI worker (managers)  ...=configurable modules
```

| Element | Behaviour | Basis |
|---|---|---|
| Navigation rail | Icons for Home, Lists, Inbox (only when the interaction/chat module is active), Dashboards, AI worker (managers), Knowledge, Approvals; order configurable by admin | Documented (Home, List, Inbox, reorder), Inferred (others) |
| Global search | Searches records by number and text across task tables, KB articles, users; results grouped by type; Enter on an exact number opens the record | Inferred |
| New record menu (+) | Admin-configured list of creatable records (incident, interaction, request via catalog, problem, change, knowledge) | Documented |
| AI button | Opens the AI assist panel (§9.4) | Documented |
| Notifications bell | §12 | Inferred |
| Availability status | Available, Away, Offline (default Offline); governs chat offers | Documented |
| Help (?) | Guided tours ("take a tour") when a tour exists for the page | Documented |
| Tabs | Every list, record, dashboard opens in a workspace tab; tabs persist per user; a dot marks unsaved changes; max 15 open tabs, the oldest unpinned closes first | Inferred |

### 2.2 Routes

| Route | Screen |
|---|---|
| `/ws` and `/ws/home` | Landing page (§3) |
| `/ws/list/:table/:listId` | List (§4); `listId` = default list key or saved list sys_id |
| `/ws/record/:table/:sysId?tab=` | Record page (§5 to §8); `sysId=-1` creates a record |
| `/ws/inbox` | Chat inbox (§10.1) |
| `/ws/dashboards/:id` | Dashboard (`analytics.md` §3) |
| `/ws/ai-worker` | L1 AI worker setup and performance (`ai.md` §5) |
| `/ws/search?q=` | Search results |

All routes are deep-linkable; a record route opened directly also creates its tab. **[Inferred]**

## 3. Landing page

Sources: [sow]sow-ui-landing-page.html, [sow]slm-sow.html, [itsm]config-details-l1-sd-ai-spec-sow.html

### 3.1 Sections

| Section | Tier 1 | Tier 2 | Content and interaction | Basis |
|---|---|---|---|---|
| Header | yes | yes | Greeting with first name, shift details when scheduling is enabled (link to shift schedule), admin message banner that expands to fit, themed illustration | Documented |
| Overview donuts | Incidents (unresolved, mine or my groups'), Catalog tasks, Incident SLAs | Problems, Changes, Catalog tasks, Incidents | Click a segment: list filtered to it; click the centre: all records of the card; lists offer a preview icon for incident, problem, interaction, change, request; delegated tasks included | Documented |
| Attention cards | SLA breached, SLA at risk, open P1, not updated in 24 h | optional | Count + click-through list | Documented (use cases), Inferred (cards) |
| Announcements | yes | yes | List or grid view | Documented |
| Upcoming | yes | yes | Today and Tomorrow tabs of due work; one record opens it, several open a list tab; with workforce optimization: events, shifts, skill reviews, shift sign-ups | Documented |
| Quick links | yes | yes | User-specific links | Documented |
| Explore key features | yes | yes | Onboarding cards | Documented |
| My performance | when WFO active | | Targets set by the manager | Documented |
| My active learning | when WFO active | | Up to 3 learning items sorted by due date, overdue in red, remaining time | Documented |
| Recently viewed | | yes | Last 10 records opened | Documented (use case), Inferred (count) |
| AI worker card | managers | managers | Activate, View details, menu with Deactivate | Documented |

### 3.2 Card queries (ResolvrNow)

| Card | Segments | Query (base) | Basis |
|---|---|---|---|
| Incidents (Tier 1) | by priority | `stateIN1,2,3^assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744^ORassigned_to=javascript:gs.getUserID()` | Inferred |
| Catalog tasks | by state | `active=true^assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744^ORassigned_to=javascript:gs.getUserID()` on `sc_task` | Inferred |
| Incident SLAs | On track (< 75 percent), At risk (75 to 99), Breached | `task_sla`: `task.assigned_to=javascript:gs.getUserID()^task.active=true^stage!=cancelled` bucketed by `business_percentage` | Documented (card shows SLAs of incidents assigned to the agent), Inferred (buckets) |
| Problems (Tier 2) | by state | `active=true` + same assignment term on `problem` | Inferred |
| Changes (Tier 2) | by state | `active=true` + same assignment term on `change_request` | Inferred |
| SLA breached | | `incident`: `active=true^made_sla=false` + assignment term | Inferred |
| Not updated 24 h | | `incident`: `stateIN1,2,3^sys_updated_on<javascript:gs.hoursAgo(24)` + assignment term | Inferred |
| Upcoming Today | | union over task tables: `active=true^assigned_to=javascript:gs.getUserID()^due_dateONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` | Inferred |

### 3.3 Wireframe (Tier 1)

```
+---------------------------------------------------------------------------------+
| Good morning, Abel                         Shift 08:00-16:00   [banner message] |
+---------------------------------------------------------------------------------+
| Overview                                                                        |
|  ( Incidents 18 )      ( Catalog tasks 6 )      ( Incident SLAs 12 )            |
|  P1 2 P2 5 P3 9 P4 2   Open 4  WIP 2            On track 8 At risk 3 Breached 1 |
+--------------------------------------+------------------------------------------+
| Needs attention                      | Upcoming          [Today] [Tomorrow]     |
|  SLA breached 1   At risk 3          |  3 incidents due   1 catalog task due     |
|  Open P1 2   Not updated 24h 4       |                                          |
+--------------------------------------+------------------------------------------+
| Announcements  [list|grid]           | Quick links          Explore features    |
+--------------------------------------+------------------------------------------+
```

## 4. Lists and queues

Sources: [sow]service-operations-workspace-ui.html, [sow]create-list-sow.html, [sow]request-sow.html, [sow]knowledge-articles-sow.html, [sow]customize-the-incident-record-page.html, [sow]configuring-sow-to-improve-experience.html, [ux]lists-configurable-workspace.html, [otto]sentiment-analysis-now-assist-itsm.html

### 4.1 List menu

The Lists screen has a left list menu with two tabs: Default lists (grouped by category: Interactions, Incidents, Requests, Catalog tasks, Problems, Changes, Knowledge, Approvals) and My lists (saved by the user: start from an existing list or create from a table; shareable; one owner; ownership transferable). **[Documented]**

### 4.2 Default queues

`MYGROUPS` abbreviates `assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744` (dynamic "one of my groups"); `ME` abbreviates `javascript:gs.getUserID()`.

| Category | List | Table | Encoded query | Default sort | Basis |
|---|---|---|---|---|---|
| Incidents | My work | incident | `stateIN1,2,3^assigned_to=ME` | priority asc, sys_updated_on desc | Inferred |
| Incidents | Unassigned (my groups) | incident | `stateIN1,2,3^MYGROUPS^assigned_toISEMPTY` | priority asc, opened_at asc | Inferred |
| Incidents | My groups' work | incident | `stateIN1,2,3^MYGROUPS` | priority asc | Inferred |
| Incidents | Open | incident | `stateIN1,2,3` | priority asc | Documented (list exists), Inferred (query) |
| Incidents | Open critical | incident | `stateIN1,2,3^priority=1` | opened_at asc | Inferred |
| Incidents | SLA breached | incident | `active=true^made_sla=false^MYGROUPS` | priority asc | Inferred |
| Incidents | Resolved (last 7 days) | incident | `state=6^resolved_at>=javascript:gs.daysAgoStart(7)` | resolved_at desc | Inferred |
| Incidents | Major incidents | incident | `major_incident_state=accepted^active=true` | opened_at desc | Inferred |
| Interactions | My active interactions | interaction | `assigned_to=ME^stateINnew,work_in_progress,on_hold` | opened_at desc | Inferred |
| Requests | Requests | sc_request | `active=true` | opened_at desc | Documented (active requests) |
| Requests | Requested items | sc_req_item | `active=true` | opened_at desc | Documented |
| Catalog tasks | Assigned to me | sc_task | `active=true^assigned_to=ME` | due_date asc | Documented |
| Catalog tasks | My groups | sc_task | `active=true^MYGROUPS` | due_date asc | Documented |
| Problems | My problems / My groups | problem | `active=true^assigned_to=ME` / `active=true^MYGROUPS` | priority asc | Inferred |
| Changes | My changes / My groups / Scheduled next 7 days | change_request | `active=true^assigned_to=ME` / `active=true^MYGROUPS` / `state=-2^start_date<=javascript:gs.daysAgoEnd(-7)` | start_date asc | Inferred |
| Approvals | My approvals | sysapproval_approver | `approver=ME^state=requested` | sys_created_on asc | Documented (My Approvals for change, request, catalog task, requested item) |
| Knowledge | My articles, feedback tasks, flagged, translation tasks | kb_knowledge, kb_feedback_task | author or assignee = ME | sys_updated_on desc | Documented (lists), Inferred (queries) |

### 4.3 List behaviour

| Feature | Behaviour | Basis |
|---|---|---|
| Header | Title, record count, filter (condition builder in the header), refresh, column personalization, export | Documented (condition builder), Inferred (rest) |
| Counts | Approximate ("fuzzy") counts above a threshold for performance, exact on demand | Documented |
| Inline edit | Optional, controlled by `glide.lists.inline_editing_enabled` | Documented |
| Preview | Hover a row, select the preview icon to open a side preview with key fields and actions | Documented |
| Columns | Default columns from the table's workspace list view; sentiment and sentiment trend columns sortable when present | Documented |
| Selection and bulk actions | Checkbox selection; bulk Assign to me, Assign, Resolve (incident, per `incident.md` §19), Link to major incident | Documented (Resolve and Link list actions), Inferred (others) |
| Keyboard | §11 | Inferred |
| Live updates | A "N new records" pill appears when records matching the list are created; click to refresh | Inferred |
| Paging | 20, 50 (default), 100 rows | Inferred |
| Row emphasis | Priority badge colour; SLA breached icon; unread marker when updated by someone else since the user last viewed it | Inferred |

## 5. Record page anatomy

Sources: [ux]form-configurable-workspace.html, [ux]activity-stream-configurable-workspace.html, [ux]activity-stream-compose-configurable-workspace.html, [ux]contextual-sidebar-configurable-workspace.html, [ux]administer-forms-configurable-workspace.html, [ux]administer-activity-stream-configurable-workspace.html, [sow]configuring-sow-to-improve-experience.html

```
+----------------------------------------------------------------------------------------+
| INC0010023  VPN drops every 10 minutes                    [Save] [Resolve] [Assign] [...] |
| (In Progress) (P2 High) (Caller: Beth Anglin, VIP) (Resp SLA met) (Res SLA 3h 10m) (Neutral) |
+----------------------------------------------------------------------------------------+
| [Overview] [Details] [Related records (5)] [Communicate]           | (i)(A)(R)(AI)(P)(@) |
|                                                                    |                     |
|  main tab content (form sections or overview cards)               |  contextual side    |
|                                                                    |  panel (§9)         |
|  +-- Compose ------------------------------------------------+     |                     |
|  | (Work notes v) [ text ...........................] (AI)   |     |                     |
|  |                                         [Attach] [Post]   |     |                     |
|  +----------------------------------------------------------+     |                     |
|  Activity stream (filters: All | Work notes | Comments | Emails | Field changes)          |
+----------------------------------------------------------------------------------------+
 side panel icons: i=Record information  A=Agent assist  R=Recommendations  AI=AI assist
                   P=Playbook/guidance   @=Attachments (+ Templates, On-call experts)
```

| Region | Behaviour | Basis |
|---|---|---|
| Header | Number, short description, highlighted values as badges (state, priority, caller with VIP flag, SLA timers, sentiment), presence avatars of other viewers | Documented (form header and highlighted values), Inferred (badge set) |
| Action bar | Primary UI actions as buttons (max 3 visible, ordered by `order`), the rest in an overflow menu; Save always first | Inferred |
| Main tabs | Record tabs defined per table (§6 to §8); related lists appear as tabs or inside Related records | Documented |
| Form | Sections and fields from the table's workspace view; UI policies (mandatory, read-only, visible) and client scripts apply as on the classic form; unsaved fields get a highlight background; leaving with unsaved changes warns; optional character counters on journal fields | Documented |
| Compose and stream | §8 | Documented |
| Side panel | §9; can be hidden for specific table and tab combinations (page property `hideContextualSidebar`) | Documented |
| Concurrency | If the record changes on the server while open, a banner offers Reload; conflicting saves are rejected with a field-level diff | Inferred |

## 6. Incident record page

Sources: [sow]incident-sow.html, [sow]customize-the-incident-record-page.html, [sow]slm-sow.html, [sow]mim-in-sow.html, [otto]summarize-incident-now-assist.html, [otto]resolve-incident-now-assist.html, `incident.md` §19

### 6.1 Tabs

| Tab | Content | Visible when | Basis |
|---|---|---|---|
| Overview | Field labels with values for Summary, Impact, Cause, Resolution (view `SOW-Incident-Overview`), AI summary card (§9.4), compose | always | Documented |
| Details | Full form (workspace view) with compose; field-level recommendations for assignment group, CI, service | always | Documented |
| Related records | Task SLAs, affected CIs, attached knowledge (shown when present), child incidents, incident tasks, problem, change, interactions | always | Documented (SLAs, CIs, knowledge), Inferred (others) |
| Investigation | Device metrics and remedial actions for the primary CI | agent collector integration installed (ResolvrNow: not in v1) | Documented |
| Communicate | Communication tasks and composer | major incident, or incident communications enabled | Documented |
| Post incident report | Generate, configure, publish, export | major incident in Resolved | Documented |

### 6.2 Details form layout

| Section | Fields | Basis |
|---|---|---|
| Main | number, caller_id, category, subcategory, business_service, service_offering, cmdb_ci, contact_type, state, hold_reason, impact, urgency, priority (read-only, computed), assignment_group, assigned_to, short_description, description | Documented (`incident.md` §3) |
| Related | parent_incident, problem_id, rfc, caused_by | Documented |
| Resolution information | knowledge, close_code, close_notes, resolved_by, resolved_at | Documented |
| Major incident | major_incident_state, proposed_by/on, promoted_by/on, business_impact | Documented |
| AI | sentiment, sentiment_trend (popover with reasoning and refresh) | Documented |

### 6.3 Actions by state

Conditions and effects come from `incident.md` §19; the workspace placement is defined here. **[Inferred placement]**

| Action | New (1) | In Progress (2) | On Hold (3) | Resolved (6) | Closed (7) | Canceled (8) | Placement | Dialog |
|---|---|---|---|---|---|---|---|---|
| Save | yes | yes | yes | yes | no | no | button | |
| Assign to me | yes | yes | yes | no | no | no | button when unassigned | |
| Assign | yes | yes | yes | no | no | no | button | group, assignee, work note; AI handoff summary when assignment changes |
| Put on hold | yes | yes | no | no | no | no | overflow | hold reason (Awaiting Caller requires a comment) |
| Resume | no | no | yes | no | no | no | button | |
| Resolve | yes | yes | yes | no | no | no | button | close code (required), resolution notes (required, AI generated or prefilled), knowledge flag |
| Reopen | no | no | no | yes | no | no | button | reason comment |
| Close | no | no | no | yes | no | no | button | |
| Summarize (AI) | yes | yes | yes | yes | yes | no | Overview card | |
| Create problem / change / request / incident task / child incident | yes | yes | yes | per §19 | per §19 | no | overflow "Create" submenu | create form in a new tab, linked back |
| Create knowledge | per property | per property | per property | yes | yes | no | overflow | `ai.md` §3.6 |
| Propose / promote major incident | yes | yes | yes | no | no | no | overflow | business impact, work note |
| Email | yes | yes | yes | yes | yes | yes | overflow | full or mini composer |
| Copy incident | per property | same | same | same | same | same | overflow | |

## 7. Change, problem, request and knowledge pages

Sources: [sow]change-sow.html, [sow]problem-sow.html, [sow]request-sow.html, [sow]knowledge-articles-sow.html, [otto]summarize-change-now-assist.html, [otto]generate-change-risk-assessment-answers-now-assist.html

| Record | Tabs | Side panel | Notable UI | Basis |
|---|---|---|---|---|
| Change request | Overview (AI summary card, risk evaluation section with Assess Risk, View risk assessment, Explain risk), Details (compose: work notes and additional comments), Change tasks, Related records (affected CIs, impacted services, outages, conflicts, approvals) | Record information, Agent assist | State actions per `change.md` (request approval, implement, review, close, cancel); CAB workbench link | Documented (tabs, risk UI), Inferred (Overview grouping) |
| Problem | Overview (summary, analysis information, resolution information, problem and fix tasks, impact, work notes), Details (state read-only), Problem tasks, Fix tasks (change requests), Related records (incidents, affected CIs, outages, knowledge attached from agent assist) | Agent assist | State changes only through actions (`problem.md` §17); optional create defect, enhancement, improvement shortcuts | Documented |
| Request, requested item, catalog task | Details (platform form layout, UI actions, UI policies, client scripts apply), Related records | Requested for card (local time, department, location, contact, recent requests, assigned assets), Opened by card | Variable editor in a dialog when present on the form; approvals in My approvals | Documented |
| Interaction | §10 | §10 | §10 | Documented |
| Knowledge article | Article editor, feedback tasks, flagged tasks, translation tasks (with i18n plugin), knowledge blocks (with blocks plugin) | | `knowledge.md` | Documented |

## 8. Activity stream and composer

Sources: [ux]activity-stream-configurable-workspace.html, [ux]activity-stream-compose-configurable-workspace.html, [ux]administer-activity-stream-configurable-workspace.html, [ux]administer-forms-configurable-workspace.html, [ux]using-compose-configurable-workspace.html, [otto]now-assist-itsm-activities-response-generation.html, [otto]now-assist-itsm-sidebar-discussion.html

### 8.1 Composer

| Element | Behaviour | Basis |
|---|---|---|
| Journal target | Toggle between Work notes (internal, visible to fulfillers only) and Additional comments (customer-visible, notify the caller); the target is shown by a coloured left bar (work notes amber, comments blue) and a label | Documented (two journals), Inferred (visuals) |
| Default target | Work notes for agents; Additional comments when the record is an interaction chat follow-up | Inferred |
| Mentions | `@` suggests users who can read the record; a mention notifies the user | Documented |
| Rich text | Optional HTML editor toolbar for journal fields | Documented |
| Post | Posts the entry (and saves pending field changes); a property allows posting even when mandatory fields are empty | Documented |
| Text commands | Keyboard-triggered snippets in journal, email and HTML fields; can be disabled | Documented |
| AI icon | Work notes: Summarize actions taken, Post response; Additional comments: Follow up, Post response, Acknowledge task; Refine (shorten, elaborate, tone); Insert | Documented |
| Email | Mini composer in the record and full composer in its own tab; response templates, drafts and email templates via shortcuts; recipient editing and moving across To, Cc, Bcc | Documented |
| Attachments | Attach from composer or the Attachments side tab | Documented |

### 8.2 Stream

| Element | Behaviour | Basis |
|---|---|---|
| Entries | Field changes, work notes, comments, emails, attachments, AI-generated posts (tagged "AI assisted" with the skill name) | Documented (types), Inferred (AI tag) |
| Order | Newest first; option to show the most recent reply first in threads | Documented |
| Filters | All, Work notes, Comments, Emails, Field changes, custom tags; saved filter sets (restrictable) | Documented |
| Display | Stacked view option, avatars on tiles, custom tile icons | Documented |
| Visibility | Users without work-note read access never receive work-note entries from the API | Inferred |
| Discussion threads | A record-scoped chat with agents and experts (Sidebar equivalent) can be summarized and shared to work notes | Documented |

## 9. Contextual side panel

Sources: [sow]incident-sow.html, [sow]slm-sow.html, [sow]recommendation-framework-sow.html, [sow]exploring-recommended-actions-for-itsm-in-service-operations-workspace.html, [sow]request-sow.html, [ux]contextual-sidebar-configurable-workspace.html, [otto]now-assist-itsm-incident-assist.html, [otto]request-gen-ai-capabilities-itsm-now-assist-panel.html

### 9.1 Record information

| Block | Content | Basis |
|---|---|---|
| Caller / Requested for card | Name, title, local time, department, location, contact details, VIP; links Recent incidents (or requests) and Assigned assets | Documented |
| SLA block | Response SLA and Resolution SLA timers (time to respond / resolve; after completion the time taken); when several timer mappings exist, the lowest order wins; View more SLAs opens all task SLAs | Documented |
| Key dates | Opened, last updated, resolved | Inferred |

### 9.2 Agent assist

Lists resources related to the record's short description: KB articles, similar incidents (and problems, changes), catalog items; a search box refines the query. Actions per result: open in a tab, copy link, attach to record (KB: adds to attached knowledge; incident: link as related), send to caller as a comment draft. **[Documented: purpose and "search for relevant records and perform actions"; Inferred: action set]** ResolvrNow uses the similarity solutions of `ai.md` §7 with keyword fallback.

### 9.3 Recommendations

| Element | Behaviour | Basis |
|---|---|---|
| Cards | Record cards (record fields + actions) and message cards (text + actions, for example propose major incident); cards of one rule are grouped (for example similar open incidents) | Documented |
| Priority | The first card of the highest-priority group shows as the top recommendation | Documented |
| Actions | Each card has a primary action and secondary actions; any action recomputes recommendations; Discard hides a card; after the primary action the card moves from Current to History | Documented |
| Field recommendations | Assignment group, CI, service show predicted values on the Details tab; accept or reject; auto-stamp when the configured threshold is met | Documented |
| Contexts | Incident, incident task, problem, problem task, change, change task, interaction, request | Documented |
| ResolvrNow rules (seed) | Similar open incidents (link as child), similar resolved incidents (view resolution), KB suggestions (attach), propose major incident (when 5 or more similar active incidents in 2 hours), problem candidate (from clustering), known error match | Inferred |

### 9.4 AI assist panel

Conversational panel: ask for incident or chat summary, resolution notes, incident questions (caller assets, recent incidents in 7 days, on-call experts, similar resolved incidents), add a comment or work note in conversation; notifications when an AI agent finishes. Output cards offer copy, insert into field, share as work notes, feedback. **[Documented]** ResolvrNow sends the current record reference with every message so tools resolve "this incident". **[Inferred]**

### 9.5 Other side tabs

| Tab | Behaviour | Basis |
|---|---|---|
| On-call experts | On-call members for the assignment group (or a searched group) with contact actions | Documented |
| Attachments | Add, preview, download, remove | Documented |
| Form templates | Apply a saved template to populate fields; templates searchable | Documented |
| Playbook / guidance | Step guidance for processes (major incident playbook) | Documented (ResolvrNow v2) |

## 10. Interactions and the inbox

Sources: [sow]service-operations-workspace-ui.html, [sow]configure-liveagent-sow.html, [sow]interaction-sow.html, [otto]generate-chat-summary-interaction-now-assist-itsm.html, [otto]now-assist-itsm-chat-recommendation.html

### 10.1 Inbox

| Rule | Basis |
|---|---|
| Inbox appears when the chat/interaction module is active; an agent sets Available to receive offers (default Offline). | Documented |
| Chats from the portal are offered to members of the agent chat queue. | Documented |
| Auto-assignment on: the chat is assigned, an interaction record is created, the conversation opens (possibly as a background tab, per capacity rule). Auto-assignment off: the agent accepts or rejects; accept creates the interaction. | Documented |
| Accepting hides the inbox so the agent focuses on the conversation; ending by either side closes the interaction. | Documented |
| ResolvrNow offer card: requester, channel, wait time, first message, Accept, Reject; offer expires after 60 s and moves to the next agent. | Inferred |

### 10.2 Interaction record page

```
+------------------------------------------------------------------------------------------+
| IMS0001042  Chat with Beth Anglin  (Work in Progress)  [Create incident] [Create request] [End chat] [...] |
+-------------------------------------------+------------------------------------------------+
| [Details] [Related records (2)]           | Active chat                                    |
|  Details form + compose (work notes)      |  AI summary of virtual agent part (bullets)    |
|                                           |  Beth: my VPN keeps dropping ...               |
|                                           |  Agent: ...                                    |
|                                           |  [ type a reply ......... ] (AI) [Send]        |
|                                           |  quick actions: /summarize                     |
+-------------------------------------------+------------------------------------------------+
```

| Element | Behaviour | Basis |
|---|---|---|
| Tabs | Details (fields, compose for work notes), Related records (tasks of this interaction, incidents of the requester, tasks of the requester; add, create, remove) | Documented |
| Side panel | Record information, requester information, attachments, templates | Documented |
| Chat pane | On accept, an AI summary of the virtual agent conversation heads the transcript; `/summarize` posts an interim summary; the AI icon drafts or refines replies | Documented |
| End chat | Updates the interaction short description and chat summary (editable before save) | Documented |
| Create incident | Before chat end: the incident's short description and description come from the conversation summary and are saved; after end: chat summary updated too. The new incident links back through `interaction_related_record` and opens in a tab | Documented |
| Associate | Link an existing task to the interaction | Documented |
| Channels | chat, phone, walk-up, messaging; walk-up interactions carry location and reason | Documented |
| States | New, Work in Progress, On Hold, Wrap Up, Closed Complete, Closed Abandoned (string values `new`, `work_in_progress`, `on_hold`, `wrap_up`, `closed_complete`, `closed_abandoned`); `interaction` is modelled as its own base table, not a `task` child (verify) | Documented (Work in Progress, Closed Complete), Inferred (rest) |
| Auto-close | Interactions can be closed automatically after a configured period | Documented |

## 11. Keyboard shortcuts

Sources: [ux]use-screen-summarization.html, https://www.servicenow.com/docs/r/now-intelligence/reporting/keyboard-shortcuts.html, [ux]using-compose-configurable-workspace.html

The platform provides configurable keyboard shortcuts for the Next Experience UI (users enable them in preferences; admins can configure or disable them globally), keyboard text commands in journal and email fields, and Screen Summarization (Ctrl+U or Cmd+U opens it; Alt+P or Option+P summarizes the page; Alt+S or Option+S summarizes the focused section). **[Documented]** The concrete ResolvrNow key map below is a ResolvrNow design. **[Inferred]**

| Keys | Action | Scope |
|---|---|---|
| Ctrl/Cmd+K or `/` | Focus global search / command palette | global |
| `?` | Show shortcut help | global |
| `g` then `h`, `l`, `i`, `d` | Go to Home, Lists, Inbox, Dashboards | global |
| Alt+N | Open new record menu | global |
| Alt+W | Close current workspace tab | global |
| Alt+Left / Alt+Right | Previous / next workspace tab | global |
| Alt+A | Toggle AI assist panel | record |
| Alt+P | Toggle side panel | record |
| Ctrl/Cmd+S | Save record | record |
| Ctrl/Cmd+Enter | Post the composer entry | composer |
| Alt+1 / Alt+2 | Composer target Work notes / Additional comments | composer |
| Alt+R | Open Resolve dialog | incident |
| `j` / `k`, Enter, `x`, `Shift+A` | Next / previous row, open, select, assign to me | list |
| Esc | Close dialog, preview or palette | global |

Shortcuts are ignored while typing in text inputs except combinations with Ctrl/Cmd/Alt; users can turn shortcuts off; the help overlay lists the active map. **[Inferred]**

## 12. Notifications and presence

Sources: [sow]configuring-sow-to-improve-experience.html, [sow]sow-ui-landing-page.html, [otto]request-gen-ai-capabilities-itsm-now-assist-panel.html, [itsm]collect-emp-consent.html

| Event | Channel | Recipient | Basis |
|---|---|---|---|
| Record assigned to me or to my group (unassigned) | bell + toast | assignee / group members | Inferred |
| Mention in work notes | bell + toast | mentioned user | Documented (mentions), Inferred (channel) |
| Caller added a comment on my record | bell | assignee | Inferred |
| SLA at 75 percent and SLA breached on my records | bell + toast (breach) | assignee, group manager | Inferred |
| Approval requested | bell | approver | Inferred |
| AI agent finished a task | AI panel + bell | invoking user | Documented |
| AI worker escalated an incident to a human | bell + toast | target group / assignee | Inferred |
| Major incident proposed or promoted | toast to major incident managers | | Inferred |
| Header banner message | landing page banner, auto-expanding | all agents | Documented |
| Alerts in the UI | toasts auto-dismiss after a configured time and expand to show full text | | Documented |
| Presence | Avatars of users viewing or editing the same record; refresh interval configurable | | Documented |

Delivery: server-sent events on `/api/app/events` per user session; notifications stored in `resolvr_notification` (user, type, record, read, created); the bell shows unread count and marks read on open. Email notifications are owned by each process spec. **[Inferred]**

## 13. Implementation notes

Sources: ResolvrNow design (all rows **[Inferred]**).

| Topic | Decision | Basis |
|---|---|---|
| Stack | React SPA under `web/`, route-based code splitting, TanStack Query for server state, a design-token theme with light and dark modes | Inferred |
| Data access | Table API for lists and records (`sysparm_display_value=all` for labels), Aggregate API for donuts and counts, UI action endpoint `POST /api/app/ui_action/{table}/{sys_id}/{action}` returning the updated record or a dialog spec, journal endpoint for posts, AI endpoints from `ai.md`, SSE for live updates | Inferred |
| Metadata | Lists from `sys_ui_list` views named `workspace`; forms from `sys_ui_section` view `workspace` (fallback default view); UI actions from `sys_ui_action` with a workspace flag and `order` | Inferred |
| Accessibility | Every chart has a table alternative; full keyboard operation; ARIA live region for toasts; colour is never the only signal (badges carry text) | Inferred |
| Performance | First meaningful paint of a record under 1.5 s on a warm cache; lists virtualized beyond 100 rows | Inferred |
| Responsive | Below 1024 px the side panel becomes an overlay drawer; below 768 px the rail collapses to a bottom bar | Inferred |

## 14. Acceptance tests

1. Given a user with `itil` who belongs to a service desk group, when they open `/ws/home`, then the Tier 1 landing page shows Incidents, Catalog tasks and Incident SLAs donuts.
2. Given an `itil` user in no service desk group, when they open home, then the Tier 2 page shows Problems, Changes, Catalog tasks and Incidents donuts and a Recently viewed section.
3. Given the Incidents donut, when the user clicks the P1 segment, then a list tab opens filtered to the card query AND `priority=1`; clicking the centre opens all records of the card.
4. Given a user without `itil`, when they open `/ws`, then access is denied and no landing data is requested.
5. Given incidents assigned to the user's groups with no assignee, when the "Unassigned (my groups)" list opens, then only those incidents appear, sorted by priority then opened date.
6. Given a user saves a list from "Open" with an added filter `category=network`, when they share it with a group, then group members see it under My lists as read-only and the owner can transfer ownership.
7. Given `glide.lists.inline_editing_enabled=false`, when the user double-clicks a cell, then no inline editor opens.
8. Given incident INC1 In Progress, when the record opens, then Save, Assign and Resolve are visible and Reopen and Close are not.
9. Given INC1 Resolved, when the record opens, then Reopen and Close are visible and Resolve is hidden.
10. Given the Resolve dialog, when the user submits without a close code, then the dialog shows a required-field error and the state does not change.
11. Given resolution notes generation in automatic mode and enough activity, when Resolve is opened, then the notes field is prefilled and marked as AI generated.
12. Given the user changes the assignment group and saves, when the reassignment summary skill is active, then the Assign dialog shows a handoff summary before confirming.
13. Given On Hold with reason Awaiting Caller, when the user saves without a comment, then the save is blocked with a message.
14. Given the composer target is Work notes, when the user posts, then the entry is not returned to a requester calling the API and the caller gets no notification.
15. Given the composer target is Additional comments, when the user posts, then the caller can see it in the portal and is notified.
16. Given a user types `@Ab` in the composer, when suggestions appear, then only users with read access to the record are listed.
17. Given Agent assist on an incident about VPN, when the user selects Attach on a KB article, then the article appears in Related records under attached knowledge.
18. Given 6 similar active incidents opened in the last 2 hours, when any of them opens, then the Recommendations tab shows a "Propose major incident" message card as top recommendation.
19. Given a recommendation card, when the user discards it, then it disappears from Current and does not reappear after recompute for that record.
20. Given a field recommendation for assignment group, when the user accepts it, then the field is set (unsaved, highlighted) and the prediction result is recorded as accepted.
21. Given a record with Response and Resolution SLAs, when Record information opens, then both timers show remaining time; after resolution they show the time taken.
22. Given an agent with status Offline, when a chat arrives, then no offer is shown; after switching to Available, the next chat is offered.
23. Given auto-assignment is off, when the agent accepts an offer, then an interaction record is created, opened in a tab, and the inbox closes.
24. Given an active chat that started with a virtual agent, when the agent accepts, then the chat pane begins with an AI summary of the bot conversation.
25. Given the agent selects Create incident before ending the chat, when the incident is created, then its short description and description come from the conversation summary and it is linked to the interaction.
26. Given the agent ends the chat, when the interaction saves, then its short description and chat summary are filled and editable.
27. Given focus is not in a text field, when the user presses `g` then `l`, then the Lists screen opens; inside a text field the keys type normally.
28. Given the user presses Ctrl/Cmd+Enter in the composer, when text is present, then the entry posts.
29. Given another user opens the same record, when presence refreshes, then their avatar appears in the header.
30. Given an AI agent run started from the AI panel finishes, when the event arrives, then the bell count increases and the panel shows the result.
31. Given the server updates a record that is open with unsaved local edits, when the change event arrives, then a banner offers Reload and the local edits are kept until the user decides.
32. Given a viewport of 900 px, when a record opens, then the side panel renders as an overlay drawer toggled by its icon.
