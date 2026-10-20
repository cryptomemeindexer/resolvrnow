import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '../src/engine/context.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import { QueryCompiler } from '../src/engine/query/compiler.js';
import {
  endOf,
  fromLocal,
  glide,
  isoWeek,
  localGlide,
  startOf,
  toLocal,
  zoneSegments,
} from '../src/engine/query/datetime.js';
import {
  DYNAMIC_FILTERS,
  evalMacro,
  labelBounds,
  type MacroEnv,
  onBounds,
  relativeBounds,
  relativeInstant,
  resolveDynamic,
} from '../src/engine/query/macros.js';
import { type MatchSubject, matchCondition, matches } from '../src/engine/query/matcher.js';
import { parseEncodedQuery, stringifyQuery } from '../src/engine/query/parser.js';
import { checkQuery, operatorApplies } from '../src/engine/query/validate.js';
import { QueryBuilder } from '../src/engine/querybuilder.js';
import type { Rec } from '../src/engine/record.js';
import { recSubject } from '../src/engine/rules.js';
import { clock } from '../src/engine/util.js';
import { bootPlatform, makeUser } from './helpers.js';

describe('encoded query parser', () => {
  it('parses AND, OR and NQ structure', () => {
    const q = parseEncodedQuery('active=true^priority=1^ORpriority=2^NQstate=6');
    expect(q.blocks).toHaveLength(2);
    expect(q.blocks[0]).toHaveLength(2);
    expect(q.blocks[0][1].map((c) => c.value)).toEqual(['1', '2']);
    expect(q.blocks[1][0][0]).toMatchObject({ field: 'state', op: '=', value: '6' });
  });

  it('recognises multi-word and longest operators', () => {
    const q = parseEncodedQuery(
      'short_descriptionNOT LIKEprinter^sys_idNOT IN1,2^nameSTARTSWITHab^categoryISNOTEMPTY',
    );
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
    const qb = new QueryBuilder('incident')
      .addEncodedQuery('priority=1^NQpriority=2')
      .addQuery('active', true);
    const parsed = qb.parsed();
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks.every((b) => b.some((c) => c[0].field === 'active'))).toBe(true);
  });

  it('does not misparse IN_HIERARCHY as IN', () => {
    const q = parseEncodedQuery(
      'managerIN_HIERARCHYabc@def^managerIN_HIERARCHY_DYNAMICabc@me^priorityIN1,2^sys_class_nameINSTANCEOFtask',
    );
    expect(q.blocks[0].map((c) => c[0].op)).toEqual([
      'IN_HIERARCHY',
      'IN_HIERARCHY_DYNAMIC',
      'IN',
      'INSTANCEOF',
    ]);
    expect(q.blocks[0][0][0].value).toBe('abc@def');
  });

  it('normalises operator aliases and keeps longest matches', () => {
    const q = parseEncodedQuery('a*x^b!*y^c%z^dEMPTY^eNOTEMPTY^fEMPTYSTRING^gISEMPTY^h!=1');
    expect(q.blocks[0].map((c) => c[0].op)).toEqual([
      'LIKE',
      'NOT LIKE',
      'ENDSWITH',
      'ISEMPTY',
      'ISNOTEMPTY',
      'EMPTYSTRING',
      'ISEMPTY',
      '!=',
    ]);
  });

  it('recognises every documented operator token', () => {
    const ops = [
      ['=', 'a=1'],
      ['!=', 'a!=1'],
      ['>', 'a>1'],
      ['<', 'a<1'],
      ['>=', 'a>=1'],
      ['<=', 'a<=1'],
      ['BETWEEN', 'aBETWEEN1@2'],
      ['LIKE', 'aLIKEx'],
      ['NOT LIKE', 'aNOT LIKEx'],
      ['STARTSWITH', 'aSTARTSWITHx'],
      ['ENDSWITH', 'aENDSWITHx'],
      ['IN', 'aIN1,2'],
      ['NOT IN', 'aNOT IN1,2'],
      ['ISEMPTY', 'aISEMPTY'],
      ['ISNOTEMPTY', 'aISNOTEMPTY'],
      ['EMPTYSTRING', 'aEMPTYSTRING'],
      ['ANYTHING', 'aANYTHING'],
      ['SAMEAS', 'aSAMEASb'],
      ['NSAMEAS', 'aNSAMEASb@day'],
      ['GT_FIELD', 'aGT_FIELDb'],
      ['LT_FIELD', 'aLT_FIELDb'],
      ['GT_OR_EQUALS_FIELD', 'aGT_OR_EQUALS_FIELDb'],
      ['LT_OR_EQUALS_FIELD', 'aLT_OR_EQUALS_FIELDb'],
      ['MORETHAN', 'aMORETHANb@day@before@1'],
      ['LESSTHAN', 'aLESSTHANb@day@after@1'],
      ['ON', 'aONToday@x@y'],
      ['NOTON', 'aNOTONToday@x@y'],
      ['RELATIVEGT', 'aRELATIVEGT@hour@ago@1'],
      ['RELATIVELT', 'aRELATIVELT@hour@ago@1'],
      ['RELATIVEGE', 'aRELATIVEGE@hour@ago@1'],
      ['RELATIVELE', 'aRELATIVELE@hour@ago@1'],
      ['RELATIVEEE', 'aRELATIVEEE@hour@ago@1'],
      ['DATEPART', "aDATEPARTMonday@javascript:gs.datePart('dayofweek','monday','EE')"],
      ['DYNAMIC', 'aDYNAMIC90d1921e5f510100a9ad2572f2b477fe'],
      ['IN_HIERARCHY', 'aIN_HIERARCHYx@y'],
      ['IN_HIERARCHY_DYNAMIC', 'aIN_HIERARCHY_DYNAMICx@y'],
      ['INSTANCEOF', 'aINSTANCEOFtask'],
      ['VALCHANGES', 'aVALCHANGES'],
      ['CHANGESFROM', 'aCHANGESFROM1'],
      ['CHANGESTO', 'aCHANGESTO1'],
      ['DOESNOTHAVE', 'sys_tagsDOESNOTHAVEx'],
      ['EXCLUDING', 'sys_tagsEXCLUDINGx'],
    ];
    for (const [op, term] of ops) expect(parseEncodedQuery(term).blocks[0][0][0].op, term).toBe(op);
  });

  it('parses text index groups and keyword search', () => {
    const q = parseEncodedQuery('123TEXTQUERY321=email outage^123TEXTINDEXGROUP321=itsm');
    expect(q.blocks[0].map((c) => c[0].field)).toEqual(['123TEXTQUERY321', '123TEXTINDEXGROUP321']);
  });

  it('parses RLQUERY with conditions after ^ and in the documented comma form', () => {
    const a = parseEncodedQuery(
      'active=true^RLQUERYincident.problem_id,>=1^priority=1^ORpriority=2^ENDRLQUERY',
    );
    const rl = a.blocks[0][1][0];
    expect(rl.op).toBe('RLQUERY');
    expect(rl.related).toEqual({
      table: 'incident',
      field: 'problem_id',
      quantifier: { op: '>=', n: 1 },
      m2m: false,
      query: 'priority=1^ORpriority=2',
    });
    const b = parseEncodedQuery('RLQUERYincident.problem_id,>=1,priority=1^ENDRLQUERY');
    expect(b.blocks[0][0][0].related?.query).toBe('priority=1');
    const c = parseEncodedQuery(
      'RLQUERYsys_user_grmember.user,=0,m2m^group.name=Net^^work^ENDRLQUERY^active=true',
    );
    expect(c.blocks[0][0][0].related).toMatchObject({
      m2m: true,
      quantifier: { op: '=', n: 0 },
      query: 'group.name=Net^^work',
    });
    expect(c.blocks[0][1][0].field).toBe('active');
  });

  it('round-trips RLQUERY through stringify and the QueryBuilder', () => {
    const src = 'active=true^RLQUERYincident.problem_id,>=2^priority=1^ENDRLQUERY';
    expect(stringifyQuery(parseEncodedQuery(src))).toBe(src);
    const qb = new QueryBuilder('problem').addEncodedQuery(src).addQuery('state', '1');
    expect(stringifyQuery(qb.parsed())).toBe(`${src}^state=1`);
    // A missing ENDRLQUERY extends the subquery to the end; a stray one is invalid.
    expect(
      parseEncodedQuery('RLQUERYincident.problem_id,>=1^priority=1').blocks[0][0][0].related?.query,
    ).toBe('priority=1');
    expect(parseEncodedQuery('active=true^ENDRLQUERY').invalid).toEqual(['ENDRLQUERY']);
    expect(parseEncodedQuery('RLQUERYincident,>=1^ENDRLQUERY').invalid).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- macros

describe('date and user macros', () => {
  const ny: MacroEnv = {
    userId: 'u1',
    userName: 'abel',
    timeZone: 'America/New_York',
    myGroups: () => ['g1', 'g2'],
    managerId: () => 'm1',
  };
  const utc: MacroEnv = { userId: 'u1', userName: 'abel' };
  beforeAll(() => clock.freeze('2026-10-21 15:00:00'));
  afterAll(() => clock.reset());

  it('computes day bounds in the user time zone (spec test vector 7)', () => {
    expect(evalMacro('javascript:gs.beginningOfToday()', ny)).toBe('2026-10-21 04:00:00');
    expect(evalMacro('javascript:gs.endOfToday()', ny)).toBe('2026-10-22 03:59:59');
    expect(evalMacro('javascript:gs.beginningOfToday()', utc)).toBe('2026-10-21 00:00:00');
    expect(evalMacro('javascript:gs.daysAgoStart(0)', ny)).toBe('2026-10-21 04:00:00');
    expect(evalMacro('javascript:gs.daysAgoEnd(1)', ny)).toBe('2026-10-21 03:59:59');
    expect(evalMacro('javascript:gs.beginningOfYesterday()', ny)).toBe('2026-10-20 04:00:00');
    expect(evalMacro('javascript:gs.endOfTomorrow()', ny)).toBe('2026-10-23 03:59:59');
  });

  it('computes week, month, quarter and year bounds across daylight saving changes', () => {
    expect(evalMacro('javascript:gs.beginningOfThisWeek()', ny)).toBe('2026-10-19 04:00:00');
    expect(evalMacro('javascript:gs.endOfThisWeek()', ny)).toBe('2026-10-26 03:59:59');
    expect(evalMacro('javascript:gs.beginningOfThisMonth()', ny)).toBe('2026-10-01 04:00:00');
    expect(evalMacro('javascript:gs.endOfThisMonth()', ny)).toBe('2026-11-01 03:59:59');
    expect(evalMacro('javascript:gs.endOfNextMonth()', ny)).toBe('2026-12-01 04:59:59');
    expect(evalMacro('javascript:gs.beginningOfThisQuarter()', ny)).toBe('2026-10-01 04:00:00');
    expect(evalMacro('javascript:gs.endOfThisQuarter()', ny)).toBe('2027-01-01 04:59:59');
    expect(evalMacro('javascript:gs.beginningOfNextQuarter()', ny)).toBe('2027-01-01 05:00:00');
    expect(evalMacro('javascript:gs.beginningOfLastQuarter()', utc)).toBe('2026-07-01 00:00:00');
    expect(evalMacro('javascript:gs.beginningOfThisYear()', ny)).toBe('2026-01-01 05:00:00');
    expect(evalMacro('javascript:gs.endOfLastYear()', utc)).toBe('2025-12-31 23:59:59');
    expect(evalMacro('javascript:gs.beginningOfLast2Years()', utc)).toBe('2024-01-01 00:00:00');
    expect(evalMacro('javascript:gs.beginningOfOneYearAgo()', utc)).toBe('2025-10-21 00:00:00');
  });

  it('supports rolling windows and relative points', () => {
    expect(evalMacro('javascript:gs.beginningOfLast15Minutes()', utc)).toBe('2026-10-21 14:45:00');
    expect(evalMacro('javascript:gs.endOfLast15Minutes()', utc)).toBe('2026-10-21 15:00:59');
    expect(evalMacro('javascript:gs.beginningOfCurrentHour()', utc)).toBe('2026-10-21 15:00:00');
    expect(evalMacro('javascript:gs.endOfLastHour()', utc)).toBe('2026-10-21 14:59:59');
    expect(evalMacro('javascript:gs.beginningOfLastMinute()', utc)).toBe('2026-10-21 14:59:00');
    expect(evalMacro('javascript:gs.beginningOfLast7Days()', ny)).toBe('2026-10-14 04:00:00');
    expect(evalMacro('javascript:gs.endOfLast7Days()', ny)).toBe('2026-10-22 03:59:59');
    expect(evalMacro('javascript:gs.beginningOfLast3Months()', utc)).toBe('2026-07-01 00:00:00');
    expect(evalMacro('javascript:gs.beginningOfLast2Quarters()', utc)).toBe('2026-04-01 00:00:00');
    expect(evalMacro('javascript:gs.hoursAgoStart(2)', utc)).toBe('2026-10-21 13:00:00');
    expect(evalMacro('javascript:gs.minutesAgo(30)', utc)).toBe('2026-10-21 14:30:00');
    expect(evalMacro('javascript:gs.monthsAgoStart(1)', ny)).toBe('2026-09-01 04:00:00');
    expect(evalMacro('javascript:gs.quartersAgoEnd(1)', utc)).toBe('2026-09-30 23:59:59');
    expect(evalMacro('javascript:gs.yearsAgo(1)', utc)).toBe('2025-10-21 15:00:00');
    expect(evalMacro('javascript:gs.daysAgoLocal(0)', ny)).toBe('2026-10-21 11:00:00');
    expect(evalMacro('javascript:gs.beginningOfDay("2026-03-08 12:00:00")', ny)).toBe('2026-03-08 05:00:00');
  });

  it('uses calendar arithmetic with end-of-month clamping', () => {
    clock.freeze('2026-03-31 12:00:00');
    try {
      expect(evalMacro('javascript:gs.monthsAgo(1)', utc)).toBe('2026-02-28 12:00:00');
      expect(relativeInstant('@month@ago@1', utc)).toBe('2026-02-28 12:00:00');
      expect(relativeInstant('@quarter@ahead@1', utc)).toBe('2026-06-30 12:00:00');
    } finally {
      clock.freeze('2026-10-21 15:00:00');
    }
  });

  it('evaluates construction, duration and user functions', () => {
    expect(evalMacro("javascript:gs.dateGenerate('2026-01-01','00:00:00')", ny)).toBe('2026-01-01 05:00:00');
    expect(evalMacro("javascript:gs.dateGenerate('2026-01-31','end')", utc)).toBe('2026-01-31 23:59:59');
    expect(evalMacro("javascript:gs.getDurationDate('1 02:03:04')", utc)).toBe('1970-01-02 02:03:04');
    expect(evalMacro('javascript:gs.now()', { ...utc, timeZone: 'Asia/Tokyo' })).toBe('2026-10-22');
    expect(evalMacro('javascript:gs.nowDateTime()', ny)).toBe('2026-10-21 15:00:00');
    expect(evalMacro('javascript:gs.getUser().getMyGroups()', ny)).toBe('g1,g2');
    expect(evalMacro('javascript:gs.getUser().getManagerID();', ny)).toBe('m1');
    expect(evalMacro("javascript:'INC' + gs.getUserID()", ny)).toBe('INCu1');
    expect(evalMacro("javascript:new GlideRecord('incident')", ny)).toBeNull();
    expect(evalMacro('javascript:gs.eval(1)', ny)).toBeNull();
  });

  it('resolves RELATIVE specs including dayofweek (spec vectors 8 and 9)', () => {
    expect(relativeInstant('@hour@ago@1', ny)).toBe('2026-10-21 14:00:00');
    expect(relativeInstant('@dayofweek@ago@14', ny)).toBe('2026-10-07 15:00:00');
    expect(relativeInstant('@minute@ahead@5', utc)).toBe('2026-10-21 15:05:00');
    expect(relativeInstant('@week@ago@1', utc)).toBe('2026-10-14 15:00:00');
    expect(relativeInstant('@year@ago@1', utc)).toBe('2025-10-21 15:00:00');
    expect(relativeInstant('@fortnight@ago@1', utc)).toBeNull();
    expect(relativeInstant('@day@sideways@1', utc)).toBeNull();
    expect(relativeBounds('@day@ago@2', ny)).toEqual(['2026-10-19 04:00:00', '2026-10-20 03:59:59']);
  });

  it('maps date-picker labels and bare dates for ON', () => {
    expect(labelBounds('Last 7 days', ny)).toEqual(['2026-10-14 04:00:00', '2026-10-22 03:59:59']);
    expect(labelBounds('This quarter', utc)).toEqual(['2026-10-01 00:00:00', '2026-12-31 23:59:59']);
    expect(labelBounds('Current hour', utc)).toEqual(['2026-10-21 15:00:00', '2026-10-21 15:59:59']);
    expect(labelBounds('Someday', utc)).toBeNull();
    expect(onBounds('Today', ny)).toEqual(['2026-10-21 04:00:00', '2026-10-22 03:59:59']);
    expect(onBounds('2026-10-21', ny)).toEqual(['2026-10-21 04:00:00', '2026-10-22 03:59:59']);
    expect(
      onBounds(
        'Custom@javascript:gs.dateGenerate("2026-01-01","start")@javascript:gs.dateGenerate("2026-01-02","end")',
        utc,
      ),
    ).toEqual(['2026-01-01 00:00:00', '2026-01-02 23:59:59']);
    // Unsupported bound macros fall back to the label.
    expect(onBounds('Today@javascript:gs.nope()@javascript:gs.nope()', utc)).toEqual([
      '2026-10-21 00:00:00',
      '2026-10-21 23:59:59',
    ]);
  });

  it('knows the documented dynamic filter ids', () => {
    expect(DYNAMIC_FILTERS['54635e965f510100a9ad2572f2b4774c']?.label).toBe('Me');
    expect(resolveDynamic('54635e965f510100a9ad2572f2b4774c', ny)).toEqual(['u1']);
    expect(resolveDynamic('90d1921e5f510100a9ad2572f2b477fe', ny)).toEqual(['u1']);
    expect(resolveDynamic('d6435e965f510100a9ad2572f2b47744', ny)).toEqual(['g1', 'g2']);
    expect(resolveDynamic('2a0e2e365f510100a9ad2572f2b477e9', ny)).toEqual(['m1']);
    expect(resolveDynamic('2a0e2e365f510100a9ad2572f2b477e9', { userId: 'x' })).toEqual([]);
    expect(resolveDynamic('ffffffffffffffffffffffffffffffff', ny)).toBeNull();
  });

  it('converts between UTC and local calendars', () => {
    const ms = Date.UTC(2026, 2, 8, 12, 0, 0); // US daylight saving starts that morning
    expect(localGlide(ms, 'America/New_York')).toBe('2026-03-08 08:00:00');
    expect(glide(startOf(ms, 'America/New_York', 'day'))).toBe('2026-03-08 05:00:00');
    expect(glide(endOf(ms, 'America/New_York', 'day'))).toBe('2026-03-09 03:59:59');
    expect(glide(fromLocal('Asia/Kolkata', 2026, 1, 1))).toBe('2025-12-31 18:30:00');
    expect(toLocal(Date.UTC(2026, 9, 21, 3, 30), 'America/New_York')).toMatchObject({ d: 20, h: 23, dow: 2 });
    expect(isoWeek(2026, 1, 1)).toBe(1);
    expect(isoWeek(2021, 1, 1)).toBe(53);
    const segs = zoneSegments('Europe/Paris');
    expect(segs.length).toBeGreaterThan(100);
    expect(zoneSegments('Asia/Dubai')).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- compiler and matcher

const testItsm: AppModule = {
  id: 'test_itsm',
  name: 'Test ITSM',
  dependsOn: ['task'],
  tables: [
    {
      name: 'problem',
      label: 'Problem',
      extends: 'task',
      number: { prefix: 'PRB', start: 40000 },
      columns: [],
    },
    {
      name: 'incident',
      label: 'Incident',
      extends: 'task',
      number: { prefix: 'INC', start: 10000 },
      columns: [
        { name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user' },
        { name: 'problem_id', label: 'Problem', type: 'reference', reference: 'problem' },
        { name: 'business_duration', label: 'Business duration', type: 'glide_duration' },
        { name: 'resolved_at', label: 'Resolved', type: 'glide_date_time' },
        { name: 'u_due_day', label: 'Due day', type: 'glide_date' },
        { name: 'reopen_count', label: 'Reopen count', type: 'integer' },
        { name: 'u_flag', label: 'Flag', type: 'boolean' },
        {
          name: 'category',
          label: 'Category',
          type: 'string',
          choices: [
            { value: 'network', label: 'Network' },
            { value: 'software', label: 'Software' },
            { value: 'hardware', label: 'Hardware' },
          ],
        },
      ],
    },
  ],
};

describe('query compiler and matcher', () => {
  let p: Platform;
  let ids: Record<string, string>;
  let abel: Context;
  let utcUser: Context;

  const subject = (ctx: Context, rec: Rec): MatchSubject => ({
    ...recSubject(rec, null, ctx.registry),
    relatedCount: (rq) =>
      ctx.count(rq.table, new QueryBuilder(rq.table).addQuery(rq.field, rec.sysId).addEncodedQuery(rq.query)),
    journal: (path) =>
      path.includes('.')
        ? null
        : ctx.platform.history.journal(rec.className, rec.sysId, [path]).map((j) => j.value),
  });

  /** Runs a query through SQL and through the matcher, asserts both agree and returns the names. */
  const run = (ctx: Context, query: string, table = 'incident'): string[] => {
    const sql = ctx
      .query(table, query)
      .map((r) => r.str('short_description'))
      .sort();
    const mem = ctx
      .query(table)
      .filter((r) => matches(query, subject(ctx, r), ctx.env))
      .map((r) => r.str('short_description'))
      .sort();
    expect(mem, `matcher vs SQL for ${query}`).toEqual(sql);
    return sql;
  };

  const ALL = ['Caret ^ in text', 'Email outage', 'Printer jam', 'VPN outage in lobby'];

  beforeAll(() => {
    p = bootPlatform([testItsm]);
    clock.freeze('2026-10-21 15:00:00');
    const sys = p.systemContext();
    const it = sys.insert('sys_user_group', { name: 'IT' });
    const network = sys.insert('sys_user_group', { name: 'Network', parent: it.sysId });
    const db = sys.insert('sys_user_group', { name: 'Database' });
    const abelId = makeUser(p, 'abel.tuter', ['itil'], ['Network']);
    sys.updateById('sys_user', abelId, {
      first_name: 'Abel',
      last_name: 'Tuter',
      time_zone: 'America/New_York',
    });
    const bethId = makeUser(p, 'beth.ross', ['itil']);
    sys.updateById('sys_user', bethId, { manager: abelId });
    const carlId = makeUser(p, 'carl.diaz', ['itil']);
    sys.updateById('sys_user', carlId, { manager: bethId });
    const danaId = makeUser(p, 'dana.wu', ['itil']);
    makeUser(p, 'utc.user', ['itil']);
    p.users.invalidate();
    const pa = sys.insert('problem', { short_description: 'Problem A' });
    const pb = sys.insert('problem', { short_description: 'Problem B' });
    sys.insert('problem', { short_description: 'Problem C' });
    const i1 = sys.insert('incident', {
      short_description: 'VPN outage in lobby',
      priority: 1,
      caller_id: abelId,
      problem_id: pa.sysId,
      business_duration: 3_723_000,
      opened_at: '2026-10-21 03:30:00',
      resolved_at: '2026-10-21 05:00:00',
      u_due_day: '2026-10-21',
      category: 'network',
      assigned_to: carlId,
      assignment_group: network.sysId,
      reassignment_count: 2,
      reopen_count: 1,
      u_flag: true,
    });
    const i2 = sys.insert('incident', {
      short_description: 'Email outage',
      priority: 2,
      caller_id: bethId,
      problem_id: pa.sysId,
      business_duration: 7_200_000,
      opened_at: '2026-10-21 14:30:00',
      u_due_day: '2026-10-22',
      category: 'software',
      assigned_to: bethId,
      assignment_group: db.sysId,
      reassignment_count: 0,
      reopen_count: 0,
      u_flag: false,
      comments: 'Customer called back',
    });
    const i3 = sys.insert('incident', {
      short_description: 'Printer jam',
      priority: 3,
      caller_id: carlId,
      problem_id: pb.sysId,
      opened_at: '2026-10-19 10:00:00',
      resolved_at: '2026-10-19 11:30:00',
      u_due_day: '2026-10-18',
      category: '',
      reassignment_count: 1,
      reopen_count: 3,
    });
    const i4 = sys.insert('incident', {
      short_description: 'Caret ^ in text',
      priority: 4,
      opened_at: '2026-10-07 12:00:00',
      resolved_at: '2026-10-09 12:00:00',
      category: 'hardware',
      assigned_to: danaId,
      reassignment_count: 0,
      reopen_count: 0,
      u_flag: false,
    });
    ids = {
      abel: abelId,
      beth: bethId,
      carl: carlId,
      dana: danaId,
      it: it.sysId,
      network: network.sysId,
      i1: i1.sysId,
      i2: i2.sysId,
      i3: i3.sysId,
      i4: i4.sysId,
    };
    abel = p.contextAs('abel.tuter');
    utcUser = p.contextAs('utc.user');
  });

  afterAll(() => {
    p.close();
    clock.reset();
  });

  it('compares numbers with = != > < >= <= and BETWEEN', () => {
    expect(run(abel, 'priority=1')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'priority!=1')).toEqual(['Caret ^ in text', 'Email outage', 'Printer jam']);
    expect(run(abel, 'priority>2')).toEqual(['Caret ^ in text', 'Printer jam']);
    expect(run(abel, 'priority>=2')).toEqual(['Caret ^ in text', 'Email outage', 'Printer jam']);
    expect(run(abel, 'priority<2')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'priority<=2')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'priorityBETWEEN2@3')).toEqual(['Email outage', 'Printer jam']);
  });

  it('matches strings with LIKE, NOT LIKE, STARTSWITH, ENDSWITH and their aliases', () => {
    expect(run(abel, 'short_descriptionLIKEoutage')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'short_description*OUTAGE')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'short_descriptionNOT LIKEoutage')).toEqual(['Caret ^ in text', 'Printer jam']);
    // "does not contain" never returns empty fields (Printer jam has an empty category).
    expect(run(abel, 'category!*net')).toEqual(['Caret ^ in text', 'Email outage']);
    expect(run(abel, 'short_descriptionSTARTSWITHprinter')).toEqual(['Printer jam']);
    expect(run(abel, 'short_descriptionENDSWITHlobby')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'short_description%LOBBY')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'short_description=Caret ^^ in text')).toEqual(['Caret ^ in text']);
  });

  it('handles IN, NOT IN and emptiness operators', () => {
    expect(run(abel, 'categoryINnetwork,software')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'categoryNOT INnetwork,software')).toEqual(['Caret ^ in text', 'Printer jam']);
    expect(run(abel, 'categoryISEMPTY')).toEqual(['Printer jam']);
    expect(run(abel, 'categoryEMPTY')).toEqual(['Printer jam']);
    expect(run(abel, 'categoryISNOTEMPTY')).toEqual([
      'Caret ^ in text',
      'Email outage',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'categoryNOTEMPTY')).toEqual(['Caret ^ in text', 'Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'categoryEMPTYSTRING')).toEqual(['Printer jam']);
    expect(run(abel, 'category=')).toEqual(['Printer jam']);
    expect(run(abel, 'category!=')).toEqual(['Caret ^ in text', 'Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'categoryANYTHING')).toEqual(ALL);
    expect(run(abel, 'reopen_countISEMPTY')).toEqual([]);
  });

  it('reads boolean literals case-insensitively and treats other values as no match', () => {
    expect(run(abel, 'u_flag=true')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'u_flag=TRUE')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'u_flag=false')).toEqual(['Caret ^ in text', 'Email outage']);
    expect(run(abel, 'u_flag=maybe')).toEqual([]);
    expect(run(abel, 'u_flag!=true')).toEqual(['Caret ^ in text', 'Email outage', 'Printer jam']);
  });

  it('compares references by sys_id, display value, macro and DYNAMIC option', () => {
    expect(run(abel, `caller_id=${ids.abel}`)).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'caller_id=Abel Tuter')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'caller_id=javascript:gs.getUserID()')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'caller_idDYNAMIC54635e965f510100a9ad2572f2b4774c')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'caller_idDYNAMIC90d1921e5f510100a9ad2572f2b477fe')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'caller_id.nameSTARTSWITHabel')).toEqual(['VPN outage in lobby']);
    // An unknown dynamic option is invalid and ignored.
    expect(run(abel, 'caller_idDYNAMICffffffffffffffffffffffffffffffff')).toEqual(ALL);
  });

  it('treats list macros in = as "is one of" and empty lists as no match', () => {
    expect(run(abel, 'assignment_group=javascript:getMyGroups()')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744')).toEqual([
      'VPN outage in lobby',
    ]);
    expect(run(utcUser, 'assignment_group=javascript:getMyGroups()')).toEqual([]);
    expect(run(utcUser, 'assignment_group!=javascript:getMyGroups()')).toEqual(ALL);
  });

  it('walks hierarchies with IN_HIERARCHY and IN_HIERARCHY_DYNAMIC', () => {
    expect(run(abel, `assigned_toIN_HIERARCHYmgr@${ids.abel}`)).toEqual([
      'Email outage',
      'VPN outage in lobby',
    ]);
    expect(run(abel, `assigned_toIN_HIERARCHYmgr%40${ids.beth}`)).toEqual([
      'Email outage',
      'VPN outage in lobby',
    ]);
    expect(run(abel, `assigned_toIN_HIERARCHYmgr@${ids.carl}`)).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'assigned_toIN_HIERARCHY_DYNAMICmgr@90d1921e5f510100a9ad2572f2b477fe')).toEqual([
      'Email outage',
      'VPN outage in lobby',
    ]);
    expect(
      run(p.contextAs('carl.diaz'), 'assigned_toIN_HIERARCHY_DYNAMICmgr@54635e965f510100a9ad2572f2b4774c'),
    ).toEqual(['VPN outage in lobby']);
    expect(run(abel, `assignment_groupIN_HIERARCHYgrp@${ids.it}`)).toEqual(['VPN outage in lobby']);
  });

  it('supports INSTANCEOF on the class hierarchy', () => {
    expect(run(abel, 'sys_class_nameINSTANCEOFtask', 'task')).toHaveLength(7);
    expect(run(abel, 'sys_class_nameINSTANCEOFproblem', 'task')).toEqual([
      'Problem A',
      'Problem B',
      'Problem C',
    ]);
  });

  it('compares fields with GT_FIELD, LT_FIELD, the OR_EQUALS variants, SAMEAS and NSAMEAS', () => {
    expect(run(abel, 'reassignment_countGT_FIELDreopen_count')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'reassignment_countLT_FIELDreopen_count')).toEqual(['Printer jam']);
    expect(run(abel, 'reassignment_countGT_OR_EQUALS_FIELDreopen_count')).toEqual([
      'Caret ^ in text',
      'Email outage',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'reassignment_countLT_OR_EQUALS_FIELDreopen_count')).toEqual([
      'Caret ^ in text',
      'Email outage',
      'Printer jam',
    ]);
    expect(run(abel, 'reassignment_countSAMEASreopen_count')).toEqual(['Caret ^ in text', 'Email outage']);
    expect(run(abel, 'reassignment_countNSAMEASreopen_count')).toEqual([
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'reassignment_countSAMEASno_such_field')).toEqual(ALL);
  });

  it('compares date buckets with SAMEAS/NSAMEAS @unit in the user time zone', () => {
    // VPN outage was opened on Oct 20 and resolved on Oct 21 in New York, the same UTC day.
    expect(run(abel, 'opened_atSAMEASresolved_at@day')).toEqual(['Printer jam']);
    expect(run(utcUser, 'opened_atSAMEASresolved_at@day')).toEqual(['Printer jam', 'VPN outage in lobby']);
    expect(run(abel, 'opened_atNSAMEASresolved_at@day')).toEqual(['Caret ^ in text', 'VPN outage in lobby']);
    expect(run(abel, 'opened_atSAMEASresolved_at@week')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atSAMEASresolved_at@month')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atSAMEASresolved_at@hour')).toEqual([]);
    expect(run(abel, 'opened_atSAMEASresolved_at@quarter')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atSAMEASresolved_at@year')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atSAMEASresolved_at@fortnight')).toEqual(ALL);
  });

  it('evaluates MORETHAN and LESSTHAN gaps between dates', () => {
    expect(run(abel, 'opened_atMORETHANresolved_at@hour@before@1')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atMORETHANresolved_at@hour@before@2')).toEqual(['Caret ^ in text']);
    expect(run(abel, 'opened_atLESSTHANresolved_at@hour@before@2')).toEqual([
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'resolved_atMORETHANopened_at@day@after@1')).toEqual(['Caret ^ in text']);
    expect(run(abel, 'resolved_atLESSTHANopened_at@day@after@1')).toEqual([
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atMORETHANresolved_at@hour@beforeorafter@1')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atLESSTHANresolved_at@week@either@1')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'opened_atMORETHANresolved_at@month@before@1')).toEqual([]);
    // n has at most two digits; a malformed operand is ignored.
    expect(run(abel, 'opened_atMORETHANresolved_at@hour@before@100')).toEqual(ALL);
  });

  it('evaluates ON and NOTON in the user time zone, with labels and bare dates', () => {
    const today = 'opened_atONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()';
    expect(run(abel, today)).toEqual(['Email outage']);
    expect(run(utcUser, today)).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'opened_atONToday')).toEqual(['Email outage']);
    expect(run(abel, 'opened_atON2026-10-21')).toEqual(['Email outage']);
    expect(
      run(abel, 'opened_atONYesterday@javascript:gs.beginningOfYesterday()@javascript:gs.endOfYesterday()'),
    ).toEqual(['VPN outage in lobby']);
    expect(
      run(abel, 'opened_atNOTONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()'),
    ).toEqual(['Caret ^ in text', 'Printer jam', 'VPN outage in lobby']);
    expect(run(abel, 'opened_atONThis week')).toEqual(['Email outage', 'Printer jam', 'VPN outage in lobby']);
    expect(
      run(abel, 'opened_atONLast 7 days@javascript:gs.daysAgoStart(7)@javascript:gs.endOfToday()'),
    ).toEqual(['Email outage', 'Printer jam', 'VPN outage in lobby']);
    expect(run(abel, 'u_due_dayON2026-10-21')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'u_due_dayONToday')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'opened_atONSomeday')).toEqual(ALL);
  });

  it('evaluates RELATIVE operators including dayofweek (spec vectors 8 and 9)', () => {
    expect(run(abel, 'opened_atRELATIVEGT@hour@ago@1')).toEqual(['Email outage']);
    expect(run(abel, 'opened_atRELATIVELT@dayofweek@ago@14')).toEqual(['Caret ^ in text']);
    expect(run(abel, 'opened_atRELATIVEGE@day@ago@2')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'opened_atRELATIVELE@day@ago@2')).toEqual(['Caret ^ in text', 'Printer jam']);
    expect(run(abel, 'opened_atRELATIVEEE@day@ago@2')).toEqual(['Printer jam']);
    expect(run(abel, 'opened_atRELATIVEGT@month@ago@1')).toEqual(ALL);
    expect(run(abel, 'opened_atRELATIVEGT@week@ago@1')).toEqual([
      'Email outage',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'u_due_dayRELATIVEGE@day@ahead@1')).toEqual(['Email outage']);
    expect(run(abel, 'opened_atRELATIVEGT@fortnight@ago@1')).toEqual(ALL);
  });

  it('evaluates DATEPART trends in the user time zone', () => {
    const dp = (part: string, value: string, op: string) =>
      `opened_atDATEPART${value}@javascript:gs.datePart('${part}','${value}','${op}')`;
    expect(run(abel, dp('dayofweek', 'monday', 'EE'))).toEqual(['Printer jam']);
    // Opened 23:30 on a Tuesday in New York, which is Wednesday in UTC.
    expect(run(abel, dp('dayofweek', 'tuesday', 'EE'))).toEqual(['VPN outage in lobby']);
    expect(run(utcUser, dp('dayofweek', 'tuesday', 'EE'))).toEqual([]);
    // Sunday sorts before Monday.
    expect(run(abel, dp('dayofweek', 'monday', 'LE'))).toEqual(['Printer jam']);
    expect(run(abel, dp('dayofweek', 'monday', 'LT'))).toEqual([]);
    expect(run(abel, dp('dayofweek', 'tuesday', 'GT'))).toEqual(['Caret ^ in text', 'Email outage']);
    expect(run(abel, dp('hour', '12', 'LT'))).toEqual(['Caret ^ in text', 'Email outage', 'Printer jam']);
    expect(run(abel, dp('hour', '6', 'GE'))).toEqual(ALL);
    expect(run(abel, dp('month', 'october', 'EE'))).toEqual(ALL);
    expect(run(abel, dp('quarter', '4', 'EE'))).toEqual(ALL);
    expect(run(abel, dp('year', '2026', 'EE'))).toEqual(ALL);
    expect(run(abel, dp('week', String(isoWeek(2026, 10, 19)), 'EE'))).toEqual([
      'Email outage',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, dp('dayofweek', 'monday', 'XX'))).toEqual(ALL);
  });

  it('ignores change operators and tag operators in read queries but evaluates them in rule conditions', () => {
    // By design the matcher evaluates change operators (rule conditions), so only SQL is compared here.
    const sqlOnly = (q: string) =>
      abel
        .query('incident', q)
        .map((r) => r.str('short_description'))
        .sort();
    expect(sqlOnly('priorityVALCHANGES')).toEqual(ALL);
    expect(sqlOnly('priority=1^ORpriorityCHANGESTO2')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'sys_tagsDOESNOTHAVEabc')).toEqual(ALL);
    const c = QueryCompiler.compile(p.registry, 'incident', 'priorityCHANGESFROM1^stateVALCHANGES', abel.env);
    expect(c.invalid).toEqual(['priorityCHANGESFROM1', 'stateVALCHANGES']);
    const fake: MatchSubject = {
      value: (f) => (f === 'priority' ? 2 : null),
      previous: (f) => (f === 'priority' ? 1 : null),
      isNew: () => false,
      column: (f) => p.registry.column('incident', f) ?? null,
      display: () => '',
      classes: () => ['incident', 'task'],
      descendantsOf: () => [],
      text: () => '',
    };
    const cond = (q: string) => matchCondition(parseEncodedQuery(q).blocks[0][0][0], fake, abel.env);
    expect(cond('priorityVALCHANGES')).toBe(true);
    expect(cond('priorityCHANGESFROM1')).toBe(true);
    expect(cond('priorityCHANGESTO2')).toBe(true);
    expect(cond('priorityCHANGESTO3')).toBe(false);
  });

  it('runs keyword search with phrases and accepts text index groups', () => {
    expect(run(abel, '123TEXTQUERY321=outage')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, '123TEXTQUERY321=email outage')).toEqual(['Email outage']);
    expect(run(abel, '123TEXTQUERY321="outage in"')).toEqual(['VPN outage in lobby']);
    expect(run(abel, '123TEXTINDEXGROUP321=itsm^priority=1')).toEqual(['VPN outage in lobby']);
  });

  it('runs related-list queries (RLQUERY) as correlated subqueries (spec vector 18)', () => {
    expect(run(abel, 'RLQUERYincident.problem_id,>=1^ENDRLQUERY', 'problem')).toEqual([
      'Problem A',
      'Problem B',
    ]);
    expect(run(abel, 'RLQUERYincident.problem_id,>=2^ENDRLQUERY', 'problem')).toEqual(['Problem A']);
    expect(run(abel, 'RLQUERYincident.problem_id,=0^ENDRLQUERY', 'problem')).toEqual(['Problem C']);
    expect(run(abel, 'RLQUERYincident.problem_id,>=1,priority=1^ENDRLQUERY', 'problem')).toEqual([
      'Problem A',
    ]);
    expect(run(abel, 'RLQUERYincident.problem_id,>=1^priority=3^ORpriority=4^ENDRLQUERY', 'problem')).toEqual(
      ['Problem B'],
    );
    expect(run(abel, 'active=true^RLQUERYincident.problem_id,<2^ENDRLQUERY', 'problem')).toEqual([
      'Problem B',
      'Problem C',
    ]);
    expect(run(abel, 'RLQUERYincident.problem_id,!=1^ENDRLQUERY', 'problem')).toEqual([
      'Problem A',
      'Problem C',
    ]);
    expect(
      run(abel, 'RLQUERYincident.problem_id,>=1,m2m^caller_id.user_name=beth.ross^ENDRLQUERY', 'problem'),
    ).toEqual(['Problem A']);
    expect(run(abel, 'RLQUERYincident.bogus,>=1^ENDRLQUERY', 'problem')).toEqual([
      'Problem A',
      'Problem B',
      'Problem C',
    ]);
  });

  it('supports OR, NQ, ordering with a stable tiebreaker and dot-walking', () => {
    expect(run(abel, 'priority=1^NQpriority=4')).toEqual(['Caret ^ in text', 'VPN outage in lobby']);
    expect(run(abel, 'category=software^ORcategory=hardware^priority>1')).toEqual([
      'Caret ^ in text',
      'Email outage',
    ]);
    expect(abel.query('incident', 'ORDERBYDESCpriority').map((r) => r.num('priority'))).toEqual([4, 3, 2, 1]);
    expect(abel.query('incident', 'ORDERBYcategory').map((r) => r.str('category'))).toEqual([
      '',
      'hardware',
      'network',
      'software',
    ]);
    expect(QueryCompiler.compile(p.registry, 'incident', 'ORDERBYpriority', abel.env).orderBy).toBe(
      't0."priority" ASC, t0.rowid ASC',
    );
    expect(run(abel, 'caller_id.manager.user_name=abel.tuter')).toEqual(['Email outage']);
    expect(run(abel, 'caller_id.nameISEMPTY')).toEqual(['Caret ^ in text']);
    expect(run(abel, 'caller_id.name!=Abel Tuter')).toEqual([
      'Caret ^ in text',
      'Email outage',
      'Printer jam',
    ]);
  });

  it('drops blocks whose terms are all invalid (not TRUE) in SQL and in the matcher', () => {
    expect(run(abel, 'bogus=1^NQpriority=1')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'bogus=1^priority=1^NQnope=2')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'bogus=1')).toEqual(ALL);
    expect(run(abel, 'caller_id=javascript:gs.evil()')).toEqual(ALL);
  });

  it('parses durations and dates', () => {
    expect(run(abel, 'business_duration=1970-01-01 01:02:03')).toEqual(['VPN outage in lobby']);
    expect(run(abel, 'business_duration>0 01:30:00')).toEqual(['Email outage']);
    expect(run(abel, "business_duration<javascript:gs.getDurationDate('0 01:30:00')")).toEqual([
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'u_due_day>2026-10-20')).toEqual(['Email outage', 'VPN outage in lobby']);
    // Literal date-times keep their written date; macro bounds map to the user's local date.
    expect(run(abel, 'u_due_day>=2026-10-21 00:00:00')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'u_due_day>=javascript:gs.beginningOfToday()')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(run(abel, 'u_due_day<javascript:gs.beginningOfToday()')).toEqual(['Printer jam']);
    expect(run(abel, 'u_due_dayBETWEENjavascript:gs.beginningOfToday()@javascript:gs.endOfTomorrow()')).toEqual(['Email outage', 'VPN outage in lobby']);
    expect(
      run(
        abel,
        'opened_atBETWEENjavascript:gs.dateGenerate("2026-10-19","start")@javascript:gs.dateGenerate("2026-10-19","end")',
      ),
    ).toEqual(['Printer jam']);
  });

  it('searches journal fields through their entries', () => {
    expect(run(abel, 'commentsLIKEcalled back')).toEqual(['Email outage']);
    expect(run(abel, 'commentsISNOTEMPTY')).toEqual(['Email outage']);
    expect(run(abel, 'commentsISEMPTY')).toEqual(['Caret ^ in text', 'Printer jam', 'VPN outage in lobby']);
    expect(run(abel, 'commentsNOT LIKEzzz')).toEqual(['Email outage']);
    expect(run(abel, 'comments=customer called back')).toEqual(['Email outage']);
    expect(run(abel, 'comments!=customer called back')).toEqual([
      'Caret ^ in text',
      'Printer jam',
      'VPN outage in lobby',
    ]);
    expect(run(abel, 'comments=')).toEqual(['Caret ^ in text', 'Printer jam', 'VPN outage in lobby']);
    // Rule-condition subjects without journal access keep evaluating change operators on the row.
    const rec = abel.get('incident', ids.i2)!;
    expect(matches('commentsVALCHANGES', recSubject(rec, null, p.registry), abel.env)).toBe(false);
  });

  it('never matches password values', () => {
    expect(run(abel, 'caller_id.user_passwordSTARTSWITHscrypt')).toEqual(ALL);
    expect(run(abel, 'caller_id.user_passwordISNOTEMPTY')).toEqual([
      'Email outage',
      'Printer jam',
      'VPN outage in lobby',
    ]);
  });

  it('includes empty values in != (spec vector 17)', () => {
    p.systemContext().updateById('incident', ids.i4, { state: '' });
    expect(run(abel, 'state!=7')).toEqual(ALL);
  });
});

describe('REST query validation', () => {
  let p: Platform;
  beforeAll(() => {
    p = bootPlatform([testItsm]);
  });
  afterAll(() => p.close());

  it('applies the operator applicability table', () => {
    const col = (t: string, f: string) => p.registry.column(t, f)!;
    expect(operatorApplies('LIKE', col('task', 'active'))).toBe(false);
    expect(operatorApplies('=', col('task', 'active'))).toBe(true);
    expect(operatorApplies('>', col('incident', 'caller_id'))).toBe(false);
    expect(operatorApplies('DYNAMIC', col('incident', 'caller_id'))).toBe(true);
    expect(operatorApplies('ON', col('task', 'opened_at'))).toBe(true);
    expect(operatorApplies('LIKE', col('task', 'opened_at'))).toBe(false);
    expect(operatorApplies('STARTSWITH', col('sys_user', 'user_password'))).toBe(false);
    expect(operatorApplies('INSTANCEOF', col('task', 'sys_class_name'))).toBe(true);
  });

  it('drops inapplicable and unreadable terms and keeps the rest', () => {
    const r = checkQuery(
      p.registry,
      'incident',
      'activeLIKEtru^short_descriptionLIKEx^ORcaller_id.user_passwordSTARTSWITHa^priority>1',
    );
    expect(r.dropped).toEqual(['activeLIKEtru', 'caller_id.user_passwordSTARTSWITHa']);
    expect(stringifyQuery(r.query)).toBe('short_descriptionLIKEx^priority>1');
    const hidden = checkQuery(
      p.registry,
      'incident',
      'caller_id.email=a@b.c^priority=1^ORDERBYcaller_id.email',
      {
        canRead: (t, f) => !(t === 'sys_user' && f === 'email'),
      },
    );
    expect(hidden.dropped).toEqual(['caller_id.email=a@b.c']);
    expect(hidden.query.orderBy).toEqual([]);
    const rl = checkQuery(
      p.registry,
      'problem',
      'RLQUERYincident.problem_id,>=1^activeLIKEx^priority=1^ENDRLQUERY',
    );
    expect(rl.dropped).toEqual(['activeLIKEx']);
    expect(rl.query.blocks[0][0][0].related?.query).toBe('priority=1');
  });
});
