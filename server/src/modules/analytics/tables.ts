import type { ChoiceDef, ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';

/**
 * Analytics schema (analytics spec sections 2 to 4 and `tables` in data/ai-analytics.json).
 * Platform table names are reused where the spec names them: `sys_report` for report
 * definitions, the `par_dashboard` family for dashboards and the `pa_*` family for indicators.
 */

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });
const choices = (pairs: [string, string][]): ChoiceDef[] => pairs.map(([v, l], i) => c(v, l, i + 1));

export const REPORT_TYPE_CHOICES = choices([
  ['bar', 'Vertical bar'],
  ['horizontal_bar', 'Horizontal bar'],
  ['pareto', 'Pareto'],
  ['hist', 'Histogram'],
  ['pie', 'Pie'],
  ['donut', 'Donut'],
  ['semi_donut', 'Semi donut'],
  ['line', 'Line'],
  ['line_bar', 'Line and bar'],
  ['area', 'Area'],
  ['spline', 'Spline'],
  ['step_line', 'Step line'],
  ['column', 'Column'],
  ['pivot', 'Pivot table'],
  ['pivot_v2', 'Multilevel pivot'],
  ['heatmap', 'Heatmap'],
  ['bubble', 'Bubble'],
  ['single_score', 'Single score'],
  ['speedometer', 'Speedometer'],
  ['dial', 'Dial'],
  ['list', 'List'],
  ['calendar', 'Calendar'],
  ['map', 'Map'],
  ['funnel', 'Funnel'],
  ['pyramid', 'Pyramid'],
  ['box', 'Box'],
  ['trendbox', 'Trendbox'],
  ['control', 'Control'],
  ['trend', 'Trend'],
]);

export const REPORT_AGGREGATE_CHOICES = choices([
  ['COUNT', 'Count'],
  ['COUNT_DISTINCT', 'Count distinct'],
  ['AVG', 'Average'],
  ['SUM', 'Sum'],
  ['MIN', 'Minimum'],
  ['MAX', 'Maximum'],
  ['STDDEV', 'Standard deviation'],
]);

export const REPORT_INTERVAL_CHOICES = choices([
  ['year', 'Year'],
  ['quarter', 'Quarter'],
  ['month', 'Month'],
  ['week', 'Week'],
  ['dayofweek', 'Day of week'],
  ['hour', 'Hour'],
  ['date', 'Date'],
]);

const INDICATOR_AGGREGATES = choices([
  ['COUNT', 'Count'],
  ['COUNT_DISTINCT', 'Count distinct'],
  ['SUM', 'Sum'],
  ['AVG', 'Average'],
  ['MIN', 'Minimum'],
  ['MAX', 'Maximum'],
  ['AVG_AGE', 'Average age in days'],
  ['FORMULA', 'Formula'],
]);

const FREQUENCY = choices([
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
]);

const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});
const bool = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  ...extra,
});
const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const fieldName = (name: string, label: string): ColumnDef => ({
  name,
  label,
  type: 'field_name',
  maxLength: 255,
  dependentOn: 'table',
});

/** Stable seed key shared by seeded reports, dashboards and indicators (ResolvrNow column). */
const resolvrKey = (): ColumnDef =>
  str('resolvr_key', 'Key', { maxLength: 80, indexed: true, hint: 'Stable identifier of shipped content' });

/** Dashboard child rows follow their dashboard (deleted with it). */
const dashboardRef = (): ColumnDef =>
  ref('dashboard', 'Dashboard', 'par_dashboard', { mandatory: true, cascade: 'delete' });

export const analyticsTables: TableDef[] = [
  // ------------------------------------------------------------------ visualizations
  sdkTable('par_component', {
    label: 'Analytics Component',
    displayField: 'name',
    exclude: ['macroponent', 'required_translations'],
  }),
  sdkTable('analytics_visualization', { label: 'Analytics Visualization' }),
  sdkTable('sys_report', {
    label: 'Report',
    displayField: 'title',
    audit: true,
    textIndex: ['title', 'description'],
    exclude: [
      'sc_groupby_item_id',
      'sc_groupby_variable_id',
      'sc_stackby_item_id',
      'sc_stackby_variable_id',
      'import_table',
      'map',
      'map_source',
      'page_hdrftr',
      'no_bulk_migration',
    ],
    patch: {
      title: { mandatory: true },
      table: { mandatory: true },
      filter: { dependentOn: 'table' },
      field: { type: 'field_name', label: 'Group by', dependentOn: 'table' },
      trend_field: { type: 'field_name', label: 'Trend by', dependentOn: 'table' },
      sumfield: { type: 'field_name', label: 'Aggregation field', dependentOn: 'table' },
      field_list: { dependentOn: 'table' },
      orderby_list: { dependentOn: 'table' },
      aggregate: { choices: REPORT_AGGREGATE_CHOICES, defaultValue: 'COUNT' },
      interval: { choices: REPORT_INTERVAL_CHOICES },
      compute_percent: {
        choices: choices([
          ['aggregate', 'Use aggregation'],
          ['count', 'Use record count'],
        ]),
      },
      others: {
        choices: choices([
          ['yes', 'Show Other group'],
          ['no', 'Hide Other group'],
        ]),
      },
      other_threshold: { hint: 'Max groups before the Other bucket; 0 = show all (up to 50)' },
      show_chart_title: {
        choices: choices([
          ['never', 'Never'],
          ['report', 'Report only'],
          ['always', 'Always'],
        ]),
      },
      chart_size: {
        choices: choices([
          ['small', 'Small'],
          ['medium', 'Medium'],
          ['large', 'Large'],
        ]),
      },
      source_type: {
        choices: choices([
          ['table', 'Table'],
          ['source', 'Report source'],
          ['import', 'External import'],
          ['metricbase', 'MetricBase'],
        ]),
        defaultValue: 'table',
      },
      set_color: {
        choices: choices([
          ['one_color', 'Use one color'],
          ['color_palette', 'Use color palette'],
          ['several_colors', 'Use several colors'],
        ]),
      },
      direction: {
        choices: choices([
          ['minimize', 'Minimize'],
          ['maximize', 'Maximize'],
        ]),
      },
      user: { hint: 'Owner sys_id for personal reports, GLOBAL to share with everyone' },
      report_source: { cascade: 'restrict' },
    },
    columns: [
      { ...fieldName('stack_field', 'Stack by'), hint: 'Field used to stack bar and column reports' },
      {
        ...fieldName('box_field', 'Box field'),
        hint: 'Numeric field for box, trendbox and histogram reports',
      },
      resolvrKey(),
    ],
    overrides: {
      type: { choices: REPORT_TYPE_CHOICES, defaultValue: 'bar' },
      description: { maxLength: 4000 },
    },
  }),
  {
    name: 'sys_report_source',
    label: 'Report Source',
    displayField: 'name',
    columns: [
      str('name', 'Name', { maxLength: 100, mandatory: true }),
      { name: 'table', label: 'Table', type: 'table_name', mandatory: true },
      { name: 'filter', label: 'Filter', type: 'conditions', dependentOn: 'table' },
      str('description', 'Description', { maxLength: 4000 }),
      bool('active', 'Active', { defaultValue: 'true' }),
    ],
  },
  {
    name: 'sys_report_users_groups',
    label: 'Report Users and Groups',
    displayField: 'report_id',
    columns: [
      ref('report_id', 'Report', 'sys_report', { mandatory: true, cascade: 'delete' }),
      ref('user_id', 'User', 'sys_user', { cascade: 'delete' }),
      ref('group_id', 'Group', 'sys_user_group', { cascade: 'delete' }),
    ],
    indexes: [['report_id']],
  },

  // ------------------------------------------------------------------ dashboards
  sdkTable('analytics_dashboard', { displayField: 'name', exclude: ['ready_to_migrate'] }),
  {
    name: 'par_dashboard',
    label: 'Dashboard',
    extends: 'analytics_dashboard',
    displayField: 'name',
    audit: true,
    textIndex: ['name', 'description'],
    columns: [
      ref('owner', 'Owner', 'sys_user'),
      ref('requester', 'Requester', 'sys_user'),
      str('categories', 'Categories', { maxLength: 1000 }),
      int('refresh_interval_min', 'Refresh interval (minutes)', { defaultValue: '5' }),
      bool('cache_enabled', 'Cache data', { defaultValue: 'true' }),
      str('allowed_workspaces', 'Allowed workspaces', { maxLength: 1000 }),
      resolvrKey(),
    ],
  },
  {
    name: 'par_dashboard_tab',
    label: 'Dashboard Tab',
    displayField: 'name',
    columns: [
      dashboardRef(),
      str('name', 'Name', { maxLength: 100, mandatory: true }),
      int('order', 'Order', { defaultValue: '100' }),
      str('background_color', 'Background color', { maxLength: 20 }),
    ],
  },
  {
    name: 'par_dashboard_widget',
    label: 'Dashboard Widget',
    displayField: 'title_override',
    columns: [
      dashboardRef(),
      ref('tab', 'Tab', 'par_dashboard_tab', { hint: 'Empty = top stage', cascade: 'delete' }),
      str('kind', 'Kind', {
        defaultValue: 'visualization',
        choices: choices([
          ['visualization', 'Data visualization'],
          ['kpi_scorecard', 'KPI scorecard'],
          ['filter', 'Filter'],
          ['heading', 'Heading'],
          ['text', 'Rich text'],
          ['image', 'Image'],
          ['list', 'List'],
          ['divider', 'Divider'],
        ]),
      }),
      { name: 'component_table', label: 'Component table', type: 'table_name' },
      { name: 'component', label: 'Component', type: 'document_id', dependentOn: 'component_table' },
      int('x', 'X', { defaultValue: '0' }),
      int('y', 'Y', { defaultValue: '0' }),
      int('w', 'Width (of 12)', { defaultValue: '4' }),
      int('h', 'Height (rows)', { defaultValue: '3' }),
      str('title_override', 'Title', { maxLength: 100 }),
      { name: 'config', label: 'Configuration', type: 'json' },
    ],
  },
  {
    name: 'par_dashboard_filter',
    label: 'Dashboard Filter',
    displayField: 'label',
    columns: [
      dashboardRef(),
      ref('tab', 'Tab', 'par_dashboard_tab', { cascade: 'delete' }),
      str('label', 'Label', { maxLength: 100 }),
      str('kind', 'Kind', {
        defaultValue: 'select',
        choices: choices([
          ['select', 'Select'],
          ['cascading', 'Cascading select'],
          ['boolean', 'True/False'],
          ['date', 'Date'],
        ]),
      }),
      { name: 'table', label: 'Table', type: 'table_name' },
      str('field', 'Field', { maxLength: 255 }),
      str('default_value', 'Default value', { maxLength: 4000 }),
      { name: 'targets', label: 'Targets (widget to field path)', type: 'json' },
    ],
  },
  {
    name: 'par_dashboard_permission',
    label: 'Dashboard Permission',
    displayField: 'dashboard',
    columns: [
      dashboardRef(),
      ref('user', 'User', 'sys_user', { cascade: 'delete' }),
      ref('group', 'Group', 'sys_user_group', { cascade: 'delete' }),
      ref('role', 'Role', 'sys_user_role', { cascade: 'delete' }),
      str('access', 'Access', {
        defaultValue: 'view',
        choices: choices([
          ['view', 'Can view'],
          ['edit', 'Can edit'],
        ]),
      }),
    ],
    indexes: [['dashboard']],
  },

  // ------------------------------------------------------------------ indicators
  {
    name: 'pa_cubes',
    label: 'Indicator Source',
    displayField: 'name',
    columns: [
      str('name', 'Name', { maxLength: 100, mandatory: true }),
      { name: 'facts_table', label: 'Facts table', type: 'table_name', mandatory: true },
      { name: 'conditions', label: 'Conditions', type: 'conditions', dependentOn: 'facts_table' },
      str('frequency', 'Frequency', { defaultValue: 'daily', choices: FREQUENCY }),
    ],
  },
  {
    name: 'pa_indicators',
    label: 'Indicator',
    displayField: 'name',
    audit: true,
    textIndex: ['name', 'description', 'resolvr_key'],
    columns: [
      str('name', 'Name', { maxLength: 100, mandatory: true }),
      str('resolvr_key', 'Key', {
        maxLength: 80,
        indexed: true,
        hint: 'Stable id, for example mttr_incident',
      }),
      str('description', 'Description', { maxLength: 4000 }),
      str('type', 'Type', {
        defaultValue: 'automated',
        choices: choices([
          ['automated', 'Automated'],
          ['formula', 'Formula'],
          ['manual', 'Manual'],
          ['external', 'External'],
        ]),
      }),
      ref('cube', 'Indicator source', 'pa_cubes', { cascade: 'restrict' }),
      str('aggregate', 'Aggregate', { defaultValue: 'COUNT', choices: INDICATOR_AGGREGATES }),
      str('field', 'Field', { maxLength: 255 }),
      str('mode', 'Mode', {
        defaultValue: 'period',
        choices: choices([
          ['snapshot', 'Snapshot at end of score date'],
          ['period', 'Events within score date'],
        ]),
      }),
      str('date_field', 'Date field', { maxLength: 255 }),
      { name: 'conditions', label: 'Additional conditions', type: 'conditions' },
      str('predicate', 'Predicate', { maxLength: 255 }),
      str('formula', 'Formula', { maxLength: 4000 }),
      str('unit', 'Unit', {
        defaultValue: 'count',
        choices: choices([
          ['count', '#'],
          ['seconds', 'Seconds'],
          ['days', 'Days'],
          ['percent', '%'],
          ['ratio', 'Ratio'],
          ['score', 'Score'],
        ]),
      }),
      int('precision', 'Precision', { defaultValue: '2' }),
      str('direction', 'Direction', {
        defaultValue: 'none',
        choices: choices([
          ['none', 'None'],
          ['maximize', 'Maximize'],
          ['minimize', 'Minimize'],
        ]),
      }),
      str('frequency', 'Frequency', { defaultValue: 'daily', choices: FREQUENCY }),
      bool('collect_records', 'Collect records (snapshots)', { defaultValue: 'false' }),
      bool('show_in_library', 'Show in library', { defaultValue: 'true' }),
      bool('active', 'Active', { defaultValue: 'true' }),
    ],
  },
  {
    name: 'pa_scores',
    label: 'Score',
    displayField: 'start_at',
    columns: [
      ref('indicator', 'Indicator', 'pa_indicators', { mandatory: true, cascade: 'delete' }),
      str('element', 'Element', { maxLength: 255, hint: 'Empty = total' }),
      { name: 'start_at', label: 'Score date', type: 'glide_date', mandatory: true },
      { name: 'value', label: 'Value', type: 'decimal' },
      bool('approximate', 'Approximate (historic snapshot)', { defaultValue: 'false' }),
    ],
    indexes: [['indicator', 'start_at']],
  },
  {
    name: 'pa_targets',
    label: 'Target',
    displayField: 'indicator',
    columns: [
      ref('indicator', 'Indicator', 'pa_indicators', { mandatory: true, cascade: 'delete' }),
      str('element', 'Element', { maxLength: 255 }),
      { name: 'target', label: 'Target', type: 'decimal', mandatory: true },
      { name: 'start_at', label: 'Start date', type: 'glide_date', mandatory: true },
      { name: 'review_date', label: 'Review date', type: 'glide_date' },
      ref('personal_for', 'Personal for user', 'sys_user', { hint: 'Empty = global', cascade: 'delete' }),
      ref('responsible', 'Responsible', 'sys_user'),
    ],
  },
];
