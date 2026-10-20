import type { ColumnDef, TableDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import {
  ANNOUNCEMENT_STYLE_CHOICES,
  CONTENT_TYPE_CHOICES,
  DATATYPE_CHOICES,
  EVALUATION_METHOD_CHOICES,
  PLACEMENT_CHOICES,
  QUICK_LINK_TYPE_CHOICES,
  SURVEY_STATE_CHOICES,
  T,
  UR_REASON_CHOICES,
  UR_STATE_CHOICES,
} from './constants.js';

const ref = (name: string, label: string, reference: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'reference',
  reference,
  ...extra,
});
const str = (name: string, label: string, maxLength = 255, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'string',
  maxLength,
  ...extra,
});
const bool = (name: string, label: string, value: boolean, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'boolean',
  defaultValue: value ? 'true' : 'false',
  ...extra,
});
const int = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'integer',
  ...extra,
});
const dt = (name: string, label: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  label,
  type: 'glide_date_time',
  ...extra,
});
const order = (): ColumnDef => int('order', 'Order', { defaultValue: '100' });
const active = (): ColumnDef => bool('active', 'Active', true);
const ME = 'javascript:gs.getUserID()';

// ------------------------------------------------------------------ taxonomy

const taxonomy: TableDef = {
  name: T.taxonomy,
  label: 'Taxonomy',
  plural: 'Taxonomies',
  description: 'A classification tree shared by catalog items, articles and quick links.',
  displayField: 'name',
  columns: [
    str('name', 'Name', 100, { mandatory: true }),
    str('description', 'Description', 1000),
    active(),
    order(),
  ],
};

const topic: TableDef = sdkTable(T.topic, {
  displayField: 'name',
  plural: 'Topics',
  description: 'Portal taxonomy topic: department, topic or sub-topic.',
  textIndex: ['name', 'description'],
  exclude: [
    'template',
    'topic_manager',
    'topic_contributor',
    'banner_image',
    'apply_to_child_topics',
    'topic_based_navigation',
  ],
  patch: {
    name: { maxLength: 100 },
    description: { maxLength: 1000, type: 'string' },
    icon: {
      type: 'string',
      maxLength: 100,
      hint: 'Icon name from the lucide set, for example laptop or wifi',
    },
    parent_topic: { referenceQual: 'active=true', cascade: 'restrict' },
    taxonomy: { cascade: 'restrict' },
    order: { defaultValue: '100' },
    topic_path: { readOnly: true, type: 'string' },
  },
  columns: [
    ref('resolvr_ur_service', 'Request routing', T.urService, {
      hint: 'Requests raised under this topic (or its sub-topics) are routed to this service. Leave empty to inherit from the parent topic.',
    }),
    bool('resolvr_featured', 'Featured on the portal home page', false),
  ],
});

const connectedContent: TableDef = {
  name: T.content,
  label: 'Connected Content',
  plural: 'Connected Content',
  description: 'Links a topic to a catalog item, a knowledge article or a quick link.',
  displayField: 'topic',
  columns: [
    ref('topic', 'Topic', T.topic, { mandatory: true, cascade: 'delete' }),
    str('content_type', 'Content type', 40, {
      mandatory: true,
      choices: CONTENT_TYPE_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
    ref('catalog_item', 'Catalog item', 'sc_cat_item', { cascade: 'delete' }),
    ref('knowledge', 'Knowledge article', 'kb_knowledge', { cascade: 'delete' }),
    ref('quick_link', 'Quick link', T.quickLink, { cascade: 'delete' }),
    bool('featured', 'Featured', false),
    order(),
    active(),
  ],
  indexes: [['topic', 'content_type']],
};

const quickLink: TableDef = {
  name: T.quickLink,
  label: 'Quick Link',
  plural: 'Quick Links',
  description: 'Curated shortcut shown on the home page, in the menu and on topic pages.',
  displayField: 'name',
  textIndex: ['name', 'short_description'],
  columns: [
    str('name', 'Name', 100, { mandatory: true }),
    str('short_description', 'Short description', 255),
    str('content_type', 'Content type', 40, {
      defaultValue: 'url',
      choices: QUICK_LINK_TYPE_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
    { name: 'url', label: 'URL', type: 'url', maxLength: 1024 },
    str('page', 'Portal page', 40, { hint: 'Portal page id, for example my_requests, sc_home or kb_home' }),
    ref('catalog_item', 'Catalog item', 'sc_cat_item'),
    ref('knowledge', 'Knowledge article', 'kb_knowledge'),
    str('icon', 'Icon', 100, { hint: 'Icon name from the lucide set' }),
    bool('show_on_home', 'Show on home page', false),
    order(),
    active(),
    {
      name: 'available_for',
      label: 'Available for',
      type: 'glide_list',
      reference: 'user_criteria',
      maxLength: 1024,
    },
    {
      name: 'not_available_for',
      label: 'Not available for',
      type: 'glide_list',
      reference: 'user_criteria',
      maxLength: 1024,
    },
  ],
};

const favorite: TableDef = {
  name: T.favorite,
  label: 'Portal Favorite',
  plural: 'Portal Favorites',
  description: 'A catalog item, article, quick link or topic a user marked as favorite.',
  displayField: 'document',
  columns: [
    ref('user', 'User', 'sys_user', { mandatory: true, defaultValue: ME, cascade: 'delete' }),
    { name: 'table', label: 'Table', type: 'table_name', maxLength: 80, mandatory: true },
    { name: 'document', label: 'Record', type: 'document_id', mandatory: true, dependentOn: 'table' },
    order(),
  ],
  indexes: [['user', 'document']],
};

const announcement: TableDef = {
  name: T.announcement,
  label: 'Portal Announcement',
  plural: 'Portal Announcements',
  description: 'Banner shown at the top of the employee portal during its display window.',
  displayField: 'title',
  columns: [
    str('title', 'Title', 100, { mandatory: true }),
    str('summary', 'Summary', 1000),
    { name: 'details_url', label: 'Details link', type: 'url', maxLength: 1024 },
    str('details_link_text', 'Details link text', 100),
    str('display_style', 'Display style', 40, {
      defaultValue: 'normal',
      choices: ANNOUNCEMENT_STYLE_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
    dt('display_from', 'Display from'),
    dt('display_to', 'Display to'),
    bool('dismissible', 'Users can dismiss', true),
    order(),
    active(),
  ],
};

// ------------------------------------------------------------------ universal request

const universalRequest: TableDef = {
  name: T.ur,
  label: 'Universal Request',
  plural: 'Universal Requests',
  description: 'One request number for the employee, whichever department works the primary ticket.',
  extends: 'task',
  audit: true,
  number: { prefix: 'UR', start: 10000, digits: 7 },
  textIndex: ['number', 'short_description', 'description'],
  columns: [
    ref('opened_for', 'Opened for', 'sys_user', { mandatory: true, defaultValue: ME, indexed: true }),
    ref('primary_task', 'Primary ticket', 'task', {
      cascade: 'clear',
      readOnly: true,
      hint: 'Department record (incident, requested item...) that fulfils this request',
    }),
    ref('department', 'Department', T.urDepartment),
    ref('service', 'Service', T.urService),
    ref('resolvr_topic', 'Topic', T.topic, { hint: 'Portal topic the request was raised under' }),
    str('state_reason', 'State reason', 40, { choices: UR_REASON_CHOICES, choiceMode: 'dropdown_with_none' }),
    bool('needs_resolution_review', 'Needs resolution review', false),
    bool('restricted', 'Restricted', false),
    str('transfer_reason', 'Transfer reason', 255),
    dt('confirm_due', 'Confirmation due', { readOnly: true }),
  ],
  overrides: {
    state: { choices: UR_STATE_CHOICES, defaultValue: '1' },
    contact_type: { defaultValue: 'self-service' },
  },
};

const stateMapping: TableDef = {
  name: T.urMapping,
  label: 'UR State Mapping',
  plural: 'UR State Mappings',
  description: 'How the state of a primary ticket moves its universal request.',
  displayField: 'primary_table',
  columns: [
    {
      name: 'primary_table',
      label: 'Primary ticket table',
      type: 'table_name',
      maxLength: 80,
      mandatory: true,
    },
    str('primary_state', 'Primary ticket state', 40, { mandatory: true }),
    int('ur_state', 'Universal request state', { mandatory: true, choices: UR_STATE_CHOICES }),
    str('ur_state_reason', 'Universal request state reason', 40, {
      choices: UR_REASON_CHOICES,
      choiceMode: 'dropdown_with_none',
    }),
    active(),
  ],
};

const department: TableDef = {
  name: T.urDepartment,
  label: 'UR Department',
  plural: 'UR Departments',
  description: 'Department (service set) that universal requests are routed to.',
  displayField: 'name',
  columns: [
    str('name', 'Name', 100, { mandatory: true }),
    str('description', 'Description', 1000),
    ref('assignment_group', 'Routing group', 'sys_user_group'),
    active(),
  ],
};

const service: TableDef = {
  name: T.urService,
  label: 'UR Service',
  plural: 'UR Services',
  description: 'Registers the table that fulfils universal requests for a department.',
  displayField: 'name',
  columns: [
    str('name', 'Name', 100, { mandatory: true }),
    ref('department', 'Department', T.urDepartment, { mandatory: true }),
    { name: 'table_name', label: 'Fulfilment table', type: 'table_name', maxLength: 80, mandatory: true },
    ref('assignment_group', 'Assignment group', 'sys_user_group', {
      hint: 'Overrides the department routing group',
    }),
    active(),
  ],
};

// ------------------------------------------------------------------ surveys

const surveyType: TableDef = {
  name: T.survey,
  label: 'Survey',
  plural: 'Surveys',
  description: 'Survey definition (metric type).',
  displayField: 'name',
  columns: [
    str('name', 'Name', 100, { mandatory: true }),
    str('description', 'Description', 1000),
    str('evaluation_method', 'Evaluation method', 40, {
      defaultValue: 'survey',
      choices: EVALUATION_METHOD_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
    active(),
    bool('allow_retake', 'Allow retake', false),
    int('due_days', 'Days to complete', { defaultValue: '14' }),
  ],
};

const question: TableDef = {
  name: T.question,
  label: 'Survey Question',
  plural: 'Survey Questions',
  description: 'A question (metric) of a survey.',
  displayField: 'name',
  columns: [
    ref('metric_type', 'Survey', T.survey, { mandatory: true, cascade: 'delete' }),
    str('name', 'Name', 100, { mandatory: true }),
    str('question', 'Question', 1000, { mandatory: true }),
    str('datatype', 'Data type', 40, {
      defaultValue: 'scale',
      choices: DATATYPE_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
    int('scale_min', 'Scale min', { defaultValue: '1' }),
    int('scale_max', 'Scale max', { defaultValue: '5' }),
    { name: 'weight', label: 'Weight', type: 'decimal', defaultValue: '1' },
    bool('mandatory', 'Mandatory', false),
    order(),
    active(),
  ],
};

const instance: TableDef = {
  name: T.instance,
  label: 'Survey Instance',
  plural: 'Survey Instances',
  description: 'A survey sent to one user, usually when one of their tickets closes.',
  number: { prefix: 'AINST', start: 10000, digits: 7 },
  displayField: 'number',
  columns: [
    str('number', 'Number', 40, { readOnly: true }),
    ref('metric_type', 'Survey', T.survey, { mandatory: true }),
    ref('user', 'Assigned to', 'sys_user', { mandatory: true, indexed: true, cascade: 'delete' }),
    str('state', 'State', 40, {
      defaultValue: 'ready',
      choices: SURVEY_STATE_CHOICES,
      choiceMode: 'dropdown_without_none',
      indexed: true,
    }),
    dt('due_date', 'Due date'),
    { name: 'trigger_table', label: 'Trigger table', type: 'table_name', maxLength: 80 },
    {
      name: 'trigger_id',
      label: 'Trigger record',
      type: 'document_id',
      reference: 'task',
      dependentOn: 'trigger_table',
      indexed: true,
    },
    ref('trigger_condition', 'Trigger condition', T.trigger),
    dt('taken_on', 'Taken on', { readOnly: true }),
    int('percent_answered', 'Percent answered', { defaultValue: '0', readOnly: true }),
  ],
};

const result: TableDef = {
  name: T.result,
  label: 'Survey Result',
  plural: 'Survey Results',
  description: 'One answer to one survey question.',
  displayField: 'metric',
  columns: [
    ref('instance', 'Instance', T.instance, { mandatory: true, cascade: 'delete' }),
    ref('metric', 'Question', T.question, { mandatory: true }),
    ref('user', 'User', 'sys_user'),
    { name: 'actual_value', label: 'Actual value', type: 'decimal' },
    { name: 'normalized_value', label: 'Normalized value', type: 'decimal' },
    str('string_value', 'String value', 4000),
    { name: 'source_table', label: 'Source table', type: 'table_name', maxLength: 80 },
    {
      name: 'source_id',
      label: 'Source record',
      type: 'document_id',
      reference: 'task',
      dependentOn: 'source_table',
    },
  ],
};

const trigger: TableDef = {
  name: T.trigger,
  label: 'Survey Trigger Condition',
  plural: 'Survey Trigger Conditions',
  description: 'Sends a survey to a user when a record newly matches a condition.',
  displayField: 'table',
  columns: [
    ref('metric_type', 'Survey', T.survey, { mandatory: true, cascade: 'delete' }),
    { name: 'table', label: 'Table', type: 'table_name', maxLength: 80, mandatory: true },
    { name: 'condition', label: 'Condition', type: 'conditions', maxLength: 4000, dependentOn: 'table' },
    {
      name: 'user_field',
      label: 'User field',
      type: 'field_name',
      maxLength: 80,
      mandatory: true,
      dependentOn: 'table',
    },
    int('probability', 'Send percentage', { defaultValue: '100' }),
    int('repeat_interval_days', 'Minimum days between surveys per user', { defaultValue: '0' }),
    active(),
  ],
};

// ------------------------------------------------------------------ guided tours

const tour: TableDef = {
  name: T.tour,
  label: 'Guided Tour',
  plural: 'Guided Tours',
  displayField: 'name',
  columns: [
    str('name', 'Name', 100, { mandatory: true }),
    str('page_id', 'Page ID', 40),
    { name: 'roles', label: 'Roles', type: 'user_roles', maxLength: 255 },
    active(),
    bool('auto_launch', 'Auto launch on first visit', false),
  ],
};

const tourStep: TableDef = {
  name: T.tourStep,
  label: 'Guided Tour Step',
  plural: 'Guided Tour Steps',
  displayField: 'title',
  columns: [
    ref('guide', 'Tour', T.tour, { mandatory: true, cascade: 'delete' }),
    order(),
    str('target', 'Target selector', 1000),
    str('title', 'Title', 100),
    str('content', 'Content', 4000),
    str('placement', 'Placement', 20, {
      defaultValue: 'bottom',
      choices: PLACEMENT_CHOICES,
      choiceMode: 'dropdown_without_none',
    }),
  ],
};

export const PORTAL_TABLES: TableDef[] = [
  taxonomy,
  topic,
  quickLink,
  connectedContent,
  favorite,
  announcement,
  department,
  service,
  universalRequest,
  stateMapping,
  surveyType,
  question,
  trigger,
  instance,
  result,
  tour,
  tourStep,
];
