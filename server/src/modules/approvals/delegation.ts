import type { Platform } from '../../engine/platform.js';
import { nowGlide } from '../../engine/util.js';
import { DELEGATE_TABLE } from './constants.js';

export type DelegateCapability = 'approvals' | 'assignments' | 'notifications' | 'invitations';
const CAPABILITIES: ReadonlySet<string> = new Set([
  'approvals',
  'assignments',
  'notifications',
  'invitations',
]);

interface DelegateRow {
  user: string;
  delegate: string;
  starts: string | null;
  ends: string | null;
}

function activeWindow(row: DelegateRow, now: string): boolean {
  if (row.starts && row.starts > now) return false;
  if (row.ends && row.ends <= now) return false;
  return true;
}

function rows(
  platform: Platform,
  column: 'user' | 'delegate',
  id: string,
  capability: DelegateCapability,
): DelegateRow[] {
  if (!platform.registry.has(DELEGATE_TABLE) || !CAPABILITIES.has(capability)) return [];
  return platform.db.all<DelegateRow>(
    `SELECT d."user" AS "user", d."delegate" AS "delegate", d."starts" AS "starts", d."ends" AS "ends"
       FROM "sys_user_delegate" d
       JOIN "sys_user" du ON du."sys_id" = d."delegate"
      WHERE d."${column}" = ? AND COALESCE(d."${capability}", 1) = 1 AND (du."active" IS NULL OR du."active" = 1)`,
    [id],
  );
}

/**
 * Users who currently delegate `capability` to `delegateId` (active window, active
 * delegate, never the delegate themself).
 */
export function delegatorsOf(
  platform: Platform,
  delegateId: string | null,
  capability: DelegateCapability = 'approvals',
): string[] {
  if (!delegateId) return [];
  const now = nowGlide();
  return [
    ...new Set(
      rows(platform, 'delegate', delegateId, capability)
        .filter((r) => r.user && r.user !== delegateId && activeWindow(r, now))
        .map((r) => r.user),
    ),
  ];
}

/** Active delegates of a user for a capability. */
export function delegatesOf(
  platform: Platform,
  userId: string | null,
  capability: DelegateCapability = 'approvals',
): string[] {
  if (!userId) return [];
  const now = nowGlide();
  return [
    ...new Set(
      rows(platform, 'user', userId, capability)
        .filter((r) => r.delegate && r.delegate !== userId && activeWindow(r, now))
        .map((r) => r.delegate),
    ),
  ];
}

/** True when `delegateId` may currently act for `userId` on approvals. */
export function isActiveDelegate(
  platform: Platform,
  delegateId: string | null,
  userId: string | null,
): boolean {
  if (!delegateId || !userId || delegateId === userId) return false;
  return delegatorsOf(platform, delegateId, 'approvals').includes(userId);
}
