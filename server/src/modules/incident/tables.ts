import type { ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import {
  CATEGORY_CHOICES,
  CHANNEL_CHOICES,
  CLOSE_CODE_CHOICES,
  FREQUENCY_CHOICES,
  HOLD_REASON_CHOICES,
  INCIDENT_STATE_CHOICES,
  MIM_STATE_CHOICES,
  NOTIFY_CHOICES,
  OUTAGE_TYPE_CHOICES,
  PLAN_TYPE_CHOICES,
  SEVERITY_CHOICES,
  SUBCATEGORY_CHOICES,
  TRIGGER_ACTION_CHOICES,
} from './choices.js';

const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  maxLength: 255,
  ...extra,
});
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});
const bool = (
  name: string,
  label: string,
  defaultValue: boolean,
  extra: Partial<ColumnDef> = {},
): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: defaultValue ? 'true' : 'false',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});

/** Columns the major incident extension adds to incident (not part of the SDK schema). */
const mimColumns: ColumnDef[] = [
  str('major_incident_state', 'Major incident state', {
    maxLength: 40,
    choices: MIM_STATE_CHOICES,
    choiceMode: 'dropdown_with_none',
  }),
  ref('proposed_by', 'Proposed by', 'sys_user', { readOnly: true }),
  dt('proposed_on', 'Proposed', { readOnly: true }),
  ref('promoted_by', 'Promoted by', 'sys_user', { readOnly: true }),
  dt('promoted_on', 'Promoted', { readOnly: true }),
  { name: 'actions_taken', label: 'Actions taken', type: 'journal_input', maxLength: 4000 },
  { name: 'overview', label: 'Overview', type: 'html' },
  { name: 'lessons_learned', label: 'Findings', type: 'html' },
  { name: 'timeline', label: 'Timeline', type: 'html' },
  ref('trigger_rule', 'Trigger rule', 'major_incident_trigger_rule', { readOnly: true }),
];

export const incidentTable: TableDef = sdkTable('incident', {
  audit: true,
  displayField: 'number',
  number: { prefix: 'INC', start: 10000, digits: 7 },
  textIndex: ['number', 'short_description', 'description'],
  patch: {
    caller_id: { defaultValue: 'javascript:gs.getUserID()', indexed: true },
    category: { choices: CATEGORY_CHOICES, defaultValue: 'inquiry' },
    subcategory: { choices: SUBCATEGORY_CHOICES },
    close_code: { choices: CLOSE_CODE_CHOICES },
    hold_reason: { choices: HOLD_REASON_CHOICES },
    incident_state: { choices: INCIDENT_STATE_CHOICES, defaultValue: '1' },
    severity: { choices: SEVERITY_CHOICES, defaultValue: '3' },
    notify: { choices: NOTIFY_CHOICES, defaultValue: '1' },
    child_incidents: { readOnly: true, defaultValue: '0' },
    reopen_count: { readOnly: true, defaultValue: '0' },
    resolved_at: { readOnly: true },
    resolved_by: { readOnly: true },
    parent_incident: { referenceQual: 'active=true' },
  },
  columns: mimColumns,
  overrides: {
    state: { defaultValue: '1' },
    contact_type: { label: 'Channel' },
    close_notes: { label: 'Resolution notes' },
    priority: { readOnly: true },
  },
});

export const incidentTaskTable: TableDef = {
  name: 'incident_task',
  label: 'Incident Task',
  extends: 'task',
  columns: [ref('incident', 'Incident', 'incident', { mandatory: true, cascade: 'delete' })],
  overrides: { state: { defaultValue: '1' } },
};

export const triggerRuleTable: TableDef = {
  name: 'major_incident_trigger_rule',
  label: 'Major Incident Trigger Rule',
  displayField: 'name',
  columns: [
    str('name', 'Name', { mandatory: true, unique: true, maxLength: 100 }),
    { name: 'table', label: 'Table', type: 'table_name', defaultValue: 'incident' },
    int('order', 'Execution Order', { defaultValue: '100' }),
    str('action', 'Action to take', {
      maxLength: 40,
      defaultValue: 'propose',
      choices: TRIGGER_ACTION_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
    bool('active', 'Active', false),
    { name: 'condition', label: 'Conditions', type: 'conditions', dependentOn: 'table' },
    { name: 'description', label: 'Description', type: 'string', maxLength: 1000 },
  ],
};

export const strikeTable: TableDef = {
  name: 'resolvr_incident_strike',
  label: 'Incident Caller Strike',
  columns: [
    ref('incident', 'Incident', 'incident', { mandatory: true, cascade: 'delete' }),
    int('attempts', 'Attempts', { defaultValue: '0' }),
    dt('next_due', 'Next due'),
  ],
};

const commDefinitionColumns = (extra: ColumnDef[]): ColumnDef[] => [
  str('name', 'Name', { mandatory: true, maxLength: 100 }),
  ...extra,
  int('order', 'Order', { defaultValue: '100' }),
  bool('active', 'Active', true),
];

export const commTables: TableDef[] = [
  {
    name: 'comm_plan_definition',
    label: 'Communication Plan Definition',
    displayField: 'name',
    columns: commDefinitionColumns([
      { name: 'table', label: 'Table', type: 'table_name', defaultValue: 'incident' },
      { name: 'condition', label: 'Conditions', type: 'conditions', dependentOn: 'table' },
      str('type', 'Type', { maxLength: 40, choices: PLAN_TYPE_CHOICES, choiceMode: 'dropdown_with_none' }),
      str('short_description', 'Plan title', { maxLength: 160 }),
    ]),
  },
  {
    name: 'comm_task_definition',
    label: 'Communication Task Definition',
    displayField: 'name',
    columns: commDefinitionColumns([
      ref('comm_plan_definition', 'Communication plan definition', 'comm_plan_definition', {
        mandatory: true,
        cascade: 'delete',
      }),
      str('channel', 'Channel', {
        maxLength: 40,
        defaultValue: 'email',
        choices: CHANNEL_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      str('communication_frequency', 'Communication frequency', {
        maxLength: 40,
        defaultValue: 'once',
        choices: FREQUENCY_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      { name: 'due_in', label: 'Due in', type: 'glide_duration' },
    ]),
  },
  {
    name: 'comm_plan',
    label: 'Communication Plan',
    extends: 'task',
    extensible: true,
    columns: [ref('comm_plan_definition', 'Communication plan definition', 'comm_plan_definition')],
  },
  {
    name: 'comm_task',
    label: 'Communication Task',
    extends: 'task',
    extensible: true,
    columns: [
      ref('comm_plan', 'Communication plan', 'comm_plan'),
      ref('comm_task_definition', 'Communication task definition', 'comm_task_definition', {
        readOnly: true,
      }),
      str('channel', 'Channel', {
        maxLength: 40,
        defaultValue: 'email',
        choices: CHANNEL_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      str('communication_frequency', 'Communication frequency', {
        maxLength: 40,
        defaultValue: 'once',
        choices: FREQUENCY_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      { name: 'due_in', label: 'Due in', type: 'glide_duration' },
      dt('last_communication_sent', 'Last communication sent', { readOnly: true }),
      int('times_performed', 'Times performed', { defaultValue: '0', readOnly: true }),
    ],
  },
  {
    name: 'incident_alert',
    label: 'Incident Communication Plan',
    extends: 'comm_plan',
    number: { prefix: 'ICP', start: 10000, digits: 7 },
    columns: [
      ref('source_incident', 'Source incident', 'incident', { indexed: true }),
      str('type', 'Type', {
        maxLength: 40,
        defaultValue: 'adhoc',
        choices: PLAN_TYPE_CHOICES,
        choiceMode: 'dropdown_with_none',
      }),
      { name: 'background', label: 'Background', type: 'html' },
      { name: 'actions_taken', label: 'Actions taken', type: 'journal_input', maxLength: 4000 },
    ],
    overrides: { state: { defaultValue: '1' } },
  },
  {
    name: 'incident_alert_task',
    label: 'Incident Communication Task',
    extends: 'comm_task',
    number: { prefix: 'ICT', start: 10000, digits: 7 },
    columns: [
      ref('incident_alert', 'Incident Communication Plan', 'incident_alert', {
        readOnly: true,
        cascade: 'delete',
      }),
      ref('source_incident', 'Source incident', 'incident', { readOnly: true }),
    ],
    overrides: { state: { defaultValue: '-5' } },
  },
];

export const outageTables: TableDef[] = [
  {
    name: 'cmdb_ci_outage',
    label: 'Outage',
    displayField: 'number',
    number: { prefix: 'OUT', start: 10000, digits: 7 },
    columns: [
      str('number', 'Number', { readOnly: true, maxLength: 40 }),
      ref('cmdb_ci', 'Configuration item', 'cmdb_ci', { mandatory: true }),
      str('type', 'Type', {
        maxLength: 40,
        defaultValue: 'outage',
        choices: OUTAGE_TYPE_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      dt('begin', 'Begin'),
      dt('end', 'End'),
      { name: 'duration', label: 'Duration', type: 'glide_duration', readOnly: true },
      ref('task_number', 'Task number', 'task'),
      str('short_description', 'Short description', { maxLength: 160 }),
    ],
  },
  {
    name: 'task_outage',
    label: 'Task Outage',
    columns: [
      ref('task', 'Task', 'task', { mandatory: true, cascade: 'delete' }),
      ref('outage', 'Outage', 'cmdb_ci_outage', { mandatory: true, cascade: 'delete' }),
    ],
  },
];

export const INCIDENT_TABLES: TableDef[] = [
  incidentTable,
  incidentTaskTable,
  triggerRuleTable,
  strikeTable,
  ...commTables,
  ...outageTables,
];
