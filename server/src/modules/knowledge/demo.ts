import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { addMs, newSysId, nowGlide } from '../../engine/util.js';
import { DEMO_ARTICLES, DEMO_CATEGORIES, type DemoArticle } from './demo-articles.js';
import { knowledge } from './service.js';
import { ARTICLE, articleCol, physTable } from './util.js';

/** Small deterministic random generator so the demo data is the same on every install. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMPLOYEES = [
  'olivia.martin',
  'noah.johnson',
  'emma.williams',
  'liam.brown',
  'ava.jones',
  'ethan.garcia',
  'mia.miller',
  'james.davis',
  'layla.hassan',
  'charlotte.taylor',
  'henry.anderson',
];
const AGENTS = [
  'alex.rivera',
  'noor.haddad',
  'marcus.chen',
  'sofia.alvarez',
  'jamal.wright',
  'elena.petrova',
  'david.kim',
  'ravi.menon',
];

/**
 * Demo knowledge: "IT Help" (readable by every employee) and "IT Runbooks" (agents only),
 * a category tree, about thirty original how-to articles, views, ratings, comments, a
 * flagged article with its feedback task, a versioned article, a retired article and a draft.
 */
export function loadKnowledgeDemo(ctx: Context): void {
  const p = ctx.platform;
  const svc = knowledge(p);
  if (ctx.first('kb_knowledge_base', 'title=IT Help')) return;
  const userId = (name: string) => ctx.first('sys_user', `user_name=${name}`)?.sysId ?? '';
  const roleId = (name: string) => ctx.getBy('sys_user_role', 'name', name)?.sysId ?? '';
  const hannah = userId('hannah.lee');
  if (!hannah) return; // the shared demo organization is not loaded

  // ---------------------------------------------------------------- access
  const internalRole = roleId('snc_internal');
  const everyone =
    ctx.first('user_criteria', `name=All internal users^role=${internalRole}`) ??
    ctx.insert('user_criteria', {
      name: 'All internal users',
      short_description: 'Every signed-in Northwind Labs employee',
      role: internalRole,
    });
  const agents = ctx.insert('user_criteria', {
    name: 'IT agents',
    short_description: 'Service desk and IT support staff',
    role: roleId('itil'),
  });
  const contributors = ctx.insert('user_criteria', {
    name: 'Knowledge contributors',
    short_description: 'IT staff and knowledge authors',
    role: [roleId('itil'), roleId('knowledge')].filter(Boolean).join(','),
  });

  const help = ctx.insert('kb_knowledge_base', {
    title: 'IT Help',
    description:
      'Self-help guides for Northwind Labs employees: remote access, accounts, devices, email and software.',
    owner: hannah,
    kb_managers: [hannah, userId('priya.nair')].filter(Boolean).join(','),
    resolvr_publish_flow: 'approval',
    resolvr_retire_flow: 'instant',
    approval_description: 'Hannah Lee or Priya Nair review new and updated articles.',
    card_color: '#2563eb',
    order: 10,
  });
  const runbooks = ctx.insert('kb_knowledge_base', {
    title: 'IT Runbooks',
    description: 'Procedures and known errors for IT agents. Not visible to employees.',
    owner: hannah,
    kb_managers: [hannah, userId('ravi.menon')].filter(Boolean).join(','),
    resolvr_publish_flow: 'instant',
    resolvr_retire_flow: 'instant',
    card_color: '#7c3aed',
    order: 20,
  });
  ctx.insert('kb_uc_can_read_mtom', { kb_knowledge_base: help.sysId, user_criteria: everyone.sysId });
  ctx.insert('kb_uc_can_contribute_mtom', {
    kb_knowledge_base: help.sysId,
    user_criteria: contributors.sysId,
  });
  ctx.insert('kb_uc_can_read_mtom', { kb_knowledge_base: runbooks.sysId, user_criteria: agents.sysId });
  ctx.insert('kb_uc_can_contribute_mtom', {
    kb_knowledge_base: runbooks.sysId,
    user_criteria: contributors.sysId,
  });
  p.properties.set('glide.knowman.task_kb', help.sysId);
  p.properties.set('resolvr.knowledge.known_error_kb', runbooks.sysId);
  const template = ctx.first('kb_article_template', 'child_table=kb_template_known_error_article');
  if (template) ctx.update(template, { active: true });

  // ---------------------------------------------------------------- categories
  const kbIds = { help: help.sysId, runbooks: runbooks.sysId };
  const categories = new Map<string, string>();
  for (const [kb, paths] of Object.entries(DEMO_CATEGORIES) as ['help' | 'runbooks', string[]][]) {
    for (const path of paths) {
      let parentTable = 'kb_knowledge_base';
      let parentId = kbIds[kb];
      let soFar = '';
      for (const label of path.split(' > ')) {
        soFar = soFar ? `${soFar} > ${label}` : label;
        const key = `${kb}:${soFar}`;
        let id = categories.get(key);
        if (!id) {
          id = ctx.insert('kb_category', { label, parent_table: parentTable, parent_id: parentId }).sysId;
          categories.set(key, id);
        }
        parentTable = 'kb_category';
        parentId = id;
      }
    }
  }

  // ---------------------------------------------------------------- articles
  const now = nowGlide();
  const daysAgo = (d: number, extraMs = 0) => addMs(now, -d * 86_400_000 + extraMs);
  const articles = new Map<string, Rec>();
  const create = (a: DemoArticle): Rec => {
    const values: Record<string, unknown> = {
      kb_knowledge_base: kbIds[a.kb],
      kb_category: categories.get(`${a.kb}:${a.category}`) ?? '',
      short_description: a.title,
      meta: a.meta,
      author: userId(a.author) || hannah,
      ...(a.fields ?? {}),
    };
    if (a.html) values.text = a.html;
    return ctx.insert(a.table ?? ARTICLE, values);
  };
  const backdate = (rec: Rec, age: number) => {
    p.db.run(
      `UPDATE ${physTable(p, ARTICLE)} SET ${articleCol(p, 'published')} = ?, "sys_created_on" = ?, "sys_updated_on" = ? WHERE "sys_id" = ?`,
      [daysAgo(age).slice(0, 10), daysAgo(age + 3), daysAgo(age), rec.sysId],
    );
  };
  for (const a of DEMO_ARTICLES) {
    const rec = create(a);
    svc.completePublish(ctx, rec);
    backdate(rec, a.age);
    articles.set(a.key, rec);
  }

  // A second version of the VPN article: 1.0 becomes outdated, 2.0 is published.
  const vpn = articles.get('vpn');
  if (vpn) {
    const draft = svc.checkout(ctx, ctx.get(ARTICLE, vpn.sysId)!).article;
    ctx.update(draft, {
      text: `${draft.str('text')}\n<h3>Travelling abroad</h3>\n<p>The VPN works in most countries. Before travelling, check the travel guidance in <em>Working remotely: a checklist</em>, because some destinations need a loan laptop.</p>`,
    });
    svc.completePublish(ctx, ctx.get(ARTICLE, draft.sysId)!);
    backdate(draft, 30);
    articles.set('vpn', ctx.get(ARTICLE, draft.sysId)!);
  }

  // A retired article that points readers to its replacement.
  const legacy = ctx.insert(ARTICLE, {
    kb_knowledge_base: help.sysId,
    kb_category: categories.get('help:Network & Remote Access > VPN') ?? '',
    short_description: 'Use the legacy remote access portal',
    meta: 'remote access portal, legacy, web vpn',
    author: userId('marcus.chen') || hannah,
    text: '<p>The browser-based remote access portal was switched off at the end of March. Use the Northwind VPN app instead; see <em>Connect to the corporate VPN</em>.</p>',
  });
  svc.completePublish(ctx, legacy);
  backdate(legacy, 420);
  svc.retire(ctx, ctx.get(ARTICLE, legacy.sysId)!, { replacement: articles.get('vpn')?.sysId ?? null });

  // A draft still being written.
  ctx.insert(ARTICLE, {
    kb_knowledge_base: help.sysId,
    kb_category: categories.get('help:Email & Collaboration > Meetings') ?? '',
    short_description: 'Use the meeting room displays for hybrid meetings',
    meta: 'meeting room, display, hybrid meeting, video bar',
    author: userId('alex.rivera') || hannah,
    text: '<p>Every bookable room has a touch panel on the table. Tap <strong>Join</strong> on the panel to start the meeting in your calendar invitation.</p><p><em>Draft: screenshots of the new panels still to be added.</em></p>',
  });

  // Featured on the knowledge home page.
  const keyword =
    ctx.first('kb_keyword', 'keyword=homepage') ?? ctx.insert('kb_keyword', { keyword: 'homepage' });
  DEMO_ARTICLES.filter((a) => a.featured).forEach((a, i) => {
    const rec = articles.get(a.key);
    if (rec)
      ctx.insert('kb_knowledge_keyword', {
        kb_knowledge: rec.sysId,
        kb_keyword: keyword.sysId,
        order: (i + 1) * 10,
      });
  });

  // ---------------------------------------------------------------- views (spread over the last 25 days)
  const insertUse = p.db.prepare(
    `INSERT INTO "kb_use" ("sys_id","sys_class_name","article","user","viewed","used","times_viewed","session_id","sys_created_on","sys_created_by","sys_updated_on","sys_updated_by","sys_mod_count") VALUES (?,?,?,?,1,0,1,'',?,?,?,?,0)`,
  );
  const ids = new Map([...EMPLOYEES, ...AGENTS].map((u) => [u, userId(u)]));
  DEMO_ARTICLES.forEach((a, i) => {
    const rec = articles.get(a.key);
    if (!rec) return;
    const rand = prng(1000 + i);
    const readers = a.kb === 'runbooks' ? AGENTS : [...EMPLOYEES, ...AGENTS];
    for (let v = 0; v < a.views; v++) {
      const reader = readers[Math.floor(rand() * readers.length)];
      const at = addMs(now, -Math.floor(rand() * 25 * 86_400_000));
      insertUse.run(newSysId(), 'kb_use', rec.sysId, ids.get(reader) ?? '', at, reader, at, reader);
    }
  });
  svc.recomputeViewCounts();

  // ---------------------------------------------------------------- feedback
  DEMO_ARTICLES.forEach((a, i) => {
    const rec = articles.get(a.key);
    if (!rec) return;
    const rand = prng(5000 + i);
    const readers = (a.kb === 'runbooks' ? AGENTS : EMPLOYEES).filter((u) => u !== a.author);
    const n = Math.min(readers.length, Math.max(3, Math.round(a.views / 35)));
    const start = Math.floor(rand() * readers.length);
    for (let k = 0; k < n; k++) {
      const reader = readers[(start + k) % readers.length];
      const rating = Math.min(5, Math.max(1, Math.round(a.quality + (rand() - 0.5) * 1.8)));
      const values: Record<string, unknown> = { article: rec.sysId, user: ids.get(reader), rating };
      ctx.insert('kb_feedback', values);
      if (rand() < 0.75)
        ctx.insert('kb_feedback', {
          article: rec.sysId,
          user: ids.get(reader),
          useful: rating >= 3 || rand() < 0.15 ? 'yes' : 'no',
        });
    }
    (a.comments ?? []).forEach((text, k) => {
      ctx.insert('kb_feedback', {
        article: rec.sysId,
        user: ids.get(readers[(start + n + k) % readers.length]),
        comments: text,
      });
    });
  });

  // A flagged article: creates a feedback task for its author.
  const printer = articles.get('printer-stuck');
  if (printer) {
    ctx.insert('kb_feedback', {
      article: printer.sysId,
      user: ids.get('ava.jones'),
      flagged: true,
      reason: 'outdated',
      comments:
        'The Singapore office printers show a different release screen since last month. Step 1 does not match any more.',
    });
  }
}
