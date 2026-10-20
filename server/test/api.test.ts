import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Platform } from '../src/engine/platform.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let app: FastifyInstance;
let dir: string;
const basic = (u: string, pw: string) => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
const ADMIN = basic('admin', 'admin-test-pw');

beforeAll(async () => {
  p = bootPlatform();
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-test-'));
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
  makeUser(p, 'itil.agent', ['itil']);
  makeUser(p, 'plain.user', []);
});

afterAll(async () => {
  await app.close();
  p.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Table API', () => {
  it('rejects anonymous requests with 401 and the platform error shape', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/now/table/task' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ status: 'failure', error: { message: 'User Not Authenticated' } });
  });

  it('creates, reads, updates and deletes records', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/now/table/task',
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      payload: { short_description: 'Laptop will not boot', priority: '2' },
    });
    expect(created.statusCode).toBe(201);
    const rec = created.json().result;
    expect(rec.number).toMatch(/^TASK/);
    expect(rec.priority).toBe('2');
    expect(rec.active).toBe('true');
    expect(rec.opened_by).toMatchObject({ link: expect.stringContaining('https://resolvrnow.test/api/now/table/sys_user/') });
    expect(created.headers.location).toBe(`https://resolvrnow.test/api/now/table/task/${rec.sys_id}`);

    const got = await app.inject({ method: 'GET', url: `/api/now/table/task/${rec.sys_id}?sysparm_display_value=true&sysparm_fields=number,priority,opened_by`, headers: { authorization: ADMIN } });
    expect(got.json().result).toEqual({
      number: rec.number,
      priority: '2 - High',
      opened_by: { display_value: 'System Administrator', link: expect.any(String) },
    });

    const all = await app.inject({ method: 'GET', url: `/api/now/table/task/${rec.sys_id}?sysparm_display_value=all&sysparm_fields=priority&sysparm_exclude_reference_link=true`, headers: { authorization: ADMIN } });
    expect(all.json().result.priority).toEqual({ display_value: '2 - High', value: '2' });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/task/${rec.sys_id}`,
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      payload: { state: '3', work_notes: 'Replaced the battery' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().result.active).toBe('false');

    const del = await app.inject({ method: 'DELETE', url: `/api/now/table/task/${rec.sys_id}`, headers: { authorization: ADMIN } });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/now/table/task/${rec.sys_id}`, headers: { authorization: ADMIN } });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.message).toBe('No Record found');
  });

  it('paginates with X-Total-Count and Link headers', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/now/table/task',
        headers: { authorization: ADMIN, 'content-type': 'application/json' },
        payload: { short_description: `Paged ${i}` },
      });
    }
    const r = await app.inject({
      method: 'GET',
      url: '/api/now/table/task?sysparm_query=short_descriptionSTARTSWITHPaged&sysparm_limit=2&sysparm_offset=2',
      headers: { authorization: ADMIN },
    });
    expect(r.headers['x-total-count']).toBe('5');
    expect(r.json().result).toHaveLength(2);
    const link = String(r.headers.link);
    expect(link).toContain('rel="first"');
    expect(link).toContain('rel="prev"');
    expect(link).toContain('rel="next"');
    expect(link).toContain('sysparm_offset=4>;rel="last"');
  });

  it('returns 400 for unknown tables', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/now/table/not_a_table', headers: { authorization: ADMIN } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('Invalid table not_a_table');
  });

  it('enforces ACLs for non-privileged users', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/table/task',
      headers: { authorization: basic('plain.user', 'Password1!'), 'content-type': 'application/json' },
      payload: { short_description: 'not allowed' },
    });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/now/table/task',
      headers: { authorization: basic('itil.agent', 'Password1!'), 'content-type': 'application/json' },
      payload: { short_description: 'agent created' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('never returns password hashes', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/now/table/sys_user?sysparm_query=user_name=admin', headers: { authorization: ADMIN } });
    expect(r.json().result[0].user_password).toBe('');
  });

  it('supports v1/v2 paths', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/now/v2/table/sys_user_role?sysparm_limit=1', headers: { authorization: ADMIN } });
    expect(r.statusCode).toBe(200);
  });
});

describe('Aggregate API', () => {
  it('counts and groups', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/now/stats/task?sysparm_count=true&sysparm_group_by=priority&sysparm_display_value=true',
      headers: { authorization: ADMIN },
    });
    expect(r.statusCode).toBe(200);
    const rows = r.json().result as { stats: { count: string }; groupby_fields: { field: string; value: string; display_value: string }[] }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].groupby_fields[0].field).toBe('priority');
    const total = await app.inject({ method: 'GET', url: '/api/now/stats/task?sysparm_count=true', headers: { authorization: ADMIN } });
    expect(Number(total.json().result.stats.count)).toBe(rows.reduce((n, row) => n + Number(row.stats.count), 0));
  });
});

describe('Attachment API', () => {
  it('uploads, lists, downloads and deletes a file', async () => {
    const t = await app.inject({
      method: 'POST',
      url: '/api/now/table/task',
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      payload: { short_description: 'with attachment' },
    });
    const id = t.json().result.sys_id;
    const up = await app.inject({
      method: 'POST',
      url: `/api/now/attachment/file?table_name=task&table_sys_id=${id}&file_name=log.txt`,
      headers: { authorization: ADMIN, 'content-type': 'text/plain' },
      payload: 'hello world',
    });
    expect(up.statusCode).toBe(201);
    const att = up.json().result;
    expect(att.size_bytes).toBe('11');
    const file = await app.inject({ method: 'GET', url: `/api/now/attachment/${att.sys_id}/file`, headers: { authorization: ADMIN } });
    expect(file.body).toBe('hello world');
    const list = await app.inject({ method: 'GET', url: `/api/now/attachment?sysparm_query=table_sys_id=${id}`, headers: { authorization: ADMIN } });
    expect(list.json().result).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/now/attachment/${att.sys_id}`, headers: { authorization: ADMIN } });
    expect(del.statusCode).toBe(204);
  });
});

describe('UI session API', () => {
  it('logs in with a cookie and requires the CSRF header for writes', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/app/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { user_name: 'itil.agent', password: 'Password1!' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const csrf = login.json().result.csrf_token;
    const me = await app.inject({ method: 'GET', url: '/api/app/me', headers: { cookie } });
    expect(me.json().result).toMatchObject({ user_name: 'itil.agent', is_agent: true });
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/now/table/task',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { short_description: 'x' },
    });
    expect(noCsrf.statusCode).toBe(401);
    const withCsrf = await app.inject({
      method: 'POST',
      url: '/api/now/table/task',
      headers: { cookie, 'x-usertoken': csrf, 'content-type': 'application/json' },
      payload: { short_description: 'x' },
    });
    expect(withCsrf.statusCode).toBe(201);
    const meta = await app.inject({ method: 'GET', url: '/api/app/meta/task', headers: { cookie } });
    expect(meta.json().result.columns.priority.choices).toHaveLength(5);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/app/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { user_name: 'itil.agent', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
