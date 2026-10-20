import type { Context } from '../../engine/context.js';
import { DEFAULT_PRIORITY_MATRIX } from '../task/index.js';
import { DEFAULT_PROBLEM_MODEL, PRB_STATE, PTASK_STATE } from './constants.js';

const PROBLEM_STATES = [
  PRB_STATE.NEW,
  PRB_STATE.ASSESS,
  PRB_STATE.RCA,
  PRB_STATE.FIX_IN_PROGRESS,
  PRB_STATE.RESOLVED,
  PRB_STATE.CLOSED,
];
const TASK_STATES = [PTASK_STATE.NEW, PTASK_STATE.ASSESS, PTASK_STATE.WORK_IN_PROGRESS, PTASK_STATE.CLOSED];

/** Built-in lifecycle transitions, recorded as model rows for reference. */
const PROBLEM_TRANSITIONS: [string, string][] = [
  ['101', '102'],
  ['101', '107'],
  ['102', '103'],
  ['102', '107'],
  ['103', '104'],
  ['103', '107'],
  ['104', '103'],
  ['104', '106'],
  ['104', '107'],
  ['106', '107'],
  ['106', '103'],
  ['107', '103'],
];
const TASK_TRANSITIONS: [string, string][] = [
  ['151', '152'],
  ['151', '157'],
  ['152', '154'],
  ['152', '157'],
  ['154', '152'],
  ['154', '157'],
  ['157', '152'],
];

function seedModel(
  ctx: Context,
  table: string,
  values: Record<string, unknown>,
  states: string[],
  transitions: [string, string][],
): void {
  if (ctx.first(table, `name=${values.name}`)) return;
  const model = ctx.insert(table, values);
  const ids = new Map<string, string>();
  states.forEach((state, i) => {
    const row = ctx.insert('prb_model_state', {
      model_table: table,
      model: model.sysId,
      state: Number(state),
      initial_state: i === 0,
    });
    ids.set(state, row.sysId);
  });
  for (const [from, to] of transitions) {
    ctx.insert('prb_model_transition', {
      from_state: ids.get(from),
      to_state: ids.get(to),
      automatic: false,
    });
  }
}

/** Problem priority lookup rows and the default models (equal to the built-in lifecycle). */
export function seedProblemData(ctx: Context): void {
  if (ctx.count('dl_problem_priority') === 0) {
    for (const [key, priority] of Object.entries(DEFAULT_PRIORITY_MATRIX)) {
      const [impact, urgency] = key.split(':');
      ctx.insert('dl_problem_priority', { impact, urgency, priority });
    }
  }
  seedModel(
    ctx,
    'prb_model',
    {
      name: DEFAULT_PROBLEM_MODEL,
      default_model: true,
      description: 'Standard problem lifecycle from New to Closed',
    },
    PROBLEM_STATES,
    PROBLEM_TRANSITIONS,
  );
  seedModel(
    ctx,
    'prb_task_model',
    {
      name: 'Root cause analysis',
      problem_task_type: 'rca',
      description: 'Investigation of the cause of a problem',
    },
    TASK_STATES,
    TASK_TRANSITIONS,
  );
  seedModel(
    ctx,
    'prb_task_model',
    {
      name: 'General',
      problem_task_type: 'general',
      default_model: true,
      description: 'Any other unit of work on a problem',
    },
    TASK_STATES,
    TASK_TRANSITIONS,
  );
}
