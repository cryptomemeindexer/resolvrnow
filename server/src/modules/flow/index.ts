import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { AppModule } from '../../engine/module.js';
import type { AclDef } from '../../engine/services/acl.js';
import type { ApprovalEngine } from '../approvals/engine.js';
import { optionalService, SERVICES } from '../contracts.js';
import { registerFlowApi } from './api.js';
import { FlowEngine, flowEngine } from './engine.js';
import { seedFlows } from './seed.js';
import { CONTEXT_TABLE, FLOW_ROOT, FLOW_TABLE, flowTables, LOG_TABLE, SNAPSHOT_TABLE } from './tables.js';

export type { ActionImpl, ActionOutcome, ActionRuntime } from './actions.js';
export { contextDetail, contextSummary } from './api.js';
export { compile, validateDefinition } from './definition.js';
export { type CustomAction, FlowEngine, flowEngine, type StartOptions } from './engine.js';
export { type EvalEnv, evalCondition, evaluate, render } from './expr.js';
export { durationMs, nextRun } from './schedule.js';
export { NOTIFY_CALLER_ON_RESOLVE } from './seed.js';
export type { FlowDefinition, FlowStep, FlowTrigger } from './types.js';

const acls: AclDef[] = [
  { name: FLOW_ROOT, operation: 'read', roles: ['flow_designer', 'flow_operator'] },
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: FLOW_ROOT, operation, roles: ['flow_designer'] }),
  ),
  { name: CONTEXT_TABLE, operation: 'read', roles: ['flow_designer', 'flow_operator'] },
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: CONTEXT_TABLE, operation, roles: ['admin'] }),
  ),
  { name: LOG_TABLE, operation: 'read', roles: ['flow_designer', 'flow_operator'] },
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: LOG_TABLE, operation, roles: ['admin'] }),
  ),
  { name: SNAPSHOT_TABLE, operation: 'read', roles: ['flow_designer'] },
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: SNAPSHOT_TABLE, operation, roles: ['admin'] }),
  ),
];

/** Record-triggered flows with actions, approvals and waits. */
export const flowModule: AppModule = {
  id: 'flow',
  name: 'Flows',
  description: 'Record-triggered, scheduled and API flows with actions, approvals and waits.',
  dependsOn: ['task', 'approvals'],
  tables: flowTables,
  roles: [
    { name: 'flow_designer', description: 'Builds, publishes and runs flows', contains: ['flow_operator'] },
    { name: 'flow_operator', description: 'Monitors flow executions and cancels them' },
    { name: 'action_designer', description: 'Builds custom flow actions' },
  ],
  acls,
  properties: [
    {
      name: 'resolvr.flows.max_actions',
      value: '50',
      type: 'integer',
      description: 'Maximum number of action steps in a flow definition',
    },
    {
      name: 'resolvr.flows.max_iterations',
      value: '1000',
      type: 'integer',
      description: 'Maximum iterations of a For each or Do until loop',
    },
  ],
  events: [
    {
      name: 'flow.notification',
      description: 'Raised by a flow notification step when no email could be sent directly',
    },
  ],
  rules: [
    {
      name: 'Flow: validate definition',
      table: FLOW_TABLE,
      when: 'before',
      actions: ['insert', 'update'],
      order: 100,
      run: (cur, _prev, ctx) => flowEngine(ctx.platform).prepareFlow(cur),
    },
    {
      name: 'Flow: publish snapshot',
      table: FLOW_TABLE,
      when: 'after',
      actions: ['insert', 'update'],
      order: 100,
      run: (cur, prev, ctx) => flowEngine(ctx.platform).afterFlowSaved(cur, prev, ctx),
    },
  ],
  jobs: [
    {
      id: 'flow.runner',
      name: 'Flow runner',
      description: 'Runs queued flow executions and resumes waiting executions that are due',
      intervalMs: 1000,
      run: (ctx) => {
        flowEngine(ctx.platform).tick();
      },
    },
    {
      id: 'flow.scheduler',
      name: 'Scheduled flows',
      description: 'Starts flows with a scheduled trigger',
      intervalMs: 60_000,
      run: (ctx) => {
        flowEngine(ctx.platform).runSchedules();
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'flows',
        title: 'Flows',
        icon: 'workflow',
        roles: ['flow_designer', 'flow_operator'],
        order: 880,
        modules: [
          { title: 'Flow definitions', table: FLOW_TABLE, query: 'ORDERBYname' },
          { title: 'Executions', table: CONTEXT_TABLE, query: 'ORDERBYDESCsys_created_on' },
          {
            title: 'Waiting executions',
            table: CONTEXT_TABLE,
            query: 'state=WAITING^ORDERBYDESCsys_created_on',
          },
          {
            title: 'Failed executions',
            table: CONTEXT_TABLE,
            query: 'state=ERROR^ORDERBYDESCsys_created_on',
          },
        ],
      },
    ],
    lists: [
      {
        table: FLOW_TABLE,
        columns: [
          'name',
          'internal_name',
          'type',
          'status',
          'active',
          'resolvr_trigger_type',
          'resolvr_trigger_table',
          'sys_updated_on',
        ],
      },
      {
        table: CONTEXT_TABLE,
        columns: [
          'name',
          'state',
          'source_table',
          'source_record',
          'calling_source',
          'sys_created_on',
          'run_time',
          'error_message',
        ],
      },
      {
        table: LOG_TABLE,
        columns: ['sequence', 'step_id', 'step_type', 'action', 'state', 'message', 'started', 'duration_ms'],
      },
      { table: SNAPSHOT_TABLE, columns: ['flow', 'version', 'sys_created_on', 'sys_created_by'] },
    ],
    forms: [
      {
        table: FLOW_TABLE,
        highlights: ['status', 'active', 'resolvr_trigger_type'],
        sections: [
          {
            left: ['name', 'internal_name', 'type', 'status'],
            right: ['active', 'run_as', 'resolvr_trigger_type', 'resolvr_trigger_table'],
          },
          { fields: ['description'] },
          { caption: 'Definition', fields: ['resolvr_definition'] },
          {
            caption: 'Publishing',
            left: ['master_snapshot', 'resolvr_next_run'],
            right: ['run_with_roles', 'callable_by_client_api'],
          },
        ],
        relatedLists: [
          {
            table: CONTEXT_TABLE,
            field: 'flow',
            label: 'Executions',
            columns: ['state', 'source_record', 'sys_created_on', 'run_time', 'error_message'],
          },
          {
            table: SNAPSHOT_TABLE,
            field: 'flow',
            label: 'Snapshots',
            columns: ['version', 'sys_created_on', 'sys_created_by'],
          },
        ],
      },
      {
        table: CONTEXT_TABLE,
        highlights: ['state', 'flow', 'source_record'],
        sections: [
          {
            left: ['name', 'flow', 'state', 'calling_source'],
            right: ['source_table', 'source_record', 'is_test_run', 'run_time'],
          },
          { left: ['resolvr_started', 'resolvr_ended'], right: ['resolvr_wake_at', 'resolvr_parent'] },
          { fields: ['error_message'] },
        ],
        relatedLists: [
          {
            table: LOG_TABLE,
            field: 'context',
            label: 'Step log',
            columns: ['sequence', 'step_id', 'state', 'message', 'duration_ms'],
          },
        ],
      },
      {
        table: LOG_TABLE,
        sections: [
          {
            left: ['context', 'step_id', 'step_type', 'action'],
            right: ['state', 'level', 'started', 'duration_ms'],
          },
          { fields: ['message', 'inputs', 'outputs'] },
        ],
      },
    ],
    uiActions: [
      {
        id: 'flow.run_now',
        table: FLOW_TABLE,
        label: 'Run now',
        actionName: 'run_flow',
        style: 'primary',
        order: 100,
        roles: ['flow_designer'],
        run(rec, ctx) {
          const c = flowEngine(ctx.platform).startNow(ctx, rec);
          return {
            message: `Execution ${c.str('state').toLowerCase()}`,
            record: { table: CONTEXT_TABLE, sys_id: c.sysId },
          };
        },
      },
      {
        id: 'flow.publish',
        table: FLOW_TABLE,
        label: 'Publish',
        actionName: 'publish_flow',
        order: 110,
        roles: ['flow_designer'],
        condition: 'status=draft',
        run(rec, ctx) {
          ctx.update(rec, { status: 'published' });
          return { message: 'Flow published' };
        },
      },
      {
        id: 'flow.deactivate',
        table: FLOW_TABLE,
        label: 'Deactivate',
        actionName: 'deactivate_flow',
        order: 120,
        roles: ['flow_designer'],
        condition: 'active=true',
        run(rec, ctx) {
          ctx.update(rec, { active: false });
          return { message: 'Flow deactivated' };
        },
      },
      {
        id: 'flow.cancel_execution',
        table: CONTEXT_TABLE,
        label: 'Cancel',
        actionName: 'cancel_flow_execution',
        style: 'destructive',
        order: 100,
        roles: ['flow_designer', 'flow_operator'],
        condition: 'stateINQUEUED,IN_PROGRESS,WAITING',
        confirm: 'Cancel this execution? Pending approvals it asked for are cancelled too.',
        run(rec, ctx) {
          flowEngine(ctx.platform).cancel(
            ctx,
            rec.sysId,
            `Cancelled by ${ctx.user.name || ctx.user.userName}`,
          );
          return { message: 'Execution cancelled' };
        },
      },
    ],
  },
  register(platform) {
    const engine = new FlowEngine(platform);
    platform.services.set(SERVICES.flows, engine);
    platform.hooks.on('insert', '*', 'flow-triggers', (rec, prev, ctx) =>
      engine.onRecordWrite('insert', rec, prev, ctx),
    );
    platform.hooks.on('update', '*', 'flow-triggers', (rec, prev, ctx) =>
      engine.onRecordWrite('update', rec, prev, ctx),
    );
    platform.hooks.on(['insert', 'update', 'delete'], FLOW_ROOT, 'flow-cache', () => engine.invalidate());
    optionalService<ApprovalEngine>(platform, SERVICES.approvals)?.onStepDecided((step) =>
      engine.onApprovalStepDecided(step),
    );
  },
  seedVersion: 1,
  seed(ctx) {
    seedFlows(ctx);
  },
  afterBoot(platform) {
    flowEngine(platform).strictActions = true;
  },
  http(app, deps) {
    registerFlowApi(app as FastifyInstance, deps as ApiDeps);
  },
};
