# ResolvrNow spec: encoded query language (`sysparm_query`)

Status: draft 1 (2026-10-21). Audience: engineers working on `server/src/engine/query/` (parser, compiler, macros, matcher) and on every REST endpoint that accepts an encoded query.

Goal: a query string that a ServiceNow API client sends today must select the same rows in ResolvrNow, or ResolvrNow must fail in a predictable, documented way.

Companion documents:
- `docs/spec/rest-api.md`: where each API accepts a query.
- `docs/spec/data/rest-api.json`: machine-readable operator table (`operators[]`).

## 0. Conventions and sources

Every normative statement carries one of two tags:

- **[Documented]**: stated in the public product documentation for the section's cited URL. The text here is a paraphrase.
- **[Inferred]**: one of the following:
  - our reasoning;
  - platform behavior widely known to integrators but absent from the cited pages;
  - a ResolvrNow design decision.

  Items marked "verify" should be confirmed against a live instance before they are frozen.

In tables, a "Basis" column holds `Documented` or `Inferred` with the same meaning.

| Id | Source page | URL |
|---|---|---|
| S1 | Operators available for filters and queries | https://www.servicenow.com/docs/r/platform-user-interface/r_OpAvailableFiltersQueries.html |
| S2 | Encoded query strings | https://www.servicenow.com/docs/r/platform-user-interface/c_EncodedQueryStrings.html |
| S3 | Table API (`sysparm_query` parameter) | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html |
| S4 | REST API overview (custom parameters, dot-walking) | https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/c_RESTAPI.html |
| S5 | Values for date/time fields | https://www.servicenow.com/docs/r/platform-user-interface/c_ValuesForDateTimeFields.html |
| S6 | Comparing field values | https://www.servicenow.com/docs/r/platform-user-interface/r_ComparingFieldValues.html |
| S7 | Add related list conditions | https://www.servicenow.com/docs/r/platform-user-interface/create-related-list-query.html |
| S8 | OR conditions | https://www.servicenow.com/docs/r/platform-user-interface/c_UsingORConditions.html |
| S9 | Dynamic operators | https://www.servicenow.com/docs/r/platform-user-interface/r_UsingTheDynamicOperator.html |
| S10 | Dot-walking to data in related tables | https://www.servicenow.com/docs/r/platform-user-interface/c_DotWalking.html |
| S11 | JavaScript APIs supported by guarded script | https://www.servicenow.com/docs/r/api-reference/scripts/guarded-script-allowed-apis.html |
| S12 | Guarded script evaluator | https://www.servicenow.com/docs/r/api-reference/scripts/guarded-script.html |
| S13 | Filter on multiple string values | https://www.servicenow.com/docs/r/platform-user-interface/t_FilteringOnMultipleStringValues.html |
| S14 | Aggregate API | https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AggregateAPI.html |
| S15 | Using GlideRecord to query tables | https://www.servicenow.com/docs/r/api-reference/scripts/c_UsingGlideRecordToQueryTables.html |
| S16 | Filtering on empty fields | https://www.servicenow.com/docs/r/platform-user-interface/t_FilteringOnEmptyFields.html |
| S17 | The INSTANCEOF operator in reference qualifiers | https://www.servicenow.com/docs/r/platform-administration/c_UseTheINSTANCEOFOperator.html |
| S18 | Reporting properties (`glide.ui.filter.first_day_of_week`) | https://www.servicenow.com/docs/r/now-intelligence/reporting/reporting-properties.html |
| S19 | Agent Client Collector API (sample filter using `RELATIVELT@dayofweek`) | https://www.servicenow.com/docs/r/api-reference/rest-apis/agnt_clnt_cll-api.html |

## 1. Where encoded queries are accepted

| Surface | Parameter | Notes | Basis |
|---|---|---|---|
| Table API `GET /api/now/table/{table}` | `sysparm_query` | Full language. | Documented (S3) |
| Table API `GET` list | bare `field=value` URL parameters | Shorthand for equality conditions; cannot be combined with `sysparm_query`. Choice and reference fields also accept display values here, e.g. `state=closed`. | Documented (S3) |
| Aggregate API `GET /api/now/stats/{table}` | `sysparm_query`, bare `field=value` pairs | Full language. `sysparm_having` uses a different syntax (section 7.3). | Documented (S14) |
| Attachment API `GET /api/now/attachment` | `sysparm_query` | Evaluated against `sys_attachment`. ORDERBY is supported. | Documented (rest-api.md section 4) |
| CMDB Instance API list | `sysparm_query` | Evaluated against the CMDB class. | Documented (rest-api.md section 7) |
| Change Management API list endpoints | `sysparm_query` plus field=value pairs | Both are accepted. | Documented (rest-api.md section 11) |
| Import Set API | none | Dot-walking is explicitly unsupported there. | Documented (S4) |

**Decoding.** The parameter arrives URL-encoded. Decode it exactly once, using standard form decoding (`+` becomes a space, `%40` becomes `@`), and only then parse it. **[Inferred]**

## 2. Grammar and term recognition

### 2.1 Grammar

```
query      = block { "^NQ" block }                 ; top-level OR of blocks
block      = cluster { "^" cluster }               ; AND of clusters
cluster    = term { "^OR" term }                   ; OR of conditions
term       = condition | order | group | rlquery | "EQ"
condition  = field operator value
field      = path | "123TEXTQUERY321" | "123TEXTINDEXGROUP321"
path       = name { "." name }                     ; dot-walk, section 6
name       = 1*( a-z | 0-9 | "_" )
order      = ( "ORDERBY" | "ORDERBYDESC" ) path
group      = "GROUPBY" path
rlquery    = "RLQUERY" table "." path "," quantifier [ "," subquery ] "^ENDRLQUERY"
```

### 2.2 Precedence and connectors

| Token | Meaning | Precedence | Basis |
|---|---|---|---|
| `^` | AND | middle | Documented (S1, S3) |
| `^OR` | OR with the condition immediately before it. `a^b^ORc` is `a AND (b OR c)`. | tightest | Documented (S8 describes this "dependent OR" as A and (B or C)) |
| `^NQ` | starts a new top-level group. `a^b^NQc^d` is `(a AND b) OR (c AND d)`. | loosest | Documented (S1, S8) |
| `^EQ` | end marker emitted by the UI; carries no meaning | n/a | Inferred |
| `^^` | a literal `^` inside a value | n/a | Inferred (ResolvrNow already supports it) |

### 2.3 Term recognition algorithm

This is normative for ResolvrNow. Steps **[Inferred]** unless marked.

1. **Split.** Split on single `^` characters. Turn every `^^` back into a literal `^` inside the current term. Skip empty terms.
2. **Connectors.** If a term starts with `NQ`, close the current block and strip the prefix. If it then starts with `OR` immediately followed by a lowercase letter, digit, `_` or `123TEXTQUERY321`, it joins the previous cluster; strip the prefix. Field names are lowercase, so an uppercase `OR` can never be part of one.
3. **Prefixes.** Recognize `ORDERBYDESC`, `ORDERBY` and `GROUPBY` in that order.
4. **Related list.** `RLQUERY` opens a related-list subquery that runs up to the term `ENDRLQUERY` (section 9). This is not implemented yet.
5. **Field.** The field is the longest prefix matching `[a-z0-9_]+(\.[a-z0-9_]+)*`. The reserved names `123TEXTQUERY321` and `123TEXTINDEXGROUP321` are matched literally.
6. **Operator.** Take the longest operator token that matches immediately after the field (section 3). Scan the token list longest first: `IN_HIERARCHY_DYNAMIC` before `IN_HIERARCHY` before `INSTANCEOF` before `IN`; `ISNOTEMPTY` before `ISEMPTY`; `NSAMEAS` before `SAMEAS`; `NOTON` before `ON`; `NOT LIKE` and `NOT IN` before their parts; `!=` and `!*` before `*`.
7. **Value.** Everything after the operator is the value. It is not trimmed (except for IN lists, section 5.10).
8. **Failure.** If any step fails, the term is **invalid** (section 10).

## 3. Operator catalogue

Type-family codes in "Applies to": S string-like, CS choice with string values, CI choice with integer values, N numeric, B boolean, R reference, D date and date-time, T tags pseudo-field, X rule conditions only.

"ResolvrNow" is the status in the current code (`server/src/engine/query/*.ts`): OK (implemented), PARTIAL (implemented with a noted difference), IGNORED (parsed, then dropped as invalid), MISSING (not recognized), BUG (recognized, but with wrong semantics).

Sources: S1 for operators and labels, S15 for INSTANCEOF and the empty-field rule of DOES NOT CONTAIN, S17 for INSTANCEOF.

### 3.1 Comparison and range

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `=` | is | literal or `javascript:` macro | Equal. An empty value means "is empty" (Inferred). | all | Documented | OK |
| `!=` | is not | literal or macro | Not equal. Rows where the field is empty or NULL also match. | all | Documented (boolean table states NULL and empty match); Inferred for other types | OK |
| `>` `<` | greater than / less than; dates: after / before | literal or macro | Numeric order for N and CI, chronological for D, lexical for S | N, CI, D | Documented | OK |
| `>=` `<=` | greater than or is / less than or is; dates: at or after / at or before | literal or macro | Inclusive comparison. The S table shows `<=` and `>=`. S1 notes the condition builder hides them for integer fields; queries still accept them. | S, N, CI, D | Documented; Inferred (queries accept them on integers) | OK |
| `BETWEEN` | between | `low@high` | Inclusive on both ends | S, N, CI, D | Documented | OK |

### 3.2 String matching

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `LIKE` (alias `*`) | contains | substring | Substring match. On references it matches the display value. | S, CS, R | Documented | PARTIAL: alias `*` MISSING |
| `NOT LIKE` (alias `!*`) | does not contain | substring | Negated substring match. GlideRecord docs (S15) state that empty fields are **not** returned. | S, CS, R | Documented | PARTIAL: ResolvrNow returns NULL and empty rows; alias `!*` MISSING |
| `STARTSWITH` | starts with | prefix | Prefix match. On references it matches the display value. | S, CS, R | Documented | OK |
| `ENDSWITH` (alias `%`) | ends with | suffix | Suffix match | S, CS, R | Documented | PARTIAL: alias `%` MISSING |
| `IN` | is one of | `v1,v2,...` | Membership. Commas cannot be escaped (S13). | S, CS, CI, N, R (sys_ids) | Documented | OK |
| `NOT IN` | is not one of | `v1,v2,...` | Negated membership | S, CS, CI, N, R | Documented | OK; NULL and empty rows also match (Inferred) |

### 3.3 Emptiness

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `ISEMPTY` | is empty | none | NULL or empty string | all | Documented | OK |
| `ISNOTEMPTY` | is not empty | none | Has a value | all | Documented | OK |
| `EMPTY`, `NOTEMPTY` | (listed as query-operator equivalents in S1 numeric and integer-choice tables) | none | Same as ISEMPTY / ISNOTEMPTY. The S1 example queries use ISEMPTY. | N, CI | Documented as listed | MISSING (accept as aliases) |
| `EMPTYSTRING` | is empty string | none | Exactly `''`. ResolvrNow does not match NULL (Inferred). | S, R | Documented | OK |
| `ANYTHING` | is anything | none | Always true, including NULL | all | Documented | OK |

### 3.4 Field-to-field comparison

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `SAMEAS` | is same | other field. For D: `other@unit` with unit in `hour, day, week, month, quarter, year`. | Values are equal. For dates, they share the same unit bucket in the user's time zone. | S, CS, CI, N, B, R, D | Documented (S1, S6) | PARTIAL: the `@unit` form is IGNORED |
| `NSAMEAS` | is different | as SAMEAS | Values differ | as SAMEAS | Documented | PARTIAL: as SAMEAS |
| `GT_FIELD`, `LT_FIELD` | greater / less than field | other field | Strict comparison | N | Documented | OK |
| `GT_OR_EQUALS_FIELD`, `LT_OR_EQUALS_FIELD` | greater / less than or is field | other field | Inclusive comparison | N | Documented | OK |
| `MORETHAN` | is more than | `other@unit@before\|after@n` (S1 example `sla_dueMORETHANactivity_due@day@before@1`) | The gap between the two dates exceeds n units in the stated direction. n has at most 2 digits (S6). | D | Documented | IGNORED |
| `LESSTHAN` | is less than | as MORETHAN | The gap is within n units | D | Documented | IGNORED |

### 3.5 Dates

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `ON` | on | `label@start@end` | start <= v <= end | D | Documented | OK |
| `NOTON` | not on | `label@start@end` | Outside the range | D | Documented | OK; NULL rows match, verify |
| `RELATIVEGT` | relative (after) | `@unit@ago\|ahead@n` | v > now ± n units | D | Documented | PARTIAL (5.5) |
| `RELATIVELT` | relative (before) | as above | v < now ± n units | D | Documented | PARTIAL |
| `RELATIVEGE`, `RELATIVELE`, `RELATIVEEE` | relative on or after / on or before / on | as above | Inclusive variants. EE matches the same unit bucket. | D | Inferred | PARTIAL |
| `DATEPART` | trend (on, after, before, on or after, on or before) | `label@javascript:gs.datePart('part','value','OP')` | Compares one component of the date (5.6) | D | Documented | IGNORED |

### 3.6 Reference, user and class

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `DYNAMIC` | is (dynamic) | sys_id of a dynamic filter option | Value comes from the option's script (5.8) | R | Documented | PARTIAL: only 3 ids known |
| `IN_HIERARCHY` | is in hierarchy | `hierarchyDefId@startRecordId` (UI emits `%40`) | The value is the start record or any record below it | R (self-hierarchical) | Documented | BUG: parsed as `IN` |
| `IN_HIERARCHY_DYNAMIC` | is in hierarchy (dynamic) | `hierarchyDefId@dynamicOptionId` | As above, with a dynamic start | R | Documented | BUG: parsed as `IN` |
| `INSTANCEOF` | (scripts and reference qualifiers) | table name | `sys_class_name` is that class or one of its descendants | `sys_class_name` | Documented (S15, S17) | OK |

### 3.7 Change detection

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `VALCHANGES` | changes | none | The field changed in this update | X | Documented (listed for notifications) | PARTIAL: compiled as TRUE (G15) |
| `CHANGESFROM` | changes from | old value | The previous value equals the given value | X | Documented | PARTIAL |
| `CHANGESTO` | changes to | new value | The new value equals the given value | X | Documented | PARTIAL |

### 3.8 Tags

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `sys_tags.<tagId>=<tagId>` | have | tag sys_id | The record carries the tag | T | Documented | MISSING |
| `DOESNOTHAVE` | does not have | tag sys_id | The record has tags, but not this one | T | Documented | MISSING |
| `EXCLUDING` | excluding | tag sys_id | Records with or without tags, except those carrying this tag | T | Documented | MISSING |

### 3.9 Search

| Token | UI label | Value syntax | Semantics | Applies to | Basis | ResolvrNow |
|---|---|---|---|---|---|---|
| `123TEXTQUERY321=` | keyword search | search terms | Full-text search, case-insensitive (S15) | table | Documented (S2, S15) | PARTIAL (section 9.2) |
| `123TEXTINDEXGROUP321=` | text index group | group name | Restricts or scores search by index group | table | Documented (S2, S15) | MISSING |

## 4. Applicability by ResolvrNow field type

The left column lists the `type` values found in `server/src/schema/sdk/sdk-tables.json`. Each one is mapped to the operator family it should accept.

An operator outside its family should be treated as **invalid**, so the term is ignored. ResolvrNow currently does not check applicability; it compiles the operator anyway. **[Inferred]**

| ResolvrNow types | Family | Accepted operators | Notes |
|---|---|---|---|
| `string`, `translated_text`, `multi_two_lines`, `email`, `url`, `phone_number`, `ip_address`, `field_name`, `table_name`, `field_list`, `conditions`, `user_roles`, `name_values`, `json` | S | `= != LIKE NOT LIKE STARTSWITH ENDSWITH IN NOT IN ISEMPTY ISNOTEMPTY EMPTYSTRING ANYTHING < <= > >= BETWEEN SAMEAS NSAMEAS` | Lexical comparisons (Documented, S1). |
| `html`, `script` | S without SAMEAS / NSAMEAS | as S | S6 excludes HTML and script from field comparison (Documented). |
| `journal`, `journal_input`, `journal_list` | S subset | `LIKE NOT LIKE ISEMPTY ISNOTEMPTY ANYTHING` | Journal text is stored as entries, not in the row. Implement LIKE as a subquery on the journal entry table (Inferred). S6 excludes journal from field comparison. |
| `choice` (string values) | CS | `= != IN NOT IN LIKE NOT LIKE STARTSWITH ENDSWITH ANYTHING SAMEAS NSAMEAS ISEMPTY ISNOTEMPTY` | Compare the stored value, not the label (Documented, S2, S6). |
| `integer` columns that carry choices (`state`, `priority`, `impact`, `urgency`) | CI | `= != IN NOT IN ISEMPTY ISNOTEMPTY < > <= >= BETWEEN ANYTHING SAMEAS NSAMEAS` | Numeric ordering (Documented, S1). |
| `integer`, `decimal`, `float`, `currency`, `price`, `percent_complete` | N | `= != < > <= >= BETWEEN IN NOT IN ISEMPTY ISNOTEMPTY ANYTHING SAMEAS NSAMEAS GT_FIELD LT_FIELD GT_OR_EQUALS_FIELD LT_OR_EQUALS_FIELD` | IN on numbers is Inferred. Currency compares the stored amount (Inferred). |
| `glide_duration` | N over milliseconds | `= != < > <= >= BETWEEN ISEMPTY ISNOTEMPTY ANYTHING` | Value format: `1970-01-01 HH:MM:SS` or `D HH:MM:SS`. S6 excludes duration from field comparison (Documented). |
| `boolean` | B | `= != ISEMPTY ISNOTEMPTY ANYTHING SAMEAS NSAMEAS` | Values `true` / `false` (Documented). |
| `reference`, `domain_id` | R | `= != IN NOT IN ISEMPTY ISNOTEMPTY EMPTYSTRING ANYTHING STARTSWITH ENDSWITH LIKE NOT LIKE SAMEAS NSAMEAS DYNAMIC IN_HIERARCHY IN_HIERARCHY_DYNAMIC` | The text operators run on the display value (Documented, S1 examples). `=` takes a sys_id. |
| `document_id` | R subset | `= != ISEMPTY ISNOTEMPTY ANYTHING` | Stores a sys_id; the target table comes from a sibling field (Inferred). |
| `GUID` (sys_id) | S subset | `= != IN NOT IN STARTSWITH ISEMPTY ISNOTEMPTY ANYTHING` | Exact, case-sensitive comparison (Inferred). |
| `glide_date_time`, `due_date` | D | `ON NOTON < <= > >= BETWEEN DATEPART RELATIVE* ISEMPTY ISNOTEMPTY ANYTHING SAMEAS NSAMEAS MORETHAN LESSTHAN` | Stored as UTC `YYYY-MM-DD HH:MM:SS`. |
| `glide_date` | D | as above | Comparisons use the date part only. |
| `glide_time` | D subset | `= != < > <= >= BETWEEN ISEMPTY ISNOTEMPTY ANYTHING` | Inferred. |
| `sys_class_name` | CS + class | CS plus `INSTANCEOF` | Documented (S15, S17). |
| `glide_list` | list | `LIKE NOT LIKE = != ISEMPTY ISNOTEMPTY ANYTHING` | The value is a comma-separated list of sys_ids; LIKE tests membership (Inferred). S6 excludes list fields from field comparison (Documented). |
| `password2`, `image`, `variables`, `days_of_week` | opaque | `ISEMPTY ISNOTEMPTY ANYTHING` | A `password2` value must never be matchable (Inferred). |

## 5. Value formats

### 5.1 Literal values

| Kind | Format | Basis |
|---|---|---|
| Boolean | `true` / `false` | Documented (S2) |
| Choice | The stored value, e.g. `install_status=1`, never the label. The URL `field=value` shorthand (S3) is the exception: it accepts labels. | Documented (S2, S3) |
| Reference | A 32-hex sys_id (S1 examples). ResolvrNow extension: a value that is not a sys_id is matched against the target's display field, case-insensitively. | Documented for sys_id; Inferred for the extension |
| Number | Decimal with a `.` separator and no grouping | Inferred |
| Date-time | `YYYY-MM-DD HH:MM:SS`, compared to the stored UTC value. The Table API states that the database value is UTC. | Documented (S3); Inferred for literal comparison |
| Date | `YYYY-MM-DD` | Inferred |
| Duration | `1970-01-01 HH:MM:SS`, `D HH:MM:SS`, or `javascript:gs.getDurationDate('D HH:MM:SS')` | Inferred; `getDurationDate` is listed in S11 |
| Empty | `field=` means is empty; `field!=` means is not empty | Inferred |

### 5.2 `javascript:` values

**Platform behavior.** The value is evaluated server-side by the guarded script evaluator. Guarded script accepts:
- one simple expression or function call;
- literals, `+`, the ternary operator, and dot access;
- an allow-listed set of APIs.

Anything else is rejected. On new instances the rejection is enforced fully. **[Documented S12]**

**ResolvrNow policy.** ResolvrNow never runs JavaScript. A fixed allow-list of pure functions is evaluated natively. A value using any other function makes the term invalid (section 10). **[Inferred: ResolvrNow design, consistent with S12]**

**Time zone.**
- Every `beginningOf*` and `endOf*` bound, and every `*AgoStart` / `*AgoEnd` bound, must be computed in the **session user's time zone**, then converted to UTC for comparison.
- Date comparisons in the platform follow the active user's time zone. **[Documented S6]**
- ResolvrNow computes all bounds in UTC today (gap G12).

**Week start.**
- Taken from `glide.ui.filter.first_day_of_week`: an integer where 1 is Sunday and 2 is Monday; the default is 2, Monday. **[Documented S18]**
- ResolvrNow hard-codes Monday today, which matches the default.

The function names below come from the guarded-script allow-list (S11), so their existence is **[Documented]**. Their exact range semantics are **[Inferred]** from their names and S5.

| Group | Functions (S11) | ResolvrNow today |
|---|---|---|
| Day bounds | `beginningOfToday/endOfToday`, `beginningOfYesterday/endOfYesterday`, `beginningOfTomorrow/endOfTomorrow` | all present |
| Week bounds | `beginningOfThisWeek`, `LastWeek`, `NextWeek` (and `endOf...`) | present |
| Month bounds | `beginningOfThisMonth`, `LastMonth`, `NextMonth` (and `endOf...`) | present |
| Quarter bounds | `ThisQuarter`, `LastQuarter` | present |
| | `NextQuarter`, `Last2Quarters`, `Next2Quarters` | **missing** |
| Year bounds | `ThisYear`, `LastYear`, `NextYear` | present |
| | `Last2Years`, `OneYearAgo` | **missing** |
| Rolling windows | `Last15Minutes`, `Last30Minutes`, `Last45Minutes`, `LastMinute`, `CurrentMinute`, `LastHour`, `CurrentHour`, `Last2Hours`, `Last7Days`, `Last30Days`, `Last60Days`, `Last90Days`, `Last120Days`, `Last3Months`, `Last6Months`, `Last9Months`, `Last12Months` (each as `beginningOf...`/`endOf...`) | **missing** |
| Schedule periods | `beginningOf/endOfThisSchedulePeriod`, `LastSchedulePeriod`, `NextSchedulePeriod`, `SchedulePeriodsAgo` | **missing** (low priority) |
| Generic bounds | `beginningOfDay/Week/Month/Year`, `endOfDay/Week/Month/Year` | **missing** |
| Relative points | `daysAgo`, `daysAgoStart`, `daysAgoEnd`, `hoursAgo`, `hoursAgoStart`, `hoursAgoEnd`, `minutesAgo`, `minutesAgoStart`, `minutesAgoEnd`, `monthsAgo`, `monthsAgoStart`, `monthsAgoEnd`, `quartersAgo`, `quartersAgoStart`, `quartersAgoEnd`, `yearsAgo` | present |
| | `daysAgoLocal`, `hoursAgoLocal`, `yesterday`, `lastWeek` | **missing** |
| Construction | `dateGenerate('YYYY-MM-DD','HH:MM:SS')`, `now()` (date), `nowDateTime()`, `nowNoTZ()` | present |
| | `nowGlideDateTime()`, `dateAdd`, `getDurationDate`, `datePart(part, value, op)` | **missing** |
| User | `getUserID()`, `getUserName()`, `getUser().getID()`, `getUser().getName()`, `getUser().getMyGroups()`, `getUser().getManagerID()` | present |
| | other `GlideUser` getters in S11, such as `getCompanyID()`, `getDepartmentID()`, `getLocation()` | **missing** |
| Global helpers | `getMyGroups()`, `getMyAssignments()` | present |
| | `getMyApprovals()` (Inferred to exist) | **missing** |

### 5.3 ON / NOTON values

**Syntax.** `field ON label @ startExpr @ endExpr`, written without spaces. The documented example is `sla_dueONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)` (S1). The REST overview page uses `sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` (S4). **[Documented]**

Rules **[Inferred]**:
- The label is decorative. Evaluate `startExpr` and `endExpr`.
- If only a label is present, map it through the table below.
- If only a `YYYY-MM-DD` literal is present, treat it as that whole day. ResolvrNow supports this today; the platform's behavior should be verified.
- Bounds are inclusive. `endOf*` values are at second precision, ending in `:59`.
- For `glide_date` columns, compare date parts only.

Standard labels emitted by the date picker, with their bound pairs **[Inferred, verify]**. S5 defines the semantics of the labels. The `Today` pair is Documented.

| Label | start / end |
|---|---|
| Today | `gs.beginningOfToday()` / `gs.endOfToday()` (equivalently `gs.daysAgoStart(0)` / `gs.daysAgoEnd(0)`) |
| Yesterday / Tomorrow | `gs.beginningOfYesterday()` / `gs.endOfYesterday()`; `gs.beginningOfTomorrow()` / `gs.endOfTomorrow()` |
| This week / Last week / Next week | `gs.beginningOfThisWeek()` / `gs.endOfThisWeek()`, and the Last and Next equivalents |
| This month / Last month / Next month | `gs.beginningOfThisMonth()` / `gs.endOfThisMonth()`, and so on |
| This quarter / Last quarter / Next quarter | `gs.beginningOfThisQuarter()` / `gs.endOfThisQuarter()`, and so on |
| This year / Last year / Next year | `gs.beginningOfThisYear()` / `gs.endOfThisYear()`, and so on |
| Last 7 / 30 / 60 / 90 / 120 days | `gs.beginningOfLast7Days()` / `gs.endOfLast7Days()`, and so on |
| Last 3 / 6 / 9 / 12 months | `gs.beginningOfLast3Months()` / `gs.endOfLast3Months()`, and so on |
| Last 2 quarters / Next 2 quarters / Last 2 years | `gs.beginningOfLast2Quarters()` / `gs.endOfLast2Quarters()`, and so on |
| Current hour / Last hour / Last 2 hours | `gs.beginningOfCurrentHour()` / `gs.endOfCurrentHour()`, and so on |
| Current minute / Last minute / Last 15 / 30 / 45 minutes | `gs.beginningOfCurrentMinute()` / `gs.endOfCurrentMinute()`, and so on |
| One year ago | `gs.beginningOfOneYearAgo()` / `gs.endOfOneYearAgo()` |

Calendar rules from S5 **[Documented]**:
- "Last 3 months" starts at midnight on the first day of the month three full months back and runs to now.
- "Last 12 months" runs January to January.
- "This week" runs from the start of the current week.

S5 is not consistent about where a week starts: one example runs Sunday to Saturday, while the property default (S18) is Monday. Follow `glide.ui.filter.first_day_of_week`.

### 5.4 BETWEEN values

**Syntax.** `low@high`, inclusive on both ends.
- Numbers: `reassignment_countBETWEEN1@3` **[Documented]**.
- Strings: `short_descriptionBETWEENq@t` **[Documented]**.
- Dates: `sla_dueBETWEENjavascript:gs.daysAgoStart(1)@javascript:gs.daysAgoEnd(0)` **[Documented]**. For fixed dates the UI also emits `javascript:gs.dateGenerate('2026-01-01','00:00:00')@javascript:gs.dateGenerate('2026-01-31','23:59:59')` **[Inferred]**.

Note that one S1 example, `impactBETWEEN1@2`, is described as returning impacts 1 to 3. Treat that as a documentation error.

**Splitting.** Split on the first `@` that is outside a quoted macro argument. **[Inferred]**

### 5.5 RELATIVE values

**Syntax.** `@unit@direction@n`. Documented samples:
- `sla_dueRELATIVEGT@hour@ago@1` (S1);
- `last_discoveredRELATIVELT@dayofweek@ago@14` (S19).

Pieces:
- `direction` is `ago` or `ahead`.
- `unit` is one of `minute`, `hour`, `dayofweek` (which means days), `week`, `month`, `quarter`, `year`. Only `hour` and `dayofweek` are Documented; the rest are Inferred.

Semantics:
- The anchor is now ± n units, using calendar arithmetic for month, quarter and year. **[Inferred]**
- `RELATIVEGT` means the value is later than the anchor; `RELATIVELT` means earlier. **[Documented S1]**

ResolvrNow gaps:
- `dayofweek` is not in the unit table, so the documented sample is ignored (G13).
- Months, quarters and years are approximated as 30, 91 and 365 days.

### 5.6 DATEPART (trend) values

**Syntax.** `label@javascript:gs.datePart('part','value','OP')`, for example `sla_dueDATEPARTMonday@javascript:gs.datePart('dayofweek','monday','EE')`. **[Documented S1]**

- `OP` is one of `EE`, `GT`, `GE`, `LT`, `LE`. **[Documented]**
- `part` covers hour of day, day of week, week of year, month, quarter and year (S5). The tokens other than `dayofweek` are **[Inferred]**: `hour`, `week`, `month`, `quarter`, `year`.
- **Order of days.** The S1 examples imply Sunday sorts before Monday. "on or before Monday" matches Sunday and Monday, and "before Monday" matches Sunday only. **[Documented]**
- **Time zone.** Extract the date part in the user's time zone. **[Inferred]**

### 5.7 Field-comparison suffixes

`SAMEAS` and `NSAMEAS` on dates take an optional `@unit` suffix, for example `sla_dueSAMEASactivity_due@day`. **[Documented S1]** Units are `hour`, `day`, `week`, `month`, `quarter`, `year`. **[Documented S6]**

`MORETHAN` and `LESSTHAN` take `other@unit@position@n`.
- `position` covers before, after, and "before or after" (S6). Tokens other than `before` are **[Inferred]**: `after`, and `beforeorafter` (verify).
- `n` has at most two digits. **[Documented S6]**

### 5.8 DYNAMIC values

**Value.** The sys_id of a dynamic filter option record. That record stores a script which produces the comparison value or values. **[Documented S9 for the concept; Inferred for the storage]**

| sys_id | Label | Target table | Resolves to | Basis | ResolvrNow |
|---|---|---|---|---|---|
| `54635e965f510100a9ad2572f2b4774c` | Me | sys_user | current user sys_id | Documented (S1 example `caller_idDYNAMIC...`) | **missing** |
| `90d1921e5f510100a9ad2572f2b477fe` | Me | sys_user | current user sys_id | Documented (S1 uses it as "Me" inside IN_HIERARCHY_DYNAMIC) | present |
| `d6435e965f510100a9ad2572f2b47744` | One of My Groups | sys_user_group | the user's group sys_ids | Inferred | present |
| `2a0e2e365f510100a9ad2572f2b477e9` | My Manager | sys_user | the user's manager | Inferred | present |
| (ids unknown) | One of My Assignments, One of My Approvals, Users With Roles | sys_user | user plus delegates, and so on | Documented labels (S9) | missing |

Seed these as rows in a dynamic-option table, rather than hard-coding them, so administrators can add more (S9 notes that admins can create options). **[Inferred]**

### 5.9 IN_HIERARCHY values

**Syntax.** `managerIN_HIERARCHY<hierarchyDefinitionSysId>@<startUserSysId>`. The documented example URL-encodes the `@` as `%40`. **[Documented S1]**

**Semantics.**
- The field matches if its value is the start record, or any record that reaches the start record by repeatedly following the hierarchy's parent field.
- A hierarchy definition must exist first. **[Documented]**

**ResolvrNow status.** Not implemented. Because `IN` is matched first, the term currently becomes `IN` with value `_HIERARCHY...` and matches nothing (gap G2).

### 5.10 IN / NOT IN values

**Syntax.** A comma-separated list with no escape mechanism. Do not use these operators on values that contain commas. **[Documented S13]**

**Rules** **[Inferred]**:
- Trim each item and drop empty items.
- An empty list makes `IN` match nothing and `NOT IN` match everything (ResolvrNow today).
- For reference fields the items are sys_ids.

## 6. Dot-walking

Rules:
- **Syntax.** `ref.field`, chainable. The documented REST example is `company.stock_symbol=NYX` (S4). Every segment except the last must be a reference field. **[Documented S4, S10]**
- **Depth.** The recommended maximum chain length is three levels. ResolvrNow should accept deeper chains and should not hard-fail on them. **[Documented S10 for the recommendation; Inferred for the policy]**
- **In `sysparm_fields`.** The response key is the full dotted path, for example `"user.name"`. A dot-walked reference field is rendered as a reference object. **[Documented S4]**
- **Import Set API.** Dot-walking is not supported there. **[Documented S4]**
- **Empty intermediate reference.** The walked value is empty: `ISEMPTY` is true, `=x` is false, `!=x` is true. ResolvrNow implements this as a LEFT JOIN. **[Inferred]**
- **Unknown segment.** The whole term is invalid. **[Inferred]**
- **Subclass fields.** A segment that names a field defined only on a subclass of the referenced table is unknown, unless the reference target is that subclass. **[Inferred, verify]**
- **ORDERBY.** Dot-walked fields are allowed. **[Inferred]**

## 7. Ordering and grouping

### 7.1 ORDERBY / ORDERBYDESC

- **Syntax.** `ORDERBY<field>` and `ORDERBYDESC<field>`. Several may appear and are applied in order of appearance. The S3 example is `active=true^ORDERBYnumber^ORDERBYDESCcategory`. **[Documented S3]**
- **Placement.** They may appear anywhere in the string and do not take part in AND/OR logic. **[Inferred]**
- **Default order.** When no ORDERBY is given, the platform's order is unspecified. ResolvrNow should order by insertion order (rowid), which keeps `sysparm_offset` paging stable. **[Inferred]**
- **Reference fields** sort by display value; ResolvrNow already does this. **[Inferred, verify]**
- **Choice fields** sort by stored value. **[Inferred]**
- **Unknown fields** in ORDERBY are ignored. **[Inferred]**
- **API-generated ordering.** The Attachment API documents ORDERBY inside its own `sysparm_query`. **[Documented]**

### 7.2 GROUPBY

- `GROUPBY<field>` is a list and report hint. The Table API returns rows ungrouped and ignores it; ResolvrNow parses it and drops it. **[Inferred]**

### 7.3 Aggregate API ordering and having (different syntax)

These parameters do not appear inside `sysparm_query`. All **[Documented S14]**.

| Parameter | Syntax |
|---|---|
| `sysparm_order_by` | A comma list of `field`, `AGG^field` or `COUNT`, ascending by default, with an optional `^DESC`. Examples: `AVG^state`, `state^DESC`. |
| `sysparm_having` | A comma list of `aggregate^field^operator^value`. Example: `count^priority^>^3`. |

## 8. Related-list queries (RLQUERY)

**Syntax.** The related-list clause must be the last part of the query string. **[Documented S2]**

```
^RLQUERY<related_table>.<reference_field>,<quantifier>[,<encoded conditions>]^ENDRLQUERY
```

Examples:
- problems with at least one incident: `^RLQUERYincident.problem_id,>=1^ENDRLQUERY`
- problems with at least one critical incident: `^RLQUERYincident.problem_id,>=1,priority=1^ENDRLQUERY`

**Quantifiers.**
- The UI offers greater than or equal (default 1), greater than, less than or equal, less than, equal, none, and between. **[Documented S7]**
- Only `>=n` appears in the docs. These forms are **[Inferred]**: `>n`, `<=n`, `<n`, `=n`, and `=0` for "none". The token for "between" is unknown.

**Restrictions.**
- Only one related table per query. **[Documented S7]**
- No keyword search inside the related conditions. **[Documented S7]**

**Semantics** **[Inferred]**. Let `cnt` be the number of rows in `related_table` whose `reference_field` equals the outer row's `sys_id` and which match the inner conditions. The outer row matches if `cnt` satisfies the quantifier. In SQL this is a correlated `(SELECT COUNT(*) ...)` predicate, ANDed with the rest of the block.

**Inner conditions.** Everything after the second comma, up to `^ENDRLQUERY`, is an encoded query on the related table. Inside it, `^` separators belong to the subquery. **[Inferred]**

**ResolvrNow today.** Not supported. The `RLQUERY...` and `ENDRLQUERY` terms fail field recognition and are silently dropped, so the result is a superset (gap G1). The minimum fix is to recognize the construct and treat the whole query as invalid under section 10.

## 9. Text search

### 9.1 Platform behavior

- `123TEXTQUERY321=<terms>` searches across the table's indexed text and ignores case. **[Documented S2, S15]**
- `123TEXTINDEXGROUP321=<group>` restricts the search to an index group and scores results with that group's relevance settings. **[Documented S2, S15]**

### 9.2 ResolvrNow today

**Matching.**
- The search terms are split on whitespace.
- Every word must appear, as a case-insensitive `LIKE`, in at least one text column.
- The columns come from the table's `textIndex` if one is declared. Otherwise they are `number`, `short_description`, `description`, `name`, `title`, `text`, `user_name` and `email`.

**Recommendations** **[Inferred]**:
- Treat a `"quoted phrase"` as a single word.
- Return nothing, rather than everything, when the table has no searchable columns.
- Rank results only when the client asks for relevance.

## 10. Invalid terms, errors and case sensitivity

### 10.1 Invalid input

- **Platform default.** The invalid part of a query is ignored, and rows are returned using only the valid part. **[Documented S3]**
- **Strict mode.** Setting the property `glide.invalid_query.returns_no_rows` to `true` makes an invalid query return no rows at all. It affects every query path: lists, scripts and web services. **[Documented S3]**
- **Status code.** An invalid query is never an HTTP error in the Table API; the response is 200. **[Inferred from S3]**

A term is **invalid** in ResolvrNow if any of the following holds **[Inferred]**:
- An unknown field, or an unknown dot-walk segment.
- An unknown operator token.
- An operator outside the field's family (section 4). This check is not implemented yet.
- A malformed value: `BETWEEN` without `@`, `ON` bounds that cannot be parsed, a bad RELATIVE spec, or a `SAMEAS` target field that does not exist.
- An unknown `DYNAMIC` id.
- An unsupported `javascript:` expression.

How invalid terms are removed **[Inferred]**:
1. Drop the term from its OR cluster. If the cluster becomes empty, drop the cluster.
2. If a block becomes empty, drop the block. It is **not** treated as TRUE.
3. If nothing remains, the query has no filter and matches all rows.

This is ResolvrNow's current compiler behavior. Verify the empty-block rule against the platform.

**Strict mode in ResolvrNow.** ResolvrNow must implement `glide.invalid_query.returns_no_rows`, default `false`. When it is `true`, any invalid term turns the whole query into `1=0` (gap G16).

**Diagnostics.** Collect invalid terms in `CompiledQuery.invalid`. When session debugging is requested (`X-WantSessionDebugMessages: true`), surface them as debug log lines. **[Inferred]**

### 10.2 Case sensitivity

| Element | Rule | Basis |
|---|---|---|
| Field names | Case-sensitive, lowercase. `Short_description=x` is an unknown field, so the term is invalid. | Documented (S3: column names are case-sensitive) |
| Operators and connectors | Case-sensitive uppercase: `LIKE`, `^OR`, `ORDERBY`. `like` is not an operator. | Documented (S3: operators are case-sensitive) |
| Values: literal statement | S3 says values are case-sensitive. | Documented |
| Values: observed behavior | Platform databases normally use case-insensitive collations, and `123TEXTQUERY321` is explicitly case-insensitive (S15). ResolvrNow compares text with `COLLATE NOCASE` for `=`, `!=`, `IN` and `NOT IN`, and the LIKE family is ASCII case-insensitive. Keep this behavior and treat it as a deliberate, documented deviation. | Inferred |
| sys_id and GUID values | Exact match. | Inferred |
| Booleans | `true`, `TRUE` and `True` are all accepted. | Inferred |

Unicode case folding is a gap. SQLite `NOCASE` folds only ASCII, while platform collations also fold accented letters (gap G20).

### 10.3 NULL and empty semantics

| Operator | Matches NULL or `''`? | Basis |
|---|---|---|
| `=x`, `<`, `>`, `BETWEEN`, `LIKE`, `STARTSWITH`, `ENDSWITH`, `IN`, `ON` | No | Documented (S16: most filter operations do not return empty fields) |
| `!=x` | Yes | Documented for booleans (S1); Inferred otherwise |
| `NOT LIKE` | No: GlideRecord's DOES NOT CONTAIN excludes empty fields (S15). ResolvrNow currently returns them. | Documented; ResolvrNow differs (G23) |
| `NOT IN`, `NOTON` | Yes in ResolvrNow | Inferred (verify) |
| `ISEMPTY` | NULL or `''` on text columns, NULL on other columns | Inferred |
| `EMPTYSTRING` | `''` only | Inferred |
| `ANYTHING` | Yes | Documented |

To include empty rows in a result, clients add `^ORfieldISEMPTY`. **[Documented S16]**

## 11. Gap list against the current ResolvrNow parser

Scope: `server/src/engine/query/parser.ts`, `compiler.ts` and `macros.ts`, as read on 2026-10-21.

Priority key:

| Priority | Meaning |
|---|---|
| P1 | wrong results today, or a common client pattern |
| P2 | a documented feature is missing |
| P3 | a nicety, or rare |

| Id | Item | Docs | ResolvrNow today | Recommendation | Pri |
|---|---|---|---|---|---|
| G1 | `RLQUERY ... ENDRLQUERY` | S2, S7 | Silently dropped, so the result is a superset | Implement a correlated COUNT subquery. Until then, treat the query as invalid so strict mode returns no rows, and log it. | P1 |
| G2 | `IN_HIERARCHY`, `IN_HIERARCHY_DYNAMIC` | S1 | Misparsed as `IN`, so the term matches nothing | Add the tokens ahead of `IN`, then implement recursive CTE semantics | P1 |
| G3 | DYNAMIC id `54635e965f510100a9ad2572f2b4774c` ("Me") | S1 | Unknown id, so the term is ignored and the filter disappears | Add it as an alias of "Me". Move options into a seeded table. | P1 |
| G4 | Time zone of date macros and ON/DATEPART/SAMEAS buckets | S5, S6 | All computed in UTC | Compute in the session user's time zone (`sys_user.time_zone`, then the system default), then convert to UTC | P1 |
| G5 | `DATEPART` (trend) | S1, S5 | Parsed, then ignored | Implement `gs.datePart` evaluation with user-TZ extraction | P2 |
| G6 | `SAMEAS` / `NSAMEAS` with an `@unit` suffix | S1, S6 | Field lookup fails, so the term is ignored | Strip the suffix and compare `strftime` buckets in the user's TZ | P2 |
| G7 | `MORETHAN` / `LESSTHAN` | S1, S6 | Parsed, then ignored | Implement date-difference predicates | P3 |
| G8 | Missing `gs.*` functions | S11 | See the 5.2 table: NextQuarter, Last N windows, Current/Last hour and minute, `datePart`, `getDurationDate`, ... | Add them to the allow-list. The ON labels in 5.3 depend on them. | P2 |
| G9 | RELATIVE unit `dayofweek` (means days) | S19 | Unknown unit, so the term is ignored | Add `dayofweek` (and `day`) as the day unit | P1 |
| G10 | RELATIVE month, quarter and year use fixed day counts; `gs.monthsAgo` and similar clamp the day of month to 28 | Inferred | Approximate | Use calendar arithmetic with end-of-month clamping | P3 |
| G11 | Operator aliases `*`, `!*`, `%` | S1 lists them as equivalents | Not recognized | Accept them as aliases of LIKE, NOT LIKE and ENDSWITH (verify on a live instance) | P3 |
| G12 | `EMPTY` / `NOTEMPTY` tokens | S1 lists them as equivalents | Not recognized | Accept them as aliases | P3 |
| G13 | Tag queries: `sys_tags.<id>=`, `DOESNOTHAVE`, `EXCLUDING` | S1 | Not recognized | Implement once a label/label-entry model exists | P3 |
| G14 | `123TEXTINDEXGROUP321` | S2, S15 | Not recognized | Accept it; restrict the search columns to the group's tables | P3 |
| G15 | `VALCHANGES`, `CHANGESFROM`, `CHANGESTO` in read queries | S1 (notification conditions) | Compiled as TRUE. Inside an OR cluster this makes the whole cluster true. | Treat as invalid in read queries; evaluate only in rule conditions that have previous values | P2 |
| G16 | `glide.invalid_query.returns_no_rows` | S3 | Always ignores invalid terms | Add the property, default false | P2 |
| G17 | Operator/type applicability is not checked | S1 | e.g. `activeLIKEtru` compiles | Validate operators against section 4; treat a mismatch as invalid | P3 |
| G18 | Boolean literal parsing | S2 | Anything other than `true`, `1` or `yes` is read as false | Read `false`, `0` and `no` as false; any other value matches nothing | P3 |
| G19 | Arbitrary `javascript:` expressions (concatenation, script includes) | S2, S12 | Ignored | Keep rejecting them (security). Document it. Optionally support `'literal' + fn()` concatenation of allow-listed calls. | P3 |
| G20 | Unicode case-insensitive comparison | Inferred | ASCII only | Add a Unicode-aware collation or lower-case shadow columns | P3 |
| G21 | Label-only ON values (`ONToday` with no bounds) | Inferred | Parsed as a date, which fails, so the term is ignored | Map the standard labels from 5.3 to their bound pairs | P3 |
| G22 | Default ordering | Inferred | Unspecified | Add a deterministic tiebreaker (rowid) for stable offset paging | P2 |
| G23 | `NOT LIKE` includes NULL and empty rows | S15 | `(f IS NULL OR NOT LIKE)` | Exclude empty values to match the documented GlideRecord behavior (verify, since `!=` keeps NULLs) | P2 |
| G24 | `GOTO` prefix, and `NOTLIKE` / `NOTIN` without a space | not documented | Accepted | Keep them as harmless extensions | n/a |
| G25 | `=` on a reference with a non-sys_id value matches the display value | S3 (URL pair form only) | Applies to `sysparm_query` too | Keep it as an extension. Note that the platform may treat it as no match. | n/a |

## 12. Test vectors

These assume the user `abel` (sys_id `a1...`) in time zone `America/New_York`, and the clock `2026-10-21 15:00:00 UTC` (11:00 local). All vectors are **[Inferred]** expectations built from the rules above.

| # | Query | Expected match rule |
|---|---|---|
| 1 | `active=true^priority=1^ORpriority=2` | active AND (priority 1 OR 2) |
| 2 | `active=true^NQpriority=1` | active OR priority 1 |
| 3 | `short_descriptionLIKEvpn^ORDERBYDESCnumber` | contains "vpn" (any case); sorted by number descending |
| 4 | `bogus_field=1^active=true` | active only, since the bogus term is ignored; with strict mode, no rows |
| 5 | `caller_id.department.name=Finance` | two LEFT JOINs; matches by department name |
| 6 | `assigned_toISEMPTY^ORassignment_groupISEMPTY` | either field is NULL or `''` |
| 7 | `sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` | 2026-10-21 04:00:00 to 2026-10-22 03:59:59 UTC (New York day) |
| 8 | `opened_atRELATIVEGT@hour@ago@1` | opened_at > 2026-10-21 14:00:00 |
| 9 | `last_discoveredRELATIVELT@dayofweek@ago@14` | last_discovered < 2026-10-07 15:00:00 |
| 10 | `impactIN1,2` | impact 1 or 2 |
| 11 | `short_description=a^^b` | value is the literal `a^b` |
| 12 | `caller_idDYNAMIC54635e965f510100a9ad2572f2b4774c` | caller is the current user |
| 13 | `sys_class_nameINSTANCEOFtask` (on `task`) | every task subclass |
| 14 | `reassignment_countGT_FIELDreopen_count` | numeric column comparison |
| 15 | `123TEXTQUERY321=email outage` | both words appear (case-insensitive) |
| 16 | `priority<=2^ORDERBYpriority^ORDERBYnumber` | priority 1 or 2; sorted by priority, then number |
| 17 | `state!=7` | rows whose state is not 7, including rows with an empty state |
| 18 | `^RLQUERYincident.problem_id,>=1^ENDRLQUERY` (on `problem`) | problems with at least one incident (after G1) |
