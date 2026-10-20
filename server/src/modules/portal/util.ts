import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { clock, isSysId } from '../../engine/util.js';
import { optionalService, SERVICES } from '../contracts.js';
import { EXT } from './constants.js';

/** True when the table is installed (other modules may be absent). */
export function hasTable(ctx: Context | Platform, table: string): boolean {
  return ctx.registry.has(table);
}

export function hasColumn(ctx: Context | Platform, table: string, field: string): boolean {
  return !!ctx.registry.column(table, field);
}

/** Escapes a value for use inside an encoded query (a literal caret is written twice). */
export function q(value: string): string {
  return String(value).replace(/\^/g, '^^');
}

/** Comma-separated list of valid sys_ids for IN queries (`none` keeps the query valid when empty). */
export function idList(ids: Iterable<string>): string {
  const out = [...new Set([...ids].filter((id) => isSysId(id)))];
  return out.length ? out.join(',') : 'none';
}

/** Search words: letters and digits only, lower-cased, at most 8. */
export function searchWords(text: string | null | undefined): string[] {
  const words = String(text ?? '')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}.\-_]*/gu);
  return [...new Set(words ?? [])].slice(0, 8);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3)).trimEnd()}...`;
}

/** First non-empty line of a text, trimmed to `n` characters. */
export function firstLine(s: string, n: number): string {
  const line =
    String(s ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return truncate(line, n);
}

/** Plain text from simple HTML (descriptions and article bodies in result cards). */
export function plainText(html: string | null | undefined): string {
  return String(html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** `{ sys_id, display_value }` for a reference field, or null when empty. */
export function refOf(
  rec: Rec | null | undefined,
  field: string,
): { sys_id: string; display_value: string } | null {
  if (!rec?.has(field)) return null;
  const id = rec.str(field);
  if (!id) return null;
  return { sys_id: id, display_value: rec.display(field) };
}

/** Value of the first existing, non-empty field. */
export function firstField(rec: Rec, fields: string[]): string {
  for (const f of fields) if (rec.has(f) && rec.str(f)) return rec.str(f);
  return '';
}

/** Fields that identify the person a ticket is for, in order of preference. */
export const REQUESTER_FIELDS = ['opened_for', 'requested_for', 'caller_id', 'requested_by'];

/** The person a ticket is for (requester), falling back to the opener. */
export function requesterOf(rec: Rec): string {
  return firstField(rec, [...REQUESTER_FIELDS, 'opened_by']);
}

/** Field on a table that holds the requester (null for tables without one). */
export function requesterField(ctx: Context, table: string): string | null {
  for (const f of REQUESTER_FIELDS) if (hasColumn(ctx, table, f)) return f;
  return null;
}

/** True when the user is the requester, the opener or on the watch list of a ticket. */
export function isTicketParty(rec: Rec, userId: string | null): boolean {
  if (!userId) return false;
  for (const f of [...REQUESTER_FIELDS, 'opened_by']) if (rec.has(f) && rec.str(f) === userId) return true;
  return rec.has('watch_list') && rec.str('watch_list').split(',').includes(userId);
}

/** Hour of day (0-23) in the user's time zone, used for the greeting. */
export function localHour(ctx: Context): number {
  const zone = ctx.user.timeZone || ctx.platform.properties.get('glide.sys.default.tz') || 'UTC';
  try {
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(clock.now())
      .find((p) => p.type === 'hour')?.value;
    return Number(hour ?? clock.now().getUTCHours()) % 24;
  } catch {
    return clock.now().getUTCHours();
  }
}

/** Display name of a user by user_name (journal entries store user names). */
export function userByName(
  ctx: Context,
  cache: Map<string, { sys_id: string | null; name: string }>,
  userName: string,
) {
  const hit = cache.get(userName);
  if (hit) return hit;
  const row = ctx.platform.db.get<{ sys_id: string; name: string }>(
    `SELECT "sys_id","name" FROM "sys_user" WHERE "user_name" = ?`,
    [userName],
  );
  const v = { sys_id: row?.sys_id ?? null, name: row?.name || userName };
  cache.set(userName, v);
  return v;
}

// ------------------------------------------------------------------ user criteria

const criteriaCache = new WeakMap<Context, Map<string, boolean>>();

function list(rec: Rec, field: string): string[] {
  return rec.has(field)
    ? rec
        .str(field)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Evaluates one user criteria record for the current user (scripted criteria are not supported and never match). */
function criterionMatches(ctx: Context, criterion: Rec): boolean {
  if (criterion.has('active') && criterion.str('active') !== '' && !criterion.bool('active')) return false;
  const me = ctx.user.sysId;
  if (!me) return false;
  const sys = ctx.elevated();
  const user = sys.get('sys_user', me);
  const checks: boolean[] = [];
  const users = list(criterion, 'user');
  if (users.length) checks.push(users.includes(me));
  const groups = list(criterion, 'group');
  if (groups.length) checks.push(groups.some((g) => ctx.user.groups.includes(g)));
  const roles = list(criterion, 'role');
  if (roles.length) {
    const names = roles
      .map((r) => (isSysId(r) ? (sys.get('sys_user_role', r)?.str('name') ?? '') : r))
      .filter(Boolean);
    checks.push(names.some((n) => ctx.user.roles.has(n)));
  }
  for (const [field, userField] of [
    ['department', 'department'],
    ['location', 'location'],
    ['company', 'company'],
  ] as const) {
    const values = list(criterion, field);
    if (values.length) checks.push(!!user && values.includes(user.str(userField)));
  }
  if (!checks.length) return false;
  return criterion.bool('match_all') ? checks.every(Boolean) : checks.some(Boolean);
}

/** True when the user matches at least one of the given user criteria. */
export function matchesAnyCriteria(ctx: Context, ids: string[]): boolean {
  if (!ids.length || !hasTable(ctx, EXT.userCriteria)) return false;
  let cache = criteriaCache.get(ctx);
  if (!cache) {
    cache = new Map();
    criteriaCache.set(ctx, cache);
  }
  for (const id of ids) {
    let hit = cache.get(id);
    if (hit === undefined) {
      const rec = ctx.elevated().get(EXT.userCriteria, id);
      hit = !!rec && criterionMatches(ctx, rec);
      cache.set(id, hit);
    }
    if (hit) return true;
  }
  return false;
}

/** Available For / Not Available For evaluation ("not" wins; empty lists do not restrict). */
export function visibleByCriteria(ctx: Context, rec: Rec): boolean {
  if (ctx.user.isSystem) return true;
  const available = list(rec, 'available_for');
  const notAvailable = list(rec, 'not_available_for');
  if (!hasTable(ctx, EXT.userCriteria)) return true;
  if (notAvailable.length && matchesAnyCriteria(ctx, notAvailable)) return false;
  if (available.length && !matchesAnyCriteria(ctx, available)) return false;
  return true;
}

// ------------------------------------------------------------------ optional catalog service

export interface CatalogAccessLike {
  canViewItem?: (item: Rec, opts?: { portal?: boolean; search?: boolean }) => boolean;
}

/** The parts of the catalog module's service the portal uses (all optional). */
export interface CatalogServiceLike {
  access?: (ctx: Context, userId?: string) => CatalogAccessLike;
  cancel?: (ctx: Context, rec: Rec, reason: string) => void;
  ticket?: (ctx: Context, table: string, id: string) => Record<string, unknown>;
}

export function catalogService(platform: Platform): CatalogServiceLike | undefined {
  return optionalService<CatalogServiceLike>(platform, SERVICES.catalog);
}
