import type { ChoiceDef } from '../../engine/types.js';

const list = (pairs: [string, string][], dependentValue?: string): ChoiceDef[] =>
  pairs.map(([value, label], i) => ({
    value,
    label,
    sequence: i + 1,
    ...(dependentValue ? { dependentValue } : {}),
  }));

export const INCIDENT_STATE_CHOICES = list([
  ['1', 'New'],
  ['2', 'In Progress'],
  ['3', 'On Hold'],
  ['6', 'Resolved'],
  ['7', 'Closed'],
  ['8', 'Canceled'],
]);

export const HOLD_REASON_CHOICES = list([
  ['1', 'Awaiting Caller'],
  ['5', 'Awaiting Change'],
  ['3', 'Awaiting Problem'],
  ['4', 'Awaiting Vendor'],
]);

const ACTIVE_CLOSE_CODES = [
  'Duplicate',
  'Known error',
  'No resolution provided',
  'Resolved by caller',
  'Resolved by change',
  'Resolved by problem',
  'Resolved by request',
  'Solution provided',
  'Workaround provided',
  'User error',
  'Resolved - No response from caller',
];

/** Legacy codes stay valid for imports and REST writes but are not offered in pickers. */
const LEGACY_CLOSE_CODES = [
  'Solved (Work Around)',
  'Solved (Permanently)',
  'Solved Remotely (Work Around)',
  'Solved Remotely (Permanently)',
  'Not Solved (Not Reproducible)',
  'Not Solved (Too Costly)',
  'Closed/Resolved by Caller',
];

export const CLOSE_CODE_CHOICES: ChoiceDef[] = [
  ...ACTIVE_CLOSE_CODES.map((c, i) => ({ value: c, label: c, sequence: i + 1 })),
  ...LEGACY_CLOSE_CODES.map((c, i) => ({ value: c, label: c, sequence: 100 + i, inactive: true })),
];

export const CATEGORY_CHOICES = list([
  ['inquiry', 'Inquiry / Help'],
  ['software', 'Software'],
  ['hardware', 'Hardware'],
  ['network', 'Network'],
  ['database', 'Database'],
]);

export const SUBCATEGORY_CHOICES: ChoiceDef[] = [
  ...list(
    [
      ['antivirus', 'Antivirus'],
      ['email', 'Email'],
      ['internal application', 'Internal Application'],
    ],
    'inquiry',
  ),
  ...list(
    [
      ['email', 'Email'],
      ['os', 'Operating System'],
    ],
    'software',
  ),
  ...list(
    [
      ['cpu', 'CPU'],
      ['disk', 'Disk'],
      ['keyboard', 'Keyboard'],
      ['memory', 'Memory'],
      ['monitor', 'Monitor'],
      ['mouse', 'Mouse'],
    ],
    'hardware',
  ),
  ...list(
    [
      ['dhcp', 'DHCP'],
      ['dns', 'DNS'],
      ['ip address', 'IP Address'],
      ['vpn', 'VPN'],
      ['wireless', 'Wireless'],
    ],
    'network',
  ),
  ...list(
    [
      ['db2', 'DB2'],
      ['sql server', 'MS SQL Server'],
      ['oracle', 'Oracle'],
    ],
    'database',
  ),
].map((c, i) => ({ ...c, sequence: i + 1 }));

export const SEVERITY_CHOICES = list([
  ['1', '1 - High'],
  ['2', '2 - Medium'],
  ['3', '3 - Low'],
]);

export const CONTACT_TYPE_CHOICES = list([
  ['chat', 'Chat'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['monitoring', 'Monitoring'],
  ['self-service', 'Self-service'],
  ['virtual_agent', 'Virtual agent'],
  ['walk-in', 'Walk-in'],
]);

export const NOTIFY_CHOICES = list([
  ['1', 'Do Not Notify'],
  ['2', 'Send Email'],
]);

export const MIM_STATE_CHOICES = list([
  ['proposed', 'Proposed'],
  ['accepted', 'Accepted'],
  ['rejected', 'Rejected'],
  ['canceled', 'Canceled'],
]);

export const INCIDENT_TASK_STATE_CHOICES = list([
  ['-5', 'Pending'],
  ['1', 'Open'],
  ['2', 'Work in Progress'],
  ['3', 'Closed Complete'],
  ['4', 'Closed Incomplete'],
  ['7', 'Closed Skipped'],
]);

export const TRIGGER_ACTION_CHOICES = list([
  ['propose', 'Propose Major Incident'],
  ['promote', 'Promote Major Incident'],
]);

export const PLAN_STATE_CHOICES = list([
  ['1', 'Open'],
  ['3', 'Closed'],
  ['7', 'Canceled'],
]);

export const PLAN_TYPE_CHOICES = list([
  ['adhoc', 'Ad hoc'],
  ['end_user', 'End User'],
  ['stakeholder', 'Stakeholder'],
  ['technical', 'Technical'],
]);

export const COMM_TASK_STATE_CHOICES = list([
  ['-5', 'Pending'],
  ['1', 'Open'],
  ['2', 'In Progress'],
  ['3', 'Complete'],
  ['7', 'Skipped'],
]);

export const CHANNEL_CHOICES = list([
  ['email', 'Email'],
  ['sms', 'SMS'],
  ['conference', 'Conference'],
  ['slack', 'Slack'],
]);

export const FREQUENCY_CHOICES = list([
  ['once', 'Once'],
  ['recurring', 'Recurring'],
]);

export const OUTAGE_TYPE_CHOICES = list([
  ['outage', 'Outage'],
  ['degradation', 'Degradation'],
  ['planned', 'Planned'],
]);

/** Choice lists for inherited fields (applied as dictionary overrides by the platform). */
export const INCIDENT_MODULE_CHOICES: Record<string, ChoiceDef[]> = {
  'incident.state': INCIDENT_STATE_CHOICES,
  'incident.contact_type': CONTACT_TYPE_CHOICES,
  'incident_task.state': INCIDENT_TASK_STATE_CHOICES,
  'incident_alert.state': PLAN_STATE_CHOICES,
  'incident_alert_task.state': COMM_TASK_STATE_CHOICES,
};
