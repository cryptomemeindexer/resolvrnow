import type { Platform } from '../../engine/platform.js';
import { newSysId, nowGlide } from '../../engine/util.js';

/**
 * Writes a syslog row directly (no business rules, no ACLs), like the engine's own error logging.
 * Logging never throws.
 */
export function writeSyslog(
  platform: Platform,
  level: string,
  source: string,
  message: string,
  user = 'system',
): void {
  if (!platform.registry.has('syslog')) return;
  const now = nowGlide();
  const by = user.slice(0, 40);
  try {
    platform.db.run(
      `INSERT INTO "syslog" ("sys_id","sys_class_name","level","source","message","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,?,?,?,?,?,0)`,
      [newSysId(), 'syslog', level, source.slice(0, 100), message.slice(0, 4000), now, by, now, by],
    );
  } catch {
    /* logging must never throw */
  }
}
