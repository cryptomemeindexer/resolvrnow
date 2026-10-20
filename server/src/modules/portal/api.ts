import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, HttpError, intParam } from '../../api/http.js';
import { readAttachment, saveAttachment } from '../../api/now/attachment.js';
import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import { EXT, T, UR_AGENT_ROLES } from './constants.js';
import { homePayload } from './home.js';
import { bundle, type Lang, normalizeLang, t } from './i18n.js';
import { normalizeSource, portalSearch } from './search.js';
import {
  listSurveys,
  loadSurveyInstance,
  type SurveySubmission,
  submitSurvey,
  surveyDetail,
} from './surveys.js';
import {
  activeAnnouncements,
  addFavorite,
  type ContentSort,
  dismissAnnouncement,
  homeQuickLinks,
  listFavorites,
  removeFavorite,
  topicPage,
  topicTree,
} from './taxonomy.js';
import {
  addPortalComment,
  approvalJson,
  decideApproval,
  listMyTickets,
  loadPortalTicket,
  myAssignedTasks,
  pendingApprovalRecords,
  pendingSurveysByTrigger,
  runPortalAction,
  type TicketQuery,
  ticketAttachment,
  ticketDetail,
  ticketRow,
  type View,
} from './tickets.js';
import { completeTour, toursFor } from './tours.js';
import { createUniversalRequest } from './ur.js';

type Q = Record<string, string | undefined>;
type Body = Record<string, unknown>;

const BASE = '/api/app/portal';
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Language of server-rendered labels: `?lang=`, else the user's preferred language, else English. */
function langOf(req: FastifyRequest, ctx: Context): Lang {
  const query = (req.query as Q).lang;
  if (query) return normalizeLang(query);
  const me = ctx.user.sysId;
  const preferred = me ? ctx.elevated().get('sys_user', me)?.str('preferred_language') : '';
  return normalizeLang(preferred || 'en');
}

const body = (req: FastifyRequest): Body =>
  req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as Body) : {};
const text = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);

interface AttachmentInput {
  sys_id?: string;
  file_name?: string;
  name?: string;
  content_type?: string;
  data?: string;
}

/**
 * Attaches a file (base64 payload), or moves a file the user staged on their own user record
 * (`table_name=sys_user`, `table_sys_id=<me>`) before the request existed.
 */
function attach(ctx: Context, deps: ApiDeps, rec: Rec, input: unknown): Rec {
  const sys = ctx.elevated();
  const a = (typeof input === 'string' ? { sys_id: input } : (input ?? {})) as AttachmentInput;
  if (a.sys_id && !a.data) {
    const existing = isSysId(a.sys_id) ? sys.get(EXT.attachment, a.sys_id) : null;
    const staged =
      !!existing &&
      existing.str('sys_created_by') === ctx.user.userName &&
      existing.str('table_name') === 'sys_user' &&
      existing.str('table_sys_id') === ctx.user.sysId;
    if (!existing || !staged) throw new InvalidError('Unknown attachment', a.sys_id);
    return sys.update(existing, { table_name: rec.className, table_sys_id: rec.sysId });
  }
  const data = Buffer.from(text(a.data), 'base64');
  if (!data.length) throw new InvalidError('Attachment is empty', text(a.file_name ?? a.name));
  if (data.length > MAX_ATTACHMENT_BYTES)
    throw new InvalidError('Attachment is too large', `Maximum ${MAX_ATTACHMENT_BYTES} bytes`);
  return saveAttachment(
    sys,
    deps.config.attachmentDir,
    rec.className,
    rec.sysId,
    text(a.file_name ?? a.name) || 'file',
    text(a.content_type),
    data,
  );
}

function attachmentList(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new InvalidError('attachments must be an array');
  if (input.length > MAX_ATTACHMENTS) throw new InvalidError(`At most ${MAX_ATTACHMENTS} attachments`);
  return input;
}

export function registerPortalApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const done = () => platform.scheduleWork();

  // ---------------------------------------------------------------- language

  /** UI strings; public so the login page can be translated too. */
  app.get(`${BASE}/i18n/:lang`, async (req) => ({ result: bundle((req.params as { lang: string }).lang) }));

  app.post(`${BASE}/language`, async (req) => {
    const ctx = ctxOf(req, deps);
    const lang = normalizeLang(body(req).lang);
    const user = ctx.user.sysId ? ctx.elevated().get('sys_user', ctx.user.sysId) : null;
    if (user) ctx.elevated().update(user, { preferred_language: lang });
    return { result: bundle(lang) };
  });

  // ---------------------------------------------------------------- home, topics, search

  app.get(`${BASE}/home`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: homePayload(ctx, langOf(req, ctx)) };
  });

  app.get(`${BASE}/topics`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: topicTree(ctx, (req.query as Q).taxonomy ?? null) };
  });

  app.get(`${BASE}/topics/:id`, async (req) => {
    const ctx = ctxOf(req, deps);
    const qs = req.query as Q;
    const sort = (['popular', 'name', 'newest'].includes(qs.sort ?? '') ? qs.sort : 'popular') as ContentSort;
    const type = ['catalog', 'knowledge', 'quick_link'].includes(qs.type ?? '') ? qs.type : 'all';
    return { result: topicPage(ctx, (req.params as { id: string }).id, langOf(req, ctx), { type, sort }) };
  });

  app.get(`${BASE}/quick-links`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: homeQuickLinks(ctx) };
  });

  app.get(`${BASE}/announcements`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: activeAnnouncements(ctx) };
  });

  app.post(`${BASE}/announcements/:id/dismiss`, async (req) => {
    const ctx = ctxOf(req, deps);
    dismissAnnouncement(ctx, (req.params as { id: string }).id);
    return { result: { dismissed: true } };
  });

  app.get(`${BASE}/search`, async (req) => {
    const ctx = ctxOf(req, deps);
    const qs = req.query as Q;
    const result = portalSearch(
      ctx,
      {
        q: qs.q ?? '',
        source: normalizeSource(qs.source),
        topic: qs.topic || null,
        kb: qs.kb || null,
        type: qs.type || null,
        limit: intParam(qs.limit, 20, 1, 100),
        offset: intParam(qs.offset, 0, 0),
      },
      langOf(req, ctx),
    );
    return { result };
  });

  // ---------------------------------------------------------------- universal requests

  app.post(`${BASE}/requests`, async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const b = body(req);
    const lang = langOf(req, ctx);
    const openedFor = text(b.opened_for) || null;
    if (openedFor && openedFor !== ctx.user.sysId && !ctx.hasAnyRole([...UR_AGENT_ROLES, 'admin'])) {
      throw new HttpError(403, 'You can only raise requests for yourself');
    }
    if (openedFor && !ctx.elevated().get('sys_user', openedFor))
      throw new InvalidError('Unknown user', openedFor);
    if (!platform.registry.has(T.ur)) throw new HttpError(503, 'Universal requests are not available');
    const attachments = attachmentList(b.attachments);
    const { ur, primary } = platform.db.tx(() => {
      const created = createUniversalRequest(ctx, {
        description: text(b.description),
        short_description: text(b.short_description) || null,
        topic: text(b.topic) || null,
        opened_for: openedFor ?? undefined,
      });
      for (const a of attachments) attach(ctx, deps, created.ur, a);
      return created;
    });
    done();
    const fresh = ctx.elevated().get(T.ur, ur.sysId) ?? ur;
    reply.code(201);
    return {
      result: {
        ...ticketRow(ctx, fresh, lang, pendingSurveysByTrigger(ctx)),
        routed: !!primary,
        message: t(lang, 'request.created', { number: fresh.str('number') }),
      },
    };
  });

  // ---------------------------------------------------------------- tickets

  app.get(`${BASE}/tickets`, async (req) => {
    const ctx = ctxOf(req, deps);
    const qs = req.query as Q;
    const view = (['open', 'closed', 'all'].includes(qs.view ?? '') ? qs.view : 'open') as View;
    const sort = (
      ['updated', 'created', 'number'].includes(qs.sort ?? '') ? qs.sort : 'updated'
    ) as TicketQuery['sort'];
    const order = qs.order === 'asc' ? 'asc' : 'desc';
    return {
      result: listMyTickets(ctx, langOf(req, ctx), {
        view,
        q: qs.q ?? '',
        sort,
        order,
        limit: intParam(qs.limit, 20, 1, 200),
        offset: intParam(qs.offset, 0, 0),
      }),
    };
  });

  app.get(`${BASE}/tickets/:table/:id`, async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, id } = req.params as { table: string; id: string };
    const { rec, redirectedFrom } = loadPortalTicket(ctx, table, id);
    return { result: ticketDetail(ctx, rec, langOf(req, ctx), redirectedFrom) };
  });

  app.post(`${BASE}/tickets/:table/:id/comment`, async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, id } = req.params as { table: string; id: string };
    const { rec } = loadPortalTicket(ctx, table, id);
    const b = body(req);
    addPortalComment(ctx, rec, text(b.comment ?? b.comments ?? b.text));
    done();
    const fresh = ctx.elevated().get(rec.className, rec.sysId) ?? rec;
    return { result: ticketDetail(ctx, fresh, langOf(req, ctx), null) };
  });

  app.post(`${BASE}/tickets/:table/:id/action/:name`, async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, id, name } = req.params as { table: string; id: string; name: string };
    const { rec } = loadPortalTicket(ctx, table, id);
    const lang = langOf(req, ctx);
    const message = platform.db.tx(() => runPortalAction(ctx, rec, name, text(body(req).comment), lang));
    done();
    const fresh = ctx.elevated().get(rec.className, rec.sysId) ?? rec;
    return { result: { message, ticket: ticketDetail(ctx, fresh, lang, null) } };
  });

  app.post(`${BASE}/tickets/:table/:id/attachments`, async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const { table, id } = req.params as { table: string; id: string };
    const { rec } = loadPortalTicket(ctx, table, id);
    if (!rec.bool('active')) throw new InvalidError('This ticket is closed');
    const att = attach(ctx, deps, rec, body(req));
    reply.code(201);
    return {
      result: {
        sys_id: att.sysId,
        file_name: att.str('file_name'),
        content_type: att.str('content_type'),
        size_bytes: att.num('size_bytes') ?? 0,
        download_url: `${BASE}/tickets/${rec.className}/${rec.sysId}/attachments/${att.sysId}`,
      },
    };
  });

  app.get(`${BASE}/tickets/:table/:id/attachments/:attachmentId`, async (req, reply: FastifyReply) => {
    const ctx = ctxOf(req, deps);
    const { table, id, attachmentId } = req.params as { table: string; id: string; attachmentId: string };
    const { rec } = loadPortalTicket(ctx, table, id);
    const att = ticketAttachment(ctx, rec, attachmentId);
    if (!att) throw new NotFoundError();
    let data: Buffer;
    try {
      data = readAttachment(deps.config.attachmentDir, att);
    } catch {
      throw new NotFoundError('Attachment content not found');
    }
    reply
      .header('Content-Type', att.str('content_type') || 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${att.str('file_name').replace(/"/g, '')}"`)
      .header('Cache-Control', 'private, no-store');
    return reply.send(data);
  });

  // ---------------------------------------------------------------- approvals (To-dos)

  app.get(`${BASE}/approvals`, async (req) => {
    const ctx = ctxOf(req, deps);
    const approvals = pendingApprovalRecords(ctx).map((a) => approvalJson(ctx, a));
    const lang = langOf(req, ctx);
    const surveys = pendingSurveysByTrigger(ctx);
    const tasks = myAssignedTasks(ctx).map((r) => ticketRow(ctx, r, lang, surveys));
    return { result: { approvals, tasks, counts: { approvals: approvals.length, tasks: tasks.length } } };
  });

  for (const [path, decision] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(`${BASE}/approvals/:id/${path}`, async (req) => {
      const ctx = ctxOf(req, deps);
      const approval = platform.db.tx(() =>
        decideApproval(ctx, (req.params as { id: string }).id, decision, text(body(req).comment)),
      );
      done();
      return { result: approvalJson(ctx, approval) };
    });
  }

  // ---------------------------------------------------------------- favorites

  app.get(`${BASE}/favorites`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: listFavorites(ctx, langOf(req, ctx)) };
  });

  app.post(`${BASE}/favorites`, async (req, reply) => {
    const ctx = ctxOf(req, deps);
    const b = body(req);
    const { favorite, created } = addFavorite(
      ctx,
      text(b.table),
      text(b.sys_id ?? b.document),
      langOf(req, ctx),
    );
    reply.code(created ? 201 : 200);
    return { result: favorite };
  });

  app.delete(`${BASE}/favorites/:id`, async (req, reply) => {
    const ctx = ctxOf(req, deps);
    removeFavorite(ctx, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- surveys

  app.get(`${BASE}/surveys`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: listSurveys(ctx, (req.query as Q).state === 'all' ? 'all' : 'pending') };
  });

  app.get(`${BASE}/surveys/:id`, async (req) => {
    const ctx = ctxOf(req, deps);
    const inst = loadSurveyInstance(ctx, (req.params as { id: string }).id);
    return { result: surveyDetail(ctx, inst, langOf(req, ctx)) };
  });

  app.post(`${BASE}/surveys/:id`, async (req) => {
    const ctx = ctxOf(req, deps);
    const inst = loadSurveyInstance(ctx, (req.params as { id: string }).id);
    const updated = platform.db.tx(() => submitSurvey(ctx, inst, body(req) as SurveySubmission));
    done();
    return { result: surveyDetail(ctx, updated, langOf(req, ctx)) };
  });

  // ---------------------------------------------------------------- guided tours

  app.get(`${BASE}/tours`, async (req) => {
    const ctx = ctxOf(req, deps);
    return { result: toursFor(ctx, (req.query as Q).page ?? null) };
  });

  app.post(`${BASE}/tours/:id/done`, async (req) => {
    const ctx = ctxOf(req, deps);
    completeTour(ctx, (req.params as { id: string }).id);
    return { result: { done: true } };
  });
}
