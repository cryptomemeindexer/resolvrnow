// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fulfillment step templates use ${variable} placeholders
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AbortError } from '../src/engine/errors.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import { approvalsModule } from '../src/modules/approvals/index.js';
import { CatalogAccess } from '../src/modules/catalog/access.js';
import { fulfillmentOf } from '../src/modules/catalog/fulfillment.js';
import { evaluateGuide, guideToCart, orderGuide } from '../src/modules/catalog/guide.js';
import { catalogModule } from '../src/modules/catalog/index.js';
import { addLines, CART, checkout, ensureCart, orderNow } from '../src/modules/catalog/ordering.js';
import { myRequests, ticketDetail } from '../src/modules/catalog/portal.js';
import { submitProducer } from '../src/modules/catalog/producer.js';
import { VariableError } from '../src/modules/catalog/util.js';
import type { ApprovalService, FlowService } from '../src/modules/contracts.js';
import { flowModule } from '../src/modules/flow/index.js';
import { incidentModule } from '../src/modules/incident/index.js';
import { bootPlatform, makeUser } from './helpers.js';

const DAY = 86_400_000;
const PW = 'Password1!';
const basic = (u: string, pw = PW) => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
const SC = '/api/sn_sc/servicecatalog';

interface Fixture {
  p: Platform;
  sys: Context;
  ids: Record<string, string>;
  catalog: Rec;
  hardware: Rec;
  laptop: Rec;
  mouse: Rec;
}

let current: Platform | null = null;

afterEach(() => {
  current?.close();
  current = null;
  clock.reset();
});

function variable(
  sys: Context,
  item: Rec,
  values: Record<string, unknown>,
  choices: [string, string, number?][] = [],
): Rec {
  const v = sys.insert('item_option_new', { cat_item: item.sysId, ...values });
  choices.forEach(([value, text, price], i) => {
    sys.insert('question_choice', { question: v.sysId, value, text, price: price ?? 0, order: (i + 1) * 10 });
  });
  return v;
}

/** Catalog fixture: Laptop (manager approval, variables, two fulfillment steps) and a plain Wireless Mouse. */
function setup(extra: AppModule[] = [], opts: { boot?: boolean } = {}): Fixture {
  const p = bootPlatform([...extra, catalogModule]);
  if (opts.boot !== false) current = p;
  const sys = p.systemContext();
  const ids: Record<string, string> = {
    mike: makeUser(p, 'mike.manager'),
    alice: makeUser(p, 'alice.user'),
    bob: makeUser(p, 'bob.agent', ['itil'], ['Hardware Fulfilment']),
    carol: makeUser(p, 'carol.admin', ['catalog_admin']),
    dave: makeUser(p, 'dave.sales'),
    erin: makeUser(p, 'erin.user'),
  };
  ids.sales = sys.insert('cmn_department', { name: 'Sales' }).sysId;
  sys.update(sys.get('sys_user', ids.alice)!, { manager: ids.mike });
  sys.update(sys.get('sys_user', ids.dave)!, { department: ids.sales });
  p.users.invalidate();
  ids.hw = sys.first('sys_user_group', 'name=Hardware Fulfilment')!.sysId;
  const catalog = sys.first('sc_catalog', 'title=Service Catalog')!;
  const hardware = sys.insert('sc_category', { title: 'Hardware', sc_catalog: catalog.sysId });
  const laptop = sys.insert('sc_cat_item', {
    name: 'Laptop',
    short_description: 'Standard business laptop',
    price: 1000,
    category: hardware.sysId,
    group: ids.hw,
    u_manager_approval: true,
    delivery_time: 2 * DAY,
    meta: 'notebook, computer',
  });
  variable(sys, laptop, {
    name: 'requested_for',
    question_text: 'Requested for',
    type: 31,
    order: 10,
    enable_also_request_for: true,
  });
  variable(sys, laptop, { name: 'ram', question_text: 'RAM', type: 5, order: 20, mandatory: true }, [
    ['8GB', '8 GB', 0],
    ['16GB', '16 GB', 200],
  ]);
  variable(sys, laptop, {
    name: 'justification',
    question_text: 'Justification',
    type: 2,
    order: 30,
    mandatory: true,
  });
  variable(sys, laptop, {
    name: 'warranty',
    question_text: 'Extended warranty',
    type: 7,
    order: 40,
    price_if_checked: 50,
  });
  sys.insert('resolvr_cat_item_fulfillment_step', {
    cat_item: laptop.sysId,
    order: 100,
    name: 'Prepare',
    short_description: 'Prepare a ${ram} laptop for ${requested_for}',
    assignment_group: ids.hw,
  });
  sys.insert('resolvr_cat_item_fulfillment_step', {
    cat_item: laptop.sysId,
    order: 200,
    name: 'Deliver',
    short_description: 'Deliver the laptop to ${requested_for}',
    assignment_group: ids.hw,
    stage: 'delivery',
  });
  const mouse = sys.insert('sc_cat_item', {
    name: 'Wireless Mouse',
    price: 25,
    category: hardware.sysId,
    group: ids.hw,
  });
  return {
    p,
    sys,
    ids,
    catalog,
    hardware,
    laptop: sys.get('sc_cat_item', laptop.sysId)!,
    mouse: sys.get('sc_cat_item', mouse.sysId)!,
  };
}

const laptopVars = (extra: Record<string, unknown> = {}) => ({
  ram: '16GB',
  justification: 'Old one is broken',
  ...extra,
});
const as = (f: Fixture, user: string) => f.p.contextAs(user);
const ritmOf = (f: Fixture, id: string) => f.sys.get('sc_req_item', id)!;
const reqOf = (f: Fixture, id: string) => f.sys.get('sc_request', id)!;
const tasksOf = (f: Fixture, ritmId: string) =>
  f.sys.query('sc_task', { query: `request_item=${ritmId}`, orderBy: [{ field: 'number', desc: false }] });
const closeTask = (f: Fixture, t: Rec, state = '3') =>
  f.sys.update(f.sys.get('sc_task', t.sysId)!, { state });

function order(f: Fixture, user: string, item: Rec, variables: Record<string, unknown> = {}, quantity = 1) {
  const r = orderNow(as(f, user), item, { quantity, variables });
  f.p.drain();
  return r;
}

function expectHttp(fn: () => unknown, status: number, message?: string | RegExp): void {
  try {
    fn();
  } catch (e) {
    const err = e as { status?: number; message: string };
    expect(err.status).toBe(status);
    if (message) expect(err.message).toMatch(message);
    return;
  }
  throw new Error('expected an error');
}

// ======================================================================= ordering

describe('ordering and checkout', () => {
  it('order now creates one request and one requested item with answers and prices', () => {
    const f = setup();
    const { request, items } = order(f, 'alice.user', f.laptop, laptopVars({ warranty: 'true' }), 2);
    expect(request.str('number')).toMatch(/^REQ\d{7}$/);
    expect(items).toHaveLength(1);
    const ritm = ritmOf(f, items[0].sysId);
    expect(ritm.str('number')).toMatch(/^RITM\d{7}$/);
    expect(ritm.str('request')).toBe(request.sysId);
    expect(ritm.num('quantity')).toBe(2);
    expect(ritm.num('price')).toBe(1250);
    expect(reqOf(f, request.sysId).num('price')).toBe(2500);
    expect(ritm.str('requested_for')).toBe(f.ids.alice);
    expect(ritm.str('opened_by')).toBe(f.ids.alice);
    expect(request.str('opened_by')).toBe(f.ids.alice);
    const links = f.sys.query('sc_item_option_mtom', `request_item=${ritm.sysId}`);
    const answers = Object.fromEntries(
      links.map((l) => [
        l.ref('sc_item_option')!.ref('item_option_new')!.str('name'),
        l.ref('sc_item_option')!.str('value'),
      ]),
    );
    expect(answers).toMatchObject({
      ram: '16GB',
      justification: 'Old one is broken',
      warranty: 'true',
      requested_for: f.ids.alice,
    });
    expect(f.sys.count('sc_cart_item')).toBe(0);
    expect(f.sys.count('sc_cart')).toBe(0);
  });

  it('cart checkout places one request with one item per line and relinks the answers', () => {
    const f = setup();
    const alice = as(f, 'alice.user');
    const cart = ensureCart(alice);
    addLines(alice, cart, f.laptop, { quantity: 1, variables: laptopVars() });
    addLines(alice, cart, f.mouse, { quantity: 3 });
    expect(f.sys.count('sc_item_option_mtom', 'cart_itemISNOTEMPTY')).toBeGreaterThan(0);
    const { request, items } = checkout(alice, cart);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.str('request') === request.sysId)).toBe(true);
    expect(reqOf(f, request.sysId).num('price')).toBe(1200 + 75);
    expect(f.sys.count('sc_item_option_mtom', 'cart_itemISNOTEMPTY')).toBe(0);
    expect(f.sys.count('sc_item_option_mtom', `request_item=${items[0].sysId}`)).toBe(4);
    expect(f.sys.count('sc_cart_item', `cart=${cart.sysId}`)).toBe(0);
    expectHttp(() => checkout(alice, cart), 400, 'Cart is empty');
  });

  it('order now leaves the default cart untouched', () => {
    const f = setup();
    const alice = as(f, 'alice.user');
    addLines(alice, ensureCart(alice), f.laptop, { quantity: 1, variables: laptopVars() });
    const { items } = order(f, 'alice.user', f.mouse);
    expect(items[0].str('cat_item')).toBe(f.mouse.sysId);
    expect(f.sys.count('sc_cart_item', `cart.name=${CART.default}^cat_item=${f.laptop.sysId}`)).toBe(1);
  });

  it('orders on behalf of another user through the Requested For variable', () => {
    const f = setup();
    const { request, items } = order(f, 'alice.user', f.laptop, laptopVars({ requested_for: 'erin.user' }));
    expect(items[0].str('requested_for')).toBe(f.ids.erin);
    expect(request.str('requested_for')).toBe(f.ids.erin);
    expect(request.str('opened_by')).toBe(f.ids.alice);
    const ev = f.sys.query('sysevent', `name=sc_request.requested_for^instance=${request.sysId}`);
    expect(ev.map((e) => e.str('parm1'))).toEqual([f.ids.erin]);
  });

  it('refuses ordering for others when glide.sc.req_for.roles.default is deny', () => {
    const f = setup();
    f.p.properties.set('glide.sc.req_for.roles.default', 'deny');
    expectHttp(
      () => order(f, 'alice.user', f.laptop, laptopVars({ requested_for: f.ids.erin })),
      400,
      'Security constraints prevent ordering of Item',
    );
    expect(f.sys.count('sc_request')).toBe(0);
    f.p.properties.set('glide.sc.req_for.roles', 'itil');
    const r = order(f, 'bob.agent', f.laptop, laptopVars({ requested_for: f.ids.erin }));
    expect(r.items[0].str('requested_for')).toBe(f.ids.erin);
  });

  it('Also Request For creates one requested item per user under one request', () => {
    const f = setup();
    const r = orderNow(as(f, 'alice.user'), f.laptop, {
      quantity: 1,
      variables: laptopVars(),
      alsoRequestFor: [f.ids.erin, 'dave.sales'],
    });
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.str('requested_for')).sort()).toEqual(
      [f.ids.alice, f.ids.dave, f.ids.erin].sort(),
    );
    expect(r.request.str('requested_for')).toBe(f.ids.alice);
    const many = Array.from({ length: 51 }, (_, i) => makeUser(f.p, `bulk.user${i}`));
    expectHttp(
      () =>
        orderNow(as(f, 'alice.user'), f.laptop, {
          quantity: 1,
          variables: laptopVars(),
          alsoRequestFor: many,
        }),
      400,
    );
    expectHttp(
      () => orderNow(as(f, 'alice.user'), f.mouse, { quantity: 1, alsoRequestFor: [f.ids.erin] }),
      400,
      'Security constraints',
    );
  });

  it('estimates delivery from the item delivery time and sets the request due date', () => {
    const f = setup();
    clock.freeze('2026-01-05 10:00:00');
    const quick = f.sys.insert('sc_cat_item', {
      name: 'Cable',
      price: 5,
      category: f.hardware.sysId,
      delivery_time: 1 * DAY,
    });
    const alice = as(f, 'alice.user');
    const cart = ensureCart(alice);
    addLines(alice, cart, f.laptop, { quantity: 1, variables: laptopVars() });
    addLines(alice, cart, f.sys.get('sc_cat_item', quick.sysId)!, { quantity: 1 });
    const { request, items } = checkout(alice, cart);
    expect(items[0].str('estimated_delivery')).toBe('2026-01-07 10:00:00');
    expect(items[1].str('estimated_delivery')).toBe('2026-01-06 10:00:00');
    expect(reqOf(f, request.sysId).str('due_date')).toBe('2026-01-07 10:00:00');
  });

  it('rejects unknown quantities and items the user cannot order', () => {
    const f = setup();
    const alice = as(f, 'alice.user');
    expectHttp(() => orderNow(alice, f.mouse, { quantity: Number.NaN }), 400);
    f.sys.update(f.sys.get('sc_cat_item', f.mouse.sysId)!, { active: false });
    expectHttp(
      () => orderNow(alice, f.sys.get('sc_cat_item', f.mouse.sysId)!, { quantity: 1 }),
      400,
      'Security constraints prevent ordering of Item',
    );
  });
});

// ============================================================ variable validation

describe('variable validation', () => {
  it('requires mandatory variables', () => {
    const f = setup();
    try {
      orderNow(as(f, 'alice.user'), f.laptop, { quantity: 1, variables: { ram: '8GB' } });
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(VariableError);
      expect((e as VariableError).message).toBe('Mandatory Variables are required');
      expect((e as VariableError).fields.map((x) => x.variable)).toEqual(['justification']);
    }
    expect(f.sys.count('sc_request')).toBe(0);
  });

  it('checks choices, formats, regex, length and reference qualifiers', () => {
    const f = setup();
    const item = f.sys.insert('sc_cat_item', { name: 'Access card', category: f.hardware.sysId });
    variable(f.sys, item, { name: 'size', question_text: 'Size', type: 5 }, [
      ['s', 'Small'],
      ['l', 'Large'],
    ]);
    variable(f.sys, item, {
      name: 'badge',
      question_text: 'Badge id',
      type: 6,
      validate_regex: '^B-\\d{4}$',
      attributes: 'max_length=6',
    });
    variable(f.sys, item, { name: 'start', question_text: 'Start', type: 9 });
    variable(f.sys, item, { name: 'mail', question_text: 'Mail', type: 26 });
    variable(f.sys, item, { name: 'site', question_text: 'Site', type: 27 });
    variable(f.sys, item, { name: 'ip', question_text: 'IP', type: 28 });
    variable(f.sys, item, {
      name: 'escort',
      question_text: 'Escort',
      type: 8,
      reference: 'sys_user',
      reference_qual_condition: 'active=true^user_nameSTARTSWITHbob',
    });
    variable(f.sys, item, { name: 'visitor', question_text: 'Visitor?', type: 1 });
    const rec = f.sys.get('sc_cat_item', item.sysId)!;
    const alice = as(f, 'alice.user');
    const bad = (variables: Record<string, unknown>) => {
      try {
        orderNow(alice, rec, { quantity: 1, variables });
      } catch (e) {
        expect((e as VariableError).message).toBe('Invalid variable value');
        return (e as VariableError).fields.map((x) => x.variable);
      }
      throw new Error('expected failure');
    };
    expect(bad({ size: 'xl' })).toEqual(['size']);
    expect(bad({ badge: 'X-1' })).toEqual(['badge']);
    expect(bad({ badge: 'B-12345' })).toEqual(['badge']);
    expect(bad({ start: 'next week', mail: 'nope', site: 'not a url', ip: '300.1.1.1' })).toEqual([
      'start',
      'mail',
      'site',
      'ip',
    ]);
    expect(bad({ escort: f.ids.alice })).toEqual(['escort']);
    expect(bad({ visitor: 'maybe' })).toEqual(['visitor']);
    const ok = orderNow(alice, rec, {
      quantity: 1,
      variables: {
        size: 'Large',
        badge: 'B-1234',
        start: '2026-02-01',
        mail: 'a@b.co',
        site: 'https://northwind.example',
        ip: '10.0.0.1',
        escort: 'bob.agent',
        visitor: true,
      },
    });
    const opts = f.sys
      .query('sc_item_option_mtom', `request_item=${ok.items[0].sysId}`)
      .map((l) => l.ref('sc_item_option')!);
    const byName = Object.fromEntries(
      opts.map((o) => [o.ref('item_option_new')!.str('name'), o.str('value')]),
    );
    expect(byName).toMatchObject({ size: 'l', escort: f.ids.bob, visitor: 'Yes', start: '2026-02-01' });
  });

  it('re-evaluates catalog UI policies on the server', () => {
    const f = setup();
    const item = f.sys.insert('sc_cat_item', { name: 'Laptop B', price: 900, category: f.hardware.sysId });
    variable(f.sys, item, { name: 'ram', question_text: 'RAM', type: 5 }, [
      ['8GB', '8 GB'],
      ['16GB', '16 GB'],
    ]);
    variable(f.sys, item, { name: 'justification', question_text: 'Justification', type: 2 });
    const policy = f.sys.insert('catalog_ui_policy', {
      catalog_item: item.sysId,
      short_description: '16 GB needs a reason',
      catalog_conditions: 'ram=16GB',
      reverse_if_false: true,
    });
    f.sys.insert('catalog_ui_policy_action', {
      ui_policy: policy.sysId,
      catalog_variable: 'justification',
      mandatory: 'true',
    });
    const rec = f.sys.get('sc_cat_item', item.sysId)!;
    expect(orderNow(as(f, 'alice.user'), rec, { quantity: 1, variables: { ram: '8GB' } }).items).toHaveLength(
      1,
    );
    expectHttp(
      () => orderNow(as(f, 'alice.user'), rec, { quantity: 1, variables: { ram: '16GB' } }),
      400,
      'Mandatory Variables are required',
    );
  });

  it('limits multi-row variable set rows and stores them per row', () => {
    const f = setup();
    const item = f.sys.insert('sc_cat_item', { name: 'Distribution lists', category: f.hardware.sysId });
    const set = f.sys.insert('item_option_new_set', {
      title: 'Lists',
      internal_name: 'lists',
      type: 'one_to_many',
      set_attributes: 'max_rows=2',
    });
    f.sys.insert('io_set_item', { sc_cat_item: item.sysId, variable_set: set.sysId });
    f.sys.insert('item_option_new', {
      variable_set: set.sysId,
      name: 'list_name',
      question_text: 'List',
      type: 6,
      mandatory: true,
    });
    f.sys.insert('item_option_new', {
      variable_set: set.sysId,
      name: 'owner',
      question_text: 'Owner',
      type: 7,
    });
    const rec = f.sys.get('sc_cat_item', item.sysId)!;
    const rows = (n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ list_name: `team-${i}`, owner: i === 0 })));
    expectHttp(
      () => orderNow(as(f, 'alice.user'), rec, { quantity: 1, variables: { lists: rows(3) } }),
      400,
      'Invalid variable value',
    );
    const r = orderNow(as(f, 'alice.user'), rec, { quantity: 1, variables: { lists: rows(2) } });
    const stored = f.sys.query('sc_multi_row_question_answer', `parent_id=${r.items[0].sysId}`);
    expect(stored).toHaveLength(4);
    expect(stored.every((s) => s.str('parent_table_name') === 'sc_req_item')).toBe(true);
  });

  it('encrypts masked answers and reveals them only to the requester', () => {
    const f = setup();
    const item = f.sys.insert('sc_cat_item', { name: 'Wi-Fi guest code', category: f.hardware.sysId });
    variable(f.sys, item, { name: 'pin', question_text: 'Door PIN', type: 25 });
    const r = order(f, 'alice.user', f.sys.get('sc_cat_item', item.sysId)!, { pin: '4321' });
    const opt = f.sys
      .query('sc_item_option_mtom', `request_item=${r.items[0].sysId}`)[0]
      .ref('sc_item_option')!;
    expect(opt.str('value')).toMatch(/^enc:v1:/);
    const mine = ticketDetail(as(f, 'alice.user'), 'sc_req_item', r.items[0].sysId).variables as {
      name: string;
      value: string;
    }[];
    expect(mine.find((v) => v.name === 'pin')?.value).toBe('4321');
    const agent = ticketDetail(as(f, 'bob.agent'), 'sc_req_item', r.items[0].sysId).variables as {
      name: string;
      value: string;
    }[];
    expect(agent.find((v) => v.name === 'pin')?.value).toBe('********');
  });
});

// ================================================================== fulfillment

describe('native fulfillment', () => {
  it('runs the steps in order, moves the stages and closes the item and the request', () => {
    const f = setup();
    const { request, items } = order(f, 'alice.user', f.laptop, laptopVars());
    let ritm = ritmOf(f, items[0].sysId);
    // No approvals module: the manager approval is skipped and fulfillment starts.
    expect(ritm.str('stage')).toBe('fulfillment');
    expect(ritm.str('state')).toBe('2');
    expect(ritm.str('approval')).toBe('approved');
    let tasks = tasksOf(f, ritm.sysId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].str('number')).toMatch(/^SCTASK\d{7}$/);
    expect(tasks[0].str('short_description')).toBe('Prepare a 16 GB laptop for alice user');
    expect(tasks[0].str('request')).toBe(request.sysId);
    expect(tasks[0].str('cat_item')).toBe(f.laptop.sysId);
    expect(tasks[0].str('assignment_group')).toBe(f.ids.hw);
    expect(tasks[0].str('description')).toContain('RAM: 16 GB');
    expect(reqOf(f, request.sysId).str('stage')).toBe('fulfillment');
    closeTask(f, tasks[0]);
    ritm = ritmOf(f, ritm.sysId);
    expect(ritm.str('stage')).toBe('delivery');
    tasks = tasksOf(f, ritm.sysId);
    expect(tasks).toHaveLength(2);
    expect(f.sys.count('sysevent', `name=sc_req_item.delivery^instance=${ritm.sysId}`)).toBe(1);
    closeTask(f, tasks[1]);
    ritm = ritmOf(f, ritm.sysId);
    expect(ritm.str('state')).toBe('3');
    expect(ritm.str('stage')).toBe('complete');
    expect(ritm.bool('active')).toBe(false);
    const req = reqOf(f, request.sysId);
    expect(req.str('state')).toBe('3');
    expect(req.str('request_state')).toBe('closed_complete');
    expect(req.bool('active')).toBe(false);
  });

  it('rolls task states up to the item and items up to the request', () => {
    const f = setup();
    const item = f.sys.insert('sc_cat_item', { name: 'Desk move', category: f.hardware.sysId });
    for (const name of ['Pack', 'Move'])
      f.sys.insert('resolvr_cat_item_fulfillment_step', {
        cat_item: item.sysId,
        order: 100,
        name,
        short_description: name,
        assignment_group: f.ids.hw,
      });
    const rec = f.sys.get('sc_cat_item', item.sysId)!;
    const run = (states: [string, string]) => {
      const r = order(f, 'erin.user', rec);
      const tasks = tasksOf(f, r.items[0].sysId);
      expect(tasks).toHaveLength(2);
      closeTask(f, tasks[0], states[0]);
      expect(ritmOf(f, r.items[0].sysId).bool('active')).toBe(true);
      closeTask(f, tasks[1], states[1]);
      return { ritm: ritmOf(f, r.items[0].sysId), req: reqOf(f, r.request.sysId) };
    };
    const complete = run(['3', '3']);
    expect([complete.ritm.str('state'), complete.req.str('request_state')]).toEqual(['3', 'closed_complete']);
    const incomplete = run(['3', '4']);
    expect([incomplete.ritm.str('state'), incomplete.req.str('request_state')]).toEqual([
      '4',
      'closed_incomplete',
    ]);
    const skipped = run(['7', '7']);
    expect([skipped.ritm.str('state'), skipped.req.str('request_state')]).toEqual(['7', 'closed_skipped']);
    const mixed = run(['3', '7']);
    expect(mixed.ritm.str('state')).toBe('3');
  });

  it('closes the request only when every item is closed', () => {
    const f = setup();
    const alice = as(f, 'alice.user');
    const cart = ensureCart(alice);
    addLines(alice, cart, f.mouse, { quantity: 1 });
    addLines(alice, cart, f.mouse, { quantity: 2 });
    const { request, items } = checkout(alice, cart);
    f.p.drain();
    closeTask(f, tasksOf(f, items[0].sysId)[0], '3');
    expect(reqOf(f, request.sysId).bool('active')).toBe(true);
    closeTask(f, tasksOf(f, items[1].sysId)[0], '4');
    const req = reqOf(f, request.sysId);
    expect(req.str('request_state')).toBe('closed_incomplete');
    expect(req.str('state')).toBe('4');
  });

  it('creates one task for the fulfillment group when the item has no steps', () => {
    const f = setup();
    const r = order(f, 'alice.user', f.mouse);
    const tasks = tasksOf(f, r.items[0].sysId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].str('short_description')).toBe('Wireless Mouse');
    expect(tasks[0].str('assignment_group')).toBe(f.ids.hw);
    expect(f.sys.count('sysevent', `name=sc_task.assigned.to.group^instance=${tasks[0].sysId}`)).toBe(1);
    f.sys.update(tasks[0], { assigned_to: f.ids.bob });
    f.sys.update(f.sys.get('sc_task', tasks[0].sysId)!, { work_notes: 'On it' });
    expect(f.sys.count('sysevent', `name=sc_task.assigned.to.user^instance=${tasks[0].sysId}`)).toBe(1);
  });

  it('closes fully automated items without tasks and skips steps whose condition fails', () => {
    const f = setup();
    const auto = f.sys.insert('sc_cat_item', {
      name: 'Roaming',
      category: f.hardware.sysId,
      fulfillment_automation_level: 'fully_automated',
    });
    const r = order(f, 'alice.user', f.sys.get('sc_cat_item', auto.sysId)!);
    const ritm = ritmOf(f, r.items[0].sysId);
    expect([ritm.str('stage'), ritm.str('state')]).toEqual(['complete', '3']);
    expect(tasksOf(f, ritm.sysId)).toHaveLength(0);

    const cond = f.sys.insert('sc_cat_item', { name: 'Phone', category: f.hardware.sysId });
    variable(f.sys, cond, { name: 'esim', question_text: 'eSIM only', type: 7 });
    f.sys.insert('resolvr_cat_item_fulfillment_step', {
      cat_item: cond.sysId,
      order: 100,
      name: 'Ship SIM',
      short_description: 'Ship SIM',
      condition: 'esim=false',
    });
    f.sys.insert('resolvr_cat_item_fulfillment_step', {
      cat_item: cond.sysId,
      order: 200,
      name: 'Activate',
      short_description: 'Activate line',
    });
    const r2 = order(f, 'alice.user', f.sys.get('sc_cat_item', cond.sysId)!, { esim: 'true' });
    expect(tasksOf(f, r2.items[0].sysId).map((t) => t.str('short_description'))).toEqual(['Activate line']);
  });

  it('starts requests and items created outside checkout; items without a catalog item stay manual', () => {
    const f = setup();
    const bob = as(f, 'bob.agent');
    const req = bob.insert('sc_request', { requested_for: f.ids.alice, short_description: 'Phone request' });
    const manual = bob.insert('sc_req_item', {
      request: req.sysId,
      short_description: 'Set up a desk phone',
    });
    f.p.drain();
    expect(reqOf(f, req.sysId).str('request_state')).toBe('in_process');
    const m = ritmOf(f, manual.sysId);
    expect([m.str('stage'), m.str('state'), m.bool('active')]).toEqual(['fulfillment', '2', true]);
    expect(tasksOf(f, manual.sysId)).toHaveLength(0);
    const added = bob.insert('sc_req_item', { request: req.sysId, cat_item: f.mouse.sysId, quantity: 1 });
    f.p.drain();
    expect(ritmOf(f, added.sysId).str('stage')).toBe('fulfillment');
    expect(tasksOf(f, added.sysId)).toHaveLength(1);
  });

  it('cancels an item: open tasks are skipped and the request closes as cancelled', () => {
    const f = setup();
    const r = order(f, 'alice.user', f.mouse);
    fulfillmentOf(f.p).cancelItem(as(f, 'bob.agent'), ritmOf(f, r.items[0].sysId), 'Duplicate order');
    const ritm = ritmOf(f, r.items[0].sysId);
    expect([ritm.str('stage'), ritm.str('state'), ritm.bool('active')]).toEqual([
      'Request Cancelled',
      '4',
      false,
    ]);
    expect(tasksOf(f, ritm.sysId).map((t) => t.str('state'))).toEqual(['7']);
    expect(reqOf(f, r.request.sysId).str('request_state')).toBe('closed_cancelled');
  });

  it('locks the quantity of approved items except for catalog admins', async () => {
    const f = setup();
    const r = order(f, 'alice.user', f.mouse);
    const dir = mkdtempSync(join(tmpdir(), 'resolvrnow-cat-'));
    const app = await buildApp(f.p, config(dir));
    try {
      const patch = (user: string) =>
        app.inject({
          method: 'PATCH',
          url: `/api/now/table/sc_req_item/${r.items[0].sysId}`,
          headers: { authorization: basic(user), 'content-type': 'application/json' },
          payload: { quantity: '2' },
        });
      await patch('bob.agent');
      expect(ritmOf(f, r.items[0].sysId).num('quantity')).toBe(1);
      makeUser(f.p, 'cara.catalog', ['itil', 'catalog_admin']);
      await patch('cara.catalog');
      expect(ritmOf(f, r.items[0].sysId).num('quantity')).toBe(2);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ==================================================================== approvals

describe('approvals', () => {
  const withApprovals = () => setup([approvalsModule]);
  const probe = bootPlatform([approvalsModule]);
  const hasApprovals = probe.services.has('approvals');
  probe.close();

  it.runIf(hasApprovals)('asks the manager, then creates the tasks once approved', () => {
    const f = withApprovals();
    const { request, items } = order(f, 'alice.user', f.laptop, laptopVars());
    let ritm = ritmOf(f, items[0].sysId);
    expect([ritm.str('stage'), ritm.str('approval'), ritm.str('state')]).toEqual([
      'waiting_for_approval',
      'requested',
      '1',
    ]);
    expect(tasksOf(f, ritm.sysId)).toHaveLength(0);
    const rows = f.sys.query('sysapproval_approver', `document_id=${ritm.sysId}`);
    expect(rows.map((r) => [r.str('approver'), r.str('state')])).toEqual([[f.ids.mike, 'requested']]);
    expect(reqOf(f, request.sysId).str('stage')).toBe('waiting_for_approval');
    f.p.service<ApprovalService>('approvals').decide(as(f, 'mike.manager'), rows[0], 'approved');
    f.p.drain();
    ritm = ritmOf(f, ritm.sysId);
    expect([ritm.str('stage'), ritm.str('approval'), ritm.str('state')]).toEqual([
      'fulfillment',
      'approved',
      '2',
    ]);
    const tasks = tasksOf(f, ritm.sysId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].str('request')).toBe(request.sysId);
    expect(tasks[0].str('assignment_group')).toBe(f.ids.hw);
  });

  it.runIf(hasApprovals)('cancels the item when the approver rejects', () => {
    const f = withApprovals();
    const { request, items } = order(f, 'alice.user', f.laptop, laptopVars());
    const row = f.sys.query('sysapproval_approver', `document_id=${items[0].sysId}`)[0];
    f.p.service<ApprovalService>('approvals').decide(as(f, 'mike.manager'), row, 'rejected', 'No budget');
    f.p.drain();
    const ritm = ritmOf(f, items[0].sysId);
    expect([ritm.str('stage'), ritm.str('approval'), ritm.str('state'), ritm.bool('active')]).toEqual([
      'Request Cancelled',
      'rejected',
      '4',
      false,
    ]);
    expect(tasksOf(f, ritm.sysId)).toHaveLength(0);
    expect(reqOf(f, request.sysId).str('request_state')).toBe('closed_rejected');
  });

  it.runIf(hasApprovals)('uses group approvals configured on the item and the Approve shortcut', () => {
    const f = withApprovals();
    const secId = f.sys.insert('sys_user_group', { name: 'Security' }).sysId;
    const sec = makeUser(f.p, 'sara.security', ['itil'], ['Security']);
    const item = f.sys.insert('sc_cat_item', {
      name: 'Admin rights',
      category: f.hardware.sysId,
      group: f.ids.hw,
    });
    f.sys.insert('sc_cat_item_app_group', { sc_cat_item: item.sysId, approver: secId });
    const r = order(f, 'erin.user', f.sys.get('sc_cat_item', item.sysId)!);
    const ritm = ritmOf(f, r.items[0].sysId);
    expect(ritm.str('approval')).toBe('requested');
    expect(
      f.sys.query('sysapproval_approver', `document_id=${ritm.sysId}`).map((x) => x.str('approver')),
    ).toContain(sec);
    const action = f.p.uiActions.get('sc_req_item.approve')!;
    const sara = as(f, 'sara.security');
    expect(typeof action.condition === 'function' && action.condition(ritm, sara)).toBe(true);
    expect(typeof action.condition === 'function' && action.condition(ritm, as(f, 'erin.user'))).toBe(false);
    action.run(ritm, sara, {});
    f.p.drain();
    expect(ritmOf(f, ritm.sysId).str('stage')).toBe('fulfillment');
  });

  it.runIf(hasApprovals)('lets the requester cancel while waiting for approval', () => {
    const f = withApprovals();
    const { request, items } = order(f, 'alice.user', f.laptop, laptopVars());
    const alice = as(f, 'alice.user');
    const f2 = fulfillmentOf(f.p);
    expect(f2.canCancel(alice, ritmOf(f, items[0].sysId))).toBe(true);
    expect(f2.canCancel(as(f, 'erin.user'), ritmOf(f, items[0].sysId))).toBe(false);
    f2.cancelRequest(alice, reqOf(f, request.sysId), 'Changed my mind');
    const ritm = ritmOf(f, items[0].sysId);
    expect([ritm.str('stage'), ritm.bool('active')]).toEqual(['Request Cancelled', false]);
    expect(
      f.sys.query('sysapproval_approver', `document_id=${ritm.sysId}`).map((x) => x.str('state')),
    ).toEqual(['cancelled']);
    expect(reqOf(f, request.sysId).str('request_state')).toBe('closed_cancelled');
  });

  it.runIf(hasApprovals)('asks for a request-level approval above the price threshold', () => {
    const f = withApprovals();
    f.p.properties.set('resolvr.sc.request_approval_threshold', '500');
    const { request, items } = order(f, 'alice.user', f.mouse, {}, 30);
    expect(reqOf(f, request.sysId).str('approval')).toBe('requested');
    expect(ritmOf(f, items[0].sysId).str('stage')).toBe('waiting_for_approval');
    const row = f.sys.query('sysapproval_approver', `document_id=${request.sysId}`)[0];
    f.p.service<ApprovalService>('approvals').decide(as(f, 'mike.manager'), row, 'approved');
    f.p.drain();
    expect(reqOf(f, request.sysId).str('request_state')).toBe('in_process');
    expect(ritmOf(f, items[0].sysId).str('stage')).toBe('fulfillment');
  });
});

// ============================================================== flows (contract)

describe('flow hand-off', () => {
  it('starts the item flow instead of the built-in steps and offers catalog actions', () => {
    const f = setup();
    const started: { flow: string; record: string; inputs: Record<string, unknown> }[] = [];
    const actions = new Map<string, Parameters<FlowService['registerAction']>[1]>();
    const fake: FlowService = {
      start(ctx, flow, record, inputs) {
        started.push({ flow, record: record?.sysId ?? '', inputs: inputs ?? {} });
        return ctx.platform.systemContext().first('sys_user', 'user_name=admin');
      },
      registerAction(type, run) {
        actions.set(type, run);
      },
    };
    f.p.services.set('flows', fake);
    fulfillmentOf(f.p).registerFlowActions();
    expect([...actions.keys()]).toEqual(
      expect.arrayContaining(['create_catalog_task', 'set_ritm_stage', 'get_catalog_variables']),
    );
    f.sys.update(f.sys.get('sc_cat_item', f.laptop.sysId)!, { flow: 'laptop_fulfillment' });
    const r = order(f, 'alice.user', f.sys.get('sc_cat_item', f.laptop.sysId)!, laptopVars());
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ flow: 'laptop_fulfillment', record: r.items[0].sysId });
    expect(started[0].inputs.variables).toMatchObject({ ram: '16GB' });
    let ritm = ritmOf(f, r.items[0].sysId);
    expect(ritm.str('flow_context')).not.toBe('');
    expect(tasksOf(f, ritm.sysId)).toHaveLength(0);
    const out = actions.get('create_catalog_task')!(f.sys, { short_description: 'Flow task' }, ritm) as {
      number: string;
    };
    expect(out.number).toMatch(/^SCTASK/);
    actions.get('set_ritm_stage')!(f.sys, { stage: 'fulfillment' }, ritm);
    ritm = ritmOf(f, ritm.sysId);
    expect([ritm.str('stage'), ritm.str('state')]).toEqual(['fulfillment', '2']);
    closeTask(f, tasksOf(f, ritm.sysId)[0]);
    expect(ritmOf(f, ritm.sysId).bool('active')).toBe(true);
    actions.get('set_ritm_stage')!(f.sys, { stage: 'complete' }, ritm);
    expect(ritmOf(f, ritm.sysId).str('state')).toBe('3');
  });
  const flowProbe = bootPlatform([approvalsModule, flowModule]);
  const hasFlows = flowProbe.services.has('flows');
  flowProbe.close();

  it.runIf(hasFlows)('runs a published flow that uses the catalog actions', () => {
    const f = setup([approvalsModule, flowModule]);
    f.sys.insert('sys_hub_flow', {
      name: 'Laptop fulfillment',
      status: 'published',
      active: true,
      resolvr_definition: JSON.stringify({
        schema: 'resolvr.flow/v1',
        type: 'flow',
        run_as: 'system',
        name: 'Laptop fulfillment',
        internal_name: 'laptop_fulfillment',
        trigger: { type: 'api' },
        steps: [
          { id: 'stage', type: 'action', action: 'set_ritm_stage', inputs: { stage: 'fulfillment' } },
          {
            id: 'task',
            type: 'action',
            action: 'create_catalog_task',
            inputs: { short_description: 'Image the laptop' },
          },
        ],
      }),
    });
    f.sys.update(f.sys.get('sc_cat_item', f.laptop.sysId)!, { flow: 'laptop_fulfillment' });
    const r = order(f, 'alice.user', f.sys.get('sc_cat_item', f.laptop.sysId)!, laptopVars());
    f.p.drain();
    const ritm = ritmOf(f, r.items[0].sysId);
    expect(ritm.str('flow_context')).not.toBe('');
    expect([ritm.str('stage'), ritm.str('state')]).toEqual(['fulfillment', '2']);
    expect(ritm.str('approval')).toBe('not requested');
    expect(tasksOf(f, ritm.sysId).map((t) => t.str('short_description'))).toEqual(['Image the laptop']);
  });
});

// ============================================================== record producers

describe('record producers', () => {
  function producerFixture() {
    const f = setup([incidentModule]);
    const producer = f.sys.insert('sc_cat_item_producer', {
      name: 'Report an issue',
      table_name: 'incident',
      category: f.hardware.sysId,
      resolvr_template: 'contact_type=self-service^impact=2',
    });
    variable(f.sys, producer, {
      name: 'short_description',
      question_text: 'What is wrong?',
      type: 6,
      mandatory: true,
    });
    variable(
      f.sys,
      producer,
      { name: 'how_bad', question_text: 'How urgent?', type: 5, map_to_field: true, field: 'urgency' },
      [
        ['1', 'High'],
        ['3', 'Low'],
      ],
    );
    variable(f.sys, producer, {
      name: 'details',
      question_text: 'Details',
      type: 2,
      map_to_field: true,
      field: 'description',
    });
    return { f, producer: f.sys.get('sc_cat_item_producer', producer.sysId)! };
  }

  it('creates the target record with mapped answers, answers and a produced-record link', () => {
    const { f, producer } = producerFixture();
    const { record } = submitProducer(as(f, 'alice.user'), producer, {
      variables: { short_description: 'VPN drops every hour', how_bad: '1', details: 'Since Monday' },
    });
    expect(record.className).toBe('incident');
    expect(record.str('number')).toMatch(/^INC/);
    expect(record.str('short_description')).toBe('VPN drops every hour');
    expect(record.str('urgency')).toBe('1');
    expect(record.str('description')).toBe('Since Monday');
    expect(record.str('contact_type')).toBe('self-service');
    expect(record.str('impact')).toBe('2');
    expect(record.str('caller_id')).toBe(f.ids.alice);
    expect(record.str('opened_by')).toBe(f.ids.alice);
    expect(f.sys.count('question_answer', `table_sys_id=${record.sysId}`)).toBe(3);
    expect(
      f.sys.count('sc_item_produced_record', `record_key=${record.sysId}^producer=${producer.sysId}`),
    ).toBe(1);
    expect(f.sys.count('sc_request')).toBe(0);
    expectHttp(
      () => submitProducer(as(f, 'alice.user'), producer, { variables: { how_bad: '1' } }),
      400,
      'Mandatory Variables are required',
    );
  });

  it('refuses producers that would create requests, items or catalog tasks', () => {
    const { f } = producerFixture();
    for (const table of ['sc_req_item', 'sc_request', 'sc_task']) {
      expect(() => f.sys.insert('sc_cat_item_producer', { name: `Bad ${table}`, table_name: table })).toThrow(
        AbortError,
      );
    }
  });
});

// ================================================================== order guides

describe('order guides', () => {
  function guideFixture() {
    const f = setup();
    const phone = f.sys.insert('sc_cat_item', {
      name: 'Phone',
      price: 300,
      category: f.hardware.sysId,
      group: f.ids.hw,
    });
    variable(f.sys, phone, { name: 'requested_for', question_text: 'Requested for', type: 31 });
    variable(f.sys, phone, { name: 'location', question_text: 'Location', type: 6 });
    variable(f.sys, f.laptop, { name: 'location', question_text: 'Location', type: 6, order: 50 });
    const guide = f.sys.insert('sc_cat_item_guide', {
      name: 'New Hire',
      category: f.hardware.sysId,
      cascade: true,
    });
    variable(f.sys, guide, { name: 'requested_for', question_text: 'New hire', type: 31, mandatory: true });
    variable(f.sys, guide, { name: 'role', question_text: 'Role', type: 5, mandatory: true }, [
      ['engineer', 'Engineer'],
      ['sales', 'Sales'],
    ]);
    variable(f.sys, guide, { name: 'location', question_text: 'Location', type: 6 });
    variable(f.sys, guide, { name: 'justification', question_text: 'Why', type: 2 });
    f.sys.insert('sc_cat_item_guide_items', { guide: guide.sysId, item: f.laptop.sysId, position: 10 });
    f.sys.insert('sc_cat_item_guide_items', {
      guide: guide.sysId,
      item: phone.sysId,
      position: 20,
      condition: 'role=sales',
    });
    return {
      f,
      guide: f.sys.get('sc_cat_item_guide', guide.sysId)!,
      phone: f.sys.get('sc_cat_item', phone.sysId)!,
    };
  }

  it('selects items from the rules', () => {
    const { f, guide } = guideFixture();
    const carol = as(f, 'carol.admin');
    expect(
      evaluateGuide(carol, guide, { requested_for: f.ids.erin, role: 'engineer' }).items.map((s) =>
        s.item.str('name'),
      ),
    ).toEqual(['Laptop']);
    expect(
      evaluateGuide(carol, guide, { requested_for: f.ids.erin, role: 'sales' }).items.map((s) =>
        s.item.str('name'),
      ),
    ).toEqual(['Laptop', 'Phone']);
  });

  it('cascades guide answers into the items and orders one request', () => {
    const { f, guide, phone } = guideFixture();
    const carol = as(f, 'carol.admin');
    const evaluation = evaluateGuide(carol, guide, {
      requested_for: f.ids.erin,
      role: 'sales',
      location: 'Austin HQ',
      justification: 'New hire',
    });
    const r = orderGuide(carol, evaluation, [
      { sys_id: f.laptop.sysId, variables: { ram: '8GB' } },
      { sys_id: phone.sysId },
    ]);
    f.p.drain();
    expect(r.items).toHaveLength(2);
    for (const ritm of r.items) {
      expect(ritm.str('order_guide')).toBe(guide.sysId);
      expect(ritm.str('requested_for')).toBe(f.ids.erin);
      const loc = f.sys
        .query('sc_item_option_mtom', `request_item=${ritm.sysId}`)
        .map((l) => l.ref('sc_item_option')!)
        .find((o) => o.ref('item_option_new')!.str('name') === 'location');
      expect(loc?.str('value')).toBe('Austin HQ');
    }
    expect(r.request.str('requested_for')).toBe(f.ids.erin);
  });

  it('three-step guides fill the default cart with lines tagged with the guide', () => {
    const { f, guide, phone } = guideFixture();
    const carol = as(f, 'carol.admin');
    const evaluation = evaluateGuide(carol, guide, {
      requested_for: f.ids.erin,
      role: 'sales',
      justification: 'Hire',
    });
    const cart = guideToCart(carol, evaluation, [
      { sys_id: f.laptop.sysId, variables: { ram: '8GB' } },
      { sys_id: phone.sysId },
    ]);
    const lines = f.sys.query('sc_cart_item', `cart=${cart.sysId}`);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.str('order_guide') === guide.sysId)).toBe(true);
  });
});

// ======================================================================= access

describe('access', () => {
  it('applies Available For / Not Available For user criteria to items, not cascading from categories', () => {
    const f = setup();
    const everyone = f.sys.insert('user_criteria', {
      name: 'Everyone',
      role: f.sys.getBy('sys_user_role', 'name', 'snc_internal')!.sysId,
    });
    const sales = f.sys.insert('user_criteria', { name: 'Sales', department: f.ids.sales });
    f.sys.insert('sc_cat_item_user_criteria_mtom', {
      sc_cat_item: f.laptop.sysId,
      user_criteria: everyone.sysId,
    });
    f.sys.insert('sc_cat_item_user_criteria_no_mtom', {
      sc_cat_item: f.laptop.sysId,
      user_criteria: sales.sysId,
    });
    expect(new CatalogAccess(as(f, 'dave.sales')).canViewItem(f.laptop)).toBe(false);
    expect(new CatalogAccess(as(f, 'alice.user')).canViewItem(f.laptop)).toBe(true);
    expectHttp(
      () => orderNow(as(f, 'dave.sales'), f.laptop, { quantity: 1, variables: laptopVars() }),
      400,
      'Security constraints',
    );
    f.sys.insert('sc_category_user_criteria_no_mtom', {
      sc_category: f.hardware.sysId,
      user_criteria: sales.sysId,
    });
    expect(new CatalogAccess(as(f, 'dave.sales')).canViewCategory(f.hardware)).toBe(false);
    expect(new CatalogAccess(as(f, 'dave.sales')).canViewItem(f.mouse)).toBe(true);
  });

  it('shows requesters their own requests and items only', () => {
    const f = setup();
    const mine = order(f, 'alice.user', f.mouse);
    const theirs = order(f, 'erin.user', f.mouse);
    const alice = as(f, 'alice.user');
    expect(alice.query('sc_request').map((r) => r.sysId)).toEqual([mine.request.sysId]);
    expect(alice.query('sc_req_item').map((r) => r.sysId)).toEqual([mine.items[0].sysId]);
    expect(alice.get('sc_req_item', theirs.items[0].sysId)).toBeNull();
    expect(alice.get('sc_request', theirs.request.sysId)).toBeNull();
    expect(alice.query('sc_task')).toHaveLength(0);
    expect(as(f, 'bob.agent').query('sc_req_item')).toHaveLength(2);
    expect(as(f, 'bob.agent').query('sc_task')).toHaveLength(2);
    // A catalog task assigned to a requester is visible to them.
    const task = tasksOf(f, mine.items[0].sysId)[0];
    f.sys.update(task, { assigned_to: f.ids.alice });
    expect(alice.query('sc_task').map((t) => t.sysId)).toEqual([task.sysId]);
    expectHttp(() => ticketDetail(alice, 'sc_req_item', theirs.items[0].sysId), 404);
  });

  it('scopes catalog managers and editors to their catalogs', () => {
    const f = setup();
    const mgr = makeUser(f.p, 'mia.manager', ['catalog_manager']);
    const ed = makeUser(f.p, 'eddy.editor', ['catalog_editor']);
    const other = f.sys.insert('sc_catalog', { title: 'HR Catalog' });
    const hrItem = f.sys.insert('sc_cat_item', { name: 'Payslip copy', sc_catalogs: other.sysId });
    f.sys.update(f.sys.get('sc_catalog', f.catalog.sysId)!, { manager: mgr, editors: ed });
    const m = as(f, 'mia.manager');
    m.update(m.get('sc_cat_item', f.laptop.sysId)!, { short_description: 'Edited by the manager' });
    expect(() => m.update(m.get('sc_cat_item', hrItem.sysId)!, { short_description: 'Nope' })).toThrow();
    const e = as(f, 'eddy.editor');
    e.update(e.get('sc_cat_item', f.mouse.sysId)!, { short_description: 'Edited by the editor' });
    expect(() => e.delete(e.get('sc_cat_item', f.mouse.sysId)!)).toThrow();
    expect(() =>
      as(f, 'alice.user').update(as(f, 'alice.user').get('sc_cat_item', f.mouse.sysId)!, { price: 1 }),
    ).toThrow();
    m.delete(m.get('sc_cat_item', f.mouse.sysId)!);
    expect(f.sys.get('sc_cat_item', f.mouse.sysId)).toBeNull();
  });
});

// ================================================================ HTTP: SC API

function config(dir: string): ServerConfig {
  return {
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
}

describe('Service Catalog API', () => {
  let f: Fixture;
  let app: FastifyInstance;
  let dir: string;
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    user = 'alice.user',
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: basic(user), 'content-type': 'application/json' },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });

  beforeAll(async () => {
    f = setup([incidentModule], { boot: false });
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-sc-'));
    app = await buildApp(f.p, config(dir));
    const producer = f.sys.insert('sc_cat_item_producer', {
      name: 'Report outage',
      table_name: 'incident',
      category: f.hardware.sysId,
    });
    variable(f.sys, producer, {
      name: 'short_description',
      question_text: 'Summary',
      type: 6,
      mandatory: true,
    });
    variable(f.sys, producer, { name: 'urgency', question_text: 'Urgency', type: 5 }, [
      ['1', 'High'],
      ['2', 'Medium'],
      ['3', 'Low'],
    ]);
    f.ids.producer = producer.sysId;
  });

  afterAll(async () => {
    await app.close();
    f.p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists catalogs, categories and the same body on versioned paths', async () => {
    const r = await call('GET', `${SC}/catalogs`);
    expect(r.statusCode).toBe(200);
    const cats = r.json().result;
    expect(cats).toEqual([
      expect.objectContaining({
        sys_id: f.catalog.sysId,
        title: 'Service Catalog',
        has_categories: true,
        has_items: true,
      }),
    ]);
    const v1 = await call('GET', '/api/sn_sc/v1/servicecatalog/catalogs');
    expect(v1.json()).toEqual(r.json());
    const one = (await call('GET', `${SC}/catalogs/${f.catalog.sysId}`)).json().result;
    expect(one.categories).toEqual([
      expect.objectContaining({ sys_id: f.hardware.sysId, title: 'Hardware' }),
    ]);
    const list = (await call('GET', `${SC}/catalogs/${f.catalog.sysId}/categories`)).json().result;
    expect(list[0]).toMatchObject({
      sys_id: f.hardware.sysId,
      title: 'Hardware',
      count: 3,
      subcategories: [],
    });
    const cat = (await call('GET', `${SC}/categories/${f.hardware.sysId}`)).json().result;
    expect(cat).toMatchObject({ title: 'Hardware', child_categories: [] });
    expect((await call('GET', `${SC}/catalogs/${'0'.repeat(32)}`)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${SC}/catalogs` })).statusCode).toBe(401);
  });

  it('searches items by category, text and type', async () => {
    const names = async (q: string) =>
      (await call('GET', `${SC}/items${q}`)).json().result.map((i: { name: string }) => i.name);
    expect(await names(`?sysparm_category=${f.hardware.sysId}`)).toEqual([
      'Laptop',
      'Report outage',
      'Wireless Mouse',
    ]);
    expect(await names('?sysparm_text=notebook')).toEqual(['Laptop']);
    expect(await names('?sysparm_type=Record%20Producer')).toEqual(['Report outage']);
    expect(await names('?sysparm_limit=1&sysparm_offset=1')).toEqual(['Report outage']);
    const laptop = (await call('GET', `${SC}/items?sysparm_text=laptop`)).json().result[0];
    expect(laptop).toMatchObject({
      sys_id: f.laptop.sysId,
      type: 'catalog_item',
      show_price: true,
      price: '$1,000.00',
      price_currency: 'USD',
      category: { sys_id: f.hardware.sysId, title: 'Hardware' },
    });
    expect(laptop.catalogs).toEqual([{ sys_id: f.catalog.sysId, title: 'Service Catalog' }]);
  });

  it('returns item details with typed variables', async () => {
    const r = await call('GET', `${SC}/items/${f.laptop.sysId}`);
    expect(r.statusCode).toBe(200);
    const item = r.json().result;
    const ram = item.variables.find((v: { name: string }) => v.name === 'ram');
    expect(ram).toMatchObject({ type: 5, friendly_type: 'select_box', mandatory: true, label: 'RAM' });
    expect(ram.choices).toEqual([
      { value: '8GB', label: '8 GB', price: 0, recurring_price: 0 },
      { value: '16GB', label: '16 GB', price: 200, recurring_price: 0 },
    ]);
    expect(item.variables.find((v: { name: string }) => v.name === 'requested_for')).toMatchObject({
      type: 31,
      friendly_type: 'requested_for',
      reference: 'sys_user',
    });
    expect(item).toHaveProperty('ui_policy');
    expect(item.client_script).toEqual({ onChange: [], onLoad: [], onSubmit: [] });
    expect((await call('GET', `${SC}/items/${'0'.repeat(32)}`)).statusCode).toBe(400);
  });

  it('adds to the cart, updates and removes lines, and checks out', async () => {
    const missing = await call('POST', `${SC}/items/${f.laptop.sysId}/add_to_cart`, 'erin.user', {
      sysparm_quantity: 1,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      status: 'failure',
      error: { message: 'Mandatory Variables are required' },
    });
    const badQty = await call('POST', `${SC}/items/${f.mouse.sysId}/add_to_cart`, 'erin.user', {
      sysparm_quantity: '-1',
    });
    expect(badQty.json().error.message).toBe('Invalid quantity value');
    const added = await call('POST', `${SC}/items/${f.laptop.sysId}/add_to_cart`, 'erin.user', {
      sysparm_quantity: 1,
      variables: { ram: '16GB', justification: 'Needed' },
    });
    expect(added.statusCode).toBe(200);
    const res = added.json().result;
    expect(res.subtotal).toBe('$1,200.00');
    expect(res.items).toEqual([
      expect.objectContaining({
        item_name: 'Laptop',
        quantity: '1',
        price: '$1,200.00',
        catalog_item_id: f.laptop.sysId,
      }),
    ]);
    const lineId = res.items[0].cart_item_id;
    const put = await call('PUT', `${SC}/cart/${lineId}`, 'erin.user', { sysparm_quantity: '2' });
    expect(put.statusCode).toBe(201);
    const cart = (await call('GET', `${SC}/cart`, 'erin.user')).json().result;
    expect(cart).not.toHaveProperty('items');
    expect(cart.none.items[0]).toMatchObject({
      subtotal: 2400,
      subtotal_price: '$2,400.00',
      quantity: '2',
      variables: expect.objectContaining({ RAM: '16 GB' }),
    });
    expect(cart.subtotal_price).toBe('$2,400.00');
    await call('POST', `${SC}/items/${f.mouse.sysId}/add_to_cart`, 'erin.user', { sysparm_quantity: 1 });
    const cart2 = (await call('GET', `${SC}/cart`, 'erin.user')).json().result;
    const mouseLine = cart2.none.items.find((i: { item_name: string }) => i.item_name === 'Wireless Mouse');
    expect((await call('DELETE', `${SC}/cart/${mouseLine.cart_item_id}`, 'erin.user')).statusCode).toBe(204);
    const done = await call('POST', `${SC}/cart/checkout`, 'erin.user');
    expect(done.statusCode).toBe(200);
    expect(done.json().result).toEqual({
      request_number: expect.stringMatching(/^REQ/),
      request_id: expect.any(String),
    });
    expect(f.sys.count('sc_req_item', `request=${done.json().result.request_id}`)).toBe(1);
    expect((await call('POST', `${SC}/cart/submit_order`, 'erin.user')).statusCode).toBe(400);
  });

  it('supports two-step checkout', async () => {
    f.p.properties.set('glide.sc.checkout.twostep', 'true');
    try {
      await call('POST', `${SC}/items/${f.mouse.sysId}/add_to_cart`, 'bob.agent', { sysparm_quantity: 2 });
      const review = (await call('POST', `${SC}/cart/checkout`, 'bob.agent')).json().result;
      expect(review).toMatchObject({
        requested_for: f.ids.bob,
        requested_for_user: expect.any(String),
        special_instructions: '',
        delivery_address: '',
      });
      expect(f.sys.count('sc_request', `opened_by=${f.ids.bob}`)).toBe(0);
      const placed = (
        await call('POST', `${SC}/cart/submit_order`, 'bob.agent', {
          special_instructions: 'Leave at reception',
        })
      ).json().result;
      expect(placed.request_number).toMatch(/^REQ/);
      expect(f.sys.get('sc_request', placed.request_id)!.str('special_instructions')).toBe(
        'Leave at reception',
      );
    } finally {
      f.p.properties.set('glide.sc.checkout.twostep', 'false');
    }
  });

  it('orders now', async () => {
    const r = await call('POST', `${SC}/items/${f.mouse.sysId}/order_now`, 'alice.user', {
      sysparm_quantity: '3',
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res).toMatchObject({ table: 'sc_request', number: expect.stringMatching(/^REQ/) });
    expect(res.sys_id).toBe(res.request_id);
    expect(res.number).toBe(res.request_number);
    expect(f.sys.first('sc_req_item', `request=${res.sys_id}`)!.num('quantity')).toBe(3);
  });

  it('submits record producers', async () => {
    const r = await call('POST', `${SC}/items/${f.ids.producer}/submit_producer`, 'alice.user', {
      variables: { short_description: 'Printer on fire', urgency: '1' },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res).toMatchObject({
      table: 'incident',
      number: expect.stringMatching(/^INC/),
      record: `api/now/table/incident/${res.sys_id}`,
      redirect_url: `incident.do?sys_id=${res.sys_id}&sysparm_view=ess`,
    });
    expect(f.sys.get('incident', res.sys_id)!.str('urgency')).toBe('1');
    expect(
      (await call('POST', `${SC}/items/${'0'.repeat(32)}/submit_producer`, 'alice.user', { variables: {} }))
        .statusCode,
    ).toBe(404);
  });

  it('answers delegation questions and keeps a wish list', async () => {
    expect((await call('GET', `${SC}/items/${f.laptop.sysId}/delegation/${f.ids.erin}`)).json()).toEqual({
      result: { result: true },
    });
    const invalid = await call(
      'POST',
      `${SC}/items/${f.mouse.sysId}/get_invalid_delegated_users`,
      'alice.user',
      { sysparm_also_request_for: f.ids.erin },
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().result.errCode).toBe('42202');
    const ok = await call('POST', `${SC}/items/${f.laptop.sysId}/get_invalid_delegated_users`, 'alice.user', {
      sysparm_also_request_for: `${f.ids.erin},${'0'.repeat(32)}`,
    });
    expect(ok.json().result.invalidUsers).toHaveLength(1);
    const wish = await call('POST', `${SC}/items/${f.laptop.sysId}/add_to_wishlist`, 'alice.user', {});
    expect(wish.statusCode).toBe(200);
    const list = (await call('GET', `${SC}/wishlist`, 'alice.user')).json().result;
    expect(list.items).toHaveLength(1);
    expect((await call('GET', `${SC}/wishlist/${list.items[0].cart_item_id}`, 'alice.user')).statusCode).toBe(
      200,
    );
    expect((await call('GET', `${SC}/wishlist/${'0'.repeat(32)}`, 'alice.user')).statusCode).toBe(404);
    expect((await call('GET', `${SC}/cart/delivery_address/${f.ids.alice}`)).json()).toEqual({ result: '' });
  });

  it('serves the portal form and order APIs', async () => {
    const form = await call('GET', `/api/app/catalog/items/${f.laptop.sysId}/form`, 'alice.user');
    expect(form.statusCode).toBe(200);
    const body = form.json().result;
    expect(body.item).toMatchObject({
      name: 'Laptop',
      submit_label: 'Order Now',
      show_price: true,
      delivery_time: '2 Days',
    });
    const ram = body.variables.find((v: { name: string }) => v.name === 'ram');
    expect(ram).toMatchObject({ ui_type: 'select', mandatory: true, visible: true });
    expect(ram.choices).toHaveLength(2);
    expect(body.variables.find((v: { name: string }) => v.name === 'requested_for')).toMatchObject({
      ui_type: 'reference',
      default_value: f.ids.alice,
    });
    expect(body.requested_for).toMatchObject({
      variable: 'requested_for',
      value: { sys_id: f.ids.alice },
      can_change: true,
      also_request_for: true,
    });

    const invalid = await call('POST', `/api/app/catalog/items/${f.laptop.sysId}/order`, 'alice.user', {
      variables: { ram: '16GB' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.fields).toEqual([
      expect.objectContaining({ variable: 'justification', code: 'mandatory' }),
    ]);

    const placed = await call('POST', `/api/app/catalog/items/${f.laptop.sysId}/order`, 'alice.user', {
      variables: { ram: '16GB', justification: 'Portal order' },
      quantity: 1,
    });
    expect(placed.statusCode).toBe(200);
    const res = placed.json().result;
    expect(res.request).toMatchObject({ table: 'sc_request', number: expect.stringMatching(/^REQ/) });
    expect(res.request_items).toEqual([
      expect.objectContaining({
        table: 'sc_req_item',
        number: expect.stringMatching(/^RITM/),
        quantity: 1,
        price: 1200,
      }),
    ]);
    f.p.drain();

    const prod = await call('POST', `/api/app/catalog/items/${f.ids.producer}/order`, 'alice.user', {
      variables: { short_description: 'Screen flickers' },
    });
    expect(prod.json().result.record).toMatchObject({
      table: 'incident',
      number: expect.stringMatching(/^INC/),
    });

    const mine = (await call('GET', '/api/app/catalog/my-requests?filter=all', 'alice.user')).json();
    expect(mine.result.length).toBeGreaterThan(0);
    const entry = mine.result.find((e: { number: string }) => e.number === res.request.number);
    expect(entry).toMatchObject({
      table: 'sc_request',
      badge: 'In Progress',
      link: { table: 'sc_req_item', sys_id: res.request_items[0].sys_id },
    });
    expect(entry.items[0].timeline.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual(
      ['submitted:done', 'approval:skipped', 'fulfillment:current', 'closed:pending'],
    );
    const others = (await call('GET', '/api/app/catalog/my-requests?filter=all', 'dave.sales')).json();
    expect(others.result.find((e: { number: string }) => e.number === res.request.number)).toBeUndefined();

    const ticket = await call(
      'GET',
      `/api/app/catalog/tickets/sc_req_item/${res.request_items[0].sys_id}`,
      'alice.user',
    );
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().result.variables.find((v: { name: string }) => v.name === 'ram')).toMatchObject({
      value: '16GB',
      display_value: '16 GB',
    });
    expect(
      (await call('GET', `/api/app/catalog/tickets/sc_req_item/${res.request_items[0].sys_id}`, 'dave.sales'))
        .statusCode,
    ).toBe(404);
    const comment = await call(
      'POST',
      `/api/app/catalog/tickets/sc_req_item/${res.request_items[0].sys_id}/comment`,
      'alice.user',
      { comment: 'Any update?' },
    );
    expect(comment.statusCode).toBe(200);
    expect(
      f.p.history.journal('sc_req_item', res.request_items[0].sys_id, ['comments']).map((j) => j.value),
    ).toEqual(['Any update?']);
    const cancel = await call(
      'POST',
      `/api/app/catalog/tickets/sc_req_item/${res.request_items[0].sys_id}/cancel`,
      'alice.user',
      {},
    );
    expect(cancel.statusCode).toBe(400);
  });

  it('lists catalogs and items for the portal', async () => {
    const tree = (await call('GET', '/api/app/catalog/catalogs')).json().result;
    expect(tree[0].categories[0]).toMatchObject({ title: 'Hardware', count: 3, children: [] });
    const items = (await call('GET', `/api/app/catalog/items?category=${f.hardware.sysId}&q=mouse`)).json();
    expect(items.total).toBe(1);
    expect(items.result[0].name).toBe('Wireless Mouse');
  });
});

// ========================================================================= demo

describe('demo data', () => {
  it('loads the Northwind Labs catalog and requests', () => {
    const p = bootPlatform([catalogModule], { demo: true });
    current = p;
    const sys = p.systemContext();
    expect(sys.count('sc_category')).toBe(5);
    expect(sys.count('sc_cat_item')).toBeGreaterThanOrEqual(13);
    expect(sys.count('sc_request')).toBeGreaterThanOrEqual(20);
    expect(new Set(sys.query('sc_req_item').map((r) => r.str('stage'))).size).toBeGreaterThanOrEqual(3);
    expect(p.errors).toEqual([]);
  });

  it('loads with approvals and incidents installed', () => {
    const p = bootPlatform([approvalsModule, incidentModule, catalogModule], { demo: true });
    current = p;
    const sys = p.systemContext();
    expect(sys.count('sc_cat_item')).toBe(14);
    const stages = new Set(sys.query('sc_req_item').map((r) => r.str('stage')));
    expect(stages).toEqual(
      new Set(['waiting_for_approval', 'fulfillment', 'delivery', 'complete', 'Request Cancelled']),
    );
    expect(sys.count('sc_item_produced_record')).toBe(2);
    expect(myRequests(p.contextAs('olivia.martin'), { filter: 'all' }).total).toBe(3);
    expect(p.errors).toEqual([]);
  });
});
