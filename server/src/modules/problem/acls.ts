import type { RoleDef } from '../../engine/module.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import type { AclDef, AclOperation } from '../../engine/services/acl.js';
import { READ_ROLES, WRITE_ROLES } from './constants.js';

export const PROBLEM_ROLES: RoleDef[] = [
  { name: 'problem_task_analyst', description: 'Works problem tasks such as root cause analysis' },
  {
    name: 'problem_coordinator',
    description: 'Owns problems and their tasks through the lifecycle',
    contains: ['problem_task_analyst', 'itil'],
  },
  {
    name: 'problem_manager',
    description: 'Owns the problem process and re-analyzes closed problems',
    contains: ['problem_coordinator'],
  },
  {
    name: 'problem_admin',
    description: 'Configures Problem Management and can delete problems',
    contains: ['problem_manager'],
  },
  { name: 'sn_problem_read', description: 'Reads problems and related records' },
  {
    name: 'sn_problem_write',
    description: 'Creates and edits problems and problem tasks',
    contains: ['sn_problem_read'],
  },
  { name: 'problem_model_script_admin', description: 'Edits problem model condition scripts' },
];

const ops = (
  name: string,
  operations: AclOperation[],
  roles: string[],
  extra: Partial<AclDef> = {},
): AclDef[] => operations.map((operation) => ({ name, operation, roles, ...extra }));

/** Table-level list access for everyone, so unprivileged list queries return no rows instead of failing. */
const listAccess = (name: string): AclDef => ({
  name,
  operation: 'read',
  script: (rec) => rec === null,
  description: 'List access only; rows need a problem reading role',
});

export const PROBLEM_ACLS: AclDef[] = [
  ...ops('problem', ['read'], READ_ROLES),
  listAccess('problem'),
  ...ops('problem', ['create', 'write'], WRITE_ROLES),
  ...ops('problem', ['delete'], ['problem_admin']),
  ...ops('problem_task', ['read'], READ_ROLES),
  listAccess('problem_task'),
  ...ops('problem_task', ['create'], [...WRITE_ROLES, 'problem_task_analyst']),
  ...ops('problem_task', ['write'], WRITE_ROLES),
  ...ops('problem_task', ['write'], ['problem_task_analyst'], {
    condition: 'assigned_to=javascript:gs.getUserID()',
  }),
  ...ops('problem_task', ['delete'], ['problem_admin']),
  ...ops('dl_problem_priority', ['read'], READ_ROLES),
  ...ops('dl_problem_priority', ['create', 'write', 'delete'], ['data_lookup_admin', 'problem_admin']),
  ...[
    'prb_model',
    'prb_task_model',
    'prb_model_state',
    'prb_model_transition',
    'prb_model_transition_condition',
  ].flatMap((t) => [
    ...ops(t, ['read'], READ_ROLES),
    ...ops(t, ['create', 'write', 'delete'], ['problem_admin']),
  ]),
];

/** Users without a problem reading role see no problems or problem tasks. */
export const PROBLEM_QUERY_RULES: BusinessRuleDef[] = ['problem', 'problem_task'].map(
  (table): BusinessRuleDef => ({
    name: `${table} query`,
    table,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([...READ_ROLES, 'admin'])) return;
      qb.addEncodedQuery('sys_id=-1');
    },
  }),
);
