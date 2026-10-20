import type { ChoiceDef } from '../../engine/types.js';

/** Tables owned by the portal module. Platform names are used where the spec names one. */
export const T = {
  taxonomy: 'taxonomy',
  topic: 'topic',
  content: 'm2m_connected_content',
  quickLink: 'sn_ex_sp_quick_link',
  favorite: 'sp_favorite',
  announcement: 'resolvr_announcement',
  ur: 'universal_request',
  urMapping: 'universal_request_state_mapping',
  urDepartment: 'sn_uni_req_department',
  urService: 'sn_uni_req_service',
  survey: 'asmt_metric_type',
  question: 'asmt_metric',
  instance: 'asmt_assessment_instance',
  result: 'asmt_metric_result',
  trigger: 'asmt_condition',
  tour: 'sys_embedded_tour_guide',
  tourStep: 'sys_embedded_tour_step',
} as const;

/** Tables of other modules the portal reads when they are installed. */
export const EXT = {
  incident: 'incident',
  ritm: 'sc_req_item',
  request: 'sc_request',
  catalogItem: 'sc_cat_item',
  catalogTask: 'sc_task',
  article: 'kb_knowledge',
  knowledgeBase: 'kb_knowledge_base',
  approval: 'sysapproval_approver',
  itemOption: 'sc_item_option',
  itemOptionLink: 'sc_item_option_mtom',
  questionAnswer: 'question_answer',
  variable: 'item_option_new',
  variableChoice: 'question_choice',
  userCriteria: 'user_criteria',
  preference: 'sys_user_preference',
  attachment: 'sys_attachment',
} as const;

export const UR_STATE = { NEW: '1', IN_PROGRESS: '2', AWAITING: '3', CLOSED: '4', CANCELED: '7' } as const;
export const UR_CLOSED_STATES: readonly string[] = [UR_STATE.CLOSED, UR_STATE.CANCELED];
export const UR_REASON = {
  ROUTING: 'routing',
  CONFIRM: 'confirm_response',
  USER_INFO: 'user_info',
  TRANSFERRED: 'transferred',
} as const;

export const SURVEY_STATE = {
  READY: 'ready',
  WIP: 'wip',
  COMPLETE: 'complete',
  CANCELED: 'canceled',
} as const;
export const SURVEY_OPEN: readonly string[] = [SURVEY_STATE.READY, SURVEY_STATE.WIP];

export const ROLES = {
  routingAgent: 'sn_uni_req.routing_agent',
  urAdmin: 'sn_uni_req.admin',
  portalAdmin: 'sp_admin',
  taxonomyAdmin: 'taxonomy_admin',
  surveyAdmin: 'survey_admin',
  surveyReader: 'survey_reader',
  tourAdmin: 'guided_tour_admin',
} as const;

/** Roles that work universal requests (fulfillers). */
export const UR_AGENT_ROLES = ['itil', ROLES.routingAgent];

export const PROPS = {
  confirmDays: 'resolvr.ur.confirm_auto_close_days',
  copyFields: 'sn_inc_uni_req.incident.universal_request.copy_fields',
  streamLimit: 'glide.service_portal.stream_entry_limit',
  supportPhone: 'com.glide.cs.general.support_phone',
  supportEmail: 'com.glide.cs.general.support_email',
  supportHours: 'com.glide.cs.general.support_hours',
  catalogRequiresTopic: 'resolvr.portal.search.catalog_requires_topic',
  surveysEnabled: 'resolvr.portal.surveys.enabled',
  recentItems: 'resolvr.portal.home.recent_items',
  popularDays: 'resolvr.portal.popularity_days',
} as const;

/** Content types of connected content rows and of favorites. */
export type ContentType = 'catalog' | 'knowledge' | 'quick_link';

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const UR_STATE_CHOICES: ChoiceDef[] = [
  c(UR_STATE.NEW, 'New', 1),
  c(UR_STATE.IN_PROGRESS, 'In Progress', 2),
  c(UR_STATE.AWAITING, 'Awaiting', 3),
  c(UR_STATE.CLOSED, 'Closed', 4),
  c(UR_STATE.CANCELED, 'Canceled', 5),
];

export const UR_REASON_CHOICES: ChoiceDef[] = [
  c(UR_REASON.ROUTING, 'Routing', 1),
  c(UR_REASON.CONFIRM, 'Confirm response', 2),
  c(UR_REASON.USER_INFO, 'Awaiting user information', 3),
  c(UR_REASON.TRANSFERRED, 'Transferred', 4),
];

export const CONTENT_TYPE_CHOICES: ChoiceDef[] = [
  c('catalog', 'Catalog item', 1),
  c('knowledge', 'Knowledge article', 2),
  c('quick_link', 'Quick link', 3),
];

export const QUICK_LINK_TYPE_CHOICES: ChoiceDef[] = [
  c('url', 'External link', 1),
  c('page', 'Portal page', 2),
  c('catalog', 'Catalog item', 3),
  c('knowledge', 'Knowledge article', 4),
];

export const ANNOUNCEMENT_STYLE_CHOICES: ChoiceDef[] = [c('normal', 'Normal', 1), c('urgent', 'Urgent', 2)];

export const SURVEY_STATE_CHOICES: ChoiceDef[] = [
  c(SURVEY_STATE.READY, 'Ready to take', 1),
  c(SURVEY_STATE.WIP, 'In progress', 2),
  c(SURVEY_STATE.COMPLETE, 'Complete', 3),
  c(SURVEY_STATE.CANCELED, 'Canceled', 4),
];

export const EVALUATION_METHOD_CHOICES: ChoiceDef[] = [
  c('survey', 'Survey', 1),
  c('assessment', 'Assessment', 2),
];

export const DATATYPE_CHOICES: ChoiceDef[] = [
  c('scale', 'Scale', 1),
  c('numeric', 'Numeric', 2),
  c('boolean', 'Yes / No', 3),
  c('string', 'String', 4),
];

export const PLACEMENT_CHOICES: ChoiceDef[] = [
  c('top', 'Top', 1),
  c('bottom', 'Bottom', 2),
  c('left', 'Left', 3),
  c('right', 'Right', 4),
];

/** Seeded state mapping rows: primary table, primary states, UR state, UR state reason. */
export const DEFAULT_STATE_MAPPING: { table: string; states: string[]; ur: string; reason?: string }[] = [
  { table: 'sc_req_item', states: ['-5', '1', '2'], ur: UR_STATE.IN_PROGRESS },
  { table: 'sc_req_item', states: ['3', '4', '7'], ur: UR_STATE.CLOSED },
  { table: 'incident', states: ['1', '2', '3'], ur: UR_STATE.IN_PROGRESS },
  { table: 'incident', states: ['6'], ur: UR_STATE.AWAITING, reason: UR_REASON.CONFIRM },
  { table: 'incident', states: ['7'], ur: UR_STATE.CLOSED },
  { table: 'incident', states: ['8'], ur: UR_STATE.CANCELED },
];

/** Name of the seeded satisfaction survey. */
export const DEFAULT_SURVEY = 'Request satisfaction';
export const OVERALL_METRIC = 'Overall satisfaction';

/** Catalog variable types that never carry an answer (labels, containers, breaks, custom widgets). */
export const LAYOUT_VARIABLE_TYPES = new Set(['11', '12', '14', '15', '17', '19', '20', '24']);
