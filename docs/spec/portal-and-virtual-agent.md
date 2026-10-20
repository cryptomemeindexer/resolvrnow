# ResolvrNow Spec: Employee Center Portal, Universal Request, Virtual Agent, Walk-up

Status: draft v1 (clean-room). Parity target: ServiceNow "Brazil" public documentation plus the observed UX of a production Employee Center portal (described generically by the project lead).
Companion specs: `service-catalog.md` (ordering, requests), `knowledge.md` (articles, search), `incident.md`, `platform-core.md` (roles, ACLs, explicit roles), `rest-api.md` (HTTP layer). Data: `docs/spec/data/catalog-knowledge.json`.

## 0. Conventions and scope

- **[Documented]**: stated in the public docs cited in the section. **[Inferred]**: gap filled or ResolvrNow design decision. **[Observed]**: taken from the reference portal walkthrough (UX facts, not platform facts).
- Many Employee Center (EC) and Universal Request (UR) detail pages are not in our doc corpus (only titles). Their table names below are therefore mostly **[Inferred]**, except where the SDK JSON already declares them (`topic`, `sp_portal`, `sp_page`, `sp_widget`, `sp_instance`, `sp_instance_menu`, `user_criteria`).
- ResolvrNow v1 renders the portal natively (React pages under one route) instead of executing `sp_widget` scripts. `sp_portal` and `sp_page` records still exist and drive branding, page titles, public flags, roles and the menu, so configuration stays ServiceNow-shaped **[Inferred]**.

| In scope (v1) | Out of scope (v1) |
|---|---|
| EC portal shell, taxonomy topics, connected content, quick links, favorites, unified search, My Tickets, To-dos, surveys/CSAT, guided tours, multilingual + RTL | EC Pro (campaigns, content publishing, forums, Manager Hub, kiosk), App Launcher, Now Mobile, Teams/Slack/Zoom |
| Universal Request record, routing, transfer, state mapping, requester view | UR AWA routing, UR predictive intelligence, restricted (sensitive) URs beyond a flag |
| Standard ticket page and request timeline | Gen AI ticket summary |
| Virtual Agent core (topics, keyword and optional LLM discovery, runtime, handoff) and ITSM topics | NLU model training, voice, third-party channels, agentic AI |
| Walk-up Experience: locations, queue, online check-in, wait time, CSAT | Badge readers, kiosk hardware, appointment calendar sync |

## 1. Portal architecture

Sources: https://www.servicenow.com/docs/r/platform-user-interface/service-portal/create-a-portal.html, https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/explore-emp-center.html, https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/emp-center-reference.html

| Concept | Rule | Basis |
|---|---|---|
| Portal record | `sp_portal`: title, `url_suffix` (unique), homepage, kb_knowledge_page, sc_catalog_page, sc_category_page, login_page, notfound_page, logo, icon, theme, dark_theme, `rtl_enabled`, `enable_favorites`, `enable_ais`, sp_rectangle_menu (main menu), sp_chat_queue, default, inactive (+ alternate_portal) | Documented (SDK JSON and portal form) |
| EC portal | Suffix `esc`; seeded as the default portal; ResolvrNow also answers `/sp` with the same pages | Documented ("ESC" naming), Inferred (suffix) |
| Page tree | `sp_page` (id, title, public, roles, human_readable_url_structure, dynamic_title_structure) > container > row > column > instance > widget | Documented |
| Catalog and KB scoping | `m2m_sp_portal_catalog` (portal, catalog, order) and `m2m_sp_portal_knowledge_base` (active, portal, knowledge base, order) decide which catalogs and bases the portal shows | Documented |
| URLs | `/<suffix>?id=<page_id>&<params>`; optional readable form `/<suffix>/<lang>/<keywords>?id=...` (lowercase, hyphens, max 75 chars); unknown pages go to the portal 404 page (default page `404`) | Documented |
| Route maps | Page-to-page redirects per portal (for example legacy KB pages to `kb_article_view`) | Documented |
| Header | Built from the portal main menu (`sp_instance_menu`, items in `sp_rectangle_menu_item`); cart and wish list off by default in EC (`enable_cart`, `enable_wishlist` options) | Documented |
| Access | Pages may be public or role-restricted; user criteria can restrict pages, widgets, search sources and announcements | Documented |

ResolvrNow page registry **[Inferred]** (page ids reuse platform ids where documented):

| Page id | Purpose | Basis of id |
|---|---|---|
| index | Home | Documented |
| emp_taxonomy_topic (`topic_id`) | Topic page | Inferred |
| sc_category (`sys_id`), sc_home | Catalog browse (Service Portal style) | Documented (`sc_home`), Inferred (`sc_category`) |
| sc_cat_item (`sys_id`, optional `sysparm_variable_values`) | Item / record producer page | Documented |
| sc_cat_item_guide (`sys_id`) | Order guide | Inferred |
| sc_cart | Cart and checkout | Inferred |
| sc_request (`sys_id`) | Order status | Inferred |
| my_requests | My Tickets | Inferred |
| ticket (`table`, `sys_id`) | Standard ticket page | Inferred (standard ticket route map documented by title) |
| search (`q`, `source`) | Unified search | Inferred |
| kb_home, kb_article_view (`sys_kb_id` or `sysparm_article`, `sysparm_language`) | Knowledge home and article | Documented |
| approvals, approval (`sys_id`) | To-dos and approval detail | Inferred |
| my_surveys, take_survey (`instance_id`) | Surveys | Inferred |
| favorites | Favorites list | Inferred |
| walkup_online_checkin | Walk-up check-in | Documented |
| user_profile | Profile and language | Inferred |

## 2. Employee Center concepts

### 2.1 Taxonomy, topics, connected content

Sources: https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/explore-emp-center.html, https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/itsm-ec-landing.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/associate-cat-item-taxonomy-ec.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/associate-knowledge-article-with-taxonomy-topic.html

- A taxonomy is one classification tree shared by every content type (catalog items, knowledge articles, quick links) **[Documented]**. The base taxonomy "Employee" ships department topics IT, HR, Workplace, Legal and Procurement; the IT topic ships sub-topics Hardware, Software, Network and Browse IT **[Documented]**. ResolvrNow seeds the same tree **[Inferred]**.
- `taxonomy` (name, active, portal binding) and `topic` (SDK JSON: name, description, parent_topic, taxonomy, order, icon, banner_image, template (topic page), available_for / not_available_for, enable_user_criteria_check, topic_manager, topic_contributor, topic_path, active) **[Documented]** via SDK JSON.
- Mega menu depth: department (root topic) -> topic -> sub-topic **[Observed]**.
- Connected content links content to topics. Catalog items: "Assigned Topics" related list (pick taxonomy, topic, child topic); knowledge: same through "Connected Content". Only draft, review or published articles may be connected; the author needs the knowledge role and contribute access **[Documented]**. ResolvrNow table `m2m_connected_content` (topic, content_type, catalog_item, knowledge, quick_link, featured, order) **[Inferred]** name; `sc_cat_item.taxonomy_topic` and `kb_knowledge.taxonomy_topic` (SDK JSON) hold the primary topic **[Documented]**.
- In EC, catalog search returns only items connected to a topic (Service Portal requires a category instead) **[Documented]**.
- Topic visibility: when `enable_user_criteria_check` is set, `available_for` / `not_available_for` apply ("not" wins); a topic with no visible content and no visible children is hidden **[Inferred]**.

### 2.2 Quick links

Quick links are curated shortcuts (URL, portal page, catalog item, article) shown in the mega menu, on topic pages and in a home widget; visibility through Available For / Not Available For user criteria **[Documented]**. ResolvrNow table `sn_ex_sp_quick_link` (name, content_type, url, page, catalog_item, knowledge, icon, order, active, available_for, not_available_for) and connection to topics through `m2m_connected_content` **[Inferred]**. Home "quick-link cards" such as "Request a Service" and "Report an IT Issue" are quick links flagged for the home page **[Observed]**.

### 2.3 My Tickets (My Requests) data sources

Sources: https://www.servicenow.com/docs/r/it-service-management/request-management/configure-my-requests.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/delegated-request-exp.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inci-mgmt-integ-with-univ-req.html

- Sources are `request_filter` rows (title, table extending task, applies_to, filter, portal page, primary field, up to 3 secondary fields) **[Documented]**. ResolvrNow seeds: Incidents (caller_id or opened_by = me), Requested Items (requested_for = me or request.requested_for = me or opened_by = me), Universal Requests (opened_for = me or opened_by = me), Requests (opened_by = me with no RITM visible to me) **[Inferred]**.
- Dedup rules **[Documented]**: a record that belongs to a UR is replaced by its UR (requesters never see the linked incident); a RITM whose requested_for differs from its REQ's requested_for is listed for the RITM's user; otherwise the REQ is listed.
- Drafts (saved catalog drafts) appear in a Drafts tab **[Documented]**.

### 2.4 To-dos

The To-dos page lists approvals and tasks assigned to the user and supports prioritising **[Documented]**. ResolvrNow sources **[Inferred]**: `sysapproval_approver` where approver = me (or a delegate per `sys_user_delegate`) and state = requested; active tasks with assigned_to = me for non-fulfiller users (for example a "pick up your laptop" catalog task); badge = count of both. Approve and Reject (reject requires a comment) act on the approval row.

### 2.5 Favorites

`sp_portal.enable_favorites` shows a heart on catalog items and articles and a "My Favorites" header menu listing only items the user can still find **[Documented]**. ResolvrNow table `sp_favorite` (user, portal, table, document, order) **[Inferred]**; toggling is idempotent; removed or inaccessible targets are hidden, not deleted.

### 2.6 Unified search

Sources: https://www.servicenow.com/docs/r/platform-user-interface/service-portal/search-service-portal.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-service-portal-search.html

- Platform: AI Search (natural language, typo tolerance, Genius results) or legacy Zing search sources (table queries, max about 30 facet items, plain-text results) **[Documented]**. ResolvrNow v1 implements a search service with pluggable sources and SQLite FTS5 **[Inferred]**.
- ResolvrNow sources **[Inferred]**: Knowledge (`knowledge.md` section 13 rules), Catalog (orderable items the user can view: name, short_description, meta, connected topic names), Quick links, My tickets (number exact match and short description, only the user's own records).
- Results are grouped by source; facets: Source (All, Knowledge Articles, Catalogs) and, for knowledge, Topic, Knowledge Base, Type of Article (template class) **[Observed]**.
- Logging: knowledge hits write `ts_query_kb`; portal searches write `sys_search_event` **[Documented]** table names.

### 2.7 Surveys and CSAT

Sources: https://www.servicenow.com/docs/r/api-reference/rest-apis/copy-assessments-api.html, https://www.servicenow.com/docs/r/it-service-management/walk-up-experience/walkup-survey.html

- Assessment tables in the corpus **[Documented]**: `asmt_metric_type` (survey definition), `asmt_metric_category`, `asmt_metric` (question), `asmt_metric_definition` (answer choices), `asmt_metric_result` (`normalized_value = actual_value * weight`), `asmt_category_result`. Roles `survey_admin` (contains `assessment_admin`), `survey_creator`, `survey_reader` (contained in `itil`).
- Not in the corpus, ResolvrNow design **[Inferred]**: `asmt_assessment_instance` (metric_type, user, state, due_date, trigger_table, trigger_id, taken_on, number prefix AINST), `asmt_assessment_instance_question` (instance, metric, value, string_value), `asmt_condition` (metric_type, table, condition, user_field, active, probability percent, repeat_interval_days).
- Instance states **[Inferred]**: ready (Ready to take), wip (In progress), complete (Complete), canceled (Canceled).
- Trigger: an async rule on task updates evaluates active `asmt_condition` rows; when the record newly matches (for example `state` becomes Closed on `sc_req_item`, `incident` or `universal_request`) it creates one instance for the user in `user_field`, unless one exists for the same trigger and user **[Inferred]**. CSAT surveys on closure are a documented practice **[Documented]**.
- Seeded survey "Request satisfaction" **[Inferred]**: Q1 overall satisfaction (scale 1..5), Q2 met expectations (yes/no), Q3 comments (text).
- Header "My Surveys" badge = count of the user's instances in ready or wip **[Observed]** UX, **[Inferred]** query.

### 2.8 Guided tours

`sys_embedded_tour_guide` (managed by `guided_tour_admin`) holds tours **[Documented]**; steps in `sys_embedded_tour_step` (guide, order, target CSS selector, title, body, placement, action) **[Inferred]**. The header "Tours" menu lists active tours whose page matches the current page id and whose roles match the user; completion is stored as a user preference `resolvr.tour.<sys_id>.done` **[Inferred]**.

### 2.9 Multilingual and RTL

Sources: https://www.servicenow.com/docs/r/platform-user-interface/service-portal/create-a-portal.html, https://www.servicenow.com/docs/r/platform-user-interface/service-portal/c_WidgetLocalization.html

- `sp_portal.rtl_enabled` mirrors the portal when the session language is right-to-left **[Documented]**. Property `glide.sp.portals.language_selector_enabled` lists portals that show a language selector **[Documented]**.
- UI strings resolve through `sys_ui_message`; translatable fields (`translated_text`, for example item name, topic name, category title) through `sys_translated_text` **[Documented]**.
- ResolvrNow behaviour **[Inferred]**: the header toggle (English / Arabic **[Observed]**) writes `sys_user.preferred_language` and the session language, reloads data in that language, sets `<html lang dir>` (`dir="rtl"` for ar, he, fa, ur), mirrors layout with CSS logical properties, keeps numbers, ticket numbers and dates in left-to-right isolates (`<bdi>`), and falls back to English text when a translation is missing.

## 3. Universal Request (UR)

Sources: https://www.servicenow.com/docs/r/it-service-management/request-management/req-item-state-mapping.html, https://www.servicenow.com/docs/r/it-service-management/request-management/create-request-from-ur.html, https://www.servicenow.com/docs/r/it-service-management/request-management/req-transfer-ur.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/inci-mgmt-integ-with-univ-req.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/customize-fields-copied-univ-inc.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/ur-catalog-config.html, https://www.servicenow.com/docs/r/it-service-management/service-operations-workspace/using-ur-sow.html

### 3.1 Concept

A UR is a parent task that gives the employee one number for an issue regardless of which department works it. It links a **primary ticket** (incident, requested item, HR case, and so on) and can hold further associated tickets; the employee only ever sees the UR **[Documented]**.

### 3.2 Record

| Field | Meaning | Basis |
|---|---|---|
| table `universal_request` extends task, number prefix `UR` | | Prefix Documented; table name Inferred |
| opened_for | Employee the UR is for | Inferred (copy example `caller_id=opened_for` documented) |
| short_description, description, opened_by, contact_type | Standard | Inferred |
| primary_task (Primary ticket) | Reference to the department record | Documented label |
| department, service | Target service set and service | Documented concept (transfer dialog), Inferred columns |
| state, state_reason | See 3.5; reason "Confirm response" documented | Documented reason |
| needs_resolution_review | Default false | Documented |
| restricted | Sensitive flag (restrict / unrestrict actions) | Documented |
| Related lists | Associated Tickets, Associated Requests | Documented |
| Every task: `universal_request` (reference) and `task_effective_number` (UR number when part of a UR, else own number) | | Documented (SDK JSON has both) |

### 3.3 Creation paths

| Path | Rule | Basis |
|---|---|---|
| Catalog item / record producer flagged "UR certified/enabled item" | On submit, also create a UR whose primary ticket is the RITM (item) or the target record (producer); "Requires Additional Review" sets needs_resolution_review | Documented |
| Global switches | `sn_uni_req.enable_ur_all_cat_items`, `sn_uni_req.enable_ur_all_rec_prod_items` | Documented |
| Requires | RITM (or the producer target table) registered as a UR service; RITM links only when cart layouts are on (`glide.sc.use_cart_layouts`) and the item uses cart layout | Documented |
| Virtual Agent | `com.snc.create_universal_request_with_incident` (default true): VA-created incidents get a UR | Documented |
| Incident from any channel | Business rule "Create Universal Request for Incident" (inactive by default); skips child incidents whose parent is already a primary ticket | Documented |
| Agent | Create on behalf in the agent workspace | Documented |

ResolvrNow default **[Inferred]**: portal-submitted items and producers create a UR only when flagged (or the global switch is on); the observed portal flags all employee-facing items, so My Tickets shows UR numbers.

### 3.4 Routing, transfer, associated tickets **[Documented]** unless noted

- A routing agent (`routing_agent`) works URs without a primary ticket and creates the department record: Create Incident (copies `universal_request`, short_description, description, caller_id <- opened_for, opened_by; overridable by `sn_inc_uni_req.incident.universal_request.copy_fields`), Create Request (assignment group prefilled from item routing, short description; the RITM shows the UR number and becomes the primary ticket).
- Transfer of the primary ticket (by itil, routing agents, `sn_request_write` holders who are in the assignment group or assigned): to a department (service set), to a service, or back to the UR queue; with or without resolution; transfer reason and notes; comments and attachments copied by default, work notes never. Behaviour governed by `sn_uni_req.transfer_type` and mapping configuration.
- Associated tickets: from a primary incident, "Create Associated Ticket" (department, short description, description, work notes) adds a second department record under the same UR.

### 3.5 State model and mapping

UR states **[Inferred]** values (labels New, In Progress, Closed documented; cancel documented as an action):

| Value | Label | Entered when |
|---|---|---|
| 1 | New | Created, no primary ticket yet or primary not started |
| 2 | In Progress | Primary ticket state maps to In Progress |
| 3 | Awaiting | Waiting on the requester (state_reason `confirm_response` or `user_info`) |
| 4 | Closed | Primary ticket closed and no review needed, or requester confirmed |
| 7 | Canceled | Cancelled by requester or agent |

Mapping table `universal_request_state_mapping` (primary table, primary state, UR state, UR state reason) **[Documented]** table. Seeded rows:

| Primary table | Primary state | UR state | Basis |
|---|---|---|---|
| sc_req_item | Open, Work in Progress, Pending | In Progress | Documented |
| sc_req_item | Closed Complete, Closed Skipped, Closed Incomplete | Closed | Documented |
| incident | New, In Progress, On Hold | In Progress | Inferred |
| incident | Resolved | Awaiting (reason confirm_response) | Inferred |
| incident | Closed | Closed | Inferred |
| incident | Canceled | Canceled | Inferred |

Rules: mapping runs when the primary ticket's state changes (example: RITM Open -> Work in Progress moves the UR New -> In Progress) **[Documented]**. When a primary RITM closes without a transfer and `needs_resolution_review` is true, the UR does not close; its reason becomes "Confirm response" **[Documented]** and ResolvrNow sets state Awaiting until the requester confirms or 5 days pass (auto-close) **[Inferred]**.

### 3.6 Requester-facing rules **[Documented]**

- The requester sees the UR (portal Requests, platform Self-Service > Universal Requests) and never the incident behind it.
- When the primary ticket is an incident, the UR ticket page shows incident actions (Resolve, Reopen, Close) depending on incident state; comments flow to the primary ticket.
- Caller notifications of an incident inside a UR are suppressed; other incident emails show the UR number (effective number).

User-facing state model (portal badge, all ticket types) **[Inferred]**:

| Badge | UR state | RITM | Incident |
|---|---|---|---|
| Submitted | New | stage waiting_for_approval with approval not requested | New |
| Awaiting Approval | (via primary) | approval requested | n/a |
| In Progress | In Progress | stage fulfillment or delivery | In Progress, On Hold |
| Action Needed | Awaiting | n/a | On Hold (awaiting caller), Resolved |
| Closed | Closed | state 3, 4, 7 | Closed |
| Cancelled | Canceled | stage Request Cancelled | Canceled |

### 3.7 Roles and properties

Roles **[Documented]** names: `routing_agent`, a sensitive-agent role, `itil`, `sn_request_write`, `itil_admin`, `admin`. ResolvrNow scoped names `sn_uni_req.routing_agent`, `sn_uni_req.sensitive_agent`, `sn_uni_req.admin` **[Inferred]**. Properties **[Documented]**: `sn_uni_req.com.snc.ur.request_integration` (must be true for the request integration), `sn_uni_req.transfer_type`, `sn_uni_req.enable_ur_all_cat_items`, `sn_uni_req.enable_ur_all_rec_prod_items`, `sn_inc_uni_req.incident.universal_request.copy_fields`, `com.snc.create_universal_request_with_incident`.

## 4. Standard ticket page and request timeline

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/stpage-req-item.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/config-inci-ticket-page.html, https://www.servicenow.com/docs/r/it-service-management/incident-management/resolve-reopen-close-inc-sp.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_ServiceCatalogProperties.html

Configuration **[Documented]** (ResolvrNow table names **[Inferred]**: `portal_ticket_config`, `portal_ticket_tab`):

| Setting | Rule |
|---|---|
| Table | Any task-extended table (one active config per table) |
| State field | Defaults to the table's `state` |
| Show Description | None, Always, or When no variables (collapsible) |
| Info fields | Extra summary fields; cannot repeat number, short description, created, updated, watch list, state, comments, work notes (already in the header) |
| Action region | Action widget per table (for example incident Resolve / Reopen / Close) |
| Tabs | Types: Activity, Attachments, Custom, Variable Editor (Read-Only), Variable Summarizer; Activity and Attachments exist by default; at most 5 tabs; only Custom may repeat; only one of the two variable types |
| Activity stream | Capped by `glide.service_portal.stream_entry_limit` (default 100); requesters can comment |

ResolvrNow seeded configs **[Inferred]** from the observed layout:

| Table | Header band | Summary fields | Tabs | Actions |
|---|---|---|---|---|
| sc_req_item | number, created, updated, state badge | item, requested for, assignment group, assigned to, stage | Submitted Details (Variable Editor read-only), Activity, Attachments | Add comment, Add attachment, Cancel request (only while waiting for approval) |
| universal_request | UR number, created, updated, state badge | primary item or short description, requested for, assignment group, assigned to, stage of primary | Submitted Details (primary ticket variables), Activity (UR plus primary comments), Attachments | Add comment, attachment; incident actions when primary is an incident |
| incident | number, created, updated, state | short description, caller, urgency, assignment group, assigned to | Activity, Attachments | Resolve, Reopen (resolved only), Close (resolved only) |

Request timeline **[Observed]** steps, **[Inferred]** derivation (documented basis: the order status page shows a stage renderer collapsed to the current stage; `glide.sc.approval.hover` exposes the pending approver):

| Step | Done when | Current when | Timestamp shown |
|---|---|---|---|
| Submitted | always | never after creation | `opened_at` |
| Awaiting Approval | approval approved or not required | approval = requested (hover lists pending approvers) | `approval_set` |
| Fulfillment | stage complete or RITM closed | stage fulfillment or delivery | first `sc_task.opened_at` |
| Closed | `active = false` | n/a | `closed_at` |

If approval is rejected or the request is cancelled, the timeline ends with a red "Cancelled" terminal step after the last reached step. Steps whose phase never occurred (no approval needed) render as "Skipped" in grey **[Inferred]**.

## 5. Page-by-page UX spec (ResolvrNow portal)

Global rules **[Inferred]**: every page uses the shell (5.0); all lists paginate at 20 rows with infinite scroll on mobile; dates render relative ("3 hours ago") with absolute tooltip; every action is keyboard reachable and announced to screen readers (`aria-live` for toasts, never auto-dismissed when the user preference `glide.ui.accessibility` is on **[Documented]**); all copy is original ResolvrNow text.

### 5.0 Shell (header, footer, chat)

| Region | Content and behaviour | Basis |
|---|---|---|
| Logo | `sp_portal.logo`, links to `index` | Documented field |
| Mega menu | Root topics; hover/click opens columns of topics and sub-topics plus that topic's quick links; keyboard: arrow keys move, Esc closes | Observed, Documented (mega menu with quick links) |
| Language toggle | Shows the other language name (English / Arabic); switching flips `dir` and reloads strings (2.9) | Observed |
| Favorites | Heart icon, dropdown of the latest 10 favorites plus "View all" (`favorites`) | Observed, Documented (My Favorites menu) |
| My Tickets | Link to `my_requests` | Observed |
| My Surveys | Link to `my_surveys` with a numeric badge (hidden when 0) | Observed |
| Tours | Lists tours for the page; starts the overlay | Observed |
| User menu | Avatar and name; Profile, To-dos (with count), Language, Log out | Observed, Inferred items |
| Chat launcher | Bottom corner bubble opening Virtual Agent (section 6); hidden when no VA assistant is active | Documented (chat widget on portal) |
| Announcements | Banner of active announcements (Normal or Urgent style), dismissible per announcement settings | Documented |

### 5.1 Home (`?id=index`)

- Greeting: "Good morning, <first name>" by local time of day, localised **[Observed]** (personalised home documented).
- Unified search box (placeholder "How can we help?"), typeahead after 3 characters showing up to 5 grouped suggestions (articles, items, my tickets by number); Enter opens `search` **[Inferred]**.
- Quick-link cards row: home-flagged quick links in `order` (for example Request a Service -> catalog topic, Report an IT Issue -> incident record producer) **[Observed]**.
- Support contact panel: phone, email, hours, live chat button (values from `com.glide.cs.general.support_phone/_email/_hours`) **[Observed]**, **[Inferred]** source.
- My Recent Items: the user's 5 most recently updated tickets (same dedup as My Tickets) with number, title, state badge, relative update time, and "View all" **[Observed]**.
- Optional widgets: Popular items (most ordered in 30 days), Featured articles, To-dos summary **[Inferred]**.

### 5.2 Topic page (`?id=emp_taxonomy_topic&topic_id=<sys_id>`)

- Breadcrumb from root topic to current **[Documented]** (breadcrumbs widget).
- Header: topic name, description, banner image **[Documented]** (topic header widget).
- Child-topic chips: one chip per visible child topic; clicking navigates **[Observed]**, **[Documented]** (sub-topics widget).
- Support resources: connected content of this topic and its descendants (catalog items, record producers, order guides, articles, quick links) **[Observed]**, **[Documented]** (topic content widget).
  - Filter by type: All, Requests (catalog), Articles, Links.
  - Sort: Popular (default: orders + views in the last 90 days), Name A-Z, Newest **[Observed]** Popular, **[Inferred]** formula and others.
  - Grid / list toggle (remembered per user preference).
  - Card: icon/picture, title, short description, type label, favorite heart (toggle, optimistic update).
- Empty state: "No resources in this topic yet" plus link to search.

### 5.3 Catalog item page (`?id=sc_cat_item&sys_id=<item>`)

Layout **[Observed]**: breadcrumb (topic path, or category when reached from a category **[Documented]**); left column picture and description (HTML, collapsible "More information"); main column the variables form; right column the "Required information" panel and order box.

| Element | Behaviour | Basis |
|---|---|---|
| Variables | Two-column responsive form in `order`; mandatory marker (red asterisk) on mandatory variables; help text expandable; client scripts and UI policies run live | Documented |
| Requested by / Requested for | Auto-filled with the current user; Requested For variable editable when the user may request for others (`glide.sc.req_for.roles`) | Observed, Documented |
| Location and entity | Auto-populated from the requested-for user's profile (`location`, `company` or department) through variable default values; refresh when Requested For changes | Observed, Inferred mechanism |
| Dropdowns, text fields | Rendered per type (`service-catalog.md` 5.2) | Documented |
| Attachments drop zone | Drag and drop or browse; shows file chips with remove; mandatory when `mandatory_attachment`; hidden when `no_attachment_v2` | Documented, Observed |
| Required information panel | Lists unfilled visible mandatory variables as chips, in form order; clicking a chip scrolls to and focuses the variable; the panel recalculates on every change; when empty it shows a check mark | Observed (panel), Inferred (behaviour) |
| Quantity | Hidden per item settings | Documented |
| Price and delivery time | Shown unless hidden; updates as price-affecting variables change | Documented |
| Submit button | Label by `request_method` (Order Now / Request / Submit); disabled while required information is missing; double-submit guarded | Documented label, Observed |
| Add to Cart, Wish List, Save as Draft | Shown per item portal settings and portal options | Documented |
| Confirmation | For order/request methods: modal with Request for, delivery information, special instructions, Checkout; submit method skips it | Documented |
| After submit | Navigate to the ticket page of the created RITM (or UR when created) with a success toast showing the number | Observed (portal behaviour), Inferred target |
| Related articles / items | Below the form, from `kb_2_sc` and related items | Documented |
| URL prefill | `sysparm_variable_values={"name":"value"}` fills variables (not attachment, custom, label, masked, UI page, MRVS) | Documented |

Record producer variant: same page; submit runs the producer (`service-catalog.md` section 8); "Cancel" shown when `can_cancel` **[Documented]**. Order guide variant (`sc_cat_item_guide`): Describe Needs -> Choose Options (accordion per item with include toggle) -> Summary -> confirmation **[Documented]**.

### 5.4 Cart and order status (`?id=sc_cart`, `?id=sc_request&sys_id=`)

Cart (only when enabled): lines with edit, quantity, remove; Clear cart; Save as draft per line; subtotal and recurring subtotals; Proceed to checkout -> confirmation modal **[Documented]**. Order status: request number, estimated delivery, per-item rows (item name or RITM number, price, stage renderer), tasks list when `glide.sc.checkout.task.display` **[Documented]**.

### 5.5 My Tickets (`?id=my_requests`)

- One list across departments (sources in 2.3); UR records show `UR` numbers **[Observed]**.
- View filter: Open (default), Closed, All, Drafts **[Observed]** filter, **[Inferred]** values.
- Search box: matches number (exact or prefix) and title, debounced 300 ms **[Inferred]**.
- Columns (sortable): Ticket (number + title, links to `ticket`), Module (department label: UR department, else per-table label such as IT Incident, IT Request), Created, State (user-facing badge, 3.6), Updated (relative time). Default sort Updated descending **[Observed]**.
- "Take survey" button on closed rows that have a ready or wip survey instance for the user; opens `take_survey` **[Observed]**.
- Empty state with links to Request a Service and Report an IT Issue.

### 5.6 Ticket page (`?id=ticket&table=<t>&sys_id=<id>`)

Per section 4 config. Layout **[Observed]**: header band (number, created, updated, state badge); summary card (item, requested for, assignment group, assigned to, stage); Request Timeline (horizontal on desktop, vertical on mobile, mirrored in RTL); tabs Submitted Details (read-only variables, MRVS as table), Activity (comments and system updates, newest first, comment box at top), Attachments (list plus upload). Access: the requester, opened_by, watch list, approvers, and fulfillers by ACL; others get the 404 page (no existence leak) **[Inferred]**.

### 5.7 Search (`?id=search&q=<text>&source=all|kb|catalog`)

- Source facet: All / Knowledge Articles / Catalogs with counts **[Observed]**.
- Knowledge filters (visible when source is All or Knowledge): Topic, Knowledge Base, Type of Article (template class or article type) as checkbox lists with counts **[Observed]**.
- Results grouped by type with headers ("Knowledge Articles (12)", "Catalog Items (4)"), 5 per group in All with "See all", full paging inside one source **[Observed]** grouping, **[Inferred]** sizes.
- Article result: title, snippet with highlighted terms, knowledge base, updated date, views; catalog result: name, short description, picture, Request button.
- No results: spelling suggestion (FTS vocabulary distance 1), popular articles, and "Ask the Virtual Agent" link **[Inferred]**.

### 5.8 Knowledge article page (`?id=kb_article_view&sys_kb_id=<id>` or `&sysparm_article=KB...`)

Per `knowledge.md`: breadcrumb (knowledge base, category), number and version, title, language switcher (translations), body (template fields), author and updated date, views, attachments (when display_attachments), Helpful? yes/no with percentage, 1-5 star rating, comments, Flag article, Copy permalink, related articles and related catalog items, favorite heart **[Documented]**. Opening an outdated version shows a banner linking to the latest **[Documented]**.

### 5.9 My Surveys and take survey (`?id=my_surveys`, `?id=take_survey&instance_id=`)

List of the user's instances: survey name, related ticket number, due date, state; open ones first **[Inferred]**. Take survey: one question per card (scale questions as large tap targets, 1-5 labelled), progress indicator, Save (state wip) and Submit (state complete; writes `asmt_metric_result` rows); a completed or cancelled instance opens read-only **[Inferred]**.

### 5.10 To-dos and approval (`?id=approvals`, `?id=approval&sys_id=`)

List grouped Approvals / Tasks with counts; approval card shows requested item, requester, price, variables summary (fields from the approval configuration for `sc_request` / `sc_req_item`, preconfigured **[Documented]**), Approve and Reject (comment required for reject) **[Inferred]** UX.

### 5.11 Other pages

- Favorites (`favorites`): grid of favorites by type with remove.
- Profile (`user_profile`): name, photo, contact details, location, language preference, time zone.
- Walk-up check-in (`walkup_online_checkin`): section 7.

## 6. Virtual Agent

Sources: https://www.servicenow.com/docs/r/conversational-interfaces/virtual-agent/design-va-topic.html, https://www.servicenow.com/docs/r/conversational-interfaces/virtual-agent/chat-experiences.html, https://www.servicenow.com/docs/r/conversational-interfaces/virtual-agent/va-llm.html, https://www.servicenow.com/docs/r/conversational-interfaces/virtual-agent/va-components.html, https://www.servicenow.com/docs/r/conversational-interfaces/virtual-agent/using-va-agent-chat.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/bot-api.html

### 6.1 Topic model

| Concept | Rule | Basis |
|---|---|---|
| Asset types | Topic (one goal), Topic Block (reusable fragment with typed inputs/outputs, callable once published), Setup Topic (runs at fixed points), Small Talk | Documented |
| Properties | name (unique per domain), description (the discovery signal for LLM topics), model type (LLM or NLU/keyword), categories, assistants, roles (empty = everyone), discoverable, visible ("Show me everything"), promoted (up to 6 shown as starters), condition, channels, keywords (keyword topics) | Documented |
| Lifecycle | Save keeps a draft; Publish validates (errors block, warnings allowed), sets Active and deploys; status Draft / Modified / Published; template topics are read-only and must be duplicated; Greeting, Live Agent, Error, Closing, Feedback and Capabilities setup topics cannot be deleted | Documented |
| Flow | Start node, End node; nodes from three groups | Documented |
| User inputs | Text, Static Choice, Grouped Choice, Dynamic (reference) Choice from a table and condition, Boolean, Date Time, File Picker, Carousel, Secure Text | Documented |
| Bot responses | Text, Image, Link, HTML, Multi-response, Script, Card (record card with chosen fields), Table, Video | Documented |
| Utilities | Lookup, Script Action, Record Action (create or update), Decision (branches with conditions, first is "Always"), Topic Block, Action (flow action), Pause | Documented |
| Variables | Input variables named from node names (lowercase, non-alphanumerics to `_`); script variables `vaVars`; inputs `vaInputs`; context variables in `sys_cs_virtual_agent_context` | Documented (naming rule Inferred from examples) |

ResolvrNow storage **[Inferred]**: `sys_cb_topic.graph` (draft JSON) and `published_graph` + `published_version`; each conversation task pins the version it started with; script nodes run in the ResolvrNow TypeScript sandbox with the caller's ACLs (VA transactions are non-interactive **[Documented]**).

### 6.2 Discovery

| Mode | Matching | ResolvrNow v1 |
|---|---|---|
| Keyword | Utterance vs topic keywords and names; partial, phonetic and spell-check matching after `com.glide.cs.suggest.minimum_characters` | Implemented (default) |
| NLU | Intents and utterances per language, confidence threshold (value undocumented) | Not implemented; intent field kept for import |
| LLM | Utterance compared with topic descriptions; entities extracted without mapping; supports switching topics mid-flow | Optional provider plug-in |

Algorithm **[Inferred]** (documented pieces: disambiguation list, discoverable flag, fallback topics):
1. Candidates = active, published, discoverable topics allowed by roles, condition and channel.
2. Score each (keyword: BM25 over name + keywords + description, normalised 0..1; LLM: provider score).
3. Best score >= `resolvr.va.discovery_confidence_threshold` (0.6) and lead over the second >= 0.1: start it. Several within 0.1: show a picker of up to 3 plus "Something else" (value `-1`). None: run the Fallback setup topic (rephrase), then knowledge search (6.4 Search knowledge), then offer Live Agent Support and "Report an issue".
4. Mid-topic switching is allowed except inside catalog ordering **[Documented]**.

### 6.3 Conversation runtime

- Setup topics **[Documented]**: Greeting, Virtual Agent Capabilities, Fallback, AI Search Fallback, Anything Else, Provide Feedback, Live Agent Support, Error Handling (then transfer), Closing.
- Records **[Documented]**: `sys_cs_conversation` (one per conversation), `sys_cs_conversation_task` (topics run), `sys_cs_message`, `interaction` (whole conversation incl. transfers), `sys_cs_consumer` (user). States Open, Completed, Faulted, Canceled.
- Timeouts **[Documented]**: enhanced chats close after 2 h idle; the hourly job "Time Out Abandoned VA Conversations" closes abandoned VA and agent chats with the faulted message from `com.glide.cs.conversation_faulted_reason`.
- Message schema **[Inferred]** from the Bot API vocabulary **[Documented]**: each bot message is `{uiType, group, label, value, options[{label, value, enabled, description}], required, maskType, data}` with uiType in OutputText, OutputHtml, OutputLink, OutputImage, OutputCard, Picker, Boolean, InputText, Date, DateTime, FileUpload, TopicPickerControl, ActionMsg.
- Portal client: chat window (standard) with history of the current conversation, typing indicator honouring `com.glide.cs.branding.type_presence_delay`, thumbs up/down per bot answer, "End conversation" **[Documented]** features.

### 6.4 ITSM topics shipped by ResolvrNow

Sources: https://www.servicenow.com/docs/r/it-service-management/itsm-virtual-agent/itsm-va-self-service-topics.html, https://www.servicenow.com/docs/r/it-service-management/itsm-virtual-agent/itsm-password-management.html, https://www.servicenow.com/docs/r/it-service-management/itsm-virtual-agent/itsm-va-topic-blocks.html, https://www.servicenow.com/docs/r/it-service-management/itsm-virtual-agent/itsm-va-setup-topics.html

Platform ITSM topics install inactive, read-only, suffixed "(Template)" **[Documented]**; ResolvrNow ships equivalents active by default **[Inferred]**.

| ResolvrNow topic (platform equivalent) | Flow | Records |
|---|---|---|
| Report an IT issue (Open IT Ticket 2.0) | Ask what is wrong (text) -> Contextual Search block (top 3 articles, "Did this help?") -> if yes: close, deflection event KB-Resolve; if no: look for the user's similar open incidents (same CI or text similarity) and offer to comment instead -> ask urgency (Low/Medium/High) -> Create Incident block (caller, short description, description = conversation summary, urgency, contact_type virtual_agent) -> UR when `com.snc.create_universal_request_with_incident` -> card with number and link | incident, universal_request, deflection event |
| Check ticket status (Check IT Ticket Status) | List the user's active incidents, requests and URs (link, item, stage or state, last update) -> pick one -> card with stage, assignment group, last comment -> options: add comment, talk to a live agent, done | reads incident, sc_req_item, universal_request; writes comments |
| Reset password / unlock account (Password Reset for VA) | Keywords reset, change, unlock, password; logged-out users get Reset and Unlock; logged-in users also Change; ResolvrNow v1 shows the password-reset page links (Display Password Reset URLs block) | none (links) |
| Search knowledge (Contextual Search block) | Inputs: query, knowledge base (optional), portal; shows up to `limit` articles with snippets and links; asks helpful yes/no; outputs results_returned, results_helpful | ts_query_kb, kb_use |
| Request something (Search / Request Catalog Item blocks) | Search Catalog Item (query, catalogs, result_limit 5; returns -1 when none chosen) -> conversational ordering when eligible (at most 10 questions, single-row sets only, supported variable types, no scripted UI policies) else link to the portal item page | sc_request, sc_req_item |
| Approvals (Process Approval) | approver_user only: list pending approvals -> approve or reject with comment | sysapproval_approver |
| Dynamic greeting (Dynamic Greeting Topic) | First name and time of day, counts of open incidents and requests, current outages; empty lines omitted | reads |

### 6.5 Live agent handoff

**[Documented]**: handoff targets a human in agent chat with full history and context; entry points are the Live Agent Support setup topic (also the contextual command "agent"), the Error Handling topic, topic offers (for example in Check IT Ticket Status) and the "Contact Live Agent" support option; queue from the topic or `com.glide.cs.live_agent_queue`; messages from `com.glide.cs.general.live_agent_handoff_message` and `..._error_message`; wait time is sent with a spinner; replies carry `agentChat=true` and agent info; only one live-agent conversation per user at a time; with no agents a disabled "No live agents currently available" state shows.

ResolvrNow flow **[Inferred]**:
1. Create a chat work item on the queue with the transcript; set `interaction.state = queued`.
2. Estimated wait = round(average handle wait of the queue over the last 7 days x position) minutes; post it and refresh every 60 s.
3. Outside `com.glide.cs.general.support_hours` or with no available agent: post the error message, support phone/email/hours, and offer "Report an IT issue" instead.
4. On accept: post "<agent> joined"; messages relay both ways; on end, the conversation returns to the bot Closing topic.

Actionable notifications **[Documented]**: request approved or rejected, RITM commented, RITM update, approval requests (approve or reject in chat) are delivered as chat messages when the user is not mid-conversation, queued up to `com.glide.cs.idle_actionable_notification_timer` hours (default 8, max 72). ResolvrNow v1 implements the approval and RITM-update notifications **[Inferred]** scope.

## 7. Walk-up Experience (light)

Sources: https://www.servicenow.com/docs/r/it-service-management/walk-up-experience/understanding-walkup-experience-new.html, https://www.servicenow.com/docs/r/it-service-management/walk-up-experience/configure-walkup-location.html, https://www.servicenow.com/docs/r/it-service-management/walk-up-experience/installed-with-walkup-experience.html, https://www.servicenow.com/docs/r/it-service-management/walk-up-experience/walkup-survey.html, https://www.servicenow.com/docs/r/it-service-management/walk-up-experience/plan-your-visit.html

| Topic | Rule | Basis |
|---|---|---|
| Purpose | Onsite IT help desk ("tech lounge"): join a queue online or onsite, or book an appointment; agents work interactions | Documented |
| Tables | `wu_location_queue` (location config, extends the work-assignment queue), `wu_reason`, `wu_m2m_location_queue_reason`, `wu_context`, `wu_appointment` (extends task), `interaction` (the visit ticket) | Documented |
| Check-in | Online page `walkup_online_checkin` (nearest location by geolocation or profile, reason, description) or onsite page `walkup_check_in` (find yourself by name/email, guest entry); last check-in N minutes before closing; closed locations show phone and a create-incident producer | Documented |
| States | New, Queued, Work in Progress, On Hold (keeps queue position; re-routed after hold time), Closed Complete, Closed Abandoned | Documented labels, Inferred values |
| Queue order | First come, first served; VIP requesters flagged; agents may pick anyone | Documented |
| Wait time | Average wait of the queue x number of people waiting, rounded to whole minutes; shown on check-in pages, the queue monitor and the portal status widget when "Show estimated wait time" is on | Documented |
| Agent actions | Accept, assign, transfer (agent or location), hold, create incident / request / case from the visit, close, abandon | Documented |
| Notifications | Walk-up Assigned, Walk-up Threshold (near the front, per "Position notification"), Walk-up Abandoned, Walk-up Closed; appointment reminders | Documented |
| Surveys | Onsite one-click CSAT (1-3 faces) and emailed satisfaction survey (1-5) on close | Documented |
| Roles | `sn_walkup.walkup_login` (shared device login, no other role), `sn_walkup.walkup_technician`, `sn_walkup.walkup_manager`, `sn_walkup.walkup_admin` | Documented |

ResolvrNow v1 portal page `walkup_online_checkin` **[Inferred]** layout: location picker (default nearest), open/closed status with hours, current queue length and estimated wait, reason dropdown, description, "Join queue" (creates the interaction in state queued and a `wu_context` row); after joining, a status card with position, estimated wait, "Leave queue" (closed abandoned) and live refresh every 30 s. The EC IT topic shows a "Walk-up: plan your visit" quick link **[Documented]**.

## 8. Acceptance tests

Fixtures: portal `esc` with `rtl_enabled = true`; taxonomy Employee > IT > Hardware > Computers; item Laptop connected to Hardware; producer "Report an IT Issue" (incident, UR-enabled); article "Reconnect the VPN client" connected to IT > Network; users `alice` (employee, language en), `bob` (itil, Hardware Fulfilment), `ria` (routing_agent); survey condition on `sc_req_item` state Closed for `requested_for`.

| # | Given | When | Then |
|---|---|---|---|
| 1 | alice signed in at 09:00 local | opens `/esc?id=index` | greeting contains "Good morning" and alice's first name; quick-link cards render in configured order |
| 2 | Home page | alice types "vpn" | typeahead groups show the VPN article under Knowledge; Enter opens `search` with `q=vpn` |
| 3 | Mega menu | alice opens IT | Hardware, Software, Network, Browse IT appear with IT quick links |
| 4 | Topic Hardware | page loads | breadcrumb Employee > IT > Hardware; chip "Computers"; Laptop card listed; filter "Articles" hides Laptop |
| 5 | Laptop card | alice clicks the heart, then opens Favorites | Laptop listed; second click removes it and the list updates |
| 6 | Laptop page with two empty mandatory variables | page loads | Required information panel shows two chips in form order and the submit button is disabled |
| 7 | Same page | alice fills one variable | panel shows one chip; clicking it focuses that variable |
| 8 | All mandatory filled, request_method order | alice clicks Order Now and confirms | RITM created with requested_for alice; browser lands on the ticket page; toast shows the number |
| 9 | alice's profile location HQ | Laptop page loads | Location variable shows HQ; switching Requested For to a user in Branch updates it to Branch |
| 10 | Attachment dropped on Laptop page | order submitted | the attachment is linked to the new RITM |
| 11 | Producer "Report an IT Issue" (UR-enabled) | alice submits | incident and universal_request (prefix UR) created; UR primary_task = incident; incident.universal_request = UR |
| 12 | Item 11 done | alice opens My Tickets | one row with the UR number, not the incident; Module shows IT |
| 13 | UR with primary RITM in Open | RITM moves to Work in Progress | UR state In Progress |
| 14 | UR with primary RITM, needs_resolution_review false | RITM closes Closed Complete | UR state Closed |
| 15 | Same with needs_resolution_review true | RITM closes | UR not closed; state_reason confirm_response; UR state Awaiting |
| 16 | ria on a UR without primary ticket | Create Incident | incident caller = UR opened_for, short description copied, UR primary_task set, Associated Tickets lists it |
| 17 | My Tickets with 30 rows | alice sorts by Created ascending and searches "RITM00" | rows filtered by number prefix and sorted; Updated column shows relative times |
| 18 | Closed RITM with a ready survey instance | My Tickets renders | that row shows "Take survey"; header My Surveys badge shows 1 |
| 19 | Survey taken and submitted | header reloads | badge hidden; instance state complete; `asmt_metric_result` rows exist |
| 20 | RITM closes twice (reopen then close) | survey trigger runs | still only one instance for that RITM and user |
| 21 | Ticket page for a RITM awaiting approval | page loads | timeline: Submitted done, Awaiting Approval current, Fulfillment and Closed pending; hovering shows the approver |
| 22 | RITM approved, tasks open | page loads | Awaiting Approval done with the approval timestamp; Fulfillment current |
| 23 | RITM rejected | page loads | timeline ends with a Cancelled terminal step; state badge Cancelled |
| 24 | Ticket page of bob's RITM | alice opens it by URL | 404 page; no data returned |
| 25 | Ticket page | alice adds a comment | comment appears at top of Activity and on the RITM `comments` journal |
| 26 | Search "vpn" source All | results render | groups Knowledge Articles and Catalogs with counts; Knowledge filters Topic, Knowledge Base, Type of Article visible |
| 27 | Search with source Catalogs | results render | knowledge filters hidden; only orderable visible items appear |
| 28 | Language toggle | alice switches to Arabic | `<html dir="rtl" lang="ar">`, menu mirrored, translated item names shown where translations exist, English fallback elsewhere; preference persists after re-login |
| 29 | Tour for `index` active for employees | alice opens Tours and finishes it | tour marked done for alice; it no longer auto-starts |
| 30 | VA: alice types "my laptop screen is broken" | discovery runs | "Report an IT issue" starts (keyword score above threshold) |
| 31 | VA Report an IT issue | alice says the article did not help, urgency High | incident with urgency 1, contact_type virtual_agent, caller alice, and a UR; card shows the UR number |
| 32 | VA input matching two topics within 0.1 | discovery runs | picker with both topics plus "Something else" |
| 33 | VA gibberish input | discovery runs | Fallback topic, then knowledge search, then live agent offer |
| 34 | VA Check ticket status | alice selects her RITM | card shows stage and assignment group; "Add comment" writes to the RITM |
| 35 | Live agent requested outside support hours | handoff runs | error message plus support hours, phone and email; offer to report an issue |
| 36 | Conversation idle 2 h | idle job runs | conversation state completed (or faulted when abandoned mid-topic) |
| 37 | Walk-up location open, 3 waiting, average wait 6 min each | alice opens check-in | estimated wait shows 18 minutes; Join queue creates an interaction in state queued |
| 38 | alice in queue | clicks Leave queue | interaction state closed_abandoned |
