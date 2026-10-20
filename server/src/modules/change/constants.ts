import { createHash } from 'node:crypto';
import type { ChoiceDef } from '../../engine/types.js';

/** Table names used throughout the change module. */
export const T = {
  change: 'change_request',
  task: 'change_task',
  model: 'chg_model',
  state: 'sttrm_state',
  transition: 'sttrm_state_transition',
  conditionType: 'sttrm_condition_type',
  transitionCondition: 'sttrm_transition_condition',
  fieldPolicy: 'sttrm_state_field_policy',
  attribute: 'sttrm_attribute',
  stateAttribute: 'sttrm_state_attribute',
  conflict: 'conflict',
  worker: 'chg_mgt_worker',
  riskCondition: 'risk_conditions',
  assessment: 'change_risk_asmt',
  question: 'change_risk_asmt_question',
  threshold: 'change_risk_asmt_threshold',
  result: 'change_risk_asmt_result',
  riskLookup: 'sn_chg_probability_risk_lookup',
  producer: 'std_change_record_producer',
  version: 'std_change_producer_version',
  stdTemplate: 'std_change_template',
  taskTemplate: 'std_change_task_template',
  proposal: 'std_change_proposal',
  stdProperties: 'std_change_properties',
  cabDefinition: 'cab_definition',
  cabMeeting: 'cab_meeting',
  agendaItem: 'cab_agenda_item',
  attendee: 'cab_attendee',
  schedule: 'cmn_schedule',
  span: 'cmn_schedule_span',
  conditionSchedule: 'cmn_schedule_condition',
  blackout: 'cmn_schedule_blackout',
  maintenance: 'cmn_schedule_maintenance',
  information: 'cmn_schedule_information',
  taskCi: 'task_ci',
  taskService: 'task_cmdb_ci_service',
  taskOffering: 'task_service_offering',
  approval: 'sysapproval_approver',
  pipeline: 'resolvr_change_pipeline',
} as const;

/** Change request states (stored integers). */
export const STATE = {
  NEW: -5,
  ASSESS: -4,
  AUTHORIZE: -3,
  SCHEDULED: -2,
  IMPLEMENT: -1,
  REVIEW: 0,
  CLOSED: 3,
  CANCELED: 4,
} as const;

export const STATE_LABEL: Record<string, string> = {
  '-5': 'New',
  '-4': 'Assess',
  '-3': 'Authorize',
  '-2': 'Scheduled',
  '-1': 'Implement',
  '0': 'Review',
  '3': 'Closed',
  '4': 'Canceled',
};

export const TERMINAL_STATES: readonly number[] = [STATE.CLOSED, STATE.CANCELED];
/** States whose entry opens an approval stage. */
export const APPROVAL_STATES: readonly number[] = [STATE.ASSESS, STATE.AUTHORIZE];

/** State handler names accepted by the REST API (`new` is an alias of `draft`). */
export const STATE_NAMES: Record<string, number> = {
  draft: STATE.NEW,
  new: STATE.NEW,
  assess: STATE.ASSESS,
  authorize: STATE.AUTHORIZE,
  scheduled: STATE.SCHEDULED,
  implement: STATE.IMPLEMENT,
  review: STATE.REVIEW,
  closed: STATE.CLOSED,
  canceled: STATE.CANCELED,
  cancelled: STATE.CANCELED,
};

export function stateLabel(state: number | string | null | undefined): string {
  if (state === null || state === undefined || state === '') return '(empty)';
  return STATE_LABEL[String(state)] ?? String(state);
}

/** Parses a state given as a number, numeric string, handler name or label. */
export function parseChangeState(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).trim();
  if (/^-?\d+(\.0+)?$/.test(s)) return Math.trunc(Number(s));
  const byName = STATE_NAMES[s.toLowerCase()];
  if (byName !== undefined) return byName;
  const byLabel = Object.entries(STATE_LABEL).find(([, l]) => l.toLowerCase() === s.toLowerCase());
  return byLabel ? Number(byLabel[0]) : null;
}

/** Change task states. */
export const TASK_STATE = { PENDING: -5, OPEN: 1, IN_PROGRESS: 2, CLOSED: 3, CANCELED: 4 } as const;
export const TASK_TERMINAL: readonly number[] = [TASK_STATE.CLOSED, TASK_STATE.CANCELED];

export const RISK = { VERY_HIGH: 1, HIGH: 2, MODERATE: 3, LOW: 4 } as const;
export const RISK_LABEL: Record<string, string> = {
  '1': 'Very High',
  '2': 'High',
  '3': 'Moderate',
  '4': 'Low',
};

/** Accepts 1..4 or a label ("low", "very high") and returns the risk value. */
export function parseRisk(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/^[1-4]$/.test(s)) return Number(s);
  const hit = Object.entries(RISK_LABEL).find(([, l]) => l.toLowerCase() === s);
  if (hit) return Number(hit[0]);
  if (s === 'medium') return RISK.MODERATE;
  if (s === 'critical') return RISK.VERY_HIGH;
  return null;
}

/** Stable sys_ids for seeded records (32 hex characters). */
export function fixedId(key: string): string {
  return createHash('md5').update(`resolvr:change:${key}`).digest('hex');
}

export const MODEL_IDS = {
  normal: fixedId('model:normal'),
  standard: fixedId('model:standard'),
  emergency: fixedId('model:emergency'),
  unauthorized: fixedId('model:unauthorized'),
  registration: fixedId('model:registration'),
} as const;

export const MODEL_NAMES = {
  normal: 'Normal',
  standard: 'Standard',
  emergency: 'Emergency',
  unauthorized: 'Unauthorized Change',
  registration: 'Change Registration',
} as const;

/** Built-in transition condition types evaluated natively. */
export const COND = {
  MANDATORY: 'Mandatory Fields',
  CONDITION: 'Transition Condition',
  SCRIPT: 'Transition Script',
  NO_ACTIVE_TASKS: 'No active Change Tasks',
  NOT_ON_HOLD: 'Not On hold',
  APPROVED: 'Approval approved',
  REJECTED: 'Approval rejected',
  POLICY: 'State Field Policy Managed',
} as const;

export const ATTR = {
  CI_MODIFICATION: 'allow_ci_modification',
  IMPLEMENTATION: 'allow_implementation',
  CONFLICT_DETECTION: 'allow_conflict_detection',
  CHILD_CHANGES: 'allow_child_change_creation',
} as const;

/** Product properties (all under `resolvr.change.`). */
export const PROP = {
  enforceData: 'resolvr.change.enforce_data_requirements',
  riskRule: 'resolvr.change.risk_calculate_rule',
  calculatedRisk: 'resolvr.change.risk.calculated_score',
  cabGroup: 'resolvr.change.cab_group',
  managementGroup: 'resolvr.change.management_group',
  assessApprover: 'resolvr.change.assess_approver',
  implementTasks: 'resolvr.change.implement_tasks',
  reviewNeedsClosedTasks: 'resolvr.change.review_requires_closed_tasks',
  conflictAuto: 'resolvr.change.conflict.auto',
  conflictMode: 'resolvr.change.conflict.mode',
  conflictContiguous: 'resolvr.change.conflict.allow_contiguous_changes',
  conflictCurrentCi: 'resolvr.change.conflict.currentci',
  conflictAssignedTo: 'resolvr.change.conflict.assigned_to',
  conflictBlackout: 'resolvr.change.conflict.blackout',
  conflictMaintenance: 'resolvr.change.conflict.maintenance',
  conflictMaxCount: 'resolvr.change.conflict.max_count',
  slotWindowDays: 'resolvr.change.next_available.schedule_window',
  slotLimit: 'resolvr.change.next_available.choice_limit',
  slotStepMinutes: 'resolvr.change.next_available.step_minutes',
  unauthorizedEnabled: 'resolvr.change.unauthorized.enabled',
  unauthorizedIgnoreHours: 'resolvr.change.unauthorized.ignore_period_hours',
  unauthorizedValidQuery: 'resolvr.change.unauthorized.valid_change_query',
  stateEventEnabled: 'resolvr.change.event.state_updated.enabled',
  stateEventStates: 'resolvr.change.event.state_updated.states',
  notifyStateChange: 'resolvr.change.notify_state_change',
  pipelineTemplate: 'resolvr.change.pipeline.default_template',
  pipelineGroup: 'resolvr.change.pipeline.assignment_group',
  calendarWindowDays: 'resolvr.change.calendar.max_range_days',
} as const;

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });
const list = (pairs: [string, string][]): ChoiceDef[] => pairs.map(([v, l], i) => c(v, l, i + 1));

export const CHOICES = {
  state: list([
    ['-5', 'New'],
    ['-4', 'Assess'],
    ['-3', 'Authorize'],
    ['-2', 'Scheduled'],
    ['-1', 'Implement'],
    ['0', 'Review'],
    ['3', 'Closed'],
    ['4', 'Canceled'],
  ]),
  type: list([
    ['standard', 'Standard'],
    ['normal', 'Normal'],
    ['emergency', 'Emergency'],
  ]),
  risk: list([
    ['1', 'Very High'],
    ['2', 'High'],
    ['3', 'Moderate'],
    ['4', 'Low'],
  ]),
  impact: list([
    ['1', '1 - High'],
    ['2', '2 - Medium'],
    ['3', '3 - Low'],
  ]),
  closeCode: list([
    ['successful', 'Successful'],
    ['successful_issues', 'Successful with issues'],
    ['unsuccessful', 'Unsuccessful'],
  ]),
  phase: list([
    ['requested', 'Requested'],
    ['plan', 'Plan'],
    ['build', 'Build'],
    ['accept', 'Accept'],
  ]),
  phaseState: list([
    ['open', 'Open'],
    ['requested', 'Requested'],
    ['work in progress', 'Work in Progress'],
    ['on hold', 'On Hold'],
    ['complete', 'Complete'],
    ['rejected', 'Rejected'],
  ]),
  conflictStatus: [
    c('Not Run', 'Not Run', -1),
    c('Conflict', 'Conflict', 0),
    c('No Conflict', 'No Conflict', 1),
  ],
  reviewStatus: list([
    ['1', 'Pending'],
    ['2', 'Successful'],
    ['3', 'Successful with issues'],
    ['4', 'Unsuccessful'],
  ]),
  scope: list([
    ['1', 'Massive'],
    ['2', 'Large'],
    ['3', 'Medium'],
    ['4', 'Small'],
    ['5', 'Tiny'],
  ]),
  reason: list(
    [
      'Business requirements',
      'Hardware upgrade',
      'Legislation',
      'Location change',
      'Network requirements',
      'New or removed CI',
      'Other',
      'Problem resolved',
      'Product or service changed',
      'Software upgrade',
      'User requested',
    ].map((v) => [v, v] as [string, string]),
  ),
  category: list(
    [
      'Hardware',
      'Software',
      'Service',
      'System Software',
      'Applications Software',
      'Network',
      'Telecom',
      'Documentation',
      'DevOps',
      'Other',
    ].map((v) => [v, v] as [string, string]),
  ),
  actionStatus: list([
    ['1', 'Blocked internally'],
    ['2', 'Blocked by customer'],
    ['3', 'Blocked internally and by customer'],
    ['4', 'Needs attention'],
  ]),
  childStatus: list([
    ['in_progress', 'In Progress'],
    ['completed', 'Completed'],
    ['completed_with_errors', 'Completed with errors'],
  ]),
  taskState: list([
    ['-5', 'Pending'],
    ['1', 'Open'],
    ['2', 'In Progress'],
    ['3', 'Closed'],
    ['4', 'Canceled'],
  ]),
  taskType: list([
    ['planning', 'Planning'],
    ['implementation', 'Implementation'],
    ['testing', 'Testing'],
    ['review', 'Review'],
  ]),
  createdFrom: list([
    ['manual', 'Manual'],
    ['workflow', 'Workflow'],
  ]),
  itilProcess: list([
    ['standard', 'Standard'],
    ['normal', 'Normal'],
    ['emergency', 'Emergency'],
  ]),
  templateProposer: list([
    ['modify', 'Anyone who can modify this model'],
    ['read', 'Anyone who can read this model'],
  ]),
  conditionType: list([
    ['mandatory_fields', 'Mandatory Fields'],
    ['condition', 'Condition'],
    ['script', 'Script'],
  ]),
  templateState: list([
    ['draft', 'Draft'],
    ['proposed', 'Proposed'],
    ['published', 'Published'],
    ['pending_retirement', 'Pending Retirement'],
    ['retired', 'Retired'],
  ]),
  proposalState: list([
    ['1', 'New'],
    ['2', 'In Progress'],
    ['3', 'Closed Complete'],
    ['4', 'Closed Incomplete'],
  ]),
  proposalType: list([
    ['1', 'New'],
    ['2', 'Modify'],
    ['3', 'Retire'],
  ]),
  conflictType: list([
    ['ci_already_scheduled', 'CI Already Scheduled'],
    ['parent_ci_already_scheduled', 'Parent CI Already Scheduled'],
    ['child_ci_already_scheduled', 'Child CI Already Scheduled'],
    ['not_in_maintenance_window', 'Not In Maintenance Window'],
    ['parent_not_in_maintenance_window', 'Parent Not In Maintenance Window'],
    ['child_not_in_maintenance_window', 'Child Not In Maintenance Window'],
    ['blackout', 'Blackout'],
    ['assigned_to_already_scheduled', 'Assigned To Already Scheduled'],
    ['inside_change_lockdown', 'Inside Change Lockdown'],
  ]),
  scheduleSource: list([
    ['service', 'Service'],
    ['change_request', 'Change Request'],
    ['ci_class', 'CI Class'],
  ]),
  maintenanceCategory: list([
    ['preventive', 'Preventive'],
    ['patching', 'Patching'],
    ['general', 'General'],
  ]),
  blackoutCategory: list([
    ['hard_freeze', 'Hard Freeze'],
    ['soft_freeze', 'Soft Freeze'],
  ]),
  informationCategory: list([
    ['holiday', 'Holiday'],
    ['global_event', 'Global event'],
    ['organisational_event', 'Organisational event'],
  ]),
  assessmentState: list([
    ['draft', 'Draft'],
    ['published', 'Published'],
  ]),
  successProbability: list([
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ]),
  meetingState: list([
    ['pending', 'Pending'],
    ['in_progress', 'In Progress'],
    ['complete', 'Complete'],
    ['canceled', 'Canceled'],
  ]),
  agendaState: list([
    ['pending', 'Pending'],
    ['in_progress', 'In Progress'],
    ['complete', 'Complete'],
    ['skipped', 'Skipped'],
  ]),
  agendaDecision: list([
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['no_decision', 'No decision'],
  ]),
  attendeeResponse: list([
    ['accept', 'Accept'],
    ['tentative', 'Tentative'],
    ['decline', 'Decline'],
    ['no_response', 'No response'],
  ]),
  attendeeType: list([
    ['manager', 'CAB manager'],
    ['delegate', 'Delegate'],
    ['board_member', 'Board member'],
    ['requester', 'Change requester'],
  ]),
  workerState: list([
    ['1', 'Waiting'],
    ['2', 'In-Progress'],
    ['3', 'Complete'],
    ['4', 'Error'],
  ]),
  workerType: list([
    ['schedule', 'Schedule'],
    ['affected', 'Affected CIs'],
    ['impacted', 'Impacted services'],
    ['offering', 'Service offerings'],
    ['conflict', 'Conflict detection'],
    ['child_changes', 'Child change requests creation'],
  ]),
  pipelineStatus: list([
    ['pending', 'Pending approval'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['canceled', 'Canceled'],
    ['completed', 'Completed'],
  ]),
  pipelineDecision: list([
    ['auto_approved', 'Auto-approved by change policy'],
    ['approval_requested', 'Approval requested'],
  ]),
};
