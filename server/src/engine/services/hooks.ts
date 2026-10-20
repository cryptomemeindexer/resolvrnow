import type { Context } from '../context.js';
import type { Rec } from '../record.js';

export type RecordEvent = 'insert' | 'update' | 'delete';
export type RecordHook = (rec: Rec, previous: Rec | null, ctx: Context) => void;

interface HookEntry {
  table: string | '*';
  fn: RecordHook;
  name: string;
}

/**
 * Platform-level listeners that run after a record operation has been committed and
 * its after-business-rules have run (notifications, SLA timers, flows, caches, search index).
 */
export class HookBus {
  private hooks: Record<RecordEvent, HookEntry[]> = { insert: [], update: [], delete: [] };

  on(event: RecordEvent | RecordEvent[], table: string | '*', name: string, fn: RecordHook): void {
    for (const e of Array.isArray(event) ? event : [event]) this.hooks[e].push({ table, fn, name });
  }

  emit(event: RecordEvent, rec: Rec, previous: Rec | null, ctx: Context, onError: (name: string, e: unknown) => void): void {
    for (const h of this.hooks[event]) {
      if (h.table !== '*' && !rec.table.ancestors.includes(h.table)) continue;
      try {
        h.fn(rec, previous, ctx);
      } catch (e) {
        onError(h.name, e);
      }
    }
  }
}
