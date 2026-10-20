import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { AppModule } from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import type { AclDef } from '../../engine/services/acl.js';
import type { PropertyDef } from '../../engine/services/properties.js';
import { taskStates } from '../task/index.js';
import { registerChangeApi } from './api.js';
import { approvalRows, onChangeDecision } from './approvals.js';
import { runConflictDetection } from './conflicts.js';
import { PROP, STATE, T } from './constants.js';
import { changeDemo } from './demo.js';
import { changeEventHandlers, changeEvents } from './events.js';
import { changeModels } from './model.js';
import { registerProductApi } from './product-api.js';
import { changeRules, otherRules, taskRules } from './rules.js';
import { seedChange } from './seed.js';
import { decideProposal } from './standard.js';
import { changeTables } from './tables.js';
import { changeForm, changeUi } from './ui.js';
import { approvalsOf } from './util.js';

const READ = ['itil', 'change_manager', 'sn_change_read'];
const WRITE = ['itil', 'change_manager', 'sn_change_write'];

const readable = (name: string, roles = READ): AclDef => ({ name, operation: 'read', roles });
const CHANGE_SCHEDULES: string[] = [T.blackout, T.maintenance, T.information, T.conditionSchedule];

/** True for entries of blackout, maintenance and information schedules (or before a schedule is chosen). */
function isChangeScheduleEntry(rec: Rec | null, ctx: Context): boolean {
  const scheduleId = rec?.str('schedule');
  if (!scheduleId) return true;
  const schedule = ctx.elevated().get(T.schedule, scheduleId);
  return !!schedule && CHANGE_SCHEDULES.includes(schedule.className);
}
const manageable = (name: string, roles: string[]): AclDef[] =>
  (['write', 'create', 'delete'] as const).map((operation) => ({ name, operation, roles }));

const acls: AclDef[] = [
  // Change requests: agents and change managers; requesters, assignees, watchers and approvers can read.
  readable(T.change),
  {
    name: T.change,
    operation: 'read',
    condition: 'requested_by=javascript:gs.getUserID()',
    description: 'Requesters can read their changes',
  },
  { name: T.change, operation: 'read', condition: 'opened_by=javascript:gs.getUserID()' },
  { name: T.change, operation: 'read', condition: 'assigned_to=javascript:gs.getUserID()' },
  { name: T.change, operation: 'read', condition: 'watch_listLIKEjavascript:gs.getUserID()' },
  {
    name: T.change,
    operation: 'read',
    script: (rec, ctx) =>
      !!rec && !!ctx.user.sysId && approvalRows(ctx, rec.sysId, `approver=${ctx.user.sysId}`).length > 0,
    description: 'Approvers can read the changes they are asked to approve',
  },
  { name: T.change, operation: 'write', roles: WRITE },
  { name: T.change, operation: 'create', roles: WRITE },
  { name: T.change, operation: 'delete', roles: ['change_manager'] },
  {
    name: `${T.change}.approval`,
    operation: 'write',
    roles: ['admin'],
    description: 'The approval roll-up is maintained by the approval process',
  },
  { name: `${T.change}.unauthorized`, operation: 'write', roles: ['change_manager'] },
  { name: `${T.change}.exclude_from_conflict_detection`, operation: 'write', roles: ['change_manager'] },
  // Change tasks
  readable(T.task),
  { name: T.task, operation: 'read', condition: 'assigned_to=javascript:gs.getUserID()' },
  { name: T.task, operation: 'write', roles: WRITE },
  { name: T.task, operation: 'create', roles: WRITE },
  { name: T.task, operation: 'delete', roles: ['change_manager'] },
  // Reference data and results
  ...[
    T.conflict,
    T.worker,
    T.model,
    T.state,
    T.transition,
    T.conditionType,
    T.transitionCondition,
    T.fieldPolicy,
    T.attribute,
    T.stateAttribute,
    T.riskCondition,
    T.assessment,
    T.question,
    T.threshold,
    T.result,
    T.riskLookup,
    T.producer,
    T.version,
    T.stdTemplate,
    T.taskTemplate,
    T.stdProperties,
    T.cabDefinition,
    T.cabMeeting,
    T.agendaItem,
    T.attendee,
    T.blackout,
    T.maintenance,
    T.information,
    T.conditionSchedule,
    T.pipeline,
    'chg_template',
  ].map((t) => readable(t)),
  ...[
    T.model,
    T.state,
    T.transition,
    T.conditionType,
    T.transitionCondition,
    T.fieldPolicy,
    T.attribute,
    T.stateAttribute,
    T.producer,
    T.version,
    T.stdTemplate,
    T.taskTemplate,
    T.stdProperties,
    'chg_template',
  ].flatMap((t) => manageable(t, ['change_manager'])),
  ...[
    T.riskCondition,
    T.assessment,
    T.question,
    T.threshold,
    T.riskLookup,
    T.blackout,
    T.maintenance,
    T.information,
    T.conditionSchedule,
  ].flatMap((t) => manageable(t, ['change_manager', 'itil_admin'])),
  ...[T.cabDefinition, T.cabMeeting, T.agendaItem, T.attendee].flatMap((t) =>
    manageable(t, ['change_manager', 'sn_change_cab.cab_manager']),
  ),
  { name: T.result, operation: 'create', roles: WRITE },
  { name: T.proposal, operation: 'read', roles: READ },
  { name: T.proposal, operation: 'read', condition: 'requested_by=javascript:gs.getUserID()' },
  { name: T.proposal, operation: 'create', roles: WRITE },
  { name: T.proposal, operation: 'write', roles: WRITE },
  { name: T.proposal, operation: 'delete', roles: ['change_manager'] },
  ...[T.taskCi, T.taskService, T.taskOffering].flatMap((t) => [readable(t), ...manageable(t, WRITE)]),
  // Schedule entries are shared with the schedules module: only entries of change schedules are granted here.
  { name: T.span, operation: 'read', roles: READ, script: isChangeScheduleEntry },
  ...(['write', 'create', 'delete'] as const).map(
    (operation): AclDef => ({
      name: T.span,
      operation,
      roles: ['change_manager', 'itil_admin'],
      script: isChangeScheduleEntry,
    }),
  ),
];

const properties: PropertyDef[] = [
  {
    name: PROP.enforceData,
    value: 'true',
    type: 'boolean',
    description: 'Enforce change model state field policies on every write path',
  },
  {
    name: PROP.riskRule,
    value: 'ui_action',
    type: 'choicelist',
    choices: 'ui_action,business_rule,none',
    description: 'Risk conditions: ui_action (Calculate risk), business_rule (on save) or none',
  },
  {
    name: PROP.calculatedRisk,
    value: 'true',
    type: 'boolean',
    description: 'Include the calculated risk score (model success rate and impact)',
  },
  { name: PROP.cabGroup, value: 'CAB Approval', description: 'Group whose members authorize CAB changes' },
  {
    name: PROP.managementGroup,
    value: 'Change Management',
    description: 'Change management group (unauthorized changes, template proposals, reviews)',
  },
  {
    name: PROP.assessApprover,
    value: 'group',
    type: 'choicelist',
    choices: 'group,manager',
    description: 'Technical approval at Assess: the assignment group members or the group manager',
  },
  {
    name: PROP.implementTasks,
    value: 'true',
    type: 'boolean',
    description: 'Create the implementation and testing tasks when a change enters Implement',
  },
  {
    name: PROP.reviewNeedsClosedTasks,
    value: 'false',
    type: 'boolean',
    description: 'Block the move to Review while change tasks are still active',
  },
  {
    name: PROP.conflictAuto,
    value: 'true',
    type: 'boolean',
    description: 'Run conflict detection when the CI, planned dates, state or assignee change',
  },
  {
    name: PROP.conflictMode,
    value: 'basic',
    type: 'choicelist',
    choices: 'basic,advanced',
    description: 'basic: primary CI; advanced: affected and related CIs too',
  },
  {
    name: PROP.conflictContiguous,
    value: 'true',
    type: 'boolean',
    description: 'Windows that only touch (end equals start) do not conflict',
  },
  {
    name: PROP.conflictCurrentCi,
    value: 'true',
    type: 'boolean',
    description: 'Detect other changes scheduled on the same CI',
  },
  {
    name: PROP.conflictAssignedTo,
    value: 'true',
    type: 'boolean',
    description: 'Detect assignees scheduled on overlapping changes',
  },
  {
    name: PROP.conflictBlackout,
    value: 'true',
    type: 'boolean',
    description: 'Detect changes inside blackout schedules',
  },
  {
    name: PROP.conflictMaintenance,
    value: 'true',
    type: 'boolean',
    description: 'Detect changes outside applicable maintenance schedules',
  },
  {
    name: PROP.conflictMaxCount,
    value: '1000',
    type: 'integer',
    description: 'Maximum conflicts recorded per type (minimum 1000)',
  },
  {
    name: PROP.slotWindowDays,
    value: '90',
    type: 'integer',
    description: 'Scheduling assistant: days searched for free slots',
  },
  {
    name: PROP.slotLimit,
    value: '100',
    type: 'integer',
    description: 'Scheduling assistant: maximum slots returned',
  },
  {
    name: PROP.slotStepMinutes,
    value: '30',
    type: 'integer',
    description: 'Scheduling assistant: slot start granularity in minutes',
  },
  {
    name: PROP.unauthorizedEnabled,
    value: 'false',
    type: 'boolean',
    description: 'Record unauthorized changes from ci.change.unplanned events',
  },
  {
    name: PROP.unauthorizedIgnoreHours,
    value: '24',
    type: 'integer',
    description: 'Hours during which another unplanned event on the same CI is ignored',
  },
  {
    name: PROP.unauthorizedValidQuery,
    value: 'active=true^stateIN-1,0',
    description: 'Changes on the CI matching this query make an unplanned change valid',
  },
  {
    name: PROP.stateEventEnabled,
    value: 'false',
    type: 'boolean',
    description: 'Queue sn_change.state.updated on state changes',
  },
  {
    name: PROP.stateEventStates,
    value: '',
    description: 'States (comma separated values) that queue sn_change.state.updated; empty means all',
  },
  {
    name: PROP.notifyStateChange,
    value: 'true',
    type: 'boolean',
    description: 'Email the requester when the change becomes Scheduled, Implement, Review or Canceled',
  },
  {
    name: PROP.pipelineTemplate,
    value: '',
    description: 'Standard change template used by pipeline runs that do not name one',
  },
  {
    name: PROP.pipelineGroup,
    value: 'Change Management',
    description: 'Assignment group of pipeline changes when none is given or derived from the CI',
  },
  {
    name: PROP.calendarWindowDays,
    value: '366',
    type: 'integer',
    description: 'Largest range in days served by the change calendar',
  },
];

function rerunConflicts(ctx: Context, window: string): void {
  const sys = ctx.elevated();
  const changes = sys.query(
    T.change,
    `active=true^cmdb_ciISNOTEMPTY^end_dateISNOTEMPTY^exclude_from_conflict_detection!=true^${window}`,
  );
  for (const c of changes) runConflictDetection(ctx, c.sysId);
}

/** Change requests, change tasks, CAB, risk, conflicts, schedules and change API. */
export const changeModule: AppModule = {
  id: 'change',
  name: 'Change Management',
  description: 'Change requests, change tasks, CAB, risk, conflicts, schedules and change API.',
  // Approvals, CMDB and schedules are optional: their services are looked up at runtime.
  dependsOn: ['task'],
  tables: changeTables,
  roles: [
    {
      name: 'change_manager',
      description: 'Manages change models, approvals, CAB, templates and unauthorized changes',
    },
    { name: 'sn_change_read', description: 'Reads all changes and CAB information' },
    { name: 'sn_change_write', description: 'Writes change records', contains: ['sn_change_read'] },
    {
      name: 'sn_change_admin',
      description: 'Administers change management',
      contains: ['sn_change_write', 'change_manager', 'sn_change_cab.cab_manager'],
    },
    { name: 'sn_change_cab.cab_manager', description: 'Manages CAB definitions and meetings' },
  ],
  acls,
  rules: [...changeRules, ...taskRules, ...otherRules],
  properties,
  events: changeEvents,
  eventHandlers: changeEventHandlers,
  jobs: [
    {
      id: 'change.conflicts.week',
      name: 'Change conflict detection: changes starting within a week',
      intervalMs: 24 * 3_600_000,
      run: (ctx) =>
        rerunConflicts(ctx, 'start_date>=javascript:gs.nowDateTime()^start_date<javascript:gs.daysAgo(-7)'),
    },
    {
      id: 'change.conflicts.month',
      name: 'Change conflict detection: changes starting within a month',
      intervalMs: 2 * 24 * 3_600_000,
      run: (ctx) =>
        rerunConflicts(ctx, 'start_date>=javascript:gs.daysAgo(-7)^start_date<javascript:gs.daysAgo(-30)'),
    },
    {
      id: 'change.conflicts.later',
      name: 'Change conflict detection: changes starting in a month or more',
      intervalMs: 7 * 24 * 3_600_000,
      run: (ctx) => rerunConflicts(ctx, 'start_date>=javascript:gs.daysAgo(-30)'),
    },
  ],
  ui: changeUi,
  register(platform) {
    const states = taskStates(platform);
    states.register(T.change, {
      closed: [String(STATE.CLOSED), String(STATE.CANCELED)],
      defaultClosed: String(STATE.CLOSED),
    });
    states.register(T.task, { closed: ['3', '4'], defaultClosed: '3' });
    states.register(T.proposal, { closed: ['3', '4'], defaultClosed: '3' });
    changeModels(platform).watch();
    platform.forms.set(`${T.change}:default`, changeForm(platform));
  },
  afterBoot(platform) {
    // Registered after every module is up so the approvals service is found whatever the module order.
    const approvals = approvalsOf(platform);
    if (approvals) {
      approvals.onDecision(T.change, onChangeDecision);
      approvals.onDecision(T.proposal, (target, decision, ctx) => {
        decideProposal(ctx, target, decision);
      });
    }
  },
  seedVersion: 1,
  seed: seedChange,
  demo: changeDemo,
  http(app, deps) {
    registerChangeApi(app as FastifyInstance, deps as ApiDeps);
    registerProductApi(app as FastifyInstance, deps as ApiDeps);
  },
};
