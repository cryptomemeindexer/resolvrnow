import type { Context } from '../../engine/context.js';
import type { FormLayoutDef, ModuleUiDef, UiActionDef } from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import { articleFacts } from './access.js';
import { knowledge } from './service.js';
import { TEMPLATE_CLASSES } from './tables.js';

const svcOf = (ctx: Context) => knowledge(ctx.platform);
const state = (rec: Rec) => rec.str('workflow_state') || 'draft';
const recordRoute = (table: string, id: string) => `/workspace/record/${table}/${id}`;

const articleSections = (bodyFields: string[]): FormLayoutDef['sections'] => [
  {
    left: ['number', 'kb_knowledge_base', 'kb_category', 'author', 'ownership_group', 'language'],
    right: ['workflow_state', 'version', 'valid_to', 'scheduled_publish_date', 'published', 'retired'],
  },
  { fields: ['short_description', ...bodyFields] },
  {
    caption: 'Access and display',
    left: ['can_read_user_criteria', 'cannot_read_user_criteria', 'roles', 'meta', 'meta_description'],
    right: ['display_attachments', 'disable_commenting', 'disable_suggesting', 'article_type', 'image'],
  },
  {
    caption: 'Feedback and usage',
    left: ['sys_view_count', 'use_count', 'helpful_count'],
    right: ['rating', 'flagged', 'confidence', 'governance'],
  },
  {
    caption: 'Origin and versions',
    left: ['source', 'cmdb_ci', 'replacement_article'],
    right: ['base_version', 'revised_by', 'latest', 'parent'],
  },
];

const articleRelated: FormLayoutDef['relatedLists'] = [
  {
    table: 'kb_feedback',
    field: 'article',
    label: 'Feedback',
    columns: ['user', 'useful', 'rating', 'flagged', 'comments', 'sys_created_on'],
  },
  {
    table: 'kb_version',
    field: 'knowledge',
    label: 'Version history',
    columns: ['version', 'modified_by', 'modified_on'],
  },
  {
    table: 'm2m_kb_task',
    field: 'kb_knowledge',
    label: 'Attached to tasks',
    columns: ['task', 'sys_created_by', 'sys_created_on'],
  },
  {
    table: 'kb_feedback_task',
    field: 'article',
    label: 'Feedback tasks',
    columns: ['number', 'short_description', 'state', 'assigned_to'],
  },
  { table: 'kb_2_kb', field: 'kb_knowledge', label: 'Related articles', columns: ['related_kb_knowledge'] },
];

const articleActions: UiActionDef[] = [
  {
    id: 'knowledge.submit_for_review',
    table: 'kb_knowledge',
    label: 'Submit for review',
    actionName: 'kb_submit_for_review',
    style: 'primary',
    order: 10,
    condition: (rec, ctx) =>
      state(rec) === 'draft' &&
      svcOf(ctx).usesApproval(rec.str('kb_knowledge_base'), 'publish') &&
      svcOf(ctx).access.canEditArticle(ctx, articleFacts(rec)),
    run(rec, ctx) {
      return { message: svcOf(ctx).publish(ctx, rec).message };
    },
  },
  {
    id: 'knowledge.publish',
    table: 'kb_knowledge',
    label: 'Publish',
    actionName: 'kb_publish',
    style: 'primary',
    order: 10,
    condition: (rec, ctx) =>
      state(rec) === 'draft' &&
      !svcOf(ctx).usesApproval(rec.str('kb_knowledge_base'), 'publish') &&
      svcOf(ctx).access.canEditArticle(ctx, articleFacts(rec)),
    run(rec, ctx) {
      return { message: svcOf(ctx).publish(ctx, rec).message };
    },
  },
  {
    id: 'knowledge.recall',
    table: 'kb_knowledge',
    label: 'Recall',
    actionName: 'kb_recall',
    order: 20,
    condition: (rec, ctx) =>
      ['review', 'scheduled_publish'].includes(state(rec)) && svcOf(ctx).canRecall(ctx, rec),
    run(rec, ctx) {
      return { message: svcOf(ctx).recall(ctx, rec).message };
    },
  },
  {
    id: 'knowledge.checkout',
    table: 'kb_knowledge',
    label: 'Create new version',
    actionName: 'kb_checkout',
    order: 30,
    condition: (rec, ctx) =>
      state(rec) === 'published' && !svcOf(ctx).checkedOutRow(rec) && svcOf(ctx).canCheckout(ctx, rec),
    run(rec, ctx) {
      const r = svcOf(ctx).checkout(ctx, rec);
      return {
        message: r.message,
        redirect: recordRoute(r.article.className, r.article.sysId),
        record: { table: r.article.className, sys_id: r.article.sysId },
      };
    },
  },
  {
    id: 'knowledge.make_current',
    table: 'kb_knowledge',
    label: 'Make this current',
    actionName: 'kb_make_current',
    order: 30,
    condition: (rec, ctx) =>
      state(rec) === 'outdated' && !svcOf(ctx).checkedOutRow(rec) && svcOf(ctx).canMakeCurrent(ctx, rec),
    run(rec, ctx) {
      const r = svcOf(ctx).makeCurrent(ctx, rec);
      return {
        message: r.message,
        redirect: recordRoute(r.article.className, r.article.sysId),
        record: { table: r.article.className, sys_id: r.article.sysId },
      };
    },
  },
  {
    id: 'knowledge.view_latest',
    table: 'kb_knowledge',
    label: 'Go to latest version',
    order: 35,
    saveFirst: false,
    condition: (rec, ctx) => !rec.bool('latest') && svcOf(ctx).latestRow(rec) !== rec.sysId,
    run(rec, ctx) {
      const id = svcOf(ctx).latestRow(rec);
      return { redirect: recordRoute('kb_knowledge', id) };
    },
  },
  {
    id: 'knowledge.retire',
    table: 'kb_knowledge',
    label: 'Retire',
    actionName: 'kb_retire',
    style: 'destructive',
    order: 40,
    prompt: [{ field: 'replacement_article', label: 'Replacement article (optional)' }],
    condition: (rec, ctx) => state(rec) === 'published' && svcOf(ctx).canRetire(ctx, rec),
    run(rec, ctx, input) {
      const replacement = String(input.replacement_article ?? '').trim();
      return { message: svcOf(ctx).retire(ctx, rec, { replacement: replacement || null }).message };
    },
  },
  {
    id: 'knowledge.republish',
    table: 'kb_knowledge',
    label: 'Republish',
    actionName: 'kb_republish',
    order: 40,
    condition: (rec, ctx) => state(rec) === 'retired' && svcOf(ctx).access.isKnowledgeAdmin(ctx),
    run(rec, ctx) {
      return { message: svcOf(ctx).republish(ctx, rec).message };
    },
  },
  {
    id: 'knowledge.mark_helpful',
    table: 'kb_knowledge',
    label: 'Mark helpful',
    order: 60,
    saveFirst: false,
    condition: (rec, ctx) =>
      state(rec) === 'published' && !!ctx.user.sysId && svcOf(ctx).feedbackOptions(rec).helpful,
    run(rec, ctx) {
      ctx.insert('kb_feedback', { article: rec.sysId, useful: 'yes' });
      return { message: 'Thanks for your feedback' };
    },
  },
  {
    id: 'knowledge.flag',
    table: 'kb_knowledge',
    label: 'Flag article',
    order: 65,
    saveFirst: false,
    prompt: [{ field: 'flag_comments', label: 'What should be corrected or improved?', mandatory: true }],
    condition: (rec, ctx) =>
      state(rec) === 'published' && !!ctx.user.sysId && svcOf(ctx).feedbackOptions(rec).flag,
    run(rec, ctx, input) {
      ctx.insert('kb_feedback', {
        article: rec.sysId,
        flagged: true,
        reason: 'other',
        comments: String(input.flag_comments ?? ''),
      });
      return { message: 'The article was flagged for review' };
    },
  },
  {
    id: 'knowledge.attach_to_task',
    table: 'kb_knowledge',
    label: 'Attach to task',
    order: 70,
    saveFirst: false,
    roles: ['itil', 'knowledge'],
    prompt: [{ field: 'source', label: 'Task', mandatory: true }],
    condition: (rec) => ['published', 'outdated'].includes(state(rec)),
    run(rec, ctx, input) {
      const r = svcOf(ctx).attachToTask(ctx, rec, String(input.source ?? ''));
      return {
        message: r.attached
          ? `Attached to ${r.task.str('number')}`
          : `Already attached to ${r.task.str('number')}`,
      };
    },
  },
];

const taskActions: UiActionDef[] = [
  {
    id: 'knowledge.create_from_task',
    table: 'task',
    label: 'Create knowledge article',
    actionName: 'create_knowledge',
    order: 900,
    roles: ['itil', 'knowledge'],
    condition: (rec, ctx) =>
      !['kb_feedback_task', 'kb_submission'].includes(rec.className) && !svcOf(ctx).existingFromTask(rec),
    run(rec, ctx) {
      const r = svcOf(ctx).createFromTask(ctx, rec);
      if (!r) return { error: 'No knowledge base is available for new articles' };
      const what = r.table === 'kb_submission' ? 'Knowledge submission' : 'Draft article';
      return {
        message: `${what} created`,
        redirect: recordRoute(r.table, r.sysId),
        record: { table: r.table, sys_id: r.sysId },
      };
    },
  },
  {
    id: 'knowledge.create_known_error_article',
    table: 'problem',
    label: 'Create Known Error Article',
    actionName: 'create_known_error_article',
    order: 910,
    roles: ['admin', 'problem_admin', 'problem_coordinator', 'problem_manager'],
    condition: (rec) => rec.has('primary_known_error_article') && !rec.str('primary_known_error_article'),
    run(rec, ctx) {
      const r = svcOf(ctx).createKnownErrorArticle(ctx, rec);
      return {
        message: 'Known error article created',
        redirect: recordRoute(r.table, r.sysId),
        record: { table: r.table, sys_id: r.sysId },
      };
    },
  },
];

const feedbackTaskActions: UiActionDef[] = [
  {
    id: 'knowledge.feedback_task.resolve',
    table: 'kb_feedback_task',
    label: 'Resolve',
    style: 'primary',
    order: 10,
    prompt: [
      { field: 'resolution_code', mandatory: true },
      { field: 'close_notes', label: 'Resolution notes' },
    ],
    condition: (rec, ctx) =>
      ['1', '2', '3'].includes(rec.str('state')) &&
      (ctx.hasAnyRole(['knowledge', 'itil']) || rec.str('assigned_to') === ctx.user.sysId),
    run(rec, ctx, input) {
      ctx.update(rec, {
        state: '6',
        resolution_code: input.resolution_code,
        close_notes: input.close_notes ?? '',
      });
      return { message: 'Feedback task resolved; the submitter has been asked to confirm' };
    },
  },
  {
    id: 'knowledge.feedback_task.accept',
    table: 'kb_feedback_task',
    label: 'Accept resolution',
    style: 'primary',
    order: 20,
    saveFirst: false,
    condition: (rec, ctx) =>
      rec.str('state') === '6' && !!ctx.user.sysId && rec.str('opened_by') === ctx.user.sysId,
    run(rec, ctx) {
      ctx.elevated().update(rec, { state: '7', submitter_accepted: true });
      return { message: 'Thank you. The feedback task is closed.' };
    },
  },
  {
    id: 'knowledge.feedback_task.reject',
    table: 'kb_feedback_task',
    label: 'Reject resolution',
    order: 21,
    saveFirst: false,
    prompt: [{ field: 'comments', label: 'Why does this not resolve your feedback?', mandatory: true }],
    condition: (rec, ctx) =>
      rec.str('state') === '6' && !!ctx.user.sysId && rec.str('opened_by') === ctx.user.sysId,
    run(rec, ctx, input) {
      ctx
        .elevated()
        .update(rec, { state: '2', submitter_accepted: false, comments: String(input.comments ?? '') });
      return { message: 'The feedback task was reopened' };
    },
  },
  {
    id: 'knowledge.feedback_task.close',
    table: 'kb_feedback_task',
    label: 'Close',
    order: 30,
    condition: (rec, ctx) =>
      rec.str('state') === '6' &&
      (ctx.hasAnyRole(['knowledge', 'itil']) || rec.str('assigned_to') === ctx.user.sysId),
    run(rec, ctx) {
      ctx.update(rec, { state: '7' });
      return { message: 'Feedback task closed' };
    },
  },
];

const submissionActions: UiActionDef[] = [
  {
    id: 'knowledge.submission.create_article',
    table: 'kb_submission',
    label: 'Create article',
    style: 'primary',
    order: 10,
    roles: ['knowledge', 'itil'],
    condition: (rec) => ['1', '2'].includes(rec.str('status')),
    run(rec, ctx) {
      const art = svcOf(ctx).createFromSubmission(ctx, rec);
      return {
        message: `Draft ${art.str('number')} created`,
        redirect: recordRoute(art.className, art.sysId),
      };
    },
  },
  ...(
    [
      ['knowledge.submission.duplicate', 'Close as duplicate', 'closed_duplicate'],
      ['knowledge.submission.invalid', 'Close as invalid', 'closed_invalid'],
    ] as const
  ).map(
    ([id, label, status], i): UiActionDef => ({
      id,
      table: 'kb_submission',
      label,
      order: 20 + i,
      roles: ['knowledge', 'itil'],
      prompt: [{ field: 'close_notes', label: 'Notes for the submitter' }],
      condition: (rec) => ['1', '2'].includes(rec.str('status')),
      run(rec, ctx, input) {
        svcOf(ctx).closeSubmission(ctx, rec, status, String(input.close_notes ?? ''));
        return { message: `Submission ${label.toLowerCase().replace('close as ', 'closed as ')}` };
      },
    }),
  ),
];

const templateForms: FormLayoutDef[] = Object.entries(TEMPLATE_CLASSES).map(([table, t]) => ({
  table,
  highlights: ['workflow_state', 'version', 'kb_knowledge_base'],
  sections: articleSections(t.fields.map((f) => f.field)),
  relatedLists: articleRelated,
}));

export const knowledgeUi: ModuleUiDef = {
  navigation: [
    {
      id: 'knowledge',
      title: 'Knowledge',
      icon: 'book-open',
      roles: ['knowledge', 'itil'],
      order: 60,
      modules: [
        { title: 'Articles', table: 'kb_knowledge', query: 'latest=true^ORDERBYDESCsys_updated_on' },
        {
          title: 'My Drafts',
          table: 'kb_knowledge',
          query:
            'workflow_stateINdraft,review^author=javascript:gs.getUserID()^ORrevised_by=javascript:gs.getUserID()^ORDERBYDESCsys_updated_on',
        },
        {
          title: 'Pending review',
          table: 'kb_knowledge',
          query: 'workflow_stateINreview,pending_retirement^ORDERBYsys_updated_on',
          roles: ['knowledge_manager', 'knowledge_admin', 'knowledge_group_member'],
        },
        {
          title: 'Flagged articles',
          table: 'kb_knowledge',
          query: 'flagged=true^ORDERBYDESCsys_updated_on',
          roles: ['knowledge'],
        },
        {
          title: 'Create New',
          table: 'kb_knowledge',
          route: '/workspace/record/kb_knowledge/-1',
          roles: ['knowledge', 'itil'],
        },
        { title: 'Knowledge bases', table: 'kb_knowledge_base', query: 'ORDERBYtitle', separator: true },
        { title: 'Categories', table: 'kb_category', query: 'ORDERBYfull_category' },
        { title: 'Feedback', table: 'kb_feedback', query: 'ORDERBYDESCsys_created_on', roles: ['knowledge'] },
        {
          title: 'Feedback tasks',
          table: 'kb_feedback_task',
          query: 'active=true^ORDERBYDESCsys_created_on',
          roles: ['knowledge'],
        },
        {
          title: 'Submissions',
          table: 'kb_submission',
          query: 'active=true^ORDERBYDESCsys_created_on',
          roles: ['knowledge'],
        },
        { title: 'User criteria', table: 'user_criteria', query: 'ORDERBYname', roles: ['knowledge_admin'] },
        {
          title: 'Article templates',
          table: 'kb_article_template',
          query: 'ORDERBYname',
          roles: ['knowledge_admin'],
        },
        {
          title: 'Search log',
          table: 'ts_query_kb',
          query: 'ORDERBYDESCsys_created_on',
          roles: ['knowledge_manager', 'knowledge_admin'],
        },
      ],
    },
  ],
  lists: [
    {
      table: 'kb_knowledge',
      columns: [
        'number',
        'short_description',
        'kb_knowledge_base',
        'kb_category',
        'workflow_state',
        'version',
        'author',
        'sys_view_count',
        'rating',
        'sys_updated_on',
      ],
    },
    {
      table: 'kb_knowledge_base',
      columns: ['title', 'owner', 'kb_managers', 'resolvr_publish_flow', 'resolvr_retire_flow', 'active'],
    },
    { table: 'kb_category', columns: ['full_category', 'label', 'parent_id', 'active'] },
    {
      table: 'kb_feedback',
      columns: ['article', 'user', 'useful', 'rating', 'flagged', 'reason', 'comments', 'sys_created_on'],
    },
    {
      table: 'kb_feedback_task',
      columns: [
        'number',
        'short_description',
        'article',
        'state',
        'assigned_to',
        'resolution_code',
        'sys_created_on',
      ],
    },
    {
      table: 'kb_submission',
      columns: [
        'number',
        'short_description',
        'kb_knowledge_base',
        'status',
        'parent',
        'opened_by',
        'sys_created_on',
      ],
    },
    { table: 'kb_version', columns: ['knowledge', 'version', 'modified_by', 'modified_on'] },
    {
      table: 'kb_use',
      columns: ['article', 'user', 'viewed', 'used', 'times_viewed', 'task', 'sys_created_on'],
    },
    {
      table: 'ts_query_kb',
      columns: [
        'search_term',
        'results',
        'user',
        'sort_order',
        'highest_click_rank',
        'final_search_term',
        'sys_created_on',
      ],
    },
    {
      table: 'user_criteria',
      columns: ['name', 'user', 'group', 'role', 'department', 'location', 'company', 'match_all', 'active'],
    },
    { table: 'kb_article_template', columns: ['name', 'child_table', 'active'] },
    { table: 'm2m_kb_task', columns: ['kb_knowledge', 'task', 'sys_created_by', 'sys_created_on'] },
  ],
  forms: [
    {
      table: 'kb_knowledge',
      highlights: ['workflow_state', 'version', 'kb_knowledge_base'],
      sections: articleSections(['text', 'wiki']),
      relatedLists: articleRelated,
    },
    ...templateForms,
    {
      table: 'kb_knowledge_base',
      highlights: ['active', 'owner'],
      sections: [
        {
          left: ['title', 'owner', 'kb_managers', 'active'],
          right: ['resolvr_publish_flow', 'resolvr_retire_flow', 'article_validity', 'order'],
        },
        { fields: ['description', 'approval_description'] },
        {
          caption: 'Feedback and editing',
          left: ['disable_commenting', 'disable_suggesting', 'disable_rating'],
          right: ['disable_mark_as_helpful', 'disable_category_editing', 'disable_standard_template'],
        },
        { caption: 'Appearance', left: ['card_color', 'icon'], right: ['kb_version', 'mandatory_fields'] },
      ],
      relatedLists: [
        {
          table: 'kb_category',
          field: 'parent_id',
          label: 'Categories',
          columns: ['label', 'full_category', 'active'],
        },
        {
          table: 'kb_uc_can_read_mtom',
          field: 'kb_knowledge_base',
          label: 'Can Read',
          columns: ['user_criteria'],
        },
        {
          table: 'kb_uc_cannot_read_mtom',
          field: 'kb_knowledge_base',
          label: 'Cannot Read',
          columns: ['user_criteria'],
        },
        {
          table: 'kb_uc_can_contribute_mtom',
          field: 'kb_knowledge_base',
          label: 'Can Contribute',
          columns: ['user_criteria'],
        },
        {
          table: 'kb_uc_cannot_contribute_mtom',
          field: 'kb_knowledge_base',
          label: 'Cannot Contribute',
          columns: ['user_criteria'],
        },
        {
          table: 'm2m_kb_template_kb',
          field: 'kb_knowledge_base',
          label: 'Article Templates',
          columns: ['template'],
        },
        {
          table: 'kb_knowledge',
          field: 'kb_knowledge_base',
          label: 'Articles',
          columns: ['number', 'short_description', 'workflow_state', 'sys_view_count'],
        },
      ],
    },
    {
      table: 'kb_category',
      sections: [
        { left: ['label', 'value', 'active'], right: ['parent_table', 'parent_id', 'full_category'] },
      ],
      relatedLists: [
        {
          table: 'kb_category',
          field: 'parent_id',
          label: 'Subcategories',
          columns: ['label', 'full_category', 'active'],
        },
        {
          table: 'kb_knowledge',
          field: 'kb_category',
          label: 'Articles',
          columns: ['number', 'short_description', 'workflow_state'],
        },
      ],
    },
    {
      table: 'user_criteria',
      sections: [
        { left: ['name', 'active', 'match_all'], right: ['advanced'] },
        { fields: ['short_description'] },
        {
          caption: 'Who matches',
          left: ['user', 'group', 'role'],
          right: ['department', 'location', 'company'],
        },
        { caption: 'Advanced', fields: ['script'] },
      ],
    },
    {
      table: 'kb_feedback',
      sections: [
        { left: ['article', 'user', 'parent'], right: ['useful', 'rating', 'flagged', 'reason'] },
        { fields: ['comments'] },
        { caption: 'Follow-up', fields: ['feedback_task'] },
      ],
    },
    {
      table: 'kb_feedback_task',
      highlights: ['state', 'assigned_to'],
      sections: [
        {
          left: ['number', 'article', 'feedback', 'reason', 'opened_by'],
          right: ['state', 'assignment_group', 'assigned_to', 'resolution_code', 'submitter_accepted'],
        },
        { fields: ['short_description', 'description'] },
        { caption: 'Resolution', fields: ['close_notes'] },
        { caption: 'Notes', fields: ['comments', 'work_notes'] },
      ],
    },
    {
      table: 'kb_submission',
      highlights: ['status', 'assigned_to'],
      sections: [
        {
          left: ['number', 'kb_knowledge_base', 'kb_category', 'parent'],
          right: ['status', 'assignment_group', 'assigned_to', 'kb_knowledge'],
        },
        { fields: ['short_description', 'text'] },
        { caption: 'Notes', fields: ['comments', 'work_notes', 'close_notes'] },
      ],
    },
  ],
  uiActions: [...articleActions, ...taskActions, ...feedbackTaskActions, ...submissionActions],
  uiPolicies: [
    {
      id: 'knowledge.published_read_only',
      table: 'kb_knowledge',
      name: 'Live and retired articles are read-only',
      condition: 'workflow_stateINpublished,pending_retirement,retired,outdated',
      reverseIfFalse: true,
      actions: [
        'short_description',
        'text',
        'kb_knowledge_base',
        'kb_category',
        'ownership_group',
        'scheduled_publish_date',
      ].map((field) => ({ field, readOnly: true })),
    },
    {
      id: 'knowledge.replacement_visible',
      table: 'kb_knowledge',
      name: 'Show the replacement article when retired',
      condition: 'workflow_state=retired',
      reverseIfFalse: true,
      actions: [{ field: 'replacement_article', visible: true }],
    },
    {
      id: 'knowledge.wiki_body',
      table: 'kb_knowledge',
      name: 'Wiki articles use the wiki field',
      condition: 'article_type=wiki',
      reverseIfFalse: true,
      actions: [
        { field: 'wiki', visible: true },
        { field: 'text', visible: false },
      ],
    },
    {
      id: 'knowledge.feedback_task_resolution',
      table: 'kb_feedback_task',
      name: 'Resolution code is mandatory when resolved',
      condition: 'stateIN6,7',
      reverseIfFalse: true,
      actions: [{ field: 'resolution_code', mandatory: true, visible: true }],
    },
    {
      id: 'knowledge.criteria_script',
      table: 'user_criteria',
      name: 'Script only for advanced criteria',
      condition: 'advanced=true',
      reverseIfFalse: true,
      actions: [{ field: 'script', visible: true }],
    },
  ],
};
