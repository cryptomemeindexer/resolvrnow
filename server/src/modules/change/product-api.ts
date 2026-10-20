import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, errorBody, HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import { AbortError, InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { addMs, clock, isSysId, nowGlide } from '../../engine/util.js';
import { CHOICES, MODEL_IDS, PROP, parseRisk, RISK, RISK_LABEL, STATE, stateLabel, T } from './constants.js';
import {
  assessmentFor,
  assessmentQuestions,
  latestAssessmentResult,
  questionOptions,
  submitAssessment,
} from './risk.js';
import { scheduleIntervals, toGlide, toMs } from './schedules.js';
import { createStandardChange, findProducer } from './standard.js';
import { ChangeTransitionError } from './transitions.js';
import { DAY_MS, groupByName, readJson } from './util.js';

const WRITE_ROLES = ['itil', 'change_manager', 'sn_change_write', 'admin'];
const READ_ROLES = ['itil', 'change_manager', 'sn_change_read', 'admin'];

const RISK_COLORS: Record<string, string> = {
  '1': '#c62828',
  '2': '#e53935',
  '3': '#fb8c00',
  '4': '#43a047',
};

type Handler = (req: FastifyRequest, reply: FastifyReply, ctx: Context) => unknown;

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

const ref = (rec: Rec, field: string) => ({ value: rec.str(field), display_value: rec.display(field) });

// ------------------------------------------------------------ pipeline gate

/** Gate status a pipeline polls: approved means the pipeline may proceed. */
export function gateStatus(
  change: Rec | null,
): 'pending' | 'approved' | 'rejected' | 'canceled' | 'completed' {
  if (!change) return 'canceled';
  const state = change.num('state');
  if (state === STATE.CANCELED) return 'canceled';
  if (state === STATE.CLOSED) return 'completed';
  if (change.str('approval') === 'rejected') return 'rejected';
  if (
    change.str('approval') === 'approved' ||
    [STATE.SCHEDULED, STATE.IMPLEMENT, STATE.REVIEW].includes(state as -2 | -1 | 0)
  )
    return 'approved';
  return 'pending';
}

function pipelineJson(gate: Rec, change: Rec | null): Record<string, unknown> {
  const status = gateStatus(change);
  return {
    sys_id: gate.sysId,
    pipeline: gate.str('pipeline'),
    build: gate.str('build'),
    commit: gate.str('commit'),
    decision: gate.str('decision'),
    status,
    proceed: status === 'approved',
    message: gate.str('message'),
    change: change
      ? {
          sys_id: change.sysId,
          number: change.str('number'),
          type: change.str('type'),
          state: change.num('state'),
          state_label: stateLabel(change.num('state')),
          approval: change.str('approval'),
          risk: change.num('risk'),
          risk_label: change.num('risk') ? RISK_LABEL[String(change.num('risk'))] : '',
        }
      : null,
    links: { status: `/api/app/change/pipeline/${gate.sysId}/status` },
  };
}

function resolveCi(ctx: Context, ci: string): string | null {
  if (!ci || !ctx.registry.has('cmdb_ci')) return null;
  const sys = ctx.elevated();
  const rec = isSysId(ci) ? sys.get('cmdb_ci', ci) : sys.first('cmdb_ci', `name=${ci}`);
  return rec?.sysId ?? null;
}

function resolveGroup(ctx: Context, value: unknown, ciId: string | null): string | null {
  const sys = ctx.elevated();
  const v = String(value ?? '').trim();
  if (v) {
    const g = isSysId(v) ? sys.get('sys_user_group', v) : groupByName(ctx, v);
    if (g) return g.sysId;
  }
  if (ciId) {
    const ci = sys.get('cmdb_ci', ciId);
    if (ci?.has('support_group') && ci.str('support_group')) return ci.str('support_group');
  }
  const fallback = groupByName(
    ctx,
    ctx.platform.properties.get(PROP.pipelineGroup, 'Change Management') ?? 'Change Management',
  );
  return fallback?.sysId ?? null;
}

/**
 * Creates the change for a pipeline run. Change policy: a low risk run with a standard
 * change template is pre-approved; anything else is a normal change that requests approval.
 */
export function createPipelineChange(
  ctx: Context,
  input: Record<string, unknown>,
): { gate: Rec; change: Rec } {
  const pipeline = String(input.pipeline ?? '').trim();
  const shortDescription = String(input.short_description ?? '').trim();
  if (!pipeline) throw new InvalidError('pipeline is required');
  if (!shortDescription) throw new InvalidError('short_description is required');
  const risk = input.risk === undefined || input.risk === '' ? null : parseRisk(input.risk);
  if (input.risk !== undefined && input.risk !== '' && risk === null)
    throw new InvalidError('risk must be low, moderate, high, very high or 1 to 4');
  const templateRef =
    String(input.template ?? '').trim() || ctx.platform.properties.get(PROP.pipelineTemplate, '') || '';
  const producer = templateRef ? findProducer(ctx, templateRef) : null;
  if (String(input.template ?? '').trim() && !producer)
    throw new InvalidError(`Unknown or retired standard change template "${input.template}"`);
  const build = String(input.build ?? '').trim();
  const commit = String(input.commit ?? '').trim();
  const ciRef = String(input.ci ?? '').trim();
  const ciId = resolveCi(ctx, ciRef);
  const now = nowGlide();
  const start = String(input.start_date ?? '').trim() || now;
  const end = String(input.end_date ?? '').trim() || addMs(start, 3_600_000);
  const origin = `Pipeline ${pipeline}${build ? ` build ${build}` : ''}${commit ? ` (commit ${commit})` : ''}`;
  const common: Record<string, unknown> = {
    short_description: shortDescription,
    cmdb_ci: ciId,
    start_date: start,
    end_date: end,
    assignment_group: resolveGroup(ctx, input.assignment_group, ciId),
    justification: String(input.justification ?? '') || `Requested by ${origin}`,
  };
  let change: Rec;
  let decision: 'auto_approved' | 'approval_requested';
  if (producer && risk === RISK.LOW) {
    decision = 'auto_approved';
    change = createStandardChange(ctx, producer.sysId, { ...common, risk: RISK.LOW }).change;
    ctx.update(change, {
      state: STATE.SCHEDULED,
      work_notes: `Created by ${origin}. Change policy: low risk standard change, pre-approved.`,
    });
  } else {
    decision = 'approval_requested';
    change = ctx.insert(T.change, {
      ...common,
      chg_model: MODEL_IDS.normal,
      category: 'DevOps',
      risk,
      description: String(input.description ?? '') || `${origin}.`,
      implementation_plan:
        String(input.implementation_plan ?? '') ||
        `Deploy build ${build || 'from the pipeline'} through ${pipeline}.`,
      backout_plan: String(input.backout_plan ?? '') || 'Redeploy the previous build.',
      test_plan: String(input.test_plan ?? '') || 'Pipeline test stages and post-deployment smoke tests.',
    });
    ctx.update(change, {
      state: STATE.ASSESS,
      work_notes: `Created by ${origin}. Change policy: ${producer ? 'risk is not low' : 'no standard change template'}, approval requested.`,
    });
  }
  const after = ctx.elevated().get(T.change, change.sysId) ?? change;
  const gate = ctx.elevated().insert(T.pipeline, {
    pipeline,
    build,
    commit,
    ci: ciRef,
    change_request: after.sysId,
    template: producer?.sysId ?? null,
    requested_risk: risk,
    decision,
    status: gateStatus(after),
    message:
      ciRef && !ciId
        ? `Configuration item "${ciRef}" was not found; the change has no configuration item`
        : '',
    payload: JSON.stringify(input),
  });
  return { gate, change: after };
}

// ----------------------------------------------------------------- calendar

function parseBoundary(v: unknown, fallback: number): number {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  const ms = toMs(s);
  if (ms === null)
    throw new HttpError(
      400,
      'Invalid date',
      `"${s}" is not a valid date (use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)`,
    );
  return ms;
}

export function changeCalendar(ctx: Context, fromMs: number, toMs_: number): Record<string, unknown> {
  const from = toGlide(fromMs);
  const to = toGlide(toMs_);
  const changes = ctx.query(T.change, {
    query: `start_dateISNOTEMPTY^end_dateISNOTEMPTY^start_date<${to}^end_date>${from}^ORDERBYstart_date`,
    limit: ctx.platform.properties.getNumber('resolvr.change.calendar.max_changes', 1000),
  });
  const typeLabel = (v: string) => CHOICES.type.find((c) => c.value === v)?.label ?? 'Model';
  const sys = ctx.elevated();
  const windows = (table: string, color: string) =>
    ctx.registry.has(table)
      ? sys.query(table).flatMap((s) =>
          scheduleIntervals(ctx, s.sysId, fromMs, toMs_, false).map((i) => ({
            sys_id: s.sysId,
            name: s.str('name'),
            category: s.str('category'),
            category_label: s.display('category'),
            start: toGlide(i.start),
            end: toGlide(i.end),
            color,
          })),
        )
      : [];
  return {
    from,
    to,
    changes: changes.map((c) => ({
      sys_id: c.sysId,
      number: c.str('number'),
      short_description: c.str('short_description'),
      type: c.str('type'),
      type_label: typeLabel(c.str('type')),
      state: c.num('state'),
      state_label: c.display('state'),
      risk: c.num('risk'),
      risk_label: c.display('risk'),
      approval: c.str('approval'),
      on_hold: c.bool('on_hold'),
      conflict_status: c.str('conflict_status'),
      start: c.str('start_date'),
      end: c.str('end_date'),
      cmdb_ci: ref(c, 'cmdb_ci'),
      assignment_group: ref(c, 'assignment_group'),
      assigned_to: ref(c, 'assigned_to'),
      color: RISK_COLORS[c.str('risk')] ?? '#488df4',
    })),
    blackouts: windows(T.blackout, '#9e9e9e'),
    maintenance: windows(T.maintenance, '#b3e5fc'),
  };
}

// ------------------------------------------------------------------- routes

export function registerProductApi(app: FastifyInstance, deps: ApiDeps): void {
  const route = (method: 'GET' | 'POST', url: string, roles: string[], handler: Handler) => {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const ctx = ctxOf(req, deps);
        if (!ctx.hasAnyRole(roles))
          throw new HttpError(
            403,
            'Insufficient rights',
            'User does not have the role required for this operation',
          );
        try {
          return await handler(req, reply, ctx);
        } catch (e) {
          if (e instanceof ChangeTransitionError) return reply.code(400).send(errorBody(e.title, e.detail));
          if (e instanceof AbortError) return reply.code(400).send(errorBody(e.message, ''));
          throw e;
        }
      },
    });
  };

  route('POST', '/api/app/change/pipeline', WRITE_ROLES, (req, reply, ctx) => {
    const { gate, change } = createPipelineChange(ctx, body(req));
    return reply.code(201).send({ result: pipelineJson(gate, change) });
  });

  const gateOf = (ctx: Context, id: string): Rec => {
    const sys = ctx.elevated();
    const gate = isSysId(id) ? sys.get(T.pipeline, id) : null;
    if (!gate) throw new NotFoundError('No Record found', 'Pipeline change gate not found');
    return gate;
  };

  route('GET', '/api/app/change/pipeline/:id/status', READ_ROLES, (req, _reply, ctx) => {
    const gate = gateOf(ctx, (req.params as { id: string }).id);
    const change = gate.str('change_request')
      ? ctx.elevated().get(T.change, gate.str('change_request'))
      : null;
    const status = gateStatus(change);
    if (status !== gate.str('status')) ctx.elevated().update(gate, { status });
    return { result: { ...pipelineJson(gate, change), poll_after_seconds: status === 'pending' ? 30 : 0 } };
  });

  /** The pipeline reports the deployment result: the change is implemented, reviewed and closed. */
  route('POST', '/api/app/change/pipeline/:id/complete', WRITE_ROLES, (req, _reply, ctx) => {
    const gate = gateOf(ctx, (req.params as { id: string }).id);
    const input = body(req);
    const result = String(input.result ?? '').toLowerCase();
    if (!['success', 'failure'].includes(result)) throw new InvalidError('result must be success or failure');
    const sys = ctx.elevated();
    let change = gate.str('change_request') ? sys.get(T.change, gate.str('change_request')) : null;
    if (!change)
      throw new NotFoundError('No Record found', 'The change of this pipeline run no longer exists');
    if (gateStatus(change) !== 'approved')
      throw new InvalidError(`The change is ${stateLabel(change.num('state'))} and cannot be completed`);
    const notes = String(input.notes ?? '') || `Pipeline ${gate.str('pipeline')} reported ${result}.`;
    const step = (state: number, extra: Record<string, unknown> = {}) => {
      ctx.update(change!, { state, ...extra });
      change = sys.get(T.change, change!.sysId) ?? change;
    };
    if (change.num('state') === STATE.SCHEDULED) step(STATE.IMPLEMENT);
    if (change.num('state') === STATE.IMPLEMENT) step(STATE.REVIEW);
    if (change.num('state') === STATE.REVIEW) {
      step(STATE.CLOSED, {
        close_code: result === 'success' ? 'successful' : 'unsuccessful',
        close_notes: notes,
      });
    }
    const status = gateStatus(change);
    sys.update(gate, { status });
    return { result: pipelineJson(gate, change) };
  });

  route('GET', '/api/app/change/calendar', READ_ROLES, (req, _reply, ctx) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const today = clock.now();
    const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
    const from = parseBoundary(q.from, monthStart);
    const to = parseBoundary(q.to, from + 35 * DAY_MS);
    const maxDays = ctx.platform.properties.getNumber(PROP.calendarWindowDays, 366);
    if (to <= from) throw new HttpError(400, 'Invalid range', '"to" must be after "from"');
    if (to - from > maxDays * DAY_MS)
      throw new HttpError(400, 'Invalid range', `The calendar range cannot exceed ${maxDays} days`);
    return { result: changeCalendar(ctx, from, to) };
  });

  route('GET', '/api/app/change/:id/risk_assessment', READ_ROLES, (req, _reply, ctx) => {
    const change = ctx.get(T.change, (req.params as { id: string }).id);
    if (!change) throw new NotFoundError();
    const asmt = assessmentFor(ctx, change);
    if (!asmt)
      throw new NotFoundError('No Record found', 'No published risk assessment applies to this change');
    const latest = latestAssessmentResult(ctx, change.sysId);
    return {
      result: {
        assessment: { sys_id: asmt.sysId, name: asmt.str('name'), description: asmt.str('description') },
        questions: assessmentQuestions(ctx, asmt.sysId).map((q) => ({
          sys_id: q.sysId,
          question: q.str('question'),
          description: q.str('description'),
          mandatory: q.bool('mandatory'),
          weight: q.num('weight') ?? 1,
          options: questionOptions(q),
        })),
        latest: latest
          ? {
              sys_id: latest.sysId,
              score: latest.num('score'),
              risk: latest.num('risk'),
              risk_label: latest.display('risk'),
              taken_on: latest.str('taken_on'),
              answers: readJson<Record<string, number>>(latest.str('answers'), {}),
            }
          : null,
      },
    };
  });

  route('POST', '/api/app/change/:id/risk_assessment', WRITE_ROLES, (req, _reply, ctx) => {
    const change = ctx.get(T.change, (req.params as { id: string }).id);
    if (!change) throw new NotFoundError();
    const input = body(req);
    const asmt = input.assessment
      ? ctx.elevated().get(T.assessment, String(input.assessment))
      : assessmentFor(ctx, change);
    if (!asmt)
      throw new NotFoundError('No Record found', 'No published risk assessment applies to this change');
    const answers = (input.answers && typeof input.answers === 'object' ? input.answers : {}) as Record<
      string,
      unknown
    >;
    const { result, outcome } = submitAssessment(ctx, change, asmt.sysId, answers);
    return {
      result: {
        sys_id: result.sysId,
        score: result.num('score'),
        assessment_risk: result.num('risk'),
        assessment_risk_label: result.display('risk'),
        risk: outcome.risk,
        risk_label: outcome.risk ? RISK_LABEL[String(outcome.risk)] : '',
        messages: outcome.messages,
      },
    };
  });
}
