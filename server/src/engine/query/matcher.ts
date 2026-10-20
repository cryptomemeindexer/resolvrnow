import type { ColumnMeta, Internal } from '../types.js';
import { SYS_ID_RE, normalizeDate, normalizeDateTime, parseDuration } from '../util.js';
const isSysId = (v: string): boolean => SYS_ID_RE.test(v);
import { DYNAMIC_FILTERS, type MacroEnv, relativeInstant, resolveValue } from './macros.js';
import { type Condition, type ParsedQuery, parseEncodedQuery, TEXT_QUERY_FIELD } from './parser.js';

/** Abstraction over a record so conditions can be evaluated without SQL (rule conditions, SLA, ACL, notifications). */
export interface MatchSubject {
  /** Stored value of a field path (dot-walks allowed). `undefined` means the field does not exist. */
  value(path: string): Internal | undefined;
  /** Stored value before the current change, for CHANGES operators. */
  previous(path: string): Internal | undefined;
  /** True when the record is being inserted (every field counts as changed). */
  isNew(): boolean;
  column(path: string): ColumnMeta | null;
  /** Display value of a reference/choice path (used for non-sys_id reference comparisons). */
  display(path: string): string;
  /** Class hierarchy (self + ancestors) of the record, for INSTANCEOF. */
  classes(): string[];
  /** Descendant classes of a table, for INSTANCEOF value expansion. */
  descendantsOf(table: string): string[];
  /** Text used for 123TEXTQUERY321 matching. */
  text(): string;
}

const str = (v: Internal | undefined): string => (v === null || v === undefined ? '' : String(v));

function norm(col: ColumnMeta | null, v: string): string | number | null {
  if (!col) return v;
  switch (col.type) {
    case 'boolean':
      return ['true', '1', 'yes'].includes(v.toLowerCase()) ? 1 : 0;
    case 'integer':
    case 'decimal':
    case 'float':
    case 'currency':
    case 'price':
    case 'percent_complete':
      return v === '' || Number.isNaN(Number(v)) ? v : Number(v);
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

function cmp(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isEmpty(v: Internal | undefined): boolean {
  return v === null || v === undefined || v === '';
}

export function matchCondition(c: Condition, s: MatchSubject, env: MacroEnv): boolean | null {
  if (c.field === TEXT_QUERY_FIELD) {
    const t = s.text().toLowerCase();
    return c.value
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => t.includes(w));
  }
  const raw = s.value(c.field);
  if (raw === undefined) return null; // invalid field: ignored
  const col = s.column(c.field);
  const isRef = !!col && (col.type === 'reference' || col.type === 'document_id');
  const current = raw;

  switch (c.op) {
    case 'ANYTHING':
      return true;
    case 'ISEMPTY':
      return isEmpty(current);
    case 'ISNOTEMPTY':
      return !isEmpty(current);
    case 'EMPTYSTRING':
      return current === '';
    case 'VALCHANGES':
      return s.isNew() ? !isEmpty(current) : str(s.previous(c.field)) !== str(current);
    case 'CHANGESFROM': {
      if (s.isNew()) return false;
      const prev = s.previous(c.field);
      const v = resolveValue(c.value, env) ?? '';
      return str(prev) !== str(current) && cmp(norm(col, str(prev)), norm(col, v)) === 0;
    }
    case 'CHANGESTO': {
      const prev = s.isNew() ? null : s.previous(c.field);
      const v = resolveValue(c.value, env) ?? '';
      return (s.isNew() || str(prev) !== str(current)) && cmp(norm(col, str(current)), norm(col, v)) === 0;
    }
    case 'INSTANCEOF': {
      const classes = s.classes();
      return classes.includes(c.value) || s.descendantsOf(c.value).includes(str(current));
    }
    case 'DYNAMIC': {
      const dyn = DYNAMIC_FILTERS[c.value];
      if (!dyn) return null;
      const v = resolveValue(dyn.script, env) ?? '';
      return v.split(',').includes(str(current));
    }
    case 'SAMEAS':
    case 'NSAMEAS':
    case 'GT_FIELD':
    case 'LT_FIELD':
    case 'GT_OR_EQUALS_FIELD':
    case 'LT_OR_EQUALS_FIELD': {
      const other = s.value(c.value);
      if (other === undefined) return null;
      const d = cmp(norm(col, str(current)), norm(col, str(other)));
      switch (c.op) {
        case 'SAMEAS':
          return d === 0;
        case 'NSAMEAS':
          return d !== 0;
        case 'GT_FIELD':
          return d > 0;
        case 'LT_FIELD':
          return d < 0;
        case 'GT_OR_EQUALS_FIELD':
          return d >= 0;
        default:
          return d <= 0;
      }
    }
    case 'BETWEEN': {
      const [a, b] = c.value.split('@');
      const va = resolveValue(a ?? '', env);
      const vb = resolveValue(b ?? '', env);
      if (va === null || vb === null || isEmpty(current)) return false;
      const x = norm(col, str(current));
      return cmp(x, norm(col, va)) >= 0 && cmp(x, norm(col, vb)) <= 0;
    }
    case 'ON':
    case 'NOTON': {
      const parts = c.value.split('@');
      let start: string | null;
      let end: string | null;
      if (parts.length >= 3) {
        start = resolveValue(parts[1], env);
        end = resolveValue(parts[2], env);
      } else {
        const day = normalizeDate(parts[0]);
        start = day ? `${day} 00:00:00` : null;
        end = day ? `${day} 23:59:59` : null;
      }
      if (start === null || end === null) return null;
      const x = str(current);
      const inside = !isEmpty(current) && x >= start.slice(0, x.length) && x <= end.slice(0, Math.max(x.length, 10));
      return c.op === 'ON' ? inside : !inside;
    }
    case 'RELATIVEGT':
    case 'RELATIVELT':
    case 'RELATIVEGE':
    case 'RELATIVELE':
    case 'RELATIVEEE': {
      const inst = relativeInstant(c.value);
      if (!inst || isEmpty(current)) return false;
      const x = str(current);
      switch (c.op) {
        case 'RELATIVEGT':
          return x > inst;
        case 'RELATIVELT':
          return x < inst;
        case 'RELATIVEGE':
          return x >= inst;
        case 'RELATIVELE':
          return x <= inst;
        default:
          return x.slice(0, 10) === inst.slice(0, 10);
      }
    }
    case 'DATEPART':
    case 'MORETHAN':
    case 'LESSTHAN':
      return null;
    default:
      break;
  }

  const v = resolveValue(c.value, env);
  if (v === null) return null;
  const x = str(current);

  switch (c.op) {
    case '=': {
      if (isRef && v !== '' && !isSysId(v)) return s.display(c.field).toLowerCase() === v.toLowerCase();
      if (v === '') return isEmpty(current);
      return cmp(norm(col, x), norm(col, v)) === 0;
    }
    case '!=': {
      if (isRef && v !== '' && !isSysId(v)) return s.display(c.field).toLowerCase() !== v.toLowerCase();
      if (v === '') return !isEmpty(current);
      return isEmpty(current) || cmp(norm(col, x), norm(col, v)) !== 0;
    }
    case '>':
      return !isEmpty(current) && cmp(norm(col, x), norm(col, v)) > 0;
    case '>=':
      return !isEmpty(current) && cmp(norm(col, x), norm(col, v)) >= 0;
    case '<':
      return !isEmpty(current) && cmp(norm(col, x), norm(col, v)) < 0;
    case '<=':
      return !isEmpty(current) && cmp(norm(col, x), norm(col, v)) <= 0;
    case 'LIKE':
    case 'NOT LIKE':
    case 'NOTLIKE':
    case 'STARTSWITH':
    case 'ENDSWITH': {
      const target = (isRef ? s.display(c.field) : x).toLowerCase();
      const needle = v.toLowerCase();
      const hit =
        c.op === 'STARTSWITH'
          ? target.startsWith(needle)
          : c.op === 'ENDSWITH'
            ? target.endsWith(needle)
            : target.includes(needle);
      return c.op === 'NOT LIKE' || c.op === 'NOTLIKE' ? !hit : hit;
    }
    case 'IN':
    case 'NOT IN':
    case 'NOTIN': {
      const list = v
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      const hit = list.some((p) => cmp(norm(col, x), norm(col, p)) === 0);
      return c.op === 'IN' ? hit : !hit;
    }
    default:
      return null;
  }
}

/** Evaluates an encoded query against a subject. An empty query matches everything. */
export function matches(query: string | ParsedQuery | null | undefined, s: MatchSubject, env: MacroEnv): boolean {
  const parsed = typeof query === 'string' || query == null ? parseEncodedQuery(query) : query;
  if (parsed.blocks.length === 0) return true;
  return parsed.blocks.some((block) =>
    block.every((cluster) => {
      const results = cluster.map((c) => matchCondition(c, s, env)).filter((r): r is boolean => r !== null);
      if (results.length === 0) return true; // all terms invalid: ignored
      return results.some(Boolean);
    }),
  );
}
