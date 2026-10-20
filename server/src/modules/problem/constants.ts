export const PRB_STATE = {
  NEW: '101',
  ASSESS: '102',
  RCA: '103',
  FIX_IN_PROGRESS: '104',
  RESOLVED: '106',
  CLOSED: '107',
} as const;

export const PTASK_STATE = {
  NEW: '151',
  ASSESS: '152',
  WORK_IN_PROGRESS: '154',
  CLOSED: '157',
} as const;

export const RESOLUTION = {
  FIX_APPLIED: 'fix_applied',
  RISK_ACCEPTED: 'risk_accepted',
  DUPLICATE: 'duplicate',
  CANCELED: 'canceled',
} as const;

export const OPEN_TASK_STATES = [
  PTASK_STATE.NEW,
  PTASK_STATE.ASSESS,
  PTASK_STATE.WORK_IN_PROGRESS,
] as string[];

/** Lifecycle actions need a problem coordinator (managers and admins contain the role). */
export const COORDINATOR = 'problem_coordinator';
export const TASK_ANALYST = 'problem_task_analyst';
/** Roles allowed to own (be assigned) a problem, and additionally a problem task. */
export const PROBLEM_ASSIGNEE_ROLES = ['problem_coordinator', 'problem_manager', 'problem_admin'];
export const TASK_ASSIGNEE_ROLES = [...PROBLEM_ASSIGNEE_ROLES, 'problem_task_analyst'];
export const READ_ROLES = ['itil', 'sn_problem_read', 'problem_task_analyst'];
export const WRITE_ROLES = ['itil', 'sn_problem_write', 'problem_coordinator'];

export const PRB_PROP = {
  acceptRiskToClosed: 'problem.acceptrisk.move_to_closed',
  canCreateTasksOnClosed: 'problem.closed.can_create_tasks',
  reanalyzeCanceled: 'problem.closed.role.reanalyze_from_canceled',
  reanalyzeRiskAccepted: 'problem.closed.role.reanalyze_from_closed_riskaccepted',
  reanalyzeCompleted: 'problem.closed.role.reanalyze_from_completed',
  cancelOpenTasks: 'problem.closed.cancel_open_tasks',
  taskReassessRole: 'problem_task.closed.role.reaassess_from_closed',
  taskReassessOnClosedProblem: 'problem_task.closed.can_reassess_on_closed_problem',
  fixRecords: 'problem.fix.records',
  duplicateRecords: 'problem.duplicate.records_to_move',
  relateClosedIncidents: 'problem.role.relate_closed_incidents',
  createFromIncidentAttributes: 'com.snc.problem.create_from_incident.attributes',
  ciGroupField: 'com.snc.problem.ci_assignment_group.field_name',
  offeringGroupField: 'com.snc.problem.service_offering_assignment_group.field_name',
  modelsEnabled: 'com.snc.problem_management.models.enabled',
  workaroundToWorkNotes: 'com.snc.incident.communicate_prb_workaround_to_inc_worknotes',
} as const;

export const DEFAULT_PROBLEM_MODEL = 'General';
export const KNOWN_ERROR_BASE = 'Known Error';
