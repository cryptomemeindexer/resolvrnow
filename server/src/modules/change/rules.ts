import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { nowGlide } from '../../engine/util.js';
import { approvalRows, cancelApprovals, latestRejectionNote, openApprovalStage } from './approvals.js';
import { onAgendaDecision, onAgendaItemAdded } from './cab.js';
import { autoDetectionAllowed, conflictPrecondition, runConflictDetection } from './conflicts.js';
import {
  APPROVAL_STATES,
  ATTR,
  MODEL_IDS,
  PROP,
  RISK,
  STATE,
  T,
  TASK_STATE,
  TASK_TERMINAL,
} from './constants.js';
import { changeModels, parsePreset } from './model.js';
import { latestAssessmentResult, matchRiskCondition } from './risk.js';
import { recordTemplateOutcome } from './standard.js';
import {
  applyHold,
  cancelAllTasks,
  cancelFlowTasks,
  captureHold,
  createImplementTasks,
  createReviewTask,
} from './tasks.js';
import {
  ChangeTransitionError,
  enforceStatePolicies,
  evaluateAutomaticTransitions,
  validateTransition,
} from './transitions.js';
import { cmdbOf, csv, uniq } from './util.js';

/** CAB involvement is derived from type and risk. */
export function deriveCabRequired(rec: Rec): boolean {
  const type = rec.str('type');
  if (type === 'emergency') return true;
  if (type !== 'normal') return false;
  const risk = rec.num('risk');
  return risk === null || risk !== RISK.LOW;
}

function abortAs(title: string, detail: string): never {
  throw new ChangeTransitionError(title, detail);
}

export const changeRules: BusinessRuleDef[] = [
  // ----------------------------------------------------------- before insert
  {
    name: 'Change: model, preset and initial state',
    table: T.change,
    when: 'before',
    actions: ['insert'],
    order: 5,
    run(cur, _prev, ctx) {
      const models = changeModels(ctx.platform);
      const given = cur.str('chg_model');
      let model = given ? (models.get(given) ?? models.byName(given)) : undefined;
      if (given && !model) abortAs('Invalid change model', `Change model "${given}" does not exist`);
      if (model && !model.active) abortAs('Invalid change model', `Change model "${model.name}" is inactive`);
      if (!model && cur.str('type')) {
        model = models.forType(cur.str('type'));
        if (!model)
          abortAs('Invalid change type', `No change model is available for type "${cur.str('type')}"`);
      }
      model ??= models.defaultModel();
      if (!model) return;
      cur.setRaw('chg_model', model.sysId);
      // The preset decides the type; other preset values fill fields the caller left empty.
      for (const [field, value] of Object.entries(parsePreset(model.preset))) {
        if (!cur.has(field)) continue;
        if (field === 'type' || field === 'unauthorized' || !cur.str(field)) cur.set(field, value);
      }
      cur.setRaw('state', model.initial ?? STATE.NEW);
      if (!cur.str('approval')) cur.setRaw('approval', 'not requested');
      if (!cur.str('conflict_status')) cur.setRaw('conflict_status', 'Not Run');
      if (model.sysId === MODEL_IDS.unauthorized) cur.setRaw('unauthorized', 1);
    },
  },

  // ----------------------------------------------------------- before update
  {
    name: 'Change: type change guard',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 20,
    condition: (cur) => cur.changed('type'),
    run(cur, prev, ctx) {
      const from = prev?.str('type') ?? '';
      const to = cur.str('type');
      if (prev?.num('state') !== STATE.NEW)
        abortAs('Invalid type change', 'The type of a change can only be changed while it is New');
      if (to === 'standard')
        abortAs('Invalid type change', 'Standard changes are created from a standard change template');
      if (!['normal', 'emergency'].includes(to))
        abortAs('Invalid type change', `Unknown change type "${to}"`);
      const pending = approvalRows(ctx, cur.sysId, 'state=requested').length;
      if (pending) abortAs('Invalid type change', 'The type cannot change while approvals are pending');
      const model = changeModels(ctx.platform).forType(to);
      if (model) cur.setRaw('chg_model', model.sysId);
      if (from === 'standard') cur.setRaw('std_change_producer_version', null);
    },
  },
  {
    name: 'Change: configuration item guard',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 25,
    condition: (cur) => cur.changed('cmdb_ci'),
    run(cur, prev, ctx) {
      const svc = changeModels(ctx.platform);
      const model = svc.forRecord(cur);
      const state = prev?.num('state') ?? null;
      if (!model || state === null) return;
      const allowed = svc.modelHasAttribute(model, ATTR.CI_MODIFICATION)
        ? svc.hasAttribute(model, state, ATTR.CI_MODIFICATION)
        : state === model.initial;
      if (!allowed) cur.abort('Configuration item cannot change for Change Requests in this state');
    },
  },
  {
    name: 'Change: planned dates',
    table: T.change,
    when: 'before',
    actions: ['insert', 'update'],
    order: 30,
    condition: (cur) => cur.isNew() || cur.changed('start_date') || cur.changed('end_date'),
    run(cur) {
      const start = cur.str('start_date');
      const end = cur.str('end_date');
      if (start && end && end <= start) cur.abort('Planned end date must be after planned start date');
    },
  },
  {
    name: 'Change: validate state transition',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 40,
    condition: (cur) => cur.changed('state'),
    run(cur, prev, ctx) {
      if (prev) validateTransition(ctx, cur, prev);
    },
  },
  {
    name: 'Change: on hold needs a reason',
    table: T.change,
    when: 'before',
    actions: ['insert', 'update'],
    order: 45,
    condition: (cur) =>
      cur.bool('on_hold') && (cur.isNew() || cur.changed('on_hold') || cur.changed('on_hold_reason')),
    run(cur) {
      if (!cur.str('on_hold_reason').trim())
        cur.abort('An on hold reason is required to put a change on hold');
    },
  },
  {
    name: 'Change: assignment group from configuration item',
    table: T.change,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    condition: (cur) =>
      !!cur.str('cmdb_ci') && !cur.str('assignment_group') && (cur.isNew() || cur.changed('cmdb_ci')),
    run(cur, _prev, ctx) {
      if (!ctx.registry.has('cmdb_ci')) return;
      const ci = ctx.elevated().get('cmdb_ci', cur.str('cmdb_ci'));
      const group = ci?.has('support_group') ? ci.str('support_group') : '';
      if (group) cur.setRaw('assignment_group', group);
    },
  },
  {
    name: 'Change: risk from risk conditions',
    table: T.change,
    when: 'before',
    actions: ['insert', 'update'],
    order: 55,
    condition: (_cur, _prev, ctx) =>
      ctx.platform.properties.get(PROP.riskRule, 'ui_action') === 'business_rule',
    run(cur, _prev, ctx) {
      if (!cur.isNew() && latestAssessmentResult(ctx, cur.sysId)) return;
      const rule = matchRiskCondition(ctx, cur);
      if (!rule) return;
      if (rule.num('risk')) cur.setRaw('risk', rule.num('risk'));
      if (rule.num('impact')) cur.setRaw('impact', rule.num('impact'));
    },
  },
  {
    name: 'Change: state field policies',
    table: T.change,
    when: 'before',
    actions: ['insert', 'update'],
    order: 60,
    run(cur, prev, ctx) {
      enforceStatePolicies(ctx, cur, prev);
    },
  },
  {
    name: 'Change: derive CAB required',
    table: T.change,
    when: 'before',
    actions: ['insert', 'update'],
    order: 70,
    run(cur) {
      const derived = deriveCabRequired(cur) ? 1 : 0;
      if (cur.num('cab_required') !== derived) cur.setRaw('cab_required', derived);
    },
  },
  {
    name: 'Change: state entry defaults',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 200,
    condition: (cur) => cur.changed('state'),
    run(cur, prev) {
      const state = cur.num('state');
      const from = prev?.num('state') ?? null;
      const now = nowGlide();
      if (state !== null && APPROVAL_STATES.includes(state)) cur.setRaw('approval', 'requested');
      if (state === STATE.SCHEDULED && cur.str('approval') !== 'approved') cur.setRaw('approval', 'approved');
      if (
        state === STATE.NEW &&
        from !== null &&
        APPROVAL_STATES.includes(from) &&
        cur.str('approval') !== 'rejected'
      ) {
        cur.setRaw('approval', 'not requested');
      }
      if (state === STATE.IMPLEMENT && !cur.str('work_start')) cur.setRaw('work_start', now);
      if (state === STATE.REVIEW) {
        if (from === STATE.IMPLEMENT && !cur.str('work_end')) cur.setRaw('work_end', now);
        if (!cur.str('review_date')) cur.setRaw('review_date', now.slice(0, 10));
        if (!cur.str('review_status')) cur.setRaw('review_status', 1);
      }
      if (state === STATE.CLOSED && (!cur.str('review_status') || cur.num('review_status') === 1)) {
        const map: Record<string, number> = { successful: 2, successful_issues: 3, unsuccessful: 4 };
        const status = map[cur.str('close_code')];
        if (status) cur.setRaw('review_status', status);
      }
      if (state === STATE.CANCELED && cur.bool('on_hold')) {
        cur.setRaw('on_hold', 0);
      }
    },
  },
  {
    name: 'Change: approval outcome notes',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 205,
    condition: (cur) =>
      cur.changed('approval') && cur.str('approval') === 'rejected' && !cur.changed('work_notes'),
    run(cur, _prev, ctx) {
      cur.set('work_notes', latestRejectionNote(ctx, cur.sysId));
    },
  },
  {
    name: 'Change: on hold bookkeeping',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 210,
    condition: (cur) => cur.changed('on_hold'),
    run(cur, _prev, ctx) {
      captureHold(ctx, cur);
    },
  },
  {
    name: 'Change: clearing the unauthorized flag',
    table: T.change,
    when: 'before',
    actions: ['update'],
    order: 220,
    condition: (cur, prev) => !!prev?.bool('unauthorized') && !cur.bool('unauthorized'),
    run(cur, _prev, ctx) {
      if (!cur.changed('work_notes')) {
        cur.abort('Explain in the work notes why the unauthorized flag is cleared');
        return;
      }
      if (cur.str('chg_model') === MODEL_IDS.unauthorized) {
        const emergency = changeModels(ctx.platform).forType('emergency');
        const state = cur.num('state');
        if (emergency && state !== null && emergency.states.has(state))
          cur.setRaw('chg_model', emergency.sysId);
      }
    },
  },

  // ------------------------------------------------------------ after rules
  {
    name: 'Change: approvals on state entry',
    table: T.change,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('state'),
    run(cur, prev, ctx) {
      const state = cur.num('state');
      const from = prev?.num('state') ?? null;
      if (state !== null && APPROVAL_STATES.includes(state)) {
        openApprovalStage(ctx, cur.sysId);
        return;
      }
      if (state === STATE.NEW && from !== null && APPROVAL_STATES.includes(from)) {
        const rejected = cur.str('approval') === 'rejected';
        cancelApprovals(
          ctx,
          cur,
          rejected ? 'Change rejected' : 'Change reverted to New',
          rejected ? undefined : 'not requested',
        );
      }
      if (state === STATE.CANCELED) cancelApprovals(ctx, cur, 'Change canceled');
    },
  },
  {
    name: 'Change: tasks on state entry',
    table: T.change,
    when: 'after',
    actions: ['update'],
    order: 150,
    condition: (cur) => cur.changed('state'),
    run(cur, prev, ctx) {
      const state = cur.num('state');
      if (state === STATE.IMPLEMENT) createImplementTasks(ctx, cur);
      if (state === STATE.REVIEW) {
        cancelFlowTasks(ctx, cur);
        if (
          prev?.num('state') === STATE.AUTHORIZE &&
          cur.str('chg_model') === MODEL_IDS.unauthorized &&
          cur.str('approval') === 'approved'
        ) {
          createReviewTask(ctx, cur);
        }
      }
      if (state === STATE.CANCELED) cancelAllTasks(ctx, cur);
      if (state === STATE.CLOSED) recordTemplateOutcome(ctx, cur);
    },
  },
  {
    name: 'Change: on hold sync',
    table: T.change,
    when: 'after',
    actions: ['update'],
    order: 160,
    condition: (cur) => cur.changed('on_hold'),
    run(cur, prev, ctx) {
      applyHold(ctx, cur, prev);
    },
  },
  {
    name: 'Change: refresh impacted services when leaving New',
    table: T.change,
    when: 'after',
    actions: ['update'],
    order: 180,
    condition: (cur, prev) =>
      cur.changed('state') && prev?.num('state') === STATE.NEW && cur.num('state') !== STATE.CANCELED,
    run(cur, _prev, ctx) {
      refreshImpactedServices(ctx, cur);
    },
  },
  {
    name: 'Change: events',
    table: T.change,
    when: 'after',
    actions: ['insert', 'update'],
    order: 800,
    run(cur, prev, ctx) {
      queueChangeEvents(ctx, cur, prev);
    },
  },
  {
    name: 'Change: evaluate automatic transitions',
    table: T.change,
    when: 'after',
    actions: ['update'],
    order: 950,
    condition: (cur) => cur.changed('state') || cur.changed('approval') || cur.changed('on_hold'),
    run(cur, _prev, ctx) {
      evaluateAutomaticTransitions(ctx, cur.sysId);
    },
  },
  {
    name: 'Change: automatic conflict detection',
    table: T.change,
    when: 'async',
    actions: ['insert', 'update'],
    order: 100,
    condition: (cur, prev, ctx) => {
      if (!ctx.platform.properties.getBool(PROP.conflictAuto, true)) return false;
      if (!cur.bool('active') || conflictPrecondition(cur)) return false;
      if (!prev) return true;
      return ['cmdb_ci', 'start_date', 'end_date', 'state', 'assigned_to'].some(
        (f) => String(cur.get(f) ?? '') !== String(prev.get(f) ?? ''),
      );
    },
    run(cur, _prev, ctx) {
      if (!autoDetectionAllowed(ctx, cur)) return;
      runConflictDetection(ctx, cur.sysId);
    },
  },
  {
    name: 'Change: delete related records',
    table: T.change,
    when: 'after',
    actions: ['delete'],
    order: 100,
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      for (const table of [T.taskCi, T.taskService, T.taskOffering]) {
        if (!ctx.registry.has(table)) continue;
        for (const r of sys.query(table, `task=${cur.sysId}`)) sys.delete(r);
      }
      for (const r of approvalRows(ctx, cur.sysId)) {
        try {
          sys.delete(r);
        } catch {
          /* the approvals module may protect decided approvals */
        }
      }
    },
  },
];

/** Rebuilds automatically added impacted services from the primary CI (manual rows kept). */
export function refreshImpactedServices(ctx: Context, change: Rec): number {
  const cmdb = cmdbOf(ctx.platform);
  const ci = change.str('cmdb_ci');
  if (!cmdb || !ci || !ctx.registry.has(T.taskService)) return 0;
  const sys = ctx.elevated();
  let services: Rec[] = [];
  try {
    services = cmdb.impactedServices(sys, ci);
  } catch {
    return 0;
  }
  for (const r of sys.query(T.taskService, `task=${change.sysId}^manually_added!=true`)) sys.delete(r);
  const ids = uniq(services.map((s) => s.sysId));
  for (const id of ids)
    sys.insert(T.taskService, { task: change.sysId, cmdb_ci_service: id, manually_added: false });
  return ids.length;
}

function queueChangeEvents(ctx: Context, cur: Rec, prev: Rec | null): void {
  if (!prev) {
    ctx.queueEvent('change_request.inserted', cur, cur.str('state'), null);
    if (cur.bool('unauthorized'))
      ctx.queueEvent('change.unauthorized.created', cur, cur.str('cmdb_ci') || null, null);
    return;
  }
  ctx.queueEvent('change_request.updated', cur, null, null);
  if (cur.changed('state')) {
    const state = cur.str('state');
    ctx.queueEvent('change.state_changed', cur, state, prev.str('state'));
    if (cur.num('state') === STATE.CANCELED) ctx.queueEvent('change.canceled', cur, null, null);
    if (cur.num('state') === STATE.CLOSED) ctx.queueEvent('change.closed', cur, cur.str('close_code'), null);
    const props = ctx.platform.properties;
    if (props.getBool(PROP.stateEventEnabled, false)) {
      const states = csv(props.get(PROP.stateEventStates, ''));
      if (!states.length || states.includes(state))
        ctx.queueEvent('sn_change.state.updated', cur, state, prev.str('state'));
    }
  }
  if (cur.changed('approval')) {
    const approval = cur.str('approval');
    if (approval === 'requested') ctx.queueEvent('change.approval_requested', cur, cur.str('state'), null);
    if (approval === 'approved') ctx.queueEvent('change.approved', cur, cur.str('state'), null);
    if (approval === 'rejected') ctx.queueEvent('change.rejected', cur, prev.str('state'), null);
  }
  if (cur.changed('on_hold'))
    ctx.queueEvent(
      cur.bool('on_hold') ? 'change.on_hold' : 'change.released',
      cur,
      cur.str('on_hold_reason') || null,
      null,
    );
}

// -------------------------------------------------------------- change tasks

export const taskRules: BusinessRuleDef[] = [
  {
    name: 'Change task: parent change',
    table: T.task,
    when: 'before',
    actions: ['insert', 'update'],
    order: 10,
    condition: (cur) => cur.isNew() || cur.changed('change_request'),
    run(cur, _prev, ctx) {
      const change = ctx.elevated().get(T.change, cur.str('change_request'));
      if (!change) {
        cur.abort('A change task must belong to a change request');
        return;
      }
      if (!change.bool('active')) {
        cur.abort(`Change tasks cannot be added to ${change.str('number')} because it is closed or canceled`);
        return;
      }
      cur.setRaw('parent', change.sysId);
    },
  },
  {
    name: 'Change task: final states',
    table: T.task,
    when: 'before',
    actions: ['update'],
    order: 20,
    condition: (cur) => cur.changed('state'),
    run(cur, prev) {
      const from = prev?.num('state') ?? null;
      if (from !== null && TASK_TERMINAL.includes(from))
        cur.abort('Closed or canceled change tasks cannot be reopened');
    },
  },
  {
    name: 'Change task: close fields',
    table: T.task,
    when: 'before',
    actions: ['insert', 'update'],
    order: 30,
    condition: (cur) => cur.num('state') === TASK_STATE.CLOSED && (cur.isNew() || cur.changed('state')),
    run(cur) {
      const missing = ['close_code', 'close_notes'].filter((f) => !cur.str(f).trim());
      if (missing.length) {
        cur.abort(
          `Mandatory fields must be populated: ${missing.map((f) => cur.column(f)?.label ?? f).join(', ')}`,
        );
      }
    },
  },
  {
    name: 'Change task: planned window',
    table: T.task,
    when: 'before',
    actions: ['insert', 'update'],
    order: 40,
    condition: (cur) =>
      cur.isNew() ||
      cur.changed('planned_start_date') ||
      cur.changed('planned_end_date') ||
      cur.changed('change_task_type') ||
      cur.changed('change_request'),
    run(cur, _prev, ctx) {
      const start = cur.str('planned_start_date');
      const end = cur.str('planned_end_date');
      if (start && end && end <= start) {
        cur.abort('Planned end date must be after planned start date');
        return;
      }
      if (cur.str('change_task_type') !== 'implementation' || (!start && !end)) return;
      const change = ctx.elevated().get(T.change, cur.str('change_request'));
      const cs = change?.str('start_date') ?? '';
      const ce = change?.str('end_date') ?? '';
      if (!cs || !ce) return;
      if ((start && (start < cs || start > ce)) || (end && (end < cs || end > ce))) {
        cur.abort(
          `Planned dates of an implementation task must be within the change's planned window (${cs} to ${ce})`,
        );
      }
    },
  },
  {
    name: 'Change task: parent model evaluation',
    table: T.task,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('active') && !cur.bool('active'),
    run(cur, _prev, ctx) {
      evaluateAutomaticTransitions(ctx, cur.str('change_request'));
    },
  },
  {
    name: 'Change task: assignment event',
    table: T.task,
    when: 'after',
    actions: ['insert', 'update'],
    order: 800,
    condition: (cur) => !!cur.str('assigned_to') && (cur.isNew() || cur.changed('assigned_to')),
    run(cur, _prev, ctx) {
      ctx.queueEvent('change_task.assigned', cur, cur.str('assigned_to'), null);
    },
  },
];

// ------------------------------------------------------------- other tables

export const otherRules: BusinessRuleDef[] = [
  {
    name: 'CAB agenda item: set CAB date on the change',
    table: T.agendaItem,
    when: 'after',
    actions: ['insert'],
    order: 100,
    run(cur, _prev, ctx) {
      onAgendaItemAdded(ctx, cur);
    },
  },
  {
    name: 'CAB agenda item: record decision',
    table: T.agendaItem,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('decision') && !!cur.str('decision'),
    run(cur, _prev, ctx) {
      onAgendaDecision(ctx, cur);
    },
  },
  {
    name: 'CAB meeting: end after start',
    table: T.cabMeeting,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur) {
      if (cur.str('start') && cur.str('end') && cur.str('end') <= cur.str('start'))
        cur.abort('The meeting must end after it starts');
    },
  },
  {
    name: 'Change model: one model per ITIL process',
    table: T.model,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    condition: (cur) =>
      !!cur.str('itil_change_process') &&
      cur.bool('active') &&
      (cur.isNew() || cur.changed('itil_change_process') || cur.changed('active')),
    run(cur, _prev, ctx) {
      const dup = ctx
        .elevated()
        .first(
          T.model,
          `itil_change_process=${cur.str('itil_change_process')}^active=true^sys_id!=${cur.sysId}`,
        );
      if (dup)
        cur.abort(
          `The ${cur.display('itil_change_process')} process is already designated to the ${dup.str('name')} model`,
        );
    },
  },
  {
    name: 'Risk assessment threshold: valid risk',
    table: T.threshold,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur) {
      const r = cur.num('risk');
      if (r === null || r < 1 || r > 4) cur.abort('Threshold risk must be Very High, High, Moderate or Low');
    },
  },
];
