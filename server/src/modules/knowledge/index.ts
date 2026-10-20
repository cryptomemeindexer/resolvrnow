import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { AppModule, RoleDef } from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import type { EventHandlerDef } from '../../engine/services/events.js';
import type { PropertyDef } from '../../engine/services/properties.js';
import { SERVICES } from '../contracts.js';
import { taskStates } from '../task/index.js';
import { knowledgeAcls } from './acls.js';
import { registerKnowledgeApi } from './api.js';
import { loadKnowledgeDemo } from './demo.js';
import { knowledgeRules } from './rules.js';
import { KnowledgeService, knowledge } from './service.js';
import { CRITERIA_TABLES, knowledgeChoices, knowledgeTables, TEMPLATE_CLASSES } from './tables.js';
import { knowledgeUi } from './ui.js';
import { ARTICLE, escapeHtml } from './util.js';

export { KnowledgeService, knowledge } from './service.js';

const prop = (name: string, value: string, type: PropertyDef['type'], description: string): PropertyDef => ({
  name,
  value,
  type,
  description,
});

const properties: PropertyDef[] = [
  prop(
    'glide.knowman.versioning.enabled',
    'true',
    'boolean',
    'Article versioning: new versions are created from published articles',
  ),
  prop(
    'glide.knowman.versioning.enable_minor_edits',
    'false',
    'boolean',
    'Base owners and managers may make minor edits to published articles',
  ),
  prop(
    'glide.knowman.versioning.minor_edit_fields',
    'valid_to',
    'string',
    'Fields that a minor edit may change (comma separated)',
  ),
  prop(
    'glide.knowman.view_age.days',
    '30',
    'integer',
    'Days of views counted in the article view count (0 = all time)',
  ),
  prop(
    'glide.knowman.block_access_with_no_user_criteria',
    'true',
    'boolean',
    'Deny access to knowledge bases without user criteria',
  ),
  prop(
    'glide.knowman.apply_article_read_criteria',
    'false',
    'boolean',
    'Apply article read criteria to base contributors as well',
  ),
  prop(
    'glide.knowman.search.apply_role_based_security',
    'true',
    'boolean',
    'Respect the Roles field of articles',
  ),
  prop(
    'glide.knowman.search.apply_acls',
    'true',
    'boolean',
    'Apply access rules to knowledge search results',
  ),
  prop(
    'glide.knowman.search.operator',
    'and_then_or',
    'string',
    'Multi-word search: and, or, or and_then_or (AND, then OR when nothing matches)',
  ),
  prop('glide.knowman.order.search', 'relevancy', 'string', 'Default order of search results'),
  prop(
    'glide.knowman.enable_approval_notification',
    'true',
    'boolean',
    'Send approval emails for knowledge approvals',
  ),
  prop(
    'glide.knowman.enable_article_replacement_on_retire',
    'true',
    'boolean',
    'Redirect readers of retired articles to the replacement article',
  ),
  prop(
    'glide.knowman.feedback.enable_actionable_feedback_for_flag',
    'true',
    'boolean',
    'Create a feedback task when an article is flagged',
  ),
  prop(
    'glide.knowman.feedback.enable_actionable_feedback_for_helpful',
    'false',
    'boolean',
    'Create a feedback task when an article is marked not helpful',
  ),
  prop(
    'glide.knowman.feedback.enable_actionable_feedback_for_rating',
    '',
    'integer',
    'Create a feedback task for ratings at or below this value (empty = off)',
  ),
  prop(
    'glide.knowman.feedback.enable_explicit_feedback',
    'false',
    'boolean',
    'Only create feedback tasks when the reader typed details',
  ),
  prop(
    'glide.knowman.feedback.display_threshold',
    '100',
    'integer',
    'Maximum number of comments shown on an article',
  ),
  prop(
    'glide.knowman.max_comments_per_user_daily',
    '',
    'integer',
    'Maximum comments per user per day (empty = unlimited)',
  ),
  prop(
    'glide.knowman.show_rating_options',
    'true',
    'boolean',
    'Show the rating and feedback block on articles',
  ),
  prop('glide.knowman.show_yn_rating', 'true', 'boolean', 'Show the Helpful yes/no question'),
  prop('glide.knowman.show_star_rating', 'true', 'boolean', 'Show the five-star rating'),
  prop('glide.knowman.show_flag', 'true', 'boolean', 'Show Flag Article'),
  prop('glide.knowman.show_user_feedback', 'true', 'boolean', 'Show and allow article comments'),
  prop('glide.knowman.use_live_feed', 'true', 'boolean', 'Comments use the live feed'),
  prop(
    'glide.knowman.submission.workflow',
    'false',
    'boolean',
    'Knowledge from tasks creates a submission instead of a draft article',
  ),
  prop(
    'glide.knowman.task_kb',
    '',
    'string',
    'Knowledge base (sys_id) for articles created from incidents and problems',
  ),
  prop(
    'glide.knowman.attach.fields',
    'comments',
    'string',
    'Task field that receives the article when it is attached to a task',
  ),
  prop(
    'glide.knowman.recent_tasks.display',
    'true',
    'boolean',
    'Show the tasks an article was recently attached to',
  ),
  prop('glide.knowman.recent_tasks', '5', 'integer', 'Number of recent tasks shown on an article'),
  prop('glide.knowman.enable_multi_language_search', 'false', 'boolean', 'Search in every language'),
  prop('glide.knowman.ownership_group.enabled', 'false', 'boolean', 'Show ownership groups on articles'),
  prop(
    'glide.knowman.ownership_group.allow_self_approval',
    'true',
    'boolean',
    'Ownership group members may approve their own articles',
  ),
  prop(
    'glide.knowman.enable_km_subscription',
    'true',
    'boolean',
    'Article subscriptions (recorded for a later release)',
  ),
  prop('glide.knowman.enable_km_subscription.roles', 'knowledge', 'string', 'Roles allowed to subscribe'),
  prop(
    'glide.knowman.enable_km_subscription.workflow_state',
    'draft,review,published',
    'string',
    'States that can be subscribed to',
  ),
  prop('glide.knowman.aqi_pass_score', '70', 'integer', 'Article quality pass mark'),
  prop(
    'glide.knowman.aqi.article_workflow_states',
    'draft,review,published',
    'string',
    'States checked by article quality reviews',
  ),
  prop(
    'glide.knowman.default_keyword',
    'homepage',
    'string',
    'Keyword of the featured articles on the knowledge home page',
  ),
  prop(
    'enable_kcs_incident',
    'false',
    'boolean',
    'Create Knowledge on incidents opens a KCS article through the table map',
  ),
  prop(
    'resolvr.km_api.require_auth',
    'false',
    'boolean',
    'Require authentication for the Knowledge API (otherwise public bases are served to anonymous callers)',
  ),
  prop(
    'resolvr.knowledge.article_url',
    '/sp?id=kb_article_view&sys_kb_id={sys_id}',
    'string',
    'Link to an article ({sys_id} and {number} are replaced)',
  ),
  prop(
    'resolvr.knowledge.known_error_kb',
    '',
    'string',
    'Knowledge base (sys_id) for known error articles; defaults to a base named Known Error',
  ),
];

const roles: RoleDef[] = [
  {
    name: 'knowledge',
    description: 'Knowledge contributor: writes and edits articles in bases they can contribute to',
  },
  {
    name: 'knowledge_manager',
    description: 'Manages knowledge bases: categories, featured content and approvals',
    contains: ['knowledge'],
  },
  {
    name: 'knowledge_admin',
    description: 'Administers all knowledge bases, criteria and templates; republishes retired articles',
    contains: ['knowledge'],
  },
  { name: 'knowledge_coach', description: 'Reviews and validates articles', contains: ['knowledge'] },
  {
    name: 'knowledge_domain_expert',
    description: 'Subject matter expert who writes and reviews articles',
    contains: ['knowledge'],
  },
  {
    name: 'knowledge_group_member',
    description: 'Approves and edits the articles of their ownership group',
    contains: ['knowledge'],
  },
  {
    name: 'knowledge_group_manager',
    description: 'Manages an ownership group; default assignee of its feedback tasks',
    contains: ['knowledge_group_member'],
  },
  { name: 'kcs_candidate', description: 'KCS licence: candidate', contains: ['knowledge'] },
  { name: 'kcs_contributor', description: 'KCS licence: contributor', contains: ['knowledge'] },
  { name: 'kcs_publisher', description: 'KCS licence: publisher', contains: ['knowledge'] },
];

const events = [
  {
    name: 'knowledge.created',
    table: ARTICLE,
    description: 'A knowledge article was created (parm1: source task, parm2: source table)',
  },
  { name: 'kb.article.published', table: ARTICLE, description: 'An article version was published' },
  { name: 'kb.article.retired', table: ARTICLE, description: 'An article was retired (parm2: replacement)' },
  { name: 'kb.article.approved', table: ARTICLE, description: 'Publishing an article was approved' },
  { name: 'kb.article.rejected', table: ARTICLE, description: 'Publishing an article was rejected' },
  {
    name: 'kb.article.expiry',
    table: ARTICLE,
    description: 'An article expires next month (parm2: valid to)',
  },
  {
    name: 'kb_feedback_task.commented',
    table: 'kb_feedback_task',
    description: 'The assignee asked the submitter for information',
  },
  {
    name: 'kb_feedback_task.resolved',
    table: 'kb_feedback_task',
    description: 'A feedback task was resolved; the submitter is asked to confirm',
  },
  {
    name: 'kb.submission.closed_created',
    table: 'kb_submission',
    description: 'A knowledge submission produced an article',
  },
  {
    name: 'kb.submission.closed_duplicate',
    table: 'kb_submission',
    description: 'A knowledge submission was closed as a duplicate',
  },
  {
    name: 'kb.submission.closed_invalid',
    table: 'kb_submission',
    description: 'A knowledge submission was closed as invalid',
  },
];

function mail(ctx: Context, rec: Rec | null, to: string[], subject: string, lines: string[]): void {
  const svc = knowledge(ctx.platform);
  const link = rec?.table.ancestors.includes(ARTICLE)
    ? `<p><a href="${escapeHtml(svc.absoluteArticleUrl(rec))}">Open the article</a></p>`
    : '';
  const body = lines
    .filter((l) => l.trim())
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('');
  svc.notify(ctx, to, subject, `${body}${link}`, rec);
}

const eventHandlers: EventHandlerDef[] = [
  {
    event: 'kb.article.approved',
    name: 'Knowledge: tell the author the article was approved',
    run(_ev, rec, ctx) {
      if (!rec) return;
      mail(ctx, rec, [rec.str('author'), rec.str('revised_by')], `Article ${rec.str('number')} approved`, [
        `"${rec.str('short_description')}" was approved and is now ${rec.display('workflow_state').toLowerCase()}.`,
      ]);
    },
  },
  {
    event: 'kb.article.rejected',
    name: 'Knowledge: tell the author the article was rejected',
    run(_ev, rec, ctx) {
      if (!rec) return;
      mail(
        ctx,
        rec,
        [rec.str('author'), rec.str('revised_by')],
        `Article ${rec.str('number')} returned to draft`,
        [
          `The review of "${rec.str('short_description')}" was rejected. The article is back in draft so you can update it and publish again.`,
        ],
      );
    },
  },
  {
    event: 'kb.article.expiry',
    name: 'Knowledge: articles expiring next month',
    run(ev, rec, ctx) {
      if (!rec) return;
      const kb = knowledge(ctx.platform).access.kb(rec.str('kb_knowledge_base'));
      mail(
        ctx,
        rec,
        [rec.str('author'), kb?.owner ?? '', ...(kb ? [...kb.managers] : [])],
        `Article ${rec.str('number')} expires on ${ev.parm2 ?? ''}`,
        [
          `"${rec.str('short_description')}" stops appearing in search after ${ev.parm2 ?? ''}. Review it and extend the Valid to date, or create a new version.`,
        ],
      );
    },
  },
  {
    event: 'kb_feedback_task.commented',
    name: 'Knowledge: ask the feedback submitter for information',
    run(ev, rec, ctx) {
      if (!rec || !ev.parm1) return;
      mail(ctx, rec, [ev.parm1], `${rec.str('number')}: more information needed about your feedback`, [
        ev.parm2 ?? '',
        'Reply to this email to answer.',
      ]);
    },
  },
  {
    event: 'kb_feedback_task.resolved',
    name: 'Knowledge: ask the feedback submitter to confirm the resolution',
    run(ev, rec, ctx) {
      if (!rec || !ev.parm1) return;
      mail(ctx, rec, [ev.parm1], `${rec.str('number')}: your article feedback was resolved`, [
        `Resolution: ${rec.display('resolution_code')}. ${rec.str('close_notes')}`,
        `Open ${rec.str('number')} to accept or reject the resolution.`,
      ]);
    },
  },
  ...(['closed_created', 'closed_duplicate', 'closed_invalid'] as const).map(
    (status): EventHandlerDef => ({
      event: `kb.submission.${status}`,
      name: `Knowledge: submission ${status.replace('closed_', '')}`,
      run(ev, rec, ctx) {
        if (!rec || !ev.parm1) return;
        const outcome =
          status === 'closed_created'
            ? 'was turned into a knowledge article'
            : status === 'closed_duplicate'
              ? 'duplicates an existing article'
              : 'was closed as not suitable for the knowledge base';
        mail(
          ctx,
          rec,
          [ev.parm1],
          `${rec.str('number')}: knowledge submission ${status.replace('closed_', '')}`,
          [`Your knowledge submission "${rec.str('short_description')}" ${outcome}.`, rec.str('close_notes')],
        );
      },
    }),
  ),
];

/** Fields indexed for full-text search. */
const INDEXED_FIELDS = ['number', 'short_description', 'text', 'wiki', 'meta'];

/** Knowledge bases, articles, versions, feedback and knowledge APIs. */
export const knowledgeModule: AppModule = {
  id: 'knowledge',
  name: 'Knowledge Management',
  description: 'Knowledge bases, articles, versions, feedback and knowledge APIs.',
  dependsOn: ['task'],
  tables: knowledgeTables,
  choices: knowledgeChoices,
  roles,
  acls: knowledgeAcls,
  rules: knowledgeRules,
  properties,
  events,
  eventHandlers,
  jobs: [
    {
      id: 'knowledge.scheduled_publish',
      name: 'Knowledge: publish scheduled articles',
      intervalMs: 5 * 60_000,
      run: (ctx) => {
        knowledge(ctx.platform).publishScheduled(ctx);
      },
    },
    {
      id: 'knowledge.view_counts',
      name: 'Knowledge: refresh article view counts',
      intervalMs: 3_600_000,
      run: (ctx) => {
        knowledge(ctx.platform).recomputeViewCounts();
      },
    },
    {
      id: 'knowledge.expiry',
      name: 'Knowledge: outdate expired articles and announce expiries',
      intervalMs: 24 * 3_600_000,
      run: (ctx) => {
        knowledge(ctx.platform).expireArticles(ctx);
      },
    },
  ],
  ui: knowledgeUi,
  register(platform) {
    const svc = new KnowledgeService(platform);
    platform.services.set(SERVICES.knowledge, svc);
    svc.search.ensureIndex();
    platform.hooks.on(['insert', 'update'], ARTICLE, 'knowledge-search-index', (rec, prev) => {
      if (prev && !INDEXED_FIELDS.some((f) => rec.changed(f))) return;
      svc.search.indexArticle(rec);
    });
    platform.hooks.on('delete', ARTICLE, 'knowledge-search-index', (rec) =>
      svc.search.removeArticle(rec.sysId),
    );
    for (const table of [
      'kb_knowledge_base',
      'kb_category',
      'user_criteria',
      'sys_user_role',
      ...Object.values(CRITERIA_TABLES),
    ]) {
      platform.hooks.on(['insert', 'update', 'delete'], table, 'knowledge-access-cache', () =>
        svc.access.invalidate(),
      );
    }
    taskStates(platform).register('kb_feedback_task', {
      closed: ['7', '8'],
      resolved: ['6'],
      defaultClosed: '7',
    });
  },
  afterBoot(platform) {
    const svc = knowledge(platform);
    svc.search.rebuildIfNeeded();
    svc.bindApprovals();
  },
  seedVersion: 1,
  seed(ctx) {
    const templates: {
      table: string;
      name: string;
      active: boolean;
      seo: string;
      fields: { field: string; label: string }[];
    }[] = [
      {
        table: ARTICLE,
        name: 'Standard',
        active: true,
        seo: 'text',
        fields: [{ field: 'text', label: 'Article body' }],
      },
      ...Object.entries(TEMPLATE_CLASSES).map(([table, t]) => ({
        table,
        name: t.name,
        active: false,
        seo: t.seo,
        fields: t.fields,
      })),
    ];
    for (const t of templates) {
      if (ctx.first('kb_article_template', `child_table=${t.table}`)) continue;
      const tpl = ctx.insert('kb_article_template', {
        name: t.name,
        child_table: t.table,
        active: t.active,
        seo_description_field: t.seo,
      });
      t.fields.forEach((f, i) => {
        ctx.insert('kb_article_template_definition', {
          template: tpl.sysId,
          field: f.field,
          label: f.label,
          order: (i + 1) * 100,
        });
      });
    }
    if (!ctx.first('kb_keyword', 'keyword=homepage')) ctx.insert('kb_keyword', { keyword: 'homepage' });
    if (!ctx.first('csm_table_map', 'source_table=incident^target_table=kb_template_incident_kcs_article')) {
      const map = ctx.insert('csm_table_map', {
        name: 'Incident to Incident KCS Article',
        source_table: 'incident',
        target_table: 'kb_template_incident_kcs_article',
        advanced: true,
      });
      for (const [source_field, target_field] of [
        ['sys_id', 'source'],
        ['short_description', 'short_description'],
        ['close_notes', 'kb_resolution'],
      ]) {
        ctx.insert('csm_field_map', { table_map: map.sysId, source_field, target_field });
      }
    }
  },
  demo(ctx) {
    loadKnowledgeDemo(ctx);
  },
  http(app, deps) {
    registerKnowledgeApi(app as FastifyInstance, deps as ApiDeps);
  },
};
