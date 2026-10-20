import type { SchemaRegistry } from '../registry.js';
import type { ColumnMeta, FieldType, TableMeta } from '../types.js';
import {
  type Block,
  type Condition,
  type ParsedQuery,
  parseEncodedQuery,
  stringifyQuery,
  TEXT_INDEX_GROUP_FIELD,
  TEXT_QUERY_FIELD,
} from './parser.js';

/**
 * Validation of client-supplied encoded queries (REST APIs). It applies the operator
 * applicability rules of the encoded-query spec (section 4) and drops terms on fields
 * the caller cannot read, so hidden values cannot be probed through filters. Dropped
 * terms are reported as invalid, which is how the platform treats them.
 *
 * The SQL compiler itself stays lenient so internal engine queries keep working.
 */

const BASIC = ['=', '!=', 'ISEMPTY', 'ISNOTEMPTY', 'ANYTHING'];
const ORDER = ['>', '<', '>=', '<=', 'BETWEEN'];
const CONTAINS = ['LIKE', 'NOT LIKE', 'NOTLIKE'];
const TEXT = [...CONTAINS, 'STARTSWITH', 'ENDSWITH'];
const SET = ['IN', 'NOT IN', 'NOTIN'];
const SAME = ['SAMEAS', 'NSAMEAS'];
const NUM_FIELD = ['GT_FIELD', 'LT_FIELD', 'GT_OR_EQUALS_FIELD', 'LT_OR_EQUALS_FIELD'];
const DATE = [
  'MORETHAN',
  'LESSTHAN',
  'ON',
  'NOTON',
  'RELATIVEGT',
  'RELATIVELT',
  'RELATIVEGE',
  'RELATIVELE',
  'RELATIVEEE',
  'DATEPART',
];
const REF = ['DYNAMIC', 'IN_HIERARCHY', 'IN_HIERARCHY_DYNAMIC'];
const CHANGES = ['VALCHANGES', 'CHANGESFROM', 'CHANGESTO'];

const STRING_OPS = new Set([...BASIC, ...ORDER, ...TEXT, ...SET, 'EMPTYSTRING', ...SAME, ...CHANGES]);
const CHOICE_OPS = new Set([...BASIC, ...TEXT, ...SET, ...SAME, 'INSTANCEOF', ...CHANGES]);
const NUMERIC_OPS = new Set([...BASIC, ...ORDER, ...SET, ...SAME, ...NUM_FIELD, ...CHANGES]);
const BOOLEAN_OPS = new Set([...BASIC, ...SAME, ...CHANGES]);
const REFERENCE_OPS = new Set([...BASIC, ...TEXT, ...SET, 'EMPTYSTRING', ...SAME, ...REF, ...CHANGES]);
const DATE_OPS = new Set([...BASIC, ...ORDER, ...SAME, ...DATE, ...CHANGES]);
const LIST_OPS = new Set([...BASIC, ...CONTAINS, ...CHANGES]);
const JOURNAL_OPS = new Set([...BASIC, ...CONTAINS, ...CHANGES]);
const GUID_OPS = new Set([...BASIC, 'STARTSWITH', ...SET, ...CHANGES]);
const OPAQUE_OPS = new Set(['ISEMPTY', 'ISNOTEMPTY', 'ANYTHING']);

const FAMILY: Partial<Record<FieldType, Set<string>>> = {
  string: STRING_OPS,
  translated_text: STRING_OPS,
  multi_two_lines: STRING_OPS,
  email: STRING_OPS,
  url: STRING_OPS,
  phone_number: STRING_OPS,
  ip_address: STRING_OPS,
  field_name: STRING_OPS,
  table_name: STRING_OPS,
  field_list: STRING_OPS,
  conditions: STRING_OPS,
  user_roles: STRING_OPS,
  name_values: STRING_OPS,
  json: STRING_OPS,
  html: STRING_OPS,
  script: STRING_OPS,
  choice: CHOICE_OPS,
  sys_class_name: CHOICE_OPS,
  integer: NUMERIC_OPS,
  decimal: NUMERIC_OPS,
  float: NUMERIC_OPS,
  currency: NUMERIC_OPS,
  price: NUMERIC_OPS,
  percent_complete: NUMERIC_OPS,
  glide_duration: NUMERIC_OPS,
  boolean: BOOLEAN_OPS,
  reference: REFERENCE_OPS,
  document_id: REFERENCE_OPS,
  domain_id: REFERENCE_OPS,
  glide_date_time: DATE_OPS,
  glide_date: DATE_OPS,
  due_date: DATE_OPS,
  glide_time: DATE_OPS,
  glide_list: LIST_OPS,
  journal: JOURNAL_OPS,
  journal_input: JOURNAL_OPS,
  journal_list: JOURNAL_OPS,
  GUID: GUID_OPS,
  password2: OPAQUE_OPS,
  image: OPAQUE_OPS,
  variables: OPAQUE_OPS,
  days_of_week: OPAQUE_OPS,
};

/** True when `op` may be used on a column of this type (section 4 of the encoded-query spec). */
export function operatorApplies(op: string, col: ColumnMeta): boolean {
  const family = FAMILY[col.type];
  return family ? family.has(op) : true;
}

export interface QueryCheckOptions {
  /** Field-level read check. Terms and sort keys on unreadable fields are dropped. */
  canRead?: (table: string, field: string) => boolean;
}

export interface CheckedQuery {
  /** The query without the dropped terms (its `invalid` keeps the parser's invalid terms). */
  query: ParsedQuery;
  /** Terms dropped by the checks (not including the parser's own invalid terms). */
  dropped: string[];
}

interface PathInfo {
  col: ColumnMeta;
  ok: boolean;
}

/** Resolves a dot-walked path against the schema and checks read access on every hop. */
function resolvePath(
  registry: SchemaRegistry,
  table: TableMeta,
  path: string,
  opts: QueryCheckOptions,
): PathInfo | null {
  const parts = path.split('.');
  let t = table;
  for (let i = 0; i < parts.length; i++) {
    const col = t.columns.get(parts[i]);
    if (!col) return null;
    if (opts.canRead && !opts.canRead(t.name, col.name)) return { col, ok: false };
    if (i === parts.length - 1) return { col, ok: true };
    if (col.type !== 'reference' || !col.reference) return null;
    const next = registry.tryTable(col.reference);
    if (!next) return null;
    t = next;
  }
  return null;
}

function checkCondition(
  registry: SchemaRegistry,
  table: TableMeta,
  c: Condition,
  opts: QueryCheckOptions,
  dropped: string[],
): Condition | null {
  if (c.op === 'RLQUERY') {
    const rq = c.related;
    const rel = rq ? registry.tryTable(rq.table) : undefined;
    if (!rq || !rel) {
      dropped.push(c.raw);
      return null;
    }
    const link = resolvePath(registry, rel, rq.field, opts);
    if (!link?.ok) {
      dropped.push(c.raw);
      return null;
    }
    const inner = checkQuery(registry, rel.name, rq.query, opts);
    dropped.push(...inner.dropped);
    const q = stringifyQuery({ ...inner.query, orderBy: [], groupBy: [] });
    return { ...c, related: { ...rq, query: q } };
  }
  if (c.field === TEXT_QUERY_FIELD || c.field === TEXT_INDEX_GROUP_FIELD) return c;
  const info = resolvePath(registry, table, c.field, opts);
  if (!info || !info.ok || !operatorApplies(c.op, info.col)) {
    dropped.push(c.raw);
    return null;
  }
  // Field-to-field operators also read the other field.
  if ([...SAME, ...NUM_FIELD, 'MORETHAN', 'LESSTHAN'].includes(c.op)) {
    const other = c.value.split('@')[0].trim();
    const o = resolvePath(registry, table, other, opts);
    if (!o?.ok) {
      dropped.push(c.raw);
      return null;
    }
  }
  return c;
}

/** Applies operator applicability and field read checks to a query on `tableName`. */
export function checkQuery(
  registry: SchemaRegistry,
  tableName: string,
  query: string | ParsedQuery | null | undefined,
  opts: QueryCheckOptions = {},
): CheckedQuery {
  const parsed = typeof query === 'string' || query == null ? parseEncodedQuery(query) : query;
  const table = registry.tryTable(tableName);
  if (!table) return { query: parsed, dropped: [] };
  const dropped: string[] = [];
  const blocks: Block[] = [];
  for (const block of parsed.blocks) {
    const clusters: Condition[][] = [];
    for (const cluster of block) {
      const kept = cluster
        .map((c) => checkCondition(registry, table, c, opts, dropped))
        .filter((c): c is Condition => c !== null);
      if (kept.length) clusters.push(kept);
    }
    if (clusters.length) blocks.push(clusters);
  }
  const orderBy = parsed.orderBy.filter((o) => {
    const info = resolvePath(registry, table, o.field, opts);
    if (!info) return true; // unknown sort fields are ignored by the compiler
    return info.ok && info.col.type !== 'password2';
  });
  return { query: { blocks, orderBy, groupBy: parsed.groupBy, invalid: parsed.invalid }, dropped };
}
