import type { Rec } from '../../engine/record.js';
import { parseGlideDateTime } from '../../engine/util.js';
import type { ScheduleEngine } from './engine.js';
import { DAY, HOUR, localDay, localSecond, toUtc } from './time.js';

export interface RelativeInput {
  start: number;
  now: number;
  scheduleId: string | null;
  zone: string | null;
  /** Record the calculator reads (the task for "Breach on Due Date"). */
  current: Rec | null;
}

/** The built-in relative durations seeded into cmn_relative_duration (schedules.md section 7). */
export const BUILT_IN_RELATIVE_DURATIONS: { name: string; description: string }[] = [
  { name: 'End of next business day', description: 'Breaches at 17:00 on the next business day.' },
  { name: 'Next business day by 4pm', description: 'Breaches at 16:00 on the next business day.' },
  {
    name: 'Two business days by 4pm',
    description: 'Breaches at 16:00 two business days later, or three when started after 10:00.',
  },
  {
    name: 'Three business days by 4pm',
    description: 'Breaches at 16:00 three business days later, or four when started after 10:00.',
  },
  {
    name: 'Breach on Due Date',
    description: "Breaches at the task's due date (moved into the schedule when it falls outside it).",
  },
];

const UNIT_MS: Record<string, number> = { days: DAY, hours: HOUR, minutes: 60_000 };

/** The `count`-th business day after the local date of `start`, at `hour` local time. */
function businessDayAt(
  engine: ScheduleEngine,
  input: RelativeInput,
  count: number,
  hour: number,
): number | null {
  const zone = engine.zoneFor(input.scheduleId, input.zone);
  let day = localDay(zone, input.start);
  let found = 0;
  for (let i = 0; i < 3660 && found < count; i++) {
    day++;
    if (engine.isBusinessDay(input.scheduleId, zone, day)) found++;
  }
  if (found < count) return null;
  return toUtc(zone, day * DAY + hour * HOUR);
}

function dueDateEnd(engine: ScheduleEngine, input: RelativeInput): number | null {
  const raw = input.current
    ? input.current.str(input.current.has('due_date') ? 'due_date' : 'task.due_date')
    : '';
  const due = parseGlideDateTime(raw)?.getTime();
  if (due === undefined || due < input.now) return input.start + 1000;
  return engine.nextInSchedule(input.scheduleId, input.zone, due);
}

/** Planned end for a relative duration definition (cmn_relative_duration record). */
export function relativeEnd(engine: ScheduleEngine, def: Rec, input: RelativeInput): number | null {
  const zone = engine.zoneFor(input.scheduleId, input.zone);
  const lateStart = localSecond(zone, input.start) > 10 * 3600;
  switch (def.str('name')) {
    case 'End of next business day':
      return businessDayAt(engine, input, 1, 17);
    case 'Next business day by 4pm':
      return businessDayAt(engine, input, 1, 16);
    case 'Two business days by 4pm':
      return businessDayAt(engine, input, lateStart ? 3 : 2, 16);
    case 'Three business days by 4pm':
      return businessDayAt(engine, input, lateStart ? 4 : 3, 16);
    case 'Breach on Due Date':
      return dueDateEnd(engine, input);
    default: {
      const amount = def.num('duration_amount') ?? 0;
      const unit = UNIT_MS[def.str('duration_unit')] ?? HOUR;
      return engine.add(input.scheduleId, input.zone, input.start, amount * unit);
    }
  }
}
