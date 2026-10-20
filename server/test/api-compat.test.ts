import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { parseLenientJson } from '../src/api/now/lenient-json.js';
import { toXmlResponse, xmlToObject } from '../src/api/now/xml.js';
import { buildApp } from '../src/app.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import { clock } from '../src/engine/util.js';
import { importSetModule } from '../src/modules/importset/index.js';
import { bootPlatform, makeUser } from './helpers.js';

const fixtures: AppModule = {
  id: 'compat_fixtures',
  name: 'REST compatibility fixtures',
  dependsOn: ['task', 'importset'],
  tables: [
    {
      name: 'problem',
      label: 'Problem',
      extends: 'task',
      number: { prefix: 'PRB', start: 40000 },
      columns: [],
    },
    {
      name: 'incident',
      label: 'Incident',
      extends: 'task',
      number: { prefix: 'INC', start: 10000 },
      columns: [
        { name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user' },
        { name: 'business_duration', label: 'Business duration', type: 'glide_duration' },
        { name: 'resolved_at', label: 'Resolved', type: 'glide_date_time' },
      ],
    },
    {
      name: 'u_imp_user',
      label: 'User Import',
      extends: 'sys_import_set_row',
      columns: [
        { name: 'u_name', label: 'Name', type: 'string' },
        { name: 'u_email', label: 'Email address', type: 'string' },
        { name: 'u_user_name', label: 'User ID', type: 'string' },
        { name: 'u_department', label: 'Department', type: 'string' },
      ],
    },
    {
      name: 'customer_account',
      label: 'Account',
      displayField: 'name',
      number: { prefix: 'ACCT', start: 0 },
      columns: [
        { name: 'number', label: 'Number', type: 'string', readOnly: true },
        { name: 'name', label: 'Name', type: 'string' },
        { name: 'primary_contact', label: 'Primary contact', type: 'reference', reference: 'sys_user' },
      ],
    },
    {
      name: 'sys_attachment_attribute',
      label: 'Attachment Attribute',
      columns: [
        {
          name: 'attachment',
          label: 'Attachment',
          type: 'reference',
          reference: 'sys_attachment',
          cascade: 'delete',
        },
        { name: 'key', label: 'Key', type: 'string' },
        { name: 'value', label: 'Value', type: 'string', maxLength: 4000 },
      ],
    },
  ],
  choices: {
    'incident.state': [
      { value: '1', label: 'New', sequence: 1 },
      { value: '2', label: 'In Progress', sequence: 2 },
      { value: '6', label: 'Resolved', sequence: 3 },
      { value: '7', label: 'Closed', sequence: 4 },
    ],
  },
  roles: [{ name: 'csm_ws_integration' }, { name: 'sn_change_read' }],
  acls: [
    { name: 'customer_account', operation: 'read', roles: ['csm_ws_integration'] },
    { name: 'incident', operation: 'read', condition: 'caller_id=javascript:gs.getUserID()' },
    { name: 'incident', operation: 'read', roles: ['itil'] },
  ],
  ui: {
    forms: [
      {
        table: 'incident',
        sections: [
          { left: ['number', 'caller_id'], right: ['state', 'priority'] },
          { fields: ['short_description'] },
        ],
      },
    ],
    lists: [{ table: 'incident', view: 'mobile', columns: ['number', 'short_description'] }],
  },
};

let p: Platform;
let app: FastifyInstance;
let dir: string;
const basic = (u: string, pw: string) => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
const ADMIN = basic('admin', 'admin-test-pw');
const ABEL = basic('abel.tuter', 'Password1!');
const BETH = basic('beth.ross', 'Password1!');
const PLAIN = basic('plain.user', 'Password1!');
const ids: Record<string, string> = {};

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { authorization: ADMIN, ...headers } });
const send = (
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { authorization: ADMIN, 'content-type': 'application/json', ...headers },
    payload:
      payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;

beforeAll(async () => {
  p = bootPlatform([importSetModule, fixtures]);
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-compat-'));
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbFile: ':memory:',
    attachmentDir: join(dir, 'att'),
    publicUrl: 'https://resolvr.example.com',
    webDir: null,
    demo: false,
    secureCookies: false,
  };
  app = await buildApp(p, config);
  const sys = p.systemContext();
  ids.abel = makeUser(p, 'abel.tuter', ['itil'], ['Network']);
  sys.updateById('sys_user', ids.abel, {
    first_name: 'Abel',
    last_name: 'Tuter',
    time_zone: 'America/New_York',
  });
  ids.beth = makeUser(p, 'beth.ross', ['itil']);
  sys.updateById('sys_user', ids.beth, { manager: ids.abel });
  makeUser(p, 'plain.user', []);
  makeUser(p, 'user.admin', ['user_admin']);
  makeUser(p, 'csm.agent', ['csm_ws_integration']);
  // Role containment and a group role for the User Role Inheritance API.
  const itil = sys.getBy('sys_user_role', 'name', 'itil')!;
  const read = sys.getBy('sys_user_role', 'name', 'sn_change_read')!;
  sys.insert('sys_user_role_contains', { role: itil.sysId, contains: read.sysId });
  sys.insert('sys_group_has_role', {
    group: sys.getBy('sys_user_group', 'name', 'Network')!.sysId,
    role: itil.sysId,
  });
  p.users.invalidate();

  clock.freeze('2026-10-21 03:30:00'); // Oct 20, 23:30 in New York
  ids.inc1 = sys.insert('incident', {
    short_description: 'Router down',
    caller_id: ids.abel,
    priority: 1,
    urgency: 3,
    state: '1',
    description: 'Core router in building 2',
    business_duration: 3_723_000,
  }).sysId;
  clock.freeze('2026-10-21 14:30:00');
  ids.inc2 = sys.insert('incident', {
    short_description: 'Mail queue stuck',
    caller_id: ids.beth,
    priority: 3,
    state: '2',
    reassignment_count: 2,
  }).sysId;
  clock.freeze('2026-10-21 14:45:00');
  ids.inc3 = sys.insert('incident', {
    short_description: 'Printer offline',
    priority: 3,
    state: '1',
    reassignment_count: 1,
  }).sysId;
  ids.prb = sys.insert('problem', { short_description: 'Root cause' }).sysId;
  clock.freeze('2026-10-21 15:00:00');
});

afterAll(async () => {
  await app.close();
  p.close();
  clock.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe('Table API: lists, paging and headers', () => {
  it('AT-01/02/03/04 pages with X-Total-Count and Link', async () => {
    const r = await get('/api/now/table/incident?sysparm_limit=1');
    expect(r.statusCode).toBe(200);
    expect(json(r).result).toHaveLength(1);
    expect(r.headers['x-total-count']).toBe('3');
    const link = String(r.headers.link);
    expect(link).toContain('rel="first"');
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
    expect(link).not.toContain('rel="prev"');
    expect(link).toContain(
      '<https://resolvr.example.com/api/now/table/incident?sysparm_limit=1&sysparm_offset=2>;rel="last"',
    );

    const second = await get('/api/now/table/incident?sysparm_limit=1&sysparm_offset=1');
    expect(String(second.headers.link)).toContain('sysparm_offset=0>;rel="prev"');

    const suppressed = await get(
      '/api/now/table/incident?sysparm_limit=1&sysparm_suppress_pagination_header=true',
    );
    expect(suppressed.headers.link).toBeUndefined();

    const noCount = await get('/api/now/table/incident?sysparm_limit=1&sysparm_no_count=true');
    expect(noCount.headers['x-total-count']).toBeUndefined();
    expect(json(noCount)).toEqual(json(r));
    expect(String(noCount.headers.link)).toContain('rel="next"');
    expect(String(noCount.headers.link)).not.toContain('rel="last"');
  });

  it('builds Link URLs exactly as documented', async () => {
    const r = await get(
      '/api/now/table/incident?sysparm_query=active=true^ORDERBYnumber&sysparm_fields=number,state,caller_id,opened_at&sysparm_limit=2',
    );
    expect(r.headers.link).toBe(
      [
        '<https://resolvr.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Cstate%2Ccaller_id%2Copened_at&sysparm_limit=2&sysparm_offset=0>;rel="first"',
        '<https://resolvr.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Cstate%2Ccaller_id%2Copened_at&sysparm_limit=2&sysparm_offset=2>;rel="next"',
        '<https://resolvr.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Cstate%2Ccaller_id%2Copened_at&sysparm_limit=2&sysparm_offset=2>;rel="last"',
      ].join(','),
    );
    expect(r.headers['content-type']).toBe('application/json;charset=UTF-8');
  });

  it('AT-05/06 returns an empty list, or 404 on v1', async () => {
    const r = await get('/api/now/table/incident?sysparm_query=number=NOPE');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('{"result":[]}');
    const v2 = await get('/api/now/v2/table/incident?sysparm_query=number=NOPE');
    expect(v2.statusCode).toBe(200);
    const v1 = await get('/api/now/v1/table/incident?sysparm_query=number=NOPE');
    expect(v1.statusCode).toBe(404);
    expect(json(v1)).toMatchObject({ status: 'failure', error: { message: 'No Record found' } });
  });

  it('AT-07/28 uses the platform error envelope for missing records and tables', async () => {
    const r = await get('/api/now/table/incident/ffffffffffffffffffffffffffffffff');
    expect(r.statusCode).toBe(404);
    expect(json(r)).toEqual({
      error: {
        message: 'No Record found',
        detail: "Record doesn't exist or ACL restricts the record retrieval",
      },
      status: 'failure',
    });
    const t = await get('/api/now/table/no_such_table');
    expect(t.statusCode).toBe(400);
    expect(json(t)).toEqual({
      error: { message: 'Invalid table no_such_table', detail: null },
      status: 'failure',
    });
  });

  it('AT-27 rejects missing credentials', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/now/table/incident' });
    expect(r.statusCode).toBe(401);
    expect(json(r).error).toEqual({
      message: 'User Not Authenticated',
      detail: 'Required to provide Auth information',
    });
  });

  it('AT-34 lists subclass rows from task with task fields only', async () => {
    const r = await get('/api/now/table/task?sysparm_query=sys_class_name=incident');
    const rows = json(r).result as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.sys_class_name === 'incident')).toBe(true);
    expect(rows.every((x) => !('caller_id' in x))).toBe(true);
    const all = await get('/api/now/table/task');
    expect(json(all).result).toHaveLength(4);
    const wrongClass = await get(`/api/now/table/incident/${ids.prb}`);
    expect(wrongClass.statusCode).toBe(404);
  });

  it('AT-35/36/37/38 handles invalid terms, ordering, field=value pairs and macros', async () => {
    const a = await get(
      '/api/now/table/incident?sysparm_query=bogus_field=1^active=true&sysparm_fields=sys_id',
    );
    const b = await get('/api/now/table/incident?sysparm_query=active=true&sysparm_fields=sys_id');
    expect(json(a).result).toEqual(json(b).result);
    const desc = await get('/api/now/table/incident?sysparm_query=ORDERBYDESCnumber&sysparm_fields=number');
    const numbers = (json(desc).result as { number: string }[]).map((x) => x.number);
    expect(numbers).toEqual([...numbers].sort().reverse());
    expect(new Set(numbers).size).toBe(numbers.length);
    const pairs = await get('/api/now/table/incident?active=true&priority=3&sysparm_fields=number');
    const encoded = await get(
      '/api/now/table/incident?sysparm_query=active=true^priority=3&sysparm_fields=number',
    );
    expect(json(pairs).result).toEqual(json(encoded).result);
    expect(json(pairs).result).toHaveLength(2);
    // Display values are accepted in field=value pairs.
    const byLabel = await get(
      '/api/now/table/incident?state=New&caller_id=abel.tuter&sysparm_fields=short_description',
    );
    expect(json(byLabel).result).toEqual([{ short_description: 'Router down' }]);
    // sysparm_query wins over pairs.
    const both = await get(
      '/api/now/table/incident?priority=1&sysparm_query=priority=3&sysparm_fields=short_description',
    );
    expect(json(both).result).toHaveLength(2);
    const mine = await get(
      '/api/now/table/incident?sysparm_query=caller_id=javascript:gs.getUserID()&sysparm_fields=short_description',
      {
        authorization: ABEL,
      },
    );
    expect(json(mine).result).toEqual([{ short_description: 'Router down' }]);
  });

  it('AT-64 evaluates date macros in the user time zone', async () => {
    const q =
      'sysparm_query=sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()&sysparm_fields=short_description';
    const abel = await get(`/api/now/table/incident?${q}`, { authorization: ABEL });
    expect(
      (json(abel).result as { short_description: string }[]).map((x) => x.short_description).sort(),
    ).toEqual(['Mail queue stuck', 'Printer offline']);
    const utc = await get(`/api/now/table/incident?${q}`);
    expect(json(utc).result).toHaveLength(3);
  });

  it('honours glide.invalid_query.returns_no_rows and reports ignored terms in debug logs', async () => {
    const r = await get('/api/now/table/incident?sysparm_query=bogus=1^active=true', {
      'x-wantsessiondebugmessages': 'true',
    });
    expect(json(r).result).toHaveLength(3);
    expect(json(r).session.debug_logs.map((l: { line: string }) => l.line)).toEqual([
      'Invalid query term ignored: bogus=1',
    ]);
    p.properties.set('glide.invalid_query.returns_no_rows', 'true');
    try {
      const strict = await get('/api/now/table/incident?sysparm_query=bogus=1^active=true');
      expect(json(strict).result).toEqual([]);
      expect(strict.headers['x-total-count']).toBe('0');
      const ok = await get('/api/now/table/incident?sysparm_query=active=true');
      expect(json(ok).result).toHaveLength(3);
    } finally {
      p.properties.set('glide.invalid_query.returns_no_rows', 'false');
    }
  });

  it('resolves DYNAMIC options defined as sys_filter_option_dynamic rows', async () => {
    const id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    p.systemContext().insert('sys_filter_option_dynamic', {
      sys_id: id,
      label: 'Manager of me',
      script: 'gs.getUser().getManagerID()',
      active: true,
    });
    const r = await get(`/api/now/table/incident?sysparm_query=caller_idDYNAMIC${id}&sysparm_fields=short_description`, {
      authorization: BETH,
    });
    expect(json(r).result).toEqual([{ short_description: 'Router down' }]);
  });

  it('does not let filters probe fields the caller cannot read', async () => {
    const r = await get(
      '/api/now/table/sys_user?sysparm_query=user_passwordSTARTSWITHscrypt^user_name=abel.tuter&sysparm_fields=user_name',
    );
    expect(json(r).result).toEqual([{ user_name: 'abel.tuter' }]);
    const none = await get(
      '/api/now/table/sys_user?sysparm_query=user_name=abel.tuter^user_passwordSTARTSWITHzzz&sysparm_fields=user_name',
    );
    expect(json(none).result).toEqual([{ user_name: 'abel.tuter' }]);
  });
});

describe('Table API: record format', () => {
  it('AT-08/09/10/11 renders references in every display mode', async () => {
    const base = `/api/now/table/incident/${ids.inc1}?sysparm_fields=caller_id,state,number`;
    const plain = json(await get(base)).result;
    expect(plain.caller_id).toEqual({
      link: `https://resolvr.example.com/api/now/table/sys_user/${ids.abel}`,
      value: ids.abel,
    });
    const noLink = json(await get(`${base}&sysparm_exclude_reference_link=true`)).result;
    expect(noLink.caller_id).toMatch(/^[0-9a-f]{32}$/);
    const disp = json(await get(`${base}&sysparm_display_value=true`)).result;
    expect(disp.state).toBe('New');
    expect(disp.caller_id).toEqual({
      display_value: 'Abel Tuter',
      link: `https://resolvr.example.com/api/now/table/sys_user/${ids.abel}`,
    });
    const all = json(await get(`${base}&sysparm_display_value=all`)).result;
    expect(all.state).toEqual({ display_value: 'New', value: '1' });
    expect(all.number).toMatchObject({ value: expect.stringMatching(/^INC/) });
    expect(all.caller_id).toEqual({
      display_value: 'Abel Tuter',
      link: expect.stringContaining('/sys_user/'),
      value: ids.abel,
    });
    const everything = json(await get(`/api/now/table/incident/${ids.inc1}?sysparm_display_value=all`))
      .result as Record<string, unknown>;
    for (const v of Object.values(everything))
      expect(v).toMatchObject({ display_value: expect.any(String), value: expect.any(String) });
  });

  it('AT-12/13 supports dot-walked fields and ignores unknown ones', async () => {
    const r = json(
      await get(
        '/api/now/table/incident?sysparm_fields=number,caller_id.name&sysparm_limit=1&sysparm_query=ORDERBYnumber',
      ),
    ).result;
    expect(Object.keys(r[0]).sort()).toEqual(['caller_id.name', 'number']);
    expect(r[0]['caller_id.name']).toBe('Abel Tuter');
    const unknown = json(
      await get('/api/now/table/incident?sysparm_fields=number,not_a_field&sysparm_limit=1'),
    ).result;
    expect(Object.keys(unknown[0])).toEqual(['number']);
    const ref = json(
      await get(`/api/now/table/incident/${ids.inc2}?sysparm_fields=caller_id.manager`),
    ).result;
    expect(ref['caller_id.manager']).toEqual({
      link: `https://resolvr.example.com/api/now/table/sys_user/${ids.abel}`,
      value: ids.abel,
    });
    const empty = json(await get(`/api/now/table/incident/${ids.inc3}?sysparm_fields=caller_id.name`)).result;
    expect(empty).toEqual({ 'caller_id.name': '' });
  });

  it('AT-14/15/16/17 serializes scalars as strings in the documented formats', async () => {
    const r = json(await get(`/api/now/table/incident/${ids.inc1}`)).result as Record<string, unknown>;
    const walk = (v: unknown): void => {
      if (v && typeof v === 'object') Object.values(v).forEach(walk);
      else expect(typeof v).toBe('string');
    };
    walk(r);
    expect(r.active).toBe('true');
    expect(r.priority).toMatch(/^\d+$/);
    expect(r.parent).toBe('');
    expect(r.opened_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r.opened_at).toBe('2026-10-21 03:30:00');
    expect(r.business_duration).toBe('1970-01-01 01:02:03');
    expect(r.sys_domain).toEqual({
      link: 'https://resolvr.example.com/api/now/table/sys_user_group/global',
      value: 'global',
    });
    expect(r.comments).toBe('');
  });

  it('renders the fields of a UI view with sysparm_view', async () => {
    const desktop = json(await get(`/api/now/table/incident/${ids.inc1}?sysparm_view=desktop`)).result;
    expect(Object.keys(desktop)).toEqual([
      'sys_id',
      'number',
      'caller_id',
      'state',
      'priority',
      'short_description',
    ]);
    const mobile = json(await get(`/api/now/table/incident/${ids.inc1}?sysparm_view=mobile`)).result;
    expect(Object.keys(mobile)).toEqual(['sys_id', 'number', 'short_description']);
    const fieldsWin = json(
      await get(`/api/now/table/incident/${ids.inc1}?sysparm_view=desktop&sysparm_fields=number`),
    ).result;
    expect(Object.keys(fieldsWin)).toEqual(['number']);
  });

  it('AT-29/30 negotiates XML and rejects unsupported Accept values', async () => {
    const xml = await get(
      '/api/now/table/incident?sysparm_fields=number,caller_id&sysparm_query=ORDERBYnumber&sysparm_limit=2',
      {
        accept: 'application/xml',
      },
    );
    expect(xml.statusCode).toBe(200);
    expect(xml.headers['content-type']).toBe('application/xml;charset=UTF-8');
    expect(xml.body).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?><response><result><number>INC\d+<\/number><caller_id><link>/,
    );
    expect(xml.body.match(/<result>/g)).toHaveLength(2);
    expect(xml.body.endsWith('</result></response>')).toBe(true);
    const csv = await get('/api/now/table/incident', { accept: 'text/csv' });
    expect(csv.statusCode).toBe(406);
    const browser = await get('/api/now/table/incident?sysparm_limit=1', {
      accept: 'text/html,application/xml;q=0.9,*/*;q=0.8',
    });
    expect(browser.headers['content-type']).toBe('application/xml;charset=UTF-8');
    const wildcard = await get('/api/now/table/incident?sysparm_limit=1', { accept: '*/*' });
    expect(wildcard.headers['content-type']).toBe('application/json;charset=UTF-8');
    const err = await get('/api/now/table/incident/ffffffffffffffffffffffffffffffff', {
      accept: 'application/xml',
    });
    expect(err.body).toContain('<response><error><message>No Record found</message>');
  });

  it('AT-32/65 answers HEAD and adds session debug logs on request', async () => {
    const getR = await get('/api/now/table/incident?sysparm_limit=1');
    const head = await app.inject({
      method: 'HEAD',
      url: '/api/now/table/incident?sysparm_limit=1',
      headers: { authorization: ADMIN },
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-total-count']).toBe(getR.headers['x-total-count']);
    expect(head.body).toBe('');
    const dbg = json(
      await get('/api/now/table/incident?sysparm_limit=1', { 'x-wantsessiondebugmessages': 'true' }),
    );
    expect(Object.keys(dbg)).toEqual(['result', 'session']);
    expect(Array.isArray(dbg.session.debug_logs)).toBe(true);
  });
});

describe('Table API: writes', () => {
  it('AT-18/21 creates records, ignoring unknown fields', async () => {
    const r = await send('POST', '/api/now/table/incident', { short_description: 'x', no_such_field: 'y' });
    expect(r.statusCode).toBe(201);
    const res = json(r).result;
    expect(res.sys_id).toMatch(/^[0-9a-f]{32}$/);
    expect(res.number).toMatch(/^INC/);
    expect(res.no_such_field).toBeUndefined();
    expect(r.headers.location).toBe(`https://resolvr.example.com/api/now/table/incident/${res.sys_id}`);
  });

  it('AT-19 accepts single-quoted JSON and bodies without Content-Type', async () => {
    const r = await send(
      'POST',
      '/api/now/table/incident?sysparm_fields=short_description',
      "{'short_description':'single quoted'}",
    );
    expect(r.statusCode).toBe(201);
    expect(json(r).result).toEqual({ short_description: 'single quoted' });
    const noType = await app.inject({
      method: 'POST',
      url: '/api/now/table/incident?sysparm_fields=short_description',
      headers: { authorization: ADMIN },
      payload: "{short_description: 'unquoted key',}",
    });
    expect(noType.statusCode).toBe(201);
    expect(json(noType).result.short_description).toBe('unquoted key');
    const bad = await send('POST', '/api/now/table/incident', '{"short_description":');
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.message).toBe('Exception while reading request');
  });

  it('accepts XML bodies and uses only the first element of an array body', async () => {
    const x = await send(
      'POST',
      '/api/now/table/incident?sysparm_fields=short_description,urgency',
      '<request><entry><short_description>From XML &amp; more</short_description><urgency>2</urgency></entry></request>',
      {
        'content-type': 'application/xml',
      },
    );
    expect(x.statusCode).toBe(201);
    expect(json(x).result).toEqual({ short_description: 'From XML & more', urgency: '2' });
    const arr = await send('POST', '/api/now/table/incident?sysparm_fields=short_description', [
      { short_description: 'first' },
      { short_description: 'second' },
    ]);
    expect(json(arr).result.short_description).toBe('first');
  });

  it('AT-20 suppresses the body with X-no-response-body', async () => {
    const r = await send(
      'POST',
      '/api/now/table/incident',
      { short_description: 'quiet' },
      { 'x-no-response-body': 'true' },
    );
    expect(r.statusCode).toBe(201);
    expect(r.body).toBe('');
    expect(r.headers.location).toMatch(/\/api\/now\/table\/incident\/[0-9a-f]{32}$/);
  });

  it('AT-22/23/24 updates partially with PATCH and PUT and clears with empty strings', async () => {
    const id = json(
      await send('POST', '/api/now/table/incident', {
        short_description: 'to update',
        urgency: '3',
        description: 'keep me',
      }),
    ).result.sys_id;
    const patched = await send('PATCH', `/api/now/table/incident/${id}`, { urgency: '1' });
    expect(patched.statusCode).toBe(200);
    expect(json(patched).result.urgency).toBe('1');
    expect(json(patched).result.short_description).toBe('to update');
    const put = await send('PUT', `/api/now/table/incident/${id}`, { urgency: '2' });
    expect(put.statusCode).toBe(200);
    expect(json(put).result.description).toBe('keep me');
    const cleared = await send('PATCH', `/api/now/table/incident/${id}`, { description: '' });
    expect(json(cleared).result.description).toBe('');
    // An empty string leaves a choice field unchanged.
    const choice = await send('PATCH', `/api/now/table/incident/${id}`, { urgency: '' });
    expect(json(choice).result.urgency).toBe('2');
    const missing = await send('PATCH', '/api/now/table/incident/ffffffffffffffffffffffffffffffff', {
      urgency: '1',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('AT-25 resolves display values and local date-times with sysparm_input_display_value', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/table/incident?sysparm_input_display_value=true&sysparm_fields=caller_id,resolved_at,state',
      headers: { authorization: ABEL, 'content-type': 'application/json' },
      payload: {
        short_description: 'by display',
        caller_id: 'Abel Tuter',
        resolved_at: '2026-10-21 08:00:00',
        state: 'In Progress',
      },
    });
    expect(r.statusCode).toBe(201);
    const res = json(r).result;
    expect(res.caller_id.value).toBe(ids.abel);
    expect(res.resolved_at).toBe('2026-10-21 12:00:00');
    expect(res.state).toBe('2');
  });

  it('accepts a valid unused sys_id on POST and rejects malformed ones', async () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ok = await send('POST', '/api/now/table/incident?sysparm_fields=sys_id', {
      sys_id: id,
      short_description: 'chosen id',
    });
    expect(json(ok).result.sys_id).toBe(id);
    expect((await send('POST', '/api/now/table/incident', { sys_id: id })).statusCode).toBe(400);
    expect((await send('POST', '/api/now/table/incident', { sys_id: 'not-a-sys-id' })).statusCode).toBe(400);
  });

  it('AT-26 deletes with 204 and an empty body', async () => {
    const id = json(await send('POST', '/api/now/table/incident', { short_description: 'delete me' })).result
      .sys_id;
    const del = await send('DELETE', `/api/now/table/incident/${id}`);
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    expect((await get(`/api/now/table/incident/${id}`)).statusCode).toBe(404);
  });

  it('AT-31 rejects unsupported content types with 415', async () => {
    const r = await send('POST', '/api/now/table/incident', 'just text', { 'content-type': 'text/plain' });
    expect(r.statusCode).toBe(415);
    expect(json(r).status).toBe('failure');
  });

  it('AT-33 honours X-HTTP-Method-Override on POST', async () => {
    const r = await send(
      'POST',
      `/api/now/table/incident/${ids.inc3}?sysparm_fields=urgency`,
      { urgency: '1' },
      { 'x-http-method-override': 'PATCH' },
    );
    expect(r.statusCode).toBe(200);
    expect(json(r).result.urgency).toBe('1');
  });

  it('maps ACL write failures to 403 Operation Failed', async () => {
    const r = await send(
      'POST',
      '/api/now/table/incident',
      { short_description: 'nope' },
      { authorization: PLAIN },
    );
    expect(r.statusCode).toBe(403);
    expect(json(r).error).toEqual({
      message: 'Operation Failed',
      detail: 'ACL Exception Insert Failed due to security constraints',
    });
  });

  it('answers 405 for unsupported methods, 400 for unknown URIs and tolerates a trailing slash', async () => {
    const r = await send('PUT', '/api/now/table/incident');
    expect(r.statusCode).toBe(405);
    const unknown = await get('/api/now/v9/table/incident');
    expect(unknown.statusCode).toBe(400);
    expect(json(unknown).error).toEqual({
      message: 'Requested URI does not represent any resource',
      detail: null,
    });
    const slash = await get('/api/now/table/incident/');
    expect(slash.statusCode).toBe(200);
  });
});

describe('Aggregate API', () => {
  it('AT-39/40/41 counts, groups and averages', async () => {
    const count = json(
      await get(
        '/api/now/stats/incident?sysparm_count=true&sysparm_query=active=true^short_descriptionINRouter down,Mail queue stuck,Printer offline',
      ),
    );
    expect(count.result.stats.count).toBe('3');
    const grouped = json(
      await get(
        '/api/now/stats/incident?sysparm_count=true&sysparm_group_by=priority&sysparm_query=short_descriptionINRouter down,Mail queue stuck,Printer offline',
      ),
    );
    expect(grouped.result).toEqual([
      { stats: { count: '1' }, groupby_fields: [{ field: 'priority', value: '1' }] },
      { stats: { count: '2' }, groupby_fields: [{ field: 'priority', value: '3' }] },
    ]);
    const avg = json(
      await get(
        '/api/now/stats/incident?sysparm_avg_fields=reassignment_count&sysparm_query=short_descriptionINRouter down,Mail queue stuck,Printer offline',
      ),
    );
    expect(avg.result.stats.avg.reassignment_count).toMatch(/^-?\d+\.\d{4}$/);
    expect(avg.result.stats.avg.reassignment_count).toBe('1.0000');
    expect(avg.result.stats.count).toBeUndefined();
  });

  it('returns empty stats when nothing is requested and formats min, max, sum and durations', async () => {
    expect(json(await get('/api/now/stats/incident')).result).toEqual({ stats: {} });
    const r = json(
      await get(
        '/api/now/stats/incident?sysparm_min_fields=opened_at&sysparm_max_fields=priority&sysparm_sum_fields=reassignment_count&sysparm_avg_fields=business_duration&sysparm_query=short_descriptionINRouter down,Mail queue stuck,Printer offline',
      ),
    );
    expect(r.result.stats).toEqual({
      min: { opened_at: '2026-10-21 03:30:00' },
      max: { priority: '3' },
      sum: { reassignment_count: '3' },
      avg: { business_duration: '3723.0000' },
    });
  });

  it('applies having, order_by and display values', async () => {
    const q = 'sysparm_query=short_descriptionINRouter down,Mail queue stuck,Printer offline';
    const having = json(
      await get(
        `/api/now/stats/incident?${q}&sysparm_count=true&sysparm_group_by=priority&sysparm_having=count^priority^>^1`,
      ),
    );
    expect(having.result).toEqual([
      { stats: { count: '2' }, groupby_fields: [{ field: 'priority', value: '3' }] },
    ]);
    const ordered = json(
      await get(
        `/api/now/stats/incident?${q}&sysparm_count=true&sysparm_group_by=priority&sysparm_order_by=COUNT^DESC`,
      ),
    );
    expect(
      ordered.result.map((g: { groupby_fields: { value: string }[] }) => g.groupby_fields[0].value),
    ).toEqual(['3', '1']);
    const byAvg = json(
      await get(
        `/api/now/stats/incident?${q}&sysparm_group_by=priority&sysparm_order_by=AVG^reassignment_count^DESC`,
      ),
    );
    expect(
      byAvg.result.map((g: { groupby_fields: { value: string }[] }) => g.groupby_fields[0].value),
    ).toEqual(['3', '1']);
    expect(byAvg.result[0].stats).toEqual({});
    const disp = json(
      await get(
        `/api/now/stats/incident?${q}&sysparm_count=true&sysparm_group_by=state&sysparm_display_value=true`,
      ),
    );
    expect(
      disp.result.map((g: { groupby_fields: { value: string }[] }) => g.groupby_fields[0].value),
    ).toEqual(['New', 'In Progress']);
    const all = json(
      await get(
        `/api/now/stats/incident?${q}&sysparm_count=true&sysparm_group_by=caller_id&sysparm_display_value=all`,
      ),
    );
    expect(all.result).toContainEqual({
      stats: { count: '1' },
      groupby_fields: [{ field: 'caller_id', value: ids.abel, display_value: 'Abel Tuter' }],
    });
    expect(all.result).toContainEqual({
      stats: { count: '1' },
      groupby_fields: [{ field: 'caller_id', value: '', display_value: '' }],
    });
    const bad = await get(`/api/now/stats/incident?sysparm_having=nonsense`);
    expect(bad.statusCode).toBe(400);
  });
});

describe('Attachment API', () => {
  let att = '';

  it('AT-42/43 uploads a raw file and downloads it', async () => {
    const up = await app.inject({
      method: 'POST',
      url: `/api/now/attachment/file?table_name=incident&table_sys_id=${ids.inc1}&file_name=a.txt`,
      headers: { authorization: ADMIN, 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(up.statusCode).toBe(201);
    const meta = json(up).result;
    att = meta.sys_id;
    expect(up.headers.location).toBe(`https://resolvr.example.com/api/now/attachment/${att}`);
    expect(meta.size_bytes).toBe('5');
    expect(meta.download_link).toMatch(/\/file$/);
    expect(Object.keys(meta)).toEqual([
      'sys_id',
      'file_name',
      'content_type',
      'size_bytes',
      'size_compressed',
      'compressed',
      'table_name',
      'table_sys_id',
      'download_link',
      'image_width',
      'image_height',
      'average_image_color',
      'sys_tags',
      'sys_mod_count',
      'sys_created_by',
      'sys_created_on',
      'sys_updated_by',
      'sys_updated_on',
      'created_by_name',
      'updated_by_name',
    ]);
    expect(meta.created_by_name).toBe('System Administrator');
    const file = await get(`/api/now/attachment/${att}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('hello');
    expect(file.headers['content-type']).toBe('text/plain');
    expect(JSON.parse(String(file.headers['x-attachment-metadata'])).sys_id).toBe(att);
    expect((await get(`/api/now/attachment/${att}/file`, { accept: 'image/png' })).statusCode).toBe(406);
  });

  it('keeps JSON uploads byte for byte', async () => {
    const raw = '{ "a" : 1 }';
    const up = await app.inject({
      method: 'POST',
      url: `/api/now/attachment/file?table_name=incident&table_sys_id=${ids.inc1}&file_name=data.json`,
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(up.statusCode).toBe(201);
    expect((await get(`/api/now/attachment/${json(up).result.sys_id}/file`)).body).toBe(raw);
  });

  it('AT-44 uploads multipart with the file part last', async () => {
    const boundary = '----resolvr';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="table_name"',
      '',
      'incident',
      `--${boundary}`,
      'Content-Disposition: form-data; name="table_sys_id"',
      '',
      ids.inc2,
      `--${boundary}`,
      'Content-Disposition: form-data; name="uploadFile"; filename="pic.png"',
      'Content-Type: image/png',
      '',
      Buffer.from('89504e470d0a1a0a0000000d494844520000000300000002', 'hex').toString('latin1'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/attachment/upload',
      headers: { authorization: ADMIN, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(body, 'latin1'),
    });
    expect(r.statusCode).toBe(201);
    const meta = json(r).result;
    expect(meta.table_sys_id).toBe(ids.inc2);
    expect(meta.content_type).toBe('image/png');
    expect(meta.file_name).toBe('pic.png');
    expect([meta.image_width, meta.image_height]).toEqual(['3', '2']);
  });

  it('AT-45 validates required parameters and the target record', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/attachment/file?table_name=incident&file_name=a.txt',
      headers: { authorization: ADMIN, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(r.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/now/attachment/file?table_name=incident&table_sys_id=ffffffffffffffffffffffffffffffff&file_name=a.txt',
      headers: { authorization: ADMIN, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('AT-46/47/48 lists, renames and deletes', async () => {
    const list = await get(`/api/now/attachment?sysparm_query=table_sys_id=${ids.inc1}^file_name=a.txt`);
    expect(list.headers['x-total-count']).toBe('1');
    const row = json(list).result[0];
    expect(row.sys_id).toBe(att);
    for (const v of Object.values(row)) expect(typeof v).toBe('string');
    const ren = await send('PATCH', `/api/now/attachment/${att}`, { file_name: 'b.txt' });
    expect(ren.statusCode).toBe(204);
    expect(json(await get(`/api/now/attachment/${att}`)).result.file_name).toBe('b.txt');
    expect((await send('PATCH', `/api/now/attachment/${att}`, {})).statusCode).toBe(400);
    const del = await send('DELETE', `/api/now/attachment/${att}`);
    expect(del.statusCode).toBe(204);
    expect((await get(`/api/now/attachment/${att}`)).statusCode).toBe(404);
  });

  it('manages attachment attributes', async () => {
    const up = await app.inject({
      method: 'POST',
      url: `/api/now/attachment/file?table_name=incident&table_sys_id=${ids.inc1}&file_name=attr.txt`,
      headers: { authorization: ADMIN, 'content-type': 'text/plain' },
      payload: 'x',
    });
    const id = json(up).result.sys_id;
    const add = await send('POST', `/api/now/attachment/${id}/attributes`, {
      key: 'classification',
      value: 'internal',
    });
    expect(add.statusCode).toBe(201);
    expect(json(add).result).toEqual({ key: 'classification', value: 'internal' });
    expect((await send('POST', `/api/now/attachment/${id}/attributes`, { key: 'x' })).statusCode).toBe(400);
    expect(json(await get(`/api/now/attachment/${id}/attributes`)).result).toEqual([
      { key: 'classification', value: 'internal' },
    ]);
    const put = await send('PUT', `/api/now/attachment/${id}/attributes/classification`, { value: 'public' });
    expect(json(put).result).toEqual({ key: 'classification', value: 'public' });
    expect(json(await get(`/api/now/attachment/${id}/attributes/classification`)).result.value).toBe(
      'public',
    );
    expect((await send('DELETE', `/api/now/attachment/${id}/attributes/classification`)).statusCode).toBe(
      204,
    );
    expect((await get(`/api/now/attachment/${id}/attributes/classification`)).statusCode).toBe(404);
  });
});

describe('Batch API', () => {
  it('AT-49/50 runs items in order and echoes ids', async () => {
    const body = Buffer.from("{'short_description':'Disk full'}").toString('base64');
    const r = await send('POST', '/api/now/v1/batch', {
      batch_request_id: 'b-77',
      rest_requests: [
        {
          id: '1',
          method: 'GET',
          url: '/api/now/table/incident?sysparm_limit=1&sysparm_fields=number',
          headers: [{ name: 'Accept', value: 'application/json' }],
          exclude_response_headers: true,
        },
        {
          id: '2',
          method: 'POST',
          url: '/api/now/table/incident?sysparm_fields=number',
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Accept', value: 'application/json' },
          ],
          body,
        },
        { id: '3', method: 'GET', url: '/api/now/table/incident/ffffffffffffffffffffffffffffffff' },
      ],
    });
    expect(r.statusCode).toBe(200);
    const res = json(r);
    expect(res.result).toBeUndefined();
    expect(res.batch_request_id).toBe('b-77');
    expect(res.unserviced_requests).toEqual([]);
    const [a, b, c] = res.serviced_requests;
    expect([a.id, a.status_code, a.status_text]).toEqual(['1', 200, 'OK']);
    expect(a.headers).toEqual([]);
    expect(JSON.parse(Buffer.from(a.body, 'base64').toString()).result).toHaveLength(1);
    expect([b.id, b.status_code, b.status_text]).toEqual(['2', 201, 'Created']);
    expect(b.headers).toContainEqual({ name: 'Content-Type', value: 'application/json;charset=UTF-8' });
    expect(JSON.parse(Buffer.from(b.body, 'base64').toString()).result.number).toMatch(/^INC/);
    expect(typeof b.execution_time).toBe('number');
    expect([c.status_code, c.error_message]).toEqual([404, 'No Record found']);
  });

  it('rejects nested batches per item and stops at size limits', async () => {
    const r = json(
      await send('POST', '/api/now/batch', {
        rest_requests: [{ id: 'n', method: 'POST', url: '/api/now/batch' }],
      }),
    );
    expect(r.serviced_requests[0].status_code).toBe(400);
    const big = json(
      await send(
        'POST',
        '/api/now/batch',
        {
          rest_requests: [
            { id: '1', method: 'GET', url: '/api/now/table/incident?sysparm_limit=1' },
            { id: '2', method: 'GET', url: '/api/now/table/incident' },
            { id: '3', method: 'GET', url: '/api/now/table/incident?sysparm_limit=1' },
          ],
        },
        { 'x-batchrequest-max-output-size': '4000' },
      ),
    );
    expect(big.serviced_requests.map((s: { id: string }) => s.id)).toEqual(['1']);
    expect(big.unserviced_requests).toEqual(['2', '3']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/now/batch',
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('Import Set API', () => {
  beforeAll(() => {
    const sys = p.systemContext();
    const map = sys.insert('sys_transform_map', {
      name: 'User Import',
      source_table: 'u_imp_user',
      target_table: 'sys_user',
    });
    sys.insert('sys_transform_entry', { map: map.sysId, source_field: 'u_name', target_field: 'name' });
    sys.insert('sys_transform_entry', {
      map: map.sysId,
      source_field: 'u_user_name',
      target_field: 'user_name',
      coalesce: true,
    });
    sys.insert('sys_transform_entry', { map: map.sysId, source_field: 'u_email', target_field: 'email' });
    sys.insert('sys_transform_entry', {
      map: map.sysId,
      source_field: 'u_department',
      target_field: 'department',
      choice_action: 'reject',
    });
  });

  it('AT-51 inserts a staging row and transforms it synchronously', async () => {
    const r = await send('POST', '/api/now/import/u_imp_user', {
      u_name: 'Lena Ortiz',
      u_user_name: 'lena.ortiz',
    });
    expect(r.statusCode).toBe(201);
    const res = json(r);
    expect(res.import_set).toMatch(/^ISET\d+$/);
    expect(res.staging_table).toBe('u_imp_user');
    expect(res.result).toHaveLength(1);
    const entry = res.result[0];
    expect(Object.keys(entry)).toEqual([
      'transform_map',
      'table',
      'display_name',
      'display_value',
      'record_link',
      'status',
      'sys_id',
    ]);
    expect(entry).toMatchObject({
      transform_map: 'User Import',
      table: 'sys_user',
      display_name: 'name',
      display_value: 'Lena Ortiz',
      status: 'inserted',
    });
    expect(entry.record_link).toBe(`https://resolvr.example.com/api/now/table/sys_user/${entry.sys_id}`);
    // Coalesce on user_name updates instead of inserting; unchanged rows are ignored.
    const again = json(
      await send(
        'POST',
        '/api/now/import/u_imp_user',
        "{'u_name':'Lena Ortiz','u_user_name':'lena.ortiz','u_email':'lena@example.com'}",
      ),
    );
    expect(again.result[0]).toMatchObject({ status: 'updated', sys_id: entry.sys_id });
    expect(again.import_set).toBe(res.import_set);
    const same = json(
      await send('POST', '/api/now/import/u_imp_user', { u_name: 'Lena Ortiz', u_user_name: 'lena.ortiz' }),
    );
    expect(same.result[0].status).toBe('ignored');
    // An unknown reference value with choice action "reject" skips the row.
    const rejected = json(
      await send('POST', '/api/now/import/u_imp_user', {
        u_name: 'Nora',
        u_user_name: 'nora',
        u_department: 'Nowhere',
      }),
    );
    expect(rejected.result[0].status).toBe('skipped');
  });

  it('reads a staging row with its transform result', async () => {
    const sys = p.systemContext();
    const row = sys.first('u_imp_user', 'u_user_name=lena.ortiz', [
      { field: 'sys_import_row', desc: false },
    ])!;
    const r = await get(`/api/now/import/u_imp_user/${row.sysId}`);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({
      staging_table: 'u_imp_user',
      result: [{ status: 'inserted', table: 'sys_user' }],
    });
    expect((await get('/api/now/import/u_imp_user/ffffffffffffffffffffffffffffffff')).statusCode).toBe(404);
    expect((await send('POST', '/api/now/import/incident', { a: 1 })).statusCode).toBe(400);
  });

  it('inserts multiple rows by column label and transforms them asynchronously', async () => {
    const r = await send('POST', '/api/now/import/u_imp_user/insertMultiple', {
      records: [
        { Name: 'Ana Silva', 'User ID': 'ana.silva', 'Email address': 'ana@example.com' },
        { Name: 'Bo Chen', 'User ID': 'bo.chen' },
      ],
    });
    expect(r.statusCode).toBe(201);
    const res = json(r);
    expect(Object.keys(res)).toEqual(['import_set_id', 'multi_import_set_id']);
    const sys = p.systemContext();
    expect(sys.count('u_imp_user', `sys_import_set=${res.import_set_id}^sys_import_state=pending`)).toBe(2);
    p.drain();
    expect(sys.count('u_imp_user', `sys_import_set=${res.import_set_id}^sys_import_state=inserted`)).toBe(2);
    expect(sys.first('sys_user', 'user_name=ana.silva')?.str('email')).toBe('ana@example.com');
    expect(sys.get('sys_import_set', res.import_set_id)?.str('state')).toBe('processed');
    const more = await send(
      'POST',
      `/api/now/import/u_imp_user/insertMultiple?multi_import_set_id=${res.multi_import_set_id}`,
      { records: [{ Name: 'Cy', 'User ID': 'cy' }] },
    );
    expect(json(more).multi_import_set_id).toBe(res.multi_import_set_id);
    expect((await send('POST', '/api/now/import/u_imp_user/insertMultiple', { rows: [] })).statusCode).toBe(
      400,
    );
  });

  it('requires create rights on the staging table', async () => {
    const r = await send('POST', '/api/now/import/u_imp_user', { u_name: 'x' }, { authorization: PLAIN });
    expect(r.statusCode).toBe(403);
  });
});

describe('Account and User Role Inheritance APIs', () => {
  it('lists accounts as flat records with hasMore', async () => {
    const sys = p.systemContext();
    sys.insert('customer_account', { name: 'Acme', primary_contact: ids.abel });
    sys.insert('customer_account', { name: 'Globex' });
    const csm = basic('csm.agent', 'Password1!');
    const r = await get('/api/now/account?sysparm_limit=1&sysparm_query=ORDERBYname', { authorization: csm });
    expect(r.statusCode).toBe(200);
    const res = json(r);
    expect(res.hasMore).toBe(true);
    expect(res.result[0]).toMatchObject({
      name: 'Acme',
      primary_contact: ids.abel,
      number: expect.stringMatching(/^ACCT/),
    });
    expect(r.headers['x-total-count']).toBe('2');
    const one = await get(`/api/now/account/${res.result[0].sys_id}`, { authorization: csm });
    expect(json(one).result.name).toBe('Acme');
    expect(
      (await get('/api/now/account/ffffffffffffffffffffffffffffffff', { authorization: csm })).statusCode,
    ).toBe(404);
    expect((await get('/api/now/account', { authorization: PLAIN })).statusCode).toBe(403);
  });

  it('AT-63 reports direct, contained and group roles', async () => {
    const ua = basic('user.admin', 'Password1!');
    const r = await get(`/api/global/user_role_inheritance?user_sysid=${ids.abel}`, { authorization: ua });
    expect(r.statusCode).toBe(200);
    expect(json(r).result).toEqual({
      user_name: 'abel.tuter',
      from_role: ['/itil', '/itil/sn_change_read'],
      from_group: ['[Network]/itil', '[Network]/itil/sn_change_read'],
    });
    expect((await get('/api/global/v1/user_role_inheritance', { authorization: ua })).statusCode).toBe(400);
    expect(
      (
        await get('/api/global/user_role_inheritance?user_sysid=ffffffffffffffffffffffffffffffff', {
          authorization: ua,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await get(`/api/global/user_role_inheritance?user_sysid=${ids.abel}`, { authorization: BETH }))
        .statusCode,
    ).toBe(403);
  });
});

describe('body and XML helpers', () => {
  it('parses lenient JSON safely', () => {
    expect(parseLenientJson("{'a':'it\\'s', b: [1, 2,], /* c */ 'd': 0x10, e: .5}")).toEqual({
      a: "it's",
      b: [1, 2],
      d: 16,
      e: 0.5,
    });
    const polluted = parseLenientJson("{'__proto__': {'x': 1}}") as Record<string, unknown>;
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(Object.keys(polluted)).toEqual(['__proto__']);
    expect(() => parseLenientJson("{'a':")).toThrow();
  });

  it('converts XML in both directions', () => {
    expect(
      xmlToObject(
        '<?xml version="1.0"?><request><entry><a>1</a><b><![CDATA[<x>]]></b><c>&#65;&lt;</c></entry></request>',
      ),
    ).toEqual({
      a: '1',
      b: '<x>',
      c: 'A<',
    });
    expect(() => xmlToObject('<!DOCTYPE x [<!ENTITY e "x">]><x>&e;</x>')).toThrow();
    expect(toXmlResponse({ result: [{ 'caller_id.name': 'A & B', n: null }], status: 'ok' })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><response><result><caller_id.name>A &amp; B</caller_id.name><n/></result><status>ok</status></response>',
    );
  });
});
