import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AccessError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import { clock } from '../src/engine/util.js';
import { analyticsModule } from '../src/modules/analytics/index.js';
import {
  backfillScores,
  IndicatorSet,
  KpiEngine,
  kpiScorecards,
  readScores,
} from '../src/modules/analytics/kpis.js';
import {
  definitionFromRecord,
  normalizeDefinition,
  type ReportResult,
  runReport,
} from '../src/modules/analytics/reports.js';
import { DASHBOARD_SEEDS } from '../src/modules/analytics/seed.js';
import { bootPlatform, makeUser } from './helpers.js';

// A Wednesday; the test data spans about ten weeks before it.
const NOW = '2026-03-18 12:00:00';
const TODAY = '2026-03-18';
const DAY = 86_400_000;
const GROUPS = ['Network', 'Database', 'Desktop', 'Applications', 'Security'];

interface Row {
  sysId: string;
  opened: string;
  closed: string | null;
  priority: number;
  /** '' stores an empty string, null leaves the column NULL. */
  group: string | null;
  openedBy: string | null;
  reassign: number;
}

const basic = (u: string) => `Basic ${Buffer.from(`${u}:Password1!`).toString('base64')}`;
const ADMIN = `Basic ${Buffer.from('admin:admin-test-pw').toString('base64')}`;

const ms = (glide: string) => Date.parse(`${glide.replace(' ', 'T')}Z`);
const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => dateOf(ms(`${date} 00:00:00`) + n * DAY);
const mondayOf = (glide: string) => {
  const d = new Date(ms(`${glide.slice(0, 10)} 00:00:00`));
  return dateOf(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
};

let p: Platform;
let app: FastifyInstance;
let dir: string;
const rows: Row[] = [];
const groupIds = new Map<string, string>();
let plainId = '';

const sys = (): Context => p.systemContext();

function run(ctx: Context, def: Record<string, unknown>, opts = {}): ReportResult {
  return runReport(ctx, normalizeDefinition(def), opts);
}

/** Task records matching an encoded query (system rights): the oracle for drilldown queries. */
const count = (query: string | null): number => sys().count('task', query ?? '');
const open = () => rows.filter((r) => !r.closed);
const openAt = (instant: string) =>
  rows.filter((r) => r.opened <= instant && (!r.closed || r.closed > instant)).length;

function insertTask(r: Omit<Row, 'sysId'>, label: string): void {
  const ctx = sys();
  clock.freeze(r.opened);
  const rec = ctx.insert('task', {
    short_description: label,
    priority: r.priority,
    ...(r.group === null ? {} : { assignment_group: r.group ? groupIds.get(r.group) : '' }),
    opened_at: r.opened,
    opened_by: r.openedBy ?? '',
    reassignment_count: r.reassign,
  });
  if (r.closed) {
    clock.freeze(r.closed);
    ctx.update(rec, { state: '3' });
  }
  rows.push({ ...r, sysId: rec.sysId });
}

beforeAll(async () => {
  p = bootPlatform([analyticsModule]);
  makeUser(p, 'abel.agent', ['itil']);
  plainId = makeUser(p, 'pat.plain', []);
  makeUser(p, 'rita.reporter', ['report_user']);
  makeUser(p, 'gina.global', ['report_global']);
  makeUser(p, 'ada.analytics', ['report_admin']);
  makeUser(p, 'lim.agent', ['itil']);
  for (const g of GROUPS) groupIds.set(g, sys().insert('sys_user_group', { name: g }).sysId);
  for (let i = 0; i < 24; i++) {
    const openedDate = addDays(TODAY, -(i * 3 + 1));
    const closedDate = addDays(openedDate, 2);
    insertTask(
      {
        opened: `${openedDate} 09:00:00`,
        closed: i % 3 === 0 && closedDate < TODAY ? `${closedDate} 15:00:00` : null,
        priority: (i % 4) + 1,
        group: i < 20 ? GROUPS[i % 5] : '',
        openedBy: [1, 5, 9].includes(i) ? plainId : null,
        reassign: i % 3,
      },
      `Task ${i}`,
    );
  }
  // No group at all (NULL), next to the empty-string groups above.
  insertTask(
    {
      opened: `${addDays(TODAY, -2)} 11:00:00`,
      closed: null,
      priority: 3,
      group: null,
      openedBy: null,
      reassign: 2,
    },
    'No group',
  );
  insertTask(
    { opened: `${TODAY} 08:00:00`, closed: null, priority: 2, group: 'Network', openedBy: null, reassign: 0 },
    'Today 1',
  );
  insertTask(
    { opened: `${TODAY} 10:30:00`, closed: null, priority: 2, group: 'Network', openedBy: null, reassign: 1 },
    'Today 2',
  );
  clock.freeze(NOW);

  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-analytics-'));
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbFile: ':memory:',
    attachmentDir: join(dir, 'att'),
    publicUrl: 'https://resolvrnow.test',
    webDir: null,
    demo: false,
    secureCookies: false,
  };
  app = await buildApp(p, config);
});

afterAll(async () => {
  await app.close();
  p.close();
  clock.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe('seeded content', () => {
  it('ships six dashboards of 6 to 10 widgets, keyed reports and the KPI catalogue', () => {
    const ctx = sys();
    const dashboards = ctx.query('par_dashboard');
    expect(dashboards.map((d) => d.str('name')).sort()).toEqual([
      'Change Management',
      'Incident Management',
      'Knowledge',
      'Request Fulfillment',
      'Service Desk Overview',
      'Service Level Performance',
    ]);
    for (const d of dashboards) {
      const widgets = ctx.query('par_dashboard_widget', `dashboard=${d.sysId}`);
      expect(widgets.length, d.str('name')).toBeGreaterThanOrEqual(6);
      expect(widgets.length, d.str('name')).toBeLessThanOrEqual(10);
      // Every widget of the shipped definition was created and points at an existing report or indicator.
      expect(widgets.length).toBe(
        DASHBOARD_SEEDS.find((s) => s.key === d.str('resolvr_key'))!.widgets.length,
      );
      for (const w of widgets)
        expect(ctx.get(w.str('component_table'), w.str('component')), w.sysId).not.toBeNull();
    }
    // Seeded by table name although the incident module is not installed.
    expect(ctx.first('sys_report', 'resolvr_key=rn.inc.open_by_priority')?.str('table')).toBe('incident');
    expect(ctx.count('pa_indicators')).toBeGreaterThanOrEqual(110);
    expect(ctx.first('pa_indicators', 'resolvr_key=incident_fcr_pct')?.str('formula')).toContain(
      '[[incident_resolved_first_contact]]',
    );
    expect(ctx.count('pa_targets')).toBeGreaterThan(0);
    const nav = p.navigation.find((n) => n.id === 'analytics');
    expect(nav?.modules.map((m) => m.title)).toEqual(
      expect.arrayContaining(['Dashboards', 'Reports', 'Indicators']),
    );
    expect(p.lists.has('sys_report:default')).toBe(true);
    expect(p.forms.has('sys_report:default')).toBe(true);
  });
});

describe('report engine', () => {
  const agent = () => p.contextAs('abel.agent');

  it('bar: groups in choice order with display labels and a drilldown query per point', () => {
    const res = run(agent(), {
      type: 'bar',
      table: 'task',
      filter: 'active=true',
      field: 'priority',
      title: 'Open by priority',
    });
    expect(res.kind).toBe('category');
    expect(res.labels).toEqual(['1 - Critical', '2 - High', '3 - Moderate', '4 - Low']);
    expect(res.keys).toEqual(['1', '2', '3', '4']);
    expect(res.series).toHaveLength(1);
    expect(res.series[0].data).toEqual(
      [1, 2, 3, 4].map((pr) => open().filter((r) => r.priority === pr).length),
    );
    expect(res.total).toBe(open().length);
    for (const pt of res.series[0].points) expect(count(pt.query)).toBe(pt.value);
    expect(count(res.query)).toBe(open().length);
    expect(res.missingTable).toBe(false);
  });

  it('folds groups beyond other_threshold into Other, with its own drilldown', () => {
    const res = run(agent(), {
      type: 'horizontal_bar',
      table: 'task',
      field: 'assignment_group',
      other_threshold: 2,
    });
    expect(res.labels).toHaveLength(3);
    expect(res.labels[2]).toBe('Other');
    const byGroup = GROUPS.map((g) => rows.filter((r) => r.group === g).length).sort((a, b) => b - a);
    expect(res.series[0].data.slice(0, 2)).toEqual(byGroup.slice(0, 2));
    expect(GROUPS).toContain(res.labels[0]);
    expect(res.other?.value).toBe(byGroup.slice(2).reduce((a, b) => a + b, 0));
    expect(count(res.other!.query)).toBe(res.other!.value);
    for (const pt of res.series[0].points) expect(count(pt.query)).toBe(pt.value);
    const hidden = run(agent(), {
      type: 'bar',
      table: 'task',
      field: 'assignment_group',
      other_threshold: 2,
      others: 'no',
    });
    expect(hidden.labels).toHaveLength(2);
    expect(hidden.other).toBeNull();
  });

  it('drops empty groups unless show_empty is set', () => {
    const without = run(agent(), { type: 'pie', table: 'task', field: 'assignment_group' });
    expect(without.keys).not.toContain('');
    expect(without.total).toBe(rows.filter((r) => r.group).length);
    const withEmpty = run(agent(), {
      type: 'pie',
      table: 'task',
      field: 'assignment_group',
      show_empty: true,
    });
    const empty = withEmpty.series[0].points.find((pt) => pt.key === '');
    expect(empty?.label).toBe('(empty)');
    expect(empty?.value).toBe(rows.filter((r) => !r.group).length);
    expect(count(empty!.query)).toBe(empty!.value);
    expect(withEmpty.series[0].points.reduce((n, pt) => n + (pt.percent ?? 0), 0)).toBeCloseTo(100, 0);
  });

  it('stacks series by a second field', () => {
    const res = run(agent(), {
      type: 'bar',
      table: 'task',
      field: 'priority',
      stack_field: 'active',
      show_empty: true,
    });
    expect(res.stackBy).toBe('active');
    expect(res.series.map((s) => s.key).sort()).toEqual(['false', 'true']);
    const sums = res.labels.map((_, i) => res.series.reduce((n, s) => n + (s.data[i] ?? 0), 0));
    expect(sums).toEqual([1, 2, 3, 4].map((pr) => rows.filter((r) => r.priority === pr).length));
    for (const s of res.series) for (const pt of s.points) expect(count(pt.query)).toBe(pt.value);
  });

  it('aggregates SUM, AVG, MIN, MAX, COUNT DISTINCT and STDDEV over a field', () => {
    const sum = run(agent(), {
      type: 'pie',
      table: 'task',
      field: 'priority',
      aggregate: 'SUM',
      sumfield: 'reassignment_count',
    });
    expect(sum.aggregateLabel).toBe('Sum of Reassignment count');
    expect(sum.series[0].data).toEqual(
      [1, 2, 3, 4].map((pr) => rows.filter((r) => r.priority === pr).reduce((n, r) => n + r.reassign, 0)),
    );
    const avg = run(agent(), {
      type: 'single_score',
      table: 'task',
      aggregate: 'AVG',
      sumfield: 'reassignment_count',
    });
    expect(avg.value).toBeCloseTo(rows.reduce((n, r) => n + r.reassign, 0) / rows.length, 4);
    expect(
      run(agent(), { type: 'single_score', table: 'task', aggregate: 'MAX', sumfield: 'priority' }).value,
    ).toBe(4);
    expect(
      run(agent(), { type: 'single_score', table: 'task', aggregate: 'MIN', sumfield: 'reassignment_count' })
        .value,
    ).toBe(0);
    expect(
      run(agent(), {
        type: 'single_score',
        table: 'task',
        aggregate: 'COUNT_DISTINCT',
        sumfield: 'assignment_group',
      }).value,
    ).toBe(GROUPS.length);
    const values = rows.map((r) => r.reassign);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((n, v) => n + (v - mean) ** 2, 0) / (values.length - 1));
    expect(
      run(agent(), {
        type: 'single_score',
        table: 'task',
        aggregate: 'STDDEV',
        sumfield: 'reassignment_count',
      }).value,
    ).toBeCloseTo(sd, 3);
    expect(() => run(agent(), { type: 'bar', table: 'task', field: 'priority', aggregate: 'AVG' })).toThrow(
      /aggregation field/,
    );
  });

  it('single score counts the filtered records and drills down to them', () => {
    const res = run(agent(), {
      type: 'single_score',
      table: 'task',
      filter: 'active=true^priority=2',
      title: 'Open high',
    });
    expect(res.value).toBe(open().filter((r) => r.priority === 2).length);
    expect(res.labels).toEqual(['Open high']);
    expect(count(res.series[0].points[0].query)).toBe(res.value);
  });

  it('trend by week: Monday buckets in calendar order, gaps filled, drilldown per bucket', () => {
    const res = run(agent(), {
      type: 'line',
      table: 'task',
      trend_field: 'opened_at',
      interval: 'week',
      filter: 'opened_at>=javascript:gs.daysAgoStart(70)',
    });
    expect(res.kind).toBe('series');
    expect(res.interval).toBe('week');
    expect(res.keys[0]).toBe(mondayOf(addDays(TODAY, -70)));
    expect(res.keys[res.keys.length - 1]).toBe(mondayOf(TODAY));
    for (let i = 1; i < res.keys.length; i++) expect(res.keys[i]).toBe(addDays(res.keys[i - 1], 7));
    const inRange = rows.filter((r) => r.opened >= `${addDays(TODAY, -70)} 00:00:00`);
    expect(res.series[0].data).toEqual(
      res.keys.map((k) => inRange.filter((r) => mondayOf(r.opened) === k).length),
    );
    expect(res.total).toBe(inRange.length);
    for (const pt of res.series[0].points) expect(count(pt.query)).toBe(pt.value);
  });

  it('trend by day zero-fills the filter window', () => {
    const res = run(agent(), {
      type: 'area',
      table: 'task',
      trend_field: 'opened_at',
      interval: 'date',
      filter: 'opened_at>=javascript:gs.daysAgoStart(14)',
    });
    expect(res.keys).toHaveLength(15);
    expect(res.keys[0]).toBe(addDays(TODAY, -14));
    expect(res.keys[14]).toBe(TODAY);
    expect(res.series[0].data[14]).toBe(2);
    expect(res.series[0].data.filter((v) => v === 0).length).toBeGreaterThan(5);
    for (const pt of res.series[0].points) expect(count(pt.query)).toBe(pt.value);
  });

  it('trend by month with one series per group by value', () => {
    const res = run(agent(), {
      type: 'column',
      table: 'task',
      trend_field: 'opened_at',
      interval: 'month',
      field: 'priority',
    });
    expect(res.kind).toBe('series');
    expect(res.keys).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(res.series.map((s) => s.name)).toEqual(['1 - Critical', '2 - High', '3 - Moderate', '4 - Low']);
    for (const s of res.series) {
      expect(s.data).toEqual(
        res.keys.map(
          (m) => rows.filter((r) => r.opened.startsWith(m) && String(r.priority) === s.key).length,
        ),
      );
      for (const pt of s.points) expect(count(pt.query)).toBe(pt.value);
    }
  });

  it('trend by day of week and by hour uses cyclic buckets', () => {
    const dow = run(agent(), {
      type: 'line',
      table: 'task',
      trend_field: 'opened_at',
      interval: 'dayofweek',
    });
    expect(dow.labels).toEqual([
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]);
    expect(dow.series[0].data.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(rows.length);
    const hours = run(agent(), { type: 'line', table: 'task', trend_field: 'opened_at', interval: 'hour' });
    expect(hours.keys).toHaveLength(24);
    expect(hours.series[0].data[9]).toBe(24);
    // Drilldowns use DATEPART conditions.
    for (const pt of [...dow.series[0].points, ...hours.series[0].points])
      expect(count(pt.query)).toBe(pt.value);
  });

  it('pivot: cells, row and column totals and drilldowns; heatmap adds the value range', () => {
    const res = run(agent(), {
      type: 'pivot',
      table: 'task',
      row: 'priority',
      column: 'active',
      show_empty: true,
    });
    const pv = res.pivot!;
    expect(pv.rows.map((r) => r.label)).toEqual(['1 - Critical', '2 - High', '3 - Moderate', '4 - Low']);
    expect(pv.columns.map((c) => c.keys[0])).toEqual(['true', 'false']);
    pv.rows.forEach((r, ri) => {
      const pr = Number(r.keys[0]);
      expect(pv.cells[ri]).toEqual([
        rows.filter((x) => x.priority === pr && !x.closed).length,
        rows.filter((x) => x.priority === pr && !!x.closed).length,
      ]);
      expect(r.total).toBe(rows.filter((x) => x.priority === pr).length);
      pv.cellQueries[ri].forEach((q, ci) => {
        expect(count(q)).toBe(pv.cells[ri][ci]);
      });
    });
    expect(pv.columns[0].total).toBe(open().length);
    expect(res.total).toBe(rows.length);
    const heat = run(agent(), {
      type: 'heatmap',
      table: 'task',
      row: 'priority',
      column: 'assignment_group',
    });
    expect(heat.pivot!.max).toBeGreaterThanOrEqual(heat.pivot!.min!);
    expect(heat.series).toHaveLength(GROUPS.length);
  });

  it('multilevel pivot returns subtotals per first row field', () => {
    const res = run(agent(), {
      type: 'pivot_v2',
      table: 'task',
      row: 'priority,active',
      column: 'assignment_group',
    });
    const pv = res.pivot!;
    expect(pv.rowFields).toEqual(['priority', 'active']);
    expect(pv.subtotals.map((s) => s.key)).toEqual(['1', '2', '3', '4']);
    for (const s of pv.subtotals) {
      expect(s.total).toBe(rows.filter((r) => String(r.priority) === s.key && r.group).length);
      expect(count(s.query)).toBe(rows.filter((r) => String(r.priority) === s.key).length);
    }
  });

  it('list: requested columns with values and display values, ordering, limit and total', () => {
    const res = run(agent(), {
      type: 'list',
      table: 'task',
      filter: 'active=true^ORDERBYDESCopened_at',
      field_list: 'number,short_description,priority,assignment_group',
      limit: 5,
    });
    expect(res.columns?.map((c) => c.field)).toEqual([
      'number',
      'short_description',
      'priority',
      'assignment_group',
    ]);
    expect(res.rows).toHaveLength(5);
    expect(res.total).toBe(open().length);
    const first = res.rows![0].values as Record<string, { value: string; display_value: string }>;
    expect(first.short_description.value).toBe('Today 2');
    expect(first.priority).toEqual({ value: '2', display_value: '2 - High' });
    expect(first.assignment_group.display_value).toBe('Network');
  });

  it('ANDs an extra filter and supports a group by override', () => {
    const res = run(agent(), { type: 'bar', table: 'task', field: 'priority' }, { filter: 'active=false' });
    expect(res.total).toBe(rows.filter((r) => r.closed).length);
    const byGroup = run(
      agent(),
      { type: 'bar', table: 'task', field: 'priority' },
      { groupBy: 'assignment_group' },
    );
    expect(byGroup.groupBy).toBe('assignment_group');
    expect(byGroup.labels).toEqual(expect.arrayContaining(GROUPS));
  });

  it('returns an empty result flagged missingTable when the table is not installed', () => {
    const res = run(agent(), { type: 'bar', table: 'incident', field: 'priority', filter: 'active=true' });
    expect(res).toMatchObject({ missingTable: true, labels: [], series: [], total: null });
    expect(run(agent(), { type: 'list', table: 'change_request' })).toMatchObject({
      missingTable: true,
      rows: [],
    });
  });

  it('pareto adds a cumulative percentage series', () => {
    const res = run(agent(), { type: 'pareto', table: 'task', field: 'assignment_group' });
    const values = res.series[0].data as number[];
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    const cumulative = res.series.find((s) => s.kind === 'line')!;
    expect(cumulative.data[cumulative.data.length - 1]).toBe(100);
  });

  it('uses the table and conditions of a report source', () => {
    const ctx = sys();
    const source = ctx.insert('sys_report_source', {
      name: 'Open work',
      table: 'task',
      filter: 'active=true',
    });
    const report = ctx.insert('sys_report', {
      title: 'Open work by priority',
      type: 'bar',
      source_type: 'source',
      report_source: source.sysId,
      table: 'incident',
      field: 'priority',
      filter: 'priority=2',
      user: 'GLOBAL',
    });
    const res = runReport(agent(), definitionFromRecord(sys(), report));
    expect(res.table).toBe('task');
    expect(res.total).toBe(open().filter((r) => r.priority === 2).length);
    // A source still used by reports cannot be deleted.
    expect(() => ctx.delete(ctx.get('sys_report_source', source.sysId)!)).toThrow(/referenced/);
  });

  it('rejects unknown fields and unsupported types', () => {
    expect(() => run(agent(), { type: 'bar', table: 'task', field: 'no_such_field' })).toThrow(
      /Invalid group by field/,
    );
    expect(() => run(agent(), { type: 'map', table: 'task', field: 'priority' })).toThrow(/not supported/);
    expect(() => run(agent(), { type: 'line', table: 'task', trend_field: 'priority' })).toThrow(
      /date field/,
    );
  });
});

describe('report security', () => {
  it('applies row-level read ACLs: counts only cover records the user may read', () => {
    const ctx = p.contextAs('pat.plain');
    const mine = rows.filter((r) => r.openedBy === plainId);
    const res = run(ctx, { type: 'bar', table: 'task', field: 'priority' });
    expect(res.total).toBe(mine.length);
    expect(res.aclChecked).toBe(true);
    expect(res.aclFiltered).toBe(rows.length - mine.length);
    expect(res.series[0].data.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(mine.length);
    const list = run(ctx, { type: 'list', table: 'task', field_list: 'number' });
    expect(list.total).toBe(mine.length);
    expect(list.rows).toHaveLength(mine.length);
  });

  it('applies query business rules of the requesting user', () => {
    const rule = p.rules.add({
      name: 'test: limited agent sees critical work only',
      table: 'task',
      when: 'before',
      actions: ['query'],
      query(qb, ctx) {
        if (ctx.user.userName === 'lim.agent') qb.addEncodedQuery('priority=1');
      },
    });
    try {
      const critical = rows.filter((r) => r.priority === 1).length;
      const res = run(p.contextAs('lim.agent'), { type: 'pie', table: 'task', field: 'priority' });
      expect(res.keys).toEqual(['1']);
      expect(res.total).toBe(critical);
      const week = run(p.contextAs('lim.agent'), {
        type: 'line',
        table: 'task',
        trend_field: 'opened_at',
        interval: 'week',
      });
      expect(week.total).toBe(critical);
      expect(run(p.contextAs('abel.agent'), { type: 'pie', table: 'task', field: 'priority' }).total).toBe(
        rows.length,
      );
    } finally {
      p.rules.remove(rule.id);
    }
  });

  it('denies reports on tables the user cannot read', () => {
    expect(() => run(p.contextAs('pat.plain'), { type: 'single_score', table: 'dl_u_priority' })).toThrow(
      AccessError,
    );
    expect(run(p.contextAs('abel.agent'), { type: 'single_score', table: 'dl_u_priority' }).value).toBe(9);
  });

  it('denies grouping or aggregating fields the user cannot read', () => {
    // Password hashes are readable by nobody but security_admin, admins included.
    const admin = p.contextAs('admin');
    expect(() => run(admin, { type: 'bar', table: 'sys_user', field: 'user_password' })).toThrow(
      /Insufficient rights to read field/,
    );
    expect(run(admin, { type: 'bar', table: 'sys_user', field: 'active' }).total).toBeGreaterThan(0);
  });

  it('protects report definitions through the Table API', async () => {
    const payload = { title: 'Via table API', table: 'task', type: 'bar', field: 'priority' };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/now/table/sys_report',
      headers: { authorization: basic('pat.plain'), 'content-type': 'application/json' },
      payload,
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/now/table/sys_report',
      headers: { authorization: basic('rita.reporter'), 'content-type': 'application/json' },
      payload,
    });
    expect(ok.statusCode).toBe(201);
    const id = ok.json().result.sys_id;
    // Personal by default: the owner sees it, others do not and cannot change it.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/now/table/sys_report/${id}`,
          headers: { authorization: basic('abel.agent') },
        })
      ).statusCode,
    ).toBe(404);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/sys_report/${id}`,
      headers: { authorization: basic('ada.analytics'), 'content-type': 'application/json' },
      payload: { title: 'Renamed by report admin' },
    });
    expect(patch.statusCode).toBe(200);
  });
});

describe('indicators', () => {
  const set = () => new IndicatorSet(p);
  const cards = (ctx: Context, ids: string[], opts = {}) => {
    const s = set();
    return kpiScorecards(
      ctx,
      ids.map((id) => s.get(id)!),
      opts,
      new KpiEngine(p, s),
    );
  };

  it('computes snapshot, period, formula and average-age KPIs with previous-day deltas', () => {
    const [openCard, newCard, growth, age, closed] = cards(sys(), [
      'task_open',
      'task_new',
      'task_backlog_growth',
      'task_backlog_age',
      'task_closed',
    ]);
    expect(openCard.value).toBe(open().length);
    // Yesterday's snapshot is reconstructed from opened and closed timestamps (approximate).
    expect(openCard.previous).toBe(openAt(`${addDays(TODAY, -1)} 23:59:59`));
    expect(openCard.approximate).toBe(true);
    expect(openCard.delta).toBe(openCard.value! - openCard.previous!);
    expect(openCard.trend).toBe('up');
    expect(openCard.status).toBe('bad');

    expect(newCard.value).toBe(2);
    expect(newCard.previous).toBe(rows.filter((r) => r.opened.startsWith(addDays(TODAY, -1))).length);
    expect(newCard).toMatchObject({ delta: 1, deltaPct: 100, trend: 'up', status: 'neutral' });
    expect(count(newCard.query)).toBe(2);

    expect(growth.value).toBe(newCard.value! - closed.value!);
    const expectedAge = open().reduce((n, r) => n + (ms(NOW) - ms(r.opened)) / DAY, 0) / open().length;
    expect(age.value).toBeCloseTo(expectedAge, 3);
    expect(age.displayValue).toMatch(/ d$/);
  });

  it('compares rolling windows for week and month periods', () => {
    const inDays = (from: number, to: number) =>
      rows.filter(
        (r) =>
          r.opened >= `${addDays(TODAY, -from)} 00:00:00` && r.opened <= `${addDays(TODAY, -to)} 23:59:59`,
      ).length;
    const [week] = cards(sys(), ['task_new'], { period: 'week' });
    expect(week.value).toBe(inDays(6, 0));
    expect(week.previous).toBe(inDays(13, 7));
    const [month] = cards(sys(), ['task_new'], { period: 'month' });
    expect(month.value).toBe(inDays(29, 0));
    expect(month.previous).toBe(inDays(59, 30));
  });

  it('skips KPIs whose tables are not installed and hides KPIs on unreadable tables', () => {
    const [inc, fcr] = cards(sys(), ['incident_open', 'incident_fcr_pct']);
    expect(inc).toMatchObject({ missingTable: true, value: null, missingTables: ['incident'] });
    expect(fcr.missingTable).toBe(true);
    const ctx = sys();
    const cube = ctx.insert('pa_cubes', { name: 'Priority matrix', facts_table: 'dl_u_priority' });
    ctx.insert('pa_indicators', {
      name: 'Priority matrix rows',
      resolvr_key: 'test_matrix_rows',
      cube: cube.sysId,
      aggregate: 'COUNT',
      mode: 'snapshot',
    });
    expect(cards(p.contextAs('pat.plain'), ['test_matrix_rows'])[0]).toMatchObject({
      noAccess: true,
      value: null,
    });
    expect(cards(p.contextAs('abel.agent'), ['test_matrix_rows'])[0]).toMatchObject({
      noAccess: false,
      value: 9,
    });
    // Stored scores follow the same rule through the Table API.
    backfillScores(p, { days: 2, keys: ['test_matrix_rows'] });
    const id = set().get('test_matrix_rows')!.sysId;
    expect(p.contextAs('pat.plain').query('pa_scores', `indicator=${id}`)).toHaveLength(0);
    expect(p.contextAs('abel.agent').query('pa_scores', `indicator=${id}`)).toHaveLength(2);
  });

  it('gives no value for indicators referencing unknown fields, without blocking the others', () => {
    const ctx = sys();
    const cube = ctx.first('pa_cubes', 'facts_table=task')!;
    ctx.insert('pa_indicators', {
      name: 'Broken',
      resolvr_key: 'test_broken',
      cube: cube.sysId,
      conditions: 'no_such_fieldISNOTEMPTY',
      mode: 'snapshot',
    });
    const [broken, fine] = cards(sys(), ['test_broken', 'task_open']);
    expect(broken).toMatchObject({ value: null, invalidTerms: ['no_such_fieldISNOTEMPTY'] });
    expect(fine.value).toBe(open().length);
    const result = backfillScores(p, { days: 1, keys: ['test_broken', 'task_open'] });
    expect(result.errors.map((e) => e.id)).toEqual(['test_broken']);
    expect(result.indicators).toBe(1);
    ctx.update(ctx.first('pa_indicators', 'resolvr_key=test_broken')!, { active: false });
  });

  it('reports the target and whether the score is on track', () => {
    sys().insert('pa_targets', {
      indicator: set().get('task_open')!.sysId,
      target: 5,
      start_at: '2026-01-01',
      review_date: '2026-12-31',
    });
    const [card] = cards(sys(), ['task_open']);
    expect(card.target).toMatchObject({ value: 5, status: 'off_track', gap: 5 - card.value! });
  });

  it('rejects formulas that create a cycle', () => {
    const ctx = sys();
    ctx.insert('pa_indicators', {
      name: 'Cycle A',
      resolvr_key: 'cycle_a',
      type: 'formula',
      aggregate: 'FORMULA',
      formula: '[[task_new]] + 1',
    });
    ctx.insert('pa_indicators', {
      name: 'Cycle B',
      resolvr_key: 'cycle_b',
      type: 'formula',
      aggregate: 'FORMULA',
      formula: '[[cycle_a]] * 2',
    });
    const a = ctx.first('pa_indicators', 'resolvr_key=cycle_a')!;
    expect(() => ctx.update(a, { formula: '[[cycle_b]] / 2' })).toThrow(/cycle/);
    expect(() =>
      ctx.insert('pa_indicators', {
        name: 'Bad',
        type: 'formula',
        aggregate: 'FORMULA',
        formula: '[[task_new]] +',
      }),
    ).toThrow(/Invalid formula/);
  });

  it('snapshot job stores exact scores for today and keeps them when the day is finalized', () => {
    p.scheduler.runNow('resolvr.analytics.snapshot');
    const s = set();
    const openId = s.get('task_open')!.sysId;
    expect(readScores(p, openId, TODAY, TODAY).get(TODAY)).toEqual({
      value: open().length,
      approximate: false,
    });
    expect(readScores(p, s.get('task_new')!.sysId, TODAY, TODAY).get(TODAY)?.value).toBe(2);
    expect(readScores(p, s.get('incident_open')!.sysId, addDays(TODAY, -7), TODAY).size).toBe(0);

    const before = open().length;
    clock.freeze(`${addDays(TODAY, 1)} 01:00:00`);
    try {
      p.scheduler.runNow('resolvr.analytics.snapshot');
      const stored = readScores(p, openId, TODAY, addDays(TODAY, 1));
      expect(stored.get(TODAY)).toEqual({ value: before, approximate: false });
      expect(stored.get(addDays(TODAY, 1))?.approximate).toBe(false);
      // The catch-up window was filled with approximations.
      expect(readScores(p, openId, addDays(TODAY, -7), addDays(TODAY, -1)).size).toBe(7);
    } finally {
      clock.freeze(NOW);
    }
  });

  it('backfills daily history from record timestamps', () => {
    const result = backfillScores(p, { days: 21 });
    expect(result.skipped).toContain('incident_open');
    expect(result.indicators).toBeGreaterThanOrEqual(5);
    const s = set();
    const newScores = readScores(p, s.get('task_new')!.sysId, addDays(TODAY, -20), TODAY);
    const openScores = readScores(p, s.get('task_open')!.sysId, addDays(TODAY, -20), TODAY);
    for (let i = 1; i <= 20; i++) {
      const d = addDays(TODAY, -i);
      expect(newScores.get(d), d).toEqual({
        value: rows.filter((r) => r.opened.startsWith(d)).length,
        approximate: false,
      });
      expect(openScores.get(d)?.value, d).toBe(openAt(`${d} 23:59:59`));
    }
    expect(openScores.get(addDays(TODAY, -10))?.approximate).toBe(true);
    // The exact snapshot collected live today is kept.
    expect(openScores.get(TODAY)).toEqual({ value: open().length, approximate: false });
    const d5 = addDays(TODAY, -5);
    const growth = readScores(p, s.get('task_backlog_growth')!.sysId, d5, d5);
    expect(growth.get(d5)?.value).toBe(
      rows.filter((r) => r.opened.startsWith(d5)).length -
        rows.filter((r) => r.closed?.startsWith(d5)).length,
    );
    const [card] = cards(sys(), ['task_new'], { days: 14 });
    expect(card.sparkline).toHaveLength(14);
    expect(card.sparkline[13]).toMatchObject({ date: TODAY, value: 2 });
    expect(card.sparkline.every((pt) => pt.value !== null)).toBe(true);
  });
});

describe('REST API', () => {
  const get = (url: string, user: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: user } });
  const post = (url: string, user: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: user, 'content-type': 'application/json' },
      payload,
    });

  it('lists the dashboards a user may see, with edit rights', async () => {
    const agent = await get('/api/app/analytics/dashboards', basic('abel.agent'));
    expect(agent.statusCode).toBe(200);
    const list = agent.json().result as { name: string; canEdit: boolean; widgetCount: number }[];
    expect(list).toHaveLength(6);
    expect(list.every((d) => !d.canEdit && d.widgetCount >= 6)).toBe(true);
    const plain = (await get('/api/app/analytics/dashboards', basic('pat.plain'))).json().result as {
      name: string;
    }[];
    expect(plain.map((d) => d.name)).toEqual(['Knowledge']);
    const admin = (await get('/api/app/analytics/dashboards', basic('ada.analytics'))).json().result as {
      canEdit: boolean;
    }[];
    expect(admin.every((d) => d.canEdit)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/app/analytics/dashboards' })).statusCode).toBe(401);
  });

  it('returns a dashboard layout with widgets referencing reports and KPIs, optionally with data', async () => {
    const res = await get(
      '/api/app/analytics/dashboards/rn.dash.service_desk?include_data=true',
      basic('abel.agent'),
    );
    expect(res.statusCode).toBe(200);
    const dash = res.json().result;
    expect(dash).toMatchObject({ name: 'Service Desk Overview', access: 'view', canEdit: false, tabs: [] });
    expect(dash.widgets).toHaveLength(8);
    for (const w of dash.widgets) {
      expect(w).toEqual(
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          w: expect.any(Number),
          h: expect.any(Number),
        }),
      );
      expect(w.report ?? w.kpi).toBeTruthy();
    }
    type W = {
      report?: { key: string; missingTable: boolean };
      kpi?: { id: string; missingTable: boolean };
      kind: string;
      data: any;
    };
    const widgets = dash.widgets as W[];
    const byType = widgets.find((w) => w.report?.key === 'rn.task.open_by_type')!;
    expect(byType.data.labels).toEqual(['Task']);
    expect(byType.data.total).toBe(open().length);
    const incidents = widgets.find((w) => w.report?.key === 'rn.inc.open_by_group')!;
    expect(incidents.report!.missingTable).toBe(true);
    expect(incidents.data.missingTable).toBe(true);
    const taskOpen = widgets.find((w) => w.kpi?.id === 'task_open')!;
    expect(taskOpen.kind).toBe('kpi_scorecard');
    expect(taskOpen.data).toMatchObject({ id: 'task_open', value: open().length, direction: 'minimize' });
    const incOpen = widgets.find((w) => w.kpi?.id === 'incident_open')!;
    expect(incOpen.kpi!.missingTable).toBe(true);
    expect(incOpen.data.missingTable).toBe(true);

    const incident = (await get('/api/app/analytics/dashboards/rn.dash.incident', basic('abel.agent'))).json()
      .result;
    expect(incident.tabs.map((t: { name: string }) => t.name)).toEqual(['Overview', 'KPIs']);
    expect(incident.widgets.filter((w: { tab: string }) => w.tab === incident.tabs[1].sysId)).toHaveLength(3);
    expect((await get('/api/app/analytics/dashboards/rn.dash.incident', basic('pat.plain'))).statusCode).toBe(
      404,
    );
  });

  it('shows widgets on unreadable tables as no access without leaking counts', async () => {
    const ctx = sys();
    const report = ctx.insert('sys_report', {
      title: 'Matrix rows',
      table: 'dl_u_priority',
      type: 'single_score',
      user: 'GLOBAL',
    });
    const dash = ctx.insert('par_dashboard', { name: 'Shared board', resolvr_key: 'test.shared' });
    ctx.insert('par_dashboard_widget', {
      dashboard: dash.sysId,
      component_table: 'sys_report',
      component: report.sysId,
      kind: 'visualization',
    });
    const role = ctx.first('sys_user_role', 'name=snc_internal')!;
    ctx.insert('par_dashboard_permission', { dashboard: dash.sysId, role: role.sysId, access: 'view' });
    const res = await get('/api/app/analytics/dashboards/test.shared?include_data=true', basic('pat.plain'));
    expect(res.statusCode).toBe(200);
    const w = res.json().result.widgets[0];
    expect(w.report.access).toBe(false);
    expect(w.data).toBeUndefined();
    expect(w.error.status).toBe(403);
    expect((await get(`/api/app/analytics/reports/${report.sysId}/run`, basic('pat.plain'))).statusCode).toBe(
      403,
    );
  });

  it('applies dashboard filter values to the widgets they target', async () => {
    // Shipped filters map widgets to field paths (SLA widgets reach the group through the task).
    const sla = (await get('/api/app/analytics/dashboards/rn.dash.sla', basic('abel.agent'))).json().result;
    expect(sla.filters).toHaveLength(1);
    expect(Object.values(sla.filters[0].targets)).toEqual(Array(4).fill('task.assignment_group'));

    const ctx = sys();
    const report = ctx.first('sys_report', 'resolvr_key=rn.task.open_by_type')!;
    const dash = ctx.insert('par_dashboard', {
      name: 'Filtered board',
      resolvr_key: 'test.filtered',
      owner: '',
    });
    const widget = ctx.insert('par_dashboard_widget', {
      dashboard: dash.sysId,
      component_table: 'sys_report',
      component: report.sysId,
    });
    const filter = ctx.insert('par_dashboard_filter', {
      dashboard: dash.sysId,
      label: 'Priority',
      table: 'task',
      field: 'priority',
      targets: JSON.stringify({ [widget.sysId]: 'priority' }),
    });
    const values = encodeURIComponent(JSON.stringify({ [filter.sysId]: '1,2' }));
    const res = await get(
      `/api/app/analytics/dashboards/test.filtered?include_data=true&filters=${values}`,
      ADMIN,
    );
    const w = res.json().result.widgets[0];
    expect(w.filter).toBe('priorityIN1,2');
    expect(w.data.total).toBe(open().filter((r) => r.priority <= 2).length);
  });

  it('lists visible reports and runs saved reports', async () => {
    const agent = (await get('/api/app/analytics/reports?table=task', basic('abel.agent'))).json().result as {
      key: string;
      canRun: boolean;
    }[];
    expect(agent.map((r) => r.key).sort()).toEqual(['rn.task.open_by_type', 'rn.task.opened_per_week']);
    expect(agent.every((r) => r.canRun)).toBe(true);
    // ITSM reports are restricted to itil; knowledge reports are shared with everyone.
    const plain = (await get('/api/app/analytics/reports', basic('pat.plain'))).json().result as {
      key: string | null;
      table: string;
    }[];
    const seeded = plain.filter((r) => r.key?.startsWith('rn.'));
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((r) => r.table === 'kb_knowledge')).toBe(true);

    const run = await get('/api/app/analytics/reports/rn.task.opened_per_week/run', basic('abel.agent'));
    expect(run.statusCode).toBe(200);
    const result = run.json().result as ReportResult;
    expect(result).toMatchObject({ type: 'line', interval: 'week', missingTable: false });
    expect(result.series.map((s) => s.name)).toEqual(['Task']);
    const filtered = (
      await get(
        '/api/app/analytics/reports/rn.task.open_by_type/run?filter=priority%3D1',
        basic('abel.agent'),
      )
    ).json().result;
    expect(filtered.total).toBe(open().filter((r) => r.priority === 1).length);
    const missing = (
      await get('/api/app/analytics/reports/rn.chg.open_by_state/run', basic('abel.agent'))
    ).json().result;
    expect(missing).toMatchObject({ missingTable: true, labels: [] });
    expect((await get('/api/app/analytics/reports/no.such.report/run', basic('abel.agent'))).statusCode).toBe(
      404,
    );
  });

  it('runs ad-hoc definitions for report creators only', async () => {
    const def = { type: 'bar', table: 'task', field: 'priority', filter: 'active=true' };
    expect((await post('/api/app/analytics/run', basic('pat.plain'), def)).statusCode).toBe(403);
    const ok = await post('/api/app/analytics/run', basic('abel.agent'), def);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.labels).toEqual(['1 - Critical', '2 - High', '3 - Moderate', '4 - Low']);
    // A report_user may design reports, but only over the records they can read.
    const reporter = (await post('/api/app/analytics/run', basic('rita.reporter'), def)).json().result;
    expect(reporter).toMatchObject({ total: 0, labels: [], aclChecked: true, aclFiltered: open().length });
    expect(
      (await post('/api/app/analytics/run', basic('rita.reporter'), { type: 'bar', table: 'task' }))
        .statusCode,
    ).toBe(400);
  });

  it('creates reports with the sharing rules', async () => {
    const created = await post('/api/app/analytics/reports', basic('rita.reporter'), {
      title: 'My work',
      type: 'pie',
      table: 'task',
      field: 'priority',
    });
    expect(created.statusCode).toBe(201);
    const mine = created.json().result;
    expect(mine).toMatchObject({ visibility: 'me', canEdit: true });
    expect((await get(`/api/app/analytics/reports/${mine.sysId}`, basic('rita.reporter'))).statusCode).toBe(
      200,
    );
    expect((await get(`/api/app/analytics/reports/${mine.sysId}`, basic('abel.agent'))).statusCode).toBe(404);
    const plainCreate = await post('/api/app/analytics/reports', basic('pat.plain'), {
      title: 'Nope',
      type: 'pie',
      table: 'task',
      field: 'priority',
    });
    expect(plainCreate.statusCode).toBe(403);
    const everyone = {
      title: 'For everyone',
      type: 'pie',
      table: 'task',
      field: 'priority',
      visibility: 'everyone',
    };
    expect((await post('/api/app/analytics/reports', basic('abel.agent'), everyone)).statusCode).toBe(403);
    expect((await post('/api/app/analytics/reports', basic('gina.global'), everyone)).statusCode).toBe(201);
    const seen = (await get('/api/app/analytics/reports?q=For everyone', basic('abel.agent'))).json()
      .result as { title: string; canEdit: boolean }[];
    expect(seen).toEqual([expect.objectContaining({ title: 'For everyone', canEdit: false })]);
    // Shared with one user through sys_report_users_groups.
    sys().insert('sys_report_users_groups', {
      report_id: mine.sysId,
      user_id: sys().first('sys_user', 'user_name=abel.agent')!.sysId,
    });
    expect((await get(`/api/app/analytics/reports/${mine.sysId}`, basic('abel.agent'))).statusCode).toBe(200);
  });

  it('returns KPI scorecards with sparkline, target and direction', async () => {
    const res = await get(
      '/api/app/analytics/kpis?ids=task_open,task_new,incident_open&days=7',
      basic('abel.agent'),
    );
    expect(res.statusCode).toBe(200);
    const [taskOpen, taskNew, inc] = res.json().result;
    expect(taskOpen).toMatchObject({
      id: 'task_open',
      value: open().length,
      direction: 'minimize',
      unit: 'count',
    });
    expect(taskOpen.sparkline).toHaveLength(7);
    expect(taskOpen.target).toMatchObject({ value: 5 });
    expect(taskNew).toMatchObject({ value: 2, previous: 1, delta: 1, trend: 'up' });
    expect(inc).toMatchObject({ missingTable: true, value: null });
    expect((await get('/api/app/analytics/kpis?ids=nope', basic('abel.agent'))).statusCode).toBe(404);
    expect(
      (await get('/api/app/analytics/kpis?ids=task_open&period=decade', basic('abel.agent'))).statusCode,
    ).toBe(400);
    const scores = (
      await get('/api/app/analytics/kpis/task_new/scores?from=2026-03-10', basic('abel.agent'))
    ).json().result;
    expect(scores.scores).toHaveLength(9);
    expect(scores.scores[8]).toMatchObject({ date: TODAY, value: 2, live: true });
    expect((await post('/api/app/analytics/kpis/collect', basic('abel.agent'), {})).statusCode).toBe(403);
    expect((await post('/api/app/analytics/kpis/collect', ADMIN, {})).statusCode).toBe(200);
  });
});

describe('demo data', () => {
  it('backfills indicator history for installed tables when demo data loads', () => {
    const demo = bootPlatform([analyticsModule], { demo: true });
    try {
      const set = new IndicatorSet(demo);
      const days = demo.properties.getNumber('resolvr.analytics.backfill_days', 90);
      const today = new Date().toISOString().slice(0, 10);
      expect(readScores(demo, set.get('task_open')!.sysId, '2000-01-01', today).size).toBe(days);
      expect(readScores(demo, set.get('incident_open')!.sysId, '2000-01-01', today).size).toBe(0);
    } finally {
      demo.close();
    }
  });
});
