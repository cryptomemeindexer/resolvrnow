import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { nowGlide } from '../../engine/util.js';
import { CLOSE_CODE, HOLD_REASON, INC_STATE } from '../incident/constants.js';
import { maintenanceContext, propBool, propList, propStr, quietly, recipients } from '../incident/util.js';
import { COORDINATOR, PRB_PROP, PRB_STATE, RESOLUTION } from './constants.js';

const OPEN_INCIDENT = `stateIN${INC_STATE.NEW},${INC_STATE.IN_PROGRESS},${INC_STATE.ON_HOLD}`;
const WAITING_ON_PROBLEM = `state=${INC_STATE.ON_HOLD}^hold_reason=${HOLD_REASON.PROBLEM}`;

/** Plain text from the HTML fields (workaround, fix notes) for journal entries. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function linkedIncidents(ctx: Context, prb: Rec, query = ''): Rec[] {
  return ctx
    .elevated()
    .query('incident', { query: `problem_id=${prb.sysId}${query ? `^${query}` : ''}^ORDERBYnumber` });
}

export function recountRelatedIncidents(ctx: Context, problemId: string): void {
  if (!problemId) return;
  const m = maintenanceContext(ctx);
  const prb = m.get('problem', problemId);
  if (!prb) return;
  const n = m.count('incident', `problem_id=${problemId}`);
  if (prb.num('related_incidents') !== n) m.update(prb, { related_incidents: n });
}

function requireCoordinator(ctx: Context, what: string): void {
  if (!ctx.user.isSystem && !ctx.hasRole(COORDINATOR))
    throw new AccessError(`Insufficient rights to ${what}`);
}

/** Create Problem from an incident: copies the configured fields, links it and puts the incident on hold. */
export function createProblemFromIncident(ctx: Context, inc: Rec): Rec {
  if (!ctx.user.isSystem && !ctx.hasAnyRole(['itil', 'itil_admin', 'sn_incident_write'])) {
    throw new AccessError('Insufficient rights to create a problem');
  }
  if (inc.str('problem_id')) throw new AbortError('This incident is already linked to a problem');
  if (![INC_STATE.NEW, INC_STATE.IN_PROGRESS, INC_STATE.ON_HOLD].includes(inc.str('state') as '1')) {
    throw new AbortError('Problems can only be created from open incidents');
  }
  const values: Record<string, unknown> = {};
  const problemMeta = ctx.registry.table('problem');
  for (const f of propList(ctx, PRB_PROP.createFromIncidentAttributes)) {
    if (f === 'number') values.first_reported_by_task = inc.sysId;
    else if (problemMeta.columns.has(f) && inc.has(f) && inc.str(f)) values[f] = inc.get(f);
  }
  const prb = ctx.insert('problem', values);
  ctx.update(inc, {
    problem_id: prb.sysId,
    state: INC_STATE.ON_HOLD,
    hold_reason: HOLD_REASON.PROBLEM,
    work_notes: `Problem ${prb.str('number')} was created to find the root cause.`,
  });
  return prb;
}

/** "Add" on the problem's Incidents related list. Closed incidents need the configured role. */
export function addIncidentsToProblem(ctx: Context, prb: Rec, incidentIds: string[]): number {
  if (!ctx.user.isSystem && !ctx.hasAnyRole(['itil', COORDINATOR]))
    throw new AccessError('Insufficient rights to relate incidents');
  if (!prb.bool('active')) throw new AbortError('Incidents can only be related to active problems');
  const role = propStr(ctx, PRB_PROP.relateClosedIncidents, COORDINATOR);
  const sys = ctx.elevated();
  let added = 0;
  for (const id of incidentIds) {
    const inc = sys.get('incident', id);
    if (!inc || inc.str('problem_id') === prb.sysId) continue;
    if (!inc.bool('active') && !(role && role !== 'nobody' && ctx.hasRole(role))) {
      throw new AccessError(`Insufficient rights to relate closed incident ${inc.str('number')}`);
    }
    sys.update(inc, { problem_id: prb.sysId });
    added++;
  }
  return added;
}

/** Problem resolved or closed: incidents waiting on it are resolved (fix) or informed (risk accepted). */
export function syncIncidents(prb: Rec, ctx: Context): void {
  const code = prb.str('resolution_code');
  const sys = ctx.elevated();
  if (code === RESOLUTION.FIX_APPLIED) {
    const fix = stripHtml(prb.str('fix_notes'));
    for (const inc of linkedIncidents(ctx, prb, WAITING_ON_PROBLEM)) {
      quietly(() =>
        sys.update(inc, {
          state: INC_STATE.RESOLVED,
          close_code: CLOSE_CODE.RESOLVED_BY_PROBLEM,
          close_notes: `Resolved by problem ${prb.str('number')}. See the comments for the fix that was applied.`,
          comments: `The permanent fix from problem ${prb.str('number')} has been applied.${fix ? `\n\n${fix}` : ''}`,
        }),
      );
      ctx.queueEvent(
        'incident.problem.resolved',
        inc,
        recipients(inc.str('caller_id'), inc.str('assigned_to')),
        prb.str('number'),
      );
    }
  } else if (code === RESOLUTION.RISK_ACCEPTED && prb.changed('resolution_code')) {
    for (const inc of linkedIncidents(ctx, prb, WAITING_ON_PROBLEM)) {
      quietly(() =>
        sys.update(inc, {
          work_notes: `Problem ${prb.str('number')} was closed with the risk accepted: ${prb.str('close_notes')}`,
        }),
      );
      ctx.queueEvent(
        'incident.problem.risk_accepted',
        inc,
        recipients(inc.str('assigned_to')),
        prb.str('number'),
      );
    }
  }
}

/** Communicate Workaround: work note (and a comment unless configured otherwise) on each open incident. */
export function communicateWorkaround(ctx: Context, prb: Rec): number {
  requireCoordinator(ctx, 'communicate workarounds');
  const workaround = stripHtml(prb.str('workaround'));
  if (!workaround) throw new AbortError('Document the workaround before communicating it');
  if (!prb.bool('active')) throw new AbortError('Workarounds can only be communicated for active problems');
  const workNotesOnly = propBool(ctx, PRB_PROP.workaroundToWorkNotes, false);
  const text = `Workaround from problem ${prb.str('number')} (${prb.str('short_description')}):\n\n${workaround}`;
  const sys = ctx.elevated();
  const incidents = linkedIncidents(ctx, prb, OPEN_INCIDENT);
  for (const inc of incidents) {
    quietly(() =>
      sys.update(inc, workNotesOnly ? { work_notes: text } : { work_notes: text, comments: text }),
    );
    const to = workNotesOnly
      ? recipients(inc.str('assigned_to'), inc.str('work_notes_list'))
      : recipients(
          inc.str('caller_id'),
          inc.str('assigned_to'),
          inc.str('watch_list'),
          inc.str('work_notes_list'),
        );
    ctx.queueEvent('incident.problem.workaround', inc, to, prb.str('number'));
  }
  ctx.update(prb, { workaround_communicated_at: nowGlide(), workaround_communicated_by: ctx.user.sysId });
  ctx.queueEvent('problem.workaround.communicated', prb, String(incidents.length), ctx.user.userName);
  return incidents.length;
}

/** Communicate Fix: fix notes as a comment (or a work note when configured) on each open incident. */
export function communicateFix(ctx: Context, prb: Rec): number {
  requireCoordinator(ctx, 'communicate fixes');
  const fix = stripHtml(prb.str('fix_notes'));
  if (!fix) throw new AbortError('Document the fix before communicating it');
  const asWorkNote = propBool(ctx, PRB_PROP.workaroundToWorkNotes, false);
  const text = `Fix from problem ${prb.str('number')} (${prb.str('short_description')}):\n\n${fix}`;
  const sys = ctx.elevated();
  const incidents = linkedIncidents(ctx, prb, OPEN_INCIDENT);
  for (const inc of incidents) {
    quietly(() => sys.update(inc, asWorkNote ? { work_notes: text } : { comments: text }));
    const to = asWorkNote
      ? recipients(inc.str('assigned_to'), inc.str('work_notes_list'))
      : recipients(inc.str('caller_id'), inc.str('assigned_to'));
    ctx.queueEvent('incident.problem.fix', inc, to, prb.str('number'));
  }
  ctx.update(prb, { fix_communicated_at: nowGlide(), fix_communicated_by: ctx.user.sysId });
  ctx.queueEvent('problem.fix.communicated', prb, String(incidents.length), ctx.user.userName);
  return incidents.length;
}

/** A Known Error article was linked to the problem: open incidents get a work note pointing at it. */
export function shareKnownErrorArticle(prb: Rec, ctx: Context): void {
  const article = prb.ref('primary_known_error_article');
  const label = article?.str('number') || 'a known error article';
  const sys = ctx.elevated();
  for (const inc of linkedIncidents(ctx, prb, 'active=true')) {
    quietly(() =>
      sys.update(inc, {
        work_notes: `Problem ${prb.str('number')} now has known error article ${label} describing the cause and the workaround.`,
      }),
    );
  }
}

/** Mark Duplicate: moves the configured related records (table.field) to the surviving problem. */
export function moveDuplicateRecords(prb: Rec, ctx: Context): void {
  const target = prb.str('duplicate_of');
  if (!target) return;
  const sys = ctx.elevated();
  for (const entry of propList(ctx, PRB_PROP.duplicateRecords)) {
    const [table, field] = entry.split('.');
    if (!table || !field || !sys.registry.has(table) || !sys.registry.column(table, field)) continue;
    for (const rec of sys.query(table, { query: `${field}=${prb.sysId}` })) {
      quietly(() =>
        sys.update(rec, { [field]: target, work_notes: `Moved from duplicate problem ${prb.str('number')}` }),
      );
    }
  }
  recountRelatedIncidents(ctx, prb.sysId);
  recountRelatedIncidents(ctx, target);
}

/** True when the problem has fix records (problem.fix.records) and none of them is still active. */
export function allFixRecordsDone(ctx: Context, problemId: string): boolean {
  const sys = ctx.elevated();
  let found = 0;
  for (const entry of propList(ctx, PRB_PROP.fixRecords)) {
    const [table, field] = entry.split('.');
    if (!table || !field || !sys.registry.has(table) || !sys.registry.column(table, field)) continue;
    found += sys.count(table, `${field}=${problemId}`);
    if (sys.count(table, `${field}=${problemId}^active=true`) > 0) return false;
  }
  return found > 0;
}

export const isClosedProblem = (prb: Rec | null): boolean => prb?.str('state') === PRB_STATE.CLOSED;
