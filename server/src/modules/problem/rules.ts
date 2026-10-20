import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { propBool, propStr } from '../incident/util.js';
import { DEFAULT_PRIORITY_MATRIX } from '../task/index.js';
import {
  OPEN_TASK_STATES,
  PRB_PROP,
  PRB_STATE,
  PROBLEM_ASSIGNEE_ROLES,
  PTASK_STATE,
  RESOLUTION,
  TASK_ASSIGNEE_ROLES,
} from './constants.js';
import {
  allFixRecordsDone,
  moveDuplicateRecords,
  recountRelatedIncidents,
  shareKnownErrorArticle,
  syncIncidents,
} from './incidents.js';
import { cancelOpenTasks, currentAction, transitionAllowed } from './lifecycle.js';

const prevStr = (rec: Rec, field: string): string => {
  const v = rec.prev(field);
  return v === null || v === undefined ? '' : String(v);
};

/** Priority from the problem priority lookup (falls back to the standard matrix). */
export function problemPriority(ctx: Context, impact: string, urgency: string): number | null {
  if (!impact || !urgency) return null;
  const row = ctx.platform.db.get<{ priority: number }>(
    `SELECT "priority" FROM "dl_problem_priority" WHERE "impact" = ? AND "urgency" = ? AND ("active" IS NULL OR "active" = 1) ORDER BY "order" LIMIT 1`,
    [Number(impact), Number(urgency)],
  );
  return row ? Number(row.priority) : (DEFAULT_PRIORITY_MATRIX[`${impact}:${urgency}`] ?? null);
}

function holdsRole(ctx: Context, userId: string, roles: string[]): boolean {
  const user = ctx.platform.users.session(userId);
  return !!user && (user.isAdmin || roles.some((r) => user.roles.has(r)));
}

function groupFrom(rec: Rec | null, field: string): string | null {
  if (!rec || !field || !rec.has(field)) return null;
  return rec.str(field) || null;
}

function defaultModel(ctx: Context, table: string, query: string): string | null {
  return ctx.platform.systemContext().first(table, `active=true^${query}`)?.sysId ?? null;
}

const clearAssigneeOnGroupChange = (table: string): BusinessRuleDef => ({
  name: `${table === 'problem' ? 'Problem' : 'Problem task'}: clear assignee when the group changes`,
  table,
  when: 'before',
  actions: ['update'],
  order: 40,
  condition: (cur) =>
    cur.changed('assignment_group') && !cur.changed('assigned_to') && !!cur.str('assigned_to'),
  run(cur) {
    cur.setRaw('assigned_to', null);
  },
});

const assigneeRoleCheck = (table: string, roles: string[], label: string): BusinessRuleDef => ({
  name: `${table === 'problem' ? 'Problem' : 'Problem task'}: assignee must hold a problem role`,
  table,
  when: 'before',
  actions: ['insert', 'update'],
  order: 105,
  condition: (cur) => cur.changed('assigned_to') && !!cur.str('assigned_to'),
  run(cur, _prev, ctx) {
    if (!holdsRole(ctx, cur.str('assigned_to'), roles)) cur.abort(`The assignee must be a ${label}`);
  },
});

const problemBefore: BusinessRuleDef[] = [
  {
    name: 'Problem: defaults',
    table: 'problem',
    when: 'before',
    actions: ['insert'],
    order: 10,
    run(cur, _prev, ctx) {
      const assessed = !!cur.str('assignment_group') && !!cur.str('assigned_to');
      cur.setRaw('state', Number(assessed ? PRB_STATE.ASSESS : PRB_STATE.NEW));
      if (!cur.str('prb_model'))
        cur.setRaw('prb_model', defaultModel(ctx, 'prb_model', 'default_model=true'));
    },
  },
  clearAssigneeOnGroupChange('problem'),
  {
    name: 'Problem: priority from impact and urgency',
    table: 'problem',
    when: 'before',
    actions: ['insert', 'update'],
    order: 60,
    run(cur, _prev, ctx) {
      const p = problemPriority(ctx, cur.str('impact'), cur.str('urgency'));
      if (p !== null && cur.num('priority') !== p) cur.setRaw('priority', p);
    },
  },
  {
    name: 'Problem: work note required when the priority changes',
    table: 'problem',
    when: 'before',
    actions: ['update'],
    order: 70,
    condition: (cur) => (cur.changed('impact') || cur.changed('urgency')) && !cur.changed('work_notes'),
    run(cur) {
      cur.abort('Work notes are required when the priority changes');
    },
  },
  {
    name: 'Problem: state changes only through actions',
    table: 'problem',
    when: 'before',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('state') && !transitionAllowed(cur),
    run(cur) {
      cur.abort('Use the problem actions to change state');
    },
  },
  assigneeRoleCheck(
    'problem',
    PROBLEM_ASSIGNEE_ROLES,
    'problem coordinator, problem manager or problem admin',
  ),
  {
    name: 'Problem: mirror state to problem_state',
    table: 'problem',
    when: 'before',
    actions: ['insert', 'update'],
    order: 120,
    run(cur) {
      if (cur.str('problem_state') !== cur.str('state')) cur.setRaw('problem_state', cur.num('state'));
    },
  },
  {
    name: 'Problem: work note required for a major problem',
    table: 'problem',
    when: 'before',
    actions: ['update'],
    order: 130,
    condition: (cur) =>
      cur.changed('major_problem') && cur.bool('major_problem') && !cur.changed('work_notes'),
    run(cur) {
      cur.abort('Work notes are required when a problem is marked as a major problem');
    },
  },
  {
    name: 'Problem: populate assignment group from CI or service offering',
    table: 'problem',
    when: 'before',
    actions: ['insert', 'update'],
    order: 900,
    condition: (cur) =>
      !cur.str('assignment_group') &&
      !cur.str('assigned_to') &&
      (cur.isNew() || cur.changed('cmdb_ci') || cur.changed('service_offering')),
    run(cur, _prev, ctx) {
      const group =
        groupFrom(cur.ref('cmdb_ci'), propStr(ctx, PRB_PROP.ciGroupField, 'support_group')) ??
        groupFrom(cur.ref('service_offering'), propStr(ctx, PRB_PROP.offeringGroupField, 'support_group'));
      if (group) cur.setRaw('assignment_group', group);
    },
  },
];

function queueProblemEvents(cur: Rec, prev: Rec | null, ctx: Context): void {
  const inserted = cur.operation === 'insert';
  const uid = ctx.user.sysId ?? '';
  const before = (f: string) => (prev ? prev.str(f) : '');
  ctx.queueEvent(inserted ? 'problem.inserted' : 'problem.updated', cur, uid, ctx.user.userName);
  if (cur.changed('assigned_to') && cur.str('assigned_to'))
    ctx.queueEvent('problem.assigned', cur, cur.str('assigned_to'), before('assigned_to'));
  if (cur.changed('assignment_group') && cur.str('assignment_group')) {
    ctx.queueEvent('problem.assigned.to.group', cur, cur.str('assignment_group'), before('assignment_group'));
  }
  if (cur.changed('work_notes')) ctx.queueEvent('problem.worknoted', cur, uid, ctx.user.userName);
  if (!inserted && cur.changed('state'))
    ctx.queueEvent('problem.state.changed', cur, cur.str('state'), currentAction(cur));
}

const problemAfter: BusinessRuleDef[] = [
  {
    name: 'Problem: queue events',
    table: 'problem',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    run: queueProblemEvents,
  },
  {
    name: 'Problem: move records of a duplicate',
    table: 'problem',
    when: 'after',
    actions: ['update'],
    order: 190,
    condition: (cur) => cur.changedTo('resolution_code', RESOLUTION.DUPLICATE),
    run(cur, _prev, ctx) {
      moveDuplicateRecords(cur, ctx);
    },
  },
  {
    name: 'Problem: cancel open tasks on closure',
    table: 'problem',
    when: 'after',
    actions: ['update'],
    order: 200,
    condition: (cur, _prev, ctx) =>
      cur.changedTo('state', PRB_STATE.CLOSED) && propBool(ctx, PRB_PROP.cancelOpenTasks, true),
    run(cur, _prev, ctx) {
      cancelOpenTasks(ctx, cur);
    },
  },
  {
    name: 'Problem: update incidents when the problem is resolved or closed',
    table: 'problem',
    when: 'after',
    actions: ['update'],
    order: 220,
    condition: (cur) =>
      cur.changed('state') && [PRB_STATE.RESOLVED, PRB_STATE.CLOSED].includes(cur.str('state') as '106'),
    run(cur, _prev, ctx) {
      syncIncidents(cur, ctx);
    },
  },
  {
    name: 'Problem: share a new Known Error article with incidents',
    table: 'problem',
    when: 'after',
    actions: ['update'],
    order: 230,
    condition: (cur) =>
      cur.changed('primary_known_error_article') && !!cur.str('primary_known_error_article'),
    run(cur, _prev, ctx) {
      shareKnownErrorArticle(cur, ctx);
    },
  },
];

const taskRules: BusinessRuleDef[] = [
  {
    name: 'Problem task: defaults',
    table: 'problem_task',
    when: 'before',
    actions: ['insert'],
    order: 10,
    run(cur, _prev, ctx) {
      const problem = cur.ref('problem');
      if (
        problem?.str('state') === PRB_STATE.CLOSED &&
        !propBool(ctx, PRB_PROP.canCreateTasksOnClosed, false)
      ) {
        cur.abort('Tasks cannot be added to a closed problem');
        return;
      }
      if (!cur.str('problem_task_type')) cur.setRaw('problem_task_type', 'general');
      const assessed = !!cur.str('assignment_group') && !!cur.str('assigned_to');
      cur.setRaw('state', Number(assessed ? PTASK_STATE.ASSESS : PTASK_STATE.NEW));
      if (!cur.str('prb_task_model')) {
        cur.setRaw(
          'prb_task_model',
          defaultModel(ctx, 'prb_task_model', `problem_task_type=${cur.str('problem_task_type')}`),
        );
      }
      if (problem && !cur.str('cmdb_ci') && problem.str('cmdb_ci'))
        cur.setRaw('cmdb_ci', problem.str('cmdb_ci'));
    },
  },
  clearAssigneeOnGroupChange('problem_task'),
  {
    name: 'Problem task: state changes only through actions',
    table: 'problem_task',
    when: 'before',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('state') && !transitionAllowed(cur),
    run(cur) {
      cur.abort('Use the problem task actions to change state');
    },
  },
  {
    name: 'Problem task: type is fixed after creation',
    table: 'problem_task',
    when: 'before',
    actions: ['update'],
    order: 101,
    condition: (cur) => cur.changed('problem_task_type'),
    run(cur) {
      cur.abort('The problem task type cannot be changed');
    },
  },
  assigneeRoleCheck('problem_task', TASK_ASSIGNEE_ROLES, 'problem task analyst or problem coordinator'),
  {
    name: 'Problem task: events',
    table: 'problem_task',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    run(cur, prev, ctx) {
      if (cur.changed('assigned_to') && cur.str('assigned_to')) {
        ctx.queueEvent('problem_task.assigned', cur, cur.str('assigned_to'), prev?.str('assigned_to') ?? '');
      }
      if (cur.changed('assignment_group') && cur.str('assignment_group')) {
        ctx.queueEvent(
          'problem_task.assigned.to.group',
          cur,
          cur.str('assignment_group'),
          prev?.str('assignment_group') ?? '',
        );
      }
      if (cur.changed('work_notes'))
        ctx.queueEvent('problem_task.worknoted', cur, ctx.user.sysId ?? '', ctx.user.userName);
    },
  },
  {
    name: 'Problem task: notify the coordinator when all tasks are closed',
    table: 'problem_task',
    when: 'after',
    actions: ['update'],
    order: 200,
    condition: (cur) => cur.changedTo('state', PTASK_STATE.CLOSED),
    run(cur, _prev, ctx) {
      const problem = cur.ref('problem');
      if (!problem || problem.str('state') === PRB_STATE.CLOSED) return;
      const open = ctx
        .elevated()
        .count('problem_task', `problem=${problem.sysId}^stateIN${OPEN_TASK_STATES.join(',')}`);
      if (open === 0)
        ctx.queueEvent('problem_task.all_closed', problem, problem.str('assigned_to'), cur.str('number'));
    },
  },
];

/** Rules this module adds to incidents and fix records. */
const linkRules: BusinessRuleDef[] = [
  {
    name: 'Problem: related incident count',
    table: 'incident',
    when: 'after',
    actions: ['insert', 'update', 'delete'],
    order: 220,
    condition: (cur) => cur.operation === 'delete' || cur.changed('problem_id'),
    run(cur, _prev, ctx) {
      for (const id of new Set([cur.str('problem_id'), prevStr(cur, 'problem_id')]))
        recountRelatedIncidents(ctx, id);
    },
  },
  {
    name: 'Problem: link incidents of an attached Known Error article',
    table: 'm2m_kb_task',
    when: 'after',
    actions: ['insert'],
    order: 100,
    run(cur, _prev, ctx) {
      const task = cur.has('task') ? cur.ref('task') : null;
      const article = cur.has('kb_knowledge') ? cur.ref('kb_knowledge') : null;
      if (task?.className !== 'incident' || task.str('problem_id') || !article?.has('source')) return;
      const source = article.ref('source');
      if (source?.className === 'problem') ctx.elevated().update(task, { problem_id: source.sysId });
    },
  },
  {
    name: 'Check Related Problem Fixes - Change Req',
    table: 'change_request',
    when: 'after',
    actions: ['update'],
    order: 300,
    condition: (cur) => cur.changed('active') && !cur.bool('active') && !!cur.str('parent'),
    run(cur, _prev, ctx) {
      const problem = ctx.platform.systemContext().get('problem', cur.str('parent'));
      if (problem && allFixRecordsDone(ctx, problem.sysId)) {
        ctx.queueEvent(
          'problem.fix_records.completed',
          problem,
          problem.str('assigned_to'),
          cur.str('number'),
        );
      }
    },
  },
];

export const PROBLEM_RULES: BusinessRuleDef[] = [
  ...problemBefore,
  ...problemAfter,
  ...taskRules,
  ...linkRules,
];
