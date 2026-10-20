import type { SqlParam } from '../db.js';
import type { SchemaRegistry } from '../registry.js';
import { type ColumnMeta, JOURNAL_TYPES, type TableMeta } from '../types.js';
import { escapeLike, isSysId, normalizeDate, normalizeDateTime, quoteIdent } from '../util.js';
import {
  type CalendarUnit,
  type DatePart,
  datePartValue,
  localDate,
  localSql,
  normalizeZone,
  parseDatePart,
  parseUtc,
} from './datetime.js';
import {
  isMacro,
  type MacroEnv,
  macroIsList,
  onBounds,
  relativeBounds,
  relativeInstant,
  resolveDynamic,
  resolveValue,
  splitValue,
} from './macros.js';
import {
  booleanLiteral,
  DATEPART_OPS,
  durationMs,
  hierarchyParentField,
  isDateType,
  isReference,
  listItems,
  parseDatePartCall,
  parseFieldComparison,
  parseGap,
  searchWords,
} from './operands.js';
import {
  type Condition,
  type OrderSpec,
  type ParsedQuery,
  parseEncodedQuery,
  TEXT_INDEX_GROUP_FIELD,
  TEXT_QUERY_FIELD,
} from './parser.js';

export interface CompiledQuery {
  from: string;
  joins: string[];
  where: string;
  params: SqlParam[];
  orderBy: string;
  /** Terms that referenced unknown fields or unsupported operators (ignored, platform-style). */
  invalid: string[];
}

interface Resolved {
  sql: string;
  col: ColumnMeta | null;
  table: TableMeta;
  /** Alias of the row that owns the column (the root row or a dot-walk join). */
  alias: string;
}

export interface CompilerOptions {
  /** Alias of the root row; defaults to `t0`. Related-list subqueries get their own. */
  alias?: string;
}

const PASSWORD_OPS = new Set(['ANYTHING', 'ISEMPTY', 'ISNOTEMPTY']);

const FIELD_SYMBOLS: Record<string, string> = {
  SAMEAS: '=',
  NSAMEAS: '<>',
  GT_FIELD: '>',
  LT_FIELD: '<',
  GT_OR_EQUALS_FIELD: '>=',
  LT_OR_EQUALS_FIELD: '<=',
};

const RELATIVE_SYMBOLS: Record<string, string> = {
  RELATIVEGT: '>',
  RELATIVELT: '<',
  RELATIVEGE: '>=',
  RELATIVELE: '<=',
};

/**
 * Compiles a parsed encoded query into SQL against the table-per-hierarchy layout.
 * Dot-walked fields (`caller_id.department.name`) become LEFT JOINs that are reused
 * between the WHERE and ORDER BY clauses. Related-list conditions (RLQUERY) become
 * correlated EXISTS / COUNT subqueries and hierarchy conditions recursive CTEs.
 */
export class QueryCompiler {
  private joins = new Map<string, { alias: string; sql: string; table: TableMeta }>();
  private params: SqlParam[] = [];
  private invalid: string[] = [];
  private n = 0;
  private readonly alias: string;
  private readonly tz: string | null;

  constructor(
    private registry: SchemaRegistry,
    private table: TableMeta,
    private env: MacroEnv,
    private textColumns: (table: TableMeta) => ColumnMeta[] = defaultTextColumns,
    opts: CompilerOptions = {},
  ) {
    this.alias = opts.alias ?? 't0';
    this.tz = normalizeZone(env.timeZone);
  }

  static compile(
    registry: SchemaRegistry,
    tableName: string,
    query: string | ParsedQuery | null | undefined,
    env: MacroEnv,
    extraOrder: OrderSpec[] = [],
  ): CompiledQuery {
    const table = registry.table(tableName);
    const parsed = typeof query === 'string' || query == null ? parseEncodedQuery(query) : query;
    const c = new QueryCompiler(registry, table, env);
    return c.build(parsed, extraOrder);
  }

  build(parsed: ParsedQuery, extraOrder: OrderSpec[] = []): CompiledQuery {
    this.invalid.push(...parsed.invalid);
    const where: string[] = [];
    const t = this.table;
    const a = this.alias;
    if (t.name !== t.root || t.parent) {
      // Restrict to this class and its descendants.
      where.push(`${a}."sys_class_name" IN (${t.descendants.map(() => '?').join(', ')})`);
      this.params.push(...t.descendants);
    }
    const blockSql: string[] = [];
    for (const block of parsed.blocks) {
      const ands: string[] = [];
      for (const cluster of block) {
        const ors = cluster.map((c) => this.condition(c)).filter((s): s is string => s !== null);
        if (ors.length === 0) continue;
        ands.push(ors.length === 1 ? ors[0] : `(${ors.join(' OR ')})`);
      }
      if (ands.length) blockSql.push(ands.length === 1 ? ands[0] : `(${ands.join(' AND ')})`);
    }
    if (blockSql.length) where.push(blockSql.length === 1 ? blockSql[0] : `(${blockSql.join(' OR ')})`);

    const order: string[] = [];
    for (const o of [...parsed.orderBy, ...extraOrder]) {
      const r = this.resolve(o.field);
      if (!r) continue;
      let expr = r.sql;
      if (isReference(r.col) && r.col?.reference) {
        const disp = this.displayExpr(o.field, r);
        if (disp) expr = disp;
      }
      order.push(`${expr} ${o.desc ? 'DESC' : 'ASC'}`);
    }
    // Deterministic tiebreaker so offset paging is stable when sort keys repeat.
    if (order.length) order.push(`${a}.rowid ASC`);
    return {
      from: `${quoteIdent(t.physical)} ${a}`,
      joins: [...this.joins.values()].map((j) => j.sql),
      where: where.length ? where.join(' AND ') : '1=1',
      params: this.params,
      orderBy: order.join(', '),
      invalid: this.invalid,
    };
  }

  /** Resolves a (possibly dot-walked) field path to a SQL column expression. */
  resolve(path: string): Resolved | null {
    const parts = path.split('.');
    let table = this.table;
    let alias = this.alias;
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const col = table.columns.get(name);
      if (!col) return null;
      if (i === parts.length - 1) {
        if (!col.storage) return { sql: 'NULL', col, table, alias };
        return { sql: `${alias}.${quoteIdent(col.physical)}`, col, table, alias };
      }
      if (col.type !== 'reference' || !col.reference) return null;
      const target = this.registry.tryTable(col.reference);
      if (!target) return null;
      prefix = prefix ? `${prefix}.${name}` : name;
      let j = this.joins.get(prefix);
      if (!j) {
        const ja = `${this.alias === 't0' ? '' : this.alias}j${++this.n}`;
        j = {
          alias: ja,
          table: target,
          sql: `LEFT JOIN ${quoteIdent(target.physical)} ${ja} ON ${ja}."sys_id" = ${alias}.${quoteIdent(col.physical)}`,
        };
        this.joins.set(prefix, j);
      }
      alias = j.alias;
      table = target;
    }
    return null;
  }

  /** Expression for the display value of a reference column, joining its target. */
  private displayExpr(path: string, r: Resolved): string | null {
    if (!r.col?.reference) return null;
    const target = this.registry.tryTable(r.col.reference);
    if (!target) return null;
    const disp = target.columns.get(target.displayField);
    if (!disp?.storage) return null;
    const res = this.resolve(`${path}.${target.displayField}`);
    return res?.sql ?? null;
  }

  private p(v: SqlParam): string {
    this.params.push(v);
    return '?';
  }

  private bad(c: Condition): null {
    this.invalid.push(c.raw);
    return null;
  }

  private value(raw: string): string | null {
    return resolveValue(raw, this.env);
  }

  /**
   * A date-only operand. Dates stay as written; a date-time literal keeps its written date,
   * while instants produced by macros (UTC bounds of local days) map to the user's local date.
   */
  private dateOnly(v: string, local = true): string {
    const t = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t)) {
      if (!local) return t.slice(0, 10);
      const ms = parseUtc(t);
      if (ms !== null) return localDate(ms, this.tz);
    }
    return normalizeDate(t) ?? t;
  }

  private typed(col: ColumnMeta | null, v: string, viaMacro = false): SqlParam {
    if (!col) return v;
    switch (col.type) {
      case 'boolean':
        return booleanLiteral(v);
      case 'integer':
        return /^-?\d+$/.test(v.trim()) ? Number(v) : v;
      case 'decimal':
      case 'float':
      case 'currency':
      case 'price':
      case 'percent_complete':
        return v.trim() === '' || Number.isNaN(Number(v)) ? v : Number(v);
      case 'glide_duration':
        return durationMs(v);
      case 'glide_date_time':
      case 'due_date':
        return normalizeDateTime(v) ?? v;
      case 'glide_date':
        return this.dateOnly(v, viaMacro);
      default:
        return v;
    }
  }

  private isText(col: ColumnMeta | null): boolean {
    return !col || col.storage === 'TEXT';
  }

  private nocase(col: ColumnMeta | null): string {
    return this.isText(col) && col?.type !== 'GUID' && !isReference(col) ? ' COLLATE NOCASE' : '';
  }

  private condition(c: Condition): string | null {
    if (c.op === 'RLQUERY') return this.related(c);
    if (c.field === TEXT_QUERY_FIELD) return this.textQuery(c.value);
    // Text index groups only narrow keyword search; ResolvrNow has a single index, so the term is a no-op.
    if (c.field === TEXT_INDEX_GROUP_FIELD) return null;
    const r = this.resolve(c.field);
    if (!r) return this.bad(c);
    const { col } = r;
    if (col && JOURNAL_TYPES.has(col.type)) return this.journal(c, r);
    // Password values must never be matchable.
    if (col?.type === 'password2' && !PASSWORD_OPS.has(c.op)) return this.bad(c);
    const f = r.sql;
    const text = this.isText(col);
    const nocase = this.nocase(col);
    const isRef = isReference(col);
    const emptyCheck = `(${f} IS NULL OR ${f} = '')`;
    const notEmpty = `(${f} IS NOT NULL AND ${f} <> '')`;
    const op = c.op;

    switch (op) {
      case 'ANYTHING':
        return '1=1';
      case 'ISEMPTY':
        return text ? emptyCheck : `${f} IS NULL`;
      case 'ISNOTEMPTY':
        return text ? notEmpty : `${f} IS NOT NULL`;
      case 'EMPTYSTRING':
        return `${f} = ''`;
      case 'VALCHANGES':
      case 'CHANGESFROM':
      case 'CHANGESTO':
      case 'DOESNOTHAVE':
      case 'EXCLUDING':
        // Change operators need a before/after pair (rule conditions only); tag operators need a
        // label model ResolvrNow does not have. Both are invalid in read queries.
        return this.bad(c);
      case 'DYNAMIC': {
        const vals = resolveDynamic(c.value, this.env);
        if (!vals) return this.bad(c);
        return this.inList(f, vals, col, false, nocase);
      }
      case 'INSTANCEOF': {
        const t = this.registry.tryTable(c.value.trim());
        const classes = t ? t.descendants : [c.value.trim()];
        return `${f} IN (${classes.map((x) => this.p(x)).join(', ')})`;
      }
      case 'IN_HIERARCHY':
      case 'IN_HIERARCHY_DYNAMIC':
        return this.hierarchy(c, r);
      case 'SAMEAS':
      case 'NSAMEAS':
      case 'GT_FIELD':
      case 'LT_FIELD':
      case 'GT_OR_EQUALS_FIELD':
      case 'LT_OR_EQUALS_FIELD':
        return this.fieldCompare(c, r);
      case 'MORETHAN':
      case 'LESSTHAN':
        return this.gap(c, r);
      case 'BETWEEN': {
        const parts = splitValue(c.value);
        if (parts.length !== 2) return this.bad(c);
        const va = this.value(parts[0]);
        const vb = this.value(parts[1]);
        if (va === null || vb === null || va.trim() === '' || vb.trim() === '') return this.bad(c);
        const ta = this.typed(col, va, isMacro(parts[0]));
        const tb = this.typed(col, vb, isMacro(parts[1]));
        if (ta === null || tb === null) return this.bad(c);
        return `${f}${nocase} BETWEEN ${this.p(ta)} AND ${this.p(tb)}`;
      }
      case 'ON':
      case 'NOTON': {
        const b = onBounds(c.value, this.env);
        if (!b) return this.bad(c);
        const [start, end] = col?.type === 'glide_date' ? [this.dateOnly(b[0]), this.dateOnly(b[1])] : b;
        const between = `${f} BETWEEN ${this.p(start)} AND ${this.p(end)}`;
        return op === 'ON' ? between : `(${f} IS NULL OR NOT (${between}))`;
      }
      case 'RELATIVEEE': {
        const b = relativeBounds(c.value, this.env);
        if (!b) return this.bad(c);
        const [start, end] = col?.type === 'glide_date' ? [this.dateOnly(b[0]), this.dateOnly(b[1])] : b;
        return `${f} BETWEEN ${this.p(start)} AND ${this.p(end)}`;
      }
      case 'RELATIVEGT':
      case 'RELATIVELT':
      case 'RELATIVEGE':
      case 'RELATIVELE': {
        const inst = relativeInstant(c.value, this.env);
        if (!inst) return this.bad(c);
        const bound = col?.type === 'glide_date' ? this.dateOnly(inst) : inst;
        return `(${f} <> '' AND ${f} ${RELATIVE_SYMBOLS[op]} ${this.p(bound)})`;
      }
      case 'DATEPART':
        return this.datePart(c, r);
      default:
        break;
    }

    const v = this.value(c.value);
    if (v === null) return this.bad(c);
    const viaMacro = isMacro(c.value);
    const listMacro = viaMacro && macroIsList(c.value);

    switch (op) {
      case '=':
        if (listMacro) return this.inList(f, listItems(v), col, false, nocase);
        if (isRef && v !== '' && !isSysId(v)) {
          const disp = this.displayExpr(c.field, r);
          if (disp) return `${disp} COLLATE NOCASE = ${this.p(v)}`;
        }
        if (v === '') return text ? emptyCheck : `${f} IS NULL`;
        return `${f}${nocase} = ${this.p(this.typed(col, v, viaMacro))}`;
      case '!=':
        if (listMacro) return this.inList(f, listItems(v), col, true, nocase);
        if (isRef && v !== '' && !isSysId(v)) {
          const disp = this.displayExpr(c.field, r);
          if (disp) return `(${f} IS NULL OR ${disp} IS NULL OR ${disp} COLLATE NOCASE <> ${this.p(v)})`;
        }
        if (v === '') return text ? notEmpty : `${f} IS NOT NULL`;
        return `(${f} IS NULL OR ${f}${nocase} <> ${this.p(this.typed(col, v, viaMacro))})`;
      case '>':
      case '>=':
      case '<':
      case '<=': {
        const cmp = `${f}${nocase} ${op} ${this.p(this.typed(col, v, viaMacro))}`;
        return text ? `(${f} <> '' AND ${cmp})` : cmp;
      }
      case 'LIKE':
      case 'NOT LIKE':
      case 'NOTLIKE':
      case 'STARTSWITH':
      case 'ENDSWITH': {
        let target = f;
        if (isRef) target = this.displayExpr(c.field, r) ?? f;
        const pat =
          op === 'STARTSWITH'
            ? `${escapeLike(v)}%`
            : op === 'ENDSWITH'
              ? `%${escapeLike(v)}`
              : `%${escapeLike(v)}%`;
        const like = `${target} LIKE ${this.p(pat)} ESCAPE '\\'`;
        // "does not contain" never returns empty fields.
        if (op === 'NOT LIKE' || op === 'NOTLIKE')
          return `(${target} IS NOT NULL AND ${target} <> '' AND NOT (${like}))`;
        return like;
      }
      case 'IN':
        return this.inList(f, listItems(v), col, false, nocase);
      case 'NOT IN':
      case 'NOTIN':
        return this.inList(f, listItems(v), col, true, nocase);
      default:
        return this.bad(c);
    }
  }

  private inList(
    f: string,
    values: string[],
    col: ColumnMeta | null,
    negate: boolean,
    nocase: string,
  ): string {
    const vals = values.map((x) => x.trim()).filter((x) => x !== '');
    if (vals.length === 0) return negate ? '1=1' : '1=0';
    const list = vals.map((x) => this.p(this.typed(col, x))).join(', ');
    return negate ? `(${f} IS NULL OR ${f}${nocase} NOT IN (${list}))` : `${f}${nocase} IN (${list})`;
  }

  /** Local wall-clock expression of a date column (date-only columns have no zone). */
  private localExpr(r: Resolved): string {
    return r.col?.type === 'glide_date' ? r.sql : localSql(r.sql, this.tz);
  }

  private bucketSql(r: Resolved, unit: CalendarUnit): string {
    const l = this.localExpr(r);
    switch (unit) {
      case 'minute':
        return `strftime('%Y-%m-%d %H:%M', ${l})`;
      case 'hour':
        return `strftime('%Y-%m-%d %H', ${l})`;
      case 'day':
        return `date(${l})`;
      case 'week':
        return `date(${l}, '-6 days', 'weekday 1')`;
      case 'month':
        return `strftime('%Y-%m', ${l})`;
      case 'quarter':
        return `(strftime('%Y', ${l}) || '-' || ((CAST(strftime('%m', ${l}) AS INTEGER) + 2) / 3))`;
      default:
        return `strftime('%Y', ${l})`;
    }
  }

  private fieldCompare(c: Condition, r: Resolved): string | null {
    const { field, unit, badUnit } = parseFieldComparison(c.value);
    const other = this.resolve(field);
    if (!other || badUnit || (other.col && JOURNAL_TYPES.has(other.col.type))) return this.bad(c);
    const sym = FIELD_SYMBOLS[c.op];
    if (unit) {
      if ((c.op !== 'SAMEAS' && c.op !== 'NSAMEAS') || !isDateType(r.col) || !isDateType(other.col))
        return this.bad(c);
      return `${this.bucketSql(r, unit)} ${sym} ${this.bucketSql(other, unit)}`;
    }
    const nocase = c.op === 'SAMEAS' || c.op === 'NSAMEAS' ? this.nocase(r.col) : '';
    return `${r.sql}${nocase} ${sym} ${other.sql}`;
  }

  /** `datetime(col, ±n unit)`; month-based units clamp to the end of the month. */
  private shiftSql(col: string, unit: CalendarUnit, n: number): string {
    const sign = (x: number) => `${x >= 0 ? '+' : ''}${x}`;
    switch (unit) {
      case 'minute':
        return `datetime(${col}, '${sign(n)} minutes')`;
      case 'hour':
        return `datetime(${col}, '${sign(n)} hours')`;
      case 'day':
        return `datetime(${col}, '${sign(n)} days')`;
      case 'week':
        return `datetime(${col}, '${sign(7 * n)} days')`;
      case 'month':
        return `datetime(${col}, '${sign(n)} months', 'floor')`;
      case 'quarter':
        return `datetime(${col}, '${sign(3 * n)} months', 'floor')`;
      default:
        return `datetime(${col}, '${sign(n)} years', 'floor')`;
    }
  }

  /** MORETHAN / LESSTHAN: the gap between two date fields in a direction. */
  private gap(c: Condition, r: Resolved): string | null {
    const g = parseGap(c.value);
    if (!g || !isDateType(r.col)) return this.bad(c);
    const other = this.resolve(g.field);
    if (!other || !isDateType(other.col)) return this.bad(c);
    const f = `datetime(${r.sql})`;
    const o = `datetime(${other.sql})`;
    const minus = this.shiftSql(other.sql, g.unit, -g.n);
    const plus = this.shiftSql(other.sql, g.unit, g.n);
    if (c.op === 'MORETHAN') {
      if (g.position === 'before') return `${f} < ${minus}`;
      if (g.position === 'after') return `${f} > ${plus}`;
      return `(${f} < ${minus} OR ${f} > ${plus})`;
    }
    if (g.position === 'before') return `(${f} <= ${o} AND ${f} > ${minus})`;
    if (g.position === 'after') return `(${f} >= ${o} AND ${f} < ${plus})`;
    return `(${f} > ${minus} AND ${f} < ${plus})`;
  }

  private datePartSql(part: DatePart, l: string): string {
    switch (part) {
      case 'dayofweek':
        return `(CAST(strftime('%w', ${l}) AS INTEGER) + 1)`;
      case 'hour':
        return `CAST(strftime('%H', ${l}) AS INTEGER)`;
      case 'week':
        return `CAST(strftime('%V', ${l}) AS INTEGER)`;
      case 'month':
        return `CAST(strftime('%m', ${l}) AS INTEGER)`;
      case 'quarter':
        return `((CAST(strftime('%m', ${l}) AS INTEGER) + 2) / 3)`;
      case 'year':
        return `CAST(strftime('%Y', ${l}) AS INTEGER)`;
      default:
        return `CAST(strftime('%d', ${l}) AS INTEGER)`;
    }
  }

  /** DATEPART (trend): compares one component of the date in the user's time zone. */
  private datePart(c: Condition, r: Resolved): string | null {
    if (!isDateType(r.col)) return this.bad(c);
    const call = parseDatePartCall(c.value);
    if (!call) return this.bad(c);
    const part = parseDatePart(call.part);
    const sym = DATEPART_OPS[call.op];
    if (!part || !sym) return this.bad(c);
    const n = datePartValue(part, call.value);
    if (n === null) return this.bad(c);
    return `${this.datePartSql(part, this.localExpr(r))} ${sym} ${this.p(n)}`;
  }

  /** IN_HIERARCHY: the start record or any record whose parent chain reaches it. */
  private hierarchy(c: Condition, r: Resolved): string | null {
    if (!r.col || r.col.type !== 'reference' || !r.col.reference) return this.bad(c);
    const target = this.registry.tryTable(r.col.reference);
    if (!target) return this.bad(c);
    const parent = hierarchyParentField(this.registry, target);
    if (!parent) return this.bad(c);
    const raw = c.value.replace(/%40/gi, '@');
    const at = raw.indexOf('@');
    if (at < 0) return this.bad(c);
    const startRaw = raw.slice(at + 1).trim();
    let starts: string[] | null;
    if (c.op === 'IN_HIERARCHY_DYNAMIC') {
      starts = resolveDynamic(startRaw, this.env);
    } else {
      const v = this.value(startRaw);
      starts = v === null ? null : listItems(v);
    }
    if (!starts) return this.bad(c);
    if (!starts.length) return '1=0';
    const tbl = quoteIdent(target.physical);
    const seeds = starts.map((s) => this.p(s)).join(', ');
    const h = `h${++this.n}`;
    return (
      `${r.sql} IN (WITH RECURSIVE ${h}(id) AS (SELECT "sys_id" FROM ${tbl} WHERE "sys_id" IN (${seeds}) ` +
      `UNION SELECT x."sys_id" FROM ${tbl} x JOIN ${h} ON x.${quoteIdent(parent.physical)} = ${h}.id) SELECT id FROM ${h})`
    );
  }

  /** RLQUERY: correlated subquery over the related table, compared with the quantifier. */
  private related(c: Condition): string | null {
    const rq = c.related;
    if (!rq) return this.bad(c);
    const rel = this.registry.tryTable(rq.table);
    if (!rel) return this.bad(c);
    const subAlias = `${this.alias === 't0' ? '' : this.alias}r${++this.n}`;
    const sub = new QueryCompiler(this.registry, rel, this.env, this.textColumns, { alias: subAlias });
    const link = sub.resolve(rq.field);
    const owner = `${this.alias}."sys_id"`;
    let corr: string;
    if (link?.col && isReference(link.col) && link.col.storage) {
      corr = `${link.sql} = ${owner}`;
    } else if (link?.col?.type === 'glide_list' && link.col.storage) {
      corr = `(',' || ${link.sql} || ',') LIKE ('%,' || ${owner} || ',%')`;
    } else {
      return this.bad(c);
    }
    const inner = parseEncodedQuery(rq.query);
    const built = sub.build({ blocks: inner.blocks, orderBy: [], groupBy: [], invalid: inner.invalid });
    for (const t of built.invalid) this.invalid.push(t);
    this.params.push(...built.params);
    const body = `FROM ${built.from} ${built.joins.join(' ')} WHERE ${corr} AND ${built.where}`;
    const q = rq.quantifier;
    if ((q.op === '>=' && q.n === 1) || (q.op === '>' && q.n === 0)) return `EXISTS (SELECT 1 ${body})`;
    if ((q.op === '=' && q.n === 0) || (q.op === '<' && q.n === 1) || (q.op === '<=' && q.n === 0)) {
      return `NOT EXISTS (SELECT 1 ${body})`;
    }
    return `(SELECT COUNT(*) ${body}) ${q.op === '!=' ? '<>' : q.op} ${this.p(q.n)}`;
  }

  /** Journal fields live in sys_journal_field, one row per entry. */
  private journal(c: Condition, r: Resolved): string | null {
    if (!this.registry.has('sys_journal_field')) return this.bad(c);
    const jf = `jf${++this.n}`;
    const field = r.col!.name;
    const scope = () =>
      `FROM "sys_journal_field" ${jf} WHERE ${jf}."element_id" = ${r.alias}."sys_id" AND ${jf}."element" = ${this.p(field)}`;
    switch (c.op) {
      case 'ANYTHING':
        return '1=1';
      case 'ISEMPTY':
        return `NOT EXISTS (SELECT 1 ${scope()})`;
      case 'ISNOTEMPTY':
        return `EXISTS (SELECT 1 ${scope()})`;
      case 'LIKE':
      case 'STARTSWITH':
      case 'ENDSWITH': {
        const v = this.value(c.value);
        if (v === null) return this.bad(c);
        const pat =
          c.op === 'STARTSWITH'
            ? `${escapeLike(v)}%`
            : c.op === 'ENDSWITH'
              ? `%${escapeLike(v)}`
              : `%${escapeLike(v)}%`;
        const s = scope();
        return `EXISTS (SELECT 1 ${s} AND ${jf}."value" LIKE ${this.p(pat)} ESCAPE '\\')`;
      }
      case '=':
      case '!=': {
        const v = this.value(c.value);
        if (v === null) return this.bad(c);
        let test: string;
        if (v === '') {
          test = `NOT EXISTS (SELECT 1 ${scope()})`;
        } else {
          const s = scope();
          test = `EXISTS (SELECT 1 ${s} AND ${jf}."value" = ${this.p(v)} COLLATE NOCASE)`;
        }
        return c.op === '=' ? test : `NOT ${test}`;
      }
      case 'NOT LIKE':
      case 'NOTLIKE': {
        const v = this.value(c.value);
        if (v === null) return this.bad(c);
        const any = `EXISTS (SELECT 1 ${scope()})`;
        const jf2 = `jf${++this.n}`;
        const none = `NOT EXISTS (SELECT 1 FROM "sys_journal_field" ${jf2} WHERE ${jf2}."element_id" = ${r.alias}."sys_id" AND ${jf2}."element" = ${this.p(field)} AND ${jf2}."value" LIKE ${this.p(`%${escapeLike(v)}%`)} ESCAPE '\\')`;
        return `(${any} AND ${none})`;
      }
      default:
        return this.bad(c);
    }
  }

  private textQuery(term: string): string | null {
    const words = searchWords(term);
    if (!words.length) return null;
    const cols = this.textColumns(this.table);
    // A table without searchable columns has no keyword matches.
    if (!cols.length) return '1=0';
    const perWord = words.map((w) => {
      const ors = cols.map(
        (col) => `${this.alias}.${quoteIdent(col.physical)} LIKE ${this.p(`%${escapeLike(w)}%`)} ESCAPE '\\'`,
      );
      return `(${ors.join(' OR ')})`;
    });
    return `(${perWord.join(' AND ')})`;
  }
}

export function defaultTextColumns(table: TableMeta): ColumnMeta[] {
  const names = table.def.textIndex ?? [];
  const out: ColumnMeta[] = [];
  const pick = names.length
    ? names
    : ['number', 'short_description', 'description', 'name', 'title', 'text', 'user_name', 'email'];
  for (const n of pick) {
    const c = table.columns.get(n);
    if (c?.storage === 'TEXT') out.push(c);
  }
  return out;
}
