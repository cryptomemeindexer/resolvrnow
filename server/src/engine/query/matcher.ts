import { type ColumnMeta, type Internal, JOURNAL_TYPES } from '../types.js';
import { normalizeDate, normalizeDateTime, SYS_ID_RE } from '../util.js';
import {
  addUnits,
  type CalendarUnit,
  datePartValue,
  extractPart,
  localDate,
  normalizeZone,
  parseDatePart,
  parseUtc,
  startOf,
  toLocal,
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
  isDateType,
  isReference,
  listItems,
  parseDatePartCall,
  parseFieldComparison,
  parseGap,
  quantifierMatches,
  searchWords,
} from './operands.js';
import {
  type Condition,
  type ParsedQuery,
  parseEncodedQuery,
  type RelatedQuery,
  TEXT_INDEX_GROUP_FIELD,
  TEXT_QUERY_FIELD,
} from './parser.js';

const isSysId = (v: string): boolean => SYS_ID_RE.test(v);

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
  /**
   * Optional: number of related records for an RLQUERY condition. Subjects without
   * database access omit it, and RLQUERY terms are then ignored like invalid terms.
   */
  relatedCount?(related: RelatedQuery): number | null;
  /** Optional: journal entry texts of a journal field (comments, work_notes). */
  journal?(path: string): string[] | null;
}

const PASSWORD_OPS = new Set(['ANYTHING', 'ISEMPTY', 'ISNOTEMPTY']);
/** Operators evaluated against journal entries; others (e.g. VALCHANGES in rule conditions) use the row value. */
const JOURNAL_OPS = new Set([
  'ANYTHING',
  'ISEMPTY',
  'ISNOTEMPTY',
  'LIKE',
  'STARTSWITH',
  'ENDSWITH',
  'NOT LIKE',
  'NOTLIKE',
  '=',
  '!=',
]);

const str = (v: Internal | undefined): string => (v === null || v === undefined ? '' : String(v));

function isEmpty(v: Internal | undefined): boolean {
  return v === null || v === undefined || v === '';
}

function dateOnly(v: string, tz: string | null, local = true): string {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t)) {
    if (!local) return t.slice(0, 10);
    const ms = parseUtc(t);
    if (ms !== null) return localDate(ms, tz);
  }
  return normalizeDate(t) ?? t;
}

/** Same coercions as the SQL compiler's typed parameters. */
function norm(col: ColumnMeta | null, v: string, tz: string | null, viaMacro = false): string | number | null {
  if (!col) return v;
  switch (col.type) {
    case 'boolean':
      return booleanLiteral(v);
    case 'integer':
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
      return dateOnly(v, tz, viaMacro);
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

/** Local unit bucket key of a stored date value (mirrors the compiler's strftime buckets). */
function bucketKey(
  v: Internal | undefined,
  col: ColumnMeta | null,
  unit: CalendarUnit,
  tz: string | null,
): string | null {
  const ms = parseUtc(str(v));
  if (ms === null) return null;
  const zone = col?.type === 'glide_date' ? null : tz;
  if (unit === 'week') return String(startOf(ms, zone, 'week'));
  const p = toLocal(ms, zone);
  switch (unit) {
    case 'minute':
      return `${p.y}-${p.m}-${p.d} ${p.h}:${p.mi}`;
    case 'hour':
      return `${p.y}-${p.m}-${p.d} ${p.h}`;
    case 'day':
      return `${p.y}-${p.m}-${p.d}`;
    case 'month':
      return `${p.y}-${p.m}`;
    case 'quarter':
      return `${p.y}-Q${Math.floor((p.m - 1) / 3) + 1}`;
    default:
      return `${p.y}`;
  }
}

/** Parent-link field used by IN_HIERARCHY, found through the subject's dot-walk metadata. */
function parentFieldOf(s: MatchSubject, path: string, col: ColumnMeta): string | null {
  for (const name of ['parent', 'manager']) {
    const pc = s.column(`${path}.${name}`);
    if (!pc || pc.type !== 'reference' || !pc.reference || !col.reference) continue;
    if (
      pc.reference === col.reference ||
      s.descendantsOf(pc.reference).includes(col.reference) ||
      s.descendantsOf(col.reference).includes(pc.reference)
    ) {
      return name;
    }
  }
  return null;
}

function compare(sym: string, d: number): boolean {
  switch (sym) {
    case '=':
      return d === 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '<':
      return d < 0;
    default:
      return d <= 0;
  }
}

function matchJournal(c: Condition, s: MatchSubject, env: MacroEnv): boolean | null {
  const v = resolveValue(c.value, env);
  // Without journal access the field reads as empty (stored rows carry no journal text).
  const entries = s.journal?.(c.field) ?? [];
  switch (c.op) {
    case '=':
    case '!=': {
      if (v === null) return null;
      const hit = v === '' ? entries.length === 0 : entries.some((e) => e.toLowerCase() === v.toLowerCase());
      return c.op === '=' ? hit : !hit;
    }
    case 'ANYTHING':
      return true;
    case 'ISEMPTY':
      return entries.length === 0;
    case 'ISNOTEMPTY':
      return entries.length > 0;
    case 'LIKE':
    case 'STARTSWITH':
    case 'ENDSWITH':
    case 'NOT LIKE':
    case 'NOTLIKE': {
      if (v === null) return null;
      const needle = v.toLowerCase();
      const hit = entries.some((e) => {
        const t = e.toLowerCase();
        return c.op === 'STARTSWITH'
          ? t.startsWith(needle)
          : c.op === 'ENDSWITH'
            ? t.endsWith(needle)
            : t.includes(needle);
      });
      return c.op === 'NOT LIKE' || c.op === 'NOTLIKE' ? entries.length > 0 && !hit : hit;
    }
    default:
      return null;
  }
}

export function matchCondition(c: Condition, s: MatchSubject, env: MacroEnv): boolean | null {
  const tz = normalizeZone(env.timeZone);
  if (c.op === 'RLQUERY') {
    if (!c.related || !s.relatedCount) return null;
    const n = s.relatedCount(c.related);
    return n === null ? null : quantifierMatches(c.related.quantifier, n);
  }
  if (c.field === TEXT_QUERY_FIELD) {
    const words = searchWords(c.value.toLowerCase());
    if (!words.length) return null;
    const t = s.text().toLowerCase();
    return words.every((w) => t.includes(w));
  }
  if (c.field === TEXT_INDEX_GROUP_FIELD) return null;
  const raw = s.value(c.field);
  if (raw === undefined) return null; // invalid field: ignored
  const col = s.column(c.field);
  if (col && JOURNAL_TYPES.has(col.type) && JOURNAL_OPS.has(c.op)) return matchJournal(c, s, env);
  if (col?.type === 'password2' && !PASSWORD_OPS.has(c.op)) return null;
  const isRef = isReference(col);
  const current = raw;
  const text = !col || col.storage === 'TEXT';

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
      return str(prev) !== str(current) && cmp(norm(col, str(prev), tz), norm(col, v, tz)) === 0;
    }
    case 'CHANGESTO': {
      const prev = s.isNew() ? null : s.previous(c.field);
      const v = resolveValue(c.value, env) ?? '';
      return (
        (s.isNew() || str(prev) !== str(current)) && cmp(norm(col, str(current), tz), norm(col, v, tz)) === 0
      );
    }
    case 'DOESNOTHAVE':
    case 'EXCLUDING':
      return null;
    case 'INSTANCEOF': {
      // Same as SQL: the field's value is the class or one of its descendants.
      const target = c.value.trim();
      const desc = s.descendantsOf(target);
      return (desc.length ? desc : [target]).includes(str(current));
    }
    case 'DYNAMIC': {
      const vals = resolveDynamic(c.value, env);
      if (!vals) return null;
      return vals.includes(str(current));
    }
    case 'IN_HIERARCHY':
    case 'IN_HIERARCHY_DYNAMIC': {
      if (!col || col.type !== 'reference') return null;
      const parent = parentFieldOf(s, c.field, col);
      if (!parent) return null;
      const rawValue = c.value.replace(/%40/gi, '@');
      const at = rawValue.indexOf('@');
      if (at < 0) return null;
      const startRaw = rawValue.slice(at + 1).trim();
      let starts: string[] | null;
      if (c.op === 'IN_HIERARCHY_DYNAMIC') {
        starts = resolveDynamic(startRaw, env);
      } else {
        const v = resolveValue(startRaw, env);
        starts = v === null ? null : listItems(v);
      }
      if (!starts) return null;
      let path = c.field;
      let cur = str(current);
      for (let depth = 0; depth < 32 && cur; depth++) {
        if (starts.includes(cur)) return true;
        path = `${path}.${parent}`;
        cur = str(s.value(path));
      }
      return false;
    }
    case 'SAMEAS':
    case 'NSAMEAS':
    case 'GT_FIELD':
    case 'LT_FIELD':
    case 'GT_OR_EQUALS_FIELD':
    case 'LT_OR_EQUALS_FIELD': {
      const { field, unit, badUnit } = parseFieldComparison(c.value);
      const other = s.value(field);
      const ocol = s.column(field);
      if (other === undefined || badUnit || (ocol && JOURNAL_TYPES.has(ocol.type))) return null;
      if (unit) {
        if ((c.op !== 'SAMEAS' && c.op !== 'NSAMEAS') || !isDateType(col) || !isDateType(ocol)) return null;
        const a = bucketKey(current, col, unit, tz);
        const b = bucketKey(other, ocol, unit, tz);
        if (a === null || b === null) return false;
        return c.op === 'SAMEAS' ? a === b : a !== b;
      }
      // SQL semantics: a comparison with NULL is never true.
      if (current === null || other === null) return false;
      const d = cmp(norm(col, str(current), tz), norm(col, str(other), tz));
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
    case 'MORETHAN':
    case 'LESSTHAN': {
      const g = parseGap(c.value);
      if (!g || !isDateType(col)) return null;
      const ocol = s.column(g.field);
      const other = s.value(g.field);
      if (other === undefined || !isDateType(ocol)) return null;
      const f = parseUtc(str(current));
      const o = parseUtc(str(other));
      if (f === null || o === null) return false;
      const minus = addUnits(o, null, g.unit, -g.n);
      const plus = addUnits(o, null, g.unit, g.n);
      if (c.op === 'MORETHAN') {
        if (g.position === 'before') return f < minus;
        if (g.position === 'after') return f > plus;
        return f < minus || f > plus;
      }
      if (g.position === 'before') return f <= o && f > minus;
      if (g.position === 'after') return f >= o && f < plus;
      return f > minus && f < plus;
    }
    case 'BETWEEN': {
      const parts = splitValue(c.value);
      if (parts.length !== 2) return null;
      const va = resolveValue(parts[0], env);
      const vb = resolveValue(parts[1], env);
      if (va === null || vb === null || va.trim() === '' || vb.trim() === '') return null;
      const na = norm(col, va, tz, isMacro(parts[0]));
      const nb = norm(col, vb, tz, isMacro(parts[1]));
      if (na === null || nb === null) return null;
      if (isEmpty(current)) return false;
      const x = norm(col, str(current), tz);
      return cmp(x, na) >= 0 && cmp(x, nb) <= 0;
    }
    case 'ON':
    case 'NOTON': {
      const b = onBounds(c.value, env);
      if (!b) return null;
      const [start, end] = col?.type === 'glide_date' ? [dateOnly(b[0], tz), dateOnly(b[1], tz)] : b;
      const x = str(current);
      const inside = x !== '' && x >= start && x <= end;
      return c.op === 'ON' ? inside : !inside;
    }
    case 'RELATIVEEE': {
      const b = relativeBounds(c.value, env);
      if (!b) return null;
      const [start, end] = col?.type === 'glide_date' ? [dateOnly(b[0], tz), dateOnly(b[1], tz)] : b;
      const x = str(current);
      return x !== '' && x >= start && x <= end;
    }
    case 'RELATIVEGT':
    case 'RELATIVELT':
    case 'RELATIVEGE':
    case 'RELATIVELE': {
      const inst = relativeInstant(c.value, env);
      if (!inst) return null;
      const bound = col?.type === 'glide_date' ? dateOnly(inst, tz) : inst;
      const x = str(current);
      if (x === '') return false;
      if (c.op === 'RELATIVEGT') return x > bound;
      if (c.op === 'RELATIVELT') return x < bound;
      if (c.op === 'RELATIVEGE') return x >= bound;
      return x <= bound;
    }
    case 'DATEPART': {
      if (!isDateType(col)) return null;
      const call = parseDatePartCall(c.value);
      if (!call) return null;
      const part = parseDatePart(call.part);
      const sym = DATEPART_OPS[call.op];
      if (!part || !sym) return null;
      const n = datePartValue(part, call.value);
      if (n === null) return null;
      const ms = parseUtc(str(current));
      if (ms === null) return false;
      const p = toLocal(ms, col?.type === 'glide_date' ? null : tz);
      return compare(sym, extractPart(p, part) - n);
    }
    default:
      break;
  }

  const v = resolveValue(c.value, env);
  if (v === null) return null;
  const x = str(current);
  const viaMacro = isMacro(c.value);
  const listMacro = viaMacro && macroIsList(c.value);

  switch (c.op) {
    case '=': {
      if (listMacro) return listItems(v).some((p) => cmp(norm(col, x, tz), norm(col, p, tz)) === 0);
      if (isRef && v !== '' && !isSysId(v)) return s.display(c.field).toLowerCase() === v.toLowerCase();
      if (v === '') return isEmpty(current);
      if (current === null) return false;
      return cmp(norm(col, x, tz), norm(col, v, tz, viaMacro)) === 0;
    }
    case '!=': {
      if (listMacro) return !listItems(v).some((p) => cmp(norm(col, x, tz), norm(col, p, tz)) === 0);
      if (isRef && v !== '' && !isSysId(v)) return s.display(c.field).toLowerCase() !== v.toLowerCase();
      if (v === '') return !isEmpty(current);
      return isEmpty(current) || cmp(norm(col, x, tz), norm(col, v, tz, viaMacro)) !== 0;
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (isEmpty(current) || (text && x === '')) return false;
      return compare(c.op, cmp(norm(col, x, tz), norm(col, v, tz, viaMacro)));
    }
    case 'LIKE':
    case 'NOT LIKE':
    case 'NOTLIKE':
    case 'STARTSWITH':
    case 'ENDSWITH': {
      const targetRaw = isRef ? (isEmpty(current) ? '' : s.display(c.field)) : x;
      const negate = c.op === 'NOT LIKE' || c.op === 'NOTLIKE';
      // NULL never matches; "does not contain" never returns empty fields.
      if (current === null || (negate && targetRaw === '')) return false;
      const target = targetRaw.toLowerCase();
      const needle = v.toLowerCase();
      const hit =
        c.op === 'STARTSWITH'
          ? target.startsWith(needle)
          : c.op === 'ENDSWITH'
            ? target.endsWith(needle)
            : target.includes(needle);
      return negate ? !hit : hit;
    }
    case 'IN':
    case 'NOT IN':
    case 'NOTIN': {
      const list = listItems(v);
      const hit = current !== null && list.some((p) => cmp(norm(col, x, tz), norm(col, p, tz)) === 0);
      return c.op === 'IN' ? hit : !hit;
    }
    default:
      return null;
  }
}

/**
 * Evaluates an encoded query against a subject. An empty query matches everything.
 * Invalid terms are ignored; a block whose terms are all invalid is dropped (not TRUE),
 * exactly like the SQL compiler.
 */
export function matches(
  query: string | ParsedQuery | null | undefined,
  s: MatchSubject,
  env: MacroEnv,
): boolean {
  const parsed = typeof query === 'string' || query == null ? parseEncodedQuery(query) : query;
  if (parsed.blocks.length === 0) return true;
  let anyBlock = false;
  for (const block of parsed.blocks) {
    let present = false;
    let ok = true;
    for (const cluster of block) {
      const results = cluster.map((c) => matchCondition(c, s, env)).filter((r): r is boolean => r !== null);
      if (results.length === 0) continue; // all terms invalid: cluster ignored
      present = true;
      if (!results.some(Boolean)) ok = false;
    }
    if (!present) continue;
    anyBlock = true;
    if (ok) return true;
  }
  return !anyBlock;
}
