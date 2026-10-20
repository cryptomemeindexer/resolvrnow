// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notification templates use ${field} placeholders
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { activityFor } from '../src/api/app/ui.js';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { InvalidError } from '../src/engine/errors.js';
import type { AppModule } from '../src/engine/module.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { clock } from '../src/engine/util.js';
import {
  type ApprovalDecision,
  type NotificationService,
  optionalService,
  SERVICES,
} from '../src/modules/contracts.js';
import {
  LogTransport,
  type NotificationEngine,
  notificationEngine,
  notificationsModule,
  smtpTransportFromPlugin,
} from '../src/modules/notifications/index.js';
import { smtpConfig } from '../src/modules/notifications/transport.js';
import { bootPlatform, makeUser } from './helpers.js';

/** Tables used only by these tests: a task child, a minimal incident and approval table. */
const testModule: AppModule = {
  id: 'notif_test',
  name: 'Notification test tables',
  dependsOn: ['task'],
  tables: [
    {
      name: 'x_ticket',
      label: 'Ticket',
      extends: 'task',
      number: { prefix: 'TKT', start: 1000 },
      columns: [{ name: 'caller', label: 'Caller', type: 'reference', reference: 'sys_user' }],
    },
    {
      name: 'incident',
      label: 'Incident',
      extends: 'task',
      number: { prefix: 'INC', start: 10000 },
      columns: [
        { name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user' },
        { name: 'close_notes', label: 'Resolution notes', type: 'string', maxLength: 4000 },
      ],
    },
    {
      name: 'sysapproval_approver',
      label: 'Approval',
      columns: [
        { name: 'approver', label: 'Approver', type: 'reference', reference: 'sys_user' },
        { name: 'state', label: 'State', type: 'string', maxLength: 40 },
        { name: 'sysapproval', label: 'Approval for', type: 'reference', reference: 'task' },
        { name: 'comments', label: 'Comments', type: 'journal_input' },
      ],
    },
  ],
};

interface Env {
  p: Platform;
  ctx: Context;
  engine: NotificationEngine;
  log: LogTransport;
  agent: string;
  agent2: string;
  requester: string;
  boss: string;
  group: string;
}

let platforms: Platform[] = [];

function setup(): Env {
  const p = bootPlatform([notificationsModule, testModule]);
  platforms.push(p);
  p.properties.set('glide.servlet.uri', 'https://resolvr.test');
  p.properties.set('glide.email.user', 'help@resolvr.test');
  const engine = notificationEngine(p);
  const log = new LogTransport();
  engine.setTransport(log);
  const boss = makeUser(p, 'bella.boss', ['itil']);
  const agent = makeUser(p, 'abel.agent', ['itil'], ['Service Desk']);
  const agent2 = makeUser(p, 'ada.agent', ['itil'], ['Service Desk']);
  const requester = makeUser(p, 'rita.requester', []);
  const ctx = p.systemContext();
  ctx.update(ctx.get('sys_user', requester)!, { manager: boss });
  const group = ctx.first('sys_user_group', 'name=Service Desk')!.sysId;
  return { p, ctx, engine, log, agent, agent2, requester, boss, group };
}

afterEach(() => {
  for (const p of platforms) p.close();
  platforms = [];
  clock.reset();
});

let seq = 0;
function notification(ctx: Context, values: Record<string, unknown>): Rec {
  seq++;
  return ctx.insert('sysevent_email_action', {
    name: `Test notification ${seq}`,
    collection: 'x_ticket',
    active: true,
    generation_type: 'engine',
    content_type: 'text/html',
    subject: '${number} changed',
    message_html: '<p>${short_description}</p>',
    ...values,
  });
}

function ticket(ctx: Context, values: Record<string, unknown> = {}): Rec {
  return ctx.insert('x_ticket', { short_description: 'Printer jams on floor 2', ...values });
}

function emailsFor(ctx: Context, rec: Rec, type?: string): Rec[] {
  return ctx.query('sys_email', {
    query: `instance=${rec.sysId}${type ? `^type=${type}` : ''}`,
    orderBy: [{ field: 'sys_created_on', desc: false }],
  });
}

function addresses(email: Rec): string[] {
  return email
    .str('recipients')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

const WATERMARK = /Ref:(MSG\d{7}_[A-Za-z0-9]{20})/;

// ---------------------------------------------------------------------------------- seed

describe('seed data', () => {
  it('ships default notifications by table name, templates, a branded layout and inbound actions', () => {
    const { ctx } = setup();
    const names = ctx.query('sysevent_email_action').map((n) => n.str('name'));
    for (const n of [
      'Incident assigned to me',
      'Incident assigned to my group',
      'Incident commented',
      'Incident resolved',
      'Approval requested',
      'Request item completed',
      'Change approved',
      'Change rejected',
      'SLA warning',
    ]) {
      expect(names).toContain(n);
    }
    const resolved = ctx.first('sysevent_email_action', 'name=Incident resolved')!;
    expect(resolved.str('collection')).toBe('incident');
    expect(resolved.str('event_name')).toBe('incident.resolved');
    expect(resolved.display('category')).toBe('Incident');
    const tpl = resolved.ref('template')!;
    expect(tpl.display('email_layout')).toBe('ResolvrNow default');
    const layout = ctx.first('sys_email_layout', 'name=ResolvrNow default')!;
    expect(layout.str('layout')).toContain('${notification:body}');
    expect(layout.str('layout')).toContain('lang="en"');
    expect(ctx.count('sysevent_in_email_action', 'active=true')).toBeGreaterThanOrEqual(5);
    expect(ctx.count('sys_mailbox')).toBe(7);
    expect(ctx.count('sys_email_digest_interval')).toBe(4);
    expect(ctx.count('sys_script_email', 'resolvr_native=true')).toBe(3);
    expect(ctx.first('sys_user', 'user_name=guest')).not.toBeNull();
  });

  it('keeps a primary email device in sync with the user email', () => {
    const { ctx, agent } = setup();
    const device = ctx.first('cmn_notif_device', `user=${agent}^primary_email=true`)!;
    expect(device.str('email_address')).toBe('abel.agent@example.com');
    ctx.update(ctx.get('sys_user', agent)!, { email: 'abel@northwind.example' });
    expect(ctx.get('cmn_notif_device', device.sysId)!.str('email_address')).toBe('abel@northwind.example');
  });
});

// ---------------------------------------------------------------------------------- recipients

describe('recipient resolution', () => {
  it('addresses users from fields, dot-walks and group members', () => {
    const { ctx, engine, agent, requester, group } = setup();
    const n = notification(ctx, { recipient_fields: 'assigned_to,opened_by.manager,assignment_group' });
    const t = ticket(ctx, { assigned_to: agent, opened_by: requester, assignment_group: group });
    const preview = engine.preview(ctx, n.sysId, t.sysId);
    expect(preview.recipients.map((r) => r.address).sort()).toEqual([
      'abel.agent@example.com',
      'ada.agent@example.com',
      'bella.boss@example.com',
    ]);
    expect(preview.recipients.find((r) => r.address === 'bella.boss@example.com')!.reason).toContain(
      'opened_by.manager',
    );
  });

  it('uses the group address only, unless members are included', () => {
    const { ctx, engine, group } = setup();
    ctx.update(ctx.get('sys_user_group', group)!, {
      email: 'desk@northwind.example',
      include_members: false,
    });
    const n = notification(ctx, { recipient_groups: group });
    const t = ticket(ctx);
    expect(engine.preview(ctx, n.sysId, t.sysId).recipients.map((r) => r.address)).toEqual([
      'desk@northwind.example',
    ]);
    ctx.update(ctx.get('sys_user_group', group)!, { include_members: true });
    expect(
      engine
        .preview(ctx, n.sysId, t.sysId)
        .recipients.map((r) => r.address)
        .sort(),
    ).toEqual(['abel.agent@example.com', 'ada.agent@example.com', 'desk@northwind.example']);
  });

  it('expands watch lists with users and raw addresses', () => {
    const { ctx, engine, agent } = setup();
    const n = notification(ctx, { recipient_fields: 'watch_list' });
    const t = ticket(ctx, { watch_list: `${agent},partner@vendor.example` });
    expect(
      engine
        .preview(ctx, n.sysId, t.sysId)
        .recipients.map((r) => r.address)
        .sort(),
    ).toEqual(['abel.agent@example.com', 'partner@vendor.example']);
  });

  it('honours notification settings, unsubscribes, inactive users and the event creator', () => {
    const { p, ctx, engine, agent, agent2, requester, boss } = setup();
    const n = notification(ctx, {
      recipient_users: [agent, agent2, requester, boss].join(','),
      send_self: false,
    });
    const t = ticket(ctx);
    ctx.update(ctx.get('sys_user', agent)!, { notification: 1 });
    ctx.update(ctx.get('sys_user', agent2)!, { active: false });
    ctx.insert('cmn_notif_message', { user: requester, notification: n.sysId, active: false });
    const asBoss = p.contextAs(boss);
    const r = engine.preview(asBoss, n.sysId, t.sysId);
    expect(r.recipients).toEqual([]);
    expect(r.excluded.map((x) => x.reason).sort()).toEqual([
      'Email notifications are turned off for this user',
      'Triggered the notification and "Send to event creator" is off',
      'Unsubscribed from this notification',
      'User is inactive',
    ]);
    // Forced delivery ignores the user switch; mandatory ignores the unsubscribe.
    ctx.update(n, { force_delivery: true, mandatory: true, send_self: true });
    const forced = engine
      .preview(asBoss, n.sysId, t.sysId)
      .recipients.map((x) => x.address)
      .sort();
    expect(forced).toEqual([
      'abel.agent@example.com',
      'bella.boss@example.com',
      'rita.requester@example.com',
    ]);
  });

  it('adds active notification delegates unless delegates are excluded', () => {
    const { ctx, engine, agent, agent2 } = setup();
    ctx.insert('sys_user_delegate', { user: agent, delegate: agent2, notifications: true });
    const n = notification(ctx, { recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { assigned_to: agent });
    expect(
      engine
        .preview(ctx, n.sysId, t.sysId)
        .recipients.map((r) => r.address)
        .sort(),
    ).toEqual(['abel.agent@example.com', 'ada.agent@example.com']);
    ctx.update(n, { exclude_delegates: true });
    expect(engine.preview(ctx, n.sysId, t.sysId).recipients.map((r) => r.address)).toEqual([
      'abel.agent@example.com',
    ]);
  });

  it('reads recipients from event parameters', () => {
    const { p, ctx, requester } = setup();
    const n = notification(ctx, {
      generation_type: 'event',
      event_name: 'x_ticket.escalated',
      event_parm_1: true,
    });
    const t = ticket(ctx);
    ctx.queueEvent('x_ticket.escalated', t, `${requester},ext@partner.example`, '');
    p.drain();
    const [email] = emailsFor(ctx, t);
    expect(addresses(email)).toEqual(['ext@partner.example', 'rita.requester@example.com']);
    expect(ctx.count('sys_email_log', `email=${email.sysId}^notification=${n.sysId}`)).toBe(1);
  });

  it('addresses every group member for approval notifications and skips users without an address', () => {
    const { p, ctx, engine, group, agent } = setup();
    ctx.update(ctx.get('sys_user_group', group)!, {
      email: 'desk@northwind.example',
      include_members: false,
    });
    const silent = makeUser(p, 'sam.silent', [], ['Service Desk']);
    ctx.update(ctx.get('sys_user', silent)!, { email: '' });
    const n = notification(ctx, {
      collection: 'sysapproval_approver',
      recipient_groups: group,
      subject: 'Approve',
    });
    const approval = ctx.insert('sysapproval_approver', { approver: agent, state: 'not requested' });
    const r = engine.preview(ctx, n.sysId, approval.sysId);
    expect(r.recipients.map((x) => x.address).sort()).toEqual([
      'abel.agent@example.com',
      'ada.agent@example.com',
      'desk@northwind.example',
    ]);
    expect(r.excluded).toEqual([expect.objectContaining({ userId: silent, reason: 'No email address' })]);
  });
});

// ---------------------------------------------------------------------------------- rendering

describe('template rendering', () => {
  it('expands fields, dot-walks, links, journals and mail scripts', () => {
    const { ctx, engine, agent, requester } = setup();
    const t = ticket(ctx, {
      short_description: 'Laptop <b>overheats</b> ${number}',
      assigned_to: agent,
      opened_by: requester,
    });
    for (const c of ['First update', 'Second update', 'Third update']) ctx.update(t, { comments: c });
    const out = engine.render(
      ctx,
      '${number}|${short_description}|${assigned_to.name}|${opened_by.manager.name}|${URI_REF}|${URI}|${assigned_to.URI_REF}|${comments:2}|${nope}|${opened_at}',
      t,
    );
    const parts = out.split('|');
    expect(parts[0]).toBe(t.str('number'));
    expect(parts[1]).toBe('Laptop &lt;b&gt;overheats&lt;/b&gt; ${number}');
    expect(parts[2]).toBe('abel agent');
    expect(parts[3]).toBe('bella boss');
    expect(parts[4]).toBe(
      `<a href="https://resolvr.test/workspace/record/x_ticket/${t.sysId}" style="color:#1f5fbf;text-decoration:underline;">${t.str('number')}</a>`,
    );
    expect(parts[5]).toContain('>LINK</a>');
    expect(parts[6]).toContain(`/workspace/record/sys_user/${agent}`);
    expect(parts[6]).toContain('>abel agent</a>');
    expect(parts[7]).toContain('Third update');
    expect(parts[7]).toContain('Second update');
    expect(parts[7]).not.toContain('First update');
    expect(parts[8]).toBe('');
    expect(parts[9]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);

    const scripts = engine.render(ctx, '${mail_script:comments_history}${mail_script:record_summary}', t);
    expect(scripts).toContain('Recent comments');
    expect(scripts).toContain('Third update');
    expect(scripts).toContain(`View ${t.str('number')}`);
    expect(engine.renderText(ctx, 'Hello ${short_description}', t)).toBe(
      'Hello Laptop <b>overheats</b> ${number}',
    );
  });

  it('falls back to the template and wraps the body in its layout', () => {
    const { p, ctx, agent } = setup();
    const layout = ctx.insert('sys_email_layout', {
      name: 'Bare',
      layout: '<header/>${notification:body}<footer/>',
    });
    const tpl = ctx.insert('sysevent_email_template', {
      name: 'ticket.updated',
      collection: 'x_ticket',
      subject: '${number} updated',
      message_html: '<p>Hi ${assigned_to.first_name}</p>',
      email_layout: layout.sysId,
    });
    notification(ctx, {
      subject: '',
      message_html: '',
      template: tpl.sysId,
      recipient_fields: 'assigned_to',
      action_insert: true,
      condition: 'priority=5',
    });
    notification(ctx, {
      subject: 'Hi',
      message_html: '',
      template: tpl.sysId,
      recipient_fields: 'assigned_to',
      action_insert: true,
      condition: 'priority=4',
    });
    const t = ticket(ctx, { assigned_to: agent, priority: 5 });
    const t2 = ticket(ctx, { assigned_to: agent, priority: 4 });
    p.drain();
    const [email] = emailsFor(ctx, t);
    expect(email.str('subject')).toBe(`${t.str('number')} updated`);
    expect(email.str('body')).toMatch(
      /^<header\/><p>Hi abel<\/p><footer\/>\n<div style="display:inline;[^"]*">Ref:MSG\d{7}_[A-Za-z0-9]{20}<\/div>$/,
    );
    expect(emailsFor(ctx, t2)[0].str('subject')).toBe('Hi');
  });

  it('uses the branded default layout when there is no template', () => {
    const { p, ctx, agent } = setup();
    notification(ctx, {
      recipient_fields: 'assigned_to',
      action_insert: true,
      message_html: '<p>${short_description}</p>',
    });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const body = emailsFor(ctx, t)[0].str('body');
    expect(body).toContain('<html lang="en">');
    expect(body).toContain('<span style="color:#1f5fbf;">Resolvr</span>Now');
    expect(body).toContain('<p>Printer jams on floor 2</p>');
    expect(body).toContain('Manage your email preferences');
    expect(body.indexOf('Ref:MSG')).toBeLessThan(body.indexOf('</body>'));
  });

  it('limits journal variables to glide.email.journal.lines entries by default', () => {
    const { ctx, engine } = setup();
    const t = ticket(ctx);
    for (const note of ['n1', 'n2', 'n3', 'n4', 'n5']) ctx.update(t, { work_notes: note });
    const out = engine.renderText(ctx, '${work_notes}', t);
    expect(out.match(/\(Work notes\)/g)).toHaveLength(3);
    expect(out).toContain('n5');
    expect(out).not.toContain('n2');
    ctx.platform.properties.set('glide.email.journal.lines', '-1');
    expect(engine.renderText(ctx, '${work_notes}', t).match(/\(Work notes\)/g)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------- triggers

describe('notification triggers', () => {
  it('fires record notifications on insert when the condition matches', () => {
    const { ctx, agent } = setup();
    notification(ctx, { action_insert: true, condition: 'priority=1', recipient_fields: 'assigned_to' });
    const p1 = ticket(ctx, { priority: 1, assigned_to: agent });
    const p3 = ticket(ctx, { priority: 3, assigned_to: agent });
    const [email] = emailsFor(ctx, p1);
    expect(email.str('type')).toBe('send-ready');
    expect(email.str('state')).toBe('ready');
    expect(email.display('mailbox')).toBe('Outbox');
    expect(email.str('target_table')).toBe('x_ticket');
    expect(addresses(email)).toEqual(['abel.agent@example.com']);
    expect(emailsFor(ctx, p3)).toHaveLength(0);
  });

  it('evaluates change operators against the previous values', () => {
    const { p, ctx, agent } = setup();
    notification(ctx, { action_update: true, condition: 'stateCHANGESTO3', recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { state: '2', assigned_to: agent });
    p.drain();
    expect(emailsFor(ctx, t)).toHaveLength(0);
    ctx.update(t, { state: '3' });
    p.drain();
    expect(emailsFor(ctx, t)).toHaveLength(1);
    ctx.update(t, { short_description: 'still closed' });
    p.drain();
    expect(emailsFor(ctx, t)).toHaveLength(1);
  });

  it('detects journal entries added by the update', () => {
    const { p, ctx, agent } = setup();
    notification(ctx, {
      action_update: true,
      condition: 'commentsVALCHANGES',
      recipient_fields: 'assigned_to',
      message_html: '${comments:1}',
    });
    const t = ticket(ctx, { assigned_to: agent });
    ctx.update(t, { priority: 2 });
    p.drain();
    expect(emailsFor(ctx, t)).toHaveLength(0);
    ctx.update(t, { comments: 'Toner replaced' });
    p.drain();
    const emails = emailsFor(ctx, t);
    expect(emails).toHaveLength(1);
    expect(emails[0].str('body')).toContain('Toner replaced');
  });

  it('fires event notifications and links the email to its notification and event', () => {
    const { p, ctx, agent } = setup();
    const n = notification(ctx, {
      generation_type: 'event',
      event_name: 'x_ticket.commented',
      recipient_fields: 'assigned_to',
      subject: 'Comment on ${number} by ${event.parm2}',
    });
    const t = ticket(ctx, { assigned_to: agent });
    ctx.queueEvent('x_ticket.commented', t, 'someone', 'Rita');
    ctx.queueEvent('x_ticket.other', t, '', '');
    p.drain();
    const emails = emailsFor(ctx, t);
    expect(emails).toHaveLength(1);
    expect(emails[0].str('subject')).toBe(`Comment on ${t.str('number')} by Rita`);
    const event = ctx.first('sysevent', 'name=x_ticket.commented')!;
    expect(event.str('state')).toBe('processed');
    expect(
      ctx.count('sys_email_log', `email=${emails[0].sysId}^notification=${n.sysId}^event=${event.sysId}`),
    ).toBe(1);
  });

  it('requires the advanced condition too, and fails closed without a script engine', () => {
    const { p, ctx, agent } = setup();
    notification(ctx, {
      action_insert: true,
      condition: 'priority=1',
      advanced_condition: 'answer = current.short_description.indexOf("VIP") >= 0;',
      recipient_fields: 'assigned_to',
    });
    const before = ticket(ctx, { priority: 1, assigned_to: agent, short_description: 'VIP printer' });
    expect(emailsFor(ctx, before)).toHaveLength(0);
    p.services.set(SERVICES.scripts, {
      run: () => undefined,
      condition: (_c: Context, _script: string, current: Rec | null) =>
        !!current?.str('short_description').includes('VIP'),
    });
    const vip = ticket(ctx, { priority: 1, assigned_to: agent, short_description: 'VIP printer' });
    const other = ticket(ctx, { priority: 1, assigned_to: agent, short_description: 'Printer' });
    expect(emailsFor(ctx, vip)).toHaveLength(1);
    expect(emailsFor(ctx, other)).toHaveLength(0);
  });

  it('does not notify for writes without workflow, nor for inactive notifications', () => {
    const { p, ctx, agent } = setup();
    const n = notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const quiet = ctx.derive({ workflow: false });
    const t1 = quiet.insert('x_ticket', { short_description: 'imported', assigned_to: agent });
    ctx.update(n, { active: false });
    const t2 = ticket(ctx, { assigned_to: agent });
    p.drain();
    expect(emailsFor(ctx, t1)).toHaveLength(0);
    expect(emailsFor(ctx, t2)).toHaveLength(0);
  });

  it('refuses notifications on the task table', () => {
    const { ctx } = setup();
    expect(() => notification(ctx, { collection: 'task' })).toThrow(InvalidError);
  });

  it('splits large recipient lists into several emails', () => {
    const { p, ctx, group } = setup();
    for (const u of ['uma.one', 'ulf.two', 'una.three']) makeUser(p, u, [], ['Service Desk']);
    p.properties.set('glide.email.smtp.max_recipients', '2');
    notification(ctx, { action_insert: true, recipient_groups: group });
    const t = ticket(ctx);
    p.drain();
    expect(
      emailsFor(ctx, t)
        .map((e) => addresses(e).length)
        .sort(),
    ).toEqual([1, 2, 2]);
  });

  it('serves the NotificationService contract to other modules', () => {
    const { ctx, p, agent, group } = setup();
    const svc = optionalService<NotificationService>(p, SERVICES.notifications)!;
    const t = ticket(ctx);
    const email = svc.send(ctx, {
      to: [agent, 'outside@vendor.example'],
      cc: [group],
      subject: 'Heads up',
      body: '<p>Please check</p>',
      target: t,
    })!;
    expect(email.str('type')).toBe('send-ready');
    expect(addresses(email)).toEqual(['abel.agent@example.com', 'outside@vendor.example']);
    expect(email.str('copied')).toBe('ada.agent@example.com');
    expect(email.str('body')).toMatch(WATERMARK);
    expect(svc.render(ctx, '${number} / ${short_description}', t)).toBe(
      `${t.str('number')} / Printer jams on floor 2`,
    );
    expect(svc.send(ctx, { to: [], subject: 'x', body: 'y' })).toBeNull();
    expect(svc.send(ctx, { to: [agent], subject: 'R&amp;D update', body: '<p>x</p>' })!.str('subject')).toBe(
      'R&D update',
    );
  });

  it('lets a configured event notification replace a module email for the same event', () => {
    const { ctx, p, agent } = setup();
    const svc = optionalService<NotificationService>(p, SERVICES.notifications)!;
    const t = ticket(ctx);
    const mail = {
      to: [agent],
      subject: 'SLA at 75%',
      body: '<p>Hurry</p>',
      target: t,
      notification: 'x_ticket.sla.75',
    };
    expect(svc.send(ctx, mail)).not.toBeNull();
    notification(ctx, {
      generation_type: 'event',
      event_name: 'x_ticket.sla.75',
      recipient_fields: 'assigned_to',
    });
    expect(svc.send(ctx, mail)).toBeNull();
    expect(svc.send(ctx, { ...mail, notification: 'x_ticket.other' })).not.toBeNull();
  });

  it('renders link variables as bare URLs inside href attributes', () => {
    const { ctx, engine } = setup();
    const t = ticket(ctx);
    const out = engine.render(ctx, '<p><a href="${URI_REF}">Open ${number}</a></p>', t);
    expect(out).toBe(
      `<p><a href="https://resolvr.test/workspace/record/x_ticket/${t.sysId}">Open ${t.str('number')}</a></p>`,
    );
  });
});

// ---------------------------------------------------------------------------------- outbound

describe('sys_email lifecycle and transports', () => {
  it('delivers through the log transport and shows emails in the activity stream', async () => {
    const { p, ctx, engine, log, agent } = setup();
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to', importance: 'high' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const result = await engine.processOutbox();
    expect(result.sent).toBe(1);
    const [email] = emailsFor(ctx, t);
    expect(email.str('type')).toBe('sent');
    expect(email.str('state')).toBe('processed');
    expect(email.display('mailbox')).toBe('Sent');
    expect(email.num('resolvr_attempts')).toBe(1);
    const msg = log.sent[0];
    expect(msg.to).toEqual(['abel.agent@example.com']);
    expect(msg.from).toBe('"ResolvrNow" <help@resolvr.test>');
    expect(msg.messageId).toBe(email.str('message_id'));
    expect(msg.headers['Auto-Submitted']).toBe('auto-generated');
    expect(msg.headers.Importance).toBe('high');
    expect(msg.html).toContain('Ref:MSG');
    expect(msg.text).toBeUndefined();
    const activity = activityFor(ctx, t).filter((i) => i.type === 'email');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ subject: email.str('subject'), direction: 'sent' });
    expect(ctx.count('syslog_email', `email=${email.sysId}^messageSTARTSWITHIncluded`)).toBe(1);
  });

  it('selects the transport from properties and environment variables', async () => {
    const { p, ctx, engine, agent } = setup();
    engine.setTransport(null);
    expect(engine.transport()?.name).toBe('log');
    p.properties.set('resolvr.email.transport', 'smtp');
    const saved = process.env.RESOLVRNOW_SMTP_HOST;
    delete process.env.RESOLVRNOW_SMTP_HOST;
    try {
      expect(engine.transport()).toBeNull();
      notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
      const t = ticket(ctx, { assigned_to: agent });
      expect((await engine.processOutbox()).sent).toBe(0);
      expect(emailsFor(ctx, t)[0].str('type')).toBe('send-ready');
      p.properties.set('resolvr.email.smtp.host', 'smtp.from-property.example');
      expect(engine.transport()?.name).toBe('smtp');
      process.env.RESOLVRNOW_SMTP_HOST = 'smtp.from-env.example';
      expect(smtpConfig(p)).toMatchObject({
        host: 'smtp.from-env.example',
        port: 587,
        secure: false,
        from: 'help@resolvr.test',
      });
    } finally {
      if (saved === undefined) delete process.env.RESOLVRNOW_SMTP_HOST;
      else process.env.RESOLVRNOW_SMTP_HOST = saved;
      engine.transport()?.close?.();
    }
  });

  it('keeps email in the outbox while sending is disabled', async () => {
    const { p, ctx, engine, agent } = setup();
    p.properties.set('glide.email.smtp.active', 'false');
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    expect((await engine.processOutbox()).sent).toBe(0);
    expect(emailsFor(ctx, t)[0].str('type')).toBe('send-ready');
  });

  it('sends over SMTP with nodemailer, retries 4xx with backoff and fails on 5xx', async () => {
    const { p, ctx, engine, agent } = setup();
    clock.freeze('2026-03-02 09:00:00');
    const delivered: { envelope: { from: string; to: string[] }; raw: string }[] = [];
    let failure: { responseCode: number; message: string } | null = null;
    let calls = 0;
    const plugin = {
      name: 'test-transport',
      version: '1.0.0',
      send(
        mail: {
          message: {
            getEnvelope(): { from: string; to: string[] };
            build(cb: (err: Error | null, buf: Buffer) => void): void;
          };
        },
        cb: (err: Error | null, info?: unknown) => void,
      ) {
        calls++;
        if (failure) {
          cb(Object.assign(new Error(failure.message), { responseCode: failure.responseCode }));
          return;
        }
        const envelope = mail.message.getEnvelope();
        mail.message.build((err, buf) => {
          if (err) return cb(err);
          delivered.push({ envelope, raw: buf.toString('utf8') });
          cb(null, { envelope, messageId: 'ok', response: '250 2.0.0 queued' });
        });
      },
    };
    engine.setTransport(smtpTransportFromPlugin(plugin));
    notification(ctx, {
      action_insert: true,
      recipient_fields: 'assigned_to',
      subject: 'Ticket ${number} assigned',
    });
    const ok = ticket(ctx, { assigned_to: agent });
    p.drain();
    await engine.processOutbox();
    const sent = emailsFor(ctx, ok)[0];
    expect(sent.str('type')).toBe('sent');
    expect(sent.str('status')).toContain('250 2.0.0 queued');
    expect(delivered[0].envelope).toEqual({ from: 'help@resolvr.test', to: ['abel.agent@example.com'] });
    expect(delivered[0].raw).toContain(`Subject: Ticket ${ok.str('number')} assigned`);
    expect(delivered[0].raw).toContain(`Message-ID: ${sent.str('message_id')}`);
    expect(delivered[0].raw).toMatch(/X-ResolvrNow-Watermark: Ref:MSG\d{7}_/i);
    expect(delivered[0].raw).toMatch(/^Auto-Submitted: auto-generated/m);

    failure = { responseCode: 451, message: '451 4.3.0 Mailbox busy, try later' };
    const later = ticket(ctx, { assigned_to: agent });
    p.drain();
    await engine.processOutbox();
    let email = emailsFor(ctx, later)[0];
    expect(email.str('type')).toBe('send-retry-backoff');
    expect(email.str('state')).toBe('ready');
    expect(email.str('resolvr_next_attempt')).toBe('2026-03-02 09:01:00');
    expect(email.str('error_string')).toContain('451');
    const before = calls;
    await engine.processOutbox();
    expect(calls).toBe(before);
    clock.advance(60_000);
    await engine.processOutbox();
    email = ctx.get('sys_email', email.sysId)!;
    expect(email.num('resolvr_attempts')).toBe(2);
    expect(email.str('resolvr_next_attempt')).toBe('2026-03-02 09:06:00');
    failure = { responseCode: 550, message: '550 5.1.1 No such user' };
    clock.advance(5 * 60_000);
    const r = await engine.processOutbox();
    expect(r.failed).toBe(1);
    email = ctx.get('sys_email', email.sysId)!;
    expect(email.str('type')).toBe('send-failed');
    expect(email.str('state')).toBe('error');
    expect(email.display('mailbox')).toBe('Failed');
    expect(email.str('error_string')).toContain('550');
  });

  it('stops retrying once the retry window has elapsed', async () => {
    const { p, ctx, engine, agent } = setup();
    clock.freeze('2026-03-02 09:00:00');
    engine.setTransport({
      name: 'flaky',
      send: () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    });
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    await engine.processOutbox();
    expect(emailsFor(ctx, t)[0].str('type')).toBe('send-retry-backoff');
    clock.advance(25 * 3_600_000);
    await engine.processOutbox();
    const email = emailsFor(ctx, t)[0];
    expect(email.str('type')).toBe('send-failed');
    expect(email.str('error_string')).toContain('Retry window elapsed');
  });

  it('suppresses duplicates by weight and identical content', async () => {
    const { p, ctx, engine, agent } = setup();
    notification(ctx, {
      action_update: true,
      condition: 'stateCHANGESTO3',
      recipient_fields: 'assigned_to',
      weight: 10,
      subject: 'Commented',
    });
    notification(ctx, {
      action_update: true,
      condition: 'stateCHANGESTO3',
      recipient_fields: 'assigned_to',
      weight: 20,
      subject: 'Closed',
    });
    notification(ctx, {
      action_update: true,
      condition: 'stateCHANGESTO4',
      recipient_fields: 'assigned_to',
      subject: 'Zero A',
    });
    notification(ctx, {
      action_update: true,
      condition: 'stateCHANGESTO4',
      recipient_fields: 'assigned_to',
      subject: 'Zero B',
    });
    notification(ctx, {
      action_update: true,
      condition: 'stateCHANGESTO7',
      recipient_fields: 'assigned_to',
      weight: 5,
      subject: 'Same',
    });
    notification(ctx, {
      action_update: true,
      condition: 'stateCHANGESTO7',
      recipient_fields: 'assigned_to',
      weight: 5,
      subject: 'Same',
    });
    const closed = ticket(ctx, { assigned_to: agent });
    const incomplete = ticket(ctx, { assigned_to: agent });
    const skipped = ticket(ctx, { assigned_to: agent });
    ctx.update(closed, { state: '3' });
    ctx.update(incomplete, { state: '4' });
    ctx.update(skipped, { state: '7' });
    p.drain();
    await engine.processOutbox();
    const byType = (t: Rec) =>
      emailsFor(ctx, t)
        .map((e) => `${e.str('subject')}:${e.str('type')}`)
        .sort();
    expect(byType(closed)).toEqual(['Closed:sent', 'Commented:send-ignored']);
    expect(byType(incomplete)).toEqual(['Zero A:sent', 'Zero B:sent']);
    expect(byType(skipped)).toEqual(['Same:send-ignored', 'Same:sent']);
    const ignored = emailsFor(ctx, closed, 'send-ignored')[0];
    expect(ignored.str('error_string')).toBe(`Duplicate of ${emailsFor(ctx, closed, 'sent')[0].sysId}`);
    expect(ignored.display('mailbox')).toBe('Skipped');
  });

  it('watermarks every notification email and records the target', () => {
    const { p, ctx, agent } = setup();
    const n = notification(ctx, {
      action_insert: true,
      recipient_fields: 'assigned_to',
      content_type: 'multipart/alternative',
    });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const email = emailsFor(ctx, t)[0];
    const label = WATERMARK.exec(email.str('body'))![1];
    expect(email.str('body_text').trimEnd().endsWith(`Ref:${label}`)).toBe(true);
    expect(email.str('body')).toContain('<div style="display:inline;');
    const wm = ctx.first('sys_watermark', `number=${label}`)!;
    expect(wm.str('source_table')).toBe('x_ticket');
    expect(wm.str('source_id')).toBe(t.sysId);
    expect(wm.str('email')).toBe(email.sysId);

    p.properties.set('glide.email.watermark.visible', 'false');
    const t2 = ticket(ctx, { assigned_to: agent });
    p.drain();
    const hidden = emailsFor(ctx, t2)[0];
    expect(hidden.str('body')).toContain('<div style="display:none;');
    expect(hidden.str('body_text')).toMatch(WATERMARK);

    ctx.update(n, { omit_watermark: true });
    const t3 = ticket(ctx, { assigned_to: agent });
    p.drain();
    expect(emailsFor(ctx, t3)[0].str('body')).not.toContain('Ref:');
  });

  it('restricts who can read emails of a restricted notification', () => {
    const { p, ctx, agent, agent2 } = setup();
    const n = notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    ctx.insert('email_access_restriction', { notification: n.sysId, conditions: 'vip=true' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const email = emailsFor(ctx, t)[0];
    ctx.update(ctx.get('sys_user', agent2)!, { vip: true });
    expect(p.contextAs(agent).get('sys_email', email.sysId)).toBeNull();
    expect(p.contextAs(agent2).get('sys_email', email.sysId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------- digests

describe('digests', () => {
  it('collects occurrences per record and sends them after the interval', () => {
    const { p, ctx, engine, agent } = setup();
    clock.freeze('2026-03-02 09:00:00');
    const hourly = ctx.first('sys_email_digest_interval', 'name=Every hour')!;
    const n = notification(ctx, {
      action_update: true,
      condition: 'commentsVALCHANGES',
      recipient_fields: 'assigned_to',
      digestable: true,
      digest_type: 'single',
      digest_subject: 'Updates on ${number}',
      digest_html: '<p>${comments:1}</p>',
    });
    ctx.insert('cmn_notif_message', {
      user: agent,
      notification: n.sysId,
      active: true,
      digest: true,
      digest_interval: hourly.sysId,
    });
    const t1 = ticket(ctx, { assigned_to: agent });
    const t2 = ticket(ctx, { assigned_to: agent });
    for (const c of ['a1', 'a2', 'a3']) ctx.update(t1, { comments: c });
    for (const c of ['b1', 'b2']) ctx.update(t2, { comments: c });
    p.drain();
    expect(emailsFor(ctx, t1)).toHaveLength(0);
    expect(engine.processDigests()).toBe(0);
    clock.advance(3_600_000);
    expect(engine.processDigests()).toBe(2);
    const d1 = emailsFor(ctx, t1)[0];
    expect(d1.str('subject')).toBe(`Updates on ${t1.str('number')}`);
    expect(d1.str('body')).toContain('a1');
    expect(d1.str('body')).toContain('a3');
    expect(d1.str('body').split('<hr>').length).toBe(3);
    expect(emailsFor(ctx, t2)[0].str('body').split('<hr>').length).toBe(2);
    expect(engine.processDigests()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------- inbound

function replyText(body: string, email: Rec): string {
  return `${body}\n\nOn Mon, 2 Mar 2026, ResolvrNow wrote:\n> ${email.str('body_text').split('\n').join('\n> ')}`;
}

describe('inbound email', () => {
  it('threads replies by watermark and adds the reply as a comment from the sender', () => {
    const { p, ctx, engine, agent, requester } = setup();
    notification(ctx, { action_insert: true, recipient_fields: 'opened_by' });
    const t = ticket(ctx, { opened_by: requester, assigned_to: agent });
    p.drain();
    const out = emailsFor(ctx, t)[0];
    const r = engine.inbound.receive({
      from: '"Rita Requester" <rita.requester@example.com>',
      to: 'help@resolvr.test',
      subject: 'Thanks',
      text: replyText('It works again, thank you!', out),
    });
    expect(r).toMatchObject({
      receive_type: 'reply',
      state: 'processed',
      target_table: 'x_ticket',
      target_sys_id: t.sysId,
      user_id: requester,
    });
    expect(r.actions).toEqual(['Comment from reply']);
    const comments = p.history.journal('x_ticket', t.sysId, ['comments']);
    expect(comments).toHaveLength(1);
    expect(comments[0].value).toBe('reply from: rita.requester@example.com\n\nIt works again, thank you!');
    expect(comments[0].sys_created_by).toBe('rita.requester');
    const inbound = ctx.get('sys_email', r.sys_id)!;
    expect(inbound.str('type')).toBe('received');
    expect(inbound.display('mailbox')).toBe('Inbox');
    expect(inbound.str('instance')).toBe(t.sysId);
  });

  it('accepts provider-shaped payloads with CRLF bodies and quoted replies', () => {
    const { p, ctx, engine, agent } = setup();
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const mark = WATERMARK.exec(emailsFor(ctx, t)[0].str('body_text'))![0];
    const r = engine.inbound.receive({
      from: { address: 'abel.agent@example.com', name: 'Abel Agent' },
      to: [{ address: 'help@resolvr.test' }],
      subject: 'Re: your ticket',
      text: `Replaced the fuser.\r\n\r\nOn Tue, 3 Mar 2026 at 10:00, ResolvrNow wrote:\r\n> ${mark}\r\n`,
      html: '<p onclick="steal()">Replaced the fuser.</p><script>alert(1)</script>',
      headers: [{ name: 'Message-ID', value: '<abc@mail.example>' }],
    });
    expect(r).toMatchObject({ receive_type: 'reply', target_sys_id: t.sysId, user_id: agent });
    expect(p.history.journal('x_ticket', t.sysId, ['comments'])[0].value).toBe(
      'reply from: abel.agent@example.com\n\nReplaced the fuser.',
    );
    const stored = ctx.get('sys_email', r.sys_id)!;
    expect(stored.str('message_id')).toBe('<abc@mail.example>');
    expect(stored.str('body')).toBe('<p>Replaced the fuser.</p>');
  });

  it('uses the last watermark in the body', () => {
    const { p, ctx, engine, agent } = setup();
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const t1 = ticket(ctx, { assigned_to: agent });
    const t2 = ticket(ctx, { assigned_to: agent });
    p.drain();
    const w1 = WATERMARK.exec(emailsFor(ctx, t1)[0].str('body_text'))![0];
    const w2 = WATERMARK.exec(emailsFor(ctx, t2)[0].str('body_text'))![0];
    const r = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: 'both',
      text: `Done.\n${w1}\nand\n${w2}`,
    });
    expect(r.target_sys_id).toBe(t2.sysId);
  });

  it('threads by In-Reply-To and by record number after a reply prefix', () => {
    const { p, ctx, engine, agent } = setup();
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const out = emailsFor(ctx, t)[0];
    const viaHeader = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: 'no marker',
      text: 'On it.',
      inReplyTo: out.str('message_id'),
    });
    expect(viaHeader).toMatchObject({ receive_type: 'reply', target_sys_id: t.sysId });
    expect(viaHeader.matched_by).toContain('In-Reply-To');

    const number = t.str('number');
    expect(
      engine.inbound.receive({
        from: 'abel.agent@example.com',
        subject: `RE: about ${number}`,
        text: 'Update',
      }),
    ).toMatchObject({
      receive_type: 'reply',
      target_sys_id: t.sysId,
    });
    expect(
      engine.inbound.receive({
        from: 'abel.agent@example.com',
        subject: `Re: about ${number}`,
        text: 'Update',
      }).receive_type,
    ).toBe('new');
    expect(
      engine.inbound.receive({
        from: 'abel.agent@example.com',
        subject: `RE: Example "${number}"`,
        text: 'Update',
      }).receive_type,
    ).toBe('new');
  });

  it('treats forwards as new even with a watermark, and creates an incident for new email', () => {
    const { p, ctx, engine, agent, requester } = setup();
    notification(ctx, { action_insert: true, recipient_fields: 'assigned_to' });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const mark = WATERMARK.exec(emailsFor(ctx, t)[0].str('body_text'))![0];
    const fwd = engine.inbound.receive({
      from: 'rita.requester@example.com',
      subject: 'FW: printer problem',
      text: `See below.\n\n---------- Forwarded message ---------\nFrom: Help Desk <help@resolvr.test>\n${mark}`,
    });
    expect(fwd.receive_type).toBe('forward');
    expect(fwd.target_table).toBe('incident');
    expect(fwd.actions).toEqual(['Create incident from forwarded email']);

    const created = engine.inbound.receive({
      from: 'Rita Requester <rita.requester@example.com>',
      subject: 'VPN keeps dropping',
      text: 'Since this morning.',
    });
    expect(created).toMatchObject({
      receive_type: 'new',
      target_table: 'incident',
      actions: ['Create incident from email'],
    });
    const inc = ctx.get('incident', created.target_sys_id!)!;
    expect(inc.str('caller_id')).toBe(requester);
    expect(inc.str('opened_by')).toBe(requester);
    expect(inc.str('short_description')).toBe('VPN keeps dropping');
    expect(inc.str('description')).toBe('Since this morning.');
    expect(inc.str('contact_type')).toBe('email');
  });

  it('processes unknown senders as guest, or creates them for trusted domains', () => {
    const { p, ctx, engine } = setup();
    const guest = ctx.first('sys_user', 'user_name=guest')!;
    const r = engine.inbound.receive({
      from: 'stranger@unknown.example',
      subject: 'Hello',
      text: 'Who are you?',
    });
    expect(r.user_id).toBe(guest.sysId);
    const inc = ctx.get('incident', r.target_sys_id!)!;
    expect(inc.str('caller_id')).toBe('');
    expect(inc.str('opened_by')).toBe(guest.sysId);

    p.properties.set('glide.pop3readerjob.create_caller', 'true');
    p.properties.set('glide.user.trusted_domain', 'company.example');
    const r2 = engine.inbound.receive({
      from: '"User, New" <new.user@company.example>',
      subject: 'Access',
      text: 'Please grant access',
    });
    const user = ctx.first('sys_user', 'user_name=new.user@company.example')!;
    expect(user.str('name')).toBe('New User');
    expect(ctx.get('incident', r2.target_sys_id!)!.str('caller_id')).toBe(user.sysId);
  });

  it('runs inbound actions in order with conditions, roles, field actions and stop processing', () => {
    const { ctx, engine } = setup();
    ctx.insert('sysevent_in_email_action', {
      name: 'Router changes',
      type: 'new',
      collection: 'x_ticket',
      order: 5,
      filter_condition: 'subjectSTARTSWITHchg:',
      template: 'short_description=Change: ${email.subject}^priority=1^description=${email.body.location}',
      stop_processing: true,
      active: true,
    });
    ctx.insert('sysevent_in_email_action', {
      name: 'Agents only',
      type: 'new',
      collection: 'x_ticket',
      order: 6,
      required_roles: 'itil',
      resolvr_handler: 'create_record',
      stop_processing: true,
      active: true,
    });
    const r = engine.inbound.receive({
      from: 'rita.requester@example.com',
      subject: 'chg: router',
      text: 'Please swap it.\nLocation: Building 4',
    });
    expect(r.actions).toEqual(['Router changes']);
    const t = ctx.get('x_ticket', r.target_sys_id!)!;
    expect(t.str('short_description')).toBe('Change: chg: router');
    expect(t.str('priority')).toBe('1');
    expect(t.str('description')).toBe('Building 4');
    expect(ctx.count('incident')).toBe(0);

    const asRequester = engine.inbound.receive({
      from: 'rita.requester@example.com',
      subject: 'Printer',
      text: 'Broken',
    });
    expect(asRequester.actions).toEqual(['Create incident from email']);
    expect(asRequester.log.some((l) => l.includes('Skipped "Agents only"'))).toBe(true);
    const asAgent = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: 'Printer',
      text: 'Broken',
    });
    expect(asAgent).toMatchObject({ target_table: 'x_ticket', actions: ['Agents only'] });
  });

  it('ignores auto-replies and processes email even when no action matches', () => {
    const { ctx, engine } = setup();
    const auto = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: 'Out of office',
      text: 'Back Monday',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    expect(auto).toMatchObject({ type: 'received-ignored', state: 'ignored' });
    expect(ctx.get('sys_email', auto.sys_id)!.display('mailbox')).toBe('Junk');
    for (const a of ctx.query('sysevent_in_email_action')) ctx.update(a, { active: false });
    const none = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: 'Hello',
      text: 'Nothing to do',
    });
    expect(none).toMatchObject({ state: 'processed', actions: [] });
  });

  it('decides approvals from replies through the approvals service', () => {
    const { p, ctx, engine, agent } = setup();
    const decisions: {
      approval: string;
      decision: ApprovalDecision;
      comments?: string;
      user: string;
      source?: string;
    }[] = [];
    p.services.set(SERVICES.approvals, {
      decide(
        c: Context,
        approval: Rec,
        decision: ApprovalDecision,
        comments?: string,
        opts?: { source?: string },
      ) {
        decisions.push({
          approval: approval.sysId,
          decision,
          comments,
          user: c.user.userName,
          source: opts?.source,
        });
      },
    });
    const t = ticket(ctx, { short_description: 'New laptop' });
    const approval = ctx.insert('sysapproval_approver', {
      approver: agent,
      state: 'requested',
      sysapproval: t.sysId,
    });
    p.drain();
    const [request] = emailsFor(ctx, approval);
    expect(request.str('subject')).toBe(`Approval needed for ${t.str('number')}`);
    expect(addresses(request)).toEqual(['abel.agent@example.com']);
    expect(request.str('body')).toContain('Approve</a>');
    const label = WATERMARK.exec(request.str('body_text'))![1];
    expect(request.str('body')).toContain(`Ref%3A${label}`);

    const stranger = engine.inbound.receive({
      from: 'ada.agent@example.com',
      subject: 'Re: approval',
      text: replyText('approve', request),
    });
    expect(stranger.log.some((l) => l.includes('not authorized'))).toBe(true);
    expect(decisions).toHaveLength(0);

    const r = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: `Re: ${t.str('number')} - approve`,
      text: replyText('Approve, budget is fine.', request),
    });
    expect(r).toMatchObject({
      receive_type: 'reply',
      target_table: 'sysapproval_approver',
      actions: ['Approval decision by reply'],
    });
    expect(decisions).toEqual([
      {
        approval: approval.sysId,
        decision: 'approved',
        comments: 'Approve, budget is fine.',
        user: 'abel.agent',
        source: 'email',
      },
    ]);

    p.services.delete(SERVICES.approvals);
    const missing = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: 'Re: decision',
      text: replyText('reject', request),
    });
    expect(missing.log.some((l) => l.includes('approvals module is not installed'))).toBe(true);
  });

  it('unsubscribes a user who replies to an unsubscribe link', () => {
    const { p, ctx, engine, agent } = setup();
    const n = notification(ctx, {
      action_insert: true,
      recipient_fields: 'assigned_to',
      message_html: '<p>${NOTIF_UNSUB+link_text="Stop these emails"}</p>',
    });
    const t = ticket(ctx, { assigned_to: agent });
    p.drain();
    const body = emailsFor(ctx, t)[0].str('body');
    expect(body).toContain('>Stop these emails</a>');
    const href = /href="(mailto:[^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    const url = new URL(href);
    const r = engine.inbound.receive({
      from: 'abel.agent@example.com',
      subject: url.searchParams.get('subject')!,
      text: url.searchParams.get('body')!,
    });
    expect(r.actions).toEqual(['Unsubscribe from notification']);
    expect(ctx.first('cmn_notif_message', `user=${agent}^notification=${n.sysId}`)!.bool('active')).toBe(
      false,
    );
    const t2 = ticket(ctx, { assigned_to: agent });
    p.drain();
    expect(emailsFor(ctx, t2)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------- UI and HTTP

describe('UI metadata, preview and HTTP endpoints', () => {
  let app: FastifyInstance | null = null;
  let dir = '';
  const ADMIN = `Basic ${Buffer.from('admin:admin-test-pw').toString('base64')}`;

  async function http(env: Env): Promise<FastifyInstance> {
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-notif-'));
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
    app = await buildApp(env.p, config);
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('declares the Email navigation, forms and the Preview action', () => {
    const { p, ctx, agent } = setup();
    const nav = p.navigation.find((a) => a.id === 'email')!;
    expect(nav.modules.map((m) => m.title)).toEqual(
      expect.arrayContaining(['Notifications', 'Templates', 'Outbox', 'Inbox', 'Inbound Actions']),
    );
    expect(p.forms.has('sysevent_email_action:default')).toBe(true);
    const missing: string[] = [];
    for (const form of notificationsModule.ui?.forms ?? []) {
      const cols = p.registry.table(form.table).columns;
      for (const s of form.sections)
        for (const f of [...(s.left ?? []), ...(s.right ?? []), ...(s.fields ?? [])])
          if (!cols.has(f)) missing.push(`${form.table}.${f}`);
      for (const rl of form.relatedLists ?? [])
        if (rl.field && !p.registry.table(rl.table).columns.has(rl.field))
          missing.push(`${rl.table}.${rl.field}`);
    }
    for (const list of notificationsModule.ui?.lists ?? []) {
      for (const f of list.columns)
        if (!p.registry.table(list.table).columns.has(f)) missing.push(`${list.table}.${f}`);
    }
    expect(missing).toEqual([]);
    const action = p.uiActions.get('sysevent_email_action.preview')!;
    expect(action.prompt?.[0].field).toBe('preview_record');
    const n = notification(ctx, { recipient_fields: 'assigned_to', subject: 'Preview of ${number}' });
    const t = ticket(ctx, { assigned_to: agent });
    const result = action.run(n, ctx, { preview_record: t.str('number') })!;
    expect(result.redirect).toMatch(/^\/workspace\/record\/resolvr_email_preview\/[0-9a-f]{32}$/);
    const preview = ctx.get('resolvr_email_preview', result.redirect!.split('/').pop()!)!;
    expect(preview.str('subject')).toBe(`Preview of ${t.str('number')}`);
    expect(preview.str('recipients')).toContain('abel.agent@example.com');
    expect(preview.str('body')).toContain('Printer jams on floor 2');
    expect(ctx.count('sys_email')).toBe(0);
  });

  it('enforces the inbound webhook secret', async () => {
    const env = setup();
    const a = await http(env);
    const payload = {
      from: 'rita.requester@example.com',
      to: 'help@resolvr.test',
      subject: 'Webhook',
      text: 'Hello',
    };
    const send = (headers: Record<string, string> = {}) =>
      a.inject({
        method: 'POST',
        url: '/api/app/email/inbound',
        headers: { 'content-type': 'application/json', ...headers },
        payload,
      });
    expect((await send()).statusCode).toBe(503);
    env.p.properties.set('resolvr.email.inbound_secret', 's3cret-token');
    const missing = await send();
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ status: 'failure', error: { message: 'Invalid webhook secret' } });
    expect((await send({ 'x-resolvr-webhook-secret': 'wrong' })).statusCode).toBe(401);
    const ok = await send({ 'x-resolvr-webhook-secret': 's3cret-token' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result).toMatchObject({
      receive_type: 'new',
      state: 'processed',
      target_table: 'incident',
    });
    expect(env.ctx.count('sys_email', 'type=received')).toBe(1);
  });

  it('stores webhook attachments on the record the email created', async () => {
    const env = setup();
    const a = await http(env);
    env.p.properties.set('resolvr.email.inbound_secret', 'abc');
    const res = await a.inject({
      method: 'POST',
      url: '/api/app/email/inbound',
      headers: { 'content-type': 'application/json', 'x-resolvr-webhook-secret': 'abc' },
      payload: {
        from: 'rita.requester@example.com',
        subject: 'Screen flickers',
        text: 'See the photos',
        attachments: [
          {
            filename: 'screen.txt',
            contentType: 'text/plain',
            content: Buffer.from('flicker').toString('base64'),
          },
          {
            filename: 'log.txt',
            contentType: 'text/plain',
            content: Buffer.from('error 42').toString('base64'),
          },
        ],
      },
    });
    const result = res.json().result;
    expect(result.target_table).toBe('incident');
    const files = env.ctx.query('sys_attachment', { query: `table_sys_id=${result.target_sys_id}` });
    expect(files.map((f) => f.str('file_name')).sort()).toEqual(['log.txt', 'screen.txt']);
    expect(env.ctx.count('sys_email_attachment', `email=${result.sys_id}`)).toBe(2);
  });

  it('previews notifications and manages preferences over HTTP', async () => {
    const env = setup();
    const a = await http(env);
    const n = notification(env.ctx, { recipient_fields: 'assigned_to', subject: '${number} preview' });
    const t = ticket(env.ctx, { assigned_to: env.agent });
    const res = await a.inject({
      method: 'POST',
      url: `/api/app/notification/${n.sysId}/preview`,
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      payload: { record: t.sysId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({
      subject: `${t.str('number')} preview`,
      recipients: [{ address: 'abel.agent@example.com' }],
    });

    const agentAuth = `Basic ${Buffer.from('abel.agent:Password1!').toString('base64')}`;
    const denied = await a.inject({
      method: 'POST',
      url: `/api/app/notification/${n.sysId}/preview`,
      headers: { authorization: agentAuth, 'content-type': 'application/json' },
      payload: { record: t.sysId },
    });
    expect(denied.statusCode).toBe(403);
    const prefs = await a.inject({
      method: 'GET',
      url: '/api/app/notification/preferences',
      headers: { authorization: agentAuth },
    });
    expect(prefs.json().result.notifications_enabled).toBe(true);
    const put = await a.inject({
      method: 'PUT',
      url: '/api/app/notification/preferences',
      headers: { authorization: agentAuth, 'content-type': 'application/json' },
      payload: { notifications_enabled: false, preferences: [{ notification: n.sysId, subscribed: false }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().result.notifications_enabled).toBe(false);
    expect(env.ctx.get('sys_user', env.agent)!.num('notification')).toBe(1);
    expect(
      env.ctx.first('cmn_notif_message', `user=${env.agent}^notification=${n.sysId}`)!.bool('active'),
    ).toBe(false);
  });

  it('rejects notifications on the task table through the REST API', async () => {
    const env = setup();
    const a = await http(env);
    const res = await a.inject({
      method: 'POST',
      url: '/api/now/table/sysevent_email_action',
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      payload: { name: 'Bad', collection: 'task' },
    });
    expect(res.statusCode).toBe(400);
  });
});
