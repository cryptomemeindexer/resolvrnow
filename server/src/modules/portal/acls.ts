import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import type { AclDef, AclOperation } from '../../engine/services/acl.js';
import { ROLES, T, UR_AGENT_ROLES } from './constants.js';

const ME = 'javascript:gs.getUserID()';
const WRITE_OPS: AclOperation[] = ['write', 'create', 'delete'];

const ops = (name: string, operations: AclOperation[], extra: Partial<AclDef>): AclDef[] =>
  operations.map((operation) => ({ name, operation, ...extra }));

/** The requester side of a universal request: opened for, or opened by, the current user. */
export function isUrRequester(rec: Rec | null, ctx: Context): boolean {
  const me = ctx.user.sysId;
  return !!rec && !!me && (rec.str('opened_for') === me || rec.str('opened_by') === me);
}

export function isUrAgent(ctx: Context): boolean {
  return ctx.user.isSystem || ctx.hasAnyRole([...UR_AGENT_ROLES, 'admin']);
}

const SURVEY_READERS = [ROLES.surveyAdmin, ROLES.surveyReader];

/** Fields a requester may provide when raising a universal request through the Table API. */
const UR_CREATE_FIELDS = [
  'short_description',
  'description',
  'opened_for',
  'contact_type',
  'watch_list',
  'comments',
  'resolvr_topic',
];

export const PORTAL_ACLS: AclDef[] = [
  // Portal content: readable by every internal user, maintained by portal administrators.
  ...[T.taxonomy, T.topic, T.content].flatMap((name) => [
    { name, operation: 'read' as const, roles: ['snc_internal'] },
    ...ops(name, WRITE_OPS, { roles: [ROLES.taxonomyAdmin] }),
  ]),
  ...[T.quickLink, T.announcement].flatMap((name) => [
    { name, operation: 'read' as const, roles: ['snc_internal'] },
    ...ops(name, WRITE_OPS, { roles: [ROLES.portalAdmin] }),
  ]),
  ...[T.tour, T.tourStep].flatMap((name) => [
    { name, operation: 'read' as const, roles: ['snc_internal'] },
    ...ops(name, WRITE_OPS, { roles: [ROLES.tourAdmin] }),
  ]),

  // Favorites belong to their user.
  ...ops(T.favorite, ['read', 'write', 'create', 'delete'], {
    condition: `user=${ME}`,
    description: 'Users manage their own favorites',
  }),

  // Universal requests
  { name: T.ur, operation: 'create', description: 'Any authenticated user can raise a universal request' },
  { name: T.ur, operation: 'read', roles: UR_AGENT_ROLES },
  {
    name: T.ur,
    operation: 'read',
    condition: `opened_for=${ME}`,
    description: 'Requesters read their universal requests',
  },
  {
    name: T.ur,
    operation: 'read',
    condition: `opened_by=${ME}`,
    description: 'Openers read the universal requests they raised',
  },
  {
    name: T.ur,
    operation: 'read',
    condition: `watch_listLIKE${ME}`,
    description: 'Watch list members read the universal request',
  },
  { name: T.ur, operation: 'write', roles: UR_AGENT_ROLES },
  {
    name: T.ur,
    operation: 'write',
    script: (rec, ctx) => isUrRequester(rec, ctx) && (!rec || rec.bool('active')),
    description: 'Requesters update their own open universal requests (comments)',
  },
  { name: T.ur, operation: 'delete', roles: [ROLES.urAdmin] },
  { name: `${T.ur}.*`, operation: 'write', roles: UR_AGENT_ROLES },
  {
    name: `${T.ur}.comments`,
    operation: 'write',
    script: (rec, ctx) => !rec || isUrAgent(ctx) || isUrRequester(rec, ctx),
    description: 'Agents, and requesters on their own universal requests',
  },
  { name: `${T.ur}.work_notes`, operation: 'read', roles: UR_AGENT_ROLES },
  { name: `${T.ur}.work_notes`, operation: 'write', roles: UR_AGENT_ROLES },
  { name: `${T.ur}.*`, operation: 'create', roles: UR_AGENT_ROLES },
  ...UR_CREATE_FIELDS.map((f): AclDef => ({ name: `${T.ur}.${f}`, operation: 'create' })),

  // Universal request configuration
  ...[T.urMapping, T.urDepartment, T.urService].flatMap((name) => [
    { name, operation: 'read' as const, roles: [...UR_AGENT_ROLES, ROLES.urAdmin] },
    ...ops(name, WRITE_OPS, { roles: [ROLES.urAdmin] }),
  ]),

  // Surveys: definitions are public to employees; answers belong to the person who was asked.
  ...[T.survey, T.question].flatMap((name) => [
    { name, operation: 'read' as const, roles: ['snc_internal'] },
    ...ops(name, WRITE_OPS, { roles: [ROLES.surveyAdmin] }),
  ]),
  { name: T.instance, operation: 'read', roles: SURVEY_READERS },
  {
    name: T.instance,
    operation: 'read',
    condition: `user=${ME}`,
    description: 'Users read the surveys sent to them',
  },
  { name: T.instance, operation: 'write', roles: [ROLES.surveyAdmin] },
  {
    name: T.instance,
    operation: 'write',
    condition: `user=${ME}^stateINready,wip`,
    description: 'Users take the surveys sent to them',
  },
  ...ops(T.instance, ['create', 'delete'], { roles: [ROLES.surveyAdmin] }),
  { name: T.result, operation: 'read', roles: SURVEY_READERS },
  { name: T.result, operation: 'read', condition: `user=${ME}`, description: 'Users read their own answers' },
  ...ops(T.result, WRITE_OPS, { roles: [ROLES.surveyAdmin] }),
  ...ops(T.trigger, ['read', ...WRITE_OPS], { roles: [ROLES.surveyAdmin] }),
];

/** Row filters for users who only see their own records. */
export const PORTAL_QUERY_RULES: BusinessRuleDef[] = [
  {
    name: 'universal request query',
    table: T.ur,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || isUrAgent(ctx)) return;
      const me = ctx.user.sysId;
      qb.addEncodedQuery(me ? `opened_for=${me}^ORopened_by=${me}^ORwatch_listLIKE${me}` : 'sys_id=-1');
    },
  },
  {
    name: 'portal favorite query',
    table: T.favorite,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasRole('admin')) return;
      qb.addEncodedQuery(`user=${ctx.user.sysId ?? '-1'}`);
    },
  },
  ...[T.instance, T.result].map(
    (table): BusinessRuleDef => ({
      name: `${table} query`,
      table,
      when: 'before',
      actions: ['query'],
      query(qb, ctx) {
        if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([...SURVEY_READERS, 'admin'])) return;
        qb.addEncodedQuery(`user=${ctx.user.sysId ?? '-1'}`);
      },
    }),
  ),
];
