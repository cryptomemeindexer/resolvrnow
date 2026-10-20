import { type OrderSpec, type ParsedQuery, parseEncodedQuery, stringifyQuery } from './query/parser.js';

/**
 * Accumulates query conditions (GlideRecord-style addQuery/addEncodedQuery) and
 * combines them with correct AND semantics even when a fragment contains ^NQ blocks.
 */
export class QueryBuilder {
  private fragments: ParsedQuery[] = [];
  orderBy: OrderSpec[] = [];
  limit: number | undefined;
  offset = 0;

  constructor(readonly table: string) {}

  addEncodedQuery(q: string | null | undefined): this {
    if (!q || !q.trim()) return this;
    const parsed = parseEncodedQuery(q);
    if (parsed.orderBy.length) this.orderBy.push(...parsed.orderBy);
    this.fragments.push({ ...parsed, orderBy: [] });
    return this;
  }

  /** addQuery(field, value) or addQuery(field, operator, value). */
  addQuery(field: string, opOrValue: string | number | boolean | null, value?: string | number | boolean | null): this {
    let op = '=';
    let v: unknown = opOrValue;
    if (value !== undefined) {
      op = String(opOrValue);
      v = value;
    }
    const sv = v === null || v === undefined ? '' : String(v);
    return this.addEncodedQuery(`${field}${op}${sv.replace(/\^/g, '^^')}`);
  }

  addActiveQuery(): this {
    return this.addEncodedQuery('active=true');
  }

  addNullQuery(field: string): this {
    return this.addEncodedQuery(`${field}ISEMPTY`);
  }

  addNotNullQuery(field: string): this {
    return this.addEncodedQuery(`${field}ISNOTEMPTY`);
  }

  orderByAsc(field: string): this {
    this.orderBy.push({ field, desc: false });
    return this;
  }

  orderByDesc(field: string): this {
    this.orderBy.push({ field, desc: true });
    return this;
  }

  setLimit(n: number): this {
    this.limit = n;
    return this;
  }

  /** Combined query: the cartesian AND of all fragments' NQ blocks. */
  parsed(): ParsedQuery {
    let blocks: ParsedQuery['blocks'] = [[]];
    const invalid: string[] = [];
    const groupBy: string[] = [];
    for (const f of this.fragments) {
      invalid.push(...f.invalid);
      groupBy.push(...f.groupBy);
      if (f.blocks.length === 0) continue;
      const next: ParsedQuery['blocks'] = [];
      for (const a of blocks) for (const b of f.blocks) next.push([...a, ...b]);
      blocks = next;
    }
    if (blocks.length === 1 && blocks[0].length === 0) blocks = [];
    return { blocks, orderBy: this.orderBy, groupBy, invalid };
  }

  encoded(): string {
    return stringifyQuery(this.parsed());
  }
}
