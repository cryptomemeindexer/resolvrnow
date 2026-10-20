import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { AclDef, AclOperation } from '../../engine/services/acl.js';
import { articleFacts } from './access.js';
import { knowledge, PROTECTED_FIELDS } from './service.js';
import { CRITERIA_TABLES } from './tables.js';

const svcOf = (ctx: Context) => knowledge(ctx.platform);
const CRUD: AclOperation[] = ['read', 'write', 'create', 'delete'];
const WRITE_OPS: AclOperation[] = ['write', 'create', 'delete'];

/** The base a record belongs to (criteria relationships, templates per base). */
const kbOf = (rec: Rec | null) => rec?.str('kb_knowledge_base') ?? '';

function categoryWrite(rec: Rec | null, ctx: Context, op: AclOperation): boolean {
  const svc = svcOf(ctx);
  if (!rec) return ctx.hasRole('knowledge');
  const kbId =
    rec.str('parent_table') === 'kb_category'
      ? svc.access.categoryKb(rec.str('parent_id'))
      : rec.str('parent_id');
  if (svc.access.isPrivileged(ctx, kbId)) return true;
  if (op === 'delete') return false;
  const kb = svc.kbRecord(kbId);
  return !!kb && !kb.bool('disable_category_editing') && svc.access.canContributeKb(ctx, kbId);
}

export const knowledgeAcls: AclDef[] = [
  // Articles: user criteria, state-based visibility and contribution rules (see access.ts).
  {
    name: 'kb_knowledge',
    operation: 'read',
    script: (rec, ctx) => !rec || svcOf(ctx).access.canSeeArticle(ctx, articleFacts(rec)),
    description: 'Readers see live articles of readable bases; drafts only for authors and base managers',
  },
  {
    name: 'kb_knowledge',
    operation: 'create',
    script: (rec, ctx) => svcOf(ctx).access.canCreateArticle(ctx, rec),
    description: 'Contributors of the base',
  },
  {
    name: 'kb_knowledge',
    operation: 'write',
    script: (rec, ctx) => !!rec && svcOf(ctx).access.canEditArticle(ctx, articleFacts(rec)),
    description: 'Authors edit drafts; published versions change through new versions',
  },
  {
    name: 'kb_knowledge',
    operation: 'delete',
    script: (rec, ctx) => !!rec && svcOf(ctx).access.canDeleteArticle(ctx, articleFacts(rec)),
    description: 'Only admin deletes published articles',
  },
  ...PROTECTED_FIELDS.map(
    (f): AclDef => ({
      name: `kb_knowledge.${f}`,
      operation: 'write',
      roles: ['admin'],
      description: 'Maintained by the knowledge application',
    }),
  ),
  {
    name: 'kb_knowledge.confidence',
    operation: 'write',
    roles: ['knowledge_coach', 'knowledge_admin', 'kcs_contributor', 'kcs_publisher'],
  },

  // Knowledge bases and categories.
  {
    name: 'kb_knowledge_base',
    operation: 'read',
    script: (rec, ctx) =>
      !rec || svcOf(ctx).access.isPrivileged(ctx, rec.sysId) || svcOf(ctx).access.canReadKb(ctx, rec.sysId),
  },
  { name: 'kb_knowledge_base', operation: 'create', roles: ['knowledge_admin'] },
  {
    name: 'kb_knowledge_base',
    operation: 'write',
    script: (rec, ctx) => !!rec && svcOf(ctx).access.canManageKb(ctx, rec.sysId),
  },
  { name: 'kb_knowledge_base', operation: 'delete', roles: ['knowledge_admin'] },
  {
    name: 'kb_category',
    operation: 'read',
    script: (rec, ctx) => {
      if (!rec) return true;
      const svc = svcOf(ctx);
      const kbId = svc.access.categoryKb(rec.sysId);
      return svc.access.isPrivileged(ctx, kbId) || svc.access.canReadKb(ctx, kbId);
    },
  },
  ...WRITE_OPS.map(
    (operation): AclDef => ({
      name: 'kb_category',
      operation,
      script: (rec, ctx) => categoryWrite(rec, ctx, operation),
    }),
  ),

  // User criteria and base access lists.
  { name: 'user_criteria', operation: 'read', roles: ['knowledge', 'user_criteria_admin', 'catalog_admin'] },
  ...WRITE_OPS.map(
    (operation): AclDef => ({
      name: 'user_criteria',
      operation,
      roles: ['knowledge_admin', 'user_criteria_admin'],
    }),
  ),
  ...Object.values(CRITERIA_TABLES).flatMap((name): AclDef[] => [
    { name, operation: 'read', roles: ['knowledge'] },
    ...WRITE_OPS.map(
      (operation): AclDef => ({
        name,
        operation,
        script: (rec, ctx) =>
          rec ? svcOf(ctx).access.canManageKb(ctx, kbOf(rec)) : ctx.hasRole('knowledge'),
      }),
    ),
  ]),

  // Versions and summaries follow the article.
  {
    name: 'kb_version',
    operation: 'read',
    script: (rec, ctx) => {
      if (!rec) return true;
      const article = rec.ref('knowledge');
      return !!article && svcOf(ctx).access.canSeeArticle(ctx, articleFacts(article));
    },
  },
  { name: 'kb_knowledge_summary', operation: 'read', roles: ['knowledge'] },

  // Feedback: readers give feedback on what they can read; flags stay with authors and managers.
  {
    name: 'kb_feedback',
    operation: 'read',
    script: (rec, ctx) => !rec || svcOf(ctx).access.canReadFeedback(ctx, rec),
  },
  {
    name: 'kb_feedback',
    operation: 'create',
    script: (rec, ctx) => !rec || svcOf(ctx).feedbackDenial(ctx, rec) === null,
  },
  ...(['write', 'delete'] as const).map(
    (operation): AclDef => ({
      name: 'kb_feedback',
      operation,
      script: (rec, ctx) =>
        !!rec &&
        ((!!ctx.user.sysId && rec.str('user') === ctx.user.sysId) || svcOf(ctx).access.isKnowledgeAdmin(ctx)),
    }),
  ),
  { name: 'm2m_kb_feedback_likes', operation: 'read' },
  ...(['create', 'delete'] as const).map(
    (operation): AclDef => ({
      name: 'm2m_kb_feedback_likes',
      operation,
      condition: 'user=javascript:gs.getUserID()',
    }),
  ),

  // Feedback tasks: knowledge workers and agents; submitters and assignees see their own.
  ...(['read', 'write', 'create'] as const).map(
    (operation): AclDef => ({ name: 'kb_feedback_task', operation, roles: ['knowledge', 'itil'] }),
  ),
  { name: 'kb_feedback_task', operation: 'read', condition: 'opened_by=javascript:gs.getUserID()' },
  { name: 'kb_feedback_task', operation: 'read', condition: 'assigned_to=javascript:gs.getUserID()' },
  { name: 'kb_feedback_task', operation: 'write', condition: 'assigned_to=javascript:gs.getUserID()' },
  { name: 'kb_feedback_task', operation: 'delete', roles: ['admin'] },
  ...(['read', 'write', 'create'] as const).map(
    (operation): AclDef => ({ name: 'kb_submission', operation, roles: ['knowledge', 'itil'] }),
  ),
  { name: 'kb_submission', operation: 'read', condition: 'opened_by=javascript:gs.getUserID()' },
  { name: 'kb_submission', operation: 'delete', roles: ['knowledge_admin'] },

  // Usage and search logs (written by the application).
  ...(['kb_use', 'ts_query_kb'] as const).flatMap((name): AclDef[] => [
    { name, operation: 'read', roles: ['knowledge_manager', 'knowledge_admin'] },
    { name, operation: 'read', condition: 'user=javascript:gs.getUserID()' },
  ]),

  // Article relationships.
  ...(['read', 'create', 'delete'] as const).map(
    (operation): AclDef => ({ name: 'm2m_kb_task', operation, roles: ['itil', 'knowledge'] }),
  ),
  ...(['kb_2_kb', 'kb_2_sc', 'm2m_kb_ci'] as const).flatMap((name): AclDef[] => [
    { name, operation: 'read' },
    ...WRITE_OPS.map((operation): AclDef => ({ name, operation, roles: ['knowledge'] })),
  ]),
  ...(['kb_keyword', 'kb_knowledge_keyword'] as const).flatMap((name): AclDef[] => [
    { name, operation: 'read' },
    ...WRITE_OPS.map(
      (operation): AclDef => ({ name, operation, roles: ['knowledge_manager', 'knowledge_admin'] }),
    ),
  ]),

  // Templates and table maps.
  ...(['kb_article_template', 'kb_article_template_definition', 'm2m_kb_template_kb'] as const).flatMap(
    (name): AclDef[] => [
      { name, operation: 'read' },
      ...WRITE_OPS.map((operation): AclDef => ({ name, operation, roles: ['knowledge_admin'] })),
    ],
  ),
  ...(['csm_table_map', 'csm_field_map'] as const).flatMap((name): AclDef[] =>
    CRUD.map(
      (operation): AclDef => ({
        name,
        operation,
        roles: operation === 'read' ? ['knowledge_admin'] : ['admin'],
      }),
    ),
  ),
];
