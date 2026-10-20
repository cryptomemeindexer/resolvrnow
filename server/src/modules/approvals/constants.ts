import type { ChoiceDef } from '../../engine/types.js';

/** Approval table names. `resolvr_approval_step` is a ResolvrNow table (one row per approval request). */
export const APPROVAL_TABLE = 'sysapproval_approver';
export const GROUP_TABLE = 'sysapproval_group';
export const STEP_TABLE = 'resolvr_approval_step';
export const DELEGATE_TABLE = 'sys_user_delegate';

export const ST = {
  notRequested: 'not requested',
  requested: 'requested',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  notRequired: 'not_required',
  duplicate: 'duplicate',
} as const;

/** States in which an approval still waits for an answer. */
export const PENDING: ReadonlySet<string> = new Set([ST.notRequested, ST.requested]);
/** Final answers. */
export const DECIDED: ReadonlySet<string> = new Set([ST.approved, ST.rejected]);
/** Rows that never count as responders. */
export const IGNORED: ReadonlySet<string> = new Set([ST.cancelled, ST.duplicate]);

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const APPROVAL_STATE_CHOICES: ChoiceDef[] = [
  c(ST.notRequested, 'Not Yet Requested', 10),
  c(ST.requested, 'Requested', 20),
  c(ST.approved, 'Approved', 30),
  c(ST.rejected, 'Rejected', 40),
  c(ST.cancelled, 'Cancelled', 50),
  c(ST.notRequired, 'No Longer Required', 60),
  c(ST.duplicate, 'Duplicate', 70),
];

export type RuleType = 'first_response' | 'any' | 'all' | 'percentage';

export const RULE_CHOICES: ChoiceDef[] = [
  c('first_response', 'First response', 10),
  c('any', 'Anyone approves', 20),
  c('all', 'All responses', 30),
  c('percentage', 'Percentage of users', 40),
];

export type OnDue = 'approve' | 'reject' | 'cancel';

export const ON_DUE_CHOICES: ChoiceDef[] = [
  c('approve', 'Approve', 10),
  c('reject', 'Reject', 20),
  c('cancel', 'Cancel', 30),
];

export const SOURCE_CHOICES: ChoiceDef[] = [
  c('ui', 'User interface', 10),
  c('email', 'Email', 20),
  c('api', 'API', 30),
  c('flow', 'Flow', 40),
  c('rule', 'Approval rule', 50),
  c('manual', 'Manual', 60),
];

/** Accepts the contract names (`first`), the spec names and their aliases (`anyone`, `everyone`). */
export function normalizeRule(rule: unknown, fallback: RuleType): RuleType {
  const s = String(rule ?? '')
    .trim()
    .toLowerCase();
  switch (s) {
    case 'first':
    case 'first_response':
    case 'firstresponse':
      return 'first_response';
    case 'any':
    case 'anyone':
      return 'any';
    case 'all':
    case 'everyone':
      return 'all';
    case 'percentage':
    case 'percent':
      return 'percentage';
    default:
      return fallback;
  }
}

export function normalizeOnDue(v: unknown): OnDue | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (s === 'approve' || s === 'approved') return 'approve';
  if (s === 'reject' || s === 'rejected') return 'reject';
  if (s === 'cancel' || s === 'cancelled') return 'cancel';
  return null;
}

/** Catalog requests use their own event names (`request.approval.*`). */
export function approvalEventName(
  base: 'inserted' | 'rejected' | 'cancelled',
  targetAncestors: string[],
): string {
  const catalog = targetAncestors.includes('sc_request') || targetAncestors.includes('sc_req_item');
  return catalog ? `request.approval.${base}` : `approval.${base}`;
}
