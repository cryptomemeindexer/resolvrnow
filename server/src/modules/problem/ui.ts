import type {
  FormLayoutDef,
  ListLayoutDef,
  ModuleUiDef,
  NavApplicationDef,
  UiPolicyDef,
} from '../../engine/module.js';
import { PROBLEM_UI_ACTIONS } from './actions.js';

const ME = 'javascript:gs.getUserID()';

const navigation: NavApplicationDef[] = [
  {
    id: 'problem',
    title: 'Problem',
    icon: 'bug',
    roles: ['itil', 'sn_problem_read', 'problem_task_analyst'],
    order: 25,
    modules: [
      {
        title: 'Create New',
        table: 'problem',
        route: '/workspace/record/problem/-1',
        roles: ['itil', 'sn_problem_write', 'problem_coordinator'],
      },
      { title: 'Assigned to me', table: 'problem', query: `active=true^assigned_to=${ME}^ORDERBYpriority` },
      { title: 'Open', table: 'problem', query: 'active=true^ORDERBYpriority^ORDERBYDESCsys_updated_on' },
      { title: 'Known Errors', table: 'problem', query: 'known_error=true^ORDERBYDESCsys_updated_on' },
      { title: 'All', table: 'problem', query: 'ORDERBYDESCnumber' },
      {
        title: 'Problem Tasks',
        table: 'problem_task',
        query: 'active=true^ORDERBYpriority',
        separator: true,
      },
      { title: 'My Problem Tasks', table: 'problem_task', query: `active=true^assigned_to=${ME}` },
      { title: 'Problem Models', table: 'prb_model', roles: ['problem_admin'], separator: true },
      { title: 'Problem Task Models', table: 'prb_task_model', roles: ['problem_admin'] },
      {
        title: 'Problem Priority Lookup',
        table: 'dl_problem_priority',
        roles: ['problem_admin', 'data_lookup_admin'],
      },
    ],
  },
];

const lists: ListLayoutDef[] = [
  {
    table: 'problem',
    columns: [
      'number',
      'short_description',
      'state',
      'priority',
      'category',
      'related_incidents',
      'known_error',
      'assignment_group',
      'assigned_to',
      'sys_updated_on',
    ],
    defaultOrder: 'ORDERBYDESCnumber',
  },
  {
    table: 'problem_task',
    columns: [
      'number',
      'problem',
      'short_description',
      'problem_task_type',
      'state',
      'assignment_group',
      'assigned_to',
      'due_date',
    ],
  },
  { table: 'dl_problem_priority', columns: ['impact', 'urgency', 'priority', 'order', 'active'] },
  { table: 'prb_model', columns: ['name', 'default_model', 'active', 'description'] },
  { table: 'prb_task_model', columns: ['name', 'problem_task_type', 'default_model', 'active'] },
];

const forms: FormLayoutDef[] = [
  {
    table: 'problem',
    highlights: ['priority', 'state', 'assigned_to', 'known_error'],
    sections: [
      {
        left: [
          'number',
          'first_reported_by_task',
          'category',
          'subcategory',
          'business_service',
          'service_offering',
          'cmdb_ci',
        ],
        right: [
          'state',
          'resolution_code',
          'duplicate_of',
          'impact',
          'urgency',
          'priority',
          'assignment_group',
          'assigned_to',
        ],
      },
      { fields: ['short_description', 'description'] },
      { caption: 'Notes', fields: ['work_notes_list', 'work_notes'] },
      { caption: 'Analysis Information', fields: ['workaround', 'cause_notes'] },
      { left: ['primary_known_error_article', 'known_error'], right: ['major_problem', 'related_incidents'] },
      { caption: 'Resolution Information', fields: ['fix_notes', 'close_notes', 'review_outcome'] },
      { left: ['resolved_by', 'resolved_at'], right: ['rfc', 'reopen_count'] },
      {
        caption: 'Other Information',
        left: [
          'opened_by',
          'opened_at',
          'confirmed_by',
          'confirmed_at',
          'workaround_communicated_by',
          'workaround_communicated_at',
        ],
        right: ['fix_by', 'fix_at', 'fix_communicated_by', 'fix_communicated_at', 'closed_by', 'closed_at'],
      },
    ],
    relatedLists: [
      {
        table: 'incident',
        field: 'problem_id',
        label: 'Incidents',
        columns: ['number', 'short_description', 'caller_id', 'state', 'priority', 'assigned_to'],
      },
      {
        table: 'problem_task',
        field: 'problem',
        label: 'Problem Tasks',
        columns: ['number', 'short_description', 'problem_task_type', 'state', 'assigned_to'],
      },
      {
        table: 'change_request',
        field: 'parent',
        label: 'Change Requests',
        columns: ['number', 'short_description', 'state', 'assigned_to'],
      },
      { table: 'task_ci', field: 'task', label: 'Affected CIs' },
      {
        table: 'cmdb_ci_outage',
        label: 'Outages',
        via: { table: 'task_outage', parentField: 'task', childField: 'outage' },
        columns: ['number', 'cmdb_ci', 'type', 'begin', 'end', 'duration'],
      },
    ],
  },
  {
    table: 'problem_task',
    highlights: ['state', 'problem_task_type', 'assigned_to'],
    sections: [
      {
        left: ['number', 'problem', 'problem_task_type', 'cmdb_ci', 'due_date'],
        right: ['state', 'close_code', 'priority', 'assignment_group', 'assigned_to'],
      },
      { fields: ['short_description', 'description'] },
      { caption: 'Root Cause Analysis', fields: ['cause_code', 'workaround', 'fix_notes'] },
      { caption: 'Closure', fields: ['close_notes'] },
      { caption: 'Notes', fields: ['work_notes_list', 'work_notes'] },
    ],
  },
  {
    table: 'prb_model',
    sections: [
      { left: ['name', 'default_model'], right: ['active', 'advanced_security'] },
      { fields: ['description'] },
    ],
  },
  {
    table: 'prb_task_model',
    sections: [
      { left: ['name', 'problem_task_type'], right: ['default_model', 'active'] },
      { fields: ['description'] },
    ],
  },
];

const policy = (
  table: string,
  id: string,
  name: string,
  condition: string,
  actions: UiPolicyDef['actions'],
): UiPolicyDef => ({
  id,
  table,
  name,
  condition,
  reverseIfFalse: true,
  onLoad: true,
  actions,
});

const uiPolicies: UiPolicyDef[] = [
  policy('problem', 'problem.priority_readonly', 'Priority comes from the lookup', '', [
    { field: 'priority', readOnly: true },
    { field: 'state', readOnly: true },
    { field: 'resolution_code', readOnly: true },
  ]),
  policy('problem', 'problem.major_problem', 'Major problems show the review notes', 'major_problem=true', [
    { field: 'review_outcome', visible: true },
  ]),
  policy(
    'problem',
    'problem.duplicate_of',
    'Duplicate of is shown for duplicates',
    'resolution_code=duplicate',
    [{ field: 'duplicate_of', visible: true, readOnly: true }],
  ),
  policy(
    'problem',
    'problem.closed_readonly',
    'Closed problems are read-only',
    'state=107',
    [
      'short_description',
      'description',
      'category',
      'subcategory',
      'impact',
      'urgency',
      'assignment_group',
      'assigned_to',
      'workaround',
      'cause_notes',
      'fix_notes',
    ].map((field) => ({ field, readOnly: true })),
  ),
  policy(
    'problem_task',
    'problem_task.rca_fields',
    'Root cause fields are for RCA tasks',
    'problem_task_type=rca',
    [
      { field: 'cause_code', visible: true },
      { field: 'workaround', visible: true },
      { field: 'fix_notes', visible: true },
    ],
  ),
  policy(
    'problem_task',
    'problem_task.type_readonly',
    'The task type is fixed once saved',
    'numberISNOTEMPTY',
    [{ field: 'problem_task_type', readOnly: true }],
  ),
];

export const PROBLEM_UI: ModuleUiDef = {
  navigation,
  lists,
  forms,
  uiActions: PROBLEM_UI_ACTIONS,
  uiPolicies,
};
