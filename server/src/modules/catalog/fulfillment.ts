/**
 * Request fulfillment: the requested item stage machine (spec 7.3), item and
 * request approvals through the approvals service, the built-in fulfillment engine
 * (ordered fulfillment steps become catalog tasks), flow hand-off, state roll-ups to
 * the requested item and the request, and cancellation.
 */
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { addMs, nowGlide } from '../../engine/util.js';
import {
  type ApprovalDecision,
  type ApprovalService,
  type FlowService,
  optionalService,
  SERVICES,
} from '../contracts.js';
import { APPROVAL, PROP, REQ_STATE, STAGE, STATE, T, VT } from './constants.js';
import { displayAnswer, loadForm, readAnswers, variableSubject } from './variables.js';

export interface StepDef {
  id: string | null;
  order: number;
  name: string;
  shortDescription: string;
  description: string;
  assignmentGroup: string;
  assignedTo: string;
  stage: string;
  priority: string;
  condition: string;
  includeVariables: boolean;
}

/** Combines child states: any incomplete -> incomplete, all skipped -> skipped, else complete (spec 7.3). */
export function rollupState(states: string[]): string {
  if (states.includes(STATE.incomplete)) return STATE.incomplete;
  if (states.length && states.every((s) => s === STATE.skipped)) return STATE.skipped;
  return STATE.complete;
}

const REQ_CLOSED_BY_STATE: Record<string, string> = {
  [STATE.complete]: REQ_STATE.closedComplete,
  [STATE.incomplete]: REQ_STATE.closedIncomplete,
  [STATE.skipped]: REQ_STATE.closedSkipped,
};

/** Expands `${name}` placeholders with variable answers, then requested item fields (dot-walks allowed). */
export function renderTemplate(template: string, values: Record<string, string>, ritm: Rec | null): string {
  return template.replace(/\$\{\s*([a-zA-Z0-9_.]+)\s*\}/g, (_m, key: string) => {
    if (key in values) return values[key];
    if (ritm) {
      const head = key.split('.')[0];
      if (ritm.has(head)) return ritm.display(key);
    }
    return '';
  });
}

export class Fulfillment {
  constructor(private platform: Platform) {}

  approvals(): ApprovalService | undefined {
    return optionalService<ApprovalService>(this.platform, SERVICES.approvals);
  }

  flows(): FlowService | undefined {
    return optionalService<FlowService>(this.platform, SERVICES.flows);
  }

  /** Elevated context keeping the caller's identity (automation must see every record). */
  private sys(ctx: Context): Context {
    return ctx.elevated();
  }

  // ----------------------------------------------------------- request level

  /** Request-level approval (optional price threshold) and start of every requested item. */
  startRequest(ctx: Context, requestId: string): void {
    const sys = this.sys(ctx);
    const req = sys.get(T.request, requestId);
    if (!req?.bool('active') || req.str('request_state') !== REQ_STATE.requested) return;
    if (req.str('approval') === APPROVAL.requested) return;
    const threshold = Number(this.platform.properties.get(PROP.requestApprovalThreshold) ?? '-1');
    const approvals = this.approvals();
    if (Number.isFinite(threshold) && threshold >= 0 && (req.num('price') ?? 0) > threshold && approvals) {
      const manager = req.ref('requested_for')?.str('manager') ?? '';
      if (manager) {
        sys.update(req, { stage: 'waiting_for_approval' });
        approvals.request(sys, sys.get(T.request, requestId) ?? req, {
          users: [manager],
          stage: 'Request approval',
        });
        return;
      }
    }
    this.requestApproved(sys, requestId, true);
  }

  /** Approvals service callback for requests. */
  onRequestDecision(ctx: Context, requestId: string, decision: ApprovalDecision): void {
    const sys = this.sys(ctx);
    const req = sys.get(T.request, requestId);
    if (!req?.bool('active') || req.str('request_state') !== REQ_STATE.requested) return;
    if (decision === APPROVAL.approved) {
      this.requestApproved(sys, requestId, false);
      return;
    }
    sys.update(req, {
      approval: APPROVAL.rejected,
      request_state: REQ_STATE.closedRejected,
      stage: 'closed_rejected',
      state: STATE.incomplete,
    });
    for (const ritm of sys.query(T.ritm, { query: `request=${requestId}^active=true` })) {
      this.cancelItem(sys, ritm, 'The request was rejected', APPROVAL.rejected);
    }
  }

  private requestApproved(sys: Context, requestId: string, automatic: boolean): void {
    const req = sys.get(T.request, requestId);
    if (!req) return;
    const values: Record<string, unknown> = {
      approval: APPROVAL.approved,
      request_state: REQ_STATE.inProcess,
    };
    if (!automatic && req.has('approval_set') && !req.str('approval_set')) values.approval_set = nowGlide();
    sys.update(req, values);
    for (const ritm of sys.query(T.ritm, {
      query: `request=${requestId}^active=true`,
      orderBy: [{ field: 'number', desc: false }],
    })) {
      this.startItem(sys, ritm.sysId);
    }
    this.rollupRequest(sys, requestId);
  }

  // -------------------------------------------------------------- item level

  /** Starts a requested item: its flow when it has one, else approvals then the built-in steps. */
  startItem(ctx: Context, ritmId: string): void {
    const sys = this.sys(ctx);
    const ritm = sys.get(T.ritm, ritmId);
    if (!ritm?.bool('active') || ritm.str('stage') !== STAGE.waiting) return;
    if (ritm.str('approval') !== APPROVAL.notRequested || ritm.str('flow_context')) return;
    const item = ritm.ref('cat_item');
    const flowRef = item ? item.str('flow') || item.str('flow_designer_flow') : '';
    const flows = this.flows();
    if (item && flowRef && flows) {
      const fc = flows.start(sys, flowRef, ritm, this.flowInputs(sys, ritm));
      if (fc) {
        sys.update(sys.get(T.ritm, ritmId) ?? ritm, {
          flow_context: fc.sysId,
          work_notes: `Fulfillment flow ${fc.displayValue() || flowRef} started`,
        });
        return;
      }
      sys.update(ritm, {
        work_notes: `Flow "${flowRef}" could not be started; the built-in fulfillment steps are used instead`,
      });
    }
    const approvers = item ? this.approversFor(sys, item, ritm) : { users: [], groups: [] };
    if (approvers.users.length || approvers.groups.length) {
      const approvals = this.approvals();
      if (approvals) {
        approvals.request(sys, sys.get(T.ritm, ritmId) ?? ritm, {
          users: approvers.users,
          groups: approvers.groups,
          rule: 'any',
          stage: 'Catalog item approval',
        });
        return;
      }
      sys.update(sys.get(T.ritm, ritmId) ?? ritm, {
        work_notes: 'Approval skipped: the approvals application is not installed',
      });
    }
    this.itemApproved(sys, ritmId);
  }

  /** Users and groups that must approve an item (Approved by lists and the requested-for's manager). */
  approversFor(sys: Context, item: Rec, ritm: Rec): { users: string[]; groups: string[] } {
    const users = sys.query(T.appUser, { query: `sc_cat_item=${item.sysId}` }).map((r) => r.str('approver'));
    const groups = sys
      .query(T.appGroup, { query: `sc_cat_item=${item.sysId}` })
      .map((r) => r.str('approver'));
    if (item.bool('u_manager_approval')) {
      const manager = ritm.ref('requested_for')?.str('manager') ?? '';
      if (manager) users.unshift(manager);
    }
    const activeUsers = users.filter(
      (u, i) => u && users.indexOf(u) === i && sys.get('sys_user', u)?.bool('active') !== false,
    );
    // A group without active members could never answer: leave it out.
    const staffed = [...new Set(groups.filter(Boolean))].filter(
      (g) => sys.count('sys_user_grmember', `group=${g}^user.active=true`) > 0,
    );
    return { users: activeUsers, groups: staffed };
  }

  /** Approvals service callback (and approval field changes made by people). */
  onItemDecision(ctx: Context, ritmId: string, decision: ApprovalDecision): void {
    const sys = this.sys(ctx);
    const ritm = sys.get(T.ritm, ritmId);
    if (!ritm?.bool('active') || ritm.str('stage') !== STAGE.waiting || ritm.str('flow_context')) return;
    if (decision === APPROVAL.approved) this.itemApproved(sys, ritmId);
    else if (decision === APPROVAL.rejected) {
      sys.update(ritm, { approval: APPROVAL.rejected, stage: STAGE.cancelled, state: STATE.incomplete });
    }
  }

  /** Approved (or no approval needed): fulfillment stage and the first catalog tasks. */
  itemApproved(ctx: Context, ritmId: string): void {
    const sys = this.sys(ctx);
    const ritm = sys.get(T.ritm, ritmId);
    if (!ritm?.bool('active') || ritm.str('stage') !== STAGE.waiting) return;
    sys.update(ritm, { approval: APPROVAL.approved, stage: STAGE.fulfillment, state: STATE.wip });
    const fresh = sys.get(T.ritm, ritmId) ?? ritm;
    // Items without a catalog item (created by routing or by hand) are fulfilled manually.
    if (!fresh.str('cat_item')) return;
    if (!this.createNextTasks(sys, fresh) && sys.count(T.task, `request_item=${ritmId}^active=true`) === 0) {
      const automated = fresh.ref('cat_item')?.str('fulfillment_automation_level') === 'fully_automated';
      this.closeItem(
        sys,
        fresh,
        STATE.complete,
        automated ? 'Fulfilled automatically' : 'No fulfillment tasks were needed',
      );
    }
  }

  // ------------------------------------------------------------- task engine

  /** Fulfillment steps of an item: its own steps, else its execution plan tasks. */
  steps(sys: Context, item: Rec): StepDef[] {
    const own = sys.query(T.step, {
      query: `cat_item=${item.sysId}^active=true`,
      orderBy: [{ field: 'order', desc: false }],
    });
    if (own.length) {
      return own.map((s) => ({
        id: s.sysId,
        order: s.num('order') ?? 100,
        name: s.str('name'),
        shortDescription: s.str('short_description') || s.str('name'),
        description: s.str('description'),
        assignmentGroup: s.str('assignment_group'),
        assignedTo: s.str('assigned_to'),
        stage: s.str('stage') || STAGE.fulfillment,
        priority: s.str('priority') || '4',
        condition: s.str('condition'),
        includeVariables: s.get('include_variables') === null ? true : s.bool('include_variables'),
      }));
    }
    const planId = item.str('delivery_plan');
    if (planId && this.platform.registry.has(T.deliveryTask)) {
      return sys
        .query(T.deliveryTask, {
          query: `delivery_plan=${planId}`,
          orderBy: [{ field: 'order', desc: false }],
        })
        .map((t) => ({
          id: null,
          order: t.num('order') ?? 100,
          name: t.str('name'),
          shortDescription: t.str('short_description') || t.str('name'),
          description: t.str('instructions'),
          assignmentGroup: t.str('group'),
          assignedTo: t.str('assigned_to'),
          stage: STAGE.fulfillment,
          priority: '4',
          condition: t.str('condition'),
          includeVariables: true,
        }));
    }
    return [];
  }

  private answerContext(
    sys: Context,
    ritm: Rec,
  ): { values: Record<string, string>; display: Record<string, string>; lines: string[] } {
    const item = ritm.ref('cat_item');
    if (!item) return { values: {}, display: {}, lines: [] };
    const form = loadForm(sys, item, { includeInactive: true });
    const answers = readAnswers(sys, form, { table: T.ritm, id: ritm.sysId });
    const display: Record<string, string> = {};
    const lines: string[] = [];
    for (const def of form.vars) {
      if (!def.info.data) continue;
      const v = answers.values[def.name] ?? '';
      const shown = def.type === VT.masked ? (v ? '********' : '') : displayAnswer(sys, def, v);
      display[def.name] = shown;
      if (shown && def.visibleSummary) lines.push(`${def.label}: ${shown}`);
    }
    return { values: answers.values, display, lines };
  }

  /**
   * Creates the catalog tasks of the next step group (lowest order above the last
   * started one whose condition matches). With no steps defined, one task for the
   * item's fulfillment group. Returns false when nothing was left to create.
   */
  createNextTasks(ctx: Context, ritm: Rec): boolean {
    const sys = this.sys(ctx);
    const item = ritm.ref('cat_item');
    if (!item) return false;
    const steps = this.steps(sys, item);
    const answers = this.answerContext(sys, ritm);
    if (!steps.length) {
      if (item.str('fulfillment_automation_level') === 'fully_automated') return false;
      if (sys.count(T.task, `request_item=${ritm.sysId}`) > 0) return false;
      this.createTask(
        sys,
        ritm,
        {
          id: null,
          order: 100,
          name: item.str('name'),
          shortDescription: item.str('name'),
          description: '',
          assignmentGroup: item.str('group'),
          assignedTo: '',
          stage: STAGE.fulfillment,
          priority: '4',
          condition: '',
          includeVariables: true,
        },
        answers,
      );
      return true;
    }
    const current = ritm.num('resolvr_step_order') ?? Number.NEGATIVE_INFINITY;
    const orders = [...new Set(steps.map((s) => s.order))].filter((o) => o > current).sort((a, b) => a - b);
    const subject = variableSubject([], answers.values);
    for (const order of orders) {
      const group = steps.filter(
        (s) => s.order === order && (!s.condition || matches(s.condition, subject, sys.env)),
      );
      if (!group.length) continue;
      const stage = group.some((s) => s.stage === STAGE.delivery) ? STAGE.delivery : STAGE.fulfillment;
      const fresh = sys.get(T.ritm, ritm.sysId) ?? ritm;
      const values: Record<string, unknown> = { resolvr_step_order: order };
      if (fresh.str('stage') !== stage) values.stage = stage;
      sys.update(fresh, values);
      for (const step of group) this.createTask(sys, fresh, step, answers);
      return true;
    }
    return false;
  }

  private createTask(
    sys: Context,
    ritm: Rec,
    step: StepDef,
    answers: { display: Record<string, string>; lines: string[] },
  ): Rec {
    const parts = [renderTemplate(step.description, answers.display, ritm).trim()];
    if (step.includeVariables && answers.lines.length)
      parts.push(`Request details:\n${answers.lines.map((l) => `- ${l}`).join('\n')}`);
    const values: Record<string, unknown> = {
      request_item: ritm.sysId,
      short_description:
        renderTemplate(step.shortDescription, answers.display, ritm).slice(0, 160) ||
        ritm.str('short_description'),
      description: parts.filter(Boolean).join('\n\n'),
      assignment_group: step.assignmentGroup || null,
      assigned_to: step.assignedTo || null,
      priority: step.priority,
      state: STATE.open,
    };
    if (step.id) values.resolvr_fulfillment_step = step.id;
    return sys.insert(T.task, values);
  }

  /** A catalog task closed: create the next step group or close the requested item (roll-up). */
  onTaskClosed(ctx: Context, task: Rec): void {
    const sys = this.sys(ctx);
    const ritmId = task.str('request_item');
    const ritm = ritmId ? sys.get(T.ritm, ritmId) : null;
    if (!ritm?.bool('active') || ritm.str('flow_context')) return;
    if (ritm.str('stage') === STAGE.waiting || ritm.str('stage') === STAGE.cancelled) return;
    if (sys.count(T.task, `request_item=${ritmId}^active=true`) > 0) return;
    const states = sys.query(T.task, { query: `request_item=${ritmId}` }).map((t) => t.str('state'));
    if (states.includes(STATE.incomplete)) {
      this.closeItem(sys, ritm, STATE.incomplete);
      return;
    }
    if (this.createNextTasks(sys, ritm)) return;
    this.closeItem(sys, ritm, rollupState(states));
  }

  /** Closes a requested item with the given state; stage becomes Completed. */
  closeItem(ctx: Context, ritm: Rec, state: string, note?: string): void {
    const sys = this.sys(ctx);
    const fresh = sys.get(T.ritm, ritm.sysId);
    if (!fresh?.bool('active')) return;
    const values: Record<string, unknown> = { state, stage: STAGE.complete };
    if (note) values.work_notes = note;
    sys.update(fresh, values);
  }

  /** Recomputes a requested item from its tasks (used by flows and admins). */
  rollupItem(ctx: Context, ritm: Rec): void {
    const sys = this.sys(ctx);
    const tasks = sys.query(T.task, { query: `request_item=${ritm.sysId}` });
    if (tasks.some((t) => t.bool('active'))) return;
    this.closeItem(sys, ritm, rollupState(tasks.map((t) => t.str('state'))));
  }

  // ------------------------------------------------------------ cancellation

  /** Cancels a requested item: stage Request Cancelled, state Closed Incomplete, approvals and tasks stopped. */
  cancelItem(ctx: Context, ritm: Rec, reason: string, approval?: string): void {
    const sys = this.sys(ctx);
    const fresh = sys.get(T.ritm, ritm.sysId);
    if (!fresh?.bool('active')) return;
    const pending = fresh.str('approval') === APPROVAL.requested;
    if (pending) {
      try {
        this.approvals()?.cancel(sys, fresh, reason);
      } catch (e) {
        this.platform.reportError('catalog: cancel approvals', e);
      }
    }
    const after = sys.get(T.ritm, ritm.sysId) ?? fresh;
    const values: Record<string, unknown> = {
      stage: STAGE.cancelled,
      state: STATE.incomplete,
      work_notes: `Cancelled: ${reason}`,
    };
    if (approval) values.approval = approval;
    else if (pending && after.str('approval') === APPROVAL.requested) values.approval = APPROVAL.cancelled;
    sys.update(after, values);
    for (const t of sys.query(T.task, { query: `request_item=${ritm.sysId}^active=true` })) {
      sys.update(t, { state: STATE.skipped, work_notes: 'Closed because the request was cancelled' });
    }
  }

  /** Cancels every open item of a request; the request closes as Closed Cancelled. */
  cancelRequest(ctx: Context, req: Rec, reason: string): void {
    const sys = this.sys(ctx);
    if (req.str('approval') === APPROVAL.requested) {
      try {
        this.approvals()?.cancel(sys, req, reason);
      } catch (e) {
        this.platform.reportError('catalog: cancel request approvals', e);
      }
    }
    for (const ritm of sys.query(T.ritm, { query: `request=${req.sysId}^active=true` }))
      this.cancelItem(sys, ritm, reason);
    const fresh = sys.get(T.request, req.sysId);
    if (fresh?.bool('active')) {
      sys.update(fresh, {
        request_state: REQ_STATE.closedCancelled,
        stage: 'closed_cancelled',
        state: STATE.incomplete,
        comments: `Request cancelled: ${reason}`,
      });
    }
  }

  /** Requesters (and fulfillers) may cancel while nothing has been approved or started (spec 7.3). */
  canCancel(ctx: Context, rec: Rec): boolean {
    if (!rec.bool('active')) return false;
    const me = ctx.user.sysId;
    const own = !!me && (rec.str('opened_by') === me || rec.str('requested_for') === me);
    if (!own && !ctx.user.isSystem && !ctx.hasAnyRole(['itil', 'sn_request_write', 'catalog_admin']))
      return false;
    const sys = ctx.platform.systemContext();
    if (rec.table.ancestors.includes(T.ritm)) return rec.str('stage') === STAGE.waiting;
    if (rec.table.ancestors.includes(T.request)) {
      const items = sys.query(T.ritm, { query: `request=${rec.sysId}` });
      return items.length > 0 && items.every((i) => !i.bool('active') || i.str('stage') === STAGE.waiting);
    }
    return false;
  }

  // ----------------------------------------------------------------- roll-up

  /** Recomputes a request's stage, state and request_state from its items. */
  rollupRequest(ctx: Context, requestId: string): void {
    const sys = this.sys(ctx);
    const req = sys.get(T.request, requestId);
    if (!req) return;
    const items = sys.query(T.ritm, { query: `request=${requestId}` });
    if (!items.length) return;
    const open = items.filter((i) => i.bool('active'));
    const values: Record<string, unknown> = {};
    if (open.length) {
      if (!req.bool('active')) return;
      const working = open.some((i) => i.str('stage') !== STAGE.waiting);
      const waiting = req.str('request_state') === REQ_STATE.requested || !working;
      const stage = waiting ? 'waiting_for_approval' : 'fulfillment';
      if (req.str('stage') !== stage) values.stage = stage;
      if (working && req.str('state') !== STATE.wip) values.state = STATE.wip;
    } else if (req.bool('active')) {
      const cancelled = items.every((i) => i.str('stage') === STAGE.cancelled);
      const rejected = cancelled && items.every((i) => i.str('approval') === APPROVAL.rejected);
      let requestState: string;
      let state: string;
      if (rejected) {
        requestState = REQ_STATE.closedRejected;
        state = STATE.incomplete;
      } else if (cancelled) {
        requestState = REQ_STATE.closedCancelled;
        state = STATE.incomplete;
      } else {
        state = rollupState(items.map((i) => i.str('state')));
        requestState = REQ_CLOSED_BY_STATE[state] ?? REQ_STATE.closedComplete;
      }
      values.request_state = requestState;
      values.stage = requestState;
      values.state = state;
    }
    const price = items.reduce((sum, i) => sum + (i.num('price') ?? 0) * (i.num('quantity') ?? 1), 0);
    if (Math.abs((req.num('price') ?? 0) - price) > 0.001) values.price = Math.round(price * 100) / 100;
    const due = items
      .map((i) => i.str('estimated_delivery'))
      .filter(Boolean)
      .sort()
      .pop();
    if (due && due !== req.str('due_date')) values.due_date = due;
    if (Object.keys(values).length) sys.update(req, values);
  }

  // -------------------------------------------------------------------- flows

  flowInputs(sys: Context, ritm: Rec): Record<string, unknown> {
    const answers = this.answerContext(sys, ritm);
    return {
      request_item: ritm.sysId,
      request: ritm.str('request'),
      cat_item: ritm.str('cat_item'),
      requested_for: ritm.str('requested_for'),
      quantity: ritm.num('quantity') ?? 1,
      variables: answers.values,
    };
  }

  /** Finds the requested item a flow action works on. */
  ritmFor(sys: Context, inputs: Record<string, unknown>, record: Rec | null): Rec | null {
    const given = inputs.request_item ?? inputs.ritm ?? inputs.record;
    const id =
      typeof given === 'string'
        ? given
        : given && typeof given === 'object' && 'sysId' in given
          ? String((given as Rec).sysId)
          : '';
    if (id) return sys.get(T.ritm, id);
    if (record?.table.ancestors.includes(T.ritm)) return sys.get(T.ritm, record.sysId);
    if (record?.table.ancestors.includes(T.task) && record.str('request_item'))
      return sys.get(T.ritm, record.str('request_item'));
    return null;
  }

  /** Registers the catalog flow actions (when the flows service is installed). */
  registerFlowActions(): void {
    const flows = this.flows();
    if (!flows) return;
    flows.registerAction('create_catalog_task', (ctx, inputs, record) => {
      const sys = this.sys(ctx);
      const ritm = this.ritmFor(sys, inputs, record);
      if (!ritm) throw new Error('create_catalog_task: no requested item');
      const answers = this.answerContext(sys, ritm);
      const task = this.createTask(
        sys,
        ritm,
        {
          id: null,
          order: 100,
          name: String(inputs.short_description ?? ''),
          shortDescription: String(inputs.short_description ?? ritm.str('short_description')),
          description: String(inputs.description ?? ''),
          assignmentGroup: String(inputs.assignment_group ?? ritm.ref('cat_item')?.str('group') ?? ''),
          assignedTo: String(inputs.assigned_to ?? ''),
          stage: STAGE.fulfillment,
          priority: String(inputs.priority ?? '4'),
          condition: '',
          includeVariables: inputs.include_variables !== false,
        },
        answers,
      );
      return { record: task, sys_id: task.sysId, number: task.str('number') };
    });
    flows.registerAction('set_ritm_stage', (ctx, inputs, record) => {
      const sys = this.sys(ctx);
      const ritm = this.ritmFor(sys, inputs, record);
      if (!ritm) throw new Error('set_ritm_stage: no requested item');
      const stage = String(inputs.stage ?? '');
      if (stage === STAGE.cancelled)
        this.cancelItem(
          sys,
          ritm,
          String(inputs.reason ?? 'Cancelled by the fulfillment flow'),
          inputs.approval ? String(inputs.approval) : undefined,
        );
      else if (stage === STAGE.complete) {
        if (inputs.state) this.closeItem(sys, ritm, String(inputs.state));
        else this.rollupItem(sys, ritm);
      } else {
        const values: Record<string, unknown> = { stage };
        if (inputs.state) values.state = String(inputs.state);
        else if (stage === STAGE.fulfillment || stage === STAGE.delivery) values.state = STATE.wip;
        if (inputs.approval) values.approval = String(inputs.approval);
        sys.update(ritm, values);
      }
      return { record: sys.get(T.ritm, ritm.sysId) };
    });
    flows.registerAction('get_catalog_variables', (ctx, inputs, record) => {
      const sys = this.sys(ctx);
      const ritm = this.ritmFor(sys, inputs, record);
      if (!ritm) return { variables: {}, display: {} };
      const answers = this.answerContext(sys, ritm);
      return { variables: answers.values, display: answers.display };
    });
    flows.registerAction('run_catalog_fulfillment', (ctx, inputs, record) => {
      const sys = this.sys(ctx);
      const ritm = this.ritmFor(sys, inputs, record);
      if (!ritm) throw new Error('run_catalog_fulfillment: no requested item');
      sys.update(ritm, { flow_context: null, stage: STAGE.waiting, approval: APPROVAL.notRequested });
      this.itemApproved(sys, ritm.sysId);
      return { record: sys.get(T.ritm, ritm.sysId) };
    });
  }

  /** Registers decision callbacks with the approvals service (when installed). */
  registerApprovalHandlers(): void {
    const approvals = this.approvals();
    if (!approvals) return;
    approvals.onDecision(T.ritm, (target, decision, ctx) => this.onItemDecision(ctx, target.sysId, decision));
    approvals.onDecision(T.request, (target, decision, ctx) =>
      this.onRequestDecision(ctx, target.sysId, decision),
    );
  }

  // ------------------------------------------------------------------- misc

  /** Estimated delivery of a requested item. */
  estimate(openedAt: string, ms: number): string {
    return addMs(openedAt || nowGlide(), ms);
  }

  /** Pending approval rows of the session user (or users who delegated to them) for a record. */
  pendingApprovalsFor(ctx: Context, rec: Rec): Rec[] {
    if (!this.platform.registry.has(T.approval) || !ctx.user.sysId) return [];
    const sys = ctx.platform.systemContext();
    const rows = sys.query(T.approval, { query: `document_id=${rec.sysId}^state=requested` });
    return rows.filter(
      (r) => r.str('approver') === ctx.user.sysId || this.isDelegateFor(ctx, r.str('approver')),
    );
  }

  private isDelegateFor(ctx: Context, userId: string): boolean {
    if (!this.platform.registry.has('sys_user_delegate') || !ctx.user.sysId) return false;
    const now = nowGlide();
    return ctx.platform
      .systemContext()
      .query('sys_user_delegate', { query: `user=${userId}^delegate=${ctx.user.sysId}` })
      .some(
        (d) =>
          d.get('approvals') !== 0 &&
          (!d.str('starts') || d.str('starts') <= now) &&
          (!d.str('ends') || d.str('ends') > now),
      );
  }

  /** Display names of the people an item or request is waiting on. */
  pendingApprovers(ctx: Context, rec: Rec): string[] {
    if (!this.platform.registry.has(T.approval)) return [];
    const sys = ctx.platform.systemContext();
    return sys
      .query(T.approval, { query: `document_id=${rec.sysId}^state=requested` })
      .map((r) => r.display('approver'))
      .filter(Boolean);
  }
}

export function fulfillmentOf(platform: Platform): Fulfillment {
  const svc = platform.services.get('catalog') as { fulfillment?: Fulfillment } | undefined;
  return svc?.fulfillment ?? new Fulfillment(platform);
}
