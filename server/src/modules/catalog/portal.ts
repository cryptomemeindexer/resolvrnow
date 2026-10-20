/**
 * Portal-friendly catalog APIs under /api/app/catalog (documented in docs/api/catalog.md):
 * browse, item forms ready to render, ordering, My Requests and ticket pages.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, HttpError, intParam } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import { CatalogAccess, canRequestForOthers, splitList } from './access.js';
import { findItem, searchItems } from './api.js';
import { APPROVAL, CLOSED_STATES, FREQUENCY_LABEL, ROLES, STAGE, T, VT } from './constants.js';
import { fulfillmentOf } from './fulfillment.js';
import { cascadeFor, evaluateGuide, orderGuide } from './guide.js';
import { type OrderResult, orderNow } from './ordering.js';
import {
  answersJson,
  catalogCategories,
  categoryItemCount,
  clientScriptsJson,
  itemSummary,
  policiesJson,
  variableJson,
} from './present.js';
import { submitProducer } from './producer.js';
import {
  currencyCode,
  deliveryLabel,
  itemKind,
  money,
  noAccess,
  parseQuantity,
  showPrice,
  showQuantity,
  VariableError,
} from './util.js';
import {
  defaultOf,
  effectiveStates,
  hasPriceVariables,
  type ItemForm,
  loadForm,
  readAnswers,
  type VarDef,
} from './variables.js';

type Body = Record<string, unknown>;
type Q = Record<string, string | undefined>;

const UI_TYPES: Record<number, string> = {
  1: 'yes_no',
  2: 'textarea',
  3: 'radio',
  4: 'scale',
  5: 'select',
  6: 'text',
  7: 'checkbox',
  8: 'reference',
  9: 'date',
  10: 'datetime',
  11: 'label',
  12: 'break',
  14: 'unsupported',
  15: 'unsupported',
  16: 'text',
  17: 'unsupported',
  18: 'select',
  19: 'container_start',
  20: 'container_end',
  21: 'multi_reference',
  22: 'checkbox_group',
  23: 'html',
  24: 'container_split',
  25: 'password',
  26: 'email',
  27: 'url',
  28: 'ip_address',
  29: 'duration',
  31: 'reference',
  32: 'rich_text_label',
  33: 'attachment',
};

const SUBMIT_LABEL: Record<string, string> = { order: 'Order Now', request: 'Request', submit: 'Submit' };

function body(req: FastifyRequest): Body {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {};
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

function vars(b: Body): Record<string, unknown> {
  const v = b.variables;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function userRef(ctx: Context, id: string): { sys_id: string; name: string } | null {
  return id ? { sys_id: id, name: ctx.displayOf('sys_user', id) } : null;
}

// ------------------------------------------------------------------- forms

/** A variable ready to render: API variable plus UI type, state and default. */
function portalVariable(
  ctx: Context,
  def: VarDef,
  value: string,
  state: { mandatory: boolean; visible: boolean; readOnly: boolean } | undefined,
): Record<string, unknown> {
  const base = variableJson(ctx, def, value, state);
  return {
    ...base,
    sys_id: def.id,
    ui_type: UI_TYPES[def.type] ?? 'text',
    wide: def.type === VT.wideSingleLine || def.layout !== 'normal',
    show_help: def.showHelp,
    default_value: def.type === VT.masked ? '' : value,
    choice_direction: def.rec.str('choice_direction') || 'down',
    scale: def.type === VT.scale ? { min: def.scaleMin, max: def.scaleMax } : undefined,
    selection_required: def.selectionRequired,
    dependent_on: def.dependentOn || undefined,
  };
}

/** Item form payload for the portal (GET /api/app/catalog/items/:id/form). */
export function itemForm(
  ctx: Context,
  access: CatalogAccess,
  item: Rec,
  opts: { cascade?: Record<string, string>; guide?: boolean } = {},
): Record<string, unknown> {
  const platform = ctx.platform;
  const form: ItemForm = loadForm(ctx, item, { context: opts.guide ? 'guide' : 'standalone' });
  const values: Record<string, string> = {};
  for (const def of form.vars)
    if (def.info.data) values[def.name] = opts.cascade?.[def.name] ?? defaultOf(ctx, def);
  const states = effectiveStates(ctx, form, values);
  const variables = form.vars.map((def) =>
    portalVariable(ctx, def, values[def.name] ?? '', states.get(def.name)),
  );
  const kind = itemKind(item);
  const method = item.str('request_method') || 'order';
  const shown = showPrice(platform, item, hasPriceVariables(ctx, form));
  const rf = form.vars.find((d) => d.type === VT.requestedFor);
  const approvals = fulfillmentOf(platform);
  const sys = platform.systemContext();
  return {
    item: {
      ...itemSummary(ctx, access, item, form),
      request_method: method,
      submit_label: kind === 'record_producer' ? 'Submit' : (SUBMIT_LABEL[method] ?? 'Order Now'),
      confirm: kind === 'catalog_item' && method !== 'submit',
      price_value: item.num('price') ?? 0,
      recurring_price_value: item.num('recurring_price') ?? 0,
      recurring_frequency_label: item.str('recurring_frequency')
        ? (FREQUENCY_LABEL[item.str('recurring_frequency')] ?? '')
        : '',
      currency: currencyCode(platform),
      show_price: shown,
      show_quantity: showQuantity(item),
      quantity_choices: Array.from({ length: 10 }, (_, i) => i + 1),
      delivery_time: kind === 'catalog_item' ? deliveryLabel(ctx, item) : '',
      no_cart: item.bool('no_cart') || item.bool('no_cart_v2') || kind !== 'catalog_item',
      no_order_now: item.bool('no_order_now'),
      mandatory_attachment: item.bool('mandatory_attachment'),
      hide_attachment: item.bool('no_attachment_v2'),
      access_type: item.str('access_type') || 'restricted',
      target_table: kind === 'record_producer' ? item.str('table_name') : undefined,
      approvals: {
        manager: item.bool('u_manager_approval'),
        users: sys.query(T.appUser, { query: `sc_cat_item=${item.sysId}` }).map((r) => r.display('approver')),
        groups: sys
          .query(T.appGroup, { query: `sc_cat_item=${item.sysId}` })
          .map((r) => r.display('approver')),
      },
      fulfillment_steps: approvals
        .steps(sys, item)
        .map((s) => ({ name: s.name, order: s.order, stage: s.stage })),
    },
    variables,
    variable_sets: form.sets.map((s) => ({
      sys_id: s.id,
      title: s.title,
      internal_name: s.internalName,
      type: s.type,
      max_rows: s.type === 'one_to_many' ? s.maxRows : undefined,
      variables:
        s.type === 'one_to_many'
          ? s.vars.map((d) => portalVariable(ctx, d, defaultOf(ctx, d), undefined))
          : s.vars.map((d) => d.name),
    })),
    ui_policies: policiesJson(ctx, form),
    client_scripts: clientScriptsJson(ctx, form),
    requested_for: {
      variable: rf?.name ?? null,
      value: userRef(ctx, rf ? values[rf.name] : (ctx.user.sysId ?? '')),
      can_change: canRequestForOthers(ctx),
      also_request_for: !!rf?.enableAlsoRequestFor,
    },
    values,
  };
}

// --------------------------------------------------------------- requests

function choiceDisplay(rec: Rec, field: string): { value: string; display: string } {
  return { value: rec.str(field), display: rec.display(field) };
}

/** User-facing state badge (portal spec 3.6). */
export function itemBadge(ritm: Rec): string {
  if (ritm.str('stage') === STAGE.cancelled)
    return ritm.str('approval') === APPROVAL.rejected ? 'Rejected' : 'Cancelled';
  if (!ritm.bool('active') || CLOSED_STATES.includes(ritm.str('state'))) return 'Closed';
  if (ritm.str('approval') === APPROVAL.requested) return 'Awaiting Approval';
  if (ritm.str('stage') === STAGE.waiting) return 'Submitted';
  return 'In Progress';
}

function requestBadge(req: Rec, items: Rec[]): string {
  const rs = req.str('request_state');
  if (rs === 'closed_cancelled') return 'Cancelled';
  if (rs === 'closed_rejected') return 'Rejected';
  if (!req.bool('active')) return 'Closed';
  if (req.str('approval') === APPROVAL.requested) return 'Awaiting Approval';
  const badges = items.map(itemBadge);
  if (badges.includes('In Progress')) return 'In Progress';
  if (badges.includes('Awaiting Approval')) return 'Awaiting Approval';
  if (badges.length && badges.every((b) => b === 'Closed' || b === 'Cancelled' || b === 'Rejected'))
    return 'Closed';
  return 'Submitted';
}

interface TimelineStep {
  id: string;
  label: string;
  status: 'done' | 'current' | 'pending' | 'skipped' | 'cancelled';
  at: string | null;
  detail?: string;
  approvers?: string[];
}

/** Request timeline of a requested item (portal spec section 4). */
export function itemTimeline(ctx: Context, ritm: Rec): TimelineStep[] {
  const sys = ctx.platform.systemContext();
  const f = fulfillmentOf(ctx.platform);
  const stage = ritm.str('stage');
  const approval = ritm.str('approval');
  const cancelled = stage === STAGE.cancelled;
  const hasApprovalRows =
    ctx.platform.registry.has(T.approval) && sys.count(T.approval, `document_id=${ritm.sysId}`) > 0;
  const approvalHappened =
    approval === APPROVAL.requested ||
    approval === APPROVAL.rejected ||
    !!ritm.str('approval_set') ||
    hasApprovalRows;
  const tasks = sys.query(T.task, {
    query: `request_item=${ritm.sysId}`,
    orderBy: [{ field: 'opened_at', desc: false }],
  });
  const working = stage === STAGE.fulfillment || stage === STAGE.delivery;
  const complete = stage === STAGE.complete || (!ritm.bool('active') && !cancelled);
  const steps: TimelineStep[] = [
    {
      id: 'submitted',
      label: 'Submitted',
      status: 'done',
      at: ritm.str('opened_at') || ritm.str('sys_created_on'),
    },
  ];
  let approvalStep: TimelineStep;
  if (approval === APPROVAL.requested)
    approvalStep = {
      id: 'approval',
      label: 'Awaiting Approval',
      status: 'current',
      at: null,
      approvers: f.pendingApprovers(ctx, ritm),
    };
  else if (approval === APPROVAL.rejected)
    approvalStep = {
      id: 'approval',
      label: 'Awaiting Approval',
      status: 'done',
      at: ritm.str('approval_set') || null,
      detail: 'Rejected',
    };
  else if (approvalHappened && (working || complete || approval === APPROVAL.approved))
    approvalStep = {
      id: 'approval',
      label: 'Awaiting Approval',
      status: 'done',
      at: ritm.str('approval_set') || null,
      detail: 'Approved',
    };
  else if (stage === STAGE.waiting)
    approvalStep = { id: 'approval', label: 'Awaiting Approval', status: 'pending', at: null };
  else
    approvalStep = {
      id: 'approval',
      label: 'Awaiting Approval',
      status: 'skipped',
      at: null,
      detail: 'No approval needed',
    };
  steps.push(approvalStep);
  const fulfillStep: TimelineStep = {
    id: 'fulfillment',
    label: 'Fulfillment',
    status: complete ? 'done' : working ? 'current' : 'pending',
    at: tasks[0]?.str('opened_at') || null,
    detail: stage === STAGE.delivery ? 'Delivery' : undefined,
  };
  steps.push(fulfillStep);
  steps.push({
    id: 'closed',
    label: 'Closed',
    status: complete ? 'done' : 'pending',
    at: complete ? ritm.str('closed_at') || null : null,
  });
  if (!cancelled) return steps;
  const reached = steps.filter(
    (s) => s.status === 'done' || s.status === 'current' || (s.id === 'fulfillment' && tasks.length > 0),
  );
  const out = steps
    .slice(0, Math.max(1, steps.indexOf(reached[reached.length - 1]) + 1))
    .map((s) => (s.status === 'current' ? { ...s, status: 'done' as const } : s));
  out.push({
    id: 'cancelled',
    label: 'Cancelled',
    status: 'cancelled',
    at: ritm.str('closed_at') || null,
    detail: approval === APPROVAL.rejected ? 'Rejected by an approver' : undefined,
  });
  return out;
}

function itemEntry(ctx: Context, ritm: Rec, opts: { timeline?: boolean } = {}): Record<string, unknown> {
  const sys = ctx.platform.systemContext();
  const item = ritm.str('cat_item') ? sys.get(T.item, ritm.str('cat_item')) : null;
  return {
    table: T.ritm,
    sys_id: ritm.sysId,
    number: ritm.str('number'),
    title: item?.str('name') || ritm.str('short_description'),
    cat_item: item
      ? { sys_id: item.sysId, name: item.str('name'), picture: item.str('picture'), icon: item.str('icon') }
      : null,
    request: ritm.str('request') ? { sys_id: ritm.str('request'), number: ritm.display('request') } : null,
    requested_for: userRef(ctx, ritm.str('requested_for')),
    opened_by: userRef(ctx, ritm.str('opened_by')),
    quantity: ritm.num('quantity') ?? 1,
    price: ritm.num('price') ?? 0,
    price_display: money(ctx.platform, ritm.num('price') ?? 0),
    recurring_price: ritm.num('recurring_price') ?? 0,
    recurring_frequency: ritm.str('recurring_frequency')
      ? (FREQUENCY_LABEL[ritm.str('recurring_frequency')] ?? '')
      : '',
    stage: choiceDisplay(ritm, 'stage'),
    state: choiceDisplay(ritm, 'state'),
    approval: choiceDisplay(ritm, 'approval'),
    badge: itemBadge(ritm),
    active: ritm.bool('active'),
    created: ritm.str('opened_at') || ritm.str('sys_created_on'),
    updated: ritm.str('sys_updated_on'),
    closed_at: ritm.str('closed_at') || null,
    estimated_delivery: ritm.str('estimated_delivery') || null,
    ...(opts.timeline !== false ? { timeline: itemTimeline(ctx, ritm) } : {}),
  };
}

function requestEntry(ctx: Context, req: Rec, items: Rec[]): Record<string, unknown> {
  const entries = items.map((i) => itemEntry(ctx, i));
  const single = items.length === 1 ? items[0] : null;
  return {
    table: T.request,
    sys_id: req.sysId,
    number: req.str('number'),
    title: req.str('short_description') || (single ? String(entries[0].title) : req.str('number')),
    requested_for: userRef(ctx, req.str('requested_for')),
    opened_by: userRef(ctx, req.str('opened_by')),
    request_state: choiceDisplay(req, 'request_state'),
    stage: choiceDisplay(req, 'stage'),
    state: choiceDisplay(req, 'state'),
    approval: choiceDisplay(req, 'approval'),
    badge: requestBadge(req, items),
    active: req.bool('active'),
    price: req.num('price') ?? 0,
    price_display: money(ctx.platform, req.num('price') ?? 0),
    created: req.str('opened_at') || req.str('sys_created_on'),
    updated:
      [req.str('sys_updated_on'), ...items.map((i) => i.str('sys_updated_on'))].sort().pop() ??
      req.str('sys_updated_on'),
    closed_at: req.str('closed_at') || null,
    due_date: req.str('due_date') || null,
    link: single ? { table: T.ritm, sys_id: single.sysId } : { table: T.request, sys_id: req.sysId },
    items: entries,
    timeline: single ? entries[0].timeline : undefined,
  };
}

/**
 * The caller's requests (My Requests): requests opened by or for the user, plus
 * items someone else ordered for them (listed on their own, spec 10).
 */
export function myRequests(
  ctx: Context,
  opts: { filter?: string; q?: string; limit?: number; offset?: number } = {},
): { result: Record<string, unknown>[]; total: number; counts: Record<string, number> } {
  const me = ctx.user.sysId;
  if (!me) return { result: [], total: 0, counts: { open: 0, closed: 0, all: 0 } };
  const reqs = ctx.query(T.request, { query: `opened_by=${me}^ORrequested_for=${me}` });
  const reqIds = new Set(reqs.map((r) => r.sysId));
  const itemsByReq = new Map<string, Rec[]>();
  if (reqs.length) {
    for (const i of ctx.query(T.ritm, {
      query: `requestIN${[...reqIds].join(',')}`,
      orderBy: [{ field: 'number', desc: false }],
    })) {
      itemsByReq.set(i.str('request'), [...(itemsByReq.get(i.str('request')) ?? []), i]);
    }
  }
  const forMe = ctx
    .query(T.ritm, { query: `requested_for=${me}` })
    .filter((i) => !reqIds.has(i.str('request')));
  const entries: Record<string, unknown>[] = [
    ...reqs.map((r) => requestEntry(ctx, r, itemsByReq.get(r.sysId) ?? [])),
    ...forMe.map((i) => ({ ...itemEntry(ctx, i), link: { table: T.ritm, sys_id: i.sysId } })),
  ];
  const isOpen = (e: Record<string, unknown>) => e.active === true;
  const counts = {
    open: entries.filter(isOpen).length,
    closed: entries.filter((e) => !isOpen(e)).length,
    all: entries.length,
  };
  const filter = (opts.filter ?? 'open').toLowerCase();
  let list =
    filter === 'all'
      ? entries
      : filter === 'closed'
        ? entries.filter((e) => !isOpen(e))
        : entries.filter(isOpen);
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter((e) => {
      const numbers = [
        String(e.number),
        ...((e.items as Record<string, unknown>[] | undefined) ?? []).map((i) => String(i.number)),
      ].map((n) => n.toLowerCase());
      return numbers.some((n) => n.startsWith(q)) || String(e.title).toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return { result: list.slice(offset, offset + limit), total: list.length, counts };
}

/** Ticket page payload for a requested item or a request. */
export function ticketDetail(ctx: Context, table: string, id: string): Record<string, unknown> {
  const rec = isSysId(id) && (table === T.ritm || table === T.request) ? ctx.get(table, id) : null;
  if (!rec)
    throw new HttpError(404, 'No Record found', 'The ticket does not exist or you do not have access to it');
  const f = fulfillmentOf(ctx.platform);
  const sys = ctx.platform.systemContext();
  const me = ctx.user.sysId;
  const actions = {
    can_cancel: f.canCancel(ctx, rec),
    can_comment:
      rec.bool('active') &&
      (ctx.hasAnyRole(['itil', ROLES.requestWrite]) ||
        rec.str('opened_by') === me ||
        rec.str('requested_for') === me),
    can_approve: f.pendingApprovalsFor(ctx, rec).length > 0,
  };
  const approvalsList = ctx.platform.registry.has(T.approval)
    ? sys
        .query(T.approval, {
          query: `document_id=${rec.sysId}`,
          orderBy: [{ field: 'sys_created_on', desc: false }],
        })
        .map((a) => ({
          approver: a.display('approver'),
          state: { value: a.str('state'), display: a.display('state') },
          updated: a.str('sys_updated_on'),
        }))
    : [];
  if (table === T.request) {
    const items = ctx.query(T.ritm, {
      query: `request=${rec.sysId}`,
      orderBy: [{ field: 'number', desc: false }],
    });
    return {
      ...requestEntry(ctx, rec, items),
      special_instructions: rec.str('special_instructions'),
      delivery_address: rec.str('delivery_address'),
      approvals: approvalsList,
      actions,
    };
  }
  const item = rec.str('cat_item') ? sys.get(T.item, rec.str('cat_item')) : null;
  let variables: Record<string, unknown>[] = [];
  if (item) {
    const form = loadForm(ctx, item, {
      context: rec.str('order_guide') ? 'guide' : 'standalone',
      includeInactive: true,
    });
    const answers = readAnswers(ctx, form, { table: T.ritm, id: rec.sysId });
    const reveal =
      ctx.hasRole(ROLES.viewMasked) ||
      (!!me && (rec.str('opened_by') === me || rec.str('requested_for') === me));
    variables = answersJson(ctx, form, answers.values, answers.rows, { reveal });
  }
  const tasks = ctx
    .query(T.task, { query: `request_item=${rec.sysId}`, orderBy: [{ field: 'number', desc: false }] })
    .map((t) => ({
      sys_id: t.sysId,
      number: t.str('number'),
      short_description: t.str('short_description'),
      state: choiceDisplay(t, 'state'),
      assignment_group: t.display('assignment_group'),
      assigned_to: t.display('assigned_to'),
      active: t.bool('active'),
    }));
  return {
    ...itemEntry(ctx, rec),
    short_description: rec.str('short_description'),
    description: item?.str('description') ?? '',
    assignment_group: rec.display('assignment_group'),
    assigned_to: rec.display('assigned_to'),
    variables,
    tasks,
    approvals: approvalsList,
    actions,
  };
}

function orderPayload(ctx: Context, result: OrderResult): Record<string, unknown> {
  const req = result.request;
  return {
    request: {
      table: T.request,
      sys_id: req.sysId,
      number: req.str('number'),
      request_state: choiceDisplay(req, 'request_state'),
      price: req.num('price') ?? 0,
      price_display: money(ctx.platform, req.num('price') ?? 0),
      requested_for: userRef(ctx, req.str('requested_for')),
    },
    request_items: result.items.map((i) =>
      itemEntry(ctx, ctx.platform.systemContext().get(T.ritm, i.sysId) ?? i, { timeline: false }),
    ),
  };
}

// -------------------------------------------------------------------- routes

export function registerPortalCatalogApi(app: FastifyInstance, deps: ApiDeps): void {
  const route = (
    method: 'GET' | 'POST',
    url: string,
    handler: (req: FastifyRequest, reply: FastifyReply, ctx: Context) => unknown,
  ) => {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const ctx = ctxOf(req, deps);
        try {
          const out = await handler(req, reply, ctx);
          deps.platform.scheduleWork();
          return out;
        } catch (e) {
          if (e instanceof VariableError)
            return reply
              .code(400)
              .send({ error: { message: e.message, detail: e.detail, fields: e.fields }, status: 'failure' });
          throw e;
        }
      },
    });
  };

  route('GET', '/api/app/catalog/catalogs', (_req, _reply, ctx) => {
    const access = new CatalogAccess(ctx);
    const sys = ctx.platform.systemContext();
    const tree = (catalogId: string, parent: string | null): Record<string, unknown>[] =>
      catalogCategories(ctx, access, catalogId, false)
        .filter((c) => (c.str('parent') || null) === parent)
        .map((c) => ({
          sys_id: c.sysId,
          title: c.str('title'),
          description: c.str('description'),
          icon: c.str('icon'),
          count: categoryItemCount(ctx, access, c.sysId),
          children: tree(catalogId, c.sysId),
        }));
    const result = sys
      .query(T.catalog, { query: 'active=true', orderBy: [{ field: 'title', desc: false }] })
      .map((c) => ({
        sys_id: c.sysId,
        title: c.str('title'),
        description: c.str('description'),
        image: c.str('desktop_image'),
        categories: tree(c.sysId, null),
      }));
    return { result };
  });

  route('GET', '/api/app/catalog/items', (req, _reply, ctx) => {
    const q = req.query as Q;
    const access = new CatalogAccess(ctx);
    const items = searchItems(ctx, access, {
      catalog: str(q.catalog),
      category: str(q.category),
      text: str(q.q),
      type: str(q.type),
      portal: true,
    });
    const limit = intParam(q.limit, 100, 1, 1000);
    const offset = intParam(q.offset, 0, 0);
    return {
      result: items.slice(offset, offset + limit).map((i) => itemSummary(ctx, access, i)),
      total: items.length,
    };
  });

  route('GET', '/api/app/catalog/items/:id/form', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const item = findItem(ctx, id);
    if (!item || !access.canViewItem(item, { portal: true }))
      throw new HttpError(404, 'No Record found', 'The item does not exist or is not available to you');
    return { result: itemForm(ctx, access, item) };
  });

  route('POST', '/api/app/catalog/items/:id/order', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const item = findItem(ctx, id);
    if (!item) throw noAccess();
    const kind = itemKind(item);
    if (kind === 'record_producer') {
      const produced = submitProducer(ctx, item, {
        variables: vars(b),
        portal: true,
        attachments: splitList(str(b.attachments)),
      });
      return { result: { request: null, request_items: [], record: producedPayload(produced.record) } };
    }
    if (kind !== 'catalog_item')
      throw new HttpError(
        400,
        'This item cannot be ordered directly',
        kind === 'order_guide'
          ? 'Use /api/app/catalog/guides/{id}/order for order guides'
          : 'Content items are information only',
      );
    const result = orderNow(
      ctx,
      item,
      {
        quantity: parseQuantity(b.quantity, 1),
        variables: vars(b),
        requestedFor: str(b.requested_for) || null,
        alsoRequestFor: Array.isArray(b.also_request_for)
          ? b.also_request_for.map(String)
          : splitList(str(b.also_request_for)),
        portal: true,
      },
      {
        deliveryAddress: b.delivery_address === undefined ? null : str(b.delivery_address),
        specialInstructions: b.special_instructions === undefined ? null : str(b.special_instructions),
        requestedDate: str(b.requested_date) || null,
        attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : splitList(str(b.attachments)),
      },
    );
    return { result: orderPayload(ctx, result) };
  });

  route('POST', '/api/app/catalog/producers/:id/submit', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const item = findItem(ctx, id);
    if (!item) throw new HttpError(404, 'No Record found', `Record producer ${id} does not exist`);
    if (itemKind(item) !== 'record_producer')
      throw new HttpError(400, 'Invalid record producer', `${item.str('name')} is not a record producer`);
    const produced = submitProducer(ctx, item, {
      variables: vars(b),
      portal: true,
      attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : [],
    });
    return { result: { record: producedPayload(produced.record) } };
  });

  route('POST', '/api/app/catalog/guides/:id/evaluate', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const guide = findItem(ctx, id);
    if (!guide || itemKind(guide) !== 'order_guide') throw noAccess('Not an order guide');
    const evaluation = evaluateGuide(ctx, guide, vars(body(req)), { portal: true });
    return {
      result: {
        guide: itemSummary(ctx, access, guide),
        include_toggle: guide.get('include_items') === null ? true : guide.bool('include_items'),
        items: evaluation.items.map((sel) => ({
          quantity: sel.quantity,
          show_quantity: sel.showQuantity,
          position: sel.position,
          form: itemForm(ctx, access, sel.item, {
            cascade: cascadeFor(ctx, evaluation, sel.item),
            guide: true,
          }),
        })),
      },
    };
  });

  route('POST', '/api/app/catalog/guides/:id/order', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const guide = findItem(ctx, id);
    if (!guide || itemKind(guide) !== 'order_guide') throw noAccess('Not an order guide');
    const evaluation = evaluateGuide(ctx, guide, vars(b), { portal: true });
    const items = Array.isArray(b.items)
      ? (b.items as Body[]).map((i) => ({
          sys_id: str(i.sys_id),
          quantity: parseQuantity(i.quantity, 1),
          variables: vars(i),
          include: i.include !== false,
        }))
      : evaluation.items.map((s) => ({
          sys_id: s.item.sysId,
          quantity: s.quantity,
          variables: {},
          include: true,
        }));
    const result = orderGuide(ctx, evaluation, items, {
      portal: true,
      specialInstructions: b.special_instructions === undefined ? null : str(b.special_instructions),
    });
    return { result: orderPayload(ctx, result) };
  });

  route('GET', '/api/app/catalog/my-requests', (req, _reply, ctx) => {
    const q = req.query as Q;
    const out = myRequests(ctx, {
      filter: q.filter,
      q: q.q,
      limit: intParam(q.limit, 100, 1, 500),
      offset: intParam(q.offset, 0, 0),
    });
    return { result: out.result, total: out.total, counts: out.counts };
  });

  route('GET', '/api/app/catalog/tickets/:table/:id', (req, _reply, ctx) => {
    const { table, id } = req.params as { table: string; id: string };
    return { result: ticketDetail(ctx, table, id) };
  });

  route('POST', '/api/app/catalog/tickets/:table/:id/cancel', (req, _reply, ctx) => {
    const { table, id } = req.params as { table: string; id: string };
    const rec = isSysId(id) && (table === T.ritm || table === T.request) ? ctx.get(table, id) : null;
    if (!rec)
      throw new HttpError(
        404,
        'No Record found',
        'The ticket does not exist or you do not have access to it',
      );
    const f = fulfillmentOf(ctx.platform);
    if (!f.canCancel(ctx, rec))
      throw new HttpError(
        400,
        'This request can no longer be cancelled',
        'Requests can be cancelled while they are waiting for approval',
      );
    const reason = str(body(req).reason) || 'Cancelled by the requester';
    if (table === T.request) f.cancelRequest(ctx, rec, reason);
    else f.cancelItem(ctx, rec, reason);
    return { result: ticketDetail(ctx, table, id) };
  });

  route('POST', '/api/app/catalog/tickets/:table/:id/comment', (req, _reply, ctx) => {
    const { table, id } = req.params as { table: string; id: string };
    const rec = isSysId(id) && (table === T.ritm || table === T.request) ? ctx.get(table, id) : null;
    if (!rec)
      throw new HttpError(
        404,
        'No Record found',
        'The ticket does not exist or you do not have access to it',
      );
    const text = str(body(req).comment ?? body(req).comments);
    if (!text) throw new HttpError(400, 'Comment is required');
    const detail = ticketDetail(ctx, table, id);
    if (!(detail.actions as { can_comment: boolean }).can_comment)
      throw new HttpError(403, 'You cannot comment on this ticket');
    ctx.elevated().update(ctx.elevated().get(table, id) ?? rec, { comments: text });
    return { result: { ok: true } };
  });
}

function producedPayload(record: Rec): Record<string, unknown> {
  return {
    table: record.className,
    sys_id: record.sysId,
    number: record.has('number') ? record.str('number') : '',
    display_value: record.displayValue(),
    short_description: record.has('short_description') ? record.str('short_description') : '',
    state: record.has('state') ? record.display('state') : '',
    link: { table: record.className, sys_id: record.sysId },
  };
}
