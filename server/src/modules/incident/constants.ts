/** Incident state values (`incident.state` and its legacy mirror `incident_state`). */
export const INC_STATE = {
  NEW: '1',
  IN_PROGRESS: '2',
  ON_HOLD: '3',
  RESOLVED: '6',
  CLOSED: '7',
  CANCELED: '8',
} as const;

export const HOLD_REASON = {
  CALLER: '1',
  PROBLEM: '3',
  VENDOR: '4',
  CHANGE: '5',
} as const;

export const MIM_STATE = {
  PROPOSED: 'proposed',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELED: 'canceled',
} as const;

export const TASK_STATE = {
  PENDING: '-5',
  OPEN: '1',
  WORK_IN_PROGRESS: '2',
  CLOSED_COMPLETE: '3',
  CLOSED_INCOMPLETE: '4',
  CLOSED_SKIPPED: '7',
} as const;

/** Communication plan (`incident_alert`) and task (`incident_alert_task`) states. */
export const PLAN_STATE = { OPEN: '1', CLOSED: '3', CANCELED: '7' } as const;
export const COMM_TASK_STATE = {
  PENDING: '-5',
  OPEN: '1',
  IN_PROGRESS: '2',
  COMPLETE: '3',
  SKIPPED: '7',
} as const;

export const CLOSE_CODE = {
  KNOWN_ERROR: 'Known error',
  RESOLVED_BY_CALLER: 'Resolved by caller',
  RESOLVED_BY_PROBLEM: 'Resolved by problem',
  NO_RESPONSE: 'Resolved - No response from caller',
} as const;

export const ACTIVE_STATES = [INC_STATE.NEW, INC_STATE.IN_PROGRESS, INC_STATE.ON_HOLD] as const;
export const CLOSED_STATES = [INC_STATE.CLOSED, INC_STATE.CANCELED] as const;

/** Roles that make a user an incident "agent" (admin passes implicitly). */
export const AGENT_ROLES = ['itil', 'sn_incident_write'];
export const READ_ROLES = ['itil', 'sn_incident_read', 'sn_incident_write'];

/** Fields an admin may still change on a closed or canceled incident. */
export const ADMIN_EDITABLE_WHEN_CLOSED = [
  'subcategory',
  'business_service',
  'service_offering',
  'description',
  'contact_type',
  'watch_list',
  'work_notes_list',
  'parent_incident',
  'problem_id',
  'rfc',
  'caused_by',
  'resolved_by',
  'resolved_at',
  'reassignment_count',
];

/** Fields that automation maintains and that never count as a user edit. */
export const SYSTEM_MAINTAINED = ['child_incidents', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count'];

export const PROP = {
  autocloseDays: 'glide.ui.autoclose.time',
  autocloseOnResolvedAt: 'com.snc.incident.autoclose.basedon.resolved_at',
  autocloseBusinessDays: 'resolvr.incident.autoclose.business_days',
  autocloseRunAs: 'resolvr.incident.autoclose.run_as',
  taskClosure: 'com.snc.incident.incident_task.closure',
  strikeCount: 'com.snc.incident.strike.count',
  strikeWait: 'com.snc.incident.strike.wait_period',
  alertClosure: 'com.snc.incident.incident_alert.closure',
  alertTaskClosure: 'com.snc.iam.incident_alert_task.closure',
  copyEnable: 'com.snc.incident.copy.enable',
  childEnable: 'com.snc.incident.create.child.enable',
  copyAttributes: 'com.snc.incident.copy.attributes',
  copyRelatedLists: 'com.snc.incident.copy.related_lists',
  copyTaskCiAttributes: 'com.snc.incident.copy.rl.task_ci.attributes',
  ciGroupField: 'com.snc.incident.ci_assignment_group.field_name',
  offeringGroupField: 'com.snc.incident.service_offering_assignment_group.field_name',
  workaroundToWorkNotes: 'com.snc.incident.communicate_prb_workaround_to_inc_worknotes',
  mimCreation: 'sn_major_inc_mgmt.com.snc.incident.mim.major_incident_creation',
  mimGroup: 'sn_major_inc_mgmt.major_incident_management_group',
  mimCopyAttributes: 'sn_major_inc_mgmt.com.snc.major_incident.create.copy.attributes',
  assignMovesToInProgress: 'resolvr.incident.assign_moves_to_in_progress',
  businessSchedule: 'resolvr.incident.business_schedule',
} as const;

export const MIM_GROUP_NAME = 'Major Incident Management';
