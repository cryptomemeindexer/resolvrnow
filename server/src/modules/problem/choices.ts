import type { ChoiceDef } from '../../engine/types.js';
import { CATEGORY_CHOICES, SUBCATEGORY_CHOICES } from '../incident/choices.js';

const list = (pairs: [string, string][], inactiveFrom = Number.POSITIVE_INFINITY): ChoiceDef[] =>
  pairs.map(([value, label], i) => ({
    value,
    label,
    sequence: i + 1,
    ...(i >= inactiveFrom ? { inactive: true } : {}),
  }));

export const PROBLEM_STATE_CHOICES = list([
  ['101', 'New'],
  ['102', 'Assess'],
  ['103', 'Root Cause Analysis'],
  ['104', 'Fix in Progress'],
  ['106', 'Resolved'],
  ['107', 'Closed'],
]);

/** Mirrors state; legacy values stay valid (inactive) for imports. */
export const PROBLEM_STATE_MIRROR_CHOICES = list(
  [
    ['101', 'New'],
    ['102', 'Assess'],
    ['103', 'Root Cause Analysis'],
    ['104', 'Fix in Progress'],
    ['106', 'Resolved'],
    ['107', 'Closed'],
    ['1', 'Open'],
    ['2', 'Known Error'],
    ['3', 'Pending Change'],
    ['4', 'Closed/Resolved'],
  ],
  6,
);

export const RESOLUTION_CODE_CHOICES = list([
  ['fix_applied', 'Fix Applied'],
  ['risk_accepted', 'Risk Accepted'],
  ['duplicate', 'Duplicate'],
  ['canceled', 'Canceled'],
]);

export const PROBLEM_TASK_STATE_CHOICES = list(
  [
    ['151', 'New'],
    ['152', 'Assess'],
    ['154', 'Work in Progress'],
    ['157', 'Closed'],
    ['-5', 'Pending'],
    ['1', 'Open'],
    ['2', 'Work in Progress'],
    ['3', 'Closed Complete'],
    ['4', 'Closed Incomplete'],
    ['7', 'Closed Skipped'],
  ],
  4,
);

export const PROBLEM_TASK_TYPE_CHOICES = list([
  ['rca', 'Root Cause Analysis'],
  ['general', 'General'],
]);

export const TASK_MODEL_TYPE_CHOICES = list([
  ['rca', 'Root Cause Analysis'],
  ['general', 'General'],
  ['model', 'Model'],
]);

export const PROBLEM_TASK_CLOSE_CODE_CHOICES = list([
  ['complete', 'Complete'],
  ['canceled', 'Canceled'],
]);

export const CAUSE_CODE_CHOICES = list([
  ['environmental_disaster', 'Environmental disaster'],
  ['hardware_issue', 'Hardware issue'],
  ['people_process_documentation', 'People/Process/Documentation'],
  ['software_issue', 'Software issue'],
  ['other', 'Other'],
]);

export const CONDITION_REQUIRES_CHOICES = list([
  ['predefined', 'Predefined condition'],
  ['condition', 'Transition Condition'],
  ['script', 'Transition Script'],
]);

export { CATEGORY_CHOICES, SUBCATEGORY_CHOICES };

/** Choice lists for inherited fields (applied as dictionary overrides by the platform). */
export const PROBLEM_MODULE_CHOICES: Record<string, ChoiceDef[]> = {
  'problem.state': PROBLEM_STATE_CHOICES,
  'problem_task.state': PROBLEM_TASK_STATE_CHOICES,
};
