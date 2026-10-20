import type { SchemaRegistry } from '../registry.js';
import type { ColumnMeta, TableMeta } from '../types.js';
import { parseDuration } from '../util.js';
import { type CalendarUnit, parseUnit } from './datetime.js';
import type { Quantifier } from './parser.js';

/**
 * Operand helpers shared by the SQL compiler and the in-memory matcher, so both
 * evaluate encoded queries with the same semantics.
 */

/** Sentinel for a boolean literal that is neither true nor false: it matches nothing. */
export const INVALID_BOOLEAN = -1;

/** `true`/`1`/`yes` (any case) is 1, `false`/`0`/`no` is 0, anything else matches nothing. */
export function booleanLiteral(v: string): number {
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return 1;
  if (s === 'false' || s === '0' || s === 'no') return 0;
  return INVALID_BOOLEAN;
}

/**
 * Duration operand in milliseconds. Accepts `1970-01-01 HH:MM:SS`, `D HH:MM:SS`,
 * `HH:MM:SS`, a millisecond count and unit words such as `2 Days 3 Hours`.
 */
export function durationMs(v: string): number | null {
  const m = /^\s*(\d+)\s+(\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(v);
  if (m) return ((Number(m[1]) * 24 + Number(m[2])) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
  return parseDuration(v);
}

/** IN / NOT IN list items: trimmed, empty items dropped. Commas cannot be escaped. */
export function listItems(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

/** Keyword search terms: whitespace separated, a "quoted phrase" counts as one term. */
export function searchWords(term: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(term))) {
    const w = (m[1] ?? m[2] ?? '').trim();
    if (w) out.push(w);
  }
  return out;
}

export function isReference(col: ColumnMeta | null | undefined): boolean {
  return !!col && (col.type === 'reference' || col.type === 'document_id');
}

export function isDateType(col: ColumnMeta | null | undefined): boolean {
  return !!col && (col.type === 'glide_date_time' || col.type === 'glide_date' || col.type === 'due_date');
}

/** Field comparison operand: `other[@unit]`. */
export function parseFieldComparison(v: string): {
  field: string;
  unit: CalendarUnit | null;
  badUnit: boolean;
} {
  const at = v.indexOf('@');
  if (at < 0) return { field: v.trim(), unit: null, badUnit: false };
  const unit = parseUnit(v.slice(at + 1));
  return { field: v.slice(0, at).trim(), unit, badUnit: unit === null || unit === 'second' };
}

export type GapPosition = 'before' | 'after' | 'either';

/** MORETHAN / LESSTHAN operand: `other@unit@before|after|beforeorafter@n` (n has at most two digits). */
export function parseGap(
  v: string,
): { field: string; unit: CalendarUnit; position: GapPosition; n: number } | null {
  const parts = v.split('@');
  if (parts.length !== 4) return null;
  const [field, u, pos, n] = parts.map((p) => p.trim());
  const unit = parseUnit(u);
  if (!field || !unit || unit === 'second' || !/^\d{1,2}$/.test(n)) return null;
  const p = pos.toLowerCase().replace(/[\s_-]/g, '');
  const position: GapPosition | null =
    p === 'before'
      ? 'before'
      : p === 'after'
        ? 'after'
        : p === 'beforeorafter' || p === 'either'
          ? 'either'
          : null;
  if (!position) return null;
  return { field, unit, position, n: Number(n) };
}

/** Evaluates a related-list quantifier against a count. */
export function quantifierMatches(q: Quantifier, count: number): boolean {
  switch (q.op) {
    case '>=':
      return count >= q.n;
    case '>':
      return count > q.n;
    case '<=':
      return count <= q.n;
    case '<':
      return count < q.n;
    case '!=':
      return count !== q.n;
    default:
      return count === q.n;
  }
}

/**
 * Field that links a record to its parent in a self-referencing hierarchy (used by
 * IN_HIERARCHY): `parent`, or `manager` for users, when it references the same class tree.
 */
export function hierarchyParentField(registry: SchemaRegistry, target: TableMeta): ColumnMeta | null {
  for (const name of ['parent', 'manager']) {
    const col = target.columns.get(name);
    if (!col || col.type !== 'reference' || !col.reference || !col.storage) continue;
    const ref = registry.tryTable(col.reference);
    if (ref && ref.root === target.root) return col;
  }
  return null;
}

/** Parses the `gs.datePart('part','value','OP')` call inside a DATEPART operand. */
export function parseDatePartCall(v: string): { part: string; value: string; op: string } | null {
  const m = /gs\.datePart\(\s*(['"])([^'"]*)\1\s*,\s*(['"])([^'"]*)\3\s*,\s*(['"])([^'"]*)\5\s*\)/.exec(v);
  if (!m) return null;
  return { part: m[2], value: m[4], op: m[6].toUpperCase() };
}

export const DATEPART_OPS: Record<string, '=' | '>' | '>=' | '<' | '<='> = {
  EE: '=',
  GT: '>',
  GE: '>=',
  LT: '<',
  LE: '<=',
};
