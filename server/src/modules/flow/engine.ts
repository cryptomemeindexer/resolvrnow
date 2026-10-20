import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import { parseEncodedQuery } from '../../engine/query/parser.js';
import type { Rec } from '../../engine/record.js';
import type { SessionUser } from '../../engine/services/users.js';
import type { RowData } from '../../engine/types.js';
import { clock, isSysId, newSysId, nowGlide, toGlideDateTime } from '../../engine/util.js';
import type { ApprovalEngine } from '../approvals/engine.js';
import { type FlowService, optionalService, SERVICES } from '../contracts.js';
import { type ActionImpl, BUILTIN_ACTIONS } from './actions.js';
import { ACTION_ALIASES, compile, validateDefinition } from './definition.js';
import { recordMatches, toRec } from './expr.js';
import { Execution, errorText, type LoadedFlow, parseJson } from './runtime.js';
import { nextRun } from './schedule.js';
import { CONTEXT_TABLE, FLOW_TABLE, INTERNAL_ROOTS, SNAPSHOT_TABLE } from './tables.js';
import type {
  FlowDefinition,
  FlowStep,
  Plan,
  RecordTrigger,
  RunState,
  ScheduledTrigger,
  WaitInfo,
} from './types.js';

/** Custom action contract (FlowService.registerAction). */
export type CustomAction = Parameters<FlowService['registerAction']>[1];

export const ACTIVE_STATES = ['QUEUED', 'IN_PROGRESS', 'WAITING'] as const;

interface TriggerEntry {
  flowId: string;
  trigger: RecordTrigger;
  /** Fields named in the condition (each_unique_change). */
  fields: string[];
}

export interface StartOptions {
  record?: Rec | null;
  previous?: RowData | null;
  operation?: string;
  user?: string | null;
  inputs?: Record<string, unknown>;
  source?: string;
  parent?: { context: string; step: string } | null;
  depth?: number;
  /** Manual test run: drafts run with their current definition. */
  test?: boolean;
}

export function flowEngine(platform: Platform): FlowEngine {
  return platform.service<FlowEngine>('flows');
}

/**
 * Flow engine: record, scheduled and API triggers, a persistent runner for executions
 * (sys_flow_context) and the registry of actions. Executions are run asynchronously
 * (platform async queue, then the `flow.runner` job) so a trigger never runs a flow
 * inside the transaction that fired it.
 */
export class FlowEngine implements FlowService {
  private custom = new Map<string, CustomAction>();
  private triggers: Map<string, TriggerEntry[]> | null = null;
  private programs = new Map<string, LoadedFlow>();
  private executing: { flow: string; record: string; context: string }[] = [];
  /** Unknown actions are only refused once every module had the chance to register its actions (after boot). */
  strictActions = false;

  constructor(readonly platform: Platform) {}

  // ---------------------------------------------------------------- contract

  /** Queues an execution of an active, published flow (by sys_id, internal name or name). */
  start(ctx: Context, flow: string, record: Rec | null, inputs: Record<string, unknown> = {}): Rec | null {
    const sys = this.sys(ctx);
    const flowRec = this.findFlow(sys, flow);
    if (!flowRec?.bool('active') || flowRec.str('status') !== 'published') return null;
    const c = this.createContext(sys, flowRec, {
      record,
      operation: 'api',
      user: ctx.user.sysId,
      inputs,
      source: 'api',
    });
    this.enqueue(c.sysId);
    return c;
  }

  registerAction(type: string, run: CustomAction): void {
    if (!/^[A-Za-z_][\w.-]*$/.test(type)) throw new Error(`Invalid action type ${type}`);
    this.custom.set(type, run);
  }

  // -------------------------------------------------------------- extensions

  /** Creates an execution and runs it right away (manual runs, REST); returns the execution. */
  startNow(ctx: Context, flow: string | Rec, opts: StartOptions = {}): Rec {
    const sys = this.sys(ctx);
    const flowRec = typeof flow === 'string' ? this.findFlow(sys, flow) : sys.get(FLOW_TABLE, flow.sysId);
    if (!flowRec) throw new InvalidError('Unknown flow');
    const test = opts.test ?? flowRec.str('status') !== 'published';
    const c = this.createContext(sys, flowRec, {
      operation: 'manual',
      user: ctx.user.sysId,
      source: 'manual',
      ...opts,
      test,
    });
    this.runContext(c.sysId);
    return sys.get(CONTEXT_TABLE, c.sysId) ?? c;
  }

  /** Cancels a queued, running or waiting execution (and its pending approvals or subflows). */
  cancel(ctx: Context, contextId: string, reason = 'Cancelled'): boolean {
    const sys = this.sys(ctx);
    const c = sys.get(CONTEXT_TABLE, contextId);
    if (!c || !(ACTIVE_STATES as readonly string[]).includes(c.str('state'))) return false;
    const run = parseJson<RunState | null>(c.str('attributes'), null);
    sys.derive({ workflow: false }).update(c, {
      state: 'CANCELLED',
      error_message: reason,
      resolvr_wait_on: null,
      resolvr_wake_at: null,
      resolvr_ended: nowGlide(),
    });
    const w = run?.wait;
    if (w?.kind === 'approval')
      this.approvals()?.resolveStep(sys, w.approval_step, 'cancelled', 'the flow was cancelled');
    if (w?.kind === 'subflow') this.cancel(ctx, w.context, reason);
    const plan = parseJson<Plan | null>(c.str('plan'), null);
    if (plan?.parent) this.wake(plan.parent.context);
    return true;
  }

  /** Runs an execution if it is queued or its wait is over. Safe to call repeatedly. */
  runContext(contextId: string): void {
    try {
      this.platform.db.tx(() => this.execute(contextId));
    } catch (e) {
      // Unexpected engine failure: record it on the execution so it is not retried forever.
      this.platform.db.tx(() => {
        const sys = this.platform.systemContext().derive({ workflow: false });
        const c = sys.get(CONTEXT_TABLE, contextId);
        if (c && (ACTIVE_STATES as readonly string[]).includes(c.str('state'))) {
          sys.update(c, {
            state: 'ERROR',
            error_message: `Flow engine error: ${errorText(e)}`.slice(0, 4000),
            resolvr_wait_on: null,
            resolvr_wake_at: null,
          });
        }
      });
      this.platform.reportError(`flow execution ${contextId}`, e);
    }
  }

  /** Runner job: queued executions and waiting executions that are due. */
  tick(): number {
    const rows = this.platform.db.all<{ sys_id: string }>(
      `SELECT "sys_id" FROM "sys_flow_context" WHERE "state" = 'QUEUED' OR ("state" = 'WAITING' AND "resolvr_wake_at" IS NOT NULL AND "resolvr_wake_at" <= ?) ORDER BY "sys_created_on", rowid LIMIT 200`,
      [nowGlide()],
    );
    for (const r of rows) this.runContext(r.sys_id);
    return rows.length;
  }

  /** Scheduler job: starts scheduled flows whose next run is due. */
  runSchedules(): number {
    const sys = this.platform.systemContext();
    const due = sys.query(FLOW_TABLE, {
      query: `active=true^status=published^resolvr_trigger_type=scheduled^resolvr_next_runISNOTEMPTY^resolvr_next_run<=${nowGlide()}`,
    });
    for (const f of due) {
      const def = this.load(sys, f, null).def;
      const next = def.trigger?.type === 'scheduled' ? nextRun(def.trigger, clock.now(), true) : null;
      sys.derive({ workflow: false }).update(f, { resolvr_next_run: next ? toGlideDateTime(next) : null });
      const c = this.createContext(sys, f, { operation: 'schedule', source: 'schedule' });
      this.runContext(c.sysId);
    }
    return due.length;
  }

  // ---------------------------------------------------------------- triggers

  /** Record hook: fires record triggers and wakes executions waiting on the record. */
  onRecordWrite(op: 'insert' | 'update', rec: Rec, previous: Rec | null, ctx: Context): void {
    if (INTERNAL_ROOTS.has(rec.table.root) || !ctx.workflow) return;
    this.wakeConditionWaits(rec, previous, op === 'insert', ctx);
    const index = this.triggerIndex();
    if (!index.size) return;
    const entries = rec.table.ancestors.flatMap((t) => index.get(t) ?? []);
    for (const e of entries) {
      try {
        this.fireTrigger(e, op, rec, previous, ctx);
      } catch (err) {
        this.platform.reportError(`flow trigger ${e.flowId}`, err);
      }
    }
  }

  private fireTrigger(
    e: TriggerEntry,
    op: 'insert' | 'update',
    rec: Rec,
    previous: Rec | null,
    ctx: Context,
  ): void {
    const t = e.trigger;
    const when = t.when ?? 'created_or_updated';
    if (op === 'insert' && when === 'updated') return;
    if (op === 'update' && when === 'created') return;
    // A flow never re-triggers itself on the record it is running for.
    if (this.executing.some((x) => x.flow === e.flowId && x.record === rec.sysId)) return;
    const env = {
      registry: this.platform.registry,
      macros: ctx.env,
      root: () => undefined,
      load: () => null,
    };
    if (
      t.condition &&
      !recordMatches(rec, t.condition, env, op === 'update' ? previous : null, op === 'insert')
    )
      return;
    const mode = t.run ?? 'each_unique_change';
    if (
      mode === 'each_unique_change' &&
      op === 'update' &&
      e.fields.length &&
      !e.fields.some((f) => rec.changed(f))
    )
      return;
    if (mode === 'once' && this.hasExecution(e.flowId, rec.sysId)) return;
    if (mode === 'if_not_running' && this.hasExecution(e.flowId, rec.sysId, true)) return;
    const sys = this.sys(ctx);
    const flowRec = sys.get(FLOW_TABLE, e.flowId);
    if (!flowRec) return;
    const c = this.createContext(sys, flowRec, {
      record: rec,
      previous: op === 'update' && previous ? { ...previous.data } : null,
      operation: op,
      user: ctx.user.sysId,
      source: 'trigger',
    });
    this.enqueue(c.sysId);
  }

  private hasExecution(flowId: string, recordId: string, activeOnly = false): boolean {
    const row = this.platform.db.get(
      `SELECT 1 AS "x" FROM "sys_flow_context" WHERE "flow" = ? AND "source_record" = ?${
        activeOnly ? ` AND "state" IN ('QUEUED','IN_PROGRESS','WAITING')` : ''
      } LIMIT 1`,
      [flowId, recordId],
    );
    return !!row;
  }

  private wakeConditionWaits(rec: Rec, previous: Rec | null, isNew: boolean, ctx: Context): void {
    const rows = this.platform.db.all<{ sys_id: string; attributes: string | null }>(
      `SELECT "sys_id","attributes" FROM "sys_flow_context" WHERE "state" = 'WAITING' AND "resolvr_wait_on" = ?`,
      [rec.sysId],
    );
    if (!rows.length) return;
    const env = {
      registry: this.platform.registry,
      macros: ctx.env,
      root: () => undefined,
      load: () => null,
    };
    for (const r of rows) {
      const run = parseJson<RunState | null>(r.attributes ?? '', null);
      const w = run?.wait;
      if (!run || !w || w.kind !== 'condition') continue;
      if (w.query !== undefined) {
        if (!recordMatches(rec, w.query, env, previous, isNew)) continue;
        (w as Extract<WaitInfo, { kind: 'condition' }>).satisfied = true;
        this.platform.db.run(`UPDATE "sys_flow_context" SET "attributes" = ? WHERE "sys_id" = ?`, [
          JSON.stringify(run),
          r.sys_id,
        ]);
      }
      this.wake(r.sys_id);
    }
  }

  /** Approval listener: resumes executions waiting for a decided approval step. */
  onApprovalStepDecided(step: Rec): void {
    const rows = this.platform.db.all<{ sys_id: string }>(
      `SELECT "sys_id" FROM "sys_flow_context" WHERE "state" = 'WAITING' AND "resolvr_wait_on" = ?`,
      [`approval:${step.sysId}`],
    );
    for (const r of rows) this.wake(r.sys_id);
  }

  /** Marks a waiting execution due now and queues a run. */
  wake(contextId: string): void {
    this.platform.db.run(
      `UPDATE "sys_flow_context" SET "resolvr_wake_at" = ? WHERE "sys_id" = ? AND "state" = 'WAITING'`,
      [nowGlide(), contextId],
    );
    this.enqueue(contextId);
  }

  setWakeAt(contextId: string, at: string | null): void {
    this.platform.db.run(`UPDATE "sys_flow_context" SET "resolvr_wake_at" = ? WHERE "sys_id" = ?`, [
      at,
      contextId,
    ]);
  }

  private enqueue(contextId: string): void {
    this.platform.enqueueAsync(`flow:${contextId}`, () => this.runContext(contextId));
  }

  private triggerIndex(): Map<string, TriggerEntry[]> {
    if (this.triggers) return this.triggers;
    const index = new Map<string, TriggerEntry[]>();
    const sys = this.platform.systemContext();
    for (const f of sys.query(FLOW_TABLE, {
      query: 'active=true^status=published^resolvr_trigger_type=record',
    })) {
      let def: FlowDefinition;
      try {
        def = this.load(sys, f, null).def;
      } catch {
        continue;
      }
      const t = def.trigger;
      if (t?.type !== 'record' || !this.platform.registry.has(t.table)) continue;
      const fields = new Set<string>();
      for (const block of parseEncodedQuery(t.condition ?? '').blocks)
        for (const cluster of block)
          for (const cond of cluster) if (cond.field) fields.add(cond.field.split('.')[0]);
      const list = index.get(t.table) ?? [];
      list.push({ flowId: f.sysId, trigger: t, fields: [...fields] });
      index.set(t.table, list);
    }
    this.triggers = index;
    return index;
  }

  invalidate(): void {
    this.triggers = null;
    for (const k of [...this.programs.keys()]) if (!k.startsWith('snap:')) this.programs.delete(k);
  }

  // --------------------------------------------------------------- executions

  findFlow(sys: Context, ref: string | Rec): Rec | null {
    if (typeof ref !== 'string') return sys.get(FLOW_TABLE, ref.sysId);
    const s = ref.trim();
    if (!s) return null;
    if (isSysId(s)) {
      const r = sys.get(FLOW_TABLE, s);
      if (r) return r;
    }
    return sys.getBy(FLOW_TABLE, 'internal_name', s) ?? sys.getBy(FLOW_TABLE, 'name', s);
  }

  /** Definition and compiled program for a flow (a snapshot when given or published). */
  load(sys: Context, flowRec: Rec | null, snapshotId: string | null, draft = false): LoadedFlow {
    let snapshot: Rec | null = null;
    if (snapshotId) snapshot = sys.get(SNAPSHOT_TABLE, snapshotId);
    if (!snapshot && !draft && flowRec?.str('master_snapshot'))
      snapshot = sys.get(SNAPSHOT_TABLE, flowRec.str('master_snapshot'));
    const key = snapshot
      ? `snap:${snapshot.sysId}`
      : `draft:${flowRec?.sysId ?? ''}:${flowRec?.str('sys_mod_count') ?? ''}:${flowRec?.str('sys_updated_on') ?? ''}`;
    const hit = this.programs.get(key);
    if (hit) return hit;
    const raw = snapshot ? snapshot.str('definition') : (flowRec?.str('resolvr_definition') ?? '');
    if (!raw) throw new Error('The flow has no definition');
    const def = JSON.parse(raw) as FlowDefinition;
    const loaded: LoadedFlow = { def, program: compile(def), snapshot: snapshot?.sysId ?? null };
    if (this.programs.size > 500) this.programs.clear();
    this.programs.set(key, loaded);
    return loaded;
  }

  createContext(sys: Context, flowRec: Rec, opts: StartOptions): Rec {
    const loaded = this.load(sys, flowRec, null, !!opts.test && flowRec.str('status') !== 'published');
    const def = loaded.def;
    const record = opts.record ?? null;
    const plan: Plan = {
      trigger: {
        table: record?.className ?? null,
        sys_id: record?.sysId ?? null,
        operation: opts.operation ?? 'api',
        user: opts.user ?? null,
        previous: opts.previous ?? null,
      },
      inputs: this.inputsFor(def, opts.inputs ?? {}),
      parent: opts.parent ?? null,
      depth: opts.depth ?? 0,
    };
    const vars: Record<string, unknown> = {};
    for (const v of def.variables ?? []) vars[v.name] = v.default ?? null;
    const run: RunState = {
      pc: 0,
      mode: 'main',
      vars,
      steps: {},
      loops: [],
      outputs: {},
      wait: null,
      error: null,
      executed: 0,
      seq: 0,
    };
    return sys.derive({ workflow: false }).insert(CONTEXT_TABLE, {
      name: flowRec.str('name') || def.name || 'Flow',
      flow: flowRec.sysId,
      snapshot: loaded.snapshot,
      state: 'QUEUED',
      source_table: plan.trigger.table,
      source_record: plan.trigger.sys_id,
      plan: JSON.stringify(plan),
      attributes: JSON.stringify(run),
      execution_id: newSysId(),
      is_test_run: !!opts.test,
      reporting: 'ON',
      run_time: 0,
      calling_source: opts.source ?? 'api',
      resolvr_parent: opts.parent?.context ?? null,
    });
  }

  private inputsFor(def: FlowDefinition, given: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...given };
    for (const d of def.inputs ?? []) {
      if (out[d.name] === undefined || out[d.name] === '') out[d.name] = d.default ?? null;
      if (d.mandatory && (out[d.name] === null || out[d.name] === undefined || out[d.name] === '')) {
        throw new InvalidError(`Flow input "${d.name}" is required`);
      }
    }
    return out;
  }

  private execute(contextId: string): void {
    const sys = this.platform.systemContext();
    const c = sys.get(CONTEXT_TABLE, contextId);
    if (!c) return;
    const state = c.str('state');
    if (state !== 'QUEUED' && state !== 'WAITING') return;
    const plan = parseJson<Plan>(c.str('plan'), {
      trigger: { table: null, sys_id: null, operation: 'api', user: null, previous: null },
      inputs: {},
    });
    const run = parseJson<RunState>(c.str('attributes'), {
      pc: 0,
      mode: 'main',
      vars: {},
      steps: {},
      loops: [],
      outputs: {},
      wait: null,
      error: null,
      executed: 0,
      seq: 0,
    });
    const flowRec = c.str('flow') ? sys.get(FLOW_TABLE, c.str('flow')) : null;
    let loaded: LoadedFlow;
    try {
      loaded = this.load(sys, flowRec, c.str('snapshot') || null, c.bool('is_test_run'));
    } catch (e) {
      sys.derive({ workflow: false }).update(c, {
        state: 'ERROR',
        error_message: `The flow definition cannot be loaded: ${errorText(e)}`,
      });
      return;
    }
    const execution = new Execution(this, sys, c, flowRec, loaded, plan, run);
    if (state === 'WAITING' && !execution.resume()) return;
    execution.execute();
  }

  // ------------------------------------------------------- runtime services

  enter(entry: { flow: string; record: string; context: string }): void {
    this.executing.push(entry);
  }

  leave(): void {
    this.executing.pop();
  }

  approvals(): ApprovalEngine | undefined {
    return optionalService<ApprovalEngine>(this.platform, SERVICES.approvals);
  }

  maxIterations(): number {
    return this.platform.properties.getNumber('resolvr.flows.max_iterations', 1000);
  }

  maxActions(): number {
    return this.platform.properties.getNumber('resolvr.flows.max_actions', 50);
  }

  knownActions(): Set<string> {
    return new Set([...Object.keys(BUILTIN_ACTIONS), ...this.custom.keys(), ...Object.keys(ACTION_ALIASES)]);
  }

  /** Built-in or registered action (registered actions take precedence). */
  action(name: string): ActionImpl | undefined {
    const custom = this.custom.get(name);
    if (custom) {
      return (inputs, rt) => {
        const record =
          inputs.record !== undefined
            ? toRec(inputs.record, rt.env, typeof inputs.table === 'string' ? inputs.table : null)
            : rt.trigger();
        return { outputs: custom(rt.ctx, inputs, record) ?? {} };
      };
    }
    return BUILTIN_ACTIONS[name];
  }

  findStep(loaded: LoadedFlow, id: string): FlowStep | null {
    const walk = (steps: unknown): FlowStep | null => {
      if (!Array.isArray(steps)) return null;
      for (const s of steps as FlowStep[]) {
        if (s?.id === id) return s;
        for (const child of [
          s.then,
          s.else,
          s.steps,
          ...(Array.isArray(s.else_if) ? (s.else_if as { steps?: unknown }[]).map((b) => b.steps) : []),
        ]) {
          const hit = walk(child);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(loaded.def.steps) ?? walk(loaded.def.error_handler);
  }

  /** Scripts run only in flows whose last editor is an administrator. */
  trustedScripts(flow: Rec | null): boolean {
    if (!flow) return false;
    const by = flow.str('sys_updated_by');
    if (by === 'system') return true;
    return !!this.platform.users.byUserName(by)?.isAdmin;
  }

  /** Identity of an execution: system, or the triggering user (plus run_with_roles). */
  runAsContext(def: FlowDefinition, plan: Plan): Context {
    if ((def.run_as ?? 'system') === 'user' && plan.trigger.user) {
      const session = this.platform.users.session(plan.trigger.user);
      if (session) {
        const roles = new Set([...session.roles, ...(def.run_with_roles ?? [])]);
        const user: SessionUser = { ...session, roles, isAdmin: session.isAdmin || roles.has('admin') };
        return this.platform.contextFor(user);
      }
    }
    return this.platform.systemContext();
  }

  private sys(ctx: Context): Context {
    return ctx.derive({ acl: false, workflow: true });
  }

  // --------------------------------------------------------------- publishing

  /** Before insert/update of a flow: validates the JSON definition and syncs header fields. */
  prepareFlow(cur: Rec): void {
    const raw = cur.str('resolvr_definition').trim();
    if (!raw) {
      if (cur.str('status') === 'published') cur.abort('A published flow needs a definition');
      cur.setRaw('resolvr_trigger_type', null);
      cur.setRaw('resolvr_trigger_table', null);
      return;
    }
    let def: FlowDefinition;
    try {
      def = JSON.parse(raw) as FlowDefinition;
    } catch (e) {
      cur.abort(`The flow definition is not valid JSON: ${errorText(e)}`);
      return;
    }
    const errors = this.validate(def);
    if (errors.length) {
      cur.abort(`Invalid flow definition: ${errors.slice(0, 6).join('; ')}`);
      return;
    }
    if (!cur.str('name') && def.name) cur.setRaw('name', def.name);
    if (!cur.str('name')) {
      cur.abort('A flow needs a name');
      return;
    }
    const internal =
      def.internal_name ||
      cur.str('internal_name') ||
      cur
        .str('name')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (cur.str('internal_name') !== internal) cur.setRaw('internal_name', internal);
    const dup = this.platform.db.get(
      `SELECT "sys_id" FROM "sys_hub_flow_block" WHERE "internal_name" = ? AND "sys_id" <> ? AND "sys_class_name" = 'sys_hub_flow' LIMIT 1`,
      [internal, cur.sysId],
    );
    if (dup) {
      cur.abort(`Another flow already uses the internal name "${internal}"`);
      return;
    }
    if (def.type && cur.str('type') !== def.type) cur.setRaw('type', def.type);
    if (def.run_as && cur.str('run_as') !== def.run_as) cur.setRaw('run_as', def.run_as);
    if (def.description && !cur.str('description')) cur.setRaw('description', def.description);
    const trigger = def.trigger ?? null;
    cur.setRaw('resolvr_trigger_type', trigger?.type ?? (def.type === 'subflow' ? null : 'api'));
    cur.setRaw('resolvr_trigger_table', trigger?.type === 'record' ? trigger.table : null);
  }

  /** After insert/update of a flow: publishes a snapshot and schedules the next run. */
  afterFlowSaved(cur: Rec, previous: Rec | null, ctx: Context): void {
    const sys = this.sys(ctx);
    const fresh = sys.get(FLOW_TABLE, cur.sysId);
    if (!fresh) return;
    const values: Record<string, unknown> = {};
    const published = fresh.str('status') === 'published' && !!fresh.str('resolvr_definition');
    const definitionChanged = !previous || cur.changed('resolvr_definition');
    const statusChanged = !previous || cur.changed('status') || cur.changed('active');
    if (published && (definitionChanged || statusChanged || !fresh.str('master_snapshot'))) {
      const last = this.platform.db.get<{ v: number | null }>(
        `SELECT MAX("version") AS "v" FROM "resolvr_flow_snapshot" WHERE "flow" = ?`,
        [fresh.sysId],
      );
      const current = fresh.str('master_snapshot')
        ? sys.get(SNAPSHOT_TABLE, fresh.str('master_snapshot'))
        : null;
      if (!current || current.str('definition') !== fresh.str('resolvr_definition')) {
        const snap = sys.derive({ workflow: false }).insert(SNAPSHOT_TABLE, {
          flow: fresh.sysId,
          version: (last?.v ?? 0) + 1,
          definition: fresh.str('resolvr_definition'),
        });
        values.master_snapshot = snap.sysId;
        values.latest_snapshot = snap.sysId;
      }
    }
    if (definitionChanged || statusChanged) {
      let next: string | null = null;
      if (published && fresh.bool('active')) {
        try {
          const def = JSON.parse(fresh.str('resolvr_definition')) as FlowDefinition;
          if (def.trigger?.type === 'scheduled') {
            const at = nextRun(def.trigger as ScheduledTrigger, clock.now());
            next = at ? toGlideDateTime(at) : null;
          }
        } catch {
          next = null;
        }
      }
      if ((fresh.str('resolvr_next_run') || null) !== next) values.resolvr_next_run = next;
    }
    if (Object.keys(values).length) sys.derive({ workflow: false }).update(fresh, values);
    this.invalidate();
  }

  /** Validation errors of a definition (UI and tests). */
  validate(def: unknown): string[] {
    return validateDefinition(def, {
      actions: this.strictActions ? this.knownActions() : null,
      maxActions: this.maxActions(),
      maxIterations: this.maxIterations(),
    });
  }
}
