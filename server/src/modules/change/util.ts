import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import { matches } from '../../engine/query/matcher.js';
import { parseEncodedQuery, TEXT_QUERY_FIELD } from '../../engine/query/parser.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import {
  type ApprovalService,
  type CmdbService,
  optionalService,
  type ScheduleService,
  SERVICES,
} from '../contracts.js';

export const DAY_MS = 86_400_000;

export function approvalsOf(platform: Platform): ApprovalService | undefined {
  return optionalService<ApprovalService>(platform, SERVICES.approvals);
}

export function cmdbOf(platform: Platform): CmdbService | undefined {
  return optionalService<CmdbService>(platform, SERVICES.cmdb);
}

export function schedulesOf(platform: Platform): ScheduleService | undefined {
  return optionalService<ScheduleService>(platform, SERVICES.schedules);
}

/**
 * Evaluates an encoded query against a record. With `strict`, a term that refers to a
 * field the record does not have (for example a CMDB field when the CMDB is not
 * installed) makes the whole condition fail instead of being ignored.
 */
export function recordMatches(
  ctx: Context,
  rec: Rec,
  query: string | null | undefined,
  strict = false,
): boolean {
  const q = (query ?? '').trim();
  if (!q) return true;
  const subject = recSubject(rec, null, ctx.registry);
  if (strict) {
    const parsed = parseEncodedQuery(q);
    if (parsed.invalid.length) return false;
    for (const block of parsed.blocks) {
      for (const cluster of block) {
        for (const cond of cluster) {
          if (cond.field === TEXT_QUERY_FIELD) continue;
          if (!subject.column(cond.field)) return false;
        }
      }
    }
  }
  return matches(q, subject, ctx.env);
}

/** Active members (sys_user sys_ids) of a group. */
export function groupMembers(ctx: Context, groupId: string): string[] {
  if (!groupId || !ctx.registry.has('sys_user_grmember')) return [];
  return ctx
    .elevated()
    .query('sys_user_grmember', `group=${groupId}^user.active=true`)
    .map((m) => m.str('user'))
    .filter(Boolean);
}

export function groupByName(ctx: Context, name: string): Rec | null {
  if (!name) return null;
  return ctx.elevated().first('sys_user_group', `name=${name}`);
}

/** Active users holding a role directly. */
export function usersWithRole(ctx: Context, role: string): string[] {
  if (!ctx.registry.has('sys_user_has_role')) return [];
  const ids = ctx
    .elevated()
    .query('sys_user_has_role', `role.name=${role}^user.active=true`)
    .map((r) => r.str('user'))
    .filter(Boolean);
  return [...new Set(ids)];
}

export function isActiveUser(ctx: Context, userId: string): boolean {
  if (!userId) return false;
  const u = ctx.elevated().get('sys_user', userId);
  return !!u && u.bool('active');
}

/** Parses an encoded list of field values (`a=1^b=two`), honouring `^^` escapes. */
export function parseValues(encoded: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!encoded) return out;
  const terms: string[] = [];
  let current = '';
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    if (ch !== '^') {
      current += ch;
    } else if (encoded[i + 1] === '^') {
      current += '^';
      i++;
    } else {
      terms.push(current);
      current = '';
    }
  }
  terms.push(current);
  for (const term of terms) {
    if (!term || term === 'EQ') continue;
    const i = term.indexOf('=');
    if (i <= 0) continue;
    out[term.slice(0, i).trim()] = term.slice(i + 1);
  }
  return out;
}

export function encodeValues(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v).replace(/\^/g, '^^')}`)
    .join('^');
}

export function csv(v: string | null | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Reads a JSON column, tolerating empty or malformed content. */
export function readJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
