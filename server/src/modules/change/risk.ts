import type { Context } from '../../engine/context.js';
import { InvalidError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { PROP, RISK_LABEL, STATE, T } from './constants.js';
import { cmdbOf, DAY_MS, readJson, recordMatches } from './util.js';

/** Minimum number of closed changes of a model before its success rate is used. */
export const CALCULATED_MIN_SAMPLE = 5;

export interface RiskOutcome {
  /** Final risk (highest = lowest number) across the engines, or null when no engine produced one. */
  risk: number | null;
  impact: number | null;
  condition: { sys_id: string; name: string; risk: number | null; impact: number | null } | null;
  assessment: { sys_id: string; score: number; risk: number | null } | null;
  calculated: { risk: number; success_probability: string; success_rate: number } | null;
  messages: string[];
}

export interface AnswerOption {
  label: string;
  value: number;
}

/** Number of business/application services impacted by the change's configuration item. */
export function impactedServiceCount(ctx: Context, change: Rec): number {
  const ci = change.str('cmdb_ci');
  const cmdb = cmdbOf(ctx.platform);
  if (ci && cmdb) {
    try {
      return cmdb.impactedServices(ctx.elevated(), ci).length;
    } catch {
      return 0;
    }
  }
  return ctx.elevated().count(T.taskService, `task=${change.sysId}`);
}

/** First active risk condition (lowest order) matching the change. */
export function matchRiskCondition(ctx: Context, change: Rec): Rec | null {
  const sys = ctx.elevated();
  let impacted: number | null = null;
  for (const rule of sys.query(T.riskCondition, {
    query: 'active=true',
    orderBy: [{ field: 'order', desc: false }],
  })) {
    if (rule.bool('use_advanced_condition')) {
      const scripts = optionalService<ScriptService>(ctx.platform, SERVICES.scripts);
      if (!scripts || !rule.str('advanced_condition').trim()) continue;
      let ok = false;
      try {
        ok = scripts.condition(sys, rule.str('advanced_condition'), change, null);
      } catch {
        ok = false;
      }
      if (!ok) continue;
    } else if (!recordMatches(ctx, change, rule.str('condition'), true)) {
      continue;
    }
    const min = rule.num('resolvr_min_impacted_services');
    if (min && min > 0) {
      impacted ??= impactedServiceCount(ctx, change);
      if (impacted < min) continue;
    }
    return rule;
  }
  return null;
}

/** Most recent completed risk assessment result of a change. */
export function latestAssessmentResult(ctx: Context, changeId: string): Rec | null {
  return ctx.elevated().first(T.result, `change=${changeId}`, [{ field: 'taken_on', desc: true }]);
}

/** Calculated risk from the model's recent success rate and the change impact. */
export function calculatedRisk(ctx: Context, change: Rec): RiskOutcome['calculated'] {
  if (!ctx.platform.properties.getBool(PROP.calculatedRisk, true)) return null;
  const impact = change.num('impact');
  const model = change.str('chg_model');
  if (!impact || !model) return null;
  const since = addMs(nowGlide(), -90 * DAY_MS);
  const sys = ctx.elevated();
  const base = `chg_model=${model}^state=${STATE.CLOSED}^closed_at>=${since}^sys_id!=${change.sysId}`;
  const closed = sys.count(T.change, base);
  if (closed < CALCULATED_MIN_SAMPLE) return null;
  const successful = sys.count(T.change, `${base}^close_code=successful`);
  const rate = successful / closed;
  const band = rate >= 0.9 ? 'high' : rate >= 0.7 ? 'medium' : 'low';
  const row = sys.first(T.riskLookup, `impact=${impact}^success_probability=${band}`);
  const risk = row?.num('risk');
  if (!risk) return null;
  return { risk, success_probability: band, success_rate: Math.round(rate * 1000) / 10 };
}

/** Runs every risk engine; the highest risk (lowest value) wins. Does not save. */
export function computeRisk(ctx: Context, change: Rec): RiskOutcome {
  const messages: string[] = [];
  const rule = matchRiskCondition(ctx, change);
  const condition = rule
    ? { sys_id: rule.sysId, name: rule.str('name'), risk: rule.num('risk'), impact: rule.num('impact') }
    : null;
  if (condition) messages.push(`Risk condition applied: ${condition.name}`);
  const result = latestAssessmentResult(ctx, change.sysId);
  const assessment = result
    ? { sys_id: result.sysId, score: result.num('score') ?? 0, risk: result.num('risk') }
    : null;
  if (assessment?.risk)
    messages.push(
      `Risk assessment result: ${RISK_LABEL[String(assessment.risk)]} (score ${assessment.score})`,
    );
  const calculated = calculatedRisk(ctx, change);
  if (calculated) {
    messages.push(
      `Calculated risk: ${RISK_LABEL[String(calculated.risk)]} (model success rate ${calculated.success_rate}%)`,
    );
  }
  const candidates = [condition?.risk, assessment?.risk, calculated?.risk].filter(
    (r): r is number => !!r && r > 0,
  );
  const risk = candidates.length ? Math.min(...candidates) : null;
  const impact = condition?.impact ?? null;
  return { risk, impact, condition, assessment, calculated, messages };
}

/** Computes risk and writes `risk` (and `impact` from the winning risk condition). */
export function applyRisk(ctx: Context, change: Rec): RiskOutcome {
  const outcome = computeRisk(ctx, change);
  const values: Record<string, unknown> = {};
  if (outcome.risk !== null && outcome.risk !== change.num('risk')) values.risk = outcome.risk;
  if (outcome.impact !== null && outcome.impact !== change.num('impact')) values.impact = outcome.impact;
  if (Object.keys(values).length) ctx.update(change, values);
  if (outcome.risk === null)
    outcome.messages.push('No risk condition, assessment or calculated score applies to this change');
  return outcome;
}

/** Published assessment applying to a change (first whose condition matches). */
export function assessmentFor(ctx: Context, change: Rec): Rec | null {
  for (const a of ctx
    .elevated()
    .query(T.assessment, { query: 'state=published', orderBy: [{ field: 'name', desc: false }] })) {
    if (recordMatches(ctx, change, a.str('condition'), false)) return a;
  }
  return null;
}

export function assessmentQuestions(ctx: Context, assessmentId: string): Rec[] {
  return ctx.elevated().query(T.question, {
    query: `risk_assessment=${assessmentId}^active=true`,
    orderBy: [{ field: 'order', desc: false }],
  });
}

export function questionOptions(q: Rec): AnswerOption[] {
  const raw = readJson<unknown>(q.str('options'), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      const opt = o as { label?: unknown; value?: unknown };
      return { label: String(opt.label ?? opt.value ?? ''), value: Number(opt.value) };
    })
    .filter((o) => Number.isFinite(o.value));
}

/** Risk from assessment thresholds: the threshold with the largest bound strictly below the score. */
export function riskFromThresholds(ctx: Context, assessmentId: string, score: number): number | null {
  const rows = ctx.elevated().query(T.threshold, `risk_assessment=${assessmentId}`);
  let best: { bound: number; risk: number } | null = null;
  for (const r of rows) {
    const bound = r.num('score_greater_than') ?? 0;
    const risk = r.num('risk');
    if (risk === null || !(score > bound)) continue;
    if (!best || bound > best.bound) best = { bound, risk };
  }
  return best?.risk ?? null;
}

/**
 * Scores answers: sum(answer value x question weight x category weight). Answers are keyed
 * by question sys_id; a value may be the option value or its label.
 */
export function scoreAnswers(
  ctx: Context,
  assessment: Rec,
  answers: Record<string, unknown>,
): { score: number; risk: number | null; normalized: Record<string, number> } {
  const categoryWeight = assessment.num('category_weight') ?? 1;
  const normalized: Record<string, number> = {};
  let score = 0;
  const missing: string[] = [];
  for (const q of assessmentQuestions(ctx, assessment.sysId)) {
    const given = answers[q.sysId];
    if (given === undefined || given === null || given === '') {
      if (q.bool('mandatory')) missing.push(q.str('question'));
      continue;
    }
    const options = questionOptions(q);
    const hit =
      options.find((o) => String(o.value) === String(given)) ??
      options.find((o) => o.label.toLowerCase() === String(given).trim().toLowerCase());
    if (!hit) throw new InvalidError(`Invalid answer for "${q.str('question')}"`);
    normalized[q.sysId] = hit.value;
    score += hit.value * (q.num('weight') ?? 1) * categoryWeight;
  }
  if (missing.length) throw new InvalidError(`Mandatory questions are not answered: ${missing.join('; ')}`);
  score = Math.round(score * 100) / 100;
  return { score, risk: riskFromThresholds(ctx, assessment.sysId, score), normalized };
}

/** Records a completed risk assessment for a change and recalculates its risk. */
export function submitAssessment(
  ctx: Context,
  change: Rec,
  assessmentId: string,
  answers: Record<string, unknown>,
): { result: Rec; outcome: RiskOutcome } {
  const sys = ctx.elevated();
  const assessment = sys.get(T.assessment, assessmentId);
  if (assessment?.str('state') !== 'published')
    throw new InvalidError('Unknown or unpublished risk assessment');
  const { score, risk, normalized } = scoreAnswers(ctx, assessment, answers);
  // One result per change and assessment: submitting again edits the existing answers.
  const values = {
    answers: JSON.stringify(normalized),
    score,
    risk,
    taken_by: ctx.user.sysId,
    taken_on: nowGlide(),
  };
  const existing = sys.first(T.result, `change=${change.sysId}^risk_assessment=${assessment.sysId}`);
  const result = existing
    ? sys.update(existing, values)
    : sys.insert(T.result, { change: change.sysId, risk_assessment: assessment.sysId, ...values });
  const fresh = sys.get(T.change, change.sysId) ?? change;
  const outcome = applyRisk(ctx, fresh);
  return { result, outcome };
}
