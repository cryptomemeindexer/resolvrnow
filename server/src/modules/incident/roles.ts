import type { RoleDef } from '../../engine/module.js';

export const INCIDENT_ROLES: RoleDef[] = [
  { name: 'list_updater', description: 'Bulk updates from lists (resolve and close)' },
  { name: 'sn_incident_read', description: 'Reads all incidents and the major incident workbench' },
  { name: 'sn_incident_write', description: 'Creates and updates incidents', contains: ['sn_incident_read'] },
  { name: 'sn_incident_comments_write', description: 'Adds comments to incidents' },
  { name: 'sn_incident_task_assigned_user', description: 'Works the incident tasks assigned to the user' },
  {
    name: 'incident_manager',
    description: 'Manages incident properties, trigger rules and plan definitions',
    contains: ['ia_admin', 'sn_incident_write'],
  },
  {
    name: 'sn_incident_admin',
    description: 'Configures Incident Management',
    contains: ['incident_manager'],
  },
  {
    name: 'major_incident_manager',
    description: 'Accepts, rejects, demotes and closes major incidents',
    contains: ['ia_admin', 'sn_incident_write'],
  },
  {
    name: 'sn_mim_admin',
    description: 'Configures Major Incident Management',
    contains: ['major_incident_manager', 'sn_iam_admin'],
  },
  {
    name: 'communication_manager',
    description: 'Runs stakeholder communications',
    contains: ['ia_admin', 'sn_incident_write'],
  },
  { name: 'contact_user', description: 'Uses communication contacts' },
  { name: 'contact_admin', description: 'Manages communication contacts', contains: ['contact_user'] },
  {
    name: 'ia_admin',
    description: 'Manages incident communication plans and tasks',
    contains: ['contact_admin'],
  },
  { name: 'sn_iam_admin', description: 'Administers incident communications', contains: ['ia_admin'] },
  {
    name: 'business_stakeholder',
    description: 'Reads and approves across ITSM',
    contains: ['sn_incident_read', 'approver_user', 'sn_incident_comments_write'],
  },
  { name: 'sn_task_outage_admin', description: 'Administers task outages' },
  { name: 'data_lookup_admin', description: 'Maintains data lookup tables such as the priority matrix' },
  { name: 'assignment_rule_admin', description: 'Maintains assignment rules' },
];
