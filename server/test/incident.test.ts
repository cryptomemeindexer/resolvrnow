import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AbortError, AccessError } from '../src/engine/errors.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import {
  addCommunicationTask,
  closeCommunicationPlan,
  createCommunicationPlan,
  sendCommunication,
} from '../src/modules/incident/icm.js';
import { incidentModule } from '../src/modules/incident/index.js';
import {
  canClose,
  canReopen,
  canResolve,
  closeIncident,
  copyIncident,
  reopenIncident,
  resolveIncident,
} from '../src/modules/incident/lifecycle.js';
import {
  demoteMajorIncident,
  linkToMajorIncident,
  mimGroupId,
  promoteMajorIncident,
  proposeMajorIncident,
  rejectMajorIncident,
} from '../src/modules/incident/mim.js';
import { problemModule } from '../src/modules/problem/index.js';
import { cancelProblem } from '../src/modules/problem/lifecycle.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let sys: Context;
let agent: Context;
let agent2: Context;
let caller: Context;
let other: Context;
let manager: Context;
let ids: Record<string, string>;

const MONDAY = '2026-01-05 09:00:00';
const DAY = 86_400_000;

function boot(extra: AppModule[] = []) {
  p = bootPlatform([incidentModule, problemModule, ...extra]);
  ids = {
    agent: makeUser(p, 'abel.agent', ['itil'], ['Service Desk']),
    agent2: makeUser(p, 'beth.agent', ['itil'], ['Network Operations']),
    caller: makeUser(p, 'carl.caller'),
    other: makeUser(p, 'dina.user'),
    manager: makeUser(p, 'mona.manager', ['itil', 'major_incident_manager']),
    itilAdmin: makeUser(p, 'ivan.admin', ['itil_admin']),
    bot: makeUser(p, 'autoclose.bot', ['itil']),
  };
  sys = p.systemContext();
  agent = p.contextAs('abel.agent');
  agent2 = p.contextAs('beth.agent');
  caller = p.contextAs('carl.caller');
  other = p.contextAs('dina.user');
  manager = p.contextAs('mona.manager');
  ids.serviceDesk = sys.first('sys_user_group', 'name=Service Desk')!.sysId;
  ids.network = sys.first('sys_user_group', 'name=Network Operations')!.sysId;
}

beforeEach(() => boot());

afterEach(() => {
  p?.close();
  clock.reset();
});

/** Fresh read (a new context, so referenced records are not served from a stale cache). */
const reload = (rec: Rec) => p.systemContext().get('incident', rec.sysId)!;
const events = (name: string, rec: Rec) =>
  sys.query('sysevent', { query: `name=${name}^instance=${rec.sysId}` });
const journal = (rec: Rec, field?: string) =>
  p.history.journal('incident', rec.sysId, field ? [field] : undefined).map((j) => j.value);
const newIncident = (values: Record<string, unknown> = {}, ctx: Context = agent) =>
  ctx.insert('incident', {
    short_description: 'Laptop cannot reach the VPN',
    caller_id: ids.caller,
    ...values,
  });
const resolved = (values: Record<string, unknown> = {}) => {
  const inc = newIncident({ assigned_to: ids.agent, ...values });
  resolveIncident(agent, inc, { close_code: 'Solution provided', close_notes: 'Reinstalled the VPN client' });
  return reload(inc);
};

describe('incident basics', () => {
  it('numbers incidents from INC0010001', () => {
    expect(newIncident().str('number')).toBe('INC0010001');
    expect(newIncident().str('number')).toBe('INC0010002');
  });

  it('applies defaults on insert', () => {
    const inc = agent.insert('incident', {});
    expect(inc.str('state')).toBe('1');
    expect(inc.str('incident_state')).toBe('1');
    expect(inc.str('impact')).toBe('3');
    expect(inc.str('urgency')).toBe('3');
    expect(inc.str('priority')).toBe('5');
    expect(inc.str('severity')).toBe('3');
    expect(inc.str('category')).toBe('inquiry');
    expect(inc.str('caller_id')).toBe(ids.agent);
    expect(inc.str('opened_by')).toBe(ids.agent);
    expect(inc.bool('active')).toBe(true);
    expect(inc.num('reopen_count')).toBe(0);
  });

  it('derives priority from impact and urgency on every write', () => {
    const inc = newIncident();
    agent.update(inc, { impact: '1', urgency: '2' });
    expect(reload(inc).str('priority')).toBe('2');
    agent.update(inc, { urgency: '3' });
    expect(reload(inc).str('priority')).toBe('3');
    const matrix: [number, number, number][] = [
      [1, 1, 1],
      [1, 2, 2],
      [1, 3, 3],
      [2, 1, 2],
      [2, 2, 3],
      [2, 3, 4],
      [3, 1, 3],
      [3, 2, 4],
      [3, 3, 5],
    ];
    for (const [impact, urgency, priority] of matrix)
      expect(newIncident({ impact, urgency }).num('priority')).toBe(priority);
    const fixed = newIncident({ impact: 2, urgency: 3 });
    agent.update(fixed, { priority: '1' });
    expect(reload(fixed).str('priority')).toBe('4');
  });

  it('keeps incident_state in sync with state', () => {
    const inc = newIncident();
    agent.update(inc, { state: '2' });
    expect(reload(inc).str('incident_state')).toBe('2');
    agent.update(reload(inc), { incident_state: '3', hold_reason: '4' });
    expect(reload(inc).str('state')).toBe('3');
  });

  it('moves a New incident to In Progress when it is assigned', () => {
    const inc = newIncident();
    agent.update(inc, { assigned_to: ids.agent });
    expect(reload(inc).str('state')).toBe('2');
    p.properties.set('resolvr.incident.assign_moves_to_in_progress', 'false');
    const other = newIncident();
    agent.update(other, { assigned_to: ids.agent });
    expect(reload(other).str('state')).toBe('1');
  });

  it('rejects invalid transitions', () => {
    const inc = newIncident({ state: '2' });
    expect(() => agent.update(inc, { state: '1' })).toThrow('Invalid state transition');
    expect(reload(inc).str('state')).toBe('2');
  });

  it('counts reassignments and clears the assignee when the group changes', () => {
    const inc = newIncident({ assignment_group: ids.serviceDesk, assigned_to: ids.agent });
    agent.update(inc, { assignment_group: ids.network });
    const r = reload(inc);
    expect(r.num('reassignment_count')).toBe(1);
    expect(r.str('assigned_to')).toBe('');
  });

  it('fills the assignment group from the CI support group (CMDB stand-in)', () => {
    p.close();
    boot([
      {
        id: 'test_cmdb',
        name: 'CMDB stand-in',
        dependsOn: ['task'],
        tables: [
          {
            name: 'cmdb_ci',
            label: 'Configuration Item',
            displayField: 'name',
            columns: [
              { name: 'name', label: 'Name', type: 'string' },
              {
                name: 'support_group',
                label: 'Support group',
                type: 'reference',
                reference: 'sys_user_group',
              },
            ],
          },
        ],
      },
    ]);
    const ci = sys.insert('cmdb_ci', { name: 'austin-core-sw-a', support_group: ids.network });
    expect(newIncident({ cmdb_ci: ci.sysId }).str('assignment_group')).toBe(ids.network);
    expect(
      newIncident({ cmdb_ci: ci.sysId, assignment_group: ids.serviceDesk }).str('assignment_group'),
    ).toBe(ids.serviceDesk);
  });

  it('queues assignment, comment and work note events', () => {
    const inc = newIncident();
    agent.update(inc, {
      assigned_to: ids.agent2,
      comments: 'We are on it',
      work_notes: 'Checking gateway logs',
    });
    expect(events('incident.inserted', inc)).toHaveLength(1);
    expect(events('incident.assigned', inc)[0].str('parm1')).toBe(ids.agent2);
    expect(events('incident.commented', inc)).toHaveLength(1);
    expect(events('incident.worknoted', inc)).toHaveLength(1);
    agent.update(reload(inc), { impact: '1', urgency: '1' });
    expect(events('incident.priority.1', inc)).toHaveLength(1);
  });
});

describe('on hold and caller response', () => {
  it('requires a hold reason', () => {
    const inc = newIncident({ state: '2' });
    expect(() => agent.update(inc, { state: '3' })).toThrow('On hold reason is required');
    expect(reload(inc).str('state')).toBe('2');
  });

  it('requires a comment when awaiting the caller and starts the strike cycle', () => {
    const inc = newIncident({ state: '2' });
    expect(() => agent.update(inc, { state: '3', hold_reason: '1' })).toThrow(AbortError);
    agent.update(reload(inc), {
      state: '3',
      hold_reason: '1',
      comments: 'Can you send a screenshot of the error?',
    });
    const strike = sys.first('resolvr_incident_strike', `incident=${inc.sysId}`);
    expect(strike?.num('attempts')).toBe(1);
    expect(events('incident.strike.reminder', inc)).toHaveLength(1);
  });

  it('resumes work when the caller comments', () => {
    const inc = newIncident({ state: '2', assigned_to: ids.agent, watch_list: ids.agent2 });
    agent.update(inc, { state: '3', hold_reason: '1', comments: 'Which floor are you on?' });
    caller.update(caller.get('incident', inc.sysId)!, { comments: 'Third floor, east wing' });
    const r = reload(inc);
    expect(r.str('state')).toBe('2');
    expect(r.str('hold_reason')).toBe('');
    expect(sys.count('resolvr_incident_strike', `incident=${inc.sysId}`)).toBe(0);
    const ev = events('incident.caller.responded', inc);
    expect(ev).toHaveLength(1);
    expect(ev[0].str('parm2').split(',').sort()).toEqual([ids.agent, ids.agent2].sort());
  });

  it('stays on hold when someone else comments', () => {
    const inc = newIncident({ state: '3', hold_reason: '4' });
    agent2.update(inc, { comments: 'Vendor ticket raised' });
    expect(reload(inc).str('state')).toBe('3');
  });

  it('resolves an unresponsive caller after the last reminder', () => {
    clock.freeze(MONDAY);
    const inc = newIncident({ state: '2' });
    agent.update(inc, { state: '3', hold_reason: '1', comments: 'Please confirm the asset tag' });
    for (let day = 1; day <= 3; day++) {
      clock.advance(DAY);
      p.scheduler.runNow('incident.strike_reminders');
    }
    const r = reload(inc);
    expect(events('incident.strike.reminder', inc)).toHaveLength(3);
    expect(r.str('state')).toBe('6');
    expect(r.str('close_code')).toBe('Resolved - No response from caller');
    expect(sys.count('resolvr_incident_strike', `incident=${inc.sysId}`)).toBe(0);
  });

  it('skips weekends between reminders', () => {
    clock.freeze('2026-01-09 09:00:00');
    const inc = newIncident({ state: '2' });
    agent.update(inc, { state: '3', hold_reason: '1', comments: 'Please confirm the asset tag' });
    expect(sys.first('resolvr_incident_strike', `incident=${inc.sysId}`)?.str('next_due')).toBe(
      '2026-01-12 09:00:00',
    );
  });

  it('does nothing when the strike count is 0', () => {
    p.properties.set('com.snc.incident.strike.count', '0');
    const inc = newIncident({ state: '2' });
    agent.update(inc, { state: '3', hold_reason: '1', comments: 'Waiting for you' });
    expect(sys.count('resolvr_incident_strike', `incident=${inc.sysId}`)).toBe(0);
    expect(events('incident.strike.reminder', inc)).toHaveLength(0);
  });
});

describe('resolution, closure and reopening', () => {
  it('requires resolution data', () => {
    const inc = newIncident({ state: '2' });
    expect(() => agent.update(inc, { state: '6' })).toThrow(
      'Resolution code and resolution notes are required',
    );
    expect(reload(inc).str('state')).toBe('2');
  });

  it('records the resolver and resolve time', () => {
    clock.freeze('2026-01-05 10:00:00');
    const inc = newIncident();
    clock.advance(2 * 3_600_000);
    resolveIncident(agent, inc, { close_code: 'Solution provided', close_notes: 'Cleared the DNS cache' });
    const r = reload(inc);
    expect(r.str('state')).toBe('6');
    expect(r.str('resolved_by')).toBe(ids.agent);
    expect(r.str('resolved_at')).toBe('2026-01-05 12:00:00');
    expect(r.num('calendar_stc')).toBe(7200);
    expect(r.num('business_stc')).toBe(7200);
    expect(r.bool('active')).toBe(true);
    expect(events('incident.resolved', inc)).toHaveLength(1);
  });

  it('lets the caller close a resolved incident', () => {
    const inc = resolved();
    expect(canClose(inc, caller)).toBe(true);
    expect(canClose(inc, agent)).toBe(false);
    closeIncident(caller, caller.get('incident', inc.sysId)!);
    const r = reload(inc);
    expect(r.str('state')).toBe('7');
    expect(r.str('incident_state')).toBe('7');
    expect(r.str('closed_by')).toBe(ids.caller);
    expect(r.str('closed_at')).not.toBe('');
    expect(r.bool('active')).toBe(false);
    expect(r.num('calendar_duration')).not.toBeNull();
    expect(() => agent.update(r, { state: '2' })).toThrow(/Insufficient rights|cannot change state/);
    expect(() => sys.update(reload(inc), { state: '2' })).toThrow(
      'Closed or canceled incidents cannot change state',
    );
  });

  it('lets the caller reopen a resolved incident', () => {
    const inc = resolved();
    expect(canReopen(inc, caller)).toBe(true);
    reopenIncident(caller, caller.get('incident', inc.sysId)!, { comments: 'Still broken after a restart' });
    const r = reload(inc);
    expect(r.str('state')).toBe('2');
    expect(r.num('reopen_count')).toBe(1);
    expect(r.str('reopened_by')).toBe(ids.caller);
    expect(r.str('reopened_time')).not.toBe('');
    for (const f of ['resolved_at', 'resolved_by', 'close_code', 'close_notes']) expect(r.str(f)).toBe('');
    expect(events('incident.reopened', inc)).toHaveLength(1);
  });

  it('reopens when the caller comments on a resolved incident', () => {
    const inc = resolved();
    agent.update(reload(inc), { comments: 'Let us know if anything else comes up' });
    expect(reload(inc).str('state')).toBe('6');
    caller.update(caller.get('incident', inc.sysId)!, { comments: 'It is broken again after lunch' });
    const r = reload(inc);
    expect(r.str('state')).toBe('2');
    expect(r.num('reopen_count')).toBe(1);
    expect(r.str('reopened_by')).toBe(ids.caller);
    expect(r.str('close_code')).toBe('');
  });

  it('denies reopening to unrelated self-service users', () => {
    const inc = resolved();
    expect(other.get('incident', inc.sysId)).toBeNull();
    expect(canReopen(inc, other)).toBe(false);
    expect(() => reopenIncident(other, reload(inc))).toThrow(AccessError);
    expect(reload(inc).str('state')).toBe('6');
  });

  it('lets callers resolve their own incident', () => {
    const inc = newIncident();
    const mine = caller.get('incident', inc.sysId)!;
    expect(canResolve(mine, caller)).toBe(true);
    resolveIncident(caller, mine, {});
    const r = reload(inc);
    expect(r.str('state')).toBe('6');
    expect(r.str('close_code')).toBe('Resolved by caller');
  });

  it('cancels incidents and closes their open tasks', () => {
    const inc = newIncident({ state: '2' });
    const open = agent.insert('incident_task', { incident: inc.sysId, short_description: 'Replace dock' });
    const done = agent.insert('incident_task', {
      incident: inc.sysId,
      short_description: 'Check cable',
      state: '3',
    });
    agent.update(inc, { state: '7', close_code: 'Solution provided', close_notes: 'Fixed on the phone' });
    expect(sys.get('incident_task', open.sysId)!.str('state')).toBe('4');
    expect(sys.get('incident_task', done.sysId)!.str('state')).toBe('3');
    const resolvedFields = reload(inc);
    expect(resolvedFields.str('resolved_at')).not.toBe('');
    const second = newIncident({ state: '2' });
    const task = agent.insert('incident_task', {
      incident: second.sysId,
      short_description: 'Swap keyboard',
    });
    agent.update(second, { state: '8' });
    expect(sys.get('incident_task', task.sysId)!.str('state')).toBe('7');
    expect(reload(second).bool('active')).toBe(false);
  });

  it('keeps closed incidents read-only except for the admin field list', () => {
    const inc = newIncident({ state: '2' });
    agent.update(inc, { state: '7', close_code: 'Solution provided', close_notes: 'Done' });
    const admin = p.contextAs('admin');
    const problem = sys.insert('problem', { short_description: 'Recurring VPN drops' });
    admin.update(admin.get('incident', inc.sysId)!, { problem_id: problem.sysId });
    expect(reload(inc).str('problem_id')).toBe(problem.sysId);
    expect(() => admin.update(admin.get('incident', inc.sysId)!, { short_description: 'Changed' })).toThrow(
      'read-only',
    );
  });
});

describe('auto-close', () => {
  const resolvedDaysAgo = (days: number, values: Record<string, unknown> = {}) => {
    clock.freeze(MONDAY);
    clock.advance(-days * DAY);
    const inc = resolved(values);
    clock.freeze(MONDAY);
    return inc;
  };

  it('closes incidents resolved longer than the configured delay', () => {
    p.properties.set('resolvr.incident.autoclose.run_as', 'autoclose.bot');
    const old = resolvedDaysAgo(8);
    const recent = resolvedDaysAgo(6);
    p.scheduler.runNow('incident.autoclose');
    expect(reload(old).str('state')).toBe('7');
    expect(reload(old).str('closed_by')).toBe(ids.bot);
    expect(reload(recent).str('state')).toBe('6');
  });

  it('can count from the last update instead', () => {
    p.properties.set('com.snc.incident.autoclose.basedon.resolved_at', 'false');
    clock.freeze(MONDAY);
    clock.advance(-10 * DAY);
    const inc = resolved();
    clock.advance(8 * DAY);
    agent.update(reload(inc), { work_notes: 'Waiting for the caller to confirm' });
    clock.advance(2 * DAY);
    p.scheduler.runNow('incident.autoclose');
    expect(reload(inc).str('state')).toBe('6');
  });

  it('never auto-closes an accepted major incident', () => {
    clock.freeze(MONDAY);
    clock.advance(-30 * DAY);
    const inc = newIncident({ state: '2' });
    promoteMajorIncident(manager, manager.get('incident', inc.sysId)!, {
      reason: 'Site down',
      business_impact: 'All staff',
    });
    resolveIncident(manager, reload(inc), { close_code: 'Solution provided', close_notes: 'Restored' });
    clock.freeze(MONDAY);
    p.scheduler.runNow('incident.autoclose');
    expect(reload(inc).str('state')).toBe('6');
  });
});

describe('parent and child incidents', () => {
  const family = () => {
    const parent = newIncident({ state: '2', short_description: 'Email delivery delayed for everyone' });
    const a = newIncident({ state: '2', parent_incident: parent.sysId });
    const b = newIncident({ state: '1', parent_incident: parent.sysId });
    return { parent: reload(parent), a, b };
  };

  it('resolves children with the parent and copies the resolution', () => {
    const { parent, a, b } = family();
    expect(parent.num('child_incidents')).toBe(2);
    resolveIncident(agent, parent, {
      close_code: 'Workaround provided',
      close_notes: 'Mail routed through the backup relay',
    });
    for (const child of [a, b]) {
      const r = reload(child);
      expect(r.str('state')).toBe('6');
      expect(r.str('close_code')).toBe('Workaround provided');
      expect(r.str('close_notes')).toBe('Mail routed through the backup relay');
      expect(journal(child).join('\n')).toContain('Mail routed through the backup relay');
      expect(events('incident.commented', child)).toHaveLength(0);
    }
    closeIncident(p.contextAs('admin'), reload(parent));
    expect(reload(a).str('state')).toBe('6');
  });

  it('propagates holds except when awaiting the caller', () => {
    const { parent, a } = family();
    agent.update(parent, { state: '3', hold_reason: '4' });
    expect(reload(a).str('state')).toBe('3');
    expect(reload(a).str('hold_reason')).toBe('4');
    const other = family();
    agent.update(other.parent, { state: '3', hold_reason: '1', comments: 'Please confirm' });
    expect(reload(other.a).str('state')).toBe('2');
  });

  it('reopens resolved children only when an agent reopens the parent', () => {
    const { parent, a } = family();
    resolveIncident(agent, parent, { close_code: 'Solution provided', close_notes: 'Relay restarted' });
    reopenIncident(agent, reload(parent));
    expect(reload(a).str('state')).toBe('2');
    expect(reload(a).num('reopen_count')).toBe(1);

    const callerParent = newIncident({ state: '2' });
    const child = newIncident({ state: '2', parent_incident: callerParent.sysId });
    resolveIncident(agent, reload(callerParent), {
      close_code: 'Solution provided',
      close_notes: 'Relay restarted',
    });
    reopenIncident(caller, caller.get('incident', callerParent.sysId)!);
    expect(reload(callerParent).str('state')).toBe('2');
    expect(reload(child).str('state')).toBe('6');
  });

  it('aligns a newly linked child and prevents loops', () => {
    const parent = newIncident({ state: '2' });
    const child = newIncident({ parent_incident: parent.sysId });
    expect(child.str('state')).toBe('2');
    expect(() => agent.update(reload(parent), { parent_incident: child.sysId })).toThrow(
      'Parent incident would create a loop',
    );
    expect(reload(parent).num('child_incidents')).toBe(1);
    agent.update(reload(child), { parent_incident: '' });
    expect(reload(parent).num('child_incidents')).toBe(0);
  });
});

describe('major incidents', () => {
  it('proposes a candidate and assigns the major incident group', () => {
    const inc = newIncident({ state: '2' });
    proposeMajorIncident(agent, inc, {
      reason: 'Whole floor offline',
      business_impact: '200 users cannot work',
    });
    const r = reload(inc);
    expect(r.str('major_incident_state')).toBe('proposed');
    expect(r.str('proposed_by')).toBe(ids.agent);
    expect(r.str('proposed_on')).not.toBe('');
    expect(r.str('assignment_group')).toBe(mimGroupId(sys));
    expect(r.str('business_impact')).toBe('200 users cannot work');
    expect(journal(inc, 'work_notes')).toContain('Whole floor offline');
  });

  it('promotes with reassignment to the manager and notifies the previous assignees', () => {
    const inc = newIncident({ state: '2', assignment_group: ids.network, assigned_to: ids.agent2 });
    proposeMajorIncident(agent, reload(inc), {
      reason: 'Core switch failure',
      business_impact: 'Austin HQ offline',
    });
    expect(() => promoteMajorIncident(agent, reload(inc), { reason: 'x' })).toThrow(AccessError);
    promoteMajorIncident(manager, manager.get('incident', inc.sysId)!, {
      reason: 'Confirmed outage',
      business_impact: 'Austin HQ offline',
    });
    const r = reload(inc);
    expect(r.str('major_incident_state')).toBe('accepted');
    expect(r.str('promoted_by')).toBe(ids.manager);
    expect(r.str('assignment_group')).toBe(mimGroupId(sys));
    expect(r.str('assigned_to')).toBe(ids.manager);
    const ev = events('incident.mim.reassigned', inc);
    expect(ev).toHaveLength(1);
    expect(ev[0].str('parm1')).toBe(ids.agent2);
    expect(ev[0].str('parm2')).toBe(ids.network);
  });

  it('can create a new major incident from a candidate', () => {
    p.properties.set('sn_major_inc_mgmt.com.snc.incident.mim.major_incident_creation', 'create_new');
    const inc = newIncident({ state: '2', impact: 1, urgency: 1 });
    const mi = promoteMajorIncident(manager, manager.get('incident', inc.sysId)!, {
      reason: 'Many reports',
      business_impact: 'Sales blocked',
    });
    expect(mi.sysId).not.toBe(inc.sysId);
    expect(reload(mi).str('major_incident_state')).toBe('accepted');
    expect(reload(mi).str('priority')).toBe('1');
    expect(reload(inc).str('parent_incident')).toBe(mi.sysId);
    expect(reload(inc).str('major_incident_state')).toBe('');
  });

  it('rejects and demotes', () => {
    const inc = newIncident({ state: '2', assigned_to: ids.agent });
    proposeMajorIncident(agent, reload(inc), { reason: 'Looks big', business_impact: 'Unknown' });
    rejectMajorIncident(manager, manager.get('incident', inc.sysId)!, 'Only one user affected');
    expect(reload(inc).str('major_incident_state')).toBe('rejected');
    expect(reload(inc).str('state')).toBe('2');
    expect(journal(inc, 'work_notes').join()).toContain('Only one user affected');
    expect(events('incident.mim.rejected', inc)).toHaveLength(1);

    promoteMajorIncident(manager, manager.get('incident', inc.sysId)!, {
      reason: 'Spread to all sites',
      business_impact: 'Company wide',
    });
    demoteMajorIncident(manager, manager.get('incident', inc.sysId)!, 'Contained to one site');
    expect(reload(inc).str('major_incident_state')).toBe('canceled');
    expect(reload(inc).str('state')).toBe('2');
  });

  it('links incidents to a major incident', () => {
    const mi = newIncident({ state: '2' });
    promoteMajorIncident(manager, manager.get('incident', mi.sysId)!, {
      reason: 'Outage',
      business_impact: 'All users',
    });
    const inc = newIncident();
    linkToMajorIncident(agent, inc, mi.sysId);
    expect(reload(inc).str('parent_incident')).toBe(mi.sysId);
    expect(reload(inc).str('state')).toBe('2');
  });

  it('runs trigger rules asynchronously', () => {
    const rule = sys.first('major_incident_trigger_rule', 'name=Priority 1 incident')!;
    sys.update(rule, { active: true, order: 100 });
    const inc = newIncident({ impact: 1, urgency: 1 });
    p.drain();
    expect(reload(inc).str('major_incident_state')).toBe('proposed');
    expect(reload(inc).str('trigger_rule')).toBe(rule.sysId);
    const parent = newIncident();
    const child = newIncident({ impact: 1, urgency: 1, parent_incident: parent.sysId });
    p.drain();
    expect(reload(child).str('major_incident_state')).toBe('');
  });

  it('restricts resolve, close and reopen of a major incident to agents and managers', () => {
    const inc = newIncident({ state: '2' });
    promoteMajorIncident(manager, manager.get('incident', inc.sysId)!, {
      reason: 'Outage',
      business_impact: 'All users',
    });
    const mine = caller.get('incident', inc.sysId)!;
    expect(canResolve(mine, caller)).toBe(false);
    expect(() =>
      resolveIncident(caller, mine, { close_code: 'Solution provided', close_notes: 'Works now' }),
    ).toThrow(AbortError);
    resolveIncident(manager, reload(inc), {
      close_code: 'Solution provided',
      close_notes: 'Failover completed',
    });
    expect(canReopen(caller.get('incident', inc.sysId)!, caller)).toBe(false);
    expect(() => reopenIncident(caller, caller.get('incident', inc.sysId)!)).toThrow(AbortError);
    expect(() => closeIncident(caller, caller.get('incident', inc.sysId)!)).toThrow(AbortError);
    expect(() => closeIncident(agent, reload(inc))).toThrow('major incident manager');
    closeIncident(manager, reload(inc));
    expect(reload(inc).str('state')).toBe('7');
  });

  it('cancels the major incident state with the incident', () => {
    const inc = newIncident({ state: '2' });
    proposeMajorIncident(agent, reload(inc), { reason: 'Maybe big', business_impact: 'Unknown' });
    agent.update(reload(inc), { state: '8' });
    expect(reload(inc).str('major_incident_state')).toBe('canceled');
  });
});

describe('communication plans', () => {
  it('closes plans and their tasks with the incident when configured', () => {
    p.properties.set('com.snc.incident.incident_alert.closure', 'true');
    p.properties.set('com.snc.iam.incident_alert_task.closure', 'true');
    const inc = newIncident({ state: '2' });
    const plan = createCommunicationPlan(manager, manager.get('incident', inc.sysId)!);
    expect(plan.str('number')).toMatch(/^ICP/);
    expect(plan.str('assigned_to')).toBe(ids.manager);
    const sent = addCommunicationTask(manager, plan, {
      short_description: 'Hourly update',
      communication_frequency: 'recurring',
    });
    const never = addCommunicationTask(manager, plan, { short_description: 'Exec briefing' });
    expect(sent.str('state')).toBe('1');
    sendCommunication(manager, sys.get('incident_alert_task', sent.sysId)!);
    sendCommunication(manager, sys.get('incident_alert_task', sent.sysId)!);
    agent.update(reload(inc), { state: '7', close_code: 'Solution provided', close_notes: 'Restored' });
    expect(sys.get('incident_alert', plan.sysId)!.str('state')).toBe('3');
    expect(sys.get('incident_alert_task', sent.sysId)!.str('state')).toBe('3');
    expect(sys.get('incident_alert_task', sent.sysId)!.num('times_performed')).toBe(2);
    expect(sys.get('incident_alert_task', never.sysId)!.str('state')).toBe('7');
  });

  it('attaches plans from active definitions', () => {
    const def = sys.first('comm_plan_definition', 'name=Major incident communications')!;
    sys.update(def, { active: true });
    const inc = newIncident({ state: '2' });
    promoteMajorIncident(manager, manager.get('incident', inc.sysId)!, {
      reason: 'Outage',
      business_impact: 'All users',
    });
    const plans = sys.query('incident_alert', { query: `source_incident=${inc.sysId}` });
    expect(plans).toHaveLength(1);
    expect(sys.count('incident_alert_task', `incident_alert=${plans[0].sysId}`)).toBe(3);
    closeCommunicationPlan(manager, plans[0], true);
    expect(sys.get('incident_alert', plans[0].sysId)!.str('state')).toBe('7');
  });
});

describe('access for self-service users', () => {
  it('lets end users create incidents and comment on their own', () => {
    const inc = caller.insert('incident', {
      short_description: 'Printer jams on every page',
      work_notes: undefined,
    });
    expect(inc.str('caller_id')).toBe(ids.caller);
    expect(inc.str('state')).toBe('1');
    caller.update(caller.get('incident', inc.sysId)!, { comments: 'It happens on tray 2 only' });
    expect(journal(inc, 'comments')).toContain('It happens on tray 2 only');
    expect(() => caller.update(caller.get('incident', inc.sysId)!, { work_notes: 'sneaky' })).toThrow(
      'Only agents can add work notes',
    );
    expect(p.acl.canField(caller, 'incident', 'state', 'write', inc)).toBe(false);
    expect(p.acl.canField(caller, 'incident', 'comments', 'write', inc)).toBe(true);
    expect(p.acl.canField(caller, 'incident', 'short_description', 'create', null)).toBe(true);
    expect(p.acl.canField(caller, 'incident', 'assigned_to', 'create', null)).toBe(false);
    expect(other.get('incident', inc.sysId)).toBeNull();
    expect(() => other.update(reload(inc), { comments: 'hi' })).toThrow(AccessError);
  });

  it('only returns incidents the user reported, opened or watches', () => {
    const a = newIncident({ short_description: 'A' });
    const b = newIncident({ short_description: 'B', caller_id: ids.agent2, watch_list: ids.caller });
    const c = caller.insert('incident', { short_description: 'C', caller_id: ids.other });
    newIncident({ short_description: 'D', caller_id: ids.other });
    const seen = caller
      .query('incident')
      .map((r) => r.str('short_description'))
      .sort();
    expect(seen).toEqual(['A', 'B', 'C']);
    expect(caller.count('incident')).toBe(3);
    expect([a, b, c].every((r) => caller.get('incident', r.sysId))).toBe(true);
    expect(agent.query('incident')).toHaveLength(4);
  });
});

describe('copy, tasks and outages', () => {
  it('copies an incident without resolution data or inactive links', () => {
    const problem = sys.insert('problem', { short_description: 'Old problem' });
    const source = newIncident({
      state: '2',
      category: 'network',
      subcategory: 'vpn',
      impact: 2,
      problem_id: problem.sysId,
    });
    cancelProblem(sys, sys.get('problem', problem.sysId)!, 'Not a problem after all');
    agent.update(reload(source), { state: '7', close_code: 'Solution provided', close_notes: 'Done' });
    const copy = copyIncident(agent, reload(source));
    expect(copy.str('category')).toBe('network');
    expect(copy.str('subcategory')).toBe('vpn');
    expect(copy.str('impact')).toBe('2');
    expect(copy.str('problem_id')).toBe('');
    expect(copy.str('close_code')).toBe('');
    expect(copy.str('state')).toBe('1');
    expect(journal(copy, 'work_notes')).toContain(`Created from a similar incident: ${source.str('number')}`);
    const child = copyIncident(agent, newIncident({ state: '2' }), { child: true });
    expect(child.str('parent_incident')).not.toBe('');
  });

  it('creates outages linked to the task', () => {
    const inc = newIncident();
    const outage = agent.insert('cmdb_ci_outage', {
      cmdb_ci: 'a'.repeat(32),
      task_number: inc.sysId,
      begin: '2026-01-05 09:00:00',
      end: '2026-01-05 10:30:00',
    });
    expect(outage.str('number')).toMatch(/^OUT/);
    expect(outage.num('duration')).toBe(90 * 60_000);
    expect(sys.count('task_outage', `task=${inc.sysId}^outage=${outage.sysId}`)).toBe(1);
  });
});

describe('HTTP integration', () => {
  it('serves actions, field restrictions and the query rule through the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolvrnow-incident-'));
    const app = await buildApp(p, {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      dbFile: ':memory:',
      attachmentDir: join(dir, 'att'),
      publicUrl: 'https://resolvrnow.test',
      webDir: null,
      demo: false,
      secureCookies: false,
    });
    const auth = (user: string) => ({
      authorization: `Basic ${Buffer.from(`${user}:Password1!`).toString('base64')}`,
      'content-type': 'application/json',
    });
    const actionIds = async (user: string, id: string) =>
      (
        (
          await app.inject({ method: 'GET', url: `/api/app/record/incident/${id}`, headers: auth(user) })
        ).json().result.actions as { id: string }[]
      ).map((a) => a.id);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/now/table/incident',
        headers: auth('carl.caller'),
        payload: { short_description: 'Monitor flickers', state: '6', assigned_to: ids.agent, urgency: '2' },
      });
      expect(created.statusCode).toBe(201);
      const rec = created.json().result;
      expect(rec.state).toBe('1');
      expect(rec.assigned_to).toBe('');
      expect(rec.caller_id.value).toBe(ids.caller);
      expect(rec.urgency).toBe('2');

      const list = await app.inject({
        method: 'GET',
        url: '/api/now/table/incident',
        headers: auth('dina.user'),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().result).toHaveLength(0);

      const agentActions = await actionIds('abel.agent', rec.sys_id);
      expect(agentActions).toEqual(
        expect.arrayContaining(['incident.resolve', 'incident.propose_major', 'incident.create_problem']),
      );
      expect(agentActions).not.toContain('incident.promote_major');
      const resolve = await app.inject({
        method: 'POST',
        url: `/api/app/action/incident/${rec.sys_id}/incident.resolve`,
        headers: auth('abel.agent'),
        payload: { input: { close_code: 'Solution provided', close_notes: 'Replaced the display cable' } },
      });
      expect(resolve.statusCode).toBe(200);
      expect(await actionIds('carl.caller', rec.sys_id)).toEqual(
        expect.arrayContaining(['incident.reopen', 'incident.close']),
      );

      const invalid = await app.inject({
        method: 'PATCH',
        url: `/api/now/table/incident/${rec.sys_id}`,
        headers: auth('abel.agent'),
        payload: { state: '3' },
      });
      expect(invalid.statusCode).toBe(403);
      expect(invalid.json().error.detail).toBe('Invalid state transition');

      const meta = await app.inject({
        method: 'GET',
        url: '/api/app/meta/incident',
        headers: auth('abel.agent'),
      });
      const related = (meta.json().result.form.relatedLists as { table: string }[]).map((r) => r.table);
      expect(related).toEqual(expect.arrayContaining(['incident_task', 'incident', 'incident_alert']));
      expect(related).not.toContain('task_ci');
      const nav = await app.inject({
        method: 'GET',
        url: '/api/app/navigation',
        headers: auth('abel.agent'),
      });
      const incidentApp = (nav.json().result as { id: string; modules: { title: string }[] }[]).find(
        (a) => a.id === 'incident',
      )!;
      expect(incidentApp.modules.map((m) => m.title)).toEqual(
        expect.arrayContaining([
          'Create New',
          'Assigned to me',
          'Open',
          'Open - Unassigned',
          'Resolved',
          'All',
          'Major Incidents',
        ]),
      );
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo data', () => {
  it('plays about 80 incidents and a dozen problems over the last 60 days', () => {
    p.close();
    p = bootPlatform([incidentModule, problemModule], { demo: true });
    const s = p.systemContext();
    expect(s.count('incident')).toBe(80);
    expect(s.count('incident', 'major_incident_state=accepted')).toBe(2);
    expect(s.count('incident', 'parent_incidentISNOTEMPTY')).toBe(9);
    for (const state of ['1', '2', '3', '6', '7', '8'])
      expect(s.count('incident', `state=${state}`)).toBeGreaterThan(0);
    expect(s.count('incident', 'reopen_count>0')).toBeGreaterThan(0);
    expect(s.count('problem')).toBeGreaterThanOrEqual(12);
    expect(s.count('problem', 'related_incidentsISNOTEMPTY^related_incidents>0')).toBeGreaterThanOrEqual(10);
    const oldest = s.first('incident', null, [{ field: 'opened_at', desc: false }])!.str('opened_at');
    const ageDays = (clock.now().getTime() - Date.parse(`${oldest.replace(' ', 'T')}Z`)) / DAY;
    expect(ageDays).toBeGreaterThan(40);
    expect(ageDays).toBeLessThan(61);
    expect(p.errors).toHaveLength(0);
  });
});
