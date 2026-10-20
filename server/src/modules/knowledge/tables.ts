import type { ChoiceDef, ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';

const ch = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

/** Article lifecycle states (kb_knowledge.workflow_state). */
export const WORKFLOW_STATES: ChoiceDef[] = [
  ch('draft', 'Draft', 1),
  ch('review', 'Review', 2),
  ch('scheduled_publish', 'Scheduled for publish', 3),
  ch('published', 'Published', 4),
  ch('pending_retirement', 'Pending retirement', 5),
  ch('retired', 'Retired', 6),
  ch('outdated', 'Outdated', 7),
];

export const ARTICLE_TYPES: ChoiceDef[] = [ch('text', 'HTML', 1), ch('wiki', 'Wiki', 2)];

export const CONFIDENCE: ChoiceDef[] = [
  ch('in_progress', 'Work in Progress', 1),
  ch('validated', 'Validated', 2),
  ch('not_validated', 'Not Validated', 3),
  ch('archived', 'Archived', 4),
];

export const GOVERNANCE: ChoiceDef[] = [
  ch('experience', 'Experience Based', 1),
  ch('compliance', 'Compliance Based', 2),
];

export const KB_RELEASE: ChoiceDef[] = [
  ch('2', 'Knowledge Management v2', 1),
  ch('3', 'Knowledge Management v3', 2),
];

export const PUBLISH_FLOWS: ChoiceDef[] = [
  ch('instant', 'Instant publish', 1),
  ch('approval', 'Publish after approval', 2),
];

export const RETIRE_FLOWS: ChoiceDef[] = [
  ch('instant', 'Instant retire', 1),
  ch('approval', 'Retire after approval', 2),
];

export const USEFUL: ChoiceDef[] = [ch('yes', 'Yes', 1), ch('no', 'No', 2)];

export const FEEDBACK_REASONS: ChoiceDef[] = [
  ch('inaccurate', 'Inaccurate information', 1),
  ch('outdated', 'Outdated content', 2),
  ch('incomplete', 'Incomplete content', 3),
  ch('inappropriate', 'Inappropriate content', 4),
  ch('broken_link', 'Broken link or image', 5),
  ch('other', 'Other', 6),
];

export const FEEDBACK_TASK_STATES: ChoiceDef[] = [
  ch('1', 'Open', 1),
  ch('2', 'Work in Progress', 2),
  ch('3', 'Awaiting Information', 3),
  ch('6', 'Resolved', 4),
  ch('7', 'Closed', 5),
  ch('8', 'Cancelled', 6),
];

export const RESOLUTION_CODES: ChoiceDef[] = [
  ch('updated_article', 'Updated article', 1),
  ch('created_article', 'Created article', 2),
  ch('updated_search_config', 'Updated search configuration', 3),
  ch('no_action', 'No action', 4),
  ch('others', 'Others', 5),
];

export const SUBMISSION_STATUS: ChoiceDef[] = [
  ch('1', 'Open', 1),
  ch('2', 'Work in Progress', 2),
  ch('closed_created', 'Closed - Article Created', 3),
  ch('closed_duplicate', 'Closed - Duplicate', 4),
  ch('closed_invalid', 'Closed - Invalid', 5),
];

export const SEARCH_SORT: ChoiceDef[] = [
  ch('relevance', 'Relevancy', 1),
  ch('views', 'Views', 2),
  ch('newest', 'Newest', 3),
  ch('alphabetical', 'Alphabetical', 4),
];

/**
 * Article template classes: the fields that make up the article body, in order. The body
 * (`text`) of a template article is generated from these fields, each under its label.
 */
export const TEMPLATE_CLASSES: Record<
  string,
  { name: string; fields: { field: string; label: string }[]; seo: string }
> = {
  kb_template_faq: {
    name: 'FAQ',
    fields: [
      { field: 'kb_question', label: 'Question' },
      { field: 'kb_answer', label: 'Answer' },
    ],
    seo: 'kb_question',
  },
  kb_template_how_to: {
    name: 'How To',
    fields: [
      { field: 'kb_introduction', label: 'Introduction' },
      { field: 'kb_instructions', label: 'Instructions' },
    ],
    seo: 'kb_introduction',
  },
  kb_template_what_is: {
    name: 'What Is',
    fields: [
      { field: 'kb_introduction', label: 'Introduction' },
      { field: 'kb_explanation', label: 'Explanation' },
    ],
    seo: 'kb_introduction',
  },
  kb_template_kcs_article: {
    name: 'KCS Article',
    fields: [
      { field: 'kb_issue', label: 'Issue' },
      { field: 'kb_environment', label: 'Environment' },
      { field: 'kb_cause', label: 'Cause' },
      { field: 'kb_resolution', label: 'Resolution' },
    ],
    seo: 'kb_issue',
  },
  kb_template_known_error_article: {
    name: 'Known Error',
    fields: [
      { field: 'kb_description', label: 'Description' },
      { field: 'kb_workaround', label: 'Workaround' },
      { field: 'kb_cause', label: 'Cause' },
    ],
    seo: 'kb_description',
  },
  kb_template_incident_kcs_article: {
    name: 'Incident KCS Article',
    fields: [
      { field: 'kb_issue', label: 'Issue' },
      { field: 'kb_environment', label: 'Environment' },
      { field: 'kb_cause', label: 'Cause' },
      { field: 'kb_resolution', label: 'Resolution' },
    ],
    seo: 'kb_issue',
  },
};

const str = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  maxLength: 255,
  ...extra,
});
const bool = (name: string, label: string, def = false, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: def ? 'true' : 'false',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});
const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const html = (name: string, label: string): ColumnDef => ({ name, label, type: 'html', maxLength: 65000 });

/** Each user criteria relationship table, keyed by the access it grants. */
export const CRITERIA_TABLES = {
  canRead: 'kb_uc_can_read_mtom',
  cannotRead: 'kb_uc_cannot_read_mtom',
  canContribute: 'kb_uc_can_contribute_mtom',
  cannotContribute: 'kb_uc_cannot_contribute_mtom',
} as const;

const criteriaTable = (name: string): TableDef =>
  sdkTable(name, {
    displayField: 'user_criteria',
    patch: {
      kb_knowledge_base: { cascade: 'delete' },
      user_criteria: { cascade: 'delete', mandatory: true },
    },
  });

export const knowledgeTables: TableDef[] = [
  sdkTable('kb_knowledge_base', {
    displayField: 'title',
    audit: true,
    plural: 'Knowledge Bases',
    exclude: ['application', 'checklist', 'data_policy', 'enable_socialqa', 'question_annotation'],
    patch: {
      title: { indexed: true },
      kb_version: { choices: KB_RELEASE },
      kb_publish_flow: { referenceQual: undefined },
      kb_retire_flow: { referenceQual: undefined },
      workflow: { referenceQual: undefined },
      retire_workflow: { referenceQual: undefined },
      kb_managers: { reference: 'sys_user' },
      article_validity: {
        hint: 'Number of days an article stays valid after it is created. Leave empty for no expiry.',
      },
    },
    columns: [
      str('resolvr_publish_flow', 'Publish process', {
        maxLength: 40,
        defaultValue: 'approval',
        choices: PUBLISH_FLOWS,
        choiceMode: 'dropdown_without_none',
        hint: 'Instant publish, or approval by the base managers (or the ownership group) when the approvals application is installed',
      }),
      str('resolvr_retire_flow', 'Retire process', {
        maxLength: 40,
        defaultValue: 'instant',
        choices: RETIRE_FLOWS,
        choiceMode: 'dropdown_without_none',
        hint: 'Instant retirement, or approval by the base managers when the approvals application is installed',
      }),
    ],
  }),
  sdkTable('kb_category', {
    displayField: 'label',
    plural: 'Knowledge Categories',
    patch: {
      full_category: { readOnly: true },
      parent_table: { defaultValue: 'kb_knowledge_base' },
    },
  }),
  sdkTable('kb_knowledge_summary', { displayField: 'number', plural: 'Knowledge Summaries' }),
  sdkTable('kb_version', {
    displayField: 'version',
    patch: { knowledge: { cascade: 'delete' }, version: { maxLength: 40 } },
  }),
  sdkTable('kb_knowledge', {
    displayField: 'display_number',
    plural: 'Knowledge Articles',
    audit: true,
    extensible: true,
    textIndex: ['number', 'short_description', 'text', 'meta'],
    exclude: ['generated_with_now_assist', 'instrumentation_metadata', 'latest_aqi', 'editor_type'],
    patch: {
      workflow_state: {
        choices: WORKFLOW_STATES,
        defaultValue: 'draft',
        readOnly: true,
        indexed: true,
        choiceMode: 'dropdown_without_none',
      },
      article_type: { choices: ARTICLE_TYPES },
      kb_knowledge_base: { defaultValue: undefined, referenceQual: 'active=true' },
      kb_category: { referenceQual: 'active=true' },
      valid_to: { defaultValue: undefined },
      ownership_group: { referenceQual: 'active=true' },
      number: { readOnly: true, indexed: true },
      display_number: { readOnly: true, maxLength: 60 },
      flagged: { readOnly: true, defaultValue: 'false' },
      published: { readOnly: true },
      latest: { indexed: true },
      text: { type: 'html', maxLength: 65000 },
    },
    columns: [
      str('language', 'Language', { maxLength: 40, defaultValue: 'en' }),
      ref('parent', 'Parent (base-language article)', 'kb_knowledge'),
      str('confidence', 'Confidence', {
        maxLength: 40,
        choiceMode: 'dropdown_with_none',
        choices: CONFIDENCE,
      }),
      str('governance', 'Governance', {
        maxLength: 40,
        choiceMode: 'dropdown_with_none',
        choices: GOVERNANCE,
      }),
    ],
  }),
  ...Object.entries(TEMPLATE_CLASSES).map(
    ([name, t]): TableDef => ({
      name,
      label: t.name === 'Known Error' ? 'Known Error article' : t.name,
      plural: `${t.name} Articles`,
      extends: 'kb_knowledge',
      columns: t.fields.map((f) => html(f.field, f.label)),
    }),
  ),
  sdkTable('user_criteria', { displayField: 'name', plural: 'User Criteria' }),
  ...Object.values(CRITERIA_TABLES).map(criteriaTable),
  {
    name: 'kb_feedback',
    label: 'Knowledge Feedback',
    plural: 'Knowledge Feedback',
    displayField: 'article',
    columns: [
      ref('article', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('user', 'User', 'sys_user'),
      str('useful', 'Helpful', { maxLength: 10, choices: USEFUL, choiceMode: 'dropdown_with_none' }),
      int('rating', 'Rating (1-5)'),
      bool('flagged', 'Flagged'),
      str('reason', 'Reason', { maxLength: 40, choices: FEEDBACK_REASONS, choiceMode: 'dropdown_with_none' }),
      str('comments', 'Comments', { maxLength: 4000, type: 'multi_two_lines' }),
      ref('parent', 'Reply to', 'kb_feedback', { cascade: 'delete' }),
      str('session_id', 'Session ID', { maxLength: 64, internal: true }),
      ref('feedback_task', 'Feedback task', 'kb_feedback_task', { cascade: 'clear' }),
    ],
  },
  {
    name: 'kb_feedback_task',
    label: 'Knowledge Feedback Task',
    extends: 'task',
    number: { prefix: 'KBFT', start: 10000, digits: 7 },
    columns: [
      ref('feedback', 'Feedback', 'kb_feedback', { cascade: 'clear' }),
      ref('article', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'clear' }),
      str('reason', 'Reason', { maxLength: 40, choices: FEEDBACK_REASONS, choiceMode: 'dropdown_with_none' }),
      str('resolution_code', 'Resolution code', {
        maxLength: 40,
        choices: RESOLUTION_CODES,
        choiceMode: 'dropdown_with_none',
      }),
      bool('submitter_accepted', 'Submitter accepted'),
    ],
  },
  {
    name: 'kb_use',
    label: 'Knowledge Use',
    plural: 'Knowledge Use',
    displayField: 'article',
    columns: [
      ref('article', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('user', 'User', 'sys_user'),
      bool('viewed', 'Viewed'),
      bool('used', 'Used'),
      int('times_viewed', 'Times viewed', { defaultValue: '0' }),
      ref('search_id', 'Search', 'ts_query_kb', { cascade: 'clear' }),
      str('session_id', 'Session ID', { maxLength: 64 }),
      ref('task', 'Task (when used)', 'task', { cascade: 'clear' }),
    ],
  },
  {
    name: 'ts_query_kb',
    label: 'Knowledge Search',
    plural: 'Knowledge Searches',
    displayField: 'search_term',
    columns: [
      str('search_term', 'Search term', { maxLength: 1000 }),
      int('results', 'Results', { defaultValue: '0' }),
      ref('user', 'User', 'sys_user'),
      str('sort_order', 'Sort order', {
        maxLength: 40,
        choices: SEARCH_SORT,
        choiceMode: 'dropdown_with_none',
      }),
      bool('final_search_term', 'Final search term'),
      int('highest_click_rank', 'Highest click rank'),
      str('session_id', 'Session ID', { maxLength: 64 }),
      str('source', 'Search source', { maxLength: 100 }),
    ],
  },
  {
    name: 'm2m_kb_task',
    label: 'Knowledge Applied to Task',
    plural: 'Knowledge Applied to Tasks',
    displayField: 'kb_knowledge',
    columns: [
      ref('kb_knowledge', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('task', 'Task', 'task', { mandatory: true, cascade: 'delete' }),
    ],
  },
  {
    name: 'kb_2_kb',
    label: 'Related Article',
    displayField: 'related_kb_knowledge',
    columns: [
      ref('kb_knowledge', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('related_kb_knowledge', 'Related article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
    ],
  },
  {
    name: 'kb_2_sc',
    label: 'Related Catalog Item',
    displayField: 'sc_cat_item',
    columns: [
      ref('kb_knowledge', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('sc_cat_item', 'Catalog item', 'sc_cat_item', { mandatory: true }),
    ],
  },
  {
    name: 'm2m_kb_ci',
    label: 'Knowledge Related to Product',
    plural: 'Knowledge Related to Products',
    displayField: 'cmdb_ci',
    columns: [
      ref('kb_knowledge', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('cmdb_ci', 'Product / CI', 'cmdb_ci', { mandatory: true }),
    ],
  },
  {
    name: 'm2m_kb_feedback_likes',
    label: 'Knowledge Comment Like',
    displayField: 'feedback',
    columns: [
      ref('feedback', 'Comment', 'kb_feedback', { mandatory: true, cascade: 'delete' }),
      ref('user', 'User', 'sys_user', { mandatory: true }),
    ],
  },
  {
    name: 'kb_keyword',
    label: 'Knowledge Keyword',
    displayField: 'keyword',
    columns: [
      str('keyword', 'Keyword', { maxLength: 100, mandatory: true, indexed: true }),
      ref('kb_knowledge_base', 'Knowledge base', 'kb_knowledge_base'),
    ],
  },
  {
    name: 'kb_knowledge_keyword',
    label: 'Knowledge Keyword Mapping',
    displayField: 'kb_keyword',
    columns: [
      ref('kb_knowledge', 'Article', 'kb_knowledge', { mandatory: true, cascade: 'delete' }),
      ref('kb_keyword', 'Keyword', 'kb_keyword', { mandatory: true, cascade: 'delete' }),
      int('order', 'Order', { defaultValue: '100' }),
    ],
  },
  {
    name: 'kb_article_template',
    label: 'Article Template',
    displayField: 'name',
    columns: [
      str('name', 'Name', { maxLength: 100, mandatory: true }),
      { name: 'child_table', label: 'Template table', type: 'table_name', maxLength: 80, mandatory: true },
      bool('active', 'Active'),
      { name: 'seo_description_field', label: 'SEO description field', type: 'field_name', maxLength: 80 },
    ],
  },
  {
    name: 'kb_article_template_definition',
    label: 'Article Template Definition',
    displayField: 'label',
    columns: [
      ref('template', 'Template', 'kb_article_template', { mandatory: true, cascade: 'delete' }),
      { name: 'field', label: 'Field', type: 'field_name', maxLength: 80, mandatory: true },
      str('label', 'Label', { maxLength: 100 }),
      int('order', 'Order', { defaultValue: '100' }),
      bool('mandatory', 'Mandatory'),
    ],
  },
  {
    name: 'm2m_kb_template_kb',
    label: 'Knowledge Base Article Template',
    displayField: 'template',
    columns: [
      ref('kb_knowledge_base', 'Knowledge base', 'kb_knowledge_base', { mandatory: true, cascade: 'delete' }),
      ref('template', 'Template', 'kb_article_template', { mandatory: true, cascade: 'delete' }),
    ],
  },
  {
    name: 'kb_submission',
    label: 'Knowledge Submission',
    extends: 'task',
    number: { prefix: 'KBSUB', start: 10000, digits: 7 },
    columns: [
      ref('kb_knowledge_base', 'Knowledge base', 'kb_knowledge_base'),
      ref('kb_category', 'Category', 'kb_category'),
      html('text', 'Text'),
      ref('kb_knowledge', 'Created article', 'kb_knowledge', { cascade: 'clear' }),
      str('status', 'Status', {
        maxLength: 40,
        defaultValue: '1',
        choices: SUBMISSION_STATUS,
        choiceMode: 'dropdown_without_none',
      }),
    ],
  },
  {
    name: 'csm_table_map',
    label: 'Table Map',
    displayField: 'name',
    columns: [
      str('name', 'Mapping name', { maxLength: 100, mandatory: true }),
      { name: 'source_table', label: 'Source table', type: 'table_name', maxLength: 80, mandatory: true },
      { name: 'target_table', label: 'Target table', type: 'table_name', maxLength: 80, mandatory: true },
      { name: 'condition', label: 'Condition', type: 'conditions', maxLength: 4000 },
      bool('advanced', 'Advanced field mapping'),
      { name: 'script', label: 'Advanced mapping script', type: 'script', maxLength: 8000 },
    ],
  },
  {
    name: 'csm_field_map',
    label: 'Field Map',
    displayField: 'target_field',
    columns: [
      ref('table_map', 'Table map', 'csm_table_map', { mandatory: true, cascade: 'delete' }),
      { name: 'source_field', label: 'Source field', type: 'field_name', maxLength: 80, mandatory: true },
      { name: 'target_field', label: 'Target field', type: 'field_name', maxLength: 80, mandatory: true },
    ],
  },
];

/** Choice overrides for inherited fields. */
export const knowledgeChoices: Record<string, ChoiceDef[]> = {
  'kb_feedback_task.state': FEEDBACK_TASK_STATES,
};
