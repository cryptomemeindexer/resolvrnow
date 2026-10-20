import type { Context } from '../../engine/context.js';
import { AbortError, InvalidError } from '../../engine/errors.js';
import type { FormLayoutDef, ModuleUiDef, UiActionDef } from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import {
  canDecideDirectly,
  decideAsApprover,
  directDecision,
  pendingApprovalFor,
  requestApprovalTarget,
  usesFallbackApprovals,
} from './approvals.js';
import { refreshAgenda, setMeetingState } from './cab.js';
import { conflictPrecondition, runConflictDetection } from './conflicts.js';
import { APPROVAL_STATES, MODEL_IDS, PROP, STATE, stateLabel, T, TASK_STATE } from './constants.js';
import { applyRisk } from './risk.js';
import { refreshImpactedServices } from './rules.js';
import {
  createStandardChange,
  decideProposal,
  PROPOSAL,
  proposalFromChange,
  requestProposalApproval,
} from './standard.js';
import { isManualNext } from './transitions.js';
import { cmdbOf } from './util.js';

const AGENT = ['itil', 'change_manager', 'sn_change_write'];
const MANAGER = ['change_manager', 'admin'];
const CAB_MANAGER = ['change_manager', 'sn_change_cab.cab_manager', 'admin'];

/** Runs an action body and turns business rule aborts into an error result for the form. */
function guarded(fn: UiActionDef['run']): UiActionDef['run'] {
  return (rec, ctx, input) => {
    try {
      return fn(rec, ctx, input);
    } catch (e) {
      if (e instanceof AbortError || e instanceof InvalidError) return { error: e.message };
      throw e;
    }
  };
}

const text = (input: Record<string, unknown>, key: string) => String(input[key] ?? '').trim();
const active = (rec: Rec) => rec.bool('active');
const stateIs = (rec: Rec, ...states: number[]) => states.includes(rec.num('state') ?? Number.NaN);

function moveTo(ctx: Context, rec: Rec, state: number, extra: Record<string, unknown> = {}): Rec {
  ctx.update(rec, { state, ...extra });
  return ctx.elevated().get(T.change, rec.sysId) ?? rec;
}

function stateMessage(rec: Rec): string {
  return `${rec.str('number')} is now ${stateLabel(rec.num('state'))}`;
}

const changeActions: UiActionDef[] = [
  {
    id: 'change.request_approval',
    table: T.change,
    label: 'Request approval',
    actionName: 'state_model_request_approval',
    style: 'primary',
    order: 10,
    roles: AGENT,
    condition: (rec, ctx) =>
      active(rec) &&
      !rec.bool('on_hold') &&
      !['requested', 'approved'].includes(rec.str('approval')) &&
      requestApprovalTarget(ctx, rec) !== null,
    run: guarded((rec, ctx) => {
      const target = requestApprovalTarget(ctx, rec);
      if (target === null) return { error: 'Approval cannot be requested in this state' };
      const after = moveTo(ctx, rec, target);
      if (after.num('state') === STATE.SCHEDULED)
        return { message: `${after.str('number')} is pre-approved and now Scheduled` };
      return { message: `Approval requested: ${stateMessage(after)}` };
    }),
  },
  {
    id: 'change.approve',
    table: T.change,
    label: 'Approve',
    style: 'primary',
    order: 12,
    condition: (rec, ctx) =>
      active(rec) &&
      !rec.bool('on_hold') &&
      APPROVAL_STATES.includes(rec.num('state') ?? 0) &&
      (usesFallbackApprovals(ctx) ? canDecideDirectly(ctx) : !!pendingApprovalFor(ctx, rec.sysId)),
    prompt: [{ field: 'work_notes', label: 'Comments', mandatory: false }],
    run: guarded((rec, ctx, input) => {
      const comments = text(input, 'work_notes');
      const after = usesFallbackApprovals(ctx)
        ? directDecision(ctx, rec, 'approved', comments)
        : decideAsApprover(ctx, rec, 'approved', comments);
      return { message: `Approved: ${stateMessage(after)}` };
    }),
  },
  {
    id: 'change.reject',
    table: T.change,
    label: 'Reject',
    style: 'destructive',
    order: 13,
    condition: (rec, ctx) =>
      active(rec) &&
      !rec.bool('on_hold') &&
      APPROVAL_STATES.includes(rec.num('state') ?? 0) &&
      (usesFallbackApprovals(ctx) ? canDecideDirectly(ctx) : !!pendingApprovalFor(ctx, rec.sysId)),
    prompt: [{ field: 'work_notes', label: 'Rejection reason', mandatory: true }],
    run: guarded((rec, ctx, input) => {
      const comments = text(input, 'work_notes');
      const after = usesFallbackApprovals(ctx)
        ? directDecision(ctx, rec, 'rejected', comments)
        : decideAsApprover(ctx, rec, 'rejected', comments);
      return { message: `Rejected: ${stateMessage(after)}` };
    }),
  },
  {
    id: 'change.revert',
    table: T.change,
    label: 'Revert to New',
    actionName: 'state_model_move_to_new',
    order: 20,
    roles: AGENT,
    condition: (rec, ctx) =>
      active(rec) && APPROVAL_STATES.includes(rec.num('state') ?? 0) && isManualNext(ctx, rec, STATE.NEW),
    confirm: 'Revert this change to New? Pending approvals are canceled.',
    run: guarded((rec, ctx) => ({ message: stateMessage(moveTo(ctx, rec, STATE.NEW)) })),
  },
  {
    id: 'change.implement',
    table: T.change,
    label: 'Implement',
    actionName: 'state_model_move_to_implement',
    style: 'primary',
    order: 30,
    roles: AGENT,
    condition: (rec, ctx) =>
      stateIs(rec, STATE.SCHEDULED) && !rec.bool('on_hold') && isManualNext(ctx, rec, STATE.IMPLEMENT),
    run: guarded((rec, ctx) => ({ message: stateMessage(moveTo(ctx, rec, STATE.IMPLEMENT)) })),
  },
  {
    id: 'change.review',
    table: T.change,
    label: 'Review',
    actionName: 'state_model_move_to_review',
    style: 'primary',
    order: 40,
    roles: AGENT,
    condition: (rec, ctx) =>
      stateIs(rec, STATE.IMPLEMENT) && !rec.bool('on_hold') && isManualNext(ctx, rec, STATE.REVIEW),
    run: guarded((rec, ctx) => ({ message: stateMessage(moveTo(ctx, rec, STATE.REVIEW)) })),
  },
  {
    id: 'change.close',
    table: T.change,
    label: 'Close',
    actionName: 'state_model_move_to_closed',
    style: 'primary',
    order: 50,
    roles: AGENT,
    condition: (rec, ctx) => stateIs(rec, STATE.REVIEW) && isManualNext(ctx, rec, STATE.CLOSED),
    prompt: [
      { field: 'close_code', mandatory: true },
      { field: 'close_notes', mandatory: true },
      { field: 'review_comments', label: 'Post-implementation review comments', mandatory: false },
    ],
    run: guarded((rec, ctx, input) => {
      const extra: Record<string, unknown> = {
        close_code: text(input, 'close_code'),
        close_notes: text(input, 'close_notes'),
      };
      if (text(input, 'review_comments')) extra.review_comments = text(input, 'review_comments');
      return { message: stateMessage(moveTo(ctx, rec, STATE.CLOSED, extra)) };
    }),
  },
  {
    id: 'change.cancel',
    table: T.change,
    label: 'Cancel change',
    actionName: 'state_model_move_to_canceled',
    style: 'destructive',
    order: 90,
    roles: AGENT,
    condition: (rec, ctx) => active(rec) && isManualNext(ctx, rec, STATE.CANCELED),
    prompt: [{ field: 'work_notes', label: 'Reason for canceling', mandatory: true }],
    run: guarded((rec, ctx, input) => {
      const after = moveTo(ctx, rec, STATE.CANCELED, {
        work_notes: `Change canceled: ${text(input, 'work_notes')}`,
      });
      return { message: stateMessage(after) };
    }),
  },
  {
    id: 'change.hold',
    table: T.change,
    label: 'Put on hold',
    order: 60,
    roles: AGENT,
    condition: (rec) => active(rec) && !rec.bool('on_hold'),
    prompt: [{ field: 'on_hold_reason', mandatory: true }],
    run: guarded((rec, ctx, input) => {
      ctx.update(rec, { on_hold: true, on_hold_reason: text(input, 'on_hold_reason') });
      return { message: `${rec.str('number')} is on hold` };
    }),
  },
  {
    id: 'change.release',
    table: T.change,
    label: 'Release hold',
    order: 61,
    roles: AGENT,
    condition: (rec) => active(rec) && rec.bool('on_hold'),
    run: guarded((rec, ctx) => {
      ctx.update(rec, { on_hold: false, on_hold_reason: '' });
      return { message: `${rec.str('number')} is no longer on hold` };
    }),
  },
  {
    id: 'change.check_conflicts',
    table: T.change,
    label: 'Check conflicts',
    order: 70,
    roles: AGENT,
    condition: (rec) => active(rec) && conflictPrecondition(rec) === null,
    run: guarded((rec, ctx) => {
      const run = runConflictDetection(ctx, rec.sysId);
      return {
        message: run.conflicts.length ? `${run.conflicts.length} conflict(s) found` : 'No conflicts found',
      };
    }),
  },
  {
    id: 'change.calculate_risk',
    table: T.change,
    label: 'Calculate risk',
    order: 71,
    roles: ['itil', 'change_manager', 'admin'],
    condition: (rec, ctx) =>
      active(rec) && ctx.platform.properties.get(PROP.riskRule, 'ui_action') !== 'none',
    run: guarded((rec, ctx) => {
      const outcome = applyRisk(ctx, rec);
      const risk = outcome.risk ? ctx.choiceLabel(T.change, 'risk', String(outcome.risk)) : null;
      return { message: [risk ? `Risk set to ${risk}` : '', ...outcome.messages].filter(Boolean).join('. ') };
    }),
  },
  {
    id: 'change.clear_unauthorized',
    table: T.change,
    label: 'Clear unauthorized flag',
    order: 80,
    roles: MANAGER,
    condition: (rec) => rec.bool('unauthorized') && active(rec),
    prompt: [{ field: 'work_notes', label: 'Why is this change authorized?', mandatory: true }],
    run: guarded((rec, ctx, input) => {
      ctx.update(rec, {
        unauthorized: false,
        work_notes: `Unauthorized flag cleared: ${text(input, 'work_notes')}`,
      });
      return { message: `${rec.str('number')} is no longer flagged as unauthorized` };
    }),
  },
  {
    id: 'change.refresh_impacted_services',
    table: T.change,
    label: 'Refresh impacted services',
    order: 85,
    roles: AGENT,
    condition: (rec, ctx) => active(rec) && !!rec.str('cmdb_ci') && !!cmdbOf(ctx.platform),
    run: guarded((rec, ctx) => ({
      message: `${refreshImpactedServices(ctx, rec)} impacted service(s) linked`,
    })),
  },
  {
    id: 'change.propose_standard',
    table: T.change,
    label: 'Propose standard change template',
    order: 95,
    roles: AGENT,
    condition: (rec) => rec.str('type') !== 'standard' && rec.str('chg_model') !== MODEL_IDS.unauthorized,
    run: guarded((rec, ctx) => {
      const proposal = proposalFromChange(ctx, rec);
      return {
        message: `Proposal ${proposal.str('number')} created`,
        redirect: `/workspace/record/${T.proposal}/${proposal.sysId}`,
        record: { table: T.proposal, sys_id: proposal.sysId },
      };
    }),
  },
];

const taskActions: UiActionDef[] = [
  {
    id: 'change_task.start',
    table: T.task,
    label: 'Start work',
    style: 'primary',
    order: 10,
    roles: AGENT,
    condition: (rec) => active(rec) && stateIs(rec, TASK_STATE.PENDING, TASK_STATE.OPEN),
    run: guarded((rec, ctx) => {
      ctx.update(rec, { state: TASK_STATE.IN_PROGRESS });
      return { message: `${rec.str('number')} is in progress` };
    }),
  },
  {
    id: 'change_task.close',
    table: T.task,
    label: 'Close task',
    style: 'primary',
    order: 20,
    roles: AGENT,
    condition: (rec) => active(rec),
    prompt: [
      { field: 'close_code', mandatory: true },
      { field: 'close_notes', mandatory: true },
    ],
    run: guarded((rec, ctx, input) => {
      ctx.update(rec, {
        state: TASK_STATE.CLOSED,
        close_code: text(input, 'close_code'),
        close_notes: text(input, 'close_notes'),
      });
      return { message: `${rec.str('number')} closed` };
    }),
  },
  {
    id: 'change_task.cancel',
    table: T.task,
    label: 'Cancel task',
    style: 'destructive',
    order: 30,
    roles: AGENT,
    condition: (rec) => active(rec),
    prompt: [{ field: 'work_notes', label: 'Reason for canceling', mandatory: true }],
    run: guarded((rec, ctx, input) => {
      ctx.update(rec, {
        state: TASK_STATE.CANCELED,
        work_notes: `Task canceled: ${text(input, 'work_notes')}`,
      });
      return { message: `${rec.str('number')} canceled` };
    }),
  },
];

const cabActions: UiActionDef[] = [
  {
    id: 'cab_meeting.refresh_agenda',
    table: T.cabMeeting,
    label: 'Refresh agenda',
    style: 'primary',
    order: 10,
    roles: CAB_MANAGER,
    condition: 'stateINpending,in_progress',
    run: guarded((rec, ctx) => ({ message: `${refreshAgenda(ctx, rec)} change(s) added to the agenda` })),
  },
  {
    id: 'cab_meeting.start',
    table: T.cabMeeting,
    label: 'Start meeting',
    order: 20,
    roles: CAB_MANAGER,
    condition: 'state=pending',
    run: guarded((rec, ctx) => {
      setMeetingState(ctx, rec, 'in_progress');
      return { message: 'Meeting started' };
    }),
  },
  {
    id: 'cab_meeting.end',
    table: T.cabMeeting,
    label: 'End meeting',
    order: 30,
    roles: CAB_MANAGER,
    condition: 'state=in_progress',
    run: guarded((rec, ctx) => {
      setMeetingState(ctx, rec, 'complete');
      return { message: 'Meeting ended' };
    }),
  },
  {
    id: 'cab_meeting.cancel',
    table: T.cabMeeting,
    label: 'Cancel meeting',
    style: 'destructive',
    order: 40,
    roles: CAB_MANAGER,
    condition: 'state=pending',
    confirm: 'Cancel this CAB meeting?',
    run: guarded((rec, ctx) => {
      setMeetingState(ctx, rec, 'canceled');
      return { message: 'Meeting canceled' };
    }),
  },
];

const standardActions: UiActionDef[] = [
  {
    id: 'std_change.create_change',
    table: T.producer,
    label: 'Create standard change',
    style: 'primary',
    order: 10,
    roles: AGENT,
    list: true,
    condition: 'active=true^retired!=true',
    run: guarded((rec, ctx) => {
      const { change } = createStandardChange(ctx, rec.sysId);
      return {
        message: `${change.str('number')} created from "${rec.str('name')}"`,
        redirect: `/workspace/record/${T.change}/${change.sysId}`,
        record: { table: T.change, sys_id: change.sysId },
      };
    }),
  },
  {
    id: 'std_change_proposal.request_approval',
    table: T.proposal,
    label: 'Request approval',
    style: 'primary',
    order: 10,
    roles: AGENT,
    condition: `state=${PROPOSAL.NEW}`,
    run: guarded((rec, ctx) => {
      const after = requestProposalApproval(ctx, rec);
      return { message: `Proposal is ${after.display('state')}` };
    }),
  },
  {
    id: 'std_change_proposal.approve',
    table: T.proposal,
    label: 'Approve proposal',
    style: 'primary',
    order: 20,
    roles: MANAGER,
    condition: (rec, ctx) => rec.num('state') === PROPOSAL.IN_PROGRESS && usesFallbackApprovals(ctx),
    run: guarded((rec, ctx) => {
      decideProposal(ctx, rec, 'approved');
      return { message: 'Proposal approved and template published' };
    }),
  },
  {
    id: 'std_change_proposal.reject',
    table: T.proposal,
    label: 'Reject proposal',
    style: 'destructive',
    order: 21,
    roles: MANAGER,
    condition: (rec, ctx) => rec.num('state') === PROPOSAL.IN_PROGRESS && usesFallbackApprovals(ctx),
    prompt: [{ field: 'work_notes', label: 'Rejection reason', mandatory: true }],
    run: guarded((rec, ctx, input) => {
      decideProposal(ctx, rec, 'rejected', text(input, 'work_notes'));
      return { message: 'Proposal rejected' };
    }),
  },
];

/** New change form preset with a model (the type is shown before the first save). */
const createRoute = (modelId: string, type: string) =>
  `/workspace/record/${T.change}/-1?sysparm_query=chg_model=${modelId}^type=${type}`;

export const changeUi: ModuleUiDef = {
  navigation: [
    {
      id: 'change',
      title: 'Change',
      icon: 'git-pull-request',
      roles: ['itil', 'change_manager', 'sn_change_read'],
      order: 40,
      modules: [
        { title: 'Create New - Normal', route: createRoute(MODEL_IDS.normal, 'normal'), roles: AGENT },
        {
          title: 'Create New - Emergency',
          route: createRoute(MODEL_IDS.emergency, 'emergency'),
          roles: AGENT,
        },
        {
          title: 'Create New - Standard',
          table: T.producer,
          query: 'active=true^retired!=true^ORDERBYname',
          roles: AGENT,
        },
        { title: 'Open', table: T.change, query: 'active=true^ORDERBYDESCnumber' },
        {
          title: 'Assigned to me',
          table: T.change,
          query: 'active=true^assigned_to=javascript:gs.getUserID()^ORDERBYstart_date',
        },
        {
          title: 'Awaiting approval',
          table: T.change,
          query: 'active=true^approval=requested^ORDERBYstart_date',
        },
        { title: 'Scheduled', table: T.change, query: `state=${STATE.SCHEDULED}^ORDERBYstart_date` },
        { title: 'In review', table: T.change, query: `state=${STATE.REVIEW}^ORDERBYstart_date` },
        { title: 'Change tasks', table: T.task, query: 'active=true^ORDERBYplanned_start_date' },
        { title: 'Change schedule', route: '/workspace/change-schedule' },
        { title: 'CAB meetings', table: T.cabMeeting, query: 'ORDERBYDESCstart' },
        {
          title: 'Standard change catalog',
          table: T.producer,
          query: 'active=true^retired!=true^ORDERBYname',
        },
        { title: 'Standard change proposals', table: T.proposal, query: 'ORDERBYDESCnumber' },
        { title: 'All changes', table: T.change, query: 'ORDERBYDESCnumber' },
        {
          title: 'Blackout schedules',
          table: T.blackout,
          separator: true,
          roles: ['change_manager', 'itil_admin', 'admin'],
        },
        {
          title: 'Maintenance schedules',
          table: T.maintenance,
          roles: ['change_manager', 'itil_admin', 'admin'],
        },
        { title: 'Change models', table: T.model, query: 'ORDERBYname', roles: ['change_manager', 'admin'] },
        {
          title: 'Risk conditions',
          table: T.riskCondition,
          query: 'ORDERBYorder',
          roles: ['change_manager', 'itil_admin', 'admin'],
        },
        { title: 'Risk assessments', table: T.assessment, roles: ['change_manager', 'itil_admin', 'admin'] },
        {
          title: 'Pipeline change gates',
          table: T.pipeline,
          query: 'ORDERBYDESCsys_created_on',
          roles: ['change_manager', 'admin'],
        },
      ],
    },
  ],
  lists: [
    {
      table: T.change,
      columns: [
        'number',
        'short_description',
        'type',
        'state',
        'risk',
        'approval',
        'assignment_group',
        'assigned_to',
        'start_date',
        'end_date',
      ],
    },
    {
      table: T.task,
      columns: [
        'number',
        'short_description',
        'change_request',
        'change_task_type',
        'state',
        'assignment_group',
        'assigned_to',
        'planned_start_date',
      ],
    },
    {
      table: T.conflict,
      columns: [
        'type',
        'conflicting_change',
        'configuration_item',
        'schedule',
        'category',
        'resolvr_description',
        'last_checked',
      ],
    },
    {
      table: T.model,
      columns: ['name', 'itil_change_process', 'active', 'default_change_model', 'available_in_ui', 'color'],
    },
    { table: T.state, columns: ['label', 'state', 'initial_state', 'order', 'active'] },
    { table: T.transition, columns: ['name', 'from_state', 'to_state', 'automatic_transition', 'active'] },
    { table: T.cabMeeting, columns: ['name', 'start', 'end', 'state', 'manager'] },
    { table: T.agendaItem, columns: ['order', 'task', 'short_description', 'state', 'decision'] },
    { table: T.attendee, columns: ['attendee', 'attendee_type', 'response'] },
    { table: T.producer, columns: ['name', 'short_description', 'category', 'current_version', 'active'] },
    {
      table: T.version,
      columns: ['name', 'version', 'successful_count', 'unsuccessful_count', 'successful_pct'],
    },
    {
      table: T.proposal,
      columns: ['number', 'short_description', 'type', 'state', 'requested_by', 'std_change_producer'],
    },
    { table: T.riskCondition, columns: ['order', 'name', 'risk', 'impact', 'active'] },
    { table: T.question, columns: ['order', 'question', 'weight', 'mandatory', 'active'] },
    { table: T.result, columns: ['risk_assessment', 'score', 'risk', 'taken_by', 'taken_on'] },
    { table: T.blackout, columns: ['name', 'category', 'source', 'applies_to', 'time_zone'] },
    { table: T.maintenance, columns: ['name', 'category', 'source', 'applies_to', 'time_zone'] },
    {
      table: T.pipeline,
      columns: ['pipeline', 'build', 'commit', 'change_request', 'status', 'decision', 'sys_created_on'],
    },
    { table: T.worker, columns: ['type', 'state', 'task', 'started_at', 'completed_at'] },
  ],
  forms: [
    {
      table: T.task,
      highlights: ['state', 'change_task_type', 'assigned_to'],
      sections: [
        {
          left: ['number', 'change_request', 'change_task_type', 'cmdb_ci', 'created_from'],
          right: ['state', 'assignment_group', 'assigned_to', 'planned_start_date', 'planned_end_date'],
        },
        { fields: ['short_description', 'description'] },
        { caption: 'Hold', left: ['on_hold'], right: ['on_hold_reason'] },
        { caption: 'Closure', left: ['close_code', 'work_start', 'work_end'], right: ['close_notes'] },
        { caption: 'Notes', fields: ['comments', 'work_notes'] },
      ],
    },
    {
      table: T.cabMeeting,
      highlights: ['state', 'start', 'manager'],
      sections: [
        { left: ['name', 'manager', 'host', 'state'], right: ['start', 'end', 'conference_details'] },
        {
          caption: 'Agenda selection',
          left: ['changes_start_after', 'changes_start_on_or_before', 'use_filter_dates'],
          right: ['change_condition', 'complete_preapproved', 'auto_add_agenda_decisions'],
        },
        {
          caption: 'Board',
          left: ['board_members', 'delegates'],
          right: ['board_groups', 'time_per_agenda_item'],
        },
        { fields: ['meeting_notes'] },
      ],
      relatedLists: [
        { table: T.agendaItem, field: 'meeting', label: 'Agenda items' },
        { table: T.attendee, field: 'meeting', label: 'Attendees' },
      ],
    },
    {
      table: T.producer,
      highlights: ['category', 'current_version', 'active'],
      sections: [
        { left: ['name', 'category', 'template'], right: ['active', 'retired', 'current_version'] },
        { fields: ['short_description', 'description'] },
      ],
      relatedLists: [{ table: T.version, field: 'std_change_producer', label: 'Versions' }],
    },
    {
      table: T.proposal,
      highlights: ['state', 'type', 'approval'],
      sections: [
        {
          left: ['number', 'type', 'requested_by', 'category'],
          right: ['state', 'approval', 'std_change_producer', 'assignment_group'],
        },
        { fields: ['short_description', 'description', 'business_justification', 'template_value'] },
        { caption: 'Notes', fields: ['comments', 'work_notes'] },
      ],
      relatedLists: [{ table: T.taskTemplate, field: 'std_change_proposal', label: 'Change task templates' }],
    },
    {
      table: T.model,
      highlights: ['itil_change_process', 'active'],
      sections: [
        {
          left: ['name', 'itil_change_process', 'color', 'record_preset'],
          right: ['active', 'default_change_model', 'available_in_ui', 'implementation_states'],
        },
        { fields: ['description'] },
      ],
      relatedLists: [
        { table: T.state, field: 'model', label: 'States' },
        { table: T.transition, field: 'model', label: 'Transitions' },
      ],
    },
    {
      table: T.transition,
      sections: [
        {
          left: ['name', 'model', 'from_state', 'to_state'],
          right: ['automatic_transition', 'active', 'order'],
        },
      ],
      relatedLists: [{ table: T.transitionCondition, field: 'state_transition', label: 'Conditions' }],
    },
    {
      table: T.state,
      sections: [{ left: ['label', 'model', 'state'], right: ['initial_state', 'order', 'active'] }],
      relatedLists: [
        { table: T.fieldPolicy, field: 'model_state', label: 'Field policies' },
        { table: T.stateAttribute, field: 'model_state', label: 'Attributes' },
      ],
    },
    {
      table: T.assessment,
      sections: [
        { left: ['name', 'state', 'category_weight'], right: ['condition'] },
        { fields: ['description'] },
      ],
      relatedLists: [
        { table: T.question, field: 'risk_assessment', label: 'Questions' },
        { table: T.threshold, field: 'risk_assessment', label: 'Thresholds' },
      ],
    },
    {
      table: T.blackout,
      sections: [
        {
          left: ['name', 'category', 'source', 'applies_to'],
          right: ['time_zone', 'assignment_group', 'assigned_to'],
        },
        { fields: ['condition', 'description'] },
      ],
      relatedLists: [{ table: T.span, field: 'schedule', label: 'Schedule entries' }],
    },
    {
      table: T.maintenance,
      sections: [
        {
          left: ['name', 'category', 'source', 'applies_to'],
          right: ['time_zone', 'assignment_group', 'assigned_to'],
        },
        { fields: ['condition', 'description'] },
      ],
      relatedLists: [{ table: T.span, field: 'schedule', label: 'Schedule entries' }],
    },
  ],
  uiActions: [...changeActions, ...taskActions, ...cabActions, ...standardActions],
  uiPolicies: [
    {
      id: 'change_request.plans_at_assess',
      table: T.change,
      name: 'Backout and test plans are mandatory while a normal change is assessed',
      condition: `type=normal^state=${STATE.ASSESS}`,
      onLoad: true,
      reverseIfFalse: true,
      actions: [
        { field: 'backout_plan', mandatory: true },
        { field: 'test_plan', mandatory: true },
      ],
    },
    {
      id: 'change_request.planning_read_only',
      table: T.change,
      name: 'Planning is read-only once the change is authorized',
      condition: `type!=standard^stateIN${STATE.AUTHORIZE},${STATE.SCHEDULED},${STATE.IMPLEMENT},${STATE.REVIEW},${STATE.CLOSED},${STATE.CANCELED}`,
      onLoad: true,
      reverseIfFalse: true,
      actions: [
        'description',
        'justification',
        'implementation_plan',
        'risk_impact_analysis',
        'backout_plan',
        'test_plan',
      ].map((field) => ({
        field,
        readOnly: true,
      })),
    },
    {
      id: 'change_request.ci_read_only',
      table: T.change,
      name: 'Configuration item can only change while the change is New',
      condition: `state!=${STATE.NEW}^unauthorized!=true`,
      onLoad: true,
      reverseIfFalse: true,
      actions: [{ field: 'cmdb_ci', readOnly: true }],
    },
    {
      id: 'change_request.on_hold_reason',
      table: T.change,
      name: 'On hold reason is mandatory when the change is on hold',
      condition: 'on_hold=true',
      onLoad: true,
      reverseIfFalse: true,
      actions: [{ field: 'on_hold_reason', mandatory: true, visible: true }],
    },
    {
      id: 'change_request.unauthorized_emergency_only',
      table: T.change,
      name: 'Unauthorized flag is shown for emergency changes only',
      condition: 'type=emergency',
      onLoad: true,
      reverseIfFalse: true,
      actions: [{ field: 'unauthorized', visible: true }],
    },
    {
      id: 'change_request.cab_fields',
      table: T.change,
      name: 'CAB fields are shown for normal and emergency changes',
      condition: 'type!=standard',
      onLoad: true,
      reverseIfFalse: true,
      actions: ['cab_required', 'cab_date', 'cab_delegate', 'cab_recommendation'].map((field) => ({
        field,
        visible: true,
      })),
    },
    {
      id: 'change_request.closure_fields',
      table: T.change,
      name: 'Closure and review fields are shown from Review onwards',
      condition: `stateIN${STATE.REVIEW},${STATE.CLOSED},${STATE.CANCELED}`,
      onLoad: true,
      reverseIfFalse: true,
      actions: ['close_code', 'close_notes', 'review_status', 'review_date', 'review_comments'].map(
        (field) => ({ field, visible: true }),
      ),
    },
    {
      id: 'change_request.close_mandatory',
      table: T.change,
      name: 'Close code and close notes are mandatory to close a change',
      condition: `state=${STATE.CLOSED}`,
      onLoad: true,
      reverseIfFalse: true,
      actions: [
        { field: 'close_code', mandatory: true },
        { field: 'close_notes', mandatory: true },
      ],
    },
    {
      id: 'change_task.close_mandatory',
      table: T.task,
      name: 'Close code and close notes are mandatory to close a change task',
      condition: `state=${TASK_STATE.CLOSED}`,
      onLoad: true,
      reverseIfFalse: true,
      actions: [
        { field: 'close_code', mandatory: true },
        { field: 'close_notes', mandatory: true },
      ],
    },
    {
      id: 'change_task.on_hold_reason',
      table: T.task,
      name: 'On hold reason is mandatory when the change task is on hold',
      condition: 'on_hold=true',
      onLoad: true,
      reverseIfFalse: true,
      actions: [{ field: 'on_hold_reason', mandatory: true, visible: true }],
    },
  ],
};

/**
 * The change form, including related lists for tables owned by optional modules only when
 * those tables exist (approvals, impacted services).
 */
export function changeForm(platform: Platform): FormLayoutDef {
  const has = (t: string) => platform.registry.has(t);
  return {
    table: T.change,
    highlights: ['type', 'risk', 'state', 'approval'],
    sections: [
      {
        left: ['number', 'requested_by', 'category', 'business_service', 'cmdb_ci', 'chg_model', 'type'],
        right: ['state', 'approval', 'risk', 'impact', 'priority', 'assignment_group', 'assigned_to'],
      },
      { fields: ['short_description', 'description'] },
      {
        caption: 'Planning',
        fields: ['justification', 'implementation_plan', 'risk_impact_analysis', 'backout_plan', 'test_plan'],
      },
      {
        caption: 'Schedule',
        left: ['start_date', 'end_date', 'requested_by_date', 'work_start', 'work_end'],
        right: ['cab_required', 'cab_date', 'cab_delegate', 'cab_recommendation', 'change_manager'],
      },
      {
        caption: 'Conflicts',
        left: ['conflict_status', 'conflict_last_run'],
        right: ['exclude_from_conflict_detection', 'outside_maintenance_schedule'],
      },
      { caption: 'On hold', left: ['on_hold'], right: ['on_hold_reason'] },
      {
        caption: 'Closure and review',
        left: ['close_code', 'review_status', 'review_date'],
        right: ['unauthorized', 'std_change_producer_version', 'close_notes', 'review_comments'],
      },
      { caption: 'Notes', fields: ['watch_list', 'comments', 'work_notes'] },
    ],
    relatedLists: [
      { table: T.task, field: 'change_request', label: 'Change Tasks' },
      {
        table: T.taskCi,
        field: 'task',
        label: 'Affected CIs',
        columns: ['ci_item', 'manual_proposed_change', 'applied'],
      },
      ...(has(T.approval) ? [{ table: T.approval, field: 'document_id', label: 'Approvers' }] : []),
      { table: T.conflict, field: 'change', label: 'Conflicts' },
      {
        table: T.taskService,
        field: 'task',
        label: 'Impacted Services/CIs',
        columns: ['cmdb_ci_service', 'manually_added'],
      },
      {
        table: T.agendaItem,
        field: 'task',
        label: 'CAB Agenda Items',
        columns: ['meeting', 'state', 'decision'],
      },
      { table: T.result, field: 'change', label: 'Risk Assessments' },
    ],
  };
}
