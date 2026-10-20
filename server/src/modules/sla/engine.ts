import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { MatchSubject } from '../../engine/query/matcher.js';
import { Rec } from '../../engine/record.js';
import { clock, parseGlideDateTime, quoteIdent, toGlideDateTime } from '../../engine/util.js';
import type { SlaService } from '../contracts.js';
import { type ScheduleEngine, scheduleEngine } from '../schedules/engine.js';
import { relativeEnd } from '../schedules/relative.js';
import { isValidZone } from '../schedules/time.js';
import { CONDITION_CLASSES, SlaConditions, taskSubject } from './conditions.js';
import { type TaskVersion, taskVersions } from './history.js';
import { raiseThreshold } from './notify.js';

export const SLA_PROPS = {
  async: 'com.snc.sla.engine.async',
  compat: 'com.snc.sla.compatibility.breach',
  conditionClass: 'com.snc.sla.default_conditionclass',
  pctLimit: 'com.snc.sla.calculation.percentage',
  maxDuration: 'com.snc.sla.maximum_duration',
  workflowForBreached: 'com.snc.sla.workflow.run_for_breached',
  flowForBreached: 'com.snc.sla.flow.run_for_breached',
  plannedAfterBreach: 'com.snc.sla.calculate_planned_end_time_after_breach',
  useTimeLeft: 'com.snc.sla.calculation.use_time_left',
  calcOnDisplay: 'glide.sla.calculate_on_display',
  alwaysBusiness: 'com.snc.sla.always_populate_business_fields',
  repair: 'com.snc.sla.repair.enabled',
  legacy: 'resolvr.sla.sync_legacy_task_fields',
  notifications: 'resolvr.sla.notifications',
} as const;

/** Stages in which a task SLA is timing (breached only exists in compatibility mode). */
const RUNNING = new Set(['in_progress', 'breached']);
export const THRESHOLDS = [50, 75, 100];

export interface RunOptions {
  now: number;
  /** The task was just inserted: every field counts as changed. */
  insert: boolean;
  /** Repair replay: no timers, events or task writes. */
  replay?: boolean;
}

/** Window of an update job relative to now, on planned_end_time. */
export interface JobWindow {
  from: number;
  to: number;
}

const msOf = (v: string): number | null => (v ? (parseGlideDateTime(v)?.getTime() ?? null) : null);
const glide = (t: number): string => toGlideDateTime(new Date(t));

/** Percentage rounded half-up to two decimals, computed on integers to avoid float drift. */
export function percent(elapsed: number, target: number): number {
  const num = Math.round(elapsed) * 10000;
  const q = Math.floor(num / target);
  const r = num - q * target;
  return (2 * r >= target ? q + 1 : q) / 100;
}

export function isRelative(def: Rec | null): boolean {
  return !!def?.str('duration_type');
}

/**
 * The SLA engine (sla.md sections 4 to 10): attaches task SLAs from definitions, walks
 * them through pause, resume, completion, reset and cancellation, keeps elapsed time and
 * breach data current, and drives the 50/75/100 % timers.
 */
export class SlaEngine implements SlaService {
  private engineContexts = new WeakSet<Context>();
  private refreshing = false;

  constructor(private platform: Platform) {}

  private get schedules(): ScheduleEngine | undefined {
    return scheduleEngine(this.platform);
  }

  private flag(name: string, fallback = false): boolean {
    return this.platform.properties.getBool(name, fallback);
  }

  /** Context used for the engine's own writes: no ACL checks, recognised by the field guard. */
  engineContext(ctx: Context): Context {
    const e = ctx.derive({ acl: false });
    this.engineContexts.add(e);
    return e;
  }

  isEngineContext(ctx: Context): boolean {
    return this.engineContexts.has(ctx);
  }

  // ------------------------------------------------------------------ entry points

  /** Hook for task inserts and updates ("Run SLAs"). */
  onTaskWrite(task: Rec, previous: Rec | null, ctx: Context): void {
    if (!ctx.workflow) return;
    const now = clock.now().getTime();
    const insert = previous === null;
    if (!this.flag(SLA_PROPS.async)) {
      this.run(ctx, task, previous, { now, insert });
      return;
    }
    const table = task.className;
    const id = task.sysId;
    const data = { ...task.data };
    const prevData = previous ? { ...previous.data } : null;
    const user = ctx.user;
    this.platform.enqueueAsync(`sla:${id}:${now}`, () => {
      const actx = this.platform.contextFor(user);
      if (!actx.loadRaw(table, id)) return;
      const meta = this.platform.registry.table(table);
      const cur = new Rec(actx, meta, { ...data }, prevData ? { ...prevData } : null);
      const prev = prevData ? new Rec(actx, meta, { ...prevData }, { ...prevData }) : null;
      this.run(actx, cur, prev, { now, insert });
    });
  }

  process(ctx: Context, task: Rec, previous: Rec | null): void {
    this.run(ctx, task, previous, { now: clock.now().getTime(), insert: previous === null && task.isNew() });
  }

  /** Fires due percentage timers and recalculates every running task SLA. */
  updateTimers(ctx: Context): number {
    const ectx = this.engineContext(ctx);
    const now = clock.now().getTime();
    let n = this.fireDueTimers(ectx, now);
    for (const ts of this.selectRunning(ectx, null, now)) {
      this.recalc(ectx, ts, now);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ processing (6.1)

  run(ctx: Context, task: Rec, previous: Rec | null, opts: RunOptions): void {
    const ectx = this.engineContext(ctx);
    const defs = ectx.query('contract_sla', { query: `active=true^collection=${task.className}` });
    const open = this.openTaskSlas(ectx, task.sysId);
    if (!defs.length && !open.length) return;
    const subject = taskSubject(task, previous, opts.insert, this.platform.registry);
    const cache = new Map<string, Rec | null>(defs.map((d) => [d.sysId, d]));
    const defOf = (id: string): Rec | null => {
      if (!cache.has(id)) cache.set(id, ectx.get('contract_sla', id));
      return cache.get(id) ?? null;
    };
    const queue = [...open];
    const fresh = new Set<string>();
    for (const def of defs) {
      if (open.some((ts) => ts.str('sla') === def.sysId)) continue;
      if (!this.conditions(ectx, def, subject).attach()) continue;
      const ts = this.attach(ectx, def, task, opts);
      queue.push(ts);
      fresh.add(ts.sysId);
    }
    while (queue.length) {
      const ts = queue.shift()!;
      const def = defOf(ts.str('sla'));
      if (!def) {
        this.recalc(ectx, ts, opts.now, opts, null);
        continue;
      }
      const r = this.conditions(ectx, def, subject);
      const stage = ts.str('stage');
      if (r.complete()) this.finish(ectx, ts, def, 'complete', opts);
      else if (!fresh.has(ts.sysId) && r.reattach()) {
        this.finish(ectx, ts, def, def.str('reset_action') === 'complete' ? 'complete' : 'cancel', opts);
        const next = this.attach(ectx, def, task, opts);
        queue.push(next);
        fresh.add(next.sysId);
      } else if (r.cancel()) this.finish(ectx, ts, def, 'cancel', opts);
      else if (RUNNING.has(stage) && !isRelative(def) && r.pause()) this.pause(ectx, ts, def, opts);
      else if (stage === 'paused' && r.resume()) this.resume(ectx, ts, def, opts);
      else this.recalc(ectx, ts, opts.now, opts, def);
    }
    if (!opts.replay) this.syncLegacyFields(ectx, task.sysId);
  }

  private openTaskSlas(ctx: Context, taskId: string): Rec[] {
    return ctx.query('task_sla', { query: `task=${taskId}^active=true^stageINin_progress,paused,breached` });
  }

  private conditions(ctx: Context, def: Rec, subject: MatchSubject): SlaConditions {
    let cls = '';
    const ref = def.str('condition_class');
    if (ref) {
      cls =
        ctx.platform.db.get<{ name: string }>(
          `SELECT "name" FROM "sla_condition_class" WHERE "sys_id" = ? AND ("active" IS NULL OR "active" = 1)`,
          [ref],
        )?.name ?? '';
    }
    if (!cls) cls = this.platform.properties.get(SLA_PROPS.conditionClass) || CONDITION_CLASSES.base;
    return new SlaConditions(def, subject, ctx.env, cls === CONDITION_CLASSES.simple);
  }

  // ------------------------------------------------------------------ transitions (6.2 - 6.4)

  /** Zone from the definition's time zone source; system zone when empty or invalid. */
  zoneFor(def: Rec, task: Rec): string {
    const source = def.str('timezone_source') || 'task.caller_id.time_zone';
    const z =
      source === 'sla.timezone'
        ? def.str('timezone')
        : source.startsWith('task.')
          ? task.str(source.slice(5))
          : '';
    if (isValidZone(z)) return z;
    return this.schedules?.systemZone() ?? 'UTC';
  }

  scheduleFor(def: Rec, task: Rec): string | null {
    switch (def.str('schedule_source') || 'sla_definition') {
      case 'no_schedule':
        return null;
      case 'task_field': {
        const field = def.str('schedule_source_field');
        return field ? task.str(field) || null : null;
      }
      default:
        return def.str('schedule') || null;
    }
  }

  private attach(ectx: Context, def: Rec, task: Rec, opts: RunOptions): Rec {
    const now = opts.now;
    const scheduleId = this.scheduleFor(def, task);
    const zone = this.zoneFor(def, task);
    const startField = def.bool('retroactive') ? def.str('set_start_to') : '';
    const start = (startField ? msOf(task.str(startField)) : null) ?? now;
    const ts = ectx.newRecord('task_sla');
    ts.setRaw('task', task.sysId)
      .setRaw('sla', def.sysId)
      .setRaw('stage', 'in_progress')
      .setRaw('active', 1)
      .setRaw('start_time', glide(start))
      .setRaw('end_time', null)
      .setRaw('pause_time', null)
      .setRaw('pause_duration', 0)
      .setRaw('business_pause_duration', 0)
      .setRaw('has_breached', 0)
      .setRaw('planned_end_time', null)
      .setRaw('schedule', scheduleId)
      .setRaw('timezone', zone);
    if (isRelative(def))
      ts.setRaw('planned_end_time', this.relativePlannedEnd(ectx, def, task, ts, start, now));
    else if (startField && def.bool('retroactive_pause') && start < now)
      this.replayPauses(ectx, ts, def, task, start, now);
    this.compute(ts, def, now);
    ts.setRaw('original_breach_time', ts.get('planned_end_time'));
    ectx.insert(ts);
    if (!opts.replay) this.startTimers(ectx, ts, def, now);
    return ts;
  }

  private relativePlannedEnd(
    ctx: Context,
    def: Rec,
    task: Rec,
    ts: Rec,
    start: number,
    now: number,
  ): string | null {
    const engine = this.schedules;
    const rd = ctx.get('cmn_relative_duration', def.str('duration_type'));
    if (!engine || !rd) return null;
    const current = def.str('relative_duration_works_on') === 'SLA record' ? ts : task;
    const end = relativeEnd(engine, rd, {
      start,
      now,
      scheduleId: ts.str('schedule') || null,
      zone: ts.str('timezone') || null,
      current,
    });
    return end === null ? null : glide(end);
  }

  /** Retroactive pause: replays the audited task history between the retroactive start and now. */
  private replayPauses(ctx: Context, ts: Rec, def: Rec, task: Rec, start: number, now: number): void {
    const versions = taskVersions(ctx, task).filter((v) => v.at <= now);
    if (!versions.length) return;
    let first = 0;
    versions.forEach((v, i) => {
      if (v.at <= start) first = i;
    });
    const scheduleId = ts.str('schedule') || null;
    const zone = ts.str('timezone') || null;
    let pausedAt: number | null = null;
    let pause = 0;
    let businessPause = 0;
    for (let i = first; i < versions.length; i++) {
      const subject = this.versionSubject(ctx, task, versions[i], i > 0 ? versions[i - 1] : null);
      const r = this.conditions(ctx, def, subject);
      const t = Math.max(versions[i].at, start);
      if (pausedAt === null && r.pause()) pausedAt = t;
      else if (pausedAt !== null && r.resume()) {
        pause += t - pausedAt;
        businessPause += this.businessDuration(scheduleId, zone, pausedAt, t);
        pausedAt = null;
      }
    }
    ts.setRaw('pause_duration', pause).setRaw('business_pause_duration', businessPause);
    if (pausedAt !== null) ts.setRaw('stage', 'paused').setRaw('pause_time', glide(pausedAt));
  }

  private versionSubject(ctx: Context, task: Rec, v: TaskVersion, prev: TaskVersion | null): MatchSubject {
    const cur = new Rec(ctx, task.table, { ...v.data }, prev ? { ...prev.data } : null);
    const before = prev ? new Rec(ctx, task.table, { ...prev.data }, { ...prev.data }) : null;
    return taskSubject(cur, before, prev === null, this.platform.registry);
  }

  private pause(ectx: Context, ts: Rec, def: Rec, opts: RunOptions): void {
    ts.setRaw('stage', 'paused').setRaw('pause_time', glide(opts.now));
    const breached = this.compute(ts, def, opts.now);
    ectx.update(ts);
    if (opts.replay) return;
    if (breached) this.fireDue(ectx, ts, def, opts.now);
    this.cancelTimers(ectx, ts);
  }

  private resume(ectx: Context, ts: Rec, def: Rec, opts: RunOptions): void {
    this.closePause(ts, opts.now);
    this.compute(ts, def, opts.now);
    ectx.update(ts);
    if (!opts.replay) this.restartTimers(ectx, ts, def, opts.now);
  }

  private closePause(ts: Rec, now: number): void {
    const pausedAt = msOf(ts.str('pause_time'));
    if (ts.str('stage') !== 'paused') return;
    if (pausedAt !== null) {
      ts.setRaw('pause_duration', (ts.num('pause_duration') ?? 0) + Math.max(0, now - pausedAt));
      ts.setRaw(
        'business_pause_duration',
        (ts.num('business_pause_duration') ?? 0) +
          this.businessDuration(ts.str('schedule') || null, ts.str('timezone') || null, pausedAt, now),
      );
    }
    ts.setRaw('pause_time', null);
    ts.setRaw('stage', ts.bool('has_breached') && this.flag(SLA_PROPS.compat) ? 'breached' : 'in_progress');
  }

  private finish(
    ectx: Context,
    ts: Rec,
    def: Rec | null,
    how: 'complete' | 'cancel',
    opts: RunOptions,
  ): void {
    this.closePause(ts, opts.now);
    ts.setRaw('end_time', glide(opts.now)).setRaw('active', 0);
    this.compute(ts, def, opts.now);
    const compat = this.flag(SLA_PROPS.compat);
    const stage =
      how === 'cancel'
        ? 'cancelled'
        : compat
          ? ts.bool('has_breached')
            ? 'breached'
            : 'achieved'
          : 'completed';
    ts.setRaw('stage', stage);
    ectx.update(ts);
    if (!opts.replay) this.cancelTimers(ectx, ts);
  }

  /** Recalculates a task SLA at `now`; a new breach fires the due timers. */
  recalc(ectx: Context, ts: Rec, now: number, opts?: RunOptions, def?: Rec | null): void {
    const d = def === undefined ? ectx.get('contract_sla', ts.str('sla')) : def;
    const breached = this.compute(ts, d, now);
    const moved = ts.changed('planned_end_time') && RUNNING.has(ts.str('stage'));
    ectx.update(ts);
    if (opts?.replay) return;
    if (moved) this.rescheduleTimers(ectx, ts, d);
    if (breached) this.fireDue(ectx, ts, d, now);
  }

  // ------------------------------------------------------------------ calculation (7.1 - 7.3)

  private businessDuration(scheduleId: string | null, zone: string | null, a: number, b: number): number {
    const engine = scheduleId ? this.schedules : undefined;
    return engine ? engine.duration(scheduleId, zone, a, b) : Math.max(0, b - a);
  }

  /** Target duration: the definition's duration, or for relative durations the span fixed at attach. */
  private target(
    ts: Rec,
    def: Rec | null,
    scheduleId: string | null,
    zone: string | null,
    start: number,
  ): number | null {
    if (def && !isRelative(def)) {
      const d = def.num('duration');
      return d && d > 0 ? d : null;
    }
    const end = msOf(ts.str('original_breach_time')) ?? msOf(ts.str('planned_end_time'));
    return end === null ? null : this.businessDuration(scheduleId, zone, start, end);
  }

  /** Recomputes elapsed, percentages, time left and breach time; returns true on a new breach. */
  compute(ts: Rec, def: Rec | null, now: number): boolean {
    const start = msOf(ts.str('start_time')) ?? now;
    const stage = ts.str('stage');
    const n =
      stage === 'paused'
        ? (msOf(ts.str('pause_time')) ?? now)
        : ts.bool('active')
          ? now
          : (msOf(ts.str('end_time')) ?? now);
    const pause = ts.num('pause_duration') ?? 0;
    const businessPause = ts.num('business_pause_duration') ?? 0;
    const scheduleId = ts.str('schedule') || null;
    const zone = ts.str('timezone') || null;
    const engine = scheduleId ? this.schedules : undefined;
    const target = this.target(ts, def, scheduleId, zone, start);
    const always = this.flag(SLA_PROPS.alwaysBusiness, true);
    const duration = Math.max(0, n - start - pause);
    const business = engine
      ? Math.max(0, engine.duration(scheduleId, zone, start, n) - businessPause)
      : always
        ? duration
        : null;
    const breached = ts.bool('has_breached');
    let planned = msOf(ts.str('planned_end_time'));
    if (!isRelative(def) && target !== null && !(breached && !this.flag(SLA_PROPS.plannedAfterBreach))) {
      planned = engine ? engine.add(scheduleId, zone, start, target + businessPause) : start + target + pause;
    }
    const reached = planned !== null && n >= planned;
    const pct = (x: number) => (target && target > 0 ? percent(x, target) : reached ? 100 : 0);
    const timeLeft = planned === null ? null : Math.max(0, planned - n);
    const businessLeft = engine
      ? target === null
        ? null
        : Math.max(0, target - (business ?? 0))
      : always
        ? timeLeft
        : null;
    const percentage = target === null ? null : pct(duration);
    const businessPct = business === null || target === null ? null : pct(business);
    ts.setRaw('duration', duration)
      .setRaw('business_duration', business)
      .setRaw('planned_end_time', planned === null ? null : glide(planned))
      .setRaw('percentage', percentage)
      .setRaw('business_percentage', businessPct)
      .setRaw('time_left', timeLeft)
      .setRaw('business_time_left', businessLeft);
    if (breached) return false;
    const effLeft = engine ? businessLeft : timeLeft;
    const breachedNow = this.flag(SLA_PROPS.useTimeLeft)
      ? planned !== null && n >= start && effLeft !== null && effLeft <= 0
      : (businessPct ?? percentage ?? 0) >= 100;
    if (!breachedNow) return false;
    ts.setRaw('has_breached', 1);
    if (this.flag(SLA_PROPS.compat) && RUNNING.has(stage)) ts.setRaw('stage', 'breached');
    return true;
  }

  // ------------------------------------------------------------------ percentage timers (9)

  private flowEnabled(def: Rec | null): boolean {
    return !!def && !!(def.str('flow') || def.str('workflow'));
  }

  private runForBreached(def: Rec): boolean {
    return this.flag(def.str('flow') ? SLA_PROPS.flowForBreached : SLA_PROPS.workflowForBreached);
  }

  private timers(ctx: Context, ts: Rec, state?: string): Rec[] {
    return ctx.query('resolvr_sla_timer', {
      query: `task_sla=${ts.sysId}${state ? `^state=${state}` : ''}`,
      orderBy: [{ field: 'threshold', desc: false }],
    });
  }

  /** Instant at which `threshold` % of the target is reached, given the pauses so far. */
  private fireAt(ts: Rec, def: Rec | null, threshold: number): number | null {
    const start = msOf(ts.str('start_time'));
    if (start === null) return null;
    const scheduleId = ts.str('schedule') || null;
    const zone = ts.str('timezone') || null;
    const target = this.target(ts, def, scheduleId, zone, start);
    if (target === null) return null;
    const part = Math.round((threshold * target) / 100);
    const engine = scheduleId ? this.schedules : undefined;
    if (engine) return engine.add(scheduleId, zone, start, part + (ts.num('business_pause_duration') ?? 0));
    return start + part + (ts.num('pause_duration') ?? 0);
  }

  private startTimers(ectx: Context, ts: Rec, def: Rec, now: number): void {
    if (!this.flowEnabled(def) || !RUNNING.has(ts.str('stage'))) return;
    if (ts.bool('has_breached') && !this.runForBreached(def)) return;
    this.createTimers(ectx, ts, def, now, false);
    this.fireDue(ectx, ts, def, now);
  }

  /** Replaces pending timers by fresh ones for every threshold not yet fired. */
  private createTimers(ectx: Context, ts: Rec, def: Rec | null, now: number, silentPast: boolean): void {
    const existing = this.timers(ectx, ts);
    const fired = new Set(existing.filter((t) => t.str('state') === 'fired').map((t) => t.num('threshold')));
    for (const t of existing) if (t.str('state') === 'pending') ectx.update(t, { state: 'cancelled' });
    for (const threshold of THRESHOLDS) {
      if (fired.has(threshold)) continue;
      const at = this.fireAt(ts, def, threshold);
      if (at === null) continue;
      ectx.insert('resolvr_sla_timer', {
        task_sla: ts.sysId,
        threshold,
        fire_at: glide(at),
        state: silentPast && at <= now ? 'fired' : 'pending',
      });
    }
  }

  /** After a resume: timers come back unless the flow never started (breached at attach). */
  private restartTimers(ectx: Context, ts: Rec, def: Rec, now: number): void {
    if (!this.flowEnabled(def)) return;
    const hadTimers = this.timers(ectx, ts).length > 0;
    if (!hadTimers && ts.bool('has_breached') && !this.runForBreached(def)) return;
    this.createTimers(ectx, ts, def, now, false);
    this.fireDue(ectx, ts, def, now);
  }

  /** The breach time moved (definition edited): pending timers follow it. */
  private rescheduleTimers(ectx: Context, ts: Rec, def: Rec | null): void {
    for (const t of this.timers(ectx, ts, 'pending')) {
      const at = this.fireAt(ts, def, t.num('threshold') ?? 100);
      if (at !== null && glide(at) !== t.str('fire_at')) ectx.update(t, { fire_at: glide(at) });
    }
  }

  private cancelTimers(ectx: Context, ts: Rec): void {
    for (const t of this.timers(ectx, ts, 'pending')) ectx.update(t, { state: 'cancelled' });
  }

  /** Fires pending timers that are due, in ascending order; a breach makes the 100 % timer due. */
  private fireDue(ectx: Context, ts: Rec, def: Rec | null, now: number): void {
    let task: Rec | null | undefined;
    for (const timer of this.timers(ectx, ts, 'pending')) {
      const threshold = timer.num('threshold') ?? 100;
      const at = msOf(timer.str('fire_at'));
      const due = (at !== null && at <= now) || (threshold >= 100 && ts.bool('has_breached'));
      if (!due) continue;
      ectx.update(timer, { state: 'fired' });
      this.compute(ts, def, now);
      ectx.update(ts);
      if (!RUNNING.has(ts.str('stage'))) continue;
      if (task === undefined) task = ectx.loadRaw('task', ts.str('task'));
      raiseThreshold(ectx, ts, task, threshold);
    }
  }

  /** Timer job: fires every pending timer whose time has come. Returns the task SLAs touched. */
  fireDueTimers(ctx: Context, now: number): number {
    const ectx = this.isEngineContext(ctx) ? ctx : this.engineContext(ctx);
    const due = ectx.query('resolvr_sla_timer', {
      query: `state=pending^fire_at<=${glide(now)}`,
      orderBy: [
        { field: 'fire_at', desc: false },
        { field: 'threshold', desc: false },
      ],
    });
    const seen = new Set<string>();
    for (const t of due) {
      const id = t.str('task_sla');
      if (seen.has(id)) continue;
      seen.add(id);
      const ts = ectx.get('task_sla', id);
      if (!ts) continue;
      if (!ts.bool('active') || !RUNNING.has(ts.str('stage'))) {
        this.cancelTimers(ectx, ts);
        continue;
      }
      this.fireDue(ectx, ts, ectx.get('contract_sla', ts.str('sla')), now);
      this.syncLegacyFields(ectx, ts.str('task'));
    }
    return seen.size;
  }

  // ------------------------------------------------------------------ update jobs (8)

  /** Running task SLAs whose breach time falls in the window (all running ones when null). */
  selectRunning(ctx: Context, window: JobWindow | null, now: number): Rec[] {
    const raw = (this.platform.properties.get(SLA_PROPS.pctLimit) ?? '').trim();
    if (raw === '0') return [];
    const limit = raw === '' ? null : Number(raw);
    let query = 'active=true^stageINin_progress,breached';
    if (window)
      query += `^planned_end_time>=${glide(now + window.from)}^planned_end_time<${glide(now + window.to)}`;
    return ctx
      .query('task_sla', { query })
      .filter((ts) => limit === null || !Number.isFinite(limit) || (ts.num('percentage') ?? 0) <= limit);
  }

  runUpdateJob(ctx: Context, window: JobWindow): number {
    const ectx = this.engineContext(ctx);
    const now = clock.now().getTime();
    const rows = this.selectRunning(ectx, window, now);
    const tasks = new Set<string>();
    for (const ts of rows) {
      this.recalc(ectx, ts, now);
      tasks.add(ts.str('task'));
    }
    for (const t of tasks) this.syncLegacyFields(ectx, t);
    return rows.length;
  }

  /** Recalculates the open task SLAs of one task (display, UI action, REST). */
  refreshTask(ctx: Context, taskId: string): Rec[] {
    if (this.refreshing) return [];
    this.refreshing = true;
    try {
      const ectx = this.engineContext(ctx);
      const now = clock.now().getTime();
      const rows = this.openTaskSlas(ectx, taskId);
      for (const ts of rows) this.recalc(ectx, ts, now);
      if (rows.length) this.syncLegacyFields(ectx, taskId);
      return rows;
    } finally {
      this.refreshing = false;
    }
  }

  // ------------------------------------------------------------------ legacy task fields (11)

  private syncLegacyFields(ctx: Context, taskId: string): void {
    if (!this.flag(SLA_PROPS.legacy)) return;
    const task = ctx.loadRaw('task', taskId);
    const made = task?.column('made_sla');
    const due = task?.column('sla_due');
    if (!task || !made?.storage || !due?.storage) return;
    const rows = this.platform.db.all<{
      has_breached: number | null;
      stage: string | null;
      active: number | null;
      planned_end_time: string | null;
    }>(`SELECT "has_breached","stage","active","planned_end_time" FROM "task_sla" WHERE "task" = ?`, [
      taskId,
    ]);
    const breached = rows.some((r) => r.has_breached === 1);
    const nextDue =
      rows
        .filter((r) => r.active === 1 && r.stage !== 'paused' && r.planned_end_time)
        .map((r) => r.planned_end_time!)
        .sort()[0] ?? null;
    const cur = this.platform.db.get<{ made: number | null; due: string | null }>(
      `SELECT ${quoteIdent(made.physical)} AS "made", ${quoteIdent(due.physical)} AS "due" FROM ${quoteIdent(task.table.physical)} WHERE "sys_id" = ?`,
      [taskId],
    );
    if (!cur) return;
    const madeValue = breached ? 0 : (cur.made ?? 1);
    if (madeValue === cur.made && nextDue === cur.due) return;
    this.platform.db.run(
      `UPDATE ${quoteIdent(task.table.physical)} SET ${quoteIdent(made.physical)} = ?, ${quoteIdent(due.physical)} = ? WHERE "sys_id" = ?`,
      [madeValue, nextDue, taskId],
    );
  }

  // ------------------------------------------------------------------ repair (10)

  repairEnabled(): boolean {
    return this.flag(SLA_PROPS.repair, true);
  }

  /** Rebuilds the task SLAs of the given tasks by replaying their audit history. Returns the repair log. */
  repair(ctx: Context, taskIds: string[]): Rec {
    const ectx = this.engineContext(ctx);
    const now = clock.now().getTime();
    const log = ectx.insert('sla_repair_log', {
      initiated_by: ctx.user.sysId,
      started: glide(now),
      state: 'in_progress',
      request: JSON.stringify({ task: taskIds }).slice(0, 4000),
    });
    try {
      for (const id of new Set(taskIds)) this.repairTask(ectx, log, id, now);
      ectx.update(log, { state: 'complete', finished: glide(clock.now().getTime()) });
    } catch (e) {
      ectx.update(log, { state: 'error', finished: glide(clock.now().getTime()) });
      throw e;
    }
    return log;
  }

  private logEntry(ctx: Context, log: Rec, type: 'before' | 'after', ts: Rec): void {
    ctx.insert('sla_repair_log_entry', {
      repair_log: log.sysId,
      type,
      task: ts.str('task'),
      task_sla_id: ts.sysId,
      sla: ts.str('sla'),
      values: JSON.stringify(ts.toObject()),
    });
  }

  private repairTask(ectx: Context, log: Rec, taskId: string, now: number): void {
    const task = ectx.loadRaw('task', taskId);
    if (!task) return;
    for (const ts of ectx.query('task_sla', { query: `task=${taskId}` })) {
      this.logEntry(ectx, log, 'before', ts);
      ectx.delete(ts);
    }
    const versions = taskVersions(ectx, task);
    if (!versions.length) this.run(ectx, task, null, { now, insert: true, replay: true });
    versions.forEach((v, i) => {
      const prev = i > 0 ? versions[i - 1] : null;
      const cur = new Rec(ectx, task.table, { ...v.data }, prev ? { ...prev.data } : null);
      const before = prev ? new Rec(ectx, task.table, { ...prev.data }, { ...prev.data }) : null;
      this.run(ectx, cur, before, { now: v.at, insert: i === 0, replay: true });
    });
    for (const ts of this.openTaskSlas(ectx, taskId)) {
      const def = ectx.get('contract_sla', ts.str('sla'));
      this.compute(ts, def, now);
      ectx.update(ts);
      if (this.flowEnabled(def) && RUNNING.has(ts.str('stage'))) this.createTimers(ectx, ts, def, now, true);
    }
    for (const ts of ectx.query('task_sla', { query: `task=${taskId}` }))
      this.logEntry(ectx, log, 'after', ts);
    this.syncLegacyFields(ectx, taskId);
  }
}

export function slaEngine(platform: Platform): SlaEngine | undefined {
  return platform.services.get('sla') as SlaEngine | undefined;
}
