/**
 * One run of a flow execution (sys_flow_context): interprets the compiled program
 * from the persisted program counter until the flow ends, fails or waits. Waiting
 * persists everything needed to resume in `attributes` so executions survive restarts.
 */
import type { Context } from '../../engine/context.js';
import { Rec } from '../../engine/record.js';
import { addMs, normalizeDateTime, nowGlide } from '../../engine/util.js';
import { optionalService, type ScheduleService, SERVICES } from '../contracts.js';
import type { ActionOutcome, ActionRuntime } from './actions.js';
import { actionName, type Instr, type Program, stepKind } from './definition.js';
import type { FlowEngine } from './engine.js';
import { type EvalEnv, evalCondition, recordMatches, refOf, render, serialize, toRec } from './expr.js';
import { durationMs } from './schedule.js';
import { CONTEXT_TABLE, LOG_TABLE } from './tables.js';
import type { FlowDefinition, FlowStep, LoopFrame, Plan, RunState, WaitInfo } from './types.js';

export interface LoadedFlow {
  def: FlowDefinition;
  program: Program;
  snapshot: string | null;
}

type StepResult = undefined | 'wait' | { status: 'COMPLETE' | 'ERROR'; message?: string };

const MAX_INSTRUCTIONS = 100_000;
const SUCCESS = { code: 'success', message: '' };
const SECRET_KEY = /pass(word)?|secret|token|credential|api_?key/i;

export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const detail = (e as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail && detail !== e.message
      ? `${e.message}: ${detail}`
      : e.message;
  }
  return String(e);
}

export function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return '...';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '********' : redact(x, depth + 1);
    return out;
  }
  return v;
}

function jsonOf(v: unknown): string | null {
  if (v === undefined) return null;
  const s = JSON.stringify(redact(serialize(v)));
  return s && s.length > 20_000 ? `${s.slice(0, 19_990)}..."` : (s ?? null);
}

function toList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [v];
}

function stepOf(ins: Instr): FlowStep | null {
  return 'step' in ins ? ins.step : null;
}

/** Merges the step's own keys with its `inputs` (wait steps accept both shapes). */
function stepArgs(step: FlowStep): Record<string, unknown> {
  const inputs =
    step.inputs && typeof step.inputs === 'object' && !Array.isArray(step.inputs)
      ? (step.inputs as Record<string, unknown>)
      : {};
  return { ...inputs, ...step };
}

export class Execution {
  readonly env: EvalEnv;
  readonly runCtx: Context;
  private startedAt = performance.now();
  private triggerPill: Record<string, unknown> | null = null;

  constructor(
    private readonly engine: FlowEngine,
    private readonly sys: Context,
    private readonly c: Rec,
    private readonly flow: Rec | null,
    private readonly loaded: LoadedFlow,
    private readonly plan: Plan,
    private readonly run: RunState,
  ) {
    this.runCtx = engine.runAsContext(loaded.def, plan);
    this.env = this.makeEnv();
  }

  private get program(): Instr[] {
    return this.run.mode === 'main' ? this.loaded.program.main : this.loaded.program.handler;
  }

  private get maxIterations(): number {
    return this.engine.maxIterations();
  }

  // ------------------------------------------------------------------ pills

  private makeEnv(): EvalEnv {
    const registry = this.engine.platform.registry;
    return {
      registry,
      macros: this.runCtx.env,
      load: (table, id) => (id && registry.has(table) ? this.sys.get(table, id) : null),
      root: (name) => {
        switch (name) {
          case 'trigger':
            this.triggerPill ??= this.makeTriggerPill();
            return this.triggerPill;
          case 'inputs':
            return this.plan.inputs ?? {};
          case 'vars':
          case 'variables':
            return this.run.vars;
          case 'steps':
            return this.run.steps;
          case 'error':
            return this.run.error ?? {};
          case 'outputs':
            return this.run.outputs;
          case 'now':
            return nowGlide();
          case 'run_as_user':
            return this.runCtx.user.sysId ?? '';
          case 'context':
            return { sys_id: this.c.sysId, name: this.c.str('name'), flow: this.c.str('flow') };
          case 'loop': {
            const f = this.innermostEach();
            return f ? { index: f.index, count: f.items?.length ?? 0 } : undefined;
          }
          default:
            for (let i = this.run.loops.length - 1; i >= 0; i--) {
              const f = this.run.loops[i];
              if (f.kind === 'each' && (f.as ?? 'item') === name) return f.items?.[f.index];
            }
            return undefined;
        }
      },
    };
  }

  private makeTriggerPill(): Record<string, unknown> {
    const t = this.plan.trigger;
    const ref = t.table && t.sys_id ? { $table: t.table, $sys_id: t.sys_id } : null;
    const meta = t.table ? this.engine.platform.registry.tryTable(t.table) : undefined;
    const previous =
      t.previous && meta ? new Rec(this.sys, meta, { ...t.previous }, { ...t.previous }) : null;
    return {
      current: ref,
      record: ref,
      previous,
      table: t.table,
      sys_id: t.sys_id,
      operation: t.operation,
      user: t.user,
    };
  }

  private innermostEach(): LoopFrame | undefined {
    for (let i = this.run.loops.length - 1; i >= 0; i--)
      if (this.run.loops[i].kind === 'each') return this.run.loops[i];
    return undefined;
  }

  triggerRecord(): Rec | null {
    const t = this.plan.trigger;
    return t.table && t.sys_id ? this.env.load(t.table, t.sys_id) : null;
  }

  private cond(c: unknown): boolean {
    return evalCondition(c, this.env, () => this.triggerRecord());
  }

  // ------------------------------------------------------------- lifecycle

  /** For a waiting execution: true when its wait is over (outputs recorded, program counter advanced). */
  resume(): boolean {
    const w = this.run.wait;
    if (!w) return true;
    const now = nowGlide();
    let outputs: Record<string, unknown> | null = null;
    let failure: string | null = null;
    switch (w.kind) {
      case 'duration':
        if (w.until > now) return this.stillWaiting(w);
        outputs = { resumed_at: now };
        break;
      case 'condition': {
        const rec = this.env.load(w.table, w.sys_id);
        const met = !!w.satisfied || (!!rec && this.conditionMet(w, rec));
        if (met) outputs = { timed_out: false };
        else if (!rec || (w.timeout_at && w.timeout_at <= now)) outputs = { timed_out: true };
        else return this.stillWaiting(w);
        break;
      }
      case 'approval': {
        const st = this.engine.approvals()?.stepState(this.sys, w.approval_step) ?? 'cancelled';
        if (st === 'requested' || st === 'not requested') return this.stillWaiting(w);
        outputs = { approval_state: st === 'approved' || st === 'rejected' ? st : 'cancelled' };
        break;
      }
      case 'subflow': {
        const child = this.sys.get(CONTEXT_TABLE, w.context);
        const st = child?.str('state') ?? 'CANCELLED';
        if (st === 'QUEUED' || st === 'IN_PROGRESS' || st === 'WAITING') return this.stillWaiting(w);
        if (st === 'COMPLETE')
          outputs = {
            ...parseJson<RunState | null>(child!.str('attributes'), null)?.outputs,
            context: w.context,
          };
        else
          failure = `Subflow ${st === 'ERROR' ? 'failed' : 'was cancelled'}${child?.str('error_message') ? `: ${child.str('error_message')}` : ''}`;
        break;
      }
    }
    this.run.wait = null;
    if (failure) {
      this.run.pending_error = { step: w.step, message: failure };
      return true;
    }
    this.run.steps[w.step] = { ...(w.outputs ?? {}), ...outputs, status: SUCCESS };
    this.log({ step: w.step, state: 'resumed', message: 'Resumed', outputs });
    this.run.pc++;
    return true;
  }

  private stillWaiting(w: WaitInfo): false {
    // A wake-up that did not satisfy the wait must not keep the execution due.
    const due = w.kind === 'duration' ? w.until : w.kind === 'condition' ? (w.timeout_at ?? null) : null;
    if (this.c.str('resolvr_wake_at') !== (due ?? '')) this.engine.setWakeAt(this.c.sysId, due);
    return false;
  }

  private conditionMet(w: Extract<WaitInfo, { kind: 'condition' }>, rec: Rec): boolean {
    if (w.query !== undefined) return recordMatches(rec, w.query, this.env);
    return evalCondition(w.condition, this.env, () => rec);
  }

  /** Runs instructions until the flow ends, fails or waits. */
  execute(): void {
    this.save({
      state: 'IN_PROGRESS',
      resolvr_wait_on: null,
      resolvr_wake_at: null,
      resolvr_started: this.c.str('resolvr_started') || nowGlide(),
    });
    this.engine.enter({
      flow: this.c.str('flow'),
      record: this.plan.trigger.sys_id ?? '',
      context: this.c.sysId,
    });
    try {
      if (this.run.pending_error) {
        const pe = this.run.pending_error;
        this.run.pending_error = null;
        const res = this.fail(pe.step, pe.message, null);
        if (res && res !== 'wait') {
          this.finish(res.status, res.message);
          return;
        }
      }
      for (;;) {
        const prog = this.program;
        if (this.run.pc >= prog.length) {
          if (this.run.mode === 'error') this.finish('ERROR', this.errorSummary());
          else this.finish('COMPLETE');
          return;
        }
        if (++this.run.executed > MAX_INSTRUCTIONS) {
          this.finish('ERROR', `The execution exceeded ${MAX_INSTRUCTIONS} steps`);
          return;
        }
        const ins = prog[this.run.pc];
        let res: StepResult;
        try {
          res = this.exec(ins);
        } catch (e) {
          res = this.fail(stepOf(ins)?.id ?? '', errorText(e), ins);
        }
        if (res === 'wait') return;
        if (res) {
          this.finish(res.status, res.message);
          return;
        }
      }
    } finally {
      this.engine.leave();
    }
  }

  private errorSummary(): string {
    const e = this.run.error;
    return e ? `Step "${e.step}" failed: ${e.message}` : 'The flow failed';
  }

  private fail(stepId: string, message: string, ins: Instr | null): StepResult {
    const step = ins ? stepOf(ins) : this.engine.findStep(this.loaded, stepId);
    this.log({ step: stepId, type: step ? stepKind(step) : '', state: 'error', level: 'error', message });
    if (step?.when_error === 'continue') {
      this.run.steps[stepId] = { ...(this.run.steps[stepId] ?? {}), status: { code: 'error', message } };
      if (ins?.op === 'each') this.run.pc = ins.exit;
      else if (ins?.op === 'next' || ins?.op === 'until') {
        this.run.loops.pop();
        this.run.pc++;
      } else this.run.pc++;
      return undefined;
    }
    if (this.run.mode === 'main') {
      this.run.error = { step: stepId, code: 'error', message };
      if (this.loaded.program.handler.length) {
        this.run.mode = 'error';
        this.run.pc = 0;
        this.run.loops = [];
        this.log({ state: 'info', message: 'Running the error handler' });
        return undefined;
      }
      return { status: 'ERROR', message: this.errorSummary() };
    }
    return {
      status: 'ERROR',
      message: `${this.errorSummary()} (error handler step "${stepId}" failed: ${message})`,
    };
  }

  private finish(status: 'COMPLETE' | 'ERROR', message?: string): void {
    this.log({
      state: status === 'COMPLETE' ? 'complete' : 'error',
      level: status === 'ERROR' ? 'error' : 'info',
      message: message ?? 'Flow completed',
    });
    this.save({
      state: status,
      error_message: status === 'ERROR' ? (message ?? 'The flow failed').slice(0, 4000) : null,
      resolvr_wait_on: null,
      resolvr_wake_at: null,
      resolvr_ended: nowGlide(),
    });
    if (this.plan.parent) this.engine.wake(this.plan.parent.context);
  }

  private wait(info: WaitInfo, message: string, inputs?: unknown): 'wait' {
    this.run.wait = info;
    const waitOn =
      info.kind === 'condition'
        ? info.sys_id
        : info.kind === 'approval'
          ? `approval:${info.approval_step}`
          : info.kind === 'subflow'
            ? `context:${info.context}`
            : null;
    const wakeAt =
      info.kind === 'duration' ? info.until : info.kind === 'condition' ? (info.timeout_at ?? null) : null;
    this.log({ step: info.step, state: 'waiting', message, inputs });
    this.save({ state: 'WAITING', resolvr_wait_on: waitOn, resolvr_wake_at: wakeAt });
    return 'wait';
  }

  private save(values: Record<string, unknown>): void {
    const elapsed = performance.now() - this.startedAt;
    this.startedAt = performance.now();
    this.sys.derive({ workflow: false }).update(this.c, {
      ...values,
      attributes: JSON.stringify(this.run),
      run_time: (this.c.num('run_time') ?? 0) + Math.round(elapsed),
    });
  }

  log(e: {
    step?: string;
    type?: string;
    action?: string;
    label?: string;
    state: string;
    level?: string;
    message?: string;
    inputs?: unknown;
    outputs?: unknown;
    started?: string;
    duration?: number;
  }): void {
    this.run.seq++;
    const frame = this.innermostEach();
    this.sys.derive({ workflow: false }).insert(LOG_TABLE, {
      context: this.c.sysId,
      flow: this.c.str('flow') || null,
      sequence: this.run.seq,
      step_id: e.step ?? '',
      step_type: e.type ?? '',
      action: e.action ?? '',
      label: e.label ?? '',
      state: e.state,
      level: e.level ?? (e.state === 'error' ? 'error' : 'info'),
      message: (e.message ?? '').slice(0, 4000),
      inputs: jsonOf(e.inputs),
      outputs: jsonOf(e.outputs),
      started: e.started ?? nowGlide(),
      ended: nowGlide(),
      duration_ms: e.duration ?? 0,
      iteration: frame ? frame.index : null,
    });
  }

  // ------------------------------------------------------------ instructions

  private frame(stepId: string): LoopFrame {
    for (let i = this.run.loops.length - 1; i >= 0; i--)
      if (this.run.loops[i].step === stepId) return this.run.loops[i];
    throw new Error(`Loop state of "${stepId}" is missing`);
  }

  private exec(ins: Instr): StepResult {
    switch (ins.op) {
      case 'jump':
        this.run.pc = ins.target;
        return undefined;
      case 'if': {
        for (const b of ins.branches) {
          if (this.cond(b.condition)) {
            this.log({
              step: ins.step.id,
              type: 'if',
              label: ins.step.label,
              state: 'branch',
              message: `Took the ${b.label} branch`,
            });
            this.run.pc = b.target;
            return undefined;
          }
        }
        const hasElse = ins.elseTarget < ins.end;
        this.log({
          step: ins.step.id,
          type: 'if',
          label: ins.step.label,
          state: 'branch',
          message: hasElse ? 'Took the else branch' : 'No branch matched',
        });
        this.run.pc = ins.elseTarget;
        return undefined;
      }
      case 'each': {
        const id = ins.step.id;
        const items = toList(render(ins.step.items, this.env));
        if (items.length > this.maxIterations) {
          throw new Error(
            `For each received ${items.length} items; the limit is ${this.maxIterations} iterations`,
          );
        }
        this.run.steps[id] = { iterations: 0, count: items.length };
        this.log({
          step: id,
          type: 'for_each',
          label: ins.step.label,
          state: 'info',
          message: `Looping over ${items.length} item(s)`,
        });
        if (!items.length) {
          this.run.pc = ins.exit;
          return undefined;
        }
        this.run.loops.push({
          step: id,
          kind: 'each',
          items: serialize(items) as unknown[],
          index: 0,
          as: (ins.step.as as string) || 'item',
        });
        this.run.pc++;
        return undefined;
      }
      case 'next': {
        const f = this.frame(ins.step.id);
        f.index++;
        this.run.steps[ins.step.id] = { ...this.run.steps[ins.step.id], iterations: f.index };
        if (f.index < (f.items?.length ?? 0)) {
          this.run.pc = ins.body;
          return undefined;
        }
        this.run.loops.splice(this.run.loops.indexOf(f), 1);
        this.run.pc++;
        return undefined;
      }
      case 'until_start':
        this.run.loops.push({ step: ins.step.id, kind: 'until', index: 0 });
        this.run.steps[ins.step.id] = { iterations: 0 };
        this.run.pc++;
        return undefined;
      case 'until': {
        const f = this.frame(ins.step.id);
        f.index++;
        this.run.steps[ins.step.id] = { iterations: f.index };
        if (this.cond(ins.step.condition)) {
          this.run.loops.splice(this.run.loops.indexOf(f), 1);
          this.run.pc++;
          return undefined;
        }
        const max = Math.min(
          Number(ins.step.max_iterations ?? this.maxIterations) || this.maxIterations,
          this.maxIterations,
        );
        if (f.index >= max) throw new Error(`Do until reached its limit of ${max} iterations`);
        this.run.pc = ins.body;
        return undefined;
      }
      case 'step':
        return this.execStep(ins.step);
    }
  }

  private execStep(step: FlowStep): StepResult {
    switch (stepKind(step)) {
      case 'action':
        return this.execAction(step);
      case 'wait_duration':
        return this.execWaitDuration(step);
      case 'wait_condition':
        return this.execWaitCondition(step);
      case 'set_variables':
      case 'assign_outputs': {
        const args = stepArgs(step);
        const values = render(args.values ?? {}, this.env) as Record<string, unknown>;
        const target = stepKind(step) === 'set_variables' ? this.run.vars : this.run.outputs;
        for (const [k, v] of Object.entries(values ?? {})) target[k] = serialize(v);
        this.run.steps[step.id] = { status: SUCCESS };
        this.log({
          step: step.id,
          type: stepKind(step),
          label: step.label,
          state: 'complete',
          outputs: values,
        });
        this.run.pc++;
        return undefined;
      }
      case 'subflow':
        return this.execSubflow(step);
      case 'end': {
        const message = step.message === undefined ? undefined : String(render(step.message, this.env) ?? '');
        this.log({
          step: step.id,
          type: 'end',
          label: step.label,
          state: 'complete',
          message: message ?? `End (${step.status ?? 'complete'})`,
        });
        return step.status === 'error'
          ? { status: 'ERROR', message: message || `Ended with an error at step "${step.id}"` }
          : { status: 'COMPLETE', message: message || undefined };
      }
      default:
        throw new Error(`Unsupported step type "${step.type}"`);
    }
  }

  private runtime(step: FlowStep): ActionRuntime {
    return {
      platform: this.engine.platform,
      ctx: this.runCtx,
      sys: this.sys,
      env: this.env,
      context: this.c,
      flowName: this.flow?.str('internal_name') || this.c.str('name'),
      stepId: step.id,
      trigger: () => this.triggerRecord(),
      vars: this.run.vars,
      trustedScripts: this.engine.trustedScripts(this.flow),
      log: (level, message) => this.log({ step: step.id, type: 'log', state: 'info', level, message }),
    };
  }

  private execAction(step: FlowStep): StepResult {
    const name = actionName(step);
    const impl = this.engine.action(name);
    if (!impl) throw new Error(`Unknown action "${name}"`);
    const inputs = (render(step.inputs ?? {}, this.env) ?? {}) as Record<string, unknown>;
    const started = nowGlide();
    const t0 = performance.now();
    const outcome: ActionOutcome = this.engine.platform.db.tx(() => impl(inputs, this.runtime(step))) ?? {};
    const outputs = (serialize(outcome.outputs ?? {}) ?? {}) as Record<string, unknown>;
    const w = outcome.wait;
    if (w?.kind === 'approval') {
      return this.wait(
        { kind: 'approval', step: step.id, approval_step: w.approval_step, outputs },
        'Waiting for the approval decision',
        inputs,
      );
    }
    if (w?.kind === 'condition') {
      const rec = this.env.load(w.table, w.sys_id);
      if (!rec || !recordMatches(rec, w.query, this.env)) {
        return this.wait(
          {
            kind: 'condition',
            step: step.id,
            table: w.table,
            sys_id: w.sys_id,
            query: w.query,
            timeout_at: w.timeout_at ?? null,
            outputs,
          },
          `Waiting for ${rec?.displayValue() || 'the record'} to match ${w.query}`,
          inputs,
        );
      }
    }
    this.run.steps[step.id] = { ...outputs, status: SUCCESS };
    this.log({
      step: step.id,
      type: 'action',
      action: name,
      label: step.label,
      state: 'complete',
      inputs,
      outputs,
      started,
      duration: Math.round(performance.now() - t0),
    });
    this.run.pc++;
    return undefined;
  }

  private addDuration(start: string, ms: number, scheduleId: string): string {
    const schedules = scheduleId
      ? optionalService<ScheduleService>(this.engine.platform, SERVICES.schedules)
      : undefined;
    return schedules ? schedules.addBusinessMs(this.sys, scheduleId, start, ms) : addMs(start, ms);
  }

  private execWaitDuration(step: FlowStep): StepResult {
    const args = stepArgs(step);
    const now = nowGlide();
    let until = args.until !== undefined ? normalizeDateTime(render(args.until, this.env)) : null;
    if (!until) {
      const ms = durationMs(render(args.duration, this.env));
      if (ms === null || ms < 0)
        throw new Error('The wait needs a valid duration (ISO-8601, e.g. PT1H) or an until date-time');
      until = this.addDuration(now, ms, String(render(args.schedule ?? '', this.env) ?? ''));
    }
    if (until <= now) {
      this.run.steps[step.id] = { resumed_at: now, status: SUCCESS };
      this.log({
        step: step.id,
        type: 'wait_duration',
        label: step.label,
        state: 'complete',
        message: 'Nothing to wait for',
      });
      this.run.pc++;
      return undefined;
    }
    return this.wait({ kind: 'duration', step: step.id, until }, `Waiting until ${until}`);
  }

  private execWaitCondition(step: FlowStep): StepResult {
    const args = stepArgs(step);
    const rec =
      args.record !== undefined
        ? toRec(render(args.record, this.env), this.env, typeof args.table === 'string' ? args.table : null)
        : this.triggerRecord();
    if (!rec) throw new Error('The wait has no record to watch');
    const condition = args.condition;
    const query = typeof condition === 'string' && !condition.includes('{{') ? condition : undefined;
    const met =
      query !== undefined
        ? recordMatches(rec, query, this.env)
        : evalCondition(condition, this.env, () => rec);
    if (met) {
      this.run.steps[step.id] = { timed_out: false, record: refOf(rec), status: SUCCESS };
      this.log({
        step: step.id,
        type: 'wait_condition',
        label: step.label,
        state: 'complete',
        message: 'Condition already met',
      });
      this.run.pc++;
      return undefined;
    }
    const timeoutMs = args.timeout !== undefined ? durationMs(render(args.timeout, this.env)) : null;
    return this.wait(
      {
        kind: 'condition',
        step: step.id,
        table: rec.className,
        sys_id: rec.sysId,
        query,
        condition: query === undefined ? condition : undefined,
        timeout_at: timeoutMs !== null ? addMs(nowGlide(), timeoutMs) : null,
        outputs: { record: refOf(rec) },
      },
      `Waiting for ${rec.displayValue() || rec.table.label} to match ${query ?? 'the condition'}`,
    );
  }

  private execSubflow(step: FlowStep): StepResult {
    const depth = (this.plan.depth ?? 0) + 1;
    if (depth > 4) throw new Error('Subflows are nested too deeply (limit 4)');
    const sub = this.engine.findFlow(this.sys, String(step.subflow ?? ''));
    if (!sub) throw new Error(`Unknown subflow "${String(step.subflow)}"`);
    if (sub.sysId === this.flow?.sysId && depth > 3)
      throw new Error('A flow may not call itself more than three times');
    const inputs = serialize(render(step.inputs ?? {}, this.env)) as Record<string, unknown>;
    const child = this.engine.createContext(this.sys, sub, {
      record: this.triggerRecord(),
      operation: 'subflow',
      user: this.plan.trigger.user,
      inputs,
      source: 'subflow',
      parent: { context: this.c.sysId, step: step.id },
      depth,
    });
    this.engine.runContext(child.sysId);
    const fresh = this.sys.get(CONTEXT_TABLE, child.sysId) ?? child;
    const state = fresh.str('state');
    if (step.wait === false) {
      this.run.steps[step.id] = { context: child.sysId, status: SUCCESS };
      this.log({
        step: step.id,
        type: 'subflow',
        label: step.label,
        state: 'complete',
        message: `Started subflow ${sub.str('name')}`,
      });
      this.run.pc++;
      return undefined;
    }
    if (state === 'COMPLETE') {
      const outputs = parseJson<RunState | null>(fresh.str('attributes'), null)?.outputs ?? {};
      this.run.steps[step.id] = { ...outputs, context: child.sysId, status: SUCCESS };
      this.log({ step: step.id, type: 'subflow', label: step.label, state: 'complete', outputs });
      this.run.pc++;
      return undefined;
    }
    if (state === 'ERROR' || state === 'CANCELLED')
      throw new Error(`Subflow ${sub.str('name')} failed: ${fresh.str('error_message')}`);
    return this.wait(
      { kind: 'subflow', step: step.id, context: child.sysId, outputs: { context: child.sysId } },
      `Waiting for subflow ${sub.str('name')}`,
    );
  }
}
