import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import { type ApprovalEngine, approvalsModule } from '../src/modules/approvals/index.js';
import type { NotificationService, OutboundEmail } from '../src/modules/contracts.js';
import {
  durationMs,
  type EvalEnv,
  evaluate,
  type FlowDefinition,
  type FlowEngine,
  flowModule,
  nextRun,
  render,
} from '../src/modules/flow/index.js';
import { platformModule } from '../src/modules/platform/index.js';
import { taskModule } from '../src/modules/task/index.js';
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

let ctx: Context;
let engine: FlowEngine;
let seq = 0;

function boot(): void {
  p = bootPlatform([approvalsModule, flowModule]);
  ctx = p.systemContext();
  engine = p.service<FlowEngine>('flows');
}

const approvals = (platform: Platform) => platform.service<ApprovalEngine>('approvals');

type Def = Partial<FlowDefinition> & { steps: FlowDefinition['steps'] };

function createFlow(def: Def, opts: { status?: string; active?: boolean } = {}): Rec {
  seq++;
  const full = {
    schema: 'resolvr.flow/v1',
    type: 'flow',
    run_as: 'system',
    name: `Test flow ${seq}`,
    internal_name: `test_flow_${seq}`,
    ...def,
  };
  return ctx.insert('sys_hub_flow', {
    name: full.name,
    status: opts.status ?? 'published',
    active: opts.active ?? true,
    resolvr_definition: JSON.stringify(full),
  });
}

const executions = (flow: Rec) =>
  ctx.query('sys_flow_context', {
    query: `flow=${flow.sysId}`,
    orderBy: [{ field: 'sys_created_on', desc: false }],
  });
const only = (flow: Rec) => {
  const list = executions(flow);
  expect(list).toHaveLength(1);
  return list[0];
};
const fresh = (r: Rec) => ctx.get(r.className, r.sysId)!;
const attrs = (c: Rec) => JSON.parse(fresh(c).str('attributes'));
const logMessages = (c: Rec) =>
  ctx
    .query('resolvr_flow_log', { query: `context=${c.sysId}`, orderBy: [{ field: 'sequence', desc: false }] })
    .map((l) => l.str('message'));

describe('pills and expressions', () => {
  const values: Record<string, unknown> = {
    vars: { n: 3, name: 'Ada', list: [1, 2, 3], flag: false },
    steps: { cab: { approval_state: 'approved' } },
  };
  const env: EvalEnv = {
    root: (name) => values[name],
    load: () => null,
    registry: undefined as never,
    macros: { userId: null },
  };

  it('evaluates comparisons, logic and the ternary operator', () => {
    expect(evaluate("steps.cab.approval_state == 'approved' ? -2 : -5", env)).toBe(-2);
    expect(evaluate('vars.n >= 3 && !vars.flag', env)).toBe(true);
    expect(evaluate("vars.name != 'Ada' || vars.n < 2", env)).toBe(false);
    expect(evaluate('vars.list.length', env)).toBe(3);
    expect(evaluate('(vars.n > 1) == true', env)).toBe(true);
    expect(() => evaluate('vars.n + 1', env)).toThrow();
  });

  it('keeps the type of a single pill and interpolates text', () => {
    expect(render('{{vars.n}}', env)).toBe(3);
    expect(render('Hello {{vars.name}}, you have {{vars.n}} items', env)).toBe('Hello Ada, you have 3 items');
    expect(render({ a: ['{{vars.list}}'], b: 'x' }, env)).toEqual({ a: [[1, 2, 3]], b: 'x' });
    expect(render('{{missing.path}}', env)).toBeUndefined();
  });

  it('parses ISO durations and schedules', () => {
    expect(durationMs('PT1H')).toBe(3_600_000);
    expect(durationMs('P3D')).toBe(3 * 86_400_000);
    expect(durationMs('PT1H30M')).toBe(5_400_000);
    expect(durationMs('2 hours')).toBe(7_200_000);
    const after = new Date(Date.UTC(2026, 0, 5, 10, 0, 0)); // a Monday
    expect(nextRun({ type: 'scheduled', repeat: 'daily', at: '09:30' }, after)?.toISOString()).toBe(
      '2026-01-06T09:30:00.000Z',
    );
    expect(
      nextRun(
        { type: 'scheduled', repeat: 'weekly', at: '08:00', days_of_week: ['fri'] },
        after,
      )?.toISOString(),
    ).toBe('2026-01-09T08:00:00.000Z');
    expect(
      nextRun(
        { type: 'scheduled', repeat: 'monthly', at: '00:00', day_of_month: 31 },
        new Date(Date.UTC(2026, 1, 2)),
      )?.toISOString(),
    ).toBe('2026-02-28T00:00:00.000Z');
    expect(nextRun({ type: 'scheduled', repeat: 'interval', every: 'PT15M' }, after)?.toISOString()).toBe(
      '2026-01-05T10:15:00.000Z',
    );
  });
});

describe('definitions and publishing', () => {
  it('seeds the example flow, published with a snapshot', () => {
    boot();
    const f = ctx.getBy('sys_hub_flow', 'internal_name', 'notify_caller_incident_resolved')!;
    expect(f.str('name')).toBe('Notify caller when incident is resolved');
    expect(f.str('status')).toBe('published');
    expect(f.bool('active')).toBe(true);
    expect(f.str('resolvr_trigger_type')).toBe('record');
    expect(f.str('resolvr_trigger_table')).toBe('incident');
    const def = JSON.parse(f.str('resolvr_definition'));
    expect(def.trigger).toMatchObject({ table: 'incident', when: 'updated', condition: 'stateCHANGESTO6' });
    expect(ctx.count('resolvr_flow_snapshot', `flow=${f.sysId}`)).toBe(1);
  });

  it('refuses invalid definitions: bad JSON, unknown actions and more than 50 actions', () => {
    boot();
    expect(() => ctx.insert('sys_hub_flow', { name: 'Broken', resolvr_definition: '{ nope' })).toThrow(
      /not valid JSON/,
    );
    expect(() => createFlow({ steps: [{ id: 'a', type: 'action', action: 'teleport' }] })).toThrow(
      /unknown action "teleport"/,
    );
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`,
      type: 'action',
      action: 'log',
      inputs: { message: 'x' },
    }));
    expect(() => createFlow({ steps: many })).toThrow(/51 action steps; the limit is 50/);
    // biome-ignore lint/suspicious/noThenProperty: `then` is a key of the flow definition format
    expect(() => createFlow({ steps: [{ id: 'x', type: 'if', then: [] }] })).toThrow(/needs a condition/);
    expect(createFlow({ steps: many.slice(0, 50) }).str('status')).toBe('published');
  });

  it('keeps waiting executions on their snapshot when the flow is republished', () => {
    boot();
    clock.freeze('2026-03-02 08:00:00');
    const flow = createFlow({
      steps: [
        { id: 'wait', type: 'wait_duration', duration: 'PT1H' },
        { id: 'v', type: 'set_variables', values: { version: 'one' } },
      ],
    });
    engine.startNow(ctx, flow);
    const c = only(flow);
    expect(fresh(c).str('state')).toBe('WAITING');
    const def = JSON.parse(flow.str('resolvr_definition'));
    def.steps[1].values.version = 'two';
    ctx.update(fresh(flow), { resolvr_definition: JSON.stringify(def) });
    expect(ctx.count('resolvr_flow_snapshot', `flow=${flow.sysId}`)).toBe(2);
    clock.advance(3_600_000);
    p.scheduler.runNow('flow.runner');
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.version).toBe('one');
    engine.startNow(ctx, flow);
    clock.advance(3_600_000);
    p.scheduler.runNow('flow.runner');
    expect(attrs(executions(flow)[1]).vars.version).toBe('two');
  });
});

describe('triggers', () => {
  it('record created: one queued execution after the insert, none when the condition fails', () => {
    boot();
    const flow = createFlow({
      trigger: { type: 'record', table: 'task', when: 'created', condition: 'priority=1' },
      steps: [
        { id: 'log', type: 'action', action: 'log', inputs: { message: 'P1 {{trigger.current.number}}' } },
      ],
    });
    const p1 = ctx.insert('task', { short_description: 'Outage', impact: 1, urgency: 1, priority: 1 });
    ctx.insert('task', { short_description: 'Minor', priority: 3 });
    const c = only(flow);
    expect(c.str('state')).toBe('QUEUED');
    expect(c.str('source_record')).toBe(p1.sysId);
    p.drain();
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(logMessages(c)).toContain(`P1 ${p1.str('number')}`);
  });

  it('writes without business rules (setWorkflow false) do not trigger', () => {
    boot();
    const flow = createFlow({
      trigger: { type: 'record', table: 'task', when: 'created', condition: 'priority=1' },
      steps: [{ id: 'log', type: 'action', action: 'log', inputs: { message: 'x' } }],
    });
    ctx.derive({ workflow: false }).insert('task', { short_description: 'Silent', priority: 1 });
    expect(executions(flow)).toHaveLength(0);
  });

  it('record updated with run once fires only for the first qualifying update', () => {
    boot();
    const flow = createFlow({
      trigger: { type: 'record', table: 'task', when: 'updated', condition: 'state=2', run: 'once' },
      steps: [{ id: 'log', type: 'action', action: 'log', inputs: { message: 'x' } }],
    });
    const t = ctx.insert('task', { short_description: 'Work', state: 1 });
    ctx.update(fresh(t), { state: 2 });
    ctx.update(fresh(t), { state: 3 });
    ctx.update(fresh(t), { state: 2 });
    expect(executions(flow)).toHaveLength(1);
  });

  it('each unique change ignores updates of fields outside the condition; always does not', () => {
    boot();
    const unique = createFlow({
      trigger: { type: 'record', table: 'task', when: 'created_or_updated', condition: 'priority=1' },
      steps: [{ id: 'log', type: 'action', action: 'log', inputs: { message: 'x' } }],
    });
    const always = createFlow({
      trigger: {
        type: 'record',
        table: 'task',
        when: 'created_or_updated',
        condition: 'priority=1',
        run: 'always',
      },
      steps: [{ id: 'log', type: 'action', action: 'log', inputs: { message: 'x' } }],
    });
    const t = ctx.insert('task', { short_description: 'Hot', priority: 1 });
    ctx.update(fresh(t), { short_description: 'Still hot' });
    expect(executions(unique)).toHaveLength(1);
    expect(executions(always)).toHaveLength(2);
  });

  it('if not running skips while an execution waits for the record', () => {
    boot();
    const flow = createFlow({
      trigger: {
        type: 'record',
        table: 'task',
        when: 'updated',
        condition: 'priority=1',
        run: 'if_not_running',
      },
      steps: [{ id: 'wait', type: 'wait_duration', duration: 'PT1H' }],
    });
    const t = ctx.insert('task', { short_description: 'Hot', priority: 2 });
    ctx.update(fresh(t), { priority: 1 });
    p.drain();
    expect(only(flow).str('state')).toBe('WAITING');
    ctx.update(fresh(t), { priority: 1, short_description: 'Hotter' });
    ctx.update(fresh(t), { priority: 2 });
    ctx.update(fresh(t), { priority: 1 });
    expect(executions(flow)).toHaveLength(1);
  });

  it('a flow does not re-trigger itself on the record it updates', () => {
    boot();
    const flow = createFlow({
      trigger: {
        type: 'record',
        table: 'task',
        when: 'created_or_updated',
        condition: 'priority=1',
        run: 'always',
      },
      steps: [
        {
          id: 'touch',
          type: 'action',
          action: 'update_record',
          inputs: { record: '{{trigger.current}}', values: { description: 'Seen by flow' } },
        },
      ],
    });
    const t = ctx.insert('task', { short_description: 'Loop?', priority: 1 });
    p.drain();
    expect(fresh(t).str('description')).toBe('Seen by flow');
    expect(executions(flow)).toHaveLength(1);
  });

  it('scheduled flows run when due and compute their next run', () => {
    boot();
    clock.freeze('2026-04-01 10:00:00');
    const flow = createFlow({
      trigger: { type: 'scheduled', repeat: 'interval', every: 'PT1H' },
      steps: [
        {
          id: 'mk',
          type: 'action',
          action: 'create_record',
          inputs: { table: 'task', values: { short_description: 'Hourly check {{now}}' } },
        },
      ],
    });
    expect(fresh(flow).str('resolvr_next_run')).toBe('2026-04-01 11:00:00');
    p.scheduler.runNow('flow.scheduler');
    expect(executions(flow)).toHaveLength(0);
    clock.advance(3_600_000);
    p.scheduler.runNow('flow.scheduler');
    const c = only(flow);
    expect(c.str('state')).toBe('COMPLETE');
    expect(c.str('calling_source')).toBe('schedule');
    expect(ctx.count('task', 'short_description=Hourly check 2026-04-01 11:00:00')).toBe(1);
    expect(fresh(flow).str('resolvr_next_run')).toBe('2026-04-01 12:00:00');
  });

  it('API start queues an execution with inputs; inactive flows cannot be started', () => {
    boot();
    const flow = createFlow({
      trigger: { type: 'api' },
      inputs: [
        { name: 'title', mandatory: true },
        { name: 'priority', default: 4 },
      ],
      steps: [
        {
          id: 'mk',
          type: 'action',
          action: 'create_task',
          inputs: { values: { short_description: '{{inputs.title}}', priority: '{{inputs.priority}}' } },
        },
      ],
    });
    const c = engine.start(ctx, flow.str('internal_name'), null, { title: 'From the API' })!;
    expect(c.str('state')).toBe('QUEUED');
    p.drain();
    expect(fresh(c).str('state')).toBe('COMPLETE');
    const made = ctx.first('task', 'short_description=From the API')!;
    expect(made.str('priority')).toBe('4');
    expect(() => engine.start(ctx, flow.sysId, null, {})).toThrow(/input "title" is required/);
    const off = createFlow({ steps: [] }, { active: false });
    expect(engine.start(ctx, off.sysId, null)).toBeNull();
  });
});

describe('actions', () => {
  it('creates, looks up and updates records with data pills', () => {
    boot();
    const flow = createFlow({
      trigger: {
        type: 'record',
        table: 'task',
        when: 'created',
        condition: 'short_descriptionSTARTSWITHParent',
      },
      steps: [
        {
          id: 'child',
          type: 'action',
          action: 'create_task',
          inputs: {
            values: {
              short_description: 'Child of {{trigger.record.number}}',
              parent: '{{trigger.current}}',
            },
          },
        },
        {
          id: 'find',
          type: 'action',
          action: 'look_up_record',
          inputs: { table: 'task', query: 'parent={{trigger.current.sys_id}}' },
        },
        {
          id: 'upd',
          type: 'action',
          action: 'update_record',
          inputs: {
            record: '{{steps.find.record}}',
            values: {
              description: 'Found {{steps.find.found}} via {{steps.child.record.number}}',
              priority: 2,
            },
          },
        },
        {
          id: 'all',
          type: 'action',
          action: 'look_up_records',
          inputs: { table: 'task', query: 'short_descriptionLIKEChild', order_by: '-number' },
        },
        {
          id: 'v',
          type: 'set_variables',
          values: { count: '{{steps.all.count}}', parent_desc: '{{trigger.current.short_description}}' },
        },
      ],
    });
    const parent = ctx.insert('task', { short_description: 'Parent work' });
    p.drain();
    const c = only(flow);
    expect(fresh(c).str('state')).toBe('COMPLETE');
    const child = ctx.first('task', `parent=${parent.sysId}`)!;
    expect(child.str('short_description')).toBe(`Child of ${parent.str('number')}`);
    expect(child.str('description')).toBe(`Found true via ${child.str('number')}`);
    expect(child.str('priority')).toBe('2');
    expect(attrs(c).vars).toEqual({ count: 1, parent_desc: 'Parent work' });
    expect(attrs(c).steps.child.record).toEqual({ $table: 'task', $sys_id: child.sysId });
  });

  it('adds comments and work notes, deletes records and fires events', () => {
    boot();
    const target = ctx.insert('task', { short_description: 'Notes here' });
    const doomed = ctx.insert('task', { short_description: 'Delete me' });
    const flow = createFlow({
      steps: [
        {
          id: 'c',
          type: 'action',
          action: 'add_comment',
          inputs: { record: { table: 'task', sys_id: target.sysId }, text: 'Customer visible' },
        },
        {
          id: 'w',
          type: 'action',
          action: 'add_work_note',
          inputs: { record: { table: 'task', sys_id: target.sysId }, text: 'Internal' },
        },
        {
          id: 'd',
          type: 'action',
          action: 'delete_record',
          inputs: { record: { table: 'task', sys_id: doomed.sysId } },
        },
        {
          id: 'e',
          type: 'action',
          action: 'fire_event',
          inputs: {
            name: 'custom.flow.event',
            record: { table: 'task', sys_id: target.sysId },
            parm1: 'one',
          },
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('COMPLETE');
    const journal = p.history.journal('task', target.sysId).map((j) => `${j.element}:${j.value}`);
    expect(journal).toEqual(expect.arrayContaining(['comments:Customer visible', 'work_notes:Internal']));
    expect(ctx.get('task', doomed.sysId)).toBeNull();
    expect(ctx.count('sysevent', `name=custom.flow.event^instance=${target.sysId}^parm1=one`)).toBe(1);
  });

  it('logs to the execution log and the system log', () => {
    boot();
    const flow = createFlow({
      steps: [{ id: 'l', type: 'log', inputs: { level: 'warn', message: 'Heads up {{now}}' } }],
    });
    clock.freeze('2026-05-01 12:00:00');
    const c = engine.startNow(ctx, flow);
    expect(logMessages(c)).toContain('Heads up 2026-05-01 12:00:00');
    expect(ctx.count('syslog', 'level=warn^message=Heads up 2026-05-01 12:00:00')).toBe(1);
  });

  it('send notification queues an event without the notifications module and emails through it when present', () => {
    boot();
    const caller = makeUser(p, 'cal.ler');
    const t = ctx.insert('task', { short_description: 'Printer', opened_by: caller });
    const flow = createFlow({
      variables: [{ name: 'ref', default: 'your printer' }],
      steps: [
        {
          id: 'n',
          type: 'action',
          action: 'send_notification',
          inputs: {
            record: { table: 'task', sys_id: t.sysId },
            to: ['{{trigger.current.opened_by}}', caller],
            subject: 'About {{vars.ref}}',
            body: 'Hi',
            event: 'task.notice',
          },
        },
      ],
    });
    engine.startNow(ctx, flow);
    expect(
      ctx.count('sysevent', `name=task.notice^instance=${t.sysId}^parm1=${caller}^parm2=About your printer`),
    ).toBe(1);

    const sent: OutboundEmail[] = [];
    const fake: NotificationService = {
      send: (_c, email) => {
        sent.push(email);
        return null;
      },
      render: (_c, s) => s,
    };
    p.services.set('notifications', fake);
    const c = engine.startNow(ctx, flow);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: [caller], subject: 'About your printer', body: 'Hi' });
    expect(sent[0].target?.sysId).toBe(t.sysId);
    expect(attrs(c).steps.n.sent).toBe(false);
  });

  it('runs actions registered by other modules', () => {
    boot();
    engine.registerAction('stamp_task', (actx, inputs, record) => {
      actx.update(record!, { description: `stamped ${String(inputs.mark)}` });
      return { stamped: true, record };
    });
    const t = ctx.insert('task', { short_description: 'Stamp me' });
    const flow = createFlow({
      steps: [
        {
          id: 's',
          type: 'action',
          action: 'stamp_task',
          inputs: { record: { table: 'task', sys_id: t.sysId }, mark: 'A1' },
        },
        {
          id: 'v',
          type: 'set_variables',
          values: { ok: '{{steps.s.stamped}}', num: '{{steps.s.record.number}}' },
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(fresh(t).str('description')).toBe('stamped A1');
    expect(attrs(c).vars).toEqual({ ok: true, num: t.str('number') });
  });
});

describe('flow logic', () => {
  it('branches with if / else if / else', () => {
    boot();
    const flow = createFlow({
      trigger: { type: 'api' },
      inputs: [{ name: 'score' }],
      steps: [
        {
          id: 'grade',
          type: 'if',
          condition: { all: [{ left: '{{inputs.score}}', op: '>=', right: 90 }] },
          // biome-ignore lint/suspicious/noThenProperty: `then` is a key of the flow definition format
          then: [{ id: 'a', type: 'set_variables', values: { grade: 'A' } }],
          else_if: [
            {
              condition: '{{inputs.score >= 50}}',
              steps: [{ id: 'b', type: 'set_variables', values: { grade: 'B' } }],
            },
          ],
          else: [{ id: 'c', type: 'set_variables', values: { grade: 'C' } }],
        },
        { id: 'after', type: 'set_variables', values: { done: true } },
      ],
    });
    const grade = (score: number) => attrs(engine.startNow(ctx, flow, { inputs: { score } })).vars;
    expect(grade(95)).toEqual({ grade: 'A', done: true });
    expect(grade(70)).toEqual({ grade: 'B', done: true });
    expect(grade(10)).toEqual({ grade: 'C', done: true });
  });

  it('loops over looked-up records with for each and ends early with end', () => {
    boot();
    for (const n of [1, 2, 3]) ctx.insert('task', { short_description: `Batch ${n}`, priority: 4 });
    const flow = createFlow({
      steps: [
        {
          id: 'find',
          type: 'action',
          action: 'look_up_records',
          inputs: { table: 'task', query: 'short_descriptionSTARTSWITHBatch', order_by: 'short_description' },
        },
        {
          id: 'each',
          type: 'for_each',
          items: '{{steps.find.records}}',
          as: 'task',
          steps: [
            {
              id: 'bump',
              type: 'action',
              action: 'update_record',
              inputs: {
                record: '{{task}}',
                values: { priority: 2, description: 'Item {{loop.index}} of {{loop.count}}' },
              },
            },
          ],
        },
        { id: 'stop', type: 'end', status: 'complete' },
        { id: 'never', type: 'set_variables', values: { reached: true } },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('COMPLETE');
    expect(ctx.count('task', 'short_descriptionSTARTSWITHBatch^priority=2')).toBe(3);
    expect(ctx.first('task', 'short_description=Batch 3')!.str('description')).toBe('Item 2 of 3');
    expect(attrs(c).steps.each.iterations).toBe(3);
    expect(attrs(c).vars.reached).toBeUndefined();
  });

  it('repeats with do until', () => {
    boot();
    const flow = createFlow({
      variables: [{ name: 'n', default: 0 }],
      steps: [
        {
          id: 'loop',
          type: 'do_until',
          condition: '{{vars.n >= 3}}',
          steps: [
            {
              id: 'inc',
              type: 'if',
              condition: '{{vars.n == 0}}',
              // biome-ignore lint/suspicious/noThenProperty: `then` is a key of the flow definition format
              then: [{ id: 's1', type: 'set_variables', values: { n: 1 } }],
              else_if: [
                {
                  condition: '{{vars.n == 1}}',
                  steps: [{ id: 's2', type: 'set_variables', values: { n: 2 } }],
                },
                {
                  condition: '{{vars.n == 2}}',
                  steps: [{ id: 's3', type: 'set_variables', values: { n: 3 } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.n).toBe(3);
    expect(attrs(c).steps.loop.iterations).toBe(3);
  });

  it('for each over more than 1000 items ends in error', () => {
    boot();
    const flow = createFlow({
      variables: [{ name: 'big', default: Array.from({ length: 1001 }, (_, i) => i) }],
      steps: [
        {
          id: 'each',
          type: 'for_each',
          items: '{{vars.big}}',
          steps: [{ id: 'x', type: 'set_variables', values: { last: '{{item}}' } }],
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('ERROR');
    expect(c.str('error_message')).toMatch(/1001 items; the limit is 1000 iterations/);
  });

  it('an end step with an error status fails the execution', () => {
    boot();
    const flow = createFlow({
      steps: [{ id: 'bad', type: 'end', status: 'error', message: 'Nope {{now}}' }],
    });
    clock.freeze('2026-06-01 00:00:00');
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('ERROR');
    expect(c.str('error_message')).toBe('Nope 2026-06-01 00:00:00');
  });
});

describe('waits', () => {
  it('wait for duration resumes from the runner job no earlier than the duration', () => {
    boot();
    clock.freeze('2026-02-02 09:00:00');
    const flow = createFlow({
      steps: [
        { id: 'w', type: 'wait_duration', duration: 'PT1H' },
        { id: 'done', type: 'set_variables', values: { at: '{{now}}' } },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('WAITING');
    expect(c.str('resolvr_wake_at')).toBe('2026-02-02 10:00:00');
    clock.advance(59 * 60_000);
    p.scheduler.runNow('flow.runner');
    expect(fresh(c).str('state')).toBe('WAITING');
    clock.advance(60_000);
    p.scheduler.runNow('flow.runner');
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.at).toBe('2026-02-02 10:00:00');
    expect(attrs(c).steps.w.resumed_at).toBe('2026-02-02 10:00:00');
  });

  it('wait for condition resumes when the record is updated to match', () => {
    boot();
    clock.freeze('2026-02-02 09:00:00');
    const flow = createFlow({
      trigger: { type: 'record', table: 'task', when: 'created' },
      steps: [
        {
          id: 'w',
          type: 'wait_condition',
          record: '{{trigger.current}}',
          condition: 'state=3',
          timeout: 'P1D',
        },
        { id: 'v', type: 'set_variables', values: { timed_out: '{{steps.w.timed_out}}' } },
      ],
    });
    const t = ctx.insert('task', { short_description: 'Watch me' });
    p.drain();
    const c = only(flow);
    expect(fresh(c).str('state')).toBe('WAITING');
    ctx.update(fresh(t), { short_description: 'Still open' });
    p.drain();
    expect(fresh(c).str('state')).toBe('WAITING');
    clock.advance(2 * 3_600_000);
    ctx.update(fresh(t), { state: 3 });
    p.drain();
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.timed_out).toBe(false);
  });

  it('wait for condition times out', () => {
    boot();
    clock.freeze('2026-02-02 09:00:00');
    const t = ctx.insert('task', { short_description: 'Slow' });
    const flow = createFlow({
      steps: [
        {
          id: 'w',
          type: 'action',
          action: 'wait_for_condition',
          inputs: { record: { table: 'task', sys_id: t.sysId }, condition: 'state=3', timeout: 'PT2H' },
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('WAITING');
    clock.advance(2 * 3_600_000 + 1000);
    p.scheduler.runNow('flow.runner');
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).steps.w.timed_out).toBe(true);
  });

  it('create task can wait for the task to complete', () => {
    boot();
    const flow = createFlow({
      steps: [
        {
          id: 'task',
          type: 'action',
          action: 'create_task',
          inputs: { values: { short_description: 'Do the thing' }, wait_for_completion: true },
        },
        { id: 'v', type: 'set_variables', values: { closed: '{{steps.task.record.state}}' } },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('WAITING');
    const task = ctx.first('task', 'short_description=Do the thing')!;
    ctx.update(task, { state: 3 });
    p.drain();
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.closed).toBe(3);
  });

  it('waiting executions survive a restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-flow-'));
    const dbFile = join(dir, 'flows.db');
    const make = () =>
      new Platform({
        dbFile,
        modules: [platformModule, taskModule, approvalsModule, flowModule],
        strict: true,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }).boot();
    clock.reset();
    process.env.RESOLVRNOW_ADMIN_PASSWORD = 'admin-test-pw';
    p = make();
    ctx = p.systemContext();
    engine = p.service<FlowEngine>('flows');
    clock.freeze('2026-02-02 09:00:00');
    const flow = createFlow({
      steps: [
        { id: 'w', type: 'wait_duration', duration: 'PT30M' },
        {
          id: 'mk',
          type: 'action',
          action: 'create_task',
          inputs: { values: { short_description: 'After restart' } },
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('WAITING');
    p.close();
    p = make();
    ctx = p.systemContext();
    clock.advance(31 * 60_000);
    p.scheduler.runNow('flow.runner');
    expect(ctx.get('sys_flow_context', c.sysId)!.str('state')).toBe('COMPLETE');
    expect(ctx.count('task', 'short_description=After restart')).toBe(1);
  });
});

describe('approvals in flows', () => {
  it('waits for an approval decision and branches on the outcome', () => {
    boot();
    const mgr = makeUser(p, 'mia.manager');
    const flow = createFlow({
      trigger: {
        type: 'record',
        table: 'task',
        when: 'created',
        condition: 'short_descriptionSTARTSWITHBuy',
      },
      steps: [
        {
          id: 'ask',
          type: 'action',
          action: 'ask_for_approval',
          inputs: {
            record: '{{trigger.current}}',
            approvers: { users: [mgr] },
            rule: { type: 'first_response' },
          },
        },
        {
          id: 'chk',
          type: 'if',
          condition: { all: [{ left: '{{steps.ask.approval_state}}', op: '=', right: 'approved' }] },
          // biome-ignore lint/suspicious/noThenProperty: `then` is a key of the flow definition format
          then: [
            {
              id: 'go',
              type: 'action',
              action: 'update_record',
              inputs: {
                record: '{{trigger.current}}',
                values: { state: '{{steps.ask.approval_state == "approved" ? 2 : 4}}' },
              },
            },
          ],
          else: [
            {
              id: 'no',
              type: 'action',
              action: 'update_record',
              inputs: {
                record: '{{trigger.current}}',
                values: { state: 4, work_notes: 'Rejected by manager' },
              },
            },
          ],
        },
      ],
    });
    const t = ctx.insert('task', { short_description: 'Buy a monitor' });
    p.drain();
    const c = only(flow);
    expect(fresh(c).str('state')).toBe('WAITING');
    const row = ctx.first('sysapproval_approver', `document_id=${t.sysId}`)!;
    expect(row.str('approval_source')).toBe('flow');
    expect(row.str('flow_context')).toBe(c.sysId);
    expect(fresh(t).str('approval')).toBe('requested');
    approvals(p).decide(p.contextAs('mia.manager'), row, 'approved', 'Fine');
    p.drain();
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).steps.ask.approval_state).toBe('approved');
    expect(fresh(t).str('state')).toBe('2');
    expect(fresh(t).str('approval')).toBe('approved');
  });

  it('group percentage approval with a due date rejects when nobody answers in time', () => {
    boot();
    clock.freeze('2026-02-02 09:00:00');
    for (const u of ['cab.a', 'cab.b', 'cab.c', 'cab.d']) makeUser(p, u, [], ['CAB Approval']);
    const flow = createFlow({
      steps: [
        {
          id: 'grp',
          type: 'action',
          action: 'look_up_record',
          inputs: { table: 'sys_user_group', query: 'name=CAB Approval' },
        },
        {
          id: 'cab',
          type: 'action',
          action: 'ask_for_approval',
          inputs: {
            record: '{{trigger.current}}',
            approvers: { groups: ['{{steps.grp.record}}'] },
            group_rule: { type: 'percentage', percentage: 50 },
            due: 'P3D',
            on_due: 'reject',
          },
        },
        { id: 'v', type: 'set_variables', values: { outcome: '{{steps.cab.approval_state}}' } },
      ],
    });
    const change = ctx.insert('task', { short_description: 'Core switch replacement' });
    const c = engine.startNow(ctx, flow, { record: change });
    expect(c.str('state')).toBe('WAITING');
    const group = ctx.first('sysapproval_group', `parent=${change.sysId}`)!;
    expect(group.str('resolvr_wait_for')).toBe('percentage');
    expect(ctx.count('sysapproval_approver', `group=${group.sysId}^state=requested`)).toBe(4);
    approvals(p).decide(
      p.contextAs('cab.a'),
      ctx.first('sysapproval_approver', `group=${group.sysId}^approver.user_name=cab.a`)!,
      'approved',
    );
    p.drain();
    expect(fresh(c).str('state')).toBe('WAITING');
    clock.advance(3 * 86_400_000 + 60_000);
    p.scheduler.runNow('approvals.due');
    p.drain();
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.outcome).toBe('rejected');
    expect(ctx.count('sysapproval_approver', `group=${group.sysId}^state=not_required`)).toBe(3);
    expect(fresh(change).str('approval')).toBe('rejected');
  });

  it('cancelling a waiting execution cancels its pending approvals', () => {
    boot();
    const mgr = makeUser(p, 'max.manager');
    const t = ctx.insert('task', { short_description: 'Laptop' });
    const flow = createFlow({
      steps: [
        {
          id: 'ask',
          type: 'action',
          action: 'ask_for_approval',
          inputs: { record: '{{trigger.current}}', approvers: [mgr] },
        },
      ],
    });
    const c = engine.startNow(ctx, flow, { record: t });
    expect(c.str('state')).toBe('WAITING');
    expect(engine.cancel(ctx, c.sysId, 'No longer needed')).toBe(true);
    p.drain();
    expect(fresh(c).str('state')).toBe('CANCELLED');
    expect(ctx.first('sysapproval_approver', `document_id=${t.sysId}`)!.str('state')).toBe('cancelled');
    expect(engine.cancel(ctx, c.sysId)).toBe(false);
  });
});

describe('errors', () => {
  it('a failing step runs the error handler and marks the execution errored', () => {
    boot();
    const t = ctx.insert('task', { short_description: 'Short lived' });
    const flow = createFlow({
      steps: [
        {
          id: 'del',
          type: 'action',
          action: 'delete_record',
          inputs: { record: { table: 'task', sys_id: t.sysId } },
        },
        {
          id: 'upd',
          type: 'action',
          action: 'update_record',
          inputs: { record: { table: 'task', sys_id: t.sysId }, values: { priority: 1 } },
        },
        { id: 'never', type: 'set_variables', values: { reached: true } },
      ],
      error_handler: [
        {
          id: 'err',
          type: 'action',
          action: 'log',
          inputs: { level: 'error', message: 'Failed at {{error.step}}: {{error.message}}' },
        },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('ERROR');
    expect(c.str('error_message')).toMatch(/^Step "upd" failed: Record not found/);
    expect(logMessages(c).some((m) => m.startsWith('Failed at upd: Record not found'))).toBe(true);
    expect(attrs(c).vars.reached).toBeUndefined();
    expect(ctx.count('resolvr_flow_log', `context=${c.sysId}^state=error^step_id=upd`)).toBe(1);
  });

  it('when_error continue records the failure and goes on', () => {
    boot();
    const flow = createFlow({
      steps: [
        {
          id: 'bad',
          type: 'action',
          action: 'create_record',
          when_error: 'continue',
          inputs: { table: 'no_such_table', values: {} },
        },
        { id: 'next', type: 'set_variables', values: { status: '{{steps.bad.status.code}}' } },
      ],
    });
    const c = engine.startNow(ctx, flow);
    expect(c.str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.status).toBe('error');
  });

  it('run as user applies ACLs; run_with_roles grants the missing rights', () => {
    boot();
    makeUser(p, 'ess.user');
    const def = (roles?: string[]): Def => ({
      run_as: 'user',
      run_with_roles: roles,
      trigger: { type: 'api' },
      steps: [
        {
          id: 'mk',
          type: 'action',
          action: 'create_task',
          inputs: { values: { short_description: 'By ESS' } },
        },
      ],
    });
    const c1 = engine.startNow(p.contextAs('ess.user'), createFlow(def()));
    expect(c1.str('state')).toBe('ERROR');
    expect(c1.str('error_message')).toMatch(/Insufficient rights to create record/);
    const c2 = engine.startNow(p.contextAs('ess.user'), createFlow(def(['itil'])));
    expect(c2.str('state')).toBe('COMPLETE');
    expect(ctx.first('task', 'short_description=By ESS')!.str('sys_created_by')).toBe('ess.user');
  });
});

describe('REST', () => {
  async function server(): Promise<FastifyInstance> {
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-flow-api-'));
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
  const auth = (u: string) => ({
    authorization: `Basic ${Buffer.from(`${u}:Password1!`).toString('base64')}`,
  });
  const json = (u: string) => ({ ...auth(u), 'content-type': 'application/json' });

  it('lists flows, runs one, shows executions and the execution log, and cancels', async () => {
    boot();
    makeUser(p, 'flo.designer', ['flow_designer']);
    makeUser(p, 'no.flows', ['itil']);
    const api = await server();
    const flow = createFlow({
      name: 'Hello flow',
      trigger: { type: 'api' },
      inputs: [{ name: 'who', default: 'world' }],
      steps: [
        { id: 'greet', type: 'action', action: 'log', inputs: { message: 'Hello {{inputs.who}}' } },
        { id: 'w', type: 'wait_duration', duration: 'PT1H' },
      ],
    });

    expect(
      (await api.inject({ method: 'GET', url: '/api/app/flows', headers: auth('no.flows') })).statusCode,
    ).toBe(403);
    const list = await api.inject({ method: 'GET', url: '/api/app/flows', headers: auth('flo.designer') });
    expect(list.statusCode).toBe(200);
    const names = list.json().result.map((f: { name: string }) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Hello flow', 'Notify caller when incident is resolved']));

    const run = await api.inject({
      method: 'POST',
      url: `/api/app/flows/${flow.sysId}/run`,
      headers: json('flo.designer'),
      payload: { inputs: { who: 'Ada' } },
    });
    expect(run.statusCode).toBe(200);
    const detail = run.json().result;
    expect(detail.state).toBe('WAITING');
    expect(detail.logs.map((l: { message: string }) => l.message)).toContain('Hello Ada');

    const execs = await api.inject({
      method: 'GET',
      url: `/api/app/flows/${flow.str('internal_name')}/executions`,
      headers: auth('flo.designer'),
    });
    expect(execs.json().result).toHaveLength(1);
    expect(execs.json().result[0]).toMatchObject({
      sys_id: detail.sys_id,
      state: 'WAITING',
      calling_source: 'manual',
    });

    const one = await api.inject({
      method: 'GET',
      url: `/api/app/flows/contexts/${detail.sys_id}`,
      headers: auth('flo.designer'),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().result.waiting_for).toMatchObject({ kind: 'duration', step: 'w' });
    expect(one.json().result.logs.length).toBeGreaterThanOrEqual(2);

    const cancel = await api.inject({
      method: 'POST',
      url: `/api/app/flows/contexts/${detail.sys_id}/cancel`,
      headers: json('flo.designer'),
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().result.state).toBe('CANCELLED');
    const again = await api.inject({
      method: 'POST',
      url: `/api/app/flows/contexts/${detail.sys_id}/cancel`,
      headers: json('flo.designer'),
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/app/flows/nope/executions',
          headers: auth('flo.designer'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api.inject({
          method: 'POST',
          url: `/api/app/flows/${flow.sysId}/run`,
          headers: json('no.flows'),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('subflows and the API trigger', () => {
  it('calls a subflow with inputs and reads its outputs', () => {
    boot();
    createFlow({
      name: 'Double it',
      internal_name: 'double_it',
      type: 'subflow',
      inputs: [{ name: 'n', mandatory: true }],
      outputs: [{ name: 'result' }],
      steps: [
        {
          id: 'out',
          type: 'assign_outputs',
          values: { result: '{{inputs.n}}{{inputs.n}}', twice: '{{inputs.n == 21}}' },
        },
      ],
    });
    const parent = createFlow({
      steps: [
        { id: 'call', type: 'subflow', subflow: 'double_it', inputs: { n: 21 } },
        {
          id: 'v',
          type: 'set_variables',
          values: { got: '{{steps.call.result}}', ok: '{{steps.call.twice}}' },
        },
      ],
    });
    const c = engine.startNow(ctx, parent);
    expect(c.str('state')).toBe('COMPLETE');
    expect(attrs(c).vars).toEqual({ got: '2121', ok: true });
    expect(() => createFlow({ steps: [{ id: 'o', type: 'assign_outputs', values: { a: 1 } }] })).toThrow(
      /only allowed in subflows/,
    );
  });

  it('waits for a subflow that waits, then continues', () => {
    boot();
    clock.freeze('2026-07-01 08:00:00');
    createFlow({
      internal_name: 'slow_sub',
      type: 'subflow',
      steps: [
        { id: 'w', type: 'wait_duration', duration: 'PT10M' },
        { id: 'o', type: 'assign_outputs', values: { finished: '{{now}}' } },
      ],
    });
    const parent = createFlow({
      steps: [
        { id: 'call', type: 'subflow', subflow: 'slow_sub' },
        { id: 'v', type: 'set_variables', values: { finished: '{{steps.call.finished}}' } },
      ],
    });
    const c = engine.startNow(ctx, parent);
    expect(c.str('state')).toBe('WAITING');
    const child = ctx.first('sys_flow_context', `resolvr_parent=${c.sysId}`)!;
    expect(child.str('state')).toBe('WAITING');
    clock.advance(10 * 60_000);
    p.scheduler.runNow('flow.runner');
    p.drain();
    expect(fresh(child).str('state')).toBe('COMPLETE');
    expect(fresh(c).str('state')).toBe('COMPLETE');
    expect(attrs(c).vars.finished).toBe('2026-07-01 08:10:00');
  });

  it('starts flows callable by the client API through POST /api/app/flow/{internal_name}/start', async () => {
    boot();
    makeUser(p, 'api.caller', ['itil']);
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-flow-api-'));
    app = await buildApp(p, {
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
    const flow = createFlow({
      internal_name: 'open_ticket',
      trigger: { type: 'api' },
      inputs: [{ name: 'title', mandatory: true }],
      steps: [
        {
          id: 'mk',
          type: 'action',
          action: 'create_task',
          inputs: { values: { short_description: '{{inputs.title}}' } },
        },
      ],
    });
    const headers = {
      authorization: `Basic ${Buffer.from('api.caller:Password1!').toString('base64')}`,
      'content-type': 'application/json',
    };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/app/flow/open_ticket/start',
      headers,
      payload: { inputs: { title: 'x' } },
    });
    expect(denied.statusCode).toBe(403);
    ctx.update(fresh(flow), { callable_by_client_api: true });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/app/flow/open_ticket/start',
      headers,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/app/flow/open_ticket/start',
      headers,
      payload: { inputs: { title: 'Opened through the API' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result).toMatchObject({ state: 'COMPLETE', calling_source: 'api' });
    expect(ctx.first('task', 'short_description=Opened through the API')!.str('sys_created_by')).toBe(
      'system',
    );
  });
});

describe('scripts in flows', () => {
  it('runs scripts through the scripts service only in flows last edited by an administrator', () => {
    boot();
    const calls: unknown[] = [];
    p.services.set('scripts', {
      run: (_c: Context, script: string, b?: { vars?: Record<string, unknown> }) => {
        calls.push([script, { ...b?.vars }]);
        return 42;
      },
      condition: () => true,
    });
    const steps = [
      { id: 's', type: 'action', action: 'run_script', inputs: { script: 'answer()' } },
      { id: 'v', type: 'set_variables', values: { r: '{{steps.s.result}}' } },
    ];
    const c = engine.startNow(ctx, createFlow({ variables: [{ name: 'x', default: 1 }], steps }));
    expect(attrs(c).vars).toEqual({ x: 1, r: 42 });
    expect(calls[0]).toEqual(['answer()', { x: 1 }]);

    makeUser(p, 'plain.designer', ['flow_designer']);
    const byDesigner = p.contextAs('plain.designer').insert('sys_hub_flow', {
      name: 'Designer script',
      status: 'published',
      resolvr_definition: JSON.stringify({
        schema: 'resolvr.flow/v1',
        name: 'Designer script',
        internal_name: 'designer_script',
        steps,
      }),
    });
    const refused = engine.startNow(ctx, byDesigner);
    expect(refused.str('state')).toBe('ERROR');
    expect(refused.str('error_message')).toMatch(/only allowed in flows last edited by an administrator/);
  });

  it('waits until a given date-time', () => {
    boot();
    clock.freeze('2026-08-01 10:00:00');
    const c = engine.startNow(
      ctx,
      createFlow({ steps: [{ id: 'w', type: 'wait_duration', until: '2026-08-02 08:00:00' }] }),
    );
    expect(c.str('state')).toBe('WAITING');
    expect(c.str('resolvr_wake_at')).toBe('2026-08-02 08:00:00');
    clock.freeze('2026-08-02 08:00:00');
    p.scheduler.runNow('flow.runner');
    expect(fresh(c).str('state')).toBe('COMPLETE');
  });
});
