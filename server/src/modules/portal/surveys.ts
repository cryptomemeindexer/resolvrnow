import type { Context } from '../../engine/context.js';
import { InvalidError, NotFoundError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import { matches } from '../../engine/query/matcher.js';
import type { Rec } from '../../engine/record.js';
import { recSubject } from '../../engine/rules.js';
import { addMs, isSysId, nowGlide } from '../../engine/util.js';
import { PROPS, ROLES, SURVEY_OPEN, SURVEY_STATE, T } from './constants.js';
import type { Lang } from './i18n.js';
import { hasTable } from './util.js';

const DAY = 86_400_000;

interface TriggerDef {
  sysId: string;
  survey: string;
  table: string;
  condition: string;
  userField: string;
  probability: number;
  repeatDays: number;
}

const triggerCache = new WeakMap<Platform, TriggerDef[]>();

export function invalidateSurveyTriggers(platform: Platform): void {
  triggerCache.delete(platform);
}

function activeTriggers(platform: Platform): TriggerDef[] {
  let list = triggerCache.get(platform);
  if (!list) {
    list = platform
      .systemContext()
      .query(T.trigger, { query: 'active=true' })
      .map((r) => ({
        sysId: r.sysId,
        survey: r.str('metric_type'),
        table: r.str('table'),
        condition: r.str('condition'),
        userField: r.str('user_field'),
        probability: r.num('probability') ?? 100,
        repeatDays: r.num('repeat_interval_days') ?? 0,
      }));
    triggerCache.set(platform, list);
  }
  return list;
}

export interface SendOptions {
  survey: string;
  user: string;
  triggerTable?: string | null;
  triggerId?: string | null;
  condition?: string | null;
  probability?: number;
  repeatDays?: number;
}

/** Creates a survey instance for a user, unless one already exists for the same record or within the repeat interval. */
export function sendSurvey(ctx: Context, opts: SendOptions): Rec | null {
  const sys = ctx.elevated();
  const survey = sys.get(T.survey, opts.survey);
  if (!survey?.bool('active') || !isSysId(opts.user)) return null;
  if (
    opts.triggerId &&
    sys.count(T.instance, `metric_type=${survey.sysId}^user=${opts.user}^trigger_id=${opts.triggerId}`) > 0
  )
    return null;
  if ((opts.repeatDays ?? 0) > 0) {
    const since = addMs(nowGlide(), -(opts.repeatDays ?? 0) * DAY);
    if (sys.count(T.instance, `metric_type=${survey.sysId}^user=${opts.user}^sys_created_on>=${since}`) > 0)
      return null;
  }
  const probability = opts.probability ?? 100;
  if (probability < 100 && Math.random() * 100 >= probability) return null;
  return sys.insert(T.instance, {
    metric_type: survey.sysId,
    user: opts.user,
    state: SURVEY_STATE.READY,
    due_date: addMs(nowGlide(), (survey.num('due_days') ?? 14) * DAY),
    trigger_table: opts.triggerTable ?? '',
    trigger_id: opts.triggerId ?? '',
    trigger_condition: opts.condition ?? '',
  });
}

/**
 * Sends surveys for a ticket that newly matches an active trigger condition (for example
 * an incident or requested item that closes). A department record that belongs to a
 * universal request is surveyed through the universal request instead.
 */
export function evaluateSurveyTriggers(ctx: Context, cur: Rec, prev: Rec | null): Rec[] {
  if (!ctx.platform.properties.getBool(PROPS.surveysEnabled, true)) return [];
  const triggers = activeTriggers(ctx.platform).filter((tr) => cur.table.ancestors.includes(tr.table));
  if (!triggers.length) return [];
  if (!cur.table.ancestors.includes(T.ur) && cur.has('universal_request') && cur.str('universal_request'))
    return [];
  const created: Rec[] = [];
  for (const tr of triggers) {
    const condition = tr.condition || 'active=false';
    if (!matches(condition, recSubject(cur, prev, ctx.registry), ctx.env)) continue;
    if (prev && matches(condition, recSubject(prev, null, ctx.registry), ctx.env)) continue;
    const user = cur.has(tr.userField) ? cur.str(tr.userField) : '';
    if (!user) continue;
    const inst = sendSurvey(ctx, {
      survey: tr.survey,
      user,
      triggerTable: cur.className,
      triggerId: cur.sysId,
      condition: tr.sysId,
      probability: tr.probability,
      repeatDays: tr.repeatDays,
    });
    if (inst) {
      created.push(inst);
      ctx.queueEvent('survey.instance.ready', inst, user, cur.str('number'));
    }
  }
  return created;
}

// ------------------------------------------------------------------ portal views

function triggerOf(ctx: Context, inst: Rec): Rec | null {
  const table = inst.str('trigger_table');
  const id = inst.str('trigger_id');
  return table && id && hasTable(ctx, table) ? ctx.elevated().get(table, id) : null;
}

export function surveyJson(ctx: Context, inst: Rec) {
  const survey = inst.ref('metric_type');
  const trigger = triggerOf(ctx, inst);
  return {
    sys_id: inst.sysId,
    number: inst.str('number'),
    state: { value: inst.str('state'), label: inst.display('state') },
    open: SURVEY_OPEN.includes(inst.str('state')),
    survey: survey
      ? { sys_id: survey.sysId, name: survey.str('name'), description: survey.str('description') }
      : null,
    due_date: inst.str('due_date'),
    taken_on: inst.str('taken_on'),
    created: inst.str('sys_created_on'),
    percent_answered: inst.num('percent_answered') ?? 0,
    trigger: trigger
      ? {
          table: trigger.className,
          sys_id: trigger.sysId,
          number: trigger.str('number'),
          title: trigger.str('short_description') || trigger.displayValue(),
        }
      : null,
  };
}

/** The user's survey instances: open ones first (by due date), then the rest. */
export function listSurveys(ctx: Context, which: 'pending' | 'all' = 'pending') {
  const me = ctx.user.sysId;
  if (!me) return [];
  const filter = which === 'pending' ? `^stateIN${SURVEY_OPEN.join(',')}` : '';
  const rows = ctx
    .elevated()
    .query(T.instance, { query: `user=${me}${filter}^ORDERBYDESCsys_created_on`, limit: 200 });
  rows.sort(
    (a, b) =>
      Number(SURVEY_OPEN.includes(b.str('state'))) - Number(SURVEY_OPEN.includes(a.str('state'))) ||
      a.str('due_date').localeCompare(b.str('due_date')),
  );
  return rows.map((r) => surveyJson(ctx, r));
}

/** Loads an instance the user may take (their own) or review (survey administrators). */
export function loadSurveyInstance(ctx: Context, id: string): Rec {
  const inst = isSysId(id) ? ctx.elevated().get(T.instance, id) : null;
  if (!inst) throw new NotFoundError();
  const own = !!ctx.user.sysId && inst.str('user') === ctx.user.sysId;
  if (!own && !ctx.hasAnyRole([ROLES.surveyAdmin, ROLES.surveyReader])) throw new NotFoundError();
  return inst;
}

function questionsOf(ctx: Context, inst: Rec): Rec[] {
  return ctx.elevated().query(T.question, {
    query: `metric_type=${inst.str('metric_type')}^active=true^ORDERBYorder^ORDERBYname`,
  });
}

export function surveyDetail(ctx: Context, inst: Rec, _lang: Lang) {
  const answers = new Map<string, Rec>();
  for (const r of ctx.elevated().query(T.result, { query: `instance=${inst.sysId}` }))
    answers.set(r.str('metric'), r);
  const own = inst.str('user') === ctx.user.sysId;
  return {
    ...surveyJson(ctx, inst),
    read_only: !own || !SURVEY_OPEN.includes(inst.str('state')),
    questions: questionsOf(ctx, inst).map((qn) => {
      const a = answers.get(qn.sysId);
      const type = qn.str('datatype') || 'scale';
      let answer: string | number | boolean | null = null;
      if (a) {
        if (type === 'string') answer = a.str('string_value');
        else if (type === 'boolean') answer = (a.num('actual_value') ?? 0) > 0;
        else answer = a.num('actual_value');
      }
      return {
        sys_id: qn.sysId,
        name: qn.str('name'),
        question: qn.str('question'),
        datatype: type,
        scale_min: qn.num('scale_min') ?? 1,
        scale_max: qn.num('scale_max') ?? 5,
        mandatory: qn.bool('mandatory'),
        answer,
      };
    }),
  };
}

export interface SurveySubmission {
  answers?: Record<string, unknown>;
  /** Shorthand for the first scale question. */
  rating?: unknown;
  /** Shorthand for the first text question. */
  comment?: unknown;
  /** Save without completing (state In progress). */
  save?: boolean;
}

function empty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Validates and stores answers; completes the instance unless `save` is set. */
export function submitSurvey(ctx: Context, inst: Rec, body: SurveySubmission): Rec {
  if (inst.str('user') !== ctx.user.sysId) throw new NotFoundError();
  if (!SURVEY_OPEN.includes(inst.str('state')))
    throw new InvalidError('This survey can no longer be changed');
  const sys = ctx.elevated();
  const questions = questionsOf(ctx, inst);
  const given = new Map<string, unknown>();
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  for (const qn of questions) given.set(qn.sysId, answers[qn.sysId] ?? answers[qn.str('name')]);
  const fill = (type: string, v: unknown) => {
    if (empty(v)) return;
    const target = questions.find(
      (qn) => (qn.str('datatype') || 'scale') === type && empty(given.get(qn.sysId)),
    );
    if (target) given.set(target.sysId, v);
  };
  fill('scale', body.rating);
  fill('string', body.comment);
  const save = !!body.save;
  const rows: { metric: Rec; actual: number | null; text: string }[] = [];
  for (const qn of questions) {
    const v = given.get(qn.sysId);
    const label = qn.str('question') || qn.str('name');
    if (empty(v)) {
      if (qn.bool('mandatory') && !save) throw new InvalidError(`An answer is required: ${label}`);
      continue;
    }
    const type = qn.str('datatype') || 'scale';
    if (type === 'string') {
      rows.push({ metric: qn, actual: null, text: String(v).trim().slice(0, 4000) });
    } else if (type === 'boolean') {
      const s = String(v).trim().toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(s))
        throw new InvalidError(`Answer yes or no: ${label}`);
      rows.push({ metric: qn, actual: ['true', '1', 'yes'].includes(s) ? 1 : 0, text: '' });
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new InvalidError(`A number is required: ${label}`);
      if (type === 'scale') {
        const min = qn.num('scale_min') ?? 1;
        const max = qn.num('scale_max') ?? 5;
        if (!Number.isInteger(n) || n < min || n > max)
          throw new InvalidError(`Choose a value from ${min} to ${max}: ${label}`);
      }
      rows.push({ metric: qn, actual: n, text: '' });
    }
  }
  for (const old of sys.query(T.result, { query: `instance=${inst.sysId}` })) sys.delete(old);
  for (const row of rows) {
    const weight = row.metric.num('weight') ?? 1;
    sys.insert(T.result, {
      instance: inst.sysId,
      metric: row.metric.sysId,
      user: inst.str('user'),
      actual_value: row.actual,
      normalized_value: row.actual === null ? null : row.actual * weight,
      string_value: row.text,
      source_table: inst.str('trigger_table'),
      source_id: inst.str('trigger_id'),
    });
  }
  const percent = questions.length ? Math.round((rows.length / questions.length) * 100) : 100;
  return sys.update(inst, {
    state: save ? SURVEY_STATE.WIP : SURVEY_STATE.COMPLETE,
    taken_on: save ? null : nowGlide(),
    percent_answered: percent,
  });
}

/** Cancels survey instances that were not taken before their due date. */
export function expireSurveys(ctx: Context): number {
  const sys = ctx.elevated();
  let n = 0;
  for (const inst of sys.query(T.instance, {
    query: `stateIN${SURVEY_OPEN.join(',')}^due_date<${nowGlide()}`,
    limit: 1000,
  })) {
    sys.update(inst, { state: SURVEY_STATE.CANCELED });
    n++;
  }
  return n;
}
