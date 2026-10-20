/**
 * Pure decision logic for approvals: how the answers of one unit (a group, or the
 * listed users of a request) combine under a rule, and how step states roll up to
 * the approved record. No database access here so the rules are easy to test.
 */
import { DECIDED, IGNORED, PENDING, type RuleType, ST } from './constants.js';

export interface UnitRow {
  state: string;
  /** When the answer was given (glide date-time); used by the first-response rule. */
  decidedOn?: string | null;
  /** Tie breaker for answers given in the same second. */
  seq?: number;
}

export type UnitOutcome = 'pending' | 'approved' | 'rejected' | 'empty';

/**
 * Approvals needed under a percentage rule: half-up rounding of N x p / 100, at least one.
 * Returns null when the rule degrades to "first response" (percentage empty or <= 0).
 */
export function requiredApprovals(n: number, percentage: number | null | undefined): number | null {
  if (percentage === null || percentage === undefined || !Number.isFinite(percentage) || percentage <= 0)
    return null;
  if (percentage >= 100) return n;
  return Math.max(1, Math.floor((n * percentage) / 100 + 0.5));
}

function firstResponse(rows: UnitRow[]): UnitOutcome {
  const answered = rows
    .filter((r) => DECIDED.has(r.state))
    .sort(
      (a, b) =>
        String(a.decidedOn ?? '').localeCompare(String(b.decidedOn ?? '')) || (a.seq ?? 0) - (b.seq ?? 0),
    );
  if (!answered.length) return 'pending';
  return answered[0].state === ST.approved ? 'approved' : 'rejected';
}

/** Outcome of one unit. Cancelled and duplicate rows are not responders. */
export function evaluateUnit(
  rule: RuleType,
  percentage: number | null | undefined,
  rows: UnitRow[],
): UnitOutcome {
  const live = rows.filter((r) => !IGNORED.has(r.state));
  const n = live.length;
  if (n === 0) return 'empty';
  const approved = live.filter((r) => r.state === ST.approved).length;
  const rejected = live.filter((r) => r.state === ST.rejected).length;
  const pending = live.filter((r) => PENDING.has(r.state)).length;
  switch (rule) {
    case 'first_response':
      return firstResponse(live);
    case 'any':
      if (approved >= 1) return 'approved';
      return pending === 0 ? 'rejected' : 'pending';
    case 'all':
      if (rejected >= 1) return 'rejected';
      return approved === n ? 'approved' : 'pending';
    case 'percentage': {
      const required = requiredApprovals(n, percentage);
      if (required === null) return firstResponse(live);
      if (approved >= required) return 'approved';
      return approved + pending < required ? 'rejected' : 'pending';
    }
    default:
      return 'pending';
  }
}

/** A step is approved when every unit is approved and rejected as soon as one unit is rejected. */
export function combineUnits(
  outcomes: ('pending' | 'approved' | 'rejected')[],
): 'pending' | 'approved' | 'rejected' {
  if (outcomes.includes('rejected')) return 'rejected';
  if (outcomes.length && outcomes.every((o) => o === 'approved')) return 'approved';
  return 'pending';
}

/**
 * Roll-up of step states into the record's approval value. This is the classic
 * algorithm (any rejection rejects, everything approved approves, nothing asked yet
 * stays "not requested") with cancelled steps winning over approvals.
 */
export function rollupStates(states: string[]): string {
  const live = states.filter((s) => s !== ST.notRequired && s !== ST.duplicate && s !== '');
  if (!live.length) return ST.notRequested;
  if (live.includes(ST.rejected)) return ST.rejected;
  if (live.includes(ST.requested)) return ST.requested;
  if (live.includes(ST.cancelled)) return ST.cancelled;
  if (live.every((s) => s === ST.approved)) return ST.approved;
  if (live.every((s) => s === ST.notRequested)) return ST.notRequested;
  return ST.requested;
}

/** Parses the reply text of an approval email into a decision (spec: approval by email reply). */
export function emailDecision(subject: string, text: string): 'approved' | 'rejected' | null {
  const body = text ?? '';
  if (/\bstate\s*:\s*approved\b/i.test(body)) return 'approved';
  if (/\bstate\s*:\s*rejected\b/i.test(body)) return 'rejected';
  const subj = (subject ?? '').trim().toLowerCase();
  const first = (body.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (/-\s*approve$/.test(subj) || ['yes', 'approve', 'approved'].includes(first)) return 'approved';
  if (/-\s*reject$/.test(subj) || ['no', 'reject', 'rejected'].includes(first)) return 'rejected';
  return null;
}
