/**
 * Validation of JSON flow definitions and compilation of the step tree into a flat
 * instruction list with jumps. A flat program gives every position a stable index,
 * so a waiting execution only persists its program counter and loop frames.
 */
import type { FlowDefinition, FlowStep } from './types.js';

/** Step types handled by the runtime itself (everything else must be an action). */
export const LOGIC_TYPES: ReadonlySet<string> = new Set([
  'action',
  'if',
  'for_each',
  'do_until',
  'wait_duration',
  'wait_condition',
  'set_variables',
  'subflow',
  'assign_outputs',
  'end',
]);

/** Action names that are aliases of logic steps. */
export const ACTION_ALIASES: Record<string, string> = {
  wait_for_duration: 'wait_duration',
  wait_for_condition: 'wait_condition',
  set_variables: 'set_variables',
  set_flow_variables: 'set_variables',
};

export type Instr =
  | { op: 'step'; step: FlowStep }
  | {
      op: 'if';
      step: FlowStep;
      branches: { condition: unknown; target: number; label: string }[];
      elseTarget: number;
      end: number;
    }
  | { op: 'jump'; target: number }
  | { op: 'each'; step: FlowStep; exit: number }
  | { op: 'next'; step: FlowStep; body: number }
  | { op: 'until_start'; step: FlowStep }
  | { op: 'until'; step: FlowStep; body: number };

export interface Program {
  main: Instr[];
  handler: Instr[];
}

const ID_RE = /^[A-Za-z_][\w-]*$/;
const NAME_RE = /^[a-z0-9_]+$/;

/** Effective kind of a step: a logic type, or `action` (explicit or shorthand `type: "<action name>"`). */
export function stepKind(step: FlowStep): string {
  if (step.type === 'action') {
    const alias = ACTION_ALIASES[String(step.action ?? '')];
    return alias ?? 'action';
  }
  if (LOGIC_TYPES.has(step.type)) return step.type;
  return ACTION_ALIASES[step.type] ?? 'action';
}

/** Action name of an action step (`action` key, or the shorthand type). */
export function actionName(step: FlowStep): string {
  return step.type === 'action' ? String(step.action ?? '') : step.type;
}

function asSteps(v: unknown): FlowStep[] {
  return Array.isArray(v) ? (v as FlowStep[]) : [];
}

export interface ValidationOptions {
  /** Known action names; null skips the check (during boot, before every module registered its actions). */
  actions: ReadonlySet<string> | null;
  maxActions: number;
  maxIterations: number;
}

/** Returns a list of problems; empty when the definition can be published. */
export function validateDefinition(input: unknown, opts: ValidationOptions): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return ['The definition must be a JSON object'];
  const def = input as FlowDefinition;
  if (def.schema && def.schema !== 'resolvr.flow/v1')
    errors.push(`Unsupported schema "${def.schema}" (expected resolvr.flow/v1)`);
  if (def.type && def.type !== 'flow' && def.type !== 'subflow')
    errors.push('type must be "flow" or "subflow"');
  if (def.run_as && def.run_as !== 'system' && def.run_as !== 'user')
    errors.push('run_as must be "system" or "user"');
  if (def.internal_name !== undefined && !NAME_RE.test(String(def.internal_name)))
    errors.push('internal_name may only contain a-z, 0-9 and _');
  if (def.run_with_roles !== undefined && !Array.isArray(def.run_with_roles))
    errors.push('run_with_roles must be a list of role names');
  if (!Array.isArray(def.steps)) errors.push('steps must be a list');
  for (const key of ['inputs', 'outputs', 'variables'] as const) {
    const list = def[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((v) => !v || typeof v.name !== 'string' || !v.name))
      errors.push(`${key} must be a list of {name, type}`);
  }
  const trigger = def.trigger as unknown as Record<string, unknown> | undefined;
  if (trigger) {
    if (def.type === 'subflow') errors.push('Subflows have no trigger');
    switch (trigger.type) {
      case 'record':
        if (typeof trigger.table !== 'string' || !trigger.table)
          errors.push('A record trigger needs a table');
        if (
          trigger.when !== undefined &&
          !['created', 'updated', 'created_or_updated'].includes(String(trigger.when))
        ) {
          errors.push('trigger.when must be created, updated or created_or_updated');
        }
        if (
          trigger.run !== undefined &&
          !['once', 'each_unique_change', 'always', 'if_not_running'].includes(String(trigger.run))
        ) {
          errors.push('trigger.run must be once, each_unique_change, always or if_not_running');
        }
        if (trigger.condition !== undefined && typeof trigger.condition !== 'string')
          errors.push('trigger.condition must be an encoded query');
        break;
      case 'scheduled': {
        const repeat = String(trigger.repeat ?? '');
        if (!['once', 'daily', 'weekly', 'monthly', 'interval'].includes(repeat))
          errors.push('trigger.repeat must be once, daily, weekly, monthly or interval');
        if (repeat === 'interval' && !trigger.every)
          errors.push('An interval schedule needs "every" (ISO-8601 duration)');
        if (repeat === 'once' && !trigger.at) errors.push('A one-time schedule needs "at"');
        break;
      }
      case 'api':
        break;
      default:
        errors.push('trigger.type must be record, scheduled or api');
    }
  }
  const ids = new Set<string>();
  let actions = 0;
  const walk = (steps: unknown, where: string) => {
    if (!Array.isArray(steps)) {
      errors.push(`${where} must be a list of steps`);
      return;
    }
    for (const raw of steps) {
      if (!raw || typeof raw !== 'object') {
        errors.push(`${where} contains an invalid step`);
        continue;
      }
      const s = raw as FlowStep;
      const label = `step "${s.id ?? '?'}"`;
      if (typeof s.id !== 'string' || !ID_RE.test(s.id))
        errors.push(`${where}: every step needs an id (letters, digits, _ or -)`);
      else if (ids.has(s.id)) errors.push(`Duplicate step id "${s.id}"`);
      else ids.add(s.id);
      if (typeof s.type !== 'string' || !s.type) {
        errors.push(`${label} needs a type`);
        continue;
      }
      if (s.when_error !== undefined && s.when_error !== 'fail' && s.when_error !== 'continue')
        errors.push(`${label}: when_error must be fail or continue`);
      const kind = stepKind(s);
      switch (kind) {
        case 'action': {
          actions++;
          const name = actionName(s);
          if (!name) errors.push(`${label} needs an action name`);
          else if (opts.actions && !opts.actions.has(name))
            errors.push(`${label} uses unknown action "${name}"`);
          if (s.inputs !== undefined && (typeof s.inputs !== 'object' || Array.isArray(s.inputs)))
            errors.push(`${label}: inputs must be an object`);
          break;
        }
        case 'if':
          if (s.condition === undefined) errors.push(`${label} needs a condition`);
          if (s.then !== undefined) walk(s.then, `${label} then`);
          if (s.else_if !== undefined) {
            if (!Array.isArray(s.else_if)) errors.push(`${label}: else_if must be a list`);
            else
              (s.else_if as { condition?: unknown; steps?: unknown }[]).forEach((b, i) => {
                if (!b || b.condition === undefined) errors.push(`${label}: else_if[${i}] needs a condition`);
                walk(b?.steps ?? [], `${label} else_if[${i}]`);
              });
          }
          if (s.else !== undefined) walk(s.else, `${label} else`);
          break;
        case 'for_each':
          if (s.items === undefined) errors.push(`${label} needs items`);
          if (s.as !== undefined && (typeof s.as !== 'string' || !/^[A-Za-z_]\w*$/.test(s.as)))
            errors.push(`${label}: "as" must be a pill name`);
          walk(s.steps ?? [], `${label} steps`);
          break;
        case 'do_until':
          if (s.condition === undefined) errors.push(`${label} needs a condition`);
          if (
            s.max_iterations !== undefined &&
            (Number(s.max_iterations) < 1 || Number(s.max_iterations) > opts.maxIterations)
          ) {
            errors.push(`${label}: max_iterations must be between 1 and ${opts.maxIterations}`);
          }
          walk(s.steps ?? [], `${label} steps`);
          break;
        case 'wait_duration': {
          const inputs = (s.inputs ?? {}) as Record<string, unknown>;
          if (
            s.duration === undefined &&
            s.until === undefined &&
            inputs.duration === undefined &&
            inputs.until === undefined
          ) {
            errors.push(`${label} needs a duration or an until date-time`);
          }
          break;
        }
        case 'wait_condition': {
          const inputs = (s.inputs ?? {}) as Record<string, unknown>;
          if (s.condition === undefined && inputs.condition === undefined)
            errors.push(`${label} needs a condition`);
          break;
        }
        case 'set_variables':
        case 'assign_outputs': {
          const values = s.values ?? (s.inputs as Record<string, unknown> | undefined)?.values;
          if (!values || typeof values !== 'object' || Array.isArray(values))
            errors.push(`${label} needs values`);
          if (kind === 'assign_outputs' && def.type !== 'subflow')
            errors.push(`${label}: assign_outputs is only allowed in subflows`);
          break;
        }
        case 'subflow':
          actions++;
          if (typeof s.subflow !== 'string' || !s.subflow)
            errors.push(`${label} needs the subflow's internal name`);
          break;
        case 'end':
          if (s.status !== undefined && s.status !== 'complete' && s.status !== 'error')
            errors.push(`${label}: status must be complete or error`);
          break;
        default:
          break;
      }
    }
  };
  if (Array.isArray(def.steps)) walk(def.steps, 'steps');
  if (def.error_handler !== undefined) walk(def.error_handler, 'error_handler');
  if (actions > opts.maxActions)
    errors.push(`The flow has ${actions} action steps; the limit is ${opts.maxActions}`);
  return errors;
}

function compileSteps(steps: FlowStep[], out: Instr[]): void {
  for (const s of steps) {
    switch (stepKind(s)) {
      case 'if': {
        const ins: Extract<Instr, { op: 'if' }> = {
          op: 'if',
          step: s,
          branches: [],
          elseTarget: -1,
          end: -1,
        };
        out.push(ins);
        const jumps: Extract<Instr, { op: 'jump' }>[] = [];
        const branches = [
          { condition: s.condition, steps: asSteps(s.then), label: 'then' },
          ...((Array.isArray(s.else_if) ? s.else_if : []) as { condition?: unknown; steps?: unknown }[]).map(
            (b, i) => ({
              condition: b.condition,
              steps: asSteps(b.steps),
              label: `else_if[${i}]`,
            }),
          ),
        ];
        for (const b of branches) {
          ins.branches.push({ condition: b.condition, target: out.length, label: b.label });
          compileSteps(b.steps, out);
          const j: Extract<Instr, { op: 'jump' }> = { op: 'jump', target: -1 };
          out.push(j);
          jumps.push(j);
        }
        ins.elseTarget = out.length;
        compileSteps(asSteps(s.else), out);
        ins.end = out.length;
        for (const j of jumps) j.target = out.length;
        break;
      }
      case 'for_each': {
        const start: Extract<Instr, { op: 'each' }> = { op: 'each', step: s, exit: -1 };
        out.push(start);
        const body = out.length;
        compileSteps(asSteps(s.steps), out);
        out.push({ op: 'next', step: s, body });
        start.exit = out.length;
        break;
      }
      case 'do_until': {
        out.push({ op: 'until_start', step: s });
        const body = out.length;
        compileSteps(asSteps(s.steps), out);
        out.push({ op: 'until', step: s, body });
        break;
      }
      default:
        out.push({ op: 'step', step: s });
    }
  }
}

export function compile(def: FlowDefinition): Program {
  const main: Instr[] = [];
  const handler: Instr[] = [];
  compileSteps(asSteps(def.steps), main);
  compileSteps(asSteps(def.error_handler), handler);
  return { main, handler };
}
