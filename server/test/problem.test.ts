import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../src/engine/context.js';
import { AbortError, AccessError } from '../src/engine/errors.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import { incidentModule } from '../src/modules/incident/index.js';
import { resolveIncident } from '../src/modules/incident/lifecycle.js';
import { createChangeFromProblem } from '../src/modules/problem/actions.js';
import {
  addIncidentsToProblem,
  communicateFix,
  communicateWorkaround,
  createProblemFromIncident,
} from '../src/modules/problem/incidents.js';
import { problemModule } from '../src/modules/problem/index.js';
import { createKnownErrorArticle, knowledgeAvailable } from '../src/modules/problem/knowledge.js';
import {
  acceptRisk,
  assessProblem,
  assessTask,
  cancelProblem,
  cancelTask,
  completeProblem,
  completeTask,
  confirmProblem,
  fixProblem,
  markDuplicate,
  reanalyzeProblem,
  reassessTask,
  resolveProblem,
  startTaskWork,
} from '../src/modules/problem/lifecycle.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let sys: Context;
let coord: Context;
let manager: Context;
let analyst: Context;
let agent: Context;
let reader: Context;
let caller: Context;
let ids: Record<string, string>;

function boot(extra: AppModule[] = []) {
  p = bootPlatform([incidentModule, problemModule, ...extra]);
  ids = {
    coord: makeUser(p, 'cora.coord', ['problem_coordinator'], ['Problem Management']),
    manager: makeUser(p, 'manny.mgr', ['problem_manager']),
    analyst: makeUser(p, 'ana.analyst', ['problem_task_analyst', 'itil'], ['Database Administration']),
    agent: makeUser(p, 'abel.agent', ['itil'], ['Service Desk']),
    reader: makeUser(p, 'rita.reader', ['sn_problem_read']),
    caller: makeUser(p, 'carl.caller'),
  };
  sys = p.systemContext();
  coord = p.contextAs('cora.coord');
  manager = p.contextAs('manny.mgr');
  analyst = p.contextAs('ana.analyst');
  agent = p.contextAs('abel.agent');
  reader = p.contextAs('rita.reader');
  caller = p.contextAs('carl.caller');
  ids.pm = sys.first('sys_user_group', 'name=Problem Management')!.sysId;
  ids.dba = sys.first('sys_user_group', 'name=Database Administration')!.sysId;
}

beforeEach(() => boot());

afterEach(() => {
  p?.close();
  clock.reset();
});

/** Fresh read (a new context, so referenced records are not served from a stale cache). */
const reload = (rec: Rec) => p.systemContext().get(rec.className, rec.sysId)!;
const events = (name: string, rec: Rec) =>
  sys.query('sysevent', { query: `name=${name}^instance=${rec.sysId}` });
const journal = (rec: Rec, field: string) =>
  p.history.journal(rec.className, rec.sysId, [field]).map((j) => j.value);
const newProblem = (values: Record<string, unknown> = {}) =>
  coord.insert('problem', { short_description: 'Database connections exhausted every Monday', ...values });

/** A problem in Root Cause Analysis owned by the coordinator. */
const inRca = (values: Record<string, unknown> = {}) => {
  const prb = newProblem({ assignment_group: ids.pm, assigned_to: ids.coord, ...values });
  confirmProblem(coord, prb);
  return reload(prb);
};
const inFix = () => {
  const prb = inRca();
  fixProblem(coord, prb, {
    cause_notes: 'Connection pool too small',
    fix_notes: 'Raise the pool to 200 connections',
  });
  return reload(prb);
};
const newIncident = (values: Record<string, unknown> = {}) =>
  agent.insert('incident', {
    short_description: 'Payroll app times out',
    caller_id: ids.caller,
    assigned_to: ids.agent,
    ...values,
  });

describe('problem lifecycle', () => {
  it('numbers and defaults new problems', () => {
    const prb = newProblem();
    expect(prb.str('number')).toBe('PRB0040001');
    expect(prb.str('state')).toBe('101');
    expect(prb.str('problem_state')).toBe('101');
    expect(prb.str('priority')).toBe('5');
    expect(prb.display('prb_model')).toBe('General');
    expect(newProblem().str('number')).toBe('PRB0040002');
  });

  it('starts in Assess when the assignment is filled', () => {
    expect(newProblem({ assignment_group: ids.pm, assigned_to: ids.coord }).str('state')).toBe('102');
  });

  it('assesses only with an assignment', () => {
    const prb = newProblem();
    expect(() => assessProblem(coord, prb)).toThrow(/Assess requires/);
    expect(reload(prb).str('state')).toBe('101');
    assessProblem(coord, reload(prb), { assignment_group: ids.pm, assigned_to: ids.coord });
    expect(reload(prb).str('state')).toBe('102');
    expect(reload(prb).str('problem_state')).toBe('102');
  });

  it('confirms into root cause analysis', () => {
    const prb = inRca();
    expect(prb.str('state')).toBe('103');
    expect(prb.str('confirmed_by')).toBe(ids.coord);
    expect(prb.str('confirmed_at')).not.toBe('');
  });

  it('cancels', () => {
    for (const prb of [newProblem({ assignment_group: ids.pm, assigned_to: ids.coord }), inRca()]) {
      cancelProblem(coord, reload(prb), 'Not reproducible');
      const r = reload(prb);
      expect(r.str('state')).toBe('107');
      expect(r.str('resolution_code')).toBe('canceled');
      expect(r.bool('active')).toBe(false);
    }
  });

  it('fixes, resolves and completes', () => {
    const prb = inRca();
    expect(() => fixProblem(coord, prb, { cause_notes: 'Pool too small' })).toThrow(/Fix requires/);
    fixProblem(coord, reload(prb), { cause_notes: 'Pool too small', fix_notes: 'Raise the pool size' });
    let r = reload(prb);
    expect(r.str('state')).toBe('104');
    expect(r.str('fix_by')).toBe(ids.coord);
    expect(r.str('fix_at')).not.toBe('');
    resolveProblem(coord, r);
    r = reload(prb);
    expect(r.str('state')).toBe('106');
    expect(r.str('resolution_code')).toBe('fix_applied');
    expect(r.str('resolved_by')).toBe(ids.coord);
    expect(r.str('resolved_at')).not.toBe('');
    expect(r.bool('active')).toBe(true);
    completeProblem(coord, r);
    r = reload(prb);
    expect(r.str('state')).toBe('107');
    expect(r.str('resolution_code')).toBe('fix_applied');
    expect(r.str('closed_at')).not.toBe('');
    expect(r.bool('active')).toBe(false);
    expect(events('problem.state.changed', prb).map((e) => e.str('parm2'))).toEqual([
      'confirm',
      'fix',
      'resolve',
      'complete',
    ]);
  });

  it('accepts the risk', () => {
    const closed = inRca();
    acceptRisk(coord, closed, {
      cause_notes: 'Vendor limitation',
      close_notes: 'Cost of the fix outweighs the impact',
    });
    expect(reload(closed).str('state')).toBe('107');
    expect(reload(closed).str('resolution_code')).toBe('risk_accepted');
    p.properties.set('problem.acceptrisk.move_to_closed', 'false');
    const resolved = inFix();
    acceptRisk(coord, resolved, { close_notes: 'Accepted until the next hardware refresh' });
    expect(reload(resolved).str('state')).toBe('106');
    expect(reload(resolved).str('resolution_code')).toBe('risk_accepted');
  });

  it('re-analyzes closed problems with the configured role', () => {
    const prb = inFix();
    resolveProblem(coord, prb);
    completeProblem(coord, reload(prb));
    expect(() => reanalyzeProblem(coord, reload(prb))).toThrow(AccessError);
    reanalyzeProblem(manager, reload(prb));
    const r = reload(prb);
    expect(r.str('state')).toBe('103');
    expect(r.num('reopen_count')).toBe(1);
    expect(r.str('reopened_by')).toBe(ids.manager);
    expect(r.str('reopened_at')).not.toBe('');
    expect(r.str('resolution_code')).toBe('');
    expect(r.bool('active')).toBe(true);
    expect(r.str('closed_at')).toBe('');

    p.properties.set('problem.closed.role.reanalyze_from_canceled', 'problem_coordinator');
    const canceled = inRca();
    cancelProblem(coord, canceled);
    reanalyzeProblem(coord, reload(canceled));
    expect(reload(canceled).str('state')).toBe('103');
  });

  it('rejects direct state changes', () => {
    const prb = newProblem();
    expect(() => coord.update(prb, { state: '104' })).toThrow('Use the problem actions to change state');
    expect(reload(prb).str('state')).toBe('101');
    expect(() => sys.update(reload(prb), { state: '107' })).toThrow(AbortError);
  });

  it('requires a work note when the priority or major problem flag changes', () => {
    const prb = newProblem();
    expect(() => coord.update(prb, { impact: '1' })).toThrow(
      'Work notes are required when the priority changes',
    );
    coord.update(reload(prb), { impact: '1', work_notes: 'Affects every branch office' });
    expect(reload(prb).str('priority')).toBe('3');
    expect(() => coord.update(reload(prb), { major_problem: true })).toThrow(AbortError);
    coord.update(reload(prb), { major_problem: true, work_notes: 'Board-level visibility' });
    expect(reload(prb).bool('major_problem')).toBe(true);
  });

  it('only assigns problems to problem coordinators', () => {
    expect(() => newProblem({ assigned_to: ids.agent })).toThrow(
      'The assignee must be a problem coordinator',
    );
    const prb = newProblem();
    expect(() => coord.update(prb, { assigned_to: ids.analyst })).toThrow(AbortError);
    coord.update(reload(prb), { assigned_to: ids.manager });
    expect(reload(prb).str('assigned_to')).toBe(ids.manager);
  });
});

describe('duplicates', () => {
  it('moves incidents and tasks to the surviving problem', () => {
    const a = inRca({ short_description: 'Survivor' });
    const b = inRca({ short_description: 'Duplicate' });
    const i1 = newIncident({ problem_id: b.sysId });
    const i2 = newIncident({ problem_id: b.sysId });
    const task = coord.insert('problem_task', {
      problem: b.sysId,
      short_description: 'Collect pool metrics',
    });
    expect(reload(b).num('related_incidents')).toBe(2);
    markDuplicate(coord, reload(b), a.sysId);
    const r = reload(b);
    expect(r.str('state')).toBe('107');
    expect(r.str('resolution_code')).toBe('duplicate');
    expect(r.str('duplicate_of')).toBe(a.sysId);
    expect(reload(i1).str('problem_id')).toBe(a.sysId);
    expect(reload(i2).str('problem_id')).toBe(a.sysId);
    expect(reload(task).str('problem')).toBe(a.sysId);
    expect(reload(a).num('related_incidents')).toBe(2);
    expect(reload(b).num('related_incidents')).toBe(0);
    expect(() => reanalyzeProblem(manager, reload(b))).toThrow('Duplicate problems cannot be re-analyzed');
  });

  it('rejects self and chained duplicates', () => {
    const a = inRca();
    expect(() => markDuplicate(coord, a, a.sysId)).toThrow(AbortError);
    const b = inRca();
    const c = inRca();
    markDuplicate(coord, b, c.sysId);
    expect(() => markDuplicate(coord, reload(a), b.sysId)).toThrow('itself a duplicate');
  });
});

describe('problem tasks', () => {
  it('cancels open tasks when the problem closes', () => {
    const prb = inFix();
    const fresh = coord.insert('problem_task', {
      problem: prb.sysId,
      short_description: 'Review pool settings',
    });
    const working = coord.insert('problem_task', {
      problem: prb.sysId,
      short_description: 'Load test',
      assignment_group: ids.dba,
      assigned_to: ids.analyst,
    });
    startTaskWork(analyst, working);
    resolveProblem(coord, reload(prb));
    completeProblem(coord, reload(prb));
    for (const t of [fresh, working]) {
      expect(reload(t).str('state')).toBe('157');
      expect(reload(t).str('close_code')).toBe('canceled');
    }
  });

  it('blocks tasks on closed problems unless allowed', () => {
    const prb = inRca();
    cancelProblem(coord, prb);
    expect(() =>
      coord.insert('problem_task', { problem: prb.sysId, short_description: 'Late task' }),
    ).toThrow('closed problem');
    p.properties.set('problem.closed.can_create_tasks', 'true');
    expect(
      coord.insert('problem_task', { problem: prb.sysId, short_description: 'Late task' }).str('number'),
    ).toMatch(/^PTASK/);
  });

  it('runs the task lifecycle', () => {
    const prb = inRca();
    const task = coord.insert('problem_task', {
      problem: prb.sysId,
      problem_task_type: 'rca',
      short_description: 'Find why the pool is exhausted',
      assignment_group: ids.dba,
      assigned_to: ids.analyst,
    });
    expect(task.str('state')).toBe('152');
    expect(task.display('prb_task_model')).toBe('Root cause analysis');
    startTaskWork(analyst, task);
    expect(reload(task).str('state')).toBe('154');
    reassessTask(analyst, reload(task));
    expect(reload(task).str('state')).toBe('152');
    expect(() => cancelTask(analyst, reload(task), '')).toThrow('reason');
    startTaskWork(analyst, reload(task));
    expect(() => completeTask(analyst, reload(task), { cause_code: 'software_issue' })).toThrow(
      /Complete requires/,
    );
    completeTask(analyst, reload(task), {
      cause_code: 'software_issue',
      fix_notes: 'Release connections in the batch job',
    });
    expect(reload(task).str('state')).toBe('157');
    expect(reload(task).str('close_code')).toBe('complete');
    const allClosed = events('problem_task.all_closed', prb);
    expect(allClosed).toHaveLength(1);
    expect(allClosed[0].str('parm1')).toBe(ids.coord);
    expect(() => coord.update(reload(task), { problem_task_type: 'general' })).toThrow(AbortError);
  });

  it('cancels with a reason and re-assesses closed tasks', () => {
    const prb = inRca();
    const task = coord.insert('problem_task', { problem: prb.sysId, short_description: 'Check firmware' });
    assessTask(coord, task, { assignment_group: ids.dba, assigned_to: ids.analyst });
    cancelTask(analyst, reload(task), 'Firmware is current');
    expect(reload(task).str('state')).toBe('157');
    expect(reload(task).str('close_notes')).toBe('Firmware is current');
    expect(() => reassessTask(analyst, reload(task))).toThrow(AccessError);
    reassessTask(coord, reload(task));
    expect(reload(task).str('state')).toBe('152');
    expect(reload(task).num('reopen_count')).toBe(1);

    cancelTask(coord, reload(task), 'Again');
    cancelProblem(coord, reload(prb));
    expect(() => reassessTask(coord, reload(task))).toThrow(AccessError);
    expect(() => coord.update(reload(task), { state: '154' })).toThrow(
      'Use the problem task actions to change state',
    );
  });
});

describe('incidents and problems', () => {
  it('creates a problem from an incident', () => {
    const inc = newIncident({
      state: '2',
      impact: 2,
      urgency: 1,
      category: 'software',
      cmdb_ci: 'c'.repeat(32),
      description: 'Since the patch',
    });
    const prb = createProblemFromIncident(agent, inc);
    expect(prb.str('short_description')).toBe('Payroll app times out');
    expect(prb.str('description')).toBe('Since the patch');
    expect(prb.str('cmdb_ci')).toBe('c'.repeat(32));
    expect(prb.str('impact')).toBe('2');
    expect(prb.str('urgency')).toBe('1');
    expect(prb.str('category')).toBe('software');
    expect(prb.str('first_reported_by_task')).toBe(inc.sysId);
    const r = reload(inc);
    expect(r.str('problem_id')).toBe(prb.sysId);
    expect(r.str('state')).toBe('3');
    expect(r.str('hold_reason')).toBe('3');
    expect(reload(prb).num('related_incidents')).toBe(1);
    expect(() => createProblemFromIncident(agent, r)).toThrow(AbortError);
  });

  it('communicates the workaround to open incidents', () => {
    const prb = inRca({ workaround: '<p>Restart the <b>payroll</b> service</p>' });
    const working = newIncident({ state: '2', problem_id: prb.sysId });
    const waiting = newIncident({ state: '3', hold_reason: '3', problem_id: prb.sysId });
    const done = newIncident({ problem_id: prb.sysId });
    resolveIncident(agent, done, { close_code: 'Solution provided', close_notes: 'Fixed' });
    expect(communicateWorkaround(coord, reload(prb))).toBe(2);
    for (const inc of [working, waiting]) {
      expect(journal(inc, 'work_notes').join()).toContain('Restart the payroll service');
      expect(journal(inc, 'comments').join()).toContain('Restart the payroll service');
      expect(events('incident.commented', inc)).toHaveLength(0);
      expect(events('incident.problem.workaround', inc)).toHaveLength(1);
    }
    expect(journal(done, 'work_notes')).toHaveLength(0);
    expect(reload(prb).str('workaround_communicated_at')).not.toBe('');
    expect(reload(prb).str('workaround_communicated_by')).toBe(ids.coord);
  });

  it('communicates the fix as a comment or a work note', () => {
    const prb = inFix();
    const inc = newIncident({ state: '2', problem_id: prb.sysId });
    communicateFix(coord, reload(prb));
    expect(journal(inc, 'comments').join()).toContain('Raise the pool to 200 connections');
    const ev = events('incident.problem.fix', inc);
    expect(ev[0].str('parm1').split(',').sort()).toEqual([ids.agent, ids.caller].sort());
    expect(reload(prb).str('fix_communicated_by')).toBe(ids.coord);

    p.properties.set('com.snc.incident.communicate_prb_workaround_to_inc_worknotes', 'true');
    const other = newIncident({ state: '2', problem_id: prb.sysId, short_description: 'Second' });
    communicateFix(coord, reload(prb));
    expect(journal(other, 'work_notes').join()).toContain('Raise the pool to 200 connections');
    expect(journal(other, 'comments')).toHaveLength(0);
  });

  it('resolves incidents waiting on the problem when the fix is applied', () => {
    const prb = inFix();
    const waiting = newIncident({ state: '3', hold_reason: '3', problem_id: prb.sysId });
    const working = newIncident({ state: '2', problem_id: prb.sysId });
    resolveProblem(coord, prb);
    const w = reload(waiting);
    expect(w.str('state')).toBe('6');
    expect(w.str('close_code')).toBe('Resolved by problem');
    expect(w.str('close_notes')).toContain(prb.str('number'));
    expect(journal(waiting, 'comments').join()).toContain('Raise the pool to 200 connections');
    expect(events('incident.problem.resolved', waiting)[0].str('parm1').split(',').sort()).toEqual(
      [ids.agent, ids.caller].sort(),
    );
    expect(reload(working).str('state')).toBe('2');
    const updates = reload(waiting).num('sys_mod_count');
    completeProblem(coord, reload(prb));
    expect(reload(waiting).num('sys_mod_count')).toBe(updates);
  });

  it('informs waiting incidents when the risk is accepted', () => {
    const prb = inRca();
    const waiting = newIncident({ state: '3', hold_reason: '3', problem_id: prb.sysId });
    acceptRisk(coord, prb, { cause_notes: 'Legacy driver', close_notes: 'Replacement planned next quarter' });
    expect(reload(waiting).str('state')).toBe('3');
    expect(journal(waiting, 'work_notes').join()).toContain('Replacement planned next quarter');
    expect(events('incident.problem.risk_accepted', waiting)[0].str('parm1')).toBe(ids.agent);
  });

  it('relates incidents, including closed ones only for the configured role', () => {
    const prb = inRca();
    const open = newIncident({ state: '2' });
    const closed = newIncident({ state: '2' });
    agent.update(closed, { state: '7', close_code: 'Solution provided', close_notes: 'Done' });
    p.properties.set('problem.role.relate_closed_incidents', 'nobody');
    expect(() => addIncidentsToProblem(agent, prb, [closed.sysId])).toThrow(AccessError);
    expect(addIncidentsToProblem(agent, reload(prb), [open.sysId])).toBe(1);
    expect(reload(prb).num('related_incidents')).toBe(1);
    p.properties.set('problem.role.relate_closed_incidents', 'problem_coordinator');
    expect(addIncidentsToProblem(coord, reload(prb), [closed.sysId])).toBe(1);
    expect(reload(prb).num('related_incidents')).toBe(2);
  });
});

describe('problem access', () => {
  it('lets readers read but not change problems, and hides them from end users', () => {
    const prb = newProblem();
    expect(reader.get('problem', prb.sysId)).not.toBeNull();
    expect(() => reader.update(reader.get('problem', prb.sysId)!, { description: 'x' })).toThrow(AccessError);
    expect(() =>
      assessProblem(reader, reader.get('problem', prb.sysId)!, {
        assignment_group: ids.pm,
        assigned_to: ids.coord,
      }),
    ).toThrow(AccessError);
    expect(caller.query('problem')).toHaveLength(0);
    expect(caller.count('problem')).toBe(0);
    expect(caller.get('problem', prb.sysId)).toBeNull();
    expect(agent.query('problem')).toHaveLength(1);
  });
});

/** Minimal stand-ins for the knowledge and change modules, which other teams own. */
const stubModule: AppModule = {
  id: 'test_stubs',
  name: 'Knowledge and change stand-ins',
  dependsOn: ['task'],
  tables: [
    {
      name: 'kb_knowledge_base',
      label: 'Knowledge Base',
      displayField: 'title',
      columns: [{ name: 'title', label: 'Title', type: 'string' }],
    },
    {
      name: 'kb_knowledge',
      label: 'Knowledge',
      displayField: 'number',
      number: { prefix: 'KB', start: 10000 },
      columns: [
        { name: 'number', label: 'Number', type: 'string' },
        { name: 'short_description', label: 'Short description', type: 'string' },
        {
          name: 'kb_knowledge_base',
          label: 'Knowledge base',
          type: 'reference',
          reference: 'kb_knowledge_base',
        },
        { name: 'source', label: 'Source task', type: 'reference', reference: 'task' },
        { name: 'workflow_state', label: 'Workflow', type: 'string', defaultValue: 'draft' },
      ],
    },
    {
      name: 'kb_template_known_error_article',
      label: 'Known Error Article',
      extends: 'kb_knowledge',
      columns: ['kb_description', 'kb_workaround', 'kb_cause'].map((name) => ({
        name,
        label: name,
        type: 'html' as const,
      })),
    },
    {
      name: 'm2m_kb_task',
      label: 'Attached Knowledge',
      columns: [
        { name: 'kb_knowledge', label: 'Article', type: 'reference', reference: 'kb_knowledge' },
        { name: 'task', label: 'Task', type: 'reference', reference: 'task' },
      ],
    },
    {
      name: 'change_request',
      label: 'Change Request',
      extends: 'task',
      number: { prefix: 'CHG', start: 30000 },
      columns: [{ name: 'type', label: 'Type', type: 'string' }],
    },
  ],
  register(platform) {
    platform.services.set('knowledge', {});
  },
  seed(ctx) {
    ctx.insert('kb_knowledge_base', { title: 'Known Error' });
  },
};

describe('known errors and changes (with stand-in modules)', () => {
  beforeEach(() => {
    p.close();
    boot([stubModule]);
  });

  it('creates a Known Error article once', () => {
    expect(knowledgeAvailable(p)).toBe(true);
    const prb = inRca({
      workaround: '<p>Reconnect the client</p>',
      cause_notes: '<p>Expired certificate</p>',
      category: 'software',
    });
    const inc = newIncident({ state: '2', problem_id: prb.sysId });
    const article = createKnownErrorArticle(coord, reload(prb));
    expect(article.className).toBe('kb_template_known_error_article');
    expect(article.str('kb_workaround')).toBe('<p>Reconnect the client</p>');
    expect(article.str('kb_cause')).toBe('<p>Expired certificate</p>');
    expect(article.display('kb_knowledge_base')).toBe('Known Error');
    expect(article.str('source')).toBe(prb.sysId);
    const r = reload(prb);
    expect(r.str('primary_known_error_article')).toBe(article.sysId);
    expect(r.bool('known_error')).toBe(true);
    expect(sys.count('m2m_kb_task', `task=${prb.sysId}^kb_knowledge=${article.sysId}`)).toBe(1);
    expect(journal(inc, 'work_notes').join()).toContain(article.str('number'));
    expect(() => createKnownErrorArticle(coord, r)).toThrow(AbortError);
  });

  it('links an incident to the problem behind an attached Known Error article', () => {
    const prb = inRca();
    const article = createKnownErrorArticle(coord, prb);
    const inc = newIncident({ state: '2' });
    sys.insert('m2m_kb_task', { kb_knowledge: article.sysId, task: inc.sysId });
    expect(reload(inc).str('problem_id')).toBe(prb.sysId);
    resolveIncident(agent, reload(inc), {
      close_code: 'Known error',
      close_notes: 'Applied the documented workaround',
    });
    expect(reload(inc).str('state')).toBe('6');
    const other = newIncident({ state: '2' });
    expect(() => resolveIncident(agent, other, { close_code: 'Known error', close_notes: 'x' })).toThrow(
      'known error article',
    );
  });

  it('creates a fix change and reports when every fix is done', () => {
    const prb = inRca();
    const change = createChangeFromProblem(coord, prb, 'normal');
    expect(change.str('parent')).toBe(prb.sysId);
    expect(change.str('type')).toBe('normal');
    expect(reload(prb).str('rfc')).toBe(change.sysId);
    sys.update(sys.get('change_request', change.sysId)!, { state: '3' });
    const ev = events('problem.fix_records.completed', prb);
    expect(ev).toHaveLength(1);
    expect(ev[0].str('parm1')).toBe(ids.coord);
  });
});
