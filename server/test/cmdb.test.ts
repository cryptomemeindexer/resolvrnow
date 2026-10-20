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
import { addMs, clock, nowGlide } from '../src/engine/util.js';
import { RelationshipGovernance, suggestionsFor } from '../src/modules/cmdb/governance.js';
import { cmdbEngine } from '../src/modules/cmdb/graph.js';
import { computeHealth, DEFAULT_WEIGHTS, runHealthJob, weightedScore } from '../src/modules/cmdb/health.js';
import { cmdbModule } from '../src/modules/cmdb/index.js';
import { type IrePayload, runIre } from '../src/modules/cmdb/ire.js';
import { reclassify } from '../src/modules/cmdb/reclassify.js';
import { REL, relTypeId } from '../src/modules/cmdb/seed.js';
import { bootPlatform, makeUser } from './helpers.js';

const DAY = 86_400_000;
let p: Platform;

afterEach(() => {
  clock.reset();
});

function boot(): Context {
  p = bootPlatform([cmdbModule]);
  return p.systemContext();
}

function rel(ctx: Context, parent: string, type: string, child: string): string {
  return ctx.insert('cmdb_rel_ci', { parent, child, type: relTypeId(ctx, type) }).sysId;
}

const ire = (ctx: Context, payload: IrePayload, source = 'ServiceNow') => runIre(ctx, payload, { source });
const item = (className: string, values: Record<string, unknown>) => ({ items: [{ className, values }] });

describe('CMDB classes and lifecycle', () => {
  it('stores every class in cmdb and supports INSTANCEOF (AT 1)', () => {
    const ctx = boot();
    const lnx = ctx.insert('cmdb_ci_linux_server', { name: 'lnx1' });
    ctx.insert('cmdb_ci_win_server', { name: 'win1' });
    ctx.insert('cmdb_ci_computer', { name: 'pc1' });
    ctx.insert('cmdb_ci_ip_router', { name: 'rtr1' });
    expect(
      ctx
        .query('cmdb_ci_server')
        .map((r) => r.str('name'))
        .sort(),
    ).toEqual(['lnx1', 'win1']);
    expect(ctx.count('cmdb_ci', 'sys_class_nameINSTANCEOFcmdb_ci_computer')).toBe(3);
    expect(ctx.count('cmdb', 'sys_class_nameINSTANCEOFcmdb_ci_server')).toBe(2);
    expect(p.registry.table('cmdb_ci_linux_server').physical).toBe('cmdb');
    const computerPath = ctx.insert('cmdb_ci_computer', { name: 'pc2' }).str('sys_class_path');
    expect(lnx.str('sys_class_path').startsWith(computerPath)).toBe(true);
    expect(computerPath.startsWith('/!!/')).toBe(true);
  });

  it('reclassifies keeping the sys_id and clearing columns of the old class (AT 2)', () => {
    const ctx = boot();
    const lnx = ctx.insert('cmdb_ci_linux_server', { name: 'lnx', kernel_release: '6.1.0', ram: 2048 });
    const moved = reclassify(ctx, lnx, 'cmdb_ci_win_server');
    expect(moved.sysId).toBe(lnx.sysId);
    expect(moved.className).toBe('cmdb_ci_win_server');
    expect(moved.num('ram')).toBe(2048);
    const row = p.db.get<{ kernel_release: string | null; sys_class_name: string }>(
      `SELECT "kernel_release","sys_class_name" FROM "cmdb" WHERE "sys_id" = ?`,
      [lnx.sysId],
    );
    expect(row).toEqual({ kernel_release: null, sys_class_name: 'cmdb_ci_win_server' });
    expect(() => reclassify(ctx, moved, 'incident_task')).toThrow();
  });

  it('couples operational status and status around Retired (AT 3)', () => {
    const ctx = boot();
    const ci = ctx.insert('cmdb_ci_linux_server', { name: 'srv' });
    expect(ci.str('hardware_status')).toBe('installed');
    expect(ci.str('hardware_substatus')).toBe('in_use');
    ctx.update(ci, { operational_status: 6 });
    let fresh = ctx.get('cmdb_ci', ci.sysId)!;
    expect(fresh.num('install_status')).toBe(7);
    expect(fresh.str('hardware_status')).toBe('retired');
    ctx.update(fresh, { install_status: 1 });
    fresh = ctx.get('cmdb_ci', ci.sysId)!;
    expect(fresh.num('operational_status')).toBe(2);
    expect(fresh.str('hardware_status')).toBe('installed');
    const app = ctx.insert('cmdb_ci_appl', { name: 'app', install_status: 7 });
    expect(app.num('operational_status')).toBe(6);
  });

  it('derives the service classification from the class', () => {
    const ctx = boot();
    const tech = ctx.insert('cmdb_ci_service_technical', { name: 'Hosting' });
    expect(tech.str('service_classification')).toBe('Technical Service');
    expect(ctx.insert('cmdb_ci_service_auto', { name: 'App svc' }).str('service_classification')).toBe(
      'Application Service',
    );
    expect(
      ctx
        .insert('service_offering', { name: 'Hosting - Gold', parent: tech.sysId })
        .str('service_classification'),
    ).toBe('Technical Service');
    expect(ctx.insert('cmdb_ci_service_business', { name: 'Biz' }).str('number')).toMatch(/^BSN\d{7}$/);
  });
});

describe('relationships and governance', () => {
  it('rejects duplicate and self relationships (AT 5)', () => {
    const ctx = boot();
    const a = ctx.insert('cmdb_ci_appl', { name: 'A' }).sysId;
    const b = ctx.insert('cmdb_ci_appl', { name: 'B' }).sysId;
    rel(ctx, a, REL.DEPENDS_ON, b);
    expect(() => rel(ctx, a, REL.DEPENDS_ON, b)).toThrow(AbortError);
    expect(() => rel(ctx, a, REL.DEPENDS_ON, a)).toThrow(AbortError);
    ctx.insert('cmdb_rel_ci', { parent: a, child: b, type: relTypeId(ctx, REL.DEPENDS_ON), port: '8080' });
    expect(ctx.count('cmdb_rel_ci')).toBe(2);
  });

  it('seeds relationship types with the documented sys_ids', () => {
    const ctx = boot();
    expect(relTypeId(ctx, REL.DEPENDS_ON)).toBe('1a9cb166f1571100a92eb60da2bce5c5');
    expect(relTypeId(ctx, REL.RUNS_ON)).toBe('60bc4e22c0a8010e01f074cbe6bd73c3');
    expect(relTypeId(ctx, 'Exchanges data with::Exchanges data with')).toBe(
      '607ad1b2c0a8010e01941856b365af90',
    );
    const t = ctx.insert('cmdb_rel_type', {
      parent_descriptor: 'Backs up',
      child_descriptor: 'Backed up by',
    });
    expect(t.str('name')).toBe('Backs up::Backed up by');
  });

  it('lists suggestions inherited from ancestor classes (AT 6)', () => {
    const ctx = boot();
    const type = relTypeId(ctx, 'Powers::Is Powered By')!;
    ctx.insert('cmdb_rel_type_suggest', {
      base_class: 'cmdb_ci_hardware',
      cmdb_rel_type: type,
      dependent_class: 'cmdb_ci_rack',
      parent: false,
    });
    ctx.insert('cmdb_rel_type_suggest', {
      base_class: 'cmdb_ci_server',
      cmdb_rel_type: type,
      dependent_class: 'cmdb_ci_peripheral',
      parent: true,
    });
    const bases = suggestionsFor(p, 'cmdb_ci_linux_server')
      .filter((s) => s.relation_type === type)
      .map((s) => s.base_class);
    expect(bases.sort()).toEqual(['cmdb_ci_hardware', 'cmdb_ci_server']);
    expect(suggestionsFor(p, 'cmdb_ci_appl').some((s) => s.base_class === 'cmdb_ci_server')).toBe(false);
  });

  it('validates relationships by inheritance (AT 7)', () => {
    const ctx = boot();
    const gov = new RelationshipGovernance(p);
    const runsOn = relTypeId(ctx, REL.RUNS_ON)!;
    expect(gov.isValid('cmdb_ci_appl_dot_net', runsOn, 'cmdb_ci_win_server')).toBe(true);
    expect(gov.isValid('cmdb_ci_win_server', runsOn, 'cmdb_ci_appl_dot_net')).toBe(false);
  });

  it('deletes relationships and orphaned dependent CIs with their host', () => {
    const ctx = boot();
    const host = ctx.insert('cmdb_ci_linux_server', { name: 'host' });
    const other = ctx.insert('cmdb_ci_linux_server', { name: 'other' });
    const app = ctx.insert('cmdb_ci_appl', { name: 'hosted app' });
    const shared = ctx.insert('cmdb_ci_appl', { name: 'shared app' });
    rel(ctx, app.sysId, REL.RUNS_ON, host.sysId);
    rel(ctx, shared.sysId, REL.RUNS_ON, host.sysId);
    rel(ctx, shared.sysId, REL.RUNS_ON, other.sysId);
    ctx.delete(host);
    expect(ctx.get('cmdb_ci', app.sysId)).toBeNull();
    expect(ctx.get('cmdb_ci', shared.sysId)).not.toBeNull();
    expect(ctx.count('cmdb_rel_ci', `parent=${shared.sysId}`)).toBe(1);
  });
});

describe('identification and reconciliation', () => {
  it('matches hardware by serial number and updates it (AT 8)', () => {
    const ctx = boot();
    const existing = ctx.insert('cmdb_ci_linux_server', { name: 'old', serial_number: 'S1' });
    const out = ire(ctx, item('cmdb_ci_linux_server', { serial_number: 'S1', name: 'n1' }));
    expect(out.items[0]).toMatchObject({ operation: 'UPDATE', sysId: existing.sysId, errors: [] });
    expect(ctx.count('cmdb_ci')).toBe(1);
    expect(ctx.get('cmdb_ci', existing.sysId)!.str('name')).toBe('n1');
  });

  it('matches by name and upgrades the class (AT 9)', () => {
    const ctx = boot();
    const comp = ctx.insert('cmdb_ci_computer', { name: 'n1' });
    const out = ire(ctx, item('cmdb_ci_linux_server', { name: 'n1', kernel_release: '6.8' }));
    expect(out.items[0]).toMatchObject({ operation: 'UPDATE_WITH_UPGRADE', sysId: comp.sysId });
    expect(
      out.items[0].identificationAttempts.find((a) => a.attemptResult === 'MATCHED')?.attributes,
    ).toEqual(['name']);
    const fresh = ctx.get('cmdb_ci', comp.sysId)!;
    expect(fresh.className).toBe('cmdb_ci_linux_server');
    expect(fresh.str('kernel_release')).toBe('6.8');
  });

  it('keeps the class and opens a reclassification task when downgrades are disabled (AT 10)', () => {
    const ctx = boot();
    p.properties.set('glide.class.downgrade.enabled', 'false');
    const srv = ctx.insert('cmdb_ci_server', { name: 'srv1' });
    const out = ire(ctx, item('cmdb_ci_computer', { name: 'srv1', ram: 1024 }));
    expect(out.items[0].sysId).toBe(srv.sysId);
    expect(out.items[0].warnings.map((w) => w.error)).toContain('RECLASSIFICATION_NOT_ALLOWED');
    expect(ctx.get('cmdb_ci', srv.sysId)!.className).toBe('cmdb_ci_server');
    expect(
      ctx.count('resolvr_reclassification_task', `cmdb_ci=${srv.sysId}^target_class=cmdb_ci_computer`),
    ).toBe(1);
  });

  it('resolves small duplicate sets to the oldest CI and fails on large ones (AT 11)', () => {
    const ctx = boot();
    clock.freeze('2026-01-05 09:00:00');
    const dups = [0, 1, 2].map(() => {
      clock.advance(60_000);
      return ctx.insert('cmdb_ci_computer', { name: 'dup' });
    });
    const out = ire(ctx, item('cmdb_ci_computer', { name: 'dup', ram: 512 }));
    expect(out.items[0].sysId).toBe(dups[0].sysId);
    for (const d of dups.slice(1))
      expect(ctx.get('cmdb_ci', d.sysId)!.str('duplicate_of')).toBe(dups[0].sysId);
    expect(ctx.count('reconcile_duplicate_task')).toBe(1);
    ire(ctx, item('cmdb_ci_computer', { name: 'dup', ram: 1024 }));
    expect(ctx.count('reconcile_duplicate_task')).toBe(1);

    for (let i = 0; i < 6; i++) ctx.insert('cmdb_ci_computer', { name: 'many' });
    const many = ire(ctx, item('cmdb_ci_computer', { name: 'many' }));
    expect(many.items[0].errors[0].error).toBe('MULTIPLE_DUPLICATE_RECORDS');
    expect(ctx.count('reconcile_duplicate_task')).toBe(2);
  });

  it('reports missing matching attributes without writing (AT 12)', () => {
    const ctx = boot();
    const out = ire(ctx, item('cmdb_ci_linux_server', { ram: 4096 }));
    expect(out.items[0].errors[0].error).toBe('MISSING_MATCHING_ATTRIBUTES');
    expect(out.items[0].sysId).toBeNull();
    expect(ctx.count('cmdb_ci')).toBe(0);
  });

  it('identifies dependent applications through their host (AT 13)', () => {
    const ctx = boot();
    const missing = ire(ctx, item('cmdb_ci_app_server_tomcat', { name: 'tomcat' }));
    expect(missing.items[0].errors[0].error).toBe('MISSING_DEPENDENCY');
    const s1 = ctx.insert('cmdb_ci_linux_server', { name: 's1' }).sysId;
    const s2 = ctx.insert('cmdb_ci_linux_server', { name: 's2' }).sysId;
    const onHost = (host: string): IrePayload => ({
      items: [{ className: 'cmdb_ci_app_server_tomcat', values: { name: 'tomcat' } }],
      relations: [{ parent: 0, child: host, type: REL.RUNS_ON }],
    });
    const a = ire(ctx, onHost(s1)).items[0];
    const b = ire(ctx, onHost(s2)).items[0];
    expect(a.operation).toBe('INSERT');
    expect(b.operation).toBe('INSERT');
    expect(a.sysId).not.toBe(b.sysId);
    const again = ire(ctx, onHost(s1)).items[0];
    expect(again.sysId).toBe(a.sysId);
    expect(again.operation).toBe('NO_CHANGE');
    expect(ctx.count('cmdb_rel_ci', `parent=${a.sysId}^child=${s1}`)).toBe(1);
  });

  it('identifies a host and its application in one payload', () => {
    const ctx = boot();
    const out = ire(ctx, {
      items: [
        { className: 'cmdb_ci_appl', values: { name: 'billing' } },
        {
          className: 'cmdb_ci_linux_server',
          values: { name: 'bill-01', serial_number: 'B1' },
          lookup: [
            {
              className: 'cmdb_serial_number',
              values: { serial_number: 'B1-SYS', serial_number_type: 'system' },
            },
          ],
        },
      ],
      relations: [{ parent: 0, child: 1, type: REL.RUNS_ON }],
    });
    expect(out.items.map((i) => i.operation)).toEqual(['INSERT', 'INSERT']);
    expect(out.relations[0].operation).toBe('INSERT');
    expect(ctx.count('cmdb_serial_number', `cmdb_ci=${out.items[1].sysId}`)).toBe(1);
    const viaLookup = ire(ctx, {
      items: [
        {
          className: 'cmdb_ci_linux_server',
          values: { name: 'renamed' },
          lookup: [
            {
              className: 'cmdb_serial_number',
              values: { serial_number: 'B1-SYS', serial_number_type: 'system' },
            },
          ],
        },
      ],
    });
    expect(viaLookup.items[0].sysId).toBe(out.items[1].sysId);
    expect(viaLookup.items[0].identificationAttempts[0]).toMatchObject({
      searchOnTable: 'cmdb_serial_number',
      attemptResult: 'MATCHED',
    });
  });

  it('applies source priorities and data refresh rules (AT 14, 15)', () => {
    const ctx = boot();
    ctx.insert('cmdb_reconciliation_definition', {
      applies_to: 'cmdb_ci_computer',
      discovery_source: 'ServiceNow',
      priority: 100,
      attributes: 'name',
    });
    ctx.insert('cmdb_reconciliation_definition', {
      applies_to: 'cmdb_ci_computer',
      discovery_source: 'ImportSet',
      priority: 200,
      attributes: 'name',
    });
    const ci = ctx.insert('cmdb_ci_computer', { name: 'orig', serial_number: 'C1' });
    ire(ctx, item('cmdb_ci_computer', { serial_number: 'C1', name: 'from-discovery' }), 'ServiceNow');
    expect(ctx.get('cmdb_ci', ci.sysId)!.str('name')).toBe('from-discovery');
    clock.advance(5000);
    ire(ctx, item('cmdb_ci_computer', { serial_number: 'C1', name: 'from-import' }), 'ImportSet');
    let fresh = ctx.get('cmdb_ci', ci.sysId)!;
    expect(fresh.str('name')).toBe('from-discovery');
    expect(fresh.str('discovery_source')).toBe('ImportSet');
    ctx.insert('cmdb_data_refresh_rule', {
      applies_to: 'cmdb_ci_computer',
      discovery_source: 'ServiceNow',
      effective_duration: 0,
    });
    ire(ctx, item('cmdb_ci_computer', { serial_number: 'C1', name: 'from-import' }), 'ImportSet');
    fresh = ctx.get('cmdb_ci', ci.sysId)!;
    expect(fresh.str('name')).toBe('from-import');
  });

  it('maintains first and last discovered (AT 16)', () => {
    const ctx = boot();
    clock.freeze('2026-03-01 10:00:00');
    const created = ire(ctx, item('cmdb_ci_linux_server', { name: 'disc-1' })).items[0];
    let ci = ctx.get('cmdb_ci', created.sysId!)!;
    expect(ci.str('first_discovered')).toBe('2026-03-01 10:00:00');
    expect(ci.str('last_discovered')).toBe('2026-03-01 10:00:00');
    clock.advance(DAY);
    ire(ctx, item('cmdb_ci_linux_server', { name: 'disc-1', last_discovered: '2020-01-01 00:00:00' }));
    ci = ctx.get('cmdb_ci', created.sysId!)!;
    expect(ci.str('last_discovered')).toBe('2026-03-01 10:00:00');
    ire(ctx, item('cmdb_ci_linux_server', { name: 'disc-1' }));
    ci = ctx.get('cmdb_ci', created.sysId!)!;
    expect(ci.str('last_discovered')).toBe('2026-03-02 10:00:00');
    expect(ci.str('first_discovered')).toBe('2026-03-01 10:00:00');
  });

  it('matches by source native key and rejects system fields', () => {
    const ctx = boot();
    const src = { source_name: 'SCCM', source_native_key: '16777219' };
    const first = ire(
      ctx,
      { items: [{ className: 'cmdb_ci_computer', values: { name: 'pc-a' }, sys_object_source_info: src }] },
      'SCCM',
    ).items[0];
    const second = ire(
      ctx,
      {
        items: [
          { className: 'cmdb_ci_computer', values: { name: 'pc-renamed' }, sys_object_source_info: src },
        ],
      },
      'SCCM',
    ).items[0];
    expect(second.sysId).toBe(first.sysId);
    expect(ctx.count('sys_object_source', 'name=SCCM')).toBe(1);
    const bad = ire(ctx, item('cmdb_ci_computer', { name: 'x', sys_created_on: '2020-01-01 00:00:00' }))
      .items[0];
    expect(bad.errors[0].error).toBe('INVALID_INPUT_DATA');
  });
});

describe('impact analysis and task links', () => {
  function chain(ctx: Context) {
    const S = ctx.insert('cmdb_ci_service_business', { name: 'S' }).sysId;
    const I = ctx.insert('cmdb_ci_service_auto', { name: 'I' }).sysId;
    const T = ctx.insert('cmdb_ci_app_server_tomcat', { name: 'T' }).sysId;
    const L = ctx.insert('cmdb_ci_linux_server', { name: 'L' }).sysId;
    rel(ctx, S, REL.DEPENDS_ON, I);
    rel(ctx, I, REL.DEPENDS_ON, T);
    rel(ctx, T, REL.RUNS_ON, L);
    return { S, I, T, L };
  }

  it('walks upstream for impact and downstream with a depth limit (AT 17)', () => {
    const ctx = boot();
    const { S, L } = chain(ctx);
    const eng = cmdbEngine(p);
    expect(eng.upstream(ctx, L).map((r) => r.str('name'))).toEqual(['T', 'I', 'S']);
    expect(
      eng
        .impactedServices(ctx, L)
        .map((r) => r.str('name'))
        .sort(),
    ).toEqual(['I', 'S']);
    expect(eng.downstream(ctx, S, 2).map((r) => r.str('name'))).toEqual(['I', 'T']);
    expect(eng.downstream(ctx, S).map((r) => r.str('name'))).toEqual(['I', 'T', 'L']);
  });

  it('is cycle safe', () => {
    const ctx = boot();
    const a = ctx.insert('cmdb_ci_appl', { name: 'a' }).sysId;
    const b = ctx.insert('cmdb_ci_appl', { name: 'b' }).sysId;
    rel(ctx, a, REL.DEPENDS_ON, b);
    rel(ctx, b, REL.DEPENDS_ON, a);
    expect(
      cmdbEngine(p)
        .upstream(ctx, a)
        .map((r) => r.str('name')),
    ).toEqual(['b']);
  });

  it('refreshes impacted services keeping manual rows (AT 18)', () => {
    const ctx = boot();
    const { S, I, L } = chain(ctx);
    const M = ctx.insert('cmdb_ci_service_business', { name: 'M' }).sysId;
    const task = ctx.insert('task', { short_description: 'Server down', cmdb_ci: L });
    ctx.insert('task_cmdb_ci_service', { task: task.sysId, cmdb_ci_service: M, manually_added: true });
    const eng = cmdbEngine(p);
    eng.refreshImpactedServices(ctx, task);
    eng.refreshImpactedServices(ctx, task);
    const rows = ctx.query('task_cmdb_ci_service', `task=${task.sysId}`);
    expect(rows.map((r) => [r.str('cmdb_ci_service'), r.bool('manually_added')]).sort()).toEqual(
      [
        [I, false],
        [M, true],
        [S, false],
      ].sort(),
    );
  });

  it('adds the primary CI to the affected CIs (AT 19)', () => {
    const ctx = boot();
    const L = ctx.insert('cmdb_ci_linux_server', { name: 'L' }).sysId;
    const L2 = ctx.insert('cmdb_ci_linux_server', { name: 'L2' }).sysId;
    const task = ctx.insert('task', { short_description: 'Disk full', cmdb_ci: L });
    expect(ctx.count('task_ci', `task=${task.sysId}^ci_item=${L}`)).toBe(1);
    ctx.update(task, { cmdb_ci: L2 });
    expect(
      ctx
        .query('task_ci', `task=${task.sysId}`)
        .map((r) => r.str('ci_item'))
        .sort(),
    ).toEqual([L, L2].sort());
    expect(() => ctx.insert('task_ci', { task: task.sysId, ci_item: L })).toThrow(AbortError);
  });

  it('reaches the business service through an offering (AT 28)', () => {
    const ctx = boot();
    const B = ctx.insert('cmdb_ci_service_business', { name: 'B' }).sysId;
    const O = ctx.insert('service_offering', { name: 'O', parent: B }).sysId;
    const I = ctx.insert('cmdb_ci_service_auto', { name: 'I' }).sysId;
    const app = ctx.insert('cmdb_ci_appl', { name: 'app' }).sysId;
    rel(ctx, O, REL.DEPENDS_ON, I);
    rel(ctx, I, REL.DEPENDS_ON, app);
    const eng = cmdbEngine(p);
    expect(eng.upstream(ctx, app).map((r) => r.str('name'))).toEqual(['I', 'O', 'B']);
    expect(eng.impact([app]).offerings).toEqual([O]);
    expect(
      eng
        .impactedServices(ctx, app)
        .map((r) => r.str('name'))
        .sort(),
    ).toEqual(['B', 'I']);
  });

  it('builds dependency maps with depth limits and contracted qualifiers', () => {
    const ctx = boot();
    const { S, I, T, L } = chain(ctx);
    const g = cmdbEngine(p).graph(T, { depth: 1 });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['I', 'L', 'T']);
    expect(g.edges.find((e) => e.to === L)).toMatchObject({
      from: T,
      type: REL.RUNS_ON,
      parentDescriptor: 'Runs on',
      childDescriptor: 'Runs',
    });
    const q = ctx.insert('cmdb_ci_qualifier', { name: 'qualifier' }).sysId;
    rel(ctx, S, REL.DEPENDS_ON, q);
    rel(ctx, q, REL.DEPENDS_ON, L);
    const down = cmdbEngine(p).graph(S, { direction: 'down', depth: 1 });
    expect(down.nodes.map((n) => n.name).sort()).toEqual(['I', 'L', 'S']);
    expect(down.edges.find((e) => e.to === L)?.contracted).toBe(true);
    const all = cmdbEngine(p).graph(S, { direction: 'down', depth: 1, showAll: true });
    expect(all.nodes.map((n) => n.name)).toContain('qualifier');
    expect(I).toBeTruthy();
  });
});

describe('CMDB UI and access', () => {
  it('registers navigation, layouts and the refresh impacted services action', () => {
    const ctx = boot();
    const nav = p.navigation.find((n) => n.id === 'cmdb')!;
    expect(nav.title).toBe('Configuration');
    expect(nav.modules.map((m) => m.title)).toEqual(
      expect.arrayContaining([
        'Servers',
        'Applications',
        'Databases',
        'Business Services',
        'Relationships',
        'CMDB Health',
      ]),
    );
    expect(p.forms.get('cmdb_ci:default')?.relatedLists?.map((r) => r.table)).toEqual(
      expect.arrayContaining(['cmdb_rel_ci', 'task_ci']),
    );
    const L = ctx.insert('cmdb_ci_linux_server', { name: 'L' }).sysId;
    const S = ctx.insert('cmdb_ci_service_business', { name: 'S' }).sysId;
    rel(ctx, S, REL.DEPENDS_ON, L);
    const task = ctx.insert('task', { short_description: 'x', cmdb_ci: L });
    const result = p.uiActions.get('cmdb.refresh_impacted_services')!.run(task, ctx, {});
    expect(result).toMatchObject({ message: expect.stringContaining('1 service') });
    expect(ctx.count('task_cmdb_ci_service', `task=${task.sysId}^cmdb_ci_service=${S}`)).toBe(1);
    expect(p.uiActions.get('cmdb.dependency_map')!.run(ctx.get('cmdb_ci', L)!, ctx, {})).toEqual({
      redirect: `/workspace/cmdb/map/${L}`,
    });
  });

  it('lets users read their own CIs only', () => {
    const ctx = boot();
    const me = makeUser(p, 'end.user');
    const mine = ctx.insert('cmdb_ci_computer', { name: 'my-laptop', assigned_to: me }).sysId;
    ctx.insert('cmdb_ci_computer', { name: 'not-mine' });
    const user = p.contextAs('end.user');
    expect(user.get('cmdb_ci', mine)?.str('name')).toBe('my-laptop');
    expect(user.query('cmdb_ci').map((r) => r.str('name'))).toEqual(['my-laptop']);
    makeUser(p, 'agent.one', ['itil']);
    expect(p.contextAs('agent.one').count('cmdb_ci')).toBe(2);
  });
});

describe('CMDB health', () => {
  it('weights completeness 60/40 (AT 22)', () => {
    expect(weightedScore({ required: 80, recommended: 50 }, DEFAULT_WEIGHTS)).toBe(68);
  });

  it('applies the nearest staleness rule and flags stale relationships (AT 20)', () => {
    const ctx = boot();
    ctx.insert('cmdb_health_staleness_rule', { applies_to: 'cmdb_ci_server', effective_duration: 10 * DAY });
    const old = addMs(nowGlide(), -20 * DAY);
    const srv = ctx.insert(
      'cmdb_ci_linux_server',
      { name: 'srv', sys_created_on: old, sys_updated_on: old },
      { autoSysFields: false },
    );
    const rtr = ctx.insert(
      'cmdb_ci_ip_router',
      { name: 'rtr', sys_created_on: old, sys_updated_on: old },
      { autoSysFields: false },
    );
    const app = ctx.insert('cmdb_ci_appl', { name: 'app' });
    rel(ctx, app.sysId, REL.RUNS_ON, srv.sysId);
    const report = computeHealth(ctx);
    const stale = report.failures.filter((f) => f.metric === 'staleness').map((f) => f.name);
    expect(stale).toEqual(['srv']);
    expect(rtr.sysId).toBeTruthy();
    expect(report.relationships.stale).toBe(1);
  });

  it('evaluates orphan rules with relationship conditions (AT 21)', () => {
    const ctx = boot();
    ctx.insert('cmdb_health_orphan_rule', {
      applies_to: 'cmdb_ci_disk',
      relationship_type: relTypeId(ctx, REL.CONTAINS),
      related_class: 'cmdb_ci_computer',
    });
    const lonely = ctx.insert('cmdb_ci_disk', { name: 'lonely-disk' });
    const kept = ctx.insert('cmdb_ci_disk', { name: 'kept-disk' });
    const pc = ctx.insert('cmdb_ci_computer', { name: 'pc' });
    rel(ctx, pc.sysId, REL.CONTAINS, kept.sysId);
    const report = computeHealth(ctx);
    expect(report.failures.filter((f) => f.metric === 'orphan').map((f) => f.sys_id)).toEqual([lonely.sysId]);
    expect(report.kpis.correctness?.metrics.orphan).toMatchObject({ evaluated: 2, failed: 1, score: 50 });
  });

  it('reports duplicates, required fields and compliance, and stores results', () => {
    const ctx = boot();
    ctx.insert('cmdb_ci_linux_server', { name: 'twin' });
    ctx.insert('cmdb_ci_linux_server', { name: 'TWIN' });
    ctx.insert('cmdb_ci_business_app', { name: 'no owner app' });
    let report = computeHealth(ctx);
    expect(report.kpis.compliance).toBeUndefined();
    expect(report.kpis.correctness?.metrics.duplicate?.failed).toBe(1);
    expect(report.failures.find((f) => f.metric === 'required')?.details).toContain('it_application_owner');
    ctx.insert('resolvr_cmdb_compliance_rule', {
      name: 'Servers are supported',
      applies_to: 'cmdb_ci_server',
      condition: 'support_groupISNOTEMPTY',
    });
    report = runHealthJob(ctx);
    expect(report.kpis.compliance?.metrics.audit).toMatchObject({ evaluated: 2, failed: 2, score: 0 });
    expect(report.overall).not.toBeNull();
    expect(ctx.count('cmdb_health_result', 'metric=audit^state=fail')).toBe(2);
  });
});

describe('CMDB REST APIs', () => {
  let app: FastifyInstance;
  let dir: string;
  let ctx: Context;
  const basic = (u: string, pw: string) => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
  const ADMIN = basic('admin', 'admin-test-pw');
  const ITIL = basic('cmdb.agent', 'Password1!');
  const json = { authorization: ADMIN, 'content-type': 'application/json' };

  beforeAll(async () => {
    p = bootPlatform([cmdbModule]);
    ctx = p.systemContext();
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-cmdb-'));
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
    makeUser(p, 'cmdb.agent', ['itil']);
    makeUser(p, 'plain.user', []);
  });

  afterAll(async () => {
    await app.close();
    p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists CIs of a class with limit and offset (AT 23, AT-57)', async () => {
    const a = ctx.insert('cmdb_ci_linux_server', { name: 'api-lnx-1' });
    const b = ctx.insert('cmdb_ci_linux_server', { name: 'api-lnx-2' });
    const r = await app.inject({
      method: 'GET',
      url: '/api/now/cmdb/instance/cmdb_ci_linux_server?sysparm_limit=1&sysparm_offset=1',
      headers: { authorization: ADMIN },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ result: [{ sys_id: b.sysId, name: 'api-lnx-2' }] });
    const all = await app.inject({
      method: 'GET',
      url: '/api/now/v1/cmdb/instance/cmdb_ci_server?sysparm_query=nameSTARTSWITHapi-lnx',
      headers: { authorization: ITIL },
    });
    expect(all.json().result.map((x: { sys_id: string }) => x.sys_id)).toEqual([a.sysId, b.sysId]);
    expect(Object.keys(all.json().result[0]).sort()).toEqual(['name', 'sys_id']);
  });

  it('validates classes and roles', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/now/cmdb/instance/not_a_class',
      headers: { authorization: ADMIN },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().status).toBe('failure');
    const notCi = await app.inject({
      method: 'GET',
      url: '/api/now/cmdb/instance/cmdb',
      headers: { authorization: ADMIN },
    });
    expect(notCi.statusCode).toBe(400);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/now/cmdb/instance/cmdb_ci',
      headers: { authorization: basic('plain.user', 'Password1!') },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('returns attributes with relations in both directions (AT 4)', async () => {
    const a = ctx.insert('cmdb_ci_appl', { name: 'rel-A', version: '2.1' });
    const b = ctx.insert('cmdb_ci_linux_server', { name: 'rel-B', ram: 2048 });
    const relId = rel(ctx, a.sysId, REL.DEPENDS_ON, b.sysId);
    const ra = (
      await app.inject({
        method: 'GET',
        url: `/api/now/cmdb/instance/cmdb_ci_appl/${a.sysId}`,
        headers: { authorization: ADMIN },
      })
    ).json().result;
    expect(ra.outbound_relations).toEqual([
      {
        sys_id: relId,
        type: {
          display_value: 'Depends on::Used by',
          link: 'https://resolvrnow.test/api/now/table/cmdb_rel_type/1a9cb166f1571100a92eb60da2bce5c5',
          value: '1a9cb166f1571100a92eb60da2bce5c5',
        },
        target: {
          display_value: 'rel-B',
          link: `https://resolvrnow.test/api/now/cmdb/instance/cmdb_ci/${b.sysId}`,
          value: b.sysId,
        },
      },
    ]);
    expect(ra.inbound_relations).toEqual([]);
    expect(ra.attributes).toMatchObject({
      name: 'rel-A',
      version: '2.1',
      sys_class_name: 'cmdb_ci_appl',
      install_status: '1',
      location: '',
      monitor: 'false',
    });
    const rb = (
      await app.inject({
        method: 'GET',
        url: `/api/now/cmdb/instance/cmdb_ci_server/${b.sysId}`,
        headers: { authorization: ADMIN },
      })
    ).json().result;
    expect(rb.inbound_relations[0].target.value).toBe(a.sysId);
    expect(rb.inbound_relations[0].type.display_value).toBe('Depends on::Used by');
    expect(rb.attributes.ram).toBe('2048');
    const wrongClass = await app.inject({
      method: 'GET',
      url: `/api/now/cmdb/instance/cmdb_ci_win_server/${b.sysId}`,
      headers: { authorization: ADMIN },
    });
    expect(wrongClass.statusCode).toBe(404);
  });

  it('creates CIs through identification and requires a source (AT 24, AT-58)', async () => {
    const target = ctx.insert('cmdb_ci_linux_server', { name: 'api-target' });
    const noSource = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_linux_server',
      headers: json,
      payload: { attributes: { name: 'x' } },
    });
    expect(noSource.statusCode).toBe(400);
    expect(noSource.json().status).toBe('failure');
    const badSource = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_linux_server',
      headers: json,
      payload: { attributes: { name: 'x' }, source: 'Nope' },
    });
    expect(badSource.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_linux_server',
      headers: { authorization: ITIL, 'content-type': 'application/json' },
      payload: {
        source: 'ServiceNow',
        attributes: { name: 'lnux999', ram: '16384', not_a_field: 'x' },
        outbound_relations: [{ type: REL_ID.dependsOn, target: target.sysId }],
      },
    });
    expect(created.statusCode).toBe(200);
    const result = created.json().result;
    expect(result.attributes).toMatchObject({
      name: 'lnux999',
      ram: '16384',
      discovery_source: 'ServiceNow',
      sys_class_name: 'cmdb_ci_linux_server',
    });
    expect(result.attributes.not_a_field).toBeUndefined();
    expect(result.outbound_relations).toHaveLength(1);
    expect(result.outbound_relations[0].target.value).toBe(target.sysId);
    const again = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_linux_server',
      headers: json,
      payload: { source: 'ServiceNow', attributes: { name: 'lnux999' } },
    });
    expect(again.json().result.attributes.sys_id).toBe(result.attributes.sys_id);
  });

  it('identifies dependent classes through their host relation', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_appl',
      headers: json,
      payload: { source: 'ServiceNow', attributes: { name: 'floating app' } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('Exception while executing request: null');
    expect(r.json().error.detail).toContain('MISSING_DEPENDENCY');
    const host = ctx.insert('cmdb_ci_linux_server', {
      name: 'app-host',
      location: ctx.insert('cmn_location', { name: 'Austin DC' }).sysId,
    });
    const body = {
      source: 'ServiceNow',
      attributes: { name: 'hosted app', version: '1.0' },
      outbound_relations: [{ type: REL_ID.runsOn, target: host.sysId }],
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_appl',
      headers: json,
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/now/cmdb/instance/cmdb_ci_appl',
      headers: json,
      payload: { ...body, attributes: { name: 'hosted app', version: '1.1' } },
    });
    expect(second.json().result.attributes.sys_id).toBe(first.json().result.attributes.sys_id);
    expect(second.json().result.attributes.version).toBe('1.1');
    const hostView = (
      await app.inject({
        method: 'GET',
        url: `/api/now/cmdb/instance/cmdb_ci_linux_server/${host.sysId}`,
        headers: { authorization: ADMIN },
      })
    ).json().result;
    expect(hostView.attributes.location).toEqual({
      display_value: 'Austin DC',
      link: `https://resolvrnow.test/api/now/table/cmn_location/${host.str('location')}`,
      value: host.str('location'),
    });
    expect(hostView.inbound_relations[0].type.display_value).toBe('Runs on::Runs');
  });

  it('merges attributes on PUT and PATCH (AT 25)', async () => {
    const ci = ctx.insert('cmdb_ci_linux_server', { name: 'put-me', ram: 1024, os: 'Ubuntu Linux' });
    const other = ctx.insert('cmdb_ci_linux_server', { name: 'put-peer' });
    rel(ctx, ci.sysId, REL.DEPENDS_ON, other.sysId);
    const r = await app.inject({
      method: 'PUT',
      url: `/api/now/cmdb/instance/cmdb_ci_linux_server/${ci.sysId}`,
      headers: json,
      payload: { source: 'ServiceNow', attributes: { ram: '4096' } },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res.attributes).toMatchObject({
      ram: '4096',
      os: 'Ubuntu Linux',
      name: 'put-me',
      discovery_source: 'ServiceNow',
    });
    expect(res.outbound_relations).toHaveLength(1);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/now/cmdb/instance/cmdb_ci/${ci.sysId}`,
      headers: json,
      payload: { source: 'SCCM', attributes: { os_version: '24.04' } },
    });
    expect(patched.json().result.attributes).toMatchObject({
      os_version: '24.04',
      ram: '4096',
      sys_class_name: 'cmdb_ci_linux_server',
    });
  });

  it('adds relations idempotently and deletes only relations of the CI (AT 26)', async () => {
    const a = ctx.insert('cmdb_ci_appl', { name: 'del-A' }).sysId;
    const b = ctx.insert('cmdb_ci_linux_server', { name: 'del-B' }).sysId;
    const c = ctx.insert('cmdb_ci_linux_server', { name: 'del-C' }).sysId;
    const payload = {
      source: 'ServiceNow',
      outbound_relations: [{ type: REL_ID.runsOn, target: b }],
      inbound_relations: [{ type: REL_ID.dependsOn, target: c }],
    };
    const added = await app.inject({
      method: 'POST',
      url: `/api/now/cmdb/instance/cmdb_ci_appl/${a}/relation`,
      headers: json,
      payload,
    });
    expect(added.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: `/api/now/cmdb/instance/cmdb_ci_appl/${a}/relation`,
      headers: json,
      payload,
    });
    const res = added.json().result;
    expect(res.outbound_relations).toHaveLength(1);
    expect(res.inbound_relations).toHaveLength(1);
    expect(ctx.count('cmdb_rel_ci', `parent=${a}^ORchild=${a}`)).toBe(2);
    const foreign = rel(ctx, c, REL.DEPENDS_ON, b);
    const miss = await app.inject({
      method: 'DELETE',
      url: `/api/now/cmdb/instance/cmdb_ci_appl/${a}/relation/${foreign}`,
      headers: { authorization: ADMIN },
    });
    expect(miss.statusCode).toBe(404);
    const relId = res.outbound_relations[0].sys_id;
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/now/cmdb/instance/cmdb_ci_appl/${a}/relation/${relId}`,
      headers: { authorization: ADMIN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('');
    expect(ctx.get('cmdb_rel_ci', relId)).toBeNull();
  });

  it('describes classes through the Meta API (AT 27, AT-56)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/now/cmdb/meta/cmdb_ci_computer',
      headers: { authorization: ITIL },
    });
    expect(r.statusCode).toBe(200);
    const meta = r.json().result;
    expect(meta).toMatchObject({
      name: 'cmdb_ci_computer',
      label: 'Computer',
      parent: 'cmdb_ci_hardware',
      is_extendable: true,
    });
    expect(meta.children).toEqual(expect.arrayContaining(['cmdb_ci_server', 'cmdb_ci_pc_hardware']));
    expect(meta.identification_rules.applies_to).toBe('cmdb_ci_hardware');
    expect(meta.identification_rules.identifiers.map((i: { order: number }) => i.order)).toEqual([
      100, 200, 300, 400,
    ]);
    expect(meta.identification_rules.identifiers[0]).toMatchObject({
      table: 'cmdb_serial_number',
      exact_count_match: true,
      active: true,
    });
    const ram = meta.attributes.find((a: { element: string }) => a.element === 'os_address_width');
    expect(ram).toEqual({
      element: 'os_address_width',
      label: 'OS Address Width (bits)',
      type: 'integer',
      max_length: '40',
      is_mandatory: 'false',
      is_read_only: 'false',
      is_inherited: 'false',
      is_display: 'false',
      default_value: null,
    });
    expect(meta.attributes.find((a: { element: string }) => a.element === 'name').is_inherited).toBe('true');
    expect(meta.relationship_rules).toEqual(
      expect.arrayContaining([
        {
          parent: 'cmdb_ci_computer',
          relation_type: relTypeId(ctx, REL.CONTAINS),
          child: 'cmdb_ci_storage_device',
        },
      ]),
    );
    const missing = await app.inject({
      method: 'GET',
      url: '/api/now/cmdb/meta/not_a_class',
      headers: { authorization: ADMIN },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('runs identification and reconciliation for payloads', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/identifyreconcile?sysparm_data_source=SCCM',
      headers: json,
      payload: {
        items: [
          { className: 'cmdb_ci_computer', values: { name: 'ire-pc', serial_number: 'IRE-1' } },
          { className: 'cmdb_ci_computer', values: { ram: 1 } },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    const out = r.json().result;
    expect(out.items[0]).toMatchObject({ operation: 'INSERT', className: 'cmdb_ci_computer' });
    expect(out.items[1].errors[0].error).toBe('MISSING_MATCHING_ATTRIBUTES');
    const query = await app.inject({
      method: 'POST',
      url: '/api/now/identifyreconcile/query',
      headers: json,
      payload: { items: [{ className: 'cmdb_ci_computer', values: { name: 'ire-pc', ram: 99 } }] },
    });
    expect(query.json().result.items[0]).toMatchObject({ operation: 'NONE', sysId: null });
    expect(ctx.first('cmdb_ci', 'name=ire-pc')!.str('ram')).toBe('');
  });

  it('serves the dependency graph, impact and health product APIs', async () => {
    const svc = ctx.insert('cmdb_ci_service_business', { name: 'Graph Service' }).sysId;
    const inst = ctx.insert('cmdb_ci_service_auto', { name: 'Graph Instance' }).sysId;
    const host = ctx.insert('cmdb_ci_linux_server', { name: 'graph-host' }).sysId;
    rel(ctx, svc, REL.DEPENDS_ON, inst);
    rel(ctx, inst, REL.DEPENDS_ON, host);
    const g = await app.inject({
      method: 'GET',
      url: `/api/app/cmdb/graph/${inst}?depth=2`,
      headers: { authorization: ITIL },
    });
    expect(g.statusCode).toBe(200);
    const graph = g.json();
    expect(graph.nodes.find((n: { sys_id: string }) => n.sys_id === host)).toMatchObject({
      name: 'graph-host',
      class: 'cmdb_ci_linux_server',
      classLabel: 'Linux Server',
      operational_status: '1',
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: svc,
          to: inst,
          type: 'Depends on::Used by',
          parentDescriptor: 'Depends on',
          childDescriptor: 'Used by',
        }),
      ]),
    );
    const impact = await app.inject({
      method: 'GET',
      url: `/api/app/cmdb/impact/${host}`,
      headers: { authorization: ITIL },
    });
    expect(
      impact
        .json()
        .result.services.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(['Graph Instance', 'Graph Service']);
    const health = await app.inject({
      method: 'GET',
      url: '/api/app/cmdb/health',
      headers: { authorization: ITIL },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().result).toMatchObject({
      kpis: { completeness: expect.any(Object), correctness: expect.any(Object) },
    });
    expect(typeof health.json().result.overall).toBe('number');
    const run = await app.inject({
      method: 'POST',
      url: '/api/app/cmdb/health/run',
      headers: { authorization: ITIL },
    });
    expect(run.statusCode).toBe(403);
  });
});

/** Relationship type sys_ids (seeded with their documented values). */
const REL_ID = { dependsOn: '1a9cb166f1571100a92eb60da2bce5c5', runsOn: '60bc4e22c0a8010e01f074cbe6bd73c3' };

describe('demo data', () => {
  it('loads a Northwind estate with meaningful impact', () => {
    p = bootPlatform([cmdbModule], { demo: true });
    const ctx = p.systemContext();
    expect(ctx.count('cmdb_ci')).toBeGreaterThanOrEqual(55);
    expect(ctx.count('cmdb_ci_service_business')).toBe(3);
    expect(p.errors).toEqual([]);
    const eng = cmdbEngine(p);
    const dc = ctx.first('cmdb_ci', 'name=dc-01')!;
    expect(eng.impactedServices(ctx, dc.sysId).map((r) => r.str('name'))).toEqual(
      expect.arrayContaining(['Payroll', 'Email']),
    );
    const db = ctx.first('cmdb_ci', 'name=cp-db-01')!;
    expect(eng.impactedServices(ctx, db.sysId).map((r) => r.str('name'))).toEqual(
      expect.arrayContaining(['Customer Portal', 'Customer Portal Production']),
    );
    const laptops = ctx.query('cmdb_ci_computer', 'form_factor=Laptop');
    expect(laptops.length).toBeGreaterThanOrEqual(12);
    expect(laptops.every((l) => !!l.str('assigned_to'))).toBe(true);
    const report = computeHealth(ctx);
    expect(report.failures.some((f) => f.metric === 'staleness' && f.name === 'legacy-ftp-01')).toBe(true);
    expect(report.failures.some((f) => f.metric === 'duplicate' && f.name === 'aus-wap-01')).toBe(true);
    expect(report.failures.some((f) => f.metric === 'orphan' && f.name === 'Legacy Reporting')).toBe(true);
  });
});
