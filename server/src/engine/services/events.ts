import type { Context } from '../context.js';
import type { Platform } from '../platform.js';
import type { Rec } from '../record.js';
import { newSysId, nowGlide } from '../util.js';

export interface EventRecord {
  sys_id: string;
  name: string;
  instance: string | null;
  table: string | null;
  parm1: string | null;
  parm2: string | null;
  user_id: string | null;
  user_name: string | null;
  sys_created_on: string;
}

export interface EventHandlerDef {
  /** Event name, or '*' for every event. */
  event: string;
  name: string;
  run: (ev: EventRecord, rec: Rec | null, ctx: Context) => void;
}

/**
 * Event queue (sysevent). Events are recorded in the same transaction as the change
 * that raised them and processed asynchronously by handlers (notifications, script actions).
 */
export class EventService {
  private handlers: EventHandlerDef[] = [];
  readonly registered = new Map<string, { table?: string; description?: string }>();

  constructor(private platform: Platform) {}

  register(name: string, table?: string, description?: string): void {
    this.registered.set(name, { table, description });
  }

  on(def: EventHandlerDef): void {
    this.handlers.push(def);
  }

  queue(ctx: Context, name: string, rec: Rec | null, parm1: string | null, parm2: string | null): void {
    if (!this.platform.registry.has('sysevent')) return;
    const now = nowGlide();
    this.platform.db.run(
      `INSERT INTO "sysevent" ("sys_id","sys_class_name","name","instance","table","parm1","parm2","state","queue","user_id","user_name","process_on","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        newSysId(),
        'sysevent',
        name,
        rec?.sysId ?? null,
        rec?.className ?? null,
        parm1,
        parm2,
        'ready',
        null,
        ctx.user.sysId,
        ctx.user.userName,
        now,
        now,
        ctx.user.userName,
        now,
        ctx.user.userName,
      ],
    );
    this.platform.scheduleWork();
  }

  /** Processes ready events; returns the number processed. */
  process(limit = 200): number {
    if (!this.platform.registry.has('sysevent')) return 0;
    const rows = this.platform.db.all<EventRecord>(
      `SELECT "sys_id","name","instance","table","parm1","parm2","user_id","user_name","sys_created_on" FROM "sysevent" WHERE "state" = 'ready' AND ("process_on" IS NULL OR "process_on" <= ?) ORDER BY "sys_created_on", rowid LIMIT ?`,
      [nowGlide(), limit],
    );
    for (const ev of rows) {
      this.platform.db.run(`UPDATE "sysevent" SET "state" = 'processing' WHERE "sys_id" = ?`, [ev.sys_id]);
      let state = 'processed';
      const user = ev.user_id ? this.platform.users.session(ev.user_id) : null;
      const ctx = this.platform.contextFor(user).derive({ acl: false });
      const rec = ev.table && ev.instance && this.platform.registry.has(ev.table) ? ctx.loadRaw(ev.table, ev.instance) : null;
      for (const h of this.handlers) {
        if (h.event !== '*' && h.event !== ev.name) continue;
        try {
          h.run(ev, rec, ctx);
        } catch (e) {
          state = 'error';
          this.platform.reportError(`event handler ${h.name} (${ev.name})`, e);
        }
      }
      this.platform.db.run(`UPDATE "sysevent" SET "state" = ?, "processed" = ? WHERE "sys_id" = ?`, [state, nowGlide(), ev.sys_id]);
    }
    return rows.length;
  }
}
