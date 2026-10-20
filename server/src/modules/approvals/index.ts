import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import { InvalidError } from '../../engine/errors.js';
import type { AppModule } from '../../engine/module.js';
import type { AclDef } from '../../engine/services/acl.js';
import { SERVICES } from '../contracts.js';
import { registerApprovalApi } from './api.js';
import { approvalRuleTable, RULE_TABLE, runRulesAfter, runRulesBefore } from './classic.js';
import { APPROVAL_TABLE, DELEGATE_TABLE, GROUP_TABLE, ST, STEP_TABLE } from './constants.js';
import { ApprovalEngine, approvalEngine } from './engine.js';
import { approvalTables } from './tables.js';

export { approvalSummary } from './api.js';
export { approvalEngineFor } from './classic.js';
export { delegatesOf, delegatorsOf, isActiveDelegate } from './delegation.js';
export type {
  ApprovalEmailReply,
  ApprovalEmailResult,
  ApprovalStepRequest,
  ApprovalStepResult,
  DecisionHandler,
  StepListener,
} from './engine.js';
export { ApprovalEngine, ApprovalNotPendingError, approvalEngine } from './engine.js';
export { emailDecision, evaluateUnit, requiredApprovals, rollupStates } from './evaluate.js';

const ops = ['read', 'write', 'create', 'delete'] as const;

const acls: AclDef[] = [
  {
    name: APPROVAL_TABLE,
    operation: 'read',
    script: (rec, ctx) => !rec || approvalEngine(ctx.platform).canRead(rec, ctx),
    description: 'Approver, active delegate, approval_admin, or anyone who can read the approved record',
  },
  {
    name: APPROVAL_TABLE,
    operation: 'write',
    script: (rec, ctx) => !rec || approvalEngine(ctx.platform).canWrite(rec, ctx),
    description:
      'Pending approvals of the user or of a user who delegated approvals to them; approval_admin always',
  },
  {
    name: APPROVAL_TABLE,
    operation: 'create',
    script: (rec, ctx) => approvalEngine(ctx.platform).canCreate(rec, ctx),
    description: 'itil users who can write the record (manual approvers) or approval_admin',
  },
  { name: APPROVAL_TABLE, operation: 'delete', roles: ['admin'] },
  ...['approver', 'document_id', 'sysapproval', 'source_table', 'resolvr_step', 'iteration'].map(
    (f): AclDef => ({ name: `${APPROVAL_TABLE}.${f}`, operation: 'write', roles: ['approval_admin'] }),
  ),
  { name: GROUP_TABLE, operation: 'read', roles: ['itil', 'approval_admin'] },
  {
    name: GROUP_TABLE,
    operation: 'read',
    script: (rec, ctx) => !!rec && ctx.user.groups.includes(rec.str('assignment_group')),
    description: 'Members of the approving group',
  },
  ...(['write', 'create'] as const).map(
    (operation): AclDef => ({ name: GROUP_TABLE, operation, roles: ['approval_admin'] }),
  ),
  { name: GROUP_TABLE, operation: 'delete', roles: ['admin'] },
  { name: STEP_TABLE, operation: 'read', roles: ['itil', 'approval_admin'] },
  { name: RULE_TABLE, operation: 'read', roles: ['itil', 'approval_admin'] },
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: RULE_TABLE, operation, roles: ['approval_admin'] }),
  ),
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: STEP_TABLE, operation, roles: ['admin'] }),
  ),
  // Delegation: users manage their own delegates; delegates see who delegated to them.
  ...ops.map(
    (operation): AclDef => ({ name: DELEGATE_TABLE, operation, condition: 'user=javascript:gs.getUserID()' }),
  ),
  { name: DELEGATE_TABLE, operation: 'read', condition: 'delegate=javascript:gs.getUserID()' },
  ...ops.map((operation): AclDef => ({ name: DELEGATE_TABLE, operation, roles: ['user_admin'] })),
];

/** Approval engine (sysapproval_approver, group approvals, approval rules, delegation). */
export const approvalsModule: AppModule = {
  id: 'approvals',
  name: 'Approvals',
  description: 'Approval engine (sysapproval_approver, group approvals, approval rules, delegation).',
  dependsOn: ['task'],
  tables: [...approvalTables, approvalRuleTable],
  roles: [
    { name: 'approval_admin', description: 'View and modify approvals that are assigned to other users' },
    { name: 'approver_user', description: 'Can approve records routed to them' },
  ],
  acls,
  properties: [
    {
      name: 'resolvr.approvals.empty_outcome',
      value: 'approved',
      type: 'string',
      choices: 'approved,rejected,pending',
      description:
        'Outcome of an approval request (or group) without any active approver: approved, rejected or pending',
    },
    {
      name: 'resolvr.approvals.reject_closes_task',
      value: 'true',
      type: 'boolean',
      description: 'When no module handles a rejection and upon_reject=cancel, close the task as incomplete',
    },
  ],
  events: [
    {
      name: 'approval.inserted',
      table: APPROVAL_TABLE,
      description: 'An approval entered the Requested state',
    },
    { name: 'approval.approved', table: APPROVAL_TABLE, description: 'An approver approved' },
    { name: 'approval.rejected', table: APPROVAL_TABLE, description: 'An approver rejected' },
    {
      name: 'approval.rejected.by.other',
      table: APPROVAL_TABLE,
      description: 'Another approver rejected; this approval is no longer required',
    },
    { name: 'approval.cancelled', table: APPROVAL_TABLE, description: 'A pending approval was cancelled' },
    {
      name: 'request.approval.inserted',
      table: APPROVAL_TABLE,
      description: 'A catalog request approval entered the Requested state',
    },
    {
      name: 'request.approval.rejected',
      table: APPROVAL_TABLE,
      description: 'A catalog request approval was rejected',
    },
    {
      name: 'request.approval.cancelled',
      table: APPROVAL_TABLE,
      description: 'A catalog request approval was cancelled',
    },
  ],
  rules: [
    {
      name: 'Approval: prepare new approval',
      table: APPROVAL_TABLE,
      when: 'before',
      actions: ['insert'],
      order: 50,
      run: (cur, _prev, ctx) => approvalEngine(ctx.platform).prepareNewApproval(cur, ctx),
    },
    {
      name: 'Approval: validate decision',
      table: APPROVAL_TABLE,
      when: 'before',
      actions: ['update'],
      order: 50,
      run: (cur, prev, ctx) => approvalEngine(ctx.platform).validateApprovalChange(cur, prev, ctx),
    },
    {
      name: 'Approval: events, history and roll-up',
      table: APPROVAL_TABLE,
      when: 'after',
      actions: ['insert', 'update'],
      order: 100,
      run: (cur, prev, ctx) => approvalEngine(ctx.platform).afterApprovalChange(cur, prev, ctx),
    },
    {
      name: 'Approval: roll-up after delete',
      table: APPROVAL_TABLE,
      when: 'after',
      actions: ['delete'],
      order: 100,
      run: (cur, _prev, ctx) => approvalEngine(ctx.platform).recompute(ctx, cur.str('document_id')),
    },
    {
      name: 'Group approval: join approval step',
      table: GROUP_TABLE,
      when: 'before',
      actions: ['insert'],
      order: 50,
      run: (cur, _prev, ctx) => approvalEngine(ctx.platform).prepareNewGroup(cur, ctx),
    },
    {
      name: 'Group approval: member approvals and roll-up',
      table: GROUP_TABLE,
      when: 'after',
      actions: ['insert', 'update'],
      order: 100,
      run: (cur, prev, ctx) => approvalEngine(ctx.platform).afterGroupChange(cur, prev, ctx),
    },
    {
      name: 'Approval rules: before engine',
      table: 'task',
      when: 'before',
      actions: ['insert', 'update'],
      order: 999,
      condition: (cur) => cur.className !== GROUP_TABLE,
      run: (cur, _prev, ctx) => runRulesBefore(cur, ctx),
    },
    {
      name: 'Approval rules: after engine',
      table: 'task',
      when: 'after',
      actions: ['insert', 'update'],
      order: 999,
      condition: (cur) => cur.className !== GROUP_TABLE,
      run: (cur, _prev, ctx) => runRulesAfter(cur, ctx),
    },
    {
      name: 'Task: cancel pending approvals when closed',
      table: 'task',
      when: 'after',
      actions: ['update'],
      order: 150,
      condition: (cur) => cur.className !== GROUP_TABLE && cur.changed('active') && !cur.bool('active'),
      run: (cur, _prev, ctx) => approvalEngine(ctx.platform).onRecordClosed(cur, ctx),
    },
    {
      name: 'Delegate: validate',
      table: DELEGATE_TABLE,
      when: 'before',
      actions: ['insert', 'update'],
      order: 100,
      run(cur, _prev, ctx) {
        const user = cur.str('user');
        const delegate = cur.str('delegate');
        if (user && delegate && user === delegate) return cur.abort('A user cannot delegate to themselves');
        if (delegate) {
          const row = ctx.platform.db.get<{ active: number | null }>(
            `SELECT "active" FROM "sys_user" WHERE "sys_id" = ?`,
            [delegate],
          );
          if (!row || row.active === 0) return cur.abort('The delegate must be an active user');
        }
        const starts = cur.str('starts');
        const ends = cur.str('ends');
        if (starts && ends && ends < starts) return cur.abort('The end date must be after the start date');
      },
    },
  ],
  jobs: [
    {
      id: 'approvals.due',
      name: 'Approval due dates',
      description: 'Applies the "when due" outcome of approval requests whose due date has passed',
      intervalMs: 60_000,
      run: (ctx) => {
        ctx.platform.db.tx(() => approvalEngine(ctx.platform).processDue(ctx));
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'approvals',
        title: 'Approvals',
        icon: 'check-circle',
        order: 15,
        modules: [
          {
            title: 'My approvals',
            table: APPROVAL_TABLE,
            query: `approver=javascript:gs.getUserID()^state=${ST.requested}^ORDERBYsys_created_on`,
          },
          {
            title: 'My approval history',
            table: APPROVAL_TABLE,
            query: `approver=javascript:gs.getUserID()^stateIN${ST.approved},${ST.rejected}^ORDERBYDESCresolvr_decided_on`,
          },
          {
            title: 'All pending',
            table: APPROVAL_TABLE,
            query: `state=${ST.requested}^ORDERBYsys_created_on`,
            roles: ['itil', 'approval_admin'],
          },
          {
            title: 'Group approvals',
            table: GROUP_TABLE,
            query: `approval=${ST.requested}^ORDERBYsys_created_on`,
            roles: ['itil', 'approval_admin'],
          },
          { title: 'My delegates', table: DELEGATE_TABLE, query: 'user=javascript:gs.getUserID()' },
          {
            title: 'Approval rules',
            table: RULE_TABLE,
            query: 'ORDERBYtable^ORDERBYorder',
            roles: ['approval_admin'],
          },
        ],
      },
    ],
    lists: [
      {
        table: APPROVAL_TABLE,
        columns: ['state', 'approver', 'document_id', 'source_table', 'group', 'due_date', 'sys_created_on'],
      },
      {
        table: GROUP_TABLE,
        columns: [
          'number',
          'assignment_group',
          'approval',
          'parent',
          'resolvr_wait_for',
          'due_date',
          'sys_created_on',
        ],
      },
      {
        table: STEP_TABLE,
        columns: ['label', 'document_id', 'rule', 'state', 'source', 'iteration', 'due_date', 'decided_on'],
      },
      {
        table: DELEGATE_TABLE,
        columns: ['user', 'delegate', 'starts', 'ends', 'approvals', 'assignments', 'notifications'],
      },
      {
        table: RULE_TABLE,
        columns: ['name', 'table', 'active', 'run_before', 'user', 'group', 'set_state', 'order'],
      },
    ],
    forms: [
      {
        table: APPROVAL_TABLE,
        highlights: ['state', 'approver', 'due_date'],
        sections: [
          {
            left: ['approver', 'state', 'group', 'approval_source'],
            right: ['document_id', 'source_table', 'due_date', 'iteration'],
          },
          { caption: 'Decision', left: ['resolvr_decided_by'], right: ['resolvr_decided_on'] },
          { caption: 'Comments', fields: ['comments'] },
        ],
      },
      {
        table: GROUP_TABLE,
        highlights: ['approval', 'assignment_group'],
        sections: [
          {
            left: ['number', 'parent', 'assignment_group', 'approval'],
            right: ['resolvr_wait_for', 'resolvr_percentage', 'due_date', 'approval_set'],
          },
          { fields: ['short_description'] },
        ],
        relatedLists: [
          {
            table: APPROVAL_TABLE,
            field: 'group',
            label: 'Member approvals',
            columns: ['approver', 'state', 'resolvr_decided_on'],
          },
        ],
      },
      {
        table: STEP_TABLE,
        sections: [
          {
            left: ['label', 'document_id', 'source_table', 'state'],
            right: ['rule', 'percentage', 'source', 'iteration'],
          },
          { left: ['due_date', 'on_due'], right: ['decided_on', 'requested_by'] },
        ],
        relatedLists: [
          {
            table: APPROVAL_TABLE,
            field: 'resolvr_step',
            label: 'Approvals',
            columns: ['approver', 'group', 'state', 'resolvr_decided_on'],
          },
          {
            table: GROUP_TABLE,
            field: 'resolvr_step',
            label: 'Group approvals',
            columns: ['assignment_group', 'approval', 'resolvr_wait_for'],
          },
        ],
      },
      {
        table: DELEGATE_TABLE,
        sections: [
          {
            left: ['user', 'delegate', 'starts', 'ends'],
            right: ['approvals', 'assignments', 'notifications', 'invitations'],
          },
        ],
      },
      {
        table: RULE_TABLE,
        sections: [
          { left: ['name', 'table', 'active', 'order'], right: ['run_before', 'user', 'group', 'set_state'] },
          { fields: ['condition', 'script', 'description'] },
        ],
      },
    ],
    uiActions: [
      {
        id: 'approvals.approve',
        table: APPROVAL_TABLE,
        label: 'Approve',
        actionName: 'approve',
        style: 'primary',
        list: true,
        order: 100,
        saveFirst: false,
        condition: (rec, ctx) =>
          rec.str('state') === ST.requested && approvalEngine(ctx.platform).canDecide(ctx, rec),
        prompt: [{ field: 'comments', label: 'Comments (optional)', mandatory: false }],
        run(rec, ctx, input) {
          approvalEngine(ctx.platform).decide(ctx, rec, 'approved', String(input.comments ?? ''), {
            source: 'ui',
          });
          return { message: 'Approved' };
        },
      },
      {
        id: 'approvals.reject',
        table: APPROVAL_TABLE,
        label: 'Reject',
        actionName: 'reject',
        style: 'destructive',
        list: true,
        order: 110,
        saveFirst: false,
        condition: (rec, ctx) =>
          rec.str('state') === ST.requested && approvalEngine(ctx.platform).canDecide(ctx, rec),
        prompt: [{ field: 'comments', label: 'Reason for rejecting', mandatory: true }],
        run(rec, ctx, input) {
          const comments = String(input.comments ?? '').trim();
          if (!comments) throw new InvalidError('Comments are required to reject an approval');
          approvalEngine(ctx.platform).decide(ctx, rec, 'rejected', comments, { source: 'ui' });
          return { message: 'Rejected' };
        },
      },
      {
        id: 'approvals.request',
        table: APPROVAL_TABLE,
        label: 'Request approval',
        actionName: 'request_approval',
        order: 120,
        roles: ['itil', 'approval_admin'],
        condition: (rec, ctx) =>
          rec.str('state') === ST.notRequested &&
          (ctx.hasRole('approval_admin') || approvalEngine(ctx.platform).canCreate(rec, ctx)),
        run(rec, ctx) {
          ctx.elevated().update(rec, { state: ST.requested });
          return { message: 'Approval requested' };
        },
      },
    ],
  },
  register(platform) {
    platform.services.set(SERVICES.approvals, new ApprovalEngine(platform));
  },
  http(app, deps) {
    registerApprovalApi(app as FastifyInstance, deps as ApiDeps);
  },
};
