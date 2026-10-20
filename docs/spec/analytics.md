# ResolvrNow spec: Platform Analytics for ITSM (reports, dashboards, indicators)

Status: draft 1 (2026-10-21). Parity target: ServiceNow "Brazil" public documentation.
Audience: engineers building `server/src/analytics/*` (report engine, KPI collector, dashboard API) and the chart components of the web app.
Companion files: `ai.md`, `agent-workspace.md`, `data/ai-analytics.json` (`choices`, `tables`, `constants.kpis`). Condition syntax: `encoded-query.md` (Aggregate API parameters in its §7.3).

## 0. Conventions and sources

- **[Documented]** = stated in the cited public page (paraphrased). **[Inferred]** = our reading, general platform knowledge absent from the pages, or a ResolvrNow decision. Tables use a Basis column with the same words.
- Tables already declared in `server/src/schema/sdk/sdk-tables.json` (formerly `sdk-tables.json`) (`sys_report`, `analytics_visualization`, `par_component`, `analytics_dashboard`, `pa_dashboards`) are referenced, not redeclared; missing columns and new tables are in the JSON.

| Prefix | URL |
|---|---|
| `[rep]` | https://www.servicenow.com/docs/r/now-intelligence/reporting/ |
| `[par]` | https://www.servicenow.com/docs/r/now-intelligence/ |
| `[im]` | https://www.servicenow.com/docs/r/it-service-management/incident-management/ |
| `[chg]` | https://www.servicenow.com/docs/r/it-service-management/change-management/ |
| `[prb]` | https://www.servicenow.com/docs/r/it-service-management/problem-management/ |
| `[sd]` | https://www.servicenow.com/docs/r/it-service-management/itsm-success-dashboard-indicators/ |
| `[otto]` | https://www.servicenow.com/docs/r/it-service-management/now-assist-for-it-service-management-itsm/ |
| `[api]` | https://www.servicenow.com/docs/r/api-reference/rest-apis/ |

## 1. Model overview

Sources: [par]platform-analytics-tables.html, [par]dashboards-glossary.html, [rep]c_ReportSources.html

| Layer | ServiceNow artifacts | ResolvrNow | Basis |
|---|---|---|---|
| Visualization | Core UI report `sys_report` and Platform Analytics visualization `par_visualization`, both under `analytics_visualization` (which extends `par_component`) | `sys_report` is the single stored definition (REST compatible); the renderer serves both "report" and "data visualization" UIs | Documented / Inferred |
| Dashboard | Core UI `pa_dashboards` and Platform Analytics `par_dashboard` (+ `par_dashboard_tab`, `par_dashboard_canvas`, `par_dashboard_widget`, `par_dashboard_filter`, `par_dashboard_permission`), both under `analytics_dashboard` | `par_dashboard` family only (simplified columns) | Documented / Inferred |
| Indicator | Performance Analytics indicators, sources, breakdowns, scores, targets, thresholds | `pa_indicators`, `pa_cubes`, `pa_breakdowns`, `pa_dimensions`, `pa_scores`, `pa_snapshots`, `pa_targets`, `pa_thresholds` (ResolvrNow columns) | Documented concept, table names Inferred (verify) |
| Report source | Named table + filter reused by many reports; changes propagate; cannot be deleted while used | `sys_report_source` | Documented |

## 2. Report definition

Sources: [rep]report-types-creation-details-rd.html, [rep]c_CreateBarCharts.html, [rep]c_CreatePieCharts.html, [rep]c_CreateLineCharts.html, [rep]c_SingleScoreCharts.html, [rep]c_PivotTables.html, [rep]c_MultilevelPivotCharts.html, [rep]list-reports.html, [rep]c_HeatmapCharts.html, [rep]c_CreateDialsAndSpeedometers.html, [rep]c_EmbeddingReportsInJelly.html, [rep]aggregation-reporting.html, [rep]t_CreateYourOwnReport.html, [rep]c_DrillingDownWithinReports.html, [rep]c_ReportRanges.html

### 2.1 Data section

| Field (sys_report) | Meaning | Basis |
|---|---|---|
| `source_type` | `table` (default), `source` (report source), `import` (imported spreadsheet), `metricbase` | Documented (values from embed parameters) |
| `table` / `report_source` | Raw table, or a report source (takes precedence when both are given) | Documented |
| `filter` | Encoded query applied before aggregation; may end with `^ORDERBY<field>` / `^ORDERBYDESC<field>` | Documented |
| `title`, `description` | Name shown in library and as default chart title (chart title max 40 characters) | Documented |
| `user`, `group`, `roles`, `is_published` | Owner and visibility (Me, Everyone, Groups and Users) | Documented / Inferred mapping |

### 2.2 Report types

`type` values are those accepted by the documented embed parameter; values in italics are not in that list and are Inferred.

| type | Category | Required configuration | Optional configuration | Aggregation | Drilldown | ResolvrNow phase |
|---|---|---|---|---|---|---|
| `bar` | Bar | `field` (group by) | `stack_field`, `additional_groupby`, `others`, `other_threshold`, `display_grid` | yes | yes | P1 |
| `horizontal_bar` | Bar | `field` | same as bar | yes | yes | P1 |
| `pareto` | Bar | `field` | | no | yes | P3 |
| `hist` | Bar | `box_field` (numeric) | bucket count | no | no | P3 |
| `pie`, `donut`, `semi_donut` | Pie and donut | `field` | `others`, `other_threshold`, `show_chart_total`, `donut_width_percent` | yes | yes | P1 |
| `line`, `area`, `spline`, *`step_line`*, *`column`*, `line_bar` | Time series | `trend_field` (date), `interval` (per) | `field` (series), `calendar`, `show_marker`, `use_null_in_trend` | yes | yes | P1 (line, area, column), P3 others |
| `pivot_v2` | Multidimensional (multilevel pivot) | `row` (up to 5 fields), `column` (up to 3 fields) | `show_zero`, subtotals | yes | yes | P2 |
| `pivot` | Other (simple pivot) | `row`, `column` | | yes | yes | P2 |
| *`heatmap`* | Multidimensional | `row`, `column` | `use_color_heatmap`, `axis_min_color`, `axis_max_color` | yes | yes | P2 |
| *`bubble`* | Multidimensional | `row`, `column`, size aggregate | | yes | yes | P3 |
| *`single_score`* | Scores | aggregate | `show_zero` (display zero), coloring rules, `score_color` | yes (count, count distinct, average, sum) | to list | P1 |
| `speedometer`, `dial` | Scores | aggregate | `gauge_autoscale`, `from`, `to`, `lower_limit`, `upper_limit`, `direction` (minimize/maximize) | yes | to list | P2 |
| `list` | Other | `field_list` (columns) | `orderby_list`, `list_ui_view` | no | n/a | P1 |
| `calendar` | Other | `trend_field` | | no | no | P3 |
| *`map`* | Other | `location_field`, `map` | `map_source` | yes | yes | P3 |
| `funnel`, `pyramid` | Other | `field` | `funnel_neck_percent` (default 30) | yes | yes | P3 |
| `box`, `trendbox`, `control`, `trend` | Statistical | `box_field` or `trend_field` + `field` | | no | no | P3 |

Rules: drilldown is unavailable on list, histogram, calendar, control, box, trendbox; the last drilldown level is always a list filtered by the clicked segment and subject to ACLs; drilldowns stay on the report's table and may use another chart type (`sys_report_drill`). **[Documented]** Reports cannot be scheduled when they are calendars; drilldowns export to PDF as the top level only. **[Documented]**

### 2.3 Configuration fields

| Field | Meaning | Basis |
|---|---|---|
| `field` | Group by field; dot-walking to extended/related tables allowed | Documented |
| `additional_groupby` | Extra group-by fields the viewer can switch to at runtime | Documented |
| `stack_field` | Stack by field for bar and column charts (column missing from the SDK extraction; name from the documented embed parameter) | Documented |
| `bar_unstack` | Show stacked data as side-by-side bars | Documented |
| `aggregate` | `COUNT` (default), `COUNT_DISTINCT`, `AVG`, `SUM`, `MIN`, `MAX`, `STDDEV` | Documented (STDDEV value Inferred) |
| `sumfield` | Field aggregated when the aggregate is not COUNT | Documented |
| `compute_percent` | Tooltip percentage basis: `aggregate` or `count` | Documented |
| `trend_field`, `interval`, `calendar` | Date field, period (`year`, `quarter`, `month`, `week`, `dayofweek`, `hour`, `date`), standard or business calendar | Documented |
| `row`, `column` | Rows and columns of pivot and heatmap | Documented |
| `others`, `other_threshold` | Show the "Other" bucket; max groups before bucketing ("Show all" means up to 50 groups) | Documented |
| `show_empty` | Include records with empty group or trend values | Documented |
| `display_grid` | Data table under the chart (forced on when accessibility mode is on) | Documented |
| `field_list`, `orderby_list` | List columns and sort | Documented |
| `report_drilldown`, `list_ui_view` | Drilldown chain and list view used at the bottom level | Documented |
| Style | colors (`set_color`: one_color, color_palette, several_colors), titles, legend, axes, chart size (small, medium, large; or custom width 600 / height 450 default), decimal precision 0 to 4 (default 2), data labels | Documented |
| Function fields | Calculated fields usable for grouping and aggregation (saved report required) | Documented (ResolvrNow P3) |
| Report ranges | Bucket definitions for durations, integers or value lists (for example Same Day, 2 Days, 2-5 Days, 5-7 Days, 1-2 Weeks, 2-4 Weeks, 1-2 Months, over 2 Months), global or per table field | Documented (ResolvrNow P2) |

Aggregation rules: Count gives records per group; Count Distinct counts unique values of `sumfield`; Average, Sum, Min, Max, Std deviation operate on `sumfield`; grouping with Average averages within each group. The reporting reference excludes histogram, pareto, single score, box, calendar and list reports from aggregation, while the single score page offers Count, Count Distinct and other aggregates; ResolvrNow supports aggregates on single score. **[Documented conflict, ResolvrNow choice Inferred]**

### 2.4 Report data API (ResolvrNow)

| Endpoint | Behaviour | Basis |
|---|---|---|
| `GET/POST/PATCH/DELETE /api/now/table/sys_report` | CRUD on definitions through the Table API with `sys_report` ACLs (write ACL controls saving) | Documented ACL, Inferred API reuse |
| `GET /api/now/stats/{table}` | Aggregate API: `sysparm_query`, `sysparm_count`, `sysparm_avg_fields`, `sysparm_sum_fields`, `sysparm_min_fields`, `sysparm_max_fields`, `sysparm_group_by`, `sysparm_having`, `sysparm_order_by`, `sysparm_display_value` | Documented ([api]c_AggregateAPI.html) |
| `GET /api/app/analytics/report/{sys_id}/data` | Executes a saved report; query parameters `filter` (extra encoded query ANDed), `group_by_override`, `as_of` | Inferred |
| `POST /api/app/analytics/report/preview` | Executes an unsaved definition (designer preview) | Inferred |

Response shape (ResolvrNow):

```json
{"type":"bar","title":"Open incidents by priority","table":"incident","aggregate":"COUNT","total":42,
 "series":[{"name":"Count","points":[{"key":"1","label":"1 - Critical","value":3,"drilldown":"stateIN1,2,3^priority=1"}]}],
 "other":{"value":0,"drilldown":null},"generatedAt":"2026-10-21 08:00:00","cached":false}
```

Each point carries the encoded query that opens the matching list (drilldown and dashboard click-through). Groups beyond `other_threshold` fold into `other`. Empty groups are dropped unless `show_empty`. **[Inferred]**

### 2.5 Sharing, scheduling, roles

| Topic | Rule | Basis |
|---|---|---|
| Roles that create reports | `itil`, `report_user`, `report_group`, `report_global`, `report_admin`, `admin`; viz admin roles in the library: `viz_admin`, `viz_creator`, `report_admin`, `pa_admin`, `platform_analytics_admin` | Documented |
| Data access | A user may only report on data they can read; list drill-ins drop rows removed by ACLs with a notice | Documented |
| Sharing | Me, Everyone, Groups and Users (`sys_report_users_groups`) | Documented concept, table Inferred |
| Scheduling | Email a report on a schedule (PDF or CSV attachment, recipients, condition) in `sysauto_report` | Documented concept, table Inferred |
| Designer shortcuts | Run Ctrl+Alt+R, Save Ctrl+Alt+S, domain picker Ctrl+Alt+D, Data tab Ctrl+Alt+1 | Documented |

## 3. Dashboard model

Sources: [par]ac-elements.html, [par]configuring-dashboards.html, [par]dashboards-glossary.html, [par]platform-analytics-tables.html, [par]data-caching-pa.html, [par]interactive-filters-workspace.html, [par]explore-data-vis-library.html

### 3.1 Concepts

| Concept | Behaviour | Basis |
|---|---|---|
| Dashboard | Canvas of elements shared with users, groups or roles (view or edit); owner can transfer ownership; requester gets edit rights | Documented |
| Tabs and top stage | Named tabs; the top stage stays visible across tabs and its filters apply to all tabs; filters on a tab apply only to that tab | Documented |
| Elements | Data visualizations, filters, filter groups, headings, images, lists, dividers, rich text, AI context menus, process maps, workbenches, funnels | Documented |
| Header controls | Title with switcher, last refresh time, refresh button, certification and category badges, details (owner and sharing), insights, edit, more actions (create, duplicate, share, print, bookmark, clear filters, delete) | Documented |
| Library | Dashboards owned, shared, bookmarked; categories (managed by `analytics_categories_admin`); certification by admin or `dashboard_admin` | Documented |
| Refresh and caching | Admins set scheduled refresh and caching per dashboard and a global tab cache timeout in minutes | Documented |
| Insights | Proactive cards about indicator anomalies, targets, thresholds, process bottlenecks | Documented (ResolvrNow P3) |
| Workspaces | A dashboard declares which workspaces may embed it | Documented |

### 3.2 ResolvrNow dashboard schema

| Table | Key columns | Basis |
|---|---|---|
| `par_dashboard` | `name`, `description`, `owner`, `requester`, `active`, `certified`, `categories`, `refresh_interval_min`, `cache_enabled`, `allowed_workspaces` | Inferred columns |
| `par_dashboard_tab` | `dashboard`, `name`, `order`, `background_color` | Inferred columns |
| `par_dashboard_widget` | `dashboard`, `tab` (empty = top stage), `component_table` (`sys_report`, `pa_indicators`), `component` (sys_id), `kind` (visualization, kpi_scorecard, filter, heading, text, image, list), `x`, `y`, `w`, `h` on a 12-column grid, `title_override`, `config` (JSON) | Inferred columns |
| `par_dashboard_filter` | `dashboard`, `tab`, `label`, `kind` (select, cascading, boolean, date), `table`, `field`, `default_value`, `targets` (JSON map: widget id to field path) | Inferred columns |
| `par_dashboard_permission` | `dashboard`, `user`, `group`, `role`, `access` (view, edit) | Inferred columns |

Filter semantics: a filter produces an encoded query term per target widget (`priority=1`, date filters produce `opened_atBETWEEN...`); widgets on other tables only react when a field mapping is configured; URL parameters can preset filter values. **[Documented concept, mapping Inferred]**

## 4. Indicators and KPI engine

Sources: [par]your-kpis.html, [par]kpi-details-components.html, [par]kpi-details-targets.html, [api]c_PerformanceAnalyticsAPI.html, [sd]itsm-sdb-dasboard-overview.html

### 4.1 Platform concepts

| Concept | Behaviour | Basis |
|---|---|---|
| Indicator types | Automated (computed from a source), formula (arithmetic over other indicators using `[[Indicator name]]`), manual, external | Documented |
| Indicator source | Facts table, conditions, frequency | Documented |
| Scores | Collected by jobs per frequency (daily for ITSM); historic collection backfills past dates | Documented |
| Breakdowns | Dimensions such as priority, category, assignment group, state, age; scores per element | Documented |
| Direction | Maximize or minimize; drives up/down colouring of changes | Documented |
| KPI Details | Header (score on date, change vs previous score in absolute and percent), chart with date range and time aggregation (AVG or SUM per period), records behind a score, contributing indicators of a formula, breakdown filters | Documented |
| Targets | Personal or global; start date and review date; gap = target minus score on the selected date; forecast gap on review date; status On track, Off track, Too early to track, then Met or Not met | Documented |
| Thresholds | Personal or global; crossing sends an email notification | Documented |
| Scorecards API | `GET /api/now/pa/scorecards` with `sysparm_uuid` (indicator:breakdown:elements...), `sysparm_include_scores`, `sysparm_from`, `sysparm_to`, `sysparm_step`, `sysparm_breakdown`, `sysparm_display_value` | Documented |
| Period roll-up (Success Dashboard) | Monthly, quarterly, yearly views: counts are sums of daily values, percentages are averages of daily percentages; comparison with the previous period | Documented |

### 4.2 ResolvrNow KPI definition and collection

| Element | Rule | Basis |
|---|---|---|
| Definition | `{id, label, table, condition, aggregate, field, unit, mode, dateField, formula, direction, breakdowns}`; catalogue in §5 and `constants.kpis` | Inferred |
| Aggregates | `COUNT`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`, `AVG_AGE` (average of `as_of - field`, in days), `FORMULA` | Inferred |
| Mode `snapshot` | Rows matching `condition` at collection time; the daily score is the state at 23:59:59 of the score date | Inferred |
| Mode `period` | Rows matching `condition` AND `dateField` within the score date (00:00:00 to 23:59:59 in the instance time zone) | Inferred |
| Predicates | `predicate` expresses comparisons the encoded query cannot (for example `same_day(opened_at,resolved_at)`), evaluated in SQL by the collector | Inferred |
| Collection job | `pa.collect.daily` at 00:30 for yesterday; `pa.collect.historic(from,to)` backfills `period` KPIs exactly and `snapshot` KPIs approximately from history tables (flagged `approximate=true`) | Inferred |
| Formula | Evaluated after inputs for the same date and breakdown element; division by zero yields null (gap in chart) | Inferred |
| Breakdowns | Each KPI lists breakdown fields; scores stored per element plus the total (element empty) | Inferred |
| Snapshots | For snapshot KPIs flagged `collect_records`, sys_ids behind each daily score are stored in `pa_snapshots` for "show records" | Inferred |
| Period views | Week, month, quarter, year: counts summed, percentages averaged over days (documented convention); an option recomputes ratios from summed numerators and denominators | Documented / Inferred |
| Targets and thresholds | Stored per KPI and optional breakdown element; threshold evaluation after each collection; notification to subscribers | Documented concept |

## 5. ITSM KPI catalogue

Sources: [im]incident-premium-dashboard.html, [im]incident-sla-mgmt-dashboard.html, [im]incident-monitor-track.html, [chg]change-premium-dashboard.html, [chg]change-velocity-dashboard.html, [prb]problem-premium-dashboard.html, [sd]performance-overview-ref.html, [sd]service-quality-ref.html, [sd]operational-success-ref.html, [otto]insights-opportunities-incident-dashboard-reference.html, plus `ai.md` §5.7 for worker metrics.

### 5.0 Notation and value assumptions

- Incident `state`: 1 New, 2 In Progress, 3 On Hold, 6 Resolved, 7 Closed, 8 Canceled (state numbers documented in the KB-generation property page). Change `state`: -5 New, -4 Assess, -3 Authorize, -2 Scheduled, -1 Implement, 0 Review, 3 Closed, 4 Canceled. Change `close_code`: `successful`, `successful_issues`, `unsuccessful`. Change `risk`: 1 Very High, 2 High, 3 Moderate, 4 Low. Incident `close_code` values as labels (for example `Resolved by caller`, `No resolution provided`). RITM `state` 3 = Closed Complete (see `service-catalog.md`). Problem `state` 107 = Closed. **[Inferred, verify against the incident, change and problem specs]**
- `calendar_stc` and `business_stc` hold seconds from open to resolve. ResolvrNow sets `task.calendar_duration` (seconds) when a task closes. **[Inferred]**
- Column `Mode` gives `snapshot` or `period:<dateField>`. Percentages are `numerator / denominator * 100`.

### 5.1 Incident volume and backlog

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `incident_open` | Open incidents | incident | `stateIN1,2,3` | COUNT | snapshot | count | min | Documented concept (no resolution date) |
| `incident_new` | New incidents | incident | (none) | COUNT | period:opened_at | count | none | Documented |
| `incident_resolved` | Resolved incidents | incident | `resolved_atISNOTEMPTY^state!=8` | COUNT | period:resolved_at | count | max | Documented |
| `incident_closed` | Closed incidents | incident | `state=7` | COUNT | period:closed_at | count | max | Documented |
| `incident_unassigned_open` | Unassigned open incidents | incident | `stateIN1,2,3^assigned_toISEMPTY` | COUNT | snapshot | count | min | Documented |
| `incident_open_p1` | Open critical incidents | incident | `stateIN1,2,3^priority=1` | COUNT | snapshot | count | min | Documented |
| `incident_new_p1` | New critical incidents | incident | `priority=1` | COUNT | period:opened_at | count | min | Documented |
| `incident_new_critical_pct` | % new incidents that are critical | | `[[incident_new_p1]] / [[incident_new]] * 100` | FORMULA | | percent | min | Documented |
| `incident_backlog_age` | Average age of open incidents | incident | `stateIN1,2,3` | AVG_AGE (opened_at) | snapshot | days | min | Documented (summed age / count / 24) |
| `incident_open_older_30d` | Open incidents older than 30 days | incident | `stateIN1,2,3^opened_at<javascript:gs.daysAgoStart(30)` | COUNT | snapshot | count | min | Documented |
| `incident_open_stale_5d` | Open incidents not updated for 5 days | incident | `stateIN1,2,3^sys_updated_on<javascript:gs.daysAgoStart(5)` | COUNT | snapshot | count | min | Documented |
| `incident_stale_5d_pct` | % open incidents not updated in 5 days | | `[[incident_open_stale_5d]] / [[incident_open]] * 100` | FORMULA | | percent | min | Documented |
| `incident_avg_reassignment_open` | Average reassignments of open incidents | incident | `stateIN1,2,3` | AVG (reassignment_count) | snapshot | count | min | Documented |
| `incident_open_reassigned` | Open incidents reassigned at least once | incident | `stateIN1,2,3^reassignment_count>0` | COUNT | snapshot | count | min | Documented |
| `incident_reassigned_open_pct` | % open incidents reassigned | | `[[incident_open_reassigned]] / [[incident_open]] * 100` | FORMULA | | percent | min | Documented |
| `incident_backlog_growth` | Incident backlog growth | | `[[incident_new]] - [[incident_resolved]]` | FORMULA | | count | min | Inferred |

### 5.2 Incident speed

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `mttr_incident` | Mean time to resolve | incident | `resolved_atISNOTEMPTY^state!=8` | AVG (calendar_stc) | period:resolved_at | seconds | min | Documented concept |
| `mttr_incident_business` | Mean time to resolve (business hours) | incident | `resolved_atISNOTEMPTY^state!=8` | AVG (business_stc) | period:resolved_at | seconds | min | Inferred |
| `incident_avg_close_time` | Average time to close (Success Dashboard MTTR variant: creation to closure) | incident | `state=7` | AVG (calendar_duration) | period:closed_at | seconds | min | Documented |
| `incident_resolved_same_day` | Incidents resolved the day they opened | incident | `resolved_atISNOTEMPTY^state!=8` + predicate `same_day(opened_at,resolved_at)` | COUNT | period:resolved_at | count | max | Documented |
| `incident_resolved_same_day_pct` | % resolved same day | | `[[incident_resolved_same_day]] / [[incident_resolved]] * 100` | FORMULA | | percent | max | Documented |

### 5.3 Incident quality and SLA

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `incident_sla_res_total` | Resolution SLAs completed | task_sla | `task.sys_class_name=incident^sla.type=SLA^sla.target=resolution^stage!=cancelled^end_timeISNOTEMPTY` | COUNT_DISTINCT (task) | period:end_time | count | none | Documented (type SLA, stage not cancelled); target filter Inferred |
| `incident_sla_res_met` | Resolution SLAs met | task_sla | same `^has_breached=false` | COUNT_DISTINCT (task) | period:end_time | count | max | Documented (elapsed percentage at most 100) |
| `incident_resolved_within_sla_pct` | % incidents resolved within SLA | | `[[incident_sla_res_met]] / [[incident_sla_res_total]] * 100` | FORMULA | | percent | max | Documented |
| `incident_sla_open` | Open incidents with an active SLA | task_sla | `task.active=true^task.sys_class_name=incident^sla.type=SLA^stage!=cancelled` | COUNT_DISTINCT (task) | snapshot | count | none | Documented |
| `incident_sla_open_breached` | Open and overdue incidents | task_sla | same `^has_breached=true` | COUNT_DISTINCT (task) | snapshot | count | min | Documented |
| `incident_open_overdue_pct` | % open incidents overdue | | `[[incident_sla_open_breached]] / [[incident_sla_open]] * 100` | FORMULA | | percent | min | Documented |
| `incident_sla_resp_total` | Response SLAs completed | task_sla | `task.sys_class_name=incident^sla.target=response^stage!=cancelled^end_timeISNOTEMPTY` | COUNT | period:end_time | count | none | Documented concept (doc models response as OLA) |
| `incident_sla_resp_met` | Response SLAs met | task_sla | same `^has_breached=false` | COUNT | period:end_time | count | max | Documented concept |
| `incident_response_within_sla_pct` | % responded within SLA | | `[[incident_sla_resp_met]] / [[incident_sla_resp_total]] * 100` | FORMULA | | percent | max | Documented concept |
| `incident_closed_breached` | Closed incidents that breached an SLA | incident | `state=7^made_sla=false` | COUNT | period:closed_at | count | min | Documented concept |
| `incident_breached_sla_pct` | % breached SLAs (Success Dashboard) | | `[[incident_closed_breached]] / [[incident_closed]] * 100` | FORMULA | | percent | min | Documented |
| `incident_resolved_first_assignment` | Resolved without reassignment | incident | `resolved_atISNOTEMPTY^state!=8^reassignment_count=0` | COUNT | period:resolved_at | count | max | Documented |
| `incident_first_assignment_resolution_pct` | % first assignment resolution | | `[[incident_resolved_first_assignment]] / [[incident_resolved]] * 100` | FORMULA | | percent | max | Documented |
| `incident_resolved_interactive` | Resolved incidents from interactive channels | incident | `resolved_atISNOTEMPTY^state!=8^contact_typeINphone,chat,walk-in` | COUNT | period:resolved_at | count | none | Inferred |
| `incident_resolved_first_contact` | Resolved at first contact | incident | `resolved_atISNOTEMPTY^state!=8^contact_typeINphone,chat,walk-in^reassignment_count=0^resolved_bySAMEASopened_by` | COUNT | period:resolved_at | count | max | Inferred |
| `incident_fcr_pct` | First contact resolution rate | | `[[incident_resolved_first_contact]] / [[incident_resolved_interactive]] * 100` | FORMULA | | percent | max | Inferred |
| `incident_reopened` | Incidents reopened | incident | `reopen_count>0` | COUNT | period:reopened_time | count | min | Documented concept |
| `incident_reopen_rate_pct` | Reopen rate | | `[[incident_reopened]] / [[incident_resolved]] * 100` | FORMULA | | percent | min | Documented |
| `incident_closed_by_caller` | Closed by caller (self-service) | incident | `state=7^close_code=Resolved by caller` | COUNT | period:closed_at | count | max | Documented concept |
| `incident_closed_by_caller_pct` | % closed by self-service | | `[[incident_closed_by_caller]] / [[incident_closed]] * 100` | FORMULA | | percent | max | Documented |
| `incident_not_solved` | Closed without resolution | incident | `state=7^close_code=No resolution provided` | COUNT | period:closed_at | count | min | Documented concept |
| `incident_not_solved_pct` | % not solved | | `[[incident_not_solved]] / [[incident_closed]] * 100` | FORMULA | | percent | min | Documented |

### 5.4 Change

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `change_open` | Open changes | change_request | `active=true` | COUNT | snapshot | count | none | Documented |
| `change_new` | New changes | change_request | (none) | COUNT | period:opened_at | count | none | Documented |
| `change_closed` | Closed changes | change_request | `state=3` | COUNT | period:closed_at | count | none | Documented |
| `change_closed_with_code` | Closed changes with an outcome | change_request | `state=3^close_codeINsuccessful,successful_issues,unsuccessful` | COUNT | period:closed_at | count | none | Inferred |
| `change_closed_successful` | Successful changes | change_request | `state=3^close_code=successful` | COUNT | period:closed_at | count | max | Documented concept |
| `change_success_rate_pct` | Change success rate | | `[[change_closed_successful]] / [[change_closed_with_code]] * 100` | FORMULA | | percent | max | Inferred formula |
| `change_unsuccessful` | Unsuccessful changes | change_request | `state=3^close_code=unsuccessful` | COUNT | period:closed_at | count | min | Documented |
| `change_new_emergency` | New emergency changes | change_request | `type=emergency` | COUNT | period:opened_at | count | min | Documented concept |
| `change_emergency_rate_pct` | Emergency change rate | | `[[change_new_emergency]] / [[change_new]] * 100` | FORMULA | | percent | min | Documented analog (% urgent changes) |
| `change_backlog_growth` | Change backlog growth | | `[[change_new]] - [[change_closed]]` | FORMULA | | count | min | Documented |
| `change_avg_age_open` | Average age of open changes | change_request | `active=true` | AVG_AGE (opened_at) | snapshot | days | min | Documented |
| `change_avg_close_time` | Average close time of changes | change_request | `state=3` | AVG (calendar_duration) | period:closed_at | seconds | min | Documented |
| `change_overdue` | Overdue changes | change_request | `stateIN-5,-4,-3,-2^start_date<javascript:gs.nowDateTime()` | COUNT | snapshot | count | min | Documented |
| `change_unauthorized` | Unauthorized changes | change_request | `unauthorized=true` | COUNT | period:opened_at | count | min | Documented |
| `change_open_reassigned` | Reassigned open changes | change_request | `active=true^reassignment_count>0` | COUNT | snapshot | count | min | Documented |
| `change_awaiting_approval` | Changes awaiting approval | change_request | `active=true^approval=requested` | COUNT | snapshot | count | none | Documented concept |
| `change_high_risk_today` | High-risk changes starting today | change_request | `riskIN1,2^start_dateONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` | COUNT | snapshot | count | none | Documented concept |
| `change_caused_incidents` | Incidents caused by changes | incident | `caused_byISNOTEMPTY` | COUNT | period:opened_at | count | min | Documented |

### 5.5 Problem

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `problem_open` | Open problems | problem | `active=true` | COUNT | snapshot | count | none | Documented |
| `problem_new` | New problems | problem | (none) | COUNT | period:opened_at | count | none | Documented |
| `problem_closed` | Closed problems | problem | `closed_atISNOTEMPTY` | COUNT | period:closed_at | count | none | Documented |
| `problem_to_incident_ratio` | Problem-to-incident ratio | | `[[problem_new]] / [[incident_new]]` | FORMULA | | ratio | none | Inferred |
| `incident_resolved_with_problem` | Resolved incidents linked to a problem | incident | `resolved_atISNOTEMPTY^state!=8^problem_idISNOTEMPTY` | COUNT | period:resolved_at | count | max | Inferred |
| `incident_with_problem_pct` | % resolved incidents linked to a problem | | `[[incident_resolved_with_problem]] / [[incident_resolved]] * 100` | FORMULA | | percent | max | Inferred |
| `problem_avg_age_open` | Average age of open problems | problem | `active=true` | AVG_AGE (opened_at) | snapshot | days | min | Documented |
| `problem_avg_close_time` | Average close time of problems | problem | `closed_atISNOTEMPTY` | AVG (calendar_duration) | period:closed_at | seconds | min | Documented |
| `problem_open_known_error` | Open problems that are known errors | problem | `active=true^known_error=true` | COUNT | snapshot | count | none | Documented |
| `problem_known_error_pct` | % open problems classified as known error | | `[[problem_open_known_error]] / [[problem_open]] * 100` | FORMULA | | percent | max | Documented |
| `problem_open_with_incident` | Open problems with at least one incident | problem | `active=true^related_incidents>0` | COUNT | snapshot | count | none | Documented |
| `problem_with_incident_pct` | % open problems with incidents | | `[[problem_open_with_incident]] / [[problem_open]] * 100` | FORMULA | | percent | max | Documented |
| `problem_closed_no_notes` | Closed problems without close notes | problem | `closed_atISNOTEMPTY^close_notesISEMPTY` | COUNT | period:closed_at | count | min | Documented |
| `problem_closed_no_notes_pct` | % closed problems without notes | | `[[problem_closed_no_notes]] / [[problem_closed]] * 100` | FORMULA | | percent | min | Documented |

### 5.6 Request fulfilment

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `ritm_open` | Open requested items | sc_req_item | `active=true` | COUNT | snapshot | count | none | Inferred |
| `ritm_new` | Requested items created | sc_req_item | (none) | COUNT | period:opened_at | count | none | Documented (RITMs created) |
| `ritm_completed` | Requested items completed (structured tickets) | sc_req_item | `state=3` | COUNT | period:closed_at | count | max | Documented |
| `request_fulfillment_time` | Average request fulfilment time | sc_req_item | `state=3` | AVG (calendar_duration) | period:closed_at | seconds | min | Inferred |
| `ritm_completed_on_time` | Completed before due date | sc_req_item | `state=3^due_dateGT_FIELDclosed_at` | COUNT | period:closed_at | count | max | Inferred |
| `ritm_on_time_pct` | % requests fulfilled on time | | `[[ritm_completed_on_time]] / [[ritm_completed]] * 100` | FORMULA | | percent | max | Inferred |
| `ritm_auto_fulfilled` | Requests fulfilled automatically | sc_req_item | `state=3^cat_item.fulfillment_automation_level=fully_automated` | COUNT | period:closed_at | count | max | Documented concept |
| `tickets_submitted` | Total tickets submitted | | `[[incident_new]] + [[ritm_new]]` | FORMULA | | count | none | Documented |

### 5.7 Experience and self-service

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `csat_score` | Customer satisfaction score | asmt_metric_result | `metric.name=Overall satisfaction^instance.trigger_table=incident` | AVG (actual_value) | period:sys_created_on | score | max | Documented concept, encoding Inferred |
| `incident_self_service_new` | Incidents submitted via portal | incident | `contact_type=self-service` | COUNT | period:opened_at | count | max | Documented concept |
| `incident_va_new` | Incidents submitted via virtual agent | incident | `contact_type=virtual_agent` | COUNT | period:opened_at | count | max | Documented concept |
| `catalog_ticket_submissions` | Catalog ticket submissions | | `[[incident_self_service_new]] + [[ritm_new]]` | FORMULA | | count | max | Documented |
| `self_solved_va` | Self-solved via virtual agent | resolvr_self_service_event | `type=va_solved` | COUNT | period:sys_created_on | count | max | Documented concept (no ticket and no agent within 24 h) |
| `self_solved_kb` | Self-solved via knowledge | resolvr_self_service_event | `type=kb_solved` | COUNT | period:sys_created_on | count | max | Documented concept (same 24 h rule) |
| `call_deflection_pct` | Call deflection | | `([[catalog_ticket_submissions]] + [[incident_va_new]] + [[self_solved_va]] + [[self_solved_kb]]) / ([[tickets_submitted]] + [[self_solved_va]] + [[self_solved_kb]]) * 100` | FORMULA | | percent | max | Documented formula |
| `total_ticket_resolutions` | Total ticket resolutions | | `[[incident_resolved]] + [[ritm_completed]] + [[interaction_closed_no_ticket]]` | FORMULA | | count | none | Documented |
| `interaction_closed_no_ticket` | Interactions closed without a ticket | interaction | `state=closed_complete^RLQUERYinteraction_related_record.interaction,=0^ENDRLQUERY` | COUNT | period:closed_at | count | max | Documented concept, encoding Inferred |
| `self_solved_pct` | Self-solved percentage | | `([[self_solved_va]] + [[self_solved_kb]] + [[ritm_auto_fulfilled]]) / ([[total_ticket_resolutions]] + [[self_solved_va]] + [[self_solved_kb]]) * 100` | FORMULA | | percent | max | Documented formula (password reset and DEX terms omitted in ResolvrNow v1) |

`resolvr_self_service_event` is a ResolvrNow table written by the portal search and AI Q&A when a user views an answer and neither creates a ticket nor contacts an agent within 24 hours (job `pa.self_service.evaluate`). **[Inferred]**

### 5.8 AI and automation

| Id | Label | Table | Condition | Aggregate (field) | Mode | Unit | Dir | Basis |
|---|---|---|---|---|---|---|---|---|
| `pi_predictions_attempted` | Predictions attempted | ml_predictor_results | (none) | COUNT | period:sys_created_on | count | none | Documented concept |
| `pi_predictions_applied` | Predictions produced (confidence over threshold) | ml_predictor_results | `above_threshold=true` | COUNT | period:sys_created_on | count | max | Documented concept |
| `pi_coverage_pct` | Prediction coverage | | `[[pi_predictions_applied]] / [[pi_predictions_attempted]] * 100` | FORMULA | | percent | max | Documented |
| `pi_predictions_evaluated` | Predictions with an outcome at closure | ml_predictor_results | `outcomeINcorrect,incorrect` | COUNT | period:outcome_at | count | none | Documented concept |
| `pi_predictions_correct` | Correct predictions (productivity in routing) | ml_predictor_results | `outcome=correct` | COUNT | period:outcome_at | count | max | Documented |
| `pi_precision_pct` | Prediction precision | | `[[pi_predictions_correct]] / [[pi_predictions_evaluated]] * 100` | FORMULA | | percent | max | Documented |
| `genai_invocations` | AI skill invocations | sys_generative_ai_log | `status=success` | COUNT | period:sys_created_on | count | max | Documented concept (productivity in fulfilment) |
| `genai_helpful` | Helpful feedback | sys_generative_ai_log | `feedback=helpful` | COUNT | period:sys_created_on | count | max | Documented concept |
| `genai_rated` | Rated outputs | sys_generative_ai_log | `feedbackINhelpful,not_helpful` | COUNT | period:sys_created_on | count | none | Inferred |
| `genai_helpful_pct` | % helpful AI outputs | | `[[genai_helpful]] / [[genai_rated]] * 100` | FORMULA | | percent | max | Inferred |
| `l1_attempted` | Incidents attempted by the AI worker | resolvr_ai_worker_engagement | `attempted=true` | COUNT | period:closed_at | count | none | Documented concept |
| `l1_assigned` | Incidents assigned to the AI worker | resolvr_ai_worker_engagement | (none) | COUNT | period:closed_at | count | none | Documented concept |
| `l1_durable_resolved` | Resolved without human reassignment and not reopened | resolvr_ai_worker_engagement | `attempted=true^outcome=resolved^reopened=false` | COUNT | period:closed_at | count | max | Documented |
| `l1_durable_auto_resolve_pct` | Durable auto-resolve rate | | `[[l1_durable_resolved]] / [[l1_attempted]] * 100` | FORMULA | | percent | max | Documented |
| `l1_coverage_pct` | AI worker coverage rate | | `[[l1_attempted]] / [[l1_assigned]] * 100` | FORMULA | | percent | max | Documented |
| `l1_followed_up` | Attempted incidents needing a follow-up | resolvr_ai_worker_engagement | `attempted=true^follow_ups>0` | COUNT | period:closed_at | count | min | Documented |
| `l1_follow_up_rate_pct` | Follow-up rate | | `[[l1_followed_up]] / [[l1_attempted]] * 100` | FORMULA | | percent | min | Documented |

Standard breakdowns: incident KPIs by `priority`, `category`, `assignment_group`, `state`, `contact_type`; change by `type`, `risk`, `assignment_group`, `category`; problem by `priority`, `assignment_group`; request by `cat_item`, `assignment_group`. Age buckets use the report range Same Day, 2 Days, 2-5 Days, 5-7 Days, 1-2 Weeks, 2-4 Weeks, 1-2 Months, over 2 Months. **[Documented breakdown sets, assignment Inferred]**

## 6. Dashboards shipped with ResolvrNow

Sources: [im]incident-premium-dashboard.html, [chg]change-premium-dashboard.html, [chg]change-velocity-dashboard.html, [prb]problem-premium-dashboard.html, [sd]itsm-sdb-dasboard-overview.html, [otto]insights-opportunities-incident-dashboard.html, [otto]insights-opportunities-incident-dashboard-reference.html

| Dashboard / tab | Widgets (type: definition) | Filters | Basis |
|---|---|---|---|
| Incident / Overview | Single scores: Opened today (`opened_atONToday`), Unassigned (`active=true^assigned_toISEMPTY`), Overdue (`active=true^made_sla=false`), Open (`stateIN1,2,3`), Not updated for 7 days, Open older than 30 days. Bar: open by priority. Horizontal bar: open older than 30 days. Heatmaps: priority x state; priority x state older than 30 days; group x state older than 30 days; open with inactive assignee (`assigned_to.active=false`); open with closed problem (`problem_id.state=107`). Area: opened and closed per week | Priority, State, Assignment group, Category, Opened date | Documented (encodings Inferred) |
| Incident / KPIs | KPI scorecards with 90-day trend: `incident_open`, `mttr_incident`, `incident_resolved_within_sla_pct`, `incident_fcr_pct`, `incident_reopen_rate_pct`, `incident_backlog_age`, `incident_first_assignment_resolution_pct` | same | Inferred |
| Change / Overview | Single scores: Opened today, Unassigned, Overdue, On hold (`on_hold=true`), Conflicting (`conflict_status=Conflict`), Rejected (`approval=rejected`). Bars: open by priority; scheduled in next 30 days. Heatmap: risk x priority. Column: opened per month by type. Line: closed per month | Type, Risk, Assignment group | Documented |
| Change / Velocity | Awaiting CAB approval, high risk starting today, awaiting approvals; pies by model, type, category (30 days); pipeline by state; success by close code; risk counts; top 10 CIs by change activity (3 months); emergency changes (90 days); change-related incidents (90 days); unauthorized changes (90 days); active changes older than 7 days | | Documented |
| Problem / Overview | `problem_open`, `problem_avg_age_open`, `problem_known_error_pct`, `problem_with_incident_pct`, `problem_avg_close_time`, `problem_closed_no_notes_pct`; open by priority and state | Priority, State, Assignment group | Documented |
| Service level | `incident_resolved_within_sla_pct`, `incident_open_overdue_pct`, `incident_response_within_sla_pct`; breached SLAs by group | Assignment group, Priority | Documented |
| ITSM Success / Performance overview | `self_solved_pct`, `call_deflection_pct`, `ritm_completed`, `pi_predictions_correct`; monthly, quarterly, yearly views with period-over-period change; "View details" lists records | Period | Documented |
| ITSM Success / Service quality | `csat_score`, `incident_avg_close_time`, `incident_breached_sla_pct`, `incident_first_assignment_resolution_pct`, `incident_reopen_rate_pct` | Period | Documented |
| ITSM Success / Operational | One section per process (incident, major incident, change, request, catalog, interaction, problem, on-call) with that process's headline KPIs | Period | Documented concept |
| Insights and Opportunities for Incident | Dashboard view: incident volume with prior-period comparison and trend; SLA status (on track vs breached); sentiment trend; incident trends table (clusters ranked by count); top departments; geographic distribution; channel distribution; services by business criticality; top CI classes; groups with most reassignments. Trend view: AI summary (issues, probable causes), total incidents, average MTTR (note when insufficient data), SLA-breached count, total reassignments, priority breakdown, top categories (donut), top 10 departments by state, MTTR by group over time, SLA-breached open incidents, associated incidents (number, opened, short description, caller, sentiment, trend, priority, state, category, group, assignee) | Date range | Documented |

ResolvrNow builds trend categories from the clustering of §7 in `ai.md` (incidents in the selected range) and the AI summary from the `trend_summary` skill with an offline fallback listing the top terms and the three most frequent categories. **[Inferred]**

## 7. Process Mining (brief)

Sources: [chg]change-velocity-dashboard.html, [par]configuring-dashboards.html, [par]kpi-details-components.html, [sd]itsm-sdb-dasboard-overview.html

Process Mining reconstructs how records move between states (and assignment groups) to expose bottlenecks, loops and rework; it can be launched from an indicator ("run process analysis"), placed on dashboards as a process map, suggested by dashboard insights, and powers the Success Dashboard process insights (top two least efficient findings) and the change "Process Optimization" tab (enterprise tier). Role `sn_process_optimization_analyst`. **[Documented]** ResolvrNow v2: build a transition graph from field history of `state` and `assignment_group` (edge count, median and p90 duration, loop count), render as a directed graph, and flag edges whose median duration exceeds twice the process median. **[Inferred]**

## 8. ResolvrNow implementation plan

Sources: ResolvrNow design (rows marked per Basis), using sections 2 to 6.

| Area | Design | Basis |
|---|---|---|
| Query engine | Extend the SQL compiler with `GROUP BY`, aggregates and date bucketing (`interval`) per the Aggregate API; dot-walk joins reused; ACL row filter applied before aggregation | Inferred |
| Charts | React chart components (bar, column, line, area, pie, donut, single score, list, pivot, heatmap, gauge) fed by the §2.4 response; accessible data table toggle; consistent palette from design tokens | Inferred |
| Dashboards | 12-column grid editor (drag, resize), tabs + top stage, filters producing per-widget encoded queries, permissions, bookmarks, certification flag | Inferred |
| Caching | Per widget result cache keyed by definition hash + user ACL fingerprint + filter state; TTL = dashboard refresh interval (default 5 minutes); manual refresh bypasses | Inferred |
| KPI collector | Scheduler jobs from §4.2; scores in `pa_scores` (one row per KPI, date, breakdown, element); formulas resolved in dependency order; cycle detection rejects definitions | Inferred |
| KPI details page | Score, change vs previous, sparkline and chart with range picker, time aggregation, breakdown filter, records toggle (snapshots), targets and thresholds | Documented behaviour, Inferred UI |
| APIs | Table API for definitions; Aggregate API; report data endpoint; `GET /api/now/pa/scorecards` compatible subset (`sysparm_uuid`, `sysparm_include_scores`, `sysparm_from`, `sysparm_to`, `sysparm_breakdown`) | Documented / Inferred |
| Export | CSV for any widget; PDF via headless render (P3); scheduled email (`sysauto_report`) | Inferred |
| Seed data | Ship the §5 KPI catalogue and §6 dashboards as installable records | Inferred |

## 9. Acceptance tests

1. Given 5 incidents in states 1, 2, 3, 6, 7, when `incident_open` is collected, then the score is 3.
2. Given incidents resolved yesterday with `calendar_stc` 3600 and 7200 and one cancelled incident, when `mttr_incident` is collected for yesterday, then the score is 5400 seconds.
3. Given two resolution SLAs completed yesterday, one breached, when `incident_resolved_within_sla_pct` is computed, then the score is 50.
4. Given a resolution SLA with `stage=cancelled`, when SLA KPIs are collected, then it counts in neither numerator nor denominator.
5. Given 10 incidents resolved yesterday of which 2 were reopened yesterday, when `incident_reopen_rate_pct` is computed, then the score is 20.
6. Given a phone incident resolved yesterday by its opener with `reassignment_count=0`, when `incident_fcr_pct` is collected, then it counts in both numerator and denominator; with `reassignment_count=1` only in the denominator.
7. Given 4 closed changes yesterday with codes successful, successful, successful_issues, unsuccessful, when `change_success_rate_pct` is computed, then the score is 50.
8. Given 20 new changes yesterday including 3 emergency, when `change_emergency_rate_pct` is computed, then the score is 15.
9. Given `incident_new=0` for a day, when `problem_to_incident_ratio` is computed, then the score is null and the chart shows a gap.
10. Given a formula KPI referencing itself through another formula, when it is saved, then the definition is rejected with a cycle error.
11. Given open incidents opened 1 and 3 days ago at collection time, when `incident_backlog_age` is collected, then the score is 2 days.
12. Given 30 daily scores of a percentage KPI, when the monthly view is shown, then the value is the average of the daily percentages; counts show the sum of daily values.
13. Given a bar report on incident grouped by priority with `other_threshold=2` and four priorities, when it runs, then two groups and an "Other" bucket are returned and each point carries a drilldown query.
14. Given the user clicks the bar for priority 1, when the drilldown opens, then the list uses the report filter AND `priority=1` and rows the user cannot read are omitted with a notice.
15. Given a report with `show_empty=false`, when incidents have an empty category, then no empty group appears; with `show_empty=true` it appears.
16. Given a single score report with aggregate AVG on `reopen_count`, when it runs, then one value is returned (ResolvrNow supports aggregates on single score).
17. Given a line report with `trend_field=opened_at` and `interval=week`, when it runs over 3 months, then one point per week is returned in calendar order.
18. Given a pivot_v2 with rows priority and state and column category, when it runs, then cells hold counts and subtotals per row group.
19. Given a dashboard filter "Assignment group" in the top stage mapped to `assignment_group` on two widgets and to `task.assignment_group` on a task_sla widget, when a group is selected, then all three widgets refresh with the corresponding term.
20. Given a dashboard shared with group G as view only, when a member of G opens it, then the Edit button is hidden.
21. Given dashboard refresh interval 5 minutes, when the same widget is requested twice within 1 minute by users with identical ACLs, then the second response has `cached=true`.
22. Given a user without read access to `change_request`, when they open the Change dashboard, then change widgets show "no access" and no counts leak.
23. Given a global target 85 on `incident_resolved_within_sla_pct` with a review date next month, when the forecast passes 85, then KPI details shows "On track"; after the review date it shows Met or Not met.
24. Given a threshold "below 80" on the same KPI, when the collected score is 78, then subscribers receive one notification for that date.
25. Given `GET /api/now/stats/incident?sysparm_count=true&sysparm_group_by=priority&sysparm_query=active=true`, when called, then counts per priority are returned in the Aggregate API format.
26. Given `GET /api/now/pa/scorecards?sysparm_uuid=<incident_open id>&sysparm_include_scores=true&sysparm_from=2026-10-01`, when called, then scores from that date are returned.
