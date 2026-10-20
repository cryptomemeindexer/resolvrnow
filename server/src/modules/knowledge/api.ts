import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ApiDeps, baseUrl, ctxOf, HttpError, intParam } from '../../api/http.js';
import { readAttachment } from '../../api/now/attachment.js';
import { parseBool, serializeRecord } from '../../api/serialize.js';
import type { Context } from '../../engine/context.js';
import { AuthError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import type { SessionUser } from '../../engine/services/users.js';
import { isSysId } from '../../engine/util.js';
import { toApiValue } from '../../engine/values.js';
import { articleFacts } from './access.js';
import type { SearchHit, SearchOrder } from './search.js';
import { knowledge, type LifecycleResult, languageLabel } from './service.js';
import { ARTICLE, formatVersion, props, splitList, stripHtml, truncate } from './util.js';

type Q = Record<string, unknown>;

/** Anonymous reader of public knowledge bases (no roles, not an internal user). */
const GUEST = Object.freeze({
  sysId: null,
  userName: 'guest',
  name: 'Guest',
  email: null,
  roles: new Set<string>(),
  groups: [],
  timeZone: null,
  managerId: null,
  isSystem: false,
  isAdmin: false,
}) as unknown as SessionUser;

const KM_PREFIXES = [
  '/api/sn_km_api/knowledge',
  '/api/sn_km_api/v1/knowledge',
  '/api/sn_km_api/v2/knowledge',
];

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => splitList(x));
  return splitList(v);
}

/** Fixed-window limiter for anonymous and external callers (500 requests per hour). */
class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();

  constructor(
    private max = 500,
    private windowMs = 3_600_000,
  ) {}

  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

/** Field value objects of the Knowledge API: {display_value, label, name, type, value}. */
function fieldObjects(ctx: Context, rec: Rec, names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of names) {
    const parts = path.split('.');
    let target: Rec | null = rec;
    for (let i = 0; target && i < parts.length - 1; i++) target = target.ref(parts[i]);
    const field = parts[parts.length - 1];
    const col = target?.column(field);
    if (!target || !col?.storage) continue;
    if (!ctx.platform.acl.canField(ctx, target.className, field, 'read', target)) continue;
    out[path] = {
      display_value: target.display(field),
      label: col.label,
      name: path,
      type: col.type,
      value: toApiValue(col, target.get(field)),
    };
  }
  return out;
}

function plainSnippet(rec: Rec): string {
  return truncate(stripHtml(rec.str('text')).replace(/\s+/g, ' '), 200);
}

function tagsOf(rec: Rec): string[] {
  return [
    ...new Set(
      rec
        .str('meta')
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

export function registerKnowledgeApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const svc = knowledge(platform);
  svc.attachmentDir = deps.config.attachmentDir;
  svc.publicUrl = deps.config.publicUrl;
  const limiter = new RateLimiter();

  /** Knowledge API caller: authenticated user, or a guest unless authentication is required. */
  const kmCtx = (req: FastifyRequest): Context => {
    const auth = req.auth;
    if (auth) {
      if (
        auth.user.roles.has('snc_external') &&
        !auth.user.isAdmin &&
        !limiter.take(`user:${auth.user.sysId}`)
      ) {
        throw new HttpError(
          429,
          'Rate limit exceeded',
          'External users can make 500 Knowledge API requests per hour',
        );
      }
      return platform.contextFor(auth.user);
    }
    if (props(platform).bool('resolvr.km_api.require_auth', false)) throw new AuthError();
    if (!limiter.take(`ip:${req.ip}`)) {
      throw new HttpError(
        429,
        'Rate limit exceeded',
        'Unauthenticated callers can make 500 Knowledge API requests per hour',
      );
    }
    return platform.contextFor(GUEST);
  };

  const translationsOf = (ctx: Context, rec: Rec): Rec[] => {
    const base = rec.str('parent') ? (ctx.elevated().get(ARTICLE, rec.str('parent')) ?? rec) : rec;
    const ids = svc.versionRows(base.str('summary') || base.sysId).map((r) => r.sysId);
    return ctx.query(ARTICLE, { query: `parentIN${ids.join(',')}^workflow_state=published^ORDERBYlanguage` });
  };

  /** sys_id, or KB number (current published version; `language` selects a translation). */
  const resolveArticle = (ctx: Context, id: string, language: string): Rec | null => {
    if (isSysId(id)) return ctx.get(ARTICLE, id);
    const number = String(id).toUpperCase();
    if (!/^KB\d+$/.test(number)) return null;
    const rows = ctx.query(ARTICLE, { query: `number=${number}` });
    const base =
      rows.find((r) => r.str('workflow_state') === 'published') ??
      rows.find((r) => r.bool('latest')) ??
      rows[0] ??
      null;
    if (base && language && language !== (base.str('language') || 'en')) {
      const tr = translationsOf(ctx, base).find(
        (t) => (t.str('language') || 'en').toLowerCase() === language,
      );
      if (tr) return tr;
    }
    return base;
  };

  const languagesOf = (ctx: Context, rec: Rec) => {
    const base = rec.str('parent') ? (ctx.get(ARTICLE, rec.str('parent')) ?? rec) : rec;
    return [base, ...translationsOf(ctx, rec)]
      .filter((r, i, all) => all.findIndex((x) => x.sysId === r.sysId) === i)
      .map((r) => {
        const code = r.str('language') || 'en';
        return { label: languageLabel(code), language: code, sys_id: r.sysId };
      });
  };

  const attachmentsOf = (ctx: Context, rec: Rec) =>
    ctx
      .elevated()
      .query('sys_attachment', { query: `table_sys_id=${rec.sysId}^ORDERBYfile_name` })
      .map((a) => ({
        sys_id: a.sysId,
        file_name: a.str('file_name'),
        size_bytes: a.str('size_bytes'),
        state: a.str('state') || 'available',
      }));

  // ------------------------------------------------------------------ Knowledge API (KM-1 .. KM-5)

  for (const base of KM_PREFIXES) {
    app.get(`${base}/articles`, async (req) => {
      const ctx = kmCtx(req);
      const q = req.query as Q;
      const query = String(q.query ?? '').trim();
      const filter = String(q.filter ?? '');
      const fields = list(q.fields);
      const kbs = list(q.kb);
      const language = String(q.language ?? '').trim() || 'en';
      const limit = intParam(q.limit, 30, 1, 1000);
      const offset = intParam(q.offset, 0, 0);
      const res = svc.search.search(ctx, {
        query,
        filter,
        kbs: kbs.length ? kbs : undefined,
        languages: language === 'all' ? null : list(language),
        limit,
        offset,
        log: query ? { source: 'knowledge_api', sessionId: req.auth?.sessionId ?? null } : null,
      });
      return {
        result: {
          meta: {
            start: offset,
            end: offset + limit,
            fields: fields.join(','),
            query,
            filter,
            kb: kbs.join(','),
            language,
            count: res.total,
            ts_query_id: res.searchId ?? '',
            status: { code: 200 },
          },
          articles: res.hits.map((h) => ({
            id: `kb_knowledge:${h.rec.sysId}`,
            number: h.rec.str('number'),
            title: h.rec.str('short_description'),
            snippet: h.snippet,
            link: `?sys_kb_id=${h.rec.sysId}&id=kb_article_view&sysparm_rank=${h.rank}${res.searchId ? `&sysparm_tsqueryId=${res.searchId}` : ''}`,
            rank: h.rank,
            score: h.score,
            fields: fieldObjects(ctx, h.rec, fields),
          })),
        },
      };
    });

    const homepageList = (req: FastifyRequest, kind: 'featured' | 'most_viewed') => {
      const ctx = kmCtx(req);
      const q = req.query as Q;
      const fields = list(q.fields);
      const kbs = list(q.kb);
      const language = String(q.language ?? '').trim() || 'en';
      const limit = intParam(q.limit, 30, 1, 1000);
      const offset = intParam(q.offset, 0, 0);
      const corpus = svc.search.corpus(ctx, {
        kbs: kbs.length ? kbs : undefined,
        languages: language === 'all' ? null : list(language),
      });
      const viewed = corpus.filter((r) => (r.num('sys_view_count') ?? 0) > 0);
      let all = viewed;
      if (kind === 'featured') {
        const keyword = props(platform).str('glide.knowman.default_keyword', 'homepage');
        const featuredIds = platform.db
          .all<{ id: string }>(
            `SELECT kk."kb_knowledge" AS id FROM "kb_knowledge_keyword" kk JOIN "kb_keyword" k ON k."sys_id" = kk."kb_keyword" WHERE k."keyword" = ? COLLATE NOCASE ORDER BY kk."order", kk."sys_created_on"`,
            [keyword],
          )
          .map((r) => r.id);
        const byId = new Map(corpus.map((r) => [r.sysId, r]));
        const featured = [...new Set(featuredIds)].map((id) => byId.get(id)).filter((r): r is Rec => !!r);
        all = [...featured, ...viewed.filter((r) => !featuredIds.includes(r.sysId))];
      }
      const page = all.slice(offset, offset + limit);
      return {
        result: {
          meta: {
            start: offset,
            end: offset + limit,
            fields: fields.join(','),
            query: kind === 'featured' ? 'homepage' : '',
            filter: '',
            kb: kbs.join(','),
            language,
            count: all.length,
            status: { code: 200 },
          },
          articles: page.map((r) => ({
            id: `kb_knowledge:${r.sysId}`,
            number: r.str('number'),
            title: r.str('short_description'),
            snippet: plainSnippet(r),
            link: `?id=kb_article_view&sys_kb_id=${r.sysId}`,
            score: kind === 'featured' ? -1 : (r.num('sys_view_count') ?? 0),
            fields: fieldObjects(ctx, r, fields),
            ...(kind === 'most_viewed' ? { tags: tagsOf(r) } : {}),
          })),
        },
      };
    };
    app.get(`${base}/articles/featured`, async (req) => homepageList(req, 'featured'));
    app.get(`${base}/articles/most_viewed`, async (req) => homepageList(req, 'most_viewed'));

    app.get(`${base}/articles/:id`, async (req) => {
      const ctx = kmCtx(req);
      const { id } = req.params as { id: string };
      const q = req.query as Q;
      const fields = list(q.fields);
      const language = String(q.language ?? '')
        .trim()
        .toLowerCase();
      const rec = resolveArticle(ctx, id, language);
      if (!rec) throw new NotFoundError('No Record found', 'Knowledge record not found');
      const searchId = String(q.search_id ?? '');
      const rank = Number(q.search_rank);
      const sessionId = req.auth?.sessionId ?? null;
      if (searchId && Number.isFinite(rank) && rank > 0)
        svc.recordView(ctx, rec, { searchId, rank, sessionId });
      else if (q.update_view !== undefined) svc.recordView(ctx, rec, { sessionId });
      const isTemplate = rec.className !== ARTICLE;
      const display = rec.bool('display_attachments');
      return {
        result: {
          sys_id: rec.sysId,
          number: rec.str('number'),
          short_description: rec.str('short_description'),
          content: rec.str('article_type') === 'wiki' && rec.str('wiki') ? rec.str('wiki') : rec.str('text'),
          template: isTemplate,
          ...(isTemplate ? { template_table: rec.className } : {}),
          display_attachments: display,
          attachments: display ? attachmentsOf(ctx, rec) : [],
          embedded_content: [],
          fields: fieldObjects(ctx, rec, fields),
          language: rec.str('language') || 'en',
          languages: languagesOf(ctx, rec),
        },
      };
    });

    app.get(`${base}/articles/:id/attachments/:attachmentId`, async (req, reply) => {
      const ctx = kmCtx(req);
      const { id, attachmentId } = req.params as { id: string; attachmentId: string };
      const rec = isSysId(id) ? ctx.get(ARTICLE, id) : null;
      if (!rec) throw new NotFoundError();
      const att = isSysId(attachmentId) ? ctx.elevated().get('sys_attachment', attachmentId) : null;
      if (!att || att.str('table_sys_id') !== rec.sysId)
        throw new NotFoundError('No Record found', 'Attachment not found');
      let data: Buffer;
      try {
        data = readAttachment(deps.config.attachmentDir, att);
      } catch {
        throw new NotFoundError('Attachment content not found');
      }
      return reply
        .header('Content-Type', att.str('content_type') || 'application/octet-stream')
        .header('Content-Disposition', `inline; filename="${att.str('file_name').replace(/"/g, '')}"`)
        .send(data);
    });
  }

  // ------------------------------------------------------------------ product APIs

  const searchItem = (h: SearchHit) => ({
    sys_id: h.rec.sysId,
    table: h.rec.className,
    number: h.rec.str('number'),
    title: h.rec.str('short_description'),
    snippet: h.snippet,
    score: h.score,
    rank: h.rank,
    kb_knowledge_base: {
      value: h.rec.str('kb_knowledge_base'),
      display_value: h.rec.display('kb_knowledge_base'),
    },
    kb_category: {
      value: h.rec.str('kb_category'),
      display_value: h.rec.str('kb_category') ? svc.access.categoryPath(h.rec.str('kb_category')) : '',
    },
    sys_view_count: h.rec.num('sys_view_count') ?? 0,
    rating: h.rec.num('rating'),
    helpful_count: h.rec.num('helpful_count') ?? 0,
    published: h.rec.str('published'),
    updated: h.rec.str('sys_updated_on'),
    link: svc.articleUrl(h.rec),
  });

  /** Ranked full-text search over published articles the caller may read. */
  app.get('/api/app/knowledge/search', async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Q;
    const term = String(q.q ?? q.query ?? '').trim();
    const kbs = list(q.kb);
    const categories = list(q.category).flatMap((c) => svc.access.categoryTree(c));
    const limit = intParam(q.limit, 10, 1, 100);
    const offset = intParam(q.offset, 0, 0);
    const order = ['relevance', 'views', 'newest', 'alphabetical'].includes(String(q.order))
      ? (String(q.order) as SearchOrder)
      : undefined;
    // Session language (English) unless a language is given or multi-language search is enabled.
    const multi = props(platform).bool('glide.knowman.enable_multi_language_search', false);
    const languages = q.language
      ? String(q.language) === 'all'
        ? null
        : list(q.language)
      : multi
        ? null
        : ['en'];
    const res = svc.search.search(ctx, {
      query: term,
      kbs: kbs.length ? kbs : undefined,
      categories: categories.length ? categories : undefined,
      languages,
      limit,
      offset,
      order,
      log: term ? { source: 'resolvr_app', sessionId: req.auth?.sessionId ?? null } : null,
    });
    return {
      result: {
        query: term,
        count: res.total,
        offset,
        limit,
        search_id: res.searchId,
        terms: res.terms,
        results: res.hits.map(searchItem),
      },
    };
  });

  /** Readable knowledge bases with their category trees and published article counts. */
  app.get('/api/app/knowledge/bases', async (req) => {
    const ctx = ctxOf(req, deps);
    const bases = ctx.query('kb_knowledge_base', { query: 'active=true^ORDERBYorder^ORDERBYtitle' });
    const counts = new Map<string, number>();
    for (const r of svc.search.corpus(ctx, {}))
      counts.set(r.str('kb_knowledge_base'), (counts.get(r.str('kb_knowledge_base')) ?? 0) + 1);
    const categories = ctx.query('kb_category', { query: 'active=true^ORDERBYfull_category' });
    return {
      result: bases.map((b) => ({
        sys_id: b.sysId,
        title: b.str('title'),
        description: b.str('description'),
        articles: counts.get(b.sysId) ?? 0,
        can_contribute: svc.access.canContributeKb(ctx, b.sysId),
        publish_flow: b.str('resolvr_publish_flow'),
        categories: categories
          .filter((c) => svc.access.categoryKb(c.sysId) === b.sysId)
          .map((c) => ({
            sys_id: c.sysId,
            label: c.str('label'),
            full_category: c.str('full_category'),
            parent: c.str('parent_table') === 'kb_category' ? c.str('parent_id') : null,
          })),
      })),
    };
  });

  const articleView = (ctx: Context, rec: Rec, notice: string | null) => {
    const kb = svc.kbRecord(rec.str('kb_knowledge_base'));
    const facts = articleFacts(rec);
    const options = svc.feedbackOptions(rec);
    const fb = svc.feedbackSummary(rec, ctx.user.sysId);
    const state = rec.str('workflow_state') || 'draft';
    const rows = svc.versionRows(rec.str('summary') || rec.sysId);
    const latestId = svc.latestRow(rec);
    const latestPublished = [...rows].reverse().find((r) => r.state === 'published');
    const e = ctx.elevated();
    const comments = e
      .query('kb_feedback', {
        query: `articleIN${rows.map((r) => r.sysId).join(',')}^flagged!=true^commentsISNOTEMPTY^ORDERBYsys_created_on`,
        limit: props(platform).num('glide.knowman.feedback.display_threshold', 100) || 100,
      })
      .map((c) => ({
        sys_id: c.sysId,
        user: c.display('user'),
        comments: c.str('comments'),
        parent: c.str('parent') || null,
        created: c.str('sys_created_on'),
        likes:
          platform.db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM "m2m_kb_feedback_likes" WHERE "feedback" = ?`,
            [c.sysId],
          )?.n ?? 0,
      }));
    const showTasks = props(platform).bool('glide.knowman.recent_tasks.display', true) && ctx.hasRole('itil');
    const recentTasks = showTasks
      ? e
          .query('m2m_kb_task', {
            query: `kb_knowledgeIN${rows.map((r) => r.sysId).join(',')}^ORDERBYDESCsys_created_on`,
            limit: props(platform).num('glide.knowman.recent_tasks', 5),
          })
          .map((m) => ctx.get('task', m.str('task')))
          .filter((t): t is Rec => !!t)
          .map((t) => ({
            sys_id: t.sysId,
            table: t.className,
            number: t.str('number'),
            short_description: t.str('short_description'),
          }))
      : [];
    const related = e
      .query('kb_2_kb', { query: `kb_knowledge=${rec.sysId}` })
      .map((r) => ctx.get(ARTICLE, r.str('related_kb_knowledge')))
      .filter((r): r is Rec => !!r && r.str('workflow_state') === 'published')
      .map((r) => ({ sys_id: r.sysId, number: r.str('number'), title: r.str('short_description') }));
    const banner =
      state === 'outdated' && latestPublished && latestPublished.sysId !== rec.sysId
        ? {
            type: 'outdated',
            message: 'You are viewing an older version of this article.',
            latest: { sys_id: latestPublished.sysId, version: formatVersion(latestPublished.version) },
          }
        : state === 'retired'
          ? { type: 'retired', message: 'This article has been retired.' }
          : null;
    return {
      sys_id: rec.sysId,
      table: rec.className,
      number: rec.str('number'),
      display_number: rec.str('display_number'),
      version: formatVersion(svc.versionOf(rec)),
      title: rec.str('short_description'),
      content: rec.str('article_type') === 'wiki' && rec.str('wiki') ? rec.str('wiki') : rec.str('text'),
      template: rec.className !== ARTICLE,
      workflow_state: { value: state, display_value: rec.display('workflow_state') },
      knowledge_base: { sys_id: rec.str('kb_knowledge_base'), title: kb?.str('title') ?? '' },
      category: rec.str('kb_category')
        ? {
            sys_id: rec.str('kb_category'),
            label: rec.display('kb_category'),
            path: svc.access.categoryPath(rec.str('kb_category')),
          }
        : null,
      author: { sys_id: rec.str('author'), name: rec.display('author') },
      published: rec.str('published'),
      updated: rec.str('sys_updated_on'),
      valid_to: rec.str('valid_to'),
      sys_view_count: rec.num('sys_view_count') ?? 0,
      use_count: rec.num('use_count') ?? 0,
      helpful: fb.helpful,
      rating: fb.rating,
      my_feedback: fb.mine,
      can: {
        edit: platform.acl.canTable(ctx, rec.className, 'write', rec).allowed,
        mark_helpful: !!ctx.user.sysId && state === 'published' && options.helpful,
        rate: !!ctx.user.sysId && state === 'published' && options.rating,
        comment: !!ctx.user.sysId && state === 'published' && options.comment,
        flag: !!ctx.user.sysId && state === 'published' && options.flag,
        checkout: state === 'published' && !svc.checkedOutRow(rec) && svc.canCheckout(ctx, rec),
        retire: state === 'published' && svc.canRetire(ctx, rec),
        attach_to_task: ['published', 'outdated'].includes(state) && ctx.hasAnyRole(['itil', 'knowledge']),
      },
      is_latest: latestId === rec.sysId,
      banner,
      notice,
      attachments: rec.bool('display_attachments') ? attachmentsOf(ctx, rec) : [],
      comments,
      related,
      recent_tasks: recentTasks,
      languages: languagesOf(ctx, rec),
      contributor: svc.access.canEditArticle(ctx, facts),
    };
  };

  /** Article page service: records a view and handles retired articles (replacement redirect or 404). */
  app.get('/api/app/knowledge/articles/:id', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { id } = req.params as { id: string };
    const q = req.query as Q;
    const language = String(q.language ?? '')
      .trim()
      .toLowerCase();
    const preview = parseBool(q.preview);
    const rec = resolveArticle(ctx, id, language);
    const number = String(id).toUpperCase();
    const hidden =
      rec ??
      (isSysId(id)
        ? ctx.elevated().get(ARTICLE, id)
        : /^KB\d+$/.test(number)
          ? ctx.elevated().first(ARTICLE, `number=${number}^workflow_state=retired`)
          : null);
    if (hidden?.str('workflow_state') === 'retired' && !(preview && rec)) {
      const replacementId = hidden.str('replacement_article');
      const replacement =
        replacementId && props(platform).bool('glide.knowman.enable_article_replacement_on_retire', true)
          ? ctx.get(ARTICLE, replacementId)
          : null;
      if (replacement) {
        const notice = `${hidden.str('number')} has been retired and replaced by ${replacement.str('number')}`;
        return reply
          .code(301)
          .header(
            'Location',
            `/api/app/knowledge/articles/${replacement.sysId}?replaced=${encodeURIComponent(hidden.str('number'))}`,
          )
          .send({
            result: {
              status: 'replaced',
              notice,
              replacement: {
                sys_id: replacement.sysId,
                number: replacement.str('number'),
                title: replacement.str('short_description'),
              },
            },
          });
      }
      if (!rec) throw new HttpError(404, 'Knowledge record not found');
    }
    if (!rec) throw new HttpError(404, 'Knowledge record not found');
    if (!preview && ['published', 'outdated', 'pending_retirement'].includes(rec.str('workflow_state'))) {
      const rank = Number(q.rank ?? q.search_rank);
      svc.recordView(ctx, rec, {
        searchId: String(q.search_id ?? ''),
        rank: Number.isFinite(rank) ? rank : null,
        sessionId: req.auth?.sessionId ?? null,
      });
    }
    const replaced = String(q.replaced ?? '');
    const notice = replaced ? `${replaced} has been retired and replaced by this article` : null;
    const fresh = ctx.elevated().get(ARTICLE, rec.sysId) ?? rec;
    return { result: articleView(ctx, fresh, notice) };
  });

  const lifecycle = async (req: FastifyRequest) => {
    const ctx = ctxOf(req, deps);
    const { id: sysId, action } = req.params as { id: string; action: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rec = isSysId(sysId) ? ctx.get(ARTICLE, sysId) : null;
    if (!rec) throw new NotFoundError();
    let r: LifecycleResult;
    switch (action) {
      case 'publish':
      case 'submit':
        r = svc.publish(
          ctx,
          rec,
          body.scheduled_publish_date !== undefined
            ? { scheduledPublishDate: String(body.scheduled_publish_date ?? '') }
            : {},
        );
        break;
      case 'retire':
        r = svc.retire(ctx, rec, {
          replacement: String(body.replacement_article ?? body.replacement ?? '') || null,
        });
        break;
      case 'recall':
        r = svc.recall(ctx, rec);
        break;
      case 'checkout':
        r = svc.checkout(ctx, rec);
        break;
      case 'make_current':
        r = svc.makeCurrent(ctx, rec);
        break;
      case 'republish':
        r = svc.republish(ctx, rec);
        break;
      case 'feedback': {
        const values: Record<string, unknown> = { article: rec.sysId };
        for (const k of ['useful', 'rating', 'comments', 'flagged', 'reason', 'parent'])
          if (body[k] !== undefined) values[k] = body[k];
        const fb = ctx.insert('kb_feedback', values);
        platform.scheduleWork();
        const fresh = ctx.elevated().get(ARTICLE, rec.sysId) ?? rec;
        return {
          result: {
            feedback: fb.sysId,
            feedback_task: fb.str('feedback_task') || null,
            ...svc.feedbackSummary(fresh, ctx.user.sysId),
          },
        };
      }
      case 'attach': {
        const out = svc.attachToTask(ctx, rec, String(body.task ?? body.sys_id ?? ''));
        platform.scheduleWork();
        return {
          result: {
            attached: out.attached,
            task: { sys_id: out.task.sysId, table: out.task.className, number: out.task.str('number') },
          },
        };
      }
      default:
        throw new HttpError(400, `Unknown knowledge action ${action}`);
    }
    platform.scheduleWork();
    const fresh = ctx.elevated().get(ARTICLE, r.article.sysId) ?? r.article;
    return {
      result: {
        message: r.message,
        state: r.state,
        article: serializeRecord(ctx, fresh, {
          displayValue: 'all',
          excludeReferenceLink: true,
          fields: [],
          baseUrl: baseUrl(req, deps),
        }),
        messages: ctx.messages,
      },
    };
  };
  app.post('/api/app/knowledge/articles/:id/:action', lifecycle);
  app.post('/api/app/km/articles/:id/:action', lifecycle);

  /** Creates a knowledge article (or submission) from a task on demand. */
  app.post('/api/app/knowledge/from_task/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    if (!ctx.hasAnyRole(['itil', 'knowledge']))
      throw new HttpError(403, 'Insufficient rights to create knowledge');
    if (!platform.registry.isA(table, 'task')) throw new HttpError(400, `Invalid task table ${table}`);
    const task = isSysId(sysId) ? ctx.get(table, sysId) : null;
    if (!task) throw new NotFoundError();
    const out = svc.createFromTask(ctx, task);
    if (!out) throw new HttpError(400, 'No knowledge base is available for new articles');
    platform.scheduleWork();
    return { result: out };
  });

  /** Known Error article from a problem record. */
  app.post('/api/app/knowledge/known_error/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    if (!ctx.hasAnyRole(['problem_admin', 'problem_coordinator', 'problem_manager', 'knowledge_admin'])) {
      throw new HttpError(403, 'Insufficient rights to create known error articles');
    }
    if (!platform.registry.isA(table, 'task')) throw new HttpError(400, `Invalid task table ${table}`);
    const task = isSysId(sysId) ? ctx.get(table, sysId) : null;
    if (!task) throw new NotFoundError();
    const out = svc.createKnownErrorArticle(ctx, task);
    platform.scheduleWork();
    return { result: out };
  });
}
