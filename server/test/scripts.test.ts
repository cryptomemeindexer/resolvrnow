import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AbortError, AccessError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import type { ScriptService } from '../src/modules/contracts.js';
import {
  ScriptError,
  type ScriptRuntime,
  scriptsModule,
  scriptsReady,
} from '../src/modules/scripts/index.js';
import { sandboxEngine } from '../src/modules/scripts/sandbox.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let rt: ScriptRuntime;
let sys: Context;
let agentId: string;
const created: { table: string; id: string }[] = [];

function run(source: string, ctx: Context = p.systemContext()): { value: unknown; output: string[] } {
  return rt.execute({ ctx, source, file: 'test.js', label: 'Test script' });
}

function track(table: string, values: Record<string, unknown>): Rec {
  const rec = sys.insert(table, values);
  created.push({ table, id: rec.sysId });
  return rec;
}

function addRule(values: Record<string, unknown>): string {
  return track('sys_script', { active: true, order: 100, when: 'before', ...values }).sysId;
}

function task(values: Record<string, unknown>): Rec {
  return sys.insert('task', values);
}

function syslog(query: string): Rec[] {
  return sys.query('syslog', query);
}

beforeAll(async () => {
  p = bootPlatform([scriptsModule]);
  await scriptsReady();
  rt = p.service<ScriptRuntime>('scripts');
  sys = p.systemContext();
  agentId = makeUser(p, 'abel.agent', ['itil'], ['Service Desk']);
  makeUser(p, 'plain.user', []);
  const dept = sys.insert('cmn_department', { name: 'Networking' });
  const dora = makeUser(p, 'dora.walker', ['itil']);
  sys.update(sys.get('sys_user', dora)!, { department: dept.sysId });
  for (let i = 1; i <= 5; i++) {
    task({
      short_description: `QB-${i}`,
      priority: i,
      assigned_to: i === 1 ? dora : null,
      state: i === 5 ? '3' : '1',
    });
  }
});

afterEach(() => {
  for (const { table, id } of created.splice(0).reverse()) {
    const rec = sys.get(table, id);
    if (rec) sys.delete(rec);
  }
  clock.reset();
});

// ------------------------------------------------------------------ basics

describe('sandbox basics', () => {
  it('returns the completion value, or answer when the script sets it', () => {
    expect(run('1 + 2').value).toBe(3);
    expect(run("({ a: [1, 'two', true, null], b: { c: 1.5 } })").value).toEqual({
      a: [1, 'two', true, null],
      b: { c: 1.5 },
    });
    expect(run('answer = 42; 7').value).toBe(42);
    expect(run('var x = 5; x * 2').value).toBe(10);
    expect(run('undefined').value).toBeNull();
  });

  it('collects gs log output and writes syslog rows', () => {
    const r = run(
      "gs.info('Hello {0} and {1}', 'Ada', 'Grace'); gs.warn('careful'); gs.error('broken'); gs.debug('quiet'); console.log('via console', 3); 'done'",
    );
    expect(r.output).toEqual([
      'Hello Ada and Grace',
      '[warn] careful',
      '[error] broken',
      '[debug] quiet',
      'via console 3',
    ]);
    const rows = syslog('source=Test script');
    expect(rows.map((x) => `${x.str('level')}:${x.str('message')}`)).toEqual(
      expect.arrayContaining([
        'info:Hello Ada and Grace',
        'warn:careful',
        'error:broken',
        'info:via console 3',
      ]),
    );
    expect(rows.some((x) => x.str('message') === 'quiet')).toBe(false);
  });

  it('reports syntax and runtime errors with line numbers', () => {
    try {
      run('var a = 1;\nvar b = ;');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError);
      expect((e as ScriptError).kind).toBe('syntax');
      expect((e as ScriptError).line).toBe(2);
    }
    try {
      run('var a = 1;\n\nnull.boom;');
      expect.unreachable();
    } catch (e) {
      expect((e as ScriptError).message).toMatch(/TypeError/);
      expect((e as ScriptError).line).toBe(3);
    }
    expect(() => run("throw new Error('custom failure')")).toThrow(/custom failure/);
  });

  it('isolates scripts from each other', () => {
    run(
      "var leaked = 'yes'; Object.prototype.polluted = 1; Array.prototype.push = null; GlideRecord = null; 1",
    );
    expect(run('[typeof leaked, typeof ({}).polluted, typeof [].push, typeof GlideRecord]').value).toEqual([
      'undefined',
      'undefined',
      'function',
      'function',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ------------------------------------------------------------- GlideRecord

const NAMES =
  'function names(gr) { var out = []; gr.query(); while (gr.next()) out.push(gr.getValue("short_description")); return out.join(","); }\n';

describe('GlideRecord', () => {
  it('inserts, reads, updates and deletes records', () => {
    const id = run(
      "var gr = new GlideRecord('task'); gr.initialize(); gr.short_description = 'Printer on fire'; gr.setValue('priority', 2); gr.insert();",
    ).value as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const rec = sys.get('task', id)!;
    expect(rec.str('short_description')).toBe('Printer on fire');
    expect(rec.num('priority')).toBe(2);
    expect(rec.str('number')).toMatch(/^TASK\d+/);

    const out = run(`
      var gr = new GlideRecord('task');
      gr.get('${id}');
      gr.short_description = 'Printer extinguished';
      var updated = gr.update();
      var check = new GlideRecord('task');
      check.get('${id}');
      var desc = check.getValue('short_description');
      var deleted = check.deleteRecord();
      [updated === '${id}', desc, deleted, new GlideRecord('task').get('${id}')];
    `).value;
    expect(out).toEqual([true, 'Printer extinguished', true, false]);
    expect(sys.get('task', id)).toBeNull();
  });

  it('builds queries like the platform API', () => {
    const q = (body: string) =>
      run(
        `${NAMES}var gr = new GlideRecord('task'); gr.addQuery('short_description', 'STARTSWITH', 'QB-'); ${body}`,
      ).value;
    expect(q('gr.orderBy("short_description"); names(gr)')).toBe('QB-1,QB-2,QB-3,QB-4,QB-5');
    expect(q("gr.addQuery('priority', '<=', 2); gr.orderBy('priority'); names(gr)")).toBe('QB-1,QB-2');
    expect(q("gr.addQuery('priority', 'IN', [1, 3]); gr.orderBy('priority'); names(gr)")).toBe('QB-1,QB-3');
    expect(
      q("gr.addQuery('priority', 1).addOrCondition('priority', 5); gr.orderBy('priority'); names(gr)"),
    ).toBe('QB-1,QB-5');
    expect(q("gr.addEncodedQuery('priority>=4^ORDERBYDESCpriority'); names(gr)")).toBe('QB-5,QB-4');
    expect(q("gr.addActiveQuery(); gr.orderBy('priority'); names(gr)")).toBe('QB-1,QB-2,QB-3,QB-4');
    expect(q("gr.orderByDesc('priority'); gr.setLimit(2); names(gr)")).toBe('QB-5,QB-4');
    expect(q("gr.orderBy('priority'); gr.chooseWindow(1, 3); names(gr)")).toBe('QB-2,QB-3');
    expect(q("gr.addNotNullQuery('assigned_to'); names(gr)")).toBe('QB-1');
    expect(
      q("gr.addNullQuery('assigned_to'); gr.addQuery('short_description', 'CONTAINS', '-4'); names(gr)"),
    ).toBe('QB-4');
    expect(
      q(
        "gr.addQuery('priority', '>', 3); gr.query(); var n = gr.getRowCount(); var first = gr.hasNext(); gr.next(); gr.next(); [n, first, gr.hasNext(), gr.next()]",
      ),
    ).toEqual([2, true, false, false]);
    expect(q("gr.addQuery('short_description', 'QB-2'); gr.getEncodedQuery()")).toBe(
      'short_descriptionSTARTSWITHQB-^short_description=QB-2',
    );
    expect(
      q("gr.query('priority', 3); gr.next(); [gr.getRowCount(), gr.getValue('short_description')]"),
    ).toEqual([1, 'QB-3']);
    expect(
      run("var gr = new GlideRecord('task'); [gr.get('short_description', 'QB-4'), gr.getRowCount()]").value,
    ).toEqual([true, 1]);
  });

  it('reads values, display values and record state', () => {
    const out = run(`
      var gr = new GlideRecord('task');
      var found = gr.get('short_description', 'QB-2');
      [found, gr.getValue('priority'), gr.getDisplayValue('priority'), gr.priority.getDisplayValue(), gr.getUniqueValue() == gr.sys_id.toString(),
       gr.getTableName(), gr.isNewRecord(), gr.isValidRecord(), gr.getValue('active'), gr.active.toString(), gr.active == true,
       gr.priority == 2, gr.getValue('description'), gr.description.nil(), gr.getDisplayValue() == gr.number.toString(), gr.getRecordClassName()];
    `).value;
    expect(out).toEqual([
      true,
      '2',
      '2 - High',
      '2 - High',
      true,
      'task',
      false,
      true,
      '1',
      'true',
      true,
      true,
      null,
      true,
      true,
      'task',
    ]);
    expect(
      run(
        "var gr = new GlideRecord('task'); gr.initialize(); [gr.isNewRecord(), gr.isValidRecord(), gr.getValue('active')]",
      ).value,
    ).toEqual([true, true, '1']);
  });

  it('resolves references by display value and walks references', () => {
    const out = run(`
      var gr = new GlideRecord('task');
      gr.get('short_description', 'QB-1');
      var dept = gr.assigned_to.department;
      [gr.assigned_to.department.name.toString(), gr.assigned_to.getDisplayValue(), gr.getDisplayValue('assigned_to.department'),
       gr.getValue('assigned_to.user_name'), gr.assigned_to.getRefRecord().getValue('user_name'), dept.getRefRecord().name.toString(),
       gr.assigned_to.getReferenceTable(), gr.getElement('assigned_to.department.name').toString()];
    `).value;
    expect(out).toEqual([
      'Networking',
      'dora walker',
      'Networking',
      'dora.walker',
      'dora.walker',
      'Networking',
      'sys_user',
      'Networking',
    ]);
    const id = run(
      "var gr = new GlideRecord('task'); gr.short_description = 'Ref by name'; gr.assigned_to = 'abel.agent'; gr.insert();",
    ).value as string;
    expect(sys.get('task', id)!.str('assigned_to')).toBe(agentId);
    expect(
      run(
        "var gr = new GlideRecord('task'); gr.addNullQuery('assigned_to'); gr.setLimit(1); gr.query(); gr.next(); var r = gr.assigned_to.getRefRecord(); [r.isValidRecord(), gr.assigned_to.department.name.toString()]",
      ).value,
    ).toEqual([false, '']);
    sys.delete(sys.get('task', id)!);
  });

  it('updates and deletes in bulk', () => {
    for (const n of [1, 2, 3]) task({ short_description: `UM-${n}`, priority: 4 });
    const updated = run(
      "var gr = new GlideRecord('task'); gr.addQuery('short_description', 'STARTSWITH', 'UM-'); gr.setValue('description', 'bulk'); gr.updateMultiple();",
    ).value;
    expect(updated).toBe(3);
    expect(
      sys.query('task', 'short_descriptionSTARTSWITHUM-').every((r) => r.str('description') === 'bulk'),
    ).toBe(true);
    const deleted = run(
      "var gr = new GlideRecord('task'); gr.addQuery('short_description', 'STARTSWITH', 'UM-'); gr.deleteMultiple();",
    ).value;
    expect(deleted).toBe(3);
    expect(sys.count('task', 'short_descriptionSTARTSWITHUM-')).toBe(0);
  });

  it('copies a record when insert() is called on an existing one', () => {
    const out = run(
      "var gr = new GlideRecord('task'); gr.get('short_description', 'QB-3'); var old = gr.getUniqueValue(); var copy = gr.insert(); [copy != old, gr.getValue('short_description'), gr.getValue('number') != '']",
    ).value as unknown[];
    expect(out).toEqual([true, 'QB-3', true]);
    const copies = sys.query('task', 'short_description=QB-3');
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((r) => r.str('number'))).size).toBe(2);
    sys.delete(copies[1]);
  });

  it('enforces ACLs only with GlideRecordSecure and canRead()', () => {
    const plain = p.contextAs('plain.user');
    const agent = p.contextAs('abel.agent');
    const script =
      "var a = new GlideRecord('task'); a.addQuery('short_description', 'STARTSWITH', 'QB-'); a.query(); var s = new GlideRecordSecure('task'); s.addQuery('short_description', 'STARTSWITH', 'QB-'); s.query(); var one = new GlideRecord('task'); one.get('short_description', 'QB-1'); [a.getRowCount(), s.getRowCount(), one.canRead(), one.canWrite(), one.canDelete()]";
    expect(run(script, plain).value).toEqual([5, 0, false, false, false]);
    expect(run(script, agent).value).toEqual([5, 5, true, true, false]);
    expect(
      run(
        "var s = new GlideRecordSecure('task'); s.short_description = 'denied'; [s.insert(), s.getLastErrorMessage() != null]",
        plain,
      ).value,
    ).toEqual([null, true]);
  });

  it('rejects invalid tables and never exposes secrets', () => {
    expect(
      run("var g = new GlideRecord('no_such_table'); [g.isValid(), g.insert(), g.get('x')]").value,
    ).toEqual([false, null, false]);
    expect(
      run("var g = new GlideRecord('task; DROP TABLE task'); g.query(); [g.isValid(), g.next()]").value,
    ).toEqual([false, false]);
    expect(
      run(
        "var g = new GlideRecord('sys_user_session'); g.query(); [g.isValid(), g.next(), gs.tableExists('sys_user_session')]",
      ).value,
    ).toEqual([false, false, false]);
    expect(
      run(
        "var u = new GlideRecord('sys_user'); u.get('user_name', 'admin'); [u.isValidField('user_password'), u.getValue('user_password'), u.user_password.toString(), u.getDisplayValue('user_password')]",
      ).value,
    ).toEqual([true, null, '', '']);
    expect(() => run("new GlideRecord('task').addQuery('short_description^ORactive', 'x')")).toThrow(
      /Invalid field name/,
    );
    expect(() => run("new GlideRecord('task').addQuery('priority', 'UNION SELECT', 1)")).toThrow(
      /Invalid query operator/,
    );
    expect(sys.count('task')).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------- business rules

describe('business rules from sys_script', () => {
  it('applies before-rule changes to the record being saved', () => {
    addRule({
      name: 'Default description',
      collection: 'task',
      action_insert: true,
      script:
        "current.description = 'Filed by ' + gs.getUserName() + (previous === null ? ' (new)' : ''); current.setValue('impact', 1);",
    });
    const rec = p.contextAs('abel.agent').insert('task', { short_description: 'BR test' });
    expect(rec.str('description')).toBe('Filed by abel.agent (new)');
    expect(sys.get('task', rec.sysId)!.str('description')).toBe('Filed by abel.agent (new)');
    expect(sys.get('task', rec.sysId)!.num('impact')).toBe(1);
    const viaScript = run(
      "var gr = new GlideRecord('task'); gr.short_description = 'nested'; gr.insert(); gr.description.toString()",
    ).value;
    expect(viaScript).toBe('Filed by system (new)');
    const quiet = run(
      "var gr = new GlideRecord('task'); gr.short_description = 'no rules'; gr.setWorkflow(false); gr.insert(); gr.getValue('description')",
    ).value;
    expect(quiet).toBeNull();
  });

  it('detects field changes against previous', () => {
    addRule({
      name: 'Track priority',
      collection: 'task',
      action_update: true,
      script:
        "if (current.priority.changes()) { current.description = 'priority ' + previous.priority + ' -> ' + current.priority + (current.priority.changesTo(1) ? ' (now critical)' : '') + (current.priority.changesFrom(3) ? ' (was moderate)' : ''); }",
    });
    const t = task({ short_description: 'Change test', priority: 3 });
    sys.update(t, { priority: 1 });
    expect(sys.get('task', t.sysId)!.str('description')).toBe(
      'priority 3 -> 1 (now critical) (was moderate)',
    );
    sys.update(t, { short_description: 'Change test renamed' });
    expect(sys.get('task', t.sysId)!.str('description')).toBe(
      'priority 3 -> 1 (now critical) (was moderate)',
    );
    sys.update(t, { priority: 2 });
    expect(sys.get('task', t.sysId)!.str('description')).toBe('priority 1 -> 2');
  });

  it('honours filter conditions, condition scripts and role conditions', () => {
    addRule({
      name: 'Escalate urgent P1',
      collection: 'task',
      action_insert: true,
      filter_condition: 'priority=1',
      condition: "current.short_description.toString().indexOf('urgent') >= 0",
      script: "current.description = 'escalated';",
    });
    addRule({
      name: 'Agents only',
      collection: 'task',
      action_insert: true,
      order: 200,
      role_conditions: 'itil',
      script: "current.work_notes = 'agent note';",
    });
    expect(task({ short_description: 'urgent outage', priority: 1 }).str('description')).toBe('escalated');
    expect(task({ short_description: 'urgent but low', priority: 2 }).str('description')).toBe('');
    expect(task({ short_description: 'routine', priority: 1 }).str('description')).toBe('');
    const byAgent = p.contextAs('abel.agent').insert('task', { short_description: 'agent work' });
    expect(p.history.journal('task', byAgent.sysId, ['work_notes'])).toHaveLength(1);
    const byPlain = p.contextAs('plain.user').elevated().insert('task', { short_description: 'plain work' });
    expect(p.history.journal('task', byPlain.sysId, ['work_notes'])).toHaveLength(0);
  });

  it('aborts the operation with setAbortAction() and with the no-code abort action', () => {
    addRule({
      name: 'Block forbidden words',
      collection: 'task',
      action_insert: true,
      condition: "current.short_description.toString().indexOf('forbidden') >= 0",
      script: "gs.addErrorMessage('Forbidden words are not allowed'); current.setAbortAction(true);",
    });
    expect(() => task({ short_description: 'forbidden fruit' })).toThrow(AbortError);
    expect(() => task({ short_description: 'forbidden fruit' })).toThrow('Forbidden words are not allowed');
    expect(sys.count('task', 'short_description=forbidden fruit')).toBe(0);
    expect(
      run(
        "var gr = new GlideRecord('task'); gr.short_description = 'forbidden again'; [gr.insert(), gr.getLastErrorMessage()]",
      ).value,
    ).toEqual([null, 'Forbidden words are not allowed']);

    const t = task({ short_description: 'cannot delete me' });
    addRule({
      name: 'No deletes',
      collection: 'task',
      action_delete: true,
      abort_action: true,
      add_message: true,
      message: 'Tasks cannot be deleted',
    });
    expect(() => sys.delete(t)).toThrow('Tasks cannot be deleted');
    expect(sys.get('task', t.sysId)).not.toBeNull();
  });

  it('lets after rules update other records', () => {
    addRule({
      name: 'Count children',
      collection: 'task',
      when: 'after',
      action_insert: true,
      filter_condition: 'parentISNOTEMPTY',
      script: `
        (function executeRule(current, previous) {
          var parent = current.parent.getRefRecord();
          parent.description = 'Children: ' + countChildren(parent.getUniqueValue());
          parent.update();
        })(current, previous);
        function countChildren(id) {
          var ga = new GlideAggregate('task');
          ga.addQuery('parent', id);
          ga.addAggregate('COUNT');
          ga.query();
          ga.next();
          return ga.getAggregate('COUNT');
        }`,
    });
    const parent = task({ short_description: 'Parent' });
    task({ short_description: 'Child 1', parent: parent.sysId });
    task({ short_description: 'Child 2', parent: parent.sysId });
    expect(sys.get('task', parent.sysId)!.str('description')).toBe('Children: 2');
  });

  it('reloads rules when sys_script changes', () => {
    const id = addRule({
      name: 'Stamp',
      collection: 'task',
      action_insert: true,
      script: "current.description = 'v1';",
    });
    expect(p.rules.get(`sys_script:${id}`)?.source).toBe('script');
    expect(task({ short_description: 'reload 1' }).str('description')).toBe('v1');
    sys.update(sys.get('sys_script', id)!, { script: "current.description = 'v2';" });
    expect(task({ short_description: 'reload 2' }).str('description')).toBe('v2');
    sys.update(sys.get('sys_script', id)!, { active: false });
    expect(task({ short_description: 'reload 3' }).str('description')).toBe('');
    expect(p.rules.get(`sys_script:${id}`)).toBeUndefined();
    sys.update(sys.get('sys_script', id)!, { active: true });
    expect(task({ short_description: 'reload 4' }).str('description')).toBe('v2');
    sys.delete(sys.get('sys_script', id)!);
    expect(p.rules.get(`sys_script:${id}`)).toBeUndefined();
  });

  it('runs async rules after the transaction and applies templates', () => {
    addRule({
      name: 'Async stamp',
      collection: 'task',
      when: 'async',
      action_insert: true,
      script: "current.description = 'async done'; current.update();",
    });
    addRule({ name: 'Template', collection: 'task', action_insert: true, template: 'impact=1^urgency=2' });
    const t = task({ short_description: 'async test' });
    expect(t.num('impact')).toBe(1);
    expect(t.num('urgency')).toBe(2);
    expect(sys.get('task', t.sysId)!.str('description')).toBe('');
    p.drain();
    expect(sys.get('task', t.sysId)!.str('description')).toBe('async done');
  });

  it('restricts queries with query business rules', () => {
    addRule({
      name: 'Hide planning tasks',
      collection: 'task',
      action_query: true,
      condition: "!gs.hasRole('itil')",
      script: "current.addQuery('priority', '!=', 5);",
    });
    const plain = p.contextAs('plain.user').elevated();
    expect(
      plain
        .query('task', 'short_descriptionSTARTSWITHQB-')
        .map((r) => r.str('short_description'))
        .sort(),
    ).toEqual(['QB-1', 'QB-2', 'QB-3', 'QB-4']);
    expect(p.contextAs('abel.agent').query('task', 'short_descriptionSTARTSWITHQB-')).toHaveLength(5);
    const count =
      "var gr = new GlideRecord('task'); gr.addQuery('short_description', 'STARTSWITH', 'QB-'); gr.query(); gr.getRowCount()";
    expect(run(count, p.contextAs('plain.user')).value).toBe(4);
    expect(
      run(count.replace('gr.query()', 'gr.setWorkflow(false); gr.query()'), p.contextAs('plain.user')).value,
    ).toBe(5);
  });

  it('stops a rule from re-entering itself through current.update()', () => {
    addRule({
      name: 'Self update',
      collection: 'task',
      when: 'after',
      action_update: true,
      script: "current.description = 'touched'; current.update();",
    });
    const t = task({ short_description: 'recursion' });
    sys.update(t, { priority: 2 });
    expect(sys.get('task', t.sysId)!.str('description')).toBe('touched');
    expect(syslog('source=Business rule: Self update^level=warn').length).toBeGreaterThan(0);
  });

  it('bounds runaway rule chains', () => {
    addRule({
      name: 'Spawn child',
      collection: 'task',
      when: 'after',
      action_insert: true,
      filter_condition: 'short_descriptionSTARTSWITHchain',
      script:
        "var gr = new GlideRecord('task'); gr.short_description = 'chain ' + current.number; gr.insert();",
    });
    expect(() => task({ short_description: 'chain start' })).not.toThrow();
    const n = sys.count('task', 'short_descriptionSTARTSWITHchain');
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThan(20);
    expect(syslog('source=Business rule: Spawn child^level=error').length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------- script includes

describe('script includes', () => {
  it('loads includes by name and by direct reference', () => {
    track('sys_script_include', {
      name: 'MathUtil',
      script:
        "var MathUtil = Class.create(); MathUtil.prototype = { initialize: function (base) { this.base = base || 0; }, add: function (n) { return this.base + n; }, type: 'MathUtil' };",
    });
    track('sys_script_include', {
      name: 'FancyMath',
      script:
        "var FancyMath = Class.create(); FancyMath.prototype = Object.extendsObject(MathUtil, { double: function (n) { return this.add(n) * 2; }, type: 'FancyMath' });",
    });
    track('sys_script_include', { name: 'Disabled', active: false, script: 'var Disabled = 1;' });
    expect(run('new MathUtil(40).add(2)').value).toBe(42);
    expect(run("[gs.include('MathUtil'), new MathUtil(1).add(1)]").value).toEqual([true, 2]);
    expect(run('new FancyMath(1).double(2)').value).toBe(6);
    expect(run("[typeof NotAnInclude, typeof Disabled, gs.include('Disabled')]").value).toEqual([
      'undefined',
      'undefined',
      false,
    ]);

    const util = sys.query('sys_script_include', 'name=MathUtil')[0];
    sys.update(util, {
      script:
        'var MathUtil = Class.create(); MathUtil.prototype = { initialize: function () {}, add: function (n) { return n * 100; } };',
    });
    expect(run('new MathUtil().add(2)').value).toBe(200);
  });

  it('makes includes available to business rules', () => {
    track('sys_script_include', {
      name: 'Labels',
      script: 'var Labels = { tag: function (s) { return "[" + s + "]"; } };',
    });
    addRule({
      name: 'Use include',
      collection: 'task',
      action_insert: true,
      script: 'current.description = Labels.tag(current.short_description);',
    });
    expect(task({ short_description: 'with include' }).str('description')).toBe('[with include]');
  });
});

// ---------------------------------------------------------- GlideAggregate

describe('GlideAggregate', () => {
  it('counts and aggregates with grouping', () => {
    const grouped = run(`
      var ga = new GlideAggregate('task');
      ga.addQuery('short_description', 'STARTSWITH', 'QB-');
      ga.addAggregate('COUNT');
      ga.groupBy('priority');
      ga.orderBy('priority');
      ga.query();
      var out = [];
      while (ga.next()) out.push(ga.getValue('priority') + ':' + ga.getAggregate('COUNT') + ':' + ga.priority.getDisplayValue());
      out;
    `).value;
    expect(grouped).toEqual([
      '1:1:1 - Critical',
      '2:1:2 - High',
      '3:1:3 - Moderate',
      '4:1:4 - Low',
      '5:1:5 - Planning',
    ]);
    const totals = run(`
      var ga = new GlideAggregate('task');
      ga.addQuery('short_description', 'STARTSWITH', 'QB-');
      ga.addAggregate('COUNT');
      ga.addAggregate('MAX', 'priority');
      ga.addAggregate('SUM', 'priority');
      ga.query();
      ga.next();
      [ga.getAggregate('COUNT'), ga.getAggregate('MAX', 'priority'), ga.getAggregate('SUM', 'priority'), ga.getRowCount()];
    `).value;
    expect(totals).toEqual(['5', '5', '15', 1]);
    const byActive = run(
      "var ga = new GlideAggregate('task'); ga.addQuery('short_description', 'STARTSWITH', 'QB-'); ga.addAggregate('COUNT'); ga.groupBy('active'); ga.query(); var o = {}; while (ga.next()) o[ga.getValue('active')] = ga.getAggregate('COUNT'); o",
    ).value;
    expect(byActive).toEqual({ true: '4', false: '1' });
  });
});

// ---------------------------------------------------------------------- gs

describe('gs API', () => {
  it('describes the user running the script', () => {
    const agent = p.contextAs('abel.agent');
    const out = run(
      "var u = gs.getUser(); [gs.getUserID(), gs.getUserName(), gs.getUserDisplayName(), gs.hasRole('itil'), gs.hasRole('admin'), gs.hasRole('nobody,itil'), u.isMemberOf('Service Desk'), u.isMemberOf('Nope'), u.getMyGroups().size(), u.getEmail(), u.getRecord().getValue('user_name')]",
      agent,
    ).value;
    expect(out).toEqual([
      agentId,
      'abel.agent',
      'abel agent',
      true,
      false,
      true,
      true,
      false,
      1,
      'abel.agent@example.com',
      'abel.agent',
    ]);
    expect(run('[gs.getUserID(), gs.getUserName(), gs.hasRole("itil"), gs.isLoggedIn()]').value).toEqual([
      null,
      'system',
      true,
      false,
    ]);
  });

  it('uses the platform clock for dates', () => {
    clock.freeze('2026-03-10 12:00:00');
    const out = run(`
      var d = new GlideDateTime('2026-01-31 10:00:00'); d.addMonthsUTC(1);
      var a = new GlideDateTime('2026-01-01 00:00:00'); var b = new GlideDateTime('2026-01-02 06:00:00');
      var c = new GlideDateTime(a); c.addSeconds(90); c.addDaysUTC(2);
      [gs.nowDateTime(), gs.daysAgo(1), gs.beginningOfToday(), gs.endOfThisMonth(), new GlideDateTime().getValue(), d.getValue(),
       GlideDateTime.subtract(a, b).getNumericValue(), GlideDateTime.subtract(a, b).getDisplayValue(), a.before(b), a.after(b), a.compareTo(b), b.compareTo(a),
       c.getValue(), c.getDayOfWeekUTC(), new GlideDuration(90061000).getDisplayValue(), new GlideDuration('2 01:00:00').getNumericValue(),
       new GlideDuration(3600000).getValue(), gs.dateDiff('2026-01-01 00:00:00', '2026-01-01 01:30:00', true), new Date().toISOString().slice(0, 16)];
    `).value;
    expect(out).toEqual([
      '2026-03-10 12:00:00',
      '2026-03-09 12:00:00',
      '2026-03-10 00:00:00',
      '2026-03-31 23:59:59',
      '2026-03-10 12:00:00',
      '2026-02-28 10:00:00',
      108_000_000,
      '1 Day 6 Hours',
      true,
      false,
      -1,
      1,
      '2026-01-03 00:01:30',
      6,
      '1 Day 1 Hour 1 Minute',
      176_400_000,
      '1970-01-01 01:00:00',
      5400,
      '2026-03-10T12:00',
    ]);
  });

  it('reads and writes properties (writes require admin)', () => {
    expect(
      run(
        "[gs.getProperty('resolvr.script.max_rows'), gs.getProperty('no.such.property', 'fallback'), gs.getProperty('no.such.property')]",
      ).value,
    ).toEqual(['10000', 'fallback', null]);
    run("gs.setProperty('resolvr.test.flag', 'on')");
    expect(p.properties.get('resolvr.test.flag')).toBe('on');
    expect(() => run("gs.setProperty('resolvr.test.flag', 'off')", p.contextAs('abel.agent'))).toThrow(
      /admin/,
    );
    expect(p.properties.get('resolvr.test.flag')).toBe('on');
  });

  it('queues events, session messages and helpers', () => {
    const ctx = p.contextAs('abel.agent');
    run(
      "var gr = new GlideRecord('task'); gr.get('short_description', 'QB-1'); gs.eventQueue('task.poked', gr, 'p1', gr.priority); gs.addInfoMessage('saved'); gs.addErrorMessage('careful');",
      ctx,
    );
    const ev = sys.query('sysevent', 'name=task.poked')[0];
    expect(ev.str('table')).toBe('task');
    expect(ev.str('parm1')).toBe('p1');
    expect(ev.str('parm2')).toBe('1');
    expect(ev.str('user_name')).toBe('abel.agent');
    expect(ctx.messages).toEqual([
      { type: 'info', text: 'saved' },
      { type: 'error', text: 'careful' },
    ]);
    const helpers = run(
      "[gs.nil(''), gs.nil(null), gs.nil('x'), /^[0-9a-f]{32}$/.test(gs.generateGUID()), gs.getMessage('Hi {0}', ['there']), gs.base64Decode(gs.base64Encode('héllo')), JSUtil.notNil('a'), new ArrayUtil().unique([1, 1, 2]).length]",
    ).value;
    expect(helpers).toEqual([true, true, false, true, 'Hi there', 'héllo', true, 2]);
  });
});

// ------------------------------------------------------- service contract

describe('ScriptService contract', () => {
  it('runs scripts with records, values and host callbacks', () => {
    const svc = p.services.get('scripts') as ScriptService;
    const calls: unknown[] = [];
    const value = svc.run(sys, "notify('hi ' + who.name, limit); limit * 2", {
      vars: {
        who: { name: 'Ada' },
        limit: 21,
        notify: (msg: unknown, n: unknown) => {
          calls.push([msg, n]);
          return 'ok';
        },
      },
    });
    expect(value).toBe(42);
    expect(calls).toEqual([['hi Ada', 21]]);
    const qb1 = sys.first('task', 'short_description=QB-1')!;
    const qb2 = sys.first('task', 'short_description=QB-2')!;
    expect(
      svc.run(sys, "current.short_description + ' / ' + previous.priority", { current: qb1, previous: qb2 }),
    ).toBe('QB-1 / 2');
    expect(svc.condition(sys, 'current.priority == 1', qb1)).toBe(true);
    expect(svc.condition(sys, 'current.priority == 1', qb2)).toBe(false);
    expect(svc.condition(sys, '', null)).toBe(true);
    expect(svc.condition(sys, 'this is not javascript (', null)).toBe(false);
  });

  it('exposes host objects with methods (UI action style)', () => {
    const svc = p.services.get('scripts') as ScriptService;
    let redirect: unknown = null;
    const qb1 = sys.first('task', 'short_description=QB-1')!;
    const result = svc.run(sys, "action.setRedirectURL(current); action.label + ':' + action.count(3)", {
      current: qb1,
      vars: {
        action: {
          label: 'Resolve',
          setRedirectURL: (target: unknown) => {
            redirect = target;
          },
          count: (n: unknown) => Number(n) + 1,
        },
      },
    });
    expect(result).toBe('Resolve:4');
    expect(redirect).toEqual({ table: 'task', sys_id: qb1.sysId });
  });
});

// ------------------------------------------------------------- ACL scripts

describe('ACL scripts', () => {
  it('decides access with answer and gs', () => {
    track('sys_security_acl', {
      name: 'sys_number',
      operation: 'read',
      type: 'record',
      active: true,
      advanced: true,
      admin_overrides: true,
      script: "answer = gs.hasRole('itil') && current.prefix == 'TASK';",
    });
    expect(
      p
        .contextAs('abel.agent')
        .query('sys_number')
        .map((r) => r.str('prefix')),
    ).toEqual(['TASK']);
    expect(() => p.contextAs('plain.user').query('sys_number')).toThrow(AccessError);
    const row = sys.query('sys_number')[0];
    expect(p.acl.canTable(p.contextAs('abel.agent'), 'sys_number', 'read', row).allowed).toBe(true);
    expect(p.acl.canTable(p.contextAs('plain.user'), 'sys_number', 'read', row).allowed).toBe(false);
  });

  it('filters records when the script depends on current', () => {
    track('sys_security_acl', {
      name: 'sys_number',
      operation: 'read',
      type: 'record',
      active: true,
      advanced: true,
      script: "answer = current.prefix == 'NONE';",
    });
    expect(p.contextAs('abel.agent').query('sys_number')).toEqual([]);
  });

  it('runs ACL scripts read-only', () => {
    track('sys_security_acl', {
      name: 'sys_number',
      operation: 'write',
      type: 'record',
      active: true,
      advanced: true,
      script: "current.prefix = 'HACK'; answer = true;",
    });
    const row = sys.query('sys_number')[0];
    expect(p.acl.canTable(p.contextAs('abel.agent'), 'sys_number', 'write', row).allowed).toBe(false);
    expect(row.str('prefix')).toBe('TASK');
    expect(
      syslog('source=ACL script^level=error').some((r) => /cannot be modified/.test(r.str('message'))),
    ).toBe(true);
  });
});

// ------------------------------------------------------- scheduled scripts

describe('scheduled scripts', () => {
  it('runs sysauto_script records when their period elapses', () => {
    clock.freeze('2026-05-01 08:00:00');
    const job = track('sysauto_script', {
      name: 'Hourly stamp',
      active: true,
      run_period: 3_600_000,
      script:
        "var gr = new GlideRecord('task'); gr.short_description = 'from job at ' + gs.nowDateTime(); gr.insert();",
    });
    track('sysauto_script', {
      name: 'Later',
      active: true,
      run_start: '2026-05-02 00:00:00',
      script: "gs.info('later ran')",
    });
    track('sysauto_script', { name: 'Off', active: false, script: "gs.info('off ran')" });
    const agentJob = track('sysauto_script', {
      name: 'As agent',
      active: true,
      run_as: agentId,
      script: "gs.info('ran as ' + gs.getUserName())",
    });

    p.scheduler.runNow('scripts.scheduled');
    expect(sys.count('task', 'short_descriptionSTARTSWITHfrom job at')).toBe(1);
    expect(sys.get('sysauto_script', job.sysId)!.str('last_run')).toBe('2026-05-01 08:00:00');
    expect(syslog('message=ran as abel.agent')).toHaveLength(1);
    p.scheduler.runNow('scripts.scheduled');
    expect(sys.count('task', 'short_descriptionSTARTSWITHfrom job at')).toBe(1);
    clock.advance(3_600_000);
    p.scheduler.runNow('scripts.scheduled');
    expect(sys.count('task', 'short_descriptionSTARTSWITHfrom job at 2026-05-01 09:00:00')).toBe(1);
    expect(syslog('message=later ran')).toHaveLength(0);
    expect(syslog('message=off ran')).toHaveLength(0);
    expect(syslog('message=ran as abel.agent')).toHaveLength(1);
    expect(sys.get('sysauto_script', agentJob.sysId)!.str('last_run')).toBe('2026-05-01 08:00:00');
    for (const r of sys.query('task', 'short_descriptionSTARTSWITHfrom job at')) sys.delete(r);
  });
});

// ------------------------------------------------------------ HTTP API

describe('background script API', () => {
  let app: FastifyInstance;
  let dir: string;
  const basic = (u: string, pw: string) => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
  const ADMIN = basic('admin', 'admin-test-pw');
  const AGENT = basic('abel.agent', 'Password1!');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-scripts-'));
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
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, auth: string | null, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      payload,
    });

  it('runs background scripts for admins and audits them', async () => {
    const r = await post('/api/app/scripts/background', ADMIN, {
      script:
        "gs.info('hello {0}', 'world'); var gr = new GlideRecord('task'); gr.addQuery('short_description', 'STARTSWITH', 'QB-'); gr.query(); gr.getRowCount()",
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.result).toBe(5);
    expect(body.output).toEqual(['hello world']);
    expect(typeof body.durationMs).toBe('number');
    expect(body.error).toBeUndefined();
    const audit = syslog('source=Background script');
    expect(
      audit.some(
        (a) =>
          a.str('message').startsWith('Background script run by admin completed') &&
          a.str('message').includes("gs.info('hello {0}'"),
      ),
    ).toBe(true);
  });

  it('reports script failures in the response', async () => {
    const r = await post('/api/app/scripts/background', ADMIN, {
      script: "gs.print('before');\nthrow new Error('boom');",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      result: null,
      output: ['before'],
      error: { message: 'boom (line 2)', kind: 'error', line: 2 },
    });
  });

  it('is restricted to admins', async () => {
    expect((await post('/api/app/scripts/background', AGENT, { script: '1' })).statusCode).toBe(403);
    expect((await post('/api/app/scripts/background', null, { script: '1' })).statusCode).toBe(401);
    expect((await post('/api/app/scripts/background', ADMIN, {})).statusCode).toBe(400);
    expect((await post('/api/app/scripts/eval-condition', AGENT, { condition: 'true' })).statusCode).toBe(
      403,
    );
  });

  it('evaluates condition scripts against a record', async () => {
    const qb1 = sys.first('task', 'short_description=QB-1')!;
    const qb2 = sys.first('task', 'short_description=QB-2')!;
    const yes = await post('/api/app/scripts/eval-condition', ADMIN, {
      condition: 'current.priority == 1',
      table: 'task',
      sys_id: qb1.sysId,
    });
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toMatchObject({ result: true, value: true });
    const no = await post('/api/app/scripts/eval-condition', ADMIN, {
      condition: 'current.priority == 1',
      table: 'task',
      sys_id: qb2.sysId,
    });
    expect(no.json()).toMatchObject({ result: false });
    expect(
      (
        await post('/api/app/scripts/eval-condition', ADMIN, {
          condition: 'true',
          table: 'task',
          sys_id: 'f'.repeat(32),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await post('/api/app/scripts/eval-condition', ADMIN, { condition: 'gs.hasRole("admin")' })).json(),
    ).toMatchObject({ result: true });
  });

  it('returns 403 Operation Failed when a script rule aborts a REST insert', async () => {
    addRule({
      name: 'REST guard',
      collection: 'task',
      action_insert: true,
      script:
        "if (current.short_description == 'blocked') { gs.addErrorMessage('Blocked by rule'); current.setAbortAction(true); }",
    });
    const r = await post('/api/now/table/task', ADMIN, { short_description: 'blocked' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { message: 'Operation Failed', detail: 'Blocked by rule' } });
  });
});

// ------------------------------------------------------ limits and escapes

describe('sandbox limits', () => {
  beforeAll(() => p.properties.set('resolvr.script.timeout_ms', '300'));
  afterAll(() => p.properties.set('resolvr.script.timeout_ms', '2000'));

  it('interrupts infinite loops, even when they catch errors', () => {
    let t0 = Date.now();
    expect(() => run('while (true) {}')).toThrow(/time limit of 300 ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
    t0 = Date.now();
    expect(() => run('for (;;) { try { while (true) {} } catch (e) {} }')).toThrow(/time limit/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(run('1 + 1').value).toBe(2);
  });

  it('gives background scripts their own time limit', () => {
    p.properties.set('resolvr.script.background_timeout_ms', '1500');
    try {
      const slow = 'var end = Date.now() + 600; while (Date.now() < end) {} "done"';
      expect(() => run(slow)).toThrow(/time limit of 300 ms/);
      expect(rt.background(sys, slow)).toMatchObject({ result: 'done' });
      expect(rt.background(sys, 'while (true) {}').error).toMatchObject({
        kind: 'timeout',
        message: expect.stringMatching(/1500 ms/),
      });
    } finally {
      p.properties.set('resolvr.script.background_timeout_ms', '10000');
    }
  });

  it('does not let a looping business rule hang the save', () => {
    addRule({ name: 'Spin', collection: 'task', action_insert: true, script: 'while (true) {}' });
    const t0 = Date.now();
    const t = task({ short_description: 'spin test' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(sys.get('task', t.sysId)).not.toBeNull();
    expect(syslog('source=Business rule: Spin^level=error')[0].str('message')).toMatch(/time limit/);
  });

  it('enforces the memory limit', () => {
    const t0 = Date.now();
    try {
      run('var a = []; while (true) a.push(new Float64Array(100000));');
      expect.unreachable();
    } catch (e) {
      expect((e as ScriptError).kind).toBe('memory');
      expect((e as ScriptError).message).toMatch(/memory limit of 32 MB/);
    }
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(() => run("var s = 'x'.repeat(1 << 28); s.indexOf('y')")).toThrow(/memory/);
    expect(run('[1, 2, 3].length').value).toBe(3);
  });

  it('limits the call depth', () => {
    try {
      run('function f() { return f() + 1; } f();');
      expect.unreachable();
    } catch (e) {
      expect((e as ScriptError).kind).toBe('stack');
    }
    expect(run('function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } f(1000)').value).toBe(1000);
    expect(() => run(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)).toThrow(/stack overflow/);
    expect(run('2 * 21').value).toBe(42);
  });

  it('does not charge sandbox start-up to a short time limit', () => {
    p.properties.set('resolvr.script.timeout_ms', '1');
    try {
      for (let i = 0; i < 12; i++) {
        try {
          run('2 * 21');
        } catch (e) {
          // A 1 ms limit may stop the script itself, but building its context must not fail.
          expect((e as ScriptError).kind).toBe('timeout');
        }
      }
    } finally {
      p.properties.set('resolvr.script.timeout_ms', '300');
    }
  });

  it('replaces the sandbox when native code ignores the time limit', () => {
    const before = sandboxEngine().restartCount;
    const t0 = Date.now();
    try {
      run(
        'var o = {}, c = o; for (var i = 0; i < 300000; i++) { c.a = {}; c = c.a; } JSON.stringify(o).length',
      );
      expect.unreachable();
    } catch (e) {
      expect((e as ScriptError).kind).toBe('timeout');
    }
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(sandboxEngine().restartCount).toBe(before + 1);
    expect(
      run(
        "var gr = new GlideRecord('task'); gr.addQuery('short_description', 'QB-1'); gr.query(); gr.getRowCount()",
      ).value,
    ).toBe(1);
  });
});

describe('sandbox escapes', () => {
  it('exposes no host globals', () => {
    const names = [
      'process',
      'require',
      'module',
      'exports',
      'Buffer',
      'global',
      'setTimeout',
      'setInterval',
      'fetch',
      'XMLHttpRequest',
      'WebAssembly',
      '__host',
      'std',
      'os',
      'Deno',
      'Bun',
    ];
    expect(run(`[${names.map((n) => `typeof ${n}`).join(', ')}]`).value).toEqual(
      names.map(() => 'undefined'),
    );
    expect(
      run(
        "['__host', 'require', 'process', 'module'].filter(function (k) { return Object.getOwnPropertyNames(globalThis).indexOf(k) >= 0; })",
      ).value,
    ).toEqual([]);
  });

  it('cannot reach the host through constructor tricks', () => {
    expect(run("globalThis.constructor.constructor('return typeof process')()").value).toBe('undefined');
    expect(run("(function () {}).constructor('return this')() === globalThis").value).toBe(true);
    expect(run("Function('return typeof require')()").value).toBe('undefined');
    expect(run("gs.constructor.constructor('return typeof process')()").value).toBe('undefined');
    expect(run("GlideRecord.prototype.query.constructor('return typeof module')()").value).toBe('undefined');
    expect(
      run("try { [].constructor.constructor('return process.env')(); 'escaped' } catch (e) { e.name }").value,
    ).toBe('ReferenceError');
    expect(
      run(
        "try { this.constructor.constructor('return process')().mainModule.require('fs'); 'escaped' } catch (e) { e.name }",
      ).value,
    ).toBe('ReferenceError');
    expect(
      run(
        "try { new GlideRecord('task').constructor.constructor('return __host')(); 'escaped' } catch (e) { e.name }",
      ).value,
    ).toBe('ReferenceError');
    expect(run("try { eval('require(\"fs\")'); 'escaped' } catch (e) { e.name }").value).toBe(
      'ReferenceError',
    );
  });

  it('has no module loading', () => {
    expect(() => run("import fs from 'fs'; fs.readFileSync('/etc/passwd')")).toThrow(
      /could not load module|SyntaxError/,
    );
    expect(
      run(
        "var p = import('fs'); var state = 'pending'; p.then(function () { state = 'loaded'; }, function () { state = 'failed'; }); [typeof p.then, state]",
      ).value,
    ).toEqual(['function', 'pending']);
  });

  it('validates every host call', () => {
    expect(
      run("var g = new GlideRecord('task'); g._h = 999999; try { g.query(); 'ok' } catch (e) { e.message }")
        .value,
    ).toBe('Invalid record handle');
    expect(
      run("var g = new GlideRecord('task'); g._h = 'x'; try { g.insert(); 'ok' } catch (e) { e.message }")
        .value,
    ).toBe('Invalid record handle');
    expect(
      run(
        "var g = new GlideRecord('task'); g.setValue('short_description', { toString: function () { return 'x'; } }); g.getValue('short_description')",
      ).value,
    ).toBe('x');
    expect(
      run("try { gs.eventQueue('bad name with spaces', null); 'ok' } catch (e) { e.message }").value,
    ).toMatch(/Invalid event name/);
    expect(run("try { gs.daysAgo(\"1'); process.exit(1); ('\"); 'ok' } catch (e) { e.message }").value).toBe(
      'Invalid date argument',
    );
    expect(sys.count('task', 'short_description=QB-1')).toBe(1);
  });
});
