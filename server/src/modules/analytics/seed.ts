import type { Context } from '../../engine/context.js';
import { GLOBAL } from './access.js';
import { todayDate } from './dates.js';
import { KPI_CATALOGUE, type KpiSpec, RESOLVR_KPIS } from './kpi-catalogue.js';

/**
 * Shipped analytics content: indicator sources and indicators (spec section 5 plus
 * ResolvrNow additions), global targets, reports and the six default dashboards.
 * Everything is keyed (`resolvr_key`) and refers to tables by name, so it is created even
 * when the ITSM module behind a table is installed later; seeding is idempotent.
 */

interface ReportSeed {
  key: string;
  title: string;
  table: string;
  type: string;
  filter?: string;
  field?: string;
  stack?: string;
  aggregate?: string;
  sumfield?: string;
  trend?: string;
  interval?: string;
  row?: string;
  column?: string;
  fields?: string;
  threshold?: number;
  limit?: number;
  description?: string;
}

const ITSM_ROLES = 'itil';
const LAST_90 = 'javascript:gs.daysAgoStart(90)';
const LAST_30 = 'javascript:gs.daysAgoStart(30)';
const LAST_12_MONTHS = 'javascript:gs.monthsAgoStart(11)';

export const REPORT_SEEDS: ReportSeed[] = [
  // Work across all task types
  {
    key: 'rn.task.open_by_type',
    title: 'Open work by type',
    table: 'task',
    type: 'pie',
    filter: 'active=true',
    field: 'sys_class_name',
  },
  {
    key: 'rn.task.opened_per_week',
    title: 'Work opened per week by type',
    table: 'task',
    type: 'line',
    filter: `opened_at>=${LAST_90}`,
    trend: 'opened_at',
    interval: 'week',
    field: 'sys_class_name',
  },
  // Incident
  {
    key: 'rn.inc.open_count',
    title: 'Open incidents',
    table: 'incident',
    type: 'single_score',
    filter: 'stateIN1,2,3',
  },
  {
    key: 'rn.inc.unassigned',
    title: 'Unassigned incidents',
    table: 'incident',
    type: 'single_score',
    filter: 'active=true^assigned_toISEMPTY',
  },
  {
    key: 'rn.inc.overdue',
    title: 'Overdue incidents',
    table: 'incident',
    type: 'single_score',
    filter: 'active=true^made_sla=false',
  },
  {
    key: 'rn.inc.opened_today',
    title: 'Incidents opened today',
    table: 'incident',
    type: 'single_score',
    filter: 'opened_atONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()',
  },
  {
    key: 'rn.inc.open_by_priority',
    title: 'Open incidents by priority',
    table: 'incident',
    type: 'bar',
    filter: 'stateIN1,2,3',
    field: 'priority',
  },
  {
    key: 'rn.inc.open_by_state',
    title: 'Open incidents by state',
    table: 'incident',
    type: 'donut',
    filter: 'active=true',
    field: 'state',
  },
  {
    key: 'rn.inc.open_by_group',
    title: 'Open incidents by assignment group',
    table: 'incident',
    type: 'horizontal_bar',
    filter: 'stateIN1,2,3',
    field: 'assignment_group',
    threshold: 10,
  },
  {
    key: 'rn.inc.open_by_category',
    title: 'Open incidents by category',
    table: 'incident',
    type: 'pie',
    filter: 'stateIN1,2,3',
    field: 'category',
    threshold: 8,
  },
  {
    key: 'rn.inc.priority_state',
    title: 'Open incidents: priority by state',
    table: 'incident',
    type: 'heatmap',
    filter: 'active=true',
    row: 'priority',
    column: 'state',
  },
  {
    key: 'rn.inc.opened_per_week',
    title: 'Incidents opened per week',
    table: 'incident',
    type: 'area',
    filter: `opened_at>=${LAST_90}`,
    trend: 'opened_at',
    interval: 'week',
  },
  {
    key: 'rn.inc.resolved_per_week',
    title: 'Incidents resolved per week',
    table: 'incident',
    type: 'line',
    filter: `resolved_at>=${LAST_90}^state!=8`,
    trend: 'resolved_at',
    interval: 'week',
  },
  {
    key: 'rn.inc.older_30d_by_group',
    title: 'Open incidents older than 30 days by group',
    table: 'incident',
    type: 'horizontal_bar',
    filter: 'stateIN1,2,3^opened_at<javascript:gs.daysAgoStart(30)',
    field: 'assignment_group',
  },
  {
    key: 'rn.inc.mttr_by_priority',
    title: 'Mean time to resolve by priority (90 days)',
    table: 'incident',
    type: 'bar',
    filter: `resolved_at>=${LAST_90}^state!=8`,
    field: 'priority',
    aggregate: 'AVG',
    sumfield: 'calendar_stc',
    description: 'Average seconds from open to resolve',
  },
  {
    key: 'rn.inc.by_channel',
    title: 'Incidents by channel (30 days)',
    table: 'incident',
    type: 'donut',
    filter: `opened_at>=${LAST_30}`,
    field: 'contact_type',
  },
  {
    key: 'rn.inc.group_priority',
    title: 'Open incidents by group and priority',
    table: 'incident',
    type: 'pivot',
    filter: 'stateIN1,2,3',
    row: 'assignment_group',
    column: 'priority',
  },
  {
    key: 'rn.inc.critical_open',
    title: 'Open critical incidents',
    table: 'incident',
    type: 'list',
    filter: 'stateIN1,2,3^priority=1^ORDERBYDESCopened_at',
    fields: 'number,short_description,state,assignment_group,assigned_to,opened_at',
    limit: 10,
  },
  // Change
  {
    key: 'rn.chg.open_by_state',
    title: 'Open changes by state',
    table: 'change_request',
    type: 'bar',
    filter: 'active=true',
    field: 'state',
  },
  {
    key: 'rn.chg.by_type_30d',
    title: 'Changes by type (30 days)',
    table: 'change_request',
    type: 'pie',
    filter: `opened_at>=${LAST_30}`,
    field: 'type',
  },
  {
    key: 'rn.chg.risk_priority',
    title: 'Open changes: risk by priority',
    table: 'change_request',
    type: 'heatmap',
    filter: 'active=true',
    row: 'risk',
    column: 'priority',
  },
  {
    key: 'rn.chg.opened_per_month_by_type',
    title: 'Changes opened per month by type',
    table: 'change_request',
    type: 'column',
    filter: `opened_at>=${LAST_12_MONTHS}`,
    trend: 'opened_at',
    interval: 'month',
    field: 'type',
  },
  {
    key: 'rn.chg.closed_per_month',
    title: 'Changes closed per month',
    table: 'change_request',
    type: 'line',
    filter: `state=3^closed_at>=${LAST_12_MONTHS}`,
    trend: 'closed_at',
    interval: 'month',
  },
  {
    key: 'rn.chg.outcomes_90d',
    title: 'Change outcomes (90 days)',
    table: 'change_request',
    type: 'donut',
    filter: `state=3^closed_at>=${LAST_90}`,
    field: 'close_code',
  },
  {
    key: 'rn.chg.awaiting_approval',
    title: 'Changes awaiting approval',
    table: 'change_request',
    type: 'single_score',
    filter: 'active=true^approval=requested',
  },
  {
    key: 'rn.chg.emergency_90d',
    title: 'Emergency changes (90 days)',
    table: 'change_request',
    type: 'single_score',
    filter: `type=emergency^opened_at>=${LAST_90}`,
  },
  {
    key: 'rn.chg.next_30d',
    title: 'Changes scheduled in the next 30 days',
    table: 'change_request',
    type: 'list',
    filter:
      'active=true^start_date>=javascript:gs.beginningOfToday()^start_dateRELATIVELT@day@ahead@30^ORDERBYstart_date',
    fields: 'number,short_description,type,risk,state,start_date,assignment_group',
    limit: 15,
  },
  // Problem
  {
    key: 'rn.prb.open_by_priority',
    title: 'Open problems by priority',
    table: 'problem',
    type: 'bar',
    filter: 'active=true',
    field: 'priority',
  },
  {
    key: 'rn.prb.open_by_state',
    title: 'Open problems by state',
    table: 'problem',
    type: 'donut',
    filter: 'active=true',
    field: 'state',
  },
  {
    key: 'rn.prb.known_errors',
    title: 'Open known errors',
    table: 'problem',
    type: 'single_score',
    filter: 'active=true^known_error=true',
  },
  {
    key: 'rn.prb.opened_per_month',
    title: 'Problems opened per month',
    table: 'problem',
    type: 'line',
    filter: `opened_at>=${LAST_12_MONTHS}`,
    trend: 'opened_at',
    interval: 'month',
  },
  {
    key: 'rn.prb.open_list',
    title: 'Open problems',
    table: 'problem',
    type: 'list',
    filter: 'active=true^ORDERBYpriority',
    fields: 'number,short_description,state,priority,assignment_group,opened_at',
    limit: 20,
  },
  // Service levels
  {
    key: 'rn.sla.breached_by_group',
    title: 'Breached SLAs by assignment group (90 days)',
    table: 'task_sla',
    type: 'horizontal_bar',
    filter: `has_breached=true^stage!=cancelled^start_time>=${LAST_90}`,
    field: 'task.assignment_group',
    threshold: 10,
  },
  {
    key: 'rn.sla.by_stage',
    title: 'Task SLAs by stage (30 days)',
    table: 'task_sla',
    type: 'donut',
    filter: `start_time>=${LAST_30}`,
    field: 'stage',
  },
  {
    key: 'rn.sla.breached_per_week',
    title: 'Breached SLAs per week',
    table: 'task_sla',
    type: 'line',
    filter: `has_breached=true^stage!=cancelled^start_time>=${LAST_90}`,
    trend: 'start_time',
    interval: 'week',
  },
  {
    key: 'rn.sla.active_breached',
    title: 'Active breached SLAs',
    table: 'task_sla',
    type: 'single_score',
    filter: 'active=true^has_breached=true',
  },
  {
    key: 'rn.sla.elapsed_by_priority',
    title: 'Average elapsed percentage by priority',
    table: 'task_sla',
    type: 'bar',
    filter: 'active=true',
    field: 'task.priority',
    aggregate: 'AVG',
    sumfield: 'business_percentage',
  },
  {
    key: 'rn.sla.by_definition',
    title: 'SLAs by definition and breach (90 days)',
    table: 'task_sla',
    type: 'bar',
    filter: `stage!=cancelled^start_time>=${LAST_90}`,
    field: 'sla',
    stack: 'has_breached',
  },
  {
    key: 'rn.sla.breached_list',
    title: 'Active breached SLAs',
    table: 'task_sla',
    type: 'list',
    filter: 'active=true^has_breached=true^ORDERBYplanned_end_time',
    fields: 'task,sla,stage,planned_end_time,business_percentage',
    limit: 20,
  },
  // Request fulfilment
  {
    key: 'rn.ritm.open_count',
    title: 'Open requested items',
    table: 'sc_req_item',
    type: 'single_score',
    filter: 'active=true',
  },
  {
    key: 'rn.ritm.open_by_state',
    title: 'Open requested items by state',
    table: 'sc_req_item',
    type: 'bar',
    filter: 'active=true',
    field: 'state',
  },
  {
    key: 'rn.ritm.by_item_30d',
    title: 'Requested items by catalog item (30 days)',
    table: 'sc_req_item',
    type: 'horizontal_bar',
    filter: `opened_at>=${LAST_30}`,
    field: 'cat_item',
    threshold: 10,
  },
  {
    key: 'rn.ritm.opened_per_week',
    title: 'Requested items opened per week',
    table: 'sc_req_item',
    type: 'line',
    filter: `opened_at>=${LAST_90}`,
    trend: 'opened_at',
    interval: 'week',
  },
  {
    key: 'rn.ritm.fulfillment_by_item',
    title: 'Average fulfillment time by item (90 days)',
    table: 'sc_req_item',
    type: 'bar',
    filter: `state=3^closed_at>=${LAST_90}`,
    field: 'cat_item',
    aggregate: 'AVG',
    sumfield: 'calendar_duration',
    threshold: 10,
  },
  {
    key: 'rn.ritm.overdue',
    title: 'Overdue requested items',
    table: 'sc_req_item',
    type: 'list',
    filter: 'active=true^due_date<javascript:gs.nowDateTime()^ORDERBYdue_date',
    fields: 'number,cat_item,requested_for,state,due_date,assignment_group',
    limit: 20,
  },
  // Knowledge
  {
    key: 'rn.kb.by_state',
    title: 'Articles by workflow state',
    table: 'kb_knowledge',
    type: 'pie',
    field: 'workflow_state',
  },
  {
    key: 'rn.kb.published_by_base',
    title: 'Published articles by knowledge base',
    table: 'kb_knowledge',
    type: 'bar',
    filter: 'workflow_state=published',
    field: 'kb_knowledge_base',
  },
  {
    key: 'rn.kb.by_category',
    title: 'Published articles by category',
    table: 'kb_knowledge',
    type: 'horizontal_bar',
    filter: 'workflow_state=published',
    field: 'kb_category',
    threshold: 10,
  },
  {
    key: 'rn.kb.created_per_month',
    title: 'Articles created per month',
    table: 'kb_knowledge',
    type: 'line',
    filter: `sys_created_on>=${LAST_12_MONTHS}`,
    trend: 'sys_created_on',
    interval: 'month',
  },
  {
    key: 'rn.kb.top_viewed',
    title: 'Most viewed articles',
    table: 'kb_knowledge',
    type: 'list',
    filter: 'workflow_state=published^ORDERBYDESCsys_view_count',
    fields: 'number,short_description,kb_knowledge_base,sys_view_count,rating',
    limit: 10,
  },
  {
    key: 'rn.kb.rating_by_base',
    title: 'Average rating by knowledge base',
    table: 'kb_knowledge',
    type: 'bar',
    filter: 'workflow_state=published^rating>0',
    field: 'kb_knowledge_base',
    aggregate: 'AVG',
    sumfield: 'rating',
  },
  {
    key: 'rn.kb.published_count',
    title: 'Published articles',
    table: 'kb_knowledge',
    type: 'single_score',
    filter: 'workflow_state=published^active=true',
  },
];

interface WidgetSeed {
  report?: string;
  kpi?: string;
  tab?: string;
  w: number;
  h: number;
  title?: string;
}

interface FilterSeed {
  label: string;
  kind: 'select' | 'boolean' | 'date';
  /** Table and field the filter offers values from. */
  table: string;
  field: string;
  /** Report key to the field path the filter value applies to on that widget. */
  targets: Record<string, string>;
}

interface DashboardSeed {
  key: string;
  name: string;
  description: string;
  /** Roles granted view access. */
  viewRoles: string[];
  tabs?: string[];
  widgets: WidgetSeed[];
  filters?: FilterSeed[];
}

const INCIDENT_WIDGET_REPORTS = [
  'rn.inc.open_count',
  'rn.inc.unassigned',
  'rn.inc.overdue',
  'rn.inc.opened_today',
  'rn.inc.open_by_priority',
  'rn.inc.priority_state',
  'rn.inc.opened_per_week',
];
const SLA_WIDGET_REPORTS = [
  'rn.sla.breached_by_group',
  'rn.sla.by_stage',
  'rn.sla.breached_per_week',
  'rn.sla.breached_list',
];
const targetsFor = (reports: string[], path: string) => Object.fromEntries(reports.map((r) => [r, path]));

const kpi = (id: string, w = 3, tab?: string): WidgetSeed => ({ kpi: id, w, h: 2, tab });
const chart = (key: string, w = 6, h = 4, tab?: string): WidgetSeed => ({ report: key, w, h, tab });

export const DASHBOARD_SEEDS: DashboardSeed[] = [
  {
    key: 'rn.dash.service_desk',
    name: 'Service Desk Overview',
    description: 'Open work, incident backlog and requests at a glance.',
    viewRoles: ['itil'],
    widgets: [
      kpi('task_open'),
      kpi('incident_open'),
      kpi('incident_unassigned_open'),
      kpi('ritm_open'),
      chart('rn.task.open_by_type', 4),
      chart('rn.inc.open_by_group', 4),
      chart('rn.task.opened_per_week', 4),
      chart('rn.inc.critical_open', 12),
    ],
  },
  {
    key: 'rn.dash.incident',
    name: 'Incident Management',
    description: 'Incident volume, backlog health and resolution performance.',
    viewRoles: ['itil'],
    tabs: ['Overview', 'KPIs'],
    widgets: [
      { report: 'rn.inc.open_count', w: 3, h: 2, tab: 'Overview' },
      { report: 'rn.inc.unassigned', w: 3, h: 2, tab: 'Overview' },
      { report: 'rn.inc.overdue', w: 3, h: 2, tab: 'Overview' },
      { report: 'rn.inc.opened_today', w: 3, h: 2, tab: 'Overview' },
      chart('rn.inc.open_by_priority', 6, 4, 'Overview'),
      chart('rn.inc.priority_state', 6, 4, 'Overview'),
      chart('rn.inc.opened_per_week', 12, 4, 'Overview'),
      kpi('mttr_incident', 4, 'KPIs'),
      kpi('incident_resolved_within_sla_pct', 4, 'KPIs'),
      kpi('incident_fcr_pct', 4, 'KPIs'),
    ],
    filters: [
      {
        label: 'Priority',
        kind: 'select',
        table: 'incident',
        field: 'priority',
        targets: targetsFor(INCIDENT_WIDGET_REPORTS, 'priority'),
      },
      {
        label: 'Assignment group',
        kind: 'select',
        table: 'incident',
        field: 'assignment_group',
        targets: targetsFor(INCIDENT_WIDGET_REPORTS, 'assignment_group'),
      },
    ],
  },
  {
    key: 'rn.dash.change',
    name: 'Change Management',
    description: 'Change pipeline, risk and success rate.',
    viewRoles: ['itil'],
    widgets: [
      kpi('change_open', 4),
      kpi('change_success_rate_pct', 4),
      kpi('change_emergency_rate_pct', 4),
      chart('rn.chg.open_by_state'),
      chart('rn.chg.by_type_30d'),
      chart('rn.chg.risk_priority'),
      chart('rn.chg.opened_per_month_by_type'),
      chart('rn.chg.next_30d', 12),
    ],
  },
  {
    key: 'rn.dash.sla',
    name: 'Service Level Performance',
    description: 'Response and resolution SLAs, breaches and at-risk work.',
    viewRoles: ['itil'],
    widgets: [
      kpi('incident_resolved_within_sla_pct'),
      kpi('incident_open_overdue_pct'),
      kpi('incident_response_within_sla_pct'),
      kpi('incident_breached_sla_pct'),
      chart('rn.sla.breached_by_group'),
      chart('rn.sla.by_stage'),
      chart('rn.sla.breached_per_week', 12),
      chart('rn.sla.breached_list', 12),
    ],
    filters: [
      {
        label: 'Assignment group',
        kind: 'select',
        table: 'task',
        field: 'assignment_group',
        // SLA widgets reach the group through the task they measure.
        targets: targetsFor(SLA_WIDGET_REPORTS, 'task.assignment_group'),
      },
    ],
  },
  {
    key: 'rn.dash.request',
    name: 'Request Fulfillment',
    description: 'Requested item volume, fulfilment time and overdue requests.',
    viewRoles: ['itil'],
    widgets: [
      kpi('ritm_open'),
      kpi('ritm_new'),
      kpi('request_fulfillment_time'),
      kpi('ritm_on_time_pct'),
      chart('rn.ritm.open_by_state'),
      chart('rn.ritm.by_item_30d'),
      chart('rn.ritm.opened_per_week', 12),
      chart('rn.ritm.overdue', 12),
    ],
  },
  {
    key: 'rn.dash.knowledge',
    name: 'Knowledge',
    description: 'Knowledge base content, usage and quality.',
    viewRoles: ['snc_internal'],
    widgets: [
      kpi('kb_published'),
      kpi('kb_new'),
      kpi('kb_views'),
      kpi('kb_avg_rating'),
      chart('rn.kb.by_state', 4),
      chart('rn.kb.published_by_base', 4),
      chart('rn.kb.created_per_month', 4),
      chart('rn.kb.top_viewed', 12),
    ],
  },
];

/** Global targets shipped with the catalogue (ResolvrNow defaults, editable). */
const TARGET_SEEDS: { kpi: string; target: number }[] = [
  { kpi: 'incident_resolved_within_sla_pct', target: 85 },
  { kpi: 'incident_response_within_sla_pct', target: 90 },
  { kpi: 'incident_first_assignment_resolution_pct', target: 70 },
  { kpi: 'incident_fcr_pct', target: 70 },
  { kpi: 'incident_open_overdue_pct', target: 10 },
  { kpi: 'mttr_incident', target: 28_800 },
  { kpi: 'change_success_rate_pct', target: 95 },
  { kpi: 'ritm_on_time_pct', target: 90 },
  { kpi: 'kb_avg_rating', target: 4 },
];

const CUBE_NAMES: Record<string, string> = {
  task: 'Tasks',
  incident: 'Incidents',
  problem: 'Problems',
  change_request: 'Change requests',
  sc_req_item: 'Requested items',
  task_sla: 'Task SLAs',
  kb_knowledge: 'Knowledge articles',
  asmt_metric_result: 'Survey results',
  resolvr_self_service_event: 'Self-service events',
  interaction: 'Interactions',
  ml_predictor_results: 'Prediction results',
  sys_generative_ai_log: 'Generative AI log',
  resolvr_ai_worker_engagement: 'AI worker engagements',
};

const PRECISION: Record<string, number> = { count: 0, percent: 1, seconds: 0, days: 1, ratio: 2, score: 2 };

function describe(k: KpiSpec): string {
  if (k.aggregate === 'FORMULA') return `Formula: ${k.formula}`;
  const what =
    k.aggregate === 'COUNT'
      ? 'Number'
      : k.aggregate === 'AVG_AGE'
        ? 'Average age in days'
        : `${k.aggregate} of ${k.field}`;
  const when = k.mode === 'snapshot' ? 'at the end of each day' : `by ${k.dateField} date`;
  return `${what} of ${k.table} records${k.condition ? ` matching ${k.condition}` : ''}, ${when}.`;
}

function seedIndicators(ctx: Context): Map<string, string> {
  const ids = new Map<string, string>();
  const all = [...KPI_CATALOGUE, ...RESOLVR_KPIS];
  const cubes = new Map<string, string>();
  for (const c of ctx.query('pa_cubes')) cubes.set(c.str('facts_table'), c.sysId);
  for (const table of new Set(all.map((k) => k.table).filter((t): t is string => !!t))) {
    if (cubes.has(table)) continue;
    cubes.set(
      table,
      ctx.insert('pa_cubes', { name: CUBE_NAMES[table] ?? table, facts_table: table, frequency: 'daily' })
        .sysId,
    );
  }
  for (const k of all) {
    const existing = ctx.first('pa_indicators', `resolvr_key=${k.id}`);
    if (existing) {
      ids.set(k.id, existing.sysId);
      continue;
    }
    const rec = ctx.insert('pa_indicators', {
      name: k.label,
      resolvr_key: k.id,
      description: describe(k),
      type: k.aggregate === 'FORMULA' ? 'formula' : 'automated',
      cube: k.table ? cubes.get(k.table) : null,
      aggregate: k.aggregate,
      field: k.field ?? '',
      mode: k.mode ?? 'period',
      date_field: k.dateField ?? '',
      conditions: k.condition,
      predicate: k.predicate ?? '',
      formula: k.formula ?? '',
      unit: k.unit,
      precision: PRECISION[k.unit] ?? 2,
      direction: k.direction,
      frequency: 'daily',
      active: true,
    });
    ids.set(k.id, rec.sysId);
  }
  const year = todayDate().slice(0, 4);
  for (const t of TARGET_SEEDS) {
    const indicator = ids.get(t.kpi);
    if (!indicator || ctx.first('pa_targets', `indicator=${indicator}^personal_forISEMPTY`)) continue;
    ctx.insert('pa_targets', {
      indicator,
      target: t.target,
      start_at: `${year}-01-01`,
      review_date: `${year}-12-31`,
    });
  }
  return ids;
}

function seedReports(ctx: Context): Map<string, string> {
  const ids = new Map<string, string>();
  for (const r of REPORT_SEEDS) {
    const existing = ctx.first('sys_report', `resolvr_key=${r.key}`);
    if (existing) {
      ids.set(r.key, existing.sysId);
      continue;
    }
    const rec = ctx.insert('sys_report', {
      resolvr_key: r.key,
      title: r.title,
      description: r.description ?? '',
      table: r.table,
      type: r.type,
      source_type: 'table',
      filter: r.filter ?? '',
      field: r.field ?? '',
      stack_field: r.stack ?? '',
      aggregate: r.aggregate ?? 'COUNT',
      sumfield: r.sumfield ?? '',
      trend_field: r.trend ?? '',
      interval: r.interval ?? (r.trend ? 'week' : 'year'),
      row: r.row ?? '',
      column: r.column ?? '',
      field_list: r.fields ?? '',
      others: 'yes',
      other_threshold: r.threshold ?? 0,
      show_empty: false,
      properties: r.limit ? JSON.stringify({ limit: r.limit }) : '',
      user: GLOBAL,
      roles: r.table === 'kb_knowledge' ? '' : ITSM_ROLES,
      is_published: false,
    });
    ids.set(r.key, rec.sysId);
  }
  return ids;
}

/** Flow layout on the 12-column grid, per tab. */
function layout(widgets: WidgetSeed[]): { x: number; y: number }[] {
  const cursor = new Map<string, { x: number; y: number; rowH: number }>();
  return widgets.map((w) => {
    const key = w.tab ?? '';
    const c = cursor.get(key) ?? { x: 0, y: 0, rowH: 0 };
    if (c.x + w.w > 12) {
      c.y += c.rowH;
      c.x = 0;
      c.rowH = 0;
    }
    const pos = { x: c.x, y: c.y };
    c.x += w.w;
    c.rowH = Math.max(c.rowH, w.h);
    cursor.set(key, c);
    return pos;
  });
}

function seedDashboards(ctx: Context, reports: Map<string, string>, indicators: Map<string, string>): void {
  for (const d of DASHBOARD_SEEDS) {
    if (ctx.first('par_dashboard', `resolvr_key=${d.key}`)) continue;
    const dash = ctx.insert('par_dashboard', {
      name: d.name,
      description: d.description,
      resolvr_key: d.key,
      active: true,
      certified: true,
      categories: 'IT Service Management',
      refresh_interval_min: 5,
    });
    const tabs = new Map<string, string>();
    (d.tabs ?? []).forEach((name, i) => {
      tabs.set(
        name,
        ctx.insert('par_dashboard_tab', { dashboard: dash.sysId, name, order: (i + 1) * 100 }).sysId,
      );
    });
    const positions = layout(d.widgets);
    const widgetByReport = new Map<string, string>();
    d.widgets.forEach((w, i) => {
      const component = w.report ? reports.get(w.report) : w.kpi ? indicators.get(w.kpi) : undefined;
      if (!component) return;
      const widget = ctx.insert('par_dashboard_widget', {
        dashboard: dash.sysId,
        tab: w.tab ? (tabs.get(w.tab) ?? null) : null,
        kind: w.kpi ? 'kpi_scorecard' : 'visualization',
        component_table: w.kpi ? 'pa_indicators' : 'sys_report',
        component,
        x: positions[i].x,
        y: positions[i].y,
        w: w.w,
        h: w.h,
        title_override: w.title ?? '',
      });
      if (w.report) widgetByReport.set(w.report, widget.sysId);
    });
    // Top-stage filters: each maps the widgets it drives to the field path the value applies to.
    for (const f of d.filters ?? []) {
      const targets: Record<string, string> = {};
      for (const [report, path] of Object.entries(f.targets)) {
        const widget = widgetByReport.get(report);
        if (widget) targets[widget] = path;
      }
      ctx.insert('par_dashboard_filter', {
        dashboard: dash.sysId,
        label: f.label,
        kind: f.kind,
        table: f.table,
        field: f.field,
        targets: JSON.stringify(targets),
      });
    }
    for (const role of d.viewRoles) {
      const r = ctx.first('sys_user_role', `name=${role}`);
      if (r) ctx.insert('par_dashboard_permission', { dashboard: dash.sysId, role: r.sysId, access: 'view' });
    }
  }
}

export function seedAnalytics(ctx: Context): void {
  const sctx = ctx.derive({ audit: false });
  const indicators = seedIndicators(sctx);
  const reports = seedReports(sctx);
  seedDashboards(sctx, reports, indicators);
}
