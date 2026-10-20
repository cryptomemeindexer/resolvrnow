import { serializeRecord } from '../../api/serialize.js';
import type { Context } from '../../engine/context.js';
import { AccessError, InvalidError } from '../../engine/errors.js';
import { relativeInstant, resolveValue } from '../../engine/query/macros.js';
import { type OrderSpec, parseEncodedQuery } from '../../engine/query/parser.js';
import type { Rec } from '../../engine/record.js';
import { NUMERIC_TYPES } from '../../engine/types.js';
import { clock, normalizeDateTime, nowGlide, toGlideDateTime } from '../../engine/util.js';
import { bucketKeyOf, bucketLabel, bucketRange, bucketSequence, dayName } from './dates.js';
import {
  andQueries,
  type Bucket,
  type Dimension,
  equalsTerm,
  type GroupRow,
  groupAggregate,
  invalidTerms,
  isDateField,
  type Measure,
  type ResolvedField,
  requireField,
  resolveField,
  term,
  totalAggregate,
} from './grouping.js';

// ====================================================================== definitions

export type ReportAggregate = 'COUNT' | 'COUNT_DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'STDDEV';
export type ReportKind = 'category' | 'series' | 'score' | 'pivot' | 'list';
export type SortMode = 'natural' | 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc';

const AGGREGATES: ReadonlySet<string> = new Set([
  'COUNT',
  'COUNT_DISTINCT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'STDDEV',
]);
const ADDITIVE: ReadonlySet<string> = new Set(['COUNT', 'SUM']);
const AGG_LABEL: Record<ReportAggregate, string> = {
  COUNT: 'Count',
  COUNT_DISTINCT: 'Count distinct of',
  SUM: 'Sum of',
  AVG: 'Average of',
  MIN: 'Minimum of',
  MAX: 'Maximum of',
  STDDEV: 'Standard deviation of',
};

const KINDS: Record<string, ReportKind> = {
  bar: 'category',
  horizontal_bar: 'category',
  pie: 'category',
  donut: 'category',
  semi_donut: 'category',
  funnel: 'category',
  pyramid: 'category',
  pareto: 'category',
  line: 'series',
  area: 'series',
  spline: 'series',
  step_line: 'series',
  line_bar: 'series',
  trend: 'series',
  single_score: 'score',
  speedometer: 'score',
  dial: 'score',
  pivot: 'pivot',
  pivot_v2: 'pivot',
  heatmap: 'pivot',
  list: 'list',
};

const INTERVALS: Record<string, Bucket> = {
  date: 'date',
  day: 'date',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
  dayofweek: 'dayofweek',
  hour: 'hour',
};

/** Normalized report definition (from a sys_report record or an ad-hoc request body). */
export interface ReportDefinition {
  sysId: string | null;
  key: string | null;
  title: string;
  description: string;
  type: string;
  table: string;
  /** Conditions of the report source, when the report uses one. */
  sourceFilter: string;
  /** Report conditions; may carry ORDERBY terms (used by list reports). */
  filter: string;
  groupBy: string | null;
  stackBy: string | null;
  aggregate: ReportAggregate;
  aggregateField: string | null;
  trendField: string | null;
  interval: Bucket;
  rows: string[];
  columns: string[];
  fieldList: string[];
  orderBy: OrderSpec[];
  sort: SortMode | null;
  limit: number | null;
  showOther: boolean;
  /** Maximum groups before folding into "Other"; 0 = default maximum. */
  otherThreshold: number;
  showEmpty: boolean;
  showZero: boolean;
  computePercent: 'aggregate' | 'count';
  precision: number;
  gauge: {
    from: number | null;
    to: number | null;
    lowerLimit: number | null;
    upperLimit: number | null;
    direction: string | null;
  };
}

export interface RunOptions {
  /** Extra encoded query ANDed with the report conditions (dashboard filters, drill-in). */
  filter?: string | null;
  /** Replaces the group by field (viewer switching to an additional group by). */
  groupBy?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface ReportPoint {
  key: string;
  label: string;
  value: number | null;
  count: number;
  /** Encoded query of the records behind the point (drilldown to the list). */
  query: string | null;
  percent?: number | null;
}

export interface ReportSeries {
  name: string;
  /** Stack or series group value; null for the single aggregate series. */
  key: string | null;
  data: (number | null)[];
  points: ReportPoint[];
  /** Rendering hint for combined charts (pareto cumulative line). */
  kind?: 'line';
}

export interface PivotHeader {
  keys: string[];
  labels: string[];
  label: string;
  query: string;
  total: number | null;
}

export interface PivotResult {
  rowFields: string[];
  columnFields: string[];
  rows: PivotHeader[];
  columns: PivotHeader[];
  /** cells[row][column] */
  cells: (number | null)[][];
  cellQueries: string[][];
  /** First-level row subtotals when there are several row fields. */
  subtotals: { key: string; label: string; values: (number | null)[]; total: number | null; query: string }[];
  min: number | null;
  max: number | null;
}

export interface ListColumn {
  field: string;
  label: string;
  type: string;
}

export interface ListRow {
  sysId: string;
  table: string;
  values: Record<string, unknown>;
}

/** Chart-ready report output. */
export interface ReportResult {
  type: string;
  kind: ReportKind;
  title: string;
  table: string;
  tableLabel: string | null;
  sysId: string | null;
  aggregate: ReportAggregate;
  aggregateField: string | null;
  aggregateLabel: string;
  groupBy: string | null;
  stackBy: string | null;
  trendField: string | null;
  interval: Bucket | null;
  labels: string[];
  keys: string[];
  series: ReportSeries[];
  total: number | null;
  /** Records behind the report. */
  count: number;
  other: ReportPoint | null;
  value?: number | null;
  gauge?: ReportDefinition['gauge'];
  pivot?: PivotResult;
  columns?: ListColumn[];
  rows?: ListRow[];
  /** Encoded query of every record in the report (whole-report drilldown). */
  query: string;
  precision: number;
  valueFormat: 'number' | 'duration';
  missingTable: boolean;
  /** Matching records hidden because row-level ACLs deny read. */
  aclFiltered: number;
  /** Whether row-level ACLs were evaluated (false: only query business rules applied). */
  aclChecked: boolean;
  invalidTerms: string[];
  generatedAt: string;
  cached: boolean;
}

// ---------------------------------------------------------------------- normalization

const pick = (o: Record<string, unknown>, ...names: string[]): unknown => {
  for (const n of names) {
    const v = o[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const asString = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean);
  return asString(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
};

const asNumber = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const asBool = (v: unknown, fallback: boolean): boolean => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
};

function parseOrder(v: unknown): OrderSpec[] {
  const items: unknown[] = Array.isArray(v) ? v : asList(v);
  const out: OrderSpec[] = [];
  for (const it of items) {
    if (it && typeof it === 'object') {
      const o = it as { field?: unknown; desc?: unknown; direction?: unknown };
      const field = asString(o.field);
      if (field)
        out.push({ field, desc: asBool(o.desc, false) || asString(o.direction).toLowerCase() === 'desc' });
      continue;
    }
    let s = asString(it);
    let desc = false;
    if (s.startsWith('-')) {
      desc = true;
      s = s.slice(1);
    } else if (/^ORDERBYDESC/.test(s)) {
      desc = true;
      s = s.slice(11);
    } else if (/^ORDERBY/.test(s)) {
      s = s.slice(7);
    }
    const m = /^(.+?)(?:\s+|\^)(DESC|ASC)$/i.exec(s);
    if (m) {
      s = m[1];
      desc = m[2].toUpperCase() === 'DESC';
    }
    if (s) out.push({ field: s, desc });
  }
  return out;
}

function parseSort(v: unknown): SortMode | null {
  const s = asString(v).toLowerCase();
  if (!s) return null;
  if (s === 'value' || s === 'value_desc' || s === 'count_desc' || s === 'desc') return 'value_desc';
  if (s === 'value_asc' || s === 'count_asc' || s === 'asc') return 'value_asc';
  if (s === 'label' || s === 'label_asc' || s === 'alpha') return 'label_asc';
  if (s === 'label_desc') return 'label_desc';
  if (s === 'natural' || s === 'key' || s === 'default') return 'natural';
  throw new InvalidError(`Invalid sort ${v}`);
}

function parseJsonObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  const s = asString(v);
  if (!s.startsWith('{')) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Normalizes a report definition. Accepts sys_report column names (`field`, `sumfield`,
 * `trend_field`, `stack_field`, `field_list`, `other_threshold`...) and camelCase aliases.
 * ResolvrNow chart options without a sys_report column (`sort`, `limit`) may also come
 * from the record's `properties` JSON.
 */
export function normalizeDefinition(input: Record<string, unknown>): ReportDefinition {
  const props = parseJsonObject(input.properties);
  const table = asString(pick(input, 'table', 'tableName', 'table_name'));
  if (!table) throw new InvalidError('Report table is required');
  const type = asString(pick(input, 'type')).toLowerCase() || 'bar';
  const aggregate = (asString(pick(input, 'aggregate')).toUpperCase() || 'COUNT') as ReportAggregate;
  if (!AGGREGATES.has(aggregate)) throw new InvalidError(`Invalid aggregate ${aggregate}`);
  const aggregateField =
    asString(pick(input, 'sumfield', 'aggregateField', 'aggregate_field', 'sum_field')) || null;
  if (aggregate !== 'COUNT' && !aggregateField)
    throw new InvalidError(`Aggregate ${aggregate} needs an aggregation field`);
  const rawInterval = asString(pick(input, 'interval')).toLowerCase() || 'week';
  const interval = INTERVALS[rawInterval];
  if (!interval) throw new InvalidError(`Invalid interval ${rawInterval}`);
  const others = pick(input, 'others', 'showOther', 'show_other');
  const limit = asNumber(pick(input, 'limit') ?? props.limit);
  const otherThreshold = asNumber(pick(input, 'other_threshold', 'otherThreshold')) ?? 0;
  return {
    sysId: asString(pick(input, 'sys_id', 'sysId')) || null,
    key: asString(pick(input, 'resolvr_key', 'key')) || null,
    title: asString(pick(input, 'title', 'chart_title', 'name')) || 'Untitled report',
    description: asString(pick(input, 'description')),
    type,
    table,
    sourceFilter: '',
    filter: asString(pick(input, 'filter', 'query', 'conditions')),
    groupBy: asString(pick(input, 'field', 'groupBy', 'group_by')) || null,
    stackBy: asString(pick(input, 'stack_field', 'stackBy', 'stack_by')) || null,
    aggregate,
    aggregateField: aggregate === 'COUNT' ? null : aggregateField,
    trendField: asString(pick(input, 'trend_field', 'trendField')) || null,
    interval,
    rows: asList(pick(input, 'row', 'rows')),
    columns: asList(pick(input, 'column', 'columns')),
    fieldList: asList(pick(input, 'field_list', 'fieldList', 'fields')),
    orderBy: parseOrder(pick(input, 'orderby_list', 'orderBy', 'order_by')),
    sort: parseSort(pick(input, 'sort') ?? props.sort),
    limit: limit !== null && limit > 0 ? Math.floor(limit) : null,
    showOther:
      typeof others === 'string'
        ? others.toLowerCase() !== 'no' && asBool(others, true)
        : asBool(others, true),
    otherThreshold: otherThreshold > 0 ? Math.floor(otherThreshold) : 0,
    showEmpty: asBool(pick(input, 'show_empty', 'showEmpty'), false),
    showZero: asBool(pick(input, 'show_zero', 'showZero'), false),
    computePercent:
      asString(pick(input, 'compute_percent', 'computePercent')) === 'count' ? 'count' : 'aggregate',
    precision: Math.min(4, Math.max(0, asNumber(pick(input, 'decimal_precision', 'precision')) ?? 2)),
    gauge: {
      from: asNumber(pick(input, 'from')),
      to: asNumber(pick(input, 'to')),
      lowerLimit: asNumber(pick(input, 'lower_limit', 'lowerLimit')),
      upperLimit: asNumber(pick(input, 'upper_limit', 'upperLimit')),
      direction: asString(pick(input, 'direction')) || null,
    },
  };
}

/** Definition of a saved report; a report source (when set) supplies the table and base conditions. */
export function definitionFromRecord(ctx: Context, rec: Rec): ReportDefinition {
  const raw: Record<string, unknown> = { sys_id: rec.sysId };
  for (const [name, col] of rec.table.columns) {
    if (!col.storage) continue;
    raw[name] = col.type === 'boolean' ? rec.bool(name) : rec.get(name);
  }
  let sourceFilter = '';
  const sourceId = rec.str('report_source');
  if (sourceId && ctx.registry.has('sys_report_source')) {
    const src = ctx.elevated().get('sys_report_source', sourceId);
    if (src) {
      raw.table = src.str('table') || raw.table;
      sourceFilter = src.str('filter');
    }
  }
  if (!asString(raw.table)) raw.table = '';
  const def = normalizeDefinition({ ...raw, table: asString(raw.table) || 'unknown_table' });
  def.sourceFilter = sourceFilter;
  return def;
}

export function reportKind(def: ReportDefinition): ReportKind {
  if (def.type === 'column') return def.trendField ? 'series' : 'category';
  const kind = KINDS[def.type];
  if (!kind) throw new InvalidError(`Report type ${def.type} is not supported`);
  return kind;
}

/**
 * Checks a definition without running it. Fields are only verified when the table is
 * installed: definitions may target a module that is installed later.
 */
export function validateDefinition(ctx: Context, def: ReportDefinition): ReportKind {
  const kind = reportKind(def);
  if (kind === 'category' && !def.groupBy)
    throw new InvalidError(`A ${def.type} report needs a group by field`);
  if (kind === 'series' && !def.trendField)
    throw new InvalidError(`A ${def.type} report needs a trend field`);
  if (kind === 'pivot' && !def.rows.length && !def.groupBy)
    throw new InvalidError('A pivot report needs at least one row field');
  if (!ctx.registry.has(def.table)) return kind;
  const need = (f: string | null, purpose: string) => f && requireField(ctx, def.table, f, purpose);
  need(def.groupBy, 'group by');
  need(def.stackBy, 'stack by');
  need(def.aggregateField, 'aggregation');
  if (def.trendField && !isDateField(requireField(ctx, def.table, def.trendField, 'trend'))) {
    throw new InvalidError(`Trend field ${def.trendField} must be a date field`);
  }
  for (const f of [...def.rows, ...def.columns]) need(f, 'pivot');
  for (const f of def.fieldList)
    if (!resolveField(ctx, def.table, f))
      throw new InvalidError(`Invalid list field ${f} for table ${def.table}`);
  return kind;
}

// ---------------------------------------------------------------------- execution helpers

interface Secured {
  query: string;
  denied: number;
  checked: boolean;
}

/**
 * Row-level read ACLs for the records a report aggregates. Query business rules already
 * restrict the SQL; per-record ACL conditions and scripts are evaluated here (up to
 * `resolvr.analytics.acl_row_check_limit` records) so no count leaks rows the user
 * cannot read. Admins and system contexts skip the check.
 */
export function rowSecurity(ctx: Context, table: string, query: string): Secured {
  if (ctx.user.isSystem || !ctx.enforceAcl || ctx.user.isAdmin) return { query, denied: 0, checked: false };
  const limit = ctx.platform.properties.getNumber('resolvr.analytics.acl_row_check_limit', 20000);
  const n = ctx.count(table, query);
  if (n === 0) return { query, denied: 0, checked: true };
  if (n > limit) return { query, denied: 0, checked: false };
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const rec of ctx.derive({ acl: false }).query(table, { query })) {
    (ctx.platform.acl.canTable(ctx, rec.className, 'read', rec).allowed ? allowed : denied).push(rec.sysId);
  }
  if (!denied.length) return { query, denied: 0, checked: true };
  const blocks = Math.max(1, parseEncodedQuery(query).blocks.length);
  const ids = allowed.length <= denied.length ? allowed : denied;
  // Keep the id list within SQLite's bound-parameter limit once distributed over NQ blocks.
  if (ids.length * blocks > 30000) return { query, denied: 0, checked: false };
  const restriction =
    allowed.length <= denied.length ? `sys_idIN${allowed.join(',')}` : `sys_idNOT IN${denied.join(',')}`;
  return { query: andQueries(table, query, restriction), denied: denied.length, checked: true };
}

function measureOf(def: ReportDefinition): Measure {
  return { fn: def.aggregate, field: def.aggregateField };
}

function aggregateLabel(ctx: Context, def: ReportDefinition): string {
  if (def.aggregate === 'COUNT') return 'Count';
  const f = resolveField(ctx, def.table, def.aggregateField ?? '');
  return `${AGG_LABEL[def.aggregate]} ${f?.col.label ?? def.aggregateField}`;
}

/** Display value of a group key. */
export function groupLabel(
  ctx: Context,
  field: ResolvedField | null,
  bucket: Bucket | null,
  key: string,
): string {
  if (key === '') return '(empty)';
  if (bucket) return bucketLabel(bucket, key);
  if (!field) return key;
  const { col, table } = field;
  if ((col.type === 'reference' || col.type === 'document_id') && col.reference)
    return ctx.displayOf(col.reference, key) || key;
  if (col.type === 'sys_class_name' || col.type === 'table_name')
    return ctx.registry.tryTable(key)?.label ?? key;
  if (col.type === 'boolean') return key;
  return ctx.platform.choices.label(table.name, col.name, key) ?? key;
}

/** Drilldown term(s) selecting one group value. */
function groupTerm(
  field: string,
  resolved: ResolvedField | null,
  bucket: Bucket | null,
  key: string,
): string | null {
  if (!bucket) return equalsTerm(field, key);
  if (key === '') return `${field}ISEMPTY`;
  if (bucket === 'dayofweek' || bucket === 'hour') {
    const value = bucket === 'dayofweek' ? dayName(key) : String(Number(key));
    if (!value) return null;
    return term(
      field,
      'DATEPART',
      `${bucketLabel(bucket, key)}@javascript:gs.datePart('${bucket}','${value}','EE')`,
    );
  }
  const range = bucketRange(bucket, key);
  if (!range) return null;
  const dateOnly = resolved?.col.type === 'glide_date';
  const start = dateOnly ? range.start : `${range.start} 00:00:00`;
  const end = dateOnly ? range.end : `${range.end} 00:00:00`;
  return `${term(field, '>=', start)}^${term(field, '<', end)}`;
}

function drill(table: string, base: string, ...terms: (string | null)[]): string | null {
  if (terms.some((t) => t === null)) return null;
  return andQueries(table, base, ...(terms as string[]));
}

interface Group {
  key: string;
  label: string;
  value: number | null;
  count: number;
}

/** Comparator for the natural order of a field's values (choice sequence, buckets, numbers, labels). */
function naturalOrder(
  ctx: Context,
  field: ResolvedField | null,
  bucket: Bucket | null,
): (a: Group, b: Group) => number {
  const emptyLast = (a: Group, b: Group) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0);
  if (bucket) {
    const numeric = bucket === 'dayofweek' || bucket === 'hour';
    return (a, b) =>
      emptyLast(a, b) || (numeric ? Number(a.key) - Number(b.key) : a.key.localeCompare(b.key));
  }
  if (field) {
    const list = ctx.platform.choices.list(field.table.name, field.col.name, { includeInactive: true });
    if (list.length) {
      const pos = new Map(list.map((c, i) => [c.value, i]));
      return (a, b) =>
        emptyLast(a, b) ||
        (pos.get(a.key) ?? 1e9) - (pos.get(b.key) ?? 1e9) ||
        a.label.localeCompare(b.label);
    }
    if (NUMERIC_TYPES.has(field.col.type)) return (a, b) => emptyLast(a, b) || Number(a.key) - Number(b.key);
    if (field.col.type === 'boolean') return (a, b) => emptyLast(a, b) || b.key.localeCompare(a.key);
  }
  return (a, b) => emptyLast(a, b) || a.label.localeCompare(b.label);
}

const byValueDesc = (a: Group, b: Group) =>
  (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY) ||
  b.count - a.count ||
  a.label.localeCompare(b.label);

function sortGroups(groups: Group[], mode: SortMode, natural: (a: Group, b: Group) => number): Group[] {
  const out = [...groups];
  switch (mode) {
    case 'value_desc':
      return out.sort(byValueDesc);
    case 'value_asc':
      return out.sort((a, b) => -byValueDesc(a, b));
    case 'label_asc':
      return out.sort((a, b) => a.label.localeCompare(b.label));
    case 'label_desc':
      return out.sort((a, b) => b.label.localeCompare(a.label));
    default:
      return out.sort(natural);
  }
}

function hasChoices(ctx: Context, f: ResolvedField): boolean {
  return ctx.platform.choices.hasChoices(f.table.name, f.col.name);
}

function round(v: number | null, digits = 4): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function maxGroups(ctx: Context): number {
  return Math.max(1, ctx.platform.properties.getNumber('resolvr.analytics.max_groups', 50));
}

// ---------------------------------------------------------------------- runners

interface RunState {
  ctx: Context;
  def: ReportDefinition;
  /** Drilldown base: source + report + request conditions (no ACL restriction). */
  base: string;
  /** SQL query: base plus the row-level ACL restriction. */
  secured: string;
  measure: Measure;
  additive: boolean;
}

function runCategory(s: RunState): Partial<ReportResult> {
  const { ctx, def } = s;
  if (!def.groupBy) throw new InvalidError(`A ${def.type} report needs a group by field`);
  const field = requireField(ctx, def.table, def.groupBy, 'group by');
  const bucket = isDateField(field) ? def.interval : null;
  const dim: Dimension = { field: def.groupBy, bucket };
  const notEmpty = def.showEmpty ? null : `${def.groupBy}ISNOTEMPTY`;
  const query = andQueries(def.table, s.secured, notEmpty);
  const natural = naturalOrder(ctx, field, bucket);
  const mode: SortMode =
    def.type === 'pareto'
      ? 'value_desc'
      : (def.sort ?? (bucket || hasChoices(ctx, field) ? 'natural' : 'value_desc'));

  let groups: Group[] = groupAggregate(ctx, def.table, query, [dim], s.measure).map((r) => ({
    key: r.keys[0],
    label: groupLabel(ctx, field, bucket, r.keys[0]),
    value: r.value,
    count: r.count,
  }));
  const threshold = Math.min(def.otherThreshold > 0 ? def.otherThreshold : maxGroups(ctx), maxGroups(ctx));
  let folded: Group[] = [];
  if (groups.length > threshold) {
    const keep = new Set(
      [...groups]
        .sort(byValueDesc)
        .slice(0, threshold)
        .map((g) => g.key),
    );
    folded = groups.filter((g) => !keep.has(g.key));
    groups = groups.filter((g) => keep.has(g.key));
  }
  groups = sortGroups(groups, mode, natural);
  if (def.limit) groups = groups.slice(0, def.limit);

  let other: ReportPoint | null = null;
  if (folded.length && def.showOther && !bucket && !def.limit) {
    const exclusions = groups.filter((g) => g.key !== '').map((g) => term(def.groupBy!, '!=', g.key));
    const excludeEmpty = !def.showEmpty || groups.some((g) => g.key === '');
    const otherBase = andQueries(
      def.table,
      s.base,
      ...exclusions,
      excludeEmpty ? `${def.groupBy}ISNOTEMPTY` : null,
    );
    const count = folded.reduce((n, g) => n + g.count, 0);
    const value = s.additive
      ? folded.reduce((n, g) => n + (g.value ?? 0), 0)
      : totalAggregate(
          ctx,
          def.table,
          andQueries(def.table, s.secured, ...exclusions, excludeEmpty ? `${def.groupBy}ISNOTEMPTY` : null),
          s.measure,
        ).value;
    other = { key: '__other__', label: 'Other', value: round(value), count, query: otherBase };
  }

  const total = totalAggregate(ctx, def.table, query, s.measure);
  const visible = [...groups, ...(other ? [other as Group] : [])];
  const valueSum = visible.reduce((n, g) => n + (g.value ?? 0), 0);
  const countSum = total.count || visible.reduce((n, g) => n + g.count, 0);
  const pct = (g: Group): number | null => {
    if (def.computePercent === 'count') return countSum ? round((g.count / countSum) * 100, 2) : null;
    return s.additive && valueSum ? round(((g.value ?? 0) / valueSum) * 100, 2) : null;
  };
  const points: ReportPoint[] = visible.map((g) => ({
    key: g.key,
    label: g.label,
    value: round(g.value),
    count: g.count,
    query:
      g.key === '__other__'
        ? (other?.query ?? null)
        : drill(def.table, s.base, groupTerm(def.groupBy!, field, bucket, g.key)),
    percent: pct(g),
  }));
  if (other) other.percent = points[points.length - 1].percent;

  const series: ReportSeries[] = [];
  if (def.stackBy) {
    series.push(...stackSeries(s, field, bucket, groups, folded, other));
  } else {
    series.push({ name: aggregateLabel(ctx, def), key: null, data: points.map((p) => p.value), points });
  }
  if (def.type === 'pareto') {
    let run = 0;
    const cumulative = points.map((p) => {
      run += p.value ?? 0;
      return valueSum ? round((run / valueSum) * 100, 2) : null;
    });
    series.push({
      name: 'Cumulative %',
      key: '__cumulative__',
      kind: 'line',
      data: cumulative,
      points: points.map((p, i) => ({ ...p, value: cumulative[i], percent: cumulative[i] })),
    });
  }
  return {
    labels: points.map((p) => p.label),
    keys: points.map((p) => p.key),
    series,
    total: round(total.value),
    count: total.count,
    other,
    interval: bucket,
  };
}

function stackSeries(
  s: RunState,
  field: ResolvedField,
  bucket: Bucket | null,
  groups: Group[],
  folded: Group[],
  other: ReportPoint | null,
): ReportSeries[] {
  const { ctx, def } = s;
  const stackField = requireField(ctx, def.table, def.stackBy!, 'stack by');
  const stackBucket = isDateField(stackField) ? def.interval : null;
  const notEmpty = def.showEmpty ? [] : [`${def.groupBy}ISNOTEMPTY`, `${def.stackBy}ISNOTEMPTY`];
  const rows = groupAggregate(
    ctx,
    def.table,
    andQueries(def.table, s.secured, ...notEmpty),
    [
      { field: def.groupBy!, bucket },
      { field: def.stackBy!, bucket: stackBucket },
    ],
    s.measure,
  );
  const cell = new Map<string, GroupRow>();
  const stackTotals = new Map<string, Group>();
  for (const r of rows) {
    cell.set(`${r.keys[0]}\u0000${r.keys[1]}`, r);
    const g = stackTotals.get(r.keys[1]) ?? {
      key: r.keys[1],
      label: groupLabel(ctx, stackField, stackBucket, r.keys[1]),
      value: 0,
      count: 0,
    };
    g.count += r.count;
    g.value = (g.value ?? 0) + (r.value ?? 0);
    stackTotals.set(r.keys[1], g);
  }
  const stackMode: SortMode = stackBucket || hasChoices(ctx, stackField) ? 'natural' : 'value_desc';
  const stacks = sortGroups(
    [...stackTotals.values()],
    stackMode,
    naturalOrder(ctx, stackField, stackBucket),
  ).slice(0, maxGroups(ctx));
  const zero = s.additive ? 0 : null;
  const foldedKeys = folded.map((g) => g.key);
  return stacks.map((st) => {
    const points: ReportPoint[] = groups.map((g) => {
      const r = cell.get(`${g.key}\u0000${st.key}`);
      return {
        key: g.key,
        label: g.label,
        value: r ? round(r.value) : zero,
        count: r?.count ?? 0,
        query: drill(
          def.table,
          s.base,
          groupTerm(def.groupBy!, field, bucket, g.key),
          groupTerm(def.stackBy!, stackField, stackBucket, st.key),
        ),
      };
    });
    if (other) {
      const rs = foldedKeys.map((k) => cell.get(`${k}\u0000${st.key}`)).filter((r): r is GroupRow => !!r);
      points.push({
        key: '__other__',
        label: 'Other',
        value: s.additive ? rs.reduce((n, r) => n + (r.value ?? 0), 0) : null,
        count: rs.reduce((n, r) => n + r.count, 0),
        query: other.query
          ? drill(def.table, other.query, groupTerm(def.stackBy!, stackField, stackBucket, st.key))
          : null,
      });
    }
    return { name: st.label, key: st.key, data: points.map((p) => p.value), points };
  });
}

/** Trend window from conditions on the trend field (`>=`, `BETWEEN`, `ON`, relative operators). */
function trendBounds(ctx: Context, base: string, field: string): { from: string | null; to: string | null } {
  const parsed = parseEncodedQuery(base);
  let from: string | null = null;
  let to: string | null = null;
  if (parsed.blocks.length !== 1) return { from, to };
  const value = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    const v = resolveValue(raw, ctx.env);
    return v === null ? null : normalizeDateTime(v);
  };
  for (const cluster of parsed.blocks[0]) {
    if (cluster.length !== 1 || cluster[0].field !== field) continue;
    const c = cluster[0];
    switch (c.op) {
      case '>':
      case '>=':
        from = value(c.value) ?? from;
        break;
      case '<':
      case '<=':
        to = value(c.value) ?? to;
        break;
      case 'BETWEEN': {
        const [a, b] = c.value.split('@');
        from = value(a) ?? from;
        to = value(b) ?? to;
        break;
      }
      case 'ON': {
        const parts = c.value.split('@');
        if (parts.length >= 3) {
          from = value(parts[1]) ?? from;
          to = value(parts[2]) ?? to;
        }
        break;
      }
      case 'RELATIVEGT':
      case 'RELATIVEGE':
        from = relativeInstant(c.value) ?? from;
        break;
      case 'RELATIVELT':
      case 'RELATIVELE':
        to = relativeInstant(c.value) ?? to;
        break;
      default:
        break;
    }
  }
  return { from, to };
}

function runSeries(s: RunState): Partial<ReportResult> {
  const { ctx, def } = s;
  if (!def.trendField) throw new InvalidError(`A ${def.type} report needs a trend field`);
  const trend = requireField(ctx, def.table, def.trendField, 'trend');
  if (!isDateField(trend)) throw new InvalidError(`Trend field ${def.trendField} must be a date field`);
  const bucket = def.interval;
  const seriesField = def.groupBy ? requireField(ctx, def.table, def.groupBy, 'group by') : null;
  const seriesBucket: Bucket | null = seriesField && isDateField(seriesField) ? 'date' : null;
  const conds = [
    `${def.trendField}ISNOTEMPTY`,
    ...(seriesField && !def.showEmpty ? [`${def.groupBy}ISNOTEMPTY`] : []),
  ];
  const query = andQueries(def.table, s.secured, ...conds);
  const dims: Dimension[] = [{ field: def.trendField, bucket }];
  if (def.groupBy) dims.push({ field: def.groupBy, bucket: seriesBucket });
  const rows = groupAggregate(ctx, def.table, query, dims, s.measure);

  // Calendar keys, gap-filled across the filter window (or the data range).
  const dataKeys = [...new Set(rows.map((r) => r.keys[0]).filter(Boolean))].sort();
  let keys = dataKeys;
  if (bucket === 'dayofweek' || bucket === 'hour') {
    keys = bucketSequence(bucket, '', '') ?? dataKeys;
  } else {
    const bounds = trendBounds(ctx, s.base, def.trendField);
    const nowKey = bucketKeyOf(bucket, toGlideDateTime(clock.now()));
    const fromKey = (bounds.from ? bucketKeyOf(bucket, bounds.from) : null) ?? dataKeys[0] ?? null;
    let toKey =
      (bounds.to ? bucketKeyOf(bucket, bounds.to) : null) ??
      (bounds.from ? nowKey : null) ??
      dataKeys[dataKeys.length - 1] ??
      null;
    if (toKey && dataKeys.length && dataKeys[dataKeys.length - 1] > toKey)
      toKey = dataKeys[dataKeys.length - 1];
    const start = fromKey && dataKeys.length && dataKeys[0] < fromKey ? dataKeys[0] : fromKey;
    if (start && toKey) keys = bucketSequence(bucket, start, toKey) ?? dataKeys;
  }

  const zero = s.additive || s.measure.fn === 'COUNT_DISTINCT' ? 0 : null;
  const labels = keys.map((k) => bucketLabel(bucket, k));
  const series: ReportSeries[] = [];
  const pointFor = (key: string, r: GroupRow | undefined, seriesKey: string | null): ReportPoint => ({
    key,
    label: bucketLabel(bucket, key),
    value: r ? round(r.value) : zero,
    count: r?.count ?? 0,
    query: drill(
      def.table,
      s.base,
      groupTerm(def.trendField!, trend, bucket, key),
      seriesKey === null ? '' : groupTerm(def.groupBy!, seriesField, seriesBucket, seriesKey),
    ),
  });
  if (!seriesField) {
    const byKey = new Map(rows.map((r) => [r.keys[0], r]));
    const points = keys.map((k) => pointFor(k, byKey.get(k), null));
    series.push({ name: aggregateLabel(ctx, def), key: null, data: points.map((p) => p.value), points });
  } else {
    const cell = new Map(rows.map((r) => [`${r.keys[0]}\u0000${r.keys[1]}`, r]));
    const totals = new Map<string, Group>();
    for (const r of rows) {
      const g = totals.get(r.keys[1]) ?? {
        key: r.keys[1],
        label: groupLabel(ctx, seriesField, seriesBucket, r.keys[1]),
        value: 0,
        count: 0,
      };
      g.count += r.count;
      g.value = (g.value ?? 0) + (r.value ?? 0);
      totals.set(r.keys[1], g);
    }
    const mode: SortMode = def.sort ?? (hasChoices(ctx, seriesField) ? 'natural' : 'value_desc');
    const ordered = sortGroups(
      [...totals.values()],
      mode,
      naturalOrder(ctx, seriesField, seriesBucket),
    ).slice(0, def.limit ?? 20);
    for (const g of ordered) {
      const points = keys.map((k) => pointFor(k, cell.get(`${k}\u0000${g.key}`), g.key));
      series.push({ name: g.label, key: g.key, data: points.map((p) => p.value), points });
    }
  }
  const total = totalAggregate(ctx, def.table, query, s.measure);
  return {
    labels,
    keys,
    series,
    total: round(total.value),
    count: total.count,
    other: null,
    interval: bucket,
  };
}

function runScore(s: RunState): Partial<ReportResult> {
  const { ctx, def } = s;
  const t = totalAggregate(ctx, def.table, s.secured, s.measure);
  let value = round(t.value);
  if (value === null && def.showZero) value = 0;
  const point: ReportPoint = { key: '', label: def.title, value, count: t.count, query: s.base };
  return {
    labels: [def.title],
    keys: [''],
    series: [{ name: aggregateLabel(ctx, def), key: null, data: [value], points: [point] }],
    total: value,
    value,
    count: t.count,
    other: null,
    gauge: def.type === 'single_score' ? undefined : def.gauge,
  };
}

function runPivot(s: RunState): Partial<ReportResult> {
  const { ctx, def } = s;
  const rowFields = def.rows.length ? def.rows : def.groupBy ? [def.groupBy] : [];
  const colFields = def.columns.length ? def.columns : def.stackBy ? [def.stackBy] : [];
  if (!rowFields.length) throw new InvalidError('A pivot report needs at least one row field');
  if (rowFields.length > 5 || colFields.length > 3)
    throw new InvalidError('Pivot reports support up to 5 row and 3 column fields');
  const resolve = (f: string) => {
    const r = requireField(ctx, def.table, f, 'pivot');
    return { field: f, resolved: r, bucket: isDateField(r) ? def.interval : null };
  };
  const rDims = rowFields.map(resolve);
  const cDims = colFields.map(resolve);
  const all = [...rDims, ...cDims];
  const notEmpty = def.showEmpty ? [] : all.map((d) => `${d.field}ISNOTEMPTY`);
  const query = andQueries(def.table, s.secured, ...notEmpty);
  const dimsOf = (ds: typeof all): Dimension[] => ds.map((d) => ({ field: d.field, bucket: d.bucket }));
  const cells = groupAggregate(ctx, def.table, query, dimsOf(all), s.measure);
  const zero = s.additive || s.measure.fn === 'COUNT_DISTINCT' ? 0 : null;

  const tuple = (ds: typeof all, keys: string[]) => {
    const labels = ds.map((d, i) => groupLabel(ctx, d.resolved, d.bucket, keys[i]));
    const terms = ds.map((d, i) => groupTerm(d.field, d.resolved, d.bucket, keys[i]));
    return {
      keys,
      labels,
      label: labels.join(' / '),
      terms,
      query: drill(def.table, s.base, ...terms) ?? s.base,
    };
  };
  const compareTuples = (ds: typeof all) => {
    const orders = ds.map((d) => naturalOrder(ctx, d.resolved, d.bucket));
    return (a: { keys: string[]; labels: string[] }, b: { keys: string[]; labels: string[] }) => {
      for (let i = 0; i < ds.length; i++) {
        const c = orders[i](
          { key: a.keys[i], label: a.labels[i], value: null, count: 0 },
          { key: b.keys[i], label: b.labels[i], value: null, count: 0 },
        );
        if (c) return c;
      }
      return 0;
    };
  };
  const uniq = (ds: typeof all, offset: number) => {
    const seen = new Map<string, string[]>();
    for (const r of cells) {
      const k = r.keys.slice(offset, offset + ds.length);
      seen.set(k.join('\u0000'), k);
    }
    return [...seen.values()].map((k) => tuple(ds, k)).sort(compareTuples(ds));
  };
  const rowsT = uniq(rDims, 0).slice(0, 200);
  const colsT = cDims.length ? uniq(cDims, rDims.length).slice(0, 50) : [];
  const cellMap = new Map(cells.map((r) => [r.keys.join('\u0000'), r]));
  const totalsBy = (ds: typeof all) =>
    new Map(
      groupAggregate(ctx, def.table, query, dimsOf(ds), s.measure).map((r) => [r.keys.join('\u0000'), r]),
    );
  const rowTotals = totalsBy(rDims);
  const colTotals = cDims.length ? totalsBy(cDims) : new Map<string, GroupRow>();

  const header = (t: (typeof rowsT)[number], totals: Map<string, GroupRow>): PivotHeader => ({
    keys: t.keys,
    labels: t.labels,
    label: t.label,
    query: t.query,
    total: round(totals.get(t.keys.join('\u0000'))?.value ?? zero),
  });
  const matrix: (number | null)[][] = [];
  const queries: string[][] = [];
  for (const r of rowsT) {
    if (!colsT.length) {
      matrix.push([round(cellMap.get(r.keys.join('\u0000'))?.value ?? zero)]);
      queries.push([r.query]);
      continue;
    }
    matrix.push(colsT.map((c) => round(cellMap.get([...r.keys, ...c.keys].join('\u0000'))?.value ?? zero)));
    queries.push(colsT.map((c) => drill(def.table, s.base, ...r.terms, ...c.terms) ?? r.query));
  }
  const values = matrix.flat().filter((v): v is number => v !== null);
  const subtotals: PivotResult['subtotals'] = [];
  if (rDims.length > 1) {
    const first = [rDims[0]];
    const subCells = new Map(
      groupAggregate(ctx, def.table, query, dimsOf([...first, ...cDims]), s.measure).map((r) => [
        r.keys.join('\u0000'),
        r,
      ]),
    );
    const subTotals = totalsBy(first);
    const firstKeys = [...new Set(rowsT.map((r) => r.keys[0]))];
    for (const k of firstKeys) {
      const t = tuple(first, [k]);
      subtotals.push({
        key: k,
        label: t.label,
        values: colsT.length
          ? colsT.map((c) => round(subCells.get([k, ...c.keys].join('\u0000'))?.value ?? zero))
          : [round(subTotals.get(k)?.value ?? zero)],
        total: round(subTotals.get(k)?.value ?? zero),
        query: t.query,
      });
    }
  }
  const grand = totalAggregate(ctx, def.table, query, s.measure);
  const pivot: PivotResult = {
    rowFields,
    columnFields: colFields,
    rows: rowsT.map((r) => header(r, rowTotals)),
    columns: colsT.map((c) => header(c, colTotals)),
    cells: matrix,
    cellQueries: queries,
    subtotals,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
  const seriesCols = colsT.length
    ? colsT
    : [
        {
          keys: [] as string[],
          labels: [] as string[],
          label: aggregateLabel(ctx, def),
          terms: [],
          query: s.base,
        },
      ];
  const series: ReportSeries[] = seriesCols.map((c, ci) => ({
    name: c.label,
    key: c.keys.length ? c.keys.join(',') : null,
    data: matrix.map((row) => row[ci]),
    points: rowsT.map((r, ri) => {
      const cellRow = cellMap.get([...r.keys, ...c.keys].join('\u0000'));
      return {
        key: r.keys.join(','),
        label: r.label,
        value: matrix[ri][ci],
        count: cellRow?.count ?? 0,
        query: queries[ri][ci],
      };
    }),
  }));
  return {
    labels: rowsT.map((r) => r.label),
    keys: rowsT.map((r) => r.keys.join(',')),
    series,
    pivot,
    total: round(grand.value),
    count: grand.count,
    other: null,
    groupBy: rowFields[0],
    stackBy: colFields[0] ?? null,
  };
}

function defaultListColumns(ctx: Context, table: string): string[] {
  const meta = ctx.registry.table(table);
  for (const t of meta.ancestors) {
    const l = ctx.platform.lists.get(`${t}:default`);
    if (l) return l.columns;
  }
  const cols = [
    meta.displayField,
    ...[...meta.columns.values()].filter((c) => !c.system && !c.internal && c.storage).map((c) => c.name),
  ];
  return [...new Set(cols)].slice(0, 6);
}

function runList(s: RunState, opts: RunOptions): Partial<ReportResult> {
  const { ctx, def } = s;
  const meta = ctx.registry.table(def.table);
  const fields = def.fieldList.length ? def.fieldList : defaultListColumns(ctx, def.table);
  const columns: ListColumn[] = fields.map((f) => {
    const r = resolveField(ctx, def.table, f);
    if (!r) throw new InvalidError(`Invalid list field ${f} for table ${def.table}`);
    return { field: f, label: r.col.label, type: r.col.type };
  });
  const filterOrder = parseEncodedQuery(def.filter).orderBy;
  let orderBy = def.orderBy.length ? def.orderBy : filterOrder;
  if (!orderBy.length && meta.columns.has('sys_created_on'))
    orderBy = [{ field: 'sys_created_on', desc: true }];
  const max = ctx.platform.properties.getNumber('resolvr.analytics.list_limit', 100);
  const limit = Math.min(1000, Math.max(1, opts.limit ?? def.limit ?? max));
  const offset = Math.max(0, opts.offset ?? 0);
  const recs = ctx.query(def.table, { query: s.secured, orderBy, limit, offset });
  const rows: ListRow[] = recs.map((r) => ({
    sysId: r.sysId,
    table: r.className,
    values: serializeRecord(ctx, r, { displayValue: 'all', excludeReferenceLink: true, fields, baseUrl: '' }),
  }));
  const count = ctx.count(def.table, s.secured);
  return { labels: [], keys: [], series: [], columns, rows, total: count, count, other: null };
}

// ---------------------------------------------------------------------- entry point

/** Grouping or aggregating a field exposes its values, so it needs field read access. */
function assertFieldsReadable(ctx: Context, def: ReportDefinition): void {
  const fields = [def.groupBy, def.stackBy, def.trendField, def.aggregateField, ...def.rows, ...def.columns];
  for (const f of fields) {
    if (!f) continue;
    const r = resolveField(ctx, def.table, f);
    if (!r) continue;
    const tableOk =
      r.table.name === def.table || ctx.platform.acl.canTable(ctx, r.table.name, 'read').allowed;
    if (!tableOk || !ctx.platform.acl.canField(ctx, r.table.name, r.col.name, 'read')) {
      throw new AccessError(
        `Insufficient rights to read field ${f}`,
        `ACL denied read on ${r.table.name}.${r.col.name}`,
      );
    }
  }
}

function baseResult(ctx: Context, def: ReportDefinition, kind: ReportKind): ReportResult {
  const meta = ctx.registry.tryTable(def.table);
  const aggField = def.aggregateField ? resolveField(ctx, def.table, def.aggregateField) : null;
  return {
    type: def.type,
    kind,
    title: def.title,
    table: def.table,
    tableLabel: meta?.label ?? null,
    sysId: def.sysId,
    aggregate: def.aggregate,
    aggregateField: def.aggregateField,
    aggregateLabel: meta ? aggregateLabel(ctx, def) : def.aggregate,
    groupBy: def.groupBy,
    stackBy: def.stackBy,
    trendField: def.trendField,
    interval: null,
    labels: [],
    keys: [],
    series: [],
    total: null,
    count: 0,
    other: null,
    query: '',
    precision: def.precision,
    valueFormat:
      aggField?.col.type === 'glide_duration' && def.aggregate !== 'COUNT_DISTINCT' ? 'duration' : 'number',
    missingTable: !meta,
    aclFiltered: 0,
    aclChecked: false,
    invalidTerms: [],
    generatedAt: nowGlide(),
    cached: false,
  };
}

/**
 * Runs a report as the context's user: table read ACL, query business rules and
 * row-level read ACLs apply. A report on a table that is not installed returns an empty
 * result flagged `missingTable` instead of failing.
 */
export function runReport(ctx: Context, def: ReportDefinition, opts: RunOptions = {}): ReportResult {
  const effective: ReportDefinition = opts.groupBy ? { ...def, groupBy: opts.groupBy } : def;
  const kind = reportKind(effective);
  const result = baseResult(ctx, effective, kind);
  if (result.missingTable) {
    if (kind === 'list') {
      result.rows = [];
      result.columns = [];
    }
    return result;
  }
  if (!ctx.platform.acl.canTable(ctx, effective.table, 'read').allowed) {
    throw new AccessError('Insufficient rights to query records', `ACL denied read on ${effective.table}`);
  }
  assertFieldsReadable(ctx, effective);
  const base = andQueries(effective.table, effective.sourceFilter, effective.filter, opts.filter ?? null);
  const sec = rowSecurity(ctx, effective.table, base);
  const state: RunState = {
    ctx,
    def: effective,
    base,
    secured: sec.query,
    measure: measureOf(effective),
    additive: ADDITIVE.has(effective.aggregate),
  };
  let part: Partial<ReportResult>;
  switch (kind) {
    case 'category':
      part = runCategory(state);
      break;
    case 'series':
      part = runSeries(state);
      break;
    case 'score':
      part = runScore(state);
      break;
    case 'pivot':
      part = runPivot(state);
      break;
    default:
      part = runList(state, opts);
  }
  return {
    ...result,
    ...part,
    query: base,
    aclFiltered: sec.denied,
    aclChecked: sec.checked,
    invalidTerms: [
      ...invalidTerms(ctx, effective.table, effective.sourceFilter),
      ...invalidTerms(ctx, effective.table, effective.filter),
      ...invalidTerms(ctx, effective.table, opts.filter ?? ''),
    ],
  };
}
