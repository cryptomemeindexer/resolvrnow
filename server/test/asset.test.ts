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
import { clock, toGlideDate } from '../src/engine/util.js';
import { runContractJob } from '../src/modules/asset/contracts.js';
import { assetModule } from '../src/modules/asset/index.js';
import { runStockRules } from '../src/modules/asset/stock.js';
import { cmdbModule } from '../src/modules/cmdb/index.js';
import { bootPlatform, makeUser } from './helpers.js';

const DAY = 86_400_000;
let p: Platform;

afterEach(() => {
  clock.reset();
});

interface Fixture {
  sys: Context;
  user: Context;
  L1: string;
  S1: string;
  M1: string;
  U1: string;
  U2: string;
  computer: string;
  server: string;
}

/** Boots CMDB + asset with the spec fixtures: categories, model M1 (Computer), stockroom S1 at L1, users. */
function fixture(): Fixture {
  p = bootPlatform([cmdbModule, assetModule]);
  const sys = p.systemContext();
  const cat = (name: string) => sys.first('cmdb_model_category', `name=${name}`)!.sysId;
  const L1 = sys.insert('cmn_location', { name: 'L1' }).sysId;
  const S1 = sys.insert('alm_stockroom', { name: 'S1', location: L1 }).sysId;
  const computer = cat('Computer');
  const M1 = sys.insert('cmdb_hardware_product_model', { name: 'M1', cmdb_model_category: computer }).sysId;
  const U1 = makeUser(p, 'user.one');
  const U2 = makeUser(p, 'user.two');
  makeUser(p, 'asset.mgr', ['asset']);
  return { sys, user: p.contextAs('asset.mgr'), L1, S1, M1, U1, U2, computer, server: cat('Server') };
}

const get = (ctx: Context, table: string, id: string): Rec => ctx.get(table, id)!;

/** An asset in State 1 linked to the CI created for it. */
function linkedPair(f: Fixture, values: Record<string, unknown> = {}): { asset: Rec; ci: Rec } {
  const asset = f.user.insert('alm_hardware', {
    model: f.M1,
    asset_tag: `T-${Math.random().toString(36).slice(2, 7)}`,
    install_status: 1,
    assigned_to: f.U1,
    ...values,
  });
  const fresh = get(f.sys, 'alm_asset', asset.sysId);
  return { asset: fresh, ci: get(f.sys, 'cmdb_ci', fresh.str('ci')) };
}

describe('asset lifecycle', () => {
  it('fills the default substate, location, quantity and display name (AT 2)', () => {
    const f = fixture();
    const a = f.user.insert('alm_hardware', {
      model: f.M1,
      asset_tag: 'P100',
      install_status: 6,
      stockroom: f.S1,
      quantity: 5,
    });
    expect(a.str('substatus')).toBe('available');
    expect(a.str('location')).toBe(f.L1);
    expect(a.num('quantity')).toBe(1);
    expect(a.str('display_name')).toBe('P100 - M1');
    expect(a.str('model_category')).toBe(f.computer);
  });

  it('requires a stockroom for user writes in stock, not for system writes (AT 1)', () => {
    const f = fixture();
    expect(() => f.user.insert('alm_hardware', { model: f.M1, install_status: 6 })).toThrow(AbortError);
    expect(f.sys.count('cmdb_ci')).toBe(0);
    expect(f.sys.insert('alm_hardware', { model: f.M1, install_status: 6 }).str('substatus')).toBe(
      'available',
    );
  });

  it('rejects a substate that does not fit the state (AT 3)', () => {
    const f = fixture();
    const a = f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    expect(() => f.user.update(a, { substatus: 'sold' })).toThrow(/Substate sold is not valid for State 6/);
  });

  it('deploys: clears stock fields and records history (AT 4)', () => {
    const f = fixture();
    clock.freeze('2026-04-01 08:30:00');
    const a = f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    clock.advance(3_600_000);
    f.user.update(a, { install_status: 1, assigned_to: f.U1 });
    const fresh = get(f.sys, 'alm_asset', a.sysId);
    expect(fresh.str('substatus')).toBe('');
    expect(fresh.str('stockroom')).toBe('');
    expect(fresh.str('install_date')).toBe('2026-04-01 09:30:00');
    expect(fresh.str('assigned')).toBe('2026-04-01 09:30:00');
    expect(fresh.str('old_status')).toBe('6');
    expect(fresh.str('old_substatus')).toBe('available');
  });

  it('requires reserved_for for reserved assets (AT 24)', () => {
    const f = fixture();
    expect(() =>
      f.user.insert('alm_hardware', {
        model: f.M1,
        install_status: 6,
        substatus: 'reserved',
        stockroom: f.S1,
      }),
    ).toThrow(/Reserved for/);
    const ok = f.user.insert('alm_hardware', {
      model: f.M1,
      install_status: 6,
      substatus: 'reserved',
      stockroom: f.S1,
      reserved_for: f.U2,
    });
    f.user.update(ok, { substatus: 'available' });
    expect(get(f.sys, 'alm_asset', ok.sysId).str('reserved_for')).toBe('');
  });

  it('resolves the model category or asks for one (AT 21)', () => {
    const f = fixture();
    const both = f.sys.insert('cmdb_hardware_product_model', {
      name: 'Hybrid',
      cmdb_model_category: `${f.computer},${f.server}`,
    }).sysId;
    expect(() => f.user.insert('alm_hardware', { model: both, install_status: 1 })).toThrow(
      /several categories/,
    );
    expect(
      f.user
        .insert('alm_hardware', { model: both, model_category: f.server, install_status: 1 })
        .str('model_category'),
    ).toBe(f.server);
    expect(f.user.insert('alm_hardware', { model: f.M1, install_status: 1 }).str('model_category')).toBe(
      f.computer,
    );
  });

  it('stores base-table inserts as the category asset class (AT 22)', () => {
    const f = fixture();
    const a = f.user.insert('alm_asset', { model: f.M1, install_status: 1 });
    const fresh = get(f.sys, 'alm_asset', a.sysId);
    expect(fresh.className).toBe('alm_hardware');
    expect(fresh.num('quantity')).toBe(1);
    expect(fresh.str('ci')).not.toBe('');
  });

  it('accepts Consumed only on consumables, which never get CIs (AT 25)', () => {
    const f = fixture();
    const consumable = f.sys.first('cmdb_model_category', 'name=Consumable')!.sysId;
    const toner = f.sys.insert('cmdb_consumable_product_model', {
      name: 'Toner',
      cmdb_model_category: consumable,
    }).sysId;
    const c = f.user.insert('alm_consumable', { model: toner, install_status: 10, quantity: 12 });
    expect(c.num('quantity')).toBe(12);
    expect(c.str('ci')).toBe('');
    expect(f.sys.count('cmdb_ci')).toBe(0);
    expect(() => f.user.insert('alm_hardware', { model: f.M1, install_status: 10 })).toThrow(/Invalid State/);
  });
});

describe('asset and CI synchronization', () => {
  it('creates the CI for a new asset (AT 5)', () => {
    const f = fixture();
    const a = f.user.insert('alm_hardware', {
      model: f.M1,
      asset_tag: 'P200',
      serial_number: 'SN200',
      install_status: 6,
      stockroom: f.S1,
    });
    const asset = get(f.sys, 'alm_asset', a.sysId);
    const ci = get(f.sys, 'cmdb_ci', asset.str('ci'));
    expect(ci.className).toBe('cmdb_ci_computer');
    expect(ci.str('asset')).toBe(a.sysId);
    expect(ci.str('model_id')).toBe(f.M1);
    expect(ci.num('install_status')).toBe(6);
    expect(ci.str('hardware_status')).toBe('in_stock');
    expect(ci.str('hardware_substatus')).toBe('available');
    expect(ci.str('serial_number')).toBe('SN200');
    expect(ci.str('name')).toBe('P200 - M1');
    expect(ci.str('location')).toBe(f.L1);
  });

  it('honours skip_sync on insert and stores it as false (AT 6)', () => {
    const f = fixture();
    const a = f.user.insert('alm_hardware', { model: f.M1, install_status: 1, skip_sync: true });
    expect(f.sys.count('cmdb_ci')).toBe(0);
    expect(get(f.sys, 'alm_asset', a.sysId).bool('skip_sync')).toBe(false);
  });

  it('does not track models marked do_not_track (AT 7)', () => {
    const f = fixture();
    const m2 = f.sys.insert('cmdb_hardware_product_model', {
      name: 'M2',
      cmdb_model_category: f.computer,
      asset_tracking_strategy: 'do_not_track',
    }).sysId;
    f.user.insert('cmdb_ci_computer', { name: 'pc-m2', model_id: m2 });
    expect(f.sys.count('alm_asset')).toBe(0);
  });

  it('creates an asset with the Unknown model for a new server CI (AT 8)', () => {
    const f = fixture();
    const ci = f.user.insert('cmdb_ci_server', { name: 'srv-1', install_status: 1 });
    const asset = f.sys.first('alm_asset', `ci=${ci.sysId}`)!;
    expect(asset.className).toBe('alm_hardware');
    expect(asset.display('model')).toBe('Unknown');
    expect(asset.str('model_category')).toBe(f.server);
    expect(asset.num('install_status')).toBe(1);
    const fresh = get(f.sys, 'cmdb_ci', ci.sysId);
    expect(fresh.display('model_id')).toBe('Unknown');
    expect(fresh.str('asset')).toBe(asset.sysId);
  });

  it('creates no asset for classes without a category (AT 9)', () => {
    const f = fixture();
    f.user.insert('cmdb_ci_service', { name: 'Payroll' });
    f.user.insert('cmdb_ci_linux_server', { name: 'subclass without category' });
    expect(f.sys.count('alm_asset')).toBe(0);
  });

  it('retires the CI when the asset is disposed (AT 10)', () => {
    const f = fixture();
    clock.freeze('2026-05-10 12:00:00');
    const { asset, ci } = linkedPair(f);
    expect(ci.str('assigned_to')).toBe(f.U1);
    f.user.update(get(f.user, 'alm_asset', asset.sysId), { install_status: 7, substatus: 'disposed' });
    const a = get(f.sys, 'alm_asset', asset.sysId);
    expect(a.str('retired')).toBe('2026-05-10');
    expect(a.str('assigned_to')).toBe('');
    const c = get(f.sys, 'cmdb_ci', ci.sysId);
    expect([
      c.num('install_status'),
      c.str('hardware_status'),
      c.str('hardware_substatus'),
      c.num('operational_status'),
    ]).toEqual([7, 'retired', 'disposed', 6]);
    expect(c.str('assigned_to')).toBe('');
  });

  it('retires the asset when the CI is retired operationally (AT 11)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    f.user.update(get(f.user, 'cmdb_ci', ci.sysId), { operational_status: 6 });
    const c = get(f.sys, 'cmdb_ci', ci.sysId);
    expect(c.num('install_status')).toBe(7);
    expect(c.str('hardware_status')).toBe('retired');
    const a = get(f.sys, 'alm_asset', asset.sysId);
    expect(a.num('install_status')).toBe(7);
    expect(a.str('substatus')).toBe('');
  });

  function retiredPair(f: Fixture) {
    const pair = linkedPair(f);
    f.user.update(get(f.user, 'alm_asset', pair.asset.sysId), { install_status: 7 });
    return pair;
  }

  it('returns a retired pair to stock from the CI (AT 12)', () => {
    const f = fixture();
    const { asset, ci } = retiredPair(f);
    expect(get(f.sys, 'alm_asset', asset.sysId).str('retired')).not.toBe('');
    f.user.update(get(f.user, 'cmdb_ci', ci.sysId), { install_status: 6 });
    const c = get(f.sys, 'cmdb_ci', ci.sysId);
    expect([c.num('operational_status'), c.str('hardware_status'), c.str('hardware_substatus')]).toEqual([
      2,
      'in_stock',
      'available',
    ]);
    const a = get(f.sys, 'alm_asset', asset.sysId);
    expect([a.num('install_status'), a.str('substatus'), a.str('retired')]).toEqual([6, 'available', '']);
  });

  it('reinstalls a retired pair when the CI becomes operational (AT 13)', () => {
    const f = fixture();
    const { asset, ci } = retiredPair(f);
    f.user.update(get(f.user, 'cmdb_ci', ci.sysId), { operational_status: 1 });
    const c = get(f.sys, 'cmdb_ci', ci.sysId);
    expect([c.num('install_status'), c.str('hardware_status'), c.str('hardware_substatus')]).toEqual([
      1,
      'installed',
      'in_use',
    ]);
    expect(get(f.sys, 'alm_asset', asset.sysId).num('install_status')).toBe(1);
  });

  it('maps missing assets to Stolen or Absent (AT 14)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    f.user.update(get(f.user, 'alm_asset', asset.sysId), { install_status: 8, substatus: 'stolen' });
    expect(get(f.sys, 'cmdb_ci', ci.sysId).num('install_status')).toBe(8);
    f.user.update(get(f.user, 'alm_asset', asset.sysId), { substatus: 'lost' });
    expect(get(f.sys, 'cmdb_ci', ci.sysId).num('install_status')).toBe(100);
    expect(get(f.sys, 'cmdb_ci', ci.sysId).str('hardware_substatus')).toBe('lost');
  });

  it('keeps substate detail the CI cannot express and does not rewrite the asset (AT 15)', () => {
    const f = fixture();
    const a = f.user.insert('alm_hardware', {
      model: f.M1,
      install_status: 6,
      substatus: 'defective',
      stockroom: f.S1,
    });
    const ciId = get(f.sys, 'alm_asset', a.sysId).str('ci');
    expect(get(f.sys, 'cmdb_ci', ciId).str('hardware_substatus')).toBe('defective');
    f.user.update(get(f.user, 'cmdb_ci', ciId), { install_status: 1, skip_sync: true });
    expect(get(f.sys, 'cmdb_ci', ciId).str('hardware_status')).toBe('installed');
    const before = get(f.sys, 'alm_asset', a.sysId).num('sys_mod_count');
    f.user.update(get(f.user, 'cmdb_ci', ciId), { install_status: 6 });
    const c = get(f.sys, 'cmdb_ci', ciId);
    expect([c.str('hardware_status'), c.str('hardware_substatus')]).toEqual(['in_stock', 'defective']);
    const after = get(f.sys, 'alm_asset', a.sysId);
    expect([after.num('install_status'), after.str('substatus'), after.num('sys_mod_count')]).toEqual([
      6,
      'defective',
      before,
    ]);
  });

  it('copies assignment to the CI (AT 16)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    clock.advance(60_000);
    f.user.update(get(f.user, 'alm_asset', asset.sysId), { assigned_to: f.U2 });
    const a = get(f.sys, 'alm_asset', asset.sysId);
    const c = get(f.sys, 'cmdb_ci', ci.sysId);
    expect(c.str('assigned_to')).toBe(f.U2);
    expect(c.str('assigned')).toBe(a.str('assigned'));
  });

  it('copies CI changes to the asset exactly once (AT 17)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    const L2 = f.sys.insert('cmn_location', { name: 'L2' }).sysId;
    const assetCount = get(f.sys, 'alm_asset', asset.sysId).num('sys_mod_count')!;
    const ciCount = get(f.sys, 'cmdb_ci', ci.sysId).num('sys_mod_count')!;
    f.user.update(get(f.user, 'cmdb_ci', ci.sysId), { location: L2 });
    const a = get(f.sys, 'alm_asset', asset.sysId);
    expect(a.str('location')).toBe(L2);
    expect(a.num('sys_mod_count')).toBe(assetCount + 1);
    expect(get(f.sys, 'cmdb_ci', ci.sysId).num('sys_mod_count')).toBe(ciCount + 1);
  });

  it('skips propagation for a CI write with skip_sync (AT 18)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    const L3 = f.sys.insert('cmn_location', { name: 'L3' }).sysId;
    f.user.update(get(f.user, 'cmdb_ci', ci.sysId), { location: L3, skip_sync: true });
    expect(get(f.sys, 'alm_asset', asset.sysId).str('location')).not.toBe(L3);
    const c = get(f.sys, 'cmdb_ci', ci.sysId);
    expect(c.str('location')).toBe(L3);
    expect(c.bool('skip_sync')).toBe(false);
  });

  it('keeps the asset when its CI is deleted (AT 23)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    f.sys.delete(get(f.sys, 'cmdb_ci', ci.sysId));
    const a = get(f.sys, 'alm_asset', asset.sysId);
    expect(a.str('ci')).toBe('');
  });

  it('links existing records once and clears back-references', () => {
    const f = fixture();
    const { asset } = linkedPair(f);
    const spare = f.user.insert('cmdb_ci_computer', {
      name: 'spare-pc',
      model_id: f.M1,
      serial_number: 'SPARE',
    });
    expect(get(f.sys, 'cmdb_ci', spare.sysId).str('asset')).not.toBe('');
    const loose = f.sys.insert('cmdb_ci_linux_server', { name: 'loose', serial_number: 'LOOSE-1' });
    const oldCi = get(f.sys, 'alm_asset', asset.sysId).str('ci');
    f.user.update(get(f.user, 'alm_asset', asset.sysId), { ci: loose.sysId });
    expect(get(f.sys, 'cmdb_ci', oldCi).str('asset')).toBe('');
    const linked = get(f.sys, 'cmdb_ci', loose.sysId);
    expect(linked.str('asset')).toBe(asset.sysId);
    expect(linked.str('assigned_to')).toBe(f.U1);
    expect(linked.str('serial_number')).toBe('LOOSE-1');
    const other = f.user.insert('alm_hardware', { model: f.M1, install_status: 1, skip_sync: true });
    expect(() => f.user.update(other, { ci: loose.sysId })).toThrow(/already linked/);
  });

  it('marks CIs of verified categories as unverified', () => {
    const f = fixture();
    f.sys.update(f.sys.get('cmdb_model_category', f.computer)!, { enforce_verification: true });
    const manual = f.user.insert('cmdb_ci_computer', { name: 'manual-pc', model_id: f.M1 });
    expect(get(f.sys, 'cmdb_ci', manual.sysId).bool('unverified')).toBe(true);
    const { ci } = linkedPair(f);
    expect(ci.bool('unverified')).toBe(false);
  });
});

describe('asset events', () => {
  it('handles retire and deploy events (AT 19, 20)', () => {
    const f = fixture();
    const { asset, ci } = linkedPair(f);
    f.sys.queueEvent('sn_hamp.asset.retire', get(f.sys, 'alm_asset', asset.sysId));
    p.drain();
    let a = get(f.sys, 'alm_asset', asset.sysId);
    expect([a.num('install_status'), a.str('substatus')]).toEqual([6, 'pending_disposal']);
    f.sys.update(a, { install_status: 7 });
    f.sys.queueEvent('sn_hamp.asset.retire', get(f.sys, 'alm_asset', asset.sysId));
    p.drain();
    expect(get(f.sys, 'alm_asset', asset.sysId).num('install_status')).toBe(7);

    const spare = f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    f.sys.queueEvent('sn_hamp.asset.deploy', spare);
    p.drain();
    a = get(f.sys, 'alm_asset', spare.sysId);
    expect(a.num('install_status')).toBe(1);
    expect(get(f.sys, 'cmdb_ci', a.str('ci')).num('install_status')).toBe(1);
    expect(f.sys.count('sysevent', 'name=asset.state.changed')).toBeGreaterThan(0);
    expect(ci.sysId).toBeTruthy();
  });

  it('applies the CSDM life cycle when enabled (AT 31)', () => {
    const f = fixture();
    p.properties.set('csdm.lifecycle.migration.activated', 'true');
    const a = f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    expect(get(f.sys, 'alm_asset', a.sysId).display('life_cycle_stage')).toBe('Inventory');
    f.user.update(get(f.user, 'alm_asset', a.sysId), { install_status: 1 });
    const asset = get(f.sys, 'alm_asset', a.sysId);
    const ci = get(f.sys, 'cmdb_ci', asset.str('ci'));
    expect([asset.display('life_cycle_stage'), asset.display('life_cycle_stage_status')]).toEqual([
      'Operational',
      'In Use',
    ]);
    expect([ci.display('life_cycle_stage'), ci.display('life_cycle_stage_status')]).toEqual([
      'Operational',
      'In Use',
    ]);
    f.user.update(get(f.user, 'cmdb_ci', ci.sysId), { install_status: 3 });
    const back = get(f.sys, 'cmdb_ci', ci.sysId);
    expect(get(f.sys, 'alm_asset', a.sysId).num('install_status')).toBe(3);
    expect([back.display('life_cycle_stage'), back.display('life_cycle_stage_status')]).toEqual([
      'Operational',
      'In Maintenance',
    ]);
  });
});

describe('asset and contract UI actions', () => {
  it('deploys and retires assets', () => {
    const f = fixture();
    const a = f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    p.uiActions.get('asset.deploy')!.run(get(f.user, 'alm_asset', a.sysId), f.user, { assigned_to: f.U2 });
    expect([
      get(f.sys, 'alm_asset', a.sysId).num('install_status'),
      get(f.sys, 'alm_asset', a.sysId).str('assigned_to'),
    ]).toEqual([1, f.U2]);
    p.uiActions
      .get('asset.retire')!
      .run(get(f.user, 'alm_asset', a.sysId), f.user, { disposal_reason: 'Broken screen' });
    const retired = get(f.sys, 'alm_asset', a.sysId);
    expect([retired.num('install_status'), retired.str('substatus'), retired.str('disposal_reason')]).toEqual(
      [7, 'disposed', 'Broken screen'],
    );
  });

  it('walks a contract through review', () => {
    const f = fixture();
    const model = f.sys.first('cmdb_contract_product_model', 'name=Lease')!.sysId;
    const c = f.user.insert('ast_lease', {
      short_description: 'Lease',
      vendor_contract: 'L-1',
      contract_model: model,
    });
    const run = (id: string, input: Record<string, unknown> = {}) =>
      p.uiActions.get(id)!.run(get(f.user, 'ast_contract', c.sysId), f.user, input);
    run('contract.submit_review', { approver: f.U1 });
    expect(get(f.sys, 'ast_contract', c.sysId).str('substate')).toBe('under_review');
    run('contract.reject', { work_notes: 'Missing terms' });
    expect(get(f.sys, 'ast_contract', c.sysId).str('substate')).toBe('awaiting_review');
    run('contract.submit_review', { approver: f.U1 });
    run('contract.approve');
    expect(get(f.sys, 'ast_contract', c.sysId).str('substate')).toBe('approved');
    run('contract.cancel');
    const cancelled = get(f.sys, 'ast_contract', c.sysId);
    expect([cancelled.str('state'), cancelled.str('substate'), cancelled.bool('active')]).toEqual([
      'cancelled',
      '',
      false,
    ]);
  });
});

describe('stockrooms and transfer orders', () => {
  it('flags stock locations, protects stocked rooms and raises stock rule events once', () => {
    const f = fixture();
    expect(get(f.sys, 'cmn_location', f.L1).bool('stock_room')).toBe(true);
    f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    expect(() => f.sys.delete(get(f.sys, 'alm_stockroom', f.S1))).toThrow(AbortError);
    f.sys.insert('alm_stock_rule', { stockroom: f.S1, model: f.M1, threshold: 2 });
    expect(runStockRules(f.sys)).toBe(1);
    expect(runStockRules(f.sys)).toBe(0);
    f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    runStockRules(f.sys);
    expect(f.sys.first('alm_stock_rule')!.bool('breach_active')).toBe(false);
    expect(f.sys.count('sysevent', 'name=stock_rule.threshold_reached')).toBe(1);
  });

  it('moves assets through transfer order stages', () => {
    const f = fixture();
    const S2 = f.sys.insert('alm_stockroom', {
      name: 'S2',
      location: f.sys.insert('cmn_location', { name: 'L9' }).sysId,
    }).sysId;
    const a = f.user.insert('alm_hardware', { model: f.M1, install_status: 6, stockroom: f.S1 });
    const order = f.sys.insert('alm_transfer_order', { from_stockroom: f.S1, to_stockroom: S2 });
    expect(order.str('number')).toMatch(/^TRO/);
    f.sys.insert('alm_transfer_order_line', { transfer_order: order.sysId, asset: a.sysId });
    f.sys.update(order, { stage: 'requested' });
    expect([
      get(f.sys, 'alm_asset', a.sysId).str('substatus'),
      get(f.sys, 'alm_asset', a.sysId).bool('active_to'),
    ]).toEqual(['pending_transfer', true]);
    f.sys.update(get(f.sys, 'alm_transfer_order', order.sysId), { stage: 'in_transit' });
    expect(get(f.sys, 'alm_asset', a.sysId).num('install_status')).toBe(9);
    f.sys.update(get(f.sys, 'alm_transfer_order', order.sysId), { stage: 'received' });
    const done = get(f.sys, 'alm_asset', a.sysId);
    expect([
      done.num('install_status'),
      done.str('substatus'),
      done.str('stockroom'),
      done.bool('active_to'),
    ]).toEqual([6, 'available', S2, false]);
    expect(get(f.sys, 'alm_transfer_order', order.sysId).str('received_date')).not.toBe('');
  });
});

describe('contracts', () => {
  function contract(f: Fixture, values: Record<string, unknown>): Rec {
    const model = f.sys.first('cmdb_contract_product_model', 'name=Warranty')!.sysId;
    return f.sys.insert('ast_contract', {
      short_description: 'Support',
      vendor_contract: `V-${Math.random()}`,
      contract_model: model,
      ...values,
    });
  }
  const today = () => toGlideDate(clock.now());
  const plusDays = (n: number) => toGlideDate(new Date(clock.now().getTime() + n * DAY));

  it('activates approved contracts on their start date (AT 26)', () => {
    const f = fixture();
    const c = contract(f, { state: 'draft', substate: 'approved', starts: today(), ends: plusDays(365) });
    expect(contract(f, {}).str('substate')).toBe('awaiting_review');
    runContractJob(f.sys);
    const fresh = get(f.sys, 'ast_contract', c.sysId);
    expect([fresh.str('state'), fresh.str('substate'), fresh.bool('active')]).toEqual(['active', '', true]);
  });

  it('expires ended contracts once (AT 27)', () => {
    const f = fixture();
    const c = contract(f, { state: 'active', starts: plusDays(-365), ends: plusDays(-1), renewable: false });
    runContractJob(f.sys);
    runContractJob(f.sys);
    const fresh = get(f.sys, 'ast_contract', c.sysId);
    expect([fresh.str('state'), fresh.bool('active')]).toEqual(['expired', false]);
    expect(f.sys.count('sysevent', 'name=contract.expired')).toBe(1);
  });

  it('renews renewable contracts (AT 28)', () => {
    const f = fixture();
    const c = contract(f, {
      state: 'active',
      starts: plusDays(-365),
      ends: plusDays(-1),
      renewable: true,
      renewal_end_date: plusDays(365),
    });
    runContractJob(f.sys);
    const fresh = get(f.sys, 'ast_contract', c.sysId);
    expect([fresh.str('state'), fresh.str('ends'), fresh.str('starts')]).toEqual([
      'active',
      plusDays(365),
      today(),
    ]);
    expect(f.sys.count('sysevent', 'name=contract.renewed')).toBe(1);
  });

  it('sends one expiration notice (AT 29)', () => {
    const f = fixture();
    contract(f, { state: 'active', starts: plusDays(-30), ends: plusDays(60), notice_date: today() });
    runContractJob(f.sys);
    runContractJob(f.sys);
    expect(f.sys.count('sysevent', 'name=contract.expiration_notice')).toBe(1);
  });

  it('covers an asset once per contract and tracks warranty expiration (AT 30)', () => {
    const f = fixture();
    const model = f.sys.first('cmdb_contract_product_model', 'name=Warranty')!.sysId;
    const w = f.sys.insert('ast_warranty', {
      short_description: 'Warranty',
      vendor_contract: 'W1',
      contract_model: model,
      state: 'active',
      starts: plusDays(-10),
      ends: plusDays(500),
    });
    const { asset } = linkedPair(f);
    f.sys.insert('clm_m2m_contract_asset', { contract: w.sysId, asset: asset.sysId });
    expect(() => f.sys.insert('clm_m2m_contract_asset', { contract: w.sysId, asset: asset.sysId })).toThrow(
      AbortError,
    );
    const a = get(f.sys, 'alm_asset', asset.sysId);
    expect(a.str('warranty_expiration')).toBe(plusDays(500));
    expect(get(f.sys, 'cmdb_ci', a.str('ci')).str('warranty_expiration')).toBe(plusDays(500));
  });
});

describe('asset REST writes', () => {
  let app: FastifyInstance;
  let dir: string;
  let f: Fixture;
  const AUTH = `Basic ${Buffer.from('asset.mgr:Password1!').toString('base64')}`;
  const headers = { authorization: AUTH, 'content-type': 'application/json' };

  beforeAll(async () => {
    f = fixture();
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-asset-'));
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
    p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies lifecycle rules to Table API writes (AT 1, 2, 3, 5, 24)', async () => {
    const noRoom = await app.inject({
      method: 'POST',
      url: '/api/now/table/alm_hardware',
      headers,
      payload: { model: f.M1, install_status: '6' },
    });
    expect(noRoom.statusCode).toBe(403);
    expect(noRoom.json().error.detail).toContain('Stockroom');
    expect(f.sys.count('cmdb_ci')).toBe(0);
    const reserved = await app.inject({
      method: 'POST',
      url: '/api/now/table/alm_hardware',
      headers,
      payload: { model: f.M1, install_status: '6', substatus: 'reserved', stockroom: f.S1 },
    });
    expect(reserved.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/now/table/alm_hardware',
      headers,
      payload: { model: f.M1, asset_tag: 'R1', install_status: '6', stockroom: f.S1 },
    });
    expect(ok.statusCode).toBe(201);
    const created = ok.json().result;
    expect(created).toMatchObject({ substatus: 'available', quantity: '1', display_name: 'R1 - M1' });
    expect(created.location.value).toBe(f.L1);
    const ci = f.sys.first('cmdb_ci', `asset=${created.sys_id}`)!;
    expect(ci.str('hardware_substatus')).toBe('available');
    const sold = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/alm_hardware/${created.sys_id}`,
      headers,
      payload: { substatus: 'sold' },
    });
    expect(sold.statusCode).toBe(403);
    expect(sold.json().error.detail).toContain('Substate sold');
    const base = await app.inject({
      method: 'POST',
      url: '/api/now/table/alm_asset',
      headers,
      payload: { model: f.M1, install_status: '1' },
    });
    expect(base.json().result.sys_class_name).toBe('alm_hardware');
  });
});

describe('asset demo data', () => {
  it('creates linked assets for the demo laptops and servers', () => {
    p = bootPlatform([cmdbModule, assetModule], { demo: true });
    const ctx = p.systemContext();
    expect(p.errors).toEqual([]);
    const laptops = ctx.query('alm_hardware', 'asset_tagSTARTSWITHNWL-LT-10^install_status=1');
    expect(laptops.length).toBe(12);
    for (const l of laptops) {
      expect(l.str('ci')).not.toBe('');
      expect(l.str('assigned_to')).not.toBe('');
    }
    const server = ctx.first('cmdb_ci', 'name=cp-db-01')!;
    const asset = ctx.first('alm_asset', `ci=${server.sysId}`)!;
    expect(asset.display('model_category')).toBe('Server');
    expect(server.str('asset')).toBe(asset.sysId);
    expect(ctx.count('alm_hardware', 'install_status=6')).toBeGreaterThanOrEqual(3);
    expect(ctx.count('ast_contract')).toBeGreaterThanOrEqual(3);
    expect(ctx.count('clm_m2m_contract_asset')).toBeGreaterThan(5);
  });
});
