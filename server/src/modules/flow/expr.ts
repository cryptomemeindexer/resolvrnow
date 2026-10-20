/**
 * Data pills, string templates, the restricted expression grammar and conditions of
 * flow definitions. Nothing here is passed to a JavaScript evaluator: expressions are
 * parsed by a small recursive-descent parser that only knows literals, pill paths,
 * comparisons, `!`, `&&`, `||`, `? :` and parentheses.
 */
import type { MacroEnv } from '../../engine/query/macros.js';
import { matches } from '../../engine/query/matcher.js';
import { Rec } from '../../engine/record.js';
import type { SchemaRegistry } from '../../engine/registry.js';
import { recSubject } from '../../engine/rules.js';
import { type ColumnMeta, NUMERIC_TYPES } from '../../engine/types.js';
import type { RecordRef } from './types.js';

export interface EvalEnv {
  /** Value of the first segment of a pill path (trigger, vars, steps, inputs, loop items...). */
  root(name: string): unknown;
  /** Loads a record without ACL checks (null when it does not exist). */
  load(table: string, sysId: string): Rec | null;
  registry: SchemaRegistry;
  macros: MacroEnv;
}

export class ExpressionError extends Error {}

// ------------------------------------------------------------------ values

export function isRef(v: unknown): v is RecordRef {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as RecordRef).$table === 'string' &&
    typeof (v as RecordRef).$sys_id === 'string'
  );
}

export function refOf(rec: Rec): RecordRef {
  return { $table: rec.className, $sys_id: rec.sysId };
}

/** Converts runtime values to their persisted JSON form (records become references). */
export function serialize(v: unknown): unknown {
  if (v instanceof Rec) return refOf(v);
  if (Array.isArray(v)) return v.map(serialize);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && !isRef(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const s = serialize(x);
      if (s !== undefined && typeof s !== 'function') out[k] = s;
    }
    return out;
  }
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return undefined;
  return v;
}

/** sys_id of a record value (reference, Rec, `{sys_id}` / `{value}` object, or the string itself). */
export function sysIdOf(v: unknown): string {
  if (v instanceof Rec) return v.sysId;
  if (isRef(v)) return v.$sys_id;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.sys_id === 'string') return o.sys_id;
    if (typeof o.value === 'string') return o.value;
  }
  return '';
}

/** Resolves a record argument: Rec, reference, `{table, sys_id}`, or a sys_id with a table hint. */
export function toRec(v: unknown, env: EvalEnv, tableHint?: string | null): Rec | null {
  if (v instanceof Rec) return env.load(v.className, v.sysId) ?? v;
  if (isRef(v)) return env.load(v.$table, v.$sys_id);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const table = typeof o.table === 'string' ? o.table : tableHint;
    const id = typeof o.sys_id === 'string' ? o.sys_id : typeof o.value === 'string' ? o.value : '';
    return table && id ? env.load(table, id) : null;
  }
  if (typeof v === 'string' && tableHint) return env.load(tableHint, v.trim());
  return null;
}

export function displayOf(v: unknown, env: EvalEnv): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Rec) return v.displayValue();
  if (isRef(v)) return env.load(v.$table, v.$sys_id)?.displayValue() ?? '';
  if (Array.isArray(v)) return v.map((x) => displayOf(x, env)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function columnAt(rec: Rec, path: string, registry: SchemaRegistry): ColumnMeta | null {
  const parts = path.split('.');
  let table = rec.table;
  for (let i = 0; i < parts.length; i++) {
    const col = table.columns.get(parts[i]);
    if (!col) return null;
    if (i === parts.length - 1) return col;
    if (col.type !== 'reference' || !col.reference) return null;
    const next = registry.tryTable(col.reference);
    if (!next) return null;
    table = next;
  }
  return null;
}

/** Field of a record as a pill value: booleans and numbers typed, references as sys_ids. */
function fieldValue(rec: Rec, path: string, env: EvalEnv, display: boolean): unknown {
  if (!path) return display ? rec.displayValue() : refOf(rec);
  const col = columnAt(rec, path, env.registry);
  if (!col) return undefined;
  if (display) return rec.display(path);
  const v = rec.get(path);
  if (v === null || v === undefined) return col.type === 'boolean' ? false : '';
  if (col.type === 'boolean') return v === 1 || v === '1' || v === 'true';
  if (NUMERIC_TYPES.has(col.type) || col.type === 'integer') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

/** Walks a pill path such as `trigger.current.assigned_to.email` or `steps.lookup.records.0`. */
export function resolvePath(path: string, env: EvalEnv, display = false): unknown {
  const parts = path
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  let cur: unknown = env.root(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (cur instanceof Rec || isRef(cur)) {
      const rec = cur instanceof Rec ? cur : env.load(cur.$table, cur.$sys_id);
      return rec ? fieldValue(rec, parts.slice(i).join('.'), env, display) : undefined;
    }
    const part = parts[i];
    if (Array.isArray(cur)) {
      if (part === 'length' || part === 'count' || part === 'size') {
        cur = cur.length;
        continue;
      }
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
      continue;
    }
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  if (display) return displayOf(cur, env);
  return cur;
}

// ------------------------------------------------------------ comparisons

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function scalar(v: unknown): unknown {
  if (v instanceof Rec) return v.sysId;
  if (isRef(v)) return v.$sys_id;
  return v;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function looseEquals(a: unknown, b: unknown): boolean {
  const x = scalar(a);
  const y = scalar(b);
  if (isEmptyValue(x) && isEmptyValue(y)) return true;
  if (typeof x === 'boolean' || typeof y === 'boolean') return truthy(x) === truthy(y);
  const nx = asNumber(x);
  const ny = asNumber(y);
  if (nx !== null && ny !== null) return nx === ny;
  return String(x ?? '') === String(y ?? '');
}

function order(a: unknown, b: unknown): number {
  const x = scalar(a);
  const y = scalar(b);
  const nx = asNumber(x);
  const ny = asNumber(y);
  if (nx !== null && ny !== null) return nx - ny;
  const sx = String(x ?? '');
  const sy = String(y ?? '');
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== 'false' && s !== '0';
  }
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function listOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map((s) => s.trim());
  return v === null || v === undefined ? [] : [v];
}

export function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op.trim().toLowerCase()) {
    case '=':
    case '==':
    case '===':
    case 'is':
    case 'equals':
      return looseEquals(left, right);
    case '!=':
    case '!==':
    case '<>':
    case 'is_not':
    case 'not_equals':
      return !looseEquals(left, right);
    case '>':
      return !isEmptyValue(left) && order(left, right) > 0;
    case '>=':
      return !isEmptyValue(left) && order(left, right) >= 0;
    case '<':
      return !isEmptyValue(left) && order(left, right) < 0;
    case '<=':
      return !isEmptyValue(left) && order(left, right) <= 0;
    case 'contains':
      if (Array.isArray(left)) return left.some((x) => looseEquals(x, right));
      return String(scalar(left) ?? '')
        .toLowerCase()
        .includes(String(scalar(right) ?? '').toLowerCase());
    case 'does_not_contain':
      return !compare(left, 'contains', right);
    case 'starts_with':
      return String(scalar(left) ?? '')
        .toLowerCase()
        .startsWith(String(scalar(right) ?? '').toLowerCase());
    case 'ends_with':
      return String(scalar(left) ?? '')
        .toLowerCase()
        .endsWith(String(scalar(right) ?? '').toLowerCase());
    case 'in':
      return listOf(right).some((x) => looseEquals(left, x));
    case 'not_in':
      return !listOf(right).some((x) => looseEquals(left, x));
    case 'is_empty':
      return isEmptyValue(scalar(left));
    case 'is_not_empty':
      return !isEmptyValue(scalar(left));
    default:
      throw new ExpressionError(`Unknown comparison operator "${op}"`);
  }
}

// ------------------------------------------------------------- expressions

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'path'; v: string }
  | { t: 'op'; v: string };

const OPS = ['===', '!==', '==', '!=', '>=', '<=', '&&', '||', '>', '<', '!', '?', ':', '(', ')', '|', '-'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw new ExpressionError('Unterminated string in expression');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const path = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*/.exec(src.slice(i));
    if (path) {
      out.push({ t: 'path', v: path[0] });
      i += path[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character "${ch}" in expression`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(
    private tokens: Token[],
    private env: EvalEnv,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new ExpressionError(`Expected "${v}" in expression`);
    this.i++;
  }

  parse(): unknown {
    const v = this.ternary();
    if (this.i < this.tokens.length) throw new ExpressionError('Unexpected token in expression');
    return v;
  }

  private ternary(): unknown {
    const cond = this.or();
    if (!this.isOp('?')) return cond;
    this.i++;
    const a = this.ternary();
    this.expect(':');
    const b = this.ternary();
    return truthy(cond) ? a : b;
  }

  private or(): unknown {
    let v = this.and();
    while (this.isOp('||')) {
      this.i++;
      const r = this.and();
      v = truthy(v) ? v : r;
    }
    return v;
  }

  private and(): unknown {
    let v = this.cmp();
    while (this.isOp('&&')) {
      this.i++;
      const r = this.cmp();
      v = truthy(v) ? r : v;
    }
    return v;
  }

  private cmp(): unknown {
    const left = this.unary();
    const t = this.peek();
    if (t?.t === 'op' && ['==', '!=', '===', '!==', '>', '>=', '<', '<='].includes(t.v)) {
      this.i++;
      return compare(left, t.v, this.unary());
    }
    return left;
  }

  private unary(): unknown {
    if (this.isOp('!')) {
      this.i++;
      return !truthy(this.unary());
    }
    if (this.isOp('-')) {
      this.i++;
      const v = asNumber(scalar(this.unary()));
      if (v === null) throw new ExpressionError('Unary minus needs a number');
      return -v;
    }
    return this.primary();
  }

  private primary(): unknown {
    const t = this.peek();
    if (!t) throw new ExpressionError('Unexpected end of expression');
    this.i++;
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = this.ternary();
      this.expect(')');
      return v;
    }
    if (t.t === 'path') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null' || t.v === 'undefined') return null;
      let display = false;
      while (this.isOp('|')) {
        this.i++;
        const f = this.peek();
        if (f?.t !== 'path') throw new ExpressionError('Expected a filter name after "|"');
        this.i++;
        if (f.v === 'display') display = true;
        else throw new ExpressionError(`Unknown filter "${f.v}"`);
      }
      return resolvePath(t.v, this.env, display);
    }
    throw new ExpressionError(`Unexpected "${t.v}" in expression`);
  }
}

export function evaluate(expression: string, env: EvalEnv): unknown {
  return new Parser(tokenize(expression), env).parse();
}

// --------------------------------------------------------------- templates

const SINGLE_PILL = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
const PILL = /\{\{([\s\S]+?)\}\}/g;

/**
 * Resolves `{{...}}` in a value. A string that is exactly one pill keeps the pill's
 * type (record, number, list...); otherwise pills are interpolated as text.
 * Objects and arrays are resolved recursively.
 */
export function render(value: unknown, env: EvalEnv): unknown {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    const single = SINGLE_PILL.exec(value);
    if (single && !single[1].includes('}}') && !single[1].includes('{{')) return evaluate(single[1], env);
    return value.replace(PILL, (_m, expr: string) => displayOf(evaluate(expr, env), env));
  }
  if (Array.isArray(value)) return value.map((v) => render(v, env));
  if (value && typeof value === 'object' && !isRef(value) && !(value instanceof Rec)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, env);
    return out;
  }
  return value;
}

// --------------------------------------------------------------- conditions

/** True when `rec` matches an encoded query; `previous` enables change operators. */
export function recordMatches(
  rec: Rec,
  query: string,
  env: EvalEnv,
  previous: Rec | null = null,
  isNew = false,
): boolean {
  const subject = recSubject(rec, previous, env.registry);
  return matches(query, isNew ? { ...subject, isNew: () => true } : subject, env.macros);
}

/**
 * Evaluates a flow condition: an expression string (`{{...}}`), an encoded query
 * (string, on the default record), `{record, query}`, `{all|any: [...]}`, `{not: ...}`
 * or a comparison `{left, op, right}`.
 */
export function evalCondition(cond: unknown, env: EvalEnv, defaultRecord: () => Rec | null): boolean {
  if (cond === undefined || cond === null) return true;
  if (typeof cond === 'boolean') return cond;
  if (typeof cond === 'number') return cond !== 0;
  if (typeof cond === 'string') {
    if (cond.includes('{{')) return truthy(render(cond, env));
    const rec = defaultRecord();
    return !!rec && recordMatches(rec, cond, env);
  }
  if (Array.isArray(cond)) return cond.every((c) => evalCondition(c, env, defaultRecord));
  if (typeof cond === 'object') {
    const o = cond as Record<string, unknown>;
    if ('all' in o) return listOf(o.all).every((c) => evalCondition(c, env, defaultRecord));
    if ('any' in o) return listOf(o.any).some((c) => evalCondition(c, env, defaultRecord));
    if ('not' in o) return !evalCondition(o.not, env, defaultRecord);
    if ('query' in o) {
      const rec =
        'record' in o
          ? toRec(render(o.record, env), env, typeof o.table === 'string' ? o.table : null)
          : defaultRecord();
      return !!rec && recordMatches(rec, String(render(o.query, env) ?? ''), env);
    }
    if ('expression' in o) return truthy(evaluate(String(o.expression), env));
    if ('left' in o || 'op' in o)
      return compare(render(o.left, env), String(o.op ?? '='), render(o.right, env));
  }
  throw new ExpressionError('Unsupported condition');
}
