import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../../engine/context.js';
import { AccessError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { JOURNAL_TYPES } from '../../engine/types.js';
import { addMs, clock, isSysId, nowGlide, parseGlideDateTime, toGlideDate } from '../../engine/util.js';
import {
  type ApprovalDecision,
  type ApprovalService,
  type NotificationService,
  optionalService,
  SERVICES,
} from '../contracts.js';
import { type ArticleFacts, articleFacts, KnowledgeAccess } from './access.js';
import { KnowledgeSearch } from './search.js';
import { TEMPLATE_CLASSES } from './tables.js';
import {
  ARTICLE,
  addDaysToDate,
  articleCol,
  asHtml,
  escapeHtml,
  formatVersion,
  NO_BUMP_STATES,
  nextMajor,
  parseVersion,
  physCol,
  physTable,
  props,
  stripHtml,
  textToHtml,
  today,
  truncate,
  WORKING_STATES,
} from './util.js';

export interface LifecycleResult {
  article: Rec;
  state: string;
  message: string;
}

export interface FromTaskResult {
  table: string;
  sysId: string;
  created: boolean;
}

/** Fields not carried over when a new version of an article is created. */
const COPY_SKIP = new Set([
  'version',
  'display_number',
  'published',
  'retired',
  'scheduled_publish_date',
  'valid_to',
  'replacement_article',
  'confidence',
  'flagged',
  'latest',
  'base_version',
  'revised_by',
  'workflow_state',
]);

/** Article counters and system-managed fields that users never write directly. */
export const PROTECTED_FIELDS = [
  'sys_view_count',
  'use_count',
  'helpful_count',
  'rating',
  'flagged',
  'version',
  'summary',
  'base_version',
  'latest',
  'display_number',
  'article_id',
  'published',
  'retired',
  'revised_by',
  'replacement_article',
];

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ar: 'Arabic',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
};

export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code.toLowerCase()] ?? code;
}

/** The knowledge service registered under `SERVICES.knowledge`. */
export function knowledge(platform: Platform): KnowledgeService {
  return platform.service<KnowledgeService>(SERVICES.knowledge);
}

/**
 * Knowledge Management: article lifecycle (publish, retire, recall, versions), approvals,
 * feedback counters, view logging, search and the task (incident/problem) integration.
 */
export class KnowledgeService {
  readonly access: KnowledgeAccess;
  readonly search: KnowledgeSearch;
  /** Attachment storage directory, known once the HTTP layer is registered (used to copy files to new versions). */
  attachmentDir: string | null = null;
  /** Public base URL of the server (from the HTTP configuration), used for absolute links in emails and comments. */
  publicUrl: string | null = null;
  /**
   * Customisation point: the users who approve publishing or retiring an article.
   * Default: ownership group members, else the base managers, else knowledge admins.
   */
  getApprovers: (ctx: Context, article: Rec) => string[] = (ctx, article) =>
    this.defaultApprovers(ctx, article);
  private approvalBound = new WeakSet<object>();

  constructor(readonly platform: Platform) {
    this.access = new KnowledgeAccess(platform);
    this.search = new KnowledgeSearch(platform, this.access);
  }

  // ------------------------------------------------------------------ lookups

  kbRecord(kbId: string): Rec | null {
    if (!isSysId(kbId)) return null;
    return this.platform.systemContext().get('kb_knowledge_base', kbId);
  }

  articleById(ctx: Context, sysId: string): Rec | null {
    return ctx.elevated().get(ARTICLE, sysId);
  }

  private flow(kb: Rec | null, kind: 'publish' | 'retire'): 'instant' | 'approval' {
    const v = kb?.str(kind === 'publish' ? 'resolvr_publish_flow' : 'resolvr_retire_flow');
    return v === 'approval' ? 'approval' : 'instant';
  }

  /** Whether publishing in this base goes through approval (approval process and an approvals provider). */
  usesApproval(kbId: string, kind: 'publish' | 'retire'): boolean {
    return this.flow(this.kbRecord(kbId), kind) === 'approval' && !!this.approvals();
  }

  approvals(): ApprovalService | undefined {
    return optionalService<ApprovalService>(this.platform, SERVICES.approvals);
  }

  /** Registers the approval decision handler with the approvals provider (once per provider). */
  bindApprovals(): void {
    const svc = this.approvals();
    if (!svc || this.approvalBound.has(svc as object)) return;
    this.approvalBound.add(svc as object);
    const tables = this.platform.registry.table(ARTICLE).descendants;
    for (const t of tables)
      svc.onDecision(t, (target, decision, ctx) => this.onDecision(target, decision, ctx));
  }

  /** Current version of an article as hundredths (1.02 -> 102). */
  versionOf(rec: Rec): number {
    const id = rec.str('version');
    if (!id) return 0;
    const row = this.platform.db.get<{ v: string }>(
      `SELECT ${physCol(this.platform, 'kb_version', 'version')} AS v FROM ${physTable(this.platform, 'kb_version')} WHERE "sys_id" = ?`,
      [id],
    );
    return parseVersion(row?.v);
  }

  /** Every row (version) of an article with its version number, oldest first. */
  versionRows(
    summaryOrId: string,
  ): { sysId: string; version: number; state: string; latest: boolean; createdOn: string }[] {
    const c = (f: string) => `k.${articleCol(this.platform, f)}`;
    const rows = this.platform.db.all<{
      sys_id: string;
      v: string | null;
      state: string | null;
      latest: number | null;
      created: string;
    }>(
      `SELECT k."sys_id" AS sys_id, v.${physCol(this.platform, 'kb_version', 'version')} AS v, ${c('workflow_state')} AS state, ${c('latest')} AS latest, k."sys_created_on" AS created
         FROM ${physTable(this.platform, ARTICLE)} k LEFT JOIN ${physTable(this.platform, 'kb_version')} v ON v."sys_id" = ${c('version')}
        WHERE ${c('summary')} = ? OR k."sys_id" = ?`,
      [summaryOrId, summaryOrId],
    );
    return rows
      .map((r) => ({
        sysId: r.sys_id,
        version: parseVersion(r.v),
        state: r.state ?? '',
        latest: r.latest === 1,
        createdOn: r.created,
      }))
      .sort((a, b) => a.version - b.version || a.createdOn.localeCompare(b.createdOn));
  }

  /** The version of an article currently being worked on (draft, review or scheduled), if any. */
  checkedOutRow(rec: Rec): string | null {
    const key = rec.str('summary') || rec.sysId;
    return this.versionRows(key).find((r) => WORKING_STATES.includes(r.state || 'draft'))?.sysId ?? null;
  }

  latestRow(rec: Rec): string {
    const rows = this.versionRows(rec.str('summary') || rec.sysId);
    return rows.find((r) => r.latest)?.sysId ?? rows[rows.length - 1]?.sysId ?? rec.sysId;
  }

  articleUrl(rec: Rec): string {
    const tpl = props(this.platform).str(
      'resolvr.knowledge.article_url',
      '/sp?id=kb_article_view&sys_kb_id={sys_id}',
    );
    return tpl.replaceAll('{sys_id}', rec.sysId).replaceAll('{number}', rec.str('number'));
  }

  /** Article link for emails and task comments: absolute when the public URL is known. */
  absoluteArticleUrl(rec: Rec): string {
    const url = this.articleUrl(rec);
    return url.startsWith('/') && this.publicUrl ? `${this.publicUrl.replace(/\/$/, '')}${url}` : url;
  }

  // ------------------------------------------------------------------ versions (called from business rules)

  private writeVersion(ctx: Context, cur: Rec, n: number): void {
    const v = ctx.elevated().insert('kb_version', {
      knowledge: cur.sysId,
      version: formatVersion(n),
      modified_by: ctx.user.sysId ?? '',
      modified_on: nowGlide(),
      snapshot: (cur.num('sys_mod_count') ?? 0) + (cur.isNew() ? 0 : 1),
    });
    cur.setRaw('version', v.sysId);
    cur.setRaw('display_number', `${cur.str('number')} v${formatVersion(n)}`);
  }

  /** Initial version: 0.01 for a new draft, latest + 0.01 for a new version of an existing article. */
  initialVersion(ctx: Context, cur: Rec): void {
    if (cur.str('version')) {
      cur.setRaw('display_number', `${cur.str('number')} v${formatVersion(this.versionOf(cur))}`);
      return;
    }
    let n: number;
    if (cur.str('base_version')) {
      const rows = this.versionRows(cur.str('summary') || cur.str('base_version'));
      n = Math.max(0, ...rows.map((r) => r.version)) + 1;
    } else {
      const state = cur.str('workflow_state') || 'draft';
      n = ['published', 'outdated', 'retired', 'pending_retirement'].includes(state) ? 100 : 1;
    }
    this.writeVersion(ctx, cur, n);
  }

  /**
   * Version rules: every workflow state change adds 0.01, publishing jumps to the next whole
   * number, and moves into or out of pending retirement, retired or outdated keep the number.
   */
  bumpVersion(ctx: Context, cur: Rec, prev: Rec): void {
    const from = prev.str('workflow_state') || 'draft';
    const to = cur.str('workflow_state') || 'draft';
    if (from === to) return;
    if (NO_BUMP_STATES.has(from) || NO_BUMP_STATES.has(to)) return;
    const v = this.versionOf(prev.str('version') ? prev : cur);
    this.writeVersion(ctx, cur, to === 'published' ? nextMajor(v) : v + 1);
  }

  // ------------------------------------------------------------------ lifecycle

  private requireState(rec: Rec, states: string[], action: string): void {
    const state = rec.str('workflow_state') || 'draft';
    if (!states.includes(state)) {
      throw new InvalidError(
        `Cannot ${action} an article in state ${rec.display('workflow_state') || state}`,
      );
    }
  }

  /** Publish action on a draft: approval when the base requires it, otherwise instant (or scheduled). */
  publish(ctx: Context, rec: Rec, opts: { scheduledPublishDate?: string | null } = {}): LifecycleResult {
    this.requireState(rec, ['draft'], 'publish');
    if (!this.access.canEditArticle(ctx, articleFacts(rec)))
      throw new AccessError('Insufficient rights to publish this article');
    const e = ctx.elevated();
    if (opts.scheduledPublishDate !== undefined)
      e.update(rec, { scheduled_publish_date: opts.scheduledPublishDate ?? '' });
    const kb = this.kbRecord(rec.str('kb_knowledge_base'));
    const approvals = this.approvals();
    if (approvals && this.flow(kb, 'publish') === 'approval') {
      const approvers = this.getApprovers(e, rec);
      if (approvers.length) {
        e.update(rec, { workflow_state: 'review' });
        this.bindApprovals();
        approvals.request(e, rec, { users: approvers, rule: 'first', stage: 'Knowledge publish approval' });
        return { article: rec, state: 'review', message: `${rec.str('number')} was submitted for review` };
      }
      ctx.addInfoMessage(
        'No approvers were found for this knowledge base, so the article was published directly',
      );
    }
    return this.completePublish(ctx, rec);
  }

  /** Publishes now, or schedules when a future publish date is set. */
  completePublish(ctx: Context, rec: Rec): LifecycleResult {
    const e = ctx.elevated();
    const when = rec.str('scheduled_publish_date');
    if (when && when > nowGlide()) {
      e.update(rec, { workflow_state: 'scheduled_publish' });
      return {
        article: rec,
        state: 'scheduled_publish',
        message: `${rec.str('number')} will be published on ${when} (UTC)`,
      };
    }
    e.update(rec, { workflow_state: 'published' });
    return { article: rec, state: 'published', message: `${rec.str('display_number')} published` };
  }

  /** Approval outcome for an article in review or pending retirement. */
  onDecision(target: Rec, decision: ApprovalDecision, ctx: Context): void {
    const e = ctx.elevated();
    const rec = e.get(ARTICLE, target.sysId);
    if (!rec) return;
    const state = rec.str('workflow_state');
    if (state === 'review') {
      if (decision === 'approved') {
        this.completePublish(e, rec);
        e.queueEvent('kb.article.approved', rec, rec.str('author'), ctx.user.sysId ?? '');
      } else {
        e.update(rec, { workflow_state: 'draft' });
        e.queueEvent('kb.article.rejected', rec, rec.str('author'), ctx.user.sysId ?? '');
      }
    } else if (state === 'pending_retirement') {
      e.update(rec, { workflow_state: decision === 'approved' ? 'retired' : 'published' });
    }
  }

  /** Default approvers: ownership group members, else base managers, else knowledge admins (active users only). */
  defaultApprovers(_ctx: Context, article: Rec): string[] {
    const db = this.platform.db;
    const active = (ids: string[]) =>
      ids.length
        ? db
            .all<{ sys_id: string }>(
              `SELECT "sys_id" FROM "sys_user" WHERE "sys_id" IN (${ids.map(() => '?').join(',')}) AND ("active" IS NULL OR "active" = 1)`,
              ids,
            )
            .map((r) => r.sys_id)
        : [];
    const group = article.str('ownership_group');
    if (group) {
      let members = db
        .all<{ user: string }>(`SELECT "user" FROM "sys_user_grmember" WHERE "group" = ?`, [group])
        .map((r) => r.user);
      if (!props(this.platform).bool('glide.knowman.ownership_group.allow_self_approval', true)) {
        members = members.filter((m) => m !== article.str('author') && m !== article.str('revised_by'));
      }
      const out = active(members);
      if (out.length) return out;
    }
    const kb = this.access.kb(article.str('kb_knowledge_base'));
    const managers = active([...(kb?.managers ?? [])]);
    if (managers.length) return managers;
    const admins = db
      .all<{ user: string }>(
        `SELECT DISTINCT ur."user" AS "user" FROM "sys_user_has_role" ur JOIN "sys_user_role" r ON r."sys_id" = ur."role" WHERE r."name" = 'knowledge_admin'`,
      )
      .map((r) => r.user);
    return active(admins);
  }

  canRetire(ctx: Context, rec: Rec): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    if (ctx.user.roles.has('kcs_contributor') || ctx.user.roles.has('kcs_candidate')) return false;
    const a = articleFacts(rec);
    if (this.access.isPrivileged(ctx, a.kb) || this.access.inOwnershipGroup(ctx, a)) return true;
    const publisher = this.platform.db.get<{ by: string }>(
      `SELECT ${physCol(this.platform, 'kb_version', 'modified_by')} AS by FROM ${physTable(this.platform, 'kb_version')} WHERE "sys_id" = ?`,
      [rec.str('version')],
    );
    return !!ctx.user.sysId && publisher?.by === ctx.user.sysId;
  }

  /** Retire action: instant, or pending retirement with approval. */
  retire(ctx: Context, rec: Rec, opts: { replacement?: string | null } = {}): LifecycleResult {
    this.requireState(rec, ['published'], 'retire');
    if (!this.canRetire(ctx, rec)) throw new AccessError('Insufficient rights to retire this article');
    const e = ctx.elevated();
    const values: Record<string, unknown> = {};
    if (opts.replacement) {
      const target = isSysId(opts.replacement)
        ? e.get(ARTICLE, opts.replacement)
        : e.first(ARTICLE, `number=${opts.replacement}^workflow_state=published`);
      if (
        !target ||
        target.sysId === rec.sysId ||
        (rec.str('summary') && target.str('summary') === rec.str('summary'))
      ) {
        throw new InvalidError('The replacement must be a different article');
      }
      if (target.str('workflow_state') !== 'published')
        throw new InvalidError('The replacement article must be published');
      values.replacement_article = target.sysId;
    }
    const kb = this.kbRecord(rec.str('kb_knowledge_base'));
    const approvals = this.approvals();
    if (approvals && this.flow(kb, 'retire') === 'approval') {
      const approvers = this.getApprovers(e, rec);
      if (approvers.length) {
        e.update(rec, { ...values, workflow_state: 'pending_retirement' });
        this.bindApprovals();
        approvals.request(e, rec, { users: approvers, rule: 'first', stage: 'Knowledge retire approval' });
        return {
          article: rec,
          state: 'pending_retirement',
          message: `Retirement of ${rec.str('number')} was submitted for approval`,
        };
      }
    }
    e.update(rec, { ...values, workflow_state: 'retired' });
    return { article: rec, state: 'retired', message: `${rec.str('number')} retired` };
  }

  canRecall(ctx: Context, rec: Rec): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin || this.access.isKnowledgeAdmin(ctx)) return true;
    const a = articleFacts(rec);
    return this.access.isAuthorOrReviser(ctx, a) || this.access.inOwnershipGroup(ctx, a);
  }

  /** Recall from review or scheduled publish back to draft (outstanding approvals are cancelled). */
  recall(ctx: Context, rec: Rec): LifecycleResult {
    this.requireState(rec, ['review', 'scheduled_publish'], 'recall');
    if (!this.canRecall(ctx, rec)) throw new AccessError('Insufficient rights to recall this article');
    const e = ctx.elevated();
    if (rec.str('workflow_state') === 'review') {
      try {
        this.approvals()?.cancel(e, rec, 'Article recalled');
      } catch (err) {
        this.platform.reportError('knowledge recall approvals', err);
      }
    }
    e.update(rec, { workflow_state: 'draft' });
    return { article: rec, state: 'draft', message: `${rec.str('number')} recalled to draft` };
  }

  canCheckout(ctx: Context, rec: Rec): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    return this.access.canContributeArticle(ctx, articleFacts(rec));
  }

  /** Creates a new draft version of a published article (one working version at a time). */
  checkout(ctx: Context, rec: Rec): LifecycleResult {
    this.requireState(rec, ['published'], 'create a new version of');
    if (this.checkedOutRow(rec))
      throw new InvalidError('A new version of this article is already in progress');
    if (!this.canCheckout(ctx, rec))
      throw new AccessError('Insufficient rights to create a new version of this article');
    const copy = this.newVersion(ctx, rec);
    return { article: copy, state: 'draft', message: `${copy.str('display_number')} created` };
  }

  canMakeCurrent(ctx: Context, rec: Rec): boolean {
    if (ctx.user.isSystem || ctx.user.isAdmin) return true;
    const a = articleFacts(rec);
    return (
      this.access.isPrivileged(ctx, a.kb) ||
      this.access.inOwnershipGroup(ctx, a) ||
      ctx.hasRole('knowledge_manager')
    );
  }

  /** Starts a new draft version from an outdated version. */
  makeCurrent(ctx: Context, rec: Rec): LifecycleResult {
    this.requireState(rec, ['outdated'], 'make current');
    if (this.checkedOutRow(rec))
      throw new InvalidError('A new version of this article is already in progress');
    if (!this.canMakeCurrent(ctx, rec))
      throw new AccessError('Insufficient rights to make this version current');
    const copy = this.newVersion(ctx, rec);
    return {
      article: copy,
      state: 'draft',
      message: `${copy.str('display_number')} created from version ${formatVersion(this.versionOf(rec))}`,
    };
  }

  /** Republishes a retired article without approval. */
  republish(ctx: Context, rec: Rec): LifecycleResult {
    this.requireState(rec, ['retired'], 'republish');
    if (!ctx.user.isSystem && !this.access.isKnowledgeAdmin(ctx))
      throw new AccessError('Only knowledge administrators can republish articles');
    ctx.elevated().update(rec, { workflow_state: 'published', retired: '' });
    return { article: rec, state: 'published', message: `${rec.str('number')} republished` };
  }

  private newVersion(ctx: Context, source: Rec): Rec {
    const e = ctx.elevated();
    const copy = e.newRecord(source.className);
    for (const [name, col] of source.table.columns) {
      if (!col.storage || col.system || COPY_SKIP.has(name)) continue;
      copy.setRaw(name, source.data[name] ?? null);
    }
    if (!copy.str('summary')) copy.setRaw('summary', source.str('summary') || null);
    copy.setRaw('base_version', source.sysId);
    copy.setRaw('revised_by', ctx.user.sysId);
    copy.setRaw('workflow_state', 'draft');
    copy.setRaw('latest', 1);
    copy.setRaw('flagged', 0);
    const ids = this.copyAttachments(e, source, copy.sysId);
    if (ids.size) {
      for (const [name, col] of copy.table.columns) {
        if (col.type !== 'html' || !copy.str(name)) continue;
        let text = copy.str(name);
        for (const [from, to] of ids) text = text.replaceAll(from, to);
        copy.setRaw(name, text);
      }
    }
    e.insert(copy);
    return e.get(ARTICLE, copy.sysId) ?? copy;
  }

  /** Copies attachment rows and files to a new version; returns old -> new attachment ids. */
  private copyAttachments(ctx: Context, source: Rec, targetId: string): Map<string, string> {
    const out = new Map<string, string>();
    const dir = this.attachmentDir;
    if (!dir || !this.platform.registry.has('sys_attachment')) return out;
    for (const att of ctx.query('sys_attachment', { query: `table_sys_id=${source.sysId}` })) {
      const from = join(dir, att.str('storage_path') || att.sysId);
      if (!existsSync(from)) continue;
      const copy = ctx.insert('sys_attachment', {
        file_name: att.str('file_name'),
        content_type: att.str('content_type'),
        size_bytes: att.num('size_bytes'),
        size_compressed: att.num('size_compressed'),
        compressed: false,
        table_name: source.className,
        table_sys_id: targetId,
        hash: att.str('hash'),
        state: att.str('state') || 'available',
      });
      copyFileSync(from, join(dir, copy.sysId));
      this.platform.db.run(`UPDATE "sys_attachment" SET "storage_path" = ? WHERE "sys_id" = ?`, [
        copy.sysId,
        copy.sysId,
      ]);
      out.set(att.sysId, copy.sysId);
    }
    return out;
  }

  // ------------------------------------------------------------------ scheduled jobs

  /** Publishes scheduled articles whose date has passed. */
  publishScheduled(ctx: Context): number {
    const e = ctx.elevated();
    const due = e.query(ARTICLE, {
      query: `workflow_state=scheduled_publish^scheduled_publish_date<=${nowGlide()}`,
    });
    for (const rec of due) e.update(rec, { workflow_state: 'published' });
    return due.length;
  }

  /** Marks expired articles outdated; on the first day of a month, announces next month's expiries. */
  expireArticles(ctx: Context): number {
    const e = ctx.elevated();
    const expired = e.query(ARTICLE, {
      query: `workflow_state=published^valid_to<${today()}^valid_toISNOTEMPTY`,
    });
    for (const rec of expired) e.update(rec, { workflow_state: 'outdated' });
    const now = clock.now();
    if (now.getUTCDate() === 1) {
      const start = toGlideDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
      const end = toGlideDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0)));
      for (const rec of e.query(ARTICLE, {
        query: `workflow_state=published^valid_to>=${start}^valid_to<=${end}`,
      })) {
        e.queueEvent('kb.article.expiry', rec, rec.str('author'), rec.str('valid_to'));
      }
    }
    return expired.length;
  }

  /** Recomputes sys_view_count as the views in the last `glide.knowman.view_age.days` days (0 = all time). */
  recomputeViewCounts(): number {
    const days = props(this.platform).num('glide.knowman.view_age.days', 30);
    const since = days > 0 ? addMs(nowGlide(), -days * 86_400_000) : null;
    const counts = new Map<string, number>();
    for (const r of this.platform.db.all<{ article: string; n: number }>(
      `SELECT "article", COUNT(*) AS n FROM "kb_use" WHERE "viewed" = 1${since ? ` AND "sys_created_on" >= ?` : ''} GROUP BY "article"`,
      since ? [since] : [],
    ))
      counts.set(r.article, r.n);
    const c = (f: string) => `k.${articleCol(this.platform, f)}`;
    const rows = this.platform.db.all<{
      sys_id: string;
      summary: string | null;
      views: number | null;
      v: string | null;
      created: string;
    }>(
      `SELECT k."sys_id" AS sys_id, ${c('summary')} AS summary, ${c('sys_view_count')} AS views, v.${physCol(this.platform, 'kb_version', 'version')} AS v, k."sys_created_on" AS created
         FROM ${physTable(this.platform, ARTICLE)} k LEFT JOIN ${physTable(this.platform, 'kb_version')} v ON v."sys_id" = ${c('version')}`,
    );
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.summary || r.sys_id;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    let changed = 0;
    for (const list of groups.values()) {
      list.sort((a, b) => parseVersion(a.v) - parseVersion(b.v) || a.created.localeCompare(b.created));
      let running = 0;
      for (const r of list) {
        running += counts.get(r.sys_id) ?? 0;
        if ((r.views ?? 0) !== running) {
          this.platform.db.run(
            `UPDATE ${physTable(this.platform, ARTICLE)} SET ${articleCol(this.platform, 'sys_view_count')} = ? WHERE "sys_id" = ?`,
            [running, r.sys_id],
          );
          changed++;
        }
      }
    }
    return changed;
  }

  // ------------------------------------------------------------------ views and use

  /** Adds `delta` to a counter on this version and on every later version of the same article. */
  private bumpCounter(rec: Rec, field: 'sys_view_count' | 'use_count', delta: number): void {
    const own = this.versionOf(rec);
    const rows = this.versionRows(rec.str('summary') || rec.sysId).filter(
      (r) => r.sysId === rec.sysId || r.version >= own,
    );
    const col = articleCol(this.platform, field);
    for (const r of rows) {
      this.platform.db.run(
        `UPDATE ${physTable(this.platform, ARTICLE)} SET ${col} = COALESCE(${col}, 0) + ? WHERE "sys_id" = ?`,
        [delta, r.sysId],
      );
    }
  }

  /** Logs an article view (kb_use) and increments the view count. */
  recordView(
    ctx: Context,
    rec: Rec,
    opts: { searchId?: string | null; rank?: number | null; sessionId?: string | null } = {},
  ): void {
    const e = ctx.elevated();
    const uid = ctx.user.sysId;
    const before = uid
      ? (this.platform.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM "kb_use" WHERE "article" = ? AND "user" = ? AND "viewed" = 1`,
          [rec.sysId, uid],
        )?.n ?? 0)
      : 0;
    const searchId =
      opts.searchId && isSysId(opts.searchId) && e.get('ts_query_kb', opts.searchId) ? opts.searchId : '';
    e.insert('kb_use', {
      article: rec.sysId,
      user: uid ?? '',
      viewed: true,
      used: false,
      times_viewed: before + 1,
      search_id: searchId,
      session_id: opts.sessionId ?? '',
    });
    this.bumpCounter(rec, 'sys_view_count', 1);
    if (searchId && opts.rank) this.search.recordClick(searchId, opts.rank);
  }

  /** Counts a use of the article (attached to a task). Called when an m2m_kb_task row is inserted. */
  recordUse(ctx: Context, articleId: string, taskId: string): void {
    const e = ctx.elevated();
    const rec = e.get(ARTICLE, articleId);
    if (!rec) return;
    e.insert('kb_use', {
      article: rec.sysId,
      user: ctx.user.sysId ?? '',
      viewed: false,
      used: true,
      task: taskId,
    });
    this.bumpCounter(rec, 'use_count', 1);
  }

  /** Attach to Task: links the article, copies its number, title and link into the task, counts a use. */
  attachToTask(ctx: Context, rec: Rec, taskId: string): { task: Rec; attached: boolean } {
    if (!this.access.canSeeArticle(ctx, articleFacts(rec))) throw new NotFoundError();
    const task = isSysId(taskId) ? ctx.get('task', taskId) : null;
    if (!task) throw new NotFoundError('No Record found', 'The task does not exist or you cannot read it');
    if (!ctx.user.isSystem && !this.platform.acl.canTable(ctx, task.className, 'write', task).allowed) {
      throw new AccessError('Insufficient rights to update the task');
    }
    const e = ctx.elevated();
    if (e.first('m2m_kb_task', `kb_knowledge=${rec.sysId}^task=${task.sysId}`))
      return { task, attached: false };
    e.insert('m2m_kb_task', { kb_knowledge: rec.sysId, task: task.sysId });
    const fields = props(this.platform)
      .str('glide.knowman.attach.fields', 'comments')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const field = fields.find((f) => task.has(f)) ?? 'comments';
    const plain = stripHtml(rec.str('text')).replace(/\n{2,}/g, '\n');
    const note = `Knowledge article ${rec.str('number')}: ${rec.str('short_description')}\n${this.absoluteArticleUrl(rec)}\n\n${truncate(plain, 600)}`;
    const col = task.column(field);
    if (col && JOURNAL_TYPES.has(col.type)) {
      ctx.update(task, { [field]: note });
    } else if (col) {
      const existing = task.str(field);
      ctx.update(task, { [field]: existing ? `${existing}\n\n${note}` : note });
    }
    return { task, attached: true };
  }

  // ------------------------------------------------------------------ feedback

  /** Which feedback kinds a reader may give on an article (base switches and properties). */
  feedbackOptions(article: Rec): { helpful: boolean; rating: boolean; comment: boolean; flag: boolean } {
    const p = props(this.platform);
    const kb = this.kbRecord(article.str('kb_knowledge_base'));
    const master = p.bool('glide.knowman.show_rating_options', true);
    return {
      helpful: master && p.bool('glide.knowman.show_yn_rating', true) && !kb?.bool('disable_mark_as_helpful'),
      rating: master && p.bool('glide.knowman.show_star_rating', true) && !kb?.bool('disable_rating'),
      comment:
        p.bool('glide.knowman.show_user_feedback', true) &&
        !kb?.bool('disable_commenting') &&
        !article.bool('disable_commenting'),
      flag:
        p.bool('glide.knowman.show_flag', true) &&
        !kb?.bool('disable_suggesting') &&
        !article.bool('disable_suggesting'),
    };
  }

  /** Why a feedback record may not be created (null when allowed). */
  feedbackDenial(ctx: Context, fb: Rec): string | null {
    const article = fb.ref('article');
    if (!article) return 'Unknown article';
    if (!ctx.user.isSystem && !ctx.user.sysId) return 'Sign in to give feedback';
    if (!this.access.canSeeArticle(ctx, articleFacts(article))) return 'You cannot read this article';
    const o = this.feedbackOptions(article);
    if (fb.str('useful') && !o.helpful) return 'Marking this article as helpful is disabled';
    if (fb.get('rating') !== null && fb.str('rating') !== '' && !o.rating)
      return 'Rating is disabled for this knowledge base';
    if (fb.bool('flagged') && !o.flag) return 'Flagging is disabled for this article';
    if (!fb.bool('flagged') && fb.str('comments').trim() && !o.comment)
      return 'Comments are disabled for this article';
    return null;
  }

  /** Validation of a new feedback record (before insert). */
  prepareFeedback(ctx: Context, fb: Rec): void {
    const userCtx = ctx.enforceAcl && !ctx.user.isSystem && !ctx.user.isAdmin;
    if (userCtx || !fb.str('user')) fb.setRaw('user', ctx.user.sysId);
    const rating = fb.get('rating');
    if (
      rating !== null &&
      rating !== '' &&
      (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)
    ) {
      fb.abort('Rating must be a whole number from 1 to 5');
      return;
    }
    const useful = fb.str('useful');
    if (useful && useful !== 'yes' && useful !== 'no') {
      fb.abort('Helpful must be yes or no');
      return;
    }
    if (!useful && (rating === null || rating === '') && !fb.str('comments').trim() && !fb.bool('flagged')) {
      fb.abort('Feedback needs a helpful answer, a rating, a comment or a flag');
      return;
    }
    if (!ctx.user.isSystem) {
      const denial = this.feedbackDenial(ctx, fb);
      if (denial) {
        fb.abort(denial);
        return;
      }
    }
    const cap = props(this.platform).num('glide.knowman.max_comments_per_user_daily', 0);
    if (cap > 0 && fb.str('comments').trim() && !fb.bool('flagged') && fb.str('user')) {
      const n =
        this.platform.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM "kb_feedback" WHERE "user" = ? AND COALESCE("comments", '') <> '' AND "sys_created_on" >= ?`,
          [fb.str('user'), `${today()} 00:00:00`],
        )?.n ?? 0;
      if (n >= cap) fb.abort(`You can post at most ${cap} comments per day`);
    }
  }

  /** After a feedback insert: one effective helpful/rating answer per user and version, counters, flags, tasks. */
  afterFeedback(ctx: Context, fb: Rec): void {
    const e = ctx.elevated();
    const uid = fb.str('user');
    const articleId = fb.str('article');
    if (uid) {
      for (const field of ['useful', 'rating'] as const) {
        if (fb.get(field) === null || fb.str(field) === '') continue;
        for (const old of e.query(
          'kb_feedback',
          `article=${articleId}^user=${uid}^sys_id!=${fb.sysId}^${field}ISNOTEMPTY`,
        )) {
          const other = field === 'useful' ? old.get('rating') !== null : !!old.str('useful');
          if (other || old.str('comments').trim() || old.bool('flagged'))
            e.derive({ workflow: false }).update(old, { [field]: '' });
          else e.derive({ workflow: false }).delete(old);
        }
      }
    }
    if (fb.bool('flagged')) {
      this.platform.db.run(
        `UPDATE ${physTable(this.platform, ARTICLE)} SET ${articleCol(this.platform, 'flagged')} = 1 WHERE "sys_id" = ?`,
        [articleId],
      );
    }
    this.recomputeFeedback(articleId);
    this.maybeCreateFeedbackTask(ctx, fb);
  }

  /**
   * Feedback over all versions of an article, counting each user's latest answer:
   * helpful yes/no, average rating, and the given user's own answers.
   */
  feedbackSummary(article: Rec, userId?: string | null) {
    const key = article.str('summary');
    const c = (f: string) => `k.${articleCol(this.platform, f)}`;
    const rows = this.platform.db.all<{
      user: string | null;
      useful: string | null;
      rating: number | null;
      rid: number;
    }>(
      `SELECT f."user" AS user, f."useful" AS useful, f."rating" AS rating, f.rowid AS rid
         FROM "kb_feedback" f JOIN ${physTable(this.platform, ARTICLE)} k ON k."sys_id" = f."article"
        WHERE ${key ? `${c('summary')} = ?` : `k."sys_id" = ?`}
        ORDER BY f."sys_created_on", f.rowid`,
      [key || article.sysId],
    );
    const useful = new Map<string, string>();
    const ratings = new Map<string, number>();
    for (const r of rows) {
      const who = r.user || `anonymous:${r.rid}`;
      if (r.useful) useful.set(who, r.useful);
      if (r.rating !== null && r.rating !== undefined) ratings.set(who, Number(r.rating));
    }
    const yes = [...useful.values()].filter((v) => v === 'yes').length;
    const no = [...useful.values()].filter((v) => v === 'no').length;
    const average = ratings.size
      ? Math.round(([...ratings.values()].reduce((a, b) => a + b, 0) / ratings.size) * 100) / 100
      : null;
    return {
      helpful: { yes, no, percent: yes + no ? Math.round((yes / (yes + no)) * 100) : null },
      rating: { average, count: ratings.size },
      mine: { useful: (userId && useful.get(userId)) || '', rating: (userId && ratings.get(userId)) || null },
    };
  }

  /** Helpful count and average rating over all versions (latest answer per user). */
  recomputeFeedback(articleId: string): void {
    const article = this.platform.systemContext().get(ARTICLE, articleId);
    if (!article) return;
    const key = article.str('summary');
    const s = this.feedbackSummary(article);
    this.platform.db.run(
      `UPDATE ${physTable(this.platform, ARTICLE)} SET ${articleCol(this.platform, 'helpful_count')} = ?, ${articleCol(this.platform, 'rating')} = ? WHERE ${key ? `${articleCol(this.platform, 'summary')} = ?` : `"sys_id" = ?`}`,
      [s.helpful.yes, s.rating.average, key || articleId],
    );
  }

  /** Re-derives the flagged flag of an article version from its feedback. */
  recomputeFlag(articleId: string): void {
    const flagged = !!this.platform.db.get(
      `SELECT 1 FROM "kb_feedback" WHERE "article" = ? AND "flagged" = 1 LIMIT 1`,
      [articleId],
    );
    this.platform.db.run(
      `UPDATE ${physTable(this.platform, ARTICLE)} SET ${articleCol(this.platform, 'flagged')} = ? WHERE "sys_id" = ?`,
      [flagged ? 1 : 0, articleId],
    );
  }

  /** Actionable feedback: a task for flags, "not helpful" answers or low ratings, per the feedback properties. */
  maybeCreateFeedbackTask(ctx: Context, fb: Rec): Rec | null {
    const p = props(this.platform);
    const details = fb.str('comments').trim();
    const rating = fb.num('rating');
    let kind: 'flag' | 'helpful' | 'rating' | null = null;
    if (fb.bool('flagged') && p.bool('glide.knowman.feedback.enable_actionable_feedback_for_flag', true))
      kind = 'flag';
    else if (
      fb.str('useful') === 'no' &&
      p.bool('glide.knowman.feedback.enable_actionable_feedback_for_helpful', false)
    )
      kind = 'helpful';
    else {
      const threshold = p.num('glide.knowman.feedback.enable_actionable_feedback_for_rating', Number.NaN);
      if (rating !== null && Number.isFinite(threshold) && threshold >= 1 && rating <= threshold)
        kind = 'rating';
    }
    if (!kind) return null;
    if (p.bool('glide.knowman.feedback.enable_explicit_feedback', false) && !details) return null;
    if (!this.platform.registry.has('kb_feedback_task')) return null;
    const e = ctx.elevated();
    const article = e.get(ARTICLE, fb.str('article'));
    if (!article) return null;
    const group = article.str('ownership_group');
    let assignee = article.str('revised_by') || article.str('author');
    if (group) assignee = e.get('sys_user_group', group)?.str('manager') || assignee;
    const label =
      kind === 'flag' ? 'Flagged article' : kind === 'helpful' ? 'Not helpful' : `Rated ${rating} of 5`;
    const description =
      details ||
      (kind === 'helpful'
        ? 'A reader marked this article as not helpful.'
        : kind === 'rating'
          ? `A reader rated this article ${rating} out of 5.`
          : 'A reader flagged this article for review.');
    const task = e.insert('kb_feedback_task', {
      short_description: truncate(
        `${label}: ${article.str('number')} ${article.str('short_description')}`,
        160,
      ),
      description,
      article: article.sysId,
      feedback: fb.sysId,
      reason: fb.str('reason'),
      assignment_group: group,
      assigned_to: assignee,
      opened_by: fb.str('user') || ctx.user.sysId || '',
    });
    this.platform.db.run(`UPDATE "kb_feedback" SET "feedback_task" = ? WHERE "sys_id" = ?`, [
      task.sysId,
      fb.sysId,
    ]);
    return task;
  }

  // ------------------------------------------------------------------ knowledge from tasks

  /** Base for articles created from tasks: `glide.knowman.task_kb`, else the first base the user can contribute to. */
  taskKnowledgeBase(ctx: Context): string | null {
    const configured = props(this.platform).str('glide.knowman.task_kb');
    if (isSysId(configured) && this.access.kb(configured)?.active) return configured;
    const kbs = this.access.allKbs().filter((k) => k.active);
    const mine = kbs.filter((k) => this.access.canContributeKb(ctx, k.id));
    return (mine[0] ?? kbs[0])?.id ?? null;
  }

  knownErrorKnowledgeBase(ctx: Context): string | null {
    const configured = props(this.platform).str('resolvr.knowledge.known_error_kb');
    if (isSysId(configured) && this.access.kb(configured)?.active) return configured;
    const named = this.access.allKbs().find((k) => k.active && k.title.toLowerCase() === 'known error');
    return named?.id ?? this.taskKnowledgeBase(ctx);
  }

  /** Journal entries of a task, oldest first. */
  private journalText(task: Rec, field: string): string[] {
    return this.platform.history
      .journal(task.className, task.sysId, [field])
      .reverse()
      .map((j) => j.value)
      .filter((v) => v.trim());
  }

  /** Article body from a task: issue, workaround/cause (problems), resolution notes and customer-visible notes. */
  taskArticleBody(task: Rec): string {
    const parts: string[] = [];
    const isProblem = task.table.ancestors.includes('problem');
    parts.push(`<h3>Issue</h3>${textToHtml(task.str('description') || task.str('short_description'))}`);
    if (task.has('workaround') && task.str('workaround').trim())
      parts.push(`<h3>Workaround</h3>${asHtml(task.str('workaround'))}`);
    if (task.has('cause_notes') && task.str('cause_notes').trim())
      parts.push(`<h3>Cause</h3>${asHtml(task.str('cause_notes'))}`);
    const resolution = task.str('close_notes') || (task.has('fix_notes') ? task.str('fix_notes') : '');
    if (resolution.trim()) parts.push(`<h3>Resolution</h3>${asHtml(resolution)}`);
    const notes = this.journalText(task, isProblem ? 'work_notes' : 'comments');
    if (notes.length)
      parts.push(`<h3>${isProblem ? 'Work notes' : 'Notes'}</h3>${notes.map((n) => textToHtml(n)).join('')}`);
    return parts.join('\n');
  }

  /** An article (or submission) already created from this task. */
  existingFromTask(task: Rec): FromTaskResult | null {
    const art = this.platform.db.get<{ sys_id: string; cls: string }>(
      `SELECT "sys_id", "sys_class_name" AS cls FROM ${physTable(this.platform, ARTICLE)} WHERE ${articleCol(this.platform, 'source')} = ? LIMIT 1`,
      [task.sysId],
    );
    if (art) return { table: art.cls, sysId: art.sys_id, created: false };
    if (this.platform.registry.has('kb_submission')) {
      const sub = this.platform.db.get<{ sys_id: string }>(
        `SELECT "sys_id" FROM ${physTable(this.platform, 'kb_submission')} WHERE "sys_class_name" = 'kb_submission' AND ${physCol(this.platform, 'kb_submission', 'parent')} = ? LIMIT 1`,
        [task.sysId],
      );
      if (sub) return { table: 'kb_submission', sysId: sub.sys_id, created: false };
    }
    return null;
  }

  /** KCS path for incidents: `enable_kcs_incident` and a table map from the incident class. */
  private kcsMap(ctx: Context, task: Rec): Rec | null {
    if (!task.table.ancestors.includes('incident')) return null;
    if (!props(this.platform).bool('enable_kcs_incident', false)) return null;
    if (!this.platform.registry.has('csm_table_map')) return null;
    for (const t of task.table.ancestors) {
      const map = ctx.asSystem().first('csm_table_map', `source_table=${t}^target_tableSTARTSWITHkb_`);
      if (map && this.platform.registry.has(map.str('target_table'))) return map;
    }
    return null;
  }

  isKcsActive(ctx: Context, task: Rec): boolean {
    return !!this.kcsMap(ctx, task);
  }

  /**
   * Creates a draft article from a task (Knowledge checkbox at close, or on demand). With the
   * submission workflow a kb_submission is created instead; for incidents with KCS enabled the
   * table map produces a KCS article. Idempotent per task.
   */
  createFromTask(ctx: Context, task: Rec): FromTaskResult | null {
    const existing = this.existingFromTask(task);
    if (existing) return existing;
    const e = ctx.elevated();
    const kb = this.taskKnowledgeBase(ctx);
    if (!kb) return null;
    const author = task.str('assigned_to') || ctx.user.sysId || '';
    const map = this.kcsMap(ctx, task);
    if (map) {
      const values = this.applyTableMap(e, map, task);
      const target = map.str('target_table');
      const art = e.insert(target, { ...values, kb_knowledge_base: kb, author, source: task.sysId });
      e.derive({ workflow: false }).insert('m2m_kb_task', { kb_knowledge: art.sysId, task: task.sysId });
      return { table: art.className, sysId: art.sysId, created: true };
    }
    const body = this.taskArticleBody(task);
    const title = truncate(task.str('short_description') || `Knowledge from ${task.str('number')}`, 100);
    if (
      props(this.platform).bool('glide.knowman.submission.workflow', false) &&
      this.platform.registry.has('kb_submission')
    ) {
      const sub = e.insert('kb_submission', {
        short_description: title,
        description: `Knowledge submitted from ${task.str('number')}`,
        text: body,
        kb_knowledge_base: kb,
        parent: task.sysId,
        status: '1',
        opened_by: ctx.user.sysId ?? '',
      });
      return { table: 'kb_submission', sysId: sub.sysId, created: true };
    }
    const art = e.insert(ARTICLE, {
      kb_knowledge_base: kb,
      short_description: title,
      text: body,
      source: task.sysId,
      author,
    });
    e.derive({ workflow: false }).insert('m2m_kb_task', { kb_knowledge: art.sysId, task: task.sysId });
    return { table: ARTICLE, sysId: art.sysId, created: true };
  }

  /** Field mapping from a source task to a knowledge template (csm_table_map / csm_field_map). */
  private applyTableMap(ctx: Context, map: Rec, task: Rec): Record<string, unknown> {
    const target = this.platform.registry.table(map.str('target_table'));
    const values: Record<string, unknown> = {};
    for (const fm of ctx.asSystem().query('csm_field_map', `table_map=${map.sysId}`)) {
      const from = fm.str('source_field');
      const to = fm.str('target_field');
      const tcol = target.columns.get(to);
      if (!tcol) continue;
      let v = '';
      if (from === 'sys_id') v = task.sysId;
      else {
        const scol = task.column(from);
        if (!scol) continue;
        v = JOURNAL_TYPES.has(scol.type) ? this.journalText(task, from).join('\n\n') : task.str(from);
      }
      values[to] = tcol.type === 'html' ? asHtml(v) : v;
    }
    // Advanced mapping (built in): the issue comes from the first customer comment, else the description.
    if (map.bool('advanced') && target.columns.has('kb_issue') && !values.kb_issue) {
      const first =
        this.journalText(task, 'comments')[0] ?? task.str('description') ?? task.str('short_description');
      values.kb_issue = asHtml(first);
    }
    if (!values.short_description) values.short_description = truncate(task.str('short_description'), 100);
    return values;
  }

  /** Creates the draft article from a knowledge submission and closes the submission. */
  createFromSubmission(ctx: Context, sub: Rec): Rec {
    if (sub.str('kb_knowledge')) {
      const existing = ctx.elevated().get(ARTICLE, sub.str('kb_knowledge'));
      if (existing) return existing;
    }
    const e = ctx.elevated();
    const kb = sub.str('kb_knowledge_base') || this.taskKnowledgeBase(ctx);
    if (!kb) throw new InvalidError('No knowledge base is available');
    const source = sub.str('parent');
    const art = e.insert(ARTICLE, {
      kb_knowledge_base: kb,
      kb_category: sub.str('kb_category'),
      short_description: truncate(sub.str('short_description'), 100),
      text: sub.str('text'),
      source,
      author: ctx.user.sysId ?? '',
    });
    if (source)
      e.derive({ workflow: false }).insert('m2m_kb_task', { kb_knowledge: art.sysId, task: source });
    e.update(sub, { kb_knowledge: art.sysId, status: 'closed_created', state: '3' });
    return art;
  }

  closeSubmission(
    ctx: Context,
    sub: Rec,
    status: 'closed_duplicate' | 'closed_invalid',
    note?: string,
  ): void {
    ctx.elevated().update(sub, { status, state: '4', close_notes: note ?? '' });
  }

  /** Known Error article from a problem (table name strings only, no dependency on the problem module). */
  createKnownErrorArticle(ctx: Context, problem: Rec): FromTaskResult {
    const e = ctx.elevated();
    const current = problem.has('primary_known_error_article')
      ? problem.str('primary_known_error_article')
      : '';
    if (current && e.get(ARTICLE, current))
      return { table: e.get(ARTICLE, current)!.className, sysId: current, created: false };
    const kb = this.knownErrorKnowledgeBase(ctx);
    if (!kb) throw new InvalidError('No knowledge base is available for known error articles');
    const category = problem.has('category') ? problem.str('category') : '';
    let kbCategory = '';
    if (category) {
      const display = problem.display('category');
      const match = e
        .query('kb_category', 'active=true')
        .find(
          (c) =>
            this.access.categoryKb(c.sysId) === kb &&
            [c.str('value').toLowerCase(), c.str('label').toLowerCase()].some(
              (v) => v && (v === category.toLowerCase() || v === display.toLowerCase()),
            ),
        );
      kbCategory = match?.sysId ?? '';
    }
    const table = this.platform.registry.has('kb_template_known_error_article')
      ? 'kb_template_known_error_article'
      : ARTICLE;
    const values: Record<string, unknown> = {
      kb_knowledge_base: kb,
      kb_category: kbCategory,
      category,
      short_description: truncate(
        problem.str('short_description') || `Known error ${problem.str('number')}`,
        100,
      ),
      source: problem.sysId,
      author: ctx.user.sysId ?? '',
    };
    const description = asHtml(problem.str('description') || problem.str('short_description'));
    const workaround = problem.has('workaround') ? asHtml(problem.str('workaround')) : '';
    const cause = problem.has('cause_notes') ? asHtml(problem.str('cause_notes')) : '';
    if (table === ARTICLE) {
      values.text = [
        `<h3>Description</h3>${description}`,
        workaround && `<h3>Workaround</h3>${workaround}`,
        cause && `<h3>Cause</h3>${cause}`,
      ]
        .filter(Boolean)
        .join('\n');
    } else {
      Object.assign(values, { kb_description: description, kb_workaround: workaround, kb_cause: cause });
    }
    const art = e.insert(table, values);
    e.derive({ workflow: false }).insert('m2m_kb_task', { kb_knowledge: art.sysId, task: problem.sysId });
    const updates: Record<string, unknown> = {};
    if (problem.has('primary_known_error_article')) updates.primary_known_error_article = art.sysId;
    if (problem.has('known_error')) updates.known_error = true;
    if (Object.keys(updates).length) e.update(problem, updates);
    return { table: art.className, sysId: art.sysId, created: true };
  }

  // ------------------------------------------------------------------ templates

  /** Builds the body of a template article from its fields, each under its label. */
  composeTemplateBody(cur: Rec): void {
    const tpl =
      TEMPLATE_CLASSES[cur.className] ?? cur.table.ancestors.map((t) => TEMPLATE_CLASSES[t]).find(Boolean);
    if (!tpl) return;
    const parts = tpl.fields
      .filter((f) => cur.str(f.field).trim())
      .map((f) => `<h3>${escapeHtml(f.label)}</h3>\n${asHtml(cur.str(f.field))}`);
    cur.setRaw('text', parts.join('\n'));
    if (!cur.str('meta_description')) {
      const seo = stripHtml(cur.str(tpl.seo)).replace(/\s+/g, ' ');
      if (seo) cur.setRaw('meta_description', truncate(seo, 160));
    }
  }

  /** Template rules: active template, allowed in the base, standard template not disabled. */
  templateDenial(ctx: Context, cur: Rec, kb: Rec): string | null {
    const cls = cur.className;
    if (cls === ARTICLE && kb.bool('disable_standard_template'))
      return `The standard template is disabled for ${kb.str('title')}`;
    if (!this.platform.registry.has('kb_article_template')) return null;
    const s = ctx.asSystem();
    const template = s.first('kb_article_template', `child_table=${cls}`);
    if (template && cls !== ARTICLE && !template.bool('active'))
      return `The ${template.str('name')} template is not active`;
    const allowed = s
      .query('m2m_kb_template_kb', `kb_knowledge_base=${kb.sysId}`)
      .map((r) => r.str('template'));
    if (allowed.length && (!template || !allowed.includes(template.sysId))) {
      return `The ${template?.str('name') ?? cur.table.label} template cannot be used in ${kb.str('title')}`;
    }
    return null;
  }

  // ------------------------------------------------------------------ notifications

  /** Sends an email through the notifications application when it is installed. */
  notify(ctx: Context, to: string[], subject: string, body: string, target: Rec | null): void {
    const svc = optionalService<NotificationService>(this.platform, SERVICES.notifications);
    const recipients = [...new Set(to.filter(Boolean))];
    if (!svc || !recipients.length) return;
    try {
      svc.send(ctx, { to: recipients, subject, body, target });
    } catch (e) {
      this.platform.reportError('knowledge notification', e);
    }
  }

  // ------------------------------------------------------------------ facts helper

  facts(rec: Rec): ArticleFacts {
    return articleFacts(rec);
  }

  /** Valid-to date for a new article in a base (blank validity: 2100-01-01). */
  validTo(kb: Rec | null, from: Date = clock.now()): string {
    const days = kb?.num('article_validity');
    return days && days > 0 ? addDaysToDate(days, from) : '2100-01-01';
  }

  /** Scheduled publish dates must be at least 24 hours ahead. */
  scheduleDenial(value: string): string | null {
    if (!value) return null;
    const when = parseGlideDateTime(value);
    if (!when) return 'Invalid scheduled publish date';
    if (when.getTime() < clock.now().getTime() + 24 * 3_600_000) {
      return 'The scheduled publish date must be at least 24 hours from now. Use Publish to publish sooner.';
    }
    return null;
  }
}
