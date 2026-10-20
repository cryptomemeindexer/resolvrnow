import type { ChoiceDef } from '../../engine/types.js';

/** Table names used by the catalog module. */
export const T = {
  catalog: 'sc_catalog',
  category: 'sc_category',
  item: 'sc_cat_item',
  producer: 'sc_cat_item_producer',
  guide: 'sc_cat_item_guide',
  content: 'sc_cat_item_content',
  itemCategory: 'sc_cat_item_category',
  itemCatalog: 'sc_cat_item_catalog',
  itemAvailable: 'sc_cat_item_user_criteria_mtom',
  itemNotAvailable: 'sc_cat_item_user_criteria_no_mtom',
  categoryAvailable: 'sc_category_user_criteria_mtom',
  categoryNotAvailable: 'sc_category_user_criteria_no_mtom',
  criteria: 'user_criteria',
  variable: 'item_option_new',
  variableSet: 'item_option_new_set',
  setItem: 'io_set_item',
  choice: 'question_choice',
  uiPolicy: 'catalog_ui_policy',
  uiPolicyAction: 'catalog_ui_policy_action',
  clientScript: 'catalog_script_client',
  cart: 'sc_cart',
  cartItem: 'sc_cart_item',
  option: 'sc_item_option',
  optionLink: 'sc_item_option_mtom',
  answer: 'question_answer',
  mrvsAnswer: 'sc_multi_row_question_answer',
  produced: 'sc_item_produced_record',
  guideRule: 'sc_cat_item_guide_items',
  appUser: 'sc_cat_item_app_user',
  appGroup: 'sc_cat_item_app_group',
  deliveryPlan: 'sc_cat_item_delivery_plan',
  deliveryTask: 'sc_cat_item_delivery_task',
  request: 'sc_request',
  ritm: 'sc_req_item',
  task: 'sc_task',
  step: 'resolvr_cat_item_fulfillment_step',
  software: 'resolvr_software_title',
  approval: 'sysapproval_approver',
} as const;

/** Tables a record producer must never target (spec: hard rule 2). */
export const PRODUCER_FORBIDDEN_TABLES = [T.request, T.ritm, T.task];

/** sc_req_item.stage values. */
export const STAGE = {
  waiting: 'waiting_for_approval',
  approved: 'request_approved',
  fulfillment: 'fulfillment',
  delivery: 'delivery',
  complete: 'complete',
  cancelled: 'Request Cancelled',
} as const;

/** sc_request.request_state values. */
export const REQ_STATE = {
  requested: 'requested',
  inProcess: 'in_process',
  closedComplete: 'closed_complete',
  closedIncomplete: 'closed_incomplete',
  closedCancelled: 'closed_cancelled',
  closedRejected: 'closed_rejected',
  closedSkipped: 'closed_skipped',
} as const;

/** Task state integers shared by sc_request, sc_req_item and sc_task. */
export const STATE = {
  pending: '-5',
  open: '1',
  wip: '2',
  complete: '3',
  incomplete: '4',
  skipped: '7',
} as const;

export const CLOSED_STATES: readonly string[] = [STATE.complete, STATE.incomplete, STATE.skipped];

export const APPROVAL = {
  notRequested: 'not requested',
  requested: 'requested',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  notRequired: 'not_required',
} as const;

/** Product properties (in addition to the documented glide.sc.* ones). */
export const PROP = {
  currency: 'resolvr.currency',
  defaultCatalog: 'resolvr.sc.default_catalog',
  requestApprovalThreshold: 'resolvr.sc.request_approval_threshold',
  maskedKey: 'resolvr.sc.masked_key',
} as const;

export const ROLES = {
  admin: 'catalog_admin',
  manager: 'catalog_manager',
  editor: 'catalog_editor',
  fulfiller: 'catalog',
  viewMasked: 'catalog_view_masked',
  requestRead: 'sn_request_read',
  requestWrite: 'sn_request_write',
} as const;

/** Roles that may read every request, requested item and catalog task. */
export const REQUEST_READ_ROLES = ['itil', ROLES.requestRead, ROLES.requestWrite, ROLES.admin];
/** Roles that work requests and catalog tasks. */
export const REQUEST_WRITE_ROLES = ['itil', ROLES.requestWrite];
/** Roles that may manage catalog definitions (scoped further for managers and editors). */
export const CATALOG_DEFINITION_ROLES = [ROLES.admin, ROLES.manager, ROLES.editor];

// ----------------------------------------------------------------- variables

export interface VariableTypeInfo {
  code: number;
  label: string;
  friendly: string;
  /** Collects an answer (stored in sc_item_option / question_answer). */
  data: boolean;
  /** Allowed inside a multi-row variable set. */
  mrvs: boolean;
}

const vt = (
  code: number,
  label: string,
  friendly: string,
  data: boolean,
  mrvs: boolean,
): VariableTypeInfo => ({
  code,
  label,
  friendly,
  data,
  mrvs,
});

/** item_option_new.type codes (spec 5.2). */
export const VARIABLE_TYPES: VariableTypeInfo[] = [
  vt(1, 'Yes / No', 'yes_no', true, true),
  vt(2, 'Multi Line Text', 'multi_line_text', true, true),
  vt(3, 'Multiple Choice', 'multiple_choice', true, true),
  vt(4, 'Numeric Scale', 'numeric_scale', true, true),
  vt(5, 'Select Box', 'select_box', true, true),
  vt(6, 'Single Line Text', 'single_line_text', true, true),
  vt(7, 'CheckBox', 'check_box', true, true),
  vt(8, 'Reference', 'reference', true, true),
  vt(9, 'Date', 'date', true, true),
  vt(10, 'Date/Time', 'date_time', true, true),
  vt(11, 'Label', 'label', false, false),
  vt(12, 'Break', 'break', false, false),
  vt(14, 'Custom', 'custom', false, false),
  vt(15, 'UI Page', 'ui_page', false, false),
  vt(16, 'Wide Single Line Text', 'wide_single_line_text', true, true),
  vt(17, 'Custom with Label', 'custom_with_label', false, false),
  vt(18, 'Lookup Select Box', 'lookup_select_box', true, true),
  vt(19, 'Container Start', 'container_start', false, false),
  vt(20, 'Container End', 'container_end', false, false),
  vt(21, 'List Collector', 'list_collector', true, true),
  vt(22, 'Lookup Multiple Choice', 'lookup_multiple_choice', true, true),
  vt(23, 'HTML', 'html', true, false),
  vt(24, 'Container Split', 'container_split', false, false),
  vt(25, 'Masked', 'masked', true, true),
  vt(26, 'Email', 'email', true, true),
  vt(27, 'URL', 'url', true, true),
  vt(28, 'IP Address', 'ip_address', true, true),
  vt(29, 'Duration', 'duration', true, true),
  vt(31, 'Requested For', 'requested_for', true, false),
  vt(32, 'Rich Text Label', 'rich_text_label', false, false),
  vt(33, 'Attachment', 'attachment', true, false),
];

export const VT_BY_CODE = new Map(VARIABLE_TYPES.map((t) => [t.code, t]));

/** Frequently used type codes. */
export const VT = {
  yesNo: 1,
  multiLine: 2,
  multipleChoice: 3,
  scale: 4,
  select: 5,
  singleLine: 6,
  checkbox: 7,
  reference: 8,
  date: 9,
  dateTime: 10,
  label: 11,
  break: 12,
  wideSingleLine: 16,
  lookupSelect: 18,
  containerStart: 19,
  containerEnd: 20,
  listCollector: 21,
  lookupMultiple: 22,
  html: 23,
  containerSplit: 24,
  masked: 25,
  email: 26,
  url: 27,
  ip: 28,
  duration: 29,
  requestedFor: 31,
  richTextLabel: 32,
  attachment: 33,
} as const;

// ------------------------------------------------------------------- choices

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const CHOICES = {
  requestState: [
    c(REQ_STATE.requested, 'Pending Approval', 1),
    c(REQ_STATE.inProcess, 'Approved', 2),
    c(REQ_STATE.closedComplete, 'Closed Complete', 3),
    c(REQ_STATE.closedIncomplete, 'Closed Incomplete', 4),
    c(REQ_STATE.closedCancelled, 'Closed Cancelled', 5),
    c(REQ_STATE.closedRejected, 'Closed Rejected', 6),
    c(REQ_STATE.closedSkipped, 'Closed Skipped', 7),
  ],
  requestStage: [
    c('requested', 'Requested', 1),
    c('waiting_for_approval', 'Waiting for Approval', 2),
    c('fulfillment', 'Fulfillment', 3),
    c('closed_complete', 'Closed Complete', 4),
    c('closed_incomplete', 'Closed Incomplete', 5),
    c('closed_cancelled', 'Closed Cancelled', 6),
    c('closed_rejected', 'Closed Rejected', 7),
    c('closed_skipped', 'Closed Skipped', 8),
  ],
  itemStage: [
    c(STAGE.waiting, 'Waiting for Approval', 1),
    c(STAGE.approved, 'Request Approved', 2),
    c(STAGE.fulfillment, 'Fulfillment', 3),
    c(STAGE.delivery, 'Delivery', 4),
    c(STAGE.complete, 'Completed', 5),
    c(STAGE.cancelled, 'Request Cancelled', 6),
  ],
  recurringFrequency: [
    c('daily', 'Daily', 1),
    c('weekly', 'Weekly', 2),
    c('weekly2', 'Every 2 Weeks', 3),
    c('monthly', 'Monthly', 4),
    c('monthly2', 'Every 2 Months', 5),
    c('quarterly', 'Quarterly', 6),
    c('semiannual', 'Semi-Annually', 7),
    c('yearly', 'Annually', 8),
  ],
  itemType: [c('item', 'Item', 1), c('bundle', 'Bundle', 2), c('package', 'Package', 3)],
  availability: [
    c('on_both', 'Desktop and Mobile', 1),
    c('on_desktop', 'Desktop Only', 2),
    c('on_mobile', 'Mobile Only', 3),
  ],
  accessType: [c('restricted', 'Restricted', 1), c('delegated', 'Delegated', 2)],
  requestMethod: [c('order', 'Order', 1), c('request', 'Request', 2), c('submit', 'Submit', 3)],
  automationLevel: [
    c('unspecified', 'Unspecified', 1),
    c('manual', 'Manual', 2),
    c('semi_automated', 'Semi-automated', 3),
    c('fully_automated', 'Fully automated', 4),
  ],
  mobilePictureType: [
    c('use_desktop_picture', 'Desktop', 1),
    c('use_mobile_picture', 'Mobile', 2),
    c('none', 'None', 3),
  ],
  producerRedirect: [
    c('generated_record', 'Generated task record', 1),
    c('catalog_home', 'Catalog homepage', 2),
  ],
  contentType: [
    c('kb', 'KB Article', 1),
    c('literal', 'Catalog Content', 2),
    c('external', 'External Content', 3),
  ],
  contentTarget: [c('within', 'Within Catalog', 1), c('new_window', 'New Window/Tab', 2)],
  variableType: VARIABLE_TYPES.map((t, i) => c(String(t.code), t.label, i + 1)),
  refQualifier: [c('simple', 'Simple', 1), c('dynamic', 'Dynamic', 2), c('advanced', 'Advanced', 3)],
  choiceDirection: [c('across', 'Across', 1), c('down', 'Down', 2)],
  lookupSource: [c('table', 'Table', 1), c('choices', 'Choices', 2)],
  layout: [
    c('normal', '1 Column Wide', 1),
    c('2across', '2 Columns Wide, alternating sides', 2),
    c('2down', '2 Columns Wide, one side then the other', 3),
  ],
  setType: [c('one_to_one', 'Single Row', 1), c('one_to_many', 'Multi Row', 2)],
  quantity: Array.from({ length: 10 }, (_, i) => c(String(i + 1), String(i + 1), i + 1)),
  policyAppliesTo: [c('item', 'A Catalog Item', 1), c('set', 'A Variable Set', 2)],
  policyTri: [c('ignore', 'Leave alone', 1), c('true', 'True', 2), c('false', 'False', 3)],
  valueAction: [
    c('ignore', 'Leave alone', 1),
    c('set_value', 'Set value', 2),
    c('clear_value', 'Clear value', 3),
  ],
  messageType: [
    c('none', 'None', 1),
    c('info', 'Info', 2),
    c('warning', 'Warning', 3),
    c('error', 'Error', 4),
  ],
  clientScriptType: [c('onLoad', 'onLoad', 1), c('onChange', 'onChange', 2), c('onSubmit', 'onSubmit', 3)],
  clientScriptUi: [c('0', 'Desktop', 1), c('1', 'Mobile / Service Portal', 2), c('10', 'All', 3)],
  stepStage: [c(STAGE.fulfillment, 'Fulfillment', 1), c(STAGE.delivery, 'Delivery', 2)],
  softwareLicense: [
    c('free', 'Free', 1),
    c('per_user', 'Per user', 2),
    c('subscription', 'Subscription', 3),
    c('site', 'Site license', 4),
  ],
  softwareCategory: [
    c('productivity', 'Productivity', 1),
    c('development', 'Development', 2),
    c('design', 'Design', 3),
    c('analytics', 'Analytics', 4),
    c('security', 'Security', 5),
    c('communication', 'Communication', 6),
  ],
  taskPriority: [
    c('1', '1 - Critical', 1),
    c('2', '2 - High', 2),
    c('3', '3 - Moderate', 3),
    c('4', '4 - Low', 4),
    c('5', '5 - Planning', 5),
  ],
};

/** Labels of the recurring frequency keys, used for cart grouping. */
export const FREQUENCY_LABEL: Record<string, string> = Object.fromEntries(
  CHOICES.recurringFrequency.map((ch) => [ch.value, ch.label]),
);

/** Two days, the documented default delivery time of an item. */
export const DEFAULT_DELIVERY_MS = 2 * 86_400_000;
