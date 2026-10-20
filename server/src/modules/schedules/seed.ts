import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { BUILT_IN_RELATIVE_DURATIONS } from './relative.js';
import { dayOf, isoWeekday, ymdOf } from './time.js';

export interface SpanSeed {
  name: string;
  start: string;
  end: string;
  type?: string;
  all_day?: boolean;
  repeat_type?: string;
  repeat_count?: string;
  days_of_week?: string;
  yearly_type?: string;
  month?: string;
  float_week?: string;
  float_day?: string;
  monthly_type?: string;
  repeat_until?: number;
}

export interface ScheduleSeed {
  name: string;
  description: string;
  type?: string;
  time_zone?: string;
  spans: SpanSeed[];
  includes?: string[];
}

export const SEED_SCHEDULE_NAMES = {
  always: '24x7',
  weekdays: '8-5 weekdays',
  weekdaysNoHolidays: '8-5 weekdays excluding holidays',
  usHolidays: 'U.S. Holidays',
  weekends: 'Weekends',
} as const;

const WEEKDAYS_8_5: SpanSeed = {
  name: 'Weekdays 08:00-17:00',
  start: '20000103T080000',
  end: '20000103T170000',
  repeat_type: 'weekdays',
};

/** All-day holiday entry repeating every year on a fixed date. */
function fixedHoliday(name: string, fromYear: number, month: number, day: number): SpanSeed {
  const ymd = `${fromYear}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  return {
    name,
    type: 'exclude',
    all_day: true,
    start: `${ymd}T000000`,
    end: `${ymd}T235959`,
    repeat_type: 'yearly',
    yearly_type: 'doy',
  };
}

/** n-th (or last) weekday of a month in a given year; weekday is ISO (1 = Monday). */
function nthWeekday(year: number, month: number, isoDow: number, n: number | 'last'): number {
  if (n === 'last') {
    const next = month === 12 ? dayOf(year + 1, 1, 1) : dayOf(year, month + 1, 1);
    let d = next - 1;
    while (isoWeekday(d) !== isoDow) d--;
    return d;
  }
  let d = dayOf(year, month, 1);
  while (isoWeekday(d) !== isoDow) d++;
  return d + (n - 1) * 7;
}

/** All-day holiday entry on a floating weekday (e.g. last Monday of May); float_day 1 = Sunday. */
function floatingHoliday(name: string, month: number, isoDow: number, week: number | 'last'): SpanSeed {
  const ymd = ymdOf(nthWeekday(2000, month, isoDow, week));
  return {
    name,
    type: 'exclude',
    all_day: true,
    start: `${ymd}T000000`,
    end: `${ymd}T235959`,
    repeat_type: 'yearly',
    yearly_type: 'float',
    month: String(month),
    float_week: String(week),
    float_day: String((isoDow % 7) + 1),
  };
}

/** The Friday after the fourth Thursday of November is not a fixed weekday rule, so one entry per year. */
function dayAfterThanksgiving(fromYear: number, toYear: number): SpanSeed[] {
  const out: SpanSeed[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const ymd = ymdOf(nthWeekday(y, 11, 4, 4) + 1);
    out.push({
      name: `Day after Thanksgiving ${y}`,
      type: 'exclude',
      all_day: true,
      start: `${ymd}T000000`,
      end: `${ymd}T235959`,
    });
  }
  return out;
}

export const US_HOLIDAYS: SpanSeed[] = [
  fixedHoliday("New Year's Day", 2000, 1, 1),
  floatingHoliday('Martin Luther King Jr. Day', 1, 1, 3),
  floatingHoliday("Presidents' Day", 2, 1, 3),
  floatingHoliday('Memorial Day', 5, 1, 'last'),
  fixedHoliday('Juneteenth', 2021, 6, 19),
  fixedHoliday('Independence Day', 2000, 7, 4),
  floatingHoliday('Labor Day', 9, 1, 1),
  floatingHoliday('Columbus Day', 10, 1, 2),
  fixedHoliday('Veterans Day', 2000, 11, 11),
  floatingHoliday('Thanksgiving Day', 11, 4, 4),
  ...dayAfterThanksgiving(2020, 2040),
  fixedHoliday('Christmas Day', 2000, 12, 25),
];

export const SEED_SCHEDULES: ScheduleSeed[] = [
  {
    name: SEED_SCHEDULE_NAMES.always,
    description: 'Around the clock, every day of the year.',
    spans: [
      { name: 'All day, every day', start: '20000101T000000', end: '20000102T000000', repeat_type: 'daily' },
    ],
  },
  {
    name: SEED_SCHEDULE_NAMES.weekdays,
    description: 'Monday to Friday, 08:00 to 17:00 in the time zone of whoever uses the schedule.',
    spans: [WEEKDAYS_8_5],
  },
  {
    name: SEED_SCHEDULE_NAMES.usHolidays,
    description:
      'United States federal holidays (sample list). Add it as a child schedule to exclude these days.',
    type: 'excluded',
    spans: US_HOLIDAYS,
  },
  {
    name: SEED_SCHEDULE_NAMES.weekdaysNoHolidays,
    description: 'Monday to Friday, 08:00 to 17:00, excluding U.S. holidays.',
    spans: [WEEKDAYS_8_5],
    includes: [SEED_SCHEDULE_NAMES.usHolidays],
  },
  {
    name: SEED_SCHEDULE_NAMES.weekends,
    description: 'Saturday 00:00 to Monday 00:00.',
    spans: [
      {
        name: 'Weekend',
        start: '20000101T000000',
        end: '20000103T000000',
        repeat_type: 'weekly',
        days_of_week: '6',
      },
    ],
  },
];

/** Creates a schedule with its entries and child links unless one with the same name exists. */
export function ensureSchedule(ctx: Context, seed: ScheduleSeed): Rec {
  const existing = ctx.first('cmn_schedule', `name=${seed.name}`);
  if (existing) return existing;
  const schedule = ctx.insert('cmn_schedule', {
    name: seed.name,
    description: seed.description,
    type: seed.type ?? '',
    time_zone: seed.time_zone ?? '',
  });
  for (const s of seed.spans) {
    const { start, end, ...rest } = s;
    ctx.insert('cmn_schedule_span', {
      schedule: schedule.sysId,
      start_date_time: start,
      end_date_time: end,
      ...rest,
    });
  }
  for (const childName of seed.includes ?? []) {
    const child = ctx.first('cmn_schedule', `name=${childName}`);
    if (child)
      ctx.insert('cmn_other_schedule', {
        schedule: schedule.sysId,
        child_schedule: child.sysId,
        type: 'include',
      });
  }
  return schedule;
}

export function seedSchedules(ctx: Context): void {
  for (const s of SEED_SCHEDULES) ensureSchedule(ctx, s);
  for (const r of BUILT_IN_RELATIVE_DURATIONS) {
    if (!ctx.first('cmn_relative_duration', `name=${r.name}`))
      ctx.insert('cmn_relative_duration', { name: r.name, description: r.description, active: true });
  }
}

/** Office-hour schedules for the Northwind Labs sites (fixed time zones). */
export function demoSchedules(ctx: Context): void {
  const offices: [string, string, string][] = [
    ['Northwind Austin office hours', 'America/Chicago', '20000103T080000'],
    ['Northwind London office hours', 'Europe/London', '20000103T090000'],
    ['Northwind Singapore office hours', 'Asia/Singapore', '20000103T090000'],
  ];
  for (const [name, zone, start] of offices) {
    const endHour = Number(start.slice(9, 11)) + 9;
    const us = zone === 'America/Chicago';
    ensureSchedule(ctx, {
      name,
      description: `Weekday office hours in ${zone}${us ? ', excluding U.S. holidays' : ''}.`,
      time_zone: zone,
      spans: [
        {
          name: 'Office hours',
          start,
          end: `${start.slice(0, 9)}${String(endHour).padStart(2, '0')}0000`,
          repeat_type: 'weekdays',
        },
      ],
      includes: us ? [SEED_SCHEDULE_NAMES.usHolidays] : [],
    });
  }
}
