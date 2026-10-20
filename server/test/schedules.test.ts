import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../src/engine/context.js';
import { AbortError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import { clock, parseGlideDateTime, toGlideDateTime } from '../src/engine/util.js';
import { type ScheduleEngine, scheduleEngine, schedulesModule } from '../src/modules/schedules/index.js';
import { relativeEnd } from '../src/modules/schedules/relative.js';
import { bootPlatform } from './helpers.js';

const H = 3_600_000;
const T = (s: string) => parseGlideDateTime(s)!.getTime();
const G = (ms: number | null) => (ms === null ? null : toGlideDateTime(new Date(ms)));

let p: Platform;
let ctx: Context;
let engine: ScheduleEngine;
let W: string;

function makeSchedule(
  name: string,
  spans: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): string {
  const s = ctx.insert('cmn_schedule', { name, ...extra });
  for (const span of spans)
    ctx.insert('cmn_schedule_span', { schedule: s.sysId, name: `${name} entry`, ...span });
  return s.sysId;
}

const WEEKDAYS = {
  start_date_time: '20000103T080000',
  end_date_time: '20000103T170000',
  repeat_type: 'weekdays',
};

beforeEach(() => {
  p = bootPlatform([schedulesModule]);
  ctx = p.systemContext();
  engine = scheduleEngine(p)!;
  W = ctx.first('cmn_schedule', 'name=8-5 weekdays')!.sysId;
});

afterEach(() => {
  p.close();
  clock.reset();
});

describe('seeded schedules', () => {
  it('creates the common schedules, holidays and relative durations', () => {
    for (const n of [
      '24x7',
      '8-5 weekdays',
      '8-5 weekdays excluding holidays',
      'U.S. Holidays',
      'Weekends',
    ]) {
      expect(ctx.first('cmn_schedule', `name=${n}`), n).not.toBeNull();
    }
    expect(ctx.count('cmn_relative_duration')).toBe(5);
    const always = ctx.first('cmn_schedule', 'name=24x7')!.sysId;
    expect(engine.duration(always, 'UTC', T('2025-03-08 00:00:00'), T('2025-03-10 00:00:00'))).toBe(48 * H);
  });
});

describe('business time math (8-5 weekdays, UTC)', () => {
  it('1: inside / outside with an exclusive end', () => {
    expect(engine.contains(W, 'UTC', T('2025-03-03 08:00:00'))).toBe(true);
    expect(engine.contains(W, 'UTC', T('2025-03-03 17:00:00'))).toBe(false);
    expect(engine.contains(W, 'UTC', T('2025-03-08 10:00:00'))).toBe(false);
  });

  it('2-3: durations within a day and across a weekend', () => {
    expect(engine.duration(W, 'UTC', T('2025-03-03 07:00:00'), T('2025-03-03 18:00:00'))).toBe(9 * H);
    expect(engine.duration(W, 'UTC', T('2025-03-07 16:00:00'), T('2025-03-10 09:00:00'))).toBe(2 * H);
    expect(engine.duration(W, 'UTC', T('2025-03-10 09:00:00'), T('2025-03-07 16:00:00'))).toBe(0);
  });

  it('4-6: add across the weekend, from outside the schedule and to an interval end', () => {
    expect(G(engine.add(W, 'UTC', T('2025-03-07 16:00:00'), 2 * H))).toBe('2025-03-10 09:00:00');
    expect(G(engine.add(W, 'UTC', T('2025-03-08 10:00:00'), H))).toBe('2025-03-10 09:00:00');
    expect(G(engine.add(W, 'UTC', T('2025-03-03 09:00:00'), 8 * H))).toBe('2025-03-03 17:00:00');
  });

  it('7: a 24 h duration consumes 24 h of schedule time (9 h days)', () => {
    // Mon 9 h + Tue 9 h + Wed 6 h. The spec example quotes Wed 17:00, which assumes 8 h days.
    expect(G(engine.add(W, 'UTC', T('2025-03-03 08:00:00'), 24 * H))).toBe('2025-03-05 14:00:00');
    expect(G(engine.add(W, 'UTC', T('2025-03-03 08:00:00'), 27 * H))).toBe('2025-03-05 17:00:00');
  });

  it('8: adding zero returns the start; nextInSchedule moves to the next interval', () => {
    expect(G(engine.add(W, 'UTC', T('2025-03-08 10:00:00'), 0))).toBe('2025-03-08 10:00:00');
    expect(G(engine.nextInSchedule(W, 'UTC', T('2025-03-08 10:00:00')))).toBe('2025-03-10 08:00:00');
    expect(G(engine.nextInSchedule(W, 'UTC', T('2025-03-10 10:00:00')))).toBe('2025-03-10 10:00:00');
  });

  it('9: entries that cross midnight', () => {
    const night = makeSchedule('Nights', [
      { start_date_time: '20250101T220000', end_date_time: '20250102T060000', repeat_type: 'daily' },
    ]);
    expect(engine.duration(night, 'UTC', T('2025-03-03 20:00:00'), T('2025-03-04 08:00:00'))).toBe(8 * H);
  });

  it('10: an excluded day removes its time', () => {
    const s = makeSchedule('W with Tuesday off', [
      WEEKDAYS,
      { type: 'exclude', all_day: true, start_date_time: '20250304', end_date_time: '20250304' },
    ]);
    expect(engine.duration(s, 'UTC', T('2025-03-03 08:00:00'), T('2025-03-05 17:00:00'))).toBe(18 * H);
    expect(G(engine.add(s, 'UTC', T('2025-03-03 16:00:00'), 8 * H))).toBe('2025-03-05 15:00:00');
  });

  it('11: holidays come from the included holiday schedule', () => {
    const s = ctx.first('cmn_schedule', 'name=8-5 weekdays excluding holidays')!.sysId;
    expect(engine.contains(s, 'UTC', T('2025-07-04 10:00:00'))).toBe(false);
    expect(engine.contains(s, 'UTC', T('2025-07-03 10:00:00'))).toBe(true);
    for (const day of [
      '2025-01-01',
      '2025-01-20',
      '2025-02-17',
      '2025-05-26',
      '2025-06-19',
      '2025-09-01',
      '2025-10-13',
      '2025-11-11',
      '2025-11-27',
      '2025-11-28',
      '2025-12-25',
    ]) {
      expect(engine.contains(s, 'UTC', T(`${day} 10:00:00`)), day).toBe(false);
    }
    expect(engine.contains(s, 'UTC', T('2025-11-26 10:00:00'))).toBe(true);
  });

  it('12: parent entries apply to the child schedule', () => {
    const b = makeSchedule('Afternoons', [
      { start_date_time: '20000103T130000', end_date_time: '20000103T170000', repeat_type: 'weekdays' },
    ]);
    const a = makeSchedule(
      'Mornings',
      [{ start_date_time: '20000103T080000', end_date_time: '20000103T120000', repeat_type: 'weekdays' }],
      { parent: b },
    );
    expect(engine.duration(a, 'UTC', T('2025-03-03 00:00:00'), T('2025-03-04 00:00:00'))).toBe(8 * H);
    expect(engine.duration(b, 'UTC', T('2025-03-03 00:00:00'), T('2025-03-04 00:00:00'))).toBe(4 * H);
  });

  it('13: a child schedule linked with type exclude subtracts its time', () => {
    const weekends = ctx.first('cmn_schedule', 'name=Weekends')!.sysId;
    const always = ctx.first('cmn_schedule', 'name=24x7')!.sysId;
    const custom = makeSchedule('24x7 without weekends', [
      { start_date_time: '20000101T000000', end_date_time: '20000102T000000', repeat_type: 'daily' },
    ]);
    ctx.insert('cmn_other_schedule', { schedule: custom, child_schedule: weekends, type: 'exclude' });
    ctx.insert('cmn_other_schedule', { schedule: W, child_schedule: weekends, type: 'exclude' });
    expect(engine.duration(custom, 'UTC', T('2025-03-08 00:00:00'), T('2025-03-10 00:00:00'))).toBe(0);
    expect(engine.duration(custom, 'UTC', T('2025-03-10 00:00:00'), T('2025-03-11 00:00:00'))).toBe(24 * H);
    expect(engine.duration(W, 'UTC', T('2025-03-08 00:00:00'), T('2025-03-10 00:00:00'))).toBe(0);
    expect(engine.duration(W, 'UTC', T('2025-03-03 00:00:00'), T('2025-03-04 00:00:00'))).toBe(9 * H);
    expect(engine.duration(always, 'UTC', T('2025-03-08 00:00:00'), T('2025-03-09 00:00:00'))).toBe(24 * H);
  });
});

describe('repeat rules', () => {
  const at = (s: string, day: string, time = '09:30:00') => engine.contains(s, 'UTC', T(`${day} ${time}`));

  it('14: weekly on Monday and Wednesday every two weeks', () => {
    const s = makeSchedule('Biweekly', [
      {
        start_date_time: '20250303T090000',
        end_date_time: '20250303T100000',
        repeat_type: 'weekly',
        days_of_week: '13',
        repeat_count: '2',
      },
    ]);
    expect(['2025-03-03', '2025-03-05', '2025-03-17', '2025-03-19'].map((d) => at(s, d))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['2025-03-10', '2025-03-12', '2025-03-04'].map((d) => at(s, d))).toEqual([false, false, false]);
  });

  it('15: monthly by day of month skips months without that day', () => {
    const s = makeSchedule('Month end', [
      {
        start_date_time: '20250131T090000',
        end_date_time: '20250131T100000',
        repeat_type: 'monthly',
        monthly_type: 'dom',
      },
    ]);
    expect(engine.duration(s, 'UTC', T('2025-02-01 00:00:00'), T('2025-03-01 00:00:00'))).toBe(0);
    expect(G(engine.nextInSchedule(s, 'UTC', T('2025-02-01 00:00:00')))).toBe('2025-03-31 09:00:00');
  });

  it('16: monthly nth weekday by day index or by week row', () => {
    const s = makeSchedule('First Monday', [
      {
        start_date_time: '20121105T090000',
        end_date_time: '20121105T100000',
        repeat_type: 'monthly',
        monthly_type: 'nth',
      },
    ]);
    expect(G(engine.nextInSchedule(s, 'UTC', T('2012-11-06 00:00:00')))).toBe('2012-12-03 09:00:00');
    expect(G(engine.nextInSchedule(s, 'UTC', T('2012-12-04 00:00:00')))).toBe('2013-01-07 09:00:00');
    p.properties.set('glide.schedules.repeat_nth', 'week');
    expect(G(engine.nextInSchedule(s, 'UTC', T('2012-11-06 00:00:00')))).toBe('2012-12-10 09:00:00');
    expect(G(engine.nextInSchedule(s, 'UTC', T('2012-12-11 00:00:00')))).toBe('2013-01-14 09:00:00');
  });

  it('17: fifth weekday handling: last, next and strict', () => {
    const s = makeSchedule('Fifth Thursday', [
      {
        start_date_time: '20121129T090000',
        end_date_time: '20121129T100000',
        repeat_type: 'monthly',
        monthly_type: 'nth',
      },
    ]);
    const next = () => G(engine.nextInSchedule(s, 'UTC', T('2012-11-30 00:00:00')));
    const jan = () => at(s, '2013-01-31');
    expect(next()).toBe('2012-12-27 09:00:00');
    expect(jan()).toBe(true);
    p.properties.set('glide.schedules.fifth', 'next');
    expect(next()).toBe('2013-01-03 09:00:00');
    expect(jan()).toBe(true);
    p.properties.set('glide.schedules.fifth', 'strict');
    expect(next()).toBe('2013-01-31 09:00:00');
  });

  it('18: last weekday and last day of the month', () => {
    const lw = makeSchedule('Last Friday', [
      {
        start_date_time: '20250328T090000',
        end_date_time: '20250328T100000',
        repeat_type: 'monthly',
        monthly_type: 'lwdom',
      },
    ]);
    expect(G(engine.nextInSchedule(lw, 'UTC', T('2025-04-01 00:00:00')))).toBe('2025-04-25 09:00:00');
    const ld = makeSchedule('Last day', [
      {
        start_date_time: '20250131T090000',
        end_date_time: '20250131T100000',
        repeat_type: 'monthly',
        monthly_type: 'ldom',
      },
    ]);
    expect(G(engine.nextInSchedule(ld, 'UTC', T('2025-02-01 00:00:00')))).toBe('2025-02-28 09:00:00');
  });

  it('19: yearly floating weekday', () => {
    const s = makeSchedule('Fourth Thursday of November', [
      {
        all_day: true,
        start_date_time: '20001123',
        end_date_time: '20001123',
        repeat_type: 'yearly',
        yearly_type: 'float',
        month: '11',
        float_week: '4',
        float_day: '5',
      },
    ]);
    expect(G(engine.nextInSchedule(s, 'UTC', T('2025-01-01 00:00:00')))).toBe('2025-11-27 00:00:00');
    expect(engine.duration(s, 'UTC', T('2025-11-27 00:00:00'), T('2025-11-29 00:00:00'))).toBe(24 * H);
  });

  it('20: repeat until is inclusive', () => {
    const s = makeSchedule('Three days', [
      {
        start_date_time: '20250303T090000',
        end_date_time: '20250303T100000',
        repeat_type: 'daily',
        repeat_until: 20250305,
      },
    ]);
    expect(['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06'].map((d) => at(s, d))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('25: an override entry replaces one occurrence', () => {
    const s = makeSchedule('W with override', [WEEKDAYS]);
    const parent = ctx.first('cmn_schedule_span', `schedule=${s}`)!;
    ctx.insert('cmn_schedule_span', {
      schedule: s,
      name: 'Moved',
      parent: parent.sysId,
      override_start_date: 20250305,
      start_date_time: '20250305T120000',
      end_date_time: '20250305T140000',
    });
    expect(engine.duration(s, 'UTC', T('2025-03-05 00:00:00'), T('2025-03-06 00:00:00'))).toBe(2 * H);
    expect(engine.duration(s, 'UTC', T('2025-03-04 00:00:00'), T('2025-03-05 00:00:00'))).toBe(9 * H);
  });
});

describe('time zones', () => {
  it('21: floating schedules follow the caller zone; fixed zones win', () => {
    expect(engine.contains(W, 'America/New_York', T('2025-03-03 12:00:00'))).toBe(false);
    expect(engine.contains(W, 'America/New_York', T('2025-03-03 13:00:00'))).toBe(true);
    const paris = makeSchedule('Paris 8-5', [WEEKDAYS], { time_zone: 'Europe/Paris' });
    expect(engine.contains(paris, 'America/New_York', T('2025-03-03 07:00:00'))).toBe(true);
    expect(engine.contains(paris, 'America/New_York', T('2025-03-03 06:59:59'))).toBe(false);
    expect(engine.zoneFor(paris, 'America/New_York')).toBe('Europe/Paris');
    expect(engine.zoneFor(W, null)).toBe('UTC');
  });

  it('22: durations are real elapsed time across DST changes', () => {
    const s = makeSchedule('Early hours', [
      { start_date_time: '20250101T000000', end_date_time: '20250101T080000', repeat_type: 'daily' },
    ]);
    const z = 'America/New_York';
    expect(engine.duration(s, z, T('2025-03-09 05:00:00'), T('2025-03-10 04:00:00'))).toBe(7 * H);
    expect(engine.duration(s, z, T('2025-11-02 04:00:00'), T('2025-11-03 05:00:00'))).toBe(9 * H);
  });

  it('23: a start inside the spring-forward gap begins when the gap ends', () => {
    const s = makeSchedule('Gap', [{ start_date_time: '20250309T023000', end_date_time: '20250309T040000' }]);
    expect(
      engine.intervals(s, 'America/New_York', T('2025-03-09 00:00:00'), T('2025-03-10 00:00:00')),
    ).toEqual([[T('2025-03-09 07:00:00'), T('2025-03-09 08:00:00')]]);
  });

  it('24: adding business time across the DST change', () => {
    expect(G(engine.add(W, 'America/New_York', T('2025-03-07 21:00:00'), 4 * H))).toBe('2025-03-10 15:00:00');
  });
});

describe('validation', () => {
  it('26: a schedule with only exclusions has no usable time and cannot be a parent', () => {
    const only = makeSchedule('Only exclusions', [
      { type: 'exclude', all_day: true, start_date_time: '20250304', end_date_time: '20250304' },
    ]);
    expect(engine.add(only, 'UTC', T('2025-03-03 08:00:00'), H)).toBeNull();
    expect(engine.nextInSchedule(only, 'UTC', T('2025-03-03 08:00:00'))).toBeNull();
    expect(() => ctx.insert('cmn_schedule', { name: 'Child', parent: only })).toThrow(AbortError);
    const rec = ctx.get('cmn_schedule', only)!;
    ctx.messages.length = 0;
    ctx.update(rec, { description: 'Holidays only' });
    expect(ctx.messages.map((m) => m.text)).toContain("Schedule 'Only exclusions' has no active entries");
  });

  it('27: maintenance and blackout entries cannot share a schedule tree', () => {
    const child = makeSchedule('Change windows', [
      {
        type: 'maintenance',
        start_date_time: '20250301T220000',
        end_date_time: '20250302T020000',
        repeat_type: 'weekly',
        days_of_week: '6',
      },
    ]);
    const parent = makeSchedule('Datacenter', [WEEKDAYS]);
    ctx.insert('cmn_other_schedule', { schedule: parent, child_schedule: child, type: 'include' });
    expect(() =>
      ctx.insert('cmn_schedule_span', {
        schedule: parent,
        name: 'Freeze',
        type: 'blackout',
        start_date_time: '20251220T000000',
        end_date_time: '20260102T000000',
      }),
    ).toThrow(AbortError);
    expect(() =>
      ctx.insert('cmn_schedule_span', {
        schedule: child,
        name: 'More',
        type: 'maintenance',
        start_date_time: '20250308T220000',
        end_date_time: '20250309T020000',
      }),
    ).not.toThrow();
  });

  it('normalises entry date formats and rejects bad ones', () => {
    const s = makeSchedule('Formats', []);
    const span = ctx.insert('cmn_schedule_span', {
      schedule: s,
      name: 'x',
      start_date_time: '2025-03-03 08:00:00',
      end_date_time: '2025-03-03 09:30:00',
    });
    expect(span.str('start_date_time')).toBe('20250303T080000');
    expect(span.str('end_date_time')).toBe('20250303T093000');
    const day = ctx.insert('cmn_schedule_span', {
      schedule: s,
      name: 'y',
      start_date_time: '20250304',
      end_date_time: '20250304',
    });
    expect(day.bool('all_day')).toBe(true);
    expect(() =>
      ctx.insert('cmn_schedule_span', {
        schedule: s,
        name: 'z',
        start_date_time: 'tomorrow',
        end_date_time: '20250304',
      }),
    ).toThrow(AbortError);
    expect(() => ctx.insert('cmn_schedule', { name: 'Bad zone', time_zone: 'Mars/Olympus' })).toThrow(
      AbortError,
    );
  });

  it('drops cached intervals when entries change', () => {
    const s = makeSchedule('Changing', [WEEKDAYS]);
    expect(engine.duration(s, 'UTC', T('2025-03-03 00:00:00'), T('2025-03-04 00:00:00'))).toBe(9 * H);
    const span = ctx.first('cmn_schedule_span', `schedule=${s}`)!;
    ctx.update(span, { end_date_time: '20000103T120000' });
    expect(engine.duration(s, 'UTC', T('2025-03-03 00:00:00'), T('2025-03-04 00:00:00'))).toBe(4 * H);
    ctx.delete(ctx.get('cmn_schedule_span', span.sysId)!);
    expect(engine.duration(s, 'UTC', T('2025-03-03 00:00:00'), T('2025-03-04 00:00:00'))).toBe(0);
  });
});

describe('ScheduleService contract and relative durations', () => {
  it('works on glide date-time strings', () => {
    expect(engine.businessMs(ctx, W, '2025-03-07 16:00:00', '2025-03-10 09:00:00')).toBe(2 * H);
    expect(engine.addBusinessMs(ctx, W, '2025-03-07 16:00:00', 2 * H)).toBe('2025-03-10 09:00:00');
    expect(engine.isInSchedule(ctx, W, '2025-03-10 08:30:00', 'UTC')).toBe(true);
    expect(engine.businessMs(ctx, null, '2025-03-07 16:00:00', '2025-03-07 18:00:00')).toBe(2 * H);
    expect(engine.addBusinessMs(ctx, null, '2025-03-07 16:00:00', H)).toBe('2025-03-07 17:00:00');
  });

  it('computes the built-in relative durations', () => {
    const def = (name: string) => ctx.first('cmn_relative_duration', `name=${name}`)!;
    const base = { now: T('2025-03-07 10:00:00'), scheduleId: W, zone: 'UTC', current: null };
    expect(
      G(relativeEnd(engine, def('End of next business day'), { ...base, start: T('2025-03-07 10:00:00') })),
    ).toBe('2025-03-10 17:00:00');
    expect(
      G(relativeEnd(engine, def('Two business days by 4pm'), { ...base, start: T('2025-03-03 09:00:00') })),
    ).toBe('2025-03-05 16:00:00');
    expect(
      G(relativeEnd(engine, def('Two business days by 4pm'), { ...base, start: T('2025-03-03 11:00:00') })),
    ).toBe('2025-03-06 16:00:00');
    const custom = ctx.insert('cmn_relative_duration', {
      name: 'Two schedule hours',
      duration_amount: 2,
      duration_unit: 'hours',
    });
    expect(G(relativeEnd(engine, custom, { ...base, start: T('2025-03-07 16:00:00') }))).toBe(
      '2025-03-10 09:00:00',
    );
  });
});
