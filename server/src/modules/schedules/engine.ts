import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { isSysId, parseGlideDateTime, toGlideDateTime } from '../../engine/util.js';
import type { ScheduleService } from '../contracts.js';
import { occurrences, type RepeatOptions, type SpanDef, spanFromRecord } from './spans.js';
import { DAY, isValidZone, localDay, toUtc } from './time.js';

/** Half-open UTC interval `[start, end)` in ms. */
export type Interval = [number, number];

/** An entry of a schedule's effective set (own, parent and child-schedule entries). */
export interface ScheduleEntry {
  span: SpanDef;
  exclude: boolean;
  /** Fixed zone of the schedule owning the entry; null = floating (evaluation zone). */
  zone: string | null;
  /** Dates of this entry's occurrences replaced by override entries. */
  suppressed: Set<number>;
}

interface ScheduleRow {
  id: string;
  zone: string | null;
  parent: string | null;
}

const MAX_CACHE = 4000;

export function mergeIntervals(list: Interval[]): Interval[] {
  if (list.length < 2) return list.slice();
  const sorted = list.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const [s, e] = sorted[i];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** `a` minus `b`; both sorted and disjoint. */
export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  if (!b.length) return a.slice();
  const out: Interval[] = [];
  let j = 0;
  for (const [s0, e] of a) {
    let s = s0;
    while (j < b.length && b[j][1] <= s) j++;
    let k = j;
    while (k < b.length && b[k][0] < e) {
      if (b[k][0] > s) out.push([s, b[k][0]]);
      s = Math.max(s, b[k][1]);
      if (s >= e) break;
      k++;
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}

export function clipIntervals(list: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const [s, e] of list) {
    if (e <= from || s >= to) continue;
    out.push([Math.max(s, from), Math.min(e, to)]);
  }
  return out;
}

function yearStart(year: number): number {
  return Date.UTC(year, 0, 1);
}

function yearOf(t: number): number {
  return new Date(t).getUTCFullYear();
}

const ms = (glide: string): number => parseGlideDateTime(glide)?.getTime() ?? Number.NaN;

/**
 * Business-time calculations over cmn_schedule definitions (schedules.md section 5).
 * Expanded intervals are cached per (schedule, zone, UTC year) and dropped whenever a
 * schedule, entry or child-schedule link changes.
 */
export class ScheduleEngine implements ScheduleService {
  private entryCache = new Map<string, ScheduleEntry[]>();
  private rowCache = new Map<string, ScheduleRow | null>();
  private yearCache = new Map<string, Interval[]>();
  private spanFilters: ((span: Rec) => boolean)[] = [];

  constructor(private platform: Platform) {}

  invalidate(): void {
    this.entryCache.clear();
    this.rowCache.clear();
    this.yearCache.clear();
  }

  /** Lets other modules hide entries that are not schedule time (e.g. on-call time off). */
  addSpanFilter(keep: (span: Rec) => boolean): void {
    this.spanFilters.push(keep);
    this.invalidate();
  }

  // ------------------------------------------------------------------ zones

  systemZone(): string {
    const z = this.platform.properties.get('glide.sys.default.tz') ?? '';
    return isValidZone(z) ? z : 'America/Los_Angeles';
  }

  /** The schedule's own zone, or null when it is floating. */
  fixedZone(scheduleId: string | null): string | null {
    if (!scheduleId) return null;
    const z = this.row(scheduleId)?.zone ?? null;
    return isValidZone(z) ? z : null;
  }

  /** Zone used to read a schedule's wall-clock entries for a caller. */
  zoneFor(scheduleId: string | null, callerZone?: string | null): string {
    return this.fixedZone(scheduleId) ?? (isValidZone(callerZone) ? callerZone : this.systemZone());
  }

  private repeatOptions(): RepeatOptions {
    const nth = this.platform.properties.get('glide.schedules.repeat_nth') === 'week' ? 'week' : 'day';
    const f = this.platform.properties.get('glide.schedules.fifth');
    return { nth, fifth: f === 'next' || f === 'strict' ? f : 'last' };
  }

  // ------------------------------------------------------------------ loading

  private row(id: string): ScheduleRow | null {
    if (this.rowCache.has(id)) return this.rowCache.get(id)!;
    let out: ScheduleRow | null = null;
    if (isSysId(id) && this.platform.registry.has('cmn_schedule')) {
      const r = this.platform.db.get<{ sys_id: string; time_zone: string | null; parent: string | null }>(
        `SELECT "sys_id","time_zone","parent" FROM "cmn_schedule" WHERE "sys_id" = ?`,
        [id],
      );
      if (r) out = { id: r.sys_id, zone: r.time_zone || null, parent: r.parent || null };
    }
    this.rowCache.set(id, out);
    return out;
  }

  private ownSpans(scheduleId: string): Rec[] {
    const ctx = this.platform.systemContext();
    return ctx
      .query('cmn_schedule_span', { query: `schedule=${scheduleId}` })
      .filter((s) => this.spanFilters.every((keep) => keep(s)));
  }

  /** Effective entries: own, parent's and child schedules' (schedules.md section 4). */
  entries(scheduleId: string): ScheduleEntry[] {
    const hit = this.entryCache.get(scheduleId);
    if (hit) return hit;
    const out = this.collect(scheduleId, new Set());
    this.entryCache.set(scheduleId, out);
    return out;
  }

  private collect(scheduleId: string, path: Set<string>): ScheduleEntry[] {
    if (path.has(scheduleId)) return [];
    const row = this.row(scheduleId);
    if (!row) return [];
    const inner = new Set(path).add(scheduleId);
    const zone = isValidZone(row.zone) ? row.zone : null;
    const spans = this.ownSpans(scheduleId).map(spanFromRecord);
    const suppressed = new Map<string, Set<number>>();
    for (const s of spans) {
      if (!s.parent || s.overrideDay === null) continue;
      const set = suppressed.get(s.parent) ?? new Set<number>();
      set.add(s.overrideDay);
      suppressed.set(s.parent, set);
    }
    const out: ScheduleEntry[] = spans
      .filter((s) => s.start)
      .map((span) => ({
        span,
        exclude: span.type === 'exclude',
        zone,
        suppressed: suppressed.get(span.id) ?? new Set(),
      }));
    if (row.parent) out.push(...this.collect(row.parent, inner));
    if (this.platform.registry.has('cmn_other_schedule')) {
      const links = this.platform.db.all<{ child_schedule: string; type: string | null }>(
        `SELECT "child_schedule","type" FROM "cmn_other_schedule" WHERE "schedule" = ? ORDER BY rowid`,
        [scheduleId],
      );
      for (const l of links) {
        const child = this.collect(l.child_schedule, inner);
        if (l.type === 'exclude')
          out.push(...child.filter((e) => !e.exclude).map((e) => ({ ...e, exclude: true })));
        else out.push(...child);
      }
    }
    return out;
  }

  /** True when the effective entries contain at least one included (non-excluded) entry. */
  hasIncludedTime(scheduleId: string): boolean {
    return this.entries(scheduleId).some((e) => !e.exclude);
  }

  // ------------------------------------------------------------------ expansion

  /** UTC occurrences of one entry record (no exclusions applied), clipped to `[from, to)`. */
  spanIntervals(span: Rec, zone: string, from: number, to: number): Interval[] {
    const def = spanFromRecord(span);
    const z = this.fixedZone(span.str('schedule')) ?? zone;
    const out: Interval[] = [];
    const fromDay = localDay(z, from) - 2;
    const toDay = localDay(z, to) + 2;
    for (const [ls, le] of occurrences(def, fromDay, toDay, undefined, this.repeatOptions())) {
      const s = toUtc(z, ls);
      const e = toUtc(z, le);
      if (e > s) out.push([s, e]);
    }
    return clipIntervals(mergeIntervals(out), from, to);
  }

  private yearIntervals(scheduleId: string, zone: string, year: number): Interval[] {
    const opts = this.repeatOptions();
    const key = `${scheduleId}|${zone}|${year}|${opts.nth}|${opts.fifth}`;
    const hit = this.yearCache.get(key);
    if (hit) return hit;
    const from = yearStart(year);
    const to = yearStart(year + 1);
    const include: Interval[] = [];
    const exclude: Interval[] = [];
    for (const e of this.entries(scheduleId)) {
      const z = e.zone ?? zone;
      const fromDay = Math.floor(from / DAY) - 2;
      const toDay = Math.floor(to / DAY) + 2;
      for (const [ls, le] of occurrences(e.span, fromDay, toDay, e.suppressed, opts)) {
        const s = toUtc(z, ls);
        const en = toUtc(z, le);
        if (en > s) (e.exclude ? exclude : include).push([s, en]);
      }
    }
    const result = clipIntervals(
      subtractIntervals(mergeIntervals(include), mergeIntervals(exclude)),
      from,
      to,
    );
    if (this.yearCache.size > MAX_CACHE) this.yearCache.clear();
    this.yearCache.set(key, result);
    return result;
  }

  /** Sorted, disjoint schedule intervals within `[from, to)`; null schedule = 24x7. */
  intervals(
    scheduleId: string | null,
    callerZone: string | null | undefined,
    from: number,
    to: number,
  ): Interval[] {
    if (to <= from) return [];
    if (!scheduleId) return [[from, to]];
    const zone = this.zoneFor(scheduleId, callerZone);
    const all: Interval[] = [];
    for (let y = yearOf(from); y <= yearOf(to - 1); y++) all.push(...this.yearIntervals(scheduleId, zone, y));
    return clipIntervals(mergeIntervals(all), from, to);
  }

  /** Milliseconds of schedule time in `[a, b)`. */
  duration(scheduleId: string | null, callerZone: string | null | undefined, a: number, b: number): number {
    if (b <= a) return 0;
    if (!scheduleId) return b - a;
    return this.intervals(scheduleId, callerZone, a, b).reduce((sum, [s, e]) => sum + (e - s), 0);
  }

  private horizonMs(): number {
    const days = this.platform.properties.getNumber('com.snc.sla.maximum_duration', 1095);
    return 4 * Math.max(1, days) * DAY;
  }

  /**
   * Instant at which `ms` of schedule time has elapsed after `a`. Reaching the exact end
   * of an interval returns that end. Null when the schedule has no usable time.
   */
  add(
    scheduleId: string | null,
    callerZone: string | null | undefined,
    a: number,
    ms: number,
  ): number | null {
    if (ms <= 0) return a;
    if (!scheduleId) return a + ms;
    if (!this.hasIncludedTime(scheduleId)) return null;
    const zone = this.zoneFor(scheduleId, callerZone);
    const limit = a + this.horizonMs();
    let remaining = ms;
    for (let y = yearOf(a); yearStart(y) < limit; y++) {
      for (const [s, e] of this.yearIntervals(scheduleId, zone, y)) {
        if (e <= a) continue;
        const seg = Math.max(s, a);
        const avail = e - seg;
        if (remaining <= avail) return seg + remaining;
        remaining -= avail;
      }
    }
    return null;
  }

  /** `t` when inside the schedule, otherwise the start of the next interval (null if none). */
  nextInSchedule(scheduleId: string | null, callerZone: string | null | undefined, t: number): number | null {
    if (!scheduleId) return t;
    if (!this.hasIncludedTime(scheduleId)) return null;
    const zone = this.zoneFor(scheduleId, callerZone);
    const limit = t + this.horizonMs();
    for (let y = yearOf(t); yearStart(y) < limit; y++) {
      for (const [s, e] of this.yearIntervals(scheduleId, zone, y)) {
        if (e > t) return Math.max(s, t);
      }
    }
    return null;
  }

  contains(scheduleId: string | null, callerZone: string | null | undefined, t: number): boolean {
    if (!scheduleId) return true;
    const zone = this.zoneFor(scheduleId, callerZone);
    return this.yearIntervals(scheduleId, zone, yearOf(t)).some(([s, e]) => s <= t && t < e);
  }

  /** Interval of schedule time containing `t`, if any. */
  intervalAt(scheduleId: string | null, callerZone: string | null | undefined, t: number): Interval | null {
    if (!scheduleId) return null;
    const zone = this.zoneFor(scheduleId, callerZone);
    const y = yearOf(t);
    const list = mergeIntervals([
      ...this.yearIntervals(scheduleId, zone, y - 1),
      ...this.yearIntervals(scheduleId, zone, y),
      ...this.yearIntervals(scheduleId, zone, y + 1),
    ]);
    return list.find(([s, e]) => s <= t && t < e) ?? null;
  }

  /** A local date is a business day when it contains included schedule time. */
  isBusinessDay(scheduleId: string | null, callerZone: string | null | undefined, day: number): boolean {
    if (!scheduleId) return true;
    const zone = this.zoneFor(scheduleId, callerZone);
    return this.duration(scheduleId, zone, toUtc(zone, day * DAY), toUtc(zone, (day + 1) * DAY)) > 0;
  }

  // ------------------------------------------------------------------ ScheduleService

  businessMs(
    _ctx: Context,
    scheduleId: string | null,
    start: string,
    end: string,
    timeZone?: string | null,
  ): number {
    const a = ms(start);
    const b = ms(end);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return this.duration(scheduleId || null, timeZone, a, b);
  }

  /** Returns '' when the schedule never accumulates enough time. */
  addBusinessMs(
    _ctx: Context,
    scheduleId: string | null,
    start: string,
    msToAdd: number,
    timeZone?: string | null,
  ): string {
    const a = ms(start);
    if (!Number.isFinite(a)) return '';
    const r = this.add(scheduleId || null, timeZone, a, msToAdd);
    return r === null ? '' : toGlideDateTime(new Date(r));
  }

  isInSchedule(_ctx: Context, scheduleId: string | null, at: string, timeZone?: string | null): boolean {
    const t = ms(at);
    if (!Number.isFinite(t)) return false;
    return this.contains(scheduleId || null, timeZone, t);
  }
}

export function scheduleEngine(platform: Platform): ScheduleEngine | undefined {
  return platform.services.get('schedules') as ScheduleEngine | undefined;
}
