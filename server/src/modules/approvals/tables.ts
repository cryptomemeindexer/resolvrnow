import type { ColumnDef, TableDef } from '../../engine/types.js';
import {
  APPROVAL_STATE_CHOICES,
  APPROVAL_TABLE,
  GROUP_TABLE,
  ON_DUE_CHOICES,
  RULE_CHOICES,
  SOURCE_CHOICES,
  STEP_TABLE,
} from './constants.js';

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
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});

export const approvalTables: TableDef[] = [
  {
    name: APPROVAL_TABLE,
    label: 'Approval',
    plural: 'Approvals',
    description: 'One row per person asked to approve a record.',
    audit: true,
    displayField: 'document_id',
    columns: [
      ref('approver', 'Approver', 'sys_user'),
      str('state', 'State', {
        maxLength: 40,
        defaultValue: 'requested',
        choices: APPROVAL_STATE_CHOICES,
        choiceMode: 'dropdown_without_none',
        indexed: true,
      }),
      ref('sysapproval', 'Approval for', 'task'),
      { name: 'document_id', label: 'Approving', type: 'document_id', dependentOn: 'source_table' },
      { name: 'source_table', label: 'Source table', type: 'table_name', maxLength: 80 },
      { name: 'comments', label: 'Comments', type: 'journal_input', maxLength: 4000 },
      ref('group', 'Group', GROUP_TABLE),
      int('order', 'Order', { defaultValue: 100 }),
      dt('due_date', 'Due date'),
      dt('expected_start', 'Expected start'),
      str('approval_column', 'Approval column', { maxLength: 80, defaultValue: 'approval' }),
      str('approval_journal_column', 'Approval journal column', {
        maxLength: 80,
        defaultValue: 'approval_history',
      }),
      str('approval_source', 'Approval source', { maxLength: 40, choices: SOURCE_CHOICES }),
      int('iteration', 'Iteration', { defaultValue: 0 }),
      ref('flow_context', 'Flow', 'sys_flow_context'),
      str('wf_activity', 'Workflow activity', { maxLength: 32, internal: true }),
      // ResolvrNow extensions
      ref('resolvr_step', 'Approval step', STEP_TABLE),
      ref('resolvr_decided_by', 'Decided by', 'sys_user', { readOnly: true }),
      dt('resolvr_decided_on', 'Decided on', { readOnly: true }),
    ],
    indexes: [['document_id', 'iteration']],
  },
  {
    name: GROUP_TABLE,
    label: 'Group approval',
    plural: 'Group approvals',
    description: 'One row per approving group; member approvals point at it.',
    extends: 'task',
    columns: [
      str('resolvr_wait_for', 'Wait for', {
        maxLength: 40,
        defaultValue: 'first_response',
        choices: RULE_CHOICES,
      }),
      int('resolvr_percentage', 'Percentage'),
      ref('resolvr_step', 'Approval step', STEP_TABLE),
    ],
  },
  {
    name: STEP_TABLE,
    label: 'Approval Step',
    plural: 'Approval Steps',
    description: 'One approval request on a record (users and groups decided together under a rule).',
    displayField: 'label',
    columns: [
      { name: 'document_id', label: 'Approving', type: 'document_id', dependentOn: 'source_table' },
      { name: 'source_table', label: 'Source table', type: 'table_name', maxLength: 80 },
      int('iteration', 'Iteration', { defaultValue: 0 }),
      str('label', 'Label', { maxLength: 255 }),
      str('rule', 'Rule', { maxLength: 40, defaultValue: 'any', choices: RULE_CHOICES }),
      int('percentage', 'Percentage'),
      str('state', 'State', {
        maxLength: 40,
        defaultValue: 'requested',
        choices: APPROVAL_STATE_CHOICES,
        indexed: true,
      }),
      str('source', 'Source', { maxLength: 40, choices: SOURCE_CHOICES }),
      ref('flow_context', 'Flow', 'sys_flow_context'),
      dt('due_date', 'Due date', { indexed: true }),
      str('on_due', 'When due', { maxLength: 20, choices: ON_DUE_CHOICES }),
      str('approval_column', 'Approval column', { maxLength: 80, defaultValue: 'approval' }),
      str('journal_column', 'Journal column', { maxLength: 80, defaultValue: 'approval_history' }),
      dt('decided_on', 'Decided on'),
      ref('requested_by', 'Requested by', 'sys_user'),
    ],
  },
];
