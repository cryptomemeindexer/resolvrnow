import type { ChoiceDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import { TIME_ZONE_CHOICES } from '../schedules/tables.js';

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const STAGE_CHOICES: ChoiceDef[] = [
  c('in_progress', 'In progress', 1),
  c('paused', 'Paused', 2),
  c('cancelled', 'Cancelled', 3),
  c('completed', 'Completed', 4),
  c('breached', 'Breached', 5),
  c('achieved', 'Achieved', 6),
];

export const slaTables: TableDef[] = [
  sdkTable('contract_sla', {
    displayField: 'name',
    audit: true,
    textIndex: ['name'],
    patch: {
      name: { mandatory: true, indexed: true },
      collection: { mandatory: true, indexed: true },
      duration_type: { choices: undefined, choiceMode: undefined, hint: 'Empty: user specified duration' },
      timezone: {
        choices: TIME_ZONE_CHOICES.filter((z) => z.value !== 'floating'),
        choiceMode: 'suggestion',
      },
    },
  }),
  sdkTable('task_sla', {
    displayField: 'sla',
    patch: {
      task: { mandatory: true, cascade: 'delete' },
      sla: { mandatory: true },
      stage: { choices: STAGE_CHOICES, choiceMode: 'dropdown_without_none' },
      has_breached: { defaultValue: 'false' },
      pause_duration: { defaultValue: 0 },
      business_pause_duration: { defaultValue: 0 },
    },
    indexes: [
      ['task', 'active'],
      ['active', 'stage', 'planned_end_time'],
    ],
  }),
  sdkTable('sla_condition_class', {
    label: 'SLA Condition Rule',
    displayField: 'name',
    patch: { name: { mandatory: true } },
  }),
  {
    name: 'resolvr_sla_timer',
    label: 'SLA Percentage Timer',
    displayField: 'threshold',
    columns: [
      {
        name: 'task_sla',
        label: 'Task SLA',
        type: 'reference',
        reference: 'task_sla',
        mandatory: true,
        cascade: 'delete',
      },
      { name: 'threshold', label: 'Threshold (%)', type: 'integer', mandatory: true },
      { name: 'fire_at', label: 'Fire at', type: 'glide_date_time', mandatory: true, indexed: true },
      {
        name: 'state',
        label: 'State',
        type: 'string',
        defaultValue: 'pending',
        choices: [c('pending', 'Pending', 1), c('fired', 'Fired', 2), c('cancelled', 'Cancelled', 3)],
        choiceMode: 'dropdown_without_none',
      },
    ],
    indexes: [['state', 'fire_at']],
  },
  {
    name: 'sla_repair_log',
    label: 'SLA Repair Log',
    displayField: 'started',
    columns: [
      { name: 'initiated_by', label: 'Initiated by', type: 'reference', reference: 'sys_user' },
      { name: 'started', label: 'Start', type: 'glide_date_time' },
      { name: 'finished', label: 'End', type: 'glide_date_time' },
      {
        name: 'state',
        label: 'State',
        type: 'string',
        defaultValue: 'in_progress',
        choices: [c('in_progress', 'In progress', 1), c('complete', 'Complete', 2), c('error', 'Error', 3)],
        choiceMode: 'dropdown_without_none',
      },
      { name: 'request', label: 'Request', type: 'string', maxLength: 4000 },
    ],
  },
  {
    name: 'sla_repair_log_entry',
    label: 'SLA Repair Log Entry',
    displayField: 'type',
    columns: [
      {
        name: 'repair_log',
        label: 'Repair log',
        type: 'reference',
        reference: 'sla_repair_log',
        mandatory: true,
        cascade: 'delete',
      },
      {
        name: 'type',
        label: 'Type',
        type: 'string',
        mandatory: true,
        choices: [c('before', 'Before repair', 1), c('after', 'After repair', 2)],
        choiceMode: 'dropdown_without_none',
      },
      { name: 'task', label: 'Task', type: 'reference', reference: 'task' },
      { name: 'task_sla_id', label: 'Task SLA sys_id', type: 'string', maxLength: 32 },
      { name: 'sla', label: 'SLA definition', type: 'reference', reference: 'contract_sla' },
      { name: 'values', label: 'Values', type: 'json' },
    ],
  },
];
