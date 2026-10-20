# Schedules and time configuration (cmn_schedule, cmn_schedule_span, time zones)

ResolvrNow spec, clean-room. Shared by the SLA engine (`sla.md`), On-Call Scheduling (`on-call.md`) and CMDB maintenance schedules (`cmdb.md`).

Conventions: **[Documented]** = stated in the public Brazil docs listed per section. **[Inferred]** = ResolvrNow decision or platform behaviour not stated in the corpus. All instants are stored in UTC as `YYYY-MM-DD HH:MM:SS`; all durations are integer milliseconds (ResolvrNow `glide_duration`). "Local" means wall-clock time in a named IANA zone.

Sources:
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/c_UseSchedules.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/r_DefaultSchedules.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/c_Holidays.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/c_ParentAndChildSchedules.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/r_ScheduleFields.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/r_ScheduleEntryFields.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/t_RepeatAMonthlySchedule.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/t_FifthInstanceOfADayOfTheWeek.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/r_TimeZones.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/t_SetASystemTimeZone.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/t_DefineARelativeDuration.html
- https://www.servicenow.com/docs/r/platform-administration/time-configuration/create-events-next-experience-ui.html

## 1. Tables

### 1.1 cmn_schedule (Schedule)

In the SDK model `cmn_schedule` extends `business_calendar` [Documented, SDK JSON]. ResolvrNow uses these columns:

| Column | Type | Source | Meaning |
|---|---|---|---|
| name | string(80) | own | Unique schedule name [Documented] |
| time_zone | string | inherited from business_calendar | IANA id (`America/New_York`) or empty / `floating` [Documented: Floating option] |
| type | string | own | Free label; system values listed in 1.4 [Documented] |
| parent | reference business_calendar | inherited | Parent schedule whose entries also apply to this one [Documented] |
| description | string(1000) | inherited | Free text |
| read_only | boolean, default false | own | Protects generated schedules (rota schedules) [Inferred use] |
| document, document_key | string, string(32) | own | Owner record (table name + sys_id), e.g. the rota a schedule belongs to [Inferred use] |
| sys_domain | domain_id | inherited | Domain separation [Documented] |

### 1.2 cmn_schedule_span (Schedule Entry)

Extends `business_calendar_span` in the SDK; ResolvrNow ignores the inherited `calendar/start/end` columns for schedule math (they belong to fiscal/business calendars) [Inferred].

| Column | Type | Default | Meaning |
|---|---|---|---|
| schedule | reference cmn_schedule | | Owning schedule; a span belongs to exactly one schedule [Documented] |
| name | string(80) | | Entry name [Documented] |
| type | choice | empty | empty = included time; `exclude` (label "Excluded"); `maintenance`, `blackout`, `appointment`, `meeting`, `call`, `time_off`, `on_call` [Documented labels; SDK choices: appointment, call, exclude, meeting, time_off] |
| show_as | choice | busy | `busy`, `free`, `tentative`, `on_call` [Documented labels; SDK has busy/free/tentative] |
| start_date_time | string | | First occurrence start, local wall clock, format `YYYYMMDDTHHMMSS` [Inferred format] |
| end_date_time | string | | First occurrence end (exclusive), same format |
| all_day | boolean | false | Occurrence covers whole local days [Documented] |
| repeat_type | string | empty | `daily`, `weekdays`, `weekends`, `weekMWF`, `weekTT`, `weekly`, `monthly`, `yearly`, `specific` [SDK choices] |
| repeat_count | string | `1` | Interval ("every N days/weeks/months/years") [Documented] |
| days_of_week | days_of_week | `1` | Digits `1`..`7`, 1 = Monday, 7 = Sunday, used by `weekly` [Inferred numbering] |
| monthly_type | choice | dom | `dom` day of month, `nth` day of week, `lwdom` last week day of month, `ldom` last day of month [SDK] |
| yearly_type | choice | doy | `doy` day of year, `float` floating [SDK] |
| float_week | choice | 1 | `1`..`4`, `last` [SDK] |
| float_day | choice | 1 | `1` Sunday .. `7` Saturday [SDK]. Note the different numbering from days_of_week |
| month | string | | `1`..`12` for yearly floating entries [Documented] |
| repeat_until | integer | 0 | Last date `YYYYMMDD`, inclusive; 0 or empty = forever [Documented: blank repeats indefinitely] |
| parent | reference cmn_schedule_span | | Set on an occurrence override (see 3.3) [Inferred] |
| override_start_date | integer | | `YYYYMMDD` of the parent occurrence being replaced [Inferred] |
| notes | string(1000) | | Description |

Input accepted by REST: `YYYYMMDDTHHMMSS`, `YYYYMMDD` (all-day) and `YYYY-MM-DD HH:MM:SS`; ResolvrNow normalises to `YYYYMMDDTHHMMSS` on write [Inferred].

### 1.3 cmn_other_schedule (Child Schedules related list)

| Column | Type | Meaning |
|---|---|---|
| schedule | reference cmn_schedule | Containing schedule |
| child_schedule | reference cmn_schedule | Schedule whose entries are pulled in |
| type | choice `include`/`exclude`, default include | include: child entries keep their own meaning; exclude: child included time is subtracted |

Concept and the rule "holiday schedules are added as a child with type Include" are **[Documented]**; the table and column names are **[Inferred]**.

### 1.4 Schedule `type` values

| Value | Meaning | Status |
|---|---|---|
| empty | Ordinary business-hours schedule | [Inferred] |
| `excluded` | Schedule used only to exclude time (holidays) | [Documented] |
| `maintenance` | Windows where changes are allowed; cannot coexist with blackout entries in the same schedule tree | [Documented] |
| `blackout` | Windows where changes are not allowed; cannot coexist with maintenance entries | [Documented] |
| `roster`, `on_call` | Rota schedules, displayed in the on-call calendar (see on-call.md) | [Documented: roster type] |

## 2. Time zones

| Rule | Status |
|---|---|
| All instants stored in UTC; display uses the user zone, else the system zone | [Documented] |
| System zone = property `glide.sys.default.tz`; if blank the platform falls back to `America/Los_Angeles`. ResolvrNow seeds the property with `UTC` at install and applies the documented fallback only when it is blank | [Documented fallback] [Inferred seed] |
| User zone = `sys_user.time_zone`; blank means system zone | [Documented] |
| Location-based IANA ids follow DST; abbreviations such as `GMT` do not | [Documented] |
| Schedule with a fixed `time_zone`: spans are wall-clock times in that zone, whoever evaluates them | [Documented] |
| Floating schedule (`time_zone` empty or `floating`): spans are wall-clock times in the zone supplied by the caller (SLA: `task_sla.timezone`; on-call: rota zone; UI: user zone) | [Documented semantics] [Inferred caller rules] |
| Local to UTC conversion: a non-existent local time (spring-forward gap) moves forward by the gap length; an ambiguous local time (fall-back overlap) takes the earlier (pre-transition) offset | [Inferred] |
| Durations are measured in real elapsed time between UTC instants, so a local 00:00-08:00 span lasts 7 h on a spring-forward night and 9 h on a fall-back night | [Inferred] |

## 3. Occurrence expansion

### 3.1 Per-span algorithm [Inferred unless noted]

```
occurrences(span, fromDate, toDate):            # local dates, inclusive
  d0 = date(span.start_date_time); t0 = time(span.start_date_time)
  if span.all_day: t0 = 00:00; L = (date(end) + 1 day) - d0   # whole days
  else:            L = localDateTime(end) - localDateTime(start)  # wall-clock length, may exceed 24h
  for d in max(d0, fromDate - ceil(L)) .. toDate:
     if span.repeat_until and d > span.repeat_until: break
     if occursOn(span, d, d0) and not suppressedByOverride(span, d):
        yield [d + t0, d + t0 + L)              # local wall clock, end exclusive
```

### 3.2 occursOn(span, d, d0)

| repeat_type | Occurs on local date d (d >= d0) when |
|---|---|
| empty | d == d0 |
| daily | daysBetween(d0, d) % N == 0, N = repeat_count |
| weekdays | weekday(d) in Mon..Fri [Documented label] |
| weekends | weekday(d) in Sat, Sun |
| weekMWF / weekTT | Mon, Wed, Fri / Tue, Thu |
| weekly | weekday(d) in days_of_week and weeksBetween(monday(d0), monday(d)) % N == 0 |
| monthly, dom | dayOfMonth(d) == dayOfMonth(d0) and monthsBetween(d0, d) % N == 0; months without that day are skipped |
| monthly, nth | weekday(d) == weekday(d0), monthsBetween % N == 0, and d is the n-th such weekday (n rules below) |
| monthly, lwdom | weekday(d) == weekday(d0) and d is the last such weekday of its month [Documented label] |
| monthly, ldom | d is the last day of its month [Documented label] |
| yearly, doy | month/day equal to d0 (29 Feb only in leap years), yearsBetween % N == 0 |
| yearly, float | month(d) == month, weekday(d) == float_day, d is the float_week-th such weekday (or the last one) |
| specific | d == d0 only; extra dates come from override children |

Ordinal n for `monthly`/`nth` [Documented behaviour, property names Documented]:
- `glide.schedules.repeat_nth = day` (default): n = ceil(dayOfMonth(d0) / 7), the occurrence index of that weekday. Example: 5 Nov 2012 (first Monday) repeats 3 Dec 2012, 7 Jan 2013.
- `glide.schedules.repeat_nth = week`: n = week-of-month row of d0 (weeks start Sunday [Inferred]). Example: 5 Nov 2012 is in week 2, repeats on the second Monday: 10 Dec 2012, 14 Jan 2013.
- When n = 5 and a month has only four such weekdays, `glide.schedules.fifth` decides: `last` (default) uses the fourth/last one; `next` uses the first such weekday of the following month; `strict` skips the month. Valid only with `repeat_nth = day`. Example from 29 Nov 2012 (fifth Thursday): last gives 27 Dec 2012, next gives 3 Jan 2013, strict skips December; all three give 31 Jan 2013.

### 3.3 Occurrence overrides [Inferred]
Editing one occurrence of a repeating entry creates a span with `parent` = the repeating span and `override_start_date` = that occurrence date. The parent occurrence on that date is suppressed; the child span's own start/end define the replacement. A child whose start is empty deletes the occurrence.

## 4. Effective schedule

```
entries(S) = own spans of S
           U entries(S.parent)                      # Parent field: parent entries apply to S [Documented]
           U for each cmn_other_schedule L where L.schedule == S:
                 include -> entries(L.child_schedule) unchanged          [Documented include]
                 exclude -> included entries of the child, re-typed as exclusions [Inferred]
(guard against cycles: a schedule already on the path contributes nothing)
```

Classification for time math [Inferred]: a span is an **exclusion** when its type is `exclude` (or it arrived through an exclude link); every other type is **included time**. `show_as` is informational for SLA math.

Instant `t` is in schedule S (zone Z) iff some included occurrence covers `t` and no exclusion occurrence covers `t` (exclusion always wins) [Documented: Excluded removes time from SLA counts].

Validation:
- A schedule whose effective entries contain no included span is reported "no active entries" (warning, save allowed) [Documented].
- A parent schedule consisting only of exclusions is invalid [Documented]; ResolvrNow rejects saving `parent` to such a schedule.
- Maintenance and blackout entries cannot coexist in one schedule tree (own, parent, children); reject the insert that creates the conflict [Documented].

## 5. Algorithms (engine API)

```ts
interface ScheduleCalc {
  intervals(scheduleId: string | null, zone: string, from: Date, to: Date): Array<[Date, Date]>; // sorted, disjoint, UTC
  isInSchedule(scheduleId, zone, t: Date): boolean;
  duration(scheduleId, zone, a: Date, b: Date): number;       // ms of schedule time in [a, b)
  add(scheduleId, zone, a: Date, ms: number): Date | null;     // instant where ms of schedule time have elapsed after a
  nextInSchedule(scheduleId, zone, t: Date): Date | null;      // t if inside, else start of next interval
}
```

Rules [Inferred]:
1. `scheduleId == null` means 24x7: `duration = b - a`, `add = a + ms`, always in schedule.
2. `intervals`: expand occurrences for local dates from `localDate(from) - 2` to `localDate(to) + 2`, convert both ends to UTC (section 2), union the included ones, subtract exclusions, merge touching intervals, clip to `[from, to)`.
3. `duration(a, b)` = sum of `|interval ∩ [a, b)|`; 0 when `b <= a`.
4. `add(a, ms)`: if `ms <= 0` return `a`. Walk `intervals` forward from `a` in 31-day windows, consuming time until `ms` is exhausted; the answer is `intervalStart + remaining`. If the end of an interval is reached exactly, return that interval end (not the next interval start). Search at most 4 x `com.snc.sla.maximum_duration` days ahead (default 1095, about 12 years); if `ms` is still not consumed, return `null` (schedule has no usable time).
5. Results are exact to the millisecond; seed data and tests use whole seconds.
6. Cache expanded intervals per (schedule, zone, local year); invalidate on any insert/update/delete of `cmn_schedule`, `cmn_schedule_span` or `cmn_other_schedule` in the tree.

## 6. Seeded schedules

| Name | Definition | Status |
|---|---|---|
| 8-5 weekdays | span 08:00:00 to 17:00:00, repeat `weekdays`, floating zone | [Documented name and days] [Inferred times and zone] |
| 8-5 weekdays excluding holidays | same span plus child include link to U.S. Holidays | [Documented] |
| U.S. Holidays | 12 all-day `exclude` spans repeating yearly (fixed `doy` or `float`): New Year's Day, MLK Day, Presidents' Day, Memorial Day (last Mon May), Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving, Day after Thanksgiving (as `specific`-year spans), Christmas Day | [Documented count 12] [Inferred list] |
| Weekends | Saturday 00:00 for two days, repeat weekly on Saturday | [Documented] |

## 7. Relative durations (cmn_relative_duration)

Columns per SDK: `name`, `description`, `duration_amount` (integer), `duration_unit` (`days`/`hours`/`minutes`), `script`, `active`. The platform evaluates `script` with a DurationCalculator; ResolvrNow does not run stored JavaScript, so it ships built-in TypeScript calculators keyed by name and a declarative fallback [Inferred].

| Name | Result from start `s` (local to the SLA zone, business days per the SLA schedule) | Status |
|---|---|---|
| End of next business day | next business day after date(s), at 17:00 | [Documented: 17:00 hard-coded] |
| Next business day by 4pm | next business day after date(s), at 16:00 | [Documented name] [Inferred rule] |
| Two business days by 4pm | 2 business days after date(s) at 16:00; one more day when time(s) > 10:00 | [Documented: extra day after 10am] |
| Three business days by 4pm | as above with 3 days | [Inferred] |
| Breach on Due Date | task `due_date`; see sla.md 7.4 | [Documented] |
| any other active record | `add(schedule, zone, s, duration_amount x unit)` where 1 day = 24 h of schedule time | [Inferred] |

"Business day" = a local date containing at least one included interval of the schedule; with no schedule every date is a business day [Documented: durations default to 24x7].

## 8. Properties

| Property | Default | Use |
|---|---|---|
| glide.sys.default.tz | blank (America/Los_Angeles); ResolvrNow seeds `UTC` | System zone [Documented] |
| glide.schedules.repeat_nth | day | Monthly nth computation [Documented] |
| glide.schedules.fifth | last | Fifth-weekday handling: last, next, strict [Documented] |

## 9. Acceptance tests

Fixtures unless stated: zone UTC; schedule **W** = "8-5 weekdays" (08:00-17:00, weekdays). 3 Mar 2025 is a Monday.

1. Given W, When `isInSchedule` at Mon 2025-03-03 08:00:00, Then true; at 17:00:00 false (end exclusive); at Sat 2025-03-08 10:00 false.
2. Given W, When `duration(Mon 07:00, Mon 18:00)`, Then 9 h.
3. Given W, When `duration(Fri 2025-03-07 16:00, Mon 2025-03-10 09:00)`, Then 2 h.
4. Given W, When `add(Fri 2025-03-07 16:00, 2 h)`, Then Mon 2025-03-10 09:00.
5. Given W, When `add(Sat 2025-03-08 10:00, 1 h)`, Then Mon 2025-03-10 09:00.
6. Given W, When `add(Mon 09:00, 8 h)`, Then Mon 17:00 (interval end, not Tue 08:00).
7. Given W, When `add(Mon 08:00, 24 h)`, Then Wed 2025-03-05 17:00 (one "day" is 24 h of schedule time).
8. Given W, When `add(t, 0)`, Then t, even when t is outside the schedule; `nextInSchedule(Sat 10:00)` = Mon 08:00.
9. Given a span 22:00 to 06:00 (next day) repeating daily, When `duration(Mon 20:00, Tue 08:00)`, Then 8 h.
10. Given W plus an all-day `exclude` span on Tue 2025-03-04, When `duration(Mon 08:00, Wed 17:00)`, Then 18 h, and `add(Mon 16:00, 8 h)` = Wed 2025-03-05 15:00.
11. Given "8-5 weekdays excluding holidays" with Independence Day (4 Jul, yearly `doy`), When `isInSchedule(Fri 2025-07-04 10:00)`, Then false; Thu 2025-07-03 10:00 true.
12. Given schedule A (Mon-Fri 08-12) with `parent` B (Mon-Fri 13-17), When `duration(Mon 00:00, Tue 00:00)` on A, Then 8 h; on B alone 4 h.
13. Given W linked to child "Weekends" with type `exclude`, When evaluating Sat, Then no time; weekday results unchanged.
14. Given a weekly span on Mon and Wed (`days_of_week` = `13`), `repeat_count` 2, starting Mon 2025-03-03, Then occurrences fall on 3, 5, 17, 19 Mar and not on 10 or 12 Mar.
15. Given a monthly `dom` span starting Fri 2025-01-31, Then February 2025 has no occurrence and the next is Mon 2025-03-31.
16. Given a monthly `nth` span starting Mon 2012-11-05, When `repeat_nth = day`, Then next occurrences are 2012-12-03 and 2013-01-07; When `repeat_nth = week`, Then 2012-12-10 and 2013-01-14.
17. Given a monthly `nth` span starting Thu 2012-11-29, Then December 2012 gives 2012-12-27 with `fifth = last`, 2013-01-03 with `next`, nothing with `strict`; all give 2013-01-31.
18. Given monthly `lwdom` starting Fri 2025-03-28, Then the April occurrence is Fri 2025-04-25; monthly `ldom` gives 2025-02-28 for February.
19. Given yearly `float` with month 11, float_week 4, float_day 5 (Thursday), Then the 2025 occurrence is 2025-11-27.
20. Given `repeat_until` = 20250305 on a daily span starting 2025-03-03, Then occurrences are 3, 4 and 5 March only.
21. Given floating W evaluated in America/New_York, When `isInSchedule(2025-03-03 12:00Z)`, Then false (07:00 local) and at 13:00Z true; Given W with fixed zone Europe/Paris evaluated with caller zone America/New_York, Then the Paris wall clock is used (08:00 Paris = 07:00Z in March).
22. Given a daily 00:00-08:00 floating span in America/New_York, Then `duration` over Sun 2025-03-09 is 7 h and over Sun 2025-11-02 is 9 h.
23. Given a span starting 02:30 local on 2025-03-09 in America/New_York, Then its occurrence starts at 03:00 EDT (07:00Z).
24. Given floating W in America/New_York, When `add(Fri 2025-03-07 21:00Z, 4 h)`, Then Mon 2025-03-10 15:00Z (1 h on Friday EST, 3 h on Monday EDT).
25. Given an override child span for the 2025-03-05 occurrence of W moved to 12:00-14:00, Then `duration` on Wed 2025-03-05 is 2 h.
26. Given a schedule with only exclusion entries, When `add(t, 1 h)`, Then null and the schedule form shows the no-active-entries warning; ResolvrNow rejects using it as a `parent`.
27. Given a schedule tree containing a maintenance entry, When a blackout entry is inserted into the same tree, Then the insert is rejected.
