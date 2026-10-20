// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notification templates use ${field} placeholders
import type { PropertyDef } from '../../engine/services/properties.js';
import type { NotificationSeed } from '../incident/notifications.js';

const prop = (name: string, value: string, type: PropertyDef['type'], description: string): PropertyDef => ({
  name,
  value,
  type,
  description,
});

export const PROBLEM_PROPERTIES: PropertyDef[] = [
  prop(
    'problem.acceptrisk.move_to_closed',
    'true',
    'boolean',
    'Accept Risk closes the problem instead of resolving it',
  ),
  prop('problem.closed.can_create_tasks', 'false', 'boolean', 'Allow problem tasks on closed problems'),
  prop(
    'problem.closed.role.reanalyze_from_canceled',
    'problem_manager',
    'string',
    'Role that can re-analyze canceled problems',
  ),
  prop(
    'problem.closed.role.reanalyze_from_closed_riskaccepted',
    'problem_manager',
    'string',
    'Role that can re-analyze risk-accepted problems',
  ),
  prop(
    'problem.closed.role.reanalyze_from_completed',
    'problem_manager',
    'string',
    'Role that can re-analyze problems closed with a fix',
  ),
  prop(
    'problem.closed.cancel_open_tasks',
    'true',
    'boolean',
    'Cancel open problem tasks when the problem closes',
  ),
  prop(
    'problem_task.closed.role.reaassess_from_closed',
    'problem_coordinator',
    'string',
    'Role that can re-assess closed problem tasks',
  ),
  prop(
    'problem_task.closed.can_reassess_on_closed_problem',
    'false',
    'boolean',
    'Allow re-assessing tasks of closed problems',
  ),
  prop(
    'problem.fix.records',
    'change_request.parent,rm_defect.parent,rm_release.parent,rm_enhancement.parent,sn_cim_register.source_id',
    'string',
    'Records (table.field) tracked as fixes of a problem',
  ),
  prop(
    'problem.duplicate.records_to_move',
    'incident.problem_id,sn_customerservice_case.problem,problem_task.problem',
    'string',
    'Records (table.field) moved to the surviving problem when one is marked duplicate',
  ),
  prop(
    'problem.role.relate_closed_incidents',
    'problem_coordinator',
    'string',
    'Role that can relate closed incidents to a problem (nobody disables)',
  ),
  prop(
    'com.snc.problem.create_from_incident.attributes',
    'number,description,short_description,cmdb_ci,impact,urgency,priority,company,sys_domain,business_service,category,subcategory',
    'string',
    'Incident fields copied to a new problem (number becomes the origin task)',
  ),
  prop(
    'com.snc.problem.create_from_incident.copy_attachments',
    'false',
    'boolean',
    'Copy attachments and knowledge links to a problem created from an incident',
  ),
  prop(
    'com.snc.problem.create_from_interaction.save',
    'true',
    'boolean',
    'Save problems created from interactions immediately',
  ),
  prop(
    'glide.problem.interaction.allow_create',
    'false',
    'boolean',
    'Allow problems to be created from interactions',
  ),
  prop(
    'com.snc.problem.ci_assignment_group.field_name',
    'support_group',
    'string',
    'Configuration item column used to fill the assignment group',
  ),
  prop(
    'com.snc.problem.service_offering_assignment_group.field_name',
    'support_group',
    'string',
    'Service offering column used to fill the assignment group',
  ),
  prop(
    'com.snc.problem_management.models.enabled',
    'true',
    'boolean',
    'Use problem models (only the default models are supported)',
  ),
];

const ev = (name: string, description: string, table = 'problem') => ({ name, table, description });

export const PROBLEM_EVENTS = [
  ev('problem.inserted', 'A problem was created'),
  ev('problem.updated', 'A problem was updated'),
  ev('problem.assigned', 'Problem assigned (parm1: new assignee, parm2: previous)'),
  ev('problem.assigned.to.group', 'Problem assigned to a group (parm1: new group, parm2: previous)'),
  ev('problem.worknoted', 'Work note added to a problem'),
  ev('problem.state.changed', 'Problem state changed (parm1: new state, parm2: action)'),
  ev('problem.workaround.communicated', 'Workaround shared with incidents (parm1: incident count)'),
  ev('problem.fix.communicated', 'Fix shared with incidents (parm1: incident count)'),
  ev('problem.fix_records.completed', 'Every fix record of the problem is complete (parm1: coordinator)'),
  ev('problem_task.all_closed', 'The last open problem task closed (parm1: coordinator)'),
  ev('problem_task.assigned', 'Problem task assigned (parm1: new assignee)', 'problem_task'),
  ev('problem_task.assigned.to.group', 'Problem task assigned to a group (parm1: new group)', 'problem_task'),
  ev('problem_task.worknoted', 'Work note added to a problem task', 'problem_task'),
  ev(
    'incident.problem.workaround',
    'Problem workaround shared with the incident (parm1: recipients, parm2: problem)',
    'incident',
  ),
  ev(
    'incident.problem.fix',
    'Problem fix shared with the incident (parm1: recipients, parm2: problem)',
    'incident',
  ),
  ev(
    'incident.problem.resolved',
    'Incident resolved by its problem (parm1: recipients, parm2: problem)',
    'incident',
  ),
  ev(
    'incident.problem.risk_accepted',
    'Problem risk accepted (parm1: recipients, parm2: problem)',
    'incident',
  ),
];

const link = '<p><a href="${URI_REF}">Open ${number}</a></p>';

export const PROBLEM_NOTIFICATIONS: NotificationSeed[] = [
  {
    name: 'Problem assigned to me',
    table: 'problem',
    event: 'problem.assigned',
    fields: 'assigned_to',
    subject: 'Problem ${number} has been assigned to you',
    body: '<p>${short_description}</p><p>Priority: ${priority}</p>' + link,
  },
  {
    name: 'Problem assigned to my group',
    table: 'problem',
    event: 'problem.assigned.to.group',
    fields: 'assignment_group',
    condition: 'assigned_toISEMPTY',
    subject: 'Problem ${number} has been assigned to ${assignment_group}',
    body: '<p>${short_description}</p>' + link,
  },
  {
    name: 'Problem updated',
    table: 'problem',
    event: 'problem.state.changed',
    fields: 'assigned_to,work_notes_list',
    sendSelf: false,
    subject: 'Problem ${number} is now ${state}',
    body: '<p>${short_description}</p>' + link,
  },
  {
    name: 'All fix records completed',
    table: 'problem',
    event: 'problem.fix_records.completed',
    parm1: true,
    subject: 'Every fix for problem ${number} is complete',
    body:
      '<p>All changes and other fix records of ${number} are complete. Review the problem and resolve it.</p>' +
      link,
  },
  {
    name: 'All problem tasks completed',
    table: 'problem',
    event: 'problem_task.all_closed',
    parm1: true,
    subject: 'All tasks of problem ${number} are closed',
    body: '<p>The last open task of ${number} was closed.</p>' + link,
  },
  {
    name: 'Problem task assigned to me',
    table: 'problem_task',
    event: 'problem_task.assigned',
    fields: 'assigned_to',
    subject: 'Problem task ${number} has been assigned to you',
    body: '<p>${short_description}</p>' + link,
  },
  {
    name: 'Incident workaround from problem',
    table: 'incident',
    event: 'incident.problem.workaround',
    parm1: true,
    subject: 'A workaround is available for incident ${number}',
    body: '<p>${comments:1}</p>' + link,
  },
  {
    name: 'Incident fix from problem',
    table: 'incident',
    event: 'incident.problem.fix',
    parm1: true,
    subject: 'A fix is available for incident ${number}',
    body: '<p>${comments:1}</p>' + link,
  },
  {
    name: 'Incident resolved by problem',
    table: 'incident',
    event: 'incident.problem.resolved',
    parm1: true,
    subject: 'Incident ${number} has been resolved by a permanent fix',
    body: '<p>${close_notes}</p><p>${comments:1}</p>' + link,
  },
  {
    name: 'Incident problem risk accepted',
    table: 'incident',
    event: 'incident.problem.risk_accepted',
    parm1: true,
    subject: 'Problem behind incident ${number} was closed without a fix',
    body: '<p>${work_notes:1}</p>' + link,
  },
];
