import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import {
  type ApprovalEngine,
  approvalsModule,
  emailDecision,
  evaluateUnit,
  requiredApprovals,
  rollupStates,
} from '../src/modules/approvals/index.js';
import { flowModule } from '../src/modules/flow/index.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let app: FastifyInstance | null = null;
let dir: string | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
  p?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  clock.reset();
});

async function server(): Promise<FastifyInstance> {
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-approvals-'));
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbFile: ':memory:',
    attachmentDir: join(dir, 'att'),
    publicUrl: 'https://resolvrnow.test',
    webDir: null,
    demo: false,
    secureCookies: false,
  };
  app = await buildApp(p, config);
  return app;
}
const auth = (u: string) => ({ authorization: `Basic ${Buffer.from(`${u}:Password1!`).toString('base64')}` });
const json = (u: string) => ({ ...auth(u), 'content-type': 'application/json' });

function boot(): { ctx: Context; engine: ApprovalEngine } {
  p = bootPlatform([approvalsModule, flowModule]);
  return { ctx: p.systemContext(), engine: p.service<ApprovalEngine>('approvals') };
}

const states = (rows: Rec[]) => rows.map((r) => r.str('state'));
const reload = (ctx: Context, r: Rec) => ctx.get(r.className, r.sysId)!;
const rowsOf = (ctx: Context, task: Rec) =>
  ctx.query('sysapproval_approver', {
    query: `document_id=${task.sysId}`,
    orderBy: [{ field: 'sys_created_on', desc: false }],
  });
const events = (ctx: Context, name: string) => ctx.count('sysevent', `name=${name}`);

describe('approval rules (pure)', () => {
  const r = (...s: string[]) => s.map((state, i) => ({ state, decidedOn: `2026-01-01 00:00:0${i}` }));

  it('first response decides on the earliest answer', () => {
    expect(evaluateUnit('first_response', null, r('requested', 'rejected', 'requested'))).toBe('rejected');
    expect(evaluateUnit('first_response', null, r('requested', 'requested'))).toBe('pending');
    expect(
      evaluateUnit('first_response', null, [
        { state: 'approved', decidedOn: '2026-01-01 00:00:05' },
        { state: 'rejected', decidedOn: '2026-01-01 00:00:01' },
      ]),
    ).toBe('rejected');
  });

  it('any approves on one approval and rejects once everyone said no', () => {
    expect(evaluateUnit('any', null, r('rejected', 'requested'))).toBe('pending');
    expect(evaluateUnit('any', null, r('rejected', 'approved'))).toBe('approved');
    expect(evaluateUnit('any', null, r('rejected', 'rejected'))).toBe('rejected');
  });

  it('all rejects on the first rejection and needs every approval', () => {
    expect(evaluateUnit('all', null, r('approved', 'approved', 'requested'))).toBe('pending');
    expect(evaluateUnit('all', null, r('approved', 'approved', 'rejected'))).toBe('rejected');
    expect(evaluateUnit('all', null, r('approved', 'approved'))).toBe('approved');
  });

  it('percentage rounds half up and fails when the threshold is out of reach', () => {
    expect(requiredApprovals(5, 50)).toBe(3);
    expect(requiredApprovals(4, 50)).toBe(2);
    expect(requiredApprovals(10, 24.9)).toBe(2);
    expect(requiredApprovals(4, 100)).toBe(4);
    expect(requiredApprovals(4, 0)).toBeNull();
    expect(evaluateUnit('percentage', 50, r('rejected', 'rejected', 'rejected', 'requested'))).toBe(
      'rejected',
    );
    expect(evaluateUnit('percentage', 50, r('rejected', 'rejected', 'requested', 'requested'))).toBe(
      'pending',
    );
    expect(evaluateUnit('percentage', 0, r('requested', 'approved'))).toBe('approved');
    expect(evaluateUnit('percentage', 100, r('approved', 'approved', 'requested'))).toBe('pending');
  });

  it('ignores cancelled and duplicate rows and reports empty units', () => {
    expect(evaluateUnit('all', null, r('approved', 'cancelled', 'duplicate'))).toBe('approved');
    expect(evaluateUnit('any', null, r('cancelled'))).toBe('empty');
  });

  it('rolls step states up with the classic algorithm', () => {
    expect(rollupStates([])).toBe('not requested');
    expect(rollupStates(['approved', 'requested'])).toBe('requested');
    expect(rollupStates(['approved', 'rejected', 'requested'])).toBe('rejected');
    expect(rollupStates(['approved', 'approved'])).toBe('approved');
    expect(rollupStates(['not requested', 'not requested'])).toBe('not requested');
    expect(rollupStates(['approved', 'not requested'])).toBe('requested');
    expect(rollupStates(['approved', 'not_required'])).toBe('approved');
    expect(rollupStates(['cancelled'])).toBe('cancelled');
  });

  it('reads approve or reject from an email reply', () => {
    expect(emailDecision('Re:CHG0030001 - approve', 'Looks fine to me')).toBe('approved');
    expect(emailDecision('Re:CHG0030001 - reject', '')).toBe('rejected');
    expect(emailDecision('Re: change', 'please see state:rejected below')).toBe('rejected');
    expect(emailDecision('Re: change', 'Yes, go ahead')).toBe('approved');
    expect(emailDecision('Re: change', 'No.')).toBe('rejected');
    expect(emailDecision('Re: change', 'What is this?')).toBeNull();
  });
});

describe('approval requests on records', () => {
  it('any: a rejection waits, an approval approves and rolls up to the task', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'ann.approver', ['itil']);
    const b = makeUser(p, 'ben.approver', ['itil']);
    const task = ctx.insert('task', { short_description: 'New laptop' });
    const decisions: string[] = [];
    engine.onDecision('task', (t, d) => decisions.push(`${t.str('number')}:${d}`));
    const rows = engine.request(ctx, task, { users: [a, b], rule: 'any' });
    expect(states(rows)).toEqual(['requested', 'requested']);
    expect(reload(ctx, task).str('approval')).toBe('requested');
    expect(engine.stateOf(ctx, task)).toBe('requested');

    engine.decide(p.contextAs('ann.approver'), rows[0], 'rejected', 'Too expensive');
    expect(reload(ctx, task).str('approval')).toBe('requested');
    engine.decide(p.contextAs('ben.approver'), rows[1], 'approved');
    const t = reload(ctx, task);
    expect(t.str('approval')).toBe('approved');
    expect(t.str('approval_set')).not.toBe('');
    expect(engine.stateOf(ctx, task)).toBe('approved');
    expect(decisions).toEqual([`${task.str('number')}:approved`]);
    const decided = rowsOf(ctx, task);
    expect(decided[1].str('resolvr_decided_by')).toBe(b);
    expect(decided[1].str('resolvr_decided_on')).not.toBe('');
  });

  it('all: approvals then one rejection rejects the step', () => {
    const { ctx, engine } = boot();
    const ids = ['a1.user', 'a2.user', 'a3.user'].map((u) => makeUser(p, u));
    const task = ctx.insert('task', { short_description: 'Firewall change' });
    const rows = engine.request(ctx, task, { users: ids, rule: 'all' });
    engine.decide(p.contextAs('a1.user'), rows[0], 'approved');
    engine.decide(p.contextAs('a2.user'), rows[1], 'approved');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    engine.decide(p.contextAs('a3.user'), rows[2], 'rejected', 'Not this week');
    expect(engine.stateOf(ctx, task)).toBe('rejected');
    expect(reload(ctx, task).str('approval')).toBe('rejected');
  });

  it('first response: the first answer decides and the others are no longer required', () => {
    const { ctx, engine } = boot();
    const ids = ['f1.user', 'f2.user', 'f3.user'].map((u) => makeUser(p, u));
    const task = ctx.insert('task', { short_description: 'Access request' });
    const rows = engine.request(ctx, task, { users: ids, rule: 'first' });
    engine.decide(p.contextAs('f2.user'), rows[1], 'rejected', 'No');
    expect(states(rowsOf(ctx, task))).toEqual(['not_required', 'rejected', 'not_required']);
    expect(reload(ctx, task).str('approval')).toBe('rejected');
    expect(events(ctx, 'approval.rejected.by.other')).toBe(2);
  });

  it('percentage: 50 % of five needs three approvals', () => {
    const { ctx, engine } = boot();
    const names = ['p1.user', 'p2.user', 'p3.user', 'p4.user', 'p5.user'];
    const ids = names.map((u) => makeUser(p, u));
    const task = ctx.insert('task', { short_description: 'Budget' });
    const rows = engine.request(ctx, task, { users: ids, rule: 'percentage', percentage: 50 });
    engine.decide(p.contextAs(names[0]), rows[0], 'approved');
    engine.decide(p.contextAs(names[1]), rows[1], 'approved');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    engine.decide(p.contextAs(names[2]), rows[2], 'approved');
    expect(engine.stateOf(ctx, task)).toBe('approved');
    expect(states(rowsOf(ctx, task))).toEqual([
      'approved',
      'approved',
      'approved',
      'not_required',
      'not_required',
    ]);
  });

  it('percentage: rejected once the threshold cannot be reached', () => {
    const { ctx, engine } = boot();
    const names = ['q1.user', 'q2.user', 'q3.user', 'q4.user'];
    const ids = names.map((u) => makeUser(p, u));
    const task = ctx.insert('task', { short_description: 'Budget' });
    const rows = engine.request(ctx, task, { users: ids, rule: 'percentage', percentage: 50 });
    engine.decide(p.contextAs(names[0]), rows[0], 'rejected', 'no');
    engine.decide(p.contextAs(names[1]), rows[1], 'rejected', 'no');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    engine.decide(p.contextAs(names[2]), rows[2], 'rejected', 'no');
    expect(engine.stateOf(ctx, task)).toBe('rejected');
  });

  it('group approval: one group row, member approvals, first response decides', () => {
    const { ctx, engine } = boot();
    for (const u of ['cab.one', 'cab.two', 'cab.three']) makeUser(p, u, [], ['CAB']);
    const group = ctx.getBy('sys_user_group', 'name', 'CAB')!;
    const task = ctx.insert('task', { short_description: 'Datacenter move' });
    const rows = engine.request(ctx, task, { groups: [group.sysId] });
    expect(rows).toHaveLength(3);
    const groupRows = ctx.query('sysapproval_group', { query: `parent=${task.sysId}` });
    expect(groupRows).toHaveLength(1);
    expect(groupRows[0].str('approval')).toBe('requested');
    expect(groupRows[0].str('resolvr_wait_for')).toBe('first_response');
    expect(rows.every((r) => r.str('group') === groupRows[0].sysId)).toBe(true);

    const mine = rows.find((r) => r.display('approver') === 'cab two')!;
    engine.decide(p.contextAs('cab.two'), mine, 'approved');
    expect(reload(ctx, groupRows[0]).str('approval')).toBe('approved');
    expect(reload(ctx, groupRows[0]).bool('active')).toBe(false);
    expect(reload(ctx, task).str('approval')).toBe('approved');
    expect(states(rowsOf(ctx, task)).sort()).toEqual(['approved', 'not_required', 'not_required']);
  });

  it('a step with users and groups needs every unit to approve', () => {
    const { ctx, engine } = boot();
    makeUser(p, 'g.one', [], ['Network']);
    makeUser(p, 'g.two', [], ['Network']);
    const mgr = makeUser(p, 'the.manager');
    const task = ctx.insert('task', { short_description: 'Router upgrade' });
    const rows = engine.request(ctx, task, { users: [mgr], groups: ['Network'], groupRule: 'all' });
    expect(rows).toHaveLength(3);
    engine.decide(p.contextAs('the.manager'), rows.find((r) => r.str('approver') === mgr)!, 'approved');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    const members = rows.filter((r) => r.str('group'));
    engine.decide(p.contextAs('g.one'), members[0], 'approved');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    engine.decide(p.contextAs('g.two'), members[1], 'approved');
    expect(engine.stateOf(ctx, task)).toBe('approved');
  });

  it('sequential approvers are asked one after the other', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 's1.user');
    const b = makeUser(p, 's2.user');
    const task = ctx.insert('task', { short_description: 'Contract' });
    const rows = engine.request(ctx, task, { users: [a, b], rule: 'all', sequential: true });
    expect(states(rows)).toEqual(['requested', 'not requested']);
    engine.decide(p.contextAs('s1.user'), rows[0], 'approved');
    expect(states(rowsOf(ctx, task))).toEqual(['approved', 'requested']);
    engine.decide(p.contextAs('s2.user'), reload(ctx, rows[1]), 'approved');
    expect(engine.stateOf(ctx, task)).toBe('approved');
  });

  it('an empty request is approved immediately', () => {
    const { ctx, engine } = boot();
    const task = ctx.insert('task', { short_description: 'Nobody to ask' });
    const res = engine.requestStep(ctx, task, { users: [] });
    expect(res.state).toBe('approved');
    expect(reload(ctx, task).str('approval')).toBe('approved');
  });
});

describe('classic approvals (approvers added by hand)', () => {
  it('start not requested, request queues approval.inserted, all must approve', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'm1.user', ['itil']);
    const b = makeUser(p, 'm2.user', ['itil']);
    const task = ctx.insert('task', { short_description: 'Manual approvals' });
    const ra = ctx.insert('sysapproval_approver', { approver: a, sysapproval: task.sysId });
    const rb = ctx.insert('sysapproval_approver', { approver: b, sysapproval: task.sysId });
    expect(ra.str('state')).toBe('not requested');
    expect(ra.str('document_id')).toBe(task.sysId);
    expect(ra.str('source_table')).toBe('task');
    expect(reload(ctx, task).str('approval')).toBe('not requested');
    expect(events(ctx, 'approval.inserted')).toBe(0);

    ctx.update(reload(ctx, ra), { state: 'requested' });
    expect(events(ctx, 'approval.inserted')).toBe(1);
    expect(ctx.first('sysevent', 'name=approval.inserted')!.str('parm1')).toBe(a);
    expect(reload(ctx, task).str('approval')).toBe('requested');
    ctx.update(reload(ctx, rb), { state: 'requested' });

    engine.decide(p.contextAs('m1.user'), ra, 'approved');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    engine.decide(p.contextAs('m2.user'), rb, 'approved');
    expect(reload(ctx, task).str('approval')).toBe('approved');
    expect(reload(ctx, task).str('approval_set')).not.toBe('');
    expect(events(ctx, 'approval.approved')).toBe(2);
  });

  it('one rejection rejects immediately and the other approval is no longer required', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'r1.user');
    const b = makeUser(p, 'r2.user');
    const task = ctx.insert('task', { short_description: 'Two approvers' });
    for (const u of [a, b])
      ctx.insert('sysapproval_approver', { approver: u, sysapproval: task.sysId, state: 'requested' });
    const [ra] = rowsOf(ctx, task);
    engine.decide(p.contextAs('r1.user'), ra, 'rejected', 'No budget');
    expect(states(rowsOf(ctx, task))).toEqual(['rejected', 'not_required']);
    expect(reload(ctx, task).str('approval')).toBe('rejected');
    expect(events(ctx, 'approval.rejected')).toBe(1);
  });

  it('cancelled rows are ignored by the roll-up', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'c1.user');
    const b = makeUser(p, 'c2.user');
    const task = ctx.insert('task', { short_description: 'One cancelled' });
    const ra = ctx.insert('sysapproval_approver', {
      approver: a,
      sysapproval: task.sysId,
      state: 'requested',
    });
    const rb = ctx.insert('sysapproval_approver', {
      approver: b,
      sysapproval: task.sysId,
      state: 'requested',
    });
    ctx.update(reload(ctx, rb), { state: 'cancelled' });
    engine.decide(p.contextAs('c1.user'), ra, 'approved');
    expect(reload(ctx, task).str('approval')).toBe('approved');
  });

  it('a second approval for the same approver and round is a duplicate and sends nothing', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'd1.user');
    const task = ctx.insert('task', { short_description: 'Dup' });
    engine.request(ctx, task, { users: [a] });
    const before = events(ctx, 'approval.inserted');
    const dup = ctx.insert('sysapproval_approver', {
      approver: a,
      sysapproval: task.sysId,
      state: 'requested',
    });
    expect(dup.str('state')).toBe('duplicate');
    expect(events(ctx, 'approval.inserted')).toBe(before);
    engine.decide(p.contextAs('d1.user'), rowsOf(ctx, task)[0], 'approved');
    expect(reload(ctx, task).str('approval')).toBe('approved');
  });

  it('a new request after a decision starts a new round', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'it1.user');
    const task = ctx.insert('task', { short_description: 'Resubmitted' });
    const [first] = engine.request(ctx, task, { users: [a] });
    engine.decide(p.contextAs('it1.user'), first, 'rejected', 'Fix the cost');
    expect(engine.stateOf(ctx, task)).toBe('rejected');
    ctx.update(reload(ctx, task), { state: 1 });
    const [second] = engine.request(ctx, reload(ctx, task), { users: [a] });
    expect(second.num('iteration')).toBe(1);
    expect(second.str('state')).toBe('requested');
    expect(reload(ctx, task).str('approval')).toBe('requested');
    engine.decide(p.contextAs('it1.user'), second, 'approved');
    expect(reload(ctx, task).str('approval')).toBe('approved');
  });
});

describe('decision effects', () => {
  it('writes the decision and comment to approval_history', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'hist.approver');
    const task = ctx.insert('task', { short_description: 'History' });
    const [row] = engine.request(ctx, task, { users: [a] });
    engine.decide(p.contextAs('hist.approver'), row, 'approved', 'ok');
    const entries = p.history.journal('task', task.sysId, ['approval_history']);
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe(`hist approver approved ${task.str('number')}\nok`);
    expect(entries[0].sys_created_by).toBe('hist.approver');
  });

  it('rejection with upon_reject=cancel cancels other pending approvals and calls the module handler', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'rej.one');
    const b = makeUser(p, 'rej.two');
    const handled: string[] = [];
    engine.onDecision('task', (t, d) => handled.push(`${t.str('number')}:${d}:${engine.stateOf(ctx, t)}`));
    const task = ctx.insert('task', { short_description: 'Reject me' });
    const [ra] = engine.request(ctx, task, { users: [a], stage: 'Manager' });
    engine.request(ctx, task, { users: [b], stage: 'Finance' });
    engine.decide(p.contextAs('rej.one'), ra, 'rejected', 'No');
    expect(states(rowsOf(ctx, task))).toEqual(['rejected', 'cancelled']);
    expect(handled).toEqual([`${task.str('number')}:rejected:rejected`]);
    expect(events(ctx, 'approval.cancelled')).toBe(1);
    expect(reload(ctx, task).bool('active')).toBe(true);
  });

  it('without a handler a rejected task is closed incomplete', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'close.me');
    const task = ctx.insert('task', { short_description: 'Close on reject' });
    const [ra] = engine.request(ctx, task, { users: [a] });
    engine.decide(p.contextAs('close.me'), ra, 'rejected', 'No');
    const t = reload(ctx, task);
    expect(t.str('state')).toBe('4');
    expect(t.bool('active')).toBe(false);
  });

  it('cancel() withdraws pending approvals; closing the record does the same', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'can.one');
    const b = makeUser(p, 'can.two');
    for (const u of ['g.m1', 'g.m2']) makeUser(p, u, [], ['Reviewers']);
    const task = ctx.insert('task', { short_description: 'Withdrawn' });
    engine.request(ctx, task, { users: [a], groups: ['Reviewers'] });
    engine.cancel(ctx, task, 'Request withdrawn');
    expect(states(rowsOf(ctx, task))).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(engine.stateOf(ctx, task)).toBe('cancelled');
    expect(reload(ctx, task).str('approval')).toBe('cancelled');
    expect(ctx.first('sysapproval_group', `parent=${task.sysId}`)!.str('approval')).toBe('cancelled');
    expect(p.history.journal('task', task.sysId, ['approval_history'])[0].value).toContain(
      'Request withdrawn',
    );

    const other = ctx.insert('task', { short_description: 'Closed while pending' });
    engine.request(ctx, other, { users: [b] });
    ctx.update(reload(ctx, other), { state: 3 });
    expect(states(rowsOf(ctx, other))).toEqual(['cancelled']);
  });

  it('due dates apply the "when due" outcome', () => {
    const { ctx, engine } = boot();
    clock.freeze('2026-01-05 09:00:00');
    const a = makeUser(p, 'slow.approver');
    const task = ctx.insert('task', { short_description: 'Timeout' });
    engine.onDecision('task', () => {});
    engine.request(ctx, task, { users: [a], due: '2026-01-06 09:00:00', onDue: 'approve' });
    p.scheduler.runNow('approvals.due');
    expect(engine.stateOf(ctx, task)).toBe('requested');
    clock.advance(86_400_000);
    p.scheduler.runNow('approvals.due');
    expect(engine.stateOf(ctx, task)).toBe('approved');
    expect(states(rowsOf(ctx, task))).toEqual(['not_required']);
  });

  it('an approval administrator can change a decided approval and the roll-up follows', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'first.decider');
    makeUser(p, 'appr.admin', ['approval_admin']);
    const decisions: string[] = [];
    engine.onDecision('task', (_t, d) => decisions.push(d));
    const task = ctx.insert('task', { short_description: 'Changed answer' });
    const [row] = engine.request(ctx, task, { users: [a] });
    engine.decide(p.contextAs('first.decider'), row, 'approved');
    expect(() => engine.decide(p.contextAs('first.decider'), row, 'rejected', 'oops')).toThrow(
      /already been decided/,
    );
    engine.decide(p.contextAs('appr.admin'), row, 'rejected', 'Policy breach');
    expect(engine.stateOf(ctx, task)).toBe('rejected');
    expect(decisions).toEqual(['approved', 'rejected']);
  });
});

describe('delegation and access', () => {
  function setup() {
    const env = boot();
    const u = makeUser(p, 'una.boss', ['itil']);
    const d = makeUser(p, 'dan.delegate', ['itil']);
    makeUser(p, 'ivy.itil', ['itil']);
    makeUser(p, 'ada.admin', ['approval_admin', 'itil']);
    const task = env.ctx.insert('task', { short_description: 'Delegated approval' });
    const [row] = env.engine.request(env.ctx, task, { users: [u] });
    return { ...env, u, d, task, row };
  }

  it('an active delegate approves through the Table API; the approver stays and the journal says on behalf of', async () => {
    const { ctx, u, d, task, row } = setup();
    clock.freeze('2026-03-01 12:00:00');
    ctx.insert('sys_user_delegate', {
      user: u,
      delegate: d,
      starts: '2026-03-01 00:00:00',
      ends: '2026-03-31 00:00:00',
      approvals: true,
    });
    const api = await server();
    const res = await api.inject({
      method: 'PATCH',
      url: `/api/now/table/sysapproval_approver/${row.sysId}`,
      headers: json('dan.delegate'),
      payload: { state: 'approved', comments: 'Covering for Una' },
    });
    expect(res.statusCode).toBe(200);
    const fresh = reload(ctx, row);
    expect(fresh.str('state')).toBe('approved');
    expect(fresh.str('approver')).toBe(u);
    expect(fresh.str('resolvr_decided_by')).toBe(d);
    const history = p.history.journal('task', task.sysId, ['approval_history'])[0].value;
    expect(history).toContain('dan delegate on behalf of una boss approved');
    expect(ctx.count('sys_audit', `documentkey=${row.sysId}^fieldname=state^reason=delegate`)).toBe(1);
  });

  it('a delegate outside the window, or a plain itil user, gets 403; approval_admin may override', async () => {
    const { ctx, engine, u, d, row } = setup();
    clock.freeze('2026-04-15 12:00:00');
    ctx.insert('sys_user_delegate', {
      user: u,
      delegate: d,
      starts: '2026-03-01 00:00:00',
      ends: '2026-03-31 00:00:00',
      approvals: true,
    });
    const api = await server();
    const late = await api.inject({
      method: 'PATCH',
      url: `/api/now/table/sysapproval_approver/${row.sysId}`,
      headers: json('dan.delegate'),
      payload: { state: 'approved' },
    });
    expect(late.statusCode).toBe(403);
    const stranger = await api.inject({
      method: 'PATCH',
      url: `/api/now/table/sysapproval_approver/${row.sysId}`,
      headers: json('ivy.itil'),
      payload: { state: 'approved' },
    });
    expect(stranger.statusCode).toBe(403);
    expect(reload(ctx, row).str('state')).toBe('requested');
    expect(engine.canDecide(p.contextAs('ivy.itil'), row)).toBe(false);
    const admin = await api.inject({
      method: 'PATCH',
      url: `/api/now/table/sysapproval_approver/${row.sysId}`,
      headers: json('ada.admin'),
      payload: { state: 'approved' },
    });
    expect(admin.statusCode).toBe(200);
    expect(reload(ctx, row).str('state')).toBe('approved');
  });

  it('refuses self delegation and inverted date ranges', () => {
    const { ctx, u, d } = setup();
    expect(() => ctx.insert('sys_user_delegate', { user: u, delegate: u })).toThrow(
      /cannot delegate to themselves/,
    );
    expect(() =>
      ctx.insert('sys_user_delegate', {
        user: u,
        delegate: d,
        starts: '2026-05-01 00:00:00',
        ends: '2026-04-01 00:00:00',
      }),
    ).toThrow(/end date/);
  });
});

describe('approvals REST API', () => {
  it('lists my pending approvals including delegated ones, with a summary of the record', async () => {
    const { ctx, engine } = boot();
    const me = makeUser(p, 'me.approver');
    const boss = makeUser(p, 'boss.away');
    const task = ctx.insert('task', { short_description: 'Laptop for Sam', priority: 2 });
    const other = ctx.insert('task', { short_description: 'Monitor for Kim' });
    engine.request(ctx, task, { users: [me], stage: 'Manager approval' });
    engine.request(ctx, other, { users: [boss] });
    ctx.insert('sys_user_delegate', { user: boss, delegate: me, approvals: true });
    const api = await server();
    const res = await api.inject({
      method: 'GET',
      url: '/api/app/approvals/mine',
      headers: auth('me.approver'),
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as Record<string, any>[];
    expect(result).toHaveLength(2);
    const own = result.find((r) => !r.delegated)!;
    expect(own.stage).toBe('Manager approval');
    expect(own.record).toMatchObject({
      table: 'task',
      sys_id: task.sysId,
      display_value: task.str('number'),
    });
    expect(own.record.fields.short_description.value).toBe('Laptop for Sam');
    expect(own.record.fields.priority).toEqual({ value: '2', display_value: '2 - High' });
    const delegated = result.find((r) => r.delegated)!;
    expect(delegated.approver.value).toBe(boss);
    expect(delegated.record.fields.short_description.value).toBe('Monitor for Kim');
  });

  it('approves and rejects with comments; rejecting needs a comment; decided approvals conflict', async () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'api.approver');
    makeUser(p, 'api.stranger');
    const t1 = ctx.insert('task', { short_description: 'Approve me' });
    const t2 = ctx.insert('task', { short_description: 'Reject me' });
    const [r1] = engine.request(ctx, t1, { users: [a] });
    const [r2] = engine.request(ctx, t2, { users: [a] });
    const api = await server();

    const ok = await api.inject({
      method: 'POST',
      url: `/api/app/approvals/${r1.sysId}/approve`,
      headers: json('api.approver'),
      payload: { comments: 'Go ahead' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.state.value).toBe('approved');
    expect(reload(ctx, t1).str('approval')).toBe('approved');
    expect(p.history.journal('sysapproval_approver', r1.sysId, ['comments'])[0].value).toBe('Go ahead');

    const noComment = await api.inject({
      method: 'POST',
      url: `/api/app/approvals/${r2.sysId}/reject`,
      headers: json('api.approver'),
      payload: {},
    });
    expect(noComment.statusCode).toBe(400);
    const stranger = await api.inject({
      method: 'POST',
      url: `/api/app/approvals/${r2.sysId}/reject`,
      headers: json('api.stranger'),
      payload: { comments: 'x' },
    });
    expect(stranger.statusCode).toBe(404);
    const rejected = await api.inject({
      method: 'POST',
      url: `/api/app/approvals/${r2.sysId}/reject`,
      headers: json('api.approver'),
      payload: { comments: 'Too expensive' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(reload(ctx, t2).str('approval')).toBe('rejected');

    const again = await api.inject({
      method: 'POST',
      url: `/api/app/approvals/${r1.sysId}/approve`,
      headers: json('api.approver'),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    const anon = await api.inject({ method: 'GET', url: '/api/app/approvals/mine' });
    expect(anon.statusCode).toBe(401);
  });

  it('runs the Approve and Reject UI actions; Reject needs comments', async () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'ui.approver');
    const task = ctx.insert('task', { short_description: 'UI decision' });
    const [row] = engine.request(ctx, task, { users: [a] });
    const api = await server();
    const form = await api.inject({
      method: 'GET',
      url: `/api/app/record/sysapproval_approver/${row.sysId}`,
      headers: auth('ui.approver'),
    });
    expect(form.statusCode).toBe(200);
    const actions = form.json().result.actions.map((x: { id: string }) => x.id);
    expect(actions).toEqual(expect.arrayContaining(['approvals.approve', 'approvals.reject']));
    const missing = await api.inject({
      method: 'POST',
      url: `/api/app/action/sysapproval_approver/${row.sysId}/approvals.reject`,
      headers: json('ui.approver'),
      payload: { input: {} },
    });
    expect(missing.statusCode).toBe(400);
    const done = await api.inject({
      method: 'POST',
      url: `/api/app/action/sysapproval_approver/${row.sysId}/approvals.reject`,
      headers: json('ui.approver'),
      payload: { input: { comments: 'Not now' } },
    });
    expect(done.statusCode).toBe(200);
    expect(reload(ctx, row).str('state')).toBe('rejected');
    expect(reload(ctx, row).str('approval_source')).toBe('ui');
  });
});

describe('approval by email reply', () => {
  it('approves from the approver, rejects on state:rejected, ignores strangers and decided approvals', () => {
    const { ctx, engine } = boot();
    const a = makeUser(p, 'mail.approver');
    const stranger = makeUser(p, 'mail.stranger');
    const t1 = ctx.insert('task', { short_description: 'Mail one' });
    const t2 = ctx.insert('task', { short_description: 'Mail two' });
    const [r1] = engine.request(ctx, t1, { users: [a] });
    const [r2] = engine.request(ctx, t2, { users: [a] });

    expect(
      engine.decideFromEmail(ctx, r1, {
        from: stranger,
        subject: `Re:${t1.str('number')} - approve`,
        body_text: 'yes',
      }),
    ).toMatchObject({
      status: 'ignored',
      message: expect.stringContaining('not authorized'),
    });
    expect(reload(ctx, r1).str('state')).toBe('requested');

    const ok = engine.decideFromEmail(ctx, r1, {
      from: a,
      subject: `Re:${t1.str('number')} - approve`,
      body_text: 'Looks good to me',
    });
    expect(ok.status).toBe('approved');
    const fresh = reload(ctx, r1);
    expect(fresh.str('state')).toBe('approved');
    expect(fresh.str('approval_source')).toBe('email');
    expect(fresh.str('resolvr_decided_by')).toBe(a);
    expect(p.history.journal('sysapproval_approver', r1.sysId, ['comments'])[0].value).toBe(
      'Looks good to me',
    );

    expect(
      engine.decideFromEmail(ctx, r2, {
        from: a,
        subject: 'Re: your approval',
        body_text: 'state:rejected\nnot this quarter',
      }).status,
    ).toBe('rejected');
    expect(reload(ctx, r2).str('state')).toBe('rejected');
    expect(
      engine.decideFromEmail(ctx, r2, { from: a, subject: 'Re: again', body_text: 'state:approved' }).status,
    ).toBe('ignored');
    expect(reload(ctx, r2).str('state')).toBe('rejected');
  });
});

describe('classic approval rules', () => {
  it('are off by default; with the approval rules engine matching rules add approvers', () => {
    const { ctx, engine } = boot();
    const u = makeUser(p, 'rule.approver');
    for (const m of ['net.one', 'net.two']) makeUser(p, m, [], ['Network CAB']);
    ctx.insert('sysrule_approvals', {
      name: 'Network work',
      table: 'task',
      condition: 'short_descriptionLIKEnetwork',
      user: u,
      set_state: 'requested',
      run_before: true,
    });
    ctx.insert('sysrule_approvals', {
      name: 'Network CAB',
      table: 'task',
      condition: 'short_descriptionLIKEnetwork',
      group: 'Network CAB',
      run_before: false,
    });
    const off = ctx.insert('task', { short_description: 'Replace network switch' });
    expect(rowsOf(ctx, off)).toHaveLength(0);

    p.properties.set('glide.approval_engine.task', 'approval_engine');
    const on = ctx.insert('task', { short_description: 'Upgrade network core' });
    const rows = rowsOf(ctx, on);
    expect(states(rows)).toEqual(['requested', 'requested', 'requested']);
    expect(rows.every((r) => r.str('approval_source') === 'rule')).toBe(true);
    expect(reload(ctx, on).str('approval')).toBe('requested');
    expect(rowsOf(ctx, ctx.insert('task', { short_description: 'Printer toner' }))).toHaveLength(0);

    for (const r of rows) engine.decide(ctx, r, 'approved');
    expect(reload(ctx, on).str('approval')).toBe('approved');
    ctx.update(reload(ctx, on), { description: 'No new approvals on later updates' });
    expect(rowsOf(ctx, on)).toHaveLength(3);
  });
});
