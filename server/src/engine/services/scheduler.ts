import type { Context } from '../context.js';
import type { Platform } from '../platform.js';
import { clock } from '../util.js';

export interface ScheduledJobDef {
  id: string;
  name: string;
  /** Run every N milliseconds. */
  intervalMs: number;
  /** Delay before the first run (defaults to the interval). */
  initialDelayMs?: number;
  run: (ctx: Context) => void;
  description?: string;
  module?: string;
}

interface JobState {
  def: ScheduledJobDef;
  nextRun: number;
  lastRun: number | null;
  lastError: string | null;
  running: boolean;
}

/** In-process scheduler for periodic platform jobs (SLA timers, auto-close, ML training...). */
export class Scheduler {
  private jobs = new Map<string, JobState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private platform: Platform) {}

  define(def: ScheduledJobDef): void {
    const now = clock.now().getTime();
    this.jobs.set(def.id, {
      def,
      nextRun: now + (def.initialDelayMs ?? def.intervalMs),
      lastRun: null,
      lastError: null,
      running: false,
    });
  }

  list(): { id: string; name: string; intervalMs: number; nextRun: string; lastRun: string | null; lastError: string | null }[] {
    return [...this.jobs.values()].map((j) => ({
      id: j.def.id,
      name: j.def.name,
      intervalMs: j.def.intervalMs,
      nextRun: new Date(j.nextRun).toISOString(),
      lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
      lastError: j.lastError,
    }));
  }

  /** Runs a job immediately. */
  runNow(id: string): void {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    this.execute(j);
  }

  private execute(j: JobState): void {
    if (j.running) return;
    j.running = true;
    const started = clock.now().getTime();
    try {
      j.def.run(this.platform.systemContext());
      j.lastError = null;
    } catch (e) {
      j.lastError = e instanceof Error ? e.message : String(e);
      this.platform.reportError(`scheduled job ${j.def.id}`, e);
    } finally {
      j.running = false;
      j.lastRun = started;
      j.nextRun = clock.now().getTime() + j.def.intervalMs;
    }
  }

  /** Runs every job that is due at the current (possibly simulated) time. */
  tick(): number {
    const now = clock.now().getTime();
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.nextRun <= now) {
        this.execute(j);
        n++;
      }
    }
    return n;
  }

  start(pollMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.platform.reportError('scheduler', e);
      }
    }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
