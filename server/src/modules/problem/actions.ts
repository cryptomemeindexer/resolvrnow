import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import type { UiActionDef } from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import { INC_STATE } from '../incident/constants.js';
import { COORDINATOR, PRB_STATE, PTASK_STATE, TASK_ANALYST } from './constants.js';
import { communicateFix, communicateWorkaround, createProblemFromIncident, stripHtml } from './incidents.js';
import { createKnownErrorArticle, knowledgeAvailable } from './knowledge.js';
import {
  acceptRisk,
  assessProblem,
  assessTask,
  cancelProblem,
  cancelTask,
  canReanalyze,
  canReassessTask,
  completeProblem,
  completeTask,
  confirmProblem,
  fixProblem,
  markDuplicate,
  reanalyzeProblem,
  reassessTask,
  resolveProblem,
  startTaskWork,
} from './lifecycle.js';

const route = (table: string, sysId: string) => `/workspace/record/${table}/${sysId}`;
const text = (input: Record<string, unknown>, field: string) => String(input[field] ?? '').trim();
const inState = (rec: Rec, ...states: string[]) => states.includes(rec.str('state'));
const COORDINATORS = [COORDINATOR];
const ANALYSTS = [TASK_ANALYST];

/** Create Normal / Emergency Change: available when the change module provides change_request. */
export function createChangeFromProblem(ctx: Context, prb: Rec, type: 'normal' | 'emergency'): Rec {
  if (!ctx.user.isSystem && !ctx.hasRole(COORDINATOR))
    throw new AccessError('Insufficient rights to create changes from problems');
  if (!ctx.registry.has('change_request')) throw new AbortError('Change Management is not installed');
  const values: Record<string, unknown> = { type, parent: prb.sysId };
  for (const f of ['short_description', 'description', 'cmdb_ci', 'priority', 'company'])
    if (prb.str(f)) values[f] = prb.get(f);
  const change = ctx.insert('change_request', values);
  if (!prb.str('rfc'))
    ctx.update(prb, { rfc: change.sysId, work_notes: `Fix change ${change.str('number')} created.` });
  return change;
}

const problemActions: UiActionDef[] = [
  {
    id: 'problem.assess',
    table: 'problem',
    label: 'Assess',
    style: 'primary',
    order: 10,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.NEW),
    prompt: [
      { field: 'assignment_group', mandatory: true },
      { field: 'assigned_to', label: 'Problem coordinator', mandatory: true },
    ],
    run(rec, ctx, input) {
      assessProblem(ctx, rec, input);
      return { message: 'Problem moved to Assess' };
    },
  },
  {
    id: 'problem.confirm',
    table: 'problem',
    label: 'Confirm',
    style: 'primary',
    order: 20,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.ASSESS),
    run(rec, ctx) {
      confirmProblem(ctx, rec);
      return { message: 'Problem confirmed; root cause analysis can start' };
    },
  },
  {
    id: 'problem.fix',
    table: 'problem',
    label: 'Fix',
    style: 'primary',
    order: 30,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.RCA),
    prompt: [
      { field: 'cause_notes', mandatory: true },
      { field: 'fix_notes', mandatory: true },
    ],
    run(rec, ctx, input) {
      fixProblem(ctx, rec, input);
      return { message: 'Fix in progress' };
    },
  },
  {
    id: 'problem.resolve',
    table: 'problem',
    label: 'Resolve',
    style: 'primary',
    order: 40,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.FIX_IN_PROGRESS),
    prompt: [{ field: 'fix_notes', mandatory: true }],
    run(rec, ctx, input) {
      resolveProblem(ctx, rec, input);
      return { message: 'Problem resolved with the fix applied' };
    },
  },
  {
    id: 'problem.complete',
    table: 'problem',
    label: 'Complete',
    style: 'primary',
    order: 50,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.RESOLVED),
    run(rec, ctx) {
      completeProblem(ctx, rec);
      return { message: 'Problem closed' };
    },
  },
  {
    id: 'problem.accept_risk',
    table: 'problem',
    label: 'Accept Risk',
    order: 60,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.RCA, PRB_STATE.FIX_IN_PROGRESS),
    prompt: [
      { field: 'cause_notes', mandatory: true },
      { field: 'close_notes', label: 'Why is the risk accepted?', mandatory: true },
    ],
    run(rec, ctx, input) {
      acceptRisk(ctx, rec, input);
      return { message: 'Risk accepted' };
    },
  },
  {
    id: 'problem.mark_duplicate',
    table: 'problem',
    label: 'Mark Duplicate',
    order: 70,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.ASSESS, PRB_STATE.RCA),
    prompt: [{ field: 'duplicate_of', mandatory: true }],
    run(rec, ctx, input) {
      markDuplicate(ctx, rec, text(input, 'duplicate_of'));
      return { message: 'Marked as duplicate; related records moved' };
    },
  },
  {
    id: 'problem.reanalyze',
    table: 'problem',
    label: 'Re-analyze',
    order: 80,
    condition: canReanalyze,
    run(rec, ctx) {
      reanalyzeProblem(ctx, rec);
      return { message: 'Problem back in root cause analysis' };
    },
  },
  {
    id: 'problem.cancel',
    table: 'problem',
    label: 'Cancel',
    style: 'destructive',
    order: 90,
    roles: COORDINATORS,
    condition: (rec) => inState(rec, PRB_STATE.NEW, PRB_STATE.ASSESS, PRB_STATE.RCA),
    prompt: [{ field: 'work_notes', label: 'Reason', mandatory: true }],
    run(rec, ctx, input) {
      cancelProblem(ctx, rec, text(input, 'work_notes'));
      return { message: 'Problem canceled' };
    },
  },
  {
    id: 'problem.communicate_workaround',
    table: 'problem',
    label: 'Communicate Workaround',
    order: 200,
    roles: COORDINATORS,
    condition: (rec) => rec.bool('active') && !!stripHtml(rec.str('workaround')),
    run(rec, ctx) {
      const n = communicateWorkaround(ctx, rec);
      return { message: `Workaround shared with ${n} incident${n === 1 ? '' : 's'}` };
    },
  },
  {
    id: 'problem.communicate_fix',
    table: 'problem',
    label: 'Communicate Fix',
    order: 210,
    roles: COORDINATORS,
    condition: (rec) => !!stripHtml(rec.str('fix_notes')),
    run(rec, ctx) {
      const n = communicateFix(ctx, rec);
      return { message: `Fix shared with ${n} incident${n === 1 ? '' : 's'}` };
    },
  },
  {
    id: 'problem.create_known_error',
    table: 'problem',
    label: 'Create Known Error Article',
    order: 220,
    roles: COORDINATORS,
    actionName: 'create_known_error_article',
    // Hidden when the knowledge module contributes its own button for the same action.
    condition: (rec, ctx) =>
      knowledgeAvailable(ctx.platform) &&
      !rec.str('primary_known_error_article') &&
      ![...ctx.platform.uiActions.values()].some(
        (a) =>
          a.table === 'problem' &&
          a.actionName === 'create_known_error_article' &&
          a.id !== 'problem.create_known_error',
      ),
    run(rec, ctx) {
      const article = createKnownErrorArticle(ctx, rec);
      return {
        message: `Known error article ${article.str('number')} drafted`,
        redirect: route(article.className, article.sysId),
      };
    },
  },
  {
    id: 'problem.view_article',
    table: 'problem',
    label: 'View Article',
    order: 230,
    condition: (rec, ctx) =>
      !!rec.str('primary_known_error_article') && ctx.registry.has('kb_template_known_error_article'),
    run(rec) {
      return { redirect: route('kb_template_known_error_article', rec.str('primary_known_error_article')) };
    },
  },
  ...(['normal', 'emergency'] as const).map(
    (type, i): UiActionDef => ({
      id: `problem.create_${type}_change`,
      table: 'problem',
      label: `Create ${type === 'normal' ? 'Normal' : 'Emergency'} Change`,
      order: 240 + i,
      roles: COORDINATORS,
      condition: (rec, ctx) =>
        ctx.registry.has('change_request') && inState(rec, PRB_STATE.RCA, PRB_STATE.FIX_IN_PROGRESS),
      run(rec, ctx) {
        const change = createChangeFromProblem(ctx, rec, type);
        return {
          message: `${change.str('number')} created`,
          redirect: route('change_request', change.sysId),
        };
      },
    }),
  ),
  {
    id: 'problem.add_task',
    table: 'problem',
    label: 'Create Problem Task',
    order: 250,
    roles: ['itil', 'sn_problem_write', TASK_ANALYST],
    condition: (rec) => rec.bool('active'),
    run(rec) {
      return {
        redirect: `/workspace/record/problem_task/-1?sysparm_query=${encodeURIComponent(`problem=${rec.sysId}`)}`,
      };
    },
  },
];

const taskActions: UiActionDef[] = [
  {
    id: 'problem_task.assess',
    table: 'problem_task',
    label: 'Assess',
    style: 'primary',
    order: 10,
    roles: ANALYSTS,
    condition: (rec) => inState(rec, PTASK_STATE.NEW),
    prompt: [
      { field: 'assignment_group', mandatory: true },
      { field: 'assigned_to', mandatory: true },
    ],
    run(rec, ctx, input) {
      assessTask(ctx, rec, input);
      return { message: 'Task moved to Assess' };
    },
  },
  {
    id: 'problem_task.start_work',
    table: 'problem_task',
    label: 'Start Work',
    style: 'primary',
    order: 20,
    roles: ANALYSTS,
    condition: (rec) => inState(rec, PTASK_STATE.ASSESS),
    run(rec, ctx) {
      startTaskWork(ctx, rec);
      return { message: 'Work started' };
    },
  },
  {
    id: 'problem_task.complete_rca',
    table: 'problem_task',
    label: 'Complete',
    style: 'primary',
    order: 30,
    roles: ANALYSTS,
    condition: (rec) => inState(rec, PTASK_STATE.WORK_IN_PROGRESS) && rec.str('problem_task_type') === 'rca',
    prompt: [
      { field: 'cause_code', mandatory: true },
      { field: 'fix_notes', mandatory: true },
    ],
    run(rec, ctx, input) {
      completeTask(ctx, rec, input);
      return { message: 'Root cause analysis completed' };
    },
  },
  {
    id: 'problem_task.complete',
    table: 'problem_task',
    label: 'Complete',
    style: 'primary',
    order: 31,
    roles: ANALYSTS,
    condition: (rec) => inState(rec, PTASK_STATE.WORK_IN_PROGRESS) && rec.str('problem_task_type') !== 'rca',
    prompt: [{ field: 'close_notes', mandatory: true }],
    run(rec, ctx, input) {
      completeTask(ctx, rec, input);
      return { message: 'Task completed' };
    },
  },
  {
    id: 'problem_task.reassess',
    table: 'problem_task',
    label: 'Re-assess',
    order: 40,
    condition: canReassessTask,
    run(rec, ctx) {
      reassessTask(ctx, rec);
      return { message: 'Task back in Assess' };
    },
  },
  {
    id: 'problem_task.cancel',
    table: 'problem_task',
    label: 'Cancel',
    style: 'destructive',
    order: 50,
    roles: ANALYSTS,
    condition: (rec) => inState(rec, PTASK_STATE.NEW, PTASK_STATE.ASSESS, PTASK_STATE.WORK_IN_PROGRESS),
    prompt: [{ field: 'close_notes', label: 'Reason', mandatory: true }],
    run(rec, ctx, input) {
      cancelTask(ctx, rec, text(input, 'close_notes'));
      return { message: 'Task canceled' };
    },
  },
];

const incidentActions: UiActionDef[] = [
  {
    id: 'incident.create_problem',
    table: 'incident',
    label: 'Create Problem',
    order: 340,
    roles: ['itil', 'itil_admin', 'sn_incident_write'],
    condition: (rec) =>
      !rec.str('problem_id') && inState(rec, INC_STATE.NEW, INC_STATE.IN_PROGRESS, INC_STATE.ON_HOLD),
    run(rec, ctx) {
      const prb = createProblemFromIncident(ctx, rec);
      return { message: `Problem ${prb.str('number')} created`, redirect: route('problem', prb.sysId) };
    },
  },
];

export const PROBLEM_UI_ACTIONS: UiActionDef[] = [...problemActions, ...taskActions, ...incidentActions];
