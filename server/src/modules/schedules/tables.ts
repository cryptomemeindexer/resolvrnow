import type { ChoiceDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const SCHEDULE_TYPE_CHOICES: ChoiceDef[] = [
  c('excluded', 'Excluded', 1),
  c('maintenance', 'Maintenance', 2),
  c('blackout', 'Blackout', 3),
  c('roster', 'Roster', 4),
  c('on_call', 'On call', 5),
];

export const SPAN_TYPE_CHOICES: ChoiceDef[] = [
  c('exclude', 'Excluded', 1),
  c('maintenance', 'Maintenance', 2),
  c('blackout', 'Blackout', 3),
  c('appointment', 'Appointment', 4),
  c('meeting', 'Meeting', 5),
  c('call', 'Phone call', 6),
  c('time_off', 'Time off', 7),
  c('on_call', 'On call', 8),
];

export const SHOW_AS_CHOICES: ChoiceDef[] = [
  c('busy', 'Busy', 1),
  c('free', 'Free', 2),
  c('tentative', 'Tentative', 3),
  c('on_call', 'On call', 4),
];

/** Common IANA zones offered in pickers; any valid IANA id is accepted. */
export const TIME_ZONE_CHOICES: ChoiceDef[] = [
  'floating',
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
].map((z, i) => c(z, z === 'floating' ? 'Floating' : z, i + 1));

export const schedulesTables: TableDef[] = [
  sdkTable('cmn_schedule', {
    displayField: 'name',
    audit: true,
    textIndex: ['name', 'description'],
    patch: {
      name: { mandatory: true, indexed: true },
      type: { choices: SCHEDULE_TYPE_CHOICES, choiceMode: 'dropdown_with_none' },
    },
    columns: [
      {
        name: 'time_zone',
        label: 'Time zone',
        type: 'string',
        maxLength: 40,
        choices: TIME_ZONE_CHOICES,
        choiceMode: 'suggestion',
        hint: 'Empty or Floating: entries follow the time zone of whoever evaluates the schedule',
      },
      {
        name: 'parent',
        label: 'Parent',
        type: 'reference',
        reference: 'cmn_schedule',
        hint: 'Entries of the parent schedule also apply to this schedule',
      },
      { name: 'description', label: 'Description', type: 'string', maxLength: 1000 },
    ],
  }),
  sdkTable('cmn_schedule_span', {
    displayField: 'name',
    extensible: true,
    patch: {
      schedule: { mandatory: true, cascade: 'delete' },
      type: { choices: SPAN_TYPE_CHOICES },
      show_as: { choices: SHOW_AS_CHOICES },
      start_date_time: { mandatory: true, hint: 'Local wall-clock time, YYYYMMDDTHHMMSS' },
      end_date_time: { mandatory: true, hint: 'Local wall-clock time (exclusive), YYYYMMDDTHHMMSS' },
      repeat_until: { hint: 'Last date YYYYMMDD (inclusive); empty repeats forever' },
      days_of_week: { hint: 'Digits 1-7, 1 = Monday' },
      parent: { cascade: 'delete' },
    },
  }),
  {
    name: 'cmn_other_schedule',
    label: 'Child Schedule',
    displayField: 'child_schedule',
    columns: [
      {
        name: 'schedule',
        label: 'Schedule',
        type: 'reference',
        reference: 'cmn_schedule',
        mandatory: true,
        cascade: 'delete',
      },
      {
        name: 'child_schedule',
        label: 'Child schedule',
        type: 'reference',
        reference: 'cmn_schedule',
        mandatory: true,
        cascade: 'delete',
      },
      {
        name: 'type',
        label: 'Type',
        type: 'string',
        defaultValue: 'include',
        choices: [c('include', 'Include', 1), c('exclude', 'Exclude', 2)],
        choiceMode: 'dropdown_without_none',
      },
    ],
  },
  sdkTable('cmn_relative_duration', {
    displayField: 'name',
    patch: { name: { mandatory: true } },
  }),
];
