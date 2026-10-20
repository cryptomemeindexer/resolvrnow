import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { AppModule } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { AclDef } from '../../engine/services/acl.js';
import { SERVICES } from '../contracts.js';
import {
  canEditReport,
  canReadIndicatorScores,
  canViewReport,
  DASHBOARD_CREATOR_ROLES,
  dashboardAccess,
  PA_ADMIN_ROLES,
  parentDashboardAccess,
  REPORT_CREATOR_ROLES,
  sharingError,
} from './access.js';
import { registerAnalyticsApi } from './api.js';
import {
  backfillScores,
  type CollectResult,
  findCycle,
  type Indicator,
  IndicatorSet,
  type KpiCard,
  KpiEngine,
  type KpiPeriod,
  kpiScorecards,
  parseFormula,
  runSnapshotJob,
} from './kpis.js';
import { normalizeDefinition, type ReportResult, type RunOptions, runReport } from './reports.js';
import { seedAnalytics } from './seed.js';
import { analyticsTables } from './tables.js';

/** Service registered as `analytics` for other modules (AI insights, portals, notifications). */
export interface AnalyticsService {
  runReport(ctx: Context, definition: Record<string, unknown>, opts?: RunOptions): ReportResult;
  scorecards(ctx: Context, ids: string[], opts?: { period?: KpiPeriod; days?: number }): KpiCard[];
  collect(): CollectResult;
  backfill(opts?: { days?: number; from?: string; to?: string; keys?: string[] }): CollectResult;
}

function analyticsService(platform: Platform): AnalyticsService {
  return {
    runReport: (ctx, definition, opts) => runReport(ctx, normalizeDefinition(definition), opts),
    scorecards: (ctx, ids, opts) => {
      const set = new IndicatorSet(platform);
      const list = ids.length
        ? ids.map((id) => set.get(id)).filter((i): i is Indicator => !!i)
        : set.list.filter((i) => i.active);
      return kpiScorecards(ctx, list, opts, new KpiEngine(platform, set));
    },
    collect: () => runSnapshotJob(platform),
    backfill: (opts) => backfillScores(platform, opts),
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

/** ACLs of dashboard child rows (tabs, widgets, filters): read with the dashboard, change with edit access. */
function dashboardChildAcls(name: string, readNeedsEdit = false): AclDef[] {
  return [
    {
      name,
      operation: 'read',
      script: (rec, ctx) => {
        const a = parentDashboardAccess(ctx, rec);
        return a === 'table' || (readNeedsEdit ? a === 'edit' : !!a);
      },
      description: 'Follows the read access of the dashboard',
    },
    ...(['create', 'write', 'delete'] as const).map((operation) => ({
      name,
      operation,
      script: (rec: Rec | null, ctx: Context) => {
        const a = parentDashboardAccess(ctx, rec);
        return a === 'table' ? ctx.hasAnyRole(DASHBOARD_CREATOR_ROLES) : a === 'edit';
      },
      description: 'Requires edit access to the dashboard',
    })),
  ];
}

const adminOnly = (name: string, roles: string[]): AclDef[] =>
  (['create', 'write', 'delete'] as const).map((operation) => ({ name, operation, roles }));

/** Reports, dashboards and ITSM indicators (analytics spec). */
export const analyticsModule: AppModule = {
  id: 'analytics',
  name: 'Analytics',
  description: 'Reports, dashboards and ITSM KPIs.',
  dependsOn: ['task'],
  tables: analyticsTables,
  roles: [
    { name: 'report_group', description: 'Can share reports with groups', contains: ['report_user'] },
    { name: 'report_global', description: 'Can share reports with everyone', contains: ['report_group'] },
    { name: 'pa_admin', description: 'Administers indicators, targets and score collection' },
    { name: 'dashboard_admin', description: 'Manages and certifies dashboards' },
  ],
  acls: [
    {
      name: 'sys_report',
      operation: 'read',
      script: (rec, ctx) => !rec || canViewReport(ctx, rec),
      description: 'Report visibility: owner, everyone, groups, shared users and roles',
    },
    { name: 'sys_report', operation: 'create', roles: REPORT_CREATOR_ROLES },
    {
      name: 'sys_report',
      operation: 'write',
      script: (rec, ctx) => canEditReport(ctx, rec),
      description: 'Owner or report_admin',
    },
    {
      name: 'sys_report',
      operation: 'delete',
      script: (rec, ctx) => canEditReport(ctx, rec),
      description: 'Owner or report_admin',
    },
    {
      name: 'sys_report_users_groups',
      operation: 'read',
      script: (rec, ctx) => {
        if (!rec) return true;
        const report = ctx.elevated().get('sys_report', rec.str('report_id'));
        return !!report && canViewReport(ctx, report);
      },
    },
    ...(['create', 'write', 'delete'] as const).map((operation) => ({
      name: 'sys_report_users_groups',
      operation,
      script: (rec: Rec | null, ctx: Context) => {
        if (!rec) return ctx.hasAnyRole(REPORT_CREATOR_ROLES);
        const report = ctx.elevated().get('sys_report', rec.str('report_id'));
        return !!report && canEditReport(ctx, report);
      },
    })),
    { name: 'sys_report_source', operation: 'read', roles: ['snc_internal'] },
    ...adminOnly('sys_report_source', ['report_admin']),
    {
      name: 'par_dashboard',
      operation: 'read',
      script: (rec, ctx) => !rec || !!dashboardAccess(ctx, rec),
      description: 'Owner, requester, permission rows, report_admin or dashboard_admin',
    },
    { name: 'par_dashboard', operation: 'create', roles: DASHBOARD_CREATOR_ROLES },
    ...(['write', 'delete'] as const).map((operation) => ({
      name: 'par_dashboard',
      operation,
      script: (rec: Rec | null, ctx: Context) =>
        rec ? dashboardAccess(ctx, rec) === 'edit' : ctx.hasAnyRole(DASHBOARD_CREATOR_ROLES),
    })),
    ...dashboardChildAcls('par_dashboard_tab'),
    ...dashboardChildAcls('par_dashboard_widget'),
    ...dashboardChildAcls('par_dashboard_filter'),
    ...dashboardChildAcls('par_dashboard_permission', true),
    ...['pa_cubes', 'pa_indicators', 'pa_targets'].flatMap((name): AclDef[] => [
      { name, operation: 'read', roles: ['snc_internal'] },
      ...adminOnly(name, PA_ADMIN_ROLES),
    ]),
    {
      name: 'pa_scores',
      operation: 'read',
      script: (rec, ctx) => !rec || canReadIndicatorScores(ctx, rec.str('indicator')),
      description: 'Scores are readable with read access to the facts tables behind the indicator',
    },
    ...adminOnly('pa_scores', ['pa_admin']),
  ],
  rules: [
    {
      name: 'Report: owner and default visibility',
      table: 'sys_report',
      when: 'before',
      actions: ['insert'],
      order: 50,
      run(cur, _prev, ctx) {
        const me = ctx.user.isSystem ? null : ctx.user.sysId;
        if (!me) return;
        if (!cur.str('created_by_user')) cur.setRaw('created_by_user', me);
        // New reports are personal until shared.
        if (!cur.str('user') && !cur.str('group')) cur.setRaw('user', me);
      },
    },
    {
      name: 'Report: sharing requires the sharing roles',
      table: 'sys_report',
      when: 'before',
      actions: ['insert', 'update'],
      order: 60,
      run(cur, _prev, ctx) {
        const error = sharingError(ctx, cur);
        if (error) cur.abort(error);
      },
    },
    {
      name: 'Indicator: key and formula validation',
      table: 'pa_indicators',
      when: 'before',
      actions: ['insert', 'update'],
      order: 50,
      run(cur, _prev, ctx) {
        if (!cur.str('resolvr_key') && cur.str('name')) cur.setRaw('resolvr_key', slug(cur.str('name')));
        const formula = cur.str('formula');
        if (!formula || !(cur.isNew() || cur.changed('formula') || cur.changed('resolvr_key'))) return;
        try {
          parseFormula(formula);
        } catch (e) {
          cur.abort(e instanceof Error ? e.message : 'Invalid formula');
          return;
        }
        const formulas = new Map<string, string>();
        const keys = new Map<string, string>();
        for (const r of ctx.elevated().query('pa_indicators')) {
          if (r.sysId === cur.sysId) continue;
          const key = r.str('resolvr_key') || r.sysId;
          keys.set(key, key);
          if (!keys.has(r.str('name'))) keys.set(r.str('name'), key);
          if (r.str('formula')) formulas.set(key, r.str('formula'));
        }
        const key = cur.str('resolvr_key') || cur.sysId;
        keys.set(key, key);
        keys.set(cur.str('name'), key);
        formulas.set(key, formula);
        const cycle = findCycle(key, formulas, (ref) => keys.get(ref) ?? ref);
        if (cycle) cur.abort(`Formula creates a cycle: ${cycle.join(' -> ')}`);
      },
    },
    {
      name: 'Dashboard: owner defaults to the creator',
      table: 'par_dashboard',
      when: 'before',
      actions: ['insert'],
      order: 50,
      condition: (cur, _prev, ctx) => !cur.str('owner') && !ctx.user.isSystem && !!ctx.user.sysId,
      run(cur, _prev, ctx) {
        cur.setRaw('owner', ctx.user.sysId);
      },
    },
  ],
  properties: [
    {
      name: 'resolvr.analytics.backfill_days',
      value: '90',
      type: 'integer',
      description: 'Days of indicator history computed when demo data loads or a backfill runs',
    },
    {
      name: 'resolvr.analytics.catchup_days',
      value: '7',
      type: 'integer',
      description: 'Days the score collection job looks back for missing scores',
    },
    {
      name: 'resolvr.analytics.acl_row_check_limit',
      value: '20000',
      type: 'integer',
      description:
        'Maximum records per report checked against row-level read ACLs (above it only query business rules apply)',
    },
    {
      name: 'resolvr.analytics.max_groups',
      value: '50',
      type: 'integer',
      description: 'Maximum groups shown before the remaining groups fold into Other',
    },
    {
      name: 'resolvr.analytics.list_limit',
      value: '100',
      type: 'integer',
      description: 'Default number of rows of list reports',
    },
  ],
  jobs: [
    {
      id: 'resolvr.analytics.snapshot',
      name: 'Collect daily indicator scores',
      description:
        "Stores today's indicator scores (refreshed every hour), finalizes yesterday's and fills recent gaps",
      intervalMs: 3_600_000,
      initialDelayMs: 60_000,
      run(ctx) {
        runSnapshotJob(ctx.platform);
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'analytics',
        title: 'Analytics',
        icon: 'bar-chart-3',
        roles: ['itil', 'report_user', 'report_admin', 'pa_admin', 'dashboard_admin'],
        order: 700,
        modules: [
          { title: 'Dashboards', route: '/workspace/dashboards' },
          { title: 'Reports', table: 'sys_report', query: 'ORDERBYtitle' },
          { title: 'Indicators', table: 'pa_indicators', query: 'active=true^ORDERBYname' },
          { title: 'Targets', table: 'pa_targets', roles: PA_ADMIN_ROLES },
          { title: 'Scores', table: 'pa_scores', query: 'ORDERBYDESCstart_at', roles: PA_ADMIN_ROLES },
          { title: 'Indicator Sources', table: 'pa_cubes', roles: PA_ADMIN_ROLES },
          { title: 'Report Sources', table: 'sys_report_source', roles: ['report_admin'] },
          {
            title: 'Dashboard Definitions',
            table: 'par_dashboard',
            roles: ['report_admin', 'dashboard_admin'],
          },
        ],
      },
    ],
    lists: [
      {
        table: 'sys_report',
        columns: ['title', 'table', 'type', 'field', 'aggregate', 'created_by_user', 'sys_updated_on'],
        defaultOrder: 'title',
      },
      { table: 'sys_report_source', columns: ['name', 'table', 'filter', 'active'] },
      {
        table: 'par_dashboard',
        columns: ['name', 'owner', 'categories', 'certified', 'active', 'sys_updated_on'],
      },
      {
        table: 'par_dashboard_widget',
        columns: ['dashboard', 'tab', 'kind', 'component_table', 'component', 'x', 'y', 'w', 'h'],
      },
      {
        table: 'pa_indicators',
        columns: ['name', 'resolvr_key', 'type', 'aggregate', 'unit', 'direction', 'active'],
      },
      { table: 'pa_cubes', columns: ['name', 'facts_table', 'conditions', 'frequency'] },
      { table: 'pa_scores', columns: ['indicator', 'start_at', 'value', 'approximate', 'element'] },
      { table: 'pa_targets', columns: ['indicator', 'target', 'start_at', 'review_date', 'personal_for'] },
    ],
    forms: [
      {
        table: 'sys_report',
        highlights: ['type', 'table', 'aggregate'],
        sections: [
          {
            left: ['title', 'table', 'type', 'source_type', 'report_source'],
            right: ['field', 'stack_field', 'aggregate', 'sumfield', 'trend_field', 'interval'],
          },
          { caption: 'Conditions', fields: ['filter'] },
          {
            caption: 'Layout',
            left: ['row', 'column', 'field_list', 'orderby_list'],
            right: [
              'others',
              'other_threshold',
              'show_empty',
              'show_zero',
              'decimal_precision',
              'chart_size',
            ],
          },
          {
            caption: 'Sharing',
            left: ['user', 'group', 'roles'],
            right: ['is_published', 'created_by_user'],
          },
          { fields: ['description'] },
        ],
        relatedLists: [
          {
            table: 'sys_report_users_groups',
            field: 'report_id',
            label: 'Shared with',
            columns: ['user_id', 'group_id'],
          },
        ],
      },
      {
        table: 'par_dashboard',
        sections: [
          {
            left: ['name', 'owner', 'requester', 'categories'],
            right: ['active', 'certified', 'refresh_interval_min', 'cache_enabled'],
          },
          { fields: ['description', 'allowed_workspaces'] },
        ],
        relatedLists: [
          { table: 'par_dashboard_tab', field: 'dashboard', label: 'Tabs', columns: ['name', 'order'] },
          {
            table: 'par_dashboard_widget',
            field: 'dashboard',
            label: 'Widgets',
            columns: ['kind', 'component_table', 'component', 'tab', 'x', 'y', 'w', 'h'],
          },
          {
            table: 'par_dashboard_permission',
            field: 'dashboard',
            label: 'Sharing',
            columns: ['user', 'group', 'role', 'access'],
          },
          {
            table: 'par_dashboard_filter',
            field: 'dashboard',
            label: 'Filters',
            columns: ['label', 'kind', 'table', 'field'],
          },
        ],
      },
      {
        table: 'pa_indicators',
        highlights: ['type', 'unit', 'direction'],
        sections: [
          {
            left: ['name', 'resolvr_key', 'type', 'cube', 'aggregate', 'field'],
            right: ['mode', 'date_field', 'unit', 'precision', 'direction', 'frequency', 'active'],
          },
          { caption: 'Definition', fields: ['conditions', 'predicate', 'formula'] },
          { fields: ['description'] },
        ],
        relatedLists: [
          {
            table: 'pa_targets',
            field: 'indicator',
            label: 'Targets',
            columns: ['target', 'start_at', 'review_date', 'personal_for'],
          },
          {
            table: 'pa_scores',
            field: 'indicator',
            label: 'Scores',
            columns: ['start_at', 'value', 'approximate'],
          },
        ],
      },
      {
        table: 'pa_cubes',
        sections: [{ left: ['name', 'facts_table'], right: ['frequency'] }, { fields: ['conditions'] }],
      },
      {
        table: 'pa_targets',
        sections: [
          {
            left: ['indicator', 'target', 'element'],
            right: ['start_at', 'review_date', 'personal_for', 'responsible'],
          },
        ],
      },
    ],
    uiActions: [
      {
        id: 'pa_indicators.collect',
        table: 'pa_indicators',
        label: 'Collect scores (30 days)',
        roles: PA_ADMIN_ROLES,
        condition: 'active=true',
        run(rec, ctx) {
          const r = backfillScores(ctx.platform, { days: 30, keys: [rec.sysId] });
          if (r.skipped.length) return { error: 'The tables behind this indicator are not installed' };
          return { message: `Stored ${r.scores} scores` };
        },
      },
    ],
  },
  register(platform) {
    platform.services.set(SERVICES.analytics, analyticsService(platform));
  },
  seedVersion: 1,
  seed(ctx) {
    seedAnalytics(ctx);
  },
  demo(ctx) {
    // Other modules' demo data may still have queued async work (SLA attachment...):
    // process it first so the history covers it, then score the installed tables.
    ctx.platform.drain();
    backfillScores(ctx.platform);
  },
  http(app, deps) {
    registerAnalyticsApi(app as FastifyInstance, deps as ApiDeps);
  },
};
