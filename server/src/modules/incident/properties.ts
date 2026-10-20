import type { PropertyDef } from '../../engine/services/properties.js';

const bool = (name: string, value: boolean, description: string): PropertyDef => ({
  name,
  value: String(value),
  type: 'boolean',
  description,
});
const int = (name: string, value: number, description: string): PropertyDef => ({
  name,
  value: String(value),
  type: 'integer',
  description,
});
const str = (name: string, value: string, description: string): PropertyDef => ({
  name,
  value,
  type: 'string',
  description,
});

export const INCIDENT_PROPERTIES: PropertyDef[] = [
  int(
    'glide.ui.autoclose.time',
    7,
    'Days after which resolved incidents are closed automatically (0 disables auto-close)',
  ),
  bool(
    'com.snc.incident.autoclose.basedon.resolved_at',
    true,
    'Auto-close counts from the resolved time (false: from the last update)',
  ),
  bool(
    'resolvr.incident.autoclose.business_days',
    false,
    'Count the auto-close delay in business days (weekdays) instead of calendar days',
  ),
  str(
    'resolvr.incident.autoclose.run_as',
    'system',
    'User name recorded as the closer by the auto-close job',
  ),
  bool(
    'com.snc.incident.incident_task.closure',
    true,
    'Close open incident tasks when the incident is closed or canceled',
  ),
  int(
    'com.snc.incident.strike.count',
    3,
    'Reminders sent to an unresponsive caller before the incident is resolved (0 disables)',
  ),
  int('com.snc.incident.strike.wait_period', 1, 'Business days between caller reminders'),
  bool(
    'com.snc.incident.incident_alert.closure',
    false,
    'Close or cancel open communication plans together with the incident',
  ),
  bool(
    'com.snc.iam.incident_alert_task.closure',
    false,
    'Complete or skip open communication tasks when their plan closes',
  ),
  str(
    'com.snc.incident.clone_fields_on_reopen',
    '',
    'Fields cloned into a new incident when a closed one is reopened by email (empty disables)',
  ),
  bool('com.snc.incident.copy.enable', true, 'Offer the Copy Incident action'),
  bool('com.snc.incident.create.child.enable', true, 'Offer the Create Child Incident action'),
  bool('com.snc.incident.copy.attach', false, 'Copy attachments when copying an incident'),
  str(
    'com.snc.incident.copy.attributes',
    'category,subcategory,business_service,cmdb_ci,impact,urgency,assignment_group,short_description,description,caused_by,location,company,problem_id,rfc,parent_incident',
    'Fields copied by Copy Incident and Create Child Incident',
  ),
  str(
    'com.snc.incident.copy.related_lists',
    'task_ci,task_cmdb_ci_service,task_service_offering',
    'Related lists copied with an incident',
  ),
  str(
    'com.snc.incident.copy.rl.task_ci.attributes',
    'ci_item',
    'Affected CI columns copied with an incident',
  ),
  str(
    'com.snc.incident.copy.rl.task_cmdb_ci_services.attributes',
    'cmdb_ci_service,manually_added',
    'Impacted service columns copied with an incident',
  ),
  str(
    'com.snc.incident.ci_assignment_group.field_name',
    'support_group',
    'Configuration item column used to fill the assignment group',
  ),
  str(
    'com.snc.incident.service_offering_assignment_group.field_name',
    'support_group',
    'Service offering column used to fill the assignment group',
  ),
  bool(
    'com.snc.incident.communicate_prb_workaround_to_inc_worknotes',
    false,
    'Problem workarounds and fixes reach incidents as work notes instead of comments',
  ),
  bool(
    'com.snc.incident.create_from_interaction.save',
    true,
    'Save incidents created from interactions immediately',
  ),
  bool(
    'com.snc.incident.create_from_interaction.copy_attachments',
    true,
    'Copy interaction attachments to the incident',
  ),
  str('glide.ui.incident_activity.fields', '', 'Fields shown in the incident activity stream'),
  str(
    'sn_major_inc_mgmt.com.snc.incident.mim.major_incident_creation',
    'promote',
    'promote: the candidate becomes the major incident; create_new: a new major incident is created with the candidate as child',
  ),
  str(
    'sn_major_inc_mgmt.major_incident_management_group',
    '',
    'Group (sys_id) that receives major incidents',
  ),
  str(
    'sn_major_inc_mgmt.com.snc.major_incident.create.copy.attributes',
    'short_description,description,category,subcategory,impact,urgency,cmdb_ci,business_service',
    'Fields copied into a new major incident',
  ),
  str(
    'sn_major_inc_mgmt.com.snc.incident.mim.compose_email_on_iatasks',
    'email',
    'Communication task channels that offer Compose Email',
  ),
  str('sn_major_inc_mgmt.pir_export_pdf_ui_page', '', 'Custom page used to export the post incident report'),
  str(
    'sn_comm_management.default_email_recipient_field',
    'bcc',
    'Recipient field used for communication emails',
  ),
  bool(
    'sn_comm_management.email_client_recipient_items_enabled',
    false,
    'Offer recipient lists on communication emails',
  ),
  bool('sow_email_notification_redirect', false, 'Email links open the agent workspace'),
  bool(
    'sn_major_inc_mgmt.sow_email_notification_redirect.mim',
    false,
    'Email links about major incidents open the agent workspace',
  ),
  bool(
    'resolvr.incident.assign_moves_to_in_progress',
    true,
    'Setting Assigned to on a New incident moves it to In Progress',
  ),
  str(
    'resolvr.incident.business_schedule',
    '',
    'Schedule (sys_id) used for business resolve time; empty means calendar time',
  ),
];
