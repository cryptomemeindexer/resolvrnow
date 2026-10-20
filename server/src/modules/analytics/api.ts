import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, HttpError, intParam } from '../../api/http.js';
import { parseBool, parseFields } from '../../api/serialize.js';
import type { Context } from '../../engine/context.js';
import { AccessError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import {
  canEditReport,
  canReadIndicatorScores,
  dashboardAccess,
  GLOBAL,
  PA_ADMIN_ROLES,
  REPORT_CREATOR_ROLES,
  reportVisibility,
} from './access.js';
import { addDays, datesBetween, isValidDate, todayDate } from './dates.js';
import { term } from './grouping.js';
import {
  backfillScores,
  dayWindow,
  type Indicator,
  IndicatorSet,
  KpiEngine,
  type KpiPeriod,
  kpiScorecards,
  readScores,
  runSnapshotJob,
} from './kpis.js';
import {
  definitionFromRecord,
  normalizeDefinition,
  type ReportDefinition,
  type RunOptions,
  runReport,
  validateDefinition,
} from './reports.js';

type Query = Record<string, string | undefined>;

const PERIODS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'quarter', 'year']);

function findReport(ctx: Context, id: string): Rec | null {
  if (isSysId(id)) return ctx.get('sys_report', id);
  return ctx.first('sys_report', term('resolvr_key', '=', id));
}

function findDashboard(ctx: Context, id: string): Rec | null {
  const sys = ctx.elevated();
  const rec = isSysId(id)
    ? sys.get('par_dashboard', id)
    : sys.first('par_dashboard', term('resolvr_key', '=', id));
  return rec && dashboardAccess(ctx, rec) ? rec : null;
}

function userRef(ctx: Context, id: string): { sysId: string; name: string } | null {
  return id && isSysId(id) ? { sysId: id, name: ctx.displayOf('sys_user', id) || id } : null;
}

function reportSummary(ctx: Context, rec: Rec) {
  const table = rec.str('table');
  const meta = ctx.registry.tryTable(table);
  return {
    sysId: rec.sysId,
    key: rec.str('resolvr_key') || null,
    title: rec.str('title'),
    description: rec.str('description'),
    type: rec.str('type'),
    table,
    tableLabel: meta?.label ?? null,
    missingTable: !meta,
    canRun: !!meta && ctx.platform.acl.canTable(ctx, table, 'read').allowed,
    groupBy: rec.str('field') || null,
    aggregate: rec.str('aggregate') || 'COUNT',
    visibility: reportVisibility(ctx, rec),
    owner: userRef(ctx, rec.str('created_by_user') || (rec.str('user') !== GLOBAL ? rec.str('user') : '')),
    canEdit: canEditReport(ctx, rec),
    updatedOn: rec.str('sys_updated_on'),
  };
}

function runOptions(q: Query): RunOptions {
  return {
    filter: q.filter ?? q.sysparm_query ?? null,
    groupBy: q.group_by ?? null,
    limit: q.limit ? intParam(q.limit, 100, 1, 1000) : null,
    offset: q.offset ? intParam(q.offset, 0, 0) : null,
  };
}

/** sys_report values for a normalized definition (plus sharing fields from the request body). */
function recordValues(
  ctx: Context,
  def: ReportDefinition,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (def.sort) props.sort = def.sort;
  if (def.limit) props.limit = def.limit;
  const visibility = String(body.visibility ?? '').toLowerCase();
  const values: Record<string, unknown> = {
    title: def.title,
    description: def.description,
    type: def.type,
    table: def.table,
    source_type: 'table',
    filter: def.filter,
    field: def.groupBy ?? '',
    stack_field: def.stackBy ?? '',
    aggregate: def.aggregate,
    sumfield: def.aggregateField ?? '',
    trend_field: def.trendField ?? '',
    interval: def.interval,
    row: def.rows.join(','),
    column: def.columns.join(','),
    field_list: def.fieldList.join(','),
    orderby_list: def.orderBy.map((o) => (o.desc ? `-${o.field}` : o.field)).join(','),
    others: def.showOther ? 'yes' : 'no',
    other_threshold: def.otherThreshold,
    show_empty: def.showEmpty,
    show_zero: def.showZero,
    compute_percent: def.computePercent,
    decimal_precision: def.precision,
    properties: Object.keys(props).length ? JSON.stringify(props) : '',
    created_by_user: ctx.user.sysId,
  };
  if (visibility === 'everyone') values.user = GLOBAL;
  else if (visibility === 'me') values.user = ctx.user.sysId;
  for (const f of ['user', 'group', 'roles', 'is_published'] as const) {
    if (body[f] !== undefined) values[f] = body[f];
  }
  return values;
}

function scorecardOptions(q: Query): { period: KpiPeriod; days: number } {
  const period = (q.period ?? 'day').toLowerCase();
  if (!PERIODS.has(period))
    throw new HttpError(400, `Invalid period ${period}`, 'Use day, week, month, quarter or year');
  return { period: period as KpiPeriod, days: intParam(q.days, 30, 2, 366) };
}

function resolveIndicators(set: IndicatorSet, ids: string[]): Indicator[] {
  if (!ids.length) return set.list.filter((i) => i.active);
  return ids.map((id) => {
    const ind = set.get(id);
    if (!ind) throw new HttpError(404, `Unknown indicator ${id}`);
    return ind;
  });
}

function requireRoles(ctx: Context, roles: string[], what: string): void {
  if (!ctx.hasAnyRole(roles))
    throw new HttpError(403, `Insufficient rights to ${what}`, `Requires one of: ${roles.join(', ')}`);
}

function parseJson(v: string): unknown {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

interface DashboardFilter {
  sysId: string;
  kind: string;
  defaultValue: string;
  targets: Record<string, string> | null;
}

/**
 * Encoded query terms per widget from dashboard filter values (request values by filter
 * sys_id, else the filter's default). A select filter with several comma-separated values
 * becomes IN, a date filter `from` or `from@to` a lower bound or a range.
 */
function filterTerms(
  filters: DashboardFilter[],
  values: Record<string, unknown> | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of filters) {
    const raw = values?.[f.sysId];
    const value = (
      Array.isArray(raw) ? raw.join(',') : raw === undefined || raw === null ? f.defaultValue : String(raw)
    ).trim();
    if (!value || !f.targets) continue;
    for (const [widget, path] of Object.entries(f.targets)) {
      if (typeof path !== 'string' || !path) continue;
      let t: string;
      if (f.kind === 'date') t = value.includes('@') ? term(path, 'BETWEEN', value) : term(path, '>=', value);
      else if (value.includes(',')) t = term(path, 'IN', value);
      else t = term(path, '=', value);
      const list = out.get(widget) ?? [];
      list.push(t);
      out.set(widget, list);
    }
  }
  return out;
}

/** Runs a widget's component; failures become a per-widget error instead of failing the dashboard. */
function widgetData(fn: () => unknown): { data?: unknown; error?: { status: number; message: string } } {
  try {
    return { data: fn() };
  } catch (e) {
    if (e instanceof AccessError) return { error: { status: 403, message: e.message } };
    if (e instanceof InvalidError || e instanceof HttpError)
      return { error: { status: 400, message: e.message } };
    if (e instanceof NotFoundError) return { error: { status: 404, message: e.message } };
    return { error: { status: 500, message: e instanceof Error ? e.message : String(e) } };
  }
}

export function registerAnalyticsApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const base = '/api/app/analytics';

  // ------------------------------------------------------------------ reports

  app.get(`${base}/reports`, async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Query;
    const terms: string[] = [];
    if (q.table) terms.push(term('table', '=', q.table));
    if (q.type) terms.push(term('type', '=', q.type));
    if (q.q) terms.push(term('title', 'LIKE', q.q));
    terms.push('ORDERBYtitle');
    const recs = ctx.query('sys_report', { query: terms.join('^') });
    const limit = intParam(q.limit, 200, 1, 1000);
    const offset = intParam(q.offset, 0, 0);
    reply.header('X-Total-Count', String(recs.length));
    return { result: recs.slice(offset, offset + limit).map((r) => reportSummary(ctx, r)) };
  });

  app.post(`${base}/reports`, async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const def = normalizeDefinition(body);
    validateDefinition(ctx, def);
    const rec = ctx.insert('sys_report', recordValues(ctx, def, body));
    reply.code(201);
    return { result: { ...reportSummary(ctx, rec), definition: definitionFromRecord(ctx, rec) } };
  });

  app.get(`${base}/reports/:id`, async (req) => {
    const ctx = ctxOf(req, deps);
    const rec = findReport(ctx, (req.params as { id: string }).id);
    if (!rec) throw new NotFoundError();
    return { result: { ...reportSummary(ctx, rec), definition: definitionFromRecord(ctx, rec) } };
  });

  app.get(`${base}/reports/:id/run`, async (req) => {
    const ctx = ctxOf(req, deps);
    const rec = findReport(ctx, (req.params as { id: string }).id);
    if (!rec) throw new NotFoundError();
    return { result: runReport(ctx, definitionFromRecord(ctx, rec), runOptions(req.query as Query)) };
  });

  /** Ad-hoc definition (report designer preview). */
  app.post(`${base}/run`, async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, REPORT_CREATOR_ROLES, 'run ad-hoc reports');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const def = normalizeDefinition((body.definition as Record<string, unknown>) ?? body);
    const opts = runOptions(req.query as Query);
    if (typeof body.extraFilter === 'string') opts.filter = body.extraFilter;
    return { result: runReport(ctx, def, opts) };
  });

  // ------------------------------------------------------------------ dashboards

  app.get(`${base}/dashboards`, async (req) => {
    const ctx = ctxOf(req, deps);
    const sys = ctx.elevated();
    const out = [];
    for (const d of sys.query('par_dashboard', { query: 'ORDERBYname' })) {
      const access = dashboardAccess(ctx, d);
      if (!access) continue;
      out.push({
        sysId: d.sysId,
        key: d.str('resolvr_key') || null,
        name: d.str('name'),
        description: d.str('description'),
        active: d.bool('active'),
        certified: d.bool('certified'),
        categories: d.str('categories'),
        owner: userRef(ctx, d.str('owner')),
        access,
        canEdit: access === 'edit',
        widgetCount: sys.count('par_dashboard_widget', `dashboard=${d.sysId}`),
        refreshIntervalMin: d.num('refresh_interval_min') ?? 5,
      });
    }
    return { result: out };
  });

  app.get(`${base}/dashboards/:id`, async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Query;
    const dash = findDashboard(ctx, (req.params as { id: string }).id);
    if (!dash) throw new NotFoundError();
    const access = dashboardAccess(ctx, dash);
    const includeData = parseBool(q.include_data);
    const scoreOpts = scorecardOptions(q);
    const sys = ctx.elevated();
    const tabs = sys.query('par_dashboard_tab', { query: `dashboard=${dash.sysId}^ORDERBYorder` });
    const tabOrder = new Map(tabs.map((t, i) => [t.sysId, i]));
    const indicators = new IndicatorSet(platform);
    const engine = new KpiEngine(platform, indicators);
    const filters = sys.query('par_dashboard_filter', { query: `dashboard=${dash.sysId}` }).map((f) => ({
      sysId: f.sysId,
      tab: f.str('tab') || null,
      label: f.str('label'),
      kind: f.str('kind') || 'select',
      table: f.str('table'),
      field: f.str('field'),
      defaultValue: f.str('default_value'),
      targets: parseJson(f.str('targets')) as Record<string, string> | null,
    }));
    const widgetFilters = filterTerms(filters, parseJson(q.filters ?? '') as Record<string, unknown> | null);
    const widgets = sys
      .query('par_dashboard_widget', { query: `dashboard=${dash.sysId}` })
      .sort(
        (a, b) =>
          (tabOrder.get(a.str('tab')) ?? -1) - (tabOrder.get(b.str('tab')) ?? -1) ||
          (a.num('y') ?? 0) - (b.num('y') ?? 0) ||
          (a.num('x') ?? 0) - (b.num('x') ?? 0),
      )
      .map((w) => {
        const componentTable = w.str('component_table');
        const component = w.str('component');
        const filter = widgetFilters.get(w.sysId)?.join('^') || null;
        const out: Record<string, unknown> = {
          sysId: w.sysId,
          kind: w.str('kind') || 'visualization',
          tab: w.str('tab') || null,
          x: w.num('x') ?? 0,
          y: w.num('y') ?? 0,
          w: w.num('w') ?? 4,
          h: w.num('h') ?? 3,
          title: w.str('title_override') || null,
          config: parseJson(w.str('config')),
          /** Encoded query the dashboard filters add to this widget (pass it as `filter` when running). */
          filter,
          report: null,
          kpi: null,
        };
        if (componentTable === 'sys_report') {
          const rec = component ? ctx.get('sys_report', component) : null;
          if (!rec) {
            out.report = { sysId: component, access: false };
          } else {
            const summary = reportSummary(ctx, rec);
            out.report = { ...summary, access: summary.missingTable || summary.canRun };
            out.title ??= summary.title;
            if (includeData) {
              Object.assign(
                out,
                widgetData(() => runReport(ctx, definitionFromRecord(ctx, rec), { filter })),
              );
            }
          }
        } else if (componentTable === 'pa_indicators') {
          const ind = indicators.get(component);
          if (!ind) {
            out.kpi = { sysId: component, access: false };
          } else {
            const tables = engine.tablesOf(ind);
            const missing = tables.filter((t) => !ctx.registry.has(t));
            out.kpi = {
              id: ind.key,
              sysId: ind.sysId,
              name: ind.name,
              unit: ind.unit,
              direction: ind.direction,
              tables,
              missingTable: missing.length > 0,
              access:
                missing.length > 0 || tables.every((t) => ctx.platform.acl.canTable(ctx, t, 'read').allowed),
            };
            out.title ??= ind.name;
            if (includeData) {
              Object.assign(
                out,
                widgetData(() => kpiScorecards(ctx, [ind], scoreOpts, engine)[0]),
              );
            }
          }
        }
        return out;
      });
    return {
      result: {
        sysId: dash.sysId,
        key: dash.str('resolvr_key') || null,
        name: dash.str('name'),
        description: dash.str('description'),
        certified: dash.bool('certified'),
        categories: dash.str('categories'),
        owner: userRef(ctx, dash.str('owner')),
        access,
        canEdit: access === 'edit',
        refreshIntervalMin: dash.num('refresh_interval_min') ?? 5,
        tabs: tabs.map((t) => ({ sysId: t.sysId, name: t.str('name'), order: t.num('order') ?? 100 })),
        filters,
        widgets,
      },
    };
  });

  // ------------------------------------------------------------------ indicators

  app.get(`${base}/kpis`, async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Query;
    const set = new IndicatorSet(platform);
    const indicators = resolveIndicators(set, parseFields(q.ids));
    return { result: kpiScorecards(ctx, indicators, scorecardOptions(q), new KpiEngine(platform, set)) };
  });

  /** Daily scores of one indicator (KPI details chart); today is computed live. */
  app.get(`${base}/kpis/:id/scores`, async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Query;
    const set = new IndicatorSet(platform);
    const [ind] = resolveIndicators(set, [(req.params as { id: string }).id]);
    if (!canReadIndicatorScores(ctx, ind.sysId))
      throw new AccessError('Insufficient rights to read scores', `ACL denied read on ${ind.table}`);
    const today = todayDate();
    const to = q.to && isValidDate(q.to) ? q.to : today;
    const from = q.from && isValidDate(q.from) ? q.from : addDays(to, -89);
    if (from > to) throw new HttpError(400, 'from must not be after to');
    const stored = readScores(platform, ind.sysId, from, to);
    const engine = new KpiEngine(platform, set);
    const live = to >= today ? engine.value(ind, dayWindow(today)) : null;
    return {
      result: {
        id: ind.key,
        sysId: ind.sysId,
        name: ind.name,
        unit: ind.unit,
        missingTables: engine.missingTables(ind),
        scores: datesBetween(from, to).map((d) => {
          if (d === today && live)
            return { date: d, value: live.value, approximate: live.approximate, live: true };
          const s = stored.get(d);
          return { date: d, value: s?.value ?? null, approximate: s?.approximate ?? false, live: false };
        }),
      },
    };
  });

  app.post(`${base}/kpis/collect`, async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, PA_ADMIN_ROLES, 'collect scores');
    return { result: runSnapshotJob(platform) };
  });

  app.post(`${base}/kpis/backfill`, async (req) => {
    const ctx = ctxOf(req, deps);
    requireRoles(ctx, PA_ADMIN_ROLES, 'backfill scores');
    const body = (req.body ?? {}) as { days?: number; from?: string; to?: string; ids?: string[] };
    return {
      result: backfillScores(platform, {
        days: body.days ? intParam(body.days, 90, 1, 731) : undefined,
        from: body.from,
        to: body.to,
        keys: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      }),
    };
  });
}
