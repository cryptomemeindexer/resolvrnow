/** HTTP API of the AI module: status, skills, predictions, similarity, clusters and the virtual agent. */
import type { FastifyInstance } from 'fastify';
import { type ApiDeps, ctxOf, HttpError, intParam } from '../../api/http.js';
import { NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { PROP } from './config.js';
import { editDistance } from './ml/text.js';
import { type AiEngine, aiEngineOf } from './service.js';
import { SkillError } from './skills/defs.js';

const FEEDBACK = new Set(['none', 'helpful', 'not_helpful']);

/** Default similarity targets for a record: its own table, problems and knowledge. */
function defaultTargets(engine: AiEngine, rec: Rec): string[] {
  const reg = engine.platform.registry;
  const own = rec.table.ancestors.includes('incident') ? 'incident' : rec.className;
  return [own, 'problem', 'kb_knowledge'].filter((t, i, arr) => reg.has(t) && arr.indexOf(t) === i);
}

export function registerAiApi(app: FastifyInstance, deps: ApiDeps): void {
  const { platform } = deps;
  const engine = (): AiEngine => {
    const e = aiEngineOf(platform);
    if (!e) throw new HttpError(503, 'The AI module is not initialised');
    return e;
  };
  const record = (table: string, sysId: string, ctx: ReturnType<typeof ctxOf>): Rec => {
    if (!platform.registry.has(table)) throw new HttpError(400, `Invalid table ${table}`);
    const rec = ctx.get(table, sysId);
    if (!rec) throw new NotFoundError();
    return rec;
  };
  const number = (rec: Rec) => (rec.has('number') ? rec.str('number') : rec.displayValue());

  app.get('/api/app/ai/status', async (req) => ({ result: engine().status(ctxOf(req, deps)) }));

  app.get('/api/app/ai/skills', async (req) => ({ result: engine().skills.available(ctxOf(req, deps)) }));

  app.post('/api/app/ai/skills/:skill', async (req) => {
    const ctx = ctxOf(req, deps);
    const { skill } = req.params as { skill: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    try {
      return { result: await engine().skills.run(ctx, skill, body) };
    } catch (e) {
      if (e instanceof SkillError) throw new HttpError(e.status, e.message, e.code);
      throw e;
    }
  });

  /** Feedback on a generated output (thumbs up/down, inserted, shared as work note). */
  app.post('/api/app/ai/feedback/:logId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { logId } = req.params as { logId: string };
    const body = (req.body ?? {}) as {
      feedback?: string;
      comment?: string;
      inserted?: boolean;
      shared?: boolean;
    };
    const row = ctx.elevated().get('sys_generative_ai_log', logId);
    if (!row || (row.str('user') !== (ctx.user.sysId ?? '') && !ctx.hasRole('ai_admin')))
      throw new NotFoundError();
    const values: Record<string, unknown> = {};
    if (body.feedback !== undefined) {
      if (!FEEDBACK.has(body.feedback))
        throw new HttpError(400, 'feedback must be helpful, not_helpful or none');
      values.feedback = body.feedback;
    }
    if (typeof body.comment === 'string') values.feedback_comment = body.comment.slice(0, 4000);
    if (typeof body.inserted === 'boolean') values.inserted = body.inserted;
    if (typeof body.shared === 'boolean') values.shared = body.shared;
    ctx.elevated().update(row, values);
    return {
      result: {
        sys_id: row.sysId,
        feedback: row.str('feedback'),
        inserted: row.bool('inserted'),
        shared: row.bool('shared'),
      },
    };
  });

  /** Shares a (possibly edited) generated text as a work note on the record it was generated for. */
  app.post('/api/app/ai/feedback/:logId/share', async (req) => {
    const ctx = ctxOf(req, deps);
    const { logId } = req.params as { logId: string };
    const body = (req.body ?? {}) as { text?: unknown };
    const row = ctx.elevated().get('sys_generative_ai_log', logId);
    if (!row || row.str('user') !== (ctx.user.sysId ?? '')) throw new NotFoundError();
    const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : row.str('output');
    if (!text) throw new HttpError(400, 'Nothing to share');
    const table = row.str('table');
    if (!table || !platform.registry.has(table))
      throw new HttpError(400, 'This output is not linked to a record');
    const rec = record(table, row.str('document'), ctx);
    if (!rec.has('work_notes')) throw new HttpError(400, `${rec.table.label} records have no work notes`);
    ctx.update(rec, { work_notes: text });
    ctx.elevated().update(row, { shared: true, edit_distance: editDistance(row.str('output'), text) });
    return { result: { sys_id: row.sysId, shared: true, table: rec.className, record: rec.sysId } };
  });

  app.get('/api/app/ai/similar/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    const q = req.query as Record<string, string | undefined>;
    const rec = record(table, sysId, ctx);
    const e = engine();
    const targets = (q.targets ? q.targets.split(',') : defaultTargets(e, rec))
      .map((t) => t.trim())
      .filter((t) => t && platform.registry.has(t));
    const results = e.similarity.similarToRecord(ctx, rec, targets, {
      limit: intParam(q.limit, 5, 1, 50),
      minScore: q.min_score !== undefined ? intParam(q.min_score, 20, 0, 100) : undefined,
    });
    return { result: { table: rec.className, sys_id: rec.sysId, number: number(rec), targets: results } };
  });

  app.get('/api/app/ai/recommendations/:table/:sysId', async (req) => {
    const ctx = ctxOf(req, deps);
    const { table, sysId } = req.params as { table: string; sysId: string };
    const q = req.query as Record<string, string | undefined>;
    const rec = record(table, sysId, ctx);
    const e = engine();
    const limit = intParam(q.limit, 5, 1, 20);
    const predictions = e.predictor.predictRecord(rec).map((p) => ({
      field: p.field,
      field_label: rec.column(p.field)?.label ?? p.field,
      current_value: rec.str(p.field),
      current_display: rec.display(p.field),
      value: p.value,
      display_value: p.display,
      confidence: p.confidence,
      threshold: p.threshold,
      above_threshold: p.aboveThreshold,
      preference: p.preference,
      solution: { sys_id: p.solution, name: p.definitionName, label: p.definitionLabel, version: p.version },
      candidates: p.candidates,
    }));
    const own = rec.table.ancestors.includes('incident') ? 'incident' : rec.className;
    const similar = e.similarity.similarToRecord(ctx, rec, [own], { limit })[own] ?? [];
    const knowledge = e.similarity.suggestKnowledge(ctx, e.similarity.textOf(rec), { limit });
    const results = platform.registry.has('ml_predictor_results')
      ? ctx.elevated().query('ml_predictor_results', {
          query: `record=${rec.sysId}`,
          orderBy: [{ field: 'sys_created_on', desc: true }],
          limit: 20,
        })
      : [];
    return {
      result: {
        table: rec.className,
        sys_id: rec.sysId,
        number: number(rec),
        predictions,
        prediction_log: results.map((r) => ({
          sys_id: r.sysId,
          field: r.str('field'),
          predicted_value: r.str('predicted_value'),
          predicted_display: r.str('predicted_display'),
          confidence: r.num('confidence'),
          applied: r.bool('applied'),
          outcome: r.str('outcome'),
          user_action: r.str('user_action'),
          created: r.str('sys_created_on'),
        })),
        similar_records: similar,
        knowledge,
      },
    };
  });

  /** Ad hoc prediction for values that are not saved yet (forms, portals). */
  app.post('/api/app/ai/predict', async (req) => {
    const ctx = ctxOf(req, deps);
    const body = (req.body ?? {}) as { table?: string; values?: Record<string, unknown> };
    const table = String(body.table ?? '');
    if (!platform.registry.has(table)) throw new HttpError(400, `Invalid table ${table}`);
    if (
      !platform.acl.canTable(ctx, table, 'read').allowed &&
      !platform.acl.canTable(ctx, table, 'create').allowed
    ) {
      throw new HttpError(403, 'Insufficient rights');
    }
    const rec = ctx.newRecord(table);
    rec.setMany(body.values ?? {});
    return { result: engine().predictor.predictRecord(rec) };
  });

  app.post('/api/app/ai/solutions/:id/train', async (req, reply) => {
    const ctx = ctxOf(req, deps);
    if (!ctx.hasRole('ai_admin')) throw new HttpError(403, 'Training requires the ai_admin role');
    const { id } = req.params as { id: string };
    const result = engine().predictor.train(ctx, id);
    if (result.state !== 'solution_complete') reply.code(422);
    return { result };
  });

  app.get('/api/app/ai/clusters', async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Record<string, string | undefined>;
    const table = q.table || 'incident';
    if (!platform.registry.has(table)) throw new HttpError(400, `Invalid table ${table}`);
    if (!ctx.hasRole('itil')) throw new HttpError(403, 'Clusters are available to agents (itil)');
    const result = engine().similarity.clusters(ctx, table, {
      minSize: intParam(q.min_size, 3, 2, 1000),
      minCohesion:
        q.min_cohesion !== undefined ? Math.min(1, Math.max(0, Number(q.min_cohesion) || 0)) : undefined,
      limit: intParam(q.limit, 2000, 10, 10_000),
      query: q.query || undefined,
      k: q.k ? intParam(q.k, 2, 2, 500) : undefined,
    });
    return { result };
  });

  /** Suggested knowledge articles for free text or a record. */
  app.get('/api/app/ai/knowledge', async (req) => {
    const ctx = ctxOf(req, deps);
    const q = req.query as Record<string, string | undefined>;
    const e = engine();
    let text = String(q.text ?? q.q ?? '').trim();
    if (q.table && q.sys_id) text = `${text} ${e.similarity.textOf(record(q.table, q.sys_id, ctx))}`.trim();
    if (!text) throw new HttpError(400, 'text, or table and sys_id, is required');
    return {
      result: e.similarity.suggestKnowledge(ctx, text, {
        limit: intParam(q.limit, 5, 1, 20),
        minScore: q.min_score !== undefined ? intParam(q.min_score, 20, 0, 100) : undefined,
      }),
    };
  });

  // ------------------------------------------------------------ virtual agent

  app.post('/api/app/va/message', async (req) => {
    const ctx = ctxOf(req, deps);
    if (!platform.properties.getBool(PROP.vaEnabled, true))
      throw new HttpError(404, 'The virtual agent is disabled');
    const body = (req.body ?? {}) as {
      conversationId?: string;
      conversation_id?: string;
      text?: string;
      value?: string;
    };
    const result = await engine().va.handle(ctx, {
      conversationId: body.conversationId ?? body.conversation_id,
      text: typeof body.text === 'string' ? body.text : '',
      value: typeof body.value === 'string' ? body.value : '',
    });
    return { result };
  });

  app.get('/api/app/va/conversations/:id', async (req) => {
    const ctx = ctxOf(req, deps);
    const { id } = req.params as { id: string };
    return { result: engine().va.history(ctx, id) };
  });
}
