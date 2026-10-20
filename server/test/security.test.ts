import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import { incidentModule } from '../src/modules/incident/index.js';
import { syncPlatformMetadata } from '../src/modules/platform/index.js';
import { bootPlatform, makeUser } from './helpers.js';

/** Tables whose ACLs exercise field-level rules, plus an ACL naming a role no module declares. */
const fixtures: AppModule = {
  id: 'security_fixtures',
  name: 'Security fixtures',
  dependsOn: ['task'],
  tables: [
    { name: 'u_ticket', label: 'Ticket', extends: 'task', columns: [] },
    {
      name: 'u_doc',
      label: 'Document',
      columns: [
        { name: 'u_name', label: 'Name', type: 'string' },
        { name: 'u_status', label: 'Status', type: 'string' },
        { name: 'u_owner_note', label: 'Owner note', type: 'string' },
      ],
    },
    { name: 'u_secret', label: 'Secret', columns: [{ name: 'u_name', label: 'Name', type: 'string' }] },
    { name: 'u_mix', label: 'Mixed', columns: [{ name: 'u_name', label: 'Name', type: 'string' }] },
  ],
  acls: [
    ...(['read', 'write', 'create'] as const).map((operation) => ({ name: 'u_ticket', operation })),
    { name: 'u_ticket.work_notes', operation: 'write', roles: ['itil'] },
    ...(['read', 'write', 'create'] as const).map((operation) => ({ name: 'u_doc', operation })),
    { name: 'u_doc.u_status', operation: 'write', roles: ['doc_admin'] },
    { name: 'u_doc.u_owner_note', operation: 'write', roles: ['doc_admin'] },
    { name: 'u_doc.u_owner_note', operation: 'create' },
    { name: 'u_secret', operation: 'read', roles: ['u_secret_reader'] },
    { name: 'u_mix', operation: 'read', roles: ['mix_one'] },
    { name: 'u_mix', operation: 'read', roles: ['mix_two'] },
  ],
};

let p: Platform;
let app: FastifyInstance;
let dir: string;
const basic = (u: string) => `Basic ${Buffer.from(`${u}:Password1!`).toString('base64')}`;
const json = (user: string) => ({ authorization: basic(user), 'content-type': 'application/json' });

beforeAll(async () => {
  p = bootPlatform([incidentModule, fixtures]);
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-security-'));
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
  makeUser(p, 'plain.user', []);
  makeUser(p, 'desk.agent', ['itil']);
  makeUser(p, 'doc.admin', ['doc_admin']);
  makeUser(p, 'mix.two', ['mix_two']);
});

afterAll(async () => {
  await app.close();
  p.close();
  rmSync(dir, { recursive: true, force: true });
});

function journal(table: string, sysId: string, field: string): string[] {
  return p.db
    .all<{ value: string }>(`SELECT "value" FROM "sys_journal_field" WHERE "name" = ? AND "element_id" = ? AND "element" = ?`, [table, sysId, field])
    .map((r) => r.value);
}

describe('field ACLs on journal fields', () => {
  it('drops work notes from a user without the write role but keeps comments', async () => {
    const id = p.systemContext().insert('u_ticket', { short_description: 'Printer jam' }).sysId;
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/u_ticket/${id}`,
      headers: json('plain.user'),
      payload: { work_notes: 'internal guess', comments: 'Still broken' },
    });
    expect(r.statusCode).toBe(200);
    expect(journal('u_ticket', id, 'work_notes')).toEqual([]);
    expect(journal('u_ticket', id, 'comments')).toEqual(['Still broken']);
  });

  it('lets an agent write work notes', async () => {
    const id = p.systemContext().insert('u_ticket', { short_description: 'Projector' }).sysId;
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/u_ticket/${id}`,
      headers: json('desk.agent'),
      payload: { work_notes: 'Replaced the lamp' },
    });
    expect(r.statusCode).toBe(200);
    expect(journal('u_ticket', id, 'work_notes')).toEqual(['Replaced the lamp']);
  });

  it('keeps work notes off a caller-owned incident through the Table API', async () => {
    const caller = p.systemContext().getBy('sys_user', 'user_name', 'plain.user')!.sysId;
    const id = p.systemContext().insert('incident', { short_description: 'VPN drops', caller_id: caller }).sysId;
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/incident/${id}`,
      headers: json('plain.user'),
      payload: { work_notes: 'I am an agent now', comments: 'It dropped again at 10:00' },
    });
    expect(r.statusCode).toBe(200);
    expect(journal('incident', id, 'work_notes')).toEqual([]);
    expect(journal('incident', id, 'comments')).toEqual(['It dropped again at 10:00']);
  });
});

describe('field ACLs on insert', () => {
  it('applies write ACLs to fields that have no create ACL', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/table/u_doc',
      headers: json('plain.user'),
      payload: { u_name: 'Draft', u_status: 'published' },
    });
    expect(r.statusCode).toBe(201);
    const { result } = r.json();
    expect(result.u_name).toBe('Draft');
    expect(result.u_status).toBe('');
  });

  it('lets a field-level create ACL decide when one exists', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/table/u_doc',
      headers: json('plain.user'),
      payload: { u_name: 'Notes', u_owner_note: 'set at creation' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().result.u_owner_note).toBe('set at creation');
  });

  it('allows the protected field for a user with the write role', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/now/table/u_doc',
      headers: json('doc.admin'),
      payload: { u_name: 'Final', u_status: 'published' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().result.u_status).toBe('published');
  });
});

describe('mirrored native ACLs', () => {
  it('creates roles that ACLs reference and keeps requiring them', () => {
    const ctx = p.systemContext();
    const role = ctx.getBy('sys_user_role', 'name', 'u_secret_reader');
    expect(role).not.toBeNull();
    const acl = ctx.first('sys_security_acl', 'name=u_secret^operation=read')!;
    expect(ctx.query('sys_security_acl_role', `sys_security_acl=${acl.sysId}`).map((l) => l.str('sys_user_role'))).toEqual([role!.sysId]);
    expect(p.acl.canTable(p.contextAs('plain.user'), 'u_secret', 'read').allowed).toBe(false);
  });

  it('does not open an ACL whose mirrored role links are missing', () => {
    const ctx = p.systemContext();
    const acl = ctx.first('sys_security_acl', 'name=u_secret^operation=read')!;
    for (const link of ctx.query('sys_security_acl_role', `sys_security_acl=${acl.sysId}`)) ctx.delete(link);
    p.acl.invalidate();
    expect(p.acl.canTable(p.contextAs('plain.user'), 'u_secret', 'read').allowed).toBe(false);
    syncPlatformMetadata(p);
    expect(ctx.query('sys_security_acl_role', `sys_security_acl=${acl.sysId}`)).toHaveLength(1);
  });

  it('ignores and removes mirrors of ACLs that no longer exist', () => {
    const ctx = p.systemContext();
    const stale = ctx.insert('sys_security_acl', { name: 'u_secret', operation: 'read', active: true, native_id: 'native:read:u_secret:99' });
    p.acl.invalidate();
    expect(p.acl.canTable(p.contextAs('plain.user'), 'u_secret', 'read').allowed).toBe(false);
    syncPlatformMetadata(p);
    expect(ctx.get('sys_security_acl', stale.sysId)).toBeNull();
  });

  it('honours the active flag on a mirrored native ACL', () => {
    const ctx = p.systemContext();
    expect(p.acl.canTable(p.contextAs('mix.two'), 'u_mix', 'read').allowed).toBe(true);
    const two = ctx
      .query('sys_security_acl', 'name=u_mix^operation=read')
      .find((a) => ctx.query('sys_security_acl_role', `sys_security_acl=${a.sysId}`).some((l) => l.ref('sys_user_role')?.str('name') === 'mix_two'))!;
    two.set('active', false);
    ctx.update(two);
    p.acl.invalidate();
    expect(p.acl.canTable(p.contextAs('mix.two'), 'u_mix', 'read').allowed).toBe(false);
  });
});
