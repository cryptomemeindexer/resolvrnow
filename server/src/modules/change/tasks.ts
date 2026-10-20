import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { approvalRows, openApprovalStage } from './approvals.js';
import { PROP, T, TASK_STATE } from './constants.js';
import { approvalsOf, csv, groupByName } from './util.js';

const FLOW_TASKS = [
  { short_description: 'Implement', change_task_type: 'implementation' },
  { short_description: 'Post-implementation testing', change_task_type: 'testing' },
];

export function activeTasks(ctx: Context, changeId: string, extra = ''): Rec[] {
  return ctx.elevated().query(T.task, {
    query: `change_request=${changeId}^active=true${extra ? `^${extra}` : ''}`,
    orderBy: [{ field: 'number', desc: false }],
  });
}

/** Entering Implement: the implementation and post-implementation testing tasks. */
export function createImplementTasks(ctx: Context, change: Rec): Rec[] {
  if (!ctx.platform.properties.getBool(PROP.implementTasks, true)) return [];
  const sys = ctx.elevated();
  if (activeTasks(ctx, change.sysId, 'created_from=workflow').length) return [];
  return FLOW_TASKS.map((def) =>
    sys.insert(T.task, {
      change_request: change.sysId,
      short_description: def.short_description,
      description: `${def.short_description}: ${change.str('short_description')}`,
      change_task_type: def.change_task_type,
      created_from: 'workflow',
      assignment_group: change.str('assignment_group') || null,
      assigned_to: change.str('assigned_to') || null,
      cmdb_ci: change.str('cmdb_ci') || null,
      planned_start_date: change.str('start_date') || null,
      planned_end_date: change.str('end_date') || null,
    }),
  );
}

/** Entering Review: open tasks created by the change process are canceled; manual tasks stay. */
export function cancelFlowTasks(ctx: Context, change: Rec): number {
  const sys = ctx.elevated();
  const tasks = activeTasks(ctx, change.sysId, 'created_from=workflow');
  for (const t of tasks) {
    sys.update(t, {
      state: TASK_STATE.CANCELED,
      work_notes: `Canceled automatically: ${change.str('number')} moved to Review.`,
    });
  }
  return tasks.length;
}

/** Canceling the change cancels all of its active tasks. */
export function cancelAllTasks(ctx: Context, change: Rec): number {
  const sys = ctx.elevated();
  const tasks = activeTasks(ctx, change.sysId);
  for (const t of tasks) {
    sys.update(t, {
      state: TASK_STATE.CANCELED,
      on_hold: false,
      work_notes: `Canceled because ${change.str('number')} was canceled.`,
    });
  }
  return tasks.length;
}

/** Unauthorized change authorized: a post-implementation review task for Change Management. */
export function createReviewTask(ctx: Context, change: Rec): Rec | null {
  const sys = ctx.elevated();
  if (activeTasks(ctx, change.sysId, 'change_task_type=review').length) return null;
  const mgmt = groupByName(
    ctx,
    ctx.platform.properties.get(PROP.managementGroup, 'Change Management') ?? 'Change Management',
  );
  return sys.insert(T.task, {
    change_request: change.sysId,
    short_description: 'Post Implementation Review',
    description: `Review the unauthorized change ${change.str('number')}: ${change.str('short_description')}`,
    change_task_type: 'review',
    created_from: 'workflow',
    assignment_group: mgmt?.sysId ?? (change.str('assignment_group') || null),
    cmdb_ci: change.str('cmdb_ci') || null,
  });
}

/** Marker stored in resolvr_hold_approvals when a hold suspends an approval stage. */
const HOLD_MARKER = 'stage:';

/** Before rule half of the hold sync: remember which tasks and which approval stage the hold parks. */
export function captureHold(ctx: Context, cur: Rec): void {
  if (cur.bool('on_hold')) {
    const tasks = activeTasks(ctx, cur.sysId, 'on_hold!=true').map((t) => t.sysId);
    cur.setRaw('on_hold_task', tasks.join(',') || null);
    const state = cur.num('state');
    const pending = approvalRows(ctx, cur.sysId, 'stateINrequested,not requested').length > 0;
    cur.setRaw('resolvr_hold_approvals', pending && state !== null ? `${HOLD_MARKER}${state}` : null);
  } else {
    cur.setRaw('on_hold_task', null);
    cur.setRaw('resolvr_hold_approvals', null);
  }
}

/**
 * After rule half of the hold sync. Tasks are held and released. Pending approvals of the
 * current stage are withdrawn while the change is on hold and requested again on release
 * (the approvals service has no suspended state).
 */
export function applyHold(ctx: Context, cur: Rec, prev: Rec | null): void {
  const sys = ctx.elevated();
  const svc = approvalsOf(ctx.platform);
  if (cur.bool('on_hold')) {
    for (const id of csv(cur.str('on_hold_task'))) {
      const t = sys.get(T.task, id);
      if (t?.bool('active')) sys.update(t, { on_hold: true, on_hold_reason: cur.str('on_hold_reason') });
    }
    if (svc && cur.str('resolvr_hold_approvals').startsWith(HOLD_MARKER)) {
      const fresh = sys.get(T.change, cur.sysId);
      if (fresh) svc.cancel(sys, fresh, `Change put on hold: ${cur.str('on_hold_reason')}`);
    }
    return;
  }
  if (!prev) return;
  for (const id of csv(prev.str('on_hold_task'))) {
    const t = sys.get(T.task, id);
    if (t?.bool('on_hold')) sys.update(t, { on_hold: false, on_hold_reason: '' });
  }
  const marker = prev.str('resolvr_hold_approvals');
  if (
    svc &&
    marker.startsWith(HOLD_MARKER) &&
    Number(marker.slice(HOLD_MARKER.length)) === cur.num('state')
  ) {
    openApprovalStage(ctx, cur.sysId);
  }
}
