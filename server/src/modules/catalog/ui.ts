import type { Context } from '../../engine/context.js';
import type {
  FormLayoutDef,
  ListLayoutDef,
  ModuleUiDef,
  NavApplicationDef,
  UiActionDef,
} from '../../engine/module.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { type ApprovalService, optionalService, SERVICES } from '../contracts.js';
import {
  CATALOG_DEFINITION_ROLES,
  REQUEST_READ_ROLES,
  REQUEST_WRITE_ROLES,
  ROLES,
  STATE,
  T,
} from './constants.js';
import { fulfillmentOf } from './fulfillment.js';

const ME = 'javascript:gs.getUserID()';
const MY_GROUPS = 'd6435e965f510100a9ad2572f2b47744';
const MANAGERS = [...CATALOG_DEFINITION_ROLES, 'admin'];

const navigation: NavApplicationDef[] = [
  {
    id: 'service_catalog',
    title: 'Service Catalog',
    icon: 'shopping-cart',
    roles: MANAGERS,
    order: 60,
    modules: [
      { title: 'Catalogs', table: T.catalog, query: 'ORDERBYtitle' },
      { title: 'Categories', table: T.category, query: 'ORDERBYsc_catalog^ORDERBYorder^ORDERBYtitle' },
      { title: 'Items', table: T.item, query: `sys_class_name=${T.item}^ORDERBYname` },
      { title: 'Record producers', table: T.producer, query: 'ORDERBYname' },
      { title: 'Order guides', table: T.guide, query: 'ORDERBYname' },
      { title: 'Content items', table: T.content, query: 'ORDERBYname' },
      { title: 'Variable sets', table: T.variableSet, query: 'ORDERBYtitle', separator: true },
      { title: 'Variables', table: T.variable, query: 'ORDERBYcat_item^ORDERBYorder' },
      { title: 'Catalog UI policies', table: T.uiPolicy, query: 'ORDERBYcatalog_item^ORDERBYorder' },
      { title: 'Fulfillment steps', table: T.step, query: 'ORDERBYcat_item^ORDERBYorder' },
      { title: 'User criteria', table: T.criteria, query: 'ORDERBYname', roles: [ROLES.admin, 'admin'] },
      { title: 'Software titles', table: T.software, query: 'ORDERBYname' },
    ],
  },
  {
    id: 'requests',
    title: 'Requests',
    icon: 'package',
    roles: [...REQUEST_READ_ROLES, 'admin'],
    order: 50,
    modules: [
      { title: 'Requests', table: T.request, query: 'active=true^ORDERBYDESCnumber' },
      { title: 'Requested items', table: T.ritm, query: 'active=true^ORDERBYDESCnumber' },
      { title: 'Catalog tasks', table: T.task, query: 'active=true^ORDERBYDESCnumber' },
      {
        title: 'Open tasks for my groups',
        table: T.task,
        query: `active=true^assignment_groupDYNAMIC${MY_GROUPS}^ORDERBYpriority^ORDERBYsys_created_on`,
      },
      {
        title: 'Catalog tasks assigned to me',
        table: T.task,
        query: `active=true^assigned_to=${ME}^ORDERBYpriority`,
      },
      {
        title: 'Items waiting for approval',
        table: T.ritm,
        query: 'active=true^stage=waiting_for_approval^ORDERBYsys_created_on',
        separator: true,
      },
      { title: 'All requests', table: T.request, query: 'ORDERBYDESCnumber' },
      { title: 'All requested items', table: T.ritm, query: 'ORDERBYDESCnumber' },
    ],
  },
];

const lists: ListLayoutDef[] = [
  {
    table: T.catalog,
    columns: ['title', 'manager', 'editors', 'active', 'enable_wish_list', 'sys_updated_on'],
  },
  { table: T.category, columns: ['title', 'sc_catalog', 'parent', 'order', 'active'] },
  {
    table: T.item,
    columns: [
      'name',
      'sys_class_name',
      'category',
      'sc_catalogs',
      'price',
      'recurring_price',
      'group',
      'active',
      'order',
    ],
  },
  { table: T.producer, columns: ['name', 'table_name', 'category', 'sc_catalogs', 'active', 'order'] },
  { table: T.guide, columns: ['name', 'category', 'sc_catalogs', 'two_step', 'cascade', 'active'] },
  {
    table: T.variable,
    columns: ['question_text', 'name', 'type', 'cat_item', 'variable_set', 'order', 'mandatory', 'active'],
  },
  { table: T.variableSet, columns: ['title', 'internal_name', 'type', 'order', 'description'] },
  { table: T.choice, columns: ['text', 'value', 'price', 'recurring_price', 'order', 'inactive'] },
  { table: T.setItem, columns: ['variable_set', 'sc_cat_item', 'order'] },
  {
    table: T.uiPolicy,
    columns: ['short_description', 'catalog_item', 'variable_set', 'catalog_conditions', 'order', 'active'],
  },
  {
    table: T.uiPolicyAction,
    columns: ['catalog_variable', 'mandatory', 'visible', 'disabled', 'value_action', 'order'],
  },
  { table: T.step, columns: ['cat_item', 'order', 'name', 'assignment_group', 'stage', 'active'] },
  { table: T.guideRule, columns: ['position', 'item', 'condition', 'quantity', 'ignore_mandatory'] },
  {
    table: T.software,
    columns: ['name', 'publisher', 'version', 'category', 'license_type', 'price', 'active'],
  },
  {
    table: T.criteria,
    columns: ['name', 'user', 'group', 'role', 'department', 'location', 'match_all', 'active'],
  },
  {
    table: T.request,
    columns: [
      'number',
      'opened_at',
      'short_description',
      'requested_for',
      'opened_by',
      'request_state',
      'stage',
      'approval',
      'price',
      'due_date',
    ],
    defaultOrder: 'ORDERBYDESCnumber',
  },
  {
    table: T.ritm,
    columns: [
      'number',
      'opened_at',
      'cat_item',
      'request',
      'requested_for',
      'quantity',
      'stage',
      'state',
      'approval',
      'assignment_group',
      'estimated_delivery',
    ],
    defaultOrder: 'ORDERBYDESCnumber',
  },
  {
    table: T.task,
    columns: [
      'number',
      'short_description',
      'request_item',
      'request',
      'priority',
      'state',
      'assignment_group',
      'assigned_to',
      'sys_updated_on',
    ],
    defaultOrder: 'ORDERBYDESCnumber',
  },
  { table: T.option, columns: ['item_option_new', 'value', 'order'] },
  { table: T.cart, columns: ['name', 'user', 'requested_for', 'active', 'sys_updated_on'] },
  {
    table: T.cartItem,
    columns: ['cat_item', 'cart', 'quantity', 'price', 'recurring_price', 'requested_for', 'active'],
  },
];

const itemRelated = [
  {
    table: T.variable,
    field: 'cat_item',
    label: 'Variables',
    columns: ['order', 'question_text', 'name', 'type', 'mandatory', 'active'],
  },
  { table: T.setItem, field: 'sc_cat_item', label: 'Variable sets', columns: ['variable_set', 'order'] },
  {
    table: T.step,
    field: 'cat_item',
    label: 'Fulfillment steps',
    columns: ['order', 'name', 'assignment_group', 'stage', 'active'],
  },
  { table: T.appUser, field: 'sc_cat_item', label: 'Approved by (users)', columns: ['approver'] },
  { table: T.appGroup, field: 'sc_cat_item', label: 'Approved by (groups)', columns: ['approver'] },
  { table: T.itemAvailable, field: 'sc_cat_item', label: 'Available for', columns: ['user_criteria'] },
  { table: T.itemNotAvailable, field: 'sc_cat_item', label: 'Not available for', columns: ['user_criteria'] },
  { table: T.itemCategory, field: 'sc_cat_item', label: 'Additional categories', columns: ['sc_category'] },
  {
    table: T.uiPolicy,
    field: 'catalog_item',
    label: 'Catalog UI policies',
    columns: ['short_description', 'order', 'active'],
  },
  {
    table: T.ritm,
    field: 'cat_item',
    label: 'Requested items',
    columns: ['number', 'requested_for', 'stage', 'state', 'opened_at'],
  },
];

const itemMain = {
  left: ['name', 'sc_catalogs', 'category', 'owner', 'group', 'flow'],
  right: ['active', 'price', 'recurring_price', 'recurring_frequency', 'delivery_time', 'order'],
};

const forms: FormLayoutDef[] = [
  {
    table: T.catalog,
    sections: [
      { left: ['title', 'manager', 'editors'], right: ['active', 'enable_wish_list', 'desktop_image'] },
      { fields: ['description'] },
    ],
    relatedLists: [
      {
        table: T.category,
        field: 'sc_catalog',
        label: 'Categories',
        columns: ['title', 'parent', 'order', 'active'],
      },
    ],
  },
  {
    table: T.category,
    sections: [
      { left: ['title', 'sc_catalog', 'parent'], right: ['active', 'order', 'icon', 'location'] },
      { fields: ['description'] },
    ],
    relatedLists: [
      {
        table: T.item,
        field: 'category',
        label: 'Items',
        columns: ['name', 'sys_class_name', 'price', 'active'],
      },
      { table: T.category, field: 'parent', label: 'Subcategories', columns: ['title', 'order', 'active'] },
      {
        table: T.categoryAvailable,
        field: 'sc_category',
        label: 'Available for',
        columns: ['user_criteria'],
      },
      {
        table: T.categoryNotAvailable,
        field: 'sc_category',
        label: 'Not available for',
        columns: ['user_criteria'],
      },
    ],
  },
  {
    table: T.item,
    highlights: ['price', 'category', 'active'],
    sections: [
      itemMain,
      { fields: ['short_description', 'description', 'meta', 'picture', 'icon'] },
      {
        caption: 'Fulfillment',
        left: ['u_manager_approval', 'fulfillment_automation_level', 'delivery_plan'],
        right: ['access_type', 'request_method', 'no_quantity', 'no_cart', 'hide_sp'],
      },
    ],
    relatedLists: itemRelated,
  },
  {
    table: T.producer,
    highlights: ['table_name', 'category', 'active'],
    sections: [
      {
        left: ['name', 'sc_catalogs', 'category', 'owner'],
        right: ['active', 'table_name', 'redirect_url', 'can_cancel', 'order'],
      },
      { fields: ['short_description', 'description', 'picture', 'icon'] },
      { caption: 'Generated record', fields: ['resolvr_template', 'script', 'post_insert_script'] },
    ],
    relatedLists: [
      itemRelated[0],
      itemRelated[1],
      itemRelated[5],
      itemRelated[6],
      {
        table: T.produced,
        field: 'producer',
        label: 'Produced records',
        columns: ['record_table', 'record_key', 'sys_created_on'],
      },
    ],
  },
  {
    table: T.guide,
    highlights: ['category', 'two_step', 'active'],
    sections: [
      {
        left: ['name', 'sc_catalogs', 'category', 'owner'],
        right: ['active', 'two_step', 'cascade', 'include_items', 'order_to_cart', 'order'],
      },
      { fields: ['short_description', 'description', 'picture', 'icon'] },
    ],
    relatedLists: [
      itemRelated[0],
      itemRelated[1],
      {
        table: T.guideRule,
        field: 'guide',
        label: 'Rule base',
        columns: ['position', 'item', 'condition', 'quantity'],
      },
      itemRelated[5],
      itemRelated[6],
    ],
  },
  {
    table: T.variable,
    sections: [
      {
        left: ['question_text', 'name', 'type', 'cat_item', 'variable_set', 'order'],
        right: ['active', 'mandatory', 'read_only', 'hidden', 'global', 'default_value'],
      },
      {
        caption: 'Type specifications',
        left: [
          'reference',
          'use_reference_qualifier',
          'reference_qual_condition',
          'reference_qual',
          'list_table',
          'lookup_table',
          'lookup_value',
          'lookup_label',
        ],
        right: [
          'choice_table',
          'choice_field',
          'include_none',
          'validate_regex',
          'attributes',
          'scale_min',
          'scale_max',
        ],
      },
      {
        caption: 'Pricing',
        left: ['price_if_checked', 'rec_price_if_checked'],
        right: ['pricing_implications'],
      },
      {
        caption: 'Annotation',
        fields: ['tooltip', 'example_text', 'help_text', 'show_help', 'instructions'],
      },
      {
        caption: 'Record producer mapping',
        left: ['map_to_field', 'field'],
        right: ['enable_also_request_for', 'selection_required'],
      },
    ],
    relatedLists: [
      {
        table: T.choice,
        field: 'question',
        label: 'Question choices',
        columns: ['order', 'text', 'value', 'price', 'recurring_price', 'inactive'],
      },
    ],
  },
  {
    table: T.variableSet,
    sections: [
      {
        left: ['title', 'internal_name', 'type'],
        right: ['order', 'layout', 'display_title', 'set_attributes'],
      },
      { fields: ['description'] },
    ],
    relatedLists: [
      {
        table: T.variable,
        field: 'variable_set',
        label: 'Variables',
        columns: ['order', 'question_text', 'name', 'type', 'mandatory'],
      },
      { table: T.setItem, field: 'variable_set', label: 'Included in', columns: ['sc_cat_item', 'order'] },
    ],
  },
  {
    table: T.uiPolicy,
    sections: [
      {
        left: ['short_description', 'applies_to', 'catalog_item', 'variable_set'],
        right: ['active', 'order', 'on_load', 'reverse_if_false'],
      },
      { fields: ['catalog_conditions'] },
      {
        caption: 'Applies on',
        left: ['applies_catalog', 'applies_req_item'],
        right: ['applies_sc_task', 'applies_target_record'],
      },
    ],
    relatedLists: [
      {
        table: T.uiPolicyAction,
        field: 'ui_policy',
        label: 'Actions',
        columns: ['catalog_variable', 'mandatory', 'visible', 'disabled', 'value_action'],
      },
    ],
  },
  {
    table: T.step,
    sections: [
      {
        left: ['cat_item', 'name', 'order', 'stage'],
        right: ['assignment_group', 'assigned_to', 'priority', 'active'],
      },
      { fields: ['short_description', 'description', 'condition', 'include_variables'] },
    ],
  },
  {
    table: T.software,
    sections: [
      {
        left: ['name', 'publisher', 'version', 'category'],
        right: ['license_type', 'price', 'recurring_price', 'approval_required', 'active'],
      },
      { fields: ['description'] },
    ],
  },
  {
    table: T.request,
    highlights: ['request_state', 'stage', 'approval'],
    sections: [
      {
        left: ['number', 'requested_for', 'opened_by', 'opened_at', 'due_date'],
        right: ['request_state', 'stage', 'approval', 'price', 'requested_date'],
      },
      { fields: ['short_description', 'special_instructions', 'delivery_address'] },
      { caption: 'Notes', fields: ['watch_list', 'comments', 'work_notes'] },
    ],
    relatedLists: [
      {
        table: T.ritm,
        field: 'request',
        label: 'Requested items',
        columns: ['number', 'cat_item', 'requested_for', 'quantity', 'price', 'stage', 'state'],
      },
      {
        table: T.task,
        field: 'request',
        label: 'Catalog tasks',
        columns: ['number', 'short_description', 'state', 'assignment_group', 'assigned_to'],
      },
      {
        table: T.approval,
        field: 'document_id',
        label: 'Approvers',
        columns: ['approver', 'state', 'comments', 'sys_updated_on'],
      },
    ],
  },
  {
    table: T.ritm,
    highlights: ['stage', 'state', 'approval'],
    sections: [
      {
        left: ['number', 'cat_item', 'request', 'requested_for', 'opened_by', 'quantity'],
        right: ['stage', 'state', 'approval', 'assignment_group', 'assigned_to', 'estimated_delivery'],
      },
      { fields: ['short_description', 'description'] },
      {
        caption: 'Pricing',
        left: ['price', 'recurring_price'],
        right: ['recurring_frequency', 'order_guide'],
      },
      { caption: 'Notes', fields: ['watch_list', 'comments', 'work_notes'] },
    ],
    relatedLists: [
      {
        table: T.task,
        field: 'request_item',
        label: 'Catalog tasks',
        columns: ['number', 'short_description', 'state', 'assignment_group', 'assigned_to'],
      },
      {
        table: T.option,
        label: 'Variables',
        via: { table: T.optionLink, parentField: 'request_item', childField: 'sc_item_option' },
        columns: ['item_option_new', 'value'],
      },
      {
        table: T.approval,
        field: 'document_id',
        label: 'Approvers',
        columns: ['approver', 'state', 'comments', 'sys_updated_on'],
      },
    ],
  },
  {
    table: T.task,
    highlights: ['state', 'assigned_to', 'priority'],
    sections: [
      {
        left: ['number', 'request_item', 'request', 'cat_item', 'opened_at'],
        right: ['state', 'priority', 'assignment_group', 'assigned_to', 'due_date'],
      },
      { fields: ['short_description', 'description', 'close_notes'] },
      { caption: 'Notes', fields: ['watch_list', 'comments', 'work_notes'] },
    ],
  },
];

// --------------------------------------------------------------- UI actions

function approvals(ctx: Context): ApprovalService | undefined {
  return optionalService<ApprovalService>(ctx.platform, SERVICES.approvals);
}

const canDecide = (rec: Rec, ctx: Context) =>
  !!approvals(ctx) &&
  rec.bool('active') &&
  rec.str('approval') === 'requested' &&
  fulfillmentOf(ctx.platform).pendingApprovalsFor(ctx, rec).length > 0;

function decide(
  rec: Rec,
  ctx: Context,
  decision: 'approved' | 'rejected',
  comments: string,
): { message: string } {
  const svc = approvals(ctx);
  if (!svc) return { message: 'Approvals are not installed' };
  const rows = fulfillmentOf(ctx.platform).pendingApprovalsFor(ctx, rec);
  if (!rows.length) return { message: 'Nothing is waiting for your approval on this record' };
  svc.decide(ctx, rows[0], decision, comments || undefined);
  return { message: `${rec.str('number')} ${decision === 'approved' ? 'approved' : 'rejected'}` };
}

const text = (input: Record<string, unknown>, field: string) => String(input[field] ?? '').trim();

const approvalActions: UiActionDef[] = [T.request, T.ritm].flatMap((table): UiActionDef[] => [
  {
    id: `${table}.approve`,
    table,
    label: 'Approve',
    style: 'primary',
    order: 10,
    condition: canDecide,
    prompt: [{ field: 'comments', label: 'Comment (optional)', mandatory: false }],
    run: (rec, ctx, input) => decide(rec, ctx, 'approved', text(input, 'comments')),
  },
  {
    id: `${table}.reject`,
    table,
    label: 'Reject',
    style: 'destructive',
    order: 11,
    condition: canDecide,
    prompt: [{ field: 'comments', label: 'Why is it rejected?', mandatory: true }],
    run: (rec, ctx, input) => decide(rec, ctx, 'rejected', text(input, 'comments')),
  },
]);

const uiActions: UiActionDef[] = [
  ...approvalActions,
  {
    id: `${T.request}.cancel`,
    table: T.request,
    label: 'Cancel request',
    style: 'destructive',
    order: 50,
    condition: (rec, ctx) => fulfillmentOf(ctx.platform).canCancel(ctx, rec),
    confirm: 'Cancel this request and all of its items?',
    prompt: [{ field: 'comments', label: 'Reason', mandatory: false }],
    run(rec, ctx, input) {
      fulfillmentOf(ctx.platform).cancelRequest(
        ctx,
        rec,
        text(input, 'comments') || 'Cancelled by the requester',
      );
      return { message: `${rec.str('number')} cancelled` };
    },
  },
  {
    id: `${T.ritm}.cancel`,
    table: T.ritm,
    label: 'Cancel request',
    style: 'destructive',
    order: 50,
    condition: (rec, ctx) => fulfillmentOf(ctx.platform).canCancel(ctx, rec),
    confirm: 'Cancel this requested item?',
    prompt: [{ field: 'comments', label: 'Reason', mandatory: false }],
    run(rec, ctx, input) {
      fulfillmentOf(ctx.platform).cancelItem(
        ctx,
        rec,
        text(input, 'comments') || 'Cancelled by the requester',
      );
      return { message: `${rec.str('number')} cancelled` };
    },
  },
  {
    id: `${T.task}.close`,
    table: T.task,
    label: 'Close task',
    style: 'primary',
    order: 10,
    condition: (rec, ctx) =>
      rec.bool('active') &&
      (ctx.hasAnyRole([...REQUEST_WRITE_ROLES, ROLES.admin]) ||
        (!!ctx.user.sysId && rec.str('assigned_to') === ctx.user.sysId)),
    prompt: [{ field: 'close_notes', label: 'Close notes', mandatory: false }],
    run(rec, ctx, input) {
      const values: Record<string, unknown> = { state: STATE.complete };
      if (text(input, 'close_notes')) values.close_notes = text(input, 'close_notes');
      ctx.elevated().update(ctx.elevated().get(T.task, rec.sysId) ?? rec, values);
      return { message: `${rec.str('number')} closed` };
    },
  },
  {
    id: `${T.task}.close_incomplete`,
    table: T.task,
    label: 'Close incomplete',
    order: 20,
    roles: [...REQUEST_WRITE_ROLES, ROLES.admin],
    condition: (rec) => rec.bool('active'),
    prompt: [{ field: 'close_notes', label: 'What could not be done?', mandatory: true }],
    run(rec, ctx, input) {
      ctx.update(rec, { state: STATE.incomplete, close_notes: text(input, 'close_notes') });
      return { message: `${rec.str('number')} closed incomplete` };
    },
  },
  {
    id: `${T.task}.assign_to_me`,
    table: T.task,
    label: 'Assign to me',
    order: 5,
    roles: [...REQUEST_WRITE_ROLES],
    condition: (rec, ctx) =>
      rec.bool('active') && !!ctx.user.sysId && rec.str('assigned_to') !== ctx.user.sysId,
    run(rec, ctx) {
      const values: Record<string, unknown> = { assigned_to: ctx.user.sysId };
      if (rec.str('state') === STATE.open) values.state = STATE.wip;
      ctx.update(rec, values);
      return { message: `${rec.str('number')} assigned to you` };
    },
  },
];

export const CATALOG_UI: ModuleUiDef = { navigation, forms, lists, uiActions };

/** Removes related lists whose tables are not installed (approvals are optional). */
export function pruneCatalogRelatedLists(platform: Platform): void {
  for (const form of forms) {
    const key = `${form.table}:${form.view ?? 'default'}`;
    const current = platform.forms.get(key);
    if (current !== form || !form.relatedLists?.length) continue;
    const kept = form.relatedLists.filter(
      (r) => platform.registry.has(r.table) && (!r.via || platform.registry.has(r.via.table)),
    );
    if (kept.length !== form.relatedLists.length) platform.forms.set(key, { ...form, relatedLists: kept });
  }
}
