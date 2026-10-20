import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/api/auth.js';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { aiFixturesModule } from '../src/modules/ai/fixtures.js';
import { aiModule } from '../src/modules/ai/index.js';
import { createMcpServer } from '../src/modules/ai/mcp/server.js';
import { bootPlatform, makeUser } from './helpers.js';

type Data = Record<string, unknown> & {
  error?: { code: string; message: string; confirmation_token?: string; preview?: Record<string, unknown> };
};

let p: Platform;
let sys: Context;
let incA: Rec;
let incB: Rec;
const clients: Client[] = [];

async function connect(userName: string): Promise<Client> {
  const user = p.users.byUserName(userName)!;
  const server = createMcpServer(p, user, { transport: 'memory', client: 'vitest' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: Data }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const data = (r.structuredContent ?? JSON.parse((r.content[0] as { text: string }).text)) as Data;
  return { isError: !!r.isError, data };
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

beforeAll(() => {
  p = bootPlatform([aiModule, aiFixturesModule]);
  sys = p.systemContext();
  makeUser(p, 'mia.agent', ['itil', 'mcp_user'], ['Hardware Team']);
  const rex = makeUser(p, 'rex.requester', ['mcp_user']);
  const olga = makeUser(p, 'olga.other', ['mcp_user']);
  makeUser(p, 'rob.reader', ['sn_incident_read', 'mcp_user']);
  makeUser(p, 'nora.nomcp', ['itil']);
  incA = sys.insert('incident', {
    short_description: 'Laptop battery drains fast',
    caller_id: rex,
    urgency: '3',
    state: '2',
  });
  sys.update(incA, { work_notes: 'Internal: this battery model was recalled.' });
  sys.update(incA, { comments: 'We ordered a new battery for you.' });
  incB = sys.insert('incident', {
    short_description: 'Cannot open the finance share',
    caller_id: olga,
    state: '1',
  });
  const base = sys.insert('kb_knowledge_base', { title: 'IT' }).sysId;
  sys.insert('kb_knowledge', {
    kb_knowledge_base: base,
    short_description: 'Extend laptop battery life',
    text: '<p>Lower the screen brightness and close background apps to extend battery life.</p>',
    workflow_state: 'published',
  });
  sys.insert('change_request', { short_description: 'Replace the core router', state: '-4', type: 'normal' });
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  p.close();
});

describe('MCP tools (in-memory transport)', () => {
  it('lists the tools allowed for each user', async () => {
    const agentTools = await toolNames(await connect('mia.agent'));
    for (const t of [
      'incident_get_details',
      'incident_modify',
      'incident_search',
      'incident_search_similar',
      'incident_search_similar_kb',
      'incident_get_kb_details',
      'incident_attach_kb',
      'incident_create',
      'problem_get_details',
      'change_query',
      'change_lifecycle',
      'lookup_users',
      'lookup_assignment_groups',
      'get_session_timezone',
      'requester_check_status',
    ]) {
      expect(agentTools).toContain(t);
    }
    const requesterTools = await toolNames(await connect('rex.requester'));
    expect(requesterTools).toContain('incident_get_details');
    expect(requesterTools).toContain('requester_create_incident');
    expect(requesterTools).not.toContain('incident_search');
    expect(requesterTools).not.toContain('lookup_users');
    expect(requesterTools).not.toContain('change_lifecycle');
  });

  it('gives agents the full incident with work notes', async () => {
    const { isError, data } = await call(await connect('mia.agent'), 'incident_get_details', {
      number: incA.str('number'),
    });
    expect(isError).toBe(false);
    expect(data.number).toBe(incA.str('number'));
    expect(data.short_description).toBe('Laptop battery drains fast');
    const types = (data.activity as { type: string }[]).map((a) => a.type).sort();
    expect(types).toEqual(['comments', 'work_notes']);
  });

  it('gives requesters their own incidents only, with comments but no work notes', async () => {
    const rex = await connect('rex.requester');
    const own = await call(rex, 'incident_get_details', { sys_id: incA.sysId });
    expect(own.isError).toBe(false);
    expect((own.data.activity as { type: string; text: string }[]).map((a) => a.type)).toEqual(['comments']);
    expect(JSON.stringify(own.data)).not.toContain('recalled');
    expect(own.data.assigned_to).toBeUndefined();
    const other = await call(rex, 'incident_get_details', { number: incB.str('number') });
    expect(other.isError).toBe(true);
    expect(other.data.error?.code).toBe('NOT_FOUND');
  });

  it('enforces write permissions: read-only roles get FORBIDDEN and nothing changes', async () => {
    const res = await call(await connect('rob.reader'), 'incident_modify', {
      number: incA.str('number'),
      work_notes: 'should not be written',
    });
    expect(res.isError).toBe(true);
    expect(res.data.error?.code).toBe('FORBIDDEN');
    expect(
      p.history
        .journal('incident', incA.sysId, ['work_notes'])
        .some((j) => j.value === 'should not be written'),
    ).toBe(false);
    const log = sys.first('resolvr_mcp_call_log', `tool=incident_modify^outcome=forbidden`)!;
    expect(log.display('user')).toBe('rob reader');
    expect(log.str('transport')).toBe('memory');
  });

  it('lets agents update incidents with business rules and ACLs applied', async () => {
    const res = await call(await connect('mia.agent'), 'incident_modify', {
      number: incA.str('number'),
      work_notes: 'Replacement battery shipped.',
      assignment_group: 'Hardware Team',
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('updated');
    const fresh = sys.get('incident', incA.sysId)!;
    expect(fresh.display('assignment_group')).toBe('Hardware Team');
    expect(fresh.str('sys_updated_by')).toBe('mia.agent');
    const bad = await call(await connect('mia.agent'), 'incident_modify', {
      number: incA.str('number'),
      assignment_group: 'No Such Group',
    });
    expect(bad.data.error?.code).toBe('VALIDATION');
    const log = sys.first('resolvr_mcp_call_log', `tool=incident_modify^outcome=ok`)!;
    expect(log.str('record')).toBe(incA.sysId);
  });

  it('limits requesters to comments, escalation and confirmed resolution', async () => {
    const rex = await connect('rex.requester');
    const number = incA.str('number');
    expect((await call(rex, 'incident_modify', { number, work_notes: 'x' })).data.error?.code).toBe(
      'FORBIDDEN',
    );
    expect((await call(rex, 'incident_modify', { number, fields: { priority: '1' } })).data.error?.code).toBe(
      'FORBIDDEN',
    );
    expect((await call(rex, 'incident_modify', { number, comments: 'Thanks!' })).data.status).toBe(
      'commented',
    );
    expect((await call(rex, 'incident_modify', { number, escalate: true })).data.error?.code).toBe(
      'VALIDATION',
    );
    const esc = await call(rex, 'incident_modify', {
      number,
      escalate: true,
      escalation_reason: 'I travel tomorrow',
    });
    expect(esc.data.status).toBe('escalated');
    expect(sys.get('incident', incA.sysId)!.str('urgency')).toBe('1');
    expect(
      (await call(rex, 'incident_modify', { number, escalate: true, escalation_reason: 'again' })).data.error
        ?.code,
    ).toBe('INVALID_STATE');
    const first = await call(rex, 'incident_modify', { number, resolve: true });
    expect(first.data.error?.code).toBe('CONFIRMATION_REQUIRED');
    const token = first.data.error?.confirmation_token as string;
    expect(token).toBeTruthy();
    expect(sys.get('incident', incA.sysId)!.str('state')).toBe('2');
    const done = await call(rex, 'incident_modify', { number, resolve: true, confirmation_token: token });
    expect(done.data.status).toBe('resolved');
    const resolved = sys.get('incident', incA.sysId)!;
    expect(resolved.str('state')).toBe('6');
    expect(resolved.str('close_code')).toBe('Resolved by caller');
    // A token is bound to the user who received it.
    const olga = await connect('olga.other');
    const stolen = await call(olga, 'incident_modify', {
      sys_id: incB.sysId,
      resolve: true,
      confirmation_token: token,
    });
    expect(stolen.data.error?.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('searches incidents and knowledge, and attaches articles', async () => {
    const mia = await connect('mia.agent');
    const found = await call(mia, 'incident_search', { text: 'battery' });
    expect((found.data.results as { number: string }[]).map((r) => r.number)).toContain(incA.str('number'));
    const kb = await call(mia, 'incident_search_similar_kb', { incident_number: incA.str('number') });
    const hits = kb.data.results as { number: string; title: string; relevance: number }[];
    expect(hits[0].title).toBe('Extend laptop battery life');
    const details = await call(mia, 'incident_get_kb_details', { number: hits[0].number });
    expect(details.data.body).toContain('Lower the screen brightness');
    const attached = await call(mia, 'incident_attach_kb', {
      incident: incA.str('number'),
      kb_article: hits[0].number,
    });
    expect(attached.data).toMatchObject({
      status: 'attached',
      incident: incA.str('number'),
      kb_number: hits[0].number,
    });
    expect(sys.count('m2m_kb_task', `task=${incA.sysId}`)).toBe(1);
    const similar = await call(mia, 'incident_search_similar', { text: 'laptop battery empty quickly' });
    expect((similar.data.results as { number: string }[])[0].number).toBe(incA.str('number'));
  });

  it('guides a requester through incident creation and status checks', async () => {
    const rex = await connect('rex.requester');
    const start = await call(rex, 'requester_create_incident', {
      description: 'My laptop battery drains within an hour. It started after the update.',
    });
    expect(start.data.step).toBe('review');
    expect((start.data.suggested_articles as { title: string }[])[0].title).toBe(
      'Extend laptop battery life',
    );
    const sessionId = start.data.session_id as string;
    const review = await call(rex, 'requester_create_incident', {
      session_id: sessionId,
      choice: { type: 'continue' },
    });
    expect(review.data.step).toBe('confirm');
    const created = await call(rex, 'requester_create_incident', {
      session_id: sessionId,
      choice: { type: 'submit' },
      urgency: '2',
    });
    expect(created.data.outcome).toBe('created');
    const inc = sys.first('incident', `number=${created.data.number}`)!;
    expect(inc.display('caller_id')).toBe('rex requester');
    expect(inc.str('urgency')).toBe('2');
    const olga = await connect('olga.other');
    expect(
      (await call(olga, 'requester_create_incident', { session_id: sessionId, choice: { type: 'submit' } }))
        .data.error?.code,
    ).toBe('VALIDATION');
    const status = await call(rex, 'requester_check_status', { reference: 'my latest ticket' });
    expect((status.data.record as { number: string }).number).toBe(created.data.number);
    const byNumber = await call(olga, 'requester_check_status', { number: created.data.number });
    expect(byNumber.data.error?.code).toBe('NOT_FOUND');
    const bySubject = await call(rex, 'requester_check_status', { reference: 'my battery ticket' });
    expect((bySubject.data.record as { short_description: string }).short_description).toMatch(/battery/i);
    expect(
      (await call(rex, 'requester_check_status', { reference: 'my forklift ticket' })).data.error?.code,
    ).toBe('NOT_FOUND');
  });

  it('looks up people and groups, and reports the session time zone', async () => {
    const mia = await connect('mia.agent');
    const users = await call(mia, 'lookup_users', { role: 'itil' });
    const names = (users.data.results as { user_name: string }[]).map((u) => u.user_name);
    expect(names).toContain('mia.agent');
    expect(names).not.toContain('rex.requester');
    const groups = await call(mia, 'lookup_assignment_groups', { query: 'Hardware', include_members: true });
    const g = (groups.data.results as { name: string; members: { name: string }[] }[])[0];
    expect(g.name).toBe('Hardware Team');
    expect(g.members.map((m) => m.name)).toContain('mia agent');
    const tz = await call(mia, 'get_session_timezone');
    expect(tz.data.time_zone).toBe('UTC');
    expect(String(tz.data.now_utc)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('queries and updates changes, with confirmation for state transitions', async () => {
    const mia = await connect('mia.agent');
    const search = await call(mia, 'change_query', { operation: 'search', text: 'router' });
    const number = (search.data.results as { number: string }[])[0].number;
    expect(number).toMatch(/^CHG/);
    const created = await call(mia, 'change_lifecycle', {
      operation: 'create',
      type: 'emergency',
      fields: { short_description: 'Patch the firewall' },
    });
    expect(created.data.status).toBe('created');
    const ask = await call(mia, 'change_lifecycle', {
      operation: 'update',
      number,
      state: 'Authorize',
      work_notes: 'Ready for CAB',
    });
    expect(ask.data.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(ask.data.error?.preview).toMatchObject({ number, to: 'Authorize' });
    const ok = await call(mia, 'change_lifecycle', {
      operation: 'update',
      number,
      state: 'Authorize',
      work_notes: 'Ready for CAB',
      confirmation_token: ask.data.error?.confirmation_token,
    });
    expect(ok.data.status).toBe('updated');
    expect(sys.first('change_request', `number=${number}`)!.str('state')).toBe('-3');
    expect((await call(mia, 'change_query', { operation: 'data_quality' })).data.error?.code).toBe(
      'VALIDATION',
    );
  });

  it('exposes prompts and resources', async () => {
    const mia = await connect('mia.agent');
    const prompts = (await mia.listPrompts()).prompts.map((x) => x.name);
    expect(prompts).toEqual(
      expect.arrayContaining(['summarize_incident', 'draft_resolution_notes', 'triage_incident']),
    );
    const me = await mia.readResource({ uri: 'resolvrnow://user/me' });
    expect(JSON.parse((me.contents[0] as { text: string }).text).user_name).toBe('mia.agent');
    const inc = await mia.readResource({ uri: `resolvrnow://incident/${incA.str('number')}` });
    expect(JSON.parse((inc.contents[0] as { text: string }).text).short_description).toBe(
      'Laptop battery drains fast',
    );
  });

  it('can expose dotted compatibility names', async () => {
    p.properties.set('resolvr.mcp.tool_names', 'dotted');
    const names = await toolNames(await connect('mia.agent'));
    p.properties.set('resolvr.mcp.tool_names', 'underscore');
    expect(names).toContain('sn_itsm_mcp_server.incident.get_details');
    expect(names).not.toContain('incident_get_details');
  });
});

describe('MCP over Streamable HTTP', () => {
  let app: FastifyInstance;
  let dir: string;
  let token: string;
  const headers = (t?: string) => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(t ? { authorization: `Bearer ${t}` } : {}),
  });
  const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
  const init = rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-mcp-'));
    const config: ServerConfig = {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      dbFile: ':memory:',
      attachmentDir: join(dir, 'att'),
      publicUrl: 'https://resolvr.test',
      webDir: null,
      demo: false,
      secureCookies: false,
    };
    app = await buildApp(p, config);
    token = new AuthService(p).issueToken(p.users.byUserName('mia.agent')!.sysId!, 'Claude Desktop');
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is disabled by default', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/app/mcp',
      headers: headers(token),
      payload: init,
    });
    expect(r.statusCode).toBe(404);
  });

  it('requires authentication and the MCP role', async () => {
    p.properties.set('resolvr.mcp.enabled', 'true');
    const anon = await app.inject({ method: 'POST', url: '/api/app/mcp', headers: headers(), payload: init });
    expect(anon.statusCode).toBe(401);
    expect(String(anon.headers['www-authenticate'])).toContain('Bearer');
    const noRole = new AuthService(p).issueToken(p.users.byUserName('nora.nomcp')!.sysId!, 'no role');
    expect(
      (await app.inject({ method: 'POST', url: '/api/app/mcp', headers: headers(noRole), payload: init }))
        .statusCode,
    ).toBe(403);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/app/mcp',
      headers: { ...headers(token), origin: 'https://evil.example' },
      payload: init,
    });
    expect(evil.statusCode).toBe(403);
  });

  it('answers initialize, tools/list and tools/call with a bearer token', async () => {
    p.properties.set('resolvr.mcp.enabled', 'true');
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/app/mcp',
      headers: headers(token),
      payload: init,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().result.serverInfo.name).toBe('resolvrnow');
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/app/mcp',
      headers: { ...headers(token), 'mcp-protocol-version': '2025-06-18' },
      payload: rpc(2, 'tools/list'),
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().result.tools.map((t: { name: string }) => t.name)).toContain('incident_get_details');
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/app/mcp',
      headers: { ...headers(token), 'mcp-protocol-version': '2025-06-18' },
      payload: rpc(3, 'tools/call', {
        name: 'incident_get_details',
        arguments: { number: incB.str('number') },
      }),
    });
    const result = r3.json().result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.short_description).toBe('Cannot open the finance share');
    expect(result.structuredContent.link).toBe(
      `https://resolvr.test/workspace/record/incident/${incB.sysId}`,
    );
    const log = sys.first('resolvr_mcp_call_log', 'transport=http^tool=incident_get_details')!;
    expect(log.str('outcome')).toBe('ok');
    const get = await app.inject({ method: 'GET', url: '/api/app/mcp', headers: headers(token) });
    expect(get.statusCode).toBe(405);
  });

  it('lets users with the MCP role create their own token', async () => {
    const basic = (u: string) => `Basic ${Buffer.from(`${u}:Password1!`).toString('base64')}`;
    const r = await app.inject({
      method: 'POST',
      url: '/api/app/mcp/tokens',
      headers: { authorization: basic('rex.requester'), 'content-type': 'application/json' },
      payload: { name: 'My assistant' },
    });
    expect(r.statusCode).toBe(201);
    const { token: mine, sys_id } = r.json().result;
    expect(mine).toMatch(/^resolvr_/);
    expect(sys.get('sys_api_token', sys_id)!.str('name')).toBe('My assistant');
    const list = await app.inject({
      method: 'POST',
      url: '/api/app/mcp',
      headers: { ...headers(mine), 'mcp-protocol-version': '2025-06-18' },
      payload: rpc(9, 'tools/list'),
    });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toContain('requester_check_status');
    const viaToken = await app.inject({
      method: 'POST',
      url: '/api/app/mcp/tokens',
      headers: { authorization: `Bearer ${mine}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(viaToken.statusCode).toBe(403);
    const noRole = await app.inject({
      method: 'POST',
      url: '/api/app/mcp/tokens',
      headers: { authorization: basic('nora.nomcp'), 'content-type': 'application/json' },
      payload: {},
    });
    expect(noRole.statusCode).toBe(403);
  });
});
