/**
 * Encoded query parser.
 *
 * Grammar (as publicly documented for the platform's REST `sysparm_query`):
 *   query      := block ( '^NQ' block )*
 *   block      := term ( ('^' | '^OR') term )*
 *   term       := field operator value | 'ORDERBY' field | 'ORDERBYDESC' field | 'GROUPBY' field | 'EQ'
 *               | 'RLQUERY' table '.' field ',' quantifier [',m2m' | ',' condition] ( '^' condition )* '^ENDRLQUERY'
 * A literal caret inside a value is written as `^^`.
 * `a^b^ORc` means a AND (b OR c): an OR term attaches to the condition before it.
 */

export interface Condition {
  field: string;
  op: Operator;
  value: string;
  raw: string;
  /** Present when `op` is `RLQUERY`: a related-list (sub-)query. */
  related?: RelatedQuery;
}

/** `RLQUERY<table>.<field>,<quantifier>[,m2m]^<conditions>^ENDRLQUERY`. */
export interface RelatedQuery {
  table: string;
  field: string;
  quantifier: Quantifier;
  m2m: boolean;
  /** Encoded query on the related table, in escaped form (literal carets doubled). */
  query: string;
}

export interface Quantifier {
  op: '>=' | '>' | '<=' | '<' | '=' | '!=';
  n: number;
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

/** Operator tokens recognised after a field name. Matching is longest-token-first. */
export const OPERATORS = [
  'IN_HIERARCHY_DYNAMIC',
  'IN_HIERARCHY',
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
  'EMPTYSTRING',
  'NOTEMPTY',
  'EMPTY',
  'STARTSWITH',
  'ENDSWITH',
  'INSTANCEOF',
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
  'DOESNOTHAVE',
  'EXCLUDING',
  'NOTON',
  'LIKE',
  'IN',
  'ON',
  '!=',
  '!*',
  '>=',
  '<=',
  '=',
  '>',
  '<',
  '*',
  '%',
] as const;

/** `RLQUERY` is the pseudo-operator of related-list conditions; it is never scanned after a field. */
export type Operator = (typeof OPERATORS)[number] | 'RLQUERY';

/** Alias tokens are normalised to their canonical operator when parsed. */
const ALIASES: Partial<Record<Operator, Operator>> = {
  '*': 'LIKE',
  '!*': 'NOT LIKE',
  '%': 'ENDSWITH',
  EMPTY: 'ISEMPTY',
  NOTEMPTY: 'ISNOTEMPTY',
};

const SCAN = [...OPERATORS].sort((a, b) => b.length - a.length);

export const TEXT_QUERY_FIELD = '123TEXTQUERY321';
export const TEXT_INDEX_GROUP_FIELD = '123TEXTINDEXGROUP321';

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

const escapeValue = (v: string) => v.replace(/\^/g, '^^');

const FIELD_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*/;

export function parseTerm(term: string): Condition | null {
  let field: string;
  let rest: string;
  if (term.startsWith(TEXT_QUERY_FIELD)) {
    field = TEXT_QUERY_FIELD;
    rest = term.slice(field.length);
  } else if (term.startsWith(TEXT_INDEX_GROUP_FIELD)) {
    field = TEXT_INDEX_GROUP_FIELD;
    rest = term.slice(field.length);
  } else if (term.startsWith('GOTO')) {
    return parseTerm(term.slice(4));
  } else {
    const m = FIELD_RE.exec(term);
    if (!m) return null;
    field = m[0];
    rest = term.slice(field.length);
  }
  for (const op of SCAN) {
    if (rest.startsWith(op)) {
      return { field, op: ALIASES[op] ?? op, value: rest.slice(op.length), raw: term };
    }
  }
  return null;
}

const QUANT_RE = /^(>=|<=|!=|>|<|=)?\s*(\d+)$/;

/** Parses `RLQUERY<table>.<field>,<quantifier>[,<rest>]`; returns the parts or null. */
function parseRlHead(
  head: string,
): { table: string; field: string; quantifier: Quantifier; rest: string } | null {
  const body = head.slice('RLQUERY'.length);
  const c1 = body.indexOf(',');
  if (c1 < 0) return null;
  const target = body.slice(0, c1).trim();
  const dot = target.indexOf('.');
  if (dot <= 0) return null;
  const table = target.slice(0, dot);
  const field = target.slice(dot + 1);
  if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(field)) return null;
  const after = body.slice(c1 + 1);
  const c2 = after.indexOf(',');
  const quant = (c2 < 0 ? after : after.slice(0, c2)).trim();
  const qm = QUANT_RE.exec(quant);
  if (!qm) return null;
  return {
    table,
    field,
    // A bare count means "at least", the condition builder's default.
    quantifier: { op: (qm[1] ?? '>=') as Quantifier['op'], n: Number(qm[2]) },
    rest: c2 < 0 ? '' : after.slice(c2 + 1),
  };
}

export function parseEncodedQuery(query: string | null | undefined): ParsedQuery {
  const result: ParsedQuery = { blocks: [], orderBy: [], groupBy: [], invalid: [] };
  if (!query) return result;
  const q = query.trim();
  if (!q) return result;
  // Split into terms first, respecting ^^ escapes.
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
      const f = t.slice('ORDERBYDESC'.length);
      if (f) result.orderBy.push({ field: f, desc: true });
      continue;
    }
    if (t.startsWith('ORDERBY')) {
      const f = t.slice('ORDERBY'.length);
      if (f) result.orderBy.push({ field: f, desc: false });
      continue;
    }
    if (t.startsWith('GROUPBY')) {
      const f = t.slice('GROUPBY'.length);
      if (f) result.groupBy.push(f);
      continue;
    }
    if (t === 'ENDRLQUERY') {
      result.invalid.push(t);
      continue;
    }
    if (t.startsWith('RLQUERY')) {
      // The related-list clause runs up to ENDRLQUERY (or the end of the string); every
      // term in between belongs to the subquery.
      const inner: string[] = [];
      let j = i + 1;
      while (j < terms.length && terms[j] !== 'ENDRLQUERY') inner.push(terms[j++]);
      const rawTerms = terms.slice(i, Math.min(j + 1, terms.length));
      i = j;
      const head = parseRlHead(t);
      const raw = rawTerms.map(escapeValue).join('^');
      if (!head) {
        result.invalid.push(raw);
        continue;
      }
      let m2m = false;
      let rest = head.rest;
      if (/^m2m(?:,|$)/i.test(rest)) {
        m2m = true;
        rest = rest.slice(4);
      }
      const parts = [rest, ...inner].filter((p) => p !== '').map(escapeValue);
      const cond: Condition = {
        field: '',
        op: 'RLQUERY',
        value: '',
        raw,
        related: {
          table: head.table,
          field: head.field,
          quantifier: head.quantifier,
          m2m,
          query: parts.join('^'),
        },
      };
      block.push([cond]);
      continue;
    }
    let isOr = false;
    // Field names are lower-case, so a leading upper-case "OR" is the OR connector.
    if (
      /^OR[a-z0-9_]/.test(t) ||
      t.startsWith(`OR${TEXT_QUERY_FIELD}`) ||
      t.startsWith(`OR${TEXT_INDEX_GROUP_FIELD}`)
    ) {
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

/** Encoded form of a single condition (without OR / NQ prefixes). */
export function stringifyCondition(c: Condition): string {
  if (c.op === 'RLQUERY' && c.related) {
    const r = c.related;
    const quant = `${r.quantifier.op}${r.quantifier.n}`;
    const head = `RLQUERY${r.table}.${r.field},${quant}${r.m2m ? ',m2m' : ''}`;
    return `${head}${r.query ? `^${r.query}` : ''}^ENDRLQUERY`;
  }
  return `${c.field}${c.op}${escapeValue(c.value)}`;
}

/** Serializes a parsed query back to encoded form (used by the UI condition builder round-trip). */
export function stringifyQuery(q: ParsedQuery): string {
  const parts: string[] = [];
  q.blocks.forEach((block, bi) => {
    const terms: string[] = [];
    for (const cluster of block) {
      cluster.forEach((c, ci) => {
        const t = stringifyCondition(c);
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
