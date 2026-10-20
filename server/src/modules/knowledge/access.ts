import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { SessionUser } from '../../engine/services/users.js';
import { optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { CRITERIA_TABLES } from './tables.js';
import { ARTICLE, physCol, physTable, props, READABLE_STATES, splitList, WORKING_STATES } from './util.js';

/** The fields of an article that drive access decisions. */
export interface ArticleFacts {
  sysId: string;
  kb: string;
  state: string;
  author: string;
  revisedBy: string;
  ownershipGroup: string;
  canRead: string[];
  cannotRead: string[];
  roles: string[];
}

export function articleFacts(rec: Rec): ArticleFacts {
  return {
    sysId: rec.sysId,
    kb: rec.str('kb_knowledge_base'),
    state: rec.str('workflow_state') || 'draft',
    author: rec.str('author'),
    revisedBy: rec.str('revised_by'),
    ownershipGroup: rec.str('ownership_group'),
    canRead: splitList(rec.str('can_read_user_criteria')),
    cannotRead: splitList(rec.str('cannot_read_user_criteria')),
    roles: splitList(rec.str('roles')),
  };
}

interface Criterion {
  id: string;
  active: boolean;
  matchAll: boolean;
  advanced: boolean;
  script: string;
  users: string[];
  groups: string[];
  roles: string[];
  departments: string[];
  locations: string[];
  companies: string[];
}

export interface KbAccessConfig {
  id: string;
  title: string;
  owner: string;
  managers: Set<string>;
  active: boolean;
  canRead: string[];
  cannotRead: string[];
  canContribute: string[];
  cannotContribute: string[];
}

interface CategoryInfo {
  id: string;
  label: string;
  parentTable: string;
  parentId: string;
  active: boolean;
}

interface AccessConfig {
  kbs: Map<string, KbAccessConfig>;
  criteria: Map<string, Criterion>;
  categories: Map<string, CategoryInfo>;
}

interface UserFacts {
  id: string | null;
  roles: Set<string>;
  groups: Set<string>;
  department: string;
  location: string;
  company: string;
}

interface UserCache {
  key: string;
  facts: UserFacts;
  criteria: Map<string, boolean>;
  read: Map<string, boolean>;
  contribute: Map<string, boolean>;
}

/**
 * Knowledge access evaluation (user criteria on bases and articles, plus state-based
 * visibility). Base configuration is cached until a base, a criteria record or a
 * criteria relationship changes; per-user results are cached on the session object,
 * which the platform replaces whenever the user's roles or groups change.
 */
export class KnowledgeAccess {
  private cfg: AccessConfig | null = null;
  private gen = 0;
  private perUser = new WeakMap<SessionUser, UserCache>();

  constructor(private platform: Platform) {}

  invalidate(): void {
    this.gen++;
    this.cfg = null;
  }

  settings() {
    const p = props(this.platform);
    return {
      block: p.bool('glide.knowman.block_access_with_no_user_criteria', true),
      articleRead: p.bool('glide.knowman.apply_article_read_criteria', false),
      roleSecurity: p.bool('glide.knowman.search.apply_role_based_security', true),
      versioning: p.bool('glide.knowman.versioning.enabled', true),
      minorEdits: p.bool('glide.knowman.versioning.enable_minor_edits', false),
    };
  }

  // ------------------------------------------------------------------ configuration

  private config(): AccessConfig {
    if (this.cfg) return this.cfg;
    const { db, registry } = this.platform;
    const kbs = new Map<string, KbAccessConfig>();
    const criteria = new Map<string, Criterion>();
    const categories = new Map<string, CategoryInfo>();
    if (registry.has('kb_knowledge_base')) {
      const c = (f: string) => physCol(this.platform, 'kb_knowledge_base', f);
      for (const r of db.all<Record<string, unknown>>(
        `SELECT "sys_id", ${c('title')} AS title, ${c('owner')} AS owner, ${c('kb_managers')} AS managers, ${c('active')} AS active FROM ${physTable(this.platform, 'kb_knowledge_base')}`,
      )) {
        kbs.set(String(r.sys_id), {
          id: String(r.sys_id),
          title: String(r.title ?? ''),
          owner: String(r.owner ?? ''),
          managers: new Set(splitList(r.managers)),
          active: r.active !== 0,
          canRead: [],
          cannotRead: [],
          canContribute: [],
          cannotContribute: [],
        });
      }
      for (const [key, table] of Object.entries(CRITERIA_TABLES) as [
        keyof typeof CRITERIA_TABLES,
        string,
      ][]) {
        if (!registry.has(table)) continue;
        for (const r of db.all<{ kb: string; uc: string }>(
          `SELECT ${physCol(this.platform, table, 'kb_knowledge_base')} AS kb, ${physCol(this.platform, table, 'user_criteria')} AS uc FROM ${physTable(this.platform, table)}`,
        )) {
          const kb = kbs.get(r.kb);
          if (kb && r.uc) kb[key].push(r.uc);
        }
      }
    }
    if (registry.has('user_criteria')) {
      const roleNames = new Map(
        db
          .all<{ sys_id: string; name: string }>(`SELECT "sys_id","name" FROM "sys_user_role"`)
          .map((r) => [r.sys_id, r.name]),
      );
      const c = (f: string) => physCol(this.platform, 'user_criteria', f);
      for (const r of db.all<Record<string, unknown>>(
        `SELECT "sys_id", ${c('active')} AS active, ${c('match_all')} AS match_all, ${c('advanced')} AS advanced, ${c('script')} AS script, ${c('user')} AS users, ${c('group')} AS groups, ${c('role')} AS roles, ${c('department')} AS departments, ${c('location')} AS locations, ${c('company')} AS companies FROM ${physTable(this.platform, 'user_criteria')}`,
      )) {
        criteria.set(String(r.sys_id), {
          id: String(r.sys_id),
          active: r.active !== 0,
          matchAll: r.match_all === 1,
          advanced: r.advanced === 1,
          script: String(r.script ?? ''),
          users: splitList(r.users),
          groups: splitList(r.groups),
          roles: splitList(r.roles).map((x) => roleNames.get(x) ?? x),
          departments: splitList(r.departments),
          locations: splitList(r.locations),
          companies: splitList(r.companies),
        });
      }
    }
    if (registry.has('kb_category')) {
      const c = (f: string) => physCol(this.platform, 'kb_category', f);
      for (const r of db.all<Record<string, unknown>>(
        `SELECT "sys_id", ${c('label')} AS label, ${c('parent_table')} AS pt, ${c('parent_id')} AS pid, ${c('active')} AS active FROM ${physTable(this.platform, 'kb_category')}`,
      )) {
        categories.set(String(r.sys_id), {
          id: String(r.sys_id),
          label: String(r.label ?? ''),
          parentTable: String(r.pt ?? ''),
          parentId: String(r.pid ?? ''),
          active: r.active !== 0,
        });
      }
    }
    this.cfg = { kbs, criteria, categories };
    return this.cfg;
  }

  kb(id: string): KbAccessConfig | undefined {
    return this.config().kbs.get(id);
  }

  allKbs(): KbAccessConfig[] {
    return [...this.config().kbs.values()];
  }

  category(id: string): CategoryInfo | undefined {
    return this.config().categories.get(id);
  }

  /** The knowledge base a category belongs to (walking up parent categories). */
  categoryKb(id: string): string {
    const cats = this.config().categories;
    let cur = cats.get(id);
    for (let i = 0; cur && i < 32; i++) {
      if (cur.parentTable === 'kb_knowledge_base') return cur.parentId;
      cur = cur.parentTable === 'kb_category' ? cats.get(cur.parentId) : undefined;
    }
    return '';
  }

  /** The category plus all of its descendants. */
  categoryTree(id: string): string[] {
    const cats = [...this.config().categories.values()];
    const out = [id];
    for (let i = 0; i < out.length && i < 1000; i++) {
      for (const c of cats)
        if (c.parentTable === 'kb_category' && c.parentId === out[i] && !out.includes(c.id)) out.push(c.id);
    }
    return out;
  }

  /** `Parent > Child` path of a category. */
  categoryPath(id: string): string {
    const cats = this.config().categories;
    const parts: string[] = [];
    let cur = cats.get(id);
    for (let i = 0; cur && i < 32; i++) {
      parts.unshift(cur.label);
      cur = cur.parentTable === 'kb_category' ? cats.get(cur.parentId) : undefined;
    }
    return parts.join(' > ');
  }

  // ------------------------------------------------------------------ user facts

  private userCache(ctx: Context): UserCache {
    const key = `${this.gen}|${this.settings().block ? 1 : 0}`;
    let uc = this.perUser.get(ctx.user);
    if (!uc || uc.key !== key) {
      uc = { key, facts: this.facts(ctx.user), criteria: new Map(), read: new Map(), contribute: new Map() };
      this.perUser.set(ctx.user, uc);
    }
    return uc;
  }

  private facts(user: SessionUser): UserFacts {
    let department = '';
    let location = '';
    let company = '';
    if (user.sysId && this.platform.registry.has('sys_user')) {
      const row = this.platform.db.get<Record<string, unknown>>(
        `SELECT "department","location","company" FROM "sys_user" WHERE "sys_id" = ?`,
        [user.sysId],
      );
      department = String(row?.department ?? '');
      location = String(row?.location ?? '');
      company = String(row?.company ?? '');
    }
    return {
      id: user.sysId,
      roles: new Set(user.roles),
      groups: new Set(user.groups),
      department,
      location,
      company,
    };
  }

  // ------------------------------------------------------------------ user criteria

  /** Whether the context's user matches a user criteria record. */
  matches(ctx: Context, criterionId: string): boolean {
    const uc = this.userCache(ctx);
    const hit = uc.criteria.get(criterionId);
    if (hit !== undefined) return hit;
    const c = this.config().criteria.get(criterionId);
    let result = false;
    if (c?.active) {
      const f = uc.facts;
      const conds: boolean[] = [];
      if (c.users.length) conds.push(!!f.id && c.users.includes(f.id));
      if (c.groups.length) conds.push(c.groups.some((g) => f.groups.has(g)));
      if (c.roles.length) conds.push(c.roles.some((r) => f.roles.has(r)));
      if (c.departments.length) conds.push(!!f.department && c.departments.includes(f.department));
      if (c.locations.length) conds.push(!!f.location && c.locations.includes(f.location));
      if (c.companies.length) conds.push(!!f.company && c.companies.includes(f.company));
      if (conds.length) result = c.matchAll ? conds.every(Boolean) : conds.some(Boolean);
      if (c.advanced && c.script.trim()) {
        const scripted = this.runCriteriaScript(ctx, c.script);
        result = conds.length === 0 ? scripted : c.matchAll ? result && scripted : result || scripted;
      }
    }
    uc.criteria.set(criterionId, result);
    return result;
  }

  private runCriteriaScript(ctx: Context, script: string): boolean {
    const scripts = optionalService<ScriptService>(this.platform, SERVICES.scripts);
    if (!scripts) return false;
    try {
      return !!scripts.run(ctx.asSystem(), script, { vars: { user_id: ctx.user.sysId ?? '' } });
    } catch (e) {
      this.platform.reportError('knowledge user criteria script', e);
      return false;
    }
  }

  // ------------------------------------------------------------------ knowledge bases

  /** Admins and knowledge admins see and manage every base. */
  isKnowledgeAdmin(ctx: Context): boolean {
    return ctx.user.isSystem || ctx.hasRole('knowledge_admin');
  }

  /** Owner, managers and knowledge admins bypass user criteria for a base. */
  isPrivileged(ctx: Context, kbId: string): boolean {
    if (this.isKnowledgeAdmin(ctx)) return true;
    const kb = this.kb(kbId);
    const uid = ctx.user.sysId;
    return !!kb && !!uid && (kb.owner === uid || kb.managers.has(uid));
  }

  canContributeKb(ctx: Context, kbId: string): boolean {
    const uc = this.userCache(ctx);
    const hit = uc.contribute.get(kbId);
    if (hit !== undefined) return hit;
    const result = this.evalContribute(ctx, kbId);
    uc.contribute.set(kbId, result);
    return result;
  }

  private evalContribute(ctx: Context, kbId: string): boolean {
    const kb = this.kb(kbId);
    if (!kb) return false;
    if (!kb.active) return this.isKnowledgeAdmin(ctx);
    if (this.isPrivileged(ctx, kbId)) return true;
    if (kb.cannotContribute.some((c) => this.matches(ctx, c))) return false;
    if (kb.canContribute.length) return kb.canContribute.some((c) => this.matches(ctx, c));
    if (this.settings().block) return false;
    return [...ctx.user.roles].some((r) => r !== 'snc_internal');
  }

  canReadKb(ctx: Context, kbId: string): boolean {
    const uc = this.userCache(ctx);
    const hit = uc.read.get(kbId);
    if (hit !== undefined) return hit;
    const result = this.evalRead(ctx, kbId);
    uc.read.set(kbId, result);
    return result;
  }

  private evalRead(ctx: Context, kbId: string): boolean {
    const kb = this.kb(kbId);
    if (!kb) return false;
    if (!kb.active) return this.isKnowledgeAdmin(ctx);
    if (this.isPrivileged(ctx, kbId) || this.canContributeKb(ctx, kbId)) return true;
    if (kb.cannotRead.some((c) => this.matches(ctx, c))) return false;
    if (kb.canRead.length) return kb.canRead.some((c) => this.matches(ctx, c));
    return !this.settings().block;
  }

  /** Owner, managers and knowledge admins can edit the base and its criteria. */
  canManageKb(ctx: Context, kbId: string): boolean {
    return this.isPrivileged(ctx, kbId);
  }

  readableKbIds(ctx: Context): string[] {
    return this.allKbs()
      .filter((kb) => kb.active && this.canReadKb(ctx, kb.id))
      .map((kb) => kb.id);
  }

  contributableKbIds(ctx: Context): string[] {
    return this.allKbs()
      .filter((kb) => kb.active && this.canContributeKb(ctx, kb.id))
      .map((kb) => kb.id);
  }

  privilegedKbIds(ctx: Context): string[] {
    return this.allKbs()
      .filter((kb) => kb.active && this.isPrivileged(ctx, kb.id))
      .map((kb) => kb.id);
  }

  activeKbIds(): string[] {
    return this.allKbs()
      .filter((kb) => kb.active)
      .map((kb) => kb.id);
  }

  // ------------------------------------------------------------------ articles

  isAuthorOrReviser(ctx: Context, a: ArticleFacts): boolean {
    const uid = ctx.user.sysId;
    return !!uid && (a.author === uid || a.revisedBy === uid);
  }

  inOwnershipGroup(ctx: Context, a: ArticleFacts): boolean {
    return !!a.ownershipGroup && ctx.user.groups.includes(a.ownershipGroup);
  }

  /** Read access to the content of an article, regardless of its state. */
  canReadArticleContent(ctx: Context, a: ArticleFacts): boolean {
    if (this.isKnowledgeAdmin(ctx)) return true;
    if (this.inOwnershipGroup(ctx, a)) return true;
    const s = this.settings();
    if (!s.articleRead && this.canContributeKb(ctx, a.kb)) return true;
    if (!this.canReadKb(ctx, a.kb)) return false;
    if (a.cannotRead.some((c) => this.matches(ctx, c))) return false;
    if (a.canRead.length) return a.canRead.some((c) => this.matches(ctx, c));
    if (a.roles.length && s.roleSecurity) return a.roles.some((r) => ctx.hasRole(r));
    return true;
  }

  /** State-aware read access: drafts for their authors and the base managers, retired for knowledge admins. */
  canSeeArticle(ctx: Context, a: ArticleFacts): boolean {
    if (this.isKnowledgeAdmin(ctx)) return true;
    const kb = this.kb(a.kb);
    if (!kb?.active) return false;
    const state = a.state || 'draft';
    if (READABLE_STATES.includes(state)) return this.canReadArticleContent(ctx, a);
    if (state === 'retired') return false;
    return this.isAuthorOrReviser(ctx, a) || this.isPrivileged(ctx, a.kb) || this.inOwnershipGroup(ctx, a);
  }

  /** Contribute access to a specific article (base contribute plus article read when configured). */
  canContributeArticle(ctx: Context, a: ArticleFacts): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    if (this.inOwnershipGroup(ctx, a)) return true;
    return (
      this.canContributeKb(ctx, a.kb) && (!this.settings().articleRead || this.canReadArticleContent(ctx, a))
    );
  }

  canEditArticle(ctx: Context, a: ArticleFacts): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    const ka = this.isKnowledgeAdmin(ctx);
    const kb = this.kb(a.kb);
    if (!kb?.active) return ka;
    const s = this.settings();
    const group = this.inOwnershipGroup(ctx, a);
    const priv = this.isPrivileged(ctx, a.kb);
    const contributor = this.canContributeArticle(ctx, a);
    const mine = this.isAuthorOrReviser(ctx, a);
    switch (a.state || 'draft') {
      case 'draft':
        return (contributor && mine) || group || ka || (priv && !s.versioning);
      case 'review':
      case 'scheduled_publish':
        return group || priv;
      case 'published':
        return s.versioning ? s.minorEdits && (priv || group) : (contributor && mine) || group || priv;
      default:
        return false;
    }
  }

  canDeleteArticle(ctx: Context, a: ArticleFacts): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    const state = a.state || 'draft';
    if (state === 'published' || state === 'pending_retirement') return false;
    if (state === 'retired' || state === 'outdated') return this.isKnowledgeAdmin(ctx);
    return this.canEditArticle(ctx, { ...a, state: 'draft' }) || this.isPrivileged(ctx, a.kb);
  }

  canCreateArticle(ctx: Context, rec: Rec | null): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    const kb = rec?.str('kb_knowledge_base') ?? '';
    if (!kb) return this.contributableKbIds(ctx).length > 0;
    return this.canContributeKb(ctx, kb);
  }

  // ------------------------------------------------------------------ query restrictions

  /** Encoded query limiting article queries to what the user may see (null = no restriction). */
  articleQuery(ctx: Context): string | null {
    if (this.isKnowledgeAdmin(ctx)) return null;
    const uid = ctx.user.sysId;
    const readable = this.readableKbIds(ctx);
    const privileged = this.privilegedKbIds(ctx);
    const active = this.activeKbIds();
    const blocks: string[] = [];
    if (readable.length) {
      const denied = this.deniedArticles(ctx, readable);
      blocks.push(
        `kb_knowledge_baseIN${readable.join(',')}^workflow_stateIN${READABLE_STATES.join(',')}${denied.length ? `^sys_idNOT IN${denied.join(',')}` : ''}`,
      );
    }
    if (privileged.length)
      blocks.push(`kb_knowledge_baseIN${privileged.join(',')}^workflow_stateNOT INretired`);
    if (uid && active.length) {
      const working = `workflow_stateIN${WORKING_STATES.join(',')}^ORworkflow_stateISEMPTY`;
      blocks.push(`kb_knowledge_baseIN${active.join(',')}^author=${uid}^${working}`);
      blocks.push(`kb_knowledge_baseIN${active.join(',')}^revised_by=${uid}^${working}`);
    }
    if (ctx.user.groups.length && active.length) {
      blocks.push(
        `kb_knowledge_baseIN${active.join(',')}^ownership_groupIN${ctx.user.groups.join(',')}^workflow_stateNOT INretired`,
      );
    }
    return blocks.length ? blocks.join('^NQ') : 'sys_id=-1';
  }

  /** Live articles in readable bases that article-level criteria hide from the user. */
  private deniedArticles(ctx: Context, kbIds: string[]): string[] {
    const c = (f: string) => physCol(this.platform, ARTICLE, f);
    const rows = this.platform.db.all<Record<string, unknown>>(
      `SELECT "sys_id", ${c('kb_knowledge_base')} AS kb, ${c('workflow_state')} AS state, ${c('author')} AS author, ${c('revised_by')} AS revised_by, ${c('ownership_group')} AS og, ${c('can_read_user_criteria')} AS can_read, ${c('cannot_read_user_criteria')} AS cannot_read, ${c('roles')} AS roles
       FROM ${physTable(this.platform, ARTICLE)}
       WHERE ${c('kb_knowledge_base')} IN (${kbIds.map(() => '?').join(',')})
         AND ${c('workflow_state')} IN (${READABLE_STATES.map(() => '?').join(',')})
         AND (COALESCE(${c('can_read_user_criteria')},'') <> '' OR COALESCE(${c('cannot_read_user_criteria')},'') <> '' OR COALESCE(${c('roles')},'') <> '')`,
      [...kbIds, ...READABLE_STATES],
    );
    const out: string[] = [];
    for (const r of rows) {
      const facts: ArticleFacts = {
        sysId: String(r.sys_id),
        kb: String(r.kb ?? ''),
        state: String(r.state ?? ''),
        author: String(r.author ?? ''),
        revisedBy: String(r.revised_by ?? ''),
        ownershipGroup: String(r.og ?? ''),
        canRead: splitList(r.can_read),
        cannotRead: splitList(r.cannot_read),
        roles: splitList(r.roles),
      };
      if (!this.canReadArticleContent(ctx, facts)) out.push(facts.sysId);
    }
    return out;
  }

  /** Encoded query limiting feedback queries (flags are visible to authors and managers only). */
  feedbackQuery(ctx: Context): string | null {
    if (this.isKnowledgeAdmin(ctx)) return null;
    const uid = ctx.user.sysId;
    const readable = this.readableKbIds(ctx);
    const privileged = this.privilegedKbIds(ctx);
    const blocks: string[] = [];
    if (uid) blocks.push(`user=${uid}`);
    if (readable.length) {
      blocks.push(
        `article.kb_knowledge_baseIN${readable.join(',')}^article.workflow_stateIN${READABLE_STATES.join(',')}${ctx.hasRole('knowledge_manager') ? '' : '^flagged!=true'}`,
      );
    }
    if (privileged.length) blocks.push(`article.kb_knowledge_baseIN${privileged.join(',')}`);
    if (uid) blocks.push(`article.author=${uid}`);
    return blocks.length ? blocks.join('^NQ') : 'sys_id=-1';
  }

  canReadFeedback(ctx: Context, rec: Rec): boolean {
    if (this.isKnowledgeAdmin(ctx)) return true;
    const uid = ctx.user.sysId;
    if (uid && rec.str('user') === uid) return true;
    const article = rec.ref('article');
    if (!article) return false;
    const a = articleFacts(article);
    if (uid && a.author === uid) return true;
    if (this.isPrivileged(ctx, a.kb)) return true;
    if (rec.bool('flagged') && !ctx.hasRole('knowledge_manager')) return false;
    return this.canSeeArticle(ctx, a);
  }
}
