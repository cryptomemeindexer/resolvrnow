import type { Context } from '../../engine/context.js';
import { AccessError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { JOURNAL_TYPES } from '../../engine/types.js';
import { isSysId, normalizeDateTime, nowGlide, quoteIdent } from '../../engine/util.js';
import type { ApprovalDecision, ApprovalRequest, ApprovalService } from '../contracts.js';
import {
  APPROVAL_TABLE,
  approvalEventName,
  DECIDED,
  GROUP_TABLE,
  IGNORED,
  normalizeOnDue,
  normalizeRule,
  type OnDue,
  PENDING,
  type RuleType,
  ST,
  STEP_TABLE,
} from './constants.js';
import { delegatorsOf, isActiveDelegate } from './delegation.js';
import { combineUnits, emailDecision, evaluateUnit, rollupStates } from './evaluate.js';

/** Options accepted by `request()`/`requestStep()`: the contract's request plus ResolvrNow extensions. */
export interface ApprovalStepRequest {
  /** Individual approvers (sys_user sys_ids, user names or records). */
  users?: unknown[];
  /** Approving groups (sys_user_group sys_ids, names or records); each group is its own unit. */
  groups?: unknown[];
  /** Rule for the user unit: first | first_response | any | all | percentage (default any). */
  rule?: string;
  /** Percentage for the user unit when rule = percentage. */
  percentage?: number | null;
  /** Rule for each group (default: `rule` when given, else first_response). */
  groupRule?: string;
  groupPercentage?: number | null;
  /** Label shown to approvers, e.g. "Technical approval". */
  stage?: string;
  /** Due date-time of the approvals. */
  due?: string | null;
  /** What happens when `due` passes without an outcome. */
  onDue?: OnDue | string | null;
  /** Ask the listed users one after the other (in list order) instead of all at once. */
  sequential?: boolean;
  /** Where the request comes from: api (default), flow, rule, ui. */
  source?: string;
  /** sys_flow_context that asked (flows only). */
  flowContext?: string | null;
  /** Field on the record receiving the roll-up (default approval). */
  approvalField?: string;
  /** Journal field on the record receiving decisions (default approval_history). */
  journalField?: string;
}

export interface ApprovalStepResult {
  step: Rec;
  approvals: Rec[];
  /** Step state right after the request (an empty request may be decided immediately). */
  state: string;
}

export type DecisionHandler = (target: Rec, decision: ApprovalDecision, ctx: Context) => void;
export type StepListener = (step: Rec, state: string, ctx: Context) => void;

export interface ApprovalEmailReply {
  /** sys_user sys_id of the sender matched by the inbound email processor. */
  from: string | null;
  subject?: string;
  /** Plain-text body, already cut at the first reply separator. */
  body_text?: string;
}

export interface ApprovalEmailResult {
  status: 'approved' | 'rejected' | 'ignored';
  message: string;
}

/** Raised when an approval cannot be decided because it is no longer waiting for an answer. */
export class ApprovalNotPendingError extends InvalidError {
  constructor(message = 'This approval is no longer pending') {
    super(message);
    this.name = 'ApprovalNotPendingError';
  }
}

interface JournalLine {
  column: string;
  text: string;
}

interface Pass {
  dirty: boolean;
  journal: JournalLine[];
  decidedSteps: string[];
  decidedSources: string[];
}

interface Unit {
  group: Rec | null;
  rule: RuleType;
  percentage: number | null;
  rows: Rec[];
}

interface TaskModels {
  model(table: string): { closed: string[]; defaultClosed?: string } | undefined;
}

export function approvalEngine(platform: Platform): ApprovalEngine {
  return platform.service<ApprovalEngine>('approvals');
}

/**
 * Approval engine: creates approval rows for a record, applies the rules of each
 * request (first response, anyone, everyone, percentage) per unit, rolls the result
 * up into the record's approval field and journal, and notifies listeners.
 *
 * Every `request()` call is persisted as a `resolvr_approval_step` row; approvers
 * added by hand (approvers related list) join a "manual" step that follows the
 * classic everyone-must-approve roll-up.
 */
export class ApprovalEngine implements ApprovalService {
  private handlers = new Map<string, DecisionHandler[]>();
  private stepListeners: StepListener[] = [];
  /** Documents whose roll-up is being recomputed (re-entrant calls only mark them dirty). */
  private passes = new Map<string, Pass>();
  /** Documents whose approvals are being created or bulk-updated; roll-up waits until the end. */
  private building = new Map<string, { depth: number; journal: JournalLine[] }>();
  /** Journal lines collected while building, handed to the next roll-up. */
  private deferred = new Map<string, JournalLine[]>();

  constructor(readonly platform: Platform) {}

  // ------------------------------------------------------------------ contract

  request(ctx: Context, target: Rec, req: ApprovalRequest | ApprovalStepRequest): Rec[] {
    return this.requestStep(ctx, target, req as ApprovalStepRequest).approvals;
  }

  decide(
    ctx: Context,
    approval: Rec,
    decision: ApprovalDecision,
    comments?: string,
    opts: { source?: string } = {},
  ): void {
    if (decision !== ST.approved && decision !== ST.rejected)
      throw new InvalidError(`Invalid approval decision ${String(decision)}`);
    const row = this.sys(ctx).get(APPROVAL_TABLE, approval.sysId);
    if (!row) throw new NotFoundError();
    const state = row.str('state');
    const admin = this.isApprovalAdmin(ctx);
    const allowed = state === ST.requested || (admin && (PENDING.has(state) || DECIDED.has(state)));
    if (!allowed)
      throw new ApprovalNotPendingError(
        DECIDED.has(state) ? 'This approval has already been decided' : undefined,
      );
    if (!this.canDecide(ctx, row)) {
      throw new AccessError(
        'Insufficient rights to decide this approval',
        'Only the approver, an active delegate or an approval administrator can decide',
      );
    }
    const values: Record<string, unknown> = { state: decision };
    const text = (comments ?? '').trim();
    if (text) values.comments = text;
    if (opts.source) values.approval_source = opts.source;
    ctx.derive({ workflow: true }).update(row, values);
  }

  cancel(ctx: Context, target: Rec, reason?: string): void {
    this.cancelPending(this.sys(ctx), target.sysId, reason ?? 'Approvals cancelled');
  }

  stateOf(ctx: Context, target: Rec): string {
    return this.rollup(this.sys(ctx), target.sysId).get('approval') ?? ST.notRequested;
  }

  onDecision(table: string, handler: DecisionHandler): void {
    const list = this.handlers.get(table) ?? [];
    list.push(handler);
    this.handlers.set(table, list);
  }

  // ---------------------------------------------------------------- extensions

  /** Called whenever a step reaches a final state (approved, rejected, cancelled). */
  onStepDecided(listener: StepListener): void {
    this.stepListeners.push(listener);
  }

  /** Creates one approval step (users and groups) for a record; returns the step and its approvals. */
  requestStep(ctx: Context, target: Rec, req: ApprovalStepRequest): ApprovalStepResult {
    const sys = this.sys(ctx);
    const id = target.sysId;
    // After-insert rules see a record that is written but not yet committed (isNew), so check the table.
    if (!id || !this.classOf(id, target.className))
      throw new InvalidError('Approvals can only be requested for a saved record');
    const table = target.className;
    const isTask = target.table.ancestors.includes('task');
    const users = this.resolveUsers(req.users ?? []);
    const groups = this.resolveGroups(req.groups ?? []);
    const due = req.due ? normalizeDateTime(req.due) : null;
    const source = req.source || 'api';
    const approvalColumn = req.approvalField || 'approval';
    const journalColumn = req.journalField || 'approval_history';
    const step = sys.insert(STEP_TABLE, {
      document_id: id,
      source_table: table,
      iteration: this.iterationForNewRequest(sys, id),
      label: req.stage ?? '',
      rule: normalizeRule(req.rule, 'any'),
      percentage: req.percentage ?? null,
      state: ST.requested,
      source,
      flow_context: req.flowContext ?? null,
      due_date: due,
      on_due: normalizeOnDue(req.onDue),
      approval_column: approvalColumn,
      journal_column: journalColumn,
      requested_by: ctx.user.sysId,
    });
    const created: Rec[] = [];
    this.beginBuild(id);
    try {
      const label = target.displayValue() || target.table.label;
      for (const g of groups) {
        const grow = sys.insert(GROUP_TABLE, {
          parent: isTask ? id : null,
          assignment_group: g,
          approval: ST.requested,
          short_description: `${req.stage ? `${req.stage}: ` : ''}Approval for ${label}`.slice(0, 160),
          resolvr_wait_for: normalizeRule(req.groupRule ?? req.rule, 'first_response'),
          resolvr_percentage: req.groupPercentage ?? req.percentage ?? null,
          resolvr_step: step.sysId,
          due_date: due,
        });
        created.push(...this.ensureGroupMembers(sys, grow));
      }
      users.forEach((u, i) => {
        created.push(
          sys.insert(APPROVAL_TABLE, {
            approver: u,
            document_id: id,
            source_table: table,
            sysapproval: isTask ? id : null,
            state: req.sequential && i > 0 ? ST.notRequested : ST.requested,
            order: req.sequential ? (i + 1) * 100 : 100,
            resolvr_step: step.sysId,
            iteration: step.num('iteration') ?? 0,
            due_date: due,
            approval_source: source,
            flow_context: req.flowContext ?? null,
            approval_column: approvalColumn,
            approval_journal_column: journalColumn,
          }),
        );
      });
    } finally {
      this.endBuild(id);
    }
    this.recompute(sys, id);
    const fresh = sys.get(STEP_TABLE, step.sysId) ?? step;
    return {
      step: fresh,
      approvals: created.map((r) => sys.get(APPROVAL_TABLE, r.sysId) ?? r),
      state: fresh.str('state'),
    };
  }

  /** Approvals of a record (all iterations unless `iteration` is given), oldest first. */
  approvalsFor(ctx: Context, target: Rec | string, iteration?: number): Rec[] {
    const id = typeof target === 'string' ? target : target.sysId;
    const q = `document_id=${id}${iteration === undefined ? '' : `^iteration=${iteration}`}`;
    return this.sys(ctx).query(APPROVAL_TABLE, {
      query: q,
      orderBy: [{ field: 'sys_created_on', desc: false }],
    });
  }

  stepsFor(ctx: Context, target: Rec | string): Rec[] {
    const id = typeof target === 'string' ? target : target.sysId;
    return this.sys(ctx).query(STEP_TABLE, {
      query: `document_id=${id}`,
      orderBy: [{ field: 'sys_created_on', desc: false }],
    });
  }

  stepState(ctx: Context, stepId: string): string | null {
    return this.sys(ctx).get(STEP_TABLE, stepId)?.str('state') ?? null;
  }

  /** Approvals waiting for the session user, including those of users who delegated approvals to them. */
  pendingFor(ctx: Context, opts: { limit?: number } = {}): Rec[] {
    const me = ctx.user.sysId;
    if (!me) return [];
    const ids = [me, ...delegatorsOf(this.platform, me, 'approvals')];
    return this.sys(ctx).query(APPROVAL_TABLE, {
      query: `state=${ST.requested}^approverIN${ids.join(',')}`,
      orderBy: [{ field: 'sys_created_on', desc: false }],
      limit: opts.limit ?? 500,
    });
  }

  /** Forces the outcome of a step (due date reached, flow cancelled...). */
  resolveStep(
    ctx: Context,
    stepOrId: Rec | string,
    outcome: 'approved' | 'rejected' | 'cancelled',
    reason?: string,
  ): void {
    const sys = this.sys(ctx);
    const step = sys.get(STEP_TABLE, typeof stepOrId === 'string' ? stepOrId : stepOrId.sysId);
    if (!step || !PENDING.has(step.str('state'))) return;
    const documentId = step.str('document_id');
    const before = this.rollup(sys, documentId).get('approval') ?? ST.notRequested;
    const rowState = outcome === ST.cancelled ? ST.cancelled : ST.notRequired;
    this.beginBuild(documentId);
    try {
      for (const r of sys.query(APPROVAL_TABLE, {
        query: `resolvr_step=${step.sysId}^stateIN${[...PENDING].join(',')}`,
      })) {
        sys.update(r, { state: rowState });
      }
      for (const g of sys.query(GROUP_TABLE, {
        query: `resolvr_step=${step.sysId}^approvalIN${[...PENDING].join(',')}`,
      })) {
        this.setGroupState(sys, g, rowState);
      }
      sys.update(step, { state: outcome, decided_on: nowGlide() });
    } finally {
      this.endBuild(documentId);
    }
    const lines: JournalLine[] = [];
    if (reason)
      lines.push({
        column: step.str('journal_column') || 'approval_history',
        text: `${step.str('label') || 'Approval'} ${outcome}: ${reason}`,
      });
    this.recompute(sys, documentId, lines, { before, decidedSources: [step.str('source')] });
    this.notifyStep(sys, step.sysId);
  }

  /** Applies the `on_due` outcome of steps whose due date has passed. Returns the number of steps resolved. */
  processDue(ctx: Context): number {
    const sys = this.sys(ctx);
    const due = sys.query(STEP_TABLE, {
      query: `stateIN${[...PENDING].join(',')}^on_dueISNOTEMPTY^due_dateISNOTEMPTY^due_date<=${nowGlide()}`,
    });
    for (const s of due) {
      const onDue = normalizeOnDue(s.str('on_due'));
      if (!onDue) continue;
      const outcome = onDue === 'approve' ? ST.approved : onDue === 'reject' ? ST.rejected : ST.cancelled;
      this.resolveStep(sys, s, outcome, 'the due date passed without a decision');
    }
    return due.length;
  }

  /** True when the session user may approve or reject this approval. */
  canDecide(ctx: Context, approval: Rec): boolean {
    if (ctx.user.isSystem || !ctx.enforceAcl) return true;
    if (this.isApprovalAdmin(ctx)) return true;
    const me = ctx.user.sysId;
    const approver = approval.str('approver');
    if (!me || !approver) return false;
    return approver === me || isActiveDelegate(this.platform, me, approver);
  }

  isApprovalAdmin(ctx: Context): boolean {
    return ctx.user.isSystem || ctx.hasRole('approval_admin');
  }

  /**
   * Inbound email hook ("Update Approval Request"): applies an approve/reject reply
   * from the approver or an active delegate. The notifications module calls this with
   * the approval matched by the reply's watermark.
   */
  decideFromEmail(ctx: Context, approval: Rec | string, email: ApprovalEmailReply): ApprovalEmailResult {
    const sys = this.sys(ctx);
    const row = sys.get(APPROVAL_TABLE, typeof approval === 'string' ? approval : approval.sysId);
    if (!row) return { status: 'ignored', message: 'Approval not found' };
    if (row.str('state') !== ST.requested)
      return { status: 'ignored', message: 'Approval is not pending; reply ignored' };
    const sender = email.from && isSysId(email.from) ? email.from : null;
    const approver = row.str('approver');
    if (!sender || (sender !== approver && !isActiveDelegate(this.platform, sender, approver))) {
      return { status: 'ignored', message: 'Sender is not authorized to decide this approval' };
    }
    const text = (email.body_text ?? '').trim();
    const decision = emailDecision(email.subject ?? '', text);
    if (!decision) return { status: 'ignored', message: 'No approval decision found in the reply' };
    const session = this.platform.users.session(sender);
    if (!session) return { status: 'ignored', message: 'Sender is not a known user' };
    const actor = this.platform.contextFor(session).derive({ acl: false, workflow: true });
    actor.update(row, { state: decision, comments: text || undefined, approval_source: 'email' });
    return { status: decision, message: `Approval ${decision} by email reply` };
  }

  // ------------------------------------------------------- business rule hooks

  /** Before insert of an approval: fills the target fields, joins a step, flags duplicates. */
  prepareNewApproval(cur: Rec, ctx: Context): void {
    const sys = this.sys(ctx);
    const sysapproval = cur.str('sysapproval');
    const id = cur.str('document_id') || sysapproval;
    const table = id ? this.classOf(id, cur.str('source_table') || 'task') : null;
    if (!id || !table) {
      cur.abort('An approval needs the record being approved (document_id and source_table, or sysapproval)');
      return;
    }
    cur.setRaw('document_id', id);
    cur.setRaw('source_table', table);
    if (!sysapproval && this.platform.registry.isA(table, 'task')) cur.setRaw('sysapproval', id);
    let step = cur.str('resolvr_step') ? sys.get(STEP_TABLE, cur.str('resolvr_step')) : null;
    if (!step) {
      // Added by hand (approvers related list, Table API): waits until someone requests it.
      if (!cur.touched.has('state')) cur.setRaw('state', ST.notRequested);
      step = this.manualStep(sys, table, id);
      cur.setRaw('resolvr_step', step.sysId);
    }
    if (!cur.touched.has('iteration')) cur.setRaw('iteration', step.num('iteration') ?? 0);
    if (!cur.touched.has('approval_column'))
      cur.setRaw('approval_column', step.str('approval_column') || 'approval');
    if (!cur.touched.has('approval_journal_column'))
      cur.setRaw('approval_journal_column', step.str('journal_column') || 'approval_history');
    if (!cur.str('approval_source')) cur.setRaw('approval_source', step.str('source') || 'manual');
    if (!cur.str('flow_context') && step.str('flow_context'))
      cur.setRaw('flow_context', step.str('flow_context'));
    const approver = cur.str('approver');
    if (approver && !IGNORED.has(cur.str('state'))) {
      const dup = this.platform.db.get(
        `SELECT "sys_id" FROM "sysapproval_approver" WHERE "document_id" = ? AND "approver" = ? AND COALESCE("iteration",0) = ? AND "state" NOT IN ('cancelled','duplicate') AND "sys_id" <> ? LIMIT 1`,
        [id, approver, cur.num('iteration') ?? 0, cur.sysId],
      );
      if (dup) cur.setRaw('state', ST.duplicate);
    }
  }

  /** Before update of an approval: who may decide, decisions are final, records the decider. */
  validateApprovalChange(cur: Rec, prev: Rec | null, ctx: Context): void {
    const automation = ctx.user.isSystem || !ctx.enforceAcl;
    const admin = automation || ctx.hasRole('approval_admin');
    if (cur.changed('approver') && !admin) {
      cur.abort('Only an approval administrator can change the approver');
      return;
    }
    if (!cur.changed('state')) return;
    const to = cur.str('state');
    const from = prev?.str('state') ?? String(cur.prev('state') ?? '');
    if (DECIDED.has(to)) {
      const approver = prev?.str('approver') ?? cur.str('approver');
      const me = ctx.user.sysId;
      const mayDecide = admin || (!!me && (approver === me || isActiveDelegate(this.platform, me, approver)));
      if (!mayDecide) {
        cur.abort('Only the approver or an active delegate can approve or reject this approval');
        return;
      }
      if (from !== ST.requested && !admin) {
        cur.abort(
          DECIDED.has(from) ? 'This approval has already been decided' : 'This approval is not pending',
        );
        return;
      }
      cur.setRaw('resolvr_decided_by', ctx.user.sysId);
      cur.setRaw('resolvr_decided_on', nowGlide());
    } else if (DECIDED.has(from) && !admin) {
      cur.abort('A decided approval can only be changed by an approval administrator');
    }
  }

  /** After insert/update of an approval: events, approval history, roll-up. */
  afterApprovalChange(cur: Rec, prev: Rec | null, ctx: Context): void {
    const documentId = cur.str('document_id');
    if (!documentId) return;
    const inserted = !prev;
    const changed = inserted ? true : cur.changed('state');
    const to = cur.str('state');
    const from = prev?.str('state') ?? '';
    const ancestors = this.platform.registry.tryTable(cur.str('source_table'))?.ancestors ?? [];
    if (changed) {
      if (to === ST.requested)
        ctx.queueEvent(approvalEventName('inserted', ancestors), cur, cur.str('approver'), documentId);
      else if (to === ST.approved)
        ctx.queueEvent('approval.approved', cur, cur.str('resolvr_decided_by'), documentId);
      else if (to === ST.rejected)
        ctx.queueEvent(
          approvalEventName('rejected', ancestors),
          cur,
          cur.str('resolvr_decided_by'),
          documentId,
        );
      else if (to === ST.cancelled && !inserted)
        ctx.queueEvent(approvalEventName('cancelled', ancestors), cur, cur.str('approver'), documentId);
    }
    const lines: JournalLine[] = [];
    let before: string | undefined;
    if (changed && DECIDED.has(to)) {
      lines.push({
        column: cur.str('approval_journal_column') || 'approval_history',
        text: this.historyText(ctx, cur, to),
      });
      const me = ctx.user.sysId;
      if (
        me &&
        me !== cur.str('approver') &&
        isActiveDelegate(this.platform, me, cur.str('approver')) &&
        this.platform.registry.has('sys_audit')
      ) {
        this.platform.db.run(
          `UPDATE "sys_audit" SET "reason" = 'delegate' WHERE "documentkey" = ? AND "tablename" = ? AND "record_checkpoint" = ?`,
          [cur.sysId, APPROVAL_TABLE, cur.num('sys_mod_count') ?? 0],
        );
      }
      if (!inserted && DECIDED.has(from)) {
        // An approval administrator changed an answer: re-run the step with the new answer.
        before = this.rollup(this.sys(ctx), documentId).get('approval');
        const step = cur.str('resolvr_step') ? this.sys(ctx).get(STEP_TABLE, cur.str('resolvr_step')) : null;
        if (step && DECIDED.has(step.str('state')))
          this.sys(ctx).update(step, { state: ST.requested, decided_on: null });
      }
    }
    if (changed || inserted) this.recompute(ctx, documentId, lines, before ? { before } : {});
  }

  /** Before insert of a group approval created by hand: joins the record's manual step. */
  prepareNewGroup(cur: Rec, ctx: Context): void {
    if (cur.str('resolvr_step')) return;
    const parent = cur.str('parent');
    if (!parent) return;
    const table = this.classOf(parent, 'task');
    if (!table) return;
    cur.setRaw('resolvr_step', this.manualStep(this.sys(ctx), table, parent).sysId);
  }

  /** After insert/update of a group approval: member approvals once requested, roll-up on overrides. */
  afterGroupChange(cur: Rec, prev: Rec | null, ctx: Context): void {
    const sys = this.sys(ctx);
    const approval = cur.str('approval');
    if (approval === ST.requested && (!prev || prev.str('approval') !== ST.requested))
      this.ensureGroupMembers(sys, cur);
    if (prev && cur.changed('approval')) {
      const step = cur.str('resolvr_step') ? sys.get(STEP_TABLE, cur.str('resolvr_step')) : null;
      if (step) this.recompute(sys, step.str('document_id'));
    }
  }

  /** A record was closed or cancelled: pending approvals are no longer needed. */
  onRecordClosed(rec: Rec, ctx: Context): void {
    this.cancelPending(this.sys(ctx), rec.sysId, 'the record was closed');
  }

  // ----------------------------------------------------------------- ACL checks

  canRead(rec: Rec, ctx: Context): boolean {
    if (this.isApprovalAdmin(ctx)) return true;
    const me = ctx.user.sysId;
    const approver = rec.str('approver');
    if (me && approver && (approver === me || isActiveDelegate(this.platform, me, approver))) return true;
    const id = rec.str('document_id') || rec.str('sysapproval');
    const table = rec.str('source_table') || (rec.str('sysapproval') ? 'task' : '');
    if (!id || !table || !this.platform.registry.has(table)) return false;
    return !!ctx.get(table, id);
  }

  /** Table-level write: pending approvals of the user (or a delegator), or approval_admin. */
  canWrite(rec: Rec, ctx: Context): boolean {
    if (this.isApprovalAdmin(ctx)) return true;
    if (!PENDING.has(rec.str('state'))) return false;
    const me = ctx.user.sysId;
    const approver = rec.str('approver');
    return !!me && !!approver && (approver === me || isActiveDelegate(this.platform, me, approver));
  }

  /** Manual approvers: itil users who can write the record, or approval_admin. */
  canCreate(rec: Rec | null, ctx: Context): boolean {
    if (this.isApprovalAdmin(ctx)) return true;
    if (!ctx.hasRole('itil')) return false;
    if (!rec) return true;
    const id = rec.str('document_id') || rec.str('sysapproval');
    const table = rec.str('source_table') || 'task';
    if (!id || !this.platform.registry.has(table)) return true;
    const target = ctx.get(table, id);
    return !!target && this.platform.acl.canTable(ctx, target.className, 'write', target).allowed;
  }

  // ------------------------------------------------------------------ internals

  /** Same user, no ACLs, business rules on: the engine's own reads and writes. */
  private sys(ctx: Context): Context {
    return ctx.derive({ acl: false, workflow: true });
  }

  private beginBuild(documentId: string): void {
    const b = this.building.get(documentId);
    if (b) b.depth++;
    else this.building.set(documentId, { depth: 1, journal: [] });
  }

  private endBuild(documentId: string): void {
    const b = this.building.get(documentId);
    if (!b) return;
    if (--b.depth > 0) return;
    this.building.delete(documentId);
    if (!b.journal.length) return;
    const pass = this.passes.get(documentId);
    if (pass) pass.journal.push(...b.journal);
    else this.deferred.set(documentId, [...(this.deferred.get(documentId) ?? []), ...b.journal]);
  }

  /** Class of a record given a table of its hierarchy (or null when it does not exist). */
  private classOf(id: string, hint: string): string | null {
    if (!isSysId(id)) return null;
    const meta = hint ? this.platform.registry.tryTable(hint) : undefined;
    if (!meta) return null;
    const row = this.platform.db.get<{ cls: string | null }>(
      `SELECT "sys_class_name" AS "cls" FROM ${quoteIdent(meta.physical)} WHERE "sys_id" = ?`,
      [id],
    );
    if (!row) return null;
    return row.cls && this.platform.registry.has(row.cls) ? row.cls : meta.name;
  }

  private currentIteration(documentId: string): number {
    const row = this.platform.db.get<{ n: number | null }>(
      `SELECT MAX("iteration") AS "n" FROM "resolvr_approval_step" WHERE "document_id" = ?`,
      [documentId],
    );
    return row?.n ?? 0;
  }

  /** A new request after the record's approval was decided starts a new round (iteration). */
  private iterationForNewRequest(sys: Context, documentId: string): number {
    const iteration = this.currentIteration(documentId);
    const hasSteps = this.platform.db.get(
      `SELECT 1 AS "x" FROM "resolvr_approval_step" WHERE "document_id" = ? LIMIT 1`,
      [documentId],
    );
    if (!hasSteps) return 0;
    const state = this.rollup(sys, documentId).get('approval');
    return state === ST.approved || state === ST.rejected || state === ST.cancelled
      ? iteration + 1
      : iteration;
  }

  private manualStep(sys: Context, table: string, documentId: string): Rec {
    const iteration = this.currentIteration(documentId);
    const open = sys.query(STEP_TABLE, {
      query: `document_id=${documentId}^iteration=${iteration}^source=manual^stateIN${[...PENDING].join(',')}`,
      limit: 1,
    })[0];
    if (open) return open;
    return sys.insert(STEP_TABLE, {
      document_id: documentId,
      source_table: table,
      iteration,
      label: 'Approvers',
      rule: 'all',
      state: ST.notRequested,
      source: 'manual',
    });
  }

  private resolveUsers(values: unknown[]): string[] {
    const out: string[] = [];
    for (const v of values) {
      const raw = idOf(v);
      if (!raw) continue;
      const row = this.platform.db.get<{ sys_id: string; active: number | null }>(
        isSysId(raw)
          ? `SELECT "sys_id","active" FROM "sys_user" WHERE "sys_id" = ?`
          : `SELECT "sys_id","active" FROM "sys_user" WHERE "user_name" = ? COLLATE NOCASE OR "email" = ? COLLATE NOCASE LIMIT 1`,
        isSysId(raw) ? [raw] : [raw, raw],
      );
      if (!row || row.active === 0) continue;
      if (!out.includes(row.sys_id)) out.push(row.sys_id);
    }
    return out;
  }

  private resolveGroups(values: unknown[]): string[] {
    const out: string[] = [];
    for (const v of values) {
      const raw = idOf(v);
      if (!raw) continue;
      const row = this.platform.db.get<{ sys_id: string }>(
        isSysId(raw)
          ? `SELECT "sys_id" FROM "sys_user_group" WHERE "sys_id" = ?`
          : `SELECT "sys_id" FROM "sys_user_group" WHERE "name" = ? COLLATE NOCASE LIMIT 1`,
        [raw],
      );
      if (row && !out.includes(row.sys_id)) out.push(row.sys_id);
    }
    return out;
  }

  /** Member approvals of a group approval (created for active members when it is requested). */
  ensureGroupMembers(sys: Context, grow: Rec): Rec[] {
    const existing = sys.query(APPROVAL_TABLE, {
      query: `group=${grow.sysId}`,
      orderBy: [{ field: 'sys_created_on', desc: false }],
    });
    if (existing.length || grow.str('approval') !== ST.requested) return existing;
    const step = grow.str('resolvr_step') ? sys.get(STEP_TABLE, grow.str('resolvr_step')) : null;
    const documentId = step?.str('document_id') || grow.str('parent');
    const table = step?.str('source_table') || (documentId ? this.classOf(documentId, 'task') : null);
    if (!documentId || !table) return [];
    const isTask = this.platform.registry.isA(table, 'task');
    const members = this.platform.db.all<{ user: string }>(
      `SELECT m."user" AS "user" FROM "sys_user_grmember" m JOIN "sys_user" u ON u."sys_id" = m."user"
        WHERE m."group" = ? AND (u."active" IS NULL OR u."active" = 1) ORDER BY u."name", u."user_name"`,
      [grow.str('assignment_group')],
    );
    const out: Rec[] = [];
    for (const m of members) {
      out.push(
        sys.insert(APPROVAL_TABLE, {
          approver: m.user,
          document_id: documentId,
          source_table: table,
          sysapproval: isTask ? documentId : null,
          group: grow.sysId,
          state: ST.requested,
          order: 100,
          resolvr_step: step?.sysId ?? null,
          iteration: step?.num('iteration') ?? 0,
          due_date: grow.str('due_date') || null,
          approval_source: step?.str('source') || 'manual',
          flow_context: step?.str('flow_context') || null,
          approval_column: step?.str('approval_column') || 'approval',
          approval_journal_column: step?.str('journal_column') || 'approval_history',
        }),
      );
    }
    return out;
  }

  private stepsOf(sys: Context, documentId: string, iteration?: number): Rec[] {
    return sys.query(STEP_TABLE, {
      query: `document_id=${documentId}${iteration === undefined ? '' : `^iteration=${iteration}`}`,
      orderBy: [{ field: 'sys_created_on', desc: false }],
    });
  }

  /** Roll-up per approval column for the current iteration, from persisted step states. */
  private rollup(sys: Context, documentId: string): Map<string, string> {
    const steps = this.stepsOf(sys, documentId, this.currentIteration(documentId));
    const byColumn = new Map<string, string[]>([['approval', []]]);
    for (const s of steps) {
      const col = s.str('approval_column') || 'approval';
      const list = byColumn.get(col) ?? [];
      list.push(s.str('state'));
      byColumn.set(col, list);
    }
    return new Map([...byColumn].map(([col, states]) => [col, rollupStates(states)]));
  }

  /** Rows that lost their step (imports without business rules) join the manual step. */
  private adoptOrphans(sys: Context, documentId: string): void {
    const orphans = sys.query(APPROVAL_TABLE, { query: `document_id=${documentId}^resolvr_stepISEMPTY` });
    for (const r of orphans) {
      const table = r.str('source_table') || this.classOf(documentId, 'task');
      if (!table) continue;
      const step = this.manualStep(sys, table, documentId);
      sys
        .derive({ workflow: false })
        .update(r, { resolvr_step: step.sysId, iteration: step.num('iteration') ?? 0 });
    }
  }

  /**
   * Re-evaluates the open steps of a record and writes the roll-up. Re-entrant calls
   * (caused by the engine's own writes) mark the pass dirty so it loops until stable.
   */
  recompute(
    ctx: Context,
    documentId: string,
    journal: JournalLine[] = [],
    opts: { before?: string; decidedSources?: string[] } = {},
  ): void {
    if (!documentId) return;
    const building = this.building.get(documentId);
    if (building) {
      building.journal.push(...journal);
      return;
    }
    const running = this.passes.get(documentId);
    if (running) {
      running.dirty = true;
      running.journal.push(...journal);
      return;
    }
    const sys = this.sys(ctx);
    const pass: Pass = {
      dirty: true,
      journal: [...(this.deferred.get(documentId) ?? []), ...journal],
      decidedSteps: [],
      decidedSources: [...(opts.decidedSources ?? [])],
    };
    this.deferred.delete(documentId);
    this.passes.set(documentId, pass);
    let before = opts.before;
    let after: string = ST.notRequested;
    try {
      before ??= this.rollup(sys, documentId).get('approval') ?? ST.notRequested;
      for (let round = 0; pass.dirty && round < 10; round++) {
        pass.dirty = false;
        this.adoptOrphans(sys, documentId);
        for (const step of sys.query(STEP_TABLE, {
          query: `document_id=${documentId}^stateIN${[...PENDING].join(',')}`,
        })) {
          this.evaluateStep(sys, step, pass);
        }
        this.writeRollup(sys, documentId, pass);
      }
      after = this.rollup(sys, documentId).get('approval') ?? ST.notRequested;
    } finally {
      this.passes.delete(documentId);
    }
    for (const stepId of pass.decidedSteps) this.notifyStep(sys, stepId);
    if (after !== before && (after === ST.approved || after === ST.rejected))
      this.onRecordDecided(sys, documentId, after, pass);
  }

  /**
   * A duplicate row (same approver already asked for the record in this round) is not
   * asked again; it carries the answer of the original approval instead.
   */
  private effectiveRow(r: Rec): { state: string; decidedOn: string; seq: number } {
    const seq = r.num('sys_mod_count') ?? 0;
    if (r.str('state') !== ST.duplicate)
      return { state: r.str('state'), decidedOn: r.str('resolvr_decided_on'), seq };
    const original = this.platform.db.get<{ state: string; decided: string | null }>(
      `SELECT "state", "resolvr_decided_on" AS "decided" FROM "sysapproval_approver"
        WHERE "document_id" = ? AND "approver" = ? AND COALESCE("iteration",0) = ? AND "state" <> 'duplicate' AND "sys_id" <> ?
        ORDER BY ("state" = 'cancelled'), "sys_created_on" LIMIT 1`,
      [r.str('document_id'), r.str('approver'), r.num('iteration') ?? 0, r.sysId],
    );
    if (!original || original.state === ST.notRequired) return { state: ST.duplicate, decidedOn: '', seq };
    return { state: original.state, decidedOn: original.decided ?? '', seq };
  }

  private unitOutcome(unit: Unit, manual: boolean): 'pending' | 'approved' | 'rejected' {
    if (unit.group && DECIDED.has(unit.group.str('approval')))
      return unit.group.str('approval') as 'approved' | 'rejected';
    const res = evaluateUnit(
      unit.rule,
      unit.percentage,
      unit.rows.map((r) => this.effectiveRow(r)),
    );
    if (res !== 'empty') return res;
    if (manual) return 'pending';
    const empty = this.platform.properties.get('resolvr.approvals.empty_outcome', 'approved');
    return empty === 'rejected' ? 'rejected' : empty === 'pending' ? 'pending' : 'approved';
  }

  private evaluateStep(sys: Context, step: Rec, pass: Pass): void {
    if (!PENDING.has(step.str('state'))) return;
    const manual = step.str('source') === 'manual';
    const rows = sys.query(APPROVAL_TABLE, {
      query: `resolvr_step=${step.sysId}`,
      orderBy: [
        { field: 'order', desc: false },
        { field: 'sys_created_on', desc: false },
      ],
    });
    const groups = sys.query(GROUP_TABLE, { query: `resolvr_step=${step.sysId}` });
    const units: Unit[] = [];
    const userRows = rows.filter((r) => !r.str('group'));
    if (userRows.length || !groups.length) {
      units.push({
        group: null,
        rule: normalizeRule(step.str('rule'), 'any'),
        percentage: step.num('percentage'),
        rows: userRows,
      });
    }
    for (const g of groups) {
      units.push({
        group: g,
        rule: normalizeRule(g.str('resolvr_wait_for'), 'first_response'),
        percentage: g.num('resolvr_percentage'),
        rows: rows.filter((r) => r.str('group') === g.sysId),
      });
    }
    if (manual && !rows.some((r) => !IGNORED.has(this.effectiveRow(r).state))) {
      // Every hand-added approver was withdrawn (or only duplicates remain): the step
      // no longer takes part in the roll-up.
      const withdrawn = rows.some((r) => r.str('state') === ST.cancelled);
      sys.update(step, { state: withdrawn ? ST.cancelled : ST.notRequired, decided_on: nowGlide() });
      return;
    }
    const outcomes = units.map((u) => this.unitOutcome(u, manual));
    units.forEach((u, i) => {
      const o = outcomes[i];
      if (o === 'approved' || o === 'rejected') this.closeUnit(sys, u, o);
      else if (!manual) this.activateNext(sys, u);
    });
    const outcome = combineUnits(outcomes);
    if (outcome === 'pending') {
      const live = rows.filter((r) => r.str('state') === ST.requested || DECIDED.has(r.str('state')));
      const next = live.length || !manual ? ST.requested : ST.notRequested;
      if (step.str('state') !== next) sys.update(step, { state: next });
      return;
    }
    for (const u of units) {
      for (const r of u.rows)
        if (PENDING.has(r.str('state'))) this.setRowState(sys, r, ST.notRequired, outcome === ST.rejected);
      if (u.group && PENDING.has(u.group.str('approval'))) this.setGroupState(sys, u.group, ST.notRequired);
    }
    sys.update(step, { state: outcome, decided_on: nowGlide() });
    pass.decidedSteps.push(step.sysId);
    pass.decidedSources.push(step.str('source'));
  }

  private closeUnit(sys: Context, unit: Unit, outcome: 'approved' | 'rejected'): void {
    for (const r of unit.rows)
      if (PENDING.has(r.str('state'))) this.setRowState(sys, r, ST.notRequired, outcome === ST.rejected);
    if (unit.group && unit.group.str('approval') !== outcome) this.setGroupState(sys, unit.group, outcome);
  }

  /** Sequential requests: when nobody is being asked, ask the next approvers in order. */
  private activateNext(sys: Context, unit: Unit): void {
    if (unit.rows.some((r) => r.str('state') === ST.requested)) return;
    const waiting = unit.rows.filter((r) => r.str('state') === ST.notRequested);
    if (!waiting.length) return;
    const order = Math.min(...waiting.map((r) => r.num('order') ?? 100));
    for (const r of waiting) if ((r.num('order') ?? 100) === order) sys.update(r, { state: ST.requested });
  }

  private setRowState(sys: Context, row: Rec, state: string, byRejection: boolean): void {
    sys.update(row, { state });
    if (state === ST.notRequired && byRejection)
      sys.queueEvent('approval.rejected.by.other', row, row.str('approver'), row.str('document_id'));
  }

  private setGroupState(sys: Context, group: Rec, approval: string): void {
    const closeState = approval === ST.approved ? '3' : approval === ST.rejected ? '4' : '7';
    const values: Record<string, unknown> = { approval, state: closeState };
    if (DECIDED.has(approval)) values.approval_set = nowGlide();
    sys.update(group, values);
  }

  private targetOf(sys: Context, documentId: string): Rec | null {
    const row = this.platform.db.get<{ t: string | null }>(
      `SELECT "source_table" AS "t" FROM "resolvr_approval_step" WHERE "document_id" = ? AND "source_table" IS NOT NULL LIMIT 1`,
      [documentId],
    );
    const table = row?.t && this.platform.registry.has(row.t) ? row.t : null;
    return table ? sys.get(table, documentId) : null;
  }

  private writeRollup(sys: Context, documentId: string, pass: Pass): void {
    const target = this.targetOf(sys, documentId);
    if (!target) {
      pass.journal = [];
      return;
    }
    const values: Record<string, unknown> = {};
    let decided = false;
    for (const [col, state] of this.rollup(sys, documentId)) {
      const meta = target.column(col);
      if (!meta?.storage || target.str(col) === state) continue;
      values[col] = state;
      if (DECIDED.has(state)) decided = true;
    }
    if (decided && target.has('approval_set')) values.approval_set = nowGlide();
    for (const line of pass.journal) {
      const meta = target.column(line.column);
      if (meta && JOURNAL_TYPES.has(meta.type)) target.set(line.column, line.text);
    }
    pass.journal = [];
    if (Object.keys(values).length || target.journal.length) sys.update(target, values);
  }

  private onRecordDecided(
    sys: Context,
    documentId: string,
    decision: 'approved' | 'rejected',
    pass: Pass,
  ): void {
    let target = this.targetOf(sys, documentId);
    if (!target) return;
    const uponReject = target.has('upon_reject') ? target.str('upon_reject') || 'cancel' : 'cancel';
    if (decision === ST.rejected) {
      const gotoId = target.has('rejection_goto') ? target.str('rejection_goto') : '';
      if (uponReject === 'goto' && gotoId) this.reopen(sys, gotoId);
      else this.cancelPending(sys, documentId, 'the approval was rejected');
      target = this.targetOf(sys, documentId) ?? target;
    }
    const handlers = target.table.ancestors.flatMap((t) => this.handlers.get(t) ?? []);
    for (const h of handlers) {
      try {
        h(target, decision, sys);
      } catch (e) {
        this.platform.reportError(`approval decision handler (${target.className})`, e);
      }
    }
    if (
      !handlers.length &&
      decision === ST.rejected &&
      uponReject === 'cancel' &&
      !pass.decidedSources.includes('flow')
    ) {
      this.closeRejected(sys, target);
    }
  }

  /** Platform default when no module handles a rejection: close the task as incomplete. */
  private closeRejected(sys: Context, target: Rec): void {
    if (!target.table.ancestors.includes('task') || !target.bool('active')) return;
    if (!this.platform.properties.getBool('resolvr.approvals.reject_closes_task', true)) return;
    const model = (this.platform.services.get('tasks') as TaskModels | undefined)?.model(target.className);
    const state = model
      ? model.closed.includes('4')
        ? '4'
        : (model.defaultClosed ?? model.closed[0])
      : null;
    sys.update(target, state ? { state } : { active: false });
  }

  private reopen(sys: Context, taskId: string): void {
    const table = this.classOf(taskId, 'task');
    const task = table ? sys.get(table, taskId) : null;
    if (!task) return;
    const model = (this.platform.services.get('tasks') as TaskModels | undefined)?.model(task.className);
    const open = this.platform.choices
      .list(task.className, 'state')
      .map((c) => c.value)
      .find((v) => !(model?.closed ?? []).includes(v) && Number(v) > 0);
    sys.update(task, open ? { state: open, active: true } : { active: true });
  }

  /** Cancels the pending approvals and steps of a record. */
  private cancelPending(sys: Context, documentId: string, reason: string): void {
    const pendingList = [...PENDING].join(',');
    const rows = sys.query(APPROVAL_TABLE, { query: `document_id=${documentId}^stateIN${pendingList}` });
    const steps = sys.query(STEP_TABLE, { query: `document_id=${documentId}^stateIN${pendingList}` });
    if (!rows.length && !steps.length) return;
    const before = this.passes.has(documentId)
      ? undefined
      : (this.rollup(sys, documentId).get('approval') ?? ST.notRequested);
    this.beginBuild(documentId);
    try {
      for (const r of rows) sys.update(r, { state: ST.cancelled });
      for (const s of steps) {
        for (const g of sys.query(GROUP_TABLE, {
          query: `resolvr_step=${s.sysId}^approvalIN${pendingList}`,
        })) {
          this.setGroupState(sys, g, ST.cancelled);
        }
        sys.update(s, { state: ST.cancelled, decided_on: nowGlide() });
      }
    } finally {
      this.endBuild(documentId);
    }
    const column =
      steps[0]?.str('journal_column') || rows[0]?.str('approval_journal_column') || 'approval_history';
    this.recompute(
      sys,
      documentId,
      [{ column, text: `Pending approvals cancelled: ${reason}` }],
      before ? { before } : {},
    );
    for (const s of steps) this.notifyStep(sys, s.sysId);
  }

  private notifyStep(sys: Context, stepId: string): void {
    if (!this.stepListeners.length) return;
    const step = sys.get(STEP_TABLE, stepId);
    if (!step || PENDING.has(step.str('state'))) return;
    for (const l of this.stepListeners) {
      try {
        l(step, step.str('state'), sys);
      } catch (e) {
        this.platform.reportError('approval step listener', e);
      }
    }
  }

  private historyText(ctx: Context, row: Rec, decision: string): string {
    const approverName = row.display('approver') || 'Unknown approver';
    const me = ctx.user.sysId;
    const who =
      me && me !== row.str('approver')
        ? `${ctx.user.name || ctx.user.userName} on behalf of ${approverName}`
        : approverName;
    const record = row.display('document_id') || 'the record';
    let text = `${who} ${decision} ${record}`;
    const latest = this.platform.history.journal(APPROVAL_TABLE, row.sysId, ['comments'])[0];
    if (latest?.value) text += `\n${latest.value}`;
    return text;
  }
}

function idOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    const o = v as { sysId?: unknown; sys_id?: unknown; value?: unknown; $sys_id?: unknown };
    if (typeof o.sysId === 'string') return o.sysId;
    if (typeof o.$sys_id === 'string') return o.$sys_id;
    if (typeof o.sys_id === 'string') return o.sys_id;
    if (typeof o.value === 'string') return o.value;
  }
  return '';
}
