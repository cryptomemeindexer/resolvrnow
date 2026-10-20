/**
 * Service Catalog REST API (spec section 14, rest-api.md section 10):
 * /api/sn_sc/servicecatalog/... and the versioned /api/sn_sc/{v}/servicecatalog/....
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiDeps, ctxOf, HttpError, intParam } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import { isSysId } from '../../engine/util.js';
import { CatalogAccess, type CatalogView, canRequestForOthers, splitList } from './access.js';
import { ROLES, T, VT } from './constants.js';
import { cascadeFor, evaluateGuide, guideToCart, orderGuide, staticEvaluation } from './guide.js';
import {
  addLines,
  CART,
  cartItemJson,
  cartLines,
  cartSummaryJson,
  checkout,
  deliveryAddressOf,
  emptyCart,
  ensureCart,
  findCart,
  orderNow,
  ownLine,
  pruneInactiveLines,
  removeLine,
  resolveUser,
  updateLine,
} from './ordering.js';
import { catalogCategories, categoryItemCount, categoryJson, itemDetail, itemSummary } from './present.js';
import { producerResponse, submitProducer } from './producer.js';
import { itemKind, money, noAccess, parseQuantity } from './util.js';
import { loadForm } from './variables.js';

const BASES = ['/api/sn_sc/servicecatalog', '/api/sn_sc/v1/servicecatalog', '/api/sn_sc/v2/servicecatalog'];

type Q = Record<string, string | undefined>;
type Body = Record<string, unknown>;
type Handler = (req: FastifyRequest, reply: FastifyReply, ctx: Context) => unknown;

function body(req: FastifyRequest): Body {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {};
}

function viewOf(q: Q): CatalogView {
  const v = String(q.sysparm_view ?? '').toLowerCase();
  return v === 'mobile' ? 'mobile' : v === 'both' ? 'both' : 'desktop';
}

/** Rejects XML-only clients (JSON is the only implemented representation). */
function negotiate(req: FastifyRequest): void {
  const accept = String(req.headers.accept ?? '');
  if (accept && /xml/i.test(accept) && !/json|\*\/\*/i.test(accept))
    throw new HttpError(406, 'Not Acceptable', 'Only application/json is supported');
}

function variablesOf(b: Body): Record<string, unknown> {
  const v = b.variables;
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, 'Invalid variables', 'variables must be a JSON object keyed by variable name');
    }
  }
  if (typeof v !== 'object' || Array.isArray(v))
    throw new HttpError(400, 'Invalid variables', 'variables must be an object keyed by variable name');
  return v as Record<string, unknown>;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** Loads an item by sys_id (any item class), or null. */
export function findItem(ctx: Context, id: string): Rec | null {
  return isSysId(id) ? ctx.platform.systemContext().get(T.item, id) : null;
}

/** An item the caller may see; 400 otherwise (the API never answers 404 for items). */
function visibleItem(ctx: Context, access: CatalogAccess, id: string, view: CatalogView): Rec {
  const item = findItem(ctx, id);
  if (!item || !access.canViewItem(item, { view })) throw noAccess();
  return item;
}

function orderResult(result: { request: Rec }, opts: { full?: boolean } = {}): Record<string, unknown> {
  const req = result.request;
  const out: Record<string, unknown> = opts.full
    ? {
        sys_id: req.sysId,
        number: req.str('number'),
        request_number: req.str('number'),
        request_id: req.sysId,
        table: T.request,
      }
    : { request_number: req.str('number'), request_id: req.sysId };
  if (req.str('parent')) {
    out.parent_id = req.str('parent');
    out.parent_table = req.ref('parent')?.className ?? 'task';
  }
  return out;
}

function parentOf(ctx: Context, b: Body): { table: string; id: string } | null {
  const id = str(b.sysparm_parent_sys_id ?? b.parent_id);
  const table = str(b.sysparm_parent_table ?? b.parent_table) || 'task';
  if (!id) return null;
  if (!isSysId(id) || !ctx.platform.registry.has(table) || !ctx.get(table, id))
    throw new HttpError(400, 'Invalid parent record', `${table} ${id} is not readable`);
  return { table, id };
}

export function registerServiceCatalogApi(app: FastifyInstance, deps: ApiDeps): void {
  const route = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: Handler) => {
    for (const base of BASES) {
      app.route({
        method,
        url: `${base}${path}`,
        handler: async (req, reply) => {
          negotiate(req);
          const ctx = ctxOf(req, deps);
          const out = await handler(req, reply, ctx);
          deps.platform.scheduleWork();
          return out;
        },
      });
    }
  };

  // ---------------------------------------------------------------- catalogs

  route('GET', '/catalogs', (req, _reply, ctx) => {
    const q = req.query as Q;
    const access = new CatalogAccess(ctx);
    const limit = intParam(q.sysparm_limit, 10000, 1, 10000);
    const text = str(q.sysparm_text).toLowerCase();
    const sys = ctx.platform.systemContext();
    const catalogs = sys
      .query(T.catalog, { query: 'active=true', orderBy: [{ field: 'title', desc: false }] })
      .filter((c) => !text || c.str('title').toLowerCase().includes(text));
    const visibleItems = sys
      .query(T.item, { query: 'active=true' })
      .filter((i) => access.canViewItem(i, { view: viewOf(q), search: true }));
    const result = catalogs.slice(0, limit).map((c) => ({
      sys_id: c.sysId,
      title: c.str('title'),
      description: c.str('description'),
      desktop_image: c.str('desktop_image'),
      has_categories: catalogCategories(ctx, access, c.sysId, false).length > 0,
      has_items: visibleItems.some((i) => access.itemCatalogs(i).includes(c.sysId)),
    }));
    return { result };
  });

  route('GET', '/catalogs/:id', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const cat = isSysId(id) ? ctx.platform.systemContext().get(T.catalog, id) : null;
    if (!cat || !access.canViewCatalog(cat))
      throw new HttpError(400, 'Catalog not found', `No visible catalog ${id}`);
    return {
      result: {
        sys_id: cat.sysId,
        title: cat.str('title'),
        description: cat.str('description'),
        desktop_image: cat.str('desktop_image'),
        categories: catalogCategories(ctx, access, cat.sysId, true).map((c) => ({
          sys_id: c.sysId,
          title: c.str('title'),
          description: c.str('description'),
          header_image: c.str('header_icon'),
        })),
      },
    };
  });

  route('GET', '/catalogs/:id/categories', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const q = req.query as Q;
    const access = new CatalogAccess(ctx);
    const cat = isSysId(id) ? ctx.platform.systemContext().get(T.catalog, id) : null;
    if (!cat || !access.canViewCatalog(cat))
      throw new HttpError(400, 'Catalog not found', `No visible catalog ${id}`);
    const limit = intParam(q.sysparm_limit, 10000, 1, 10000);
    const offset = intParam(q.sysparm_offset, 0, 0);
    const topOnly = ['true', '1'].includes(String(q.sysparm_top_level_only ?? '').toLowerCase());
    const cats = catalogCategories(ctx, access, cat.sysId, topOnly).slice(offset, offset + limit);
    return { result: cats.map((c) => categoryJson(ctx, access, c)) };
  });

  route('GET', '/categories/:id', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const sys = ctx.platform.systemContext();
    const cat = isSysId(id) ? sys.get(T.category, id) : null;
    if (!cat || !access.canViewCategory(cat))
      throw new HttpError(400, 'Category not found', `No visible category ${id}`);
    const children = sys
      .query(T.category, {
        query: `parent=${cat.sysId}^active=true`,
        orderBy: [
          { field: 'order', desc: false },
          { field: 'title', desc: false },
        ],
      })
      .filter((c) => access.canViewCategory(c));
    return {
      result: {
        ...categoryJson(ctx, access, cat),
        catalog: cat.str('sc_catalog')
          ? { sys_id: cat.str('sc_catalog'), title: cat.display('sc_catalog') }
          : {},
        parent: cat.str('parent'),
        child_categories: children.map((c) => {
          const subs = sys
            .query(T.category, { query: `parent=${c.sysId}^active=true` })
            .filter((s) => access.canViewCategory(s));
          return {
            sys_id: c.sysId,
            title: c.str('title'),
            count: categoryItemCount(ctx, access, c.sysId),
            parent: cat.sysId,
            isParentCategory: subs.length > 0,
            subcategories: subs.map((s) => ({ sys_id: s.sysId, title: s.str('title') })),
          };
        }),
      },
    };
  });

  // ------------------------------------------------------------------- items

  route('GET', '/items', (req, _reply, ctx) => {
    const q = req.query as Q;
    const access = new CatalogAccess(ctx);
    const limit = intParam(q.sysparm_limit, 10000, 1, 10000);
    const offset = intParam(q.sysparm_offset, 0, 0);
    const items = searchItems(ctx, access, {
      catalog: str(q.sysparm_catalog),
      category: str(q.sysparm_category),
      text: str(q.sysparm_text),
      type: str(q.sysparm_type),
      view: viewOf(q),
    });
    return { result: items.slice(offset, offset + limit).map((i) => itemSummary(ctx, access, i)) };
  });

  route('GET', '/items/:id', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const item = visibleItem(ctx, access, id, viewOf(req.query as Q));
    return { result: itemDetail(ctx, access, item) };
  });

  route('GET', '/items/:id/delegation/:user', (req, _reply, ctx) => {
    const { id, user } = req.params as { id: string; user: string };
    const access = new CatalogAccess(ctx);
    const item = findItem(ctx, id);
    const target = resolveUser(ctx, user);
    let ok = !!item && !!target && access.canViewItem(item);
    if (ok && target !== ctx.user.sysId) {
      ok =
        canRequestForOthers(ctx) &&
        (item!.str('access_type') === 'delegated' || new CatalogAccess(ctx, target).canViewItem(item!));
    }
    return { result: { result: ok } };
  });

  route('POST', '/items/:id/get_invalid_delegated_users', (req, reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const item = visibleItem(ctx, access, id, 'desktop');
    const form = loadForm(ctx, item);
    if (!form.vars.some((d) => d.type === VT.requestedFor)) {
      reply.code(400);
      return {
        result: {
          errCode: '42202',
          errMsg:
            'This item cannot be submitted for multiple people as it is not configured with Requested For',
        },
      };
    }
    const users = splitList(str(body(req).sysparm_also_request_for));
    const invalid: string[] = [];
    for (const u of users) {
      const uid = resolveUser(ctx, u);
      const ok =
        !!uid &&
        canRequestForOthers(ctx) &&
        (item.str('access_type') === 'delegated' || new CatalogAccess(ctx, uid).canViewItem(item));
      if (!ok) invalid.push(uid ? ctx.displayOf('sys_user', uid) : u);
    }
    return { result: { invalidUsers: invalid } };
  });

  const lineInput = (b: Body, quantityRequired = true) => ({
    quantity: parseQuantity(b.sysparm_quantity, quantityRequired ? undefined : 1),
    variables: variablesOf(b),
    requestedFor: str(b.sysparm_requested_for) || null,
    alsoRequestFor: splitList(str(b.sysparm_also_request_for)),
  });

  route('POST', '/items/:id/add_to_cart', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const item = findItem(ctx, id);
    if (!item) throw noAccess();
    const input = lineInput(b);
    const cart = ctx.platform.db.tx(() => {
      const c = ensureCart(ctx, CART.default);
      addLines(ctx, c, item, { ...input, view: viewOf(req.query as Q) });
      return c;
    });
    const lines = cartLines(ctx, cart);
    const subtotal = lines.reduce((s, l) => s + (l.num('price') ?? 0) * (l.num('quantity') ?? 1), 0);
    return {
      result: {
        cart_id: cart.sysId,
        subtotal: money(ctx.platform, subtotal),
        items: lines.map((l) => cartItemJson(ctx, l, 'compact')),
      },
    };
  });

  route('POST', '/items/:id/order_now', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const item = findItem(ctx, id);
    if (!item) throw noAccess();
    const result = orderNow(
      ctx,
      item,
      { ...lineInput(b), view: viewOf(req.query as Q) },
      { parent: parentOf(ctx, b) },
    );
    return { result: orderResult(result, { full: true }) };
  });

  route('POST', '/items/:id/add_to_wishlist', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const item = findItem(ctx, id);
    if (!item) throw noAccess();
    const cart = ctx.platform.db.tx(() => {
      const c = ensureCart(ctx, CART.wishlist);
      addLines(ctx, c, item, { ...lineInput(b, false), ignoreMandatory: true });
      return c;
    });
    return {
      result: {
        cart_id: cart.sysId,
        items: cartLines(ctx, cart).map((l) => cartItemJson(ctx, l, 'compact_vars')),
      },
    };
  });

  route('POST', '/items/:id/submit_producer', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const item = findItem(ctx, id);
    if (!item) throw new HttpError(404, 'No Record found', `Record producer ${id} does not exist`);
    if (itemKind(item) !== 'record_producer')
      throw new HttpError(400, 'Invalid record producer', `${item.str('name')} is not a record producer`);
    const b = body(req);
    const result = submitProducer(ctx, item, {
      variables: variablesOf(b),
      view: viewOf(req.query as Q),
      attachments: splitList(str(b.attachments)),
    });
    return { result: producerResponse(result, item) };
  });

  route('PUT', '/items/:id/submit_guide', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const access = new CatalogAccess(ctx);
    const guide = visibleItem(ctx, access, id, viewOf(req.query as Q));
    if (itemKind(guide) !== 'order_guide') throw noAccess(`${guide.str('name')} is not an order guide`);
    const evaluation = evaluateGuide(ctx, guide, variablesOf(body(req)), { view: viewOf(req.query as Q) });
    return {
      result: evaluation.items.map((sel) => {
        const cascade = cascadeFor(ctx, evaluation, sel.item);
        return {
          ...itemDetail(ctx, access, sel.item, cascade),
          quantity: String(sel.quantity),
          order: String(sel.position),
        };
      }),
    };
  });

  route('POST', '/items/:id/checkout_guide', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    const access = new CatalogAccess(ctx);
    const guide = visibleItem(ctx, access, id, 'desktop');
    if (itemKind(guide) !== 'order_guide') throw noAccess(`${guide.str('name')} is not an order guide`);
    const items = Array.isArray(b.items) ? (b.items as Body[]) : [];
    if (!items.length)
      throw new HttpError(400, 'No items selected', 'items must list the guide items to order');
    const guideVars = variablesOf(b);
    const evaluation = Object.keys(guideVars).length
      ? evaluateGuide(ctx, guide, guideVars, { checkMandatory: false })
      : staticEvaluation(ctx, guide);
    const lines = items.map((i) => ({
      sys_id: str(i.sys_id),
      quantity: parseQuantity(i.sysparm_quantity, 1),
      variables: variablesOf(i),
    }));
    if (guide.bool('two_step')) {
      const result = orderGuide(ctx, evaluation, lines);
      return { result: orderResult(result) };
    }
    const cart = guideToCart(ctx, evaluation, lines);
    return { result: cartSummaryJson(ctx, cart) };
  });

  route('POST', '/variables/:id/display_value', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const sys = ctx.platform.systemContext();
    const variable = isSysId(id) ? sys.get(T.variable, id) : null;
    const owner = variable?.str('cat_item') ? sys.get(T.item, variable.str('cat_item')) : null;
    if (!variable || (owner && !new CatalogAccess(ctx).canViewItem(owner)))
      throw new HttpError(404, 'No Record found', `Variable ${id} does not exist`);
    const type = variable.num('type');
    const table =
      type === VT.requestedFor
        ? 'sys_user'
        : variable.str('reference') || variable.str('list_table') || variable.str('lookup_table');
    const value = str(body(req).sysparm_value);
    const rec = table && ctx.platform.registry.has(table) && isSysId(value) ? sys.get(table, value) : null;
    if (!rec) throw new HttpError(404, 'No Record found', `No ${table || 'record'} ${value}`);
    return { result: rec.displayValue() };
  });

  // -------------------------------------------------------------------- cart

  route('GET', '/cart', (_req, _reply, ctx) => {
    const cart = ensureCart(ctx, CART.default);
    pruneInactiveLines(ctx, cart);
    return { result: cartSummaryJson(ctx, cart) };
  });

  route('GET', '/cart/delivery_address/:id', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const user = resolveUser(ctx, id);
    if (!user) throw new HttpError(400, 'Invalid user', `No active user ${id}`);
    return { result: deliveryAddressOf(ctx, user) };
  });

  route('POST', '/cart/checkout', (req, _reply, ctx) => {
    const cart = ensureCart(ctx, CART.default);
    const b = body(req);
    if (ctx.platform.properties.getBool('glide.sc.checkout.twostep', false)) {
      if (!cartLines(ctx, cart).length)
        throw new HttpError(400, 'Cart is empty', 'There are no items in the cart to order');
      const requestedFor = cart.str('requested_for') || ctx.user.sysId || '';
      return {
        result: {
          ...cartSummaryJson(ctx, cart),
          delivery_address: cart.str('delivery_address') || deliveryAddressOf(ctx, requestedFor),
          special_instructions: cart.str('special_instructions'),
          requested_for: requestedFor,
          requested_for_user: requestedFor ? ctx.displayOf('sys_user', requestedFor) : '',
        },
      };
    }
    return { result: orderResult(checkout(ctx, cart, checkoutOptions(b))) };
  });

  route('POST', '/cart/submit_order', (req, _reply, ctx) => {
    const cart = findCart(ctx, CART.default);
    if (!cart) throw new HttpError(400, 'Cart is empty', 'There are no items in the cart to order');
    return { result: orderResult(checkout(ctx, cart, checkoutOptions(body(req)))) };
  });

  route('PUT', '/cart/:id', (req, reply, ctx) => {
    const { id } = req.params as { id: string };
    const line = ownLine(ctx, id);
    if (!line) throw new HttpError(400, 'Invalid cart item', `No cart item ${id} in your cart`);
    const b = body(req);
    const quantity = parseQuantity(b.sysparm_quantity);
    const cart = line.ref('cart');
    ctx.platform.db.tx(() => updateLine(ctx, line, { quantity, variables: variablesOf(b) }));
    reply.code(201);
    return {
      result: cart ? cartSummaryJson(ctx, ctx.platform.systemContext().get(T.cart, cart.sysId) ?? cart) : {},
    };
  });

  route('DELETE', '/cart/:id', (req, reply, ctx) => {
    const { id } = req.params as { id: string };
    const line = ownLine(ctx, id);
    if (!line) throw new HttpError(400, 'Invalid cart item', `No cart item ${id} in your cart`);
    ctx.platform.db.tx(() => removeLine(ctx, line));
    return reply.code(204).send();
  });

  route('DELETE', '/cart/:id/empty', (req, reply, ctx) => {
    const { id } = req.params as { id: string };
    const cart = isSysId(id) ? ctx.platform.systemContext().get(T.cart, id) : null;
    if (!cart) throw new HttpError(400, 'Invalid cart', `No cart ${id}`);
    if (cart.str('user') !== ctx.user.sysId && !ctx.hasAnyRole(['admin', ROLES.admin]))
      throw new HttpError(400, 'Invalid cart', "Only admin or catalog_admin can empty another user's cart");
    ctx.platform.db.tx(() => emptyCart(ctx, cart, { deleteCart: true }));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- wish list

  route('GET', '/wishlist', (_req, _reply, ctx) => {
    const cart = findCart(ctx, CART.wishlist);
    return {
      result: {
        cart_id: cart?.sysId ?? '',
        items: cart ? cartLines(ctx, cart).map((l) => cartItemJson(ctx, l, 'full')) : [],
      },
    };
  });

  route('GET', '/wishlist/:id', (req, _reply, ctx) => {
    const { id } = req.params as { id: string };
    const line = ownLine(ctx, id);
    if (!line || line.ref('cart')?.str('name') !== CART.wishlist)
      throw new HttpError(404, 'No Record found', `No wish list item ${id}`);
    return { result: cartItemJson(ctx, line, 'compact_vars') };
  });
}

function checkoutOptions(b: Body) {
  return {
    requestedFor: str(b.requested_for ?? b.sysparm_requested_for) || null,
    deliveryAddress: b.delivery_address === undefined ? null : str(b.delivery_address),
    specialInstructions: b.special_instructions === undefined ? null : str(b.special_instructions),
  };
}

export interface ItemSearch {
  catalog?: string;
  category?: string;
  text?: string;
  /** `Record Producer`, `Order Guide` (API values) or an item kind. */
  type?: string;
  view?: CatalogView;
  portal?: boolean;
}

/** Visible items matching catalog / category / text / type filters, ordered by order then name. */
export function searchItems(ctx: Context, access: CatalogAccess, s: ItemSearch): Rec[] {
  const sys = ctx.platform.systemContext();
  let table: string = T.item;
  const type = (s.type ?? '').toLowerCase();
  if (type === 'record producer' || type === 'record_producer') table = T.producer;
  else if (type === 'order guide' || type === 'order_guide') table = T.guide;
  else if (type === 'content_item') table = T.content;
  const terms: string[] = ['active=true'];
  if (type === 'catalog_item') terms.push(`sys_class_name=${T.item}`);
  if (s.category) {
    const extra = sys
      .query(T.itemCategory, { query: `sc_category=${s.category}` })
      .map((l) => l.str('sc_cat_item'));
    terms.push(
      extra.length ? `category=${s.category}^ORsys_idIN${extra.join(',')}` : `category=${s.category}`,
    );
  }
  let items = sys.query(table, {
    query: terms.join('^'),
    orderBy: [
      { field: 'order', desc: false },
      { field: 'name', desc: false },
    ],
  });
  if (s.catalog) items = items.filter((i) => access.itemCatalogs(i).includes(s.catalog!));
  const words = (s.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    items = items.filter((i) => {
      const hay = ['name', 'short_description', 'meta', 'description']
        .map((f) => i.str(f).toLowerCase())
        .join(' ');
      return words.every((w) => hay.includes(w));
    });
  }
  return items.filter((i) => access.canViewItem(i, { view: s.view, portal: s.portal, search: true }));
}
