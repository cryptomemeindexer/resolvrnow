import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import type { AclDef, AclOperation } from '../../engine/services/acl.js';
import { AGENT_ROLES, CLOSED_STATES, READ_ROLES } from './constants.js';
import { isAgent } from './util.js';

const ME = 'javascript:gs.getUserID()';

const ownRow = (rec: Rec | null, ctx: Context): boolean =>
  !!rec &&
  !!ctx.user.sysId &&
  (rec.str('caller_id') === ctx.user.sysId || rec.str('opened_by') === ctx.user.sysId);
const notClosed = (rec: Rec | null): boolean =>
  !rec || !(CLOSED_STATES as readonly string[]).includes(rec.str('state'));

/** Fields a self-service user may fill when reporting an incident (portal, record producer, email). */
const SELF_SERVICE_CREATE_FIELDS = [
  'short_description',
  'description',
  'caller_id',
  'category',
  'subcategory',
  'impact',
  'urgency',
  'contact_type',
  'cmdb_ci',
  'business_service',
  'service_offering',
  'location',
  'company',
  'watch_list',
];
/** Fields a caller or opener may update on their own incident. */
const SELF_SERVICE_WRITE_FIELDS = ['short_description', 'watch_list', 'comments'];

const COMM_READ = ['itil', 'sn_incident_read', 'ia_admin', 'communication_manager', 'major_incident_manager'];
const COMM_MANAGE = ['ia_admin', 'major_incident_manager', 'communication_manager', 'incident_manager'];
const OUTAGE_READ = ['itil', 'sn_incident_read', 'sn_task_outage_admin'];

const ops = (
  name: string,
  operations: AclOperation[],
  roles: string[],
  extra: Partial<AclDef> = {},
): AclDef[] => operations.map((operation) => ({ name, operation, roles, ...extra }));

export const INCIDENT_ACLS: AclDef[] = [
  { name: 'incident', operation: 'create', description: 'Any authenticated user can report an incident' },
  { name: 'incident', operation: 'read', roles: READ_ROLES },
  {
    name: 'incident',
    operation: 'read',
    condition: `caller_id=${ME}`,
    description: 'Callers read their incidents',
  },
  {
    name: 'incident',
    operation: 'read',
    condition: `opened_by=${ME}`,
    description: 'Openers read the incidents they reported',
  },
  {
    name: 'incident',
    operation: 'read',
    condition: `watch_listLIKE${ME}`,
    description: 'Watch list members read the incident',
  },
  {
    name: 'incident',
    operation: 'write',
    roles: AGENT_ROLES,
    script: notClosed,
    description: 'Agents update open incidents',
  },
  {
    name: 'incident',
    operation: 'write',
    script: (rec, ctx) => ownRow(rec, ctx) && notClosed(rec),
    description: 'Callers and openers update their own open incidents',
  },
  { name: 'incident', operation: 'delete', roles: ['sn_incident_admin'] },
  { name: 'incident.*', operation: 'create', roles: AGENT_ROLES },
  ...SELF_SERVICE_CREATE_FIELDS.map((f): AclDef => ({ name: `incident.${f}`, operation: 'create' })),
  { name: 'incident.*', operation: 'write', roles: AGENT_ROLES },
  ...SELF_SERVICE_WRITE_FIELDS.map(
    (f): AclDef => ({
      name: `incident.${f}`,
      operation: 'write',
      script: (rec, ctx) => !rec || isAgent(ctx) || ownRow(rec, ctx),
      description: 'Agents, and callers or openers on their own incidents',
    }),
  ),
  ...['work_notes', 'actions_taken'].flatMap((f): AclDef[] => [
    { name: `incident.${f}`, operation: 'read', roles: READ_ROLES },
    { name: `incident.${f}`, operation: 'write', roles: AGENT_ROLES },
  ]),

  ...ops('incident_task', ['read', 'write', 'create'], AGENT_ROLES),
  { name: 'incident_task', operation: 'read', roles: ['sn_incident_read'] },
  ...ops('incident_task', ['read', 'write'], ['sn_incident_task_assigned_user'], {
    condition: `assigned_to=${ME}`,
  }),
  { name: 'incident_task', operation: 'delete', roles: ['sn_incident_admin'] },

  ...ops('major_incident_trigger_rule', ['read'], READ_ROLES),
  ...ops('major_incident_trigger_rule', ['write', 'create', 'delete'], ['incident_manager', 'sn_mim_admin']),
  ...ops('resolvr_incident_strike', ['read'], ['itil']),
  ...ops('resolvr_incident_strike', ['write', 'create', 'delete'], ['admin']),

  ...['comm_plan', 'comm_task'].flatMap((t) => [
    ...ops(t, ['read'], COMM_READ),
    ...ops(t, ['create', 'write'], COMM_MANAGE),
    ...ops(t, ['write'], ['itil'], {
      condition: `assigned_to=${ME}`,
      description: 'Assignees work their communication items',
    }),
    ...ops(t, ['delete'], ['ia_admin']),
  ]),
  ...['comm_plan_definition', 'comm_task_definition'].flatMap((t) => [
    ...ops(t, ['read'], COMM_READ),
    ...ops(t, ['create', 'write', 'delete'], ['ia_admin', 'incident_manager']),
  ]),
  ...['cmdb_ci_outage', 'task_outage'].flatMap((t) => [
    ...ops(t, ['read'], OUTAGE_READ),
    ...ops(t, ['create', 'write'], ['itil', 'sn_task_outage_admin']),
    ...ops(t, ['delete'], ['sn_task_outage_admin']),
  ]),
];

/** Users without an incident reading role only see incidents they reported, opened or watch. */
export const INCIDENT_QUERY_RULES: BusinessRuleDef[] = [
  {
    name: 'incident query',
    table: 'incident',
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([...READ_ROLES, 'admin'])) return;
      const me = ctx.user.sysId;
      qb.addEncodedQuery(me ? `caller_id=${me}^ORopened_by=${me}^ORwatch_listLIKE${me}` : 'sys_id=-1');
    },
  },
];
