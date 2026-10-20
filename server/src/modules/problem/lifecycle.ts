import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { nowGlide } from '../../engine/util.js';
import { propBool, propStr } from '../incident/util.js';
import {
  COORDINATOR,
  OPEN_TASK_STATES,
  PRB_PROP,
  PRB_STATE,
  PTASK_STATE,
  RESOLUTION,
  TASK_ANALYST,
} from './constants.js';

/**
 * Problem and problem task lifecycle actions. State changes are only legal through these
 * functions: each registers the transition it is about to make, and the state guard
 * rules abort any other change of `state`.
 */
const pending: { sysId: string; state: string; action: string }[] = [];

export function transitionAllowed(rec: Rec): boolean {
  return pending.some((t) => t.sysId === rec.sysId && t.state === rec.str('state'));
}

/** Name of the lifecycle action currently changing `rec`, if any. */
export function currentAction(rec: Rec): string {
  return pending.findLast((t) => t.sysId === rec.sysId)?.action ?? '';
}

/** Applies a state change (plus values) as an authorized lifecycle transition. */
export function transition(
  ctx: Context,
  rec: Rec,
  state: string,
  values: Record<string, unknown> = {},
  action = '',
): Rec {
  pending.push({ sysId: rec.sysId, state, action });
  try {
    return ctx.update(rec, { ...values, state });
  } finally {
    pending.pop();
  }
}

function requireRole(ctx: Context, role: string, action: string): void {
  if (!ctx.user.isSystem && !ctx.hasRole(role)) throw new AccessError(`Insufficient rights to ${action}`);
}

function requireState(rec: Rec, states: string[], action: string): void {
  if (!states.includes(rec.str('state')))
    throw new AbortError(`${action} is not available in the current state`);
}

const pick = (rec: Rec, input: Record<string, unknown>, field: string): string =>
  String(input[field] ?? '').trim() || rec.str(field);

function requireFields(
  rec: Rec,
  input: Record<string, unknown>,
  fields: string[],
  action: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of fields) {
    out[f] = pick(rec, input, f);
    if (!out[f]) missing.push(rec.column(f)?.label ?? f);
  }
  if (missing.length) throw new AbortError(`${action} requires: ${missing.join(', ')}`);
  return out;
}

// ------------------------------------------------------------------ problem

export function assessProblem(ctx: Context, prb: Rec, input: Record<string, unknown> = {}): Rec {
  requireRole(ctx, COORDINATOR, 'assess problems');
  requireState(prb, [PRB_STATE.NEW], 'Assess');
  const values = requireFields(prb, input, ['assignment_group', 'assigned_to'], 'Assess');
  return transition(ctx, prb, PRB_STATE.ASSESS, values, 'assess');
}

export function confirmProblem(ctx: Context, prb: Rec): Rec {
  requireRole(ctx, COORDINATOR, 'confirm problems');
  requireState(prb, [PRB_STATE.ASSESS], 'Confirm');
  return transition(
    ctx,
    prb,
    PRB_STATE.RCA,
    { confirmed_by: ctx.user.sysId, confirmed_at: nowGlide() },
    'confirm',
  );
}

export function markDuplicate(ctx: Context, prb: Rec, duplicateOf: string, reason?: string): Rec {
  requireRole(ctx, COORDINATOR, 'mark problems as duplicates');
  requireState(prb, [PRB_STATE.ASSESS, PRB_STATE.RCA], 'Mark Duplicate');
  if (!duplicateOf) throw new AbortError('Choose the problem this one duplicates');
  if (duplicateOf === prb.sysId) throw new AbortError('A problem cannot be a duplicate of itself');
  const target = ctx.platform.systemContext().get('problem', duplicateOf);
  if (!target) throw new AbortError('The duplicate target problem does not exist');
  if (target.str('duplicate_of') || target.str('resolution_code') === RESOLUTION.DUPLICATE) {
    throw new AbortError('A problem cannot be marked as a duplicate of a problem that is itself a duplicate');
  }
  const values: Record<string, unknown> = {
    duplicate_of: duplicateOf,
    resolution_code: RESOLUTION.DUPLICATE,
  };
  values.work_notes = [`Marked as a duplicate of ${target.str('number')}.`, reason]
    .filter(Boolean)
    .join('\n\n');
  return transition(ctx, prb, PRB_STATE.CLOSED, values, 'mark_duplicate');
}

export function cancelProblem(ctx: Context, prb: Rec, reason?: string): Rec {
  requireRole(ctx, COORDINATOR, 'cancel problems');
  requireState(prb, [PRB_STATE.NEW, PRB_STATE.ASSESS, PRB_STATE.RCA], 'Cancel');
  const values: Record<string, unknown> = { resolution_code: RESOLUTION.CANCELED };
  if (reason) values.work_notes = `Problem canceled: ${reason}`;
  return transition(ctx, prb, PRB_STATE.CLOSED, values, 'cancel');
}

export function fixProblem(ctx: Context, prb: Rec, input: Record<string, unknown> = {}): Rec {
  requireRole(ctx, COORDINATOR, 'start fixing problems');
  requireState(prb, [PRB_STATE.RCA], 'Fix');
  const values = requireFields(prb, input, ['cause_notes', 'fix_notes'], 'Fix');
  return transition(
    ctx,
    prb,
    PRB_STATE.FIX_IN_PROGRESS,
    { ...values, fix_by: ctx.user.sysId, fix_at: nowGlide() },
    'fix',
  );
}

export function acceptRisk(ctx: Context, prb: Rec, input: Record<string, unknown> = {}): Rec {
  requireRole(ctx, COORDINATOR, 'accept the risk of problems');
  requireState(prb, [PRB_STATE.RCA, PRB_STATE.FIX_IN_PROGRESS], 'Accept Risk');
  const values = requireFields(prb, input, ['cause_notes', 'close_notes'], 'Accept Risk');
  const target = propBool(ctx, PRB_PROP.acceptRiskToClosed, true) ? PRB_STATE.CLOSED : PRB_STATE.RESOLVED;
  const extra = target === PRB_STATE.RESOLVED ? { resolved_by: ctx.user.sysId, resolved_at: nowGlide() } : {};
  return transition(
    ctx,
    prb,
    target,
    { ...values, ...extra, resolution_code: RESOLUTION.RISK_ACCEPTED },
    'accept_risk',
  );
}

export function resolveProblem(ctx: Context, prb: Rec, input: Record<string, unknown> = {}): Rec {
  requireRole(ctx, COORDINATOR, 'resolve problems');
  requireState(prb, [PRB_STATE.FIX_IN_PROGRESS], 'Resolve');
  const values = requireFields(prb, input, ['fix_notes'], 'Resolve');
  return transition(
    ctx,
    prb,
    PRB_STATE.RESOLVED,
    {
      ...values,
      resolution_code: RESOLUTION.FIX_APPLIED,
      resolved_by: ctx.user.sysId,
      resolved_at: nowGlide(),
    },
    'resolve',
  );
}

export function completeProblem(ctx: Context, prb: Rec): Rec {
  requireRole(ctx, COORDINATOR, 'complete problems');
  requireState(prb, [PRB_STATE.RESOLVED], 'Complete');
  return transition(ctx, prb, PRB_STATE.CLOSED, {}, 'complete');
}

/** Role needed to re-analyze a resolved or closed problem, by resolution code. */
export function reanalyzeRole(ctx: Context, prb: Rec): string | null {
  switch (prb.str('resolution_code')) {
    case RESOLUTION.DUPLICATE:
      return null;
    case RESOLUTION.CANCELED:
      return propStr(ctx, PRB_PROP.reanalyzeCanceled, 'problem_manager');
    case RESOLUTION.RISK_ACCEPTED:
      return propStr(ctx, PRB_PROP.reanalyzeRiskAccepted, 'problem_manager');
    default:
      return propStr(ctx, PRB_PROP.reanalyzeCompleted, 'problem_manager');
  }
}

export function canReanalyze(prb: Rec, ctx: Context): boolean {
  const state = prb.str('state');
  if (state === PRB_STATE.FIX_IN_PROGRESS) return ctx.hasRole(COORDINATOR);
  if (state !== PRB_STATE.RESOLVED && state !== PRB_STATE.CLOSED) return false;
  const role = reanalyzeRole(ctx, prb);
  return !!role && ctx.hasRole(role);
}

export function reanalyzeProblem(ctx: Context, prb: Rec): Rec {
  const state = prb.str('state');
  requireState(prb, [PRB_STATE.FIX_IN_PROGRESS, PRB_STATE.RESOLVED, PRB_STATE.CLOSED], 'Re-analyze');
  if (state === PRB_STATE.FIX_IN_PROGRESS) {
    requireRole(ctx, COORDINATOR, 're-analyze problems');
    return transition(ctx, prb, PRB_STATE.RCA, { resolution_code: null }, 'reanalyze');
  }
  const role = reanalyzeRole(ctx, prb);
  if (!role) throw new AbortError('Duplicate problems cannot be re-analyzed');
  requireRole(ctx, role, 're-analyze this problem');
  return transition(
    ctx,
    prb,
    PRB_STATE.RCA,
    {
      resolution_code: null,
      reopen_count: (prb.num('reopen_count') ?? 0) + 1,
      reopened_by: ctx.user.sysId,
      reopened_at: nowGlide(),
      resolved_by: null,
      resolved_at: null,
    },
    'reanalyze',
  );
}

// ------------------------------------------------------------- problem task

export function assessTask(ctx: Context, task: Rec, input: Record<string, unknown> = {}): Rec {
  requireRole(ctx, TASK_ANALYST, 'assess problem tasks');
  requireState(task, [PTASK_STATE.NEW], 'Assess');
  const values = requireFields(task, input, ['assignment_group', 'assigned_to'], 'Assess');
  return transition(ctx, task, PTASK_STATE.ASSESS, values);
}

export function startTaskWork(ctx: Context, task: Rec): Rec {
  requireRole(ctx, TASK_ANALYST, 'work problem tasks');
  requireState(task, [PTASK_STATE.ASSESS], 'Start Work');
  return transition(ctx, task, PTASK_STATE.WORK_IN_PROGRESS);
}

export function canReassessTask(task: Rec, ctx: Context): boolean {
  const state = task.str('state');
  if (state === PTASK_STATE.WORK_IN_PROGRESS) return ctx.hasRole(TASK_ANALYST);
  if (state !== PTASK_STATE.CLOSED) return false;
  if (!ctx.hasRole(propStr(ctx, PRB_PROP.taskReassessRole, COORDINATOR))) return false;
  const problemClosed = task.ref('problem')?.str('state') === PRB_STATE.CLOSED;
  return !problemClosed || propBool(ctx, PRB_PROP.taskReassessOnClosedProblem, false);
}

export function reassessTask(ctx: Context, task: Rec): Rec {
  requireState(task, [PTASK_STATE.WORK_IN_PROGRESS, PTASK_STATE.CLOSED], 'Re-assess');
  if (!canReassessTask(task, ctx) && !ctx.user.isSystem)
    throw new AccessError('Insufficient rights to re-assess this problem task');
  if (task.str('state') === PTASK_STATE.WORK_IN_PROGRESS) return transition(ctx, task, PTASK_STATE.ASSESS);
  return transition(ctx, task, PTASK_STATE.ASSESS, {
    close_code: null,
    reopen_count: (task.num('reopen_count') ?? 0) + 1,
  });
}

export function cancelTask(ctx: Context, task: Rec, reason: string): Rec {
  requireRole(ctx, TASK_ANALYST, 'cancel problem tasks');
  requireState(task, OPEN_TASK_STATES, 'Cancel');
  if (!reason?.trim()) throw new AbortError('A reason is required to cancel a problem task');
  return transition(ctx, task, PTASK_STATE.CLOSED, { close_code: 'canceled', close_notes: reason.trim() });
}

export function completeTask(ctx: Context, task: Rec, input: Record<string, unknown> = {}): Rec {
  requireRole(ctx, TASK_ANALYST, 'complete problem tasks');
  requireState(task, [PTASK_STATE.WORK_IN_PROGRESS], 'Complete');
  const fields = task.str('problem_task_type') === 'rca' ? ['cause_code', 'fix_notes'] : ['close_notes'];
  const values = requireFields(task, input, fields, 'Complete');
  return transition(ctx, task, PTASK_STATE.CLOSED, { ...values, close_code: 'complete' });
}

/** Cancels the open tasks of a problem that just closed (system transition). */
export function cancelOpenTasks(ctx: Context, prb: Rec): void {
  const sys = ctx.elevated();
  for (const t of sys.query('problem_task', {
    query: `problem=${prb.sysId}^stateIN${OPEN_TASK_STATES.join(',')}`,
  })) {
    transition(sys, t, PTASK_STATE.CLOSED, {
      close_code: 'canceled',
      close_notes: `Canceled because ${prb.str('number')} was closed`,
    });
  }
}
