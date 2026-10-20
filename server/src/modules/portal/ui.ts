import type { Context } from '../../engine/context.js';
import type {
  FormLayoutDef,
  ListLayoutDef,
  ModuleUiDef,
  NavApplicationDef,
  UiActionDef,
} from '../../engine/module.js';
import type { Rec } from '../../engine/record.js';
import { ROLES, T, UR_AGENT_ROLES, UR_STATE } from './constants.js';
import { closeUniversalRequest, hasActivePrimary, routeUniversalRequest } from './ur.js';

const ME = 'javascript:gs.getUserID()';
const PORTAL_ADMINS = [ROLES.portalAdmin, ROLES.taxonomyAdmin, 'admin'];
const recordRoute = (table: string, sysId: string) => `/workspace/record/${table}/${sysId}`;

const navigation: NavApplicationDef[] = [
  {
    id: 'portal',
    title: 'Portal',
    icon: 'layout-grid',
    roles: [...UR_AGENT_ROLES, ...PORTAL_ADMINS, ROLES.surveyAdmin, ROLES.surveyReader, ROLES.urAdmin],
    order: 70,
    modules: [
      {
        title: 'Topics',
        table: T.topic,
        query: 'ORDERBYtopic_path',
        roles: PORTAL_ADMINS,
        icon: 'folder-tree',
      },
      { title: 'Taxonomies', table: T.taxonomy, query: 'ORDERBYorder', roles: PORTAL_ADMINS },
      {
        title: 'Connected Content',
        table: T.content,
        query: 'ORDERBYtopic^ORDERBYorder',
        roles: PORTAL_ADMINS,
      },
      { title: 'Quick Links', table: T.quickLink, query: 'ORDERBYorder', roles: PORTAL_ADMINS, icon: 'link' },
      {
        title: 'Announcements',
        table: T.announcement,
        query: 'ORDERBYDESCdisplay_from',
        roles: PORTAL_ADMINS,
        icon: 'megaphone',
      },
      { title: 'Guided Tours', table: T.tour, roles: [ROLES.tourAdmin, 'admin'] },
      {
        title: 'Universal Requests',
        table: T.ur,
        query: 'active=true^ORDERBYDESCsys_updated_on',
        roles: [...UR_AGENT_ROLES, ROLES.urAdmin],
        separator: true,
        icon: 'inbox',
      },
      {
        title: 'Unrouted Requests',
        table: T.ur,
        query: 'active=true^primary_taskISEMPTY^ORDERBYopened_at',
        roles: [...UR_AGENT_ROLES, ROLES.urAdmin],
      },
      {
        title: 'My Universal Requests',
        table: T.ur,
        query: `opened_for=${ME}^ORopened_by=${ME}^ORDERBYDESCsys_updated_on`,
        roles: [...UR_AGENT_ROLES, ROLES.urAdmin],
      },
      {
        title: 'All Universal Requests',
        table: T.ur,
        query: 'ORDERBYDESCnumber',
        roles: [...UR_AGENT_ROLES, ROLES.urAdmin],
      },
      { title: 'UR Departments', table: T.urDepartment, roles: [ROLES.urAdmin, 'admin'] },
      { title: 'UR Services', table: T.urService, roles: [ROLES.urAdmin, 'admin'] },
      {
        title: 'UR State Mapping',
        table: T.urMapping,
        query: 'ORDERBYprimary_table^ORDERBYprimary_state',
        roles: [ROLES.urAdmin, 'admin'],
      },
      {
        title: 'Surveys',
        table: T.survey,
        roles: [ROLES.surveyAdmin, ROLES.surveyReader, 'admin'],
        separator: true,
        icon: 'smile',
      },
      {
        title: 'Survey Instances',
        table: T.instance,
        query: 'ORDERBYDESCsys_created_on',
        roles: [ROLES.surveyAdmin, ROLES.surveyReader, 'admin'],
      },
      {
        title: 'Survey Results',
        table: T.result,
        query: 'ORDERBYDESCsys_created_on',
        roles: [ROLES.surveyAdmin, ROLES.surveyReader, 'admin'],
      },
      { title: 'Survey Triggers', table: T.trigger, roles: [ROLES.surveyAdmin, 'admin'] },
    ],
  },
];

const lists: ListLayoutDef[] = [
  { table: T.taxonomy, columns: ['name', 'description', 'order', 'active'] },
  {
    table: T.topic,
    columns: [
      'name',
      'topic_path',
      'taxonomy',
      'parent_topic',
      'icon',
      'order',
      'resolvr_ur_service',
      'resolvr_featured',
      'active',
    ],
  },
  {
    table: T.content,
    columns: [
      'topic',
      'content_type',
      'catalog_item',
      'knowledge',
      'quick_link',
      'featured',
      'order',
      'active',
    ],
  },
  {
    table: T.quickLink,
    columns: ['name', 'content_type', 'page', 'url', 'icon', 'show_on_home', 'order', 'active'],
  },
  { table: T.favorite, columns: ['user', 'table', 'document', 'sys_created_on'] },
  {
    table: T.announcement,
    columns: ['title', 'display_style', 'display_from', 'display_to', 'dismissible', 'active'],
  },
  {
    table: T.ur,
    columns: [
      'number',
      'short_description',
      'opened_for',
      'state',
      'state_reason',
      'department',
      'primary_task',
      'assignment_group',
      'sys_updated_on',
    ],
    defaultOrder: 'ORDERBYDESCnumber',
  },
  {
    table: T.urMapping,
    columns: ['primary_table', 'primary_state', 'ur_state', 'ur_state_reason', 'active'],
  },
  { table: T.urDepartment, columns: ['name', 'assignment_group', 'active'] },
  { table: T.urService, columns: ['name', 'department', 'table_name', 'assignment_group', 'active'] },
  { table: T.survey, columns: ['name', 'evaluation_method', 'due_days', 'active'] },
  {
    table: T.question,
    columns: ['metric_type', 'name', 'question', 'datatype', 'mandatory', 'order', 'active'],
  },
  {
    table: T.instance,
    columns: [
      'number',
      'metric_type',
      'user',
      'state',
      'trigger_table',
      'trigger_id',
      'due_date',
      'taken_on',
    ],
  },
  {
    table: T.result,
    columns: ['instance', 'metric', 'user', 'actual_value', 'string_value', 'sys_created_on'],
  },
  { table: T.trigger, columns: ['metric_type', 'table', 'condition', 'user_field', 'probability', 'active'] },
  { table: T.tour, columns: ['name', 'page_id', 'roles', 'auto_launch', 'active'] },
  { table: T.tourStep, columns: ['guide', 'order', 'title', 'target', 'placement'] },
];

const forms: FormLayoutDef[] = [
  {
    table: T.taxonomy,
    sections: [{ left: ['name', 'order'], right: ['active'] }, { fields: ['description'] }],
    relatedLists: [
      {
        table: T.topic,
        field: 'taxonomy',
        label: 'Topics',
        columns: ['name', 'parent_topic', 'order', 'active'],
      },
    ],
  },
  {
    table: T.topic,
    sections: [
      {
        left: ['name', 'taxonomy', 'parent_topic', 'order'],
        right: ['icon', 'active', 'resolvr_featured', 'topic_path'],
      },
      { fields: ['description'] },
      { caption: 'Requests', left: ['resolvr_ur_service'], right: [] },
      { caption: 'Appearance', left: ['banner_image_url', 'banner_img_alt_text'], right: ['icon_url'] },
      {
        caption: 'Visibility',
        left: ['enable_user_criteria_check', 'available_for'],
        right: ['not_available_for'],
      },
    ],
    relatedLists: [
      { table: T.topic, field: 'parent_topic', label: 'Child Topics', columns: ['name', 'order', 'active'] },
      {
        table: T.content,
        field: 'topic',
        label: 'Connected Content',
        columns: ['content_type', 'catalog_item', 'knowledge', 'quick_link', 'featured', 'order'],
      },
    ],
  },
  {
    table: T.content,
    sections: [
      { left: ['topic', 'content_type', 'order'], right: ['featured', 'active'] },
      { left: ['catalog_item', 'knowledge'], right: ['quick_link'] },
    ],
  },
  {
    table: T.quickLink,
    sections: [
      { left: ['name', 'content_type', 'icon', 'order'], right: ['show_on_home', 'active'] },
      { fields: ['short_description'] },
      { caption: 'Target', left: ['url', 'page'], right: ['catalog_item', 'knowledge'] },
      { caption: 'Visibility', left: ['available_for'], right: ['not_available_for'] },
    ],
  },
  {
    table: T.announcement,
    sections: [
      {
        left: ['title', 'display_style', 'order'],
        right: ['display_from', 'display_to', 'dismissible', 'active'],
      },
      { fields: ['summary'] },
      { left: ['details_url'], right: ['details_link_text'] },
    ],
  },
  {
    table: T.ur,
    highlights: ['state', 'state_reason', 'primary_task', 'assigned_to'],
    sections: [
      {
        left: ['number', 'opened_for', 'opened_by', 'contact_type', 'resolvr_topic', 'department', 'service'],
        right: [
          'state',
          'state_reason',
          'primary_task',
          'assignment_group',
          'assigned_to',
          'needs_resolution_review',
          'restricted',
        ],
      },
      { fields: ['short_description', 'description'] },
      { caption: 'Notes', fields: ['watch_list', 'comments', 'work_notes'] },
      { caption: 'Closure', left: ['confirm_due', 'closed_at'], right: ['transfer_reason', 'closed_by'] },
    ],
    relatedLists: [
      {
        table: 'task',
        field: 'universal_request',
        label: 'Associated Tickets',
        columns: [
          'number',
          'sys_class_name',
          'short_description',
          'state',
          'assignment_group',
          'assigned_to',
        ],
      },
    ],
  },
  {
    table: T.urMapping,
    sections: [
      { left: ['primary_table', 'primary_state'], right: ['ur_state', 'ur_state_reason', 'active'] },
    ],
  },
  {
    table: T.urDepartment,
    sections: [{ left: ['name', 'assignment_group'], right: ['active'] }, { fields: ['description'] }],
    relatedLists: [
      {
        table: T.urService,
        field: 'department',
        label: 'Services',
        columns: ['name', 'table_name', 'active'],
      },
    ],
  },
  {
    table: T.urService,
    sections: [{ left: ['name', 'department', 'table_name'], right: ['assignment_group', 'active'] }],
  },
  {
    table: T.survey,
    sections: [
      { left: ['name', 'evaluation_method', 'due_days'], right: ['active', 'allow_retake'] },
      { fields: ['description'] },
    ],
    relatedLists: [
      {
        table: T.question,
        field: 'metric_type',
        label: 'Questions',
        columns: ['order', 'name', 'question', 'datatype', 'mandatory', 'active'],
      },
      {
        table: T.trigger,
        field: 'metric_type',
        label: 'Trigger Conditions',
        columns: ['table', 'condition', 'user_field', 'active'],
      },
      {
        table: T.instance,
        field: 'metric_type',
        label: 'Instances',
        columns: ['number', 'user', 'state', 'trigger_id', 'taken_on'],
      },
    ],
  },
  {
    table: T.question,
    sections: [
      {
        left: ['metric_type', 'name', 'datatype', 'order'],
        right: ['scale_min', 'scale_max', 'weight', 'mandatory', 'active'],
      },
      { fields: ['question'] },
    ],
  },
  {
    table: T.instance,
    highlights: ['state', 'user', 'due_date'],
    sections: [
      {
        left: ['number', 'metric_type', 'user', 'state'],
        right: ['trigger_table', 'trigger_id', 'due_date', 'taken_on', 'percent_answered'],
      },
    ],
    relatedLists: [
      {
        table: T.result,
        field: 'instance',
        label: 'Answers',
        columns: ['metric', 'actual_value', 'string_value'],
      },
    ],
  },
  {
    table: T.result,
    sections: [
      {
        left: ['instance', 'metric', 'user'],
        right: ['actual_value', 'normalized_value', 'source_table', 'source_id'],
      },
      { fields: ['string_value'] },
    ],
  },
  {
    table: T.trigger,
    sections: [
      {
        left: ['metric_type', 'table', 'user_field'],
        right: ['probability', 'repeat_interval_days', 'active'],
      },
      { fields: ['condition'] },
    ],
  },
  {
    table: T.tour,
    sections: [{ left: ['name', 'page_id'], right: ['roles', 'auto_launch', 'active'] }],
    relatedLists: [
      {
        table: T.tourStep,
        field: 'guide',
        label: 'Steps',
        columns: ['order', 'title', 'target', 'placement'],
      },
    ],
  },
  {
    table: T.tourStep,
    sections: [
      { left: ['guide', 'order', 'title'], right: ['target', 'placement'] },
      { fields: ['content'] },
    ],
  },
];

const routable = (rec: Rec, ctx: Context) => rec.bool('active') && !hasActivePrimary(ctx, rec);

const uiActions: UiActionDef[] = [
  {
    id: 'universal_request.route_incident',
    table: T.ur,
    label: 'Route to incident',
    actionName: 'route_to_incident',
    style: 'primary',
    order: 10,
    roles: UR_AGENT_ROLES,
    condition: (rec, ctx) => routable(rec, ctx) && ctx.registry.has('incident'),
    run(rec, ctx) {
      const inc = routeUniversalRequest(ctx, rec, 'incident');
      return {
        message: `Incident ${inc.str('number')} created`,
        redirect: recordRoute('incident', inc.sysId),
      };
    },
  },
  {
    id: 'universal_request.route_request',
    table: T.ur,
    label: 'Route to request',
    actionName: 'route_to_request',
    order: 20,
    roles: UR_AGENT_ROLES,
    condition: (rec, ctx) =>
      routable(rec, ctx) && (ctx.registry.has('sc_req_item') || ctx.registry.has('sc_request')),
    run(rec, ctx) {
      const table = ctx.registry.has('sc_req_item') ? 'sc_req_item' : 'sc_request';
      const item = routeUniversalRequest(ctx, rec, table);
      return {
        message: `${item.table.label} ${item.str('number')} created`,
        redirect: recordRoute(item.className, item.sysId),
      };
    },
  },
  {
    id: 'universal_request.close',
    table: T.ur,
    label: 'Close',
    actionName: 'close_universal_request',
    order: 30,
    roles: UR_AGENT_ROLES,
    condition: (rec, ctx) =>
      rec.bool('active') && rec.str('state') !== UR_STATE.CLOSED && !hasActivePrimary(ctx, rec),
    prompt: [{ field: 'comments', label: 'Closing note for the requester', mandatory: true }],
    run(rec, ctx, input) {
      closeUniversalRequest(ctx, rec, String(input.comments ?? ''));
      return { message: `${rec.str('number')} closed` };
    },
  },
];

export const PORTAL_UI: ModuleUiDef = { navigation, lists, forms, uiActions };
