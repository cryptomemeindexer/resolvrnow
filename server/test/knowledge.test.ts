import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionVisible } from '../src/api/app/ui.js';
import type { ServerConfig } from '../src/api/http.js';
import { buildApp } from '../src/app.js';
import type { Context } from '../src/engine/context.js';
import { AccessError, InvalidError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import type { Rec } from '../src/engine/record.js';
import { addMs, clock, newSysId, nowGlide } from '../src/engine/util.js';
import type { ApprovalDecision, ApprovalRequest, ApprovalService } from '../src/modules/contracts.js';
import { knowledgeModule } from '../src/modules/knowledge/index.js';
import { type KnowledgeService, knowledge } from '../src/modules/knowledge/service.js';
import { formatVersion } from '../src/modules/knowledge/util.js';
import { bootPlatform, makeUser } from './helpers.js';

// ---------------------------------------------------------------------- fixtures

/** In-memory approvals provider implementing the cross-module contract. */
class StubApprovals implements ApprovalService {
  requests: { target: string; req: ApprovalRequest }[] = [];
  cancelled: string[] = [];
  private handlers = new Map<string, (target: Rec, decision: ApprovalDecision, ctx: Context) => void>();

  request(_ctx: Context, target: Rec, req: ApprovalRequest): Rec[] {
    this.requests.push({ target: target.sysId, req });
    return [];
  }
  decide(): void {}
  cancel(_ctx: Context, target: Rec): void {
    this.cancelled.push(target.sysId);
  }
  stateOf(): string {
    return 'requested';
  }
  onDecision(table: string, handler: (target: Rec, decision: ApprovalDecision, ctx: Context) => void): void {
    this.handlers.set(table, handler);
  }
  /** Simulates the approver's decision. */
  fire(p: Platform, approver: string, sysId: string, decision: ApprovalDecision): void {
    const ctx = p.contextAs(approver);
    const rec = ctx.elevated().get('kb_knowledge', sysId)!;
    this.handlers.get(rec.className)!(rec, decision, ctx);
  }
}

interface Fx {
  p: Platform;
  svc: KnowledgeService;
  sys: Context;
  ids: Record<'olga' | 'mia' | 'ann' | 'ivan' | 'eve' | 'kim' | 'kurt' | 'gina', string>;
  criteria: Record<'employees' | 'itStaff' | 'agents', string>;
  /** "IT": approval publish and retire, 365 days validity, read by employees, contributed by IT staff. */
  it: string;
  /** "Public": instant publish and retire, no validity. */
  pub: string;
  approvals: StubApprovals | null;
  as: (user: string) => Context;
}

function fixture(opts: { approvals?: boolean } = {}): Fx {
  const p = bootPlatform([knowledgeModule]);
  const approvals = opts.approvals ? new StubApprovals() : null;
  if (approvals) p.services.set('approvals', approvals);
  const sys = p.systemContext();
  const ids = {
    olga: makeUser(p, 'olga.owner', ['knowledge']),
    mia: makeUser(p, 'mia.manager', ['knowledge']),
    ann: makeUser(p, 'ann.author', ['knowledge'], ['IT staff']),
    ivan: makeUser(p, 'ivan.agent', ['itil'], ['IT staff']),
    eve: makeUser(p, 'eve.employee'),
    kim: makeUser(p, 'kim.admin', ['knowledge_admin']),
    kurt: makeUser(p, 'kurt.kcs', ['kcs_contributor'], ['IT staff']),
    gina: makeUser(p, 'gina.docs', ['knowledge'], ['Docs Team']),
  };
  const role = (n: string) => sys.getBy('sys_user_role', 'name', n)!.sysId;
  const group = (n: string) => sys.getBy('sys_user_group', 'name', n)!.sysId;
  const criteria = {
    employees: sys.insert('user_criteria', { name: 'All employees', role: role('snc_internal') }).sysId,
    itStaff: sys.insert('user_criteria', { name: 'IT staff', group: group('IT staff') }).sysId,
    agents: sys.insert('user_criteria', { name: 'Agents', role: role('itil') }).sysId,
  };
  const base = (title: string, extra: Record<string, unknown>, read: string[], contribute: string[]) => {
    const kb = sys.insert('kb_knowledge_base', { title, owner: ids.olga, ...extra });
    for (const c of read)
      sys.insert('kb_uc_can_read_mtom', { kb_knowledge_base: kb.sysId, user_criteria: c });
    for (const c of contribute)
      sys.insert('kb_uc_can_contribute_mtom', { kb_knowledge_base: kb.sysId, user_criteria: c });
    return kb.sysId;
  };
  const it = base(
    'IT',
    {
      kb_managers: ids.mia,
      resolvr_publish_flow: 'approval',
      resolvr_retire_flow: 'approval',
      article_validity: 365,
    },
    [criteria.employees],
    [criteria.itStaff],
  );
  const pub = base(
    'Public',
    { resolvr_publish_flow: 'instant', resolvr_retire_flow: 'instant' },
    [criteria.employees],
    [criteria.itStaff],
  );
  return { p, svc: knowledge(p), sys, ids, criteria, it, pub, approvals, as: (u) => p.contextAs(u) };
}

const reload = (fx: Fx, id: string) => fx.sys.get('kb_knowledge', id)!;
const versionOf = (fx: Fx, id: string) => formatVersion(fx.svc.versionOf(reload(fx, id)));
const stateOf = (fx: Fx, id: string) => reload(fx, id).str('workflow_state');

/** Inserts and publishes an article as the system (instant, no approval). */
function published(
  fx: Fx,
  kb: string,
  title: string,
  html: string,
  extra: Record<string, unknown> = {},
): Rec {
  const rec = fx.sys.insert('kb_knowledge', {
    kb_knowledge_base: kb,
    short_description: title,
    text: html,
    author: fx.ids.ann,
    ...extra,
  });
  fx.svc.completePublish(fx.sys, rec);
  return reload(fx, rec.sysId);
}

function draft(
  fx: Fx,
  user: string,
  kb: string,
  title: string,
  html = '<p>Draft body</p>',
  extra: Record<string, unknown> = {},
): Rec {
  return fx
    .as(user)
    .insert('kb_knowledge', { kb_knowledge_base: kb, short_description: title, text: html, ...extra });
}

// ---------------------------------------------------------------------- lifecycle

describe('Article lifecycle', () => {
  it('creates drafts at version 0.01 with a KB number and validity from the base', () => {
    const fx = fixture();
    clock.freeze('2026-03-01 09:00:00');
    const a = draft(fx, 'ann.author', fx.it, 'Connect to the VPN');
    expect(a.str('workflow_state')).toBe('draft');
    expect(a.str('number')).toMatch(/^KB\d{7}$/);
    expect(versionOf(fx, a.sysId)).toBe('0.01');
    expect(reload(fx, a.sysId).str('display_number')).toBe(`${a.str('number')} v0.01`);
    expect(a.str('valid_to')).toBe('2027-03-01');
    expect(a.str('author')).toBe(fx.ids.ann);
    expect(a.str('summary')).toMatch(/^[0-9a-f]{32}$/);
    const b = draft(fx, 'ann.author', fx.pub, 'No validity');
    expect(b.str('valid_to')).toBe('2100-01-01');
    // Readers without contribute access cannot create articles.
    expect(() => draft(fx, 'eve.employee', fx.it, 'Not allowed')).toThrow(AccessError);
    // Users cannot create articles directly in a later state.
    const c = fx.as('ann.author').insert('kb_knowledge', {
      kb_knowledge_base: fx.pub,
      short_description: 'Sneaky',
      workflow_state: 'published',
      sys_view_count: 99,
    });
    expect(c.str('workflow_state')).toBe('draft');
    expect(c.num('sys_view_count')).toBe(0);
  });

  it('runs the approval flow: review, recall, reject and approve with version bumps', () => {
    const fx = fixture({ approvals: true });
    clock.freeze('2026-03-01 09:00:00');
    const ann = fx.as('ann.author');
    const a = draft(fx, 'ann.author', fx.it, 'Approval flow article');
    let r = fx.svc.publish(ann, a);
    expect(r.state).toBe('review');
    expect(versionOf(fx, a.sysId)).toBe('0.02');
    expect(fx.approvals!.requests).toHaveLength(1);
    expect(fx.approvals!.requests[0].req.users).toEqual([fx.ids.mia]);

    r = fx.svc.recall(ann, reload(fx, a.sysId));
    expect(r.state).toBe('draft');
    expect(versionOf(fx, a.sysId)).toBe('0.03');
    expect(fx.approvals!.cancelled).toContain(a.sysId);

    fx.svc.publish(ann, reload(fx, a.sysId));
    expect(versionOf(fx, a.sysId)).toBe('0.04');
    fx.approvals!.fire(fx.p, 'mia.manager', a.sysId, 'rejected');
    expect(stateOf(fx, a.sysId)).toBe('draft');
    expect(versionOf(fx, a.sysId)).toBe('0.05');
    expect(fx.sys.count('sysevent', 'name=kb.article.rejected')).toBe(1);

    fx.svc.publish(ann, reload(fx, a.sysId));
    expect(versionOf(fx, a.sysId)).toBe('0.06');
    fx.approvals!.fire(fx.p, 'mia.manager', a.sysId, 'approved');
    const pubd = reload(fx, a.sysId);
    expect(pubd.str('workflow_state')).toBe('published');
    expect(versionOf(fx, a.sysId)).toBe('1.0');
    expect(pubd.str('published')).toBe('2026-03-01');
    expect(pubd.str('confidence')).toBe('not_validated');
    expect(fx.sys.count('sysevent', 'name=kb.article.approved')).toBe(1);
    expect(fx.sys.query('kb_version', `knowledge=${a.sysId}`).map((v) => v.str('version'))).toEqual([
      '0.01',
      '0.02',
      '0.03',
      '0.04',
      '0.05',
      '0.06',
      '1.0',
    ]);
  });

  it('publishes instantly when no approvals provider is installed', () => {
    const fx = fixture();
    const a = draft(fx, 'ann.author', fx.it, 'Instant fallback');
    expect(fx.svc.usesApproval(fx.it, 'publish')).toBe(false);
    expect(fx.svc.publish(fx.as('ann.author'), a).state).toBe('published');
    expect(versionOf(fx, a.sysId)).toBe('1.0');
  });

  it('schedules publishing for a future date and the job publishes it', () => {
    const fx = fixture();
    clock.freeze('2026-03-01 09:00:00');
    const ann = fx.as('ann.author');
    const a = draft(fx, 'ann.author', fx.pub, 'Scheduled article', '<p>x</p>', {
      scheduled_publish_date: '2026-03-04 09:00:00',
    });
    expect(fx.svc.publish(ann, a).state).toBe('scheduled_publish');
    expect(versionOf(fx, a.sysId)).toBe('0.02');
    clock.advance(2 * 86_400_000);
    fx.p.scheduler.runNow('knowledge.scheduled_publish');
    expect(stateOf(fx, a.sysId)).toBe('scheduled_publish');
    clock.advance(2 * 86_400_000);
    fx.p.scheduler.runNow('knowledge.scheduled_publish');
    expect(stateOf(fx, a.sysId)).toBe('published');
    expect(versionOf(fx, a.sysId)).toBe('1.0');
  });

  it('rejects scheduled publish dates less than 24 hours ahead', () => {
    const fx = fixture();
    clock.freeze('2026-03-01 09:00:00');
    const a = draft(fx, 'ann.author', fx.pub, 'Too soon');
    expect(() => fx.as('ann.author').update(a, { scheduled_publish_date: '2026-03-01 11:00:00' })).toThrow(
      /24 hours/,
    );
  });

  it('creates new versions: 1.01 draft, one checkout at a time, 2.0 outdates 1.0', () => {
    const fx = fixture();
    const ann = fx.as('ann.author');
    const v1 = published(fx, fx.pub, 'Versioned article', '<p>First</p>');
    expect(versionOf(fx, v1.sysId)).toBe('1.0');
    const next = fx.svc.checkout(ann, v1).article;
    expect(next.sysId).not.toBe(v1.sysId);
    expect(next.str('number')).toBe(v1.str('number'));
    expect(next.str('summary')).toBe(v1.str('summary'));
    expect(next.str('workflow_state')).toBe('draft');
    expect(next.str('base_version')).toBe(v1.sysId);
    expect(next.str('revised_by')).toBe(fx.ids.ann);
    expect(versionOf(fx, next.sysId)).toBe('1.01');
    expect(reload(fx, next.sysId).bool('latest')).toBe(true);
    expect(reload(fx, v1.sysId).bool('latest')).toBe(false);
    expect(stateOf(fx, v1.sysId)).toBe('published');
    expect(() => fx.svc.checkout(ann, reload(fx, v1.sysId))).toThrow(InvalidError);

    ann.update(reload(fx, next.sysId), { text: '<p>Second</p>' });
    fx.svc.publish(ann, reload(fx, next.sysId));
    expect(versionOf(fx, next.sysId)).toBe('2.0');
    expect(stateOf(fx, next.sysId)).toBe('published');
    expect(stateOf(fx, v1.sysId)).toBe('outdated');
  });

  it('make this current starts a draft at the latest version plus 0.01', () => {
    const fx = fixture();
    const ann = fx.as('ann.author');
    const v1 = published(fx, fx.pub, 'Current article', '<p>One</p>');
    const v2 = fx.svc.checkout(ann, v1).article;
    fx.svc.publish(ann, v2);
    const v3 = fx.svc.checkout(ann, reload(fx, v2.sysId)).article;
    fx.svc.publish(ann, v3);
    expect(versionOf(fx, v3.sysId)).toBe('3.0');
    expect(stateOf(fx, v1.sysId)).toBe('outdated');
    expect(() => fx.svc.makeCurrent(fx.as('eve.employee'), reload(fx, v1.sysId))).toThrow(AccessError);
    const v4 = fx.svc.makeCurrent(fx.as('kim.admin'), reload(fx, v1.sysId)).article;
    expect(versionOf(fx, v4.sysId)).toBe('3.01');
    expect(v4.str('base_version')).toBe(v1.sysId);
    expect(reload(fx, v4.sysId).str('text')).toBe('<p>One</p>');
  });

  it('retires through approval and returns to published on rejection', () => {
    const fx = fixture({ approvals: true });
    const ann = fx.as('ann.author');
    const mia = fx.as('mia.manager');
    const a = draft(fx, 'ann.author', fx.it, 'Retire me');
    fx.svc.publish(ann, a);
    fx.approvals!.fire(fx.p, 'mia.manager', a.sysId, 'approved');
    expect(fx.svc.retire(mia, reload(fx, a.sysId)).state).toBe('pending_retirement');
    expect(versionOf(fx, a.sysId)).toBe('1.0');
    fx.approvals!.fire(fx.p, 'mia.manager', a.sysId, 'approved');
    expect(stateOf(fx, a.sysId)).toBe('retired');
    expect(reload(fx, a.sysId).str('retired')).not.toBe('');
    expect(reload(fx, a.sysId).str('confidence')).toBe('archived');
    expect(versionOf(fx, a.sysId)).toBe('1.0');

    const b = draft(fx, 'ann.author', fx.it, 'Keep me');
    fx.svc.publish(ann, b);
    fx.approvals!.fire(fx.p, 'mia.manager', b.sysId, 'approved');
    fx.svc.retire(mia, reload(fx, b.sysId));
    fx.approvals!.fire(fx.p, 'mia.manager', b.sysId, 'rejected');
    expect(stateOf(fx, b.sysId)).toBe('published');
  });

  it('denies retirement to KCS contributors and lets knowledge admins republish', () => {
    const fx = fixture();
    const a = published(fx, fx.pub, 'KCS rules', '<p>x</p>');
    expect(() => fx.svc.retire(fx.as('kurt.kcs'), a)).toThrow(AccessError);
    expect(() => fx.svc.retire(fx.as('eve.employee'), a)).toThrow(AccessError);
    fx.svc.retire(fx.as('olga.owner'), a);
    expect(stateOf(fx, a.sysId)).toBe('retired');
    expect(() => fx.svc.republish(fx.as('ann.author'), reload(fx, a.sysId))).toThrow(AccessError);
    fx.svc.republish(fx.as('kim.admin'), reload(fx, a.sysId));
    expect(stateOf(fx, a.sysId)).toBe('published');
  });

  it('lets ownership group members edit and approve their articles', () => {
    const fx = fixture({ approvals: true });
    const docs = fx.sys.getBy('sys_user_group', 'name', 'Docs Team')!.sysId;
    const a = draft(fx, 'ann.author', fx.it, 'Owned by docs', '<p>v1</p>', { ownership_group: docs });
    const gina = fx.as('gina.docs');
    expect(gina.get('kb_knowledge', a.sysId)).not.toBeNull();
    gina.update(gina.get('kb_knowledge', a.sysId)!, { text: '<p>Edited by the group</p>' });
    expect(reload(fx, a.sysId).str('text')).toBe('<p>Edited by the group</p>');
    fx.svc.publish(fx.as('ann.author'), reload(fx, a.sysId));
    expect(fx.approvals!.requests.at(-1)!.req.users).toEqual([fx.ids.gina]);
    fx.approvals!.fire(fx.p, 'gina.docs', a.sysId, 'approved');
    expect(stateOf(fx, a.sysId)).toBe('published');
  });

  it('only allows the templates enabled for a base', () => {
    const fx = fixture();
    const ann = fx.as('ann.author');
    const tpl = (t: string) => fx.sys.first('kb_article_template', `child_table=${t}`)!;
    expect(() =>
      ann.insert('kb_template_faq', {
        kb_knowledge_base: fx.it,
        short_description: 'FAQ',
        kb_question: 'Q?',
      }),
    ).toThrow(/not active/);
    fx.sys.update(tpl('kb_template_faq'), { active: true });
    fx.sys.update(tpl('kb_template_kcs_article'), { active: true });
    fx.sys.insert('m2m_kb_template_kb', {
      kb_knowledge_base: fx.it,
      template: tpl('kb_template_kcs_article').sysId,
    });
    expect(() =>
      ann.insert('kb_template_faq', {
        kb_knowledge_base: fx.it,
        short_description: 'FAQ',
        kb_question: 'Q?',
      }),
    ).toThrow(/cannot be used/);
    expect(() =>
      ann.insert('kb_knowledge', { kb_knowledge_base: fx.it, short_description: 'Standard' }),
    ).toThrow(/cannot be used/);
    const kcs = ann.insert('kb_template_kcs_article', {
      kb_knowledge_base: fx.it,
      short_description: 'Outlook search is empty',
      kb_issue: 'Search returns nothing',
      kb_resolution: '<p>Rebuild the index</p>',
    });
    expect(kcs.str('text')).toContain('<h3>Issue</h3>');
    expect(kcs.str('text')).toContain('Rebuild the index');
    expect(kcs.str('meta_description')).toBe('Search returns nothing');
  });

  it('rejects workflow state changes outside the lifecycle actions and locks published content', () => {
    const fx = fixture();
    const ann = fx.as('ann.author');
    const a = draft(fx, 'ann.author', fx.pub, 'Locked');
    expect(() => ann.update(a, { workflow_state: 'published' })).toThrow(/knowledge actions/);
    fx.svc.publish(ann, reload(fx, a.sysId));
    expect(() => ann.update(reload(fx, a.sysId), { text: '<p>changed</p>' })).toThrow();
  });
});

// ---------------------------------------------------------------------- access

describe('Knowledge access', () => {
  it('shows published articles to readers and drafts only to authors and managers', () => {
    const fx = fixture();
    const d = draft(fx, 'ann.author', fx.it, 'Draft only');
    const pub = published(fx, fx.it, 'Live article', '<p>x</p>');
    const retired = published(fx, fx.it, 'Old article', '<p>x</p>');
    fx.svc.retire(fx.sys, retired);
    const visible = (u: string) =>
      fx
        .as(u)
        .query('kb_knowledge')
        .map((r) => r.str('short_description'))
        .sort();
    expect(visible('eve.employee')).toEqual(['Live article']);
    expect(fx.as('eve.employee').count('kb_knowledge')).toBe(1);
    expect(fx.as('eve.employee').get('kb_knowledge', d.sysId)).toBeNull();
    expect(visible('ann.author')).toEqual(['Draft only', 'Live article']);
    expect(visible('mia.manager')).toEqual(['Draft only', 'Live article']);
    expect(visible('ivan.agent')).toEqual(['Live article']);
    expect(visible('kim.admin')).toEqual(['Draft only', 'Live article', 'Old article']);
    expect(fx.as('eve.employee').get('kb_knowledge', pub.sysId)).not.toBeNull();
  });

  it('applies article-level cannot-read criteria', () => {
    const fx = fixture();
    const justEve = fx.sys.insert('user_criteria', { name: 'Just Eve', user: fx.ids.eve });
    const a = published(fx, fx.it, 'Hidden from Eve', '<p>x</p>', {
      cannot_read_user_criteria: justEve.sysId,
    });
    published(fx, fx.it, 'Visible to Eve', '<p>x</p>');
    expect(fx.as('eve.employee').get('kb_knowledge', a.sysId)).toBeNull();
    expect(fx.as('eve.employee').count('kb_knowledge')).toBe(1);
    expect(fx.as('ivan.agent').get('kb_knowledge', a.sysId)).not.toBeNull();
    const roles = published(fx, fx.it, 'Agents only', '<p>x</p>', { roles: 'itil' });
    expect(fx.as('eve.employee').get('kb_knowledge', roles.sysId)).toBeNull();
    expect(fx.as('ivan.agent').get('kb_knowledge', roles.sysId)).not.toBeNull();
  });

  it('lets contributors read past article criteria unless apply_article_read_criteria is on', () => {
    const fx = fixture();
    const justAnn = fx.sys.insert('user_criteria', { name: 'Just Ann', user: fx.ids.ann });
    const a = published(fx, fx.it, 'Hidden from Ann', '<p>x</p>', {
      cannot_read_user_criteria: justAnn.sysId,
      author: fx.ids.ivan,
    });
    expect(fx.as('ann.author').get('kb_knowledge', a.sysId)).not.toBeNull();
    fx.p.properties.set('glide.knowman.apply_article_read_criteria', 'true');
    expect(fx.as('ann.author').get('kb_knowledge', a.sysId)).toBeNull();
  });

  it('closes bases without user criteria unless block_access_with_no_user_criteria is false', () => {
    const fx = fixture();
    const open = fx.sys.insert('kb_knowledge_base', {
      title: 'Open',
      owner: fx.ids.olga,
      resolvr_publish_flow: 'instant',
    }).sysId;
    const a = published(fx, open, 'Open article', '<p>x</p>');
    expect(fx.as('eve.employee').get('kb_knowledge', a.sysId)).toBeNull();
    fx.p.properties.set('glide.knowman.block_access_with_no_user_criteria', 'false');
    expect(fx.as('eve.employee').get('kb_knowledge', a.sysId)).not.toBeNull();
  });

  it('keeps an agents-only base hidden from employees', () => {
    const fx = fixture();
    const runbooks = fx.sys.insert('kb_knowledge_base', {
      title: 'Runbooks',
      owner: fx.ids.olga,
      resolvr_publish_flow: 'instant',
    }).sysId;
    fx.sys.insert('kb_uc_can_read_mtom', { kb_knowledge_base: runbooks, user_criteria: fx.criteria.agents });
    const a = published(fx, runbooks, 'Failover procedure', '<p>x</p>');
    expect(fx.as('eve.employee').get('kb_knowledge', a.sysId)).toBeNull();
    expect(fx.as('ivan.agent').get('kb_knowledge', a.sysId)).not.toBeNull();
    expect(fx.svc.access.canReadKb(fx.as('eve.employee'), runbooks)).toBe(false);
    expect(fx.svc.access.canContributeKb(fx.as('eve.employee'), runbooks)).toBe(false);
  });

  it('gives base managers the knowledge_manager role', () => {
    const fx = fixture();
    expect(fx.as('mia.manager').hasRole('knowledge_manager')).toBe(true);
    expect(fx.as('ann.author').hasRole('knowledge_manager')).toBe(false);
  });
});

// ---------------------------------------------------------------------- search

describe('Knowledge search', () => {
  const FILLER = [
    ['Reset the print spooler', 'Restart the spooler service on the print server and resend the job.'],
    ['Set up email on a phone', 'Install the mail app, sign in and approve the request.'],
    ['Book a meeting room', 'Use the room finder to pick a free room for your meeting.'],
    ['Order a new monitor', 'Request a monitor from the hardware catalog with your cost center.'],
    ['Change your desk phone PIN', 'Open the phone settings menu and choose a new PIN.'],
    ['Use the badge printer', 'Badges are printed at reception with the visitor tool.'],
    ['Archive old mailbox items', 'Run the archive wizard to move old items out of the mailbox.'],
    ['Request a parking permit', 'Facilities issue parking permits from the workplace portal.'],
  ];

  function corpus() {
    const fx = fixture();
    for (const [t, b] of FILLER) published(fx, fx.it, t, `<p>${b}</p>`);
    return fx;
  }

  it('ranks title matches above body matches and highlights snippets', () => {
    const fx = corpus();
    const title = published(
      fx,
      fx.it,
      'Configure the VPN client',
      '<p>Open the client and sign in with your account.</p>',
    );
    published(
      fx,
      fx.it,
      'Working from home',
      '<p>Check your internet connection, your headset and your desk setup. Connect the VPN before opening internal sites.</p>',
    );
    const res = fx.svc.search.search(fx.as('eve.employee'), { query: 'vpn', limit: 10, offset: 0 });
    expect(res.total).toBe(2);
    expect(res.hits[0].rec.sysId).toBe(title.sysId);
    expect(res.hits[0].rank).toBe(1);
    expect(res.hits[1].snippet).toContain('<B>VPN</B>');
    expect(res.hits[0].score).toBeGreaterThan(res.hits[1].score);
  });

  it('respects access: drafts, other bases and article criteria never appear', () => {
    const fx = corpus();
    const runbooks = fx.sys.insert('kb_knowledge_base', {
      title: 'Runbooks',
      owner: fx.ids.olga,
      resolvr_publish_flow: 'instant',
    }).sysId;
    fx.sys.insert('kb_uc_can_read_mtom', { kb_knowledge_base: runbooks, user_criteria: fx.criteria.agents });
    published(fx, fx.it, 'VPN for employees', '<p>Connect to the VPN.</p>');
    published(fx, runbooks, 'VPN gateway failover', '<p>Drain the VPN gateway.</p>');
    draft(fx, 'ann.author', fx.it, 'VPN draft notes', '<p>VPN draft</p>');
    const titles = (u: string) =>
      fx.svc.search
        .search(fx.as(u), { query: 'vpn', limit: 10, offset: 0 })
        .hits.map((h) => h.rec.str('short_description'));
    expect(titles('eve.employee')).toEqual(['VPN for employees']);
    expect(titles('ivan.agent').sort()).toEqual(['VPN for employees', 'VPN gateway failover']);
    expect(titles('ann.author')).not.toContain('VPN draft notes');
  });

  it('gives a small boost to popular, well rated articles', () => {
    const fx = corpus();
    const a = published(
      fx,
      fx.it,
      'Laptop docking guide alpha',
      '<p>Plug the dock cable into the laptop.</p>',
    );
    const b = published(
      fx,
      fx.it,
      'Laptop docking guide bravo',
      '<p>Plug the dock cable into the laptop.</p>',
    );
    const setStats = (id: string, views: number, rating: number) =>
      fx.p.db.run(`UPDATE "kb_knowledge" SET "sys_view_count" = ?, "rating" = ? WHERE "sys_id" = ?`, [
        views,
        rating,
        id,
      ]);
    setStats(a.sysId, 3, 2);
    setStats(b.sysId, 900, 4.8);
    const first = () =>
      fx.svc.search.search(fx.as('eve.employee'), { query: 'docking', limit: 5, offset: 0 }).hits[0].rec
        .sysId;
    expect(first()).toBe(b.sysId);
    setStats(a.sysId, 900, 4.8);
    setStats(b.sysId, 3, 2);
    expect(first()).toBe(a.sysId);
  });

  it('falls back from AND to OR for multi-word queries', () => {
    const fx = corpus();
    const res = fx.svc.search.search(fx.as('eve.employee'), {
      query: 'spooler parking',
      limit: 10,
      offset: 0,
    });
    expect(res.hits.map((h) => h.rec.str('short_description')).sort()).toEqual([
      'Request a parking permit',
      'Reset the print spooler',
    ]);
  });

  it('excludes expired and retired articles and escapes markup in snippets', () => {
    const fx = corpus();
    const old = published(fx, fx.it, 'Fax machine setup', '<p>Dial 9 for the fax line.</p>');
    fx.sys.update(old, { valid_to: '2020-01-01' });
    const gone = published(fx, fx.it, 'Fax cover sheets', '<p>Use the fax template.</p>');
    fx.svc.retire(fx.sys, gone);
    expect(fx.svc.search.search(fx.as('eve.employee'), { query: 'fax', limit: 10, offset: 0 }).total).toBe(0);
    published(fx, fx.it, 'Keyboard shortcuts', '<p>Press &lt;Ctrl&gt; + K to open the search box.</p>');
    const hit = fx.svc.search.search(fx.as('eve.employee'), {
      query: 'shortcuts search',
      limit: 1,
      offset: 0,
    }).hits[0];
    expect(hit.snippet).toContain('&lt;Ctrl&gt;');
    expect(hit.snippet).toContain('<B>search</B>');
  });

  it('keeps the index in sync with article edits and deletes', () => {
    const fx = corpus();
    const a = published(fx, fx.it, 'Temporary page', '<p>Nothing here.</p>');
    const search = () =>
      fx.svc.search.search(fx.as('kim.admin'), { query: 'zebra', limit: 5, offset: 0 }).total;
    expect(search()).toBe(0);
    fx.sys.update(reload(fx, a.sysId), { meta: 'zebra' });
    expect(search()).toBe(1);
    fx.sys.delete(reload(fx, a.sysId));
    expect(search()).toBe(0);
    expect(fx.svc.search.rebuild()).toBe(fx.sys.count('kb_knowledge'));
  });
});

// ---------------------------------------------------------------------- feedback

describe('Feedback and usage', () => {
  it('keeps one effective helpful answer per user', () => {
    const fx = fixture();
    const a = published(fx, fx.it, 'Helpful test', '<p>x</p>');
    const eve = fx.as('eve.employee');
    eve.insert('kb_feedback', { article: a.sysId, useful: 'yes' });
    expect(reload(fx, a.sysId).num('helpful_count')).toBe(1);
    eve.insert('kb_feedback', { article: a.sysId, useful: 'no' });
    const rows = fx.sys.query('kb_feedback', `article=${a.sysId}^user=${fx.ids.eve}^usefulISNOTEMPTY`);
    expect(rows.map((r) => r.str('useful'))).toEqual(['no']);
    expect(reload(fx, a.sysId).num('helpful_count')).toBe(0);
    fx.as('ivan.agent').insert('kb_feedback', { article: a.sysId, useful: 'yes' });
    expect(reload(fx, a.sysId).num('helpful_count')).toBe(1);
    expect(fx.svc.feedbackSummary(reload(fx, a.sysId), fx.ids.eve)).toMatchObject({
      helpful: { yes: 1, no: 1, percent: 50 },
      mine: { useful: 'no' },
    });
  });

  it('averages the latest rating per user, carries it to new versions and resets flags', () => {
    const fx = fixture();
    const a = published(fx, fx.pub, 'Rated article', '<p>x</p>');
    fx.as('eve.employee').insert('kb_feedback', { article: a.sysId, rating: 4 });
    fx.as('ivan.agent').insert('kb_feedback', { article: a.sysId, rating: 2 });
    expect(reload(fx, a.sysId).num('rating')).toBe(3);
    fx.as('eve.employee').insert('kb_feedback', { article: a.sysId, rating: 5 });
    expect(reload(fx, a.sysId).num('rating')).toBe(3.5);
    expect(() => fx.as('eve.employee').insert('kb_feedback', { article: a.sysId, rating: 7 })).toThrow(
      /1 to 5/,
    );
    fx.as('eve.employee').insert('kb_feedback', {
      article: a.sysId,
      flagged: true,
      comments: 'Step 2 is wrong',
    });
    expect(reload(fx, a.sysId).bool('flagged')).toBe(true);
    const ann = fx.as('ann.author');
    const v2 = fx.svc.checkout(ann, reload(fx, a.sysId)).article;
    fx.svc.publish(ann, v2);
    const fresh = reload(fx, v2.sysId);
    expect(fresh.num('rating')).toBe(3.5);
    expect(fresh.bool('flagged')).toBe(false);
  });

  it('creates a feedback task for flags, assigned to the author', () => {
    const fx = fixture();
    const a = published(fx, fx.it, 'Flag me', '<p>x</p>');
    const fb = fx.as('eve.employee').insert('kb_feedback', {
      article: a.sysId,
      flagged: true,
      reason: 'inaccurate',
      comments: 'The menu name changed',
    });
    expect(reload(fx, a.sysId).bool('flagged')).toBe(true);
    const tasks = fx.sys.query('kb_feedback_task', `article=${a.sysId}`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].str('number')).toMatch(/^KBFT\d{7}$/);
    expect(tasks[0].str('assigned_to')).toBe(fx.ids.ann);
    expect(tasks[0].str('opened_by')).toBe(fx.ids.eve);
    expect(tasks[0].str('description')).toBe('The menu name changed');
    expect(fx.sys.get('kb_feedback', fb.sysId)!.str('feedback_task')).toBe(tasks[0].sysId);
    // Flags are private to the author and managers.
    expect(fx.as('ivan.agent').query('kb_feedback', `article=${a.sysId}`)).toHaveLength(0);
    expect(fx.as('ann.author').query('kb_feedback', `article=${a.sysId}`)).toHaveLength(1);
    expect(fx.as('eve.employee').query('kb_feedback', `article=${a.sysId}`)).toHaveLength(1);
  });

  it('creates feedback tasks for low ratings when configured', () => {
    const fx = fixture();
    fx.p.properties.set('glide.knowman.feedback.enable_actionable_feedback_for_rating', '2');
    const a = published(fx, fx.it, 'Low rating', '<p>x</p>');
    fx.as('eve.employee').insert('kb_feedback', { article: a.sysId, rating: 2 });
    expect(fx.sys.count('kb_feedback_task', `article=${a.sysId}`)).toBe(1);
    fx.as('ivan.agent').insert('kb_feedback', { article: a.sysId, rating: 3 });
    expect(fx.sys.count('kb_feedback_task', `article=${a.sysId}`)).toBe(1);
  });

  it('resolves feedback tasks with a code and closes them when the submitter accepts', () => {
    const fx = fixture();
    const a = published(fx, fx.it, 'Task flow', '<p>x</p>');
    fx.as('eve.employee').insert('kb_feedback', {
      article: a.sysId,
      flagged: true,
      comments: 'Outdated screenshot',
    });
    const ann = fx.as('ann.author');
    const task = ann.query('kb_feedback_task', `article=${a.sysId}`)[0];
    expect(() => ann.update(task, { state: '6' })).toThrow(/resolution code/);
    ann.update(ann.get('kb_feedback_task', task.sysId)!, {
      state: '6',
      resolution_code: 'updated_article',
      close_notes: 'Replaced the screenshot',
    });
    expect(fx.sys.count('sysevent', 'name=kb_feedback_task.resolved')).toBe(1);
    const eve = fx.as('eve.employee');
    const mine = eve.get('kb_feedback_task', task.sysId)!;
    const accept = fx.p.uiActions.get('knowledge.feedback_task.accept')!;
    expect(actionVisible(accept, mine, eve)).toBe(true);
    expect(actionVisible(accept, mine, fx.as('ivan.agent'))).toBe(false);
    accept.run(mine, eve, {});
    const closed = fx.sys.get('kb_feedback_task', task.sysId)!;
    expect(closed.str('state')).toBe('7');
    expect(closed.bool('active')).toBe(false);
    expect(closed.bool('submitter_accepted')).toBe(true);
  });

  it('logs views and recomputes the windowed view count', () => {
    const fx = fixture();
    clock.freeze('2026-05-01 12:00:00');
    const a = published(fx, fx.it, 'Viewed article', '<p>x</p>');
    fx.svc.recordView(fx.as('eve.employee'), reload(fx, a.sysId));
    fx.svc.recordView(fx.as('eve.employee'), reload(fx, a.sysId));
    expect(reload(fx, a.sysId).num('sys_view_count')).toBe(2);
    const uses = fx.sys.query('kb_use', `article=${a.sysId}^ORDERBYtimes_viewed`);
    expect(uses.map((u) => u.num('times_viewed'))).toEqual([1, 2]);
    expect(uses.every((u) => u.bool('viewed') && u.str('user') === fx.ids.eve)).toBe(true);

    const b = published(fx, fx.it, 'Older views', '<p>x</p>');
    for (const days of [40, 20, 5]) {
      const at = addMs(nowGlide(), -days * 86_400_000);
      fx.sys.insert(
        'kb_use',
        {
          article: b.sysId,
          user: fx.ids.eve,
          viewed: true,
          times_viewed: 1,
          sys_created_on: at,
          sys_updated_on: at,
        },
        { autoSysFields: false },
      );
    }
    fx.p.scheduler.runNow('knowledge.view_counts');
    expect(reload(fx, b.sysId).num('sys_view_count')).toBe(2);
    fx.p.properties.set('glide.knowman.view_age.days', '0');
    fx.p.scheduler.runNow('knowledge.view_counts');
    expect(reload(fx, b.sysId).num('sys_view_count')).toBe(3);
  });

  it('counts views of older versions for later versions, not the reverse', () => {
    const fx = fixture();
    const v1 = published(fx, fx.pub, 'Viewed versions', '<p>x</p>');
    fx.svc.recordView(fx.as('eve.employee'), reload(fx, v1.sysId));
    const v2 = fx.svc.checkout(fx.as('ann.author'), reload(fx, v1.sysId)).article;
    fx.svc.publish(fx.as('ann.author'), v2);
    fx.svc.recordView(fx.as('eve.employee'), reload(fx, v2.sysId));
    fx.p.scheduler.runNow('knowledge.view_counts');
    expect(reload(fx, v1.sysId).num('sys_view_count')).toBe(1);
    expect(reload(fx, v2.sysId).num('sys_view_count')).toBe(2);
  });
});

// ---------------------------------------------------------------------- tasks

describe('Knowledge from tasks', () => {
  function closeTask(fx: Fx, values: Record<string, unknown> = {}) {
    const ivan = fx.as('ivan.agent');
    const task = ivan.insert('task', {
      short_description: 'Monitoring agent crashes on start',
      description: 'The agent stops right after sign-in.',
      knowledge: true,
      assigned_to: fx.ids.ivan,
      ...values,
    });
    ivan.update(task, { comments: 'Restart the agent and clear its cache folder.' });
    ivan.update(ivan.get('task', task.sysId)!, { state: '3', close_notes: 'Cleared the agent cache.' });
    fx.p.drain();
    return task;
  }

  it('creates one draft when a task closes with Knowledge checked', () => {
    const fx = fixture();
    fx.p.properties.set('glide.knowman.task_kb', fx.pub);
    const task = closeTask(fx);
    const arts = fx.sys.query('kb_knowledge', `source=${task.sysId}`);
    expect(arts).toHaveLength(1);
    const a = arts[0];
    expect(a.str('workflow_state')).toBe('draft');
    expect(a.str('kb_knowledge_base')).toBe(fx.pub);
    expect(a.str('short_description')).toBe('Monitoring agent crashes on start');
    expect(a.str('author')).toBe(fx.ids.ivan);
    expect(a.str('text')).toContain('Restart the agent and clear its cache folder.');
    expect(a.str('text')).toContain('Cleared the agent cache.');
    expect(fx.sys.count('m2m_kb_task', `kb_knowledge=${a.sysId}^task=${task.sysId}`)).toBe(1);
    expect(fx.sys.count('sysevent', `name=knowledge.created^instance=${a.sysId}^parm1=${task.sysId}`)).toBe(
      1,
    );
    // Reopening and closing again does not create a duplicate.
    const ivan = fx.as('ivan.agent');
    ivan.update(ivan.get('task', task.sysId)!, { state: '1' });
    ivan.update(ivan.get('task', task.sysId)!, { state: '3' });
    fx.p.drain();
    expect(fx.sys.count('kb_knowledge', `source=${task.sysId}`)).toBe(1);
  });

  it('creates a knowledge submission when the submission workflow is on', () => {
    const fx = fixture();
    fx.p.properties.set('glide.knowman.task_kb', fx.pub);
    fx.p.properties.set('glide.knowman.submission.workflow', 'true');
    const task = closeTask(fx);
    expect(fx.sys.count('kb_knowledge', `source=${task.sysId}`)).toBe(0);
    const sub = fx.sys.first('kb_submission', `parent=${task.sysId}`)!;
    expect(sub.str('number')).toMatch(/^KBSUB/);
    expect(sub.str('text')).toContain('Restart the agent');
    const ivan = fx.as('ivan.agent');
    const action = fx.p.uiActions.get('knowledge.submission.create_article')!;
    const out = action.run(ivan.get('kb_submission', sub.sysId)!, ivan, {});
    expect(out?.redirect).toMatch(/^\/workspace\/record\/kb_knowledge\//);
    const done = fx.sys.get('kb_submission', sub.sysId)!;
    expect(done.str('status')).toBe('closed_created');
    expect(fx.sys.get('kb_knowledge', done.str('kb_knowledge'))!.str('source')).toBe(task.sysId);
    expect(fx.sys.count('sysevent', 'name=kb.submission.closed_created')).toBe(1);
  });

  it('creates an article on demand from the task UI action', () => {
    const fx = fixture();
    fx.p.properties.set('glide.knowman.task_kb', fx.it);
    const ivan = fx.as('ivan.agent');
    const task = ivan.insert('task', { short_description: 'Teams keeps asking to sign in' });
    const action = fx.p.uiActions.get('knowledge.create_from_task')!;
    expect(actionVisible(action, task, ivan)).toBe(true);
    expect(actionVisible(action, task, fx.as('eve.employee'))).toBe(false);
    const out = action.run(task, ivan, {});
    expect(out?.record?.table).toBe('kb_knowledge');
    expect(actionVisible(action, ivan.get('task', task.sysId)!, ivan)).toBe(false);
    expect(fx.sys.get('kb_knowledge', out!.record!.sys_id)!.str('kb_knowledge_base')).toBe(fx.it);
  });

  it('attaches an article to a task: link, comment, use count', () => {
    const fx = fixture();
    const a = published(fx, fx.it, 'Clear the Teams cache', '<p>Quit Teams and delete the cache folder.</p>');
    const ivan = fx.as('ivan.agent');
    const task = ivan.insert('task', { short_description: 'Teams is slow' });
    expect(fx.svc.attachToTask(ivan, ivan.get('kb_knowledge', a.sysId)!, task.sysId).attached).toBe(true);
    expect(fx.sys.count('m2m_kb_task', `kb_knowledge=${a.sysId}^task=${task.sysId}`)).toBe(1);
    expect(fx.sys.count('kb_use', `article=${a.sysId}^used=true^task=${task.sysId}`)).toBe(1);
    expect(reload(fx, a.sysId).num('use_count')).toBe(1);
    const comments = fx.p.history.journal('task', task.sysId, ['comments']).map((j) => j.value);
    expect(comments[0]).toContain(a.str('number'));
    expect(comments[0]).toContain('Clear the Teams cache');
    expect(fx.svc.attachToTask(ivan, ivan.get('kb_knowledge', a.sysId)!, task.sysId).attached).toBe(false);
    expect(reload(fx, a.sysId).num('use_count')).toBe(1);
  });

  it('creates known error articles in the Known Error base', () => {
    const fx = fixture();
    const ke = fx.sys.insert('kb_knowledge_base', {
      title: 'Known Error',
      owner: fx.ids.olga,
      resolvr_publish_flow: 'instant',
    }).sysId;
    const ivan = fx.as('ivan.agent');
    const problem = ivan.insert('task', {
      short_description: 'Laptops lose Wi-Fi after sleep',
      description: 'Adapter disabled after resume',
    });
    const out = fx.svc.createKnownErrorArticle(ivan, problem);
    expect(out.table).toBe('kb_template_known_error_article');
    const art = fx.sys.get('kb_template_known_error_article', out.sysId)!;
    expect(art.str('kb_knowledge_base')).toBe(ke);
    expect(art.str('source')).toBe(problem.sysId);
    expect(art.str('kb_description')).toContain('Adapter disabled after resume');
    expect(art.str('text')).toContain('<h3>Description</h3>');
    expect(fx.sys.count('m2m_kb_task', `kb_knowledge=${out.sysId}`)).toBe(1);
  });
});

// ---------------------------------------------------------------------- HTTP APIs

describe('Knowledge REST API', () => {
  let fx: Fx;
  let app: FastifyInstance;
  let dir: string;
  const basic = (u: string) =>
    `Basic ${Buffer.from(`${u}:${u === 'admin' ? 'admin-test-pw' : 'Password1!'}`).toString('base64')}`;
  const get = (url: string, user?: string) =>
    app.inject({ method: 'GET', url, headers: user ? { authorization: basic(user) } : {} });
  let vpn: Rec;
  let vpnHelp: Rec;
  let printer: Rec;
  let runbook: Rec;
  let french: Rec;
  let publicKb: string;

  beforeAll(async () => {
    fx = fixture();
    dir = mkdtempSync(join(tmpdir(), 'resolvrnow-kb-'));
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
    app = await buildApp(fx.p, config);
    vpn = published(fx, fx.it, 'Connect to the VPN', '<p>Open the VPN app and select Connect.</p>', {
      meta: 'vpn, remote',
    });
    vpnHelp = published(fx, fx.it, 'VPN troubleshooting', '<p>If the VPN fails, flush DNS.</p>');
    printer = published(fx, fx.it, 'Add a printer', '<p>Install the printer from the software center.</p>');
    const runbooks = fx.sys.insert('kb_knowledge_base', {
      title: 'Runbooks',
      owner: fx.ids.olga,
      resolvr_publish_flow: 'instant',
    }).sysId;
    fx.sys.insert('kb_uc_can_read_mtom', { kb_knowledge_base: runbooks, user_criteria: fx.criteria.agents });
    runbook = published(fx, runbooks, 'VPN gateway failover', '<p>Drain the VPN gateway.</p>');
    french = published(fx, fx.it, 'Se connecter au VPN', '<p>Ouvrez l application VPN.</p>', {
      language: 'fr',
      parent: vpn.sysId,
    });
    publicKb = fx.sys.insert('kb_knowledge_base', {
      title: 'Anonymous',
      owner: fx.ids.olga,
      resolvr_publish_flow: 'instant',
    }).sysId;
    published(fx, publicKb, 'Office opening hours', '<p>The fax line and reception open at 8:00.</p>');
  });

  afterAll(async () => {
    await app.close();
    fx.p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('KM-1 searches with ranking, totals, fields and a search log entry', async () => {
    const r = await get(
      '/api/sn_km_api/knowledge/articles?query=vpn&limit=1&fields=short_description,kb_knowledge_base',
      'eve.employee',
    );
    expect(r.statusCode).toBe(200);
    const { meta, articles } = r.json().result;
    expect(meta).toMatchObject({
      start: 0,
      end: 1,
      query: 'vpn',
      count: 2,
      language: 'en',
      status: { code: 200 },
    });
    expect(articles).toHaveLength(1);
    expect(articles[0].id).toBe(`kb_knowledge:${vpn.sysId}`);
    expect(articles[0].rank).toBe(1);
    expect(articles[0].snippet).toContain('<B>VPN</B>');
    expect(articles[0].link).toBe(
      `?sys_kb_id=${vpn.sysId}&id=kb_article_view&sysparm_rank=1&sysparm_tsqueryId=${meta.ts_query_id}`,
    );
    expect(articles[0].fields.short_description).toEqual({
      display_value: 'Connect to the VPN',
      label: 'Short description',
      name: 'short_description',
      type: 'string',
      value: 'Connect to the VPN',
    });
    expect(articles[0].fields.kb_knowledge_base).toMatchObject({
      display_value: 'IT',
      value: fx.it,
      type: 'reference',
    });
    const log = fx.sys.get('ts_query_kb', meta.ts_query_id)!;
    expect(log.str('search_term')).toBe('vpn');
    expect(log.num('results')).toBe(2);
    expect(log.str('user')).toBe(fx.ids.eve);
    const agent = await get('/api/sn_km_api/v1/knowledge/articles?query=vpn', 'ivan.agent');
    expect(agent.json().result.meta.count).toBe(3);
    const all = await get('/api/sn_km_api/knowledge/articles?query=vpn&language=all', 'eve.employee');
    expect(all.json().result.meta.count).toBe(3);
  });

  it('KM-4 returns an article and counts a view tied to the search', async () => {
    const s = await get('/api/sn_km_api/knowledge/articles?query=troubleshooting', 'eve.employee');
    const tsId = s.json().result.meta.ts_query_id;
    const before = reload(fx, vpnHelp.sysId).num('sys_view_count') ?? 0;
    const r = await get(
      `/api/sn_km_api/knowledge/articles/${vpnHelp.sysId}?search_id=${tsId}&search_rank=1&fields=number`,
      'eve.employee',
    );
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res).toMatchObject({
      sys_id: vpnHelp.sysId,
      number: vpnHelp.str('number'),
      short_description: 'VPN troubleshooting',
      template: false,
      language: 'en',
    });
    expect(res.content).toContain('flush DNS');
    expect(res.fields.number.value).toBe(vpnHelp.str('number'));
    expect(reload(fx, vpnHelp.sysId).num('sys_view_count')).toBe(before + 1);
    expect(fx.sys.count('kb_use', `article=${vpnHelp.sysId}^search_id=${tsId}`)).toBe(1);
    expect(fx.sys.get('ts_query_kb', tsId)!.num('highest_click_rank')).toBe(1);
    await get(`/api/sn_km_api/knowledge/articles/${vpnHelp.sysId}?update_view`, 'eve.employee');
    expect(reload(fx, vpnHelp.sysId).num('sys_view_count')).toBe(before + 2);
    await get(`/api/sn_km_api/knowledge/articles/${vpnHelp.sysId}`, 'eve.employee');
    expect(reload(fx, vpnHelp.sysId).num('sys_view_count')).toBe(before + 2);
  });

  it('KM-4 resolves KB numbers, translations and hides unreadable articles', async () => {
    const r = await get(`/api/sn_km_api/knowledge/articles/${vpn.str('number')}?language=fr`, 'eve.employee');
    expect(r.json().result).toMatchObject({ sys_id: french.sysId, language: 'fr' });
    const en = await get(`/api/sn_km_api/knowledge/articles/${vpn.str('number')}`, 'eve.employee');
    expect(en.json().result.sys_id).toBe(vpn.sysId);
    expect(
      en
        .json()
        .result.languages.map((l: { language: string }) => l.language)
        .sort(),
    ).toEqual(['en', 'fr']);
    expect((await get(`/api/sn_km_api/knowledge/articles/${runbook.sysId}`, 'eve.employee')).statusCode).toBe(
      404,
    );
    expect((await get(`/api/sn_km_api/knowledge/articles/${newSysId()}`, 'eve.employee')).statusCode).toBe(
      404,
    );
  });

  it('KM-3 lists most viewed articles and KM-2 puts featured ones first', async () => {
    const setViews = (id: string, n: number) =>
      fx.p.db.run(`UPDATE "kb_knowledge" SET "sys_view_count" = ? WHERE "sys_id" = ?`, [n, id]);
    setViews(vpn.sysId, 5);
    setViews(printer.sysId, 9);
    setViews(vpnHelp.sysId, 0);
    setViews(french.sysId, 0);
    const mv = (await get('/api/sn_km_api/knowledge/articles/most_viewed', 'eve.employee')).json().result;
    expect(mv.articles.map((a: { id: string }) => a.id)).toEqual([
      `kb_knowledge:${printer.sysId}`,
      `kb_knowledge:${vpn.sysId}`,
    ]);
    expect(mv.articles.map((a: { score: number }) => a.score)).toEqual([9, 5]);
    expect(mv.articles[1].tags).toEqual(['vpn', 'remote']);
    expect(mv.articles[0].rank).toBeUndefined();
    const kw = fx.sys.first('kb_keyword', 'keyword=homepage')!;
    fx.sys.insert('kb_knowledge_keyword', { kb_knowledge: vpnHelp.sysId, kb_keyword: kw.sysId, order: 10 });
    const fe = (await get('/api/sn_km_api/knowledge/articles/featured?limit=2', 'eve.employee')).json()
      .result;
    expect(fe.meta).toMatchObject({ query: 'homepage', count: 3, start: 0, end: 2 });
    expect(fe.articles.map((a: { id: string }) => a.id)).toEqual([
      `kb_knowledge:${vpnHelp.sysId}`,
      `kb_knowledge:${printer.sysId}`,
    ]);
    expect(
      fe.articles.every((a: { score: number; rank?: number }) => a.score === -1 && a.rank === undefined),
    ).toBe(true);
  });

  it('serves public bases to anonymous callers only when allowed', async () => {
    expect((await get('/api/sn_km_api/knowledge/articles?query=fax')).json().result.meta.count).toBe(0);
    fx.p.properties.set('glide.knowman.block_access_with_no_user_criteria', 'false');
    const anon = (await get('/api/sn_km_api/knowledge/articles?query=fax')).json().result;
    expect(anon.meta.count).toBe(1);
    expect((await get('/api/sn_km_api/knowledge/articles?query=vpn')).json().result.meta.count).toBe(0);
    fx.p.properties.set('resolvr.km_api.require_auth', 'true');
    expect((await get('/api/sn_km_api/knowledge/articles?query=fax')).statusCode).toBe(401);
    fx.p.properties.set('resolvr.km_api.require_auth', 'false');
    fx.p.properties.set('glide.knowman.block_access_with_no_user_criteria', 'true');
  });

  it('KM-5 downloads article attachments', async () => {
    const up = await app.inject({
      method: 'POST',
      url: `/api/now/attachment/file?table_name=kb_knowledge&table_sys_id=${printer.sysId}&file_name=steps.txt`,
      headers: { authorization: basic('admin'), 'content-type': 'text/plain' },
      payload: 'step one',
    });
    expect(up.statusCode).toBe(201);
    const att = up.json().result.sys_id;
    const r = await get(
      `/api/sn_km_api/knowledge/articles/${printer.sysId}/attachments/${att}`,
      'eve.employee',
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toBe('step one');
    expect(
      (await get(`/api/sn_km_api/knowledge/articles/${vpn.sysId}/attachments/${att}`, 'eve.employee'))
        .statusCode,
    ).toBe(404);
  });

  it('applies knowledge access to the Table API', async () => {
    const d = draft(fx, 'ann.author', fx.it, 'Private draft');
    const r = await get(
      '/api/now/table/kb_knowledge?sysparm_fields=sys_id,short_description,workflow_state',
      'eve.employee',
    );
    const rows = r.json().result as { sys_id: string; workflow_state: string }[];
    expect(rows.every((x) => x.workflow_state === 'published')).toBe(true);
    expect(rows.map((x) => x.sys_id)).not.toContain(d.sysId);
    expect(rows.map((x) => x.sys_id)).not.toContain(runbook.sysId);
    expect(Number(r.headers['x-total-count'])).toBe(rows.length);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/now/table/kb_knowledge/${d.sysId}`,
      headers: { authorization: basic('ann.author'), 'content-type': 'application/json' },
      payload: { workflow_state: 'published' },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.detail).toMatch(/knowledge actions/);
  });

  it('rejects ratings on bases with rating disabled', async () => {
    fx.sys.update(fx.sys.get('kb_knowledge_base', fx.it)!, { disable_rating: true });
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/now/table/kb_feedback',
        headers: { authorization: basic('eve.employee'), 'content-type': 'application/json' },
        payload: { article: printer.sysId, ...payload },
      });
    expect((await post({ rating: 4 })).statusCode).toBe(403);
    expect((await post({ useful: 'yes' })).statusCode).toBe(201);
    fx.sys.update(fx.sys.get('kb_knowledge_base', fx.it)!, { disable_rating: false });
  });

  it('product search returns snippets and respects access', async () => {
    const r = await get('/api/app/knowledge/search?q=vpn&limit=5', 'eve.employee');
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res.count).toBe(2);
    expect(res.results[0]).toMatchObject({
      sys_id: vpn.sysId,
      rank: 1,
      kb_knowledge_base: { value: fx.it, display_value: 'IT' },
    });
    expect(res.results[0].snippet).toContain('<B>VPN</B>');
    const agent = (await get('/api/app/knowledge/search?q=vpn', 'ivan.agent')).json().result;
    expect(agent.results.map((x: { sys_id: string }) => x.sys_id)).toContain(runbook.sysId);
    expect((await get('/api/app/knowledge/search?q=vpn')).statusCode).toBe(401);
  });

  it('article page redirects retired articles to their replacement or answers 404', async () => {
    const old = published(fx, fx.it, 'Legacy remote portal', '<p>Old</p>');
    fx.svc.retire(fx.sys, old, { replacement: vpn.sysId });
    const r = await get(`/api/app/knowledge/articles/${old.sysId}`, 'eve.employee');
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe(`/api/app/knowledge/articles/${vpn.sysId}?replaced=${old.str('number')}`);
    const target = await get(String(r.headers.location), 'eve.employee');
    expect(target.statusCode).toBe(200);
    expect(target.json().result.notice).toContain(old.str('number'));
    const gone = published(fx, fx.it, 'Gone article', '<p>Old</p>');
    fx.svc.retire(fx.sys, gone);
    const nf = await get(`/api/app/knowledge/articles/${gone.sysId}`, 'eve.employee');
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.message).toBe('Knowledge record not found');
    const view = (await get(`/api/app/knowledge/articles/${printer.str('number')}`, 'eve.employee')).json()
      .result;
    expect(view).toMatchObject({
      title: 'Add a printer',
      knowledge_base: { title: 'IT' },
      can: { rate: true, mark_helpful: true, checkout: false },
    });
  });

  it('runs lifecycle actions and feedback through the product API', async () => {
    const d = draft(fx, 'ann.author', fx.pub, 'Publish over HTTP');
    const r = await app.inject({
      method: 'POST',
      url: `/api/app/knowledge/articles/${d.sysId}/publish`,
      headers: { authorization: basic('ann.author') },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().result).toMatchObject({
      state: 'published',
      article: { workflow_state: { value: 'published' } },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/app/knowledge/articles/${d.sysId}/publish`,
      headers: { authorization: basic('ann.author') },
    });
    expect(again.statusCode).toBe(400);
    const fb = await app.inject({
      method: 'POST',
      url: `/api/app/knowledge/articles/${d.sysId}/feedback`,
      headers: { authorization: basic('eve.employee'), 'content-type': 'application/json' },
      payload: { useful: 'yes', rating: 5 },
    });
    expect(fb.statusCode).toBe(200);
    expect(fb.json().result).toMatchObject({
      helpful: { yes: 1 },
      rating: { average: 5, count: 1 },
      mine: { useful: 'yes', rating: 5 },
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/app/knowledge/articles/${d.sysId}/retire`,
      headers: { authorization: basic('eve.employee') },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('exposes navigation and form actions for knowledge workers', async () => {
    const nav = (await get('/api/app/navigation', 'ivan.agent')).json().result as {
      id: string;
      modules: { title: string }[];
    }[];
    const kb = nav.find((a) => a.id === 'knowledge')!;
    expect(kb.modules.map((m) => m.title)).toEqual(
      expect.arrayContaining(['Articles', 'My Drafts', 'Knowledge bases', 'Categories']),
    );
    expect(
      ((await get('/api/app/navigation', 'eve.employee')).json().result as { id: string }[]).some(
        (a) => a.id === 'knowledge',
      ),
    ).toBe(false);
    const d = draft(fx, 'ann.author', fx.pub, 'Form actions');
    const form = (await get(`/api/app/record/kb_knowledge/${d.sysId}`, 'ann.author')).json().result;
    const actions = (form.actions as { id: string }[]).map((a) => a.id);
    expect(actions).toContain('knowledge.publish');
    expect(actions).not.toContain('knowledge.submit_for_review');
    expect(actions).not.toContain('knowledge.retire');
    const meta = (await get('/api/app/meta/kb_knowledge', 'ann.author')).json().result;
    expect(meta.columns.workflow_state.choices.map((c: { value: string }) => c.value)).toEqual([
      'draft',
      'review',
      'scheduled_publish',
      'published',
      'pending_retirement',
      'retired',
      'outdated',
    ]);
    expect(meta.columns.sys_view_count.canWrite).toBe(false);
  });
});

// ---------------------------------------------------------------------- demo

describe('Demo data', () => {
  it('loads the IT Help and IT Runbooks bases with articles, views and feedback', () => {
    const p = bootPlatform([knowledgeModule], { demo: true });
    const svc = knowledge(p);
    const sys = p.systemContext();
    expect(p.errors).toEqual([]);
    expect(
      sys
        .query('kb_knowledge_base')
        .map((b) => b.str('title'))
        .sort(),
    ).toEqual(['IT Help', 'IT Runbooks']);
    expect(sys.count('kb_knowledge', 'workflow_state=published')).toBeGreaterThanOrEqual(30);
    expect(
      sys.count('kb_knowledge', 'workflow_state=published^sys_view_count>0^ratingISNOTEMPTY'),
    ).toBeGreaterThanOrEqual(30);
    expect(sys.count('kb_feedback_task')).toBe(1);
    expect(sys.count('kb_knowledge', 'workflow_state=outdated')).toBe(1);
    expect(sys.count('kb_knowledge', 'workflow_state=retired^replacement_articleISNOTEMPTY')).toBe(1);
    const olivia = p.contextAs('olivia.martin');
    const alex = p.contextAs('alex.rivera');
    const hannah = p.contextAs('hannah.lee');
    expect(svc.search.search(olivia, { query: 'printer', limit: 5, offset: 0 }).total).toBeGreaterThan(0);
    expect(svc.search.search(olivia, { query: 'runbook', limit: 5, offset: 0 }).total).toBe(0);
    expect(svc.search.search(alex, { query: 'runbook', limit: 5, offset: 0 }).total).toBeGreaterThan(0);
    expect(olivia.count('kb_knowledge', 'kb_knowledge_base.title=IT Runbooks')).toBe(0);
    expect(olivia.count('kb_knowledge', 'workflow_state=draft')).toBe(0);
    expect(hannah.count('kb_knowledge', 'workflow_state=draft')).toBe(1);
    expect(
      svc.search
        .search(olivia, { query: 'reset password', limit: 1, offset: 0 })
        .hits[0].rec.str('short_description'),
    ).toBe('Reset your password');
  });
});
