/**
 * Ordering: carts and cart lines, Order Now through a temporary cart, one- and
 * two-step checkout creating one request with one requested item per line
 * (spec 6.3 and 6.4), Requested For / Also Request For rules (section 10).
 */
import { HttpError } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { addMs, isSysId, newSysId, nowGlide } from '../../engine/util.js';
import { CatalogAccess, type CatalogView, canRequestForOthers, splitList } from './access.js';
import { APPROVAL, FREQUENCY_LABEL, REQ_STATE, STAGE, STATE, T, VT } from './constants.js';
import { catalogListeners } from './listeners.js';
import {
  deliveryLabel,
  deliveryMs,
  isOrderable,
  money,
  noAccess,
  propList,
  showPrice,
  showQuantity,
  VariableError,
} from './util.js';
import {
  type Answers,
  answersAsInput,
  computePrice,
  deleteAnswers,
  displayAnswer,
  hasPriceVariables,
  loadForm,
  readAnswers,
  relinkAnswers,
  storeAnswers,
  type VarError,
  validateAnswers,
} from './variables.js';

export const CART = {
  default: 'DEFAULT',
  wishlist: 'WISHLIST',
  draft: 'DRAFT',
  tempPrefix: 'TEMP_',
} as const;

export interface LineInput {
  quantity: number;
  variables?: Record<string, unknown>;
  /** sysparm_requested_for: the user the line is for (needs glide.sc.req_for.roles). */
  requestedFor?: string | null;
  /** sysparm_also_request_for: additional users, one line / requested item each. */
  alsoRequestFor?: string[];
  orderGuide?: string | null;
  /** Answers cascaded from an order guide; the caller's own answers win. */
  cascade?: Record<string, string>;
  /** Skip mandatory checks (order guide rules with ignore_mandatory, wish lists). */
  ignoreMandatory?: boolean;
  view?: CatalogView;
  portal?: boolean;
}

export interface CheckoutOptions {
  requestedFor?: string | null;
  deliveryAddress?: string | null;
  specialInstructions?: string | null;
  requestedDate?: string | null;
  /** Record the request is raised from (Create Request from an incident). */
  parent?: { table: string; id: string } | null;
  /** Attachments (sys_attachment ids uploaded by the caller) to move to the first requested item. */
  attachments?: string[];
}

export interface OrderResult {
  request: Rec;
  items: Rec[];
}

/** Turns variable errors into the API's 400 response. */
export function throwVariableErrors(errors: VarError[]): void {
  if (!errors.length) return;
  const mandatory = errors.filter((e) => e.code === 'mandatory');
  if (mandatory.length) {
    throw new VariableError(
      'Mandatory Variables are required',
      `Missing: ${mandatory.map((e) => e.label).join(', ')}`,
      errors,
    );
  }
  throw new VariableError('Invalid variable value', errors.map((e) => e.message).join('; '), errors);
}

function me(ctx: Context): string {
  if (!ctx.user.sysId) throw new HttpError(400, 'A signed-in user is required to use the cart');
  return ctx.user.sysId;
}

/** Resolves a user reference (sys_id, user_name or email) to an active user's sys_id. */
export function resolveUser(ctx: Context, v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const sys = ctx.platform.systemContext();
  const u = isSysId(s) ? sys.get('sys_user', s) : sys.first('sys_user', `user_name=${s}^ORemail=${s}`);
  return u && u.get('active') !== 0 ? u.sysId : null;
}

// ------------------------------------------------------------------- carts

export function findCart(ctx: Context, name: string): Rec | null {
  return ctx.platform
    .systemContext()
    .first(T.cart, `user=${me(ctx)}^name=${name}`, [{ field: 'sys_created_on', desc: false }]);
}

export function ensureCart(ctx: Context, name: string = CART.default): Rec {
  return findCart(ctx, name) ?? ctx.elevated().insert(T.cart, { name, user: me(ctx), active: true });
}

/** A throwaway cart used by Order Now and order guides. */
export function createTempCart(ctx: Context): Rec {
  return ctx
    .elevated()
    .insert(T.cart, { name: `${CART.tempPrefix}${newSysId().slice(0, 12)}`, user: me(ctx), active: true });
}

export function isTempCart(cart: Rec): boolean {
  return cart.str('name').startsWith(CART.tempPrefix);
}

/** Removes lines whose item became inactive (glide.sc.remove_inactive_cat_items_from_cart). */
export function pruneInactiveLines(ctx: Context, cart: Rec): void {
  if (!ctx.platform.properties.getBool('glide.sc.remove_inactive_cat_items_from_cart', false)) return;
  const sys = ctx.platform.systemContext();
  for (const line of sys.query(T.cartItem, { query: `cart=${cart.sysId}` })) {
    if (!sys.get(T.item, line.str('cat_item'))?.bool('active')) removeLine(ctx, line);
  }
}

/** Lines of a cart in insertion order (wish lists hold inactive lines). */
export function cartLines(ctx: Context, cart: Rec): Rec[] {
  const q = cart.str('name') === CART.wishlist ? `cart=${cart.sysId}` : `cart=${cart.sysId}^active=true`;
  return ctx.platform
    .systemContext()
    .query(T.cartItem, { query: q, orderBy: [{ field: 'sys_created_on', desc: false }] });
}

/** Loads a cart line owned by the caller (admins and catalog admins may see others). */
export function ownLine(ctx: Context, lineId: string): Rec | null {
  const sys = ctx.platform.systemContext();
  const line = isSysId(lineId) ? sys.get(T.cartItem, lineId) : null;
  if (!line) return null;
  const cart = line.ref('cart');
  if (!cart) return null;
  if (cart.str('user') !== ctx.user.sysId && !ctx.hasAnyRole(['admin', 'catalog_admin'])) return null;
  return line;
}

function checkQuantityRoles(ctx: Context, quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 0)
    throw new HttpError(
      400,
      'Invalid quantity value',
      `Quantity must be a non-negative whole number, got ${quantity}`,
    );
  const roles = propList(ctx.platform, 'glide.sc.allow.quantity');
  if (quantity !== 1 && roles.length && !ctx.hasAnyRole(roles)) {
    throw new HttpError(400, 'Invalid quantity value', 'You are not allowed to change the quantity');
  }
}

/** Adds an item to a cart; returns one line per requested-for user (Also Request For). */
export function addLines(ctx: Context, cart: Rec, item: Rec, input: LineInput): Rec[] {
  const user = me(ctx);
  const access = new CatalogAccess(ctx);
  if (!access.canViewItem(item, { view: input.view, portal: input.portal })) throw noAccess();
  if (!isOrderable(ctx.platform, item))
    throw noAccess('This kind of item cannot be added to a cart or ordered');
  checkQuantityRoles(ctx, input.quantity);
  const wishlist = cart.str('name') === CART.wishlist;
  let requestedFor: string | null = null;
  if (input.requestedFor) {
    requestedFor = resolveUser(ctx, input.requestedFor);
    if (!requestedFor) throw noAccess('The requested-for user does not exist or is inactive');
  }
  const form = loadForm(ctx, item, { context: input.orderGuide ? 'guide' : 'standalone' });
  const rfVar = form.vars.find((d) => d.type === VT.requestedFor);
  const variables = { ...(input.variables ?? {}) };
  if (rfVar && requestedFor && !(rfVar.name in variables)) variables[rfVar.name] = requestedFor;
  const { answers, errors } = validateAnswers(ctx, form, variables, {
    base: input.cascade,
    checkMandatory: !input.ignoreMandatory && !wishlist,
    requestedFor,
  });
  throwVariableErrors(errors);
  const primary = answers.requestedFor || requestedFor;
  if (primary && primary !== user && !canRequestForOthers(ctx)) {
    throw noAccess('You are not allowed to request items for other users');
  }
  const also = [...new Set((input.alsoRequestFor ?? []).map((s) => s.trim()).filter(Boolean))];
  const alsoIds: string[] = [];
  if (also.length) {
    if (also.length > 50) throw noAccess('Also Request For accepts at most 50 users');
    if (!rfVar?.enableAlsoRequestFor) {
      throw noAccess(
        'This item cannot be submitted for multiple people as it is not configured with Requested For',
      );
    }
    if (rfVar.alsoRequestForRoles.length && !ctx.hasAnyRole(rfVar.alsoRequestForRoles))
      throw noAccess('You are not allowed to request this item for multiple people');
    if (!canRequestForOthers(ctx)) throw noAccess('You are not allowed to request items for other users');
    for (const a of also) {
      const id = resolveUser(ctx, a);
      if (!id) throw noAccess(`User ${a} does not exist or is inactive`);
      if (!alsoIds.includes(id) && id !== primary) alsoIds.push(id);
    }
  }
  const targets: (string | null)[] = [primary ?? null, ...alsoIds];
  if (item.str('access_type') !== 'delegated') {
    for (const u of targets) {
      if (!u || u === user) continue;
      if (!new CatalogAccess(ctx, u).canViewItem(item, { view: input.view })) {
        throw noAccess(`${ctx.displayOf('sys_user', u)} is not entitled to this item`);
      }
    }
  }
  const price = computePrice(ctx, form, answers);
  const sys = ctx.elevated();
  const lines: Rec[] = [];
  for (const u of targets) {
    const lineAnswers: Answers =
      rfVar && u ? { ...answers, values: { ...answers.values, [rfVar.name]: u }, requestedFor: u } : answers;
    const line = sys.insert(T.cartItem, {
      cart: cart.sysId,
      cat_item: item.sysId,
      quantity: input.quantity,
      price: price.price,
      recurring_price: price.recurringPrice,
      recurring_frequency: item.str('recurring_frequency') || null,
      requested_for: u,
      order_guide: input.orderGuide ?? null,
      active: !wishlist,
    });
    storeAnswers(ctx, form, lineAnswers, { table: T.cartItem, id: line.sysId });
    lines.push(line);
  }
  return lines;
}

/** Changes the quantity and/or answers of a cart line. */
export function updateLine(
  ctx: Context,
  line: Rec,
  patch: { quantity?: number; variables?: Record<string, unknown> },
): Rec {
  const sys = ctx.elevated();
  const item = sys.get(T.item, line.str('cat_item'));
  if (!item) throw noAccess();
  const values: Record<string, unknown> = {};
  if (patch.quantity !== undefined) {
    checkQuantityRoles(ctx, patch.quantity);
    values.quantity = patch.quantity;
  }
  if (patch.variables && Object.keys(patch.variables).length) {
    const form = loadForm(ctx, item, { context: line.str('order_guide') ? 'guide' : 'standalone' });
    const owner = { table: T.cartItem, id: line.sysId } as const;
    const current = readAnswers(ctx, form, owner);
    const wishlist = line.ref('cart')?.str('name') === CART.wishlist;
    const { answers, errors } = validateAnswers(ctx, form, patch.variables, {
      base: answersAsInput(current),
      checkMandatory: !wishlist,
    });
    throwVariableErrors(errors);
    if (answers.requestedFor && answers.requestedFor !== ctx.user.sysId && !canRequestForOthers(ctx)) {
      throw noAccess('You are not allowed to request items for other users');
    }
    deleteAnswers(ctx, owner);
    storeAnswers(ctx, form, answers, owner);
    const price = computePrice(ctx, form, answers);
    values.price = price.price;
    values.recurring_price = price.recurringPrice;
    if (form.vars.some((d) => d.type === VT.requestedFor)) values.requested_for = answers.requestedFor;
  }
  if (Object.keys(values).length) sys.update(line, values);
  return sys.get(T.cartItem, line.sysId) ?? line;
}

export function removeLine(ctx: Context, line: Rec): void {
  deleteAnswers(ctx, { table: T.cartItem, id: line.sysId });
  ctx.elevated().delete(line);
}

export function emptyCart(ctx: Context, cart: Rec, opts: { deleteCart?: boolean } = {}): void {
  const sys = ctx.elevated();
  for (const line of sys.query(T.cartItem, { query: `cart=${cart.sysId}` })) removeLine(ctx, line);
  if (opts.deleteCart) sys.delete(cart);
}

// ---------------------------------------------------------------- checkout

/** Multi-line address of a user's location (empty when unknown). */
export function deliveryAddressOf(ctx: Context, userId: string | null): string {
  if (!userId) return '';
  const user = ctx.platform.systemContext().get('sys_user', userId);
  const loc = user?.ref('location');
  if (!loc) return '';
  const cityLine = [loc.str('city'), loc.str('state'), loc.str('zip')].filter(Boolean).join(' ');
  return [loc.str('name'), loc.str('street'), cityLine, loc.str('country')].filter(Boolean).join('\n');
}

function moveAttachments(
  sys: Context,
  fromTable: string,
  fromId: string,
  toTable: string,
  toId: string,
): void {
  if (!sys.platform.registry.has('sys_attachment')) return;
  for (const a of sys.query('sys_attachment', { query: `table_name=${fromTable}^table_sys_id=${fromId}` })) {
    sys.update(a, { table_name: toTable, table_sys_id: toId });
  }
}

function adoptAttachments(ctx: Context, ids: string[], toTable: string, toId: string): void {
  if (!ids.length || !ctx.platform.registry.has('sys_attachment')) return;
  const sys = ctx.elevated();
  for (const id of ids) {
    const a = isSysId(id) ? sys.get('sys_attachment', id) : null;
    if (a && a.str('sys_created_by') === ctx.user.userName)
      sys.update(a, { table_name: toTable, table_sys_id: toId });
  }
}

/** Places the order for a cart: one request, one requested item per line, answers moved over. */
export function checkout(ctx: Context, cart: Rec, opts: CheckoutOptions = {}): OrderResult {
  const user = me(ctx);
  const platform = ctx.platform;
  return platform.db.tx(() => {
    const sys = ctx.elevated();
    const lines = cartLines(ctx, cart).filter((l) => l.bool('active'));
    if (!lines.length) throw new HttpError(400, 'Cart is empty', 'There are no items in the cart to order');
    const access = new CatalogAccess(ctx);
    const prepared = lines.map((line) => {
      const item = sys.get(T.item, line.str('cat_item'));
      if (!item || !access.canViewItem(item) || !isOrderable(platform, item)) {
        throw noAccess(`${item?.str('name') || 'An item'} in the cart is no longer available`);
      }
      const forUser = line.str('requested_for');
      if (
        forUser &&
        forUser !== user &&
        item.str('access_type') !== 'delegated' &&
        !new CatalogAccess(ctx, forUser).canViewItem(item)
      ) {
        throw noAccess(`${ctx.displayOf('sys_user', forUser)} is not entitled to ${item.str('name')}`);
      }
      const form = loadForm(ctx, item, { context: line.str('order_guide') ? 'guide' : 'standalone' });
      const answers = readAnswers(ctx, form, { table: T.cartItem, id: line.sysId });
      const { errors } = validateAnswers(ctx, form, answersAsInput(answers), { applyDefaults: false });
      throwVariableErrors(errors.filter((e) => e.code === 'mandatory'));
      return { line, item, answers };
    });
    let requestedFor = opts.requestedFor ? resolveUser(ctx, opts.requestedFor) : null;
    if (opts.requestedFor && !requestedFor)
      throw noAccess('The requested-for user does not exist or is inactive');
    if (requestedFor && requestedFor !== user && !canRequestForOthers(ctx))
      throw noAccess('You are not allowed to request items for other users');
    const lineUsers = [
      ...new Set(prepared.map((p) => p.answers.requestedFor || p.line.str('requested_for')).filter(Boolean)),
    ];
    requestedFor =
      requestedFor || cart.str('requested_for') || (lineUsers.length === 1 ? lineUsers[0] : null) || user;
    const now = nowGlide();
    const total = prepared.reduce(
      (s, p) => s + (p.line.num('price') ?? 0) * (p.line.num('quantity') ?? 1),
      0,
    );
    const names = prepared.map((p) => p.item.str('name'));
    const req = sys.insert(T.request, {
      opened_by: user,
      requested_for: requestedFor,
      request_state: REQ_STATE.requested,
      stage: 'requested',
      approval: APPROVAL.notRequested,
      state: STATE.open,
      price: Math.round(total * 100) / 100,
      delivery_address:
        opts.deliveryAddress ?? (cart.str('delivery_address') || deliveryAddressOf(ctx, requestedFor)),
      special_instructions: opts.specialInstructions ?? cart.str('special_instructions'),
      requested_date: opts.requestedDate ?? null,
      short_description: (names.length === 1
        ? names[0]
        : `${names[0]} and ${names.length - 1} more item${names.length > 2 ? 's' : ''}`
      ).slice(0, 160),
      parent: opts.parent?.id ?? null,
      contact_type: 'self-service',
    });
    const items: Rec[] = [];
    for (const p of prepared) {
      const estimate = addMs(now, deliveryMs(ctx, p.item));
      const catalogs = splitList(p.item.str('sc_catalogs'));
      const ritm = sys.insert(T.ritm, {
        request: req.sysId,
        cat_item: p.item.sysId,
        sc_catalog: catalogs[0] ?? null,
        quantity: p.line.num('quantity') ?? 1,
        price: p.line.num('price') ?? 0,
        recurring_price: p.line.num('recurring_price') ?? 0,
        recurring_frequency: p.line.str('recurring_frequency') || null,
        requested_for: p.answers.requestedFor || p.line.str('requested_for') || requestedFor,
        opened_by: user,
        order_guide: p.line.str('order_guide') || null,
        stage: STAGE.waiting,
        state: STATE.open,
        approval: APPROVAL.notRequested,
        short_description: p.item.str('name').slice(0, 160),
        description: p.item.str('short_description'),
        assignment_group: p.item.str('group') || null,
        estimated_delivery: estimate,
        due_date: estimate,
        contact_type: 'self-service',
      });
      relinkAnswers(ctx, p.line.sysId, ritm.sysId);
      moveAttachments(sys, T.cartItem, p.line.sysId, T.ritm, ritm.sysId);
      items.push(ritm);
    }
    adoptAttachments(ctx, opts.attachments ?? [], T.ritm, items[0].sysId);
    const due = items
      .map((i) => i.str('estimated_delivery'))
      .sort()
      .pop();
    if (due) sys.update(req, { due_date: due });
    for (const p of prepared) sys.delete(p.line);
    if (isTempCart(cart)) sys.delete(cart);
    else if (cart.str('requested_for') || cart.str('special_instructions'))
      sys.update(cart, { requested_for: null, special_instructions: '', delivery_address: '' });
    const onBehalf = new Set<string>();
    if (requestedFor !== user) onBehalf.add(requestedFor);
    for (const i of items)
      if (i.str('requested_for') && i.str('requested_for') !== user) onBehalf.add(i.str('requested_for'));
    for (const u of onBehalf) sys.queueEvent('sc_request.requested_for', req, u, user);
    const result = {
      request: sys.get(T.request, req.sysId) ?? req,
      items: items.map((i) => sys.get(T.ritm, i.sysId) ?? i),
    };
    catalogListeners(platform).emit({
      kind: 'request',
      ctx,
      item: prepared[0].item,
      request: result.request,
      items: result.items,
    });
    return result;
  });
}

/** Order Now: orders one item through a temporary cart, leaving the default cart untouched. */
export function orderNow(ctx: Context, item: Rec, input: LineInput, opts: CheckoutOptions = {}): OrderResult {
  return ctx.platform.db.tx(() => {
    const cart = createTempCart(ctx);
    addLines(ctx, cart, item, input);
    return checkout(ctx, cart, opts);
  });
}

// --------------------------------------------------------------- API shapes

export type LineShape = 'full' | 'compact' | 'compact_vars';

/** A cart line in the Service Catalog API format (spec 14.3 CartItem). */
export function cartItemJson(ctx: Context, line: Rec, shape: LineShape = 'full'): Record<string, unknown> {
  const sys = ctx.platform.systemContext();
  const platform = ctx.platform;
  const item = sys.get(T.item, line.str('cat_item'));
  const qty = line.num('quantity') ?? 1;
  const price = line.num('price') ?? 0;
  const rec = line.num('recurring_price') ?? 0;
  const freq = line.str('recurring_frequency');
  const base: Record<string, unknown> = {
    cart_item_id: line.sysId,
    catalog_item_id: line.str('cat_item'),
    item_name: item?.str('name') ?? '',
    quantity: String(qty),
    price: money(platform, price),
    localized_price: money(platform, price),
    recurring_price: money(platform, rec),
    localized_recurring_price: money(platform, rec),
    recurring_frequency: freq ? (FREQUENCY_LABEL[freq] ?? freq) : '',
  };
  const vars = (): Record<string, string> => {
    if (!item) return {};
    const form = loadForm(ctx, item, {
      context: line.str('order_guide') ? 'guide' : 'standalone',
      includeInactive: true,
    });
    const answers = readAnswers(ctx, form, { table: T.cartItem, id: line.sysId });
    const out: Record<string, string> = {};
    for (const def of form.vars) {
      if (!def.info.data) continue;
      out[def.label] =
        def.type === VT.masked
          ? answers.values[def.name]
            ? '********'
            : ''
          : displayAnswer(ctx, def, answers.values[def.name] ?? '');
    }
    for (const set of form.mrvs) out[set.title] = JSON.stringify(answers.rows[set.internalName] ?? []);
    return out;
  };
  if (shape === 'compact') return base;
  if (shape === 'compact_vars')
    return { ...base, delivery_time: item ? deliveryLabel(ctx, item) : '', variables: vars() };
  const form = item ? loadForm(ctx, item) : null;
  const shown = item ? showPrice(platform, item, form ? hasPriceVariables(ctx, form) : false) : false;
  return {
    ...base,
    short_description: item?.str('short_description') ?? '',
    sys_class_name: item?.className ?? T.item,
    picture: item?.str('picture') ?? '',
    order_guide: line.str('order_guide'),
    delivery_time: item ? deliveryLabel(ctx, item) : '',
    subtotal: Math.round(price * qty * 100) / 100,
    subtotal_price: money(platform, price * qty),
    recurring_subtotal: Math.round(rec * qty * 100) / 100,
    recurring_subtotal_price: money(platform, rec * qty),
    show_price: shown,
    show_quantity: item ? showQuantity(item) : true,
    show_recurring_price: shown && rec !== 0,
    requested_for: line.str('requested_for'),
    created_by: line.str('sys_created_by'),
    created_on: line.str('sys_created_on'),
    updated_by: line.str('sys_updated_by'),
    updated_on: line.str('sys_updated_on'),
    variables: vars(),
  };
}

/** The cart in the Service Catalog API format (spec 14.3 CartSummary): one block per recurring frequency. */
export function cartSummaryJson(ctx: Context, cart: Rec): Record<string, unknown> {
  const platform = ctx.platform;
  const lines = cartLines(ctx, cart).filter((l) => l.bool('active'));
  const groups = new Map<string, Rec[]>();
  for (const l of lines) {
    const key = l.str('recurring_frequency') || 'none';
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const total = (ls: Rec[], field: string) =>
    ls.reduce((s, l) => s + (l.num(field) ?? 0) * (l.num('quantity') ?? 1), 0);
  const itemsJson = new Map<string, Record<string, unknown>[]>();
  let anyShown = false;
  for (const [k, ls] of groups) {
    const js = ls.map((l) => cartItemJson(ctx, l, 'full'));
    if (js.some((j) => j.show_price === true)) anyShown = true;
    itemsJson.set(k, js);
  }
  const out: Record<string, unknown> = {
    cart_id: cart.sysId,
    subtotal_price: money(platform, total(lines, 'price')),
    subtotal_recurring_frequency: '',
    subtotal_recurring_price: '',
    subtotal_title: 'Subtotal',
    total_title: 'Total',
    show_subtotal_price: String(anyShown || lines.length === 0),
  };
  for (const [key, ls] of groups) {
    const recurring = key !== 'none';
    const js = itemsJson.get(key) ?? [];
    out[key] = {
      frequency_label: recurring ? (FREQUENCY_LABEL[key] ?? key) : '',
      items: js,
      show_subtotal_price: String(js.some((j) => j.show_price === true)),
      subtotal_price: money(platform, total(ls, 'price')),
      subtotal_recurring_frequency: recurring ? (FREQUENCY_LABEL[key] ?? key) : '',
      subtotal_recurring_price: recurring ? money(platform, total(ls, 'recurring_price')) : '',
      subtotal_title: 'Subtotal',
      total_title: 'Total',
    };
  }
  return out;
}

/** Totals of a cart as numbers (portal use). */
export function cartTotals(ctx: Context, cart: Rec): { count: number; subtotal: number; recurring: number } {
  const lines = cartLines(ctx, cart).filter((l) => l.bool('active'));
  return {
    count: lines.length,
    subtotal: lines.reduce((s, l) => s + (l.num('price') ?? 0) * (l.num('quantity') ?? 1), 0),
    recurring: lines.reduce((s, l) => s + (l.num('recurring_price') ?? 0) * (l.num('quantity') ?? 1), 0),
  };
}
