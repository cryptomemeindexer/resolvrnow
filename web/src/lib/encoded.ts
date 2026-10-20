/**
 * Client-side model for the condition builder: a list of OR-groups ("new query" blocks),
 * each an AND list of conditions, where a condition can have OR alternatives.
 */

export interface Cond {
  field: string;
  op: string;
  value: string;
}

/** AND list of OR clusters. */
export type Block = Cond[][];

export interface ParsedQuery {
  blocks: Block[];
  orderBy: { field: string; desc: boolean }[];
}

const OPS = [
  'GT_OR_EQUALS_FIELD', 'LT_OR_EQUALS_FIELD', 'GT_FIELD', 'LT_FIELD', 'NOT LIKE', 'NOT IN', 'ISNOTEMPTY', 'ISEMPTY',
  'STARTSWITH', 'ENDSWITH', 'INSTANCEOF', 'EMPTYSTRING', 'ANYTHING', 'BETWEEN', 'NSAMEAS', 'SAMEAS', 'RELATIVEGT',
  'RELATIVELT', 'RELATIVEGE', 'RELATIVELE', 'VALCHANGES', 'CHANGESFROM', 'CHANGESTO', 'DYNAMIC', 'NOTON', 'LIKE',
  'IN', 'ON', '!=', '>=', '<=', '=', '>', '<',
];

function split(q: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < q.length; i++) {
    if (q[i] === '^') {
      if (q[i + 1] === '^') {
        cur += '^';
        i++;
        continue;
      }
      out.push(cur);
      cur = '';
    } else cur += q[i];
  }
  out.push(cur);
  return out;
}

function term(t: string): Cond | null {
  const m = /^[a-z0-9_][a-z0-9_.]*/.exec(t);
  if (!m) return null;
  const rest = t.slice(m[0].length);
  const op = OPS.find((o) => rest.startsWith(o));
  if (!op) return null;
  return { field: m[0], op, value: rest.slice(op.length) };
}

export function parseQuery(q: string | null | undefined): ParsedQuery {
  const out: ParsedQuery = { blocks: [], orderBy: [] };
  if (!q) return out;
  let block: Block = [];
  for (let t of split(q)) {
    if (!t || t === 'EQ') continue;
    if (t.startsWith('NQ')) {
      if (block.length) out.blocks.push(block);
      block = [];
      t = t.slice(2);
      if (!t) continue;
    }
    if (t.startsWith('ORDERBYDESC')) {
      out.orderBy.push({ field: t.slice(11), desc: true });
      continue;
    }
    if (t.startsWith('ORDERBY')) {
      out.orderBy.push({ field: t.slice(7), desc: false });
      continue;
    }
    let isOr = false;
    if (/^OR[a-z0-9_]/.test(t)) {
      isOr = true;
      t = t.slice(2);
    }
    const c = term(t);
    if (!c) continue;
    if (isOr && block.length) block[block.length - 1].push(c);
    else block.push([c]);
  }
  if (block.length) out.blocks.push(block);
  return out;
}

export function stringifyQuery(q: ParsedQuery): string {
  const esc = (v: string) => v.replace(/\^/g, '^^');
  const parts: string[] = [];
  q.blocks.forEach((b, i) => {
    const terms: string[] = [];
    for (const cluster of b) cluster.forEach((c, j) => terms.push(`${j ? 'OR' : ''}${c.field}${c.op}${esc(c.value)}`));
    const s = terms.join('^');
    if (s) parts.push(i === 0 ? s : `NQ${s}`);
  });
  for (const o of q.orderBy) parts.push(`${o.desc ? 'ORDERBYDESC' : 'ORDERBY'}${o.field}`);
  return parts.join('^');
}

export interface OperatorDef {
  op: string;
  label: string;
  /** Value input: none, single, list, two (between), field (another field). */
  input: 'none' | 'single' | 'list' | 'two' | 'field' | 'date';
}

const STRING_OPS: OperatorDef[] = [
  { op: 'STARTSWITH', label: 'starts with', input: 'single' },
  { op: 'ENDSWITH', label: 'ends with', input: 'single' },
  { op: 'LIKE', label: 'contains', input: 'single' },
  { op: 'NOT LIKE', label: 'does not contain', input: 'single' },
  { op: '=', label: 'is', input: 'single' },
  { op: '!=', label: 'is not', input: 'single' },
  { op: 'ISEMPTY', label: 'is empty', input: 'none' },
  { op: 'ISNOTEMPTY', label: 'is not empty', input: 'none' },
  { op: 'IN', label: 'is one of', input: 'list' },
  { op: 'ANYTHING', label: 'is anything', input: 'none' },
];
const CHOICE_OPS: OperatorDef[] = [
  { op: '=', label: 'is', input: 'single' },
  { op: '!=', label: 'is not', input: 'single' },
  { op: 'IN', label: 'is one of', input: 'list' },
  { op: 'NOT IN', label: 'is not one of', input: 'list' },
  { op: 'ISEMPTY', label: 'is empty', input: 'none' },
  { op: 'ISNOTEMPTY', label: 'is not empty', input: 'none' },
  { op: '<', label: 'less than', input: 'single' },
  { op: '>', label: 'greater than', input: 'single' },
];
const REF_OPS: OperatorDef[] = [
  { op: '=', label: 'is', input: 'single' },
  { op: '!=', label: 'is not', input: 'single' },
  { op: 'DYNAMIC', label: 'is (dynamic)', input: 'single' },
  { op: 'ISEMPTY', label: 'is empty', input: 'none' },
  { op: 'ISNOTEMPTY', label: 'is not empty', input: 'none' },
  { op: 'STARTSWITH', label: 'starts with', input: 'single' },
  { op: 'LIKE', label: 'contains', input: 'single' },
  { op: 'IN', label: 'is one of', input: 'list' },
];
const NUM_OPS: OperatorDef[] = [
  { op: '=', label: 'is', input: 'single' },
  { op: '!=', label: 'is not', input: 'single' },
  { op: '<', label: 'less than', input: 'single' },
  { op: '>', label: 'greater than', input: 'single' },
  { op: '<=', label: 'less than or is', input: 'single' },
  { op: '>=', label: 'greater than or is', input: 'single' },
  { op: 'BETWEEN', label: 'between', input: 'two' },
  { op: 'ISEMPTY', label: 'is empty', input: 'none' },
  { op: 'ISNOTEMPTY', label: 'is not empty', input: 'none' },
];
const DATE_OPS: OperatorDef[] = [
  { op: 'ON', label: 'on', input: 'date' },
  { op: 'NOTON', label: 'not on', input: 'date' },
  { op: '<', label: 'before', input: 'single' },
  { op: '>', label: 'after', input: 'single' },
  { op: 'BETWEEN', label: 'between', input: 'two' },
  { op: 'RELATIVEGT', label: 'relative after', input: 'single' },
  { op: 'RELATIVELT', label: 'relative before', input: 'single' },
  { op: 'ISEMPTY', label: 'is empty', input: 'none' },
  { op: 'ISNOTEMPTY', label: 'is not empty', input: 'none' },
];
const BOOL_OPS: OperatorDef[] = [
  { op: '=', label: 'is', input: 'single' },
  { op: '!=', label: 'is not', input: 'single' },
  { op: 'ISEMPTY', label: 'is empty', input: 'none' },
];

export function operatorsFor(type: string, hasChoices: boolean): OperatorDef[] {
  if (type === 'boolean') return BOOL_OPS;
  if (hasChoices) return CHOICE_OPS;
  if (type === 'reference' || type === 'document_id') return REF_OPS;
  if (['glide_date_time', 'glide_date', 'due_date'].includes(type)) return DATE_OPS;
  if (['integer', 'decimal', 'float', 'currency', 'price', 'percent_complete', 'glide_duration'].includes(type)) return NUM_OPS;
  return STRING_OPS;
}

export const DATE_PRESETS: { label: string; value: string }[] = [
  { label: 'Today', value: 'Today@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()' },
  { label: 'Yesterday', value: 'Yesterday@javascript:gs.beginningOfYesterday()@javascript:gs.endOfYesterday()' },
  { label: 'This week', value: 'This week@javascript:gs.beginningOfThisWeek()@javascript:gs.endOfThisWeek()' },
  { label: 'Last week', value: 'Last week@javascript:gs.beginningOfLastWeek()@javascript:gs.endOfLastWeek()' },
  { label: 'Last 7 days', value: 'Last 7 days@javascript:gs.daysAgoStart(7)@javascript:gs.endOfToday()' },
  { label: 'This month', value: 'This month@javascript:gs.beginningOfThisMonth()@javascript:gs.endOfThisMonth()' },
  { label: 'Last month', value: 'Last month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()' },
  { label: 'Last 30 days', value: 'Last 30 days@javascript:gs.daysAgoStart(30)@javascript:gs.endOfToday()' },
  { label: 'This year', value: 'This year@javascript:gs.beginningOfThisYear()@javascript:gs.endOfThisYear()' },
];

export const DYNAMIC_ME = '90d1921e5f510100a9ad2572f2b477fe';
export const DYNAMIC_MY_GROUPS = 'd6435e965f510100a9ad2572f2b47744';

/** Evaluates a (simple) encoded query against form values; used for UI policies in the browser. */
export function evaluate(query: string, values: Record<string, { value: string; display_value?: string } | undefined>): boolean {
  const parsed = parseQuery(query);
  if (!parsed.blocks.length) return true;
  const test = (c: Cond): boolean => {
    const v = values[c.field]?.value ?? '';
    const d = values[c.field]?.display_value ?? v;
    const num = (x: string) => (x === '' || Number.isNaN(Number(x)) ? null : Number(x));
    switch (c.op) {
      case '=':
        return v === c.value || (!!d && d.toLowerCase() === c.value.toLowerCase());
      case '!=':
        return v !== c.value;
      case 'IN':
        return c.value.split(',').includes(v);
      case 'NOT IN':
        return !c.value.split(',').includes(v);
      case 'ISEMPTY':
        return v === '';
      case 'ISNOTEMPTY':
        return v !== '';
      case 'LIKE':
        return d.toLowerCase().includes(c.value.toLowerCase());
      case 'NOT LIKE':
        return !d.toLowerCase().includes(c.value.toLowerCase());
      case 'STARTSWITH':
        return d.toLowerCase().startsWith(c.value.toLowerCase());
      case 'ENDSWITH':
        return d.toLowerCase().endsWith(c.value.toLowerCase());
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const a = num(v);
        const b = num(c.value);
        if (a === null || b === null) return false;
        return c.op === '<' ? a < b : c.op === '>' ? a > b : c.op === '<=' ? a <= b : a >= b;
      }
      case 'ANYTHING':
        return true;
      default:
        return true;
    }
  };
  return parsed.blocks.some((block) => block.every((cluster) => cluster.some(test)));
}
