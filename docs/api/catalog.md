# Service Catalog API

Catalogs, items, variables, carts, requests and fulfillment. ResolvrNow serves two API families:

- the **Service Catalog REST API** under `/api/sn_sc/servicecatalog` (platform compatible), and
- **portal APIs** under `/api/app/catalog` (product APIs shaped for the employee portal: forms ready to
  render, ordering, My Requests and ticket pages).

Implementation: `server/src/modules/catalog/`. Behaviour comes from `docs/spec/service-catalog.md`
(primary), `docs/spec/rest-api.md` section 10 and `docs/spec/portal-and-virtual-agent.md` sections 2 to 5.

## Conventions

| Topic | Rule |
|---|---|
| Authentication | HTTP Basic, bearer API token or session cookie (writes with a session need the `X-UserToken` CSRF header). Anonymous calls get `401`. |
| Envelope | Success: `{ "result": ... }`. Errors: `{ "error": { "message", "detail" }, "status": "failure" }` |
| Identity | Every call runs as the caller. Carts, wish lists and orders always belong to the caller. |
| Item access | Items must be active, in an active catalog and allowed by user criteria (Available For / Not Available For; "not available" wins; no Available For means everyone). Category criteria do not cascade to items. Checkout repeats the check. |
| Dates | UTC strings `YYYY-MM-DD HH:MM:SS`. |
| Money | Service Catalog API: display strings such as `"$1,598.00"` plus currency codes (`resolvr.currency`, default `USD`). Portal APIs add plain numbers (`price`, `price_value`). |
| Variables in requests | Keyed by variable **name** (also accepted: variable sys_id or `IO:<sys_id>`). Values are strings; booleans, numbers and arrays are converted. Multi-row variable sets take a JSON array of row objects under the set's internal name. |

## Data model

Platform tables (names and fields compatible with the platform): `sc_catalog`, `sc_category`,
`sc_cat_item` with the classes `sc_cat_item_producer` (record producer), `sc_cat_item_guide` (order
guide) and `sc_cat_item_content` (content item), `item_option_new` (variables), `question_choice`,
`item_option_new_set` (variable sets) with `io_set_item`, `catalog_ui_policy` and
`catalog_ui_policy_action`, `catalog_script_client`, `user_criteria` with the item and category
links (`sc_cat_item_user_criteria_mtom`, `..._no_mtom`, `sc_category_user_criteria_mtom`,
`..._no_mtom`), `sc_cat_item_category`, `sc_cat_item_catalog`, `sc_cat_item_app_user` and
`sc_cat_item_app_group` (Approved by), `sc_cat_item_guide_items` (order guide rules), `sc_cart`,
`sc_cart_item`, `sc_item_option` with `sc_item_option_mtom` (answers of cart lines and requested
items), `question_answer` (answers stored on records made by producers), `sc_multi_row_question_answer`,
`sc_item_produced_record`, `sc_cat_item_delivery_plan` and `sc_cat_item_delivery_task`.

Task tables (stored in `task`): `sc_request` (`REQ0010001`...), `sc_req_item` (`RITM0010001`...),
`sc_task` (`SCTASK0010001`...).

ResolvrNow additions:

| Table / column | Purpose |
|---|---|
| `resolvr_cat_item_fulfillment_step` | Built-in fulfillment: `cat_item`, `order`, `name`, `short_description` and `description` templates, `assignment_group`, `assigned_to`, `stage` (`fulfillment` or `delivery`), `priority`, `condition` (encoded query over variable names), `include_variables`, `active` |
| `resolvr_software_title` | Software list referenced by catalog variables: `name`, `publisher`, `version`, `category`, `license_type`, `price`, `recurring_price`, `approval_required`, `active` |
| `sc_cat_item.flow` | Internal name or sys_id of a flow that fulfils the item instead of the built-in steps (`flow_designer_flow` is honoured too) |
| `sc_cat_item.u_manager_approval` | The requested-for user's manager must approve |
| `sc_cat_item.ur_enabled`, `ur_requires_review` | Universal request flags (used by the portal module) |
| `sc_cat_item_producer.resolvr_template` | Encoded assignments applied to the generated record, for example `contact_type=self-service^impact=3` |
| `sc_req_item.resolvr_step_order` | Order of the step group currently being worked (internal) |
| `sc_task.resolvr_fulfillment_step` | Step that created the task |

Variable type codes (`item_option_new.type`): 1 Yes/No, 2 Multi Line Text, 3 Multiple Choice,
4 Numeric Scale, 5 Select Box, 6 Single Line Text, 7 CheckBox, 8 Reference, 9 Date, 10 Date/Time,
11 Label, 12 Break, 14 Custom, 15 UI Page, 16 Wide Single Line Text, 17 Custom with Label,
18 Lookup Select Box, 19 Container Start, 20 Container End, 21 List Collector, 22 Lookup Multiple
Choice, 23 HTML, 24 Container Split, 25 Masked, 26 Email, 27 URL, 28 IP Address, 29 Duration,
31 Requested For, 32 Rich Text Label, 33 Attachment.

## Request lifecycle

```
checkout --> REQ requested --(request approval, optional)--> REQ in_process
               RITM waiting_for_approval
                 +- item approval (manager and/or Approved by users and groups)
                 |    approved --> RITM fulfillment, state 2, first step group's catalog tasks
                 |    rejected --> RITM "Request Cancelled", state 4, approval rejected
                 +- tasks of a group all closed --> next group (stage delivery when the step says so)
                 +- last group closed --> RITM complete, state 3 / 4 / 7 (roll-up)
               REQ closes when every RITM is closed: closed_complete / closed_incomplete /
               closed_skipped, or closed_cancelled / closed_rejected when every item was
               cancelled / rejected
```

| Rule | Behaviour |
|---|---|
| Start | An async rule on `sc_request` insert starts the request after the order commits (`p.drain()` in tests). Items added later to an approved request start on their own. |
| Request approval | When `resolvr.sc.request_approval_threshold` is 0 or more and the request price exceeds it, the requested-for user's manager approves the request first; otherwise the request is approved automatically (`request_state = in_process`). |
| Item approval | Approvers are the `sc_cat_item_app_user` users, the members of each `sc_cat_item_app_group` group (each group decides on the first response) and the requested-for user's manager when `u_manager_approval` is set. The users approve under the "anyone" rule; every group and the user list must approve. With no approver, or without the approvals application, the item is approved automatically (a work note says so). |
| Flow | When the item references a flow and the flows service is installed, the flow starts instead of the built-in steps and owns approvals, tasks and closure (`flow_context` is set). |
| Steps | Fulfillment steps run by ascending `order`; steps sharing an order run in parallel; a step whose `condition` does not match the answers is skipped. Without steps (and without an execution plan) one task is created for the item's fulfillment group. `fulfillment_automation_level = fully_automated` with no steps closes the item at once. |
| Templates | `${name}` in a step's short description or description inserts the display value of the answer named `name`; other names are read from the requested item (`${requested_for}`, `${number}`, `${requested_for.location}`). Tasks also list the answers ("Request details") unless `include_variables` is false. |
| Roll-up | Any task Closed Incomplete closes the item Closed Incomplete (remaining groups are not created); all Closed Skipped gives Closed Skipped; anything else Closed Complete. The same rules roll items up to the request. |
| Cancellation | Requesters (opened by or requested for) and fulfillers may cancel while every item is waiting for approval: pending approvals are cancelled, open tasks are closed skipped, items get stage "Request Cancelled" and the request closes as `closed_cancelled`. |
| Quantity | After approval only catalog admins can change a requested item's quantity (`glide.sc.restrict.quantity.changes`). |
| Delivery | `estimated_delivery = opened_at + item delivery time` (or the execution plan total); the request `due_date` is the latest estimate. |
| Events | `sc_request.requested_for` (one per person ordered for), `sc_request.approved`, `sc_request.assigned`, `sc_request.updated`, `sc_req_item.assigned`, `sc_req_item.delivery`, `sc_req_item.commented`, `sc_task.assigned.to.user`, `sc_task.assigned.to.group`. |

## Validation

Answers are checked on add to cart, order, checkout (mandatory answers only) and producer submit:
mandatory variables after the catalog UI policies are re-evaluated on the server, choice values,
numeric scale bounds, date and date/time formats, email, URL, IP address, duration
(`DD HH:MM:SS`), `max_length` attribute and `validate_regex` for text, reference and list collector
values against the referenced table and its reference qualifier (simple, dynamic or advanced),
lookup values, `selection_required` check boxes, multi-row set `max_rows` (hard maximum 50) and the
right to order for someone else (`glide.sc.req_for.roles`, `glide.sc.req_for.roles.default`).

Masked answers (type 25 with `use_encryption`) are stored encrypted (AES-256-GCM, key from
`RESOLVRNOW_ENCRYPTION_KEY` or the generated `resolvr.sc.masked_key` property) and shown as
`********` except to the requester and holders of `catalog_view_masked`.

## Service Catalog API

Base path `/api/sn_sc/servicecatalog`; the versioned forms `/api/sn_sc/v1/servicecatalog` and
`/api/sn_sc/v2/servicecatalog` return the same bodies. JSON only (`Accept` asking only for XML gets
`406`).

| Method and path | Purpose | Success |
|---|---|---|
| `GET /catalogs` (`sysparm_text`, `sysparm_limit`) | `[{ sys_id, title, description, desktop_image, has_categories, has_items }]` | 200 |
| `GET /catalogs/{id}` | Catalog plus top-level `categories[{ sys_id, title, description, header_image }]` | 200 (400 unknown) |
| `GET /catalogs/{id}/categories` (`sysparm_top_level_only`, `sysparm_limit`, `sysparm_offset`) | `[{ sys_id, title, description, full_description, icon, header_icon, homepage_image, count, subcategories[] }]` | 200 |
| `GET /categories/{id}` | Category plus `catalog`, `parent`, `child_categories[{ sys_id, title, count, parent, isParentCategory, subcategories }]` | 200 (400) |
| `GET /items` (`sysparm_catalog`, `sysparm_category`, `sysparm_text`, `sysparm_type` = `Record Producer` or `Order Guide`, `sysparm_limit`, `sysparm_offset`, `sysparm_view`) | ItemSummary list, sorted by order then name | 200 |
| `GET /items/{id}` | ItemDetail | 200 (400 unknown or not visible) |
| `GET /items/{id}/delegation/{user}` | `{ "result": { "result": true } }` when the item can be ordered for that user | 200 |
| `POST /items/{id}/get_invalid_delegated_users` (`sysparm_also_request_for`) | `{ invalidUsers: [names] }`; `400` with `{ errCode: "42202", errMsg }` when the item has no Requested For variable | 200 |
| `POST /items/{id}/add_to_cart` (`sysparm_quantity` required, `variables`, `sysparm_requested_for`, `sysparm_also_request_for`) | `{ cart_id, subtotal, items[] }` (compact lines) | 200 |
| `POST /items/{id}/order_now` (same body, plus optional `sysparm_parent_sys_id` / `sysparm_parent_table`) | `{ sys_id, number, request_number, request_id, table: "sc_request" }` | 200 |
| `POST /items/{id}/add_to_wishlist` | `{ cart_id, items[] }` | 200 |
| `POST /items/{id}/submit_producer` (`variables`) | `{ sys_id, number, table, record, redirect_url, redirect_portal_url, redirect_to, parent_id, parent_table }` | 200 (404 unknown) |
| `PUT /items/{id}/submit_guide` (`variables`) | Selected items: ItemDetail with cascaded values plus `quantity` and `order` (strings) | 200 |
| `POST /items/{id}/checkout_guide` (`items[{ sys_id, sysparm_quantity, variables }]`, optional guide `variables`) | Two-step guide: `{ request_number, request_id }`. Otherwise the lines go to the default cart and the CartSummary is returned | 200 |
| `POST /variables/{id}/display_value` (`sysparm_value`) | Bare string display value of a referenced record | 200 (404) |
| `GET /cart` | CartSummary | 200 |
| `PUT /cart/{cart_item_id}` (`sysparm_quantity` required, `variables`) | CartSummary | **201** |
| `DELETE /cart/{cart_item_id}` | Removes the line | 204 |
| `DELETE /cart/{cart_id}/empty` | Empties and deletes a cart (own cart; admin or catalog_admin for others) | 204 |
| `GET /cart/delivery_address/{user}` | Multi-line address of the user's location (bare string) | 200 |
| `POST /cart/checkout` | One-step (default): places the order, `{ request_number, request_id }`. Two-step (`glide.sc.checkout.twostep`): CartSummary plus `delivery_address`, `special_instructions`, `requested_for`, `requested_for_user` | 200 (400 empty cart) |
| `POST /cart/submit_order` (optional `requested_for`, `delivery_address`, `special_instructions`) | Places the order: `{ request_number, request_id }` | 200 (400 empty cart) |
| `GET /wishlist`, `GET /wishlist/{cart_item_id}` | Wish list lines | 200 (404) |

Error messages clients can match: `Invalid quantity value`, `Security constraints prevent ordering of
Item` (unknown item, no access, ordering for someone not allowed), `Mandatory Variables are
required`, `Invalid variable value` (detail lists the problems), `Cart is empty`. Unknown or
invisible single records answer `400`, except `submit_producer`, `display_value` and
`wishlist/{id}` (`404`).

Shapes:

- **ItemSummary**: `sys_id, name, short_description, description, icon, picture, url, content_type,
  kb_article, order, type (catalog_item, record_producer, order_guide, content_item), sys_class_name,
  show_price, show_quantity, catalogs[{ sys_id, title }], category{ sys_id, title }` and, when
  `show_price`, `price, localized_price, price_currency, local_currency, recurring_price,
  localized_recurring_price, recurring_price_currency, recurring_frequency`.
- **ItemDetail**: ItemSummary plus `categories[]`, `variables[]`, `ui_policy[]`,
  `client_script{ onChange, onLoad, onSubmit }`, `data_lookup[]`, `mandatory_attachment`,
  `request_method`, `no_cart`, `no_quantity`, `no_order_now`, `delivery_time`.
- **Variable**: `id, name, label, type (code), friendly_type, display_type, mandatory, read_only,
  visible, render_label, value, displayvalue, help_text, tooltip, example_text, instructions,
  max_length, attributes, pricing_implications, order`, plus `choices[{ value, label, price,
  recurring_price }]` for choice types, `reference` and `reference_qualifier` for reference types and
  `variable_set` for set members. Containers are nodes with `type: 0`, `friendly_type:
  "container_start"` and `children[]`; multi-row sets are nodes with `friendly_type:
  "multi_row_variable_set"`, `max_rows` and `children[]`.
- **CartItem**: `cart_item_id, catalog_item_id, item_name, short_description, sys_class_name, picture,
  order_guide, delivery_time, quantity (string), price, localized_price, recurring_price,
  localized_recurring_price, recurring_frequency, subtotal (number), subtotal_price,
  recurring_subtotal (number), recurring_subtotal_price, show_price, show_quantity,
  show_recurring_price, requested_for, created_by, created_on, updated_by, updated_on,
  variables{ label: display value }`.
- **CartSummary**: `cart_id, subtotal_price, subtotal_recurring_frequency, subtotal_recurring_price,
  subtotal_title, total_title, show_subtotal_price ("true"/"false")` and one block per recurring
  frequency key (`none`, `monthly`, ...) holding `frequency_label, items[CartItem]` and the same
  subtotal fields. There is no top-level `items`.

```http
POST /api/sn_sc/servicecatalog/items/7a1c.../add_to_cart
{"sysparm_quantity": 1, "variables": {"ram": "16GB", "justification": "Old one is broken"}}

200 {"result":{"cart_id":"52e0...","subtotal":"$1,200.00","items":[{"cart_item_id":"0c9d...",
     "catalog_item_id":"7a1c...","item_name":"Laptop","quantity":"1","price":"$1,200.00",
     "localized_price":"$1,200.00","recurring_price":"$0.00","localized_recurring_price":"$0.00",
     "recurring_frequency":""}]}}
```

## Portal APIs

Base path `/api/app/catalog`. Validation errors on these endpoints carry the failing variables:

```json
{ "error": { "message": "Mandatory Variables are required", "detail": "Missing: Justification",
  "fields": [{ "variable": "justification", "label": "Justification", "code": "mandatory",
               "message": "Justification is required" }] }, "status": "failure" }
```

### `GET /catalogs`

Active catalogs with their visible category tree and the number of visible items per category.

```json
{ "result": [{ "sys_id": "0bde...", "title": "IT Service Catalog", "description": "...", "image": "",
  "categories": [{ "sys_id": "707c...", "title": "Hardware", "description": "...", "icon": "laptop",
                   "count": 5, "children": [] }] }] }
```

### `GET /items?catalog=&category=&q=&type=&limit=&offset=`

Visible items (portal rules: `hide_sp` and `no_search` items are left out) as ItemSummary objects,
plus `total`. `type` takes `catalog_item`, `record_producer`, `order_guide` or `content_item`.

### `GET /items/:id/form`

Everything needed to render an item page. `404` when the item is unknown or not visible.

```json
{ "result": {
  "item": { "sys_id": "ae28...", "name": "External Monitor", "type": "catalog_item", "...": "ItemSummary fields",
            "request_method": "order", "submit_label": "Order Now", "confirm": true,
            "price_value": 249, "recurring_price_value": 0, "recurring_frequency_label": "", "currency": "USD",
            "show_price": true, "show_quantity": true, "quantity_choices": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            "delivery_time": "3 Days", "no_cart": false, "no_order_now": false,
            "mandatory_attachment": false, "hide_attachment": false, "access_type": "restricted",
            "approvals": { "manager": false, "users": [], "groups": [] },
            "fulfillment_steps": [{ "name": "Deliver monitor", "order": 100, "stage": "fulfillment" }] },
  "variables": [{
    "sys_id": "8d4b...", "id": "8d4b...", "name": "requested_for", "label": "Requested for",
    "type": 31, "friendly_type": "requested_for", "ui_type": "reference", "display_type": "Requested For",
    "mandatory": true, "read_only": false, "visible": true, "render_label": true, "wide": false,
    "default_value": "6b2b...", "value": "6b2b...", "displayvalue": "James Davis",
    "help_text": "", "show_help": false, "tooltip": "", "example_text": "", "instructions": "",
    "reference": "sys_user", "reference_qualifier": "active=true", "enable_also_request_for": true,
    "variable_set": { "sys_id": "aa81...", "internal_name": "requester_details" }, "order": 100 },
    { "name": "size", "type": 5, "ui_type": "select", "mandatory": true, "default_value": "24",
      "choices": [{ "value": "24", "label": "24-inch Full HD", "price": 0, "recurring_price": 0 },
                  { "value": "27", "label": "27-inch QHD", "price": 110, "recurring_price": 0 }] }],
  "variable_sets": [{ "sys_id": "aa81...", "title": "Requester details", "internal_name": "requester_details",
                      "type": "one_to_one", "variables": ["requested_for", "contact_phone"] }],
  "ui_policies": [{ "sys_id": "58a4...", "short_description": "Explain why a 4K monitor is needed",
                    "condition": "size=32_4k", "reverse_if_false": true, "on_load": true, "order": 100,
                    "applies_to": "item", "actions": [{ "name": "usage", "mandatory": "true", "visible": "true",
                    "disabled": "ignore", "value_action": "ignore", "value": "",
                    "field_message_type": "none", "field_message": "" }] }],
  "client_scripts": { "onChange": [], "onLoad": [], "onSubmit": [] },
  "requested_for": { "variable": "requested_for", "value": { "sys_id": "6b2b...", "name": "James Davis" },
                     "can_change": true, "also_request_for": true },
  "values": { "requested_for": "6b2b...", "contact_phone": "", "size": "24", "usage": "" } } }
```

`variables` is the flat list in display order (item variables and single-row set members; layout
types such as `label`, `break`, `container_start`, `container_split` and `container_end` are
included as markers). Multi-row sets are listed in `variable_sets` with `type: "one_to_many"`,
`max_rows` and their column variables. `ui_type` is one of `yes_no`, `textarea`, `radio`, `scale`,
`select`, `text`, `checkbox`, `reference`, `multi_reference`, `checkbox_group`, `date`, `datetime`,
`html`, `password`, `email`, `url`, `ip_address`, `duration`, `attachment`, `label`,
`rich_text_label`, `break`, `container_start`, `container_split`, `container_end`, `unsupported`.
Policy conditions are encoded queries over variable names; evaluate them in the browser for live
behaviour (the server re-evaluates them on submit).

### `POST /items/:id/order`

Body `{ "variables": {...}, "quantity": 1, "requested_for": "<user>", "also_request_for": ["<user>"],
"delivery_address": "...", "special_instructions": "...", "requested_date": "2026-11-02",
"attachments": ["<sys_attachment id>"] }` (all optional except mandatory variables). Attachments
uploaded by the caller are moved to the first requested item. Orders through a temporary cart (the
default cart is untouched).

```json
{ "result": {
  "request": { "table": "sc_request", "sys_id": "f31e...", "number": "REQ0010023",
               "request_state": { "value": "requested", "display": "Pending Approval" },
               "price": 1200, "price_display": "$1,200.00",
               "requested_for": { "sys_id": "6b2b...", "name": "James Davis" } },
  "request_items": [{ "table": "sc_req_item", "sys_id": "a5ee...", "number": "RITM0010026",
                      "title": "Laptop", "quantity": 1, "price": 1200, "price_display": "$1,200.00",
                      "stage": { "value": "waiting_for_approval", "display": "Waiting for Approval" },
                      "state": { "value": "1", "display": "Open" }, "badge": "Submitted", "...": "..." }] } }
```

For a record producer the same endpoint returns `{ "request": null, "request_items": [], "record":
{ table, sys_id, number, display_value, short_description, state, link } }`. Order guides use the
guide endpoints below; content items answer `400`.

### `POST /producers/:id/submit`

Body `{ "variables": {...}, "attachments": [...] }`. Runs the record producer and returns
`{ "record": { "table": "incident", "sys_id": "...", "number": "INC0010042", "display_value": "...",
"short_description": "...", "state": "New", "link": { "table": "incident", "sys_id": "..." } } }`.

### `POST /guides/:id/evaluate`

Body `{ "variables": { guide answers } }`. Returns the guide summary, `include_toggle` and the items
the rules selected, each with `quantity`, `show_quantity`, `position` and a full `form` (as
`GET /items/:id/form`) whose `values` already hold the cascaded guide answers.

### `POST /guides/:id/order`

Body `{ "variables": { guide answers }, "items": [{ "sys_id", "quantity", "variables", "include" }],
"special_instructions": "..." }`. `items` defaults to every selected item; `include: false` leaves an
item out. Orders everything as one request (each requested item has `order_guide` set) and returns
the same payload as `POST /items/:id/order`.

### `GET /my-requests?filter=open|closed|all&q=&limit=&offset=`

The caller's requests (opened by or for them) with their items, plus the items someone else ordered
for them. `q` matches number prefixes and titles. Sorted by last update, newest first.

```json
{ "result": [{
    "table": "sc_request", "sys_id": "9437...", "number": "REQ0010019", "title": "Temporary Administrator Rights",
    "requested_for": { "sys_id": "6b2b...", "name": "James Davis" }, "opened_by": { "...": "..." },
    "request_state": { "value": "in_process", "display": "Approved" },
    "stage": { "value": "fulfillment", "display": "Fulfillment" },
    "state": { "value": "2", "display": "Work in Progress" },
    "approval": { "value": "approved", "display": "Approved" },
    "badge": "In Progress", "active": true, "price": 0, "price_display": "$0.00",
    "created": "2026-10-18 22:54:45", "updated": "2026-10-19 18:06:45", "closed_at": null,
    "due_date": "2026-10-19 22:54:45",
    "link": { "table": "sc_req_item", "sys_id": "a5ee..." },
    "items": [{ "table": "sc_req_item", "number": "RITM0010019", "badge": "In Progress", "timeline": ["..."], "...": "..." }],
    "timeline": [
      { "id": "submitted", "label": "Submitted", "status": "done", "at": "2026-10-18 22:54:45" },
      { "id": "approval", "label": "Awaiting Approval", "status": "done", "at": "2026-10-19 18:06:45", "detail": "Approved" },
      { "id": "fulfillment", "label": "Fulfillment", "status": "current", "at": "2026-10-19 18:06:45" },
      { "id": "closed", "label": "Closed", "status": "pending", "at": null }] }],
  "total": 3, "counts": { "open": 3, "closed": 0, "all": 3 } }
```

`link` is the ticket to open: the requested item when the request has a single item, else the
request. `badge` is the user-facing state: `Submitted`, `Awaiting Approval`, `In Progress`, `Closed`,
`Cancelled` or `Rejected`. Timeline step `status` is `done`, `current`, `pending`, `skipped` (no
approval was needed) or `cancelled`; a cancelled or rejected item ends with a `cancelled` step after
the last step it reached. The awaiting-approval step lists the pending `approvers` while current.

### `GET /tickets/:table/:id`

Ticket page for `sc_req_item` or `sc_request`. `404` when the record does not exist or the caller
cannot read it. A requested item returns the My Requests item entry plus `short_description`,
`description`, `assignment_group`, `assigned_to`, `variables[{ name, label, type, value,
display_value, order }]` (multi-row sets as `{ name, label, type: "multi_row_variable_set",
columns, rows }`; masked answers revealed only to the requester and `catalog_view_masked`),
`tasks[]` the caller may see, `approvals[{ approver, state, updated }]` and
`actions{ can_cancel, can_comment, can_approve }`. A request returns its entry with `items[]`,
`special_instructions`, `delivery_address`, `approvals` and `actions`.

### `POST /tickets/:table/:id/cancel`

Body `{ "reason": "..." }`. Cancels the item or the whole request while it is waiting for approval;
`400` once work has started. Returns the updated ticket.

### `POST /tickets/:table/:id/comment`

Body `{ "comment": "..." }`. Adds a customer-visible comment (`comments` journal) as the caller.

## Flow actions

When the flows service is installed the catalog registers these actions (inputs default to the
flow's trigger record, which may be the requested item or one of its catalog tasks):

| Action | Inputs | Outputs |
|---|---|---|
| `create_catalog_task` | `request_item`, `short_description`, `description`, `assignment_group`, `assigned_to`, `priority`, `include_variables` | `record`, `sys_id`, `number` |
| `set_ritm_stage` | `request_item`, `stage` (`fulfillment`, `delivery`, `complete`, `Request Cancelled`, ...), `state`, `approval`, `reason` | `record`. `complete` without `state` rolls the task states up |
| `get_catalog_variables` | `request_item` | `variables` (stored values), `display` |
| `run_catalog_fulfillment` | `request_item` | Hands the item back to the built-in fulfillment steps |

## Programmatic API (other modules)

`platform.services.get('catalog')` is a `CatalogService` (`server/src/modules/catalog/service.ts`):
`orderNow(ctx, item, input, opts)`, `addToCart`, `checkout`, `submitProducer`, `orderGuide`,
`cancel`, `myRequests`, `ticket`, `access(ctx, userId?)` (visibility checks), `form(ctx, item)` and
`onSubmitted(listener)`, which is called inside the order transaction with
`{ kind: 'request' | 'producer', ctx, item, request?, items?, record? }` (for example to create
universal requests).

## Roles and access

| Role | Access |
|---|---|
| `catalog_admin` | Manages every catalog, category, item, variable, variable set, user criteria and fulfillment step; contains `catalog`, `user_criteria_admin`, `catalog_lookup_admin` |
| `catalog_manager` | Edits and deletes catalogs where they are `manager`, with their categories, items and item records |
| `catalog_editor` | Edits catalogs where they are listed in `editors` and their content; cannot delete or change the manager |
| `itil`, `sn_request_write` | Read and work every request, requested item and catalog task |
| `sn_request_read` | Read every request, requested item and catalog task |
| `catalog_view_masked` | Sees masked answers |
| every internal user | Browses and orders items allowed by user criteria; reads requests and items they opened, are requested for or watch (lists are filtered by query rules); comments on them; reads and closes catalog tasks assigned to them; approvers read what they approve |

## Properties

`glide.sc.checkout.twostep`, `glide.sc.enable_order_now`, `glide.sc.use_user_criteria`,
`glide.sc.producer.redirect_url`, `glide.sc.item.not_normal_cart_item`,
`glide.sc.item.cannot_add_to_request`, `glide.sc.item.cannot_show_price`,
`glide.sc.item.order_guide_exclusion`, `glide.sc.allow.quantity`,
`glide.sc.restrict.quantity.changes`, `glide.sc.price.display` (`always`, `nonzero`, `never`),
`glide.sc.req_for.roles`, `glide.sc.req_for.roles.default`,
`glide.sc.remove_inactive_cat_items_from_cart`, `glide.sc.round.delivery.times`,
`glide.sc.ui_policy.variable_set_run_first`, `resolvr.currency`,
`resolvr.sc.request_approval_threshold` (`-1` disables request approval),
`resolvr.sc.default_catalog`, `resolvr.sc.masked_key`.

## Demo data

With demo data the default catalog becomes "IT Service Catalog" (manager Lucas Moreau, editor Jamal
Wright) with the categories Hardware, Software, Access, Mobile and Onboarding and 14 items: Standard
Laptop (model and memory choices, warranty, manager approval, prepare and deliver steps), External
Monitor (UI policy: the 4K model needs a reason), Headset, Docking Station, Wireless Keyboard and
Mouse (single default task), Software Installation (reference to the software titles list with
pricing), Design Suite Subscription (monthly price, Software Support group approval), VPN Access,
Shared Drive Access, Temporary Administrator Rights (only for Engineering and IT staff, Information
Security approval), New Mobile Phone (monthly plan, UI policy for the current number),
International Roaming (fully automated), the New Hire Onboarding order guide (rules by role,
cascading answers) and the "Report an IT issue" record producer (creates incidents, when the
incident application is installed). About twenty requests for the demo employees cover every stage:
waiting for approval, fulfillment, delivery, completed, closed incomplete, rejected and cancelled,
plus an onboarding request for the new hire Sam Patel and two incidents reported through the
producer.
