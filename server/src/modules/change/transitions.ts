import type { Context } from '../../engine/context.js';
import { AbortError } from '../../engine/errors.js';
import type { Rec } from '../../engine/record.js';
import { optionalService, type ScriptService, SERVICES } from '../contracts.js';
import { COND, PROP, STATE, stateLabel, T, TERMINAL_STATES } from './constants.js';
import { type ChangeModel, changeModels, type ModelCondition, type ModelTransition } from './model.js';
import { recordMatches, uniq } from './util.js';

/**
 * Raised by the transition guard. Extends AbortError so the save is rolled back like any
 * business rule abort; the change API reports `title` as the message and `detail` as the detail.
 */
export class ChangeTransitionError extends AbortError {
  constructor(
    readonly title: string,
    readonly detail: string,
  ) {
    super(`${title}: ${detail}`);
    this.name = 'ChangeTransitionError';
  }
}

export interface ConditionResult {
  condition: ModelCondition;
  passed: boolean;
  /** Why the condition failed, phrased to follow "cannot move from X to Y:". */
  reason: string;
}

export interface TransitionStatus {
  transition: ModelTransition;
  available: boolean;
  results: ConditionResult[];
}

export function activeTaskCount(ctx: Context, changeId: string): number {
  return ctx.elevated().count(T.task, `change_request=${changeId}^active=true`);
}

function isEmptyValue(rec: Rec, field: string): boolean {
  if (!rec.has(field)) return false;
  const v = rec.get(field);
  return v === null || v === undefined || v === '';
}

function fieldLabels(rec: Rec, fields: string[]): string {
  return fields.map((f) => rec.column(f)?.label ?? f).join(', ');
}

/** Mandatory fields of a model state that are empty on the record. */
export function missingMandatory(rec: Rec, model: ChangeModel, state: number): string[] {
  const st = model.states.get(state);
  if (!st) return [];
  return uniq(st.mandatory).filter((f) => isEmptyValue(rec, f));
}

export function stateName(model: ChangeModel | undefined, state: number | null): string {
  if (state === null) return '(empty)';
  return model?.states.get(state)?.label ?? stateLabel(state);
}

export function evaluateCondition(
  ctx: Context,
  rec: Rec,
  model: ChangeModel,
  t: ModelTransition,
  cond: ModelCondition,
): ConditionResult {
  const ok = (passed: boolean, reason: string): ConditionResult => ({
    condition: cond,
    passed,
    reason: passed ? '' : reason,
  });
  switch (cond.typeName) {
    case COND.NOT_ON_HOLD:
      return ok(!rec.bool('on_hold'), 'the change is on hold');
    case COND.NO_ACTIVE_TASKS:
      return ok(
        activeTaskCount(ctx, rec.sysId) === 0,
        'it still has active change tasks (close or cancel them first)',
      );
    case COND.APPROVED:
      return ok(rec.str('approval') === 'approved', 'the change has not been approved');
    case COND.REJECTED:
      return ok(rec.str('approval') === 'rejected', 'the change has not been rejected');
    default:
      break;
  }
  if (cond.kind === 'mandatory_fields') {
    const fields = cond.policyManaged ? (model.states.get(t.to)?.mandatory ?? []) : cond.fields;
    const missing = uniq(fields).filter((f) => isEmptyValue(rec, f));
    return ok(missing.length === 0, `mandatory fields are empty (${fieldLabels(rec, missing)})`);
  }
  if (cond.kind === 'script') {
    const scripts = optionalService<ScriptService>(ctx.platform, SERVICES.scripts);
    if (!scripts || !cond.script.trim()) return ok(false, `condition "${cond.name}" cannot be evaluated`);
    let passed = false;
    try {
      passed = scripts.condition(ctx.elevated(), cond.script, rec, null);
    } catch {
      passed = false;
    }
    return ok(passed, `condition "${cond.name}" is not met`);
  }
  return ok(recordMatches(ctx, rec, cond.condition, false), `condition "${cond.name}" is not met`);
}

/** Evaluates every condition of a transition against the record. */
export function transitionStatus(
  ctx: Context,
  rec: Rec,
  model: ChangeModel,
  t: ModelTransition,
  opts: { skipPolicy?: boolean } = {},
): TransitionStatus {
  const results = t.conditions
    .filter((c) => !(opts.skipPolicy && c.policyManaged))
    .map((c) => evaluateCondition(ctx, rec, model, t, c));
  return { transition: t, available: results.every((r) => r.passed), results };
}

/**
 * Business rule "Change: validate state transition". Throws ChangeTransitionError with a
 * message saying which move was attempted and why it is not allowed.
 */
export function validateTransition(ctx: Context, cur: Rec, prev: Rec): void {
  const from = prev.num('state');
  const to = cur.num('state');
  if (from === null || from === to) return;
  const model = changeModels(ctx.platform).forRecord(cur);
  const err = (detail: string) => new ChangeTransitionError('Invalid state transition', detail);
  if (to === null) throw err('The state of a change cannot be empty');
  const fromL = stateName(model, from);
  const toL = stateName(model, to);
  const move = `Change cannot move from ${fromL} to ${toL}`;
  if (TERMINAL_STATES.includes(from)) throw err(`${move}: ${fromL} is a final state`);
  if (cur.bool('on_hold') && to !== STATE.CANCELED) {
    throw err(`${move} while it is on hold (an on hold change can only be canceled)`);
  }
  if (!model) return;
  if (!model.states.has(to)) throw err(`${move}: ${toL} is not a state of the ${model.name} model`);
  const candidates = model.transitions.filter((t) => t.from === from && t.to === to);
  if (!candidates.length) {
    if (to === STATE.CANCELED && from === STATE.REVIEW)
      throw err(`${move}: changes in Review cannot be canceled`);
    throw err(move);
  }
  const statuses = candidates.map((t) => transitionStatus(ctx, cur, model, t, { skipPolicy: true }));
  if (!statuses.some((s) => s.available)) {
    // Report the reasons of the candidate closest to passing.
    const failures = (s: TransitionStatus) => s.results.filter((r) => !r.passed).length;
    const best = [...statuses].sort((a, b) => failures(a) - failures(b))[0];
    const reasons = uniq(best.results.filter((r) => !r.passed).map((r) => r.reason));
    throw err(`${move}: ${reasons.join('; ')}`);
  }
  if (
    from === STATE.IMPLEMENT &&
    to === STATE.REVIEW &&
    ctx.platform.properties.getBool(PROP.reviewNeedsClosedTasks, false) &&
    activeTaskCount(ctx, cur.sysId) > 0
  ) {
    throw err(`${move}: all change tasks must be closed or canceled before review`);
  }
}

/**
 * State field policies: mandatory fields of the record's state must be populated and
 * read-only fields of the state cannot change.
 */
export function enforceStatePolicies(ctx: Context, cur: Rec, prev: Rec | null): void {
  if (!ctx.platform.properties.getBool(PROP.enforceData, true)) return;
  const model = changeModels(ctx.platform).forRecord(cur);
  const state = cur.num('state');
  if (!model || state === null) return;
  const missing = missingMandatory(cur, model, state);
  if (missing.length) {
    cur.abort(`Mandatory fields must be populated: ${fieldLabels(cur, missing)}`);
    return;
  }
  if (!prev) return;
  const st = model.states.get(state);
  if (!st?.readOnly.length) return;
  const prevState = prev.num('state');
  const prevSt = prevState !== null && prevState !== state ? model.states.get(prevState) : st;
  const blocked = st.readOnly.filter((f) => {
    if (!cur.changed(f) || f === 'state') return false;
    // On a state change a field blocks only when it is read-only in both states.
    if (prevSt !== st && !prevSt?.readOnly.includes(f)) return false;
    // A mandatory read-only field that is still empty may be filled once.
    const wasEmpty = prev.get(f) === null || prev.get(f) === '';
    if (wasEmpty && st.mandatory.includes(f)) return false;
    return true;
  });
  if (blocked.length) cur.abort(`Read-only fields can't be modified: ${fieldLabels(cur, blocked)}`);
}

export interface NextStates {
  available_states: string[];
  state_label: Record<string, string>;
  state_transitions: Record<string, unknown>[][];
}

/** Next states of a change for the REST API (all transitions out of the current state). */
export function nextStates(ctx: Context, rec: Rec): NextStates {
  const current = rec.num('state') ?? STATE.NEW;
  const model = changeModels(ctx.platform).forRecord(rec);
  const labels: Record<string, string> = { [String(current)]: stateName(model, current) };
  if (!model || TERMINAL_STATES.includes(current)) {
    return { available_states: [String(current)], state_label: labels, state_transitions: [] };
  }
  const byTarget = new Map<number, ModelTransition[]>();
  for (const t of model.transitions.filter((x) => x.from === current)) {
    const list = byTarget.get(t.to) ?? [];
    list.push(t);
    byTarget.set(t.to, list);
  }
  const available = [String(current)];
  const groups: Record<string, unknown>[][] = [];
  for (const [to, list] of byTarget) {
    labels[String(to)] = stateName(model, to);
    const entries = list.map((t) => {
      const status = transitionStatus(ctx, rec, model, t);
      const onHoldBlocked = rec.bool('on_hold') && to !== STATE.CANCELED;
      return {
        sys_id: t.sysId,
        display_value: t.name,
        from_state: String(t.from),
        to_state: String(t.to),
        transition_available: status.available && !onHoldBlocked,
        automatic_transition: t.automatic,
        conditions: status.results.map((r) => ({
          passed: r.passed,
          condition: {
            name: r.condition.name,
            description: r.condition.description || null,
            sys_id: r.condition.sysId,
          },
        })),
      };
    });
    if (entries.some((e) => e.transition_available)) available.push(String(to));
    groups.push(entries);
  }
  return { available_states: available, state_label: labels, state_transitions: groups };
}

/** True when a manual (non automatic) transition from the current state to `to` exists. */
export function isManualNext(ctx: Context, rec: Rec, to: number): boolean {
  const model = changeModels(ctx.platform).forRecord(rec);
  const from = rec.num('state');
  if (!model || from === null) return false;
  return model.transitions.some((t) => t.from === from && t.to === to && !t.automatic);
}

const evaluating = new Set<string>();

/**
 * Model evaluation: takes automatic transitions out of the current state while their
 * conditions pass (at most `maxHops` moves). Returns the number of moves made.
 */
export function evaluateAutomaticTransitions(ctx: Context, changeId: string, maxHops = 5): number {
  if (!changeId || evaluating.has(changeId)) return 0;
  evaluating.add(changeId);
  let hops = 0;
  try {
    const sys = ctx.elevated();
    while (hops < maxHops) {
      const rec = sys.get(T.change, changeId);
      if (!rec || rec.bool('on_hold')) break;
      const state = rec.num('state');
      if (state === null || TERMINAL_STATES.includes(state)) break;
      const model = changeModels(ctx.platform).forRecord(rec);
      if (!model) break;
      const pick = model.transitions.find(
        (t) =>
          t.from === state &&
          t.automatic &&
          transitionStatus(sys, rec, model, t).available &&
          missingMandatory(rec, model, t.to).length === 0,
      );
      if (!pick) break;
      try {
        sys.update(rec, { state: String(pick.to) });
      } catch (e) {
        if (e instanceof AbortError) break;
        throw e;
      }
      hops++;
    }
  } finally {
    evaluating.delete(changeId);
  }
  return hops;
}
