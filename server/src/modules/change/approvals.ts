import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { nowGlide } from '../../engine/util.js';
import type { ApprovalDecision, ApprovalRequest } from '../contracts.js';
import { APPROVAL_STATES, MODEL_IDS, PROP, RISK, STATE, T } from './constants.js';
import { changeModels } from './model.js';
import { evaluateAutomaticTransitions } from './transitions.js';
import { approvalsOf, groupByName, groupMembers, isActiveUser, usersWithRole } from './util.js';

export interface StagePlan {
  stage: string;
  request?: ApprovalRequest;
  /** Set when no approval is needed; the stage is approved automatically with this reason. */
  skip?: string;
}

/** Approval rows (sysapproval_approver) of a record, optionally filtered by an encoded query. */
export function approvalRows(ctx: Context, recordId: string, extra = ''): Rec[] {
  if (!ctx.registry.has(T.approval)) return [];
  const meta = ctx.registry.table(T.approval);
  const terms: string[] = [];
  if (meta.columns.has('document_id')) terms.push(`document_id=${recordId}`);
  if (meta.columns.has('sysapproval')) terms.push(`sysapproval=${recordId}`);
  if (!terms.length) return [];
  return ctx.elevated().query(T.approval, `${terms.join('^OR')}${extra ? `^${extra}` : ''}`);
}

function isUnauthorizedModel(change: Rec): boolean {
  return change.str('chg_model') === MODEL_IDS.unauthorized;
}

/** Decides who approves the stage the change just entered (Assess or Authorize). */
export function planStage(ctx: Context, change: Rec): StagePlan | null {
  const state = change.num('state');
  const props = ctx.platform.properties;
  const sys = ctx.elevated();
  const groupId = change.str('assignment_group');
  const group = groupId ? sys.get('sys_user_group', groupId) : null;
  const manager = group?.str('manager') ?? '';
  const managerOk = isActiveUser(ctx, manager);

  if (state === STATE.ASSESS) {
    const stage = 'Technical approval';
    const members = groupMembers(ctx, groupId);
    if (props.get(PROP.assessApprover, 'group') === 'manager' && managerOk) {
      return { stage, request: { users: [manager], rule: 'any', stage } };
    }
    if (members.length) return { stage, request: { groups: [groupId], rule: 'first', stage } };
    if (managerOk) return { stage, request: { users: [manager], rule: 'any', stage } };
    return { stage, skip: 'no technical approver was found for the assignment group' };
  }
  if (state !== STATE.AUTHORIZE) return null;

  if (isUnauthorizedModel(change)) {
    const stage = 'Unauthorized change authorization';
    const mgmt = groupByName(
      ctx,
      props.get(PROP.managementGroup, 'Change Management') ?? 'Change Management',
    );
    if (mgmt && groupMembers(ctx, mgmt.sysId).length)
      return { stage, request: { groups: [mgmt.sysId], rule: 'first', stage } };
    return cabPlan(ctx, change, stage);
  }

  const risk = change.num('risk');
  if (change.str('type') === 'normal' && risk === RISK.LOW && !change.bool('cab_required')) {
    const stage = 'Manager authorization';
    if (managerOk) {
      const approvedInAssess =
        approvalRows(ctx, change.sysId, `approver=${manager}^state=approved`).length > 0;
      if (approvedInAssess)
        return {
          stage,
          skip: 'the assignment group manager already approved this low risk change during assessment',
        };
      return { stage, request: { users: [manager], rule: 'any', stage } };
    }
  }
  return cabPlan(ctx, change, 'CAB authorization');
}

function cabPlan(ctx: Context, change: Rec, stage: string): StagePlan {
  const props = ctx.platform.properties;
  const cab = groupByName(ctx, props.get(PROP.cabGroup, 'CAB Approval') ?? 'CAB Approval');
  if (cab && groupMembers(ctx, cab.sysId).length)
    return { stage, request: { groups: [cab.sysId], rule: 'first', stage } };
  const changeManager = change.str('change_manager');
  if (isActiveUser(ctx, changeManager))
    return { stage, request: { users: [changeManager], rule: 'any', stage } };
  const managers = usersWithRole(ctx, 'change_manager');
  if (managers.length) return { stage, request: { users: managers, rule: 'first', stage } };
  return { stage, skip: 'no CAB member or change manager was found' };
}

/**
 * Opens the approval stage of the state the change just entered. With the approvals
 * service the approvers are requested; without it change managers decide through the
 * Approve / Reject UI actions (or the REST approvals endpoint).
 */
export function openApprovalStage(ctx: Context, changeId: string): void {
  const svc = approvalsOf(ctx.platform);
  if (!svc) return;
  const sys = ctx.elevated();
  const change = sys.get(T.change, changeId);
  if (!change || !APPROVAL_STATES.includes(change.num('state') ?? 0)) return;
  const plan = planStage(ctx, change);
  if (!plan) return;
  if (plan.skip || !plan.request) {
    sys.update(change, {
      approval: 'approved',
      work_notes: `${plan.stage} skipped: ${plan.skip ?? 'no approvers'}.`,
    });
    return;
  }
  svc.request(sys, change, { ...plan.request, due: change.str('start_date') || undefined });
}

/**
 * Cancels outstanding approvals of a change (revert, cancel). With `resetTo`, the approval
 * roll-up the service leaves behind ("cancelled") is replaced, e.g. by "not requested".
 */
export function cancelApprovals(ctx: Context, change: Rec, reason: string, resetTo?: string): void {
  const svc = approvalsOf(ctx.platform);
  if (!svc) return;
  const sys = ctx.elevated();
  const fresh = sys.get(T.change, change.sysId) ?? change;
  svc.cancel(sys, fresh, reason);
  if (!resetTo) return;
  const after = sys.get(T.change, change.sysId);
  if (after && after.str('approval') !== resetTo && after.str('approval') === 'cancelled') {
    sys.derive({ workflow: false }).update(after, { approval: resetTo });
  }
}

/** Work note recorded when a change is rejected: who rejected it and their comments. */
export function latestRejectionNote(ctx: Context, changeId: string): string {
  const rows = approvalRows(ctx, changeId, 'state=rejected^ORDERBYDESCsys_updated_on');
  const row = rows[0];
  if (!row) return 'Change rejected.';
  const who = row.display('approver') || 'an approver';
  const comments = ctx.platform.history.journal(T.approval, row.sysId, ['comments']);
  const latest = comments.sort((a, b) => b.sys_created_on.localeCompare(a.sys_created_on))[0]?.value ?? '';
  return `Change rejected by ${who}${latest ? `: ${latest}` : '.'}`;
}

/**
 * Handler registered with the approvals service for change requests. It records the
 * outcome on the change; the model's automatic transitions then move the change on
 * (approved: next stage, rejected: back to New).
 */
export function onChangeDecision(target: Rec, decision: ApprovalDecision, ctx: Context): void {
  const sys = ctx.elevated();
  const change = sys.get(T.change, target.sysId);
  if (!change) return;
  if (!APPROVAL_STATES.includes(change.num('state') ?? 0)) return;
  const svc = approvalsOf(ctx.platform);
  if (svc) {
    let aggregate: string | undefined;
    try {
      aggregate = svc.stateOf(sys, change);
    } catch {
      aggregate = undefined;
    }
    // A decision for an earlier stage arriving after the next stage opened is ignored.
    if (aggregate && aggregate !== decision) return;
  }
  if (change.str('approval') === decision) {
    evaluateAutomaticTransitions(sys, change.sysId);
    return;
  }
  // The rejection work note is added by the "approval outcome" rule.
  sys.update(change, { approval: decision });
}

/** Pending approval of the current user (directly or as an approval delegate) for a record. */
export function pendingApprovalFor(ctx: Context, recordId: string): Rec | null {
  const me = ctx.user.sysId;
  if (!me) return null;
  const mine = approvalRows(ctx, recordId, `state=requested^approver=${me}`);
  if (mine.length) return mine[0];
  if (!ctx.registry.has('sys_user_delegate')) return null;
  const now = nowGlide();
  const delegators = ctx
    .elevated()
    .query('sys_user_delegate', `delegate=${me}^approvals=true`)
    .filter((d) => (!d.str('starts') || d.str('starts') <= now) && (!d.str('ends') || d.str('ends') > now))
    .map((d) => d.str('user'))
    .filter(Boolean);
  if (!delegators.length) return null;
  return approvalRows(ctx, recordId, `state=requested^approverIN${delegators.join(',')}`)[0] ?? null;
}

/** True when change managers decide approvals directly (no approvals service installed). */
export function usesFallbackApprovals(ctx: Context): boolean {
  return !approvalsOf(ctx.platform);
}

export function canDecideDirectly(ctx: Context): boolean {
  return ctx.hasRole('change_manager') || ctx.hasRole('admin');
}

/**
 * Records an approval decision on a change without the approvals service: used by the
 * change manager fallback (UI actions and REST). The model then moves the change on.
 */
export function directDecision(ctx: Context, change: Rec, decision: ApprovalDecision, comments = ''): Rec {
  const state = change.num('state') ?? 0;
  if (!APPROVAL_STATES.includes(state)) throw new InvalidError('The change is not awaiting approval');
  if (change.bool('on_hold')) throw new InvalidError('The change is on hold: release it before deciding');
  if (decision === 'rejected' && !comments.trim())
    throw new InvalidError('Comments are required when rejecting a change');
  const who = ctx.user.name || ctx.user.userName;
  const stage = state === STATE.ASSESS ? 'assessment' : 'authorization';
  const note =
    decision === 'approved'
      ? `Change ${stage} approved by ${who}${comments ? `: ${comments}` : '.'}`
      : `Change rejected by ${who}: ${comments}`;
  ctx.update(change, { approval: decision, work_notes: note });
  return ctx.elevated().get(T.change, change.sysId) ?? change;
}

/** Approver decision through the approvals service (the caller's own pending approval). */
export function decideAsApprover(ctx: Context, change: Rec, decision: ApprovalDecision, comments = ''): Rec {
  const svc = approvalsOf(ctx.platform);
  if (!svc) throw new InvalidError('Approvals are not installed');
  const row = pendingApprovalFor(ctx, change.sysId);
  if (!row) throw new InvalidError('User lacks authority to approve or reject this change');
  if (decision === 'rejected' && !comments.trim())
    throw new InvalidError('Comments are required when rejecting a change');
  svc.decide(ctx, row, decision, comments || undefined);
  return ctx.elevated().get(T.change, change.sysId) ?? change;
}

/** Model helper: the request approval target state from the current state, if any. */
export function requestApprovalTarget(ctx: Context, change: Rec): number | null {
  const model = changeModels(ctx.platform).forRecord(change);
  const from = change.num('state');
  if (!model || from === null) return null;
  const manual = model.transitions.filter((t) => t.from === from && !t.automatic);
  for (const target of [STATE.ASSESS, STATE.AUTHORIZE]) {
    if (manual.some((t) => t.to === target)) return target;
  }
  if (from === STATE.NEW && manual.some((t) => t.to === STATE.SCHEDULED)) return STATE.SCHEDULED;
  return null;
}
