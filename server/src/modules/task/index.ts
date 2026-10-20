import type { Context } from '../../engine/context.js';
import type { AppModule } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { ChoiceDef } from '../../engine/types.js';
import { diffMs, nowGlide } from '../../engine/util.js';
import { sdkTable } from '../../schema/sdk.js';

export interface TaskStateModel {
  /** States that make the task inactive (closed, canceled...). */
  closed: string[];
  /** Optional states counted as resolved (sets resolved_at/resolved_by on tables that have them). */
  resolved?: string[];
  /** State used when an automation closes the task. */
  defaultClosed?: string;
}

/**
 * Per-class state models. Each ITSM module registers its own; lookups walk the
 * class hierarchy so subclasses inherit their parent's model.
 */
export class TaskStateService {
  private models = new Map<string, TaskStateModel>();
  private priorityTables = new Set<string>();

  constructor(private platform: Platform) {}

  register(table: string, model: TaskStateModel): void {
    this.models.set(table, model);
  }

  model(table: string): TaskStateModel | undefined {
    const meta = this.platform.registry.tryTable(table);
    for (const t of meta?.ancestors ?? [table]) {
      const m = this.models.get(t);
      if (m) return m;
    }
    return undefined;
  }

  isClosedState(table: string, state: string): boolean {
    return this.model(table)?.closed.includes(state) ?? false;
  }

  /** Enables impact × urgency priority calculation for a table (and its children). */
  enablePriorityLookup(table: string): void {
    this.priorityTables.add(table);
  }

  usesPriorityLookup(table: string): boolean {
    const meta = this.platform.registry.tryTable(table);
    return (meta?.ancestors ?? [table]).some((t) => this.priorityTables.has(t));
  }

  /** Priority from the dl_u_priority data lookup table (falls back to the standard matrix). */
  lookupPriority(ctx: Context, impact: string, urgency: string): string | null {
    if (!impact || !urgency) return null;
    const row = ctx.platform.db.get<{ priority: number }>(
      `SELECT "priority" FROM "dl_u_priority" WHERE "impact" = ? AND "urgency" = ? AND ("active" IS NULL OR "active" = 1) ORDER BY "order" LIMIT 1`,
      [Number(impact), Number(urgency)],
    );
    if (row) return String(row.priority);
    return String(DEFAULT_PRIORITY_MATRIX[`${impact}:${urgency}`] ?? 4);
  }
}

/** Standard impact × urgency → priority matrix (1 = Critical ... 5 = Planning). */
export const DEFAULT_PRIORITY_MATRIX: Record<string, number> = {
  '1:1': 1,
  '1:2': 2,
  '1:3': 3,
  '2:1': 2,
  '2:2': 3,
  '2:3': 4,
  '3:1': 3,
  '3:2': 4,
  '3:3': 5,
};

export function taskStates(platform: Platform): TaskStateService {
  return platform.service<TaskStateService>('tasks');
}

const c = (value: string, label: string, sequence?: number): ChoiceDef => ({ value, label, sequence });

export const TASK_CHOICES: Record<string, ChoiceDef[]> = {
  state: [
    c('-5', 'Pending', 1),
    c('1', 'Open', 2),
    c('2', 'Work in Progress', 3),
    c('3', 'Closed Complete', 4),
    c('4', 'Closed Incomplete', 5),
    c('7', 'Closed Skipped', 6),
  ],
  impact: [c('1', '1 - High', 1), c('2', '2 - Medium', 2), c('3', '3 - Low', 3)],
  urgency: [c('1', '1 - High', 1), c('2', '2 - Medium', 2), c('3', '3 - Low', 3)],
  priority: [c('1', '1 - Critical', 1), c('2', '2 - High', 2), c('3', '3 - Moderate', 3), c('4', '4 - Low', 4), c('5', '5 - Planning', 5)],
  approval: [
    c('not requested', 'Not Yet Requested', 1),
    c('requested', 'Requested', 2),
    c('approved', 'Approved', 3),
    c('rejected', 'Rejected', 4),
    c('cancelled', 'Cancelled', 5),
    c('not_required', 'No Longer Required', 6),
    c('duplicate', 'Duplicate', 7),
  ],
  contact_type: [
    c('email', 'Email', 1),
    c('phone', 'Phone', 2),
    c('self-service', 'Self-service', 3),
    c('walk-in', 'Walk-in', 4),
    c('chat', 'Chat', 5),
    c('virtual_agent', 'Virtual Agent', 6),
    c('monitoring', 'Monitoring', 7),
  ],
  escalation: [c('0', 'Normal', 1), c('1', 'Moderate', 2), c('2', 'High', 3), c('3', 'Overdue', 4)],
  upon_approval: [c('proceed', 'Proceed to Next Task', 1), c('do_nothing', 'Wait for a User to Close this task', 2)],
  upon_reject: [c('cancel', 'Cancel all future Tasks', 1), c('goto', 'Go to a previous Task', 2)],
};

function maintainActive(cur: Rec, prev: Rec | null, ctx: Context): void {
  const svc = taskStates(ctx.platform);
  const model = svc.model(cur.className);
  if (!model) return;
  const state = cur.str('state');
  const closed = model.closed.includes(state);
  if (!cur.isNew() && !cur.changed('state') && !cur.changed('active')) return;
  if (closed) {
    cur.setRaw('active', 0);
    if (!cur.str('closed_at')) cur.setRaw('closed_at', nowGlide());
    if (!cur.str('closed_by') && ctx.user.sysId) cur.setRaw('closed_by', ctx.user.sysId);
    const opened = cur.str('opened_at');
    if (opened) {
      const secs = Math.max(0, Math.round(diffMs(cur.str('closed_at'), opened) / 1000));
      cur.setRaw('calendar_duration', secs * 1000);
    }
  } else if (state) {
    cur.setRaw('active', 1);
    if (prev && model.closed.includes(prev.str('state'))) {
      cur.setRaw('closed_at', null);
      cur.setRaw('closed_by', null);
    }
  }
}

export const taskModule: AppModule = {
  id: 'task',
  name: 'Task',
  description: 'Base task table shared by incidents, problems, changes, requests and catalog tasks.',
  dependsOn: ['platform'],
  tables: [
    sdkTable('task', {
      displayField: 'number',
      audit: true,
      extensible: true,
      textIndex: ['number', 'short_description', 'description'],
      exclude: ['wf_activity', 'delivery_task', 'delivery_plan', 'sn_ai_sentiment', 'task_effective_number', 'route_reason', 'variables', 'user_input', 'comments_and_work_notes'],
      patch: {
        short_description: { maxLength: 160 },
        description: { maxLength: 4000, type: 'multi_two_lines' },
        state: { choices: TASK_CHOICES.state },
        impact: { choices: TASK_CHOICES.impact, defaultValue: '3' },
        urgency: { choices: TASK_CHOICES.urgency, defaultValue: '3' },
        priority: { choices: TASK_CHOICES.priority, defaultValue: '5' },
        approval: { choices: TASK_CHOICES.approval, defaultValue: 'not requested' },
        contact_type: { choices: TASK_CHOICES.contact_type },
        escalation: { choices: TASK_CHOICES.escalation, defaultValue: '0' },
        upon_approval: { choices: TASK_CHOICES.upon_approval, defaultValue: 'proceed' },
        upon_reject: { choices: TASK_CHOICES.upon_reject, defaultValue: 'cancel' },
        active: { defaultValue: 'true' },
        opened_by: { defaultValue: 'javascript:gs.getUserID()' },
        opened_at: { defaultValue: 'javascript:gs.nowDateTime()' },
        watch_list: { reference: 'sys_user' },
        work_notes_list: { reference: 'sys_user' },
        additional_assignee_list: { reference: 'sys_user' },
        group_list: { reference: 'sys_user_group' },
        number: { readOnly: true, indexed: true },
        reassignment_count: { readOnly: true, defaultValue: '0' },
        made_sla: { defaultValue: 'true' },
      },
    }),
    {
      name: 'dl_u_priority',
      label: 'Priority Data Lookup',
      displayField: 'priority',
      columns: [
        { name: 'impact', label: 'Impact', type: 'integer', choices: TASK_CHOICES.impact },
        { name: 'urgency', label: 'Urgency', type: 'integer', choices: TASK_CHOICES.urgency },
        { name: 'priority', label: 'Priority', type: 'integer', choices: TASK_CHOICES.priority },
        { name: 'active', label: 'Active', type: 'boolean', defaultValue: 'true' },
        { name: 'order', label: 'Order', type: 'integer', defaultValue: '100' },
      ],
    },
  ],
  roles: [],
  acls: [
    ...(['read', 'write', 'create'] as const).map((operation) => ({ name: 'task', operation, roles: ['itil'] })),
    { name: 'task', operation: 'delete', roles: ['admin'] },
    { name: 'task', operation: 'read', condition: 'opened_by=javascript:gs.getUserID()', description: 'Requesters can read tasks they opened' },
    { name: 'task', operation: 'read', condition: 'watch_listLIKEjavascript:gs.getUserID()', description: 'Watch list members can read the task' },
    { name: 'task', operation: 'read', condition: 'assigned_to=javascript:gs.getUserID()' },
    { name: 'dl_u_priority', operation: 'read', roles: ['itil'] },
  ],
  rules: [
    {
      name: 'Task: priority from impact and urgency',
      table: 'task',
      when: 'before',
      actions: ['insert', 'update'],
      order: 10,
      condition: (cur, _p, ctx) =>
        taskStates(ctx.platform).usesPriorityLookup(cur.className) &&
        (cur.isNew() || cur.changed('impact') || cur.changed('urgency')),
      run(cur, _prev, ctx) {
        const p = taskStates(ctx.platform).lookupPriority(ctx, cur.str('impact'), cur.str('urgency'));
        if (p) cur.setRaw('priority', Number(p));
      },
    },
    {
      name: 'Task: count reassignments',
      table: 'task',
      when: 'before',
      actions: ['update'],
      order: 200,
      condition: (cur, prev) => cur.changed('assignment_group') && !!prev?.str('assignment_group'),
      run(cur) {
        cur.setRaw('reassignment_count', (cur.num('reassignment_count') ?? 0) + 1);
      },
    },
    {
      name: 'Task: maintain active flag and close time',
      table: 'task',
      when: 'before',
      actions: ['insert', 'update'],
      order: 900,
      run: maintainActive,
    },
    {
      name: 'Task: set assignment time',
      table: 'task',
      when: 'before',
      actions: ['insert', 'update'],
      order: 950,
      condition: (cur) => cur.changed('assigned_to') && !!cur.str('assigned_to') && !cur.str('work_start'),
      run(cur) {
        cur.setRaw('work_start', nowGlide());
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'my_work',
        title: 'My Work',
        icon: 'inbox',
        roles: ['itil'],
        order: 10,
        modules: [
          { title: 'Assigned to me', table: 'task', query: 'active=true^assigned_to=javascript:gs.getUserID()^ORDERBYDESCpriority' },
          { title: 'My groups (unassigned)', table: 'task', query: 'active=true^assigned_toISEMPTY^assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744^ORDERBYpriority' },
          { title: "My groups' work", table: 'task', query: 'active=true^assignment_groupDYNAMICd6435e965f510100a9ad2572f2b47744^ORDERBYpriority' },
          { title: 'All open tasks', table: 'task', query: 'active=true^ORDERBYDESCsys_updated_on' },
        ],
      },
    ],
    lists: [
      { table: 'task', columns: ['number', 'short_description', 'sys_class_name', 'priority', 'state', 'assignment_group', 'assigned_to', 'sys_updated_on'] },
    ],
    forms: [
      {
        table: 'task',
        sections: [
          { left: ['number', 'opened_by', 'priority', 'state'], right: ['assignment_group', 'assigned_to', 'due_date', 'active'] },
          { fields: ['short_description', 'description'] },
          { caption: 'Notes', fields: ['watch_list', 'comments', 'work_notes'] },
        ],
      },
    ],
  },
  register(platform) {
    platform.services.set('tasks', new TaskStateService(platform));
    taskStates(platform).register('task', { closed: ['3', '4', '7'], defaultClosed: '3' });
  },
  seedVersion: 1,
  seed(ctx) {
    if (ctx.count('dl_u_priority') === 0) {
      for (const [key, priority] of Object.entries(DEFAULT_PRIORITY_MATRIX)) {
        const [impact, urgency] = key.split(':');
        ctx.insert('dl_u_priority', { impact, urgency, priority });
      }
    }
  },
};
