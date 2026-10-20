import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { CLOSE_CODE, INC_STATE, PROP } from './constants.js';
import { isAgent, isCaller, isMajorIncident, isOpener, propBool, propList } from './util.js';

/** Who may use the self-service style actions on an incident. */
export function canResolve(rec: Rec, ctx: Context): boolean {
  if (![INC_STATE.NEW, INC_STATE.IN_PROGRESS, INC_STATE.ON_HOLD].includes(rec.str('state') as '1'))
    return false;
  if (isAgent(ctx)) return true;
  return !isMajorIncident(rec) && (isCaller(rec, ctx) || isOpener(rec, ctx));
}

export function canReopen(rec: Rec, ctx: Context): boolean {
  if (rec.str('state') !== INC_STATE.RESOLVED) return false;
  if (isAgent(ctx)) return true;
  return !isMajorIncident(rec) && (isCaller(rec, ctx) || isOpener(rec, ctx));
}

/** Close Incident: caller, itil_admin or admin; major incidents need a major incident manager. */
export function canClose(rec: Rec, ctx: Context): boolean {
  if (rec.str('state') !== INC_STATE.RESOLVED) return false;
  if (isMajorIncident(rec)) return ctx.hasRole('major_incident_manager');
  return ctx.hasRole('itil_admin') || isCaller(rec, ctx);
}

export interface ResolveInput {
  close_code?: string;
  close_notes?: string;
  comments?: string;
}

export function resolveIncident(ctx: Context, inc: Rec, input: ResolveInput): Rec {
  const values: Record<string, unknown> = {
    state: INC_STATE.RESOLVED,
    close_code: input.close_code ?? inc.str('close_code'),
    close_notes: input.close_notes ?? inc.str('close_notes'),
  };
  if (!isAgent(ctx) && isCaller(inc, ctx)) {
    values.close_code ||= CLOSE_CODE.RESOLVED_BY_CALLER;
    values.close_notes ||= 'Resolved by caller';
  }
  if (input.comments) values.comments = input.comments;
  return ctx.update(inc, values);
}

export function reopenIncident(ctx: Context, inc: Rec, input: { comments?: string } = {}): Rec {
  if (inc.str('state') !== INC_STATE.RESOLVED)
    throw new AbortError('Only resolved incidents can be reopened');
  const values: Record<string, unknown> = { state: INC_STATE.IN_PROGRESS };
  if (input.comments) values.comments = input.comments;
  return ctx.update(inc, values);
}

export function closeIncident(ctx: Context, inc: Rec, input: { comments?: string } = {}): Rec {
  if (inc.str('state') !== INC_STATE.RESOLVED) throw new AbortError('Only resolved incidents can be closed');
  const values: Record<string, unknown> = { state: INC_STATE.CLOSED };
  if (input.comments) values.comments = input.comments;
  return ctx.update(inc, values);
}

/** Fields that are never carried into a copy, whatever the property says. */
const NEVER_COPIED = new Set([
  'close_code',
  'close_notes',
  'resolved_by',
  'resolved_at',
  'knowledge',
  'number',
  'state',
]);
const DROP_WHEN_TARGET_INACTIVE = ['problem_id', 'rfc', 'parent_incident'];

/** Copy Incident / Create Child Incident: saves the copy and returns it. */
export function copyIncident(ctx: Context, source: Rec, opts: { child?: boolean } = {}): Rec {
  const enabled = opts.child ? propBool(ctx, PROP.childEnable, true) : propBool(ctx, PROP.copyEnable, true);
  if (!enabled)
    throw new AbortError(opts.child ? 'Create Child Incident is disabled' : 'Copy Incident is disabled');
  if (!isAgent(ctx) && !isOpener(source, ctx))
    throw new AccessError('Insufficient rights to copy this incident');
  if (opts.child && [INC_STATE.CLOSED, INC_STATE.CANCELED].includes(source.str('state') as '7')) {
    throw new AbortError('Child incidents cannot be created for closed or canceled incidents');
  }
  const values: Record<string, unknown> = {};
  for (const f of propList(ctx, PROP.copyAttributes)) {
    if (NEVER_COPIED.has(f) || !source.has(f) || !source.str(f)) continue;
    if (DROP_WHEN_TARGET_INACTIVE.includes(f) && !source.ref(f)?.bool('active')) continue;
    values[f] = source.get(f);
  }
  if (opts.child) values.parent_incident = source.sysId;
  const marker = `Created from a similar incident: ${source.str('number')}`;
  // Self-service users cannot write work notes, so the system records the marker for them.
  if (isAgent(ctx)) values.work_notes = marker;
  const copy = ctx.insert('incident', values);
  if (!isAgent(ctx)) ctx.asSystem().update(copy, { work_notes: marker });
  copyRelatedLists(ctx, source, copy);
  return copy;
}

/** Copies Affected CIs (task_ci) when the CMDB module provides the table. */
function copyRelatedLists(ctx: Context, source: Rec, copy: Rec): void {
  const lists = propList(ctx, PROP.copyRelatedLists);
  const sys = ctx.elevated();
  if (!lists.includes('task_ci') || !sys.registry.has('task_ci')) return;
  const columns = propList(ctx, PROP.copyTaskCiAttributes);
  for (const row of sys.query('task_ci', { query: `task=${source.sysId}` })) {
    const values: Record<string, unknown> = { task: copy.sysId };
    for (const c of columns) if (row.has(c)) values[c] = row.get(c);
    const ci = values.ci_item as string | undefined;
    if (ci && sys.count('task_ci', `task=${copy.sysId}^ci_item=${ci}`) > 0) continue;
    sys.insert('task_ci', values);
  }
}
