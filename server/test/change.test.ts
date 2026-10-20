import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AbortError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { addMs, clock, nowGlide } from '../src/engine/util.js';
import { approvalsModule } from '../src/modules/approvals/index.js';
import { directDecision } from '../src/modules/change/approvals.js';
import { refreshAgenda } from '../src/modules/change/cab.js';
import { findConflicts, runConflictDetection } from '../src/modules/change/conflicts.js';
import { MODEL_IDS, PROP, STATE, T } from '../src/modules/change/constants.js';
import { changeModule } from '../src/modules/change/index.js';
import { computeRisk, submitAssessment } from '../src/modules/change/risk.js';
import {
  createStandardChange,
  createTemplate,
  decideProposal,
  requestProposalApproval,
} from '../src/modules/change/standard.js';
import type { ApprovalService } from '../src/modules/contracts.js';
import { bootPlatform, makeUser } from './helpers.js';

const CI_WEB = 'aa10bb20cc30dd40ee50ff6011223344';
const CI_DB = 'bb10bb20cc30dd40ee50ff6011223344';
const CI_OTHER = 'cc10bb20cc30dd40ee50ff6011223344';
const DAY = 86_400_000;

/** True when the approvals module boots and registers its service (it may still be in progress). */
const APPROVALS_AVAILABLE = (() => {
  try {
    const probe = bootPlatform([approvalsModule, changeModule]);
    const ok = probe.services.has('approvals');
    probe.close();
    return ok;
  } catch {
    return false;
  }
})();

interface Env {
  p: Platform;
  sys: Context;
  network: string;
  users: Record<string, string>;
}

function setup(withApprovals = false): Env {
  const p = bootPlatform(withApprovals ? [approvalsModule, changeModule] : [changeModule]);
  const sys = p.systemContext();
  const users: Record<string, string> = {
    uma: makeUser(p, 'uma.agent', ['itil']),
    mia: makeUser(p, 'mia.lead', ['itil'], ['Network']),
    bob: makeUser(p, 'bob.engineer', ['itil'], ['Network']),
    ann: makeUser(p, 'ann.engineer', ['itil'], ['Network']),
    carl: makeUser(p, 'carl.cab', ['itil'], ['CAB Approval']),
    cora: makeUser(p, 'cora.changemgr', ['itil', 'change_manager'], ['Change Management']),
  };
  const network = sys.first('sys_user_group', 'name=Network')!;
  sys.update(network, { manager: users.mia });
  p.users.invalidate();
  return { p, sys, network: network.sysId, users };
}

function newChange(env: Env, values: Record<string, unknown> = {}, as = 'uma.agent'): Rec {
  return env.p.contextAs(as).insert(T.change, {
    short_description: 'Rotate TLS certificates on web tier',
    assignment_group: env.network,
    ...values,
  });
}

const reload = (env: Env, id: string): Rec => env.sys.get(T.change, id)!;

function tryUpdate(ctx: Context, rec: Rec, values: Record<string, unknown>): string | null {
  try {
    ctx.update(rec, values);
    return null;
  } catch (e) {
    if (e instanceof AbortError) return e.message;
    throw e;
  }
}

/** Moves a change to a state through its model; approvals are decided by the change manager (fallback). */
function driveTo(env: Env, id: string, target: number): Rec {
  const cm = env.p.contextAs('cora.changemgr');
  for (let i = 0; i < 10; i++) {
    const rec = reload(env, id);
    const state = rec.num('state');
    if (state === target) return rec;
    const type = rec.str('type');
    if (target === STATE.CANCELED) cm.update(rec, { state: STATE.CANCELED });
    else if (state === STATE.NEW)
      cm.update(rec, {
        state: type === 'standard' ? STATE.SCHEDULED : type === 'emergency' ? STATE.AUTHORIZE : STATE.ASSESS,
      });
    else if (state === STATE.ASSESS || state === STATE.AUTHORIZE) directDecision(cm, rec, 'approved');
    else if (state === STATE.SCHEDULED) cm.update(rec, { state: STATE.IMPLEMENT });
    else if (state === STATE.IMPLEMENT) cm.update(rec, { state: STATE.REVIEW });
    else if (state === STATE.REVIEW)
      cm.update(rec, { state: STATE.CLOSED, close_code: 'successful', close_notes: 'Done' });
  }
  return reload(env, id);
}

const notesOf = (env: Env, id: string) =>
  env.p.history
    .journal(T.change, id, ['work_notes'])
    .map((j) => j.value)
    .join('\n');

let env: Env | null = null;
afterEach(() => {
  env?.p.close();
  env = null;
  clock.reset();
});

// ---------------------------------------------------------------------------

describe('change creation and models', () => {
  it('numbers changes, resolves the model and applies defaults', () => {
    const e = (env = setup());
    const c = newChange(e, { chg_model: 'Normal' });
    expect(c.str('number')).toMatch(/^CHG\d{7}$/);
    expect(Number(c.str('number').slice(3))).toBeGreaterThan(30000);
    expect(c.str('type')).toBe('normal');
    expect(c.num('state')).toBe(STATE.NEW);
    expect(c.str('approval')).toBe('not requested');
    expect(c.str('conflict_status')).toBe('Not Run');
    expect(c.str('phase')).toBe('requested');
    expect(c.str('chg_model')).toBe(MODEL_IDS.normal);
  });

  it('picks the model of the type and rejects unknown models', () => {
    const e = (env = setup());
    expect(newChange(e, { type: 'emergency' }).str('chg_model')).toBe(MODEL_IDS.emergency);
    expect(newChange(e, {}).str('type')).toBe('normal');
    expect(() => newChange(e, { chg_model: 'Bogus model' })).toThrow(
      /Change model "Bogus model" does not exist/,
    );
    const reg = newChange(e, { chg_model: 'Change Registration', type: 'emergency' });
    expect(reg.str('type')).toBe('normal');
    expect(reg.num('state')).toBe(STATE.REVIEW);
  });

  it('derives cab_required from type and risk', () => {
    const e = (env = setup());
    expect(newChange(e, { type: 'normal' }).bool('cab_required')).toBe(true);
    const low = newChange(e, { type: 'normal', risk: 4 });
    expect(low.bool('cab_required')).toBe(false);
    expect(newChange(e, { type: 'normal', risk: 2 }).bool('cab_required')).toBe(true);
    expect(newChange(e, { type: 'emergency', risk: 4 }).bool('cab_required')).toBe(true);
    const uma = e.p.contextAs('uma.agent');
    uma.update(reload(e, low.sysId), { risk: 1 });
    expect(reload(e, low.sysId).bool('cab_required')).toBe(true);
    const tpl = createTemplate(e.sys, {
      name: 'Restart service',
      values: { short_description: 'Restart', risk: 4 },
    });
    expect(
      createStandardChange(uma, tpl.sysId, { assignment_group: e.network }).change.bool('cab_required'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('state transition matrix', () => {
  const ALL = [
    STATE.NEW,
    STATE.ASSESS,
    STATE.AUTHORIZE,
    STATE.SCHEDULED,
    STATE.IMPLEMENT,
    STATE.REVIEW,
    STATE.CLOSED,
    STATE.CANCELED,
  ];
  const MATRIX: Record<string, { states: number[]; allowed: Record<number, number[]> }> = {
    normal: {
      states: ALL,
      allowed: {
        [STATE.NEW]: [STATE.ASSESS, STATE.CANCELED],
        [STATE.ASSESS]: [STATE.NEW, STATE.CANCELED],
        [STATE.AUTHORIZE]: [STATE.CANCELED],
        [STATE.SCHEDULED]: [STATE.IMPLEMENT, STATE.CANCELED],
        [STATE.IMPLEMENT]: [STATE.REVIEW, STATE.CANCELED],
        [STATE.REVIEW]: [STATE.CLOSED],
        [STATE.CLOSED]: [],
        [STATE.CANCELED]: [],
      },
    },
    standard: {
      states: [STATE.NEW, STATE.SCHEDULED, STATE.IMPLEMENT, STATE.REVIEW, STATE.CLOSED, STATE.CANCELED],
      allowed: {
        [STATE.NEW]: [STATE.SCHEDULED, STATE.CANCELED],
        [STATE.SCHEDULED]: [STATE.IMPLEMENT, STATE.CANCELED],
        [STATE.IMPLEMENT]: [STATE.REVIEW, STATE.CANCELED],
        [STATE.REVIEW]: [STATE.CLOSED],
        [STATE.CLOSED]: [],
        [STATE.CANCELED]: [],
      },
    },
    emergency: {
      states: [
        STATE.NEW,
        STATE.AUTHORIZE,
        STATE.SCHEDULED,
        STATE.IMPLEMENT,
        STATE.REVIEW,
        STATE.CLOSED,
        STATE.CANCELED,
      ],
      allowed: {
        [STATE.NEW]: [STATE.AUTHORIZE, STATE.CANCELED],
        [STATE.AUTHORIZE]: [STATE.NEW, STATE.CANCELED],
        [STATE.SCHEDULED]: [STATE.IMPLEMENT, STATE.CANCELED],
        [STATE.IMPLEMENT]: [STATE.REVIEW, STATE.CANCELED],
        [STATE.REVIEW]: [STATE.CLOSED],
        [STATE.CLOSED]: [],
        [STATE.CANCELED]: [],
      },
    },
  };

  for (const [type, spec] of Object.entries(MATRIX)) {
    it(`enforces the ${type} transitions for an agent`, () => {
      const e = (env = setup());
      const uma = e.p.contextAs('uma.agent');
      const template =
        type === 'standard'
          ? createTemplate(e.sys, { name: 'Matrix template', values: { short_description: 'Std' } })
          : null;
      const make = (from: number) => {
        const c = template
          ? createStandardChange(uma, template.sysId, { assignment_group: e.network }).change
          : newChange(e, { type, risk: 2 });
        return driveTo(e, c.sysId, from);
      };
      const failures: string[] = [];
      for (const from of spec.states) {
        const shared = make(from);
        expect(shared.num('state')).toBe(from);
        for (const to of ALL) {
          if (to === from) continue;
          const valid = spec.allowed[from].includes(to);
          const rec = valid ? make(from) : reload(e, shared.sysId);
          const extra = to === STATE.CLOSED ? { close_code: 'successful', close_notes: 'Done' } : {};
          const error = tryUpdate(uma, rec, { state: to, ...extra });
          const after = reload(e, rec.sysId).num('state');
          const ok = valid ? error === null && after === to : error !== null && after === from;
          if (!ok)
            failures.push(
              `${type} ${from} -> ${to}: expected ${valid ? 'allowed' : 'rejected'}, got ${error ?? `state ${after}`}`,
            );
          if (!valid && error) expect(error).toMatch(/^Invalid state transition: Change cannot move from/);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('explains invalid moves', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    expect(tryUpdate(uma, newChange(e), { state: STATE.IMPLEMENT })).toBe(
      'Invalid state transition: Change cannot move from New to Implement',
    );
    const assess = driveTo(e, newChange(e).sysId, STATE.ASSESS);
    expect(tryUpdate(uma, assess, { state: STATE.AUTHORIZE })).toBe(
      'Invalid state transition: Change cannot move from Assess to Authorize: the change has not been approved',
    );
    const review = driveTo(e, newChange(e).sysId, STATE.REVIEW);
    expect(tryUpdate(uma, review, { state: STATE.CANCELED })).toMatch(/changes in Review cannot be canceled/);
    const closed = driveTo(e, newChange(e).sysId, STATE.CLOSED);
    expect(tryUpdate(uma, closed, { state: STATE.REVIEW })).toMatch(/Closed is a final state/);
  });

  it('requires the assignment group to request approval', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const c = uma.insert(T.change, { short_description: 'No group', type: 'normal' });
    expect(tryUpdate(uma, c, { state: STATE.ASSESS })).toBe(
      'Mandatory fields must be populated: Assignment group',
    );
    expect(reload(e, c.sysId).num('state')).toBe(STATE.NEW);
  });

  it('guards type changes and the configuration item', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const c = newChange(e, { type: 'normal', cmdb_ci: CI_WEB });
    uma.update(c, { type: 'emergency' });
    expect(reload(e, c.sysId).str('chg_model')).toBe(MODEL_IDS.emergency);
    expect(tryUpdate(uma, reload(e, c.sysId), { type: 'standard' })).toMatch(/standard change template/);
    const assess = driveTo(e, newChange(e, { cmdb_ci: CI_WEB }).sysId, STATE.ASSESS);
    expect(tryUpdate(uma, assess, { type: 'emergency' })).toMatch(/only be changed while it is New/);
    expect(tryUpdate(uma, reload(e, assess.sysId), { cmdb_ci: CI_DB })).toBe(
      'Configuration item cannot change for Change Requests in this state',
    );
  });

  it('rejects planned end dates before the start', () => {
    const e = (env = setup());
    expect(() =>
      newChange(e, { start_date: '2026-11-07 10:00:00', end_date: '2026-11-07 09:00:00' }),
    ).toThrow(/Planned end date must be after planned start date/);
  });
});

// ---------------------------------------------------------------------------

describe('approvals without the approvals module (change manager fallback)', () => {
  it('lets change managers approve and reject through UI actions', () => {
    const e = (env = setup());
    const c = driveTo(e, newChange(e, { risk: 2 }).sysId, STATE.ASSESS);
    expect(c.str('approval')).toBe('requested');
    const approve = e.p.uiActions.get('change.approve')!;
    const reject = e.p.uiActions.get('change.reject')!;
    const visible = approve.condition as (r: Rec, c: Context) => boolean;
    const uma = e.p.contextAs('uma.agent');
    const cm = e.p.contextAs('cora.changemgr');
    expect(visible(c, uma)).toBe(false);
    expect(visible(c, cm)).toBe(true);
    expect(approve.run(c, cm, {})).toMatchObject({ message: expect.stringMatching(/Authorize$/) });
    const authorize = reload(e, c.sysId);
    expect(authorize.num('state')).toBe(STATE.AUTHORIZE);
    expect(authorize.str('approval')).toBe('requested');
    expect(reject.run(authorize, cm, { work_notes: 'Window clashes with the audit' })).toMatchObject({
      message: expect.stringMatching(/New$/),
    });
    const back = reload(e, c.sysId);
    expect(back.num('state')).toBe(STATE.NEW);
    expect(back.str('approval')).toBe('rejected');
    expect(notesOf(e, c.sysId)).toContain('Window clashes with the audit');
    // A rejected change can change type and be resubmitted.
    uma.update(reload(e, c.sysId), { type: 'emergency' });
    uma.update(reload(e, c.sysId), { state: STATE.AUTHORIZE });
    expect(reload(e, c.sysId).num('state')).toBe(STATE.AUTHORIZE);
  });

  it('pre-approves standard changes and reverts to New', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const tpl = createTemplate(e.sys, {
      name: 'Patch a server',
      values: { short_description: 'Patch', risk: 4 },
    });
    const std = createStandardChange(uma, tpl.sysId, { assignment_group: e.network }).change;
    expect(e.p.uiActions.get('change.request_approval')!.run(std, uma, {})).toMatchObject({
      message: expect.stringMatching(/pre-approved/),
    });
    const s = reload(e, std.sysId);
    expect(s.num('state')).toBe(STATE.SCHEDULED);
    expect(s.str('approval')).toBe('approved');
    const normal = driveTo(e, newChange(e).sysId, STATE.ASSESS);
    e.p.uiActions.get('change.revert')!.run(normal, uma, {});
    const reverted = reload(e, normal.sysId);
    expect(reverted.num('state')).toBe(STATE.NEW);
    expect(reverted.str('approval')).toBe('not requested');
  });
});

describe('approvals through the approvals service', () => {
  const rows = (e: Env, id: string, extra = '') =>
    e.sys.query('sysapproval_approver', `document_id=${id}${extra ? `^${extra}` : ''}`);
  const svc = (e: Env) => e.p.service<ApprovalService>('approvals');

  it.runIf(APPROVALS_AVAILABLE)('asks the assignment group, then the CAB, then schedules the change', () => {
    const e = (env = setup(true));
    expect(e.p.services.has('approvals')).toBe(true);
    const c = newChange(e, { risk: 2 });
    e.p.contextAs('uma.agent').update(c, { state: STATE.ASSESS });
    const assess = reload(e, c.sysId);
    expect(assess.num('state')).toBe(STATE.ASSESS);
    expect(assess.str('approval')).toBe('requested');
    const requested = rows(e, c.sysId, 'state=requested');
    expect(requested.map((r) => r.str('approver')).sort()).toEqual(
      [e.users.mia, e.users.bob, e.users.ann].sort(),
    );
    svc(e).decide(
      e.p.contextAs('bob.engineer'),
      requested.find((r) => r.str('approver') === e.users.bob)!,
      'approved',
    );
    expect(reload(e, c.sysId).num('state')).toBe(STATE.AUTHORIZE);
    expect(rows(e, c.sysId, `approver=${e.users.ann}`)[0].str('state')).toBe('not_required');
    const cab = rows(e, c.sysId, 'state=requested');
    expect(cab.map((r) => r.str('approver'))).toEqual([e.users.carl]);
    svc(e).decide(e.p.contextAs('carl.cab'), cab[0], 'approved');
    const scheduled = reload(e, c.sysId);
    expect(scheduled.num('state')).toBe(STATE.SCHEDULED);
    expect(scheduled.str('approval')).toBe('approved');
  });

  it.runIf(APPROVALS_AVAILABLE)(
    'skips authorization when the group manager approved a low risk change',
    () => {
      const e = (env = setup(true));
      const c = newChange(e, { risk: 4 });
      e.p.contextAs('uma.agent').update(c, { state: STATE.ASSESS });
      const miaRow = rows(e, c.sysId, `state=requested^approver=${e.users.mia}`)[0];
      svc(e).decide(e.p.contextAs('mia.lead'), miaRow, 'approved');
      expect(reload(e, c.sysId).num('state')).toBe(STATE.SCHEDULED);
      expect(rows(e, c.sysId, 'state=requested')).toHaveLength(0);
    },
  );

  it.runIf(APPROVALS_AVAILABLE)('returns a rejected change to New with the comment in the work notes', () => {
    const e = (env = setup(true));
    const c = newChange(e, { type: 'emergency' });
    e.p.contextAs('uma.agent').update(c, { state: STATE.AUTHORIZE });
    const carlRow = rows(e, c.sysId, `state=requested^approver=${e.users.carl}`)[0];
    expect(carlRow).toBeDefined();
    svc(e).decide(e.p.contextAs('carl.cab'), carlRow, 'rejected', 'Not during the release freeze');
    const back = reload(e, c.sysId);
    expect(back.num('state')).toBe(STATE.NEW);
    expect(back.str('approval')).toBe('rejected');
    expect(notesOf(e, c.sysId)).toContain('Not during the release freeze');
  });

  it.runIf(APPROVALS_AVAILABLE)('cancels approvals on revert and resets the approval', () => {
    const e = (env = setup(true));
    const uma = e.p.contextAs('uma.agent');
    const c = newChange(e);
    uma.update(c, { state: STATE.ASSESS });
    uma.update(reload(e, c.sysId), { state: STATE.NEW });
    expect(reload(e, c.sysId).str('approval')).toBe('not requested');
    expect(rows(e, c.sysId, 'state=requested')).toHaveLength(0);
    expect(rows(e, c.sysId, 'state=cancelled').length).toBeGreaterThan(0);
  });

  it.runIf(APPROVALS_AVAILABLE)('withdraws approvals while on hold and asks again on release', () => {
    const e = (env = setup(true));
    const uma = e.p.contextAs('uma.agent');
    const c = newChange(e);
    uma.update(c, { state: STATE.ASSESS });
    uma.update(reload(e, c.sysId), { on_hold: true, on_hold_reason: 'Vendor' });
    expect(rows(e, c.sysId, 'state=requested')).toHaveLength(0);
    uma.update(reload(e, c.sysId), { on_hold: false });
    expect(rows(e, c.sysId, 'state=requested')).toHaveLength(3);
    expect(reload(e, c.sysId).str('approval')).toBe('requested');
  });

  it.runIf(APPROVALS_AVAILABLE)(
    'lets approvers decide from the change form and resubmits after a rejection',
    () => {
      const e = (env = setup(true));
      const uma = e.p.contextAs('uma.agent');
      const bob = e.p.contextAs('bob.engineer');
      const c = newChange(e, { risk: 2 });
      uma.update(c, { state: STATE.ASSESS });
      const reject = e.p.uiActions.get('change.reject')!;
      const visible = reject.condition as (r: Rec, c: Context) => boolean;
      expect(visible(reload(e, c.sysId), bob)).toBe(true);
      expect(visible(reload(e, c.sysId), uma)).toBe(false);
      expect(reject.run(reload(e, c.sysId), bob, { work_notes: 'Missing test evidence' })).toMatchObject({
        message: expect.stringMatching(/New$/),
      });
      expect(notesOf(e, c.sysId)).toContain('Missing test evidence');
      uma.update(reload(e, c.sysId), { test_plan: 'Evidence attached', state: STATE.ASSESS });
      expect(reload(e, c.sysId).str('approval')).toBe('requested');
      expect(rows(e, c.sysId, 'state=requested')).toHaveLength(3);
      e.p.uiActions.get('change.approve')!.run(reload(e, c.sysId), e.p.contextAs('ann.engineer'), {});
      expect(reload(e, c.sysId).num('state')).toBe(STATE.AUTHORIZE);
    },
  );

  it.runIf(APPROVALS_AVAILABLE)('approves through the REST approvals endpoint as the approver', async () => {
    const e = (env = setup(true));
    const dir = mkdtempSync(join(tmpdir(), 'resolvrnow-change-appr-'));
    const app = await buildApp(e.p, {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      dbFile: ':memory:',
      attachmentDir: join(dir, 'att'),
      publicUrl: null,
      webDir: null,
      demo: false,
      secureCookies: false,
    });
    try {
      const c = newChange(e, { type: 'emergency' });
      e.p.contextAs('uma.agent').update(c, { state: STATE.AUTHORIZE });
      const patch = (user: string, payload: unknown) =>
        app.inject({
          method: 'PATCH',
          url: `/api/sn_chg_rest/change/${c.sysId}/approvals`,
          headers: {
            authorization: `Basic ${Buffer.from(`${user}:Password1!`).toString('base64')}`,
            'content-type': 'application/json',
          },
          payload: JSON.stringify(payload),
        });
      const notMine = await patch('bob.engineer', { state: 'approved' });
      expect(notMine.statusCode).toBe(400);
      expect(notMine.json().error.detail).toBe('User lacks authority to approve or reject this change');
      const ok = await patch('carl.cab', { state: 'approved', comments: 'Go ahead' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().result.state).toEqual({ value: -2, display_value: 'Scheduled' });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(APPROVALS_AVAILABLE)('pre-approves standard changes without approval records', () => {
    const e = (env = setup(true));
    const uma = e.p.contextAs('uma.agent');
    const tpl = createTemplate(e.sys, { name: 'Restart', values: { short_description: 'Restart' } });
    const std = createStandardChange(uma, tpl.sysId, { assignment_group: e.network }).change;
    uma.update(std, { state: STATE.SCHEDULED });
    expect(reload(e, std.sysId).str('approval')).toBe('approved');
    expect(rows(e, std.sysId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('risk', () => {
  const soon = (days: number) => ({
    start_date: addMs(nowGlide(), days * DAY),
    end_date: addMs(nowGlide(), days * DAY + 3_600_000),
  });

  it('applies the first matching risk condition by order', () => {
    const e = (env = setup());
    const c = newChange(e, soon(2));
    e.sys.insert(T.riskCondition, {
      name: 'Everything moderate',
      order: 120,
      condition: 'typeINnormal,emergency',
      risk: 3,
    });
    const outcome = computeRisk(e.sys, reload(e, c.sysId));
    expect(outcome.condition?.name).toBe('Insufficient lead time (Normal)');
    expect(outcome.risk).toBe(2);
    expect(computeRisk(e.sys, newChange(e, soon(30))).condition?.name).toBe('Everything moderate');
    e.p.uiActions.get('change.calculate_risk')!.run(reload(e, c.sysId), e.p.contextAs('uma.agent'), {});
    expect(reload(e, c.sysId).num('risk')).toBe(2);
  });

  it('raises risk when the configuration item supports many services', () => {
    const e = (env = setup());
    const c = newChange(e, { cmdb_ci: CI_WEB, ...soon(40) });
    expect(computeRisk(e.sys, c).condition).toBeNull();
    for (let i = 0; i < 3; i++)
      e.sys.insert(T.taskService, { task: c.sysId, cmdb_ci_service: `cc${String(i).padStart(30, '0')}` });
    const outcome = computeRisk(e.sys, reload(e, c.sysId));
    expect(outcome.condition?.name).toBe('Many dependent services');
    expect(outcome.risk).toBe(2);
    expect(outcome.impact).toBe(1);
  });

  it('scores a risk assessment with weighted answers and keeps the highest risk', () => {
    const e = (env = setup());
    const sys = e.sys;
    const asmt = sys.insert(T.assessment, {
      name: 'Small assessment',
      state: 'published',
      condition: 'short_descriptionLIKEassessed',
      category_weight: 1,
    });
    const options = (pairs: [string, number][]) =>
      JSON.stringify(pairs.map(([label, value]) => ({ label, value })));
    const q1 = sys.insert(T.question, {
      risk_assessment: asmt.sysId,
      question: 'Blast radius?',
      weight: 2,
      mandatory: true,
      options: options([
        ['Small', 1],
        ['Large', 3],
      ]),
    });
    const q2 = sys.insert(T.question, {
      risk_assessment: asmt.sysId,
      question: 'Tested?',
      weight: 1,
      options: options([
        ['Yes', 1],
        ['No', 4],
      ]),
    });
    for (const [risk, score] of [
      [2, 10],
      [3, 6],
      [4, 0],
    ])
      sys.insert(T.threshold, { risk_assessment: asmt.sysId, risk, score_greater_than: score });
    const c = newChange(e, { short_description: 'Change to be assessed', ...soon(40) });
    const uma = e.p.contextAs('uma.agent');
    expect(() => submitAssessment(uma, c, asmt.sysId, { [q2.sysId]: 'No' })).toThrow(/Mandatory questions/);
    const first = submitAssessment(uma, c, asmt.sysId, { [q1.sysId]: 'Small', [q2.sysId]: 'No' });
    expect(first.result.num('score')).toBe(6);
    expect(first.result.num('risk')).toBe(4);
    expect(first.outcome.risk).toBe(4);
    const second = submitAssessment(uma, reload(e, c.sysId), asmt.sysId, { [q1.sysId]: 3, [q2.sysId]: 1 });
    expect(second.result.sysId).toBe(first.result.sysId);
    expect(second.result.num('score')).toBe(7);
    expect(second.result.num('risk')).toBe(3);
    expect(reload(e, c.sysId).num('risk')).toBe(3);
    sys.insert(T.riskCondition, {
      name: 'Assessed changes are high',
      order: 50,
      condition: 'short_descriptionLIKEassessed',
      risk: 2,
    });
    expect(computeRisk(sys, reload(e, c.sysId)).risk).toBe(2);
  });

  it('applies risk conditions on save in business rule mode unless an assessment exists', () => {
    const e = (env = setup());
    e.p.properties.set(PROP.riskRule, 'business_rule');
    const c = newChange(e, soon(1));
    expect(c.num('risk')).toBe(2);
    e.sys.insert(T.result, {
      change: c.sysId,
      risk_assessment: e.sys.first(T.assessment)!.sysId,
      score: 1,
      risk: 4,
      taken_on: nowGlide(),
    });
    e.p.contextAs('uma.agent').update(reload(e, c.sysId), { risk: 4, short_description: 'Edited' });
    expect(reload(e, c.sysId).num('risk')).toBe(4);
  });

  it('uses the model success rate for the calculated risk', () => {
    const e = (env = setup());
    const fast = e.sys.derive({ workflow: false });
    for (const code of ['successful', 'successful', 'successful', 'unsuccessful', 'unsuccessful']) {
      fast.insert(T.change, {
        chg_model: MODEL_IDS.normal,
        type: 'normal',
        state: STATE.CLOSED,
        close_code: code,
        closed_at: nowGlide(),
        active: false,
        short_description: 'Old',
      });
    }
    const outcome = computeRisk(e.sys, newChange(e, { impact: 1, ...soon(40) }));
    expect(outcome.calculated).toMatchObject({ success_probability: 'low', risk: 2 });
    expect(outcome.risk).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('conflict detection', () => {
  const win = (day: string, from: string, to: string) => ({
    start_date: `${day} ${from}:00`,
    end_date: `${day} ${to}:00`,
  });

  it('finds another change scheduled on the same CI', () => {
    const e = (env = setup());
    const a = newChange(e, { cmdb_ci: CI_WEB, ...win('2026-11-07', '10:00', '12:00') });
    const b = newChange(e, { cmdb_ci: CI_WEB, ...win('2026-11-07', '11:00', '13:00') });
    const run = runConflictDetection(e.sys, a.sysId);
    expect(run.status).toBe('Conflict');
    expect(run.conflicts.map((r) => [r.str('type'), r.str('conflicting_change')])).toEqual([
      ['ci_already_scheduled', b.sysId],
    ]);
    const after = reload(e, a.sysId);
    expect(after.str('conflict_status')).toBe('Conflict');
    expect(after.str('conflict_last_run')).not.toBe('');
  });

  it('treats touching windows as no conflict and ignores excluded changes', () => {
    const e = (env = setup());
    const a = newChange(e, { cmdb_ci: CI_WEB, ...win('2026-11-07', '10:00', '12:00') });
    newChange(e, { cmdb_ci: CI_WEB, ...win('2026-11-07', '12:00', '14:00') });
    expect(runConflictDetection(e.sys, a.sysId).status).toBe('No Conflict');
    expect(reload(e, a.sysId).str('conflict_status')).toBe('No Conflict');
    newChange(
      e,
      { cmdb_ci: CI_WEB, exclude_from_conflict_detection: true, ...win('2026-11-07', '09:00', '11:00') },
      'cora.changemgr',
    );
    expect(runConflictDetection(e.sys, a.sysId).status).toBe('No Conflict');
  });

  it('reports blackout and maintenance windows but not information schedules', () => {
    const e = (env = setup());
    const sys = e.sys;
    const freeze = sys.insert(T.blackout, {
      name: 'Year-end freeze',
      category: 'hard_freeze',
      source: 'ci_class',
      applies_to: 'cmdb_ci',
    });
    sys.insert(T.span, {
      schedule: freeze.sysId,
      name: 'Freeze',
      start_date_time: '20261201T000000',
      end_date_time: '20270102T000000',
    });
    const offsite = sys.insert(T.information, {
      name: 'Company offsite',
      category: 'organisational_event',
      source: 'ci_class',
      applies_to: 'cmdb_ci',
    });
    sys.insert(T.span, {
      schedule: offsite.sysId,
      name: 'Offsite',
      start_date_time: '20261201T000000',
      end_date_time: '20261231T000000',
    });
    const window = sys.insert(T.maintenance, {
      name: 'Saturday nights',
      category: 'general',
      source: 'ci_class',
      applies_to: 'cmdb_ci',
    });
    sys.insert(T.span, {
      schedule: window.sysId,
      name: 'Saturday',
      start_date_time: '20261107T220000',
      end_date_time: '20261108T060000',
      repeat_type: 'weekly',
      days_of_week: '6',
    });

    const inFreeze = newChange(e, { cmdb_ci: CI_WEB, ...win('2026-12-12', '23:00', '23:30') });
    const run = runConflictDetection(sys, inFreeze.sysId);
    expect(run.conflicts.map((r) => r.str('type'))).toEqual(['blackout']);
    expect(run.conflicts[0].str('schedule')).toBe(freeze.sysId);
    expect(run.conflicts[0].str('category')).toBe('hard_freeze');
    expect(reload(e, inFreeze.sysId).bool('outside_maintenance_schedule')).toBe(false);

    const weekday = newChange(e, { cmdb_ci: CI_DB, ...win('2026-11-10', '10:00', '11:00') });
    const run2 = runConflictDetection(sys, weekday.sysId);
    expect(run2.conflicts.map((r) => [r.str('type'), r.str('schedule')])).toEqual([
      ['not_in_maintenance_window', window.sysId],
    ]);
    expect(reload(e, weekday.sysId).bool('outside_maintenance_schedule')).toBe(true);
  });

  it('applies change-based blackouts by condition and flags busy assignees', () => {
    const e = (env = setup());
    const sys = e.sys;
    const freeze = sys.insert(T.blackout, {
      name: 'Finance close',
      category: 'soft_freeze',
      source: 'change_request',
      condition: 'category=Software',
    });
    sys.insert(T.span, {
      schedule: freeze.sysId,
      name: 'Close',
      start_date_time: '2026-12-24 00:00:00',
      end_date_time: '2027-01-01 00:00:00',
    });
    const sw = newChange(e, {
      category: 'Software',
      cmdb_ci: CI_WEB,
      ...win('2026-12-28', '10:00', '11:00'),
    });
    const hw = newChange(e, {
      category: 'Hardware',
      cmdb_ci: CI_DB,
      assigned_to: e.users.bob,
      ...win('2026-12-28', '10:00', '11:00'),
    });
    expect(findConflicts(sys, sw).findings.map((f) => f.type)).toContain('blackout');
    expect(findConflicts(sys, hw).findings.map((f) => f.type)).not.toContain('blackout');
    const other = newChange(e, {
      cmdb_ci: CI_OTHER,
      assigned_to: e.users.bob,
      ...win('2026-12-28', '10:30', '12:00'),
    });
    const busy = findConflicts(sys, reload(e, hw.sysId)).findings.filter(
      (f) => f.type === 'assigned_to_already_scheduled',
    );
    expect(busy.map((f) => f.conflicting_change)).toEqual([other.sysId]);
  });

  it('runs automatically when planned dates or the CI change, and from the UI action', () => {
    const e = (env = setup());
    const a = newChange(e, { cmdb_ci: CI_WEB, ...win('2026-11-07', '10:00', '12:00') });
    e.p.drain();
    expect(reload(e, a.sysId).str('conflict_status')).toBe('No Conflict');
    const b = newChange(e, { cmdb_ci: CI_WEB, ...win('2026-11-07', '11:00', '13:00') });
    e.p.drain();
    expect(reload(e, b.sysId).str('conflict_status')).toBe('Conflict');
    const uma = e.p.contextAs('uma.agent');
    uma.update(reload(e, a.sysId), { end_date: '2026-11-07 12:30:00' });
    e.p.drain();
    expect(reload(e, a.sysId).str('conflict_status')).toBe('Conflict');
    expect(e.p.uiActions.get('change.check_conflicts')!.run(reload(e, a.sysId), uma, {})).toMatchObject({
      message: '1 conflict(s) found',
    });
  });
});

// ---------------------------------------------------------------------------

describe('change tasks, review and closure', () => {
  it('creates implementation tasks and cancels them on review', () => {
    const e = (env = setup());
    const c = driveTo(e, newChange(e).sysId, STATE.IMPLEMENT);
    expect(c.str('work_start')).not.toBe('');
    const tasks = e.sys.query(T.task, `change_request=${c.sysId}`);
    expect(
      tasks
        .map((t) => `${t.str('short_description')}|${t.str('change_task_type')}|${t.str('created_from')}`)
        .sort(),
    ).toEqual(['Implement|implementation|workflow', 'Post-implementation testing|testing|workflow']);
    e.p.contextAs('uma.agent').update(c, { state: STATE.REVIEW });
    expect(e.sys.query(T.task, `change_request=${c.sysId}`).map((t) => t.num('state'))).toEqual([4, 4]);
    const review = reload(e, c.sysId);
    expect(review.num('state')).toBe(STATE.REVIEW);
    expect(review.str('work_end')).not.toBe('');
    expect(review.str('review_date')).not.toBe('');
  });

  it('keeps manual tasks open and blocks closing until they are done', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const c = driveTo(e, newChange(e).sysId, STATE.IMPLEMENT);
    const manual = uma.insert(T.task, { change_request: c.sysId, short_description: 'Update the runbook' });
    uma.update(reload(e, c.sysId), { state: STATE.REVIEW });
    expect(reload(e, c.sysId).num('state')).toBe(STATE.REVIEW);
    expect(uma.get(T.task, manual.sysId)!.num('state')).toBe(1);
    expect(
      tryUpdate(uma, reload(e, c.sysId), {
        state: STATE.CLOSED,
        close_code: 'successful',
        close_notes: 'Done',
      }),
    ).toMatch(/active change tasks/);
    expect(tryUpdate(uma, uma.get(T.task, manual.sysId)!, { state: 3 })).toBe(
      'Mandatory fields must be populated: Close code, Close notes',
    );
    uma.update(uma.get(T.task, manual.sysId)!, {
      state: 3,
      close_code: 'successful',
      close_notes: 'Updated',
    });
    expect(tryUpdate(uma, uma.get(T.task, manual.sysId)!, { state: 1 })).toBe(
      'Closed or canceled change tasks cannot be reopened',
    );
    expect(tryUpdate(uma, reload(e, c.sysId), { state: STATE.CLOSED })).toBe(
      'Mandatory fields must be populated: Close code, Close notes',
    );
    uma.update(reload(e, c.sysId), {
      state: STATE.CLOSED,
      close_code: 'successful_issues',
      close_notes: 'Minor follow-up',
    });
    const closed = reload(e, c.sysId);
    expect(closed.bool('active')).toBe(false);
    expect(closed.str('closed_at')).not.toBe('');
    expect(closed.num('review_status')).toBe(3);
  });

  it('moves to Review automatically when the last task closes', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const c = driveTo(e, newChange(e).sysId, STATE.IMPLEMENT);
    for (const t of e.sys.query(T.task, `change_request=${c.sysId}^active=true`)) {
      expect(reload(e, c.sysId).num('state')).toBe(STATE.IMPLEMENT);
      uma.update(uma.get(T.task, t.sysId)!, { state: 3, close_code: 'successful', close_notes: 'ok' });
    }
    expect(reload(e, c.sysId).num('state')).toBe(STATE.REVIEW);
  });

  it('can require closed tasks before review', () => {
    const e = (env = setup());
    e.p.properties.set(PROP.reviewNeedsClosedTasks, 'true');
    const c = driveTo(e, newChange(e).sysId, STATE.IMPLEMENT);
    expect(tryUpdate(e.p.contextAs('uma.agent'), c, { state: STATE.REVIEW })).toMatch(
      /all change tasks must be closed or canceled before review/,
    );
  });

  it('validates implementation task windows', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const c = newChange(e, { start_date: '2026-11-07 08:00:00', end_date: '2026-11-07 10:00:00' });
    const task = (from: string, to: string) =>
      uma.insert(T.task, {
        change_request: c.sysId,
        change_task_type: 'implementation',
        planned_start_date: `2026-11-07 ${from}:00`,
        planned_end_date: `2026-11-07 ${to}:00`,
      });
    expect(() => task('07:00', '09:00')).toThrow(/within the change's planned window/);
    const ok = task('08:00', '08:30');
    expect(ok.str('parent')).toBe(c.sysId);
    expect(ok.str('number')).toMatch(/^CTASK\d{7}$/);
  });

  it('holds tasks with the change and only allows canceling while on hold', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const c = driveTo(e, newChange(e).sysId, STATE.SCHEDULED);
    const t1 = uma.insert(T.task, { change_request: c.sysId, short_description: 'Prepare' });
    const t2 = uma.insert(T.task, {
      change_request: c.sysId,
      short_description: 'Held by hand',
      on_hold: true,
      on_hold_reason: 'Parts',
    });
    expect(tryUpdate(uma, reload(e, c.sysId), { on_hold: true })).toMatch(/on hold reason is required/);
    uma.update(reload(e, c.sysId), { on_hold: true, on_hold_reason: 'Vendor' });
    expect(uma.get(T.task, t1.sysId)!.bool('on_hold')).toBe(true);
    expect(uma.get(T.task, t1.sysId)!.str('on_hold_reason')).toBe('Vendor');
    expect(tryUpdate(uma, reload(e, c.sysId), { state: STATE.IMPLEMENT })).toMatch(/while it is on hold/);
    uma.update(reload(e, c.sysId), { on_hold: false });
    expect(uma.get(T.task, t1.sysId)!.bool('on_hold')).toBe(false);
    expect(uma.get(T.task, t2.sysId)!.bool('on_hold')).toBe(true);
    uma.update(reload(e, c.sysId), { on_hold: true, on_hold_reason: 'Vendor again' });
    uma.update(reload(e, c.sysId), { state: STATE.CANCELED });
    const canceled = reload(e, c.sysId);
    expect(canceled.num('state')).toBe(STATE.CANCELED);
    expect(canceled.bool('on_hold')).toBe(false);
    expect(e.sys.query(T.task, `change_request=${c.sysId}`).every((t) => t.num('state') === 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('unauthorized changes, standard templates and CAB', () => {
  it('records unauthorized changes from unplanned CI events', () => {
    const e = (env = setup());
    e.p.properties.set(PROP.unauthorizedEnabled, 'true');
    e.sys.queueEvent('ci.change.unplanned', null, CI_DB, 'Port speed changed');
    e.p.drain();
    const list = e.sys.query(T.change, `cmdb_ci=${CI_DB}`);
    expect(list).toHaveLength(1);
    const u = list[0];
    expect(u.bool('unauthorized')).toBe(true);
    expect(u.str('type')).toBe('emergency');
    expect(u.num('state')).toBe(STATE.REVIEW);
    expect(u.display('assignment_group')).toBe('Change Management');
    e.sys.queueEvent('ci.change.unplanned', null, CI_DB, 'Again');
    e.p.drain();
    expect(e.sys.count(T.change, `cmdb_ci=${CI_DB}`)).toBe(1);
    const cm = e.p.contextAs('cora.changemgr');
    expect(tryUpdate(cm, reload(e, u.sysId), { unauthorized: false })).toMatch(/work notes/);
    cm.update(reload(e, u.sysId), { unauthorized: false, work_notes: 'Approved retroactively by the CAB' });
    expect(reload(e, u.sysId).str('chg_model')).toBe(MODEL_IDS.emergency);

    // Authorized after the fact: back to Review with a post-implementation review task.
    e.sys.queueEvent('ci.change.unplanned', null, CI_OTHER, 'Firmware changed');
    e.p.drain();
    const v = e.sys.first(T.change, `cmdb_ci=${CI_OTHER}`)!;
    const request = e.p.uiActions.get('change.request_approval')!;
    expect(request.run(v, cm, {})).toMatchObject({ message: expect.stringMatching(/Authorize$/) });
    e.p.uiActions.get('change.approve')!.run(reload(e, v.sysId), cm, {});
    const authorized = reload(e, v.sysId);
    expect(authorized.num('state')).toBe(STATE.REVIEW);
    expect(authorized.str('approval')).toBe('approved');
    expect((request.condition as (r: Rec, c: Context) => boolean)(authorized, cm)).toBe(false);
    const tasks = e.sys.query(T.task, `change_request=${v.sysId}`);
    expect(tasks.map((t) => `${t.str('short_description')}|${t.str('change_task_type')}`)).toEqual([
      'Post Implementation Review|review',
    ]);
  });

  it('publishes a proposal and creates changes with its tasks in order', () => {
    const e = (env = setup());
    const uma = e.p.contextAs('uma.agent');
    const proposal = uma.insert(T.proposal, {
      short_description: 'Rotate a TLS certificate',
      template_value:
        'short_description=Rotate a TLS certificate^implementation_plan=Install the new certificate^risk=4',
      category: 'Security',
    });
    e.sys.insert(T.taskTemplate, { std_change_proposal: proposal.sysId, name: 'Second', order: 200 });
    e.sys.insert(T.taskTemplate, { std_change_proposal: proposal.sysId, name: 'First', order: 100 });
    requestProposalApproval(uma, proposal);
    expect(e.sys.get(T.proposal, proposal.sysId)!.num('state')).toBe(2);
    decideProposal(e.p.contextAs('cora.changemgr'), proposal, 'approved');
    const done = e.sys.get(T.proposal, proposal.sysId)!;
    expect(done.num('state')).toBe(3);
    const producer = e.sys.get(T.producer, done.str('std_change_producer'))!;
    expect(producer.str('current_version')).not.toBe('');
    const { change, ignored } = createStandardChange(uma, producer.sysId, {
      assignment_group: e.network,
      implementation_plan: 'skip steps',
    });
    expect(ignored).toEqual(['implementation_plan']);
    expect(change.str('implementation_plan')).toBe('Install the new certificate');
    expect(change.str('std_change_producer_version')).toBe(producer.str('current_version'));
    const tasks = e.sys.query(T.task, {
      query: `change_request=${change.sysId}`,
      orderBy: [{ field: 'number', desc: false }],
    });
    expect(tasks.map((t) => t.str('short_description'))).toEqual(['First', 'Second']);
  });

  it('builds a CAB agenda and sets the CAB date on the change', () => {
    const e = (env = setup());
    const c = driveTo(
      e,
      newChange(e, { risk: 2, start_date: '2026-11-12 10:00:00', end_date: '2026-11-12 11:00:00' }).sysId,
      STATE.AUTHORIZE,
    );
    const meeting = e.sys.insert(T.cabMeeting, {
      name: 'Weekly CAB',
      start: '2026-11-10 15:00:00',
      end: '2026-11-10 16:00:00',
      board_groups: e.sys.first('sys_user_group', 'name=CAB Approval')!.sysId,
    });
    expect(refreshAgenda(e.sys, meeting)).toBe(1);
    expect(refreshAgenda(e.sys, meeting)).toBe(0);
    expect(reload(e, c.sysId).str('cab_date')).toBe('2026-11-10');
    expect(e.sys.count(T.attendee, `meeting=${meeting.sysId}`)).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('demo data', () => {
  it('loads about 25 changes across types and states', () => {
    const p = bootPlatform([changeModule], { demo: true });
    env = { p, sys: p.systemContext(), network: '', users: {} };
    const sys = env.sys;
    expect(sys.count(T.change)).toBeGreaterThanOrEqual(25);
    for (const type of ['normal', 'standard', 'emergency'])
      expect(sys.count(T.change, `type=${type}`)).toBeGreaterThan(0);
    for (const state of [
      STATE.NEW,
      STATE.ASSESS,
      STATE.AUTHORIZE,
      STATE.SCHEDULED,
      STATE.IMPLEMENT,
      STATE.REVIEW,
      STATE.CLOSED,
      STATE.CANCELED,
    ]) {
      expect(sys.count(T.change, `state=${state}`)).toBeGreaterThan(0);
    }
    expect(sys.first(T.blackout, 'name=End-of-quarter finance freeze')).not.toBeNull();
    expect(sys.count(T.agendaItem)).toBeGreaterThan(0);
    expect(sys.count(T.producer)).toBe(5);
    expect(sys.count(T.pipeline)).toBe(2);
    expect(p.errors).toEqual([]);
  });

  it.runIf(APPROVALS_AVAILABLE)(
    'creates approvals for demo changes when the approvals service exists',
    () => {
      const p = bootPlatform([approvalsModule, changeModule], { demo: true });
      env = { p, sys: p.systemContext(), network: '', users: {} };
      expect(p.errors).toEqual([]);
      expect(env.sys.count('sysapproval_approver', 'state=requested')).toBeGreaterThan(0);
      expect(env.sys.count(T.change, `state=${STATE.CLOSED}`)).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------

describe('Change Management REST API', () => {
  let p: Platform;
  let app: FastifyInstance;
  let dir: string;
  const basic = (u: string, pw = 'Password1!') => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
  let AGENT = '';
  let MANAGER = '';
  let groupId = '';
  let templateId = '';

  beforeAll(async () => {
    p = bootPlatform([changeModule]);
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-change-'));
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
    makeUser(p, 'api.agent', ['itil'], ['Network Ops']);
    makeUser(p, 'api.manager', ['itil', 'change_manager'], ['Change Management']);
    makeUser(p, 'api.nobody', []);
    AGENT = basic('api.agent');
    MANAGER = basic('api.manager');
    const sys = p.systemContext();
    groupId = sys.first('sys_user_group', 'name=Network Ops')!.sysId;
    templateId = createTemplate(sys, {
      name: 'Restart an application service',
      values: {
        short_description: 'Restart an application service',
        implementation_plan: 'Restart it',
        risk: 4,
        category: 'Software',
      },
      tasks: [{ name: 'Restart and verify', values: { change_task_type: 'implementation' } }],
    }).sysId;
  });

  afterAll(async () => {
    await app.close();
    p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, auth = AGENT, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: auth,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const create = async (payload: Record<string, unknown>) =>
    (await call('POST', '/api/sn_chg_rest/change', AGENT, payload)).json().result;

  it('requires authentication and roles', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sn_chg_rest/change' })).statusCode).toBe(401);
    expect((await call('GET', '/api/sn_chg_rest/change', basic('api.nobody'))).statusCode).toBe(403);
  });

  it('creates a normal change from the generic endpoint', async () => {
    const r = await call('POST', '/api/sn_chg_rest/v1/change', AGENT, {
      chg_model: 'Normal',
      short_description: 'Rotate TLS certificates on web tier',
      cmdb_ci: CI_WEB,
      assignment_group: groupId,
      start_date: '2026-11-07 08:00:00',
      end_date: '2026-11-07 10:00:00',
      favorite_color: 'blue',
    });
    expect(r.statusCode).toBe(200);
    const rec = r.json().result;
    expect(rec.number.value).toMatch(/^CHG\d{7}$/);
    expect(rec.type).toEqual({ value: 'normal', display_value: 'Normal' });
    expect(rec.chg_model).toEqual({ value: MODEL_IDS.normal, display_value: 'Normal' });
    expect(rec.state).toEqual({ value: -5, display_value: 'New' });
    expect(rec.approval).toEqual({ value: 'not requested', display_value: 'Not Yet Requested' });
    expect(rec.risk).toEqual({ value: '', display_value: '' });
    expect(rec.impact).toEqual({ value: 3, display_value: '3 - Low' });
    expect(rec.conflict_status).toEqual({ value: 'Not Run', display_value: 'Not Run' });
    expect(rec.active).toEqual({ value: true, display_value: 'true' });
    expect(rec.start_date).toEqual({
      value: '2026-11-07 08:00:00',
      display_value: '2026-11-07 08:00:00',
      display_value_internal: '2026-11-07 08:00:00',
    });
    expect(rec.__meta).toEqual({ ignoredFields: ['favorite_color'] });
  });

  it('creates normal and emergency changes and reads them back by type', async () => {
    const n = await call(
      'POST',
      `/api/sn_chg_rest/change/normal?short_description=Normal%20via%20query&assignment_group=${groupId}`,
    );
    expect(n.statusCode).toBe(200);
    expect(n.json().result.type.value).toBe('normal');
    const em = (
      await call('POST', '/api/sn_chg_rest/change/emergency', AGENT, {
        short_description: 'Emergency via body',
        type: 'normal',
      })
    ).json().result;
    expect(em.type.value).toBe('emergency');
    expect(em.state.value).toBe(-5);
    expect(em.__meta.ignoredFields).toEqual(['type']);
    const got = await call('GET', `/api/sn_chg_rest/change/emergency/${em.sys_id.value}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().result.short_description.value).toBe('Emergency via body');
    expect((await call('GET', `/api/sn_chg_rest/change/normal/${em.sys_id.value}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/sn_chg_rest/change/${em.sys_id.value}`)).statusCode).toBe(200);
    expect((await call('GET', '/api/sn_chg_rest/change/ffffffffffffffffffffffffffffffff')).statusCode).toBe(
      404,
    );
    const patched = await call('PATCH', `/api/sn_chg_rest/change/emergency/${em.sys_id.value}`, AGENT, {
      description: 'Updated by type path',
    });
    expect(patched.json().result.description.value).toBe('Updated by type path');
  });

  it('creates standard changes from templates', async () => {
    const r = await call(
      'POST',
      `/api/sn_chg_rest/change/standard/${templateId}?cmdb_ci=${CI_WEB}&implementation_plan=skip%20steps&assignment_group=${groupId}`,
    );
    expect(r.statusCode).toBe(200);
    const rec = r.json().result;
    expect(rec.type.value).toBe('standard');
    expect(rec.state.value).toBe(-5);
    expect(rec.std_change_producer_version.value).not.toBe('');
    expect(rec.implementation_plan.value).toBe('Restart it');
    expect(rec.__meta.ignoredFields).toEqual(['implementation_plan']);
    const tasks = (await call('GET', `/api/sn_chg_rest/change/${rec.sys_id.value}/task`)).json().result;
    expect(tasks.map((t: { short_description: { value: string } }) => t.short_description.value)).toEqual([
      'Restart and verify',
    ]);
    expect(
      (await call('POST', '/api/sn_chg_rest/change/standard/ffffffffffffffffffffffffffffffff')).statusCode,
    ).toBe(404);
    const templates = (await call('GET', '/api/sn_chg_rest/change/standard/template')).json().result;
    expect(templates[0].template.display_value).toBe('Restart an application service');
    expect(
      (await call('GET', `/api/sn_chg_rest/change/standard/template/${templateId}`)).json().result.name.value,
    ).toBe('Restart an application service');
    expect(
      (await call('GET', `/api/sn_chg_rest/change/standard?sysparm_query=sys_id=${rec.sys_id.value}`)).json()
        .result,
    ).toHaveLength(1);
  });

  it('updates changes, reports invalid moves with 400 and lists next states', async () => {
    const id = (await create({ type: 'normal', short_description: 'No group yet' })).sys_id.value;
    const noGroup = await call('PATCH', `/api/sn_chg_rest/change/${id}`, AGENT, { state: 'assess' });
    expect(noGroup.statusCode).toBe(400);
    expect(noGroup.json()).toEqual({
      error: { message: 'Mandatory fields must be populated: Assignment group', detail: '' },
      status: 'failure',
    });
    const jump = await call('PATCH', `/api/sn_chg_rest/change/${id}`, AGENT, { state: 'implement' });
    expect(jump.statusCode).toBe(400);
    expect(jump.json().error).toEqual({
      message: 'Invalid state transition',
      detail: 'Change cannot move from New to Implement',
    });
    expect((await call('GET', `/api/sn_chg_rest/change/${id}`)).json().result.state.value).toBe(-5);
    const ok = await call('PATCH', `/api/sn_chg_rest/change/${id}`, AGENT, {
      assignment_group: groupId,
      mystery: 1,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.__meta.ignoredFields).toEqual(['mystery']);
    const assess = (await call('PATCH', `/api/sn_chg_rest/change/${id}`, AGENT, { state: 'assess' })).json()
      .result;
    expect(assess.state).toEqual({ value: -4, display_value: 'Assess' });
    expect(assess.approval.value).toBe('requested');
    const next = (await call('GET', `/api/sn_chg_rest/change/${id}/nextstates`)).json().result;
    expect(next.available_states).toEqual(['-4', '-5', '4']);
    expect(next.state_label['-3']).toBe('Authorize');
    const toAuthorize = next.state_transitions.find((g: { to_state: string }[]) => g[0].to_state === '-3')[0];
    expect(toAuthorize).toMatchObject({
      transition_available: false,
      automatic_transition: true,
      display_value: 'Assess to Authorize',
    });
    expect(toAuthorize.conditions[0]).toMatchObject({
      passed: false,
      condition: { name: 'Approval approved' },
    });
    expect(
      (await call('PATCH', `/api/sn_chg_rest/change/${id}/approvals`, AGENT, { state: 'rejected' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('PATCH', `/api/sn_chg_rest/change/${id}/approvals`, AGENT, { state: 'approved' }))
        .statusCode,
    ).toBe(400);
    const approved = await call('PATCH', `/api/sn_chg_rest/change/${id}/approvals`, MANAGER, {
      state: 'approved',
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().result.state.value).toBe(-3);
  });

  it('returns only the current state for closed changes', async () => {
    const id = (await create({ type: 'normal', short_description: 'Close me', assignment_group: groupId }))
      .sys_id.value;
    await call('PATCH', `/api/sn_chg_rest/change/${id}`, AGENT, { state: 'canceled' });
    const next = (await call('GET', `/api/sn_chg_rest/change/${id}/nextstates`)).json().result;
    expect(next).toEqual({
      available_states: ['4'],
      state_label: { '4': 'Canceled' },
      state_transitions: [],
    });
  });

  it('lists with filters, paging and labels', async () => {
    const byLabel = await call('GET', '/api/sn_chg_rest/change?state=New&sysparm_limit=2');
    const byValue = await call('GET', '/api/sn_chg_rest/change?state=-5&sysparm_limit=2');
    expect(byLabel.statusCode).toBe(200);
    const ids = (r: typeof byLabel) =>
      r.json().result.map((x: { sys_id: { value: string } }) => x.sys_id.value);
    expect(ids(byLabel)).toEqual(ids(byValue));
    expect(Number(byLabel.headers['x-total-count'])).toBeGreaterThan(2);
    expect(String(byLabel.headers.link)).toContain('rel="next"');
    expect((await call('GET', '/api/sn_chg_rest/change?state=-5&sysparm_query=active=true')).statusCode).toBe(
      400,
    );
    const models = (await call('GET', '/api/sn_chg_rest/change/model')).json().result;
    expect(models.map((m: { name: { value: string } }) => m.name.value)).toEqual([
      'Change Registration',
      'Emergency',
      'Normal',
      'Standard',
      'Unauthorized Change',
    ]);
  });

  it('deletes changes as change manager only', async () => {
    const id = (await create({ short_description: 'Delete me' })).sys_id.value;
    expect((await call('DELETE', `/api/sn_chg_rest/change/${id}`)).statusCode).toBe(403);
    const del = await call('DELETE', `/api/sn_chg_rest/change/${id}`, MANAGER);
    expect(del.statusCode).toBe(200);
    expect(del.json().result.short_description.value).toBe('Delete me');
    expect((await call('GET', `/api/sn_chg_rest/change/${id}`)).statusCode).toBe(404);
  });

  it('manages change tasks', async () => {
    const id = (
      await create({
        short_description: 'With tasks',
        assignment_group: groupId,
        start_date: '2026-11-07 08:00:00',
        end_date: '2026-11-07 10:00:00',
      })
    ).sys_id.value;
    const base = `/api/sn_chg_rest/change/${id}/task?short_description=Drain%20node%20A&change_task_type=implementation`;
    expect(
      (
        await call(
          'POST',
          `${base}&planned_start_date=2026-11-07%2007:00:00&planned_end_date=2026-11-07%2007:30:00`,
        )
      ).statusCode,
    ).toBe(400);
    const created = await call(
      'POST',
      `${base}&planned_start_date=2026-11-07%2008:00:00&planned_end_date=2026-11-07%2008:30:00`,
    );
    expect(created.statusCode).toBe(200);
    const task = created.json().result;
    expect(task.parent.value).toBe(id);
    expect(task.change_request.value).toBe(id);
    expect(
      (await call('PATCH', `/api/sn_chg_rest/change/${id}/task/${task.sys_id.value}`, AGENT, { state: 3 }))
        .statusCode,
    ).toBe(400);
    const closed = await call('PATCH', `/api/sn_chg_rest/change/${id}/task/${task.sys_id.value}`, AGENT, {
      state: 3,
      close_code: 'successful',
      close_notes: 'Node drained',
    });
    expect(closed.json().result.state.display_value).toBe('Closed');
    const other = (await create({ short_description: 'Other' })).sys_id.value;
    expect(
      (
        await call('PATCH', `/api/sn_chg_rest/change/${other}/task/${task.sys_id.value}`, AGENT, {
          short_description: 'x',
        })
      ).statusCode,
    ).toBe(404);
    const removed = await call('DELETE', `/api/sn_chg_rest/change/${id}/task/${task.sys_id.value}`, MANAGER);
    expect(removed.json().result.sys_id.value).toBe(task.sys_id.value);
  });

  it('runs, reports and cancels conflict checks', async () => {
    const a = (
      await create({
        short_description: 'A',
        cmdb_ci: CI_DB,
        start_date: '2026-11-20 10:00:00',
        end_date: '2026-11-20 12:00:00',
      })
    ).sys_id.value;
    await create({
      short_description: 'B',
      cmdb_ci: CI_DB,
      start_date: '2026-11-20 11:00:00',
      end_date: '2026-11-20 13:00:00',
    });
    const noCi = (await create({ short_description: 'No CI' })).sys_id.value;
    const refused = await call('POST', `/api/sn_chg_rest/change/${noCi}/conflict`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.detail).toMatch(/planned start date/);
    const run = await call('POST', `/api/sn_chg_rest/change/${a}/conflict`);
    expect(run.statusCode).toBe(200);
    expect(run.json().result).toMatch(/^[0-9a-f]{32}$/);
    const status = (await call('GET', `/api/sn_chg_rest/change/${a}/conflict`)).json().result;
    expect(status).toMatchObject({ status: 'Conflict', record_count: '1', job_status: '2' });
    expect(status.conflicts[0].type).toEqual({
      value: 'ci_already_scheduled',
      display_value: 'CI Already Scheduled',
    });
    const cancel = await call('DELETE', `/api/sn_chg_rest/change/${a}/conflict`);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.body).toBe('');
    expect((await call('GET', `/api/sn_chg_rest/change/${a}/conflict`)).json().result).toMatchObject({
      status: 'Not Run',
      job_status: '3',
      conflicts: [],
    });
  });

  it('evaluates risk through the risk endpoint', async () => {
    const id = (
      await create({
        short_description: 'Soon',
        type: 'normal',
        start_date: addMs(nowGlide(), DAY),
        end_date: addMs(nowGlide(), DAY + 3_600_000),
      })
    ).sys_id.value;
    const r = await call('PATCH', `/api/sn_chg_rest/change/${id}/risk`);
    expect(r.statusCode).toBe(200);
    expect(r.json().result.risk).toEqual({ value: 2, display_value: 'High' });
  });

  it('finds free slots through workers', async () => {
    const id = (
      await create({
        short_description: 'Slots',
        cmdb_ci: CI_WEB,
        start_date: addMs(nowGlide(), DAY),
        end_date: addMs(nowGlide(), DAY + 7_200_000),
      })
    ).sys_id.value;
    const w = await call('GET', `/api/sn_chg_rest/change/${id}/schedule`);
    expect(w.statusCode).toBe(202);
    const worker = w.json().result;
    expect(worker.state).toEqual({ value: 1, display_value: 'Waiting' });
    expect(worker.type).toBe('schedule');
    expect(worker.worker.link).toBe(
      `https://resolvrnow.test/api/sn_chg_rest/change/worker/${worker.worker.sysId}`,
    );
    p.drain();
    const done = (await call('GET', `/api/sn_chg_rest/change/worker/${worker.worker.sysId}`)).json().result;
    expect(done.state.value).toBe(3);
    expect(done.payload.spans).toHaveLength(100);
    const first = await call('PATCH', `/api/sn_chg_rest/change/${id}/schedule/first_available`, AGENT, {
      duration_in_seconds: 3600,
      planned_start_time: '2027-01-04 08:00:00',
    });
    expect(first.statusCode).toBe(202);
    p.drain();
    const fw = (
      await call('GET', `/api/sn_chg_rest/change/worker/${first.json().result.worker.sysId}`)
    ).json().result;
    expect(fw.messages.infoMessages).toEqual(['Change has been updated']);
    const moved = (await call('GET', `/api/sn_chg_rest/change/${id}`)).json().result;
    expect([moved.start_date.value, moved.end_date.value]).toEqual([
      '2027-01-04 08:00:00',
      '2027-01-04 09:00:00',
    ]);
    expect(
      (await call('PATCH', `/api/sn_chg_rest/change/${id}/schedule/first_available`, AGENT, {})).statusCode,
    ).toBe(400);
    expect((await call('GET', `/api/sn_chg_rest/change/ci/${CI_WEB}/schedule`)).statusCode).toBe(400);
    expect(
      (await call('GET', '/api/sn_chg_rest/change/worker/ffffffffffffffffffffffffffffffff')).statusCode,
    ).toBe(404);
  });

  it('gates pipelines with the change policy', async () => {
    const pipeline = (payload: Record<string, unknown>) =>
      call('POST', '/api/app/change/pipeline', AGENT, payload);
    const auto = await pipeline({
      pipeline: 'northwind-web/deploy',
      build: '1842',
      commit: '9f3c2ab',
      ci: 'web-01',
      short_description: 'Restart web service after deploy',
      risk: 'low',
      template: 'Restart an application service',
      assignment_group: 'Network Ops',
    });
    expect(auto.statusCode).toBe(201);
    expect(auto.json().result).toMatchObject({
      status: 'approved',
      proceed: true,
      decision: 'auto_approved',
      change: { type: 'standard', state: -2, approval: 'approved' },
    });

    const gated = (
      await pipeline({
        pipeline: 'northwind-portal/release',
        build: '311',
        commit: 'c41d07e',
        short_description: 'Release portal 3.8',
        risk: 'moderate',
        template: 'Restart an application service',
        assignment_group: 'Network Ops',
      })
    ).json().result;
    expect(gated).toMatchObject({
      status: 'pending',
      proceed: false,
      decision: 'approval_requested',
      change: { type: 'normal', state: -4 },
    });
    expect((await call('GET', `/api/app/change/pipeline/${gated.sys_id}/status`)).json().result.status).toBe(
      'pending',
    );
    for (let i = 0; i < 2; i++)
      await call('PATCH', `/api/sn_chg_rest/change/${gated.change.sys_id}/approvals`, MANAGER, {
        state: 'approved',
      });
    expect(
      (await call('GET', `/api/app/change/pipeline/${gated.sys_id}/status`)).json().result,
    ).toMatchObject({ status: 'approved', proceed: true });
    const complete = await call('POST', `/api/app/change/pipeline/${gated.sys_id}/complete`, AGENT, {
      result: 'success',
    });
    expect(complete.json().result).toMatchObject({ status: 'completed', change: { state: 3 } });

    expect((await pipeline({ short_description: 'x' })).statusCode).toBe(400);
    expect((await pipeline({ pipeline: 'p', short_description: 'x', risk: 'enormous' })).statusCode).toBe(
      400,
    );
    expect(
      (await call('GET', '/api/app/change/pipeline/ffffffffffffffffffffffffffffffff/status')).statusCode,
    ).toBe(404);
  });

  it('serves the change calendar with blackout windows', async () => {
    const sys = p.systemContext();
    const freeze = sys.insert(T.blackout, {
      name: 'Calendar freeze',
      category: 'hard_freeze',
      source: 'change_request',
    });
    sys.insert(T.span, {
      schedule: freeze.sysId,
      name: 'Freeze',
      start_date_time: '20261228T000000',
      end_date_time: '20261231T000000',
    });
    await create({
      short_description: 'Calendar change',
      risk: 2,
      start_date: '2026-12-29 10:00:00',
      end_date: '2026-12-29 11:00:00',
    });
    const r = await call('GET', '/api/app/change/calendar?from=2026-12-01&to=2027-01-01');
    expect(r.statusCode).toBe(200);
    const cal = r.json().result;
    expect(
      cal.changes.find((c: { short_description: string }) => c.short_description === 'Calendar change'),
    ).toMatchObject({
      risk: 2,
      risk_label: 'High',
      color: '#e53935',
      state_label: 'New',
    });
    expect(cal.blackouts).toContainEqual(
      expect.objectContaining({
        name: 'Calendar freeze',
        start: '2026-12-28 00:00:00',
        end: '2026-12-31 00:00:00',
      }),
    );
    expect((await call('GET', '/api/app/change/calendar?from=2026-12-01&to=2026-11-01')).statusCode).toBe(
      400,
    );
  });

  it('serves and scores the risk questionnaire', async () => {
    const id = (
      await create({
        short_description: 'Questionnaire',
        type: 'normal',
        start_date: '2027-03-01 10:00:00',
        end_date: '2027-03-01 11:00:00',
      })
    ).sys_id.value;
    const q = (await call('GET', `/api/app/change/${id}/risk_assessment`)).json().result;
    expect(q.questions).toHaveLength(5);
    const answers = Object.fromEntries(
      q.questions.map((x: { sys_id: string; options: { value: number }[] }) => [
        x.sys_id,
        x.options[x.options.length - 1].value,
      ]),
    );
    const r = await call('POST', `/api/app/change/${id}/risk_assessment`, AGENT, { answers });
    expect(r.statusCode).toBe(200);
    expect(r.json().result).toMatchObject({
      score: 21.5,
      assessment_risk: 1,
      risk: 1,
      risk_label: 'Very High',
    });
  });
});
