# ResolvrNow spec: ServiceNow-compatible REST API layer

Status: draft 1, dated 2026-10-21.

Goal: existing ServiceNow API clients (SDKs, integrations, scripts) work against ResolvrNow unchanged.

This file covers:
- the cross-cutting HTTP contract (section 1);
- every API ResolvrNow exposes (sections 2 to 13);
- an acceptance test list (section 14).

Companion files:

| File | Contents |
|---|---|
| `docs/spec/encoded-query.md` | The `sysparm_query` language |
| `docs/spec/data/rest-api.json` | Machine-readable endpoints, parameters, statuses, operators and the error format |

## 0. Conventions

**Tags.** Each statement carries one of two tags. In tables they appear in a "Basis" column.

| Tag | Meaning |
|---|---|
| **[Documented]** | Stated in the public product documentation cited for the section. All prose here is paraphrased. |
| **[Inferred]** | Our reasoning, platform behavior widely known to integrators, or a ResolvrNow design decision. |

Items marked "verify" should be checked against a live instance before they are frozen.

**Example values.** Hosts are `https://resolvr.example.com`. All sys_ids in examples are invented.

**Sources:**

| Id | Page | URL |
|---|---|---|
| R1 | REST APIs overview (URI format, versioning, headers, custom parameters, security) | https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/c_RESTAPI.html |
| R2 | REST API HTTP response codes | https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/r_RESTAPIHTTPResponseCodes.html |
| R3 | Table API | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html |
| R4 | Aggregate API | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AggregateAPI.html |
| R5 | Attachment API | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AttachmentAPI.html |
| R6 | Batch API | https://www.servicenow.com/docs/r/api-reference/rest-apis/batch-api.html |
| R7 | Import Set API | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ImportSetAPI.html |
| R8 | CMDB Instance API | https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-instance-api.html |
| R9 | CMDB Meta API | https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-meta-api.html |
| R10 | Knowledge Management REST API | https://www.servicenow.com/docs/r/api-reference/rest-apis/knowledge-api.html |
| R11 | Service Catalog API | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html |
| R12 | Change Management API | https://www.servicenow.com/docs/r/api-reference/rest-apis/change-management-api.html |
| R13 | Email API | https://www.servicenow.com/docs/r/api-reference/rest-apis/email-api.html |
| R14 | Account API | https://www.servicenow.com/docs/r/api-reference/rest-apis/account-api.html |
| R15 | User Role Inheritance API | https://www.servicenow.com/docs/r/api-reference/rest-apis/user-role-inheritance-api.html |
| R16 | Inbound REST API rate limiting | https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/inbound-REST-API-rate-limiting.html |
| R17 | REST OAuth example | https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/r_RESTOAuthExample.html |
| R18 | Return session debug logs in a REST response | https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/rest-session-debug-header.html |
| R19 | AP Invoice API (documents the 401 message strings) | https://www.servicenow.com/docs/r/api-reference/rest-apis/ap-invoice-api.html |

## 1. Cross-cutting HTTP contract

### 1.1 URL layout and versions

Sources: R1, plus each API page.

| API | Default (unversioned) base | Versioned base | Basis |
|---|---|---|---|
| Table | `/api/now/table` | `/api/now/{v}/table` | Documented |
| Aggregate | `/api/now/stats` | `/api/now/{v}/stats` | Documented |
| Attachment | `/api/now/attachment` | `/api/now/{v}/attachment` (the page shows `v1`) | Documented |
| Batch | `/api/now/batch` (Inferred) | `/api/now/{v}/batch` (the only form documented) | Documented / Inferred |
| Import Set | `/api/now/import` | `/api/now/{v}/import` | Documented |
| CMDB Instance | `/api/now/cmdb/instance` | `/api/now/{v}/cmdb/instance` | Documented |
| CMDB Meta | `/api/now/cmdb/meta` | `/api/now/{v}/cmdb/meta` | Documented |
| Knowledge | `/api/sn_km_api/knowledge/articles` | `/api/sn_km_api/{v}/knowledge/articles` | Documented |
| Service Catalog | `/api/sn_sc/servicecatalog` | `/api/sn_sc/{v}/servicecatalog` | Documented |
| Change Management | `/api/sn_chg_rest/change` | `/api/sn_chg_rest/{v}/change` | Documented |
| Email | `/api/now/email` (Inferred) | `/api/now/{v}/email` (the only form documented) | Documented / Inferred |
| Account | `/api/now/account` | `/api/now/{v}/account` | Documented |
| User Role Inheritance | `/api/global/user_role_inheritance` | `/api/global/{v}/user_role_inheritance` | Documented |

Rules:
- A URI with no version maps to the newest version of the endpoint. **[Documented R1]**
- ResolvrNow accepts `v1` and `v2` on every API and routes both to the same handler. The one exception is the Table API's empty-list rule (2.5). **[Inferred]** The pages list versions only as examples and defer to the REST API Explorer.
- An unknown version or unknown path returns 400 with message `Requested URI does not represent any resource`. R2 maps "URI matches no API" to 400; the message text is **[Inferred]**.
- Path matching is case-sensitive.
- A single trailing slash is tolerated. **[Inferred]**
- Literal segments are routed before `{sys_id}` parameters, so `/change/normal`, `/change/model`, `/articles/featured` and similar paths are not read as IDs. **[Inferred]**

### 1.2 Methods

| Rule | Basis |
|---|---|
| Supported methods: GET, POST, PUT, PATCH, DELETE, HEAD. HEAD is a GET that returns no body. | Documented (R1) |
| Header `X-HTTP-Method-Override` replaces the HTTP method. ResolvrNow honors it only on POST requests. | Documented (R1); Inferred (POST-only) |
| POST, PUT and PATCH write one record. If the body is a JSON array, only its first element is processed and the rest are ignored. | Documented (R1) |
| Writes to database views are rejected. ResolvrNow returns 403 `Operation Failed`. | Documented (R1); Inferred (status) |
| A method the route does not support returns 405. | Documented (R2) |

### 1.3 Content negotiation and body parsing

**Accept.** **[Documented R1]**
- Values: `application/json` (the default) and `application/xml`.
- An Accept value ResolvrNow cannot satisfy returns 406. **[Documented R2]**
- `*/*` or a missing Accept means JSON. **[Inferred]**

**Content-Type.** **[Documented R1]**
- Values: `application/json` and `application/xml`.
- Unsupported types return 415. **[Documented R2]**
- R1 states that writes require both headers and that a missing header causes 400. ResolvrNow is lenient: when Content-Type is missing and the body parses as JSON, ResolvrNow accepts it, because several official samples omit the header. **[Inferred]**

**Lenient JSON.** The official samples send:
- single-quoted JSON: `{'short_description':'...'}` in the Table, Import Set and Batch samples (the Batch item body decodes to single-quoted JSON);
- unquoted keys, in the Change Management and Service Catalog samples.

So ResolvrNow must accept JSON5-style single quotes and unquoted keys. **[Documented as sample behavior; Inferred that the platform parser is lenient]**

**XML responses.**
- The root element is `<response>`, and each record appears as a `<result>` element. For example, the decoded Batch sample is `<response><result><user_name/></result></response>`. **[Documented R6 sample]**
- A list repeats `<result>` once per record. A reference renders as `<caller_id><link>..</link><value>..</value></caller_id>`. **[Inferred]**

**JSON responses.** ResolvrNow sets `Content-Type: application/json;charset=UTF-8`. **[Inferred]**

### 1.4 Authentication

| Mechanism | Contract | Basis |
|---|---|---|
| Basic | `Authorization: Basic base64(user:password)` | Documented (R1) |
| OAuth 2.0 password grant | `POST /oauth_token.do`, form-encoded `grant_type=password&client_id=..&client_secret=..&username=..&password=..` | Documented (R17) |
| OAuth token response | JSON `{"access_token","refresh_token","scope":"useraccount","token_type":"Bearer","expires_in":1799}` | Documented (R17) |
| OAuth API calls | Send `Authorization: Bearer <access_token>` | Documented (R17) |
| OAuth refresh | `grant_type=refresh_token` | Inferred |
| Session cookie | Cookie binding to an existing session is supported. A cookie-only request should also carry `X-UserToken` (CSRF token; it appears in the R18 sample). | Documented (R1, R18); Inferred (X-UserToken requirement) |
| MFA | A bad or missing MFA token returns 401 with header `X-MFA_TOKEN: invalid`. Bad credentials return 401 without that header. ResolvrNow: optional. | Documented (R1) |
| Public tables | Tables listed in `sys_public` (active) are reachable without authentication, and their ACLs still apply. The Knowledge API is public by default. | Documented (R1, R10) |

Requests without valid credentials get 401 and this body. Both strings appear in R19 as documented values; the pairing is **[Inferred]**.

```json
{"error":{"message":"User Not Authenticated","detail":"Required to provide Auth information"},"status":"failure"}
```

### 1.5 Authorization

**[Documented R1, R2, R3]**
- A REST call runs as the authenticated user, with the same ACLs as an interactive session.
- The API-level ACLs for the Table, Aggregate, Import Set and Attachment APIs ship deactivated. Access to those APIs is governed by table, record and field ACLs alone.
- A table must allow web service access, through the table's "Allow access to this table via web services" flag. The application-access CRUD flags do not apply to REST.
- Fields the caller may not read are omitted from responses.
- A record the caller may not read returns 404. ACL failures on writes, business rules that abort, and data policies return 403.
- Role requirements per API are in each section. The role names to seed are `itil`, `admin`, `change_manager`, `sn_change_read`, `sn_change_writer`, `catalog_admin`, `email_api_send`, `csm_ws_integration`, `user_admin` and `query_no_domain_table_api`.

### 1.6 Response envelope

| Case | Shape | Basis |
|---|---|---|
| Single record | `{"result": { ... }}` | Documented (R3) |
| List | `{"result": [ ... ]}`. An empty valid query returns `{"result": []}`. | Documented (R3) |
| Error | `{"error": {"message": "<text>", "detail": "<text or null>"}, "status": "failure"}`. The `status` key is present only on errors. | Documented (R5, R8, R16) |
| Session debug | Request header `X-WantSessionDebugMessages: true` adds a sibling `"session": {"debug_logs": [{"type","customerUpdate","line","debugClassSet"}]}`. | Documented (R18) |
| Exceptions | Batch, Import Set and Knowledge use their own top-level shapes (sections 5, 6, 9). | Documented |

### 1.7 Field value serialization

This applies to the Table API and to APIs that reuse its record format: Aggregate group keys, CMDB attributes, and Account. Sources: R1, R3 (samples).

| Field type | Default (`sysparm_display_value=false`) | `true` | `all` | Basis |
|---|---|---|---|---|
| Any scalar | A JSON **string**, never a number or boolean. Example: `"priority": "4"`. | display string | `{"display_value": "...", "value": "..."}` | Documented (samples) |
| Empty value | `""` (never `null`). | `""` | `{"display_value": "", "value": ""}` | Documented (samples) |
| Boolean | `"true"` / `"false"` | `"true"` / `"false"` | both | Documented (samples) |
| Choice | The stored value, e.g. `"2"` | The label, e.g. `"In Progress"` | both | Documented (R3) |
| Reference, set | `{"link": "<base>/api/now/table/<target>/<sys_id>", "value": "<sys_id>"}` | `{"display_value": "<target display>", "link": "..."}` | `{"display_value", "link", "value"}` | Documented (samples); Inferred for `all` |
| Reference, empty | `""` | `""` | `{"display_value": "", "value": ""}` | Documented (sample `"parent": ""`) |
| Reference with `sysparm_exclude_reference_link=true` | `"<sys_id>"` | `"<display>"` | `{"display_value", "value"}` | Inferred |
| Date-time | UTC `YYYY-MM-DD HH:MM:SS` | User time zone and user format | both | Documented (R3) |
| Date | `YYYY-MM-DD` | User format | both | Inferred |
| Duration | `1970-01-01 HH:MM:SS`, counting from the epoch, so 26 hours is `1970-01-02 02:00:00`. ResolvrNow stores milliseconds and formats them on output. | Words, e.g. `1 Day 2 Hours` | both | Documented (`"business_duration": "1970-01-01 00:00:00"`); Inferred for longer spans |
| Journal input (`comments`, `work_notes`) | `""` on read; writes append an entry | Concatenated history text | both | Documented (samples show `""`); Inferred (display) |
| List (`watch_list`, `glide_list`) | Comma-separated sys_ids | Comma-separated display values | both | Inferred |
| `sys_domain` | Reference object, value `"global"`, link `.../sys_user_group/global` | as reference | as reference | Documented (sample) |
| Currency / price | Stored amount. On input there is no conversion; on output the value is converted to the reader's locale. | Localized with symbol | both | Documented (R1) |
| Password | Never returned in clear text | n/a | n/a | Inferred |
| Encrypted fields | Hidden without the encryption context. Writing requires `sysparm_input_display_value=true`. | | | Documented (R3) |

Link rules **[Inferred]**:
- `link` URLs are absolute.
- They are built from the request's scheme and host.
- They always use the unversioned path, as all samples do.

### 1.8 Standard query parameters

Source: R1 ("custom query parameters") and R3.

| Name | Type | Default | Meaning | Basis |
|---|---|---|---|---|
| `sysparm_query` | string | none | Encoded query (see `encoded-query.md`) | Documented |
| `sysparm_fields` | string | all fields | Comma list of fields to return. Dot-walking is allowed (key = dotted path). Unknown names are ignored. | Documented |
| `sysparm_limit` | number | 10000 | Page size. It is applied before ACL filtering, so pages can come back short. | Documented |
| `sysparm_offset` | number | 0 | Index of the first record. Next page = offset + limit. Negative values are not allowed; ResolvrNow clamps them to 0. | Documented (Inferred: clamp) |
| `sysparm_display_value` | string | `false` | `false`, `true` or `all` (1.7) | Documented |
| `sysparm_exclude_reference_link` | boolean | false | Drop `link` from references | Documented |
| `sysparm_input_display_value` | boolean | false | Treat input values as display values. Reference by display, choice by label, date-times in the user's time zone. | Documented |
| `sysparm_suppress_pagination_header` | boolean | false | Omit the `Link` header | Documented |
| `sysparm_no_count` | boolean | false | Skip the `count(*)`. ResolvrNow then omits `X-Total-Count`. | Documented (Inferred: header omission) |
| `sysparm_view` | string | none | `desktop`, `mobile` or `both`: return the fields of that UI view. `sysparm_fields` wins when both are given. | Documented |
| `sysparm_query_category` | string | none | Query category name. ResolvrNow accepts it and ignores it. | Documented (Inferred: ignore) |
| `sysparm_query_no_domain` | boolean | false | Search across all domains. Only for `admin` or `query_no_domain_table_api`. | Documented |

General parsing rules **[Inferred]**:
- Booleans parse case-insensitively. Values other than `true` count as false.
- A non-numeric `sysparm_limit` or `sysparm_offset` falls back to the default.
- Unknown `sysparm_*` names are ignored.
- ResolvrNow enforces a configurable hard cap on `sysparm_limit`, default 10000.

### 1.9 Pagination headers

**[Documented R3]** for the header names and `rel` values.

| Header | Format | Rules |
|---|---|---|
| `X-Total-Count` | integer | Count of every row matching the query, ignoring limit and offset **[Inferred; R3 calls it the total count of records the query returns]**. |
| `Link` | `<URL>;rel="first",<URL>;rel="prev",<URL>;rel="next",<URL>;rel="last"` | See the rules below this table. |

`Link` header rules:
- Each URL is absolute and repeats every original query parameter, with only `sysparm_offset` and `sysparm_limit` replaced. **[Inferred]**
- `first` has offset 0. **[Inferred]**
- `prev` appears only when offset > 0, at `max(0, offset - limit)`. **[Inferred]**
- `next` appears only when `offset + limit < total`. **[Inferred]**
- `last` is at `floor((total - 1) / limit) * limit`, or 0 when the total is 0. **[Inferred]**
- Entries are comma-separated, with no space after `;`. Clients must not depend on their order. **[Inferred]**
- The header is omitted when `sysparm_suppress_pagination_header=true`. **[Documented]**

Example: total 57, limit 10, offset 20.

```
X-Total-Count: 57
Link: <https://resolvr.example.com/api/now/table/incident?sysparm_limit=10&sysparm_offset=0>;rel="first",<https://resolvr.example.com/api/now/table/incident?sysparm_limit=10&sysparm_offset=10>;rel="prev",<https://resolvr.example.com/api/now/table/incident?sysparm_limit=10&sysparm_offset=30>;rel="next",<https://resolvr.example.com/api/now/table/incident?sysparm_limit=10&sysparm_offset=50>;rel="last"
```

### 1.10 Status codes

Source: R2, R16.

| Code | Use | Basis |
|---|---|---|
| 200 | Success with body (GET, PUT, PATCH; some API-specific POSTs) | Documented |
| 201 | Created with body (Table POST, Attachment POST, Import Set POST) | Documented |
| 202 | Accepted, async worker (Change Management CI association and scheduling) | Documented (R12) |
| 204 | Success with no body (Table DELETE, Attachment DELETE and rename) | Documented |
| 400 | Bad request: URI matches no API, malformed body, invalid headers, or missing mandatory input | Documented |
| 401 | Not authenticated | Documented |
| 403 | Authenticated but not allowed (ACL, business rule abort, data policy) | Documented |
| 404 | Resource missing or unreadable | Documented |
| 405 | Method not allowed for the route | Documented |
| 406 | Accept not supported | Documented |
| 415 | Content-Type not supported | Documented |
| 429 | Rate limit exceeded; sends `Retry-After` and `X-RateLimit-Limit/Reset/Rule` | Documented (R16) |
| 500 | Unexpected error; the body includes details | Documented |
| 502, 503 | Gateway or unavailable (proxy-level only) | Documented |

### 1.11 Error catalogue

The JSON shape is fixed by section 1.6. Message wording marked Inferred should be verified, because some clients match on it.

| Situation | Status | `error.message` | `error.detail` | Basis |
|---|---|---|---|---|
| No or bad credentials | 401 | `User Not Authenticated` | `Required to provide Auth information` | Documented strings (R19) |
| Record not found or not readable (Table API) | 404 | `No Record found` | `Record doesn't exist or ACL restricts the record retrieval` | Inferred, verify |
| Unknown table | 400 | `Invalid table <name>` | null | Inferred, verify |
| Unknown URI or version | 400 | `Requested URI does not represent any resource` | null | Inferred |
| Malformed JSON or XML | 400 | `Exception while reading request` | parser message | Inferred |
| Write denied by ACL | 403 | `Operation Failed` | `ACL Exception Insert Failed due to security constraints` (and the `Update` and `Delete` variants) | Inferred, verify |
| Business rule abort or data policy | 403 | `Operation Failed` | the rule's message | Documented status (R2); Inferred text |
| Rate limited | 429 | `Rate limit exceeded` | `Rate limit of <n> requests per hour for <API> exceeded` | Documented (R16) |
| Unhandled failure | 500 | short text | diagnostic text | Documented (R2) |
| CMDB create with a broken dependent relation | see 7.4 | `Exception while executing request: null` | `Exception while executing request: null Check logs for error trace or enable glide.rest.debug property to verify REST request processing` | Documented (R8) |

### 1.12 Header summary

| Header | Dir | Meaning | Basis |
|---|---|---|---|
| `Accept`, `Content-Type` | req | Formats (1.3) | Documented |
| `Authorization` | req | Basic or Bearer | Documented |
| `X-HTTP-Method-Override` | req | Method tunneling | Documented (R1) |
| `X-no-response-body: true` | req | Suppress the body on Table POST, PUT and PATCH. The status code is unchanged. | Documented (R3); Inferred (status unchanged) |
| `X-WantSessionDebugMessages: true` | req | Add `session.debug_logs` to the response | Documented (R18) |
| `X-UserToken` | req | CSRF token for cookie sessions | Documented (R18 sample) |
| `X-BATCHREQUEST-MAX-OUTPUT-SIZE` | req | Per-item response cap for Batch | Documented (R6) |
| `Link`, `X-Total-Count` | resp | Pagination (1.9) | Documented (R3) |
| `Location` | resp | Absolute URL of the created resource (Table POST, Attachment POST) | Documented (R3, R5) |
| `X-Attachment-Metadata` | resp | Metadata of the downloaded file, as JSON | Documented (R5); Inferred (JSON encoding) |
| `X-RateLimit-Limit`, `X-RateLimit-Reset`, `X-RateLimit-Rule`, `Retry-After` | resp | Rate limiting | Documented (R16) |
| `X-MFA_TOKEN` | resp | `invalid` on a failed MFA check | Documented (R1) |

## 2. Table API

Source: R3. Roles: none specific to the API. The caller needs the table's own ACL roles, for example `itil` to write `incident`. **[Documented]**

### 2.1 Endpoints

| Method | Path (default; versioned form inserts `/{v}` after `/now`) | Purpose | Success | Documented statuses |
|---|---|---|---|---|
| GET | `/api/now/table/{tableName}` | List records | 200 | 200 |
| GET | `/api/now/table/{tableName}/{sys_id}` | Read one record | 200 | 200, 404 |
| POST | `/api/now/table/{tableName}` | Insert one record | 201 | 201, 400, 404 |
| PUT | `/api/now/table/{tableName}/{sys_id}` | Update one record | 200 | 200, 400, 404 |
| PATCH | `/api/now/table/{tableName}/{sys_id}` | Update one record | 200 | 200, 400, 404 |
| DELETE | `/api/now/table/{tableName}/{sys_id}` | Delete one record | 204 | 204 |
| HEAD | as the two GETs | Headers only | 200 | 200 (method documented in R1) |

ResolvrNow additionally returns:
- 400 for an unknown table;
- 401 and 403 per 1.4 and 1.5;
- 404 on PUT, PATCH and DELETE when the sys_id is unknown.

These are **[Inferred]**.

### 2.2 Query parameters per endpoint

Definitions are in 1.8. The matrix below follows the documented tables in R3 **[Documented]**. ResolvrNow also accepts the PATCH gap, `sysparm_exclude_reference_link`. **[Inferred]**

| Parameter | GET list | GET one | POST | PUT | PATCH | DELETE |
|---|---|---|---|---|---|---|
| `sysparm_query` | yes | | | | | |
| `field=value` filters | yes | | | | | |
| `sysparm_display_value` | yes | yes | yes | yes | yes | |
| `sysparm_exclude_reference_link` | yes | yes | yes | yes | (ResolvrNow) | |
| `sysparm_fields` | yes | yes | yes | yes | yes | |
| `sysparm_limit`, `sysparm_offset` | yes | | | | | |
| `sysparm_no_count`, `sysparm_suppress_pagination_header`, `sysparm_query_category` | yes | | | | | |
| `sysparm_view` | yes | yes | yes | yes | yes | |
| `sysparm_input_display_value` | | | yes | yes | yes | |
| `sysparm_query_no_domain` | yes | yes | | yes | yes | yes |

**`field=value` filters.** Any query parameter that is not a `sysparm_*` name is an equality filter, ANDed with the others.
- These filters cannot be combined with `sysparm_query`. **[Documented]** If both are sent, ResolvrNow uses `sysparm_query` and ignores the pairs. **[Inferred]**
- Choice and reference fields accept display values, e.g. `state=closed` or `assigned_to=john.smith`. **[Documented]**

### 2.3 Request body (POST, PUT, PATCH)

A flat JSON object of field names and values: `{"short_description": "Printer jam", "urgency": "2"}`. **[Documented]**

Rules:
- `sys_*` fields are system-maintained. ResolvrNow ignores them in input. **[Documented that they are typically not updatable]**
- On POST, fields that are not supplied get their default, or the type's empty value. **[Documented]**
- An empty string clears a field, except on choice fields, where ResolvrNow leaves the value unchanged. **[Documented R1]**
- Unknown field names are ignored silently. **[Inferred]**
- A `sys_id` supplied in a POST body is used as the new record's id if it is a valid, unused 32-hex value. Otherwise ResolvrNow returns 400. **[Inferred, verify]**
- Writing `comments` or `work_notes` appends a journal entry. **[Inferred]**
- Reference values are sys_ids. With `sysparm_input_display_value=true`, the display value is resolved instead. **[Documented]** ResolvrNow also resolves an exact display-value match when the value is not a sys_id. **[Inferred, verify]**
- Date-time input is taken as UTC unless `sysparm_input_display_value=true`, in which case it is in the user's time zone. **[Documented]**
- Choice values are stored as given. They are not validated against the choice list. **[Inferred]**
- **PUT and PATCH semantics are identical.** Both are partial updates; fields absent from the body keep their values. Neither creates a record when the sys_id is unknown (404). **[Inferred]** R3 describes both as updates and documents no replace or upsert behavior.

### 2.4 Response

- **GET one, POST, PUT, PATCH:** `{"result": {<all readable fields, or sysparm_fields>}}`, using the formats in 1.7.
- **GET list:** `{"result": [ ... ]}`, with `X-Total-Count` and `Link` (1.9).
- **POST:** sends `Location: <base>/api/now/table/<table>/<sys_id>`.
- **DELETE:** 204 with an empty body.

All of the above are **[Documented]**.

### 2.5 Behaviors and edge cases

| Topic | Rule | Basis |
|---|---|---|
| Empty result | A valid query with no hits returns 200 `{"result":[]}` on the default and `v2` paths. On `v1` it returns 404. | Documented |
| Invalid query parts | Ignored, unless `glide.invalid_query.returns_no_rows=true` | Documented |
| Table hierarchy | ResolvrNow stores `incident`, `problem` and `change_request` in `task`. `GET /table/task` returns every subclass row with its real `sys_class_name`, rendering only the fields defined on `task` and its ancestors. `GET /table/incident/{sys_id-of-a-problem}` returns 404. | Inferred |
| Record numbers | Generated on insert from the table's prefix and counter (`INC0010001`; `task` uses `TASK`). | Inferred (prefixes from the SDK schema) |
| Limit vs ACL | The limit is applied before ACL filtering on the platform. ResolvrNow may filter first, which is strictly safer. | Documented (platform); Inferred (ResolvrNow) |
| `X-no-response-body` | The status is still 201 or 200; the body is empty. | Inferred |
| Mandatory fields | Not enforced by REST, except through data policies (403). | Inferred |
| Display-value cost | `sysparm_display_value` may be slower; that is no reason to reject the request. | Documented |
| Domain separation | `sysparm_query_no_domain=true` requires `admin` or `query_no_domain_table_api`; otherwise ResolvrNow ignores the parameter. | Documented; Inferred (ignore) |

### 2.6 Examples

**List with paging and reference objects:**

```
GET /api/now/table/incident?sysparm_query=active=true^ORDERBYnumber&sysparm_fields=number,state,caller_id,opened_at&sysparm_limit=2
Accept: application/json
```

```
HTTP/1.1 200 OK
Content-Type: application/json;charset=UTF-8
X-Total-Count: 3
Link: <https://resolvr.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Cstate%2Ccaller_id%2Copened_at&sysparm_limit=2&sysparm_offset=0>;rel="first",<https://resolvr.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Cstate%2Ccaller_id%2Copened_at&sysparm_limit=2&sysparm_offset=2>;rel="next",<https://resolvr.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Cstate%2Ccaller_id%2Copened_at&sysparm_limit=2&sysparm_offset=2>;rel="last"

{"result":[
  {"number":"INC0010001","state":"1","opened_at":"2026-10-20 08:15:00",
   "caller_id":{"link":"https://resolvr.example.com/api/now/table/sys_user/7a1c0f3e9b2d4c5e8f60718293a4b5c6","value":"7a1c0f3e9b2d4c5e8f60718293a4b5c6"}},
  {"number":"INC0010002","state":"2","opened_at":"2026-10-20 09:40:12","caller_id":""}
]}
```

**Read with `sysparm_display_value=all`:**

```
GET /api/now/table/incident/3c4d5e6f708192a3b4c5d6e7f8091a2b?sysparm_fields=number,state,caller_id&sysparm_display_value=all
```

```json
{"result":{
  "number":{"display_value":"INC0010001","value":"INC0010001"},
  "state":{"display_value":"New","value":"1"},
  "caller_id":{"display_value":"Abel Tuter","link":"https://resolvr.example.com/api/now/table/sys_user/7a1c0f3e9b2d4c5e8f60718293a4b5c6","value":"7a1c0f3e9b2d4c5e8f60718293a4b5c6"}
}}
```

**Create:**

```
POST /api/now/table/incident?sysparm_fields=sys_id,number,urgency
Content-Type: application/json

{"short_description":"Badge reader offline in lobby","urgency":"2"}
```

```
HTTP/1.1 201 Created
Location: https://resolvr.example.com/api/now/table/incident/0b1c2d3e4f5061728394a5b6c7d8e9f0

{"result":{"sys_id":"0b1c2d3e4f5061728394a5b6c7d8e9f0","number":"INC0010004","urgency":"2"}}
```

**Not found:**

```
GET /api/now/table/incident/ffffffffffffffffffffffffffffffff
```

```
HTTP/1.1 404 Not Found

{"error":{"message":"No Record found","detail":"Record doesn't exist or ACL restricts the record retrieval"},"status":"failure"}
```

## 3. Aggregate (Stats) API

Source: R4. Role: read access to the table. The API uses aggregate queries and honors read-only queries only where the table grants read access. **[Documented]**

### 3.1 Endpoint

| Method | Path | Success | Documented statuses |
|---|---|---|---|
| GET | `/api/now/stats/{tableName}` (versioned `/api/now/{v}/stats/{tableName}`) | 200 | 200, 401, 403, 500 |

### 3.2 Query parameters

All **[Documented]**.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `sysparm_query` | string | none | Encoded query |
| `field=value` | string | none | Equality filters (display values accepted for choice and reference fields) |
| `sysparm_count` | boolean | false | Return the record count |
| `sysparm_avg_fields`, `sysparm_min_fields`, `sysparm_max_fields`, `sysparm_sum_fields` | string | none | Comma list of fields to aggregate |
| `sysparm_group_by` | string | none | Comma list of grouping fields |
| `sysparm_having` | string | none | `aggregate^field^operator^value`, comma-separated. Example: `count^priority^>^3`. |
| `sysparm_order_by` | string | none | Groups ordering: `field`, `AGG^field`, `COUNT`, optional `^DESC`. Ascending by default. |
| `sysparm_display_value` | string | false | `true`, `false` or `all`; affects the group values of reference and choice fields |

If neither `sysparm_count` nor any `sysparm_<agg>_fields` is passed, no aggregate is computed. ResolvrNow then returns `{"result":{"stats":{}}}`. **[Documented that nothing is computed; Inferred body]**

### 3.3 Response

Without `sysparm_group_by` **[Inferred]**:

```json
{"result":{"stats":{"count":"42","avg":{"reassignment_count":"1.2500"},"max":{"priority":"5"}}}}
```

With `sysparm_group_by` **[Documented]**: an array, one element per group.

```json
{"result":[
  {"stats":{"count":"7"},"groupby_fields":[{"field":"priority","value":"1"}]},
  {"stats":{"count":"12"},"groupby_fields":[{"field":"priority","value":"3"}]}
]}
```

Rules:
- All numbers are strings. **[Documented]**
- `avg` values carry four decimals, for example `"1.0000"`. **[Documented sample]**
- A NULL group value is `""`. **[Documented sample]**
- With `sysparm_display_value=true`, `value` holds the display text. With `all`, each group entry also gets `display_value`. **[Inferred]**
- Durations are averaged as numbers of seconds. **[Inferred]** The sample averages an integer-seconds duration field (`business_stc`).

## 4. Attachment API

Source: R5. **[Documented]**

**Roles.** The caller needs:
- create rights on `sys_attachment`;
- read and write on the target record's table (for example `itil` for incidents).

There is no dedicated attachment role.

**Size and type limits.**
- `com.glide.attachment.max_size`: default 1024 MB. **[Documented]**
- `glide.attachment.extensions`: allowed extensions. **[Documented]**
- A violation returns 400. **[Inferred]**

### 4.1 Endpoints

| Method | Path (under `/api/now/attachment`; versioned `/api/now/v1/attachment`) | Purpose | Success | Documented statuses |
|---|---|---|---|---|
| GET | (base path) | List attachment metadata | 200 | 200, 401, 500 |
| GET | `/{sys_id}` | One attachment's metadata | 200 | 200, 401, 404, 500 |
| GET | `/{sys_id}/file` | Download the binary | 200 | 200, 400, 401, 500 |
| POST | `/file` | Upload a raw binary body | 201 | 201, 400, 404, 500 |
| POST | `/upload` | Upload via multipart/form-data | 201 | 201, 400, 401, 404, 500 |
| PATCH | `/{sys_id}` | Rename (`{"file_name": "..."}`) | 204 | 204, 400, 401 |
| DELETE | `/{sys_id}` | Delete | 204 | 204, 401, 404, 500 |
| GET | `/{sys_id}/attributes` | List attributes | 200 | 200, 400, 404 |
| GET | `/{sys_id}/attributes/{attribute_key}` | One attribute | 200 | 200, 400, 404 |
| POST | `/{sys_id}/attributes` | Add an attribute: body `{"key","value"}`, both required | 201 | 201, 400, 404 |
| PUT | `/{sys_id}/attributes/{attribute_key}` | Update an attribute: body `{"value"}` | 200 | 200, 400, 404 |
| DELETE | `/{sys_id}/attributes` | Delete all attributes | 204 | 204, 400, 404 |
| DELETE | `/{sys_id}/attributes/{attribute_key}` | Delete one attribute | 204 | 204, 400, 404 |

Attributes live in `sys_attachment_attribute`.
- One attribute: `{"result": {"key": "...", "value": "..."}}`.
- List of attributes: `{"result": [{"key","value"}, ...]}`.

**[Documented]**

### 4.2 Parameters

| Endpoint | Name | Type | Default | Meaning | Basis |
|---|---|---|---|---|---|
| GET list | `sysparm_limit` | string (number) | **1000** | Page size | Documented |
| GET list | `sysparm_offset` | string (number) | 0 | Records to skip | Documented |
| GET list | `sysparm_query` | string | none | Query on `sys_attachment`; ORDERBY supported | Documented |
| POST /file | `table_name` | string | required | Target table | Documented |
| POST /file | `table_sys_id` | string | required | Target record | Documented |
| POST /file | `file_name` | string | required | Stored file name | Documented |
| POST /file | `creation_time` | string | now | Creation time override (offline uploads) | Documented |
| POST /file | `encryption_context` | string | user's context, if any | Restrict access to holders of this context | Documented |

### 4.3 Upload rules

**POST /file:**
- The request body is the raw file.
- The `Content-Type` header is mandatory and becomes the stored `content_type` (any type, including `*/*`).

**POST /upload:**
- The body is `multipart/form-data`. Form fields `table_name` and `table_sys_id` must come before the file part, and **the file part must be last**.
- The file part's own `Content-Type` is stored.
- The file name is taken from the part's filename. **[Inferred]**

Statuses:
- A missing `table_name`, `table_sys_id` or `file_name` returns 400.
- An unknown or unreadable target record returns 404.

Both uploads return 201, a `Location` header and the metadata object. **[Documented]**

### 4.4 Metadata object and download

All values are **plain strings**, with no reference objects:

```json
{"result":{"sys_id":"5a6b7c8d9e0f11223344556677889900","file_name":"router.log","content_type":"text/plain",
  "size_bytes":"2048","size_compressed":"611","compressed":"true","table_name":"incident",
  "table_sys_id":"0b1c2d3e4f5061728394a5b6c7d8e9f0",
  "download_link":"https://resolvr.example.com/api/now/attachment/5a6b7c8d9e0f11223344556677889900/file",
  "image_width":"","image_height":"","average_image_color":"","sys_tags":"","sys_mod_count":"0",
  "sys_created_by":"abel.tuter","sys_created_on":"2026-10-21 10:02:11","sys_updated_by":"abel.tuter",
  "sys_updated_on":"2026-10-21 10:02:11","created_by_name":"Abel Tuter","updated_by_name":"Abel Tuter"}}
```

The field list is **[Documented R5]**. The values are invented.

**`GET /{sys_id}/file`:**
- Returns the bytes with `Content-Type` equal to the stored type, plus `X-Attachment-Metadata`.
- Accept defaults to `*/*`. **[Documented]**
- If Accept excludes the stored type, ResolvrNow returns 406. **[Inferred]**
- ResolvrNow also sends `Content-Disposition: attachment; filename="<file_name>"`. **[Inferred]**

**GET list paging.** The page documents a `Link` response header for the list. ResolvrNow emits Table-API-style pagination `Link` and `X-Total-Count` headers. **[Inferred]**

## 5. Batch API

Source: R6. **[Documented]** unless marked.

| Method | Path | Success | Documented statuses |
|---|---|---|---|
| POST | `/api/now/{v}/batch`, and also `/api/now/batch` (Inferred) | 200 | 200, 401, 500 |

**Headers:**
- `Content-Type` must be `application/json`.
- `Accept` may be `application/json` or `multipart/mixed`.
- `X-BATCHREQUEST-MAX-OUTPUT-SIZE` can lower the per-item output cap.

**Request:**

| Field | Type | Req | Meaning |
|---|---|---|---|
| `batch_request_id` | string | no | Echoed back |
| `rest_requests[]` | array | yes | Items to run |
| `.id` | string | yes | Item id, echoed |
| `.method` | string | yes | HTTP method |
| `.url` | string | yes | Relative URL with query, e.g. `/api/now/table/incident?sysparm_limit=1` |
| `.headers[]` | array of `{"name","value"}` | no | Item request headers |
| `.body` | string | no | Base64 of the item body, which may be JSON or XML |
| `.exclude_response_headers` | boolean | no (false) | Drop headers from the item result |

**Response:** no `result` wrapper.

| Field | Type | Meaning |
|---|---|---|
| `batch_request_id` | string | Echo |
| `serviced_requests[]` | array | One entry per executed item, in order |
| `.id` | string | Item id |
| `.status_code` | number | Item HTTP status |
| `.status_text` | string | Item status text, e.g. `OK`, `Created` |
| `.headers[]` | array of `{"name","value"}` | Item response headers; `[]` when excluded |
| `.body` | string | Base64 of the item response body |
| `.execution_time` | number | Milliseconds |
| `.error_message` | string | Present on failure |
| `.redirect_url` | string | Present on redirect |
| `unserviced_requests` | array of ids | Items skipped because a limit was hit |

**Limits:**
- Per item: 5 MB input (`glide.rest.batch.max.inputSize`, maximum 10 MB) and 10 MB output (`glide.rest.batch.max.outputSize`). **[Documented]**
- The whole batch is capped by a 30-second transaction quota. **[Documented]**
- When a limit is hit, the remaining items are listed in `unserviced_requests`. **[Documented]**

**Behavior:**
- ACLs are applied to each item. **[Documented]**
- Items run sequentially, in order, as the calling user. **[Inferred]**
- A failing item does not abort the batch; it gets its own status. **[Inferred]**
- Nested batch calls are rejected with an item status of 400. **[Inferred]**

**Example:**

```json
{"batch_request_id":"b-77","rest_requests":[
  {"id":"1","method":"GET","url":"/api/now/table/incident?sysparm_limit=1&sysparm_fields=number",
   "headers":[{"name":"Accept","value":"application/json"}],"exclude_response_headers":true},
  {"id":"2","method":"POST","url":"/api/now/table/incident?sysparm_fields=number",
   "headers":[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}],
   "body":"eyJzaG9ydF9kZXNjcmlwdGlvbiI6IkRpc2sgZnVsbCJ9"}]}
```

```json
{"batch_request_id":"b-77","serviced_requests":[
  {"id":"1","status_code":200,"status_text":"OK","headers":[],"execution_time":6,
   "body":"eyJyZXN1bHQiOlt7Im51bWJlciI6IklOQzAwMTAwMDEifV19"},
  {"id":"2","status_code":201,"status_text":"Created","headers":[{"name":"Content-Type","value":"application/json;charset=UTF-8"}],
   "execution_time":31,"body":"eyJyZXN1bHQiOnsibnVtYmVyIjoiSU5DMDAxMDAwNSJ9fQ=="}],
 "unserviced_requests":[]}
```

## 6. Import Set API

Source: R7, plus R1 (no dot-walking). **[Documented]** unless marked.

**Access.**
- Basic authentication, with ACLs on the staging table.
- The Import Set API ACL ships inactive.
- Tables can be made public through `sys_public`.
- The caller needs create rights on the staging table. **[Inferred]**

### 6.1 Endpoints

| Method | Path (versioned: `/api/now/{v}/import/...`) | Purpose | Success | Documented statuses |
|---|---|---|---|---|
| POST | `/api/now/import/{stagingTableName}` | Insert one staging row; transform synchronously | 201 | 200, 201, 401, 500 |
| POST | `/api/now/import/{stagingTableName}/insertMultiple` | Insert many rows; transform asynchronously by default | 201 | 200, 201, 401, 500 |
| GET | `/api/now/import/{stagingTableName}/{sys_id}` | Read a staging row and its transform result | 200 | 200, 401, 404, 500 |

### 6.2 Requests

**POST (single).**
- The body is a flat object of string values keyed by staging column. Values that are not strings are stringified; nested objects turn `:` into `=`.
- Accept and Content-Type: JSON or XML.

**insertMultiple.**
- Body `{"records": [{"<column label or name>": "<value>"}, ...]}`. Keys are column **labels** by default. A `sys_rest_insert_multiple` entry can switch them to column names, use the data source's own JSON format, or make the transform synchronous.
- JSON only.

| Query parameter (insertMultiple only) | Type | Meaning |
|---|---|---|
| `multi_import_set_id` | string | Add this import to an existing `sys_multi_import_set` |
| `run_after` | string | `sys_import_set` sys_id to run after (async only) |

### 6.3 Responses

There is no `result` object at the top level.

**POST and GET:**

```json
{"import_set":"ISET0010042","staging_table":"u_imp_user",
 "result":[{"transform_map":"User Import","table":"sys_user","display_name":"name","display_value":"Lena Ortiz",
            "record_link":"https://resolvr.example.com/api/now/table/sys_user/1f2e3d4c5b6a79881726354453627180",
            "status":"inserted","sys_id":"1f2e3d4c5b6a79881726354453627180"}]}
```

**insertMultiple:**

```json
{"import_set_id":"<sys_import_set sys_id>","multi_import_set_id":"<sys_multi_import_set sys_id>"}
```

**Status values and messages:**
- `result[].status` takes the values `inserted`, `updated`, `ignored`, `skipped` and `error`. Only `inserted` appears in the docs; the rest are **[Inferred]**.
- If a transform script sets `status_message` or `error_message`, those are added to the entry. Custom response fields are added the same way. **[Documented]**

**Staging-row lifetime.** Staging rows are purged on a schedule, so GET can return 404 later.

## 7. CMDB Instance API

Source: R8. **[Documented]** unless marked.

**Roles and scope:**
- Role: `itil`.
- Each write handles one CI.
- Creates return **200**, not 201.
- Every endpoint documents 200, 400, 401, 404, 405 and 500.
- Errors use the 1.6 envelope.

### 7.1 Endpoints

| Method | Path (versioned: `/api/now/{v}/cmdb/instance/...`) | Purpose |
|---|---|---|
| GET | `/api/now/cmdb/instance/{className}` | List CIs of a class; returns `[{"sys_id","name"}]` only |
| GET | `/api/now/cmdb/instance/{className}/{sys_id}` | One CI: attributes plus relations |
| POST | `/api/now/cmdb/instance/{className}` | Create a CI, optionally with relations |
| PUT | `/api/now/cmdb/instance/{className}/{sys_id}` | Update attributes (merge, not replace) |
| PATCH | `/api/now/cmdb/instance/{className}/{sys_id}` | Same as PUT |
| POST | `/api/now/cmdb/instance/{className}/{sys_id}/relation` | Add inbound or outbound relations |
| DELETE | `/api/now/cmdb/instance/{className}/{sys_id}/relation/{rel_sys_id}` | Remove one relation; 200 |

**List parameters:**

| Name | Type | Default |
|---|---|---|
| `sysparm_limit` | number | **10000** |
| `sysparm_offset` | number | 0 |
| `sysparm_query` | string | none |

The list has no count header and no `Link` header.

### 7.2 Write bodies

```json
{"source":"ServiceNow",
 "attributes":{"name":"lnx-web-07","ip_address":"10.20.30.47","ram":"16384"},
 "outbound_relations":[{"type":"<cmdb_rel_type sys_id>","target":"<cmdb_ci sys_id>"}],
 "inbound_relations":[{"type":"<cmdb_rel_type sys_id>","target":"<cmdb_ci sys_id>"}]}
```

**`source`** is required on POST, PUT, PATCH and POST relation. It must be a `cmdb_ci.discovery_source` choice. The page gives no value list; the sample uses `ServiceNow`.
- ResolvrNow validates it against seeded choices. A missing or invalid value returns 400. **[Inferred]**

**Relations:**
- `type` and `target` are mandatory in each relation.
- Outbound: the path CI is the parent.
- Inbound: the path CI is the child.

**PUT and PATCH:**
- Both are merges: columns absent from `attributes` keep their values.
- Relations are never touched.
- Unknown attribute names are dropped silently. **[Documented sample behavior]**
- `discovery_source` follows `source`.
- `last_discovered` and `sys_updated_on` are refreshed, and `sys_mod_count` increments.

**Dependent identification.** Classes with a dependent identification rule need a relation to an existing CI. A missing or invalid target produces the CMDB error in 1.11. Its HTTP status is not shown in the docs; ResolvrNow uses 400. **[Inferred]**

**Identification and reconciliation.** ResolvrNow runs identification on POST, so a match updates the existing CI instead of creating a duplicate. Reconciliation is keyed on `source`. **[Inferred]** The page never names these mechanisms.

**Duplicate relations.** Re-adding an existing (parent, child, type) relation is idempotent and returns the same relation sys_id. **[Inferred from sample]**

### 7.3 Read model

```json
{"result":{
  "attributes":{"name":"lnx-web-07","sys_class_name":"cmdb_ci_linux_server","install_status":"1",
    "location":{"display_value":"Austin DC","link":"https://resolvr.example.com/api/now/table/cmn_location/2b3c...","value":"2b3c..."},
    "managed_by":"","sys_domain":{"display_value":"global","link":"https://resolvr.example.com/api/now/table/sys_user_group/global","value":"global"}},
  "outbound_relations":[{"sys_id":"<cmdb_rel_ci sys_id>",
    "type":{"display_value":"Runs on::Runs","link":"https://resolvr.example.com/api/now/table/cmdb_rel_type/60bc4e22c0a8010e01f074cbe6bd73c3","value":"60bc4e22c0a8010e01f074cbe6bd73c3"},
    "target":{"display_value":"esx-host-02","link":"https://resolvr.example.com/api/now/cmdb/instance/cmdb_ci/9a8b...","value":"9a8b..."}}],
  "inbound_relations":[]}}
```

**Rendering rules:**
- Scalars are strings.
- A filled reference renders as `{display_value, link, value}`.
- An empty reference renders as `""`.
- A relation's `target.link` points at the CMDB Instance API under `cmdb_ci`.
- A relation's `type.link` points at the Table API.

**Seed data.** Seed the documented relation-type sys_ids for parity:

| sys_id | Relation type |
|---|---|
| `1a9cb166f1571100a92eb60da2bce5c5` | `Depends on::Used by` |
| `607ad1b2c0a8010e01941856b365af90` | `Exchanges data with::Exchanges data with` |
| `60bc4e22c0a8010e01f074cbe6bd73c3` | `Runs on::Runs` |

## 8. CMDB Meta API

Source: R9. **[Documented]**

**Role and statuses:**
- Role: `itil`.
- Statuses: 200, 401, 404 (unknown class), 500.

| Method | Path | Params |
|---|---|---|
| GET | `/api/now/cmdb/meta/{className}` (versioned `/api/now/{v}/cmdb/meta/{className}`) | none |

**Response fields:**

| Field | Contents |
|---|---|
| `name` | Class name |
| `label` | Class label |
| `parent` | Parent class |
| `children` | Array of direct subclass names |
| `icon` | sys_id |
| `icon_url` | Icon URL |
| `is_extendable` | JSON boolean |
| `attributes[]` | One entry per column (see below) |
| `relationship_rules[]` | `{"parent","relation_type","child"}` |
| `identification_rules` | `{"name","description","active","is_independent","applies_to","identifiers":[...],"related_rules":[...]}` |

Each `attributes[]` entry is `{"element","label","type","max_length","is_mandatory","is_read_only","is_inherited","is_display","default_value"}`:
- the flags and `max_length` are **strings**, for example `"false"` and `"40"`;
- `default_value` may be JSON `null`.

Identifier and related-rule entries carry `condition` (an encoded query such as `install_status!=100^EQ`), `exact_count_match`, `referenced_field`, `active`, `attributes` (a comma list), `allow_fallback`, `table`, `order` (a number) and `allow_null_attribute`. The boolean keys are JSON booleans.

**Example:**

```json
{"result":{"name":"cmdb_ci_linux_server","label":"Linux Server","parent":"cmdb_ci_server","children":[],
  "is_extendable":true,"icon":"","icon_url":"images/app.ngbsm/server.svg",
  "attributes":[{"element":"kernel_release","label":"Kernel release","type":"string","max_length":"40",
    "is_mandatory":"false","is_read_only":"false","is_inherited":"false","is_display":"false","default_value":null}],
  "relationship_rules":[],"identification_rules":{"name":"Hardware Rule","active":true,"is_independent":true,
    "applies_to":"cmdb_ci_hardware","identifiers":[],"related_rules":[]}}}
```

## 9. Knowledge Management API

Source: R10. **[Documented]** unless marked.

**Namespace and access:**
- Namespace `sn_km_api` (Knowledge API plugin).
- Public by default. An admin can require authentication per endpoint.
- Default rate limit: 500 requests per hour for unauthenticated callers and `snc_external` users.
- Statuses:
  - lists and GET `{id}`: 200, 401, 500;
  - attachment download: 200, 401, 404, 500.
- ResolvrNow returns 404 for an unknown article. **[Inferred]**

### 9.1 Endpoints

| Method | Path (versioned `/api/sn_km_api/{v}/knowledge/articles...`) | Purpose |
|---|---|---|
| GET | `/api/sn_km_api/knowledge/articles` | Search and filter |
| GET | `/api/sn_km_api/knowledge/articles/featured` | Featured plus most-viewed |
| GET | `/api/sn_km_api/knowledge/articles/most_viewed` | By view count |
| GET | `/api/sn_km_api/knowledge/articles/{id}` | One article (sys_id or KB number) |
| GET | `/api/sn_km_api/knowledge/articles/{article_sys_id}/attachments/{attachment_sys_id}` | File bytes with the stored Content-Type |

### 9.2 Parameters

These names are **not** `sysparm_*`.

| Name | Endpoints | Type | Default | Meaning |
|---|---|---|---|---|
| `query` | list | string | none | Free-text search, ranked; snippets highlight matches with `<B>` |
| `filter` | list | string | `""` | Encoded query on `kb_knowledge` |
| `fields` | all lists, `{id}` | string | none | Columns echoed in `fields`. Accept both repeated and comma forms. |
| `kb` | lists | string | none | Comma list of knowledge base sys_ids |
| `language` | lists | string | session language, else `en` | ISO 639-1 comma list, or `all` |
| `limit` | lists | number | **30** | Page size |
| `offset` | lists | number | 0 | First row |
| `language` | `{id}` | string | none | Translation; only when `{id}` is a KB number |
| `search_id`, `search_rank` | `{id}` | string, number | none | Record a view tied to a search (send both) |
| `update_view` | `{id}` | flag | absent | Its presence alone records a view. Ignored when `search_id` and `search_rank` are sent. |

### 9.3 Responses

**List shape:**

```json
{"result":{
  "meta":{"start":0,"end":30,"count":2,"fields":"short_description","query":"vpn","filter":"","kb":"","language":"en",
          "ts_query_id":"4c5d6e7f8091a2b3c4d5e6f708192a3b","status":{"code":200}},
  "articles":[{"id":"kb_knowledge:6e7f8091a2b3c4d5e6f708192a3b4c5d","number":"KB0010007","title":"Connect to the VPN",
    "snippet":"Install the <B>VPN</B> client ...","link":"?sys_kb_id=6e7f8091a2b3c4d5e6f708192a3b4c5d&id=kb_article_view&sysparm_rank=1&sysparm_tsqueryId=4c5d...",
    "rank":1,"score":14.87,
    "fields":{"short_description":{"display_value":"Connect to the VPN","value":"Connect to the VPN","name":"short_description","label":"Short description","type":"string"}}}]}}
```

Rules for the list shape:
- `meta.count` is the total number of matches.
- `meta.end` = start + limit, and is not clamped to the number of rows returned.
- `id` carries the `kb_knowledge:` prefix.
- `rank` is absent on featured and most_viewed.
- `score` is the relevance on search, `-1` on featured, and the view count on most_viewed.

**most_viewed** uses this built-in filter:

```
workflow_state=published^valid_to>=javascript:gs.beginningOfToday()^active=true^sys_class_name!=kb_knowledge_block^sys_view_count>0^ORDERBYDESCsys_view_count^ORDERBYshort_description
```

**`{id}` response:**

```json
{"result":{"sys_id":"...","number":"KB0010007","short_description":"...","content":"<p>...</p>",
  "template":false,"display_attachments":true,
  "attachments":[{"sys_id":"...","file_name":"vpn.png","size_bytes":"20480","state":"available"}],
  "embedded_content":[],"language":"en","languages":[{"label":"English","language":"en","sys_id":"..."}],"fields":{}}}
```

- `attachments[].state` is one of `available`, `available_conditionally`, `not_available`, `pending`.
- `template_table` is present only when `template` is true.

## 10. Service Catalog API

Source: R11. **[Documented]** unless marked.

**Namespace and roles:**
- Namespace `sn_sc`, API `servicecatalog`.
- No baseline role; visibility follows catalog, category and item access.
- `admin` or `catalog_admin` may empty another user's cart.

**Cart model.** The cart, the wish list and checkout belong to the authenticated user. Each user has one current cart. **[Inferred]** The records involved are:
- `sc_cart` and `sc_cart_item` for the cart;
- `sc_request` and `sc_req_item` for the order.

### 10.1 Endpoints

All paths are under `/api/sn_sc/servicecatalog`; the versioned form is `/api/sn_sc/{v}/servicecatalog`.

| Method | Path | Purpose | Success | Other documented |
|---|---|---|---|---|
| GET | `/cart` | Current cart, grouped into frequency buckets (`none`, `daily`, `monthly`, `yearly`) with totals | 200 | 400, 401, 500 |
| PUT | `/cart/{cart_item_id}` | Change a line: body `{"sysparm_quantity":"2","variables":{}}` | **201** | 400, 401, 500 |
| DELETE | `/cart/{cart_item_id}` | Remove a line | 204 | 400, 401, 500 |
| DELETE | `/cart/{sys_id}/empty` | Empty and delete a cart | 204 | 400, 401, 500 |
| GET | `/cart/delivery_address/{user_id}` | Address as a single string with `\n` breaks | 200 | 400, 401, 500 |
| POST | `/cart/checkout` | One-step: places the order. Two-step: returns a review summary. | 200 | 400, 401, 500 |
| POST | `/cart/submit_order` | Places the order (the second step) | 200 | 400, 401, 500 |
| GET | `/catalogs` | Catalogs the user can see | 200 | 401, 500 |
| GET | `/catalogs/{sys_id}` | One catalog with categories | 200 | 400, 401, 500 |
| GET | `/catalogs/{sys_id}/categories` | Categories of a catalog | 200 | 400, 401, 500 |
| GET | `/categories/{sys_id}` | One category with child categories | 200 | 400, 401, 500 |
| GET | `/items` | Search or list items | 200 | 401, 500 |
| GET | `/items/{sys_id}` | Item definition: price, variables, client scripts, UI policies | 200 | 400, 401, 500 |
| POST | `/items/{sys_id}/add_to_cart` | Add an item to the cart | 200 | 400, 401, 500 |
| POST | `/items/{sys_id}/order_now` | Order immediately | 200 | 400, 401, 500 |
| POST | `/items/{sys_id}/submit_producer` | Run a record producer | 200 | 400, 401, 404, 500 |
| PUT | `/items/{sys_id}/submit_guide` | Evaluate an order guide; returns the selected items | 200 | 400, 401, 500 |
| POST | `/items/{sys_id}/checkout_guide` | Submit order-guide items | 200 | 400, 401, 500 |
| POST | `/items/{sys_id}/add_to_wishlist` | Save an item to the wish list | 200 | 400, 401, 500 |
| GET | `/wishlist` | Wish list | 200 | 401, 500 |
| GET | `/wishlist/{cart_item_id}` | One wish-list line | 200 | 401, 404, 500 |
| GET | `/items/{item_sys_id}/delegation/{user_sys_id}` | Can this item be requested for that user | 200 | 401, 500 |
| POST | `/items/{item_sys_id}/get_invalid_delegated_users` | Users that cannot be requested for | 200 | 400, 401, 500 |
| POST | `/variables/{sys_id}/display_value` | Display value of a reference variable | 200 | 401, 404, 500 |

### 10.2 Parameters

| Name | Where | Type | Default | Meaning |
|---|---|---|---|---|
| `sysparm_limit` | `/catalogs`, `/catalogs/{id}/categories`, `/items` (query) | number | **10000** | Page size, applied before access filtering |
| `sysparm_offset` | `/catalogs/{id}/categories`, `/items` (query) | number | 0 | Not available on `/catalogs` |
| `sysparm_text` | `/catalogs` (title), `/items` (query) | string | none | Search text |
| `sysparm_view` | catalog, category and item reads; `submit_producer` (query) | string | none | `desktop`, `mobile` or `both` |
| `sysparm_catalog`, `sysparm_category` | `/items` (query) | string | none | Scope to a catalog or category |
| `sysparm_type` | `/items` (query) | string | none | `Record Producer` or `Order Guide`; other values are ignored |
| `sysparm_top_level_only` | `/catalogs/{id}/categories` (query) | boolean | not stated (ResolvrNow: false) | Direct children of the catalog only |
| `sysparm_quantity` | add_to_cart and order_now (body, required); cart PUT (body, required); checkout_guide `items[]` (default "1") | number or string | see left | Must not be negative |
| `sysparm_requested_for` | add_to_cart, order_now (body) | string | caller | A sys_user sys_id. Allowed only with a role from `glide.sc.req_for.roles`; if that property is empty, `glide.sc.req_for.roles.default` (`allow` or `deny`) decides. |
| `sysparm_also_request_for` | add_to_cart, order_now, get_invalid_delegated_users (body) | string | none | Comma list, at most 50. One invalid user rejects the whole call. |
| `variables` | add_to_cart, order_now, cart PUT, submit_producer, submit_guide, checkout_guide (body) | object | none | Keyed by variable **name**. Values are strings. Mandatory variables must be present. |
| `sysparm_value` | `/variables/{id}/display_value` (body) | string | none | sys_id of the referenced record |

### 10.3 Responses and formats

**Wrapper.** Always `{"result": ...}`. The result can be an object, an array, or a bare string (`delivery_address`, `display_value`). The delegation check is nested: `{"result":{"result":true}}`.

**Order results:**
- `order_now` returns `{"sys_id","number","request_id","request_number","table":"sc_request"}`.
- `submit_order` returns `{"request_number","request_id"}`.
- Both add `parent_id` and `parent_table` when the request was created from a parent record.

**Producer results.** `submit_producer` returns:

```json
{"sys_id","number","table","record":"api/now/table/<table>/<sys_id>","redirect_url","redirect_portal_url","redirect_to","parent_id","parent_table"}
```

**Money and numbers:**
- Money is a preformatted string, for example `"$1,598.00"`. Currency codes are separate fields (`price_currency`, `"USD"`).
- In cart lines, `quantity` is a string, while `subtotal` and `recurring_subtotal` are JSON numbers.
- Price keys are omitted, not null, when `show_price` is false.

**Variables in output.** Cart, wish-list and checkout_guide lines key `variables` by the variable **label**. Item definitions return `variables` as an array of definitions (`id, name, label, type, friendly_type, mandatory, ...`).

**Exact 400 labels.** These apply to add_to_cart and cart PUT; clients may match on them:
- `Invalid quantity value`
- `Security constraints prevent ordering of Item`
- `Mandatory Variables are required`

**get_invalid_delegated_users failure.** The body is `{"result":{"errCode":"42202","errMsg":"This item cannot be submitted for multiple people as it is not configured with Requested For"}}`. On success the result is `{"result":{"invalidUsers":["<display names>"]}}`.

**Status mapping quirks:**
- Single-record reads return **400**, not 404, for an unknown id or no access.
- The exceptions return 404: `wishlist/{id}`, `submit_producer` and `display_value`.

**Paging.** No `Link` or `X-Total-Count` headers are documented. ResolvrNow may add them as harmless extras. **[Inferred]**

**Unclear checkout mode.** The page states the `checkout_guide` two-step behavior in reverse compared with `cart/checkout`. ResolvrNow follows `cart/checkout`:
- one-step mode places the order;
- two-step mode returns a summary.

This needs to be verified. **[Inferred]**

**Example (order now):**

```
POST /api/sn_sc/servicecatalog/items/04b7e94b4f7b4200086eeed18110c7fd/order_now
Content-Type: application/json

{"sysparm_quantity":"1","variables":{"replacement":"true","originalnumber":"555-0100"}}
```

```json
{"result":{"sys_id":"8f9e0d1c2b3a49586776a5b4c3d2e1f0","number":"REQ0010031","request_id":"8f9e0d1c2b3a49586776a5b4c3d2e1f0",
  "request_number":"REQ0010031","table":"sc_request"}}
```

## 11. Change Management API

Source: R12. **[Documented]** unless marked.

**Namespace and versions:**
- Namespace `sn_chg_rest`.
- ResolvrNow implements `v1` and routes the unversioned path to it.

**Roles:**

| Methods | Roles (any one of) |
|---|---|
| GET | `change_manager`, `itil`, `sn_change_read`, `admin` |
| POST, PATCH | `change_manager`, `itil`, `admin` |
| DELETE | `change_manager`, `admin` |
| The three scheduling endpoints | `sn_change_writer` |

### 11.1 Endpoints

Paths below are relative to `/api/sn_chg_rest/change`; the versioned form is `/api/sn_chg_rest/{v}/change`.

**Change requests, generic and by type**

| Method | Path | Purpose | Success | Other documented |
|---|---|---|---|---|
| GET | (base path) | List changes of any type | 200 | 401, 500 |
| GET | `/{sys_id}` | Read one change | 200 | 400, 401, 404, 500 |
| POST | (base path) | Create from `chg_model` and/or `type` | **200** | 400, 401, 404, 500 |
| PATCH | `/{sys_id}` | Update | 200 | 400, 401, 404, 500 |
| DELETE | `/{sys_id}` | Delete; returns the record as it was before deletion | **200** | 400, 401, 404, 500 |
| GET | `/{change_sys_id}/nextstates` | Allowed next states and transitions | 200 | 404 |
| GET, POST | `/normal`, `/emergency` | List; create from the type's default record | 200 | 400 (POST), 401, 500 |
| GET, PATCH, DELETE | `/normal/{sys_id}`, `/emergency/{sys_id}` | Read, update, delete by type | 200 | 400, 401, 404, 500 |
| GET | `/standard` | List standard changes | 200 | 401, 500 |
| POST | `/standard/{standard_change_template_id}` | Create from a published template | 200 | 400, 401, 404, 500 |
| GET, PATCH, DELETE | `/standard/{sys_id}` | Read, update, delete | 200 | 400, 401, 404, 500 |
| GET | `/standard/template`, `/standard/template/{sys_id}` | Standard change templates | 200 | 400, 401, 404, 500 |

**Risk and approvals**

| Method | Path | Purpose | Success | Other documented |
|---|---|---|---|---|
| PATCH | `/{sys_id}/risk` (ResolvrNow also serves `/standard/{sys_id}/risk`) | Calculate risk and impact | 200 | 400, 401, 404, 500 |
| PATCH | `/{sys_id}/approvals` (ResolvrNow also accepts POST) | Approve or reject: body `{"state":"approved\|rejected","comments":"..."}`. `comments` is required when rejecting. | 200 | 400, 401, 500 |

**Change tasks**

| Method | Path | Purpose | Success | Other documented |
|---|---|---|---|---|
| GET, POST | `/{change_sys_id}/task` | List or create change tasks | 200 | 400, 401, 404, 500 |
| PATCH, DELETE | `/{change_sys_id}/task/{task_sys_id}` | Update or delete a task; the task must belong to the change | 200 | 400, 401, 404, 500 |

**CI associations, conflicts and scheduling**

| Method | Path | Purpose | Success | Other documented |
|---|---|---|---|---|
| GET | `/{sys_id}/ci?association_type=affected\|impacted\|offering` | Associated CIs, services or offerings | 200 | 400, 401, 500 |
| POST | `/{sys_id}/ci` | Associate CIs (asynchronous) | **202** | 400, 401, 404, 500 |
| POST | `/{sys_id}/refresh_impacted_services` | Rebuild impacted services (asynchronous) | 200 | 401, 404, 500 |
| POST | `/{sys_id}/conflict` | Start a conflict check; result is a process id string | 200 | 400, 401, 404, 500 |
| GET | `/{sys_id}/conflict` | Status and conflicts of the last run | 200 | 400, 401, 404, 500 |
| DELETE | `/{sys_id}/conflict` | Cancel a running check (empty body) | 200 | 400, 401, 404, 500 |
| GET | `/ci/{cmdb_ci_sys_id}/schedule?duration_in_seconds=..&planned_start_time=..` | Free slots for a CI | **202** | 400 |
| GET | `/{change_sys_id}/schedule` | Free slots for a change | **202** | 400, 404 |
| PATCH | `/{change_sys_id}/schedule/first_available` | Move the change to the first free slot | **202** | 400, 403, 404 |
| GET | `/worker/{sys_id}` | Poll an asynchronous worker | 200 | 401, 404, 500 |

**Change models**

| Method | Path | Purpose | Success | Other documented |
|---|---|---|---|---|
| GET | `/model`, `/model/{sys_id}` | Change models | 200 | 400, 401, 404, 500 |

### 11.2 Parameters (list endpoints)

| Name | Type | Default | Meaning |
|---|---|---|---|
| `sysparm_query` | string | none | Encoded query |
| `<column>=<value>` | string | none | Equality filter; labels accepted; cannot be combined with `sysparm_query` |
| `sysparm_limit` | number | 500 | Page size. Not listed for `GET /change` and `/model`; ResolvrNow defaults those to 500. **[Inferred]** |
| `sysparm_offset` | number | 0 | First row |
| `order` | string | `name` (generic and `/model`), `number` (emergency), `Number` (template), none (others) | Sort column, ascending |
| `textSearch` | string | none | Full-text search. The doc's "default" `IR_AND_OR_QUERY` is the name of the search mode, not a value. |
| `association_type` | string | required | `/ci` only |

On POST and PATCH, `<column>=<value>` query parameters and JSON body keys both set fields; the body wins. `encrypted_fields` (a comma list) sets the listed columns by display value.

### 11.3 Record format ("REC")

**Every column is a pair.**
- `{"value": <raw>, "display_value": "<text>"}`, with no `link`.
- Date-time columns add `display_value_internal`.
- Empty columns are `""` in both members.
- Booleans are JSON `true`/`false` in `value`. Integers and integer choices are JSON numbers.
- **[Documented samples]** The samples disagree on numeric `state.value` versus string. ResolvrNow emits numbers. **[Inferred, verify]**

**Ignored inputs.** Writes report dropped inputs in `"__meta": {"ignoredFields": ["no_such_field"]}` inside `result`. Inputs are dropped when they are unknown, read-only, or set by rules.

**State values.**
- The `change_request.state` values seen are -5 New, -4 Assess, -2 Scheduled, -1 Implement, 0 Review, 3 Closed, 4 Canceled.
- Creates start at -5.

**Worker body:**

```json
{"result":{"worker":{"sysId":"<id>","link":"https://resolvr.example.com/api/sn_chg_rest/change/worker/<id>"},
  "request":"<original request as a JSON string>","state":{"value":1,"display_value":"Waiting"},
  "type":"affected","messages":{"errorMessages":[],"warningMessages":[],"infoMessages":[]}}}
```

Worker rules:
- Worker states: 1 Waiting and 3 Complete are documented; 2 In-Progress and 4 Error are **[Inferred]**.
- Schedule workers add `payload.spans[] = {"start":{"value","display_value"},"end":{...}}`.
- Exact message strings: `Invalid CMDB_CI sys_id provided`, `CMDB_CI sys_id already associated to provided.`, `Change has been updated`, `No slots found for <n> days from now`.
- The scheduling window comes from `change.conflict.next_available.schedule_window`, default 90 days.

**Error body.** The scheduling endpoints add a `status` member inside `error`:

```json
{"error":{"message","detail","status"},"status":"failure"}
```

**Example (create a normal change):**

```
POST /api/sn_chg_rest/change/normal?short_description=Rotate%20TLS%20certs&no_such_field=x
```

```json
{"result":{"sys_id":{"value":"6a7b8c9d0e1f20314253647586970a1b","display_value":"6a7b8c9d0e1f20314253647586970a1b"},
  "number":{"value":"CHG0030044","display_value":"CHG0030044"},"type":{"value":"normal","display_value":"Normal"},
  "state":{"value":-5,"display_value":"New"},"short_description":{"value":"Rotate TLS certs","display_value":"Rotate TLS certs"},
  "start_date":{"value":"","display_value":"","display_value_internal":""},
  "__meta":{"ignoredFields":["no_such_field"]}}}
```

## 12. Email API

Source: R13. **[Documented]** unless marked.

**Roles:**
- `email_api_send` to send.
- Read and write on `sys_email`.

### 12.1 Endpoints

| Method | Path | Params | Success | Other documented |
|---|---|---|---|---|
| GET | `/api/now/{v}/email/{id}` (ResolvrNow also serves `/api/now/email/{id}`) | `sysparm_fields` (comma list) | 200 | 401, **403** (not found or no access), 500 |
| POST | `/api/now/{v}/email` (ResolvrNow also serves `/api/now/email`) | none | **200** | 400, 401, 403, 500 |

### 12.2 Bodies

**POST request:**

| Field | Type | Maps to | Notes |
|---|---|---|---|
| `to` | array | `recipients` | Required. At most 100. Entries may be `Name <addr>`. |
| `cc`, `bcc` | array | `copied`, `blind_copied` | At most 100 each |
| `subject` | string | `subject` | |
| `text` | string | `body_text` | |
| `html` | string | `body` | |
| `importance` | string | `importance` | |
| `headers` | object | message headers | |
| `table_name`, `table_record_id` | string | target record | Must be supplied together |

**POST response:**

```json
{"result":{"id":"<sys_email sys_id>","links":[{"rel":"self","href":"/now/v1/email/<id>"},
  {"rel":"status","href":"/now/v1/email/<id>?sysparm_fields=id,type,state,error"}]}}
```

The `href` values are relative and have **no** `/api` prefix, as in the sample.

**GET response:** `{"result":{"id","to":[..],"cc":[..],"bcc":[..],"subject","text","html","importance","headers":{},"type","state"}}`.
- Empty `cc` and `bcc` lists come back as `[""]` in the sample.
- `type` is one of `received`, `received-ignored`, `send-failed`, `send-ignored`, `send-ready`, `sent`.
- `state` is one of `error`, `ignored`, `processed`, `ready`.

## 13. Account and User Role Inheritance APIs

### 13.1 Account API

Source: R14. **[Documented]**

**Role and plugin:**
- Role: `csm_ws_integration`.
- Plugin: Case Management Core.
- Table: `customer_account`.

| Method | Path (versioned `/api/now/{v}/account...`) | Params | Statuses |
|---|---|---|---|
| GET | `/api/now/account` | `sysparm_query`, `sysparm_limit` (default **10**), `sysparm_offset` (0) | 200, 500 |
| GET | `/api/now/account/{id}` | none | 200, 404 |

**Record format:**
- Records are flat: every value is a string, and references are bare sys_id strings with no link object.
- `number` looks like `ACCT0000003`.

**`hasMore` flag.** The page mentions a boolean `hasMore` but does not say where it goes. ResolvrNow adds the top-level key `"hasMore"` next to `result`, and also emits `Link` and `X-Total-Count`. **[Inferred]**

### 13.2 User Role Inheritance API

Source: R15. **[Documented]**

**Role and plugin:**
- Role: `user_admin`.
- Plugin: Contextual Security, Role Management V2 REST API.

| Method | Path | Params | Statuses |
|---|---|---|---|
| GET | `/api/global/user_role_inheritance` (versioned `/api/global/{v}/user_role_inheritance`) | `user_sysid` (required) | 200, 400, 401, 404, 500 |

**Response:**

```json
{"result":{"user_name":"abel.tuter","from_role":["/itil","/itil/sn_change_read"],"from_group":["[Network]/itil"]}}
```

How the paths are built:
- A role held directly is `/<role>`.
- A role contained in another role extends the path one segment per level.
- A role that comes from a group is prefixed with `[<group name>]`.

ResolvrNow status mapping:
- A missing `user_sysid` returns 400. **[Inferred]**
- An unknown user returns 404. **[Inferred]**

## 14. Acceptance tests

Conventions:
- Each row is one automated check.
- Unless stated, requests use Basic auth as `admin` against a seeded instance:
  - incident (TPH `task` table): at least 3 active incidents (`INC0010001` to `INC0010003`);
  - user `abel.tuter`;
  - group `Network`.
- "Basis" says whether the expected behavior is Documented, or Inferred (verify against a live instance before treating a failure as a ResolvrNow bug).

| Id | Given | When | Then | Basis |
|---|---|---|---|---|
| AT-01 | 3 or more incidents | `GET /api/now/table/incident?sysparm_limit=1` | 200; `result` is an array of length 1; `X-Total-Count` equals the incident count; `Link` contains `rel="first"`, `rel="next"` and `rel="last"` and no `rel="prev"` | Documented (headers); Inferred (rel set) |
| AT-02 | as AT-01 | `...?sysparm_limit=1&sysparm_offset=1` | `Link` contains `rel="prev"` whose URL has `sysparm_offset=0` | Inferred |
| AT-03 | as AT-01 | add `sysparm_suppress_pagination_header=true` | No `Link` header | Documented |
| AT-04 | as AT-01 | add `sysparm_no_count=true` | No `X-Total-Count` header; body unchanged | Inferred |
| AT-05 | any | `GET /api/now/table/incident?sysparm_query=number=NOPE` | 200 and body exactly `{"result":[]}` | Documented |
| AT-06 | any | `GET /api/now/v1/table/incident?sysparm_query=number=NOPE` | 404 | Documented |
| AT-07 | any | `GET /api/now/table/incident/ffffffffffffffffffffffffffffffff` | 404; body has `error.message` and `"status":"failure"` | Documented (status); Inferred (text) |
| AT-08 | incident with a caller | GET it | `caller_id` is `{"link","value"}`; `link` ends with `/api/now/table/sys_user/<value>` | Documented |
| AT-09 | as AT-08 | add `sysparm_exclude_reference_link=true` | `caller_id` is a plain 32-hex string | Documented (param); Inferred (shape) |
| AT-10 | as AT-08 | add `sysparm_display_value=true` | `state` is a label (e.g. `New`); `caller_id` is `{"display_value","link"}` | Documented |
| AT-11 | as AT-08 | add `sysparm_display_value=all` | every field is an object with `display_value` and `value`; `caller_id` also has `link` | Documented (all); Inferred (link) |
| AT-12 | any | `GET ...incident?sysparm_fields=number,caller_id.name&sysparm_limit=1` | each result object has exactly the keys `number` and `caller_id.name` | Documented |
| AT-13 | any | `sysparm_fields=number,not_a_field` | 200; only `number` returned | Documented |
| AT-14 | any incident | GET it (default) | `active` is `"true"` or `"false"` (string); `priority` is a numeric string; no JSON numbers or booleans anywhere | Documented |
| AT-15 | incident with empty `parent` | GET it | `"parent": ""` (empty string, not null or object) | Documented |
| AT-16 | any incident | GET it | `opened_at` matches `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$` and equals the stored UTC value | Documented |
| AT-17 | incident with `business_duration` of 3,723,000 ms | GET it | `business_duration` is `"1970-01-01 01:02:03"` | Documented (format) |
| AT-18 | none | `POST /api/now/table/incident` `{"short_description":"x"}` | 201; `Location` is an absolute URL ending with `/api/now/table/incident/<sys_id>`; `result.sys_id` matches `^[0-9a-f]{32}$`; `result.number` starts with `INC` | Documented |
| AT-19 | none | POST with body `{'short_description':'single quoted'}` | 201; field stored | Documented (sample) |
| AT-20 | none | POST with header `X-no-response-body: true` | 201; empty body | Documented (header); Inferred (status) |
| AT-21 | none | POST `{"short_description":"x","no_such_field":"y"}` | 201; record created; unknown field ignored | Inferred |
| AT-22 | incident with urgency 3 | `PATCH .../incident/{id}` `{"urgency":"1"}` | 200; `result.urgency` is `"1"`; `short_description` unchanged | Documented |
| AT-23 | incident with a description | `PUT .../incident/{id}` `{"urgency":"2"}` | 200; description unchanged (PUT is partial) | Inferred |
| AT-24 | incident with a description | PATCH `{"description":""}` | 200; description now `""` | Documented |
| AT-25 | user Abel Tuter | POST incident `?sysparm_input_display_value=true` with `{"caller_id":"Abel Tuter"}` | `caller_id.value` is Abel's sys_id | Documented |
| AT-26 | an incident | `DELETE .../incident/{id}`, then GET it | DELETE returns 204 with empty body; GET returns 404 | Documented |
| AT-27 | no credentials | `GET /api/now/table/incident` | 401; `error.message` is `User Not Authenticated` | Documented strings; Inferred pairing |
| AT-28 | any | `GET /api/now/table/no_such_table` | 400 with the error envelope | Inferred |
| AT-29 | any | GET with `Accept: application/xml` | XML whose root is `<response>` and whose records are `<result>` elements | Documented |
| AT-30 | any | GET with `Accept: text/csv` | 406 | Documented |
| AT-31 | none | POST with `Content-Type: text/plain` and a non-JSON body | 415 | Documented |
| AT-32 | as AT-01 | `HEAD /api/now/table/incident?sysparm_limit=1` | 200; same `X-Total-Count` as GET; empty body | Documented |
| AT-33 | an incident | `POST .../incident/{id}` with `X-HTTP-Method-Override: PATCH` and `{"urgency":"1"}` | 200; record updated | Documented |
| AT-34 | 1 incident and 1 problem | `GET /api/now/table/task?sysparm_query=sys_class_name=incident` | only incidents; each row's `sys_class_name` is `incident` | Inferred |
| AT-35 | any | `sysparm_query=bogus_field=1^active=true` | same rows as `sysparm_query=active=true` | Documented |
| AT-36 | 3 incidents | `sysparm_query=ORDERBYDESCnumber` | numbers in strictly descending order | Documented |
| AT-37 | any | `GET ...incident?active=true&priority=1` | same rows as `sysparm_query=active=true^priority=1` | Documented |
| AT-38 | any | `GET ...incident?sysparm_query=caller_id=javascript:gs.getUserID()` as abel.tuter | only incidents whose caller is abel.tuter | Documented |
| AT-39 | incidents exist | `GET /api/now/stats/incident?sysparm_count=true` | 200; `result.stats.count` is a decimal string equal to the row count | Documented (param); Inferred (shape) |
| AT-40 | incidents with priorities 1 and 3 | `...stats/incident?sysparm_count=true&sysparm_group_by=priority` | `result` is an array; each item has `groupby_fields[0].field == "priority"` and `stats.count` | Documented |
| AT-41 | any | `...stats/incident?sysparm_avg_fields=reassignment_count` | `stats.avg.reassignment_count` matches `^-?\d+\.\d{4}$` | Documented (sample) |
| AT-42 | an incident | `POST /api/now/attachment/file?table_name=incident&table_sys_id=<id>&file_name=a.txt`, `Content-Type: text/plain`, body `hello` | 201; `Location` set; `result.size_bytes` is `"5"`; `result.download_link` ends with `/file` | Documented |
| AT-43 | AT-42 done | `GET /api/now/attachment/<att>/file` | 200; body `hello`; `Content-Type: text/plain`; header `X-Attachment-Metadata` present | Documented |
| AT-44 | an incident | `POST /api/now/attachment/upload` multipart with `table_name`, `table_sys_id`, then the file part last | 201; metadata `table_sys_id` matches | Documented |
| AT-45 | an incident | POST `/api/now/attachment/file` without `table_sys_id` | 400 | Documented |
| AT-46 | AT-42 done | `GET /api/now/attachment?sysparm_query=table_sys_id=<id>` | `result` contains the attachment; values are plain strings | Documented |
| AT-47 | AT-42 done | `PATCH /api/now/attachment/<att>` `{"file_name":"b.txt"}`, then GET its metadata | 204, then `file_name` is `b.txt` | Documented |
| AT-48 | AT-42 done | `DELETE /api/now/attachment/<att>`, then GET its metadata | 204, then 404 | Documented |
| AT-49 | any | `POST /api/now/v1/batch` with a GET item and a POST item (base64 body) | 200; no `result` wrapper; 2 `serviced_requests` with matching ids and `status_code` 200 and 201; bodies decode to JSON with `result` | Documented |
| AT-50 | as AT-49 | item with `exclude_response_headers: true` | that item's `headers` is `[]` | Documented |
| AT-51 | staging table `u_imp_user` with transform to `sys_user` | `POST /api/now/import/u_imp_user` `{"u_name":"Lena Ortiz"}` | 201; top-level `import_set` and `staging_table`; `result[0].status` is `inserted`; `record_link` is a Table API URL | Documented |
| AT-52 | itil user | `POST /api/sn_chg_rest/change/normal?short_description=Patch` | 200; `result.type.value` is `normal`; `result.state.display_value` is `New`; every field is a `{value, display_value}` pair | Documented |
| AT-53 | as AT-52 | add `&no_such_field=1` | `result.__meta.ignoredFields` contains `no_such_field` | Documented |
| AT-54 | a change and a CI | `POST /api/sn_chg_rest/change/<id>/ci` `{"association_type":"affected","cmdb_ci_sys_ids":"<ci>"}`, then `GET .../change/worker/<sysId>` | 202 with `result.worker.sysId`; the poll returns 200 with `result.state.value` in {1,2,3,4} | Documented |
| AT-55 | user with only `sn_change_read` | `DELETE /api/sn_chg_rest/change/<id>` | 403 | Documented (roles); Inferred (code) |
| AT-56 | CMDB seeded | `GET /api/now/cmdb/meta/cmdb_ci_computer` | 200; `result.parent` is `cmdb_ci_hardware`; `attributes[]` entries have string flags such as `"false"` | Documented |
| AT-57 | Linux servers exist | `GET /api/now/cmdb/instance/cmdb_ci_linux_server` | 200; every element has exactly `sys_id` and `name` | Documented |
| AT-58 | any | `POST /api/now/cmdb/instance/cmdb_ci_linux_server` `{"attributes":{"name":"x"}}` (no `source`) | 400 | Documented (required); Inferred (code) |
| AT-59 | published articles | `GET /api/sn_km_api/knowledge/articles?query=vpn&limit=5` | 200; `result.meta.status.code` is 200; `result.meta.count` >= `result.articles.length`; `articles[0].id` starts with `kb_knowledge:` | Documented |
| AT-60 | item with a mandatory variable | `POST /api/sn_sc/servicecatalog/items/<id>/add_to_cart` `{"sysparm_quantity":1}` | 400; message `Mandatory Variables are required` | Documented |
| AT-61 | orderable item | `POST .../items/<id>/order_now` `{"sysparm_quantity":"1"}` | 200; `result.request_number` matches `^REQ\d{7}$`; `result.table` is `sc_request` | Documented |
| AT-62 | user with `email_api_send` | `POST /api/now/email` `{"to":["a@example.com"],"subject":"s","text":"t"}` | 200; `result.id` is 32-hex; `result.links` has `rel` `self` and `status` | Documented |
| AT-63 | `user_admin` caller, abel has `itil` directly | `GET /api/global/user_role_inheritance?user_sysid=<abel>` | 200; `result.from_role` contains `/itil` | Documented |
| AT-64 | any | `GET /api/now/table/incident?sysparm_query=sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` | only incidents created today (user time zone) | Documented |
| AT-65 | any | send header `X-WantSessionDebugMessages: true` on a GET | body has `session.debug_logs` (array) next to `result` | Documented |
