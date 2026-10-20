import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import type { Platform } from '../src/engine/platform.js';
import { aiFixturesModule } from '../src/modules/ai/fixtures.js';
import { aiModule } from '../src/modules/ai/index.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let sys: Context;
let app: FastifyInstance;
let dir: string;
const basic = (u: string, pw = 'Password1!') => `Basic ${Buffer.from(`${u}:${pw}`).toString('base64')}`;
const ADMIN = `Basic ${Buffer.from('admin:admin-test-pw').toString('base64')}`;
const AGENT = basic('alex.agent');
const EMPLOYEE = basic('erin.employee');
const json = { 'content-type': 'application/json' };

const vpnIncidents = [
  'VPN tunnel disconnects for remote users',
  'Remote users lose the VPN connection every hour',
  'VPN disconnects during video calls',
  'VPN connection drops for remote staff',
];
const printerIncidents = [
  'Printer on floor 2 has a paper jam',
  'Paper jam in the floor 2 printer',
  'Floor 2 printer jammed again',
  'Printer paper jam on second floor',
];

beforeAll(async () => {
  p = bootPlatform([aiModule, aiFixturesModule]);
  sys = p.systemContext();
  dir = mkdtempSync(join(tmpdir(), 'resolvrnow-ai-'));
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
  makeUser(p, 'alex.agent', ['itil']);
  const erin = makeUser(p, 'erin.employee', []);
  const network = sys.insert('sys_user_group', { name: 'Network' }).sysId;
  const hardware = sys.insert('sys_user_group', { name: 'Hardware' }).sysId;
  for (let round = 0; round < 3; round++) {
    for (const sd of vpnIncidents)
      sys.insert('incident', {
        short_description: `${sd} (${round})`,
        category: 'network',
        assignment_group: network,
        state: '6',
      });
    for (const sd of printerIncidents)
      sys.insert('incident', {
        short_description: `${sd} (${round})`,
        category: 'hardware',
        assignment_group: hardware,
        state: '6',
      });
  }
  for (const sd of [...vpnIncidents, ...printerIncidents])
    sys.insert('incident', { short_description: sd, caller_id: erin, state: '2' });
  const kb = sys.insert('kb_knowledge_base', { title: 'IT' }).sysId;
  sys.insert('kb_knowledge', {
    kb_knowledge_base: kb,
    short_description: 'Troubleshoot VPN disconnects',
    text: '<p>Update the VPN client and use a wired connection when the VPN keeps disconnecting.</p>',
    workflow_state: 'published',
  });
});

afterAll(async () => {
  await app.close();
  p.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AI API', () => {
  it('reports the provider status and enabled skills', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/app/ai/status',
      headers: { authorization: AGENT },
    });
    expect(r.statusCode).toBe(200);
    const s = r.json().result;
    expect(s.provider).toBe('offline');
    expect(s.llm_available).toBe(false);
    expect(s.configured_provider).toBe('anthropic');
    expect(s.enabled_skills).toEqual(
      expect.arrayContaining([
        'incident_summarization',
        'resolution_notes_generation',
        'change_summarization',
        'search_qa',
      ]),
    );
    expect(s.enabled_skills).not.toContain('email_response_generation');
    expect(s.mcp).toMatchObject({ enabled: false, path: '/api/app/mcp' });
    expect((await app.inject({ method: 'GET', url: '/api/app/ai/status' })).statusCode).toBe(401);
  });

  it('runs skills over HTTP with platform-style errors', async () => {
    const inc = sys.first('incident', `short_description=${vpnIncidents[0]}`)!;
    const r = await app.inject({
      method: 'POST',
      url: '/api/app/ai/skills/incident_summarization',
      headers: { authorization: AGENT, ...json },
      payload: { table: 'incident', sys_id: inc.sysId },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res).toMatchObject({ provider: 'offline', model: 'offline', skill: 'incident_summarization' });
    expect(res.text).toMatch(/^Issue\nVPN tunnel disconnects for remote users/);
    expect(res.sources[0]).toMatchObject({ table: 'incident', sys_id: inc.sysId });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/app/ai/skills/nope',
      headers: { authorization: AGENT, ...json },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    const inactive = await app.inject({
      method: 'POST',
      url: '/api/app/ai/skills/email_response_generation',
      headers: { authorization: AGENT, ...json },
      payload: { table: 'incident', sys_id: inc.sysId },
    });
    expect(inactive.statusCode).toBe(403);
    const thin = await app.inject({
      method: 'POST',
      url: '/api/app/ai/skills/resolution_notes_generation',
      headers: { authorization: AGENT, ...json },
      payload: { table: 'incident', sys_id: inc.sysId },
    });
    expect(thin.statusCode).toBe(422);
    expect(thin.json().error).toMatchObject({ detail: 'insufficient_activity' });
    const employee = await app.inject({
      method: 'POST',
      url: '/api/app/ai/skills/search_qa',
      headers: { authorization: EMPLOYEE, ...json },
      payload: { question: 'my vpn keeps disconnecting' },
    });
    expect(employee.statusCode).toBe(200);
    expect(employee.json().result.sources[0].title).toBe('Troubleshoot VPN disconnects');
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/app/ai/skills/incident_summarization',
      headers: { authorization: EMPLOYEE, ...json },
      payload: { table: 'incident', sys_id: inc.sysId },
    });
    expect(forbidden.statusCode).toBe(403);
    const logId = res.log_id;
    const fb = await app.inject({
      method: 'POST',
      url: `/api/app/ai/feedback/${logId}`,
      headers: { authorization: AGENT, ...json },
      payload: { feedback: 'helpful', shared: true },
    });
    expect(fb.json().result).toMatchObject({ feedback: 'helpful', shared: true });
    const share = await app.inject({
      method: 'POST',
      url: `/api/app/ai/feedback/${logId}/share`,
      headers: { authorization: AGENT, ...json },
      payload: { text: `${res.text}\nChecked by Alex.` },
    });
    expect(share.statusCode).toBe(200);
    const notes = p.history.journal('incident', inc.sysId, ['work_notes']);
    expect(notes).toHaveLength(1);
    expect(notes[0].value).toMatch(/Checked by Alex\.$/);
    const shared = sys.get('sys_generative_ai_log', logId)!;
    expect(shared.bool('shared')).toBe(true);
    expect(shared.num('edit_distance')).toBe('\nChecked by Alex.'.length);
    const notMine = await app.inject({
      method: 'POST',
      url: `/api/app/ai/feedback/${logId}`,
      headers: { authorization: EMPLOYEE, ...json },
      payload: { feedback: 'not_helpful' },
    });
    expect(notMine.statusCode).toBe(404);
  });

  it('trains a solution (ai_admin only) and predicts on insert', async () => {
    const def = sys.insert('ml_solution_definition', {
      label: 'API categorization',
      table: 'incident',
      output_field: 'category',
      input_fields: 'short_description',
      filter: 'state=6',
      confidence_threshold: 50,
      target_precision: 0,
      prediction_preference: 'autofill',
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/app/ai/solutions/${def.sysId}/train`,
      headers: { authorization: AGENT },
    });
    expect(denied.statusCode).toBe(403);
    const r = await app.inject({
      method: 'POST',
      url: `/api/app/ai/solutions/${def.sysId}/train`,
      headers: { authorization: ADMIN },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res.state).toBe('solution_complete');
    expect(res.trainingRecords).toBe(24);
    expect(res.precision).toBeGreaterThanOrEqual(85);
    const created = await app.inject({
      method: 'POST',
      url: '/api/now/table/incident',
      headers: { authorization: AGENT, ...json },
      payload: { short_description: 'The VPN tunnel disconnects for remote users again' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().result.category).toBe('network');
    const small = sys.insert('ml_solution_definition', {
      label: 'Too few',
      table: 'incident',
      output_field: 'category',
      filter: 'short_descriptionLIKEzzz',
    });
    const fail = await app.inject({
      method: 'POST',
      url: `/api/app/ai/solutions/${small.sysId}/train`,
      headers: { authorization: ADMIN },
    });
    expect(fail.statusCode).toBe(422);
    expect(fail.json().result.errorCode).toBe('insufficient_records');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/app/ai/solutions/0123456789abcdef0123456789abcdef/train',
          headers: { authorization: ADMIN },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('returns similar records for a record', async () => {
    const inc = sys.first('incident', `short_description=${vpnIncidents[1]}`)!;
    const r = await app.inject({
      method: 'GET',
      url: `/api/app/ai/similar/incident/${inc.sysId}?targets=incident,kb_knowledge&limit=3`,
      headers: { authorization: AGENT },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res.targets.incident).toHaveLength(3);
    for (const h of res.targets.incident) expect(h.title).toMatch(/VPN/i);
    expect(res.targets.kb_knowledge[0].title).toBe('Troubleshoot VPN disconnects');
    const bad = await app.inject({
      method: 'GET',
      url: '/api/app/ai/similar/nope/0123456789abcdef0123456789abcdef',
      headers: { authorization: AGENT },
    });
    expect(bad.statusCode).toBe(400);
    const other = await app.inject({
      method: 'GET',
      url: `/api/app/ai/similar/incident/${sys.first('incident', 'state=6')!.sysId}`,
      headers: { authorization: EMPLOYEE },
    });
    expect(other.statusCode).toBe(404);
  });

  it('returns recommendations: predictions, similar records and knowledge', async () => {
    const inc = sys.insert('incident', {
      short_description: 'Printer on floor 2 is jammed with paper',
      category: 'inquiry',
    });
    const r = await app.inject({
      method: 'GET',
      url: `/api/app/ai/recommendations/incident/${inc.sysId}`,
      headers: { authorization: AGENT },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    const cat = res.predictions.find((x: { field: string }) => x.field === 'category');
    expect(cat).toMatchObject({ value: 'hardware', current_value: 'inquiry' });
    expect(cat.candidates.length).toBeGreaterThan(0);
    expect(res.similar_records.length).toBeGreaterThan(0);
    expect(res.similar_records[0].title).toMatch(/printer|paper/i);
    expect(Array.isArray(res.knowledge)).toBe(true);
    const k = await app.inject({
      method: 'GET',
      url: '/api/app/ai/knowledge?text=vpn%20disconnects',
      headers: { authorization: EMPLOYEE },
    });
    expect(k.json().result[0].title).toBe('Troubleshoot VPN disconnects');
    const predict = await app.inject({
      method: 'POST',
      url: '/api/app/ai/predict',
      headers: { authorization: AGENT, ...json },
      payload: { table: 'incident', values: { short_description: 'VPN connection drops every hour' } },
    });
    expect(predict.json().result[0]).toMatchObject({ field: 'category', value: 'network' });
  });

  it('clusters open incidents into problem candidates', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/app/ai/clusters?table=incident&min_size=3',
      headers: { authorization: AGENT },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    const candidates = res.clusters.filter((c: { problem_candidate: boolean }) => c.problem_candidate);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].members.length).toBeGreaterThanOrEqual(3);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/app/ai/clusters?table=incident',
          headers: { authorization: EMPLOYEE },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('talks through the virtual agent endpoint', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/app/va/message',
      headers: { authorization: EMPLOYEE, ...json },
      payload: { text: 'hi' },
    });
    expect(r1.statusCode).toBe(200);
    const c = r1.json().result;
    expect(c.messages[0].quickReplies.length).toBe(5);
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/app/va/message',
      headers: { authorization: EMPLOYEE, ...json },
      payload: { conversationId: c.conversationId, text: 'show my open tickets' },
    });
    expect(r2.json().result.messages[0].items.length).toBeGreaterThanOrEqual(8);
    const hist = await app.inject({
      method: 'GET',
      url: `/api/app/va/conversations/${c.conversationId}`,
      headers: { authorization: EMPLOYEE },
    });
    expect(hist.json().result.messages.length).toBeGreaterThanOrEqual(4);
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/app/va/conversations/${c.conversationId}`,
      headers: { authorization: AGENT },
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('adds the AI & Automation navigation for administrators', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/app/navigation',
      headers: { authorization: ADMIN },
    });
    const nav = r.json().result.find((a: { id: string }) => a.id === 'ai_automation');
    expect(nav.title).toBe('AI & Automation');
    expect(nav.modules.map((m: { table?: string }) => m.table)).toEqual(
      expect.arrayContaining([
        'ml_solution_definition',
        'ml_predictor_results',
        'sys_generative_ai_log',
        'resolvr_va_conversation',
        'sys_api_token',
      ]),
    );
    const agentNav = (
      await app.inject({ method: 'GET', url: '/api/app/navigation', headers: { authorization: AGENT } })
    )
      .json()
      .result.find((a: { id: string }) => a.id === 'ai_automation');
    expect(agentNav.modules.map((m: { title: string }) => m.title)).toEqual(['Prediction Results']);
  });

  it('runs the Train UI action', async () => {
    const def = sys.first('ml_solution_definition', 'name=ml_api_categorization')!;
    const r = await app.inject({
      method: 'POST',
      url: `/api/app/action/ml_solution_definition/${def.sysId}/ai.ml.train`,
      headers: { authorization: ADMIN, ...json },
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.message).toMatch(/^Trained ml_api_categorization v2 on 24 records/);
  });
});
