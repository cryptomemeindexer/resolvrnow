import type { ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import { CHOICES } from './constants.js';

const str = (name: string, label: string, maxLength = 255, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  maxLength,
  ...extra,
});
const bool = (name: string, label: string, def = false, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: def ? 'true' : 'false',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});
const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});
const typed = (
  name: string,
  label: string,
  type: ColumnDef['type'],
  extra: Partial<ColumnDef> = {},
): ColumnDef => ({
  name,
  label,
  type,
  ...extra,
});

/** change_request: the SDK schema plus the columns and dictionary overrides from the change spec. */
const changeRequest: TableDef = sdkTable('change_request', {
  audit: true,
  number: { prefix: 'CHG', start: 30000, digits: 7 },
  exclude: ['risk_and_compliance_category'],
  patch: {
    chg_model: { defaultValue: undefined, referenceQual: 'active=true^available_in_ui=true' },
    type: {
      defaultValue: undefined,
      choices: CHOICES.type,
      readOnly: true,
      choiceMode: 'dropdown_with_none',
    },
    risk: { choices: CHOICES.risk, choiceMode: 'dropdown_with_none' },
    category: { choices: CHOICES.category },
    close_code: { choices: CHOICES.closeCode, choiceMode: 'dropdown_with_none' },
    phase: { choices: CHOICES.phase },
    phase_state: { choices: CHOICES.phaseState },
    conflict_status: { choices: CHOICES.conflictStatus },
    review_status: { choices: CHOICES.reviewStatus, choiceMode: 'dropdown_with_none' },
    scope: { choices: CHOICES.scope },
    reason: { choices: CHOICES.reason, choiceMode: 'dropdown_with_none' },
    cab_required: { readOnly: true },
    outside_maintenance_schedule: { readOnly: true },
    on_hold_task: { readOnly: true },
    requested_by: { indexed: true },
    start_date: { indexed: true },
    end_date: { indexed: true },
  },
  columns: [
    bool('is_bulk', 'Mass update CI class'),
    str('proposed_change', 'Proposed change', 4000),
    typed('ci_class', 'CI class', 'table_name', { defaultValue: 'cmdb_ci' }),
    str('risk_value', 'Risk value', 40, { readOnly: true }),
    bool('needs_attention', 'Needs attention'),
    int('action_status', 'Action status', {
      choices: CHOICES.actionStatus,
      choiceMode: 'dropdown_with_none',
    }),
    ref('task_for', 'Task for', 'sys_user'),
    str('child_changes_creation_status', 'Child changes creation status', 40, {
      readOnly: true,
      choices: CHOICES.childStatus,
      choiceMode: 'dropdown_with_none',
    }),
    ref('primary_change', 'Primary change', 'change_request', { readOnly: true }),
    // ResolvrNow bookkeeping: approvals parked by the change going on hold.
    str('resolvr_hold_approvals', 'Approvals held by on hold', 4000, {
      readOnly: true,
      internal: true,
      noAudit: true,
    }),
  ],
  overrides: {
    state: { defaultValue: '-5', choices: CHOICES.state },
    approval: { defaultValue: 'not requested' },
    impact: { defaultValue: '3', choices: CHOICES.impact },
    urgency: { defaultValue: '3', choices: CHOICES.impact },
    priority: { defaultValue: '4' },
  },
});

const changeTask: TableDef = {
  name: 'change_task',
  label: 'Change Task',
  extends: 'task',
  audit: true,
  number: { prefix: 'CTASK', start: 10000, digits: 7 },
  columns: [
    ref('change_request', 'Change request', 'change_request', {
      referenceQual: 'active=true',
      mandatory: true,
      indexed: true,
      cascade: 'delete',
    }),
    str('change_task_type', 'Change task type', 40, { choices: CHOICES.taskType, defaultValue: 'planning' }),
    dt('planned_start_date', 'Planned start date'),
    dt('planned_end_date', 'Planned end date'),
    bool('on_hold', 'On hold'),
    str('on_hold_reason', 'On hold reason', 4000),
    str('created_from', 'Created from', 40, {
      choices: CHOICES.createdFrom,
      defaultValue: 'manual',
      readOnly: true,
    }),
    str('close_code', 'Close code', 40, { choices: CHOICES.closeCode, choiceMode: 'dropdown_with_none' }),
  ],
  overrides: { state: { defaultValue: '1', choices: CHOICES.taskState } },
};

// ------------------------------------------------------------------ models

const modelTables: TableDef[] = [
  {
    name: 'chg_model',
    label: 'Change Model',
    displayField: 'name',
    audit: true,
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('sys_name', 'System name', 100, { readOnly: true }),
      str('description', 'Description', 1000),
      bool('active', 'Active', true),
      bool('default_change_model', 'Default change model'),
      bool('available_in_ui', 'Available in Create New', true),
      str('color', 'Color', 40, { defaultValue: '#cbcbcb' }),
      str('record_preset', 'Record preset', 4000, {
        hint: 'Encoded field values applied to new changes, e.g. type=normal^EQ',
      }),
      typed('table_name', 'Table', 'table_name', { defaultValue: 'change_request' }),
      typed('state_field', 'State field', 'field_name', { defaultValue: 'state' }),
      str('itil_change_process', 'ITIL change process', 40, {
        choices: CHOICES.itilProcess,
        choiceMode: 'dropdown_with_none',
      }),
      str('implementation_states', 'Implementation states', 200),
      bool('advanced_security', 'Advanced security'),
      typed('read_roles', 'Read roles', 'user_roles'),
      typed('write_roles', 'Write roles', 'user_roles'),
      str('template_proposer', 'Template proposer', 40, {
        choices: CHOICES.templateProposer,
        defaultValue: 'modify',
      }),
      typed('template_approval_users', 'Template approval users', 'glide_list', { reference: 'sys_user' }),
      typed('template_approval_groups', 'Template approval groups', 'glide_list', {
        reference: 'sys_user_group',
      }),
    ],
  },
  {
    name: 'sttrm_state',
    label: 'Model State',
    displayField: 'label',
    columns: [
      ref('model', 'Model', 'chg_model', { mandatory: true, cascade: 'delete' }),
      int('state', 'State', { mandatory: true, choices: CHOICES.state }),
      str('label', 'Label', 100),
      bool('initial_state', 'Initial state'),
      int('order', 'Order', { defaultValue: '100' }),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'sttrm_state_transition',
    label: 'Model State Transition',
    displayField: 'name',
    columns: [
      ref('model', 'Model', 'chg_model', { mandatory: true, cascade: 'delete' }),
      str('name', 'Name', 100),
      ref('from_state', 'From state', 'sttrm_state', { mandatory: true, cascade: 'delete' }),
      ref('to_state', 'To state', 'sttrm_state', { mandatory: true, cascade: 'delete' }),
      bool('automatic_transition', 'Automatic transition'),
      bool('active', 'Active', true),
      int('order', 'Order', { defaultValue: '100' }),
    ],
  },
  {
    name: 'sttrm_condition_type',
    label: 'Model Condition Type',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('description', 'Description', 1000),
      str('condition_type', 'Condition type', 40, {
        choices: CHOICES.conditionType,
        defaultValue: 'condition',
      }),
      typed('table_name', 'Table', 'table_name', { defaultValue: 'change_request' }),
      typed('condition', 'Condition', 'conditions', { maxLength: 4000 }),
      typed('script', 'Script', 'script', { maxLength: 8000 }),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'sttrm_transition_condition',
    label: 'Model State Transition Condition',
    displayField: 'name',
    columns: [
      ref('state_transition', 'State transition', 'sttrm_state_transition', {
        mandatory: true,
        cascade: 'delete',
      }),
      str('name', 'Name', 100, { mandatory: true }),
      str('description', 'Description', 1000),
      ref('requires', 'Requires', 'sttrm_condition_type', { mandatory: true }),
      typed('condition', 'Condition', 'conditions', { maxLength: 4000 }),
      typed('script', 'Script', 'script', { maxLength: 8000 }),
      typed('fields', 'Fields', 'field_list', { maxLength: 4000 }),
      bool('active', 'Active', true),
      bool('policy_managed', 'Policy managed', false, { readOnly: true }),
    ],
  },
  {
    name: 'sttrm_state_field_policy',
    label: 'State Field Policy',
    displayField: 'field',
    columns: [
      ref('model_state', 'Model state', 'sttrm_state', { mandatory: true, cascade: 'delete' }),
      typed('field', 'Field', 'field_name', { mandatory: true }),
      bool('mandatory', 'Mandatory'),
      bool('read_only', 'Read only'),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'sttrm_attribute',
    label: 'Change Model Attribute',
    displayField: 'label',
    columns: [
      str('label', 'Label', 100, { mandatory: true }),
      str('name', 'Name', 100, { mandatory: true }),
      str('description', 'Description', 1000),
      typed('table_name', 'Table', 'table_name', { defaultValue: 'change_request' }),
    ],
  },
  {
    name: 'sttrm_state_attribute',
    label: 'Model State Attribute',
    displayField: 'attribute',
    columns: [
      ref('model_state', 'Model state', 'sttrm_state', { mandatory: true, cascade: 'delete' }),
      ref('attribute', 'Attribute', 'sttrm_attribute', { mandatory: true, cascade: 'delete' }),
      bool('active', 'Active', true),
    ],
  },
  {
    name: 'chg_template',
    label: 'Change Template',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('short_description', 'Short description', 160),
      ref('chg_model', 'Model', 'chg_model'),
      bool('active', 'Active', true),
      str('state', 'State', 40, { choices: CHOICES.templateState, defaultValue: 'draft', readOnly: true }),
      str('template', 'Template', 4000),
      ref('previous_template', 'Previous template', 'chg_template', { readOnly: true }),
      int('version', 'Version', { defaultValue: '1', readOnly: true }),
    ],
  },
];

// ------------------------------------------------------- standard changes

const standardTables: TableDef[] = [
  {
    name: 'std_change_properties',
    label: 'Standard Change Properties',
    columns: [
      bool('two_step', 'Two step', true),
      typed('mandatory_cr_fields', 'Mandatory change fields', 'field_list', { maxLength: 4000 }),
      typed('restricted_cr_fields', 'Restricted change fields', 'field_list', { maxLength: 4000 }),
      typed('readonly_cr_fields', 'Read-only change fields', 'field_list', { maxLength: 4000 }),
      typed('cr_fields_to_copy', 'Change fields to copy', 'field_list', { maxLength: 4000 }),
      typed('task_fields_to_copy', 'Task fields to copy', 'field_list', { maxLength: 4000 }),
    ],
  },
  {
    name: 'std_change_template',
    label: 'Standard Change Template Values',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100),
      typed('table', 'Table', 'table_name', { defaultValue: 'change_request' }),
      str('template', 'Template', 8000, {
        hint: 'Encoded field values, e.g. short_description=Patch^risk=4',
      }),
    ],
  },
  {
    name: 'std_change_record_producer',
    label: 'Standard Change Template',
    displayField: 'name',
    audit: true,
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('short_description', 'Short description', 160),
      str('description', 'Description', 4000),
      str('category', 'Category', 100),
      bool('active', 'Active', true),
      int('order', 'Order', { defaultValue: '100' }),
      ref('template', 'Template', 'std_change_template'),
      ref('current_version', 'Current version', 'std_change_producer_version', { readOnly: true }),
      bool('retired', 'Retired', false, { readOnly: true }),
    ],
  },
  {
    name: 'std_change_producer_version',
    label: 'Standard Change Template Version',
    displayField: 'name',
    columns: [
      ref('std_change_producer', 'Template', 'std_change_record_producer', {
        mandatory: true,
        cascade: 'delete',
      }),
      ref('std_change_proposal', 'Proposal', 'std_change_proposal'),
      str('name', 'Name', 120),
      int('version', 'Version', { defaultValue: '1' }),
      int('successful_count', 'Successful changes', { defaultValue: '0', readOnly: true }),
      int('unsuccessful_count', 'Unsuccessful changes', { defaultValue: '0', readOnly: true }),
      typed('successful_pct', 'Successful %', 'decimal', { readOnly: true }),
      typed('unsuccessful_pct', 'Unsuccessful %', 'decimal', { readOnly: true }),
    ],
  },
  {
    name: 'std_change_proposal',
    label: 'Standard Change Proposal',
    extends: 'task',
    audit: true,
    number: { prefix: 'STDCHG', start: 1000, digits: 7 },
    columns: [
      int('type', 'Proposal type', { choices: CHOICES.proposalType, defaultValue: '1' }),
      str('category', 'Category', 100),
      ref('requested_by', 'Requested by', 'sys_user', { defaultValue: 'javascript:gs.getUserID()' }),
      str('template_value', 'Template values', 8000, {
        hint: 'Encoded change field values, e.g. short_description=Restart print spooler^risk=4',
      }),
      typed('sample_change_requests', 'Sample change requests', 'glide_list', {
        reference: 'change_request',
      }),
      ref('std_change_producer', 'Standard change template', 'std_change_record_producer'),
      str('business_justification', 'Business justification', 4000),
    ],
    overrides: { state: { defaultValue: '1', choices: CHOICES.proposalState } },
  },
  {
    name: 'std_change_task_template',
    label: 'Standard Change Task Template',
    displayField: 'name',
    columns: [
      ref('std_change_proposal', 'Proposal', 'std_change_proposal', { cascade: 'delete' }),
      ref('std_change_producer_version', 'Template version', 'std_change_producer_version', {
        cascade: 'delete',
      }),
      str('name', 'Name', 100, { mandatory: true }),
      int('order', 'Order', { defaultValue: '100' }),
      str('short_description', 'Short description', 160),
      str('task_values', 'Task values', 4000, {
        hint: 'Encoded change task values, e.g. change_task_type=implementation',
      }),
    ],
  },
];

// ------------------------------------------------------- risk and impact

const riskTables: TableDef[] = [
  {
    name: 'risk_conditions',
    label: 'Risk Condition',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('description', 'Description', 1000),
      bool('active', 'Active', true),
      int('order', 'Order', { defaultValue: '100' }),
      int('risk', 'Risk', { choices: CHOICES.risk, choiceMode: 'dropdown_with_none' }),
      int('impact', 'Impact', { choices: CHOICES.impact, choiceMode: 'dropdown_with_none' }),
      bool('use_advanced_condition', 'Use advanced condition'),
      typed('condition', 'Condition', 'conditions', { maxLength: 4000 }),
      typed('advanced_condition', 'Advanced condition', 'script', { maxLength: 8000 }),
      bool('use_script_values', 'Use script values'),
      typed('script_values', 'Script values', 'script', { maxLength: 8000 }),
      int('resolvr_min_impacted_services', 'Minimum impacted services', {
        hint: 'When set, the rule also requires the configuration item to impact at least this many services',
      }),
    ],
  },
  {
    name: 'change_risk_asmt',
    label: 'Change Risk Assessment',
    displayField: 'name',
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      str('state', 'State', 40, { choices: CHOICES.assessmentState, defaultValue: 'draft' }),
      str('description', 'Description', 1000),
      typed('condition', 'Condition', 'conditions', { maxLength: 4000 }),
      typed('category_weight', 'Category weight', 'decimal', { defaultValue: '1' }),
    ],
  },
  {
    name: 'change_risk_asmt_question',
    label: 'Change Risk Assessment Question',
    displayField: 'question',
    columns: [
      ref('risk_assessment', 'Risk assessment', 'change_risk_asmt', { mandatory: true, cascade: 'delete' }),
      str('question', 'Question', 1000, { mandatory: true }),
      str('description', 'Description', 1000),
      int('order', 'Order', { defaultValue: '100' }),
      bool('active', 'Active', true),
      bool('mandatory', 'Mandatory'),
      typed('weight', 'Weight', 'decimal', { defaultValue: '1' }),
      typed('depends_on', 'Depends on', 'conditions', { maxLength: 4000 }),
      bool('allow_additional_info', 'Allow additional information'),
      typed('options', 'Answer options', 'json', { hint: 'JSON array of {"label": "...", "value": number}' }),
    ],
  },
  {
    name: 'change_risk_asmt_threshold',
    label: 'Assessment Threshold',
    displayField: 'risk',
    columns: [
      ref('risk_assessment', 'Risk assessment', 'change_risk_asmt', { mandatory: true, cascade: 'delete' }),
      int('risk', 'Risk', { mandatory: true, choices: CHOICES.risk }),
      typed('score_greater_than', 'Score greater than', 'decimal', { mandatory: true }),
    ],
  },
  {
    name: 'change_risk_asmt_result',
    label: 'Change Risk Assessment Result',
    displayField: 'risk_assessment',
    columns: [
      ref('change', 'Change request', 'change_request', { mandatory: true, cascade: 'delete' }),
      ref('risk_assessment', 'Risk assessment', 'change_risk_asmt', { mandatory: true }),
      typed('answers', 'Answers', 'json'),
      typed('score', 'Score', 'decimal', { readOnly: true }),
      int('risk', 'Risk', { readOnly: true, choices: CHOICES.risk }),
      ref('taken_by', 'Taken by', 'sys_user'),
      dt('taken_on', 'Taken on'),
    ],
  },
  {
    name: 'sn_chg_probability_risk_lookup',
    label: 'Calculated Risk Score',
    columns: [
      int('impact', 'Impact', { mandatory: true, choices: CHOICES.impact }),
      str('success_probability', 'Success probability', 40, {
        mandatory: true,
        choices: CHOICES.successProbability,
      }),
      int('risk', 'Risk', { mandatory: true, choices: CHOICES.risk }),
    ],
  },
];

// ------------------------------------------------ conflicts and schedules

/**
 * `cmn_schedule` and `cmn_schedule_span` belong to the schedules module. They are declared
 * here with a minimal column set so blackout and maintenance windows work when that module
 * is not installed; the registry merges definitions when both modules are present.
 */
const scheduleTables: TableDef[] = [
  {
    name: 'cmn_schedule',
    label: 'Schedule',
    displayField: 'name',
    columns: [
      str('name', 'Name', 80),
      str('type', 'Type', 40),
      str('time_zone', 'Time zone', 40),
      str('description', 'Description', 1000),
    ],
  },
  sdkTable('cmn_schedule_span', {
    include: [
      'schedule',
      'name',
      'type',
      'show_as',
      'start_date_time',
      'end_date_time',
      'all_day',
      'repeat_type',
      'repeat_count',
      'days_of_week',
      'repeat_until',
      'notes',
    ],
    displayField: 'name',
  }),
  {
    name: 'cmn_schedule_condition',
    label: 'Condition Schedule',
    extends: 'cmn_schedule',
    columns: [
      str('source', 'Source', 40, { choices: CHOICES.scheduleSource, defaultValue: 'ci_class' }),
      typed('applies_to', 'Applies to', 'table_name', { defaultValue: 'cmdb_ci' }),
      typed('condition', 'Condition', 'conditions', { maxLength: 4000 }),
      str('category', 'Category', 40),
      ref('assignment_group', 'Assignment group', 'sys_user_group'),
      ref('assigned_to', 'Assigned to', 'sys_user'),
    ],
  },
  {
    name: 'cmn_schedule_blackout',
    label: 'Blackout Schedule',
    extends: 'cmn_schedule_condition',
    columns: [],
    overrides: { category: { choices: CHOICES.blackoutCategory }, type: { defaultValue: 'blackout' } },
  },
  {
    name: 'cmn_schedule_maintenance',
    label: 'Maintenance Schedule',
    extends: 'cmn_schedule_condition',
    columns: [],
    overrides: { category: { choices: CHOICES.maintenanceCategory }, type: { defaultValue: 'maintenance' } },
  },
  {
    name: 'cmn_schedule_information',
    label: 'Information Schedule',
    extends: 'cmn_schedule_condition',
    columns: [],
    overrides: { category: { choices: CHOICES.informationCategory } },
  },
];

const conflictTables: TableDef[] = [
  {
    name: 'conflict',
    label: 'Conflict',
    displayField: 'type',
    columns: [
      ref('change', 'Change', 'change_request', { mandatory: true, indexed: true, cascade: 'delete' }),
      ref('conflicting_change', 'Conflicting change', 'change_request', { cascade: 'delete' }),
      ref('configuration_item', 'Configuration item', 'cmdb_ci'),
      ref('related_configuration_item', 'Related configuration item', 'cmdb_ci'),
      ref('schedule', 'Schedule', 'cmn_schedule', { cascade: 'delete' }),
      str('type', 'Type', 40, { mandatory: true, choices: CHOICES.conflictType }),
      str('category', 'Category', 40, {
        choices: [...CHOICES.blackoutCategory, ...CHOICES.maintenanceCategory].map((ch, i) => ({
          ...ch,
          sequence: i + 1,
        })),
      }),
      dt('last_checked', 'Last checked'),
      str('resolvr_description', 'Description', 1000),
    ],
  },
  {
    name: 'chg_mgt_worker',
    label: 'Change Management Worker',
    displayField: 'type',
    columns: [
      int('state', 'State', { choices: CHOICES.workerState, defaultValue: '1' }),
      str('type', 'Type', 40, { mandatory: true, choices: CHOICES.workerType }),
      ref('task', 'Change request', 'change_request', { cascade: 'delete' }),
      ref('cmdb_ci', 'Configuration item', 'cmdb_ci'),
      typed('request', 'Request', 'json'),
      typed('payload', 'Payload', 'json'),
      typed('messages', 'Messages', 'json'),
      dt('started_at', 'Started'),
      dt('completed_at', 'Completed'),
    ],
  },
  // Task relations shared with the CMDB module (merged when both define them).
  {
    name: 'task_ci',
    label: 'Affected CI',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, indexed: true }),
      ref('ci_item', 'Configuration item', 'cmdb_ci', { mandatory: true, indexed: true }),
      bool('manual_proposed_change', 'Manual proposed change'),
      bool('applied', 'Applied', false, { readOnly: true }),
      dt('applied_date', 'Applied date'),
    ],
  },
  {
    name: 'task_cmdb_ci_service',
    label: 'Impacted Service/CI',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, indexed: true }),
      ref('cmdb_ci_service', 'Impacted service', 'cmdb_ci', { mandatory: true }),
      bool('manually_added', 'Manually added'),
    ],
  },
  {
    name: 'task_service_offering',
    label: 'Impacted Service Offering',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, indexed: true }),
      ref('service_offering', 'Service offering', 'service_offering', { mandatory: true }),
      bool('manually_added', 'Manually added'),
    ],
  },
];

// -------------------------------------------------------------------- CAB

const cabTables: TableDef[] = [
  {
    name: 'cab_definition',
    label: 'CAB Definition',
    extends: 'cmn_schedule',
    columns: [
      ref('manager', 'CAB manager', 'sys_user'),
      typed('delegates', 'Delegates', 'glide_list', { reference: 'sys_user' }),
      typed('board_members', 'Board members', 'glide_list', { reference: 'sys_user' }),
      typed('board_groups', 'Board groups', 'glide_list', { reference: 'sys_user_group' }),
      int('rolling_window', 'Rolling window (days)', { defaultValue: '28' }),
      str('cab_type', 'CAB type', 100),
      bool('active', 'Active', true),
      str('conference_details', 'Conference details', 1000),
      bool('use_filter_dates', 'Use filter dates'),
      int('notification_lead_time', 'Notification lead time'),
      bool('auto_add_agenda_decisions', 'Auto add agenda decisions'),
      bool('auto_add_changes', 'Auto add changes'),
      typed('change_condition', 'Change condition', 'conditions', { maxLength: 4000 }),
      typed('time_per_agenda_item', 'Time per agenda item', 'glide_duration', { defaultValue: 600000 }),
      bool('complete_preapproved', 'Complete pre-approved changes'),
    ],
  },
  {
    name: 'cab_meeting',
    label: 'CAB Meeting',
    displayField: 'name',
    audit: true,
    columns: [
      str('name', 'Name', 100, { mandatory: true }),
      ref('cab_definition', 'CAB definition', 'cab_definition'),
      ref('manager', 'CAB manager', 'sys_user'),
      typed('delegates', 'Delegates', 'glide_list', { reference: 'sys_user' }),
      typed('board_members', 'Board members', 'glide_list', { reference: 'sys_user' }),
      typed('board_groups', 'Board groups', 'glide_list', { reference: 'sys_user_group' }),
      str('state', 'State', 40, { choices: CHOICES.meetingState, defaultValue: 'pending' }),
      dt('start', 'Start', { mandatory: true }),
      dt('end', 'End', { mandatory: true }),
      typed('meeting_notes', 'Meeting notes', 'html', { maxLength: 65000 }),
      str('conference_details', 'Conference details', 1000),
      bool('use_filter_dates', 'Use filter dates'),
      dt('changes_start_after', 'Changes start after'),
      dt('changes_start_on_or_before', 'Changes start on or before'),
      typed('change_condition', 'Change condition', 'conditions', { maxLength: 4000 }),
      bool('complete_preapproved', 'Complete pre-approved changes'),
      typed('time_per_agenda_item', 'Time per agenda item', 'glide_duration', { defaultValue: 600000 }),
      int('notification_lead_time', 'Notification lead time'),
      bool('auto_add_agenda_decisions', 'Auto add agenda decisions', true),
      ref('host', 'Host', 'sys_user'),
    ],
  },
  {
    name: 'cab_agenda_item',
    label: 'CAB Agenda Item',
    displayField: 'short_description',
    columns: [
      ref('meeting', 'Meeting', 'cab_meeting', { mandatory: true, cascade: 'delete' }),
      ref('task', 'Task', 'task', {
        mandatory: true,
        cascade: 'delete',
        referenceQual: 'sys_class_name=change_request',
      }),
      int('order', 'Order', { defaultValue: '100' }),
      typed('notification_recipients', 'Notification recipients', 'glide_list', { reference: 'sys_user' }),
      str('short_description', 'Short description', 160),
      str('state', 'State', 40, { choices: CHOICES.agendaState, defaultValue: 'pending' }),
      str('decision', 'Decision', 40, { choices: CHOICES.agendaDecision, choiceMode: 'dropdown_with_none' }),
      typed('allotted_time', 'Allotted time', 'glide_duration'),
      typed('elapsed_time', 'Elapsed time', 'glide_duration', { readOnly: true }),
    ],
  },
  {
    name: 'cab_attendee',
    label: 'CAB Attendee',
    displayField: 'attendee',
    columns: [
      ref('meeting', 'Meeting', 'cab_meeting', { mandatory: true, cascade: 'delete' }),
      ref('attendee', 'Attendee', 'sys_user', { mandatory: true }),
      str('attendee_type', 'Attendee type', 40, {
        choices: CHOICES.attendeeType,
        defaultValue: 'board_member',
      }),
      str('response', 'Response', 40, { choices: CHOICES.attendeeResponse, defaultValue: 'no_response' }),
      bool('connected', 'Connected', false, { readOnly: true }),
    ],
  },
];

// ------------------------------------------------------ DevOps pipelines

const pipelineTables: TableDef[] = [
  {
    name: 'resolvr_change_pipeline',
    label: 'Pipeline Change Gate',
    plural: 'Pipeline Change Gates',
    displayField: 'pipeline',
    audit: true,
    columns: [
      str('pipeline', 'Pipeline', 255, { mandatory: true }),
      str('build', 'Build', 100),
      str('commit', 'Commit', 100),
      str('ci', 'Configuration item', 255),
      ref('change_request', 'Change request', 'change_request', { cascade: 'clear' }),
      ref('template', 'Standard change template', 'std_change_record_producer'),
      int('requested_risk', 'Requested risk', { choices: CHOICES.risk, choiceMode: 'dropdown_with_none' }),
      str('decision', 'Policy decision', 40, { choices: CHOICES.pipelineDecision }),
      str('status', 'Gate status', 40, { choices: CHOICES.pipelineStatus, defaultValue: 'pending' }),
      str('message', 'Message', 1000),
      typed('payload', 'Payload', 'json'),
    ],
  },
];

export const changeTables: TableDef[] = [
  changeRequest,
  changeTask,
  ...modelTables,
  ...standardTables,
  ...riskTables,
  ...scheduleTables,
  ...conflictTables,
  ...cabTables,
  ...pipelineTables,
];
