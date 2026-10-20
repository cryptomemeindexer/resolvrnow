import { describe, expect, it } from 'vitest';
import { parseEncodedQuery, stringifyQuery } from '../src/engine/query/parser.js';
import { QueryBuilder } from '../src/engine/querybuilder.js';

describe('encoded query parser', () => {
  it('parses AND, OR and NQ structure', () => {
    const q = parseEncodedQuery('active=true^priority=1^ORpriority=2^NQstate=6');
    expect(q.blocks).toHaveLength(2);
    expect(q.blocks[0]).toHaveLength(2);
    expect(q.blocks[0][1].map((c) => c.value)).toEqual(['1', '2']);
    expect(q.blocks[1][0][0]).toMatchObject({ field: 'state', op: '=', value: '6' });
  });

  it('recognises multi-word and longest operators', () => {
    const q = parseEncodedQuery('short_descriptionNOT LIKEprinter^sys_idNOT IN1,2^nameSTARTSWITHab^categoryISNOTEMPTY');
    expect(q.blocks[0].map((c) => c[0].op)).toEqual(['NOT LIKE', 'NOT IN', 'STARTSWITH', 'ISNOTEMPTY']);
  });

  it('handles ordering, grouping and EQ', () => {
    const q = parseEncodedQuery('active=true^EQ^ORDERBYDESCsys_created_on^ORDERBYnumber^GROUPBYstate');
    expect(q.orderBy).toEqual([
      { field: 'sys_created_on', desc: true },
      { field: 'number', desc: false },
    ]);
    expect(q.groupBy).toEqual(['state']);
  });

  it('unescapes ^^ inside values and round-trips', () => {
    const q = parseEncodedQuery('short_descriptionLIKEa^^b^active=true');
    expect(q.blocks[0][0][0].value).toBe('a^b');
    expect(stringifyQuery(q)).toBe('short_descriptionLIKEa^^b^active=true');
  });

  it('supports dot-walked fields', () => {
    const q = parseEncodedQuery('caller_id.department.name=IT');
    expect(q.blocks[0][0][0].field).toBe('caller_id.department.name');
  });

  it('collects invalid terms', () => {
    const q = parseEncodedQuery('Garbage^active=true');
    expect(q.invalid).toEqual(['Garbage']);
    expect(q.blocks[0]).toHaveLength(1);
  });

  it('QueryBuilder ANDs NQ fragments distributively', () => {
    const qb = new QueryBuilder('incident').addEncodedQuery('priority=1^NQpriority=2').addQuery('active', true);
    const parsed = qb.parsed();
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks.every((b) => b.some((c) => c[0].field === 'active'))).toBe(true);
  });
});
