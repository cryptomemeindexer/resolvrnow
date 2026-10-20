/**
 * Service contracts shared between modules. A module that provides a service
 * registers an implementation under the given name in `platform.services`; other
 * modules look it up with `optionalService()` so they keep working when the
 * provider is not installed (e.g. in unit tests that boot a subset of modules).
 */
import type { Context } from '../engine/context.js';
import type { Platform } from '../engine/platform.js';
import type { Rec } from '../engine/record.js';

export const SERVICES = {
  approvals: 'approvals',
  notifications: 'notifications',
  sla: 'sla',
  schedules: 'schedules',
  cmdb: 'cmdb',
  flows: 'flows',
  catalog: 'catalog',
  knowledge: 'knowledge',
  oncall: 'oncall',
  scripts: 'scripts',
  ai: 'ai',
  analytics: 'analytics',
  tasks: 'tasks',
} as const;

export function optionalService<T>(platform: Platform, name: string): T | undefined {
  return platform.services.get(name) as T | undefined;
}

// ------------------------------------------------------------------ approvals

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalRule = 'any' | 'all' | 'first';

export interface ApprovalRequest {
  /** Individual approvers (sys_user sys_ids). */
  users?: string[];
  /** Group approvals: every active member of each group becomes an approver. */
  groups?: string[];
  /** How individual decisions combine (default 'any' for users, per group for groups). */
  rule?: ApprovalRule;
  /** Free-text label shown to approvers, e.g. "Technical approval". */
  stage?: string;
  /** Due date for the approval (glide date-time). */
  due?: string;
}

export interface ApprovalService {
  /** Creates approval records for `target` and sets target.approval = 'requested'. */
  request(ctx: Context, target: Rec, req: ApprovalRequest): Rec[];
  /** Approver decision on an approval (sysapproval_approver) record. */
  decide(ctx: Context, approval: Rec, decision: ApprovalDecision, comments?: string): void;
  /** Cancels outstanding approvals for a target (e.g. when the record is canceled). */
  cancel(ctx: Context, target: Rec, reason?: string): void;
  /** Current aggregate state for a target: not requested, requested, approved, rejected, cancelled. */
  stateOf(ctx: Context, target: Rec): string;
  /** Called once the overall approval for a target is decided. */
  onDecision(table: string, handler: (target: Rec, decision: ApprovalDecision, ctx: Context) => void): void;
}

// ------------------------------------------------------------- notifications

export interface OutboundEmail {
  /** Recipients: sys_user sys_ids, sys_user_group sys_ids, or email addresses. */
  to: string[];
  cc?: string[];
  subject: string;
  /** HTML body. */
  body: string;
  /** Record the email is about (activity stream, reply threading). */
  target?: Rec | null;
  /** Notification definition that produced it, if any. */
  notification?: string;
}

export interface NotificationService {
  /** Queues an email (sys_email) and delivers it through the configured transport. */
  send(ctx: Context, email: OutboundEmail): Rec | null;
  /** Expands `${field}` / `${field.dotwalk}` / `${URI_REF}` style templates against a record. */
  render(ctx: Context, template: string, rec: Rec | null, extra?: Record<string, string>): string;
}

// ---------------------------------------------------------------- schedules

export interface ScheduleService {
  /** Business milliseconds between two instants under a schedule (null schedule = 24x7). */
  businessMs(ctx: Context, scheduleId: string | null, start: string, end: string, timeZone?: string | null): number;
  /** Instant reached after adding `ms` of business time to `start`. */
  addBusinessMs(ctx: Context, scheduleId: string | null, start: string, ms: number, timeZone?: string | null): string;
  /** Whether the instant falls inside the schedule. */
  isInSchedule(ctx: Context, scheduleId: string | null, at: string, timeZone?: string | null): boolean;
}

// ---------------------------------------------------------------------- cmdb

export interface CmdbService {
  /** CIs that depend on `ciId` (walking "used by" relationships upwards), including services. */
  upstream(ctx: Context, ciId: string, depth?: number): Rec[];
  /** CIs that `ciId` depends on. */
  downstream(ctx: Context, ciId: string, depth?: number): Rec[];
  /** Business/application services impacted by a CI. */
  impactedServices(ctx: Context, ciId: string): Rec[];
  /** Links a CI to a task as an affected CI (task_ci). */
  addAffectedCi(ctx: Context, task: Rec, ciId: string): void;
}

// --------------------------------------------------------------------- flows

export interface FlowService {
  /** Starts a flow by its name or sys_id for a record; returns the flow context record. */
  start(ctx: Context, flow: string, record: Rec | null, inputs?: Record<string, unknown>): Rec | null;
  /** Registers a custom action type usable from flow definitions. */
  registerAction(type: string, run: (ctx: Context, inputs: Record<string, unknown>, record: Rec | null) => Record<string, unknown> | void): void;
}

// ------------------------------------------------------------------- scripts

export interface ScriptService {
  /** Runs a script in the sandbox with `current`/`previous` bound to records; returns the script's result. */
  run(ctx: Context, script: string, bindings?: { current?: Rec | null; previous?: Rec | null; vars?: Record<string, unknown> }): unknown;
  /** Evaluates a condition script (truthy result). */
  condition(ctx: Context, script: string, current: Rec | null, previous?: Rec | null): boolean;
}

// ----------------------------------------------------------------------- sla

export interface SlaService {
  /** Re-evaluates SLA definitions for a task (normally automatic after insert/update). */
  process(ctx: Context, task: Rec, previous: Rec | null): void;
  /** Recomputes timing for all active task SLAs (timer job). */
  updateTimers(ctx: Context): number;
}

// ----------------------------------------------------------------------- ai

export interface AiCompletion {
  text: string;
  provider: string;
  model: string;
}

export interface AiService {
  /** True when an LLM provider is configured; otherwise skills use deterministic fallbacks. */
  llmAvailable(): boolean;
  complete(system: string, prompt: string, opts?: { maxTokens?: number }): Promise<AiCompletion>;
}
