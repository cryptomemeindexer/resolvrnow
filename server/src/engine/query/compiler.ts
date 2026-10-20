import type { SqlParam } from '../db.js';
import type { SchemaRegistry } from '../registry.js';
import type { ColumnMeta, TableMeta } from '../types.js';
import { escapeLike, isSysId, normalizeDate, normalizeDateTime, parseDuration, quoteIdent } from '../util.js';
import { DYNAMIC_FILTERS, type MacroEnv, relativeInstant, resolveValue } from './macros.js';
import { type Condition, type OrderSpec, type ParsedQuery, parseEncodedQuery, TEXT_QUERY_FIELD } from './parser.js';

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
}

/**
 * Compiles a parsed encoded query into SQL against the table-per-hierarchy layout.
 * Dot-walked fields (`caller_id.department.name`) become LEFT JOINs that are reused
 * between the WHERE and ORDER BY clauses.
 */
export class QueryCompiler {
  private joins = new Map<string, { alias: string; sql: string; table: TableMeta }>();
  private params: SqlParam[] = [];
  private invalid: string[] = [];
  private n = 0;

  constructor(
    private registry: SchemaRegistry,
    private table: TableMeta,
    private env: MacroEnv,
    private textColumns: (table: TableMeta) => ColumnMeta[] = defaultTextColumns,
  ) {}

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
    if (t.name !== t.root || t.parent) {
      // Restrict to this class and its descendants.
      where.push(`t0."sys_class_name" IN (${t.descendants.map(() => '?').join(', ')})`);
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
      if (r.col && (r.col.type === 'reference' || r.col.type === 'document_id') && r.col.reference) {
        const disp = this.displayExpr(o.field, r);
        if (disp) expr = disp;
      }
      order.push(`${expr} ${o.desc ? 'DESC' : 'ASC'}`);
    }
    return {
      from: `${quoteIdent(t.physical)} t0`,
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
    let alias = 't0';
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const col = table.columns.get(name);
      if (!col) return null;
      if (i === parts.length - 1) {
        if (!col.storage) return { sql: 'NULL', col, table };
        return { sql: `${alias}.${quoteIdent(col.physical)}`, col, table };
      }
      if (col.type !== 'reference' || !col.reference) return null;
      const target = this.registry.tryTable(col.reference);
      if (!target) return null;
      prefix = prefix ? `${prefix}.${name}` : name;
      let j = this.joins.get(prefix);
      if (!j) {
        const a = `j${++this.n}`;
        j = {
          alias: a,
          table: target,
          sql: `LEFT JOIN ${quoteIdent(target.physical)} ${a} ON ${a}."sys_id" = ${alias}.${quoteIdent(col.physical)}`,
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

  private value(raw: string): string | null {
    return resolveValue(raw, this.env);
  }

  private typed(col: ColumnMeta | null, v: string): SqlParam {
    if (!col) return v;
    switch (col.type) {
      case 'boolean':
        return ['true', '1', 'yes'].includes(v.toLowerCase()) ? 1 : 0;
      case 'integer':
        return /^-?\d+$/.test(v) ? Number(v) : v;
      case 'decimal':
      case 'float':
      case 'currency':
      case 'price':
      case 'percent_complete':
        return Number.isNaN(Number(v)) ? v : Number(v);
      case 'glide_duration':
        return parseDuration(v);
      case 'glide_date_time':
      case 'due_date':
        return normalizeDateTime(v) ?? v;
      case 'glide_date':
        return normalizeDate(v) ?? v;
      default:
        return v;
    }
  }

  private isText(col: ColumnMeta | null): boolean {
    return !col || col.storage === 'TEXT';
  }

  private condition(c: Condition): string | null {
    if (c.field === TEXT_QUERY_FIELD) return this.textQuery(c.value);
    const r = this.resolve(c.field);
    if (!r) {
      this.invalid.push(c.raw);
      return null;
    }
    const { col } = r;
    const f = r.sql;
    const nocase = this.isText(col) && col?.type !== 'GUID' && col?.type !== 'reference' ? ' COLLATE NOCASE' : '';
    const isRef = !!col && (col.type === 'reference' || col.type === 'document_id');
    const emptyCheck = `(${f} IS NULL OR ${f} = '')`;
    const notEmpty = `(${f} IS NOT NULL AND ${f} <> '')`;
    const op = c.op;

    switch (op) {
      case 'ANYTHING':
        return '1=1';
      case 'ISEMPTY':
        return this.isText(col) ? emptyCheck : `${f} IS NULL`;
      case 'ISNOTEMPTY':
        return this.isText(col) ? notEmpty : `${f} IS NOT NULL`;
      case 'EMPTYSTRING':
        return `${f} = ''`;
      case 'VALCHANGES':
      case 'CHANGESFROM':
      case 'CHANGESTO':
        // Change operators only make sense against a before/after pair (business rule conditions).
        return '1=1';
      case 'DYNAMIC': {
        const dyn = DYNAMIC_FILTERS[c.value];
        if (!dyn) {
          this.invalid.push(c.raw);
          return null;
        }
        const v = this.value(dyn.script) ?? '';
        if (v.includes(',')) return this.inList(f, v.split(','), col, false, nocase);
        return `${f}${nocase} = ${this.p(v)}`;
      }
      case 'INSTANCEOF': {
        const t = this.registry.tryTable(c.value);
        const classes = t ? t.descendants : [c.value];
        return `${f} IN (${classes.map((x) => this.p(x)).join(', ')})`;
      }
      case 'SAMEAS':
      case 'NSAMEAS':
      case 'GT_FIELD':
      case 'LT_FIELD':
      case 'GT_OR_EQUALS_FIELD':
      case 'LT_OR_EQUALS_FIELD': {
        const other = this.resolve(c.value);
        if (!other) {
          this.invalid.push(c.raw);
          return null;
        }
        const sym = { SAMEAS: '=', NSAMEAS: '<>', GT_FIELD: '>', LT_FIELD: '<', GT_OR_EQUALS_FIELD: '>=', LT_OR_EQUALS_FIELD: '<=' }[
          op
        ];
        return `${f} ${sym} ${other.sql}`;
      }
      case 'BETWEEN': {
        const [a, b] = c.value.split('@');
        const va = this.value(a ?? '');
        const vb = this.value(b ?? '');
        if (va === null || vb === null) {
          this.invalid.push(c.raw);
          return null;
        }
        return `${f} BETWEEN ${this.p(this.typed(col, va))} AND ${this.p(this.typed(col, vb))}`;
      }
      case 'ON':
      case 'NOTON': {
        // label@start@end
        const parts = c.value.split('@');
        let start: string | null;
        let end: string | null;
        if (parts.length >= 3) {
          start = this.value(parts[1]);
          end = this.value(parts[2]);
        } else {
          const day = normalizeDate(parts[0]);
          start = day ? `${day} 00:00:00` : null;
          end = day ? `${day} 23:59:59` : null;
        }
        if (start === null || end === null) {
          this.invalid.push(c.raw);
          return null;
        }
        if (col?.type === 'glide_date') {
          start = start.slice(0, 10);
          end = end.slice(0, 10);
        }
        const between = `${f} BETWEEN ${this.p(start)} AND ${this.p(end)}`;
        return op === 'ON' ? between : `(${f} IS NULL OR NOT (${between}))`;
      }
      case 'RELATIVEGT':
      case 'RELATIVELT':
      case 'RELATIVEGE':
      case 'RELATIVELE':
      case 'RELATIVEEE': {
        const inst = relativeInstant(c.value);
        if (!inst) {
          this.invalid.push(c.raw);
          return null;
        }
        const sym = { RELATIVEGT: '>', RELATIVELT: '<', RELATIVEGE: '>=', RELATIVELE: '<=', RELATIVEEE: '=' }[op];
        if (op === 'RELATIVEEE') {
          return `substr(${f}, 1, 10) = ${this.p(inst.slice(0, 10))}`;
        }
        return `${f} ${sym} ${this.p(col?.type === 'glide_date' ? inst.slice(0, 10) : inst)}`;
      }
      case 'DATEPART':
      case 'MORETHAN':
      case 'LESSTHAN':
        this.invalid.push(c.raw);
        return null;
      default:
        break;
    }

    const v = this.value(c.value);
    if (v === null) {
      this.invalid.push(c.raw);
      return null;
    }

    switch (op) {
      case '=':
        if (isRef && v !== '' && !isSysId(v)) {
          const disp = this.displayExpr(c.field, r);
          if (disp) return `${disp} COLLATE NOCASE = ${this.p(v)}`;
        }
        if (v === '' && this.isText(col)) return emptyCheck;
        return `${f}${nocase} = ${this.p(this.typed(col, v))}`;
      case '!=':
        if (isRef && v !== '' && !isSysId(v)) {
          const disp = this.displayExpr(c.field, r);
          if (disp) return `(${f} IS NULL OR ${disp} IS NULL OR ${disp} COLLATE NOCASE <> ${this.p(v)})`;
        }
        if (v === '' && this.isText(col)) return notEmpty;
        return `(${f} IS NULL OR ${f}${nocase} <> ${this.p(this.typed(col, v))})`;
      case '>':
      case '>=':
      case '<':
      case '<=':
        return `${f} ${op} ${this.p(this.typed(col, v))}`;
      case 'LIKE':
      case 'NOT LIKE':
      case 'NOTLIKE':
      case 'STARTSWITH':
      case 'ENDSWITH': {
        let target = f;
        if (isRef) target = this.displayExpr(c.field, r) ?? f;
        const pat =
          op === 'STARTSWITH' ? `${escapeLike(v)}%` : op === 'ENDSWITH' ? `%${escapeLike(v)}` : `%${escapeLike(v)}%`;
        const like = `${target} LIKE ${this.p(pat)} ESCAPE '\\'`;
        return op === 'NOT LIKE' || op === 'NOTLIKE' ? `(${target} IS NULL OR NOT (${like}))` : like;
      }
      case 'IN':
        return this.inList(f, v.split(','), col, false, nocase);
      case 'NOT IN':
      case 'NOTIN':
        return this.inList(f, v.split(','), col, true, nocase);
      default:
        this.invalid.push(c.raw);
        return null;
    }
  }

  private inList(f: string, values: string[], col: ColumnMeta | null, negate: boolean, nocase: string): string {
    const vals = values.map((x) => x.trim()).filter((x) => x !== '');
    if (vals.length === 0) return negate ? '1=1' : '1=0';
    const list = vals.map((x) => this.p(this.typed(col, x))).join(', ');
    return negate ? `(${f} IS NULL OR ${f}${nocase} NOT IN (${list}))` : `${f}${nocase} IN (${list})`;
  }

  private textQuery(term: string): string | null {
    const words = term
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (!words.length) return null;
    const cols = this.textColumns(this.table);
    if (!cols.length) return null;
    const perWord = words.map((w) => {
      const pat = this.p(`%${escapeLike(w)}%`);
      // Re-use the same bound pattern for each column.
      const idx = this.params.length - 1;
      const ors = cols.map((c, i) => {
        if (i > 0) this.params.push(this.params[idx]);
        return `t0.${quoteIdent(c.physical)} LIKE ${i === 0 ? pat : '?'} ESCAPE '\\'`;
      });
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
