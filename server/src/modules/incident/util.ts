import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { diffMs, parseGlideDateTime, toGlideDateTime } from '../../engine/util.js';
import { optionalService, type ScheduleService, SERVICES } from '../contracts.js';
import { AGENT_ROLES, MIM_STATE, PROP } from './constants.js';

/** True for the system user and users holding an incident agent role (admin included). */
export function isAgent(ctx: Context): boolean {
  return ctx.user.isSystem || ctx.hasAnyRole([...AGENT_ROLES, 'admin']);
}

export function isCaller(rec: Rec, ctx: Context): boolean {
  return !!ctx.user.sysId && rec.str('caller_id') === ctx.user.sysId;
}

export function isOpener(rec: Rec, ctx: Context): boolean {
  return !!ctx.user.sysId && rec.str('opened_by') === ctx.user.sysId;
}

export function isMajorIncident(rec: Rec): boolean {
  return rec.str('major_incident_state') === MIM_STATE.ACCEPTED;
}

/** Interactive writes are made by a person through the API or UI (ACLs enforced). */
export function isInteractive(ctx: Context): boolean {
  return !ctx.user.isSystem && ctx.enforceAcl;
}

export function propBool(ctx: Context, name: string, fallback = false): boolean {
  return ctx.platform.properties.getBool(name, fallback);
}

export function propNum(ctx: Context, name: string, fallback: number): number {
  return ctx.platform.properties.getNumber(name, fallback);
}

export function propStr(ctx: Context, name: string, fallback = ''): string {
  return ctx.platform.properties.get(name, fallback) ?? fallback;
}

export function propList(ctx: Context, name: string): string[] {
  return propStr(ctx, name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Adds weekdays (Monday to Friday) to a date-time; weekends are skipped. */
export function addBusinessDays(glide: string, days: number): string {
  const d = parseGlideDateTime(glide)!;
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return toGlideDateTime(d);
}

/** Subtracts weekdays from a date-time. */
export function subtractBusinessDays(glide: string, days: number): string {
  const d = parseGlideDateTime(glide)!;
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return toGlideDateTime(d);
}

/** Business milliseconds between two instants: the configured schedule when available, else calendar time. */
export function businessMs(ctx: Context, start: string, end: string): number {
  const calendar = Math.max(0, diffMs(end, start));
  const scheduleId = propStr(ctx, PROP.businessSchedule);
  const schedules = optionalService<ScheduleService>(ctx.platform, SERVICES.schedules);
  if (!scheduleId || !schedules) return calendar;
  try {
    return Math.max(0, schedules.businessMs(ctx, scheduleId, start, end));
  } catch {
    return calendar;
  }
}

let quietDepth = 0;

/** Runs `fn` while journal entries written by automation do not raise comment/work note events. */
export function quietly<T>(fn: () => T): T {
  quietDepth++;
  try {
    return fn();
  } finally {
    quietDepth--;
  }
}

export function isQuiet(): boolean {
  return quietDepth > 0;
}

/** Context for maintenance writes (counters, link moves): no ACLs, no business rules. */
export function maintenanceContext(ctx: Context): Context {
  return ctx.derive({ acl: false, workflow: false });
}

/** Comma-separated list of distinct, non-empty ids (event parm "recipients"). */
export function recipients(...ids: (string | null | undefined)[]): string {
  const out = new Set<string>();
  for (const v of ids) for (const id of String(v ?? '').split(',')) if (id.trim()) out.add(id.trim());
  return [...out].join(',');
}
