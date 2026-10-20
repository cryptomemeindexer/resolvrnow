/**
 * Encoded query parser.
 *
 * Grammar (as publicly documented for the platform's REST `sysparm_query`):
 *   query      := block ( '^NQ' block )*
 *   block      := term ( ('^' | '^OR') term )*
 *   term       := field operator value | 'ORDERBY' field | 'ORDERBYDESC' field | 'GROUPBY' field | 'EQ'
 * A literal caret inside a value is written as `^^`.
 * `a^b^ORc` means a AND (b OR c): an OR term attaches to the condition before it.
 */

export interface Condition {
  field: string;
  op: Operator;
  value: string;
  raw: string;
}

/** AND of OR-clusters. */
export type Block = Condition[][];

export interface OrderSpec {
  field: string;
  desc: boolean;
}

export interface ParsedQuery {
  blocks: Block[];
  orderBy: OrderSpec[];
  groupBy: string[];
  invalid: string[];
}

export const OPERATORS = [
  'GT_OR_EQUALS_FIELD',
  'LT_OR_EQUALS_FIELD',
  'GT_FIELD',
  'LT_FIELD',
  'NOT LIKE',
  'NOTLIKE',
  'NOT IN',
  'NOTIN',
  'ISNOTEMPTY',
  'ISEMPTY',
  'STARTSWITH',
  'ENDSWITH',
  'INSTANCEOF',
  'EMPTYSTRING',
  'ANYTHING',
  'BETWEEN',
  'NSAMEAS',
  'SAMEAS',
  'DATEPART',
  'RELATIVEGT',
  'RELATIVELT',
  'RELATIVEGE',
  'RELATIVELE',
  'RELATIVEEE',
  'MORETHAN',
  'LESSTHAN',
  'VALCHANGES',
  'CHANGESFROM',
  'CHANGESTO',
  'DYNAMIC',
  'NOTON',
  'LIKE',
  'IN',
  'ON',
  '!=',
  '>=',
  '<=',
  '=',
  '>',
  '<',
] as const;

export type Operator = (typeof OPERATORS)[number];

export const TEXT_QUERY_FIELD = '123TEXTQUERY321';

function splitTerms(q: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === '^') {
      if (q[i + 1] === '^') {
        cur += '^';
        i++;
        continue;
      }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const FIELD_RE = /^[a-z0-9_][a-z0-9_.]*/;

export function parseTerm(term: string): Condition | null {
  let field: string;
  let rest: string;
  if (term.startsWith(TEXT_QUERY_FIELD)) {
    field = TEXT_QUERY_FIELD;
    rest = term.slice(field.length);
  } else if (term.startsWith('GOTO')) {
    return parseTerm(term.slice(4));
  } else {
    const m = FIELD_RE.exec(term);
    if (!m) return null;
    field = m[0];
    rest = term.slice(field.length);
    // A field cannot end with a dot.
    if (field.endsWith('.')) return null;
  }
  for (const op of OPERATORS) {
    if (rest.startsWith(op)) {
      return { field, op, value: rest.slice(op.length), raw: term };
    }
  }
  return null;
}

export function parseEncodedQuery(query: string | null | undefined): ParsedQuery {
  const result: ParsedQuery = { blocks: [], orderBy: [], groupBy: [], invalid: [] };
  if (!query) return result;
  const q = query.trim();
  if (!q) return result;
  // Split into NQ blocks first, respecting ^^ escapes.
  const terms = splitTerms(q);
  let block: Block = [];
  for (let i = 0; i < terms.length; i++) {
    let t = terms[i];
    if (t === '') continue;
    if (t === 'EQ') continue;
    if (t.startsWith('NQ')) {
      if (block.length) result.blocks.push(block);
      block = [];
      t = t.slice(2);
      if (!t) continue;
    }
    if (t.startsWith('ORDERBYDESC')) {
      result.orderBy.push({ field: t.slice('ORDERBYDESC'.length), desc: true });
      continue;
    }
    if (t.startsWith('ORDERBY')) {
      result.orderBy.push({ field: t.slice('ORDERBY'.length), desc: false });
      continue;
    }
    if (t.startsWith('GROUPBY')) {
      result.groupBy.push(t.slice('GROUPBY'.length));
      continue;
    }
    let isOr = false;
    // Field names are lower-case, so a leading upper-case "OR" is the OR connector.
    if (/^OR[a-z0-9_]/.test(t) || t.startsWith(`OR${TEXT_QUERY_FIELD}`)) {
      isOr = true;
      t = t.slice(2);
    }
    const cond = parseTerm(t);
    if (!cond) {
      result.invalid.push(terms[i]);
      continue;
    }
    if (isOr && block.length) block[block.length - 1].push(cond);
    else block.push([cond]);
  }
  if (block.length) result.blocks.push(block);
  return result;
}

/** Serializes a parsed query back to encoded form (used by the UI condition builder round-trip). */
export function stringifyQuery(q: ParsedQuery): string {
  const esc = (v: string) => v.replace(/\^/g, '^^');
  const parts: string[] = [];
  q.blocks.forEach((block, bi) => {
    const terms: string[] = [];
    for (const cluster of block) {
      cluster.forEach((c, ci) => {
        const t = `${c.field}${c.op}${esc(c.value)}`;
        terms.push(ci === 0 ? t : `OR${t}`);
      });
    }
    const s = terms.join('^');
    parts.push(bi === 0 ? s : `NQ${s}`);
  });
  let out = parts.join('^');
  for (const o of q.orderBy) out += `${out ? '^' : ''}${o.desc ? 'ORDERBYDESC' : 'ORDERBY'}${o.field}`;
  for (const g of q.groupBy) out += `${out ? '^' : ''}GROUPBY${g}`;
  return out;
}
