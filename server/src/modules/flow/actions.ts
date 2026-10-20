/**
 * Built-in flow actions. Each action receives its resolved inputs (pills already
 * replaced) and returns outputs, or asks the runtime to wait (approvals, task
 * completion). Writes go through the execution's run-as context so ACLs apply to
 * flows that run as the user.
 */
import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import type { OrderSpec } from '../../engine/query/parser.js';
import { Rec } from '../../engine/record.js';
import { addMs, normalizeDateTime, nowGlide } from '../../engine/util.js';
import type { ApprovalEngine } from '../approvals/engine.js';
import { type NotificationService, optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { type EvalEnv, isRef, refOf, sysIdOf, toRec } from './expr.js';
import { durationMs } from './schedule.js';

export type WaitRequest =
  | { kind: 'condition'; table: string; sys_id: string; query: string; timeout_at?: string | null }
  | { kind: 'approval'; approval_step: string };

export interface ActionOutcome {
  outputs?: Record<string, unknown>;
  wait?: WaitRequest;
}

export interface ActionRuntime {
  platform: Platform;
  /** Run-as context (system, or the triggering user with run_with_roles). */
  ctx: Context;
  /** System context for reads that must not depend on the run-as user. */
  sys: Context;
  env: EvalEnv;
  /** sys_flow_context record of the execution. */
  context: Rec;
  flowName: string;
  stepId: string;
  /** Triggering record, re-read from the database (null for scheduled/API runs without a record). */
  trigger(): Rec | null;
  vars: Record<string, unknown>;
  /** Scripts are only allowed in flows last edited by an administrator. */
  trustedScripts: boolean;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export type ActionImpl = (inputs: Record<string, unknown>, rt: ActionRuntime) => ActionOutcome;

const MAX_LOOKUP = 10_000;

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Rec) return v.sysId;
  if (isRef(v)) return v.$sys_id;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Field values for inserts/updates: records become sys_ids, lists become comma lists. */
function plainValues(values: unknown): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    if (v instanceof Rec || isRef(v)) out[k] = sysIdOf(v);
    else if (Array.isArray(v))
      out[k] = v.map((x) => (x instanceof Rec || isRef(x) ? sysIdOf(x) : str(x))).join(',');
    else out[k] = v;
  }
  return out;
}

function tableArg(inputs: Record<string, unknown>, rt: ActionRuntime, fallback?: string): string {
  const table = str(inputs.table) || fallback || '';
  if (!table) throw new InvalidError('A table is required');
  if (!rt.platform.registry.has(table)) throw new InvalidError(`Unknown table ${table}`);
  return table;
}

/** Record input read with the run-as context (ACLs apply); fails when missing or not readable. */
function recordArg(
  inputs: Record<string, unknown>,
  rt: ActionRuntime,
  key = 'record',
  required = true,
): Rec | null {
  const raw = inputs[key];
  const hint = typeof inputs.table === 'string' ? inputs.table : null;
  let rec = raw === undefined || raw === null || raw === '' ? null : toRec(raw, rt.env, hint);
  if (!rec && (raw === undefined || raw === null || raw === '') && key === 'record') rec = rt.trigger();
  if (!rec) {
    if (required)
      throw new NotFoundError('Record not found', `The ${key} input does not point to an existing record`);
    return null;
  }
  const visible = rt.ctx.get(rec.className, rec.sysId);
  if (!visible)
    throw new NotFoundError('Record not found', `The ${key} input does not point to a readable record`);
  return visible;
}

function orderSpec(v: unknown): OrderSpec[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : String(v).split(',');
  return list
    .map((x) => String(x).trim())
    .filter(Boolean)
    .map((f) => {
      if (f.startsWith('ORDERBYDESC')) return { field: f.slice(11), desc: true };
      if (f.startsWith('ORDERBY')) return { field: f.slice(7), desc: false };
      if (f.startsWith('-')) return { field: f.slice(1), desc: true };
      return { field: f, desc: false };
    });
}

function recipients(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : String(v).split(',');
  return [
    ...new Set(
      list
        .map((x) => sysIdOf(x) || str(x))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Due input of an approval: ISO duration from now, or a date-time. */
function dueDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^P/i.test(s)) {
    const ms = durationMs(s);
    return ms === null ? null : addMs(nowGlide(), ms);
  }
  return normalizeDateTime(s);
}

function ruleSpec(v: unknown): { type?: string; percentage?: number | null } {
  if (!v) return {};
  if (typeof v === 'string') return { type: v };
  const o = v as Record<string, unknown>;
  const pct =
    o.percentage === undefined || o.percentage === null || o.percentage === '' ? null : Number(o.percentage);
  return {
    type: o.type === undefined ? undefined : String(o.type),
    percentage: Number.isFinite(pct) ? pct : null,
  };
}

function createRecord(inputs: Record<string, unknown>, rt: ActionRuntime, defaultTable?: string): Rec {
  const table = tableArg(inputs, rt, defaultTable);
  return rt.ctx.insert(table, plainValues(inputs.values ?? inputs.fields ?? {}));
}

function journalAction(field: 'comments' | 'work_notes'): ActionImpl {
  return (inputs, rt) => {
    const rec = recordArg(inputs, rt)!;
    const text = str(inputs.text ?? inputs.comment ?? inputs.work_note ?? inputs.message);
    if (!text.trim()) throw new InvalidError('A text is required');
    if (!rec.column(field)) throw new InvalidError(`${rec.table.label} has no ${field} field`);
    rt.ctx.update(rec, { [field]: text });
    return { outputs: { record: refOf(rec) } };
  };
}

export const BUILTIN_ACTIONS: Record<string, ActionImpl> = {
  create_record(inputs, rt) {
    return { outputs: { record: refOf(createRecord(inputs, rt)) } };
  },

  create_task(inputs, rt) {
    const table = str(inputs.table) || 'task';
    if (!rt.platform.registry.isA(table, 'task')) throw new InvalidError(`${table} is not a task table`);
    const rec = createRecord({ ...inputs, table }, rt);
    const outputs = { record: refOf(rec) };
    if (inputs.wait_for_completion === true || inputs.wait_for_completion === 'true') {
      return {
        outputs,
        wait: { kind: 'condition', table: rec.className, sys_id: rec.sysId, query: 'active=false' },
      };
    }
    return { outputs };
  },

  update_record(inputs, rt) {
    const rec = recordArg(inputs, rt)!;
    rt.ctx.update(rec, plainValues(inputs.values ?? inputs.fields ?? {}));
    return { outputs: { record: refOf(rec) } };
  },

  delete_record(inputs, rt) {
    const rec = recordArg(inputs, rt)!;
    rt.ctx.delete(rec);
    return { outputs: {} };
  },

  look_up_record(inputs, rt) {
    const table = tableArg(inputs, rt);
    const rec =
      rt.ctx.query(table, { query: str(inputs.query), orderBy: orderSpec(inputs.order_by), limit: 1 })[0] ??
      null;
    return { outputs: { record: rec ? refOf(rec) : null, found: !!rec } };
  },

  look_up_records(inputs, rt) {
    const table = tableArg(inputs, rt);
    const limit = Math.min(Math.max(Number(inputs.limit ?? 1000) || 1000, 1), MAX_LOOKUP);
    const recs = rt.ctx.query(table, {
      query: str(inputs.query),
      orderBy: orderSpec(inputs.order_by),
      limit,
    });
    return { outputs: { records: recs.map(refOf), count: recs.length } };
  },

  ask_for_approval(inputs, rt) {
    const engine = optionalService<ApprovalEngine>(rt.platform, SERVICES.approvals);
    if (!engine) throw new InvalidError('The approvals module is not installed');
    const target = recordArg(inputs, rt)!;
    const approvers = inputs.approvers;
    const spec: Record<string, unknown> = Array.isArray(approvers)
      ? { users: approvers }
      : ((approvers ?? {}) as Record<string, unknown>);
    const users = (Array.isArray(spec.users) ? spec.users : spec.users ? [spec.users] : [])
      .flat()
      .map(sysIdOf)
      .filter(Boolean);
    for (const f of Array.isArray(spec.fields) ? spec.fields : []) {
      const v = target.get(String(f));
      if (v) users.push(String(v));
    }
    const groups = (Array.isArray(spec.groups) ? spec.groups : spec.groups ? [spec.groups] : [])
      .flat()
      .map(sysIdOf)
      .filter(Boolean);
    const rule = ruleSpec(inputs.rule);
    const groupRule = ruleSpec(inputs.group_rule);
    const res = engine.requestStep(rt.ctx.elevated(), target, {
      users,
      groups,
      rule: rule.type ?? 'any',
      percentage: rule.percentage ?? null,
      groupRule: groupRule.type ?? 'first_response',
      groupPercentage: groupRule.percentage ?? null,
      stage: str(inputs.label ?? inputs.stage) || undefined,
      due: dueDate(inputs.due),
      onDue: inputs.on_due ? str(inputs.on_due) : null,
      source: 'flow',
      flowContext: rt.context.sysId,
      approvalField: str(inputs.approval_field) || undefined,
      journalField: str(inputs.journal_field) || undefined,
    });
    const outputs = { approvals: res.approvals.map(refOf), approval_step: res.step.sysId };
    if (res.state === 'requested' || res.state === 'not requested')
      return { outputs, wait: { kind: 'approval', approval_step: res.step.sysId } };
    return {
      outputs: {
        ...outputs,
        approval_state: res.state === 'approved' || res.state === 'rejected' ? res.state : 'cancelled',
      },
    };
  },

  send_notification(inputs, rt) {
    const record = inputs.record === undefined ? rt.trigger() : recordArg(inputs, rt, 'record', false);
    const to = recipients(inputs.to ?? inputs.recipients);
    const cc = recipients(inputs.cc);
    const subject = str(inputs.subject);
    const body = str(inputs.body ?? inputs.message);
    const notification = str(inputs.notification);
    const svc = optionalService<NotificationService>(rt.platform, SERVICES.notifications);
    if (svc && to.length && (subject || body)) {
      const email = svc.send(rt.sys, {
        to,
        cc,
        subject,
        body,
        target: record,
        notification: notification || undefined,
      });
      return { outputs: { email: email ? refOf(email) : null, sent: !!email } };
    }
    // No notifications module (or a notification referenced by name only): raise an event instead.
    const event = str(inputs.event) || 'flow.notification';
    rt.sys.queueEvent(event, record, to.join(',') || notification, subject || notification);
    return { outputs: { event, sent: false } };
  },

  send_email(inputs, rt) {
    return BUILTIN_ACTIONS.send_notification(inputs, rt);
  },

  fire_event(inputs, rt) {
    const name = str(inputs.name ?? inputs.event);
    if (!name) throw new InvalidError('An event name is required');
    const record = inputs.record === undefined ? rt.trigger() : recordArg(inputs, rt, 'record', false);
    rt.sys.queueEvent(name, record, str(inputs.parm1) || null, str(inputs.parm2) || null);
    return { outputs: {} };
  },

  log(inputs, rt) {
    const level = (['info', 'warn', 'error'].includes(str(inputs.level)) ? str(inputs.level) : 'info') as
      | 'info'
      | 'warn'
      | 'error';
    const message = str(inputs.message);
    rt.log(level, message);
    if (rt.platform.registry.has('syslog')) {
      rt.sys.derive({ workflow: false }).insert('syslog', {
        level,
        source: `flow:${rt.flowName}`.slice(0, 100),
        message: message.slice(0, 4000),
      });
    }
    return { outputs: { message } };
  },

  add_comment: journalAction('comments'),
  add_work_note: journalAction('work_notes'),

  run_script(inputs, rt) {
    if (!rt.trustedScripts)
      throw new InvalidError('Scripts are only allowed in flows last edited by an administrator');
    const svc = optionalService<ScriptService>(rt.platform, SERVICES.scripts);
    if (!svc) throw new InvalidError('The scripts module is not installed');
    const current = inputs.record === undefined ? rt.trigger() : recordArg(inputs, rt, 'record', false);
    const result = svc.run(rt.ctx, str(inputs.script), { current, vars: rt.vars });
    return { outputs: { result: result instanceof Rec ? refOf(result) : (result as unknown) } };
  },
};
