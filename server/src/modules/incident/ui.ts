import type {
  FormLayoutDef,
  ListLayoutDef,
  ModuleUiDef,
  NavApplicationDef,
  UiPolicyDef,
} from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import { INCIDENT_UI_ACTIONS } from './actions.js';

const ME = 'javascript:gs.getUserID()';

const navigation: NavApplicationDef[] = [
  {
    id: 'incident',
    title: 'Incident',
    icon: 'flame',
    roles: ['itil', 'sn_incident_read'],
    order: 20,
    modules: [
      { title: 'Create New', table: 'incident', route: '/workspace/record/incident/-1', icon: 'plus' },
      {
        title: 'Assigned to me',
        table: 'incident',
        query: `active=true^assigned_to=${ME}^ORDERBYpriority^ORDERBYDESCsys_updated_on`,
      },
      { title: 'Open', table: 'incident', query: 'active=true^ORDERBYpriority^ORDERBYDESCsys_updated_on' },
      {
        title: 'Open - Unassigned',
        table: 'incident',
        query: 'active=true^assigned_toISEMPTY^ORDERBYpriority^ORDERBYopened_at',
      },
      { title: 'Resolved', table: 'incident', query: 'state=6^ORDERBYDESCresolved_at' },
      { title: 'All', table: 'incident', query: 'ORDERBYDESCnumber' },
      {
        title: 'Major Incidents',
        table: 'incident',
        query: 'major_incident_state=accepted^ORDERBYDESCpromoted_on',
        separator: true,
      },
      {
        title: 'Major Incident Candidates',
        table: 'incident',
        query: 'major_incident_state=proposed^ORDERBYDESCproposed_on',
      },
      { title: 'Incident Tasks', table: 'incident_task', query: 'active=true^ORDERBYpriority' },
      {
        title: 'Communication Plans',
        table: 'incident_alert',
        query: 'active=true^ORDERBYDESCsys_created_on',
      },
      { title: 'Outages', table: 'cmdb_ci_outage', query: 'ORDERBYDESCbegin' },
      {
        title: 'Major Incident Trigger Rules',
        table: 'major_incident_trigger_rule',
        query: 'ORDERBYorder',
        roles: ['incident_manager', 'sn_mim_admin', 'admin'],
        separator: true,
      },
      {
        title: 'Communication Plan Definitions',
        table: 'comm_plan_definition',
        roles: ['ia_admin', 'incident_manager', 'admin'],
      },
      { title: 'Priority Lookup Rules', table: 'dl_u_priority', roles: ['data_lookup_admin', 'admin'] },
    ],
  },
];

const lists: ListLayoutDef[] = [
  {
    table: 'incident',
    columns: [
      'number',
      'opened_at',
      'short_description',
      'caller_id',
      'priority',
      'state',
      'category',
      'assignment_group',
      'assigned_to',
      'sys_updated_on',
    ],
    defaultOrder: 'ORDERBYDESCnumber',
  },
  {
    table: 'incident_task',
    columns: [
      'number',
      'incident',
      'short_description',
      'priority',
      'state',
      'assignment_group',
      'assigned_to',
      'due_date',
    ],
  },
  { table: 'major_incident_trigger_rule', columns: ['name', 'order', 'action', 'condition', 'active'] },
  {
    table: 'incident_alert',
    columns: [
      'number',
      'source_incident',
      'short_description',
      'type',
      'state',
      'assignment_group',
      'assigned_to',
    ],
  },
  {
    table: 'incident_alert_task',
    columns: [
      'number',
      'incident_alert',
      'short_description',
      'channel',
      'communication_frequency',
      'state',
      'times_performed',
      'last_communication_sent',
      'due_date',
    ],
  },
  { table: 'comm_plan_definition', columns: ['name', 'type', 'condition', 'order', 'active'] },
  {
    table: 'comm_task_definition',
    columns: ['name', 'comm_plan_definition', 'channel', 'communication_frequency', 'due_in', 'active'],
  },
  {
    table: 'cmdb_ci_outage',
    columns: ['number', 'cmdb_ci', 'type', 'begin', 'end', 'duration', 'task_number', 'short_description'],
  },
  { table: 'resolvr_incident_strike', columns: ['incident', 'attempts', 'next_due'] },
];

const forms: FormLayoutDef[] = [
  {
    table: 'incident',
    highlights: ['priority', 'state', 'assigned_to', 'major_incident_state'],
    sections: [
      {
        left: [
          'number',
          'caller_id',
          'category',
          'subcategory',
          'business_service',
          'service_offering',
          'cmdb_ci',
          'contact_type',
        ],
        right: [
          'state',
          'hold_reason',
          'impact',
          'urgency',
          'priority',
          'assignment_group',
          'assigned_to',
          'opened_at',
        ],
      },
      { fields: ['short_description', 'description'] },
      { caption: 'Notes', fields: ['watch_list', 'work_notes_list', 'comments', 'work_notes'] },
      {
        caption: 'Related Records',
        left: ['parent_incident', 'problem_id', 'child_incidents'],
        right: ['rfc', 'caused_by', 'reopen_count'],
      },
      {
        caption: 'Resolution Information',
        left: ['close_code', 'resolved_by', 'resolved_at'],
        right: ['knowledge', 'calendar_stc', 'business_stc'],
      },
      { fields: ['close_notes'] },
      {
        caption: 'Major Incident',
        left: ['major_incident_state', 'proposed_by', 'proposed_on', 'trigger_rule'],
        right: ['promoted_by', 'promoted_on'],
      },
      { fields: ['business_impact', 'cause', 'actions_taken'] },
      { caption: 'Post Incident Report', fields: ['overview', 'lessons_learned', 'timeline'] },
    ],
    relatedLists: [
      {
        table: 'incident_task',
        field: 'incident',
        label: 'Incident Tasks',
        columns: ['number', 'short_description', 'state', 'assignment_group', 'assigned_to'],
      },
      {
        table: 'incident',
        field: 'parent_incident',
        label: 'Child Incidents',
        columns: ['number', 'short_description', 'caller_id', 'state', 'priority', 'assigned_to'],
      },
      { table: 'task_ci', field: 'task', label: 'Affected CIs' },
      { table: 'task_sla', field: 'task', label: 'Task SLAs' },
      {
        table: 'incident_alert',
        field: 'source_incident',
        label: 'Communication Plans',
        columns: ['number', 'short_description', 'type', 'state', 'assigned_to'],
      },
      {
        table: 'cmdb_ci_outage',
        label: 'Outages',
        via: { table: 'task_outage', parentField: 'task', childField: 'outage' },
        columns: ['number', 'cmdb_ci', 'type', 'begin', 'end', 'duration'],
      },
    ],
  },
  {
    table: 'incident_task',
    highlights: ['state', 'priority', 'assigned_to'],
    sections: [
      {
        left: ['number', 'incident', 'cmdb_ci', 'priority'],
        right: ['state', 'assignment_group', 'assigned_to', 'due_date'],
      },
      { fields: ['short_description', 'description'] },
      { caption: 'Notes', fields: ['work_notes_list', 'work_notes'] },
      { caption: 'Closure', fields: ['close_notes'] },
    ],
  },
  {
    table: 'major_incident_trigger_rule',
    sections: [
      { left: ['name', 'table', 'order'], right: ['action', 'active'] },
      { fields: ['condition', 'description'] },
    ],
  },
  {
    table: 'incident_alert',
    highlights: ['state', 'type', 'assigned_to'],
    sections: [
      {
        left: ['number', 'source_incident', 'type', 'comm_plan_definition'],
        right: ['state', 'assignment_group', 'assigned_to', 'order'],
      },
      { fields: ['short_description', 'background'] },
      { caption: 'Notes', fields: ['actions_taken', 'work_notes'] },
    ],
    relatedLists: [
      {
        table: 'incident_alert_task',
        field: 'incident_alert',
        label: 'Communication Tasks',
        columns: [
          'number',
          'short_description',
          'channel',
          'communication_frequency',
          'state',
          'times_performed',
          'due_date',
        ],
      },
    ],
  },
  {
    table: 'incident_alert_task',
    highlights: ['state', 'channel', 'times_performed'],
    sections: [
      {
        left: ['number', 'incident_alert', 'source_incident', 'channel', 'communication_frequency'],
        right: ['state', 'assignment_group', 'assigned_to', 'due_date', 'due_in'],
      },
      { left: ['times_performed'], right: ['last_communication_sent'] },
      { fields: ['short_description', 'description', 'work_notes'] },
    ],
  },
  {
    table: 'comm_plan_definition',
    sections: [
      { left: ['name', 'table', 'type'], right: ['order', 'active'] },
      { fields: ['short_description', 'condition'] },
    ],
    relatedLists: [
      { table: 'comm_task_definition', field: 'comm_plan_definition', label: 'Task Definitions' },
    ],
  },
  {
    table: 'cmdb_ci_outage',
    highlights: ['type', 'duration'],
    sections: [
      { left: ['number', 'cmdb_ci', 'type', 'task_number'], right: ['begin', 'end', 'duration'] },
      { fields: ['short_description'] },
    ],
    relatedLists: [
      {
        table: 'task',
        label: 'Tasks',
        via: { table: 'task_outage', parentField: 'outage', childField: 'task' },
        columns: ['number', 'short_description', 'state'],
      },
    ],
  },
];

const policy = (
  id: string,
  name: string,
  condition: string,
  actions: UiPolicyDef['actions'],
  reverseIfFalse = true,
): UiPolicyDef => ({
  id,
  table: 'incident',
  name,
  condition,
  reverseIfFalse,
  onLoad: true,
  actions,
});

const uiPolicies: UiPolicyDef[] = [
  policy(
    'incident.priority_readonly',
    'Priority is managed by the priority lookup',
    '',
    [{ field: 'priority', readOnly: true }],
    false,
  ),
  policy('incident.hold_reason', 'On hold reason is visible and mandatory when on hold', 'state=3', [
    { field: 'hold_reason', visible: true, mandatory: true },
  ]),
  policy(
    'incident.caller_comment',
    'A comment for the caller is required when awaiting the caller',
    'state=3^hold_reason=1',
    [{ field: 'comments', mandatory: true }],
  ),
  policy(
    'incident.resolution',
    'Resolution code and notes are mandatory when resolved or closed',
    'stateIN6,7',
    [
      { field: 'close_code', mandatory: true },
      { field: 'close_notes', mandatory: true },
    ],
  ),
  policy(
    'incident.closed_readonly',
    'Closed and canceled incidents are read-only',
    'stateIN7,8',
    [
      'short_description',
      'description',
      'caller_id',
      'category',
      'impact',
      'urgency',
      'state',
      'assignment_group',
      'assigned_to',
      'close_code',
      'close_notes',
    ].map((field) => ({ field, readOnly: true })),
  ),
  policy(
    'incident.major_incident',
    'Show major incident fields for candidates and major incidents',
    'major_incident_stateISNOTEMPTY',
    [
      'major_incident_state',
      'proposed_by',
      'proposed_on',
      'promoted_by',
      'promoted_on',
      'trigger_rule',
      'business_impact',
      'cause',
      'actions_taken',
    ].map((field) => ({ field, visible: true })),
  ),
  policy(
    'incident.pir',
    'Show the post incident report once a major incident is resolved',
    'major_incident_state=accepted^stateIN6,7',
    ['overview', 'lessons_learned', 'timeline'].map((field) => ({ field, visible: true })),
  ),
];

export const INCIDENT_UI: ModuleUiDef = {
  navigation,
  lists,
  forms,
  uiActions: INCIDENT_UI_ACTIONS,
  uiPolicies,
};

/** Drops related lists whose tables come from modules that are not installed (CMDB, SLA). */
export function pruneRelatedLists(platform: Platform): void {
  for (const form of platform.forms.values()) {
    if (!form.relatedLists?.length || !['incident', 'problem', 'cmdb_ci_outage'].includes(form.table))
      continue;
    form.relatedLists = form.relatedLists.filter(
      (r) => platform.registry.has(r.table) && (!r.via || platform.registry.has(r.via.table)),
    );
  }
}
