# ResolvrNow Spec: Service Catalog and Request Management

Status: draft v1 (clean-room). Parity target: ServiceNow "Brazil" public documentation.
Companion data file: `docs/spec/data/catalog-knowledge.json` (choices, extra tables, variable type codes, properties).

## 0. Conventions

- **[Documented]**: the fact (name, value, behaviour) is stated in the public ServiceNow docs cited in that section. These are compatibility requirements.
- **[Inferred]**: a gap we filled (likely platform value or a ResolvrNow design decision). Implementers may revise these, but must keep them consistent across specs.
- Tables already declared in `server/src/schema/sdk/sdk-tables.json` (the "SDK JSON", loaded by `server/src/schema/sdk.ts`) are referenced, not redeclared. New tables, extension columns (`extendsExisting`) and all choice lists live in the companion JSON.
- Generic engines are specified elsewhere: roles and ACLs in `platform-core.md`, the HTTP layer in `rest-api.md`, approvals and flows in `approvals-flows.md`, events and email in `notifications-events.md`. This spec only adds catalog-specific rules on top of them.
- Storage: `sc_request`, `sc_req_item` and `sc_task` extend `task` and are stored as rows of the `task` table (table-per-hierarchy, discriminated by `sys_class_name`). Catalog definition tables extend `sys_metadata`.
- Wording rule for implementers: UI copy in ResolvrNow must be original; only names, values and codes mirror ServiceNow.

## 1. Scope

| In scope (v1) | Out of scope (v1) |
|---|---|
| Catalogs, categories, items (standard, record producer, order guide, content item) | Catalog Builder, AI authoring, conversational (LLM) catalog |
| Variables, variable sets (single and multi-row), question choices | Wizard items (`sc_cat_item_wizard`), service items (`sc_cat_item_service`) |
| Catalog UI policies and catalog client scripts (portal runtime) | CMS and classic mobile rendering, domain separation |
| Pricing, quantity, cart, one-step and two-step checkout, delivery time | Legacy graphical workflows (`wf_workflow`); execution plans are schema-only plus sequential tasks |
| `sc_request`, `sc_req_item`, `sc_task` lifecycle, approvals, flows | Bundles, catalog wish-list sharing, Now Mobile |
| Record producers, order guides, delegation (requested for) | Entitlement scripts (legacy access model) |
| Roles, ACLs, notifications, Service Catalog REST API | Service Catalog Open API (TMF) |

## 2. Data model overview

Sources: https://www.servicenow.com/docs/r/it-service-management/request-management/request-management-architecture.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_ServiceCatalogProperties.html

```
sc_catalog 1..* sc_category (tree: sc_category.parent)
sc_cat_item  (class hierarchy: sc_cat_item > sc_cat_item_producer | sc_cat_item_guide | sc_cat_item_content)
  *..* sc_catalog       via sc_cat_item.sc_catalogs (glide_list) and sc_cat_item_catalog
  *..1 sc_category      via sc_cat_item.category (+ sc_cat_item_category for extra categories)
  1..* item_option_new  (variables, cat_item)            item_option_new 1..* question_choice
  *..* item_option_new_set via io_set_item               item_option_new_set 1..* item_option_new (variable_set)
sc_cart 1..* sc_cart_item 1..* sc_item_option (linked through sc_item_option_mtom)
sc_request 1..* sc_req_item 1..* sc_task
sc_req_item 1..* sc_item_option (through sc_item_option_mtom)       answers for RITMs
<target task record> 1..* question_answer                          answers for record-producer output
sysapproval_approver.sysapproval -> task (sc_request or sc_req_item)
```

| Table | Extends | Number | Defined in | Notes |
|---|---|---|---|---|
| sc_catalog, sc_category, sc_cat_item, sc_cat_item_producer, sc_cat_item_guide, item_option_new_set, sc_cat_item_delivery_plan, sc_cat_item_delivery_task, sc_ordered_item_link, sc_template | sys_metadata (producer, guide extend sc_cat_item) | none | SDK JSON | **[Documented]** |
| sc_request | task | REQ0010000 | SDK JSON | prefix REQ **[Documented]** |
| sc_req_item | task | RITM0010000 | SDK JSON (no number block) | prefix RITM **[Inferred]**: SDK omits it; ResolvrNow seeds `sys_number` row |
| sc_task | task | SCTASK0010000 | SDK JSON | **[Documented]** |
| sc_cat_item_content, sc_cat_item_category, sc_cat_item_catalog, sc_cat_item_user_criteria_mtom, sc_cat_item_user_criteria_no_mtom, sc_category_user_criteria_mtom, sc_category_user_criteria_no_mtom, item_option_new, question_choice, io_set_item, catalog_ui_policy, catalog_ui_policy_action, catalog_script_client, sc_cart, sc_cart_item, sc_item_option, sc_item_option_mtom, question_answer, sc_multi_row_question_answer, sc_item_produced_record, sc_cat_item_guide_items, sc_cat_item_app_user, sc_cat_item_app_group, sc_script_order_guide_failure, request_filter | various | none | companion JSON | Table names in the docs are **[Documented]**; field lists are mostly **[Inferred]** |

Hard rules **[Documented]**:
1. Variables attach only to `sc_req_item` (not to tables that extend it).
2. Record producers must never insert `sc_request`, `sc_req_item`, `sc_task` (or extensions). ResolvrNow enforces this by rejecting a producer whose `table_name` is one of these (validation error on save) **[Inferred]** enforcement.
3. No `before` business rules on `sc_request`, `sc_req_item`, `sc_cart`, `sc_cart_item`. ResolvrNow's own logic for these runs inside the checkout service and in `after` rules **[Inferred]** placement.

## 3. Catalogs and categories

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_ServiceCatalogManagementTermsandRoles.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_ServiceCatalogAccessControls.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/t_AppUserCritItemsCat.html

### 3.1 sc_catalog

| Field | Behaviour |
|---|---|
| title (mandatory) | Must be unique across catalogs. Enforced by a validation rule on insert/update **[Documented]** (SDK hint) |
| manager (sys_user) | May edit, update and delete this catalog plus its categories and items; may assign editors and another manager **[Documented]** |
| editors (glide_list sys_user) | May edit and update the catalog, categories and items; may add editors; may not change the manager **[Documented]** |
| active, description, desktop_image, enable_wish_list | Standard. Inactive catalogs are hidden from portals and the API **[Inferred]** |

Seed data **[Inferred]**: one catalog "Service Catalog" (default catalog; `sc_cat_item.sc_catalogs` defaults to it, mirroring the SDK default script) and one "Technical Catalog" used by the fulfiller UI.

### 3.2 sc_category

- Tree through `parent`; `sc_catalog` is required for ResolvrNow; a child must belong to the same catalog as its parent **[Inferred]**.
- `order` sorts siblings, then `title` **[Inferred]**.
- Access: Available For / Not Available For user criteria (`sc_category_user_criteria_mtom`, `sc_category_user_criteria_no_mtom`). "Not Available For" wins over "Available For". Category restrictions do not cascade to the items in it **[Documented]**.
- Legacy `roles` field: if non-empty, user must hold one of the roles **[Inferred]**.

### 3.3 Item visibility algorithm `canView(user, item, channel)`

1. `item.active = true` and the item belongs to at least one active catalog exposed to the channel **[Inferred]**.
2. If `glide.sc.use_user_criteria` is true (default true): deny when the user matches any Not Available For criterion; else allow when there are no Available For criteria, or the user matches at least one **[Documented]** for precedence, **[Inferred]** for "no criteria means everyone".
3. User criteria match: a `user_criteria` row matches when the user satisfies any populated dimension (users, groups, roles, departments, companies, locations), or all populated dimensions when `match_all = true`; `advanced = true` evaluates `script` **[Documented]** (match any vs match all), **[Inferred]** for evaluation order.
4. Channel flags: `hide_sp` hides from portals; `no_search` hides from search and from portal browsing; `availability` restricts desktop vs mobile **[Documented]**.
5. Portal search returns only items assigned to a category; in Employee Center only items with a taxonomy topic **[Documented]**.
6. Checkout repeats the access check (it also applies to scripts and API calls) **[Documented]**.

## 4. Catalog items

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_ExtendedCatalogItemFunctions.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/catalog-item-form.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/t_AddingContentItemServiceCatalog.html

### 4.1 Item classes

| Class (`sys_class_name`) | Purpose | Result of ordering |
|---|---|---|
| sc_cat_item | Standard goods or service item | One `sc_request` plus one `sc_req_item` per cart line **[Documented]** |
| sc_cat_item_producer | Record producer: friendly form that creates a task-based record (for example an incident) | One record in `table_name`; no REQ/RITM **[Documented]** |
| sc_cat_item_guide | Order guide: rules choose several items, one submission | One `sc_request` with several RITMs (`order_guide` set) **[Documented]** |
| sc_cat_item_content | Content item: information only (KB article, HTML block, external URL) | Nothing is created **[Documented]** |

### 4.2 Key sc_cat_item fields (behavioural view)

| Group | Fields | Notes |
|---|---|---|
| Identity | name, short_description, description (HTML), picture, icon, meta (search tags) | `meta` is a comma-separated keyword list used by catalog search **[Documented]** |
| Placement | sc_catalogs, category, order, taxonomy_topic | Category selectable only after a catalog is chosen **[Documented]** |
| Ownership | owner, secondary_owners (user_criteria list) | Matching users may edit the item; only catalog admin or owner may change secondary owners **[Documented]** |
| Fulfillment | flow_designer_flow, workflow, delivery_plan, delivery_plan_script, group (fulfillment group), delivery_time (default 2 days), fulfillment_automation_level | Exactly one of flow / workflow / execution plan may be set **[Documented]**. ResolvrNow ignores `workflow` (no legacy engine) **[Inferred]** |
| Access | access_type (restricted / delegated), roles, Available For / Not Available For | `access_type` only matters when the item has a Requested For variable **[Documented]** |
| Pricing | price, recurring_price, recurring_frequency, cost, list_price, omit_price, ignore_price, billable | See section 6 |
| Portal settings | request_method, no_cart_v2, no_quantity_v2, no_delivery_time_v2, no_wishlist_v2, no_attachment_v2, no_save_as_draft, mandatory_attachment | See 4.3 |
| Legacy UI flags | no_cart, no_order, no_order_now, no_proceed_checkout, no_quantity, no_search, use_sc_layout, visible_standalone, visible_guide, visible_bundle | `visible_guide` controls inclusion in order guides **[Documented]** |
| Channels | hide_sp, availability, make_item_non_conversational | **[Documented]** |
| Universal Request | UR enabled flag, Requires Additional Review flag | Visible only with the UR plugin; see portal spec. ResolvrNow column names `ur_enabled`, `ur_requires_review` **[Inferred]** |

### 4.3 request_method (portal submit behaviour) **[Documented]**

| Value **[Inferred]** | Button label | Confirmation dialog | Delivery info | Defaults it implies |
|---|---|---|---|---|
| order (default) | Order Now | shown | editable | none |
| request | Request | shown | hidden | Hide Add to Cart and Hide Quantity on |
| submit | Submit | not shown | hidden | Hide Add to Cart, Hide Quantity, Hide Delivery time on |

### 4.4 Content items **[Documented]**

`content_type` = KB Article (`kb_article` reference, opens the article page), Catalog Content (HTML from description), External Content (`url`, must be absolute). `target` = within catalog or new window/tab. Content items are excluded from order guides (`glide.sc.item.order_guide_exclusion`) and have no cart button. Choice values are in the companion JSON **[Inferred]**.

## 5. Variables (questions)

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_ServiceCatalogVariables.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_VariableTypes.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/t_CreateAVariableForACatalogItem.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/variable-attributes.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/define-question-choice-var.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html

### 5.1 item_option_new (variable) fields

| Field | Meaning | Basis |
|---|---|---|
| cat_item / variable_set | Owner: an item or a variable set (exactly one) | Documented (form), Inferred (exclusivity) |
| type | Integer type code (5.2) | Documented field; codes see 5.2 |
| name | Script name; auto-derived from question text when blank (except break, container split/end) | Documented |
| question_text | Label shown to the user | Documented ("Question") |
| order | Ascending render order | Documented |
| active, mandatory, read_only, hidden | Initial state on load; client policies may change them at runtime | Documented |
| default_value | Literal, or `javascript:` expression (admin only) | Documented (Default value), Inferred (script gate) |
| tooltip, example_text, show_help, help_tag, help_text, instructions, always_expanded | Help and hints | Documented |
| reference, reference_qual_condition, use_reference_qualifier (simple / dynamic / advanced), dynamic_ref_qual, reference_qual | Reference-style filtering | Documented |
| list_table, lookup_table, lookup_value, lookup_label, lookup_price, lookup_rec_price, lookup_source (table / choices), choice_table, choice_field, dependent_on (Choices depend on) | Lookup and list collector sources | Documented (labels), Inferred (column names) |
| include_none, do_not_select_first, choice_direction (across / down), unique_values | Choice rendering | Documented |
| scale_min, scale_max | Numeric scale bounds (ResolvrNow default 1 and 5) | Documented fields, Inferred defaults |
| price_if_checked, rec_price_if_checked, pricing_implications | Price effects (section 6) | Documented |
| use_confirmation, use_encryption (default true) | Masked variable options | Documented |
| validate_regex | Regex for single line and wide single line text | Documented |
| attributes | `name=value` pairs, comma separated; multiple values separated by `;` | Documented |
| global | Visible on every catalog task of the RITM | Documented |
| map_to_field, field | Record producer target mapping | Documented |
| read_roles, write_roles, create_roles | Variable-level permissions (empty means anyone with item access) | Documented |
| visible_standalone, visible_bundle, visible_guide, visible_summary | Where the variable shows | Documented |
| unique, hide_on_grid | MRVS only | Documented |
| selection_required | Check box must be ticked to submit | Documented |
| enable_also_request_for, also_request_for_roles | Requested For variable only | Documented |

### 5.2 Variable types and codes

Codes 2, 6 and 7 appear in the documented REST example (with `friendly_type` multi_line_text, single_line_text, check_box). The remaining codes are the conventional platform values **[Inferred]**; ResolvrNow must use exactly these so exported data stays compatible.

| Code | Type | friendly_type (API) | Collects data | Notes |
|---|---|---|---|---|
| 1 | Yes / No | yes_no | yes | Stores `Yes` / `No` |
| 2 | Multi Line Text | multi_line_text | yes | **[Documented]** code |
| 3 | Multiple Choice | multiple_choice | yes | Radio buttons from question_choice; price per choice |
| 4 | Numeric Scale | numeric_scale | yes | Radios from scale_min..scale_max |
| 5 | Select Box | select_box | yes | Dropdown from question_choice or choice_table/field |
| 6 | Single Line Text | single_line_text | yes | **[Documented]** code; max_length, validate_regex |
| 7 | CheckBox | check_box | yes | **[Documented]** code; consecutive check boxes form a group labelled "Options" unless a label precedes them |
| 8 | Reference | reference | yes | Stores sys_id |
| 9 | Date | date | yes | |
| 10 | Date/Time | date_time | yes | Stored in UTC, shown in user time zone **[Documented]** |
| 11 | Label | label | no | Formatting only |
| 12 | Break | break | no | Horizontal rule |
| 14 | Custom (UI macro) | custom | no | Not rendered by ResolvrNow v1 (placeholder) |
| 15 | UI Page | ui_page | no | Not rendered by ResolvrNow v1 |
| 16 | Wide Single Line Text | wide_single_line_text | yes | Spans the form |
| 17 | Custom with Label | custom_with_label | no | Not rendered by ResolvrNow v1 |
| 18 | Lookup Select Box | lookup_select_box | yes | Values from lookup table or choices |
| 19 | Container Start | container_start | no | layout 1 or 2 columns; the documented API sample nests children under the container node |
| 20 | Container End | container_end | no | |
| 21 | List Collector | list_collector | yes | Stores comma-separated sys_ids; max 100 shown in available list |
| 22 | Lookup Multiple Choice | lookup_multiple_choice | yes | |
| 23 | HTML | html | yes | Rich text |
| 24 | Container Split | container_split | no | Column split |
| 25 | Masked | masked | yes | Asterisks on entry; encrypted at rest by default |
| 26 | Email | email | yes | Validated as email |
| 27 | URL | url | yes | Validated as URL |
| 28 | IP Address | ip_address | yes | IPv4 and IPv6 |
| 29 | Duration | duration | yes | Value format `DD HH:MM:SS`; attribute `max_unit` |
| 31 | Requested For | requested_for | yes | One per item; drives delegation (section 10) |
| 32 | Rich Text Label | rich_text_label | no | Formatted label |
| 33 | Attachment | attachment | yes | Stores sys_attachment sys_id; `max_file_size`, `allowed_extensions` |

### 5.3 Variable attributes **[Documented]**

| Attribute | Applies to | Effect |
|---|---|---|
| allowed_extensions=txt;pdf | Attachment | Allowed file extensions |
| max_file_size=2 | Attachment | MB limit (also capped by global attachment limits) |
| max_length=200 | Single line, wide single line | Character limit (still applies with a regex) |
| barcode=true | Single line | Camera scan on mobile (ignored by ResolvrNow web) |
| glide_list | List collector | Use tag-style list instead of slushbucket (the only mode supported inside MRVS) |
| no_filter | List collector | Hide filter controls |
| is_searchable_choice=true | Select box, lookup select box | Searchable dropdown (platform UI only) |
| max_unit=days/hours/minutes/seconds | Duration | Largest unit shown |
| ref_ac_columns=a;b | Reference, Requested For | Extra autocomplete columns |
| ref_ac_order_by=field | Reference | Autocomplete sort |
| ref_auto_completer=AJAXTableCompleter | Reference | Autocomplete renderer (ResolvrNow: table vs list rendering) |
| ref_qual_elements=a;b | Lookup, list collector | Variables sent back to recompute qualifiers |

Variable set attribute: `max_rows=N` limits MRVS rows (hard maximum 50 rows) **[Documented]**.

### 5.4 question_choice **[Documented]**

Fields: `question` (variable), `text` (label), `value` (stored), `order`, `price`, `recurring_price`, `inactive`. Changing choices affects existing RITMs; a deleted choice that was already selected keeps its stored value.

### 5.5 Variable sets **[Documented]** unless noted

- `item_option_new_set.type`: `one_to_one` (Single Row) or `one_to_many` (Multi Row, MRVS). Linked to items and order guides through `io_set_item` (fields `sc_cat_item`, `variable_set`, `order`) **[Inferred]** column names.
- Scripts and UI policies refer to the set by `internal_name`; a variable name in an item must not equal a set title or internal name, and two sets in one item must not share an internal name.
- Access: set-level read/write/create roles are checked first; if the set denies, the variable settings are ignored.
- MRVS forbids: Attachment, Break, Container Start/Split/End, HTML, Label, Macro, Macro with label, Rich Text Label, UI Page, Requested For, and variables with read roles. MRVS variables cannot be `global`, so they never appear on catalog tasks. Item-level UI policies and client scripts do not reach MRVS variables; `onSubmit` scripts are not allowed inside an MRVS. Map to field is not supported in an MRVS.
- MRVS storage: one JSON array string per MRVS on submit (API and `variables` field), persisted row by row in `sc_multi_row_question_answer` **[Inferred]**.

### 5.6 Where answers are stored

| Context | Storage | Basis |
|---|---|---|
| Cart line | `sc_item_option` (item_option_new, value, order) linked by `sc_item_option_mtom` (cart_item) | Documented tables, Inferred link column |
| Requested item | same `sc_item_option` rows, relinked at checkout: `sc_item_option_mtom.request_item` = RITM | Documented |
| Record producer output | `question_answer` (table_name, table_sys_id, question, value, order) on the generated record | Documented table, Inferred columns |
| Any task | `task.variables` (virtual field type `variables`) exposes answers as `current.variables.<name>` and in the Table API as `variables.<name>` | Documented field in SDK JSON, Inferred API shape |
| Orphans | When a RITM is deleted, up to `sc_orphan_item_option_delete_limit` orphan options are purged | Documented |

Value encoding **[Inferred]**: all values are strings; check box `true`/`false`; Yes/No `Yes`/`No`; reference/attachment sys_id; list collector comma-separated sys_ids; date `yyyy-MM-dd`; date/time `yyyy-MM-dd HH:mm:ss` UTC; duration `DD HH:MM:SS` (the documented input format); masked values encrypted (AES-GCM in ResolvrNow) and only decrypted for the requester or holders of `catalog_view_masked`.

### 5.7 Catalog UI policies **[Documented]** unless noted

- `catalog_ui_policy`: applies_to (item / variable set), catalog_item or variable_set, short_description, active, catalog_conditions (encoded query over variables), applies_catalog (item view), applies_req_item, applies_sc_task, applies_target_record, on_load, reverse_if_false, run_scripts with script_true / script_false, order.
- `catalog_ui_policy_action`: variable (or set), order, mandatory / visible / disabled (read only), each `ignore` (leave alone) / `true` / `false`; value_action (`ignore`, `set_value`, `clear_value`) with value; field_message_type (none / info / warning / error) with field_message.
- Precedence: mandatory beats read-only and hidden; a mandatory empty variable is forced visible and editable; a container or set holding an empty mandatory variable cannot be hidden. Item policies run before set policies unless `glide.sc.ui_policy.variable_set_run_first` is true. Lower `order` wins between conflicting actions.
- Not applicable: mandatory and read-only on break, container split/end, macros, label, UI page; visible on break and container split/end.
- ResolvrNow runtime **[Inferred]**: the portal evaluates policies client-side with a shared TypeScript condition evaluator; the server re-evaluates the same policies at submit time to compute the effective mandatory set, so API submissions get identical validation.

### 5.8 Catalog client scripts **[Documented]** concept, **[Inferred]** ResolvrNow runtime

`catalog_script_client` (applies_to item or set, cat_item / variable_set, type onLoad / onChange (with `cat_variable`) / onSubmit, ui_type desktop / mobile-portal / all, script, active). ResolvrNow v1 runs them in a sandboxed browser worker exposing a `g_form` subset (getValue, setValue, setMandatory, setDisplay, setReadOnly, addInfoMessage, showFieldMsg, clearValue) and `g_service_catalog.isOrderGuide()`. Server never trusts client-only validation.

### 5.9 Submit validation (server) **[Inferred]**

Reject with HTTP 400 (API) or inline errors (portal) when: a visible mandatory variable is empty; `selection_required` check box is false; regex or `max_length` fails; email/URL/IP format fails; reference or lookup value not in its qualifier result; list collector element invalid; attachment missing when `mandatory_attachment`; MRVS rows exceed `max_rows` or 50; Requested For user not allowed (section 10).

## 6. Pricing, quantity, cart, checkout, delivery

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_ServiceCatalogVariablePricing.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_SetARecurringPrice.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_HidingPricesInTheServiceCatalog.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/t_ItemQuantity.html, https://www.servicenow.com/docs/r/it-service-management/request-management/c_EnableATwoStepCheckout.html, https://www.servicenow.com/docs/r/it-service-management/request-management/c_ExecutionPlanTasks.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/t_UsingBulkRequests.html

### 6.1 Price computation

Price-affecting variable types **[Documented]**: check box (`price_if_checked`, `rec_price_if_checked`), multiple choice and select box (choice `price`, `recurring_price`), reference (when `pricing_implications`: value of `price`, `u_price`, `recurring_price` or `u_recurring_price` on the referenced row), list collector (same, summed over selections), lookup select box (`lookup_price`, `lookup_rec_price` columns).

```
unitPrice      = item.price + sum(variable deltas)                 [Inferred formula]
unitRecurring  = item.recurring_price + sum(recurring deltas)
cartLine.price = unitPrice            ; line total = unitPrice * quantity
ritm.price     = unitPrice            ; ritm.recurring_price = unitRecurring
request.price  = sum(ritm.price * ritm.quantity)                   (read-only)
```

- `ignore_price` is computed true when the item has zero price and no price-affecting variables **[Documented]** (SDK hint).
- Display: zero prices hidden by default; `glide.sc.price.display` can force always/never; `omit_price` hides price for one item; classes in `glide.sc.item.cannot_show_price` (default: guides, producers) never show price **[Documented]**.
- Recurring frequency choices and cart grouping by frequency (Recurring Prices related list on the request) **[Documented]** concept; values in companion JSON **[Inferred]**.
- ResolvrNow v1 uses a single instance currency (property `resolvr.currency`, default `USD`) **[Inferred]**.

### 6.2 Quantity **[Documented]**

Choices come from `sc_cart_item.quantity` (default 1..10, editable in sys_choice). Hidden when `no_quantity` / `no_quantity_v2` or `request_method` is request/submit. `glide.sc.allow.quantity` restricts which roles can change it. After approval, RITM quantity is locked except for catalog_admin when `glide.sc.restrict.quantity.changes` is true.

### 6.3 Cart model

| Concept | Rule | Basis |
|---|---|---|
| Default cart | One active `sc_cart` per user (name `DEFAULT`) holding "Add to Cart" lines | Documented concept, Inferred name |
| Temporary cart | "Order Now" creates a throwaway cart for that one item; the default cart is untouched (`glide.sc.enable_order_now`) | Documented |
| Non-cart classes | Producers, guides, wizards never create normal cart lines (`glide.sc.item.not_normal_cart_item`) | Documented |
| Inactive items | Removed from carts when `glide.sc.remove_inactive_cat_items_from_cart` is true | Documented |
| Delivery address | Cart carries `requested_for`, `delivery_address`, `special_instructions`; address comes from the requested-for user's location (location record wins when `glide.sc.prioritise.user.location`) | Documented |
| Wish list | Lines with `sc_cart_item.active=false` in a per-user wish-list cart (`enable_wish_list` on the catalog, item flag `no_wishlist_v2`); regex errors block adding | Documented feature, Inferred storage |
| Draft | "Save as draft" stores a partially filled line (`sc_cart_item` in a `DRAFT` cart); listed in My Requests Drafts tab | Documented feature, Inferred storage |

### 6.4 Checkout models

| Model | Property | Sequence | Basis |
|---|---|---|---|
| One-step (default) | `glide.sc.checkout.twostep = false` | Order Now / Proceed to checkout -> records created -> order status page | Documented |
| Two-step | `glide.sc.checkout.twostep = true` | Checkout -> confirmation (edit lines, requested for, delivery location, special instructions, attachments) -> Submit Order -> status. `glide.sc.checkout.twostep.back` shows Back to Catalog | Documented |
| Portal confirm dialog | `glide.sc.sp.twostep` | Confirmation modal in portal two-step flow | Documented |

Delegated requests are not supported when two-step checkout is on **[Documented]**.

Checkout transaction (ResolvrNow implementation of the documented order of operations):

```
BEGIN (single SQLite transaction)
  1. re-check canView() and orderability for every line; re-validate variables (5.9)
  2. insert sc_request (number REQ..., opened_by=me, requested_for=cart.requested_for or me,
     request_state=requested, stage=requested, approval=not requested, price=sum)
  3. for each cart line (one RITM per line; the quantity stays on the RITM):
       insert sc_req_item (request, cat_item, sc_catalog, quantity, price, recurring_*,
       requested_for (Requested For variable or request.requested_for), order_guide,
       stage=waiting_for_approval, state=1, estimated_delivery)
       relink sc_item_option_mtom rows from cart line to the new RITM
       move line attachments to the RITM (portal drop zone attachments go to the RITM)
  4. delete temporary cart / empty default cart
COMMIT
after commit: async rules start the request flow and one item flow per RITM; events fire (section 12)
```

Clone: when `glide.sc.allow.checkout.clone` (pre-cart-layout) or cart layouts allow it, a request may be copied for up to 10 users; roles limited by `glide.sc.allow.clone.roles` **[Documented]**.

### 6.5 Delivery time

- `sc_cat_item.delivery_time` (duration, default 2 days) is shown on the item page unless hidden **[Documented]** (SDK default).
- With an execution plan, the estimate is the plan `total_delivery_time`, optionally computed on the plan `calendar` (working-hours days; a 24 h task on a 9-5 calendar counts as 3 working days) **[Documented]**.
- `ritm.estimated_delivery = opened_at + estimate`; `request.due_date = max(ritm.estimated_delivery)` **[Inferred]**. `glide.sc.round.delivery.times` rounds estimates over one day to whole days **[Documented]**.
- `sc_request.requested_date` holds the requester's desired date **[Documented]** (SDK hint).

## 7. Request, requested item, catalog task

Sources: https://www.servicenow.com/docs/r/it-service-management/request-management/request-fulfillment.html, https://www.servicenow.com/docs/r/it-service-management/request-management/state-closure-request.html, https://www.servicenow.com/docs/r/it-service-management/request-management/t_AddActiviToServiceCataWorkflow.html, https://www.servicenow.com/docs/r/it-service-management/request-management/req-item-state-mapping.html, https://www.servicenow.com/docs/r/servicenow-platform/self-service/t_AddNewRequestItems.html, https://www.servicenow.com/docs/r/servicenow-platform/self-service/t_DeleteRequestItems.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/case-api.html

### 7.1 Fields that matter (beyond `task`)

| Table | Field | Behaviour |
|---|---|---|
| sc_request | requested_for (default current user), request_state (default requested), stage (default requested), price (read-only total), requested_date, delivery_address, special_instructions, calendar_stc, parent_interaction | **[Documented]** fields (SDK JSON) |
| sc_req_item | request, cat_item, sc_catalog (read-only), quantity (default 1), price, recurring_price, recurring_frequency, requested_for, stage (default waiting_for_approval, read-only), estimated_delivery, backordered, billable, order_guide, flow_context, configuration_item | **[Documented]** fields (SDK JSON) |
| sc_task | request_item, request (read-only), cat_item (read-only, derived), sc_catalog (read-only), calendar_stc | **[Documented]** fields (SDK JSON) |
| task (inherited) | number, state, approval, approval_set, approval_history, assignment_group, assigned_to, short_description, description, comments, work_notes, due_date, opened_by, opened_at, closed_at, closed_by, active, universal_request, variables | **[Documented]** |

Derivations **[Inferred]**: RITM `short_description` = item name; `sc_task.request` and `cat_item` are copied from `request_item` on insert; `sc_task.short_description` defaults to item name; RITM `assignment_group` = item `group` when set.

### 7.2 Choice lists (full values in companion JSON)

| Field | Values (value = label) | Basis |
|---|---|---|
| sc_request.request_state | requested = Pending Approval; in_process = Approved; closed_complete; closed_incomplete; closed_cancelled; closed_rejected; closed_skipped | "Pending Approval" label and closure outcomes Documented; values Inferred (default `requested` from SDK) |
| sc_req_item.stage | waiting_for_approval; request_approved; fulfillment; delivery; complete = Completed; Request Cancelled | Labels Waiting for Approval, Fulfillment, Delivery, Completed Documented; values Inferred |
| sc_req_item.state and sc_request.state | 1 Open; 2 Work in Progress; -5 Pending; 3 Closed Complete; 4 Closed Incomplete; 7 Closed Skipped | Labels Documented (UR mapping, closure rules); integers Inferred (task convention) |
| sc_task.state | -5 Pending; 1 Open; 2 Work in Progress; 3 Closed Complete; 4 Closed Incomplete; 7 Closed Skipped | Labels Documented; integers Inferred |
| task.approval | not requested (default) = Not Yet Requested; requested; approved; rejected; cancelled; not_required = No Longer Required; duplicate | Documented values (Case API), labels Inferred except "Not Yet Requested" |

Also note: when a workflow-required record is deleted, the platform shows the stage as "Catalog item removed" or "Workflow context removed" **[Documented]**; ResolvrNow renders the same two display strings when `cat_item` or `flow_context` dangles.

### 7.3 Lifecycle (ResolvrNow default)

```
                 checkout
                    |
  REQ: requested (Pending Approval) --request approval--> in_process (Approved) --all RITMs closed--> closed_*
                    |                      \--rejected--> closed_rejected (RITMs cancelled)
  RITM: stage waiting_for_approval, state 1 Open
        --item approval approved (or none needed)--> stage fulfillment, state 2 (tasks created)
        --last task enters delivery phase (optional)--> stage delivery
        --all tasks closed--> stage complete, state 3/4/7 (roll-up), active=false
        --item approval rejected--> stage Request Cancelled, state 4, approval rejected
  SCTASK: 1 Open -> 2 Work in Progress -> 3 / 4 / 7 (closed), -5 Pending when not yet startable
```

Roll-up rules **[Documented]** (docs state them for execution plans; ResolvrNow applies them to every fulfillment path **[Inferred]**):

| Children | Parent result |
|---|---|
| All catalog tasks Closed Complete | RITM Closed Complete |
| At least one task Closed Incomplete | RITM Closed Incomplete |
| All tasks Closed Skipped | RITM Closed Skipped |
| Mixed complete and skipped, none incomplete | RITM Closed Complete **[Inferred]** |
| Same three rules over RITMs | REQ `state` 3/4/7 and `request_state` closed_complete / closed_incomplete / closed_skipped |

Other documented rules: items can be added to a submitted request only while `request_state = requested` and only by admin/catalog_admin; deleting an item recalculates request price and due date; neither action re-triggers approval **[Documented]**. A skipped execution-plan task advances to the next; skipping the last closes the RITM complete **[Documented]**.

Cancellation **[Inferred]**: the requester (or itil) may cancel a request while every RITM is still in `waiting_for_approval`: request_state = closed_cancelled, RITMs state 4 with stage Request Cancelled, open approvals set to `not_required`, open tasks closed skipped.

### 7.4 Approvals

Sources: https://www.servicenow.com/docs/r/it-service-management/request-management/t_AddActiviToServiceCataWorkflow.html, https://www.servicenow.com/docs/r/it-service-management/request-management/c_ScptblAsmtExctnPlns.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/catalog-item-form.html

| Source of approvers | Mechanism | Basis |
|---|---|---|
| Item "Approved By" users / "Approved By Group" groups | `sc_cat_item_app_user`, `sc_cat_item_app_group` rows; ResolvrNow default item flow creates one `sysapproval_approver` per user and per member of each group | Documented lists, Inferred tables and expansion |
| Manager of requested_for | Approval step "requested_for.manager" (the documented example workflow and plan script both use it) | Documented |
| Request-level | `sc_request.approval`; ResolvrNow default auto-approves unless `resolvr.sc.request_approval_threshold` (default -1 = off) is exceeded by `price`, then manager approval | Inferred |

Decision rules **[Inferred]**: an approval step completes approved when any one approver approves (policy `any`, configurable to `all` per flow step); one rejection rejects the step; remaining pending approvers become `not_required`. `task.approval` mirrors the step (`requested` while waiting, then `approved` / `rejected`); `approval_set` stamps the decision time; `approval_history` journal gets a line. With no approvers the step auto-approves.

### 7.5 Fulfillment flows (mapping onto the ResolvrNow flow engine)

Sources: https://www.servicenow.com/docs/r/it-service-management/request-management/request-fulfillment.html, https://www.servicenow.com/docs/r/it-service-management/request-management/c_ExecutionPlans.html, https://www.servicenow.com/docs/r/it-service-management/request-management/c_ExecutionPlanTasks.html

The docs describe three engines (flows, legacy workflows, execution plans). ResolvrNow implements flows natively and runs execution plans as a generated flow **[Inferred]**.

Seeded flow `sc_item_default` **[Inferred]** (used when `cat_item.flow_designer_flow` is empty and no `delivery_plan`):

| # | Action | Detail |
|---|---|---|
| T | Record trigger | `sc_req_item` inserted |
| 1 | Update | stage = waiting_for_approval |
| 2 | Approval | approvers = item user list + group members (+ requested_for.manager if item `u_manager_approval`); auto-approve if empty |
| 3 | If rejected | Update RITM: approval=rejected, stage=Request Cancelled, state=4, active=false; Notify; End |
| 4 | Update | approval=approved, stage=fulfillment, state=2 |
| 5 | Create task | `sc_task`: short_description=item name, assignment_group=item.group, request_item, priority=4; all `global` variables visible |
| 6 | Wait | until all child `sc_task` inactive |
| 7 | Update | stage=complete, state from roll-up, active=false, closed_at/closed_by |

Seeded flow `sc_request_default`: trigger `sc_request` inserted; optional threshold approval; set request_state=in_process (approved) or closed_rejected; on rejection cancel child RITMs.

Execution plans: tasks (`sc_cat_item_delivery_task`) created in `order`; tasks with the same order run in parallel, blank order means no dependency; `condition` gates creation; approval tasks may roll back to an earlier task on rejection (intermediate tasks reset to Pending) or cancel all future tasks and the RITM (default) **[Documented]**. ResolvrNow v1 supports sequential creation and "cancel on reject"; rollback is v2 **[Inferred]**.

Variables in tasks: global variables appear on every task; non-global ones only when attached to the task (variable editor) **[Documented]**.

### 7.6 Business rules (TypeScript)

| Table | When | Rule | Basis |
|---|---|---|---|
| sc_request | at insert, inside the checkout service (not a `before` rule, see section 2 rule 3) | number, defaults (requested_for, request_state, stage), price | Inferred |
| sc_req_item | after insert (async) | start item flow; fire `sc_request.requested_for` when request opened for someone else | Inferred |
| sc_req_item | after update | on close: roll up to request; on assignment change fire `sc_req_item.assigned`; on stage=delivery fire `sc_req_item.delivery` | Documented events, Inferred rule |
| sc_req_item | field write ACL on `quantity` (not a `before` rule) | deny quantity change after approval except catalog_admin when `glide.sc.restrict.quantity.changes` is true | Documented property, Inferred mechanism |
| sc_task | before insert | copy request, cat_item, sc_catalog from request_item | Documented (SDK default script) |
| sc_task | after update | fire `sc_task.assigned.to.user` / `sc_task.assigned.to.group`; on close of last open task signal the waiting flow | Documented events |
| sysapproval_approver | after update | propagate decision to the approval step; fire `request.approval.*` / `approval.*` events | Documented events |

## 8. Record producers

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_RecordProducer.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_PopulatingRecordData.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/record-producer-form.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_CreatingVariablesForFieldTypes.html

Producer-specific fields **[Documented]**: `table_name` (mandatory target), `template` (static field values), `script` (runs before insert; must not call update/insert or change `sys_class_name`), `post_insert_script` (runs after insert, may call `current.update()`, overrides template and mapped values), `redirect_url` (generated record or catalog home; default from `glide.sc.producer.redirect_url`), `can_cancel`, `allow_edit`, `save_options`, `view`.

Submit algorithm:

| Step | Action | Basis |
|---|---|---|
| 1 | Validate variables (5.9) and access (3.3) | Inferred |
| 2 | Build an unsaved record of `table_name` | Documented |
| 3 | Apply `template` values | Documented |
| 4 | Map variables: a variable whose `name` equals a field name, or with `map_to_field` + `field`, sets that field (type-checked using the recommended pairs below) | Documented |
| 5 | Run `script` with `current`, `producer` (variable values; `producer.redirect`, `producer.portal_redirect`) and `cat_item`; URL parameters via `RP.getParameterValue()` | Documented |
| 6 | If the script aborts, nothing is created and no `sc_item_produced_record` row is written | Documented |
| 7 | Insert the record (normal business rules run) | Documented |
| 8 | Write `question_answer` rows for answer-carrying variables (skip variables mapped to encrypted fields); MRVS rows to `sc_multi_row_question_answer` | Documented (encrypted rule), Inferred (rest) |
| 9 | Write `sc_item_produced_record` (producer, record table, record sys_id) | Documented table, Inferred columns |
| 10 | Copy portal attachments and attachment-variable files to the new record | Documented (copy behaviour) |
| 11 | Run `post_insert_script` | Documented |
| 12 | If UR-enabled, create the Universal Request with this record as primary task (portal spec) | Documented |
| 13 | Respond with redirect target and record number | Documented |

Recommended variable type per target field type **[Documented]**: True/False -> Yes/No; Reference -> Reference; Date or Due Date -> Date; Date/Time -> Date/Time; Choice -> Select Box; Email -> Email; URL -> URL; HTML -> HTML; List -> List Collector; String longer than 256 -> Multi Line Text; String, Integer, Decimal, Float -> Single Line Text; File attachment -> Attachment; everything else -> Multi Line Text. Reference values map as sys_id; list values as comma-separated sys_ids.

## 9. Order guides

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_ServiceCatalogOrderGuides.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/t_CreateARule.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_CascadeTheOrderGuideVariables.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/order-guide-form.html, https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/c_RunOrderGuidesAutomatically.html

- Screens **[Documented]**: Describe Needs (guide variables) -> Choose Options (one tab per included item; mandatory checks on tab switch per `glide.sc.guide.tab.validate`) -> Check Out (summary). `two_step` drops the last screen in the platform UI (not applicable to portals). `order_to_cart` (requires `two_step`) adds the items to the cart instead of ordering.
- Rule base `sc_cat_item_guide_items` **[Documented]** fields (column names **[Inferred]**): guide, position (tab order), condition (over guide variables, Keywords, Requested By, Requested For), item (catalog item or record producer), ignore_mandatory, use_cart_layout, show_quantity, quantity.
- Guide `script` may call `guide.add(itemSysId)` / `guide.remove(itemSysId)` **[Documented]**. `validator` script optional.
- Inclusion filter **[Documented]**: inactive items and items with `visible_guide = false` are skipped; with a Requested For variable, an item the requested-for user cannot access is skipped when `access_type = restricted`, kept when `delegated`. Classes listed in `glide.sc.item.order_guide_exclusion` are never included. `include_items` (Show Include Toggle) lets the user switch an item off in the portal.
- Cascading **[Documented]**: when `cascade = true`, item variables inherit values from guide variables with the same name; the Requested For value always cascades (by type, regardless of the flag) and is read-only in items.
- Result: one `sc_request`; each RITM has `order_guide` set **[Documented]** (SDK field). Two-step guide checkout uses a temporary cart; three-step uses the default cart **[Documented]**.
- Scriptable order guide **[Documented]**: server API `process(json)` requires `opened_by` and `requested_for` sys_ids; returns success flag; failures are stored in `sc_script_order_guide_failure` and can be reprocessed. UI policies are not enforced when run automatically. Properties `glide.sc.sog.*` decide which conditions create failure rows. ResolvrNow exposes this as flow action "Run order guide" and as the REST `submit_guide` endpoint.

## 10. Requested for and delegated requests

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/delegated-request-exp.html, https://www.servicenow.com/docs/r/it-service-management/request-management/create-request-from-other-flow.html, https://www.servicenow.com/docs/r/it-service-management/request-management/configure-mapping-for-request.html

**[Documented]** unless noted:

- An item may hold one Requested For variable (type 31). Without a default it is the current user. On submit its value is copied to `sc_req_item.requested_for` (later edits are not synchronised either way). For producers it maps to the target field through map_to_field.
- `access_type = delegated` allows ordering for a user who cannot see the item; `restricted` requires the requested-for user to have access.
- "Also request for" (portal only): one REQ owned by the submitter, one RITM per listed user; one cart line per user when added to cart. Not for producers or guides.
- Who may change requested for: roles in `glide.sc.req_for.roles` (blank uses `glide.sc.req_for.roles.default`).
- My Requests shows the RITM to its requested-for user when it differs from the REQ requested-for; otherwise the REQ.
- Request from another record: "Create Request" from a parent (for example an incident) opens the catalog; the request links back through Request Parent Mapping (parent table, request field, parent requestor field). Default mapping: incident. The parent's caller becomes requested for.

## 11. Roles and access

Sources: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_ServiceCatalogManagementTermsandRoles.html, https://www.servicenow.com/docs/r/it-service-management/request-management/req-mgmnt-roles-instld-itsm.html, https://www.servicenow.com/docs/r/it-service-management/request-management/c_ExecutionPlanTasks.html

| Role | Grants | Basis |
|---|---|---|
| admin | Everything, including scripted parts (script fields, `javascript:` defaults, advanced qualifiers) | Documented |
| catalog_admin | Manage catalogs, categories, items, variables, variable sets, UI policies, client scripts, user criteria; no server scripting | Documented |
| catalog_manager | On catalogs where the user is `manager`: edit/update/delete catalog, categories, items; assign editors and manager; attach existing variable sets and user criteria (cannot create sets or criteria) | Documented |
| catalog_editor | On catalogs where the user is in `editors`: edit/update; add editors; cannot change manager or delete | Documented |
| itil | Fulfiller: read all requests, RITMs, catalog tasks; update those assigned to self or own groups | Documented role, Inferred ACL detail |
| catalog | Given (with itil) to fulfillment groups of type `catalog` | Documented |
| sn_request_read / sn_request_write / sn_request_comment_write / sn_service_desk_agent | Granular ITSM Roles variant: read only when also an approver; write; comment write; agent | Documented |
| approver_user | Act on `sysapproval_approver` rows assigned to self | Documented (role name), Inferred scope |
| catalog_view_masked | Reveal masked variable values in the variable editor | Documented |
| (no role) | Order visible items; read own REQ/RITM (opened_by, requested_for, watch list); comment on own RITM; read and close only the `sc_task` rows assigned to them (for example the documented "pick up laptop" task assigned to the requester), no other `sc_task` access | Inferred (the assignment example is Documented) |

## 12. Notifications and events

Sources: https://www.servicenow.com/docs/r/platform-administration/r_BaselineEmailNotifications.html, https://www.servicenow.com/docs/r/it-service-management/request-management/view-request-notification.html

| Notification | Event | Recipient | Basis |
|---|---|---|---|
| Request Opened on Behalf | sc_request.requested_for | requested_for when not the submitter | Documented |
| Request Approved | sc_request.approved | opener | Documented |
| Request Assigned | sc_request.assigned | assignee | Documented |
| Request Completed | sc_request.updated (closed complete condition) | opener | Documented |
| Request Item Assigned | sc_req_item.assigned | RITM assignee | Documented |
| Request Item Delivery | sc_req_item.delivery | requested_for | Documented |
| Email assigned to (sc_task) | sc_task.assigned.to.user | task assignee | Documented |
| Email assigned to group (sc_task) | sc_task.assigned.to.group | group members | Documented |
| Catalog Approval Request | request.approval.inserted | approver | Documented |
| Catalog Approval Request (cancelled) | request.approval.cancelled | approver | Documented |
| Catalog Approval Rejected | request.approval.rejected | opener | Documented |
| Approval Request / Rejected / Rejected by Other | approval.inserted, approval.rejected, approval.rejected.by.other | approver / opener | Documented |
| Request item commented | sc_req_item.commented | requested_for or assignee | Inferred |

End users only receive these when their notification preferences allow it **[Documented]**. Email bodies are ResolvrNow-authored templates **[Inferred]**.

## 13. Properties (selected)

Source: https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/r_ServiceCatalogProperties.html. Names are **[Documented]**; defaults are **[Documented]** except those marked "(ResolvrNow)" or in parentheses, which are **[Inferred]**. Full list with types and basis in the companion JSON.

| Property | Default | Effect |
|---|---|---|
| glide.sc.checkout.twostep | false | Two-step checkout |
| glide.sc.enable_order_now | true (ResolvrNow) | Order Now leaves default cart untouched |
| glide.sc.use_user_criteria | true | User criteria access model |
| glide.sc.producer.redirect_url | generated_record | Producer landing page |
| glide.sc.item.not_normal_cart_item | sc_cat_item_guide, sc_cat_item_producer, sc_cat_item_wizard | No cart lines for these classes |
| glide.sc.item.cannot_add_to_request | same as above | Cannot be added to an existing request |
| glide.sc.allow.quantity | blank (everyone) | Who can change quantity |
| glide.sc.restrict.quantity.changes | true (ResolvrNow) | Lock quantity after approval |
| glide.sc.price.display | (zero prices hidden) | When to show prices |
| glide.sc.req_for.roles | blank | Who may change Requested For |
| glide.sc.remove_inactive_cat_items_from_cart | false | Purge inactive items from carts |
| glide.sc.search.disabled_cats | true | Items in inactive categories still searchable |
| glide.sc.guide.tab.validate | true | Validate mandatory variables when switching guide tabs |
| glide.sc.ui_policy.variable_set_run_first | false | Run set policies before item policies |
| glide.sc.audit.variables | (off) | Audit variable value changes |

## 14. Service Catalog REST API

Source: https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html. Paths, parameters, field names, status codes and messages are **[Documented]** unless tagged.

### 14.1 Conventions

- Base path `/api/sn_sc/servicecatalog`; versioned form `/api/sn_sc/{api_version}/servicecatalog` (`v1`, `v2`; omitted = latest). ResolvrNow serves both forms from one handler **[Inferred]**.
- Calls run as the authenticated user ("cart" and "wish list" are always the caller's). Only `DELETE /cart/{sys_id}/empty` needs a role (admin or catalog_admin).
- Envelope `{"result": ...}`; DELETE success is 204 with no body. JSON and XML accepted (`Accept`, `Content-Type`); ResolvrNow v1 implements JSON only and answers 406 for XML **[Inferred]**.
- Entitlement or access failures return **400** (never 403). 401 for missing credentials, 500 for unexpected errors. Error body: `{"error":{"message":"...","detail":"..."},"status":"failure"}` **[Inferred]** (platform convention).
- Paging: `sysparm_limit` (default 10000) and `sysparm_offset` (default 0, non-negative). The platform applies the limit before access filtering, so pages can be short. ResolvrNow may filter first and then page **[Inferred]** (compatible, because clients already tolerate short pages). The HTTP-layer authority for this API is `rest-api.md` section 10; this section adds catalog semantics.
- `sysparm_view`: `desktop`, `mobile` or `both`.
- Value formats: money as display strings with symbol and grouping (`"$1,598.00"`); `quantity` as string; cart `subtotal` / `recurring_subtotal` as numbers; timestamps `"YYYY-MM-DD HH:mm:ss"`; `show_subtotal_price` as the string `"true"` / `"false"`.
- Request bodies key variables by variable **name**; cart, wish list and checkout responses key `variables` by question **label** with string values.

### 14.2 Endpoints

| ID | Method and path (after base) | Purpose | Success |
|---|---|---|---|
| SC-01 | GET /catalogs (`sysparm_text`, `sysparm_limit`, `sysparm_view`) | Catalogs visible to the caller: `{sys_id, title, description, desktop_image, has_categories, has_items}[]` | 200 |
| SC-02 | GET /catalogs/{sys_id} | One catalog plus `categories[{sys_id, title, description, header_image}]` | 200 |
| SC-03 | GET /catalogs/{sys_id}/categories (`sysparm_top_level_only`, limit, offset, view) | Categories: `{sys_id, title, description, full_description, icon, header_icon, homepage_image, count, subcategories[{sys_id,title}]}[]` | 200 |
| SC-04 | GET /categories/{sys_id} | Category plus `child_categories[{sys_id, title, count, parent, isParentCategory, subcategories}]` | 200 |
| SC-05 | GET /items (`sysparm_catalog`, `sysparm_category`, `sysparm_text`, `sysparm_type` = `Record Producer` or `Order Guide`, limit, offset, view) | Item search: ItemSummary[] | 200 |
| SC-06 | GET /items/{sys_id} | ItemDetail (variables, ui_policy, client_script, data_lookup) | 200 |
| SC-07 | GET /items/{item_sys_id}/delegation/{user_sys_id} | Can the item be requested for this user: `{"result":{"result":true}}` (nested) | 200 |
| SC-08 | POST /items/{item_sys_id}/get_invalid_delegated_users (`sysparm_also_request_for`) | `{"invalidUsers":[display names]}`; failure object `{errCode:"42202", errMsg}` when the item has no Requested For | 200 / 400 |
| SC-09 | POST /items/{sys_id}/add_to_cart | Add a line; returns `{cart_id, subtotal, items[]}` (all lines, compact) | 200 |
| SC-10 | POST /items/{sys_id}/order_now | Order immediately via a temporary cart: `{sys_id, number, request_number, request_id, table:"sc_request", parent_id?, parent_table?}` | 200 |
| SC-11 | POST /items/{sys_id}/add_to_wishlist | Wish-list line; returns `{cart_id, items[]}` | 200 |
| SC-12 | POST /items/{sys_id}/submit_producer (`variables`; query `sysparm_view`) | Run a record producer: `{sys_id, number, table, record:"api/now/table/<table>/<id>", redirect_url, redirect_portal_url, redirect_to, parent_id, parent_table}` | 200 (404 unknown) |
| SC-13 | PUT /items/{sys_id}/submit_guide (`variables`) | Evaluate an order guide; returns the resolved items (ItemDetail-like with `quantity`, `order` as string) | 200 |
| SC-14 | POST /items/{sys_id}/checkout_guide (`items[{sys_id, sysparm_quantity, variables}]`) | Guide not two-step (three-step, default): lines go to the default cart, CartSummary returned. Guide two-step: request created through a temporary cart, `{request_number, request_id, parent_id?, parent_table?}` | 200 |
| SC-15 | POST /variables/{sys_id}/display_value (`sysparm_value`) | Display value for a reference answer; result is a bare string | 200 (404) |
| SC-16 | GET /cart | CartSummary | 200 |
| SC-17 | PUT /cart/{cart_item_id} (`sysparm_quantity` string, `variables`) | Update a line; returns CartSummary | **201** |
| SC-18 | DELETE /cart/{cart_item_id} | Remove a line | 204 |
| SC-19 | DELETE /cart/{sys_id}/empty | Empty a cart (admin, catalog_admin; others only their own cart) | 204 |
| SC-20 | GET /cart/delivery_address/{user_id} | Multi-line address string of the user | 200 |
| SC-21 | POST /cart/checkout | One-step: places the order, returns `{request_number, request_id}`. Two-step: places nothing, returns CartSummary plus `delivery_address`, `special_instructions`, `requested_for`, `requested_for_user` | 200 (400 empty cart) |
| SC-22 | POST /cart/submit_order | Places the order: `{request_number, request_id, parent_id?, parent_table?}` | 200 (400 empty cart) |
| SC-23 | GET /wishlist | `{cart_id, items: CartItem[]}` (not grouped by frequency) | 200 |
| SC-24 | GET /wishlist/{cart_item_id} | One wish-list line | 200 (404) |

### 14.3 Payload shapes

- **ItemSummary**: `sys_id, name, short_description, description (HTML), icon, picture, url, content_type, kb_article, order, type (catalog_item, record_producer, order_guide, content_item), sys_class_name, show_price, show_quantity, catalogs[{sys_id,title}], category{sys_id,title}`; when `show_price` is true also `price, localized_price, price_currency, local_currency, recurring_price, localized_recurring_price, recurring_price_currency, recurring_frequency` (label such as "Monthly", or null). `order_guide` / `content_item` type strings are **[Inferred]**.
- **ItemDetail**: ItemSummary plus `categories[{sys_id, title, active, category{sys_id,title,active}}]`, `variables[]`, `ui_policy[]`, `client_script{onChange[], onLoad[], onSubmit[]}`, `data_lookup[]`. ResolvrNow also adds `mandatory_attachment`, `request_method`, `no_cart`, `no_quantity` **[Inferred]** (additive).
- **Variable**: `id, name, label, type (number), friendly_type, display_type, mandatory, read_only, render_label, value, displayvalue, help_text, max_length, attributes, pricing_implications, children[] (containers)`. The documented sample emits container nodes with `type: 0` and `friendly_type: container_start`; ResolvrNow mirrors that in the API while storing 19 **[Documented]** sample, **[Inferred]** storage. ResolvrNow adds `choices[{value, label, price, recurring_price}]` for choice types and `reference` for reference types **[Inferred]**.
- **CartItem**: `cart_item_id (= sys_id), catalog_item_id (= item_id), item_name (= name), short_description, sys_class_name, picture, order_guide, delivery_time ("2 Days"), quantity, price, localized_price, recurring_price, localized_recurring_price, recurring_frequency, subtotal, subtotal_price, recurring_subtotal, recurring_subtotal_price, show_price, show_quantity, show_recurring_price, created_by, created_on, updated_by, updated_on, variables{label: value}`. Compact form (SC-09/11/14/24) keeps the id, name, quantity and price fields (plus `delivery_time` and `variables` on SC-11/14/24).
- **CartSummary**: `cart_id, subtotal_price, subtotal_recurring_frequency, subtotal_recurring_price, subtotal_title ("Subtotal"), total_title ("Total"), show_subtotal_price`, and one block per recurring frequency key (`none`, `daily`, `monthly`, `yearly`, ...) shaped `{frequency_label, items: CartItem[], show_subtotal_price, subtotal_price, subtotal_recurring_frequency, subtotal_recurring_price, subtotal_title, total_title}`. GET /cart has no top-level `items[]`.

### 14.4 Behaviour rules

| Rule | Detail |
|---|---|
| Quantity | `sysparm_quantity` required on add_to_cart and order_now, must be a non-negative number; else 400 `Invalid quantity value` and nothing is ordered |
| Access | Unknown item or no access: 400 `Security constraints prevent ordering of Item` |
| Mandatory variables | Missing mandatory answers: 400 `Mandatory Variables are required` (submit_guide checks only variables flagged mandatory) |
| Requested for | `sysparm_requested_for` honoured when the caller holds a role in `glide.sc.req_for.roles`; if that list is empty, `glide.sc.req_for.roles.default` = `allow` lets anyone, `deny` lets no one |
| Also request for | `sysparm_also_request_for`: up to 50 comma-separated user sys_ids; all-or-nothing (any unentitled user, no Requested For variable, feature not enabled, or caller lacking the role rejects the whole call). Each user gets its own RITM under one REQ |
| Checkout mode | Controlled by `glide.sc.checkout.twostep` (property name not given by the API page) **[Inferred]**: SC-21 then SC-22 in two-step, SC-21 alone in one-step; SC-22 always submits **[Inferred]** |
| checkout_guide | The documented "two-step" switch is read as the guide's own `sc_cat_item_guide.two_step` flag, not the cart property: a three-step guide (default) fills the default cart and returns CartSummary; a two-step guide submits at once and returns the request. This matches the architecture page (two-step guide uses a temporary cart, three-step uses the default cart) **[Inferred]** reconciliation; it removes the apparent reversal versus SC-21 noted in `rest-api.md` section 10.3 |
| Delivery details | No endpoint sets delivery address, special instructions or requested for at checkout; ResolvrNow accepts optional `delivery_address`, `special_instructions`, `requested_for` in the SC-22 body **[Inferred]** (additive) |
| Producer response | `record` is a Table API relative path; `redirect_url` is `<table>.do?sys_id=<id>&sysparm_view=ess` |

### 14.5 Examples (illustrative, ResolvrNow-authored)

```http
POST /api/sn_sc/servicecatalog/items/6c3a.../add_to_cart
{"sysparm_quantity": 1, "variables": {"color": "black", "requested_for": "62826bf0..."}}

200 {"result":{"cart_id":"9f1e...","subtotal":"$50.00","items":[{"cart_item_id":"aa01...",
     "catalog_item_id":"6c3a...","item_name":"Wireless Mouse","quantity":"1","price":"$50.00",
     "localized_price":"$50.00","recurring_price":"$0.00","localized_recurring_price":"$0.00",
     "recurring_frequency":""}]}}

POST /api/sn_sc/servicecatalog/items/0d6f.../submit_producer
{"variables": {"urgency": "2", "short_description": "VPN drops every hour"}}

200 {"result":{"sys_id":"b71c...","number":"INC0010042","table":"incident",
     "record":"api/now/table/incident/b71c...","redirect_url":"incident.do?sys_id=b71c...&sysparm_view=ess",
     "redirect_portal_url":"","redirect_to":"","parent_id":null,"parent_table":"task"}}

POST /api/sn_sc/servicecatalog/cart/submit_order
200 {"result":{"request_number":"REQ0010007","request_id":"1e2d..."}}
```

## 15. Acceptance tests

Fixtures: catalog "Service Catalog"; category Hardware; item `Laptop` (price 1000, `group` = Hardware Fulfilment, variables: `ram` select box with choices 8GB (+0) and 16GB (+200), `justification` mandatory multi line text, `requested_for` type 31); users `alice` (no role, manager `mike`), `bob` (itil, member of Hardware Fulfilment), `carol` (catalog_admin); default flow `sc_item_default` with `u_manager_approval` true on Laptop.

| # | Given | When | Then |
|---|---|---|---|
| 1 | Laptop with mandatory `justification` | alice POSTs add_to_cart with quantity 1 and no variables | 400 with message `Mandatory Variables are required`; cart unchanged |
| 2 | Laptop | alice adds it to the cart with `ram=16GB` | cart line price is `$1,200.00`; GET /cart shows it inside the `none` frequency block and no top-level `items` |
| 3 | A cart line of quantity 2 at 1200 | alice GETs /cart | line `subtotal` is 2400 (number) and `subtotal_price` is `$2,400.00` |
| 4 | One-step checkout (default) and a cart with 2 different items | alice POSTs /cart/checkout | one `sc_request` (REQ prefix) and two `sc_req_item` rows (RITM prefix) exist, both referencing the request; the default cart is empty |
| 5 | `glide.sc.checkout.twostep = true` | alice POSTs /cart/checkout | no request is created; response contains `delivery_address`, `special_instructions`, `requested_for`; a following POST /cart/submit_order creates the request |
| 6 | Laptop in the default cart | alice POSTs order_now for another item | a request exists for the other item only; the Laptop line is still in the default cart |
| 7 | Empty cart | alice POSTs /cart/submit_order | 400; no request created |
| 8 | Checkout completed | inspect `sc_item_option_mtom` | every answer row is linked to the new RITM and none to a cart line |
| 9 | New RITM for Laptop | flow `sc_item_default` starts | RITM stage `waiting_for_approval`, approval `requested`, one `sysapproval_approver` for `mike` in state `requested` |
| 10 | Pending approval from mike | mike approves | RITM approval `approved`, stage `fulfillment`, state 2; one `sc_task` (SCTASK prefix) assigned to Hardware Fulfilment with `request` and `cat_item` copied from the RITM |
| 11 | Pending approval from mike | mike rejects | RITM approval `rejected`, stage `Request Cancelled`, state 4, inactive; no catalog task is created |
| 12 | RITM with two tasks | both tasks close as Closed Complete (3) | RITM state 3, stage `complete`, inactive; when it is the only RITM, the request gets state 3 and request_state `closed_complete` |
| 13 | RITM with two tasks | one closes 3 and one closes 4 | RITM state 4 (Closed Incomplete) and the request becomes `closed_incomplete` |
| 14 | RITM with two tasks | both close as Closed Skipped (7) | RITM state 7 |
| 15 | Request with RITMs complete and incomplete | last RITM closes | request_state `closed_incomplete` |
| 16 | Request with request_state `in_process` | carol tries to add a new item to it | rejected: adding items is allowed only while request_state is `requested` |
| 17 | Record producer "Report outage" on `incident` with variables `short_description` and `urgency` | alice submits it with values | an incident exists with those field values; one `sc_item_produced_record` row; `question_answer` rows for both variables; no `sc_request` was created |
| 18 | Record producer whose script sets `current.impact = 1` and a template setting impact 3 | alice submits | incident impact is 1 (script runs after template) |
| 19 | Record producer whose `post_insert_script` updates `short_description` | alice submits | stored short_description equals the post-insert value |
| 20 | Record producer configured with `table_name = sc_req_item` | carol saves it | save rejected with a validation error |
| 21 | Order guide "New Hire" with rules: always Laptop; Phone only when `role=sales`; cascade on; guide variable `requested_for` | submit_guide with `role=engineer` | result lists Laptop only; with `role=sales` it lists Laptop and Phone |
| 22 | Same guide with `two_step = false` | checkout_guide with both items | lines are added to the default cart (CartSummary returned) and each line carries `order_guide`; with `two_step = true` the call returns `request_number` and the cart is untouched |
| 23 | Guide with cascade on and guide variable `location` | items ordered | each RITM's `location` variable equals the guide answer |
| 24 | Item Laptop has a Not Available For criterion matching department Sales and an Available For matching everyone | a Sales user GETs /items/{Laptop} | 400 (no access); item absent from GET /items |
| 25 | Category with Not Available For a user | that user opens an item inside it that has no criteria | item is still visible (category criteria do not cascade) |
| 26 | `glide.sc.req_for.roles` empty and `glide.sc.req_for.roles.default = deny` | alice orders with `sysparm_requested_for` = bob | 400; no request |
| 27 | Laptop Requested For variable has "also request for" enabled | caller sends 51 user ids in `sysparm_also_request_for` | 400; nothing added |
| 28 | Laptop with also request for and roles allowed | caller orders for 3 users | one REQ and 3 RITMs, each RITM `requested_for` set to its user |
| 29 | Item `Laptop B` where `justification` is optional, plus a catalog UI policy (reverse if false) making it mandatory when `ram=16GB` | API order with `ram=8GB` and no justification, then another with `ram=16GB` and no justification | first succeeds; second returns 400 `Mandatory Variables are required` (server re-evaluates UI policies) |
| 30 | MRVS with `max_rows=2` | submission with 3 rows | 400; with 2 rows succeeds and `sc_multi_row_question_answer` holds 2 x (variables) rows |
| 31 | Masked variable with `use_encryption` | RITM read by bob (itil without `catalog_view_masked`) | value is returned masked; alice (requester) sees her own value |
| 32 | Content item of type KB Article | GET /items/{id} | `type` reflects a content item, no `variables`, and add_to_cart returns 400 |
| 33 | `glide.sc.req_for.roles.default = allow`; alice orders Laptop with Requested For = bob | checkout completes | event `sc_request.requested_for` is queued and the "Request Opened on Behalf" notification targets bob |
| 34 | sc_task assigned to bob | assignment saved | event `sc_task.assigned.to.user` fires once |
| 35 | Laptop approved RITM with quantity 1 and `glide.sc.restrict.quantity.changes` true | bob changes quantity to 2 | update rejected; carol (catalog_admin) can change it |
| 36 | Item `delivery_time` = 2 days, no plan | RITM opened at 2026-01-05 10:00 | `estimated_delivery` = 2026-01-07 10:00 and request `due_date` equals the latest RITM estimate |
| 37 | Item with check box `warranty` priced +50 | API order with `warranty=true` quantity 2 | RITM price 1050 per unit (Laptop 1000 + 50) and request price 2100 |
| 38 | Versioned path | GET /api/sn_sc/v1/servicecatalog/catalogs | same body as the unversioned path |
