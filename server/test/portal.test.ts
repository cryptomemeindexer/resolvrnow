import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import type { ColumnDef } from '../src/engine/types.js';
import { addMs, clock, nowGlide } from '../src/engine/util.js';
import { AR, EN } from '../src/modules/portal/i18n.js';
import { portalModule } from '../src/modules/portal/index.js';
import { routeUniversalRequest } from '../src/modules/portal/ur.js';
import { bootPlatform, makeUser } from './helpers.js';

// ---------------------------------------------------------------- harness

const PASSWORD = 'Password1!';
const auth = (user: string) =>
  user === 'admin'
    ? `Basic ${Buffer.from('admin:admin-test-pw').toString('base64')}`
    : `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}`;
const DAY = 86_400_000;

type Method = 'GET' | 'POST' | 'DELETE';
interface Harness {
  p: Platform;
  app: FastifyInstance;
  call: (
    user: string | null,
    method: Method,
    url: string,
    payload?: unknown,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

async function harness(modules: AppModule[]): Promise<Harness> {
  const p = bootPlatform(modules);
  const dir = mkdtempSync(join(tmpdir(), 'resolvrnow-portal-'));
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
  const app = await buildApp(p, config);
  const call: Harness['call'] = (user, method, url, payload) =>
    app.inject({
      method,
      url,
      headers: {
        ...(user ? { authorization: auth(user) } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  return {
    p,
    app,
    call,
    close: async () => {
      await app.close();
      p.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Stand-ins for catalog, knowledge, approvals and a department table, so the portal is tested on its own.
const s = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  maxLength: 255,
  ...extra,
});
const r = (name: string, label: string, reference: string): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
});
const b = (name: string, label: string, value: boolean): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: value ? 'true' : 'false',
});
const n = (name: string, label: string): ColumnDef => ({ name, label, type: 'integer' });

const stubs: AppModule = {
  id: 'portal_test_stubs',
  name: 'Portal test stand-ins',
  dependsOn: ['task'],
  tables: [
    {
      name: 'sc_cat_item',
      label: 'Catalog Item',
      displayField: 'name',
      columns: [
        s('name', 'Name'),
        s('short_description', 'Short description'),
        b('active', 'Active', true),
        b('hide_sp', 'Hide on portal', false),
        b('no_search', 'No search', false),
        r('taxonomy_topic', 'Taxonomy topic', 'topic'),
        { name: 'price', label: 'Price', type: 'price' },
        n('order', 'Order'),
      ],
    },
    {
      name: 'kb_knowledge_base',
      label: 'Knowledge Base',
      displayField: 'title',
      columns: [s('title', 'Title'), b('active', 'Active', true)],
    },
    {
      name: 'kb_knowledge',
      label: 'Knowledge',
      number: { prefix: 'KB', start: 10000 },
      columns: [
        s('number', 'Number'),
        s('short_description', 'Title'),
        { name: 'text', label: 'Text', type: 'html' },
        s('workflow_state', 'Workflow', { defaultValue: 'draft' }),
        b('active', 'Active', true),
        r('kb_knowledge_base', 'Knowledge base', 'kb_knowledge_base'),
        s('article_type', 'Article type', {
          choices: [
            { value: 'text', label: 'Text' },
            { value: 'html', label: 'HTML' },
          ],
        }),
        n('sys_view_count', 'Views'),
        r('taxonomy_topic', 'Taxonomy topic', 'topic'),
      ],
    },
    {
      name: 'resolvr_test_case',
      label: 'Test Case',
      extends: 'task',
      number: { prefix: 'TCASE', start: 1000 },
      columns: [r('requested_for', 'Requested for', 'sys_user')],
    },
    {
      name: 'sc_request',
      label: 'Request',
      extends: 'task',
      number: { prefix: 'REQ', start: 10000 },
      columns: [r('requested_for', 'Requested for', 'sys_user')],
    },
    {
      name: 'sc_req_item',
      label: 'Requested Item',
      extends: 'task',
      number: { prefix: 'RITM', start: 10000 },
      columns: [
        r('request', 'Request', 'sc_request'),
        r('cat_item', 'Item', 'sc_cat_item'),
        r('requested_for', 'Requested for', 'sys_user'),
        s('stage', 'Stage', {
          defaultValue: 'waiting_for_approval',
          choices: [
            { value: 'waiting_for_approval', label: 'Waiting for Approval' },
            { value: 'fulfillment', label: 'Fulfillment' },
            { value: 'complete', label: 'Completed' },
            { value: 'Request Cancelled', label: 'Request Cancelled' },
          ],
        }),
      ],
    },
    {
      name: 'sc_task',
      label: 'Catalog Task',
      extends: 'task',
      number: { prefix: 'SCTASK', start: 10000 },
      columns: [r('request_item', 'Requested item', 'sc_req_item')],
    },
    {
      name: 'item_option_new',
      label: 'Variable',
      displayField: 'name',
      columns: [
        r('cat_item', 'Item', 'sc_cat_item'),
        s('name', 'Name'),
        s('question_text', 'Question'),
        n('type', 'Type'),
        { name: 'reference', label: 'Reference', type: 'table_name' },
        n('order', 'Order'),
      ],
    },
    {
      name: 'question_choice',
      label: 'Question Choice',
      columns: [r('question', 'Question', 'item_option_new'), s('text', 'Text'), s('value', 'Value')],
    },
    {
      name: 'sc_item_option',
      label: 'Option',
      columns: [
        r('item_option_new', 'Question', 'item_option_new'),
        s('value', 'Value'),
        n('order', 'Order'),
      ],
    },
    {
      name: 'sc_item_option_mtom',
      label: 'Variable Ownership',
      columns: [
        r('request_item', 'Requested item', 'sc_req_item'),
        r('sc_item_option', 'Option', 'sc_item_option'),
      ],
    },
    {
      name: 'sysapproval_approver',
      label: 'Approval',
      columns: [
        r('approver', 'Approver', 'sys_user'),
        s('state', 'State', { defaultValue: 'requested' }),
        r('sysapproval', 'Approval for', 'task'),
        { name: 'comments', label: 'Comments', type: 'journal_input' },
      ],
    },
  ],
  acls: [
    { name: 'sc_cat_item', operation: 'read', roles: ['snc_internal'] },
    ...['sc_request', 'sc_req_item'].flatMap((name) => [
      { name, operation: 'read' as const, roles: ['itil'] },
      { name, operation: 'read' as const, condition: 'requested_for=javascript:gs.getUserID()' },
      { name, operation: 'read' as const, condition: 'opened_by=javascript:gs.getUserID()' },
    ]),
    { name: 'kb_knowledge_base', operation: 'read', roles: ['snc_internal'] },
    {
      name: 'kb_knowledge',
      operation: 'read',
      script: (rec, ctx) =>
        !rec || ctx.hasRole('itil') || rec.ref('kb_knowledge_base')?.str('title') !== 'HR Confidential',
    },
  ],
};

const ids: Record<string, string> = {};

/** Users, taxonomy, catalog items, articles, quick links and announcements. */
function fixtures(p: Platform): void {
  ids.ann = makeUser(p, 'ann.user');
  ids.bob = makeUser(p, 'bob.user');
  ids.abel = makeUser(p, 'abel.agent', ['itil'], ['Service Desk']);
  ids.mia = makeUser(p, 'mia.approver', ['approver_user']);
  const sys = p.systemContext();
  ids.desk = sys.first('sys_user_group', 'name=Service Desk')!.sysId;
  const dept = sys.first('sn_uni_req_department', 'name=IT')!;
  sys.update(dept, { assignment_group: ids.desk });
  ids.dept = dept.sysId;
  ids.caseService = sys.insert('sn_uni_req_service', {
    name: 'Test cases',
    department: dept.sysId,
    table_name: 'resolvr_test_case',
  }).sysId;
  ids.missingService = sys.insert('sn_uni_req_service', {
    name: 'Not installed',
    department: dept.sysId,
    table_name: 'incident',
  }).sysId;
  const tax = sys.insert('taxonomy', { name: 'Employee', order: 10 });
  ids.it = sys.insert('topic', {
    name: 'IT',
    taxonomy: tax.sysId,
    order: 10,
    icon: 'monitor',
    resolvr_ur_service: ids.caseService,
  }).sysId;
  ids.hardware = sys.insert('topic', {
    name: 'Hardware',
    taxonomy: tax.sysId,
    parent_topic: ids.it,
    order: 10,
    icon: 'laptop',
    resolvr_featured: true,
  }).sysId;
  ids.laptops = sys.insert('topic', {
    name: 'Laptops',
    taxonomy: tax.sysId,
    parent_topic: ids.hardware,
    order: 10,
  }).sysId;
  ids.network = sys.insert('topic', {
    name: 'Network',
    taxonomy: tax.sysId,
    parent_topic: ids.it,
    order: 20,
    icon: 'wifi',
  }).sysId;
  ids.hr = sys.insert('topic', {
    name: 'HR',
    taxonomy: tax.sysId,
    order: 20,
    resolvr_ur_service: ids.missingService,
  }).sysId;
  ids.retired = sys.insert('topic', {
    name: 'Retired topic',
    taxonomy: tax.sysId,
    parent_topic: ids.it,
    active: false,
  }).sysId;
  ids.orphan = sys.insert('topic', {
    name: 'Under a retired topic',
    taxonomy: tax.sysId,
    parent_topic: ids.retired,
  }).sysId;

  ids.laptop = sys.insert('sc_cat_item', {
    name: 'Standard Laptop',
    short_description: 'A 14 inch laptop for everyday work',
    price: 1200,
  }).sysId;
  ids.vpnItem = sys.insert('sc_cat_item', {
    name: 'VPN Access',
    short_description: 'Remote access to the office network',
    taxonomy_topic: ids.network,
  }).sysId;
  ids.pager = sys.insert('sc_cat_item', {
    name: 'Old Pager',
    short_description: 'Retired device',
    active: false,
  }).sysId;
  sys.insert('sc_cat_item', { name: 'Hidden Tool', short_description: 'Not on the portal', hide_sp: true });
  sys.insert('m2m_connected_content', {
    topic: ids.hardware,
    content_type: 'catalog',
    catalog_item: ids.laptop,
  });
  ids.colorVar = sys.insert('item_option_new', {
    cat_item: ids.laptop,
    name: 'color',
    question_text: 'Color',
    type: 5,
    order: 10,
  }).sysId;
  sys.insert('question_choice', { question: ids.colorVar, text: 'Silver', value: 'silver' });
  ids.managerVar = sys.insert('item_option_new', {
    cat_item: ids.laptop,
    name: 'manager',
    question_text: 'Manager',
    type: 8,
    reference: 'sys_user',
    order: 20,
  }).sysId;
  ids.labelVar = sys.insert('item_option_new', {
    cat_item: ids.laptop,
    name: 'note',
    question_text: 'Please read',
    type: 11,
    order: 5,
  }).sysId;

  ids.itKb = sys.insert('kb_knowledge_base', { title: 'IT Knowledge' }).sysId;
  ids.hrKb = sys.insert('kb_knowledge_base', { title: 'HR Confidential' }).sysId;
  const article = (values: Record<string, unknown>) =>
    sys.insert('kb_knowledge', {
      kb_knowledge_base: ids.itKb,
      article_type: 'text',
      workflow_state: 'published',
      ...values,
    }).sysId;
  ids.vpnArticle = article({
    short_description: 'Reconnect the VPN client',
    text: '<p>Open the VPN client and sign in again.</p>',
    sys_view_count: 50,
  });
  ids.vpnGuide = article({
    short_description: 'VPN troubleshooting guide',
    text: '<p>Steps to fix connection errors.</p>',
    article_type: 'html',
    sys_view_count: 10,
    taxonomy_topic: ids.network,
  });
  article({ short_description: 'VPN draft notes', workflow_state: 'draft' });
  ids.hrArticle = article({ short_description: 'VPN salary policy', kb_knowledge_base: ids.hrKb });
  ids.batteryArticle = article({ short_description: 'Laptop battery tips', sys_view_count: 5 });
  sys.insert('m2m_connected_content', {
    topic: ids.network,
    content_type: 'knowledge',
    knowledge: ids.vpnArticle,
  });
  sys.insert('m2m_connected_content', {
    topic: ids.hardware,
    content_type: 'knowledge',
    knowledge: ids.batteryArticle,
  });

  ids.reportLink = sys.insert('sn_ex_sp_quick_link', {
    name: 'Report an issue',
    content_type: 'page',
    page: 'report_issue',
    show_on_home: true,
    order: 10,
  }).sysId;
  ids.wifiLink = sys.insert('sn_ex_sp_quick_link', {
    name: 'Wi-Fi status page',
    content_type: 'url',
    url: 'https://status.example.com',
    order: 20,
  }).sysId;
  sys.insert('m2m_connected_content', {
    topic: ids.network,
    content_type: 'quick_link',
    quick_link: ids.wifiLink,
  });

  const now = nowGlide();
  ids.notice = sys.insert('resolvr_announcement', {
    title: 'Planned maintenance',
    summary: 'Email is down on Saturday',
    display_from: addMs(now, -DAY),
    display_to: addMs(now, DAY),
  }).sysId;
  sys.insert('resolvr_announcement', {
    title: 'Old notice',
    display_from: addMs(now, -3 * DAY),
    display_to: addMs(now, -2 * DAY),
  });
}

/** A plain task opened by a user (created by the system, like an import). */
function openedTask(p: Platform, user: string, values: Record<string, unknown> = {}) {
  return p
    .systemContext()
    .insert('task', { short_description: 'Desk lamp flickers', opened_by: ids[user], ...values });
}

const reload = (p: Platform, table: string, id: string) => p.systemContext().get(table, id)!;
const journal = (p: Platform, table: string, id: string, field?: string) =>
  p.history
    .journal(table, id, field ? [field] : undefined)
    .map((j) => `${j.element}:${j.value}:${j.sys_created_by}`);

// ---------------------------------------------------------------- module and boot

describe('portal module', () => {
  it('boots alone on top of task and seeds its reference data', () => {
    expect(portalModule.dependsOn).toEqual(['task']);
    const p = bootPlatform([portalModule]);
    try {
      for (const t of [
        'universal_request',
        'topic',
        'taxonomy',
        'm2m_connected_content',
        'sn_ex_sp_quick_link',
        'sp_favorite',
        'resolvr_announcement',
        'asmt_assessment_instance',
      ]) {
        expect(p.registry.has(t)).toBe(true);
      }
      expect(p.registry.table('universal_request').ancestors).toEqual(['universal_request', 'task']);
      const sys = p.systemContext();
      expect(sys.count('universal_request_state_mapping')).toBe(12);
      const survey = sys.first('asmt_metric_type', 'name=Request satisfaction')!;
      expect(sys.count('asmt_metric', `metric_type=${survey.sysId}`)).toBe(3);
      expect(
        sys
          .query('asmt_condition')
          .map((c) => c.str('table'))
          .sort(),
      ).toEqual(['incident', 'sc_req_item', 'universal_request']);
      expect(p.choices.list('universal_request', 'state').map((c) => c.label)).toEqual([
        'New',
        'In Progress',
        'Awaiting',
        'Closed',
        'Canceled',
      ]);
      expect([...p.uiActions.keys()].filter((k) => k.startsWith('universal_request.'))).toEqual([
        'universal_request.route_incident',
        'universal_request.route_request',
        'universal_request.close',
      ]);
    } finally {
      p.close();
    }
  });
});

// ---------------------------------------------------------------- main suite (portal + stand-ins)

describe('portal APIs', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness([portalModule, stubs]);
    fixtures(h.p);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => clock.reset());

  const newRequest = async (user: string, payload: Record<string, unknown>) => {
    const res = await h.call(user, 'POST', '/api/app/portal/requests', payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().result as {
      sys_id: string;
      number: string;
      routed: boolean;
      state: { badge: string };
      message: string;
    };
  };

  describe('universal requests', () => {
    it('creates a request and routes it to the department table of its topic', async () => {
      const ur = await newRequest('ann.user', {
        description: 'Laptop fan is loud\nThe fan runs at full speed all day.',
        topic: ids.laptops,
      });
      expect(ur.number).toMatch(/^UR\d{7}$/);
      expect(ur.routed).toBe(true);
      expect(ur.state.badge).toBe('in_progress');
      expect(ur.message).toBe(`Request ${ur.number} submitted`);
      const rec = reload(h.p, 'universal_request', ur.sys_id);
      expect(rec.str('short_description')).toBe('Laptop fan is loud');
      expect(rec.str('opened_for')).toBe(ids.ann);
      expect(rec.str('opened_by')).toBe(ids.ann);
      expect(rec.str('department')).toBe(ids.dept);
      expect(rec.str('service')).toBe(ids.caseService);
      expect(rec.str('resolvr_topic')).toBe(ids.laptops);
      expect(rec.str('state')).toBe('2');
      const primary = reload(h.p, 'task', rec.str('primary_task'));
      expect(primary.className).toBe('resolvr_test_case');
      expect(primary.str('number')).toMatch(/^TCASE/);
      expect(primary.str('requested_for')).toBe(ids.ann);
      expect(primary.str('opened_by')).toBe(ids.ann);
      expect(primary.str('universal_request')).toBe(rec.sysId);
      expect(primary.str('assignment_group')).toBe(ids.desk);
      expect(primary.str('description')).toContain('full speed');
    });

    it('keeps a request unrouted for triage when no installed table serves its topic', async () => {
      const noTable = await newRequest('ann.user', {
        description: 'Question about parental leave',
        topic: ids.hr,
      });
      expect(noTable.routed).toBe(false);
      expect(noTable.state.badge).toBe('submitted');
      const rec = reload(h.p, 'universal_request', noTable.sys_id);
      expect(rec.str('state')).toBe('1');
      expect(rec.str('state_reason')).toBe('routing');
      expect(rec.str('primary_task')).toBe('');
      expect(rec.str('service')).toBe(ids.missingService);
      const noTopic = await newRequest('ann.user', { description: 'Something else entirely' });
      expect(noTopic.routed).toBe(false);
    });

    it('validates submissions', async () => {
      expect(
        (await h.call('ann.user', 'POST', '/api/app/portal/requests', { description: '   ' })).statusCode,
      ).toBe(400);
      expect(
        (
          await h.call('ann.user', 'POST', '/api/app/portal/requests', {
            description: 'x',
            topic: ids.retired,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await h.call('ann.user', 'POST', '/api/app/portal/requests', {
            description: 'For Bob',
            opened_for: ids.bob,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await h.call(null, 'POST', '/api/app/portal/requests', { description: 'anonymous' })).statusCode,
      ).toBe(401);
      const onBehalf = await newRequest('abel.agent', {
        description: 'Raised for Bob by phone',
        opened_for: ids.bob,
      });
      const rec = reload(h.p, 'universal_request', onBehalf.sys_id);
      expect(rec.str('opened_for')).toBe(ids.bob);
      expect(rec.str('opened_by')).toBe(ids.abel);
    });

    it('lets an agent route or close an unrouted request', async () => {
      const ur = await newRequest('bob.user', { description: 'Badge does not open the door' });
      const form = await h.call('abel.agent', 'GET', `/api/app/record/universal_request/${ur.sys_id}`);
      const actions = (form.json().result.actions as { id: string }[]).map((a) => a.id);
      expect(actions).toContain('universal_request.close');
      expect(actions).not.toContain('universal_request.route_incident'); // incident is not installed here
      const agent = h.p.contextAs('abel.agent');
      const primary = routeUniversalRequest(
        agent,
        reload(h.p, 'universal_request', ur.sys_id),
        'resolvr_test_case',
      );
      const rec = reload(h.p, 'universal_request', ur.sys_id);
      expect(rec.str('primary_task')).toBe(primary.sysId);
      expect(rec.str('state')).toBe('2');
      expect(rec.str('state_reason')).toBe('');
      expect(() => routeUniversalRequest(agent, rec, 'resolvr_test_case')).toThrow(/already routed/);

      const other = await newRequest('bob.user', { description: 'Where do I find the holiday calendar?' });
      const noComment = await h.call(
        'abel.agent',
        'POST',
        `/api/app/action/universal_request/${other.sys_id}/universal_request.close`,
        { input: {} },
      );
      expect(noComment.statusCode).toBe(400);
      const closed = await h.call(
        'abel.agent',
        'POST',
        `/api/app/action/universal_request/${other.sys_id}/universal_request.close`,
        {
          input: { comments: 'It is on the intranet home page.' },
        },
      );
      expect(closed.statusCode, closed.body).toBe(200);
      expect(reload(h.p, 'universal_request', other.sys_id).str('state')).toBe('4');
      const detail = (
        await h.call('bob.user', 'GET', `/api/app/portal/tickets/universal_request/${other.sys_id}`)
      ).json().result;
      expect(detail.header.state.badge).toBe('closed');
      expect(detail.activity.map((a: { value: string }) => a.value)).toEqual([
        'It is on the intranet home page.',
      ]);
    });

    it('moves the request with the state of its primary ticket', async () => {
      const ur = await newRequest('ann.user', { description: 'Second screen is blank', topic: ids.hardware });
      const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');
      const agent = h.p.contextAs('abel.agent');
      agent.update(agent.get('resolvr_test_case', caseId)!, { state: '2' });
      expect(reload(h.p, 'universal_request', ur.sys_id).str('state')).toBe('2');

      // A mapping row decides over the closed/open fallback.
      h.p.systemContext().insert('universal_request_state_mapping', {
        primary_table: 'resolvr_test_case',
        primary_state: '-5',
        ur_state: '3',
        ur_state_reason: 'user_info',
      });
      agent.update(agent.get('resolvr_test_case', caseId)!, { state: '-5' });
      let rec = reload(h.p, 'universal_request', ur.sys_id);
      expect(rec.str('state')).toBe('3');
      expect(rec.str('state_reason')).toBe('user_info');
      const list = (await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=open')).json().result
        .tickets as { sys_id: string; state: { badge: string } }[];
      expect(list.find((t) => t.sys_id === ur.sys_id)?.state.badge).toBe('action_needed');

      agent.update(agent.get('resolvr_test_case', caseId)!, { state: '3' });
      rec = reload(h.p, 'universal_request', ur.sys_id);
      expect(rec.str('state')).toBe('4');
      expect(rec.bool('active')).toBe(false);
      expect(rec.str('closed_at')).not.toBe('');
    });

    it('waits for the requester to confirm when a resolution review is needed', async () => {
      const ur = await newRequest('ann.user', { description: 'New monitor arm', topic: ids.hardware });
      const sys = h.p.systemContext();
      sys.update(reload(h.p, 'universal_request', ur.sys_id), { needs_resolution_review: true });
      const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');
      sys.update(reload(h.p, 'resolvr_test_case', caseId), { state: '3' });
      let rec = reload(h.p, 'universal_request', ur.sys_id);
      expect(rec.str('state')).toBe('3');
      expect(rec.str('state_reason')).toBe('confirm_response');
      expect(rec.str('confirm_due')).not.toBe('');
      const detail = (
        await h.call('ann.user', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`)
      ).json().result;
      expect(detail.header.state.badge).toBe('action_needed');
      expect(detail.actions.map((a: { name: string }) => a.name)).toEqual(['comment', 'confirm']);
      const res = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/confirm`,
        { comment: 'All good, thanks' },
      );
      expect(res.statusCode, res.body).toBe(200);
      rec = reload(h.p, 'universal_request', ur.sys_id);
      expect(rec.str('state')).toBe('4');
      expect(rec.str('confirm_due')).toBe('');
    });

    it('syncs comments both ways and never exposes work notes', async () => {
      const ur = await newRequest('ann.user', {
        description: 'Docking station not detected',
        topic: ids.hardware,
      });
      const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');
      const posted = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/comment`,
        { comment: 'It started after the update' },
      );
      expect(posted.statusCode, posted.body).toBe(200);
      expect(journal(h.p, 'resolvr_test_case', caseId, 'comments')).toEqual([
        'comments:It started after the update:ann.user',
      ]);

      const agent = h.p.contextAs('abel.agent');
      agent.update(agent.get('resolvr_test_case', caseId)!, {
        comments: 'Please try another USB-C port',
        work_notes: 'Firmware 2.1 is known to be broken',
      });
      expect(journal(h.p, 'universal_request', ur.sys_id, 'comments')).toEqual([
        'comments:Please try another USB-C port:abel.agent',
        'comments:It started after the update:ann.user',
      ]);
      expect(journal(h.p, 'universal_request', ur.sys_id, 'work_notes')).toEqual([]);

      const res = await h.call('ann.user', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('Firmware 2.1');
      const activity = res.json().result.activity as { value: string; created_by: string; is_me: boolean }[];
      expect(activity.map((a) => a.value)).toEqual([
        'Please try another USB-C port',
        'It started after the update',
      ]);
      expect(activity.map((a) => a.is_me)).toEqual([false, true]);
      // The agent's view of the department record also hides work notes on the portal.
      const agentView = await h.call(
        'abel.agent',
        'GET',
        `/api/app/portal/tickets/resolvr_test_case/${caseId}`,
      );
      expect(agentView.statusCode).toBe(200);
      expect(agentView.body).not.toContain('Firmware 2.1');
    });

    it('cancels a request that has not been routed', async () => {
      const ur = await newRequest('ann.user', { description: 'Never mind, found it' });
      const bad = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/reopen`,
        {},
      );
      expect(bad.statusCode).toBe(403);
      expect(
        (
          await h.call(
            'bob.user',
            'POST',
            `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/cancel`,
            {},
          )
        ).statusCode,
      ).toBe(404);
      const res = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/cancel`,
        { comment: 'Solved it myself' },
      );
      expect(res.statusCode, res.body).toBe(200);
      const ticket = res.json().result.ticket;
      expect(ticket.header.state.badge).toBe('cancelled');
      expect(ticket.timeline.map((s: { key: string; status: string }) => `${s.key}:${s.status}`)).toEqual([
        'submitted:done',
        'cancelled:cancelled',
      ]);
      expect(ticket.actions).toEqual([]);
      expect(
        (
          await h.call('ann.user', 'POST', `/api/app/portal/tickets/universal_request/${ur.sys_id}/comment`, {
            comment: 'late',
          })
        ).statusCode,
      ).toBe(400);
    });

    it('accepts attachments with a request and serves them to the requester only', async () => {
      const ur = await newRequest('ann.user', {
        description: 'Error dialog when printing',
        attachments: [
          {
            file_name: 'error.txt',
            content_type: 'text/plain',
            data: Buffer.from('paper jam 42').toString('base64'),
          },
        ],
      });
      const detail = (
        await h.call('ann.user', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`)
      ).json().result;
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments[0]).toMatchObject({
        file_name: 'error.txt',
        content_type: 'text/plain',
        size_bytes: 12,
      });
      const file = await h.call('ann.user', 'GET', detail.attachments[0].download_url);
      expect(file.statusCode).toBe(200);
      expect(file.body).toBe('paper jam 42');
      expect((await h.call('bob.user', 'GET', detail.attachments[0].download_url)).statusCode).toBe(404);
      const more = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/attachments`,
        {
          file_name: 'photo.png',
          content_type: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
      );
      expect(more.statusCode, more.body).toBe(201);
      const bad = await h.call('ann.user', 'POST', '/api/app/portal/requests', {
        description: 'x',
        attachments: [{ file_name: 'empty.txt', data: '' }],
      });
      expect(bad.statusCode).toBe(400);

      // Files staged on the user's own record before submitting are moved onto the request.
      const staged = await h.app.inject({
        method: 'POST',
        url: `/api/now/attachment/file?table_name=sys_user&table_sys_id=${ids.ann}&file_name=screenshot.png`,
        headers: { authorization: auth('ann.user'), 'content-type': 'image/png' },
        payload: Buffer.from('pixels'),
      });
      expect(staged.statusCode, staged.body).toBe(201);
      const stagedId = staged.json().result.sys_id;
      const stolen = await h.call('bob.user', 'POST', '/api/app/portal/requests', {
        description: 'x',
        attachments: [stagedId],
      });
      expect(stolen.statusCode).toBe(400);
      const withStaged = await newRequest('ann.user', {
        description: 'Screen glitch',
        attachments: [stagedId],
      });
      const files = (
        await h.call('ann.user', 'GET', `/api/app/portal/tickets/universal_request/${withStaged.sys_id}`)
      ).json().result.attachments;
      expect(files.map((f: { file_name: string }) => f.file_name)).toEqual(['screenshot.png']);
      expect((await h.call('ann.user', 'GET', files[0].download_url)).body).toBe('pixels');
      const again = await h.call('ann.user', 'POST', '/api/app/portal/requests', {
        description: 'y',
        attachments: [stagedId],
      });
      expect(again.statusCode).toBe(400);
    });
  });

  describe('my tickets and the ticket page', () => {
    it('lists everything the user requested, replacing department records by their request', async () => {
      const own = openedTask(h.p, 'ann', { short_description: 'Desk lamp flickers' });
      const closedOwn = openedTask(h.p, 'ann', { short_description: 'Chair is broken' });
      h.p.systemContext().update(closedOwn, { state: '3' });
      const others = openedTask(h.p, 'bob', { short_description: 'Bob only' });
      const ur = await newRequest('ann.user', { description: 'Keyboard keys stick', topic: ids.hardware });
      const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');

      const open = (await h.call('ann.user', 'GET', '/api/app/portal/tickets')).json().result;
      const openIds = open.tickets.map((t: { sys_id: string }) => t.sys_id);
      expect(open.view).toBe('open');
      expect(openIds).toContain(own.sysId);
      expect(openIds).toContain(ur.sys_id);
      expect(openIds).not.toContain(caseId);
      expect(openIds).not.toContain(closedOwn.sysId);
      expect(openIds).not.toContain(others.sysId);
      const row = open.tickets.find((t: { sys_id: string }) => t.sys_id === ur.sys_id);
      expect(row).toMatchObject({
        table: 'universal_request',
        number: ur.number,
        title: 'Keyboard keys stick',
        module: { key: 'department', label: 'IT' },
        active: true,
        survey_pending: false,
      });
      expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(open.tickets.find((t: { sys_id: string }) => t.sys_id === own.sysId).module).toEqual({
        key: 'module.general',
        label: 'General',
      });

      const closed = (await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=closed')).json().result;
      expect(closed.tickets.map((t: { sys_id: string }) => t.sys_id)).toContain(closedOwn.sysId);
      expect(closed.tickets.every((t: { active: boolean }) => !t.active)).toBe(true);

      const all = (await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=all')).json().result;
      expect(all.total).toBe(open.total + closed.total);

      const byNumber = (
        await h.call(
          'ann.user',
          'GET',
          `/api/app/portal/tickets?view=all&q=${own.str('number').slice(0, -1)}`,
        )
      ).json().result;
      expect(byNumber.tickets.map((t: { sys_id: string }) => t.sys_id)).toContain(own.sysId);
      const byTitle = (await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=all&q=lamp')).json()
        .result;
      expect(byTitle.tickets.map((t: { title: string }) => t.title)).toEqual(['Desk lamp flickers']);

      const page = (
        await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=all&limit=1&offset=1')
      ).json().result;
      expect(page.tickets).toHaveLength(1);
      expect(page.tickets[0].sys_id).toBe(all.tickets[1].sys_id);
      const asc = (
        await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=all&sort=number&order=asc&limit=200')
      ).json().result.tickets as { number: string }[];
      expect(asc.map((t) => t.number)).toEqual([...asc.map((t) => t.number)].sort());

      const bobs = (await h.call('bob.user', 'GET', '/api/app/portal/tickets?view=all'))
        .json()
        .result.tickets.map((t: { sys_id: string }) => t.sys_id);
      expect(bobs).toContain(others.sysId);
      expect(bobs).not.toContain(own.sysId);
    });

    it('shows a ticket only to the people involved', async () => {
      const own = openedTask(h.p, 'ann', {
        short_description: 'Window does not close',
        description: 'Meeting room 4',
      });
      h.p
        .systemContext()
        .update(own, { comments: 'We will send someone', work_notes: 'Facilities ticket 991' });
      expect((await h.call('bob.user', 'GET', `/api/app/portal/tickets/task/${own.sysId}`)).statusCode).toBe(
        404,
      );
      expect(
        (
          await h.call('bob.user', 'POST', `/api/app/portal/tickets/task/${own.sysId}/comment`, {
            comment: 'hi',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/tickets/sys_user/' + ids.ann)).statusCode,
      ).toBe(404);
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/tickets/not_a_table/' + own.sysId)).statusCode,
      ).toBe(404);

      const res = await h.call('ann.user', 'GET', `/api/app/portal/tickets/task/${own.sysId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('Facilities ticket 991');
      const d = res.json().result;
      expect(d.header).toMatchObject({
        number: own.str('number'),
        state: { badge: 'submitted', badge_label: 'Submitted' },
      });
      expect(d.header.created).not.toBe('');
      expect(d.header.updated).not.toBe('');
      expect(d.summary.map((f: { name: string }) => f.name)).toEqual([
        'item',
        'requested_for',
        'assignment_group',
        'assigned_to',
        'stage',
      ]);
      expect(d.summary.find((f: { name: string }) => f.name === 'requested_for').display_value).toBe(
        'ann user',
      );
      expect(d.timeline.map((s: { key: string; status: string }) => `${s.key}:${s.status}`)).toEqual([
        'submitted:done',
        'in_progress:pending',
        'closed:pending',
      ]);
      expect(d.activity.map((a: { value: string }) => a.value)).toEqual(['We will send someone']);
      expect(d.actions.map((a: { name: string }) => a.name)).toEqual(['comment']);
      expect(d.variables).toEqual([]);
      expect(d.primary).toBeNull();

      // Agents see department records through ACLs.
      expect(
        (await h.call('abel.agent', 'GET', `/api/app/portal/tickets/task/${own.sysId}`)).statusCode,
      ).toBe(200);
      // Approvers see what they are asked to approve.
      h.p
        .systemContext()
        .insert('sysapproval_approver', { approver: ids.mia, sysapproval: own.sysId, state: 'requested' });
      h.p.systemContext().update(reload(h.p, 'task', own.sysId), { watch_list: ids.mia });
      expect(
        (await h.call('mia.approver', 'GET', `/api/app/portal/tickets/task/${own.sysId}`)).statusCode,
      ).toBe(200);
    });

    it('lets watchers follow and comment on a request without acting on it', async () => {
      const ur = await newRequest('ann.user', { description: 'Plant on my desk needs watering' });
      h.p.systemContext().update(reload(h.p, 'universal_request', ur.sys_id), { watch_list: ids.bob });
      const asWatcher = await h.call(
        'bob.user',
        'GET',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}`,
      );
      expect(asWatcher.statusCode).toBe(200);
      expect(asWatcher.json().result.actions.map((a: { name: string }) => a.name)).toEqual(['comment']);
      const action = await h.call(
        'bob.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/cancel`,
        {},
      );
      expect(action.statusCode).toBe(403);
      const comment = await h.call(
        'bob.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/comment`,
        {
          comment: 'I can water it on Friday',
        },
      );
      expect(comment.statusCode).toBe(200);
      expect(reload(h.p, 'universal_request', ur.sys_id).str('state')).toBe('1');
      // Watching does not put the request in My Tickets.
      const bobs = (await h.call('bob.user', 'GET', '/api/app/portal/tickets?view=all&limit=200')).json()
        .result.tickets;
      expect(bobs.map((t: { sys_id: string }) => t.sys_id)).not.toContain(ur.sys_id);
    });

    it('sends a requester who opens the department record to the universal request', async () => {
      const ur = await newRequest('ann.user', { description: 'Trackpad is jumpy', topic: ids.hardware });
      const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');
      const asRequester = (
        await h.call('ann.user', 'GET', `/api/app/portal/tickets/resolvr_test_case/${caseId}`)
      ).json().result;
      expect(asRequester.table).toBe('universal_request');
      expect(asRequester.sys_id).toBe(ur.sys_id);
      expect(asRequester.redirected_from).toEqual({ table: 'resolvr_test_case', sys_id: caseId });
      expect(asRequester.primary).toBeNull();
      expect(JSON.stringify(asRequester)).not.toContain('TCASE');
      const asAgent = (
        await h.call('abel.agent', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`)
      ).json().result;
      expect(asAgent.primary).toMatchObject({ table: 'resolvr_test_case', sys_id: caseId });
      expect(
        (await h.call('bob.user', 'GET', `/api/app/portal/tickets/resolvr_test_case/${caseId}`)).statusCode,
      ).toBe(404);
    });

    it('lists pending approvals and records decisions', async () => {
      const target = openedTask(h.p, 'bob', { short_description: 'Buy a standing desk' });
      const approval = h.p.systemContext().insert('sysapproval_approver', {
        approver: ids.abel,
        sysapproval: target.sysId,
        state: 'requested',
      });
      const list = (await h.call('abel.agent', 'GET', '/api/app/portal/approvals')).json().result;
      const mine = list.approvals.find((a: { sys_id: string }) => a.sys_id === approval.sysId);
      expect(mine.target).toMatchObject({
        table: 'task',
        number: target.str('number'),
        title: 'Buy a standing desk',
      });
      expect(list.counts.approvals).toBe(list.approvals.length);
      expect((await h.call('bob.user', 'GET', '/api/app/portal/approvals')).json().result.approvals).toEqual(
        [],
      );
      expect(
        (await h.call('bob.user', 'POST', `/api/app/portal/approvals/${approval.sysId}/approve`, {}))
          .statusCode,
      ).toBe(404);
      expect(
        (await h.call('abel.agent', 'POST', `/api/app/portal/approvals/${approval.sysId}/reject`, {}))
          .statusCode,
      ).toBe(400);
      const ok = await h.call('abel.agent', 'POST', `/api/app/portal/approvals/${approval.sysId}/approve`, {
        comment: 'Fine',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().result.state.value).toBe('approved');
      expect(
        (await h.call('abel.agent', 'POST', `/api/app/portal/approvals/${approval.sysId}/approve`, {}))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('requested items', () => {
    const orderItem = (user: string, values: Record<string, unknown> = {}) => {
      const sys = h.p.systemContext();
      const req = sys.insert('sc_request', {
        requested_for: ids[user],
        opened_by: ids[user],
        short_description: 'Laptop order',
      });
      const ritm = sys.insert('sc_req_item', {
        request: req.sysId,
        cat_item: ids.laptop,
        requested_for: ids[user],
        opened_by: ids[user],
        short_description: 'Standard Laptop',
        ...values,
      });
      for (const [question, value] of [
        [ids.labelVar, 'ignored'],
        [ids.colorVar, 'silver'],
        [ids.managerVar, ids.abel],
      ]) {
        const option = sys.insert('sc_item_option', { item_option_new: question, value });
        sys.insert('sc_item_option_mtom', { request_item: ritm.sysId, sc_item_option: option.sysId });
      }
      return { req, ritm };
    };
    const steps = (d: { timeline: { key: string; status: string }[] }) =>
      d.timeline.map((x) => `${x.key}:${x.status}`);

    it('shows a requested item with its variables, stage and approval timeline', async () => {
      const { req, ritm } = orderItem('ann', { approval: 'requested', approval_set: nowGlide() });
      const list = (await h.call('ann.user', 'GET', '/api/app/portal/tickets?limit=200')).json().result
        .tickets;
      const row = list.find((t: { sys_id: string }) => t.sys_id === ritm.sysId);
      expect(row).toMatchObject({
        module: { key: 'module.it_request', label: 'IT Request' },
        state: { badge: 'awaiting_approval' },
      });
      expect(list.find((t: { sys_id: string }) => t.sys_id === req.sysId)).toBeUndefined();

      let d = (await h.call('ann.user', 'GET', `/api/app/portal/tickets/sc_req_item/${ritm.sysId}`)).json()
        .result;
      expect(d.summary.find((f: { name: string }) => f.name === 'item').display_value).toBe(
        'Standard Laptop',
      );
      expect(d.summary.find((f: { name: string }) => f.name === 'stage').display_value).toBe(
        'Waiting for Approval',
      );
      expect(d.variables).toEqual([
        { name: 'color', label: 'Color', value: 'silver', display_value: 'Silver' },
        { name: 'manager', label: 'Manager', value: ids.abel, display_value: 'abel agent' },
      ]);
      expect(steps(d)).toEqual([
        'submitted:done',
        'awaiting_approval:current',
        'fulfillment:pending',
        'closed:pending',
      ]);
      expect(d.actions.map((a: { name: string }) => a.name)).toEqual(['comment', 'cancel']);

      const sys = h.p.systemContext();
      sys.update(reload(h.p, 'sc_req_item', ritm.sysId), {
        approval: 'approved',
        stage: 'fulfillment',
        state: '2',
      });
      const task = sys.insert('sc_task', {
        request_item: ritm.sysId,
        short_description: 'Prepare the laptop',
      });
      d = (await h.call('ann.user', 'GET', `/api/app/portal/tickets/sc_req_item/${ritm.sysId}`)).json()
        .result;
      expect(steps(d)).toEqual([
        'submitted:done',
        'awaiting_approval:done',
        'fulfillment:current',
        'closed:pending',
      ]);
      expect(d.timeline[2].at).toBe(task.str('opened_at'));
      expect(d.header.state.badge).toBe('in_progress');
      expect(d.actions.map((a: { name: string }) => a.name)).toEqual(['comment']);

      sys.update(reload(h.p, 'sc_req_item', ritm.sysId), { stage: 'complete', state: '3' });
      d = (await h.call('ann.user', 'GET', `/api/app/portal/tickets/sc_req_item/${ritm.sysId}`)).json()
        .result;
      expect(steps(d)).toEqual([
        'submitted:done',
        'awaiting_approval:done',
        'fulfillment:done',
        'closed:done',
      ]);
      expect(d.header.state.badge).toBe('closed');
      expect(d.survey).not.toBeNull();
      expect(
        (await h.call('bob.user', 'GET', `/api/app/portal/tickets/sc_req_item/${ritm.sysId}`)).statusCode,
      ).toBe(404);
    });

    it('cancels an item waiting for approval and shows rejections as cancelled', async () => {
      const { ritm } = orderItem('ann');
      const res = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/tickets/sc_req_item/${ritm.sysId}/action/cancel`,
        {
          comment: 'Ordered by mistake',
        },
      );
      expect(res.statusCode, res.body).toBe(200);
      const after = reload(h.p, 'sc_req_item', ritm.sysId);
      expect(after.str('state')).toBe('4');
      expect(after.str('stage')).toBe('Request Cancelled');
      const d = res.json().result.ticket;
      expect(d.header.state.badge).toBe('cancelled');
      expect(steps(d)).toEqual(['submitted:done', 'cancelled:cancelled']);
      expect(d.activity[0].value).toBe('Ordered by mistake');

      const rejected = orderItem('ann', {
        approval: 'rejected',
        stage: 'Request Cancelled',
        state: '4',
      }).ritm;
      const r = (
        await h.call('ann.user', 'GET', `/api/app/portal/tickets/sc_req_item/${rejected.sysId}`)
      ).json().result;
      expect(steps(r)).toEqual(['submitted:done', 'awaiting_approval:done', 'cancelled:cancelled']);
      expect(r.header.state.badge).toBe('cancelled');
    });

    it('uses the catalog service for visibility, variables and cancellation when installed', async () => {
      const reasons: string[] = [];
      h.p.services.set('catalog', {
        access: () => ({ canViewItem: (item: Rec) => item.str('name') !== 'VPN Access' }),
        ticket: () => ({
          variables: [
            { name: 'pin', label: 'Door PIN', type: 'masked', value: '********', display_value: '********' },
          ],
        }),
        cancel: (ctx: Context, rec: Rec, reason: string) => {
          reasons.push(reason);
          ctx.update(rec, { state: '4', stage: 'Request Cancelled' });
        },
      });
      try {
        const search = (await h.call('ann.user', 'GET', '/api/app/portal/search?q=vpn&source=catalog')).json()
          .result;
        expect(search.groups[0].total).toBe(0);
        const page = (
          await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.network}?type=catalog`)
        ).json().result;
        expect(page.content).toEqual([]);
        const { ritm } = orderItem('ann');
        const d = (
          await h.call('ann.user', 'GET', `/api/app/portal/tickets/sc_req_item/${ritm.sysId}`)
        ).json().result;
        expect(d.variables).toEqual([
          { name: 'pin', label: 'Door PIN', type: 'masked', value: '********', display_value: '********' },
        ]);
        const res = await h.call(
          'ann.user',
          'POST',
          `/api/app/portal/tickets/sc_req_item/${ritm.sysId}/action/cancel`,
          { comment: 'Not needed' },
        );
        expect(res.statusCode, res.body).toBe(200);
        expect(reasons).toEqual(['Not needed']);
        expect(res.json().result.ticket.activity.map((a: { value: string }) => a.value)).toEqual([
          'Not needed',
        ]);
        expect(reload(h.p, 'sc_req_item', ritm.sysId).str('stage')).toBe('Request Cancelled');
      } finally {
        h.p.services.delete('catalog');
      }
    });

    it('routes a universal request to a requested item and cancels both', async () => {
      const ur = await newRequest('bob.user', { description: 'Need a second monitor' });
      const routed = await h.call(
        'abel.agent',
        'POST',
        `/api/app/action/universal_request/${ur.sys_id}/universal_request.route_request`,
        {},
      );
      expect(routed.statusCode, routed.body).toBe(200);
      expect(routed.json().result.message).toMatch(/^Requested Item RITM\d+ created$/);
      const rec = reload(h.p, 'universal_request', ur.sys_id);
      const ritm = reload(h.p, 'sc_req_item', rec.str('primary_task'));
      expect(ritm.str('requested_for')).toBe(ids.bob);
      expect(ritm.ref('request')?.str('requested_for')).toBe(ids.bob);

      const tickets = (await h.call('bob.user', 'GET', '/api/app/portal/tickets?limit=200'))
        .json()
        .result.tickets.map((t: { sys_id: string }) => t.sys_id);
      expect(tickets).toContain(ur.sys_id);
      expect(tickets).not.toContain(ritm.sysId);
      expect(tickets).not.toContain(ritm.str('request'));

      const d = (
        await h.call('bob.user', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`)
      ).json().result;
      expect(d.summary.find((f: { name: string }) => f.name === 'stage').display_value).toBe(
        'Waiting for Approval',
      );
      expect(d.actions.map((a: { name: string }) => a.name)).toEqual(['comment', 'cancel']);
      const cancelled = await h.call(
        'bob.user',
        'POST',
        `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/cancel`,
        {
          comment: 'Found a spare one',
        },
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(reload(h.p, 'sc_req_item', ritm.sysId).str('stage')).toBe('Request Cancelled');
      expect(reload(h.p, 'universal_request', ur.sys_id).str('state')).toBe('7');
      expect(cancelled.json().result.ticket.header.state.badge).toBe('cancelled');
      expect(h.p.systemContext().count('asmt_assessment_instance', `trigger_id=${ur.sys_id}`)).toBe(0);
    });
  });

  describe('taxonomy, search and favorites', () => {
    it('returns the topic tree with connected quick links', async () => {
      const res = await h.call('ann.user', 'GET', '/api/app/portal/topics');
      expect(res.statusCode).toBe(200);
      const roots = res.json().result as {
        name: string;
        children: { name: string; children: { name: string }[]; quick_links: { name: string }[] }[];
      }[];
      expect(roots.map((t) => t.name)).toEqual(['IT', 'HR']);
      const it = roots[0];
      expect(it.children.map((t) => t.name)).toEqual(['Hardware', 'Network']);
      expect(it.children[0].children.map((t) => t.name)).toEqual(['Laptops']);
      expect(it.children[1].quick_links.map((l) => l.name)).toEqual(['Wi-Fi status page']);
      expect((it.children[0] as unknown as { path: string }).path).toBe('IT > Hardware');
    });

    it('builds a topic page with breadcrumb, children and typed content', async () => {
      const res = await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.hardware}`);
      expect(res.statusCode).toBe(200);
      const page = res.json().result;
      expect(page.topic.name).toBe('Hardware');
      expect(page.breadcrumb.map((c: { name: string }) => c.name)).toEqual(['IT', 'Hardware']);
      expect(page.children.map((c: { name: string }) => c.name)).toEqual(['Laptops']);
      expect(page.counts).toEqual({ all: 2, catalog: 1, knowledge: 1, quick_link: 0 });
      expect(
        page.content
          .map(
            (c: { title: string; type: string; type_label: string }) =>
              `${c.type}:${c.type_label}:${c.title}`,
          )
          .sort(),
      ).toEqual(['catalog:Request:Standard Laptop', 'knowledge:Article:Laptop battery tips']);
      const articles = (
        await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.hardware}?type=knowledge`)
      ).json().result;
      expect(articles.filter).toBe('knowledge');
      expect(articles.content.map((c: { title: string }) => c.title)).toEqual(['Laptop battery tips']);
      const byName = (await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.it}?sort=name`)).json()
        .result;
      expect(byName.content.map((c: { title: string }) => c.title)).toEqual([
        'Laptop battery tips',
        'Reconnect the VPN client',
        'Standard Laptop',
        'VPN Access',
        'VPN troubleshooting guide',
        'Wi-Fi status page',
      ]);
      const popular = (await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.network}`)).json()
        .result;
      expect(popular.content[0].title).toBe('Reconnect the VPN client');
      const arabic = (
        await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.hardware}?lang=ar`)
      ).json().result;
      expect(arabic.content.find((c: { type: string }) => c.type === 'catalog').type_label).toBe('طلب');
      expect((await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.retired}`)).statusCode).toBe(404);
      expect((await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.orphan}`)).statusCode).toBe(404);
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/topics/0123456789abcdef0123456789abcdef'))
          .statusCode,
      ).toBe(404);
    });

    it('groups search results by source with facets', async () => {
      const res = await h.call('ann.user', 'GET', '/api/app/portal/search?q=vpn');
      expect(res.statusCode).toBe(200);
      const r = res.json().result;
      expect(r.groups.map((g: { source: string; total: number }) => `${g.source}:${g.total}`)).toEqual([
        'knowledge:2',
        'catalog:1',
      ]);
      const knowledge = r.groups[0].results as { title: string; knowledge_base: { name: string } }[];
      expect(knowledge.map((a) => a.title).sort()).toEqual([
        'Reconnect the VPN client',
        'VPN troubleshooting guide',
      ]);
      expect(knowledge[0].knowledge_base.name).toBe('IT Knowledge');
      expect(r.groups[1].results[0]).toMatchObject({
        title: 'VPN Access',
        type: 'catalog',
        action_label: 'Request',
      });
      expect(r.facets.source).toEqual([
        { value: 'all', label: 'All', count: 3 },
        { value: 'knowledge', label: 'Knowledge Articles', count: 2 },
        { value: 'catalog', label: 'Catalog Items', count: 1 },
      ]);
      expect(r.facets.topic).toEqual([{ value: ids.network, label: 'Network', count: 2 }]);
      expect(r.facets.knowledge_base).toEqual([{ value: ids.itKb, label: 'IT Knowledge', count: 2 }]);
      expect(
        r.facets.article_type.map((f: { value: string; count: number }) => `${f.value}:${f.count}`).sort(),
      ).toEqual(['html:1', 'text:1']);

      const catalogOnly = (
        await h.call('ann.user', 'GET', '/api/app/portal/search?q=vpn&source=catalog')
      ).json().result;
      expect(catalogOnly.groups.map((g: { source: string }) => g.source)).toEqual(['catalog']);
      expect(catalogOnly.facets.topic).toBeUndefined();
      expect(catalogOnly.facets.knowledge_base).toBeUndefined();

      const filtered = async (qs: string) =>
        (await h.call('ann.user', 'GET', `/api/app/portal/search?q=vpn&source=knowledge&${qs}`)).json().result
          .groups[0].total;
      expect(await filtered(`kb=${ids.itKb}`)).toBe(2);
      expect(await filtered('type=html')).toBe(1);
      expect(await filtered(`topic=${ids.hardware}`)).toBe(0);
      expect(await filtered(`topic=${ids.it}`)).toBe(2);

      // Restricted knowledge bases only show up for readers that may see them.
      const agent = (
        await h.call('abel.agent', 'GET', '/api/app/portal/search?q=vpn&source=knowledge')
      ).json().result;
      expect(agent.groups[0].total).toBe(3);
      expect((await h.call('ann.user', 'GET', '/api/app/portal/search?q=pager')).json().result.total).toBe(0);
      expect((await h.call('ann.user', 'GET', '/api/app/portal/search?q=hidden')).json().result.total).toBe(
        0,
      );
      const none = (await h.call('ann.user', 'GET', '/api/app/portal/search?q=zebra')).json().result;
      expect(none.total).toBe(0);
      expect(none.message).toBe('No results found for "zebra"');
      expect((await h.call('ann.user', 'GET', '/api/app/portal/search?q=')).json().result.total).toBe(0);
    });

    it('uses the knowledge search service when one is installed', async () => {
      const article = reload(h.p, 'kb_knowledge', ids.vpnGuide);
      h.p.services.set('knowledge', {
        search: () => ({
          total: 1,
          hits: [{ rec: article, snippet: 'Steps to fix <B>VPN</B> errors', score: 3.5 }],
        }),
      });
      try {
        const r = (await h.call('ann.user', 'GET', '/api/app/portal/search?q=vpn&source=knowledge')).json()
          .result;
        expect(r.groups[0].total).toBe(1);
        expect(r.groups[0].results[0]).toMatchObject({
          title: 'VPN troubleshooting guide',
          snippet: 'Steps to fix <B>VPN</B> errors',
          score: 3.5,
        });
      } finally {
        h.p.services.delete('knowledge');
      }
    });

    it('adds, lists and removes favorites idempotently', async () => {
      const add = await h.call('ann.user', 'POST', '/api/app/portal/favorites', {
        table: 'sc_cat_item',
        sys_id: ids.laptop,
      });
      expect(add.statusCode, add.body).toBe(201);
      const fav = add.json().result;
      expect(fav).toMatchObject({
        table: 'sc_cat_item',
        document: ids.laptop,
        type: 'catalog',
        title: 'Standard Laptop',
      });
      const again = await h.call('ann.user', 'POST', '/api/app/portal/favorites', {
        table: 'sc_cat_item',
        sys_id: ids.laptop,
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().result.sys_id).toBe(fav.sys_id);
      expect(
        (
          await h.call('ann.user', 'POST', '/api/app/portal/favorites', {
            table: 'kb_knowledge',
            sys_id: ids.vpnArticle,
          })
        ).statusCode,
      ).toBe(201);
      const list = (await h.call('ann.user', 'GET', '/api/app/portal/favorites')).json().result;
      expect(list.map((f: { title: string }) => f.title).sort()).toEqual([
        'Reconnect the VPN client',
        'Standard Laptop',
      ]);
      const page = (await h.call('ann.user', 'GET', `/api/app/portal/topics/${ids.hardware}`)).json().result;
      expect(page.content.find((c: { sys_id: string }) => c.sys_id === ids.laptop).favorite).toBe(true);
      expect((await h.call('bob.user', 'GET', '/api/app/portal/favorites')).json().result).toEqual([]);
      expect((await h.call('bob.user', 'DELETE', `/api/app/portal/favorites/${fav.sys_id}`)).statusCode).toBe(
        204,
      );
      expect((await h.call('ann.user', 'GET', '/api/app/portal/favorites')).json().result).toHaveLength(2);

      expect(
        (
          await h.call('ann.user', 'POST', '/api/app/portal/favorites', {
            table: 'sys_user',
            sys_id: ids.bob,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await h.call('ann.user', 'POST', '/api/app/portal/favorites', {
            table: 'sc_cat_item',
            sys_id: ids.pager,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.call('ann.user', 'POST', '/api/app/portal/favorites', {
            table: 'kb_knowledge',
            sys_id: ids.hrArticle,
          })
        ).statusCode,
      ).toBe(404);

      // A favorite whose target disappears from the portal is hidden, not deleted.
      h.p.systemContext().update(reload(h.p, 'kb_knowledge', ids.vpnArticle), { workflow_state: 'retired' });
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/favorites'))
          .json()
          .result.map((f: { title: string }) => f.title),
      ).toEqual(['Standard Laptop']);
      h.p
        .systemContext()
        .update(reload(h.p, 'kb_knowledge', ids.vpnArticle), { workflow_state: 'published' });

      expect((await h.call('ann.user', 'DELETE', `/api/app/portal/favorites/${ids.laptop}`)).statusCode).toBe(
        204,
      );
      expect((await h.call('ann.user', 'DELETE', `/api/app/portal/favorites/${ids.laptop}`)).statusCode).toBe(
        204,
      );
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/favorites'))
          .json()
          .result.map((f: { title: string }) => f.title),
      ).toEqual(['Reconnect the VPN client']);
    });
  });

  describe('surveys', () => {
    it('sends a survey when a request closes and records the answers', async () => {
      ids.cara = makeUser(h.p, 'cara.user');
      const ur = await newRequest('cara.user', { description: 'Mouse double-clicks', topic: ids.hardware });
      const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');
      const sys = h.p.systemContext();
      sys.update(reload(h.p, 'resolvr_test_case', caseId), { state: '3' });
      const instances = sys.query('asmt_assessment_instance', { query: `user=${ids.cara}` });
      expect(instances.map((i) => `${i.str('trigger_table')}:${i.str('state')}`)).toEqual([
        'universal_request:ready',
      ]);
      const inst = instances[0];
      expect(inst.str('number')).toMatch(/^AINST/);
      expect(inst.str('due_date')).not.toBe('');

      const home = (await h.call('cara.user', 'GET', '/api/app/portal/home')).json().result;
      expect(home.counts.pending_surveys).toBe(1);
      const closed = (await h.call('cara.user', 'GET', '/api/app/portal/tickets?view=closed')).json().result
        .tickets;
      expect(closed.find((t: { sys_id: string }) => t.sys_id === ur.sys_id)).toMatchObject({
        survey_pending: true,
        survey_instance: inst.sysId,
      });
      const detail = (
        await h.call('cara.user', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`)
      ).json().result;
      expect(detail.survey).toEqual({ instance_id: inst.sysId });

      const list = (await h.call('cara.user', 'GET', '/api/app/portal/surveys')).json().result;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        sys_id: inst.sysId,
        open: true,
        survey: { name: 'Request satisfaction' },
        trigger: { number: ur.number },
      });
      const survey = (await h.call('cara.user', 'GET', `/api/app/portal/surveys/${inst.sysId}`)).json()
        .result;
      expect(survey.read_only).toBe(false);
      expect(
        survey.questions.map((q: { name: string; datatype: string }) => `${q.name}:${q.datatype}`),
      ).toEqual(['Overall satisfaction:scale', 'Met expectations:boolean', 'Comments:string']);
      expect((await h.call('bob.user', 'GET', `/api/app/portal/surveys/${inst.sysId}`)).statusCode).toBe(404);
      expect(
        (await h.call('bob.user', 'POST', `/api/app/portal/surveys/${inst.sysId}`, { rating: 5 })).statusCode,
      ).toBe(404);

      expect(
        (await h.call('cara.user', 'POST', `/api/app/portal/surveys/${inst.sysId}`, { rating: 6 }))
          .statusCode,
      ).toBe(400);
      expect(
        (await h.call('cara.user', 'POST', `/api/app/portal/surveys/${inst.sysId}`, { comment: 'no rating' }))
          .statusCode,
      ).toBe(400);
      const saved = await h.call('cara.user', 'POST', `/api/app/portal/surveys/${inst.sysId}`, {
        rating: 3,
        save: true,
      });
      expect(saved.json().result.state.value).toBe('wip');
      expect(
        (await h.call('cara.user', 'GET', '/api/app/portal/home')).json().result.counts.pending_surveys,
      ).toBe(1);

      const done = await h.call('cara.user', 'POST', `/api/app/portal/surveys/${inst.sysId}`, {
        rating: 5,
        comment: 'Quick and friendly',
        answers: { 'Met expectations': 'yes' },
      });
      expect(done.statusCode, done.body).toBe(200);
      const result = done.json().result;
      expect(result.state.value).toBe('complete');
      expect(result.read_only).toBe(true);
      expect(result.percent_answered).toBe(100);
      expect(result.questions.map((q: { answer: unknown }) => q.answer)).toEqual([
        5,
        true,
        'Quick and friendly',
      ]);
      const rows = sys.query('asmt_metric_result', { query: `instance=${inst.sysId}` });
      expect(rows).toHaveLength(3);
      const overall = rows.find((row) => row.display('metric') === 'Overall satisfaction')!;
      expect(overall.num('actual_value')).toBe(5);
      expect(overall.num('normalized_value')).toBe(5);
      expect(overall.str('source_id')).toBe(ur.sys_id);
      expect(
        (await h.call('cara.user', 'GET', '/api/app/portal/home')).json().result.counts.pending_surveys,
      ).toBe(0);
      expect(
        (await h.call('cara.user', 'POST', `/api/app/portal/surveys/${inst.sysId}`, { rating: 1 }))
          .statusCode,
      ).toBe(400);
      expect(
        (await h.call('cara.user', 'GET', '/api/app/portal/surveys?state=all')).json().result,
      ).toHaveLength(1);
    });

    it('sends one survey per record and user, using any trigger condition', async () => {
      const sys = h.p.systemContext();
      const survey = sys.first('asmt_metric_type', 'name=Request satisfaction')!;
      const trigger = sys.insert('asmt_condition', {
        metric_type: survey.sysId,
        table: 'task',
        condition: 'state=3',
        user_field: 'opened_by',
      });
      try {
        const task = openedTask(h.p, 'bob', { short_description: 'Projector bulb' });
        sys.update(task, { state: '3' });
        sys.update(reload(h.p, 'task', task.sysId), { state: '2' });
        sys.update(reload(h.p, 'task', task.sysId), { state: '3' });
        expect(sys.count('asmt_assessment_instance', `trigger_id=${task.sysId}`)).toBe(1);
        // Department records of a universal request are surveyed through the request.
        const ur = await newRequest('bob.user', { description: 'Headset crackles', topic: ids.hardware });
        const caseId = reload(h.p, 'universal_request', ur.sys_id).str('primary_task');
        sys.update(reload(h.p, 'resolvr_test_case', caseId), { state: '3' });
        expect(sys.count('asmt_assessment_instance', `trigger_id=${caseId}`)).toBe(0);
        expect(sys.count('asmt_assessment_instance', `trigger_id=${ur.sys_id}`)).toBe(1);
      } finally {
        sys.delete(reload(h.p, 'asmt_condition', trigger.sysId));
      }
    });
  });

  describe('home, language and metadata', () => {
    it('builds the home page', async () => {
      clock.freeze(`${new Date().toISOString().slice(0, 10)} 09:15:00`);
      const res = await h.call('ann.user', 'GET', '/api/app/portal/home');
      expect(res.statusCode).toBe(200);
      const home = res.json().result;
      expect(home.greeting).toEqual({ key: 'greeting.morning', text: 'Good morning, ann' });
      expect(home.language).toEqual({ lang: 'en', dir: 'ltr' });
      expect(home.quick_links.map((l: { name: string }) => l.name)).toEqual(['Report an issue']);
      expect(home.quick_links[0]).toMatchObject({ content_type: 'page', page: 'report_issue' });
      expect(home.announcements.map((a: { title: string }) => a.title)).toEqual(['Planned maintenance']);
      expect(home.featured_topics.map((t: { name: string }) => t.name)).toEqual(['Hardware']);
      expect(home.recent_items.length).toBeLessThanOrEqual(5);
      const updated = home.recent_items.map((t: { updated: string }) => t.updated);
      expect(updated).toEqual([...updated].sort().reverse());
      const open = (await h.call('ann.user', 'GET', '/api/app/portal/tickets?view=open')).json().result;
      expect(home.counts.open_tickets).toBe(open.total);
      expect(home.counts).toHaveProperty('pending_approvals', 0);
      clock.freeze(`${new Date().toISOString().slice(0, 10)} 19:00:00`);
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/home?lang=ar')).json().result.greeting,
      ).toEqual({ key: 'greeting.evening', text: 'مساء الخير، ann' });
      clock.reset();

      const dismissed = await h.call(
        'ann.user',
        'POST',
        `/api/app/portal/announcements/${ids.notice}/dismiss`,
        {},
      );
      expect(dismissed.statusCode).toBe(200);
      expect((await h.call('ann.user', 'GET', '/api/app/portal/announcements')).json().result).toEqual([]);
      expect((await h.call('bob.user', 'GET', '/api/app/portal/announcements')).json().result).toHaveLength(
        1,
      );
      expect((await h.call('ann.user', 'GET', '/api/app/portal/quick-links')).json().result).toHaveLength(1);
    });

    it('serves English and Arabic UI strings with the text direction', async () => {
      const en = await h.call(null, 'GET', '/api/app/portal/i18n/en');
      expect(en.statusCode).toBe(200);
      const e = en.json().result;
      expect(e).toMatchObject({ lang: 'en', dir: 'ltr', rtl: false, fallback: 'en' });
      expect(Object.keys(e.strings).length).toBeGreaterThanOrEqual(60);
      const ar = (await h.call(null, 'GET', '/api/app/portal/i18n/ar-SA')).json().result;
      expect(ar).toMatchObject({ lang: 'ar', dir: 'rtl', rtl: true, name: 'العربية' });
      expect(ar.strings['nav.my_tickets']).toBe('تذاكري');
      expect(ar.strings['badge.action_needed']).toBe('مطلوب إجراء');
      expect(Object.keys(EN).filter((k) => !(k in AR))).toEqual([]);
      expect(Object.keys(AR).filter((k) => !(k in EN))).toEqual([]);
      const fr = (await h.call(null, 'GET', '/api/app/portal/i18n/fr')).json().result;
      expect(fr).toMatchObject({ lang: 'en', requested: 'fr', dir: 'ltr' });

      const set = await h.call('bob.user', 'POST', '/api/app/portal/language', { lang: 'ar' });
      expect(set.statusCode).toBe(200);
      expect(reload(h.p, 'sys_user', ids.bob).str('preferred_language')).toBe('ar');
      const home = (await h.call('bob.user', 'GET', '/api/app/portal/home')).json().result;
      expect(home.language).toEqual({ lang: 'ar', dir: 'rtl' });
      const tickets = (await h.call('bob.user', 'GET', '/api/app/portal/tickets?view=all')).json().result
        .tickets;
      expect(
        tickets.find((t: { state: { badge: string } }) => t.state.badge === 'closed').state.badge_label,
      ).toBe('مغلقة');
      await h.call('bob.user', 'POST', '/api/app/portal/language', { lang: 'en' });
    });

    it('exposes the admin navigation, forms and lists', async () => {
      const nav = (await h.call('admin', 'GET', '/api/app/navigation')).json().result as {
        id: string;
        modules: { title: string }[];
      }[];
      const portal = nav.find((a) => a.id === 'portal')!;
      expect(portal.modules.map((m) => m.title)).toEqual(
        expect.arrayContaining(['Topics', 'Quick Links', 'Announcements', 'Universal Requests', 'Surveys']),
      );
      expect(
        (await h.call('ann.user', 'GET', '/api/app/navigation'))
          .json()
          .result.find((a: { id: string }) => a.id === 'portal'),
      ).toBeUndefined();
      const meta = (await h.call('admin', 'GET', '/api/app/meta/universal_request')).json().result;
      expect(meta.numberPrefix).toBe('UR');
      expect(meta.columns.state.choices.map((c: { label: string }) => c.label)).toEqual([
        'New',
        'In Progress',
        'Awaiting',
        'Closed',
        'Canceled',
      ]);
      expect(meta.form.relatedLists[0]).toMatchObject({
        table: 'task',
        field: 'universal_request',
        label: 'Associated Tickets',
      });
      for (const table of [
        'topic',
        'sn_ex_sp_quick_link',
        'resolvr_announcement',
        'asmt_metric_type',
        'asmt_assessment_instance',
      ]) {
        const m = (await h.call('admin', 'GET', `/api/app/meta/${table}`)).json().result;
        expect(m.form.sections.length).toBeGreaterThan(0);
        expect(m.list.columns.length).toBeGreaterThan(0);
      }
    });

    it('lists guided tours and remembers completion', async () => {
      const sys = h.p.systemContext();
      const tour = sys.insert('sys_embedded_tour_guide', {
        name: 'Welcome',
        page_id: 'index',
        auto_launch: true,
      });
      sys.insert('sys_embedded_tour_step', {
        guide: tour.sysId,
        order: 10,
        title: 'Search',
        target: '[data-tour="search"]',
      });
      sys.insert('sys_embedded_tour_step', {
        guide: tour.sysId,
        order: 20,
        title: 'Tickets',
        target: '[data-tour="my-tickets"]',
      });
      sys.insert('sys_embedded_tour_guide', { name: 'Agents only', page_id: 'index', roles: 'itil' });
      const tours = (await h.call('ann.user', 'GET', '/api/app/portal/tours?page=index')).json().result;
      expect(
        tours.map(
          (t: { name: string; done: boolean; steps: unknown[] }) => `${t.name}:${t.done}:${t.steps.length}`,
        ),
      ).toEqual(['Welcome:false:2']);
      expect(
        (await h.call('ann.user', 'POST', `/api/app/portal/tours/${tour.sysId}/done`, {})).statusCode,
      ).toBe(200);
      expect(
        (await h.call('ann.user', 'GET', '/api/app/portal/tours?page=index')).json().result[0].done,
      ).toBe(true);
      expect(
        (await h.call('bob.user', 'GET', '/api/app/portal/tours?page=index')).json().result[0].done,
      ).toBe(false);
    });

    it('requires authentication for portal data', async () => {
      for (const url of [
        '/api/app/portal/home',
        '/api/app/portal/topics',
        '/api/app/portal/search?q=vpn',
        '/api/app/portal/tickets',
        '/api/app/portal/favorites',
        '/api/app/portal/surveys',
        '/api/app/portal/approvals',
      ]) {
        expect((await h.call(null, 'GET', url)).statusCode).toBe(401);
      }
    });
  });
});

// ---------------------------------------------------------------- time-based jobs

describe('portal jobs', () => {
  afterEach(() => clock.reset());

  it('closes unconfirmed requests and expires overdue surveys', () => {
    const p = bootPlatform([portalModule, stubs]);
    try {
      clock.freeze('2026-03-02 09:00:00');
      fixtures(p);
      const sys = p.systemContext();
      const ann = p.contextAs('ann.user');
      const ur = sys.insert('universal_request', {
        short_description: 'Replace badge',
        opened_for: ids.ann,
        needs_resolution_review: true,
      });
      const primary = routeUniversalRequest(sys, ur, 'resolvr_test_case');
      sys.update(primary, { state: '3' });
      expect(reload(p, 'universal_request', ur.sysId).str('state')).toBe('3');
      clock.advance(4 * DAY);
      p.scheduler.runNow('portal.ur_confirm_autoclose');
      expect(reload(p, 'universal_request', ur.sysId).str('state')).toBe('3');
      clock.advance(2 * DAY);
      p.scheduler.runNow('portal.ur_confirm_autoclose');
      expect(reload(p, 'universal_request', ur.sysId).str('state')).toBe('4');

      const inst = sys.first('asmt_assessment_instance', `trigger_id=${ur.sysId}`)!;
      expect(inst.str('state')).toBe('ready');
      expect(ann.query('asmt_assessment_instance').map((i) => i.sysId)).toEqual([inst.sysId]);
      expect(p.contextAs('bob.user').query('asmt_assessment_instance')).toEqual([]);
      clock.advance(15 * DAY);
      p.scheduler.runNow('portal.survey_expiry');
      expect(reload(p, 'asmt_assessment_instance', inst.sysId).str('state')).toBe('canceled');
    } finally {
      p.close();
    }
  });
});

// ---------------------------------------------------------------- with the incident module (when it is installed and ready)

const incidentModule: AppModule | null = await import('../src/modules/incident/index.js')
  .then((m) => m.incidentModule as AppModule)
  .catch(() => null);
const INCIDENT_READY = (() => {
  if (!incidentModule) return false;
  try {
    const p = bootPlatform([incidentModule]);
    const ok = p.registry.has('incident');
    p.close();
    return ok;
  } catch {
    return false;
  }
})();

describe.runIf(INCIDENT_READY)('portal with incidents', () => {
  let h: Harness;
  let it_: string;
  beforeAll(async () => {
    h = await harness([incidentModule!, portalModule]);
    ids.ann = makeUser(h.p, 'ann.user');
    ids.bob = makeUser(h.p, 'bob.user');
    ids.abel = makeUser(h.p, 'abel.agent', ['itil'], ['Service Desk']);
    const sys = h.p.systemContext();
    const tax = sys.insert('taxonomy', { name: 'Employee' });
    const service = sys.first('sn_uni_req_service', 'name=IT incident')!;
    it_ = sys.insert('topic', { name: 'IT', taxonomy: tax.sysId, resolvr_ur_service: service.sysId }).sysId;
  });
  afterAll(async () => {
    await h?.close();
  });

  const agent = (): Context => h.p.contextAs('abel.agent');
  const resolve = (incId: string) => {
    const a = agent();
    a.update(a.get('incident', incId)!, {
      state: '6',
      close_code: 'Solution provided',
      close_notes: 'Replaced the cable',
    });
  };

  it('creates an incident for an IT topic and follows it to closure', async () => {
    const created = await h.call('ann.user', 'POST', '/api/app/portal/requests', {
      description: 'Monitor flickers\nSince this morning',
      topic: it_,
    });
    expect(created.statusCode, created.body).toBe(201);
    const ur = created.json().result;
    expect(ur.routed).toBe(true);
    const rec = reload(h.p, 'universal_request', ur.sys_id);
    const inc = reload(h.p, 'incident', rec.str('primary_task'));
    expect(inc.str('caller_id')).toBe(ids.ann);
    expect(inc.str('universal_request')).toBe(ur.sys_id);
    expect(inc.str('contact_type')).toBe('self-service');
    expect(rec.str('state')).toBe('2');

    const list = (await h.call('ann.user', 'GET', '/api/app/portal/tickets'))
      .json()
      .result.tickets.map((t: { sys_id: string }) => t.sys_id);
    expect(list).toContain(ur.sys_id);
    expect(list).not.toContain(inc.sysId);

    resolve(inc.sysId);
    let detail = (
      await h.call('ann.user', 'GET', `/api/app/portal/tickets/universal_request/${ur.sys_id}`)
    ).json().result;
    expect(detail.header.state.badge).toBe('action_needed');
    expect(detail.actions.map((a: { name: string }) => a.name)).toEqual(['comment', 'accept', 'reopen']);
    expect(detail.timeline.map((s: { key: string; status: string }) => `${s.key}:${s.status}`)).toEqual([
      'submitted:done',
      'in_progress:done',
      'resolved:current',
      'closed:pending',
    ]);

    expect(
      (
        await h.call(
          'ann.user',
          'POST',
          `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/reopen`,
          {},
        )
      ).statusCode,
    ).toBe(400);
    const reopened = await h.call(
      'ann.user',
      'POST',
      `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/reopen`,
      { comment: 'Still flickering' },
    );
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reload(h.p, 'incident', inc.sysId).str('state')).toBe('2');
    expect(reload(h.p, 'incident', inc.sysId).num('reopen_count')).toBe(1);
    expect(journal(h.p, 'incident', inc.sysId, 'comments')[0]).toBe('comments:Still flickering:ann.user');
    expect(reload(h.p, 'universal_request', ur.sys_id).str('state')).toBe('2');

    resolve(inc.sysId);
    const accepted = await h.call(
      'ann.user',
      'POST',
      `/api/app/portal/tickets/universal_request/${ur.sys_id}/action/accept`,
      {},
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(reload(h.p, 'incident', inc.sysId).str('state')).toBe('7');
    detail = accepted.json().result.ticket;
    expect(detail.header.state.badge).toBe('closed');
    const surveys = h.p.systemContext().query('asmt_assessment_instance', { query: `user=${ids.ann}` });
    expect(surveys.map((s) => s.str('trigger_table'))).toEqual(['universal_request']);
  });

  it('lets an agent route an unrouted request to an incident from the workspace', async () => {
    const created = (
      await h.call('bob.user', 'POST', '/api/app/portal/requests', {
        description: 'Something is wrong with my account',
      })
    ).json().result;
    expect(created.routed).toBe(false);
    const res = await h.call(
      'abel.agent',
      'POST',
      `/api/app/action/universal_request/${created.sys_id}/universal_request.route_incident`,
      {},
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.message).toMatch(/^Incident INC\d+ created$/);
    const ur = reload(h.p, 'universal_request', created.sys_id);
    const inc = reload(h.p, 'incident', ur.str('primary_task'));
    expect(inc.str('caller_id')).toBe(ids.bob);
    expect(inc.str('short_description')).toBe('Something is wrong with my account');
    expect(ur.str('state')).toBe('2');
    const again = await h.call(
      'abel.agent',
      'POST',
      `/api/app/action/universal_request/${created.sys_id}/universal_request.route_incident`,
      {},
    );
    expect(again.statusCode).toBe(403);
    // Bob's portal shows the request; the incident URL takes him to it.
    const viaIncident = (
      await h.call('bob.user', 'GET', `/api/app/portal/tickets/incident/${inc.sysId}`)
    ).json().result;
    expect(viaIncident.table).toBe('universal_request');
  });

  it('handles incidents raised outside a universal request', async () => {
    const inc = agent().insert('incident', {
      short_description: 'Cannot print payslips',
      caller_id: ids.ann,
    });
    const list = (await h.call('ann.user', 'GET', '/api/app/portal/tickets')).json().result.tickets;
    expect(list.find((t: { sys_id: string }) => t.sys_id === inc.sysId).module).toEqual({
      key: 'module.it_incident',
      label: 'IT Incident',
    });
    const resolved = await h.call(
      'ann.user',
      'POST',
      `/api/app/portal/tickets/incident/${inc.sysId}/action/resolve`,
      { comment: 'Works again after a restart' },
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    const after = reload(h.p, 'incident', inc.sysId);
    expect(after.str('state')).toBe('6');
    expect(after.str('close_code')).toBe('Resolved by caller');
    await h.call('ann.user', 'POST', `/api/app/portal/tickets/incident/${inc.sysId}/action/accept`, {});
    expect(reload(h.p, 'incident', inc.sysId).str('state')).toBe('7');
    expect(
      h.p.systemContext().count('asmt_assessment_instance', `trigger_id=${inc.sysId}^user=${ids.ann}`),
    ).toBe(1);
    expect(
      (await h.call('bob.user', 'GET', `/api/app/portal/tickets/incident/${inc.sysId}`)).statusCode,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------- demo data

describe('portal demo data', () => {
  const demoContent: AppModule = {
    ...stubs,
    id: 'portal_test_demo_content',
    demo(ctx) {
      ctx.insert('sc_cat_item', { name: 'Standard Laptop', short_description: 'Everyday laptop' });
      ctx.insert('sc_cat_item', { name: 'Parking permit', short_description: 'Not an IT item' });
      ctx.insert('kb_knowledge', {
        short_description: 'Reconnect the VPN client',
        workflow_state: 'published',
      });
    },
  };
  const linked = (p: Platform) =>
    p
      .systemContext()
      .query('m2m_connected_content', { query: 'content_type!=quick_link' })
      .map(
        (r) =>
          `${r.display('catalog_item') || r.ref('knowledge')?.str('short_description')} -> ${r.display('topic')}`,
      )
      .sort();

  it('builds the IT taxonomy, quick links, announcement, tour, requests and surveys', () => {
    const p = bootPlatform([portalModule], { demo: true });
    try {
      const sys = p.systemContext();
      expect(p.errors).toEqual([]);
      expect(
        sys.query('topic', { query: 'parent_topic.name=IT^ORDERBYorder' }).map((t) => t.str('name')),
      ).toEqual([
        'Hardware',
        'Software',
        'Access & Accounts',
        'Network & Connectivity',
        'Security',
        'Workplace',
      ]);
      expect(sys.first('topic', 'name=VPN & Remote Access')!.str('topic_path')).toBe(
        'IT > Network & Connectivity > VPN & Remote Access',
      );
      expect(
        sys
          .query('sn_ex_sp_quick_link', { query: 'show_on_home=true^ORDERBYorder' })
          .map((l) => l.str('name')),
      ).toEqual(['Report an issue', 'Request something', 'My tickets', 'Knowledge']);
      expect(sys.count('resolvr_announcement', 'active=true')).toBe(1);
      expect(sys.count('sys_embedded_tour_step')).toBe(3);
      const urs = sys.query('universal_request', { query: 'ORDERBYnumber' });
      expect(urs).toHaveLength(5);
      expect(urs.every((u) => u.str('primary_task') === '')).toBe(true); // no department module installed
      const noah = sys.first('sys_user', 'user_name=noah.johnson')!;
      const done = sys.first('asmt_assessment_instance', `user=${noah.sysId}`)!;
      expect(done.str('state')).toBe('complete');
      expect(sys.count('asmt_metric_result', `instance=${done.sysId}`)).toBe(2);
      const layla = sys.first('sys_user', 'user_name=layla.hassan')!;
      expect(
        sys.query('asmt_assessment_instance', { query: `user=${layla.sysId}` }).map((i) => i.str('state')),
      ).toEqual(['ready']);
      expect(
        sys
          .first('universal_request', 'short_description=VPN disconnects every few minutes from home')!
          .str('state'),
      ).toBe('3');
    } finally {
      p.close();
    }
  });

  it('connects catalog items and articles to topics by name, whichever module loads first', () => {
    for (const modules of [
      [portalModule, demoContent],
      [demoContent, portalModule],
    ]) {
      const p = bootPlatform(modules, { demo: true });
      try {
        expect(linked(p)).toEqual([
          'Reconnect the VPN client -> Network & Connectivity',
          'Standard Laptop -> Hardware',
        ]);
        // Content created after the demo load is left for administrators to connect.
        p.systemContext().insert('sc_cat_item', { name: 'Gaming laptop' });
        expect(linked(p)).toHaveLength(2);
      } finally {
        p.close();
      }
    }
  });

  it.runIf(INCIDENT_READY)(
    'routes the demo requests to incidents when the incident module is installed',
    () => {
      const p = bootPlatform([incidentModule!, portalModule], { demo: true });
      try {
        const sys = p.systemContext();
        expect(p.errors).toEqual([]);
        const ur = (title: string) => sys.first('universal_request', `short_description=${title}`)!;
        const monitor = ur('My second monitor keeps flickering');
        expect(monitor.ref('primary_task')?.className).toBe('incident');
        expect(
          p.history.journal('incident', monitor.str('primary_task'), ['comments']).map((j) => j.value),
        ).toContain('It is worse when the laptop is on battery.');
        expect(ur('Question about laptop encryption before travelling').str('primary_task')).toBe('');
        const battery = ur('Laptop battery drains within an hour');
        expect(battery.str('state')).toBe('4');
        expect(battery.ref('primary_task')?.str('state')).toBe('7');
        expect(ur('VPN disconnects every few minutes from home').str('state')).toBe('3');
      } finally {
        p.close();
      }
    },
  );
});
