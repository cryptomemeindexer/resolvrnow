import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { diffMs, nowGlide } from '../../engine/util.js';
import { taskStates } from '../task/index.js';
import {
  ACTIVE_STATES,
  ADMIN_EDITABLE_WHEN_CLOSED,
  CLOSE_CODE,
  CLOSED_STATES,
  HOLD_REASON,
  INC_STATE,
  MIM_STATE,
  PROP,
  SYSTEM_MAINTAINED,
} from './constants.js';
import { clearStrikes, startStrikes } from './strikes.js';
import {
  businessMs,
  isAgent,
  isCaller,
  isInteractive,
  isMajorIncident,
  isOpener,
  isQuiet,
  maintenanceContext,
  propBool,
  propStr,
  quietly,
  recipients,
} from './util.js';

export const RESOLUTION_REQUIRED = 'Resolution code and resolution notes are required';

/** Allowed state changes; anything else aborts (see the incident state model). */
const TRANSITIONS: Record<string, string[]> = {
  '1': ['2', '3', '6', '7', '8'],
  '2': ['3', '6', '7', '8'],
  '3': ['2', '6', '7', '8'],
  '6': ['2', '7'],
};

/** Records whose journal entries in the current operation were written by automation. */
const quietRecords = new WeakSet<Rec>();

const MAX_CASCADE_DEPTH = 10;
let cascadeDepth = 0;

export const prevStr = (rec: Rec, field: string): string => {
  const v = rec.prev(field);
  return v === null || v === undefined ? '' : String(v);
};

const isActiveState = (state: string): boolean => (ACTIVE_STATES as readonly string[]).includes(state);
const isClosedState = (state: string): boolean => (CLOSED_STATES as readonly string[]).includes(state);

/** Sets resolved_* and the resolve-time KPIs unless the caller provided them. */
function stampResolution(cur: Rec, ctx: Context, onlyMissing: boolean): void {
  if (!cur.str('resolved_at') || (!onlyMissing && !cur.touched.has('resolved_at')))
    cur.setRaw('resolved_at', nowGlide());
  if (!cur.str('resolved_by') || (!onlyMissing && !cur.touched.has('resolved_by')))
    cur.setRaw('resolved_by', ctx.user.sysId);
  const opened = cur.str('opened_at') || cur.str('sys_created_on');
  const resolved = cur.str('resolved_at');
  if (!opened || !resolved) return;
  cur.setRaw('calendar_stc', Math.max(0, Math.round(diffMs(resolved, opened) / 1000)));
  cur.setRaw('business_stc', Math.round(businessMs(ctx, opened, resolved) / 1000));
}

/** Known error resolution needs an attached Known Error article (only checked when knowledge is installed). */
function hasKnownErrorArticle(ctx: Context, inc: Rec): boolean {
  const reg = ctx.registry;
  if (
    !reg.has('m2m_kb_task') ||
    !reg.column('m2m_kb_task', 'task') ||
    !reg.column('m2m_kb_task', 'kb_knowledge')
  )
    return true;
  const sys = ctx.platform.systemContext();
  for (const link of sys.query('m2m_kb_task', { query: `task=${inc.sysId}` })) {
    const article = link.ref('kb_knowledge');
    if (article?.className === 'kb_template_known_error_article') return true;
  }
  return false;
}

function createsLoop(ctx: Context, childId: string, parentId: string): boolean {
  const sys = ctx.platform.systemContext();
  let id: string | null = parentId;
  for (let hops = 0; id && hops < 100; hops++) {
    if (id === childId) return true;
    id = sys.loadRaw('incident', id)?.str('parent_incident') || null;
  }
  return false;
}

function groupFrom(rec: Rec | null, field: string): string | null {
  if (!rec || !field || !rec.has(field)) return null;
  return rec.str(field) || null;
}

// ---------------------------------------------------------------- before rules

const before: BusinessRuleDef[] = [
  {
    name: 'Incident: defaults',
    table: 'incident',
    when: 'before',
    actions: ['insert'],
    order: 10,
    run(cur) {
      if (!cur.str('state')) cur.setRaw('state', Number(INC_STATE.NEW));
      const caller = cur.ref('caller_id');
      if (!caller) return;
      for (const f of ['company', 'location']) {
        if (!cur.str(f) && caller.has(f) && caller.str(f)) cur.setRaw(f, caller.str(f));
      }
    },
  },
  {
    name: 'Incident: self-service restrictions',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 15,
    condition: (_cur, _prev, ctx) => !isAgent(ctx),
    run(cur) {
      if (cur.journal.some((j) => j.field === 'work_notes' || j.field === 'actions_taken')) {
        cur.abort('Only agents can add work notes');
        return;
      }
      if (cur.isNew()) {
        cur.setRaw('state', Number(INC_STATE.NEW));
        cur.setRaw('hold_reason', null);
      }
    },
  },
  {
    name: 'Incident: clear assignee when the group changes',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 40,
    condition: (cur) =>
      cur.changed('assignment_group') && !cur.changed('assigned_to') && !!cur.str('assigned_to'),
    run(cur) {
      cur.setRaw('assigned_to', null);
    },
  },
  {
    name: 'Incident: assignment moves New to In Progress',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 42,
    condition: (cur, _prev, ctx) =>
      cur.changed('assigned_to') &&
      !!cur.str('assigned_to') &&
      cur.str('state') === INC_STATE.NEW &&
      !cur.changed('state') &&
      propBool(ctx, PROP.assignMovesToInProgress, true),
    run(cur) {
      cur.setRaw('state', Number(INC_STATE.IN_PROGRESS));
    },
  },
  {
    name: 'Incident: parent loop guard',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 44,
    condition: (cur) => cur.changed('parent_incident') && !!cur.str('parent_incident'),
    run(cur, _prev, ctx) {
      if (createsLoop(ctx, cur.sysId, cur.str('parent_incident')))
        cur.abort('Parent incident would create a loop');
    },
  },
  {
    name: 'Incident: align a new child with its parent',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 45,
    condition: (cur) =>
      cur.changed('parent_incident') &&
      !!cur.str('parent_incident') &&
      isActiveState(cur.str('state') || INC_STATE.NEW),
    run: alignWithParent,
  },
  {
    name: 'Incident: state and incident_state sync',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur) {
      if (cur.touched.has('incident_state') && !cur.touched.has('state') && cur.str('incident_state')) {
        cur.setRaw('state', cur.num('incident_state'));
      }
    },
  },
  {
    name: 'Incident: priority from impact and urgency',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 60,
    run(cur, _prev, ctx) {
      const p = taskStates(ctx.platform).lookupPriority(ctx, cur.str('impact'), cur.str('urgency'));
      if (p && cur.str('priority') !== p) cur.setRaw('priority', Number(p));
    },
  },
  {
    name: 'Incident: state transition guard',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('state'),
    run(cur) {
      const from = prevStr(cur, 'state');
      const to = cur.str('state');
      if (isClosedState(from)) {
        cur.abort('Closed or canceled incidents cannot change state');
        return;
      }
      const allowed = TRANSITIONS[from];
      if (allowed && !allowed.includes(to)) cur.abort('Invalid state transition');
    },
  },
  {
    name: 'Incident: closed incidents are read-only',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 105,
    condition: (cur, _prev, ctx) =>
      isInteractive(ctx) && isClosedState(prevStr(cur, 'state')) && !cur.changed('state'),
    run(cur, _prev, ctx) {
      const allowed = new Set([
        ...SYSTEM_MAINTAINED,
        ...(ctx.user.isAdmin ? ADMIN_EDITABLE_WHEN_CLOSED : []),
      ]);
      if (cur.changes().some((f) => !allowed.has(f))) cur.abort('Closed or canceled incidents are read-only');
    },
  },
  {
    name: 'Incident: on hold rules',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 110,
    run(cur) {
      if (cur.str('state') !== INC_STATE.ON_HOLD) {
        if (cur.str('hold_reason')) cur.setRaw('hold_reason', null);
        return;
      }
      if (!cur.str('hold_reason')) {
        cur.abort('On hold reason is required');
        return;
      }
      const entering = cur.isNew() || cur.changed('state') || cur.changed('hold_reason');
      if (entering && cur.str('hold_reason') === HOLD_REASON.CALLER && !cur.changed('comments')) {
        cur.abort('Add a comment for the caller when the incident waits for the caller');
      }
    },
  },
  {
    name: 'Incident: caller response resumes work',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 120,
    condition: (cur, _prev, ctx) =>
      prevStr(cur, 'state') === INC_STATE.ON_HOLD &&
      cur.str('state') === INC_STATE.ON_HOLD &&
      cur.changed('comments') &&
      isCaller(cur, ctx),
    run(cur) {
      cur.setRaw('state', Number(INC_STATE.IN_PROGRESS));
      cur.setRaw('hold_reason', null);
    },
  },
  {
    // The reopen rule below applies the reopen effects (count, reopened_by, cleared resolution).
    name: 'Incident: caller comment reopens a resolved incident',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 125,
    condition: (cur, _prev, ctx) =>
      prevStr(cur, 'state') === INC_STATE.RESOLVED &&
      cur.str('state') === INC_STATE.RESOLVED &&
      cur.changed('comments') &&
      isCaller(cur, ctx) &&
      !isMajorIncident(cur),
    run(cur) {
      cur.setRaw('state', Number(INC_STATE.IN_PROGRESS));
    },
  },
  {
    name: 'Incident: resolution fields',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 130,
    condition: (cur) => cur.str('state') === INC_STATE.RESOLVED && (cur.isNew() || cur.changed('state')),
    run(cur, _prev, ctx) {
      if (!cur.str('close_code') || !cur.str('close_notes')) {
        cur.abort(RESOLUTION_REQUIRED);
        return;
      }
      if (!isAgent(ctx)) {
        if (isMajorIncident(cur)) {
          cur.abort('Only agents can resolve a major incident');
          return;
        }
        if (!isCaller(cur, ctx) && !isOpener(cur, ctx)) {
          cur.abort('Only the caller or an agent can resolve this incident');
          return;
        }
      }
      if (cur.str('close_code') === CLOSE_CODE.KNOWN_ERROR && !hasKnownErrorArticle(ctx, cur)) {
        cur.abort('Attach a known error article before using the Known error resolution code');
        return;
      }
      stampResolution(cur, ctx, false);
    },
  },
  {
    name: 'Incident: reopen',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 140,
    condition: (cur) =>
      prevStr(cur, 'state') === INC_STATE.RESOLVED &&
      cur.changed('state') &&
      cur.str('state') === INC_STATE.IN_PROGRESS,
    run(cur, _prev, ctx) {
      if (!isAgent(ctx)) {
        if (isMajorIncident(cur)) {
          cur.abort('Only agents can reopen a major incident');
          return;
        }
        if (!isCaller(cur, ctx) && !isOpener(cur, ctx)) {
          cur.abort('Only the caller or an agent can reopen this incident');
          return;
        }
      }
      cur.setRaw('reopen_count', (cur.num('reopen_count') ?? 0) + 1);
      cur.setRaw('reopened_by', ctx.user.sysId);
      cur.setRaw('reopened_time', nowGlide());
      for (const f of ['resolved_by', 'resolved_at', 'close_code', 'close_notes']) cur.setRaw(f, null);
    },
  },
  {
    name: 'Incident: closure fields',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 150,
    condition: (cur) => isClosedState(cur.str('state')) && (cur.isNew() || cur.changed('state')),
    run(cur, _prev, ctx) {
      if (cur.str('state') === INC_STATE.CANCELED) {
        if (!isAgent(ctx)) cur.abort('Only agents can cancel an incident');
        return;
      }
      if (!cur.str('close_code') || !cur.str('close_notes')) {
        cur.abort(RESOLUTION_REQUIRED);
        return;
      }
      if (isMajorIncident(cur) && !ctx.user.isSystem && !ctx.hasRole('major_incident_manager')) {
        cur.abort('Only a major incident manager can close a major incident');
        return;
      }
      if (!isAgent(ctx) && !isCaller(cur, ctx) && !isOpener(cur, ctx)) {
        cur.abort('Only the caller or an agent can close this incident');
        return;
      }
      stampResolution(cur, ctx, true);
      const opened = cur.str('opened_at') || cur.str('sys_created_on');
      if (opened)
        cur.setRaw('business_duration', businessMs(ctx, opened, cur.str('closed_at') || nowGlide()));
    },
  },
  {
    name: 'Incident: cancel major incident state',
    table: 'incident',
    when: 'before',
    actions: ['update'],
    order: 160,
    condition: (cur) =>
      cur.changedTo('state', INC_STATE.CANCELED) &&
      [MIM_STATE.PROPOSED, MIM_STATE.ACCEPTED].includes(cur.str('major_incident_state') as 'proposed'),
    run(cur) {
      cur.setRaw('major_incident_state', MIM_STATE.CANCELED);
    },
  },
  {
    name: 'Incident: mirror state to incident_state',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 880,
    run(cur) {
      if (cur.str('incident_state') !== cur.str('state')) cur.setRaw('incident_state', cur.num('state'));
    },
  },
  {
    name: 'Incident: populate assignment group from CI or service offering',
    table: 'incident',
    when: 'before',
    actions: ['insert', 'update'],
    order: 900,
    condition: (cur) =>
      !cur.str('assignment_group') &&
      !cur.str('assigned_to') &&
      (cur.isNew() || cur.changed('cmdb_ci') || cur.changed('service_offering')),
    run(cur, _prev, ctx) {
      const group =
        groupFrom(cur.ref('cmdb_ci'), propStr(ctx, PROP.ciGroupField, 'support_group')) ??
        groupFrom(cur.ref('service_offering'), propStr(ctx, PROP.offeringGroupField, 'support_group'));
      if (group) cur.setRaw('assignment_group', group);
    },
  },
  {
    name: 'Incident task: clear assignee when the group changes',
    table: 'incident_task',
    when: 'before',
    actions: ['update'],
    order: 40,
    condition: (cur) =>
      cur.changed('assignment_group') && !cur.changed('assigned_to') && !!cur.str('assigned_to'),
    run(cur) {
      cur.setRaw('assigned_to', null);
    },
  },
];

/** Aligns a child that is being linked with its parent's current state. */
function alignWithParent(cur: Rec): void {
  const parent = cur.ref('parent_incident');
  if (!parent) return;
  const ps = parent.str('state');
  const cs = cur.str('state') || INC_STATE.NEW;
  if (ps === INC_STATE.IN_PROGRESS && (cs === INC_STATE.NEW || cs === INC_STATE.ON_HOLD)) {
    cur.setRaw('state', Number(INC_STATE.IN_PROGRESS));
    cur.setRaw('hold_reason', null);
  } else if (
    ps === INC_STATE.ON_HOLD &&
    parent.str('hold_reason') !== HOLD_REASON.CALLER &&
    parent.str('hold_reason')
  ) {
    cur.setRaw('state', Number(INC_STATE.ON_HOLD));
    cur.setRaw('hold_reason', parent.num('hold_reason'));
  } else if (ps === INC_STATE.RESOLVED) {
    cur.setRaw('state', Number(INC_STATE.RESOLVED));
    cur.setRaw('close_code', parent.str('close_code'));
    cur.setRaw('close_notes', parent.str('close_notes'));
    cur.set('comments', resolvedWithParentNote(parent));
    quietRecords.add(cur);
  }
}

function resolvedWithParentNote(parent: Rec): string {
  return `Resolved together with parent incident ${parent.str('number')}.\n\n${parent.str('close_notes')}`;
}

// ---------------------------------------------------------------- after rules

function queueEvents(cur: Rec, prev: Rec | null, ctx: Context): void {
  const inserted = cur.operation === 'insert';
  const quiet = isQuiet() || quietRecords.has(cur);
  quietRecords.delete(cur);
  const uid = ctx.user.sysId ?? '';
  const uname = ctx.user.userName;
  const ev = (name: string, p1: string | null = uid, p2: string | null = uname) =>
    ctx.queueEvent(name, cur, p1, p2);
  const before = (f: string) => (prev ? prev.str(f) : '');

  ev(inserted ? 'incident.inserted' : 'incident.updated');
  if (cur.changed('assigned_to') && cur.str('assigned_to'))
    ev('incident.assigned', cur.str('assigned_to'), before('assigned_to'));
  if (cur.changed('assignment_group') && cur.str('assignment_group')) {
    ev('incident.assigned.to.group', cur.str('assignment_group'), before('assignment_group'));
  }
  if (!quiet && cur.changed('comments')) ev('incident.commented');
  if (!quiet && cur.changed('work_notes')) ev('incident.worknoted');
  if (cur.changed('priority') && cur.str('priority') === '1')
    ev('incident.priority.1', '1', before('priority'));
  if (cur.changed('severity') && cur.str('severity') === '1')
    ev('incident.severity.1', '1', before('severity'));
  if (!inserted && (cur.num('escalation') ?? 0) > (prev?.num('escalation') ?? 0)) {
    ev('incident.escalated', cur.str('escalation'), before('escalation'));
  }
  if (!cur.changed('state')) return;
  const state = cur.str('state');
  const from = before('state');
  if (state === INC_STATE.RESOLVED) ev('incident.resolved');
  else if (state === INC_STATE.CLOSED) ev('incident.closed');
  else if (state === INC_STATE.CANCELED) ev('incident.canceled');
  else if (state === INC_STATE.IN_PROGRESS && from === INC_STATE.RESOLVED) ev('incident.reopened');
  else if (
    state === INC_STATE.IN_PROGRESS &&
    from === INC_STATE.ON_HOLD &&
    cur.changed('comments') &&
    isCaller(cur, ctx)
  ) {
    ev(
      'incident.caller.responded',
      cur.str('caller_id'),
      recipients(cur.str('assigned_to'), cur.str('watch_list')),
    );
  }
}

function syncStrikes(cur: Rec, prev: Rec | null, ctx: Context): void {
  const waiting = cur.str('state') === INC_STATE.ON_HOLD && cur.str('hold_reason') === HOLD_REASON.CALLER;
  if (waiting) {
    if (cur.operation === 'insert' || cur.changed('state') || cur.changed('hold_reason'))
      startStrikes(ctx, cur);
    return;
  }
  if (prev && prev.str('state') === INC_STATE.ON_HOLD && prev.str('hold_reason') === HOLD_REASON.CALLER)
    clearStrikes(ctx, cur);
}

/** Parent to child cascade (resolve, hold, resume, reopen). */
function syncChildren(cur: Rec, prev: Rec | null, ctx: Context): void {
  const to = cur.str('state');
  const from = prev?.str('state') ?? '';
  const sys = ctx.elevated();
  const children = sys.query('incident', { query: `parent_incident=${cur.sysId}^ORDERBYnumber` });
  if (!children.length) return;
  if (from === INC_STATE.RESOLVED && to === INC_STATE.IN_PROGRESS) {
    if (!isAgent(ctx)) return;
    for (const child of children) {
      if (child.str('state') === INC_STATE.RESOLVED) sys.update(child, { state: INC_STATE.IN_PROGRESS });
    }
    return;
  }
  if (to === INC_STATE.IN_PROGRESS) {
    for (const child of children) {
      if (child.str('state') === INC_STATE.NEW || child.str('state') === INC_STATE.ON_HOLD)
        sys.update(child, { state: INC_STATE.IN_PROGRESS });
    }
  } else if (to === INC_STATE.ON_HOLD) {
    const reason = cur.str('hold_reason');
    if (!reason || reason === HOLD_REASON.CALLER) return;
    for (const child of children) {
      if (!isActiveState(child.str('state'))) continue;
      if (child.str('state') === INC_STATE.ON_HOLD && child.str('hold_reason') === reason) continue;
      sys.update(child, { state: INC_STATE.ON_HOLD, hold_reason: reason });
    }
  } else if (to === INC_STATE.RESOLVED) {
    for (const child of children) {
      if (!isActiveState(child.str('state'))) continue;
      quietly(() =>
        sys.update(child, {
          state: INC_STATE.RESOLVED,
          close_code: cur.str('close_code'),
          close_notes: cur.str('close_notes'),
          comments: resolvedWithParentNote(cur),
        }),
      );
    }
  }
}

/** Keeps parent.child_incidents equal to the number of incidents pointing at it. */
export function recountChildren(ctx: Context, parentId: string): void {
  if (!parentId) return;
  const m = maintenanceContext(ctx);
  const parent = m.get('incident', parentId);
  if (!parent) return;
  const n = m.count('incident', `parent_incident=${parentId}`);
  if (parent.num('child_incidents') !== n) m.update(parent, { child_incidents: n });
}

const after: BusinessRuleDef[] = [
  {
    name: 'Incident: queue events',
    table: 'incident',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    run: queueEvents,
  },
  {
    name: 'Incident: caller strike cycle',
    table: 'incident',
    when: 'after',
    actions: ['insert', 'update'],
    order: 150,
    run: syncStrikes,
  },
  {
    name: 'Incident: parent and child synchronization',
    table: 'incident',
    when: 'after',
    actions: ['update'],
    order: 200,
    condition: (cur) => cur.changed('state'),
    run(cur, prev, ctx) {
      if (cascadeDepth >= MAX_CASCADE_DEPTH) return;
      cascadeDepth++;
      try {
        syncChildren(cur, prev, ctx);
      } finally {
        cascadeDepth--;
      }
    },
  },
  {
    name: 'Incident: child incident count',
    table: 'incident',
    when: 'after',
    actions: ['insert', 'update', 'delete'],
    order: 210,
    condition: (cur) => cur.operation === 'delete' || cur.changed('parent_incident'),
    run(cur, _prev, ctx) {
      const ids = new Set([cur.str('parent_incident'), prevStr(cur, 'parent_incident')]);
      for (const id of ids) recountChildren(ctx, id);
    },
  },
  {
    name: 'Incident: close open incident tasks',
    table: 'incident',
    when: 'after',
    actions: ['update'],
    order: 300,
    condition: (cur, _prev, ctx) =>
      cur.changed('state') && isClosedState(cur.str('state')) && propBool(ctx, PROP.taskClosure, true),
    run(cur, _prev, ctx) {
      const target = cur.str('state') === INC_STATE.CLOSED ? '4' : '7';
      const sys = ctx.elevated();
      for (const t of sys.query('incident_task', { query: `incident=${cur.sysId}^stateIN-5,1,2` }))
        sys.update(t, { state: target });
    },
  },
];

export const INCIDENT_RULES: BusinessRuleDef[] = [...before, ...after];
