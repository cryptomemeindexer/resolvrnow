import type { Context } from '../../engine/context.js';
import { AbortError, InvalidError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { taskStates } from '../task/index.js';
import { PROPS, T, UR_CLOSED_STATES, UR_REASON, UR_STATE } from './constants.js';
import { firstLine, hasColumn, hasTable, q, requesterField } from './util.js';

const DAY = 86_400_000;

// ------------------------------------------------------------------ comment synchronisation guard

let syncDepth = 0;

/** Runs `fn` with comment synchronisation suspended so copies do not bounce back. */
function quietSync<R>(fn: () => R): R {
  syncDepth++;
  try {
    return fn();
  } finally {
    syncDepth--;
  }
}

// ------------------------------------------------------------------ lookups

/** The primary ticket of a universal request (any task class), without ACL checks. */
export function primaryOf(ctx: Context, ur: Rec): Rec | null {
  const id = ur.has('primary_task') ? ur.str('primary_task') : '';
  return id ? ctx.elevated().get('task', id) : null;
}

/** The universal request a ticket belongs to, without ACL checks. */
export function universalRequestOf(ctx: Context, rec: Rec): Rec | null {
  if (rec.table.ancestors.includes(T.ur)) return rec;
  const id = rec.has('universal_request') ? rec.str('universal_request') : '';
  return id && hasTable(ctx, T.ur) ? ctx.elevated().get(T.ur, id) : null;
}

export function isUniversalRequest(rec: Rec): boolean {
  return rec.table.ancestors.includes(T.ur);
}

export interface Routing {
  service: Rec;
  department: Rec | null;
  table: string;
  group: string | null;
}

/** Routing of a topic: its own UR service, else the closest ancestor topic's service. */
export function routingFor(ctx: Context, topic: Rec | null): Routing | null {
  const sys = ctx.elevated();
  const seen = new Set<string>();
  let cur = topic;
  while (cur && !seen.has(cur.sysId)) {
    seen.add(cur.sysId);
    const serviceId = cur.str('resolvr_ur_service');
    const service = serviceId ? sys.get(T.urService, serviceId) : null;
    if (service?.bool('active')) {
      const department = service.str('department')
        ? sys.get(T.urDepartment, service.str('department'))
        : null;
      return {
        service,
        department,
        table: service.str('table_name'),
        group: service.str('assignment_group') || department?.str('assignment_group') || null,
      };
    }
    cur = cur.str('parent_topic') ? sys.get(T.topic, cur.str('parent_topic')) : null;
  }
  return null;
}

// ------------------------------------------------------------------ state mapping

export interface MappedState {
  state: string;
  reason: string;
}

/** UR state for the current state of its primary ticket (mapping table, then a closed/open fallback). */
export function mapPrimaryState(ctx: Context, primary: Rec): MappedState {
  const state = primary.str('state');
  // A requested item that was cancelled or rejected cancels the request, whatever its closed state.
  if (primary.has('stage') && primary.str('stage') === 'Request Cancelled')
    return { state: UR_STATE.CANCELED, reason: '' };
  const sys = ctx.elevated();
  for (const table of primary.table.ancestors) {
    const row = sys.first(T.urMapping, `active=true^primary_table=${q(table)}^primary_state=${q(state)}`);
    if (row) return { state: row.str('ur_state'), reason: row.str('ur_state_reason') };
  }
  const closed =
    (primary.has('active') && !primary.bool('active')) ||
    taskStates(ctx.platform).isClosedState(primary.className, state);
  return { state: closed ? UR_STATE.CLOSED : UR_STATE.IN_PROGRESS, reason: '' };
}

/** Field changes that align a UR with its primary ticket (empty when already aligned). */
function valuesFromPrimary(ctx: Context, ur: Rec, primary: Rec): Record<string, unknown> {
  let { state, reason } = mapPrimaryState(ctx, primary);
  const values: Record<string, unknown> = {};
  let review = false;
  if (state === UR_STATE.CLOSED && ur.bool('needs_resolution_review')) {
    // The requester confirms the outcome first; the UR closes on confirmation or after the delay.
    review = true;
    state = UR_STATE.AWAITING;
    reason = UR_REASON.CONFIRM;
    if (!ur.str('confirm_due') || ur.str('state') !== UR_STATE.AWAITING) {
      const days = ctx.platform.properties.getNumber(PROPS.confirmDays, 5);
      values.confirm_due = addMs(nowGlide(), Math.max(0, days) * DAY);
    }
  }
  if (!review && ur.str('confirm_due')) values.confirm_due = null;
  // A closed or cancelled request keeps its outcome while the primary ticket stays closed.
  if (UR_CLOSED_STATES.includes(ur.str('state')) && UR_CLOSED_STATES.includes(state)) return values;
  if (ur.str('state') !== state) values.state = state;
  if (ur.str('state_reason') !== reason) values.state_reason = reason;
  return values;
}

/** Moves the UR to the state mapped from its primary ticket. */
export function syncUrFromPrimary(ctx: Context, ur: Rec, primary: Rec): void {
  const values = valuesFromPrimary(ctx, ur, primary);
  if (Object.keys(values).length) ctx.elevated().update(ur, values);
}

/** Makes `primary` the primary ticket of `ur` and aligns the UR state with it. */
export function linkPrimary(ctx: Context, ur: Rec, primary: Rec): void {
  const values = valuesFromPrimary(ctx, ur, primary);
  if (ur.str('primary_task') !== primary.sysId) values.primary_task = primary.sysId;
  if (Object.keys(values).length) ctx.elevated().update(ur, values);
}

// ------------------------------------------------------------------ creation and routing

export interface NewUniversalRequest {
  description: string;
  short_description?: string | null;
  topic?: string | null;
  opened_for?: string | null;
  contact_type?: string | null;
}

/** Creates a UR (portal submission) and routes it when its topic maps to an installed table. */
export function createUniversalRequest(
  ctx: Context,
  input: NewUniversalRequest,
): { ur: Rec; primary: Rec | null } {
  const description = String(input.description ?? '').trim();
  if (!description) throw new InvalidError('Describe your issue or request', 'description is required');
  const sys = ctx.elevated();
  let topic: Rec | null = null;
  if (input.topic) {
    topic = sys.get(T.topic, input.topic);
    if (!topic?.bool('active')) throw new InvalidError('Unknown topic', `No active topic ${input.topic}`);
  }
  const routing = routingFor(ctx, topic);
  const ur = sys.insert(T.ur, {
    short_description: String(input.short_description ?? '').trim() || firstLine(description, 160),
    description,
    opened_for: input.opened_for || ctx.user.sysId,
    contact_type: input.contact_type || 'self-service',
    resolvr_topic: topic?.sysId ?? null,
    service: routing?.service.sysId ?? null,
    department: routing?.department?.sysId ?? null,
    state: UR_STATE.NEW,
    state_reason: UR_REASON.ROUTING,
  });
  let primary: Rec | null = null;
  if (routing?.table && hasTable(ctx, routing.table)) {
    primary = routeUniversalRequest(ctx, ur, routing.table, { assignmentGroup: routing.group });
  }
  return { ur: sys.get(T.ur, ur.sysId) ?? ur, primary };
}

/** Applies `sn_inc_uni_req.incident.universal_request.copy_fields` (pairs `incident_field=ur_field`). */
function copyFields(ctx: Context, ur: Rec, table: string, values: Record<string, unknown>): void {
  const spec = ctx.platform.properties.get(PROPS.copyFields, 'caller_id=opened_for') ?? '';
  for (const pair of spec.split(',')) {
    const [target, source] = pair.split('=').map((s) => s.trim());
    if (!target || !source || !hasColumn(ctx, table, target) || !ur.has(source)) continue;
    const v = ur.get(source);
    if (v !== null && v !== '') values[target] = v;
  }
}

/**
 * Creates the department record (incident, requested item, any task table) for a UR and
 * makes it the primary ticket. Comments and state then stay in sync through the hooks.
 */
export function routeUniversalRequest(
  ctx: Context,
  ur: Rec,
  table: string,
  opts: { assignmentGroup?: string | null } = {},
): Rec {
  if (!hasTable(ctx, table)) throw new InvalidError(`Table ${table} is not installed`);
  const meta = ctx.registry.table(table);
  if (!meta.ancestors.includes('task') || meta.ancestors.includes(T.ur))
    throw new InvalidError(`${meta.label} cannot fulfil a universal request`);
  if (UR_CLOSED_STATES.includes(ur.str('state')))
    throw new AbortError('Closed universal requests cannot be routed');
  const current = primaryOf(ctx, ur);
  if (current?.bool('active'))
    throw new AbortError(`This request is already routed to ${current.str('number')}`);

  const sys = ctx.elevated();
  const shortDescription = ur.str('short_description') || firstLine(ur.str('description'), 160);
  const values: Record<string, unknown> = {
    short_description: shortDescription,
    description: ur.str('description'),
    universal_request: ur.sysId,
  };
  if (hasColumn(ctx, table, 'opened_by')) values.opened_by = ur.str('opened_by') || ur.str('opened_for');
  const reqField = requesterField(ctx, table);
  if (reqField) values[reqField] = ur.str('opened_for');
  if (meta.ancestors.includes('incident')) copyFields(ctx, ur, table, values);
  if (hasColumn(ctx, table, 'contact_type')) values.contact_type = ur.str('contact_type') || 'self-service';
  let group = opts.assignmentGroup ?? null;
  if (!group && ur.str('service')) {
    const service = sys.get(T.urService, ur.str('service'));
    group = service?.str('assignment_group') || service?.ref('department')?.str('assignment_group') || null;
  }
  if (group && hasColumn(ctx, table, 'assignment_group')) values.assignment_group = group;
  if (
    meta.ancestors.includes('sc_req_item') &&
    hasColumn(ctx, table, 'request') &&
    hasTable(ctx, 'sc_request')
  ) {
    const request = sys.insert('sc_request', {
      requested_for: ur.str('opened_for'),
      opened_by: values.opened_by ?? ur.str('opened_for'),
      short_description: shortDescription,
      description: ur.str('description'),
    });
    values.request = request.sysId;
  }

  const primary = sys.insert(table, values);
  // The insert hook normally links the new record; this covers contexts where hooks did not run.
  const fresh = sys.get(T.ur, ur.sysId) ?? ur;
  if (fresh.str('primary_task') !== primary.sysId) linkPrimary(sys, fresh, primary);
  ctx.addInfoMessage(`${meta.label} ${primary.str('number')} created`);
  ctx.queueEvent('universal_request.routed', fresh, primary.sysId, table);
  return primary;
}

/** Closes (or cancels) a universal request, optionally with a comment for the requester. */
export function closeUniversalRequest(
  ctx: Context,
  ur: Rec,
  comment = '',
  state: string = UR_STATE.CLOSED,
): Rec {
  const values: Record<string, unknown> = { state, state_reason: '', confirm_due: null };
  if (comment.trim()) values.comments = comment.trim();
  return ctx.elevated().update(ur, values);
}

/** True when the UR has a primary ticket that is still being worked. */
export function hasActivePrimary(ctx: Context, ur: Rec): boolean {
  return !!primaryOf(ctx, ur)?.bool('active');
}

// ------------------------------------------------------------------ hooks

function commentsOf(rec: Rec): string[] {
  return rec.journal.filter((j) => j.field === 'comments').map((j) => j.value);
}

/** Copies comments added on a UR to its active primary ticket (as the same user). */
function pushComments(ur: Rec, ctx: Context): void {
  if (syncDepth) return;
  const comments = commentsOf(ur);
  if (!comments.length) return;
  const primary = primaryOf(ctx, ur);
  if (!primary?.bool('active') || !primary.has('comments')) return;
  quietSync(() => {
    for (const text of comments) primary.set('comments', text);
    try {
      ctx.elevated().update(primary);
    } catch (e) {
      // A business rule on the department table refused the comment; the UR keeps it.
      if (!(e instanceof AbortError)) throw e;
    }
  });
}

/** Copies comments added on a primary ticket to its UR. */
function pullComments(primary: Rec, ur: Rec, ctx: Context): void {
  if (syncDepth) return;
  const comments = commentsOf(primary);
  if (!comments.length) return;
  quietSync(() => {
    const fresh = ctx.elevated().get(T.ur, ur.sysId);
    if (!fresh) return;
    for (const text of comments) fresh.set('comments', text);
    ctx.elevated().update(fresh);
  });
}

export function registerUrHooks(platform: Platform): void {
  // A task created with universal_request set becomes the primary ticket when the UR has none.
  platform.hooks.on('insert', 'task', 'portal: link primary ticket', (rec, _prev, ctx) => {
    if (isUniversalRequest(rec) || !rec.has('universal_request') || !rec.str('universal_request')) return;
    const sys = ctx.elevated();
    const ur = sys.get(T.ur, rec.str('universal_request'));
    if (!ur) return;
    const current = ur.str('primary_task');
    if (current && current !== rec.sysId && sys.get('task', current)?.bool('active')) return;
    linkPrimary(sys, ur, rec);
  });

  // State and comments follow the primary ticket; UR comments flow to the primary ticket.
  platform.hooks.on('update', 'task', 'portal: universal request sync', (rec, _prev, ctx) => {
    if (isUniversalRequest(rec)) {
      pushComments(rec, ctx);
      return;
    }
    if (!rec.has('universal_request') || !rec.str('universal_request')) return;
    const sys = ctx.elevated();
    const ur = sys.get(T.ur, rec.str('universal_request'));
    if (!ur || ur.str('primary_task') !== rec.sysId) return;
    if (rec.changed('state') || rec.changed('active')) syncUrFromPrimary(sys, ur, rec);
    pullComments(rec, ur, ctx);
  });
}

// ------------------------------------------------------------------ jobs

/** Closes URs whose requester did not confirm the outcome before the confirmation due date. */
export function autoCloseUnconfirmed(ctx: Context): number {
  const sys = ctx.elevated();
  let n = 0;
  for (const ur of sys.query(T.ur, {
    query: `state=${UR_STATE.AWAITING}^state_reason=${UR_REASON.CONFIRM}^confirm_due<=${nowGlide()}`,
    limit: 500,
  })) {
    if (hasActivePrimary(sys, ur)) continue;
    closeUniversalRequest(sys, ur);
    n++;
  }
  return n;
}
