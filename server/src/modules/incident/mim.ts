import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { recSubject } from '../../engine/rules.js';
import { isSysId, nowGlide } from '../../engine/util.js';
import { optionalService, SERVICES } from '../contracts.js';
import { INC_STATE, MIM_GROUP_NAME, MIM_STATE, PROP } from './constants.js';
import { propList, propStr } from './util.js';

export interface MimInput {
  /** Reason, written to work notes. */
  reason?: string;
  business_impact?: string;
}

const FINISHED = [INC_STATE.RESOLVED, INC_STATE.CLOSED, INC_STATE.CANCELED] as string[];

export function mimGroupId(ctx: Context): string | null {
  const sys = ctx.platform.systemContext();
  const id = propStr(ctx, PROP.mimGroup);
  if (id && sys.get('sys_user_group', id)) return id;
  return sys.first('sys_user_group', `name=${MIM_GROUP_NAME}`)?.sysId ?? null;
}

function requireRole(ctx: Context, roles: string[], what: string): void {
  if (ctx.user.isSystem || ctx.hasAnyRole(roles)) return;
  throw new AccessError(`Insufficient rights to ${what}`);
}

function requireOpen(inc: Rec): void {
  if (FINISHED.includes(inc.str('state')))
    throw new AbortError('Resolved, closed or canceled incidents cannot become major incidents');
}

/** First available on-call user of a group, when an on-call provider is installed. */
export function onCallUser(ctx: Context, groupId: string): string | null {
  const svc = optionalService<Record<string, unknown>>(ctx.platform, SERVICES.oncall);
  const fn = svc?.whoIsOnCall;
  if (typeof fn !== 'function') return null;
  try {
    const args = fn.length >= 3 ? [ctx, groupId, nowGlide()] : [groupId, nowGlide()];
    const id = firstUserId((fn as (...a: unknown[]) => unknown).apply(svc, args), 0);
    return id && ctx.platform.users.session(id) ? id : null;
  } catch {
    return null;
  }
}

/** Finds a user sys_id in whatever shape the on-call provider returns (ids, records or plans). */
function firstUserId(v: unknown, depth: number): string | null {
  if (v === null || v === undefined || depth > 6) return null;
  if (typeof v === 'string') return isSysId(v) ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const id = firstUserId(x, depth + 1);
      if (id) return id;
    }
    return null;
  }
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.className === 'sys_user' && typeof o.sysId === 'string') return o.sysId;
  for (const k of ['user', 'user_id', 'userId'])
    if (typeof o[k] === 'string' && isSysId(o[k])) return o[k] as string;
  for (const k of ['users', 'rotas', 'rosters', 'plan', 'members', 'result']) {
    const id = firstUserId(o[k], depth + 1);
    if (id) return id;
  }
  return null;
}

function baseValues(input: MimInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (input.business_impact) values.business_impact = input.business_impact;
  if (input.reason) values.work_notes = input.reason;
  return values;
}

/** Propose Major Incident (also used by trigger rules running as the system user). */
export function proposeMajorIncident(
  ctx: Context,
  inc: Rec,
  input: MimInput = {},
  extra: Record<string, unknown> = {},
): Rec {
  requireRole(ctx, ['itil', 'sn_incident_write'], 'propose a major incident');
  requireOpen(inc);
  if ([MIM_STATE.PROPOSED, MIM_STATE.ACCEPTED].includes(inc.str('major_incident_state') as 'proposed')) {
    throw new AbortError('This incident is already a major incident or a candidate');
  }
  const values: Record<string, unknown> = {
    ...baseValues(input),
    ...extra,
    major_incident_state: MIM_STATE.PROPOSED,
    proposed_by: ctx.user.sysId,
    proposed_on: nowGlide(),
  };
  const group = mimGroupId(ctx);
  if (!inc.str('assignment_group') && group) {
    values.assignment_group = group;
    values.assigned_to = onCallUser(ctx, group);
  }
  ctx.update(inc, values);
  ctx.queueEvent('incident.mim.proposed', inc, ctx.user.sysId ?? '', input.reason ?? '');
  return inc;
}

/** Promote to Major Incident: the candidate becomes the major incident, or a new one is created. */
export function promoteMajorIncident(
  ctx: Context,
  inc: Rec,
  input: MimInput = {},
  extra: Record<string, unknown> = {},
): Rec {
  requireRole(ctx, ['major_incident_manager'], 'promote a major incident');
  requireOpen(inc);
  if (inc.str('major_incident_state') === MIM_STATE.ACCEPTED)
    throw new AbortError('This incident is already a major incident');
  if (propStr(ctx, PROP.mimCreation, 'promote') === 'create_new')
    return createMajorIncidentFrom(ctx, inc, input, extra);
  const values: Record<string, unknown> = {
    ...baseValues(input),
    ...extra,
    major_incident_state: MIM_STATE.ACCEPTED,
    promoted_by: ctx.user.sysId,
    promoted_on: nowGlide(),
  };
  const group = mimGroupId(ctx);
  const prevGroup = inc.str('assignment_group');
  const prevAssignee = inc.str('assigned_to');
  if (ctx.user.isSystem) {
    if (!prevGroup && group) values.assignment_group = group;
  } else if (group) {
    values.assignment_group = group;
    values.assigned_to = ctx.user.sysId;
  }
  ctx.update(inc, values);
  if (!ctx.user.isSystem && (prevGroup || prevAssignee)) {
    const notifyAssignee = prevAssignee && prevAssignee !== ctx.user.sysId ? prevAssignee : '';
    const notifyGroup = prevGroup && prevGroup !== group ? prevGroup : '';
    if (notifyAssignee || notifyGroup)
      ctx.queueEvent('incident.mim.reassigned', inc, notifyAssignee, notifyGroup);
  }
  ctx.queueEvent('incident.mim.accepted', inc, ctx.user.sysId ?? '', input.reason ?? '');
  return inc;
}

/** create_new mode: a fresh major incident with the candidate attached as a child. */
function createMajorIncidentFrom(
  ctx: Context,
  candidate: Rec,
  input: MimInput,
  extra: Record<string, unknown>,
): Rec {
  const values: Record<string, unknown> = { ...baseValues(input), ...extra, caller_id: null };
  for (const f of propList(ctx, PROP.mimCopyAttributes)) {
    if (candidate.has(f) && candidate.str(f)) values[f] = candidate.get(f);
  }
  const group = mimGroupId(ctx);
  Object.assign(values, {
    major_incident_state: MIM_STATE.ACCEPTED,
    promoted_by: ctx.user.sysId,
    promoted_on: nowGlide(),
    assignment_group: group,
    assigned_to: ctx.user.sysId,
    work_notes: [input.reason, `Major incident created from candidate ${candidate.str('number')}.`]
      .filter(Boolean)
      .join('\n\n'),
  });
  const mi = ctx.insert('incident', values);
  ctx.update(candidate, {
    parent_incident: mi.sysId,
    major_incident_state: null,
    work_notes: `Major incident ${mi.str('number')} was created from this candidate and now tracks the issue.`,
  });
  ctx.queueEvent('incident.mim.accepted', mi, ctx.user.sysId ?? '', input.reason ?? '');
  return mi;
}

export function rejectMajorIncident(ctx: Context, inc: Rec, reason: string): Rec {
  requireRole(ctx, ['major_incident_manager'], 'reject a major incident candidate');
  if (inc.str('major_incident_state') !== MIM_STATE.PROPOSED)
    throw new AbortError('Only major incident candidates can be rejected');
  ctx.update(inc, {
    major_incident_state: MIM_STATE.REJECTED,
    work_notes: `Major incident candidate rejected: ${reason}`,
  });
  ctx.queueEvent('incident.mim.rejected', inc, ctx.user.sysId ?? '', reason);
  return inc;
}

export function demoteMajorIncident(ctx: Context, inc: Rec, reason: string): Rec {
  requireRole(ctx, ['major_incident_manager'], 'demote a major incident');
  if (inc.str('major_incident_state') !== MIM_STATE.ACCEPTED)
    throw new AbortError('Only accepted major incidents can be demoted');
  ctx.update(inc, {
    major_incident_state: MIM_STATE.CANCELED,
    work_notes: `Major incident demoted: ${reason}`,
  });
  ctx.queueEvent('incident.mim.demoted', inc, ctx.user.sysId ?? '', reason);
  return inc;
}

/** Link to Major Incident: makes `inc` a child of the chosen major incident. */
export function linkToMajorIncident(ctx: Context, inc: Rec, majorId: string): Rec {
  requireRole(ctx, ['itil', 'sn_incident_write'], 'link incidents to a major incident');
  const major = ctx.get('incident', majorId);
  if (
    !major ||
    ![MIM_STATE.ACCEPTED, MIM_STATE.PROPOSED].includes(major.str('major_incident_state') as 'accepted')
  ) {
    throw new AbortError('Choose a major incident or a major incident candidate');
  }
  if (!inc.bool('active')) throw new AbortError('Only active incidents can be linked to a major incident');
  ctx.update(inc, { parent_incident: major.sysId });
  return inc;
}

/** Rebuilds the post incident report timeline from the incident's and its plans' journals. */
export function regeneratePirTimeline(ctx: Context, inc: Rec): Rec {
  const history = ctx.platform.history;
  const sys = ctx.platform.systemContext();
  const entries: { at: string; source: string; text: string }[] = [];
  const add = (table: string, rec: Rec, fields?: string[]) => {
    for (const j of history.journal(table, rec.sysId, fields))
      entries.push({ at: j.sys_created_on, source: rec.str('number'), text: j.value });
  };
  add('incident', inc, ['comments', 'work_notes', 'actions_taken']);
  if (sys.registry.has('incident_alert')) {
    for (const plan of sys.query('incident_alert', { query: `source_incident=${inc.sysId}` })) {
      add('incident_alert', plan);
      for (const t of sys.query('incident_alert_task', { query: `incident_alert=${plan.sysId}` }))
        add('incident_alert_task', t);
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<ul>${entries.map((e) => `<li><strong>${e.at} UTC</strong> (${esc(e.source)}): ${esc(e.text)}</li>`).join('')}</ul>`;
  ctx.update(inc, { timeline: html });
  return inc;
}

/** Applies the first matching active trigger rule (ascending order) as the system user. */
function applyTriggerRules(cur: Rec, ctx: Context): void {
  const sys = ctx.asSystem();
  const rules = sys.query('major_incident_trigger_rule', {
    query: 'active=true^tableISEMPTY^ORtable=incident^ORDERBYorder',
  });
  if (!rules.length) return;
  const inc = sys.get('incident', cur.sysId);
  if (!inc) return;
  for (const rule of rules) {
    if (!matches(rule.str('condition'), recSubject(inc, null, sys.registry), sys.env)) continue;
    const extra = { trigger_rule: rule.sysId };
    const input = { reason: `Matched major incident trigger rule "${rule.str('name')}".` };
    if (rule.str('action') === 'promote') promoteMajorIncident(sys, inc, input, extra);
    else proposeMajorIncident(sys, inc, input, extra);
    return;
  }
}

export const MIM_RULES: BusinessRuleDef[] = [
  {
    name: 'Incident: major incident trigger rules',
    table: 'incident',
    when: 'async',
    actions: ['insert', 'update'],
    condition: (cur) =>
      !cur.str('parent_incident') &&
      cur.bool('active') &&
      !FINISHED.includes(cur.str('state')) &&
      ![MIM_STATE.PROPOSED, MIM_STATE.ACCEPTED].includes(cur.str('major_incident_state') as 'proposed'),
    run(cur, _prev, ctx) {
      applyTriggerRules(cur, ctx);
    },
  },
];
