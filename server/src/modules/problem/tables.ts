import type { ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import { TASK_CHOICES } from '../task/index.js';
import {
  CATEGORY_CHOICES,
  CAUSE_CODE_CHOICES,
  CONDITION_REQUIRES_CHOICES,
  PROBLEM_STATE_MIRROR_CHOICES,
  PROBLEM_TASK_CLOSE_CODE_CHOICES,
  PROBLEM_TASK_TYPE_CHOICES,
  RESOLUTION_CODE_CHOICES,
  SUBCATEGORY_CHOICES,
  TASK_MODEL_TYPE_CHOICES,
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
const bool = (name: string, label: string, defaultValue: boolean): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: defaultValue ? 'true' : 'false',
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});

export const problemTable: TableDef = sdkTable('problem', {
  audit: true,
  displayField: 'number',
  number: { prefix: 'PRB', start: 40000, digits: 7 },
  textIndex: ['number', 'short_description', 'description'],
  patch: {
    category: { choices: CATEGORY_CHOICES },
    subcategory: { choices: SUBCATEGORY_CHOICES },
    resolution_code: { choices: RESOLUTION_CODE_CHOICES },
    problem_state: { choices: PROBLEM_STATE_MIRROR_CHOICES, defaultValue: '101', readOnly: true },
    prb_model: { defaultValue: undefined },
    related_incidents: { readOnly: true, defaultValue: '0' },
    known_error: { defaultValue: 'false' },
    duplicate_of: { referenceQual: 'duplicate_ofISEMPTY^active=true' },
    first_reported_by_task: { referenceQual: 'active=true' },
    primary_known_error_article: { readOnly: true },
  },
  overrides: {
    state: { defaultValue: '101', readOnly: true },
    short_description: { label: 'Problem statement' },
    close_notes: { label: 'Resolution notes' },
    priority: { readOnly: true },
  },
});

export const problemTaskTable: TableDef = {
  name: 'problem_task',
  label: 'Problem Task',
  extends: 'task',
  number: { prefix: 'PTASK', start: 10000, digits: 7 },
  columns: [
    ref('problem', 'Source problem', 'problem', { mandatory: true, indexed: true }),
    str('problem_task_type', 'Type', {
      maxLength: 40,
      defaultValue: 'general',
      choices: PROBLEM_TASK_TYPE_CHOICES,
      choiceMode: 'dropdown_with_none',
    }),
    str('cause_code', 'Cause code', {
      maxLength: 40,
      choices: CAUSE_CODE_CHOICES,
      choiceMode: 'dropdown_with_none',
    }),
    { name: 'workaround', label: 'Workaround', type: 'html' },
    { name: 'fix_notes', label: 'Proposed fix notes', type: 'html' },
    str('close_code', 'Close code', {
      maxLength: 40,
      readOnly: true,
      choices: PROBLEM_TASK_CLOSE_CODE_CHOICES,
      choiceMode: 'dropdown_with_none',
    }),
    ref('prb_task_model', 'Model', 'prb_task_model'),
    int('reopen_count', 'Reopen count', { defaultValue: '0', readOnly: true }),
  ],
  overrides: {
    state: { defaultValue: '151', readOnly: true },
    closed_by: { label: 'Completed by' },
    closed_at: { label: 'Completed' },
  },
};

export const problemPriorityTable: TableDef = {
  name: 'dl_problem_priority',
  label: 'Problem Priority Data Lookup',
  displayField: 'priority',
  columns: [
    int('impact', 'Impact', { choices: TASK_CHOICES.impact, choiceMode: 'dropdown_without_none' }),
    int('urgency', 'Urgency', { choices: TASK_CHOICES.urgency, choiceMode: 'dropdown_without_none' }),
    int('priority', 'Priority', { choices: TASK_CHOICES.priority, choiceMode: 'dropdown_without_none' }),
    int('order', 'Order', { defaultValue: '100' }),
    bool('active', 'Active', true),
  ],
};

const modelColumns = (extra: ColumnDef[]): ColumnDef[] => [
  str('name', 'Name', { mandatory: true, unique: true, maxLength: 100 }),
  ...extra,
  bool('active', 'Active', true),
  { name: 'description', label: 'Description', type: 'string', maxLength: 4000 },
  bool('advanced_security', 'Advanced Security', false),
  { name: 'read_roles', label: 'Read Roles', type: 'user_roles' },
  { name: 'write_roles', label: 'Write Roles', type: 'user_roles' },
];

/** Problem and problem task models. Only the default models (equal to the built-in lifecycle) are used in v1. */
export const modelTables: TableDef[] = [
  {
    name: 'prb_model',
    label: 'Problem Model',
    displayField: 'name',
    columns: modelColumns([bool('default_model', 'Default problem model', false)]),
  },
  {
    name: 'prb_task_model',
    label: 'Problem Task Model',
    displayField: 'name',
    columns: modelColumns([
      str('problem_task_type', 'Problem task type', {
        maxLength: 40,
        defaultValue: 'model',
        choices: TASK_MODEL_TYPE_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      bool('default_model', 'Default problem task model', false),
    ]),
  },
  {
    name: 'prb_model_state',
    label: 'Model State',
    displayField: 'state',
    columns: [
      { name: 'model_table', label: 'Model table', type: 'table_name', mandatory: true },
      { name: 'model', label: 'Model', type: 'document_id', dependentOn: 'model_table', mandatory: true },
      int('state', 'State', { mandatory: true }),
      bool('initial_state', 'Initial state', false),
    ],
  },
  {
    name: 'prb_model_transition',
    label: 'Model State Transition',
    columns: [
      ref('from_state', 'From', 'prb_model_state', { mandatory: true, cascade: 'delete' }),
      ref('to_state', 'To', 'prb_model_state', { mandatory: true, cascade: 'delete' }),
      bool('automatic', 'Automatic transition', false),
    ],
  },
  {
    name: 'prb_model_transition_condition',
    label: 'Model State Transition Condition',
    displayField: 'name',
    columns: [
      str('name', 'Name', { mandatory: true, maxLength: 100 }),
      ref('transition', 'State Transition', 'prb_model_transition', { mandatory: true, cascade: 'delete' }),
      { name: 'description', label: 'Description', type: 'string', maxLength: 4000 },
      str('requires', 'Requires', {
        maxLength: 40,
        defaultValue: 'condition',
        choices: CONDITION_REQUIRES_CHOICES,
        choiceMode: 'dropdown_without_none',
      }),
      { name: 'condition', label: 'Condition', type: 'conditions' },
      { name: 'script', label: 'Condition (Script)', type: 'script' },
      bool('active', 'Active', true),
    ],
  },
];

export const PROBLEM_TABLES: TableDef[] = [
  problemTable,
  problemTaskTable,
  problemPriorityTable,
  ...modelTables,
];
